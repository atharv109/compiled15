/* ============================================================
   Customer Swarm — crowd.js
   Signature walking crowd: CSS-transition figures with a depth
   model (perspective scale, DoF blur, z-index) and an
   inverse-CDF y-sampler so far figures are denser than near
   ones. Figures are procedural CSEffects.bust() SVGs (our own
   line art) with a white halo via drop-shadow stacks.
   Re-implementation of the spec §7 algorithm in our own code.
   ============================================================ */
(function () {
  "use strict";

  var root = document.getElementById("crowd-root");
  if (!root) return;

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) { root.classList.add("crowd-done"); root.style.display = "none"; return; }

  var TOTAL = window.innerWidth < 640 ? 24 : 60;
  var MIN_SCALE = 0.5, MAX_SCALE = 1.8;
  var SPEED = { min: 3, max: 12 };   // vw per second
  var EXIT_THRESHOLD = 0.22;         // scrollY > 0.22 * innerHeight

  var inner = null;
  var quickExit = false;
  var removed = 0;
  var mounted = 0;

  function rand(a, b) { return a + Math.random() * (b - a); }

  /* ---------- depth model (spec §7) ---------- */
  function perspective(z) { return (1 / (5 - 4 * z) - 0.2) / 0.8; }   // 0..1
  function scaleAt(z) { return MIN_SCALE + (MAX_SCALE - MIN_SCALE) * perspective(z); }
  function blurAt(z) { return 4 * Math.abs(z - 0.75) / 0.75; }        // sharp at z≈0.75
  function opacityAt(z) { return 0.25 + 0.75 * Math.sqrt(z); }

  /* ---------- inverse-CDF y sampler ----------
     101 buckets over z in [0.30, 0.85], weighted by 1/scale², so
     small (far) walkers are far more common than big foreground ones;
     sampled by binary search + linear interpolation in the bucket. */
  var cdf = (function () {
    var total = 0;
    var w = [];
    for (var i = 0; i <= 100; i++) {
      var s = scaleAt(0.30 + (0.85 - 0.30) * (i / 100));
      var v = 1 / (s * s);
      w.push(v); total += v;
    }
    var acc = 0;
    return w.map(function (v) { acc += v; return acc / total; });
  })();

  function sampleZ() {
    var r = Math.random();
    var lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1; else hi = mid;
    }
    var z0 = 0.30 + (0.85 - 0.30) * (lo / 100);
    var prev = lo === 0 ? 0 : cdf[lo - 1];
    var f = (r - prev) / ((cdf[lo] - prev) || 1);
    return Math.min(0.85, Math.max(0.30, z0 + f * (0.85 - 0.30) / 100));
  }

  /* ---------- figure ---------- */
  function makeFigure(dir, initialScatter) {
    var z = sampleZ();
    var scale = scaleAt(z);
    var blur = blurAt(z);
    var amber = Math.random() < 0.12;

    var wrap = document.createElement("div");
    wrap.className = "crowd-person";
    wrap.dataset.dir = dir;
    wrap.setAttribute("aria-hidden", "true");
    var wpx = Math.round(120 * scale);
    if (wpx < 60) wpx = 60;
    wrap.style.width = wpx + "px";
    wrap.style.top = (z * 100) + "%";
    wrap.style.zIndex = String(Math.floor(z * 100));
    wrap.style.opacity = opacityAt(z).toFixed(2);

    var move = document.createElement("div");
    move.className = "crowd-move";
    move.style.setProperty("--dur", "0s");
    move.style.setProperty("--x", "0vw");

    var fig = document.createElement("div");
    fig.className = "crowd-fig" + (amber ? " is-amber" : "");
    fig.innerHTML = window.CSEffects.bust(Math.floor(Math.random() * 12), amber ? "#FFB224" : "#fff");
    var halo = amber
      ? "drop-shadow(0 0 1px #FFB224) drop-shadow(0 0 2px rgba(255,178,36,.85))"
      : "drop-shadow(0 0 1px #fff) drop-shadow(0 0 2px #fff)";
    fig.style.filter = halo + (blur > 0.35 ? " blur(" + blur.toFixed(1) + "px)" : "");
    if (dir === "B") fig.style.transform = "scaleX(-1)";

    move.appendChild(fig);
    wrap.appendChild(move);
    return figureWalk(wrap, move, dir, initialScatter);
  }

  function figureWalk(wrap, move, dir, initialScatter) {
    var spread = Math.random() * 6 + 4;   // vw of edge overhang spread
    var x0;
    if (initialScatter) x0 = rand(5, 95);
    else if (dir === "A") x0 = -3 - Math.random() * 2 - spread * 0.65;
    else x0 = 103 + Math.random() * 2 + spread * 0.65;
    var targetX = dir === "A" ? rand(103, 105) : rand(-3, -5);
    var r = Math.random();
    var speed = SPEED.min + r * r * (SPEED.max - SPEED.min);   // skew slow
    var dur = Math.abs(targetX - x0) / speed;

    move.style.transitionDuration = "0s";
    move.style.setProperty("--x", x0.toFixed(2) + "vw");

    // double rAF: paint at x0 un-transitioned, then start the walk: real
    // duration + target x so the whole traversal runs on the compositor
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!move.isConnected) return;
        move.style.transitionDuration = dur.toFixed(2) + "s";
        move.style.setProperty("--x", targetX.toFixed(2) + "vw");
      });
    });

    // transitionend → respawn at the opposite edge (debounced 100ms)
    var last = 0;
    move.addEventListener("transitionend", function (e) {
      if (e.propertyName !== "transform") return;
      var now = Date.now();
      if (now - last < 100) return;
      last = now;
      if (!move.isConnected || quickExit) return;
      wrap.parentNode.removeChild(wrap);
      mounted--;
      if (inner && inner.parentNode) {
        // endless: the walker re-enters from its origin edge with fresh depth/sprite/speed
        inner.appendChild(makeFigure(dir, false));
        mounted++;
      }
    });
    return wrap;
  }

  /* ---------- quick exit + unmount ---------- */
  function quickExitAll() {
    if (quickExit) return;
    quickExit = true;
    root.querySelectorAll(".crowd-move").forEach(function (m) {
      var dir = m.parentNode.dataset.dir;
      // inline duration beats --dur; the .exit class is belt-and-braces
      m.classList.add("exit");
      m.style.transitionDuration = "0.5s";
      m.style.setProperty("--x", dir === "B" ? "-20vw" : "120vw");
    });
  }

  function onExitEnd(e) {
    if (e.propertyName !== "transform") return;
    var wrap = e.target.parentNode;
    if (!wrap || !wrap.dataset) return;
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    removed++;
    if (removed >= mounted) {
      inner.innerHTML = "";
      root.classList.add("crowd-done");
      root.style.display = "none";
      window.removeEventListener("scroll", onScroll);
    }
  }

  function onScroll() {
    if (window.scrollY > EXIT_THRESHOLD * window.innerHeight) {
      quickExitAll();
      window.removeEventListener("scroll", onScroll);
      root.addEventListener("transitionend", onExitEnd, true);
    }
  }

  /* ---------- mount ---------- */
  if (window.scrollY > EXIT_THRESHOLD * window.innerHeight) {
    root.classList.add("crowd-done");
    root.style.display = "none";
    return;
  }

  inner = document.createElement("div");
  inner.style.cssText = "position:absolute;inset:0;transform:translateZ(0);contain:strict;";
  inner.setAttribute("aria-hidden", "true");
  root.appendChild(inner);
  root.classList.add("crowd-quick");   // fixed while hero is in view

  for (var i = 0; i < TOTAL; i++) {
    inner.appendChild(makeFigure(i % 2 === 0 ? "A" : "B", true));
    mounted++;
  }

  window.addEventListener("scroll", onScroll, { passive: true });
})();