# Customer Swarm — frontend

Zero-dependency static frontend (no build step). Two faces, Mirofish-style:

| Page | Face | What it is |
|---|---|---|
| `index.html` | black / Inter | Marketing landing: hero, walking customer crowd, 5-step workflow, scenarios, philosophy, footer |
| `console.html` | white / mono "lab" | The product: name-only intake → 5-step run (Scout → Swarm → Debate → Verdict → Learn) with a live feed pane |

## Run it

```bash
cd frontend
python -m http.server 8020
# → http://localhost:8020/index.html   (landing)
# → http://localhost:8020/console.html (console, mock replay — always works)
```

Any static server works (`npx serve`, nginx, S3+CloudFront).

## Mock vs. live

By default the console runs a **mock replay** (`assets/js/mock-data.js` — the full
Cafe 210 West trace streamed with realistic pacing through the same event
vocabulary the backend uses). Nothing else needs to exist for the demo.

Live backend wiring — set in `console.html`'s config block:

```html
<script>
  window.CS_STRIPE_LINK = "";   // Stripe Payment Link ($19 deep-dive); "" = demo unlock button
  window.CS_API_BASE  = "";     // e.g. "http://localhost:8000"
</script>
```

Live mode: `console.html?live=1&sid=<session-id>` → opens
`GET {CS_API_BASE}/api/sessions/{sid}/stream` (SSE). SSE messages are JSON:
`{"event": "<name>", "data": {...}}` with the same event names as below.
Redirect users back with `?paid=1` after Stripe checkout → unlock persists in `localStorage`.

## Event vocabulary (SSE contract)

`session:start · scout:status · scout:source · scout:reviews · scout:done ·
evidence · segment · persona · debate:round · debate:camp · debate:arg ·
debate:digest · debate:demoted · debate:done · verdict · loop:start ·
loop:iter · loop:chart · loop:done`

Payload shapes live in `assets/js/mock-data.js` — treat that file as the
executable contract. `docs/prd-v2.md` (repo root) is the product truth.

## Where things live

```
frontend/
  index.html            landing (black face)
  console.html          console (lab face) + integrator config + SSE/mock switch
  assets/css/tokens.css shared design tokens (both faces)
  assets/css/landing.css · landing.js · crowd.js      ← landing face
  assets/css/console.css · console.js · steps/scout.js ← console shell + step 1
  assets/js/bridge.js   THE CONTRACT: step registry, event bus, session store, replay/live drivers
  assets/js/mock-data.js demo dataset (Cafe 210 West) + CSMock.chat
  assets/js/effects.js  shared FX: spotlight cards, reveals, orbs, procedural busts/avatars
  assets/js/steps/*.js  steps 2–5 (swarm, debate, verdict, learn) + their css
```

## Notes

- Brand: amber/black bee palette, hexagon mark — nothing copied from the reference site.
- Crowd + avatar art is procedurally generated line-art (`effects.js`), no image assets.
- `docs/prd-v2.md` at the repo root is the product spec this UI was built against.