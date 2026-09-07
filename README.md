# LeadsPlease Data API — Marketing Microsite

Public-facing landing page for the LeadsPlease REST/JSON Data API. The actual API runs separately (`api.leadsplease.com` for LIVE, `api-test.leadsplease.com` for TEST) — this site is purely marketing + onboarding documentation.

## Tabs

1. **Use the LeadsPlease Data API** — overview, stats, 4-step pipeline, endpoint quick reference
2. **Try It** — copy-paste cURL/Node/Python snippets for all five core calls (auth → criteria → count → list → status), plus link to live Swagger UI
3. **Use Cases** — six recurring patterns (direct mail platforms, real-estate farming, Medicare birthday targeting, B2B SIC prospecting, ESP audience handoff, mass-tort prospect pools) + 6-question FAQ
4. **Get Started** — Free 30-day TEST signup, prepaid credit packs ($100 = 100 credits) for LIVE, Enterprise (custom), smoke-test bash, spec links, compliance summary

## Local development

```bash
npm install
PORT=4323 node server.js
# → http://localhost:4323
```

The `server.js` is a 30-line Express wrapper around `index.html` + the `_astro/` CSS bundle (mirrored from leadsplease.com so the topbar + footer render pixel-identical).

## Deployment

Railway (Dockerfile + `railway.toml`). Health-check endpoint at `/health`.

```bash
railway up --detach
```

## Domain

Production: `developers.leadsplease.com` (planned). Railway-default: `leadsplease-data-api-microsite-production.up.railway.app`.

## Repos

- GitHub origin: `Eprintwerx/leadsplease-data-api-microsite`
- GitLab backup: `graham32/leadsplease-data-api-microsite`

## Pattern compliance

All anti-CLS fixes from the sales-garden + MCP microsites are baked in:
- LayoutFullWidth.css inlined in `<head>` so topbar dimensions are reserved on first paint
- Google Fonts use `display=optional` (no swap-induced line-height shift)
- `scroll-padding-top: 130px` so deep links to `/#try`, `/#install` land below the sticky chrome
- Topbar logo `<img>` has explicit `width="248" height="44"` attributes
- `Cache-Control: no-store` on HTML for instant local-dev refresh

## Spec source

The endpoint reference is sourced from the LeadsPlease API Manual (Google Doc, v1.3.4). Update both this microsite and the manual together — the manual is canonical for request/response schemas.
