/* ============================================================
   Customer Swarm — bridge.js
   The contract between the console shell and the step modules.

   A step module registers itself as:
     CS.register({
       id: 'scout', num: 1, title: 'Scout', short: 'Scouts & evidence',
       render(mount, session) { ... },   // called on activation (session is full state)
       onEvent(evt) { ... },             // (legacy hook, unused)
       tick(dt) {},                      // optional
     });

   Events flow one way: the driver applies each event to CS.session
   (the single source of truth), then emits it on CS.bus.
   Steps NEVER mutate session themselves — they render from it.

   LIVE driver (default): talks to the real FastAPI backend —
   POST /api/sessions → SSE /api/sessions/{sid}/stream (named events:
   status | evidence | persona_start | stance | camp | verdict | act),
   auto-fires /question when the snapshot flips to "ready", polls the
   snapshot for gate-state. DEMO driver (?mock=1): same shape, backend
   replays its recorded fixture through the identical event vocabulary.
   ============================================================ */
(function () {
  "use strict";

  const CS = {
    STEPS: [],
    PAL: ["#B45309", "#0F766E", "#7C3AED", "#1D4ED8", "#BE185D",
          "#65A30D", "#C2410C", "#0369A1", "#7E22CE", "#4D7C0F"],
    STRIPE_LINK: window.CS_STRIPE_LINK || null,
    /* CS.STRIPE_LINK is a frontend override only; the backend /pay decides what
       to open or whether to run the demo mark-paid flow. */

    session: null,
    bus: new EventTarget(),
    state: "idle",           // idle | running | done
    currentStep: -1,

    /* named listener registry — lets pay-time code know whether a repaint
       hook (e.g. the console's "paid" handler) exists for an event */
    _listeners: {},

    register(step) {
      if (CS.STEPS.some((s) => s.id === step.id)) return;
      CS.STEPS.push(step);
      CS.STEPS.sort((a, b) => a.num - b.num);
      CS.bus.dispatchEvent(new CustomEvent("steps:changed"));
    },

    on(name, fn) {
      (CS._listeners[name] = CS._listeners[name] || new Set()).add(fn);
      CS.bus.addEventListener(name, fn);
      return () => {
        const set = CS._listeners[name];
        if (set) set.delete(fn);
        CS.bus.removeEventListener(name, fn);
      };
    },

    hasListener(name) {
      const set = CS._listeners[name];
      return !!(set && set.size);
    },

    emit(name, detail) {
      CS.bus.dispatchEvent(new CustomEvent(name, { detail }));
    },

    esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },

    el(html) {
      const t = document.createElement("template");
      t.innerHTML = html.trim();
      return t.content.firstElementChild;
    },

    /* deterministic-ish avatar for a persona id */
    color(id) {
      let h = 0;
      for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return CS.PAL[h % CS.PAL.length];
    },
  };
  window.CS = CS;

  /* ---------- API helpers (same-origin by default; page is served from :8000/demo) ---------- */
  CS.API_BASE = String(window.CS_API_BASE || "").replace(/\/+$/, "");
  function apiFetch(path, opts) {
    return fetch(CS.API_BASE + path, Object.assign(
      { headers: { "Content-Type": "application/json" } }, opts || {}))
      .then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, body: j }))
      ).then(({ ok, status, body }) => {
        if (!ok) {
          const e = new Error((body && body.detail) || ("HTTP " + status));
          e.status = status;
          throw e;
        }
        return body;
      });
  }
  const apiPost = (path, body) =>
    apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) });

  const SOURCE_LABEL = {
    classify: "Business classifier", tavily_web: "Tavily web (menu · news)",
    google_reviews: "Google reviews", manual_paste: "Owner-pasted reviews",
  };

  /* ============================================================
     Event → session mutations  (single place; steps just render)
     ============================================================ */
  const apply = {
    "session:start"(d) {
      CS.session = {
        sid: d.sid || null,
        business: { name: d.business, town: d.town, class: "unknown", business_class: "" },
        question: d.question || "",
        sources: [], reviews: [], evidence: [], segments: [], personas: [],
        debate: { rounds: [] },
        verdict: null,
        paid: false,
        mock: !!d.mock,
        loop: { running: false, seed: 1234, result: null, chart: null, beliefs: {} },
        act: { running: false, result: null },
        elapsedFrom: d.elapsedFrom || null,
      };
    },
    "scout:status"(d) {
      CS.session.business.business_class = d.business_class || "";
      CS.session.business.class = d.business_class || "unknown";
    },
    "business:resolved"(d) {
      const e = (d && d.entity) || {};
      const biz = CS.session.business;
      if (e.display_name) biz.name = e.display_name;
      if (e.location) biz.town = e.location;
      Object.assign(biz, { entity: e, kind: e.business_kind || "",
        confidence: e.confidence, candidates: e.candidates || [] });
    },
    "scout:source"(d) {
      const s = CS.session.sources.find((x) => x.key === d.key);
      if (s) Object.assign(s, d); else CS.session.sources.push({ ...d });
    },
    "scout:reviews"(d) {
      for (const it of d.items || []) {
        const key = (it.text || "").slice(0, 80);
        if (key && !CS.session.reviews.some((r) => (r.text || "").slice(0, 80) === key))
          CS.session.reviews.push(it);
      }
    },
    "scout:done"() { CS.session.scoutDone = true; },
    "evidence"(d) {
      const card = d && d.card ? d.card : d;
      if (!card || !card.id) return;
      if (CS.session.evidence.some((x) => x.id === card.id)) return;
      CS.session.evidence.push(card);
    },
    "segment"(d) {
      const name = d.name || d.id;
      if (!name) return;
      if (CS.session.segments.some((x) => x.name === name)) return;
      CS.session.segments.push({ id: name, name: name, size: d.count || d.size || 0,
        description: d.description || "" });
    },
    "persona"(d) {
      if (!d || !d.id || CS.session.personas.some((x) => x.id === d.id)) return;
      CS.session.personas.push({
        id: d.id, segment: d.segment, name: d.name,
        profile: d.profile || d.quote || "", quote: d.profile || d.quote || "",
        stance: d.stance || null, source_review_ids: d.source_review_ids || [],
      });
    },
    "persona:stance"(d) {
      const p = (CS.session.personas || []).find((x) => x.id === d.persona_id);
      if (p) { p.stance = d.stance || p.stance; if (d.reason) p.quote = d.reason; }
    },
    "debate:round"(d) {
      if (CS.session.debate.rounds.some((r) => r.n === d.n)) return;
      CS.session.debate.rounds.push({ n: d.n, stances: [], camps: [], done: false });
    },
    "debate:stance"(d) {
      let r = CS.session.debate.rounds.find((x) => x.n === d.round);
      if (!r) { r = { n: d.round, stances: [], camps: [], done: false };
        CS.session.debate.rounds.push(r); }
      r.stances.push({ persona_id: d.persona_id, persona_name: d.persona_name || "",
        segment: d.segment, stance: d.stance, stance_label: d.stance_label,
        reason: d.reason, evidence_ids: d.evidence_ids || [], camp: null });
    },
    "debate:camp"(d) {
      const r = roundOf(d.round);
      if (!r) return;
      if (r.camps.some((c) => c.name === d.name)) return;
      r.camps.push({ name: d.name, size: (d.member_ids || []).length,
        member_ids: d.member_ids || [], top_arguments: d.top_arguments || [] });
      /* retro-tag the round's stance cards with their camp */
      const members = new Set(d.member_ids || []);
      for (const st of r.stances) if (members.has(st.persona_id)) st.camp = d.name;
    },
    "debate:done"() {
      const rs = CS.session.debate.rounds; if (rs.length) rs[rs.length - 1].done = true;
    },
    "verdict"(d) { CS.session.verdict = d; CS.session.question = CS.session.question || d.question || undefined; },
    "paid"(d) { CS.session.paid = !!(d && d.paid); },
    "loop:start"(d) {
      CS.session.loop.running = true; CS.session.loop.result = null;
      CS.session.loop.chart = null; CS.session.loop.beliefs = {};
      if (d && d.seed != null) CS.session.loop.seed = d.seed;
      CS.session.loop.t0 = Date.now();
    },
    "loop:done"(d) {
      CS.session.loop.running = false;
      if (d && d.result) {
        CS.session.loop.result = d.result;
        CS.session.loop.chart = d.chart;
        CS.session.loop.beliefs = d.beliefs || {};
        CS.session.loop.seed = d.seed != null ? d.seed : CS.session.loop.seed;
      }
    },
    "act:progress"(d) { CS.session.act.lastProgress = (d && d.stage_detail) || ""; },
    "act:done"(d) {
      CS.session.act.running = false;
      if (d && d.result) { CS.session.act.result = d.result; CS.session.act.error = null; }
      if (d && d.error) { CS.session.act.error = d.error; }
    },
  };
  function roundOf(n) {
    return CS.session && CS.session.debate.rounds.find((r) => r.n === n);
  }

  /* ============================================================
     Pacing — live feeds arrive at provider speed; keep a small
     breath between events so the stage reads, without adding
     minutes over a ~100-stance debate. Backlog replays (a shared
     ?sid link) are paced more theatrically.
     ============================================================ */
  const EASE = {
    "scout:status": 220, "scout:source": 130, "scout:reviews": 90, "scout:done": 420,
    "evidence": 85, "segment": 260, "persona": 90,
    "debate:round": 560, "debate:stance": 110, "debate:camp": 520,
    "debate:done": 300, "verdict": 760,
  };
  const REPLAY_EASE = null; /* legacy replay pacing removed — live backend paces itself */

  let running = false;

  CS.start = async function (business, town, question, opts) {
    opts = opts || {};
    if (running) return;
    running = true;
    CS.state = "running";
    try {
      const body = opts.mock
        ? { business_name: business, town: town, mock: true }
        : { business_name: business, town: town };
      /* owner-pasted listing/website (optional): helps the scouts anchor the
         right business — sent as anchor_url (contract v2); backend accepts it */
      if (opts.anchorUrl) body.anchor_url = opts.anchorUrl;
      const created = await apiPost("/api/sessions", body);
      const sid = created.session_id;
      apply["session:start"]({ business, town, question, sid, mock: !!opts.mock });
      CS.emit("session:start", { business, question });
      await runLive(sid, question, true);
    } catch (err) {
      fail(err);
    }
  };

  /* re-attach mid/after the debate (snap.question present): replay backlog */
  CS.restore = async function (sid, opts) {
    opts = opts || {};
    if (running) return;
    running = true;
    CS.state = "running";
    try {
      const snap = await apiFetch("/api/sessions/" + sid);
      if (snap.status === "ready" && !snap.question && !opts.question) {
        /* scouted but undecided: needs the owner's question — see restoreReady */
        throw Object.assign(new Error("session ready — enter your decision to convene the debate"), { readyNoQuestion: true, snap });
      }
      seedSession(snap, sid, !!opts.mock);
      await runLive(sid, snap.question || "", false);
      if (snap.verdict && !CS.session.verdict) {   // debate tail already consumed
        apply["verdict"](snap.verdict); CS.emit("verdict", snap.verdict);
      }
    } catch (err) {
      if (err && err.readyNoQuestion) {
        CS.state = "idle";
        throw err;    // caller shows the launcher again
      }
      fail(err);
    }
  };

  /* owner types the decision for an already-scouted session */
  CS.restoreReady = async function (sid, question, opts) {
    opts = opts || {};
    if (running) return;
    running = true;
    CS.state = "running";
    try {
      const snap = await apiFetch("/api/sessions/" + sid);
      seedSession(snap, sid, !!opts.mock);
      CS.session.question = question;
      await runLive(sid, question, true);
    } catch (err) { fail(err); }
  };

  function seedSession(snap, sid, mock) {
    apply["session:start"]({
      business: (snap.business || {}).name || "business",
      town: (snap.business || {}).town || "",
      question: snap.question || "",
      sid: sid, mock: !!mock,
    });
    CS.emit("session:start", { business: (snap.business || {}).name, question: snap.question });
    if (snap.status === "ready" || snap.status === "verdict_ready") {
      apply["scout:done"]({}); CS.emit("scout:done", {});
    }
    snap.evidence && snap.evidence.forEach((c) => { apply["evidence"](c); });
    snap.segments && snap.segments.forEach((s) => { apply["segment"](s); });
    snap.personas && snap.personas.forEach((p) => { apply["persona"](p); });
    if (snap.paid) {
      apply["paid"]({ paid: true }); CS.emit("paid", { paid: true });
    }
  }

  /* owner picked a "did you mean" candidate: re-run intake with it as the
     anchor — same name/town/question, new session, new scouts */
  CS.rechoose = async function (anchorUrl) {
    if (!CS.session) return;
    const name = CS.session.business.name;
    const town = CS.session.business.town;
    const question = CS.session.question;
    CS.session._stop = true;          /* break the running stream loop */
    await new Promise((res) => setTimeout(res, 700));
    running = false;
    CS.state = "idle";
    CS.session = null;
    await CS.start(name, town, question, { anchorUrl: anchorUrl });
  };

  /* server-side candidates are label-only (no URL): re-run intake with the
     picked label as the business name */
  CS.rechooseLabel = async function (label) {
    if (!CS.session) return;
    const town = CS.session.business.town;
    const question = CS.session.question;
    CS.session._stop = true;
    await new Promise((res) => setTimeout(res, 700));
    running = false;
    CS.state = "idle";
    CS.session = null;
    await CS.start(String(label || "business"), town, question, {});
  };

  /* owner said "wrong business": break the stream and let the launcher
     take over again — the loop teardown closes the SSE + poller */
  CS.stop = function () {
    if (CS.session) CS.session._stop = true;
  };

  function fail(err) {
    running = false;
    CS.state = "done";
    CS.emit("stream:error", { message: (err && err.message) || "backend unreachable", backend: true });
    CS.emit("stream:done", {});
  }

  async function runLive(sid, question, autoQuestion) {
    const es = new EventSource(CS.API_BASE + "/api/sessions/" + sid + "/stream");
    const seenEv = new Set();             // evidence ids already applied
    const q = [];                          // normalized [name, data] queue
    let resolver = null, streamEnded = false;

    const queue = (name, data) => {
      if (resolver) { const r = resolver; resolver = null; r({ value: [name, data] }); }
      else q.push([name, data]);
    };

    es.addEventListener("status", (e) => {
        const d = safeJSON(e.data);
        if (d.status === "scouting") {
          /* server resolved the business entity (Maps/website) — the
             authoritatitve "confirm the business we found" signal */
          if (d.stage === "resolved" && d.entity) {
            const v = { entity: d.entity };
            apply["business:resolved"](v); CS.emit("business:resolved", v);
          }
          if (d.stage === "candidates" && Array.isArray(d.candidates)) {
            CS.emit("intake:candidates", { candidates: d.candidates,
              name: CS.session && CS.session.business ? CS.session.business.name : "" });
          }
          if (d.business_class) { const n = "scout:status", v = { business_class: d.business_class };
            apply[n](v); CS.emit(n, v); }
          if (d.stage) {
            const v = { key: d.stage, label: SOURCE_LABEL[d.stage] || stageLabel(d.stage),
              status: /failed|skipped/i.test(String(d.detail || "")) ? "pending" : "ok",
              count: d.cards != null ? d.cards : undefined,
              note: d.detail || (d.cards != null ? "done" : "") };
            apply["scout:source"](v); CS.emit("scout:source", v);
          }
        } else if (d.status === "debating" && (d.detail || d.round != null)) {
          const v = { key: "debate", label: "Debate lane",
            status: "ok", note: d.detail || ("round " + d.round) };
          apply["scout:source"](v); CS.emit("scout:source", v);
        } else if (d.status === "ready") {
          const v = { key: "scout", label: "Swarm scout", status: "ok", note: "done" };
          apply["scout:done"](v); CS.emit("scout:done", v);
        }
      });
      es.addEventListener("evidence", (e) => {
        const d = safeJSON(e.data);
        const card = d && d.card ? d.card : d;
        if (!card || !card.id || seenEv.has(card.id)) return;
        seenEv.add(card.id);
        apply["evidence"](card); CS.emit("evidence", card);
        /* reviews column fills live from review-type cards */
        if (card.type === "review") {
          const v = { items: [{ text: card.quote || card.claim, rating: null,
                                source: card.source_label || "" }] };
          apply["scout:reviews"](v); CS.emit("scout:reviews", v);
        }
      });
      es.addEventListener("persona_start", (e) => {
        const d = safeJSON(e.data);
        const v = { id: d.persona_id, segment: d.segment, name: d.name, profile: "" };
        apply["persona"](v); CS.emit("persona", v);
      });
      const seenRounds = new Set();
      const seenStances = new Set();
      es.addEventListener("stance", (e) => {
        const d = safeJSON(e.data);
        const key = d.round + "|" + d.persona_id;
        if (seenStances.has(key)) return;
        seenStances.add(key);
        if (!seenRounds.has(d.round)) {
          seenRounds.add(d.round);
          const v = { n: d.round }; apply["debate:round"](v); CS.emit("debate:round", v);
          if (d.round > 1) { const p = { n: d.round - 1 };
            apply["debate:done"](p); CS.emit("debate:done", p); }
        }
        const p = (CS.session.personas || []).find((x) => x.id === d.persona_id);
        const v = { ...d, persona_name: p ? p.name : d.persona_id };
        apply["debate:stance"](v); CS.emit("debate:stance", v);
        const ps = { persona_id: d.persona_id, stance: d.stance, reason: d.reason };
        apply["persona:stance"](ps); CS.emit("persona:stance", ps);
      });
      const seenCamps = new Set();
      es.addEventListener("camp", (e) => {
        const d = safeJSON(e.data);
        const key = d.round + "|" + d.camp;
        if (seenCamps.has(key)) return;
        seenCamps.add(d.round);
        seenCamps.add(key);
        const v = { round: d.round, name: d.camp, member_ids: d.member_ids,
          top_arguments: d.top_arguments };
        apply["debate:camp"](v); CS.emit("debate:camp", v);
      });
      es.addEventListener("verdict", (e) => {
        const d = safeJSON(e.data);
        apply["verdict"](d); CS.emit("verdict", d);
        for (let n = 1; n <= 2; n++) {
          const v = { n }; apply["debate:done"](v); CS.emit("debate:done", v);
        }
        streamEnded = true;
      });
      es.addEventListener("act", (e) => {
        const d = safeJSON(e.data);
        const v = { stage_detail: d.stage_detail };
        apply["act:progress"](v); CS.emit("act:progress", v);
      });
      es.onerror = () => { /* EventSource retries; snapshot poll keeps us honest */ };

      /* ---------- snapshot poll: catch-up + auto-question + paid flag ---------- */
      const poller = setInterval(() => {
        apiFetch("/api/sessions/" + sid).then((snap) => {
          if (autoQuestion && snap.status === "ready" && question &&
              !CS.session.questionSent) {
            CS.session.questionSent = true;
            if (!CS.session.scoutDone) {
              apply["scout:done"]({}); CS.emit("scout:done", {});
            }
            apiPost("/api/sessions/" + sid + "/question", { text: question })
              .catch((e2) => {
                if (e2.status === 409 && /ingesting|scouting/.test(String(e2.message || ""))) {
                  CS.session.questionSent = false; return;   // not ready yet — retry
                }
                apiPushFeed && apiPushFeed("we couldn't start the debate (" +
                  (e2.message || "rejected") + ") — wait a moment, it retries automatically");
              });
          }
          const entCands = ((snap.business || {}).entity || {}).candidates || [];
          if (((Array.isArray(snap.candidates) && snap.candidates.length) ||
               entCands.length) && !CS.session.candidatesShown) {
            CS.session.candidatesShown = true;
            CS.emit("intake:candidates", {
              candidates: (snap.candidates || []).concat(entCands),
              name: (snap.business || {}).name || "",
            });
          }
          if (snap.paid && CS.session && !CS.session.paid) {
            apply["paid"]({ paid: true }); CS.emit("paid", { paid: true });
          }
        }).catch(() => { /* transient */ });
      }, 1400);

      const sleep = (ms) => new Promise((res) => {
        const t = setTimeout(res, ms);
        CS.skip = () => { clearTimeout(t); res(); };   // shortens the current wait
      });

      function stageLabel(stage) {
        return String(stage || "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
      }

      /* ---------- run the queue through the same apply/emit/pacing path ---------- */
      while (!streamEnded || q.length) {
        if (CS.session && CS.session._stop) break;   /* rechoose interrupted us */
        if (!q.length) {
          const item = await new Promise((res) => { resolver = res;
            setTimeout(() => { if (resolver === res) { resolver = null; res(null); } }, 350); });
          if (!item) continue;
        }
        const [name, data] = q.shift();
        if (!name) continue;
        apply[name] && apply[name](data);
        CS.emit(name, data);
        const wait = EASE[name] || 0;
        if (wait) await sleep(wait);
      }
      running = false;
      CS.state = "done";
      CS.emit("stream:done", {});
      try { es.close(); } catch (e) { /* noop */ }
      clearInterval(poller);
      CS.skip = null;
  }

  function safeJSON(s) { try { return JSON.parse(s); } catch { return {}; } }
  let apiPushFeed = null;    // console.js injects so bridge errors reach the feed
  CS.setFeedPush = (fn) => { apiPushFeed = fn; };

  /* ============================================================
     Pay gate — real backend: GET /pay (Stripe link) + POST /pay,
     then the snapshot poll flips session.paid and the UI unlocks.
     Demo (no Stripe link configured): mark-paid directly.
     ============================================================ */
  CS.isPaid = function () {
    return !!(CS.session && CS.session.paid);
  };
  CS.pay = async function () {
    if (!CS.session || !CS.session.sid) return false;
    /* /pay semantics (v3): either {payment_url:<real link>, provider} or
       {payment_url:null, demo:true} — demo mode goes straight to mark-paid. */
    try {
      const r = await apiFetch("/api/sessions/" + CS.session.sid + "/pay");
      const url = (!r.demo && r.payment_url) || "";
      if (url) { try { window.open(url, "_blank", "noopener"); } catch (e) { /* noop */ } }
    } catch (e) { /* fall through to mark-paid (demo checkout) */ }
    try {
      await apiPost("/api/sessions/" + CS.session.sid + "/pay/mark-paid", {});
      CS.session.paid = true;
      CS.emit("paid", { paid: true });
      /* Prefer repaint: this page's "paid" listener re-renders the unlock in
         place, so no reload and the active session stays on screen. Only a
         stale page lacking that listener takes the delayed-reload fallback
         (server-side paid state is authoritative there). */
      if (!CS.hasListener("paid")) {
        setTimeout(() => { try { location.reload(); } catch (e) { /* noop */ } }, 2000);
      }
      return true;
    } catch (e) { return false; }
  };

  /* ============================================================
     Agent chat — real backend (P1-3), 402-gated server-side.
     Returns { reply, evidence_ids }.
     ============================================================ */
  CS.chat = async function (personaId, text) {
    if (!CS.session || !CS.session.sid) return { reply: "(no session open)", evidence_ids: [] };
    const r = await apiPost("/api/sessions/" + CS.session.sid + "/agents/" +
      encodeURIComponent(personaId) + "/chat", { message: text });
    return { reply: r.reply || "…", evidence_ids: r.evidence_ids || [] };
  };

  /* ============================================================
     Learning loop — real Track 1A loop (2–4 min). Response:
     round_scores / final_eval / beliefs / chart / truth_seed.
     Emitted normalized as loop:done {result, chart, beliefs, seed}.
     ============================================================ */
  CS.runLoop = async function (opts) {
    opts = opts || {};
    if (!CS.session || !CS.session.sid || CS.session.loop.running) {
      throw new Error("no session");
    }
    const seed = opts.seed != null ? opts.seed : null;
    apply["loop:start"]({ seed: seed != null ? seed : CS.session.loop.seed });
    CS.emit("loop:start", { seed: seed != null ? seed : CS.session.loop.seed });
    try {
      const result = seed == null
        ? await apiPost("/api/sessions/" + CS.session.sid + "/run-loop", {})
        : await apiPost("/api/sessions/" + CS.session.sid + "/loop/reroll", { seed: seed });
      const done = { result: result, chart: loopChartShape(result),
        beliefs: result.beliefs || {}, seed: result.truth_seed };
      apply["loop:done"](done); CS.emit("loop:done", done);
      return result;
    } catch (e) {
      apply["loop:done"]({}); CS.emit("loop:done", { error: e.message || "loop failed" });
      throw e;
    }
  };

  function loopChartShape(result) {
    const rows = result.round_scores || [];
    const train = rows.filter((r) => !r.split || r.split === "train");
    return {
      points: train.map((r) => ({ i: r.round, train: r.regret,
        test: r.prediction_error != null ? r.prediction_error : r.regret })),
      baseline: (result.final_eval || {}).baseline_regret,
      final_eval: result.final_eval || null,
    };
  }
  CS.loopChartRestore = async function () {
    if (!CS.session || !CS.session.sid) return null;
    const d = await apiFetch("/api/sessions/" + CS.session.sid + "/loop-chart");
    /* backend make_chart_data wraps: {chart:{train_line,test_line,final_test_bar},
       truth_seed, contexts, beliefs} — accept bare/future shapes too */
    let chart = (d && d.chart) || d || {};
    /* contract-v1 shape {train, test_bar} normalized into the same view */
    if (!chart.train_line && Array.isArray(chart.train)) {
      chart = { train_line: chart.train.map((r) => ({ round: r.round, regret: r.regret,
        prediction_error: r.prediction_error })),
        final_test_bar: chart.test_bar || null };
    }
    if (!chart || !chart.train_line || !chart.train_line.length) return null;
    const tb = chart.final_test_bar || {};
    return { result: { final_eval: tb, round_scores: [] },
      chart: {
        points: chart.train_line.map((p) => ({ i: p.round, train: p.regret,
          test: p.prediction_error != null ? p.prediction_error : null })),
        baseline: tb.baseline_regret,
        final_eval: tb,
      },
      beliefs: (d && d.beliefs) || {} };
  };

  /* ============================================================
     Act (P2) — POST /act renders drafts + scores; server 402-gates.
     ============================================================ */
  CS.runAct = async function () {
    if (!CS.session || !CS.session.sid) throw new Error("no session");
    CS.session.act.running = true;
    CS.session.act.error = null;
    CS.emit("act:start", {});
    try {
      const result = await apiPost("/api/sessions/" + CS.session.sid + "/act", {});
      apply["act:done"]({ result }); CS.emit("act:done", { result });
      return result;
    } catch (e) {
      CS.session.act.running = false;
      CS.session.act.error = (e.message || "act failed");
      CS.session.act.status402 = e.status === 402;
      CS.emit("act:done", { error: e.message || "act failed", status: e.status });
      throw e;
    }
  };
})();