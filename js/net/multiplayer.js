/* ============================ MULTIPLAYER ============================
   Endless Drive v2.7 — WebRTC multiplayer with MANUAL signaling.
   There is no signaling server: the two players carry the SDP blobs
   between pages themselves (chat, notes, whatever).

   FLOW / STATE MACHINE
     idle
       -> host():  creates an RTCPeerConnection + data channel, gathers
          ICE, returns a JOIN CODE (compressed offer, base64). Status
          'awaiting-reply', attempt 1/4.
       -> join(code): decodes the host offer, creates an answer,
          returns a REPLY CODE. Status 'connecting', attempt 1/4.
       -> host acceptReply(code): applies the answer.
     data channel open -> 'connected': both sides exchange hello +
          content descriptors (below), then 10 Hz state snapshots.
     ICE 'failed' / channel close before or after connect:
          attempts 1..4 — the HOST automatically mints a FRESH offer
          (new join code delivered via onCode) because an offer is
          single-use; a JOINER cannot mint anything, so it logs
          "failed: send the host's new code" and waits for join(newCode)
          which counts as the next attempt. After attempt 4 the state
          is 'failed' with a reason: 'ICE failed' / 'data channel
          closed' / 'code invalid'.
     Every transition is written to the LoadingScreen log (when it is
     open) and to Multiplayer.onLog, in the exact forms:
       "attempting connect N/4 …", "joined", "failed: <reason>".

   CODES
     The SDP JSON ({type, sdp}) is gzip-compressed with
     CompressionStream where the browser has it, then base64url.
     Prefix "EDG1." = gzipped, "EDR1." = raw JSON (fallback for
     browsers without CompressionStream). A pasted code with the wrong
     prefix, bad base64, or a non-SDP payload is rejected with
     'code invalid' — never a throw into the page.

   CONTENT HANDSHAKE (host is authoritative)
     On channel open the HOST sends
       {type:'content', mapName, carName, mapHash, carHash}
     where the hashes are __ZIP.sha256Hex of the imported zip bytes
     (set via Multiplayer.setLocalContent); a procedural map or a
     built-in car has hash null. The JOINER compares against its own
     descriptor and replies {type:'content-ack', ok:true|false,...};
     the host logs "peer content OK" or "peer content mismatch".
     On mismatch the joiner side fires onContentMismatch(hostDesc) —
     game.js shows the loading-screen prompt "You need the host's
     map/car — import the same zip". After importing, the joiner calls
     recheckContent(), which sends {type:'content-have', ...own desc};
     the host compares and answers {type:'content-verdict', ok} and
     logs the result. State snapshots are only accepted once content
     is OK on the receiving side (hash verified before spawn).

   STATE SYNC (10 Hz, binary — chosen over JSON+base64 for size)
     Frame layout (little-endian):
       u16  nodeCount
       f32  center x, y, z            (car.center())
       i16  nodeCount*3 offsets       (node.pos - center) * 100 (cm),
                                      clamped to ±327.67 m
     Size at 500 nodes: 2 + 12 + 500*3*2 = 3,014 bytes per snapshot,
     ~30 KB/s per peer at 10 Hz. (JSON+base64 of the same payload
     would be ~4.1 KB per snapshot — the binary frame is ~27% smaller
     and needs no parse of 1,500 numbers into strings.)
     The receiver keeps Multiplayer.remote.latest = {t, pos, offsets,
     count} and Multiplayer.remote.hello = the peer's car descriptor
     ({kind:'builtin', defId} or {kind:'cage', name, carHash}).
     game.js spawns a REMOTE SoftBodyCar from the same def and lerps
     its nodes toward pos+offset each frame: remote cars are
     KINEMATIC PUPPETS (ghost) — they do not collide with the local
     car or the world; they are visual presence only. On disconnect
     game.js despawns the puppet via onPeerGone.

   API (window.Multiplayer)
     host()                 -> Promise<joinCode string>
     join(code)             -> Promise<replyCode string>
     acceptReply(code)      -> Promise<void> (resolves on connect)
     recheckContent()       joiner: re-offer its content descriptor
     setLocalContent(desc)  {mapName, carName, mapHash, carHash}
     sendState(car)         call every frame; throttled to 10 Hz inside
     disconnect()           tear down; state back to idle
     state                  live state object (see below)
     onLog, onCode, onStatus, onContentMismatch, onPeerGone, onConnected
                            assignable callbacks (game.js wires these)

   Classic script, no modules — safe from file://. RTCPeerConnection
   is read off window at call time so tests can stub it.
*/
(function(){
  'use strict';

  var MAX_ATTEMPTS = 4;
  var SEND_HZ = 10;
  var ICE_GATHER_MS = 3000;   // cap the wait for candidate gathering
  var STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  var state = {
    mode: 'idle',            // 'idle' | 'host' | 'joiner'
    status: 'idle',          // 'idle'|'awaiting-reply'|'connecting'|'connected'|'failed'
    attempt: 0,
    connected: false,
    failReason: null,
    contentOk: false,        // peer content verified (joiner: own vs host)
    peerContent: null,       // host descriptor as seen by the joiner
    localContent: { mapName:'Endless (procedural)', carName:null, mapHash:null, carHash:null }
  };
  var remote = { latest: null, hello: null, lastRxAt: 0 };

  var pc = null, dc = null;
  var pendingResolve = null, pendingReject = null;
  var lastSendAt = 0;
  var helloSent = false;

  var api = {
    state: state,
    remote: remote,
    onLog: null, onCode: null, onStatus: null,
    onContentMismatch: null, onPeerGone: null, onConnected: null,
    host: host, join: join, acceptReply: acceptReply,
    recheckContent: recheckContent, setLocalContent: setLocalContent,
    sendState: sendState, disconnect: disconnect,
    // exposed for the node mock test / debugging; not part of the game API
    _encodeSnapshot: encodeSnapshot, _decodeSnapshot: decodeSnapshot,
    _encodeCode: encodeCode, _decodeCode: decodeCode
  };
  window.Multiplayer = api;

  /* ---------------- logging / status ---------------- */
  function log(line){
    if (window.LoadingScreen && window.LoadingScreen.isOpen()) window.LoadingScreen.log(line);
    if (typeof api.onLog === 'function'){ try { api.onLog(line); } catch (e) {} }
  }
  function setStatus(s){
    state.status = s;
    if (typeof api.onStatus === 'function'){ try { api.onStatus(state); } catch (e) {} }
  }
  function fail(reason){
    state.connected = false;
    state.failReason = reason;
    setStatus('failed');
    log('failed: ' + reason);
    if (pendingReject){ var r = pendingReject; pendingResolve = pendingReject = null; r(new Error(reason)); }
  }

  /* ---------------- code encode/decode ---------------- */
  function bytesToB64url(bytes){
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlToBytes(str){
    str = String(str).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function gzip(bytes, want){
    // Returns a Promise<Uint8Array>; falls back to identity when the
    // platform lacks CompressionStream/DecompressionStream.
    var CS = window.CompressionStream, DS = window.DecompressionStream;
    if (want && !CS) return Promise.resolve(bytes);
    if (!want && !DS) return Promise.resolve(bytes);
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(want ? new CS('gzip') : new DS('gzip'));
      return new Response(stream).arrayBuffer().then(function(buf){ return new Uint8Array(buf); });
    } catch (e) { return Promise.resolve(bytes); }
  }
  function encodeCode(desc){
    var raw = new TextEncoder().encode(JSON.stringify(desc));
    var canGzip = !!window.CompressionStream;
    return gzip(raw, true).then(function(bytes){
      return (canGzip && bytes !== raw ? 'EDG1.' : 'EDR1.') + bytesToB64url(bytes);
    });
  }
  function decodeCode(code){
    code = String(code || '').trim();
    var gz = code.indexOf('EDG1.') === 0, rawP = code.indexOf('EDR1.') === 0;
    if (!gz && !rawP) return Promise.reject(new Error('code invalid'));
    var bytes;
    try { bytes = b64urlToBytes(code.slice(5)); } catch (e) { return Promise.reject(new Error('code invalid')); }
    return gzip(bytes, false).then(function(out){
      var desc;
      try { desc = JSON.parse(new TextDecoder().decode(out)); } catch (e) { throw new Error('code invalid'); }
      if (!desc || typeof desc.sdp !== 'string' || (desc.type !== 'offer' && desc.type !== 'answer'))
        throw new Error('code invalid');
      return desc;
    }, function(){ throw new Error('code invalid'); });
  }

  /* ---------------- peer lifecycle ---------------- */
  function rtcCtor(){
    var C = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!C) throw new Error('WebRTC is not available in this browser');
    return C;
  }
  function teardownPeer(){
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    dc = null; pc = null; helloSent = false;
    remote.latest = null; remote.hello = null;
  }
  function waitIceGathered(conn){
    return new Promise(function(resolve){
      if (conn.iceGatheringState === 'complete') return resolve();
      var done = false;
      var finish = function(){ if (!done){ done = true; resolve(); } };
      conn.addEventListener('icegatheringstatechange', function(){
        if (conn.iceGatheringState === 'complete') finish();
      });
      setTimeout(finish, ICE_GATHER_MS);
    });
  }
  function wirePeer(isHost){
    pc.oniceconnectionstatechange = function(){
      var s = pc.iceConnectionState;
      log('ICE: ' + s);
      if (s === 'failed') onIceFailed();
      else if (s === 'disconnected' && state.connected) onPeerLost('data channel closed');
    };
    pc.onconnectionstatechange = function(){
      if (pc.connectionState === 'failed') onIceFailed();
    };
    if (isHost){
      pc.ondatachannel = function(ev){ dc = ev.channel; wireChannel(); };
    }
  }
  function wireChannel(){
    dc.onopen = function(){
      state.connected = true;
      state.contentOk = state.mode === 'host'; // host's own content is authoritative by definition
      setStatus('connected');
      log('joined');
      sendHello();
      if (state.mode === 'host') sendContent();
      if (pendingResolve){ var r = pendingResolve; pendingResolve = pendingReject = null; r(); }
      if (typeof api.onConnected === 'function'){ try { api.onConnected(state); } catch (e) {} }
    };
    dc.onclose = function(){
      if (state.connected) onPeerLost('data channel closed');
      else if (state.status === 'connecting' || state.status === 'awaiting-reply') onIceFailed();
    };
    dc.onerror = function(){ log('data channel error'); };
    dc.onmessage = onMessage;
  }
  function onIceFailed(){
    if (state.status === 'failed') return;
    teardownPeer();
    state.connected = false;
    if (state.attempt >= MAX_ATTEMPTS){ fail('ICE failed'); return; }
    state.attempt++;
    log('attempting connect ' + state.attempt + '/' + MAX_ATTEMPTS + ' …');
    if (state.mode === 'host'){
      // fresh offer for the next attempt; the new code reaches the UI
      // through onCode — the old code is dead.
      startHostOffer().then(function(code){
        if (typeof api.onCode === 'function'){ try { api.onCode(code, 'offer'); } catch (e) {} }
      }, function(){ fail('ICE failed'); });
    } else {
      // a joiner cannot retry alone: it needs the host's fresh code.
      setStatus('awaiting-reply');
      log('waiting for the host\'s new join code (attempt ' + state.attempt + '/' + MAX_ATTEMPTS + ')');
    }
  }
  function onPeerLost(reason){
    var wasConnected = state.connected;
    teardownPeer();
    state.connected = false;
    setStatus('idle');
    state.mode = 'idle'; state.attempt = 0;
    log('peer left: ' + reason);
    if (wasConnected && typeof api.onPeerGone === 'function'){ try { api.onPeerGone(reason); } catch (e) {} }
  }

  /* ---------------- signaling entry points ---------------- */
  function startHostOffer(){
    var C = rtcCtor();
    pc = new C(STUN);
    dc = pc.createDataChannel('ed-state', { ordered: false, maxRetransmits: 2 });
    wirePeer(true); wireChannel();
    return pc.createOffer().then(function(offer){
      return pc.setLocalDescription(offer);
    }).then(function(){
      return waitIceGathered(pc);
    }).then(function(){
      return encodeCode(pc.localDescription);
    });
  }
  function host(){
    teardownPeer();
    state.mode = 'host'; state.attempt = 1; state.failReason = null; state.contentOk = false;
    setStatus('awaiting-reply');
    log('attempting connect 1/' + MAX_ATTEMPTS + ' …');
    log('hosting: share the join code, then paste the reply code');
    return startHostOffer();
  }
  function acceptReply(code){
    if (!pc || state.mode !== 'host') return Promise.reject(new Error('not hosting'));
    setStatus('connecting');
    return decodeCode(code).then(function(desc){
      if (desc.type !== 'answer') throw new Error('code invalid');
      return pc.setRemoteDescription(desc);
    }).then(function(){
      return new Promise(function(resolve, reject){ pendingResolve = resolve; pendingReject = reject; });
    }, function(err){
      fail(err && err.message === 'code invalid' ? 'code invalid' : 'ICE failed');
      throw err;
    });
  }
  function join(code){
    teardownPeer();
    if (state.mode !== 'joiner'){ state.mode = 'joiner'; state.attempt = 1; }
    else if (state.attempt < 1) state.attempt = 1;
    state.failReason = null; state.contentOk = false;
    setStatus('connecting');
    log('attempting connect ' + state.attempt + '/' + MAX_ATTEMPTS + ' …');
    return decodeCode(code).then(function(desc){
      if (desc.type !== 'offer') throw new Error('code invalid');
      var C = rtcCtor();
      pc = new C(STUN);
      wirePeer(false);
      return pc.setRemoteDescription(desc).then(function(){
        return pc.createAnswer();
      }).then(function(answer){
        return pc.setLocalDescription(answer);
      }).then(function(){
        return waitIceGathered(pc);
      }).then(function(){
        return encodeCode(pc.localDescription);
      });
    }).catch(function(err){
      if (err && err.message === 'code invalid'){ fail('code invalid'); }
      throw err;
    });
  }
  function disconnect(){
    teardownPeer();
    state.mode = 'idle'; state.attempt = 0; state.connected = false;
    setStatus('idle');
    log('disconnected');
  }

  /* ---------------- content handshake ---------------- */
  function setLocalContent(desc){
    if (!desc) return;
    state.localContent = {
      mapName: desc.mapName || 'Endless (procedural)',
      carName: desc.carName || null,
      mapHash: desc.mapHash || null,
      carHash: desc.carHash || null
    };
  }
  function sendJSON(obj){
    if (dc && dc.readyState === 'open'){
      try { dc.send(JSON.stringify(obj)); } catch (e) {}
    }
  }
  function sendHello(){
    if (helloSent) return;
    helloSent = true;
    var car = state.localCar || { kind:'builtin', defId:null, name: state.localContent.carName, carHash: state.localContent.carHash };
    sendJSON({ type:'hello', car: car });
  }
  function sendContent(){
    var c = state.localContent;
    sendJSON({ type:'content', mapName:c.mapName, carName:c.carName, mapHash:c.mapHash, carHash:c.carHash });
  }
  function contentMatches(a, b){
    return !!a && !!b && a.mapHash === b.mapHash && a.carHash === b.carHash &&
           a.mapName === b.mapName && a.carName === b.carName;
  }
  function recheckContent(){
    var c = state.localContent;
    sendJSON({ type:'content-have', mapName:c.mapName, carName:c.carName, mapHash:c.mapHash, carHash:c.carHash });
    log('re-checking content with the host…');
  }

  function onMessage(ev){
    if (typeof ev.data === 'string'){
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === 'hello'){
        remote.hello = msg.car || null;
        log('peer car: ' + (remote.hello && (remote.hello.name || remote.hello.defId) || 'unknown'));
      } else if (msg.type === 'content' && state.mode === 'joiner'){
        state.peerContent = { mapName:msg.mapName, carName:msg.carName, mapHash:msg.mapHash, carHash:msg.carHash };
        var ok = contentMatches(state.peerContent, state.localContent);
        state.contentOk = ok;
        sendJSON({ type:'content-ack', ok: ok });
        if (ok) log('content OK: map and car match the host');
        else {
          log('content mismatch: you need the host\'s map/car');
          if (typeof api.onContentMismatch === 'function'){ try { api.onContentMismatch(state.peerContent); } catch (e) {} }
        }
      } else if (msg.type === 'content-ack' && state.mode === 'host'){
        log(msg.ok ? 'peer content OK' : 'peer content mismatch');
        state.peerContentOk = !!msg.ok;
      } else if (msg.type === 'content-have' && state.mode === 'host'){
        var have = { mapName:msg.mapName, carName:msg.carName, mapHash:msg.mapHash, carHash:msg.carHash };
        var ok2 = contentMatches(have, state.localContent);
        state.peerContentOk = ok2;
        log(ok2 ? 'peer content OK' : 'peer content mismatch');
        sendJSON({ type:'content-verdict', ok: ok2 });
      } else if (msg.type === 'content-verdict' && state.mode === 'joiner'){
        state.contentOk = !!msg.ok;
        log(msg.ok ? 'content OK: map and car match the host' : 'content mismatch: you need the host\'s map/car');
        if (!msg.ok && typeof api.onContentMismatch === 'function'){
          try { api.onContentMismatch(state.peerContent); } catch (e) {}
        }
      }
      return;
    }
    // binary state snapshot — only once content is verified, so a car
    // is never spawned from content the peer has not proven it shares.
    if (!state.contentOk && state.mode === 'joiner') return;
    var snap = decodeSnapshot(ev.data);
    if (snap){ remote.latest = snap; remote.lastRxAt = performance.now(); }
  }

  /* ---------------- state snapshots ---------------- */
  function encodeSnapshot(car){
    var c = car.center();
    var n = car.nodes.length;
    var buf = new ArrayBuffer(2 + 12 + n * 3 * 2);
    var dv = new DataView(buf);
    dv.setUint16(0, n, true);
    dv.setFloat32(2, c.x, true); dv.setFloat32(6, c.y, true); dv.setFloat32(10, c.z, true);
    var off = 14;
    for (var i = 0; i < n; i++){
      var p = car.nodes[i].pos;
      dv.setInt16(off, Math.max(-32768, Math.min(32767, Math.round((p.x - c.x) * 100))), true);
      dv.setInt16(off + 2, Math.max(-32768, Math.min(32767, Math.round((p.y - c.y) * 100))), true);
      dv.setInt16(off + 4, Math.max(-32768, Math.min(32767, Math.round((p.z - c.z) * 100))), true);
      off += 6;
    }
    return buf;
  }
  function decodeSnapshot(buf){
    try {
      var dv = new DataView(buf);
      var n = dv.getUint16(0, true);
      if (buf.byteLength < 14 + n * 6) return null;
      var offsets = new Int16Array(n * 3);
      for (var i = 0; i < n * 3; i++) offsets[i] = dv.getInt16(14 + i * 2, true);
      return {
        t: performance.now(), count: n,
        pos: [dv.getFloat32(2, true), dv.getFloat32(6, true), dv.getFloat32(10, true)],
        nodeOffsets: offsets
      };
    } catch (e) { return null; }
  }
  function sendState(car){
    if (!dc || dc.readyState !== 'open' || !car) return;
    // the joiner sends nothing until the host's content is verified
    if (state.mode === 'joiner' && !state.contentOk) return;
    var now = performance.now();
    if (now - lastSendAt < 1000 / SEND_HZ) return;
    lastSendAt = now;
    try { dc.send(encodeSnapshot(car)); } catch (e) {}
  }

  // game.js sets this before connecting so hello/content name the car
  api.setLocalCar = function(carDesc){ state.localCar = carDesc || null; helloSent = false; };
})();
