'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mig073-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const aliases = require('../src/lib/aliases');
const siteSummary = require('../src/lib/billing/site_summary');
const mig073 = require('../src/migrate/073_exclude_old_month_external_vehicles');

const EXCLUDED_CODES = [
  '251-7719',
  'DAB-5905',
  'DAG-4969',
  'NVM-CONSTRUCTION',
  'PC-1094',
  'PC-1203',
  'LH Piyasena Piling',
  'OTH-KB',
  'Sub Damith',
  'CHANDANA SUBCONTRACTOR',
];

const TRANSFER_CODES = [
  'SITE-WCP',
  'DATABASE CHANGING ERROR',
  'ERROR CORRECTION',
  'FIRE DRILL',
  'General / Cleaning',
  'OTH-CEP03E',
];

test.after(() => {
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('Migration 073 merges typos, excludes 11 old-month external assets, routes SITE-* transfers, and preserves SITE ROLLER', () => {
  migrate();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run(`
    INSERT INTO projects (id, code, name, name_norm, active)
    VALUES
      (38, 'CEP-03F', 'CEP-03 F (Galagedara)', 'cep-03 f (galagedara)', 1),
      (20, 'BGP',     'Badalgama Plant',       'badalgama plant',       1),
      (21, 'ING',     'Inginimitiya Site',     'inginimitiya site',     1)
  `);
  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('tk-38', 'T38', 'Galagedara Tank', 'FIXED', 'AUTO_DIESEL', 20000, 15000, 38, 1),
      ('tk-20', 'T20', 'Badalgama Tank',  'FIXED', 'AUTO_DIESEL', 30000, 20000, 20, 1),
      ('tk-21', 'T21', 'ING Tank',        'FIXED', 'AUTO_DIESEL', 10000, 8000,  21, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, current_project_id, status, in_register, ownership, created_at, updated_at)
    VALUES
      (1612, 'DAI-9770',               'DAI9770',              'DAI-9770', NULL,  'Single Cab',                            'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1636, 'DHI-9770',               'DHI9770',              NULL,       NULL,  'Other Asset',                           'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1624, 'RG-5415',                'RG5415',               'RG-5415',  NULL,  'Tractor (hired / billed outside)',      'vehicle', 'HOURS', 38, 'active', 0, 'HIRED', datetime('now'), datetime('now')),
      (1635, 'RG-9415',                'RG9415',               NULL,       NULL,  'Other Asset',                           'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1505, '251-7719',               '2517719',              NULL,       NULL,  'From Karaitivu',                        'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (750,  '41-7225',                '417225',               NULL,       NULL,  NULL,                                    'vehicle', 'KM',    38, 'active', 0, 'OWNED', datetime('now'), datetime('now')),
      (1492, 'DAB-5905',               'DAB5905',              'DAB-5905', NULL,  'From Wadakada',                         'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1487, 'DAG-4969',               'DAG4969',              'DAG-4969', NULL,  'From Galagedara',                       'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1630, 'NVM-CONSTRUCTION',       'NVMCONSTRUCTION',      NULL,       NULL,  'Blasting Subcontractor',                'vehicle', 'HOURS', 38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1489, 'PC-1094',                'PC1094',               'PC-1094',  NULL,  'From Galagedara',                       'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1613, 'PC-1203',                'PC1203',               'PC-1203',  NULL,  'Unknown',                               'vehicle', 'KM',    38, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1517, 'LH Piyasena Piling',     'LHPIYASENAPILING',     NULL,       NULL,  'From Karaitivu',                        'vehicle', 'HOURS', 20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1538, 'OTH-KB',                 'OTHKB',                NULL,       NULL,  'Crane (Sub, Lanka Pile)',               'vehicle', 'HOURS', 20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1566, 'Sub Damith',             'SUBDAMITH',            NULL,       NULL,  'Subcontractor',                         'vehicle', 'KM',    20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1436, 'CHANDANA SUBCONTRACTOR', 'CHANDANASUBCONTRACTOR',NULL,       NULL,  NULL,                                    'vehicle', 'KM',    20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1410, 'SITE-WCP',               'SITEWCP',              NULL,       NULL,  'Project Site',                          'vehicle', 'KM',    20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1607, 'DATABASE CHANGING ERROR','DATABASECHANGINGERROR',NULL,       NULL,  'Other Asset',                           'vehicle', 'KM',    20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1437, 'ERROR CORRECTION',       'ERRORCORRECTION',      NULL,       NULL,  'Other Asset',                           'vehicle', 'KM',    20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1415, 'FIRE DRILL',             'FIREDERILL',           NULL,       NULL,  'Other Asset',                           'vehicle', 'KM',    20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1603, 'General / Cleaning',     'GENERALCLEANING',      NULL,       NULL,  'Non-vehicle consumption',               'vehicle', 'KM',    20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1536, 'OTH-CEP03E',             'OTHCEP03E',            NULL,       NULL,  'Site',                                  'vehicle', 'KM',    20, 'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (1556, 'SITE ROLLER',            'SITEROLLER',           NULL,       NULL,  'Site equipment',                        'plant',   'HOURS', 21, 'active', 1, 'OWNED', datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, equip_type, default_basis, fuel_cons_basis, fuel_cons_typ)
    VALUES
      ('r-1612', 1612, 'Single Cab', 'KM', 5000, 5000, 7000, 'FLEET', 'DRY', 'km', 0.1),
      ('r-1556', 1556, 'Vibrating Roller', 'HOURLY', 180000, 180000, 220000, 'FLEET', 'DRY', 'hr', 3)
  `);

  // Job card on 41-7225 must stay untouched
  run("INSERT INTO job_cards (id, job_no, asset_id, type, description, status, workshop_id) VALUES (3850, '2026/11/R/817', 750, 'repair', 'Alternator repair', 'CLOSED', 1)");

  // Overlapping vehicle_monthly_costs for DAI-9770 + DHI-9770 in 2026-10
  run(`
    INSERT INTO vehicle_monthly_costs (id, asset_id, year, month, fuel_cost, oil_cost, filter_cost, battery_cost, parts_cost, labour_cost, total_cost)
    VALUES
      (1, 1612, 2026, 10, 40000, 0, 0, 0, 1000, 0, 41000),
      (2, 1636, 2026, 10, 7448,  0, 0, 0, 0,    0, 7448),
      (3, 1635, 2026, 10, 1960,  0, 0, 0, 0,    0, 1960)
  `);

  // Allocations & assignments across 2026-08 and 2026-10
  run(`
    INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, owner_code, basis, origin, locked, is_current, active)
    VALUES
      ('va-dai-10',   'AUTO-1612-38-2026-10', 1612, 'DAI-9770',          38, 'CEP-03 F',        '2026-10', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 0, 1),
      ('va-dhi-10',   'AUTO-1636-38-2026-10', 1636, 'DHI-9770',          38, 'CEP-03 F',        '2026-10', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 0, 1),
      ('va-rg94-10',  'AUTO-1635-38-2026-10', 1635, 'RG-9415',           38, 'CEP-03 F',        '2026-10', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 0, 1),
      ('va-4172-08',  'AUTO-750-38-2026-08',  750,  '41-7225',           38, 'CEP-03 F',        '2026-08', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 0, 1),
      ('va-dag-10',   'AUTO-1487-38-2026-10', 1487, 'DAG-4969',          38, 'CEP-03 F',        '2026-10', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 0, 1),
      ('va-wcp-10',   'AUTO-1410-20-2026-10', 1410, 'SITE-WCP',          20, 'Badalgama Plant', '2026-10', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 0, 1),
      ('va-db-08',    'AUTO-1607-20-2026-08', 1607, 'DATABASE CHANGING', 20, 'Badalgama Plant', '2026-08', 'E&C', 'DRY_WITH_DRIVER', 'AUTO_FUEL', 0, 0, 1)
  `);
  run(`
    INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, billing_type, origin)
    VALUES
      ('fa-fuel-4172', 750,  '41-7225',  38, '2026-08-01', 'DRY_WITH_DRIVER', 'FUEL'),
      ('fa-fuel-wcp',  1410, 'SITE-WCP', 20, '2026-10-01', 'DRY_WITH_DRIVER', 'FUEL')
  `);

  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, billing_mode, rate_basis, rate_cents,
      actual_units, minimum_units, billable_units, rental_amount_cents,
      fuel_litres, fuel_cost_cents, subtotal_cents, sscl_cents, vat_cents, grand_total_cents, status
    ) VALUES (
      'b-dag-08', 'INV-DAG-08', 2026, 8, '2026-08', '2026-08-01', '2026-08-31',
      1487, 'DAG-4969', 38, 'DRY', 'KM', 0, 0, 0, 0, 0,
      180, 6936000, 6936000, 0, 0, 6936000, 'DRAFT'
    )
  `);
  run(`
    INSERT INTO fleet_financial_events (
      id, event_key, event_type, asset_id, asset_code, project_id, business_date, year, month, amount_cents, source_table, source_id
    ) VALUES (
      'fe-dag-08', 'FIN-DAG-08', 'REVENUE_FUEL', 1487, 'DAG-4969', 38, '2026-08-31', 2026, 8, 6936000, 'fleet_bills', 'b-dag-08'
    )
  `);

  run(`
    INSERT INTO fuel_issues (id, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, total_cost_cents, issue_date, source_tank_id, project_id, is_direct_billed, is_voided)
    VALUES
      ('fi-dai-10',   1612, 'DAI-9770',               'DAI-9770',               'AUTO_DIESEL', 50,   39200, 1960000,   '2026-10-03', 'tk-38', 38, 0, 0),
      ('fi-dhi-10',   1636, 'DHI-9770',               'DHI-9770',               'AUTO_DIESEL', 19,   39200, 744800,    '2026-10-05', 'tk-38', 38, 0, 0),
      ('fi-rg54-10',  1624, 'RG-5415',                'RG-5415',                'AUTO_DIESEL', 40,   39200, 1568000,   '2026-10-04', 'tk-38', 38, 1, 0),
      ('fi-rg94-10',  1635, 'RG-9415',                'RG-9415',                'AUTO_DIESEL', 5,    39200, 196000,    '2026-10-05', 'tk-38', 38, 0, 0),
      ('fi-251-10',   1505, '251-7719',               '251-7719',               'AUTO_DIESEL', 10,   39200, 392000,    '2026-10-09', 'tk-38', 38, 0, 0),
      ('fi-4172-08',  750,  '41-7225',                '41-7225',                'AUTO_DIESEL', 251,  38437, 9647700,   '2026-08-10', 'tk-38', 38, 0, 0),
      ('fi-4172-10',  750,  '41-7225',                '41-7225',                'AUTO_DIESEL', 374,  39200, 14660800,  '2026-10-12', 'tk-38', 38, 0, 0),
      ('fi-dab-10',   1492, 'DAB-5905',               'DAB-5905',               'AUTO_DIESEL', 83,   39200, 3253600,   '2026-10-08', 'tk-38', 38, 0, 0),
      ('fi-dag-08',   1487, 'DAG-4969',               'DAG-4969',               'AUTO_DIESEL', 180,  38533, 6936000,   '2026-08-15', 'tk-38', 38, 0, 0),
      ('fi-nvm-10',   1630, 'NVM-CONSTRUCTION',       'NVM-CONSTRUCTION',       'AUTO_DIESEL', 60,   39200, 2352000,   '2026-10-03', 'tk-38', 38, 0, 0),
      ('fi-pc10-08',  1489, 'PC-1094',                'PC-1094',                'AUTO_DIESEL', 119,  38700, 4605300,   '2026-08-07', 'tk-38', 38, 0, 0),
      ('fi-pc12-08',  1613, 'PC-1203',                'PC-1203',                'AUTO_DIESEL', 52,   38700, 2012400,   '2026-08-09', 'tk-38', 38, 0, 0),
      ('fi-lhp-08',   1517, 'LH Piyasena Piling',     'LH Piyasena Piling',     'AUTO_DIESEL', 200,  38700, 7740000,   '2026-08-11', 'tk-20', 20, 0, 0),
      ('fi-othkb-08', 1538, 'OTH-KB',                 'OTH-KB',                 'AUTO_DIESEL', 100,  38700, 3870000,   '2026-08-12', 'tk-20', 20, 0, 0),
      ('fi-subd-08',  1566, 'Sub Damith',             'Sub Damith',             'AUTO_DIESEL', 5,    38700, 193500,    '2026-08-13', 'tk-20', 20, 0, 0),
      ('fi-chan-08',  1436, 'CHANDANA SUBCONTRACTOR', 'CHANDANA SUBCONTRACTOR', 'AUTO_DIESEL', 25,   38700, 967500,    '2026-08-14', 'tk-20', 20, 0, 0),
      ('fi-wcp-10',   1410, 'SITE-WCP',               'SITE-WCP',               'AUTO_DIESEL', 2750, 39200, 107800000, '2026-10-05', 'tk-20', 20, 0, 0),
      ('fi-dce-08',   1607, 'DATABASE CHANGING ERROR','DATABASE CHANGING ERROR','AUTO_DIESEL', 7129, 38700, 275892300, '2026-08-05', 'tk-20', 20, 0, 0),
      ('fi-err-08',   1437, 'ERROR CORRECTION',       'ERROR CORRECTION',       'AUTO_DIESEL', 11,   38700, 425700,    '2026-08-06', 'tk-20', 20, 0, 0),
      ('fi-fire-08',  1415, 'FIRE DRILL',             'FIRE DRILL',             'AUTO_DIESEL', 2,    38700, 77400,     '2026-08-07', 'tk-20', 20, 0, 0),
      ('fi-gen-08',   1603, 'General / Cleaning',     'General / Cleaning',     'AUTO_DIESEL', 0.8,  38700, 30960,     '2026-08-08', 'tk-20', 20, 0, 0),
      ('fi-othce-08', 1536, 'OTH-CEP03E',             'OTH-CEP03E',             'AUTO_DIESEL', 100,  38700, 3870000,   '2026-08-09', 'tk-20', 20, 0, 0),
      ('fi-srol-06',  1556, 'SITE ROLLER',            'SITE ROLLER',            'AUTO_DIESEL', 13,   39200, 509600,    '2026-06-10', 'tk-21', 21, 0, 0)
  `);

  const res1 = mig073.runMigration(rawDb);
  assert.deepEqual(res1.mergedTypos, ['DHI-9770', 'RG-9415']);
  assert.equal(res1.fuelIssuesMerged, 2);
  assert.equal(res1.monthlyCostsMerged, 2);
  assert.equal(res1.assetsUpdated, 10);
  assert.equal(res1.allocsUpdated, 1);
  assert.equal(res1.assignmentsUpdated, 0);
  assert.equal(res1.fuelIssuesFlagged, 10);
  assert.equal(res1.billsVoided, 1);
  assert.equal(res1.revEventsRemoved, 1);
  assert.equal(res1.nonMachineAllocsRemoved, 2);
  assert.equal(res1.nonMachineAssignsRemoved, 1);

  // FK integrity clean
  assert.deepEqual(rawDb.prepare('PRAGMA foreign_key_check').all(), []);

  // Typo merges + alias resolution + cost summation
  assert.equal(get("SELECT id FROM assets WHERE code = 'DHI-9770'"), undefined);
  assert.equal(get("SELECT id FROM assets WHERE code = 'RG-9415'"), undefined);
  assert.equal(get("SELECT asset_id FROM fuel_issues WHERE id = 'fi-dhi-10'").asset_id, 1612);
  assert.equal(get("SELECT is_direct_billed FROM fuel_issues WHERE id = 'fi-dhi-10'").is_direct_billed, 0);
  const movedRg = get("SELECT asset_id, asset_code, is_direct_billed FROM fuel_issues WHERE id = 'fi-rg94-10'");
  assert.equal(movedRg.asset_id, 1624);
  assert.equal(movedRg.asset_code, 'RG-5415');
  assert.equal(movedRg.is_direct_billed, 1);
  assert.equal(aliases.resolveAsset('DHI-9770').assetId, 1612);
  assert.equal(aliases.resolveAsset('RG-9415').assetId, 1624);
  const daiCost = get('SELECT fuel_cost, parts_cost, total_cost FROM vehicle_monthly_costs WHERE asset_id = 1612 AND year = 2026 AND month = 10');
  assert.equal(daiCost.fuel_cost, 47448);
  assert.equal(daiCost.total_cost, 48448);

  // Excluded assets HIRED & in_register 0; E&C vehicle 41-7225 untouched (OWNED)
  for (const code of EXCLUDED_CODES) {
    const a = get('SELECT * FROM assets WHERE code = ?', code);
    assert.equal(a.ownership, 'HIRED', `${code} should be HIRED`);
    assert.equal(a.in_register, 0, `${code} should have in_register = 0`);
  }
  assert.equal(get("SELECT ownership FROM assets WHERE id = 750").ownership, 'OWNED');
  assert.equal(get("SELECT is_direct_billed FROM fuel_issues WHERE id = 'fi-4172-08'").is_direct_billed, 0);
  assert.equal(get("SELECT is_direct_billed FROM fuel_issues WHERE id = 'fi-4172-10'").is_direct_billed, 0);
  assert.equal(get('SELECT COUNT(*) AS c FROM job_cards WHERE asset_id = 750').c, 1);
  assert.equal(get('SELECT COUNT(*) AS c FROM fuel_issues').c, 23);

  // Strict idempotency on second run
  const res2 = mig073.runMigration(rawDb);
  assert.deepEqual(res2.mergedTypos, []);
  assert.equal(res2.fuelIssuesMerged, 0);
  assert.equal(res2.monthlyCostsMerged, 0);
  assert.equal(res2.assetsUpdated, 0);
  assert.equal(res2.allocsUpdated, 0);
  assert.equal(res2.assignmentsUpdated, 0);
  assert.equal(res2.fuelIssuesFlagged, 0);
  assert.equal(res2.billsVoided, 0);
  assert.equal(res2.revEventsRemoved, 0);
  assert.equal(res2.nonMachineAllocsRemoved, 0);
  assert.equal(res2.nonMachineAssignsRemoved, 0);

  // CEP-03F 2026-10 & 2026-08 Site Summaries: only DAI-9770 + untouched 41-7225 stay in lines
  const galaOct = siteSummary.buildSiteSummary(38, '2026-10');
  assert.deepEqual(galaOct.lines.map((l) => l.code), ['41-7225', 'DAI-9770']);
  assert.equal(galaOct.lines.find((l) => l.code === 'DAI-9770').fuelLitres, 69);
  assert.deepEqual(galaOct.unrated, ['41-7225']);
  assert.ok(!galaOct.billedDirect.includes('41-7225'));
  assert.ok(galaOct.billedDirect.includes('251-7719'));
  assert.ok(galaOct.billedDirect.includes('RG-5415'));

  const galaAug = siteSummary.buildSiteSummary(38, '2026-08');
  assert.deepEqual(galaAug.lines.map((l) => l.code), ['41-7225']);
  assert.deepEqual(galaAug.unrated, ['41-7225']);
  assert.equal(galaAug.fuelLitres, 251);
  assert.ok(galaAug.billedDirect.includes('DAG-4969'));
  assert.ok(galaAug.billedDirect.includes('PC-1094'));
  assert.ok(galaAug.billedDirect.includes('PC-1203'));

  // Badalgama Plant 2026-10 & 2026-08: transfers & errors excluded in transfersExcluded, not in lines/unrated
  const bgpOct = siteSummary.buildSiteSummary(20, '2026-10');
  assert.deepEqual(bgpOct.lines, []);
  assert.deepEqual(bgpOct.unrated, []);
  assert.equal(bgpOct.transfersExcluded[0].ref, 'SITE-WCP');
  assert.equal(bgpOct.transfersExcludedLitres, 2750);

  const bgpAug = siteSummary.buildSiteSummary(20, '2026-08');
  assert.deepEqual(bgpAug.lines, []);
  assert.deepEqual(bgpAug.unrated, []);
  const bgpAugRefs = new Set(bgpAug.transfersExcluded.map((t) => t.ref));
  for (const tc of TRANSFER_CODES.filter((c) => c !== 'SITE-WCP')) {
    assert.ok(bgpAugRefs.has(tc), `${tc} should be routed to transfersExcluded`);
  }

  // SITE ROLLER at ING must NOT be misclassified as a transfer
  const ingJun = siteSummary.buildSiteSummary(21, '2026-06');
  assert.deepEqual(ingJun.lines.map((l) => l.code), ['SITE ROLLER']);
  assert.deepEqual(ingJun.transfersExcluded, []);
});
