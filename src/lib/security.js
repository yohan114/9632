'use strict';

// Browser-facing protections that apply to every response: security headers, and a check that a
// request which CHANGES something was sent by this site's own pages.
//
// Dependency-free on purpose, like ratelimit.js: a handful of headers and one comparison do not
// justify a package, and every line here can be read in one sitting.

// ---------------------------------------------------------------------------
// SECURITY HEADERS
//
// Behind a public domain the browser is part of the attack surface, and these headers tell it what
// this site will never do, so it can refuse when someone else's page tries.
//
// The Content-Security-Policy is ENFORCED (access plan, Part 4). It ran report-only while the
// screens still had inline event handlers and index.html an inline script; those are gone — clicks
// are wired by one listener in public/app.js, the service worker is registered from
// public/js/sw-register.js, and the printable pages load public/js/print-page.js. So a script
// injected into a page (a name typed with a script tag in it, say) is refused by the browser, not run.
// test/csp.test.js keeps it that way: it fails on any inline handler or inline script.
// ---------------------------------------------------------------------------
// Two things come from outside, and only those: the chart library for the dashboard (this exact
// file, loaded by public/app.js when a chart is drawn) and the fonts (public/styles.css).
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${CHART_JS}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  // Never guess a file's type from its contents — an uploaded "image" must not run as script.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Nobody else's page may put this app in a frame (click-jacking). SAMEORIGIN, not DENY, so a
  // future print preview of our own pages still works.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The camera stays available to our own pages (battery / evidence photos); nothing else is used.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  // HSTS only over https. On the LAN (plain http) it would be ignored anyway, and sending it from a
  // test or dev server teaches a browser nothing useful. No includeSubDomains: other hosts under
  // the company domain are not ours to force onto https.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  // API answers carry costs, stock and names. On a shared workshop PC they must not sit in the
  // browser's disk cache for the next person. A route that wants caching can still set its own.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

// ---------------------------------------------------------------------------
// CROSS-SITE REQUEST CHECK (CSRF)
//
// The session cookie is SameSite=Lax, which already stops most cross-site form posts. This is the
// second lock: a request that changes data must come from a page of THIS site.
//
// Browsers say where a request came from, and a page cannot lie about it: they send `Origin` on
// every POST/PATCH/PUT/DELETE, and modern ones add `Sec-Fetch-Site`. So:
//
//   Origin present      -> it must be this host, or one of the trusted app origins below.
//   Sec-Fetch-Site      -> anything but same-origin / none (typed by the user) is refused.
//   Referer present     -> same rule as Origin.
//   none of the three   -> not a browser (the test suite, scripts, curl, the native HTTP layer of
//                          the Android app). CSRF is an attack through a victim's BROWSER, so a
//                          client that sends no browser headers is not what this defends against,
//                          and refusing it would break every script for no gain.
//
// "This host" is compared against the Host header, which nginx passes through unchanged. So the
// same code is right on the VPS (storesdb.ec-workshops.online), on the LAN (192.168.x.x:3000) and
// on a developer's machine, with nothing to configure.
//
// The packaged Android app is loaded from the device (http://localhost), not from the server, so
// its origin is not "this host". It is trusted by name. CSRF_TRUSTED_ORIGINS replaces that list;
// PUBLIC_ORIGIN is always trusted.
// ---------------------------------------------------------------------------
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_TRUSTED = ['http://localhost', 'https://localhost', 'capacitor://localhost'];

function trustedOrigins(env = process.env) {
  const list = env.CSRF_TRUSTED_ORIGINS !== undefined
    ? String(env.CSRF_TRUSTED_ORIGINS).split(',')
    : DEFAULT_TRUSTED.slice();
  if (env.PUBLIC_ORIGIN) list.push(env.PUBLIC_ORIGIN);
  return new Set(list.map((o) => o.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean));
}

function originGuard({ env = process.env } = {}) {
  const trusted = trustedOrigins(env);

  const allowed = (origin, host) => {
    const o = String(origin).trim().toLowerCase();
    // "null" is what a sandboxed frame or a file:// page sends. It is not an address, and an
    // attacker can produce it on purpose, so it is only accepted when explicitly listed.
    if (o === 'null') return trusted.has('null');
    let u;
    try { u = new URL(o); } catch { return false; }
    if (host && u.host === host) return true;
    return trusted.has(u.origin);
  };

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const host = String(req.headers.host || '').trim().toLowerCase();

    const refuse = (why) => {
      console.warn(`[security] refused cross-site ${req.method} ${req.originalUrl} (${why}) from ${req.ip}`);
      return res.status(403).json({
        error: 'Blocked: this request did not come from a WorkshopOne page. Reload the page and try again.',
      });
    };

    const origin = req.headers.origin;
    if (origin !== undefined) return allowed(origin, host) ? next() : refuse(`origin ${origin}`);

    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return refuse(`sec-fetch-site ${site}`);

    const referer = req.headers.referer;
    if (referer) {
      let refOrigin = null;
      try { refOrigin = new URL(referer).origin; } catch { /* malformed */ }
      return refOrigin && allowed(refOrigin, host) ? next() : refuse('referer');
    }
    return next();
  };
}

module.exports = { securityHeaders, originGuard, trustedOrigins, CSP };
