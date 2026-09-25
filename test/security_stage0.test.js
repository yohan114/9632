'use strict';

// Stage 0 security fixes (docs/SECURITY_ACCESS_MULTISITE_PLAN.md §4, Stage 0).
//
// Each block pins one protection against the way it would quietly come undone: a header dropped in
// a refactor, a cross-site write let through, a password rule bypassed by the admin screen, a
// session that outlives a password change, an internal error message reaching the page.
//
// Requests go through raw http.request rather than fetch so the test controls every header —
// Origin, Referer and Sec-Fetch-Site are exactly what a browser would send, and fetch fills some in.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sec0-'));
const TEST_DB = path.join(TMP, 'live.db');
process.env.DB_PATH = TEST_DB;
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.CSRF_TRUSTED_ORIGINS;
delete process.env.PUBLIC_ORIGIN;

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const ratelimit = require('../src/lib/ratelimit');
const policy = require('../src/lib/password_policy');

migrate();
for (const n of ['admin', 'storekeeper']) run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
function mkUser(username, password, roles = [], extra = {}) {
  const id = run('INSERT INTO users (username, password_hash, active, must_change_password) VALUES (?, ?, 1, ?)',
    username, auth.hashPassword(password), extra.mustChange ? 1 : 0).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const ADMIN_PW = 'granite-harbour-lantern';
const adminId = mkUser('chief', ADMIN_PW, ['admin']);
const keeperId = mkUser('sunil', 'rivet-willow-summit', ['storekeeper']);

const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });

