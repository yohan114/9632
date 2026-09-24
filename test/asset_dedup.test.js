'use strict';

// Vehicle de-duplication — a registered vehicle has TWO identities (an E&C number in
// `code` and a plate in `registration`); usage-created rows name the plate. This step
// folds those onto the canonical, and refuses to guess when a row is ambiguous.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-asset-dedup-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();

const asset = (code, reg, ec, inReg) => run(
  'INSERT INTO assets (code, code_norm, registration, ec_code, in_register) VALUES (?, ?, ?, ?, ?)',
  code, String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''), reg, ec, inReg).lastInsertRowid;

// The real vehicle: E&C number DC-10, plate 28-4314.
const canonical = asset('DC-10', '28-4314', 'DC-10', 1);
// Two rows the importer minted from free text on job cards / MRNs.
const v1 = asset('28-4314 Double cab', null, null, 0);
const v2 = asset('28-4314 Nissan D20', null, null, 0);
// A different vehicle that merely shares digits — must NOT be touched.
const unrelated = asset('ZB-4314', null, null, 0);
// Ambiguous: names a second real plate.
const twoPlates = asset('LP-1579 / LP-1581', null, null, 0);
const lpCanonical = asset('DT-69', 'LP-1579', 'DT-69', 1);
// Two registered vehicles claiming the same plate → contested, nobody folds onto it.
asset('XX-01', 'AB-1111', 'XX-01', 1);
asset('XX-02', 'AB-1111', 'XX-02', 1);
const contestedVariant = asset('AB-1111 Tipper', null, null, 0);

run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, total_cost) VALUES ('J/1', ?, 'repair', 'canonical work', 'CLOSED', 100)`, canonical);
run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, total_cost) VALUES ('J/2', ?, 'repair', 'variant work', 'CLOSED', 250)`, v1);
run(`INSERT INTO mrn (mrn_no, asset_id, purpose) VALUES ('900001', ?, 'parts')`, v2);
run('INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost) VALUES (?, 2026, 5, 300, 300)', canonical);
run('INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost) VALUES (?, 2026, 5, 200, 200)', v1);
run('INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost) VALUES (?, 2026, 9, 75, 75)', v2);

const step = require('../src/migrate/27_asset_dedup_dual_identity');

test('a dry run reports the folds but changes nothing', () => {
  const before = get('SELECT COUNT(*) c FROM assets').c;
  const rep = step.runStep({ apply: false });
  assert.strictEqual(rep.folded, 0);
  assert.strictEqual(get('SELECT COUNT(*) c FROM assets').c, before);
  assert.ok(rep.folds.some((f) => f.variant_id === v1 && f.canonical_id === canonical));
  assert.ok(rep.folds.some((f) => f.variant_id === v2 && f.canonical_id === canonical));
});

test('the ambiguous ones are reported, never guessed at', () => {
  const rep = step.runStep({ apply: false });
  assert.ok(rep.folds.every((f) => f.variant_id !== twoPlates), 'a row naming two plates must not fold');
  assert.ok(rep.skipped_second_plate.some((s) => s.variant_id === twoPlates));
  assert.ok(rep.folds.every((f) => f.variant_id !== contestedVariant), 'a plate claimed by two vehicles must not fold');
  assert.ok(rep.skipped_shared_identity.some((s) => s.variant_id === contestedVariant));
  assert.ok(rep.folds.every((f) => f.variant_id !== unrelated), 'a different plate must not fold');
  void lpCanonical;
});

test('applying folds the variants onto the real vehicle', () => {
  const rep = step.runStep({ apply: true });
  assert.strictEqual(rep.folded, 2);
  assert.strictEqual(get('SELECT COUNT(*) c FROM assets WHERE id IN (?, ?)', v1, v2).c, 0);
  assert.ok(get('SELECT id FROM assets WHERE id = ?', canonical), 'the registered vehicle survives');
  assert.ok(get('SELECT id FROM assets WHERE id = ?', unrelated), 'ZB-4314 is untouched');
});

test('every record moves with it — nothing is lost or duplicated', () => {
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_cards WHERE asset_id = ?', canonical).c, 2);
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn WHERE asset_id = ?', canonical).c, 1);
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_cards').c, 2, 'no job card was deleted');
  const orphans = get(`SELECT COUNT(*) c FROM job_cards WHERE asset_id IS NOT NULL AND asset_id NOT IN (SELECT id FROM assets)`).c;
  assert.strictEqual(orphans, 0);
});

test('overlapping month rollups are summed, not dropped, and stay reconciled', () => {
  const may = get('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ? AND year = 2026 AND month = 5', canonical);
  assert.strictEqual(may.parts_cost, 500, '300 canonical + 200 folded');
  assert.strictEqual(may.total_cost, 500);
  const sep = get('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ? AND year = 2026 AND month = 9', canonical);
  assert.strictEqual(sep.total_cost, 75, 'a non-overlapping month is moved across');
  const breaches = get(`SELECT COUNT(*) c FROM vehicle_monthly_costs
                         WHERE ABS(total_cost - (COALESCE(parts_cost,0)+COALESCE(fuel_cost,0)+COALESCE(oil_cost,0)
                                 +COALESCE(filter_cost,0)+COALESCE(battery_cost,0)+COALESCE(labour_cost,0))) > 0.01`).c;
  assert.strictEqual(breaches, 0, 'total must still equal the sum of its components');
});

test('the old spellings keep resolving, so history and imports still land', () => {
  for (const raw of ['28-4314 Double cab', '28-4314 Nissan D20']) {
    const al = get('SELECT asset_id, resolved FROM asset_aliases WHERE raw_text = ?', raw);
    assert.strictEqual(al.asset_id, canonical);
    assert.strictEqual(al.resolved, 1);
  }
});

test('re-running is a no-op', () => {
  const rep = step.runStep({ apply: true });
  assert.strictEqual(rep.folded, 0);
  assert.strictEqual(rep.folds.length, 0);
});
