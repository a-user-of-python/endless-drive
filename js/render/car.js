/* ============================ RENDERING ============================ */
const S = globalThis.__SIM;
const world = new S.TrackWorld(1337);
let car = null, carDef = null, lastDt = 1/60;

const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('game').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5d9);
scene.fog = new THREE.Fog(0x87b5d9, 120, 420);
const camera = new THREE.PerspectiveCamera(66, window.innerWidth/window.innerHeight, 0.1, 900);
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x4a5a3a, 0.95));
const sun = new THREE.DirectionalLight(0xfff2d8, 0.85);
sun.position.set(60, 120, 40); scene.add(sun);
window.addEventListener('resize', ()=>{
  camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ---------- geometry bucket builder (car-local coords) ---------- */
// Body detail scaling: ONE master body plan per car (buildBuckets); its
// triangle density scales with the car's node target via quad subdivision.
// subdiv 1 is the floor — exactly the density the body was designed at, so
// a 150-node car still shows the full multi-part model; at 1000 nodes the
// same plan renders at subdiv 6 and the skin can follow the fine cage's
// deformation in much smaller facets. Faces are planar, so bilinear
// interpolation of the corners is exact and normals stay the face normal.
function subdivForTarget(target){
  return Math.max(1, Math.min(6, Math.round(1 + (target - 150)/850*5)));
}
function Bucket(subdiv){ this.pos = []; this.nor = []; this.subdiv = Math.max(1, subdiv||1); }
Bucket.prototype.quad = function(a,b,c,d,n){
  const p = this.pos, nr = this.nor, sd = this.subdiv;
  if (sd <= 1){
    p.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2], a[0],a[1],a[2], c[0],c[1],c[2], d[0],d[1],d[2]);
    for (let i=0;i<6;i++) nr.push(n[0],n[1],n[2]);
    return;
  }
  const pt = (u,v)=>{
    const abx=a[0]+(b[0]-a[0])*u, aby=a[1]+(b[1]-a[1])*u, abz=a[2]+(b[2]-a[2])*u;
    const dcx=d[0]+(c[0]-d[0])*u, dcy=d[1]+(c[1]-d[1])*u, dcz=d[2]+(c[2]-d[2])*u;
    return [abx+(dcx-abx)*v, aby+(dcy-aby)*v, abz+(dcz-abz)*v];
  };
  for (let i=0;i<sd;i++) for (let j=0;j<sd;j++){
    const u0=i/sd, u1=(i+1)/sd, v0=j/sd, v1=(j+1)/sd;
    const q00=pt(u0,v0), q10=pt(u1,v0), q11=pt(u1,v1), q01=pt(u0,v1);
    p.push(q00[0],q00[1],q00[2], q10[0],q10[1],q10[2], q11[0],q11[1],q11[2],
           q00[0],q00[1],q00[2], q11[0],q11[1],q11[2], q01[0],q01[1],q01[2]);
    for (let k=0;k<6;k++) nr.push(n[0],n[1],n[2]);
  }
};
Bucket.prototype.prism = function(zF, zB, wF, wB, yBotF, yBotB, yTopF, yTopB, xF, xB){
  xF = xF||0; xB = xB||0;
  const FL=[xF-wF,yBotF,zF], FR=[xF+wF,yBotF,zF], BL=[xB-wB,yBotB,zB], BR=[xB+wB,yBotB,zB];
  const FLt=[xF-wF*0.92,yTopF,zF], FRt=[xF+wF*0.92,yTopF,zF], BLt=[xB-wB*0.92,yTopB,zB], BRt=[xB+wB*0.92,yTopB,zB];
  this.quad(FLt,FRt,BRt,BLt,[0,1,0]);            // top
  this.quad(BL,BR,FR,FL,[0,-1,0]);               // bottom
  this.quad(FR,BR,BRt,FRt,[1,0,0]);              // right
  this.quad(BL,FL,FLt,BLt,[-1,0,0]);             // left
  this.quad(FL,FR,FRt,FLt,[0,0,1]);              // front
  this.quad(BR,BL,BLt,BRt,[0,0,-1]);             // back
};
Bucket.prototype.box = function(cx,cy,cz,sx,sy,sz){
  this.prism(cz+sz/2, cz-sz/2, sx/2, sx/2, cy-sy/2, cy-sy/2, cy+sy/2, cy+sy/2, cx, cx);
};

