'use strict';

// Phase C — every stock issue must name a job card. The vehicle comes from the job, so
// the two can never disagree; consumption with no vehicle goes to the General Workshop
// card, which is a real, selectable job card rather than a silent fallback.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-issue-job-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const aliases = require('../src/lib/aliases');
const costing = require('../src/lib/costing');
const stock = require('../src/lib/stock');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();
require('../src/migrate/26_subcategories').runStep();

for (const n of ['admin', 'storekeeper', 'workshop']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}
const asset = aliases.findOrCreateAsset('28-4314', {}).id;
const openJob = run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status) VALUES ('2026/7/R/1', ?, 'repair', 'gearbox', 'IN_PROGRESS')`, asset).lastInsertRowid;
const closedJob = run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status) VALUES ('2026/6/R/9', ?, 'repair', 'done', 'CLOSED')`, asset).lastInsertRowid;
run(`INSERT INTO store_items (name, item_no, unit, unit_cost, category, category_id)
     VALUES ('Head Lamp', 'ELE-0044', 'nos', 1200, 'Electrical',
             (SELECT c.id FROM item_categories c JOIN item_categories p ON p.id = c.parent_id
               WHERE p.name = 'Electrical' AND c.name = 'Lights & Lamps'))`);

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.strictEqual((await req('/api/auth/login', { method: 'POST', body: { username: 'sk', password: 'pw' } })).status, 200);
});
test.after(() => server && server.close());

async function req(path_, opts = {}) {
  const res = await fetch(base + path_, {
    method: opts.method || 'GET',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}
const issue = (body) => req('/api/stores/issues', { method: 'POST', body: { description: 'Head Lamp', qty: 1, unit_price: 1200, ...body } });

test('an issue with no job card is refused', async () => {
  const r = await issue({});
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Select the job card/i);
  assert.strictEqual(get('SELECT COUNT(*) c FROM issues').c, 0, 'nothing should have been recorded');
});

test('an unknown job card is refused', async () => {
  assert.strictEqual((await issue({ job_id: 99999 })).status, 400);
});

test('a service record can no longer stand in for a job card', async () => {
  const svc = run("INSERT INTO service_jobs (vehicle_label, asset_id) VALUES ('28-4314', ?)", asset).lastInsertRowid;
  const r = await issue({ service_id: svc });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Select the job card/i);
});

test('an issue on an open job takes its vehicle from the job', async () => {
  const r = await issue({ job_id: openJob });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.issue.job_id, openJob);
  assert.strictEqual(r.body.issue.asset_id, asset, 'the vehicle is derived from the job card');
});

test('the vehicle cannot be set independently of the job', async () => {
  const other = aliases.findOrCreateAsset('LO-5981', {}).id;
  const r = await issue({ job_id: openJob, asset_id: other, asset: 'LO-5981' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.issue.asset_id, asset, 'the job card wins — a stray asset_id is ignored');
});

test('a closed job needs an explicit confirmation, and is audited', async () => {
  const blocked = await issue({ job_id: closedJob });
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.needs_confirm, true);
  assert.strictEqual(blocked.body.job_status, 'CLOSED');

  const confirmed = await issue({ job_id: closedJob, allow_closed: true });
  assert.strictEqual(confirmed.status, 201);
  const entry = get(`SELECT reason FROM audit_log WHERE entity = 'issue' AND entity_id = ? ORDER BY id DESC LIMIT 1`, confirmed.body.issue.id);
  assert.match(entry.reason, /late issue against CLOSED/);
});

