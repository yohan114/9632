'use strict';

// Access plan, Part 2 — access person by person.
//
//   Five levels: none < view < add < edit < full. View reads; Add also adds new records (a POST);
//   Edit also changes and removes them (PUT, PATCH, DELETE, and the POSTs that change a record);
//   Full is everything. A role is the starting template: on any section switch a person can be
//   given a level of their own, more or less than their roles give. The rules: only what you hold
//   yourself, only for someone whose access is within yours, never an admin's, never your own.
//   With no levels of their own, everybody has exactly what their roles give (day one).

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-accppl-'));
process.env.DB_PATH = path.join(TMP, 'ap.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');

migrate();
const BUILT_IN = Object.keys(perms.DEFAULT_MATRIX);
for (const n of ['admin', ...BUILT_IN]) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
capabilities.seedCapabilities();
perms.seedDefaults();
// A deputy who manages access, with a narrow reach of their own; a helper whose access is within it;
// and a role that opens nothing.
function role(name, levels, caps = []) {
  run('INSERT INTO roles (name, label) VALUES (?, ?)', name, name);
  for (const m of perms.MODULE_KEYS) perms.setPermission(name, m, levels[m] || 'none');
  for (const c of caps) capabilities.setCapability(name, c, true);
}
role('deputy', { jobs: 'edit', stores: 'view', reports: 'full' }, ['access.manage']);
role('helper', { jobs: 'view' });
role('blank', {});

const PW = 'copper-lantern-gravel';
const U = {};
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active, full_name) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), username.toUpperCase()).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  U[username] = id;
  return id;
}
mkUser('boss', ['admin']); mkUser('boss2', ['admin']); mkUser('dep', ['deputy']); mkUser('help', ['helper']);
mkUser('ws', ['workshop']); mkUser('sk', ['storekeeper']); mkUser('vw', ['viewer']); mkUser('nob', ['blank']);
for (const r of BUILT_IN) mkUser('u_' + r, [r]);

// ---- the server -----------------------------------------------------------------------------------
const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
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
        resolve({ status: res.statusCode, body: json, text: buf });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    cookies[user] = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ username: user, password: PW });
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
      });
      q.on('error', reject); q.write(data); q.end();
    });
    secondFactorOn(cookies[user]);
  }
  return cookies[user];
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

const call = async (user, method, p, body) => req(method, '/api' + p, { cookie: await as(user), body });
const setLevel = (actor, who, module, level) => call(actor, 'PUT', `/access/people/${U[who]}/levels`, { module, level });
const me = async (user) => (await call(user, 'GET', '/auth/me')).body.permissions;
const forced = (who, module, level) => perms.setPersonal(U[who], module, level, U.boss);   // as an admin would, for set-up

// ================================================================== day one
test('day one: with no levels of their own, everybody has exactly their roles\' levels', async () => {
  assert.deepStrictEqual(perms.LEVELS, ['none', 'view', 'add', 'edit', 'full']);
  for (const r of BUILT_IN) {
    const mine = await me('u_' + r);
    assert.deepStrictEqual(mine, perms.userPermissions([r]), `${r}: the same as the role`);
  }
  assert.strictEqual(get('SELECT COUNT(*) n FROM user_permissions').n, 0);
});

// ================================================================== the five levels
test('Add adds new records; changing one needs Edit', async () => {
  forced('nob', 'services', 'add');
  forced('nob', 'filters', 'add');
  try {
    assert.strictEqual((await call('nob', 'GET', '/filters/services')).status, 200, 'add reads');
    assert.notStrictEqual((await call('nob', 'POST', '/filters/services', {})).status, 403, 'add creates a service record');
    assert.strictEqual((await call('nob', 'PUT', '/filters/services/1', {})).status, 403, 'but does not change one');
    assert.notStrictEqual((await call('nob', 'POST', '/filters/xref', {})).status, 403, 'add creates a cross-reference');
    assert.strictEqual((await call('nob', 'POST', '/filters/prices', { filter_no: 'X1' })).status, 403, 'setting a price is a change: edit');
    forced('nob', 'filters', 'edit');
    assert.notStrictEqual((await call('nob', 'POST', '/filters/prices', { filter_no: 'X1' })).status, 403);
    // The other POSTs that change a record.
    forced('nob', 'purchasing', 'add'); forced('nob', 'tyrebattery', 'add'); forced('nob', 'stores', 'add');
    assert.strictEqual((await call('nob', 'POST', '/purchasing/lines/1/source', {})).status, 403);
    assert.strictEqual((await call('nob', 'POST', '/purchasing/lines/1/purchase', {})).status, 403);
    assert.strictEqual((await call('nob', 'POST', '/tyre-battery/prices', { kind: 'tyre', prices: [] })).status, 403);
    assert.strictEqual((await call('nob', 'POST', '/stores/counts/1/cancel', {})).status, 403);
    assert.strictEqual((await call('nob', 'POST', '/stores/disposals/1/cancel', {})).status, 403);
    // View reads, and adds nothing.
    forced('nob', 'filters', 'view');
    assert.strictEqual((await call('nob', 'GET', '/filters/prices')).status, 200);
    assert.strictEqual((await call('nob', 'POST', '/filters/xref', {})).status, 403);
  } finally { run('DELETE FROM user_permissions WHERE user_id = ?', U.nob); }
  assert.strictEqual(perms.needFor('GET'), 'view');
  assert.strictEqual(perms.needFor('POST'), 'add');
  assert.deepStrictEqual(['PUT', 'PATCH', 'DELETE'].map(perms.needFor), ['edit', 'edit', 'edit']);
});

