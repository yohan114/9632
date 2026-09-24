'use strict';

// Starts, stops and crashes are written to a log file, and a crash ends the process
// (src/lib/lifecycle.js). Each case runs in a child process, because the point is what happens to
// a process that crashes.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const LIB = path.join(__dirname, '..', 'src', 'lib', 'lifecycle.js').replace(/\\/g, '/');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-life-'));

// Run a small script that installs the handlers and then does `body`.
function child(name, body) {
  const file = path.join(TMP, `${name}.log`).replace(/\\/g, '/');
  const marker = path.join(TMP, `${name}.stopped`).replace(/\\/g, '/');
  const src = `require('${LIB}').install({ file: '${file}', onStop: () => require('fs').writeFileSync('${marker}', 'x') });\n${body}`;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 20000 });
  return { status: r.status, stderr: r.stderr, log: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', stopped: fs.existsSync(marker) };
}

test('an uncaught exception is written to the log with its stack, and the process exits with 1', () => {
  const r = child('uncaught', "setTimeout(() => { throw new Error('boom in a timer'); }, 10); setInterval(() => {}, 1000);");
  assert.strictEqual(r.status, 1, 'it does not carry on half-broken');
  assert.match(r.log, /STARTED — node v/);
  assert.match(r.log, /CRASHED — uncaught exception: Error: boom in a timer\n\s+at /, 'the full stack is kept');
  assert.match(r.log, /EXIT code 1/);
  assert.match(r.stderr, /CRASHED/, 'and it is printed to the window too');
});

test('an unhandled promise rejection is a crash as well', () => {
  const r = child('rejection', "Promise.reject(new Error('lost promise')); setInterval(() => {}, 1000);");
  assert.strictEqual(r.status, 1);
  assert.match(r.log, /CRASHED — unhandled promise rejection: Error: lost promise/);
});

test('a normal exit is logged as an exit, not a crash', () => {
  const r = child('clean', 'setTimeout(() => {}, 10);');
  assert.strictEqual(r.status, 0);
  assert.match(r.log, /STARTED/);
  assert.match(r.log, /EXIT code 0/);
  assert.doesNotMatch(r.log, /CRASHED/);
});

test('a stop signal is logged with its reason, closes down cleanly and exits with 0', { skip: process.platform === 'win32' && 'Windows cannot deliver SIGTERM to a handler from here' }, () => {
  const r = child('signal', "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50); setInterval(() => {}, 1000);");
  assert.strictEqual(r.status, 0);
  assert.match(r.log, /STOPPED — asked to stop/);
  assert.ok(r.stopped, 'onStop ran (the database is closed there)');
});

test('a run killed by force is named as such at the next start', async () => {
  const file = path.join(TMP, 'forced.log').replace(/\\/g, '/');
  const src = `require('${LIB}').install({ file: '${file}' }); setInterval(() => {}, 1000);`;
  const p = spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(fs.existsSync(file) && /STARTED/.test(fs.readFileSync(file, 'utf8'))); i++) await new Promise((r) => setTimeout(r, 100));
  p.kill('SIGKILL');                       // no handler can run: exactly Task Manager / a power cut
  await new Promise((r) => p.on('exit', r));
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /EXIT code/, 'a forced kill leaves no last line');

  spawnSync(process.execPath, ['-e', `require('${LIB}').install({ file: '${file}' });`], { timeout: 20000 });
  const log = fs.readFileSync(file, 'utf8');
  assert.match(log, new RegExp(`NOTE — the previous run \\(pid ${p.pid}\\) ended with no stop or crash recorded: it was closed by force`));
  // …and a run that ended normally is not flagged.
  spawnSync(process.execPath, ['-e', `require('${LIB}').install({ file: '${file}' });`], { timeout: 20000 });
  assert.strictEqual((fs.readFileSync(file, 'utf8').match(/NOTE —/g) || []).length, 1);
});

test('the real server writes its start to the log; loading it in a test does not install anything', async () => {
  const log = path.join(TMP, 'server.log');
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: path.join(TMP, 'srv.db'), BACKUP_DIR: path.join(TMP, 'bk'), BACKUP_INTERVAL_MINUTES: '0',
      PORT: '0', HOST: '127.0.0.1', CRASH_LOG: log, NODE_ENV: '' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100 && !(fs.existsSync(log) && /STARTED/.test(fs.readFileSync(log, 'utf8'))); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(fs.readFileSync(log, 'utf8'), /STARTED — node v/);
  } finally { proc.kill(); }

  const before = process.listenerCount('uncaughtException');
  process.env.DB_PATH = path.join(TMP, 'inproc.db');
  process.env.BACKUP_INTERVAL_MINUTES = '0';
  require('../src/server');
  assert.strictEqual(process.listenerCount('uncaughtException'), before, 'a test that loads the server keeps its own error handling');
});
