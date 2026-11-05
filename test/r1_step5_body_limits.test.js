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

const { migrate } = require('../src/db');
migrate();

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

  // 2. Send the same 2 MB body to an upload route (/api/stores/grn/1/photos)
  const resUpload = await fetch(`${base}/api/stores/grn/1/photos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: twoMbPayload
  });

  // Should NOT be rejected with 413 (it will be 401 unauthenticated, proving the body parser did not reject it)
  assert.notStrictEqual(resUpload.status, 413, 'Upload routes must permit bodies larger than 1MB');
});