function req(method, p, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        const setc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: buf,
          cookie: setc ? setc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function login(username, password) {
  run('UPDATE users SET mfa_enabled = 0 WHERE username = ?', username);   // the password step alone
  const r = await req('POST', '/api/auth/login', { body: { username, password } });
  assert.strictEqual(r.status, 200, `login ${username}: ${r.text}`);
  return r.cookie;
}
const accessManager = async (username, password) => secondFactorOn(await login(username, password));

// Changing access needs 2-step sign-in (access plan, Part 4). The people here have it on, set
// directly (signing in with it is tested in test/mfa.test.js), so every refusal below has only the
// reason its test names: this person is marked as having it, and this session as having passed it.
function secondFactorOn(cookie) {
  const token = decodeURIComponent(cookie.split('=')[1]);
  const s = get('SELECT user_id FROM sessions WHERE token = ?', token);
  run('UPDATE users SET mfa_enabled = 1 WHERE id = ?', s.user_id);
  run('UPDATE sessions SET mfa_verified = 1 WHERE token = ?', token);
  return cookie;
}


// ---------------------------------------------------------------- headers
test('every response carries the security headers, and no X-Powered-By', async () => {
  const r = await req('GET', '/api/health');
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.strictEqual(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  // Enforced, not report-only (access plan, Part 4): scripts come only from this site's own files.
  assert.ok(r.headers['content-security-policy'].includes("object-src 'none'"));
  assert.ok(r.headers['content-security-policy'].includes("script-src 'self'"));
  assert.strictEqual(r.headers['content-security-policy-report-only'], undefined);
  assert.ok(r.headers['permissions-policy'].includes('microphone=()'));
  assert.strictEqual(r.headers['x-powered-by'], undefined, 'the framework is not advertised');
  assert.strictEqual(r.headers['cache-control'], 'no-store', 'API answers never sit in a shared PC\'s cache');
  assert.strictEqual(r.headers['strict-transport-security'], undefined, 'no HSTS over plain http');
});

test('HSTS is sent once the request arrived over https (behind the proxy)', async () => {
  const r = await req('GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(r.headers['strict-transport-security'] || '', /max-age=\d+/);
});

// ---------------------------------------------------------------- cross-site writes
test('a write from another site is refused before it is processed', async () => {
  const body = { username: 'chief', password: ADMIN_PW };
  for (const headers of [
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { Referer: 'https://evil.example/page' },
  ]) {
    const r = await req('POST', '/api/auth/login', { body, headers });
    assert.strictEqual(r.status, 403, `must refuse ${JSON.stringify(headers)}`);
    assert.strictEqual(r.cookie, null, 'and no session is created');
  }
});

test('our own pages, the Android app and non-browser clients can still write', async () => {
  const body = { username: 'chief', password: ADMIN_PW };
  for (const headers of [
    { Origin: `http://127.0.0.1:${port}` },                 // this site, as the browser names it
    { Origin: 'http://localhost' },                          // the packaged app (loaded from the device)
    { 'Sec-Fetch-Site': 'same-origin' },
    { Referer: `http://127.0.0.1:${port}/#/jobs` },
    {},                                                       // scripts, tests, curl, native HTTP
  ]) {
    const r = await req('POST', '/api/auth/login', { body, headers });
    assert.strictEqual(r.status, 200, `must allow ${JSON.stringify(headers)}: ${r.text}`);
  }
  // Reads are never refused for their origin: a GET changes nothing.
  assert.strictEqual((await req('GET', '/api/health', { headers: { Origin: 'https://evil.example' } })).status, 200);
});

test('CSRF_TRUSTED_ORIGINS / PUBLIC_ORIGIN decide which other origins are trusted', () => {
  const { trustedOrigins } = require('../src/lib/security');
  assert.ok(trustedOrigins({}).has('http://localhost'));
  const t = trustedOrigins({ CSRF_TRUSTED_ORIGINS: 'https://a.example/', PUBLIC_ORIGIN: 'https://B.example' });
  assert.deepStrictEqual([...t].sort(), ['https://a.example', 'https://b.example']);
  assert.strictEqual(trustedOrigins({ CSRF_TRUSTED_ORIGINS: '' }).size, 0, 'an empty list means none');
});

// ---------------------------------------------------------------- uploads
test('/uploads is no longer served to anyone who is not signed in', async () => {
  fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'old-photo.txt'), 'evidence');
  assert.strictEqual((await req('GET', '/uploads/old-photo.txt')).status, 401);
  const cookie = await login('sunil', 'rivet-willow-summit');
  const r = await req('GET', '/uploads/old-photo.txt', { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, 'evidence');
});

// ---------------------------------------------------------------- password rules
test('the password rules: length, common and company words, the username', () => {
  assert.match(policy.problem('short1'), /at least 10/);
  assert.match(policy.problem('Workshop@2026'), /too common/, 'the company word with a year and a symbol');
  assert.match(policy.problem('badalgama12345'), /too common/);
  assert.match(policy.problem('P@ssword!!!!'), /too common/);
  assert.match(policy.problem('P@ssw0rd2026'), /too common/, 'the usual letter swaps are read back');
  assert.match(policy.problem('W0rksh0p#2026'), /too common/);
  assert.match(policy.problem('1234567890'), /letters/);
  assert.match(policy.problem('aaaaaaaaab'), /too simple/);
  assert.match(policy.problem('sunil-rivet-2026', { username: 'sunil' }), /username/);
  assert.match(policy.problem('x'.repeat(40) + 'é'.repeat(20)), /at most/, 'bcrypt would silently cut it at 72 bytes');
  assert.strictEqual(policy.problem('rivet willow summit'), null);
  assert.strictEqual(policy.problem('Anchor-Bridge-4821'), null, 'scripts/create_staff.js temporary passwords pass');
});

test('change-password enforces the rules and refuses the same password again', async () => {
  const id = mkUser('nimal', 'cobalt-ember-quarry', ['storekeeper']);
  const cookie = await login('nimal', 'cobalt-ember-quarry');
  const weak = await req('POST', '/api/auth/change-password', { cookie, body: { current_password: 'cobalt-ember-quarry', new_password: 'workshop1' } });
  assert.strictEqual(weak.status, 400);
  const same = await req('POST', '/api/auth/change-password', { cookie, body: { current_password: 'cobalt-ember-quarry', new_password: 'cobalt-ember-quarry' } });
  assert.strictEqual(same.status, 400);
  assert.match(same.body.error, /different/);
  assert.ok(get('SELECT 1 x FROM users WHERE id = ?', id));
});

test('changing your password signs out your other sessions, but not this one', async () => {
  mkUser('kamal', 'marble-nickel-oxide', ['storekeeper']);
  const phone = await login('kamal', 'marble-nickel-oxide');
  const pc = await login('kamal', 'marble-nickel-oxide');
  const r = await req('POST', '/api/auth/change-password', { cookie: pc, body: { current_password: 'marble-nickel-oxide', new_password: 'piston-vessel-zephyr' } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.otherSessionsEnded, 1);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: phone })).status, 401, 'the other device is signed out');
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: pc })).status, 200, 'the device that changed it stays in');
});

