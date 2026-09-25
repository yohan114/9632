'use strict';

// Access plan, Part 3 — the permissions inside each section, person by person.
//
//   A person can be given a permission their roles do not give, or have one their roles give taken
//   away. A level or a permission of their own can end on a date ("access until"): from the day
//   after, their roles decide again. A person can have their own approval limit, which replaces
//   their roles', and see their own workshop only or all of them. The same rules as Part 2: only
//   what you hold yourself (money included), only for someone within your reach, never an admin's,
//   never your own. The Sections view and the access report show everyone at once.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-accp3-'));
process.env.DB_PATH = path.join(TMP, 'ap3.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const limits = require('../src/lib/approval_limits');

migrate();
const BUILT_IN = Object.keys(perms.DEFAULT_MATRIX);
for (const n of ['admin', ...BUILT_IN]) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
capabilities.seedCapabilities();
perms.seedDefaults();
function role(name, levels, caps = []) {
  run('INSERT INTO roles (name, label) VALUES (?, ?)', name, name);
  for (const m of perms.MODULE_KEYS) perms.setPermission(name, m, levels[m] || 'none');
  for (const c of caps) capabilities.setCapability(name, c, true);
}
// A deputy who manages access within a narrow reach; a helper within it; a role that opens nothing;
// and, for money, a limited access manager who approves MRNs and two approvers below them.
role('deputy', { jobs: 'edit', stores: 'view', reports: 'full' }, ['access.manage', 'jobs.create', 'jobs.reason']);
role('helper', { jobs: 'view' }, ['jobs.reason']);
role('blank', {});
role('limiter', { stores: 'view' }, ['access.manage', 'stores.mrn.approve']);
role('approver', { stores: 'view' }, ['stores.mrn.approve']);
role('approver_free', { stores: 'view' }, ['stores.mrn.approve']);
role('clerk', { stores: 'view' });

const PW = 'copper-lantern-gravel';
const U = {};
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active, full_name) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), username.toUpperCase()).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  U[username] = id;
  return id;
}
mkUser('boss', ['admin']); mkUser('boss2', ['admin']); mkUser('dep', ['deputy']); mkUser('help', ['helper']); mkUser('help2', ['helper']);
mkUser('ws', ['workshop']); mkUser('nob', ['blank']); mkUser('mgr', ['manager']);
mkUser('lim', ['limiter']); mkUser('appr', ['approver']); mkUser('free', ['approver_free']); mkUser('clerk', ['clerk']);
for (const r of BUILT_IN) mkUser('u_' + r, [r]);

