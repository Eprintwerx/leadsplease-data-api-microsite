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

// Body parser for the API-key application JSON
app.use(express.json({ limit: '50kb' }));

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

// ─── API-key application submission ──────────────────────────────
// Receives the lead-capture form on the Get Started tab. Forwards
// the application by email to graham@eprintwerx.com via Resend so
// keys can be provisioned manually within one business day.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'graham@eprintwerx.com';
const NOTIFY_CC = process.env.NOTIFY_CC || 'info@leadsplease.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'LeadsPlease Data API <noreply@datawidget.com>';

app.post('/api/api-key-application', async function (req, res) {
  const data = req.body || {};

  // Minimal validation — the form already validates client-side
  if (!data.email || !data.first_name || !data.last_name) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  // Build a human-readable email body
  const lines = [
    'New API-key application from the Data API microsite:',
    '',
    'Tier:             ' + (data.tier || '(not set)'),
    'First name:       ' + data.first_name,
    'Last name:        ' + data.last_name,
    'Business / org:   ' + (data.business_name || '(none)'),
    'Email:            ' + data.email,
    'Phone:            ' + (data.phone || '(none)'),
    'Website:          ' + (data.website || '(none)'),
    'Expected volume:  ' + (data.expected_volume || '(not set)'),
    'Use case:         ' + (data.use_case || '(none)'),
    'Accept terms:     ' + (data.accept_terms ? 'yes' : 'no'),
    'Accept data use:  ' + (data.accept_data ? 'yes' : 'no'),
    'Source:           ' + (data.source || '(unknown)'),
    'User-Agent:       ' + (req.headers['user-agent'] || '(unknown)'),
    'Submitted at:     ' + new Date().toISOString(),
  ];
  const textBody = lines.join('\n');

  // If Resend is not configured, log the application and still return success
  // so the user gets a polite confirmation; we'll see it in server logs.
  if (!RESEND_API_KEY) {
    console.log('[api-key-application] (no RESEND_API_KEY) ' + JSON.stringify(data));
    return res.json({ ok: true, message: 'Thanks — application received. We will email you within one business day with your TEST key.' });
  }

  // Send the notification email via Resend
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [NOTIFY_EMAIL],
        cc: NOTIFY_CC ? [NOTIFY_CC] : undefined,
        reply_to: data.email,
        subject: '[Data API] Application from ' + data.first_name + ' ' + data.last_name + ' (' + (data.business_name || data.email) + ')',
        text: textBody,
      }),
    });

    if (!r.ok) {
      const errBody = await r.text();
      console.error('[api-key-application] Resend error', r.status, errBody);
      return res.status(502).json({ error: 'email_send_failed', detail: 'HTTP ' + r.status });
    }

    console.log('[api-key-application] sent to ' + NOTIFY_EMAIL + ' (cc ' + (NOTIFY_CC || 'none') + ') for ' + data.email);
    return res.json({ ok: true, message: 'Thanks — your application is in. We will email your TEST key to ' + data.email + ' within one business day.' });
  } catch (err) {
    console.error('[api-key-application] exception:', err.message);
    return res.status(500).json({ error: 'server_error', detail: err.message });
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
