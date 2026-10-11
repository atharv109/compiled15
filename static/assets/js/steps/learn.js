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
    /* real backend stance values */
    support: { label: "for",        cls: "ok" },
    oppose:  { label: "against",    cls: "warn" },
    neutral: { label: "neutral",    cls: "mut" },
    /* partner rehearsal vocabulary */
    for:            { label: "for",              cls: "ok" },
    strong_against: { label: "strong against",   cls: "err" },
    against:        { label: "against",          cls: "warn" },
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
    id: "learn", num: 5, title: "Learn", short: "Loop · agents · drafts",
    render,
  });

  /* ---------------- bus wiring (module-level, once) ---------------- */
  function wire() {
    if (wired) return;
    wired = true;
    CS.on("loop:start", () => {
      if (activeTab !== "loop" || !MOUNT) return;
      renderTab();          // switch the pane into the running state
      startTimer();
    });
    CS.on("loop:done", (e) => {
      stopTimer();
      if (activeTab !== "loop" || !MOUNT) return;
      renderTab();          // chart + final eval + beliefs + reroll, or the error note
      if (e && e.detail && e.detail.error) loopError(e.detail.error);
    });
    CS.on("act:progress", (e) => {
      const el2 = document.getElementById("act-prog");
      if (el2) el2.textContent = (e.detail && e.detail.stage_detail) || "working…";
    });
    CS.on("paid", () => { if (MOUNT && (activeTab === "agents" || activeTab === "act")) renderTab(); });
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
        '<button class="lrn-tab' + (activeTab === "act" ? " is-on" : "") +
          '" role="tab" aria-selected="' + (activeTab === "act") + '" data-tab="act">' +
          '<i>c</i>act on it</button>' +
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
    else if (activeTab === "act") renderAct(pane, session);
    else renderAgents(pane, session);
  }

  /* ---------------- elapsed timer (loop + act run long) ---------------- */
  let tabTimer = null;
  function startTimer() {
    stopTimer();
    const t0 = Date.now();
    tabTimer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const txt = "running " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      const el2 = document.getElementById("lrn-elapsed");
      if (el2) el2.textContent = txt;
      const meta = document.getElementById("lrn-loop-meta");
      if (meta) {
        meta.textContent = "market seed " + ((CS.session && CS.session.loop.seed) || "") +
          (s ? " · " + txt : "");
      }
      const ameta = document.getElementById("lrn-act-meta");
      if (ameta) ameta.textContent = txt;
    }, 1000);
  }
  function stopTimer() { if (tabTimer) { clearInterval(tabTimer); tabTimer = null; } }

  /* ============================================================
     TAB A — the improvement loop (against the real /run-loop)
     Session model: loop = {running, seed, result, chart, beliefs}
     — bridge.js normalizes the backend response into chart
     {points:[{i, train: regret, test: prediction_error}], baseline,
     final_eval}.
     ============================================================ */
  function renderLoop(pane, session) {
    const L = session.loop;
    const data = chartData(L);
    const hasAny = !!(L.result || data);

    if (!hasAny && !L.running) {
      pane.append(buildHero());
      /* a re-attached session may have a stored run — pull it in quietly */
      if (CS.session.sid && !CS.session.mock && !L.restoreTried) {
        L.restoreTried = true;
        CS.loopChartRestore().then((d) => {
          if (d && d.chart && d.chart.points && d.chart.points.length) {
            CS.session.loop.chart = d.chart;
            CS.session.loop.result = d.result || { final_eval: (d.chart.final_eval || {}) };
            if (d.result && d.result.truth_seed != null) CS.session.loop.seed = d.result.truth_seed;
            if (MOUNT && activeTab === "loop") renderTab();
          }
        }).catch(() => { /* {} means never run — hero stays */ });
      }
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

    if (L.running) {
      pane.append(CS.el(
        '<div class="lrn-recalc mono"><span class="lrn-spin" aria-hidden="true">◷</span> ' +
        '<span id="lrn-elapsed">running 0:00</span></div>'));
      pane.append(CS.el('<div class="lrn-foot-note">the loop is a real training pass — ' +
        '2&ndash;4 minutes. the regret chart, final eval and beliefs land here when it finishes.</div>'));
      startTimer();
      return;
    }

    const stream = CS.el('<div class="lrn-finals"></div>');
    refs.finals = stream;
    pane.append(stream);
    drawFinals();

    const beliefsBox = CS.el('<div class="lrn-beliefs"></div>');
    refs.beliefs = beliefsBox;
    pane.append(beliefsBox);
    drawBeliefs();

    const chartHost = CS.el('<div class="lrn-viz"></div>');
    refs.viz = chartHost;
    pane.append(chartHost);
    redrawChart();

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
    card.querySelector(".lrn-run").addEventListener("click", () => {
      if (!CS.session || CS.session.loop.running) return;
      CS.runLoop().catch(loopError);
      renderTab();
    });
    return card;
  }

  function loopError(e) {
    const pane = MOUNT && MOUNT.querySelector(".lrn-pane");
    if (!pane) return;
    pane.append(CS.el('<div class="lrn-foot-note lrn-warn">⚠ ' + CS.esc(errMsg(e)) + '</div>'));
  }
  function errMsg(e) {
    const msg = String((e && e.message) || e || "loop failed");
    if (/no reviews/i.test(msg)) return msg + " — this session has no reviews to calibrate from.";
    if (/run the loop first|run debate first/i.test(msg)) return msg + " — run the debate/loop prerequisites first.";
    return msg;
  }

  function refreshLoopChrome() {
    const L = CS.session && CS.session.loop;
    if (!L || !refs.foot) return;
    const footEl = MOUNT.querySelector(".lrn-loop-foot");
    const box = refs.foot;
    box.innerHTML = "";
    const data = chartData(L);
    if (!data) return;
    const seedIn = CS.el('<input class="lrn-seed mono" type="number" value="' + (L.seed || 42) + '" aria-label="Reroll seed" />');
    const b = CS.el('<button class="lrn-btn2" type="button">Reroll market (new seed)</button>');
    b.addEventListener("click", () => {
      const s = parseInt(seedIn.value, 10);
      CS.runLoop({ seed: isNaN(s) ? undefined : s }).catch(loopError);
      renderTab();
    });
    box.append(b);
    box.append(CS.el(
      '<span class="lrn-foot-note">same learned policy, a fresh hidden truth — ' +
        'seed → ' + CS.esc(String(L.seed || "")) + '</span>'
    ));
  }

  function drawFinals() {
    if (!refs.finals) return;
    const L = CS.session.loop;
    const fe = (L.chart && L.chart.final_eval) || (L.result && L.result.final_eval) || null;
    if (!fe) { refs.finals.innerHTML = ""; return; }
    const chips = [
      ["baseline", fe.baseline_regret, ""],
      ["final", fe.final_regret,
        (fe.final_regret != null && fe.baseline_regret != null && fe.final_regret < fe.baseline_regret) ? "down" : ""],
      ["test", fe.test_regret, ""],
      ["shifted", fe.shifted_context_regret, ""],
    ].filter((c) => c[1] != null);
    refs.finals.innerHTML = chips.map((c) =>
      '<div class="lrn-final-chip' + (c[2] ? " is-better" : "") + '">' +
        '<b>' + fmtN(c[1]) + '</b><span>' + c[0] + ' regret</span></div>'
    ).join("");
  }

  function drawBeliefs() {
    if (!refs.beliefs) return;
    const L = CS.session.loop;
    const keys = Object.keys(L.beliefs || {});
    refs.beliefs.innerHTML = keys.length
      ? '<div class="lrn-beliefs-t">beliefs per segment — rewritten by the loop</div>' +
        keys.map((k) =>
          '<div class="lrn-belief"><b>' + CS.esc(k) + '</b><span>' + CS.esc(L.beliefs[k]) + '</span></div>'
        ).join("")
      : "";
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
        "<th>round</th><th>regret</th><th>pred error</th><th>baseline</th>" +
        "<th>regret</th><th>baseline</th></tr></thead></table>"
    );
    const body = document.createElement("tbody");
    for (const p of data.points) {
      const tr = document.createElement("tr");
      const cells = [
        String(p.i), Number(p.train).toFixed(2),
        Number(p.test).toFixed(2),
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
    const L = CS.session && CS.session.loop;
    const data = L ? chartData(L) : null;
    if (!data) { if (refs.viz) refs.viz.innerHTML = ""; return; }
    drawLoopChart(refs.viz, data);
  }

  /* Hand-rolled SVG line chart: x = round, y = regret (solid amber),
     baseline dotted gray; hairline grid, crosshair tooltip, table twin. */
  function drawLoopChart(host, data) {
    host.innerHTML = "";
    const pts = data.points;
    const N = pts.length;

    /* card head: title + legend + table toggle */
    const head = CS.el(
      '<div class="lrn-viz-head">' +
        '<div class="lrn-viz-tblock">' +
          '<div class="lrn-viz-title">policy quality per loop round</div>' +
          '<div class="lrn-legend">' +
            '<span class="lrn-key">' + keyLine(C_TRAIN, "") + "regret</span>" +
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
    /* dynamic y-scale: regret + baseline; prediction_error lives in the
       table/tooltip (visits-scale — a different axis than regret) */
    const vals = pts.map((p) => Math.abs(Number(p.train) || 0));
    if (data.baseline != null) vals.push(Math.abs(Number(data.baseline)));
    const Y_MAX = Math.max(0.5,
      Math.ceil(Math.max.apply(null, vals.concat([0.1])) * 1.15 * 10) / 10);

    const xAt = (k) => M.l + (N === 1 ? iw / 2 : ((pts[k].i - pts[0].i) / (pts[N - 1].i - pts[0].i)) * iw);
    const yAt = (v) => M.t + (1 - Math.max(0, Math.min(Y_MAX, v)) / Y_MAX) * ih;

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    plot.appendChild(svg);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "lrn-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Regret across " + N + " loop rounds");
    svg.style.fontFamily = "var(--font-mono)";
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

    /* grid + y ticks (hairlines, solid) */
    for (let g = 0; g <= 5; g++) {
      const v = (g / 5) * Y_MAX, y = yAt(v);
      S("line", { x1: M.l, y1: y, x2: W - M.r, y2: y, stroke: C_GRID, "stroke-width": 1 });
      T(M.l - 8, y + 3, v.toFixed(2), "muted").setAttribute("text-anchor", "end");
    }
    /* axes labels */
    T(0, 0, "regret", "muted", { transform: "translate(13 " + (M.t + ih / 2) + ") rotate(-90)", "text-anchor": "middle" });
    T(M.l + iw / 2, H - 10, "loop round", "muted", { "text-anchor": "middle" });

    /* x ticks: round numbers */
    const stride = N > 10 ? 2 : 1;
    pts.forEach((p, k) => {
      if (k % stride !== 0 && k !== N - 1) return;
      T(xAt(k), M.t + ih + 16, String(p.i), "muted").setAttribute("text-anchor", "middle");
    });

    /* baseline: dotted chrome line + selective direct label */
    if (data.baseline != null) {
      const y = yAt(data.baseline);
      S("line", { x1: M.l, y1: y, x2: W - M.r, y2: y, stroke: C_BASE, "stroke-width": 1.5, "stroke-dasharray": "2 5", "stroke-linecap": "round" });
      T(W - M.r + 6, y + 15, "base " + data.baseline.toFixed(2), "muted");
    }

    /* line builder + markers (surface ring keeps dots legible over the line) */
    const path = (get) => pts.map((p, k) => (k ? "L" : "M") + xAt(k).toFixed(1) + " " + yAt(get(p)).toFixed(1)).join(" ");
    S("path", { d: path((p) => p.train), fill: "none", stroke: C_TRAIN, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" });
    pts.forEach((p, k) => {
      S("circle", { cx: xAt(k), cy: yAt(p.train), r: 3.5, fill: C_TRAIN, stroke: "#fff", "stroke-width": 2 });
    });

    /* selective direct label at the last point */
    T(W - M.r + 6, yAt(pts[N - 1].train) + 3, Number(pts[N - 1].train).toFixed(2), "endlab");

    /* hover layer: crosshair + tooltip listing regret + pred error at that round */
    const cross = S("line", { x1: 0, y1: M.t, x2: 0, y2: M.t + ih, stroke: "#CCCCCC", "stroke-width": 1, opacity: 0 });
    const hoverDots = [C_TRAIN].map((c) =>
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
      tipWrap.hidden = false;
      const box = svg.getBoundingClientRect();
      const sx = box.width / W;
      tipWrap.style.left = Math.max(4, Math.min(plot.clientWidth - 154, (x * sx) + 10)) + "px";
      tipWrap.style.top = "14px";
      tipWrap.textContent = "";
      const rows = [
        ["round r" + p.i, null],
        ["regret " + Number(p.train).toFixed(2), C_TRAIN],
        p.test != null ? ["pred error " + Number(p.test).toFixed(1), C_TEST] : null,
        data.baseline != null ? ["baseline " + data.baseline.toFixed(2), C_BASE] : null,
      ];
      for (const row of rows) {
        if (!row) continue;
        const cell = document.createElement("div");
        cell.className = "lrn-tip-row" + (row[1] ? "" : " head");
        if (row[1]) { const key = CS.el('<span class="lrn-tip-key"></span>'); key.style.background = row[1]; cell.append(key); }
        cell.append(document.createTextNode(row[0]));
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
        CS.pay().then(() => { if (CS.isPaid() && MOUNT) renderTab(); }).catch(() => {});
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
    /* single root: CS.el returns only the first element of a template,
       so header + msgs + footer must live inside one wrapper */
    chat.innerHTML =
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
      "</footer>";

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
      let rEids = null;
      try {
        const res = await CS.chat(id, text);
        reply = res.reply;
        rEids = res.evidence_ids || null;
      } catch (e) {
        reply = (e && e.status === 402)
          ? "This session hasn't unlocked agent chat yet — the $19 unlock happens at checkout."
          : "(the agent dropped mid-thought — try again)";
      }

      typingEl.remove();
      typingAgent = null;
      pushMsg(id, "agent", reply);
      const cur = MOUNT && MOUNT.querySelector(".lrn-msgs");
      const node = bubble({ who: "agent", text: reply });
      (cur || msgs).appendChild(node);
      if (rEids && rEids.length) {
        (cur || msgs).appendChild(CS.el(
          '<div class="lrn-eids mono">' + rEids.map((x) => CS.esc(x)).join(" · ") + "</div>"));
      }
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

  /* ============================================================
     TAB C — act on the verdict (P2; server 402-gates on unpaid)
     Backend: POST /act → {drafts[], scores[], best_id,
     artifact_type, fallback_used}; "act" progress events arrive
     on the SSE stream and are re-emitted as act:progress.
     ============================================================ */
  function renderAct(pane, session) {
    if (!session || !session.verdict) {
      pane.append(CS.el(
        '<div class="lrn-empty mono">run the debate to a verdict first — drafts are seeded from the winning camp.</div>'));
      return;
    }
    const A = session.act || (session.act = { running: false, result: null });

    if (!CS.isPaid()) {
      const lock = CS.el(
        '<div class="lrn-pay">' +
          '<div class="lrn-kicker">5c · act</div>' +
          '<h2 class="lrn-pay-t">Owner-ready drafts, scored</h2>' +
          '<p class="lrn-pay-p">The winning camp&rsquo;s arguments seed three distinct drafts — promo copy, signage, schedule policy. A second judge scores them against the evidence and flags the best.</p>' +
          '<div class="lrn-pay-price mono">$19 · one-time unlock</div>' +
          '<button class="lrn-run" type="button">Unlock — $19' + (CS.STRIPE_LINK ? " (Stripe)" : " (demo payment)") + "</button>" +
          '<div class="lrn-pay-fine mono">' + (CS.STRIPE_LINK ? "secure checkout in a new tab" : "demo session — session is marked paid on the backend") + '</div>' +
        '</div>'
      );
      lock.querySelector(".lrn-run").addEventListener("click", () => {
        CS.pay().then(() => { if (CS.isPaid() && MOUNT) renderTab(); }).catch(() => {});
      });
      pane.append(lock);
      return;
    }

    /* suggestion chips — what Act can produce (UI affordance: the
       backend picks artifact_type itself; the chip annotates the
       run + the preview label). "design a flyer" triggers the
       flyer preview flow. */
    const CHIPS = ["design a flyer", "promo copy", "signage / flyer text",
      "menu item copy", "landing page snippet", "schedule policy", "launch plan"];
    const chipRow = CS.el('<div class="act-chips" aria-label="What act can produce">' +
      CHIPS.map((c) =>
        '<button class="act-chip' + (/flyer/i.test(c) ? " is-flyer" : "") +
        '" type="button">' + CS.esc(c) + "</button>").join("") +
      "</div>");

    if (!A.result && !A.running) {
      const card = CS.el(
        '<div class="lrn-hero">' +
          '<div class="lrn-kicker">5c · act</div>' +
          '<h2 class="lrn-hero-t">From verdict to drafts</h2>' +
          '<p class="lrn-hero-p">Three owner-ready drafts seeded from the winning camp, scored by a strong judge against the evidence. Pick the one you&rsquo;d actually post.</p>' +
          '<button class="lrn-run" type="button">Draft + score it <span aria-hidden="true">&rarr;</span></button>' +
        '</div>'
      );
      card.querySelector(".lrn-run").addEventListener("click", () => {
        runActJob(null);
      });
      pane.append(chipRow);
      pane.append(card);
      /* mock path: no drafts exist but the verdict is in — show a
         locally-generated sample flyer so the preview is verifiable */
      pane.append(flyerCard(stubDraftFromVerdict(session), true));
      return;
    }

    if (A.running) {
      pane.append(CS.el(
        '<div class="lrn-loop-head"><div class="lrn-loop-title">' +
          '<span class="lrn-kicker">5c · act</span><h2>Drafting…</h2></div>' +
          '<div class="lrn-loop-meta mono" id="lrn-act-meta"></div></div>'));
      pane.append(CS.el(
        '<div class="lrn-recalc mono"><span class="lrn-spin" aria-hidden="true">◷</span> ' +
        '<span id="act-prog">' + CS.esc((A && A.lastProgress) || "working…") + '</span></div>'));
      pane.append(CS.el(
        '<div class="lrn-foot-note">drafts + scores land here (~25–45 s). the strongest is flagged.</div>'));
      startTimer();
      return;
    }

    /* done — render the drafts */
    const R = A.result || {};
    const best = R.best_id;
    const drafts = (R.drafts || []).map((d) => {
      const sc = (R.scores || []).find((s2) => s2.id === d.id);
      const isBest = d.id === best;
      const el2 = CS.el(
        '<div class="lrn-draft' + (isBest ? " is-best" : "") + '">' +
          '<div class="lrn-draft-top">' +
            '<span class="lrn-iter-n mono">' + CS.esc(d.id || "?") + "</span>" +
            '<span class="lrn-iter-name">' + CS.esc(d.title || "") + "</span>" +
            (isBest ? '<span class="lrn-badge ok">BEST PICK</span>' : '<span class="lrn-badge no">runner-up</span>') +
            (sc ? '<span class="lrn-score mono">score ' + fmtN(sc.score) + "</span>" : "") +
            '<button class="dr-copy" type="button" title="Copy draft text">copy</button>' +
          '</div>' +
          '<div class="lrn-draft-body">' + CS.esc(d.body_text || "") + "</div>" +
          (d.rationale ? '<div class="lrn-foot-note">why: ' + CS.esc(d.rationale) + "</div>" : "") +
          (d.evidence_ids && d.evidence_ids.length
            ? '<div class="lrn-eids mono">' + d.evidence_ids.map((x) => CS.esc(x)).join(" · ") + "</div>" : "") +
        '</div>'
      );
      const cp = el2.querySelector(".dr-copy");
      if (cp) cp.addEventListener("click", (e) => {
        copyText(e.currentTarget, draftText(d), "copied ✓");
      });
      return el2;
    });
    const head = CS.el(
      '<div class="lrn-loop-head"><div class="lrn-loop-title">' +
        '<span class="lrn-kicker">5c · act</span><h2>Drafts, scored</h2></div>' +
        '<div class="lrn-loop-meta mono">' + CS.esc(((R.artifact_type || "") + (R.fallback_used ? " · fallback draft used" : ""))) + '</div></div>');
    pane.append(chipRow);
    pane.append(head);
    const grid = CS.el('<div class="lrn-drafts"></div>');
    drafts.forEach((el2) => grid.append(el2));
    pane.append(grid);
    /* winner → print-ready flyer preview */
    const winner = (R.drafts || []).find((x) => x.id === best) || (R.drafts || [])[0];
    if (winner) {
      pane.append(CS.el('<div class="flyer-sec-head mono">Flyer preview · ready to print' +
        (A.requestLabel ? " · " + CS.esc(A.requestLabel) : "") + "</div>"));
      pane.append(flyerCard(winner, false));
    }
  }

  /* chip / button → run the drafts job; label annotates run + preview */
  function runActJob(label) {
    const A = CS.session && (CS.session.act || (CS.session.act = { running: false, result: null }));
    if (!A || A.running) return;
    A.running = true;
    A.requestLabel = label || "";
    CS.runAct().catch(actError).finally(() => {
      A.running = false;
      if (activeTab === "act") renderTab();
    });
    renderTab();
  }

  function actError(e) {
    const pane = MOUNT && MOUNT.querySelector(".lrn-pane");
    if (!pane) return;
    const msg = String((e && e.message) || e || "act failed");
    const hint = (e && e.status === 402) ? " — unlock with the payment first." : "";
    pane.append(CS.el('<div class="lrn-foot-note lrn-warn">⚠ ' + CS.esc(msg + hint) + '</div>'));
    stopTimer();
  }

  /* ============================================================
     Flyer preview — print-ready promo sheet for the winning draft.
     Copy (clipboard + textarea fallback) + Print/save-PDF
     (@media print shows ONLY the flyer card, white background).
     Mock path: when the act result is missing but the verdict is
     in, a locally-generated stub draft renders (labeled
     "sample preview") so the preview is verifiable in ?mock=1.
     ============================================================ */
  function stubDraftFromVerdict(session) {
    const v = (session && session.verdict) || {};
    return {
      id: "sample",
      title: "Your verdict — turned into a flyer",
      body_text: v.recommendation ||
        "The swarm's recommendation lands here once the verdict is in.",
      evidence_ids: [],
      rationale: "sample preview, generated from the verdict — run Draft + score it for the scored set",
    };
  }

  function draftText(d) {
    const eids = (d.evidence_ids || []).join(" · ");
    return [d.title || "", "", d.body_text || "",
      (eids ? "Evidence: " + eids : "")].filter(Boolean).join("\n");
  }

  async function copyText(btn, text, okLabel) {
    const restore = btn.dataset.restore || btn.textContent;
    btn.dataset.restore = restore;
    const done = (msg) => {
      btn.textContent = msg;
      setTimeout(() => { btn.textContent = btn.dataset.restore; btn.disabled = false; }, 1500);
    };
    btn.disabled = true;
    try {
      await navigator.clipboard.writeText(text);
      done("copied ✓");
      return;
    } catch (e) { /* fall through to execCommand */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done("copied ✓");
    } catch (e2) {
      done("copy failed");
    }
  }

  function flyerCard(d, stub) {
    const eids = (d.evidence_ids || []).map((x) =>
      '<span class="flyer-eid mono">' + CS.esc(x) + "</span>").join("");
    const card = CS.el(
      '<div class="flyer-card' + (stub ? " is-stub" : "") + '">' +
        '<div class="flyer-brand">' +
          '<img src="assets/logo.png" alt="" width="28" height="28">' +
          '<span class="flyer-word">Call<b>Crowd</b></span>' +
          (stub ? '<span class="flyer-stub-tag">sample preview</span>' : "") +
        "</div>" +
        '<h3 class="flyer-headline">' + CS.esc(d.title || "Flyer") + "</h3>" +
        '<div class="flyer-copy">' + CS.esc(d.body_text || "") + "</div>" +
        (eids ? '<div class="flyer-eids">' + eids + "</div>" : "") +
        '<div class="flyer-actions">' +
          '<button class="flyer-btn flyer-copybtn" type="button">Copy flyer text</button>' +
          (!stub ? '<button class="flyer-btn flyer-pdfbtn" type="button">&#10515; Flyer (PDF)</button>' : "") +
          '<button class="flyer-btn flyer-print" type="button">Print / save PDF</button>' +
        "</div>" +
      "</div>"
    );
    card.querySelector(".flyer-copybtn").addEventListener("click", (e) => {
      copyText(e.currentTarget, flyerText(d), "copied ✓");
    });
    const pdfBtn = card.querySelector(".flyer-pdfbtn");
    if (pdfBtn) pdfBtn.addEventListener("click", () => {
      /* real print-ready PDF from the backend: GET .../flyer.pdf?draft=<id> */
      const base = window.CS && CS.API_BASE || "";
      const sid = window.CS && CS.session && CS.session.sid || "";
      if (!sid) return;
      window.open(base + "/api/sessions/" + encodeURIComponent(sid) +
        "/flyer.pdf?draft=" + encodeURIComponent(d.id || ""), "_blank");
    });
    card.querySelector(".flyer-print").addEventListener("click", () => window.print());
    return card;
  }
})();