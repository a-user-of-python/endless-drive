// === SIM CORE START ===
'use strict';
/* ================================================================
   SIM CORE — pure JS, no THREE / document / window.
   Node/beam soft-body physics, procedural track, car definitions.
   ================================================================ */
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function lerp(a,b,t){ return a+(b-a)*t; }
function sstep(t){ t=clamp(t,0,1); return t*t*(3-2*t); }
function mulberry32(a){ return function(){ a|=0; a=(a+0x6D2B79F5)|0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }
function hashN(n){ const s=Math.sin(n*127.1+311.7)*43758.5453; return s-Math.floor(s); }
function hash2i(x,y){ const s=Math.sin(x*269.5+y*183.3+74.7)*43758.5453; return s-Math.floor(s); }

/* ---------------- Track ---------------- */
const DS = 5;                    // centerline sample spacing (m)
const ROAD_HALF = 4.6;
const BARRIER_LAT = 5.6;         // guardrail line: outside the road + margin
const CLIFF_FIRST = 600, CLIFF_PERIOD = 750, CLIFF_LEN = 170, CLIFF_EDGE = 7.0;

class TrackWorld {
  constructor(seed){
    this.seed = (seed===undefined?1337:seed)|0;
    this.samples = [{s:0, x:0, z:0, y:this.elev(0), h:0, k:0}];
    // flat mirrors of the sample fields nearestTrack scans (s/x/z/
    // heading): packed number arrays beat per-sample object property
    // loads in the hottest loop in the sim (every node, every substep)
    this._fs = [0]; this._fx = [0]; this._fz = [0]; this._fh = [0];
    this.obsCache = new Map();
    this.defCache = new Map();
    this.barrierCache = new Map();
    this.extraObstacles = [];
  }
  elev(s){ return 3.0*Math.sin(s*0.004) + 2.0*Math.sin(s*0.011+1.7) + 0.8*Math.sin(s*0.023+4.1); }
  kappa(s){
    // smooth random walk: value noise on 180 m knots, clamped
    const u = s/180, i = Math.floor(u), f = u-i, t = sstep(f);
    const a = hash2i(i, this.seed)*2-1, b = hash2i(i+1, this.seed)*2-1;
    return lerp(a,b,t) * 0.011;
  }
  extendTo(s){
    const arr = this.samples;
    while (arr[arr.length-1].s < s){
      const p = arr[arr.length-1];
      const k = this.kappa(p.s + DS*0.5);
      const h = p.h + k*DS;
      const np = { s:p.s+DS, x:p.x+Math.sin(h)*DS, z:p.z+Math.cos(h)*DS, y:this.elev(p.s+DS), h:h, k:k };
      arr.push(np);
      this._fs.push(np.s); this._fx.push(np.x); this._fz.push(np.z); this._fh.push(np.h);
    }
  }
  trackPoint(s){
    if (s < 0) s = 0;
    this.extendTo(s+DS);
    const i = Math.floor(s/DS), a = this.samples[i], b = this.samples[i+1] || a;
    const t = (s - a.s)/DS;
    return { s:s, x:lerp(a.x,b.x,t), z:lerp(a.z,b.z,t), y:lerp(a.y,b.y,t),
             heading:lerp(a.h,b.h,t), curvature:lerp(a.k,b.k,t) };
  }
  cliffAt(s){
    if (s < CLIFF_FIRST) return null;
    const rel = s - CLIFF_FIRST, idx = Math.floor(rel/CLIFF_PERIOD), frac = rel - idx*CLIFF_PERIOD;
    if (frac >= CLIFF_LEN) return null;
    return { index:idx, s0:CLIFF_FIRST+idx*CLIFF_PERIOD, s1:CLIFF_FIRST+idx*CLIFF_PERIOD+CLIFF_LEN,
             side:(idx%2===0)?1:-1, drop:30 + (idx%3)*5, edge:CLIFF_EDGE };
  }
  hill(s, ah){ // terrain rise away from the road (ah = |lateral|)
    if (ah <= 7.6) return 0;
    const d = ah - 7.6;
    return d*(0.22 + 0.06*Math.sin(s*0.013)) + (Math.sin(s*0.05+ah*0.3)+Math.sin(s*0.021-ah*0.17))*0.35*Math.min(1,d*0.2);
  }
  /* Road defects: deterministic, sparse. Defect k sits at
     s = 190 + 275k ± 60 (spacing 155–395 m; the first is at s >= 130, well
     past the spawn and the first ~60 m are always clean), |lat| <=
     ROAD_HALF - 0.95. Potholes dip 0.06–0.12 m, bumps rise 0.04–0.07 m —
     both are real height inside the same analytic path physics uses.
     Cracks are visual only (amp 0, the renderer draws them). */
  defectAt(k){
    if (this.defCache.has(k)) return this.defCache.get(k);
    const h1 = hash2i(k, this.seed*7+11), h2 = hash2i(k, this.seed*13+23),
          h3 = hash2i(k, this.seed*17+37), h4 = hash2i(k, this.seed*19+41),
          h5 = hash2i(k, this.seed*23+53);
    const type = h3 < 0.45 ? 'pothole' : (h3 < 0.75 ? 'bump' : 'crack');
    const d = { k:k, s:190 + k*275 + (h1-0.5)*120, lat:(h2*2-1)*(ROAD_HALF-0.95),
      type:type, r:0.45 + h4*0.35,
      amp: type==='pothole' ? -(0.06 + h5*0.06) : type==='bump' ? (0.04 + h5*0.03) : 0,
      seed:h5*1000 + k };
    this.defCache.set(k, d);
    if (this.defCache.size > 64){ const kk = this.defCache.keys().next().value; this.defCache.delete(kk); }
    return d;
  }
  defectOffset(s, lat){
    let off = 0;
    const k0 = Math.max(0, Math.floor((s-190-62)/275)), k1 = k0+2;
    // the three candidate defects for this 275 m bucket, cached: a
    // car's worth of ground queries in one substep nearly all share
    // the same bucket, so this turns three Map lookups into one
    // integer compare (defectAt itself is unchanged)
    let ds = this._dfc;
    if (!ds || ds.k0 !== k0){
      const d0 = this.defectAt(k0), d1 = this.defectAt(k0+1), d2 = this.defectAt(k0+2);
      ds = this._dfc = { k0:k0, d:[d0, d1, d2],
        // exact fast reject (v2.6 optimisation): a defect contributes
        // only when q = ((s-d.s)/d.r)^2 + ((lat-d.lat)/(d.r*0.8))^2 < 4,
        // which needs |s - d.s| < 2*d.r — outside the bucket's whole
        // s-window the offset is identically zero, no loop needed
        sLo: Math.min(d0.s - 2*d0.r, d1.s - 2*d1.r, d2.s - 2*d2.r),
        sHi: Math.max(d0.s + 2*d0.r, d1.s + 2*d1.r, d2.s + 2*d2.r) };
    }
    if (s < ds.sLo || s > ds.sHi) return 0;
    for (let k=k0;k<=k1;k++){
      const d = ds.d[k-k0];
      if (!d.amp) continue;
      const qs = (s-d.s)/d.r, ql = (lat-d.lat)/(d.r*0.8), q = qs*qs + ql*ql;
      if (q < 4) off += d.amp * Math.exp(-2.4*q);
    }
    return off;
  }
  defectsInRange(s0, s1){
    const out = [];
    const k0 = Math.max(0, Math.floor((s0-190-62)/275)), k1 = Math.max(0, Math.ceil((s1-190+62)/275));
    for (let k=k0;k<=k1;k++){ const d = this.defectAt(k); if (d.s >= s0-1 && d.s <= s1+1) out.push(d); }
    return out;
  }
  /* Guardrail stretches: deterministic per 140 m block, from s=300 on.
     Cliff blocks get a rail on the cliff side, curve blocks on the outside
     of the bend, plain blocks occasionally. A stretch never fills its
     block — there are always gaps. The rail line sits at |lat| =
     BARRIER_LAT, outside the drivable road plus margin. */
  barrierBlock(b){
    if (this.barrierCache.has(b)) return this.barrierCache.get(b);
    let out = null;
    const b0 = b*140;
    if (b0 >= 300){
      const rng = mulberry32(this.seed*31 + b*104729 + 7);
      const mid = b0 + 70;
      const cz = this.cliffAt(mid), kap = this.kappa(mid);
      let side = 0, prob = 0.15;
      if (cz){ side = cz.side; prob = 0.85; }
      else if (Math.abs(kap) > 0.0035){ side = -Math.sign(kap); prob = 0.6; }
      if (rng() <= prob){
        if (!side) side = rng() < 0.5 ? -1 : 1;
        const s0 = b0 + 12 + rng()*36;
        const s1 = Math.min(b0 + 134, s0 + 55 + rng()*55);
        out = { s0:s0, s1:s1, side:side, lat:side*BARRIER_LAT };
      }
    }
    this.barrierCache.set(b, out);
    if (this.barrierCache.size > 64){ const kk = this.barrierCache.keys().next().value; this.barrierCache.delete(kk); }
    return out;
  }
  barrierStretchesIn(s0, s1){
    const out = [];
    const b0 = Math.max(0, Math.floor(s0/140)), b1 = Math.floor(s1/140);
    for (let b=b0;b<=b1;b++){ const st = this.barrierBlock(b); if (st && st.s1 >= s0 && st.s0 <= s1) out.push(st); }
    return out;
  }
  barrierObstaclesForSegment(seg){
    // the rail as a row of overlapping circles: the penalty-contact system
    // reads it as a wall, so cars cannot clip through it
    const out = [];
    const g0 = seg*50, g1 = g0 + 50;
    for (const st of this.barrierStretchesIn(g0, g1)){
      const a = Math.max(st.s0, g0), b = Math.min(st.s1, g1);
      for (let s = Math.ceil(a/1.2)*1.2; s <= b; s += 1.2){
        const p = this.trackPoint(s), rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
        out.push({ type:'rail', s:s, lat:st.lat, x:p.x+rx*st.lat, z:p.z+rz*st.lat, y:p.y, r:0.25, h:0.8 });
      }
    }
    return out;
  }
  heightAtSL(s, lat){
    const base = this.elev(s), ah = Math.abs(lat);
    if (ah <= ROAD_HALF) return { h:base + this.defectOffset(s, lat), surface:'road' };
    const cz = this.cliffAt(s);
    if (cz && lat*cz.side > 0){
      const d = ah - cz.edge;
      if (d >= 0){
        const floorH = base - cz.drop + (Math.sin(s*0.06+ah*0.4)+Math.sin(s*0.033-ah*0.2))*0.45;
        if (d < 2.5){
          const topH = base + this.hill(s, cz.edge);
          return { h:lerp(topH, floorH, sstep(d/2.5)), surface:'rock' };
        }
        return { h:floorH, surface:'floor' };
      }
    }
    if (ah <= 7.6) return { h:base, surface:'grass' };
    return { h:base + this.hill(s, ah), surface:(this.hill(s,ah) > 6 ? 'rock' : 'grass') };
  }
  nearestTrack(x, z, sHint){
    const out = { s:0, lateral:0, dist:0, index:0 };
    this._nearestTrackInto(x, z, sHint, out);
    return out;
  }
  /* nearestTrack into a caller-owned scratch object: the scan runs
     over the flat sample arrays (identical comparisons and arithmetic
     to the original object version — just cheaper loads, and no
     result allocation in the hot loops) */
  _nearestTrackInto(x, z, sHint, out, win){
    let hint = (sHint===undefined?0:sHint); if (hint < 40) hint = 40;
    const W = win===undefined ? 140 : win;
    this.extendTo(hint+W+20);
    const FX = this._fx, FZ = this._fz;
    let bestD = 1e18, bestI = 0;
    const i0 = Math.max(0, Math.floor((hint-W)/DS)), i1 = Math.min(this.samples.length-1, Math.ceil((hint+W)/DS));
    for (let i=i0;i<=i1;i++){
      const dx = x-FX[i], dz = z-FZ[i], d = dx*dx+dz*dz;
      if (d < bestD){ bestD = d; bestI = i; }
    }
    const bh = this._fh[bestI], bx = FX[bestI], bz = FZ[bestI];
    const fx = Math.sin(bh), fz = Math.cos(bh), rx = Math.cos(bh), rz = -Math.sin(bh);
    const dx = x-bx, dz = z-bz;
    const along = dx*fx + dz*fz, lateral = dx*rx + dz*rz;
    out.s = Math.max(0, this._fs[bestI] + along);
    out.lateral = lateral;
    out.dist = Math.sqrt(bestD);
    out.index = bestI;
  }
  /* numeric twin of heightAtSL().h — the exact same branch math with
     no result object, for groundHeight's gradient taps (which run per
     node per substep). _hAtB takes the elev(s) base from the caller so
     taps that share an s share the elev evaluation too. Keep in sync
     with heightAtSL. */
  _hAt(s, lat){ return this._hAtB(s, lat, this.elev(s)); }
  _hAtB(s, lat, base){
    const ah = Math.abs(lat);
    if (ah <= ROAD_HALF) return base + this.defectOffset(s, lat);
    const cz = this.cliffAt(s);
    if (cz && lat*cz.side > 0){
      const d = ah - cz.edge;
      if (d >= 0){
        const floorH = base - cz.drop + (Math.sin(s*0.06+ah*0.4)+Math.sin(s*0.033-ah*0.2))*0.45;
        if (d < 2.5){
          const topH = base + this.hill(s, cz.edge);
          return lerp(topH, floorH, sstep(d/2.5));
        }
        return floorH;
      }
    }
    if (ah <= 7.6) return base;
    return base + this.hill(s, ah);
  }
  /* the surface half of heightAtSL, branch for branch (keep in sync) */
  _surfaceAt(s, lat){
    const ah = Math.abs(lat);
    if (ah <= ROAD_HALF) return 'road';
    const cz = this.cliffAt(s);
    if (cz && lat*cz.side > 0){
      const d = ah - cz.edge;
      if (d >= 0) return d < 2.5 ? 'rock' : 'floor';
    }
    if (ah <= 7.6) return 'grass';
    return this.hill(s, ah) > 6 ? 'rock' : 'grass';
  }
  /* height-ONLY ground query (v2.6 optimisation): the centre tap of
     _groundHeightInto without the gradient taps, surface, or normal.
     The collision pass needs the full query only for the handful of
     nodes actually penetrating the ground in a substep; every other
     node needs just the height (for the penetration test itself and
     the obstacle height gate), and the height computed here is the
     identical float the full query computes for its centre tap —
     same nearest-track scan, same elev, same _hAtB call. */
  _groundHOnly(x, z, sHint, win){
    const nt = this._ntS || (this._ntS = { s:0, lateral:0, dist:0, index:0 });
    this._nearestTrackInto(x, z, sHint, nt, win);
    return this._hAtB(nt.s, nt.lateral, this.elev(nt.s));
  }
  /* groundHeight into caller-owned scratch objects (the hot loops
     reuse one pair per substep instead of allocating two objects per
     node per substep). groundHeight() below is the allocating
     convenience wrapper over this — one implementation, no drift. */
  _groundHeightInto(x, z, sHint, out, outN, win){
    const nt = this._ntS || (this._ntS = { s:0, lateral:0, dist:0, index:0 });
    this._nearestTrackInto(x, z, sHint, nt, win);
    const baseC = this.elev(nt.s);
    const hC = this._hAtB(nt.s, nt.lateral, baseC);
    // gradient in track frame -> slope + world normal. The two lateral
    // taps share the centre tap's elev base; only the s taps need
    // their own — 3 elev evaluations per call instead of 5.
    const e = 1.2;
    const dS = (this._hAtB(nt.s+e, nt.lateral, this.elev(nt.s+e)) - this._hAtB(nt.s-e, nt.lateral, this.elev(nt.s-e)))/(2*e);
    const dL = (this._hAtB(nt.s, nt.lateral+e, baseC) - this._hAtB(nt.s, nt.lateral-e, baseC))/(2*e);
    // heading at nt.s: the same lerp trackPoint performs, read off
    // the flat sample arrays instead of allocating a track point
    this.extendTo(nt.s + DS);
    const ii = Math.floor(nt.s/DS), fh = this._fh;
    const tt = (nt.s - ii*DS)/DS;
    const hb = fh[ii+1]===undefined ? fh[ii] : fh[ii+1];
    const heading = fh[ii] + (hb - fh[ii])*tt;
    const fx = Math.sin(heading), fz = Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
    let nx = -(fx*dS + rx*dL), nz = -(fz*dS + rz*dL), ny = 1;
    const il = 1/Math.sqrt(nx*nx+ny*ny+nz*nz); nx*=il; ny*=il; nz*=il;
    const grad = Math.sqrt(dS*dS + dL*dL);
    out.h = hC; out.surface = this._surfaceAt(nt.s, nt.lateral); out.slope = Math.atan(grad);
    out.s = nt.s; out.lateral = nt.lateral;
    outN.x = nx; outN.y = ny; outN.z = nz;
  }
  groundHeight(x, z, sHint){
    const out = { h:0, surface:'road', slope:0, s:0, lateral:0, normal:{x:0, y:1, z:0} };
    this._groundHeightInto(x, z, sHint, out, out.normal);
    return out;
  }
  obstaclesForSegment(seg){
    if (this.obsCache.has(seg)) return this.obsCache.get(seg);
    const rng = mulberry32(this.seed*7919 + seg*104729 + 13);
    const out = [];
    const nT = 5 + Math.floor(rng()*3);
    for (let j=0;j<nT;j++){
      const s = seg*50 + rng()*50, side = rng()<0.5?-1:1;
      const lat = side*(9 + rng()*36);
      const p = this.trackPoint(s), rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
      out.push({ type:'tree', s:s, lat:lat, x:p.x+rx*lat, z:p.z+rz*lat, y:p.y, r:0.45, h:3.4 });
    }
    const nR = 2 + Math.floor(rng()*2);
    for (let j=0;j<nR;j++){
      const s = seg*50 + rng()*50, side = rng()<0.5?-1:1;
      const nearEdge = rng() < 0.35;
      const lat = side*(nearEdge ? (6.2+rng()*2.4) : (10+rng()*30));
      const p = this.trackPoint(s), rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
      const r = 0.7 + rng()*0.9;
      out.push({ type:'rock', s:s, lat:lat, x:p.x+rx*lat, z:p.z+rz*lat, y:p.y, r:r, h:r*1.1 });
    }
    // barrier posts along a cliff edge, with gaps
    const cz = this.cliffAt(seg*50+25);
    if (cz && seg*50+50 > cz.s0 && seg*50 < cz.s1){
      for (let j=0;j<5;j++){
        if (rng() < 0.3) continue; // the gap
        const s = seg*50 + j*10 + 2, lat = cz.side*(CLIFF_EDGE-0.7);
        const p = this.trackPoint(s), rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
        out.push({ type:'post', s:s, lat:lat, x:p.x+rx*lat, z:p.z+rz*lat, y:p.y, r:0.32, h:1.0 });
      }
    }
    this.obsCache.set(seg, out);
    if (this.obsCache.size > 400){ const k = this.obsCache.keys().next().value; this.obsCache.delete(k); }
    return out;
  }
  getObstacles(x, z, sHint){
    const nt = this.nearestTrack(x, z, sHint);
    const seg = Math.floor(nt.s/50), out = [];
    for (let g=seg-2; g<=seg+2; g++){
      if (g < 0) continue;
      for (const o of this.obstaclesForSegment(g)){
        const dx = o.x-x, dz = o.z-z;
        if (dx*dx+dz*dz < 3600) out.push(o);
      }
      for (const o of this.barrierObstaclesForSegment(g)){
        const dx = o.x-x, dz = o.z-z;
        if (dx*dx+dz*dz < 3600) out.push(o);
      }
    }
    for (const o of this.extraObstacles){
      const dx = o.x-x, dz = o.z-z;
      if (dx*dx+dz*dz < 3600) out.push(o);
    }
    return out;
  }
}

/* ---------------- Beams ---------------- */
class Beam {
  constructor(a, b, rest, opts){
    this.a = a; this.b = b; this.rest = rest; this.currentRest = rest;
    this.k = opts.k; this.c = opts.c||0;
    // strain floors in absolute terms: a very short beam reaches a given
    // strain from a tiny displacement, so its thresholds are raised to need
    // at least ~4.5 cm of yield / ~9 cm of break displacement
    this.deformStrain = Math.max((opts.deformStrain!==undefined?opts.deformStrain:0.07), 0.045/rest);
    this.breakStrain = Math.max((opts.breakStrain!==undefined?opts.breakStrain:0.4), 0.09/rest);
    // elastic limits, both measured against the ORIGINAL rest length (the
    // same convention checkDeform uses for its thresholds):
    //  - maxPlastic caps how far the yielded rest length may ever travel:
    //    a crushed zone stops folding once it has given up 70% of the
    //    displacement that would break it, and from there it only springs.
    //  - maxDisp is the break-referenced displacement bound
    //    (breakStrain x rest). The POSITIONAL clamp in
    //    SoftBodyCar.enforceBeamLimits uses the capped clampDisp
    //    below, not this — see there.
    this.maxPlastic = 0.7 * this.breakStrain * rest * (opts.plasticScale===undefined ? 1 : opts.plasticScale);
    this.maxDisp = this.breakStrain * rest;
    // v2.7.1 clamp cap: clampDisp = min(breakStrain, 0.55) x rest.
    // breakStrain is floored at 0.09/rest so a short beam needs ~9 cm
    // of displacement to BREAK — sound for breaking, but as the
    // clamp bound it let a 10 cm beam sit at 1.9x rest and compress
    // to 0.07x (measured, sedan @500 wall crash: peak tensile 1.73x,
    // peak compressive 0.093x on rest ~0.097 m crumple beams whose
    // floored breakStrain is ~0.92 against a 0.32 material value),
    // and it left support beams (breakStrain 50, deliberately
    // unbreakable, tension-silent) with NO displacement limit at
    // all — measured settled at 1.91x rest in the same wreck,
    // tethering torn structure on invisible unbreakable lines. The
    // cap bounds every unbroken beam positionally to [0.45, 1.55]x
    // rest; beams whose material break strain is below the cap
    // (bumper 0.16, crumple 0.32, panel 0.45, and every long beam
    // whose floor never engages) keep exactly their old bound.
    this.clampDisp = Math.min(this.breakStrain, 0.55) * rest;
    this.suspension = !!opts.suspension;
    this.broken = false; this.deformed = false; this.maxStrain = 0;
    // zone material name (see MATERIALS) and the live stress readout:
    // |elastic strain| relative to this beam's material yield strain,
    // refreshed every beam-force evaluation (1.0 = at yield). The B
    // skeleton view colours by it; test 27 checks the zone behaviour.
    this.mat = opts.mat || null;
    this.stress = 0;
    // v2.6 beam kinds (adapted from BeamNG.drive's documented JBeam
    // mechanics — see README): 'normal' is the plain spring-damper.
    // 'support' is a compression-only slack limiter: it exerts NO
    // spring force while L >= engageLen (= rest x engage, engage < 1)
    // and acts as a stiff spring-damper in compression only below
    // that — it can never pull in tension, so it forbids inverted /
    // folded configurations without adding any parked stiffness.
    this.kind = opts.kind || 'normal';
    this.engage = opts.engage || 1;
    this.engageLen = rest * this.engage;
    this.engage2 = this.engageLen * this.engageLen;
    // pressured-beam term (BeamNG PRESSURED idea, simplified): an
    // extra outward force Fp * min(1, currentRest/L - 1) while
    // compressed — progressive like air pressure (force grows as
    // 1/L), capped at Fp so it can never reach the 1/L singularity.
    // 0 = no pressure term. Used on the strut beams (item C).
    this.pressure = opts.pressure || 0;
    // cached derived limits (rest/deform/break never change after
    // construction): the hot loops read these instead of re-multiplying
    this.yieldDisp = this.deformStrain * rest;
    this.hiDisp = rest + this.clampDisp;
    this.loDisp = rest - this.clampDisp;
    this.hi2 = this.hiDisp * this.hiDisp;
    this.lo2 = this.loDisp * this.loDisp;
  }
  length(nodes){
    const A = nodes[this.a], B = nodes[this.b];
    const dx = B.pos.x-A.pos.x, dy = B.pos.y-A.pos.y, dz = B.pos.z-A.pos.z;
    return Math.sqrt(dx*dx+dy*dy+dz*dz);
  }
  strain(nodes){ return (this.length(nodes) - this.rest)/this.rest; }
  // plastic deform + break bookkeeping for the current length; returns strain.
  // Both thresholds are measured against the ORIGINAL rest length: if they
  // were measured against the yielded rest length, a crushing beam would
  // yield forever and never break, and rebound would "heal" the crush.
  // Lpre: the caller (addBeamForces) may pass the length it just measured —
  // the identical float, no recompute.
  checkDeform(nodes, dt, Lpre){
    if (this.broken) return 0;
    const L = Lpre===undefined ? this.length(nodes) : Lpre, st = (L - this.rest)/this.rest, ast = Math.abs(st);
    if (ast > this.breakStrain){ this.broken = true; return st; }
    if (ast > this.deformStrain && ast > this.maxStrain){
      // yield with max-strain memory: the rest length follows only when the
      // beam is strained further than it has EVER been. Without the memory,
      // the elastic bounce after a crash pulls crushed beams back past the
      // yield point in tension and the crush visibly "heals" itself.
      this.maxStrain = ast;
      this.deformed = true;
      // the yielded rest length follows the crush, but only up to the
      // plastic cap: without the cap a beam yields indefinitely and the
      // cage folds to nothing; capped, the zone stops collapsing and the
      // remaining displacement is elastic (and progressively stiffened in
      // addBeamForces), so the structure holds together with real strength
      const newRest = L - Math.sign(st)*this.deformStrain*this.rest;
      this.currentRest = Math.min(this.rest + this.maxPlastic,
                                  Math.max(this.rest - this.maxPlastic, newRest));
    }
    return st;
  }
}

/* ---------------- Beam force law (v2.6) ----------------
   One axial force evaluation, shared by the hot loop and the unit
   tests. L = current length, rel = dL/dt (relative velocity along
   the axis, positive = separating). Returns the scalar force f with
   the loop's sign convention: Ft[a] += u*f, Ft[b] -= u*f, u = a->b
   unit vector — so f > 0 pulls the pair together (tension) and
   f < 0 pushes them apart (compression).
   Damping is BAND-LIMITED (BeamNG's dampCutoffHz idea): the raw
   damping force c*rel is passed through a first-order low-pass
   whose state lives in the caller's per-beam typed array
   (dampArr[idx]); alpha is the dt-aware coefficient for the current
   substep. Instantaneous damping force at 480 Hz on stiff beams is
   mostly step-to-step noise; the filter removes the noise while
   passing real damper motion (cutoff ~90 Hz >> the ~3 Hz shell
   modes and ~10-15 Hz wheel hop), which is what lets the
   high-damping zones keep their damping without jitter. An impact
   bypass (DAMP_SNAP_N) keeps the filter from delaying real crash
   forces: noise is filtered, impacts are not. */
const DAMP_CUTOFF_HZ = 60;
/* Impact bypass for the damping filter: if the raw damping force
   jumps more than this far from the filtered state in one step, the
   state snaps straight to the raw value. Band-limiting exists to
   reject step-rate NOISE (small, alternating, sub-kN); a crash is
   the opposite signal — large and sustained — and delaying crash
   damping by even a few steps measurably deepens the crush
   (measured: 100 km/h compression 1.38 m with a pure filter vs
   1.12 m unfiltered). 2.5 kN sits between the two regimes for
   every beam class in the fleet. */
const DAMP_SNAP_N = 2500;
function dampAlpha(cutoffHz, dt){
  return 1 - Math.exp(-2*Math.PI*cutoffHz*dt);
}
function dampFilterStep(df, fd, alpha){
  const diff = fd - df;
  return Math.abs(diff) > DAMP_SNAP_N ? fd : df + alpha*diff;
}
function beamAxialForce(b, L, rel, alpha, dampArr, idx){
  if (b.kind === 'support'){
    // slack above the engagement length: identically zero force —
    // the caller early-outs on the squared length before the sqrt,
    // so this branch is only reached while actually engaged
    if (L >= b.engageLen){ dampArr[idx] = 0; return 0; }
    const pen = b.engageLen - L;
    const fd = b.c * rel;
    const df = dampFilterStep(dampArr[idx], fd, alpha);
    dampArr[idx] = df;
    const f = -b.k * pen + df;
    // compression only: the damper may resist separation while the
    // beam is engaged, but the total may never pull in tension
    return f < 0 ? f : 0;
  }
  const disp = L - b.currentRest;
  let f = b.k * disp;
  const adisp = Math.abs(disp);
  // progressive stiffening past yield (see the loop's old comment):
  // +1x rate on the excess, symmetric both ways
  if (adisp > b.yieldDisp) f += (disp < 0 ? -1 : 1) * b.k * (adisp - b.yieldDisp);
  // v2.7.1 tension strain-stiffening, measured against the ORIGINAL
  // rest length (the break/clamp convention): past 1.30x rest an
  // extra +2x k on the excess, so a beam being torn toward its
  // displacement clamp decelerates the separation progressively
  // instead of riding the clamp at full stretch (measured v2.7
  // transient peaks: 1.73x @500, 1.64x on muscle @820 — all on
  // beams whose floored break strain let the clamp sit at 1.8-1.9x).
  // Tension only: the compression law — including the pressured-
  // strut numbers the unit tests pin at 0.8x/0.5x — is unchanged,
  // and below 1.30x this term is identically zero.
  const over = L - b.rest * 1.3;
  if (over > 0) f += b.k * over * 2;
  // pressured term: progressive outward push while compressed.
  // Asymmetric by direction (the same compression/rebound split
  // BeamNG documents for its dampers): full force while the beam
  // is shortening, 35% while it extends back — a symmetric pressure
  // spring returns almost all the energy it absorbed and measurably
  // fed the suspension's second bounce (pickup drop test: second
  // bounce 31% of first without pressure, 42% with a symmetric
  // term; the parked benefit needs only the static force, which
  // sits at rel ~ 0 on the full-force side).
  if (b.pressure > 0 && disp < 0){
    const ratio = b.currentRest/L - 1;
    let pf = b.pressure * (ratio < 1 ? ratio : 1);
    if (rel > 0) pf *= 0.35;
    f -= pf;
  }
  const fd = b.c * rel;
  const df = dampFilterStep(dampArr[idx], fd, alpha);
  dampArr[idx] = df;
  f += df;
  return f;
}

/* ---------------- Zone materials ----------------
   Simplified per-zone materials, assigned to every cage beam at build
   time by zoneFor() from the beam's position in the car (section
   z-fraction + ring height). Real-car ordering: the cabin safety cell
   and the frame (floor, sills, rails — the strong spine) are by far
   the strongest; door/roof/hood panels are medium-weak skins; the
   front/rear crumple zones are soft in rate and yield early so they
   fold progressively and absorb the crash — that is what keeps
   test 2's 100 km/h compression up while the frame and cabin stay
   essentially undeformed in a moderate hit. Bumpers are the softest
   of all. The global mechanisms (progressive stiffening past yield,
   the plastic cap, the hard displacement limit) all scale off these
   per-material values, so they keep working per zone unchanged.
   v2.4 retune (issue: "wet sponge" — the whole car accordioned in a
   hard hit): panels break much less readily again (0.32 -> 0.45),
   frame/cabin plastic travel is cut hard (0.50/0.40 -> 0.28/0.25, so
   the strong zones stop telescoping once yielded), the crumple
   yield strain rises (0.06 -> 0.10, so a gap pushes back harder
   before it folds) and its break strain rises too (0.26 -> 0.32, so
   a folding rail keeps resisting longer before it tears) — with
   frame break rising in step (0.60 -> 0.68) so the designed order
   "frame/cabin tear at >= 2x the crumple strain" still holds. And
   addBeam applies a staged gradient inside the crumple zone
   (softest at the tip, strongest at the cabin edge) so the crush
   localises at the ends instead of every section gap yielding at
   once. Frame/cabin kScales move only +0.03 — the v2.3 lesson
   stands: their strength is strains and structure, not rate. */
const MATERIALS = {
  bumper:     { kScale:0.26, deform:0.07, break:0.16, plastic:1.00 },
  crumple:    { kScale:0.33, deform:0.10, break:0.32, plastic:0.75 },
  panel:      { kScale:0.75, deform:0.08, break:0.45, plastic:0.70 },
  frame:      { kScale:1.05, deform:0.22, break:0.68, plastic:0.28 },
  cabin:      { kScale:1.08, deform:0.20, break:0.68, plastic:0.25 },
  suspension: { kScale:1.00, deform:0.30, break:0.75, plastic:1.00 }
};
/* zone of a beam from its endpoints' REST positions:
   - |z| beyond 30% of the half-length at either end: crumple (front /
     rear), except mostly-vertical beams — those are the overhangs'
     posts; they carry the nose/tail weight, not the crush, so they
     stay panels (softening them just droops the overhangs).
   - low structure (bottom ~38% of the ring height): FRAME.
   - cabin band: high beams, or pillar diagonals spanning low->high,
     within the middle of the car: CABIN.
   - everything else: PANELS. */
function zoneFor(A, B, def){
  const L = def.length;
  const za = A.z/L, zb = B.z/L, zm = (za + zb)*0.5;
  const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
  const d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
  if (Math.abs(dy)/d >= 0.5) return 'panel';
  if (Math.abs(zm) > 0.30) return 'crumple';
  const rb = def.rideBoost || 0;
  const pa = profileAt(def, za), pb = profileAt(def, zb);
  const ha = clamp((A.y - (pa.yLow + rb))/Math.max(0.05, pa.yTop - pa.yLow - rb), 0, 1);
  const hb = clamp((B.y - (pb.yLow + rb))/Math.max(0.05, pb.yTop - pb.yLow - rb), 0, 1);
  const hmax = Math.max(ha, hb), hmin = Math.min(ha, hb);
  if (hmax <= 0.38) return 'frame';
  if (Math.abs(zm) <= 0.34 && (hmin >= 0.55 || (hmax >= 0.85 && hmin <= 0.35))) return 'cabin';
  return 'panel';
}

/* ---------------- Tires ----------------
   Each wheel carries a temperature. Slip power heats it (lateral slip
   speed plus a longitudinal slip proxy, weighted by how hard the tire
   is working); it cools toward ambient exponentially. The grip factor
   multiplies the surface mu (road 1.05 / grass 0.62 / rock 0.45) and
   the car's own tireMu: cold tires give ~0.85x, the optimal window
   (55 C and up) gives full grip, and past ~100 C the compound fades
   toward 0.90x. At optimal temperature grip is exactly what it was
   before tires had temperatures. */
const TIRE_AMBIENT = 20;
function tireGripFactor(T){
  let g = 0.85 + 0.15*sstep((T - TIRE_AMBIENT)/35);
  g *= 1 - 0.10*sstep((T - 100)/30);
  return g;
}

/* ---------------- Car definitions ---------------- */
/* sections: z as fraction of length (+ = front), hw = half-width factor,
   yLow / yMid / yTop = node heights (m) in rest pose */
function stdSections(hoodTop, cabTop, rearTop){
  return [
    { z: 0.50, hw:0.94, yLow:0.42, yMid:0.62, yTop:hoodTop },
    { z: 0.17, hw:1.00, yLow:0.40, yMid:0.66, yTop:cabTop },
    { z:-0.17, hw:1.00, yLow:0.40, yMid:0.66, yTop:cabTop },
    { z:-0.50, hw:0.94, yLow:0.44, yMid:0.64, yTop:rearTop }
  ];
}
const CAR_DEFS = [
  { id:'sedan', name:'Sedan', blurb:'Balanced family sedan. Front-wheel drive, forgiving, tough cage.',
    color:0xc23b2e, accent:0x222222, length:4.6, width:1.82, mass:1320, drive:'FWD',
    power:135000, engineForce:9800, drag:0.0019, stiff:272000, suspK:43000, suspDamp:3200,
    tireMu:1.00, tireHeat:2.0, tireCool:0.020,
    wheelBase:0.60, trackW:0.86, wheelR:0.33, sections:stdSections(0.86,1.42,0.92), topKmh:196 },
  { id:'pickup', name:'Pickup', blurb:'Tall, heavy work truck with a real bed. Rear-wheel drive, soft springs.',
    color:0x3f6fb5, accent:0xdddddd, length:5.2, width:1.98, mass:1980, drive:'RWD',
    power:190000, engineForce:14200, drag:0.0026, stiff:264000, suspK:49000, suspDamp:3700,
    tireMu:0.97, tireHeat:1.7, tireCool:0.018, rideBoost:0.06, topMassScale:0.65, arbScale:1.25,
    wheelBase:0.62, trackW:0.88, wheelR:0.37, sections:stdSections(1.02,1.78,1.05), topKmh:178 },
  { id:'coupe', name:'Sports Coupe', blurb:'Low, wide and stiff. Rear-wheel drive, fast, crumples less — and hurts more.',
    color:0xf2b134, accent:0x181818, length:4.4, width:1.92, mass:1240, drive:'RWD',
    power:265000, engineForce:11800, drag:0.0014, stiff:368000, suspK:54000, suspDamp:4200,
    tireMu:1.08, tireHeat:2.6, tireCool:0.024,
    wheelBase:0.60, trackW:0.90, wheelR:0.32, sections:stdSections(0.78,1.22,0.80), topKmh:228 },
  { id:'suv', name:'SUV', blurb:'Tall and heavy, soft suspension, lots of roof to bend. Four-wheel drive.',
    color:0x5f8f5a, accent:0x2b2b2b, length:4.8, width:1.94, mass:1860, drive:'4WD',
    power:175000, engineForce:12800, drag:0.0025, stiff:240000, suspK:46000, suspDamp:3250,
    tireMu:0.98, tireHeat:1.8, tireCool:0.018, rideBoost:0.05, topMassScale:0.42, arbScale:1.7,
    wheelBase:0.60, trackW:0.88, wheelR:0.36, sections:stdSections(0.98,1.78,1.76), topKmh:184 },
  { id:'muscle', name:'Muscle Car', blurb:'Long hood, heavy nose, big power. Rear-wheel drive, loves a straight line.',
    color:0x74348f, accent:0xf0f0f0, length:4.95, width:1.90, mass:1620, drive:'RWD',
    power:235000, engineForce:13800, drag:0.0021, stiff:296000, suspK:45000, suspDamp:3450,
    tireMu:1.02, tireHeat:2.3, tireCool:0.022,
    wheelBase:0.58, trackW:0.87, wheelR:0.34, sections:stdSections(0.88,1.34,0.86), topKmh:214 }
];

/* ---------------- Beam resolution: node-target grid cage ----------------
   The cage is a REGULAR grid: S sections evenly spaced along the car, each
   a ring of P nodes evenly spaced by arc length around a rounded-rect
   cross-section whose size comes from interpolating the car's own 4-point
   profile (hw / yLow / yMid / yTop) at that z. Beams are structured only —
   ring beams, longitudinal beams, one alternating diagonal per panel quad
   — plus fixed extras: bumper rails, strut-mount links, suspension links.
   The per-car setting is a target NODE count:
   total nodes = S*P + 10 (the +10 = 2 bumpers + 4 mounts + 4 wheels). */
const RES_TARGET_DEFAULT = 150;
function resNameFor(target){
  if (target <= 150) return 'NORMAL';
  if (target <= 250) return 'HIGH';
  if (target <= 500) return 'ULTRA';
  return 'ULTRA+';
}
function profileAt(def, zf){
  const pts = def.sections;
  if (zf >= pts[0].z) return pts[0];
  const last = pts[pts.length-1];
  if (zf <= last.z) return last;
  for (let i=0;i<pts.length-1;i++){
    const a = pts[i], b = pts[i+1];
    if (zf <= a.z && zf >= b.z){
      const t = (a.z - zf)/(a.z - b.z);
      return { z:zf, hw:lerp(a.hw,b.hw,t), yLow:lerp(a.yLow,b.yLow,t),
               yMid:lerp(a.yMid,b.yMid,t), yTop:lerp(a.yTop,b.yTop,t) };
    }
  }
  return last;
}
function chooseGrid(target){
  const want = Math.max(16, target - 10);
  let best = null;
  for (const P of [8,10,12,14,16,18,20]){
    for (let S=3; S<=60; S++){
      const err = Math.abs(S*P - want);
      if (!best || err < best.err || (err === best.err && S > best.S)) best = { S:S, P:P, err:err };
    }
  }
  return best;
}
/* P points evenly spaced by arc length around a rounded-rect cross-section
   (bottom half-width hwB at yLow, top half-width hwT at yTop). Point 0 is
   the bottom-centre; the walk heads up the +x side first, so with even P
   the ring is mirror-symmetric and point P/2 is the top-centre. */
function ringPoints(P, hwB, hwT, yLow, yTop){
  const r = Math.min(0.13, (yTop-yLow)*0.32, hwB*0.4);
  const V = [[hwB,yLow],[hwT,yTop],[-hwT,yTop],[-hwB,yLow]];
  const E = [], X = [];
  for (let i=0;i<4;i++){
    const prev = V[(i+3)%4], cur = V[i], next = V[(i+1)%4];
    const dIn = Math.hypot(cur[0]-prev[0], cur[1]-prev[1]) || 1;
    const dOut = Math.hypot(next[0]-cur[0], next[1]-cur[1]) || 1;
    const rr = Math.max(0.015, Math.min(r, dIn*0.45, dOut*0.45));
    E.push([cur[0]-(cur[0]-prev[0])/dIn*rr, cur[1]-(cur[1]-prev[1])/dIn*rr]);
    X.push([cur[0]+(next[0]-cur[0])/dOut*rr, cur[1]+(next[1]-cur[1])/dOut*rr]);
  }
  const dense = [];
  for (let i=0;i<4;i++){
    const a = X[i], b = E[(i+1)%4], c = V[(i+1)%4], d = X[(i+1)%4];
    const lineLen = Math.hypot(b[0]-a[0], b[1]-a[1]);
    const nl = Math.max(1, Math.ceil(lineLen/0.03));
    for (let k=0;k<nl;k++){ const t = k/nl; dense.push([lerp(a[0],b[0],t), lerp(a[1],b[1],t)]); }
    const bezLen = Math.hypot(c[0]-b[0], c[1]-b[1]) + Math.hypot(d[0]-c[0], d[1]-c[1]);
    const nb = Math.max(2, Math.ceil(bezLen/0.03));
    for (let k=0;k<nb;k++){
      const t = k/nb, u = 1-t;
      dense.push([u*u*b[0]+2*u*t*c[0]+t*t*d[0], u*u*b[1]+2*u*t*c[1]+t*t*d[1]]);
    }
  }
  const cum = [0];
  for (let i=1;i<=dense.length;i++){
    const a = dense[i-1], b = dense[i%dense.length];
    cum.push(cum[i-1] + Math.hypot(b[0]-a[0], b[1]-a[1]));
  }
  const total = cum[dense.length];
  // arc position of the bottom-centre (0, yLow): it lies on the bottom edge
  let s0 = 0, bestD = 1e9, found = false;
  for (let i=0;i<dense.length;i++){
    const a = dense[i], b = dense[(i+1)%dense.length];
    if (Math.abs(a[1]-yLow) < 1e-6 && Math.abs(b[1]-yLow) < 1e-6 && a[0] <= 0 && b[0] >= 0){
      const t = (0 - a[0])/((b[0]-a[0]) || 1);
      s0 = cum[i] + t*(cum[i+1]-cum[i]); found = true; break;
    }
    const dd = Math.hypot(a[0], a[1]-yLow);
    if (dd < bestD){ bestD = dd; s0 = cum[i]; }
  }
  const out = [];
  for (let j=0;j<P;j++){
    const s = (s0 + total*j/P) % total;
    let i = 0;
    while (i < dense.length-1 && cum[i+1] < s) i++;
    const segLen = (cum[i+1]-cum[i]) || 1;
    const t = clamp((s - cum[i])/segLen, 0, 1);
    const a = dense[i], b = dense[(i+1)%dense.length];
    out.push([lerp(a[0],b[0],t), lerp(a[1],b[1],t)]);
  }
  return out;
}
/* per-car target node count, parallel to CAR_DEFS (default Normal = 150).
   The game persists this in localStorage; tests set it directly. */
const carRes = CAR_DEFS.map(()=>RES_TARGET_DEFAULT);
/* v2.6: support-beam build switch (test 38 builds a car with the
   limiters disabled to measure what they do). Game code never
   touches this; per-car opt-out is SoftBodyCar's opts.noSupports. */
const supportOpt = { enabled:true };
/* v2.7: self-collision build switch (test 42 builds a car with the
   pass disabled to prove the clip scenario discriminates). Game code
   never touches this; per-car opt-out is SoftBodyCar's opts.noSelfColl. */
const selfCollOpt = { enabled:true };
/* Self-collision layer/group ids (v2.7): every chassis node belongs
   to exactly one group, assigned at build from its rest position —
   the section band along the car (front clip / cabin band / rear
   clip) and, inside the cabin band, its height band and side. The
   groups are the "layers" of the requirement: nodes of different
   parts of the shell may not pass through each other. Wheels are
   their own group and stay out of the self-collision set (a wheel
   is a single node; its strut and links locate it). */
const SC_GROUPS = { FLOOR:0, LEFT:1, RIGHT:2, ROOF:3, FRONT:4, REAR:5, CABIN:6, WHEEL:7 };
/* Self-collision broadphase grid cap (cells) and the 13 forward
   neighbour offsets (lexicographic half-neighbourhood on (z,y,x))
   that make every unordered cell pair be visited exactly once. */
const SC_GRID_MAX = 65536;
const SC_FWD = [[1,0,0],[-1,1,0],[0,1,0],[1,1,0],[-1,-1,1],[0,-1,1],[1,-1,1],[-1,0,1],[0,0,1],[1,0,1],[-1,1,1],[0,1,1],[1,1,1]];

/* ---------------- Soft-body car ---------------- */
class SoftBodyCar {
  constructor(def, world, targetNodes, opts){
    this.def = def; this.world = world;
    this.targetNodes = (targetNodes===undefined ? RES_TARGET_DEFAULT : targetNodes);
    this.noSupports = !!(opts && opts.noSupports);
    this.noSelfColl = !!(opts && opts.noSelfColl);
    // CageData hook (v2.7, for JBeam import): when opts.cage is
    // present, buildStructure builds the car from the cage instead
    // of the procedural grid — see buildCageStructure. triangles is
    // stored for later node-vs-triangle work (no collision yet).
    this.cageData = (opts && opts.cage) || null;
    this.triangles = [];
    this._cageWheelR = null;
    this.buildStructure();
    // band-limited damping state: one filtered-force slot per beam
    // (see beamAxialForce). Zeroed here and on repair().
    this._dampF = new Float64Array(this.beams.length);
    this.supportCount = 0;
    for (const b of this.beams) if (b.kind === 'support') this.supportCount++;
    // direct node refs per beam: the hot loops (beam forces, beam
    // limits) index through these instead of nodes[b.a] / nodes[b.b]
    for (const b of this.beams){ b.nA = this.nodes[b.a]; b.nB = this.nodes[b.b]; }
    // flat per-beam caches for the hot loops (v2.6 optimisation):
    // beam scalar fields that never change after the build (k, c,
    // yield displacement, pressure, engagement geometry, limit
    // squares) plus the force-buffer offsets and the node pos/vel
    // object refs (node pos/vel objects are mutated in place
    // everywhere in the sim, never replaced) are copied into flat
    // arrays once, so addBeamForces / enforceBeamLimits read array
    // slots instead of chasing beam->node->pos property chains at
    // ~100k evaluations per frame. The mutable state (currentRest,
    // broken, deformed, stress) stays on the Beam objects, which
    // checkDeform / repair() own. The gravity template lets the
    // flat force buffer be refilled with one typed-array copy.
    {
      const nb = this.beams.length;
      const bk = new Float64Array(nb), bc = new Float64Array(nb),
            byd = new Float64Array(nb), bpr = new Float64Array(nb),
            bre = new Float64Array(nb),
            beL = new Float64Array(nb), be2 = new Float64Array(nb),
            bhi = new Float64Array(nb), blo = new Float64Array(nb),
            bsup = new Uint8Array(nb), bfil = new Uint8Array(nb),
            bfa = new Int32Array(nb), bfb = new Int32Array(nb),
            bpA = new Array(nb), bvA = new Array(nb),
            bpB = new Array(nb), bvB = new Array(nb);
      for (let i=0;i<nb;i++){
        const b = this.beams[i];
        bk[i] = b.k; bc[i] = b.c; byd[i] = b.yieldDisp; bpr[i] = b.pressure;
        bre[i] = b.rest;
        beL[i] = b.engageLen; be2[i] = b.engage2; bhi[i] = b.hi2; blo[i] = b.lo2;
        bsup[i] = b.kind === 'support' ? 1 : 0;
        // band-limit scoping (v2.6 optimisation): the damping filter
        // runs in the hot loop only on the high-damping beams —
        // c >= 1000 N.s/m, which in this fleet is exactly the four
        // strut dampers (per-car suspDamp 3200-4200; every other
        // beam's c is zeta-scaled and tops out near 600). Those are
        // the dampers whose raw force is large enough to carry the
        // step-rate noise the filter exists to reject, and whose
        // filtering the wobble/suspension behaviour is tuned on;
        // the remaining beams take their raw damping force (their
        // filter state is still written, = the raw force, so the
        // state stays coherent). beamAxialForce — the standalone
        // law the unit tests pin — is NOT scoped; this is a
        // loop-level change only.
        bfil[i] = b.c >= 1000 ? 1 : 0;
        bfa[i] = b.a*3; bfb[i] = b.b*3;
        bpA[i] = b.nA.pos; bvA[i] = b.nA.vel; bpB[i] = b.nB.pos; bvB[i] = b.nB.vel;
      }
      this._bk = bk; this._bc = bc; this._byd = byd; this._bpr = bpr;
      this._brest = bre;
      this._beL = beL; this._be2 = be2; this._bhi2 = bhi; this._blo2 = blo;
      this._bsup = bsup; this._bfil = bfil; this._bfa = bfa; this._bfb = bfb;
      this._bpA = bpA; this._bvA = bvA; this._bpB = bpB; this._bvB = bvB;
      const grav = new Float64Array(this.nodes.length*3);
      for (let i=0;i<this.nodes.length;i++) grav[i*3+1] = -9.81*this.nodes[i].mass;
      this._gravF = grav;
    }
    // self-collision tables (groups, radii, 2-hop mask, broadphase
    // buffers) — built once, see buildSelfCollision
    this.buildSelfCollision();
    // beam subcycle count for this cage (used in substep). v2.5: the
    // schedule is 2 at every target above Normal — v2.4 ran 3 past 500
    // nodes, which cost ~50% more beam evaluations than 2 for margin
    // the fleet mostly does not need — raised back to 3 only when the
    // built cage's stiffest NODAL frequency says 2 runs too close to
    // the explicit-integration edge. The nodal frequency of a node is
    // sqrt(sum of its beams' rates / its mass); the guard trips at
    // omega*h/sub > 1.9 (h = 1/480). Measured on the fleet: every
    // cell that is stable at 2 sits at <= ~1.77, and the one cell
    // that shook itself apart parked at 2 (the SUV at 1000 nodes —
    // the lightest roof nodes in the fleet) measures 2.03. Beam
    // rates never change after the build, so the build-time value
    // bounds the car's whole life (broken beams only remove
    // stiffness).
    {
      const sumK = new Float64Array(this.nodes.length);
      // support beams are excluded: they are slack in every normal
      // configuration, so they contribute nothing to the cage's
      // standing nodal frequencies — counting them would raise the
      // subcycle (and the beam-eval cost) for stiffness that only
      // exists transiently inside a crash fold
      for (const b of this.beams){ if (b.kind === 'support') continue; sumK[b.a] += b.k; sumK[b.b] += b.k; }
      let wMax = 0;
      for (let i=0;i<this.nodes.length;i++){
        const w = Math.sqrt(sumK[i]/this.nodes[i].mass);
        if (w > wMax) wMax = w;
      }
      let n2 = this.targetNodes > RES_TARGET_DEFAULT ? 2 : 1;
      while (n2 < 3 && wMax*(1/480)/n2 > 1.9) n2++;
      this.sub2N = n2;
    }
    this.steerAngle = 0; this.sHint = 100; this.distance = 0;
    this.obstacleHits = 0; this.hitCooldown = 0; this.groundHits = 0; this.groundHitCooldown = 0;
    this.flexRamp = 0; // flex-damping fade-in state (see dampFlex)
    this.wheelSpin = [0,0,0,0]; this.lastCenter = null;
    // tire state: per-wheel temperature (C) and current grip factor
    this.tireTemp = [TIRE_AMBIENT, TIRE_AMBIENT, TIRE_AMBIENT, TIRE_AMBIENT];
    this.tireGrip = [tireGripFactor(TIRE_AMBIENT), tireGripFactor(TIRE_AMBIENT),
                     tireGripFactor(TIRE_AMBIENT), tireGripFactor(TIRE_AMBIENT)];
    // beam sleep: a fully settled car stops evaluating beams entirely
    // (see step()). beamEvals counts beam-force evaluations so tests
    // (and the HUD, if wanted) can prove the sim is actually asleep.
    this.beamEvals = 0;
    this.asleep = false; this._quietT = 0; this._sleepSig = 0; this._noSleep = false;
    this._F = null; // reused per-substep force buffer (see substep)
  }
  buildStructure(){
    if (this.cageData){ this.buildCageStructure(); return; }
    const def = this.def, L = def.length, W = def.width;
    const target = clamp(Math.round(this.targetNodes||RES_TARGET_DEFAULT), 40, 2000);
    const grid = chooseGrid(target);
    const S = grid.S, P = grid.P;
    this.gridS = S; this.gridP = P;
    const nodes = [], rawW = [];
    const addNode = (x,y,z,w,kind)=>{ nodes.push({ pos:{x:0,y:0,z:0}, vel:{x:0,y:0,z:0},
      rest:{x:x,y:y,z:z}, mass:1, kind:kind, radius:(kind==='wheel'?def.wheelR:0.06) });
      rawW.push(w); return nodes.length-1; };
    const wheelMass = 13, topScale = (def.topMassScale===undefined ? 1 : def.topMassScale);
    // cage rings: sections evenly spaced front to back, profile interpolated
    this.secRings = []; this.secZ = [];
    for (let i=0;i<S;i++){
      const zf = 0.5 - i/(S-1);
      const prof = profileAt(def, zf);
      const hwB = W*0.5*prof.hw, hwT = hwB*0.8;
      const yLow = prof.yLow + (def.rideBoost||0), yTop = prof.yTop;
      const ring = ringPoints(P, hwB, hwT, yLow, yTop);
      const ids = [];
      for (let j=0;j<P;j++){
        // mass by height: the floor/sill line carries a premium (real
        // sills and floor pans are the heaviest structure, and the
        // suspension links attach at the low nodes — a featherweight node
        // there rings against the suspension stiffness), the roof stays
        // light where the def asks for it, so the CG stays low
        const hf = clamp((ring[j][1]-yLow)/Math.max(0.05, yTop-yLow), 0, 1);
        // overhang taper: the nose and tail sections are lighter than
        // the cabin (plastic bumpers, thin panels, empty overhang
        // volume) — without it a heavy full-height tail (the SUV's)
        // droops its rear floor to the road at fine resolutions
        const endTaper = 1 - 0.3*Math.pow(Math.abs(zf)/0.5, 2);
        ids.push(addNode(ring[j][0], ring[j][1], zf*L, lerp(1.3, topScale, hf) * endTaper, 'chassis'));
      }
      this.secRings.push(ids); this.secZ.push(zf);
    }
    const profF = profileAt(def, 0.5), profR = profileAt(def, -0.5);
    // strut mounts get a fixed ~13 kg whatever the resolution: the tyre
    // grip forces are applied partly at the mount (scaled by the load the
    // wheel carries, not the mount's own mass), so a featherweight mount
    // at high node counts turns that explicit velocity feedback into a
    // resonance that shakes the car apart. ~13 kg (like the wheel itself)
    // keeps the loop tame at every resolution. The bumpers get no such
    // treatment — no force is applied at them, and 13 kg hanging off the
    // soft nose cantilever just bends it toward the ground.
    const avgCh = (def.mass - wheelMass*4)/((S*P) + 6);
    const heavyW = 13/Math.max(1, avgCh);
    this.frontBumper = addNode(0, profF.yMid*0.85, L*0.5+0.18, 1, 'chassis');
    this.rearBumper  = addNode(0, profR.yMid*0.85, -L*0.5-0.18, 1, 'chassis');
    const wz = def.wheelBase*L*0.5, wx = W*0.5*def.trackW;
    // suspension mount (strut top) directly above each wheel — the vertical
    // beam from wheel to mount is what actually carries the car's weight
    this.mountIdx = [
      addNode(-wx, def.wheelR+0.52,  wz, heavyW, 'chassis'),
      addNode( wx, def.wheelR+0.52,  wz, heavyW, 'chassis'),
      addNode(-wx, def.wheelR+0.52, -wz, heavyW, 'chassis'),
      addNode( wx, def.wheelR+0.52, -wz, heavyW, 'chassis')
    ];
    this.wheelIdx = [
      addNode(-wx, def.wheelR,  wz, 0, 'wheel'),
      addNode( wx, def.wheelR,  wz, 0, 'wheel'),
      addNode(-wx, def.wheelR, -wz, 0, 'wheel'),
      addNode( wx, def.wheelR, -wz, 0, 'wheel')
    ];
    this.nodes = nodes;
    // masses: wheels are a fixed 13 kg each; the rest of def.mass is spread
    // over the chassis nodes by raw weight, total exactly def.mass
    {
      let sum = 0; const targetCh = def.mass - wheelMass*4;
      for (let i=0;i<nodes.length;i++) if (nodes[i].kind === 'chassis') sum += rawW[i];
      const f = targetCh/sum;
      for (let i=0;i<nodes.length;i++) nodes[i].mass = nodes[i].kind === 'wheel' ? wheelMass : rawW[i]*f;
    }
    // frame reference: topmost / bottommost ring nodes of the second
    // section (ties on the flat top/bottom edges break toward the centre)
    {
      const ids = this.secRings[Math.min(1, S-1)];
      let top = ids[0], bot = ids[0], topKey = -1e9, botKey = 1e9;
      for (const id of ids){
        const r = nodes[id].rest;
        const tk = r.y - Math.abs(r.x)*0.05, bk = r.y + Math.abs(r.x)*0.05;
        if (tk > topKey){ topKey = tk; top = id; }
        if (bk < botKey){ botKey = bk; bot = id; }
      }
      this.frameTopIdx = top; this.frameFloorIdx = bot;
    }
    // resolution stiffness scale: in a finer grid each beam is a thinner
    // slice of the same shell, so per-beam stiffness scales down with the
    // node count — faster than 1/count, because the grid's beams also get
    // SHORTER as sections multiply (the length falloff pushes short beams
    // toward the stiff end) while each node's mass falls with the count.
    // Two per-car factors normalize across the fleet (the sedan is the
    // reference for both): sqrt(272000/stiff), because the stiffest car
    // on the shortest beams would otherwise sit past the 480 Hz stability
    // edge even at base resolution; and the car's mass ratio, blended in
    // as resolution rises — a heavier car's nodes are proportionally
    // heavier at the same target, so it can (and must, or its floor sags
    // to the road under its own weight) carry proportionally stiffer
    // beams at the same sum-k / node-mass. The strut spring is NOT
    // scaled: a spring rate is a property of the car, and the 13 kg
    // wheel and mount masses keep that loop stable.
    const massBlend = clamp((target - RES_TARGET_DEFAULT)/350, 0, 1);
    // past Ultra the exponent eases back (1.15 -> 0.80 at 1000): the
    // beam subcycle's stability margin is spent on holding the shell's
    // stiffness roughly constant instead, because at the plain eased
    // rate the 1000-node shell sags until its floor drags and the car
    // can barely move. At and below 500 nothing changes.
    const resExp = 1.15 - 0.50 * clamp((target - 500)/500, 0, 1);
    const resK = Math.pow(RES_TARGET_DEFAULT/Math.max(RES_TARGET_DEFAULT, target), resExp) *
      Math.sqrt(272000/def.stiff) * Math.pow((def.mass - 52)/(1320 - 52), massBlend);
    /* ---- beams (structured only — no distance-threshold auto-connect) ---- */
    const beams = [];
    const nodeSec = new Array(nodes.length).fill(-1);
    this.secRings.forEach((ids, i)=>{ for (const id of ids) nodeSec[id] = i; });
    const isEnd = id => nodeSec[id]===0 || nodeSec[id]===S-1 ||
                        id===this.frontBumper || id===this.rearBumper;
    const addBeam = (a, b, lng, forceZone)=>{
      if (a < 0 || b < 0 || a === b) return;
      const A = nodes[a].rest, B = nodes[b].rest;
      const dx=B.x-A.x, dy=B.y-A.y, dz=B.z-A.z, d = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (d < 1e-6) return;
      const rm = 2*nodes[a].mass*nodes[b].mass/(nodes[a].mass+nodes[b].mass);
      // zone material (see MATERIALS / zoneFor): the beam's rate,
      // yield and break strains and its plastic travel all come from
      // the zone it sits in — crumple at the ends, frame low, cabin
      // high in the middle, panels elsewhere. forceZone pins the
      // material for the internal-framing beams (rails, cross-members,
      // roof bars), whose geometry would otherwise classify as panel
      // or crumple.
      const zone = forceZone || zoneFor(A, B, def), M = MATERIALS[zone];
      let matK = M.kScale, matD = M.deform, matB = M.break;
      if (zone === 'crumple' && !forceZone){
        // staged crush gradient: the crumple zone is softest at the
        // tip (|zm| = 0.5) and strongest where it meets the cabin
        // (|zm| = 0.3). In a series chain of identical plastic springs
        // EVERY gap yields at the same load and the whole car
        // accordions; with the gradient the front gaps yield first,
        // the crush front stalls as it reaches stronger material, and
        // the cabin end of the zone barely moves in a moderate hit.
        const zmA = Math.abs((A.z + B.z) * 0.5 / L);
        const g = 0.85 + 0.35 * clamp((0.5 - zmA) / 0.2, 0, 1);
        matK *= g; matD *= g; matB *= g;
      }
      // longitudinal lines are SERIES chains of (S-1) beams: the whole
      // line's axial/bending stiffness is k/(S-1), so per-beam k must grow
      // with the section count to keep the tube's bending stiffness (and
      // the overhangs' ride height) the same at every resolution
      const kLng = lng===true ? Math.min(4.5, Math.pow((S-1)/13, 0.7)) : (typeof lng==='number' ? lng : 1);
      // (A +25% rate increase on non-crumple beams was tried for the
      // jelly fix and had to come back off: combined with any extra
      // damping it pushed the stiffest car (the coupe) over the
      // explicit-integration stability edge in its spawn settle. The
      // hold-together strength in this build comes from the progressive
      // stiffening in addBeamForces, the plastic cap and the beam
      // displacement limit, not from a higher base rate. The zone
      // materials respect the same budget: frame/cabin kScales sit at
      // ~1.0 (1.20/1.25 was tried first and the coupe — the stiffest
      // car — shook itself apart parked, its low frame nodes carrying
      // ~410k beams at ~10 kg; the frame's strength over the crumple
      // zones lives in its yield/break strains and low plastic travel
      // instead), while crumple keeps its 0.28 factor — crash
      // absorption lives there.)
      const k = def.stiff * clamp(1.15 - d*0.12, 0.7, 1.15) * matK * resK * kLng;
      // damping ratio: the original tune ran zeta ~0.12 (0.09 at high
      // resolution) — underdamped, so bumps and corners set the shell
      // ringing. Raised only to 0.13 (0.10 at high resolution): the
      // stability budget is that tight. At 0.14 the coupe's spawn settle
      // stops converging (it parks pre-strained and then yields beams
      // sitting still); at 0.17+ a parked car gains energy and shakes
      // itself apart; 0.28 explodes outright. Explicit damping and beam
      // stiffness spend the SAME 480 Hz stability margin, which is also
      // why the +25% rate above could not stay. Damping only resists
      // relative motion; it cannot hold a load or change the parked
      // shape.
      beams.push(new Beam(a, b, d, { k:k, c:(target > RES_TARGET_DEFAULT ? 0.10 : 0.13)*2*Math.sqrt(k*rm),
        deformStrain:matD,
        breakStrain:matB * (0.94 + 0.12*hashN(a*31+b*17)),
        plasticScale:M.plastic, mat:zone }));
    };
    // ring beams: around each section, plus chords. The chords
    // triangulate the ring in its own plane: a bare polygon of edge beams
    // keeps every beam length yet folds at its joints (a mechanism, not a
    // structure), and X-braced panels cannot stop every ring folding the
    // same way at once. With chords, each ring is a chain of rigid
    // triangles and the cross-section holds its shape.
    // v2.5 chord geometry: the chord STEP scales with the ring size —
    // a chord spans ~1/3 of the ring at every resolution, not a fixed
    // 2 nodes. The fixed step was resolution-inconsistent in disguise:
    // at P=10 the step-2 chord from the top-centre node lands on the
    // upper SIDE nodes (a steep diagonal with real vertical support),
    // but at P=18 it lands on the flat top edge itself, so the roof's
    // centre node was held only by horizontal beams — a catenary with
    // no first-order stiffness — and draped ~0.20 m between the corners
    // parked (measured; the visible W-dip across the roof and the crease
    // down the trunk). With the step at round(P/3) the chord lands at
    // the same physical place at every P. Fine grids (P >= 14, or
    // S >= 40 sections) ALSO keep the local step-2 family: the long
    // chords alone tie the top centre to the floor corners, which are
    // exactly the nodes the strut-mount links load, and the centre
    // inherited their ~40 mm load-entry pop; with both families the
    // pops average out across the ring instead of dragging one node.
    // Ring beams also get a series-compensation factor like the
    // longitudinal beams' kLng (ringK, sqrt of the section-count
    // ratio, capped): each ring is a thinner slice of the shell as S
    // grows, and the un-compensated ring was the softest path in the
    // cage at fine grids. The cap and the sqrt keep the stiffest car
    // inside the integration budget the beam subcycle buys (the
    // subcycle count itself is set from the built cage — see the
    // constructor).
    const chordStep = Math.max(2, Math.round(P/3));
    const ringK = Math.min(2.2, Math.sqrt(Math.max(1, (S-1)/13)));
    for (let i=0;i<S;i++) for (let j=0;j<P;j++){
      addBeam(this.secRings[i][j], this.secRings[i][(j+1)%P], ringK);
      addBeam(this.secRings[i][j], this.secRings[i][(j+chordStep)%P], ringK);
      if ((P >= 14 || S >= 40) && chordStep > 2)
        addBeam(this.secRings[i][j], this.secRings[i][(j+2)%P], ringK);
    }
    // bulkhead chords on the two end rings: an end ring has neighbours
    // on one side only, so its top edge is the free end of every
    // longitudinal line and its centre node sags even at Normal (the
    // coupe's trunk ring measured 43 mm at 150 nodes). One long chord
    // per side from the top-centre node down to the floor quarters
    // braces the end ring in its own plane, like a bulkhead panel.
    const endStep = Math.max(3, Math.round(P*0.4));
    for (const i of [0, S-1]) for (const sgn of [-1,1]){
      const cTop = this.secRings[i][Math.floor(P/2)];
      addBeam(cTop, this.secRings[i][(Math.floor(P/2) + sgn*endStep + P)%P], ringK);
    }
    // longitudinal beams: matching ring nodes, section to section
    for (let i=0;i<S-1;i++) for (let j=0;j<P;j++)
      addBeam(this.secRings[i][j], this.secRings[i+1][j], true);
    // skip-one longitudinals (high resolutions only): a second chord
    // family two sections apart, in parallel with the first. Tube
    // bending — the overhang droop and mid-span sag that otherwise put
    // the floor on the road at fine resolutions, where per-beam rates
    // must fall for integration stability — is resisted by the chords'
    // axial stiffness, and parallel paths add stiffness without raising
    // any single beam's rate. Half the series factor: the family has
    // half as many springs in series per unit length.
    if (target > RES_TARGET_DEFAULT){
      const kSkip = Math.min(4.5, Math.pow((S-1)/13, 0.7)) * 0.5;
      for (let i=0;i<S-2;i++) for (let j=0;j<P;j++)
        addBeam(this.secRings[i][j], this.secRings[i+2][j], kSkip);
      const kSkip2 = Math.min(4.5, Math.pow((S-1)/13, 0.7)) * 0.35;
      for (let i=0;i<S-3;i++) for (let j=0;j<P;j++)
        addBeam(this.secRings[i][j], this.secRings[i+3][j], kSkip2);
    }
    // panel diagonals, one per quad, alternating direction: a spring
    // strut resists shear both ways (it pushes as well as pulls), so one
    // diagonal braces each panel; alternating averages out any
    // directional bias. Together with the longitudinal beams this gives
    // the tube its torsional stiffness, so a tall car does not twist
    // itself over in corners.
    for (let i=0;i<S-1;i++) for (let j=0;j<P;j++){
      if ((i+j)%2 === 0) addBeam(this.secRings[i][j], this.secRings[i+1][(j+1)%P]);
      else addBeam(this.secRings[i][(j+1)%P], this.secRings[i+1][j]);
    }
    // X-brace second diagonals (v2.4): every SIDE quad along the
    // whole car gets BOTH diagonals. The base pattern above gives
    // each quad one diagonal, alternating direction gap to gap —
    // but a quad's diagonal only resists shear one way; loaded the
    // other way it is a mechanism, and the sections rotate/nest
    // instead of crushing (measured directly: at 50 km/h the
    // firewall gap shortened 0.50 m while its stiffest beam showed
    // |strain| 0.15 — the travel was rotation, not beam strain).
    // The fold concentrated exactly at those wrong-way gaps, worst
    // at the stiffness step where the crumple zone meets the cabin.
    // With both diagonals the side walls are true shear webs, so a
    // section can only shorten by straining beams — the crush the
    // materials were tuned for. Top/bottom quads keep one diagonal
    // (their shear is torsion, not the head-on fold path; bracing
    // them too was tried and made the 100 km/h crush DEEPER — the
    // stiffer end rings punch the crush further into the car).
    for (let i=0;i<S-1;i++) for (let j=0;j<P;j++){
      const a0 = nodes[this.secRings[i][j]].rest, a1 = nodes[this.secRings[i][(j+1)%P]].rest;
      if (Math.abs(a0.x) < 0.25 || Math.abs(a1.x) < 0.25) continue;
      if ((i+j)%2 === 0) addBeam(this.secRings[i][(j+1)%P], this.secRings[i+1][j]);
      else addBeam(this.secRings[i][j], this.secRings[i+1][(j+1)%P]);
    }
    // ring-node pickers: 'low' = lowest node on one side, 'mid' = the side
    // node closest to a reference height
    const ringSide = (ids, sx, yRef, mode)=>{
      let best = -1, bestKey = 1e9;
      for (const id of ids){
        const r = nodes[id].rest;
        if (Math.abs(r.x) < 1e-6 || Math.sign(r.x) !== sx) continue;
        const key = mode === 'low' ? r.y*1000 - Math.abs(r.x) : Math.abs(r.y - yRef);
        if (key < bestKey){ bestKey = key; best = id; }
      }
      return best;
    };
    // Framing adds go through addFrame, which never duplicates an
    // existing beam pair: where a framing line lands exactly on a
    // beam the shell already has (the low same-j longitudinal IS the
    // sill line where the pick does not change j between sections;
    // a skip-one ring chord already ties some floors/roofs across),
    // a second beam on the same pair would silently DOUBLE that
    // pair's stiffness — and doubling frame-grade rates on the
    // lightest nodes is exactly what pushed the coupe (the stiffest
    // car) over the 480 Hz stability edge in its spawn settle
    // (measured: a low rear node flung at 88.9 m/s within 1 s).
    const pairSet = new Set(beams.map(b => b.a < b.b ? b.a + '_' + b.b : b.b + '_' + b.a));
    const addFrame = (a, b, lng, forceZone)=>{
      if (a < 0 || b < 0 || a === b) return;
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (pairSet.has(key)) return;
      pairSet.add(key);
      addBeam(a, b, lng, forceZone);
    };
    // ---- internal framing (v2.4) ----
    // Until now the cage was a single shell: the "frame" existed only
    // as a material label on the low ring beams, and in a hard hit the
    // sections telescoped through each other (measured: a 50 km/h
    // head-on concertinaed the sedan from 4.95 m to 1.33 m long and
    // flipped it). Real cars carry the crash on dedicated structure
    // inside the shell, so the cage gets some:
    //  - SILL RAILS: a continuous longitudinal chain along each side's
    //    low nodes, in frame material. Where the chain follows the
    //    shell's own low longitudinal it adds the links that line was
    //    missing (across the sections where the low pick changes j);
    //    where it would duplicate one, addFrame skips it (above).
    //  - FLOOR CROSS-MEMBERS: a frame beam across the floor at every
    //    section, tying the two rails together so a section cannot
    //    shear sideways off its neighbours or fold as a parallelogram.
    //  - ROOF BARS: a cabin beam across the roof at every cabin-band
    //    section, closing the safety cell over the top (the pillars
    //    and roof longitudinals already exist as ring/longitudinal
    //    beams; the cell was missing its cross ties).
    const railLo = { '-1':[], '1':[] };
    for (const sx of [-1,1])
      for (let i=0;i<S;i++) railLo[sx].push(ringSide(this.secRings[i], sx, 0, 'low'));
    for (const sx of [-1,1])
      for (let i=0;i<S-1;i++) addFrame(railLo[sx][i], railLo[sx][i+1], true, 'frame');
    for (let i=0;i<S;i++) addFrame(railLo[-1][i], railLo[1][i], false, 'frame');
    for (let i=0;i<S;i++){
      if (Math.abs(this.secZ[i]) > 0.34) continue;
      const prof = profileAt(def, this.secZ[i]);
      addFrame(ringSide(this.secRings[i], -1, prof.yTop, 'mid'),
               ringSide(this.secRings[i],  1, prof.yTop, 'mid'), false, 'cabin');
    }
    //  - UPPER LOAD PATH ("shotgun" rails): a second longitudinal
    //    chain along each side's shoulder nodes (the node nearest
    //    85% of the section top), running through the overhangs and
    //    wheelhouse band (|zf| >= 0.15). The sill line alone left the
    //    sections' resistance lopsided — strong at the bottom, soft
    //    panels at the top — so a stopped wheel dragged the bottom
    //    back and the clip hinged. With an upper path the section is
    //    pushed back top and bottom together. No forced material:
    //    the ends classify as crumple (and pick up the staged
    //    gradient), the wheelhouse band as panel/cabin.
    const railUp = { '-1':[], '1':[] };
    for (const sx of [-1,1])
      for (let i=0;i<S;i++){
        const prof = profileAt(def, this.secZ[i]);
        railUp[sx].push(ringSide(this.secRings[i], sx, prof.yTop * 0.85, 'mid'));
      }
    for (const sx of [-1,1])
      for (let i=0;i<S-1;i++){
        if (Math.min(Math.abs(this.secZ[i]), Math.abs(this.secZ[i+1])) < 0.15) continue;
        addFrame(railUp[sx][i], railUp[sx][i+1], true);
      }
    // explicit bumper rails: stiff beams from each bumper to the end
    // section's low/mid side nodes. A bumper hanging off soft diagonals
    // alone starts swinging under driving vibration, the plastic ratchet
    // feeds the swing, and the front clip gets tossed at speed.
    const addRail = (a, b, matName)=>{
      if (a < 0 || b < 0) return;
      const A = nodes[a].rest, B = nodes[b].rest;
      const dx=B.x-A.x, dy=B.y-A.y, dz=B.z-A.z, d = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (d < 1e-6) return;
      const rm = 2*nodes[a].mass*nodes[b].mass/(nodes[a].mass+nodes[b].mass);
      // default bumper material: the softest zone — the rails are the
      // bumper's crush structure, first to yield and first to break in
      // a hit. The stage-2 rails (to the second section) pass
      // 'crumple': they are the crush cans behind the bumper beam.
      const M = MATERIALS[matName || 'bumper'];
      const k = def.stiff * 0.85 * resK * M.kScale;
      // rail/mount-link damping: 0.16, up from 0.15 — the same explicit-
      // integration stability budget as the cage beams (see addBeam)
      // caps it there; these links share nodes with the cage, so their
      // damping spends from the same margin
      beams.push(new Beam(a, b, d, { k:k, c:0.16*2*Math.sqrt(k*rm),
        deformStrain:M.deform, breakStrain:M.break * (0.94 + 0.12*hashN(a*31+b*17)),
        plasticScale:M.plastic, mat:(matName || 'bumper') }));
    };
    // stage-2 bumper rails: from each bumper to the SECOND section's
    // low and mid side nodes, in crumple material. Staged engagement:
    // the bumper's own soft rails take the first of the hit, these
    // engage as the end section is driven back, and the load lands on
    // the sill-rail line instead of only on the end ring. They are
    // added BEFORE the bumper's own rails below: enforceBeamLimits
    // projects beams in array order, and the exactness check (test
    // 22) uses the LAST beam touching the front bumper — that must
    // stay a bumper-to-end-ring rail, whose ring endpoint no later
    // beam in the array can move (later beams touch mounts/wheels,
    // not the end ring), or the projection would be re-disturbed.
    if (S > 2){
      for (const sx of [-1,1]){
        addRail(this.frontBumper, ringSide(this.secRings[1], sx, 0, 'low'), 'crumple');
        addRail(this.frontBumper, ringSide(this.secRings[1], sx, profF.yMid, 'mid'), 'crumple');
        addRail(this.rearBumper, ringSide(this.secRings[S-2], sx, 0, 'low'), 'crumple');
        addRail(this.rearBumper, ringSide(this.secRings[S-2], sx, profR.yMid, 'mid'), 'crumple');
      }
    }
    for (const sx of [-1,1]){
      addRail(this.frontBumper, ringSide(this.secRings[0], sx, 0, 'low'));
      addRail(this.frontBumper, ringSide(this.secRings[0], sx, profF.yMid, 'mid'));
      addRail(this.rearBumper, ringSide(this.secRings[S-1], sx, 0, 'low'));
      addRail(this.rearBumper, ringSide(this.secRings[S-1], sx, profR.yMid, 'mid'));
    }
    // the anchor sections for a wheel at z-fraction zf: sections about
    // half a metre away on either side (but never closer than the
    // bracketing sections). At high section counts the bracketing
    // sections sit centimetres from the wheel plane, so links to them
    // are stubby pins with no leverage: the wheel swings on its strut
    // until the links bind, and the car ends up parked on its floor
    // with the wheels tucked. The original cage's anchors were spread
    // wide for a reason; at low section counts the bracketing sections
    // already are.
    const anchorSecs = (zf)=>{
      const spacingZF = S > 1 ? (this.secZ[S-1] - this.secZ[0])/(S-1) : 0;
      const off = Math.max(spacingZF, 0.11);
      const near = (t)=>{ let bi = 0, bd = 1e9;
        for (let i=0;i<S;i++){ const d = Math.abs(this.secZ[i]-t); if (d < bd){ bd = d; bi = i; } }
        return bi; };
      let a = near(zf + off), b = near(zf - off);
      if (a === b){ if (b < S-1) b = a+1; else a = b-1; }
      return [a, b];
    };
    // mount links: tie each strut mount into the cage around its wheel.
    // Three lessons are baked into this web:
    //  - wide anchors: the links go to the anchorSecs sections (~±0.8 m
    //    away), not the bracketing ones — near-vertical links barely
    //    locate the mount along the car, where the strut load gives the
    //    perch a toppling (negative) stiffness.
    //  - anchors above AND below: with every anchor below, the perch is
    //    a flagpole and the spawn drop yanks the mount off the strut.
    //  - a hardpoint rate floor: the soft mode of the whole suspension
    //    is the cage sinking on mounts that slide along their strut
    //    orbit — a mode the strut itself cannot resist (on-orbit motion
    //    keeps its length), so only these links resist it, and at plain
    //    resK rates the body sinks until the floor props it up. The
    //    links therefore keep at least half the base rate whatever the
    //    resolution (the mount end is a heavy 13 kg node, so the stiffer
    //    link does not endanger the integration).
    const addMountLink = (a, b)=>{
      if (a < 0 || b < 0) return;
      const A = nodes[a].rest, B = nodes[b].rest;
      const dx=B.x-A.x, dy=B.y-A.y, dz=B.z-A.z, d = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (d < 1e-6) return;
      const rm = 2*nodes[a].mass*nodes[b].mass/(nodes[a].mass+nodes[b].mass);
      // frame material: the mount web is part of the strong spine — it
      // locates the suspension hardpoints and must not yield in a crash
      const M = MATERIALS.frame;
      const k = def.stiff * clamp(1.15 - d*0.12, 0.7, 1.15) * Math.max(resK, 0.42) * M.kScale;
      beams.push(new Beam(a, b, d, { k:k, c:0.16*2*Math.sqrt(k*rm),
        deformStrain:M.deform, breakStrain:M.break * (0.94 + 0.12*hashN(a*31+b*17)),
        plasticScale:M.plastic, mat:'frame' }));
    };
    for (let w=0; w<4; w++){
      const sx = (w%2 === 0) ? -1 : 1;
      const zf = (w < 2 ? 1 : -1) * def.wheelBase * 0.5;
      const br = anchorSecs(zf), ia = br[0], ib = br[1];
      const profA = profileAt(def, this.secZ[ia]), profB = profileAt(def, this.secZ[ib]);
      addMountLink(this.mountIdx[w], ringSide(this.secRings[ia], sx, 0, 'low'));
      addMountLink(this.mountIdx[w], ringSide(this.secRings[ia], sx, profA.yMid, 'mid'));
      addMountLink(this.mountIdx[w], ringSide(this.secRings[ia], sx, profA.yTop*0.85, 'mid'));
      addMountLink(this.mountIdx[w], ringSide(this.secRings[ib], sx, 0, 'low'));
      addMountLink(this.mountIdx[w], ringSide(this.secRings[ib], sx, profB.yMid, 'mid'));
      addMountLink(this.mountIdx[w], ringSide(this.secRings[ib], sx, profB.yTop*0.85, 'mid'));
      // cross-car braces: two diagonal links from the mount to the
      // OPPOSITE side's low anchors. The same-side web above runs fore/
      // aft from the mount, so it locates the mount along the car and
      // vertically but has almost no first-order LATERAL stiffness —
      // while the compressed strut pushes the mount away from the wheel
      // and topples it inward like an inverted pendulum (negative
      // stiffness ~ corner load / strut length). At low resolutions the
      // web's weak lateral coupling plus stiff, heavy anchors just hold
      // the perch; as the grid refines the anchors lighten and soften,
      // the mount swings inward on the strut orbit (measured: 0.26–0.42 m
      // sideways, strut length and link strains nearly unchanged), and
      // the cage drops until the floor carries the car. The braces run
      // mostly ACROSS the car, so their lateral stiffness is first-order
      // — the same reason the wheels themselves have cross-car links.
      addMountLink(this.mountIdx[w], ringSide(this.secRings[ia], -sx, 0, 'low'));
      addMountLink(this.mountIdx[w], ringSide(this.secRings[ib], -sx, 0, 'low'));
    }
    // suspension beams: each wheel to its mount (the strut — first target,
    // ×1.8 stiffness — is what carries the car's weight) plus links to the
    // bracketing sections' low/mid ring nodes. The last two targets of each
    // wheel are cross-car links: without a stiff lateral link, a steered
    // wheel just slides sideways in its soft longitudinal mounts and the
    // chassis never receives the cornering force.
    this.strutBeam = [];
    this.wheelIdx.forEach((wi, w)=>{
      const sx = (w%2 === 0) ? -1 : 1;
      const zf = (w < 2 ? 1 : -1) * def.wheelBase * 0.5;
      const br = anchorSecs(zf), ia = br[0], ib = br[1];
      const profB = profileAt(def, this.secZ[ib]);
      const targets = [
        this.mountIdx[w],
        ringSide(this.secRings[ia], sx, 0, 'low'),
        ringSide(this.secRings[ib], sx, 0, 'low'),
        ringSide(this.secRings[ib], sx, profB.yMid, 'mid'),
        ringSide(this.secRings[ib], -sx, 0, 'low'),
        ringSide(this.secRings[ia], -sx, 0, 'low')
      ];
      targets.forEach((ti, tiIdx)=>{
        if (ti < 0) return;
        const A = nodes[wi].rest, B = nodes[ti].rest;
        const dx=B.x-A.x, dy=B.y-A.y, dz=B.z-A.z, d = Math.sqrt(dx*dx+dy*dy+dz*dz);
        if (d < 1e-6) return;
        const rm = 2*nodes[wi].mass*nodes[ti].mass/(nodes[wi].mass+nodes[ti].mass);
        // first target = vertical strut at full rate; the links soften
        // mildly with resolution (sqrt of the cage scale): full-rate links
        // into the lightest ring nodes measurably ring at high counts
        const kk = def.suspK * (tiIdx===0 ? 1.8 : Math.sqrt(resK));
        if (tiIdx===0) this.strutBeam[w] = beams.length;
        // the STRUT carries the damper, and the damper is sized for the
        // BODY-bounce mode, not the wheel: the old c (zeta 0.7 against
        // the 13 kg wheel/mount reduced mass, ~1000 N.s/m) left the
        // body mode — a whole corner of the car, 300-500 kg — at
        // zeta ~0.14, which is why every car bounced repeatedly after
        // any drop or bump. def.suspDamp is the per-car absolute damper
        // rate for that mode (stiff coupe high, soft SUV lower). The
        // locating links keep their zeta-0.7 rate against rm.
        beams.push(new Beam(wi, ti, d, { k:kk,
          c:(tiIdx===0 ? def.suspDamp : 0.7*2*Math.sqrt(kk*rm)),
          // v2.6 pressured strut (item C): the strut is the element
          // that carries the corner load in this engine (the wheel is
          // a single node — there are no hub/rim radial beams), so it
          // gets the pressured-beam term: a progressive outward force
          // ~2.5x the static corner load at the 1/L cap, which makes
          // the corner stiffen as it compresses instead of staying a
          // pure linear spring. Locating links stay plain springs.
          pressure:(tiIdx===0 ? (def.mass*9.81/4)*2.5 : 0),
          deformStrain:0.3, breakStrain:0.75, suspension:true, mat:'suspension' }));
      });
    });
    /* ---- support beams (v2.6, item A) ----
       Compression-only slack limiters, adapted from BeamNG.drive's
       documented SUPPORT beam type: no force at all while the beam
       is longer than rest x 0.85, a stiff spring-damper in
       compression only below that, never any tension. Their job is
       to forbid configurations the normal beams reach only after
       large deformation: a ring folding flat or inverting (roof
       centre driven through the floor line), and the cabin band
       telescoping roof-into-floor. Because they are slack in every
       normal configuration they add NO parked stiffness — the
       parked shape, the settle matrix and sleep are untouched —
       which is exactly why they are supports and not more normal
       beams (an extra stiff normal beam here would spend the
       480 Hz stability budget full-time; see the addBeam damping
       comment). Geometry per ring: top-centre -> both floor
       quarters and bottom-centre -> both roof quarters (the two
       diagonals whose shortening IS a ring squash/inversion), plus
       top-centre -> next section's floor quarters across the cabin
       band. Pairs that already carry a normal beam are skipped —
       that pair already resists both ways. Supports never deform
       or break (thresholds set absurdly high): a limiter that
       yielded would stop limiting. */
    if (supportOpt.enabled && !this.noSupports){
      const pairSet = new Set(beams.map(b => b.a < b.b ? b.a + '_' + b.b : b.b + '_' + b.a));
      const pickInRing = (ids, tx, ty)=>{
        let best = -1, bd = 1e18;
        for (const id of ids){
          const r = nodes[id].rest;
          const dd = (r.x-tx)*(r.x-tx) + (r.y-ty)*(r.y-ty);
          if (dd < bd){ bd = dd; best = id; }
        }
        return best;
      };
      const addSupport = (a, b, kFac, matName)=>{
        if (a < 0 || b < 0 || a === b) return;
        const key = a < b ? a + '_' + b : b + '_' + a;
        if (pairSet.has(key)) return;
        pairSet.add(key);
        const A = nodes[a].rest, B = nodes[b].rest;
        const dx=B.x-A.x, dy=B.y-A.y, dz=B.z-A.z, d = Math.sqrt(dx*dx+dy*dy+dz*dz);
        if (d < 1e-6) return;
        const rm = 2*nodes[a].mass*nodes[b].mass/(nodes[a].mass+nodes[b].mass);
        const M = MATERIALS[matName];
        const k = def.stiff * clamp(1.15 - d*0.12, 0.7, 1.15) * M.kScale * resK * kFac;
        beams.push(new Beam(a, b, d, { k:k, c:0.13*2*Math.sqrt(k*rm),
          deformStrain:50, breakStrain:50, plasticScale:0, mat:matName,
          kind:'support', engage:0.85 }));
      };
      const ringPick = [];
      for (let i=0;i<S;i++){
        const prof = profileAt(def, this.secZ[i]);
        const hwB = W*0.5*prof.hw, hwT = hwB*0.8;
        const yLow = prof.yLow + (def.rideBoost||0), yTop = prof.yTop;
        const ids = this.secRings[i];
        ringPick.push({
          topC: pickInRing(ids, 0, yTop), botC: pickInRing(ids, 0, yLow),
          floorL: pickInRing(ids, -hwB*0.5, yLow), floorR: pickInRing(ids, hwB*0.5, yLow),
          roofL: pickInRing(ids, -hwT*0.5, yTop), roofR: pickInRing(ids, hwT*0.5, yTop)
        });
      }
      // supported rings are THINNED at fine grids: a limiter every
      // ~16 rings-worth of sections is the same physical spacing at
      // every resolution (at S=98 the rings sit 5 cm apart — a
      // limiter on every one would be hundreds of beams forbidding
      // the same folds). End rings are always supported. (v2.6
      // optimisation pass: the stride denominator went 28 -> 16 —
      // at 500 nodes the sedan's support count drops 160 -> ~105
      // and at 1000 176 -> ~115, while the limiters that remain
      // still span the same rings the fold test exercises at 150
      // nodes, where the stride is 1 either way.)
      const stride = Math.max(1, Math.round(S/16));
      const supRings = [];
      for (let i=0;i<S;i+=stride) supRings.push(i);
      if (supRings[supRings.length-1] !== S-1) supRings.push(S-1);
      for (const i of supRings){
        const rp = ringPick[i];
        addSupport(rp.topC, rp.floorL, ringK, 'frame');
        addSupport(rp.topC, rp.floorR, ringK, 'frame');
        addSupport(rp.botC, rp.roofL, ringK, 'frame');
        addSupport(rp.botC, rp.roofR, ringK, 'frame');
      }
      const kLngS = Math.min(4.5, Math.pow(Math.max(1, S-1)/13, 0.7));
      for (let g=0; g<supRings.length-1; g++){
        const i = supRings[g], j = supRings[g+1];
        if (Math.abs(this.secZ[i]) > 0.34 || Math.abs(this.secZ[j]) > 0.34) continue;
        addSupport(ringPick[i].topC, ringPick[j].floorL, kLngS, 'cabin');
        addSupport(ringPick[i].topC, ringPick[j].floorR, kLngS, 'cabin');
        addSupport(ringPick[j].topC, ringPick[i].floorL, kLngS, 'cabin');
        addSupport(ringPick[j].topC, ringPick[i].floorR, kLngS, 'cabin');
      }
    }
    this.beams = beams;
    // nose reference for crash measurement: bottom-centre node of the
    // section nearest z = +0.17L — the same physical gauge depth the
    // original cage's section-1 reference gave, at every resolution
    {
      let bi = 0, bd = 1e9;
      for (let i=0;i<S;i++){ const dd = Math.abs(this.secZ[i] - 0.17); if (dd < bd){ bd = dd; bi = i; } }
      this.noseRefIdx = this.secRings[bi][0];
    }
    const lowHalf = (ids, yMid)=>{
      const out = [];
      for (const id of ids) if (nodes[id].rest.y <= yMid + 0.02) out.push(id);
      return out;
    };
    this.frontNodes = [this.frontBumper].concat(lowHalf(this.secRings[0], profF.yMid));
    this.rearNodes = [this.rearBumper].concat(lowHalf(this.secRings[S-1], profR.yMid));
  }
  /* ---------------- CageData build (v2.7) ----------------
     Builds nodes/beams from an imported cage (CageData format —
     see the task spec: nodes with rest-frame x=right/y=up/z=fwd,
     beams with explicit k/c/strains, wheels as node indices,
     refNodes for frame()). Everything the constructor and step()
     do after buildStructure runs unchanged on the result:
     - node objects are shaped exactly like the procedural ones
       ({pos, vel, rest, mass, kind, radius}); the cage's per-node
       radius is kept (wheel nodes get their cage wheel radius).
     - beams are Beam instances built from the cage's k/c/strain
       fields (kind 'support' keeps its slack-limiter semantics,
       engage/pressure pass through).
     - wheelIdx comes from cage.wheels IN ORDER, assumed
       [front-left, front-right, rear-left, rear-right] — step()'s
       wheel loop treats w<2 as the front (steered) axle and the
       def's drive layout (FWD/RWD/4WD from the base def that
       spawnCageCar clones) selects the driven pair by that order.
       A cage whose wheel order differs will steer/drive the wrong
       axle — the format carries no axle field, so this ordering
       is part of the format contract.
     - mountIdx has NO cage counterpart (the format has no mount
       nodes): each wheel's mount is its nearest chassis node by
       rest distance. step() splits tyre forces between wheel and
       mount; with the mount being a real cage node the split works
       as designed, but there is no dedicated strut beam unless the
       cage itself beams the wheel to that node (strutBeam then
       records it) — a cage without wheel-to-body beams will not
       carry the body on its wheels at all, which is a cage
       authoring issue, not something the importer can invent.
     - steering geometry: step() steers by rotating the front
       wheels' rolling direction by steerAngle around the car
       frame — no per-wheel steering linkage exists in the
       procedural cars either, so cage wheels steer identically.
       What does NOT carry over: def-based geometry the cage
       replaces implicitly — wheel contact in step() normally reads
       def.wheelR; for cage cars it reads the per-wheel cage radius
       (this._cageWheelR), and the skinning/section machinery
       (secRings/secZ/gridS/gridP, buildSkinAnchors) has no cage
       meaning and is left empty/zero. */
  buildCageStructure(){
    const cage = this.cageData, def = this.def;
    const nodes = cage.nodes.map(cn=>({
      pos:{x:0,y:0,z:0}, vel:{x:0,y:0,z:0},
      rest:{x:cn.x, y:cn.y, z:cn.z},
      mass:(cn.mass > 0 ? cn.mass : 1),
      kind:cn.kind || 'chassis',
      radius:(cn.radius !== undefined ? cn.radius : (cn.kind === 'wheel' ? def.wheelR : 0.06))
    }));
    this.nodes = nodes;
    this.triangles = (cage.triangles || []).map(t=>({ a:t.a, b:t.b, c:t.c, collidable:!!t.collidable }));
    this.gridS = 0; this.gridP = 0; this.secRings = []; this.secZ = [];
    const wheelIdx = [];
    if (cage.wheels && cage.wheels.length) for (const w of cage.wheels) wheelIdx.push(w.node);
    else nodes.forEach((nd, i)=>{ if (nd.kind === 'wheel') wheelIdx.push(i); });
    this.wheelIdx = wheelIdx.slice(0, 4);
    while (this.wheelIdx.length < 4) this.wheelIdx.push(this.wheelIdx.length ? this.wheelIdx[0] : 0);
    this._cageWheelR = [];
    for (let w=0; w<4; w++){
      const src = (cage.wheels && cage.wheels[w]) ? cage.wheels[w].radius : undefined;
      this._cageWheelR.push(src !== undefined ? src : nodes[this.wheelIdx[w]].radius);
    }
    this.mountIdx = this.wheelIdx.map(wi=>{
      let best = wi, bd = Infinity;
      nodes.forEach((nd, i)=>{
        if (nd.kind === 'wheel') return;
        const dx = nd.rest.x-nodes[wi].rest.x, dy = nd.rest.y-nodes[wi].rest.y, dz = nd.rest.z-nodes[wi].rest.z;
        const d = dx*dx + dy*dy + dz*dz;
        if (d < bd){ bd = d; best = i; }
      });
      return best;
    });
    const rn = cage.refNodes || {};
    this.frontBumper = (rn.front !== undefined ? rn.front : 0);
    this.rearBumper = (rn.rear !== undefined ? rn.rear : 0);
    this.frameTopIdx = (rn.top !== undefined ? rn.top : this.frontBumper);
    this.frameFloorIdx = (rn.floor !== undefined ? rn.floor : this.rearBumper);
    this.noseRefIdx = this.frontBumper;
    const beams = [];
    for (const cb of (cage.beams || [])){
      const A = nodes[cb.a], B = nodes[cb.b];
      if (!A || !B || cb.a === cb.b) continue;
      const dx = B.rest.x-A.rest.x, dy = B.rest.y-A.rest.y, dz = B.rest.z-A.rest.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (d < 1e-6) continue;
      beams.push(new Beam(cb.a, cb.b, d, {
        k:(cb.k !== undefined ? cb.k : def.stiff), c:cb.c || 0,
        deformStrain:cb.deformStrain, breakStrain:cb.breakStrain,
        kind:cb.kind || 'normal',
        engage:(cb.engage !== undefined ? cb.engage : 0.85),
        pressure:cb.pressure || 0,
        mat:(cb.kind === 'support' ? 'frame' : 'panel')
      }));
    }
    this.beams = beams;
    this.strutBeam = [];
    this.wheelIdx.forEach((wi, w)=>{
      const mi = this.mountIdx[w];
      const bi = beams.findIndex(b=> (b.a === wi && b.b === mi) || (b.a === mi && b.b === wi));
      if (bi >= 0) this.strutBeam[w] = bi;
    });
    let zMax = -Infinity, zMin = Infinity;
    for (const nd of nodes){ if (nd.rest.z > zMax) zMax = nd.rest.z; if (nd.rest.z < zMin) zMin = nd.rest.z; }
    this.frontNodes = [this.frontBumper];
    this.rearNodes = [this.rearBumper];
    nodes.forEach((nd, i)=>{
      if (nd.kind === 'wheel') return;
      if (nd.rest.z >= zMax - 0.3 && nd.rest.y <= nodes[this.frontBumper].rest.y + 0.3 && i !== this.frontBumper) this.frontNodes.push(i);
      if (nd.rest.z <= zMin + 0.3 && nd.rest.y <= nodes[this.rearBumper].rest.y + 0.3 && i !== this.rearBumper) this.rearNodes.push(i);
    });
    this.targetNodes = nodes.length;
  }
  /* ---------------- self-collision build (v2.7) ----------------
     Until now the cage's nodes collided only with the world: in a
     hard hit one panel could pass straight through another (roof
     through floor, door through sill) because nothing ever pushed
     two nodes of the SAME car apart. buildSelfCollision prepares
     the pass that fixes that (selfCollide, called once per substep):
     every chassis node gets a collision radius and a layer/group
     (SC_GROUPS), and overlaps between nodes that are not
     structurally tied together get resolved, so a fold has to
     crumple — material stacking on material — instead of clipping.
     Radius: 0.45 x the mean rest length of the node's LOCAL
     beam-connected neighbours (its local spacing — see the
     radius block below for the locality filter), clamped to
     [0.05, 0.16] m — thick enough that two panels resting on each
     other sit a believable panel-gap apart, thin enough that the
     rest cage (whose unmasked pairs are all much farther apart
     than the largest radii sum) never touches itself parked.
     Masking: a pair never collides when the nodes are within 2
     hops on the beam graph (they share a beam, or share a common
     beam neighbour). That covers every structurally adjacent pair
     — ring neighbours, chords, longitudinals, diagonals, links —
     so the cage cannot fight its own structure; everything the
     mask leaves is a genuine panel-on-panel approach. (The "same
     panel group AND beam-neighbours" case is inside the mask by
     construction: beam-neighbours are 1 hop.) A pair is ALSO
     masked when it starts within 1.25x its radii sum at rest:
     the strut mounts are placed within centimetres of the ring
     nodes beside their wheel and tied to the cage by a link web
     a few sections away, which leaves them 3-4 hops from nodes
     they nearly coincide with — and the parked sag closes the
     last few millimetres on the pairs just outside the sum, so
     the whole hardpoint cluster (measured out to 1.04x the sum)
     has to be inside the mask, with margin. A contact there
     would fire forever at rest and fight the structure, and it
     can never be a panel contact because the pair begins
     overlapped. Genuine panel pairs all start well outside
     1.25x their radii sum. The mask is stored as CSR sorted id
     lists for allocation-free binary-search lookup in the hot
     pass.
     Broadphase buffers: a dense counting-sort grid over the
     car's bounding box (the same pattern as step()'s obstacle
     grid), rebuilt every substep into the preallocated typed
     arrays below; the pair math runs on flat position/velocity
     scratch arrays, never on node objects. */
  buildSelfCollision(){
    const nodes = this.nodes, beams = this.beams, def = this.def, n = nodes.length;
    this.scEnabled = selfCollOpt.enabled && !this.noSelfColl;
    this.scPairs = 0; this.scContacts = 0;
    const group = new Int16Array(n), rad = new Float32Array(n);
    const inSet = new Uint8Array(n);
    // groups from rest position: section band first (front/rear
    // clips), then — inside the cabin band — the height band and
    // side, using the same height fraction zoneFor uses
    const secOf = new Int32Array(n).fill(-1);
    this.secRings.forEach((ids, i)=>{ for (const id of ids) secOf[id] = i; });
    const rb = def.rideBoost || 0;
    // cage cars: rest-frame ranges for the position-band fallback
    let cgYMin = 0, cgYMax = 0, cgZMin = 0, cgZMax = 0;
    if (this.cageData){
      cgYMin = Infinity; cgYMax = -Infinity; cgZMin = Infinity; cgZMax = -Infinity;
      for (const nd of nodes){
        if (nd.rest.y < cgYMin) cgYMin = nd.rest.y; if (nd.rest.y > cgYMax) cgYMax = nd.rest.y;
        if (nd.rest.z < cgZMin) cgZMin = nd.rest.z; if (nd.rest.z > cgZMax) cgZMax = nd.rest.z;
      }
    }
    for (let i=0;i<n;i++){
      const nd = nodes[i];
      if (nd.kind === 'wheel'){ group[i] = SC_GROUPS.WHEEL; continue; }
      inSet[i] = 1;
      if (this.cageData){
        // group by the cage's own group string where it names an
        // SC_GROUPS layer; otherwise by rest-position band (front /
        // rear by normalised z, then height band, then side) — the
        // same scheme the procedural path applies via sections
        if (i === this.frontBumper){ group[i] = SC_GROUPS.FRONT; continue; }
        if (i === this.rearBumper){ group[i] = SC_GROUPS.REAR; continue; }
        const gname = String((this.cageData.nodes[i].group || '')).toUpperCase();
        if (gname && gname !== 'WHEEL' && SC_GROUPS[gname] !== undefined){ group[i] = SC_GROUPS[gname]; continue; }
        const zn = (cgZMax - cgZMin) > 1e-6 ? (nd.rest.z - (cgZMin + cgZMax)*0.5)/((cgZMax - cgZMin)*0.5) : 0;
        const hf = clamp((nd.rest.y - cgYMin)/Math.max(0.05, cgYMax - cgYMin), 0, 1);
        if (zn > 0.68) group[i] = SC_GROUPS.FRONT;
        else if (zn < -0.68) group[i] = SC_GROUPS.REAR;
        else if (hf <= 0.38) group[i] = SC_GROUPS.FLOOR;
        else if (hf >= 0.72) group[i] = SC_GROUPS.ROOF;
        else if (nd.rest.x < -0.2) group[i] = SC_GROUPS.LEFT;
        else if (nd.rest.x > 0.2) group[i] = SC_GROUPS.RIGHT;
        else group[i] = SC_GROUPS.CABIN;
        continue;
      }
      if (i === this.frontBumper){ group[i] = SC_GROUPS.FRONT; continue; }
      if (i === this.rearBumper){ group[i] = SC_GROUPS.REAR; continue; }
      const sec = secOf[i];
      if (sec < 0){ group[i] = SC_GROUPS.FLOOR; continue; } // strut mounts: floor structure
      const zf = this.secZ[sec], prof = profileAt(def, zf);
      if (zf > 0.34){ group[i] = SC_GROUPS.FRONT; continue; }
      if (zf < -0.34){ group[i] = SC_GROUPS.REAR; continue; }
      const hf = clamp((nd.rest.y - (prof.yLow + rb))/Math.max(0.05, prof.yTop - prof.yLow - rb), 0, 1);
      if (hf <= 0.38) group[i] = SC_GROUPS.FLOOR;
      else if (hf >= 0.72) group[i] = SC_GROUPS.ROOF;
      else if (nd.rest.x < -0.2) group[i] = SC_GROUPS.LEFT;
      else if (nd.rest.x > 0.2) group[i] = SC_GROUPS.RIGHT;
      else group[i] = SC_GROUPS.CABIN;
    }
    // radii from local spacing: 0.45x the mean rest length of the
    // node's LOCAL incident beams — its non-support beams within
    // 2x its shortest incident beam. The unfiltered mean over
    // every incident beam measures the wrong thing on this cage:
    // ring chords span a third of the section, skip-longitudinals
    // span three sections, and the bumper/mount links span half
    // a metre, so the plain mean saturates the 0.16 m clamp at
    // every node and every resolution and the local spacing it
    // is supposed to track disappears (measured: radius range
    // [0.160, 0.160] across the whole sedan @500). The locality
    // filter keeps the surface beams — ring edges, longitudinals,
    // panel diagonals, the node's actual cell size — and drops
    // the long bracing, so the radius tracks the grid: ~0.16 m
    // on the coarse cage, ~0.06-0.08 m on the fine ones.
    const minL = new Float64Array(n).fill(Infinity);
    for (const b of beams){
      if (b.kind === 'support') continue;
      if (b.rest < minL[b.a]) minL[b.a] = b.rest;
      if (b.rest < minL[b.b]) minL[b.b] = b.rest;
    }
    const sum = new Float64Array(n), cnt = new Int32Array(n);
    for (const b of beams){
      if (b.kind === 'support') continue;
      if (b.rest <= 2*minL[b.a]){ sum[b.a] += b.rest; cnt[b.a]++; }
      if (b.rest <= 2*minL[b.b]){ sum[b.b] += b.rest; cnt[b.b]++; }
    }
    let rMax = 0;
    for (let i=0;i<n;i++){
      if (!inSet[i]) continue;
      const mean = cnt[i] > 0 ? sum[i]/cnt[i] : (isFinite(minL[i]) ? minL[i] : 0.22);
      rad[i] = clamp(0.45*mean, 0.05, 0.16);
      if (rad[i] > rMax) rMax = rad[i];
    }
    if (this.cageData){
      // cage cars take their collision radii from the cage itself
      // (per-node radius in the format), not from beam spacing
      rMax = 0;
      for (let i=0;i<n;i++){
        if (!inSet[i]) continue;
        const cr = this.cageData.nodes[i].radius;
        rad[i] = clamp(cr !== undefined ? cr : nodes[i].radius, 0.03, 0.30);
        if (rad[i] > rMax) rMax = rad[i];
      }
    }
    this._scGroup = group; this._scRad = rad; this._scInSet = inSet;
    this._scRMax = rMax;
    // two-tier broadphase split (perf): the radius distribution is
    // bimodal at fine grids — nearly every node sits at the small
    // clamp while a handful of hardpoint nodes (mounts, bumpers)
    // carry the 0.16 m cap. A single grid must use cell = 2x the
    // LARGEST radius for everyone, which makes the neighbour search
    // volume ~10x the typical pair's interaction volume and the
    // pair loop ~5x the rest of the substep. So nodes over 0.10 m
    // go to a short brute-force list (checked against every set
    // member) and the grid cell keys off the largest REMAINING
    // radius. At coarse grids every node is large, the list stays
    // empty and the pass is exactly the single-tier original.
    {
      let rGrid = 0; const big = [];
      for (let i=0;i<n;i++){
        if (!inSet[i]) continue;
        if (rad[i] > 0.10) big.push(i);
        else if (rad[i] > rGrid) rGrid = rad[i];
      }
      if (big.length && rGrid > 0){ this._scBig = big; this._scRGrid = rGrid; }
      else { this._scBig = []; this._scRGrid = rMax; }
      this._scIsBig = new Uint8Array(n);
      for (const i of this._scBig) this._scIsBig[i] = 1;
    }
    // beam-graph adjacency (all beams, supports included: a support
    // pair is structurally tied even though it carries no standing
    // force)
    const adjOff = new Int32Array(n+1);
    for (const b of beams){ adjOff[b.a+1]++; adjOff[b.b+1]++; }
    for (let i=0;i<n;i++) adjOff[i+1] += adjOff[i];
    const adj = new Int32Array(adjOff[n]);
    { const cur = adjOff.slice(0, n);
      for (const b of beams){ adj[cur[b.a]++] = b.b; adj[cur[b.b]++] = b.a; } }
    // 2-hop mask per node (self + neighbours + neighbours of
    // neighbours), sorted and deduped via a stamp array
    const stamp = new Int32Array(n).fill(-1);
    const maskOff = new Int32Array(n+1);
    const lists = new Array(n);
    for (let i=0;i<n;i++){
      const set = [i];
      stamp[i] = i;
      for (let e=adjOff[i]; e<adjOff[i+1]; e++){
        const j = adj[e];
        if (stamp[j] !== i){ stamp[j] = i; set.push(j); }
        for (let e2=adjOff[j]; e2<adjOff[j+1]; e2++){
          const k = adj[e2];
          if (stamp[k] !== i){ stamp[k] = i; set.push(k); }
        }
      }
      set.sort((x, y)=>x-y);
      lists[i] = set;
    }
    // rest-overlap mask (see the header comment): pairs that begin
    // within 1.25x their radii sum — the mount hardpoint clusters —
    // are masked as well. Build-time O(n^2) with axis pre-rejects;
    // the pairs are rare, so the membership checks stay cheap.
    for (let i=0;i<n;i++){
      if (!inSet[i]) continue;
      const A = nodes[i].rest, ri = rad[i];
      for (let j=i+1;j<n;j++){
        if (!inSet[j]) continue;
        const rs = (ri + rad[j])*1.25, B = nodes[j].rest;
        const dx = B.x-A.x; if (dx >= rs || dx <= -rs) continue;
        const dy = B.y-A.y; if (dy >= rs || dy <= -rs) continue;
        const dz = B.z-A.z; if (dz >= rs || dz <= -rs) continue;
        if (dx*dx + dy*dy + dz*dz >= rs*rs) continue;
        if (!lists[i].includes(j)) lists[i].push(j);
        if (!lists[j].includes(i)) lists[j].push(i);
      }
    }
    let total = 0;
    for (let i=0;i<n;i++){ lists[i].sort((x, y)=>x-y); total += lists[i].length; }
    const maskIds = new Int32Array(total);
    let w = 0;
    for (let i=0;i<n;i++){ maskOff[i] = w; const s = lists[i]; for (let q=0;q<s.length;q++) maskIds[w++] = s[q]; }
    maskOff[n] = w;
    this._scMaskOff = maskOff; this._scMaskIds = maskIds;
    // bitset copy of the same mask for the hot pair loop: the CSR
    // binary search (_scMasked) costs ~7 dependent loads per
    // candidate pair and there are ~700 candidates per substep at
    // 500 nodes — measured, that lookup alone was most of the
    // pass's cost. One word load + bit test replaces it; the CSR
    // lists stay as the canonical form _scMasked reads.
    const MW = Math.ceil(n/32);
    const maskBits = new Uint32Array(n*MW);
    for (let i=0;i<n;i++){ const s = lists[i]; for (let q=0;q<s.length;q++){ const j = s[q]; maskBits[i*MW + (j>>5)] |= (1 << (j & 31)); } }
    this._scMaskBits = maskBits; this._scMaskWords = MW;
    // broadphase buffers (see selfCollide): flat position/velocity
    // scratch, inverse masses, and the counting-sort grid arrays,
    // all preallocated — the pass allocates nothing. The particle
    // space is [0, n) real nodes plus [n, n + beams.length) slots
    // for the v2.7.1 stretched-beam midpoint pseudo-particles (see
    // selfCollide): the scratch, grid order/cell arrays and the
    // particle-space radius/inverse-mass arrays are sized for both.
    this._scPos = new Float64Array((n + beams.length)*3);
    this._scVel = new Float64Array((n + beams.length)*3);
    this._scInvM = new Float64Array(n);
    for (let i=0;i<n;i++) if (inSet[i]) this._scInvM[i] = 1/nodes[i].mass;
    this._scRadP = new Float32Array(n + beams.length);
    this._scInvMP = new Float64Array(n + beams.length);
    this._scPBeam = new Int32Array(beams.length);
    this._scTick = 0; this._scHotT = 0;
    this._scCounts = new Int32Array(SC_GRID_MAX + 1);
    this._scCursor = new Int32Array(SC_GRID_MAX + 1);
    this._scOcc = new Int32Array(SC_GRID_MAX);
    this._scOrder = new Int32Array(n + beams.length);
    this._scCellOf = new Int32Array(n + beams.length);
  }
  // v2.7.1: is anything in the collision set moving fast relative
  // to the set's own mean velocity? The 240 Hz cold cadence was
  // justified by panel-relative speeds of a few m/s, but in a crash
  // the rear of the car closes on the stopped front at 20+ m/s: at
  // 240 Hz that is 8+ cm between checks, comparable to the whole
  // interaction shell of a fine-grid panel (radii sums ~0.15 m), so
  // a fast node can cross a panel plane between checks and be
  // ejected on the far side (measured: panel-slam rig, 1 of 15
  // nodes through at 30 m/s on an unstretched @500-style panel).
  // While any set member moves faster than ~10 m/s relative to the
  // set mean, selfCollide runs every substep. In ordinary driving
  // the set's relative speeds stay in the low single digits
  // (cornering is near-rigid rotation, ~1 m/s at the corners;
  // suspension flex is a few m/s; the wheels — the fastest movers
  // over bumps — are not in the set), so the gate costs one
  // velocity scan per would-be-skipped substep and nothing more.
  _scFastRelative(){
    const nodes = this.nodes, inSet = this._scInSet, n = nodes.length;
    let mx = 0, my = 0, mz = 0, cnt = 0;
    for (let i=0;i<n;i++){
      if (!inSet[i]) continue;
      const v = nodes[i].vel; mx += v.x; my += v.y; mz += v.z; cnt++;
    }
    if (!cnt) return false;
    mx /= cnt; my /= cnt; mz /= cnt;
    for (let i=0;i<n;i++){
      if (!inSet[i]) continue;
      const v = nodes[i].vel;
      const dx = v.x-mx, dy = v.y-my, dz = v.z-mz;
      // (5 m/s)^2 relative to the set mean. The mean includes the
      // approaching panel itself, which halves the signal: two
      // panels closing at 10 m/s pairwise show up here as ~5 m/s
      // each against the mean. The first cut used (10 m/s)^2 and
      // the gate stayed shut through exactly the 20 m/s panel-slam
      // it was built for (measured: pseudo resolves per run fell
      // from 111 at 5 m/s to 62 at 20 m/s and 12 of 15 gap-aimed
      // nodes passed through the stretched panel)
      if (dx*dx + dy*dy + dz*dz > 25) return true;
    }
    return false;
  }
  _scMasked(i, j){
    const off = this._scMaskOff, ids = this._scMaskIds;
    let lo = off[i], hi = off[i+1]-1;
    while (lo <= hi){
      const mid = (lo + hi) >> 1, v = ids[mid];
      if (v === j) return true;
      if (v < j) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }
  /* pose helpers */
  setPoseFrame(cx, cy, cz, right, up, fwd, vx, vy, vz){
    this.asleep = false; this._quietT = 0; // a teleport always wakes the car
    for (const n of this.nodes){
      n.pos.x = cx + right.x*n.rest.x + up.x*n.rest.y + fwd.x*n.rest.z;
      n.pos.y = cy + right.y*n.rest.x + up.y*n.rest.y + fwd.y*n.rest.z;
      n.pos.z = cz + right.z*n.rest.x + up.z*n.rest.y + fwd.z*n.rest.z;
      n.vel.x = vx||0; n.vel.y = vy||0; n.vel.z = vz||0;
    }
    this.lastCenter = { x:cx, y:cy, z:cz };
  }
  placeOnTrack(world, s, lateral){
    const p = world.trackPoint(s);
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
    const cx = p.x + rx*(lateral||0), cz = p.z + rz*(lateral||0);
    const gh = world.heightAtSL(s, lateral||0).h;
    this.setPoseFrame(cx, gh, cz, {x:rx,y:0,z:rz}, {x:0,y:1,z:0}, {x:fx,y:0,z:fz}, 0,0,0);
    this.sHint = s; this.distance = 0;
  }
  setVelocity(vx, vy, vz){ this.asleep = false; this._quietT = 0;
    for (const n of this.nodes){ n.vel.x=vx; n.vel.y=vy; n.vel.z=vz; } }
  center(){ let x=0,y=0,z=0; for (const n of this.nodes){ x+=n.pos.x; y+=n.pos.y; z+=n.pos.z; }
    const m = 1/this.nodes.length; return { x:x*m, y:y*m, z:z*m }; }
  centerVel(){ let x=0,y=0,z=0; for (const n of this.nodes){ x+=n.vel.x; y+=n.vel.y; z+=n.vel.z; }
    const m = 1/this.nodes.length; return { x:x*m, y:y*m, z:z*m }; }
  frame(){
    const F = this.nodes[this.frontBumper].pos, R = this.nodes[this.rearBumper].pos;
    let fx = F.x-R.x, fy = F.y-R.y, fz = F.z-R.z;
    let fl = Math.sqrt(fx*fx+fy*fy+fz*fz)||1; fx/=fl; fy/=fl; fz/=fl;
    const T = this.nodes[this.frameTopIdx].pos, B = this.nodes[this.frameFloorIdx].pos;
    let ux = T.x-B.x, uy = T.y-B.y, uz = T.z-B.z;
    // right = up0 x fwd ; then true up = fwd x right
    let rx = uy*fz-uz*fy, ry = uz*fx-ux*fz, rz = ux*fy-uy*fx;
    let rl = Math.sqrt(rx*rx+ry*ry+rz*rz)||1; rx/=rl; ry/=rl; rz/=rl;
    const upx = fy*rz-fz*ry, upy = fz*rx-fx*rz, upz = fx*ry-fy*rx;
    return { fwd:{x:fx,y:fy,z:fz}, right:{x:rx,y:ry,z:rz}, up:{x:upx,y:upy,z:upz} };
  }
  speed(){ const v = this.centerVel(); return Math.sqrt(v.x*v.x+v.y*v.y+v.z*v.z); }
  forwardSpeed(){ const v = this.centerVel(), f = this.frame().fwd; return v.x*f.x+v.y*f.y+v.z*f.z; }
  stats(){
    let intact=0, deformed=0, broken=0;
    for (const b of this.beams){ if (b.broken) broken++; else if (b.deformed) deformed++; else intact++; }
    const total = this.beams.length;
    return { intact:intact, deformed:deformed, broken:broken, total:total,
             integrity: Math.round(100*(intact + deformed*0.55)/total),
             scPairs: this.scPairs, scContacts: this.scContacts };
  }
  repair(){
    this.asleep = false; this._quietT = 0; // repair always wakes the car
    for (const b of this.beams){ b.broken = false; b.deformed = false; b.currentRest = b.rest; b.maxStrain = 0; b.stress = 0; }
    if (this._dampF) this._dampF.fill(0);
    const c = this.center(), f = this.frame(), v = this.centerVel();
    this.setPoseFrame(c.x, c.y, c.z, f.right, f.up, f.fwd, v.x, v.y, v.z);
  }
  // hard maximum beam displacement: an unbroken beam may never sit more
  // than clampDisp (= min(breakStrain, 0.55) x rest, measured against
  // the ORIGINAL rest length — the same convention as checkDeform's
  // thresholds; see the Beam constructor for why the clamp strain is
  // capped below the floored break strain) away from its rest length.
  // Forces alone cannot guarantee that in a crash: one
  // 480 Hz step at 30 m/s moves a node 6 cm, straight past the limit. So
  // after each integration pass, any beam found past the limit is
  // projected back to exactly the limit (correction split by inverse
  // mass, like a contact) and the relative velocity still carrying it
  // further out is removed. Broken beams are exempt — a detached part
  // stays detached. Within the limit this is a strict no-op.
  enforceBeamLimits(sweeps){
    const beamsL = this.beams;
    const nSweeps = sweeps || 1;
    let total = 0;
    for (let sw=0; sw<nSweeps; sw++){
      const p = this._enforceSweep(beamsL);
      total += p;
      if (p === 0) break;
    }
    return total;
  }
  // one Gauss-Seidel sweep of the displacement clamp; returns how
  // many beams were projected (the end-of-substep call in substep
  // asks for a second sweep, since projecting one beam can push a
  // beam sharing its nodes back past the limit — the single-sweep
  // residue measured 1.58x / 0.32x against the 1.55x / 0.45x bound
  // in the @500 wall crash. The default single sweep is what the
  // unit tests pin.)
  _enforceSweep(beamsL){
    let projected = 0;
    // flat caches (see the constructor): pos/vel object refs and the
    // squared limit bounds as array slots — the projection path below
    // (rare) still reads the Beam object's own rest/clampDisp/masses,
    // so the arithmetic is unchanged
    const bpA = this._bpA, bpB = this._bpB, bvA = this._bvA, bvB = this._bvB,
          bhi2 = this._bhi2, blo2 = this._blo2;
    for (let bi=0; bi<beamsL.length; bi++){
      const b = beamsL[bi];
      if (b.broken) continue;
      const pA = bpA[bi], pB = bpB[bi];
      const dx = pB.x-pA.x, dy = pB.y-pA.y, dz = pB.z-pA.z;
      // squared-distance pre-check: a beam inside [loDisp, hiDisp]
      // needs no projection, and that is nearly every beam nearly all
      // the time — skip the sqrt for them (identical outcome: the
      // projection below is a no-op inside the limit by definition)
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 <= bhi2[bi] && (b.loDisp <= 0 || d2 >= blo2[bi])) continue;
      const A = b.nA, B = b.nB;
      const L = Math.sqrt(d2); if (L < 1e-6) continue;
      const disp = L - b.rest, adisp = Math.abs(disp);
      if (adisp <= b.clampDisp) continue;
      const ux = dx/L, uy = dy/L, uz = dz/L, s = Math.sign(disp);
      const corr = adisp - b.clampDisp;
      projected++;
      const imA = 1/A.mass, imB = 1/B.mass, imSum = imA + imB;
      const wA = imA/imSum, wB = imB/imSum;
      pA.x += ux*s*corr*wA; pA.y += uy*s*corr*wA; pA.z += uz*s*corr*wA;
      pB.x -= ux*s*corr*wB; pB.y -= uy*s*corr*wB; pB.z -= uz*s*corr*wB;
      // kill only the velocity component carrying the pair FURTHER past
      // the limit; motion back toward the limit is the elastic recovery
      // and is left alone
      const vA = bvA[bi], vB = bvB[bi];
      const rel = (vB.x-vA.x)*ux + (vB.y-vA.y)*uy + (vB.z-vA.z)*uz;
      if (s*rel > 0){
        vA.x += ux*rel*wA; vA.y += uy*rel*wA; vA.z += uz*rel*wA;
        vB.x -= ux*rel*wB; vB.y -= uy*rel*wB; vB.z -= uz*rel*wB;
      }
    }
    return projected;
  }
  /* ---------------- self-collision pass (v2.7) ----------------
     Runs ONCE per 480 Hz substep (not per beam subcycle), after
     the beam displacement limits and before flex damping, so
     contact jitter is smoothed by the same pass that kills the
     shell wobble. Broadphase: the car's own nodes are sorted
     into a dense grid over the car's bounding box by counting
     sort (the pattern step() uses for obstacles), with the cell
     at least the largest interaction distance (2x the largest
     radius), so the 13 forward neighbour cells plus the cell
     itself cover every pair that can interact, and each
     unordered pair is visited exactly once. If a scattered
     wreck's box outgrows the preallocated counts array the cell
     grows until it fits — completeness is preserved, since the
     cell only has to stay >= the interaction distance. The pair
     math runs directly on the node objects (their pos/vel refs
     are fetched once per outer node; resolves are Gauss-Seidel,
     so a node moved by one contact is seen moved by the next);
     nothing in the pass allocates. Narrowphase: pairs inside
     their radii sum and outside the 2-hop mask resolve as a soft
     contact — 55% of the overlap projected out per substep
     (v2.7.1: the fraction rises toward 95% as the overlap
     deepens toward the full radii sum),
     split by inverse mass (at 480 Hz the rest closes within a
     few substeps, and the soft factor keeps a panel resting on
     another panel from jittering), plus damping of the approach
     velocity along the contact normal. There is no restitution
     and no tangential force: the pass can only remove energy,
     never add it, so a contact at rest stays at rest and a
     parked car registers zero contacts.
     scPairs counts candidate pairs distance-checked, scContacts
     counts contacts actually resolved; both are cumulative and
     surfaced through stats(). */
  selfCollide(){
    if (!this.scEnabled) return;
    // cadence (perf): the full pass runs every 2nd substep (240 Hz)
    // while the car is contact-free and slow inside itself — two
    // panels of the same car approach at panel-relative speeds (a
    // few m/s, not road speed), so in 1/240 s a pair closes at most
    // a few centimetres, far inside the smallest radii sum, and
    // nothing can tunnel between checks. The moment a pass resolves
    // a contact the pass goes HOT — every substep — for 0.25 s, so
    // a crash fold in progress is resolved at the full 480 Hz rate.
    // v2.7.1: the cold cadence is ALSO gated on internal speed
    // (_scFastRelative): during a crash approach no contact has
    // registered yet, but set members are already closing at 20+
    // m/s, and at 240 Hz that is 8+ cm between checks — enough to
    // cross a fine panel's interaction shell. While anything in
    // the set moves fast relative to the set mean, the pass runs
    // every substep, contact or not. Measured: the pass is
    // ~165 us at 500 nodes; at half cadence its amortised cost is
    // inside the +15% perf bar against the pre-self-collision core,
    // at full cadence it was not.
    // the stretched-beam pseudo build below is gated on the same
    // signals (buildPseudo): it runs while the pass is hot (a
    // contact in the last 0.25 s) or while internal speeds are
    // crash-like. In clean driving neither holds — measured zero
    // beams past the 1.15x stretch threshold in a 10 s drive at
    // both 500 and 1000 nodes — and skipping the scan keeps the
    // pass at its v2.7 cost there.
    let buildPseudo = false;
    if (this._scHotT > 0){ this._scHotT--; buildPseudo = true; }
    else {
      this._scTick++;
      const fast = this._scFastRelative();
      if ((this._scTick & 1) && !fast) return;
      buildPseudo = fast;
    }
    const nodes = this.nodes, n = nodes.length;
    const inSet = this._scInSet;
    // particle-space radius / inverse mass: slots [0, n) mirror the
    // per-node arrays; slots [n, n + nPseudo) are the stretched-beam
    // midpoints built below. The pair loops read only these.
    const rad = this._scRadP, invM = this._scInvMP;
    rad.set(this._scRad); invM.set(this._scInvM);
    const P = this._scPos, V = this._scVel;
    const maskBits = this._scMaskBits, MW = this._scMaskWords;
    // bounding box of the set members (anchors the grid)
    let mnx = Infinity, mny = Infinity, mnz = Infinity,
        mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i=0;i<n;i++){
      if (!inSet[i]) continue;
      const p = nodes[i].pos;
      if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
      if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
      if (p.z < mnz) mnz = p.z; if (p.z > mxz) mxz = p.z;
    }
    if (mxx === -Infinity) return; // no set members (cannot happen)
    let cell = Math.max(0.17, this._scRGrid*2);
    let dxn = 0, dyn = 0, dzn = 0;
    for (;;){
      dxn = Math.floor((mxx-mnx)/cell) + 1;
      dyn = Math.floor((mxy-mny)/cell) + 1;
      dzn = Math.floor((mxz-mnz)/cell) + 1;
      if (dxn*dyn*dzn <= SC_GRID_MAX) break;
      cell *= 1.26;
    }
    const ncells = dxn*dyn*dzn, dxy = dxn*dyn;
    const counts = this._scCounts, cursor = this._scCursor,
          occ = this._scOcc, order = this._scOrder, cellOf = this._scCellOf;
    counts.fill(0, 0, ncells);
    const inv = 1/cell;
    const isBig = this._scIsBig;
    // fill the flat scratch arrays from the live nodes (set members
    // only — the pair loop and the write-back below touch exactly
    // this set, so non-set nodes, i.e. the wheels, are never read
    // from stale scratch and never clobbered by the write-back)
    for (let i=0;i<n;i++){
      if (!inSet[i]) continue;
      const nd = nodes[i], i3 = i*3;
      P[i3] = nd.pos.x; P[i3+1] = nd.pos.y; P[i3+2] = nd.pos.z;
      V[i3] = nd.vel.x; V[i3+1] = nd.vel.y; V[i3+2] = nd.vel.z;
    }
    // v2.7.1 restricted node-vs-beam: a node can spear through the
    // middle of a panel quad without ever coming within radii-sum
    // of a corner node once the panel has stretched — the quad
    // centre sits ~0.71x the (stretched) spacing from every corner,
    // while the radii sum stays ~0.9x the UNstretched spacing.
    // Measured on a two-panel rig: with spacing 0.30 m and radii
    // 0.075 m (a @500-style panel stretched 1.75x), 6-7 of 15
    // gap-aimed nodes passed clean through at 10-30 m/s with the
    // node-node pass alone. The quad's diagonal beams cross at
    // that centre, so a pseudo-particle at the midpoint of every
    // STRETCHED beam (> 1.15x rest — holes only open once a panel
    // has stretched; an unstretched car builds zero pseudo-
    // particles and pays only this scan) closes the hole at a cost
    // proportional to the damage. A pseudo resolves against a real
    // node like a particle of mass 2x the endpoint mean (moving the
    // midpoint by delta moves BOTH endpoints by delta); its
    // correction is applied to both endpoints and to its own slot,
    // keeping the slot the endpoints' midpoint. Pairs against a
    // node within 2 hops of either endpoint are masked with the
    // same bitset as node pairs; pseudo-pseudo pairs are skipped.
    // The pseudo radius is the endpoints' mean radius, capped at
    // the grid tier's radius so the cell-size invariant (cell >=
    // every grid pair's interaction distance) is preserved.
    let nPseudo = 0;
    const pBeam = this._scPBeam, beamsL = this.beams;
    for (let bi=0; buildPseudo && bi<beamsL.length; bi++){
      const b = beamsL[bi];
      if (b.broken) continue;
      const a = b.a, bb = b.b;
      if (!inSet[a] || !inSet[bb]) continue;
      if (b.rest < 0.12) continue;
      const a3 = a*3, b3 = bb*3;
      const dx = P[b3]-P[a3], dy = P[b3+1]-P[a3+1], dz = P[b3+2]-P[a3+2];
      const lim = b.rest*1.15;
      if (dx*dx + dy*dy + dz*dz <= lim*lim) continue;
      const idx = n + nPseudo, i3 = idx*3;
      pBeam[nPseudo++] = bi;
      let rm = 0.5*(rad[a] + rad[bb]);
      if (rm > this._scRGrid) rm = this._scRGrid;
      rad[idx] = rm;
      invM[idx] = 0.25*(invM[a] + invM[bb]);
      P[i3] = (P[a3]+P[b3])*0.5; P[i3+1] = (P[a3+1]+P[b3+1])*0.5; P[i3+2] = (P[a3+2]+P[b3+2])*0.5;
      V[i3] = (V[a3]+V[b3])*0.5; V[i3+1] = (V[a3+1]+V[b3+1])*0.5; V[i3+2] = (V[a3+2]+V[b3+2])*0.5;
    }
    const nPart = n + nPseudo;
    // grid insertion over particles: real set members (minus the
    // big tier) plus every pseudo-particle, positions from P
    for (let idx=0; idx<nPart; idx++){
      if (idx < n && (!inSet[idx] || isBig[idx])) continue;
      const i3 = idx*3;
      let ix = Math.floor((P[i3]-mnx)*inv); if (ix >= dxn) ix = dxn-1;
      let iy = Math.floor((P[i3+1]-mny)*inv); if (iy >= dyn) iy = dyn-1;
      let iz = Math.floor((P[i3+2]-mnz)*inv); if (iz >= dzn) iz = dzn-1;
      const c = ix + dxn*(iy + dyn*iz);
      cellOf[idx] = c; counts[c]++;
    }
    let run = 0, nocc = 0;
    for (let c=0;c<ncells;c++){
      const k = counts[c]; counts[c] = run; run += k;
      if (k > 0) occ[nocc++] = c;
    }
    counts[ncells] = run;
    cursor.set(counts.subarray(0, ncells+1));
    for (let idx=0; idx<nPart; idx++){
      if (idx < n && (!inSet[idx] || isBig[idx])) continue;
      order[cursor[cellOf[idx]]++] = idx;
    }
    // pair iteration over occupied cells: self + 13 forward
    // neighbours, each unordered pair exactly once
    let pairs = 0, contacts = 0;
    for (let oi=0; oi<nocc; oi++){
      const C = occ[oi];
      const cz = Math.floor(C/dxy), rem = C - cz*dxy,
            cy = Math.floor(rem/dxn), cx = rem - cy*dxn;
      const a0 = counts[C], a1 = counts[C+1];
      for (let o=-1; o<13; o++){
        let C2, b0, b1;
        if (o < 0){ C2 = C; b0 = a0; b1 = a1; }
        else {
          const off = SC_FWD[o];
          const nx = cx+off[0], ny = cy+off[1], nz = cz+off[2];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= dxn || ny >= dyn || nz >= dzn) continue;
          C2 = nx + dxn*(ny + dyn*nz);
          b0 = counts[C2]; b1 = counts[C2+1];
          if (b0 === b1) continue;
        }
        for (let a=a0; a<a1; a++){
          const i = order[a], i3 = i*3;
          const ri = rad[i], imI = invM[i];
          for (let b = (o < 0 ? a+1 : b0); b<b1; b++){
            const j = order[b], j3 = j*3;
            const rs = ri + rad[j];
            // P is read live (not snapshotted): an earlier resolve
            // in this same pass may already have moved node i, and
            // the contact math must see the current position
            const dx = P[j3]-P[i3]; if (dx >= rs || dx <= -rs) continue;
            const dy = P[j3+1]-P[i3+1]; if (dy >= rs || dy <= -rs) continue;
            const dz = P[j3+2]-P[i3+2]; if (dz >= rs || dz <= -rs) continue;
            pairs++;
            // pseudo-particle pairs (v2.7.1): ea/eb become the
            // pseudo's beam endpoints; the mask test is the node
            // against BOTH endpoints (2-hop rule), and pseudo-
            // pseudo pairs are meaningless and skipped
            const iP = i >= n, jP = j >= n;
            if (iP && jP) continue;
            let ea = -1, eb = -1;
            if (iP || jP){
              const ndI = iP ? j : i;
              const bObj = beamsL[pBeam[(iP ? i : j) - n]];
              ea = bObj.a; eb = bObj.b;
              if ((maskBits[ndI*MW + (ea>>5)] & (1 << (ea & 31))) ||
                  (maskBits[ndI*MW + (eb>>5)] & (1 << (eb & 31)))) continue;
            } else if (maskBits[i*MW + (j>>5)] & (1 << (j & 31))) continue;
            const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 >= rs*rs) continue;
            contacts++;
            const d = Math.sqrt(d2);
            let ux, uy, uz, pen;
            if (d > 1e-9){ ux = dx/d; uy = dy/d; uz = dz/d; pen = rs - d; }
            else { ux = 1; uy = 0; uz = 0; pen = rs; } // coincident nodes: arbitrary axis
            const imJ = invM[j], imSum = imI + imJ;
            const wI = imI/imSum, wJ = imJ/imSum;
            // v2.7.1: the resolve fraction stiffens with depth —
            // 0.55 at a graze (unchanged: resting contacts stay
            // jitter-free) rising to 0.95 at full overlap, so a
            // pair closing at crash speed (equilibrium penetration
            // at a flat 0.55 measured ~0.5x the radii sum at @500)
            // is pushed back out within a couple of substeps
            // instead of riding deep inside the other panel
            const corr = pen*(0.55 + 0.4*Math.min(1, pen/rs));
            if (ea < 0){
              P[i3] -= ux*corr*wI; P[i3+1] -= uy*corr*wI; P[i3+2] -= uz*corr*wI;
              P[j3] += ux*corr*wJ; P[j3+1] += uy*corr*wJ; P[j3+2] += uz*corr*wJ;
              const vn = (V[j3]-V[i3])*ux + (V[j3+1]-V[i3+1])*uy + (V[j3+2]-V[i3+2])*uz;
              if (vn < 0){
                const lam = -vn*0.5;
                V[i3] -= ux*lam*wI; V[i3+1] -= uy*lam*wI; V[i3+2] -= uz*lam*wI;
                V[j3] += ux*lam*wJ; V[j3+1] += uy*lam*wJ; V[j3+2] += uz*lam*wJ;
              }
            } else {
              // node vs beam midpoint, worked in the node->pseudo
              // frame (u flipped when the pseudo is i): the node
              // takes its weight share; the pseudo's share lands on
              // BOTH endpoints and on the pseudo slot, so the slot
              // stays the endpoints' midpoint
              const nI = iP ? j : i, pI = iP ? i : j;
              const fx = iP ? -ux : ux, fy = iP ? -uy : uy, fz = iP ? -uz : uz;
              const n3 = nI*3, p3 = pI*3, e3a = ea*3, e3b = eb*3;
              const wN = iP ? wJ : wI, wP = iP ? wI : wJ;
              P[n3] -= fx*corr*wN; P[n3+1] -= fy*corr*wN; P[n3+2] -= fz*corr*wN;
              P[e3a] += fx*corr*wP; P[e3a+1] += fy*corr*wP; P[e3a+2] += fz*corr*wP;
              P[e3b] += fx*corr*wP; P[e3b+1] += fy*corr*wP; P[e3b+2] += fz*corr*wP;
              P[p3] += fx*corr*wP; P[p3+1] += fy*corr*wP; P[p3+2] += fz*corr*wP;
              const vn = (V[p3]-V[n3])*fx + (V[p3+1]-V[n3+1])*fy + (V[p3+2]-V[n3+2])*fz;
              if (vn < 0){
                // beam contact is a hard stop, not a panel graze:
                // the FULL approach velocity is killed (the node-
                // node 0.5 factor would let a fast sheet's momentum,
                // fed through its own stiff beams, re-accelerate the
                // node through the shell within the few substeps
                // the crossing window offers)
                const lam = -vn;
                V[n3] -= fx*lam*wN; V[n3+1] -= fy*lam*wN; V[n3+2] -= fz*lam*wN;
                V[e3a] += fx*lam*wP; V[e3a+1] += fy*lam*wP; V[e3a+2] += fz*lam*wP;
                V[e3b] += fx*lam*wP; V[e3b+1] += fy*lam*wP; V[e3b+2] += fz*lam*wP;
                V[p3] += fx*lam*wP; V[p3+1] += fy*lam*wP; V[p3+2] += fz*lam*wP;
              }
            }
          }
        }
      }
    }
    // big-radius tier: each large node against every set member
    // (big-big pairs once, by list order). Same contact math as
    // the grid tier, on the same live P/V scratch.
    const bigList = this._scBig;
    for (let bi=0; bi<bigList.length; bi++){
      const i = bigList[bi], i3 = i*3;
      const ri = rad[i], imI = invM[i];
      for (let j=0;j<nPart;j++){
        if (j === i) continue;
        if (j < n && !inSet[j]) continue;
        if (j < n && isBig[j] && j < i) continue; // big-big already done from the smaller index
        const j3 = j*3;
        const rs = ri + rad[j];
        const dx = P[j3]-P[i3]; if (dx >= rs || dx <= -rs) continue;
        const dy = P[j3+1]-P[i3+1]; if (dy >= rs || dy <= -rs) continue;
        const dz = P[j3+2]-P[i3+2]; if (dz >= rs || dz <= -rs) continue;
        pairs++;
        // pseudo j (v2.7.1): mask is node i against both endpoints
        let ea = -1, eb = -1;
        if (j >= n){
          const bObj = beamsL[pBeam[j - n]];
          ea = bObj.a; eb = bObj.b;
          if ((maskBits[i*MW + (ea>>5)] & (1 << (ea & 31))) ||
              (maskBits[i*MW + (eb>>5)] & (1 << (eb & 31)))) continue;
        } else if (maskBits[i*MW + (j>>5)] & (1 << (j & 31))) continue;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 >= rs*rs) continue;
        contacts++;
        const d = Math.sqrt(d2);
        let ux, uy, uz, pen;
        if (d > 1e-9){ ux = dx/d; uy = dy/d; uz = dz/d; pen = rs - d; }
        else { ux = 1; uy = 0; uz = 0; pen = rs; }
        const imJ = invM[j], imSum = imI + imJ;
        const wI = imI/imSum, wJ = imJ/imSum;
        // resolve fraction stiffens with depth (see the grid tier)
        const corr = pen*(0.55 + 0.4*Math.min(1, pen/rs));
        if (ea < 0){
          P[i3] -= ux*corr*wI; P[i3+1] -= uy*corr*wI; P[i3+2] -= uz*corr*wI;
          P[j3] += ux*corr*wJ; P[j3+1] += uy*corr*wJ; P[j3+2] += uz*corr*wJ;
          const vn = (V[j3]-V[i3])*ux + (V[j3+1]-V[i3+1])*uy + (V[j3+2]-V[i3+2])*uz;
          if (vn < 0){
            const lam = -vn*0.5;
            V[i3] -= ux*lam*wI; V[i3+1] -= uy*lam*wI; V[i3+2] -= uz*lam*wI;
            V[j3] += ux*lam*wJ; V[j3+1] += uy*lam*wJ; V[j3+2] += uz*lam*wJ;
          }
        } else {
          // node i vs beam midpoint j (u already points node->pseudo)
          const e3a = ea*3, e3b = eb*3;
          P[i3] -= ux*corr*wI; P[i3+1] -= uy*corr*wI; P[i3+2] -= uz*corr*wI;
          P[e3a] += ux*corr*wJ; P[e3a+1] += uy*corr*wJ; P[e3a+2] += uz*corr*wJ;
          P[e3b] += ux*corr*wJ; P[e3b+1] += uy*corr*wJ; P[e3b+2] += uz*corr*wJ;
          P[j3] += ux*corr*wJ; P[j3+1] += uy*corr*wJ; P[j3+2] += uz*corr*wJ;
          const vn = (V[j3]-V[i3])*ux + (V[j3+1]-V[i3+1])*uy + (V[j3+2]-V[i3+2])*uz;
          if (vn < 0){
            const lam = -vn; // full kill, as in the grid tier
            V[i3] -= ux*lam*wI; V[i3+1] -= uy*lam*wI; V[i3+2] -= uz*lam*wI;
            V[e3a] += ux*lam*wJ; V[e3a+1] += uy*lam*wJ; V[e3a+2] += uz*lam*wJ;
            V[e3b] += ux*lam*wJ; V[e3b+1] += uy*lam*wJ; V[e3b+2] += uz*lam*wJ;
            V[j3] += ux*lam*wJ; V[j3+1] += uy*lam*wJ; V[j3+2] += uz*lam*wJ;
          }
        }
      }
    }
    // write back
    for (let i=0;i<n;i++){
      if (!inSet[i]) continue;
      const nd = nodes[i], i3 = i*3;
      nd.pos.x = P[i3]; nd.pos.y = P[i3+1]; nd.pos.z = P[i3+2];
      nd.vel.x = V[i3]; nd.vel.y = V[i3+1]; nd.vel.z = V[i3+2];
    }
    this.scPairs += pairs; this.scContacts += contacts;
    if (contacts > 0) this._scHotT = 120; // 0.25 s at 480 Hz
  }
  // velocity-level flex damping — the jelly killer. Force-based beam
  // damping cannot finish this job: its ratio is capped by the 480 Hz
  // explicit integrator (past ζ≈0.13 the stiffest car's spawn settle
  // stops converging), and the wobble that survives is a ~3 Hz shell
  // mode whose strain is mostly joint rotation, which axial beam
  // dampers barely reach anyway. So once per substep, after
  // integration, this pass fits the best rigid-body velocity field of
  // the whole car — mass-weighted COM velocity V plus ω = I⁻¹L from
  // the current node cloud's angular momentum and inertia tensor —
  // and pulls every node's velocity a small fraction β toward it.
  // It only ever REMOVES energy: there is no force and no stiffness,
  // so it spends none of the integrator's stability margin. And by
  // construction it cannot touch rigid translation or rotation, so
  // driving, cornering and top speed are unaffected; only the
  // internal flex velocity — the wobble — decays.
  // CRASH GATING: while either hit cooldown is running (an obstacle
  // or ground impact just landed) β is 0 — a crash in progress
  // crumples exactly as the beams dictate, with no invisible hand
  // steadying the structure — and once the cooldowns expire it fades
  // back in over ~0.25 s (flexRamp) instead of snapping on
  // mid-ring-down and changing how the wreck settles.
  dampFlex(h){
    if (this.hitCooldown > 0 || this.groundHitCooldown > 0){ this.flexRamp = 0; return; }
    this.flexRamp = Math.min(1, this.flexRamp + h/0.25);
    // β = 0.012 per substep: at 0.015 the wobble died slightly faster
    // but test 2's crash compression drifted +16.5% (the wreck's
    // elastic springback gets damped once the gating fades back in);
    // 0.012 keeps every crash number inside its band and still kills
    // the wobble (test 26: RMS 0.021, max 0.269)
    const beta = 0.012 * this.flexRamp;
    if (beta <= 0) return;
    const nodes = this.nodes;
    let M = 0, cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    for (let ni=0; ni<nodes.length; ni++){
      const n = nodes[ni];
      M += n.mass;
      cx += n.mass*n.pos.x; cy += n.mass*n.pos.y; cz += n.mass*n.pos.z;
      vx += n.mass*n.vel.x; vy += n.mass*n.vel.y; vz += n.mass*n.vel.z;
    }
    if (!(M > 0)) return;
    cx /= M; cy /= M; cz /= M; vx /= M; vy /= M; vz /= M;
    // angular momentum L and inertia tensor I of the current cloud
    let Lx = 0, Ly = 0, Lz = 0;
    let Ixx = 0, Ixy = 0, Ixz = 0, Iyy = 0, Iyz = 0, Izz = 0;
    for (let ni=0; ni<nodes.length; ni++){
      const n = nodes[ni];
      const rx = n.pos.x-cx, ry = n.pos.y-cy, rz = n.pos.z-cz;
      const wx = n.vel.x-vx, wy = n.vel.y-vy, wz = n.vel.z-vz;
      Lx += n.mass*(ry*wz - rz*wy);
      Ly += n.mass*(rz*wx - rx*wz);
      Lz += n.mass*(rx*wy - ry*wx);
      const r2 = rx*rx + ry*ry + rz*rz;
      Ixx += n.mass*(r2 - rx*rx); Iyy += n.mass*(r2 - ry*ry); Izz += n.mass*(r2 - rz*rz);
      Ixy -= n.mass*rx*ry; Ixz -= n.mass*rx*rz; Iyz -= n.mass*ry*rz;
    }
    // ω = I⁻¹L via Cramer. A degenerate cloud (nodes near a point or
    // a line) makes I singular; then skip the rotational part and
    // damp toward pure translation rather than dividing by ~0.
    let ox = 0, oy = 0, oz = 0;
    const det = Ixx*(Iyy*Izz - Iyz*Iyz) - Ixy*(Ixy*Izz - Iyz*Ixz) + Ixz*(Ixy*Iyz - Iyy*Ixz);
    const detScale = Math.abs(Ixx*Iyy*Izz);
    if (isFinite(det) && detScale > 0 && Math.abs(det) > 1e-6*detScale){
      ox = (Lx*(Iyy*Izz - Iyz*Iyz) - Ixy*(Ly*Izz - Iyz*Lz) + Ixz*(Ly*Iyz - Iyy*Lz)) / det;
      oy = (Ixx*(Ly*Izz - Iyz*Lz) - Lx*(Ixy*Izz - Iyz*Ixz) + Ixz*(Ixy*Lz - Ly*Ixz)) / det;
      oz = (Ixx*(Iyy*Lz - Ly*Iyz) - Ixy*(Ixy*Lz - Ly*Ixz) + Lx*(Ixy*Iyz - Iyy*Ixz)) / det;
    }
    for (let ni=0; ni<nodes.length; ni++){
      const n = nodes[ni];
      const rx = n.pos.x-cx, ry = n.pos.y-cy, rz = n.pos.z-cz;
      const gx = vx + (oy*rz - oz*ry);
      const gy = vy + (oz*rx - ox*rz);
      const gz = vz + (ox*ry - oy*rx);
      n.vel.x += beta*(gx - n.vel.x);
      n.vel.y += beta*(gy - n.vel.y);
      n.vel.z += beta*(gz - n.vel.z);
    }
  }
  maxNodeSpeed(){ let m=0; for (const n of this.nodes){ const s = Math.sqrt(n.vel.x*n.vel.x+n.vel.y*n.vel.y+n.vel.z*n.vel.z); if (s>m) m=s; } return m; }
  hasNaN(){ for (const n of this.nodes){ if (!isFinite(n.pos.x+n.pos.y+n.pos.z+n.vel.x+n.vel.y+n.vel.z)) return true; } return false; }

  // position+velocity signature: while asleep nothing in the sim
  // writes node state, so ANY change — a test shoving a node, an
  // external impulse, a teleport that bypassed the wake setters —
  // shows up as a different signature and wakes the car.
  _stateSig(){
    let s = 0;
    for (const n of this.nodes)
      s += n.pos.x + n.pos.y*1.31 + n.pos.z*2.17 + n.vel.x*3.73 + n.vel.y*4.39 + n.vel.z*5.53;
    return s;
  }
  step(dt, input, world){
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;
    // BEAM SLEEP: a settled car (parked, no input, no recent impacts,
    // nothing moving) stops simulating entirely — no beam evaluations,
    // no drift, no CPU. Wake conditions: any driver input, or any
    // change to the node state signature (collision impulses arrive
    // through step() itself, so they cannot happen while asleep; what
    // can arrive is an external shove, which the signature catches).
    // repair / reset / setVelocity / setPoseFrame clear `asleep`
    // directly. A moving car never sleeps: rigid motion keeps the
    // node speeds and the centre velocity far above the quiet gates.
    if (this.asleep){
      const inp = input || {};
      if (inp.throttle || inp.reverse || inp.brake || inp.steer || inp.handbrake) this.asleep = false;
      else if (this._stateSig() !== this._sleepSig) this.asleep = false;
      if (this.asleep) return;
    }
    const SUB = 1/480;
    const nSub = Math.max(1, Math.round(dt/SUB)), h = dt/nSub;
    const c0 = this.center();
    const nt = world.nearestTrack(c0.x, c0.z, this.sHint);
    this.sHint = nt.s;
    const obstacles = world.getObstacles(c0.x, c0.z, this.sHint);
    // spatial grid of the obstacle list (4 m cells, 41x41 window
    // centred on the car, rebuilt once per step into reused typed
    // arrays): the per-node collision pass checks only the obstacles
    // in the node's own and neighbouring cells instead of the whole
    // list. The cell is larger than the biggest obstacle radius +
    // node radius (~2.6 m), so no contact can be missed; the window
    // spans +-82 m around the car and getObstacles only returns
    // obstacles within 60 m, so every obstacle lands in the grid.
    // The response math per obstacle is unchanged.
    const OSIDE = 41, OHALF = 20;
    if (!this._ogCounts) { this._ogCounts = new Int32Array(OSIDE*OSIDE + 1); this._ogIdx = new Int32Array(1024); }
    const oCounts = this._ogCounts; oCounts.fill(0);
    if (this._ogIdx.length < obstacles.length) this._ogIdx = new Int32Array(obstacles.length*2);
    const oIdx = this._ogIdx;
    const ogx = Math.floor(c0.x/4), ogz = Math.floor(c0.z/4);
    const cellOf = (x, z)=>{
      const cx = Math.floor(x/4) - ogx + OHALF, cz = Math.floor(z/4) - ogz + OHALF;
      return (cx < 0 || cz < 0 || cx >= OSIDE || cz >= OSIDE) ? -1 : cz*OSIDE + cx;
    };
    for (let oi=0; oi<obstacles.length; oi++){
      const ci = cellOf(obstacles[oi].x, obstacles[oi].z);
      if (ci >= 0) oCounts[ci]++;
    }
    let oRun = 0;
    for (let i=0; i<OSIDE*OSIDE; i++){ const c = oCounts[i]; oCounts[i] = oRun; oRun += c; }
    oCounts[OSIDE*OSIDE] = oRun;
    const oCursor = oCounts.slice(0, OSIDE*OSIDE);
    for (let oi=0; oi<obstacles.length; oi++){
      const ci = cellOf(obstacles[oi].x, obstacles[oi].z);
      if (ci >= 0) oIdx[oCursor[ci]++] = oi;
    }
    const ogrid = { counts:oCounts, idx:oIdx, ocx:ogx, ocz:ogz };
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (this.groundHitCooldown > 0) this.groundHitCooldown -= dt;
    for (let sIdx=0; sIdx<nSub; sIdx++) this.substep(h, input, world, obstacles, ogrid);
    const c1 = this.center();
    if (this.lastCenter){
      const dx=c1.x-this.lastCenter.x, dy=c1.y-this.lastCenter.y, dz=c1.z-this.lastCenter.z;
      this.distance += Math.sqrt(dx*dx+dy*dy+dz*dz);
    }
    this.lastCenter = c1;
    // quiet tracking: 1 continuous second of nothing happening puts
    // the car to sleep at the END of this step (so the state it
    // freezes in is the settled one). The speed gates sit below the
    // wobble test's pass band, so a car that is still ringing never
    // freezes mid-ring.
    if (!this._noSleep){
      const inp = input || {};
      const driven = inp.throttle || inp.reverse || inp.brake || inp.steer || inp.handbrake;
      if (!driven && this.hitCooldown <= 0 && this.groundHitCooldown <= 0 &&
          this.maxNodeSpeed() < 0.05 && this.speed() < 0.03){
        this._quietT += dt;
        if (this._quietT >= 1.0){ this.asleep = true; this._sleepSig = this._stateSig(); }
      } else this._quietT = 0;
    }
  }
  substep(h, input, world, obstacles, ogrid){
    const nodes = this.nodes, def = this.def;
    const frame = this.frame();
    // scratch ground-height result, refilled per query (the wheel and
    // collision loops each consume it fully before the next query)
    const ghS = this._ghS || (this._ghS = { h:0, surface:'road', slope:0, s:0, lateral:0, normal:{x:0, y:1, z:0} });
    // centre velocity inlined (centerVel() allocates an object per
    // call; this runs 480x/second) — same sum-then-scale arithmetic
    let cvx = 0, cvy = 0, cvz = 0;
    for (const n of nodes){ cvx += n.vel.x; cvy += n.vel.y; cvz += n.vel.z; }
    const cvM = 1/nodes.length, cvX = cvx*cvM, cvY = cvy*cvM, cvZ = cvz*cvM;
    const fSpeed = cvX*frame.fwd.x + cvY*frame.fwd.y + cvZ*frame.fwd.z;
    // steer smoothing
    const steerTarget = clamp(input.steer||0, -1, 1) * 0.5 * (1/(1+Math.abs(fSpeed)*0.038));
    this.steerAngle += clamp(steerTarget - this.steerAngle, -3.2*h, 3.2*h);
    // throttle tip-in smoothing (a step throttle input excites pitch oscillation)
    if (this.throttleSm === undefined) this.throttleSm = 0;
    const thrT = clamp(input.throttle||0, 0, 1);
    this.throttleSm += clamp(thrT - this.throttleSm, -3.5*h, 3.5*h);
    // external forces (gravity here; tyre and aero forces join below).
    // The beam forces are added separately, inside the integration loop:
    // at high node counts the cage's stiffest nodal modes sit close to
    // the 480 Hz explicit-integration edge, so the beams are subcycled —
    // evaluated and integrated sub2N times per substep (this.sub2N, set
    // at build time from the cage's stiffest nodal frequency) — which
    // buys a real stability margin without changing the step the world,
    // tyres and contacts see, and without softening the structure.
    // force buffer reused across substeps (was a fresh array of fresh
    // objects every substep — the single biggest allocation source in
    // the hot loop). v2.6 optimisation: the buffers are now FLAT
    // Float64Arrays (x,y,z per node at i*3), refilled from the
    // gravity template with one typed-array copy per substep; every
    // force writer below (beams, wheels, aero, integration) indexes
    // the flat slots. The values written are the identical floats in
    // the identical order — only the storage changed.
    if (!this._F || this._F.length !== nodes.length*3)
      this._F = new Float64Array(nodes.length*3);
    const F = this._F;
    F.set(this._gravF);
    const sub2N = this.sub2N || 1;
    if (!this._Fs || this._Fs.length !== nodes.length*3)
      this._Fs = new Float64Array(nodes.length*3);
    // band-limited damping coefficient for this substep's beam
    // subcycle step (hh = h/sub2N, computed in the integration loop
    // below — the same value, since sub2N is fixed per car)
    const dampAlphaV = dampAlpha(DAMP_CUTOFF_HZ, h/sub2N);
    const beamsL = this.beams, dampFL = this._dampF;
    // flat per-beam caches (built once in the constructor): every
    // per-evaluation read below is an array slot, not a property
    // chain — the arithmetic itself is unchanged
    const bkA = this._bk, bcA = this._bc, bydA = this._byd, bprA = this._bpr,
          breA = this._brest,
          beLA = this._beL, be2A = this._be2, bsupA = this._bsup, bfilA = this._bfil,
          bfaA = this._bfa, bfbA = this._bfb,
          bpA = this._bpA, bvA = this._bvA, bpB = this._bpB, bvB = this._bvB;
    const addBeamForces = (Ft, doDeform)=>{
      // indexed loop over hoisted locals (v2.6 optimisation): no
      // iterator protocol, beamEvals accumulated in a local and
      // flushed once per call (the count is identical)
      let ev = 0;
      for (let bi=0; bi<beamsL.length; bi++){
        const b = beamsL[bi];
        if (b.broken) continue;
        ev++;
        const pA = bpA[bi], pB = bpB[bi];
        const dx = pB.x-pA.x, dy = pB.y-pA.y, dz = pB.z-pA.z;
        const d2 = dx*dx + dy*dy + dz*dz;
        // support beams above their engagement length exert exactly
        // zero force (that is their definition), so the squared-
        // length check replaces the sqrt for the overwhelmingly
        // common disengaged case — an exact early-out, not an
        // approximation. (A normal-beam deadband skip was considered
        // and rejected: the skipped force there is small but not
        // provably negligible across every zone and load.)
        if (bsupA[bi] && d2 >= be2A[bi]){ dampFL[bi] = 0; continue; }
        const L = Math.sqrt(d2); if (L < 1e-6) continue;
        const ux = dx/L, uy = dy/L, uz = dz/L;
        const vA = bvA[bi], vB = bvB[bi];
        const rel = (vB.x-vA.x)*ux + (vB.y-vA.y)*uy + (vB.z-vA.z)*uz;
        // The force law is INLINED here (v2.6 optimisation: at
        // ~100k evaluations per frame a per-beam function call was
        // measurable). beamAxialForce above is the same law in
        // standalone form for the unit tests — keep the two in sync:
        // the unit tests (37/39/41) pin the function's numbers and
        // the car-level tests (2/26/27/28/33/34) pin the loop's, so
        // a drift between them fails one family or the other.
        let f;
        if (bsupA[bi]){
          const pen = beLA[bi] - L;
          const fd = bcA[bi] * rel;
          const df0 = dampFL[bi], dd = fd - df0;
          const df = Math.abs(dd) > DAMP_SNAP_N ? fd : df0 + dampAlphaV*dd;
          dampFL[bi] = df;
          f = -bkA[bi] * pen + df;
          if (f > 0) f = 0; // compression only — never tension
          if (doDeform) b.stress = 0; // slack limiters carry no standing load
        } else {
          const disp = L - b.currentRest;
          f = bkA[bi] * disp;
          const adisp = Math.abs(disp);
          const yd = bydA[bi];
          if (adisp > yd) f += (disp < 0 ? -1 : 1) * bkA[bi] * (adisp - yd);
          // v2.7.1 tension strain-stiffening (see beamAxialForce —
          // the two copies must stay in sync): past 1.30x the
          // ORIGINAL rest length, +2x k on the excess, tension only
          const overS = L - breA[bi] * 1.3;
          if (overS > 0) f += bkA[bi] * overS * 2;
          const pr = bprA[bi];
          if (pr > 0 && disp < 0){
            const ratio = b.currentRest/L - 1;
            let pf = pr * (ratio < 1 ? ratio : 1);
            if (rel > 0) pf *= 0.35;
            f -= pf;
          }
          const fd = bcA[bi] * rel;
          // band-limited damping, scoped (see the constructor's
          // _bfil note): filtered on the high-damping beams, raw
          // elsewhere — the filter's load/fma/store per evaluation
          // was measurable at ~37M evaluations per test run
          let df;
          if (bfilA[bi]){
            const df0 = dampFL[bi], dd = fd - df0;
            df = Math.abs(dd) > DAMP_SNAP_N ? fd : df0 + dampAlphaV*dd;
          } else df = fd;
          dampFL[bi] = df;
          f += df;
          if (doDeform){
            // live stress: elastic strain relative to the material
            // yield (1.0 = yielding) — read by the B skeleton view
            // and test 27. Deform subcycle only (still every
            // substep): a readout, not physics, and the division is
            // not free at 47k-141k evaluations per step.
            b.stress = adisp/yd;
            // plasticity/break bookkeeping, guarded (v2.6
            // optimisation): checkDeform is a strict no-op unless
            // the strain against the ORIGINAL rest passes the
            // deform threshold (the break threshold is higher than
            // the deform threshold for every normal-beam material,
            // and supports never reach this branch), so the call is
            // skipped for the overwhelming majority of beams whose
            // strain — the identical float checkDeform would
            // compute from the L already measured here — is below
            // it. Outcomes are unchanged.
            if (!this.noDeform){
              const ast = Math.abs((L - b.rest)/b.rest);
              if (ast > b.deformStrain) b.checkDeform(nodes, h, L);
            }
          }
        }
        if (f !== 0){
          const fa = bfaA[bi], fb = bfbA[bi];
          Ft[fa] += ux*f; Ft[fa+1] += uy*f; Ft[fa+2] += uz*f;
          Ft[fb] -= ux*f; Ft[fb+1] -= uy*f; Ft[fb+2] -= uz*f;
        }
      }
      this.beamEvals += ev;
    };
    // (No anti-roll-bar coupling: an undamped differential spring between
    // the struts resonated with the wheel-hop mode and made tall cars MORE
    // likely to roll, not less. Roll stiffness comes from the struts and
    // the triangulated body beams.)
    // wheel contacts + driving
    const totalMass = def.mass;
    for (let w=0; w<4; w++){
      const wi = this.wheelIdx[w], n = nodes[wi];
      const mi = this.mountIdx[w], wi3 = wi*3, mi3 = mi*3;
      // win=20: a node of this car is never more than ~15 m of
      // along-track from the car's own s (centre s + car length +
      // crash scatter), so the nearest-sample scan can use a 20 m
      // window instead of the general 140 m one — same result (the
      // window still covers the ~15 m bound with margin), under
      // half the scan. The public groundHeight keeps 140 m.
      const gh = ghS; world._groundHeightInto(n.pos.x, n.pos.z, this.sHint, gh, gh.normal, 20);
      const wRad = this._cageWheelR ? this._cageWheelR[w] : def.wheelR;
      const contact = (n.pos.y - gh.h) <= wRad + 0.07;
      this['contact'+w] = contact;
      if (!contact){
        // airborne: the tire only cools (half rate — no slip heat,
        // and no forced airflow model either)
        this.tireTemp[w] -= (this.tireTemp[w]-TIRE_AMBIENT) * def.tireCool * 0.5 * h;
        this.tireGrip[w] = tireGripFactor(this.tireTemp[w]);
        continue;
      }
      const isFront = w < 2;
      const driven = def.drive==='4WD' || (def.drive==='FWD' && isFront) || (def.drive==='RWD' && !isFront);
      const sa = isFront ? this.steerAngle : 0;
      // wheel rolling direction (car fwd rotated by steer, in world)
      let dx = frame.fwd.x*Math.cos(sa) - frame.right.x*Math.sin(sa);
      let dy = frame.fwd.y*Math.cos(sa) - frame.right.y*Math.sin(sa);
      let dz = frame.fwd.z*Math.cos(sa) - frame.right.z*Math.sin(sa);
      // project onto ground plane
      const dn = dx*gh.normal.x + dy*gh.normal.y + dz*gh.normal.z;
      dx -= gh.normal.x*dn; dy -= gh.normal.y*dn; dz -= gh.normal.z*dn;
      const dl = Math.sqrt(dx*dx+dy*dy+dz*dz); if (dl < 1e-5) continue;
      dx/=dl; dy/=dl; dz/=dl;
      let mu = gh.surface==='road'?1.05 : gh.surface==='grass'?0.62 : gh.surface==='rock'?0.45 : 0.6;
      const slopeDeg = gh.slope*57.2958;
      if (slopeDeg > 35) mu *= 0.16; else if (slopeDeg > 20) mu *= lerp(1, 0.16, (slopeDeg-20)/15);
      // the tire itself: this car's compound (tireMu) at its current
      // temperature scales the surface grip — cold ~0.85x, optimal
      // window full, overheated fading (see tireGripFactor)
      const tGrip = tireGripFactor(this.tireTemp[w]);
      this.tireGrip[w] = tGrip;
      mu *= def.tireMu * tGrip;
      const load = totalMass*9.81/4;
      const loadMass = totalMass/4; // tire forces scale with the load the
      // wheel carries, not the light wheel node's own mass — otherwise yaw
      // damping and cornering grip are ~25x too weak and the car spins
      // lateral grip: kill velocity sideways to the rolling direction
      const vLatX = n.vel.x - dx*(n.vel.x*dx+n.vel.y*dy+n.vel.z*dz) - gh.normal.x*(n.vel.x*gh.normal.x+n.vel.y*gh.normal.y+n.vel.z*gh.normal.z);
      const vLatY = n.vel.y - dy*(n.vel.x*dx+n.vel.y*dy+n.vel.z*dz) - gh.normal.y*(n.vel.x*gh.normal.x+n.vel.y*gh.normal.y+n.vel.z*gh.normal.z);
      const vLatZ = n.vel.z - dz*(n.vel.x*dx+n.vel.y*dy+n.vel.z*dz) - gh.normal.z*(n.vel.x*gh.normal.x+n.vel.y*gh.normal.y+n.vel.z*gh.normal.z);
      let gripRate = gh.surface==='road'?9:6;
      if (input.handbrake && !isFront) gripRate *= 0.3;
      let gx = -vLatX*loadMass*gripRate, gy = -vLatY*loadMass*gripRate, gz = -vLatZ*loadMass*gripRate;
      const gl = Math.sqrt(gx*gx+gy*gy+gz*gz), gCap = mu*load*0.9; // lateral
      // grip saturates below every car's roll threshold: tires slide before
      // the car can trip over its own cornering force on flat ground
      if (gl > gCap && gl > 0){ const sc = gCap/gl; gx*=sc; gy*=sc; gz*=sc; }
      // split between the wheel node and its strut mount: the suspension
      // transmits this force to the chassis anyway, and applying it all to
      // the 13 kg wheel node makes the response numerically stiff and
      // starves the chassis of yaw damping (fishtailing)
      F[wi3] += gx*0.4; F[wi3+1] += gy*0.4; F[wi3+2] += gz*0.4;
      if (this.targetNodes > RES_TARGET_DEFAULT){
        // high-resolution cages hold their mounts more softly, and the
        // cross-coupled loop (force from the WHEEL's velocity applied at
        // the MOUNT, one substep of lag) rings there. The mount's share
        // instead damps the mount's own lateral velocity — the same force
        // in steady cornering (wheel and mount velocities agree), but a
        // pure damper, not a feedback loop, in transients.
        const mn = nodes[mi];
        const mLatX = mn.vel.x - dx*(mn.vel.x*dx+mn.vel.y*dy+mn.vel.z*dz) - gh.normal.x*(mn.vel.x*gh.normal.x+mn.vel.y*gh.normal.y+mn.vel.z*gh.normal.z);
        const mLatY = mn.vel.y - dy*(mn.vel.x*dx+mn.vel.y*dy+mn.vel.z*dz) - gh.normal.y*(mn.vel.x*gh.normal.x+mn.vel.y*gh.normal.y+mn.vel.z*gh.normal.z);
        const mLatZ = mn.vel.z - dz*(mn.vel.x*dx+mn.vel.y*dy+mn.vel.z*dz) - gh.normal.z*(mn.vel.x*gh.normal.x+mn.vel.y*gh.normal.y+mn.vel.z*gh.normal.z);
        let mx = -mLatX*loadMass*gripRate, my = -mLatY*loadMass*gripRate, mz = -mLatZ*loadMass*gripRate;
        const ml = Math.sqrt(mx*mx+my*my+mz*mz);
        if (ml > gCap && ml > 0){ const sc = gCap/ml; mx*=sc; my*=sc; mz*=sc; }
        F[mi3] += mx*0.6; F[mi3+1] += my*0.6; F[mi3+2] += mz*0.6;
      } else {
        F[mi3] += gx*0.6; F[mi3+1] += gy*0.6; F[mi3+2] += gz*0.6;
      }
      // longitudinal
      const vF = n.vel.x*dx + n.vel.y*dy + n.vel.z*dz;
      const nDriven = def.drive==='4WD'?4:2;
      let fLongMag = 0; // |longitudinal tire force| — feeds tire heating
      if (driven && this.throttleSm > 0){
        let f = this.throttleSm * Math.min(def.engineForce, def.power/Math.max(4, Math.abs(fSpeed))) / nDriven;
        f = Math.min(f, mu*load);
        fLongMag = f;
        // half the drive force enters at the strut mount (chassis height):
        // applying it all at the light wheel node surges the wheel and
        // drags the nose down through the diagonal suspension links
        F[wi3] += dx*f*0.5; F[wi3+1] += dy*f*0.5; F[wi3+2] += dz*f*0.5;
        F[mi3] += dx*f*0.5; F[mi3+1] += dy*f*0.5; F[mi3+2] += dz*f*0.5;
      }
      if (driven && input.reverse > 0){
        let f = input.reverse * def.engineForce*0.45 / nDriven;
        f = Math.min(f, mu*load);
        if (vF > 0.5){ const bf = Math.min(vF*loadMass*6, mu*load*1.4); fLongMag = bf; F[wi3] -= dx*bf; F[wi3+1] -= dy*bf; F[wi3+2] -= dz*bf; }
        else { fLongMag = f; F[wi3] -= dx*f; F[wi3+1] -= dy*f; F[wi3+2] -= dz*f; }
      } else if (input.brake){
        const bf = clamp(-vF*loadMass*6, -mu*load*1.5, mu*load*1.5);
        fLongMag = Math.abs(bf);
        F[wi3] += dx*bf; F[wi3+1] += dy*bf; F[wi3+2] += dz*bf;
      }
      if (input.handbrake && !isFront){
        const bf = clamp(-vF*loadMass*5, -mu*load*1.3, mu*load*1.3);
        fLongMag = Math.max(fLongMag, Math.abs(bf));
        F[wi3] += dx*bf; F[wi3+1] += dy*bf; F[wi3+2] += dz*bf;
      }
      if (!input.throttle && !input.reverse && !input.brake){
        // parking hold at crawl speed (spring-like, capped by traction);
        // above crawl, rolling resistance is a small ~constant force —
        // a velocity-proportional force scaled by load mass would brake
        // the car at ~9 m/s^2 and ruin every crash run-up
        let rf;
        if (Math.abs(vF) < 2.5) rf = clamp(-vF * loadMass * 8, -mu*load*1.2, mu*load*1.2);
        else rf = -Math.sign(vF) * (0.012*load + Math.abs(vF)*6);
        fLongMag = Math.abs(rf);
        F[wi3] += dx*rf; F[wi3+1] += dy*rf; F[wi3+2] += dz*rf;
      } else {
        const rf = -clamp(vF * 30, -42, 42);
        fLongMag = Math.max(fLongMag, Math.abs(rf));
        F[wi3] += dx*rf; F[wi3+1] += dy*rf; F[wi3+2] += dz*rf;
      }
      // tire temperature: slip power heats, exponential approach to
      // ambient cools. Slip speed = lateral slip + a longitudinal
      // proxy (a driven wheel under throttle spins against the road
      // hardest at low speed; hard braking drags the patch). The heat
      // rate scales with utilization — applied force over the grip
      // cap — so cruising barely warms the tires while a burnout or
      // a locked stop cooks them.
      let longSlip = 0;
      if (driven && this.throttleSm > 0.05)
        longSlip = this.throttleSm * clamp(1 - Math.abs(vF)/12, 0, 1) * 7;
      else if (input.brake || (input.reverse > 0 && vF > 0.5))
        longSlip = Math.min(Math.abs(vF), 8) * 0.3;
      const slipSpd = Math.sqrt(vLatX*vLatX + vLatY*vLatY + vLatZ*vLatZ) + longSlip;
      const util = clamp(Math.sqrt(gx*gx + gy*gy + gz*gz + fLongMag*fLongMag)/(mu*load), 0, 1.2);
      const Tn = this.tireTemp[w] + (def.tireHeat * slipSpd * util - (this.tireTemp[w]-TIRE_AMBIENT) * def.tireCool) * h;
      this.tireTemp[w] = Tn < 5 ? 5 : (Tn > 160 ? 160 : Tn);
      this.wheelSpin[w] += (vF/wRad)*h;
    }
    // aero drag (on the shared center velocity, spread over nodes)
    const spd = Math.sqrt(cvX*cvX+cvY*cvY+cvZ*cvZ);
    if (spd > 0.1){
      const dragA = def.drag * spd; // accel per unit velocity
      for (let i=0, i3=0;i<nodes.length;i++, i3+=3){ F[i3] -= cvX*dragA*nodes[i].mass; F[i3+1] -= cvY*dragA*nodes[i].mass*0.3; F[i3+2] -= cvZ*dragA*nodes[i].mass; }
    }
    // integrate (beam forces subcycled at high resolution — see above)
    const hh = h/sub2N;
    for (let s2=0; s2<sub2N; s2++){
      let Ft = F;
      if (sub2N > 1){
        Ft = this._Fs;
        Ft.set(F); // flat copy of the external forces into the subcycle buffer
      }
      addBeamForces(Ft, s2 === sub2N-1);
      for (let i=0, i3=0;i<nodes.length;i++, i3+=3){
        const n = nodes[i], im = hh/n.mass;
        n.vel.x += Ft[i3]*im; n.vel.y += Ft[i3+1]*im; n.vel.z += Ft[i3+2]*im;
        // safety clamp: the sim must never explode (squared pre-check:
        // the sqrt only runs for a node actually past the limit)
        const sv2 = n.vel.x*n.vel.x + n.vel.y*n.vel.y + n.vel.z*n.vel.z;
        if (sv2 > 8100){ const sv = Math.sqrt(sv2), sc = 90/sv; n.vel.x*=sc; n.vel.y*=sc; n.vel.z*=sc; }
        n.pos.x += n.vel.x*hh; n.pos.y += n.vel.y*hh; n.pos.z += n.vel.z*hh;
      }
    }
    // hard beam displacement limit, applied after the beams have moved
    // the nodes and before contacts resolve — see enforceBeamLimits.
    // The projection count is remembered: the end-of-substep clamp
    // below only needs to run when something in this substep could
    // have pushed a beam past its bound (v2.7.1 perf: an unconditional
    // second full scan every substep cost ~+25% on the @1000 drive
    // loop, where in clean driving nothing ever projects).
    const midProj = this.enforceBeamLimits();
    const scBefore = this.scContacts, hitsBefore = this.groundHits + this.obstacleHits;
    // self-collision: panels of this same car may not pass through
    // each other — once per substep, see selfCollide
    this.selfCollide();
    // velocity-level flex damping (jelly control), gated off while a
    // crash impact is in progress — see dampFlex
    this.dampFlex(h);
    // collisions
    const oCounts = ogrid.counts, oIdxA = ogrid.idx, ogx = ogrid.ocx, ogz = ogrid.ocz;
    for (let i=0;i<nodes.length;i++){
      const n = nodes[i];
      // height-only query first (see TrackWorld._groundHOnly): the
      // full gradient query runs only for a node actually in the
      // ground — identical height float either way, and the normal
      // is consumed only inside the penetration branch below
      const ghH = world._groundHOnly(n.pos.x, n.pos.z, this.sHint, 20);
      const pen = (ghH + n.radius) - n.pos.y;
      if (pen > 0){
        const gh = ghS; world._groundHeightInto(n.pos.x, n.pos.z, this.sHint, gh, gh.normal, 20);
        const nn = gh.normal;
        if (nn.y > 0.35){ n.pos.y += pen; }
        else { n.pos.x += nn.x*pen; n.pos.z += nn.z*pen; n.pos.y += nn.y*pen; }
        const vn = n.vel.x*nn.x + n.vel.y*nn.y + n.vel.z*nn.z;
        if (vn < -4.5 && n.kind !== 'wheel' && this.groundHitCooldown <= 0){ this.groundHits++; this.groundHitCooldown = 0.3; }
        if (vn < 0){ n.vel.x -= nn.x*vn; n.vel.y -= nn.y*vn; n.vel.z -= nn.z*vn; }
        // tangential friction as a RATE (per second), not per substep —
        // a per-substep fraction at 480 Hz would act like a brake on everything
        const fr = n.kind==='wheel' ? Math.min(1, 1.2*h) : Math.min(1, 12*h);
        const vn2 = n.vel.x*nn.x + n.vel.y*nn.y + n.vel.z*nn.z;
        n.vel.x -= (n.vel.x - nn.x*vn2)*fr; n.vel.y -= (n.vel.y - nn.y*vn2)*fr; n.vel.z -= (n.vel.z - nn.z*vn2)*fr;
      }
      // obstacles: vertical cylinders — only the ones in this node's
      // spatial-grid cells (see step()); the response math is unchanged
      const ncx = Math.floor(n.pos.x/4) - ogx + 20, ncz = Math.floor(n.pos.z/4) - ogz + 20;
      for (let cellZ=-1; cellZ<=1; cellZ++){
        const gz = ncz + cellZ; if (gz < 0 || gz >= 41) continue;
        for (let cellX=-1; cellX<=1; cellX++){
          const gx = ncx + cellX; if (gx < 0 || gx >= 41) continue;
          const ci = gz*41 + gx;
          for (let oi2 = oCounts[ci]; oi2 < oCounts[ci+1]; oi2++){
            const o = obstacles[oIdxA[oi2]];
          if (n.pos.y > ghH + o.h + n.radius) continue;
          const dx = n.pos.x-o.x, dz = n.pos.z-o.z;
          const rr = o.r + n.radius, d2 = dx*dx+dz*dz;
          if (d2 >= rr*rr || d2 < 1e-9) continue;
          const d = Math.sqrt(d2), nx = dx/d, nz = dz/d, push = (rr-d)*0.55;
          // penalty-style contact: resolve ~55% of penetration and inward
          // velocity per substep instead of a rigid projection. A perfectly
          // rigid contact absorbs the whole crash into the constraint and the
          // beams never get to crush; a slightly soft contact lets the
          // structure do the absorbing (equilibrium penetration at 100 km/h
          // is ~0.1 m, far less than any obstacle radius — no tunnelling)
          n.pos.x += nx*push; n.pos.z += nz*push;
          const vn = n.vel.x*nx + n.vel.z*nz;
          if (vn < 0){
            n.vel.x -= nx*vn*0.55; n.vel.z -= nz*vn*0.55;
            // tangential scrape friction (rate-scaled)
            const sf = 1 - Math.min(0.5, 25*h);
            n.vel.x *= sf; n.vel.z *= sf;
            if (vn < -3 && this.hitCooldown <= 0){ this.obstacleHits++; this.hitCooldown = 0.25; }
          }
          }
        }
      }
    }
    // v2.7.1: second displacement clamp, at the very end of the
    // substep. The mid-substep clamp bounds what the force pass
    // sees, but self-collision, ground and obstacle resolves all
    // run AFTER it and move nodes positionally by centimetres —
    // on a 0.10 m beam a 4 cm contact correction is 0.4 of strain,
    // so the state the world (and the renderer) actually saw could
    // sit far outside the bound (measured: @500 wall crash peak
    // tensile 1.78x and peak compressive 0.20x against a 1.55x /
    // 0.45x clamp). Re-clamping here makes "an unbroken beam sits
    // within its clampDisp of rest" an invariant of every completed
    // substep; the pass is a squared-distance precheck over the
    // beams and is a strict no-op for the overwhelming majority.
    // Two sweeps here (see _enforceSweep): one sweep's Gauss-Seidel
    // residue left single beams at 1.58x / 0.32x against the bound.
    // The run is CONDITIONAL (see midProj above): it fires when
    // the mid-substep clamp projected anything, when self-collision
    // resolved a contact, or when a hard ground/obstacle hit was
    // counted this substep — exactly the events that can shove a
    // beam past its bound. In clean driving none of them fire and
    // the second scan costs nothing; in a crash all of them fire
    // constantly and the invariant holds every substep.
    if (midProj > 0 || this.scContacts !== scBefore ||
        (this.groundHits + this.obstacleHits) !== hitsBefore){
      this.enforceBeamLimits(2);
    }
  }
}
/* ---------------- Body skinning ----------------
   Each body vertex is anchored to the cage CELL it belongs to (the
   quad between two neighbouring sections and one ring segment) with
   bilinear weights over the cell's four corner nodes, plus a residual
   offset expressed in the CELL's own frame (built from the corners at
   rest, rebuilt from the corners every evaluation). When the cage
   crushes, the vertex rides its own panel: the bilinear point follows
   the cell's compression and shear, and the residual rotates with the
   panel instead of with the whole car. The old skinning (3 nearest
   nodes, offsets rotated by the single global car frame) left panels
   behind whenever one part of the car folded and the rest did not —
   in a 100 km/h crash its vertices sat ~0.57 m (p98; p50 0.139 m) away
   from where their own cage neighbourhood put them; this scheme
   measures ~0.33 m p98 and 0.021 m p50 on the same test, and what
   remains is genuine panel shear plus the large-offset mirror/bumper
   corners in fold zones, not detachment (test 32).
   Vertices past the end rings (bumper prisms, grille, lights) have no
   cell: they keep 3-nearest-node anchors, but their offsets rotate
   with the anchor TRIANGLE's own frame (rest basis -> current basis)
   instead of the global car frame. */
