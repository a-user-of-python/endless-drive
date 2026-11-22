'use strict';
/* ================================================================
   JBEAM.JS — BeamNG .jbeam parser + vehicle assembler.

   Turns the .jbeam files inside a locally-supplied vehicle mod zip
   (see zip.js) into a CageData node/beam cage this game's soft-body
   engine can spawn. Implements the format per the research report
   (sloppy JSON, scope/row modifiers, $variables, "$=..." Lua-ish
   expressions, FLT_MAX, pressureWheels tire generation).

   Classic script, no modules, works from file://. API is exposed as
   globalThis.__JBEAM and as module.exports under Node.

   ---------------------------------------------------------------
   ENGINE CALIBRATION (k / c scaling) — read before touching:
   BeamNG tunes beamSpring/beamDamp for its 2000 Hz physics substeps.
   This engine integrates explicitly at 480 Hz (js/sim/core.js). For
   an explicit spring integrator the stability edge is omega*h <= ~2
   with omega = sqrt(k/m), so holding the same stability margin when
   the step grows from 1/2000 to 1/480 means k must scale with the
   SQUARE of the frequency ratio:

       K_SCALE = (480/2000)^2 = 0.0576

   Sanity check against the engine's own fleet: core.js builds cage
   beams at def.stiff (240k-368k N/m) x MATERIALS kScale (0.26-1.08),
   i.e. roughly 60k-400k N/m. A typical BeamNG body beam
   (beamSpring 1,401,000) scales to 80,698 N/m — squarely in the
   engine's panel/frame range. A rigid structural beam (1e7) scales
   to 576k, above the fleet's top but carried by heavy structural
   nodes and the engine's beam subcycle guard. The stiffest authored
   beams (1e8) would scale to 5.76M and no 480 Hz explicit cage
   survives that on light nodes, so k is clamped to K_MAX = 1.5e6.

   Damping preserves the damping RATIO zeta = c / (2*sqrt(k*m)):
   with k scaled by s^2 (s = 480/2000 = 0.24), c must scale by s:

       C_SCALE = 0.24

   (BeamNG body beam: 140 / (2*sqrt(1.401e6*5)) = zeta 0.026; scaled:
   33.6 / (2*sqrt(80698*5)) = zeta 0.026. Identical by construction.)

   beamDeform / beamStrength are FORCES. The strain at which a beam
   yields/breaks is force / (k * rest); that conversion uses the
   ORIGINAL BeamNG k and the beam's rest length, so the strain
   thresholds are tick-rate independent and need no scaling:
       deformStrain = beamDeform    / (beamSpring * rest)
       breakStrain  = beamStrength  / (beamSpring * rest)
   "FLT_MAX" (Infinity) means never deforms / never breaks. core.js
   has no unbreakable flag: a Beam's deform/break behaviour is driven
   entirely by deformStrain/breakStrain, from which it derives
   maxPlastic = 0.7*breakStrain*rest and maxDisp = breakStrain*rest
   (the hard positional limit in enforceBeamLimits). The constructor
   DEFAULTS (0.07 / 0.4) are ordinary breakable values, so passing
   them for FLT_MAX would make "unbreakable" beams snap at 40%
   strain. Instead FLT_MAX maps to deformStrain = 10 and
   breakStrain = 20: a beam would have to stretch to 21x its rest
   length (or compress past -20x, impossible) before the bookkeeping
   fires — far beyond any displacement a cage node can physically
   reach, and maxDisp = 20*rest means the positional limiter never
   engages either. Finite strains are clamped to <= 100 for the same
   reason, and deformStrain is clamped to <= breakStrain.
   ================================================================ */
