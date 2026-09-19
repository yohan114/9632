'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-stock-cockpit-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'storekeeper', 'workshop', 'manager']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk_cockpit', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper', 'workshop', 'manager']) {
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sk_cockpit', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => server && server.close());

const api = async (p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('GET /api/stock-cockpit/overview returns accurate consolidated valuations and reorder alerts', async () => {
  // Seed General stock items
  run(`INSERT INTO store_items (name, item_no, category, unit, balance, min_stock, unit_cost, is_general)
       VALUES ('Safety Helmet', 'GEN-01', 'Safety Gear', 'nos', 5, 20, 1500, 1)`);
  run(`INSERT INTO store_items (name, item_no, category, unit, balance, min_stock, unit_cost, is_general)
       VALUES ('Welding Rods', 'GEN-02', 'Welding', 'pkt', 0, 10, 800, 1)`);

  // Seed Filter stock
  run(`INSERT INTO filter_stock (filter_type, part_no, qty_in_stock, reorder_level, unit_cost)
       VALUES ('Oil Filter', 'OF-TEST-1', 2, 10, 3000)`);
  run(`INSERT INTO filter_stock (filter_type, part_no, qty_in_stock, reorder_level, unit_cost)
       VALUES ('Air Filter', 'AF-TEST-2', 0, 5, 4500)`);

  // Seed Product (Oil)
  const pid = run(`INSERT INTO products (code, name, unit, reorder_level, unit_price)
                   VALUES ('OIL-TEST', 'Synthetic 10W40', 'L', 50, 1200)`).lastInsertRowid;
  run(`INSERT INTO stock_ledger (product_id, kind, qty, unit_price, balance_after, txn_date)
       VALUES (?, 'receipt', 20, 1200, 20, date('now'))`, pid);

  const res = await api('/stock-cockpit/overview');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.total_valuation > 0, 'Total valuation should be > 0');
  assert.ok(res.body.valuation_breakdown, 'Valuation breakdown must be present');
  assert.strictEqual(typeof res.body.valuation_breakdown.general, 'number');
  assert.strictEqual(typeof res.body.valuation_breakdown.oil, 'number');
  assert.strictEqual(typeof res.body.valuation_breakdown.filters, 'number');

  // Verify reorder alerts
  const alerts = res.body.reorder_alerts;
  assert.ok(Array.isArray(alerts));
  assert.ok(alerts.length >= 4, 'Should detect at least 4 seeded low-stock items');

  // Check alert contents
  const oilAlert = alerts.find((a) => a.section === 'oil' && a.name === 'Synthetic 10W40');
  assert.ok(oilAlert, 'Oil alert must be present');
  assert.strictEqual(oilAlert.shortfall, 30); // 50 reorder - 20 current = 30 shortfall

  const criticalGen = alerts.find((a) => a.code === 'GEN-02');
  assert.ok(criticalGen, 'Critical general item should be in alerts');
  assert.strictEqual(criticalGen.urgency, 'CRITICAL');
});

test('GET /api/stock-cockpit/search searches across all categories and filters by status', async () => {
  // Search by text
  const searchRes = await api('/stock-cockpit/search?q=helmet');
  assert.strictEqual(searchRes.status, 200);
  assert.strictEqual(searchRes.body.length, 1);
  assert.strictEqual(searchRes.body[0].code, 'GEN-01');

  // Filter by section
  const filterSec = await api('/stock-cockpit/search?section=filter');
  assert.strictEqual(filterSec.status, 200);
  assert.ok(filterSec.body.every((it) => it.section === 'filter'));

  // Filter by status=critical
  const critRes = await api('/stock-cockpit/search?status=critical');
  assert.strictEqual(critRes.status, 200);
  assert.ok(critRes.body.every((it) => it.status === 'critical'));
});

test('POST /api/stock-cockpit/create-reorder-mrn generates a restock MRN with shortfall lines', async () => {
  const payload = {
    purpose: 'Quarterly Workshop Restock',
    items: [
      {
        section: 'general',
        name: 'Safety Helmet',
        qty: 15,
        unit: 'nos',
        category: 'Safety Gear',
        reorder_level: 20,
      },
      {
        section: 'filter',
        name: 'Oil Filter (OF-TEST-1)',
        qty: 8,
        unit: 'nos',
        category: 'Filters',
        reorder_level: 10,
      },
    ],
  };

  const res = await api('/stock-cockpit/create-reorder-mrn', {
    method: 'POST',
    body: payload,
  });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.mrn_id > 0);
  assert.ok(res.body.mrn_no);
  assert.strictEqual(res.body.lines_count, 2);

  // Verify in database
  const mrn = get('SELECT * FROM mrn WHERE id = ?', res.body.mrn_id);
  assert.strictEqual(mrn.request_type, 'general');
  assert.strictEqual(mrn.purpose, 'Quarterly Workshop Restock');

  const lines = get('SELECT COUNT(*) AS c FROM mrn_lines WHERE mrn_id = ?', res.body.mrn_id);
  assert.strictEqual(lines.c, 2);
});
