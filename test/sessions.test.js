'use strict';

// Sessions: the 12-hour limit, the idle timeout, the signed-in devices list, and signing out
// elsewhere (docs/SECURITY_ACCESS_MULTISITE_PLAN.md, Stage 1 task 7).
//
// Pins: expiry is compared as a TIME (it used to be compared as text, and a "12-hour" session lived
// until midnight UTC after it expired); idle means no INPUT, so a page refreshing itself does not
// keep a session alive; a session that is over is reported as such (X-WO-Session: ended) — but a
// wrong password on the change-password form is not; the devices list never shows a token; and
// signing out, or being signed out, also closes the live socket.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sess-'));
process.env.DB_PATH = path.join(TMP, 'sess.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.SESSION_IDLE_MINUTES = '120';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const emitter = require('../src/lib/emitter');

migrate();
for (const n of ['admin', 'storekeeper']) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
const PW = 'quarry-lantern-ember';
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

function req(method, p, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function login(username, ua) {
  const r = await req('POST', '/api/auth/login', { body: { username, password: PW }, headers: ua ? { 'User-Agent': ua } : {} });
  assert.strictEqual(r.status, 200, r.text);
  return r.cookie;
}
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
const tokenOf = (cookie) => cookie.split('=')[1];
const dbTime = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const MIN = 60000;

// ---------------------------------------------------------------- the 12-hour limit
test('an expired session is refused — expiry is compared as a time, not as text', async () => {
  mkUser('ama', ['storekeeper']);
  const c = await login('ama');
  // Exactly what createSession writes (ISO, with a T), 90 minutes in the past. As text,
  // "2026-…T…" sorts after "2026-… …" and this used to count as still valid all day.
  run('UPDATE sessions SET expires_at = ? WHERE token = ?', new Date(Date.now() - 90 * MIN).toISOString(), tokenOf(c));
  const r = await req('GET', '/api/auth/me', { cookie: c });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.headers['x-wo-session'], 'ended', 'the page is told the session is over');
});

// ---------------------------------------------------------------- idle
test('a session with no input for longer than the limit is ended, and removed', async () => {
  mkUser('bimal', ['storekeeper']);
  const c = await login('bimal');
  run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', dbTime(121 * MIN), tokenOf(c));
  const r = await req('GET', '/api/auth/me', { cookie: c });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.headers['x-wo-session'], 'ended');
  assert.match(String(r.headers['set-cookie']), /wo_session=;/, 'the browser is told to drop the dead cookie');
  assert.strictEqual(get('SELECT COUNT(*) n FROM sessions WHERE token = ?', tokenOf(c)).n, 0);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE action = 'session_idle_expired'"), 'on the record');
});

test('a page refreshing itself does not keep a session alive — only real input does', async () => {
  mkUser('chandra', ['storekeeper']);
  const c = await login('chandra');
  const t = tokenOf(c);
  // Last real input 119 minutes ago; the dashboard keeps refreshing (header: idle for 119 minutes).
  run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', dbTime(119 * MIN), t);
  const bg = await req('GET', '/api/auth/me', { cookie: c, headers: { 'X-WO-Idle-Ms': String(119 * MIN) } });
  assert.strictEqual(bg.status, 200, 'still inside the limit');
  const seen = Date.parse(get('SELECT last_seen_at s FROM sessions WHERE token = ?', t).s.replace(' ', 'T') + 'Z');
  assert.ok(Date.now() - seen > 118 * MIN, 'a background refresh did not move "last active" forward');

  // The person comes back and moves the mouse: the next request says idle 0.
  const active = await req('GET', '/api/auth/me', { cookie: c, headers: { 'X-WO-Idle-Ms': '0' } });
  assert.strictEqual(active.status, 200);
  const seen2 = Date.parse(get('SELECT last_seen_at s FROM sessions WHERE token = ?', t).s.replace(' ', 'T') + 'Z');
  assert.ok(Date.now() - seen2 < 2 * MIN, 'real input moves it to now');
});

test('a wrong password on the change-password form does not look like an ended session', async () => {
  mkUser('dinesh', ['storekeeper']);
  const c = await login('dinesh');
  const r = await req('POST', '/api/auth/change-password', { cookie: c, body: { current_password: 'wrong', new_password: 'timber-kestrel-vessel' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.headers['x-wo-session'], undefined, 'the page must not sign them out for a typo');
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: c })).status, 200);
});

test('the screens are told the idle limit', async () => {
  const c = await login('chief');
  const me = await req('GET', '/api/auth/me', { cookie: c });
  assert.deepStrictEqual(me.body.sessionPolicy, { idleMinutes: 120, ttlHours: 12 });
});