/* ---------- car body plan per type ---------- */
function buildBuckets(def, subdiv){
  const B = { paint:new Bucket(subdiv), accent:new Bucket(subdiv), glass:new Bucket(subdiv),
              lightF:new Bucket(subdiv), lightR:new Bucket(subdiv), dark:new Bucket(subdiv) };
  const L = def.length, W = def.width, sec = def.sections;
  const zS = i => sec[i].z*L;
  const cabTop = sec[1].yTop, hoodTop = sec[0].yTop, rearTop = sec[3].yTop;
  // belly + lower body
  B.paint.prism(L*0.53, -L*0.53, W*0.47, W*0.47, 0.30, 0.32, sec[0].yMid+0.05, sec[3].yMid+0.05);
  B.dark.prism(L*0.50, -L*0.50, W*0.44, W*0.44, 0.16, 0.16, 0.31, 0.31); // underbody shadow line
  // hood (sloped prism)
  B.paint.prism(L*0.53, zS(1)+0.1, W*0.45, W*0.47, sec[0].yMid-0.05, sec[1].yMid-0.02, hoodTop, sec[1].yMid+0.18);
  // fenders over the wheels
  const wz = def.wheelBase*L*0.5, wx = def.trackW*W*0.5;
  for (const sx of [-1,1]) for (const sz of [-1,1]){
    B.paint.box(sx*(wx+0.02), def.wheelR+0.30, sz*wz, 0.30, 0.16, def.wheelR*2+0.34);
    B.dark.box(sx*(wx+0.10), def.wheelR+0.30, sz*wz, 0.10, 0.18, def.wheelR*2+0.40); // arch trim
  }
  // cabin / glasshouse
  if (def.id === 'pickup'){
    B.glass.prism(zS(1)+L*0.13, zS(2)+L*0.02, W*0.40, W*0.42, sec[1].yMid+0.02, sec[2].yMid+0.02, cabTop-0.05, cabTop-0.05);
    B.paint.prism(zS(1)+L*0.15, zS(2)+0.0, W*0.43, W*0.44, cabTop-0.06, cabTop-0.06, cabTop+0.04, cabTop+0.04); // roof
    // open bed: floor, walls, tailgate
    B.dark.box(0, 0.68, (zS(2)+(-L*0.53))/2, W*0.86, 0.07, (-L*0.53)-zS(2)-0.1);
    for (const sx of [-1,1]) B.paint.box(sx*(W*0.44), 0.86, (zS(2)-0.1+(-L*0.52))/2, 0.07, 0.42, (-L*0.52)-(zS(2)-0.1));
    B.paint.box(0, 0.86, -L*0.515, W*0.90, 0.42, 0.07); // tailgate
    B.paint.box(0, 0.86, zS(2)-0.05, W*0.90, 0.42, 0.07); // bed front wall
  } else {
    const glassBack = def.id==='suv' ? -L*0.44 : -L*0.30;
    B.glass.prism(zS(1)+L*0.10, glassBack, W*0.40, W*0.42, sec[1].yMid+0.02, sec[2].yMid+0.02, cabTop-0.05, (def.id==='suv'?cabTop:rearTop+0.18));
    B.paint.prism(zS(1)+L*0.13, (def.id==='suv'?-L*0.46:-L*0.28), W*0.42, W*0.43, cabTop-0.06, cabTop-0.06, cabTop+0.04, cabTop+0.04); // roof
    if (def.id !== 'suv') // trunk deck
      B.paint.prism(-L*0.26, -L*0.53, W*0.45, W*0.44, sec[3].yMid-0.02, sec[3].yMid-0.02, rearTop+0.10, rearTop);
  }
  if (def.id === 'suv'){ // roof rails
    for (const sx of [-1,1]) B.dark.box(sx*W*0.30, cabTop+0.09, -L*0.10, 0.07, 0.05, L*0.62);
  }
  if (def.id === 'coupe'){ // spoiler on struts
    B.paint.box(0, rearTop+0.24, -L*0.50, W*0.78, 0.05, 0.30);
    for (const sx of [-1,1]) B.dark.box(sx*W*0.26, rearTop+0.10, -L*0.50, 0.06, 0.16, 0.08);
  }
  if (def.id === 'muscle'){ // hood scoop
    B.paint.box(0, hoodTop+0.05, L*0.40, 0.5, 0.09, 0.42);
    B.dark.box(0, hoodTop+0.10, L*0.44, 0.34, 0.03, 0.20); // scoop opening
  }
  // bumpers, grille, lights
  B.accent.prism(L*0.60, L*0.50, W*0.48, W*0.47, 0.30, 0.32, 0.56, 0.58);
  B.accent.prism(-L*0.50, -L*0.60, W*0.47, W*0.48, 0.32, 0.30, 0.58, 0.56);
  B.dark.box(0, 0.66, L*0.575, W*0.46, 0.20, 0.06); // grille
  for (const sx of [-1,1]){
    B.lightF.box(sx*W*0.33, 0.72, L*0.565, W*0.20, 0.13, 0.05);
    B.lightR.box(sx*W*0.33, 0.74, -L*0.565, W*0.20, 0.11, 0.05);
    B.dark.box(sx*(W*0.50+0.03), cabTop-0.28, zS(1)+0.05, 0.16, 0.10, 0.07); // mirror head
    B.dark.box(sx*(W*0.485), cabTop-0.30, zS(1)+0.05, 0.05, 0.05, 0.05);     // mirror stalk
    B.dark.box(sx*(W*0.30), 0.16, -L*0.46, 0.09, 0.07, 0.16);               // exhaust tip
  }
  if (def.id==='coupe' || def.id==='muscle') for (const sx of [-1,1])
    B.dark.box(sx*(W*0.16), 0.16, -L*0.46, 0.09, 0.07, 0.16); // dual exhausts
  // side skirts
  for (const sx of [-1,1]) B.dark.box(sx*W*0.475, 0.30, 0, 0.04, 0.14, L*0.52);
  return B;
}

