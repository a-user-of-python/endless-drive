/* ============================ WORLD RENDERING ============================ */
const CHUNK = 60;
const LATS = [-60,-38,-24,-16,-12,-9.5,-8,-7,-6,-5,-4.6,-3,-1.5,0,1.5,3,4.6,5,6,7,8,9.5,12,16,24,38,60];
/* ---- textures: procedural canvas first (works offline / from file://),
   then a boot-time download swaps in real photos when it arrives. The
   download never blocks boot: TextureLoader is fire-and-forget, on error
   the procedural texture simply stays. Vertex colours multiply the map,
   so the canvases are near-white speckle — detail without a brightness
   shift — and the road is a SEPARATE mesh/material so the photographic
   grass can never tint the asphalt or wash out the markings. ---- */
function speckleCanvas(base, speckN, lo, hi, seed){
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = base; ctx.fillRect(0, 0, 256, 256);
  const rng = mulberry32(seed);
  for (let i=0;i<speckN;i++){
    const g = lo + Math.floor(rng()*(hi-lo));
    ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + (0.15 + rng()*0.25) + ')';
    ctx.fillRect(rng()*256, rng()*256, 1 + rng()*2.4, 1 + rng()*2.4);
  }
  for (let i=0;i<240;i++){
    ctx.fillStyle = rng() < 0.5 ? 'rgba(196,178,140,0.05)' : 'rgba(140,160,140,0.05)';
    ctx.beginPath(); ctx.arc(rng()*256, rng()*256, 6 + rng()*22, 0, 7); ctx.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function rockCanvas(){
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#d8d8d8'; ctx.fillRect(0, 0, 128, 128);
  const rng = mulberry32(777);
  for (let i=0;i<2600;i++){
    const g = 120 + Math.floor(rng()*110);
    ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + (0.2 + rng()*0.3) + ')';
    ctx.fillRect(rng()*128, rng()*128, 1 + rng()*2, 1 + rng()*2);
  }
  ctx.strokeStyle = 'rgba(70,70,70,0.35)'; ctx.lineWidth = 1;
  for (let i=0;i<9;i++){
    ctx.beginPath(); let x = rng()*128, y = rng()*128; ctx.moveTo(x, y);
    for (let j=0;j<4;j++){ x += (rng()-0.5)*36; y += (rng()-0.5)*36; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function grassBladeTexture(){
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 64, 128);
  const rng = mulberry32(31337);
  for (let i=0;i<11;i++){
    const x0 = 4 + rng()*56, bend = (rng()-0.5)*22, hgt = 62 + rng()*60, wdt = 2.2 + rng()*2.2;
    const g = ctx.createLinearGradient(0, 128, 0, 128-hgt);
    g.addColorStop(0, '#2c5a24'); g.addColorStop(1, '#69a84b');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0-wdt, 128);
    ctx.quadraticCurveTo(x0-wdt*0.4 + bend*0.4, 128-hgt*0.6, x0 + bend, 128-hgt);
    ctx.quadraticCurveTo(x0+wdt*0.4 + bend*0.4, 128-hgt*0.6, x0+wdt, 128);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
const terrainMat = new THREE.MeshLambertMaterial({ vertexColors:true, map:speckleCanvas('#f2f2f2', 5200, 198, 248, 4242) });
const roadMat = new THREE.MeshLambertMaterial({ vertexColors:true, map:speckleCanvas('#f4f4f4', 7000, 150, 235, 919) });
const markMat = new THREE.MeshBasicMaterial({ color:0xf2f2f2 });
const trunkMat = new THREE.MeshLambertMaterial({ color:0x6b4a2c });
const leafMats = [0x3e7d32, 0x4c8a3a, 0x356b2a].map(c=>new THREE.MeshLambertMaterial({ color:c }));
const rockMat = new THREE.MeshLambertMaterial({ color:0x8a857e, map:rockCanvas() });
const postMat = new THREE.MeshLambertMaterial({ color:0xf0f0f0 });
const postTopMat = new THREE.MeshLambertMaterial({ color:0xd23b2e });
const railMat = new THREE.MeshLambertMaterial({ color:0xb9bdc4 });
const railPostMat = new THREE.MeshLambertMaterial({ color:0x7d838c });
const grassMat = new THREE.MeshLambertMaterial({ map:grassBladeTexture(), alphaTest:0.42, side:THREE.DoubleSide });
const potholeMat = new THREE.MeshBasicMaterial({ color:0x0a0a0c, transparent:true, opacity:0.55, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2 });
const bumpMat = new THREE.MeshBasicMaterial({ color:0x9a9a9a, transparent:true, opacity:0.32, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2 });
const crackMat = new THREE.MeshBasicMaterial({ color:0x0c0c0e, transparent:true, opacity:0.6, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2 });
/* boot-time texture upgrades (verified 2026-11-19: both URLs return
   HTTP 200, image/jpeg, Access-Control-Allow-Origin: *) */
function upgradeTexture(url, mat){
  new THREE.TextureLoader().load(url, t=>{
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    mat.map = t; mat.needsUpdate = true;
  }, undefined, ()=>{ /* offline or blocked: procedural texture stays */ });
}
upgradeTexture('https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/terrain/grasslight-big.jpg', terrainMat);
upgradeTexture('https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/moon_1024.jpg', rockMat);
const trunkGeo = new THREE.CylinderGeometry(0.14, 0.22, 1.8, 6);
const canopyGeo = new THREE.IcosahedronGeometry(1.6, 0);
const coneGeo = new THREE.ConeGeometry(1.35, 2.8, 7);
const rockGeo = new THREE.IcosahedronGeometry(1, 0);
const postGeo = new THREE.BoxGeometry(0.14, 1.0, 0.14);
const postTopGeo = new THREE.BoxGeometry(0.16, 0.22, 0.16);
const railPostGeo = new THREE.BoxGeometry(0.14, 0.66, 0.10);
/* grass tuft: two crossed alpha planes, base at y=0 */
const grassGeo = (()=>{
  const pos = [ -0.45,0,0,  0.45,0,0,  0.45,0.62,0,  -0.45,0.62,0,
                0,0,-0.45,  0,0,0.45,  0,0.62,0.45,  0,0.62,-0.45 ];
  const uv = [ 0,0, 1,0, 1,1, 0,1,  0,0, 1,0, 1,1, 0,1 ];
  const nor = []; for (let i=0;i<8;i++) nor.push(0, 1, 0);
  const idx = [ 0,1,2, 0,2,3, 4,5,6, 4,6,7 ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setIndex(idx);
  return g;
})();
function hash2(a, b){ let h = Math.sin(a*127.1 + b*311.7)*43758.5453; return h - Math.floor(h); }

function buildChunk(idx){
  const g = new THREE.Group();
  const disposables = [];
  g.userData.disposables = disposables;
  const s0 = idx*CHUNK, rows = Math.floor(CHUNK/3)+1, cols = LATS.length;
  const pos = [], col = [], uvG = [], uvR = [], index = [], indexRoad = [];
  for (let r=0; r<rows; r++){
    const s = s0 + r*3;
    const p = world.trackPoint(s);
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
    for (let c=0; c<cols; c++){
      const lat = LATS[c];
      const info = world.heightAtSL(s, lat);
      const wx = p.x + rx*lat, wz = p.z + rz*lat;
      pos.push(wx, info.h, wz);
      // world-space UVs: the texture follows the ground, never stretches
      uvG.push(wx/7, wz/7); uvR.push(wx/2.5, wz/2.5);
      const slope = Math.abs(world.heightAtSL(s+1.5, lat).h - world.heightAtSL(s-1.5, lat).h)/3
                  + Math.abs(world.heightAtSL(s, lat+1.5).h - world.heightAtSL(s, lat-1.5).h)/3;
      let cr, cg, cb;
      if (Math.abs(lat) <= 4.6){ const v = 0.20 + hash2(s, lat)*0.03; cr=v; cg=v+0.015; cb=v+0.03; }        // asphalt
      else if (slope > 0.85){ cr=0.44; cg=0.41; cb=0.37; }                                                  // rock (cliff walls)
      else if (info.h < p.y - 8){ const v = 0.55 + hash2(s, lat)*0.08; cr=v; cg=v*0.88; cb=v*0.62; }        // cliff floor sand
      else { const v = hash2(Math.floor(s/3), Math.floor(lat)); cr=0.16+v*0.05; cg=0.36+v*0.10; cb=0.14+v*0.04; } // grass
      col.push(cr, cg, cb);
    }
  }
  // quads between lat -5 and +5 (columns 9..16) are the road mesh; the
  // rest is ground. Splitting them keeps the photographic ground texture
  // off the asphalt entirely.
  for (let r=0; r<rows-1; r++) for (let c=0; c<cols-1; c++){
    const a = r*cols+c, b = a+1, d = a+cols, e = d+1;
    if (c >= 9 && c < 17) indexRoad.push(a, d, b, b, d, e);
    else index.push(a, d, b, b, d, e);
  }
  const posAttr = new THREE.BufferAttribute(new Float32Array(pos), 3);
  const colAttr = new THREE.BufferAttribute(new Float32Array(col), 3);
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', posAttr);
  tg.setAttribute('color', colAttr);
  tg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvG), 2));
  tg.setIndex(index); tg.computeVertexNormals();
  // chunk geometry is built in WORLD coordinates while the chunk group
  // sits at the origin — the same layout as the car skin. These meshes
  // never move once built, but culling is switched off anyway so no
  // stale-sphere surprise can ever blank a chunk: chunk visibility is
  // already managed by distance in updateChunks.
  const terrainMesh = new THREE.Mesh(tg, terrainMat); terrainMesh.frustumCulled = false;
  g.add(terrainMesh);
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', posAttr);
  rg.setAttribute('color', colAttr);
  rg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvR), 2));
  rg.setIndex(indexRoad); rg.computeVertexNormals();
  const roadMesh = new THREE.Mesh(rg, roadMat); roadMesh.frustumCulled = false;
  g.add(roadMesh);
  disposables.push(tg, rg);
  // road markings: edge lines + center dashes
  const mp = [];
  const quadW = (cx, cy, cz, rx, rz, hw, hl)=>{
    // axis-aligned-in-track-space quad: right vector (rx,rz), fwd = (-rz, rx)
    const fx = -rz, fz = rx;
    mp.push(cx-rx*hw-fx*hl, cy, cz-rz*hw-fz*hl,  cx+rx*hw-fx*hl, cy, cz+rz*hw-fz*hl,  cx+rx*hw+fx*hl, cy, cz+rz*hw+fz*hl);
    mp.push(cx-rx*hw-fx*hl, cy, cz-rz*hw-fz*hl,  cx+rx*hw+fx*hl, cy, cz+rz*hw+fz*hl,  cx-rx*hw+fx*hl, cy, cz-rz*hw+fz*hl);
  };
  for (let s = s0; s < s0+CHUNK; s += 3){
    const p = world.trackPoint(s+1.5);
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
    for (const side of [-1,1]){
      const lat = side*4.25;
      quadW(p.x+rx*lat, p.y+0.03, p.z+rz*lat, rx, rz, 0.09, 1.5);
    }
    if ((s/3) % 2 === 0) quadW(p.x, p.y+0.03, p.z, rx, rz, 0.13, 1.4); // dash
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mp), 3));
  mg.computeVertexNormals();
  const markMesh = new THREE.Mesh(mg, markMat); markMesh.frustumCulled = false; // world coords, see terrain above
  g.add(markMesh);
  // obstacles in this chunk's segments
  const segA = Math.floor(s0/50), segB = Math.floor((s0+CHUNK)/50);
  for (let seg = segA; seg <= segB; seg++){
    for (const o of world.obstaclesForSegment(seg)){
      if (o.s < s0 || o.s >= s0+CHUNK) continue;
      const base = world.heightAtSL(o.s, o.lat).h;
      if (o.type === 'tree'){
        const t = new THREE.Group();
        const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 0.9; t.add(trunk);
        const c1 = new THREE.Mesh(canopyGeo, leafMats[Math.floor(hash2(o.s, o.lat)*3)]);
        c1.position.y = 2.9; c1.scale.setScalar(0.9 + hash2(o.s, 1)*0.5); t.add(c1);
        const c2 = new THREE.Mesh(canopyGeo, leafMats[Math.floor(hash2(o.lat, o.s)*3)]);
        c2.position.set(0.5, 3.7, 0.3); c2.scale.setScalar(0.6 + hash2(o.s, 2)*0.4); t.add(c2);
        t.position.set(o.x, base - 0.1, o.z); t.rotation.y = hash2(o.s, o.lat)*3;
        g.add(t);
      } else if (o.type === 'rock'){
        const r = new THREE.Mesh(rockGeo, rockMat);
        r.position.set(o.x, base + o.r*0.3, o.z);
        r.scale.set(o.r, o.r*0.75, o.r);
        r.rotation.set(hash2(o.s,1)*3, hash2(o.s,2)*3, hash2(o.s,3)*3);
        g.add(r);
      } else if (o.type === 'post'){
        const p1 = new THREE.Mesh(postGeo, postMat); p1.position.set(o.x, base + 0.5, o.z); g.add(p1);
        const p2 = new THREE.Mesh(postTopGeo, postTopMat); p2.position.set(o.x, base + 0.95, o.z); g.add(p2);
      }
    }
  }
  disposables.push(mg);
  /* ---- environment dressing (all deterministic per chunk, all placed
     in TRACK SPACE with a hard lateral exclusion: nothing decorative
     inside |lat| <= ROAD_HALF + margin) ---- */
  const rngE = mulberry32(world.seed*137 + idx*104729 + 777);
  const placeAt = (s, lat)=>{ const p = world.trackPoint(s);
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
    return { x:p.x + rx*lat, z:p.z + rz*lat, h:world.heightAtSL(s, lat).h,
             surf:world.heightAtSL(s, lat).surface, heading:p.heading }; };
  // filler boulders (visual only, well clear of the road)
  for (let i=0;i<4;i++){
    const s = s0 + rngE()*CHUNK, lat = (rngE()<0.5?-1:1)*(11 + rngE()*38);
    const pl = placeAt(s, lat);
    if (pl.surf !== 'grass' && pl.surf !== 'rock' && pl.surf !== 'floor') continue;
    const sc = 0.8 + rngE()*1.9;
    const r = new THREE.Mesh(rockGeo, rockMat);
    r.position.set(pl.x, pl.h + sc*0.16, pl.z);
    r.scale.set(sc, sc*(0.55 + rngE()*0.3), sc*(0.8 + rngE()*0.4));
    r.rotation.set(rngE()*3, rngE()*3, rngE()*3);
    g.add(r);
  }
  // bushes
  for (let i=0;i<6;i++){
    const s = s0 + rngE()*CHUNK, lat = (rngE()<0.5?-1:1)*(6.4 + rngE()*20);
    const pl = placeAt(s, lat);
    if (pl.surf !== 'grass') continue;
    const b = new THREE.Mesh(canopyGeo, leafMats[Math.floor(rngE()*3)]);
    b.position.set(pl.x, pl.h + 0.28, pl.z);
    b.scale.set(0.5 + rngE()*0.55, 0.34 + rngE()*0.3, 0.5 + rngE()*0.55);
    b.rotation.y = rngE()*3;
    g.add(b);
  }
  // extra trees: round canopy or pine, further out
  for (let i=0;i<4;i++){
    const s = s0 + rngE()*CHUNK, lat = (rngE()<0.5?-1:1)*(10 + rngE()*34);
    const pl = placeAt(s, lat);
    if (pl.surf !== 'grass') continue;
    const t = new THREE.Group();
    if (rngE() < 0.45){ // pine
      const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 1.4; trunk.scale.set(1, 1.7, 1); t.add(trunk);
      const cone = new THREE.Mesh(coneGeo, leafMats[2]); cone.position.y = 3.4; cone.scale.setScalar(0.9 + rngE()*0.5); t.add(cone);
      const cone2 = new THREE.Mesh(coneGeo, leafMats[2]); cone2.position.y = 4.4; cone2.scale.setScalar(0.6 + rngE()*0.3); t.add(cone2);
    } else {
      const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 0.9; t.add(trunk);
      const c1 = new THREE.Mesh(canopyGeo, leafMats[Math.floor(rngE()*3)]);
      c1.position.y = 2.9; c1.scale.setScalar(0.9 + rngE()*0.5); t.add(c1);
      const c2 = new THREE.Mesh(canopyGeo, leafMats[Math.floor(rngE()*3)]);
      c2.position.set(0.5, 3.7, 0.3); c2.scale.setScalar(0.6 + rngE()*0.4); t.add(c2);
    }
    t.position.set(pl.x, pl.h - 0.1, pl.z); t.rotation.y = rngE()*3;
    g.add(t);
  }
  // 3D grass: instanced cross-plane tufts near the road, fading out with
  // distance (density falls off via the pow curve), recycled per chunk
  {
    const rngG = mulberry32(world.seed*131 + idx*104729 + 555);
    const mats = [], cols = [];
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(),
          V = new THREE.Vector3(), SV = new THREE.Vector3(), C = new THREE.Color();
    for (let i=0;i<650;i++){
      const s = s0 + rngG()*CHUNK;
      const side = rngG() < 0.5 ? -1 : 1;
      const lat = side*(5.0 + Math.pow(rngG(), 1.7)*30);
      const info = world.heightAtSL(s, lat);
      if (info.surface !== 'grass') continue;
      let nearRail = false;
      for (const st of world.barrierStretchesIn(s, s + 0.01))
        if (Math.sign(st.lat) === side && Math.abs(Math.abs(lat) - S.BARRIER_LAT) < 0.9) nearRail = true;
      if (nearRail) continue;
      const p = world.trackPoint(s);
      const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
      const sc = 0.7 + rngG()*0.7;
      E.set(0, rngG()*Math.PI, 0); Q.setFromEuler(E);
      V.set(p.x + rx*lat, info.h - 0.02, p.z + rz*lat); SV.set(sc, sc*(0.8 + rngG()*0.5), sc);
      M.compose(V, Q, SV); mats.push(M.clone());
      C.setHSL(0.29 + rngG()*0.05, 0.45 + rngG()*0.2, 0.30 + rngG()*0.14); cols.push(C.clone());
    }
    if (mats.length){
      const im = new THREE.InstancedMesh(grassGeo, grassMat, mats.length);
      for (let i=0;i<mats.length;i++){ im.setMatrixAt(i, mats[i]); im.setColorAt(i, cols[i]); }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = false;
      g.add(im);
      disposables.push(im);
    }
  }
  // guardrails: posts every ~3 m + a continuous rail at 0.62 m, following
  // the road edge on the analytic ground height. The physics side is the
  // row of circle obstacles from barrierObstaclesForSegment (SIM core).
  for (const st of world.barrierStretchesIn(s0 - 1, s0 + CHUNK + 1)){
    const a = Math.max(st.s0, s0), b = Math.min(st.s1, s0 + CHUNK);
    if (a >= b) continue;
    const pts = [];
    for (let s = a; s <= b; s += 3) pts.push(s);
    if (pts[pts.length-1] < b - 0.01) pts.push(b);
    const P = pts.map(s=>{ const p = world.trackPoint(s);
      const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
      return { x:p.x + rx*st.lat, z:p.z + rz*st.lat, h:world.heightAtSL(s, st.lat).h, heading:p.heading }; });
    for (const q of P){
      const post = new THREE.Mesh(railPostGeo, railPostMat);
      post.position.set(q.x, q.h + 0.31, q.z);
      post.rotation.y = -q.heading;
      g.add(post);
    }
    for (let i=0;i<P.length-1;i++){
      const A = P[i], B = P[i+1];
      const len = Math.hypot(B.x-A.x, B.z-A.z);
      if (len < 0.1) continue;
      const geo = new THREE.BoxGeometry(0.07, 0.30, len + 0.12);
      disposables.push(geo);
      const rail = new THREE.Mesh(geo, railMat);
      rail.position.set((A.x+B.x)/2, (A.h+B.h)/2 + 0.62, (A.z+B.z)/2);
      rail.lookAt(B.x, (A.h+B.h)/2 + 0.62, B.z);
      g.add(rail);
    }
  }
  // road defect decals: dark patch for a pothole, lighter for a bump,
  // jagged strip for a crack (physics lives in heightAtSL; the road mesh
  // is too coarse to show a sub-metre dip, so the decal carries it)
  for (const d of world.defectsInRange(s0, s0 + CHUNK)){
    if (d.s < s0 || d.s >= s0 + CHUNK) continue;
    const p = world.trackPoint(d.s);
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
    const cx = p.x + rx*d.lat, cz = p.z + rz*d.lat;
    if (d.type === 'crack'){
      const rngC = mulberry32(Math.floor(d.seed*997) + 17);
      const posC = [], idxC = [];
      let latJ = d.lat;
      const NP = 7;
      for (let i=0;i<NP;i++){
        const si = d.s - 1.1 + (2.2*i)/(NP-1);
        latJ += (rngC()-0.5)*0.22; latJ = Math.max(-4.1, Math.min(4.1, latJ));
        const pp = world.trackPoint(si);
        const qx = Math.cos(pp.heading), qz = -Math.sin(pp.heading);
        const hh = world.heightAtSL(si, latJ).h + 0.02;
        posC.push(pp.x + qx*(latJ-0.045), hh, pp.z + qz*(latJ-0.045),
                  pp.x + qx*(latJ+0.045), hh, pp.z + qz*(latJ+0.045));
        if (i < NP-1){ const a2 = i*2; idxC.push(a2, a2+1, a2+2, a2+1, a2+3, a2+2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posC), 3));
      geo.setIndex(idxC); geo.computeVertexNormals();
      disposables.push(geo);
      const crackMesh = new THREE.Mesh(geo, crackMat); crackMesh.frustumCulled = false; // world coords, see terrain above
      g.add(crackMesh);
    } else {
      const geo = new THREE.CircleGeometry(d.r*(d.type==='pothole' ? 0.95 : 0.85), 7);
      disposables.push(geo);
      const mesh = new THREE.Mesh(geo, d.type==='pothole' ? potholeMat : bumpMat);
      mesh.rotation.x = -Math.PI/2; mesh.rotation.z = d.seed;
      mesh.scale.set(1, 0.75 + (Math.floor(d.seed)%7)*0.05, 1);
      mesh.position.set(cx, world.heightAtSL(d.s, d.lat).h + 0.02, cz);
      g.add(mesh);
    }
  }
  return g;
}
const chunks = new Map();
function updateChunks(){
  if (!car) return;
  const cur = Math.floor(car.sHint/CHUNK);
  const need = new Set();
  for (let i = cur-1; i <= cur+3; i++) need.add(i);
  for (const idx of need) if (!chunks.has(idx)){ const g = buildChunk(idx); chunks.set(idx, g); scene.add(g); }
  for (const [idx, g] of chunks){
    if (!need.has(idx)){
      scene.remove(g);
      // dispose only what the chunk owns: its geometries and instanced
      // meshes. Shared geometries/materials (trees, rocks, grass) are
      // module-level and must survive for the next chunk.
      for (const d of (g.userData.disposables || [])) d.dispose();
      chunks.delete(idx);
    }
  }
}

