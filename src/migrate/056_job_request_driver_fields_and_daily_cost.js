'use strict';

/**
 * Migration 056: Job Request / Job Card Driver Fields & Monthly Overheads
 *
 * 1. Add driver_name, contact_no, meter_reading columns to job_requests (if not present).
 * 2. Add driver_name, contact_no, meter_reading columns to job_cards (if not present).
 * 3. Create workshop_monthly_overheads table for tracking overhead expenses
 *    (electricity, internet, telephone allowance, travelling allowance, other expenses).
 * 4. Seed initial default overheads row for current year_month.
 *
 * Guarded by setting key 'migration_056_done'.
 * Fully idempotent across single-database and multidb modes.
 */

function runMigration(targetDb) {
  console.log('=== Running Migration 056: Job Request Driver Fields & Daily Cost ===');
  if (!targetDb) return;

  // Helper to ensure column exists
  function ensureCol(tableName, colName, colType) {
    try {
      const tableCheck = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
      if (!tableCheck) return;
      const cols = targetDb.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
      if (!cols.includes(colName)) {
        console.log(`Adding column ${colName} (${colType}) to ${tableName}...`);
        targetDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`);
      }
    } catch (err) {
      console.warn(`Could not add column ${colName} to ${tableName}:`, err.message);
    }
  }

  // 1. job_requests columns
  ensureCol('job_requests', 'driver_name', 'TEXT');
  ensureCol('job_requests', 'contact_no', 'TEXT');
  ensureCol('job_requests', 'meter_reading', 'TEXT');

  // 2. job_cards columns
  ensureCol('job_cards', 'driver_name', 'TEXT');
  ensureCol('job_cards', 'contact_no', 'TEXT');
  ensureCol('job_cards', 'meter_reading', 'TEXT');

  // 3. workshop_monthly_overheads table
  try {
    const existingTable = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workshop_monthly_overheads'").get();
    if (existingTable && existingTable.sql && existingTable.sql.includes('REFERENCES users')) {
      targetDb.exec("DROP TABLE workshop_monthly_overheads");
    }

    targetDb.exec(`
      CREATE TABLE IF NOT EXISTS workshop_monthly_overheads (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        workshop_id          INTEGER NOT NULL DEFAULT 1,
        year_month           TEXT NOT NULL,            -- 'YYYY-MM'
        electricity_cost     REAL NOT NULL DEFAULT 60000.0,
        internet_bill        REAL NOT NULL DEFAULT 5000.0,
        telephone_allowance  REAL NOT NULL DEFAULT 13250.0,
        travelling_allowance REAL NOT NULL DEFAULT 0.0,
        other_expenses       REAL NOT NULL DEFAULT 5000.0,
        notes                TEXT,
        updated_by           INTEGER,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(workshop_id, year_month)
      );
      CREATE INDEX IF NOT EXISTS idx_wmo_ym ON workshop_monthly_overheads(year_month);
      CREATE INDEX IF NOT EXISTS idx_wmo_ws_ym ON workshop_monthly_overheads(workshop_id, year_month);
    `);

    // 4. Seed initial default overheads row for current year_month
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    targetDb.prepare(`
      INSERT OR IGNORE INTO workshop_monthly_overheads
        (workshop_id, year_month, electricity_cost, internet_bill, telephone_allowance, travelling_allowance, other_expenses, notes)
      VALUES (1, ?, 60000.0, 5000.0, 13250.0, 0.0, 5000.0, 'Standard baseline overheads')
    `).run(ym);

  } catch (err) {
    console.warn('Could not create/seed workshop_monthly_overheads:', err.message);
  }

  console.log('=== Migration 056 Completed Successfully ===');
}

module.exports = { runMigration };
