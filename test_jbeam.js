'use strict';
/* Endless Drive v2.7 — JBeam importer test harness (Node, no browser).
   Run: node test_jbeam.js  (from web-v2/)
   Covers js/import/zip.js (zip reader + sha256) and js/import/jbeam.js
   (sloppy-JSON parser, table semantics, vehicle assembly,
   pressureWheels generation) against one hand-computed sample vehicle.

   Hand-computed expectations for the sample vehicle below:
   - parts used, in order: testcar_main, test_engine_v1, test_wheel_v1
   - nodes: 5 (main) + 2 new (engine; its 3rd row MERGES n_front)
     + 2 hubs + 10 pressureWheels ring nodes = 19; nodesMerged = 1
   - beams: 3 (main: 2 normal + 1 SUPPORT; a 4th references a missing
     node -> beamsSkipped = 1) + 2 (engine; a 3rd is optional and
     references a missing node -> skipped silently, NOT counted)
     + 1 authored ANISOTROPIC in the wheel part (beamsApproximated = 1)
     + 30 generated (10 tread + 20 sidewall) = 36
   - triangles: 2 (the second is NONCOLLIDABLE)
   - totalMass: n_front 6 (engine row modifier wins over both scopes)
     + n_rear 5 + n_left 5 + n_top 5 + n_extra 9 (row modifier over
     scope 5) + e1 22 + e2 22 ($engWeight default) + hubs 3 + 3
     + ring 10 x 2 (hubTreadNodeWeight) = 100 kg exactly
   - with the "sport" .pc applied ($engWeight := 30): totalMass = 116
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZIP = require(path.join(__dirname, 'js', 'import', 'zip.js'));
const JB = require(path.join(__dirname, 'js', 'import', 'jbeam.js'));

let failures = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    (info) => console.log('PASS ' + name + (info ? ' — ' + info : '')),
    (e) => { failures++; console.log('FAIL ' + name + ' — ' + e.message); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function approx(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(msg + ' (got ' + a + ', expected ' + b + ' ±' + tol + ')');
}

/* ---------------- sample vehicle fixtures ---------------- */
const MAIN_JBEAM = `{
  // sample vehicle, main part — comments and omitted commas on purpose
  "testcar_main": {
    "information": {"name": "Test Car", "authors": "fixture"},
    "slotType": "main",
    "slots": [
      ["type", "default", "description"],
      ["test_engine", "test_engine_v1", "Engine", {"coreSlot": true}]
      ["test_wheel", "test_wheel_v1", "Wheel"]
    ],
    "variables": [
      ["name", "type", "unit", "category", "default", "min", "max", "title", "description"],
      ["$engWeight", "number", "", "", 22, 0, 100, "", ""]
    ],
    "refNodes": [
      ["ref:", "back:", "left:", "up:"],
      ["n_front", "n_rear", "n_left", "n_top"]
    ],
    "nodes": [
      ["id", "posX", "posY", "posZ"],
      {"nodeWeight": 5},
      {"group": "body"},
      ["n_front", 0, -1.2, 0.5]
      ["n_rear", 0, 1.2, 0.5],
      ["n_left", -0.8, 0, 0.5],
      ["n_top", 0, 0, 1.0],
      {"group": ""},
      ["n_extra", 0.5, 0.5, 0.3, {"nodeWeight": 9}]
    ],
    "beams": [
      ["id1:", "id2:"],
      {"beamSpring": 1400000, "beamDamp": 140},
      {"beamDeform": 32700, "beamStrength": "FLT_MAX"},
      {"beamType": "|NORMAL"},
      ["n_front", "n_rear"]
      ["n_left", "n_top"],
      ["n_front", "n_left", {"beamType": "|SUPPORT", "beamPrecompression": 0.8}],
      ["n_front", "no_such_node"]
    ],
    "triangles": [
      ["id1:", "id2:", "id3:"],
      {"dragCoef": 10},
      ["n_front", "n_rear", "n_left"],
      ["n_front", "n_left", "n_top", {"triangleType": "NONCOLLIDABLE"}]
    ]
  },
  /* engine part, same file as the main part */
  "test_engine_v1": {
    "slotType": "test_engine",
    "nodes": [
      ["id", "posX", "posY", "posZ"],
      {"nodeWeight": "$engWeight"},
      ["e1", -0.2, -0.9, 0.3]
      ["e2", 0.2, -0.9, 0.3],
      ["n_front", 0, -1.25, 0.55, {"nodeWeight": 6}]
    ],
    "beams": [
      ["id1:", "id2:"],
      {"beamSpring": 2000000, "beamDamp": 200, "beamDeform": "FLT_MAX", "beamStrength": "FLT_MAX"},
      ["e1", "e2"],
      ["e1", "n_front"],
      ["e1", "ghost_node", {"optional": true}]
    ]
  }
}`;

