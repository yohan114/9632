'use strict';

/**
 * Phase 2: Apply Migrations 055, 056, 057 to Staging Database
 *
 * Runs the new native migrations against data/staging_merger/workshop_core_staging.db
 * to verify schema compatibility and performance without touching live databases.
 */

const path = require('path');
const Database = require('better-sqlite3');
const m055 = require('../../src/migrate/055_fuel_core_schema');
const m056 = require('../../src/migrate/056_fleet_allocations_and_billing');
const m057 = require('../../src/migrate/057_fleet_financial_ledger');

const STAGING_CORE_PATH = path.resolve(__dirname, '../../data/staging_merger/workshop_core_staging.db');

console.log('=== Applying Phase 2 Migrations to Staging Core DB ===');
console.log('Target:', STAGING_CORE_PATH);

const db = new Database(STAGING_CORE_PATH);

// Check integrity before
const beforeIntegrity = db.prepare('PRAGMA integrity_check').all();
console.log('Before migration integrity:', beforeIntegrity[0].integrity_check);

m055.runMigration(db);
m056.runMigration(db);
m057.runMigration(db);

// Check integrity after
const afterIntegrity = db.prepare('PRAGMA integrity_check').all();
console.log('After migration integrity:', afterIntegrity[0].integrity_check);

const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
console.log('Foreign key check errors:', fkErrors.length);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
console.log(`Total tables now in staging core DB: ${tables.length}`);

const newTables = [
  'fuel_tanks', 'fuel_prices', 'fuel_requests', 'fuel_issues', 'fuel_corrections',
  'fuel_tank_dips', 'fuel_bulk_deliveries', 'fuel_meter_readings', 'fuel_daily_conditions',
  'fuel_pm_tasks', 'fleet_rental_rates', 'fleet_asset_assignments', 'fleet_vehicle_allocations',
  'fleet_bills', 'fleet_bill_line_items', 'fleet_bill_revisions', 'fleet_credit_notes',
  'fleet_payments', 'fleet_billing_site_overrides', 'fleet_financial_events',
  'fleet_monthly_snapshots', 'fleet_identity_mappings'
];

for (const t of newTables) {
  if (tables.includes(t)) {
    console.log(`  ✓ Table verified: ${t}`);
  } else {
    console.error(`  ✗ Missing table: ${t}`);
  }
}

db.close();
console.log('=== Phase 2 Staging Migration Verification Complete ===\n');