test('the General Workshop card is a real job card the picker can offer', async () => {
  const g = await req('/api/stores/general-job');
  assert.strictEqual(g.status, 200);
  assert.ok(g.body.id);
  const r = await issue({ job_id: g.body.id, description: 'Cotton Waste' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.issue.job_id, g.body.id);
  assert.strictEqual(r.body.issue.asset_id, null, 'general consumption has no vehicle, but still has a job card');
  // Reused, never duplicated.
  assert.strictEqual((await req('/api/stores/general-job')).body.id, g.body.id);
  assert.strictEqual(get("SELECT COUNT(*) c FROM job_cards WHERE legacy_ref = 'general-workshop'").c, 1);
});

test('every issue costs onto its job card exactly once', async () => {
  const costing = require('../src/lib/costing');
  const before = costing.computeJobCost(openJob).material_cost;
  const r = await issue({ job_id: openJob, description: 'Head Lamp', qty: 2, unit_price: 500 });
  assert.strictEqual(r.status, 201);
  const after = costing.computeJobCost(openJob).material_cost;
  assert.strictEqual(Math.round((after - before) * 100) / 100, 1000);
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_parts WHERE source_type = ? AND source_id = ?', 'issue', r.body.issue.id).c, 1);
});

test('the vehicle month rollup keeps total = sum of its parts', async () => {
  const row = get('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ? ORDER BY id DESC LIMIT 1', asset);
  const sum = ['parts_cost', 'fuel_cost', 'oil_cost', 'filter_cost', 'battery_cost', 'labour_cost']
    .reduce((n, k) => n + (row[k] || 0), 0);
  assert.strictEqual(Math.round(sum * 100) / 100, Math.round(row.total_cost * 100) / 100);
});

test('the issue list exposes the job card it was filed against', async () => {
  const list = await req('/api/stores/issues?limit=50');
  assert.ok(list.body.every((i) => i.job_id), 'every new issue carries a job card');
  assert.ok(list.body.some((i) => i.job_no === '2026/7/R/1'));
});

test('the item search offers a last known price', async () => {
  const r = await req('/api/stores/items/search?q=head lamp');
  assert.strictEqual(r.status, 200);
  const item = r.body.find((i) => i.item_no === 'ELE-0044');
  assert.strictEqual(item.last_price, 1200); // falls back to the maintained unit cost

  // Imported receipts carry no store_item_id — they match on the description instead.
  run("INSERT INTO grn (description, qty, unit_price) VALUES ('head lamp ', 1, 1380)");
  assert.strictEqual((await req('/api/stores/items/search?q=head lamp')).body
    .find((i) => i.item_no === 'ELE-0044').last_price, 1380, 'a name-matched GRN beats the static unit cost');

  // A receipt actually linked to the item wins over the name match.
  run("INSERT INTO grn (store_item_id, description, qty, unit_price) VALUES (?, 'Head Lamp', 1, 1450)", item.id);
  assert.strictEqual((await req('/api/stores/items/search?q=head lamp')).body
    .find((i) => i.item_no === 'ELE-0044').last_price, 1450, 'the linked GRN wins');
});

// ---------------------------------------------------------------------------
// Issuing something that was RECEIVED for the vehicle.
//
// The receipt is already the cost: a GRN line against a job's MRN is materialised as a
// source_type='grn' job_part, and computeJobCost sums every job_part. So handing the part
// over must record the movement WITHOUT charging the job a second time.
// ---------------------------------------------------------------------------
test('issuing a received line does not charge the job twice', async () => {
  const mrn = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status)
                   VALUES ('900001', '2026-03-01', ?, ?, 'received')`, asset, openJob).lastInsertRowid;
  const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, category)
                    VALUES (?, 'Brake Shoe Set', 4, 4, 'Brakes & Clutch')`, mrn).lastInsertRowid;
  const grn = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                   VALUES (?, ?, 'Brake Shoe Set', 4, 1500, '2026-03-05')`, mrn, line).lastInsertRowid;
  // the receipt is already costed to the job, exactly as the importer/receiving flow does
  run(`INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price, is_external_repair)
       VALUES (?, 'grn', ?, ?, 'Brake Shoe Set', 4, 1500, 0)`, openJob, grn, line);

  const costBefore = costing.computeJobCost(openJob).material_cost;
  const partsBefore = get('SELECT COUNT(*) c FROM job_parts WHERE job_id = ?', openJob).c;

  const r = await req('/api/stores/stock-issue', {
    method: 'POST',
    body: { job_id: openJob, issue_date: '2026-03-10', issued_by: 'sk', lines: [{ grn_id: grn, qty: 3 }] },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.issued[0].costed_now, false, 'the receipt already carried the cost');

  assert.strictEqual(costing.computeJobCost(openJob).material_cost, costBefore,
    'handing the part over must not add cost the receipt already booked');
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_parts WHERE job_id = ?', openJob).c, partsBefore,
    'no second job_part for the same MRN line');

  // but the movement and the handover record must exist, tied back to the request line
  const issue = get("SELECT * FROM issues WHERE description = 'Brake Shoe Set'");
  assert.ok(issue, 'the handover is recorded');
  assert.strictEqual(issue.qty, 3);
  const move = get("SELECT * FROM stock_moves WHERE source_table = 'issues' AND source_id = ?", issue.id);
  assert.strictEqual(move.kind, 'out');
  assert.strictEqual(move.mrn_line_id, line, 'the movement points back at the request line');

  // and the line now shows 1 of 4 left
  const left = stock.receivedLines({ assetId: asset, includeDone: true }).find((x) => x.mrn_line_id === line);
  assert.strictEqual(left.issued, 3);
  assert.strictEqual(left.remaining, 1);
});

test('a receipt that never reached a job IS costed when issued', async () => {
  const mrn = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status)
                   VALUES ('900002', '2026-03-01', ?, 'received')`, asset).lastInsertRowid;
  const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, category)
                    VALUES (?, 'Loose Bolt Pack', 2, 2, 'Hardware & Fasteners')`, mrn).lastInsertRowid;
  const grn = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                   VALUES (?, ?, 'Loose Bolt Pack', 2, 250, '2026-03-05')`, mrn, line).lastInsertRowid;
  // deliberately NO job_part — nothing has charged this to a job

  const before = costing.computeJobCost(openJob).material_cost;
  const r = await req('/api/stores/stock-issue', {
    method: 'POST',
    body: { job_id: openJob, issue_date: '2026-03-10', issued_by: 'sk', lines: [{ grn_id: grn, qty: 2 }] },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.issued[0].costed_now, true, 'unaccounted cost must land somewhere');
  assert.strictEqual(costing.computeJobCost(openJob).material_cost, before + 500);
});

