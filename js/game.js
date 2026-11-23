/* ============================ INPUT / GAME FLOW ============================
   v2.7 additions (this file only — sim/render files untouched):
   - menu flow: built-in + imported BeamNG cars, procedural + imported
     BeamNG maps (load report shown on the menu), multiplayer panel
   - LoadingScreen-driven import / join flows (js/ui/loading.js)
   - PartsSystem (js/ui/parts.js): one instance per spawned car; the
     engine-dead hook lives in readInput()
   - WebRTC multiplayer wiring (js/net/multiplayer.js): the remote car
     is a kinematic puppet (ghost) rendered here as points + beam lines
     from the peer's snapshots; it never collides with the local car.
   All pre-existing behaviour is preserved: car keys 1-5, R reset,
   F repair, T resolution panel, [ ] resolution stepping, B beam view,
   C camera, P/Esc pause, freecam, title showroom orbit. */
const keys = {};
let started = false, paused = false, camMode = 0; // 0 chase, 1 cockpit, 2 freecam
let pendingDef = S.CAR_DEFS[0];
const $ = id => document.getElementById(id);
let toastTimer = 0;
function toast(msg, ms){
  $('toast').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ $('toast').textContent=''; }, ms||2200);
}

/* ---- v2.7 selection / world / parts state ---- */
let driveWorld = world;                 // procedural TrackWorld, or an imported BeamngWorld
let selCar = { kind:'builtin', def:S.CAR_DEFS[0] };   // {kind:'builtin',def} | {kind:'imported',cage,hash}
let selMap = { kind:'procedural' };                   // | {kind:'imported'}
let importedMap = null;                 // {converted, hash, name}
const importedCars = [];                // {cage, hash}
let parts = null;                       // PartsSystem for the current car

/* ---- per-car beam resolution: persisted node targets + panel ---- */
let resPanelOn = true;
const cardResEls = [];
function clampResTarget(v){
  v = Math.round(Number(v));
  if (!isFinite(v)) v = S.RES_TARGET_DEFAULT;
  return Math.max(S.RES_TARGET_DEFAULT, Math.min(1000, v));
}
function resTargetOf(i){ return clampResTarget(S.carRes[i]); }
// ] steps: 150 -> 250 -> 500 -> +10 per press up to 1000; [ reverses
function stepResTarget(cur, delta){
  cur = clampResTarget(cur);
  if (delta > 0){
    if (cur < 250) return 250;
    if (cur < 500) return 500;
    return Math.min(1000, cur + 10);
  }
  if (cur > 500) return Math.max(500, cur - 10);
  if (cur > 250) return 250;
  if (cur > S.RES_TARGET_DEFAULT) return S.RES_TARGET_DEFAULT;
  return cur;
}
function loadCarRes(){
  try {
    const raw = window.localStorage.getItem('endless-drive-beamres-v1');
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    S.CAR_DEFS.forEach((d, i)=>{ S.carRes[i] = clampResTarget(obj[d.id]); });
  } catch (e) { /* storage unavailable or corrupt: Normal defaults stand */ }
}
function saveCarRes(){
  try {
    const obj = {};
    S.CAR_DEFS.forEach((d, i)=>{ obj[d.id] = resTargetOf(i); });
    window.localStorage.setItem('endless-drive-beamres-v1', JSON.stringify(obj));
  } catch (e) { /* storage unavailable: target still applies this session */ }
}
loadCarRes();
function updateResPanel(){
  if (!car || !carDef || !$('resCur')) return;
  const i = S.CAR_DEFS.indexOf(carDef);
  if (i < 0){ // imported cage car: no per-car resolution setting
    $('resCur').innerHTML = '<b>' + carDef.name + '</b> — imported cage<br>Nodes: ' +
      car.nodes.length + ' · Beams: ' + car.beams.length;
    $('resList').innerHTML = '';
    return;
  }
  const t = resTargetOf(i);
  $('resCur').innerHTML = '<b>' + carDef.name + '</b> — ' + S.resNameFor(t) +
    '<br>Nodes: ' + car.nodes.length + ' (target ' + t + ') · Beams: ' + car.beams.length;
  $('resList').innerHTML = S.CAR_DEFS.map((d, j)=>{
    const tj = resTargetOf(j);
    return '<div class="resRow' + (j===i ? ' cur' : '') + '"><span>' + d.name + '</span><b>' +
      S.resNameFor(tj) + ' · ' + tj + ' nodes</b></div>';
  }).join('');
}
function refreshCardRes(){
  S.CAR_DEFS.forEach((d, i)=>{
    if (!cardResEls[i]) return;
    const t = resTargetOf(i);
    cardResEls[i].textContent = 'Beam resolution: ' + S.resNameFor(t) + ' · ' + t + ' nodes';
  });
  const mr = $('menuResLine');
  if (mr) mr.textContent = 'Per-car beam counts: ' + S.CAR_DEFS.map((d, i)=>
    d.name + ' ' + resTargetOf(i)).join(' · ') + ' — change in game with [ and ], remembered per car.';
}
function changeRes(delta){
  const i = S.CAR_DEFS.indexOf(carDef);
  if (i < 0){ toast('Beam resolution applies to the built-in cars', 1600); return; }
  const cur = resTargetOf(i);
  const t = stepResTarget(cur, delta);
  if (t === cur){
    toast(carDef.name + ' beams already ' + S.resNameFor(cur) + ' — ' + cur + ' nodes', 1400);
    return;
  }
  S.carRes[i] = t;
  saveCarRes();
  const sPos = Math.max(100, Math.floor(car.sHint));
  const v = car.centerVel();
  setCar(carDef.id, sPos);
  car.setVelocity(v.x, v.y, v.z);
  toast(carDef.name + ' beams: ' + S.resNameFor(t) + ' — target ' + t + ' nodes · actual ' +
    car.nodes.length + ' nodes · ' + car.beams.length + ' beams', 2600);
  refreshCardRes();
}

