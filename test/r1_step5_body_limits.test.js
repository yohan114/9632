'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-body-limit-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');
migrate();

// A signed-in account for the upload half of the test. The 50 MB upload limit is granted to a real
// session only (src/server.js parses bodies after authenticate), so the role must not demand
// two-factor sign-in first.
run("INSERT OR IGNORE INTO roles (name) VALUES ('admin')");
try { run("UPDATE roles SET require_mfa = 0 WHERE name = 'admin'"); } catch { /* column absent */ }
const PW = 'quarry-lantern-ember-41';
const uid = run('INSERT INTO users (username, password_hash, active, must_change_password) VALUES (?, ?, 1, 0)',
  'bodylimit_admin', auth.hashPassword(PW)).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", uid);

const app = require('../src/server');
let server;
let base;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
});

test('global request body limit is 1mb and returns 413 on non-upload routes, while upload routes permit larger bodies', async () => {
  // 1. Send a 2 MB body to an unauthenticated, non-upload route (/api/auth/login)
  const twoMbPayload = JSON.stringify({
    username: 'test',
    password: 'x'.repeat(2 * 1024 * 1024)
  });

  const resLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: twoMbPayload
  });

  assert.strictEqual(resLogin.status, 413, 'Unauthenticated 2MB payload on standard route must return 413 Payload Too Large');

  // 2. The same 2 MB body to an upload route WITHOUT a real session is refused before it is read:
  //    a made-up session cookie must not buy the 50 MB limit (it used to).
  const resFake = await fetch(`${base}/api/stores/grn/1/photos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'wo_session=made-up' },
    body: twoMbPayload
  });
  assert.strictEqual(resFake.status, 413, 'Upload routes must not accept a large body from someone who is not signed in');

  // 3. Signed in, the upload route accepts it (whatever the route then answers, it is not 413).
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bodylimit_admin', password: PW })
  });
  assert.strictEqual(login.status, 200, 'test login');
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const resUpload = await fetch(`${base}/api/stores/grn/1/photos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: twoMbPayload
  });
  assert.notStrictEqual(resUpload.status, 413, 'Upload routes must permit bodies larger than 1MB for a signed-in user');
});
