'use strict';

/**
 * Migration 064: P0/P1 Data Hygiene, Index Optimization & Vehicle Fuel Cost Backfill
 *
 * 1. Fixes swapped project_id links on CEP-03 and Ruwanwella site store locations.
 * 2. Merges duplicate active Galagedara workshop (GALA -> GWS) and reassigns refs.
 * 3. Cleans leaked test-suite rows (DC/TEST/%, TEST/R/%, JR-TEST-%, 2099-11-15, Test Brake Shoe).
 * 4. Marks delivered bulk fuel deliveries referencing deactivated test tanks as CANCELLED.
 * 5. Prunes expired sessions.
 * 6. Adds missing SQLite indexes on high-traffic / under-indexed tables (safe across partial schemas).
 * 7. Backfills vehicle_monthly_costs.fuel_cost and re-syncs NULL-category parts_cost across history.
 */

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function tableCols(db, name) {
  if (!hasTable(db, name)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name));
}

function safeIndex(db, indexName, tableName, colExprList) {
  const cols = tableCols(db, tableName);
  if (cols.size === 0) return false;
  for (const colExpr of colExprList) {
    const colName = String(colExpr).trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9_]/g, '');
    if (!cols.has(colName)) return false;
  }
  db.prepare(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${tableName}" (${colExprList.join(', ')})`).run();
  return true;
}