/* ---------- skinned car mesh ---------- */
let carGroup = null, skinParts = [], wheelMeshes = [], blobShadow = null;
const MATS = {};
function makeMats(def){
  MATS.paint = new THREE.MeshPhongMaterial({ color:def.color, shininess:70, specular:0x555555 });
  MATS.accent = new THREE.MeshPhongMaterial({ color:def.accent, shininess:40 });
  MATS.glass = new THREE.MeshPhongMaterial({ color:0x10161f, shininess:120, specular:0x99bbdd, transparent:true, opacity:0.88 });
  MATS.lightF = new THREE.MeshBasicMaterial({ color:0xfff6c9 });
  MATS.lightR = new THREE.MeshBasicMaterial({ color:0xff2a22 });
  MATS.dark = new THREE.MeshPhongMaterial({ color:0x17181a, shininess:25 });
}
function buildCarMeshes(){
  if (carGroup){ scene.remove(carGroup); carGroup.traverse(o=>{ if(o.geometry) o.geometry.dispose(); }); }
  wheelMeshes.forEach(g=>scene.remove(g));
  skinParts = []; wheelMeshes = [];
  carGroup = new THREE.Group(); scene.add(carGroup);
  makeMats(carDef);
  const buckets = buildBuckets(carDef, subdivForTarget(car.targetNodes));
  const nodes = car.nodes;
  for (const key of Object.keys(buckets)){
    const bk = buckets[key], n = bk.pos.length/3;
    if (!n) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bk.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bk.nor), 3));
    // anchors: each vertex belongs to a cage CELL (section pair x
    // ring segment) with bilinear weights + a residual in the cell's
    // own frame — see buildSkinAnchors in the sim core. Panels now
    // follow their own cage quad through a crash instead of blending
    // three nearest nodes through the whole car's frame.
    const anchors = S.buildSkinAnchors(car, bk.pos);
    const mesh = new THREE.Mesh(geo, MATS[key]);
    // the skin's vertices are WORLD positions (updateSkin writes them
    // every frame) while this mesh sits at the origin, so the geometry's
    // bounding sphere — computed once from the spawn-local coordinates —
    // is stale forever after: frustum culling against it makes the whole
    // body vanish at some camera angles / distances from spawn while the
    // car is physically still there. Culling off is the fix (recomputing
    // the sphere per frame would just burn the budget the skin already
    // spends on normals).
    mesh.frustumCulled = false;
    carGroup.add(mesh);
    skinParts.push({ geo:geo, anchors:anchors, n:n });
  }
  // wheels: unit wheel scaled per car (tire + rim + 5 spokes + hub)
  const tireG = new THREE.CylinderGeometry(1, 1, 0.72, 20); tireG.rotateZ(Math.PI/2);
  const rimG = new THREE.CylinderGeometry(0.58, 0.58, 0.74, 14); rimG.rotateZ(Math.PI/2);
  const hubG = new THREE.CylinderGeometry(0.16, 0.16, 0.78, 10); hubG.rotateZ(Math.PI/2);
  const tireM = new THREE.MeshPhongMaterial({ color:0x131416, shininess:8 });
  const rimM = new THREE.MeshPhongMaterial({ color:0xb9bec6, shininess:90, specular:0x888888 });
  for (let w=0; w<4; w++){
    const g = new THREE.Group();
    g.add(new THREE.Mesh(tireG, tireM));
    g.add(new THREE.Mesh(rimG, rimM));
    for (let sIdx=0; sIdx<5; sIdx++){
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.17, 0.30), rimM);
      sp.rotation.x = sIdx*Math.PI/5; g.add(sp);
    }
    g.add(new THREE.Mesh(hubG, MATS.dark));
    g.scale.setScalar(carDef.wheelR);
    g.userData.spin = 0;
    scene.add(g); wheelMeshes.push(g);
  }
  // blob shadow (cheap, always under the car — no shadow-map cost)
  if (!blobShadow){
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const cx2 = cv.getContext('2d');
    const gr = cx2.createRadialGradient(64,64,8,64,64,62);
    gr.addColorStop(0,'rgba(0,0,0,0.55)'); gr.addColorStop(1,'rgba(0,0,0,0)');
    cx2.fillStyle = gr; cx2.fillRect(0,0,128,128);
    blobShadow = new THREE.Mesh(new THREE.PlaneGeometry(1,1),
      new THREE.MeshBasicMaterial({ map:new THREE.CanvasTexture(cv), transparent:true, depthWrite:false }));
    blobShadow.rotation.x = -Math.PI/2; scene.add(blobShadow);
  }
  blobShadow.scale.set(carDef.width*1.7, carDef.length*1.25, 1);
  buildDebug();
}
function updateSkin(){
  const fr = car.frame();
  for (const part of skinParts){
    const p = part.geo.attributes.position.array;
    S.skinPositions(car, part.anchors, p);
    part.geo.attributes.position.needsUpdate = true;
    part.geo.computeVertexNormals();
  }
  // wheels follow their nodes (even detached ones), with steer + spin
  const M = new THREE.Matrix4(), Rx = new THREE.Matrix4();
  for (let w=0; w<4; w++){
    const g = wheelMeshes[w], nd = car.nodes[car.wheelIdx[w]];
    const sa = w<2 ? car.steerAngle : 0;
    const fx = fr.fwd.x*Math.cos(sa) - fr.right.x*Math.sin(sa);
    const fy = fr.fwd.y*Math.cos(sa) - fr.right.y*Math.sin(sa);
    const fz = fr.fwd.z*Math.cos(sa) - fr.right.z*Math.sin(sa);
    let rx = fr.up.y*fz - fr.up.z*fy, ry = fr.up.z*fx - fr.up.x*fz, rz = fr.up.x*fy - fr.up.y*fx;
    const rl = Math.hypot(rx,ry,rz)||1; rx/=rl; ry/=rl; rz/=rl;
    const ux = fy*rz - fz*ry, uy = fz*rx - fx*rz, uz = fx*ry - fy*rx;
    const vF = nd.vel.x*fx + nd.vel.y*fy + nd.vel.z*fz;
    g.userData.spin -= vF/carDef.wheelR * lastDt;
    M.makeBasis(new THREE.Vector3(rx,ry,rz), new THREE.Vector3(ux,uy,uz), new THREE.Vector3(fx,fy,fz));
    Rx.makeRotationX(g.userData.spin);
    M.multiply(Rx);
    g.quaternion.setFromRotationMatrix(M);
    g.position.set(nd.pos.x, nd.pos.y, nd.pos.z);
  }
  // blob shadow under the car
  const c = car.center();
  const gh = world.groundHeight(c.x, c.z, car.sHint);
  blobShadow.position.set(c.x, gh.h + 0.04, c.z);
  const hAbove = Math.max(0, c.y - gh.h - 0.5);
  blobShadow.material.opacity = Math.max(0.12, 0.9 - hAbove*0.10);
}

