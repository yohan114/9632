'use strict';

/**
 * Migration 055: Core Fuel Management Schema
 *
 * Implements native WorkshopOne schema for Fuel-System-V2 migration:
 * 1. fuel_tanks (bulk storage tanks, bowsers, dip charts, project attribution)
 * 2. fuel_prices (Ceypetco per-fuel-type historical price points in LKR cents)
 * 3. fuel_requests (site fuel requisitions and mechanical approvals)
 * 4. fuel_issues (authoritative vehicle & equipment fuel issues with meter readings)
 * 5. fuel_corrections (immutable before/after audit records with photo evidence)
 * 6. fuel_tank_dips (physical dipstick logs vs theoretical pump balance)
 * 7. fuel_bulk_deliveries (bulk tank refills and Ceypetco/dealer supply invoices)
 * 8. fuel_meter_readings (daily vehicle running hours / odometer readings)
 * 9. fuel_daily_conditions (operational working/breakdown status logs)
 * 10. fuel_pm_tasks (preventative maintenance checklists and schedules)
 *
 * Registers fuel capabilities and seeds role defaults.
 * Fully idempotent across single-database and multidb modes.
 */

function runMigration(targetDb) {
  if (!targetDb) return;
  console.log('=== Running Migration 055: Core Fuel Management Schema ===');

  targetDb.exec(`
    -- 1. Fuel Tanks & Mobile Bowsers
    CREATE TABLE IF NOT EXISTS fuel_tanks (
      id                      TEXT PRIMARY KEY,
      code                    TEXT UNIQUE NOT NULL,
      name                    TEXT NOT NULL,
      tank_type               TEXT NOT NULL DEFAULT 'FIXED' CHECK (tank_type IN ('FIXED', 'BOWSER', 'BARREL')),
      fuel_type               TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
      capacity_litres         REAL NOT NULL DEFAULT 0,
      current_litres          REAL NOT NULL DEFAULT 0,
      location                TEXT,
      project_id              INTEGER,
      bowser_asset_id         INTEGER,
      meter_type              TEXT DEFAULT 'HOURS',
      current_meter           REAL DEFAULT 0,
      calibration_chart_json  TEXT,
      active                  INTEGER NOT NULL DEFAULT 1,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 2. Ceypetco / Market Fuel Price History (integer LKR cents)
    CREATE TABLE IF NOT EXISTS fuel_prices (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      fuel_type               TEXT NOT NULL,
      price_per_litre_cents   INTEGER NOT NULL,
      effective_date          TEXT NOT NULL,
      notes                   TEXT,
      created_by              INTEGER,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (fuel_type, effective_date)
    );

    -- 3. Fuel Requests (Requisitions)
    CREATE TABLE IF NOT EXISTS fuel_requests (
      id                      TEXT PRIMARY KEY,
      request_no              TEXT UNIQUE NOT NULL,
      asset_id                INTEGER,
      asset_code              TEXT,
      project_id              INTEGER,
      fuel_type               TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
      requested_litres        REAL NOT NULL,
      meter_reading           REAL,
      reason                  TEXT,
      status                  TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED')),
      requested_by            INTEGER,
      requested_at            TEXT NOT NULL DEFAULT (datetime('now')),
      approved_by             INTEGER,
      approved_at             TEXT,
      rejection_reason        TEXT
    );

    -- 4. Authoritative Fuel Issues
    CREATE TABLE IF NOT EXISTS fuel_issues (
      id                      TEXT PRIMARY KEY,
      issue_no                TEXT,
      asset_id                INTEGER,
      asset_code              TEXT NOT NULL,
      vehicle_ref             TEXT NOT NULL,
      fuel_type               TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
      litres                  REAL NOT NULL,
      fuel_price_cents        INTEGER NOT NULL,
      total_cost_cents        INTEGER NOT NULL,
      meter_reading           REAL,
      meter_type              TEXT NOT NULL DEFAULT 'HOURS' CHECK (meter_type IN ('HOURS', 'KM', 'NONE')),
      issue_date              TEXT NOT NULL,
      station_name            TEXT,
      pump_location           TEXT,
      driver_name             TEXT,
      source_tank_id          TEXT REFERENCES fuel_tanks(id),
      source_project_id       INTEGER,
      target_project_id       INTEGER,
      fuel_request_id         TEXT REFERENCES fuel_requests(id),
      issued_by               INTEGER,
      is_voided               INTEGER NOT NULL DEFAULT 0,
      void_reason             TEXT,
      voided_at               TEXT,
      voided_by               INTEGER,
      is_manual               INTEGER NOT NULL DEFAULT 0,
      is_direct_billed        INTEGER NOT NULL DEFAULT 0,
      import_key              TEXT UNIQUE,
      source_file             TEXT,
      source_sheet            TEXT,
      signature_url           TEXT,
      photo_url               TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 5. Fuel Issue Corrections (Strict Audit Trail)
    CREATE TABLE IF NOT EXISTS fuel_corrections (
      id                      TEXT PRIMARY KEY,
      fuel_issue_id           TEXT NOT NULL REFERENCES fuel_issues(id) ON DELETE CASCADE,
      correction_type         TEXT NOT NULL CHECK (correction_type IN ('LITRES', 'METER', 'VEHICLE', 'PROJECT', 'VOID', 'OTHER')),
      before_litres           REAL,
      after_litres            REAL NOT NULL,
      before_meter            REAL,
      after_meter             REAL,
      stock_delta_litres      REAL NOT NULL DEFAULT 0,
      financial_delta_cents   INTEGER NOT NULL DEFAULT 0,
      reason                  TEXT NOT NULL,
      evidence_file           TEXT,
      status                  TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      requested_by            INTEGER NOT NULL,
      requested_at            TEXT NOT NULL DEFAULT (datetime('now')),
      approved_by             INTEGER,
      approved_at             TEXT,
      notes                   TEXT
    );

    -- 6. Physical Tank Dip Logs
    CREATE TABLE IF NOT EXISTS fuel_tank_dips (
      id                      TEXT PRIMARY KEY,
      tank_id                 TEXT NOT NULL REFERENCES fuel_tanks(id) ON DELETE CASCADE,
      dip_litres              REAL NOT NULL,
      computed_balance        REAL NOT NULL,
      variance_litres         REAL NOT NULL,
      dip_date                TEXT NOT NULL,
      note                    TEXT,
      recorded_by             INTEGER NOT NULL,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 7. Bulk Fuel Deliveries (Tank Refills)
    CREATE TABLE IF NOT EXISTS fuel_bulk_deliveries (
      id                      TEXT PRIMARY KEY,
      tank_id                 TEXT NOT NULL REFERENCES fuel_tanks(id) ON DELETE CASCADE,
      litres                  REAL NOT NULL,
      fuel_type               TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
      supplier                TEXT,
      invoice_number          TEXT,
      cost_cents              INTEGER DEFAULT 0,
      delivery_date           TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'DELIVERED' CHECK (status IN ('REQUESTED', 'ORDERED', 'DELIVERED', 'CANCELLED')),
      received_by             INTEGER,
      note                    TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 8. Vehicle & Plant Meter Readings
    CREATE TABLE IF NOT EXISTS fuel_meter_readings (
      id                      TEXT PRIMARY KEY,
      asset_id                INTEGER,
      asset_code              TEXT NOT NULL,
      meter_reading           REAL NOT NULL,
      meter_type              TEXT NOT NULL,
      reading_date            TEXT NOT NULL,
      source                  TEXT DEFAULT 'FUEL_ISSUE' CHECK (source IN ('FUEL_ISSUE', 'DAILY_LOG', 'SERVICE', 'MANUAL_ENTRY')),
      recorded_by             INTEGER,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 9. Daily Operational Condition Logs
    CREATE TABLE IF NOT EXISTS fuel_daily_conditions (
      id                      TEXT PRIMARY KEY,
      asset_id                INTEGER,
      asset_code              TEXT NOT NULL,
      condition_date          TEXT NOT NULL,
      working_status          TEXT NOT NULL DEFAULT 'WORKING' CHECK (working_status IN ('WORKING', 'IDLE', 'BREAKDOWN', 'UNDER_MAINTENANCE')),
      breakdown_reason        TEXT,
      location                TEXT,
      recorded_by             INTEGER,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 10. Preventative Maintenance Tasks
    CREATE TABLE IF NOT EXISTS fuel_pm_tasks (
      id                      TEXT PRIMARY KEY,
      asset_id                INTEGER,
      task_name               TEXT NOT NULL,
      due_meter               REAL,
      due_date                TEXT,
      status                  TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DUE', 'COMPLETED', 'OVERDUE', 'CANCELLED')),
      completed_at            TEXT,
      notes                   TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Performance Indexes
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_asset ON fuel_issues(asset_id, issue_date);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_date ON fuel_issues(issue_date);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_tank ON fuel_issues(source_tank_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_target_proj ON fuel_issues(target_project_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_import_key ON fuel_issues(import_key);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_voided ON fuel_issues(is_voided);

    CREATE INDEX IF NOT EXISTS idx_fuel_prices_type_date ON fuel_prices(fuel_type, effective_date DESC);
    CREATE INDEX IF NOT EXISTS idx_fuel_tanks_code ON fuel_tanks(code);
    CREATE INDEX IF NOT EXISTS idx_fuel_tanks_project ON fuel_tanks(project_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_corrections_issue ON fuel_corrections(fuel_issue_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_dips_tank_date ON fuel_tank_dips(tank_id, dip_date DESC);
    CREATE INDEX IF NOT EXISTS idx_fuel_bulk_tank_date ON fuel_bulk_deliveries(tank_id, delivery_date DESC);
    CREATE INDEX IF NOT EXISTS idx_fuel_readings_asset_date ON fuel_meter_readings(asset_id, reading_date DESC);
  `);

  // Seed Fuel Role Capabilities if role_capabilities table exists
  const hasRoleCaps = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_capabilities'").get();
  if (hasRoleCaps) {
    const fuelCapabilities = [
      { key: 'fuel.view', roles: ['admin', 'manager', 'operational_manager', 'transport_manager', 'assistant_transport_manager', 'workshop', 'site_storekeeper', 'storekeeper', 'viewer'] },
      { key: 'fuel.request', roles: ['admin', 'manager', 'operational_manager', 'transport_manager', 'workshop', 'site_storekeeper'] },
      { key: 'fuel.issue', roles: ['admin', 'manager', 'operational_manager', 'workshop', 'site_storekeeper', 'storekeeper'] },
      { key: 'fuel.approve', roles: ['admin', 'manager', 'operational_manager', 'transport_manager'] },
      { key: 'fuel.correct', roles: ['admin', 'manager', 'operational_manager'] },
      { key: 'fuel.void', roles: ['admin', 'manager'] },
      { key: 'fuel.export', roles: ['admin', 'manager', 'operational_manager', 'transport_manager'] },
      { key: 'fuel.tanks.view', roles: ['admin', 'manager', 'operational_manager', 'transport_manager', 'workshop', 'site_storekeeper', 'storekeeper', 'viewer'] },
      { key: 'fuel.tanks.manage', roles: ['admin', 'manager', 'operational_manager'] },
      { key: 'fuel.tanks.dip', roles: ['admin', 'manager', 'operational_manager', 'workshop', 'site_storekeeper', 'storekeeper'] },
      { key: 'fuel.tanks.refill', roles: ['admin', 'manager', 'operational_manager', 'workshop', 'site_storekeeper'] },
      { key: 'fuel.prices.view', roles: ['admin', 'manager', 'operational_manager', 'transport_manager', 'viewer'] },
      { key: 'fuel.prices.manage', roles: ['admin', 'manager', 'operational_manager'] },
    ];

    const insertStmt = targetDb.prepare(`
      INSERT INTO role_capabilities (role, capability, granted, updated_at)
      VALUES (?, ?, 1, datetime('now'))
      -- DO NOTHING: this runs on every start, and must not give back a permission an admin took away.
      ON CONFLICT(role, capability) DO NOTHING
    `);

    for (const fc of fuelCapabilities) {
      for (const r of fc.roles) {
        try {
          insertStmt.run(r, fc.key);
        } catch (_) {}
      }
    }
    console.log('[055] Seeded Fuel role capabilities');
  }

  console.log('=== Migration 055 Complete ===');
}

module.exports = { runMigration };
