/* ============================================================
   Customer Swarm — steps/scout.js
   Step 1 · Scout: name-only intake.
   Renders EVERYTHING from CS.session (never mutates it).
   Mounted already mid-stream or re-mounted later — either way
   the full draw comes from session; live scout:* events patch
   the existing DOM in place.
   ============================================================ */
(function () {
  "use strict";

  const CS = window.CS;
  if (!CS) return;

  const S = {
    done: false,   // set by scout:done, survives step re-mounts
  };

  CS.on("session:start", () => { S.done = false; });

  function isActive() {
    return !!(CS.STEPS[CS.currentStep] && CS.STEPS[CS.currentStep].id === "scout");
  }
  function live() { return isActive() && !!CS.session; }

  /* if the step never got its full draw (mounted before any data), and the
     stream is already delivering data, re-mount — partial patches need it */
  function remountIfStale() {
    const step = CS.STEPS.find((x) => x && x.id === "scout");
    if (document.getElementById("sc-src-list") || !step || !CS.session) return;
    const mount = document.getElementById("step-mount");
    if (mount && isActive()) step.render(mount, CS.session);
  }

  /* ---------- event hooks (patch only; never touch session) ---------- */
  CS.on("scout:status", (e) => {
    if (!live()) return;
    remountIfStale();
    const el = document.getElementById("sc-banner");
    if (el) el.innerHTML = bannerHtml(CS.session.business.class);
  });
  CS.on("scout:source", (e) => {
    if (!live()) return;
    remountIfStale();
    upsertSource(e.detail);
  });
  CS.on("scout:reviews", () => { if (live()) { remountIfStale(); drawReviews(); } });
  CS.on("scout:done", () => {
    S.done = true;
    if (live()) refreshChrome();
  });

  /* ============================================================ */

  function familyOf(cls) {
    return /b2b|saas|professional|corporate/i.test(String(cls || ""))
      ? "professionals" : "consumers";
  }
  function chipClass(status) {
    switch (status) {
      case "ok": return "ok";
      case "cached": return "cached";
      case "scraped": return "scraped";
      default: return "pending";
    }
  }
  function srcRow(s, anim) {
    return CS.el(
      '<div class="src-row' + (anim ? " anim" : "") + '" data-key="' +
      CS.esc(s.key) + '">' +
      '<div class="sr-top"><span class="sr-label">' + CS.esc(s.label || s.key) +
      "</span>" + '<span class="chip ' + chipClass(s.status) + '">' +
      CS.esc(s.status || "pending") + "</span></div>" +
      '<div class="sr-note">' +
      (s.count != null ? "<b>" + CS.esc(s.count) + "</b>" +
        (s.note ? " · " : "") : "") +
      CS.esc(s.note || "") + "</div></div>"
    );
  }
  function bannerHtml(cls) {
    if (!cls || cls === "unknown") return "";
    return "business_class: " + CS.esc(cls) +
      " — persona family: " + familyOf(cls);
  }
  function doneCount(session) {
    return session.sources.filter((x) => x.status && x.status !== "pending").length;
  }
  function targetCount(session) {
    return Math.max(7, session.sources.length || 0);
  }

  /* ============================================================
     RENDER — full draw from session (innerHTML reset first)
     ============================================================ */
  CS.register({
    id: "scout",
    num: 1,
    title: "Scout",
    short: "Name-only intake",
    render(mount, session) {
      mount.classList.add("step-view");

      if (!session) {
        mount.innerHTML =
          '<div class="step-empty">❖ scout — waiting for the session to open…</div>';
        return;
      }

      const biz = CS.esc((session.business && session.business.name) || "business");
      const src = session.sources || [];
      const anyReviews = src.some((x) => x.key === "g_reviews");

      mount.innerHTML =
        '<div class="step-inner sc-wrap">' +

        '<div class="sc-step-head">' +
        '<div><div class="sc-kicker">01 · Scout — Name-only intake</div>' +
        '<div class="sc-title">Scouts reading the internet on ' + biz + "</div></div>" +
        '<span class="sc-state is-run" id="sc-state">' +
        (S.done ? "complete" : "streaming") + "</span></div>" +

        '<div class="sc-banner" id="sc-banner" hidden></div>' +

        '<div class="sc-grid">' +

        '<div class="sc-col">' +
        '<div class="sc-card">' +
        '<div class="sc-card-head">◇ source sweep' +
        '<span id="sc-prog-label"></span></div>' +
        '<div class="sc-progress">' +
        '<div class="bar-track"><div class="bar-fill" id="sc-bar"></div></div>' +
        '<div class="bar-label" id="sc-bar-label"></div></div>' +
        '<div class="src-list" id="sc-src-list"></div>' +
        "</div></div>" +

        '<div class="sc-col">' +
        (anyReviews ?
          '<div class="hitl"><span class="hitl-k">◇ human in the loop — live scrape lane</span>' +
          "The browser window is visible and human-assisted: if a CAPTCHA pops, " +
          "a human solves it — then everything is cached and replayed silently.</div>"
          : "") +
        '<div class="sc-card">' +
        '<div class="sc-card-head">◇ reviews streaming' +
        '<span id="sc-rev-count"></span></div>' +
        '<div class="rev-list" id="sc-reviews"></div>' +
        "</div></div>" +

        "</div></div>";

      drawBanner();
      drawSources();
      drawReviews();
      refreshChrome();
    },
  });

  /* ---------- partial draws ---------- */
  function drawBanner() {
    const el = document.getElementById("sc-banner");
    if (!el) return;
    const cls = CS.session.business && CS.session.business.class;
    const html = bannerHtml(cls);
    el.hidden = !html;
    if (html) el.innerHTML = html;
  }

  function drawSources() {
    const list = document.getElementById("sc-src-list");
    if (!list) return;
    list.innerHTML = "";
    for (const s of CS.session.sources) list.appendChild(srcRow(s, false));
  }

  function drawReviews() {
    const box = document.getElementById("sc-reviews");
    const n = document.getElementById("sc-rev-count");
    if (!box) return;
    const all = CS.session.reviews || [];
    if (n) n.textContent = all.length + " in";
    const items = all.slice(-8);
    if (!items.length) {
      box.innerHTML = '<div class="rev-empty">…waiting for reviews</div>';
      return;
    }
    box.innerHTML = items.map((r, i) =>
      '<div class="rev-card' + (i === items.length - 1 ? " new" : "") + '">' +
      '<div class="rv-stars">' +
      (r.rating == null ? "" :
        CS.esc("★".repeat(Math.max(0, Math.min(5, r.rating || 0))) +
        "☆".repeat(5 - Math.max(0, Math.min(5, r.rating || 0)))) + " ") +
      "</div>" +
      CS.esc(r.text || "") +
      '<div class="rv-meta"><span>' + CS.esc(r.source || "web") + "</span>" +
      "<span>review " + CS.esc(all.length - items.length + i + 1) + "</span></div>" +
      "</div>"
    ).join("");
  }

  /* progress bar + state chip + shimmer, patched in place */
  function refreshChrome() {
    const wrap = document.querySelector(".sc-wrap");
    const bar = document.getElementById("sc-bar");
    const label = document.getElementById("sc-bar-label");
    const prog = document.getElementById("sc-prog-label");
    const state = document.getElementById("sc-state");
    const session = CS.session;
    if (!session) return;

    if (wrap) wrap.classList.toggle("is-done", S.done);
    if (state) {
      state.className = "sc-state " + (S.done ? "is-done" : "is-run");
      state.textContent = S.done ? "complete" : "streaming";
    }
    if (bar && label) {
      if (S.done) {
        bar.classList.add("shimmer");
        bar.style.width = "100%";
        const agents = session.personas.length;
        label.innerHTML = '<span class="forming">Swarm forming…</span>' +
          (session.evidence.length
            ? "<span>swarm built · " + CS.esc(agents) + " agents · " +
              CS.esc(session.evidence.length) + " evidence cards</span>"
            : "");
      } else {
        bar.classList.remove("shimmer");
        const done = doneCount(session), tgt = targetCount(session);
        bar.style.width = Math.round((done / tgt) * 100) + "%";
        label.innerHTML = "<span>" + CS.esc(done) + " of " + CS.esc(tgt) +
          " sources</span><span>name-only intake</span>";
      }
    }
    if (prog) {
      prog.textContent = S.done
        ? session.sources.length + " sources"
        : doneCount(session) + "/" + targetCount(session);
    }
  }

  /* row land / update without re-rendering the whole list */
  function upsertSource(d) {
    if (!CS.session) return;
    const list = document.getElementById("sc-src-list");
    if (!list) return;
    const s = CS.session.sources.find((x) => x.key === d.key);
    if (!s) return;
    const existing = list.querySelector('[data-key="' + CS.esc(d.key) + '"]');
    const row = srcRow(s, true);
    if (existing) existing.replaceWith(row); else list.appendChild(row);
    refreshChrome();
  }
})();