const WHEEL_JBEAM = `{
  "test_wheel_v1": {
    "slotType": "test_wheel",
    "nodes": [
      ["id", "posX", "posY", "posZ"],
      {"nodeWeight": 3},
      ["hub1", -0.9, -1.2, 0.33],
      ["hub2", -0.7, -1.2, 0.33]
    ],
    "beams": [
      ["id1:", "id2:"],
      {"beamSpring": 900000, "beamDamp": 90, "beamDeform": "FLT_MAX", "beamStrength": "FLT_MAX"},
      ["hub1", "hub2", {"beamType": "|ANISOTROPIC"}]
    ],
    "pressureWheels": [
      ["name", "hubGroup", "group", "node1:", "node2:", "nodeS", "nodeArm:", "wheelDir"],
      {"hubRadius": 0.19, "treadDepth": 0.14, "numRays": 10},
      {"hubNodeWeight": 1.5, "hubTreadNodeWeight": 2},
      {"hubTreadBeamSpring": 300000, "hubBeamSpring": 180000},
      ["wheel_FL", "hubgroup", "tiregroup", "hub1", "hub2", "hub1", "hub1", 1]
    ]
  }
}`;

const SPORT_PC = JSON.stringify({
  format: 2, model: 'testcar',
  parts: {},
  vars: { $engWeight: 30 }
});

function sampleZipMap(withPc) {
  const enc = new TextEncoder();
  const m = new Map();
  m.set('vehicles/testcar/testcar.jbeam', enc.encode(MAIN_JBEAM));
  m.set('vehicles/testcar/wheels.jbeam', enc.encode(WHEEL_JBEAM));
  if (withPc) m.set('vehicles/testcar/sport.pc', enc.encode(SPORT_PC));
  return m;
}
function findNode(cage, pred, what) {
  const i = cage.nodes.findIndex(pred);
  assert(i >= 0, 'node not found: ' + what);
  return i;
}
const atPos = (x, y, z) => (n) => Math.abs(n.x - x) < 1e-9 && Math.abs(n.y - y) < 1e-9 && Math.abs(n.z - z) < 1e-9;

