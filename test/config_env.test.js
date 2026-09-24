'use strict';

// How a hand-edited .env is read.
//
// This is deployment plumbing, not business logic, but it earned a test file on the VPS cut-over:
// a mis-parsed .env sent the app to a brand-new empty database, and the only symptom was that
// every correct password came back "incorrect". Nothing in the logs distinguished that from a
// forgotten password, and it cost an hour.
//
// The loader is exercised through a real child process against a real file, because the bug lived
// in the interaction between .env.example's contents and what a person types underneath them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const REPO = path.resolve(__dirname, '..');

// Build a throwaway app directory holding only src/config.js and a .env, then ask it what it read.
function resolveEnv(envContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-env-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'src', 'config.js'), path.join(dir, 'src', 'config.js'));
    fs.writeFileSync(path.join(dir, '.env'), envContents);
    const out = execFileSync(process.execPath, ['-e',
      'const c = require("./src/config");' +
      'console.log(JSON.stringify({ host: c.host, dbPath: c.dbPath, port: c.port, ttl: c.sessionTtlHours, origin: process.env.PUBLIC_ORIGIN || null }));'],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
    return JSON.parse(out.trim().split(/\r?\n/).pop());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an unquoted value stops at an inline comment', () => {
  const r = resolveEnv('HOST=127.0.0.1        # nginx reaches it; the internet does not\n');
  assert.strictEqual(r.host, '127.0.0.1',
    'keeping the comment in the value means the app cannot bind, with no useful error');
});

test('a value may still contain a # if it is quoted', () => {
  const r = resolveEnv('HOST="10.0.0.1#7"\n');
  assert.strictEqual(r.host, '10.0.0.1#7', 'quoting is the escape hatch; do not strip inside it');
});

test('a # with no space before it is part of the value', () => {
  // Only whitespace-then-# starts a comment, matching dotenv. Otherwise a password or a URL
  // fragment would be quietly truncated.
  const r = resolveEnv('HOST=10.0.0.1#7\n');
  assert.strictEqual(r.host, '10.0.0.1#7');
});

test('the LAST setting of a key wins, not the first', () => {
  // The whole VPS failure. The runbook said to copy .env.example and add your settings; appending
  // below the example's own HOST/DB_PATH left the EXAMPLE's values in force.
  const r = resolveEnv([
    'HOST=0.0.0.0',
    'DB_PATH=./data/workshopone.db',
    '',
    '# ---- what the operator added underneath ----',
    'HOST=127.0.0.1',
    'DB_PATH=/opt/workshopone/data/workshopone.db',
  ].join('\n'));
  assert.strictEqual(r.host, '127.0.0.1',
    'first-wins silently binds the public interface after someone typed 127.0.0.1');
  // Compared by suffix: an absolute POSIX path resolves against whichever drive is current on
  // Windows, so the letter is noise. What matters is that it is NOT the ./data path beside the app.
  assert.match(r.dbPath.replace(/\\/g, '/'), /\/opt\/workshopone\/data\/workshopone\.db$/,
    'first-wins opens a NEW EMPTY database beside the code — every login then fails as "incorrect"');
});

test('a duplicated key is announced, because someone typed a value they are not getting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-env-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'src', 'config.js'), path.join(dir, 'src', 'config.js'));
    fs.writeFileSync(path.join(dir, '.env'), 'HOST=0.0.0.0\nHOST=127.0.0.1\n');
    const res = require('child_process').spawnSync(process.execPath,
      ['-e', 'require("./src/config")'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.match(res.stderr, /HOST/, 'the warning must name the key');
    assert.match(res.stderr, /more than once/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real environment still beats the file', () => {
  // Containers and systemd set variables directly; that has to keep winning, and it is why the
  // systemd unit must not carry a HOST= line (see deploy/workshopone.service).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-env-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'src', 'config.js'), path.join(dir, 'src', 'config.js'));
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
    const out = execFileSync(process.execPath,
      ['-e', 'console.log(require("./src/config").port)'],
      { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, PORT: '4321' } });
    assert.strictEqual(out.trim(), '4321');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blank lines, full-line comments and a missing file are all harmless', () => {
  const r = resolveEnv('\n# a comment\n\n   \nSESSION_TTL_HOURS=9\nnot-a-pair\n');
  assert.strictEqual(r.ttl, 9);
});