/* ---------- debug node/beam overlay (B) ---------- */
let dbgGroup = null, dbgPts = null, dbgLines = null, debugOn = false;
function buildDebug(){
  if (dbgGroup){ scene.remove(dbgGroup); dbgGroup = null; }
  if (!car) return;
  dbgGroup = new THREE.Group(); dbgGroup.visible = debugOn; scene.add(dbgGroup);
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(car.nodes.length*3), 3));
  dbgPts = new THREE.Points(pg, new THREE.PointsMaterial({ color:0xffffff, size:0.13 }));
  // world-space positions in an origin-sitting object, same stale-sphere
  // culling trap as the car skin — culling off (see buildCarMeshes)
  dbgPts.frustumCulled = false;
  dbgGroup.add(dbgPts);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(car.beams.length*6), 3));
  lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(car.beams.length*6), 3));
  dbgLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors:true }));
  dbgLines.frustumCulled = false; // world-space positions, see dbgPts above
  dbgGroup.add(dbgLines);
}
function updateDebug(){
  if (!dbgGroup || !debugOn) return;
  const pp = dbgPts.geometry.attributes.position.array;
  car.nodes.forEach((nd,i)=>{ pp[i*3]=nd.pos.x; pp[i*3+1]=nd.pos.y; pp[i*3+2]=nd.pos.z; });
  dbgPts.geometry.attributes.position.needsUpdate = true;
  const lp = dbgLines.geometry.attributes.position.array, lc = dbgLines.geometry.attributes.color.array;
  car.beams.forEach((b,i)=>{
    const A = car.nodes[b.a].pos, B = car.nodes[b.b].pos;
    let ex = B.x, ey = B.y, ez = B.z, r, g, bl;
    if (b.broken){ r=0.85; g=0.12; bl=0.10; ex = A.x+(B.x-A.x)*0.35; ey = A.y+(B.y-A.y)*0.35; ez = A.z+(B.z-A.z)*0.35; }
    else {
      // colour by live stress (elastic strain vs the beam's material
      // yield, kept current by the beam-force loop): green when loafing,
      // yellow as it works, orange at yield, red approaching break. A
      // beam that has yielded keeps at least a yellow-orange tint from
      // its plastic history even after the load comes off.
      let s = b.stress || 0;
      if (b.deformed) s = Math.max(s, 0.6);
      if (s < 0.4){ const t = s/0.4; r = 0.45 + 0.55*t; g = 0.85 + 0.05*t; bl = 0.5 - 0.45*t; }
      else if (s < 0.75){ const t = (s-0.4)/0.35; r = 1.0; g = 0.9 - 0.15*t; bl = 0.05; }
      else if (s < 1.0){ const t = (s-0.75)/0.25; r = 1.0; g = 0.75 - 0.35*t; bl = 0.05; }
      else { const t = Math.min(1, (s-1.0)/0.6); r = 1.0; g = 0.4 - 0.3*t; bl = 0.05; }
    }
    lp.set([A.x,A.y,A.z, ex,ey,ez], i*6);
    lc.set([r,g,bl, r,g,bl], i*6);
  });
  dbgLines.geometry.attributes.position.needsUpdate = true;
  dbgLines.geometry.attributes.color.needsUpdate = true;
}
