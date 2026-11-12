'use strict';

/**
 * Migration 056: Fleet Allocations & Rental Billing Schema
 *
 * Implements native WorkshopOne schema for machine allocations & rental billing:
 * 1. fleet_rental_rates (hierarchical rate cards: asset-level or category-level, Dry/Wet/Min)
 * 2. fleet_asset_assignments (continuous site assignments, driver links, billing types)
 * 3. fleet_vehicle_allocations (monthly allocation sheet registers)
 * 4. fleet_bills (immutable finalized bills, integer cents, SSCL 2.5%, VAT 18%)
 * 5. fleet_bill_line_items (granular billing lines: rental, fuel recharge, breakdown deducts)
 * 6. fleet_bill_revisions (versioned audit trail snapshots of modified bills)
 * 7. fleet_credit_notes (commercial adjustments against finalized bills)
 * 8. fleet_payments (cash/cheque payment receipts and settlements)
 * 9. fleet_billing_site_overrides (site-specific contractual exceptions)
 *
 * Registers hire & billing capabilities and seeds role defaults.
 * Fully idempotent across single-database and multidb modes.
 */

function runMigration(targetDb) {
  if (!targetDb) return;
  console.log('=== Running Migration 056: Fleet Allocations & Rental Billing Schema ===');

  targetDb.exec(`
    -- 1. Machine Hire & Rental Rate Cards
    CREATE TABLE IF NOT EXISTS fleet_rental_rates (
      id                      TEXT PRIMARY KEY,
      asset_id                INTEGER,
      category_name           TEXT,
      rate_basis              TEXT NOT NULL CHECK (rate_basis IN ('HOURLY', 'DAILY', 'MONTHLY', 'KM', 'FLAT')),
      rate_cents              INTEGER NOT NULL DEFAULT 0,
      dry_rate_cents          INTEGER,
      wet_rate_cents          INTEGER,
      min_bill_hours          INTEGER DEFAULT 0,
      note                    TEXT,
      effective_start         TEXT,
      effective_end           TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 2. Fleet Machine Site Assignments
    CREATE TABLE IF NOT EXISTS fleet_asset_assignments (
      id                      TEXT PRIMARY KEY,
      asset_id                INTEGER,
      asset_code              TEXT NOT NULL,
      project_id              INTEGER,
      project_code            TEXT,
      driver_name             TEXT,
      start_date              TEXT NOT NULL,
      end_date                TEXT,
      billing_type            TEXT DEFAULT 'DRY' CHECK (billing_type IN ('DRY', 'WET', 'FULLY_WET', 'FUEL_ONLY', 'BILLED_DIRECT', 'FREE_OF_CHARGE')),
      origin                  TEXT DEFAULT 'FLEET',
      note                    TEXT,
      created_by              INTEGER,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 3. Monthly Vehicle Allocations
    CREATE TABLE IF NOT EXISTS fleet_vehicle_allocations (
      id                      TEXT PRIMARY KEY,
      dedupe_key              TEXT UNIQUE NOT NULL,
      asset_id                INTEGER,
      vehicle_no              TEXT NOT NULL,
      project_id              INTEGER,
      site_name               TEXT NOT NULL,
      month                   TEXT NOT NULL,
      machine_type            TEXT,
      owner_code              TEXT,
      basis                   TEXT,
      active                  INTEGER NOT NULL DEFAULT 1,
      source_file             TEXT,
      source_sheet            TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 4. Finalized & Draft Machine Rental Bills
    CREATE TABLE IF NOT EXISTS fleet_bills (
      id                      TEXT PRIMARY KEY,
      invoice_number          TEXT UNIQUE,
      year                    INTEGER NOT NULL,
      month                   INTEGER NOT NULL,
      period_key              TEXT NOT NULL,
      period_start            TEXT NOT NULL,
      period_end              TEXT NOT NULL,
      asset_id                INTEGER,
      asset_code              TEXT NOT NULL,
      asset_reg_no            TEXT,
      asset_label             TEXT,
      driver_name             TEXT,
      project_id              INTEGER,
      project_name            TEXT,
      project_code            TEXT,
      billing_mode            TEXT NOT NULL,
      rate_basis              TEXT NOT NULL,
      rate_cents              INTEGER NOT NULL,
      opening_meter           REAL,
      closing_meter           REAL,
      actual_units            REAL NOT NULL,
      minimum_units           REAL NOT NULL,
      billable_units          REAL NOT NULL,
      rental_amount_cents     INTEGER NOT NULL,
      fuel_litres             REAL NOT NULL DEFAULT 0,
      fuel_cost_cents         INTEGER NOT NULL DEFAULT 0,
      breakdown_days          INTEGER NOT NULL DEFAULT 0,
      breakdown_deduct_cents  INTEGER NOT NULL DEFAULT 0,
      subtotal_cents          INTEGER NOT NULL,
      sscl_rate               REAL NOT NULL DEFAULT 0.025,
      sscl_cents              INTEGER NOT NULL,
      vat_rate                REAL NOT NULL DEFAULT 0.18,
      vat_cents               INTEGER NOT NULL,
      grand_total_cents       INTEGER NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FINAL', 'ISSUED', 'PAID', 'VOID', 'REVISED')),
      issued_date             TEXT,
      due_date                TEXT,
      paid_date               TEXT,
      paid_amount_cents       INTEGER,
      payment_ref             TEXT,
      payment_note            TEXT,
      notes                   TEXT,
      derived_from_fuel       INTEGER NOT NULL DEFAULT 0,
      generated_by            INTEGER,
      approved_by             INTEGER,
      approved_at             TEXT,
      emailed_at              TEXT,
      emailed_to              TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 5. Bill Detailed Line Items
    CREATE TABLE IF NOT EXISTS fleet_bill_line_items (
      id                      TEXT PRIMARY KEY,
      bill_id                 TEXT NOT NULL REFERENCES fleet_bills(id) ON DELETE CASCADE,
      item_type               TEXT NOT NULL CHECK (item_type IN ('RENTAL', 'FUEL', 'BREAKDOWN_DEDUCT', 'OPERATOR', 'TRANSPORT', 'OTHER')),
      description             TEXT NOT NULL,
      quantity                REAL NOT NULL DEFAULT 1,
      unit_price_cents        INTEGER NOT NULL DEFAULT 0,
      amount_cents            INTEGER NOT NULL DEFAULT 0,
      is_deduction            INTEGER NOT NULL DEFAULT 0,
      meta_json               TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 6. Immutable Bill Revision Snapshots
    CREATE TABLE IF NOT EXISTS fleet_bill_revisions (
      id                      TEXT PRIMARY KEY,
      bill_id                 TEXT NOT NULL REFERENCES fleet_bills(id) ON DELETE CASCADE,
      revision_number         INTEGER NOT NULL,
      change_summary          TEXT NOT NULL,
      snapshot_json           TEXT NOT NULL,
      grand_total_cents       INTEGER NOT NULL,
      created_by              INTEGER,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (bill_id, revision_number)
    );

    -- 7. Commercial Credit Notes
    CREATE TABLE IF NOT EXISTS fleet_credit_notes (
      id                      TEXT PRIMARY KEY,
      credit_note_no          TEXT UNIQUE NOT NULL,
      bill_id                 TEXT REFERENCES fleet_bills(id),
      amount_cents            INTEGER NOT NULL,
      reason                  TEXT NOT NULL,
      approved_by             INTEGER,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 8. Payment Settlements
    CREATE TABLE IF NOT EXISTS fleet_payments (
      id                      TEXT PRIMARY KEY,
      bill_id                 TEXT REFERENCES fleet_bills(id),
      amount_cents            INTEGER NOT NULL,
      payment_date            TEXT NOT NULL,
      payment_method          TEXT,
      reference_no            TEXT,
      notes                   TEXT,
      recorded_by             INTEGER,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 9. Site Specific Billing Overrides
    CREATE TABLE IF NOT EXISTS fleet_billing_site_overrides (
      id                      TEXT PRIMARY KEY,
      asset_id                INTEGER,
      project_id              INTEGER,
      override_rate_cents     INTEGER,
      override_basis          TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Performance Indexes
    CREATE INDEX IF NOT EXISTS idx_fleet_bills_period ON fleet_bills(period_key);
    CREATE INDEX IF NOT EXISTS idx_fleet_bills_asset ON fleet_bills(asset_id, period_key);
    CREATE INDEX IF NOT EXISTS idx_fleet_bills_project ON fleet_bills(project_id, period_key);
    CREATE INDEX IF NOT EXISTS idx_fleet_bills_status ON fleet_bills(status);
    CREATE INDEX IF NOT EXISTS idx_fleet_bills_invoice ON fleet_bills(invoice_number);

    CREATE INDEX IF NOT EXISTS idx_bill_line_items_bill ON fleet_bill_line_items(bill_id);
    CREATE INDEX IF NOT EXISTS idx_bill_revisions_bill ON fleet_bill_revisions(bill_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_assignments_asset ON fleet_asset_assignments(asset_id, start_date);
    CREATE INDEX IF NOT EXISTS idx_fleet_allocations_month ON fleet_vehicle_allocations(month, project_id);
    CREATE INDEX IF NOT EXISTS idx_rental_rates_asset ON fleet_rental_rates(asset_id);
  `);

  // Seed Hire & Billing Role Capabilities
  const hasRoleCaps = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_capabilities'").get();
  if (hasRoleCaps) {
    const billingCapabilities = [
      { key: 'allocations.view', roles: ['admin', 'manager', 'operational_manager', 'transport_manager', 'assistant_transport_manager', 'viewer'] },
      { key: 'allocations.manage', roles: ['admin', 'manager', 'operational_manager', 'transport_manager'] },
      { key: 'hire.rates.view', roles: ['admin', 'manager', 'operational_manager', 'transport_manager', 'viewer'] },
      { key: 'hire.rates.manage', roles: ['admin', 'manager', 'operational_manager'] },
      { key: 'hire.billing.view', roles: ['admin', 'manager', 'operational_manager', 'transport_manager', 'viewer'] },
      { key: 'hire.billing.generate', roles: ['admin', 'manager', 'operational_manager'] },
      { key: 'hire.billing.finalise', roles: ['admin', 'manager'] },
      { key: 'hire.billing.export', roles: ['admin', 'manager', 'operational_manager', 'transport_manager'] },
    ];

    const insertStmt = targetDb.prepare(`
      INSERT INTO role_capabilities (role, capability, granted, updated_at)
      VALUES (?, ?, 1, datetime('now'))
      -- DO NOTHING: this runs on every start, and must not give back a permission an admin took away.
      ON CONFLICT(role, capability) DO NOTHING
    `);

    for (const bc of billingCapabilities) {
      for (const r of bc.roles) {
        try {
          insertStmt.run(r, bc.key);
        } catch (_) {}
      }
    }
    console.log('[056] Seeded Fleet Allocation & Billing role capabilities');
  }

  console.log('=== Migration 056 Complete ===');
}

module.exports = { runMigration };
