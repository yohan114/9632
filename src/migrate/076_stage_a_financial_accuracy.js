'use strict';

/**
 * Migration 076: Stage A Financial Accuracy & Data Hygiene
 *
 * Idempotent migration that:
 * 1. Ensures `fleet_billing_period_locks` exists.
 * 2. Marks all `SITE-*` and `TRANSFER-*` pseudo-assets `in_register = 0` and removes
 *    any rate cards, non-locked active allocations, or DRAFT bills attached to them.
 * 3. Configures `DAI-9758` (`Mahindra Bolero`) with the standard `Single Cab` KM rate card.
 * 4. Re-prices Nov 2+ (`2026-11-02..2026-11-30`) non-manual `AUTO_DIESEL` `fuel_issues`
 *    to the official effective Ceypetco tariff (Rs 397.00) and refreshes impacted `DRAFT`
 *    `fleet_bills` + `fleet_bill_line_items`.
 * 5. Generates `DAI-9758`'s `2026-11` `DRAFT` bill at its operational site (Badalgama Plant)
 *    when `2026-11` site drafts exist and `DAI-9758` does not yet have one.
 */

const SINGLE_CAB_RATE = Object.freeze({
  category_name: 'Single Cab',
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
  hr_dry_cents: 60000,
  hr_wet_cents: 106000,
  hr_fw_cents: 106000,
  dy_dry_cents: 230000,
  dy_wet_cents: 400000,
  dy_fw_cents: 400000,
  min_bill_hours: 3000,
  fuel_cons_basis: 'km',
  fuel_cons_econ: 0.07092198581560284,
  fuel_cons_typ: 0.09090909090909091,
  fuel_cons_heavy: 0.11363636363636363,
  source_label: 'Single Cab standard rate (km/L)',
  note: 'Single Cab standard rate (Migration 076)',
});

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
}