/* ---- spawning: built-ins (unchanged path) + imported cages ---- */
function attachParts(){
  if (parts && parts.dispose) parts.dispose();
  parts = (typeof window.PartsSystem === 'function') ? new window.PartsSystem(car) : null;
}
function setCar(defId, sPos){
  carDef = S.CAR_DEFS.find(d=>d.id===defId) || S.CAR_DEFS[0];
  selCar = { kind:'builtin', def:carDef };
  car = S.spawnCar(carDef.id, driveWorld, (sPos===undefined ? 100 : sPos));
  buildCarMeshes();
  document.querySelectorAll('#carBtns button').forEach(b=>b.classList.toggle('active', b.dataset.id===carDef.id));
  $('carName').textContent = carDef.name;
  chasePos = null;
  attachParts();
  updateResPanel();
  updateMpLocalContent();
}
/* A render-side def for an imported cage, derived from the cage itself:
   bounds from its node rest positions, mass from totalMass. Only the
   fields buildCarMeshes/buildBuckets read are synthesised; if the cage
   car has no section rings for the skin anchors, buildCarMeshes throws
   and spawnCage() falls back to the beam-skeleton view. */
function pseudoDefFor(cage){
  if (cage._pseudoDef) return cage._pseudoDef;
  let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
  const nodes = cage.nodes || [];
  for (const nd of nodes){
    const r = nd && nd.rest ? nd.rest : nd;
    if (!r || !isFinite(r.x) || !isFinite(r.z)) continue;
    if (r.x<minX) minX=r.x; if (r.x>maxX) maxX=r.x;
    if (r.z<minZ) minZ=r.z; if (r.z>maxZ) maxZ=r.z;
  }
  const base = S.CAR_DEFS[0];
  const def = Object.assign({}, base, {
    id:'cage', name:cage.name || 'Imported car',
    length: isFinite(maxZ-minZ) && maxZ>minZ ? (maxZ-minZ) : base.length,
    width: isFinite(maxX-minX) && maxX>minX ? (maxX-minX) : base.width,
    mass: cage.totalMass || base.mass,
    wheelR: (cage.wheels && cage.wheels[0] && cage.wheels[0].radius) || base.wheelR,
    topKmh: 180
  });
  cage._pseudoDef = def;
  return def;
}
function spawnCage(sPos){
  if (typeof S.spawnCageCar !== 'function'){
    if (window.LoadingScreen){
      LoadingScreen.show('Imported car');
      LoadingScreen.fail('This build of the sim core has no cage-car spawner (S.spawnCageCar), ' +
        'so the imported car cannot be driven yet. The built-in cars still work.');
    }
    toast('Imported car cannot spawn in this build', 2400);
    return false;
  }
  carDef = pseudoDefFor(selCar.cage);
  car = S.spawnCageCar(selCar.cage, driveWorld, (sPos===undefined ? 100 : sPos));
  try {
    buildCarMeshes();
  } catch (e) {
    // skin anchors need section rings a cage may not have: show the
    // beam skeleton instead of crashing the page.
    debugOn = true;
    try { buildDebug(); if (dbgGroup) dbgGroup.visible = true; } catch (e2) { /* skeleton optional */ }
    toast('Imported car: skeleton view (no skin for this cage)', 2200);
  }
  document.querySelectorAll('#carBtns button').forEach(b=>b.classList.remove('active'));
  $('carName').textContent = carDef.name;
  chasePos = null;
  attachParts();
  updateResPanel();
  updateMpLocalContent();
  return true;
}
function spawnSelected(sPos){
  return selCar.kind === 'imported' ? spawnCage(sPos) : (setCar(selCar.def.id, sPos), true);
}
function respawnCurrent(sPos){
  spawnSelected(sPos===undefined ? Math.max(100, Math.floor(car.sHint || 100)) : sPos);
}
function readInput(){
  const inp = { throttle:0, reverse:0, brake:0, steer:0, handbrake:0 };
  if (camMode === 2){ inp.handbrake = 1; return inp; } // parked while freecamming
  let st = 0;
  // sign convention: frame()'s "right" vector (up x fwd) actually points
  // to the car's LEFT in this coordinate system, and the whole sim is
  // built consistently on that mislabelled vector — in sim terms, steer
  // -1 turns the car toward its own left. So the KEYS are mapped to match
  // the sim (left key = steer -1), not the other way round: do not "fix"
  // frame() instead, everything else (spawn, skin, wheel direction) is
  // built on it. With the old mapping, Left steered right.
  if (keys['KeyA'] || keys['ArrowLeft']) st -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) st += 1;
  inp.steer = st;
  if (keys['KeyW'] || keys['ArrowUp']) inp.throttle = 1;
  if (keys['KeyS'] || keys['ArrowDown']){
    if (car.forwardSpeed() > 0.6) inp.brake = 1; else inp.reverse = 1;
  }
  if (keys['Space']) inp.handbrake = 1;
  // parts hook: a dead engine (health 0 or tank empty) gives no drive
  if (parts && parts.isEngineDead()){ inp.throttle = 0; inp.reverse = 0; }
  return inp;
}
window.addEventListener('keydown', e=>{
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (!started){
    // Enter in a menu text field (room code, long-code boxes) is the
    // field's own action, not "start the game".
    const tag = e.target && e.target.tagName;
    if (e.code === 'Enter' && tag !== 'INPUT' && tag !== 'TEXTAREA') startGame();
    return;
  }
  if (e.code === 'KeyP' || e.code === 'Escape'){ togglePause(); return; }
  if (paused) return;
  if (e.code === 'KeyC'){ camMode = (camMode+1)%3; $('freeBox').classList.toggle('hidden', camMode!==2);
    if (camMode===2) initFreecam(); toast(['Chase camera','Cockpit camera','Freecam'][camMode], 1200); }
  if (e.code === 'KeyB'){ debugOn = !debugOn; if (dbgGroup) dbgGroup.visible = debugOn; toast(debugOn?'Beam view ON':'Beam view OFF', 1200); }
  if (e.code === 'KeyT'){ resPanelOn = !resPanelOn; $('resBox').classList.toggle('hidden', !resPanelOn);
    toast(resPanelOn?'Resolution display ON':'Resolution display OFF', 1200); }
  if (e.code === 'BracketLeft') changeRes(-1);
  if (e.code === 'BracketRight') changeRes(1);
  if (e.code === 'KeyR'){ respawnCurrent(); toast('Fresh ' + carDef.name, 1400); }
  if (e.code === 'KeyF'){
    if (Math.abs(car.forwardSpeed()) < 0.6 && car.maxNodeSpeed() < 0.9){
      car.repair(); if (parts) parts.repair(); toast('Repaired', 1400);
    }
    else toast('Stop fully to repair', 1600);
  }
  if (e.code.startsWith('Digit')){
    const n = parseInt(e.code.slice(5), 10);
    if (n >= 1 && n <= 5){ setCar(S.CAR_DEFS[n-1].id, Math.max(100, Math.floor(car.sHint))); toast(carDef.name, 1200); }
  }
});
window.addEventListener('keyup', e=>{ keys[e.code] = false; });
function togglePause(){
  paused = !paused;
  $('pauseScr').classList.toggle('hidden', !paused);
}
function goToMenu(){
  paused = false;
  started = false;
  $('pauseScr').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('titleScr').classList.remove('hidden');
}

