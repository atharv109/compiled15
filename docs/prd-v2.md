# PRD v2 — Customer Swarm

**c0mpiled-15 · Penn State · Oct 11, 2026 · updated 12:55 after design grilling**

> Reference copy saved into this repo (the canonical one lives with the backend repo owner).

---

## 1. Summary

A business owner types **only the name of their business**. Scout adapters scrape every public source they can reach (Google reviews, menus, hours, competitors, news via Tavily; more for B2B/startup classes), 50 customer agents built *entirely from what the internet says about that business* debate the owner's real decision with citations, and a judge returns a verdict. On top sits a self-improving loop tested against a calibrated, seeded mock market.

**Pitch line:** "Ask your customers before you spend the money."

**Product principle (locked):** *generic structure, fully customized content* — the pipeline never hardcodes a domain. Personas/segments **emerge from the business's own data**; the business-class router swaps persona families and simulator knobs.

## 2. Status (as of 12:55, build window 12:00–7:00)

| Milestone | PRD v1 said | Reality |
|---|---|---|
| P0 pipeline E2E | by 3:30 | ✅ **done 12:52** — Cafe 210 West: 50 personas → debate → verdict in <1 min |
| Real review data | pasted manually | ✅ 150 scraped live (97 with text), no CAPTCHA, ~65 s/scrape |
| Team | TBD | ✅ 2 people: backend (you) + frontend/selling/camera (partner) |
| Judge | TBD model | ✅ **gpt-5.6-sol** (validated, json_mode) |

## 3. Locked Decisions (the grilling record)

1. **Team of 2.** Backend = user. Partner = single-page UI + selling + camera + filling `.env`/Stripe. Shareable session link (P1-4 in v1) → **stretch, not P1**. Crowd stays **50** (it's the brand; code-wise 500 is only a knob, not work).
2. **Name-only intake.** Owner pastes nothing; adapters do the work. Manual paste demoted from "fallback" to a *feature* ("paste more reviews to sharpen results," cap 200).
3. **Business-class router**: classify into `local_consumer / startup / b2b_service / regulated` → selects **persona-family prompts** (consumers vs investors/procurement/legal) and **simulator knob set**. One classification call + heuristic fallback.
4. **Model lanes (user-locked):** **Groq `openai/gpt-oss-120b` for everything** (personas, debate, digests, loop reflection, classifier); **OpenAI gpt-5.6-sol for the judge only** (pinned "strong" lane — judge never falls through to the crowd lane); Luminal key saved but **parked** until base URL + model are known → then it becomes crowd-primary by one `.env` line (Track 1A). Lane-failover + cooldown in one client (`app/llm/client.py`), concurrency 10 (Groq free-tier RPM).
5. **Crowd size** = config knob: **50 demo standard / 200 paid "deep run" upsell / 500 vision slide**.
6. **Determinism** = aggregation-first judge (structured votes, Pydantic-validated, temp-0) + verdict cache keyed on (business, question). Borderline tallies → low-confidence verdict is a feature.
7. **Debate** = 2 rounds; round-2 agents read **camp digests** (opposing camp's 2–3 strongest args). Camps auto-clustered per round; camp events feed UI + judge + digests from one artifact. Fabricated evidence is demoted to neutral.
8. **Simulator** = plain Python, no LLM. Calibration proposes **ranges** from reviews; a **seeded truth** is sampled inside ranges and hidden from agents; train/test splits with shifted contexts; **reroll button** (seed change) for the "works across market draws" video beat. Naive choice ("open till 2 AM + promo everywhere") is verified wrong on most seeds — the loop has something real to learn.
9. **Demo = Live scrape (user-locked option A)**: headed Chrome window visible so the owner/judges can see the agent browse; **if CAPTCHA blocks, the window pops and the human solves it** ("human-in-the-loop" is the narrative, not a failure). Cache-first bridge means every *subsequent* run replays from cache silently.
10. **Pricing = $19 teaser gate** (Stripe Payment Link): free on-screen = recommendation + confidence; behind payment = segment-by-segment impact + top objections + per-agent chat. Pitch vs "$500–2,000 market research." Organizers to confirm live-charge vs test-mode rules.

## 4. Architecture

```
Owner UI (React, partner)  ←  docs/api-contract.md (pinned 12:30)
      │ single SSE channel per session
      ▼
FastAPI backend ── business-class router
      ├── adapters.py: tavily_web | google_reviews (scraper sidecar bridge) | manual_paste
      │      └─ scrape sidecar (:8300) — headed Chrome, CAPTCHA→human, SQLite cache, 150-review cap
      ├── evidence cards {claim, source_url, type} → MongoDB (Atlas; in-memory fallback)
      ├── llm/personas.py  — 50 agents, emergent segments (3–7), batched 5 calls, cited
      ├── llm/debate.py    — async-gen event stream, camp digests
      ├── llm/judge.py     — aggregation + gpt-5.6-sol, verdict cache
      └── sim/             — truth.py (ranges→seeded truth+reroll), market.py (deterministic, contexts),
                             loop.py (parallel propose → prediction-error → belief rewrite, keep-if-better),
                             eval.py (baseline vs final vs test regret + chart_data)
```

- Crowd lane: Groq gpt-oss-120b (~110 calls/debate, ~69 calls/loop-run; ~110–125K tokens/debate — cents on Groq)
- Strong lane: gpt-5.6-sol (judge; 1–2 calls)

## 5. Requirements status

| ID | Requirement | State |
|---|---|---|
| P0-1..2 | Intake + scouts + evidence cards | ✅ (evidence extraction quality pass pending: Tavily cards are noisy) |
| P0-3..5 | Personas, debate, judge | ✅ 12:52 E2E; confidence formula + business_class persistence pending fixes |
| P0-6 | Web UI | 🔄 partner against contract + mock replay endpoint |
| P0-7 | Stripe | ⏳ needs STRIPE_LINK from partner |
| P1-1/2 | Simulator + loop into /api | ✅ built+tested offline; wiring into main pending |
| P1-3 | Agent chat | 🔜 (endpoint exists, 501; wire to persona profile + evidence) |
| P2 | QR poll, nonprofit mode, share link | only if time |

## 6. Remaining human blockers

1. **Luminal base URL + model name** (dashboard/organizer) — one `.env` line swap.
2. **Stripe link** at $19 + live-vs-test rules from organizers.
3. Demo-business confirmation (Cafe 210 West standing in and fully viable).
4. Partner records clips as they happen: first UI run, improving curve, first sale.

## 7. Timeline (re-cut, from 12:55)

- **now–1:30** loop integration into `/api`, agent chat, business_class fix, confidence tuning, evidence extraction quality
- **1:30–2:30** deep-run knob + one real loop trajectory for the chart; selling starts the moment partner's page renders a live session
- **2:30–4:30** polish + retries + 200-persona validation run + AWS deploy (only if stable)
- **5:30–6:15** speed tuning, record clips
- **6:15–7:00** edit video, submit

## 8. Honest framing (say on video)

"Simulated market calibrated from real reviews — calibration sets ranges, truth is sampled, the loop discovers it through outcomes like a real market. In production, owners log real outcomes and the swarm learns from those. When Google blocks the agent, a human solves the gate and we cache everything — that's what operating this product actually looks like."