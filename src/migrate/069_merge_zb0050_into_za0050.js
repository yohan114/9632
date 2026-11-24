'use strict';

/**
 * Migration 069: Merge all ZB-0050 duplicate assets and text references into TM-21 (ZA-0050)
 *
 * Background:
 *   Registered fleet vehicle TM-21 (TATA LPK 1618 Truck Mixer) has registration ZA-0050.
 *   Unregistered typo duplicates (ZB-0050, ZB-0050 TATA 2576, ZB-0050 rear engine) and
 *   free-text references accumulated across fuel, workshop, filter, tyre, and billing tables.
 *
 * This migration:
 *   1. Merges all FK/asset_id records into canonical TM-21 (ZA-0050) without losing data.
 *   2. Sums overlapping vehicle_monthly_costs and resolves vehicle_filter_schedules / rate duplicates.
 *   3. Replaces ZB-0050 / ZB0050 text references across operational tables with ZA-0050 / ZA0050.
 *   4. Deletes the unregistered ZB-0050* duplicate asset rows safely (verified against FKs).
 *   5. Seeds asset_aliases (ZB0050 -> TM-21) so future imports never recreate ZB-0050.
 */

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
}

function replaceZbText(val) {
  if (val == null || typeof val !== 'string') return val;
  return val.replace(/ZB([-\s]?)0050/gi, (_, sep) => (sep ? `ZA${sep}0050` : 'ZA0050'));
}

function replaceZbInTableColumn(db, table, col, pkCol = 'id') {
  if (!tableExists(db, table)) return 0;
  const cols = getColSet(db, table);
  if (!cols.has(col) || !cols.has(pkCol)) return 0;
  const rows = db.prepare(
    `SELECT "${pkCol}" AS pk, "${col}" AS val FROM "${table}"
      WHERE UPPER(COALESCE("${col}", '')) LIKE '%ZB-0050%'
         OR UPPER(COALESCE("${col}", '')) LIKE '%ZB0050%'
         OR UPPER(COALESCE("${col}", '')) LIKE '%ZB 0050%'`
  ).all();
  if (!rows.length) return 0;
  const upd = db.prepare(`UPDATE "${table}" SET "${col}" = ? WHERE "${pkCol}" = ?`);
  let updated = 0;
  for (const r of rows) {
    const nextVal = replaceZbText(r.val);
    if (nextVal !== r.val) {
      upd.run(nextVal, r.pk);
      updated++;
    }
  }
  return updated;
}

