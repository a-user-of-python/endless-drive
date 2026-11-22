'use strict';
/* Collada (.dae) subset parser: static geometry, scene graph, materials.
   Own XML tokenizer (no DOMParser) so it runs in Node and browsers alike.
   Skinning/controllers are skipped (noted in result.notes). */
function tokenizeXML(text){
  const root={tag:'#root',attrs:{},children:[],text:''}; const stack=[root]; let i=0; const n=text.length;
  function decodeEntities(s){ return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&'); }
  while(i<n){
    const lt=text.indexOf('<',i);
    if(lt<0){ stack[stack.length-1].text+=decodeEntities(text.slice(i)); break; }
    if(lt>i) stack[stack.length-1].text+=decodeEntities(text.slice(i,lt));
    if(text.startsWith('<!--',lt)){ const e=text.indexOf('-->',lt); i=e<0?n:e+3; continue; }
    if(text.startsWith('<?',lt)){ const e=text.indexOf('?>',lt); i=e<0?n:e+2; continue; }
    if(text.startsWith('<![CDATA[',lt)){ const e=text.indexOf(']]>',lt); stack[stack.length-1].text+= (e<0?text.slice(lt+9):text.slice(lt+9,e)); i=e<0?n:e+3; continue; }
    if(text.startsWith('<!',lt)){ const e=text.indexOf('>',lt); i=e<0?n:e+1; continue; }
    const gt=text.indexOf('>',lt); if(gt<0) break;
    let inside=text.slice(lt+1,gt); const selfClose=/\/\s*$/.test(inside); if(selfClose) inside=inside.replace(/\/\s*$/,'');
    if(inside.startsWith('/')){ const name=inside.slice(1).trim(); for(let k=stack.length-1;k>0;k--){ if(stack[k].tag===name){ stack.length=k; break; } } i=gt+1; continue; }
    const m=/^([^\s/>]+)([\s\S]*)$/.exec(inside); if(!m){ i=gt+1; continue; }
    const node={tag:m[1],attrs:{},children:[],text:''};
    const attrRe=/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let am;
    while((am=attrRe.exec(m[2]))!==null) node.attrs[am[1]]=decodeEntities(am[3]!==undefined?am[3]:am[4]);
    stack[stack.length-1].children.push(node);
    if(!selfClose) stack.push(node);
    i=gt+1;
  }
  return root;
}
function findAll(node,tag,out){ out=out||[]; for(const c of node.children){ if(c.tag===tag) out.push(c); findAll(c,tag,out); } return out; }
function findChild(node,tag){ for(const c of node.children) if(c.tag===tag) return c; return null; }
function floats(s){ return (s||'').trim().split(/\s+/).filter(Boolean).map(Number); }
function ints(s){ return (s||'').trim().split(/\s+/).filter(Boolean).map(function(v){return parseInt(v,10);}); }
function stripHash(u){ return (u||'').replace(/^#/,''); }
// column-major 4x4 helpers
function matIdentity(){ return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function matMul(a,b){ const o=new Array(16); for(let c=0;c<4;c++) for(let r=0;r<4;r++){ let s=0; for(let k=0;k<4;k++) s+=a[k*4+r]*b[c*4+k]; o[c*4+r]=s; } return o; }
function matFromRowMajor(v){ const o=new Array(16); for(let r=0;r<4;r++) for(let c=0;c<4;c++) o[c*4+r]=v[r*4+c]; return o; }
function matTranslate(x,y,z){ const m=matIdentity(); m[12]=x; m[13]=y; m[14]=z; return m; }
function matScale(x,y,z){ const m=matIdentity(); m[0]=x; m[5]=y; m[10]=z; return m; }
function matRotate(x,y,z,deg){ const a=deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a), t=1-c; const len=Math.sqrt(x*x+y*y+z*z)||1; x/=len; y/=len; z/=len;
  return [t*x*x+c, t*x*y+s*z, t*x*z-s*y, 0,  t*x*y-s*z, t*y*y+c, t*y*z+s*x, 0,  t*x*z+s*y, t*y*z-s*x, t*z*z+c, 0,  0,0,0,1]; }

function parseGeometry(meshEl){
  const sources={};
  for(const src of findAll(meshEl,'source')){
    const fa=findChild(src,'float_array'); if(!fa) continue;
    const acc=findChild(findChild(src,'technique_common')||src,'accessor');
    sources[src.attrs.id]={ data:floats(fa.text), stride: acc? (parseInt(acc.attrs.stride||'1',10)) : 1 };
  }
  const vertsEl=findChild(meshEl,'vertices'); const vertInputs={};
  if(vertsEl) for(const inp of vertsEl.children) if(inp.tag==='input') vertInputs[inp.attrs.semantic]=stripHash(inp.attrs.source);
  const prims=[];
  for(const prim of meshEl.children){
    if(prim.tag!=='triangles' && prim.tag!=='polylist' && prim.tag!=='tristrips') continue;
    const inputs=[]; let maxOff=-1;
    for(const inp of prim.children) if(inp.tag==='input'){ const off=parseInt(inp.attrs.offset||'0',10); maxOff=Math.max(maxOff,off); inputs.push({semantic:inp.attrs.semantic, source:stripHash(inp.attrs.source), offset:off}); }
    const stride=maxOff+1;
    const pEl=findChild(prim,'p'); if(!pEl) continue;
    const p=ints(pEl.text);
    let vcounts=null;
    if(prim.tag==='polylist'){ const vc=findChild(prim,'vcount'); vcounts=vc?ints(vc.text):null; }
    // expand primitive into triangle vertex-tuples (positionIdx, normalIdx, uvIdx)
    const tuples=[];
    if(prim.tag==='tristrips'){ prims.push({material:prim.attrs.material||null, tuples:[], unsupported:'tristrips skipped'}); continue; }
    let cursor=0;
    const groups = vcounts ? vcounts : null;
    if(groups){ for(const vc of groups){ const poly=[]; for(let v=0;v<vc;v++){ poly.push(p.slice(cursor,cursor+stride)); cursor+=stride; } for(let v=1;v+1<poly.length;v++) tuples.push(poly[0],poly[v],poly[v+1]); } }
    else { const nv=p.length/stride; for(let v=0;v+2<nv;v+=3) tuples.push(p.slice(v*stride,(v+1)*stride), p.slice((v+1)*stride,(v+2)*stride), p.slice((v+2)*stride,(v+3)*stride)); }
    prims.push({ material: prim.attrs.material||null, tuples:tuples, inputs:inputs, stride:stride });
  }
  // build de-indexed-aligned arrays via unique tuple map
  const positions=[], normals=[], uvs=[], indices=[]; const seen=new Map();
  let material=null;
  function srcFor(semantic, prim){
    for(const inp of prim.inputs){ if(inp.semantic===semantic) return {id: inp.source=== (vertsEl&&vertsEl.attrs.id) ? null : inp.source, inp:inp}; }
    return null;
  }
  function resolveSource(semantic, prim){
    for(const inp of prim.inputs){
      if(inp.semantic===semantic){ if(sources[inp.source]) return {src:sources[inp.source], off:inp.offset}; if(vertInputs[semantic] && inp.source===vertsEl.attrs.id){ /* fallthrough */ } }
      if(inp.semantic==='VERTEX' && vertInputs[semantic]){ const vid=vertInputs[semantic]; if(sources[vid]) return {src:sources[vid], off:inp.offset}; }
    }
    return null;
  }
  for(const prim of prims){
    if(prim.unsupported) continue;
    if(material===null) material=prim.material;
    const posR=resolveSource('POSITION',prim), norR=resolveSource('NORMAL',prim), uvR=resolveSource('TEXCOORD',prim);
    for(const tup of prim.tuples){
      const key=tup.join(',');
      if(seen.has(key)){ indices.push(seen.get(key)); continue; }
      const idx=positions.length/3;
      if(posR){ const si=tup[posR.off]*posR.src.stride; positions.push(posR.src.data[si]||0, posR.src.data[si+1]||0, posR.src.data[si+2]||0); } else positions.push(0,0,0);
      if(norR){ const si=tup[norR.off]*norR.src.stride; normals.push(norR.src.data[si]||0, norR.src.data[si+1]||0, norR.src.data[si+2]||0); } else normals.push(0,1,0);
      if(uvR){ const si=tup[uvR.off]*uvR.src.stride; uvs.push(uvR.src.data[si]||0, uvR.src.data[si+1]||0); } else uvs.push(0,0);
      seen.set(key,idx); indices.push(idx);
    }
  }
  return { positions:new Float32Array(positions), normals:new Float32Array(normals), uvs:new Float32Array(uvs), indices:new Uint32Array(indices), material:material };
}
function parseDAE(text){
  const root=tokenizeXML(String(text)); const notes=[];
  if(findAll(root,'library_controllers').length) notes.push('skinning/controllers present and skipped (static geometry only)');
  const meshes={};
  for(const lib of findAll(root,'library_geometries')) for(const g of lib.children) if(g.tag==='geometry'){ const mesh=findChild(g,'mesh'); if(mesh) meshes[g.attrs.id]=parseGeometry(mesh); }
  const materials=[]; const matById={};
  for(const lib of findAll(root,'library_materials')) for(const m of lib.children) if(m.tag==='material'){ const name=m.attrs.name||m.attrs.id; matById[m.attrs.id]=name; if(materials.indexOf(name)<0) materials.push(name); }
  for(const lib of findAll(root,'library_effects')) for(const e of lib.children) if(e.tag==='effect'){ if(e.attrs.name && materials.indexOf(e.attrs.name)<0) materials.push(e.attrs.name); }
  const nodes=[];
  function walk(nodeEl, parent){
    let local=matIdentity();
    for(const ch of nodeEl.children){
      if(ch.tag==='matrix') local=matMul(local, matFromRowMajor(floats(ch.text)));
      else if(ch.tag==='translate'){ const v=floats(ch.text); local=matMul(local, matTranslate(v[0]||0,v[1]||0,v[2]||0)); }
      else if(ch.tag==='rotate'){ const v=floats(ch.text); local=matMul(local, matRotate(v[0]||0,v[1]||0,v[2]||1,v[3]||0)); }
      else if(ch.tag==='scale'){ const v=floats(ch.text); local=matMul(local, matScale(v[0]===undefined?1:v[0], v[1]===undefined?1:v[1], v[2]===undefined?1:v[2])); }
    }
    const world=matMul(parent, local);
    for(const ch of nodeEl.children){
      if(ch.tag==='instance_geometry'){
        let matName=null;
        for(const im of findAll(ch,'instance_material')){ matName = matById[stripHash(im.attrs.target)] || im.attrs.symbol || matName; }
        nodes.push({ name: nodeEl.attrs.name||nodeEl.attrs.id||'', transform: world.slice(), geometryId: stripHash(ch.attrs.url), material: matName });
      }
    }
    for(const ch of nodeEl.children) if(ch.tag==='node') walk(ch, world);
  }
  for(const lib of findAll(root,'library_visual_scenes')) for(const scene of lib.children) if(scene.tag==='visual_scene') for(const n of scene.children) if(n.tag==='node') walk(n, matIdentity());
  return { meshes:meshes, nodes:nodes, materials:materials, notes:notes };
}
const API={ parseDAE:parseDAE, tokenizeXML:tokenizeXML };
if (typeof globalThis!=='undefined') globalThis.__DAE = API;
if (typeof module!=='undefined') module.exports = API;
