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
    const color = campName ? campColor(n, campName) : "#8A8A8A";
    const p = persona(a.agentId);
    const name = (p && p.name) || a.agent || "agent";
    const seg = segName(a.agentId);
    const stance = String(a.stance || "neutral");
    const badgeCls = stance === "support" ? "ok" : stance === "oppose" ? "err" : "mut";
    const badgeTxt = a.stance_label ||
      (stance === "support" ? "Yes" : stance === "oppose" ? "No" : "Undecided");
    const badgeStyle = "background:" +
      (badgeCls === "ok" ? "#0F766E" : badgeCls === "err" ? "#B91C1C" : "#8A8A8A") + "14;color:" +
      (badgeCls === "ok" ? "#0F766E" : badgeCls === "err" ? "#B91C1C" : "#5A5A5A");
    const cites = (a.cites || []).map((id) => {
      const lbl = evidenceLabel(id);
      return `<span class="db-cite">${CS.esc(id)}${lbl ? ` <i>·</i> ${CS.esc(lbl)}` : ""}</span>`;
    }).join("");

    push(CS.el(
      `<article class="db-card${S.animate ? " rise" : ""}" data-round="${n}" data-pid="${CS.esc(a.agentId || "")}" ` +
      `style="--camp:${color};--camp-tint:${color}14">` +
      `<span class="db-av">${CSE.avatar ? CSE.avatar(a.agentId || name, 36) : ""}</span>` +
      '<div class="db-card-main">' +
      '<div class="db-card-head">' +
      `<span class="db-agent">${CS.esc(name)}</span>` +
      (seg ? `<span class="db-seg">${CS.esc(seg)}</span>` : "") +
      `<span class="db-stance ${badgeCls}" style="${badgeStyle}">${CS.esc(badgeTxt)}</span>` +
      (campName ? `<span class="db-camp" style="color:${color};border-color:${color}59;background:${color}0d">${CS.esc(campName)}</span>` : "") +
      "</div>" +
      `<p class="db-text">${CS.esc(a.text || "")}</p>` +
      (cites ? `<div class="db-cites">${cites}</div>` : "") +
      "</div></article>"
    ));
  }

  /* camp summary card — the backend emits camps per round end
     (member_ids + top_arguments). Rendered in the digest slot. */
  function addCampSummary(n, c) {
    if (!c) return;
    const color = campColor(n, c.name);
    const members = (c.member_ids || []).map((id) =>
      (persona(id) || {}).name || id);
    const bullets = (c.top_arguments || []).map((t) => `<li>${CS.esc(t)}</li>`).join("");
    push(CS.el(
      `<div class="db-digest" data-round="${n}" style="--camp:${color}">` +
      `<div class="db-digest-label">ROUND ${n} · CAMP — ${CS.esc(c.name)} · ${members.length} AGENTS</div>` +
      (members.length ? `<div class="db-cites db-camp-members">${members.map((m) => `<span class="db-cite">${CS.esc(m)}</span>`).join("")}</div>` : "") +
      (bullets ? `<ul class="db-digest-bullets">${bullets}</ul>` : "") +
      "</div>"
    ));
  }

  /* one full round from session (catch-up path) */
  function drawRound(r) {
    addDivider(r.n);
    for (const st of (r.stances || [])) {
      addArg(r.n, st.camp, {
        agentId: st.persona_id, agent: st.persona_name || st.persona_id,
        text: st.reason, cites: st.evidence_ids,
        stance: st.stance, stance_label: st.stance_label,
      });
    }
    for (const c of (r.camps || [])) addCampSummary(r.n, c);
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

  CS.on("debate:camp", (e) => {
    if (!alive()) return;
    const d = e.detail || {};
    addCampLive(d.round, d);
    paintLegend();
    paintRail();
  });

  /* one live camp event: append the summary card and retro-tag the
     member stance cards that already streamed (camps land at round end) */
  function addCampLive(n, c) {
    addCampSummary(n, c);
    const r = round(n);
    if (r) {
      for (const st of r.stances) {
        if ((c.member_ids || []).includes(st.persona_id)) st.camp = c.name;
      }
    }
    for (const child of S.feed.children) {
      if (child.dataset.round !== String(n) || !child.dataset.pid) continue;
      if (!(c.member_ids || []).includes(child.dataset.pid)) continue;
      const chip = child.querySelector(".db-camp");
      if (chip) { chip.textContent = c.name; }
      else {
        const head = child.querySelector(".db-card-head");
        const color = campColor(n, c.name);
        if (head) head.insertAdjacentHTML("beforeend",
          `<span class="db-camp" style="color:${color};border-color:${color}59;background:${color}0d">${CS.esc(c.name)}</span>`);
      }
      child.style.setProperty("--camp", campColor(n, c.name));
      child.style.setProperty("--camp-tint", campColor(n, c.name) + "14");
    }
  }

  CS.on("debate:arg", (e) => {
    if (!alive()) return;
    const d = e.detail || {};
    setActive(d.round, false);
    addArg(d.round, d.camp, { agent: d.agent, agentId: d.agent_id, text: d.text, cites: d.cites || [] });
    paintRail();
  });

  CS.on("debate:stance", (e) => {
    if (!alive()) return;
    const d = e.detail || {};
    setActive(d.round, false);
    addArg(d.round, d.camp, {
      agent: d.persona_name, agentId: d.persona_id,
      text: d.reason, cites: d.evidence_ids || [],
      stance: d.stance, stance_label: d.stance_label,
    });
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