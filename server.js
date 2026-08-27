// Tiny static-file server for the LeadsPlease Data API marketing
// landing page. Static-only — the actual API lives at api.leadsplease.com.
//
//   /                      → marketing landing page
//   /_astro/*              → CSS + font assets
//   /health                → Railway healthcheck

const express = require('express');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8767;

// Gzip / brotli on every response — DataForSEO's on-page audit flagged
// `no_content_encoding`. The 200KB index.html compresses to ~25KB gzipped.
app.use(compression());

// Body parser for the API-key application JSON
app.use(express.json({ limit: '50kb' }));

// Staging-host guard — this app answers on its *.up.railway.app hostname as
// well as its canonical domain, and Google indexed the Railway one
// (Trello SEO #587). We order crawlers off the staging host only; the
// canonical domain is untouched.
//
// Deliberately NOT a robots.txt `Disallow`, and deliberately NOT a 301:
//   · `Disallow` would stop Google re-crawling, so the already-indexed
//     staging URL would linger as a bare listing. A noindex has to stay
//     crawlable for the URL to actually drop out of the index.
//   · A 301 would break the POST seams below (/api/register and
//     /api/api-key-application), which answer on this hostname.
function isStagingHost(req) {
  var host = String(req.headers.host || '').toLowerCase().split(':')[0];
  return /\.up\.railway\.app$/.test(host);
}

// Security + SEO headers on every response
app.use(function (req, res, next) {
  if (isStagingHost(req)) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  // X-Frame-Options omitted on purpose — /manual is intentionally embedded
  // via iframe of docs.google.com and we don't iframe this site elsewhere
  // (would also need to allow if anyone embeds /api-spec.json's Swagger).
  next();
});

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

// ─── /manual — server-rendered API manual ────────────────────────
// Fetches the Google Doc as HTML, extracts just the <body>, and injects
// into manual.html. This keeps the manual content crawlable by Google
// (an iframe embed is invisible to search engines) while still letting
// the source document be edited live in Google Docs.
const fs = require('fs');
const MANUAL_DOC_ID = process.env.MANUAL_DOC_ID || '10Fc69C9uAniNGKDv0SMR03z0pr9WEWbHsGPLRBYUano';
const MANUAL_DOC_URL = 'https://docs.google.com/document/d/' + MANUAL_DOC_ID + '/export?format=html';
const MANUAL_TTL_MS = 10 * 60 * 1000; // 10 min cache
let manualCache = { html: null, fetchedAt: 0 };

function extractDocBody(rawHtml) {
  // Google Docs export wraps the actual content in <body>...</body>
  // with a top-level <style> in <head>. Strip the chrome, keep the body.
  var m = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  var body = m ? m[1] : rawHtml;
  // Unwrap every Google redirect href: https://www.google.com/url?q=<real>&sa=D...
  // → real URL. Saves a round-trip and gives Google clean signals.
  body = body.replace(/https:\/\/www\.google\.com\/url\?q=([^&"]+)(?:&[^"]*)?/g, function (_m, encoded) {
    try { return decodeURIComponent(encoded); } catch (e) { return encoded; }
  });
  // Promote the doc's title <p class="...title"> to an <h1> for SEO + a11y.
  body = body.replace(/<p\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/p>/, '<h1$1>$2</h1>');
  return body;
}

app.get('/manual', async function (req, res) {
  try {
    const fresh = !manualCache.html || Date.now() - manualCache.fetchedAt > MANUAL_TTL_MS;
    if (fresh) {
      const r = await fetch(MANUAL_DOC_URL, { redirect: 'follow' });
      if (!r.ok) throw new Error('upstream ' + r.status);
      const raw = await r.text();
      manualCache = { html: extractDocBody(raw), fetchedAt: Date.now() };
    }
    const template = fs.readFileSync(path.join(__dirname, 'manual.html'), 'utf-8');
    const rendered = template.replace('<!-- DOC_BODY -->', manualCache.html);
    res.set('Cache-Control', 'public, max-age=600'); // 10 min CDN cache
    res.set('Content-Type', 'text/html; charset=UTF-8');
    res.send(rendered);
  } catch (err) {
    console.error('[/manual] error:', err.message);
    // Fallback: serve the static manual.html with an iframe-style fallback
    const template = fs.readFileSync(path.join(__dirname, 'manual.html'), 'utf-8');
    const fallback = '<div class="fallback">Couldn&rsquo;t load the manual right now. <a href="https://docs.google.com/document/d/' + MANUAL_DOC_ID + '/preview" target="_blank" rel="noopener">View it on Google Docs &rarr;</a></div>';
    res.set('Content-Type', 'text/html; charset=UTF-8');
    res.send(template.replace('<!-- DOC_BODY -->', fallback));
  }
});

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

// ─── Unified self-registration (THE seam to Tomasz's Register endpoint) ───
// The new /signup form posts here. When LP_REGISTER_URL is set we forward to the
// real LeadsPlease Register API (Test) and return the affiliate code + key. Until
// then we capture the lead by email so NO filled-in data is ever lost — flipping to
// real is purely setting the two env vars below (zero code change).
const LP_REGISTER_URL = process.env.LP_REGISTER_URL || '';
const LP_API_KEY = process.env.LP_API_KEY || '';

