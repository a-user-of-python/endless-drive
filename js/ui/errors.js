/* ============================ DETAILED ERRORS ============================
   Endless Drive v2.7.2 — layered error reporting.

   Sean's requirement: an error must say WHERE it crashed, HOW it
   crashed, and WHAT went wrong. Every failure the game surfaces is
   formatted here into layers, in this order:

     headline  one short plain-words sentence ("The terrain file
               couldn't be read") — this is all a casual player needs.
     where     the stage that was running + the exact file inside the
               zip when there is one (+ what the player was doing).
     why       the cause, with the actual-vs-expected values the
               thrower reported PRESERVED — the strict .ter reader
               already throws messages like "unsupported version 8
               (expected 9 …)"; this module surfaces them, it never
               flattens them into "import failed".
     hint      a next step, ONLY where one honestly exists (pattern
               table below). No hint is invented for unknown errors.
     tech      the top stack frames, for bug reports.

   Errors carry their context as plain properties so ANY module can
   attach it without depending on this file (beamng-map.js does):
     err.edStage  stage key (see STAGES)
     err.edFile   file inside the zip / the zip's own name
     err.edHint   a specific hint that beats the pattern table
     err.edDetail extra factual line appended to the why layer
   formatError(err, context) merges those with the caller's context
   ({stage, file, op, headline} — caller wins).

   API (window.__EDERR, also module.exports under Node for tests):
     formatError(err, ctx)     -> {headline, where, why, hint, tech, stage, file}
     formatErrorText(err, ctx) -> the layers as one multi-line string
     formatErrorLines(err,ctx) -> the layers as an array of log lines
     stageError(stage, file, cause, hint) -> an Error carrying context
     tagError(err, stage, file) -> set edStage/edFile if absent; returns err
     shortHash(h)              -> first 10 hex chars + '…' (or '—')
     setContextProvider(fn)    -> game.js registers a fn returning
                                  {view, car, map, lastOp} for the
                                  fatal box's runtime-context line
     contextSnapshot()         -> that object ({}-safe)
     presentInLoading(err,ctx) -> log the layers + fail the loading
                                  panel with them (hard failures stay
                                  visible; nothing auto-dismisses)
     showFatal(plain, err,ctx) -> layered renderer for #fatalBox;
                                  installed as window.__edShowError,
                                  replacing the boot trap's plain one
                                  once this file has loaded (the boot
                                  trap's listeners call it by name, so
                                  early-boot errors keep the old path).

   Classic script in an IIFE: no top-level names, so it can never
   collide with another file's top-level declarations. */