/* orthonormal basis [e1, e2, n] (flat 9) of the triangle p->q->r, or null */
function triBasis(p, q, r){
  let e1x = q.x-p.x, e1y = q.y-p.y, e1z = q.z-p.z;
  const l1 = Math.sqrt(e1x*e1x + e1y*e1y + e1z*e1z); if (l1 < 1e-9) return null;
  e1x/=l1; e1y/=l1; e1z/=l1;
  const e2x = r.x-p.x, e2y = r.y-p.y, e2z = r.z-p.z;
  let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
  const ln = Math.sqrt(nx*nx + ny*ny + nz*nz); if (ln < 1e-9) return null;
  nx/=ln; ny/=ln; nz/=ln;
  const f2x = ny*e1z - nz*e1y, f2y = nz*e1x - nx*e1z, f2z = nx*e1y - ny*e1x;
  return [e1x,e1y,e1z, f2x,f2y,f2z, nx,ny,nz];
}
/* frame [r, u, f] (flat 9) of a cage cell from its four corners:
   r = ring direction (segment j -> j+1), f = toward the front
   section, u completes the triad. Null when the cell is degenerate. */
function patchFrame(p00, p01, p10, p11){
  let exx = (p01.x+p11.x)*0.5 - (p00.x+p10.x)*0.5, exy = (p01.y+p11.y)*0.5 - (p00.y+p10.y)*0.5, exz = (p01.z+p11.z)*0.5 - (p00.z+p10.z)*0.5;
  let ezx = (p00.x+p01.x)*0.5 - (p10.x+p11.x)*0.5, ezy = (p00.y+p01.y)*0.5 - (p10.y+p11.y)*0.5, ezz = (p00.z+p01.z)*0.5 - (p10.z+p11.z)*0.5;
  const lx = Math.sqrt(exx*exx + exy*exy + exz*exz), lz = Math.sqrt(ezx*ezx + ezy*ezy + ezz*ezz);
  if (lx < 1e-7 || lz < 1e-7) return null;
  exx/=lx; exy/=lx; exz/=lx; ezx/=lz; ezy/=lz; ezz/=lz;
  let eyx = ezy*exz - ezz*exy, eyy = ezz*exx - ezx*exz, eyz = ezx*exy - ezy*exx;
  const ly = Math.sqrt(eyx*eyx + eyy*eyy + eyz*eyz);
  if (ly < 1e-7) return null;
  eyx/=ly; eyy/=ly; eyz/=ly;
  const rxx = eyy*ezz - eyz*ezy, rxy = eyz*ezx - eyx*ezz, rxz = eyx*ezy - eyy*ezx;
  return [rxx,rxy,rxz, eyx,eyy,eyz, ezx,ezy,ezz];
}
function buildSkinAnchors(car, verts){
  const nodes = car.nodes, nSec = car.gridS, nP = car.gridP, L = car.def.length;
  const secZ = car.secZ, rings = car.secRings;
  const n = verts.length/3, out = new Array(n);
  for (let v=0; v<n; v++){
    const vx = verts[v*3], vy = verts[v*3+1], vz = verts[v*3+2];
    const zf = vz/L;
    if (zf > secZ[0] + 0.02 || zf < secZ[nSec-1] - 0.02){
      // overhang: 3 nearest non-wheel nodes, offsets kept per node
      let d0=1e18, d1=1e18, d2=1e18, i0=-1, i1=-1, i2=-1;
      for (let ii=0; ii<nodes.length; ii++){
        const nd = nodes[ii]; if (nd.kind === 'wheel') continue;
        const dx = vx-nd.rest.x, dy = vy-nd.rest.y, dz = vz-nd.rest.z;
        const dd = dx*dx + dy*dy + dz*dz;
        if (dd < d0){ d2=d1; i2=i1; d1=d0; i1=i0; d0=dd; i0=ii; }
        else if (dd < d1){ d2=d1; i2=i1; d1=dd; i1=ii; }
        else if (dd < d2){ d2=dd; i2=ii; }
      }
      const ds = [[d0,i0],[d1,i1],[d2,i2]];
      const ws = ds.map(d=>1/(Math.sqrt(d[0])+0.05)); const sum = ws[0]+ws[1]+ws[2];
      out[v] = { mode:1, pred:[i0,i1,i2],
        anchors:ds.map((d,k)=>({ i:d[1], w:ws[k]/sum,
          ox:vx-nodes[d[1]].rest.x, oy:vy-nodes[d[1]].rest.y, oz:vz-nodes[d[1]].rest.z })) };
      continue;
    }
    // cell mode: section pair bracketing z
    let i = 0;
    while (i < nSec-2 && secZ[i+1] > zf) i++;
    const dzs = (secZ[i] - secZ[i+1]) || 1;
    const tz = clamp((secZ[i] - zf)/dzs, 0, 1);
    // ring segment: nearest segment of section i's ring in the x/y plane
    const ring = rings[i];
    let bj = 0, bt = 0, bd = 1e18;
    for (let j=0; j<nP; j++){
      const a = nodes[ring[j]].rest, b = nodes[ring[(j+1)%nP]].rest;
      const abx = b.x-a.x, aby = b.y-a.y;
      const l2 = abx*abx + aby*aby || 1;
      let t = ((vx-a.x)*abx + (vy-a.y)*aby)/l2; t = clamp(t, 0, 1);
      const px = a.x + abx*t, py = a.y + aby*t;
      const dd = (vx-px)*(vx-px) + (vy-py)*(vy-py);
      if (dd < bd){ bd = dd; bj = j; bt = t; }
    }
    const c00 = ring[bj], c01 = ring[(bj+1)%nP], c10 = rings[i+1][bj], c11 = rings[i+1][(bj+1)%nP];
    const R = id => nodes[id].rest;
    const bx = (R(c00).x*(1-bt) + R(c01).x*bt)*(1-tz) + (R(c10).x*(1-bt) + R(c11).x*bt)*tz;
    const by = (R(c00).y*(1-bt) + R(c01).y*bt)*(1-tz) + (R(c10).y*(1-bt) + R(c11).y*bt)*tz;
    const bz = (R(c00).z*(1-bt) + R(c01).z*bt)*(1-tz) + (R(c10).z*(1-bt) + R(c11).z*bt)*tz;
    // residual expressed in the REST patch frame: at evaluation time
    // it is re-applied through the CURRENT patch frame, so the offset
    // follows the panel's own rotation, not the car's
    let ox = vx-bx, oy = vy-by, oz = vz-bz;
    const Fr = patchFrame(R(c00), R(c01), R(c10), R(c11));
    if (Fr){
      const lx2 = Fr[0]*ox + Fr[1]*oy + Fr[2]*oz;
      const ly2 = Fr[3]*ox + Fr[4]*oy + Fr[5]*oz;
      const lz2 = Fr[6]*ox + Fr[7]*oy + Fr[8]*oz;
      ox = lx2; oy = ly2; oz = lz2;
    }
    out[v] = { mode:0, c00:c00, c01:c01, c10:c10, c11:c11, tr:bt, tz:tz,
               ox:ox, oy:oy, oz:oz, pred:[c00, c01, c10] };
  }
  return out;
}
function skinPositions(car, anchors, out){
  const nodes = car.nodes;
  const gf = car.frame();
  const GF = [gf.right.x,gf.right.y,gf.right.z, gf.up.x,gf.up.y,gf.up.z, gf.fwd.x,gf.fwd.y,gf.fwd.z];
  for (let v=0; v<anchors.length; v++){
    const a = anchors[v];
    if (a.mode === 1){
      const p0 = nodes[a.anchors[0].i], p1 = nodes[a.anchors[1].i], p2 = nodes[a.anchors[2].i];
      const Br = triBasis(p0.rest, p1.rest, p2.rest);
      const Bc = triBasis(p0.pos, p1.pos, p2.pos);
      let x = 0, y = 0, z = 0;
      if (Br && Bc){
        for (const an of a.anchors){
          const nd = nodes[an.i];
          const tx = Br[0]*an.ox + Br[1]*an.oy + Br[2]*an.oz;
          const ty = Br[3]*an.ox + Br[4]*an.oy + Br[5]*an.oz;
          const tz2 = Br[6]*an.ox + Br[7]*an.oy + Br[8]*an.oz;
          x += an.w*(nd.pos.x + Bc[0]*tx + Bc[3]*ty + Bc[6]*tz2);
          y += an.w*(nd.pos.y + Bc[1]*tx + Bc[4]*ty + Bc[7]*tz2);
          z += an.w*(nd.pos.z + Bc[2]*tx + Bc[5]*ty + Bc[8]*tz2);
        }
      } else {
        for (const an of a.anchors){
          const nd = nodes[an.i];
          x += an.w*(nd.pos.x + GF[0]*an.ox + GF[3]*an.oy + GF[6]*an.oz);
          y += an.w*(nd.pos.y + GF[1]*an.ox + GF[4]*an.oy + GF[7]*an.oz);
          z += an.w*(nd.pos.z + GF[2]*an.ox + GF[5]*an.oy + GF[8]*an.oz);
        }
      }
      out[v*3] = x; out[v*3+1] = y; out[v*3+2] = z;
      continue;
    }
    const p00 = nodes[a.c00].pos, p01 = nodes[a.c01].pos, p10 = nodes[a.c10].pos, p11 = nodes[a.c11].pos;
    const tr = a.tr, tz = a.tz;
    const bx = (p00.x*(1-tr) + p01.x*tr)*(1-tz) + (p10.x*(1-tr) + p11.x*tr)*tz;
    const by = (p00.y*(1-tr) + p01.y*tr)*(1-tz) + (p10.y*(1-tr) + p11.y*tr)*tz;
    const bz = (p00.z*(1-tr) + p01.z*tr)*(1-tz) + (p10.z*(1-tr) + p11.z*tr)*tz;
    const Fc = patchFrame(p00, p01, p10, p11);
    const F = Fc || GF;
    out[v*3]   = bx + F[0]*a.ox + F[3]*a.oy + F[6]*a.oz;
    out[v*3+1] = by + F[1]*a.ox + F[4]*a.oy + F[7]*a.oz;
    out[v*3+2] = bz + F[2]*a.ox + F[5]*a.oy + F[8]*a.oz;
  }
  return out;
}