(function () {

  const K_SCALE = 0.0576;          // (480/2000)^2, see header
  const C_SCALE = 0.24;            // 480/2000, preserves zeta
  const K_MAX = 1.5e6;             // engine-space clamp, see header
  const UNBREAK_DEFORM = 10;       // FLT_MAX deform -> strain 10
  const UNBREAK_BREAK = 20;        // FLT_MAX strength -> strain 20
  const DEFAULT_NODE_WEIGHT = 25;  // kg, BeamNG default when unset
  const DEFAULT_BEAM_SPRING = 1000000;
  const DEFAULT_BEAM_DAMP = 100;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  /* ============================================================
     1. Sloppy-JSON parser (report section 1.9): string-aware
     comment stripping, then recursive descent where commas are
     optional whitespace. Raw text is NEVER handed to JSON.parse.
     ============================================================ */
  function stripComments(text, warnings) {
    let out = '', i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (ch === '"') {
        // copy the whole string verbatim (honouring escapes) so a
        // "//" or "/*" inside a string is never treated as a comment
        out += ch; i++;
        while (i < n) {
          const c = text[i];
          out += c; i++;
          if (c === '\\' && i < n) { out += text[i]; i++; }
          else if (c === '"') break;
        }
      } else if (ch === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else if (ch === '/' && text[i + 1] === '*') {
        const start = i;
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
        if (i >= n) warnings.push('unterminated /* */ comment at offset ' + start);
        else i += 2;
        out += ' ';
      } else { out += ch; i++; }
    }
    return out;
  }

  function Parser(text, warnings) {
    this.s = text; this.i = 0; this.warnings = warnings;
  }
  Parser.prototype.skip = function () {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.i++;
      else break;
    }
  };
  Parser.prototype.parseValue = function () {
    this.skip();
    const s = this.s;
    if (this.i >= s.length) { this.warnings.push('unexpected end of input'); return null; }
    const ch = s[this.i];
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"') return this.parseString();
    return this.parseToken();
  };
  Parser.prototype.parseString = function () {
    const s = this.s;
    let out = '';
    this.i++; // opening quote
    while (this.i < s.length) {
      const c = s[this.i++];
      if (c === '"') return out;
      if (c === '\\' && this.i < s.length) {
        const e = s[this.i++];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'u') { out += String.fromCharCode(parseInt(s.substr(this.i, 4), 16) || 0); this.i += 4; }
        else out += e; // \" \\ \/ and anything else, literally
      } else out += c;
    }
    this.warnings.push('unterminated string');
    return out;
  };
  Parser.prototype.parseToken = function () {
    const s = this.s;
    const start = this.i;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' ||
          c === ']' || c === '}' || c === ':') break;
      this.i++;
    }
    const tok = s.slice(start, this.i);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tok)) return Number(tok);
    if (tok === '') { this.warnings.push('empty token at offset ' + start); return null; }
    return tok; // bare word: tolerate as a string (not documented, but harmless)
  };
  Parser.prototype.parseArray = function () {
    const arr = [];
    this.i++; // [
    for (;;) {
      this.skip();
      if (this.i >= this.s.length) { this.warnings.push('unterminated array'); break; }
      if (this.s[this.i] === ']') { this.i++; break; }
      arr.push(this.parseValue());
    }
    return arr;
  };
  Parser.prototype.parseObject = function () {
    const obj = {};
    this.i++; // {
    for (;;) {
      this.skip();
      if (this.i >= this.s.length) { this.warnings.push('unterminated object'); break; }
      if (this.s[this.i] === '}') { this.i++; break; }
      let key;
      if (this.s[this.i] === '"') key = this.parseString();
      else key = String(this.parseToken());
      this.skip();
      if (this.s[this.i] === ':' || this.s[this.i] === '=') this.i++;
      else this.warnings.push('expected ":" after key "' + key + '"');
      obj[key] = this.parseValue();
    }
    return obj;
  };

  /* Parse-time value coercion (report 1.9 item 4): "FLT_MAX" ->
     Infinity, leading '|' stripped from enum strings. "$name" and
     "$=expr" strings are left intact: they resolve at assembly time,
     when the vehicle's variables are known. */
  function coerceParsed(v) {
    if (typeof v === 'string') {
      if (v === 'FLT_MAX') return Infinity;
      if (v.charAt(0) === '|' && v.charAt(1) !== '=') return v.slice(1);
      return v;
    }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = coerceParsed(v[i]); return v; }
    if (isPlainObject(v)) { for (const k of Object.keys(v)) v[k] = coerceParsed(v[k]); return v; }
    return v;
  }

  /* parseJBeam(text) -> { parts: {name: partObject}, warnings: [] } */
  function parseJBeam(text) {
    const warnings = [];
    const stripped = stripComments(String(text), warnings);
    const parser = new Parser(stripped, warnings);
    const root = parser.parseValue();
    parser.skip();
    if (parser.i < stripped.length) warnings.push('trailing content after top-level value at offset ' + parser.i);
    if (!isPlainObject(root)) {
      warnings.push('top level of .jbeam file is not an object of parts');
      return { parts: {}, warnings: warnings };
    }
    return { parts: coerceParsed(root), warnings: warnings };
  }

  /* ============================================================
     2. "$=expr" evaluation — a small, honest subset of Lua.
     Supported: numbers, 'single'/"double" quoted strings, $vars,
     + - * / % ^ (Lua floored-mod semantics), parentheses, unary
     minus, and '..' string concatenation. NOT supported (throws,
     caller warns and falls back): function calls, comparisons,
     and/or/not, #length, table constructors, indexing.
     ============================================================ */
  function tokenizeExpr(expr) {
    const toks = [];
    let i = 0;
    const s = String(expr);
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '.' && s[i + 1] === '.') { toks.push({ t: 'op', v: '..' }); i += 2; continue; }
      if ('+-*/%^()'.indexOf(c) >= 0) { toks.push({ t: 'op', v: c }); i++; continue; }
      if (c === '$') {
        let j = i + 1;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        if (j === i + 1) throw new Error('bare "$" in expression');
        toks.push({ t: 'var', v: s.slice(i + 1, j) });
        i = j; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1, out = '';
        while (j < s.length && s[j] !== c) {
          if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2; }
          else { out += s[j]; j++; }
        }
        if (j >= s.length) throw new Error('unterminated string in expression');
        toks.push({ t: 'str', v: out });
        i = j + 1; continue;
      }
      if (/[0-9.]/.test(c)) {
        let j = i;
        while (j < s.length && /[0-9.eE+-]/.test(s[j]) &&
               !(('+-'.indexOf(s[j]) >= 0) && !/[eE]/.test(s[j - 1]))) j++;
        const num = Number(s.slice(i, j));
        if (!isFinite(num) && isNaN(num)) throw new Error('bad number in expression');
        toks.push({ t: 'num', v: num });
        i = j; continue;
      }
      throw new Error('unsupported character "' + c + '" in expression (only arithmetic, $vars, strings and ".." are supported)');
    }
    return toks;
  }
  function evalExprFull(expr, vars) {
    try {
      const toks = tokenizeExpr(expr);
      let pos = 0;
      const peek = () => toks[pos];
      const next = () => toks[pos++];
      function lookupVar(name) {
        if (vars) {
          if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
          if (Object.prototype.hasOwnProperty.call(vars, '$' + name)) return vars['$' + name];
        }
        throw new Error('unknown variable $' + name + ' in expression');
      }
      function toNum(v) {
        if (typeof v === 'number') return v;
        const n = Number(v);
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(n)) return n;
        throw new Error('value is not numeric: ' + JSON.stringify(v));
      }
      function parseAtom() {
        const tk = next();
        if (!tk) throw new Error('unexpected end of expression');
        if (tk.t === 'num' || tk.t === 'str') return tk.v;
        if (tk.t === 'var') {
          const v = lookupVar(tk.v);
          if (typeof v === 'string' && v.startsWith('$=')) return evalExprInner(v.slice(2));
          if (typeof v === 'string' && v.startsWith('$')) return lookupVar(v.slice(1));
          return v;
        }
        if (tk.t === 'op' && tk.v === '(') {
          const v = parseConcat();
          const close = next();
          if (!close || close.v !== ')') throw new Error('missing ")" in expression');
          return v;
        }
        throw new Error('unexpected token in expression: ' + JSON.stringify(tk.v));
      }
      function parseUnary() {
        const tk = peek();
        if (tk && tk.t === 'op' && tk.v === '-') { next(); return -toNum(parseUnary()); }
        if (tk && tk.t === 'op' && tk.v === '+') { next(); return toNum(parseUnary()); }
        return parseAtom();
      }
      function parsePow() {
        const base = parseUnary();
        const tk = peek();
        if (tk && tk.t === 'op' && tk.v === '^') { next(); return Math.pow(toNum(base), toNum(parsePow())); }
        return base;
      }
      function parseMul() {
        let a = parsePow();
        for (;;) {
          const tk = peek();
          if (!tk || tk.t !== 'op' || ('*/%'.indexOf(tk.v) < 0)) return a;
          next();
          const b = toNum(parsePow());
          a = toNum(a);
          if (tk.v === '*') a = a * b;
          else if (tk.v === '/') a = a / b;
          else a = (b === 0) ? 0 : a - Math.floor(a / b) * b; // Lua floored %
        }
      }
      function parseAdd() {
        let a = parseMul();
        for (;;) {
          const tk = peek();
          if (!tk || tk.t !== 'op' || (tk.v !== '+' && tk.v !== '-')) return a;
          next();
          const b = toNum(parseMul());
          a = (tk.v === '+') ? toNum(a) + b : toNum(a) - b;
        }
      }
      function parseConcat() {
        const a = parseAdd();
        const tk = peek();
        if (tk && tk.t === 'op' && tk.v === '..') { next(); return String(a) + String(parseConcat()); }
        return a;
      }
      function evalExprInner(e) {
        // nested "$=..." reached through a variable default: the
        // recursive call tokenizes and parses with its own state
        const r = evalExprFull(e, vars);
        if (!r.ok) throw new Error(r.error);
        return r.value;
      }
      const value = parseConcat();
      if (pos < toks.length) throw new Error('trailing tokens in expression');
      return { ok: true, value: value };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  /* evalExpr(expr, vars) -> value, or undefined when the expression
     is outside the supported subset. */
  function evalExpr(expr, vars) {
    const r = evalExprFull(expr, vars || {});
    return r.ok ? r.value : undefined;
  }

  /* Resolve a raw parsed value against the vehicle variables:
     "$name" -> the variable's default (config overrides included),
     "$=expr" -> the expression subset above. Unresolvable values
     collect a warning and fall back to 0, or '' when the expression
     is clearly string-valued (contains '..' or a quote). */
  function resolveValue(v, vars, warnings, depth) {
    depth = depth || 0;
    if (depth > 8) { if (warnings) warnings.push('variable resolution too deep at ' + JSON.stringify(v)); return 0; }
    if (typeof v === 'string') {
      if (v.startsWith('$=')) {
        const r = evalExprFull(v.slice(2), vars || {});
        if (r.ok) return r.value;
        if (warnings) warnings.push('could not evaluate "' + v + '": ' + r.error);
        return (v.indexOf('..') >= 0 || v.indexOf("'") >= 0 || v.indexOf('"') >= 0) ? '' : 0;
      }
      if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
        const name = v.slice(1);
        if (vars && Object.prototype.hasOwnProperty.call(vars, name))
          return resolveValue(vars[name], vars, warnings, depth + 1);
        if (vars && Object.prototype.hasOwnProperty.call(vars, v))
          return resolveValue(vars[v], vars, warnings, depth + 1);
        if (warnings) warnings.push('unknown variable "' + v + '" (using 0)');
        return 0;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => resolveValue(x, vars, warnings, depth));
    if (isPlainObject(v)) {
      const o = {};
      for (const k of Object.keys(v)) o[k] = resolveValue(v[k], vars, warnings, depth);
      return o;
    }
    return v;
  }
  /* Numeric view of a value: resolves, then coerces. Returns def
     when the value is absent or not numeric (Infinity passes). */
  function numOr(v, vars, warnings, def) {
    if (v === undefined || v === null) return def;
    const r = resolveValue(v, vars, warnings);
    if (typeof r === 'number') return r;
    const n = Number(r);
    if (typeof r === 'string' && r.trim() !== '' && !isNaN(n)) return n;
    if (warnings) warnings.push('expected a number, got ' + JSON.stringify(v) + ' (using ' + def + ')');
    return def;
  }
  function firstNum(row, vars, warnings, keys, def) {
    for (const k of keys) if (row[k] !== undefined) return numOr(row[k], vars, warnings, def);
    return def;
  }
  function groupStr(v, vars, warnings) {
    const r = resolveValue(v, vars, warnings);
    if (r === undefined || r === null) return '';
    if (Array.isArray(r)) return r.length ? String(r[0]) : '';
    return String(r);
  }

  /* ============================================================
     3. Table expansion (report 1.3): first array row is the header;
     bare {} elements are scope modifiers (running state, a key set
     to "" resets it); a trailing {} in a data row is a row modifier
     (that row only, wins over scope). Header names split on ':'
     into {name, target}; targets are attached to each row as a
     non-enumerable _targets map so rows stay plain data.
     ============================================================ */
  function expandTable(table) {
    if (!Array.isArray(table)) return [];
    let header = null;
    const scope = {};
    const rows = [];
    for (const el of table) {
      if (Array.isArray(el)) {
        if (!header) {
          header = el.map((h) => {
            if (typeof h === 'string') {
              const ci = h.indexOf(':');
              if (ci >= 0) return { name: h.slice(0, ci), target: h.slice(ci + 1) || 'nodes' };
              return { name: h, target: null };
            }
            return { name: String(h), target: null };
          });
          continue;
        }
        const row = {};
        for (const k of Object.keys(scope)) row[k] = scope[k];
        let rowMod = null;
        for (let i = 0; i < el.length; i++) {
          const v = el[i];
          if (isPlainObject(v)) { rowMod = v; continue; } // modifier dict, any position
          if (i < header.length) row[header[i].name] = v;
        }
        if (rowMod) {
          for (const k of Object.keys(rowMod)) {
            if (rowMod[k] === '') delete row[k];
            else row[k] = rowMod[k];
          }
        }
        const targets = {};
        for (const h of header) if (h.target) targets[h.name] = h.target;
        Object.defineProperty(row, '_targets', { value: targets, enumerable: false });
        rows.push(row);
      } else if (isPlainObject(el)) {
        for (const k of Object.keys(el)) {
          if (el[k] === '') delete scope[k];
          else scope[k] = el[k];
        }
      }
    }
    return rows;
  }

  /* ============================================================
     4. Vehicle assembly.
     ============================================================ */
  function normalizePath(p) {
    let s = String(p).replace(/\\/g, '/');
    while (s.startsWith('./')) s = s.slice(2);
    while (s.startsWith('/')) s = s.slice(1);
    return s;
  }

  function assembleVehicle(zipMap, opts) {
    opts = opts || {};
    const warnings = [];
    const progress = (stage, frac, msg) => {
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress({ stage: stage, frac: frac, msg: msg }); } catch (e) { /* caller bug, not ours */ }
      }
    };

    const files = new Map();
    for (const entry of zipMap.entries()) files.set(normalizePath(entry[0]), entry[1]);
    const decoder = new TextDecoder('utf-8');
    const decode = (bytes) => decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

    /* --- locate vehicle folders: vehicles/<name>/ (common is shared) --- */
    const folderNames = new Set();
    for (const k of files.keys()) {
      const m = k.match(/^vehicles\/([^/]+)\//);
      if (m && m[1] !== 'common') folderNames.add(m[1]);
    }
    if (!folderNames.size) throw new Error('assembleVehicle: no vehicles/<name>/ folder found in the zip');

    function parseFolder(folder) {
      const prefix = 'vehicles/' + folder + '/';
      const paths = [];
      for (const k of files.keys()) if (k.startsWith(prefix) && k.endsWith('.jbeam')) paths.push(k);
      paths.sort();
      const index = new Map(); // part name -> part object
      paths.forEach((path, i) => {
        progress('parse', 0.05 + 0.45 * (paths.length ? i / paths.length : 1), 'parsing ' + path);
        const parsed = parseJBeam(decode(files.get(path)));
        for (const w of parsed.warnings) warnings.push(path + ': ' + w);
        for (const name of Object.keys(parsed.parts)) {
          if (index.has(name)) warnings.push('duplicate part "' + name + '" in ' + path + ' (later file wins)');
          index.set(name, parsed.parts[name]);
        }
      });
      return index;
    }

    /* parse every candidate folder; the vehicle is the first (sorted)
       folder that actually contains a slotType:"main" part */
    let vehicleName = null, partIndex = null;
    const commonIndex = files.keys().next().value !== undefined ? parseFolder('common') : new Map();
    for (const folder of Array.from(folderNames).sort()) {
      const idx = parseFolder(folder);
      let hasMain = false;
      for (const part of idx.values()) if (part && part.slotType === 'main') { hasMain = true; break; }
      if (hasMain) { vehicleName = folder; partIndex = idx; break; }
    }
    if (!partIndex) throw new Error('assembleVehicle: no part with slotType "main" in any vehicles/<name>/ folder');
    for (const entry of commonIndex.entries()) if (!partIndex.has(entry[0])) partIndex.set(entry[0], entry[1]);
    progress('parse', 0.5, 'parsed vehicle "' + vehicleName + '"');

    /* --- .pc config: explicit name, else the only .pc present --- */
    let config = null;
    {
      const prefix = 'vehicles/' + vehicleName + '/';
      const pcs = [];
      for (const k of files.keys())
        if (k.startsWith(prefix) && k.endsWith('.pc') && k.indexOf('/', prefix.length) < 0) pcs.push(k);
      pcs.sort();
      let chosen = null;
      if (opts.configName) {
        const want = opts.configName.endsWith('.pc') ? opts.configName : opts.configName + '.pc';
        chosen = pcs.find((p) => p.slice(prefix.length) === want) || null;
        if (!chosen) warnings.push('config "' + opts.configName + '" not found in vehicles/' + vehicleName + '/ (using slot defaults)');
      } else if (pcs.length === 1) chosen = pcs[0];
      if (chosen) {
        const text = decode(files.get(chosen));
        try { config = JSON.parse(text); }
        catch (e) {
          const p2 = parseJBeam(text);
          const names = Object.keys(p2.parts);
          config = names.length ? p2.parts[names[0]] : null;
          warnings.push('config ' + chosen + ' was not strict JSON; parsed with the JBeam parser');
        }
        if (config) progress('parse', 0.55, 'applied config ' + chosen.slice(prefix.length));
      }
    }
    const configParts = (config && isPlainObject(config.parts)) ? config.parts : {};
    const configVars = (config && (isPlainObject(config.vars) ? config.vars
      : (isPlainObject(config.variables) ? config.variables : {}))) || {};

    /* variables: config values are seeded first and win; each part's
       own declared defaults fill in only names not already set */
    const vars = {};
    for (const k of Object.keys(configVars)) vars[k.replace(/^\$/, '')] = configVars[k];

    /* --- assembly state --- */
    const nodes = [];            // CageData nodes (exact output shape)
    const nodeIndex = new Map(); // jbeam id -> nodes[] index
    const beams = [];
    const triangles = [];
    const wheels = [];
    const partsUsed = [];
    const visited = new Set();
    let nodesMerged = 0, beamsSkipped = 0, beamsApproximated = 0;
    let mainPart = null, tiresAnnounced = false;

    function addOrUpdateNode(id, bx, by, bz, row) {
      // BeamNG -> engine rest frame: engine x=right, y=up, z=forward;
      // BeamNG x=left, y=backward, z=up  =>  ex=-bx, ey=bz, ez=-by
      const ex = -bx, ey = bz, ez = -by;
      if (nodeIndex.has(id)) {
        const n = nodes[nodeIndex.get(id)];
        n.x = ex; n.y = ey; n.z = ez;
        if (row.nodeWeight !== undefined) n.mass = numOr(row.nodeWeight, vars, warnings, n.mass);
        if (row.group !== undefined) n.group = groupStr(row.group, vars, warnings);
        if (row.frictionCoef !== undefined) n.frictionCoef = numOr(row.frictionCoef, vars, warnings, n.frictionCoef);
        nodesMerged++;
        return nodeIndex.get(id);
      }
      const n = {
        x: ex, y: ey, z: ez,
        mass: row.nodeWeight !== undefined ? numOr(row.nodeWeight, vars, warnings, DEFAULT_NODE_WEIGHT) : DEFAULT_NODE_WEIGHT,
        group: row.group !== undefined ? groupStr(row.group, vars, warnings) : '',
        kind: 'chassis',
        radius: firstNum(row, vars, warnings, ['nodeRadius', 'radius'], 0.06),
        frictionCoef: row.frictionCoef !== undefined ? numOr(row.frictionCoef, vars, warnings, 1) : 1
      };
      nodeIndex.set(id, nodes.length);
      nodes.push(n);
      return nodes.length - 1;
    }

    /* One beam from resolved BeamNG-space properties. Shared by
       authored beams and pressureWheels-generated beams. */
    function makeBeam(a, b, props) {
      const A = nodes[a], B = nodes[b];
      const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
      const rest = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(rest > 1e-9)) { warnings.push('beam with zero rest length skipped (nodes ' + a + '/' + b + ')'); return false; }
      const spring = props.beamSpring, damp = props.beamDamp;
      const k = isFinite(spring) ? clamp(spring * K_SCALE, 10, K_MAX) : K_MAX;
      const c = isFinite(damp) ? Math.max(0, damp * C_SCALE) : 1e5;
      let deformStrain, breakStrain;
      if (!isFinite(props.beamDeform)) deformStrain = UNBREAK_DEFORM;
      else if (spring > 0) deformStrain = clamp(props.beamDeform / (spring * rest), 0, 100);
      else deformStrain = UNBREAK_DEFORM;
      if (!isFinite(props.beamStrength)) breakStrain = UNBREAK_BREAK;
      else if (spring > 0) breakStrain = clamp(props.beamStrength / (spring * rest), 0, 100);
      else breakStrain = UNBREAK_BREAK;
      if (deformStrain > breakStrain) deformStrain = breakStrain;
      beams.push({
        a: a, b: b, k: k, c: c,
        deformStrain: deformStrain, breakStrain: breakStrain,
        kind: props.kind || 'normal',
        engage: props.engage !== undefined ? props.engage : 1,
        pressure: props.pressure || 0
      });
      return true;
    }
    function beamPropsFromRow(row) {
      return {
        beamSpring: numOr(row.beamSpring, vars, warnings, DEFAULT_BEAM_SPRING),
        beamDamp: numOr(row.beamDamp, vars, warnings, DEFAULT_BEAM_DAMP),
        beamDeform: numOr(row.beamDeform, vars, warnings, Infinity),
        beamStrength: numOr(row.beamStrength, vars, warnings, Infinity)
      };
    }

    function processNodes(part) {
      for (const row of expandTable(part.nodes)) {
        if (typeof row.id !== 'string' || !row.id) { warnings.push('node row without an id skipped'); continue; }
        addOrUpdateNode(row.id,
          numOr(row.posX, vars, warnings, 0),
          numOr(row.posY, vars, warnings, 0),
          numOr(row.posZ, vars, warnings, 0), row);
      }
    }

    function processBeams(part) {
      for (const row of expandTable(part.beams)) {
        const typeRaw = row.beamType !== undefined ? resolveValue(row.beamType, vars, warnings) : 'NORMAL';
        const type = String(typeRaw === undefined || typeRaw === null ? 'NORMAL' : typeRaw).toUpperCase();
        const optional = !!resolveValue(row.optional, vars, warnings);
        const i1 = nodeIndex.get(row.id1), i2 = nodeIndex.get(row.id2);
        if (i1 === undefined || i2 === undefined) {
          if (!optional) {
            beamsSkipped++;
            warnings.push('beam ' + JSON.stringify(row.id1) + '-' + JSON.stringify(row.id2) + ' skipped: node not found');
          }
          continue;
        }
        const props = beamPropsFromRow(row);
        if (type === 'SUPPORT') {
          props.kind = 'support';
          props.engage = clamp(numOr(row.beamPrecompression, vars, warnings, 1), 0.1, 1);
          makeBeam(i1, i2, props);
        } else if (type === 'PRESSURED') {
          // air-cylinder beam approximated as a normal beam plus the
          // engine's capped progressive pressure term; the cap is a
          // heuristic 15% of the beam's full-compression spring force
          props.kind = 'normal';
          const A = nodes[i1], B = nodes[i2];
          const rest = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z) || 1;
          props.pressure = 0.15 * (isFinite(props.beamSpring) ? props.beamSpring * K_SCALE : K_MAX) * rest;
          makeBeam(i1, i2, props);
        } else if (type === 'LBEAM') {
          beamsApproximated++;
          const i3 = nodeIndex.get(row.id3);
          makeBeam(i1, i2, props);
          if (i3 !== undefined) makeBeam(i2, i3, props);
          else warnings.push('LBEAM missing its third node; approximated with one segment');
        } else {
          if (type === 'HYDRO' || type === 'ANISOTROPIC' || type === 'BOUNDED') beamsApproximated++;
          else if (type !== 'NORMAL') warnings.push('unknown beamType "' + type + '" treated as NORMAL');
          makeBeam(i1, i2, props);
        }
      }
    }

    function processTriangles(part) {
      for (const row of expandTable(part.triangles)) {
        const i1 = nodeIndex.get(row.id1), i2 = nodeIndex.get(row.id2), i3 = nodeIndex.get(row.id3);
        if (i1 === undefined || i2 === undefined || i3 === undefined) {
          warnings.push('triangle skipped: a node id was not found');
          continue;
        }
        const t = row.triangleType !== undefined ? String(resolveValue(row.triangleType, vars, warnings)).toUpperCase() : 'NORMAL';
        triangles.push({ a: i1, b: i2, c: i3, collidable: t !== 'NONCOLLIDABLE' });
      }
    }

    /* pressureWheels tire generation. Radius resolution order
       (documented choice): tireRadius, then wheelRadius, then
       hubRadius + treadDepth (treadDepth defaulting to 0.14 m), then
       the 0.33 m fallback. Ring size: numRays (default 12, clamped
       8..20). A malformed section (hub nodes unusable for geometry or
       no usable radius) falls back to a documented 10-node ring of
       radius 0.33 m around the hub midpoint and warns. Ring node mass
       comes from hubTreadNodeWeight / treadNodeWeight / hubNodeWeight
       (default 2 kg). Beam property names follow BeamNG's
       hub-prefixed convention with documented fallbacks. */
    function processPressureWheels(part) {
      const rows = expandTable(part.pressureWheels);
      if (!rows.length) return;
      if (!tiresAnnounced) { progress('tires', 0.8, 'generating pressureWheels tires'); tiresAnnounced = true; }
      for (const row of rows) {
        const i1 = nodeIndex.get(row.node1), i2 = nodeIndex.get(row.node2);
        if (i1 === undefined || i2 === undefined) {
          warnings.push('pressureWheels "' + (row.name || '?') + '": hub nodes not found, wheel skipped');
          continue;
        }
        let malformed = false;
        let radius = firstNum(row, vars, warnings, ['tireRadius', 'wheelRadius'], NaN);
        if (!isFinite(radius)) {
          const hubR = numOr(row.hubRadius, vars, warnings, NaN);
          if (isFinite(hubR)) radius = hubR + numOr(row.treadDepth, vars, warnings, 0.14);
        }
        let nRays = Math.round(numOr(row.numRays, vars, warnings, 12));
        if (!isFinite(radius) || radius <= 0.05) {
          radius = 0.33; malformed = true;
        }
        if (malformed) {
          nRays = 10;
          warnings.push('pressureWheels "' + (row.name || '?') + '": malformed section, substituted a 10-node ring of radius 0.33 m');
        } else {
          nRays = clamp(isFinite(nRays) ? nRays : 12, 8, 20);
        }
        const A = nodes[i1], B = nodes[i2];
        const center = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
        let axis = { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z };
        const alen = Math.hypot(axis.x, axis.y, axis.z);
        if (alen < 1e-6) { axis = { x: 1, y: 0, z: 0 }; warnings.push('pressureWheels: hub nodes coincide, axle axis guessed'); }
        else { axis.x /= alen; axis.y /= alen; axis.z /= alen; }
        const helper = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
        let u = {
          x: axis.y * helper.z - axis.z * helper.y,
          y: axis.z * helper.x - axis.x * helper.z,
          z: axis.x * helper.y - axis.y * helper.x
        };
        const ulen = Math.hypot(u.x, u.y, u.z) || 1;
        u = { x: u.x / ulen, y: u.y / ulen, z: u.z / ulen };
        const v = {
          x: axis.y * u.z - axis.z * u.y,
          y: axis.z * u.x - axis.x * u.z,
          z: axis.x * u.y - axis.y * u.x
        };
        // hub nodes become wheel nodes carrying the tire radius
        A.kind = 'wheel'; A.radius = radius;
        B.kind = 'wheel'; B.radius = radius;
        const ringMass = firstNum(row, vars, warnings,
          ['hubTreadNodeWeight', 'treadNodeWeight', 'hubNodeWeight'], 2);
        const ringFriction = numOr(row.frictionCoef, vars, warnings, 1.1);
        const ringGroup = row.group !== undefined ? groupStr(row.group, vars, warnings) : '';
        const ring = [];
        for (let i = 0; i < nRays; i++) {
          const th = (i / nRays) * Math.PI * 2;
          const co = Math.cos(th), si = Math.sin(th);
          const id = '__pw' + wheels.length + '_' + i;
          const n = {
            x: center.x + (u.x * co + v.x * si) * radius,
            y: center.y + (u.y * co + v.y * si) * radius,
            z: center.z + (u.z * co + v.z * si) * radius,
            mass: ringMass, group: ringGroup, kind: 'wheel',
            radius: radius, frictionCoef: ringFriction
          };
          nodeIndex.set(id, nodes.length);
          nodes.push(n);
          ring.push(nodes.length - 1);
        }
        const treadProps = {
          beamSpring: firstNum(row, vars, warnings, ['hubTreadBeamSpring', 'treadBeamSpring'], 300000),
          beamDamp: firstNum(row, vars, warnings, ['hubTreadBeamDamp', 'treadBeamDamp'], 25),
          beamDeform: firstNum(row, vars, warnings, ['hubTreadBeamDeform', 'treadBeamDeform'], Infinity),
          beamStrength: firstNum(row, vars, warnings, ['hubTreadBeamStrength', 'treadBeamStrength'], Infinity),
          kind: 'normal', engage: 1, pressure: 0
        };
        const sideProps = {
          beamSpring: firstNum(row, vars, warnings, ['hubSideBeamSpring', 'sidewallBeamSpring', 'hubBeamSpring'], 180000),
          beamDamp: firstNum(row, vars, warnings, ['hubSideBeamDamp', 'sidewallBeamDamp', 'hubBeamDamp'], 20),
          beamDeform: firstNum(row, vars, warnings, ['hubSideBeamDeform', 'sidewallBeamDeform', 'hubBeamDeform'], Infinity),
          beamStrength: firstNum(row, vars, warnings, ['hubSideBeamStrength', 'sidewallBeamStrength', 'hubBeamStrength'], Infinity),
          kind: 'normal', engage: 1, pressure: 0
        };
        for (let i = 0; i < nRays; i++) makeBeam(ring[i], ring[(i + 1) % nRays], treadProps);
        for (let i = 0; i < nRays; i++) { makeBeam(ring[i], i1, sideProps); makeBeam(ring[i], i2, sideProps); }
        wheels.push({ node: i1, radius: radius });
      }
    }

    function findPartBySlotType(type) {
      for (const entry of partIndex.entries()) if (entry[1] && entry[1].slotType === type) return entry[0];
      return null;
    }

    /* Assembly is two-phase, mirroring BeamNG: the part tree is
       collected by walking slots from the root, then ALL nodes from
       all parts are merged into the global id space first, and only
       then beams / triangles / pressureWheels are built — so beam
       rest lengths and tire geometry always see final merged node
       positions, and beams may freely reference nodes from parts
       assembled after their own. */
    const orderedParts = [];
    function collectPart(name, depth) {
      if (visited.has(name)) return;
      const part = partIndex.get(name);
      if (!part) { warnings.push('part "' + name + '" referenced but not found'); return; }
      visited.add(name);
      partsUsed.push(name);
      orderedParts.push(part);
      if (depth > 40) { warnings.push('slot recursion depth limit hit at part "' + name + '"'); return; }
      const slotTable = Array.isArray(part.slots) ? part.slots : part.slots2;
      if (Array.isArray(slotTable)) {
        for (const row of expandTable(slotTable)) {
          const type = row.type;
          if (typeof type !== 'string' || !type) continue;
          let chosen = configParts[type] || row.default;
          if (!chosen) continue; // empty slot
          if (!partIndex.has(chosen)) {
            const byType = findPartBySlotType(type);
            if (byType) { warnings.push('slot "' + type + '": part "' + chosen + '" not found, using "' + byType + '"'); chosen = byType; }
            else { warnings.push('slot "' + type + '": part "' + chosen + '" not found, slot left empty'); continue; }
          }
          collectPart(chosen, depth + 1);
        }
      }
    }

    /* root = the part with slotType "main" */
    let rootName = null;
    for (const entry of partIndex.entries()) if (entry[1] && entry[1].slotType === 'main') { rootName = entry[0]; break; }
    if (!rootName) throw new Error('assembleVehicle: no part with slotType "main" in vehicle "' + vehicleName + '"');
    mainPart = partIndex.get(rootName);
    progress('assemble', 0.6, 'assembling parts from "' + rootName + '"');
    collectPart(rootName, 0);
    // variables from every collected part (root first, first
    // definition wins, config values were seeded before all of these)
    for (const part of orderedParts) {
      if (Array.isArray(part.variables)) {
        for (const row of expandTable(part.variables)) {
          const key = String(row.name || '').replace(/^\$/, '');
          if (key && !Object.prototype.hasOwnProperty.call(vars, key)) vars[key] = row.default;
        }
      }
    }
    for (const part of orderedParts) if (Array.isArray(part.nodes)) processNodes(part);
    for (const part of orderedParts) if (Array.isArray(part.beams)) processBeams(part);
    for (const part of orderedParts) if (Array.isArray(part.triangles)) processTriangles(part);
    for (const part of orderedParts) if (Array.isArray(part.pressureWheels)) processPressureWheels(part);
    if (!nodes.length) throw new Error('assembleVehicle: vehicle "' + vehicleName + '" produced no nodes');

    /* --- refNodes: the main part's refNodes row names the rear
       ('back') node; 'front' is the 'ref' node when it lies forward
       of 'back' in the engine frame (+z), otherwise (and for top /
       floor, and when refNodes is absent) the plain min/max
       estimates over all nodes are used. 'up' names the top node
       when present. --- */
    let front = -1, rear = -1, top = -1, floor = -1;
    {
      let maxZ = -Infinity, minZ = Infinity, maxY = -Infinity, minY = Infinity;
      nodes.forEach((n, i) => {
        if (n.z > maxZ) { maxZ = n.z; front = i; }
        if (n.z < minZ) { minZ = n.z; rear = i; }
        if (n.y > maxY) { maxY = n.y; top = i; }
        if (n.y < minY) { minY = n.y; floor = i; }
      });
      if (mainPart && Array.isArray(mainPart.refNodes)) {
        const rows = expandTable(mainPart.refNodes);
        if (rows.length) {
          const row = rows[0];
          const backIdx = nodeIndex.get(row.back);
          const refIdx = nodeIndex.get(row.ref);
          const upIdx = nodeIndex.get(row.up);
          if (backIdx !== undefined) rear = backIdx;
          if (refIdx !== undefined && backIdx !== undefined && nodes[refIdx].z > nodes[backIdx].z) front = refIdx;
          if (upIdx !== undefined) top = upIdx;
        }
      }
    }

    // INTEGRATION: core's spawnCageCar contract requires wheels[] in
    // [FL, FR, RL, RR] order (front axle first = the steered axle).
    // pressureWheels sections arrive in file order, which is arbitrary,
    // so sort by hub-node position in the engine frame: front = larger
    // z (forward is +z), left = smaller x (x points right). Hubs whose
    // z differs by <= 0.3 m count as the same axle.
    wheels.sort(function (w1, w2) {
      const a = nodes[w1.node], b = nodes[w2.node];
      const dz = b.z - a.z;
      if (Math.abs(dz) > 0.3) return dz;
      return a.x - b.x;
    });

    let totalMass = 0;
    for (const n of nodes) totalMass += n.mass;

    progress('done', 1, 'assembled "' + vehicleName + '": ' + nodes.length + ' nodes, ' + beams.length + ' beams');
    return {
      name: vehicleName,
      nodes: nodes,
      beams: beams,
      triangles: triangles,
      wheels: wheels,
      refNodes: { front: front, rear: rear, top: top, floor: floor },
      totalMass: totalMass,
      report: {
        partsUsed: partsUsed,
        nodesMerged: nodesMerged,
        beamsSkipped: beamsSkipped,
        beamsApproximated: beamsApproximated,
        warnings: warnings
      }
    };
  }

  const API = {
    parseJBeam: parseJBeam,
    expandTable: expandTable,
    assembleVehicle: assembleVehicle,
    evalExpr: evalExpr,
    resolveValue: resolveValue,
    K_SCALE: K_SCALE,
    C_SCALE: C_SCALE
  };
  if (typeof globalThis !== 'undefined') globalThis.__JBEAM = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
