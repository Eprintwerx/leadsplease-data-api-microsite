// Graham's 2026-10-04 policy: only the main LeadsPlease website may be indexed.
// All product domains, affiliates, previews, test hosts and provider mirrors
// receive noindex on every response, including redirects, errors and assets.
// Do not use forwarding headers to grant an indexing exemption: callers can
// supply them, and Cloudflare may rewrite the origin Host for product domains.
function resolveHost(req) {
  return String(req.headers.host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}
function isGuardedHost(host) {
  return host !== 'leadsplease.com' && host !== 'www.leadsplease.com';
}
function noindexGuard(req, res, next) {
  if (!isGuardedHost(resolveHost(req))) return next();
  res.locals.noindex = true;
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.path === '/robots.txt') {
    // Crawlers must be allowed to fetch a URL to discover its noindex header.
    // Authentication and private-data access controls remain independent.
    return res.type('text/plain').send('User-agent: *\nAllow: /\n');
  }
  next();
}
module.exports = { noindexGuard, resolveHost, isGuardedHost };