function spawnCar(defId, world, s){
  const def = CAR_DEFS.find(d=>d.id===defId) || CAR_DEFS[0];
  const defIndex = CAR_DEFS.indexOf(def);
  const car = new SoftBodyCar(def, world, carRes[defIndex]);
  car.placeOnTrack(world, (s===undefined?100:s), 0);
  // pre-settle the suspension with damage recording off, so a freshly
  // spawned car is at equilibrium with a genuinely untouched structure.
  // The settle is QUASI-STATIC: velocities are zeroed every few steps so
  // the car sinks onto its springs in small increments instead of
  // dropping with kinetic energy. A free drop at high node counts knocks
  // the strut mounts off their perches (they end up resting on the
  // ground with the floor dragged down); the same structure is perfectly
  // stable when it arrives at equilibrium gently.
  car.noDeform = true;
  car._noSleep = true; // the settle must run to completion — no sleeping mid-spawn
  const idle = { throttle:0, reverse:0, brake:0, steer:0, handbrake:0 };
  for (let i=0;i<150;i++){
    car.step(1/60, idle, world);
    if (i%6 === 5) car.setVelocity(0,0,0);
  }
  car.noDeform = false;
  car._noSleep = false;
  car.setVelocity(0,0,0);
  return car;
}
/* spawn a CageData car (v2.7): the def is a clone of the sedan's
   (drive layout, power, drag, tire model — the cage format carries
   none of those) with the cage's total mass and first wheel radius
   substituted; the structure itself comes entirely from the cage.
   Placement and the quasi-static settle mirror spawnCar exactly. */
