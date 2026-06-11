// Static-site build for S3 + CloudFront.
//
// Reproduces what server.js does at request time, but at build time —
// snapshots the two dynamic GETs (/manual, /api-spec.json) into static
// files and copies the static assets into dist/.
//
// Run:  node build.mjs
// Out:  ./dist/  (ready for `aws s3 sync`)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const MANUAL_DOC_ID = process.env.MANUAL_DOC_ID || '10Fc69C9uAniNGKDv0SMR03z0pr9WEWbHsGPLRBYUano';
const MANUAL_DOC_URL = `https://docs.google.com/document/d/${MANUAL_DOC_ID}/export?format=html`;
const SPEC_UPSTREAM = process.env.OPENAPI_SPEC_URL || 'https://api-test.leadsplease.com/v3/api-docs';

// When the site is served behind a path prefix (e.g. test.leadsplease.com/data-api),
// every root-relative URL in the bundled HTML/sitemap needs that prefix baked in,
// because the browser resolves "/foo" against the document origin (not the request
// path) and would otherwise route those subrequests to whichever CloudFront cache
// behavior owns "/foo" — which on a shared distribution is rarely this bucket.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, ''); // trim trailing slash
// Used as the canonical hostname when rewriting sitemap.xml + robots.txt absolute URLs.
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://test.leadsplease.com';

// Files / dirs to copy verbatim from project root → dist/
const STATIC_ENTRIES = [
  'index.html',
  '_astro',
  'og-image.svg',
  'manifest.json',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
];

function extractDocBody(rawHtml) {
  const m = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = m ? m[1] : rawHtml;
  body = body.replace(/https:\/\/www\.google\.com\/url\?q=([^&"]+)(?:&[^"]*)?/g, (_m, encoded) => {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  });
  body = body.replace(/<p\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/p>/, '<h1$1>$2</h1>');
  return body;
}

async function copyRecursive(src, dst) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dst, { recursive: true });
    const entries = await fs.readdir(src);
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    await fs.copyFile(src, dst);
  }
}

async function buildManual() {
  console.log(`  fetching Google Doc ${MANUAL_DOC_ID}…`);
  const r = await fetch(MANUAL_DOC_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error(`upstream ${r.status} fetching Google Doc`);
  const raw = await r.text();
  const body = extractDocBody(raw);
  const template = await fs.readFile(path.join(ROOT, 'manual.html'), 'utf-8');
  const rendered = template.replace('<!-- DOC_BODY -->', body);
  await fs.mkdir(path.join(DIST, 'manual'), { recursive: true });
  await fs.writeFile(path.join(DIST, 'manual', 'index.html'), rendered, 'utf-8');
  console.log(`  ✓ dist/manual/index.html  (${rendered.length.toLocaleString()} bytes)`);
}

async function buildSpec() {
  console.log(`  fetching OpenAPI spec from ${SPEC_UPSTREAM}…`);
  const r = await fetch(SPEC_UPSTREAM, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`upstream ${r.status} fetching OpenAPI spec`);
  const json = await r.json();
  const out = JSON.stringify(json);
  await fs.writeFile(path.join(DIST, 'api-spec.json'), out, 'utf-8');
  console.log(`  ✓ dist/api-spec.json  (${out.length.toLocaleString()} bytes)`);
}

async function copyStatic() {
  for (const name of STATIC_ENTRIES) {
    const src = path.join(ROOT, name);
    const dst = path.join(DIST, name);
    try {
      await copyRecursive(src, dst);
      console.log(`  ✓ dist/${name}`);
    } catch (err) {
      if (err.code === 'ENOENT') console.warn(`  ⚠ skipped ${name} (not found)`);
      else throw err;
    }
  }
}

// Prefix every root-relative URL with BASE_PATH. Skips protocol-relative,
// data: URIs, anchors, and anything already starting with BASE_PATH.
function prefixRootRefs(text) {
  if (!BASE_PATH) return text;
  const prefix = BASE_PATH; // e.g. '/data-api'
  const alreadyPrefixed = new RegExp(`^${prefix.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&')}(/|$)`);
  // Match an attribute / JS-string boundary then '/' then a "looks-like-a-path" char.
  return text.replace(/(["'\(])\/(?!\/|data:)([a-zA-Z0-9_\-?#])/g, (m, quote, firstChar) => {
    const after = `/${firstChar}`;
    if (alreadyPrefixed.test(after)) return m;
    return `${quote}${prefix}${after}`;
  });
}

async function rewriteForBasePath() {
  if (!BASE_PATH) {
    console.log('  (BASE_PATH unset — skipping URL rewriting)');
    return;
  }
  console.log(`  rewriting URLs with BASE_PATH=${BASE_PATH}`);

  for (const rel of ['index.html', 'manual/index.html']) {
    const file = path.join(DIST, rel);
    try {
      const src = await fs.readFile(file, 'utf-8');
      await fs.writeFile(file, prefixRootRefs(src), 'utf-8');
      console.log(`  ✓ rewrote ${rel}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // sitemap.xml: rewrite each <loc> URL so its host = PUBLIC_ORIGIN and its
  // path is prefixed with BASE_PATH. Must NOT touch xmlns="…" (that's an XML
  // namespace identifier, not a fetchable URL — rewriting it breaks the schema).
  const sitemapPath = path.join(DIST, 'sitemap.xml');
  try {
    let xml = await fs.readFile(sitemapPath, 'utf-8');
    xml = xml.replace(/<loc>([^<]+)<\/loc>/g, (_m, raw) => {
      const u = new URL(raw.trim());
      const p = u.pathname.startsWith(`${BASE_PATH}/`) || u.pathname === BASE_PATH
        ? u.pathname
        : `${BASE_PATH}${u.pathname}`;
      return `<loc>${PUBLIC_ORIGIN}${p}${u.search}${u.hash}</loc>`;
    });
    await fs.writeFile(sitemapPath, xml, 'utf-8');
    console.log('  ✓ rewrote sitemap.xml');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // robots.txt: update the Sitemap: line.
  const robotsPath = path.join(DIST, 'robots.txt');
  try {
    let txt = await fs.readFile(robotsPath, 'utf-8');
    txt = txt.replace(/^Sitemap:\s*https?:\/\/\S+/m, `Sitemap: ${PUBLIC_ORIGIN}${BASE_PATH}/sitemap.xml`);
    await fs.writeFile(robotsPath, txt, 'utf-8');
    console.log('  ✓ rewrote robots.txt');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function main() {
  console.log('Building static site → dist/');
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  // Run the two upstream fetches in parallel — they're independent.
  await Promise.all([buildManual(), buildSpec()]);
  await copyStatic();
  await rewriteForBasePath();

  console.log('\nDone. Deploy with:  pwsh deploy.ps1');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