function numsClose(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

function runMigration(targetDb) {
  if (!targetDb || !tableExists(targetDb, 'assets')) {
    return { skipped: true };
  }

  const periodLocks = require('../lib/billing/period_locks');
  const fuelReprice = require('../lib/fuel/reprice');
  const fuelTimeline = require('../lib/billing/fuel_timeline');
  const breakdowns = require('../lib/billing/breakdowns');
  const calc = require('../lib/billing/calc');

  const stats = {
    pseudoAssetsCleaned: 0,
    pseudoRatesRemoved: 0,
    pseudoAllocsDeactivated: 0,
    pseudoDraftsVoided: 0,
    dai9758Updated: 0,
    dai9758RateUpserted: 0,
    fuelSlipsRepriced: 0,
    draftBillsRefreshed: 0,
    dai9758DraftCreated: 0,
  };

  // 1. Ensure period locks table
  periodLocks.ensurePeriodLocksTable(targetDb);

  const assetCols = getColSet(targetDb, 'assets');
  const fvaCols = getColSet(targetDb, 'fleet_vehicle_allocations');
  const rateCols = getColSet(targetDb, 'fleet_rental_rates');
  const fbCols = getColSet(targetDb, 'fleet_bills');
  const fiCols = getColSet(targetDb, 'fuel_issues');

  targetDb.transaction(() => {
    // 2. Clean SITE-* and TRANSFER-* pseudo-assets from registered fleet
    const pseudoAssets = targetDb.prepare(`
      SELECT id, code, in_register
        FROM assets
       WHERE UPPER(TRIM(code)) LIKE 'SITE-%'
          OR UPPER(TRIM(code)) LIKE 'TRANSFER-%'
    `).all();

    for (const pa of pseudoAssets) {
      if (assetCols.has('in_register') && Number(pa.in_register || 0) !== 0) {
        if (assetCols.has('updated_at')) {
          targetDb.prepare("UPDATE assets SET in_register = 0, updated_at = datetime('now') WHERE id = ?").run(pa.id);
        } else {
          targetDb.prepare('UPDATE assets SET in_register = 0 WHERE id = ?').run(pa.id);
        }
        stats.pseudoAssetsCleaned++;
      }
      if (rateCols.size > 0) {
        const info = targetDb.prepare('DELETE FROM fleet_rental_rates WHERE asset_id = ?').run(pa.id);
        stats.pseudoRatesRemoved += info.changes || 0;
      }
      if (fvaCols.size > 0) {
        const lockCond = fvaCols.has('locked') ? ' AND COALESCE(locked, 0) = 0' : '';
        const info = targetDb.prepare(`UPDATE fleet_vehicle_allocations SET active = 0 WHERE asset_id = ? AND COALESCE(active, 1) = 1${lockCond}`).run(pa.id);
        stats.pseudoAllocsDeactivated += info.changes || 0;
      }
      if (fbCols.size > 0) {
        const info = targetDb.prepare("UPDATE fleet_bills SET status = 'VOID', notes = COALESCE(notes || ' | ', '') || 'Voided pseudo-asset (Migration 076)', updated_at = datetime('now') WHERE asset_id = ? AND status = 'DRAFT'").run(pa.id);
        stats.pseudoDraftsVoided += info.changes || 0;
      }
    }

    // 3. Configure DAI-9758 (Mahindra Bolero) as Single Cab
    const dai = targetDb.prepare("SELECT * FROM assets WHERE UPPER(TRIM(code)) = 'DAI-9758' LIMIT 1").get();
    if (dai) {
      const hasOwn = assetCols.has('ownership');
      const hasRegFlag = assetCols.has('in_register');
      const hasMeter = assetCols.has('meter_type');

      const assetNeedsUpdate =
        (hasOwn && String(dai.ownership || '').toUpperCase() !== 'OWNED') ||
        (hasRegFlag && Number(dai.in_register || 0) !== 1) ||
        dai.brand !== 'Mahindra' ||
        dai.type !== 'Single Cab' ||
        dai.model_no !== 'Bolero' ||
        dai.registration !== 'DAI-9758' ||
        (hasMeter && dai.meter_type !== 'KM');

      if (assetNeedsUpdate) {
        const sets = ["brand = 'Mahindra'", "type = 'Single Cab'", "model_no = 'Bolero'", "registration = 'DAI-9758'"];
        if (hasOwn) sets.push("ownership = 'OWNED'");
        if (hasRegFlag) sets.push('in_register = 1');
        if (hasMeter) sets.push("meter_type = 'KM'");
        if (assetCols.has('updated_at')) sets.push("updated_at = datetime('now')");
        targetDb.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(dai.id);
        stats.dai9758Updated = 1;
      }

      if (rateCols.size > 0) {
        const curRate = targetDb.prepare('SELECT * FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1').get(dai.id);
        const rateMatches = curRate &&
          curRate.category_name === SINGLE_CAB_RATE.category_name &&
          curRate.rate_basis === SINGLE_CAB_RATE.rate_basis &&
          Number(curRate.dry_rate_cents || 0) === SINGLE_CAB_RATE.dry_rate_cents &&
          Number(curRate.wet_rate_cents || 0) === SINGLE_CAB_RATE.wet_rate_cents &&
          Number(curRate.fully_wet_rate_cents || 0) === SINGLE_CAB_RATE.fully_wet_rate_cents &&
          numsClose(curRate.fuel_cons_typ, SINGLE_CAB_RATE.fuel_cons_typ);

        if (!rateMatches) {
          const rateId = (curRate && curRate.id) || `rate-asset-${dai.id}`;
          targetDb.prepare('DELETE FROM fleet_rental_rates WHERE asset_id = ?').run(dai.id);
          if (rateCols.has('km_dry_cents')) {
            targetDb.prepare(`
              INSERT INTO fleet_rental_rates (
                id, asset_id, category_name, rate_basis, rate_cents,
                dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, min_bill_hours,
                equip_type, default_basis, source_label,
                fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, note,
                hr_dry_cents, hr_wet_cents, hr_fw_cents,
                dy_dry_cents, dy_wet_cents, dy_fw_cents,
                km_dry_cents, km_wet_cents, km_fw_cents
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              rateId, dai.id, SINGLE_CAB_RATE.category_name, SINGLE_CAB_RATE.rate_basis, SINGLE_CAB_RATE.rate_cents,
              SINGLE_CAB_RATE.dry_rate_cents, SINGLE_CAB_RATE.wet_rate_cents, SINGLE_CAB_RATE.fully_wet_rate_cents,
              SINGLE_CAB_RATE.min_bill_hours, SINGLE_CAB_RATE.equip_type, SINGLE_CAB_RATE.default_basis,
              SINGLE_CAB_RATE.source_label, SINGLE_CAB_RATE.fuel_cons_econ, SINGLE_CAB_RATE.fuel_cons_typ,
              0.11363636363636363, SINGLE_CAB_RATE.fuel_cons_basis, SINGLE_CAB_RATE.note,
              SINGLE_CAB_RATE.hr_dry_cents, SINGLE_CAB_RATE.hr_wet_cents, SINGLE_CAB_RATE.hr_fw_cents,
              SINGLE_CAB_RATE.dy_dry_cents, SINGLE_CAB_RATE.dy_wet_cents, SINGLE_CAB_RATE.dy_fw_cents,
              SINGLE_CAB_RATE.km_dry_cents, SINGLE_CAB_RATE.km_wet_cents, SINGLE_CAB_RATE.km_fw_cents
            );
          } else {
            targetDb.prepare(`
              INSERT INTO fleet_rental_rates (
                id, asset_id, category_name, rate_basis, rate_cents,
                dry_rate_cents, wet_rate_cents, fully_wet_rate_cents, min_bill_hours,
                equip_type, default_basis, source_label,
                fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis, note
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              rateId, dai.id, SINGLE_CAB_RATE.category_name, SINGLE_CAB_RATE.rate_basis, SINGLE_CAB_RATE.rate_cents,
              SINGLE_CAB_RATE.dry_rate_cents, SINGLE_CAB_RATE.wet_rate_cents, SINGLE_CAB_RATE.fully_wet_rate_cents,
              SINGLE_CAB_RATE.min_bill_hours, SINGLE_CAB_RATE.equip_type, SINGLE_CAB_RATE.default_basis,
              SINGLE_CAB_RATE.source_label, SINGLE_CAB_RATE.fuel_cons_econ, SINGLE_CAB_RATE.fuel_cons_typ,
              0.11363636363636363, SINGLE_CAB_RATE.fuel_cons_basis, SINGLE_CAB_RATE.note
            );
          }
          stats.dai9758RateUpserted = 1;
        }
      }
    }
  })();

  // 4. Re-price Nov 2+ non-manual AUTO_DIESEL fuel_issues & refresh affected DRAFT bills
  if (fiCols.size > 0 && tableExists(targetDb, 'fuel_prices')) {
    const nov2Tariff = fuelReprice.resolveTariffCents('AUTO_DIESEL', '2026-11-02', targetDb);
    if (nov2Tariff && nov2Tariff.effectiveDate >= '2026-11-02') {
      const repRes = fuelReprice.applyFuelReprice({
        fromDate: '2026-11-02',
        toDate: '2026-11-30',
        fuelType: 'AUTO_DIESEL',
        includeManual: false,
        refreshDraftBills: true,
        reason: 'Stage A Migration 076: align Nov 2+ fuel slips with official Ceypetco 2026-11-02 tariff',
        targetDb,
      });
      stats.fuelSlipsRepriced = repRes.repricedCount || 0;
      stats.draftBillsRefreshed = repRes.draftBillsUpdated || 0;
    }
  }

  // 5. Generate missing 2026-11 DRAFT bill for DAI-9758 when Nov 2026 site drafts already exist
  if (fbCols.size > 0 && fiCols.size > 0 && tableExists(targetDb, 'projects')) {
    const dai = targetDb.prepare("SELECT * FROM assets WHERE UPPER(TRIM(code)) = 'DAI-9758' LIMIT 1").get();
    const hasNovBills = Number(
      targetDb.prepare("SELECT COUNT(*) c FROM fleet_bills WHERE period_key = '2026-11' AND status != 'VOID'").get().c || 0
    ) > 0;
    const daiHasNovBill = dai && Boolean(
      targetDb.prepare("SELECT 1 FROM fleet_bills WHERE period_key = '2026-11' AND asset_id = ? AND status != 'VOID' LIMIT 1").get(dai.id)
    );

    if (dai && hasNovBills && !daiHasNovBill) {
      const tankProjMap = new Map();
      if (tableExists(targetDb, 'fuel_tanks')) {
        for (const t of targetDb.prepare('SELECT id, project_id FROM fuel_tanks').all()) {
          tankProjMap.set(String(t.id), t.project_id != null ? Number(t.project_id) : null);
        }
      }
      const voidCond = fiCols.has('voided')
        ? 'COALESCE(is_voided, 0) = 0 AND COALESCE(voided, 0) = 0'
        : 'COALESCE(is_voided, 0) = 0';
      const directCond = fiCols.has('is_direct_billed') ? ' AND COALESCE(is_direct_billed, 0) = 0' : '';

      const daiNovRows = targetDb.prepare(`
        SELECT *
          FROM fuel_issues
         WHERE ${voidCond}${directCond}
           AND asset_id = ?
           AND issue_date >= '2026-10-31'
           AND issue_date <= '2026-12-01 23:59:59'
         ORDER BY issue_date ASC, id ASC
      `).all(dai.id).filter((fi) => {
        const d = fuelTimeline.slstDate10(fi.issue_date);
        return d && d >= '2026-11-01' && d <= '2026-11-30';
      });

      if (daiNovRows.length > 0) {
        const siteAgg = new Map();
        for (const fi of daiNovRows) {
          const pid = fuelTimeline.resolveIssueProjectId(fi, tankProjMap);
          if (!pid) continue;
          const d = fuelTimeline.slstDate10(fi.issue_date);
          const l = Number(fi.litres || 0);
          const p = Number(fi.price_per_litre_cents || fi.fuel_price_cents || 0) || Math.round(Number(fi.unit_price || 0) * 100);
          const c = Number(fi.total_cost_cents || fi.cost_cents || 0) || Math.round(l * p);
          const cur = siteAgg.get(pid) || { pid, litres: 0, costCents: 0, firstDate: d, driverName: null, readings: [] };
          cur.litres += l;
          cur.costCents += c;
          if (!cur.firstDate || d < cur.firstDate) cur.firstDate = d;
          if (!cur.driverName && fi.driver_name) cur.driverName = fi.driver_name;
          if (Number(fi.meter_reading) > 0) cur.readings.push(Number(fi.meter_reading));
          siteAgg.set(pid, cur);
        }

        const topSite = [...siteAgg.values()].sort((a, b) => b.litres - a.litres)[0];
        if (topSite && !periodLocks.isPeriodLocked('2026-11', topSite.pid, targetDb)) {
          const proj = targetDb.prepare('SELECT id, code, name FROM projects WHERE id = ?').get(topSite.pid);
          if (proj) {
            const period = breakdowns.monthBounds('2026-11');
            const priorSameSite = Boolean(
              targetDb.prepare(`
                SELECT 1 FROM fuel_issues
                 WHERE ${voidCond}${directCond}
                   AND asset_id = ?
                   AND issue_date >= '2026-09-30' AND issue_date < '2026-11-01'
                   AND COALESCE(target_project_id, project_id, source_project_id) = ?
                 LIMIT 1
              `).get(dai.id, proj.id)
            );

            // Check prior-month fuel via resolved tank/site map if needed
            let inPriorMonth = priorSameSite;
            if (!inPriorMonth) {
              const octRows = targetDb.prepare(`
                SELECT source_tank_id, bulk_tank_id, target_project_id, project_id, source_project_id, issue_date
                  FROM fuel_issues
                 WHERE ${voidCond}${directCond}
                   AND asset_id = ?
                   AND issue_date >= '2026-09-30' AND issue_date <= '2026-11-01 23:59:59'
              `).all(dai.id);
              inPriorMonth = octRows.some((r) => {
                const d = fuelTimeline.slstDate10(r.issue_date);
                return d && d >= '2026-10-01' && d <= '2026-10-31' && fuelTimeline.resolveIssueProjectId(r, tankProjMap) === proj.id;
              });
            }

            const firstDayNum = Number(topSite.firstDate.slice(8, 10));
            const postedDays = (inPriorMonth || firstDayNum <= 10)
              ? period.daysInMonth
              : breakdowns.daysBetweenInclusive(topSite.firstDate, period.end);

            const workingDaysHere = Math.round(((postedDays >= period.daysInMonth ? 25 : (25 * (postedDays / period.daysInMonth))) * 100)) / 100;
            const minProrated = Math.max(0, SINGLE_CAB_RATE.min_bill_hours * (workingDaysHere / 25));
            const fuelLitres = Math.round(topSite.litres * 100) / 100;
            const fuelCostCents = Math.round(topSite.costCents);
            const consRef = SINGLE_CAB_RATE.fuel_cons_typ > 0 ? (fuelLitres / SINGLE_CAB_RATE.fuel_cons_typ) : 0;
            const meterDelta = topSite.readings.length >= 2
              ? Math.max(0, Math.max(...topSite.readings) - Math.min(...topSite.readings))
              : null;
            const actualUnits = meterDelta != null ? meterDelta : Math.round(consRef * 100) / 100;
            const billableUnits = Math.max(meterDelta != null ? meterDelta : 0, consRef, minProrated);
            const billedOn = billableUnits > minProrated + 1e-9 ? (meterDelta != null && Math.abs(billableUnits - meterDelta) < 1e-6 ? 'meter' : 'fuel') : 'minimum';

            const rentalAmountCents = Math.round(billableUnits * SINGLE_CAB_RATE.wet_rate_cents);
            const subtotalCents = rentalAmountCents + fuelCostCents;

            let ssclRate = 0.025;
            let vatRate = 0.18;
            try {
              for (const s of targetDb.prepare("SELECT key, value FROM settings WHERE key IN ('billing.ssclRate', 'billing.vatRate')").all()) {
                if (s.key === 'billing.ssclRate' && Number.isFinite(parseFloat(s.value))) ssclRate = parseFloat(s.value);
                if (s.key === 'billing.vatRate' && Number.isFinite(parseFloat(s.value))) vatRate = parseFloat(s.value);
              }
            } catch (_) {}

            const ssclCents = Math.round(subtotalCents * ssclRate);
            const vatCents = Math.round((subtotalCents + ssclCents) * vatRate);
            const grandTotalCents = subtotalCents + ssclCents + vatCents;
            const billId = `bill-draft-2026-11-p${proj.id}-a${dai.id}`;
            const note = `Site Summary DRAFT (${billedOn}) — ${proj.name} (2026-11, Migration 076)`;

            const hasDerived = fbCols.has('derived_from_fuel');
            const billCols = [
              'id', 'invoice_number', 'year', 'month', 'period_key', 'period_start', 'period_end',
              'asset_id', 'asset_code', 'asset_reg_no', 'driver_name', 'project_id', 'project_name', 'project_code',
              'billing_mode', 'rate_basis', 'rate_cents', 'opening_meter', 'closing_meter',
              'actual_units', 'minimum_units', 'billable_units', 'rental_amount_cents',
              'fuel_litres', 'fuel_cost_cents', 'breakdown_days', 'breakdown_deduct_cents',
              'subtotal_cents', 'sscl_rate', 'sscl_cents', 'vat_rate', 'vat_cents', 'grand_total_cents',
              'status', 'issued_date', 'approved_by', 'approved_at', 'notes', 'generated_by',
            ];
            if (hasDerived) billCols.push('derived_from_fuel');

            const vals = [
              billId, null, period.year, period.month, period.periodKey, period.start, period.end,
              dai.id, dai.code, dai.registration || dai.code, topSite.driverName, proj.id, proj.name, proj.code,
              'WET', 'KM', SINGLE_CAB_RATE.wet_rate_cents, null, null,
              actualUnits, minProrated, billableUnits, rentalAmountCents,
              fuelLitres, fuelCostCents, 0, 0,
              subtotalCents, ssclRate, ssclCents, vatRate, vatCents, grandTotalCents,
              'DRAFT', null, null, null, note, 1,
            ];
            if (hasDerived) vals.push(1);

            targetDb.transaction(() => {
              const info = targetDb.prepare(
                `INSERT OR IGNORE INTO fleet_bills (${billCols.join(', ')}) VALUES (${billCols.map(() => '?').join(', ')})`
              ).run(...vals);

              if (info.changes > 0 && tableExists(targetDb, 'fleet_bill_line_items')) {
                const insLi = targetDb.prepare(`
                  INSERT OR REPLACE INTO fleet_bill_line_items (
                    id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);
                insLi.run(
                  `li-${billId}-rental`, billId, 'RENTAL',
                  `Machine Hire Rental (${billableUnits} km · ${calc.basisLabel('WET')})`,
                  billableUnits, SINGLE_CAB_RATE.wet_rate_cents, rentalAmountCents, 0
                );
                if (fuelCostCents > 0) {
                  const unitPriceCents = fuelLitres > 0 ? Math.round(fuelCostCents / fuelLitres) : 0;
                  insLi.run(
                    `li-${billId}-fuel`, billId, 'FUEL',
                    `Fuel Recharge (${fuelLitres} Litres @ Rs ${(unitPriceCents / 100).toFixed(2)})`,
                    fuelLitres, unitPriceCents, fuelCostCents, 0
                  );
                }
                stats.dai9758DraftCreated = 1;
              }
            })();
          }
        }
      }
    }
  }

  return stats;
}

module.exports = { runMigration, SINGLE_CAB_RATE };
