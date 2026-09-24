'use strict';

// Two-factor sign-in (src/lib/mfa.js, src/lib/totp.js, src/lib/secretbox.js).
//
// Pins: the code generator against the RFC's own vectors; that an enrolled account gets NO session
// from a password alone; that codes are single-use, throttled and time-limited; that recovery codes
// work once; that a role requiring it holds back the API and the live feed until the person enrols;
// that the keys are unreadable without the key file; and the admin / CLI ways back in.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mfa-'));
process.env.DB_PATH = path.join(TMP, 'mfa.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MFA_SECRET_KEY;

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const totp = require('../src/lib/totp');
const box = require('../src/lib/secretbox');
const ratelimit = require('../src/lib/ratelimit');
const capabilities = require('../src/lib/capabilities');

migrate();
for (const n of ['admin', 'storekeeper', 'viewer']) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
const PW = 'harbour-granite-ember';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const chiefId = mkUser('chief', ['admin']);

const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.httpServer.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const loginRaw = (username) => req('POST', '/api/auth/login', { body: { username, password: PW } });
async function login(username) {
  const r = await loginRaw(username);
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.cookie, 'a session cookie');
  return r.cookie;
}

// Enrol someone through the real endpoints; returns their secret and recovery codes.
async function enrol(cookie) {
  const s = await req('POST', '/api/auth/mfa/setup', { cookie });
  assert.strictEqual(s.status, 200, s.text);
  const e = await req('POST', '/api/auth/mfa/enable', { cookie, body: { code: totp.codeAt(s.body.secret) } });
  assert.strictEqual(e.status, 200, e.text);
  return { secret: s.body.secret, recovery: e.body.recoveryCodes };
}

// A code the server has not seen yet: the next 30-second step (inside the ±1 window).
const nextCode = (secret, stepsAhead = 1) => totp.codeAt(secret, Date.now() + stepsAhead * totp.STEP_SECONDS * 1000);

// socket.io over the polling transport, as in test/socket_auth.test.js.
async function socketOpens(cookie) {
  const base = `http://127.0.0.1:${port}`;
  const headers = cookie ? { cookie } : {};
  const q = `${base}/socket.io/?EIO=4&transport=polling`;
  const open = await (await fetch(q, { headers })).text();
  const sid = (open.match(/"sid"\s*:\s*"([^"]+)"/) || [])[1];
  await fetch(`${q}&sid=${sid}`, { method: 'POST', headers, body: '40' });
  const reply = await (await fetch(`${q}&sid=${sid}`, { headers })).text();
  return /(^|\x1e)40[{[]/.test(reply) || /(^|\x1e)40$/.test(reply);
}

// ---------------------------------------------------------------- the code generator
test('TOTP matches the RFC 6238 test vectors (SHA-1)', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.strictEqual(totp.codeAt(secret, t * 1000, 8), code, `t=${t}`);
  }
  assert.deepStrictEqual(totp.base32Decode(secret), Buffer.from('12345678901234567890'));
});

test('a code is accepted one step either side, not two, and never twice', () => {
  const secret = totp.newSecret();
  const now = Date.now();
  const at = (d) => totp.codeAt(secret, now + d * 30000);
  assert.notStrictEqual(totp.verify(secret, at(0), { ms: now }), null);
  assert.notStrictEqual(totp.verify(secret, at(-1), { ms: now }), null, 'a phone a little slow');
  assert.notStrictEqual(totp.verify(secret, at(1), { ms: now }), null, 'a phone a little fast');
  assert.strictEqual(totp.verify(secret, at(-3), { ms: now }), null);
  const step = totp.verify(secret, at(0), { ms: now });
  assert.strictEqual(totp.verify(secret, at(0), { ms: now, lastStep: step }), null, 'replay refused');
  assert.strictEqual(totp.verify(secret, 'abcdef'), null);
  assert.strictEqual(totp.verify(secret, '12345'), null);
});

