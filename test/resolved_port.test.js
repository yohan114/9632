'use strict';

// The launcher and the server must open the same port.
//
// start_server.bat kept its own copy of the port number and passed nothing to node, so it opened
// 1929 while the server bound 3000. It now asks scripts/resolved-port.js, which answers from
// src/config.js itself. These tests hold that contract: whatever the app would bind, the script
// prints — and when nothing is configured anywhere it prints nothing, which is the launcher's cue
// to supply this machine's own default and hand it to node.
//
// Run as a real child process against a real .env, like test/config_env.test.js, because the whole
// point is what another program sees on stdout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const REPO = path.resolve(__dirname, '..');

// A throwaway app directory holding only the two files involved, then ask it for the port.
function resolvePort({ env = null, dotenv = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-port-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'src', 'config.js'), path.join(dir, 'src', 'config.js'));
    fs.copyFileSync(path.join(REPO, 'scripts', 'resolved-port.js'), path.join(dir, 'scripts', 'resolved-port.js'));
    if (dotenv !== null) fs.writeFileSync(path.join(dir, '.env'), dotenv);
    return execFileSync(process.execPath, ['scripts/resolved-port.js'],
      { cwd: dir, encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env || {}) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('nothing configured anywhere prints nothing, so the launcher supplies its own default', () => {
  assert.strictEqual(resolvePort(), '');
});

test('PORT in .env is printed, so the launcher opens the port the server binds', () => {
  assert.strictEqual(resolvePort({ dotenv: 'PORT=1929\n' }), '1929');
});

test('PORT in the environment wins over .env, exactly as the server resolves it', () => {
  assert.strictEqual(resolvePort({ env: { PORT: '4100' }, dotenv: 'PORT=1929\n' }), '4100');
});

test('the value is read by the app’s own parser, inline comment and all', () => {
  // A naive split on "=" would hand the launcher "1929  # the office copy" and it would open
  // nothing. src/config.js stops an unquoted value at the comment; this must see the same 1929.
  assert.strictEqual(resolvePort({ dotenv: 'PORT=1929  # the office copy, see deploy/VPS.md\n' }), '1929');
});

test('a port the app cannot read falls back to the app’s default, and says so', () => {
  // PORT=abc is not a port: src/config.js falls back to 3000 and binds that, so that is what the
  // launcher must open. Silence here would send it to a different port than the server.
  assert.strictEqual(resolvePort({ dotenv: 'PORT=abc\n' }), '3000');
});
