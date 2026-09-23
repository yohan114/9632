'use strict';

// Stage 1 — custom roles (docs/SECURITY_ACCESS_MULTISITE_PLAN.md §3.3).
//
// Pins three things:
//   1. NOTHING CHANGED for the built-in roles: every capability is held by exactly the roles the
//      replaced requireRole()/can() check named.
//   2. A role an admin creates actually works — on the API and in the job-card state machine —
//      and a permission taken away is refused at the next request.
//   3. Being allowed to manage roles or users is not a way to more access: only what you hold can
//      be given, only an admin touches the admin role, and the last admin cannot be removed.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-caps-'));
process.env.DB_PATH = path.join(TMP, 'caps.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const permissions = require('../src/lib/permissions');
const jobstate = require('../src/lib/jobstate');

migrate();
const BUILT_IN = ['admin', 'storekeeper', 'main_storekeeper', 'transport_manager', 'assistant_transport_manager',
  'operational_manager', 'manager', 'workshop', 'purchase_head_office', 'purchase_local', 'viewer'];
for (const n of BUILT_IN) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);

const PW = 'lantern-quarry-summit';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const chiefId = mkUser('chief', ['admin']);

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
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function login(username) {
  const r = await req('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.strictEqual(r.status, 200, r.text);
  return r.cookie;
}

// ---------------------------------------------------------------- the catalogue itself
test('the catalogue is well-formed', () => {
  const keys = capabilities.CAPABILITIES.map((c) => c.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'keys are unique');
  for (const c of capabilities.CAPABILITIES) {
    assert.match(c.key, /^[a-z_]+(\.[a-z_]+)+$/, c.key);
    assert.ok(c.label && c.label.length > 5, `${c.key} has a label an admin can read`);
    for (const r of c.legacy) assert.ok(BUILT_IN.includes(r) && r !== 'admin', `${c.key}: legacy role ${r} is a built-in role`);
    if (c.needs) assert.ok(permissions.MODULE_KEYS.includes(c.needs), `${c.key}: needs ${c.needs} is a module`);
  }
});

test('every permission the code and the screens ask for exists in the catalogue', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.js'))
    .concat(path.join(__dirname, '..', 'public', 'app.js'));
  const asked = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:requireCap|hasCap|canDo|may)\(([^)]*)\)/g)) {
      for (const k of m[1].matchAll(/'([a-z_]+\.[a-z_.]+)'/g)) asked.add(k[1]);
    }
  }
  for (const k of asked) assert.ok(capabilities.isCapability(k), `unknown permission "${k}"`);
  assert.ok(asked.size > 50, `found ${asked.size} permission checks`);
});