test('the two-factor keys are sealed, and useless without the key file', () => {
  const sealed = box.seal('JBSWY3DPEHPK3PXP');
  assert.ok(sealed.startsWith('v1:') && !sealed.includes('JBSWY3DPEHPK3PXP'));
  assert.strictEqual(box.open(sealed), 'JBSWY3DPEHPK3PXP');
  assert.ok(fs.existsSync(box.keyFile()), 'the key lives beside the database, not in it');
  process.env.MFA_SECRET_KEY = 'ab'.repeat(32); box._reset();
  assert.strictEqual(box.open(sealed), null, 'another key cannot read it — and does not throw');
  delete process.env.MFA_SECRET_KEY; box._reset();
  assert.strictEqual(box.open(sealed), 'JBSWY3DPEHPK3PXP');
});

// ---------------------------------------------------------------- enrolling and signing in
test('enrolling needs a right code, gives 10 recovery codes, and signs out the other sessions', async () => {
  const id = mkUser('ama', ['storekeeper']);
  const phone = await login('ama');
  const pc = await login('ama');
  const s = await req('POST', '/api/auth/mfa/setup', { cookie: pc });
  assert.match(s.body.uri, /^otpauth:\/\/totp\/WorkshopOne%3Aama\?secret=[A-Z2-7]+&issuer=WorkshopOne/);
  assert.strictEqual((await req('POST', '/api/auth/mfa/enable', { cookie: pc, body: { code: '000000' } })).status, 400);
  const e = await req('POST', '/api/auth/mfa/enable', { cookie: pc, body: { code: totp.codeAt(s.body.secret) } });
  assert.strictEqual(e.status, 200, e.text);
  assert.strictEqual(e.body.recoveryCodes.length, 10);
  assert.match(e.body.recoveryCodes[0], /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  assert.strictEqual(e.body.otherSessionsEnded, 1);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: phone })).status, 401, 'the other device is out');
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: pc })).status, 200, 'this one stays in');
  const row = get('SELECT mfa_secret FROM users WHERE id = ?', id);
  assert.ok(!row.mfa_secret.includes(s.body.secret), 'the key is not stored in plain text');
});

test('with two-factor on, a right password gives a challenge — not a session', async () => {
  mkUser('bimal', ['storekeeper']);
  const { secret } = await enrol(await login('bimal'));
  const r = await loginRaw('bimal');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mfaRequired, true);
  assert.ok(r.body.challenge && r.body.challenge.length >= 64);
  assert.strictEqual(r.cookie, null, 'no cookie until the code');
  assert.strictEqual(r.body.caps, undefined, 'and nothing about the account');

  const wrong = await req('POST', '/api/auth/mfa/verify', { body: { challenge: r.body.challenge, code: '000000' } });
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual(wrong.cookie, null);
  const ok = await req('POST', '/api/auth/mfa/verify', { body: { challenge: r.body.challenge, code: nextCode(secret) } });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.ok(ok.cookie);
  assert.strictEqual(ok.body.mfaEnabled, true);
  const me = await req('GET', '/api/auth/me', { cookie: ok.cookie });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(get('SELECT mfa_verified v FROM sessions WHERE token = ?', ok.cookie.split('=')[1]).v, 1);
  assert.strictEqual((await req('POST', '/api/auth/mfa/verify', { body: { challenge: r.body.challenge, code: nextCode(secret, 1) } })).status, 401,
    'a challenge is used up by the sign-in');
});

test('the same code cannot be used twice', async () => {
  mkUser('chandra', ['storekeeper']);
  const { secret } = await enrol(await login('chandra'));
  const code = nextCode(secret);
  const a = await loginRaw('chandra');
  assert.strictEqual((await req('POST', '/api/auth/mfa/verify', { body: { challenge: a.body.challenge, code } })).status, 200);
  const b = await loginRaw('chandra');
  assert.strictEqual((await req('POST', '/api/auth/mfa/verify', { body: { challenge: b.body.challenge, code } })).status, 401,
    'a code read over a shoulder is already spent');
});

test('a recovery code signs in once', async () => {
  mkUser('dinesh', ['storekeeper']);
  const { recovery } = await enrol(await login('dinesh'));
  const a = await loginRaw('dinesh');
  const ok = await req('POST', '/api/auth/mfa/verify', { body: { challenge: a.body.challenge, code: recovery[3].toLowerCase() } });
  assert.strictEqual(ok.status, 200, 'case and the dash do not matter');
  assert.strictEqual(ok.body.recoveryCodesLeft, 9);
  const b = await loginRaw('dinesh');
  assert.strictEqual((await req('POST', '/api/auth/mfa/verify', { body: { challenge: b.body.challenge, code: recovery[3] } })).status, 401);
});