// ---- the server -----------------------------------------------------------------------------------
const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });
function req(method, p, { body, cookie, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: raw ? null : buf.toString(), buf });
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
    if (user !== 'nob') secondFactorOn(cookies[user]);   // nob signs in again below, with a password alone
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
const setCap = (actor, who, capability, state, until) => call(actor, 'PUT', `/access/people/${U[who]}/caps`, { capability, state, until });
const setLimit = (actor, who, kind, max_amount) => call(actor, 'PUT', `/access/people/${U[who]}/limits`, { kind, max_amount });
const setLevel = (actor, who, module, level, until) => call(actor, 'PUT', `/access/people/${U[who]}/levels`, { module, level, until });
const meCaps = async (user) => (await call(user, 'GET', '/auth/me')).body.caps;
const person = (who) => ({ id: U[who], roles: auth.rolesForUser(U[who]) });
const day = (n) => { const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const clearAll = () => { run('DELETE FROM user_permissions'); run('DELETE FROM user_capabilities'); run('DELETE FROM user_approval_limits'); run('DELETE FROM approval_limits'); };

// ================================================================== day one
test('day one: with nothing of their own, everybody holds exactly their roles\' permissions and limits', async () => {
  for (const r of BUILT_IN) {
    assert.deepStrictEqual(await meCaps('u_' + r), capabilities.capsForRoles([r]), `${r}: the same permissions as the role`);
    for (const k of limits.KIND_KEYS) assert.strictEqual(limits.limitFor(person('u_' + r), k), limits.roleLimitFor(person('u_' + r), k));
  }
  assert.strictEqual(get('SELECT COUNT(*) n FROM user_capabilities').n, 0);
  assert.strictEqual(get('SELECT COUNT(*) n FROM user_approval_limits').n, 0);
});

// ================================================================== a permission of one's own
test('a permission given to one person works on the server; one taken away is refused', async () => {
  clearAll();
  // Given: a person whose role cannot manage users can, once it is given to them.
  assert.strictEqual((await call('nob', 'GET', '/users')).status, 403);
  assert.strictEqual((await setCap('boss', 'nob', 'users.manage', 'give')).status, 200);
  assert.ok((await meCaps('nob')).includes('users.manage'), 'from their next click');
  const login = await req('POST', '/api/auth/login', { body: { username: 'nob', password: PW } });
  assert.ok(login.body.caps.includes('users.manage'), 'and in what signing in tells the screens');
  assert.strictEqual((await call('nob', 'GET', '/users')).status, 200);
  // Taken away: the workshop role opens job cards, but not for this person.
  assert.notStrictEqual((await call('ws', 'POST', '/jobs', {})).status, 403);
  assert.strictEqual((await setCap('boss', 'ws', 'jobs.create', 'take')).status, 200);
  assert.ok(!(await meCaps('ws')).includes('jobs.create'));
  assert.strictEqual((await call('ws', 'POST', '/jobs', {})).status, 403);
  // Back to the role: nothing of their own is left.
  await setCap('boss', 'ws', 'jobs.create', 'role');
  await setCap('boss', 'nob', 'users.manage', 'role');
  assert.notStrictEqual((await call('ws', 'POST', '/jobs', {})).status, 403);
  assert.strictEqual((await call('nob', 'GET', '/users')).status, 403);
  assert.strictEqual(get('SELECT COUNT(*) n FROM user_capabilities').n, 0);
  // Giving what the role already gives stores nothing.
  await setCap('boss', 'ws', 'jobs.create', 'give');
  assert.strictEqual(get('SELECT COUNT(*) n FROM user_capabilities').n, 0);
  assert.strictEqual((await setCap('boss', 'ws', 'no.such.permission', 'give')).status, 400);
  assert.strictEqual((await setCap('boss', 'ws', 'jobs.create', 'maybe')).status, 400);
});

// ================================================================== access until
test('"access until": a change of one\'s own ends after its last day; a past date is refused', async () => {
  clearAll();
  // Up to and including the last day, it applies.
  assert.strictEqual((await setCap('boss', 'nob', 'users.manage', 'give', day(0))).status, 200);
  assert.strictEqual((await setLevel('boss', 'nob', 'stores', 'view', day(3))).status, 200);
  assert.ok((await meCaps('nob')).includes('users.manage'), 'today is its last day: still given');
  assert.strictEqual((await call('nob', 'GET', '/stores/items')).status, 200, 'the level applies too');
  assert.strictEqual(get('SELECT until FROM user_permissions WHERE user_id = ?', U.nob).until, day(3));
  // A date already passed cannot be typed in.
  assert.strictEqual((await setCap('boss', 'nob', 'users.manage', 'give', day(-1))).status, 400);
  assert.strictEqual((await setLevel('boss', 'nob', 'stores', 'view', 'soon')).status, 400);
  // The day after the last day, both are ignored: back to the role. The rows stay, marked ended.
  run('UPDATE user_capabilities SET until = ? WHERE user_id = ?', day(-1), U.nob);
  run('UPDATE user_permissions SET until = ? WHERE user_id = ?', day(-1), U.nob);
  assert.ok(!(await meCaps('nob')).includes('users.manage'));
  assert.strictEqual((await call('nob', 'GET', '/users')).status, 403);
  assert.strictEqual((await call('nob', 'GET', '/auth/me')).body.permissions.stores, 'none');
  assert.strictEqual((await call('nob', 'GET', '/stores/items')).status, 403);
  const d = (await call('boss', 'GET', `/access/people/${U.nob}`)).body;
  assert.deepStrictEqual(d.personal, {}, 'no level of their own in force');
  assert.deepStrictEqual(d.personal_caps, {}, 'no permission of their own in force');
  assert.deepStrictEqual(d.ended.map((x) => [x.type, x.key]).sort(), [['cap', 'users.manage'], ['level', 'stores']]);
  const listed = (await call('boss', 'GET', '/access/people')).body.find((p) => p.id === U.nob);
  assert.strictEqual(listed.own_levels, 0, 'ended changes are not counted');
});

// ================================================================== the rules
test('the rules: only what you hold, only within your reach, never an admin, never your own', async () => {
  clearAll();
  // The deputy holds access.manage, jobs.create and jobs.reason — nothing else.
  assert.strictEqual((await setCap('dep', 'help', 'users.manage', 'give')).status, 403, 'not theirs to give');
  assert.strictEqual((await setCap('dep', 'help', 'jobs.create', 'give')).status, 200, 'theirs to give');
  assert.strictEqual((await setCap('dep', 'help', 'jobs.reason', 'take')).status, 200, 'taking away is fine within reach');
  assert.strictEqual((await setCap('dep', 'dep', 'jobs.create', 'take')).status, 403, 'not your own');
  assert.strictEqual((await setCap('boss', 'boss', 'jobs.create', 'take')).status, 403, 'not your own, admin included');
  assert.strictEqual((await setCap('dep', 'boss', 'jobs.create', 'take')).status, 403, 'not an admin');
  assert.strictEqual((await setCap('boss2', 'boss', 'jobs.create', 'take')).status, 403, 'an admin always has everything');
  assert.strictEqual((await setCap('dep', 'ws', 'jobs.create', 'take')).status, 403, 'the workshop holds more than the deputy');
  assert.strictEqual((await setCap('help', 'help2', 'jobs.reason', 'take')).status, 403, 'needs access.manage');
  assert.strictEqual((await setCap('mgr', 'nob', 'jobs.reason', 'give')).status, 403, 'needs access.manage, even for one the manager holds');
  assert.strictEqual((await setLimit('mgr', 'nob', 'job_close', 100)).status, 403, 'limits too');
  // Someone given a permission beyond the deputy's is out of the deputy's reach from then on.
  await setCap('boss', 'help2', 'users.manage', 'give');
  assert.strictEqual((await setCap('dep', 'help2', 'jobs.reason', 'take')).status, 403);
  const view = (await call('dep', 'GET', `/access/people/${U.help2}`)).body;
  assert.strictEqual(view.can.edit, false);
  assert.match(view.can.reason, /within your own/);
  // A permission given to the deputy themselves is theirs to give on.
  await setCap('boss', 'dep', 'jobs.close', 'give');
  assert.strictEqual((await setCap('dep', 'help', 'jobs.close', 'give')).status, 200);
});

// ================================================================== approval limits
test('an approval limit of one\'s own replaces the role\'s, and stays within the giver\'s', async () => {
  clearAll();
  limits.setLimit({ roles: ['admin'] }, 'approver', 'mrn_approve', 1000);
  limits.setLimit({ roles: ['admin'] }, 'limiter', 'mrn_approve', 2000);
  const lim = (who) => limits.limitFor(person(who), 'mrn_approve');
  assert.strictEqual(lim('appr'), 1000, 'from the role');
  // An admin gives a person their own, higher or lower.
  assert.strictEqual((await setLimit('boss', 'appr', 'mrn_approve', 5000)).status, 200);
  assert.strictEqual(lim('appr'), 5000);
  assert.strictEqual(limits.check(person('appr'), 'mrn_approve', 4000).ok, true);
  assert.ok(limits.whoCan('mrn_approve', 4000).includes('APPR'), 'named among those who can sign it');
  assert.strictEqual((await setLimit('boss', 'appr', 'mrn_approve', 300)).status, 200);
  assert.strictEqual(limits.check(person('appr'), 'mrn_approve', 400).ok, false);
  assert.strictEqual((await setLimit('boss', 'appr', 'mrn_approve', '')).status, 200, 'empty: back to the role');
  assert.strictEqual(lim('appr'), 1000);
  assert.strictEqual((await setLimit('boss', 'appr', 'mrn_approve', -5)).status, 400);
  assert.strictEqual((await setLimit('boss', 'appr', 'nothing', 5)).status, 400);
  // The limited manager (Rs 2,000) sets limits up to their own, and never lifts anyone above it.
  assert.strictEqual((await setLimit('lim', 'appr', 'mrn_approve', 1500)).status, 200);
  assert.strictEqual((await setLimit('lim', 'appr', 'mrn_approve', 3000)).status, 403, 'above their own');
  assert.strictEqual((await setLimit('lim', 'lim', 'mrn_approve', 3000)).status, 403, 'not their own');
  assert.strictEqual((await setLimit('lim', 'lim', 'mrn_approve', 1500)).status, 403, 'not their own, even lower');
  assert.strictEqual((await setLimit('boss2', 'boss', 'mrn_approve', 10)).status, 403, 'an admin never has a limit');
  // Someone whose role has no limit is out of their reach...
  assert.strictEqual((await call('lim', 'GET', `/access/people/${U.free}`)).body.can.edit, false);
  // A limit above their own is refused even for someone who does not give that approval yet.
  assert.strictEqual((await setLimit('lim', 'clerk', 'mrn_approve', 3000)).status, 403);
  // ...and giving the approval to someone without a limit is refused until one is set first.
  const given = await setCap('lim', 'clerk', 'stores.mrn.approve', 'give');
  assert.strictEqual(given.status, 403);
  assert.match(given.body.error, /Set their approval limit first/);
  assert.ok(!capabilities.capsForUser(person('clerk')).includes('stores.mrn.approve'), 'the refused change was undone');
  assert.strictEqual((await setLimit('lim', 'clerk', 'mrn_approve', 1200)).status, 200);
  assert.strictEqual((await setCap('lim', 'clerk', 'stores.mrn.approve', 'give')).status, 200);
  assert.strictEqual(lim('clerk'), 1200);
  // Clearing that limit would leave them with none: refused, and nothing changes.
  assert.strictEqual((await setLimit('lim', 'clerk', 'mrn_approve', '')).status, 403);
  assert.strictEqual(lim('clerk'), 1200);
  // Setting limits is for approvals you give yourself.
  assert.strictEqual((await setLimit('lim', 'clerk', 'job_close', 100)).status, 403);
});

// ================================================================== workshop per person
test('workshop per person: own workshop only, or all of them', async () => {
  clearAll();
  const scope = require('../src/lib/scope');
  const who = (w) => ({ ...person(w), caps: capabilities.capsForUser(person(w)) });
  assert.strictEqual(scope.headOffice(who('ws')), false, 'the workshop role sees its own');
  assert.strictEqual(scope.headOffice(who('mgr')), true, 'the manager role sees all');
  await setCap('boss', 'ws', 'workshops.all', 'give');
  await setCap('boss', 'mgr', 'workshops.all', 'take');
  assert.strictEqual(scope.headOffice(who('ws')), true);
  assert.strictEqual(scope.headOffice(who('mgr')), false);
  const d = (await call('boss', 'GET', `/access/people/${U.ws}`)).body;
  assert.strictEqual(d.workshop.all, true);
  assert.ok(d.workshop.home && d.workshop.home.name);
  assert.strictEqual(d.personal_caps['workshops.all'].granted, true);
});

// ================================================================== copy and reset
test('copy gives another person\'s levels and permissions, with their end dates; reset clears everything', async () => {
  clearAll();
  await setLevel('boss', 'help', 'stores', 'view', day(5));
  await setCap('boss', 'help', 'jobs.create', 'give', day(7));
  await setCap('boss', 'help', 'jobs.reason', 'take');
  assert.strictEqual((await call('boss', 'POST', `/access/people/${U.help2}/copy`, { from: U.help })).status, 200);
  assert.deepStrictEqual(capabilities.capsForUser(person('help2')), capabilities.capsForUser(person('help')));
  assert.deepStrictEqual(perms.userLevels(person('help2')), perms.userLevels(person('help')));
  assert.strictEqual(get('SELECT until FROM user_permissions WHERE user_id = ? AND module = ?', U.help2, 'stores').until, day(5));
  assert.strictEqual(get('SELECT until FROM user_capabilities WHERE user_id = ? AND capability = ?', U.help2, 'jobs.create').until, day(7));
  assert.strictEqual((await call('boss', 'POST', `/access/people/${U.help2}/copy`, { from: U.boss })).status, 400, 'not from an admin');
  // The deputy cannot copy in a permission they do not hold.
  await setCap('boss', 'help', 'users.manage', 'give');
  assert.strictEqual((await call('dep', 'POST', `/access/people/${U.help2}/copy`, { from: U.help })).status, 403);
  // Reset: levels, permissions and limits of their own all go.
  await setLimit('boss', 'help2', 'job_close', 50);
  assert.strictEqual((await call('boss', 'POST', `/access/people/${U.help2}/reset`, {})).status, 200);
  for (const t of ['user_permissions', 'user_capabilities', 'user_approval_limits']) {
    assert.strictEqual(get(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, U.help2).n, 0, t);
  }
  assert.deepStrictEqual(capabilities.capsForUser(person('help2')), capabilities.capsForRoles(['helper']));
});

// ================================================================== the People screen's data
test('one person\'s view: permissions grouped by section, limits, workshop, and what the viewer may give', async () => {
  clearAll();
  await setCap('boss', 'help', 'jobs.create', 'give', day(2));
  const d = (await call('dep', 'GET', `/access/people/${U.help}`)).body;
  assert.strictEqual(d.can.edit, true);
  assert.ok(d.can.caps.includes('jobs.create') && !d.can.caps.includes('users.manage'), 'the deputy may give only their own');
  assert.ok(d.user.caps.includes('jobs.create') && !d.user.role_caps.includes('jobs.create'));
  assert.strictEqual(d.personal_caps['jobs.create'].until, day(2));
  assert.strictEqual(d.personal_caps['jobs.create'].set_by_name, 'BOSS');
  const sec = new Map(d.capabilities.map((c) => [c.key, c.section]));
  assert.strictEqual(sec.get('jobs.create'), 'jobs');
  assert.strictEqual(sec.get('stores.mrn.approve'), 'stores');
  assert.strictEqual(sec.get('access.manage'), 'access');
  assert.strictEqual(sec.get('workshops.all'), 'workshops');
  assert.ok(d.capabilities.every((c) => d.sections.some((s) => s.key === c.section)), 'every permission sits under one of the 22 sections');
  assert.deepStrictEqual(d.limits.map((k) => k.key), limits.KIND_KEYS);
  const listed = (await call('boss', 'GET', '/access/people')).body.find((p) => p.id === U.help);
  assert.strictEqual(listed.own_levels, 1);
});

// ================================================================== everyone at once
test('the Sections view and the access report show everyone, and only to access managers', async () => {
  clearAll();
  await setLevel('boss', 'help', 'stores', 'edit', day(4));
  await setCap('boss', 'help', 'jobs.create', 'give');
  const ov = (await call('dep', 'GET', '/access/overview')).body;
  const h = ov.people.find((p) => p.id === U.help);
  assert.strictEqual(h.levels.stores, 'edit');
  assert.strictEqual(h.own.stores.until, day(4));
  assert.ok(h.caps.includes('jobs.create') && h.own_caps['jobs.create'].granted);
  assert.strictEqual(ov.people.find((p) => p.id === U.boss).is_admin, true);
  assert.strictEqual(ov.columns.filter((c) => c.special).length, 2, 'Workshops and Access Control');
  assert.strictEqual(new Set(ov.columns.map((c) => c.section)).size, 21, 'every section but the Dashboard');

  // Excel: three sheets, one row per active person.
  const x = await call('dep', 'GET', '/access/report.xlsx');
  assert.strictEqual(x.status, 200);
  assert.match(x.headers['content-type'], /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.buf);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['Access', 'Own changes', 'Permissions']);
  const active = get('SELECT COUNT(*) n FROM users WHERE active = 1').n;
  assert.strictEqual(wb.getWorksheet('Access').rowCount, active + 1);
  const own = wb.getWorksheet('Own changes');
  const ownRows = [];
  own.eachRow((r, i) => { if (i > 1) ownRows.push(r.values.slice(1)); });
  assert.ok(ownRows.some((r) => r[0] === 'HELP' && r[3] === 'Edit' && r[4] === day(4)), 'the level, with its end date');
  assert.ok(ownRows.some((r) => r[0] === 'HELP' && r[3] === 'Given'), 'the permission');

  // The page to print or save as PDF.
  const pg = await call('dep', 'GET', '/access/report.html');
  assert.strictEqual(pg.status, 200);
  assert.match(pg.text, /Access report/);
  assert.match(pg.text, /HELP/);
  assert.match(pg.text, /Changes made for one person \(2\)/);
  assert.doesNotMatch(pg.text, /onclick=/, 'no inline handlers');

  // Nobody else.
  for (const p of ['/access/overview', '/access/report.xlsx', '/access/report.html']) {
    assert.strictEqual((await call('help', 'GET', p)).status, 403, p);
  }
  assert.ok(get("SELECT COUNT(*) n FROM audit_log WHERE entity = 'access_report'").n >= 2, 'downloads are on the record');
});

// ================================================================== on the record
test('every change of one\'s own is on the record', async () => {
  clearAll();
  const before = get('SELECT COALESCE(MAX(id), 0) m FROM audit_log').m;
  await setCap('boss', 'help', 'jobs.create', 'give', day(1));
  await setCap('boss', 'help', 'jobs.create', 'role');
  await setCap('boss', 'help', 'jobs.reason', 'take');
  await setLimit('boss', 'appr', 'mrn_approve', 900);
  await setLimit('boss', 'appr', 'mrn_approve', '');
  await call('boss', 'POST', `/access/people/${U.help}/reset`, {});
  const rows = all('SELECT entity, action, entity_id, after_json FROM audit_log WHERE id > ? ORDER BY id', before);
  assert.deepStrictEqual(rows.map((r) => `${r.entity}:${r.action}`), [
    'user_capability:give', 'user_capability:clear', 'user_capability:take',
    'user_approval_limit:set', 'user_approval_limit:clear', 'user_permission:reset',
  ]);
  assert.strictEqual(JSON.parse(rows[0].after_json).until, day(1));
  assert.strictEqual(rows[3].entity_id, U.appr);
});
