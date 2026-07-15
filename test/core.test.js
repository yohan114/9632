'use strict';

// Isolated DB for this test file (node --test runs each file in its own process).
const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-core-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;

const test = require('node:test');
const assert = require('node:assert');
const { migrate, get, run } = require('../src/db');
const aliases = require('../src/lib/aliases');
const mechanics = require('../src/lib/mechanics');
const jobstate = require('../src/lib/jobstate');
const costing = require('../src/lib/costing');

migrate();

// ---- shared fixture ----
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 425, '2020-01-01')");
run("INSERT INTO products (id, code, name, unit, unit_price) VALUES (1, 'CI4', 'CI4', 'L', 1000)");
run("INSERT INTO product_prices (product_id, unit_price, effective_from) VALUES (1, 1000, '2020-01-01')");
const asset = aliases.findOrCreateAsset('28-4314', { brand: 'Toyota' });
const jobId = run(
  `INSERT INTO job_cards (job_no, asset_id, type, status, requested_at) VALUES ('T/1', ?, 'repair', 'REQUESTED', '2024-03-10')`,
  asset.id
).lastInsertRowid;

test('alias normalize + extract + resolve', () => {
  assert.strictEqual(aliases.normalize('28-4314'), '284314');
  assert.strictEqual(aliases.normalize('SL-08, Waker (HC401199)'), 'SL08WAKERHC401199');
  const r1 = aliases.resolveAsset('28-4314');
  assert.strictEqual(r1.resolved, true);
  assert.strictEqual(r1.assetId, asset.id);
  const r2 = aliases.resolveAsset('28-4314 Double Cab'); // extracted code
  assert.strictEqual(r2.assetId, asset.id);
  const r3 = aliases.resolveAsset('totally unknown machine XYZ');
  assert.strictEqual(r3.resolved, false);
  assert.ok(aliases.pendingAliases().some((a) => a.raw_norm === 'TOTALLYUNKNOWNMACHINEXYZ'));
});

test('state machine transitions honour state + role', () => {
  assert.strictEqual(jobstate.checkTransition('REQUESTED', 'APPROVED_TRANSPORT', ['transport_manager']).ok, true);
  assert.strictEqual(jobstate.checkTransition('REQUESTED', 'APPROVED_TRANSPORT', ['workshop']).ok, false);
  assert.strictEqual(jobstate.checkTransition('REQUESTED', 'CLOSED', ['admin']).ok, false); // illegal jump
  assert.strictEqual(jobstate.checkTransition('WORK_COMPLETE', 'CLOSED', ['operational_manager']).ok, true);
  // reopening a CLOSED card is admin-only
  assert.strictEqual(jobstate.checkTransition('CLOSED', 'IN_PROGRESS', ['workshop']).ok, false);
  assert.strictEqual(jobstate.checkTransition('CLOSED', 'IN_PROGRESS', ['admin']).ok, true);
});

test('costing rolls up labour + material + oil + external', () => {
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, '2024-03-10', 'Anura', 4)", jobId);
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'grn', 'part', 2, 500)", jobId);
  run("INSERT INTO job_daily_work (job_id, work_date, description, hours, is_external, external_value) VALUES (?, '2024-03-11', 'outside', 0, 1, 3000)", jobId);
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, job_id, txn_date) VALUES (1, 'issue', -10, 90, 1000, ?, '2024-03-10')", jobId);
  const c = costing.computeJobCost(jobId);
  assert.strictEqual(c.labour_cost, 1700);   // 4 * 425
  assert.strictEqual(c.material_cost, 1000); // 2 * 500
  assert.strictEqual(c.oil_cost, 10000);     // 10 * 1000
  assert.strictEqual(c.external_cost, 3000);
  assert.strictEqual(c.total_cost, 15700);
});

test('closure gate blocks an unpriced line, then clears', () => {
  assert.strictEqual(costing.closureReadiness(jobId).ready, true);
  const p = run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'grn', 'unpriced', 1, NULL)", jobId).lastInsertRowid;
  const blocked = costing.closureReadiness(jobId);
  assert.strictEqual(blocked.ready, false);
  assert.ok(blocked.missing.length >= 1);
  run('UPDATE job_parts SET unit_price = 250 WHERE id = ?', p);
  assert.strictEqual(costing.closureReadiness(jobId).ready, true);
});

test('mechanic split separates on comma/&/and but keeps slash-names whole', () => {
  assert.deepStrictEqual(mechanics.splitMechanics('Buddhika, Krishna'), ['Buddhika', 'Krishna']);
  assert.deepStrictEqual(mechanics.splitMechanics('Amal & Nuwan and Saman'), ['Amal', 'Nuwan', 'Saman']);
  assert.deepStrictEqual(mechanics.splitMechanics('Seethananda/seetha'), ['Seethananda/seetha']); // ONE person
  assert.deepStrictEqual(mechanics.splitMechanics('Anandan'), ['Anandan']); // internal "and" not split
});

test('mechanic resolver maps a spelling alias to the canonical rate', () => {
  const m = mechanics.findOrCreateMechanic('Seethananda/seetha');
  run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Seethananda/seetha', 250, '2020-01-01')");
  const link = mechanics.resolveMechanic('seetha', { source: 'test' });
  mechanics.linkMechanicAlias(link.aliasId, m.id);
  assert.strictEqual(mechanics.resolveMechanicName('seetha'), 'Seethananda/seetha');
  assert.strictEqual(costing.labourRateFor('seetha', '2024-03-10'), 250); // rate via alias
  // an unknown spelling stays pending, never lost
  mechanics.resolveMechanic('Vinod M', { source: 'test' });
  assert.ok(mechanics.pendingMechanicAliases().some((a) => a.raw_text === 'Vinod M'));
});

test('service jobs use a flat labour charge, not the hourly engine', () => {
  const sid = run(
    `INSERT INTO job_cards (job_no, asset_id, type, status, requested_at, flat_labour) VALUES ('T/S1', ?, 'service', 'REQUESTED', '2024-03-10', NULL)`,
    asset.id
  ).lastInsertRowid;
  // even with logged hours, a service with no flat charge costs 0 labour and can't close
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, '2024-03-10', 'Anura', 6)", sid);
  assert.strictEqual(costing.computeJobCost(sid).labour_cost, 0);
  assert.strictEqual(costing.closureReadiness(sid).ready, false); // flat charge not set
  // set the flat charge -> that IS the labour, hourly ignored
  run('UPDATE job_cards SET flat_labour = 1500 WHERE id = ?', sid);
  costing.refreshJobTotals(sid); // materialises job_labour rows (guards the NOT NULL path)
  assert.strictEqual(get('SELECT labour_cost FROM job_cards WHERE id = ?', sid).labour_cost, 1500);
  assert.strictEqual(costing.computeJobCost(sid).labour_cost, 1500);
  assert.strictEqual(costing.closureReadiness(sid).ready, true);
});

test('snapshot freezes the total even if a price later changes', () => {
  costing.snapshotJobCost(jobId);
  const snap = get('SELECT total_cost FROM job_costs WHERE job_id = ? ORDER BY id DESC LIMIT 1', jobId);
  const frozen = snap.total_cost;
  run("INSERT INTO product_prices (product_id, unit_price, effective_from) VALUES (1, 99999, '2025-01-01')");
  // recompute for a NEW job date would differ, but the snapshot must be unchanged
  const stillSnap = get('SELECT total_cost FROM job_costs WHERE job_id = ? ORDER BY id DESC LIMIT 1', jobId);
  assert.strictEqual(stillSnap.total_cost, frozen);
});
