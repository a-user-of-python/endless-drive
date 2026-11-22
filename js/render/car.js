/* ============================ RENDERING ============================ */
const S = globalThis.__SIM;
const world = new S.TrackWorld(1337);
let car = null, carDef = null, lastDt = 1/60;

/* WebGL startup (v2.4 hardening): context creation is attempted with
   progressively plainer attributes — antialias first, then without,
   then with every optional feature off. three r128 throws on the first
   failure and never retries, and browsers differ in which attribute
   combinations they accept (Firefox in particular refuses some
   contexts Chrome accepts, e.g. on driver blocklists or with
   antialiasing unavailable), so a single attempt used to mean a
   silent blank page there. If every attempt fails, the boot error box
   (index.html) explains it in plain words with the technical error. */
function createRenderer(){
  const attempts = [
    { antialias:true },
    { antialias:false },
    { antialias:false, stencil:false, depth:true, alpha:false,
      powerPreference:'default', failIfMajorPerformanceCaveat:false }
  ];
  let lastErr = null;
  for (const attrs of attempts){
    try { return new THREE.WebGLRenderer(attrs); }
    catch (e){ lastErr = e; }
  }
  throw lastErr || new Error('WebGL context creation failed');
}
let renderer;
try {
  renderer = createRenderer();
} catch (e) {
  if (window.__edShowError) window.__edShowError(
    'The game could not start its 3D graphics (WebGL). Your browser refused ' +
    'every WebGL setup the game tried. Check that hardware acceleration is ' +
    'enabled in the browser settings, update the graphics driver, or try ' +
    'another browser. The technical error is below.', e);
  throw e;
}
renderer.domElement.addEventListener('webglcontextlost', ev=>{
  ev.preventDefault();
  if (window.__edShowError) window.__edShowError(
    'The graphics context was lost (the GPU or driver reset it), so the game ' +
    'can no longer draw. Reload the page to restart it.',
    'webglcontextlost event on the renderer canvas');
});
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
              lightF:new Bucket(subdiv), lightR:new Bucket(subdiv), dark:new Bucket(subdiv),
              tail:new Bucket(subdiv), chrome:new Bucket(subdiv), interior:new Bucket(subdiv),
              lensF:new Bucket(subdiv), lensR:new Bucket(subdiv) };
  const L = def.length, W = def.width, sec = def.sections;
  const zS = i => sec[i].z*L;
  const cabTop = sec[1].yTop, hoodTop = sec[0].yTop, rearTop = sec[3].yTop;
  // belly + lower body
  B.paint.prism(L*0.53, -L*0.53, W*0.47, W*0.47, 0.30, 0.32, sec[0].yMid+0.05, sec[3].yMid+0.05);
  B.dark.prism(L*0.50, -L*0.50, W*0.44, W*0.44, 0.16, 0.16, 0.31, 0.31); // underbody shadow line
  // hood — v2.6 segmented into two angled panels (nose panel + rear
  // panel with a slight power bulge) instead of one flat prism, so
  // the front silhouette has a shaped break in it
  B.paint.prism(L*0.53, L*0.36, W*0.45, W*0.46, sec[0].yMid-0.05, sec[0].yMid-0.03, hoodTop, hoodTop+0.045);
  B.paint.prism(L*0.36, zS(1)+0.1, W*0.46, W*0.47, sec[0].yMid-0.03, sec[1].yMid-0.02, hoodTop+0.045, sec[1].yMid+0.18);
  // fenders over the wheels
  const wz = def.wheelBase*L*0.5, wx = def.trackW*W*0.5;
  for (const sx of [-1,1]) for (const sz of [-1,1]){
    B.paint.box(sx*(wx+0.02), def.wheelR+0.30, sz*wz, 0.30, 0.16, def.wheelR*2+0.34);
    B.dark.box(sx*(wx+0.10), def.wheelR+0.30, sz*wz, 0.10, 0.18, def.wheelR*2+0.40); // arch trim
  }
  /* ---- v2.7 glasshouse helpers: flat panes as single quads in the
     side / front / rear planes. Every corner is an ordinary bucket
     vertex, so panes anchor to cage cells exactly like the prisms
     they replace and fold with the body in a crash. ---- */
  // side-plane quad: sx=+1 faces +x, sx=-1 faces -x (winding mirrors)
  const sideQuad = (bk, sx, x, yB, yT, zBF, zBB, zTF, zTB)=>{
    if (sx > 0) bk.quad([x,yB,zBF],[x,yB,zBB],[x,yT,zTB],[x,yT,zTF],[1,0,0]);
    else bk.quad([x,yB,zBB],[x,yB,zBF],[x,yT,zTF],[x,yT,zTB],[-1,0,0]);
  };
  // front-facing quad (windshield / grille plane), normal tilted by n
  const frontQuad = (bk, hwB, hwT, yB, yT, zB, zT, n)=>{
    bk.quad([-hwB,yB,zB],[hwB,yB,zB],[hwT,yT,zT],[-hwT,yT,zT], n || [0,0.35,0.94]);
  };
  // rear-facing quad (backlight / tailgate plane)
  const rearQuad = (bk, hwB, hwT, yB, yT, zB, zT, n)=>{
    bk.quad([hwB,yB,zB],[-hwB,yB,zB],[-hwT,yT,zT],[hwT,yT,zT], n || [0,0.35,-0.94]);
  };
  const glassFB = zS(1)+L*0.05, glassFT = zS(1)+L*0.14;      // windshield bottom / top z
  const glassBB = def.id==='suv' ? -L*0.42 : -L*0.22;        // backlight bottom z
  const glassBT = def.id==='suv' ? -L*0.44 : -L*0.31;        // backlight top z
  const cabBackZ = def.id==='pickup' ? zS(2)+L*0.01 : glassBB;
  const cabBackTZ = def.id==='pickup' ? zS(2)+L*0.01 : glassBT;
  // cabin / glasshouse
  if (def.id === 'pickup'){
    // v2.7: separate panes (windshield / sides / rear cab glass)
    // instead of one glass prism, pillars between the panes
    frontQuad(B.glass, W*0.40, W*0.36, sec[1].yMid+0.03, cabTop-0.04, glassFB, glassFT);
    rearQuad(B.glass, W*0.38, W*0.38, sec[2].yMid+0.04, cabTop-0.06, cabBackZ, cabBackZ, [0,0,-1]);
    for (const sx of [-1,1]){
      sideQuad(B.glass, sx, sx*W*0.438, sec[1].yMid+0.03, cabTop-0.06, glassFB+0.03, L*0.01, glassFT, -L*0.01);
      sideQuad(B.glass, sx, sx*W*0.438, sec[2].yMid+0.03, cabTop-0.06, -L*0.03, cabBackZ+0.02, -L*0.03, cabBackZ+0.02);
      sideQuad(B.dark, sx, sx*W*0.452, sec[1].yMid+0.01, cabTop-0.02, glassFB+0.06, glassFB-0.03, glassFT+0.04, glassFT-0.05); // A-pillar
      B.dark.box(sx*W*0.452, (sec[1].yMid+cabTop)*0.5, -L*0.02, 0.045, Math.max(0.2, cabTop-sec[1].yMid-0.04), 0.08); // B-pillar
    }
    B.paint.prism(zS(1)+L*0.15, zS(2)+0.0, W*0.43, W*0.44, cabTop-0.06, cabTop-0.06, cabTop+0.04, cabTop+0.04); // roof
    // open bed: floor, walls, tailgate
    B.dark.box(0, 0.68, (zS(2)+(-L*0.53))/2, W*0.86, 0.07, (-L*0.53)-zS(2)-0.1);
    for (const sx of [-1,1]) B.paint.box(sx*(W*0.44), 0.86, (zS(2)-0.1+(-L*0.52))/2, 0.07, 0.42, (-L*0.52)-(zS(2)-0.1));
    B.paint.box(0, 0.86, -L*0.515, W*0.90, 0.42, 0.07); // tailgate
    B.paint.box(0, 0.86, zS(2)-0.05, W*0.90, 0.42, 0.07); // bed front wall
  } else {
    // v2.7: raked windshield, inset side panes with A/B/C pillars
    // between them, and a separate backlight — no solid glass prism
    frontQuad(B.glass, W*0.40, W*0.36, sec[1].yMid+0.03, cabTop-0.04, glassFB, glassFT);
    rearQuad(B.glass, W*0.40, W*0.37, sec[2].yMid+0.03, (def.id==='suv'?cabTop:rearTop+0.18)-0.02, glassBB, glassBT);
    for (const sx of [-1,1]){
      sideQuad(B.glass, sx, sx*W*0.438, sec[1].yMid+0.03, cabTop-0.06, glassFB+0.03, L*0.03, glassFT, L*0.0);   // front side pane
      sideQuad(B.glass, sx, sx*W*0.438, sec[2].yMid+0.03, cabTop-0.06, -L*0.01, glassBB+0.03, -L*0.03, glassBT+0.02); // rear side pane
      sideQuad(B.dark, sx, sx*W*0.452, sec[1].yMid+0.01, cabTop-0.02, glassFB+0.06, glassFB-0.03, glassFT+0.04, glassFT-0.05); // A-pillar
      B.dark.box(sx*W*0.452, (sec[1].yMid+cabTop)*0.5, L*0.015, 0.045, Math.max(0.2, cabTop-sec[1].yMid-0.04), 0.08); // B-pillar
      sideQuad(B.paint, sx, sx*W*0.455, sec[2].yMid+0.01, cabTop-0.03, glassBB+0.07, glassBB-0.09, glassBT+0.04, glassBT-0.08); // C-pillar (painted)
      sideQuad(B.chrome, sx, sx*W*0.444, cabTop-0.075, cabTop-0.045, glassFT-0.01, glassBT+0.01, glassFT-0.01, glassBT+0.01); // chrome window surround, top edge
    }
    B.paint.prism(zS(1)+L*0.13, (def.id==='suv'?-L*0.46:-L*0.28), W*0.42, W*0.43, cabTop-0.06, cabTop-0.06, cabTop+0.04, cabTop+0.04); // roof
    if (def.id !== 'suv'){ // trunk deck — v2.6 segmented (lid + rear slope)
      B.paint.prism(-L*0.26, -L*0.40, W*0.45, W*0.45, sec[3].yMid-0.02, sec[3].yMid-0.02, rearTop+0.10, rearTop+0.085);
      B.paint.prism(-L*0.40, -L*0.53, W*0.45, W*0.44, sec[3].yMid-0.02, sec[3].yMid-0.02, rearTop+0.085, rearTop);
    }
  }
  if (def.id === 'suv'){ // roof rails
    for (const sx of [-1,1]) B.dark.box(sx*W*0.30, cabTop+0.09, -L*0.10, 0.07, 0.05, L*0.62);
    B.paint.box(0, cabTop+0.03, -L*0.475, W*0.80, 0.06, 0.16); // v2.6 rear spoiler lip
  }
  if (def.id === 'coupe'){ // spoiler on struts
    B.paint.box(0, rearTop+0.24, -L*0.50, W*0.78, 0.05, 0.30);
    for (const sx of [-1,1]) B.dark.box(sx*W*0.26, rearTop+0.10, -L*0.50, 0.06, 0.16, 0.08);
    B.paint.box(0, rearTop+0.115, -L*0.505, W*0.72, 0.045, 0.14); // v2.6 ducktail lip on the trunk edge
  }
  if (def.id === 'muscle'){ // hood scoop
    B.paint.box(0, hoodTop+0.05, L*0.40, 0.5, 0.09, 0.42);
    B.dark.box(0, hoodTop+0.10, L*0.44, 0.34, 0.03, 0.20); // scoop opening
    // v2.6 centre stripe pair (accent) over hood, roof and trunk
    for (const sx of [-1,1]){
      B.accent.box(sx*0.14, hoodTop+0.062, L*0.335, 0.17, 0.018, L*0.30);
      B.accent.box(sx*0.14, cabTop+0.048, -L*0.075, 0.17, 0.018, L*0.36);
      B.accent.box(sx*0.14, rearTop+0.098, -L*0.395, 0.17, 0.018, L*0.26);
    }
  }
  if (def.id === 'pickup'){ // v2.6 bed side rails + rear window header
    for (const sx of [-1,1]) B.paint.box(sx*(W*0.44), 1.10, (zS(2)-0.1+(-L*0.52))/2, 0.09, 0.07, (-L*0.52)-(zS(2)-0.1));
    B.paint.box(0, cabTop+0.02, zS(2)+0.02, W*0.88, 0.09, 0.09); // header above the rear window
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
  /* ---- v2.6 detail pass (all pieces are ordinary bucket geometry,
     so every vertex is anchored through buildSkinAnchors and deforms
     with the body — nothing here is a static overlay) ---- */
  // windshield header panel + A-pillar suggestions + wiper line
  B.paint.box(0, cabTop-0.02, zS(1)+L*0.115, W*0.84, 0.07, 0.10);
  for (const sx of [-1,1])
    B.dark.box(sx*W*0.415, (sec[1].yMid+cabTop)*0.5, zS(1)+L*0.075, 0.07, Math.max(0.2, cabTop-sec[1].yMid-0.05), 0.10);
  B.dark.box(0, sec[1].yMid+0.10, zS(1)+L*0.115, W*0.62, 0.035, 0.06); // wiper rest line
  // front fascia: lower valance, splitter, fog lights
  B.accent.box(0, 0.30, L*0.565, W*0.80, 0.16, 0.10);
  B.dark.box(0, 0.185, L*0.55, W*0.86, 0.07, 0.22); // front splitter
  for (const sx of [-1,1]) B.lightF.box(sx*W*0.36, 0.44, L*0.575, 0.13, 0.09, 0.05); // fog lights
  // rear: full-width tail strip, valance, diffuser, plate, muffler
  B.tail.box(0, 0.76, -L*0.575, W*0.78, 0.09, 0.045);
  B.accent.box(0, 0.31, -L*0.565, W*0.80, 0.15, 0.10);
  B.dark.box(0, 0.19, -L*0.55, W*0.84, 0.07, 0.22); // rear diffuser
  B.accent.box(0, 0.52, -L*0.605, 0.34, 0.17, 0.03); // rear plate
  B.dark.box(0, 0.17, -L*0.40, 0.44, 0.13, 0.30);   // muffler can
  // sides: rocker trim strip over the skirt, door cut lines, handles
  for (const sx of [-1,1]){
    B.accent.box(sx*W*0.478, 0.40, 0, 0.03, 0.06, L*0.52);
    for (const dz of [L*0.14, -L*0.13]) // vertical door shut lines
      B.dark.box(sx*W*0.472, 0.78, dz, 0.025, 0.52, 0.035);
    for (const dz of [L*0.20, -L*0.06]) // door handles
      B.dark.box(sx*W*0.478, 1.02, dz, 0.03, 0.045, 0.17);
  }
  if (def.id !== 'pickup') B.dark.box(0, cabTop+0.075, -L*0.16, 0.05, 0.06, 0.16); // roof antenna fin

  /* ---- v2.7 detail pass (same rule as v2.6: every piece below is
     ordinary bucket geometry — quads, prisms and boxes whose corners
     sit ON or just off the existing body surfaces — so every new
     vertex is anchored through buildSkinAnchors and deforms with
     the cage; nothing is a static overlay) ---- */
  // headlight assemblies: dark housing, recessed lens, chrome
  // reflector strip and an amber indicator segment per side
  for (const sx of [-1,1]){
    B.dark.box(sx*W*0.33, 0.72, L*0.556, W*0.235, 0.175, 0.045);          // housing
    B.lensF.box(sx*W*0.33, 0.72, L*0.572, W*0.185, 0.115, 0.028);         // lens (recessed in the housing)
    B.chrome.box(sx*W*0.33, 0.755, L*0.578, W*0.17, 0.028, 0.014);        // reflector strip
    B.accent.box(sx*W*0.435, 0.72, L*0.566, W*0.045, 0.11, 0.04);         // indicator segment
    // taillight assemblies: housing + red lens + clear reverse segment
    B.dark.box(sx*W*0.33, 0.74, -L*0.556, W*0.235, 0.155, 0.045);
    B.lensR.box(sx*W*0.345, 0.74, -L*0.572, W*0.155, 0.095, 0.028);
    B.lensF.box(sx*W*0.225, 0.74, -L*0.572, W*0.05, 0.095, 0.028);         // reverse light
    // mirror: chrome cap + glass face on the existing head
    B.chrome.box(sx*(W*0.50+0.035), cabTop-0.28, zS(1)+0.085, 0.155, 0.095, 0.02);
    B.lensF.box(sx*(W*0.50+0.03), cabTop-0.28, zS(1)+0.012, 0.13, 0.075, 0.016);
    // wheel-arch lips: a paint lip standing proud of each fender box
    for (const sz of [-1,1])
      B.paint.box(sx*(wx+0.045), def.wheelR+0.415, sz*wz, 0.13, 0.055, def.wheelR*2+0.46);
    // door seams as inset quads standing 4 mm proud of the skin:
    // top seam, sill seam and the rear-door shut line (the front
    // shut lines and handles are the v2.6 boxes above)
    const sxq = sx*(W*0.476);
    sideQuad(B.dark, sx, sxq, sec[1].yMid+0.015, sec[1].yMid+0.05, L*0.24, -L*0.30, L*0.24, -L*0.30); // door top seam (at the window base)
    sideQuad(B.dark, sx, sxq, 0.44, 0.475, L*0.24, -L*0.30, L*0.24, -L*0.30);   // sill seam
    sideQuad(B.dark, sx, sxq, 0.50, sec[1].yMid+0.02, -L*0.255, -L*0.285, -L*0.255, -L*0.285); // rear door shut line
    for (const dz of [L*0.20, -L*0.06]) // handle recess + chrome pull
      { B.dark.box(sx*W*0.474, 1.02, dz, 0.028, 0.085, 0.23);
        B.chrome.box(sx*W*0.482, 1.035, dz, 0.02, 0.028, 0.17); }
    B.chrome.box(sx*W*0.478, 0.90, -L*0.38, 0.025, 0.05, 0.14); // side badge
  }
  // grille: chrome slats + centre badge; front plate in a dark recess
  for (const gy of [0.60, 0.66, 0.72]) B.chrome.box(0, gy, L*0.585, W*0.44, 0.022, 0.016);
  B.chrome.box(0, 0.66, L*0.589, 0.075, 0.075, 0.018);                       // grille badge
  B.dark.box(0, 0.44, L*0.606, 0.38, 0.21, 0.025);                           // front plate recess
  B.accent.box(0, 0.44, L*0.612, 0.34, 0.17, 0.014);                         // front plate
  // bumpers: panel-gap strips where cover meets body, painted corner
  // caps over the accent prisms, chrome rear strip + plate lamp
  B.dark.box(0, 0.585, L*0.545, W*0.93, 0.028, 0.03);
  B.dark.box(0, 0.605, -L*0.545, W*0.93, 0.028, 0.03);
  for (const sx of [-1,1]) for (const sz of [-1,1])
    B.paint.box(sx*W*0.40, 0.44, sz*L*0.565, W*0.17, 0.24, 0.09);            // bumper corner caps
  B.chrome.box(0, 0.60, -L*0.578, W*0.70, 0.035, 0.02);                      // rear chrome strip
  B.dark.box(0, 0.635, -L*0.608, 0.40, 0.20, 0.025);                         // rear plate recess (behind the v2.6 plate)
  B.chrome.box(0, 0.745, -L*0.60, 0.20, 0.03, 0.02);                         // plate lamp strip
  B.chrome.box(0, 0.50, -L*0.582, 0.16, 0.06, 0.018);                        // rear badge
  // exhaust: chrome outer tip + dark opening, over the v2.6 dark tips
  for (const sx of [-1,1]){
    B.chrome.box(sx*(W*0.30), 0.16, -L*0.465, 0.115, 0.095, 0.17);
    B.dark.box(sx*(W*0.30), 0.16, -L*0.545, 0.085, 0.065, 0.02);
    if (def.id==='coupe' || def.id==='muscle'){
      B.chrome.box(sx*(W*0.16), 0.16, -L*0.465, 0.115, 0.095, 0.17);
      B.dark.box(sx*(W*0.16), 0.16, -L*0.545, 0.085, 0.065, 0.02);
    }
  }
  B.dark.box(W*0.472, 0.88, -L*0.40, 0.02, 0.15, 0.19);                      // fuel flap (right rear quarter)
  // wipers: two dark blades lying on the windshield plane, parked at
  // its base, plus the swept second blade angled up the glass
  {
    const yB = sec[1].yMid+0.035, yT = cabTop-0.04, zB = glassFB, zT = glassFT;
    const wp = (x, t)=>[x, yB+(yT-yB)*t+0.006, zB+(zT-zB)*t+0.010];
    for (const wx0 of [-W*0.30, W*0.06]){
      const a = wp(wx0, 0.03), b = wp(wx0+0.035, 0.03), c = wp(wx0+0.30, 0.52), d = wp(wx0+0.265, 0.52);
      B.dark.quad(a, b, c, d, [0,0.35,0.94]);
    }
    if (def.id === 'suv'){ // rear wiper on the near-vertical backlight
      const a = [-W*0.16, sec[2].yMid+0.10, glassBB-0.012], b = [W*0.02, sec[2].yMid+0.10, glassBB-0.012];
      const c = [W*0.05, sec[2].yMid+0.42, glassBT-0.012], d = [-W*0.13, sec[2].yMid+0.42, glassBT-0.012];
      B.dark.quad(b, a, d, c, [0,0,-1]);
    }
  }
  /* interior suggestion, seen through the now-clearer glass:
     dashboard, wheel, seats and a rear bench, all interior-bucket
     boxes riding cabin cage cells */
  {
    const yM = sec[1].yMid, dH = cabTop - yM;
    B.interior.box(0, yM+0.20, zS(1)+L*0.015, W*0.80, 0.17, 0.30);          // dashboard
    B.interior.box(0, yM+0.295, zS(1)+L*0.03, W*0.78, 0.035, 0.24);         // dash top pad
    /* NOTE (v2.7, test-32 driven): no steering wheel / column and
       no centre console. Those pieces sit near the cabin centre,
       ~0.45 m from the nearest cage ring, and at 150 nodes the cage
       cells are ~0.9 m long: in the 100 km/h crash the cell shear
       put their skin-vs-rigid-fit mismatch at 0.71-0.74 m, single-
       handedly pushing the skin-match p98 over its 0.42 m bound
       (measured: 81 of the 109 verts over 0.40 m were the wheel).
       The dash, seats and bench stay — their corners sit close to
       the ring and measure fine. A wheel that tears away from the
       cage in a crash is worse than no wheel. */
    B.dark.box(0, cabTop-0.10, glassFT-0.03, 0.24, 0.07, 0.03);             // rear-view mirror
    for (const sx of [-1,1]){ // front seats: base, backrest, headrest
      B.interior.box(sx*W*0.21, yM-0.03, L*0.015, W*0.34, 0.15, 0.46);
      B.interior.box(sx*W*0.21, yM+dH*0.36, -L*0.045, W*0.34, dH*0.60, 0.14);
      B.interior.box(sx*W*0.21, yM+dH*0.76, -L*0.055, W*0.17, 0.13, 0.09);
    }
    if (def.id !== 'pickup'){ // rear bench + headrests
      B.interior.box(0, yM-0.03, -L*0.155, W*0.72, 0.15, 0.40);
      B.interior.box(0, yM+dH*0.34, -L*0.225, W*0.72, dH*0.58, 0.13);
      for (const sx of [-1,1]) B.interior.box(sx*W*0.20, yM+dH*0.74, -L*0.235, W*0.17, 0.12, 0.08);
    } else { // pickup: panel behind the seats instead of a bench
      B.interior.box(0, yM+dH*0.30, zS(2)+L*0.045, W*0.76, dH*0.72, 0.06);
    }
  }
  // sunroof: dark glass panel inset in the roof (not on the pickup's
  // short cab roof, and clear of the roof's front row)
  if (def.id === 'sedan' || def.id === 'coupe' || def.id === 'muscle'){
    B.glass.box(0, cabTop+0.045, -L*0.03, W*0.52, 0.018, L*0.30);
  }
  /* per-car extras, v2.7 */
  if (def.id === 'sedan'){
    B.chrome.box(0, rearTop+0.115, -L*0.47, W*0.60, 0.03, 0.03);            // trunk chrome strip
    for (const sx of [-1,1]) B.chrome.box(sx*W*0.478, 0.62, L*0.02, 0.02, 0.035, L*0.55); // side rub strip
  }
  if (def.id === 'coupe'){
    for (const sx of [-1,1]){
      B.dark.box(sx*W*0.465, 0.78, -L*0.20, 0.05, 0.20, 0.26);              // side vent behind the door
      B.paint.box(sx*W*0.44, 0.62, -L*0.36, 0.10, 0.30, L*0.24);            // rear haunch
    }
  }
  if (def.id === 'suv'){
    for (const dz of [-L*0.28, L*0.02]) B.dark.box(0, cabTop+0.115, dz, W*0.62, 0.045, 0.07); // roof cross bars
    for (const sx of [-1,1]) B.dark.box(sx*W*0.46, 0.24, 0, 0.10, 0.09, L*0.55);              // running boards
  }
  if (def.id === 'pickup'){
    for (let i=0;i<5;i++) // bed floor ribs across the dark bed floor
      B.dark.box(0, 0.725, (zS(2)-0.30) + ((-L*0.50+0.18)-(zS(2)-0.30))*i/4, W*0.82, 0.018, 0.07);
    for (const sx of [-1,1]){
      B.paint.box(sx*(W*0.30), 0.80, -wz-L*0.02, 0.30, 0.22, def.wheelR*2+0.30); // bed wheel tubs
      B.dark.box(sx*(W*0.44), 0.80, wz-def.wheelR-0.28, 0.16, 0.34, 0.04);       // mud flap behind the front wheel
      B.dark.box(sx*(W*0.44), 0.80, -wz-def.wheelR-0.28, 0.16, 0.34, 0.04);      // mud flap behind the rear wheel
    }
    B.dark.box(0, 0.98, -L*0.522, 0.30, 0.07, 0.03);                          // tailgate handle
    B.chrome.box(0, 1.085, -L*0.522, W*0.86, 0.035, 0.025);                   // tailgate top strip
    B.lensR.box(0, cabTop-0.01, zS(2)-0.015, 0.30, 0.06, 0.03);               // third brake light on the cab header
  }
  if (def.id === 'muscle'){
    for (let i=0;i<4;i++){ // rear-window louvres following the backlight slope
      const t = i/3, ly = (sec[2].yMid+0.10) + ((rearTop+0.16)-(sec[2].yMid+0.10))*t, lz = glassBB+0.02 + (glassBT-glassBB)*t;
      B.dark.box(0, ly, lz, W*0.74, 0.028, 0.10);
    }
    for (const sx of [-1,1]){
      B.dark.box(sx*0.30, hoodTop+0.105, L*0.30, 0.05, 0.03, 0.05);           // hood pins
      B.chrome.box(sx*W*0.478, 0.335, 0, 0.025, 0.045, L*0.52);               // chrome rocker trim
    }
  }
  return B;
}

