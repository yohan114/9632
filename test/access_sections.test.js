'use strict';

// Access plan, Part 1 — 22 sections, each with its own switch, checked on the server.
//
//   Nine sections used to share another's switch (Field Work and Lubricant Capacities shared Job
//   Cards; Operations shared Assets; Service Records and the Service & Filter Plan shared Filters;
//   Needs Attention, Daily Progress, Cost Teardown and the Tyre & Battery ledger shared Reports).
//   Each now has its own, starting at the level the role had on the old one — nobody's access
//   changes — and the server checks each section by its own switch. Lists that fill drop-downs
//   elsewhere (projects, mechanics) stay open to anyone signed in, names only.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-accsec-'));
process.env.DB_PATH = path.join(TMP, 'as.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');

migrate();
const BUILT_IN = Object.keys(perms.DEFAULT_MATRIX);
for (const n of ['admin', ...BUILT_IN]) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
capabilities.seedCapabilities();
perms.seedDefaults();

// A role that opens exactly the given switches (view), nothing else.
function role(name, open) {
  run('INSERT INTO roles (name, label) VALUES (?, ?)', name, name);
  for (const m of perms.MODULE_KEYS) perms.setPermission(name, m, open.includes(m) ? 'view' : 'none');
}
const ROLES = {
  jobsonly: ['jobs'], fieldonly: ['field'], opsonly: ['operations'], assetsonly: ['assets'],
  svconly: ['services'], filtonly: ['filters'], planonly: ['serviceplan'], lubeonly: ['lubecapacities'],
  attnonly: ['attention'], progonly: ['progress'], tearonly: ['teardown'], ledgeronly: ['tyrebattery'], reportsonly: ['reports'],
  storesonly: ['stores'], aliasonly: ['aliases'], labouronly: ['labour'], projonly: ['projects'], tbonly: ['tb_request'], nothing: [],
};
for (const [n, open] of Object.entries(ROLES)) role(n, open);

const PW = 'copper-lantern-gravel';
for (const n of Object.keys(ROLES).concat(['admin'])) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', n, auth.hashPassword(PW)).lastInsertRowid;
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, n);
}