// A split delivery: ONE request line received in two separate GRNs. `issued` must be counted
// per receipt — a per-request-line total gets subtracted from both rows at once and makes stock
// that is physically on the shelf disappear from the panel.
test('a split delivery tracks each receipt separately', async () => {
  const mrn = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status)
                   VALUES ('900003', '2026-04-01', ?, ?, 'received')`, asset, openJob).lastInsertRowid;
  const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, category)
                    VALUES (?, 'Wheel Stud', 10, 10, 'Hardware & Fasteners')`, mrn).lastInsertRowid;
  const a = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                 VALUES (?, ?, 'Wheel Stud', 6, 300, '2026-04-05')`, mrn, line).lastInsertRowid;
  const b = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                 VALUES (?, ?, 'Wheel Stud', 4, 300, '2026-04-09')`, mrn, line).lastInsertRowid;

  const r = await req('/api/stores/stock-issue', {
    method: 'POST',
    body: { job_id: openJob, issue_date: '2026-04-10', issued_by: 'sk', lines: [{ grn_id: a, qty: 6 }] },
  });
  assert.strictEqual(r.status, 201);

  const rows = stock.receivedLines({ assetId: asset, includeDone: true });
  const first = rows.find((x) => x.grn_id === a);
  const second = rows.find((x) => x.grn_id === b);
  assert.strictEqual(first.remaining, 0, 'the receipt that was handed out is empty');
  assert.strictEqual(second.issued, 0, 'the OTHER delivery of the same line is untouched');
  assert.strictEqual(second.remaining, 4, 'its 4 pieces are still on the shelf');
});

// Filters/batteries/tyres/oil open from a cut-over: their older receipts are history and were
// never added to the balance (counts = 0). Handing one out must not push the section negative.
test('issuing a cut-over receipt does not move the section balance', async () => {
  const mrn = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status)
                   VALUES ('900004', '2026-04-01', ?, ?, 'received')`, asset, openJob).lastInsertRowid;
  const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, category)
                    VALUES (?, 'Air Filter (A-9999)', 2, 2, 'Filters')`, mrn).lastInsertRowid;
  const grn = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                   VALUES (?, ?, 'Air Filter (A-9999)', 2, 900, '2026-04-05')`, mrn, line).lastInsertRowid;
  // the receipt as history — exactly how the cut-over records filter purchases
  run(`INSERT INTO stock_moves (section, kind, item_key, item_name, qty, txn_date, source_table, source_id, counts)
       VALUES ('filter', 'in', ?, 'Air Filter (A-9999)', 2, '2026-04-05', 'grn', ?, 0)`,
    require('../src/lib/stock').itemKey('filter', 'Air Filter (A-9999)'), grn);

  const bal = () => get(`SELECT ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0
        WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),0),2) v
      FROM stock_moves WHERE section = 'filter' AND item_key = ?`,
  require('../src/lib/stock').itemKey('filter', 'Air Filter (A-9999)')).v;

  assert.strictEqual(bal(), 0, 'a history receipt does not count toward the balance');
  const r = await req('/api/stores/stock-issue', {
    method: 'POST',
    body: { job_id: openJob, issue_date: '2026-04-10', issued_by: 'sk', lines: [{ grn_id: grn, qty: 2 }] },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(bal(), 0, 'and neither does handing it out — no phantom negative');
});

// Half now, half later, on a receipt nothing has costed yet. Both halves must reach the job.
test('both halves of a split handover are costed when the receipt was not', async () => {
  const mrn = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status)
                   VALUES ('900005', '2026-04-01', ?, 'received')`, asset).lastInsertRowid;
  const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, category)
                    VALUES (?, 'Split Cost Item', 4, 4, 'Hardware & Fasteners')`, mrn).lastInsertRowid;
  const grn = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                   VALUES (?, ?, 'Split Cost Item', 4, 100, '2026-04-05')`, mrn, line).lastInsertRowid;
  // deliberately no source_type='grn' job_part — this money is unaccounted for

  const before = costing.computeJobCost(openJob).material_cost;
  for (const q of [2, 2]) {
    const r = await req('/api/stores/stock-issue', {
      method: 'POST',
      body: { job_id: openJob, issue_date: '2026-04-10', issued_by: 'sk', lines: [{ grn_id: grn, qty: q }] },
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.issued[0].costed_now, true, 'every part of an uncosted receipt is costed');
  }
  assert.strictEqual(costing.computeJobCost(openJob).material_cost, before + 400,
    'all 4 pieces reach the job, not just the first 2');
});

