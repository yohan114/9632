'use strict';

// The Content-Security-Policy is enforced (src/lib/security.js). These tests pin the two halves:
// the header says what it should, and nothing in the pages relies on what it forbids. An inline
// onclick added next month would not fail any other test; it would just stop working in the
// browser, silently, for whoever presses it. The source scan below catches it here instead.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-csp-'));
process.env.DB_PATH = path.join(TMP, 'csp.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate } = require('../src/db');

migrate();
const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('the policy is enforced, forbids inline script, and says where to report', async () => {
  const r = await req('GET', '/');
  const csp = r.headers['content-security-policy'];
  assert.ok(csp, 'enforcing header present');
  assert.strictEqual(r.headers['content-security-policy-report-only'], undefined);
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.strictEqual(directives['script-src'], "'self'", 'no unsafe-inline / unsafe-eval / CDN for scripts');
  assert.strictEqual(directives['frame-ancestors'], "'none'");
  assert.strictEqual(directives['object-src'], "'none'");
  assert.strictEqual(directives['base-uri'], "'self'");
  assert.strictEqual(directives['form-action'], "'self'");
  assert.strictEqual(directives['report-uri'], '/csp-report');
  assert.strictEqual(directives['report-to'], 'csp');
  assert.match(r.headers['reporting-endpoints'] || '', /csp="\/csp-report"/);
  assert.strictEqual(r.headers['x-frame-options'], 'DENY');
});

test('the app shell has no inline script', async () => {
  const r = await req('GET', '/');
  assert.strictEqual(r.status, 200);
  const inline = r.text.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
  assert.deepStrictEqual(inline, [], 'every <script> in index.html loads a file');
});

test('a browser violation report is accepted without sign-in and without an Origin check', async () => {
  const report = JSON.stringify({ 'csp-report': {
    'document-uri': 'http://example.test/#/stores',
    'effective-directive': 'script-src-attr',
    'blocked-uri': 'inline',
  } });
  const r = await req('POST', '/csp-report', {
    body: report,
    headers: { 'Content-Type': 'application/csp-report', Origin: 'http://somewhere-else.test', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.strictEqual(r.status, 204);

  const listForm = JSON.stringify([{ type: 'csp-violation', body: { documentURL: 'http://x.test/', effectiveDirective: 'script-src-elem', blockedURL: 'https://cdn.test/a.js' } }]);
  const r2 = await req('POST', '/csp-report', { body: listForm, headers: { 'Content-Type': 'application/reports+json' } });
  assert.strictEqual(r2.status, 204);

  const big = await req('POST', '/csp-report', { body: 'x'.repeat(40 * 1024), headers: { 'Content-Type': 'application/csp-report' } });
  assert.strictEqual(big.status, 204, 'an oversized body is dropped, not an error page');
});

// ------------------------------------------------------------------ source scan
const ROOT = path.join(__dirname, '..');
function filesUnder(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, exts));
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}
// Markup attributes only: `btn.onclick = fn` (a property set from a script file) is allowed.
const INLINE_HANDLER = /[\s"'`]on[a-z]+=["'`$\\]/;
const JS_URL = /javascript:/i;
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>/i;

test('no page the browser runs depends on inline handlers, javascript: links or inline <script>', () => {
  const offenders = [];
  const pub = filesUnder(path.join(ROOT, 'public'), ['.js', '.html'])
    .filter((p) => !p.endsWith('chart.umd.min.js'));
  // Server code that writes HTML pages (print views, reports, previews).
  const srv = filesUnder(path.join(ROOT, 'src'), ['.js']);
  for (const file of [...pub, ...srv]) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // comments describe the old way
      if (INLINE_HANDLER.test(line) || JS_URL.test(line) || INLINE_SCRIPT.test(line)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [], 'use data- attributes (public/js/dom-actions.js) or addEventListener');
});
