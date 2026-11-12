'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-fab5-'));
process.env.DB_PATH = path.join(TMP, 'fab5.db');
process.env.MULTIDB = '0';

const { migrate, run, get, all } = require('../src/db');
const monthly = require('../src/lib/monthly_cost_report');
const monthCosts = require('../src/lib/month_costs');
const workshops = require('../src/lib/workshops');

migrate();

const CW = workshops.defaultId();
const TODAY = new Date().toISOString().slice(0, 10);
const YM = TODAY.slice(0, 7);
const [YEAR, MONTH] = YM.split('-').map(Number);

let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, registration, status, in_register) VALUES (?, ?, ?, ?, 1)', code, code.replace(/\W/g, ''), code, 'active').lastInsertRowid;

test('Phase E: Fabrication costing, reporting, and mechanics KPI', async () => {
  // 1. Seed assets and mechanics
  const a1 = asset('FAB-TRUCK-1');
  const a2 = asset('FAB-TRAILER-2');
  const aRepair = asset('REP-LORRY-3');
  const aService = asset('SVC-VAN-4');

  run("INSERT INTO mechanics (name, name_norm) VALUES ('Sunil', 'SUNIL'), ('Kamal', 'KAMAL')");

  // 2. Closed Repair Card
  const repId = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, completed_at, workshop_id, material_cost)
    VALUES (?, ?, 'repair', 'Brake overhaul', 'CLOSED', ?, ?, ?, ?)`, `2026/11/R/${800 + (++seq)}`, aRepair, TODAY, TODAY, CW, 12000).lastInsertRowid;
  run('INSERT INTO job_labour (job_id, mechanic, hours, rate, amount, work_date) VALUES (?, ?, ?, 100, ?, ?)', repId, 'Kamal', 10, 1000, TODAY);
  run('INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, work_type) VALUES (?, ?, ?, ?, ?, ?)', repId, TODAY, 'Kamal', 'Brake pads', 10, 'repair');

  // 3. Service Job
  const svcId = run(`INSERT INTO service_jobs (job_no, asset_id, service_date, labour_charge, parts_subtotal, store_id)
    VALUES (?, ?, ?, ?, ?, ?)`, `2026/11/S/${800 + (++seq)}`, aService, TODAY, 2500, 7500, CW).lastInsertRowid;
  run('INSERT INTO job_daily_work (job_id, service_id, work_date, mechanic, description, hours, work_type) VALUES (?, ?, ?, ?, ?, ?, ?)', repId, svcId, TODAY, 'Kamal', 'Oil service', 5, 'service');

  // 4. Closed Fabrication Card
  const fabClosedId = run(`INSERT INTO job_cards (job_no, asset_id, type, fabrication_kind, description, status, requested_at, completed_at, workshop_id, issue_store_location_id, material_cost, total_cost)
    VALUES (?, ?, 'fabrication', 'body', 'Fabricate tipper body', 'CLOSED', ?, ?, ?, 1, ?, ?)`, `2026/11/F/${100 + (++seq)}`, a1, TODAY, TODAY, CW, 50000, 53000).lastInsertRowid;
  run('INSERT INTO job_labour (job_id, mechanic, hours, rate, amount, work_date) VALUES (?, ?, ?, 100, ?, ?)', fabClosedId, 'Sunil', 30, 3000, TODAY);
  run('INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, work_type) VALUES (?, ?, ?, ?, ?, ?)', fabClosedId, TODAY, 'Sunil', 'Tipper welding', 30, 'fabrication');

  // Issue materials to closed fabrication card
  const plateItem = run("INSERT INTO store_items (name, is_general, balance, unit_cost) VALUES ('Steel Plate 10mm', 1, 50, 500)").lastInsertRowid;
  run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, job_id, txn_date, store_id) VALUES (?, 'issue', -10, 40, ?, ?, ?)", plateItem, fabClosedId, TODAY, 1);
  run("INSERT INTO issues (issue_date, store_item_id, description, qty, unit_price, job_id, store_id) VALUES (?, ?, 'Steel Plate 10mm', 10, 500, ?, ?)", TODAY, plateItem, fabClosedId, 1);

  // 5. Pending Fabrication Card
  const fabPendingId = run(`INSERT INTO job_cards (job_no, asset_id, type, fabrication_kind, description, status, requested_at, workshop_id, issue_store_location_id)
    VALUES (?, ?, 'fabrication', 'canopy', 'Fabricate canopy structure', 'IN_PROGRESS', ?, ?, 1)`, `2026/11/F/${100 + (++seq)}`, a2, TODAY, CW).lastInsertRowid;
  run('INSERT INTO job_labour (job_id, mechanic, hours, rate, amount, work_date) VALUES (?, ?, ?, 100, ?, ?)', fabPendingId, 'Sunil', 15, 1500, TODAY);
  run('INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, work_type) VALUES (?, ?, ?, ?, ?, ?)', fabPendingId, TODAY, 'Sunil', 'Canopy bending', 15, 'fabrication');
  // Issue direct materials to pending fabrication card
  const beamItem = run("INSERT INTO store_items (name, is_general, balance, unit_cost) VALUES ('I-Beam 4x2', 1, 20, 1000)").lastInsertRowid;
  run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, job_id, txn_date, store_id) VALUES (?, 'issue', -5, 15, ?, ?, ?)", beamItem, fabPendingId, TODAY, 1);
  run("INSERT INTO issues (issue_date, store_item_id, description, qty, unit_price, job_id, store_id) VALUES (?, ?, 'I-Beam 4x2', 5, 1000, ?, ?)", TODAY, beamItem, fabPendingId, 1);

  // 6. Test monthCosts.monthlyRollup
  const rollups = monthCosts.monthlyRollup();
  const thisMonth = rollups.find((r) => r.month === YM) || {};
  assert.strictEqual(thisMonth.service, 2500, 'Service rollup labour charge');
  assert.strictEqual(thisMonth.fabrication, 53000, 'Fabrication rollup: total_cost of closed card');

  // 7. Test monthly.buildWorkbook
  const book = await monthly.buildWorkbook(YEAR, MONTH);

  // Assert Fabrication sheet exists and is structured
  const fabSheet = book.wb.getWorksheet('Fabrication cost');
  assert.ok(fabSheet, 'Fabrication cost worksheet generated');
  assert.strictEqual(book.parts.fabrication.count, 2, '2 fabrication jobs total (1 closed, 1 pending)');
  assert.strictEqual(book.parts.fabrication.closed_count, 1);
  assert.strictEqual(book.parts.fabrication.pending_count, 1);

  // Closed fabrication: labour 3000, material 50000 -> total 53000
  assert.strictEqual(book.parts.fabrication.closed_total, 53000);
  // Pending fabrication: labour 1500, material 5000 (from 5 I-Beams at 1000) -> total 6500
  assert.strictEqual(book.parts.fabrication.pending_total, 6500);
  assert.strictEqual(book.parts.fabrication.sums.total, 59500);

  // Assert Repair sheet does NOT include fabrication jobs
  assert.strictEqual(book.parts.repair.closed_count, 1);
  assert.deepStrictEqual(book.parts.repair.closed_jobs.map((j) => j.id), [repId]);
  assert.strictEqual(book.parts.repair.closed_total, 13000);

  // Assert Service sheet has the service job
  assert.strictEqual(book.parts.service.count, 1);
  assert.strictEqual(book.parts.service.sums.total, 10000);

  // Assert General Items sheet excludes materials issued to fabrication jobs (renderedJobIds deduplication)
  // Both plateItem (-10) and beamItem (-5) were issued to fabrication jobs, so neither leaks to general items
  assert.strictEqual(book.parts.general.sums.total, 0, 'No general items leaked from fabrication cards');

  // Assert Total cost sheet row 10 is Fabrication
  const totSheet = book.wb.getWorksheet('Total cost');
  assert.strictEqual(totSheet.getCell(10, 2).value, 'Fabrication');
  // Column 3 (Labour)
  assert.strictEqual(totSheet.getCell(10, 3).value.result, 4500, 'Fabrication total labour (3000+1500)');
  // Column 5 (Material)
  assert.strictEqual(totSheet.getCell(10, 5).value.result, 55000, 'Fabrication total material (50000+5000)');

  // 8. Test KPI API / daily work summary
  let server = null;
  try {
    const app = require('../src/server');
    server = await new Promise((res) => {
      const s = app.listen(0, '127.0.0.1', () => res(s));
    });
    const port = server.address().port;

    run("INSERT OR IGNORE INTO roles (name, label) VALUES ('admin', 'Admin')");
    const authUser = require('../src/lib/auth');
    const userId = run("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('kpi_tester', ?, 1, ?)", authUser.hashPassword('pass123'), CW).lastInsertRowid;
    const adminRoleId = get("SELECT id FROM roles WHERE name = 'admin'").id;
    run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", userId, adminRoleId);

    const loginRes = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', agent: false, headers: { 'Content-Type': 'application/json', Connection: 'close' } }, (res) => {
        let b = ''; res.on('data', (c) => b += c);
        res.on('end', () => resolve({ cookie: res.headers['set-cookie'] ? res.headers['set-cookie'][0].split(';')[0] : null, body: b }));
      });
      r.on('error', reject);
      r.write(JSON.stringify({ username: 'kpi_tester', password: 'pass123' }));
      r.end();
    });

    const kpiRes = await new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method: 'GET',
        path: `/api/daily-work/mechanics-kpi?month=${YM}`,
        agent: false,
        headers: { Cookie: loginRes.cookie, Connection: 'close' }
      }, (res) => {
        let b = ''; res.on('data', (c) => b += c);
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('Parse error: ' + b)); }
        });
      });
      r.on('error', reject);
      r.end();
    });

    assert.ok(kpiRes.mechanics, 'KPI summary returned mechanics list');
    const sunil = kpiRes.mechanics.find((m) => m.mechanic === 'Sunil');
    assert.ok(sunil, 'Sunil found in KPI report');
    assert.strictEqual(sunil.fabrication_hours, 45, 'Sunil has 45 fabrication hours logged (30 + 15)');
    assert.strictEqual(sunil.repair_hours, 0);
    assert.strictEqual(sunil.service_hours, 0);

    const kamal = kpiRes.mechanics.find((m) => m.mechanic === 'Kamal');
    assert.ok(kamal, 'Kamal found in KPI report');
    assert.strictEqual(kamal.repair_hours, 10, 'Kamal has 10 repair hours');
    assert.strictEqual(kamal.service_hours, 5, 'Kamal has 5 service hours');
    assert.strictEqual(kamal.fabrication_hours, 0);

    assert.strictEqual(kpiRes.summary.fabrication_hours, 45, 'Summary total fabrication hours is 45');
    assert.strictEqual(kpiRes.summary.repair_hours, 10);
    assert.strictEqual(kpiRes.summary.service_hours, 5);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
