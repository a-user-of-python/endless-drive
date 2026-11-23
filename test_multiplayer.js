'use strict';
/* Endless Drive v2.7.1 — multiplayer test harness (Node, no browser).
   Run: node test_multiplayer.js  (from web-v2/)
   Covers js/net/multiplayer.js against a MOCK PeerJS broker and a
   MOCK RTCPeerConnection — no network, no real PeerJS cloud:

   - room codes: alphabet (31 unambiguous chars, no 0/O/1/I/L),
     length 5, generation across 2000 samples
   - input normalization: case / spaces / dashes, rejection of bad
     characters and wrong lengths
   - PeerJS host: code from the registered id; a broker "unavailable-id"
     makes the host pick another code (narrated) and still resolve
   - PeerJS host+joiner: connect, "joined", content handshake OK and
     mismatch (onContentMismatch, snapshot gating), snapshot round-trip
   - PeerJS joiner vs a nonexistent room: attempts narrate 1..4, then
     'failed: connection failed'
   - fallback A: PeerJS library missing (no window.Peer) -> manual
     long-code host/join/acceptReply round trip incl. handshake
   - fallback B: broker error before open -> host falls back to the
     manual long code, log says so plainly
   - snapshot encode/decode round-trip (regression guard)
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    (info) => console.log('PASS ' + name + (info ? ' — ' + info : '')),
    (e) => { failures++; console.log('FAIL ' + name + ' — ' + (e && e.stack || e)); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > (ms || 4000)) throw new Error('timeout waiting for ' + what);
    await delay(10);
  }
}

/* ================= mock PeerJS broker =================
   A shared registry stands in for the PeerJS cloud: constructing a
   Peer with an id registers it (or errors 'unavailable-id'), an
   anonymous Peer gets a random id, connect() finds the remote peer
   (or errors 'peer-unavailable' on the caller) and delivers a paired
   connection to both sides. MockPeer.failNextOpenWith forces the next
   registration to fail with the given error type (broker outage). */
class MockConn {
  constructor(remoteId) {
    this.remoteId = remoteId; this.handlers = {}; this.open = false;
    this.other = null; this.closed = false;
  }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, a) { (this.handlers[ev] || []).slice().forEach(f => f(a)); }
  send(data) {
    if (!this.open) throw new Error('send on a closed connection');
    if (this.other) this.other.emit('data', data);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.open = false; this.emit('close');
    const o = this.other;
    if (o && !o.closed) { o.closed = true; o.open = false; o.emit('close'); }
  }
  _openBoth() {
    this.open = true; if (this.other) this.other.open = true;
    this.emit('open'); if (this.other) this.other.emit('open');
  }
}
class MockPeer {
  constructor(id, opts) {
    this.id = (typeof id === 'string') ? id : null;
    this.handlers = {}; this.destroyed = false; this.connections = [];
    MockPeer.instances.push(this);
    const self = this;
    setTimeout(() => {
      if (self.destroyed) return;
      if (MockPeer.failNextOpenWith) {
        const t = MockPeer.failNextOpenWith; MockPeer.failNextOpenWith = null;
        self.emit('error', { type: t }); return;
      }
      if (self.id) {
        if (MockPeer.broker.has(self.id)) { self.emit('error', { type: 'unavailable-id' }); return; }
        MockPeer.broker.set(self.id, self);
      } else {
        self.id = 'mock-anon-' + (++MockPeer.seq);
      }
      self.emit('open', self.id);
    }, 0);
  }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, a) { (this.handlers[ev] || []).slice().forEach(f => f(a)); }
  connect(remoteId, opts) {
    const conn = new MockConn(remoteId);
    this.connections.push(conn);
    const self = this;
    setTimeout(() => {
      if (conn.closed) return;
      const remote = MockPeer.broker.get(remoteId);
      if (!remote) { self.emit('error', { type: 'peer-unavailable' }); return; }
      const incoming = new MockConn(self.id);
      incoming.other = conn; conn.other = incoming;
      remote.emit('connection', incoming);
      setTimeout(() => { if (!conn.closed) conn._openBoth(); }, 0);
    }, 0);
    return conn;
  }
  destroy() {
    this.destroyed = true;
    if (this.id && MockPeer.broker.get(this.id) === this) MockPeer.broker.delete(this.id);
  }
  reconnect() {}
}
MockPeer.broker = new Map();
MockPeer.instances = [];
MockPeer.seq = 0;
MockPeer.failNextOpenWith = null;
function resetBroker() {
  MockPeer.broker.clear(); MockPeer.instances = []; MockPeer.failNextOpenWith = null;
}

