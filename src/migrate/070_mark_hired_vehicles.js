'use strict';

/**
 * Migration 070: Mark External / Hired Vehicles (D4D-01, D4D-02, D4D-03, LO-4925, SRS-03)
 *
 * Adds `assets.ownership` ('OWNED' | 'HIRED'), marks the external hired assets so they
 * do not appear in the E&C fleet register or E&C rental bills, removes their E&C rate cards,
 * updates allocations/assignments to HIRED / BILLED_DIRECT, voids prior non-void E&C bills,
 * and deletes bogus REVENUE_RENTAL / REVENUE_FUEL ledger entries.
 *
 * Physical fuel_issues are intentionally preserved for tank/pump stock reconciliation.
 */

const HIRED_SPECS = [
  { code: 'D4D-01', type: 'JCB backhoe loader (hired)', meterType: 'HOURS' },
  { code: 'D4D-02', type: 'JCB backhoe loader (hired)', meterType: 'HOURS' },
  { code: 'D4D-03', type: 'JCB backhoe loader (hired)', meterType: 'HOURS' },
  { code: 'LO-4925', type: 'Dump Truck (hired)', meterType: 'KM' },
  { code: 'SRS-03', type: 'Vibrating Roller (hired)', meterType: 'HOURS' },
];

const HIRED_TEXT_RE = /\(hired\)|ownership:\s*hired|\b(billed[_ ]?direct|settled direct)\b/i;

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
  let assetsMarkedHired = 0;
  let ratesRemoved = 0;
  let allocsUpdated = 0;
  let assignmentsUpdated = 0;
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
    const hiredIds = new Set();

    // 1. Mark explicit hired vehicles
    for (const spec of HIRED_SPECS) {
      const row = targetDb.prepare('SELECT * FROM assets WHERE UPPER(TRIM(code)) = UPPER(?) LIMIT 1').get(spec.code);
      if (!row) continue;
      hiredIds.add(row.id);

      const defaultNote = 'Ownership: HIRED — external hired vehicle (not E&C fleet)';
      const needsUpdate =
        String(row.ownership || '').toUpperCase() !== 'HIRED' ||
        Number(row.in_register || 0) !== 0 ||
        row.type !== spec.type ||
        (hasMeterCol && !row.meter_type) ||
        !row.notes;

      if (needsUpdate) {
        if (hasMeterCol) {
          targetDb.prepare(`
            UPDATE assets
               SET ownership = 'HIRED',
                   in_register = 0,
                   type = ?,
                   meter_type = COALESCE(meter_type, ?),
                   notes = COALESCE(NULLIF(TRIM(notes), ''), ?),
                   updated_at = datetime('now')
             WHERE id = ?
          `).run(spec.type, spec.meterType, defaultNote, row.id);
        } else {
          targetDb.prepare(`
            UPDATE assets
               SET ownership = 'HIRED',
                   in_register = 0,
                   type = ?,
                   notes = COALESCE(NULLIF(TRIM(notes), ''), ?),
                   updated_at = datetime('now')
             WHERE id = ?
          `).run(spec.type, defaultNote, row.id);
        }
        assetsMarkedHired++;
      }
    }

    // 2. Backfill ownership = 'HIRED' on any other asset tagged as hired in type/notes/category
    const allAssets = targetDb.prepare('SELECT id, type, notes, category, ownership FROM assets').all();
    for (const a of allAssets) {
      const text = `${a.type || ''} ${a.notes || ''} ${a.category || ''}`;
      if (HIRED_TEXT_RE.test(text)) {
        if (String(a.ownership || '').toUpperCase() !== 'HIRED') {
          targetDb.prepare("UPDATE assets SET ownership = 'HIRED', in_register = 0, updated_at = datetime('now') WHERE id = ?").run(a.id);
          assetsMarkedHired++;
        }
      }
    }

    // 3. Clean E&C rate cards, allocations, assignments, bills, and revenue events for the 5 specified hired vehicles
    const idList = [...hiredIds];
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

      if (tableExists(targetDb, 'fleet_bills')) {
        const info = targetDb.prepare(`
          UPDATE fleet_bills
             SET status = 'VOID',
                 notes = CASE
                   WHEN COALESCE(notes, '') LIKE '%hired/external%' THEN notes
                   ELSE TRIM(CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE notes || ' | ' END || 'Voided: hired/external vehicle (settled direct with owner)')
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
    assetsMarkedHired,
    ratesRemoved,
    allocsUpdated,
    assignmentsUpdated,
    billsVoided,
    revEventsRemoved,
  };
}

module.exports = { runMigration, HIRED_SPECS };