/* cameras */
let chasePos = null;
const free = { pos:new THREE.Vector3(0, 6, -10), yaw:0, pitch:-0.2 };
function initFreecam(){
  free.pos.copy(camera.position);
  const fr = car.frame();
  free.yaw = Math.atan2(fr.fwd.x, fr.fwd.z);
  free.pitch = -0.15;
}
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
function updateCamera(dt){
  const c = car.center(), fr = car.frame();
  if (camMode === 0){
    _v1.set(c.x - fr.fwd.x*9 + fr.up.x*3.4, c.y - fr.fwd.y*9 + fr.up.y*3.4, c.z - fr.fwd.z*9 + fr.up.z*3.4);
    if (!chasePos) chasePos = _v1.clone();
    chasePos.lerp(_v1, 1 - Math.exp(-dt*4.5));
    camera.position.copy(chasePos);
    _v2.set(c.x + fr.fwd.x*7, c.y + fr.fwd.y*7 + 1.0, c.z + fr.fwd.z*7);
    camera.lookAt(_v2);
  } else if (camMode === 1){
    _v1.set(c.x + fr.up.x*1.02 + fr.fwd.x*0.25, c.y + fr.up.y*1.02 + fr.fwd.y*0.25, c.z + fr.up.z*1.02 + fr.fwd.z*0.25);
    camera.position.copy(_v1);
    _v2.set(_v1.x + fr.fwd.x*10, _v1.y + fr.fwd.y*10, _v1.z + fr.fwd.z*10);
    camera.lookAt(_v2);
  } else {
    const sp = (keys['ShiftLeft'] || keys['ShiftRight']) ? 60 : 22;
    if (keys['ArrowLeft']) free.yaw += dt*1.8;
    if (keys['ArrowRight']) free.yaw -= dt*1.8;
    if (keys['ArrowUp']) free.pitch = Math.min(1.2, free.pitch + dt*1.4);
    if (keys['ArrowDown']) free.pitch = Math.max(-1.2, free.pitch - dt*1.4);
    const fx = Math.sin(free.yaw)*Math.cos(free.pitch), fy = Math.sin(free.pitch), fz = Math.cos(free.yaw)*Math.cos(free.pitch);
    const rx = Math.cos(free.yaw), rz = -Math.sin(free.yaw);
    if (keys['KeyW']){ free.pos.x += fx*sp*dt; free.pos.y += fy*sp*dt; free.pos.z += fz*sp*dt; }
    if (keys['KeyS']){ free.pos.x -= fx*sp*dt; free.pos.y -= fy*sp*dt; free.pos.z -= fz*sp*dt; }
    if (keys['KeyA']){ free.pos.x -= rx*sp*dt; free.pos.z -= rz*sp*dt; }
    if (keys['KeyD']){ free.pos.x += rx*sp*dt; free.pos.z += rz*sp*dt; }
    if (keys['KeyE'] || keys['Space']) free.pos.y += sp*dt;
    if (keys['KeyQ']) free.pos.y -= sp*dt;
    camera.position.copy(free.pos);
    _v2.set(free.pos.x + fx, free.pos.y + fy, free.pos.z + fz);
    camera.lookAt(_v2);
  }
}

