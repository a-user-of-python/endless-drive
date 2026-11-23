'use strict';
/* BeamNG map converter: 100% client-side, converts what is IN the zip and
   reports every referenced-but-absent asset. No THREE dependency. */
const _DAE = (typeof globalThis!=='undefined' && globalThis.__DAE) || (typeof require!=='undefined' ? safeRequire('./dae.js') : null);
const _DDS = (typeof globalThis!=='undefined' && globalThis.__DDS) || (typeof require!=='undefined' ? safeRequire('./dds.js') : null);
function safeRequire(p){ try{ return require(p); }catch(e){ return null; } }
function decodeText(bytes){ if(typeof TextDecoder!=='undefined') return new TextDecoder('utf-8').decode(bytes); let s=''; for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return s; }
function normPath(p){ return String(p||'').replace(/\\/g,'/').replace(/^\.?\//,''); }
function lowerMap(zipMap){ const m=new Map(); for(const k of zipMap.keys()) m.set(normPath(k).toLowerCase(), k); return m; }
function getFile(zipMap, lower, path){ const k=lower.get(normPath(path).toLowerCase()); return k===undefined?null:zipMap.get(k); }
function hasFile(lower,path){ return lower.has(normPath(path).toLowerCase()); }

/* ---------- .ter reader (BeamNG terrain, version 9) ----------
   Layout — FIXED, verified against real parser code (Grille.BeamNG.Lib
   TerrainV9Serializer, Torque3D terrFile; see
   ~/workspace/research_notes/beamng-ter-format-20261122/report.md):
     offset 0:        uint8 version (must be 9)
     offset 1:        uint32LE grid size N (samples per side)
     offset 5:        N*N uint16LE height samples, index = x + y*N,
                      first sample = SW (bottom-left) corner, rows
                      advance south→north.
                      height_m = sample/65535 * maxHeight, where
                      maxHeight is NOT in this file and NOT in
                      theTerrain.terrain.json — it is the TerrainBlock
                      item's property in items.level.json.
     offset 5+2N²:    N*N uint8 layer map (material index; 0xFF = hole)
     offset 5+3N²:    uint32LE material count, then per material a
                      length-prefixed UTF-8 name (uint8 length; a 0xFF
                      prefix byte means a uint16LE length follows).
   This reader is STRICT: it parses exactly this layout, verifies the
   size equation 5 + 3N² + 4 + Σ(1+len(name)) against the file length
   (a small trailing remainder is tolerated and reported via
   trailingBytes), and throws on any mismatch. There is NO layout
   guessing: the v2.7 reader "validated" a wrong 12-byte-header layout
   by length alone and produced a spiked garbage heightfield on a real
   map. A wrong file must fail loudly, never decode wrong. */
function terParseNames(bytes, dv, offset){
  if(offset+4 > bytes.length) return null;
  const count=dv.getUint32(offset, true);
  if(count>4096) return null;
  let pos=offset+4; const names=[];
  for(let i=0;i<count;i++){
    if(pos>=bytes.length) return null;
    let len=bytes[pos]; pos+=1;
    if(len===0xFF){ if(pos+2>bytes.length) return null; len=dv.getUint16(pos, true); pos+=2; }
    if(pos+len>bytes.length) return null;
    names.push(decodeText(bytes.subarray(pos, pos+len))); pos+=len;
  }
  return { names:names, end:pos };
}
function parseTer(bytes, opts){
  opts=opts||{};
  if(!bytes || bytes.length<5) throw new Error('.ter: file too short ('+(bytes?bytes.length:0)+' bytes) — cannot hold the 5-byte v9 header');
  const dv=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version=bytes[0];
  if(version!==9) throw new Error('.ter: unsupported version '+version+' (expected 9 — the BeamNG v9 layout is the only layout this reader decodes)');
  const N=dv.getUint32(1, true);
  if(!(N>=2 && N<=8192)) throw new Error('.ter: implausible grid size N='+N+' in the header');
  const heightsEnd=5+N*N*2, layerEnd=heightsEnd+N*N;
  if(bytes.length<layerEnd+4) throw new Error('.ter: truncated — '+bytes.length+' bytes cannot hold a '+N+'×'+N+' heightmap + layer map + material count (needs at least '+(layerEnd+4)+')');
  const parsed=terParseNames(bytes, dv, layerEnd);
  if(!parsed){
    const v8=(bytes.length>=layerEnd+N*N+4) ? terParseNames(bytes, dv, layerEnd+N*N) : null;
    if(v8 && bytes.length-v8.end<=4096) throw new Error('.ter: material names do not parse at the v9 offset '+layerEnd+' but do parse one layer-map later — this file carries the deprecated v8 layerTextureMap and is not a plain v9 file');
    throw new Error('.ter: material names do not parse at offset '+layerEnd+' (count/lengths inconsistent with the '+bytes.length+'-byte file) — the file does not match the v9 layout');
  }
  const trailingBytes=bytes.length-parsed.end;
  if(trailingBytes>4096) throw new Error('.ter: size equation mismatch — the v9 sections end at byte '+parsed.end+' but the file has '+bytes.length+' bytes ('+trailingBytes+' unexplained trailing bytes)');
  const samples=new Uint16Array(N*N);
  for(let i=0;i<N*N;i++) samples[i]=dv.getUint16(5+i*2, true);
  const layerMap=Uint8Array.prototype.slice.call(bytes, heightsEnd, layerEnd);
  let holeCount=0, maxLayerIndex=-1;
  for(let i=0;i<N*N;i++){ const li=layerMap[i]; if(li===0xFF) holeCount++; else if(li>maxLayerIndex) maxLayerIndex=li; }
  const maxHeight=(typeof opts.maxHeight==='number' && opts.maxHeight>0) ? opts.maxHeight : null;
  const heights=new Float32Array(N*N); const scale=(maxHeight||1)/65535;
  for(let i=0;i<N*N;i++) heights[i]=samples[i]*scale;
  return { size:N, version:9, layout:'v9', samples:samples, heights:heights, maxHeightApplied:maxHeight,
           layerMap:layerMap, materials:parsed.names, holeCount:holeCount, maxLayerIndex:maxLayerIndex,
           trailingBytes:trailingBytes, sizeEquation:{ expected:parsed.end, actual:bytes.length } };
}
/* Sample the raw .ter grid in BeamNG coordinates: u = east, v = north,
   both in sample units (0..N-1, origin at the SW corner). The variant
   flags reinterpret the stored grid: flipNS = rows run north→south,
   transpose = samples stored column-major. Canonical (spec) is
   flipNS=false, transpose=false. */
function terSampleBilinear(samples, N, flipNS, transpose, u, v){
  function idx(bx, by){
    bx=Math.max(0, Math.min(N-1, bx)); by=Math.max(0, Math.min(N-1, by));
    if(!transpose) return (flipNS ? (N-1)-by : by)*N + bx;
    return bx*N + (flipNS ? (N-1)-by : by);
  }
  const x0=Math.floor(u), y0=Math.floor(v), fx=u-x0, fy=v-y0;
  const a=samples[idx(x0,y0)], b=samples[idx(x0+1,y0)], c=samples[idx(x0,y0+1)], d=samples[idx(x0+1,y0+1)];
  return a+(b-a)*fx+(c-a)*fy+(a-b-c+d)*fx*fy;
}
function terSampleStats(samples, layerMap, N){
  const stride=N>256 ? Math.ceil(N/256) : 1;
  let sum=0, cnt=0, max=0, sumAll=0, cntAll=0, borderSum=0, borderCnt=0;
  function solid(i){ return !layerMap || layerMap[i]!==0xFF; }
  for(let y=0;y<N;y+=stride) for(let x=0;x<N;x+=stride){
    const i=y*N+x, s=samples[i];
    if(s>max) max=s; sumAll+=s; cntAll++;
    if(x===0 || y===0 || x>=N-stride || y>=N-stride){ borderSum+=s; borderCnt++; }
    if(x+stride<N && solid(i) && solid(i+stride)){ sum+=Math.abs(samples[i+stride]-s)/stride; cnt++; }
    if(y+stride<N && solid(i) && solid(i+stride*N)){ sum+=Math.abs(samples[i+stride*N]-s)/stride; cnt++; }
  }
  return { meanAbsDiff: cnt?sum/cnt:0, maxSample:max, meanSample: cntAll?sumAll/cntAll:0, borderMean: borderCnt?borderSum/borderCnt:0 };
}
/* Scored combination search for whatever the files did NOT pin down.
   The v9 byte layout is never searched (it is proven, and parseTer has
   already enforced it as a gate — a combination that fails the byte
   checks cannot exist here). What can remain ambiguous:
     - maxHeight, when no TerrainBlock provides one
       (candidates 100/150/200/300/512/600/622 — bracketing the
       120–622 span observed in real levels; 300 is the guide value)
     - squareSize, when nothing pins it (candidates 0.5/1/2/4)
     - orientation: rows south→north (spec) vs flipped, × transposed
   Scoring (lower wins): slope plausibility — mean slope should sit
   near 0.25 (log-distance penalty); height/extent plausibility —
   max terrain height vs map extent outside 0.005..0.6 is penalised;
   and, when the level has SpawnSphere items, spawn ground sanity —
   the height sampled at each spawn's BeamNG position must sit near
   the spawn's own stored height. Spawn sanity is the only term that
   can discriminate orientation (grid smoothness is invariant under
   flips/transposes), and a spawn falling OUTSIDE a combination's
   extent counts as a large error, never as "no signal". Ties break
   toward squareSize 1 / maxHeight 300 (the common authoring values).
   The winner and the runner-up scores are recorded in the load
   report — the choice is visible, never silent.
   The spawn term samples the raw grid in BeamNG coordinates; that is
   the same computation the post-build agreement check performs
   through the CONVERTED engine positions: importMap records
   report.terrainChoice.spawnGroundErrorMeters from
   heightfield.heightAt(convertedSpawn) vs each spawn's stored
   height, so the winning orientation and the converted item
   placement are verified to agree end to end. */
function chooseTerrainCombo(ter, src){
  const N=ter.size, stats=terSampleStats(ter.samples, ter.layerMap, N);
  const mhList=src.maxHeight ? [src.maxHeight] : [100,150,200,300,512,600,622];
  const ssList=src.squareSize ? [src.squareSize] : [0.5,1,2,4];
  const orients=[{flipNS:false,transpose:false},{flipNS:true,transpose:false},{flipNS:false,transpose:true},{flipNS:true,transpose:true}];
  const spawns=(src.spawns||[]).filter(function(s){ return Array.isArray(s.position) && s.position.length>=3; });
  const combos=[];
  for(const o of orients) for(const mh of mhList) for(const ss of ssList){
    const meanSlope=stats.meanAbsDiff/65535*mh/ss;
    const slopePenalty=stats.meanAbsDiff===0 ? 0 : Math.abs(Math.log(meanSlope/0.25));
    const maxH=stats.maxSample/65535*mh, extent=N*ss, ratio=maxH/Math.max(1, extent);
    const ratioPenalty=ratio<0.005 ? Math.log(0.005/Math.max(ratio,1e-9)) : (ratio>0.6 ? Math.log(ratio/0.6) : 0);
    let spawnErr=null, spawnPenalty=0;
    if(spawns.length){
      const ox=src.tbPos ? src.tbPos[0] : -extent/2, oy=src.tbPos ? src.tbPos[1] : -extent/2;
      let err=0;
      for(const sp of spawns){
        const u=(sp.position[0]-ox)/ss, v=(sp.position[1]-oy)/ss;
        if(u<-1 || v<-1 || u>N || v>N){ err+=mh*0.5+Math.abs(sp.position[2]); continue; }
        const h=terSampleBilinear(ter.samples, N, o.flipNS, o.transpose, Math.max(0,Math.min(N-1,u)), Math.max(0,Math.min(N-1,v)))/65535*mh+(src.baseHeight||0);
        err+=Math.abs(h-sp.position[2]);
      }
      spawnErr=err/spawns.length; spawnPenalty=spawnErr/10;
    }
    combos.push({ flipNS:o.flipNS, transpose:o.transpose, maxHeight:mh, squareSize:ss,
                  score:slopePenalty+ratioPenalty+spawnPenalty, spawnErrorMeters:spawnErr,
                  prior:Math.abs(Math.log(ss/1))+Math.abs(Math.log(mh/300)) });
  }
  combos.sort(function(a,b){ const d=a.score-b.score; return Math.abs(d)>1e-6 ? d : a.prior-b.prior; });
  const win=combos[0];
  function pub(c){ return { maxHeight:c.maxHeight, squareSize:c.squareSize, flipNS:c.flipNS, transpose:c.transpose, score:c.score, spawnErrorMeters:c.spawnErrorMeters }; }
  return { maxHeight:win.maxHeight, squareSize:win.squareSize, flipNS:win.flipNS, transpose:win.transpose,
           score:win.score, spawnErrorMeters:win.spawnErrorMeters,
           runnersUp:combos.slice(1,4).map(pub), combosTested:combos.length,
           sources:{ maxHeight: src.maxHeight?'TerrainBlock':'search', squareSize: src.squareSize?'TerrainBlock':'search' },
           stats:{ meanAbsDiffSamples:stats.meanAbsDiff, maxSample:stats.maxSample, meanSample:stats.meanSample, borderMeanSample:stats.borderMean } };
}
/* ---------- heightfield ----------
   ONE orientation mapping, used identically by the physics sampler
   (BeamngWorld) and the renderer (mapworld samples heightAt too), so
   the two can never disagree:
     file sample (gx, gy): gx west→east, gy south→north, first sample
     = SW corner. Engine world: +x east, +z SOUTH — the map's north
     edge sits at z = -worldSize/2, its south edge at z = +worldSize/2.
   The engine grid is built as eng[ez*N+ex] with ex = gx (west→east)
   and ez = (N-1) - gy (ez 0 = north edge). The flipNS/transpose
   variants reinterpret the stored grid before this mapping (they are
   the importer's scored-search axes; default is the spec mapping).
   baseHeight (TerrainBlock position[2]) is added to every sample.
   Level ITEM placement uses this same mapping (see makeItemConverter
   / beamngHeading in the scene-items section): BeamNG [x east,
   y north, z up] becomes engine [x east, z = -north] relative to the
   TerrainBlock corner, so items, roads and spawns register with the
   terrain instead of sitting mirrored north<->south against it.
   Holes (layer byte 0xFF): the sampler keeps returning the stored
   height (BeamngWorld's interface has no hole concept and physics
   treats hole cells as solid at that height — a documented
   limitation), but holes are exposed via holeGrid / holeCount /
   isHoleAt(x,z), and the renderer drops triangles whose corners are
   all holes. */
function makeHeightfield(ter, squareSize, opts){
  opts=opts||{};
  const N=ter.size, ss=squareSize||1, worldSize=N*ss;
  const maxHeight=(typeof opts.maxHeight==='number' && opts.maxHeight>0) ? opts.maxHeight : (ter.maxHeightApplied||1);
  const baseHeight=opts.baseHeight||0, flipNS=!!opts.flipNS, transpose=!!opts.transpose;
  let samples=ter.samples;
  if(!samples){ // tolerate old-style {heights} inputs: resynthesise samples
    samples=new Uint16Array(N*N); const mh=ter.maxHeightApplied||1;
    for(let i=0;i<N*N;i++) samples[i]=Math.max(0, Math.min(65535, Math.round((ter.heights?ter.heights[i]:0)/mh*65535)));
  }
  const layer=ter.layerMap||null, scale=maxHeight/65535;
  const heights=new Float32Array(N*N), holeGrid=new Uint8Array(N*N);
  let holeCount=0;
  for(let ez=0; ez<N; ez++) for(let ex=0; ex<N; ex++){
    const bx=ex, by=(N-1)-ez; let si;
    if(!transpose) si=(flipNS ? (N-1)-by : by)*N + bx;
    else si=bx*N + (flipNS ? (N-1)-by : by);
    const di=ez*N+ex;
    heights[di]=samples[si]*scale+baseHeight;
    if(layer && layer[si]===0xFF){ holeGrid[di]=1; holeCount++; }
  }
  function heightAt(x,z){
    let gx=((x/worldSize)+0.5)*(N-1), gz=((z/worldSize)+0.5)*(N-1);
    gx=Math.max(0,Math.min(N-1.001,gx)); gz=Math.max(0,Math.min(N-1.001,gz));
    const ix=Math.floor(gx), iz=Math.floor(gz), fx=gx-ix, fz=gz-iz;
    const a=heights[iz*N+ix], b=heights[iz*N+ix+1], c=heights[(iz+1)*N+ix], d=heights[(iz+1)*N+ix+1];
    return a+(b-a)*fx+(c-a)*fz+(a-b-c+d)*fx*fz;
  }
  function isHoleAt(x,z){
    let ex=Math.round(((x/worldSize)+0.5)*(N-1)), ez=Math.round(((z/worldSize)+0.5)*(N-1));
    ex=Math.max(0,Math.min(N-1,ex)); ez=Math.max(0,Math.min(N-1,ez));
    return holeGrid[ez*N+ex]===1;
  }
  function groundHeight(x,z){
    const h=heightAt(x,z), e=(worldSize/(N-1))*1.0||1;
    const dx=heightAt(x+e,z)-heightAt(x-e,z), dz=heightAt(x,z+e)-heightAt(x,z-e);
    let nx=-dx/(2*e), nz=-dz/(2*e), ny=1; const il=1/Math.sqrt(nx*nx+1+nz*nz);
    return { h:h, normal:{x:nx*il,y:ny*il,z:nz*il} };
  }
  return { size:N, worldSize:worldSize, squareSize:ss, maxHeight:maxHeight, baseHeight:baseHeight,
           flipNS:flipNS, transpose:transpose, heights:heights, holeGrid:holeGrid, holeCount:holeCount,
           isHoleAt:isHoleAt, heightAt:heightAt, groundHeight:groundHeight };
}

/* ---------- fallback textures ---------- */
const CLASS_RULES=[
  ['asphalt',['asphalt','tarmac']], ['rock',['rock','cliff','stone','boulder','granite']],
  ['concrete',['concrete','cement','sidewalk','pavement']], ['sand',['sand','beach','dune']],
  ['gravel',['gravel','pebble','shingle']], ['mud',['mud','swamp','bog']],
  ['grass',['grass','meadow','lawn','field','vegetation']], ['foliage',['foliage','leaf','leaves','bush','hedge']],
  ['wood',['wood','timber','plank','bark']], ['metal',['metal','steel','iron','aluminium','aluminum','rust']],
  ['dirt',['dirt','soil','earth','ground','terrain','track','road','trail']],
];
function classifySurface(name){
  const s=String(name||'').toLowerCase();
  for(const pair of CLASS_RULES){ for(const kw of pair[1]) if(s.indexOf(kw)>=0) return pair[0]; }
  return 'unknown';
}
function hashStr(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
function makeFallbackTexture(cls, tintHex){
  const S=256, data=new Uint8Array(S*S*4);
  const palettes={ grass:[86,140,52], dirt:[122,90,58], rock:[128,128,132], sand:[210,186,132], asphalt:[62,62,66], concrete:[168,168,164], gravel:[140,132,120], mud:[84,62,40], foliage:[58,110,44], wood:[140,100,62], metal:[150,152,156], unknown:[128,0,128] };
  const base=palettes[cls]||palettes.unknown;
  let tint=null; if(typeof tintHex==='number'){ tint=[(tintHex>>16)&255,(tintHex>>8)&255,tintHex&255]; }
  else if(Array.isArray(tintHex)){ tint=[Math.round((tintHex[0]||0)*255),Math.round((tintHex[1]||0)*255),Math.round((tintHex[2]||0)*255)]; }
  const seed=hashStr(cls);
  function vhash(ix,iy){ let h=seed^Math.imul(ix,374761393)^Math.imul(iy,668265263); h=Math.imul(h^(h>>>13),1274126177); return ((h^(h>>>16))>>>0)/4294967295; }
  function noise(x,y,cell){ const gx=x/cell, gy=y/cell, ix=Math.floor(gx), iy=Math.floor(gy), fx=gx-ix, fy=gy-iy, sx=fx*fx*(3-2*fx), sy=fy*fy*(3-2*fy);
    return vhash(ix,iy)*(1-sx)*(1-sy)+vhash(ix+1,iy)*sx*(1-sy)+vhash(ix,iy+1)*(1-sx)*sy+vhash(ix+1,iy+1)*sx*sy; }
  function fbm(x,y){ return noise(x,y,64)*0.5+noise(x,y,16)*0.3+noise(x,y,4)*0.2; }
  for(let y=0;y<S;y++) for(let x=0;x<S;x++){
    let v=fbm(x,y), grain=vhash(x,y)-0.5; let r=base[0],g=base[1],b=base[2];
    if(cls==='grass'){ const sp=vhash(x>>1,y>>1); r*=0.75+v*0.5; g*=0.8+v*0.55; b*=0.7+v*0.4; if(sp>0.93){ g+=40; } }
    else if(cls==='asphalt'){ const m=0.8+v*0.35+grain*0.25; r*=m; g*=m; b*=m; if(noise(x,y,128)>0.86){ r*=0.6; g*=0.6; b*=0.6; } }
    else if(cls==='rock'){ const ridge=Math.abs(v-0.5)*2; const m=0.65+ridge*0.6; r*=m; g*=m; b*=m; }
    else if(cls==='sand'){ const m=0.85+v*0.25+grain*0.12; r*=m; g*=m; b*=m; }
    else if(cls==='concrete'){ const m=0.82+v*0.3; r*=m; g*=m; b*=m; if(noise(x+99,y,32)>0.8){ r*=0.78; g*=0.78; b*=0.78; } }
    else if(cls==='gravel'){ const cell=vhash(x>>2,y>>2); const m=0.6+cell*0.8; r*=m; g*=m*0.97; b*=m*0.92; }
    else if(cls==='wood'){ const streak=noise(x,y*0.08+0,8); const m=0.7+streak*0.6; r*=m; g*=m; b*=m*0.9; }
    else if(cls==='metal'){ const m=0.85+noise(x*0.05,y,4)*0.3+grain*0.08; r*=m; g*=m; b*=m; }
    else if(cls==='foliage'){ const cl=vhash(x>>3,y>>3); const m=0.6+cl*0.9+v*0.3; r*=m*0.8; g*=m; b*=m*0.75; }
    else { const m=0.72+v*0.55+grain*0.15; r*=m; g*=m; b*=m; }
    if(tint){ r=r*(0.35+0.65*tint[0]/255*2>1?1:0.35+0.65*(tint[0]/255)); g=g*(0.35+0.65*(tint[1]/255)); b=b*(0.35+0.65*(tint[2]/255)); /* tint scales palette toward material colour */ r=(r+tint[0])/2* (tint[0]?1:1); g=(g+tint[1])/2; b=(b+tint[2])/2; }
    const o=(y*S+x)*4; data[o]=Math.max(0,Math.min(255,r)); data[o+1]=Math.max(0,Math.min(255,g)); data[o+2]=Math.max(0,Math.min(255,b)); data[o+3]=255;
  }
  return { width:S, height:S, data:data, fallback:true, surfaceClass:cls };
}

/* ---------- scene items ---------- */
function parseJsonLines(text){
  const out=[]; const t=String(text).trim(); if(!t) return out;
  if(t[0]==='['){ try{ const a=JSON.parse(t); return Array.isArray(a)?a:out; }catch(e){} }
  for(const line of t.split(/\r?\n/)){ const s=line.trim(); if(!s) continue; try{ out.push(JSON.parse(s)); }catch(e){ /* skip bad line */ } }
  return out;
}
function parseJsonSafe(text){ try{ return JSON.parse(text); }catch(e){ return null; } }
function posOf(item){ const p=item.position||item.pos||item.translation; if(Array.isArray(p)) return [p[0]||0,p[1]||0,p[2]||0]; return [0,0,0]; }
/* ---------- item placement: BeamNG -> engine ----------
   ONE mapping for every item-derived position, identical to the
   terrain mapping in makeHeightfield:
     BeamNG: [x east, y north, z up], absolute world coords; the
       terrain's SW corner sits at the TerrainBlock position (cx, cy).
     Engine: +x east, +y up, +z SOUTH; the heightfield is centred at
       the origin (x in [-worldSize/2, +worldSize/2], north edge at
       z = -worldSize/2).
     engine = [ (bx-cx) - worldSize/2,  bz,  worldSize/2 - (by-cy) ]
   The corner term is the same centring the heightfield applies, so
   items register with the terrain they were authored on. With no
   TerrainBlock position the corner defaults to the centred
   (-worldSize/2, -worldSize/2) and this reduces to [bx, bz, -by].
   Rotations convert by conjugation with the basis matrix
   M = [[1,0,0],[0,0,1],[0,-1,0]] (eng = (bx, bz, -by)):
   R_eng = M * R_bng * M^T. det(M) = +1 — M is a proper rotation, so
   meshes are re-based, never mirrored. (The pre-fix code copied item
   positions verbatim — north landed in the up slot and up in the z
   slot — and read spawns' z from their height; items sat mirrored
   north<->south against the terrain and at wrong heights.) */
const BASIS_M=[1,0,0, 0,0,1, 0,-1,0];
function mat3Mul(a,b){ const o=new Array(9); for(let r=0;r<3;r++) for(let c=0;c<3;c++) o[r*3+c]=a[r*3]*b[c]+a[r*3+1]*b[3+c]+a[r*3+2]*b[6+c]; return o; }
function mat3Transpose(a){ return [a[0],a[3],a[6], a[1],a[4],a[7], a[2],a[5],a[8]]; }
function basisConvert3(L){ return mat3Mul(BASIS_M, mat3Mul(L, mat3Transpose(BASIS_M))); }
function makeItemConverter(worldSize, tbPos){
  const ws=worldSize||0;
  const cx=(tbPos && typeof tbPos[0]==='number' && isFinite(tbPos[0])) ? tbPos[0] : -ws/2;
  const cy=(tbPos && typeof tbPos[1]==='number' && isFinite(tbPos[1])) ? tbPos[1] : -ws/2;
  return function(p){ return [ (p[0]-cx)-ws/2, p[2]||0, ws/2-(p[1]-cy) ]; };
}
/* The item's rotation as a row-major 3x3 in BeamNG space.
   items.level.json stores `rotation` as axis-angle
   [ax, ay, az, angleDegrees] (verified in real level files, e.g.
   SpawnSphere rotation [0,0,1,148.07]) — NOT a quaternion; the old
   code read it as one and produced a ~0 heading for almost every
   spawn. `rotationMatrix` may be 9 elements (row-major) or 16
   (column-major 4x4); both are read as the same linear map. */
function beamngRotMat3(item){
  const rm=item.rotationMatrix;
  if(Array.isArray(rm) && rm.length>=16) return [rm[0],rm[4],rm[8], rm[1],rm[5],rm[9], rm[2],rm[6],rm[10]];
  if(Array.isArray(rm) && rm.length>=9) return [rm[0],rm[1],rm[2], rm[3],rm[4],rm[5], rm[6],rm[7],rm[8]];
  const r=item.rotation;
  if(Array.isArray(r) && r.length===4){
    let ax=r[0]||0, ay=r[1]||0, az=r[2]||0; const il=1/Math.hypot(ax,ay,az);
    if(!isFinite(il)) return [1,0,0, 0,1,0, 0,0,1];
    ax*=il; ay*=il; az*=il;
    const th=(r[3]||0)*Math.PI/180, c=Math.cos(th), s=Math.sin(th), t=1-c;
    return [ t*ax*ax+c,     t*ax*ay-s*az, t*ax*az+s*ay,
             t*ax*ay+s*az, t*ay*ay+c,     t*ay*az-s*ax,
             t*ax*az-s*ay, t*ay*az+s*ax, t*az*az+c ];
  }
  return [1,0,0, 0,1,0, 0,0,1];
}
/* Engine heading for an item. Derivation: an item's facing at
   identity rotation is BeamNG +Y (north); under R the facing is the
   second column of R, f = (R[1], R[4], R[7]). The basis map sends f
   to engine (f.x, f.z, -f.y), and engine heading (the BeamngWorld
   .trackPoint convention) is atan2(dx, dz) — so heading =
   atan2(R[1], -R[4]). For a pure BeamNG yaw theta about +Z this
   gives heading = PI + theta: the sign is POSITIVE because M is a
   proper rotation (orientation-preserving); only the reference
   direction changes (BeamNG measures facing from north, engine
   heading from +z/south). */
function beamngHeading(item){
  const R=beamngRotMat3(item);
  return Math.atan2(R[1], -R[4]);
}
function itemTransform(item, toEngine){
  const p=posOf(item);
  const R=beamngRotMat3(item);
  const sc=item.scale; const sx=Array.isArray(sc)?(sc[0]||1):(typeof sc==='number'?sc:1), sy=Array.isArray(sc)?(sc[1]===undefined?sx:sc[1]):sx, sz=Array.isArray(sc)?(sc[2]===undefined?sx:sc[2]):sx;
  // linear part in BeamNG space: L = R * S (scale in local axes)
  const L=[R[0]*sx,R[1]*sy,R[2]*sz, R[3]*sx,R[4]*sy,R[5]*sz, R[6]*sx,R[7]*sy,R[8]*sz];
  const Le=basisConvert3(L); // the same linear map, re-based into engine space
  const out=[0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1];
  for(let r=0;r<3;r++) for(let c=0;c<3;c++) out[c*4+r]=Le[r*3+c]; // row-major -> column-major
  const ep=toEngine ? toEngine(p) : [p[0], p[2]||0, -(p[1]||0)];
  out[12]=ep[0]; out[13]=ep[1]; out[14]=ep[2]; return out;
}
function roadNodes(item){
  const raw=item.nodes||item.points||item.roadNodes||[]; const out=[];
  for(const nd of raw){ if(Array.isArray(nd)) out.push({position:[nd[0]||0,nd[1]||0,nd[2]||0], width: nd.length>3? nd[3] : (item.width||8)});
    else if(nd && typeof nd==='object'){ const p=nd.position||nd.pos||[nd.x||0,nd.y||0,nd.z||0]; out.push({position:Array.isArray(p)?p:[p.x||0,p.y||0,p.z||0], width: nd.width||item.width||8}); } }
  return out;
}
function buildRibbon(nodes, heightfield, materialName){
  // nodes carry ENGINE-space positions ([x, up, z], see
  // makeItemConverter) — importMap converts DecalRoad nodes before
  // calling this; the ribbon is draped on the heightfield.
  const pts=nodes.map(function(nd){ return {x:nd.position[0], z:nd.position[2], width:nd.width||8}; });
  const positions=[], normals=[], uvs=[], indices=[]; let length=0;
  const cum=[0]; for(let i=1;i<pts.length;i++){ length+=Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z); cum.push(length); }
  for(let i=0;i<pts.length;i++){
    const a=pts[Math.max(0,i-1)], b=pts[Math.min(pts.length-1,i+1)];
    let dx=b.x-a.x, dz=b.z-a.z; const dl=Math.hypot(dx,dz)||1; dx/=dl; dz/=dl;
    const rx=dz, rz=-dx, hw=pts[i].width/2;
    for(const side of [-1,1]){ const ex=pts[i].x+rx*hw*side, ez=pts[i].z+rz*hw*side; const h=heightfield.heightAt(ex,ez)+0.06; positions.push(ex,h,ez); normals.push(0,1,0); uvs.push(side<0?0:1, cum[i]/10); }
    if(i>0){ const b0=(i-1)*2; indices.push(b0,b0+1,b0+2, b0+1,b0+3,b0+2); }
  }
  return { positions:new Float32Array(positions), normals:new Float32Array(normals), uvs:new Float32Array(uvs), indices:new Uint32Array(indices), materialName:materialName||'road', length:length, nodes:pts, cumulative:cum };
}
function collectMaterialDefs(zipMap, lower){
  const defs={}; // name(lower) -> {texture, tint, name}
  for(const key of zipMap.keys()){
    const lk=normPath(key).toLowerCase();
    if(!/(materials\.json|main\.materials\.json)$/.test(lk)) continue;
    const obj=parseJsonSafe(decodeText(zipMap.get(key))); if(!obj||typeof obj!=='object') continue;
    for(const name of Object.keys(obj)){ const d=obj[name]; if(!d||typeof d!=='object') continue;
      let tex=d.diffuseMap||d.colorMap||d.baseColorMap||d.map||d.texture||null;
      if(!tex && Array.isArray(d.maps)) for(const mm of d.maps){ if(mm && (mm.diffuseMap||mm.colorMap)){ tex=mm.diffuseMap||mm.colorMap; break; } }
      let tint=d.diffuseColor||d.baseColor||d.color||null;
      defs[name.toLowerCase()]={ texture: typeof tex==='string'?tex:null, tint: Array.isArray(tint)?tint:null, name:name };
      if(d.mapTo) defs[String(d.mapTo).toLowerCase()]=defs[name.toLowerCase()];
    }
  }
  return defs;
}
function collectBrushMap(zipMap, lower){
  const map={};
  function scan(obj, depth){ if(!obj||typeof obj!=='object'||depth>6) return;
    const mesh=obj.mesh||obj.shapeName||obj.shapeFile||obj.shape||obj.meshName;
    const nm=obj.name||obj.type||obj.internalName;
    if(typeof mesh==='string' && typeof nm==='string') map[nm]=mesh;
    for(const k of Object.keys(obj)) scan(obj[k], depth+1);
  }
  for(const key of zipMap.keys()){ const lk=normPath(key).toLowerCase(); if(/forestbrush|manageditemdata|brush/.test(lk) && lk.endsWith('.json')){ const t=decodeText(zipMap.get(key)); const o=parseJsonSafe(t); if(o) scan(o,0); else for(const it of parseJsonLines(t)) scan(it,0); } }
  return map;
}

async function importMap(zipMap, opts){
  opts=opts||{};
  /* Progress + a yield at every stage boundary (v2.7.2): this function
     is async but the conversion itself is synchronous CPU work, so
     without the yield the whole conversion is ONE task and the
     browser cannot paint the loading bar/log the callbacks update —
     on a big map the overlay froze on one frame until the import
     finished. The yield changes timing only, never results. */
  const onProgressRaw=opts.onProgress||function(){};
  const onProgress=async function(p){ onProgressRaw(p); await new Promise(function(r){ setTimeout(r, 0); }); };
  /* Stage context for the layered error reporter (js/ui/errors.js):
     errors thrown here carry WHERE they happened as plain properties
     (edStage / edFile) — this module never imports the reporter, the
     game's formatError just reads the properties. Only set if absent,
     so the innermost, most specific context wins. */
  function tagStage(e, stage, file){ if(e && typeof e==='object'){ if(!e.edStage) e.edStage=stage; if(!e.edFile && file) e.edFile=file; } return e; }
  const report={ levelName:null, terrainSize:0, worldSize:0, terrainChoice:null, counts:{items:0,roads:0,statics:0,forestPlacements:0,texturesDecoded:0,texturesFallback:0}, missing:[], substitutions:[], warnings:[] };
  const lower=lowerMap(zipMap);
  const keys=Array.from(zipMap.keys()).map(normPath);
  // locate level
  let levelPrefix=null, levelName=null;
  for(const k of keys){ const m=/^levels\/([^/]+)\//i.exec(k); if(m){ levelPrefix='levels/'+m[1]+'/'; levelName=m[1]; break; } }
  if(!levelPrefix) throw tagStage(new Error('importMap: no levels/<name>/ folder found in zip'), 'level', '(zip root — no levels/ folder)');
  report.levelName=levelName;
  const lp=levelPrefix.toLowerCase();
  function levelFiles(suffixTest){ return keys.filter(function(k){ return k.toLowerCase().startsWith(lp) && suffixTest(k.toLowerCase()); }); }
  // info.json
  let title=levelName, infoObj=null; const infoBytes=getFile(zipMap,lower,levelPrefix+'info.json'); if(infoBytes){ const o=parseJsonSafe(decodeText(infoBytes)); if(o){ infoObj=o; if(o.title||o.name) title=o.title||o.name; } }
  // ---- items are collected BEFORE terrain: the TerrainBlock item in
  // items.level.json is where maxHeight / squareSize / base height live
  // (they are in neither the .ter nor theTerrain.terrain.json).
  // Current BeamNG layout has ONE items.level.json per sub-group folder
  // under main/MissionGroup/... — scan every *.level.json under the
  // level folder. A root main.level.json is a stale transitional
  // fallback: it is only read when no items.level.json exists at all.
  const items=[]; const levelJsonKeys=levelFiles(function(x){ return x.endsWith('.level.json'); });
  const itemsKeys=levelJsonKeys.filter(function(k){ return k.toLowerCase().endsWith('items.level.json'); });
  const rootMainKey=levelPrefix+'main.level.json';
  let itemKeys=itemsKeys;
  if(!itemsKeys.length) itemKeys=levelJsonKeys; // transitional layout: root main.level.json only
  else itemKeys=levelJsonKeys.filter(function(k){ return k!==rootMainKey; });
  for(const k of itemKeys){ for(const it of parseJsonLines(decodeText(zipMap.get(k)))) items.push(it); }
  if(!itemsKeys.length && levelJsonKeys.length) report.warnings.push('No items.level.json found — items were read from the transitional root main.level.json, which current BeamNG treats as a stale fallback; contents may be outdated');
  let terrainBlock=null;
  for(const it of items){ if((it.class||it.type)==='TerrainBlock'){ terrainBlock=it; break; } }
  // ---- terrain.json: a PRIMARY cross-check source for what it actually
  // contains (version, size N, heightMapSize/layerMapSize sample COUNTS,
  // item sizes, materials) — and nothing else: it has no scale fields.
  // (Trap avoided: heightMapSize is N², a count — never a grid size.)
  let terJson=null;
  for(const k of levelFiles(function(x){return x.endsWith('.terrain.json');})){ const o=parseJsonSafe(decodeText(zipMap.get(k))); if(o){ terJson=o; break; } }
  // ---- terrain
  await onProgress({stage:'terrain', frac:0.05, msg:'Reading terrain…'});
  const terKey=keys.find(function(k){ return k.toLowerCase().startsWith(lp) && k.toLowerCase().endsWith('.ter'); });
  let heightfield=null, terLayout=null, itemConvert=null;
  if(terKey){
    let ter;
    try { ter=parseTer(zipMap.get(terKey), {}); } // strict v9 — throws loudly on any mismatch
    catch(e){ throw tagStage(e, 'terrain', terKey); }
    terLayout=ter.layout;
    // cross-validate the decode against terrain.json (mismatch = warning, .ter wins)
    if(terJson){
      if(terJson.size && terJson.size!==ter.size) report.warnings.push('terrain.json size '+terJson.size+' disagrees with the .ter header N='+ter.size+' — the .ter header wins');
      if(terJson.heightMapSize && terJson.heightMapSize!==ter.size*ter.size) report.warnings.push('terrain.json heightMapSize '+terJson.heightMapSize+' disagrees with N²='+(ter.size*ter.size)+' from the .ter');
      if(terJson.layerMapSize && terJson.layerMapSize!==ter.size*ter.size) report.warnings.push('terrain.json layerMapSize '+terJson.layerMapSize+' disagrees with N²='+(ter.size*ter.size)+' from the .ter');
      if(terJson.heightMapItemSize && terJson.heightMapItemSize!==2) report.warnings.push('terrain.json heightMapItemSize is '+terJson.heightMapItemSize+', expected 2 for v9');
      if(terJson.layerMapItemSize && terJson.layerMapItemSize!==1) report.warnings.push('terrain.json layerMapItemSize is '+terJson.layerMapItemSize+', expected 1 for v9');
      if(terJson.version && terJson.version!==ter.version) report.warnings.push('terrain.json version '+terJson.version+' disagrees with the .ter version byte '+ter.version);
      if(Array.isArray(terJson.materials) && JSON.stringify(terJson.materials)!==JSON.stringify(ter.materials)) report.warnings.push('terrain.json materials ['+terJson.materials.join(', ')+'] disagree with the .ter material names ['+ter.materials.join(', ')+'] — the .ter names win');
    }
    if(ter.trailingBytes>0) report.warnings.push('.ter has '+ter.trailingBytes+' trailing bytes after the material names (tolerated, not decoded)');
    if(ter.maxLayerIndex>=ter.materials.length) report.warnings.push('.ter layer map references material index '+ter.maxLayerIndex+' but only '+ter.materials.length+' material names are stored');
    // scale sources: TerrainBlock wins outright; the rest is searched.
    // squareSize is ABSENT in real-world TerrainBlocks (the serializer
    // omits it at the default) — absence means 1.0, logged as an
    // assumption (inference from real files, not a verified rule).
    let tbMax=null, tbSquare=null, baseHeight=0, tbPos=null, squareAssumed=false;
    if(terrainBlock){
      if(typeof terrainBlock.maxHeight==='number' && terrainBlock.maxHeight>0) tbMax=terrainBlock.maxHeight;
      if(typeof terrainBlock.squareSize==='number' && terrainBlock.squareSize>0) tbSquare=terrainBlock.squareSize;
      else { tbSquare=1; squareAssumed=true; }
      if(Array.isArray(terrainBlock.position)){ tbPos=terrainBlock.position; if(typeof tbPos[2]==='number' && isFinite(tbPos[2])) baseHeight=tbPos[2]; }
    }
    const spawnItems=items.filter(function(it){ return (it.class||it.type)==='SpawnSphere'; });
    const choice=chooseTerrainCombo(ter, { maxHeight:tbMax, squareSize:tbSquare, baseHeight:baseHeight, tbPos:tbPos, spawns:spawnItems });
    heightfield=makeHeightfield(ter, choice.squareSize, { maxHeight:choice.maxHeight, baseHeight:baseHeight, flipNS:choice.flipNS, transpose:choice.transpose });
    itemConvert=makeItemConverter(heightfield.worldSize, tbPos);
    report.terrainChoice={ size:ter.size, layout:terLayout, trailingBytes:ter.trailingBytes, materials:ter.materials,
      holeCount:heightfield.holeCount, baseHeight:baseHeight, terrainJsonFound:!!terJson, terrainBlockFound:!!terrainBlock,
      maxHeight:choice.maxHeight, maxHeightSource:choice.sources.maxHeight, squareSize:choice.squareSize, squareSizeSource:choice.sources.squareSize,
      flipNS:choice.flipNS, transpose:choice.transpose, score:choice.score, spawnErrorMeters:choice.spawnErrorMeters,
      runnersUp:choice.runnersUp, combosTested:choice.combosTested, stats:choice.stats };
    if(squareAssumed) report.terrainChoice.squareSizeSource='TerrainBlock default (field absent — assumed 1.0)';
    if(!terrainBlock) report.warnings.push('No TerrainBlock in items.level.json — maxHeight '+choice.maxHeight+' and squareSize '+choice.squareSize+' were chosen by the scored combination search (see report.terrainChoice), not read from the level; if the terrain looks wrong, these are the values to question');
    else {
      if(tbMax===null) report.warnings.push('TerrainBlock has no maxHeight — '+choice.maxHeight+' was chosen by the scored search (see report.terrainChoice)');
      if(squareAssumed) report.warnings.push('TerrainBlock omits squareSize (the serializer drops it at the default) — assumed 1.0; this is an inference from real level files, not a verified rule');
      if(tbPos && (Math.abs(tbPos[0]+heightfield.worldSize/2)>1 || Math.abs(tbPos[1]+heightfield.worldSize/2)>1)) report.warnings.push('TerrainBlock position ['+tbPos.join(', ')+'] is not the centred SW corner — the heightfield is built centred at the origin and item positions are converted relative to the declared corner, so items stay registered to the terrain');
    }
    if(!terJson) report.warnings.push('No theTerrain.terrain.json found — decode cross-checks against it were skipped');
  }
  else { report.warnings.push('No .ter file found; using flat terrain'); heightfield=makeHeightfield({size:2, samples:new Uint16Array(4), layerMap:new Uint8Array(4), materials:[], maxHeightApplied:1}, 1, {}); itemConvert=makeItemConverter(0, null); report.missing.push({kind:'other', path:levelPrefix+'theTerrain.ter', referencedBy:'level'}); }
  const pngHm=keys.filter(function(k){ return /heightmap.*\.png$/i.test(k) || /import\/.*\.png$/i.test(k); });
  if(pngHm.length) report.warnings.push('Heightmap PNG present ('+pngHm.join(', ')+') — noted only; .ter is the primary height source (PNG heightmap decoding not implemented)');
  report.terrainSize=heightfield.size; report.worldSize=heightfield.worldSize;
  await onProgress({stage:'terrain', frac:0.2, msg:'Terrain '+heightfield.size+'×'+heightfield.size+' ('+Math.round(heightfield.worldSize)+' m) from '+(terLayout||'fallback')});
  // ---- items
  await onProgress({stage:'items', frac:0.25, msg:'Reading scene items…'});
  const spawns=[], roads=[], staticsRaw=[], notes=[];
  const matDefs=collectMaterialDefs(zipMap, lower);
  const meshCache=new Map();
  function loadMesh(path, referencedBy){
    const np=normPath(path); const full = hasFile(lower,np) ? np : (hasFile(lower, levelPrefix+np) ? levelPrefix+np : null);
    if(!full){ report.missing.push({kind:'mesh', path:np, referencedBy:referencedBy}); return null; }
    if(meshCache.has(full)) return meshCache.get(full);
    let mesh=null;
    if(full.toLowerCase().endsWith('.dae')){ if(!_DAE){ report.warnings.push('DAE parser unavailable for '+full); } else { try { mesh=_DAE.parseDAE(decodeText(zipMap.get(full))); } catch(e){ throw tagStage(e, 'statics', full); } } }
    else { report.warnings.push('Mesh format not decoded (kept as reference): '+full); mesh={meshes:{},nodes:[],materials:[],unsupportedFormat:true}; }
    meshCache.set(full, mesh); return mesh;
  }
  for(const it of items){
    const cls=it.class||it.type||'';
    if(cls==='SpawnSphere'){ const ep=itemConvert(posOf(it)); spawns.push({position:ep, x:ep[0], z:ep[2], heading:beamngHeading(it), item:it}); }
    else if(cls==='DecalRoad'){ const nds=roadNodes(it); if(nds.length>=2){ const cnds=nds.map(function(nd){ return { position:itemConvert(nd.position), width:nd.width }; }); roads.push(buildRibbon(cnds, heightfield, it.material||it.texture||'road')); } else report.warnings.push('DecalRoad with <2 nodes skipped'); }
    else if(cls==='MeshRoad'){ notes.push('MeshRoad item present — geometry via its DAE if in zip, else missing (see report)'); const mp=it.shapeName||it.mesh; if(mp){ if(!loadMesh(mp,'MeshRoad')){} } }
    else if(cls==='LevelInfo'){ if(it.sunElevation!==undefined||it.sky){ notes.push('LevelInfo found (sun/sky basics not converted)'); } }
    const shape=it.shapeName||it.shapeFile||it.mesh||it.filename;
    if(typeof shape==='string' && shape){ const mesh=loadMesh(shape, cls||'item'); if(mesh) staticsRaw.push({mesh:mesh, transform:itemTransform(it, itemConvert), materialNames: mesh.materials||[], item:it, shapeName:shape}); }
  }
  // the level's DEFAULT spawn is named in info.json
  // (defaultSpawnPointName / spawnPoints[].objectname, matching the
  // SpawnSphere's name) — put it first; BeamngWorld spawns at [0].
  if(infoObj && spawns.length>1){
    let defName=infoObj.defaultSpawnPointName||null;
    if(!defName && Array.isArray(infoObj.spawnPoints) && infoObj.spawnPoints.length) defName=infoObj.spawnPoints[0].objectname||null;
    if(defName){ const di=spawns.findIndex(function(s){ return s.item && s.item.name===defName; }); if(di>0){ const d=spawns.splice(di,1)[0]; spawns.unshift(d); } }
  }
  // agreement check: the winning terrain combination + the CONVERTED
  // (engine-space) spawn positions must put every spawn on the ground
  // the heightfield reports — the end-to-end proof that item
  // conversion and terrain orientation agree (see chooseTerrainCombo).
  if(terKey && report.terrainChoice && spawns.length){
    let worst=0; for(const s of spawns){ const bp=s.item && s.item.position; if(Array.isArray(bp)) worst=Math.max(worst, Math.abs(heightfield.heightAt(s.x, s.z)-(bp[2]||0))); }
    report.terrainChoice.spawnGroundErrorMeters=worst;
  }
  report.counts.items=items.length;
  await onProgress({stage:'items', frac:0.4, msg:'Parsed '+items.length+' scene items ('+spawns.length+' spawns)'});
  await onProgress({stage:'roads', frac:0.5, msg:'Building '+roads.length+' decal road ribbons…'});
  report.counts.roads=roads.length;
  // ---- forest
  await onProgress({stage:'forest', frac:0.55, msg:'Placing forest items…'});
  const brushMap=collectBrushMap(zipMap, lower); const forestPlacements=[]; const forestCounts={};
  const forestFiles=keys.filter(function(k){ const lk=k.toLowerCase(); return lk.startsWith(lp) && (lk.endsWith('.forest.json')||lk.endsWith('.forest4.json')); });
  for(const k of forestFiles){ const entries=parseJsonLines(decodeText(zipMap.get(k))); if(!entries.length){ const o=parseJsonSafe(decodeText(zipMap.get(k))); if(Array.isArray(o)) entries.push.apply(entries,o); }
    for(const e of entries){ const type=e.type||e.name||'unknown'; const meshPath=brushMap[type]||e.mesh||e.shapeName||null; const p=itemConvert(posOf(e));
      forestPlacements.push({ meshPath:meshPath, position:p, rotation:e.rotation||null, scale:e.scale===undefined?1:e.scale, type:type });
      forestCounts[type]=(forestCounts[type]||0)+1;
      if(meshPath) loadMesh(meshPath, 'forest:'+type); else report.missing.push({kind:'mesh', path:'(unmapped forest type)', referencedBy:'forest:'+type});
    } }
  report.counts.forestPlacements=forestPlacements.length;
  await onProgress({stage:'forest', frac:0.65, msg:'Placing '+forestPlacements.length+' forest items…'});
  // ---- statics + textures
  await onProgress({stage:'statics', frac:0.7, msg:'Converting '+staticsRaw.length+' static meshes…'});
  report.counts.statics=staticsRaw.length;
  await onProgress({stage:'textures', frac:0.8, msg:'Decoding textures…'});
  const textures={};
  const wantedTex=new Map(); // materialLower -> def
  for(const name of Object.keys(matDefs)) wantedTex.set(name, matDefs[name]);
  for(const st of staticsRaw) for(const mn of (st.materialNames||[])){ if(!wantedTex.has(mn.toLowerCase())) wantedTex.set(mn.toLowerCase(), {name:mn, texture:null, tint:null}); }
  for(const entry of wantedTex){
    const lname=entry[0], def=entry[1];
    if(def.texture){
      const np=normPath(def.texture); const candidates=[np, levelPrefix+np];
      let found=null; for(const c of candidates) if(hasFile(lower,c)){ found=c; break; }
      if(!found){ // search by basename anywhere under level/art
        const base=np.split('/').pop().toLowerCase(); for(const k of keys){ if(k.toLowerCase().endsWith('/'+base)){ found=k; break; } }
      }
      if(found){ const bytes=zipMap.get(found); const lk=found.toLowerCase();
        if(lk.endsWith('.dds')){ try{ if(!_DDS) throw new Error('DDS decoder unavailable'); textures[def.name]=_DDS.decodeDDS(bytes); report.counts.texturesDecoded++; }catch(e){ report.warnings.push('DDS decode failed for '+found+': '+e.message); const cls=classifySurface(def.name+' '+found); textures[def.name]=makeFallbackTexture(cls, def.tint); report.counts.texturesFallback++; report.substitutions.push({material:def.name, wantedPath:np, class:cls, tinted:!!def.tint}); } }
        else if(lk.endsWith('.png')) textures[def.name]={bytes:bytes, mime:'image/png', path:found};
        else if(lk.endsWith('.jpg')||lk.endsWith('.jpeg')) textures[def.name]={bytes:bytes, mime:'image/jpeg', path:found};
        else textures[def.name]={bytes:bytes, mime:'application/octet-stream', path:found};
        continue;
      }
      report.missing.push({kind:'texture', path:np, referencedBy:'material:'+def.name});
    }
    const cls=classifySurface(def.name+(def.texture?' '+def.texture:''));
    textures[def.name]=makeFallbackTexture(cls, def.tint); report.counts.texturesFallback++;
    report.substitutions.push({material:def.name, wantedPath:def.texture||null, class:cls, tinted:!!def.tint});
  }
  await onProgress({stage:'textures', frac:0.9, msg:'Textures: '+report.counts.texturesDecoded+' decoded, '+report.counts.texturesFallback+' fallback'});
  const converted={ levelName:levelName, title:title, heightfield:heightfield, terrainLayout:terLayout, items:items, spawns:spawns, roads:roads, statics:staticsRaw, forestPlacements:forestPlacements, forestCounts:forestCounts, textures:textures, materials:matDefs, notes:notes, report:report };
  await onProgress({stage:'world', frac:0.95, msg:'Building world…'});
  try { converted.world=new BeamngWorld(converted); }
  catch(e){ throw tagStage(e, 'world', levelPrefix); }
  await onProgress({stage:'done', frac:1, msg:'Done: '+levelName+' — '+report.counts.items+' items, '+report.counts.roads+' roads, '+report.counts.forestPlacements+' forest placements'});
  return converted;
}

/* ---------- BeamngWorld: TrackWorld-compatible interface ---------- */
class BeamngWorld{
  constructor(converted){
    this.converted=converted; this.heightfield=converted.heightfield; this.roads=converted.roads||[]; this.spawns=converted.spawns||[];
    this.seed=1; this.extraObstacles=[];
    // longest road as the track
    this.trackRoad=null; for(const r of this.roads) if(!this.trackRoad||r.length>this.trackRoad.length) this.trackRoad=r;
    const sp=this.spawnPoint(); this._spawn=sp;
    if(this.trackRoad){ this._trackPts=this.trackRoad.nodes; this._trackCum=this.trackRoad.cumulative; this._trackLen=this.trackRoad.length; }
    else { this._trackPts=[{x:sp.x,z:sp.z},{x:sp.x+Math.sin(sp.heading)*1000, z:sp.z+Math.cos(sp.heading)*1000}]; this._trackCum=[0,1000]; this._trackLen=1000; }
    // obstacles from statics + forest (coarse radius)
    this._obstacles=[];
    for(const st of (converted.statics||[])) this._obstacles.push({type:'static', x:st.transform[12], z:st.transform[14], y:st.transform[13], r:2, h:3, s:0, lat:0});
    for(const f of (converted.forestPlacements||[])) this._obstacles.push({type:'tree', x:f.position[0], z:f.position[2], y:f.position[1], r:0.5, h:3.4, s:0, lat:0});
  }
  spawnPoint(){ if(this.spawns.length){ const s=this.spawns[0]; return {x:s.x, z:s.z, heading:s.heading||0}; } return {x:0, z:0, heading:0}; }
  /* Holes (layer byte 0xFF) are exposed here for callers that care.
     The ground queries below keep returning the stored height over a
     hole — this interface has no hole concept and the sim treats hole
     cells as solid at that height (documented limitation); only the
     renderer reacts to holes (it drops all-hole triangles). */
  isHoleAt(x,z){ return this.heightfield.isHoleAt ? this.heightfield.isHoleAt(x,z) : false; }
  trackPoint(s){
    s=Math.max(0, Math.min(this._trackLen, s||0)); const pts=this._trackPts, cum=this._trackCum;
    let i=0; while(i<cum.length-2 && cum[i+1]<s) i++;
    const segLen=(cum[i+1]-cum[i])||1, t=(s-cum[i])/segLen, a=pts[i], b=pts[i+1];
    const x=a.x+(b.x-a.x)*t, z=a.z+(b.z-a.z)*t, heading=Math.atan2(b.x-a.x, b.z-a.z);
    return { s:s, x:x, z:z, y:this.heightfield.heightAt(x,z), heading:heading, curvature:0 };
  }
  _onRoad(x,z){ let best=1e18, bestW=0; for(const r of this.roads){ const nds=r.nodes; for(let i=0;i+1<nds.length;i++){ const a=nds[i], b=nds[i+1]; const abx=b.x-a.x, abz=b.z-a.z; const L2=abx*abx+abz*abz||1; let t=((x-a.x)*abx+(z-a.z)*abz)/L2; t=Math.max(0,Math.min(1,t)); const px=a.x+abx*t, pz=a.z+abz*t; const d=Math.hypot(x-px,z-pz); if(d<best){ best=d; bestW=(a.width||8); } } } return best <= bestW/2 ? {on:true, dist:best} : {on:false, dist:best}; }
  heightAtSL(s, lat){ const p=this.trackPoint(s); const rx=Math.cos(p.heading), rz=-Math.sin(p.heading); const x=p.x+rx*lat, z=p.z+rz*lat; const h=this.heightfield.heightAt(x,z); return { h:h, surface: this._onRoad(x,z).on ? 'road' : 'dirt' }; }
  nearestTrack(x,z,sHint){ const out={s:0,lateral:0,dist:0,index:0}; this._nearestTrackInto(x,z,sHint,out); return out; }
  _nearestTrackInto(x,z,sHint,out,win){
    // project onto track polyline segments (hint only narrows nothing: full scan is exact and roads are modest)
    let best=1e18, bestS=0, bestLat=0, bestIdx=0; const pts=this._trackPts, cum=this._trackCum;
    for(let i=0;i+1<pts.length;i++){ const a=pts[i], b=pts[i+1]; const abx=b.x-a.x, abz=b.z-a.z; const L2=abx*abx+abz*abz||1; let t=((x-a.x)*abx+(z-a.z)*abz)/L2; t=Math.max(0,Math.min(1,t)); const px=a.x+abx*t, pz=a.z+abz*t; const dx=x-px, dz=z-pz, d=dx*dx+dz*dz;
      if(d<best){ best=d; const segLen=Math.sqrt(L2); bestS=cum[i]+t*segLen; const heading=Math.atan2(abx,abz); const rx=Math.cos(heading), rz=-Math.sin(heading); bestLat=dx*rx+dz*rz; bestIdx=i; } }
    out.s=bestS; out.lateral=bestLat; out.dist=Math.sqrt(best); out.index=bestIdx;
  }
  _groundHOnly(x,z,sHint,win){ return this.heightfield.heightAt(x,z); }
  _groundHeightInto(x,z,sHint,out,outN,win){
    const nt=this._ntS||(this._ntS={s:0,lateral:0,dist:0,index:0}); this._nearestTrackInto(x,z,sHint,nt,win);
    const g=this.heightfield.groundHeight(x,z);
    out.h=g.h; out.surface=this._onRoad(x,z).on?'road':'dirt'; out.slope=Math.atan(Math.hypot(g.normal.x,g.normal.z)/Math.max(0.0001,g.normal.y)); out.s=nt.s; out.lateral=nt.lateral;
    if(outN){ outN.x=g.normal.x; outN.y=g.normal.y; outN.z=g.normal.z; }
  }
  groundHeight(x,z,sHint){ const out={h:0,surface:'dirt',slope:0,s:0,lateral:0,normal:{x:0,y:1,z:0}}; this._groundHeightInto(x,z,sHint,out,out.normal); return out; }
  barrierStretchesIn(s0,s1){ return []; }
  barrierObstaclesForSegment(seg){ return []; }
  defectsInRange(s0,s1){ return []; }
  defectOffset(s,lat){ return 0; }
  cliffAt(s){ return null; }
  elev(s){ return this.heightAtSL(s,0).h; }
  obstaclesForSegment(seg){ const s0=seg*50, s1=s0+50, out=[]; for(const o of this._obstacles){ const nt=this.nearestTrack(o.x,o.z,0); if(nt.s>=s0&&nt.s<s1){ o.s=nt.s; o.lat=nt.lateral; out.push(o); } } return out; }
  getObstacles(x,z,sHint){ const out=[]; for(const o of this._obstacles){ const dx=o.x-x, dz=o.z-z; if(dx*dx+dz*dz<3600) out.push(o); } for(const o of this.extraObstacles){ const dx=o.x-x, dz=o.z-z; if(dx*dx+dz*dz<3600) out.push(o); } return out; }
  obstaclesNear(x,z,sHint){ return this.getObstacles(x,z,sHint); }
}
{ const API={ importMap:importMap, BeamngWorld:BeamngWorld, parseTer:parseTer, makeHeightfield:makeHeightfield, classifySurface:classifySurface, makeFallbackTexture:makeFallbackTexture, parseJsonLines:parseJsonLines, buildRibbon:buildRibbon };
if (typeof globalThis!=='undefined') globalThis.__BMAP = API;
if (typeof module!=='undefined') module.exports = API; }