/* ---------- skinned car mesh ---------- */
let carGroup = null, skinParts = [], wheelMeshes = [], blobShadow = null;
const MATS = {};
function makeMats(def){
  MATS.paint = new THREE.MeshPhongMaterial({ color:def.color, shininess:70, specular:0x555555 });
  MATS.accent = new THREE.MeshPhongMaterial({ color:def.accent, shininess:40 });
  // v2.7: glass is clearer (0.88 -> 0.60) so the new interior
  // bucket (seats / dash / wheel) reads through the panes
  MATS.glass = new THREE.MeshPhongMaterial({ color:0x1a2634, shininess:120, specular:0x99bbdd, transparent:true, opacity:0.60 });
  // v2.7 buckets: bright trim, cabin interior, and lamp lenses
  // (housings stay in the dark bucket; the lens sits recessed in it)
  MATS.chrome = new THREE.MeshPhongMaterial({ color:0xd8dde2, shininess:110, specular:0xbbbbbb });
  MATS.interior = new THREE.MeshPhongMaterial({ color:0x35302a, shininess:12 });
  MATS.lensF = new THREE.MeshPhongMaterial({ color:0xdfeaf2, shininess:130, specular:0xccddff, transparent:true, opacity:0.92 });
  MATS.lensR = new THREE.MeshPhongMaterial({ color:0xb01018, emissive:0x2a0003, shininess:90, specular:0xdd8888 });
  MATS.lightF = new THREE.MeshBasicMaterial({ color:0xfff6c9 });
  MATS.lightR = new THREE.MeshBasicMaterial({ color:0xff2a22 });
  // v2.6: tail bucket — deep red, emissive-tinted, for the rear
  // light strip (distinct from the lightR lamp pair)
  MATS.tail = new THREE.MeshPhongMaterial({ color:0x7d0d16, emissive:0x4d0208, shininess:60 });
  MATS.dark = new THREE.MeshPhongMaterial({ color:0x17181a, shininess:25 });
}
function buildCarMeshes(){
  if (carGroup){ scene.remove(carGroup); carGroup.traverse(o=>{ if(o.geometry) o.geometry.dispose(); }); }
  wheelMeshes.forEach(g=>scene.remove(g));
  skinParts = []; wheelMeshes = [];
  carGroup = new THREE.Group(); carGroup.matrixAutoUpdate = false; scene.add(carGroup);
  makeMats(carDef);
  // v2.5 render cap: the BUILT mesh never goes past subdivision 3,
  // whatever the cage resolution. subdivForTarget itself still scales
  // to 6 (the bucket builder's range, locked by the test suite), but
  // at 820 nodes it asked for 5 — 25x the base facets — and updateSkin
  // recomputes vertex normals over every one of those vertices every
  // frame; that was a large slice of the v2.4 frame cost at high
  // resolutions. At 3 the skin still renders at 9x base facets and
  // follows the same fine cage through its cell anchors; only the
  // facet size changes.
  const buckets = buildBuckets(carDef, Math.min(3, subdivForTarget(car.targetNodes)));
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
    // the mesh object itself never moves (its vertices are world
    // positions), so its matrix is the identity forever — stop
    // three.js recomposing it every frame
    mesh.matrixAutoUpdate = false;
    carGroup.add(mesh);
    skinParts.push({ geo:geo, anchors:anchors, n:n });
  }
  // wheels: unit wheel scaled per car (v2.6: wider tire, 8 spokes,
  // brake disc behind the spokes, hub + hub cap). The tire is an OPEN
  // tread band + ring sidewalls and the rim an open barrel: a closed
  // tire cylinder's end caps hid the rim/spokes/disc entirely (the
  // wheels read as solid black discs in the v2.6 spot-check).
  const tireG = new THREE.CylinderGeometry(1, 1, 0.84, 20, 1, true); tireG.rotateZ(Math.PI/2);
  const wallG = new THREE.RingGeometry(0.56, 1.0, 20); wallG.rotateY(Math.PI/2);
  const rimG = new THREE.CylinderGeometry(0.58, 0.58, 0.78, 14, 1, true); rimG.rotateZ(Math.PI/2);
  const discG = new THREE.CylinderGeometry(0.40, 0.40, 0.30, 14); discG.rotateZ(Math.PI/2);
  const hubG = new THREE.CylinderGeometry(0.16, 0.16, 0.84, 10); hubG.rotateZ(Math.PI/2);
  const capG = new THREE.CylinderGeometry(0.11, 0.11, 0.88, 10); capG.rotateZ(Math.PI/2);
  // v2.7 wheel detail: raised sidewall rings on both tire faces and
  // a rim lip ring. (A caliper is deliberately NOT added: the wheel
  // group spins as one unit, so a caliper mesh inside it would orbit
  // the hub instead of staying fixed behind the spokes.)
  const sidewallG = new THREE.TorusGeometry(0.79, 0.055, 8, 24); sidewallG.rotateY(Math.PI/2);
  const rimLipG = new THREE.TorusGeometry(0.575, 0.045, 8, 20); rimLipG.rotateY(Math.PI/2);
  const discRingG = new THREE.TorusGeometry(0.40, 0.035, 8, 20); discRingG.rotateY(Math.PI/2);
  const spokeG = new THREE.BoxGeometry(0.34, 0.52, 0.14); spokeG.translate(0, 0.33, 0);
  const tireM = new THREE.MeshPhongMaterial({ color:0x131416, shininess:8, side:THREE.DoubleSide });
  const rimM = new THREE.MeshPhongMaterial({ color:0xb9bec6, shininess:90, specular:0x888888, side:THREE.DoubleSide });
  const discM = new THREE.MeshPhongMaterial({ color:0x777777, shininess:35, specular:0x444444 });
  for (let w=0; w<4; w++){
    const g = new THREE.Group();
    g.add(new THREE.Mesh(tireG, tireM));
    for (const wx of [-0.41, 0.41]){ const wall = new THREE.Mesh(wallG, tireM); wall.position.x = wx; g.add(wall); }
    g.add(new THREE.Mesh(discG, discM));
    const discRing = new THREE.Mesh(discRingG, discM); g.add(discRing); // drilled-disc edge suggestion on the brake disc
    g.add(new THREE.Mesh(rimG, rimM));
    for (const wx of [-0.40, 0.40]){
      const sw = new THREE.Mesh(sidewallG, tireM); sw.position.x = wx; g.add(sw);   // tire sidewall ring
      const lip = new THREE.Mesh(rimLipG, rimM); lip.position.x = wx*0.98; g.add(lip); // rim lip
    }
    for (let sIdx=0; sIdx<8; sIdx++){
      const sp = new THREE.Mesh(spokeG, rimM);
      sp.rotation.x = sIdx*Math.PI/4; g.add(sp);
    }
    g.add(new THREE.Mesh(hubG, MATS.dark));
    g.add(new THREE.Mesh(capG, rimM));
    g.scale.setScalar(carDef.wheelR);
    g.userData.spin = 0;
    scene.add(g); wheelMeshes.push(g);
  }
  // blob shadow (cheap, always under the car — no shadow-map cost).
  // Optional visual: if the 2D canvas or its texture fails for any
  // reason, the car simply drives without a blob shadow (v2.4 degrade
  // rule — an optional feature must never kill the scene).
  if (!blobShadow){
    try {
      const cv = document.createElement('canvas'); cv.width = cv.height = 128;
      const cx2 = cv.getContext('2d');
      const gr = cx2.createRadialGradient(64,64,8,64,64,62);
      gr.addColorStop(0,'rgba(0,0,0,0.55)'); gr.addColorStop(1,'rgba(0,0,0,0)');
      cx2.fillStyle = gr; cx2.fillRect(0,0,128,128);
      blobShadow = new THREE.Mesh(new THREE.PlaneGeometry(1,1),
        new THREE.MeshBasicMaterial({ map:new THREE.CanvasTexture(cv), transparent:true, depthWrite:false }));
      blobShadow.rotation.x = -Math.PI/2; scene.add(blobShadow);
    } catch (e) { blobShadow = null; }
  }
  if (blobShadow) blobShadow.scale.set(carDef.width*1.7, carDef.length*1.25, 1);
  buildDebug();
}
/* v2.6: flat normals computed by hand into the existing normal
   attribute. The skin geometry is non-indexed, so every vertex
   belongs to exactly one triangle and its correct normal IS the
   face normal — exactly what computeVertexNormals produces for
   this geometry — but three's version walks the attribute API with
   per-face Vector3 temporaries, once per mesh per frame. This does
   the same arithmetic with plain array reads/writes, no allocation,
   one normalisation per face instead of per vertex. Parked
   appearance is therefore identical by construction; positions
   still update every frame, so moving deformation is unchanged. */
