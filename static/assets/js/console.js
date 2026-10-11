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
  /* backend details become plain guidance for the owner */
  function plainError(msg) {
    msg = String(msg || "we couldn't reach the swarm");
    if (/failed to fetch|networkerror|unreachable/i.test(msg))
      return "we couldn't reach the swarm right now — check the backend is running and try again.";
    if (/session still/i.test(msg))
      return "the scouts are still reading — give it a few seconds and try again.";
    if (/session not found/i.test(msg))
      return "this session is no longer available — start a new one.";
    return msg;
  }

  /* ============================================================
     MODE: live against the backend by default (same origin).
     ?mock=1 replays the backend's recorded fixture through the
     same event vocabulary — useful for rehearsal / weak Wi-Fi.
     ============================================================ */
  function liveOpts() {
    return { mock: params.get("mock") === "1" };
  }

  /* ============================================================
     Link → business name. Google Maps (/place/<slug>/), Yelp
     (/biz/<slug>/), or any site (domain words). Best-effort; the
     owner confirms before we scout.
     ============================================================ */
  function nameFromUrl(raw) {
    let name = "";
    try {
      const u = new URL(raw);
      const path = decodeURIComponent(u.pathname || "");
      let m = path.match(/\/place\/([^/@]+)/);
      if (m) name = m[1].replace(/\+/g, " ");
      if (!name) {
        m = path.match(/\/biz\/([^/]+)/);
        if (m) name = m[1].replace(/-{2,}/g, " ").replace(/-/g, " ");
      }
      if (!name) {
        const host = String(u.hostname || "").replace(/^www\./, "");
        name = host.split(".")[0].replace(/[-_]+/g, " ");
      }
    } catch (e) { name = ""; }
    name = String(name).replace(/\s+/g, " ").trim();
    /* town hints inside yelp / maps slugs: "... state college" tail */
    let town = "";
    const ym = raw.match(/yelp\.com\/biz\/[^/]*?-([a-z-]+-[a-z]+)(?:$|[/?#])/i);
    if (ym && /college|city|park|ville|town|springs|burg|ford|field|haven/.test(ym[1])) {
      town = ym[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
    /* title-case: yelp slugs are lowercase; maps slugs carry real case */
    const isLower = name === name.toLowerCase() && name.length > 0;
    if (isLower) name = name.replace(/\b\w/g, (c) => c.toUpperCase());
    return { name: name, town: town, host: (function () {
      try { return new URL(raw).hostname.replace(/^www\./, ""); } catch (e) { return raw.slice(0, 40); }
    })() };
  }

  /* intake ask — resolved listing, AFTER the entity arrives (addendum
     #5): a pasted link is authoritative (no ask); name+town intake
     answers once per page-load against the REAL listing. */
  let confirmedOnce = false;
  let intakeViaLink = false;

  /* slim non-interactive status line: "anchored on: name · town · link" */
  function anchoredLine(en) {
    document.querySelectorAll(".cs-anchored").forEach((el) => el.remove());
    const link = en.maps_url || en.anchor_url || en.url || "";
    const shown = tr(String(link).replace(/^https?:\/\//, "").replace(/\/+$/, ""), 32);
    const line = CS.el(
      '<div class="cs-anchored" role="status">' +
        '<img src="assets/logo.png" alt="" width="14" height="14" aria-hidden="true">' +
        '<span>anchored on: <b>' + CS.esc(en.display_name || "") + "</b>" +
          (en.location ? " · " + CS.esc(en.location) : "") + "</span>" +
        (link ? '<a href="' + CS.esc(link) + '" target="_blank" rel="noopener" class="anch-link">' + CS.esc(shown) + "</a>" : "") +
        '<button class="fb-x" type="button" aria-label="Dismiss">✕</button>' +
      "</div>");
    line.querySelector(".fb-x").addEventListener("click", () => { line.remove(); });
    const host = document.getElementById("chat-banners");
    if (host) host.prepend(line);
  }

  /* the one-time "is that us?" ask, with the real Google listing */
  function resolveAsk(en) {
    if (confirmedOnce) { anchoredLine(en); return; }
    document.querySelectorAll(".cs-resolve").forEach((el) => el.remove());
    const mapsUrl = en.maps_url || en.anchor_url || en.url || "";
    const site = en.website || en.site || "";
    const openUrl = mapsUrl || site;
    const card = CS.el(
      '<div class="cs-found resolve-banner cs-resolve" role="dialog" aria-label="Is this your business?">' +
        '<div class="fb-copy">The swarm resolved your business as <b>' + CS.esc(en.display_name || "") + "</b>" +
          (en.location ? " · " + CS.esc(en.location) : "") + "." +
          (openUrl ? ' <a class="fb-link" href="' + CS.esc(openUrl) + '" target="_blank" rel="noopener">Open listing ↗</a>' : "") +
        "</div>" +
        '<div class="fb-actions">' +
          '<button class="fb-yes" type="button">Yes — that&rsquo;s us</button>' +
          '<button class="fb-no" type="button">Not us — re-scout</button>' +
        "</div>" +
        '<button class="fb-x" type="button" aria-label="Dismiss">✕</button>' +
      "</div>"
    );
    card.querySelector(".fb-x").addEventListener("click", () => { card.remove(); });
    card.querySelector(".fb-yes").addEventListener("click", () => {
      confirmedOnce = true;
      card.remove();
      anchoredLine(en);
    });
    card.querySelector(".fb-no").addEventListener("click", () => {
      card.remove();
      backToLauncher();
    });
    const host = document.getElementById("chat-banners");
    if (host) host.prepend(card);
  }

  /* after the scouts classify: one-tap "right business / re-scout" —
     slim line at the top of the chat pane (typed-values fallback
     when entity resolution produced no listing) */
  function foundBanner(headNode, cls) {
    document.querySelectorAll(".cs-found").forEach((el) => el.remove());
    const s = CS.session;
    if (!s) return;
    const card = CS.el(
      '<div class="cs-found found-banner" role="status" aria-label="Business identified">' +
        '<div class="fb-copy">' + headNode +
          (cls ? " — classified as <b>" + CS.esc(familyOf(cls)) + "</b> (" + CS.esc(cls || "unknown") + ")." : ".") +
        "</div>" +
        '<div class="fb-actions">' +
          '<button class="fb-yes" type="button">Right — keep scouting</button>' +
          '<button class="fb-no" type="button">Wrong business — re-scout</button>' +
        "</div>" +
        '<button class="fb-x" type="button" aria-label="Dismiss">✕</button>' +
      "</div>"
    );
    card.querySelector(".fb-x").addEventListener("click", () => { card.remove(); });
    card.querySelector(".fb-yes").addEventListener("click", () => { card.remove(); });
    card.querySelector(".fb-no").addEventListener("click", () => {
      card.remove(); backToLauncher();
    });
    const host = document.getElementById("chat-banners");
    if (host) host.prepend(card);
  }
  function showFoundBanner(cls) {
    const s = CS.session;
    if (!s) return;
    foundBanner(
      "The swarm identified your business as <b>" + CS.esc(s.business.name) + "</b>" +
      (s.business.town ? " · " + CS.esc(s.business.town) : ""), cls);
  }
  /* runview is an app shell — lock the page scroll while it's live */
  function setRunActive(on) {
    document.body.classList.toggle("run-active", !!on);
  }

  /* active-session breadcrumb: set the moment a session starts, cleared on
     the back button. On any page load, console.js boots straight back into
     the run view for this session (skip launcher). */
  const SID_KEY = "cc.session.sid";
  function saveSid(sid) {
    try { localStorage.setItem(SID_KEY, sid); } catch (e) { /* private mode */ }
  }
  function clearSavedSid() {
    try { localStorage.removeItem(SID_KEY); } catch (e) { /* noop */ }
  }
  function loadSavedSid() {
    try { return localStorage.getItem(SID_KEY) || ""; } catch (e) { return ""; }
  }

  /* boot across a reload: the last session's id survives the page → try the
     snapshot (GET /api/sessions/{sid}); 200 → back into the run view, else
     clear the key and stay on the launcher. */
  async function restoreLastSession() {
    const sid = loadSavedSid();
    if (!sid || params.get("sid")) return;   /* ?sid link path is its own thing */
    let ok = false;
    try {
      const r = await fetch((CS.API_BASE || "") + "/api/sessions/" + encodeURIComponent(sid));
      ok = r.ok;
    } catch (e) { ok = false; }   /* backend down — launcher stays up */
    if (!ok) { clearSavedSid(); return; }
    resetThread();
    if (CS.setFeedPush) CS.setFeedPush((msg) => appendFeed("backend", CS.esc(msg), "fl-warn"));
    const launcher = $("#launcher"), run = $("#runview");
    if (launcher) launcher.hidden = true;
    if (run) run.hidden = false;
    setRunActive(true);
    startGraphPoller();
    appendFeed("console", "re-attaching to session " + CS.esc(sid), "fl-hi");
    CS.restore(sid, {}).catch((e) => {
      clearSavedSid();
      if (launcher) launcher.hidden = false;
      if (run) run.hidden = true;
      setRunActive(false);
      if (e && e.readyNoQuestion) {
        /* scouted, but the owner never answered the question → take the
           question from the launcher on convene (restoreReady path) */
        window.CS_READY_SID = sid;
        const note = document.querySelector(".demo-notice");
        if (note) {
          note.innerHTML = "Session <b>" + CS.esc(sid) +
            "</b> is already scouted — type your decision below and convene the debate.";
          note.style.display = "block";
        }
        return;
      }
      appendFeed("console", "⚠ session restore failed · " + CS.esc(e.message || "?"), "fl-warn");
    });
  }

  async function backToLauncher() {
    if (CS.session) CS.session._stop = true;   /* stream loop breaks on this */
    setRunActive(false);
    const l = $("#launcher"), r = $("#runview");
    if (l) l.hidden = false;
    if (r) r.hidden = true;
    /* let the stream driver tear down (closes SSE + poller) first */
    for (let i = 0; i < 30 && CS.state === "running"; i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    CS.state = "idle";
    CS.session = null;
    document.querySelectorAll(".cs-found").forEach((el) => el.remove());
    const name = $("#biz-name"); if (name) name.focus();
  }

  /* ============================================================
     Feed pane — one mono line per bus event
     Returns pre-escaped html so counts can be <b>-wrapped.
     ============================================================ */
  function feedText(name, d) {
    if (!d) d = {};
    switch (name) {
      case "session:start":
        return ["session opened · " + CS.esc(d.business || "business") +
          (d.town ? " · " + CS.esc(d.town) : ""), "fl-hi"];
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
        return ["scout complete · evidence base ready", "fl-hi"];
      case "evidence":
        return ["card " + CS.esc(d.id || "?") + " · " + CS.esc(tr(d.claim, 62)), "fl-dim"];
      case "debate:round":
        return ["round " + CS.esc(d.n) + " opens", "fl-hi"];
      case "debate:camp":
        return ["camp “" + CS.esc(d.name || "") + "” · " +
          CS.esc((d.member_ids || []).length) + " agents", ""];
      case "debate:done":
        return ["round " + CS.esc(d.n) + " closed", "fl-dim"];
      case "verdict": {
        const c = d.confidence != null ? Math.round((Number(d.confidence) || 0) * 100) : null;
        const t = d.tally || {};
        const n = (t.support || 0) + (t.oppose || 0) + (t.neutral || 0);
        return ["verdict in" + (c != null ? " · confidence " + c + "%" : "") +
          (n ? " · " + (t.support || 0) + "/" + n + " agent votes in support" : ""), "fl-hi"];
      }
      case "loop:start":
        return ["market loop running · seed " + CS.esc(d.seed != null ? d.seed : "?"), "fl-hi"];
      case "loop:done":
        return ["market loop complete · beliefs rewritten", "fl-hi"];
      case "act:start":
        return ["act: drafting owner-ready copy…", "fl-hi"];
      case "act:progress":
        return ["act · " + CS.esc(tr(d.stage_detail || "working", 60)), "fl-dim"];
      case "act:done":
        return [d.error ? "act failed · " + CS.esc(tr(d.error, 60)) :
          "act complete · " + ((d.result && d.result.drafts || []).length) + " drafts scored", "fl-hi"];
      case "stream:done":
        return ["session complete — all " + stepsTotal() + " steps shown", "fl-hi"];
      case "stream:error":
        return ["⚠ " + CS.esc(tr(plainError(d.message), 90)), "fl-warn"];
      case "paid":
        return ["deep-dive unlocked (paid)", "fl-hi"];
      default:
        return ["", ""];
    }
  }

  /* ============================================================
     Run stats — small monospace chips in the graph pane's top rail
     (the old left agents rail is gone; the graph canvas owns both).
     ============================================================ */
  function resetThread() {
    drawerChats.clear();
    D.host = null;
    D.context = null;
    runlogCount = 0;
    const n = $("#runlog-count");
    if (n) n.textContent = "0";
    if (runlogOpen) toggleRunlog(false);
    document.querySelectorAll(".cs-found").forEach((el) => el.remove());
    const card = $("#verdict-card"), vcBody = $("#vc-body");
    if (card) { card.hidden = true; card.classList.remove("is-closed"); }
    if (vcBody) vcBody.hidden = true;
  }

  /* ============================================================
     Graph pane — window.CSGraph = { mount(el, CS), destroy() },
     built in parallel. Mount as early as runview entry so the
     round-1 loading state lives on the canvas.
     ============================================================ */
  let graphMounted = false;
  let graphPoller = null;

  function mountGraph() {
    const el = document.getElementById("graph-mount");
    if (!el || graphMounted) return;
    const hint = document.getElementById("graph-hint");
    const G = window.CSGraph;
    if (!G || typeof G.mount !== "function") {
      if (hint) { hint.hidden = false; hint.textContent = "graph module loading… the swarm nodes land here on session start."; }
      return;
    }
    try {
      G.mount(el, CS);
      graphMounted = true;
      if (hint) hint.hidden = true;
      if (graphPoller) { clearInterval(graphPoller); graphPoller = null; }
    } catch (e) {
      graphMounted = true;   /* don't retry into the same throwing state */
      if (hint) { hint.hidden = false; hint.textContent = "graph module unavailable — steps still work in the overlay."; }
      if (window.console) console.warn("[CS graph mount]", e);
    }
  }
  function startGraphPoller() {
    if (graphPoller) return;
    graphPoller = setInterval(() => {
      mountGraph();
      if (graphMounted && graphPoller) { clearInterval(graphPoller); graphPoller = null; }
    }, 1500);
  }

  /* ============================================================
     Run log — small collapsible strip pinned to the BOTTOM of the
     graph pane; every non-agent bus event lands as a mono line.
     ============================================================ */
  const LOG_CAP = 140;
  let runlogCount = 0;
  let runlogOpen = false;

  function logHost() { return $("#feed-log"); }

  function pushLog(name, html, sev) {
    const log = logHost();
    if (!log) return;
    const line = CS.el(
      '<div class="rl-line ' + (sev || "") + '">' +
      '<span class="rl-time">' + tsShort() + "</span>" +
      '<span class="rl-text">' + html + "</span>" +
      "</div>");
    log.appendChild(line);
    while (log.children.length > LOG_CAP) log.removeChild(log.firstChild);
    runlogCount++;
    const n = $("#runlog-count");
    if (n) n.textContent = runlogCount;
    if (sev === "fl-warn" && !runlogOpen) toggleRunlog(true);   /* errors surface themselves */
    if (runlogOpen) log.scrollTop = log.scrollHeight;
  }

  function toggleRunlog(open) {
    runlogOpen = !!open;
    const box = $("#runlog");
    const body = logHost();
    const btn = $("#runlog-toggle");
    if (box) box.classList.toggle("is-open", runlogOpen);
    if (body) body.hidden = !runlogOpen;
    if (btn) btn.setAttribute("aria-expanded", String(runlogOpen));
    if (runlogOpen && body) body.scrollTop = body.scrollHeight;
  }

  function appendFeed(name, html, cls) {
    pushLog(name, html, cls);
  }

  /* narration timestamps are compact: HH:MM:SS */
  function tsShort() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /* ============================================================
     Chat station (right pane) — one vertical conversation surface:
     the verdict card + paywall live in the message flow above the
     chatbot, sharing the same scroll. Direct mode only: an agent is
     focused via a graph node click (window event "csgraph:node").
     CS.chat 402s when unpaid → the $19 paywall stays in the verdict
     card; the composer disables with a hint.
     ============================================================ */
  const D = { host: null, busy: false, context: null };
  const drawerChats = new Map();    // chat key → [{who, text, eids, note}]

  function chatKey() { return D.host || "__none"; }
  function drawerLocked() {
    const s = CS.session;
    if (!s || !s.verdict) return "verdict";
    if (!CS.isPaid()) return "pay";
    return null;
  }
  function segLabelOf(p) {
    const s = CS.session;
    if (!s || !p) return "—";
    const seg = (s.segments || []).find((x) => x.id === p.segment);
    return seg ? seg.name : (p.segment || "—");
  }
  function personaOf(id) {
    const s = CS.session;
    return s && s.personas ? s.personas.find((p) => p.id === id) : null;
  }
  function evidenceChip(id) {
    const s = CS.session;
    const e = s && s.evidence ? s.evidence.find((x) => x.id === id) : null;
    const label = id + (e && e.source_label ? " · " + e.source_label : "");
    const claim = e ? (e.quote || e.claim || "") : "";
    return '<span class="ad-cite" title="' + CS.esc(claim) + '">' + CS.esc(label) + "</span>";
  }

  /* graph-node → persona resolution. graph.js ids: "pe:"+personaId,
     "ev:"+evidenceId, "w:"+word. Resolve defensively: exact id,
     prefix-stripped id, or persona name. */
  function personaIdFromNode(raw, tipo) {
    const s = CS.session;
    if (!raw || !s || !s.personas) return null;
    const id = String(raw);
    if (/^ev:|^w:/i.test(id)) return null;
    if (tipo && /topic|evidence|entity|word|segment/i.test(tipo)) return null;
    const bare = id.replace(/^pe:/i, "");
    const p = personaOf(bare) ||
      s.personas.find((x) => x.name && (x.name === bare || x.name === id)) ||
      s.personas.find((x) => ("pe:" + x.id) === id);
    return p ? p.id : null;
  }
  function contextFromNode(raw) {
    const s = CS.session;
    const m = raw ? String(raw).match(/^ev:(.+)$/i) : null;
    if (!m || !s || !s.evidence) return null;
    const ev = s.evidence.find((x) => x.id === m[1]);
    if (!ev) return null;
    return { id: ev.id, claim: ev.claim || ev.quote || ev.title || "" };
  }
  function onGraphNode(e) {
    const d = (e && e.detail) || {};
    if (!d.nodeId) { D.context = null; if (!D.host) paintDrawer(); return; }
    const pid = personaIdFromNode(d.nodeId, d.nodeType);
    if (pid) { D.context = null; openDrawer(pid, "direct"); return; }
    /* topic/evidence node — chat opens on it, no agent chosen; the
       composer stays disabled with a "pick an agent" hint */
    D.context = contextFromNode(d.nodeId);
    D.host = null;
    paintDrawer();
    const sc = $("#chat-scroll");
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  /* a graph node click (persona) lands here */
  function openDrawer(personaId, mode) {
    D.host = personaId || null;
    D.context = null;
    /* the chat pane owns the conversation now — make sure it's visible */
    const pane = $("#chat-pane");
    if (pane) pane.classList.remove("is-collapsed");
    paintDrawer();
    const sc = $("#chat-scroll");
    if (sc) sc.scrollTop = sc.scrollHeight;
  }
  /* the ✕ on the peer header clears the focused conversation */
  function closeDrawer() {
    D.host = null;
    paintDrawer();
  }

  function paintDrawer() {
    const host = personaOf(D.host);
    const CE = window.CSEffects;
    const av = D.host && CE && CE.avatar ? CE.avatar(D.host, 34) : "";
    const nameEl = $("#ad-name"), subEl = $("#ad-sub"), avEl = $("#ad-av");
    const segName = host ? segLabelOf(host) : "";
    if (avEl) avEl.innerHTML = av;
    if (nameEl) nameEl.textContent = host ? host.name : "Pick an agent";
    if (subEl) {
      if (host) subEl.textContent = segName + " · " + (D.host || "");
      else if (D.context) subEl.textContent = "topic picked — no agent yet";
      else subEl.textContent = "click a node in the graph";
    }
    const clearBtn = $("#chat-clear");
    if (clearBtn) clearBtn.hidden = !D.host;

    /* the verdict card rides the same conversation flow */
    renderVerdictCard();

    const msgs = $("#ad-msgs");
    const foot = $("#ad-foot");
    const input = $("#ad-input");
    if (!msgs) return;
    const lock = drawerLocked();
    const unpaid = lock === "pay";

    /* verdict pending / unpaid → the big lock card is the empty chat state */
    if (lock) {
      msgs.innerHTML = "";
      if (foot) foot.hidden = true;
      const verdictPending = lock === "verdict";
      const card = CS.el(
        '<div class="ad-lock">' +
          '<div class="ad-lock-k">' + (verdictPending ? "verdict pending" : "locked") + "</div>" +
          '<div class="ad-lock-t">' + (verdictPending ? "The verdict isn&rsquo;t in yet" :
            "Unlock full segment impact + agent chat — $19") + "</div>" +
          '<div class="ad-lock-p">' + (verdictPending
            ? "Agents open up to questions once the debate closes at a verdict."
            : "The $19 deep-dive unlocks chat with every agent — answers in character, backed by the session&rsquo;s evidence.") + "</div>" +
          (verdictPending ? "" :
            '<button class="vc-cta" type="button">Unlock — $19' +
              (CS.STRIPE_LINK ? " (Stripe)" : " (demo payment)") + "</button>" +
            '<div class="vc-fine mono">' + (CS.STRIPE_LINK
              ? "secure checkout in a new tab"
              : "demo session — no card is charged") + "</div>") +
        "</div>");
      const lk = card.querySelector(".vc-cta");
      if (lk) lk.addEventListener("click", async () => {
        lk.disabled = true;
        lk.textContent = "unlocking…";
        let ok = false;
        try { ok = await CS.pay(); } catch (e) { ok = false; }
        if (!ok) { lk.disabled = false; lk.textContent = "couldn't unlock — try again"; }
      });
      msgs.appendChild(card);
      return;
    }

    if (foot) {
      foot.hidden = false;
      if (input) {
        input.disabled = unpaid || !D.host;
        input.placeholder = unpaid ? "unlock agent chat — $19 →"
          : (host ? "cross-question " + host.name.toLowerCase() + "…" : "pick an agent…");
      }
    }
    const hist = drawerChats.get(chatKey()) || [];
    msgs.innerHTML = "";
    if (!hist.length && !D.host) {
      if (D.context) {
        msgs.appendChild(CS.el(
          '<div class="ad-quote">About: ' + CS.esc(tr(D.context.claim, 150)) +
          '<span>' + CS.esc(D.context.id) + ' · the composer unlocks once you pick an agent — click a customer node</span></div>'));
      } else {
        msgs.appendChild(CS.el(
          '<div class="ad-quote">Click a customer node in the graph — it&rsquo;s that agent.' +
          '<span>every agent answers in character, backed by the session&rsquo;s evidence</span></div>'));
      }
    }
    if (!hist.length && D.host && host && host.quote) {
      msgs.appendChild(CS.el(
        '<div class="ad-quote">&ldquo;' + CS.esc(host.quote) + '&rdquo;' +
        '<span>— what they said in the debate</span></div>'));
    }
    for (const m of hist) msgs.appendChild(drawerBubble(m));
  }

  function drawerBubble(m) {
    const row = CS.el('<div class="ad-msg ' + (m.who === "me" ? "me" : "them") + '"></div>');
    if (m.who === "me") {
      row.appendChild(CS.el('<div class="ad-bubble"></div>')).textContent = m.text;
      return row;
    }
    if (D.host) {
      const CE = window.CSEffects;
      row.appendChild(CS.el('<span class="ad-av">' +
        (CE && CE.avatar ? CE.avatar(D.host, 26) : "") + "</span>"));
    }
    const wrap = CS.el('<div class="ad-bubblewrap"></div>');
    const t = CS.el('<div class="ad-bubble"></div>');
    t.textContent = m.text;
    wrap.appendChild(t);
    if (m.note) wrap.appendChild(CS.el('<div class="ad-note">' + CS.esc(m.note) + "</div>"));
    if (m.eids && m.eids.length) {
      wrap.appendChild(CS.el('<div class="ad-cites">' + m.eids.map(evidenceChip).join("") + "</div>"));
    }
    row.appendChild(wrap);
    return row;
  }

  async function sendDrawer() {
    if (D.busy || drawerLocked()) return;
    const input = $("#ad-input");
    const text = input ? input.value.trim() : "";
    if (!text) return;
    const target = personaOf(D.host);
    if (!target || !target.id) return;
    const key = chatKey();
    if (!drawerChats.has(key)) drawerChats.set(key, []);
    const hist = drawerChats.get(key);
    hist.push({ who: "me", text: text });
    const cur = $("#ad-msgs");
    if (cur) cur.appendChild(drawerBubble(hist[hist.length - 1]));
    scrollChat();
    if (input) input.value = "";

    D.busy = true;
    const btn = $("#ad-send");
    if (btn) btn.disabled = true;
    const typing = CS.el('<div class="ad-msg them"><div class="ad-bubble ad-typing">' +
      '<i></i><i></i><i></i></div></div>');
    if (cur) cur.appendChild(typing);
    scrollChat();

    try {
      const res = await CS.chat(target.id, text);
      const msg = { who: "them", text: res.reply, eids: res.evidence_ids || null, note: null };
      hist.push(msg);
      hist.splice(0, hist.length - 60);   // keep the thread light
      paintDrawer();                       // full repaint keeps eids + note
      scrollChat();
    } catch (e) {
      if (e && e.status === 402) {
        /* unpaid → open the verdict card so the paywall is visible */
        const card = $("#verdict-card"), vcBody = $("#vc-body");
        if (card && vcBody && !card.hidden) {
          vcBody.hidden = false;
          card.classList.remove("is-closed");
          const head = $("#vc-head");
          if (head) head.setAttribute("aria-expanded", "true");
        }
        paintDrawer();
        scrollChat();
      } else {
        D.busy = false;
        if (btn) btn.disabled = false;
        if (typing && typing.parentNode) typing.remove();
        const msg = { who: "them", text: "(the agent dropped mid-thought — try again)" };
        hist.push(msg);
        if (cur) cur.appendChild(drawerBubble(msg));
        scrollChat();
        return;
      }
    }
    D.busy = false;
    if (btn) btn.disabled = false;
    if (typing.parentNode) typing.remove();
  }

  /* the chat pane scrolls as one surface — keep the latest message in view */
  function scrollChat(toTop) {
    const sc = $("#chat-scroll");
    if (!sc) return;
    sc.scrollTop = toTop ? 0 : sc.scrollHeight;
  }

  function wireDrawer() {
    const clear = $("#chat-clear");
    if (clear) clear.addEventListener("click", closeDrawer);
    const send = $("#ad-send");
    if (send) send.addEventListener("click", sendDrawer);
    const input = $("#ad-input");
    if (input) input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDrawer(); }
    });
  }

  function setDot(mode) {
    const dot = $("#run-dot"), lab = $("#run-status");
    if (dot) dot.className = mode === "done" ? "dot done" : "dot proc";
    if (lab) lab.textContent = mode === "done" ? "complete" : "running";
  }

  /* 4 monospace chips in the graph pane's top rail, rebuilt from
     CS.session after every event */
  function renderStats() {
    const box = $("#graph-stats");
    if (!box) return;
    const s = CS.session;
    if (!s) { box.innerHTML = ""; return; }
    const srcDone = s.sources.filter((x) => x.status && x.status !== "pending").length;
    const srcTarget = Math.max(7, s.sources.length || 0);
    const rounds = (s.debate && s.debate.rounds.length) || 0;
    const chips = [
      [srcDone + "/" + srcTarget, "sources"],
      [String(s.evidence.length), "evidence"],
      [String(s.personas.length), "agents"],
      [rounds + "/2", "round"],
    ];
    box.innerHTML = chips.map((t) =>
      '<span class="gchip"><b>' + CS.esc(t[0]) + "</b>" + t[1] + "</span>"
    ).join("");
  }

  /* ============================================================
     Verdict card — lives INSIDE the chat pane's message flow, on
     top of the chatbot and sharing its scroll. Recommendation +
     confidence bar + tally split free; the $19 paywall sits right
     under it (paid: objections + segment-impact rows expand in the
     same card). Collapsible via the chevron header.
     ============================================================ */
  function renderVerdictCard() {
    const s = CS.session;
    const card = $("#verdict-card"), body = $("#vc-body"), mini = $("#vc-mini");
    if (!card || !body) return;
    if (!s || !s.verdict) { card.hidden = true; updateHeaderChips(); return; }
    const first = card.hidden;
    card.hidden = false;
    const v = s.verdict;
    const paid = CS.isPaid();
    const tally = v.tally || {};
    const sup = Number(tally.support) || 0;
    const opp = Number(tally.oppose) || 0;
    const neu = Number(tally.neutral) || 0;
    const total = Math.max(1, sup + opp + neu);
    const conf = Math.max(0, Math.min(1, Number(v.confidence) || 0));
    const confN = Math.round(conf * 100);
    const pct = (n) => ((n / total) * 100).toFixed(2);
    if (mini) mini.textContent = confN + "% · " + sup + "/" + total + " for";

    let html =
      '<div class="vc-hero">' + CS.esc(v.recommendation || "") + "</div>" +
      '<div class="vc-row"><span class="vc-cap">confidence</span>' +
        '<span class="vc-bar"><i style="width:' + confN + '%"></i></span>' +
        '<b class="vc-num">' + confN + "%</b></div>" +
      '<div class="vc-row"><span class="vc-cap">agent split</span>' +
        '<span class="vc-split">' +
          '<span class="vd-seg vd-sg-for" style="width:' + pct(sup) + '%"><i>' + (sup || "") + "</i></span>" +
          '<span class="vd-seg vd-sg-against" style="width:' + pct(opp) + '%"><i>' + (opp || "") + "</i></span>" +
          '<span class="vd-seg vd-sg-shift" style="width:' + pct(neu) + '%"><i>' + (neu || "") + "</i></span>" +
        "</span></div>" +
      '<div class="vc-legend">' +
        '<span style="color:var(--ok)">■ support ' + sup + "</span>" +
        '<span style="color:var(--err)">■ oppose ' + opp + "</span>" +
        '<span style="color:var(--proc)">■ neutral ' + neu + "</span>" +
      "</div>";

    if (paid) {
      const srows = (v.segment_impact || []).map((x) =>
        '<div class="vc-srow"><b>' + CS.esc(x.segment || "") + "</b>" +
          "<span>" + CS.esc(x.impact || "") + "</span>" +
          (x.evidence_ids && x.evidence_ids.length
            ? '<span class="ad-cites">' + x.evidence_ids.map(evidenceChip).join("") + "</span>" : "") +
        "</div>").join("");
      const objs = (v.objections || []).map((t, i) =>
        '<li class="vc-obj"><b>' + String(i + 1).padStart(2, "0") + '</b><span>' + CS.esc(t) + "</span></li>").join("");
      html += '<div class="vc-deep">' +
        '<div class="vc-cap2">segment impact</div>' +
        (srows || '<div class="vc-none mono">no segment rows recorded</div>') +
        '<div class="vc-cap2">top objections</div>' +
        (objs ? '<ol class="vc-objs">' + objs + "</ol>" : '<div class="vc-none mono">none recorded</div>') +
      "</div>";
    }
    /* unpaid: no lock here — the big lock card below (in the empty
       chat state) + the header pill carry the paywall (addendum #5) */

    body.innerHTML = html;
    /* header chips (lock pill + act button) follow the same state */
    updateHeaderChips();
    if (first) {                       // verdict just landed → expand + top
      body.hidden = false;
      card.classList.remove("is-closed");
      const head = $("#vc-head");
      if (head) head.setAttribute("aria-expanded", "true");
      scrollChat(true);
    }
  }

  function wireVerdictCard() {
    const head = $("#vc-head");
    if (!head || head.dataset.wired) return;
    head.dataset.wired = "1";
    head.addEventListener("click", () => {
      const open = head.getAttribute("aria-expanded") !== "true";
      head.setAttribute("aria-expanded", String(open));
      const body = $("#vc-body");
      if (body) body.hidden = !open;
      const card = $("#verdict-card");
      if (card) card.classList.toggle("is-closed", !open);
    });
  }

  /* slim header chips: lock pill (unpaid) + Act-on-it button (verdict in) */
  function updateHeaderChips() {
    const s = CS.session;
    const pill = $("#pay-pill"), act = $("#act-button");
    if (pill) pill.hidden = !(s && !CS.isPaid());
    if (act) act.hidden = !(s && s.verdict);
  }

  /* "⚡ Act on it" — opens the Act surface (learn overlay, act tab) */
  function openAct() {
    let idx = CS.STEPS.findIndex((s) => s && s.id === "learn");
    if (idx < 0) idx = CS.STEPS.length ? CS.STEPS.length - 1 : 4;
    manualNav = idx;
    gotoStep(idx);
    const mount = $("#step-mount");
    if (mount) {
      const tab = mount.querySelector('.lrn-tab[data-tab="act"]');
      if (tab) tab.click();
    }
    showOverlay();
  }

  /* ============================================================
     Canvas view modes (MiroFish-style segmented control):
     graph = nodes full-pane · split = 50/50 nodes | docked step
     panel · workbench = step board + expanded run log, graph hidden.
     Pure layout — no new data plumbing.
     ============================================================ */
  let viewMode = "split";   /* owner default: nodes | chat 50/50 */
  function setViewMode(m) {
    if (["graph", "split", "workbench"].indexOf(m) < 0) return;
    viewMode = m;
    const panes = document.querySelector(".run-panes");
    if (panes) {
      panes.classList.toggle("mode-graph", m === "graph");
      panes.classList.toggle("mode-split", m === "split");
      panes.classList.toggle("mode-workbench", m === "workbench");
    }
    document.querySelectorAll(".vt-btn").forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (m === "split") {
      hideOverlay();                     /* split shows nodes | chat, clean */
      if (CS.currentStep < 0) gotoStep(0);
    }
    if (m === "workbench" && CS.currentStep < 0) gotoStep(0);
  }

  /* ============================================================
     Step routing — the middle pane is the graph canvas; step
     content renders into a floating overlay card over it.
     Steps 1-3 + 5 open via the rail; learn auto-opens as it
     arrives. The step 4 VERDICT no longer auto-opens an overlay —
     the verdict card lives inside the chat pane now.
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
    /* learn arrives → the overlay opens by itself; the verdict
       lands in the chat pane instead */
    if (idx >= 4) showOverlay();
    else hideOverlay();
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
    const title = step ? (step.title || "Step " + (i + 1)) : "Step " + (i + 1);
    if (ind) {
      ind.innerHTML = "<b>Step " + CS.esc(i + 1) + "/" + CS.esc(CS.STEPS.length || 5) +
        "</b> · " + CS.esc(title);
    }
    const soTitle = $("#so-title");
    if (soTitle) {
      soTitle.textContent = "Step " + ((step && step.num) || i + 1) + " · " + title;
    }
    renderTabs();
    mount.scrollTop = 0;
  }

  let overlayOpen = false;

  function showOverlay() {
    overlayOpen = true;
    const ov = $("#step-overlay");
    if (ov) ov.hidden = false;
  }
  function hideOverlay() {
    overlayOpen = false;
    const ov = $("#step-overlay");
    if (ov) ov.hidden = true;
  }

  function stepError(mount, err) {
    mount.innerHTML = '<div class="step-error">step crashed — details in the dev console</div>';
    if (window.console) console.error("[CS step render]", err);
  }

  /* step tabs — slim rail at the top of the graph pane */
  function ensureRail() {
    let rail = $("#step-rail");
    if (rail && !rail.dataset.wired) {
      rail.dataset.wired = "1";
      rail.addEventListener("click", (e) => {
        const btn = e.target.closest(".rtab");
        if (!btn) return;
        const i = Number(btn.dataset.i);
        if (!CS.STEPS[i]) return;
        manualNav = i;
        gotoStep(i);
        showOverlay();
      });
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
  const NAMES = ["session:start", "business:resolved", "scout:status", "scout:source", "scout:reviews",
    "scout:done", "evidence", "segment", "persona", "debate:round", "debate:stance",
    "debate:camp", "debate:done", "verdict", "loop:start", "loop:done", "act:start",
    "act:progress", "act:done", "stream:done", "stream:error", "paid"];

  function wireBus() {
    NAMES.forEach((n) => CS.on(n, (e) => onEvent(n, e.detail)));
    CS.on("step:target", (e) => autoAdvance(e.detail && e.detail.index));
    CS.on("steps:changed", () => { renderTabs(); remountIfBlank(); });
    CS.on("intake:candidates", (e) => showCandidates(e.detail || {}));
  }

  /* ============================================================
     "Did you mean" — the scouts found more than one business with
     this name: one tap re-convenes the swarm on the right one.
     ============================================================ */
  function showCandidates(d) {
    document.querySelectorAll(".cs-didumean").forEach((el) => el.remove());
    const norm = (c) => {
      if (typeof c === "string") return { label: c, url: c };
      return {
        label: c.label || c.title || c.name || c.anchor_url || c.url || c.link || "",
        url: c.anchor_url || c.url || c.link || c.maps_url || "",
        detail: c.detail || c.subtitle || c.why || (c.kind ? "kind: " + c.kind : ""),
      };
    };
    const list = (d.candidates || []).map(norm).filter((c) => c.label);
    if (!list.length) return;
    const card = CS.el(
      '<div class="cs-didumean" role="dialog" aria-label="Is this the right business?">' +
        '<div class="cdm-title">A few businesses fit “' + CS.esc(d.name || "that name") +
        '” — is one of these yours?</div>' +
        '<div class="cdm-list"></div>' +
        '<div class="cdm-skip"><button class="cdm-none" type="button">None of these — keep scouting broadly</button></div>' +
      '</div>'
    );
    const wrap = card.querySelector(".cdm-list");
    for (const c of list) {
      const b = CS.el(
        '<button class="cdm-opt" type="button">' +
          '<b>' + CS.esc(c.label) + '</b>' +
          (c.detail ? '<span>' + CS.esc(c.detail) + "</span>" : "") +
        '</button>');
      b.addEventListener("click", () => {
        card.remove();
        resetThread();
        appendFeed("console", "re-scouting on “" + CS.esc(c.label) + "”", "fl-hi");
        const run = $("#runview");
        if (run) run.hidden = false;
        if (c.url) CS.rechoose(c.url);
        else CS.rechooseLabel(c.label);
      });
      wrap.appendChild(b);
    }
    card.querySelector(".cdm-none").addEventListener("click", () => {
      card.remove();
      appendFeed("console", "keeping the scouts as they ran", "");
    });
    document.body.appendChild(card);
  }

  function onEvent(name, d) {
    if (!d) d = {};
    /* CS.start emits session:start, then the driver applies it too — dedupe */
    const key = name + "|" + JSON.stringify(d, (k, v) => (v === undefined ? null : v));
    const dup = (name === "session:start") && key === lastKey;
    lastKey = key;

    eventCount++;
    if (!dup) {
      /* everything lands in the run log; agent cards live on the
         graph canvas now (nodes → chat via "csgraph:node") */
      const pair = feedText(name, d);
      if (pair[0]) appendFeed(name, pair[0], pair[1]);
    }

    if (name === "session:start") {
      const tag = $("#biz-tag");
      if (tag) tag.textContent = (d.business || "") + (d.town ? " · " + d.town : "");
      /* this session is now the one a reload should restore */
      if (CS.session && CS.session.sid) saveSid(CS.session.sid);
      /* restore/restoreReady paths enter runview the same way as start */
      const l = $("#launcher");
      if (l) l.hidden = true;
      const r = $("#runview");
      if (r) r.hidden = false;
      setDot("run");
      mountGraph();   /* canvas is up before the stream's first event */
    }
    if (name === "business:resolved") {
      const en = (d.entity || {});
      const listing = !!(en.display_name && !(en.candidates || []).length);
      if (listing) {
        /* link intake = authoritative (no ask); name+town asks once,
           then every later session this page-load just anchors */
        if (intakeViaLink || confirmedOnce) anchoredLine(en);
        else resolveAsk(en);
      }
      if (en.display_name) {
        const tag = $("#biz-tag");
        if (tag) tag.textContent = en.display_name + (en.location ? " · " + en.location : "");
      }
    }
    if (name === "scout:status" && d.business_class && CS.session &&
        !CS.session.foundShown) {
      CS.session.foundShown = true;
      /* entity resolution already put the authoritative banner up in live mode */
      if (!(CS.session.business && CS.session.business.entity)) {
        showFoundBanner(d.business_class);
      }
    }
    if (name === "stream:done") setDot("done");
    if (name === "stream:error") setDot("done");
    if (name === "loop:start") setDot("run");
    if (name === "loop:done") setDot("done");

    /* the chat pane's lock state tracks verdict + paid arrivals */
    if (name === "verdict" || name === "paid") paintDrawer();

    renderStats();

    const t = AUTO[name];
    if (t != null) autoAdvance(t);
  }

  /* ============================================================
     Launcher — link OR name+town; the listing ask happens after
     the scouts resolve (chat pane), never pre-session.
     ============================================================ */

  function planFromInputs() {
    const link = ($("#biz-link") && $("#biz-link").value.trim()) || "";
    let name = ($("#biz-name") && $("#biz-name").value.trim()) || "";
    let town = ($("#biz-town") && $("#biz-town").value.trim()) || "";
    if (link && !name) {
      const got = nameFromUrl(link);
      if (got.name) name = got.name;
      if (!town && got.town) town = got.town;   /* slug hint (yelp) */
    }
    return { link: link, name: name, town: town,
      host: link ? nameFromUrl(link).host : "" };
  }

  function bindStart() {
    const btn = $("#start-btn");
    if (!btn) return;
    const go = () => {
      if ((window.CS && CS.state) === "running") return;
      const plan = planFromInputs();
      const err = $("#launcher-err");
      const question = ($("#biz-question") && $("#biz-question").value.trim()) || "";
      if (!plan.name) {
        if (err) err.textContent = "Paste your business link, or give the business name and town — that's what the scouts search for.";
        return;
      }
      if (!plan.town && !plan.link) {
        if (err) err.textContent = "Add the town (or \"Online\" for an online-only business).";
        return;
      }
      if (!question) {
        if (err) err.textContent = "Add the real decision you'd like your customers to weigh in on.";
        return;
      }
      const qTrim = question.trim();
      const qWords = qTrim.split(/\s+/).filter(Boolean).length;
      if (qTrim.length < 12 || qWords < 4) {
        if (err) err.textContent = "Give the swarm a full question — specific, at least ~8 words";
        return;
      }
      if (err) err.textContent = "";
      if (!plan.town) plan.town = "Online";   /* link-only, no slug hint */

      /* straight through for both intake paths (addendum #5): a pasted
         link is authoritative; name+town is asked once POST-resolution
         (the "is that us?" ask lands in the chat pane when the
         scouts produce the listing) */
      intakeViaLink = !!plan.link;
      /* login-lite: remember the owner email for re-finding sessions */
      const emailEl = $("#biz-email");
      const email = (emailEl && emailEl.value.trim()) || "";
      if (email) { try { localStorage.setItem("cc.email", email); } catch (e) {} }
      launch(plan, question, email);
    };

    function launch(plan, question, email) {
      const launcher = $("#launcher"), run = $("#runview");
      if (launcher) launcher.hidden = true;
      if (run) run.hidden = false;
      setRunActive(true);
      resetThread();
      startGraphPoller();   /* the CSGraph mount + round-1 loading state */
      const opts = liveOpts();
      if (plan.link && !opts.mock) opts.anchorUrl = plan.link;
      appendFeed("console",
        "convening on " + CS.esc(plan.name) +
        (plan.town ? " · " + CS.esc(plan.town) : "") +
        (opts.mock ? " (recorded replay)" : ""), "fl-hi");
      if (window.CS_READY_SID) {
        /* restoring a shared session: reuse it instead of creating a new one */
        const readySid = window.CS_READY_SID;
        window.CS_READY_SID = null;
        if (launcher) launcher.hidden = true;
        if (run) run.hidden = false;
        appendFeed("console", "convening debate on session " + CS.esc(readySid), "fl-hi");
        CS.restoreReady(readySid, question, {});
        return;
      }
      if (CS.setFeedPush) CS.setFeedPush((msg) => appendFeed("backend", CS.esc(msg), "fl-warn"));
      /* if a previous stream is still tearing down, wait for it */
      const tryStart = (tries) => {
        if (CS.state === "running" && tries < 30) {
          setTimeout(() => tryStart(tries + 1), 100);
          return;
        }
        opts.email = email || undefined;
      CS.start(plan.name, plan.town, question, opts);
      };
      tryStart(0);
    }

    btn.addEventListener("click", go);
    ["#biz-link", "#biz-name", "#biz-town", "#biz-question"].forEach((sel) => {
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
    wireDrawer();
    bindStart();
    ensureRail();
    renderTabs();
    renderStats();

    const ind = $("#step-indicator");
    if (ind) ind.innerHTML = "<b>Step —/" + CS.esc(stepsTotal()) + "</b> · awaiting session";

    /* collapsible rails — agents + chat panes */
    function wirePaneToggle(btnId, paneId) {
      const btn = $(btnId), pane = $(paneId);
      if (!btn || !pane) return;
      btn.addEventListener("click", () => {
        pane.classList.toggle("is-collapsed");
      });
    }
    wirePaneToggle("#chat-toggle", "#chat-pane");
    startGraphPoller();

    /* run log drawer */
    const rl = $("#runlog-toggle");
    if (rl) rl.addEventListener("click", () => toggleRunlog(!runlogOpen));

    /* step overlay dismiss */
    const soClose = $("#so-close");
    if (soClose) soClose.addEventListener("click", hideOverlay);

    /* verdict card chevron + graph-node → chat wiring */
    wireVerdictCard();
    window.addEventListener("csgraph:node", onGraphNode);

    /* chat pane slim header: act button + lock pill */
    const actBtn = $("#act-button");
    if (actBtn) actBtn.addEventListener("click", openAct);
    const pill = $("#pay-pill");
    if (pill) pill.addEventListener("click", () => { CS.pay().catch(() => {}); });

    /* canvas view modes — one source of truth: either strip's buttons call
       setViewMode, which re-renders both panes and syncs aria-pressed on
       every .vt-btn (graph rail + chat header) */
    document.querySelectorAll(".view-toggle").forEach((tv) => {
      tv.addEventListener("click", (e) => {
        const btn = e.target.closest(".vt-btn");
        if (btn) setViewMode(btn.dataset.mode);
      });
    });
    setViewMode("split");   /* owner default */

    const back = $("#back-btn");
    if (back) back.addEventListener("click", () => {
      clearSavedSid();   /* back = leave the session; a reload must not re-enter runview */
      location.reload();
    });

    /* shared-session link: /demo/console.html?sid=s_xxx re-attaches and
       replays the full history from the SSE backlog (paid state restored) */
    const sid = params.get("sid");
    if (sid) {
      resetThread();
      if (CS.setFeedPush) CS.setFeedPush((msg) => appendFeed("backend", CS.esc(msg), "fl-warn"));
      window.CS_READY_SID = sid;   // launcher start reuses this session
      CS.restore(sid, {}).catch((e) => {
        if (e && e.readyNoQuestion) {
          const note = document.querySelector(".demo-notice");
          if (note) note.innerHTML = "Session <b>" + CS.esc(sid) +
            "</b> is already scouted — type your decision below and convene the debate.";
          if (note) note.style.display = "block";
          return;   // launcher stays up; start routes through CS.restoreReady
        }
        if (CS.setFeedPush) CS.setFeedPush("re-attach failed: " + (e.message || "?"));
        appendFeed("console", "⚠ re-attach failed · " + CS.esc(e.message || "?"), "fl-warn");
      });
      const launcher = $("#launcher"), run = $("#runview");
      if (launcher) launcher.hidden = false;
      if (run) run.hidden = true;
    }

    /* reload-safe restore: last convened session (localStorage) re-enters
       the run view instead of the launcher */
    restoreLastSession();
  }

  init();
})();