// ---------------------------------------------------------------- admin-set passwords
test('an account created by an admin must meet the rules and change its password at first sign-in', async () => {
  const cookie = await accessManager('chief', ADMIN_PW);
  const weak = await req('POST', '/api/users', { cookie, body: { username: 'ravi', password: 'ravi1234', roles: ['storekeeper'] } });
  assert.strictEqual(weak.status, 400);
  const ok = await req('POST', '/api/users', { cookie, body: { username: 'ravi', password: 'Kestrel-Timber-5521', roles: ['storekeeper'] } });
  assert.strictEqual(ok.status, 201, ok.text);
  assert.strictEqual(get('SELECT must_change_password m FROM users WHERE username = ?', 'ravi').m, 1);
  const ravi = await login('ravi', 'Kestrel-Timber-5521');
  const blocked = await req('POST', '/api/auth/signature', { cookie: ravi, body: { signature: null } });
  assert.strictEqual(blocked.status, 428, 'writes wait for the new password');
});

test('an admin password reset forces a change and signs the person out; deactivation does too', async () => {
  const id = mkUser('priya', 'forge-ingot-dynamo', ['storekeeper']);
  const priya = await login('priya', 'forge-ingot-dynamo');
  const admin = await accessManager('chief', ADMIN_PW);
  const reset = await req('PATCH', `/api/users/${id}`, { cookie: admin, body: { password: 'Summit-Lantern-7730' } });
  assert.strictEqual(reset.status, 200, reset.text);
  assert.strictEqual(get('SELECT must_change_password m FROM users WHERE id = ?', id).m, 1);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: priya })).status, 401, 'old session ended at the reset');

  const again = await login('priya', 'Summit-Lantern-7730');
  const off = await req('PATCH', `/api/users/${id}`, { cookie: admin, body: { active: false } });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(get('SELECT COUNT(*) c FROM sessions WHERE user_id = ?', id).c, 0, 'a switched-off account holds no sessions');
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: again })).status, 401);
});

// ---------------------------------------------------------------- sign-in record
test('failed sign-ins on real accounts and lockouts are on the record; invented names are not logged row by row', async () => {
  ratelimit.reset();
  const before = get("SELECT COUNT(*) c FROM audit_log WHERE action = 'login_failed'").c;
  await req('POST', '/api/auth/login', { body: { username: 'sunil', password: 'wrong-password' } });
  await req('POST', '/api/auth/login', { body: { username: 'nobody-by-this-name', password: 'x' } });
  const rows = all("SELECT user_id FROM audit_log WHERE action = 'login_failed' ORDER BY id").slice(before);
  assert.deepStrictEqual(rows.map((r) => r.user_id), [keeperId]);

  for (let i = 0; i < ratelimit.MAX_PER_USER; i++) {
    await req('POST', '/api/auth/login', { body: { username: 'ghost-account', password: 'x' } });
  }
  const locked = all("SELECT after_json FROM audit_log WHERE action = 'login_locked'");
  assert.ok(locked.some((r) => JSON.parse(r.after_json).username === 'ghost-account'), 'the lockout itself is recorded');
  ratelimit.reset();
});

test('on production, an account whose password is its username cannot sign in', async () => {
  mkUser('store', 'store', ['storekeeper']);
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const r = await req('POST', '/api/auth/login', { body: { username: 'store', password: 'store' } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.cookie, null);
    assert.match(r.body.error, /default password/);
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
  }
  // A development or demo database keeps the seeded logins.
  assert.strictEqual((await req('POST', '/api/auth/login', { body: { username: 'store', password: 'store' } })).status, 200);
});

test('/auth/me does not hand the session token to page script', async () => {
  const cookie = await login('sunil', 'rivet-willow-summit');
  const me = await req('GET', '/api/auth/me', { cookie });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.token, undefined);
  assert.ok(!me.text.includes(cookie.split('=')[1]), 'the cookie value appears nowhere in the body');
  assert.strictEqual(me.body.passwordPolicy.minLength, policy.MIN_LENGTH);
});

