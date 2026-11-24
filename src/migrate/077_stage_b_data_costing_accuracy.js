'use strict';

/**
 * Migration 077 — Stage B: Data & Costing Accuracy
 *
 * 1. Adds `meter_faulty` and `meter_fault_reason` columns to `fuel_requests`
 *    and `fuel_issues` so faulty meters can be explicitly logged instead of
 *    silently leaving meter readings blank.
 * 2. Seeds default policy settings:
 *    - `stock.block_negative_issue` = '0' (configurable strict non-negative issue guard)
 *    - `fuel.require_meter_or_faulty` = '1' (enforces valid meter or explicit faulty flag)
 */

function hasCol(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

function runMigration(db) {
  const addedColumns = [];
  const ensureCol = (table, col, defSql) => {
    if (!hasCol(db, table, col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${defSql}`);
      addedColumns.push(`${table}.${col}`);
    }
  };

  ensureCol('fuel_requests', 'meter_faulty', 'INTEGER NOT NULL DEFAULT 0');
  ensureCol('fuel_requests', 'meter_fault_reason', 'TEXT');
  ensureCol('fuel_issues', 'meter_faulty', 'INTEGER NOT NULL DEFAULT 0');
  ensureCol('fuel_issues', 'meter_fault_reason', 'TEXT');

  const seededSettings = [];
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of [
    ['stock.block_negative_issue', '0'],
    ['fuel.require_meter_or_faulty', '1'],
  ]) {
    const info = insSetting.run(k, v);
    if (info.changes > 0) seededSettings.push(k);
  }

  return { addedColumns, seededSettings };
}

module.exports = { runMigration };
