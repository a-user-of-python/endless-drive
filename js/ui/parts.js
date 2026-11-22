/* ============================ PARTS SYSTEM ============================
   Endless Drive v2.7 — vehicle parts health, fuel and temperature.
   Game-layer only: this file reads the sim's car object, it never
   changes sim physics. Exposes window.PartsSystem (one instance per
   spawned car) and window.PartsNotify (the popup queue the game uses).

   THE 10 PARTS
     radiator, engine, gearbox, fuelTank,
     tireFL, tireFR, tireRL, tireRR, steering, brakes

   HOW PARTS MAP TO BEAMS (assignment cached ONCE at construction;
   a beam may feed more than one part — a front strut really is both
   steering and brake hardware):
     Beam endpoints' REST positions give the beam midpoint. Built-in
     cars are classified with the sim's own S.zoneFor(A, B, def) plus
     the midpoint's z fraction along the car (zm = midZ / def.length,
     + = front). Imported cage cars (whose def has no sections, so
     zoneFor cannot run) fall back to the same zm bands measured
     against the cage's own rest bounds.
       radiator : front clip, zm > +0.40 (the very nose)
       engine   : front clip, +0.20 < zm <= +0.40
       gearbox  : front-centre tunnel, +0.02 < zm <= +0.20, low beams
                  (height fraction <= 0.45)
       fuelTank : rear area, -0.48 < zm < -0.18, low/mid beams
                  (height fraction <= 0.60)
       steering : suspension beams attached to a FRONT wheel node,
                  plus any beam with an endpoint within 0.65 m (rest)
                  of a front wheel node
       brakes   : every beam attached to any wheel node
       tireXX   : every beam attached to that wheel's node (in this
                  sim ALL wheel-attached beams are suspension beams —
                  struts and locating links — so tires share them with
                  brakes/steering rather than getting none), PLUS that
                  wheel node's ground-impact damage
     Wheel nodes come from car.wheelIdx (order FL, FR, RL, RR — the
     sim builds -x/+x at +z, then -x/+x at -z) or, for cage cars
     without wheelIdx, nodes whose kind === 'wheel' in build order.

   HEALTH MODEL
     Recomputed at most every 0.25 s (RECALC_S), never per frame.
     Per part: health = 100 * (1 - weightedDamage / totalWeight),
     weight per beam = its rest length; a broken beam counts 1.0,
     a deformed beam 0.55, plus a plastic term from how far the
     beam's currentRest has travelled from rest (capped at 0.45).
     A part with no mapped beams stays at 100 (nothing to break).
     Tire health is the lower of its beam health and 100 minus its
     accumulated ground-impact damage (a wheel node whose downward
     velocity collapses by > 7 m/s between updates takes damage
     proportional to the collapse; impacts never heal).

   FUEL
     Capacity: def.mass * 0.0417 L, clamped 40..80 L (a 1320 kg sedan
     gets ~55 L); cage cars use totalMass the same way.
     Consumption: idle 0.0009 L/s while the engine lives, plus
     throttle * (0.0035 + 0.011 * rpmProxy) L/s, where rpmProxy =
     clamp(|forwardSpeed| / topSpeed, 0..1) — topSpeed from
     def.topKmh, cage cars default 50 m/s.
     Leak: fuelTank health < 50 leaks (50 - health)/50 * 0.045 L/s.

   TEMPERATURE (coolant, °C; ambient 20)
     dT/dt = throttleLoad * 6 * engineFactor
             - (0.055 + speed * 0.0035) * radiatorFactor * (T - 20)
     Equilibrium at full throttle: ~129 °C parked (it will overheat if
     held), ~76 °C at 15 m/s cruise — airflow is what saves you.
     radiatorFactor = 0.30 + 0.70 * radiatorHealth/100 (a smashed
     radiator keeps 30% cooling through the fan), engineFactor scales
     with engine health (a dying engine makes less heat). Overheat:
     T > 115 damages the engine at 1.6 health/s. Engine health 0 =
     engine dead: game.js consults isEngineDead() in readInput and
     forces throttle/reverse to 0.

   NOTIFICATION THRESHOLDS (popups, queued, ~3.5 s each)
     engine health reaches 0        -> "Engine died"
     fuel < 25%                     -> "Fuel low" (once per refill:
                                       re-arms when fuel rises > 30%,
                                       i.e. after a repair)
     fuel reaches 0                 -> "Fuel empty" (once per refill)
     any tire health crosses < 35   -> "Tire blown: <corner>"
     coolant > 105                  -> "Radiator overheating" (once
                                       per episode; re-arms < 95)
     gearbox health crosses < 20    -> "Gearbox failed"
     radiator health crosses < 35   -> "Radiator damaged" (extra, same
                                       once-per-repair-cycle rule)

   UI RULE (hard requirement): there is NO permanent parts panel.
   A part chip (name + health bar) appears in a corner stack only
   when that part loses >= 1 health point, and fades out 4 s after
   its last loss. Fuel % and coolant °C ride in the existing HUD
   structure box (game.js owns those two text fields).

   Classic script, no modules — safe from file://. */
