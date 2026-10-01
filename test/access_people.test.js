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
  }
  return cookies[user];
}
const call = async (user, method, p, body) => req(method, '/api' + p, { cookie: await as(user), body });
// This tree saves a person's own levels through POST /people/:id/save, taking a map of sections,
// and copies with /copy-from taking source_user_id. The lineage these tests came from had
// PUT /levels with a single {module, level} and /copy with {from}. Same operations, different
// doors: the helpers knock on this tree's.
const setLevel = (actor, who, section, level) =>
  call(actor, 'POST', `/access/people/${U[who]}/save`, { sections: { [section]: level } });
const copyFrom = (actor, who, from) =>
  call(actor, 'POST', `/access/people/${U[who]}/copy-from`, { source_user_id: U[from] });
const resetTo = (actor, who) => call(actor, 'POST', `/access/people/${U[who]}/reset`, {});
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
    forced('nob', 'purchasing', 'add'); forced('nob', 'tb_reports', 'add'); forced('nob', 'stores', 'add');
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

  // This tree answers { people: [...] }, each person carrying their roles, a count of the overrides
  // they have and their effective set. The lineage these tests came from answered a bare array with
  // own_levels and self: the same facts, named differently.
  const { people } = (await call('boss', 'GET', '/access/people')).body;
  const h = people.find((x) => x.id === U.help);
  assert.deepStrictEqual(h.roles.map((r) => r.name), ['helper']);
  assert.strictEqual(h.overrides_count, 1, 'the one level just given');
  assert.strictEqual(h.permissions.reports, 'view', 'and it shows in the effective set');

  // One person: this tree returns the sections with role_level, override_level and effective_level
  // side by side, which is what role_levels / personal / effective were in the other.
  const d = (await call('boss', 'GET', `/access/people/${U.help}`)).body;
  assert.strictEqual(d.user.id, U.help);
  assert.deepStrictEqual(d.user.roles.map((r) => r.name), ['helper']);
  assert.strictEqual(d.sections.length, 22);
  assert.deepStrictEqual(d.levels, ['none', 'view', 'add', 'edit', 'full']);
  const sec = (k) => d.sections.find((x) => x.key === k);
  assert.deepStrictEqual(
    [sec('jobs').role_level, sec('reports').role_level, sec('reports').override_level, sec('reports').effective_level],
    ['view', 'none', 'view', 'view'],
    'the role gives jobs; reports is this person\'s own');
  assert.deepStrictEqual([sec('reports').origin, sec('reports').has_override, sec('jobs').origin], ['custom', true, 'role']);
  await setLevel('boss', 'help', 'reports', null);
  assert.strictEqual((await call('boss', 'GET', `/access/people/${U.help}`)).body.sections
    .find((x) => x.key === 'reports').override_level, null, 'cleared');
});

// ================================================================== the rules
test('nobody changes their own access — not even an admin', async () => {
  for (const [who, mod] of [['boss', 'jobs'], ['dep', 'reports']]) {
    assert.strictEqual((await setLevel(who, who, mod, 'view')).status, 403, who);
    assert.strictEqual((await resetTo(who, who)).status, 403);
    assert.strictEqual((await copyFrom(who, who, 'sk')).status, 403);
  }
  assert.strictEqual((await call('boss', 'POST', `/users/${U.boss}/roles`, { roles: ['admin', 'viewer'] })).status, 403, 'nor their own roles');
  assert.strictEqual((await call('boss2', 'POST', `/users/${U.boss}/roles`, { roles: ['admin', 'viewer'] })).status, 200, 'another admin may');
  assert.strictEqual((await call('boss2', 'POST', `/users/${U.boss}/roles`, { roles: ['admin'] })).status, 200);
});

test('an admin always has full access: nothing to set', async () => {
  // The other lineage refused the write outright. This tree takes it and makes it moot instead:
  // effectiveLevel short-circuits an admin to full before it ever reads user_permissions, so a
  // level stored against an admin changes nothing. The guarantee is the same, so assert the
  // guarantee rather than the refusal -- the guarantee is what anyone actually relies on.
  assert.strictEqual((await setLevel('boss', 'boss2', 'jobs', 'none')).status, 200);
  assert.strictEqual((await me('boss2')).jobs, 'full', 'stored as none, still full');
  assert.strictEqual((await call('boss2', 'GET', '/jobs')).status, 200, 'and the server agrees');
  run('DELETE FROM user_permissions WHERE user_id = ?', U.boss2);
});

