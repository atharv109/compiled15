/* ============================================================
   Customer Swarm — steps/learn.js
   Step 5 "Learn": the belief-rewriting loop against a seeded
   simulated market (Tab A), and — behind the paywall — direct
   chat with any of the 50 agents (Tab B).
   ============================================================ */
(function () {
  "use strict";

  const CS = window.CS;
  const CE = window.CSEffects;

  /* Chart series colors — validated with the dataviz skill's
     palette runner on the white console surface:
     #B45309 (train) ↔ #155E93 (test): CVD ΔE 19.1+, normal-vis
     ΔE 26.7, contrast ≥3:1, lightness band + chroma floor PASS.
     Baseline is chart chrome (muted grid ink), not a series. */
  const C_TRAIN = "#B45309";
  const C_TEST  = "#155E93";
  const C_BASE  = "#999999";
  const C_GRID  = "#E7E7E7";

  const STANCE = {
    for:            { label: "for",              cls: "ok" },
    neutral:        { label: "neutral",          cls: "mut" },
    against:        { label: "against",          cls: "warn" },
    strong_against: { label: "strong against",   cls: "err" },
    promo_only:     { label: "promo-led",        cls: "acc" },
  };

  /* per-agent chat history — deliberately local, never CS.session */
  const chats = new Map();
  let selAgent = null;
  let typingAgent = null;
  let pollTimer = null;

  let MOUNT = null;
  const refs = {};              /* pointers at live DOM, rebuilt on render */
  let activeTab = "loop";
  let wired = false;

  CS.register({
    id: "learn", num: 5, title: "Learn", short: "Loop & agents",
    render,
  });

  /* ---------------- bus wiring (module-level, once) ---------------- */
  function wire() {
    if (wired) return;
    wired = true;
    /* If the loop pane wasn't rendered with live refs (hero path), rebuild it
       on the first event so the stream/chart become live — the hero button is
       the normal entry point, so this is the path users actually hit. */
    const ensureLoopPane = (fn) => {
      if (!MOUNT || !CS.session) return;
      if (!refs.iters || !refs.viz) {
        if (activeTab !== "loop") return;
        renderTab();
      }
      fn();
    };
    CS.on("loop:start", () => {
      ensureLoopPane(() => {
        if (refs.iters) refs.iters.innerHTML = "";
      });
      redrawChart();
      refreshLoopChrome();
    });
    CS.on("loop:iter", (e) => {
      ensureLoopPane(() => {});
      if (refs.iters) appendIterCard(refs.iters, e.detail);
    });
    CS.on("loop:chart", () => { redrawChart(); });
    CS.on("loop:done", () => { redrawChart(); refreshLoopChrome(); });
    CS.on("paid", () => { if (MOUNT && activeTab === "agents") renderTab(); });
  }

  /* ---------------- render entry ---------------- */
  function render(mount, session) {
    MOUNT = mount;
    wire();
    mount.innerHTML = "";

    const wrap = CS.el('<div class="lrn-wrap"></div>');
    const strip = CS.el(
      '<div class="lrn-tabs" role="tablist" aria-label="Learn step tabs">' +
        '<button class="lrn-tab' + (activeTab === "loop" ? " is-on" : "") +
          '" role="tab" aria-selected="' + (activeTab === "loop") + '" data-tab="loop">' +
          '<i>a</i>improvement loop</button>' +
        '<button class="lrn-tab' + (activeTab === "agents" ? " is-on" : "") +
          '" role="tab" aria-selected="' + (activeTab === "agents") + '" data-tab="agents">' +
          '<i>b</i>ask an agent</button>' +
      '</div>'
    );
    const pane = CS.el('<div class="lrn-pane"></div>');
    wrap.append(strip, pane);
    mount.append(wrap);

    strip.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn || btn.dataset.tab === activeTab) return;
      activeTab = btn.dataset.tab;
      strip.querySelectorAll(".lrn-tab").forEach((t) => {
        const on = t.dataset.tab === activeTab;
        t.classList.toggle("is-on", on);
        t.setAttribute("aria-selected", String(on));
      });
      renderTab();
    });

    renderTab();
  }

  function renderTab() {
    const session = CS.session;
    const pane = MOUNT && MOUNT.querySelector(".lrn-pane");
    if (!pane) return;
    pane.innerHTML = "";
    for (const k of Object.keys(refs)) delete refs[k];
    if (activeTab === "loop") renderLoop(pane, session);
    else renderAgents(pane, session);
  }

  /* ============================================================
     TAB A — the improvement loop
     ============================================================ */
  function renderLoop(pane, session) {
    const L = session.loop;
    const data = chartData(L);
    const hasAny = L.iterations.length > 0 || !!data;

    if (!hasAny && !L.running) {
      pane.append(buildHero());
      return;
    }

    const head = CS.el(
      '<div class="lrn-loop-head">' +
        '<div class="lrn-loop-title">' +
          '<span class="lrn-kicker">5a · improvement loop</span>' +
          '<h2>Beliefs earn their keep, or they get discarded</h2>' +
        '</div>' +
        '<div class="lrn-loop-meta" id="lrn-loop-meta"></div>' +
      '</div>'
    );
    pane.append(head);

    const stream = CS.el('<div class="lrn-iters" aria-live="polite"></div>');
    refs.iters = stream;
    L.iterations.forEach((it) => appendIterCard(stream, it));
    pane.append(stream);

    const chartHost = CS.el('<div class="lrn-viz"></div>');
    refs.viz = chartHost;
    pane.append(chartHost);
    drawChart();

    const foot = CS.el('<div class="lrn-loop-foot"></div>');
    refs.foot = foot;
    pane.append(foot);

    refreshLoopChrome();
  }

  function buildHero() {
    const card = CS.el(
      '<div class="lrn-hero">' +
        '<div class="lrn-kicker">5a · improvement loop</div>' +
        '<h2 class="lrn-hero-t">The verdict learns from a market it can&rsquo;t see</h2>' +
        '<p class="lrn-hero-p">A simulated market, calibrated from real reviews. ' +
          'Calibration proposes ranges; a seeded truth is sampled inside them and hidden ' +
          'from the agents. Proposals earn their keep by predicting outcomes &mdash; ' +
          'beliefs get rewritten, and only if the rewritten belief predicts better is it kept.</p>' +
        '<p class="lrn-hero-note">In production, owners log real outcomes and the swarm ' +
          'learns from those.</p>' +
        '<button class="lrn-run" type="button">Run the loop <span aria-hidden="true">&rarr;</span></button>' +
      '</div>'
    );
    card.querySelector(".lrn-run").addEventListener("click", () => CS.runLoop());
    return card;
  }

  function refreshLoopChrome() {
    const L = CS.session && CS.session.loop;
    if (!L) return;
    const meta = MOUNT && MOUNT.querySelector("#lrn-loop-meta");
    if (meta) {
      const data = chartData(L);
      meta.textContent =
        "market seed " + L.seed +
        (data ? " · baseline regret " + data.baseline.toFixed(2) : "") +
        (L.running ? " · <running>" : L.iterations.length ? " · " + L.iterations.length + " beliefs tested" : "");
    }
    const foot = refs.foot;
    if (!foot) return;
    foot.innerHTML = "";
    if (L.running) {
      foot.append(CS.el('<div class="lrn-recalc mono">recalibrating… beliefs stream above</div>'));
      return;
    }
    const data = chartData(L);
    if (data) {
      const b = CS.el(
        '<button class="lrn-btn2" type="button">Reroll market (new seed)</button>'
      );
      b.addEventListener("click", () => CS.rerollLoop());
      foot.append(b);
      foot.append(CS.el(
        '<span class="lrn-foot-note">same learned policy, a fresh hidden truth — the point: it still beats the baseline. seed → ' +
          L.seed + "</span>"
      ));
    }
  }

  function appendIterCard(stream, it) {
    if (!it) return;
    const kept = !!it.kept;
    const card = CS.el(
      '<div class="lrn-iter' + (kept ? " kept" : " drop") + '">' +
        '<div class="lrn-iter-top">' +
          '<span class="lrn-iter-n mono">it.' + Number(it.n || 0).toString().padStart(2, "0") + "</span>" +
          '<span class="lrn-iter-name">' + CS.esc(it.proposal || "") + "</span>" +
          '<span class="lrn-badge ' + (kept ? "ok" : "no") + '">' +
            (kept ? "KEPT — belief updated" : "DISCARDED — rewrite predicted worse") + "</span>" +
        "</div>" +
        '<div class="lrn-iter-pv mono">' +
          '<span class="lrn-pred">' + CS.esc(it.predicted || "—") + "</span>" +
          '<span class="lrn-arrow" aria-hidden="true">&rarr;</span>' +
          '<span class="lrn-act">' + CS.esc(it.actual || "—") + "</span>" +
          '<span class="lrn-err">error ' + fmtN(it.error) + "</span>" +
        "</div>" +
        (it.belief ? '<div class="lrn-iter-b">belief: ' + CS.esc(it.belief) + "</div>" : "") +
      "</div>"
    );
    if (!kept) card.querySelector(".lrn-iter-name").classList.add("struck");
    stream.append(card);
    maybeScroll(stream);
  }

  function maybeScroll(el) {
    const p = el.parentElement;
    if (!p) return;
    if (p.scrollHeight - p.scrollTop - p.clientHeight < 160) p.scrollTop = p.scrollHeight;
  }

  function fmtN(v) {
    const n = Number(v);
    return isFinite(n) ? n.toFixed(2) : "—";
  }

  /* legend key: a short stroke of the series color — the legend mirrors the mark */
  function keyLine(color, dash) {
    return '<svg width="20" height="6" aria-hidden="true"><line x1="0" y1="3" x2="20" y2="3" stroke="' +
      color + '" stroke-width="2" stroke-linecap="round" ' +
      (dash ? 'stroke-dasharray="' + dash + '" ' : "") + "/></svg>";
  }

  /* table view — every value the chart shows, reachable without hover */
  function buildTable(data) {
    const t = CS.el(
      '<table class="lrn-viz-table"><thead><tr>' +
        "<th>iteration</th><th>train</th><th>test regret</th>" +
        "<th>regret</th><th>baseline</th></tr></thead></table>"
    );
    const body = document.createElement("tbody");
    for (const p of data.points) {
      const tr = document.createElement("tr");
      const cells = [
        String(p.i), Number(p.train).toFixed(2),
        Number(p.test).toFixed(2),
        p.regret != null ? Number(p.regret).toFixed(2) : "—",
        data.baseline != null ? Number(data.baseline).toFixed(2) : "—",
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    t.appendChild(body);
    return t;
  }

  /* ---------------- chart ---------------- */
  function chartData(L) {
    const c = L && L.chart;
    if (!c || Array.isArray(c)) return null;
    let pts = Array.isArray(c.points) ? c.points : null;
    if (!pts || !pts.length) return null;
    const base = c.baseline != null ? Number(c.baseline)
      : pts[0] && pts[0].regret != null ? Math.min(0.5, Number(pts[0].regret) * 2)
      : null;
    return { points: pts.filter((p) => p && isFinite(p.train)), baseline: base };
  }

  function redrawChart() {
    if (!refs.viz) return;
    const L = CS.session.loop;
    const data = chartData(L);
    if (!data) { refs.viz.innerHTML = ""; return; }
    drawLoopChart(refs.viz, data);
  }

  /* Hand-rolled SVG line chart (~100 lines): x = iteration, y = error.
     train (2px solid amber) · test regret (2px dashed steel-blue) ·
     baseline (dotted gray, chrome) · hairline solid grid · crosshair
     tooltip · legend + table-view twin (the WCAG-clean channel). */
  function drawLoopChart(host, data) {
    host.innerHTML = "";
    const pts = data.points;
    const N = pts.length;

    /* card head: title + legend + table toggle */
    const head = CS.el(
      '<div class="lrn-viz-head">' +
        '<div class="lrn-viz-tblock">' +
          '<div class="lrn-viz-title">policy error per loop iteration</div>' +
          '<div class="lrn-legend">' +
            '<span class="lrn-key">' + keyLine(C_TRAIN, "") + "train</span>" +
            '<span class="lrn-key">' + keyLine(C_TEST, "6 4") + "test regret</span>" +
            '<span class="lrn-key">' + keyLine(C_BASE, "2 5") + "baseline</span>" +
          "</div>" +
        "</div>" +
        '<button class="lrn-viz-tw mono" type="button" aria-pressed="false">table view</button>' +
      "</div>"
    );
    host.appendChild(head);
    const plot = CS.el('<div class="lrn-plot"></div>');
    host.appendChild(plot);
    const tbl = CS.el('<div class="lrn-viz-tablewrap" hidden></div>');
    tbl.appendChild(buildTable(data));
    host.appendChild(tbl);
    head.querySelector(".lrn-viz-tw").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const on = tbl.hidden;
      tbl.hidden = !on;
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = on ? "hide table" : "table view";
    });

    const W = 640, H = 300;
    const M = { t: 30, r: 74, b: 48, l: 52 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const Y_MAX = 0.5;

    const xAt = (k) => M.l + (N === 1 ? iw / 2 : ((pts[k].i - pts[0].i) / (pts[N - 1].i - pts[0].i)) * iw);
    const yAt = (v) => M.t + (1 - Math.max(0, Math.min(Y_MAX, v)) / Y_MAX) * ih;

    const NS = "http://www.w3.org/2000/svg";
    const S = (tag, attrs, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      (parent || svg).appendChild(n);
      return n;
    };
    const T = (x, y, txt, cls, extra) => {
      const n = S("text", Object.assign({ x, y, "class": "lrn-chart-text " + (cls || "") }, extra || {}));
      n.textContent = txt;
      return n;
    };

    const svg = S("svg", {
      viewBox: "0 0 " + W + " " + H, "class": "lrn-chart",
      role: "img", "aria-label": "Prediction error across " + N + " loop iterations",
      "font-family": "var(--font-mono)",
    });

    /* grid + y ticks (hairlines, solid) */
    for (let g = 0; g <= 5; g++) {
      const v = g * 0.1, y = yAt(v);
      S("line", { x1: M.l, y1: y, x2: W - M.r, y2: y, stroke: C_GRID, "stroke-width": 1 });
      T(M.l - 8, y + 3, v.toFixed(1), "muted").setAttribute("text-anchor", "end");
    }
    /* axes labels */
    T(0, 0, "prediction error", "muted", { transform: "translate(13 " + (M.t + ih / 2) + ") rotate(-90)", "text-anchor": "middle" });
    T(M.l + iw / 2, H - 10, "iteration", "muted", { "text-anchor": "middle" });

    /* x ticks: iteration numbers */
    const stride = N > 10 ? 2 : 1;
    pts.forEach((p, k) => {
      if (k % stride !== 0 && k !== N - 1) return;
      T(xAt(k), M.t + ih + 16, String(p.i), "muted").setAttribute("text-anchor", "middle");
    });

    /* baseline: dotted chrome line + selective direct label */
    if (data.baseline != null) {
      const y = yAt(data.baseline);
      S("line", { x1: M.l, y1: y, x2: W - M.r, y2: y, stroke: C_BASE, "stroke-width": 1.5, "stroke-dasharray": "2 5", "stroke-linecap": "round" });
      T(W - M.r + 6, y + 3, "base " + data.baseline.toFixed(2), "muted");
    }

    /* line builder + markers (surface ring keeps dots legible over the line) */
    const path = (get) => pts.map((p, k) => (k ? "L" : "M") + xAt(k).toFixed(1) + " " + yAt(get(p)).toFixed(1)).join(" ");
    S("path", { d: path((p) => p.test), fill: "none", stroke: C_TEST, "stroke-width": 2, "stroke-dasharray": "6 4", "stroke-linecap": "round", "stroke-linejoin": "round" });
    S("path", { d: path((p) => p.train), fill: "none", stroke: C_TRAIN, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" });
    pts.forEach((p, k) => {
      S("circle", { cx: xAt(k), cy: yAt(p.train), r: 3.5, fill: C_TRAIN, stroke: "#fff", "stroke-width": 2 });
      S("circle", { cx: xAt(k), cy: yAt(p.test), r: 3.5, fill: C_TEST, stroke: "#fff", "stroke-width": 2 });
    });

    /* selective direct labels at the last point (collide-checked) */
    let l1 = yAt(pts[N - 1].train), l2 = yAt(pts[N - 1].test);
    if (Math.abs(l1 - l2) < 13) { const mid = (l1 + l2) / 2; l1 = mid - (l1 <= l2 ? 7 : -7); l2 = mid + (l1 < l2 ? 8 : -8); }
    T(W - M.r + 6, l1 + 3, pts[N - 1].train.toFixed(2), "endlab");
    T(W - M.r + 6, l2 + 3, pts[N - 1].test.toFixed(2), "endlab");

    /* hover layer: crosshair + one tooltip listing every series at that x */
    const cross = S("line", { x1: 0, y1: M.t, x2: 0, y2: M.t + ih, stroke: "#CCCCCC", "stroke-width": 1, opacity: 0 });
    const hoverDots = [C_TRAIN, C_TEST].map((c) =>
      S("circle", { cx: 0, cy: 0, r: 4, fill: c, stroke: "#fff", "stroke-width": 2, opacity: 0 }));

    const tipWrap = CS.el('<div class="lrn-tip" hidden></div>');
    plot.appendChild(tipWrap);
    const hit = S("rect", { x: M.l, y: M.t, width: iw, height: ih, fill: "transparent" });
    hit.setAttribute("tabindex", "0");
    hit.setAttribute("aria-label", "Use arrow keys to read values; the table view lists every point");

    const show = (k) => {
      const p = pts[k], x = xAt(k);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("opacity", 1);
      hoverDots[0].setAttribute("cx", x); hoverDots[0].setAttribute("cy", yAt(p.train)); hoverDots[0].setAttribute("opacity", 1);
      hoverDots[1].setAttribute("cx", x); hoverDots[1].setAttribute("cy", yAt(p.test)); hoverDots[1].setAttribute("opacity", 1);
      tipWrap.hidden = false;
      const box = svg.getBoundingClientRect();
      const sx = box.width / W;
      tipWrap.style.left = Math.max(4, Math.min(plot.clientWidth - 154, (x * sx) + 10)) + "px";
      tipWrap.style.top = "14px";
      tipWrap.textContent = "";
      const rows = [
        ["it." + p.i, null], ["train " + p.train.toFixed(2), C_TRAIN],
        ["test " + p.test.toFixed(2), C_TEST], ["regret " + (p.regret != null ? p.regret.toFixed(2) : "—"), C_BASE],
      ];
      for (const [txt, c] of rows) {
        const cell = document.createElement("div");
        cell.className = "lrn-tip-row" + (c ? "" : " head");
        if (c) { const key = CS.el('<span class="lrn-tip-key"></span>'); key.style.background = c; cell.append(key); }
        cell.append(document.createTextNode(txt));
        tipWrap.appendChild(cell);
      }
    };
    const hide = () => {
      cross.setAttribute("opacity", 0);
      hoverDots.forEach((d) => d.setAttribute("opacity", 0));
      tipWrap.hidden = true;
    };
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const xr = ((e.clientX - r.left) / r.width) * W;
      let best = 0, bd = 1e9;
      pts.forEach((p, k) => { const d = Math.abs(xAt(k) - xr); if (d < bd) { bd = d; best = k; } });
      show(best);
    });
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("keydown", (e) => {
      const cur = hoverDots[0].getAttribute("opacity") !== "0" && cross.getAttribute("x1") !== "0"
        ? pts.findIndex((p, k) => Math.abs(xAt(k) - Number(cross.getAttribute("x1"))) < 0.6) : -1;
      if (e.key === "ArrowRight") { show(Math.min(N - 1, Math.max(0, cur + 1))); e.preventDefault(); }
      if (e.key === "ArrowLeft") { show(Math.max(0, (cur < 0 ? N : cur) - 1)); e.preventDefault(); }
      if (e.key === "Escape") hide();
    });
    hit.addEventListener("blur", hide);
  }

  /* ============================================================
     TAB B — ask an agent (paywalled)
     ============================================================ */
  function renderAgents(pane, session) {
    if (!session || !session.personas || !session.personas.length) {
      pane.append(CS.el('<div class="lrn-empty mono">no agents in this session yet</div>'));
      return;
    }

    if (!CS.isPaid()) { pane.append(buildPaywall(pane)); return; }
    pane.append(buildChatGrid(session));
  }

  function buildPaywall(pane) {
    const n = (CS.session && CS.session.personas.length) || 50;
    const card = CS.el(
      '<div class="lrn-pay">' +
        '<div class="lrn-kicker">5b · ask an agent</div>' +
        '<h2 class="lrn-pay-t">Talk to the swarm directly</h2>' +
        '<p class="lrn-pay-p">Ask any of the ' + n + ' agents — segment-by-segment impact ' +
          'included. Every agent answers in character, from the evidence it was built from.</p>' +
        '<div class="lrn-pay-price mono">$19 · one-time unlock</div>' +
        '<button class="lrn-run" type="button">Unlock — $19' + (CS.STRIPE_LINK ? " (Stripe)" : " (demo payment)") + "</button>" +
        '<div class="lrn-pay-fine mono">' + (CS.STRIPE_LINK ? "secure checkout in a new tab · returns here to unlock" : "demo session — no card is charged") + '</div>' +
      '</div>'
    );
    card.querySelector(".lrn-run").addEventListener("click", () => {
      if (CS.STRIPE_LINK) {
        window.open(CS.STRIPE_LINK, "_blank", "noopener");
        startPaidPoll();
      } else {
        CS.markPaid();
      }
    });
    return card;
  }

  function startPaidPoll() {
    stopPaidPoll();
    let tries = 0;
    pollTimer = setInterval(() => {
      tries++;
      if (CS.isPaid()) { stopPaidPoll(); if (MOUNT && activeTab === "agents") renderTab(); }
      else if (tries > 150) stopPaidPoll();
    }, 800);
  }
  function stopPaidPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function buildChatGrid(session) {
    const personas = session.personas;
    if (!selAgent || !session.personas.some((p) => p.id === selAgent)) selAgent = null;

    const grid = CS.el(
      '<div class="lrn-agents">' +
        '<aside class="lrn-picker">' +
          '<div class="lrn-kicker">' + personas.length + ' agents</div>' +
          '<input class="lrn-search mono" type="search" placeholder="search name / segment" aria-label="Search agents" />' +
          '<div class="lrn-list" role="listbox" aria-label="Agents"></div>' +
        "</aside>" +
        '<section class="lrn-chat" aria-label="Agent chat"></section>' +
      '</div>'
    );
    const list = grid.querySelector(".lrn-list");
    const chat = grid.querySelector(".lrn-chat");
    const search = grid.querySelector(".lrn-search");

    const paintList = () => {
      const q = (search.value || "").trim().toLowerCase();
      list.innerHTML = "";
      for (const p of personas) {
        const segName = segLabel(session, p.segment);
        if (q && !(p.name + " " + segName).toLowerCase().includes(q)) continue;
        const row = CS.el(
          '<button class="lrn-row' + (p.id === selAgent ? " is-sel" : "") + '" role="option" aria-selected="' +
            (p.id === selAgent) + '" data-id="' + p.id + '">' +
            CE.avatar(p.id, 36) +
            '<span class="lrn-row-main"><b>' + CS.esc(p.name) + "</b>" +
            '<span class="lrn-row-seg mono">' + CS.esc(segName) + "</span></span>" +
            '<span class="lrn-chip ' + stanceChip(p.stance).cls + '">' + stanceChip(p.stance).label + "</span>" +
          "</button>"
        );
        row.addEventListener("click", () => {
          selAgent = p.id;
          paintList();
          paintChat(session);
        });
        list.appendChild(row);
      }
      if (!list.children.length) list.appendChild(CS.el('<div class="lrn-empty mono">no agent matches</div>'));
    };
    search.addEventListener("input", paintList);
    paintList();

    if (!selAgent) paintEmpty(chat);
    else paintChat(session);

    /* keep selected row visible */
    const selRow = list.querySelector(".is-sel");
    if (selRow) selRow.scrollIntoView({ block: "nearest" });

    return grid;
  }

  function segLabel(session, segId) {
    const s = session.segments.find((x) => x.id === segId);
    return s ? s.name : segId || "—";
  }
  function stanceChip(v) { return STANCE[v] || STANCE.neutral; }

  function paintEmpty(chat) {
    chat.innerHTML = "";
    chat.append(CS.el(
      '<div class="lrn-pick">' +
        '<div class="lrn-pick-mark" aria-hidden="true">&rsaquo;&lsaquo;</div>' +
        '<p>Pick one of the fifty agents on the left.</p>' +
        '<p class="mono">each answers from its own segment + evidence trail</p>' +
      '</div>'
    ));
  }

  function paintChat(session) {
    const p = session.personas.find((x) => x.id === selAgent);
    const chat = MOUNT && MOUNT.querySelector(".lrn-chat");
    if (!p) { return; }

    chat.innerHTML = "";
    const chip = stanceChip(p.stance);
    chat.append(CS.el(
      '<header class="lrn-chat-head">' +
        CE.avatar(p.id, 36) +
        '<div class="lrn-chat-who"><b>' + CS.esc(p.name) + "</b>" +
        '<span class="mono">' + CS.esc(segLabel(session, p.segment)) + " · " + p.id + "</span></div>" +
        '<span class="lrn-chip ' + chip.cls + '">' + chip.label + "</span>" +
      '</header>' +
      '<div class="lrn-msgs" aria-live="polite"></div>' +
      '<footer class="lrn-send">' +
        '<input class="lrn-msg-in mono" type="text" placeholder="ask ' + CS.esc(p.name.toLowerCase()) + ' anything…" aria-label="Message" />' +
        '<button class="lrn-send-btn" type="button">send &rarr;</button>' +
      "</footer>"
    ));

    const msgs = chat.querySelector(".lrn-msgs");
    const input = chat.querySelector(".lrn-msg-in");
    const btn = chat.querySelector(".lrn-send-btn");

    const hist = chats.get(p.id) || [];
    if (!hist.length) {
      msgs.append(CS.el(
        '<div class="lrn-quote">&ldquo;' + CS.esc(p.quote) + '&rdquo;' +
        '<span class="mono">— what they said in the debate</span></div>'
      ));
    } else {
      hist.forEach((m) => msgs.appendChild(bubble(m)));
    }
    scrollMsgs(msgs);

    const send = async () => {
      if (!selAgent || typingAgent) return;
      const text = input.value.trim();
      if (!text) return;
      const id = selAgent;
      pushMsg(id, "me", text);
      input.value = "";
      msgs.appendChild(bubble({ who: "me", text }));
      scrollMsgs(msgs);

      typingAgent = id;
      const typingEl = CS.el(
        '<div class="lrn-msg them"><span class="lrn-typing" aria-label="typing"><i></i><i></i><i></i>' +
        '<span class="mono lrn-typing-note">' + CS.esc(p.name) + " is thinking</span></span></div>"
      );
      msgs.appendChild(typingEl);
      scrollMsgs(msgs);

      let reply;
      try { reply = await CS.chat(id, text); }
      catch { reply = "(the agent dropped mid-thought — try again)"; }

      typingEl.remove();
      typingAgent = null;
      pushMsg(id, "agent", reply);
      const cur = MOUNT && MOUNT.querySelector(".lrn-msgs");
      const node = bubble({ who: "agent", text: reply });
      (cur || msgs).appendChild(node);
      scrollMsgs(cur || msgs);
    };
    btn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    input.focus({ preventScroll: true });
  }

  function bubble(m) {
    const row = CS.el('<div class="lrn-msg"></div>');
    if (m.who === "me") { row.classList.add("me"); row.textContent = m.text; }
    else {
      row.classList.add("them");
      if (selAgent) {
        const av = CE.avatar(selAgent, 30);
        row.appendChild(CS.el('<span class="lrn-msg-av">' + av + "</span>"));
      }
      const t = CS.el('<span class="lrn-msg-txt"></span>');
      t.textContent = m.text;
      row.appendChild(t);
    }
    return row;
  }

  function pushMsg(id, who, text) {
    if (!chats.has(id)) chats.set(id, []);
    chats.get(id).push({ who, text });
  }

  function scrollMsgs(msgs) { msgs.scrollTop = msgs.scrollHeight; }
})();