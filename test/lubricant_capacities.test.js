'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-lubecap-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

for (const n of ['admin', 'storekeeper', 'workshop', 'mechanic', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}

// Admin user
const adminUid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'admin_lube', auth.hashPassword('admin123')).lastInsertRowid;
run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', adminUid, 'admin');

// Non-admin user (viewer / mechanic)
const viewerUid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'viewer_lube', auth.hashPassword('view123')).lastInsertRowid;
run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', viewerUid, 'mechanic');

const app = require('../src/server');
let server;
let base;
let adminCookie;
let viewerCookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Admin login
  const rAdmin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin_lube', password: 'admin123' }),
  });
  adminCookie = (rAdmin.headers.get('set-cookie') || '').split(';')[0];

  // Viewer login
  const rViewer = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'viewer_lube', password: 'view123' }),
  });
  viewerCookie = (rViewer.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => server && server.close());

const api = async (p, opts = {}, cookie = adminCookie) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('Seed sample data into vehicle_lubricant_capacities, evidence and other_equipment', () => {
  const capId = run(`
    INSERT INTO vehicle_lubricant_capacities (
      ec_no, registration, category, brand, model,
      engine_oil_l, engine_oil_grade,
      gearbox_oil_l, gearbox_oil_grade,
      diff_oil_l, diff_oil_grade,
      hydraulic_oil_l,
      coolant_l, brake_fluid_l,
      engine_oil_basis, engine_oil_records
    ) VALUES (
      'DA-01', 'WP-NA-1234', 'Dump Truck', 'CAT', '740',
      35.5, '15W40',
      18.0, '80W90',
      24.0, '85W140',
      120.0,
      45.0, 2.5,
      'Own record: average', 8
    )
  `).lastInsertRowid;

  assert.ok(capId > 0);

  run(`
    INSERT INTO lubricant_capacity_evidence (
      capacity_id, vehicle_raw, ec_no, registration, category, brand, model,
      component, qty_l, grade, source_sheet, source_row, record_date, note
    ) VALUES (
      ?, 'DA-01', 'DA-01', 'WP-NA-1234', 'Dump Truck', 'CAT', '740',
      'Engine Oil', 36.0, 'Mobil Delvac 15W40', 'Service Records', 105, '2026-03-01', 'Periodic service'
    )
  `, capId);

  run(`
    INSERT INTO other_equipment_capacities (
      equipment_name, component, qty_l, records_count, all_quantities
    ) VALUES (
      'Perkins 100kVA Generator', 'Engine Oil', 19.0, 4, '19, 19, 18.5, 19'
    )
  `);
});

test('GET /api/lubricant-capacities allows access to viewer and returns KPIs & records', async () => {
  const res = await api('/lubricant-capacities', {}, viewerCookie);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.strictEqual(res.body.items.length, 1);
  assert.strictEqual(res.body.items[0].ec_no, 'DA-01');
  assert.strictEqual(res.body.summary.total_vehicles, 1);
  assert.strictEqual(res.body.summary.count_engine_oil, 1);
});

test('GET /api/lubricant-capacities/:id returns spec plus attached service evidence', async () => {
  const listRes = await api('/lubricant-capacities', {}, viewerCookie);
  const item = listRes.body.items[0];

  const detailRes = await api(`/lubricant-capacities/${item.id}`, {}, viewerCookie);
  assert.strictEqual(detailRes.status, 200);
  assert.strictEqual(detailRes.body.item.ec_no, 'DA-01');
  assert.ok(Array.isArray(detailRes.body.evidence));
  assert.strictEqual(detailRes.body.evidence.length, 1);
  assert.strictEqual(detailRes.body.evidence[0].source_sheet, 'Service Records');
});

test('Non-admin user cannot mutate lubricant capacities (HTTP 403)', async () => {
  // Try POST
  const postRes = await api('/lubricant-capacities', {
    method: 'POST',
    body: { ec_no: 'EX-99', brand: 'Komatsu' }
  }, viewerCookie);
  assert.strictEqual(postRes.status, 403);

  // Try PUT
  const putRes = await api('/lubricant-capacities/1', {
    method: 'PUT',
    body: { engine_oil_l: 50 }
  }, viewerCookie);
  assert.strictEqual(putRes.status, 403);

  // Try DELETE
  const delRes = await api('/lubricant-capacities/1', {
    method: 'DELETE'
  }, viewerCookie);
  assert.strictEqual(delRes.status, 403);
});

test('Admin user can create, update, and delete vehicle capacity', async () => {
  // Create
  const createRes = await api('/lubricant-capacities', {
    method: 'POST',
    body: {
      ec_no: 'EX-05',
      registration: 'WP-EX-5555',
      brand: 'Komatsu',
      model: 'PC200',
      category: 'Excavator',
      engine_oil_l: 26,
      engine_oil_grade: '15W40',
      hydraulic_oil_l: 239,
      engine_oil_basis: 'OEM manual'
    }
  }, adminCookie);

  assert.strictEqual(createRes.status, 201);
  assert.ok(createRes.body.id > 0);
  const newId = createRes.body.id;

  // Update
  const updateRes = await api(`/lubricant-capacities/${newId}`, {
    method: 'PUT',
    body: {
      model: 'PC200-8 (Updated)',
      engine_oil_l: 28
    }
  }, adminCookie);
  assert.strictEqual(updateRes.status, 200);

  // Verify update
  const getRes = await api(`/lubricant-capacities/${newId}`, {}, adminCookie);
  assert.strictEqual(getRes.body.item.model, 'PC200-8 (Updated)');
  assert.strictEqual(getRes.body.item.engine_oil_l, 28);

  // Delete
  const delRes = await api(`/lubricant-capacities/${newId}`, {
    method: 'DELETE'
  }, adminCookie);
  assert.strictEqual(delRes.status, 200);

  // Verify deletion
  const getAfterDel = await api(`/lubricant-capacities/${newId}`, {}, adminCookie);
  assert.strictEqual(getAfterDel.status, 404);
});

test('Evidence and Other Equipment endpoints return seeded data', async () => {
  const evRes = await api('/lubricant-capacities/evidence?q=DA-01', {}, viewerCookie);
  assert.strictEqual(evRes.status, 200);
  assert.ok(Array.isArray(evRes.body.items));
  assert.strictEqual(evRes.body.items.length, 1);
  assert.strictEqual(evRes.body.items[0].component, 'Engine Oil');

  const eqRes = await api('/lubricant-capacities/other-equipment?q=Perkins', {}, viewerCookie);
  assert.strictEqual(eqRes.status, 200);
  assert.ok(Array.isArray(eqRes.body.items));
  assert.strictEqual(eqRes.body.items.length, 1);
  assert.strictEqual(eqRes.body.items[0].equipment_name, 'Perkins 100kVA Generator');
});

test('Frontend app.js registers lubecapacities under Operations in NAV and NAV_GROUP', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.ok(appJs.includes("['lubecapacities', '🛢️', 'Lubricant Capacities']"), 'NAV must have lubecapacities entry');
  assert.ok(appJs.includes("lubecapacities: 'Operations'"), 'NAV_GROUP must map lubecapacities to Operations');
  assert.ok(appJs.includes("routes.lubecapacities = async"), 'routes.lubecapacities must be defined');
});