// ---------------------------------------------------------------- errors
test('an unexpected error shows a reference, not its internals; a refused write keeps its meaning', async () => {
  const express = require('express');
  const { errorHandler } = require('../src/lib/http');
  const mini = express();
  mini.get('/boom', () => { throw new TypeError("Cannot read properties of undefined (reading 'asset_id')"); });
  mini.get('/dup', () => { const e = new Error('UNIQUE constraint failed: mtn.mtn_no'); e.code = 'SQLITE_CONSTRAINT_UNIQUE'; throw e; });
  mini.get('/fk', () => { const e = new Error('FOREIGN KEY constraint failed'); e.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'; throw e; });
  mini.get('/rule', () => { const e = new Error('Stock would go negative'); e.status = 409; throw e; });
  mini.use(errorHandler);
  const s = await new Promise((res) => { const x = mini.listen(0, '127.0.0.1', () => res(x)); });
  const get_ = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port: s.address().port, path: p }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) }));
  }));
  const origError = console.error; console.error = () => {};
  try {
    const boom = await get_('/boom');
    assert.strictEqual(boom.status, 500);
    assert.ok(!boom.body.error.includes('asset_id'), 'no internal wording');
    assert.match(boom.body.error, new RegExp(boom.body.ref), 'the reference is shown so the log can be matched');
    const dup = await get_('/dup');
    assert.strictEqual(dup.status, 409);
    assert.match(dup.body.error, /already has this value \(mtn\.mtn_no\)/);
    assert.strictEqual((await get_('/fk')).status, 409);
    const rule = await get_('/rule');
    assert.deepStrictEqual([rule.status, rule.body.error], [409, 'Stock would go negative']);
  } finally { console.error = origError; s.close(); }
});

// ---------------------------------------------------------------- the page's HTML escaping
test("esc() escapes the apostrophe, so JSON in a single-quoted attribute cannot break out", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('const esc = '));
  assert.ok(line, 'esc() is defined on one line in app.js');
  const esc = new Function(`${line}; return esc;`)();
  const item = { name: "Driver's seat '><img src=x onerror=alert(1)>" };
  const attr = esc(JSON.stringify(item));
  assert.ok(!attr.includes("'") && !attr.includes('<') && !attr.includes('"'), attr);
  // What the browser hands to dataset: the attribute value with entities decoded.
  const decoded = attr.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.deepStrictEqual(JSON.parse(decoded), item, 'the data still arrives intact');
});

// ---------------------------------------------------------------- backups
test('health tells an admin about the backups, and tells everyone else nothing more', async () => {
  const { snapshot } = require('../src/lib/backup');
  await snapshot();
  const anon = await req('GET', '/api/health');
  assert.deepStrictEqual(anon.body, { ok: true, name: 'WorkshopOne' });
  const keeper = await req('GET', '/api/health', { cookie: await login('sunil', 'rivet-willow-summit') });
  assert.strictEqual(keeper.body.backup, undefined);
  const admin = await req('GET', '/api/health', { cookie: await login('chief', ADMIN_PW) });
  assert.strictEqual(admin.body.backup.last_snapshot.ok, true);
  assert.ok(admin.body.backup.newest_snapshot.name.startsWith('workshopone-'));
  assert.strictEqual(admin.body.backup.verify_overdue, true, 'no restore check has run yet');
  assert.strictEqual(admin.body.backup.ok, false, 'so the backups are not yet "ok"');
});

function runRestoreVerify(snapshotFile) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore.js'), '--verify', snapshotFile], {
    env: { ...process.env, DB_PATH: TEST_DB, BACKUP_DIR: process.env.BACKUP_DIR }, encoding: 'utf8',
  });
}

test('the restore check passes a good snapshot and records it', () => {
  const status = require('../src/lib/backup_status');
  const newest = status.newestSnapshot();
  const r = runRestoreVerify(path.join(process.env.BACKUP_DIR, newest.name));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /integrity_check ok/);
  const v = status.read().verify;
  assert.strictEqual(v.ok, true);
  assert.strictEqual(status.summary().ok, true, 'snapshot + mirror + fresh verify = ok');
});

test('the restore check FAILS a damaged snapshot, with a non-zero exit and a recorded verdict', () => {
  const status = require('../src/lib/backup_status');
  const good = path.join(process.env.BACKUP_DIR, status.newestSnapshot().name);
  const bad = path.join(TMP, 'damaged.db');
  const bytes = fs.readFileSync(good);
  // Leave the header (first page) alone so the file still opens, and scribble over the rest.
  for (let i = 4096; i < bytes.length; i += 97) bytes[i] = (bytes[i] + 0x5a) & 0xff;
  fs.writeFileSync(bad, bytes);
  const r = runRestoreVerify(bad);
  assert.notStrictEqual(r.status, 0, 'a scheduled run must be able to fail');
  assert.match(r.stdout + r.stderr, /RESTORE CHECK FAILED/);
  assert.strictEqual(status.read().verify.ok, false);
  assert.strictEqual(status.summary().ok, false);
});
