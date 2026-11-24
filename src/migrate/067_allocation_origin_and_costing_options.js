'use strict';

/**
 * Migration 067: Fuel-Driven Auto-Allocation Origin/Lock Columns & Costing Options
 *
 * 1. Adds `origin` ('MANUAL' | 'AUTO_FUEL') and `locked` (0 | 1) to `fleet_vehicle_allocations`
 *    so auto-allocated monthly rows never overwrite manual/locked allocations.
 * 2. Seeds default billing & auto-allocation rules in `settings`.
 */

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColumnSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

const DEFAULT_SETTINGS = [
  ['billing.earlyMonthCutoffDay', '10'],
  ['billing.workingDaysPerMonth', '25'],
  ['billing.autoAllocMinConsecutive', '2'],
  ['billing.singleSiteFullMonthMode', 'EARLY_CUTOFF'],
];

function runMigration(db) {
  let originAdded = false;
  let lockedAdded = false;
  let settingsSeeded = 0;

  if (tableExists(db, 'fleet_vehicle_allocations')) {
    const cols = getColumnSet(db, 'fleet_vehicle_allocations');
    if (!cols.has('origin')) {
      db.exec("ALTER TABLE fleet_vehicle_allocations ADD COLUMN origin TEXT NOT NULL DEFAULT 'MANUAL'");
      originAdded = true;
    }
    if (!cols.has('locked')) {
      db.exec('ALTER TABLE fleet_vehicle_allocations ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
      lockedAdded = true;
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_fva_asset_month_origin ON fleet_vehicle_allocations(asset_id, month, origin)');
  }

  if (tableExists(db, 'settings')) {
    const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of DEFAULT_SETTINGS) {
      const info = ins.run(k, v);
      if (info && info.changes > 0) settingsSeeded++;
    }
  }

  return { originAdded, lockedAdded, settingsSeeded };
}

module.exports = { runMigration };
