'use strict';

// Who is allowed to open a live socket.
//
// The socket carries everything the workshop does — stock movements, job updates, requests as they
// are raised. On the LAN, an unauthenticated listener was theoretical. Behind a public domain it is
// not, and the `cors` option is NOT the thing that stops it: browsers do not apply the same-origin
// rules to WebSocket connections, so an `origin` pin is bypassed the moment the transport upgrades.
// The session cookie is what actually decides.
//
// Driven with plain fetch rather than socket.io-client, which is not a dependency here.
//
// One thing to know before reading `connect()` below, because it caught me out while writing this:
// the engine.io transport handshake is NOT authenticated and always returns a sid. io.use() runs a
// step later, when the client asks to join the namespace. A test that only checks the reply to the
// first request will pass against a completely open server.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-socketauth-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
run('INSERT INTO roles (name) VALUES (?)', 'admin');
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)',
  'sam', auth.hashPassword('correct-horse')).lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, 'admin');

const app = require('../src/server');
let server; let base;
test.before(async () => {
  await new Promise((res) => { server = app.httpServer.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

// A full socket.io connect over the polling transport, in the three steps the browser client
// performs. Worth spelling out, because only the third one is authenticated:
//
//   1. engine.io opens a TRANSPORT and returns a sid. No middleware runs here — this always
//      succeeds, which is why checking the reply to step 1 proves nothing at all.
//   2. the client asks to join the socket.io NAMESPACE by sending a "40" packet.
//   3. the server replies "40{...}" if io.use() let it through, or "44{...}" if it did not.
async function connect(cookie) {
  const headers = cookie ? { cookie } : {};
  const q = `${base}/socket.io/?EIO=4&transport=polling`;

  const open = await (await fetch(q, { headers })).text();
  const sid = (open.match(/"sid"\s*:\s*"([^"]+)"/) || [])[1];
  assert.ok(sid, `engine.io did not open a transport: ${open.slice(0, 160)}`);

  await fetch(`${q}&sid=${sid}`, { method: 'POST', headers, body: '40' });
  const reply = await (await fetch(`${q}&sid=${sid}`, { headers })).text();
  return { sid, body: reply };
}

// "40" = namespace joined. "44" = connect_error, carrying the middleware's message.
const opened = (body) => /(^|\x1e)40[{[]/.test(body) || /(^|\x1e)40$/.test(body);

test('a socket with no session cookie is refused', async () => {
  const { body } = await connect(null);
  assert.ok(!opened(body), `an anonymous socket was allowed to open: ${body.slice(0, 200)}`);
  assert.match(body, /unauthorized/,
    'the reason must be "unauthorized" — the browser client reads it to tell "not signed in" ' +
    '(stop retrying) from "server down" (keep retrying)');
});

test('a socket with a junk token is refused', async () => {
  const { body } = await connect(`${auth.COOKIE}=not-a-real-token`);
  assert.ok(!opened(body), 'a forged cookie value opened a socket');
});

test('a signed-in session opens a socket', async () => {
  const { token } = auth.createSession(uid, null);
  const { body } = await connect(`${auth.COOKIE}=${token}`);
  assert.ok(opened(body), `a valid session was refused: ${body.slice(0, 200)}`);
});

test('the cookie is found among others, and matched by exact name', async () => {
  const { token } = auth.createSession(uid, null);
  const ok = await connect(`theme=dark; ${auth.COOKIE}=${token}; other=1`);
  assert.ok(opened(ok.body), 'must find the session cookie when it is not the only one');

  // A cookie whose name merely ENDS WITH the real one must not be accepted as it.
  const near = await connect(`not_${auth.COOKIE}=${token}`);
  assert.ok(!opened(near.body), 'matched a cookie by suffix rather than by name');
});

test('an expired session cannot open a socket', async () => {
  const { token } = auth.createSession(uid, null);
  run("UPDATE sessions SET expires_at = datetime('now', '-1 hour') WHERE token = ?", token);
  const { body } = await connect(`${auth.COOKIE}=${token}`);
  assert.ok(!opened(body), 'an expired session is still a session row; it must not be honoured');
});

test('a deactivated user cannot open a socket, even holding a live session', async () => {
  // Deactivating someone has to take effect on the socket too, or they keep receiving the
  // workshop's traffic until their session happens to expire.
  const { token } = auth.createSession(uid, null);
  run('UPDATE users SET active = 0 WHERE id = ?', uid);
  const { body } = await connect(`${auth.COOKIE}=${token}`);
  run('UPDATE users SET active = 1 WHERE id = ?', uid);
  assert.ok(!opened(body), 'a deactivated account kept its live feed');
});

test('logging out closes the door', async () => {
  const { token } = auth.createSession(uid, null);
  auth.destroySession(token);
  const { body } = await connect(`${auth.COOKIE}=${token}`);
  assert.ok(!opened(body), 'the session was destroyed but its socket still opened');
});
