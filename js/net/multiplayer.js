/* ============================ MULTIPLAYER ============================
   Endless Drive v2.7.1 — WebRTC multiplayer, two transports.

   PRIMARY: PeerJS cloud broker + 5-CHARACTER ROOM CODES.
     The host registers the PeerJS id "endlessdrive-" + CODE, where
     CODE is 5 characters from an unambiguous alphabet (no 0/O/1/I/L).
     The joiner types the code; PeerJS brokers the WebRTC handshake,
     so nobody copy-pastes SDP any more. If the broker says the id is
     taken, the host silently picks another code (narrated in the log)
     — the code the host finally displays is the one that works.
   FALLBACK: manual copy-paste codes (the v2.7 flow, unchanged).
     Used when PeerJS fails to load (no window.Peer) or the broker
     errors before a connection exists. The loading log says plainly
     that short codes are unavailable and the long code is being used.
     A pasted code selects its own transport: 5 room characters ->
     PeerJS, an "EDG1."/"EDR1." code -> manual.

   ROOM-CODE VISIBILITY INVARIANT (the v2.7 bug: the loading overlay
   covered the code in the menu): during setup the room code lives
   INSIDE the loading panel (LoadingScreen.setRoomCode) — big, with a
   copy button — for the whole setup, and the joiner's code entry
   stays in the menu, still filled, behind a loading panel that names
   the room being joined and offers Cancel. The code is never under
   the overlay and never only in the menu while the overlay is up.

   FLOW / STATE MACHINE
     idle
       -> host():  PeerJS: register id, resolve with the room code,
          status 'awaiting-reply', attempt 1/4. Manual: mint an offer,
          resolve with the long join code.
       -> join(code): room code -> PeerJS connect (resolves when the
          channel opens). Long code -> manual: decode the offer,
          resolve with the long REPLY code; the host then pastes it
          into acceptReply(code).
     data connection open -> 'connected': both sides exchange hello +
          content descriptors (below), then 10 Hz state snapshots.
     Connection failure before open: attempts 1..4, narrated as
          "attempting connect N/4 …". A PeerJS host keeps the same room
          code across attempts (its id stays registered); a PeerJS
          joiner retries the same code. A MANUAL host mints a FRESH
          offer per attempt (offers are single-use; the new code is
          delivered via onCode); a manual joiner waits for the host's
          new code. After attempt 4: 'failed' with a reason.
     Every transition is written to the LoadingScreen log (when it is
     open) and to Multiplayer.onLog, in the exact forms:
       "attempting connect N/4 …", "joined", "failed: <reason>".

   MANUAL CODES
     The SDP JSON ({type, sdp}) is gzip-compressed with
     CompressionStream where the browser has it, then base64url.
     Prefix "EDG1." = gzipped, "EDR1." = raw JSON (fallback for
     browsers without CompressionStream). A pasted code with the wrong
     prefix, bad base64, or a non-SDP payload is rejected with
     'code invalid' — never a throw into the page.

   CONTENT HANDSHAKE (host is authoritative; unchanged by transport)
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
     host()                 -> Promise<code string> (room code, or the
                               long join code on the manual fallback)
     join(code)             -> Promise<string> (room code: resolves on
                               connect; long code: the reply code)
     acceptReply(code)      -> Promise<void> (manual host only)
     recheckContent()       joiner: re-offer its content descriptor
     setLocalContent(desc)  {mapName, carName, mapHash, carHash}
     sendState(car)         call every frame; throttled to 10 Hz inside
     disconnect()           tear down; state back to idle
     normalizeRoomCode(s)   -> canonical 5-char code or null
     state                  live state object (see below; .transport
                              is 'none'|'peerjs'|'manual', .roomCode
                              the current room code or null)
     onLog, onCode, onStatus, onContentMismatch, onPeerGone, onConnected
                            assignable callbacks (game.js wires these)

   Classic script, no modules — safe from file://. RTCPeerConnection
   and Peer are read off window at call time so tests can stub them.
*/
(function(){
  'use strict';

  var MAX_ATTEMPTS = 4;
  var SEND_HZ = 10;
  var ICE_GATHER_MS = 3000;   // cap the wait for candidate gathering
  var STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  /* ---------------- room codes ---------------- */
  // 31 unambiguous characters: A-Z without I, L, O + digits 2-9.
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var CODE_LENGTH = 5;
  var PEER_PREFIX = 'endlessdrive-';
  var ID_RETRIES = 10;        // broker "id taken" regenerations
  var JOIN_RETRY_MS = 600;    // pause between PeerJS join attempts
  var JOIN_TIMEOUT_MS = 12000; // one PeerJS join attempt may take this long

  function generateRoomCode(){
    var out = '';
    var buf = null;
    if (typeof crypto !== 'undefined' && crypto.getRandomValues){
      buf = new Uint8Array(CODE_LENGTH);
      crypto.getRandomValues(buf);
    }
    for (var i = 0; i < CODE_LENGTH; i++){
      var r = buf ? buf[i] : Math.floor(Math.random() * 256);
      out += CODE_ALPHABET[r % CODE_ALPHABET.length];
    }
    return out;
  }
  function normalizeRoomCode(s){
    if (typeof s !== 'string') return null;
    var t = s.toUpperCase().replace(/[\s-]+/g, '');
    if (t.length !== CODE_LENGTH) return null;
    for (var i = 0; i < t.length; i++)
      if (CODE_ALPHABET.indexOf(t.charAt(i)) < 0) return null;
    return t;
  }
  function peerAvailable(){ return typeof window.Peer === 'function'; }

  var state = {
    mode: 'idle',            // 'idle' | 'host' | 'joiner'
    status: 'idle',          // 'idle'|'awaiting-reply'|'connecting'|'connected'|'failed'
    attempt: 0,
    connected: false,
    failReason: null,
    transport: 'none',       // 'none' | 'peerjs' | 'manual'
    roomCode: null,          // current 5-char room code (PeerJS only)
    contentOk: false,        // peer content verified (joiner: own vs host)
    peerContent: null,       // host descriptor as seen by the joiner
    localContent: { mapName:'Endless (procedural)', carName:null, mapHash:null, carHash:null }
  };
  var remote = { latest: null, hello: null, lastRxAt: 0 };

  var pc = null, dc = null;          // manual transport
  var peer = null, pconn = null;     // PeerJS transport
  var pendingResolve = null, pendingReject = null;
  var lastSendAt = 0;
  var helloSent = false;
  var joinTimer = 0, retryTimer = 0;

  var api = {
    state: state,
    remote: remote,
    onLog: null, onCode: null, onStatus: null,
    onContentMismatch: null, onPeerGone: null, onConnected: null,
    host: host, join: join, acceptReply: acceptReply,
    recheckContent: recheckContent, setLocalContent: setLocalContent,
    sendState: sendState, disconnect: disconnect,
    normalizeRoomCode: normalizeRoomCode,
    // exposed for the node mock test / debugging; not part of the game API
    _encodeSnapshot: encodeSnapshot, _decodeSnapshot: decodeSnapshot,
    _encodeCode: encodeCode, _decodeCode: decodeCode,
    _generateRoomCode: generateRoomCode, _CODE_ALPHABET: CODE_ALPHABET,
    _PEER_PREFIX: PEER_PREFIX
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
  function emitCode(code, kind){
    if (typeof api.onCode === 'function'){ try { api.onCode(code, kind); } catch (e) {} }
  }

  /* ---------------- manual code encode/decode ---------------- */
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

  /* ---------------- channel abstraction ----------------
     Both transports feed the same handlers: channelOpened(),
     handleData(data), and a close/failure path. sendJSON/sendState
     go through channelSend/channelIsOpen so the handshake and the
     snapshot protocol do not know which transport is live. */
  function channelIsOpen(){
    if (state.transport === 'peerjs') return !!(pconn && pconn.open);
    return !!(dc && dc.readyState === 'open');
  }
  function channelSend(data){
    try {
      if (state.transport === 'peerjs'){ if (pconn && pconn.open) pconn.send(data); }
      else if (dc && dc.readyState === 'open') dc.send(data);
    } catch (e) {}
  }
  function channelOpened(){
    clearTimeout(joinTimer); clearTimeout(retryTimer);
    state.connected = true;
    // The host's own content is authoritative by definition. For the
    // joiner this must NOT clobber an existing verification: the
    // host's content message can legally arrive before the local
    // open event fires (it did over the manual transport), and
    // resetting contentOk here would un-verify a checked peer.
    state.contentOk = state.contentOk || state.mode === 'host';
    setStatus('connected');
    log('joined');
    sendHello();
    if (state.mode === 'host') sendContent();
    if (pendingResolve){ var r = pendingResolve; pendingResolve = pendingReject = null; r(state.roomCode || undefined); }
    if (typeof api.onConnected === 'function'){ try { api.onConnected(state); } catch (e) {} }
  }
  function channelClosed(){
    if (state.connected) onPeerLost('data channel closed');
    else if (state.status === 'connecting' || state.status === 'awaiting-reply'){
      // pre-connect close = a failed attempt. The status check also
      // keeps teardown closes (status already moved on) out of here.
      if (state.transport === 'peerjs') onPeerAttemptFailed();
      else onIceFailed();
    }
  }
  function onPeerLost(reason){
    var wasConnected = state.connected;
    state.connected = false; // before teardown: a nested close event must not re-enter
    teardownPeer();
    destroyPeer();
    state.transport = 'none'; state.roomCode = null;
    setStatus('idle');
    state.mode = 'idle'; state.attempt = 0;
    log('peer left: ' + reason);
    if (wasConnected && typeof api.onPeerGone === 'function'){ try { api.onPeerGone(reason); } catch (e) {} }
  }

  /* ---------------- teardown helpers ---------------- */
  function teardownPeer(){
    clearTimeout(joinTimer); clearTimeout(retryTimer);
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    try { if (pconn) pconn.close(); } catch (e) {}
    dc = null; pc = null; pconn = null; helloSent = false;
    remote.latest = null; remote.hello = null;
  }
  function destroyPeer(){
    if (peer){ try { peer.destroy(); } catch (e) {} peer = null; }
  }
  function closePconn(){
    var c = pconn;
    pconn = null; // null first: close() may synchronously fire handlers
    if (c){ try { c.close(); } catch (e) {} }
  }

  /* ================= MANUAL TRANSPORT (fallback) ================= */
  function rtcCtor(){
    var C = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!C) throw new Error('WebRTC is not available in this browser');
    return C;
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
    // The channel arrives via ondatachannel on the ANSWERING side;
    // the host created its channel directly in startHostOffer (the
    // event never fires for the creator). v2.7 installed this handler
    // for the host only, so a manual joiner never captured its channel
    // and could never send or connect — install it on both sides.
    pc.ondatachannel = function(ev){ dc = ev.channel; wireChannel(); };
  }
  function wireChannel(){
    dc.onopen = channelOpened;
    dc.onclose = channelClosed;
    dc.onerror = function(){ log('data channel error'); };
    dc.onmessage = function(ev){ handleData(ev.data); };
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
      startHostOffer().then(function(code){ emitCode(code, 'offer'); },
        function(){ fail('ICE failed'); });
    } else {
      // a joiner cannot retry alone: it needs the host's fresh code.
      setStatus('awaiting-reply');
      log('waiting for the host\'s new join code (attempt ' + state.attempt + '/' + MAX_ATTEMPTS + ')');
    }
  }
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
  function acceptReply(code){
    if (!pc || state.mode !== 'host' || state.transport !== 'manual')
      return Promise.reject(new Error('not hosting'));
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
  function joinManual(code){
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

  /* ================= PEERJS TRANSPORT (primary) ================= */
  function wirePconn(conn){
    conn.on('open', channelOpened);
    conn.on('data', handleData);
    conn.on('close', channelClosed);
    conn.on('error', function(){ log('data connection error'); });
    try {
      conn.on('iceStateChanged', function(s){
        log('ICE: ' + s);
        if (s === 'failed'){
          if (state.connected) onPeerLost('data channel closed');
          else onPeerAttemptFailed();
        } else if (s === 'disconnected' && state.connected) onPeerLost('data channel closed');
      });
    } catch (e) {}
  }
  var peerFailGuard = false;
  function onPeerAttemptFailed(){
    // closePconn() below can synchronously re-enter via the close
    // event; the guard makes one failure count as exactly one attempt.
    if (peerFailGuard) return;
    if (state.status === 'failed' || state.transport !== 'peerjs') return;
    peerFailGuard = true;
    clearTimeout(joinTimer);
    closePconn();
    peerFailGuard = false;
    state.connected = false;
    if (state.attempt >= MAX_ATTEMPTS){ fail('connection failed'); return; }
    state.attempt++;
    log('attempting connect ' + state.attempt + '/' + MAX_ATTEMPTS + ' …');
    if (state.mode === 'host'){
      // the room code stays valid: the id is still registered with
      // the broker, so the joiner can simply try the same code again.
      setStatus('awaiting-reply');
      log('room ' + state.roomCode + ' is still open — waiting for the joiner');
    } else {
      setStatus('connecting');
      var code = state.roomCode;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(function(){
        if (state.mode === 'joiner' && state.transport === 'peerjs' &&
            state.status === 'connecting' && peer) connectToHost(code);
      }, JOIN_RETRY_MS);
    }
  }
  function onPeerIncoming(conn){
    if (pconn){ try { conn.close(); } catch (e) {} return; } // one guest at a time
    pconn = conn;
    setStatus('connecting');
    log('joiner is connecting…');
    wirePconn(conn);
  }
  function startPeerHost(){
    return new Promise(function(resolve, reject){
      var settled = false;
      var idTries = 0;
      function settleManual(){
        if (settled) return;
        settled = true;
        destroyPeer();
        state.transport = 'manual'; state.roomCode = null;
        log('short room codes are unavailable right now — using the long code instead. Share it from the code box in the loading panel.');
        startHostOffer().then(function(code){ emitCode(code, 'offer'); resolve(code); }, reject);
      }
      function register(){
        var code = generateRoomCode();
        state.roomCode = code;
        var P = window.Peer;
        try { peer = new P(PEER_PREFIX + code, { config: STUN }); }
        catch (e) { settleManual(); return; }
        peer.on('open', function(){
          if (settled) return;
          settled = true;
          state.transport = 'peerjs';
          log('room code ready: ' + code);
          emitCode(code, 'room');
          resolve(code);
        });
        peer.on('connection', onPeerIncoming);
        peer.on('error', function(err){
          var t = err && err.type;
          if (t === 'unavailable-id' && !settled){
            idTries++;
            log('room code ' + code + ' is already taken — picking another…');
            destroyPeer();
            if (idTries < ID_RETRIES) register(); else settleManual();
            return;
          }
          if (!state.connected && !pconn &&
              (t === 'network' || t === 'server-error' || t === 'socket-error' ||
               t === 'socket-closed' || t === 'browser-incompatible')){
            settleManual();
            return;
          }
          log('network: ' + (t || 'error'));
        });
        peer.on('disconnected', function(){
          // signaling socket dropped; the broker id survives a
          // reconnect, so ask PeerJS to re-register the same code.
          if (peer && !state.connected){ try { peer.reconnect(); } catch (e) {} }
        });
        peer.on('close', function(){
          if (state.connected) onPeerLost('data channel closed');
        });
      }
      register();
    });
  }
  function connectToHost(code){
    if (!peer) return;
    closePconn();
    var conn;
    try { conn = peer.connect(PEER_PREFIX + code, { reliable: true }); }
    catch (e) { onPeerAttemptFailed(); return; }
    pconn = conn;
    wirePconn(conn);
    clearTimeout(joinTimer);
    joinTimer = setTimeout(function(){
      if (!state.connected && state.mode === 'joiner' && state.transport === 'peerjs')
        onPeerAttemptFailed();
    }, JOIN_TIMEOUT_MS);
  }
  function startPeerJoin(code){
    return new Promise(function(resolve, reject){
      pendingResolve = function(){ resolve(code); };
      pendingReject = reject;
      var P = window.Peer;
      try { peer = new P({ config: STUN }); }
      catch (e) { fail('broker unreachable'); return; }
      state.transport = 'peerjs';
      peer.on('open', function(){ connectToHost(code); });
      peer.on('error', function(err){
        var t = err && err.type;
        if (state.connected) { log('network: ' + (t || 'error')); return; }
        if (t === 'peer-unavailable'){ onPeerAttemptFailed(); return; }
        if (t === 'network' || t === 'server-error' || t === 'socket-error' ||
            t === 'socket-closed' || t === 'browser-incompatible'){
          fail('broker unreachable');
          return;
        }
        log('network: ' + (t || 'error'));
      });
      peer.on('close', function(){
        if (state.connected) onPeerLost('data channel closed');
      });
    });
  }

  /* ---------------- signaling entry points ---------------- */
  function host(){
    teardownPeer();
    destroyPeer();
    state.mode = 'host'; state.attempt = 1; state.failReason = null; state.contentOk = false;
    state.roomCode = null;
    setStatus('awaiting-reply');
    log('attempting connect 1/' + MAX_ATTEMPTS + ' …');
    if (peerAvailable()){
      state.transport = 'peerjs';
      return startPeerHost();
    }
    state.transport = 'manual';
    log('short room codes are unavailable (the PeerJS library did not load) — using the long code instead. Share it from the code box in the loading panel.');
    log('hosting: share the join code, then paste the reply code');
    return startHostOffer();
  }
  function join(code){
    teardownPeer();
    destroyPeer();
    var room = normalizeRoomCode(code);
    if (state.mode !== 'joiner'){ state.mode = 'joiner'; state.attempt = 1; }
    else if (state.attempt < 1) state.attempt = 1;
    state.failReason = null; state.contentOk = false;
    if (room){
      state.roomCode = room;
      if (!peerAvailable()){
        state.transport = 'none';
        fail('short codes unavailable — PeerJS did not load; ask the host for a long code');
        return Promise.reject(new Error('short codes unavailable'));
      }
      state.transport = 'peerjs';
      setStatus('connecting');
      log('attempting connect ' + state.attempt + '/' + MAX_ATTEMPTS + ' …');
      log('joining room ' + room + ' …');
      return startPeerJoin(room);
    }
    // long manual code
    state.transport = 'manual'; state.roomCode = null;
    setStatus('connecting');
    log('attempting connect ' + state.attempt + '/' + MAX_ATTEMPTS + ' …');
    return joinManual(code);
  }
  function disconnect(){
    teardownPeer();
    destroyPeer();
    state.mode = 'idle'; state.attempt = 0; state.connected = false;
    state.transport = 'none'; state.roomCode = null;
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
    if (channelIsOpen()){
      try { channelSend(JSON.stringify(obj)); } catch (e) {}
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

  function handleData(data){
    if (typeof data === 'string'){
      var msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
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
    var snap = decodeSnapshot(data);
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
    if (!channelIsOpen() || !car) return;
    // the joiner sends nothing until the host's content is verified
    if (state.mode === 'joiner' && !state.contentOk) return;
    var now = performance.now();
    if (now - lastSendAt < 1000 / SEND_HZ) return;
    lastSendAt = now;
    try { channelSend(encodeSnapshot(car)); } catch (e) {}
  }

  // game.js sets this before connecting so hello/content name the car
  api.setLocalCar = function(carDesc){ state.localCar = carDesc || null; helloSent = false; };
})();
