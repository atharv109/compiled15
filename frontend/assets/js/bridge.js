/* ============================================================
   Customer Swarm — bridge.js
   The contract between the console shell and the step modules.

   A step module registers itself as:
     CS.register({
       id: 'scout', num: 1, title: 'Scout', short: 'Scouts & evidence',
       render(mount, session) { ... },   // called on activation (session is full state)
       onEvent(evt) { ... },             // called for each streaming event while active
       tick(dt) {},                     // optional, called ~4x/sec while active
     });

   Events flow one way: the replay/live engine applies each event to
   CS.session (the single source of truth), then emits it on CS.bus.
   Steps NEVER mutate session themselves — they render from it.

   Session shape is defined in mock-data.js (window.CS_SESSION_DEMO).
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny DOM helpers ---------- */
  const CS = {
    STEPS: [],
    PAL: ["#B45309", "#0F766E", "#7C3AED", "#1D4ED8", "#BE185D",
          "#65A30D", "#C2410C", "#0369A1", "#7E22CE", "#4D7C0F"],
    STRIPE_LINK: window.CS_STRIPE_LINK || null,

    session: null,
    bus: new EventTarget(),
    state: "idle",           // idle | running | done
    currentStep: -1,

    register(step) {
      if (CS.STEPS.some((s) => s.id === step.id)) return;
      CS.STEPS.push(step);
      CS.STEPS.sort((a, b) => a.num - b.num);
      CS.bus.dispatchEvent(new CustomEvent("steps:changed"));
    },

    on(name, fn) {
      CS.bus.addEventListener(name, fn);
      return () => CS.bus.removeEventListener(name, fn);
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

  /* ============================================================
     Event → session mutations  (single place, steps just render)
     ============================================================ */
  const apply = {
    "session:start"(d) {
      CS.session = {
        business: { name: d.business, class: "unknown" },
        question: d.question,
        sources: [], reviews: [], evidence: [], segments: [], personas: [],
        debate: { rounds: [] },
        verdict: null,
        loop: { running: false, iterations: [], chart: [], seed: 1234 },
        chatLog: [],
      };
    },
    "scout:status"(d) { CS.session.business.class = d.business_class || "unknown"; },
    "scout:source"(d) {
      const s = CS.session.sources.find((x) => x.key === d.key);
      if (s) Object.assign(s, d); else CS.session.sources.push({ ...d });
    },
    "scout:reviews"(d) { CS.session.reviews.push(...d.items); },
    "scout:done"() {},
    "evidence"(d) { CS.session.evidence.push(d); },
    "segment"(d) { CS.session.segments.push(d); },
    "persona"(d) { CS.session.personas.push(d); },
    "debate:round"(d) {
      CS.session.debate.rounds.push({ n: d.n, camps: [], digest: null, done: false });
    },
    "debate:camp"(d) {
      const r = round(d.round);
      if (r) r.camps.push({ name: d.name, size: d.size, summary: d.summary, members: [], args: [] });
    },
    "debate:arg"(d) {
      const r = round(d.round), c = r && r.camps.find((x) => x.name === d.camp);
      if (c) {
        c.args.push({ agent: d.agent, agentId: d.agent_id, text: d.text, cites: d.cites || [] });
        if (!c.members.includes(d.agent)) c.members.push(d.agent);
      }
    },
    "debate:digest"(d) {
      const r = round(d.round);
      if (r) r.digest = d;               // {about_camp, bullets: [...]}
    },
    "debate:demoted"(d) {
      CS.session.demoted = CS.session.demoted || [];
      CS.session.demoted.push(d);        // {agent, text, reason}
    },
    "debate:done"() { const rs = CS.session.debate.rounds; if (rs.length) rs[rs.length - 1].done = true; },
    "verdict"(d) { CS.session.verdict = d; },
    "loop:start"(d) { CS.session.loop.running = true; if (d && d.seed) CS.session.loop.seed = d.seed; },
    "loop:iter"(d) { CS.session.loop.iterations.push(d); },
    "loop:chart"(d) { CS.session.loop.chart = d.points || d; },
    "loop:done"(d) {
      CS.session.loop.running = false;
      if (d && d.chart) CS.session.loop.chart = d.chart;
    },
  };
  function round(n) {
    return CS.session && CS.session.debate.rounds.find((r) => r.n === n);
  }

  /* re-apply every event of a finished dataset to rebuild session state
     (used for skipped-ahead replays) */
  function rebuild(events) {
    for (const [name, data] of events) apply[name] && apply[name](data);
  }

  /* ============================================================
     Drivers: mock replay (default) or live SSE (?live=1&sid=…)
     ============================================================ */
  const EASE = {
    "scout:start": 300, "scout:source": 900, "scout:reviews": 700,
    "scout:done": 500, "evidence": 520, "segment": 700, "persona": 110,
    "debate:round": 700, "debate:camp": 800, "debate:arg": 1400,
    "debate:digest": 1100, "debate:demoted": 900, "debate:done": 400,
    "verdict": 1200, "loop:start": 500, "loop:iter": 1200, "loop:done": 200,
  };

  let running = false, abort = null;

  CS.start = async function (business, question, opts) {
    opts = opts || {};
    if (running) return;
    CS.state = "running";
    /* No session:start/step:target emissions here: the driver's own
       session:start (applied to state BEFORE it's emitted) drives the
       mount so steps always render with a session present. */

    const live = opts.live && opts.sid;
    let events, driver;
    if (live) {
      driver = openSSE(opts.sid);
    } else {
      events = buildScript(window.CS_SESSION_DEMO, business, question);
      driver = replayScript(events);
    }
    running = true;
    for await (const [name, data] of driver) {
      if (abort) break;
      apply[name] && apply[name](data);
      CS.emit(name, data);
      const wait = EASE[name] || 400;
      if (wait) await sleep(wait);
    }
    running = false;
    CS.state = "done";
    CS.emit("stream:done", {});
  };

  function sleep(ms) {
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      CS.skip = () => { clearTimeout(t); res(); };   // shortens the current wait
    });
  }

  /* async generator over a static event list, with lookahead buffer */
  function replayScript(events) {
    let i = 0;
    const it = {
      [Symbol.asyncIterator]() { return it; },
      async next() { return i < events.length ? { value: events[i++] } : { done: true }; },
      get buffer() { return events; },
    };
    return it;
  }

  /* live backend: SSE channel per session; event names match the bus */
  function openSSE(sid) {
    const src = new EventSource(`/api/sessions/${sid}/stream`);
    let resolver = null;
    const q = [];
    src.onmessage = (m) => {
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      const ev = [e.event || e.type, e.data || {}];
      if (resolver) { const r = resolver; resolver = null; r({ value: ev }); }
      else q.push(ev);
    };
    src.addEventListener("end", () => { src.close(); q.push(null); if (resolver) { resolver({ done: true }); resolver = null; } });
    const it = {
      [Symbol.asyncIterator]() { return it; },
      async next() {
        if (q.length) { const v = q.shift(); return v === null ? { done: true } : { value: v }; }
        return new Promise((res) => (resolver = res));
      },
      get buffer() { return null; },
    };
    return it;
  }

  /* ============================================================
     Script builder: turn the structured demo dataset into an
     ordered event stream. Personas are synthesized from segments.
     ============================================================ */
  function buildScript(D, businessName, questionOverride) {
    const ev = [];
    const sess = D;
    const name = businessName || sess.business.name;
    const question = questionOverride || sess.question;
    ev.push(["session:start", { business: name, question }]);
    ev.push(["scout:status", { business_class: sess.business.class }]);
    for (const s of sess.sources) ev.push(["scout:source", s]);
    ev.push(["scout:reviews", { items: sess.reviews.slice(0, 8) }]);
    ev.push(["scout:done", { total: sess.sources.reduce((a, s) => a + (s.count || 0), 0) }]);
    for (const e of sess.evidence) ev.push(["evidence", e]);
    for (const g of sess.segments) ev.push(["segment", g]);
    for (const p of sess.personas) ev.push(["persona", p]);
    const R = sess.debate.rounds;
    for (const r of R) {
      ev.push(["debate:round", { n: r.n }]);
      for (const c of r.camps) {
        ev.push(["debate:camp", { round: r.n, name: c.name, size: c.size, summary: c.summary }]);
        for (const a of c.args) {
          ev.push(["debate:arg", { round: r.n, camp: c.name, agent: a.agent, agent_id: a.agentId, text: a.text, cites: a.cites }]);
        }
      }
      ev.push(["debate:digest", { round: r.n, ...r.digest }]);
      const demoted = (sess.demoted || (sess.debate && sess.debate.demoted) || []);
      if (demoted.some((d) => d.round === r.n)) {
        for (const d of demoted.filter((x) => x.round === r.n))
          ev.push(["debate:demoted", d]);
      }
      ev.push(["debate:done", {}]);
    }
    ev.push(["verdict", sess.verdict]);
    return ev;
  }

  /* Loop driver — started on demand from the Learn step */
  CS.runLoop = async function () {
    if (!CS.session || CS.session.loop.running) return;
    const L = window.CS_SESSION_DEMO.loop;
    CS.session.loop.running = true;
    CS.session.loop.seed = L.seed;
    CS.emit("loop:start", { seed: L.seed });
    for (const it of L.iterations) {
      await sleep(1100);
      CS.session.loop.iterations.push(it);
      CS.emit("loop:iter", it);
    }
    CS.session.loop.running = false;
    CS.session.loop.chart = L.chart;
    CS.emit("loop:done", { chart: L.chart });
  };

  CS.rerollLoop = async function () {
    const L = window.CS_SESSION_DEMO.loop;
    CS.session.loop.iterations = [];
    CS.session.loop.seed = L.seed2;
    CS.emit("loop:start", { seed: L.seed2 });
    for (const it of L.iterations2) {
      await sleep(900);
      CS.session.loop.iterations.push(it);
      CS.emit("loop:iter", it);
    }
    CS.session.loop.chart = L.chart2;
    CS.emit("loop:done", { chart: L.chart2 });
  };

  /* Chat (mock): canned reply per persona */
  CS.chat = async function (personaId, text) {
    const reply = window.CSMock
      ? window.CSMock.chat(CS.session, personaId, text)
      : "…";
    await sleep(700);
    return reply;
  };

  /* Paid gate (demo): set by Stripe success redirect ?paid=1 */
  CS.isPaid = function () {
    try {
      return new URLSearchParams(location.search).has("paid") ||
        localStorage.getItem("cs_paid") === "1";
    } catch { return false; }
  };
  CS.markPaid = function () {
    try { localStorage.setItem("cs_paid", "1"); } catch {}
    CS.emit("paid", {});
  };
})();