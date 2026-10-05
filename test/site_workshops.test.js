'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-site-ws-'));
process.env.DB_PATH = path.join(TMP, 'sitews.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const stores = require('../src/lib/stores');
const scope = require('../src/lib/scope');

migrate();

for (const n of ['admin', 'workshop', 'operational_manager', 'manager', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}

const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name, place) VALUES ('MTR', 'Muthur Workshop', 'Muthur')").lastInsertRowid;
const PW = 'ember-harbour-quarry';

function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)',
    username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) {
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  }
  return id;
}

const U = {
  boss: mkUser('boss', ['admin']),
  wsC: mkUser('wsC', ['workshop'], CW),
  wsM: mkUser('wsM', ['workshop'], MTR),
  wsStrict: mkUser('wsStrict', ['workshop'], MTR),
};

// wsStrict explicitly has jobs.view_other_workshops revoked to test refusal without capability
run("INSERT INTO user_capabilities (user_id, capability, granted) VALUES (?, 'jobs.view_other_workshops', 0)", U.wsStrict);

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const TODAY = day(0);

let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)',
  code, code.replace(/\W/g, ''), 'active').lastInsertRowid;

const job = (assetId, ws, status = 'IN_PROGRESS', extra = {}) => run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id)
   VALUES (?, ?, 'repair', ?, ?, 0, ?, ?)`,
  `2026/10/R/${800 + (++seq)}`, assetId, extra.description || 'fault report', status, day(-2), ws
).lastInsertRowid;

const V = { c: asset('C-ASSET'), m: asset('M-ASSET') };
const J = { c: job(V.c, CW), m: job(V.m, MTR) };

const app = require('../src/server');
let server;
let port;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
});

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* ignore non-json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    const r = await req('POST', '/api/auth/login', { body: { username: user, password: PW } });
    assert.strictEqual(r.status, 200, r.text);
    cookies[user] = r.cookie;
  }
  return cookies[user];
}

// ============================================================================
// Turn separation on so workshops are scoped
// ============================================================================
test('activate separate workshops', async () => {
  const boss = await as('boss');
  const r = await req('PUT', '/api/workshops/separate', { cookie: boss, body: { on: true } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(scope.switchedOn(), true);
  assert.strictEqual(scope.enabled(), true);
});

// ============================================================================
// Job cards: cross-workshop read-only view
// ============================================================================
test('cross-workshop reading: a site workshop sees foreign job cards as read-only', async () => {
  const wsM = await as('wsM');
  const list = (await req('GET', '/api/jobs', { cookie: wsM })).body;
  const central = list.find((j) => j.id === J.c);
  const muthur = list.find((j) => j.id === J.m);

  assert.ok(central, 'central job is visible to muthur user');
  assert.strictEqual(central.read_only, true, 'central job marked read_only for muthur');
  assert.ok(muthur, 'muthur job is visible to muthur user');
  assert.strictEqual(muthur.read_only, false, 'muthur job is NOT read_only for muthur');

  // Single card GET
  const detailCentral = (await req('GET', `/api/jobs/${J.c}`, { cookie: wsM })).body;
  assert.strictEqual(detailCentral.job.id, J.c);
  assert.strictEqual(detailCentral.job.read_only, true);

  const detailMuthur = (await req('GET', `/api/jobs/${J.m}`, { cookie: wsM })).body;
  assert.strictEqual(detailMuthur.job.id, J.m);
  assert.strictEqual(detailMuthur.job.read_only, false);
});

test('without capability, foreign card is refused with 403', async () => {
  const wsStrict = await as('wsStrict');
  const list = (await req('GET', '/api/jobs', { cookie: wsStrict })).body;
  assert.ok(!list.some((j) => j.id === J.c), 'foreign card not visible in list without capability');

  const res = await req('GET', `/api/jobs/${J.c}`, { cookie: wsStrict });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /belongs to Central Workshop/);
});

test('vehicle page shows foreign card as reachable but read-only', async () => {
  const wsM = await as('wsM');
  const assetData = (await req('GET', `/api/assets/${V.c}`, { cookie: wsM })).body;
  assert.ok(assetData.open_jobs.length > 0);
  const j = assetData.open_jobs[0];
  assert.strictEqual(j.id, J.c);
  assert.strictEqual(j.reachable, true);
  assert.strictEqual(j.read_only, true);
});

// ============================================================================
// Walk the jobcards router stack: all write actions on foreign card refused (403)
// ============================================================================
test('every mutating route under /api/jobs/:id refuses foreign card with 403', async () => {
  const wsM = await as('wsM');
  const jobcardsRouter = require('../src/routes/jobcards');
  let tested = 0;

  for (const layer of jobcardsRouter.stack.filter((l) => l.route)) {
    const routePath = layer.route.path;
    if (!routePath.includes(':id')) continue;

    for (const [method, active] of Object.entries(layer.route.methods)) {
      if (!active || method.toLowerCase() === 'get' || method.toLowerCase() === 'head') continue;

      const path_ = '/api/jobs' + routePath.replace(':id', String(J.c));
      const r = await req(method.toUpperCase(), path_, {
        cookie: wsM,
        body: { description: 'hack', to: 'CLOSED', hours: 5, qty: 1 }
      });

      assert.strictEqual(r.status, 403, `${method.toUpperCase()} ${path_} must be 403 for foreign card, got ${r.status}`);
      assert.match(r.body.error || '', /belongs to Central Workshop/, `${method.toUpperCase()} ${path_} error message`);
      tested++;
    }
  }

  assert.ok(tested >= 8, `walked at least 8 mutating route handlers (walked ${tested})`);
});

// ============================================================================
// Service records: workshop stamping and cross-workshop read-only
// ============================================================================
test('service records: stamped with workshop_id and readable across workshops', async () => {
  const wsM = await as('wsM');
  const wsC = await as('wsC');

  // Record a service from Central
  const sc = (await req('POST', '/api/filters/services', {
    cookie: wsC,
    body: { asset_id: V.c, service_date: TODAY, service_type: '500h', workshop_id: CW, filters: [], oils: [], parts: [] }
  })).body;
  assert.ok(sc.service && sc.service.id);
  assert.strictEqual(sc.service.workshop_id, CW);

  // Muthur reads Central service
  const sList = (await req('GET', '/api/filters/services', { cookie: wsM })).body;
  const centralSvc = sList.find((s) => s.id === sc.service.id);
  assert.ok(centralSvc);
  assert.strictEqual(centralSvc.read_only, true);

  const detail = (await req('GET', `/api/filters/services/${sc.service.id}`, { cookie: wsM })).body;
  assert.strictEqual(detail.service.read_only, true);

  // Muthur cannot edit Central service
  const editRes = await req('PUT', `/api/filters/services/${sc.service.id}`, {
    cookie: wsM,
    body: { asset_id: V.c, service_date: TODAY, service_type: '1000h' }
  });
  assert.strictEqual(editRes.status, 403);
  assert.match(editRes.body.error, /belongs to Central Workshop/);
});

// ============================================================================
// 4-step Workshop Setup & Readiness
// ============================================================================
test('4-step workshop setup: creates workshop row, store, assigns users, and readiness indicators', async () => {
  const boss = await as('boss');

  const created = workshops.create({ id: U.boss }, {
    code: 'SITE1',
    name: 'Site Workshop One',
    place: 'Muthur South',
    own_store: true,
    store_opened: TODAY,
    user_ids: [U.wsM],
    enable_separation: true,
  });

  assert.strictEqual(created.code, 'SITE1');
  assert.strictEqual(created.own_store, 1);
  assert.strictEqual(created.store_opened, TODAY);

  // User U.wsM reassigned to SITE1
  const updatedUser = get('SELECT workshop_id FROM users WHERE id = ?', U.wsM);
  assert.strictEqual(updatedUser.workshop_id, created.id);

  // Readiness calculation in workshops.list()
  const list = workshops.list();
  const site1 = list.find((w) => w.id === created.id);
  assert.ok(site1);
  assert.ok(site1.readiness);
  assert.strictEqual(site1.readiness.ready, false);
  assert.strictEqual(site1.readiness.no_mechanics, true);
  assert.strictEqual(site1.readiness.no_stock, true);
  assert.strictEqual(site1.readiness.nobody_assigned, false); // wsM was assigned
});

// ============================================================================
// Scoped D7 Screens: Tools, Tyres/Batteries, Oil, General Stock
// ============================================================================
test('tools list is scoped by workshop', async () => {
  const boss = await as('boss');
  const wsM = await as('wsM');
  const wsUser = get('SELECT workshop_id FROM users WHERE id = ?', U.wsM);

  // Insert tools for Central and Muthur/Site workshop
  const tC = (await req('POST', '/api/tools', {
    cookie: boss,
    body: { name: 'Central Torque Wrench', category: 'Hand Tools', workshop_id: CW }
  })).body;
  const tM = (await req('POST', '/api/tools', {
    cookie: boss,
    body: { name: 'Muthur Angle Grinder', category: 'Power Tools', workshop_id: wsUser.workshop_id }
  })).body;

  const toolsMuthur = (await req('GET', '/api/tools', { cookie: wsM })).body;
  const ids = (toolsMuthur.tools || []).map((t) => t.id);
  assert.ok(ids.includes(tM.id), 'Muthur tool is listed');
  assert.ok(!ids.includes(tC.id), 'Central tool is not listed for Muthur user');

  // Muthur cannot mutate Central tool
  assert.strictEqual((await req('PATCH', `/api/tools/${tC.id}`, { cookie: wsM, body: { name: 'Altered' } })).status, 403);
  assert.strictEqual((await req('DELETE', `/api/tools/${tC.id}`, { cookie: wsM })).status, 403);
});
