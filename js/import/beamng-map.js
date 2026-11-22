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

/* ---------- .ter reader ----------
   Implemented layout (candidate A, primary): 12-byte header
     u32LE version (expected 9), u32LE gridSize N, u32LE reserved,
     then N*N u16LE height samples, row-major (row = z, col = x),
     height = sample/65535 * maxHeight.
   Candidate B: headerless raw u16LE grid, N = sqrt(len/2).
   Candidate C: 16-byte header (version, N, two reserved words), then u16 grid.
   The reader validates byte length against N*N*2 for each candidate and
   reports which layout matched; trailing bytes (material/layer data in
   real .ter files) are tolerated for A/C and noted. If no candidate
   validates, it throws with the sizes it tried. */
function parseTer(bytes, opts){
  opts=opts||{}; const maxHeight=opts.maxHeight||200; const hint=opts.gridSize||0;
  const dv=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const candidates=[];
  function tryCand(name, header, version, N){
    if(!N || N<2 || N>8192) return null;
    const need=header+N*N*2;
    if(bytes.length<need) return null;
    const exact = bytes.length===need;
    candidates.push({name:name, header:header, N:N, exact:exact, trailing:bytes.length-need});
    const heights=new Float32Array(N*N);
    for(let i=0;i<N*N;i++) heights[i]=dv.getUint16(header+i*2,true)/65535*maxHeight;
    return { size:N, heights:heights, layout:name, version:version||null, trailingBytes:bytes.length-need };
  }
  if(bytes.length>=12){ const v=dv.getUint32(0,true), N=dv.getUint32(4,true); const r=tryCand('header12-u16',12,v,N); if(r) return r; }
  if(bytes.length>=16){ const v=dv.getUint32(0,true), N=dv.getUint32(4,true); const r=tryCand('header16-u16',16,v,N); if(r) return r; }
  if(hint){ const r=tryCand('hint-header0-u16',0,null,hint); if(r) return r; const r2=tryCand('hint-header12-u16',12,null,hint); if(r2) return r2; }
  const rawN=Math.sqrt(bytes.length/2); if(Number.isInteger(rawN)){ const r=tryCand('raw-u16',0,null,rawN); if(r) return r; }
  throw new Error('.ter: no layout validated (length '+bytes.length+'; tried header12/header16 u16 grids'+(hint?', hint N='+hint:'')+', raw grid)');
}
function makeHeightfield(ter, squareSize){
  const N=ter.size, worldSize=N*(squareSize||1), heights=ter.heights;
  function heightAt(x,z){
    let gx=((x/worldSize)+0.5)*(N-1), gz=((z/worldSize)+0.5)*(N-1);
    gx=Math.max(0,Math.min(N-1.001,gx)); gz=Math.max(0,Math.min(N-1.001,gz));
    const ix=Math.floor(gx), iz=Math.floor(gz), fx=gx-ix, fz=gz-iz;
    const a=heights[iz*N+ix], b=heights[iz*N+ix+1], c=heights[(iz+1)*N+ix], d=heights[(iz+1)*N+ix+1];
    return a+(b-a)*fx+(c-a)*fz+(a-b-c+d)*fx*fz;
  }
  function groundHeight(x,z){
    const h=heightAt(x,z), e=(worldSize/(N-1))*1.0||1;
    const dx=heightAt(x+e,z)-heightAt(x-e,z), dz=heightAt(x,z+e)-heightAt(x,z-e);
    let nx=-dx/(2*e), nz=-dz/(2*e), ny=1; const il=1/Math.sqrt(nx*nx+1+nz*nz);
    return { h:h, normal:{x:nx*il,y:ny*il,z:nz*il} };
  }
  return { size:N, worldSize:worldSize, heights:heights, heightAt:heightAt, groundHeight:groundHeight };
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
function quatToMat(q){ const x=q[0],y=q[1],z=q[2],w=q[3]; return [1-2*(y*y+z*z),2*(x*y+z*w),2*(x*z-y*w),0, 2*(x*y-z*w),1-2*(x*x+z*z),2*(y*z+x*w),0, 2*(x*z+y*w),2*(y*z-x*w),1-2*(x*x+y*y),0, 0,0,0,1]; }
function itemTransform(item){
  const p=posOf(item); let rot=null;
  if(Array.isArray(item.rotationMatrix) && item.rotationMatrix.length>=9){ const m=item.rotationMatrix; rot=[m[0],m[3],m[6],0, m[1],m[4],m[7],0, m[2],m[5],m[8],0, 0,0,0,1]; }
  else if(Array.isArray(item.rotation) && item.rotation.length===4) rot=quatToMat(item.rotation);
  else if(Array.isArray(item.rotationMatrix) && item.rotationMatrix.length===16) rot=item.rotationMatrix.slice();
  if(!rot) rot=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const sc=item.scale; const sx=Array.isArray(sc)?(sc[0]||1):(typeof sc==='number'?sc:1), sy=Array.isArray(sc)?(sc[1]===undefined?sx:sc[1]):sx, sz=Array.isArray(sc)?(sc[2]===undefined?sx:sc[2]):sx;
  const out=rot.slice(); // R * S (column-major: scale columns)
  for(let c=0;c<3;c++){ const s=[sx,sy,sz][c]; out[c*4]*=s; out[c*4+1]*=s; out[c*4+2]*=s; }
  out[12]=p[0]; out[13]=p[1]; out[14]=p[2]; return out;
}
function roadNodes(item){
  const raw=item.nodes||item.points||item.roadNodes||[]; const out=[];
  for(const nd of raw){ if(Array.isArray(nd)) out.push({position:[nd[0]||0,nd[1]||0,nd[2]||0], width: nd.length>3? nd[3] : (item.width||8)});
    else if(nd && typeof nd==='object'){ const p=nd.position||nd.pos||[nd.x||0,nd.y||0,nd.z||0]; out.push({position:Array.isArray(p)?p:[p.x||0,p.y||0,p.z||0], width: nd.width||item.width||8}); } }
  return out;
}
function buildRibbon(nodes, heightfield, materialName){
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
  opts=opts||{}; const onProgress=opts.onProgress||function(){};
  const report={ levelName:null, terrainSize:0, worldSize:0, counts:{items:0,roads:0,statics:0,forestPlacements:0,texturesDecoded:0,texturesFallback:0}, missing:[], substitutions:[], warnings:[] };
  const lower=lowerMap(zipMap);
  const keys=Array.from(zipMap.keys()).map(normPath);
  // locate level
  let levelPrefix=null, levelName=null;
  for(const k of keys){ const m=/^levels\/([^/]+)\//i.exec(k); if(m){ levelPrefix='levels/'+m[1]+'/'; levelName=m[1]; break; } }
  if(!levelPrefix) throw new Error('importMap: no levels/<name>/ folder found in zip');
  report.levelName=levelName;
  const lp=levelPrefix.toLowerCase();
  function levelFiles(suffixTest){ return keys.filter(function(k){ return k.toLowerCase().startsWith(lp) && suffixTest(k.toLowerCase()); }); }
  // info.json
  let title=levelName; const infoBytes=getFile(zipMap,lower,levelPrefix+'info.json'); if(infoBytes){ const o=parseJsonSafe(decodeText(infoBytes)); if(o&&(o.title||o.name)) title=o.title||o.name; }
  // ---- terrain
  onProgress({stage:'terrain', frac:0.05, msg:'Reading terrain…'});
  let squareSize=1, maxHeight=200, gridHint=0;
  for(const k of levelFiles(function(x){return x.endsWith('.terrain.json');})){ const o=parseJsonSafe(decodeText(zipMap.get(k))); if(o){ if(o.squareSize) squareSize=o.squareSize; if(o.maxHeight) maxHeight=o.maxHeight; if(o.heightmapSize) gridHint=o.heightmapSize; if(o.size) gridHint=o.size; } }
  const terKey=keys.find(function(k){ return k.toLowerCase().startsWith(lp) && k.toLowerCase().endsWith('.ter'); });
  let heightfield=null, terLayout=null;
  if(terKey){ const ter=parseTer(zipMap.get(terKey), {maxHeight:maxHeight, gridSize:gridHint}); terLayout=ter.layout; heightfield=makeHeightfield(ter, squareSize); if(ter.trailingBytes>0) report.warnings.push('.ter layout "'+ter.layout+'" matched with '+ter.trailingBytes+' trailing bytes (layer/material data not decoded)'); }
  else { report.warnings.push('No .ter file found; using flat terrain'); heightfield=makeHeightfield({size:2, heights:new Float32Array(4)}, squareSize); report.missing.push({kind:'other', path:levelPrefix+'theTerrain.ter', referencedBy:'level'}); }
  const pngHm=keys.filter(function(k){ return /heightmap.*\.png$/i.test(k) || /import\/.*\.png$/i.test(k); });
  if(pngHm.length) report.warnings.push('Heightmap PNG present ('+pngHm.join(', ')+') — noted only; .ter is the primary height source (PNG heightmap decoding not implemented)');
  report.terrainSize=heightfield.size; report.worldSize=heightfield.worldSize;
  onProgress({stage:'terrain', frac:0.2, msg:'Terrain '+heightfield.size+'×'+heightfield.size+' ('+Math.round(heightfield.worldSize)+' m) from '+(terLayout||'fallback')});
  // ---- items
  onProgress({stage:'items', frac:0.25, msg:'Reading scene items…'});
  const items=[]; const spawns=[], roads=[], staticsRaw=[], notes=[];
  for(const k of levelFiles(function(x){ return x.endsWith('items.level.json'); })){ for(const it of parseJsonLines(decodeText(zipMap.get(k)))) items.push(it); }
  const matDefs=collectMaterialDefs(zipMap, lower);
  const meshCache=new Map();
  function loadMesh(path, referencedBy){
    const np=normPath(path); const full = hasFile(lower,np) ? np : (hasFile(lower, levelPrefix+np) ? levelPrefix+np : null);
    if(!full){ report.missing.push({kind:'mesh', path:np, referencedBy:referencedBy}); return null; }
    if(meshCache.has(full)) return meshCache.get(full);
    let mesh=null;
    if(full.toLowerCase().endsWith('.dae')){ if(!_DAE){ report.warnings.push('DAE parser unavailable for '+full); } else { const parsed=_DAE.parseDAE(decodeText(zipMap.get(full))); mesh=parsed; } }
    else { report.warnings.push('Mesh format not decoded (kept as reference): '+full); mesh={meshes:{},nodes:[],materials:[],unsupportedFormat:true}; }
    meshCache.set(full, mesh); return mesh;
  }
  for(const it of items){
    const cls=it.class||it.type||'';
    if(cls==='SpawnSphere'){ const p=posOf(it); let heading=0; if(Array.isArray(it.rotation)&&it.rotation.length===4){ heading=Math.atan2(2*(it.rotation[3]*it.rotation[1]+it.rotation[0]*it.rotation[2]), 1-2*(it.rotation[1]*it.rotation[1]+it.rotation[2]*it.rotation[2])); } spawns.push({position:p, x:p[0], z:p[2], heading:heading, item:it}); }
    else if(cls==='DecalRoad'){ const nds=roadNodes(it); if(nds.length>=2) roads.push(buildRibbon(nds, heightfield, it.material||it.texture||'road')); else report.warnings.push('DecalRoad with <2 nodes skipped'); }
    else if(cls==='MeshRoad'){ notes.push('MeshRoad item present — geometry via its DAE if in zip, else missing (see report)'); const mp=it.shapeName||it.mesh; if(mp){ if(!loadMesh(mp,'MeshRoad')){} } }
    else if(cls==='LevelInfo'){ if(it.sunElevation!==undefined||it.sky){ notes.push('LevelInfo found (sun/sky basics not converted)'); } }
    const shape=it.shapeName||it.shapeFile||it.mesh||it.filename;
    if(typeof shape==='string' && shape){ const mesh=loadMesh(shape, cls||'item'); if(mesh) staticsRaw.push({mesh:mesh, transform:itemTransform(it), materialNames: mesh.materials||[], item:it, shapeName:shape}); }
  }
  report.counts.items=items.length;
  onProgress({stage:'items', frac:0.4, msg:'Parsed '+items.length+' scene items ('+spawns.length+' spawns)'});
  onProgress({stage:'roads', frac:0.5, msg:'Building '+roads.length+' decal road ribbons…'});
  report.counts.roads=roads.length;
  // ---- forest
  onProgress({stage:'forest', frac:0.55, msg:'Placing forest items…'});
  const brushMap=collectBrushMap(zipMap, lower); const forestPlacements=[]; const forestCounts={};
  const forestFiles=keys.filter(function(k){ const lk=k.toLowerCase(); return lk.startsWith(lp) && (lk.endsWith('.forest.json')||lk.endsWith('.forest4.json')); });
  for(const k of forestFiles){ const entries=parseJsonLines(decodeText(zipMap.get(k))); if(!entries.length){ const o=parseJsonSafe(decodeText(zipMap.get(k))); if(Array.isArray(o)) entries.push.apply(entries,o); }
    for(const e of entries){ const type=e.type||e.name||'unknown'; const meshPath=brushMap[type]||e.mesh||e.shapeName||null; const p=posOf(e);
      forestPlacements.push({ meshPath:meshPath, position:p, rotation:e.rotation||null, scale:e.scale===undefined?1:e.scale, type:type });
      forestCounts[type]=(forestCounts[type]||0)+1;
      if(meshPath) loadMesh(meshPath, 'forest:'+type); else report.missing.push({kind:'mesh', path:'(unmapped forest type)', referencedBy:'forest:'+type});
    } }
  report.counts.forestPlacements=forestPlacements.length;
  onProgress({stage:'forest', frac:0.65, msg:'Placing '+forestPlacements.length+' forest items…'});
  // ---- statics + textures
  onProgress({stage:'statics', frac:0.7, msg:'Converting '+staticsRaw.length+' static meshes…'});
  report.counts.statics=staticsRaw.length;
  onProgress({stage:'textures', frac:0.8, msg:'Decoding textures…'});
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
  onProgress({stage:'textures', frac:0.9, msg:'Textures: '+report.counts.texturesDecoded+' decoded, '+report.counts.texturesFallback+' fallback'});
  const converted={ levelName:levelName, title:title, heightfield:heightfield, terrainLayout:terLayout, items:items, spawns:spawns, roads:roads, statics:staticsRaw, forestPlacements:forestPlacements, forestCounts:forestCounts, textures:textures, materials:matDefs, notes:notes, report:report };
  onProgress({stage:'world', frac:0.95, msg:'Building world…'});
  converted.world=new BeamngWorld(converted);
  onProgress({stage:'done', frac:1, msg:'Done: '+levelName+' — '+report.counts.items+' items, '+report.counts.roads+' roads, '+report.counts.forestPlacements+' forest placements'});
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