/* ---------------- minimal zip writer for the zip tests ---------------- */
function buildZip(entries) {
  // entries: [{name, data:Uint8Array, method:0|8}]
  const chunks = [], central = [];
  let offset = 0;
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const comp = e.method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = ZIP.crc32(e.data);
    const local = Buffer.concat([u32(0x04034B50), u16(20), u16(0), u16(e.method),
      u16(0), u16(0), u32(crc), u32(comp.length), u32(raw.length), u16(nameBuf.length), u16(0), nameBuf, comp]);
    chunks.push(local);
    central.push(Buffer.concat([u32(0x02014B50), u16(20), u16(20), u16(0), u16(e.method),
      u16(0), u16(0), u32(crc), u32(comp.length), u32(raw.length), u16(nameBuf.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054B50), u16(0), u16(0), u16(entries.length),
    u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...chunks, cd, eocd]);
}

(async () => {

  /* 1 — zip round-trip: stored + deflated, path normalisation, sha256 */
  await test('1 zip: store+deflate round-trip, path normalisation, sha256 vector', async () => {
    const enc = new TextEncoder();
    const hello = enc.encode('hello jbeam world, hello jbeam world, hello!');
    const plain = enc.encode('stored bytes');
    const zipBuf = buildZip([
      { name: './vehicles/testcar/a.jbeam', data: hello, method: 8 },
      { name: 'vehicles\\testcar\\b.txt', data: plain, method: 0 },
      { name: 'vehicles/testcar/', data: new Uint8Array(0), method: 0 }
    ]);
    const map = await ZIP.readZip(zipBuf);
    assert(map.size === 2, 'expected 2 file entries (directory skipped), got ' + map.size);
    assert(map.has('vehicles/testcar/a.jbeam'), 'deflated entry missing or ./ not stripped: ' + [...map.keys()].join(','));
    assert(map.has('vehicles/testcar/b.txt'), 'backslash path not normalised: ' + [...map.keys()].join(','));
    assert(Buffer.from(map.get('vehicles/testcar/a.jbeam')).equals(Buffer.from(hello)), 'deflated content mismatch');
    assert(Buffer.from(map.get('vehicles/testcar/b.txt')).equals(Buffer.from(plain)), 'stored content mismatch');
    // FIPS 180-2 known-answer: sha256("abc")
    const h = await ZIP.sha256Hex(enc.encode('abc'));
    assert(h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc") = ' + h);
    return 'entries ' + [...map.keys()].join(' + ') + ', sha256 ok';
  });

  /* 2 — parser: comments, omitted commas, nested sections */
  await test('2 parser: comments + omitted commas + nested dict', () => {
    const parsed = JB.parseJBeam(MAIN_JBEAM);
    assert(parsed.warnings.length === 0, 'unexpected parse warnings: ' + parsed.warnings.join('; '));
    const names = Object.keys(parsed.parts).sort();
    assert(names.join(',') === 'test_engine_v1,testcar_main', 'parts = ' + names.join(','));
    const main = parsed.parts.testcar_main;
    assert(main.information.name === 'Test Car', 'nested information dict not parsed');
    assert(main.slots.length === 3, 'slots rows = ' + main.slots.length + ' (header + 2, one comma omitted)');
    assert(main.nodes.length === 9, 'nodes table length = ' + main.nodes.length + ' (header + 2 scope + 5 rows + 1 scope reset)');
    return 'parts ' + names.join('/') + ', no warnings';
  });

  /* 3 — parser coercions: FLT_MAX -> Infinity, leading | stripped */
  await test('3 parser: FLT_MAX -> Infinity, |ENUM stripped', () => {
    const parsed = JB.parseJBeam(MAIN_JBEAM);
    const beams = parsed.parts.testcar_main.beams;
    const scopeWithStrength = beams.find((el) => !Array.isArray(el) && el.beamStrength !== undefined);
    assert(scopeWithStrength && scopeWithStrength.beamStrength === Infinity,
      'beamStrength scope = ' + (scopeWithStrength && scopeWithStrength.beamStrength));
    const scopeWithType = beams.find((el) => !Array.isArray(el) && el.beamType !== undefined);
    assert(scopeWithType && scopeWithType.beamType === 'NORMAL', 'beamType scope = ' + (scopeWithType && scopeWithType.beamType));
    return 'beamStrength=Infinity, beamType=NORMAL';
  });

  /* 4 — expandTable: scope applies, "" resets, row modifier wins */
  await test('4 expandTable: scope apply/reset + row modifier override', () => {
    const parsed = JB.parseJBeam(MAIN_JBEAM);
    const rows = JB.expandTable(parsed.parts.testcar_main.nodes);
    assert(rows.length === 5, 'expanded node rows = ' + rows.length);
    const byId = {};
    for (const r of rows) byId[r.id] = r;
    assert(byId.n_front.nodeWeight === 5 && byId.n_front.group === 'body',
      'n_front scope: weight ' + byId.n_front.nodeWeight + ' group ' + JSON.stringify(byId.n_front.group));
    assert(byId.n_extra.nodeWeight === 9, 'n_extra row modifier weight = ' + byId.n_extra.nodeWeight + ' (scope said 5)');
    assert(byId.n_extra.group === undefined, 'n_extra group should be reset by {"group":""}, got ' + JSON.stringify(byId.n_extra.group));
    const beamRows = JB.expandTable(parsed.parts.testcar_main.beams);
    const support = beamRows.find((r) => r.id2 === 'n_left' && r.id1 === 'n_front');
    assert(support.beamType === 'SUPPORT' && support.beamPrecompression === 0.8,
      'support row modifier: type ' + support.beamType + ' precomp ' + support.beamPrecompression);
    assert(support.beamSpring === 1400000, 'support row should inherit scope beamSpring, got ' + support.beamSpring);
    return 'scope/row-mod semantics exact';
  });

  /* 5 — $= expression subset: arithmetic, $vars, concat, rejection */
  await test('5 evalExpr: arithmetic, $var substitution, .. concat, unsupported rejected', () => {
    assert(JB.evalExpr('2+2', {}) === 4, '2+2');
    assert(JB.evalExpr('2*$x+1', { x: 3 }) === 7, '2*$x+1 with x=3');
    assert(JB.evalExpr('(1+2)^2/3', {}) === 3, '(1+2)^2/3');
    assert(JB.evalExpr("'my_'..'group'", {}) === 'my_group', 'string concat');
    assert(JB.evalExpr('10 % 3', {}) === 1, '10 % 3');
    assert(JB.evalExpr('math.floor(1.5)', {}) === undefined, 'function calls must be unsupported');
    assert(JB.evalExpr('$missing+1', {}) === undefined, 'unknown $var must be unsupported');
    const w = [];
    const fell = JB.resolveValue('$=math.floor(1.5)', {}, w);
    assert(fell === 0 && w.length === 1, 'unresolvable $= should warn once and fall back to 0, got ' + fell + ' / ' + w.length + ' warnings');
    return 'subset exact, Lua calls rejected with warning + 0';
  });

  /* 6..16 — full assembly of the sample vehicle */
  const stages = [];
  const cage = JB.assembleVehicle(sampleZipMap(false), { onProgress: (p) => stages.push(p) });

  await test('6 assembly: counts (nodes/beams/triangles/parts/report)', () => {
    assert(cage.name === 'testcar', 'vehicle name = ' + cage.name);
    assert(cage.nodes.length === 19, 'nodes = ' + cage.nodes.length + ' (expected 19)');
    assert(cage.beams.length === 36, 'beams = ' + cage.beams.length + ' (expected 36)');
    assert(cage.triangles.length === 2, 'triangles = ' + cage.triangles.length);
    assert(cage.report.partsUsed.join(',') === 'testcar_main,test_engine_v1,test_wheel_v1',
      'partsUsed = ' + cage.report.partsUsed.join(','));
    assert(cage.report.nodesMerged === 1, 'nodesMerged = ' + cage.report.nodesMerged);
    assert(cage.report.beamsSkipped === 1, 'beamsSkipped = ' + cage.report.beamsSkipped + ' (optional ghost beam must NOT count)');
    assert(cage.report.beamsApproximated === 1, 'beamsApproximated = ' + cage.report.beamsApproximated);
    assert(cage.wheels.length === 1, 'wheels = ' + cage.wheels.length);
    return '19n/36b/2t, merged 1, skipped 1, approximated 1';
  });

  await test('7 assembly: totalMass = sum of node masses = 100 kg', () => {
    let sum = 0;
    for (const n of cage.nodes) sum += n.mass;
    approx(cage.totalMass, 100, 1e-9, 'totalMass');
    approx(sum, cage.totalMass, 1e-12, 'totalMass vs node sum');
    return 'totalMass ' + cage.totalMass + ' kg';
  });

  await test('8 assembly: coordinate conversion BeamNG -> engine signs', () => {
    // n_rear authored at BeamNG (0, +1.2, 0.5): x=left, y=backward, z=up
    const rear = cage.nodes[findNode(cage, atPos(0, 0.5, -1.2), 'n_rear at engine (0,0.5,-1.2)')];
    assert(rear.z === -1.2 && rear.y === 0.5, 'n_rear conversion wrong: ' + JSON.stringify(rear));
    // n_left authored at BeamNG (-0.8, 0, 0.5) -> engine x = -(-0.8) = +0.8
    const left = cage.nodes[findNode(cage, atPos(0.8, 0.5, 0), 'n_left at engine (0.8,0.5,0)')];
    assert(left.x === 0.8, 'n_left conversion wrong: ' + JSON.stringify(left));
    return 'n_rear z=-1.2 (backward -> -z), n_left x=+0.8 (left -> -x)';
  });

  await test('9 assembly: scope/row-mod masses and $variable default', () => {
    const extra = cage.nodes[findNode(cage, atPos(-0.5, 0.3, -0.5), 'n_extra')];
    assert(extra.mass === 9 && extra.group === '', 'n_extra mass/group = ' + extra.mass + '/' + JSON.stringify(extra.group));
    const e1 = cage.nodes[findNode(cage, atPos(0.2, 0.3, 0.9), 'e1')];
    assert(e1.mass === 22, 'e1 mass = ' + e1.mass + ' ($engWeight default is 22)');
    const front = cage.nodes[findNode(cage, atPos(0, 0.55, 1.25), 'merged n_front')];
    assert(front.mass === 6 && front.group === 'body',
      'merged n_front mass/group = ' + front.mass + '/' + JSON.stringify(front.group) + ' (engine row modifier 6 wins, position updated)');
    return 'n_extra 9kg/no-group, e1 22kg via $engWeight, n_front merged to 6kg at new position';
  });

  await test('10 assembly: beam scaling k/c + strain conversion + SUPPORT + FLT_MAX', () => {
    const iFront = findNode(cage, atPos(0, 0.55, 1.25), 'n_front');
    const iRear = findNode(cage, atPos(0, 0.5, -1.2), 'n_rear');
    const iLeft = findNode(cage, atPos(0.8, 0.5, 0), 'n_left');
    const beamFR = cage.beams.find((b) => (b.a === iFront && b.b === iRear) || (b.a === iRear && b.b === iFront));
    assert(beamFR, 'n_front-n_rear beam missing');
    approx(beamFR.k, 1400000 * JB.K_SCALE, 1e-6, 'beam k = beamSpring * K_SCALE');
    approx(beamFR.c, 140 * JB.C_SCALE, 1e-9, 'beam c = beamDamp * C_SCALE');
    const A = cage.nodes[iFront], B = cage.nodes[iRear];
    const rest = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
    approx(beamFR.deformStrain, 32700 / (1400000 * rest), 1e-9, 'deformStrain = beamDeform/(k_bng*rest)');
    assert(beamFR.breakStrain === 20, 'FLT_MAX strength should map to breakStrain 20, got ' + beamFR.breakStrain);
    const support = cage.beams.find((b) => b.kind === 'support');
    assert(support, 'no SUPPORT beam in cage');
    assert((support.a === iFront && support.b === iLeft) || (support.a === iLeft && support.b === iFront),
      'support beam endpoints wrong');
    assert(support.engage === 0.8, 'support engage = ' + support.engage + ' (beamPrecompression 0.8)');
    return 'k=' + beamFR.k.toFixed(0) + ' (=1400000*0.0576), c=' + beamFR.c.toFixed(1) +
      ', deformStrain=' + beamFR.deformStrain.toFixed(5) + ' at rest ' + rest.toFixed(3) + ' m, support engage 0.8';
  });

  await test('11 assembly: triangles collidable flags', () => {
    const col = cage.triangles.filter((t) => t.collidable).length;
    assert(col === 1, 'collidable triangles = ' + col + ' (expected 1 of 2; NONCOLLIDABLE must be false)');
    return '1 collidable, 1 NONCOLLIDABLE';
  });

  await test('12 pressureWheels: 10-node ring, hub nodes, wheel entry, masses', () => {
    const ring = cage.nodes.filter((n) => n.kind === 'wheel' && n.mass === 2);
    assert(ring.length === 10, 'ring nodes (kind wheel, hubTreadNodeWeight 2) = ' + ring.length + ' (numRays 10)');
    const wheelKind = cage.nodes.filter((n) => n.kind === 'wheel');
    assert(wheelKind.length === 12, 'wheel-kind nodes = ' + wheelKind.length + ' (10 ring + 2 hubs)');
    approx(cage.wheels[0].radius, 0.19 + 0.14, 1e-9, 'tire radius = hubRadius + treadDepth');
    const hub = cage.nodes[cage.wheels[0].node];
    assert(hub.kind === 'wheel' && Math.abs(hub.radius - cage.wheels[0].radius) < 1e-9,
      'wheels[0].node should be a hub node carrying the tire radius');
    // every ring node sits at the tire radius from the hub midpoint (0.8, 0.33, 1.2)
    for (const n of ring) {
      const d = Math.hypot(n.x - 0.8, n.y - 0.33, n.z - 1.2);
      approx(d, cage.wheels[0].radius, 1e-9, 'ring node distance from hub centre');
    }
    return 'ring of 10 at r=' + cage.wheels[0].radius.toFixed(2) + ' m around (0.8,0.33,1.2), hubs kind=wheel';
  });

  await test('13 assembly: refNodes from the main part', () => {
    const iFront = findNode(cage, atPos(0, 0.55, 1.25), 'n_front');
    const iRear = findNode(cage, atPos(0, 0.5, -1.2), 'n_rear');
    const iTop = findNode(cage, atPos(0, 1.0, 0), 'n_top');
    assert(cage.refNodes.rear === iRear, 'refNodes.rear should be the back node');
    assert(cage.refNodes.front === iFront, 'refNodes.front should be the ref node (it lies forward of back)');
    assert(cage.refNodes.top === iTop, 'refNodes.top should be the up node');
    const floorNode = cage.nodes[cage.refNodes.floor];
    // lowest node overall is a ring node: hub centre y 0.33, radius 0.33,
    // nearest ray to straight-down is 72 degrees -> y = 0.33-0.33*sin(72deg)
    assert(floorNode.kind === 'wheel' && floorNode.y < 0.02,
      'refNodes.floor should be the lowest ring node, got kind ' + floorNode.kind + ' y = ' + floorNode.y);
    return 'front/rear/top from refNodes, floor = min-y ring node (y=' + floorNode.y.toFixed(3) + ')';
  });

  await test('14 assembly: progress callbacks fire at real stages', () => {
    const seen = stages.map((s) => s.stage);
    for (const want of ['parse', 'assemble', 'tires', 'done'])
      assert(seen.includes(want), 'progress stage missing: ' + want + ' (saw ' + seen.join(',') + ')');
    const last = stages[stages.length - 1];
    assert(last.stage === 'done' && last.frac === 1, 'final progress should be done@1, got ' + last.stage + '@' + last.frac);
    return 'stages ' + seen.join('>');
  });

  await test('15 config: .pc variable override changes assembly (sport.pc)', () => {
    const caged = JB.assembleVehicle(sampleZipMap(true), { configName: 'sport' });
    approx(caged.totalMass, 116, 1e-9, 'totalMass with $engWeight=30');
    const e1 = caged.nodes[findNode(caged, atPos(0.2, 0.3, 0.9), 'e1 (pc)')];
    assert(e1.mass === 30, 'e1 mass with pc override = ' + e1.mass);
    assert(caged.nodes.length === 19 && caged.beams.length === 36, 'pc must not change structure counts');
    return 'totalMass 100 -> 116 with $engWeight 22 -> 30';
  });

  await test('16 integration: zip bytes -> readZip -> assembleVehicle', async () => {
    const enc = new TextEncoder();
    const zipBuf = buildZip([
      { name: 'vehicles/testcar/testcar.jbeam', data: enc.encode(MAIN_JBEAM), method: 8 },
      { name: 'vehicles/testcar/wheels.jbeam', data: enc.encode(WHEEL_JBEAM), method: 8 }
    ]);
    const map = await ZIP.readZip(new Uint8Array(zipBuf.buffer, zipBuf.byteOffset, zipBuf.byteLength));
    const c2 = JB.assembleVehicle(map, {});
    assert(c2.nodes.length === 19 && c2.beams.length === 36, 'zip-roundtrip cage = ' + c2.nodes.length + 'n/' + c2.beams.length + 'b');
    approx(c2.totalMass, 100, 1e-9, 'zip-roundtrip totalMass');
    return 'zip -> cage identical to in-memory map (19n/36b, 100 kg)';
  });

  /* 17 — optional engine integration: if another worker's
     spawnCageCar exists in the sim core, spawn the assembled sample
     and step it for 1 s on a TrackWorld. Guarded: when it is absent
     this prints the mode instead of asserting sim behaviour. */
  await test('17 integration: spawnCageCar settle (guarded)', () => {
    const coreJs = fs.readFileSync(path.join(__dirname, 'js', 'sim', 'core.js'), 'utf8');
    const m = coreJs.match(/\/\/ === SIM CORE START ===([\s\S]*?)\/\/ === SIM CORE END ===/);
    assert(m, 'SIM CORE markers not found in js/sim/core.js');
    eval(m[1]);
    const SIM = globalThis.__SIM;
    if (!SIM || typeof SIM.spawnCageCar !== 'function') {
      return 'mode: parser/assembly only — globalThis.__SIM.spawnCageCar not present in this build, sim step skipped';
    }
    const world = new SIM.TrackWorld(1337);
    const car = SIM.spawnCageCar(cage, world, 100);
    const NO_INPUT = { throttle: 0, reverse: 0, brake: 0, steer: 0, handbrake: 0 };
    for (let i = 0; i < 60; i++) car.step(1 / 60, NO_INPUT, world);
    assert(!car.hasNaN(), 'NaN in spawned cage car after 1 s');
    const ms = car.maxNodeSpeed();
    assert(ms < 5, 'cage car did not settle in 1 s: maxNodeSpeed ' + ms.toFixed(2));
    return 'mode: full sim — spawned cage settled, maxNodeSpeed ' + ms.toFixed(3) + ' m/s after 1 s';
  });

  console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