function runMigration(db) {
  console.log('=== Running Migration 064: Data Hygiene, Indexes & Fuel Cost Backfill ===');

  const stats = {
    storeLinksFixed: 0,
    workshopMerged: false,
    testRowsCleaned: 0,
    expiredSessionsPruned: 0,
    indexesCreated: 0,
    fuelMonthsBackfilled: 0,
  };

  db.transaction(() => {
    // 0. Ensure vehicle_hiring_revenue & vehicle_driver_other_costs exist on fresh DBs
    db.exec(`
      CREATE TABLE IF NOT EXISTS vehicle_hiring_revenue (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id      INTEGER NOT NULL REFERENCES assets(id),
        date          TEXT NOT NULL,
        month         TEXT NOT NULL,
        project_id    INTEGER REFERENCES projects(id),
        hire_type     TEXT NOT NULL DEFAULT 'hours',
        quantity      REAL NOT NULL DEFAULT 0,
        hire_rate     REAL NOT NULL DEFAULT 0,
        total_revenue REAL NOT NULL DEFAULT 0,
        invoice_no    TEXT,
        notes         TEXT,
        created_by    INTEGER REFERENCES users(id),
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS vehicle_driver_other_costs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id       INTEGER NOT NULL REFERENCES assets(id),
        date           TEXT NOT NULL,
        month          TEXT NOT NULL,
        project_id     INTEGER REFERENCES projects(id),
        cost_type      TEXT NOT NULL,
        driver_name    TEXT,
        driver_salary  REAL NOT NULL DEFAULT 0,
        bata_ot        REAL NOT NULL DEFAULT 0,
        other_expenses REAL NOT NULL DEFAULT 0,
        amount         REAL NOT NULL DEFAULT 0,
        description    TEXT,
        created_by     INTEGER REFERENCES users(id),
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // 1. Fix swapped project_id on CEP-03 & Ruwanwella site stores (name-matched safely)
    if (hasTable(db, 'store_locations') && hasTable(db, 'projects')) {
      const cepProj = db.prepare("SELECT id FROM projects WHERE name = 'CEP-03 Project' LIMIT 1").get();
      const ruwProj = db.prepare("SELECT id FROM projects WHERE name = 'Ruwanwella Water Project' LIMIT 1").get();
      if (cepProj) {
        const r = db.prepare("UPDATE store_locations SET project_id = ? WHERE code = 'SITE-STORE-CEP03PROJE' AND COALESCE(project_id, 0) != ?").run(cepProj.id, cepProj.id);
        stats.storeLinksFixed += r.changes;
      }
      if (ruwProj) {
        const r = db.prepare("UPDATE store_locations SET project_id = ? WHERE code = 'SITE-STORE-RUWANWELLA' AND COALESCE(project_id, 0) != ?").run(ruwProj.id, ruwProj.id);
        stats.storeLinksFixed += r.changes;
      }
    }

    // 2. Merge duplicate active Galagedara workshop (GALA -> GWS)
    if (hasTable(db, 'workshops')) {
      const gws = db.prepare("SELECT id FROM workshops WHERE code = 'GWS' AND COALESCE(active, 1) = 1 LIMIT 1").get();
      const gala = db.prepare("SELECT id FROM workshops WHERE code = 'GALA' AND COALESCE(active, 1) = 1 LIMIT 1").get();
      if (gws && gala && gws.id !== gala.id) {
        for (const tbl of ['users', 'job_cards', 'job_requests', 'store_locations', 'service_jobs', 'outsourcing_requests']) {
          if (tableCols(db, tbl).has('workshop_id')) {
            db.prepare(`UPDATE "${tbl}" SET workshop_id = ? WHERE workshop_id = ?`).run(gws.id, gala.id);
          }
        }
        if (hasTable(db, 'mechanic_workshops')) {
          db.prepare('UPDATE OR IGNORE mechanic_workshops SET workshop_id = ? WHERE workshop_id = ?').run(gws.id, gala.id);
          db.prepare('DELETE FROM mechanic_workshops WHERE workshop_id = ?').run(gala.id);
        }
        if (hasTable(db, 'user_workshops')) {
          db.prepare('UPDATE OR IGNORE user_workshops SET workshop_id = ? WHERE workshop_id = ?').run(gws.id, gala.id);
          db.prepare('DELETE FROM user_workshops WHERE workshop_id = ?').run(gala.id);
        }
        db.prepare('UPDATE workshops SET active = 0 WHERE id = ?').run(gala.id);
        stats.workshopMerged = true;
      }
    }

    // 3. Clean leaked test-suite pollution (strictly matching exact test markers)
    if (hasTable(db, 'job_cards')) {
      const testJobs = db.prepare("SELECT id FROM job_cards WHERE job_no LIKE 'DC/TEST/%' OR job_no LIKE 'TEST/R/%'").all().map((r) => r.id);
      if (testJobs.length > 0) {
        const ph = testJobs.map(() => '?').join(',');
        for (const child of ['job_daily_work', 'job_labour', 'job_parts', 'job_costs', 'job_approvals', 'job_hold_reasons', 'general_item_txns', 'issues']) {
          if (tableCols(db, child).has('job_id')) {
            stats.testRowsCleaned += db.prepare(`DELETE FROM "${child}" WHERE job_id IN (${ph})`).run(...testJobs).changes;
          }
        }
        if (hasTable(db, 'mrn_lines') && hasTable(db, 'mrn')) {
          const mrnIds = db.prepare(`SELECT id FROM mrn WHERE job_id IN (${ph})`).all(...testJobs).map((r) => r.id);
          if (mrnIds.length) {
            const mph = mrnIds.map(() => '?').join(',');
            stats.testRowsCleaned += db.prepare(`DELETE FROM mrn_lines WHERE mrn_id IN (${mph})`).run(...mrnIds).changes;
            stats.testRowsCleaned += db.prepare(`DELETE FROM mrn WHERE id IN (${mph})`).run(...mrnIds).changes;
          }
        }
        stats.testRowsCleaned += db.prepare(`DELETE FROM job_cards WHERE id IN (${ph})`).run(...testJobs).changes;
      }
    }

    if (hasTable(db, 'job_requests')) {
      stats.testRowsCleaned += db.prepare("DELETE FROM job_requests WHERE jr_no LIKE 'JR-TEST-%' AND description = 'Engine knocking sound'").run().changes;
    }

    if (hasTable(db, 'store_items')) {
      const testItems = db.prepare("SELECT id FROM store_items WHERE part_number = 'TEST-PN-001' AND name = 'Test Brake Shoe'").all().map((r) => r.id);
      if (testItems.length > 0) {
        const ph = testItems.map(() => '?').join(',');
        if (tableCols(db, 'general_item_txns').has('store_item_id')) {
          stats.testRowsCleaned += db.prepare(`DELETE FROM general_item_txns WHERE store_item_id IN (${ph})`).run(...testItems).changes;
        }
        if (tableCols(db, 'issues').has('store_item_id')) {
          stats.testRowsCleaned += db.prepare(`DELETE FROM issues WHERE store_item_id IN (${ph})`).run(...testItems).changes;
        }
        stats.testRowsCleaned += db.prepare(`DELETE FROM store_items WHERE id IN (${ph})`).run(...testItems).changes;
      }
    }

    if (hasTable(db, 'issues')) {
      stats.testRowsCleaned += db.prepare("DELETE FROM issues WHERE description = 'Test Brake Shoe' AND issue_date > '2090-01-01'").run().changes;
    }
    if (hasTable(db, 'job_daily_work')) {
      stats.testRowsCleaned += db.prepare("DELETE FROM job_daily_work WHERE work_date > '2090-01-01' AND mechanic = 'Test Mechanic 01'").run().changes;
    }
    if (hasTable(db, 'workshop_monthly_overheads')) {
      stats.testRowsCleaned += db.prepare("DELETE FROM workshop_monthly_overheads WHERE year_month = '2099-11' AND notes = 'Test baseline'").run().changes;
    }
    if (hasTable(db, 'labour_rates')) {
      stats.testRowsCleaned += db.prepare("DELETE FROM labour_rates WHERE mechanic = 'Test Mechanic 01'").run().changes;
    }
    if (hasTable(db, 'users')) {
      stats.testRowsCleaned += db.prepare("UPDATE users SET active = 0 WHERE username IN ('sk_gala_remed', 'sk_deact_remed') AND active = 1").run().changes;
    }

    // 4. Mark delivered bulk fuel deliveries referencing deactivated test tanks as CANCELLED
    if (hasTable(db, 'fuel_bulk_deliveries') && hasTable(db, 'fuel_tanks')) {
      stats.testRowsCleaned += db.prepare(`
        UPDATE fuel_bulk_deliveries
           SET status = 'CANCELLED',
               note = COALESCE(note || ' ', '') || '[Archived deactivated test tank delivery]'
         WHERE status != 'CANCELLED'
           AND tank_id IN (
             SELECT id FROM fuel_tanks
              WHERE active = 0 AND name IN ('test Tank', 'Central Workshop Main Tank')
           )
      `).run().changes;
    }

    // 5. Prune expired sessions
    if (hasTable(db, 'sessions')) {
      stats.expiredSessionsPruned = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run().changes;
    }

    // 6. Create missing SQLite performance indexes
    const idxDefs = [
      ['idx_filter_catalogue_oem_norm', 'filter_catalogue', ['oem_pn_norm']],
      ['idx_filter_catalogue_hifi_norm', 'filter_catalogue', ['hifi_pn_norm']],
      ['idx_filter_catalogue_category', 'filter_catalogue', ['category']],
      ['idx_filter_stock_ledger_filter', 'filter_stock_ledger', ['filter_id', 'created_at']],
      ['idx_vehicle_holds_asset', 'vehicle_holds', ['asset_id']],
      ['idx_fuel_meter_readings_asset_date', 'fuel_meter_readings', ['asset_id', 'reading_date DESC']],
      ['idx_pm_tasks_cat', 'pm_tasks', ['category', 'sort_order']],
      ['idx_fuel_pm_tasks_asset_status', 'fuel_pm_tasks', ['asset_id', 'status']],
      ['idx_store_items_partno', 'store_items', ['part_number']],
      ['idx_store_items_category_id', 'store_items', ['category_id']],
      ['idx_store_items_is_general', 'store_items', ['is_general']],
      ['idx_service_oils_service_id', 'service_oils', ['service_id']],
      ['idx_fuel_issues_asset_date', 'fuel_issues', ['asset_id', 'issue_date DESC']],
      ['idx_fuel_issues_proj_date', 'fuel_issues', ['source_project_id', 'issue_date DESC']],
      ['idx_tyre_battery_issues_asset_date', 'tyre_battery_issues', ['asset_id', 'issue_date DESC']],
      ['idx_sessions_expires', 'sessions', ['expires_at']],
      ['idx_vehicle_hiring_revenue_asset_month', 'vehicle_hiring_revenue', ['asset_id', 'month']],
      ['idx_vehicle_driver_other_costs_asset_month', 'vehicle_driver_other_costs', ['asset_id', 'month']],
    ];
    for (const [name, tbl, cols] of idxDefs) {
      if (safeIndex(db, name, tbl, cols)) stats.indexesCreated++;
    }

    // 7. Backfill vehicle_monthly_costs.fuel_cost and NULL-category parts_cost
    const vmcCols = tableCols(db, 'vehicle_monthly_costs');
    const fiCols = tableCols(db, 'fuel_issues');
    if (vmcCols.has('fuel_cost') && fiCols.has('asset_id') && fiCols.has('issue_date')) {
      const priceExpr = fiCols.has('total_cost_cents')
        ? `CASE
             WHEN COALESCE(total_cost_cents, 0) > 0 THEN total_cost_cents / 100.0
             WHEN COALESCE(cost_cents, 0) > 0 THEN cost_cents / 100.0
             WHEN COALESCE(total_price, 0) > 0 THEN total_price
             WHEN COALESCE(fuel_price_cents, price_per_litre_cents, 0) > 0 THEN (COALESCE(litres, 0) * COALESCE(fuel_price_cents, price_per_litre_cents)) / 100.0
             ELSE COALESCE(litres, 0) * COALESCE(unit_price, 0)
           END`
        : 'COALESCE(litres, 0) * COALESCE(unit_price, 0)';
      const voidExpr = fiCols.has('is_voided') ? 'COALESCE(is_voided, voided, 0) = 0' : 'COALESCE(voided, 0) = 0';

      const fuelAgg = db.prepare(`
        SELECT asset_id,
               CAST(substr(issue_date, 1, 4) AS INTEGER) AS yr,
               CAST(substr(issue_date, 6, 2) AS INTEGER) AS mo,
               ROUND(COALESCE(SUM(${priceExpr}), 0), 2) AS fuel_rs
          FROM fuel_issues
         WHERE asset_id IS NOT NULL
           AND length(issue_date) >= 7
           AND substr(issue_date, 5, 1) = '-'
           AND ${voidExpr}
         GROUP BY asset_id, yr, mo
      `).all();

      const fuelMap = new Map();
      for (const r of fuelAgg) {
        if (!r.yr || !r.mo || r.mo < 1 || r.mo > 12) continue;
        fuelMap.set(`${r.asset_id}:${r.yr}:${r.mo}`, Number(r.fuel_rs) || 0);
      }

      // First zero out stale fuel_cost on existing rows and recompute total_cost
      const existingRows = db.prepare('SELECT id, asset_id, year, month, oil_cost, filter_cost, battery_cost, parts_cost, labour_cost FROM vehicle_monthly_costs').all();
      const updStmt = db.prepare(`
        UPDATE vehicle_monthly_costs
           SET fuel_cost = ?,
               total_cost = ROUND(COALESCE(oil_cost,0) + COALESCE(filter_cost,0) + COALESCE(battery_cost,0) + COALESCE(parts_cost,0) + COALESCE(labour_cost,0) + ?, 2),
               updated_at = datetime('now')
         WHERE id = ?
      `);
      const seenKeys = new Set();
      for (const row of existingRows) {
        const key = `${row.asset_id}:${row.year}:${row.month}`;
        seenKeys.add(key);
        const fCost = fuelMap.get(key) || 0;
        updStmt.run(fCost, fCost, row.id);
        if (fCost > 0) stats.fuelMonthsBackfilled++;
      }

      // Insert missing asset-months that only have fuel_issues
      const insStmt = db.prepare(`
        INSERT INTO vehicle_monthly_costs (asset_id, year, month, fuel_cost, total_cost, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const [key, fCost] of fuelMap.entries()) {
        if (seenKeys.has(key) || fCost <= 0) continue;
        const [assetId, yr, mo] = key.split(':').map(Number);
        insStmt.run(assetId, yr, mo, fCost, fCost);
        stats.fuelMonthsBackfilled++;
      }

      // Also fix any vehicle-months with NULL-category issues that were previously dropped from parts_cost
      if (hasTable(db, 'issues')) {
        const nullCatMonths = db.prepare(`
          SELECT DISTINCT asset_id,
                 CAST(substr(issue_date, 1, 4) AS INTEGER) AS yr,
                 CAST(substr(issue_date, 6, 2) AS INTEGER) AS mo
            FROM issues
           WHERE asset_id IS NOT NULL AND category IS NULL AND length(issue_date) >= 7
        `).all();
        for (const b of nullCatMonths) {
          if (!b.yr || !b.mo) continue;
          const ym = `${b.yr}-${String(b.mo).padStart(2, '0')}`;
          const partsRow = db.prepare(`
            SELECT ROUND(COALESCE(SUM(qty * COALESCE(unit_price, 0)), 0)
              - COALESCE((SELECT SUM(r.qty * COALESCE(ir.unit_price, 0)) FROM issue_returns r JOIN issues ir ON ir.id = r.issue_id
                           WHERE ir.asset_id = ? AND substr(ir.issue_date, 1, 7) = ?), 0), 2) AS v
              FROM issues
             WHERE asset_id = ? AND substr(issue_date, 1, 7) = ?
               AND COALESCE(LOWER(category), '') NOT LIKE '%lubric%'
               AND COALESCE(LOWER(category), '') NOT LIKE '%oil%'
          `).get(b.asset_id, ym, b.asset_id, ym);
          const pCost = Number(partsRow && partsRow.v) || 0;
          const cur = db.prepare('SELECT id, fuel_cost, oil_cost, filter_cost, battery_cost, labour_cost FROM vehicle_monthly_costs WHERE asset_id = ? AND year = ? AND month = ?').get(b.asset_id, b.yr, b.mo);
          if (cur) {
            const total = Math.round(((cur.fuel_cost || 0) + (cur.oil_cost || 0) + (cur.filter_cost || 0) + (cur.battery_cost || 0) + (cur.labour_cost || 0) + pCost) * 100) / 100;
            db.prepare("UPDATE vehicle_monthly_costs SET parts_cost = ?, total_cost = ?, updated_at = datetime('now') WHERE id = ?").run(pCost, total, cur.id);
          } else if (pCost > 0) {
            db.prepare("INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(b.asset_id, b.yr, b.mo, pCost, pCost);
          }
        }
      }
    }
  })();

  console.log('=== Migration 064 Completed:', JSON.stringify(stats), '===');
  return stats;
}

module.exports = { runMigration };
