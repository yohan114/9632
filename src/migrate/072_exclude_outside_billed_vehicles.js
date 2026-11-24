'use strict';

/**
 * Migration 072: Exclude External / Outside-Billed Vehicles & Subcontractors
 * (325-1030, ELS SUBCONTRACTOR, GD-7104, PE-3723, RG-5415, S&S SOLUTION)
 *
 * Marks these external/subcontractor assets with `ownership = 'HIRED'` and `in_register = 0`,
 * updates their allocations/assignments to `HIRED` / `BILLED_DIRECT`, flags their `fuel_issues`
 * with `is_direct_billed = 1` (while preserving physical fuel_issues rows for tank/pump stock
 * reconciliation), removes E&C rate cards, voids any non-void E&C bills, and deletes bogus
 * `REVENUE_RENTAL` / `REVENUE_FUEL` ledger entries.
 */

const OUTSIDE_BILLED_SPECS = [
  { code: '325-1030', type: 'External Vehicle (hired / billed outside)', meterType: 'KM' },
  { code: 'ELS SUBCONTRACTOR', type: 'Subcontractor (billed outside)', meterType: 'KM' },
  { code: 'GD-7104', type: 'Hired Vehicle (billed outside)', meterType: 'KM' },
  { code: 'PE-3723', type: 'External Vehicle (hired / billed outside)', meterType: 'HOURS' },
  { code: 'RG-5415', type: 'Tractor (hired / billed outside)', meterType: 'HOURS' },
  { code: 'S&S SOLUTION', type: 'External Contractor (billed outside)', meterType: 'KM' },
];

const OUTSIDE_NOTE = 'Ownership: HIRED — external / outside-billed (rental & fuel paid outside, excluded from site bill)';

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
}

function runMigration(targetDb) {
  if (!targetDb || !tableExists(targetDb, 'assets')) {
    return { skipped: true };
  }

  let ownershipColAdded = false;
  let assetsUpdated = 0;
  let ratesRemoved = 0;
  let allocsUpdated = 0;
  let assignmentsUpdated = 0;
  let fuelIssuesFlagged = 0;
  let billsVoided = 0;
  let revEventsRemoved = 0;

  targetDb.transaction(() => {
    const assetCols = getColSet(targetDb, 'assets');
    if (!assetCols.has('ownership')) {
      targetDb.exec("ALTER TABLE assets ADD COLUMN ownership TEXT NOT NULL DEFAULT 'OWNED'");
      ownershipColAdded = true;
    }
    targetDb.exec('CREATE INDEX IF NOT EXISTS idx_assets_ownership ON assets(ownership)');

    const hasMeterCol = assetCols.has('meter_type');
    const targetIds = new Set();

    for (const spec of OUTSIDE_BILLED_SPECS) {
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
        assetsUpdated++;
      }
    }

    const idList = [...targetIds];
    if (idList.length > 0) {
      const ph = idList.map(() => '?').join(',');

      if (tableExists(targetDb, 'fleet_rental_rates')) {
        const info = targetDb.prepare(`DELETE FROM fleet_rental_rates WHERE asset_id IN (${ph})`).run(...idList);
        ratesRemoved = info.changes || 0;
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
        allocsUpdated = info.changes || 0;
      }

      if (tableExists(targetDb, 'fleet_asset_assignments')) {
        const info = targetDb.prepare(`
          UPDATE fleet_asset_assignments
             SET billing_type = 'BILLED_DIRECT',
                 updated_at = datetime('now')
           WHERE asset_id IN (${ph})
             AND COALESCE(billing_type, '') != 'BILLED_DIRECT'
        `).run(...idList);
        assignmentsUpdated = info.changes || 0;
      }

      const fiCols = getColSet(targetDb, 'fuel_issues');
      if (fiCols.has('is_direct_billed')) {
        const info = targetDb.prepare(`
          UPDATE fuel_issues
             SET is_direct_billed = 1
           WHERE asset_id IN (${ph})
             AND COALESCE(is_direct_billed, 0) != 1
        `).run(...idList);
        fuelIssuesFlagged = info.changes || 0;
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
        billsVoided = info.changes || 0;
      }

      if (tableExists(targetDb, 'fleet_financial_events')) {
        const info = targetDb.prepare(`
          DELETE FROM fleet_financial_events
           WHERE asset_id IN (${ph})
             AND event_type IN ('REVENUE_RENTAL', 'REVENUE_FUEL')
        `).run(...idList);
        revEventsRemoved = info.changes || 0;
      }
    }
  })();

  return {
    ownershipColAdded,
    assetsUpdated,
    ratesRemoved,
    allocsUpdated,
    assignmentsUpdated,
    fuelIssuesFlagged,
    billsVoided,
    revEventsRemoved,
  };
}

module.exports = { runMigration, OUTSIDE_BILLED_SPECS };
