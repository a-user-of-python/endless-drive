'use strict';
const assert=require('assert');
const BMAP=require('./js/import/beamng-map.js');
const DAE=require('./js/import/dae.js');
const DDS=require('./js/import/dds.js');
function enc(s){ return new TextEncoder().encode(s); }
(async function(){
  let passed=0; function ok(name,cond){ assert(cond,name); passed++; console.log('ok -',name); }
  // (a) .ter round-trip: writer for header12-u16 layout
  const N=5, maxH=100, heightsIn=[]; for(let i=0;i<N*N;i++) heightsIn.push(i*2); // 0..48
  const terBuf=new Uint8Array(12+N*N*2); const dv=new DataView(terBuf.buffer);
  dv.setUint32(0,9,true); dv.setUint32(4,N,true); dv.setUint32(8,0,true);
  heightsIn.forEach(function(h,i){ dv.setUint16(12+i*2, Math.round(h/maxH*65535), true); });
  const zip=new Map();
  zip.set('levels/testmap/info.json', enc(JSON.stringify({title:'Test Map'})));
  zip.set('levels/testmap/theTerrain.terrain.json', enc(JSON.stringify({squareSize:10, maxHeight:maxH})));
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
  // (b) items
  const lines=[
    {class:'SpawnSphere', position:[0,10,0]},
    {class:'DecalRoad', material:'AsphaltRoad', nodes:[[-20,0,-20,8],[0,0,0,8],[20,0,20,8]]},
    {class:'TSStatic', shapeName:'art/shapes/box.dae', position:[3,0,4]},
    {class:'TSStatic', shapeName:'art/shapes/absent.dae', position:[9,0,9]},
  ].map(function(o){return JSON.stringify(o);}).join('\n');
  zip.set('levels/testmap/main/items.level.json', enc(lines));
  const stages=[]; const conv=await BMAP.importMap(zip,{onProgress:function(p){stages.push(p.stage);}});
  ok('ter layout header12', conv.terrainLayout==='header12-u16');
  ok('heightfield size/worldSize', conv.heightfield.size===5 && conv.heightfield.worldSize===50);
  // sample point: grid col/row centre (index 12) -> world (0,0)
  ok('heightAt centre approx', Math.abs(conv.heightfield.heightAt(0,0)-24)<0.1);
  // bilinear midpoint between centre(24) and right neighbour(26): x = +6.25 (one half cell: cell=12.5)
  const mid=conv.heightfield.heightAt(6.25,0); ok('bilinear midpoint is average', Math.abs(mid-(24+26)/2)<0.15);
  ok('spawns parsed', conv.spawns.length===1);
  ok('roads parsed + ribbon indices', conv.roads.length===1 && conv.roads[0].indices.length===12 && conv.roads[0].length>50);
  ok('statics parsed (in-zip dae)', conv.statics.length===1);
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
  const w=conv.world; const gh=w.groundHeight(0,0,0); ok('world groundHeight fixture height', Math.abs(gh.h-24)<0.1);
  ok('world groundHeight surface road at centre', gh.surface==='road');
  const p=w.trackPoint(10); ok('world trackPoint on road', isFinite(p.x)&&isFinite(p.z));
  const hsl=w.heightAtSL(10,0); ok('world heightAtSL', isFinite(hsl.h));
  const conv2=await BMAP.importMap(new Map([['levels/m2/info.json',enc('{}')],['levels/m2/theTerrain.terrain.json',enc(JSON.stringify({squareSize:10,maxHeight:maxH}))],['levels/m2/theTerrain.ter',terBuf]]),{});
  ok('world without roads does not throw', isFinite(conv2.world.trackPoint(5).x) && isFinite(conv2.world.heightAtSL(5,2).h) && isFinite(conv2.world.groundHeight(0,0,0).h));
  ok('world spawn fallback centre', conv2.world.spawnPoint().x===0);
  console.log('\nPASS '+passed+' checks; counts='+JSON.stringify(conv.report.counts)+' missing='+JSON.stringify(conv.report.missing));
})().catch(function(e){ console.error('FAIL', e); process.exit(1); });