/* ============================ IMPORTS ============================ */
function readFileBytes(file, fracEnd){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onprogress = e=>{
      if (e.lengthComputable && window.LoadingScreen)
        LoadingScreen.stage(fracEnd * (e.loaded / e.total), 'Reading ' + file.name + '…');
    };
    r.onload = ()=>resolve(r.result);
    r.onerror = ()=>reject(r.error || new Error('could not read the file'));
    r.readAsArrayBuffer(file);
  });
}
function importModulesReady(kind){
  if (window.__ZIP && typeof window.__ZIP.readZip === 'function') {
    if (kind === 'car' && window.__JBEAM && typeof window.__JBEAM.assembleVehicle === 'function') return true;
    if (kind === 'map' && window.__BMAP && typeof window.__BMAP.importMap === 'function') return true;
  }
  return false;
}
async function importCarZip(file){
  LoadingScreen.onBack = null; // an import's Back must never run an MP cancel hook
  LoadingScreen.show('Importing car — ' + file.name);
  if (!importModulesReady('car')){
    LoadingScreen.fail('The BeamNG import modules are not loaded in this build, so cars cannot be imported yet.');
    return;
  }
  try {
    const buf = await readFileBytes(file, 0.08);
    LoadingScreen.stage(0.1, 'Reading zip…');
    const zipMap = await window.__ZIP.readZip(buf);
    const hash = await window.__ZIP.sha256Hex(new Uint8Array(buf));
    LoadingScreen.log('zip sha256: ' + String(hash).slice(0, 16) + '…');
    const cage = await window.__JBEAM.assembleVehicle(zipMap, { onProgress: p=>{
      LoadingScreen.stage(0.1 + 0.9 * (p.frac || 0), p.msg);
    }});
    const entry = { cage:cage, hash:hash };
    importedCars.push(entry);
    LoadingScreen.log('cage ready: ' + (cage.nodes ? cage.nodes.length : '?') + ' nodes, ' +
      (cage.beams ? cage.beams.length : '?') + ' beams');
    addImportedCarCard(entry);
    selectImportedCar(entry);
    LoadingScreen.done();
    toast('Imported ' + (cage.name || file.name), 2000);
  } catch (err) {
    LoadingScreen.fail('Car import failed: ' + ((err && err.message) || err));
  }
}
function addImportedCarCard(entry){
  const el = document.createElement('div');
  el.className = 'carCard importedCard';
  const rep = entry.cage.report || {};
  el.innerHTML = '<div class="nm"></div><div class="bl"></div><div class="ts">Imported · BeamNG cage</div>';
  el.querySelector('.nm').textContent = entry.cage.name || 'Imported car';
  el.querySelector('.bl').textContent =
    (entry.cage.nodes ? entry.cage.nodes.length : (rep.nodes || '?')) + ' nodes · ' +
    (entry.cage.beams ? entry.cage.beams.length : (rep.beams || '?')) + ' beams' +
    (entry.cage.totalMass ? ' · ' + Math.round(entry.cage.totalMass) + ' kg' : '');
  el.onclick = ()=>selectImportedCar(entry, el);
  entry._cardEl = el;
  $('carCards').appendChild(el);
}
function selectImportedCar(entry, el){
  selCar = { kind:'imported', cage:entry.cage, hash:entry.hash };
  document.querySelectorAll('.carCard').forEach(x=>x.classList.remove('sel'));
  (el || entry._cardEl || $('carImportCard')).classList.add('sel');
  $('carImportCard').classList.add('imported');
  $('carImportBlurb').textContent = (entry.cage.name || 'Imported car') + ' ready — ' +
    (entry.cage.nodes ? entry.cage.nodes.length : '?') + ' nodes · ' +
    (entry.cage.beams ? entry.cage.beams.length : '?') + ' beams. Click to choose another zip.';
  if (!started) spawnSelected(100);
  updateMpLocalContent();
}
async function importMapZip(file){
  LoadingScreen.onBack = null; // an import's Back must never run an MP cancel hook
  LoadingScreen.show('Importing map — ' + file.name);
  if (!importModulesReady('map')){
    LoadingScreen.fail('The BeamNG import modules are not loaded in this build, so maps cannot be imported yet.');
    return;
  }
  try {
    const buf = await readFileBytes(file, 0.08);
    LoadingScreen.stage(0.1, 'Reading zip…');
    const zipMap = await window.__ZIP.readZip(buf);
    const hash = await window.__ZIP.sha256Hex(new Uint8Array(buf));
    LoadingScreen.log('zip sha256: ' + String(hash).slice(0, 16) + '…');
    const converted = await window.__BMAP.importMap(zipMap, { onProgress: p=>{
      LoadingScreen.stage(0.1 + 0.9 * (p.frac || 0), p.msg);
    }});
    importedMap = { converted:converted, hash:hash, name:file.name };
    const rep = converted.report || {};
    (rep.missing || []).forEach(m=>LoadingScreen.log('missing: ' + String((m && m.name) || m)));
    (rep.substitutions || []).forEach(s=>LoadingScreen.log('substituted: ' + String((s && s.name) || s)));
    selectMap('imported');
    renderMapReport(rep, file.name);
    LoadingScreen.done();
    toast('Map imported: ' + file.name, 2000);
  } catch (err) {
    LoadingScreen.fail('Map import failed: ' + ((err && err.message) || err));
  }
}
function selectMap(kind){
  selMap = { kind:kind };
  $('mapCardProcedural').classList.toggle('sel', kind === 'procedural');
  $('mapImportCard').classList.toggle('sel', kind === 'imported');
  if (kind === 'imported') $('mapImportCard').classList.add('imported');
  updateMpLocalContent();
}
function renderMapReport(rep, fileName){
  const box = $('mapReport');
  const counts = rep.counts || {};
  const countLines = Object.keys(counts).map(k=>k + ': ' + counts[k]).join(' · ');
  const list = arr => '<ul class="mrList">' + (arr || []).map(m=>
    '<li>' + String((m && (m.name || m.asset)) || m).replace(/</g, '&lt;') + '</li>').join('') + '</ul>';
  box.innerHTML = '<div class="mrTitle">Map load report — ' + fileName.replace(/</g, '&lt;') + '</div>' +
    (countLines ? '<div>' + countLines + '</div>' : '<div>No counts reported.</div>') +
    ((rep.missing && rep.missing.length) ? '<div>Missing (not in the zip — cannot be rendered):</div>' + list(rep.missing) : '<div>Nothing missing.</div>') +
    ((rep.substitutions && rep.substitutions.length) ? '<div>Substituted textures:</div>' + list(rep.substitutions) : '');
  box.classList.remove('hidden');
}
/* drag-drop onto the menu: a zip with .jbeam inside is a car; a zip
   with terrain / level data is a map. */