app.post('/api/register', async function (req, res) {
  const d = req.body || {};
  if (!d.email || !d.first_name || !d.last_name || !d.business_name) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  // ── REAL mode: forward the filled-in data to Tomasz's Register endpoint ──
  if (LP_REGISTER_URL) {
    try {
      const r = await fetch(LP_REGISTER_URL, {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          LP_API_KEY ? { Authorization: 'Bearer ' + LP_API_KEY } : {}
        ),
        body: JSON.stringify({
          firstName: d.first_name,
          lastName: d.last_name,
          company: d.business_name,
          email: d.email,
          phone: d.phone,
          affiliateCode: d.affiliate_code,
          capability: d.product_interest === 'all' ? 'both' : d.product_interest,
          website: d.website,
          useCase: d.use_case,
          gaClientId: d.ga_client_id,
          utmSource: d.utm_source,
          utmMedium: d.utm_medium,
          utmCampaign: d.utm_campaign,
          referrer: d.referrer,
          source: d.source,
        }),
      });
      const body = await r.json().catch(function () { return {}; });
      if (!r.ok) return res.status(502).json({ error: (body && body.error) || ('register_failed_' + r.status) });
      return res.json({
        ok: true,
        affiliate_code: body.affiliateCode || body.code || d.affiliate_code,
        api_key: body.apiKey || body.testApiKey || null,
        message: body.message,
      });
    } catch (err) {
      console.error('[register] forward error:', err.message);
      return res.status(502).json({ error: 'register_unreachable', detail: err.message });
    }
  }

  // ── INTERIM mode: no Register URL yet → capture the lead so nothing is lost ──
  const utm = [d.utm_source, d.utm_medium, d.utm_campaign].filter(Boolean).join(' / ') || '(none)';
  const textBody = [
    'New self-registration from the Data API microsite (forward to Tomasz Register when live):',
    '',
    'Product interest: ' + (d.product_interest || '(all)'),
    'First name:       ' + d.first_name,
    'Last name:        ' + d.last_name,
    'Business:         ' + d.business_name,
    'Affiliate code:   ' + (d.affiliate_code || '(none)'),
    'Email:            ' + d.email,
    'Phone:            ' + (d.phone || '(none)'),
    'Website:          ' + (d.website || '(none)'),
    'Expected volume:  ' + (d.expected_volume || '(not set)'),
    'Use case:         ' + (d.use_case || '(none)'),
    'Accept terms:     ' + (d.accept_terms ? 'yes' : 'no'),
    'Accept data:      ' + (d.accept_data ? 'yes' : 'no'),
    'GA client_id:     ' + (d.ga_client_id || '(none)'),
    'UTM:              ' + utm,
    'Referrer:         ' + (d.referrer || '(none)'),
    'Source:           ' + (d.source || '(unknown)'),
    'Submitted at:     ' + new Date().toISOString(),
  ].join('\n');

  if (!RESEND_API_KEY) {
    console.log('[register] (no RESEND_API_KEY) ' + JSON.stringify(d));
    return res.json({ ok: true, message: 'Thanks — your Test access is being set up. We will email your affiliate code and key to ' + d.email + ' shortly.' });
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [NOTIFY_EMAIL],
        cc: NOTIFY_CC ? [NOTIFY_CC] : undefined,
        reply_to: d.email,
        subject: '[Data API] Self-registration: ' + d.first_name + ' ' + d.last_name + ' (' + (d.business_name || d.email) + ')',
        text: textBody,
      }),
    });
    if (!r.ok) {
      const e = await r.text();
      console.error('[register] Resend error', r.status, e);
      return res.status(502).json({ error: 'email_send_failed' });
    }
    return res.json({ ok: true, message: 'Thanks — your Test access is being set up. We will email your affiliate code and key to ' + d.email + ' shortly.' });
  } catch (err) {
    console.error('[register] exception:', err.message);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

// robots.txt — the canonical domain gets the real file (with its Sitemap
// line). The Railway staging host gets a copy that advertises no sitemap.
// Crawling stays allowed on purpose so the X-Robots-Tag noindex above is
// seen and the staging URL actually drops out of the index.
app.get('/robots.txt', function (req, res) {
  res.type('text/plain');
  if (isStagingHost(req)) {
    return res.send('User-agent: *\nAllow: /\n');
  }
  res.sendFile(path.join(__dirname, 'robots.txt'));
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

  // Pre-warm the OpenAPI spec cache so the first /api-spec.json request
  // (when a visitor opens the Reference tab) is served from memory, not
  // a cold proxy round-trip to api-test.leadsplease.com.
  fetch(SPEC_UPSTREAM, { headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (j) { specCache = { json: j, fetchedAt: Date.now() }; console.log('  spec cache pre-warmed (' + Object.keys(j).length + ' top-level keys)'); }
    })
    .catch(function (err) { console.error('  spec pre-warm failed:', err.message); });
});
