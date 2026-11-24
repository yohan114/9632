'use strict';

/**
 * Migration 073: Exclude Old-Month External / Outside-Billed Vehicles,
 * Merge Typo Duplicates & Clean Transfer/Error Allocations
 *
 * 1. Safely merges typo duplicates into their canonical records + seeds aliases:
 *      - DHI-9770 -> DAI-9770 (Single Cab)
 *      - RG-9415  -> RG-5415  (External tractor, already HIRED)
 * 2. Marks the 10 historical external / outside-billed / subcontractor assets with
 *    `ownership = 'HIRED'` and `in_register = 0`, sets allocations/assignments to
 *    `HIRED` / `BILLED_DIRECT`, flags preserved `fuel_issues` as `is_direct_billed = 1`
 *    (keeping physical rows for tank stock reconciliation & keeping job_cards/spares intact),
 *    removes rate cards, voids any non-void E&C bills across all months, and removes
 *    bogus `REVENUE_RENTAL` / `REVENUE_FUEL` ledger events.
 * 3. Removes stale `AUTO_FUEL` / `fa-fuel-%` allocations for non-machine transfer and
 *    error-correction codes matched by `NON_MACHINE_CODE_RE`.
 */

const NON_MACHINE_CODE_RE = /^(TRANSFER|CORRECTION|LABORATORY|LAB|PUMP[-_ ]?ADJ|STOCK[-_ ]?ADJ)[-_ ]|^SITE[-_]|^(OTH-CEP03E|DATABASE CHANGING ERROR|ERROR CORRECTION|FIRE DRILL|GENERAL\s*\/\s*CLEANING)$/i;

const TYPO_MERGES = [
  { sourceCode: 'DHI-9770', targetCode: 'DAI-9770', aliasRaw: 'DHI-9770', aliasNorm: 'DHI9770' },
  { sourceCode: 'RG-9415', targetCode: 'RG-5415', aliasRaw: 'RG-9415', aliasNorm: 'RG9415' },
];

const OUTSIDE_BILLED_OLD_MONTH_SPECS = [
  { code: '251-7719', type: 'External Vehicle (hired / billed outside)', meterType: 'KM' },
  { code: 'DAB-5905', type: 'External Vehicle (hired / billed outside)', meterType: 'KM' },
  { code: 'DAG-4969', type: 'External Vehicle (hired / billed outside)', meterType: 'KM' },
  { code: 'NVM-CONSTRUCTION', type: 'Blasting Subcontractor (billed outside)', meterType: 'HOURS' },
  { code: 'PC-1094', type: 'External Vehicle (hired / billed outside)', meterType: 'KM' },
  { code: 'PC-1203', type: 'External Vehicle (hired / billed outside)', meterType: 'KM' },
  { code: 'LH Piyasena Piling', type: 'Subcontractor (billed outside)', meterType: 'HOURS' },
  { code: 'OTH-KB', type: 'Crane (Sub, Lanka Pile — billed outside)', meterType: 'HOURS' },
  { code: 'Sub Damith', type: 'Subcontractor (billed outside)', meterType: 'KM' },
  { code: 'CHANDANA SUBCONTRACTOR', type: 'Subcontractor (billed outside)', meterType: 'KM' },
];

const OUTSIDE_NOTE = 'Ownership: HIRED — external / outside-billed (rental & fuel paid outside, excluded from site bill)';

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
}

