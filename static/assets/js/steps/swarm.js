/* ============================================================
   Customer Swarm — steps/swarm.js
   STEP 02 · Swarm: evidence graph + emergent personas.

   Left (55%): a force-directed evidence graph on a dotted canvas —
   evidence cards (squares, colored by type), segment nodes (big
   circles in CS.PAL) and persona dots (r=6, tinted by segment),
   laid out by a small hand-rolled force simulation (a0.02 §8.3,
   reimplemented in vanilla JS: O(n²) repulsion at n≈70 is fine,
   link springs toward segment centroids, center pull, damping,
   rAF until alpha < 0.02, reheated +0.3 as new nodes land).

   Right (45%): emergent segment cards + a persona birth stream
   (newest ~6 alive, older fade away) + live counter.

   Read-only over CS.session; all motion is local instance state.
   Catch-up safe: mountable at any time, syncs from whatever the
   session already holds without resetting a settled layout.
   ============================================================ */
(function () {
  "use strict";

  if (!window.CS || !CS.register) return;

  /* ---------- constants ---------- */
  const TYPE_STYLE = {
    /* real backend evidence.type values (docs/api-contract.md) */
    review:      { c: "#B45309", label: "review" },       // amber
    price:       { c: "#7C3AED", label: "price" },        // purple
    competitor:  { c: "#1D4ED8", label: "competitor" },   // blue
    event:       { c: "#0369A1", label: "event" },        // sky
    profile:     { c: "#0F766E", label: "profile" },      // teal
    public_info: { c: "#666666", label: "public info" },  // gray
    /* partner rehearsal vocabulary (kept for mock fixtures) */
    wishes:     { c: "#B45309", label: "wishes" },       // amber
    praise:     { c: "#D97706", label: "praise" },       // amber (lighter)
    market:     { c: "#1D4ED8", label: "market" },       // blue
    operations: { c: "#0F766E", label: "operations" },   // teal
    price:      { c: "#7C3AED", label: "price" },        // purple
    weak:       { c: "#8C8C8C", label: "unverified" },   // gray, dashed
  };
  const STANCE = {
    support:        ["for", "ok"],
    oppose:         ["against", "err"],
    neutral:        ["neutral", "mut"],
    /* partner rehearsal vocabulary */
    for:            ["for", "ok"],
    against:        ["against", "err"],
    strong_against: ["strong against", "err"],
    promo_only:     ["promo only", "warn"],
  };
  /* evidence.type → keywords used to pair cards to segment descriptions */
  const KEYWORDS = {
    /* real backend evidence types first */
    review:     ["wish", "late", "night", "hour", "loyal", "regular", "quiet", "study", "brunch"],
    competitor: ["competitor", "delivery", "market", "app", "listing", "late", "midnight", "alternatives"],
    event:      ["game", "event", "weekend", "festival", "sat", "football"],
    profile:    ["menu", "hours", "about", "profile", "listing"],
    public_info:["news", "blog", "public", "local", "web"],
    /* partner rehearsal vocabulary */
    wishes:     ["late", "night", "hour", "evening", "study", "refuge", "10pm", "wish", "weekend"],
    market:     ["competitor", "delivery", "market", "app", "listing", "late", "midnight"],
    operations: ["staff", "turnover", "parking", "overext", "rota", "quiet", "morn", "regular", "crew"],
    price:      ["price", "promo", "deal", "discount", "$", "cost", "steep"],
    praise:     ["loyal", "famili", "brunch", "regular", "recogn", "calm", "quiet", "morn"],
  };

  /* ---------- tiny deterministic helpers (stable per session) ---------- */
  function h32(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rand01(salt) {
    let t = (h32(salt) + 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  /* deterministic evidence→segment pairing: keyword match dominates, hash breaks ties */
  function pairEvidence(ev, segs) {
    if (!segs || !segs.length) return null;
    const keys = KEYWORDS[ev.type] || [];
    const claim = String(ev.claim || "").toLowerCase() + " " + String(ev.type || "").toLowerCase();
    let best = null, bestScore = -1;
    for (const s of segs) {
      const hay = String(s.name || "").toLowerCase() + " " + String(s.description || "").toLowerCase();
      let score = 0;
      for (const k of keys) if (hay.indexOf(k) >= 0) score += 10;
      if (claim && hay.split(/\s+/).some((w) => w.length > 3 && claim.indexOf(w) >= 0)) score += 2;
      score += (h32(ev.id + "|" + s.id) % 1000) / 1000;   // stable tiebreak
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  const svgEl = (tag) => document.createElementNS(SVGNS, tag);

  /* ============================================================ */
  function makeSwarm(mount) {
    /* CS.session is rebuilt by bridge.js — always read it fresh, never capture */
    const S = () => CS.session || { evidence: [], segments: [], personas: [] };

    /* ---------- instance state ---------- */
    const nodes = [];                 // {key,kind,x,y,vx,vy,m,r,el,data}
    const byKey = new Map();
    const edges = [];                 // {a,b,d,el,kind}
    const segColor = new Map();       // segment id → CS.PAL color (arrival order)
    let alpha = 0, alphaTarget = 0, rafId = 0;
    let W = 640, H = 480;
    let selKey = null;
    let dead = false;
    const offs = [];
    let listTimer = 0;

    /* ---------- DOM ---------- */
    mount.innerHTML = "";
    const root = CS.el(`
      <div class="sw-root">
        <div class="sw-bar">
          <div class="sw-bar-l">
            <span class="sw-num">02</span>
            <span class="sw-title">Awaiting scout results…</span>
          </div>
          <span class="sw-chip st"></span>
        </div>
        <div class="sw-main">
          <div class="sw-left">
            <svg class="sw-svg" aria-hidden="true">
              <g class="sw-world"><g class="sw-links"></g><g class="sw-nodes"></g></g>
            </svg>
            <div class="sw-canvas-head">
              <span class="sw-ch">◇ evidence graph</span>
              <span class="sw-meta"></span>
            </div>
            <div class="sw-legend" aria-hidden="true"></div>
            <div class="sw-empty" hidden>❖ waiting for the swarm — evidence cards land here</div>
            <div class="sw-detail" hidden></div>
          </div>
          <div class="sw-right">
            <div class="sw-count-row">
              <span class="sw-count"></span>
              <span class="sw-weak" hidden></span>
            </div>
            <div class="sw-seg-head">emergent segments</div>
            <div class="sw-seg-list"></div>
            <div class="sw-stream-head">agents materializing <span class="sw-live">● live</span></div>
            <div class="sw-stream" aria-live="polite"></div>
          </div>
        </div>
        <div class="sw-tip" hidden></div>
      </div>`);
    mount.appendChild(root);

    const left    = root.querySelector(".sw-left");
    const svg     = root.querySelector(".sw-svg");
    const world   = root.querySelector(".sw-world");
    const linksG  = root.querySelector(".sw-links");
    const nodesG  = root.querySelector(".sw-nodes");
    const metaEl  = root.querySelector(".sw-meta");
    const legendEl   = root.querySelector(".sw-legend");
    const emptyEl    = root.querySelector(".sw-empty");
    const detailEl   = root.querySelector(".sw-detail");
    const countEl    = root.querySelector(".sw-count");
    const weakEl     = root.querySelector(".sw-weak");
    const segListEl  = root.querySelector(".sw-seg-list");
    const streamEl   = root.querySelector(".sw-stream");
    const titleEl    = root.querySelector(".sw-title");
    const chipEl     = root.querySelector(".sw-chip.st");
    const liveEl     = root.querySelector(".sw-live");
    const tipEl      = root.querySelector(".sw-tip");

    /* ---------- legend (bottom-left) ---------- */
    legendEl.innerHTML = `
      <div class="lg-title">Nodes</div>
      <div class="lg-row"><i style="background:#B45309"></i>review · wishes/praise</div>
      <div class="lg-row"><i style="background:#1D4ED8"></i>competitor / market</div>
      <div class="lg-row"><i style="background:#0F766E"></i>profile / operations</div>
      <div class="lg-row"><i style="background:#7C3AED"></i>price</div>
      <div class="lg-row"><i class="lg-dash"></i>unverified (weak)</div>
      <div class="lg-row"><i class="lg-seg" style="background:#B45309"></i>segment</div>
      <div class="lg-row"><i class="lg-per" style="background:#9CA3AF"></i>agent</div>`;

    /* ============================================================
       physics — §8.3 numbers, hand-rolled
       ============================================================ */
    function measure() {
      const r = left.getBoundingClientRect();
      W = Math.max(360, Math.round(r.width) || 640);
      H = Math.max(340, Math.round(r.height) || 480);
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    }
    function reheat(level) {
      alpha = Math.max(alpha, level == null ? 0.3 : level);
      if (!rafId && !dead) { rafId = requestAnimationFrame(loop); }
    }
    function loop() {
      rafId = 0;
      if (dead) return;
      step();
      if (alpha >= 0.02 || alphaTarget > 0) rafId = requestAnimationFrame(loop);
    }
    function step() {
      const n = nodes.length;
      const DAMP = 0.62, REP = 9000, LINK = 0.05;

      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        a.vx += (W / 2 - a.x) * 0.008 * alpha;      // center pull
        a.vy += (H / 2 - a.y) * 0.008 * alpha;
      }
      /* repulsion + collide, O(n²) */
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.25) { d2 = 0.25; dx = 0.5; dy = 0.5; }
          const d = Math.sqrt(d2);
          let move = Math.min(5, REP * alpha / d2);
          const minD = a.r + b.r + 14;
          if (d < minD) move += (minD - d) * 0.45;   // collision (alpha-agnostic)
          const ux = dx / d, uy = dy / d;
          const wa = b.m / (a.m + b.m), wb = 1 - wa;
          a.vx -= ux * move * wa; a.vy -= uy * move * wa;
          b.vx += ux * move * wb; b.vy += uy * move * wb;
        }
      }
      /* link springs toward segment centroids */
      for (let k = 0; k < edges.length; k++) {
        const e = edges[k], a = e.a, b = e.b;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.25;
        const pull = (d - e.d) * LINK * alpha;
        const ux = dx / d, uy = dy / d;
        const wa = b.m / (a.m + b.m), wb = 1 - wa;
        a.vx += ux * pull * wa; a.vy += uy * pull * wa;
        b.vx -= ux * pull * wb; b.vy -= uy * pull * wb;
      }
      /* integrate + paint */
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        a.vx *= DAMP; a.vy *= DAMP;
        a.vx = clamp(a.vx, -2.5, 2.5); a.vy = clamp(a.vy, -2.5, 2.5);
        a.x += a.vx; a.y += a.vy;
        if (a.x < 16) a.vx += (16 - a.x) * 0.1;                 // soft walls
        if (a.x > W - 16) a.vx -= (a.x - (W - 16)) * 0.1;
        if (a.y < 18) a.vy += (18 - a.y) * 0.1;
        if (a.y > H - 18) a.vy -= (a.y - (H - 18)) * 0.1;
        if (a.el) a.el.setAttribute("transform", "translate(" + a.x.toFixed(1) + "," + a.y.toFixed(1) + ")");
      }
      for (let k = 0; k < edges.length; k++) {
        const e = edges[k], el = e.el;
        if (!el) continue;
        el.setAttribute("x1", e.a.x.toFixed(1)); el.setAttribute("y1", e.a.y.toFixed(1));
        el.setAttribute("x2", e.b.x.toFixed(1)); el.setAttribute("y2", e.b.y.toFixed(1));
      }
      alpha += (alphaTarget - alpha) * 0.06;                    // alphaDecay
    }

    /* ============================================================
       nodes
       ============================================================ */
    function ringPos(key, radius) {
      const ang = rand01(key) * Math.PI * 2;
      return {
        x: W / 2 + Math.cos(ang) * radius,
        y: H / 2 + Math.sin(ang) * radius * 0.9,
        jx: (rand01(key + "|jx") - 0.5) * 36,
        jy: (rand01(key + "|jy") - 0.5) * 36,
      };
    }
    function addSegNode(seg) {
      const col = CS.PAL[segColor.size % CS.PAL.length];
      segColor.set(seg.id, col);
      const r = clamp(14 + (Number(seg.size) || 6) * 1.1, 18, 30);
      const p = ringPos("SG|" + seg.id, Math.min(W, H) * 0.26);
      const g = svgEl("g");
      g.setAttribute("class", "nd nd-seg");
      g.innerHTML =
        '<circle r="' + r + '" fill="' + col + '" stroke="#fff" stroke-width="2.5"></circle>' +
        '<text class="nd-seg-n" text-anchor="middle" dy="3.5">' + CS.esc(seg.size || "") + "</text>" +
        '<text class="nd-lb" text-anchor="middle" y="' + (r + 15) + '">' + CS.esc(trunc(seg.name, 20)) + "</text>";
      const a = {
        key: "SG:" + seg.id, kind: "seg", x: p.x + p.jx, y: p.y + p.jy,
        vx: 0, vy: 0, m: 4, r: r, data: seg, el: g,
      };
      g.__node = a;
      nodesG.appendChild(g);
      nodes.push(a); byKey.set(a.key, a);
      bindNode(a);
      return a;
    }
    function addEvNode(ev) {
      const weak = !!ev.weak || ev.type === "weak";
      const st = TYPE_STYLE[ev.type] || TYPE_STYLE.wishes;
      const src = byKey.get("SG:" + ((pairEvidence(ev, S().segments) || {}).id));
      const p = ringPos("EV|" + ev.id, Math.min(W, H) * 0.17);
      const g = svgEl("g");
      g.setAttribute("class", "nd nd-ev" + (weak ? " is-weak" : ""));
      g.innerHTML =
        '<rect class="nd-r" x="-13" y="-9" width="26" height="18" rx="4.5" fill="' +
          (weak ? "#F7F7F7" : st.c) + '" stroke="' + (weak ? "#9C9C9C" : "#fff") +
          '" stroke-width="2.5"></rect>' +
        '<text class="nd-ev-id" text-anchor="middle" y="-14">' + CS.esc(ev.id) + "</text>";
      const a = {
        key: "EV:" + ev.id, kind: "ev", x: (src ? src.x : p.x) + p.jx, y: (src ? src.y : p.y) + p.jy,
        vx: 0, vy: 0, m: 2.5, r: 15, data: ev, el: g,
      };
      g.__node = a;
      nodesG.appendChild(g);
      nodes.push(a); byKey.set(a.key, a);
      bindNode(a);
      return a;
    }
    function addPerNode(per) {
      const col = segColor.get(per.segment) ||
        (window.CS ? CS.color(per.id) : "#9CA3AF");
      const src = byKey.get("SG:" + per.segment);
      const p = ringPos("P|" + per.id, Math.min(W, H) * 0.12);
      const g = svgEl("g");
      g.setAttribute("class", "nd nd-per");
      g.innerHTML =
        '<circle r="6" fill="' + col + '" stroke="#fff" stroke-width="2"></circle>';
      const a = {
        key: "P:" + per.id, kind: "per", x: (src ? src.x : p.x) + p.jx * 1.6,
        y: (src ? src.y : p.y) + p.jy * 1.6,
        vx: 0, vy: 0, m: 1, r: 6, data: per, el: g,
      };
      g.__node = a;
      nodesG.appendChild(g);
      nodes.push(a); byKey.set(a.key, a);
      bindNode(a);
      return a;
    }

    /* ---------- edges: rebuilt wholesale per sync (few dozen — cheap) ---------- */
    function addEdge(a, b, d, kind) {
      if (!a || !b) return;
      const el = svgEl("line");
      el.setAttribute("class", "lk lk-" + kind);
      linksG.appendChild(el);
      edges.push({ a: a, b: b, d: d, el: el, kind: kind });
    }
    function buildEdges() {
      linksG.innerHTML = "";
      edges.length = 0;
      const ses = S();
      for (const ev of ses.evidence || []) {
        const seg = pairEvidence(ev, ses.segments || []);
        if (seg) addEdge(byKey.get("EV:" + ev.id), byKey.get("SG:" + seg.id), 130, "ev");
      }
      for (const per of ses.personas || []) {
        addEdge(byKey.get("P:" + per.id), byKey.get("SG:" + per.segment), 52, "per");
      }
    }

    /* ============================================================
       sync (catch-up safe; merges, never resets)
       ============================================================ */
    function sync(initial) {
      if (dead) return;
      const ses = S();
      let added = false;
      for (const seg of ses.segments || []) if (!byKey.has("SG:" + seg.id)) { addSegNode(seg); added = true; }
      for (const ev of ses.evidence || []) if (!byKey.has("EV:" + ev.id)) { addEvNode(ev); added = true; }
      for (const per of ses.personas || []) if (!byKey.has("P:" + per.id)) { addPerNode(per); added = true; }
      buildEdges();
      paintCounts();
      if (added) reheat(initial ? 1 : 0.05);
      if (initial) { seedStream(); renderSegList(); }
      syncTitleSync();
    }
    function paintCounts() {
      const ses = S();
      const ev = (ses.evidence || []).length;
      const sg = (ses.segments || []).length;
      const per = (ses.personas || []).length;
      const weak = (ses.evidence || []).filter((e) => e.weak || e.type === "weak").length;
      metaEl.textContent = ev + " evidence · " + sg + " segments · " + per + " agents";
      if (countEl) countEl.textContent = per + " agents · " + sg + " segments";
      weakEl.hidden = !weak;
      if (weak) weakEl.textContent = weak + " unverified card" + (weak > 1 ? "s" : "");
      emptyEl.hidden = nodes.length > 0;
    }
    function syncTitleSync() {
      const ses = S();
      if ((ses.evidence || []).length || (ses.segments || []).length || (ses.personas || []).length) {
        titleEl.textContent = "Scouts done · evidence base ready";
      } else {
        titleEl.textContent = "Awaiting scout results…";
      }
      setChip();
    }
    function setChip() {
      const done = CS.state === "done";
      const run = CS.state === "running";
      chipEl.textContent = done ? "swarm formed" : run ? "streaming" : "standby";
      chipEl.className = "sw-chip st" + (done ? " is-done" : run ? " is-run" : "");
      liveEl.textContent = done ? "● done" : "● live";
    }

    /* ============================================================
       hover tooltip
       ============================================================ */
    function tipPos(e) {
      const pad = 14;
      let x = e.clientX + pad, y = e.clientY + pad;
      const r = tipEl.getBoundingClientRect();
      if (x + r.width > window.innerWidth - 10) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 10) y = e.clientY - r.height - pad;
      tipEl.style.left = x + "px";
      tipEl.style.top = y + "px";
    }
    function showTip(node, e) {
      const d = node.data;
      let html = "";
      if (node.kind === "per") {
        const seg = (S().segments || []).find((s) => s.id === d.segment) || {};
        const col = segColor.get(d.segment) || "#999";
        html = '<div class="tp-name"><i style="background:' + col + '"></i>' + CS.esc(d.name) + "</div>" +
               '<div class="tp-sub">' + CS.esc(seg.name || "") + "</div>" +
               '<div class="tp-quote">“' + CS.esc(d.quote || "") + "”</div>";
      } else if (node.kind === "ev") {
        const st = TYPE_STYLE[d.type] || TYPE_STYLE.wishes;
        const weak = !!d.weak || d.type === "weak";
        html = '<div class="tp-chip" style="color:' + st.c + '">' + CS.esc(st.label) + "</div>" +
               (weak ? '<div class="tp-chip tp-weak">unverified</div>' : "") +
               '<div class="tp-claim">' + CS.esc(d.claim || "") + "</div>" +
               '<div class="tp-src">' + CS.esc(d.source_label || d.source_url || "") + "</div>";
      } else {
        html = '<div class="tp-name"><i style="background:' + (segColor.get(d.id) || "#999") + '"></i>' +
               CS.esc(d.name) + "</div>" +
               '<div class="tp-sub">' + CS.esc(d.size || 0) + " agents</div>" +
               '<div class="tp-quote">' + CS.esc(d.description || "") + "</div>";
      }
      tipEl.innerHTML = html;
      tipEl.hidden = false;
      tipPos(e);
    }
    function hideTip() { tipEl.hidden = true; }

    /* ============================================================
       selection + detail panel (top-right, 280px)
       ============================================================ */
    function clearSel() {
      selKey = null;
      nodesG.querySelectorAll(".sel,.sel-soft").forEach((el) => el.classList.remove("sel", "sel-soft"));
      linksG.querySelectorAll(".hi").forEach((el) => el.classList.remove("hi"));
      detailEl.hidden = true;
      detailEl.classList.remove("on");
    }
    function select(node) {
      clearSel();
      if (!node) return;
      selKey = node.key;
      node.el.classList.add("sel");
      const touch = [];
      if (node.kind === "per") {
        const sg = byKey.get("SG:" + node.data.segment);
        if (sg) { sg.el.classList.add("sel-soft"); touch.push(sg); }
      }
      for (const e of edges) {
        if (e.a === node || e.b === node || touch.indexOf(e.a) >= 0 || touch.indexOf(e.b) >= 0) {
          e.el.classList.add("hi");
        }
      }
      if (node.kind === "per") openDetailPersona(node);
      else if (node.kind === "ev") openDetailEvidence(node);
      else openDetailSegment(node);
    }
    function detailShell(inner) {
      detailEl.hidden = false;
      void detailEl.offsetWidth;
      detailEl.classList.add("on");
      detailEl.innerHTML =
        '<button class="sw-dx" title="Close">×</button>' +
        inner;
      detailEl.querySelector(".sw-dx").addEventListener("click", clearSel);
    }
    function openDetailPersona(node) {
      const d = node.data;
      const seg = (S().segments || []).find((s) => s.id === d.segment) || {};
      const col = segColor.get(d.segment) || "#999";
      const st = STANCE[d.stance] || STANCE.neutral;
      detailShell(
        '<div class="dt-ava">' + (window.CSEffects ? window.CSEffects.avatar(d.id, 46) : "") + "</div>" +
        '<div class="dt-name">' + CS.esc(d.name) + "</div>" +
        '<div class="dt-seg"><i style="background:' + col + '"></i>' + CS.esc(seg.name || d.segment || "") + "</div>" +
        '<div class="dt-quote">“' + CS.esc(d.quote || "") + "”</div>" +
        '<div class="dt-row"><span class="sw-chip ' + st[1] + '">' + CS.esc(st[0]) + "</span></div>"
      );
    }
    function openDetailEvidence(node) {
      const d = node.data;
      const st = TYPE_STYLE[d.type] || TYPE_STYLE.wishes;
      const weak = !!d.weak || d.type === "weak";
      detailShell(
        '<div class="dt-row"><span class="sw-chip" style="color:' + st.c + ';background:' + st.c + '14">' +
          CS.esc(st.label) + "</span>" +
        (weak ? '<span class="sw-chip chip-weak">unverified</span>' : "") + "</div>" +
        '<div class="dt-claim">' + CS.esc(d.claim || "") + "</div>" +
        '<div class="dt-src">' + CS.esc(d.source_label || "") + "</div>" +
        '<div class="dt-url">' + CS.esc(d.source_url || "") + "</div>" +
        (weak ? '<div class="dt-note">Weighting flagged — may be demoted in debate.</div>' : "")
      );
    }
    function openDetailSegment(node) {
      const d = node.data;
      const col = segColor.get(d.id) || "#999";
      const members = (S().personas || []).filter((p) => p.segment === d.id);
      let avs = "";
      members.slice(0, 6).forEach((p) => { avs += window.CSEffects ? window.CSEffects.avatar(p.id, 22) : ""; });
      if (members.length > 6) avs += '<span class="dt-more">+' + (members.length - 6) + "</span>";
      detailShell(
        '<div class="dt-segname"><i style="background:' + col + '"></i>' + CS.esc(d.name) + "</div>" +
        '<div class="dt-row"><span class="sw-chip mut">' + CS.esc(d.size || members.length) + " agents</span></div>" +
        '<div class="dt-claim">' + CS.esc(d.description || "") + "</div>" +
        '<div class="dt-avs">' + avs + "</div>"
      );
    }

    /* ---------- node interaction wiring ---------- */
    function bindNode(a) {
      const el = a.el;
      el.addEventListener("mouseenter", (e) => { if (!dead) showTip(a, e); });
      el.addEventListener("mousemove", (e) => { if (!dead && !tipEl.hidden) tipPos(e); });
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dead) return;
        hideTip();
        if (selKey === a.key) clearSel(); else select(a);
      });
    }
    svg.addEventListener("click", (e) => { if (e.target === svg || e.target === world) { clearSel(); hideTip(); } });

    /* wheel zoom — around the cursor; dblclick resets */
    const zt = { s: 1, x: 0, y: 0 };
    function applyZ() {
      world.setAttribute("transform", "translate(" + zt.x + " " + zt.y + ") scale(" + zt.s + ")");
    }
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = clamp(zt.s * f, 0.55, 2.6);
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      zt.x = mx - (mx - zt.x) * (ns / zt.s);
      zt.y = my - (my - zt.y) * (ns / zt.s);
      zt.s = ns;
      applyZ();
    }, { passive: false });
    svg.addEventListener("dblclick", () => { zt.s = 1; zt.x = 0; zt.y = 0; applyZ(); });

    /* ============================================================
       right pane: segment cards + persona stream
       ============================================================ */
    const seenSeg = new Set();
    function renderSegList() {
      const ses = S();
      const segs = ses.segments || [];
      if (!segs.length) {
        segListEl.innerHTML = '<div class="sw-seg-hint">segments appear as the swarm clusters itself…</div>';
        return;
      }
      const per = ses.personas || [];
      segListEl.innerHTML = "";
      for (const s of segs) {
        const col = segColor.get(s.id) || "#999";
        const members = per.filter((p) => p.segment === s.id);
        let avs = "";
        members.slice(0, 5).forEach((p) => { avs += window.CSEffects ? window.CSEffects.avatar(p.id, 20) : ""; });
        if (members.length > 5) avs += '<span class="sg-more">+' + (members.length - 5) + "</span>";
        const card = CS.el(
          '<div class="sw-seg' + (seenSeg.has(s.id) ? "" : " enter") + '" data-seg="' + CS.esc(s.id) + '">' +
            '<div class="sg-row">' +
              '<span class="sg-dot" style="background:' + col + '"></span>' +
              '<span class="sg-name">' + CS.esc(s.name) + "</span>" +
              '<span class="sg-size" style="color:' + col + '">' + CS.esc(s.size || members.length) + "</span>" +
            "</div>" +
            '<div class="sg-desc">' + CS.esc(s.description || "") + "</div>" +
            '<div class="sg-avs">' + avs + "</div>" +
          "</div>");
        card.addEventListener("click", () => {
          const n = byKey.get("SG:" + s.id);
          if (n) select(n);
        });
        segListEl.appendChild(card);
        seenSeg.add(s.id);
      }
    }

    /* persona birth stream — newest first, ~6 alive, older fade */
    const shownStream = new Set();
    let streamBooted = false;
    function streamCard(p) {
      const seg = (S().segments || []).find((s) => s.id === p.segment) || {};
      const col = segColor.get(p.segment) || "#999";
      return CS.el(
        '<div class="sw-agent">' +
          (window.CSEffects ? window.CSEffects.avatar(p.id, 28) : '<span class="sg-dot" style="background:' + col + '"></span>') +
          '<div class="sa-tx">' +
            '<div class="sa-top"><b>' + CS.esc(p.name) + "</b>" +
              '<span class="sa-seg" style="color:' + col + '">' + CS.esc(seg.name || p.segment || "") + "</span></div>" +
            '<div class="sa-quote">' + CS.esc(trunc(p.quote || "", 72)) + "</div>" +
          "</div>" +
        "</div>");
    }
    function pushPersona(p, animate) {
      shownStream.add(p.id);
      const card = streamCard(p);
      if (animate) card.classList.add("enter");
      streamEl.prepend(card);
      while (streamEl.children.length > 6) {
        const last = streamEl.lastElementChild;
        if (last.classList.contains("out")) { last.remove(); continue; }
        last.classList.add("out");
        setTimeout(() => { if (last.parentNode) last.remove(); }, 300);
      }
    }
    function seedStream() {
      /* catch-up: no fanfare, just the tail of the stream */
      streamEl.innerHTML = "";
      shownStream.clear();
      streamBooted = true;
      const per = S().personas || [];
      per.slice(-6).forEach((p) => pushPersona(p, false));
    }
    function burstStream() {
      const per = S().personas || [];
      for (const p of per) {
        if (!shownStream.has(p.id)) pushPersona(p, streamBooted);
      }
      if (!per.length) streamBooted = true;
    }

    /* ---------- debounced list re-render ---------- */
    function scheduleLists() {
      if (listTimer) return;
      listTimer = setTimeout(() => {
        listTimer = 0;
        if (dead) return;
        renderSegList();
        paintCounts();
      }, 100);
    }

    /* ============================================================
       bus wiring
       ============================================================ */
    const onEv = () => { sync(false); scheduleLists(); };
    const onSegEv = () => { sync(false); scheduleLists(); burstStream(); };
    const onPerEv = () => { sync(false); burstStream(); paintCounts(); scheduleLists(); };
    const onScoutDone = () => {
      titleEl.textContent = "Scouts done · evidence base ready";
      titleEl.classList.remove("flash");
      void titleEl.offsetWidth;
      titleEl.classList.add("flash");
    };
    const onStreamDone = () => setChip();
    const onSessionStart = () => {
      /* session restart: wipe local graph state, resync */
      nodes.length = 0; byKey.clear(); edges.length = 0; segColor.clear();
      nodesG.innerHTML = ""; linksG.innerHTML = "";
      seenSeg.clear(); shownStream.clear();
      streamBooted = true;   // fresh sessions stream with animation on
      streamEl.innerHTML = "";
      segListEl.innerHTML = "";
      clearSel();
      alpha = 0;
      sync(true);
    };
    offs.push(CS.on("evidence", onEv));
    offs.push(CS.on("segment", onSegEv));
    offs.push(CS.on("persona", onPerEv));
    offs.push(CS.on("scout:done", onScoutDone));
    offs.push(CS.on("stream:done", onStreamDone));
    offs.push(CS.on("session:start", onSessionStart));

    /* resize keeps the viewBox (and thus physics bounds) honest */
    let rzTimer = 0;
    const onResize = () => {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => {
        if (dead) return;
        measure();
        for (const a of nodes) {
          a.x = clamp(a.x, 16, W - 16);
          a.y = clamp(a.y, 18, H - 18);
          if (a.el) a.el.setAttribute("transform", "translate(" + a.x + "," + a.y + ")");
        }
        reheat(0.05);
      }, 120);
    };
    window.addEventListener("resize", onResize);
    offs.push(() => window.removeEventListener("resize", onResize));

    const onKey = (e) => { if (e.key === "Escape") { clearSel(); hideTip(); } };
    window.addEventListener("keydown", onKey);
    offs.push(() => window.removeEventListener("keydown", onKey));

    /* ---------- boot ---------- */
    function start() {
      measure();
      setChip();
      sync(true);                  // catch-up: pull in whatever the session holds
      if (nodes.length) reheat(1); // empty canvas: stay idle until events arrive
    }
    function destroy() {
      dead = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clearTimeout(listTimer);
      while (offs.length) { try { offs.pop()(); } catch (e) { /* noop */ } }
    }
    return { start: start, destroy: destroy };
  }

  /* ---------- registration: one live instance at a time ---------- */
  let inst = null;

  CS.register({
    id: "swarm",
    num: 2,
    title: "Swarm",
    short: "Evidence & personas",
    render(mount) {
      if (inst) { try { inst.destroy(); } catch (e) { /* noop */ } inst = null; }
      inst = makeSwarm(mount);
      inst.start();
    },
  });
})();