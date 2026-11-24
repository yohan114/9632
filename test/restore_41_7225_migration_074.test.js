'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mig074-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const aliases = require('../src/lib/aliases');
const siteSummary = require('../src/lib/billing/site_summary');
const mig074 = require('../src/migrate/074_restore_41_7225_double_cab');

test.after(() => {
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('Migration 074 restores 41-7225 as E&C Double Cab, merges 41-7225 Crew Cab, sets standard Double Cab rates & restores old-month billing', () => {
  migrate();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run(`
    INSERT INTO projects (id, code, name, name_norm, active)
    VALUES
      (38, 'CEP-03F',         'CEP-03 F (Galagedara)', 'cep-03 f (galagedara)', 1),
      (14, 'Badalgama Plant', 'Badalgama Plant',       'badalgama plant',       1)
  `);
  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('tk-38', 'T38', 'Galagedara Tank', 'FIXED', 'AUTO_DIESEL', 20000, 15000, 38, 1),
      ('tk-14', 'T14', 'Badalgama Tank',  'FIXED', 'AUTO_DIESEL', 20000, 15000, 14, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, current_project_id, status, in_register, ownership, notes, created_at, updated_at)
    VALUES
      (750, '41-7225',          '417225',        NULL, NULL, 'Excluded Vehicle (billed outside)', 'vehicle', 'KM',   38,   'active', 0, 'HIRED', 'Ownership: HIRED — external / outside-billed (rental & fuel paid outside, excluded from site bill)', datetime('now'), datetime('now')),
      (878, '41-7225 Crew Cab', '417225CREWCAB', NULL, NULL, NULL,                                'vehicle', NULL, NULL, 'active', 0, 'OWNED', NULL, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO job_cards (id, job_no, asset_id, type, description, status, workshop_id)
    VALUES
      (3850, '2026/11/R/817', 750, 'repair', 'Alternator repair', 'CLOSED', 1),
      (3293, '2026/5/R/303',  878, 'repair', 'Stores materials for 41-7225 Crew Cab', 'CLOSED', 1)
  `);

  run(`
    INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, owner_code, basis, origin, locked, is_current, active)
    VALUES
      ('va-08', 'AUTO-750-38-2026-08', 750, '41-7225', 38, 'CEP-03 F (Galagedara)', '2026-08', 'HIRED', 'BILLED_DIRECT', 'AUTO_FUEL', 0, 0, 1),
      ('va-09', 'AUTO-750-38-2026-09', 750, '41-7225', 38, 'CEP-03 F (Galagedara)', '2026-09', 'HIRED', 'BILLED_DIRECT', 'AUTO_FUEL', 0, 0, 1),
      ('va-10', 'AUTO-750-38-2026-10', 750, '41-7225', 38, 'CEP-03 F (Galagedara)', '2026-10', 'HIRED', 'BILLED_DIRECT', 'AUTO_FUEL', 0, 0, 1)
  `);

  run(`
    INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, end_date, billing_type, origin)
    VALUES
      ('fa-08', 750, '41-7225', 38, '2026-08-01', '2026-08-31', 'BILLED_DIRECT', 'FUEL'),
      ('fa-09', 750, '41-7225', 38, '2026-09-01', '2026-09-30', 'BILLED_DIRECT', 'FUEL'),
      ('fa-10', 750, '41-7225', 38, '2026-10-01', '2026-10-31', 'BILLED_DIRECT', 'FUEL')
  `);

  run(`
    INSERT INTO fuel_issues (id, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, total_cost_cents, issue_date, source_tank_id, project_id, is_direct_billed, is_voided)
    VALUES
      ('fi-07', 750, '41-7225', '41-7225', 'AUTO_DIESEL', 20,  38700, 774000,   '2026-07-25', 'tk-14', 14, 1, 0),
      ('fi-08', 750, '41-7225', '41-7225', 'AUTO_DIESEL', 251, 38437, 9647700,  '2026-08-10', 'tk-38', 38, 1, 0),
      ('fi-09', 750, '41-7225', '41-7225', 'AUTO_DIESEL', 306, 38200, 11689200, '2026-09-12', 'tk-38', 38, 1, 0),
      ('fi-10', 750, '41-7225', '41-7225', 'AUTO_DIESEL', 374, 39200, 14660800, '2026-10-15', 'tk-38', 38, 1, 0)
  `);

  const res1 = mig074.runMigration(rawDb);
  assert.equal(res1.assetRestored, 1);
  assert.equal(res1.crewCabMerged, true);
  assert.equal(res1.rateUpserted, 1);
  assert.equal(res1.fuelIssuesRestored, 4);
  assert.equal(res1.allocsRestored, 3);
  assert.equal(res1.assignmentsRestored, 3);

  assert.deepEqual(rawDb.prepare('PRAGMA foreign_key_check').all(), []);

  // Canonical asset restored & duplicate Crew Cab merged
  const a41 = get('SELECT * FROM assets WHERE id = 750');
  assert.equal(a41.ownership, 'OWNED');
  assert.equal(a41.in_register, 1);
  assert.equal(a41.type, 'Double Cab');
  assert.equal(a41.registration, '41-7225');
  assert.equal(a41.meter_type, 'KM');
  assert.equal(a41.notes, null);
  assert.equal(get('SELECT * FROM assets WHERE id = 878'), undefined);
  assert.equal(get('SELECT COUNT(*) AS c FROM job_cards WHERE asset_id = 750').c, 2);
  assert.equal(aliases.resolveAsset('41-7225 Crew Cab').assetId, 750);

  // Standard Double Cab rate card verified
  const rc = get('SELECT * FROM fleet_rental_rates WHERE asset_id = 750');
  assert.equal(rc.category_name, 'Double Cab (Pickup)');
  assert.equal(rc.rate_basis, 'KM');
  assert.equal(rc.dry_rate_cents, 4500);
  assert.equal(rc.wet_rate_cents, 7000);
  assert.equal(rc.fully_wet_rate_cents, 11000);
  assert.ok(Math.abs(rc.fuel_cons_typ - 0.1) < 1e-9);

  // Fuel, allocations & assignments restored
  for (const r of all('SELECT is_direct_billed FROM fuel_issues WHERE asset_id = 750')) {
    assert.equal(r.is_direct_billed, 0);
  }
  for (const r of all('SELECT owner_code, basis FROM fleet_vehicle_allocations WHERE asset_id = 750')) {
    assert.equal(r.owner_code, 'E&C');
    assert.equal(r.basis, 'WET');
  }
  for (const r of all('SELECT billing_type FROM fleet_asset_assignments WHERE asset_id = 750')) {
    assert.equal(r.billing_type, 'WET');
  }

  // Strict idempotency
  const res2 = mig074.runMigration(rawDb);
  assert.equal(res2.assetRestored, 0);
  assert.equal(res2.crewCabMerged, false);
  assert.equal(res2.rateUpserted, 0);
  assert.equal(res2.fuelIssuesRestored, 0);
  assert.equal(res2.allocsRestored, 0);
  assert.equal(res2.assignmentsRestored, 0);

  // CEP-03F Site Summary bills across 2026-08, 2026-09, 2026-10 at Double Cab Rs 70/km + 10 km/L
  const sOct = siteSummary.buildSiteSummary(38, '2026-10');
  assert.deepEqual(sOct.unrated, []);
  assert.deepEqual(sOct.billedDirect, []);
  assert.equal(sOct.lines.length, 1);
  assert.equal(sOct.lines[0].code, '41-7225');
  assert.equal(sOct.lines[0].rateCents, 7000);
  assert.equal(sOct.lines[0].consRefUnits, 3740);
  assert.equal(sOct.lines[0].billableUnits, 3740);
  assert.equal(sOct.lines[0].billedOn, 'fuel');
  assert.equal(sOct.lines[0].rentalCents, 26180000);
  assert.equal(sOct.lines[0].fuelCostCents, 14660800);

  const sSep = siteSummary.buildSiteSummary(38, '2026-09');
  assert.deepEqual(sSep.unrated, []);
  assert.equal(sSep.lines[0].consRefUnits, 3060);
  assert.equal(sSep.lines[0].billableUnits, 3060);
  assert.equal(sSep.lines[0].rentalCents, 21420000);
  assert.equal(sSep.lines[0].fuelCostCents, 11689200);

  const sAug = siteSummary.buildSiteSummary(38, '2026-08');
  assert.deepEqual(sAug.unrated, []);
  assert.equal(sAug.lines[0].consRefUnits, 2510);
  assert.equal(sAug.lines[0].billableUnits, 3000);
  assert.equal(sAug.lines[0].billedOn, 'minimum');
  assert.equal(sAug.lines[0].rentalCents, 21000000);
  assert.equal(sAug.lines[0].fuelCostCents, 9647700);
});
