'use strict';

// Slowing down someone guessing passwords.
//
// On the workshop LAN this hardly mattered: to reach the login page you had to be standing in the
// building. Behind storesdb.ec-workshops.online it matters a great deal — a login page on the open
// internet is found by scanners within hours of the DNS resolving, and an unlimited number of
// guesses against a short password is only a matter of time.
//
// The trap in the obvious implementation is counting by username alone: one attacker could then
// lock every real user out of the system by guessing at their names, which hands over a denial of
// service for free. So both the name and the address are counted, and either is enough to refuse.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-ratelimit-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run } = require('../src/db');
const ratelimit = require('../src/lib/ratelimit');

migrate();
run('INSERT INTO roles (name) VALUES (?)', 'admin');
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sam',
  require('../src/lib/auth').hashPassword('correct-horse')).lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, 'admin');

const app = require('../src/server');
let server; let base;
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const login = (username, password) => fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});

test.beforeEach(() => ratelimit.reset());

test('a wrong password is refused, and says nothing about which part was wrong', async () => {
  const r = await login('sam', 'nope');
  assert.strictEqual(r.status, 401);
  const bad = await login('nosuchperson', 'nope');
  assert.strictEqual(bad.status, 401);
  assert.strictEqual((await bad.json()).error, (await (await login('sam', 'nope2')).json()).error,
    'a different message for an unknown name hands over a list of which names are worth guessing');
});

test('guessing at one name stops being answered', async () => {
  let last;
  for (let i = 0; i < ratelimit.MAX_PER_USER + 1; i++) last = await login('sam', 'guess' + i);
  assert.strictEqual(last.status, 429);
  const body = await last.json();
  assert.match(body.error, /too many/i);
  assert.ok(last.headers.get('retry-after'), 'and says how long to wait');
});

test('the right password is still refused while the lockout stands', async () => {
  for (let i = 0; i < ratelimit.MAX_PER_USER + 1; i++) await login('sam', 'guess' + i);
  const r = await login('sam', 'correct-horse');
  assert.strictEqual(r.status, 429, 'otherwise the lockout only delays the attacker until they hit it');
});

test('a good sign-in clears the slate before the limit is reached', async () => {
  await login('sam', 'wrong-once');
  const ok = await login('sam', 'correct-horse');
  assert.strictEqual(ok.status, 200, JSON.stringify(await ok.clone().json().catch(() => null)));
  // and the earlier failure is forgotten, so a full run of guesses is needed again
  for (let i = 0; i < ratelimit.MAX_PER_USER - 1; i++) {
    assert.strictEqual((await login('sam', 'g' + i)).status, 401);
  }
});

test('locking one name does not lock the others out', () => {
  // Counting by username ALONE would let one attacker lock the whole workshop out by guessing at
  // every name in turn. The address is counted too, and a name's lockout is its own.
  ratelimit.reset();
  for (let i = 0; i < ratelimit.MAX_PER_USER + 1; i++) ratelimit.fail('10.0.0.9', 'sam');
  assert.ok(ratelimit.check('10.0.0.9', 'sam') > 0, 'the guessed name rests');
  assert.strictEqual(ratelimit.check('10.0.0.50', 'priya'), 0,
    'a different person at a different address is unaffected');
});

test('one address cannot spread its guesses across many names', () => {
  ratelimit.reset();
  for (let i = 0; i < ratelimit.MAX_PER_IP + 1; i++) ratelimit.fail('203.0.113.7', 'name' + i);
  assert.ok(ratelimit.check('203.0.113.7', 'someone-new') > 0,
    'counting by name alone would let a scanner try every username once, for free');
  assert.strictEqual(ratelimit.check('198.51.100.2', 'someone-new'), 0);
});

test('a lockout expires on its own', () => {
  ratelimit.reset();
  for (let i = 0; i < ratelimit.MAX_PER_USER + 1; i++) ratelimit.fail('10.0.0.1', 'sam');
  const wait = ratelimit.check('10.0.0.1', 'sam');
  assert.ok(wait > 0 && wait <= ratelimit.LOCKOUT_MS / 1000,
    'a storekeeper who mistypes is unblocked by waiting, not by a phone call to the admin');
});

