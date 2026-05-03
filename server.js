// Tiny static-file server for the LeadsPlease Data API marketing
// landing page. Static-only — the actual API lives at api.leadsplease.com.
//
//   /                      → marketing landing page
//   /_astro/*              → CSS + font assets
//   /health                → Railway healthcheck

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8767;

function setCacheHeaders(res, filePath) {
  if (filePath.includes('/_astro/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (filePath.endsWith('.html')) {
    // No-cache so iterative dev shows the latest commit on every refresh
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}

// Health check — Railway hits this to decide if the service is up
app.get('/health', function (req, res) {
  res.json({ ok: true, service: 'leadsplease-data-api-microsite', uptime_s: Math.round(process.uptime()) });
});

// ─── OpenAPI spec proxy ───────────────────────────────────────
// The upstream LP API exposes its OpenAPI 3.0.1 spec at /v3/api-docs
// but doesn't send CORS headers, so a browser-side fetch would be
// blocked. We proxy server-side (cached 10 min) so the embedded
// Swagger UI on the Reference tab can load it same-origin.
const SPEC_UPSTREAM = process.env.OPENAPI_SPEC_URL || 'https://api-test.leadsplease.com/v3/api-docs';
let specCache = { json: null, fetchedAt: 0 };
const SPEC_TTL_MS = 10 * 60 * 1000; // 10 min

app.get('/api-spec.json', async function (req, res) {
  try {
    const fresh = !specCache.json || Date.now() - specCache.fetchedAt > SPEC_TTL_MS;
    if (fresh) {
      const r = await fetch(SPEC_UPSTREAM, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('upstream ' + r.status);
      specCache = { json: await r.json(), fetchedAt: Date.now() };
    }
    res.set('Cache-Control', 'public, max-age=600');
    res.set('Access-Control-Allow-Origin', '*');
    res.json(specCache.json);
  } catch (err) {
    console.error('spec proxy error:', err.message);
    res.status(502).json({ error: 'spec_unreachable', message: err.message });
  }
});

// Static files
app.use(express.static(path.join(__dirname), {
  setHeaders: setCacheHeaders,
  extensions: ['html'],
  index: 'index.html',
}));

app.listen(PORT, function () {
  console.log('LeadsPlease Data API microsite running on port ' + PORT);
  console.log('  http://localhost:' + PORT + '/');
});