/* ================= mock RTCPeerConnection (manual transport) ===== */
class MockDataChannel {
  constructor(label) {
    this.label = label; this.readyState = 'open'; this.other = null;
    this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null;
  }
  send(data) { if (this.other && this.other.onmessage) this.other.onmessage({ data }); }
  close() { this.readyState = 'closed'; if (this.onclose) this.onclose(); }
  _fireOpen() { if (this.onopen) this.onopen(); }
}
class MockRTC {
  constructor() {
    this.iceGatheringState = 'complete';
    this.localDescription = null; this.channel = null;
    this.ondatachannel = null; this.oniceconnectionstatechange = null; this.onconnectionstatechange = null;
    MockRTC.instances.push(this);
  }
  createDataChannel(label) { this.channel = new MockDataChannel(label); return this.channel; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'mock-offer-sdp' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'mock-answer-sdp' }); }
  setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
  setRemoteDescription(d) { this.remoteDescription = d; return Promise.resolve(); }
  addEventListener() {}
  close() {}
}
MockRTC.instances = [];

/* ================= module loading =================
   Each "browser" is a fresh vm context whose window is itself, so a
   host and a joiner run the real module side by side. */
function loadModule(opts) {
  opts = opts || {};
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    performance, TextEncoder, TextDecoder, btoa, atob,
    crypto: globalThis.crypto
  };
  ctx.window = ctx;
  if (opts.peer) ctx.Peer = MockPeer;
  if (opts.rtc) ctx.RTCPeerConnection = MockRTC;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'js', 'net', 'multiplayer.js'), 'utf8'),
    ctx, { filename: 'multiplayer.js' });
  const M = ctx.window.Multiplayer;
  M._logs = [];
  M.onLog = line => M._logs.push(line);
  return M;
}
function fakeCar() {
  return {
    center: () => ({ x: 10, y: 2, z: -5 }),
    nodes: [0, 1, 2].map(i => ({ pos: { x: 10 + i, y: 2, z: -5 + i } }))
  };
}

