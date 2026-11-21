'use strict';

/**
 * Migration 065: Phase 3 Tank Project Mapping, Allocation Current-Flag & Delivery Pricing Backfill
 *
 * 1. Assign project_id to legacy tanks TANK-CW (Badalgama Plant) and TANK-MRW (Marawila) when NULL.
 * 2. Mark the latest active fleet_vehicle_allocations row per vehicle as is_current = 1 (when none marked yet).
 * 3. Backfill cost_cents on DELIVERED fuel_bulk_deliveries where cost_cents <= 0 using date-effective fuel_prices.
 */

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(db, table, col) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

function runMigration(db) {
  let tanksLinked = 0;
  let allocationsMarkedCurrent = 0;
  let deliveriesPriced = 0;

  // 1. Link remaining unlinked active tanks to their physical site projects
  if (tableExists(db, 'fuel_tanks') && tableExists(db, 'projects')) {
    const bgp = db.prepare(`
      SELECT id FROM projects
       WHERE UPPER(COALESCE(code, '')) = 'BGP' OR LOWER(COALESCE(name, '')) LIKE '%badalgama%'
       ORDER BY id ASC LIMIT 1
    `).get();
    if (bgp) {
      const r = db.prepare(`
        UPDATE fuel_tanks
           SET project_id = ?, updated_at = datetime('now')
         WHERE code = 'TANK-CW' AND project_id IS NULL
      `).run(bgp.id);
      tanksLinked += r.changes || 0;
    }

    const mara = db.prepare(`
      SELECT id FROM projects
       WHERE UPPER(COALESCE(code, '')) = 'MARA' OR LOWER(TRIM(COALESCE(name, ''))) = 'marawila'
       ORDER BY id DESC LIMIT 1
    `).get() || db.prepare(`
      SELECT id FROM projects
       WHERE LOWER(COALESCE(name, '')) LIKE '%marawila%'
       ORDER BY id ASC LIMIT 1
    `).get();
    if (mara) {
      const r = db.prepare(`
        UPDATE fuel_tanks
           SET project_id = ?, updated_at = datetime('now')
         WHERE code = 'TANK-MRW' AND project_id IS NULL
      `).run(mara.id);
      tanksLinked += r.changes || 0;
    }
  }

  // 2. Populate fleet_vehicle_allocations.is_current = 1 for the latest active row per vehicle
  if (hasColumn(db, 'fleet_vehicle_allocations', 'is_current')) {
    const existingCurrent = db.prepare(`
      SELECT COUNT(*) AS c FROM fleet_vehicle_allocations WHERE active = 1 AND COALESCE(is_current, 0) = 1
    `).get().c;
    if (existingCurrent === 0) {
      const r = db.prepare(`
        UPDATE fleet_vehicle_allocations
           SET is_current = 1, updated_at = datetime('now')
         WHERE rowid IN (
           SELECT rid FROM (
             SELECT rowid AS rid,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(CAST(asset_id AS TEXT), UPPER(TRIM(COALESCE(vehicle_no, ''))))
                      ORDER BY COALESCE(month, month_to, month_from, '') DESC,
                               COALESCE(date_to, date_from, '') DESC,
                               rowid DESC
                    ) AS rn
               FROM fleet_vehicle_allocations
              WHERE active = 1
           )
          WHERE rn = 1
         )
      `).run();
      allocationsMarkedCurrent = r.changes || 0;
    }
  }

  // 3. Backfill unpriced DELIVERED fuel_bulk_deliveries from date-effective fuel_prices
  if (tableExists(db, 'fuel_bulk_deliveries') && tableExists(db, 'fuel_prices')) {
    const rows = db.prepare(`
      SELECT id, fuel_type, litres, delivery_date
        FROM fuel_bulk_deliveries
       WHERE status = 'DELIVERED' AND COALESCE(cost_cents, 0) <= 0 AND COALESCE(litres, 0) > 0
    `).all();

    if (rows.length) {
      const exactStmt = db.prepare(`
        SELECT price_per_litre_cents, price_per_litre
          FROM fuel_prices
         WHERE UPPER(COALESCE(fuel_type, fuel_kind)) = ?
           AND effective_date <= ?
         ORDER BY effective_date DESC, id DESC LIMIT 1
      `);
      const fallbackStmt = db.prepare(`
        SELECT price_per_litre_cents, price_per_litre
          FROM fuel_prices
         WHERE UPPER(COALESCE(fuel_type, fuel_kind)) = ?
         ORDER BY effective_date ASC, id ASC LIMIT 1
      `);
      const updStmt = db.prepare('UPDATE fuel_bulk_deliveries SET cost_cents = ? WHERE id = ?');

      const applyPrices = db.transaction(() => {
        for (const d of rows) {
          const ft = String(d.fuel_type || 'AUTO_DIESEL').trim().toUpperCase();
          const dt = String(d.delivery_date || '').trim().slice(0, 10) || new Date().toISOString().slice(0, 10);
          const p = exactStmt.get(ft, dt) || fallbackStmt.get(ft);
          if (!p) continue;
          const unitCents = Number(p.price_per_litre_cents) || Math.round(Number(p.price_per_litre || 0) * 100);
          if (!(unitCents > 0)) continue;
          const totalCents = Math.round(Number(d.litres) * unitCents);
          if (totalCents > 0) {
            updStmt.run(totalCents, d.id);
            deliveriesPriced++;
          }
        }
      });
      applyPrices();
    }
  }

  return { tanksLinked, allocationsMarkedCurrent, deliveriesPriced };
}

module.exports = { runMigration };