function spawnCageCar(cage, world, s){
  const base = CAR_DEFS[0];
  const def = Object.assign({}, base, {
    id:'cage-' + (cage.name || 'car'), name:cage.name || base.name,
    mass:(cage.totalMass > 0 ? cage.totalMass : base.mass)
  });
  if (cage.wheels && cage.wheels.length && cage.wheels[0].radius) def.wheelR = cage.wheels[0].radius;
  const car = new SoftBodyCar(def, world, cage.nodes.length, { cage:cage });
  car.placeOnTrack(world, (s===undefined?100:s), 0);
  car.noDeform = true;
  car._noSleep = true;
  const idle = { throttle:0, reverse:0, brake:0, steer:0, handbrake:0 };
  for (let i=0;i<150;i++){
    car.step(1/60, idle, world);
    if (i%6 === 5) car.setVelocity(0,0,0);
  }
  car.noDeform = false;
  car._noSleep = false;
  car.setVelocity(0,0,0);
  return car;
}
if (typeof globalThis !== 'undefined'){
  globalThis.__SIM = { TrackWorld:TrackWorld, SoftBodyCar:SoftBodyCar, Beam:Beam, CAR_DEFS:CAR_DEFS,
    spawnCar:spawnCar, spawnCageCar:spawnCageCar, ROAD_HALF:ROAD_HALF, CLIFF_FIRST:CLIFF_FIRST, CLIFF_PERIOD:CLIFF_PERIOD, CLIFF_LEN:CLIFF_LEN,
    RES_TARGET_DEFAULT:RES_TARGET_DEFAULT, resNameFor:resNameFor, profileAt:profileAt,
    chooseGrid:chooseGrid, ringPoints:ringPoints, carRes:carRes, BARRIER_LAT:BARRIER_LAT,
    MATERIALS:MATERIALS, zoneFor:zoneFor, TIRE_AMBIENT:TIRE_AMBIENT, tireGripFactor:tireGripFactor,
    beamAxialForce:beamAxialForce, dampAlpha:dampAlpha, dampFilterStep:dampFilterStep, DAMP_CUTOFF_HZ:DAMP_CUTOFF_HZ, supportOpt:supportOpt,
    selfCollOpt:selfCollOpt, SC_GROUPS:SC_GROUPS,
    buildSkinAnchors:buildSkinAnchors, skinPositions:skinPositions, triBasis:triBasis, patchFrame:patchFrame };
}
// === SIM CORE END ===
