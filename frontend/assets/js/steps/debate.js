/* ============================================================
   Customer Swarm — steps/debate.js (Step 3 · Debate)
   Vertical live feed of agent arguments, 2 rounds, camp-colored.
   Renders from CS.session only; reacts to bridge bus events.
   ============================================================ */
(function () {
  "use strict";

  const CS = window.CS || (window.CS = {});
  const CSE = window.CSEffects || {};

  /* ---------- per-mount view state ---------- */
  const S = {
    root: null, feedWrap: null, feed: null, railEl: null, railInner: null,
    legendEl: null, tabsEl: null, emptyEl: null,
    active: 1,          // active round shown in the feed
    animate: true,      // false while drawing catch-up history
    pin: false,         // user manually picked a round tab
  };

  const alive = () => !!(S.root && document.documentElement.contains(S.root));
  const cs = () => CS.session || {};

  function rounds() { return (cs().debate && cs().debate.rounds) || []; }
  function round(n) { return rounds().find((r) => r.n === n); }

  function campColor(n, name) {
    const r = round(n);
    if (!r || !r.camps.length) return CS.PAL[0];
    const i = r.camps.findIndex((c) => c.name === name);
    return CS.PAL[(i < 0 ? 0 : i) % CS.PAL.length];
  }

  function persona(id) { return (cs().personas || []).find((p) => p.id === id) || null; }
  function segName(id) {
    const p = persona(id);
    if (!p) return "";
    const s = (cs().segments || []).find((x) => x.id === p.segment);
    return s ? s.name : "";
  }
  function evidenceLabel(id) {
    const e = (cs().evidence || []).find((x) => x.id === id);
    return e ? (e.source_label || "") : "";
  }

  /* ============================================================
     render — catch-up safe: draws whatever history exists at once,
     then keeps appending live events.
     ============================================================ */
  function render(mount, session) {
    session = session || cs();
    S.root = CS.el([
      '<div class="db-root">',
      '  <div class="db-top">',
      '    <div class="db-tabs" role="tablist" aria-label="Debate rounds"></div>',
      '    <div class="db-legend"></div>',
      "  </div>",
      '  <div class="db-body">',
      '    <div class="db-feed" tabindex="0"><div class="db-feed-inner"></div></div>',
      '    <aside class="db-rail"><div class="db-rail-inner"></div></aside>',
      "  </div>",
      "</div>",
    ].join(""));

    S.feedWrap = S.root.querySelector(".db-feed");
    S.feed = S.root.querySelector(".db-feed-inner");
    S.tabsEl = S.root.querySelector(".db-tabs");
    S.legendEl = S.root.querySelector(".db-legend");
    S.railEl = S.root.querySelector(".db-rail");
    S.railInner = S.root.querySelector(".db-rail-inner");
    S.emptyEl = null;
    S.pin = false;

    mount.innerHTML = "";
    mount.appendChild(S.root);

    S.animate = false; // catch-up draw: full history at once, no backlog
    const rs = rounds();
    if (!rs.length) {
      // no debate content yet: one waiting card, hidden once content lands
      S.emptyEl = waitEl("awaiting camp clustering…");
      S.feed.appendChild(S.emptyEl);
    } else {
      for (const r of rs) drawRound(r);
    }
    S.animate = true;

    S.active = rs.length ? rs[rs.length - 1].n : 1;
    paintTabs();
    paintLegend();
    paintRail();
    applyFilter();
    scrollEnd();
  }

  function waitEl(txt, cls) {
    return CS.el(`<div class="db-wait ${cls || ""}"><span class="db-pulse"></span><span class="db-wait-txt">${CS.esc(txt)}</span></div>`);
  }

  /* ============================================================
     node factories
     ============================================================ */
  function addDivider(n) {
    const sub = n <= 1
      ? "camps clustered from 50 agents · arguments stream live"
      : "camps re-clustered; round 2 agents read the opposing camp's strongest points";
    push(CS.el(
      `<div class="db-divider" data-round="${n}">` +
      '<span class="db-div-line"></span>' +
      `<span class="db-div-txt"><b>ROUND ${n}</b><i>${CS.esc(sub)}</i></span>` +
      '<span class="db-div-line"></span>' +
      "</div>"
    ));
  }

  function addArg(n, campName, a) {
    const color = campColor(n, campName);
    const p = persona(a.agentId);
    const name = (p && p.name) || a.agent || "agent";
    const seg = segName(a.agentId);
    const cites = (a.cites || []).map((id) => {
      const lbl = evidenceLabel(id);
      return `<span class="db-cite">${CS.esc(id)}${lbl ? ` <i>·</i> ${CS.esc(lbl)}` : ""}</span>`;
    }).join("");

    push(CS.el(
      `<article class="db-card${S.animate ? " rise" : ""}" data-round="${n}" ` +
      `style="--camp:${color};--camp-tint:${color}14">` +
      `<span class="db-av">${CSE.avatar ? CSE.avatar(a.agentId || name, 36) : ""}</span>` +
      '<div class="db-card-main">' +
      '<div class="db-card-head">' +
      `<span class="db-agent">${CS.esc(name)}</span>` +
      (seg ? `<span class="db-seg">${CS.esc(seg)}</span>` : "") +
      `<span class="db-camp" style="color:${color};border-color:${color}59;background:${color}0d">${CS.esc(campName)}</span>` +
      "</div>" +
      `<p class="db-text">${CS.esc(a.text || "")}</p>` +
      (cites ? `<div class="db-cites">${cites}</div>` : "") +
      "</div></article>"
    ));
  }

  function digestFor(n, evt) {
    const r = round(n) || {};
    evt = evt || {};
    const bullets = (evt.bullets || []);
    if (bullets.length) return { about_camp: evt.about_camp || "", bullets, syn: false };
    // graceful fallback: a round digest without bullets summarizes the camps
    if ((r.camps || []).length) {
      return { about_camp: "", bullets: r.camps.map((c) => c.summary || ""), syn: true };
    }
    return null;
  }

  function addDigest(n, d) {
    const dig = digestFor(n, d);
    if (!dig) return;
    const bullets = dig.bullets
      .filter(Boolean)
      .map((b) => `<li>${CS.esc(b)}</li>`)
      .join("");
    push(CS.el(
      `<div class="db-digest" data-round="${n}">` +
      `<div class="db-digest-label">${dig.syn ? `ROUND ${n} DIGEST · CAMP POSITIONS` : "OPPOSING CAMP DIGEST"}</div>` +
      (dig.about_camp ? `<div class="db-digest-about">→ ${CS.esc(dig.about_camp)}</div>` : "") +
      `<ul class="db-digest-bullets">${bullets}</ul>` +
      "</div>"
    ));
  }

  function addDemoted(d) {
    const n = d.round || S.active;
    const color = CS.color(d.agentId || d.agent || "x");
    push(CS.el(
      `<article class="db-card db-demoted${S.animate ? " rise" : ""}" data-round="${n}" ` +
      `style="--camp:${color};--camp-tint:#00000008">` +
      '<span class="db-warn">⚠</span>' +
      `<span class="db-av">${CSE.avatar ? CSE.avatar(d.agentId || d.agent || "x", 36) : ""}</span>` +
      '<div class="db-card-main">' +
      '<div class="db-card-head">' +
      `<span class="db-agent">${CS.esc(d.agent || "agent")}</span>` +
      '<span class="db-demoted-tag">demoted</span>' +
      "</div>" +
      `<p class="db-text"><s>${CS.esc(d.text || "")}</s></p>` +
      `<div class="db-reason">${CS.esc(d.reason || "fabricated evidence demoted to neutral")}</div>` +
      "</div></article>"
    ));
  }

  /* one full round from session (catch-up path) */
  function drawRound(r) {
    addDivider(r.n);
    for (const c of r.camps) for (const a of c.args) addArg(r.n, c.name, a);
    addDigest(r.n, r.digest || {});
    for (const dm of (cs().demoted || [])) {
      if (dm.round === r.n) addDemoted(dm);
    }
  }

  /* ============================================================
     rail / tabs / legend / filter
     ============================================================ */
  function paintRail() {
    if (!alive()) return;
    const r = round(S.active);
    const camps = r ? r.camps : [];
    const total = camps.reduce((a, c) => a + (c.size || 0), 0);
    const rows = camps.map((c, i) => {
      const color = CS.PAL[i % CS.PAL.length];
      const w = total ? Math.max(3, Math.round(((c.size || 0) / total) * 100)) : 0;
      return (
        `<div class="db-bar-row">` +
        `<span class="db-bar-name"><i class="db-bar-dot" style="background:${color}"></i>${CS.esc(c.name)}</span>` +
        `<span class="db-bar-track"><span class="db-bar-fill" style="width:${w}%;background:${color}"></span></span>` +
        `<b class="db-bar-count">${c.size || 0}</b>` +
        `</div>`
      );
    }).join("");

    S.railInner.innerHTML =
      '<div class="db-rail-head">CAMP SIZE</div>' +
      (rows ||
        `<div class="db-rail-empty">no camps yet<br>clustering ${total || "50"} agents…</div>`) +
      (rows
        ? `<div class="db-rail-note">share of 50 agents per camp · ${total}/50 in round ${S.active}</div>`
        : "");
  }

  function paintTabs() {
    if (!alive()) return;
    const max = Math.max(2, rounds().length);
    let html = "";
    for (let n = 1; n <= max; n++) {
      const known = !!round(n);
      html += `<button class="db-tab${n === S.active ? " on" : ""}${known ? "" : " ghost"}" ` +
        `data-round="${n}" role="tab" aria-selected="${n === S.active}">ROUND ${n}</button>`;
    }
    S.tabsEl.innerHTML = html;
    for (const b of S.tabsEl.querySelectorAll(".db-tab")) {
      b.addEventListener("click", () => {
        S.pin = true;
        S.active = Number(b.dataset.round);
        paintTabs();
        paintLegend();
        paintRail();
        applyFilter();
        scrollEnd();
      });
    }
  }

  function paintLegend() {
    if (!alive()) return;
    const r = round(S.active);
    const camps = r ? r.camps : [];
    S.legendEl.innerHTML = camps.length
      ? camps.map((c, i) => {
          const color = CS.PAL[i % CS.PAL.length];
          return `<span class="db-leg"><span class="db-leg-dot" style="background:${color}"></span>` +
            `${CS.esc(c.name)}<b>${c.size || 0}</b></span>`;
        }).join("")
      : '<span class="db-leg db-leg-wait">clustering…</span>';
  }

  function applyFilter() {
    if (!alive()) return;
    let visible = 0;
    for (const child of S.feed.children) {
      if (child === S.emptyEl) continue;
      const dr = Number(child.dataset.round || 0);
      const show = !dr || dr === S.active;
      child.hidden = !show;
      if (show) visible++;
    }
    if (!S.emptyEl) {
      S.emptyEl = waitEl(`no arguments in round ${S.active} yet — camps clustering…`, "db-empty");
      S.feed.appendChild(S.emptyEl);
    }
    S.emptyEl.hidden = visible > 0;
    if (rounds().length) {
      S.emptyEl.querySelector(".db-wait-txt").textContent =
        `no arguments in round ${S.active} yet — camps clustering…`;
    }
  }

  function nearBottom() {
    if (!S.feedWrap) return true;
    return S.feedWrap.scrollHeight - S.feedWrap.scrollTop - S.feedWrap.clientHeight < 180;
  }
  function scrollEnd() {
    if (S.feedWrap) S.feedWrap.scrollTop = S.feedWrap.scrollHeight;
  }
  function push(node) {
    if (!alive() || !S.feed) return;
    const stick = nearBottom();
    S.feed.appendChild(node);
    applyFilter();
    if (stick) scrollEnd();
  }

  /* ============================================================
     live bus wiring (bridge applies the event to session first)
     ============================================================ */
  function setActive(n, force) {
    if (force || !S.pin) {
      const changed = S.active !== n;
      S.active = n;
      if (changed) { paintTabs(); paintLegend(); paintRail(); }
    }
  }

  CS.on("debate:round", (e) => {
    if (!alive()) return;
    const d = e.detail || {};
    addDivider(d.n);
    setActive(d.n, true); // a new round always pulls the viewer forward
    paintTabs(); paintLegend(); paintRail(); scrollEnd();
  });

  CS.on("debate:camp", () => {
    if (!alive()) return;
    paintLegend();
    paintRail();
  });

  CS.on("debate:arg", (e) => {
    if (!alive()) return;
    const d = e.detail || {};
    setActive(d.round, false);
    addArg(d.round, d.camp, { agent: d.agent, agentId: d.agent_id, text: d.text, cites: d.cites || [] });
    paintRail();
  });

  CS.on("debate:digest", (e) => {
    if (!alive()) return;
    const d = e.detail || {};
    setActive(d.round, false);
    addDigest(d.round || S.active, d);
  });

  CS.on("debate:demoted", (e) => {
    if (!alive()) return;
    const d = e.detail || {};
    setActive(d.round, false);
    addDemoted(d);
  });

  CS.on("debate:done", () => {
    if (!alive()) return;
    paintRail();
  });

  CS.register({
    id: "debate",
    num: 3,
    title: "Debate",
    short: "2 rounds, camps",
    render,
  });
})();