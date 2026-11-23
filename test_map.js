'use strict';
const assert=require('assert');
const BMAP=require('./js/import/beamng-map.js');
const DAE=require('./js/import/dae.js');
const DDS=require('./js/import/dds.js');
function enc(s){ return new TextEncoder().encode(s); }
/* Spec-exact v9 .ter writer (5-byte header: u8 version=9, u32LE N;
   N² u16LE samples at offset 5, index x + y*N, row 0 = south;
   N² u8 layer map; u32LE material count + length-prefixed names). */
function buildTer(N, sampleFn, layerFn, names){
  const total=5+N*N*2+N*N+4+names.reduce(function(a,n){ return a+1+enc(n).length; },0);
  const buf=new Uint8Array(total); const dv=new DataView(buf.buffer);
  buf[0]=9; dv.setUint32(1,N,true);
  for(let y=0;y<N;y++) for(let x=0;x<N;x++) dv.setUint16(5+(y*N+x)*2, sampleFn(x,y), true);
  for(let y=0;y<N;y++) for(let x=0;x<N;x++) buf[5+N*N*2+y*N+x]=layerFn?layerFn(x,y):0;
  let pos=5+N*N*3; dv.setUint32(pos,names.length,true); pos+=4;
  for(const n of names){ const b=enc(n); buf[pos]=b.length; pos+=1; buf.set(b,pos); pos+=b.length; }
  return buf;
}
(async function(){
  let passed=0; function ok(name,cond){ assert(cond,name); passed++; console.log('ok -',name); }
  // (a) .ter round-trip with a REAL v9 file. Heights h=(x+y)*3 m at
  // maxHeight 100 — symmetric in x/y and asserted only on the middle
  // row, so the values hold under every orientation variant the
  // importer might score (the TerrainBlock below pins scale, not
  // orientation). UPDATED from the old test, which pinned the WRONG
  // guessed header12 layout and read squareSize/maxHeight out of
  // terrain.json — neither exists in the real format.
  const N=5, maxH=100;
  const terBuf=buildTer(N, function(x,y){ return Math.round((x+y)*3/maxH*65535); }, null, ['Grass','Asphalt']);
  const zip=new Map();
  zip.set('levels/testmap/info.json', enc(JSON.stringify({title:'Test Map'})));
  zip.set('levels/testmap/theTerrain.terrain.json', enc(JSON.stringify({version:9, size:N, heightMapSize:N*N, layerMapSize:N*N, heightMapItemSize:2, layerMapItemSize:1, materials:['Grass','Asphalt']})));
  zip.set('levels/testmap/theTerrain.ter', terBuf);
  // (c) tiny DAE
  const daeText=`<?xml version="1.0"?><COLLADA><library_geometries><geometry id="g1"><mesh>
    <source id="pos"><float_array id="pa" count="12">0 0 0 1 0 0 1 1 0 0 1 0</float_array><technique_common><accessor source="#pa" count="4" stride="3"><param name="X" type="float"/></accessor></technique_common></source>
    <source id="nor"><float_array id="na" count="12">0 0 1 0 0 1 0 0 1 0 0 1</float_array><technique_common><accessor source="#na" count="4" stride="3"><param name="X" type="float"/></accessor></technique_common></source>
    <vertices id="verts"><input semantic="POSITION" source="#pos"/></vertices>
    <triangles count="2" material="mat1"><input semantic="VERTEX" source="#verts" offset="0"/><input semantic="NORMAL" source="#nor" offset="1"/><p>0 0 1 1 2 2 0 0 2 2 3 3</p></triangles>
    </mesh></geometry></library_geometries>
    <library_materials><material id="mat1" name="mat1"/></library_materials>
    <library_visual_scenes><visual_scene id="s"><node name="n1"><translate>5 6 7</translate><instance_geometry url="#g1"><bind_material><technique_common><instance_material symbol="mat1" target="#mat1"/></technique_common></bind_material></instance_geometry></node></visual_scene></library_visual_scenes></COLLADA>`;
  zip.set('levels/testmap/art/shapes/box.dae', enc(daeText));
  // (b) items. NOTE (v2.7.1): the DecalRoad nodes below were UPDATED —
  // the old test wrote them as [x, ?, groundZ, w], pinning the pre-fix
  // convention that read node[2] as ground-z. Real BeamNG DecalRoad
  // nodes are [x, y-north, z-up, width], so the same diagonal road is
  // now written [[-20,-20,0,8],[0,0,0,8],[20,20,0,8]] (running from
  // SW to NE, node heights 0). The road still passes through the
  // centre with the same total length, so the assertions below hold
  // unchanged.
  const lines=[
    {class:'TerrainBlock', terrainFile:'levels/testmap/theTerrain.ter', squareSize:10, maxHeight:maxH, position:[-25,-25,0]},
    {class:'SpawnSphere', position:[0,10,0]},
    {class:'DecalRoad', material:'AsphaltRoad', nodes:[[-20,-20,0,8],[0,0,0,8],[20,20,0,8]]},
    {class:'TSStatic', shapeName:'art/shapes/box.dae', position:[3,0,4]},
    {class:'TSStatic', shapeName:'art/shapes/absent.dae', position:[9,0,9]},
  ].map(function(o){return JSON.stringify(o);}).join('\n');
  zip.set('levels/testmap/main/items.level.json', enc(lines));
  const stages=[]; const conv=await BMAP.importMap(zip,{onProgress:function(p){stages.push(p.stage);}});
  ok('ter layout v9', conv.terrainLayout==='v9');
  ok('heightfield size/worldSize', conv.heightfield.size===5 && conv.heightfield.worldSize===50);
  // centre sample (x=2,y=2) -> h=(2+2)*3=12 m at world (0,0)
  ok('heightAt centre approx', Math.abs(conv.heightfield.heightAt(0,0)-12)<0.1);
  // bilinear midpoint between centre(12) and right neighbour(15): x = +6.25 (one half cell: cell=12.5)
  const mid=conv.heightfield.heightAt(6.25,0); ok('bilinear midpoint is average', Math.abs(mid-(12+15)/2)<0.15);
  ok('spawns parsed', conv.spawns.length===1);
  // spawn conversion (v2.7.1): BeamNG [0, 10, 0] is 10 m NORTH of
  // centre at height 0 -> engine (x=0, z=-10). The old code put the
  // spawn's height (p[2]=0) into z and lost the northing entirely.
  ok('spawn converted to engine frame', conv.spawns[0].x===0 && conv.spawns[0].z===-10);
  ok('roads parsed + ribbon indices', conv.roads.length===1 && conv.roads[0].indices.length===12 && conv.roads[0].length>50);
  ok('statics parsed (in-zip dae)', conv.statics.length===1);
  // static transform conversion (v2.7.1): BeamNG position [3, 0, 4]
  // (3 east, 0 north, 4 up) -> engine translation (3, 4, 0). The old
  // verbatim copy put north in the up slot and up in the z slot.
  ok('static transform converted', (function(){ const t=conv.statics[0].transform; return Math.abs(t[12]-3)<1e-9 && Math.abs(t[13]-4)<1e-9 && Math.abs(t[14]-0)<1e-9; })());
  ok('absent dae in missing', conv.report.missing.some(function(m){return m.kind==='mesh'&&/absent\.dae/.test(m.path);}));
  ok('progress stages include terrain/done', stages.indexOf('terrain')>=0 && stages[stages.length-1]==='done');
  // (c) DAE asserts
  const parsed=DAE.parseDAE(daeText); const mesh=parsed.meshes['g1'];
  ok('dae positions', mesh && mesh.positions.length===12);
  ok('dae indices 2 triangles', mesh.indices.length===6);
  ok('dae node transform translation', parsed.nodes.length===1 && Math.abs(parsed.nodes[0].transform[12]-5)<1e-6 && Math.abs(parsed.nodes[0].transform[14]-7)<1e-6);
  ok('dae material name', parsed.nodes[0].material==='mat1');
  // (d) DDS DXT1: endpoints red (0xF800) / green (0x07E0), all indices 0 -> all red
  const dds=new Uint8Array(128+8); const ddv=new DataView(dds.buffer);
  dds[0]=0x44;dds[1]=0x44;dds[2]=0x53;dds[3]=0x20; ddv.setUint32(4,124,true); ddv.setUint32(12,4,true); ddv.setUint32(16,4,true); ddv.setUint32(76,32,true); ddv.setUint32(80,0x4,true); dds[84]=0x44;dds[85]=0x58;dds[86]=0x54;dds[87]=0x31; // DXT1
  ddv.setUint16(128,0xF800,true); ddv.setUint16(130,0x07E0,true); ddv.setUint32(132,0,true);
  const dec=DDS.decodeDDS(dds); ok('dds dxt1 size', dec.width===4&&dec.height===4&&dec.data.length===64);
  ok('dds dxt1 red pixels', dec.data[0]===255&&dec.data[1]===0&&dec.data[2]===0&&dec.data[3]===255);
  let threw=false; try{ const b2=dds.slice(); b2[84]=0x42;b2[85]=0x43;b2[86]=0x37;b2[87]=0x20; DDS.decodeDDS(b2); }catch(e){ threw=/unsupported/.test(e.message); } ok('dds BC7 throws unsupported', threw);
  // (e) classify + fallback
  const cases={'grass_04':'grass','AsphaltRoad':'asphalt','rock_cliff':'rock','sand_beach':'sand','concrete_wall':'concrete','mud_track':'mud','zzzqqq':'unknown'};
  for(const k of Object.keys(cases)) ok('classify '+k, BMAP.classifySurface(k)===cases[k]);
  const f1=BMAP.makeFallbackTexture('grass'), f2=BMAP.makeFallbackTexture('grass');
  ok('fallback deterministic', Buffer.from(f1.data).equals(Buffer.from(f2.data)));
  const f3=BMAP.makeFallbackTexture('grass',[1,0,0]); ok('fallback tint changes output', !Buffer.from(f1.data).equals(Buffer.from(f3.data)));
  // (f) BeamngWorld
  const w=conv.world; const gh=w.groundHeight(0,0,0); ok('world groundHeight fixture height', Math.abs(gh.h-12)<0.1);
  ok('world groundHeight surface road at centre', gh.surface==='road');
  const p=w.trackPoint(10); ok('world trackPoint on road', isFinite(p.x)&&isFinite(p.z));
  const hsl=w.heightAtSL(10,0); ok('world heightAtSL', isFinite(hsl.h));
  const conv2=await BMAP.importMap(new Map([['levels/m2/info.json',enc('{}')],['levels/m2/theTerrain.terrain.json',enc(JSON.stringify({version:9,size:N,heightMapSize:N*N,layerMapSize:N*N,heightMapItemSize:2,layerMapItemSize:1,materials:['Grass','Asphalt']}))],['levels/m2/theTerrain.ter',terBuf]]),{});
  ok('world without roads does not throw', isFinite(conv2.world.trackPoint(5).x) && isFinite(conv2.world.heightAtSL(5,2).h) && isFinite(conv2.world.groundHeight(0,0,0).h));
  ok('world spawn fallback centre', conv2.world.spawnPoint().x===0);
  // (g) research-report fixture pattern: flat 64×64, every sample 1279,
  // maxHeight 512 -> exactly ~10.0 m; materials Material0/Material1.
  const fxTer=buildTer(64, function(){ return 1279; }, null, ['Material0','Material1']);
  ok('fixture-pattern file size equation', fxTer.length===12317);
  const fxParsed=BMAP.parseTer(fxTer, {maxHeight:512});
  ok('fixture-pattern parse', fxParsed.size===64 && fxParsed.layout==='v9' && fxParsed.trailingBytes===0);
  ok('fixture-pattern materials', JSON.stringify(fxParsed.materials)===JSON.stringify(['Material0','Material1']));
  ok('fixture-pattern height 10 m', Math.abs(fxParsed.heights[0]-10)<0.01 && Math.abs(fxParsed.heights[64*64-1]-10)<0.01);
  const fxHf=BMAP.makeHeightfield(fxParsed, 1, {maxHeight:512});
  ok('fixture-pattern heightAt 10 m', Math.abs(fxHf.heightAt(0,0)-10)<0.01);
  // (h) terrain.json cross-checks: (a)'s json agrees -> no 'disagree'
  // warnings, and the TerrainBlock is recorded as the scale source.
  ok('terrain.json agreement is quiet', !conv.report.warnings.some(function(s){ return /disagree/.test(s); }));
  ok('terrainChoice records TerrainBlock sources', !!conv.report.terrainChoice && conv.report.terrainChoice.maxHeightSource==='TerrainBlock' && conv.report.terrainChoice.squareSizeSource==='TerrainBlock' && conv.report.terrainChoice.size===5);
  const zipBad=new Map(zip); zipBad.set('levels/testmap/theTerrain.terrain.json', enc(JSON.stringify({version:9, size:999, heightMapSize:25, layerMapSize:25, heightMapItemSize:2, layerMapItemSize:1, materials:['Grass','Asphalt']})));
  const convBad=await BMAP.importMap(zipBad,{});
  ok('terrain.json size mismatch warns', convBad.report.warnings.some(function(s){ return /terrain\.json size 999 disagrees/.test(s); }));
  // (i) combination search: NO TerrainBlock, NO terrain.json. Terrain
  // ramps 0 -> 20 m south->north (true scale maxHeight 512, squareSize
  // 1); one SpawnSphere sits on the ground near the north edge in
  // BeamNG coordinates. The search must recover the spec orientation
  // and the true scale, and record the choice + runner-up scores.
  const SN=64;
  const rampTer=buildTer(SN, function(x,y){ return Math.round(y/(SN-1)*(20/512)*65535); }, null, ['Grass']);
  const zipSearch=new Map();
  zipSearch.set('levels/searchmap/info.json', enc(JSON.stringify({title:'Search Map'})));
  zipSearch.set('levels/searchmap/theTerrain.ter', rampTer);
  zipSearch.set('levels/searchmap/main/items.level.json', enc(JSON.stringify({class:'SpawnSphere', position:[0,28,19.05]})));
  const convS=await BMAP.importMap(zipSearch,{});
  const tc=convS.report.terrainChoice;
  ok('search recorded a choice', !!tc && tc.combosTested>1 && tc.runnersUp.length>=1);
  ok('search picked spec orientation', !!tc && tc.flipNS===false && tc.transpose===false);
  ok('search picked true scale', !!tc && tc.maxHeight===512 && tc.squareSize===1);
  ok('search spawn error small', !!tc && typeof tc.spawnErrorMeters==='number' && tc.spawnErrorMeters<1);
  ok('search winner beats runner-up', !!tc && tc.score<=tc.runnersUp[0].score);
  const convS2=await BMAP.importMap(zipSearch,{});
  ok('search is deterministic', !!convS2.report.terrainChoice && convS2.report.terrainChoice.maxHeight===tc.maxHeight && convS2.report.terrainChoice.squareSize===tc.squareSize && convS2.report.terrainChoice.flipNS===tc.flipNS && convS2.report.terrainChoice.transpose===tc.transpose);
  // (j) malformed files throw — never guess a layout
  const badVer=buildTer(8, function(){ return 0; }, null, ['Grass']); badVer[0]=8;
  let threwVer=false; try{ BMAP.parseTer(badVer, {}); }catch(e){ threwVer=/unsupported version 8/.test(e.message); }
  ok('wrong version throws', threwVer);
  const trunc=buildTer(64, function(){ return 7; }, null, ['Grass']).slice(0,1000);
  let threwTrunc=false; try{ BMAP.parseTer(trunc, {}); }catch(e){ threwTrunc=/truncated|too short/.test(e.message); }
  ok('truncated file throws', threwTrunc);
  const zipBadTer=new Map(); zipBadTer.set('levels/badmap/info.json', enc('{}')); zipBadTer.set('levels/badmap/theTerrain.ter', badVer);
  let threwImport=false; try{ await BMAP.importMap(zipBadTer,{}); }catch(e){ threwImport=/unsupported version 8/.test(e.message); }
  ok('importMap propagates the loud failure', threwImport);
  // (k) holes: layer byte 0xFF in the NE 2x2 file corner (x>=6, y>=6 of
  // an 8x8 grid). Engine mapping: file (7,7) is the north-east corner
  // -> engine (x=+4, z=-4); file (0,0) is SW -> engine (-4, +4).
  const holeTer=BMAP.parseTer(buildTer(8, function(){ return 1000; }, function(x,y){ return (x>=6&&y>=6)?0xFF:0; }, ['Grass']), {});
  ok('hole count parsed', holeTer.holeCount===4);
  const holeHf=BMAP.makeHeightfield(holeTer, 1, {maxHeight:100});
  ok('isHoleAt NE corner true', holeHf.isHoleAt(4,-4)===true);
  ok('isHoleAt SW corner false', holeHf.isHoleAt(-4,4)===false);
  ok('world exposes isHoleAt', typeof conv.world.isHoleAt==='function' && conv.world.isHoleAt(0,0)===false);
  // (m) item placement vs terrain orientation — the anti-mirror test
  // (v2.7.1). Terrain: flat 0 m with a 30 m plateau ONLY at the north
  // edge (file rows y>=12 of 16, maxHeight 100, squareSize 1,
  // TerrainBlock at the centred corner [-8,-8,0]). A SpawnSphere
  // standing on that plateau in BeamNG coords ([0, 7, 30] = 7 m north
  // of centre, height 30) must convert to engine z=-7 and sample 30 m
  // there. Under the old convention it landed at z=+7 (south, 0 m) or
  // z=30 (off the map) — this test is the one that would have caught
  // the mirroring. Also pins road / static / forest conversion, the
  // axis-angle heading derivation, and the recorded spawn-ground
  // agreement between the search winner and the converted positions.
  const HN=16;
  const hillTer=buildTer(HN, function(x,y){ return y>=12 ? Math.round(30/100*65535) : 0; }, null, ['Grass']);
  const zipHill=new Map();
  zipHill.set('levels/hillmap/info.json', enc(JSON.stringify({title:'Hill Map'})));
  zipHill.set('levels/hillmap/theTerrain.ter', hillTer);
  zipHill.set('levels/hillmap/art/shapes/box.dae', enc(daeText));
  const hillLines=[
    {class:'TerrainBlock', terrainFile:'levels/hillmap/theTerrain.ter', squareSize:1, maxHeight:100, position:[-8,-8,0]},
    {class:'SpawnSphere', position:[0,7,30], rotation:[0,0,1,0]},
    {class:'SpawnSphere', position:[0,-7,0], rotation:[0,0,1,90]},
    {class:'DecalRoad', material:'AsphaltRoad', nodes:[[-6,7,30,6],[6,7,30,6]]},
    {class:'TSStatic', shapeName:'art/shapes/box.dae', position:[1,7,30]},
  ].map(function(o){return JSON.stringify(o);}).join('\n');
  zipHill.set('levels/hillmap/main/items.level.json', enc(hillLines));
  zipHill.set('levels/hillmap/hill.forest.json', enc(JSON.stringify({type:'oak', position:[3,7,30]})));
  const convH=await BMAP.importMap(zipHill,{});
  ok('hill: north spawn converts to engine -z', convH.spawns[0].x===0 && convH.spawns[0].z===-7);
  ok('hill: north spawn stands on the plateau', Math.abs(convH.heightfield.heightAt(convH.spawns[0].x, convH.spawns[0].z)-30)<0.5);
  ok('hill: south spawn converts to engine +z and samples flat', convH.spawns[1].z===7 && Math.abs(convH.heightfield.heightAt(convH.spawns[1].x, convH.spawns[1].z)-0)<0.5);
  ok('hill: heading identity faces north (PI)', Math.abs(convH.spawns[0].heading-Math.PI)<1e-9);
  ok('hill: heading +90 yaw faces west (-PI/2)', Math.abs(convH.spawns[1].heading+Math.PI/2)<1e-9);
  ok('hill: road node at north edge lands at engine -z', convH.roads.length===1 && convH.roads[0].nodes[0].x===-6 && convH.roads[0].nodes[0].z===-7 && convH.roads[0].nodes[1].x===6);
  ok('hill: static at north position lands at engine -z', (function(){ const t=convH.statics[0].transform; return Math.abs(t[12]-1)<1e-9 && Math.abs(t[13]-30)<1e-9 && Math.abs(t[14]+7)<1e-9; })());
  ok('hill: forest placement converted', convH.forestPlacements.length===1 && JSON.stringify(convH.forestPlacements[0].position)===JSON.stringify([3,30,-7]));
  ok('hill: spawn ground agreement recorded', !!convH.report.terrainChoice && typeof convH.report.terrainChoice.spawnGroundErrorMeters==='number' && convH.report.terrainChoice.spawnGroundErrorMeters<1);
  // (l) REAL fixture file (local-only, never shipped): runs only when
  // the fixture is present; skipped silently otherwise.
  const fs=require('fs'), path=require('path');
  const fxPath=path.join(__dirname,'..','hidden_files','ter-fixture','theTerrain.ter');
  if(fs.existsSync(fxPath)){
    const realBytes=new Uint8Array(fs.readFileSync(fxPath));
    const real=BMAP.parseTer(realBytes, {maxHeight:300});
    ok('real file: N=1024', real.size===1024);
    const sorted=Float32Array.from(real.samples).sort();
    const med=sorted[Math.floor(sorted.length/2)]/65535*300;
    ok('real file: raw min/max in meters', (function(){ let mn=1e9,mx=-1; for(let i=0;i<real.heights.length;i++){ if(real.heights[i]<mn)mn=real.heights[i]; if(real.heights[i]>mx)mx=real.heights[i]; } return Math.abs(mn-0)<0.01 && Math.abs(mx-57711/65535*300)<0.5; })());
    ok('real file: median ~40.3 m at maxHeight 300', Math.abs(med-8810/65535*300)<0.5);
    ok('real file: 11 exact material names', JSON.stringify(real.materials)===JSON.stringify(['Grass','BeachSand','dirt_rocky_large','rock','Mud','Asphalt','gravel','Dirt','Concrete','Grass_Hibiscus','BeachSand_Sunflower']));
    ok('real file: size equation exact', real.trailingBytes===0 && real.sizeEquation.expected===realBytes.length);
    let dsum=0, dcnt=0; const RS=real.samples, RN=real.size;
    for(let y=0;y<RN-8;y+=8) for(let x=0;x<RN-8;x+=8){ dsum+=Math.abs(RS[y*RN+x+8]-RS[y*RN+x])/8+Math.abs(RS[(y+8)*RN+x]-RS[y*RN+x])/8; dcnt+=2; }
    ok('real file: smooth (anti-spike)', (dsum/dcnt)/65535*300<0.5);
    const zipReal=new Map();
    zipReal.set('levels/templatemc/info.json', enc(JSON.stringify({title:'Template'})));
    zipReal.set('levels/templatemc/theTerrain.ter', realBytes);
    zipReal.set('levels/templatemc/theTerrain.terrain.json', new Uint8Array(fs.readFileSync(path.join(__dirname,'..','hidden_files','ter-fixture','theTerrain.terrain.json'))));
    const convR=await BMAP.importMap(zipReal,{});
    ok('real file: importMap terrainSize 1024 + quiet cross-checks', convR.report.terrainSize===1024 && !convR.report.warnings.some(function(s){ return /disagree/.test(s); }) && !!convR.report.terrainChoice);
    console.log('real fixture: holeCount='+real.holeCount+', chosen maxHeight='+convR.report.terrainChoice.maxHeight+' ('+convR.report.terrainChoice.maxHeightSource+'), squareSize='+convR.report.terrainChoice.squareSize+' ('+convR.report.terrainChoice.squareSizeSource+'), score='+convR.report.terrainChoice.score.toFixed(3));
  } else {
    console.log('skip - real .ter fixture not present (local-only test)');
  }
  console.log('\nPASS '+passed+' checks; counts='+JSON.stringify(conv.report.counts)+' missing='+JSON.stringify(conv.report.missing));
})().catch(function(e){ console.error('FAIL', e); process.exit(1); });
