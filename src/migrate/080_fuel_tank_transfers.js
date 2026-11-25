'use strict';

/**
 * Migration 080: Bulk Tank-to-Tank Fuel Transfer Request Workflow
 *
 * Adds `fuel_tank_transfers` table so site tanks (e.g. Galagedara, Wadakada)
 * can request bulk diesel from central/source tanks (e.g. Badalgama), route
 * through Transport Section approval & bowser assignment, track IN_TRANSIT
 * dispatches from source tanks, and confirm receipt + transit variance into
 * destination tanks with zero false vehicle fuel cost.
 */

function runMigration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fuel_tank_transfers (
      id TEXT PRIMARY KEY,
      transfer_no TEXT UNIQUE NOT NULL,
      source_tank_id TEXT NOT NULL,
      dest_tank_id TEXT NOT NULL,
      source_project_id INTEGER,
      dest_project_id INTEGER,
      fuel_type TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
      requested_litres REAL NOT NULL,
      approved_litres REAL,
      dispatched_litres REAL,
      received_litres REAL,
      variance_litres REAL,
      bowser_asset_id INTEGER,
      bowser_code TEXT,
      driver_name TEXT,
      seal_no TEXT,
      receive_seal_no TEXT,
      requested_channel TEXT NOT NULL DEFAULT 'SITE',
      status TEXT NOT NULL DEFAULT 'PENDING',
      reason TEXT,
      review_note TEXT,
      dispatch_note TEXT,
      receive_note TEXT,
      rejection_reason TEXT,
      delivery_id TEXT,
      requested_by INTEGER,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_by INTEGER,
      approved_at TEXT,
      dispatched_by INTEGER,
      dispatched_at TEXT,
      received_by INTEGER,
      received_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ftt_status ON fuel_tank_transfers(status);
    CREATE INDEX IF NOT EXISTS idx_ftt_source_tank ON fuel_tank_transfers(source_tank_id, status);
    CREATE INDEX IF NOT EXISTS idx_ftt_dest_tank ON fuel_tank_transfers(dest_tank_id, status);
  `);
  return { created: true };
}

module.exports = { runMigration };