function computeFlatNormals(geo){
  const p = geo.attributes.position.array, n = geo.attributes.normal.array;
  for (let i=0; i<p.length; i+=9){
    const ax = p[i], ay = p[i+1], az = p[i+2];
    const ux = p[i+3]-ax, uy = p[i+4]-ay, uz = p[i+5]-az;
    const vx = p[i+6]-ax, vy = p[i+7]-ay, vz = p[i+8]-az;
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const l = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    nx/=l; ny/=l; nz/=l;
    n[i]=nx; n[i+1]=ny; n[i+2]=nz;
    n[i+3]=nx; n[i+4]=ny; n[i+5]=nz;
    n[i+6]=nx; n[i+7]=ny; n[i+8]=nz;
  }
  geo.attributes.normal.needsUpdate = true;
}
const _wheelM = new THREE.Matrix4(), _wheelRx = new THREE.Matrix4();
const _wvR = new THREE.Vector3(), _wvU = new THREE.Vector3(), _wvF = new THREE.Vector3();
function updateSkin(){
  const fr = car.frame();
  for (const part of skinParts){
    const p = part.geo.attributes.position.array;
    S.skinPositions(car, part.anchors, p);
    part.geo.attributes.position.needsUpdate = true;
    computeFlatNormals(part.geo);
  }
  // wheels follow their nodes (even detached ones), with steer + spin
  const M = _wheelM, Rx = _wheelRx;
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
    M.makeBasis(_wvR.set(rx,ry,rz), _wvU.set(ux,uy,uz), _wvF.set(fx,fy,fz));
    Rx.makeRotationX(g.userData.spin);
    M.multiply(Rx);
    g.quaternion.setFromRotationMatrix(M);
    g.position.set(nd.pos.x, nd.pos.y, nd.pos.z);
  }
  // blob shadow under the car (skipped entirely if its creation failed)
  const c = car.center();
  if (blobShadow){
    const gh = world.groundHeight(c.x, c.z, car.sHint);
    blobShadow.position.set(c.x, gh.h + 0.04, c.z);
    const hAbove = Math.max(0, c.y - gh.h - 0.5);
    blobShadow.material.opacity = Math.max(0.12, 0.9 - hAbove*0.10);
  }
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
