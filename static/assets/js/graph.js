/* ============================================================
   CallCrowd — graph.js  ·  the middle "nodes" canvas

   Self-contained module (no d3, no CDN, vanilla JS):
     window.CSGraph = { mount(el, CS), destroy() }

   Faithful to the MiroFish §16.2 swarm mechanics, v4 (owner pass,
   GraphPanel.vue ground truth where noted):
     - hand-rolled force sim: velocityDecay .4, charge −600 (tuned up
       from MiroFish's −400, O(n²) fine ≤400), link springs
       150 + 50 × (count−1) (GraphPanel), forceCollide radius 50,
       forceCentre exact + forceX/Y .015 (dialled down from .04 so
       the cloud rests spread) — an airy cluster spanning ~60%+ of
       the pane, not a knot; all forces scale by the SAME alpha so
       the resting shape stays spread after cooldown
     - wheel zoom (scaleExtent 0.1–4) + background pan + node
       drag-pin (d3 fx/fy, alphaTarget(.3) while dragging, 3px
       click-vs-drag threshold)
     - FLUID MOTION: physics positions are never drawn directly;
       every frame renders a lerped position toward the sim
       (no single-frame jumps), reheat ramps eased over ~400ms,
       spawn scale-in 0→r with back-out 400ms staggered ≤15ms/node
       (cap 600ms; agent batches stagger across 1.5–2s with a brief
       halo), edges draw-on (dash-offset tween 500ms) on first
       appearance, alpha floor 0.002 with a very subtle breathing
       drift so the graph is never frozen
     - growth in BATCHES ≈ every 2 s; new nodes enter at phyllotaxis
       positions around the canvas origin (top-left) — the emergent
       corner-swarm-in artifact
     - flat 1.5px grey edges (#5a6b80 @55% on dark), curved
       multi-edge fans per repeated pair with MiroFish curvature
       (((k/(total−1)) − .5) × range × 2), cap ×11 (§16.1)
     - 10-colour entity palette assigned by order of first
       appearance, recomputed (but stable) on every update
     - personas render as hollow 6px rings (CS.color(segment))
     - ENTITY TYPES legend (bottom-left dark panel): palette slots
       + counts, agent-segment ring colours, collapsible chip,
       collapsed by default on phone width <520px
     - hover tooltip (dark pill, 13px): persona → latest stance
       reason (in character) or profile; topic/entity → the claim
     - click: persona → csgraph:node {nodeId, nodeType:"persona"};
       topic/entity → pinned label card by the node (type chip +
       claim + id, re-click/outside click dismisses) and the same
       event payload; "csgraph:hover" {nodeId} dispatched on hover
       changes (additive)
     - arguing-arcs layer (spec §16.6 upgrade B — our own design):
       quadratic arc between the two personas that most recently
       held opposing stances, 3px dot travelling 900ms
       easeInOutSine, arc fades 1.5s, ≤40 concurrent, staggered
     - live toast (breathing icon) → dismissible finished pill
     - round-N loader: concentric ripple rings until the round's
       first stance lands
     - highlights: node #E91E63 4px (+its edges 2.5px), edge
       #3498DB 3px, hover ring (dark-theme equivalent of #333 3px)
     - reduced motion: no arcs/pulses/spawn anim/draw-on, faster
       cool (alphaDecay .1), no breathing drift
     - pauses when document hidden; caches positions by id
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tunables (GraphPanel.vue ground truth + owner v4) ---------- */
  var BUILD_INTERVAL = 2000;   // one growth batch ≈ every 2 s
  var BATCH_CAP = 25;          // nodes flushed per batch (ladder-ish slice)
  var CHARGE = 400;            // d3 charge strength −400 (GraphPanel L472)
  var FORCE_CAP = 8;           // safety cap on per-pair repulsion (ours)
  var LINK_BASE = 150;         // link distance = 150 + 50 × (count−1)
  var LINK_PER_FAN = 50;
  var SPRING_GAIN = 0.35;      // soft-ish springs → the cloud rests spread
  var CENTER_PULL = 0.015;     // forceX/Y, dialled down from MiroFish .04
  var CENTER_SNAP = 1;         // forceCentre: exact translation, d3-style
  var COLLIDE_R = 50;          // forceCollide radius 50 → centres ≥100px
  var ZOOM_MIN = 0.1, ZOOM_MAX = 4;
  var DRAG_PX = 3;             // click vs drag threshold
  var VELOCITY_DECAY = 0.4;
  var SPEED_CAP = 12;          // px/tick max speed — no jitter or wall slam
  var ALPHA_MIN = 0.01;
  var ALPHA_FLOOR = 0.0008;    // hard rest — no drift after settle (owner ask)
  var RAMP_MS = 400;           // eased reheat ramp
  var SPAWN_MS = 400;          // scale-in 0→r, back-out
  var SPAWN_STAGGER = 15;      // ≤15 ms per node, general batches
  var SPAWN_STAGGER_CAP = 600;
  var AGENT_STAGGER_MIN = 1500;// persona batches stagger across 1.5–2 s
  var AGENT_STAGGER_MAX = 2000;
  var HALO_MS = 600;           // brief halo after a persona lands
  var EDGE_DRAW_MS = 500;      // dash-offset tween on first appearance
  var STANCE_MS = 400;         // ring recolour transition on stance flip
  var LABEL_ZOOM = 0.5;        // agent name labels fade out below this zoom
  var ARC_WINDOW = 6000;       // opposing-stance window (ms)
  var ARC_MAX = 40;
  var ARC_SPREAD = 1800;       // stagger batch arcs across this span
  var ARC_DOT_MS = 900;
  var ARC_FADE_MS = 1500;
  var PULSE_MS = 600;
  var MULT_CAP = 11;
  var NODE_CAP = 400;
  var NARROW = 520;            // legend collapsed by default under this

  var REDUCED = (function () {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  })();

  /* ---------- readability floors (owner addendum) ----------
     WCAG relative luminance check against the dark canvas
     (#0e1116 ≈ L 0.012). Palette slots below 3:1 are auto-brightened
     toward white once at load (result remembered, never recomputed
     per frame); edge grey / highlights / arcs get a 1.5:1 floor,
     alpha-composited over the canvas colour. */
  var CANVAS_RGB = [14, 17, 22];   /* #0e1116 */

  function hex2rgb(c) {
    c = String(c).replace("#", "");
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    return [parseInt(c.substr(0, 2), 16),
            parseInt(c.substr(2, 2), 16),
            parseInt(c.substr(4, 2), 16)];
  }
  function rgb2hex(r, g, b) {
    function h(v) { v = Math.round(clamp(v, 0, 255)).toString(16); return v.length < 2 ? "0" + v : v; }
    return "#" + h(r) + h(g) + h(b);
  }
  function relLum(rgb) {
    function lin(v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  }
  function contrast(a, b) {
    var l1 = relLum(a), l2 = relLum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function brighten(rgb, floor) {
    /* scale toward white (12 % per pass) until the floor passes or
       the colour is fully white; remembered result, not per-frame */
    var out = rgb, k = 0;
    while (contrast(out, CANVAS_RGB) < floor && k < 40) {
      out = [out[0] + (255 - out[0]) * 0.12,
             out[1] + (255 - out[1]) * 0.12,
             out[2] + (255 - out[2]) * 0.12];
      k++;
    }
    return out;
  }
  function compositeOver(rgba, bg) {
    var a = rgba[3] == null ? 1 : rgba[3];
    return [rgba[0] * a + bg[0] * (1 - a),
            rgba[1] * a + bg[1] * (1 - a),
            rgba[2] * a + bg[2] * (1 - a)];
  }
  function fitFloor(rgbaParts, floor) {
    /* returns an rgba string whose composite over the canvas reaches
       the floor (brightening the base colour, alpha preserved) */
    var rgb = rgbaParts.slice(0, 3), a = rgbaParts[3] == null ? 1 : rgbaParts[3];
    if (contrast(compositeOver(rgb.concat([a]), CANVAS_RGB), CANVAS_RGB) >= floor)
      return { rgb: rgb, a: a };
    var fixed = brighten(rgbaParts.slice(0, 3), floor);
    return { rgb: fixed, a: a };
  }
  function rgbaStr(fit) {
    return "rgba(" + Math.round(fit.rgb[0]) + "," + Math.round(fit.rgb[1]) + "," +
      Math.round(fit.rgb[2]) + "," + fit.a + ")";
  }

  var CANVAS_L = relLum(CANVAS_RGB);
  var PAL = ["#FFB224", "#4FC3F7", "#66BB6A", "#BA68C8", "#F06292",
             "#FFD54F", "#4DD0E1", "#E57373", "#7986CB", "#AED581"]
    .map(function (h2) { return rgb2hex.apply(null, brighten(hex2rgb(h2), 3)); });
  var EDGE_BASE = rgbaStr(fitFloor([90, 107, 128, 0.55], 1.5));
  var EDGE_SEL = rgb2hex.apply(null, brighten(hex2rgb("#3498DB"), 1.5));
  var EDGE_SEL_NODE = rgb2hex.apply(null, brighten(hex2rgb("#E91E63"), 1.5));
  var HOVER_RING = rgbaStr(fitFloor([214, 224, 234, 0.85], 1.5));
  var ARC_SUP = rgbaStr(fitFloor([39, 174, 96, 0.85], 1.5));
  var ARC_OPP = rgbaStr(fitFloor([233, 114, 76, 0.85], 1.5));
  /* stance semantics (owner addendum #4): ring colour = for / against */
  var STANCE_SUP = rgb2hex.apply(null, brighten(hex2rgb("#22c55e"), 1.5));
  var STANCE_OPP = rgb2hex.apply(null, brighten(hex2rgb("#ef4444"), 1.5));
  var STANCE_NEU = rgb2hex.apply(null, brighten(hex2rgb("#94a3b8"), 1.5));

  function lerpHex(a, b, t) {
    var ca = hex2rgb(a), cb = hex2rgb(b);
    return rgb2hex(ca[0] + (cb[0] - ca[0]) * t,
                   ca[1] + (cb[1] - ca[1]) * t,
                   ca[2] + (cb[2] - ca[2]) * t);
  }

  function hash(s) {
    var h = 0;
    s = String(s == null ? "" : s);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function easeIO(t) { return 0.5 - Math.cos(Math.PI * t) / 2; } /* easeInOutSine */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function backOut(t) { return t >= 1 ? 1 : (function () { var s = 1.70158, u = t - 1; return u * u * ((s + 1) * u + s) + 1; })(); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function trunc(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s;
  }

  var STOP = {};
  "the and for not but was has its into over under near with from have been were their there about which would could should after before because very just also some more most they them then than when what your you are this that said says will been being while whose each other".split(" ").forEach(function (w) { STOP[w] = 1; });

  function keywords(text) {
    var out = [], seen = {};
    String(text || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ")
      .split(/\s+/).forEach(function (w) {
        if (w.length < 4 || STOP[w] || seen[w]) return;
        seen[w] = 1; out.push(w);
      });
    return out;
  }

  var ICON =
    '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="#4CAF50" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="9" cy="4.2" r="2.2"></circle><circle cx="4.4" cy="12.6" r="2.2"></circle><circle cx="13.6" cy="12.6" r="2.2"></circle>' +
    '<path d="M9 6.5 5.4 10.9M9 6.5l3.6 4.4M6.6 12.6h4.8"></path></svg>';

  var active = null;   /* disposer of the currently mounted instance */

  /* ============================================================ */
  function mount(el, CS) {
    if (!el) return;
    if (active) active();

    var destroyed = false;
    var offs = [];
    var timeoutIds = [];
    var intervalId = null;
    var rafId = 0;
    var hidden = document.hidden;

    var root = document.createElement("div");
    root.className = "csg";
    root.innerHTML =
      '<canvas class="csg-canvas"></canvas>' +
      '<div class="csg-empty" aria-hidden="true"><span class="csg-empty-mark">❖</span>' +
      '<span class="csg-empty-line">waiting for the swarm to convene</span></div>' +
      '<div class="csg-toast csg-toast-live" hidden>' +
      '<span class="csg-toast-ico">' + ICON + '</span>' +
      '<span class="csg-toast-txt">real-time updating</span></div>' +
      '<div class="csg-toast csg-toast-done" hidden>' +
      '<span class="csg-toast-ico csg-toast-ico-static">' + ICON + '</span>' +
      '<span class="csg-toast-txt">still processing some content&hellip;</span>' +
      '<button class="csg-toast-x" type="button" aria-label="Dismiss">&times;</button></div>' +
      '<div class="csg-loader" hidden><span class="csg-ring"></span><span class="csg-ring"></span>' +
      '<span class="csg-ring"></span><span class="csg-loader-label"></span></div>' +
      '<div class="csg-legend" hidden></div>' +
      '<button class="csg-legend-chip" type="button" aria-label="Toggle legend">legend</button>' +
      '<div class="csg-tip" aria-hidden="true"></div>' +
      '<div class="csg-pin" hidden></div>';
    el.appendChild(root);
    root.classList.toggle("csg-still", REDUCED);

    var canvas = root.querySelector(".csg-canvas");
    var ctx = canvas.getContext("2d");
    var toastLive = root.querySelector(".csg-toast-live");
    var toastDone = root.querySelector(".csg-toast-done");
    var loader = root.querySelector(".csg-loader");
    var loaderLabel = root.querySelector(".csg-loader-label");
    var legend = root.querySelector(".csg-legend");
    var legendChip = root.querySelector(".csg-legend-chip");
    var tip = root.querySelector(".csg-tip");
    var pin = root.querySelector(".csg-pin");

    /* ---------- graph state ---------- */
    var nodes = [];                 /* {id,kind,type,r,color,x,y,rx,ry,vx,vy,
                                       spawnAt,label,name,pulseAt} */
    var nodeById = new Map();
    var pairs = new Map();          /* "a|b" → {key,aId,bId,count,want,born} */
    var linkList = [];              /* rebuilt per flush: {p,a,b,k} */
    var cache = new Map();          /* id → {x,y} — refreshed every tick */
    var pendingNodes = [], pendingEdges = [], pendingArcs = [];
    var topicIds = [];              /* evidence-derived topic node ids */
    var typeSlot = new Map();       /* entity type → palette slot */
    var typeColor = new Map();      /* entity type → colour (recomputed per update) */
    var phyIdx = 0;                 /* phyllotaxis index (d3 appends at end) */
    var arcs = [];                  /* live arguing arcs */
    var arcsTotal = 0, pulsesTotal = 0;
    var lastStance = { support: null, oppose: null };
    var selectedNode = null, selectedEdge = null;
    var hoverNode = null, lastHoverSent = null;
    var pinnedNode = null;          /* topic/entity pinned label card */
    var legendTouched = false;      /* user override of the auto state */
    var alpha = 0, alphaGoal = ALPHA_FLOOR;
    var alphaDecay = REDUCED ? 0.1 : 0.02;
    var rampFrom = 0, rampT0 = -1;  /* eased reheat ramp */
    var firstRender = true;
    var lastFrame = 0, lastTick = 0;
    var phase = "idle";             /* idle | scout | debate | done */
    var pendingRound = null;        /* round awaiting its first stance */
    var mx = -9999, my = -9999;     /* pointer (CSS px) */
    var cssW = 10, cssH = 10;
    var maxExtent = 0;              /* widest the cloud has ever been (%) */
    var dpr = 1;
    var view = { k: 1, tx: 0, ty: 0 };   /* wheel-zoom / pan viewport */
    var userView = false;           /* user zoomed/panned → stop auto-fit */

    /* ---------- sizes ---------- */
    function resize() {
      var r = root.getBoundingClientRect();
      cssW = Math.max(10, r.width);
      cssH = Math.max(10, r.height);
      dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      /* legend auto-state: collapsed by default on phone width */
      if (!legendTouched) root.classList.toggle("csg-legend-open", cssW >= NARROW);
    }
    var ro = null;
    try { ro = new ResizeObserver(resize); ro.observe(root); } catch (e) { /* noop */ }
    resize();

    /* ---------- palette ---------- */
    function colorFor(type) {
      if (typeColor.has(type)) return typeColor.get(type);
      if (!typeSlot.has(type)) typeSlot.set(type, typeSlot.size);
      var c = PAL[typeSlot.get(type) % PAL.length];
      typeColor.set(type, c);
      return c;
    }

    /* ---------- node / edge application ---------- */
    function appendToSim(s, delay) {
      if (!s || nodeById.has(s.id) || nodes.length >= NODE_CAP) return false;
      /* d3-force: unpositioned nodes start on a phyllotaxis spiral around
         the SVG origin (0,0 = canvas top-left) — the corner-swarm-in */
      var x = 10 * Math.sqrt(0.5 + phyIdx);
      var ang = phyIdx * Math.PI * (3 - Math.sqrt(5));
      phyIdx++;
      var n = {
        id: s.id, kind: s.kind || "topic", type: s.type || "entity",
        r: s.r || 8, color: s.color || colorFor(s.type || "entity"),
        label: s.label || "", name: s.name || "",
        colorFrom: s.colorFrom || null, colorTo: s.colorTo || null,
        colorAt: s.colorAt || null, segColor: s.segColor || null,
        x: Math.cos(ang) * x, y: Math.sin(ang) * x, vx: 0, vy: 0,
        /* spawn anim r 0→r, back-out 400 ms, staggered by batch */
        spawnAt: REDUCED ? 0 : performance.now() + (delay || 0),
      };
      n.rx = n.x; n.ry = n.y;       /* interpolated render position */
      nodes.push(n); nodeById.set(n.id, n);
      return true;
    }

    function addEdge(aId, bId) {
      if (!aId || !bId || aId === bId) return false;
      var key = aId < bId ? aId + "|" + bId : bId + "|" + aId;
      var p = pairs.get(key);
      if (p) { if (p.count < MULT_CAP) p.count++; return true; }
      pairs.set(key, {
        key: key, aId: aId, bId: bId, count: 1, born: null, want: null,
      });
      return true;
    }
    /* d3-exact: link distance grows with multiplicity (fan spread) */
    function wantOf(p) { return LINK_BASE + LINK_PER_FAN * (p.count - 1); }

    /* edges draw-on after BOTH endpoints have landed (agent stagger) */
    function assignBorn(p) {
      var t = performance.now();
      var a = nodeById.get(p.aId), b = nodeById.get(p.bId);
      if (a && a.spawnAt != null && a.spawnAt + SPAWN_MS > t) t = a.spawnAt + SPAWN_MS;
      if (b && b.spawnAt != null && b.spawnAt + SPAWN_MS > t) t = Math.max(t, b.spawnAt + SPAWN_MS);
      p.born = REDUCED ? performance.now() - EDGE_DRAW_MS : t + 60;
    }

    function rebuildLinks() {
      var deg = new Map();
      var b = Math.max;
      linkList = [];
      pairs.forEach(function (p) {
        var a = nodeById.get(p.aId), c = nodeById.get(p.bId);
        if (!a || !c) return;      /* draw once both ends exist */
        deg.set(a.id, (deg.get(a.id) || 0) + p.count);
        deg.set(c.id, (deg.get(c.id) || 0) + p.count);
        linkList.push({ p: p, a: a, b: c, k: 0 });
        if (p.born == null) assignBorn(p);
      });
      for (var i = 0; i < linkList.length; i++) {
        var L = linkList[i];
        L.p.want = wantOf(L.p);
        var dmin = Math.min(deg.get(L.a.id) || 1, deg.get(L.b.id) || 1);
        L.k = clamp(1 / Math.max(1, dmin), 0.02, 1);
      }
    }

    /* ---------- growth builders (scout + debate) ---------- */
    function addEvidence(card) {
      if (!card || !card.id) return;
      var id = "ev:" + card.id;
      var h = hash(id);
      var claim = card.claim || card.quote || card.title || card.body || "";
      if (!nodeById.has(id) && !pendingHas(id)) {
        pendingNodes.push({ id: id, kind: "topic", type: card.type || "topic",
          r: 7 + (h % 3), label: claim });
        topicIds.push(id);
      }
      /* chain the new topic to the previous one + one earlier sibling */
      if (topicIds.length > 1) queueEdge(id, topicIds[topicIds.length - 2]);
      if (topicIds.length > 3) queueEdge(id, topicIds[(h >>> 3) % (topicIds.length - 2)]);
      /* phantom "entity" nodes per topic, derived from claim words (1–3) */
      var words = keywords(claim);
      var want = 1 + (h % 3);
      for (var w = 0; w < Math.min(want, words.length); w++) {
        var word = words[(h + w * 7 + 11) % words.length];
        var wid = "w:" + word;
        queueEdge(id, wid);      /* edge auto-creates the word node */
        if (!pendingHas(wid) && !nodeById.has(wid))
          pendingNodes.push({
            id: wid, kind: "phantom", type: "entity",
            r: 6 + (hash(wid) % 2), label: "entity \u00b7 " + word,
          });
      }
      function pendingHas(nid) {
        for (var i = 0; i < pendingNodes.length; i++) if (pendingNodes[i].id === nid) return true;
        return false;
      }
      function queueEdge(a, bb) {
        /* ensure the far end exists (or is queued) before the edge */
        if (!nodeById.has(bb)) {
          var found = false;
          for (var i = 0; i < pendingNodes.length; i++) if (pendingNodes[i].id === bb) { found = true; break; }
          if (!found) {
            var wh = hash(bb);
            pendingNodes.push({ id: bb, kind: /^w:/.test(bb) ? "phantom" : "topic",
              type: /^w:/.test(bb) ? "entity" : "topic",
              r: /^w:/.test(bb) ? 6 + (wh % 2) : 7 + (wh % 3),
              label: /^w:/.test(bb) ? "entity \u00b7 " + bb.slice(2) : "" });
            if (!/^w:/.test(bb)) topicIds.push(bb);
          }
        }
        pendingEdges.push([a, bb]);
      }
    }

    function ensurePersona(pid, segment) {
      if (!pid) return;
      var id = "pe:" + pid;
      if (nodeById.has(id)) return;
      colorFor("personas");  /* reserve a palette slot like any type */
      pendingNodes.push({
        id: id, kind: "persona", type: segment || pid,
        r: 6, color: colorPersona(id, segment), name: pid,
      });
    }
    function colorPersona(id, segment) {
      var c = null;
      try {
        if (CS && typeof CS.color === "function")
          c = CS.color(segment || id);   /* their segment palette slot */
      } catch (e) { /* noop */ }
      /* readability floor: persona rings must clear 3:1 on the canvas */
      return rgb2hex.apply(null, brighten(hex2rgb(c || PAL[hash(id) % PAL.length]), 3));
    }

    function addPersona(p) {
      if (!p || !p.id) return;
      ensurePersona(p.id, p.segment);
      var id = "pe:" + p.id;
      /* profile as the pre-debate tooltip fallback */
      var n = nodeById.get(id), q = null, i;
      for (i = 0; i < pendingNodes.length; i++) if (pendingNodes[i].id === id) { q = pendingNodes[i]; break; }
      var prof = p.profile || "";
      if (q && prof && !q.label) q.label = prof;
      if (n && prof) n.label = prof;
      if (q && p.name) q.name = p.name;
      if (n && p.name) n.name = p.name;
      /* persona ↔ 2 topics (hash-chosen, stable) — the memory edges */
      var h = hash(id);
      if (topicIds.length) {
        pendingEdges.push([id, topicIds[h % topicIds.length]]);
        if (topicIds.length > 2)
          pendingEdges.push([id, topicIds[(h >>> 5) % topicIds.length]]);
      }
    }

    function pickTopic(pid) {
      if (!topicIds.length) return null;
      return topicIds[hash(pid) % topicIds.length];
    }

    function onDebateRound(d) {
      var n = d && d.n;
      if (n != null) {
        phase = "debate";
        pendingRound = n;
        loaderLabel.textContent = "ROUND " + n + " — THE SWARM IS DEBATING\u2026";
        loader.hidden = false;
        setToast("live", "memory updating in real-time");
      }
    }

    function firstStanceOfRound(round) {
      return pendingRound != null && round === pendingRound;
    }

    function onStance(d) {
      var pid = d && d.persona_id;
      var round = d.round;
      if (!pid) return;
      ensurePersona(pid, d.segment);
      /* latest stance reason → tooltip (in character) */
      var pn = nodeById.get("pe:" + pid), pq = null, i;
      for (i = 0; i < pendingNodes.length; i++) if (pendingNodes[i].id === "pe:" + pid) { pq = pendingNodes[i]; break; }
      if (d.reason) {
        if (pn) pn.label = d.reason;
        else if (pq) pq.label = d.reason;
      }
      /* addendum #4: stance colour on the RING (animated ~400ms flip) */
      var stColor = d.stance === "oppose" ? STANCE_OPP
                  : d.stance === "support" ? STANCE_SUP : STANCE_NEU;
      var tgts = [pn, pq];
      for (i = 0; i < 2; i++) {
        var tgt = tgts[i];
        if (!tgt || tgt.color === stColor) continue;
        tgt.colorFrom = tgt.color;
        if (tgt.segColor == null) tgt.segColor = tgt.color;
        tgt.colorTo = stColor;
        tgt.colorAt = REDUCED ? 0 : performance.now();
        tgt.color = stColor;
      }
      /* persona display name (never fall back to ids on the canvas) */
      if (d.persona_name) {
        if (pn) pn.name = d.persona_name;
        if (pq) pq.name = d.persona_name;
      }
      /* densify: persona ↔ topic edge per stance */
      var t = pickTopic("pe:" + pid + "|" + (round || 0));
      if (t) pendingEdges.push(["pe:" + pid, t]);
      /* clear the round loader on the round's FIRST stance */
      if (firstStanceOfRound(round)) {
        pendingRound = null;
        loader.hidden = true;
      }
      if (REDUCED) return;
      /* arguing arcs (§16.6 upgrade B) — between the two personas that
         most recently held opposing stances, within the window */
      var cls = d.stance === "oppose" ? "oppose"
              : d.stance === "support" ? "support" : null;
      if (cls) {
        var now = performance.now();
        var prev = lastStance[cls === "oppose" ? "support" : "oppose"];
        if (prev && now - prev.t < ARC_WINDOW && prev.pid !== pid)
          pendingArcs.push({ aId: "pe:" + pid, bId: "pe:" + prev.pid,
            color: cls === "oppose" ? ARC_OPP : ARC_SUP });
        lastStance[cls] = { pid: pid, t: now };
      }
      /* agent ring pulse 1 → 1.6 → 1 on acting */
      if (pn && !REDUCED) { pn.pulseAt = performance.now(); pulsesTotal++; }
    }

    function onCamp(d) {
      var ids = (d && d.member_ids) || [];
      if (!ids.length) return;
      ids.forEach(function (id) { ensurePersona(id, null); });
      /* camp clustering: spokes from the first member (keeps edges sane) */
      var hub = "pe:" + ids[0];
      for (var i = 1; i < ids.length; i++) pendingEdges.push([hub, "pe:" + ids[i]]);
    }

    /* ---------- batch flush (≈ every 2 s) ---------- */
    function later(fn, ms) {
      if (destroyed) return;
      var t = setTimeout(function () {
        var i = timeoutIds.indexOf(t);
        if (i >= 0) timeoutIds.splice(i, 1);
        fn();
      }, ms);
      if (timeoutIds.length > 400) timeoutIds.shift();  /* prune safety */
      timeoutIds.push(t);
    }

    function flushBatch() {
      if (destroyed) return;
      /* nodes: a ladder-ish slice per batch, spawn-staggered */
      var take = pendingNodes.splice(0, Math.min(pendingNodes.length, BATCH_CAP));
      var added = 0, personas = 0, i;
      for (i = 0; i < take.length; i++) if (take[i].kind === "persona") personas++;
      /* stagger: agent batches sweep in over 1.5–2 s (fluid spawn),
         ordinary batches ≤15 ms/node capped at 600 ms */
      var span = personas >= 5
        ? clamp(personas * 60, AGENT_STAGGER_MIN, AGENT_STAGGER_MAX)
        : Math.min(SPAWN_STAGGER_CAP, take.length * SPAWN_STAGGER);
      for (i = 0; i < take.length; i++)
        if (appendToSim(take[i], Math.round(span * i / Math.max(1, take.length)))) added++;
      /* edges: the whole pending set (multiplicity grows the fans) */
      var pe = pendingEdges.splice(0, pendingEdges.length);
      var newPairs = 0;
      for (var j = 0; j < pe.length; j++) if (addEdge(pe[j][0], pe[j][1])) newPairs++;
      rebuildLinks();
      /* schedule this batch's arguing arcs across the 2 s window */
      var pa = pendingArcs.splice(0, pendingArcs.length);
      for (var k = 0; k < pa.length; k++) {
        (function (arc, delay) { later(function () { spawnArc(arc); }, delay); })
          (pa[k], Math.round(Math.random() * ARC_SPREAD));
      }
      if (!added && !newPairs) return;    /* identical snapshot → no reheat */
      reheat(added);
      root.classList.toggle("csg-has", nodes.length > 0);
      buildLegend();
    }

    function reheat(added) {
      var target;
      if (firstRender) {
        /* alpha 1 on first render — unless every node already had a
           cached position (restore case) → near-zero reheat */
        var hasUncached = false;
        for (var i = 0; i < nodes.length; i++) if (nodes[i].fresh !== false) { hasUncached = true; break; }
        target = hasUncached ? 1 : ALPHA_FLOOR;
        firstRender = false;
      } else {
        target = 0.3;                      /* gentle reheat on each growth burst */
      }
      if (added === 0 && target == null) target = ALPHA_FLOOR;
      /* eased ramp (~400 ms) — handled in tick() toward alphaGoal */
      if (REDUCED) {
        alphaGoal = Math.max(alphaGoal, target);
        alpha = alphaGoal;
      } else {
        rampFrom = alpha;
        rampT0 = performance.now();
        alphaGoal = Math.max(alphaGoal, target);
      }
      alphaDecay = REDUCED ? 0.1 : (nodes.length > 150 ? 0.04 : 0.02);
    }

    function spawnArc(arc) {
      if (destroyed || REDUCED) return;
      if (arcs.length >= ARC_MAX) arcs.shift();   /* ≤40 concurrent */
      arc.t0 = performance.now();
      arcs.push(arc);
      arcsTotal++;
    }

    /* ---------- physics (hand-rolled, d3-flavoured) ---------- */
    function tick(now) {
      /* alpha eases toward its (decaying) goal — reheat never jumps */
      if (!lastTick) lastTick = now;
      var dt = Math.min(100, Math.max(4, now - lastTick));
      lastTick = now;
      alphaGoal *= (1 - alphaDecay);
      /* alphaTarget(.3) semantics while a node is dragged (GraphPanel) */
      if (dragNode) alphaGoal = Math.max(alphaGoal, 0.3);
      if (alphaGoal < ALPHA_FLOOR) alphaGoal = REDUCED ? 0 : ALPHA_FLOOR;
      if (rampT0 >= 0) {
        /* explicit eased ramp over ~400 ms after a reheat */
        var rt = clamp((now - rampT0) / RAMP_MS, 0, 1);
        alpha = rampFrom + (alphaGoal - rampFrom) * easeOutCubic(rt);
        if (rt >= 1) rampT0 = -1;
      } else {
        alpha += (alphaGoal - alpha) * (1 - Math.exp(-dt / 130));
      }
      var a2 = alpha * alpha;
      void a2;
      /* owner: nodes must be STEADY once settled — no breathing drift,
         so hovering and clicking is easy. Arcs/pulses still animate. */
      var aEff = (alpha < ALPHA_MIN) ? 0 : alpha;
      /* every force scales by the SAME alpha (d3 semantics) — the resting
         shape stays spread no matter how much the sim has cooled */
      var n = nodes.length, i, j, ni, nj, dx, dy, d2, d, f, fx, fy;

      /* charge + collision — O(n²), fine ≤ 400
         charge strength −400, collide radius 50 (GraphPanel.vue) */
      for (i = 0; i < n; i++) {
        ni = nodes[i];
        for (j = i + 1; j < n; j++) {
          nj = nodes[j];
          dx = nj.x - ni.x; dy = nj.y - ni.y;
          d2 = dx * dx + dy * dy;
          if (d2 < 0.0001) { dx = 0.05; dy = 0.05; d2 = 0.005; }  /* jitter apart stacked nodes */
          if (d2 < 25) d2 = 25;
          d = Math.sqrt(d2);
          /* charge repulsion */
          f = CHARGE * aEff / d2;
          if (f > FORCE_CAP) f = FORCE_CAP;
          fx = dx / d * f; fy = dy / d * f;
          ni.vx -= fx; ni.vy -= fy;
          nj.vx += fx; nj.vy += fy;
          /* forceCollide 50: fixed collide radius, positional resolve */
          var minD = COLLIDE_R * 2;
          if (d < minD && d > 0.001) {
            var push = (minD - d) * 0.5 / d;
            var px = dx * push, py = dy * push;
            ni.x -= px; ni.y -= py;
            nj.x += px; nj.y += py;
          }
        }
      }
      /* link springs — distance = 150 + 50 × (count−1) */
      for (i = 0; i < linkList.length; i++) {
        var L = linkList[i], a = L.a, b = L.b;
        dx = b.x - a.x; dy = b.y - a.y;
        d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        f = (d - L.p.want) / d * L.k * SPRING_GAIN * aEff;
        fx = dx * f; fy = dy * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      /* forceCentre: exact translation of the mean to the pane centre
         (d3 forceCenter semantics) — smooth enough via render lerp */
      var cx = cssW / 2, cy = cssH / 2;
      if (n) {
        var sxm = 0, sym = 0;
        for (i = 0; i < n; i++) { sxm += nodes[i].x; sym += nodes[i].y; }
        var ox = (cx - sxm / n) * CENTER_SNAP, oy = (cy - sym / n) * CENTER_SNAP;
        if (ox || oy) {
          for (i = 0; i < n; i++) { nodes[i].x += ox; nodes[i].y += oy; }
        }
      }
      /* forceX / forceY to centre — strength .04 */
      for (i = 0; i < n; i++) {
        ni = nodes[i];
        if (ni.fx != null && ni.fy != null) { ni.vx += 0; ni.vy += 0; }
        else {
          ni.vx += (cx - ni.x) * CENTER_PULL * aEff;
          ni.vy += (cy - ni.y) * CENTER_PULL * aEff;
        }
      }
      /* integrate + refresh the position cache every tick */
      var decay = 1 - VELOCITY_DECAY;
      var marginX = cssW * 0.07, marginY = cssH * 0.07;
      var rightX = cssW - marginX, botY = cssH - marginY;
      for (i = 0; i < n; i++) {
        ni = nodes[i];
        ni.vx *= decay; ni.vy *= decay;
        var sp = ni.vx * ni.vx + ni.vy * ni.vy;
        if (sp > SPEED_CAP * SPEED_CAP) {   /* fluid, never violent */
          var cf = SPEED_CAP / Math.sqrt(sp);
          ni.vx *= cf; ni.vy *= cf;
        }
        /* soft containment — physics space stays bounded; the VIEW
           (auto-fit) maps the cloud into the pane */
        if (ni.x < marginX) ni.vx += (marginX - ni.x) * 0.03;
        else if (ni.x > rightX) ni.vx -= (ni.x - rightX) * 0.03;
        if (ni.y < marginY) ni.vy += (marginY - ni.y) * 0.03;
        else if (ni.y > botY) ni.vy -= (ni.y - botY) * 0.03;
        /* d3 fx/fy pinning while dragging a node */
        if (ni.fx != null) { ni.x = ni.fx; ni.vx = 0; }
        else ni.x += ni.vx;
        if (ni.fy != null) { ni.y = ni.fy; ni.vy = 0; }
        else ni.y += ni.vy;
        cache.set(ni.id, { x: ni.x, y: ni.y });
      }
      if (REDUCED && alpha <= ALPHA_MIN) alpha = 0;
    }

    /* ---------- render interpolation (fluid: no jumps) ---------- */
    function interp(now, dtMs) {
      var k = 1 - Math.exp(-dtMs / 60);   /* time-normalised smooth */
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        nd.rx += (nd.x - nd.rx) * k;
        nd.ry += (nd.y - nd.ry) * k;
      }
    }

    function spawnScale(n, now) {
      if (n.spawnAt == null || REDUCED) return 1;
      var t = (now - n.spawnAt) / SPAWN_MS;
      if (t <= 0) return 0;      /* not spawned yet — invisible */
      if (t >= 1) return 1;
      return backOut(t);
    }

    /* ---------- drawing ---------- */
    function nodePulse(n, now) {
      if (!n.pulseAt || REDUCED) return 1;
      var t = (now - n.pulseAt) / PULSE_MS;
      if (t >= 1) { n.pulseAt = 0; return 1; }
      return 1 + 0.6 * Math.sin(Math.PI * t);   /* 1 → 1.6 → 1 */
    }

    /* stance ring colour with the ~400ms animated flip */
    function ringColorNow(nd, now) {
      if (nd.colorAt == null || nd.colorTo == null) return nd.color;
      var t = (now - nd.colorAt) / STANCE_MS;
      if (t >= 1) { nd.colorAt = null; return nd.color; }
      return lerpHex(nd.colorFrom || nd.color, nd.colorTo, easeIO(clamp(t, 0, 1)));
    }

    function edgeStyle(p, now) {
      if (p.key === selectedEdge) return [EDGE_SEL, 3];
      if (selectedNode && (p.aId === selectedNode || p.bId === selectedNode))
        return [EDGE_SEL_NODE, 2.5];
      return [EDGE_BASE, 1.5];
    }
    /* MiroFish fan curvature: ((idx/(total−1)) − .5) × range × 2 */
    var FAN_RANGE = 0.3;
    function fanCur(idx, total) {
      if (total < 2) return 0;
      return ((idx / (total - 1)) - 0.5) * FAN_RANGE * 2;
    }

    function quadPoint(x0, y0, cx, cy, x1, y1, t) {
      var u = 1 - t;
      return [u * u * x0 + 2 * u * t * cx + t * t * x1,
              u * u * y0 + 2 * u * t * cy + t * t * y1];
    }

    function drawArcPath(ax, ay, bx, by) {
      var mx2 = (ax + bx) / 2, my2 = (ay + by) / 2;
      var dx = bx - ax, dy = by - ay;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var bow = dist * 0.22;
      var cxp = mx2 - dy / dist * bow, cyp = my2 + dx / dist * bow;
      return [cxp, cyp, dist];
    }

    function draw(now) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      /* wheel-zoom / pan viewport: physics space → screen space */
      ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.tx, dpr * view.ty);
      ctx.lineCap = "round";
      var i, L;

      /* edges — flat 1.5px grey; curved fans per repeated pair
         (MiroFish curvature); draw-on dash tween on first appearance */
      for (i = 0; i < linkList.length; i++) {
        L = linkList[i];
        if (L.a.rx == null || L.b.rx == null) continue;
        var born = L.p.born == null ? 0 : L.p.born;
        if (now < born) continue;                    /* source not landed yet */
        var dt2 = (now - born) / EDGE_DRAW_MS;
        var drawOn = !REDUCED && dt2 < 1;
        var st = edgeStyle(L.p, now);
        var ax = L.a.rx, ay = L.a.ry, bx = L.b.rx, by = L.b.ry;
        var straightLen = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
        var count = L.p.count;
        for (var k = 0; k < count; k++) {
          var cur = fanCur(k, count);
          ctx.beginPath();
          if (cur === 0) {
            ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
            L._geom = [ax, ay, ax, ay, bx, by];
          } else {
            var pmx = (ax + bx) / 2, pmy = (ay + by) / 2;
            var pdx = bx - ax, pdy = by - ay;
            var pd = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
            var off = cur * pd;
            var cxp = pmx - pdy / pd * off, cyp = pmy + pdx / pd * off;
            ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cxp, cyp, bx, by);
            L._geom = [ax, ay, cxp, cyp, bx, by];
          }
          if (drawOn) {
            var dl = straightLen + 110;
            var tt = easeIO(clamp(dt2, 0, 1));
            ctx.setLineDash([dl, dl]);
            ctx.lineDashOffset = dl * (1 - tt);
          }
          ctx.strokeStyle = st[0]; ctx.lineWidth = st[1] / view.k;
          ctx.stroke();
          if (drawOn) { ctx.setLineDash([]); ctx.lineDashOffset = 0; }
        }
      }

      /* arguing arcs layer (above links) */
      for (i = arcs.length - 1; i >= 0; i--) {
        var arc = arcs[i];
        var age = now - arc.t0;
        var life = ARC_DOT_MS + ARC_FADE_MS;
        if (age > life) { arcs.splice(i, 1); continue; }
        var a = nodeById.get(arc.aId), b = nodeById.get(arc.bId);
        var ax2, ay2, bx2, by2;
        if (a && a.rx != null) { ax2 = a.rx; ay2 = a.ry; } else {
          ax2 = cssW / 2; ay2 = cssH / 2;
        }
        if (b && b.rx != null) { bx2 = b.rx; by2 = b.ry; } else {
          bx2 = cssW / 2 + 40; by2 = cssH / 2 - 40;
        }
        var g2 = drawArcPath(ax2, ay2, bx2, by2);
        var op = age < ARC_DOT_MS ? 0.9 : Math.max(0, 0.9 * (1 - (age - ARC_DOT_MS) / ARC_FADE_MS));
        ctx.beginPath();
        ctx.moveTo(ax2, ay2);
        ctx.quadraticCurveTo(g2[0], g2[1], bx2, by2);
        ctx.strokeStyle = arc.color.replace(/[\d.]+\)$/, op.toFixed(2) + ")");
        ctx.lineWidth = 1.5 / view.k;
        ctx.stroke();
        /* 3px dot travelling the arc, 900ms easeInOutSine */
        if (age < ARC_DOT_MS) {
          var t = easeIO(age / ARC_DOT_MS);
          var pt = quadPoint(ax2, ay2, g2[0], g2[1], bx2, by2, t);
          ctx.beginPath();
          ctx.arc(pt[0], pt[1], 3 / view.k, 0, Math.PI * 2);
          ctx.fillStyle = arc.color; ctx.fill();
        }
      }

      /* nodes — rendered at interpolated positions, spawn scale-in */
      for (i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        if (nd.rx == null) continue;
        var s0 = spawnScale(nd, now);
        if (s0 <= 0) continue;                       /* pre-spawn: hidden */
        var s = s0 * nodePulse(nd, now);
        var r = nd.r * s;
        /* brief spawn halo on persona batches */
        var haloAge = nd.spawnAt == null ? 1e9 : now - nd.spawnAt - SPAWN_MS;
        if (!REDUCED && haloAge >= 0 && haloAge < HALO_MS &&
            (nd.kind === "persona" || s0 < 1)) {
          var ht = haloAge / HALO_MS;
          ctx.beginPath();
          ctx.arc(nd.rx, nd.ry, r + 4 + ht * 14, 0, Math.PI * 2);
          ctx.strokeStyle = nd.color;
          ctx.globalAlpha = 0.45 * (1 - ht);
          ctx.lineWidth = 1.5 / view.k;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (nd.kind === "persona") {
          /* hollow ring — segment colour before debate, then the
             stance colour (green/red/grey) with an eased flip */
          ctx.beginPath();
          ctx.arc(nd.rx, nd.ry, r, 0, Math.PI * 2);
          ctx.strokeStyle = ringColorNow(nd, now);
          ctx.lineWidth = (2 * s) / view.k;
          ctx.stroke();
          /* addendum #4: always-on agent name label under the ring;
             fades out below zoom .5; entity/phantom keep hover-only */
          var la = REDUCED ? (view.k >= LABEL_ZOOM ? 1 : 0)
                           : clamp(view.k / LABEL_ZOOM, 0, 1);
          if (la > 0.05 && s > 0.5) {
            ctx.globalAlpha = 0.65 * la;
            ctx.fillStyle = "#dfe7ee";
            ctx.textAlign = "center";
            ctx.font = (11 / view.k) + 'px "Space Grotesk", system-ui, sans-serif';
            ctx.fillText(nd.name || nd.type, nd.rx, nd.ry + r + 13 / view.k);
            ctx.globalAlpha = 1;
          }
        } else {
          /* MiroFish look: type-colour fill + panel-white stroke */
          ctx.beginPath();
          ctx.arc(nd.rx, nd.ry, r, 0, Math.PI * 2);
          ctx.fillStyle = nd.color; ctx.fill();
          ctx.lineWidth = 2.5 / view.k;
          ctx.strokeStyle = "rgba(232,237,244,0.85)";
          ctx.stroke();
        }
        if (nd.id === selectedNode) {
          ctx.beginPath();
          ctx.arc(nd.rx, nd.ry, r + 2.5, 0, Math.PI * 2);
          ctx.strokeStyle = EDGE_SEL_NODE; ctx.lineWidth = 4 / view.k; ctx.stroke();
        } else if (nd.id === hoverNode) {
          ctx.beginPath();
          ctx.arc(nd.rx, nd.ry, r + 2, 0, Math.PI * 2);
          ctx.strokeStyle = HOVER_RING; ctx.lineWidth = 3 / view.k; ctx.stroke();
        }
      }
    }

    /* ---------- auto-fit (zoom-to-fit like MiroFish's initial view) ----------
       Physics lives in its own space; the VIEW maps the cloud's bounding
       box onto the pane at ~72% coverage, easing smoothly every frame.
       Any wheel/pan/drag by the user hands the view over for good. */
    function autoFit(dtMs) {
      var i, nd, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, pad = 0;
      for (i = 0; i < nodes.length; i++) {
        nd = nodes[i];
        if (nd.rx == null) continue;
        if (nd.rx < x0) x0 = nd.rx;
        if (nd.rx > x1) x1 = nd.rx;
        if (nd.ry < y0) y0 = nd.ry;
        if (nd.ry > y1) y1 = nd.ry;
        if (nd.r > pad) pad = nd.r;
      }
      pad += 14;
      var bw = Math.max(60, x1 - x0 + pad * 2);
      var bh = Math.max(60, y1 - y0 + pad * 2);
      /* the roomier dimension maps to ~72%; the other follows (capped —
         a wide pane + square cloud must still cover ≥60% width) */
      var kT = clamp(0.72 * Math.max(cssW / bw, cssH / bh), ZOOM_MIN, 1.25);
      var f = 1 - Math.exp(-dtMs / 260);
      view.k += (kT - view.k) * f;
      var txT = cssW / 2 - ((x0 + x1) / 2) * view.k;
      var tyT = cssH / 2 - ((y0 + y1) / 2) * view.k;
      view.tx += (txT - view.tx) * f;
      view.ty += (tyT - view.ty) * f;
    }

    /* one rAF loop; physics every frame (alpha floor keeps a live,
       breathing drift; render lerp runs regardless) */
    function loop(now) {
      rafId = requestAnimationFrame(loop);
      if (hidden) return;
      if (!lastFrame) lastFrame = now;
      var dt = clamp(now - lastFrame, 4, 60);
      lastFrame = now;
      tick(now || 0);
      interp(now, dt);
      if (!userView && nodes.length) autoFit(dt);
      draw(now || 0);
      followPin();
    }
    rafId = requestAnimationFrame(loop);

    /* ---------- pointer: hover, click, drag-pin, pan, zoom ---------- */
    /* physics-space helpers (view.k/tx/ty map physics → screen) */
    function toPhys(sx, sy) {
      return [(sx - view.tx) / view.k, (sy - view.ty) / view.k];
    }
    function toScreen(x, y) {
      return [x * view.k + view.tx, y * view.k + view.ty];
    }
    function hitNode(px, py) {
      for (var i = nodes.length - 1; i >= 0; i--) {
        var n = nodes[i];
        if (n.rx == null) continue;
        if (spawnScale(n, performance.now()) <= 0) continue;
        var dx = px - n.rx, dy = py - n.ry;
        var rad = Math.max(n.r + 5, COLLIDE_R / 3) / view.k;
        if (dx * dx + dy * dy <= rad * rad) return n;
      }
      return null;
    }
    function hitEdge(px, py) {
      var tol = 6 / view.k;
      for (var i = linkList.length - 1; i >= 0; i--) {
        var L = linkList[i], g = L._geom;
        if (!g || L.a.rx == null) continue;
        /* g = [ax, ay, cpx, cpy, bx, by]; straight when control == start */
        var straight = g[0] === g[2] && g[1] === g[3];
        for (var s = 0; s <= 16; s++) {
          var t = s / 16, pt;
          if (straight) {
            pt = [g[0] + (g[4] - g[0]) * t, g[1] + (g[5] - g[1]) * t];
          } else {
            pt = quadPoint(g[0], g[1], g[2], g[3], g[4], g[5], t);
          }
          var dx = px - pt[0], dy = py - pt[1];
          if (dx * dx + dy * dy <= tol * tol) return L;
        }
      }
      return null;
    }

    function tipText(n) {
      if (n.kind === "persona") {
        var t = n.label || n.name || "";
        if (!t) return n.type || "persona";
        return t;
      }
      if (n.label) return n.label;
      return n.kind === "phantom" ? "entity \u00b7 " + String(n.id).slice(2)
                                  : (n.type || "topic");
    }

    function updateTip() {
      var n = hoverNode ? nodeById.get(hoverNode) : null;
      if (!n || dragNode || panning || pinnedNode === n.id) {
        tip.classList.remove("on");
        return;
      }
      tip.textContent = trunc(tipText(n), 120);
      var px = clamp(mx + 14, 8, Math.max(8, cssW - tip.offsetWidth - 8));
      var py = clamp(my + 16, 8, Math.max(8, cssH - tip.offsetHeight - 8));
      tip.style.left = px + "px";
      tip.style.top = py + "px";
      tip.classList.add("on");
    }
    function dispatchHover(id) {
      if (id === lastHoverSent) return;
      lastHoverSent = id;
      try {
        window.dispatchEvent(new CustomEvent("csgraph:hover",
          { detail: { nodeId: id } }));
      } catch (e) { /* noop */ }
    }

    var dragNode = null;    /* pinned node while dragging (d3 fx/fy) */
    var panning = null;     /* {sx,sy,tx0,ty0} while background-dragging */
    var press = null;       /* {sx,sy,px,py,moved} — 3px click-vs-drag */

    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      var r = canvas.getBoundingClientRect();
      mx = e.clientX - r.left; my = e.clientY - r.top;
      var pp = toPhys(mx, my);
      var n = hitNode(pp[0], pp[1]);
      press = { sx: e.clientX, sy: e.clientY, px: pp[0], py: pp[1], moved: false };
      tip.classList.remove("on");
      try {
        canvas.setPointerCapture(e.pointerId);
        press.pid = e.pointerId;
      } catch (err) { /* noop */ }
      if (n) {
        press.node = n;
        canvas.style.cursor = "grabbing";
      } else {
        press.pan = true;   /* candidate to pan once >3px */
      }
    }
    function onMove(e) {
      var r = canvas.getBoundingClientRect();
      mx = e.clientX - r.left; my = e.clientY - r.top;
      var pp = toPhys(mx, my);
      if (press) {
        if (!press.moved &&
            Math.abs(e.clientX - press.sx) + Math.abs(e.clientY - press.sy) > DRAG_PX) {
          press.moved = true;
          if (press.node) {
            dragNode = press.node;         /* d3 dragstart: pin fx/fy */
            dragNode.fx = dragNode.x; dragNode.fy = dragNode.y;
          } else {
            panning = { sx: press.sx, sy: press.sy, tx0: view.tx, ty0: view.ty };
            userView = true;
          }
        }
        if (dragNode) {
          /* d3 drag: pin to pointer, alphaTarget(.3) applied in tick */
          dragNode.fx = pp[0]; dragNode.fy = pp[1];
          return;
        }
        if (panning) {
          view.tx = panning.tx0 + (e.clientX - panning.sx);
          view.ty = panning.ty0 + (e.clientY - panning.sy);
          return;
        }
        return;   /* pressed but not yet moved: no hover churn */
      }
      var n = hitNode(pp[0], pp[1]);
      hoverNode = n ? n.id : null;
      dispatchHover(hoverNode);
      canvas.style.cursor = n ? "grab" : "default";
      updateTip();
    }
    function onLeave() {
      hoverNode = null; dispatchHover(null);
      mx = my = -9999;
      tip.classList.remove("on");
    }
    function onUp(e) {
      if (dragNode) {
        /* d3 dragend: unpin — the graph keeps breathing around it */
        dragNode.fx = dragNode.fy = null;
        dragNode = null;
      }
      var wasPress = press;
      panning = null;
      canvas.style.cursor = "default";
      if (wasPress && !wasPress.moved) {
        onClick(wasPress.px, wasPress.py);   /* genuine click (≤3px) */
      }
      press = null;
      void e;
    }
    function onWheel(e) {
      var r = canvas.getBoundingClientRect();
      mx = e.clientX - r.left; my = e.clientY - r.top;
      /* d3.zoom-like scaleExtent 0.1–4, anchored at the cursor */
      var factor = Math.exp(-e.deltaY * 0.0015);
      var newK = clamp(view.k * factor, ZOOM_MIN, ZOOM_MAX);
      view.tx = mx - (mx - view.tx) * newK / view.k;
      view.ty = my - (my - view.ty) * newK / view.k;
      view.k = newK;
      userView = true;
      e.preventDefault();
    }

    function onClick(px, py) {
      hoverNode = null;
      tip.classList.remove("on");
      var n = hitNode(px, py);
      if (n) {
        selectedNode = selectedNode === n.id ? null : n.id;
        selectedEdge = null;
        /* persona → console contract as before; topic/entity →
           pinned label card + the same event (console may react) */
        pinnedNode = (n.kind !== "persona" && pinnedNode !== n.id) ? n.id : null;
        updatePin();
        dispatchNode(n.id, n.kind === "persona" ? "persona" : n.kind === "phantom" ? "entity" : "topic");
        if (!pinnedNode) updateTip();
        return;
      }
      var L = hitEdge(px, py);
      selectedEdge = L ? L.p.key : null;
      if (L) selectedNode = null;
      else { selectedNode = null; dispatchNode(null, null); }
      pinnedNode = null;   /* any non-node click dismisses the card */
      updatePin();
      updateTip();
    }

    function dispatchNode(id, nodeType) {
      try {
        window.dispatchEvent(new CustomEvent("csgraph:node",
          { detail: { nodeId: id == null ? null : id, nodeType: nodeType || null } }));
      } catch (e) { /* noop */ }
    }

    /* ---------- pinned label card (topic / entity click) ---------- */
    function updatePin() {
      if (!pinnedNode) { pin.hidden = true; return; }
      var n = nodeById.get(pinnedNode);
      if (!n) { pinnedNode = null; pin.hidden = true; return; }
      pin.innerHTML =
        '<span class="csg-pin-chip" style="background:' + n.color + '">' +
        esc(trunc(n.type || n.kind, 18)) + '</span>' +
        '<div class="csg-pin-txt">' + esc(trunc(n.label || n.type || n.id, 220)) + '</div>' +
        '<div class="csg-pin-id">' + esc(n.id) + '</div>';
      pin.hidden = false;
      followPin(true);
    }
    function followPin(hard) {
      if (pinnedNode == null || pin.hidden) return;
      var n = nodeById.get(pinnedNode);
      if (!n || n.rx == null) return;
      var sp = toScreen(n.rx, n.ry);
      var w = pin.offsetWidth || 240, h2 = pin.offsetHeight || 80;
      var px = sp[0] + n.r * view.k + 12, py = sp[1] - h2 / 2;
      if (px + w > cssW - 8) px = sp[0] - n.r * view.k - 12 - w;
      px = clamp(px, 8, Math.max(8, cssW - w - 8));
      py = clamp(py, 8, Math.max(8, cssH - h2 - 8));
      pin.style.transform = "translate(" + Math.round(px) + "px," + Math.round(py) + "px)";
      void hard;
    }

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    /* ---------- legend (entity types + agent segments) ---------- */
    legendChip.addEventListener("click", function () {
      legendTouched = true;
      root.classList.toggle("csg-legend-open");
    });

    function buildLegend() {
      var entRows = [], segRows = [], entSeen = {}, segSeen = {};
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        var t = nd.type || "entity";
        if (nd.kind === "persona") {
          if (!segSeen[t]) {
            segSeen[t] = { name: t, color: nd.segColor || nd.color, count: 0 };
            segRows.push(segSeen[t]);
          }
          segSeen[t].count++;
        } else {
          if (!entSeen[t]) {
            entSeen[t] = { name: t, color: colorFor(t), count: 0 };
            entRows.push(entSeen[t]);
          }
          entSeen[t].count++;
        }
      }
      var html = "";
      if (entRows.length) {
        html += '<div class="csg-legend-cap">ENTITY TYPES</div>' +
          '<div class="csg-legend-rows">';
        entRows.forEach(function (row) {
          html += '<span class="csg-lg-item"><span class="csg-lg-dot" style="background:' +
            row.color + '"></span><span class="csg-lg-name">' + esc(row.name) +
            '</span><span class="csg-lg-n">' + row.count + '</span></span>';
        });
        html += '</div>';
      }
      if (segRows.length) {
        html += (html ? '<div class="csg-legend-cap csg-legend-cap2">AGENT SEGMENTS</div>' :
                       '<div class="csg-legend-cap">AGENT SEGMENTS</div>') +
          '<div class="csg-legend-rows">';
        segRows.forEach(function (row) {
          html += '<span class="csg-lg-item"><span class="csg-lg-dot csg-lg-ring" style="border-color:' +
            row.color + '"></span><span class="csg-lg-name">' + esc(row.name) +
            '</span><span class="csg-lg-n">' + row.count + '</span></span>';
        });
        html += '</div>';
      }
      if (!html) html = '<div class="csg-legend-cap">NO TYPES YET</div>';
      legend.innerHTML = html;
      legend.hidden = nodes.length === 0;
      legendChip.hidden = nodes.length === 0;
    }

    /* ---------- overlays ---------- */
    function setToast(mode, text) {
      if (mode === "live") {
        toastDone.hidden = true;
        if (text) toastLive.querySelector(".csg-toast-txt").textContent = text;
        toastLive.hidden = false;
      } else if (mode === "done") {
        toastLive.hidden = true; loader.hidden = true;
        toastDone.hidden = false;
      } else {
        toastLive.hidden = true; toastDone.hidden = true;
      }
    }
    root.querySelector(".csg-toast-x").addEventListener("click", function () {
      toastDone.hidden = true;
    });

    /* ---------- event wiring ---------- */
    function on(name, fn) {
      try { var off = CS.on(name, fn); if (off) offs.push(off); }
      catch (e) { /* noop */ }
    }
    function detail(e) { return (e && e.detail) || e || {}; }

    on("session:start", function () {
      phase = "scout";
      selectedNode = selectedEdge = null;
      pinnedNode = null; updatePin();
      pendingRound = null; loader.hidden = true;
      setToast("live", "real-time updating");
    });
    on("scout:status", function () { if (phase === "idle") phase = "scout"; });
    on("evidence", function (e) { addEvidence(detail(e).card || detail(e)); });
    on("persona", function (e) { addPersona(detail(e)); });
    on("debate:round", function (e) { onDebateRound(detail(e)); });
    on("debate:stance", function (e) { onStance(detail(e)); });
    on("debate:camp", function (e) { onCamp(detail(e)); });
    on("verdict", function () { if (nodes.length) reheat(0.3); });
    on("loop:start", function () { /* nothing to draw */ });
    on("loop:done", function () { /* nothing to draw */ });
    on("paid", function () { /* nothing to draw */ });
    on("stream:error", finish);
    on("stream:done", finish);
    function finish() {
      phase = "done";
      pendingRound = null; loader.hidden = true;
      setToast("done");
    }

    /* restore/backlog: seed whatever CS already holds */
    try {
      if (CS && CS.session) {
        (CS.session.evidence || []).forEach(addEvidence);
        (CS.session.personas || []).forEach(addPersona);
        (CS.session.debate && CS.session.debate.rounds || []).forEach(function (r) {
          (r.stances || []).forEach(function (st) {
            onStance({ persona_id: st.persona_id, segment: st.segment,
              round: r.n, stance: st.stance, reason: st.reason });
          });
          (r.camps || []).forEach(function (c) {
            onCamp({ member_ids: c.member_ids });
          });
        });
      }
    } catch (e) { /* noop */ }

    intervalId = setInterval(flushBatch, BUILD_INTERVAL);
    later(flushBatch, 400);   /* first snapshot lands quickly */

    /* ---------- visibility ---------- */
    function onVis() { hidden = document.hidden; }
    document.addEventListener("visibilitychange", onVis);

    /* ---------- teardown ---------- */
    function destroyIt() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(rafId);
      clearInterval(intervalId);
      timeoutIds.forEach(clearTimeout);
      timeoutIds.length = 0;
      offs.forEach(function (off) { try { off(); } catch (e) { /* noop */ } });
      document.removeEventListener("visibilitychange", onVis);
      if (ro) { try { ro.disconnect(); } catch (e) { /* noop */ } }
      if (root.parentNode) root.parentNode.removeChild(root);
      nodes.length = 0; pairs.clear(); linkList.length = 0;
      cache.clear(); arcs.length = 0;
      try { delete window.__csgDebug; } catch (e) { window.__csgDebug = null; }
      if (active === destroyIt) active = null;
    }
    window.__csgDebug = function () {
      var drawn = 0, kinds = {}, i;
      for (var k = 0; k < nodes.length; k++) {
        var kk = nodes[k].kind; kinds[kk] = (kinds[kk] || 0) + 1;
      }
      for (i = 0; i < linkList.length; i++) drawn += linkList[i].p.count;
      /* cloud extent — spread check (owner v4) */
      var ex = null, maxEx = 0;
      if (nodes.length) {
        var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (i = 0; i < nodes.length; i++) {
          var nd = nodes[i];
          if (nd.rx < x0) x0 = nd.rx; if (nd.rx > x1) x1 = nd.rx;
          if (nd.ry < y0) y0 = nd.ry; if (nd.ry > y1) y1 = nd.ry;
        }
        var wNow = Math.round((x1 - x0) * view.k);
        var hNow = Math.round((y1 - y0) * view.k);
        ex = { w: wNow, h: hNow, fracW: Math.round(wNow / cssW * 100) };
        maxEx = Math.round(Math.max(wNow / cssW, (y1 - y0) / cssH) * 100);
        if (maxEx > maxExtent) maxExtent = maxEx;
      }
      /* mean edge length vs its rest length — is the sim loose or jammed? */
      var meanLen = null, meanSlack = null, ifN = linkList.length;
      if (ifN) {
        var sumL = 0, sumS = 0;
        for (i = 0; i < ifN; i++) {
          var Li = linkList[i];
          var el = Math.sqrt((Li.a.rx - Li.b.rx) * (Li.a.rx - Li.b.rx) +
                             (Li.a.ry - Li.b.ry) * (Li.a.ry - Li.b.ry));
          sumL += el; sumS += el - Li.p.want;
        }
        meanLen = Math.round(sumL / ifN);
        meanSlack = Math.round(sumS / ifN);
      }
      var types = {}, segs = {};
      for (i = 0; i < nodes.length; i++) {
        var nd2 = nodes[i];
        if (nd2.kind === "persona") segs[nd2.type] = (segs[nd2.type] || 0) + 1;
        else types[nd2.type] = (types[nd2.type] || 0) + 1;
      }
      return {
        nodes: nodes.length, kinds: kinds, pairs: linkList.length, edges: drawn,
        alpha: alpha, alphaGoal: alphaGoal, alphaDecay: alphaDecay,
        simRunning: REDUCED ? alpha > ALPHA_MIN : true,
        arcs: arcs.length, arcsTotal: arcsTotal,
        pulses: pulsesTotal,
        pendingNodes: pendingNodes.length,
        pendingEdges: pendingEdges.length, phase: phase,
        pendingRound: pendingRound,
        selNode: selectedNode, selEdge: selectedEdge,
        extent: ex, maxExtent: maxExtent,
        meanLen: meanLen, meanSlack: meanSlack,
        spawn: (function () {
          var hidden = 0, rising = 0, i;
          var no = performance.now();
          for (i = 0; i < nodes.length; i++) {
            var sc = spawnScale(nodes[i], no);
            if (sc <= 0) hidden++;
            else if (sc < 1) rising++;
          }
          return { hidden: hidden, animating: rising };
        })(),
        pts: nodes.slice(0, 60).map(function (nd) {
          var sp2 = toScreen(nd.rx, nd.ry);
          return { id: nd.id, kind: nd.kind, type: nd.type,
                   x: Math.round(sp2[0]), y: Math.round(sp2[1]) };
        }),
        view: { k: +view.k.toFixed(3), tx: Math.round(view.tx), ty: Math.round(view.ty) },
        legend: { types: types, segments: segs,
                  open: root.classList.contains("csg-legend-open") },
        hover: hoverNode,
        pinned: pinnedNode,
        sampleEdgeMid: linkList.length && linkList[0]._geom && nodes.length ?
          [Math.round((linkList[0]._geom[0] + linkList[0]._geom[4]) / 2),
           Math.round((linkList[0]._geom[1] + linkList[0]._geom[5]) / 2)] : null,
        toast: !toastLive.hidden ? "live"
             : !toastDone.hidden ? "done" : null,
        probe: function (x, y) {
          var nh = hitNode(x, y);
          if (nh) return { node: nh.id };
          var eh = hitEdge(x, y);
          if (eh) return { edge: eh.p.key };
          return null;
        },
      };
    };
    active = destroyIt;
    return destroyIt;
  }

  function destroy() {
    if (active) active();
  }

  window.CSGraph = { mount: mount, destroy: destroy };
})();