(function(){
  'use strict';

  var RECALC_S = 0.25;          // health recompute cadence (seconds)
  var CHIP_HIDE_S = 4;          // chip fades this long after last loss
  var POPUP_MS = 3500;          // popup on-screen time

  var PART_DEFS = [
    { id:'radiator', label:'Radiator' },
    { id:'engine',   label:'Engine' },
    { id:'gearbox',  label:'Gearbox' },
    { id:'fuelTank', label:'Fuel tank' },
    { id:'tireFL',   label:'Tire FL' },
    { id:'tireFR',   label:'Tire FR' },
    { id:'tireRL',   label:'Tire RL' },
    { id:'tireRR',   label:'Tire RR' },
    { id:'steering', label:'Steering' },
    { id:'brakes',   label:'Brakes' }
  ];
  var TIRE_IDS = ['tireFL', 'tireFR', 'tireRL', 'tireRR'];

  /* ---------------- popup queue (shared, one at a time) ---------------- */
  var popupQueue = [], popupBusy = false, popupEl = null, popupTimer = 0;
  function ensurePopupEl(){
    if (popupEl) return popupEl;
    popupEl = document.createElement('div');
    popupEl.id = 'partsNotify';
    popupEl.className = 'partsNotify hidden';
    document.body.appendChild(popupEl);
    return popupEl;
  }
  function pumpPopups(){
    if (popupBusy) return;
    var msg = popupQueue.shift();
    if (msg === undefined) return;
    popupBusy = true;
    var el = ensurePopupEl();
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(popupTimer);
    popupTimer = setTimeout(function(){
      el.classList.add('hidden');
      popupBusy = false;
      pumpPopups();
    }, POPUP_MS);
  }
  function notify(msg){
    if (!msg || typeof document === 'undefined') return;
    // identical popups never stack twice in the queue
    if (popupQueue.indexOf(msg) < 0) popupQueue.push(msg);
    pumpPopups();
  }

  /* ---------------- helpers ---------------- */
  function restOf(node){
    if (!node) return { x:0, y:0, z:0 };
    if (node.rest) return node.rest;
    if (Array.isArray(node)) return { x:node[0]||0, y:node[1]||0, z:node[2]||0 };
    return { x:node.x||0, y:node.y||0, z:node.z||0 };
  }
  function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

  /* ---------------- PartsSystem ---------------- */
  function PartsSystem(car, opts){
    opts = opts || {};
    this.car = car;
    this.def = car.def || opts.def || {};
    this.notify = opts.notify || notify;

    this.health = {};
    this._shownHealth = {};   // last health the chip layer has seen
    this._beamLists = {};     // partId -> [beam indices] (cached map)
    this._beamWeights = {};   // partId -> total rest-length weight
    for (var i = 0; i < PART_DEFS.length; i++){
      this.health[PART_DEFS[i].id] = 100;
      this._shownHealth[PART_DEFS[i].id] = 100;
      this._beamLists[PART_DEFS[i].id] = [];
      this._beamWeights[PART_DEFS[i].id] = 0;
    }

    var mass = this.def.mass || car.totalMass || 1300;
    this.fuelCapacity = clamp(mass * 0.0417, 40, 80);
    this.fuel = this.fuelCapacity;
    this.tempC = 20;
    this._topSpeed = this.def.topKmh ? this.def.topKmh / 3.6 : 50;

    this._recalcT = 0;
    this._impactDmg = { tireFL:0, tireFR:0, tireRL:0, tireRR:0 };
    this._prevWheelVy = [null, null, null, null];
    this._wheelIdx = [];

    // one-shot event latches (reset by repair())
    this._latched = {};
    this._overheatWarned = false;

    this._chips = {};         // partId -> {root, bar, val, hideAt}
    this._chipBox = null;

    this._assignBeams(car);
    this._recompute(car);     // initial health (100 everywhere on a fresh car)
    for (var j = 0; j < PART_DEFS.length; j++)
      this._shownHealth[PART_DEFS[j].id] = this.health[PART_DEFS[j].id];
  }

  PartsSystem.prototype._assignBeams = function(car){
    var S = (typeof globalThis !== 'undefined' && globalThis.__SIM) || {};
    var nodes = car.nodes || [], beams = car.beams || [];
    var def = this.def;

    // wheel node indices: FL, FR, RL, RR
    var wheelIdx = [];
    if (Array.isArray(car.wheelIdx) && car.wheelIdx.length) wheelIdx = car.wheelIdx.slice(0, 4);
    else for (var n = 0; n < nodes.length && wheelIdx.length < 4; n++)
      if (nodes[n] && nodes[n].kind === 'wheel') wheelIdx.push(n);
    this._wheelIdx = wheelIdx;
    var wheelSet = {};
    wheelIdx.forEach(function(idx, w){ wheelSet[idx] = w; });

    // rest bounds (fallback length/height for cage cars)
    var minZ = 1e9, maxZ = -1e9, minY = 1e9, maxY = -1e9;
    for (var i = 0; i < nodes.length; i++){
      var r = restOf(nodes[i]);
      if (r.z < minZ) minZ = r.z; if (r.z > maxZ) maxZ = r.z;
      if (r.y < minY) minY = r.y; if (r.y > maxY) maxY = r.y;
    }
    var L = (def.length && isFinite(def.length)) ? def.length : Math.max(0.1, maxZ - minZ);
    var z0 = (def.length && isFinite(def.length)) ? 0 : (minZ + maxZ) / 2;
    var H = Math.max(0.1, maxY - minY);
    var canZone = !!(S.zoneFor && def.sections && def.length);

    var self = this;
    function add(partId, bi, w){
      self._beamLists[partId].push(bi);
      self._beamWeights[partId] += w;
    }

    for (var b = 0; b < beams.length; b++){
      var beam = beams[b];
      var A = restOf(nodes[beam.a]), B = restOf(nodes[beam.b]);
      var mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, mz = (A.z + B.z) / 2;
      var zm = (mz - z0) / L;                       // + = front
      var hf = clamp((my - minY) / H, 0, 1);        // height fraction
      var weight = Math.max(0.05, beam.rest || 0.3);
      var zone = null;
      if (canZone){
        try { zone = S.zoneFor(A, B, def); } catch (e) { zone = null; }
      }
      var frontClip = (zone === 'crumple' && zm > 0) || zm > 0.02;

      if (frontClip){
        if (zm > 0.40) add('radiator', b, weight);
        else if (zm > 0.20) add('engine', b, weight);
        else if (zm > 0.02 && hf <= 0.45) add('gearbox', b, weight);
      }
      if (zm < -0.18 && zm > -0.48 && hf <= 0.60) add('fuelTank', b, weight);

      var wa = wheelSet[beam.a], wb = wheelSet[beam.b];
      var wheelHits = [];
      if (wa !== undefined) wheelHits.push(wa);
      if (wb !== undefined && wb !== wa) wheelHits.push(wb);
      for (var k = 0; k < wheelHits.length; k++){
        var w = wheelHits[k];
        add('brakes', b, weight);
        add(TIRE_IDS[w], b, weight);
        if (w < 2 && beam.suspension) add('steering', b, weight);
      }
      // steering-area beams: any beam ending near a front wheel node
      if (!wheelHits.length && wheelIdx.length >= 2){
        for (var f = 0; f < 2; f++){
          var wr = restOf(nodes[wheelIdx[f]]);
          var da = Math.hypot(A.x - wr.x, A.y - wr.y, A.z - wr.z);
          var db = Math.hypot(B.x - wr.x, B.y - wr.y, B.z - wr.z);
          if (Math.min(da, db) <= 0.65){ add('steering', b, weight); break; }
        }
      }
    }
  };

  PartsSystem.prototype._recompute = function(car){
    var beams = car.beams || [];
    for (var p = 0; p < PART_DEFS.length; p++){
      var id = PART_DEFS[p].id;
      var list = this._beamLists[id], total = this._beamWeights[id];
      if (!list.length || total <= 0){ this.health[id] = 100; continue; }
      var dmg = 0;
      for (var i = 0; i < list.length; i++){
        var beam = beams[list[i]];
        if (!beam) continue;
        var w = Math.max(0.05, beam.rest || 0.3), d = 0;
        if (beam.broken) d = 1;
        else {
          if (beam.deformed) d = 0.55;
          if (beam.rest > 0 && isFinite(beam.currentRest))
            d = Math.max(d, clamp(Math.abs(beam.currentRest - beam.rest) / beam.rest, 0, 0.45));
        }
        dmg += d * w;
      }
      var h = 100 * (1 - dmg / total);
      if (TIRE_IDS.indexOf(id) >= 0) h = Math.min(h, 100 - this._impactDmg[id]);
      this.health[id] = clamp(Math.round(h * 10) / 10, 0, 100);
    }
  };

  /* ---------------- chips (transient, loss-only) ---------------- */
  PartsSystem.prototype._ensureChipBox = function(){
    if (this._chipBox) return this._chipBox;
    if (typeof document === 'undefined') return null;
    var box = document.getElementById('partChips');
    if (!box){
      box = document.createElement('div');
      box.id = 'partChips';
      document.body.appendChild(box);
    }
    this._chipBox = box;
    return box;
  };
  PartsSystem.prototype._showChip = function(partId, label){
    var box = this._ensureChipBox();
    if (!box) return;
    var chip = this._chips[partId];
    if (!chip){
      var root = document.createElement('div');
      root.className = 'partChip';
      root.innerHTML = '<span class="partChipName"></span>' +
        '<span class="partChipBarOuter"><span class="partChipBar"></span></span>' +
        '<span class="partChipVal"></span>';
      root.querySelector('.partChipName').textContent = label;
      box.appendChild(root);
      chip = this._chips[partId] = {
        root: root,
        bar: root.querySelector('.partChipBar'),
        val: root.querySelector('.partChipVal'),
        hideAt: 0
      };
    }
    chip.root.classList.remove('fading');
    chip.hideAt = performance.now() + CHIP_HIDE_S * 1000;
    var h = this.health[partId];
    chip.bar.style.width = h + '%';
    chip.bar.style.background = h > 60 ? '#57d957' : h > 30 ? '#f2b134' : '#e83a2e';
    chip.val.textContent = Math.round(h) + '%';
  };
  PartsSystem.prototype._tickChips = function(){
    var now = performance.now();
    for (var id in this._chips){
      var chip = this._chips[id];
      if (chip.hideAt && now > chip.hideAt){
        chip.hideAt = 0;
        chip.root.classList.add('fading');
        // remove from the DOM shortly after the fade starts
        (function(c){ setTimeout(function(){ if (c.root.parentNode) c.root.parentNode.removeChild(c.root); }, 450); })(chip);
        delete this._chips[id];
      }
    }
  };
  PartsSystem.prototype.dispose = function(){
    for (var id in this._chips){
      var chip = this._chips[id];
      if (chip.root.parentNode) chip.root.parentNode.removeChild(chip.root);
    }
    this._chips = {};
  };

  /* ---------------- per-frame update ---------------- */
  PartsSystem.prototype.update = function(dt, car, input){
    if (!dt || dt <= 0) return;
    input = input || {};
    var throttle = input.throttle || 0;
    var engineAlive = this.health.engine > 0 && this.fuel > 0;

    /* wheel ground impacts (checked every update; cheap: 4 nodes) */
    var nodes = car.nodes || [];
    for (var w = 0; w < this._wheelIdx.length && w < 4; w++){
      var nd = nodes[this._wheelIdx[w]];
      if (!nd || !nd.vel) continue;
      var prev = this._prevWheelVy[w];
      if (prev !== null && prev < -2 && nd.vel.y > prev + 7){
        // downward velocity collapsed between updates = the wheel hit
        // something hard. Damage scales with the collapse.
        this._impactDmg[TIRE_IDS[w]] = clamp(
          this._impactDmg[TIRE_IDS[w]] + (nd.vel.y - prev - 7) * 2.2, 0, 100);
      }
      this._prevWheelVy[w] = nd.vel.y;
    }

    /* fuel */
    if (engineAlive){
      var fs = 0;
      try { fs = Math.abs(car.forwardSpeed()); } catch (e) { fs = 0; }
      var rpmProxy = clamp(fs / Math.max(1, this._topSpeed), 0, 1);
      var use = 0.0009 + throttle * (0.0035 + 0.011 * rpmProxy);
      this.fuel = Math.max(0, this.fuel - use * dt);
    }
    if (this.health.fuelTank < 50 && this.fuel > 0){
      var leak = (50 - this.health.fuelTank) / 50 * 0.045;
      this.fuel = Math.max(0, this.fuel - leak * dt);
    }

    /* coolant temperature */
    var speed = 0;
    try { speed = Math.abs(car.forwardSpeed()); } catch (e) { speed = 0; }
    var radFactor = 0.30 + 0.70 * (this.health.radiator / 100);
    var engFactor = 0.35 + 0.65 * (this.health.engine / 100);
    var loadHeat = engineAlive ? throttle * 6 * engFactor : 0;
    var cooling = (0.055 + speed * 0.0035) * radFactor * (this.tempC - 20);
    this.tempC += (loadHeat - cooling) * dt;
    if (this.tempC < 20) this.tempC = 20;
    if (this.tempC > 115){
      // overheating eats the engine (applied to the recomputed health
      // as a persistent offset so the 0.25 s recompute keeps it)
      this._heatDmg = clamp((this._heatDmg || 0) + 1.6 * dt, 0, 100);
    }

    /* periodic health recompute + events + chips */
    this._recalcT += dt;
    if (this._recalcT >= RECALC_S){
      this._recalcT = 0;
      var before = {};
      for (var p = 0; p < PART_DEFS.length; p++) before[PART_DEFS[p].id] = this.health[PART_DEFS[p].id];
      this._recompute(car);
      if (this._heatDmg) this.health.engine = clamp(this.health.engine - this._heatDmg, 0, 100);

      for (var q = 0; q < PART_DEFS.length; q++){
        var pd = PART_DEFS[q], id = pd.id, h = this.health[id];
        if (this._shownHealth[id] - h >= 1) this._showChip(id, pd.label);
        this._shownHealth[id] = h;

        if (id === 'engine' && h <= 0 && !this._latched.engineDead){
          this._latched.engineDead = true; this.notify('Engine died');
        }
        if (id === 'gearbox' && before.gearbox >= 20 && h < 20 && !this._latched.gearbox){
          this._latched.gearbox = true; this.notify('Gearbox failed');
        }
        if (id === 'radiator' && before.radiator >= 35 && h < 35 && !this._latched.radiator){
          this._latched.radiator = true; this.notify('Radiator damaged');
        }
        if (TIRE_IDS.indexOf(id) >= 0 && before[id] >= 35 && h < 35 && !this._latched[id]){
          this._latched[id] = true; this.notify('Tire blown: ' + pd.label.slice(5));
        }
      }
      var pct = this.fuelPct();
      if (pct < 25 && pct > 0 && !this._latched.fuelLow){
        this._latched.fuelLow = true; this.notify('Fuel low');
      }
      if (this.fuel <= 0 && !this._latched.fuelEmpty){
        this._latched.fuelEmpty = true; this.notify('Fuel empty');
      }
      if (this.tempC > 105 && !this._overheatWarned){
        this._overheatWarned = true; this.notify('Radiator overheating');
      }
    }
    if (this.tempC < 95) this._overheatWarned = false;
    if (this.fuelPct() > 30){ this._latched.fuelLow = false; this._latched.fuelEmpty = false; }

    this._tickChips();
  };

  /* ---------------- public readouts / hooks ---------------- */
  PartsSystem.prototype.fuelPct = function(){
    return this.fuelCapacity > 0 ? clamp(this.fuel / this.fuelCapacity * 100, 0, 100) : 0;
  };
  PartsSystem.prototype.isEngineDead = function(){
    return this.health.engine <= 0 || this.fuel <= 0;
  };
  PartsSystem.prototype.getHealth = function(id){ return this.health[id]; };
  PartsSystem.prototype.repair = function(){
    for (var i = 0; i < PART_DEFS.length; i++){
      this.health[PART_DEFS[i].id] = 100;
      this._shownHealth[PART_DEFS[i].id] = 100;
    }
    this._impactDmg = { tireFL:0, tireFR:0, tireRL:0, tireRR:0 };
    this._heatDmg = 0;
    this._latched = {};
    this._overheatWarned = false;
    this.fuel = this.fuelCapacity;
    this.tempC = Math.min(this.tempC, 90);
    this.dispose();
  };

  window.PartsSystem = PartsSystem;
  window.PartsNotify = notify;
})();