function mergeOneTypoAsset(targetDb, spec, stats) {
  const source = targetDb.prepare('SELECT * FROM assets WHERE UPPER(TRIM(code)) = UPPER(?) LIMIT 1').get(spec.sourceCode);
  const target = targetDb.prepare('SELECT * FROM assets WHERE UPPER(TRIM(code)) = UPPER(?) LIMIT 1').get(spec.targetCode);
  if (!source || !target || source.id === target.id) return;

  const targetRef = (target.registration && String(target.registration).trim()) || target.code;
  const targetIsHired = String(target.ownership || '').trim().toUpperCase() === 'HIRED';

  // 1. Move fuel_issues
  if (tableExists(targetDb, 'fuel_issues')) {
    const fiCols = getColSet(targetDb, 'fuel_issues');
    const sets = ['asset_id = ?', 'asset_code = ?', 'vehicle_ref = ?'];
    const params = [target.id, target.code, targetRef];
    if (targetIsHired && fiCols.has('is_direct_billed')) {
      sets.push('is_direct_billed = 1');
    }
    if (fiCols.has('updated_at')) {
      sets.push("updated_at = datetime('now')");
    }
    const info = targetDb.prepare(`UPDATE fuel_issues SET ${sets.join(', ')} WHERE asset_id = ?`).run(...params, source.id);
    stats.fuelIssuesMerged += info.changes || 0;
  }

  // 2. Move fuel_meter_readings
  if (tableExists(targetDb, 'fuel_meter_readings')) {
    const fmrCols = getColSet(targetDb, 'fuel_meter_readings');
    if (fmrCols.has('asset_id')) {
      if (fmrCols.has('asset_code')) {
        targetDb.prepare('UPDATE fuel_meter_readings SET asset_id = ?, asset_code = ? WHERE asset_id = ?').run(target.id, target.code, source.id);
      } else {
        targetDb.prepare('UPDATE fuel_meter_readings SET asset_id = ? WHERE asset_id = ?').run(target.id, source.id);
      }
    }
  }

  // 3. Merge vehicle_monthly_costs cleanly respecting UNIQUE(asset_id, year, month)
  if (tableExists(targetDb, 'vehicle_monthly_costs')) {
    const srcCosts = targetDb.prepare('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ? ORDER BY year, month, id').all(source.id);
    const findTargetCost = targetDb.prepare('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ? AND year = ? AND month = ? LIMIT 1');
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
      const existing = findTargetCost.get(target.id, c.year, c.month);
      if (existing) {
        sumTargetCost.run(
          c.fuel_cost || 0, c.oil_cost || 0, c.filter_cost || 0,
          c.battery_cost || 0, c.parts_cost || 0, c.labour_cost || 0,
          c.total_cost || 0, existing.id
        );
        delSrcCost.run(c.id);
      } else {
        moveSrcCost.run(target.id, c.id);
      }
      stats.monthlyCostsMerged++;
    }
  }

  // 4. Clean/re-point fleet_vehicle_allocations
  if (tableExists(targetDb, 'fleet_vehicle_allocations')) {
    const allocCols = getColSet(targetDb, 'fleet_vehicle_allocations');
    if (allocCols.has('origin')) {
      targetDb.prepare("DELETE FROM fleet_vehicle_allocations WHERE asset_id = ? AND origin = 'AUTO_FUEL'").run(source.id);
    }
    targetDb.prepare(`
      DELETE FROM fleet_vehicle_allocations
       WHERE asset_id = ?
         AND EXISTS (
           SELECT 1 FROM fleet_vehicle_allocations t
            WHERE t.asset_id = ?
              AND COALESCE(t.month, '') = COALESCE(fleet_vehicle_allocations.month, '')
              AND COALESCE(t.project_id, 0) = COALESCE(fleet_vehicle_allocations.project_id, 0)
         )
    `).run(source.id, target.id);
    const remAllocs = targetDb.prepare('SELECT id FROM fleet_vehicle_allocations WHERE asset_id = ?').all(source.id);
    for (const a of remAllocs) {
      targetDb.prepare('UPDATE fleet_vehicle_allocations SET asset_id = ?, vehicle_no = ? WHERE id = ?').run(target.id, target.code, a.id);
    }
  }

  // 5. Clean/re-point fleet_asset_assignments
  if (tableExists(targetDb, 'fleet_asset_assignments')) {
    const asgCols = getColSet(targetDb, 'fleet_asset_assignments');
    if (asgCols.has('origin')) {
      targetDb.prepare("DELETE FROM fleet_asset_assignments WHERE asset_id = ? AND (id LIKE 'fa-fuel-%' OR origin = 'FUEL')").run(source.id);
    } else {
      targetDb.prepare("DELETE FROM fleet_asset_assignments WHERE asset_id = ? AND id LIKE 'fa-fuel-%'").run(source.id);
    }
    targetDb.prepare('UPDATE fleet_asset_assignments SET asset_id = ?, asset_code = ? WHERE asset_id = ?').run(target.id, target.code, source.id);
  }

  // 6. fleet_rental_rates
  if (tableExists(targetDb, 'fleet_rental_rates')) {
    const targetHasRate = Boolean(targetDb.prepare('SELECT 1 FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1').get(target.id));
    if (targetHasRate) {
      targetDb.prepare('DELETE FROM fleet_rental_rates WHERE asset_id = ?').run(source.id);
    } else {
      targetDb.prepare('UPDATE fleet_rental_rates SET asset_id = ? WHERE asset_id = ?').run(target.id, source.id);
    }
  }

  // 7. vehicle_filter_schedules (UNIQUE(asset_id, category))
  if (tableExists(targetDb, 'vehicle_filter_schedules')) {
    const srcScheds = targetDb.prepare('SELECT id, category FROM vehicle_filter_schedules WHERE asset_id = ?').all(source.id);
    const hasCatStmt = targetDb.prepare('SELECT 1 FROM vehicle_filter_schedules WHERE asset_id = ? AND category = ? LIMIT 1');
    const delSched = targetDb.prepare('DELETE FROM vehicle_filter_schedules WHERE id = ?');
    const moveSched = targetDb.prepare('UPDATE vehicle_filter_schedules SET asset_id = ? WHERE id = ?');
    for (const s of srcScheds) {
      if (hasCatStmt.get(target.id, s.category)) delSched.run(s.id);
      else moveSched.run(target.id, s.id);
    }
  }

  // 8. Generic FK sweep across all tables referencing assets(id)
  const allTables = targetDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((r) => r.name);
  for (const tbl of allTables) {
    if (tbl === 'assets' || tbl === 'asset_aliases') continue;
    const fks = targetDb.prepare(`PRAGMA foreign_key_list("${tbl}")`).all().filter((f) => f.table === 'assets' && f.to === 'id');
    for (const fk of fks) {
      targetDb.prepare(`UPDATE "${tbl}" SET "${fk.from}" = ? WHERE "${fk.from}" = ?`).run(target.id, source.id);
    }
  }

  // 9. Redirect asset_aliases & upsert typo alias -> canonical target.id
  if (tableExists(targetDb, 'asset_aliases')) {
    targetDb.prepare('UPDATE asset_aliases SET asset_id = ? WHERE asset_id = ?').run(target.id, source.id);
    targetDb.prepare(`
      INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 'migration_073', datetime('now'), datetime('now'))
      ON CONFLICT(raw_norm) DO UPDATE SET
        asset_id = excluded.asset_id,
        resolved = 1,
        updated_at = datetime('now')
    `).run(spec.aliasRaw, spec.aliasNorm, target.id);
  }

  // 10. Delete duplicate typo asset row
  targetDb.prepare('DELETE FROM assets WHERE id = ?').run(source.id);
  stats.mergedTypos.push(source.code);
}