test('an unresolvable line is reported, not silently dropped', async () => {
  const r = await req('/api/stores/stock-issue', {
    method: 'POST',
    body: { job_id: openJob, issued_by: 'sk', lines: [{ grn_id: 99999999, qty: 1 }, { stock_item_id: 88888888, qty: 1 }] },
  });
  assert.strictEqual(r.status, 400, 'nothing could be issued at all');
  assert.match(r.body.error, /no longer exists|not in the catalogue/);
});

// Rebuilding the ledger must not resurrect stock that was handed out, and must not start
// counting pre-cut-over issues that were never counted in (that regression turned the whole
// filter section negative when it slipped through once).
test('a ledger rebuild preserves handovers and the cut-over rule', async () => {
  const mrn = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status)
                   VALUES ('900006', '2026-05-01', ?, ?, 'received')`, asset, openJob).lastInsertRowid;
  const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, category)
                    VALUES (?, 'Rebuild Widget', 5, 5, 'Hardware & Fasteners')`, mrn).lastInsertRowid;
  const grn = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                   VALUES (?, ?, 'Rebuild Widget', 5, 80, '2026-05-05')`, mrn, line).lastInsertRowid;

  await req('/api/stores/stock-issue', {
    method: 'POST',
    body: { job_id: openJob, issue_date: '2026-05-06', issued_by: 'sk', lines: [{ grn_id: grn, qty: 2 }] },
  });
  assert.strictEqual(stock.receivedLine(grn).remaining, 3);

  stock.rebuild({ wipe: true });

  assert.strictEqual(stock.receivedLine(grn).remaining, 3,
    'the handover survives — 2 pieces must not come back onto the shelf');
  const move = get("SELECT * FROM stock_moves WHERE source_table = 'issues' AND grn_id = ?", grn);
  assert.ok(move, 'the movement is rebuilt with its receipt link intact');
  assert.strictEqual(move.mrn_line_id, line);
});

// vehicle_monthly_costs.parts_cost is defined as an absolute Σ(issues.qty × unit_price) — that
// is what migrate/015 recomputes from. A handover that writes an issues row without bumping it
// makes the stored rollup disagree with its own definition, and the number then moves on its
// own the next time migrations run.
test('a receipt handover keeps the vehicle rollup equal to its own definition', async () => {
  const mrn = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status)
                   VALUES ('900007', '2026-06-01', ?, ?, 'received')`, asset, openJob).lastInsertRowid;
  const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, category)
                    VALUES (?, 'Rollup Part', 2, 2, 'Hardware & Fasteners')`, mrn).lastInsertRowid;
  const grn = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                   VALUES (?, ?, 'Rollup Part', 2, 5000, '2026-06-05')`, mrn, line).lastInsertRowid;
  // already costed to the job at receipt — the branch that used to skip the rollup
  run(`INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price, is_external_repair)
       VALUES (?, 'grn', ?, ?, 'Rollup Part', 2, 5000, 0)`, openJob, grn, line);

  const r = await req('/api/stores/stock-issue', {
    method: 'POST',
    body: { job_id: openJob, issue_date: '2026-06-10', issued_by: 'sk', lines: [{ grn_id: grn, qty: 2 }] },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.issued[0].costed_now, false, 'the job is not charged twice');

  const stored = get('SELECT parts_cost, total_cost, fuel_cost, oil_cost, filter_cost, battery_cost, labour_cost FROM vehicle_monthly_costs WHERE asset_id = ? AND year = 2026 AND month = 6', asset);
  const definition = get(`SELECT ROUND(COALESCE(SUM(qty * COALESCE(unit_price,0)),0),2) v FROM issues
                           WHERE asset_id = ? AND substr(issue_date,1,7) = '2026-06'`, asset).v;
  assert.strictEqual(Math.round(stored.parts_cost * 100) / 100, definition,
    'parts_cost must equal the sum of that vehicle-month\'s issues');
  const components = ['fuel_cost', 'oil_cost', 'filter_cost', 'battery_cost', 'parts_cost', 'labour_cost']
    .reduce((s, c) => s + (stored[c] || 0), 0);
  assert.strictEqual(Math.round(stored.total_cost * 100) / 100, Math.round(components * 100) / 100,
    'and total_cost stays Σ(components)');
});
