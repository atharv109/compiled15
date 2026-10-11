/* ============================================================
   Customer Swarm — effects.js
   Shared visual effects, wired through data-attributes:
     .spot-card            → cursor spotlight + 1px border glow
     [data-reveal]         → viewport reveal (once), optional data-reveal-delay
     [data-orb]            → decorative drifting orb ("<div data-orb='600 400 rgba(...)'>")
   Plus procedural SVG generators:
     CSEffects.avatar(id, size)   — persona bust for cards/chats
     CSEffects.bust(variant, ink) — landing crowd figure (12 variants)
   ============================================================ */
(function () {
  "use strict";

  const CSE = (window.CSEffects = {});

  /* ---------- spotlight + border glow ---------- */
  CSE.attachSpotlights = function (root) {
    (root || document).querySelectorAll(".spot-card:not([data-spot-ready])").forEach((card) => {
      card.dataset.spotReady = "1";
      const spot = document.createElement("div");
      spot.className = "spot";
      const glow = document.createElement("div");
      glow.className = "border-glow";
      card.prepend(spot, glow);
      card.addEventListener("mousemove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--spot-x", (e.clientX - r.left) + "px");
        card.style.setProperty("--spot-y", (e.clientY - r.top) + "px");
        card.classList.add("spot-on");
      });
      card.addEventListener("mouseleave", () => card.classList.remove("spot-on"));
    });
  };

  const spotCSS = document.createElement("style");
  spotCSS.textContent = `
  .spot-card { position: relative; overflow: hidden; }
  .spot-card > .spot, .spot-card > .border-glow { position: absolute; pointer-events: none; opacity: 0; transition: opacity .3s; z-index: 0; }
  .spot-card > .spot { inset: 0; background: radial-gradient(200px circle at var(--spot-x, 50%) var(--spot-y, 50%), rgba(255,255,255,.09), transparent 60%); }
  .spot-card > .border-glow { inset: -1px; border-radius: inherit; padding: 1px;
    background: radial-gradient(260px circle at var(--spot-x, 50%) var(--spot-y, 50%), rgba(255,255,255,.30), transparent 55%);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude; }
  .spot-card:hover > .spot, .spot-card:hover > .border-glow { opacity: 1; }
  .spot-card > *:not(.spot):not(.border-glow) { position: relative; z-index: 1; }
  .spot-card.spot-lit > .spot  { background: radial-gradient(200px circle at var(--spot-x,50%) var(--spot-y,50%), rgba(255,178,36,.06), transparent 60%); }
  `;
  document.head.appendChild(spotCSS);

  /* ---------- viewport reveal (once) ---------- */
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const el = en.target;
          io.unobserve(el);
          setTimeout(() => el.classList.add("revealed"), Number(el.dataset.revealDelay || 0));
        }
      }, { threshold: 0.15 })
    : null;
  CSE.attachReveals = function (root) {
    (root || document).querySelectorAll("[data-reveal]:not([data-reveal-ready])").forEach((el) => {
      el.dataset.revealReady = "1";
      if (io) io.observe(el); else el.classList.add("revealed");
    });
  };

  /* ---------- orbs ---------- */
  CSE.orb = function (w, h, color, dur, drift) {
    const o = document.createElement("div");
    o.setAttribute("aria-hidden", "true");
    o.style.cssText =
      `position:absolute;pointer-events:none;width:${w}px;height:${h}px;border-radius:50%;` +
      `background:${color};filter:blur(60px);z-index:1;` +
      `animation:cs-drift ${dur}s ease-in-out infinite;`;
    let kf = document.getElementById("cs-drift-kf");
    if (!kf) {
      kf = document.createElement("style");
      kf.id = "cs-drift-kf";
      kf.textContent = `@keyframes cs-drift { 0%,100%{transform:translate(0,0)} 50%{transform:translate(${drift || "25px,-18px"})} }`;
      document.head.appendChild(kf);
    }
    return o;
  };

  /* ---------- procedural line-art busts (our own art, no external assets) ----------
     12 variants: head + shoulders outline, varied hair/neck/shoulder shapes.
     Each is 120×150 viewBox, stroke line-art, tinted via currentColor. */
  const HAIR = [
    "M40 34 q20 -18 40 0",                    // short
    "M36 40 q24 -30 48 -2",                   // swept
    "M34 44 q8 -28 26 -26 q26 -4 26 26",      // curly top
    "M40 30 h40 v6 q-8 -8 -40 0",             // flat crop
    "M38 46 q-4 -26 22 -30 q26 4 22 30 q0 -12 -22 -14 q-22 2 -22 14", // mid part
    "M36 38 q12 -26 30 -24 q22 0 24 26 q-4 -18 -27 -16 q-20 0 -27 14", // bob
  ];
  CSE.bust = function (variant, ink) {
    const v = ((variant || 0) % 12) + 1;
    const hair = HAIR[v % HAIR.length];
    const long = v > 6
      ? `<path d="M34 46 q-6 26 2 44 M86 46 q6 26 -2 44" />`   // long strands
      : "";
    const smile = v % 3 === 0 ? `<path d="M52 52 q8 7 16 0" />` : (v % 3 === 1 ? `<path d="M54 53 h12" />` : "");
    const tone = v % 4 === 0
      ? `<path d="M44 78 q16 12 32 0" />`   // collar
      : `<path d="M40 82 q20 -14 40 0" />`; // crew line
    return (
      `<svg viewBox="0 0 120 150" fill="none" stroke="${ink || "currentColor"}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M36 30 q24 -20 48 0 v18 q0 12 -4 18 q-4 8 -20 8 q-16 0 -20 -8 q-4 -6 -4 -18 z" />` +
      `<path d="${hair}" />` + long +
      `<circle cx="52" cy="40" r="2.2" fill="${ink || "currentColor"}" stroke="none" /><circle cx="68" cy="40" r="2.2" fill="${ink || "currentColor"}" stroke="none" />` +
      smile +
      `<path d="M22 148 q4 -44 38 -44 q34 0 38 44" />` + tone +
      `</svg>`
    );
  };

  /* avatar: tinted bust in a colored ring — used for personas everywhere */
  CSE.avatar = function (id, size, tint) {
    const color = (window.CS && CS.color(id)) || tint || "#B45309";
    const v = Math.abs(hash(String(id))) ;
    size = size || 36;
    return `<span class="cs-avatar" style="width:${size}px;height:${size}px;background:${color}1A;color:${color};border:1.5px solid ${color}66">` +
      CSE.bust(v % 12, color) + `</span>`;
  };
  function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

  document.addEventListener("DOMContentLoaded", () => { CSE.attachSpotlights(); CSE.attachReveals(); });
})();