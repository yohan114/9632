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
run("INSERT OR IGNORE INTO roles (name) VALUES ('admin')");
const uid = run("INSERT INTO users (username, password_hash, active) VALUES ('limit_tester', ?, 1)", auth.hashPassword('pw')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))", uid);

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'limit_tester', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('global request body limit is 1mb and returns 413 on non-upload routes, while authenticated upload routes permit larger bodies', async () => {
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

  // 2. Unauthenticated 2 MB body even on upload route must return 413 (DoS prevention)
  const resUnauthUpload = await fetch(`${base}/api/stores/grn/1/photos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: twoMbPayload
  });
  assert.strictEqual(resUnauthUpload.status, 413, 'Unauthenticated upload payload > 1MB must return 413');

  // 3. Authenticated 2 MB body on upload route (/api/stores/grn/1/photos) must NOT be rejected with 413
  const resUpload = await fetch(`${base}/api/stores/grn/1/photos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: twoMbPayload
  });

  assert.notStrictEqual(resUpload.status, 413, 'Authenticated upload routes must permit bodies larger than 1MB');
});