test('five wrong codes end the challenge; wrong codes count against the sign-in limit', async () => {
  ratelimit.reset();
  mkUser('eranga', ['storekeeper']);
  const { secret } = await enrol(await login('eranga'));
  const a = await loginRaw('eranga');
  let last;
  for (let i = 0; i < 5; i++) last = await req('POST', '/api/auth/mfa/verify', { body: { challenge: a.body.challenge, code: '000000' } });
  assert.strictEqual(last.body.restart, true, 'the fifth wrong code sends them back to the password');
  assert.strictEqual((await req('POST', '/api/auth/mfa/verify', { body: { challenge: a.body.challenge, code: nextCode(secret) } })).status, 401);

  // A right password does not wipe the count: keep guessing codes and the account locks.
  for (let i = 0; i < ratelimit.MAX_PER_USER; i++) {
    const c = await loginRaw('eranga');
    if (c.status === 429) break;
    await req('POST', '/api/auth/mfa/verify', { body: { challenge: c.body.challenge, code: '000000' } });
  }
  assert.strictEqual((await loginRaw('eranga')).status, 429, 'guessing codes is throttled like guessing passwords');
  ratelimit.reset();
});

test('a session made before enrolling is not honoured afterwards', async () => {
  const id = mkUser('fathima', ['storekeeper']);
  await enrol(await login('fathima'));
  const { token } = auth.createSession(id, null);   // no second factor
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: `${auth.COOKIE}=${token}` })).status, 401);
});

// ---------------------------------------------------------------- when a role requires it
test('a role that requires it holds back the API and the live feed until the person enrols', async () => {
  const admin = await login('chief');
  const on = await req('PATCH', '/api/access/roles/viewer', { cookie: admin, body: { require_mfa: true } });
  assert.strictEqual(on.status, 200, on.text);
  assert.strictEqual(on.body.require_mfa, true);

  mkUser('gayan', ['viewer']);
  const r = await loginRaw('gayan');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mfaSetupRequired, true, 'signed in, but told to enrol');
  const cookie = r.cookie;
  const held = await req('GET', '/api/projects', { cookie });
  assert.strictEqual(held.status, 428);
  assert.strictEqual(held.body.mfaSetupRequired, true);
  assert.strictEqual((await req('GET', '/uploads/anything.txt', { cookie })).status, 428);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie })).status, 200, 'the screens can still ask who they are');
  assert.strictEqual(await socketOpens(cookie), false, 'no live feed either');

  await enrol(cookie);
  assert.strictEqual((await req('GET', '/api/projects', { cookie })).status, 200, 'enrolled: in');
  assert.strictEqual(await socketOpens(cookie), true);
  const off = await req('POST', '/api/auth/mfa/disable', { cookie, body: { password: PW, code: '000000' } });
  assert.strictEqual(off.status, 403, 'and it cannot be turned off while the role requires it');
});

test('only an admin may stop a role requiring it; anyone managing roles may start it', async () => {
  run("INSERT INTO roles (name, label) VALUES ('access_admin', 'Access Admin')");
  capabilities.setCapability('access_admin', 'access.manage', true);
  mkUser('hasini', ['access_admin']);
  const h = await login('hasini');
  assert.strictEqual((await req('PATCH', '/api/access/roles/storekeeper', { cookie: h, body: { require_mfa: true } })).status, 200);
  assert.strictEqual((await req('PATCH', '/api/access/roles/storekeeper', { cookie: h, body: { require_mfa: false } })).status, 403);
  assert.strictEqual((await req('PATCH', '/api/access/roles/admin', { cookie: h, body: { require_mfa: true } })).status, 403);
  const admin = await login('chief');
  assert.strictEqual((await req('PATCH', '/api/access/roles/storekeeper', { cookie: admin, body: { require_mfa: false } })).status, 200);
  assert.strictEqual((await req('PATCH', '/api/access/roles/admin', { cookie: admin, body: { label: 'Boss' } })).status, 400,
    'the admin role still cannot be renamed');
});

