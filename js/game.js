/* ============================ INPUT / GAME FLOW ============================ */
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
  const i = S.CAR_DEFS.indexOf(carDef), t = resTargetOf(i);
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
}
function changeRes(delta){
  const i = S.CAR_DEFS.indexOf(carDef);
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
function setCar(defId, sPos){
  carDef = S.CAR_DEFS.find(d=>d.id===defId) || S.CAR_DEFS[0];
  car = S.spawnCar(carDef.id, world, (sPos===undefined ? 100 : sPos));
  buildCarMeshes();
  document.querySelectorAll('#carBtns button').forEach(b=>b.classList.toggle('active', b.dataset.id===carDef.id));
  $('carName').textContent = carDef.name;
  chasePos = null;
  updateResPanel();
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
  return inp;
}
window.addEventListener('keydown', e=>{
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (!started){ if (e.code === 'Enter') startGame(); return; }
  if (e.code === 'KeyP' || e.code === 'Escape'){ togglePause(); return; }
  if (paused) return;
  if (e.code === 'KeyC'){ camMode = (camMode+1)%3; $('freeBox').classList.toggle('hidden', camMode!==2);
    if (camMode===2) initFreecam(); toast(['Chase camera','Cockpit camera','Freecam'][camMode], 1200); }
  if (e.code === 'KeyB'){ debugOn = !debugOn; if (dbgGroup) dbgGroup.visible = debugOn; toast(debugOn?'Beam view ON':'Beam view OFF', 1200); }
  if (e.code === 'KeyT'){ resPanelOn = !resPanelOn; $('resBox').classList.toggle('hidden', !resPanelOn);
    toast(resPanelOn?'Resolution display ON':'Resolution display OFF', 1200); }
  if (e.code === 'BracketLeft') changeRes(-1);
  if (e.code === 'BracketRight') changeRes(1);
  if (e.code === 'KeyR'){ setCar(carDef.id, Math.max(100, Math.floor(car.sHint))); toast('Fresh ' + carDef.name, 1400); }
  if (e.code === 'KeyF'){
    if (Math.abs(car.forwardSpeed()) < 0.6 && car.maxNodeSpeed() < 0.9){ car.repair(); toast('Repaired', 1400); }
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

/* title screen */
function buildTitle(){
  const wrap = $('carCards');
  S.CAR_DEFS.forEach((d, i)=>{
    const el = document.createElement('div');
    el.className = 'carCard' + (d===pendingDef ? ' sel' : '');
    el.innerHTML = '<div class="nm">' + d.name + '</div><div class="bl">' + d.blurb +
      '</div><div class="ts">Top speed ~' + d.topKmh + ' km/h · key ' + (i+1) + '</div><div class="res"></div>';
    cardResEls.push(el.querySelector('.res'));
    el.onclick = ()=>{ pendingDef = d; document.querySelectorAll('.carCard').forEach(x=>x.classList.remove('sel'));
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
}
function startGame(){
  if (started) return;
  started = true;
  $('titleScr').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (!car || carDef !== pendingDef) setCar(pendingDef.id, 100);
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
      car.step(lastDt, readInput(), world);
    }
    updateSkin();
    updateDebug();
    updateChunks();
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
