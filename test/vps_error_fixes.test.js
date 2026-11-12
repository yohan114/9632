'use strict';

// Three errors seen in the VPS logs (2026-11), each one a route that failed outright:
//
//   1. The asset photo gallery used `core.asset_images` / `core.users`. The `core` schema exists only
//      in multi-database mode; a single-database install (the VPS) has none, so startup logged
//      "unknown database core" and every gallery call failed "no such table: core.asset_images".
//   2. An MRN line on the local_purchase route with no unit price looked up `store_items.last_price`,
//      a column that does not exist ("no such column: last_price").
//   3. The dashboard's mechanics pulse filtered on `d.workshop_id`, but job_daily_work has no such
//      column. Only a person tied to a workshop gets the filter, which is why the other tests,
//      whose users have no workshop, never hit it.

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-vps-fixes-'));
process.env.DB_PATH = path.join(TMP, 'live.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, multidb } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');

migrate();
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('admin', 'admin')");
// A site lead who may read the dashboard and Daily Work. Not an admin: an admin counts as main-store
// staff, sees every workshop, and so never gets the workshop filter the third bug was in.
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('site_lead', 'Site lead')");
for (const m of ['dashboard', 'dailywork']) {
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('site_lead', ?, 'view')", m);
}
const PW = 'lantern-orchard-basalt';
function mkUser(username, role, workshopId = null) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)',
    username, auth.hashPassword(PW), workshopId).lastInsertRowid;
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, role);
  return id;
}
mkUser('boss', 'admin');
mkUser('lead', 'site_lead', workshops.defaultId());

const app = require('../src/server');
let server; let base;
const cookies = {};

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['boss', 'lead']) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: PW }),
    });
    cookies[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
});
test.after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

async function api(who, p, opts = {}) {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie: cookies[who] },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

test('the asset photo gallery works in single-database mode', async () => {
  assert.strictEqual(multidb.isMultiDb(), false, 'this test is about the single-database install');
  assert.ok(get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asset_images'"),
    'the table is created at startup in the only database there is');

  const assetId = require('../src/lib/aliases').findOrCreateAsset('IMG-01', {}).id;
  const up = await api('boss', `/assets/${assetId}/images`, {
    method: 'POST', body: { url: '/uploads/front.jpg', category: 'Exterior', title: 'Front' },
  });
  assert.strictEqual(up.status, 201, JSON.stringify(up.body));
  assert.strictEqual(up.body.category, 'exterior');

  const list = await api('boss', `/assets/${assetId}/images`);
  assert.strictEqual(list.status, 200, JSON.stringify(list.body));
  assert.deepStrictEqual(list.body.images.map((i) => [i.title, i.uploaded_by_username]), [['Front', 'boss']]);

  const edit = await api('boss', `/assets/images/${up.body.id}`, { method: 'PATCH', body: { title: 'Front, left' } });
  assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
  assert.strictEqual(edit.body.title, 'Front, left');

  const del = await api('boss', `/assets/images/${up.body.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.strictEqual((await api('boss', `/assets/${assetId}/images`)).body.images.length, 0);
});

test('a local-purchase MRN line with no price is checked against the item\'s estimated price', async () => {
  const assetId = require('../src/lib/aliases').findOrCreateAsset('MRN-LP-01', {}).id;
  const item = run("INSERT INTO store_items (name, unit_cost) VALUES ('Alternator belt', 1000)").lastInsertRowid;
  const made = await api('boss', '/stores/mrn', { method: 'POST', body: {
    mrn_no: 'LP-1', asset_id: assetId, requested_by: 'Storekeeper', purpose: 'repair',
    lines: [{ description: 'Fuel Filter', qty: 1, unit: 'nos' }],
  } });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const mrnId = made.body.mrn ? made.body.mrn.id : made.body.id;

  // 2 x Rs 1,000 (the item's unit cost) is inside the Rs 25,000 local-purchase ceiling.
  const ok = await api('boss', `/stores/mrn/${mrnId}/lines`, {
    method: 'POST', body: { store_item_id: item, description: 'Alternator belt', qty: 2, supply_route: 'local_purchase' },
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));

  // 30 x Rs 1,000 is over it: refused by the limit, not by an SQL error.
  const over = await api('boss', `/stores/mrn/${mrnId}/lines`, {
    method: 'POST', body: { store_item_id: item, description: 'Alternator belt', qty: 30, supply_route: 'local_purchase' },
  });
  assert.strictEqual(over.status, 403, JSON.stringify(over.body));

  // The newest priced receipt wins over the unit cost: at Rs 100 a piece, 30 fit.
  run("INSERT INTO grn (store_item_id, description, qty, unit_price) VALUES (?, 'Alternator belt', 1, 100)", item);
  const cheap = await api('boss', `/stores/mrn/${mrnId}/lines`, {
    method: 'POST', body: { store_item_id: item, description: 'Alternator belt', qty: 30, supply_route: 'local_purchase' },
  });
  assert.strictEqual(cheap.status, 201, JSON.stringify(cheap.body));

  // Moving an existing line onto the local-purchase route goes through the same estimate.
  const line = get('SELECT id FROM mrn_lines WHERE mrn_id = ? AND supply_route IS NOT \'local_purchase\' ORDER BY id LIMIT 1', mrnId)
    || get('SELECT id FROM mrn_lines WHERE mrn_id = ? ORDER BY id LIMIT 1', mrnId);
  run('UPDATE mrn_lines SET store_item_id = ? WHERE id = ?', item, line.id);
  const moved = await api('boss', `/stores/mrn/line/${line.id}`, { method: 'PATCH', body: { supply_route: 'local_purchase' } });
  assert.notStrictEqual(moved.status, 500, JSON.stringify(moved.body));
});

test('the workflow monitor works for someone tied to a workshop', async () => {
  const r = await api('lead', '/dashboard/workflow-monitor');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.mechanics_pulse, 'the mechanics pulse is worked out, not skipped');
});