test('a role can be given Add on the Clearance Board too', async () => {
  const r = await call('boss', 'POST', '/access/matrix', { role: 'helper', module: 'field', level: 'add' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(perms.levelForRoles(['helper'], 'field'), 'add');
  perms.setPermission('helper', 'field', 'none');
});

// ================================================================== a person's own level
test('a person\'s own level replaces the role\'s — more or less — from their next click', async () => {
  assert.strictEqual((await me('ws')).jobs, 'edit');
  assert.strictEqual((await setLevel('boss', 'ws', 'jobs', 'none')).status, 200);
  assert.strictEqual((await me('ws')).jobs, 'none', 'less than the role');
  assert.strictEqual((await call('ws', 'GET', '/jobs')).status, 403, 'and the server agrees');
  assert.strictEqual((await setLevel('boss', 'ws', 'jobs', null)).status, 200);
  assert.strictEqual((await me('ws')).jobs, 'edit', 'cleared: the role again');
  assert.strictEqual((await call('vw', 'GET', '/stores/mrn')).status, 200);
  assert.strictEqual((await call('vw', 'POST', '/stores/counts/1/cancel', {})).status, 403);
  assert.strictEqual((await setLevel('boss', 'vw', 'stores', 'edit')).status, 200);
  assert.strictEqual((await me('vw')).stores, 'edit', 'more than the role');
  assert.notStrictEqual((await call('vw', 'POST', '/stores/counts/1/cancel', {})).status, 403);
  // A level opens the section; the actions inside still need their permissions.
  assert.strictEqual((await call('vw', 'POST', '/stores/mrn', { lines: [] })).status, 403);
  await setLevel('boss', 'vw', 'stores', null);
  // An admin is always full, whatever is stored.
  forced('boss2', 'jobs', 'none');
  assert.strictEqual((await me('boss2')).jobs, 'full');
  run('DELETE FROM user_permissions WHERE user_id = ?', U.boss2);
});

// ================================================================== the People screen
test('the People list and one person\'s access, for whoever manages access', async () => {
  assert.strictEqual((await call('ws', 'GET', '/access/people')).status, 403);
  await setLevel('boss', 'help', 'reports', 'view');
  const list = (await call('boss', 'GET', '/access/people')).body;
  const h = list.find((p) => p.id === U.help);
  assert.deepStrictEqual([h.roles, h.own_levels, h.self], [['helper'], 1, false]);
  assert.strictEqual(list.find((p) => p.id === U.boss).self, true);
  const d = (await call('boss', 'GET', `/access/people/${U.help}`)).body;
  assert.deepStrictEqual([d.role_levels.jobs, d.role_levels.reports, d.personal.reports.level, d.personal.reports.set_by_name, d.effective.reports],
    ['view', 'none', 'view', 'BOSS', 'view']);
  assert.strictEqual(d.sections.length, 22);
  assert.deepStrictEqual([d.can.edit, d.can.reason, d.can.max.stores], [true, null, 'full']);
  const byDep = (await call('dep', 'GET', `/access/people/${U.help}`)).body;
  assert.deepStrictEqual([byDep.can.edit, byDep.can.max.stores, byDep.can.max.reports, byDep.can.max.oil], [true, 'view', 'full', 'none'],
    'the most the deputy may give: their own');
  const own = (await call('boss', 'GET', `/access/people/${U.boss}`)).body;
  assert.deepStrictEqual([own.can.edit, own.can.reason], [false, 'You cannot change your own access. Ask another manager or an admin.']);
  await setLevel('boss', 'help', 'reports', null);
});

// ================================================================== the rules
test('nobody changes their own access — not even an admin', async () => {
  for (const [who, mod] of [['boss', 'jobs'], ['dep', 'reports']]) {
    assert.strictEqual((await setLevel(who, who, mod, 'view')).status, 403, who);
    assert.strictEqual((await call(who, 'POST', `/access/people/${U[who]}/reset`, {})).status, 403);
    assert.strictEqual((await call(who, 'POST', `/access/people/${U[who]}/copy`, { from: U.sk })).status, 403);
  }
  assert.strictEqual((await call('boss', 'POST', `/users/${U.boss}/roles`, { roles: ['admin', 'viewer'] })).status, 403, 'nor their own roles');
  assert.strictEqual((await call('boss2', 'POST', `/users/${U.boss}/roles`, { roles: ['admin', 'viewer'] })).status, 200, 'another admin may');
  assert.strictEqual((await call('boss2', 'POST', `/users/${U.boss}/roles`, { roles: ['admin'] })).status, 200);
});

test('an admin always has full access: nothing to set', async () => {
  const r = await setLevel('boss', 'boss2', 'jobs', 'none');
  assert.deepStrictEqual([r.status, r.body.error], [403, 'An admin always has full access to everything.']);
});

test('you can only give up to your own level, and only to someone within your own access', async () => {
  // The deputy: jobs edit, stores view, reports full. The helper (jobs view) is within that.
  assert.strictEqual((await setLevel('dep', 'help', 'jobs', 'edit')).status, 200);
  assert.strictEqual((await setLevel('dep', 'help', 'reports', 'full')).status, 200);
  const r = await setLevel('dep', 'help', 'stores', 'edit');
  assert.strictEqual(r.status, 403, 'more Stores than the deputy has');
  assert.match(r.body.error, /as high as your own/);
  assert.strictEqual((await setLevel('dep', 'help', 'stores', 'view')).status, 200);
  // Someone with more than the deputy is out of the deputy's reach — to give or to take away.
  assert.strictEqual((await setLevel('dep', 'ws', 'jobs', 'view')).status, 403, 'the workshop role has more than the deputy');
  forced('help', 'oil', 'view');
  assert.strictEqual((await setLevel('dep', 'help', 'jobs', 'view')).status, 403, 'now above the deputy on Oil');
  assert.strictEqual((await call('dep', 'POST', `/access/people/${U.help}/reset`, {})).status, 403);
  perms.setPersonal(U.help, 'oil', null);
  // The deputy's own level counts, where one was set for them.
  assert.strictEqual((await setLevel('boss', 'dep', 'stores', 'edit')).status, 200);
  assert.strictEqual((await setLevel('dep', 'help', 'stores', 'edit')).status, 200, 'now within the deputy\'s own');
  await call('boss', 'POST', `/access/people/${U.help}/reset`, {});
  await call('boss', 'POST', `/access/people/${U.dep}/reset`, {});
});

test('copy another person\'s levels; reset back to the role', async () => {
  const r = await call('boss', 'POST', `/access/people/${U.help}/copy`, { from: U.sk });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.effective, perms.userLevels({ id: U.sk, roles: ['storekeeper'] }), 'the storekeeper\'s levels');
  const template = perms.userPermissions(['helper']);
  for (const [m, p] of Object.entries(r.body.personal)) assert.notStrictEqual(p.level, template[m], `${m}: stored only where it differs from the role`);
  assert.ok(!('jobs' in r.body.personal), 'jobs: view in both');
  assert.deepStrictEqual(await me('help'), r.body.effective);
  // The deputy may not copy a storekeeper (more than the deputy has) to the helper.
  await call('boss', 'POST', `/access/people/${U.help}/reset`, {});
  assert.strictEqual((await call('dep', 'POST', `/access/people/${U.help}/copy`, { from: U.sk })).status, 403);
  assert.strictEqual((await call('boss', 'POST', `/access/people/${U.help}/copy`, { from: U.help })).status, 400);
  const back = (await call('boss', 'POST', `/access/people/${U.help}/reset`, {})).body;
  assert.deepStrictEqual([back.personal, back.effective], [{}, template]);
});

test('every change is on the record', () => {
  const rows = get("SELECT COUNT(*) n FROM audit_log WHERE entity = 'user_permission'").n;
  const kinds = new Set(require('../src/db').all("SELECT DISTINCT action FROM audit_log WHERE entity = 'user_permission'").map((r) => r.action));
  assert.ok(rows >= 10, `${rows} changes`);
  assert.deepStrictEqual([...kinds].sort(), ['clear', 'copy', 'reset', 'set']);
});
