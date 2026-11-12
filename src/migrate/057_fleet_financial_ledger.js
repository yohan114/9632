'use strict';

/**
 * Migration 057: Fleet Financial Ledger & Cross-System Identity Mapping
 *
 * Implements native WorkshopOne schema for fleet financial reconciliation:
 * 1. fleet_financial_events (immutable, single-posting financial ledger)
 * 2. fleet_monthly_snapshots (sealed periodic profitability facts)
 * 3. fleet_identity_mappings (source-to-target entity mapping with 100% provenance)
 *
 * Registers financial reporting capabilities and seeds role defaults.
 * Fully idempotent across single-database and multidb modes.
 */

function runMigration(targetDb) {
  if (!targetDb) return;
  console.log('=== Running Migration 057: Fleet Financial Ledger & Identity Mapping ===');

  targetDb.exec(`
    -- 1. Immutable Unified Financial Events Ledger
    CREATE TABLE IF NOT EXISTS fleet_financial_events (
      id                    TEXT PRIMARY KEY,
      event_key             TEXT UNIQUE NOT NULL,
      event_type            TEXT NOT NULL CHECK (event_type IN (
                              'REVENUE_RENTAL', 'REVENUE_FUEL', 'COST_FUEL',
                              'COST_MAINTENANCE_LABOUR', 'COST_MAINTENANCE_PARTS',
                              'COST_MAINTENANCE_OIL', 'COST_CCOM_OUTSOURCE',
                              'COST_DRIVER_WAGE', 'COST_HIRED_IN', 'COST_FABRICATION',
                              'CREDIT_NOTE', 'PAYMENT'
                            )),
      asset_id              INTEGER,
      asset_code            TEXT NOT NULL,
      project_id            INTEGER,
      business_date         TEXT NOT NULL,
      year                  INTEGER NOT NULL,
      month                 INTEGER NOT NULL,
      amount_cents          INTEGER NOT NULL,
      quantity              REAL DEFAULT 0,
      unit                  TEXT,
      source_system         TEXT NOT NULL DEFAULT 'WORKSHOPONE',
      source_table          TEXT NOT NULL,
      source_id             TEXT NOT NULL,
      source_line_id        TEXT,
      reversal_of_event_id  TEXT REFERENCES fleet_financial_events(id),
      is_reversal           INTEGER NOT NULL DEFAULT 0,
      meta_json             TEXT,
      posted_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 2. Sealed Monthly Profitability Snapshots
    CREATE TABLE IF NOT EXISTS fleet_monthly_snapshots (
      id                            TEXT PRIMARY KEY,
      asset_id                      INTEGER,
      asset_code                    TEXT NOT NULL,
      year                          INTEGER NOT NULL,
      month                         INTEGER NOT NULL,
      period_key                    TEXT NOT NULL,
      rental_revenue_cents          INTEGER NOT NULL DEFAULT 0,
      fuel_recharge_revenue_cents   INTEGER NOT NULL DEFAULT 0,
      fuel_cost_cents               INTEGER NOT NULL DEFAULT 0,
      maintenance_labour_cents      INTEGER NOT NULL DEFAULT 0,
      maintenance_parts_cents       INTEGER NOT NULL DEFAULT 0,
      maintenance_oil_cents         INTEGER NOT NULL DEFAULT 0,
      ccom_outsourcing_cents        INTEGER NOT NULL DEFAULT 0,
      driver_wage_cents             INTEGER NOT NULL DEFAULT 0,
      hired_in_supplier_cents       INTEGER NOT NULL DEFAULT 0,
      operating_contribution_cents  INTEGER NOT NULL DEFAULT 0,
      allocated_overhead_cents      INTEGER NOT NULL DEFAULT 0,
      full_cost_result_cents        INTEGER NOT NULL DEFAULT 0,
      operating_hours               REAL DEFAULT 0,
      operating_km                  REAL DEFAULT 0,
      diesel_litres                 REAL DEFAULT 0,
      is_sealed                     INTEGER NOT NULL DEFAULT 0,
      sealed_at                     TEXT,
      sealed_by                     INTEGER,
      created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (asset_id, year, month)
    );

    -- 3. Cross-System Identity Provenance Mapping
    CREATE TABLE IF NOT EXISTS fleet_identity_mappings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type     TEXT NOT NULL CHECK (entity_type IN ('ASSET', 'PROJECT', 'USER', 'TANK', 'CATEGORY')),
      source_system   TEXT NOT NULL DEFAULT 'FUEL_SYSTEM_V2',
      source_id       TEXT NOT NULL,
      target_id       TEXT NOT NULL,
      match_method    TEXT NOT NULL CHECK (match_method IN ('EXACT_FLEET_CODE', 'EXACT_REG_NO', 'EXACT_PROJECT_CODE', 'EXACT_USERNAME', 'MANUAL_MAP', 'NEW_ENTRY')),
      source_code     TEXT,
      target_code     TEXT,
      notes           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source_system, entity_type, source_id)
    );

    -- Performance Indexes
    CREATE INDEX IF NOT EXISTS idx_fin_events_asset_month ON fleet_financial_events(asset_id, year, month);
    CREATE INDEX IF NOT EXISTS idx_fin_events_type ON fleet_financial_events(event_type, business_date);
    CREATE INDEX IF NOT EXISTS idx_fin_events_source ON fleet_financial_events(source_system, source_table, source_id);

    CREATE INDEX IF NOT EXISTS idx_monthly_snapshots_period ON fleet_monthly_snapshots(period_key);
    CREATE INDEX IF NOT EXISTS idx_monthly_snapshots_asset ON fleet_monthly_snapshots(asset_id);
    CREATE INDEX IF NOT EXISTS idx_identity_map_source ON fleet_identity_mappings(source_system, entity_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_identity_map_target ON fleet_identity_mappings(entity_type, target_id);
  `);

  // Seed Financial Reporting Capabilities
  const hasRoleCaps = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_capabilities'").get();
  if (hasRoleCaps) {
    const finCapabilities = [
      { key: 'fleet.profitability.view', roles: ['admin', 'manager', 'operational_manager', 'transport_manager'] },
      { key: 'fleet.profitability.view_all', roles: ['admin', 'manager', 'operational_manager'] },
      { key: 'fleet.profitability.export', roles: ['admin', 'manager', 'operational_manager'] },
      { key: 'finance.period.close', roles: ['admin', 'manager'] },
      { key: 'finance.period.reopen', roles: ['admin'] },
      { key: 'master_dashboard.view', roles: ['admin', 'manager', 'operational_manager', 'transport_manager', 'assistant_transport_manager', 'viewer'] },
    ];

    const insertStmt = targetDb.prepare(`
      INSERT INTO role_capabilities (role, capability, granted, updated_at)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(role, capability) DO UPDATE SET granted = 1, updated_at = datetime('now')
    `);

    for (const fc of finCapabilities) {
      for (const r of fc.roles) {
        try {
          insertStmt.run(r, fc.key);
        } catch (_) {}
      }
    }
    console.log('[057] Seeded Fleet Financial & Dashboard role capabilities');
  }

  console.log('=== Migration 057 Complete ===');
}

module.exports = { runMigration };