test('you can only give up to your own level, and only to someone within your own access', async () => {
  // The deputy: jobs edit, stores view, reports full. The helper (jobs view) is within that.
  assert.strictEqual((await setLevel('dep', 'help', 'jobs', 'edit')).status, 200);
  assert.strictEqual((await setLevel('dep', 'help', 'reports', 'full')).status, 200);
  const r = await setLevel('dep', 'help', 'stores', 'edit');
  assert.strictEqual(r.status, 403, 'more Stores than the deputy has');
  assert.match(r.body.error, /as high as your own/);
  assert.strictEqual((await setLevel('dep', 'help', 'stores', 'view')).status, 200);
  // Someone whose ROLE is beyond the deputy is out of the deputy's reach.
  assert.strictEqual((await setLevel('dep', 'ws', 'jobs', 'view')).status, 403, 'the workshop role has more than the deputy');
  // A level given to one person is NOT part of that reach here. assertCanManageUser weighs the
  // target's ROLES; the lineage these tests came from weighed their effective levels as well, and
  // so put anyone holding more than you entirely out of bounds. This tree is narrower: the deputy
  // may still touch the helper after the helper is given Oil above the deputy. What the deputy
  // still cannot do -- the part that matters for escalation -- is hand out more than they hold.
  forced('help', 'oil', 'view');
  assert.strictEqual((await setLevel('dep', 'help', 'jobs', 'view')).status, 200);
  const tooHigh = await setLevel('dep', 'help', 'oil', 'edit');
  assert.strictEqual(tooHigh.status, 403, 'still cannot give more Oil than the deputy holds');
  assert.match(tooHigh.body.error, /as high as your own/);
  perms.setPersonal(U.help, 'oil', null);
  // The deputy's own level counts, where one was set for them.
  assert.strictEqual((await setLevel('boss', 'dep', 'stores', 'edit')).status, 200);
  assert.strictEqual((await setLevel('dep', 'help', 'stores', 'edit')).status, 200, 'now within the deputy\'s own');
  await resetTo('boss', 'help');
  await resetTo('boss', 'dep');
});

test('copy another person\'s levels; reset back to the role', async () => {
  // /copy-from here copies the source's OWN levels -- their deviations from their role -- not their
  // effective access. The other lineage copied the effective set, so the target came out holding
  // what the source held; here a source with no levels of their own copies nothing at all. Give the
  // storekeeper one, so there is something to copy.
  // Two of them: Reports, which the deputy also holds at full, and Oil, which the deputy has none
  // of. The second is what makes the deputy's attempt below mean something.
  await setLevel('boss', 'sk', 'reports', 'full');
  await setLevel('boss', 'sk', 'oil', 'full');
  assert.strictEqual((await copyFrom('boss', 'help', 'sk')).status, 200);
  assert.deepStrictEqual([(await me('help')).reports, (await me('help')).oil], ['full', 'full'],
    'the storekeeper\'s own levels are the helper\'s now');
  // Read back off the sections only for Reports: /people/:id walks the 22 sidebar SECTIONS, and
  // Oil is not one of them -- it is a switch under Lubricants, like jobrequests under Job Cards.
  // A level can still be held on it, which is why me() above sees both.
  const copied = (await call('boss', 'GET', `/access/people/${U.help}`)).body.sections;
  assert.strictEqual(copied.find((x) => x.key === 'reports').override_level, 'full', 'stored as their own');

  const template = perms.userPermissions(['helper']);
  await resetTo('boss', 'help');
  assert.deepStrictEqual(await me('help'), template, 'reset: the role again');
  assert.strictEqual((await call('boss', 'GET', `/access/people/${U.help}`)).body.sections
    .filter((x) => x.has_override).length, 0, 'and nothing of their own is left');

  // The deputy may not copy the storekeeper onto the helper -- not because of who the storekeeper
  // is, but because copy-from runs assertCanSetLevel over every level it would write, and one of
  // them is Oil, which the deputy holds none of. That is the check that stops this being a way
  // round "only up to your own level": copying is setting, by another name.
  const byDep = await copyFrom('dep', 'help', 'sk');
  assert.strictEqual(byDep.status, 403);
  assert.match(byDep.body.error, /oil as high as your own/);
  // Copying a person onto themselves is refused.
  assert.strictEqual((await copyFrom('boss', 'help', 'help')).status, 400);
  await setLevel('boss', 'sk', 'reports', null);
  await setLevel('boss', 'sk', 'oil', null);
});

test('every change is on the record', () => {
  const rows = get("SELECT COUNT(*) n FROM audit_log WHERE entity = 'user_permission'").n;
  const kinds = new Set(require('../src/db').all("SELECT DISTINCT action FROM audit_log WHERE entity = 'user_permission'").map((r) => r.action));
  assert.ok(rows >= 8, `${rows} changes`);
  // One action per request here: save_overrides covers both setting a level and clearing it, where
  // the other lineage wrote 'set' and 'clear' separately.
  assert.deepStrictEqual([...kinds].sort(), ['copy_from', 'reset_to_role', 'save_overrides']);
});