test('nothing decides access by role name any more (routes and screens)', () => {
  const routes = path.join(__dirname, '..', 'src', 'routes');
  for (const f of fs.readdirSync(routes)) {
    const src = fs.readFileSync(path.join(routes, f), 'utf8');
    assert.ok(!/\b(requireRole|hasRole)\(/.test(src), `${f} still checks a role name — use requireCap/hasCap`);
  }
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/(^|[^\w.])can\(/m.test(appJs), 'app.js still calls can(role…) — use canDo(capability)');
  assert.ok(!/roles\.includes\('(?!admin')/.test(appJs), 'app.js still branches on a role name');
});

// ---------------------------------------------------------------- 1. nothing changed
test('every built-in role holds exactly the permissions its old checks gave it; admin holds all', () => {
  for (const role of BUILT_IN) {
    const held = new Set(capabilities.capsForRoles([role]));
    for (const c of capabilities.CAPABILITIES) {
      const expected = role === 'admin' || c.legacy.includes(role);
      assert.strictEqual(held.has(c.key), expected, `${role} / ${c.key}`);
    }
  }
});

test('the seed never gives back a permission an admin took away', () => {
  capabilities.setCapability('viewer', 'projects.manage', true);
  capabilities.setCapability('storekeeper', 'stores.issue', false);
  capabilities.seedCapabilities();
  migrate();
  assert.ok(capabilities.capsForRoles(['viewer']).includes('projects.manage'), 'a grant survives a restart');
  assert.ok(!capabilities.capsForRoles(['storekeeper']).includes('stores.issue'), 'a removal survives a restart');
  capabilities.setCapability('viewer', 'projects.manage', false);
  capabilities.setCapability('storekeeper', 'stores.issue', true);
});

test('the job-card state machine still takes role lists, and gives the old answers', () => {
  assert.strictEqual(jobstate.checkTransition('REQUESTED', 'APPROVED_TRANSPORT', ['transport_manager']).ok, true);
  assert.strictEqual(jobstate.checkTransition('REQUESTED', 'APPROVED_TRANSPORT', ['workshop']).ok, false);
  assert.strictEqual(jobstate.checkTransition('CLOSED', 'IN_PROGRESS', ['manager']).ok, true, 'manager may reopen');
  assert.strictEqual(jobstate.checkTransition('CLOSED', 'IN_PROGRESS', ['storekeeper']).ok, false);
  assert.match(jobstate.checkTransition('CLOSED', 'IN_PROGRESS', ['viewer']).error, /Reopen a CLOSED job card/);
});

// ---------------------------------------------------------------- 2. custom roles work
test('an admin creates a role; the person holding it can do exactly what was ticked', async () => {
  const admin = await login('chief');
  const created = await req('POST', '/api/access/roles', { cookie: admin, body: { label: 'Project Coordinator', description: 'Keeps the project list' } });
  assert.strictEqual(created.status, 201, created.text);
  assert.strictEqual(created.body.name, 'project_coordinator');
  assert.deepStrictEqual(created.body.caps, [], 'a new role starts with nothing');

  mkUser('ruwan', ['project_coordinator']);
  const ruwan = await login('ruwan');
  const before = await req('POST', '/api/projects', { cookie: ruwan, body: { name: 'Matara Bypass', code: 'MTB-01' } });
  assert.strictEqual(before.status, 403);
  assert.match(before.body.error, /Create and edit projects/, 'the refusal names the missing permission');

  const tick = await req('POST', '/api/access/capabilities', { cookie: admin, body: { role: 'project_coordinator', capability: 'projects.manage', granted: true } });
  assert.strictEqual(tick.status, 200, tick.text);
  const after = await req('POST', '/api/projects', { cookie: ruwan, body: { name: 'Matara Bypass', code: 'MTB-01' } });
  assert.ok(after.status < 300, `allowed from the next request: ${after.text}`);

  const me = await req('GET', '/api/auth/me', { cookie: ruwan });
  assert.ok(me.body.caps.includes('projects.manage'), '/me tells the screens');

  await req('POST', '/api/access/capabilities', { cookie: admin, body: { role: 'project_coordinator', capability: 'projects.manage', granted: false } });
  assert.strictEqual((await req('POST', '/api/projects', { cookie: ruwan, body: { name: 'Galle Road', code: 'GLR-02' } })).status, 403, 'and refused again once taken away');
});

test('a copy of a built-in role carries its permissions and section clearance, and the router gate still applies', async () => {
  const admin = await login('chief');
  const r = await req('POST', '/api/access/roles', { cookie: admin, body: { label: 'Site Storekeeper — Matara', clone_from: 'storekeeper' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.name, 'site_storekeeper_matara');
  assert.deepStrictEqual(r.body.caps, capabilities.capsForRoles(['storekeeper']));
  assert.strictEqual(permissions.levelForRoles(['site_storekeeper_matara'], 'stores'), permissions.levelForRoles(['storekeeper'], 'stores'));

  mkUser('saman', ['site_storekeeper_matara']);
  const saman = await login('saman');
  const ok = await req('POST', '/api/stores/categories', { cookie: saman, body: { name: 'Hydraulic hoses', code: 'HYD' } });
  assert.ok(ok.status < 300, ok.text);

  // Section clearance is the outer gate: with Stores at VIEW, the permission alone is not enough.
  await req('POST', '/api/access/matrix', { cookie: admin, body: { role: 'site_storekeeper_matara', module: 'stores', level: 'view' } });
  const gated = await req('POST', '/api/stores/categories', { cookie: saman, body: { name: 'Seals', code: 'SEA' } });
  assert.strictEqual(gated.status, 403);
  const me = await req('GET', '/api/auth/me', { cookie: saman });
  assert.strictEqual(me.body.capNeeds['stores.categories.edit'], 'stores', 'the screen is told, so it can hide the button');
});

test('a custom role can be given a step of the job-card workflow', () => {
  run("INSERT INTO roles (name, label) VALUES ('fleet_approver', 'Fleet Approver')");
  capabilities.setCapability('fleet_approver', 'jobs.approve_transport', true);
  assert.strictEqual(jobstate.checkTransition('REQUESTED', 'APPROVED_TRANSPORT', { caps: capabilities.capsForRoles(['fleet_approver']) }).ok, true);
  assert.strictEqual(jobstate.checkTransition('APPROVED_TRANSPORT', 'APPROVED_OPERATIONS', ['fleet_approver']).ok, false);
});

test('a new role never takes a built-in name, and so never inherits its seeded permissions', async () => {
  const admin = await login('chief');
  const r = await req('POST', '/api/access/roles', { cookie: admin, body: { label: 'Workshop' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.notStrictEqual(r.body.name, 'workshop');
  assert.deepStrictEqual(r.body.caps, []);
  assert.strictEqual((await req('POST', '/api/access/roles', { cookie: admin, body: { label: 'workshop' } })).status, 409, 'labels are unique');
});

test('a role still held by someone cannot be retired; a retired role grants nothing', async () => {
  const admin = await login('chief');
  await req('POST', '/api/access/roles', { cookie: admin, body: { label: 'Temp Cover' } });
  await req('POST', '/api/access/capabilities', { cookie: admin, body: { role: 'temp_cover', capability: 'projects.manage', granted: true } });
  const uid = mkUser('temp1', ['temp_cover']);
  assert.strictEqual((await req('PATCH', '/api/access/roles/temp_cover', { cookie: admin, body: { active: false } })).status, 409);
  run('DELETE FROM user_roles WHERE user_id = ?', uid);
  assert.strictEqual((await req('PATCH', '/api/access/roles/temp_cover', { cookie: admin, body: { active: false } })).status, 200);
  run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'temp_cover'))", uid);
  assert.deepStrictEqual(auth.rolesForUser(uid), [], 'a retired role is not counted');
  const t = await login('temp1');
  assert.strictEqual((await req('POST', '/api/projects', { cookie: t, body: { name: 'X', code: 'X-1' } })).status, 403);
  assert.strictEqual((await req('POST', '/api/users', { cookie: admin, body: { username: 'temp2', password: 'Harbour-Ember-1942', roles: ['temp_cover'] } })).status, 400, 'nor offered to anyone new');
});

test('the admin role cannot be edited, copied or retired', async () => {
  const admin = await login('chief');
  assert.strictEqual((await req('POST', '/api/access/capabilities', { cookie: admin, body: { role: 'admin', capability: 'users.manage', granted: false } })).status, 400);
  assert.strictEqual((await req('PATCH', '/api/access/roles/admin', { cookie: admin, body: { active: false } })).status, 400);
  assert.strictEqual((await req('POST', '/api/access/roles', { cookie: admin, body: { label: 'Admin 2', clone_from: 'admin' } })).status, 400);
});

// ---------------------------------------------------------------- 3. no way up
test('someone who manages roles can only give permissions and clearance they hold themselves', async () => {
  run("INSERT INTO roles (name, label) VALUES ('access_admin', 'Access Admin')");
  capabilities.setCapability('access_admin', 'access.manage', true);
  capabilities.setCapability('access_admin', 'projects.manage', true);
  mkUser('dilani', ['access_admin']);
  const dilani = await login('dilani');

  const own = await req('POST', '/api/access/capabilities', { cookie: dilani, body: { role: 'project_coordinator', capability: 'projects.manage', granted: true } });
  assert.strictEqual(own.status, 200, 'a permission she holds: yes');
  const notOwn = await req('POST', '/api/access/capabilities', { cookie: dilani, body: { role: 'project_coordinator', capability: 'stores.issue', granted: true } });
  assert.strictEqual(notOwn.status, 403, 'one she does not: no');
  const self = await req('POST', '/api/access/capabilities', { cookie: dilani, body: { role: 'access_admin', capability: 'users.manage', granted: true } });
  assert.strictEqual(self.status, 403, 'not even on her own role');
  const level = await req('POST', '/api/access/matrix', { cookie: dilani, body: { role: 'access_admin', module: 'stores', level: 'full' } });
  assert.strictEqual(level.status, 403, 'no clearance above her own');
  const copy = await req('POST', '/api/access/roles', { cookie: dilani, body: { label: 'My Storekeeper', clone_from: 'storekeeper' } });
  assert.strictEqual(copy.status, 403, 'no copying a role with more than she holds');
  const take = await req('POST', '/api/access/capabilities', { cookie: dilani, body: { role: 'project_coordinator', capability: 'projects.manage', granted: false } });
  assert.strictEqual(take.status, 200, 'taking away is always allowed');
});

test('someone who manages users cannot hand out admin, or a role above their own, or take over a stronger account', async () => {
  run("INSERT INTO roles (name, label) VALUES ('hr_clerk', 'HR Clerk')");
  capabilities.setCapability('hr_clerk', 'users.manage', true);
  capabilities.setCapability('hr_clerk', 'projects.manage', true);
  mkUser('nadee', ['hr_clerk']);
  const keeperId = mkUser('kasun', ['storekeeper']);
  const coordId = mkUser('pradeep', ['project_coordinator']);
  const nadee = await login('nadee');
  const pw = 'Timber-Kestrel-6604';

  assert.strictEqual((await req('POST', '/api/users', { cookie: nadee, body: { username: 'x1', password: pw, roles: ['admin'] } })).status, 403);
  assert.strictEqual((await req('POST', '/api/users', { cookie: nadee, body: { username: 'x2', password: pw, roles: ['storekeeper'] } })).status, 403, 'storekeeper has permissions she lacks');
  assert.strictEqual((await req('POST', '/api/users', { cookie: nadee, body: { username: 'x3', password: pw, roles: ['project_coordinator'] } })).status, 201, 'a role within her reach: yes');

  assert.strictEqual((await req('PATCH', `/api/users/${chiefId}`, { cookie: nadee, body: { password: pw } })).status, 403, 'not the admin\'s password');
  assert.strictEqual((await req('PATCH', `/api/users/${keeperId}`, { cookie: nadee, body: { password: pw } })).status, 403, 'nor a storekeeper\'s — that would be a way in');
  assert.strictEqual((await req('POST', `/api/users/${coordId}/roles`, { cookie: nadee, body: { roles: ['storekeeper'] } })).status, 403);
  assert.strictEqual((await req('PATCH', `/api/users/${coordId}`, { cookie: nadee, body: { password: pw } })).status, 200, 'an account within her reach: yes');
});

test('the last active admin cannot be switched off or demoted — not even by themselves', async () => {
  const admin = await login('chief');
  const off = await req('PATCH', `/api/users/${chiefId}`, { cookie: admin, body: { active: false } });
  assert.strictEqual(off.status, 409);
  assert.match(off.body.error, /only active admin/);
  assert.strictEqual((await req('POST', `/api/users/${chiefId}/roles`, { cookie: admin, body: { roles: ['viewer'] } })).status, 409);
  const roles = await req('GET', '/api/access/roles', { cookie: admin });
  assert.strictEqual(roles.body.active_admins, 1, 'the screen can warn about it');

  const secondId = mkUser('deputy', ['admin']);
  assert.strictEqual((await req('POST', `/api/users/${chiefId}/roles`, { cookie: admin, body: { roles: ['admin', 'viewer'] } })).status, 200);
  assert.strictEqual((await req('PATCH', `/api/users/${secondId}`, { cookie: admin, body: { active: false } })).status, 200, 'with two, one may go');
  assert.ok(get('SELECT 1 x FROM users WHERE id = ? AND active = 1', chiefId));
});

test('role and permission changes are on the record', () => {
  const rows = get("SELECT COUNT(*) n FROM audit_log WHERE entity IN ('role', 'role_capability')").n;
  assert.ok(rows >= 5, `${rows} audited changes`);
});