function runMigration(targetDb) {
  if (!targetDb || !tableExists(targetDb, 'assets')) {
    return { skipped: true };
  }

  let targetId = null;
  let targetCode = null;
  const mergedAssetIds = [];
  let fuelIssuesUpdated = 0;
  let textRowsUpdated = 0;
  let monthlyCostsMerged = 0;
  let snapshotsUpdated = 0;

  targetDb.transaction(() => {
    // 1. Find canonical target TM-21 / ZA-0050 asset
    let target = targetDb.prepare(`
      SELECT * FROM assets
       WHERE UPPER(TRIM(COALESCE(registration, ''))) = 'ZA-0050'
          OR UPPER(TRIM(COALESCE(code_norm, ''))) IN ('ZA0050', 'TM21')
       ORDER BY COALESCE(in_register, 0) DESC, id ASC
       LIMIT 1
    `).get();

    // Fallback if DB only has ZB-0050 and no ZA-0050/TM-21 row at all
    if (!target) {
      const zbOnly = targetDb.prepare(`
        SELECT * FROM assets
         WHERE UPPER(TRIM(COALESCE(code_norm, ''))) = 'ZB0050'
            OR UPPER(TRIM(COALESCE(code, ''))) = 'ZB-0050'
         ORDER BY id ASC LIMIT 1
      `).get();
      if (zbOnly) {
        targetDb.prepare(`
          UPDATE assets
             SET code = 'ZA-0050',
                 code_norm = 'ZA0050',
                 registration = COALESCE(NULLIF(TRIM(registration), ''), 'ZA-0050'),
                 updated_at = datetime('now')
           WHERE id = ?
        `).run(zbOnly.id);
        target = targetDb.prepare('SELECT * FROM assets WHERE id = ?').get(zbOnly.id);
      }
    }

    if (!target) return;
    targetId = target.id;
    targetCode = target.code;

    // 2. Find duplicate ZB-0050* assets
    const sources = targetDb.prepare(`
      SELECT * FROM assets
       WHERE id != ?
         AND (
           UPPER(COALESCE(code_norm, '')) LIKE 'ZB0050%'
           OR UPPER(COALESCE(code, '')) LIKE '%ZB-0050%'
           OR UPPER(COALESCE(code, '')) LIKE '%ZB 0050%'
           OR UPPER(COALESCE(registration, '')) LIKE '%ZB-0050%'
         )
       ORDER BY id ASC
    `).all(targetId);

    const sourceIds = sources.map((s) => s.id);
    for (const id of sourceIds) mergedAssetIds.push(id);

    const placeholders = sourceIds.map(() => '?').join(',');

    // 3. Merge fuel_issues (by sourceIds OR ZB-0050 text codes)
    if (tableExists(targetDb, 'fuel_issues')) {
      const fiCols = getColSet(targetDb, 'fuel_issues');
      const conds = [
        "UPPER(COALESCE(asset_code, '')) LIKE '%ZB%0050%'",
        "UPPER(COALESCE(vehicle_ref, '')) LIKE '%ZB%0050%'",
      ];
      if (sourceIds.length) conds.unshift(`asset_id IN (${placeholders})`);
      const fiRows = targetDb.prepare(
        `SELECT id, import_key FROM fuel_issues WHERE ${conds.join(' OR ')}`
      ).all(...sourceIds);

      if (fiRows.length) {
        const setParts = ['asset_id = ?', 'asset_code = ?', "vehicle_ref = 'ZA-0050'"];
        if (fiCols.has('updated_at')) setParts.push("updated_at = datetime('now')");
        const updFi = targetDb.prepare(`UPDATE fuel_issues SET ${setParts.join(', ')} WHERE id = ?`);
        const chkImportKey = fiCols.has('import_key')
          ? targetDb.prepare('SELECT 1 FROM fuel_issues WHERE import_key = ? AND id != ? LIMIT 1')
          : null;
        const updImportKey = fiCols.has('import_key')
          ? targetDb.prepare('UPDATE fuel_issues SET import_key = ? WHERE id = ?')
          : null;

        for (const r of fiRows) {
          const info = updFi.run(targetId, targetCode, r.id);
          fuelIssuesUpdated += info.changes || 0;
          if (r.import_key && chkImportKey && /ZB[-\s]?0050/i.test(r.import_key)) {
            const nextKey = replaceZbText(r.import_key);
            if (nextKey !== r.import_key && !chkImportKey.get(nextKey, r.id)) {
              updImportKey.run(nextKey, r.id);
            }
          }
        }
      }
    }

    // 4. Merge fuel_meter_readings
    if (tableExists(targetDb, 'fuel_meter_readings')) {
      const conds = ["UPPER(COALESCE(asset_code, '')) LIKE '%ZB%0050%'"];
      if (sourceIds.length) conds.unshift(`asset_id IN (${placeholders})`);
      targetDb.prepare(
        `UPDATE fuel_meter_readings
            SET asset_id = ?, asset_code = ?
          WHERE (${conds.join(' OR ')})
            AND (asset_id IS NOT ? OR COALESCE(asset_code, '') != ?)`
      ).run(...sourceIds, targetId, targetCode, targetId, targetCode);
    }

    // 5. Merge fleet_rental_rates (keep TM-21's canonical rate card if it exists)
    if (sourceIds.length && tableExists(targetDb, 'fleet_rental_rates')) {
      const targetHasRate = targetDb.prepare(
        'SELECT 1 FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1'
      ).get(targetId);
      if (targetHasRate) {
        targetDb.prepare(`DELETE FROM fleet_rental_rates WHERE asset_id IN (${placeholders})`).run(...sourceIds);
      } else {
        const keep = targetDb.prepare(
          `SELECT id FROM fleet_rental_rates WHERE asset_id IN (${placeholders}) ORDER BY updated_at DESC, id ASC LIMIT 1`
        ).get(...sourceIds);
        if (keep) {
          targetDb.prepare('UPDATE fleet_rental_rates SET asset_id = ? WHERE id = ?').run(targetId, keep.id);
        }
        targetDb.prepare(`DELETE FROM fleet_rental_rates WHERE asset_id IN (${placeholders})`).run(...sourceIds);
      }
    }

    // 6. Merge fleet_vehicle_allocations
    if (sourceIds.length && tableExists(targetDb, 'fleet_vehicle_allocations')) {
      const allocCols = getColSet(targetDb, 'fleet_vehicle_allocations');
      if (allocCols.has('origin')) {
        targetDb.prepare(
          `DELETE FROM fleet_vehicle_allocations WHERE asset_id IN (${placeholders}) AND origin = 'AUTO_FUEL'`
        ).run(...sourceIds);
      }
      const remAllocs = targetDb.prepare(
        `SELECT id, dedupe_key FROM fleet_vehicle_allocations WHERE asset_id IN (${placeholders})`
      ).all(...sourceIds);
      const chkDedupe = targetDb.prepare('SELECT 1 FROM fleet_vehicle_allocations WHERE dedupe_key = ? AND id != ? LIMIT 1');
      for (const a of remAllocs) {
        let nextKey = a.dedupe_key;
        if (nextKey && /ZB[-\s]?0050/i.test(nextKey)) {
          const cand = replaceZbText(nextKey);
          if (!chkDedupe.get(cand, a.id)) nextKey = cand;
        }
        targetDb.prepare(
          `UPDATE fleet_vehicle_allocations SET asset_id = ?, vehicle_no = ?, dedupe_key = ? WHERE id = ?`
        ).run(targetId, targetCode, nextKey, a.id);
      }
    }

    // 7. Merge fleet_asset_assignments
    if (sourceIds.length && tableExists(targetDb, 'fleet_asset_assignments')) {
      targetDb.prepare(
        `DELETE FROM fleet_asset_assignments
          WHERE asset_id IN (${placeholders}) AND id LIKE 'fa-fuel-%' AND start_date >= '2026-08-01'`
      ).run(...sourceIds);
      targetDb.prepare(
        `UPDATE fleet_asset_assignments SET asset_id = ?, asset_code = ? WHERE asset_id IN (${placeholders})`
      ).run(targetId, targetCode, ...sourceIds);
    }

    // 8. Merge fleet_bills & fleet_financial_events
    if (tableExists(targetDb, 'fleet_bills')) {
      const fbConds = ["UPPER(COALESCE(asset_code, '')) LIKE '%ZB%0050%'"];
      if (sourceIds.length) fbConds.unshift(`asset_id IN (${placeholders})`);
      const fbRows = targetDb.prepare(
        `SELECT id, asset_reg_no, asset_label FROM fleet_bills WHERE ${fbConds.join(' OR ')}`
      ).all(...sourceIds);
      const updFb = targetDb.prepare(
        'UPDATE fleet_bills SET asset_id = ?, asset_code = ?, asset_reg_no = ?, asset_label = ? WHERE id = ?'
      );
      for (const r of fbRows) {
        const reg = r.asset_reg_no ? replaceZbText(r.asset_reg_no) : 'ZA-0050';
        const lbl = r.asset_label ? replaceZbText(r.asset_label) : r.asset_label;
        updFb.run(targetId, targetCode, reg, lbl, r.id);
      }
    }

    if (tableExists(targetDb, 'fleet_financial_events')) {
      const feConds = ["UPPER(COALESCE(asset_code, '')) LIKE '%ZB%0050%'"];
      if (sourceIds.length) feConds.unshift(`asset_id IN (${placeholders})`);
      targetDb.prepare(
        `UPDATE fleet_financial_events SET asset_id = ?, asset_code = ? WHERE ${feConds.join(' OR ')}`
      ).run(targetId, targetCode, ...sourceIds);
    }

    // 9. Handle UNIQUE(asset_id, category) on vehicle_filter_schedules
    if (sourceIds.length && tableExists(targetDb, 'vehicle_filter_schedules')) {
      const srcScheds = targetDb.prepare(
        `SELECT id, category FROM vehicle_filter_schedules WHERE asset_id IN (${placeholders})`
      ).all(...sourceIds);
      const hasCatStmt = targetDb.prepare(
        'SELECT 1 FROM vehicle_filter_schedules WHERE asset_id = ? AND category = ? LIMIT 1'
      );
      const delSched = targetDb.prepare('DELETE FROM vehicle_filter_schedules WHERE id = ?');
      const moveSched = targetDb.prepare('UPDATE vehicle_filter_schedules SET asset_id = ? WHERE id = ?');
      for (const s of srcScheds) {
        if (hasCatStmt.get(targetId, s.category)) {
          delSched.run(s.id);
        } else {
          moveSched.run(targetId, s.id);
        }
      }
    }

    // 10. Handle UNIQUE(asset_id, year, month) on vehicle_monthly_costs by summing costs cleanly
    if (sourceIds.length && tableExists(targetDb, 'vehicle_monthly_costs')) {
      const srcCosts = targetDb.prepare(
        `SELECT * FROM vehicle_monthly_costs WHERE asset_id IN (${placeholders}) ORDER BY year, month, id`
      ).all(...sourceIds);
      const findTargetCost = targetDb.prepare(
        'SELECT * FROM vehicle_monthly_costs WHERE asset_id = ? AND year = ? AND month = ? LIMIT 1'
      );
      const sumTargetCost = targetDb.prepare(`
        UPDATE vehicle_monthly_costs
           SET fuel_cost = COALESCE(fuel_cost, 0) + ?,
               oil_cost = COALESCE(oil_cost, 0) + ?,
               filter_cost = COALESCE(filter_cost, 0) + ?,
               battery_cost = COALESCE(battery_cost, 0) + ?,
               parts_cost = COALESCE(parts_cost, 0) + ?,
               labour_cost = COALESCE(labour_cost, 0) + ?,
               total_cost = COALESCE(total_cost, 0) + ?,
               updated_at = datetime('now')
         WHERE id = ?
      `);
      const delSrcCost = targetDb.prepare('DELETE FROM vehicle_monthly_costs WHERE id = ?');
      const moveSrcCost = targetDb.prepare('UPDATE vehicle_monthly_costs SET asset_id = ? WHERE id = ?');

      for (const c of srcCosts) {
        const existing = findTargetCost.get(targetId, c.year, c.month);
        if (existing) {
          sumTargetCost.run(
            c.fuel_cost || 0, c.oil_cost || 0, c.filter_cost || 0,
            c.battery_cost || 0, c.parts_cost || 0, c.labour_cost || 0,
            c.total_cost || 0, existing.id
          );
          delSrcCost.run(c.id);
        } else {
          moveSrcCost.run(targetId, c.id);
        }
        monthlyCostsMerged++;
      }
    }

    // 11. Repoint workshop / stores / tyres / filter ledger asset_id references
    if (sourceIds.length) {
      for (const tbl of [
        'job_cards', 'job_requests', 'mrn', 'service_jobs',
        'stock_moves', 'tyre_battery_issues', 'filter_stock_ledger',
        'vehicle_documents', 'vehicle_lubricant_capacities', 'issues', 'min_notes',
      ]) {
        if (!tableExists(targetDb, tbl)) continue;
        const cols = getColSet(targetDb, tbl);
        if (cols.has('asset_id')) {
          targetDb.prepare(`UPDATE "${tbl}" SET asset_id = ? WHERE asset_id IN (${placeholders})`).run(targetId, ...sourceIds);
        }
      }

      // Generic FK sweep across every table referencing assets(id) so DELETE cannot hit FK failure
      const allTables = targetDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all().map((r) => r.name);
      for (const tbl of allTables) {
        if (tbl === 'assets' || tbl === 'asset_aliases') continue;
        const fks = targetDb.prepare(`PRAGMA foreign_key_list("${tbl}")`).all().filter((f) => f.table === 'assets' && f.to === 'id');
        for (const fk of fks) {
          targetDb.prepare(`UPDATE "${tbl}" SET "${fk.from}" = ? WHERE "${fk.from}" IN (${placeholders})`).run(targetId, ...sourceIds);
        }
      }

      // Preserve home_project_id / current_project_id / registration on target
      const primarySrc = sources.find((s) => Number(s.id) === 488 || String(s.code_norm).toUpperCase() === 'ZB0050') || sources[0];
      if (primarySrc) {
        targetDb.prepare(`
          UPDATE assets
             SET home_project_id = COALESCE(home_project_id, ?),
                 current_project_id = COALESCE(?, current_project_id),
                 registration = COALESCE(NULLIF(TRIM(registration), ''), 'ZA-0050'),
                 updated_at = datetime('now')
           WHERE id = ?
        `).run(primarySrc.home_project_id || null, primarySrc.current_project_id || null, targetId);
      }

      // Remove source asset_aliases pointers & delete duplicate source asset rows
      if (tableExists(targetDb, 'asset_aliases')) {
        targetDb.prepare(`UPDATE asset_aliases SET asset_id = ? WHERE asset_id IN (${placeholders})`).run(targetId, ...sourceIds);
      }
      targetDb.prepare(`DELETE FROM assets WHERE id IN (${placeholders})`).run(...sourceIds);
    }

    // 12. Global text cleanup across all rows (including existing records already linked to id=47)
    for (const [tbl, col] of [
      ['service_jobs', 'vehicle_label'],
      ['job_cards', 'description'],
      ['job_requests', 'description'],
      ['stock_moves', 'ref'],
      ['stock_moves', 'note'],
      ['tyre_battery_issues', 'vehicle'],
      ['filter_stock_ledger', 'note'],
      ['filter_catalogue', 'top_vehicle'],
      ['filter_stock', 'compatible_assets'],
      ['daily_report_snapshots', 'payload'],
    ]) {
      const cnt = replaceZbInTableColumn(targetDb, tbl, col);
      if (tbl === 'daily_report_snapshots') snapshotsUpdated += cnt;
      else textRowsUpdated += cnt;
    }

    // 13. Seed/update learning aliases for ZA0050 and ZB0050 -> target.id
    if (tableExists(targetDb, 'asset_aliases')) {
      const upsertAlias = targetDb.prepare(`
        INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source, created_at, updated_at)
        VALUES (?, ?, ?, 1, 1, 'migration_069', datetime('now'), datetime('now'))
        ON CONFLICT(raw_norm) DO UPDATE SET
          asset_id = excluded.asset_id,
          resolved = 1,
          updated_at = datetime('now')
      `);
      upsertAlias.run('ZA-0050', 'ZA0050', targetId);
      upsertAlias.run('ZB-0050', 'ZB0050', targetId);
    }
  })();

  return {
    targetId,
    targetCode,
    mergedAssetIds,
    fuelIssuesUpdated,
    textRowsUpdated,
    monthlyCostsMerged,
    snapshotsUpdated,
  };
}

module.exports = { runMigration, replaceZbText };
