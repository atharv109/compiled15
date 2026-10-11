/* ============================================================
   Customer Swarm — landing.js
   Header solidify, smooth anchors, hero orbs, the How-grid
   scroll-threshold reveal (synced with the crowd-exit threshold),
   scenario row/col stagger, Why reveal at 0.75·vh.
   ============================================================ */
(function () {
  "use strict";

  var CSE = window.CSEffects;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- hero orbs (decor) ---------- */
  function addOrbs() {
    var hero = document.getElementById("hero");
    if (hero) {
      var o = CSE.orb(600, 400, "rgba(100,130,220,.06)", 30, "20px,-15px");
      o.style.filter = "blur(80px)";
      o.style.top = "30%";
      o.style.left = "50%";
      o.style.translate = "-50% -50%";   // center without touching transform (drift keyframe owns it)
      hero.prepend(o);
    }
    var how = document.getElementById("how");
    if (how) {
      var o2 = CSE.orb(360, 220, "rgba(234,160,40,.08)", 24, "25px,-15px");
      o2.style.top = "25%";
      o2.style.left = "10%";
      o2.style.rotate = "8deg";   // independent property so the drift keyframe keeps translate
      how.prepend(o2);
    }
    var cases = document.getElementById("scenarios");
    if (cases) {
      var o3 = CSE.orb(380, 200, "rgba(50,120,240,.10)", 22, "35px,-20px");
      o3.style.top = "10%";
      o3.style.left = "5%";
      o3.style.rotate = "-12deg";
      cases.prepend(o3);
      var o4 = CSE.orb(280, 180, "rgba(150,90,30,.14)", 26, "-25px,18px");
      o4.style.bottom = "10%";
      o4.style.right = "8%";
      o4.style.rotate = "18deg";
      o4.style.top = "auto";
      cases.appendChild(o4);
    }
  }

  /* ---------- header solidify (scrollY > 20, 300ms) ---------- */
  function initHeader() {
    var head = document.getElementById("site-head");
    if (!head) return;
    var update = function () { head.classList.toggle("solid", window.scrollY > 20); };
    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  /* ---------- smooth anchors ---------- */
  function initAnchors() {
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener("click", function (e) {
        var id = a.getAttribute("href");
        if (!id || id === "#") return;
        var el = document.querySelector(id);
        if (!el) return;
        e.preventDefault();
        el.scrollIntoView({ behavior: "smooth" });
      });
    });
    document.querySelectorAll("[data-scroll]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var el = document.querySelector(btn.dataset.scroll);
        if (el) el.scrollIntoView({ behavior: "smooth" });
      });
    });
  }

  /* ---------- How grid: scroll-threshold reveal (spec §6.7) ----------
     Same 0.22·innerHeight threshold as the crowd exit; the grid
     appears 700ms after that flag so the cards rise as the crowd
     leaves; each card staggers i*100ms and rises from 60px. */
  function initFeatReveal() {
    var grid = document.getElementById("feat-grid");
    if (!grid) return;
    var items = grid.querySelectorAll(".anim-show");
    var showed = false;
    function reveal() {
      if (showed) return;
      showed = true;
      // heading + subtitle appear immediately at 100/200ms
      grid.parentNode.querySelectorAll(".sec-head .anim-item").forEach(function (el, i) {
        el.style.transitionDelay = (i * 100) + "ms";
        el.classList.add("shown");
      });
      // cards rise 700ms later, i*100ms apart, from translateY(60px)
      window.setTimeout(function () {
        items.forEach(function (card, i) {
          card.style.transitionDelay = (i * 100) + "ms";
          card.style.opacity = "1";
          card.style.transform = "translateY(0)";
        });
        grid.classList.add("revealed");
        // clear stagger delays after they settle so hover lift stays instant
        window.setTimeout(function () {
          items.forEach(function (card) { card.style.transitionDelay = "0s"; });
        }, 1400 + items.length * 100);
      }, 700);
      window.removeEventListener("scroll", onScroll);
    }
    function onScroll() {
      if (window.scrollY > 0.22 * window.innerHeight) reveal();
    }
    if (reduced) { grid.classList.add("revealed"); return; }
    window.addEventListener("scroll", onScroll, { passive: true });
    if (window.scrollY > 0.22 * window.innerHeight) reveal();   // deep-linked load
  }

  /* ---------- scenario cards: row/col stagger (spec §6.8) ---------- */
  function initCaseStagger() {
    var cards = document.querySelectorAll("#case-grid .case-card[data-reveal]");
    cards.forEach(function (card, i) {
      card.dataset.revealDelay = String(Math.floor(i / 3) * 120 + (i % 3) * 60);
    });
  }

  /* ---------- Why section: reveal at 0.75·vh, once (spec §6.9) ---------- */
  function initWhyReveal() {
    var sec = document.getElementById("why");
    if (!sec) return;
    var els = sec.querySelectorAll(".anim");
    var shown = false;
    function show() {
      if (shown) return;
      shown = true;
      els.forEach(function (el) { el.classList.add("in"); });
    }
    if (reduced) { els.forEach(function (el) { el.classList.add("in"); }); return; }
    function check() {
      if (sec.getBoundingClientRect().top < window.innerHeight * 0.75) {
        show();
        window.removeEventListener("scroll", check);
      }
    }
    window.addEventListener("scroll", check, { passive: true });
    check();
  }

  /* ---------- self-drawing underline: exact dash length ---------- */
  function initUnderline() {
    var path = document.getElementById("u-path");
    if (!path) return;
    try {
      var len = path.getTotalLength();
      if (len > 0 && isFinite(len)) {
        path.style.strokeDasharray = String(Math.ceil(len) + 1);
        path.style.strokeDashoffset = String(Math.ceil(len) + 1);
      }
    } catch (e) { /* keep the CSS 210 fallback */ }
  }

  document.addEventListener("DOMContentLoaded", function () {
    addOrbs();
    initHeader();
    initAnchors();
    initFeatReveal();
    initCaseStagger();
    initWhyReveal();
    initUnderline();               // before the 0.5s draw delay kicks in
    CSE.attachSpotlights();
    CSE.attachReveals();
  });
})();