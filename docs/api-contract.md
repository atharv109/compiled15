# API Contract — Customer Swarm (v1, 2026-10-11 12:30)

**Backend owns:** everything under `/api`. **Frontend owns:** rendering only — no business logic, no LLM calls.
All real-time updates arrive on ONE SSE channel per session. Fixed schema below; backend may add fields but will never rename these.

## Endpoints

### `POST /api/sessions` — create session (intake)
Request:
```json
{ "business_name": "Cafe 210", "town": "State College", "reviews_text": "pasted reviews..." }
```
Response:
```json
{ "session_id": "s_7f3k", "status": "ingesting" }
```

### `GET /api/sessions/{id}` — session snapshot (poll-safe)
```json
{
  "session_id": "s_7f3k",
  "business": { "name": "Cafe 210", "town": "State College" },
  "evidence": [ { "id": "e1", "claim": "...", "source_url": "...", "type": "review|price|competitor|event" } ],
  "personas": [ { "id": "p1", "segment": "students", "name": "Sam the junior", "profile": "...", "source_review_ids": ["e3"] } ],
  "segments": [ { "name": "students", "count": 14 } ],
  "question": "Should we stay open until 2 AM on football Saturdays?",
  "verdict": null,
  "paid": false,
  "status": "ingesting | scouting | ready | debating | verdict_ready"
}
```

### `GET /api/sessions/{id}/stream` — THE live channel (SSE)
Every event is `event: <type>` + JSON `data`. Sequence: `status` → `evidence` (one per card) → `persona_start` (one) → `stance` (many, in round order) → `camp` (per round end) → `verdict`.

```json
// type: status        { "status": "debating", "round": 2 }
// type: persona_start { "persona_id": "p1", "segment": "students", "name": "Sam the junior" }
// type: evidence      { "card": { "id": "e1", "claim": "...", "source_url": "...", "type": "..." } }
//                     (NOTE: card is wrapped in { "card": ... } on SSE only — snapshot unwraps)
// type: stance        { "round": 1, "persona_id": "p1", "segment": "students",
//                       "stance": "oppose",           // support | oppose | neutral
//                       "stance_label": "No",          // short human text
//                       "reason": "<=2 sentences, in-character",
//                       "evidence_ids": ["e3", "e9"] }
// type: camp          { "round": 1, "camp": "Open-late skeptics",
//                       "member_ids": ["p1","p4","p9"],
//                       "top_arguments": ["...","..."] }
// type: verdict       { "recommendation": "...", "confidence": 0.72,
//                       "tally": { "support": 12, "oppose": 31, "neutral": 7 },
//                       "objections": [ "...", "...", "..." ],
//                       "segment_impact": [ { "segment": "students", "impact": "-40% visits after 1 AM", "evidence_ids": ["e3"] } ] }
```

### `POST /api/sessions/{id}/question` — start debate
```json
{ "text": "Should we stay open until 2 AM on football Saturdays?" }
```
Response: `{ "ok": true }` — results arrive on the stream.

### `POST /api/sessions/{id}/agents/{persona_id}/chat` (P1-3, gated on payment)
```json
{ "message": "Why don't you care about game day?" }
```
```json
{ "reply": "...", "evidence_ids": ["e3"] }
```

### `GET /api/sessions/{id}/pay` — Stripe payment link
```json
{ "payment_url": "https://buy.stripe.com/...", "price": 19 }
```
Frontend shows verdict teaser (recommendation + confidence only) until `paid: true`; full `segment_impact` + objections + agent chat after.

### `POST /api/sessions/{id}/act` — P2 "Act" drafts (~25–45 s; 402 unpaid)
Response: `{ "drafts": [{ "id", "title", "body_text", "rationale", "evidence_ids" }], "scores": [{ "id", "score", "why" }], "best_id", "artifact_type": "promo_copy|signage_flyer|menu_item_copy|landing_page_snippet|schedule_policy", "fallback_used": false }`
Semantics: winning camp's arguments seed 3 distinct drafts; strong judge scores against evidence; owner picks. Payload also stored as session `act`.

### `GET /demo/` — the standing demo page is served BY the backend
Single-file UI at the same origin (no tunnel for phones needed beyond the backend URL). Also works from `file://` anywhere (CORS `*`), with offline-fallback to a recorded session replay if the API is down.

## Frontend dev mode
`GET /api/mock-session/{id}` replays a recorded session (same shapes) so UI work never blocks on the backend. Ask backend to record one as soon as the first full run works (~2:00).

## v2 additions (13:45) — learning loop + agent chat

### `POST /api/sessions/{id}/agents/{persona_id}/chat` — LIVE (was 501 stub)
Request: `{ "message": "Why should we stay open late?" }`
Response: `{ "reply": "<=120 words in-character", "evidence_ids": ["e3"] }`
(402 when not paid, 404 unknown persona.)

### `POST /api/sessions/{id}/run-loop` — runs the Track 1A loop (~2–4 min)
Response: `{ "round_scores": [{ "round": 0, "regret": 0.21, "prediction_error": 5.4, "split": "train" }...], "final_eval": { "baseline_regret": ..., "final_regret": ..., "test_regret": ..., "shifted_context_regret": ... }, "beliefs": { "<segment>": "<belief note>" } }`
(404 no session, 409 "run debate first"/"no reviews": ask user to debate first.)
Note: loop runs LONG. Frontend: fire-and-wait on a button with spinner; show beliefs when they arrive.

### `GET /api/sessions/{id}/loop-chart`
Response: `{ "train": [{ "round": 0, "regret": 0.21 }...], "test_bar": { "baseline_regret": ..., "test_regret": ... } }` — shape for the regret chart; {} if not run yet.

### `POST /api/sessions/{id}/loop/reroll` — reroll button
Request: `{ "seed": 42 }` — re-samples market truth, re-runs the loop. Same shape as run-loop.

## v3 corrections (15:58) — payment handoff (real)
### `GET /api/sessions/{id}/pay`
Response (real link configured): `{ "payment_url": "<stripe/payment link>", "price": 19, "provider": "stripe" | "external" }`
Response (no real link): `{ "payment_url": null, "price": 19, "provider": "stripe", "demo": true, "note": "no real payment link configured — unlock via mark-paid for the demo" }`
- Backend returns `payment_url: null` + `demo: true` rather than any placeholder domain. `STRIPE_LINK` (or `PAY_LINK`) env = the real link; demo flow = `POST .../pay/mark-paid` then refresh.
- The P2 /act contract above still applies (402 unpaid, 409 `run debate first`, 404 unknown session; payload stored as session `act`).