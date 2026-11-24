'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mig069-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const aliases = require('../src/lib/aliases');
const mig069 = require('../src/migrate/069_merge_zb0050_into_za0050');

test.after(() => {
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('Migration 069 merges ZB-0050* assets, sums overlapping monthly costs, resolves FKs & text refs into TM-21 (ZA-0050)', () => {
  migrate();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (5, 'MTR', 'Mutur Plant', 'mutur plant', 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP03', 'Galagedara Site', 'galagedara site', 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (40, 'CEP03W', 'Wadakada Site', 'wadakada site', 1)");
  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('tk-1', 'T1', 'Gala Tank', 'FIXED', 'AUTO_DIESEL', 10000, 5000, 38, 1)");

  run(`
    INSERT INTO assets (id, code, code_norm, registration, ec_code, brand, type, model_no, asset_class, home_project_id, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (47, 'TM-21', 'TM21', 'ZA-0050', 'TM-21', 'TATA', 'Truck  Mixer', 'LPK 1618', 'plant', NULL, NULL, 'active', 1, datetime('now'), datetime('now')),
      (488, 'ZB-0050', 'ZB0050', NULL, NULL, NULL, NULL, NULL, 'vehicle', 5, 38, 'active', 0, datetime('now'), datetime('now')),
      (795, 'ZB-0050 TATA 2576', 'ZB0050TATA2576', NULL, NULL, NULL, NULL, NULL, 'vehicle', NULL, NULL, 'active', 0, datetime('now'), datetime('now')),
      (1311, 'ZB-0050 rear engine', 'ZB0050REARENGINE', NULL, NULL, NULL, NULL, NULL, 'vehicle', NULL, NULL, 'active', 0, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, fuel_cons_basis, fuel_cons_typ, equip_type, default_basis)
    VALUES
      ('r-47', 47, 'Truck Mixer', 'HOURLY', 225000, 225000, 446000, 446000, 'hr', 7.5, 'FLEET', 'DRY'),
      ('r-488', 488, 'Truck Mixer', 'HOURLY', 225000, 225000, 305000, 446000, NULL, NULL, 'FLEET', 'DRY')
  `);

  run(`
    INSERT INTO fuel_issues (id, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, total_cost_cents, issue_date, source_tank_id, project_id, import_key, is_voided)
    VALUES
      ('fi-1', 47, 'TM-21', 'ZA-0050', 'AUTO_DIESEL', 25, 29400, 735000, '2026-08-05', 'tk-1', 40, NULL, 0),
      ('fi-2', 488, 'ZB-0050', 'ZB-0050', 'AUTO_DIESEL', 40, 29400, 1176000, '2026-11-16', 'tk-1', 38, 'gala-nov-2026-ZB0050-r83-d16', 0)
  `);

  run(`
    INSERT INTO vehicle_monthly_costs (id, asset_id, year, month, fuel_cost, oil_cost, filter_cost, battery_cost, parts_cost, labour_cost, total_cost)
    VALUES
      (1, 47, 2026, 8, 27090, 0, 0, 0, 5000, 0, 32090),
      (2, 488, 2026, 8, 170280, 0, 0, 0, 0, 0, 170280),
      (3, 488, 2026, 11, 41160, 0, 0, 0, 0, 0, 41160)
  `);

  run(`
    INSERT INTO vehicle_filter_schedules (id, asset_id, category, part_no, part_no_norm, qty, every_n_services, active)
    VALUES
      (10, 47, 'Engine Oil Filter', 'TM21-OIL', 'TM21OIL', 1, 1, 1),
      (11, 488, 'Engine Oil Filter', 'ZB-OIL', 'ZBOIL', 1, 1, 1),
      (12, 1311, 'Hydraulic Filter', 'REAR-HYD', 'REARHYD', 1, 1, 1)
  `);

  run(`
    INSERT INTO service_jobs (id, vehicle_label, asset_id, service_date, service_type, workshop_id)
    VALUES
      (1, 'ZB-0050 (TM-21)', 47, '2024-07-26', 'full', 1),
      (2, 'ZB-0050 rear engine', 1311, '2023-11-22', 'full', 1)
  `);

  run(`
    INSERT INTO job_cards (id, job_no, asset_id, type, description, status, workshop_id)
    VALUES
      (1, '2026/6/R/403', 795, 'repair', 'Stores materials for ZB-0050 TATA 2576', 'CLOSED', 1)
  `);

  run(`
    INSERT INTO tyre_battery_issues (id, kind, issue_date, vehicle, asset_id, qty, category, row_hash, store_id)
    VALUES (1, 'tyre', '2024-10-15', 'ZB-0050', 488, 1, '1000X20', 'rh-1', 1)
  `);

  run(`
    INSERT INTO filter_catalogue (id, category, oem_pn, oem_pn_norm, top_vehicle)
    VALUES (1, 'Engine Oil Filter', 'OEM1', 'OEM1', 'ZB-0050 (TM-21) REAR')
  `);
  run(`
    INSERT INTO filter_stock (id, filter_type, part_no, compatible_assets)
    VALUES (1, 'Engine Oil Filter', 'P1', 'Machinery · ZA-8445, ZB-0050, ZA-8033')
  `);
  run(`
    INSERT INTO daily_report_snapshots (id, kind, report_date, workshop_id, row_count, payload)
    VALUES (1, 'daily', '2026-11-20', 1, 1, '{"vehicle":"ZB-0050"}')
  `);

  const res = mig069.runMigration(rawDb);
  assert.equal(res.targetId, 47);
  assert.equal(res.targetCode, 'TM-21');
  assert.deepEqual(res.mergedAssetIds, [488, 795, 1311]);
  assert.equal(res.fuelIssuesUpdated, 1);

  // Duplicate assets deleted & target metadata preserved
  assert.equal(all('SELECT id FROM assets WHERE id IN (488, 795, 1311)').length, 0);
  const tm21 = get('SELECT * FROM assets WHERE id = 47');
  assert.equal(tm21.registration, 'ZA-0050');
  assert.equal(tm21.home_project_id, 5);
  assert.equal(tm21.current_project_id, 38);

  // Foreign key check clean
  assert.equal(rawDb.prepare('PRAGMA foreign_key_check').all().length, 0);

  // Only TM-21's canonical rate remains
  const rates = all('SELECT * FROM fleet_rental_rates WHERE asset_id = 47');
  assert.equal(rates.length, 1);
  assert.equal(rates[0].wet_rate_cents, 446000);

  // Fuel issues merged onto asset 47 & ZA-0050
  const fi2 = get("SELECT * FROM fuel_issues WHERE id = 'fi-2'");
  assert.equal(fi2.asset_id, 47);
  assert.equal(fi2.asset_code, 'TM-21');
  assert.equal(fi2.vehicle_ref, 'ZA-0050');
  assert.equal(fi2.import_key, 'gala-nov-2026-ZA0050-r83-d16');

  // Overlapping monthly costs summed cleanly, non-overlapping moved
  const aug = get('SELECT * FROM vehicle_monthly_costs WHERE asset_id = 47 AND year = 2026 AND month = 8');
  assert.equal(aug.fuel_cost, 197370);
  assert.equal(aug.parts_cost, 5000);
  assert.equal(aug.total_cost, 202370);
  const nov = get('SELECT * FROM vehicle_monthly_costs WHERE asset_id = 47 AND year = 2026 AND month = 11');
  assert.equal(nov.fuel_cost, 41160);

  // Filter schedules deduplicated without constraint failure, unique ones preserved
  const scheds = all('SELECT * FROM vehicle_filter_schedules WHERE asset_id = 47 ORDER BY id');
  assert.equal(scheds.length, 2);
  assert.equal(scheds[0].part_no, 'TM21-OIL');
  assert.equal(scheds[1].category, 'Hydraulic Filter');

  // Text replacements completed everywhere
  assert.equal(get('SELECT vehicle_label FROM service_jobs WHERE id = 1').vehicle_label, 'ZA-0050 (TM-21)');
  assert.equal(get('SELECT vehicle_label, asset_id FROM service_jobs WHERE id = 2').vehicle_label, 'ZA-0050 rear engine');
  assert.equal(get('SELECT asset_id FROM service_jobs WHERE id = 2').asset_id, 47);
  assert.equal(get('SELECT description, asset_id FROM job_cards WHERE id = 1').description, 'Stores materials for ZA-0050 TATA 2576');
  assert.equal(get('SELECT vehicle FROM tyre_battery_issues WHERE id = 1').vehicle, 'ZA-0050');
  assert.equal(get('SELECT top_vehicle FROM filter_catalogue WHERE id = 1').top_vehicle, 'ZA-0050 (TM-21) REAR');
  assert.equal(get('SELECT compatible_assets FROM filter_stock WHERE id = 1').compatible_assets, 'Machinery · ZA-8445, ZA-0050, ZA-8033');
  assert.equal(get('SELECT payload FROM daily_report_snapshots WHERE id = 1').payload, '{"vehicle":"ZA-0050"}');

  // Learning alias maps ZB-0050 -> asset 47 (TM-21)
  const resolved = aliases.resolveAsset('ZB-0050');
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.assetId, 47);

  // Idempotency
  const res2 = mig069.runMigration(rawDb);
  assert.deepEqual(res2.mergedAssetIds, []);
  assert.equal(res2.fuelIssuesUpdated, 0);
  assert.equal(res2.textRowsUpdated, 0);
  assert.equal(res2.monthlyCostsMerged, 0);
  assert.equal(res2.snapshotsUpdated, 0);
});
