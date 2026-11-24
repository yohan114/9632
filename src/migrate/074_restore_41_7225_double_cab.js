'use strict';

/**
 * Migration 074: Restore 41-7225 as E&C Owned Double Cab with Standard Rate Card
 *
 * Restores 41-7225 (`ownership = 'OWNED'`, `in_register = 1`, `type = 'Double Cab'`),
 * merges duplicate `41-7225 Crew Cab` into `41-7225` with an alias so all workshop
 * job cards and MRN/stock history consolidate cleanly, upserts the standard
 * `Double Cab (Pickup)` rate card (`Rs 45/70/110 per km`, `0.1 L/km` = `10 km/L`),
 * and restores its allocations, assignments, and preserved `fuel_issues` (`is_direct_billed = 0`)
 * across all months.
 */

const DOUBLE_CAB_RATE = Object.freeze({
  category_name: 'Double Cab (Pickup)',
  rate_basis: 'KM',
  equip_type: 'FLEET',
  default_basis: 'WET',
  rate_cents: 4500,
  dry_rate_cents: 4500,
  wet_rate_cents: 7000,
  fully_wet_rate_cents: 11000,
  km_dry_cents: 4500,
  km_wet_cents: 7000,
  km_fw_cents: 11000,
  hr_dry_cents: 87000,
  hr_wet_cents: 161000,
  hr_fw_cents: 161000,
  dy_dry_cents: 330000,
  dy_wet_cents: 610000,
  dy_fw_cents: 610000,
  min_bill_hours: 0,
  fuel_cons_basis: 'km',
  fuel_cons_typ: 0.1,
  fuel_cons_econ: 0.078125,
  note: 'Standard Double Cab (Pickup) rate card (Migration 074)',
  source_label: 'Standard Double Cab (Pickup) rate (Rs 45/70/110 per km)',
});

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
}

function stripOutsideNote(raw) {
  const s = String(raw || '');
  if (!s.includes('outside-billed')) {
    return s.trim() === '' ? null : raw;
  }
  const cleaned = s
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p && !p.includes('outside-billed'))
    .join(' | ');
  return cleaned || null;
}

function valuesDiffer(curVal, nextVal) {
  if (typeof nextVal === 'number') {
    if (curVal == null) return true;
    return Math.abs(Number(curVal) - nextVal) > 1e-9;
  }
  return String(curVal == null ? '' : curVal) !== String(nextVal == null ? '' : nextVal);
}