(function(){
  'use strict';

  var STAGES = {
    unzip:       { label: 'Reading the zip',           headline: 'The zip file couldn\'t be opened' },
    level:       { label: 'Looking for the level',     headline: 'This zip has no BeamNG level inside it' },
    terrain:     { label: 'Reading the terrain (.ter)', headline: 'The terrain file couldn\'t be read' },
    items:       { label: 'Reading the level items',   headline: 'The level items couldn\'t be read' },
    roads:       { label: 'Building decal roads',      headline: 'A decal road couldn\'t be built' },
    statics:     { label: 'Converting static meshes',  headline: 'A static mesh couldn\'t be converted' },
    forest:      { label: 'Placing forest items',      headline: 'The forest items couldn\'t be placed' },
    textures:    { label: 'Decoding textures',         headline: 'A texture couldn\'t be decoded' },
    vehicle:     { label: 'Building the car (JBeam)',  headline: 'The car couldn\'t be built from its JBeam files' },
    world:       { label: 'Building the world',        headline: 'The world couldn\'t be built' },
    spawn:       { label: 'Spawning the car',          headline: 'The car couldn\'t be spawned' },
    multiplayer: { label: 'Multiplayer',               headline: 'Multiplayer hit a problem' },
    runtime:     { label: 'Running the game',          headline: 'The game hit an error' }
  };

  /* Honest hints, keyed on the thrower's own words. A pattern only
     earns a hint when the fix it names really follows from the cause. */
  var HINTS = [
    [/unsupported version (\d+)/, function(m){
      return 'This terrain file is version ' + m[1] + ', but only version 9 can be read. ' +
             'Re-export the map from a current BeamNG.drive, or try a different map zip.'; }],
    [/size equation mismatch|material names do not parse/, function(){
      return 'The .ter file doesn\'t match the BeamNG v9 layout — it may be corrupt, or saved by an incompatible tool. ' +
             'Re-downloading the map zip is the first thing to try.'; }],
    [/file too short|truncated/, function(){
      return 'The file ends earlier than its own header says it should — the download was probably cut off. Download the zip again.'; }],
    [/no levels\/<name>\/ folder/, function(){
      return 'A BeamNG map zip needs a levels/<level name>/ folder inside it, with the terrain and level files in it. ' +
             'Check you picked the map\'s .zip (not a car zip, and not an already-extracted folder).'; }],
    [/no vehicles\/<name>\/ folder/, function(){
      return 'A BeamNG car zip needs a vehicles/<vehicle name>/ folder with .jbeam files inside it. ' +
             'Check you picked the car\'s .zip (not a map zip, and not an already-extracted folder).'; }],
    [/no part with slotType "main"/, function(){
      return 'The car\'s JBeam files define no main part, so there is nothing to build a car from — this zip may be a parts pack rather than a complete car.'; }],
    [/CRC mismatch|size mismatch for entry/, function(){
      return 'The zip itself is damaged (a stored checksum/size doesn\'t match the data). Download it again.'; }],
    [/end-of-central-directory|not a zip/, function(){
      return 'That file isn\'t a zip archive — pick the .zip file itself, not an extracted folder or a renamed file.'; }],
    [/encrypted entries/, function(){
      return 'This zip has password-encrypted entries, which can\'t be read. Re-zip the files without a password.'; }],
    [/unsupported compression method/, function(){
      return 'The zip uses a compression method this reader doesn\'t support — re-zip it with standard (deflate) compression.'; }],
    [/broker unreachable/, function(){
      return 'The room-code service couldn\'t be reached — check your internet connection, or use the long codes under "Long codes" in the menu instead.'; }],
    [/peer-unavailable|connection failed|ICE failed/, function(){
      return 'The other player never answered. Check the room code is exactly right and the host is still hosting, then try again.'; }],
    [/short codes unavailable/, function(){
      return 'The PeerJS library didn\'t load, so short room codes can\'t work — use the long copy-paste codes under "Long codes" in the menu.'; }],
    [/code invalid/, function(){
      return 'That code isn\'t a complete, valid code — check it was copied in full, with no missing characters.'; }]
  ];

  /* Prefixes throwers put on their messages that merely repeat the
     stage headline (".ter: …", "zip: …", "assembleVehicle: …").
     Stripped from the why layer only; the full original message
     stays in the stack's first line under tech. */
  var PREFIXES = ['.ter: ', 'zip: ', 'assembleVehicle: ', 'importMap: '];

  function stageOf(err, ctx){
    if (ctx && ctx.stage) return ctx.stage;
    if (err && err.edStage) return err.edStage;
    return 'runtime';
  }
  function messageOf(err){
    if (err == null) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    return String(err);
  }
  function topFrames(err, n){
    if (!err || !err.stack) return '';
    var lines = String(err.stack).split('\n');
    var out = [];
    for (var i = 0; i < lines.length && out.length < n; i++){
      var s = lines[i].trim();
      if (s) out.push(s);
    }
    return out.join('\n');
  }
  function hintFor(err, why){
    if (err && err.edHint) return err.edHint;
    for (var i = 0; i < HINTS.length; i++){
      var m = HINTS[i][0].exec(why);
      if (m){ try { return HINTS[i][1](m); } catch (e) { return ''; } }
    }
    return '';
  }

  function formatError(err, ctx){
    ctx = ctx || {};
    var stage = stageOf(err, ctx);
    var st = STAGES[stage] || STAGES.runtime;
    var file = ctx.file || (err && err.edFile) || null;
    var rawMsg = messageOf(err);
    var why = rawMsg;
    for (var i = 0; i < PREFIXES.length; i++){
      if (why.indexOf(PREFIXES[i]) === 0){ why = why.slice(PREFIXES[i].length); break; }
    }
    if (err && err.cause){
      var c = messageOf(err.cause);
      if (c && c !== rawMsg) why += '\nCaused by: ' + c;
    }
    if (err && err.edDetail) why += '\n' + err.edDetail;
    if (rawMsg === 'Script error.'){
      why = 'The browser reported only "Script error." and hid the real message — ' +
            'it does that for errors inside scripts loaded from another origin (the CDN libraries).';
    }
    var whereParts = ['Stage: ' + st.label];
    if (file) whereParts.push('File: ' + file);
    if (ctx.op) whereParts.push('While: ' + ctx.op);
    return {
      headline: ctx.headline || (err && err.edHeadline) || st.headline,
      where: whereParts.join('  ·  '),
      why: why,
      hint: hintFor(err, rawMsg),
      tech: topFrames(err, 4),
      stage: stage,
      file: file
    };
  }

  function formatErrorLines(err, ctx){
    var f = formatError(err, ctx);
    var lines = [f.headline, f.where, 'What went wrong: ' + f.why.replace(/\n/g, '\n  ')];
    if (f.hint) lines.push('Hint: ' + f.hint);
    if (f.tech) f.tech.split('\n').forEach(function(l){ lines.push('  ' + l); });
    return lines;
  }
  function formatErrorText(err, ctx){
    return formatErrorLines(err, ctx).join('\n');
  }

  function stageError(stage, file, cause, hint){
    var e = new Error(messageOf(cause));
    e.edStage = stage || 'runtime';
    if (file) e.edFile = file;
    if (hint) e.edHint = hint;
    if (cause && typeof cause === 'object'){ e.cause = cause; if (cause.stack) e.stack = cause.stack; }
    return e;
  }
  function tagError(err, stage, file){
    if (err && typeof err === 'object'){
      if (!err.edStage && stage) err.edStage = stage;
      if (!err.edFile && file) err.edFile = file;
    }
    return err;
  }
  function shortHash(h){
    if (!h) return '—';
    var s = String(h);
    return s.length > 10 ? s.slice(0, 10) + '…' : s;
  }

  /* ---- runtime context for the fatal box (registered by game.js) ---- */
  var ctxProvider = null;
  function setContextProvider(fn){ ctxProvider = (typeof fn === 'function') ? fn : null; }
  function contextSnapshot(){
    var c = {};
    if (ctxProvider){ try { c = ctxProvider() || {}; } catch (e) { c = {}; } }
    return c;
  }
  function contextLine(){
    var c = contextSnapshot();
    var parts = [];
    if (c.view) parts.push('view: ' + c.view);
    if (c.car) parts.push('car: ' + c.car);
    if (c.map) parts.push('map: ' + c.map);
    if (c.lastOp) parts.push('last action: ' + c.lastOp);
    return parts.length ? 'Context: ' + parts.join('  ·  ') : '';
  }

  /* ---- loading-panel presentation --------------------------------
     Hard failures stay visible: the layers are written into the
     loading log line by line (the transcript keeps them) and the
     panel fails with the same layers — LoadingScreen.fail never
     auto-dismisses, it waits for Back. */
  function presentInLoading(err, ctx){
    var LS = (typeof globalThis !== 'undefined') ? globalThis.LoadingScreen : null;
    if (!LS) return false;
    var f = formatError(err, ctx);
    try {
      formatErrorLines(err, ctx).forEach(function(l){ LS.log(l); });
    } catch (e) { /* logging must never mask the failure itself */ }
    if (typeof LS.failDetail === 'function') LS.failDetail(f);
    else LS.fail(f.headline + ' — ' + f.why);
    return true;
  }

  /* ---- fatal box (global handler target) --------------------------
     Replaces window.__edShowError once loaded. The boot trap in
     index.html registered its listeners against that NAME, so errors
     after this file loads get the layered rendering; errors before
     it loads kept the boot rendering. First error only, matching
     the boot trap's semantics — later failures have their own
     surfaces (the loading panel) and must not fight over the box. */
  var fatalShown = false;
  function showFatal(plain, err, ctx){
    if (fatalShown) return;
    if (typeof document === 'undefined') return;
    var box = null;
    try { box = document.getElementById('fatalBox'); } catch (e) { box = null; }
    if (!box) return;
    fatalShown = true;
    try {
      var isErr = err && (typeof err === 'object') && (err.message || err.stack);
      var f = formatError(isErr ? err : null, ctx || {});
      var set = function(id, txt){ var el = document.getElementById(id); if (el) el.textContent = txt || ''; };
      set('fatalMsg', isErr ? f.headline : (plain || f.headline));
      var whereEl = document.getElementById('fatalWhere');
      if (whereEl){
        var w = isErr ? f.where : '';
        var cl = contextLine();
        whereEl.textContent = cl ? (w ? w + '\n' + cl : cl) : w;
        whereEl.style.display = whereEl.textContent ? '' : 'none';
      }
      set('fatalWhy', isErr ? f.why : '');
      var hintEl = document.getElementById('fatalHint');
      if (hintEl){ hintEl.textContent = f.hint ? 'Hint: ' + f.hint : ''; hintEl.style.display = f.hint ? '' : 'none'; }
      var techEl = document.getElementById('fatalTech');
      if (techEl){
        techEl.textContent = isErr ? (topFrames(err, 6) || f.why) : String(err || '');
        techEl.style.display = techEl.textContent ? '' : 'none';
      }
      box.classList.remove('hidden');
      var dismiss = document.getElementById('fatalDismiss');
      if (dismiss) dismiss.onclick = function(){ box.classList.add('hidden'); };
    } catch (e) { /* the error box itself must never become the error */ }
  }

  var API = {
    formatError: formatError,
    formatErrorText: formatErrorText,
    formatErrorLines: formatErrorLines,
    stageError: stageError,
    tagError: tagError,
    shortHash: shortHash,
    setContextProvider: setContextProvider,
    contextSnapshot: contextSnapshot,
    presentInLoading: presentInLoading,
    showFatal: showFatal,
    STAGES: STAGES
  };
  if (typeof globalThis !== 'undefined'){
    globalThis.__EDERR = API;
    if (typeof document !== 'undefined') globalThis.__edShowError = showFatal;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