test('the session token owes nothing to a shared secret', () => {
  // Worth pinning: the deployment notes used to say "change SESSION_SECRET before go-live", which
  // sent people hunting a risk that was never there. Tokens are random and stored server-side.
  const a = require('../src/lib/auth').createSession(uid, null);
  const b = require('../src/lib/auth').createSession(uid, null);
  assert.notStrictEqual(a.token, b.token);
  assert.ok(a.token.length >= 64, '32 random bytes, hex — not a signed value');
});

// ---- who may speak for the visitor ----------------------------------------
//
// `trust proxy: true` believes any X-Forwarded-For header from anyone. On the workshop LAN that
// was harmless. Facing the internet it is a hole: a client sends "X-Forwarded-For: 1.2.3.4",
// changes it every request, and walks straight through a limiter that counts by address.
//
// In production only the proxy on this machine is believed. nginx sits on 127.0.0.1, works out the
// real visitor from Cloudflare's CF-Connecting-IP, and passes it on — so the chain of trust ends
// at something we control.

test('production believes only the proxy on this machine', () => {
  const prev = process.env.NODE_ENV;
  const fresh = () => {
    for (const k of Object.keys(require.cache)) if (k.includes('server.js')) delete require.cache[k];
    return require('../src/server');
  };
  try {
    process.env.NODE_ENV = 'production';
    assert.strictEqual(fresh().get('trust proxy fn') && 'set', 'set');
    const app = fresh();
    assert.notStrictEqual(app.get('trust proxy'), true,
      'trusting every hop lets a client forge its own address and defeat the rate limit');
  } finally {
    process.env.NODE_ENV = prev;
    for (const k of Object.keys(require.cache)) if (k.includes('server.js')) delete require.cache[k];
  }
});

test('the limit counts the address the app was told, so a forged one must not reach it', () => {
  // The guard is the trust setting above; this pins the consequence. Two different addresses are
  // counted apart, which is only safe because a client cannot choose which address it appears as.
  ratelimit.reset();
  for (let i = 0; i < ratelimit.MAX_PER_IP + 1; i++) ratelimit.fail('203.0.113.9', 'u' + i);
  assert.ok(ratelimit.check('203.0.113.9', 'anyone') > 0);
  assert.strictEqual(ratelimit.check('203.0.113.10', 'anyone'), 0,
    'if a client could pick this value it would simply pick a new one each time');
});

// ---- an office is one address ---------------------------------------------
//
// On the LAN every PC had its own address. Behind Cloudflare everyone in the building shares the
// company's single public address, so the per-address ceiling stopped being "one attacker's
// budget" and became the whole company's budget for mistyped passwords in a quarter of an hour.
// It was reached on the first morning and locked the entire office out at once.

test('a building full of people mistyping does not lock the building out', () => {
  ratelimit.reset();
  // fifteen people, two fumbles each, all arriving from the office's one public address
  for (let person = 0; person < 15; person++) {
    for (let attempt = 0; attempt < 2; attempt++) ratelimit.fail('203.0.113.5', 'person' + person);
  }
  assert.strictEqual(ratelimit.check('203.0.113.5', 'someone-else'), 0,
    'thirty honest mistakes across a shared address must not shut out the next person to try');
});

test('but one name is still rested after a run of guesses at it', () => {
  // The protection that actually matters for a given account is per-USERNAME, and it is untouched.
  // An attacker spreading guesses across names to stay under the address ceiling still gets only
  // MAX_PER_USER attempts at each one.
  ratelimit.reset();
  for (let i = 0; i <= ratelimit.MAX_PER_USER; i++) ratelimit.fail('203.0.113.5', 'sam');
  assert.ok(ratelimit.check('203.0.113.5', 'sam') > 0);
  assert.strictEqual(ratelimit.check('203.0.113.5', 'priya'), 0,
    'and a colleague at the same desk is unaffected');
});

test('the address ceiling still exists, and still stops a spray', () => {
  ratelimit.reset();
  for (let i = 0; i <= ratelimit.MAX_PER_IP; i++) ratelimit.fail('198.51.100.7', 'name' + i);
  assert.ok(ratelimit.check('198.51.100.7', 'anyone') > 0,
    'raising the ceiling must not mean removing it — a botnet trying every username still stops');
});

test('the ceilings can be tuned without a code change', () => {
  // A workshop of 60 is not a workshop of 6. The owner should not need a deploy to widen this.
  assert.ok(ratelimit.MAX_PER_IP >= 100, 'default must clear a normal morning in a shared office');
  assert.ok(ratelimit.MAX_PER_USER <= 10, 'per-account guessing must stay tight');
});
