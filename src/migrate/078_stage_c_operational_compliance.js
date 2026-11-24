'use strict';

/**
 * Migration 078 — Stage C: Operational Efficiency & Compliance
 *
 * 1. Adds reconciliation & dip-type tracking columns to `fuel_tank_dips` so
 *    opening-stock calibration and reconciled physical dips are tracked cleanly.
 * 2. Adds query indexes for `site_fuel_budgets(year, month)` and
 *    `fuel_tank_dips(tank_id, dip_date)`.
 * 3. Seeds default policy settings:
 *    - `fuel.dip_variance_threshold_litres` = '50'
 *    - `fuel.budget_warn_pct` = '85'
 *    - `vdocs.expiry_warn_days` = '30'
 */

function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function hasCol(db, table, col) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().some((c) => c.name === col);
}

function runMigration(db) {
  const addedColumns = [];
  const createdIndexes = [];

  if (hasTable(db, 'fuel_tank_dips')) {
    const ensureCol = (col, defSql) => {
      if (!hasCol(db, 'fuel_tank_dips', col)) {
        db.exec(`ALTER TABLE fuel_tank_dips ADD COLUMN ${col} ${defSql}`);
        addedColumns.push(`fuel_tank_dips.${col}`);
      }
    };

    ensureCol('dip_type', "TEXT NOT NULL DEFAULT 'PHYSICAL_DIP'");
    ensureCol('reconciled', 'INTEGER NOT NULL DEFAULT 0');
    ensureCol('reconciled_at', 'TEXT');
    ensureCol('reconciled_by', 'INTEGER');
    ensureCol('reconciled_note', 'TEXT');

    db.exec('CREATE INDEX IF NOT EXISTS idx_fuel_tank_dips_tank_date ON fuel_tank_dips(tank_id, dip_date)');
    createdIndexes.push('idx_fuel_tank_dips_tank_date');
  }

  if (hasTable(db, 'site_fuel_budgets')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_site_fuel_budgets_ym ON site_fuel_budgets(year, month)');
    createdIndexes.push('idx_site_fuel_budgets_ym');
  }

  const seededSettings = [];
  if (hasTable(db, 'settings')) {
    const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of [
      ['fuel.dip_variance_threshold_litres', '50'],
      ['fuel.budget_warn_pct', '85'],
      ['vdocs.expiry_warn_days', '30'],
    ]) {
      const info = insSetting.run(k, v);
      if (info.changes > 0) seededSettings.push(k);
    }
  }

  return { addedColumns, createdIndexes, seededSettings };
}

module.exports = { runMigration };