async function handleDroppedZip(file){
  if (!file) return;
  if (!window.__ZIP){ toast('Import modules not loaded in this build', 2000); return; }
  try {
    const buf = await file.arrayBuffer();
    const zipMap = await window.__ZIP.readZip(buf);
    let isCar = false, isMap = false;
    zipMap.forEach((v, path)=>{
      const p = String(path).toLowerCase();
      if (p.endsWith('.jbeam')) isCar = true;
      if (p.endsWith('.ter') || p.indexOf('levels/') >= 0 || p.endsWith('.level.json')) isMap = true;
    });
    // import functions re-read the file (cheap, local) so their
    // progress reporting stays uniform
    if (isCar && !isMap) importCarZip(file);
    else if (isMap) importMapZip(file);
    else toast('That zip has no .jbeam car or level data I recognise', 2400);
  } catch (err) {
    toast('Could not read that zip: ' + ((err && err.message) || err), 2400);
  }
}

/* ============================ MULTIPLAYER WIRING ============================ */
function mpLocalDesc(){
  return {
    mapName: selMap.kind === 'imported' && importedMap ? importedMap.name : 'Endless (procedural)',
    carName: carDef ? carDef.name : pendingDef.name,
    mapHash: selMap.kind === 'imported' && importedMap ? importedMap.hash : null,
    carHash: selCar.kind === 'imported' ? selCar.hash : null
  };
}
function updateMpLocalContent(){
  if (!window.Multiplayer) return;
  Multiplayer.setLocalContent(mpLocalDesc());
  Multiplayer.setLocalCar(selCar.kind === 'imported'
    ? { kind:'cage', name:selCar.cage.name, carHash:selCar.hash }
    : { kind:'builtin', defId:(carDef || pendingDef).id, name:(carDef || pendingDef).name, carHash:null });
}
function wireMultiplayer(){
  if (!window.Multiplayer) return;
  const M = Multiplayer;
  M.onLog = line=>{ const s = $('mpStatus'); if (s && M.state.status !== 'connected') s.textContent = 'Multiplayer: ' + line; };
  M.onStatus = st=>{
    const s = $('mpStatus');
    if (s) s.textContent = 'Multiplayer: ' + st.status +
      (st.attempt ? ' (attempt ' + st.attempt + '/4)' : '') +
      (st.failReason ? ' — ' + st.failReason : '');
    $('mpDisconnectBtn').disabled = st.status === 'idle';
    $('mpStatusLine').classList.toggle('hidden', !(started && st.connected));
    if (st.connected) $('mpStatusLine').textContent = 'Multiplayer: connected — peer is in your game';
  };
  M.onCode = (code, kind)=>{
    // INVARIANT (v2.7.1): a code the player must read or copy is shown
    // INSIDE the loading panel while it is open (LoadingScreen room
    // slot), never only in the menu underneath the overlay.
    if (LoadingScreen.isOpen()){
      LoadingScreen.setRoomCode(code, kind === 'room' ? 'ROOM CODE — give this to your friend'
        : kind === 'reply' ? 'REPLY CODE — send this to the host'
        : 'JOIN CODE — send this to your friend');
    }
    if (kind !== 'room') $('mpCodeOut').value = code;
  };
  M.onConnected = ()=>{
    LoadingScreen.onBack = null;
    LoadingScreen.done();
    $('mpRecheckBtn').disabled = false;
    toast('Multiplayer: joined', 1800);
    updateMpLocalContent();
  };
  M.onContentMismatch = desc=>{
    LoadingScreen.show('Multiplayer — content needed');
    LoadingScreen.fail('You need the host\'s map/car — import the same zip. Host map: ' +
      (desc && desc.mapName || '?') + ' · host car: ' + (desc && desc.carName || '?') +
      '. Import it from the menu\'s CAR / MAP sections, then press "Re-check content".');
    $('mpRecheckBtn').disabled = false;
  };
  M.onPeerGone = ()=>{ despawnRemote(); toast('Peer disconnected', 1800); };

  $('mpHostBtn').onclick = ()=>{
    updateMpLocalContent();
    LoadingScreen.show('Multiplayer — hosting');
    // Back just returns to the menu; hosting continues in the
    // background (the room code / offer stays valid).
    LoadingScreen.onBack = null;
    LoadingScreen.showBack('Menu');
    M.host().then(code=>{
      if (M.state.transport === 'peerjs'){
        LoadingScreen.setRoomCode(code, 'ROOM CODE — give this to your friend');
        LoadingScreen.stage(0.4, 'Room code ready — waiting for your friend to join…');
      } else {
        $('mpCodeOut').value = code;
        LoadingScreen.setRoomCode(code, 'LONG JOIN CODE — copy and share it');
        LoadingScreen.stage(0.4, 'Long join code ready — share it, then paste the reply code in the menu and press Apply');
        LoadingScreen.log('waiting for a reply code…');
      }
    }).catch(err=>LoadingScreen.fail('Hosting failed: ' + ((err && err.message) || err)));
  };
  /* Room-code join: the code entry lives in the menu (#mpRoomIn) and
     is never cleared by the flow, so cancelling the loading panel
     returns to the still-filled input. The loading panel names the
     room being joined in its room slot for the whole attempt. */
  function startRoomJoin(code){
    updateMpLocalContent();
    LoadingScreen.show('Multiplayer — joining');
    LoadingScreen.setRoomCode(code, 'JOINING ROOM');
    LoadingScreen.onBack = ()=>{ M.disconnect(); toast('Join cancelled', 1400); };
    LoadingScreen.showBack('Cancel');
    M.join(code).then(()=>{
      // 'connected' is handled by onConnected
    }).catch(err=>{
      LoadingScreen.onBack = null;
      LoadingScreen.fail('Join failed: ' + ((err && err.message) || err) +
        ' — check the code, or ask the host for a long code and paste it under "Long codes" in the menu.');
    });
  }
  $('mpRoomIn').addEventListener('input', ()=>{
    const el = $('mpRoomIn');
    const cleaned = el.value.toUpperCase().replace(/[\s-]+/g, '');
    if (cleaned !== el.value) el.value = cleaned;
  });
  $('mpRoomIn').addEventListener('keydown', e=>{
    if (e.code === 'Enter'){ e.preventDefault(); e.stopPropagation(); $('mpJoinBtn').click(); }
  });
  $('mpJoinBtn').onclick = ()=>{
    const code = M.normalizeRoomCode($('mpRoomIn').value);
    if (!code){
      $('mpRoomIn').focus();
      toast('Enter the 5-character room code first', 2000);
      return;
    }
    $('mpRoomIn').value = code;
    startRoomJoin(code);
  };
  $('mpApplyBtn').onclick = ()=>{
    const code = $('mpCodeIn').value.trim();
    if (!code){ toast('Paste a code first', 1600); return; }
    const room = M.normalizeRoomCode(code);
    if (M.state.mode !== 'host' && room){ startRoomJoin(room); return; }
    if (M.state.mode === 'host'){
      LoadingScreen.show('Multiplayer — connecting');
      LoadingScreen.onBack = null;
      LoadingScreen.showBack('Menu');
      M.acceptReply(code).catch(err=>LoadingScreen.fail('Connect failed: ' + ((err && err.message) || err)));
    } else {
      updateMpLocalContent();
      LoadingScreen.show('Multiplayer — joining');
      LoadingScreen.onBack = null;
      LoadingScreen.showBack('Menu');
      M.join(code).then(reply=>{
        $('mpCodeOut').value = reply;
        LoadingScreen.setRoomCode(reply, 'REPLY CODE — send this to the host');
        LoadingScreen.stage(0.5, 'Reply code ready — send it to the host');
        LoadingScreen.log('waiting for the host to connect…');
      }).catch(err=>{
        if (!LoadingScreen.isOpen()) LoadingScreen.show('Multiplayer — joining');
        LoadingScreen.fail('Join failed: ' + ((err && err.message) || err));
      });
    }
  };
  $('mpRecheckBtn').onclick = ()=>{ updateMpLocalContent(); M.recheckContent(); toast('Content re-check sent', 1400); };
  $('mpDisconnectBtn').onclick = ()=>{ M.disconnect(); despawnRemote(); };
}

