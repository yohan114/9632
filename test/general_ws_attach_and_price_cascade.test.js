'use strict';

/**
 * Tests reproducing the exact 2026/11/R/811 failure pattern and verifying the fix:
 * 1) MRN issued onto GENERAL-WS (before the real job card existed) surfaces with
 *    general_ws_part_id + general_ws_min_no + attached_this_job = 0 on GET /api/jobs/:id
 *    and shows vehicle / MIN / MRN details in GET /api/jobs/unassigned/parts.
 * 2) Pricing the GRN later via /api/stores/grn/bulk-price updates issues.total_cost,
 *    stock_moves.unit_price ('in' and 'out'), and vehicle_monthly_costs.
 * 3) Claiming the GENERAL-WS part via POST /api/jobs/:id/parts/attach moves
 *    job_parts, issues, stock_moves, min_notes, and unlinked mrn onto the real job card
 *    and updates its material_cost.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-gws-cascade-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.MULTIDB = '0';
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const aliases = require('../src/lib/aliases');

migrate();

for (const n of ['admin', 'workshop', 'storekeeper']) run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)', 'wseng', auth.hashPassword('pw'), 'Workshop User').lastInsertRowid;
for (const r of ['workshop', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

const ASSET = aliases.findOrCreateAsset('WB-18').id;
const CATCH = run(`INSERT INTO job_cards (job_no, type, description, status, requested_by, requested_at, is_historical, synthesized_no, legacy_ref)
   VALUES ('GENERAL-WS', 'repair', 'General workshop stores issues', 'WORK_COMPLETE', 'system', date('now'), 0, 1, 'general-workshop')`).lastInsertRowid;

const JOB = run(`INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at)
   VALUES ('2026/11/R/811', 'repair', 'Clutch repair', 'IN_PROGRESS', ?, 'wseng', '2026-10-31')`, ASSET).lastInsertRowid;

// MRN raised without job_id, received unpriced on GRN, issued onto GENERAL-WS
const MRN = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status) VALUES ('165043', '2026-10-24', ?, NULL, 'received')`, ASSET).lastInsertRowid;
const MRN_LINE = run(`INSERT INTO mrn_lines (mrn_id, description, category, qty, qty_received, unit) VALUES (?, 'Release Bearing', 'General Items', 1, 1, 'nos')`, MRN).lastInsertRowid;
const GRN = run(`INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES ('8786', ?, ?, 'Release Bearing', 1, NULL, '2026-10-24')`, MRN, MRN_LINE).lastInsertRowid;
run(`INSERT INTO stock_moves (section, kind, item_key, item_name, qty, unit_price, txn_date, asset_id, job_id, mrn_line_id, source_table, source_id, ref)
     VALUES ('general', 'in', 'release bearing', 'Release Bearing', 1, NULL, '2026-10-24', ?, NULL, ?, 'grn', ?, '8786')`, ASSET, MRN_LINE, GRN);

const MIN = run(`INSERT INTO min_notes (min_no, issue_date, asset_id, job_id, status) VALUES ('MIN-3730', '2026-10-25', ?, ?, 'issued')`, ASSET, CATCH).lastInsertRowid;
const ISS = run(`INSERT INTO issues (asset_id, job_id, grn_id, description, qty, unit_price, issue_date, min_id, min_no)
                 VALUES (?, ?, ?, 'Release Bearing', 1, NULL, '2026-10-25', ?, 'MIN-3730')`, ASSET, CATCH, GRN, MIN).lastInsertRowid;
run(`INSERT INTO stock_moves (section, kind, item_key, item_name, qty, unit_price, txn_date, asset_id, job_id, mrn_line_id, grn_id, source_table, source_id)
     VALUES ('general', 'out', 'release bearing', 'Release Bearing', 1, NULL, '2026-10-25', ?, ?, ?, ?, 'issues', ?)`, ASSET, CATCH, MRN_LINE, GRN, ISS);
const PART = run(`INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price)
                  VALUES (?, 'issue', ?, ?, 'Release Bearing', 1, NULL)`, CATCH, ISS, MRN_LINE).lastInsertRowid;

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wseng', password: 'pw' }),
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

test('1. Unassigned GENERAL-WS issued MRN item is flagged cleanly on GET /api/jobs/:id and enriched in /unassigned/parts', async () => {
  const detail = await api('/jobs/' + JOB);
  assert.strictEqual(detail.status, 200);
  const ml = detail.body.mrnItems.find((m) => m.mrn_line_id === MRN_LINE);
  assert.ok(ml, 'MRN line appears in job detail');
  assert.strictEqual(ml.attached_this_job, 0);
  assert.strictEqual(ml.general_ws_part_id, PART);
  assert.strictEqual(ml.general_ws_min_no, 'MIN-3730');

  const picker = await api('/jobs/unassigned/parts?asset_id=' + ASSET + '&q=MIN-3730');
  assert.strictEqual(picker.status, 200);
  const row = picker.body.parts.find((p) => p.id === PART);
  assert.ok(row, 'MIN-3730 part found by MIN search');
  assert.strictEqual(row.asset_id, ASSET);
  assert.strictEqual(row.asset_code, 'WB-18');
  assert.strictEqual(row.min_no, 'MIN-3730');
  assert.strictEqual(row.mrn_no, '165043');
  assert.strictEqual(row.grn_no, '8786');
});

test('2. Pricing GRN via bulk-price updates issues.total_cost, stock_moves.unit_price, and vehicle_monthly_costs', async () => {
  const res = await api('/stores/grn/bulk-price', {
    method: 'POST',
    body: { rows: [{ id: GRN, unit_price: 16000 }] },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  const iss = get('SELECT unit_price FROM issues WHERE id = ?', ISS);
  assert.strictEqual(iss.unit_price, 16000);
  assert.strictEqual(get('SELECT unit_price FROM job_parts WHERE id = ?', PART).unit_price, 16000);
  assert.strictEqual(get("SELECT unit_price FROM stock_moves WHERE source_table = 'grn' AND source_id = ?", GRN).unit_price, 16000);
  assert.strictEqual(get("SELECT unit_price FROM stock_moves WHERE source_table = 'issues' AND source_id = ?", ISS).unit_price, 16000);
  const vmc = get('SELECT parts_cost, total_cost FROM vehicle_monthly_costs WHERE asset_id = ? AND year = 2026 AND month = 10', ASSET);
  assert.strictEqual(vmc.parts_cost, 16000);
});

test('3. Attaching GENERAL-WS issue part cascades job_id to issues, stock_moves, min_notes, unlinked mrn, and updates job material_cost', async () => {
  const res = await api(`/jobs/${JOB}/parts/attach`, {
    method: 'POST',
    body: { parts: [PART] },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.attached, 1);
  assert.strictEqual(res.body.value, 16000);

  assert.strictEqual(get('SELECT job_id FROM job_parts WHERE id = ?', PART).job_id, JOB);
  assert.strictEqual(get('SELECT job_id FROM issues WHERE id = ?', ISS).job_id, JOB);
  assert.strictEqual(get("SELECT job_id FROM stock_moves WHERE source_table = 'issues' AND source_id = ?", ISS).job_id, JOB);
  assert.strictEqual(get('SELECT job_id FROM min_notes WHERE id = ?', MIN).job_id, JOB);
  assert.strictEqual(get('SELECT job_id FROM mrn WHERE id = ?', MRN).job_id, JOB);
  assert.strictEqual(get('SELECT material_cost FROM job_cards WHERE id = ?', JOB).material_cost, 16000);

  const detailAfter = await api('/jobs/' + JOB);
  const ml = detailAfter.body.mrnItems.find((m) => m.mrn_line_id === MRN_LINE);
  assert.strictEqual(ml.attached_this_job, 1);
  assert.strictEqual(ml.general_ws_part_id, null);
});