const A = run("INSERT INTO assets (code, code_norm, status, in_register) VALUES ('EX-9', 'EX9', 'active', 1)").lastInsertRowid;
const J = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, field)
               VALUES ('2026/9/R/9', ?, 'repair', 'Track roller', 'IN_PROGRESS', date('now'), 1)`, A).lastInsertRowid;
const P = run("INSERT INTO projects (code, name, location) VALUES ('P-1', 'Harbour road', 'Colombo')").lastInsertRowid;
require('../src/lib/mechanics').findOrCreateMechanic('Anura');
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 450, '2020-01-01')");
const today = new Date().toISOString().slice(0, 10);

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
const status = async (user, p) => (await call(user, 'GET', p)).status;
// "Let through": whatever the handler then says, the section check did not refuse it.
const letThrough = async (user, p) => { const s = await status(user, p); assert.ok(s !== 403 && s !== 401 && s < 500, `${user}: ${p} → ${s}`); };
const refused = async (user, p) => assert.strictEqual(await status(user, p), 403, `${user}: ${p}`);

// ================================================================== the 22 sections
test('the 22 sections are the sidebar\'s, and every switch belongs to exactly one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const nav = [...src.slice(src.indexOf('const NAV = ['), src.indexOf('];', src.indexOf('const NAV = ['))).matchAll(/\['(\w+)', '[^']*', '([^']+)'/g)]
    .map((m) => m[2]);
  assert.strictEqual(perms.SECTIONS.length, 22);
  assert.deepStrictEqual(perms.SECTIONS.map((s) => s.label), nav, 'the same 22, in the sidebar\'s order');
  const owned = perms.SECTIONS.flatMap((s) => s.modules || []);
  assert.deepStrictEqual(owned.slice().sort(), perms.MODULE_KEYS.slice().sort(), 'every switch in one section');
  assert.strictEqual(new Set(owned).size, owned.length, 'and only one');
  // The sidebar opens each item by a switch of its own section.
  const navModule = Object.fromEntries([...src.slice(src.indexOf('const NAV_MODULE = {'), src.indexOf('};', src.indexOf('const NAV_MODULE = {')))
    .matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
  // The actions of a split-off section are listed under it on the Access screen.
  const moved = Object.fromEntries(['jobs.breakdown', 'jobs.field', 'assets.move', 'fleet.capacities.edit', 'services.attachments']
    .map((k) => [k, capabilities.get(k).module]));
  assert.deepStrictEqual(moved, { 'jobs.breakdown': 'field', 'jobs.field': 'field', 'assets.move': 'operations',
    'fleet.capacities.edit': 'lubecapacities', 'services.attachments': 'services' });
  for (const [item, key] of Object.entries({ field: 'field', operations: 'operations', services: 'services', lubecapacities: 'lubecapacities',
    serviceplan: 'serviceplan', attention: 'attention', progress: 'progress', teardown: 'teardown', tyrebattery: 'tyrebattery' })) {
    assert.strictEqual(navModule[item], key, `${item} opens by its own switch`);
  }
});

// ================================================================== day one: nothing changes
test('day one: every built-in role has on each new switch the level it had on the old one', () => {
  for (const r of BUILT_IN) {
    for (const [key, from] of perms.SPLIT) {
      assert.strictEqual(perms.levelForRoles([r], key), perms.levelForRoles([r], from), `${r}: ${key} = ${from}`);
    }
  }
});

test('day one: a role made before the split, and a level changed on the Access screen, carry over', () => {
  // As on the live server before this change: a custom role with only the old switches, and a
  // built-in role an admin had narrowed (the workshop's Reports taken to none).
  run("INSERT INTO roles (name, label) VALUES ('site_keeper', 'Site keeper')");
  for (const m of perms.MODULE_KEYS) {
    if (perms.SPLIT.some(([k]) => k === m)) continue;
    perms.setPermission('site_keeper', m, ['jobs', 'filters', 'reports'].includes(m) ? 'edit' : (m === 'assets' ? 'view' : 'none'));
  }
  const newKeys = perms.SPLIT.map(([k]) => k);
  run(`DELETE FROM role_permissions WHERE role IN ('site_keeper', 'workshop') AND module IN (${newKeys.map(() => '?').join(',')})`, ...newKeys);
  perms.setPermission('workshop', 'reports', 'none');
  migrate();   // what the server does when it starts
  for (const [key, from] of perms.SPLIT) {
    assert.strictEqual(perms.levelForRoles(['site_keeper'], key), perms.levelForRoles(['site_keeper'], from), `site keeper: ${key}`);
    assert.strictEqual(perms.levelForRoles(['workshop'], key), perms.levelForRoles(['workshop'], from), `workshop: ${key}`);
  }
  assert.deepStrictEqual(['attention', 'progress', 'teardown', 'tyrebattery'].map((k) => perms.levelForRoles(['workshop'], k)),
    ['none', 'none', 'none', 'none'], 'the admin\'s change, not the default');
  // Once set, a new switch is its own: the copy never overwrites it.
  perms.setPermission('workshop', 'field', 'none');
  assert.strictEqual(perms.splitSections().copied, 0);
  migrate();
  assert.strictEqual(perms.levelForRoles(['workshop'], 'field'), 'none');
  assert.strictEqual(perms.levelForRoles(['workshop'], 'jobs'), 'edit');
  // Put the workshop back for the tests below.
  perms.setPermission('workshop', 'field', 'edit');
  for (const k of ['reports', 'attention', 'progress', 'teardown', 'tyrebattery']) perms.setPermission('workshop', k, 'view');
});

// ================================================================== each section, its own switch
test('Field Work: the page needs Field Work; a card\'s field details open from Job Cards too', async () => {
  await letThrough('fieldonly', '/field/board');
  await refused('jobsonly', '/field/board');
  await refused('jobsonly', '/field/month');
  await letThrough('jobsonly', `/field/jobs/${J}`);
  await letThrough('jobsonly', '/field/places');
  await letThrough('fieldonly', `/field/jobs/${J}`);
  await refused('fieldonly', '/jobs');
  await refused('nothing', `/field/jobs/${J}`);
  // The Job Cards Monitor counts machines down in the field only for whoever may see Field Work.
  assert.strictEqual((await call('jobsonly', 'GET', '/job-flow/monitor')).body.watch.breakdowns_down, null);
  assert.strictEqual(typeof (await call('admin', 'GET', '/job-flow/monitor')).body.watch.breakdowns_down, 'number');
});

test('Operations: its own switch; the move form on the Assets page still reads the places', async () => {
  await letThrough('opsonly', '/operations/fleet');
  await letThrough('opsonly', '/operations/handovers');
  await refused('assetsonly', '/operations/fleet');
  await refused('assetsonly', '/operations/handovers');
  await letThrough('assetsonly', '/operations/places');
  await letThrough('assetsonly', `/operations/machines/${A}/moves`);
  await refused('opsonly', `/assets/${A}`);
  await refused('nothing', '/operations/places');
  // Workshops at a glance: head office, and Operations.
  capabilities.setCapability('assetsonly', 'workshops.all', true);
  capabilities.setCapability('opsonly', 'workshops.all', true);
  try {
    await refused('assetsonly', '/operations/glance');
    await letThrough('opsonly', '/operations/glance');
  } finally {
    capabilities.setCapability('assetsonly', 'workshops.all', false);
    capabilities.setCapability('opsonly', 'workshops.all', false);
  }
  await refused('opsonly', '/operations/glance');
});

test('Service Records, the Service & Filter Plan and the Stores filter books: one router, three switches', async () => {
  await letThrough('svconly', '/filters/services');
  await letThrough('svconly', '/filters/reference');
  await letThrough('svconly', '/filters/categories');
  await refused('svconly', '/filters/prices');
  await refused('svconly', '/filters/service-plan');
  await letThrough('filtonly', '/filters/prices');
  await letThrough('filtonly', '/filters/categories');
  await letThrough('filtonly', '/filter-stock');
  await refused('filtonly', '/filters/services');
  await refused('filtonly', '/filters/service-plan');
  await letThrough('planonly', '/filters/service-plan');
  await refused('planonly', '/filters/services');
  // Writes need edit on the part they belong to.
  run("INSERT INTO roles (name, label) VALUES ('svcedit', 'svcedit')");
  for (const m of perms.MODULE_KEYS) perms.setPermission('svcedit', m, m === 'services' ? 'edit' : (m === 'filters' ? 'view' : 'none'));
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'svcedit', auth.hashPassword(PW)).lastInsertRowid;
  run("INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'svcedit'))", id);
  assert.strictEqual((await call('svcedit', 'POST', '/filters/prices', { filter_type: 'X' })).status, 403, 'price book: filters edit');
  assert.notStrictEqual((await call('svcedit', 'POST', '/filters/services', {})).status, 403, 'a service record: services edit');
});

test('Lubricant Capacities, the stock cockpit and the Alias Queue', async () => {
  await letThrough('lubeonly', '/lubricant-capacities');
  await refused('jobsonly', '/lubricant-capacities');
  await letThrough('storesonly', '/stock-cockpit/overview');
  await refused('jobsonly', '/stock-cockpit/overview');
  await letThrough('aliasonly', '/aliases');
  await letThrough('aliasonly', '/mechanics/aliases');
  await refused('jobsonly', '/aliases');
  await refused('jobsonly', '/aliases/pending');
  await refused('jobsonly', '/mechanics/aliases');
});

test('Needs Attention, Daily Progress, Cost Teardown and the Tyre & Battery ledger apart from Reports', async () => {
  await letThrough('attnonly', '/reports/service-due');
  await letThrough('attnonly', '/reports/integrity');
  await refused('attnonly', '/reports/monthly');
  await letThrough('progonly', `/reports/daily-progress?date=${today}`);
  await letThrough('progonly', '/reports/ongoing-jobs.html');
  await refused('progonly', '/reports/service-due');
  await letThrough('tearonly', `/reports/teardown/asset/${A}`);
  await refused('tearonly', '/reports/monthly');
  await letThrough('ledgeronly', '/tyre-battery/summary');
  await refused('ledgeronly', '/reports/monthly');
  await letThrough('reportsonly', '/reports/monthly');
  await letThrough('reportsonly', '/reports/ongoing-jobs.html');
  for (const p of ['/reports/service-due', `/reports/daily-progress?date=${today}`, `/reports/teardown/asset/${A}`, '/tyre-battery/summary']) {
    await refused('reportsonly', p);
  }
  // The Dashboard's parts follow the same switches.
  const d = (await call('reportsonly', 'GET', '/reports/dashboard')).body;
  assert.deepStrictEqual([d.needs_attention, d.field_down], [{}, null]);
  const a = (await call('admin', 'GET', '/reports/dashboard')).body;
  assert.ok(Object.keys(a.needs_attention).length && a.field_down != null);
});

test('Tyre & Battery Requests: reading the requests needs a T&B step; the register needs Stores; the pick-lists are open', async () => {
  await letThrough('tbonly', '/tb/requests');
  await letThrough('tbonly', '/tb/returns/outstanding');
  await letThrough('tbonly', `/tb/vehicle/${A}`);
  await refused('tbonly', '/tb/tyres');
  await letThrough('storesonly', '/tb/tyres');
  await letThrough('storesonly', `/tb/vehicle/${A}`);
  await refused('storesonly', '/tb/requests');
  for (const p of ['/tb/requests', '/tb/tyres', `/tb/vehicle/${A}`, '/tb/returns/summary']) await refused('nothing', p);
  for (const p of ['/tb/specs', '/tb/reasons']) await letThrough('nothing', p);
});

// ================================================================== the drop-down lists
test('the project and mechanic lists stay open for the pickers — names only without the section', async () => {
  const bare = (await call('nothing', 'GET', '/projects')).body;
  assert.deepStrictEqual(bare, [{ id: P, code: 'P-1', name: 'Harbour road', location: 'Colombo', active: 1 }]);
  const full = (await call('projonly', 'GET', '/projects')).body[0];
  assert.ok('month_cost' in full && 'asset_count' in full);
  await refused('nothing', `/projects/${P}`);
  await refused('nothing', `/projects/${P}/cost`);
  await refused('nothing', `/projects/${P}/sites`);
  await letThrough('projonly', `/projects/${P}`);
  const m = (await call('nothing', 'GET', '/mechanics')).body.find((x) => x.name === 'Anura');
  assert.ok(m && !('rate' in m), 'a mechanic\'s name, not the rate');
  assert.strictEqual((await call('labouronly', 'GET', '/mechanics')).body.find((x) => x.name === 'Anura').rate, 450);
  // The vehicle list fills the vehicle pickers in other sections: the numbers, not what it has cost.
  const v = (await call('nothing', 'GET', '/assets')).body.find((x) => x.id === A);
  assert.deepStrictEqual(Object.keys(v).sort(), ['asset_class', 'brand', 'code', 'ec_code', 'id', 'registration', 'type']);
  assert.ok('current_project' in (await call('assetsonly', 'GET', '/assets')).body.find((x) => x.id === A), 'with Assets, the full list');
  await letThrough('nothing', '/assets/search?q=EX');
  await refused('nothing', `/assets/${A}`);
  await refused('nothing', '/assets/export.xlsx');
  assert.strictEqual((await call('nothing', 'POST', '/assets', { code: 'X-1' })).status, 403);
  await refused('nothing', '/mechanics/rates');
  await refused('nothing', '/mechanics/unassigned');
  await letThrough('labouronly', '/mechanics/rates');
});

// ================================================================== nothing left open
test('a role that opens nothing is refused every section address on the server', async () => {
  const fill = (p) => p.replace(/:id\b[^/]*/g, String(J)).replace(':assetId', String(A)).replace(':month', '2026-01').replace(':kind', 'pending_parts')
    .replace(':aid', '1').replace(':ws', '1').replace(':what', 'open').replace(':jobId', String(J)).replace(':lineId', '1').replace(':grnId', '1')
    .replace(':photoId', '1').replace(':step(arrived|working)', 'arrived');
  const routers = {
    '/field': 'field', '/operations': 'operations', '/filters': 'filters', '/filter-stock': 'filter_stock', '/lubricant-capacities': 'lubricant_capacities',
    '/stock-cockpit': 'stock_cockpit', '/aliases': 'aliases', '/reports': 'reports', '/tyre-battery': 'tyre_battery', '/tb': 'tyre_battery_requests',
    '/projects': 'projects', '/mechanics': 'mechanics',
  };
  // Open on purpose: your own dashboard and approvals, and the lists that fill pickers.
  const open = new Set(['/reports/dashboard', '/reports/pending-approvals', '/reports/service-outside', '/tb/specs', '/tb/reasons', '/tb/specs/resolve',
    '/projects/', '/mechanics/', '/mechanics/resolve']);
  let n = 0;
  for (const [mount, file] of Object.entries(routers)) {
    for (const layer of require(`../src/routes/${file}`).stack.filter((l) => l.route && l.route.methods.get)) {
      const p = mount + fill(layer.route.path);
      if (open.has(mount + layer.route.path) || open.has(p)) continue;
      n++;
      await refused('nothing', p);
    }
  }
  assert.ok(n > 60, `every address walked (${n})`);
});
