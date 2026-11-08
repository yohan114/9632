'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const m055 = require('../src/migrate/055_fuel_core_schema');
const m056 = require('../src/migrate/056_fleet_allocations_and_billing');
const m057 = require('../src/migrate/057_fleet_financial_ledger');
const caps = require('../src/lib/capabilities');

test('Phase 2 Migrations: 055 Fuel Core Schema creates all required tables and indexes', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS role_capabilities (role TEXT, capability TEXT, granted INTEGER, updated_at TEXT, PRIMARY KEY (role, capability));
  `);

  m055.runMigration(db);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const required055 = [
    'fuel_tanks',
    'fuel_prices',
    'fuel_requests',
    'fuel_issues',
    'fuel_corrections',
    'fuel_tank_dips',
    'fuel_bulk_deliveries',
    'fuel_meter_readings',
    'fuel_daily_conditions',
    'fuel_pm_tasks'
  ];

  for (const t of required055) {
    assert.ok(tables.includes(t), `Expected table ${t} to exist after migration 055`);
  }

  // Verify inserting a fuel tank and an authoritative fuel issue
  db.prepare(`
    INSERT INTO fuel_tanks (id, code, name, tank_type, capacity_litres, current_litres)
    VALUES ('tank-cw-01', 'CW-TANK', 'Central Workshop Main Tank', 'FIXED', 10000, 5000)
  `).run();

  const tank = db.prepare('SELECT * FROM fuel_tanks WHERE code = ?').get('CW-TANK');
  assert.strictEqual(tank.name, 'Central Workshop Main Tank');
  assert.strictEqual(tank.current_litres, 5000);

  db.prepare(`
    INSERT INTO fuel_issues (id, issue_no, asset_code, vehicle_ref, litres, fuel_price_cents, total_cost_cents, issue_date, source_tank_id)
    VALUES ('issue-001', 'FI-2026-0001', 'CAT-320D', 'CAT Excavator', 150.5, 34100, 5132050, '2026-05-15', 'tank-cw-01')
  `).run();

  const issue = db.prepare('SELECT * FROM fuel_issues WHERE id = ?').get('issue-001');
  assert.strictEqual(issue.litres, 150.5);
  assert.strictEqual(issue.total_cost_cents, 5132050);
  assert.strictEqual(issue.is_voided, 0);

  db.close();
});

test('Phase 2 Migrations: 056 Fleet Allocations & Rental Billing creates all billing tables', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS role_capabilities (role TEXT, capability TEXT, granted INTEGER, updated_at TEXT, PRIMARY KEY (role, capability));
  `);

  m056.runMigration(db);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const required056 = [
    'fleet_rental_rates',
    'fleet_asset_assignments',
    'fleet_vehicle_allocations',
    'fleet_bills',
    'fleet_bill_line_items',
    'fleet_bill_revisions',
    'fleet_credit_notes',
    'fleet_payments',
    'fleet_billing_site_overrides'
  ];

  for (const t of required056) {
    assert.ok(tables.includes(t), `Expected table ${t} to exist after migration 056`);
  }

  // Verify inserting a bill with SSCL and VAT in integer cents
  db.prepare(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_code, billing_mode, rate_basis, rate_cents,
      actual_units, minimum_units, billable_units, rental_amount_cents,
      subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents
    ) VALUES (
      'bill-test-01', 'INV-2026-001', 2026, 5, '2026-05', '2026-05-01', '2026-05-31',
      'EX-01', 'DRY', 'HOURLY', 500000,
      120, 100, 120, 60000000,
      60000000, 0.025, 1500000, 0.18, 11070000, 72570000
    )
  `).run();

  const bill = db.prepare('SELECT * FROM fleet_bills WHERE id = ?').get('bill-test-01');
  assert.strictEqual(bill.grand_total_cents, 72570000); // Rs 725,700.00
  assert.strictEqual(bill.status, 'DRAFT');

  db.close();
});

test('Phase 2 Migrations: 057 Fleet Financial Ledger creates financial events and identity mapping tables', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS role_capabilities (role TEXT, capability TEXT, granted INTEGER, updated_at TEXT, PRIMARY KEY (role, capability));
  `);

  m057.runMigration(db);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const required057 = [
    'fleet_financial_events',
    'fleet_monthly_snapshots',
    'fleet_identity_mappings'
  ];

  for (const t of required057) {
    assert.ok(tables.includes(t), `Expected table ${t} to exist after migration 057`);
  }

  // Verify inserting an identity mapping from Fuel UUID to Workshop asset ID
  db.prepare(`
    INSERT INTO fleet_identity_mappings (entity_type, source_system, source_id, target_id, match_method, source_code, target_code)
    VALUES ('ASSET', 'FUEL_SYSTEM_V2', 'd3a40965-d1a9-4fc0-b047-66adaeb4c9dc', '42', 'EXACT_FLEET_CODE', 'PQ-8773', 'PQ-8773')
  `).run();

  const mapping = db.prepare("SELECT * FROM fleet_identity_mappings WHERE source_code = 'PQ-8773'").get();
  assert.strictEqual(mapping.target_id, '42');
  assert.strictEqual(mapping.match_method, 'EXACT_FLEET_CODE');

  db.close();
});

test('Capabilities: Fuel, Hire, and Finance capabilities are registered in capability registry', () => {
  assert.ok(caps.isCapability('fuel.view'));
  assert.ok(caps.isCapability('fuel.issue'));
  assert.ok(caps.isCapability('fuel.tanks.manage'));
  assert.ok(caps.isCapability('allocations.manage'));
  assert.ok(caps.isCapability('hire.billing.generate'));
  assert.ok(caps.isCapability('hire.billing.finalise'));
  assert.ok(caps.isCapability('fleet.profitability.view'));
  assert.ok(caps.isCapability('finance.period.close'));
  assert.ok(caps.isCapability('master_dashboard.view'));
});
