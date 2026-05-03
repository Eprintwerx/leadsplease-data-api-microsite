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