/* ---- remote car: kinematic puppet (ghost) from peer snapshots ---- */
let remoteCar = null, remoteKey = '', remotePts = null, remoteLines = null;
function despawnRemote(){
  if (remotePts){ scene.remove(remotePts); remotePts.geometry.dispose(); remotePts = null; }
  if (remoteLines){ scene.remove(remoteLines); remoteLines.geometry.dispose(); remoteLines = null; }
  remoteCar = null; remoteKey = '';
}
function ensureRemoteCar(hello){
  const key = hello.kind === 'cage' ? 'cage:' + hello.name : 'def:' + hello.defId;
  if (remoteCar && remoteKey === key) return true;
  despawnRemote();
  const sPos = car ? Math.max(100, Math.floor(car.sHint || 100)) : 100;
  try {
    if (hello.kind === 'cage'){
      if (selCar.kind !== 'imported' || typeof S.spawnCageCar !== 'function') return false;
      remoteCar = S.spawnCageCar(selCar.cage, driveWorld, sPos);
    } else {
      remoteCar = S.spawnCar(hello.defId || 'sedan', driveWorld, sPos);
    }
  } catch (e) { remoteCar = null; return false; }
  remoteKey = key;
  const n = remoteCar.nodes.length;
  const posArr = new Float32Array(n * 3);
  remoteCar.nodes.forEach((nd, i)=>{ posArr[i*3] = nd.pos.x; posArr[i*3+1] = nd.pos.y; posArr[i*3+2] = nd.pos.z; });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  remotePts = new THREE.Points(pg, new THREE.PointsMaterial({ color:0x53e0ff, size:0.14 }));
  remotePts.frustumCulled = false;
  scene.add(remotePts);
  const lp = new Float32Array(remoteCar.beams.length * 6);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  remoteLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
    color:0x53e0ff, transparent:true, opacity:0.45 }));
  remoteLines.frustumCulled = false;
  scene.add(remoteLines);
  return true;
}
function updateRemote(dt){
  const M = window.Multiplayer;
  if (!M || !M.state.connected) return;
  const hello = M.remote.hello, snap = M.remote.latest;
  if (!hello || !snap) return;
  if (!ensureRemoteCar(hello)) return;
  const k = 1 - Math.exp(-dt * 12);
  const n = Math.min(snap.count, remoteCar.nodes.length);
  const off = snap.nodeOffsets;
  for (let i = 0; i < n; i++){
    const nd = remoteCar.nodes[i];
    const tx = snap.pos[0] + off[i*3] / 100, ty = snap.pos[1] + off[i*3+1] / 100, tz = snap.pos[2] + off[i*3+2] / 100;
    nd.pos.x += (tx - nd.pos.x) * k;
    nd.pos.y += (ty - nd.pos.y) * k;
    nd.pos.z += (tz - nd.pos.z) * k;
    nd.vel.x = 0; nd.vel.y = 0; nd.vel.z = 0;
  }
  if (remotePts){
    const arr = remotePts.geometry.attributes.position.array;
    remoteCar.nodes.forEach((nd, i)=>{ arr[i*3] = nd.pos.x; arr[i*3+1] = nd.pos.y; arr[i*3+2] = nd.pos.z; });
    remotePts.geometry.attributes.position.needsUpdate = true;
  }
  if (remoteLines){
    const arr = remoteLines.geometry.attributes.position.array;
    remoteCar.beams.forEach((b, i)=>{
      const A = remoteCar.nodes[b.a].pos, B = remoteCar.nodes[b.b].pos;
      arr[i*6] = A.x; arr[i*6+1] = A.y; arr[i*6+2] = A.z;
      arr[i*6+3] = B.x; arr[i*6+4] = B.y; arr[i*6+5] = B.z;
    });
    remoteLines.geometry.attributes.position.needsUpdate = true;
  }
}

