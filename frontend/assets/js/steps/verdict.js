/* ============================================================
   Customer Swarm — steps/verdict.js (Step 4 · Verdict)
   Judge panel: free tier (recommendation / split / confidence)
   + $19 paywall for the deep-dive (segments, objections, conditions).
   ============================================================ */
(function () {
  "use strict";

  const CS = window.CS || (window.CS = {});
  let mounted = null;   // step mount element while this step is active
  let panel = null;     // built verdict panel
  let pollTimer = null;

  CS.register({
    id: "verdict",
    num: 4,
    title: "Verdict",
    short: "Aggregated judge",
    render,
  });

  const IMPACT_CLS = {
    "+": "vd-im-up",
    "−": "vd-im-down",
    "-": "vd-im-down",
    "o": "vd-im-mid",
    "O": "vd-im-mid",
    "=": "vd-im-flat",
  };

  const cs = () => CS.session || {};

  function render(mount, session) {
    mounted = mount;
    stopPoll();
    const v = (session || cs()).verdict;
    mount.innerHTML = "";
    panel = null;
    if (!v) {
      // elegant waiting state — must never error before the judge lands
      mount.appendChild(CS.el(
        '<div class="vd-wait">' +
        '<span class="vd-pulse"></span>' +
        '<span class="vd-wait-txt">awaiting judge aggregation…</span>' +
        "</div>"
      ));
      return;
    }
    panel = buildVerdict(v, CS.isPaid());
    mount.appendChild(panel);
  }

  /* ============================================================
     verdict panel
     ============================================================ */
  function buildVerdict(v, paid) {
    const model = CS.esc(v.judge_model || "judge");
    const align = Math.round((Number(v.round2_alignment) || 0) * 100);
    const s = v.split || {};
    const forN = Number(s.for) || 0;
    const agN = Number(s.against) || 0;
    const shN = Number(s.shifted) || 0;
    const total = Math.max(1, forN + agN + shN);
    const conf = Math.max(0, Math.min(1, Number(v.confidence) || 0));
    const confN = Math.round(conf * 100);
    const C = (2 * Math.PI * 50).toFixed(2); // r=50 dial circumference

    const segFor = ((forN / total) * 100).toFixed(2);
    const segAg = ((agN / total) * 100).toFixed(2);
    const segSh = (100 - Number(segFor) - Number(segAg)).toFixed(2);

    const impacts = (v.segment_impacts || []).map((x) => {
      const b = IMPACT_CLS[x.impact] || "vd-im-flat";
      return (
        `<div class="vd-srow">` +
        `<span class="vd-sid">${CS.esc(x.segment || "")}</span>` +
        `<span class="vd-sname">${CS.esc(x.name || "")}</span>` +
        `<span class="vd-sbadge ${b}">${CS.esc(x.impact || "=")}</span>` +
        `<span class="vd-snote">${CS.esc(x.note || "")}</span>` +
        `</div>`
      );
    }).join("");

    const objections = (v.top_objections || []).map((t, i) =>
      `<li class="vd-obj"><b>${String(i + 1).padStart(2, "0")}</b><span>${CS.esc(t)}</span></li>`
    ).join("");

    const conditions = (v.conditions || []).map((c) =>
      `<div class="vd-cond"><span class="vd-box" role="checkbox" aria-checked="false" tabindex="0"></span>` +
      `<span class="vd-cond-txt">${CS.esc(c)}</span></div>`
    ).join("");

    const stripe = CS.STRIPE_LINK;

    const root = CS.el(
      '<div class="vd-root">' +
      `<div class="vd-label">JUDGE VERDICT · ${model} · ROUND-2 ALIGNMENT ${align}%</div>` +
      `<div class="vd-hero">${CS.esc(v.recommendation || "")}</div>` +

      '<div class="vd-metrics">' +
      '<div class="vd-split">' +
      '<div class="vd-cap">AGENT SPLIT</div>' +
      '<div class="vd-splitbar">' +
      `<span class="vd-seg vd-sg-for"   style="width:${segFor}%"><i>${forN || ""}</i></span>` +
      `<span class="vd-seg vd-sg-against" style="width:${segAg}%"><i>${agN || ""}</i></span>` +
      `<span class="vd-seg vd-sg-shift" style="width:${segSh}%"><i>${shN || ""}</i></span>` +
      "</div>" +
      '<div class="vd-split-legend">' +
      `<span class="vd-ls" style="color:var(--ok)">■ for ${forN}</span>` +
      `<span class="vd-ls" style="color:var(--err)">■ against ${agN}</span>` +
      `<span class="vd-ls" style="color:var(--proc)">■ shifted ${shN}</span>` +
      "</div>" +
      "</div>" +

      '<div class="vd-dial">' +
      '<div class="vd-ring-wrap">' +
      '<svg class="vd-ring" viewBox="0 0 120 120" aria-hidden="true">' +
      `<circle class="vd-ring-track" cx="60" cy="60" r="50"></circle>` +
      `<circle class="vd-ring-val" cx="60" cy="60" r="50" transform="rotate(-90 60 60)" ` +
      `style="stroke-dasharray:${C} ${C};stroke-dashoffset:${(Number(C) * (1 - conf)).toFixed(2)}"></circle>` +
      "</svg>" +
      '<div class="vd-ring-num">' +
      `<b>${confN}<i>%</i></b>` +
      '<span>confidence</span>' +
      "</div>" +
      "</div>" +
      '<p class="vd-dial-note">borderline elements = lower confidence — that\'s honesty, not weakness</p>' +
      "</div>" +
      "</div>" +

      `<div class="vd-deep${paid ? " is-paid" : " is-locked"}">` +
      '<div class="vd-deep-head">DEEP-DIVE · SEGMENT IMPACT · OBJECTIONS · CONDITIONS</div>' +
      '<div class="vd-deep-body">' +
      '<div class="vd-cap">SEGMENT-BY-SEGMENT IMPACT</div>' +
      `<div class="vd-seglist">${impacts}</div>` +
      '<div class="vd-cols">' +
      '<div class="vd-col"><div class="vd-cap">TOP OBJECTIONS</div>' +
      `<ol class="vd-objs">${objections}</ol></div>` +
      '<div class="vd-col"><div class="vd-cap">CONDITIONS · KILL-SWITCH</div>' +
      `<div class="vd-conds">${conditions}</div></div>` +
      "</div>" +
      "</div>" +
      (paid ? '' :
        '<div class="vd-gate">' +
        '<div class="vd-gate-txt">Segment-by-segment impact · top objections · per-agent chat — <b>$19</b></div>' +
        `<button class="vd-unlock" type="button">${stripe ? "Unlock deep-dive — $19" : "Unlock — $19 (demo payment)"}</button>` +
        `<div class="vd-gate-note">${stripe ? "secure checkout · returns with ?paid=1" : "demo mode · simulated Stripe success"}</div>` +
        "</div>") +
      "</div>" +
      "</div>"
    );

    /* ---- gate interactions ---- */
    const btn = root.querySelector(".vd-unlock");
    if (btn) {
      btn.addEventListener("click", () => {
        if (CS.STRIPE_LINK) {
          window.open(CS.STRIPE_LINK, "_blank");
          btn.disabled = true;
          btn.textContent = "waiting for payment…";
          startPoll();
        } else {
          CS.markPaid(); // simulated Stripe success → emits 'paid'
        }
      });
    }

    /* checkbox-ish kill-switch squares */
    for (const box of root.querySelectorAll(".vd-box")) {
      const flip = () => {
        const on = box.classList.toggle("on");
        box.setAttribute("aria-checked", on ? "true" : "false");
      };
      box.addEventListener("click", flip);
      box.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
      });
    }

    return root;
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(() => {
      if (CS.isPaid()) {
        stopPoll();
        CS.markPaid(); // persists + emits 'paid' → re-render unblurred
      }
    }, 800);
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ============================================================
     live wiring
     ============================================================ */
  CS.on("verdict", () => {
    if (!mounted || !document.documentElement.contains(mounted)) return;
    const v = cs().verdict;
    if (!v || panel && document.documentElement.contains(panel)) return;
    mounted.innerHTML = "";
    panel = buildVerdict(v, CS.isPaid());
    panel.classList.add("vd-in");
    mounted.appendChild(panel);
  });

  /* payment landed (demo unlock, or ?paid=1 redirect) */
  CS.on("paid", () => {
    if (!mounted || !document.documentElement.contains(mounted)) return;
    if (!cs().verdict) return;
    stopPoll();
    mounted.innerHTML = "";
    panel = buildVerdict(cs().verdict, true);
    mounted.appendChild(panel);
  });

  /* if the step sits idle while the verdict stream lands and the
     shell re-activates it, render() already catches up — nothing else to do */
})();