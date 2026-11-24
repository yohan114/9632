'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mig075-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const fuelTimeline = require('../src/lib/billing/fuel_timeline');
const siteSummary = require('../src/lib/billing/site_summary');
const mig075 = require('../src/migrate/075_prepare_nov2026_site_draft_bills');

test.after(() => {
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('Migration 075 replaces stale FINAL bills with clean zero-double-billing DRAFT bills across fueled & zero-fuel sites', () => {
  migrate();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run(`
    INSERT INTO projects (id, code, name, name_norm, active)
    VALUES
      (1,  NULL,       'CEP-03 Project',        'cep-03 project',        1),
      (38, 'CEP-03F',  'CEP-03 F (Galagedara)', 'cep-03 f (galagedara)', 1),
      (45, 'BATTI-02', 'ICDP Batti Lot-02',     'icdp batti lot-02',     1),
      (55, 'RUWA',     'Ruwanwella',            'ruwanwella',            1)
  `);
  run(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active)
    VALUES
      ('tk-38', 'T38', 'Galagedara Tank', 'FIXED', 'AUTO_DIESEL', 20000, 15000, 38, 1),
      ('tk-45', 'T45', 'Batti-02 Tank',   'FIXED', 'AUTO_DIESEL', 20000, 15000, 45, 1)
  `);

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, current_project_id, status, in_register, ownership, created_at, updated_at)
    VALUES
      (101, 'DT-15',   'DT15',   'LI-1015', 'ISUZU', 'Dump Truck',       'vehicle',   'KM',    38,   'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (102, 'HEX-10',  'HEX10',  NULL,      'CAT',   'Excavator',        'plant',     'HOURS', 38,   'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (201, 'DC-12',   'DC12',   'PA-2012', 'TOYOTA','Double Cab',       'vehicle',   'KM',    45,   'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (202, 'GE-11',   'GE11',   NULL,      'DENYO', 'Generator',        'generator', 'HOURS', 45,   'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (203, 'EX-BD5',  'EXBD5',  NULL,      'CAT',   'Excavator',        'plant',     'HOURS', 45,   'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (204, 'EX-FULL', 'EXFULL', NULL,      'CAT',   'Excavator',        'plant',     'HOURS', 45,   'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (301, 'DT-55',   'DT55',   'LO-7182', 'TATA',  'Dump Truck',       'vehicle',   'KM',    55,   'active', 1, 'OWNED', datetime('now'), datetime('now')),
      (401, 'LO-4925', 'LO4925', NULL,      NULL,    'Dump Truck(hired)','vehicle',   'KM',    45,   'active', 0, 'HIRED', datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents,
      dry_rate_cents, wet_rate_cents, fully_wet_rate_cents,
      km_dry_cents, km_wet_cents, hr_dry_cents, hr_wet_cents,
      port_dd_cents, port_dw_cents, dy_dry_cents, dy_wet_cents,
      equip_type, default_basis, fuel_cons_basis, fuel_cons_typ
    ) VALUES
      ('r-101', 101, 'Dump Truck', 'KM',     9500,   9500,   12000, 14000, 9500,  12000, NULL,   NULL,   NULL,   NULL,   NULL,   NULL,   'FLEET',    'WET', 'km',  0.22),
      ('r-102', 102, 'Excavator',  'HOURLY', 300000, 300000, 360000,400000,NULL,  NULL,  300000, 360000, NULL,   NULL,   NULL,   NULL,   'FLEET',    'WET', 'hr',  5),
      ('r-201', 201, 'Double Cab', 'KM',     4500,   4500,   7000,  11000, 4500,  7000,  NULL,   NULL,   NULL,   NULL,   NULL,   NULL,   'FLEET',    'WET', 'km',  0.1),
      ('r-202', 202, 'Generator',  'DAILY',  600000, 600000, 750000,750000,NULL,  NULL,  NULL,   NULL,   600000, 750000, 600000, 750000, 'PORTABLE', 'WET', 'hr',  3),
      ('r-203', 203, 'Excavator',  'HOURLY', 300000, 300000, 400000,450000,NULL,  NULL,  300000, 400000, NULL,   NULL,   NULL,   NULL,   'FLEET',    'WET', 'hr',  5),
      ('r-204', 204, 'Excavator',  'HOURLY', 300000, 300000, 400000,450000,NULL,  NULL,  300000, 400000, NULL,   NULL,   NULL,   NULL,   'FLEET',    'WET', 'hr',  5),
      ('r-301', 301, 'Dump Truck', 'KM',     9500,   9500,   12000, 14000, 9500,  12000, NULL,   NULL,   NULL,   NULL,   NULL,   NULL,   'FLEET',    'WET', 'km',  0.22)
  `);

  // Allocations: DT-15 was at BATTI-02 in Aug, now fuels at CEP-03F in Nov -> must NOT double-bill at BATTI-02!
  // DC-12, GE-11, EX-BD5, EX-FULL, LO-4925 were at BATTI-02 in Aug (no Nov fuel); DT-55 at RUWA in Aug (no Nov fuel).
  run(`
    INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, owner_code, basis, origin, locked, is_current, active)
    VALUES
      ('va-101-08', 'AUTO-101-45-2026-08', 101, 'DT-15',   45, 'ICDP Batti Lot-02',     '2026-08', 'E&C',   'DRY',           'AUTO_FUEL', 0, 0, 1),
      ('va-102-10', 'AUTO-102-38-2026-10', 102, 'HEX-10',  38, 'CEP-03 F (Galagedara)', '2026-10', 'E&C',   'WET',           'AUTO_FUEL', 0, 0, 1),
      ('va-201-08', 'AUTO-201-45-2026-08', 201, 'DC-12',   45, 'ICDP Batti Lot-02',     '2026-08', 'E&C',   'WET',           'AUTO_FUEL', 0, 0, 1),
      ('va-202-08', 'AUTO-202-45-2026-08', 202, 'GE-11',   45, 'ICDP Batti Lot-02',     '2026-08', 'E&C',   'WET',           'AUTO_FUEL', 0, 0, 1),
      ('va-203-08', 'AUTO-203-45-2026-08', 203, 'EX-BD5',  45, 'ICDP Batti Lot-02',     '2026-08', 'E&C',   'WET',           'AUTO_FUEL', 0, 0, 1),
      ('va-204-08', 'AUTO-204-45-2026-08', 204, 'EX-FULL', 45, 'ICDP Batti Lot-02',     '2026-08', 'E&C',   'WET',           'AUTO_FUEL', 0, 0, 1),
      ('va-301-08', 'AUTO-301-55-2026-08', 301, 'DT-55',   55, 'Ruwanwella',            '2026-08', 'E&C',   'WET',           'AUTO_FUEL', 0, 0, 1),
      ('va-401-08', 'AUTO-401-45-2026-08', 401, 'LO-4925', 45, 'ICDP Batti Lot-02',     '2026-08', 'HIRED', 'BILLED_DIRECT', 'AUTO_FUEL', 0, 0, 1)
  `);

  // Nov 2026 fuel ONLY for DT-15 at CEP-03F (HEX-10 is idle 0-fuel at CEP-03F -> stays in noFuelHere!)
  run(`
    INSERT INTO fuel_issues (id, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, total_cost_cents, issue_date, source_tank_id, project_id, is_direct_billed, is_voided)
    VALUES ('fi-101-11', 101, 'DT-15', 'LI-1015', 'AUTO_DIESEL', 100, 39200, 3920000, '2026-11-05 08:00:00', 'tk-38', 38, 0, 0)
  `);

  // Breakdowns at BATTI-02: EX-BD5 down 5 days (11-11..11-15 -> 20/25 working d = 96 hr), EX-FULL down full month
  run(`
    INSERT INTO job_cards (id, job_no, asset_id, project_id, workshop_id, type, severity, status, breakdown, reported_at, closed_at, description, requested_by, is_historical)
    VALUES
      (501, 'CW/2026/BD5',  203, 45, 1, 'repair', 'major', 'CLOSED', 1, '2026-11-11', '2026-11-15', 'Hydraulic hose burst', 1, 0),
      (502, 'CW/2026/FULL', 204, 45, 1, 'repair', 'major', 'IN_PROGRESS', 1, '2026-11-01', NULL, 'Engine overhaul', 1, 0)
  `);

  // Stale old Auto-synced FINAL bills + bogus double-bill + legacy no-code bill + linked ledger events
  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, billing_mode, rate_basis, rate_cents,
      actual_units, minimum_units, billable_units, rental_amount_cents,
      subtotal_cents, sscl_cents, vat_cents, grand_total_cents, status, notes
    ) VALUES
      ('old-dc12-batti', 'INV-OLD-1', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 201, 'DC-12', 45, 'DRY', 'HOURLY', 55000, 120, 120, 120, 6600000, 6600000, 0, 0, 7982700, 'FINAL', 'Auto-synced for ICDP Batti Lot-02 (2026-11)'),
      ('old-dt15-batti', 'INV-OLD-2', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 101, 'DT-15', 45, 'DRY', 'HOURLY', 127000,120, 120, 120, 15240000,15240000,0, 0, 18432780,'FINAL', 'Auto-synced for ICDP Batti Lot-02 (2026-11)'),
      ('old-dt15-leg',   'INV-OLD-3', 2026, 11, '2026-11', '2026-11-01', '2026-11-30', 101, 'DT-15', 1,  'DRY', 'HOURLY', 127000,120, 120, 120, 15240000,15240000,0, 0, 18432780,'FINAL', 'Auto-synced for CEP-03 Project (2026-11)')
  `);
  run(`
    INSERT INTO fleet_financial_events (
      id, event_key, event_type, asset_id, asset_code, project_id, business_date, year, month, amount_cents, source_table, source_id
    ) VALUES
      ('FIN-REV-RENTAL-old-dc12-batti', 'FIN-REV-RENTAL-old-dc12-batti', 'REVENUE_RENTAL', 201, 'DC-12', 45, '2026-11-30', 2026, 11, 6600000, 'fleet_bills', 'old-dc12-batti'),
      ('FIN-REV-RENTAL-old-dt15-leg',   'FIN-REV-RENTAL-old-dt15-leg',   'REVENUE_RENTAL', 101, 'DT-15', 1,  '2026-11-30', 2026, 11, 15240000,'fleet_bills', 'old-dt15-leg')
  `);

  const res1 = mig075.runMigration(rawDb);
  assert.equal(res1.billsVoided, 3);
  assert.equal(res1.revEventsCleared, 2);
  assert.equal(res1.carryForwardAllocsCreated, 5); // DC-12, GE-11, EX-BD5, EX-FULL, DT-55
  assert.equal(res1.draftsCreated, 5); // CEP-03F: DT-15; BATTI-02: DC-12, GE-11, EX-BD5; RUWA: DT-55
  assert.equal(res1.skippedFullBreakdowns, 1); // EX-FULL

  // Old FINAL bills voided & ledger events cleared
  for (const oid of ['old-dc12-batti', 'old-dt15-batti', 'old-dt15-leg']) {
    assert.equal(get('SELECT status FROM fleet_bills WHERE id = ?', oid).status, 'VOID');
  }
  assert.equal(get('SELECT COUNT(*) AS c FROM fleet_financial_events').c, 0);

  // All active 2026-11 bills are DRAFT across coded sites only, zero double-billing
  const activeNovBills = all("SELECT * FROM fleet_bills WHERE period_key = '2026-11' AND status != 'VOID' ORDER BY asset_id");
  assert.equal(activeNovBills.length, 5);
  assert.ok(activeNovBills.every((b) => b.status === 'DRAFT'));
  assert.equal(new Set(activeNovBills.map((b) => b.asset_id)).size, 5, 'Zero double-billing across sites');
  assert.ok(!activeNovBills.some((b) => b.project_id === 1), 'Legacy project skipped');
  assert.ok(!activeNovBills.some((b) => b.asset_code === 'LO-4925'), 'HIRED vehicle skipped');
  assert.ok(!activeNovBills.some((b) => b.asset_code === 'HEX-10'), 'Zero-fuel idle vehicle at fueled site stays unbilled');
  assert.ok(!activeNovBills.some((b) => b.asset_code === 'EX-FULL'), 'Full-month breakdown skipped');

  // Verify exact rate, unit, and breakdown calculations on DRAFT bills + line items
  const byCode = Object.fromEntries(activeNovBills.map((b) => [b.asset_code, b]));

  // DC-12 (Double Cab @ BATTI-02, 0 fuel): 3,000 km @ Rs 70/km WET = Rs 210,000 + SSCL 2.5% + VAT 18%
  assert.equal(byCode['DC-12'].project_id, 45);
  assert.equal(byCode['DC-12'].rate_basis, 'KM');
  assert.equal(byCode['DC-12'].billing_mode, 'WET');
  assert.equal(byCode['DC-12'].billable_units, 3000);
  assert.equal(byCode['DC-12'].rental_amount_cents, 21000000);
  assert.equal(byCode['DC-12'].fuel_cost_cents, 0);
  assert.equal(byCode['DC-12'].sscl_cents, Math.round(21000000 * 0.025));
  assert.equal(byCode['DC-12'].vat_cents, Math.round((21000000 + byCode['DC-12'].sscl_cents) * 0.18));

  // GE-11 (Generator @ BATTI-02, 0 fuel): 25 working days max (never 30!) @ Rs 7,500/day WET = Rs 187,500
  assert.equal(byCode['GE-11'].rate_basis, 'DAILY');
  assert.equal(byCode['GE-11'].billable_units, 25);
  assert.equal(byCode['GE-11'].rental_amount_cents, 18750000);

  // EX-BD5 (Excavator @ BATTI-02, 5 BD days): gross 120hr (Rs 480,000), deduct 24hr (-Rs 96,000), net 96hr (Rs 384,000)
  assert.equal(byCode['EX-BD5'].breakdown_days, 5);
  assert.equal(byCode['EX-BD5'].rental_amount_cents, 48000000);
  assert.equal(byCode['EX-BD5'].breakdown_deduct_cents, 9600000);
  assert.equal(byCode['EX-BD5'].subtotal_cents, 38400000);
  assert.ok(get("SELECT * FROM fleet_bill_line_items WHERE bill_id = ? AND item_type = 'BREAKDOWN_DEDUCT'", byCode['EX-BD5'].id));

  // DT-15 (fueled ONLY at CEP-03F): billed ONLY at CEP-03F with KM rate + 100L fuel
  assert.equal(byCode['DT-15'].project_id, 38);
  assert.equal(byCode['DT-15'].rate_basis, 'KM');
  assert.equal(byCode['DT-15'].fuel_litres, 100);
  assert.equal(byCode['DT-15'].fuel_cost_cents, 3920000);

  // DT-55 (0 fuel at RUWA): billed ONLY at RUWA
  assert.equal(byCode['DT-55'].project_id, 55);
  assert.equal(byCode['DT-55'].rate_basis, 'KM');
  assert.equal(byCode['DT-55'].rental_amount_cents, 36000000);

  // Strict idempotency on second run
  const res2 = mig075.runMigration(rawDb);
  assert.equal(res2.billsVoided, 0);
  assert.equal(res2.revEventsCleared, 0);
  assert.equal(res2.carryForwardAllocsCreated, 0);
  assert.equal(res2.draftsCreated, 0);

  // Site Summary includes zero-fuel sites BATTI-02 and RUWA cleanly even with includeZeroFuel = false (via DRAFT bills + CARRY_FORWARD)
  const allSums = siteSummary.buildAllSiteSummaries('2026-11');
  const sumByCode = Object.fromEntries(allSums.map((s) => [s.siteCode, s]));
  assert.equal(sumByCode['BATTI-02'].lines.length, 3);
  assert.equal(sumByCode['BATTI-02'].status, 'DRAFT');
  assert.equal(sumByCode['RUWA'].lines.length, 1);
  assert.equal(sumByCode['CEP-03F'].lines.length, 1);
  assert.equal(sumByCode['CEP-03F'].noFuelHere.includes('HEX-10'), true);

  // Future Nov fuel for DC-12 at BATTI-02 overrides CARRY_FORWARD cleanly in timeline & syncFuelAllocations
  run("INSERT INTO fuel_issues (id, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, total_cost_cents, issue_date, source_tank_id, project_id, is_direct_billed, is_voided) VALUES ('fi-dc12-late', 201, 'DC-12', 'PA-2012', 'AUTO_DIESEL', 45, 39200, 1764000, '2026-11-18 09:00:00', 'tk-45', 45, 0, 0)");
  fuelTimeline.syncFuelAllocations({ periodKey: '2026-11', assetId: 201 });
  const dc12Allocs = all("SELECT origin FROM fleet_vehicle_allocations WHERE asset_id = 201 AND month = '2026-11' AND COALESCE(active,1) = 1");
  assert.equal(dc12Allocs.length, 1);
  assert.equal(dc12Allocs[0].origin, 'AUTO_FUEL');
});