/* title screen */
function buildTitle(){
  const wrap = $('carCards');
  S.CAR_DEFS.forEach((d, i)=>{
    const el = document.createElement('div');
    el.className = 'carCard' + (d===pendingDef ? ' sel' : '');
    el.innerHTML = '<div class="nm">' + d.name + '</div><div class="bl">' + d.blurb +
      '</div><div class="ts">Top speed ~' + d.topKmh + ' km/h · key ' + (i+1) + '</div><div class="res"></div>';
    cardResEls.push(el.querySelector('.res'));
    el.onclick = ()=>{ pendingDef = d; selCar = { kind:'builtin', def:d };
      document.querySelectorAll('.carCard').forEach(x=>x.classList.remove('sel'));
      el.classList.add('sel'); if (!started) setCar(d.id, 100); };
    wrap.appendChild(el);
  });
  refreshCardRes();
  const btns = $('carBtns');
  S.CAR_DEFS.forEach(d=>{
    const b = document.createElement('button');
    b.textContent = d.name; b.dataset.id = d.id;
    b.onclick = ()=>{ if (started) setCar(d.id, Math.max(100, Math.floor(car.sHint))); };
    btns.appendChild(b);
  });
  $('startBtn').onclick = startGame;
  /* v2.7 menu wiring */
  $('carImportCard').onclick = ()=>$('carFile').click();
  $('carFile').addEventListener('change', e=>{ if (e.target.files[0]) importCarZip(e.target.files[0]); e.target.value=''; });
  $('mapCardProcedural').onclick = ()=>selectMap('procedural');
  $('mapImportCard').onclick = ()=>$('mapFile').click();
  $('mapFile').addEventListener('change', e=>{ if (e.target.files[0]) importMapZip(e.target.files[0]); e.target.value=''; });
  const ts = $('titleScr');
  ts.addEventListener('dragover', e=>{ e.preventDefault(); ts.classList.add('dropActive'); });
  ts.addEventListener('dragleave', ()=>ts.classList.remove('dropActive'));
  ts.addEventListener('drop', e=>{
    e.preventDefault(); ts.classList.remove('dropActive');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleDroppedZip(f);
  });
  $('pauseResume').onclick = ()=>{ if (paused) togglePause(); };
  $('pauseRestart').onclick = ()=>{ if (paused) togglePause(); respawnCurrent(); };
  $('pauseMenu').onclick = goToMenu;
  wireMultiplayer();
  updateMpLocalContent();
}
function startGame(){
  if (started) return;
  // pick the world first: imported map's world, or the procedural one
  driveWorld = (selMap.kind === 'imported' && importedMap) ? importedMap.converted.world : world;
  let sPos = 100;
  if (driveWorld !== world && typeof driveWorld.spawnPoint === 'function'){
    try { const sp = driveWorld.spawnPoint(); if (sp && typeof sp.s === 'number') sPos = sp.s; } catch (e) { /* default stands */ }
  }
  let ok = false;
  try { ok = spawnSelected(sPos); } catch (err) {
    if (window.LoadingScreen){
      LoadingScreen.show('Starting game');
      LoadingScreen.fail('The selected car/map could not be spawned: ' + ((err && err.message) || err));
    }
    driveWorld = world;
    return;
  }
  if (!ok) return; // spawnCage already surfaced the reason
  started = true;
  $('titleScr').classList.add('hidden');
  $('hud').classList.remove('hidden');
  updateMpLocalContent();
}

