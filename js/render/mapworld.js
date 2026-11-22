/* ================= IMPORTED-MAP RENDERING (integration) =================
   Builds the THREE visuals for a converted BeamNG map (the ConvertedMap
   produced by js/import/beamng-map.js): a vertex-coloured terrain mesh
   from the heightfield, the decal-road ribbons (geometry data built by
   the converter), the static DAE meshes at their item transforms, and
   forest placements as instanced cones. Physics lives in BeamngWorld;
   this file is visuals only.

   window.__MAPWORLD.sync(convertedOrNull) is called from the game loop:
   it is a no-op (one identity comparison) unless the active converted
   map changed, in which case the previous group is removed/disposed
   and the new one built. Known simplifications, stated plainly:
   - a static's DAE is rendered as its merged raw geometry under the
     item transform; per-node transforms inside the DAE scene graph
     are not applied (most static DAEs are a single geometry at the
     origin, where this is exact);
   - forest placements render as generic conifer cones, not their
     real meshes (the converter reports which meshes were present);
   - decoded/fallback textures are applied where the converter keyed
     them by material name; PNG/JPEG entries become THREE textures
     from blobs. */
(function(){
  'use strict';
  let current = null;   // ConvertedMap currently built
  let group = null;     // THREE.Group in the scene

  function disposeGroup(g){
    g.traverse(function(o){
      if (o.geometry) o.geometry.dispose();
      if (o.material){
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms){ if (m.map && m.map._edOwned) m.map.dispose(); m.dispose(); }
      }
    });
  }

  function textureFor(converted, materialName){
    if (!materialName || !converted.textures) return null;
    const t = converted.textures[materialName];
    if (!t) return null;
    try {
      if (t.data && t.width && t.height){ // decoded DDS or procedural fallback (RGBA)
        const tex = new THREE.DataTexture(t.data, t.width, t.height, THREE.RGBAFormat);
        tex.needsUpdate = true;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex._edOwned = true;
        return tex;
      }
      if (t.bytes && t.mime){ // png/jpg kept as bytes by the converter
        const blob = new Blob([t.bytes], { type: t.mime });
        const url = URL.createObjectURL(blob);
        const tex = new THREE.TextureLoader().load(url);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex._edOwned = true;
        return tex;
      }
    } catch (e) { /* fall through to flat colour */ }
    return null;
  }

  function buildTerrain(converted){
    const hf = converted.heightfield;
    const N = hf.size, W = hf.worldSize;
    const step = Math.max(1, Math.ceil(N/192));
    const vertsPerSide = Math.floor((N-1)/step) + 1;
    const pos = new Float32Array(vertsPerSide*vertsPerSide*3);
    const col = new Float32Array(vertsPerSide*vertsPerSide*3);
    const cGrass = [0.36, 0.47, 0.24], cDry = [0.55, 0.48, 0.30],
          cRock = [0.42, 0.40, 0.38], cHigh = [0.75, 0.73, 0.70];
    let p = 0;
    for (let j = 0; j < vertsPerSide; j++){
      for (let i = 0; i < vertsPerSide; i++){
        const x = (i*step/(N-1) - 0.5) * W;
        const z = (j*step/(N-1) - 0.5) * W;
        const h = hf.heightAt(x, z);
        pos[p] = x; pos[p+1] = h; pos[p+2] = z;
        // slope from the heightfield's own ground probe
        const e = W/(N-1)*step;
        const slope = Math.min(1, (Math.abs(hf.heightAt(x+e, z) - h) + Math.abs(hf.heightAt(x, z+e) - h)) / (e*0.9));
        const tH = Math.max(0, Math.min(1, h/120));
        let r = cGrass[0] + (cDry[0]-cGrass[0]) * ((x*0.013 + z*0.017) % 1 < 0.5 ? 0.25 : 0.6);
        let g = cGrass[1] + (cDry[1]-cGrass[1]) * 0.4;
        let b = cGrass[2] + (cDry[2]-cGrass[2]) * 0.4;
        r = r + (cRock[0]-r)*slope; g = g + (cRock[1]-g)*slope; b = b + (cRock[2]-b)*slope;
        r = r + (cHigh[0]-r)*tH*tH; g = g + (cHigh[1]-g)*tH*tH; b = b + (cHigh[2]-b)*tH*tH;
        col[p] = r; col[p+1] = g; col[p+2] = b;
        p += 3;
      }
    }
    const idx = [];
    for (let j = 0; j < vertsPerSide-1; j++){
      for (let i = 0; i < vertsPerSide-1; i++){
        const a = j*vertsPerSide + i, b = a + 1, c = a + vertsPerSide, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    return new THREE.Mesh(geo, mat);
  }

  function buildRoads(converted){
    const grp = new THREE.Group();
    for (const r of (converted.roads || [])){
      if (!r.positions || !r.indices || r.positions.length < 6) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.positions), 3));
      if (r.normals) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(r.normals), 3));
      if (r.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(r.uvs), 2));
      geo.setIndex(r.indices);
      if (!r.normals) geo.computeVertexNormals();
      const tex = textureFor(converted, r.materialName);
      const mat = new THREE.MeshLambertMaterial({
        color: tex ? 0xffffff : 0x35383c, map: tex || null,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      });
      grp.add(new THREE.Mesh(geo, mat));
    }
    return grp;
  }

  function buildStatics(converted){
    const grp = new THREE.Group();
    for (const st of (converted.statics || [])){
      const parsed = st.mesh;
      if (!parsed || !parsed.meshes) continue;
      for (const gid of Object.keys(parsed.meshes)){
        const m = parsed.meshes[gid];
        if (!m.positions || !m.indices || m.positions.length < 9) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.positions), 3));
        if (m.normals && m.normals.length === m.positions.length)
          geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.normals), 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(m.indices), 1));
        if (!m.normals || m.normals.length !== m.positions.length) geo.computeVertexNormals();
        const tex = textureFor(converted, m.material);
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
          color: tex ? 0xffffff : 0x8a7f72, map: tex || null }));
        if (st.transform) mesh.applyMatrix4(new THREE.Matrix4().fromArray(st.transform));
        grp.add(mesh);
      }
    }
    return grp;
  }

  function buildForest(converted){
    const placements = converted.forestPlacements || [];
    if (!placements.length) return null;
    const MAX = 30000;
    const stride = Math.max(1, Math.ceil(placements.length / MAX));
    const count = Math.ceil(placements.length / stride);
    const geo = new THREE.ConeGeometry(1.7, 5.5, 6);
    geo.translate(0, 2.75, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(),
          E = new THREE.Euler(), V = new THREE.Vector3(), Sv = new THREE.Vector3();
    const C = new THREE.Color();
    let w = 0;
    for (let i = 0; i < placements.length; i += stride){
      const pl = placements[i];
      const pp = Array.isArray(pl.position) ? pl.position : [0, 0, 0];
      const x = pp[0] || 0, z = pp[2] || 0;
      const y = converted.heightfield.heightAt(x, z);
      const s = (typeof pl.scale === 'number' ? pl.scale : 1) * (0.8 + ((i * 2654435761) % 100) / 250);
      E.set(0, ((i * 40503) % 628) / 100, 0); Q.setFromEuler(E);
      V.set(x, y - 0.2, z); Sv.set(s, s * (0.9 + ((i * 97) % 40) / 100), s);
      M.compose(V, Q, Sv);
      inst.setMatrixAt(w, M);
      C.setHSL(0.29 + ((i * 31) % 20) / 200, 0.42, 0.20 + ((i * 17) % 12) / 100);
      if (inst.setColorAt) inst.setColorAt(w, C);
      w++;
    }
    inst.count = w;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    return inst;
  }

  function sync(converted){
    if (converted === current) return;
    if (group){
      scene.remove(group);
      disposeGroup(group);
      group = null;
    }
    current = converted || null;
    if (!converted) return;
    group = new THREE.Group();
    try { group.add(buildTerrain(converted)); } catch (e) { if (window.__edShowError) window.__edShowError('Imported map terrain could not be built.', e); }
    try { group.add(buildRoads(converted)); } catch (e) { /* roads optional */ }
    try { group.add(buildStatics(converted)); } catch (e) { /* statics optional */ }
    try { const f = buildForest(converted); if (f) group.add(f); } catch (e) { /* forest optional */ }
    scene.add(group);
  }

  window.__MAPWORLD = { sync: sync };
})();
