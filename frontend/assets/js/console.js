/* ============================================================
   Customer Swarm — console.js
   The shell: launcher → runview, step routing, live event feed.
   Talks ONLY through window.CS (bridge.js). Steps register
   themselves; step order comes from CS.STEPS, never hardcoded
   (fallbacks only when steps haven't registered yet).
   ============================================================ */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);

  /* auto-advance: event name → step index (frontend positions) */
  const AUTO = {
    "session:start": 0,
    "scout:done": 1,
    "debate:round": 2,
    "verdict": 3,
    "loop:done": 4,
  };

  let manualNav = null;    // step index the user last clicked into
  let frontier = -1;       // highest step index the stream reached via auto-advance
  let eventCount = 0;
  let autoStick = true;    // feed autoscroll (false once user scrolled up >100px)
  let lastKey = "";

  function stepsTotal() { return (window.CS && CS.STEPS.length) || 5; }

  function tr(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function ts() {
    const d = new Date();
    const p = (n, l) => String(n).padStart(l || 2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" +
      p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3);
  }
  function familyOf(cls) {
    return /b2b|saas|professional|corporate/i.test(String(cls || ""))
      ? "professionals" : "consumers";
  }

  /* ============================================================
     LIVE MODE: window.CS_API_BASE set + ?live=1&sid=… in the URL
     → CS.start gets {live:true, sid} and the bridge opens SSE.
     ============================================================ */
  function liveOpts() {
    if (!window.CS_API_BASE || params.get("live") !== "1") return null;
    const sid = params.get("sid");
    return sid ? { live: true, sid } : null;
  }

  /* ============================================================
     Feed pane — one mono line per bus event
     Returns pre-escaped html so counts can be <b>-wrapped.
     ============================================================ */
  function feedText(name, d) {
    if (!d) d = {};
    switch (name) {
      case "session:start":
        return ["session opened · " + CS.esc(d.business || "business"), "fl-hi"];
      case "scout:status":
        return ["business_class: " + CS.esc(d.business_class || "?") +
          " — persona family: " + familyOf(d.business_class), "fl-hi"];
      case "scout:source": {
        const st = d.status || "pending";
        const bits = [];
        if (d.count != null) bits.push(CS.esc(d.count));
        if (d.note) bits.push(CS.esc(tr(d.note, 44)));
        return [CS.esc(d.label || d.key || "source") + " · " +
          (bits.join(" · ") || CS.esc(st)), "fl-src-" + st];
      }
      case "scout:reviews":
        return [(d.items || []).length + " reviews streamed", ""];
      case "scout:done":
        return ["scout complete · " + CS.esc(d.total != null ? d.total : "?") +
          " items collected", "fl-hi"];
      case "evidence":
        return ["card " + CS.esc(d.id || "?") + " · " + CS.esc(tr(d.claim, 62)), "fl-dim"];
      case "segment":
        return [CS.esc(d.name || d.id || "segment") + " · n=" +
          CS.esc(d.size != null ? d.size : "?"), "fl-hi"];
      case "persona":
        return [CS.esc(d.name || d.id || "agent") + " joined · " +
          CS.esc(d.segment || ""), "fl-dim"];
      case "debate:round":
        return ["round " + CS.esc(d.n) + " opens", "fl-hi"];
      case "debate:camp":
        return ["camp “" + CS.esc(d.name || "") + "” · " +
          CS.esc(d.size != null ? d.size : "?") + " agents", ""];
      case "debate:arg":
        return [CS.esc(d.agent || "agent") + " · " + CS.esc(tr(d.text, 90)), "fl-arg"];
      case "debate:digest":
        return [d.about_camp ? "digest → " + CS.esc(d.about_camp)
          : "round " + CS.esc(d.n) + " digest", "fl-dim"];
      case "debate:demoted":
        return [CS.esc(d.agent || "agent") + " demoted · " +
          CS.esc(tr(d.reason, 60)), "fl-warn"];
      case "debate:done":
        return ["round " + CS.esc(d.n) + " closed", "fl-dim"];
      case "verdict": {
        const c = d.confidence != null ? Math.round(d.confidence * 100) : null;
        return ["verdict in" + (c != null ? " · confidence " + c + "%" : ""), "fl-hi"];
      }
      case "loop:start":
        return ["market loop running · seed " + CS.esc(d.seed != null ? d.seed : "?"), "fl-hi"];
      case "loop:iter":
        return ["iter " + CS.esc(d.n) + " · " + CS.esc(tr(d.proposal, 40)) +
          " · err " + CS.esc(d.error != null ? d.error : "?"), "fl-dim"];
      case "loop:done":
        return ["market loop complete · beliefs rewritten", "fl-hi"];
      case "stream:done":
        return ["stream complete — " + stepsTotal() + " steps rendered", "fl-hi"];
      case "paid":
        return ["deep-dive unlocked (paid)", "fl-hi"];
      default:
        return ["", ""];
    }
  }

  function appendFeed(name, html, cls) {
    const term = $("#feed-term"), count = $("#feed-count");
    if (!term) return;
    const row = CS.el(
      '<div class="fl ' + (cls || "") + '">' +
      '<span class="fl-time">' + ts() + "</span>" +
      '<span class="fl-name">' + CS.esc(name) + "</span>" +
      (html ? '<span class="fl-text">' + html + "</span>" : "") +
      "</div>"
    );
    term.appendChild(row);
    while (term.children.length > 200) term.removeChild(term.firstChild);
    if (autoStick) term.scrollTop = term.scrollHeight;
    if (count) count.textContent = eventCount + " events";
  }

  function setDot(mode) {
    const dot = $("#run-dot"), lab = $("#run-status");
    if (dot) dot.className = mode === "done" ? "dot done" : "dot proc";
    if (lab) lab.textContent = mode === "done" ? "complete" : "running";
  }

  /* 4 stat tiles, rebuilt from CS.session after every event */
  function renderStats() {
    const box = $("#feed-stats");
    if (!box) return;
    const s = CS.session;
    if (!s) { box.innerHTML = ""; return; }
    const srcDone = s.sources.filter((x) => x.status && x.status !== "pending").length;
    const srcTarget = Math.max(7, s.sources.length || 0);
    const roundTotal = ((window.CS_SESSION_DEMO && window.CS_SESSION_DEMO.debate &&
      window.CS_SESSION_DEMO.debate.rounds) || []).length || 2;
    const tiles = [
      [srcDone + "/" + srcTarget, "sources"],
      [String(s.evidence.length), "evidence"],
      [String(s.personas.length), "agents"],
      [(s.debate && s.debate.rounds.length || 0) + "/" + roundTotal, "round"],
    ];
    box.innerHTML = tiles.map((t) =>
      '<div class="fstat"><b>' + CS.esc(t[0]) + "</b><span>" + t[1] + "</span></div>"
    ).join("");
  }

  /* ============================================================
     Step routing
     ============================================================ */
  function autoAdvance(t) {
    if (typeof t !== "number") return;
    const total = stepsTotal();
    const idx = Math.max(0, Math.min(t, total - 1));
    if (idx <= frontier) return;              // already passed — never pull back
    frontier = idx;
    if (idx <= CS.currentStep) return;        // user is there or ahead
    if (manualNav != null && idx < manualNav) return; // user navigated ahead — don't yank
    gotoStep(idx);
  }

  function gotoStep(i) {
    const mount = $("#step-mount");
    if (!mount) return;
    const step = CS.STEPS[i] || null;
    CS.currentStep = i;
    try {
      mount.innerHTML = "";
      if (step && typeof step.render === "function") {
        const r = step.render(mount, CS.session);
        if (r && typeof r.catch === "function") r.catch((err) => stepError(mount, err));
      } else if (!step) {
        mount.innerHTML = '<div class="step-empty">❖ waiting for step ' +
          CS.esc(i + 1) + " to register…</div>";
      }
    } catch (err) { stepError(mount, err); }
    const ind = $("#step-indicator");
    if (ind) {
      ind.innerHTML = "<b>Step " + CS.esc(i + 1) + "/" + CS.esc(CS.STEPS.length || 5) +
        "</b> · " + (step ? CS.esc(step.title) : "…");
    }
    renderTabs();
    mount.scrollTop = 0;
  }

  function stepError(mount, err) {
    mount.innerHTML = '<div class="step-error">step crashed — details in the dev console</div>';
    if (window.console) console.error("[CS step render]", err);
  }

  /* step tabs — injected as the top rail of the feed pane */
  function ensureRail() {
    const pane = $(".feed-pane");
    if (!pane) return null;
    let rail = pane.querySelector(".step-rail");
    if (!rail) {
      rail = CS.el('<div class="step-rail"></div>');
      rail.addEventListener("click", (e) => {
        const btn = e.target.closest(".rtab");
        if (!btn) return;
        const i = Number(btn.dataset.i);
        if (!CS.STEPS[i]) return;
        manualNav = i;
        gotoStep(i);
      });
      pane.prepend(rail);
    }
    return rail;
  }

  function renderTabs() {
    const rail = ensureRail();
    if (!rail) return;
    rail.innerHTML = CS.STEPS.map((st, i) => {
      const on = i === CS.currentStep ? " on" : "";
      return '<button class="rtab' + on + '" data-i="' + i + '" title="' +
        CS.esc(st.title) + '"><b>' + String(st.num || i + 1).padStart(2, "0") +
        "</b><span>" + CS.esc(st.short || st.title) + "</span></button>";
    }).join("");
  }

  function remountIfBlank() {
    const mount = $("#step-mount");
    if (CS.currentStep < 0 || !mount || mount.children.length) return;
    if (CS.STEPS[CS.currentStep]) gotoStep(CS.currentStep);
  }

  /* ============================================================
     Bus wiring
     ============================================================ */
  const NAMES = ["session:start", "scout:status", "scout:source", "scout:reviews",
    "scout:done", "evidence", "segment", "persona", "debate:round", "debate:camp",
    "debate:arg", "debate:digest", "debate:demoted", "debate:done", "verdict",
    "loop:start", "loop:iter", "loop:done", "stream:done", "paid"];

  function wireBus() {
    NAMES.forEach((n) => CS.on(n, (e) => onEvent(n, e.detail)));
    CS.on("step:target", (e) => autoAdvance(e.detail && e.detail.index));
    CS.on("steps:changed", () => { renderTabs(); remountIfBlank(); });
  }

  function onEvent(name, d) {
    if (!d) d = {};
    /* CS.start emits session:start, then the replay driver emits it again — dedupe */
    const key = name + "|" + JSON.stringify(d, (k, v) => (v === undefined ? null : v));
    const dup = (name === "session:start") && key === lastKey;
    lastKey = key;

    eventCount++;
    const pair = feedText(name, d);
    if (!dup) appendFeed(name, pair[0], pair[1]);

    if (name === "session:start") {
      const tag = $("#biz-tag");
      if (tag) tag.textContent = d.business || "";
      setDot("run");
    }
    if (name === "stream:done") setDot("done");
    if (name === "loop:start") setDot("run");
    if (name === "loop:done") setDot("done");

    renderStats();

    const t = AUTO[name];
    if (t != null) autoAdvance(t);
  }

  /* ============================================================
     Launcher
     ============================================================ */
  function bindStart() {
    const btn = $("#start-btn");
    if (!btn) return;
    const go = () => {
      if ((window.CS && CS.state) === "running") return;
      const name = ($("#biz-name") && $("#biz-name").value.trim()) || "Cafe 210 West";
      const demoQ = (window.CS_SESSION_DEMO && window.CS_SESSION_DEMO.question) || "";
      const question = ($("#biz-question") && $("#biz-question").value.trim()) || demoQ;
      const launcher = $("#launcher"), run = $("#runview");
      if (launcher) launcher.hidden = true;
      if (run) run.hidden = false;

      const opts = liveOpts();
      appendFeed("console", opts
        ? "live channel opened · sid " + CS.esc(opts.sid)
        : "mock replay attached", "fl-hi");
      CS.start(name, question, opts || {});
    };
    btn.addEventListener("click", go);
    ["#biz-name", "#biz-question"].forEach((sel) => {
      const elx = $(sel);
      if (elx) elx.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); }
      });
    });
  }

  /* ============================================================
     Init
     ============================================================ */
  function init() {
    wireBus();
    bindStart();
    ensureRail();
    renderTabs();
    renderStats();

    const ind = $("#step-indicator");
    if (ind) ind.innerHTML = "<b>Step —/" + CS.esc(stepsTotal()) + "</b> · awaiting session";

    const back = $("#back-btn");
    if (back) back.addEventListener("click", () => location.reload());

    /* feed autoscroll pauses when the user scrolls up >100px */
    const term = $("#feed-term");
    if (term) term.addEventListener("scroll", () => {
      autoStick = (term.scrollHeight - term.scrollTop - term.clientHeight) <= 100;
    });

    /* Stripe success redirect */
    if (params.has("paid")) {
      try { CS.markPaid(); } catch (e) { /* noop */ }
    }
  }

  init();
})();