/* ================= tests ================= */
(async () => {

await test('room code alphabet + generation', () => {
  const M = loadModule({});
  const A = M._CODE_ALPHABET;
  assert(A.length === 31, 'alphabet has 31 chars, got ' + A.length);
  assert(!A.includes('0') && !A.includes('O') && !A.includes('1') && !A.includes('I') && !A.includes('L'),
    'alphabet excludes 0, O, 1, I, L');
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = M._generateRoomCode();
    assert(c.length === 5, 'code length 5, got "' + c + '"');
    for (const ch of c) assert(A.includes(ch), 'char ' + ch + ' in alphabet');
    seen.add(c);
  }
  assert(seen.size > 1500, 'codes are well spread (' + seen.size + ' unique of 2000)');
  return seen.size + ' unique codes in 2000 draws';
});

await test('room code normalization', () => {
  const M = loadModule({});
  const n = M.normalizeRoomCode;
  assert(n('abcde') === 'ABCDE', 'lowercase uppercased');
  assert(n('AB CDE') === 'ABCDE', 'spaces stripped');
  assert(n('ab-cd-e') === 'ABCDE', 'dashes stripped');
  assert(n(' ABCDE ') === 'ABCDE', 'trimmed');
  assert(n('ABC1E') === null, 'digit 1 rejected');
  assert(n('ABODE') === null, 'letter O rejected');
  assert(n('ABCD') === null, 'too short rejected');
  assert(n('ABCDEF') === null, 'too long rejected');
  assert(n('') === null, 'empty rejected');
  assert(n(null) === null, 'null rejected');
  assert(n('EDG1.') === null, 'long-code prefix is not a room code');
});

await test('peerjs host: code comes from the registered id', async () => {
  resetBroker();
  const H = loadModule({ peer: true });
  const code = await H.host();
  assert(H.normalizeRoomCode(code) === code, 'host code is a valid room code: ' + code);
  assert(H.state.transport === 'peerjs', 'transport is peerjs');
  assert(H.state.roomCode === code, 'state.roomCode matches');
  assert(MockPeer.broker.has('endlessdrive-' + code), 'broker id registered');
  assert(H._logs.some(l => l === 'attempting connect 1/4 …'), 'attempt narrated');
  assert(H._logs.some(l => l === 'room code ready: ' + code), 'ready narrated');
  H.disconnect();
});

await test('peerjs host: taken id -> picks another code, narrated', async () => {
  resetBroker();
  const H = loadModule({ peer: true });
  MockPeer.failNextOpenWith = 'unavailable-id';
  const code = await H.host();
  assert(H.normalizeRoomCode(code) === code, 'resolved with a valid code');
  assert(MockPeer.broker.has('endlessdrive-' + code), 'second id registered');
  assert(H._logs.some(l => /already taken — picking another/.test(l)), 'retry narrated');
  H.disconnect();
});

await test('peerjs host+joiner: connect, handshake OK, snapshots flow', async () => {
  resetBroker();
  const H = loadModule({ peer: true });
  const J = loadModule({ peer: true });
  const desc = { mapName: 'Endless (procedural)', carName: 'Sedan', mapHash: null, carHash: null };
  H.setLocalContent(desc); J.setLocalContent(desc);
  H.setLocalCar({ kind: 'builtin', defId: 'sedan', name: 'Sedan', carHash: null });
  J.setLocalCar({ kind: 'builtin', defId: 'sedan', name: 'Sedan', carHash: null });
  const code = await H.host();
  const joined = J.join(code.toLowerCase()); // joiner typed it lowercase
  await until(() => H.state.connected && J.state.connected, 4000, 'both connected');
  await joined;
  assert(J.state.transport === 'peerjs' && H.state.transport === 'peerjs', 'peerjs both sides');
  assert(J._logs.some(l => l === 'joined'), 'joiner logged joined');
  await until(() => J.state.contentOk === true, 2000, 'joiner content OK');
  await until(() => H.state.peerContentOk === true, 2000, 'host peer content OK');
  // snapshot host -> joiner is accepted now that content is verified
  H.sendState(fakeCar());
  await until(() => !!J.remote.latest, 2000, 'snapshot received');
  assert(J.remote.latest.count === 3, 'snapshot node count 3');
  assert(Math.abs(J.remote.latest.pos[0] - 10) < 1e-4, 'snapshot center x');
  assert(J.remote.hello && J.remote.hello.defId === 'sedan', 'hello received');
  H.disconnect(); J.disconnect();
});

await test('peerjs handshake mismatch: joiner gated, mismatch callback fires', async () => {
  resetBroker();
  const H = loadModule({ peer: true });
  const J = loadModule({ peer: true });
  H.setLocalContent({ mapName: 'MapA', carName: 'Sedan', mapHash: 'aaa', carHash: null });
  J.setLocalContent({ mapName: 'MapB', carName: 'Sedan', mapHash: 'bbb', carHash: null });
  let mismatchDesc = null;
  J.onContentMismatch = d => { mismatchDesc = d; };
  const code = await H.host();
  J.join(code).catch(() => {});
  await until(() => J.state.connected, 4000, 'connected');
  await until(() => mismatchDesc !== null, 2000, 'mismatch callback');
  assert(mismatchDesc.mapHash === 'aaa', 'joiner was told the host descriptor');
  assert(J.state.contentOk === false, 'joiner content not OK');
  H.sendState(fakeCar());
  await delay(150);
  assert(J.remote.latest === null, 'snapshot gated until content verifies');
  // joiner imports the right map and re-checks
  J.setLocalContent({ mapName: 'MapA', carName: 'Sedan', mapHash: 'aaa', carHash: null });
  J.recheckContent();
  await until(() => J.state.contentOk === true, 2000, 'content OK after recheck');
  H.sendState(fakeCar());
  await until(() => !!J.remote.latest, 2000, 'snapshot flows after recheck');
  H.disconnect(); J.disconnect();
});

await test('peerjs joiner: nonexistent room narrates attempts 1..4 then fails', async () => {
  resetBroker();
  const J = loadModule({ peer: true });
  let err = null;
  await J.join('ZZZZZ').catch(e => { err = e; });
  assert(err && err.message === 'connection failed', 'join rejected with connection failed, got ' + err);
  assert(J.state.status === 'failed', 'state failed');
  for (const n of [2, 3, 4])
    assert(J._logs.some(l => l === 'attempting connect ' + n + '/4 …'), 'attempt ' + n + ' narrated');
  assert(J._logs.some(l => l === 'failed: connection failed'), 'failure narrated');
  J.disconnect();
  return 'retries took the narrated path';
});

await test('fallback A: no PeerJS library -> manual long-code round trip', async () => {
  MockRTC.instances = [];
  const H = loadModule({ rtc: true });
  const J = loadModule({ rtc: true });
  const desc = { mapName: 'Endless (procedural)', carName: 'Sedan', mapHash: null, carHash: null };
  H.setLocalContent(desc); J.setLocalContent(desc);
  const offer = await H.host();
  assert(/^ED[GR]1\./.test(offer), 'manual join code has ED prefix');
  assert(H.state.transport === 'manual', 'host transport manual');
  assert(H._logs.some(l => /short room codes are unavailable/.test(l) && /long code/.test(l)),
    'fallback stated plainly in the log');
  const reply = await J.join(offer);
  assert(/^ED[GR]1\./.test(reply), 'manual reply code has ED prefix');
  const dec = await J._decodeCode(reply);
  assert(dec.type === 'answer', 'reply decodes to an answer');
  // wire the two mock channels together like a real RTC connection
  const hostPc = MockRTC.instances[0], joinPc = MockRTC.instances[1];
  const hostDc = hostPc.channel;
  const joinDc = new MockDataChannel('ed-state');
  hostDc.other = joinDc; joinDc.other = hostDc;
  const connected = H.acceptReply(reply);
  // acceptReply registers its connect-wait after two async steps
  // (decode + setRemoteDescription); a real channel opens seconds
  // later, but the mock must wait a tick or the open fires into a
  // not-yet-registered wait and the promise never settles.
  await delay(10);
  joinPc.ondatachannel({ channel: joinDc });
  hostDc._fireOpen(); joinDc._fireOpen();
  await connected;
  assert(H.state.connected && J.state.connected, 'both sides connected over manual transport');
  await until(() => J.state.contentOk === true, 2000, 'manual handshake content OK');
  H.sendState(fakeCar());
  await until(() => !!J.remote.latest, 2000, 'manual snapshot received');
  H.disconnect(); J.disconnect();
});

await test('fallback B: broker error before open -> manual long code', async () => {
  resetBroker();
  MockRTC.instances = [];
  const H = loadModule({ peer: true, rtc: true });
  MockPeer.failNextOpenWith = 'network';
  const code = await H.host();
  assert(/^ED[GR]1\./.test(code), 'fell back to a long code');
  assert(H.state.transport === 'manual', 'transport switched to manual');
  assert(H._logs.some(l => /short room codes are unavailable/.test(l) && /long code/.test(l)),
    'fallback stated plainly in the log');
  H.disconnect();
});

await test('manual code validation: garbage is code invalid, never a throw', async () => {
  const M = loadModule({ rtc: true });
  let err = null;
  await M.join('not a code at all').catch(e => { err = e; });
  assert(err && err.message === 'code invalid', 'rejected as code invalid');
  assert(M.state.status === 'failed' && M.state.failReason === 'code invalid', 'failed state set');
  M.disconnect();
});

await test('snapshot encode/decode round-trip', () => {
  const M = loadModule({});
  const buf = M._encodeSnapshot(fakeCar());
  assert(buf.byteLength === 2 + 12 + 3 * 3 * 2, 'frame size 32 bytes for 3 nodes, got ' + buf.byteLength);
  const snap = M._decodeSnapshot(buf);
  assert(snap && snap.count === 3, 'count round-trips');
  assert(Math.abs(snap.pos[0] - 10) < 1e-4 && Math.abs(snap.pos[2] + 5) < 1e-4, 'center round-trips');
  assert(snap.nodeOffsets[3] === 100 && snap.nodeOffsets[8] === 200, 'offsets in cm round-trip');
});

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
})();
