/* ============================================================
   Customer Swarm — steps/verdict.js (Step 4 · Verdict)
   Judge panel per docs/api-contract.md: recommendation,
   confidence, tally {support | oppose | neutral}, objections,
   segment_impact — free tier shows rec + confidence; the $19
   deep-dive unlocks segment impact, objections and agent chat.
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
    const tally = v.tally || {};
    const sup = Number(tally.support) || 0;
    const opp = Number(tally.oppose) || 0;
    const neu = Number(tally.neutral) || 0;
    const total = Math.max(1, sup + opp + neu);
    const conf = Math.max(0, Math.min(1, Number(v.confidence) || 0));
    const confN = Math.round(conf * 100);
    const C = (2 * Math.PI * 50).toFixed(2); // r=50 dial circumference

    const segSup = ((sup / total) * 100).toFixed(2);
    const segOpp = ((opp / total) * 100).toFixed(2);
    const segNeu = (100 - Number(segSup) - Number(segOpp)).toFixed(2);

    const impacts = (v.segment_impact || []).map((x) =>
      `<div class="vd-srow">` +
      `<span class="vd-sid">${CS.esc(x.segment || "")}</span>` +
      `<span class="vd-snote">${CS.esc(x.impact || "")}</span>` +
      (x.evidence_ids && x.evidence_ids.length
        ? `<span class="vd-scites">${(x.evidence_ids || []).map((id) =>
            `<span class="db-cite">${CS.esc(id)}</span>`).join("")}</span>` : "") +
      `</div>`).join("");

    const objections = (v.objections || []).map((t, i) =>
      `<li class="vd-obj"><b>${String(i + 1).padStart(2, "0")}</b><span>${CS.esc(t)}</span></li>`
    ).join("");

    const stripe = CS.STRIPE_LINK;
    const live = !!(CS.session && CS.session.sid && !CS.session.mock);

    const root = CS.el(
      '<div class="vd-root">' +
      `<div class="vd-label">JUDGE VERDICT · ${sup + opp + neu} AGENT VOTES AGGREGATED</div>` +
      `<div class="vd-hero">${CS.esc(v.recommendation || "")}</div>` +

      '<div class="vd-metrics">' +
      '<div class="vd-split">' +
      '<div class="vd-cap">AGENT SPLIT</div>' +
      '<div class="vd-splitbar">' +
      `<span class="vd-seg vd-sg-for" style="width:${segSup}%"><i>${sup || ""}</i></span>` +
      `<span class="vd-seg vd-sg-against" style="width:${segOpp}%"><i>${opp || ""}</i></span>` +
      `<span class="vd-seg vd-sg-shift" style="width:${segNeu}%"><i>${neu || ""}</i></span>` +
      "</div>" +
      '<div class="vd-split-legend">' +
      `<span class="vd-ls" style="color:var(--ok)">■ support ${sup}</span>` +
      `<span class="vd-ls" style="color:var(--err)">■ oppose ${opp}</span>` +
      `<span class="vd-ls" style="color:var(--proc)">■ neutral ${neu}</span>` +
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
      '<p class="vd-dial-note">borderline split = lower confidence — that\'s honesty, not weakness</p>' +
      "</div>" +
      "</div>" +

      `<div class="vd-deep${paid ? " is-paid" : " is-locked"}">` +
      '<div class="vd-deep-head">DEEP-DIVE · SEGMENT IMPACT · OBJECTIONS</div>' +
      '<div class="vd-deep-body">' +
      '<div class="vd-cap">SEGMENT-BY-SEGMENT IMPACT</div>' +
      `<div class="vd-seglist">${impacts}</div>` +
      '<div class="vd-cols">' +
      '<div class="vd-col vd-col-full"><div class="vd-cap">TOP OBJECTIONS</div>' +
      `<ol class="vd-objs">${objections}</ol></div>` +
      "</div>" +
      "</div>" +
      (paid ? "" :
        '<div class="vd-gate">' +
        '<div class="vd-gate-txt">Segment-by-segment impact · top objections · per-agent chat · owner-ready drafts — <b>$19</b></div>' +
        `<button class="vd-unlock" type="button">${stripe ? "Unlock deep-dive — $19" : "Unlock — $19 (demo payment)"}</button>` +
        `<div class="vd-gate-note">${stripe ? "secure checkout — returns here to unlock" : "demo mode — no card is charged"}</div>` +
        "</div>") +
      "</div>" +
      "</div>"
    );

    /* ---- gate interactions ---- */
    const btn = root.querySelector(".vd-unlock");
    if (btn) {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "unlocking…";
        const ok = await CS.pay();
        if (!ok) {
          btn.disabled = false;
          btn.textContent = "We couldn't unlock — please try again";
          return;
        }
        btn.disabled = false;
      });
    }

    return root;
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* re-render the panel from current session state (verdict + paid) */
  function buildCurrent() {
    if (!mounted || !document.documentElement.contains(mounted)) return;
    const v = cs().verdict;
    if (!v) return;
    mounted.innerHTML = "";
    panel = buildVerdict(v, CS.isPaid());
    panel.classList.add("vd-in");
    mounted.appendChild(panel);
  }

  /* ============================================================
     live wiring
     ============================================================ */
  CS.on("verdict", () => {
    if (!mounted || !document.documentElement.contains(mounted)) return;
    buildCurrent();
  });

  /* payment landed (demo unlock, mark-paid, or the snapshot poll catching ?paid=1) */
  CS.on("paid", () => {
    if (!mounted || !document.documentElement.contains(mounted)) return;
    if (!cs().verdict) return;
    stopPoll();
    buildCurrent();
  });

  /* if the step sits idle while the verdict stream lands and the
     shell re-activates it, render() already catches up — nothing else to do */
})();