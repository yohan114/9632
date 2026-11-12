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
// The Content-Security-Policy is ENFORCED. Scripts run only from files this server sends: no inline
// <script>, no onclick="..." in markup, no javascript: links, no eval, no CDN. Click behaviours that
// used to be inline live in public/js/dom-actions.js and are named by data- attributes.
//
// style-src still allows 'unsafe-inline': the screens set thousands of style="..." attributes, and
// inline style cannot run code. Taking it away is a separate, much larger job.
//
// Violations are reported to /csp-report (see cspReport below) and logged, so a screen that a
// change breaks shows up in the server log instead of only in one person's browser console.
// ---------------------------------------------------------------------------
const CSP_REPORT_PATH = '/csp-report';
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `report-uri ${CSP_REPORT_PATH}`,
  'report-to csp',
];
const CSP = CSP_DIRECTIVES.join('; ');
// The one page this app shows inside its own frame (the outsourcing request preview). Same policy,
// but our own pages may frame it.
const CSP_SAME_ORIGIN_FRAME = CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

function securityHeaders(req, res, next) {
  // Never guess a file's type from its contents — an uploaded "image" must not run as script.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Nobody may put this app in a frame (click-jacking). The one page our own screens frame says so
  // with allowSameOriginFraming(). Browsers that know CSP go by frame-ancestors; this is for the rest.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The camera stays available to our own pages (battery / evidence photos); nothing else is used.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Reporting-Endpoints', `csp="${CSP_REPORT_PATH}"`);
  // HSTS only over https. On the LAN (plain http) it would be ignored anyway, and sending it from a
  // test or dev server teaches a browser nothing useful. No includeSubDomains: other hosts under
  // the company domain are not ours to force onto https.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  // API answers carry costs, stock and names. On a shared workshop PC they must not sit in the
  // browser's disk cache for the next person. A route that wants caching can still set its own.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

// For a page that this app shows in an <iframe> of its own.
function allowSameOriginFraming(res) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CSP_SAME_ORIGIN_FRAME);
}

// ---------------------------------------------------------------------------
// CSP VIOLATION REPORTS
//
// Browsers POST a JSON report here when the policy blocks something: report-uri sends
// application/csp-report, the Reporting API sends application/reports+json (a list). No sign-in —
// the browser sends reports on its own, often without cookies — so it is treated as untrusted
// input: a small body, only a few fields kept, each cut short, and at most REPORT_LOG_PER_MINUTE
// lines a minute so nobody can fill the log by posting here in a loop.
// ---------------------------------------------------------------------------
const REPORT_LOG_PER_MINUTE = 30;
let reportWindowStart = 0;
let reportsThisWindow = 0;
let reportsDropped = 0;

function cspReportFields(r) {
  if (!r || typeof r !== 'object') return null;
  const body = r['csp-report'] || r.body || r;
  if (!body || typeof body !== 'object') return null;
  const cut = (v) => String(v == null ? '' : v).slice(0, 200);
  return {
    page: cut(body['document-uri'] || body.documentURL),
    directive: cut(body['effective-directive'] || body.effectiveDirective || body['violated-directive']),
    blocked: cut(body['blocked-uri'] || body.blockedURL),
    source: cut(body['source-file'] || body.sourceFile),
    line: Number(body['line-number'] || body.lineNumber) || null,
    sample: cut(body['script-sample'] || body.sample).slice(0, 80),
  };
}

function cspReport() {
  const express = require('express');
  const parse = express.json({
    limit: '16kb',
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
  });
  return (req, res) => {
    parse(req, res, (err) => {
      res.status(204).end();
      if (err) return;
      const list = Array.isArray(req.body) ? req.body.slice(0, 10) : [req.body];
      const now = Date.now();
      if (now - reportWindowStart > 60000) {
        if (reportsDropped) console.warn(`[csp] ${reportsDropped} more violation report(s) not logged (rate limit)`);
        reportWindowStart = now;
        reportsThisWindow = 0;
        reportsDropped = 0;
      }
      for (const r of list) {
        const f = cspReportFields(r);
        if (!f) continue;
        if (reportsThisWindow >= REPORT_LOG_PER_MINUTE) { reportsDropped++; continue; }
        reportsThisWindow++;
        console.warn('[csp] blocked', JSON.stringify(f));
      }
    });
  };
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

// Is `origin` this host (the request's Host header) or one of the trusted origins? Shared by the
// CSRF check below and the live-update socket's handshake check (src/server.js).
function originAllowed(origin, host, trusted) {
  const o = String(origin).trim().toLowerCase();
  // "null" is what a sandboxed frame or a file:// page sends. It is not an address, and an
  // attacker can produce it on purpose, so it is only accepted when explicitly listed.
  if (o === 'null') return trusted.has('null');
  let u;
  try { u = new URL(o); } catch { return false; }
  const h = String(host || '').trim().toLowerCase();
  if (h && u.host === h) return true;
  return trusted.has(u.origin);
}

function originGuard({ env = process.env } = {}) {
  const trusted = trustedOrigins(env);

  const allowed = (origin, host) => originAllowed(origin, host, trusted);

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

module.exports = {
  securityHeaders, originGuard, trustedOrigins, originAllowed, CSP,
  allowSameOriginFraming, cspReport, CSP_REPORT_PATH,
};