// ---------------------------------------------------------------- signed-in devices
test('the devices list shows my sessions — never a token — and marks this one', async () => {
  mkUser('eranga', ['storekeeper']);
  const pc = await login('eranga', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36');
  await login('eranga', 'Mozilla/5.0 (Linux; Android 14; SM-A155F; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36');
  await login('chief');
  const r = await req('GET', '/api/auth/sessions', { cookie: pc });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.sessions.length, 2, "only this person's sessions");
  assert.deepStrictEqual(r.body.sessions.map((x) => x.device).sort(), ['Android app on Android', 'Chrome on Windows']);
  assert.strictEqual(r.body.sessions.filter((x) => x.current).length, 1);
  assert.ok(!r.text.includes(tokenOf(pc)), 'no token anywhere in the answer');
  for (const x of r.body.sessions) assert.strictEqual(x.token, undefined);
});

test('I can sign out one other device, or all of them, but not someone else\'s', async () => {
  const uid = mkUser('fathima', ['storekeeper']);
  const a = await login('fathima');
  const b = await login('fathima');
  const c = await login('fathima');
  const other = get('SELECT id FROM sessions WHERE token = ?', tokenOf(b)).id;
  assert.strictEqual((await req('POST', `/api/auth/sessions/${other}/revoke`, { cookie: a })).status, 200);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: b })).status, 401, 'that device is out');

  const chiefSession = get('SELECT id FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1', chiefId).id;
  assert.strictEqual((await req('POST', `/api/auth/sessions/${chiefSession}/revoke`, { cookie: a })).status, 404, 'not someone else\'s');

  const all = await req('POST', '/api/auth/sessions/revoke-others', { cookie: a });
  assert.strictEqual(all.body.ended, 1);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: c })).status, 401);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: a })).status, 200, 'this one stays');
  assert.strictEqual(get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', uid).n, 1);
});

test('an admin can see and end a person\'s sessions; a non-admin cannot do it to an admin', async () => {
  const uid = mkUser('gayan', ['storekeeper']);
  const g = await login('gayan');
  mkUser('warden', ['admin']);
  const admin = secondFactorOn(await login('warden'));
  const list = await req('GET', `/api/users/${uid}/sessions`, { cookie: admin });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.sessions.length, 1);
  const end = await req('POST', `/api/users/${uid}/sessions/revoke`, { cookie: admin });
  assert.strictEqual(end.body.ended, 1);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: g })).status, 401);

  run("INSERT INTO roles (name, label) VALUES ('hr_clerk', 'HR Clerk')");
  capabilities.setCapability('hr_clerk', 'users.manage', true);
  mkUser('hasini', ['hr_clerk']);
  const h = secondFactorOn(await login('hasini'));
  assert.strictEqual((await req('GET', `/api/users/${chiefId}/sessions`, { cookie: h })).status, 403);
  assert.strictEqual((await req('POST', `/api/users/${chiefId}/sessions/revoke`, { cookie: h })).status, 403);
});

// ---------------------------------------------------------------- the live socket
async function socketFor(cookie) {
  const q = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`;
  const headers = { cookie };
  const open = await (await fetch(q, { headers })).text();
  const sid = (open.match(/"sid"\s*:\s*"([^"]+)"/) || [])[1];
  await fetch(`${q}&sid=${sid}`, { method: 'POST', headers, body: '40' });
  const reply = await (await fetch(`${q}&sid=${sid}`, { headers })).text();
  return { sid, q, headers, opened: /(^|\x1e)40[{[]/.test(reply) };
}

test('signing a session out also closes its live socket', async () => {
  mkUser('indika', ['storekeeper']);
  const c = await login('indika');
  const s = await socketFor(c);
  assert.ok(s.opened, 'the socket opened');
  assert.ok([...app.io.of('/').sockets.values()].some((x) => x.data.token === tokenOf(c)));

  const sid = get('SELECT id FROM sessions WHERE token = ?', tokenOf(c)).id;
  await req('POST', `/api/auth/sessions/${sid}/revoke`, { cookie: c });
  await new Promise((r) => setTimeout(r, 50));   // the sweep runs on the next tick
  assert.ok(![...app.io.of('/').sockets.values()].some((x) => x.data.token === tokenOf(c)),
    'no socket is left listening on a session that is over');
});

test('an idle session loses its socket at the next sweep', async () => {
  mkUser('janaki', ['storekeeper']);
  const c = await login('janaki');
  assert.ok((await socketFor(c)).opened);
  run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', dbTime(121 * MIN), tokenOf(c));
  emitter.emit('sessions_changed', {});
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(![...app.io.of('/').sockets.values()].some((x) => x.data.token === tokenOf(c)));
});
