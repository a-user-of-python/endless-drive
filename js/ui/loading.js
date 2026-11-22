/* ============================ LOADING SCREEN ============================
   Endless Drive v2.7 — global LoadingScreen.

   API:
     LoadingScreen.show(title)      open the overlay, reset bar + log
     LoadingScreen.stage(frac,msg)  set the bar to a REAL progress fraction
                                    (0..1, taken from actual converter /
                                    network progress events — this module
                                    never animates the bar on a timer) and
                                    show msg as the live status line
     LoadingScreen.log(line)        append a line to the scrolling log
     LoadingScreen.done()           close the overlay (success)
     LoadingScreen.fail(msg)        show an error + a Back button; the bar
                                    stays where the work actually stopped
     LoadingScreen.onBack = fn      optional hook run when Back is pressed
     LoadingScreen.isOpen()         whether the overlay is visible

   The log keeps the last ~40 lines in the DOM (the box itself shows the
   most recent ~8 and scrolls); every stage() message is also logged, so
   the log is a faithful transcript of the work, with timestamps relative
   to show(). Used for car import, map import and multiplayer joins.
   Classic script, no modules — safe from file://. */
(function(){
  'use strict';
  var MAX_LOG_LINES = 40;
  var els = null;
  var t0 = 0;
  var lastFrac = 0;

  function build(){
    if (els) return els;
    var root = document.createElement('div');
    root.id = 'loadScr';
    root.className = 'loadScr hidden';
    root.innerHTML =
      '<div class="loadCard">' +
        '<div class="loadTitle" id="loadTitle">Loading</div>' +
        '<div class="barOuter loadBarOuter"><div id="loadBar" class="barInner loadBar"></div></div>' +
        '<div id="loadStatus" class="loadStatus">Starting…</div>' +
        '<div id="loadLog" class="loadLog" aria-live="polite"></div>' +
        '<div id="loadErr" class="loadErr hidden"></div>' +
        '<div class="loadBtns"><button id="loadBack" class="loadBackBtn hidden" type="button">Back</button></div>' +
      '</div>';
    document.body.appendChild(root);
    els = {
      root: root,
      title: root.querySelector('#loadTitle'),
      bar: root.querySelector('#loadBar'),
      status: root.querySelector('#loadStatus'),
      log: root.querySelector('#loadLog'),
      err: root.querySelector('#loadErr'),
      back: root.querySelector('#loadBack')
    };
    els.back.addEventListener('click', function(){
      var fn = window.LoadingScreen && window.LoadingScreen.onBack;
      done();
      if (typeof fn === 'function'){ try { fn(); } catch (e) { /* hook must not break the Back button */ } }
    });
    return els;
  }

  function stamp(){
    var ms = Date.now() - t0;
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    var frac = ((ms % 1000) / 100).toFixed(0);
    return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60) + '.' + frac;
  }

  function show(title){
    var e = build();
    t0 = Date.now();
    lastFrac = 0;
    e.title.textContent = title || 'Loading';
    e.bar.style.width = '0%';
    e.status.textContent = 'Starting…';
    e.log.innerHTML = '';
    e.err.textContent = '';
    e.err.classList.add('hidden');
    e.back.classList.add('hidden');
    e.root.classList.remove('hidden');
    log('— ' + (title || 'Loading') + ' —');
  }

  function stage(frac, msg){
    var e = build();
    if (typeof frac === 'number' && isFinite(frac)){
      // Progress is monotonic: a converter reporting out of order must
      // never make the bar jump backwards.
      lastFrac = Math.max(lastFrac, Math.min(1, Math.max(0, frac)));
      e.bar.style.width = (lastFrac * 100).toFixed(1) + '%';
    }
    if (msg){
      e.status.textContent = msg;
      log(msg);
    }
  }

  function log(line){
    var e = build();
    var div = document.createElement('div');
    div.className = 'loadLogLine';
    div.textContent = '[' + stamp() + '] ' + line;
    e.log.appendChild(div);
    while (e.log.children.length > MAX_LOG_LINES) e.log.removeChild(e.log.firstChild);
    e.log.scrollTop = e.log.scrollHeight;
  }

  function done(){
    var e = build();
    e.root.classList.add('hidden');
  }

  function fail(msg){
    var e = build();
    e.err.textContent = msg || 'Something went wrong.';
    e.err.classList.remove('hidden');
    e.status.textContent = 'Stopped — see the error below.';
    e.back.classList.remove('hidden');
    e.root.classList.remove('hidden');
    log('FAILED: ' + (msg || 'unknown error'));
  }

  window.LoadingScreen = {
    show: show, stage: stage, log: log, done: done, fail: fail,
    onBack: null,
    isOpen: function(){ return !!(els && !els.root.classList.contains('hidden')); },
    frac: function(){ return lastFrac; }
  };
})();