// ---------------------------------------------------------------- turning off, and the ways back in
test('turning it off needs the password and a code', async () => {
  mkUser('indika', ['storekeeper']);
  const cookie = await login('indika');
  const { secret } = await enrol(cookie);
  assert.strictEqual((await req('POST', '/api/auth/mfa/disable', { cookie, body: { password: 'wrong', code: nextCode(secret) } })).status, 401);
  assert.strictEqual((await req('POST', '/api/auth/mfa/disable', { cookie, body: { password: PW, code: '000000' } })).status, 401);
  assert.strictEqual((await req('POST', '/api/auth/mfa/disable', { cookie, body: { password: PW, code: nextCode(secret) } })).status, 200);
  const r = await loginRaw('indika');
  assert.ok(r.cookie && !r.body.mfaRequired, 'a password alone again');
});

test('new recovery codes need a code from the app, and replace the old ones', async () => {
  mkUser('janaki', ['storekeeper']);
  const cookie = await login('janaki');
  const { secret, recovery } = await enrol(cookie);
  assert.strictEqual((await req('POST', '/api/auth/mfa/recovery-codes', { cookie, body: { code: recovery[0] } })).status, 401,
    'not with a recovery code');
  const r = await req('POST', '/api/auth/mfa/recovery-codes', { cookie, body: { code: nextCode(secret) } });
  assert.strictEqual(r.status, 200, r.text);
  const a = await loginRaw('janaki');
  assert.strictEqual((await req('POST', '/api/auth/mfa/verify', { body: { challenge: a.body.challenge, code: recovery[1] } })).status, 401, 'old codes are dead');
  assert.strictEqual((await req('POST', '/api/auth/mfa/verify', { body: { challenge: a.body.challenge, code: r.body.recoveryCodes[0] } })).status, 200);
});

test('an admin resets someone who lost their phone; a non-admin cannot reset an admin', async () => {
  const id = mkUser('kumari', ['storekeeper']);
  const k = await login('kumari');
  await enrol(k);
  const admin = await login('chief');
  const r = await req('POST', `/api/users/${id}/mfa-reset`, { cookie: admin });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(get('SELECT mfa_enabled e FROM users WHERE id = ?', id).e, 0);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: k })).status, 401, 'signed out');
  assert.ok((await loginRaw('kumari')).cookie, 'back to a password alone');

  run("INSERT INTO roles (name, label) VALUES ('hr_clerk', 'HR Clerk')");
  capabilities.setCapability('hr_clerk', 'users.manage', true);
  mkUser('lakmal', ['hr_clerk']);
  const l = await login('lakmal');
  assert.strictEqual((await req('POST', `/api/users/${chiefId}/mfa-reset`, { cookie: l })).status, 403);
});

test('a key that cannot be read sends the person to the admin, without counting against them', async () => {
  ratelimit.reset();
  mkUser('madu', ['storekeeper']);
  const { secret } = await enrol(await login('madu'));
  const a = await loginRaw('madu');
  process.env.MFA_SECRET_KEY = 'cd'.repeat(32); box._reset();
  try {
    const r = await req('POST', '/api/auth/mfa/verify', { body: { challenge: a.body.challenge, code: nextCode(secret) } });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /administrator to reset/);
  } finally { delete process.env.MFA_SECRET_KEY; box._reset(); }
});

test('the server command reset-mfa is the way back for the admin themselves', () => {
  const id = mkUser('nuwan', ['admin']);
  run('UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?', box.seal(totp.newSecret()), id);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'admin.js'), 'reset-mfa', 'nuwan'],
    { env: { ...process.env }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /removed for "nuwan"/);
  assert.strictEqual(get('SELECT mfa_enabled e FROM users WHERE id = ?', id).e, 0);
});

test('two-factor events are on the record', () => {
  for (const a of ['mfa_enabled', 'mfa_disabled', 'mfa_reset', 'login_mfa_failed', 'mfa_recovery_codes_renewed']) {
    assert.ok(get('SELECT 1 x FROM audit_log WHERE action = ?', a), `audited: ${a}`);
  }
});