/* HUD */
let hudTick = 0;
function updateHUD(){
  if ((hudTick++ % 5) !== 0) return;
  const kmh = Math.abs(car.forwardSpeed()*3.6);
  $('speedVal').textContent = kmh.toFixed(0);
  $('distVal').textContent = (car.distance/1000).toFixed(2) + ' km';
  const st = car.stats();
  $('integVal').textContent = st.integrity + '%';
  const bar = $('integBar');
  bar.style.width = st.integrity + '%';
  bar.style.background = st.integrity > 70 ? '#57d957' : st.integrity > 40 ? '#f2b134' : '#e83a2e';
  $('beamCounts').textContent = 'Beams: ' + st.broken + ' broken · ' + st.deformed + ' bent · ' + st.total + ' total';
  if (parts){
    const fv = $('fuelVal'), tv = $('tempVal');
    if (fv) fv.textContent = Math.round(parts.fuelPct()) + '% · ' + parts.fuel.toFixed(1) + ' L';
    if (fv) fv.className = parts.fuelPct() < 10 ? 'hot' : parts.fuelPct() < 25 ? 'warn' : '';
    if (tv) tv.textContent = Math.round(parts.tempC) + ' °C';
    if (tv) tv.className = parts.tempC > 105 ? 'hot' : parts.tempC > 95 ? 'warn' : '';
  }
  updateResPanel();
}

/* main loop */
const clock = new THREE.Clock();
let orbitT = 0;
function loop(){
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  lastDt = dt || 1/60;
  if (car){
    if (started && !paused){
      const inp = readInput();
      car.step(lastDt, inp, driveWorld);
      if (parts) parts.update(lastDt, car, inp);
      if (window.Multiplayer) Multiplayer.sendState(car);
      updateRemote(lastDt);
    }
    try { updateSkin(); } catch (e) { /* cage cars may have no skin; skeleton stays */ }
    updateDebug();
    if (driveWorld === world){ updateChunks(); if (window.__MAPWORLD) __MAPWORLD.sync(null); }
    else if (window.__MAPWORLD && importedMap) __MAPWORLD.sync(importedMap.converted);
    if (started){ updateCamera(lastDt); updateHUD(); }
    else { // title showroom orbit
      orbitT += dt*0.25;
      const c = car.center();
      camera.position.set(c.x + Math.sin(orbitT)*8.5, c.y + 2.6, c.z + Math.cos(orbitT)*8.5);
      camera.lookAt(c.x, c.y + 0.6, c.z);
    }
  }
  renderer.render(scene, camera);
}
buildTitle();
setCar(pendingDef.id, 100);
loop();