function runMigration(targetDb) {
  if (!targetDb || !tableExists(targetDb, 'assets')) {
    return { skipped: true };
  }

  const stats = {
    mergedTypos: [],
    fuelIssuesMerged: 0,
    monthlyCostsMerged: 0,
    assetsUpdated: 0,
    ratesRemoved: 0,
    allocsUpdated: 0,
    assignmentsUpdated: 0,
    fuelIssuesFlagged: 0,
    billsVoided: 0,
    revEventsRemoved: 0,
    nonMachineAllocsRemoved: 0,
    nonMachineAssignsRemoved: 0,
  };

  targetDb.transaction(() => {
    const assetCols = getColSet(targetDb, 'assets');
    if (!assetCols.has('ownership')) {
      targetDb.exec("ALTER TABLE assets ADD COLUMN ownership TEXT NOT NULL DEFAULT 'OWNED'");
    }
    targetDb.exec('CREATE INDEX IF NOT EXISTS idx_assets_ownership ON assets(ownership)');

    // Part A: Merge typo assets (DHI-9770 -> DAI-9770, RG-9415 -> RG-5415)
    for (const spec of TYPO_MERGES) {
      mergeOneTypoAsset(targetDb, spec, stats);
    }

    // Part B: Exclude the 11 external / outside-billed assets across all months
    const hasMeterCol = assetCols.has('meter_type');
    const targetIds = new Set();

    for (const spec of OUTSIDE_BILLED_OLD_MONTH_SPECS) {
      const row = targetDb.prepare('SELECT * FROM assets WHERE UPPER(TRIM(code)) = UPPER(?) LIMIT 1').get(spec.code);
      if (!row) continue;
      targetIds.add(row.id);

      const curNotes = String(row.notes || '').trim();
      const hasOutsideNote = curNotes.includes('outside-billed');
      const nextNotes = hasOutsideNote ? row.notes : (curNotes ? `${OUTSIDE_NOTE} | ${curNotes}` : OUTSIDE_NOTE);

      const needsUpdate =
        String(row.ownership || '').toUpperCase() !== 'HIRED' ||
        Number(row.in_register || 0) !== 0 ||
        row.type !== spec.type ||
        (hasMeterCol && !row.meter_type) ||
        !hasOutsideNote;

      if (needsUpdate) {
        if (hasMeterCol) {
          targetDb.prepare(`
            UPDATE assets
               SET ownership = 'HIRED',
                   in_register = 0,
                   type = ?,
                   meter_type = COALESCE(meter_type, ?),
                   notes = ?,
                   updated_at = datetime('now')
             WHERE id = ?
          `).run(spec.type, spec.meterType, nextNotes, row.id);
        } else {
          targetDb.prepare(`
            UPDATE assets
               SET ownership = 'HIRED',
                   in_register = 0,
                   type = ?,
                   notes = ?,
                   updated_at = datetime('now')
             WHERE id = ?
          `).run(spec.type, nextNotes, row.id);
        }
        stats.assetsUpdated++;
      }
    }

    const idList = [...targetIds];
    if (idList.length > 0) {
      const ph = idList.map(() => '?').join(',');

      if (tableExists(targetDb, 'fleet_rental_rates')) {
        const info = targetDb.prepare(`DELETE FROM fleet_rental_rates WHERE asset_id IN (${ph})`).run(...idList);
        stats.ratesRemoved = info.changes || 0;
      }

      if (tableExists(targetDb, 'fleet_vehicle_allocations')) {
        const info = targetDb.prepare(`
          UPDATE fleet_vehicle_allocations
             SET owner_code = 'HIRED',
                 basis = 'BILLED_DIRECT',
                 updated_at = datetime('now')
           WHERE asset_id IN (${ph})
             AND (COALESCE(owner_code, '') != 'HIRED' OR COALESCE(basis, '') != 'BILLED_DIRECT')
        `).run(...idList);
        stats.allocsUpdated = info.changes || 0;
      }

      if (tableExists(targetDb, 'fleet_asset_assignments')) {
        const info = targetDb.prepare(`
          UPDATE fleet_asset_assignments
             SET billing_type = 'BILLED_DIRECT',
                 updated_at = datetime('now')
           WHERE asset_id IN (${ph})
             AND COALESCE(billing_type, '') != 'BILLED_DIRECT'
        `).run(...idList);
        stats.assignmentsUpdated = info.changes || 0;
      }

      const fiCols = getColSet(targetDb, 'fuel_issues');
      if (fiCols.has('is_direct_billed')) {
        const info = targetDb.prepare(`
          UPDATE fuel_issues
             SET is_direct_billed = 1
           WHERE asset_id IN (${ph})
             AND COALESCE(is_direct_billed, 0) != 1
        `).run(...idList);
        stats.fuelIssuesFlagged = info.changes || 0;
      }

      if (tableExists(targetDb, 'fleet_bills')) {
        const info = targetDb.prepare(`
          UPDATE fleet_bills
             SET status = 'VOID',
                 notes = CASE
                   WHEN COALESCE(notes, '') LIKE '%outside-billed%' THEN notes
                   ELSE TRIM(CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE notes || ' | ' END || 'Voided: external/outside-billed vehicle (rental & fuel settled outside)')
                 END,
                 updated_at = datetime('now')
           WHERE asset_id IN (${ph})
             AND status != 'VOID'
        `).run(...idList);
        stats.billsVoided = info.changes || 0;
      }

      if (tableExists(targetDb, 'fleet_financial_events')) {
        const info = targetDb.prepare(`
          DELETE FROM fleet_financial_events
           WHERE asset_id IN (${ph})
             AND event_type IN ('REVENUE_RENTAL', 'REVENUE_FUEL')
        `).run(...idList);
        stats.revEventsRemoved = info.changes || 0;
      }
    }

    // Part C: Remove stale auto allocations/assignments for non-machine transfer & error entries
    const nonMachineIds = targetDb.prepare('SELECT id, code FROM assets').all()
      .filter((a) => NON_MACHINE_CODE_RE.test(String(a.code || '').trim()))
      .map((a) => a.id);

    if (nonMachineIds.length > 0) {
      const nPh = nonMachineIds.map(() => '?').join(',');
      if (tableExists(targetDb, 'fleet_vehicle_allocations')) {
        const allocCols = getColSet(targetDb, 'fleet_vehicle_allocations');
        if (allocCols.has('origin')) {
          const info = targetDb.prepare(
            `DELETE FROM fleet_vehicle_allocations WHERE asset_id IN (${nPh}) AND origin = 'AUTO_FUEL'`
          ).run(...nonMachineIds);
          stats.nonMachineAllocsRemoved = info.changes || 0;
        }
      }
      if (tableExists(targetDb, 'fleet_asset_assignments')) {
        const asgCols = getColSet(targetDb, 'fleet_asset_assignments');
        const info = asgCols.has('origin')
          ? targetDb.prepare(`DELETE FROM fleet_asset_assignments WHERE asset_id IN (${nPh}) AND (id LIKE 'fa-fuel-%' OR origin = 'FUEL')`).run(...nonMachineIds)
          : targetDb.prepare(`DELETE FROM fleet_asset_assignments WHERE asset_id IN (${nPh}) AND id LIKE 'fa-fuel-%'`).run(...nonMachineIds);
        stats.nonMachineAssignsRemoved = info.changes || 0;
      }
    }
  })();

  return stats;
}

module.exports = {
  runMigration,
  TYPO_MERGES,
  OUTSIDE_BILLED_OLD_MONTH_SPECS,
  NON_MACHINE_CODE_RE,
};