function runMigration(targetDb) {
  if (!targetDb || !tableExists(targetDb, 'assets')) {
    return { skipped: true };
  }

  const canonical = targetDb.prepare("SELECT * FROM assets WHERE UPPER(TRIM(code)) = '41-7225' LIMIT 1").get();
  if (!canonical) {
    return { skipped: true };
  }

  const stats = {
    assetRestored: 0,
    crewCabMerged: false,
    rateUpserted: 0,
    fuelIssuesRestored: 0,
    allocsRestored: 0,
    assignmentsRestored: 0,
  };

  targetDb.transaction(() => {
    const assetCols = getColSet(targetDb, 'assets');
    if (!assetCols.has('ownership')) {
      targetDb.exec("ALTER TABLE assets ADD COLUMN ownership TEXT NOT NULL DEFAULT 'OWNED'");
      assetCols.add('ownership');
    }
    targetDb.exec('CREATE INDEX IF NOT EXISTS idx_assets_ownership ON assets(ownership)');

    const hasMeterCol = assetCols.has('meter_type');
    const nextNotes = stripOutsideNote(canonical.notes);
    const nextReg = (canonical.registration && String(canonical.registration).trim()) || '41-7225';

    const needsAssetUpdate =
      String(canonical.ownership || '').toUpperCase() !== 'OWNED' ||
      Number(canonical.in_register || 0) !== 1 ||
      canonical.type !== 'Double Cab' ||
      canonical.registration !== nextReg ||
      (hasMeterCol && canonical.meter_type !== 'KM') ||
      (canonical.notes || null) !== nextNotes;

    if (needsAssetUpdate) {
      if (hasMeterCol) {
        targetDb.prepare(`
          UPDATE assets
             SET ownership = 'OWNED',
                 in_register = 1,
                 type = 'Double Cab',
                 registration = ?,
                 meter_type = 'KM',
                 notes = ?,
                 updated_at = datetime('now')
           WHERE id = ?
        `).run(nextReg, nextNotes, canonical.id);
      } else {
        targetDb.prepare(`
          UPDATE assets
             SET ownership = 'OWNED',
                 in_register = 1,
                 type = 'Double Cab',
                 registration = ?,
                 notes = ?,
                 updated_at = datetime('now')
           WHERE id = ?
        `).run(nextReg, nextNotes, canonical.id);
      }
      stats.assetRestored = 1;
    }

    // Merge duplicate `41-7225 Crew Cab` into canonical `41-7225`
    const dup = targetDb.prepare(
      "SELECT * FROM assets WHERE UPPER(TRIM(code)) = '41-7225 CREW CAB' AND id != ? LIMIT 1"
    ).get(canonical.id);

    if (dup) {
      if (tableExists(targetDb, 'fuel_issues')) {
        const fiCols = getColSet(targetDb, 'fuel_issues');
        const sets = ['asset_id = ?', 'asset_code = ?', 'vehicle_ref = ?'];
        const params = [canonical.id, canonical.code, nextReg];
        if (fiCols.has('is_direct_billed')) sets.push('is_direct_billed = 0');
        if (fiCols.has('updated_at')) sets.push("updated_at = datetime('now')");
        targetDb.prepare(`UPDATE fuel_issues SET ${sets.join(', ')} WHERE asset_id = ?`).run(...params, dup.id);
      }

      if (tableExists(targetDb, 'fuel_meter_readings')) {
        const fmrCols = getColSet(targetDb, 'fuel_meter_readings');
        if (fmrCols.has('asset_id')) {
          if (fmrCols.has('asset_code')) {
            targetDb.prepare('UPDATE fuel_meter_readings SET asset_id = ?, asset_code = ? WHERE asset_id = ?').run(canonical.id, canonical.code, dup.id);
          } else {
            targetDb.prepare('UPDATE fuel_meter_readings SET asset_id = ? WHERE asset_id = ?').run(canonical.id, dup.id);
          }
        }
      }

      if (tableExists(targetDb, 'vehicle_monthly_costs')) {
        const srcCosts = targetDb.prepare('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ? ORDER BY year, month, id').all(dup.id);
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
          const existing = findTargetCost.get(canonical.id, c.year, c.month);
          if (existing) {
            sumTargetCost.run(
              c.fuel_cost || 0, c.oil_cost || 0, c.filter_cost || 0,
              c.battery_cost || 0, c.parts_cost || 0, c.labour_cost || 0,
              c.total_cost || 0, existing.id
            );
            delSrcCost.run(c.id);
          } else {
            moveSrcCost.run(canonical.id, c.id);
          }
        }
      }

      if (tableExists(targetDb, 'vehicle_filter_schedules')) {
        const srcScheds = targetDb.prepare('SELECT id, category FROM vehicle_filter_schedules WHERE asset_id = ?').all(dup.id);
        const hasCat = targetDb.prepare('SELECT 1 FROM vehicle_filter_schedules WHERE asset_id = ? AND category = ? LIMIT 1');
        const delSched = targetDb.prepare('DELETE FROM vehicle_filter_schedules WHERE id = ?');
        const moveSched = targetDb.prepare('UPDATE vehicle_filter_schedules SET asset_id = ? WHERE id = ?');
        for (const s of srcScheds) {
          if (hasCat.get(canonical.id, s.category)) delSched.run(s.id);
          else moveSched.run(canonical.id, s.id);
        }
      }

      if (tableExists(targetDb, 'fleet_vehicle_allocations')) {
        const allocCols = getColSet(targetDb, 'fleet_vehicle_allocations');
        if (allocCols.has('origin')) {
          targetDb.prepare("DELETE FROM fleet_vehicle_allocations WHERE asset_id = ? AND origin = 'AUTO_FUEL'").run(dup.id);
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
        `).run(dup.id, canonical.id);
        targetDb.prepare('UPDATE fleet_vehicle_allocations SET asset_id = ?, vehicle_no = ? WHERE asset_id = ?').run(canonical.id, canonical.code, dup.id);
      }

      if (tableExists(targetDb, 'fleet_asset_assignments')) {
        const asgCols = getColSet(targetDb, 'fleet_asset_assignments');
        if (asgCols.has('origin')) {
          targetDb.prepare("DELETE FROM fleet_asset_assignments WHERE asset_id = ? AND (id LIKE 'fa-fuel-%' OR origin = 'FUEL')").run(dup.id);
        } else {
          targetDb.prepare("DELETE FROM fleet_asset_assignments WHERE asset_id = ? AND id LIKE 'fa-fuel-%'").run(dup.id);
        }
        targetDb.prepare('UPDATE fleet_asset_assignments SET asset_id = ?, asset_code = ? WHERE asset_id = ?').run(canonical.id, canonical.code, dup.id);
      }

      if (tableExists(targetDb, 'fleet_rental_rates')) {
        targetDb.prepare('DELETE FROM fleet_rental_rates WHERE asset_id = ?').run(dup.id);
      }

      const allTables = targetDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all().map((r) => r.name);
      for (const tbl of allTables) {
        if (tbl === 'assets' || tbl === 'asset_aliases') continue;
        const fks = targetDb.prepare(`PRAGMA foreign_key_list("${tbl}")`).all().filter((f) => f.table === 'assets' && f.to === 'id');
        for (const fk of fks) {
          targetDb.prepare(`UPDATE "${tbl}" SET "${fk.from}" = ? WHERE "${fk.from}" = ?`).run(canonical.id, dup.id);
        }
      }

      if (tableExists(targetDb, 'asset_aliases')) {
        targetDb.prepare('UPDATE asset_aliases SET asset_id = ? WHERE asset_id = ?').run(canonical.id, dup.id);
        targetDb.prepare(`
          INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source, created_at, updated_at)
          VALUES ('41-7225 Crew Cab', '417225CREWCAB', ?, 1, 1, 'migration_074', datetime('now'), datetime('now'))
          ON CONFLICT(raw_norm) DO UPDATE SET
            asset_id = excluded.asset_id,
            resolved = 1,
            updated_at = datetime('now')
        `).run(canonical.id);
      }

      targetDb.prepare('DELETE FROM assets WHERE id = ?').run(dup.id);
      stats.crewCabMerged = true;
    }

    // Upsert standard Double Cab (Pickup) rate card on canonical 41-7225
    if (tableExists(targetDb, 'fleet_rental_rates')) {
      const rateCols = getColSet(targetDb, 'fleet_rental_rates');
      const existingRate = targetDb.prepare('SELECT * FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1').get(canonical.id);
      const specEntries = Object.entries(DOUBLE_CAB_RATE).filter(([k]) => rateCols.has(k));

      if (!existingRate) {
        const cols = ['id', 'asset_id', ...specEntries.map(([k]) => k)];
        const vals = ['rc-417225-double-cab', canonical.id, ...specEntries.map(([, v]) => v)];
        if (rateCols.has('created_at')) { cols.push('created_at'); vals.push(targetDb.prepare("SELECT datetime('now') AS d").get().d); }
        if (rateCols.has('updated_at')) { cols.push('updated_at'); vals.push(targetDb.prepare("SELECT datetime('now') AS d").get().d); }
        const ph = cols.map(() => '?').join(', ');
        targetDb.prepare(`INSERT INTO fleet_rental_rates (${cols.join(', ')}) VALUES (${ph})`).run(...vals);
        stats.rateUpserted = 1;
      } else {
        const changed = specEntries.some(([k, v]) => valuesDiffer(existingRate[k], v));
        if (changed) {
          const setClauses = specEntries.map(([k]) => `${k} = ?`);
          const vals = specEntries.map(([, v]) => v);
          if (rateCols.has('updated_at')) setClauses.push("updated_at = datetime('now')");
          targetDb.prepare(`UPDATE fleet_rental_rates SET ${setClauses.join(', ')} WHERE id = ?`).run(...vals, existingRate.id);
          stats.rateUpserted = 1;
        }
      }
    }

    // Restore fuel issues, allocations & assignments across all months
    if (tableExists(targetDb, 'fuel_issues')) {
      const fiCols = getColSet(targetDb, 'fuel_issues');
      if (fiCols.has('is_direct_billed')) {
        const info = targetDb.prepare(
          'UPDATE fuel_issues SET is_direct_billed = 0 WHERE asset_id = ? AND COALESCE(is_direct_billed, 0) != 0'
        ).run(canonical.id);
        stats.fuelIssuesRestored = info.changes || 0;
      }
    }

    if (tableExists(targetDb, 'fleet_vehicle_allocations')) {
      const info = targetDb.prepare(`
        UPDATE fleet_vehicle_allocations
           SET owner_code = 'E&C',
               basis = 'WET',
               updated_at = datetime('now')
         WHERE asset_id = ?
           AND (COALESCE(owner_code, '') != 'E&C' OR COALESCE(basis, '') = 'BILLED_DIRECT')
      `).run(canonical.id);
      stats.allocsRestored = info.changes || 0;
    }

    if (tableExists(targetDb, 'fleet_asset_assignments')) {
      const info = targetDb.prepare(`
        UPDATE fleet_asset_assignments
           SET billing_type = 'WET',
               updated_at = datetime('now')
         WHERE asset_id = ?
           AND COALESCE(billing_type, '') = 'BILLED_DIRECT'
      `).run(canonical.id);
      stats.assignmentsRestored = info.changes || 0;
    }
  })();

  return stats;
}

module.exports = { runMigration, DOUBLE_CAB_RATE };
