# Video script — submission video, ≤ 2:00

**Cut target: 2:00 hard.** Every beat below time-coded. Tag on each clip: **[PRE]** = we can pre-record THIS HOUR from the running backend (no owner needed, use the loaded Cafe 210 West session) — shoot these first; **[OWNER]** = needs the cafe owner on camera (book the window, have a scripted fallback if they no-show).

**Standing assets:** shot1–shot10 screenshots already captured in repo root (mock + live verdict teaser/unlocked, chat, loop charts) — usable as backup inserts if a live take fails.
**Demo source:** `http://<tunnel>:8000/demo/` on a phone + the headed-Chrome scraper window.

---

## Full 2:00 cut

| # | Time | Shot | Tag | VO (read as written) |
|---|------|------|-----|----------------------|
| 1 | 0:00–0:08 | Title card over shot3 (verdict teaser): "Ask your customers before you spend the money." | **[PRE]** | "Owner decisions get made on gut feel — or on a $500-to-$2,000 market-research report that takes two weeks." |
| 2 | 0:08–0:30 | Phone screen: type "Cafe 210 West" into the one intake field → cut to the **headed Chrome scraper window** visibly browsing Google reviews; if CAPTCHA pops, the human hand solves it on camera (keep it — it's the beat, not a bug) | **[PRE]** | "You type one thing: your business name. A scraper agent hits the public record — your real reviews, your prices, your competitors. When Google blocks it, a human solves the gate and everything is cached from then on. That's what operating this actually looks like." |
| 3 | 0:30–0:45 | Evidence cards streaming in live (SSE), then personas building — "Sam the junior", segment tags, source citations on card 118 and 126 | **[PRE]** | "150 real reviews become evidence cards with sources — and 50 AI customers, built entirely from what the internet says about this business." |
| 4 | 0:45–1:05 | Owner's question typed live → debate: stance cards flying ("No — game day is 40% of my late-night spend"), camps auto-forming ("Open-late skeptics") | **[PRE]** (re-shoot with a real-feeling question) | "Then they debate your actual question — in rounds, with receipts, in character." |
| 5 | 1:05–1:10 | Split stat card: "Families vs Tourists: 7–0" over the camp view | **[PRE]** | "And in one real run, the debate was 7-to-0 against the move gut feel would have made." |
| 6 | 1:10–1:22 | Verdict lands: recommendation + confidence **[teaser]** → tap pay → Stripe link → segment impact + top objections unlock **[full verdict, shot4/shot5]** | **[PRE]** (payment click can be test-mode; don't dwell) | "The verdict in under a minute. Segment by segment impact, objections, and a chat with your own customers — $19. One market-research report is $500 to $2,000." |
| 7 | 1:22–1:34 | Chat clip: owner types "Why don't you care about game day?" → in-character reply with evidence citations | **[PRE]** (chat is live and recorded) | "You can push back — and the customers answer, grounded in your real reviews." |
| 8 | 1:34–1:46 | Learning-curve clip: regret chart stepping down, final stat overlay: **held-out regret 0.707 → 0.294** | **[PRE]** (loop-chart endpoint, ~54s run) | "And it gets smarter: a market-calibrated learning loop cut its error on unseen scenarios by more than half — 0.707 to 0.294, measured on data it had never seen." |
| 9 | 1:46–1:52 | **Owner testimonial slot** — owner to camera, one line | **[OWNER]** — book NOW; fallback = re-use VO from shot 4 with their on-screen name ("Owner, Cafe 210 West — used it on today's question") | (Their words. Prompt them with: "What did it tell you that you didn't know?") |
| 10 | 1:52–2:00 | **Vision slide — SwarmStudio** (per build-notes: same engine, crowd → judge → artifact, terminal object = code, not a verdict. One slide. Post-hackathon, not demoed.) | **[PRE]** (slide today) | "Next: SwarmStudio — same swarm, drafting your flyer, your menu, your landing page. And to be straight with you: today's market is simulated from real reviews and calibrated on them — in production, owners log real outcomes and the swarm learns from those. Ask your customers before you spend the money." |

**Edit rules:** hard captions on every number (150 reviews / 50 agents / 7–0 / $19 / 0.707→0.294). No music during the CAPTCHA-solve beat — let it breathe. Total VO ≈ 1:50 so the cut lands under 2:00.

---

## Honest framing (mandatory, PRD §8 — spoken in beat 10)

> "Simulated market calibrated from real reviews — calibration sets ranges, truth is sampled, the loop discovers it through outcomes like a real market. In production, owners log real outcomes and the swarm learns from those."

Do not cut this line. It's the difference between a demo and a claims problem.

---

## Fallback cut-down — 1:15 (if the shoot runs late)

| Time | Beat |
|------|------|
| 0:00–0:06 | Title card + pitch line **[PRE]** |
| 0:06–0:16 | Scrape, 2-second CAPTCHA-solve flash, evidence cards **[PRE]** |
| 0:16–0:28 | "50 AI customers from your real reviews" — montage: persona cards + stances + the 7–0 camp stat as one overlay **[PRE]** |
| 0:28–0:40 | Question → verdict lands → teaser → unlock (one continuous take) **[PRE]** |
| 0:40–0:50 | Learning-loop stat as a single hold-on-chart card: 0.707 → 0.294 **[PRE]** |
| 0:50–0:58 | Testimonial, hard-capped at 8 seconds; if no owner, cut entirely and extend the chat clip **[OWNER]** |
| 0:58–1:15 | SwarmStudio vision slide + honest-framing line + tagline **[PRE]** |

Cut priority if you land at 1:15 and it's still over: drop the chat clip first, then the scrape detail (keep the CAPTCHA flash — it's the most memorable 2 seconds in the video). Never drop the honesty line.

---

## Shoot order for the next hour (all **[PRE]**)

1. Fresh full run at the demo URL — capture beats 2–5 in one continuous phone recording.
2. Verdict teaser → unlock (beat 6) with the Stripe link visible ≥1 frame.
3. Chat exchange, 2 questions pre-typed (beat 7).
4. `run-loop` + `loop-chart` screens (beat 8) — fire it, record the chart, ~54s.
5. Slides: title, 7–0 stat card, SwarmStudio, honesty card.
6. Then the owner window: testimonial + (if possible) a real re-run with THEIR question, which upgrades beat 4 from [PRE] to gold.