# Build notes & scope log — 2026-10-11

## P2 addition (locked 13:36): "Act" tab — swarm drafts artifacts
- Same agents, execution mode: for artifact-producing decisions (promos, flyers,
  menus, simple landing-page mock), the winning camp's arguments seed 3 candidate
  drafts; the strong judge scores drafts against the same evidence; owner picks.
- One-liner: "Ask your customers, then let them draft it."
- Build only if core stable by ~4:30. Not P0/P1.

## Vision slide (video 1:45–2:00): SwarmStudio
- Same engine (crowd → judge → artifact) terminal object = code, not a verdict.
- Post-hackathon track. NOT a demo feature today — one slide only.

## Model routing (final)
- Crowd (personas, debate, digests, loop reflection): gpt-4o-mini primary,
  Groq gpt-oss-120b fallback (free tier = 8k TPM: too slow for full runs),
  Luminal parked pending base URL/model.
- Judge: gpt-5.6-sol (strong lane, pinned via client prefer="strong").
- Crowd model is FIXED per product for verdict reproducibility.

## Gotchas learned today (do not re-trip)
- Groq json_object mode requires the literal word "json" somewhere in the prompt.
- gpt-5.x / o-series reject max_tokens — need max_completion_tokens, no temperature.
- Adapter field names: bridge rows use `claim`/`source_url`; normalize before card creation.
- Scraper sidecar must run with PYTHONUTF8=1 (cp1252 spinner crash otherwise); never with -I.
- review_text from sidecar is a {"en": "..."} map — flatten before use.
- Ingest verdict gating: unpaid verdict = teaser {recommendation, confidence} only.