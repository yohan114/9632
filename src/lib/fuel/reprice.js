'use strict';

/**
 * Audited Retroactive Fuel Tariff Re-Pricing & Draft Bill Refresh Engine
 *
 * Re-prices historical fuel slips (`fuel_issues`) within a date range to their
 * matching Ceypetco / effective `fuel_prices` tariff and recalculates affected
 * unlocked `DRAFT` `fleet_bills` + `fleet_bill_line_items` (never touching
 * `FINAL`/`PAID` bills or locked billing periods).
 */

const breakdowns = require('../billing/breakdowns');
const fuelTimeline = require('../billing/fuel_timeline');
const periodLocks = require('../billing/period_locks');
const audit = require('../audit');

function qGet(targetDb, sql, ...params) {
  if (targetDb) return targetDb.prepare(sql).get(...params);
  return require('../../db').get(sql, ...params);
}

function qAll(targetDb, sql, ...params) {
  if (targetDb) return targetDb.prepare(sql).all(...params);
  return require('../../db').all(sql, ...params);
}

function qRun(targetDb, sql, ...params) {
  if (targetDb) return targetDb.prepare(sql).run(...params);
  return require('../../db').run(sql, ...params);
}

function qTx(targetDb, fn) {
  if (targetDb) return targetDb.transaction(fn)();
  return require('../../db').tx(fn);
}

function getCols(targetDb, tableName) {
  try {
    return new Set(qAll(targetDb, `PRAGMA table_info("${tableName}")`).map((c) => c.name));
  } catch {
    return new Set();
  }
}

function hasTable(targetDb, tableName) {
  return Boolean(qGet(targetDb, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", tableName));
}

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

function normalizeIsoDate(raw, fieldName) {
  const s = String(raw || '').trim().slice(0, 10);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(s)) {
    throw badRequest(`Valid ${fieldName} (YYYY-MM-DD) is required`);
  }
  return s;
}

function resolveTariffCents(fuelType, slstDate, targetDb = null) {
  const ft = String(fuelType || 'AUTO_DIESEL').trim().toUpperCase();
  const row = qGet(
    targetDb,
    `
      SELECT price_per_litre_cents, price_per_litre, effective_date, source, notes
        FROM fuel_prices
       WHERE UPPER(COALESCE(fuel_type, fuel_kind)) = ?
         AND effective_date <= ?
       ORDER BY effective_date DESC, id DESC
       LIMIT 1
    `,
    ft,
    slstDate
  );
  if (!row) return null;
  const cents = Number(row.price_per_litre_cents) || Math.round(Number(row.price_per_litre || 0) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return {
    cents: Math.round(cents),
    effectiveDate: String(row.effective_date || '').slice(0, 10),
    source: row.source || row.notes || 'Fuel Tariff',
  };
}

function loadTankProjMap(targetDb = null) {
  const map = new Map();
  if (!hasTable(targetDb, 'fuel_tanks')) return map;
  for (const t of qAll(targetDb, 'SELECT id, project_id FROM fuel_tanks')) {
    map.set(String(t.id), t.project_id != null ? Number(t.project_id) : null);
  }
  return map;
}

function loadProjectsMap(targetDb = null) {
  const map = new Map();
  if (!hasTable(targetDb, 'projects')) return map;
  for (const p of qAll(targetDb, 'SELECT id, code, name FROM projects')) {
    map.set(Number(p.id), { id: Number(p.id), code: p.code || null, name: p.name || null });
  }
  return map;
}

function previewFuelReprice({
  fromDate,
  toDate,
  fuelType = 'ALL',
  includeManual = false,
  projectId = null,
  targetDb = null,
} = {}) {
  const start = normalizeIsoDate(fromDate, 'fromDate');
  const end = normalizeIsoDate(toDate, 'toDate');
  if (start > end) {
    throw badRequest('fromDate must be on or before toDate');
  }

  const normFuelFilter = String(fuelType || 'ALL').trim().toUpperCase() || 'ALL';
  const reqProjectId = projectId != null && projectId !== '' && String(projectId).toUpperCase() !== 'ALL'
    ? Number(projectId)
    : null;

  if (!hasTable(targetDb, 'fuel_issues') || !hasTable(targetDb, 'fuel_prices')) {
    return {
      fromDate: start,
      toDate: end,
      fuelType: normFuelFilter,
      includeManual: Boolean(includeManual),
      eligibleCount: 0,
      totalLitres: 0,
      oldTotalCostCents: 0,
      newTotalCostCents: 0,
      deltaCostCents: 0,
      skippedManualCount: 0,
      skippedLockedCount: 0,
      unchangedCount: 0,
      impactedDraftBillsCount: 0,
      impactedFinalBillsCount: 0,
      byPeriod: [],
      byFuelType: [],
      sample: [],
      _eligible: [],
    };
  }

  const tankProjMap = loadTankProjMap(targetDb);
  const projectsMap = loadProjectsMap(targetDb);
  const fiCols = getCols(targetDb, 'fuel_issues');
  const voidClause = fiCols.has('voided')
    ? 'COALESCE(is_voided, 0) = 0 AND COALESCE(voided, 0) = 0'
    : 'COALESCE(is_voided, 0) = 0';

  const winStart = fuelTimeline.addDays(start, -1);
  const winEnd = `${fuelTimeline.addDays(end, 1)} 23:59:59`;
  const rows = qAll(
    targetDb,
    `
      SELECT *
        FROM fuel_issues
       WHERE ${voidClause}
         AND issue_date >= ?
         AND issue_date <= ?
       ORDER BY issue_date ASC, id ASC
    `,
    winStart,
    winEnd
  );

  const lockCache = new Map();
  const checkLocked = (pk, pid) => {
    const k = `${pk}|${pid || 0}`;
    if (!lockCache.has(k)) {
      lockCache.set(k, Boolean(periodLocks.isPeriodLocked(pk, pid || 0, targetDb)));
    }
    return lockCache.get(k);
  };

  let skippedManualCount = 0;
  let skippedLockedCount = 0;
  let unchangedCount = 0;
  let totalLitres = 0;
  let oldTotalCostCents = 0;
  let newTotalCostCents = 0;

  const eligible = [];
  const byPeriodMap = new Map();
  const byFuelTypeMap = new Map();
  const affectedAssetPeriods = new Set();

  for (const fi of rows) {
    const slstDate = fuelTimeline.slstDate10(fi.issue_date);
    if (!slstDate || slstDate < start || slstDate > end) continue;

    const ft = String(fi.fuel_type || fi.fuel_kind || 'AUTO_DIESEL').trim().toUpperCase();
    if (normFuelFilter !== 'ALL' && ft !== normFuelFilter) continue;

    const pid = fuelTimeline.resolveIssueProjectId(fi, tankProjMap);
    if (reqProjectId != null && Number(pid) !== reqProjectId) continue;

    const periodKey = slstDate.slice(0, 7);
    if (checkLocked(periodKey, pid)) {
      skippedLockedCount++;
      continue;
    }

    if (Number(fi.is_manual || 0) === 1 && !includeManual) {
      skippedManualCount++;
      continue;
    }

    const tariff = resolveTariffCents(ft, slstDate, targetDb);
    if (!tariff) continue;

    const litres = Number(fi.litres || 0);
    if (!Number.isFinite(litres) || litres <= 0) continue;

    const oldPriceCents = Math.round(
      Number(fi.price_per_litre_cents || fi.fuel_price_cents || Math.round(Number(fi.unit_price || 0) * 100) || 0)
    );
    const rawOldTotal = Number(fi.total_cost_cents || fi.cost_cents || Math.round(Number(fi.total_price || 0) * 100) || 0);
    const oldTotalCents = rawOldTotal > 0 ? Math.round(rawOldTotal) : Math.round(litres * oldPriceCents);
    const newPriceCents = tariff.cents;
    const newTotalCents = Math.round(litres * newPriceCents);

    if (oldPriceCents === newPriceCents && oldTotalCents === newTotalCents) {
      unchangedCount++;
      continue;
    }

    const deltaCents = newTotalCents - oldTotalCents;
    const projInfo = pid != null ? projectsMap.get(Number(pid)) : null;

    eligible.push({
      id: fi.id,
      issueDate: fi.issue_date,
      slstDate,
      periodKey,
      assetId: fi.asset_id != null ? Number(fi.asset_id) : null,
      assetCode: fi.asset_code || fi.vehicle_ref || null,
      projectId: pid != null ? Number(pid) : null,
      projectName: projInfo ? projInfo.name : null,
      fuelType: ft,
      litres: Math.round(litres * 1000) / 1000,
      oldPriceCents,
      newPriceCents,
      oldTotalCents,
      newTotalCents,
      deltaCents,
      tariffEffectiveDate: tariff.effectiveDate,
    });

    totalLitres += litres;
    oldTotalCostCents += oldTotalCents;
    newTotalCostCents += newTotalCents;

    if (fi.asset_id != null) {
      affectedAssetPeriods.add(`${periodKey}|${Number(fi.asset_id)}`);
    }

    const pStat = byPeriodMap.get(periodKey) || {
      periodKey,
      count: 0,
      litres: 0,
      oldCostCents: 0,
      newCostCents: 0,
      deltaCents: 0,
    };
    pStat.count++;
    pStat.litres += litres;
    pStat.oldCostCents += oldTotalCents;
    pStat.newCostCents += newTotalCents;
    pStat.deltaCents += deltaCents;
    byPeriodMap.set(periodKey, pStat);

    const fStat = byFuelTypeMap.get(ft) || {
      fuelType: ft,
      count: 0,
      litres: 0,
      oldCostCents: 0,
      newCostCents: 0,
      deltaCents: 0,
    };
    fStat.count++;
    fStat.litres += litres;
    fStat.oldCostCents += oldTotalCents;
    fStat.newCostCents += newTotalCents;
    fStat.deltaCents += deltaCents;
    byFuelTypeMap.set(ft, fStat);
  }

  let impactedDraftBillsCount = 0;
  let impactedFinalBillsCount = 0;
  if (affectedAssetPeriods.size > 0 && hasTable(targetDb, 'fleet_bills')) {
    const periods = [...new Set([...affectedAssetPeriods].map((k) => k.split('|')[0]))];
    const placeholders = periods.map(() => '?').join(',');
    const bills = qAll(
      targetDb,
      `
        SELECT id, period_key, asset_id, status
          FROM fleet_bills
         WHERE status != 'VOID'
           AND asset_id IS NOT NULL
           AND period_key IN (${placeholders})
      `,
      ...periods
    );
    for (const b of bills) {
      if (!affectedAssetPeriods.has(`${b.period_key}|${Number(b.asset_id)}`)) continue;
      if (b.status === 'DRAFT') impactedDraftBillsCount++;
      else if (b.status === 'FINAL' || b.status === 'PAID') impactedFinalBillsCount++;
    }
  }

  const byPeriod = [...byPeriodMap.values()].map((r) => ({ ...r, litres: Math.round(r.litres * 100) / 100 }));
  const byFuelType = [...byFuelTypeMap.values()].map((r) => ({ ...r, litres: Math.round(r.litres * 100) / 100 }));

  return {
    fromDate: start,
    toDate: end,
    fuelType: normFuelFilter,
    includeManual: Boolean(includeManual),
    eligibleCount: eligible.length,
    totalLitres: Math.round(totalLitres * 100) / 100,
    oldTotalCostCents,
    newTotalCostCents,
    deltaCostCents: newTotalCostCents - oldTotalCostCents,
    skippedManualCount,
    skippedLockedCount,
    unchangedCount,
    impactedDraftBillsCount,
    impactedFinalBillsCount,
    byPeriod,
    byFuelType,
    sample: eligible.slice(0, 25),
    _eligible: eligible,
  };
}

function refreshDraftBillsForPeriods(periodKeys, { targetDb = null, onlyAssetIds = null } = {}) {
  const periods = [...new Set((periodKeys || []).filter((k) => /^\d{4}-\d{2}$/.test(String(k || ''))))];
  if (!periods.length || !hasTable(targetDb, 'fleet_bills') || !hasTable(targetDb, 'fuel_issues')) {
    return { draftBillsUpdated: 0, draftBillDeltaCents: 0 };
  }

  const tankProjMap = loadTankProjMap(targetDb);
  const fiCols = getCols(targetDb, 'fuel_issues');
  const fbCols = getCols(targetDb, 'fleet_bills');
  const hasLineItems = hasTable(targetDb, 'fleet_bill_line_items');
  const voidClause = fiCols.has('voided')
    ? 'COALESCE(is_voided, 0) = 0 AND COALESCE(voided, 0) = 0'
    : 'COALESCE(is_voided, 0) = 0';
  const directClause = fiCols.has('is_direct_billed') ? ' AND COALESCE(is_direct_billed, 0) = 0' : '';
  const assetFilterSet = onlyAssetIds && onlyAssetIds.size > 0
    ? new Set([...onlyAssetIds].map((x) => Number(x)))
    : null;

  let draftBillsUpdated = 0;
  let draftBillDeltaCents = 0;

  for (const periodKey of periods) {
    const bounds = breakdowns.monthBounds(periodKey);
    if (!bounds) continue;

    const draftBills = qAll(
      targetDb,
      "SELECT * FROM fleet_bills WHERE period_key = ? AND status = 'DRAFT'",
      periodKey
    ).filter((b) => !assetFilterSet || (b.asset_id != null && assetFilterSet.has(Number(b.asset_id))));

    if (!draftBills.length) continue;

    const winStart = fuelTimeline.addDays(bounds.start, -1);
    const winEnd = `${fuelTimeline.addDays(bounds.end, 1)} 23:59:59`;
    const periodIssues = qAll(
      targetDb,
      `
        SELECT *
          FROM fuel_issues
         WHERE ${voidClause}${directClause}
           AND issue_date >= ?
           AND issue_date <= ?
      `,
      winStart,
      winEnd
    );

    const byAssetSite = new Map();
    const byAsset = new Map();

    for (const fi of periodIssues) {
      if (fi.asset_id == null) continue;
      const day = fuelTimeline.slstDate10(fi.issue_date);
      if (!day || day < bounds.start || day > bounds.end) continue;
      const aid = Number(fi.asset_id);
      const pid = fuelTimeline.resolveIssueProjectId(fi, tankProjMap) || 0;
      const litres = Number(fi.litres || 0);
      const costCents = Math.round(
        Number(fi.total_cost_cents || fi.cost_cents || Math.round(Number(fi.total_price || 0) * 100) || 0)
      );

      const siteKey = `${aid}|${pid}`;
      const siteCur = byAssetSite.get(siteKey) || { litres: 0, costCents: 0 };
      siteCur.litres += litres;
      siteCur.costCents += costCents;
      byAssetSite.set(siteKey, siteCur);

      const totCur = byAsset.get(String(aid)) || { litres: 0, costCents: 0 };
      totCur.litres += litres;
      totCur.costCents += costCents;
      byAsset.set(String(aid), totCur);
    }

    for (const bill of draftBills) {
      if (bill.asset_id == null) continue;
      if (periodLocks.isPeriodLocked(bill.period_key, bill.project_id || 0, targetDb)) continue;

      const bm = String(bill.billing_mode || '').trim().toUpperCase();
      const chargesFuel = ['WET', 'FULLY_WET', 'FUEL_ONLY'].includes(bm)
        || Number(bill.fuel_cost_cents || 0) > 0
        || Number(bill.fuel_litres || 0) > 0;
      if (!chargesFuel) continue;

      const aid = Number(bill.asset_id);
      const agg = bill.project_id != null
        ? byAssetSite.get(`${aid}|${Number(bill.project_id)}`)
        : byAsset.get(String(aid));
      if (!agg || agg.litres <= 0) continue;

      const newFuelLitres = Math.round(agg.litres * 100) / 100;
      const newFuelCostCents = Math.round(agg.costCents);
      const rentalAmt = Number(bill.rental_amount_cents || 0);
      const bdDeduct = fbCols.has('breakdown_deduct_cents') ? Number(bill.breakdown_deduct_cents || 0) : 0;
      const netRentalCents = Math.max(0, rentalAmt - bdDeduct);
      const subtotalCents = netRentalCents + newFuelCostCents;
      const ssclRate = bill.sscl_rate != null ? Number(bill.sscl_rate) : 0.025;
      const vatRate = bill.vat_rate != null ? Number(bill.vat_rate) : 0.18;
      const ssclCents = Math.round(subtotalCents * ssclRate);
      const vatCents = Math.round((subtotalCents + ssclCents) * vatRate);
      const grandTotalCents = subtotalCents + ssclCents + vatCents;

      if (
        Number(bill.fuel_cost_cents || 0) === newFuelCostCents &&
        Number(bill.grand_total_cents || 0) === grandTotalCents &&
        Math.abs(Number(bill.fuel_litres || 0) - newFuelLitres) < 0.005
      ) {
        continue;
      }

      const oldGrand = Number(bill.grand_total_cents || 0);
      qRun(
        targetDb,
        `
          UPDATE fleet_bills
             SET fuel_litres = ?,
                 fuel_cost_cents = ?,
                 subtotal_cents = ?,
                 sscl_cents = ?,
                 vat_cents = ?,
                 grand_total_cents = ?,
                 updated_at = datetime('now')
           WHERE id = ?
        `,
        newFuelLitres,
        newFuelCostCents,
        subtotalCents,
        ssclCents,
        vatCents,
        grandTotalCents,
        bill.id
      );

      if (hasLineItems) {
        const unitPriceCents = newFuelLitres > 0 ? Math.round(newFuelCostCents / newFuelLitres) : 0;
        const desc = `Fuel Recharge (${newFuelLitres} Litres @ Rs ${(unitPriceCents / 100).toFixed(2)})`;
        const updLi = qRun(
          targetDb,
          `
            UPDATE fleet_bill_line_items
               SET description = ?,
                   quantity = ?,
                   unit_price_cents = ?,
                   amount_cents = ?
             WHERE bill_id = ? AND item_type = 'FUEL'
          `,
          desc,
          newFuelLitres,
          unitPriceCents,
          newFuelCostCents,
          bill.id
        );
        if (!updLi || !updLi.changes) {
          qRun(
            targetDb,
            `
              INSERT OR REPLACE INTO fleet_bill_line_items (
                id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
              ) VALUES (?, ?, 'FUEL', ?, ?, ?, ?, 0)
            `,
            `li-${bill.id}-fuel`,
            bill.id,
            desc,
            newFuelLitres,
            unitPriceCents,
            newFuelCostCents
          );
        }
      }

      draftBillsUpdated++;
      draftBillDeltaCents += (grandTotalCents - oldGrand);
    }
  }

  return { draftBillsUpdated, draftBillDeltaCents };
}

function applyFuelReprice({
  fromDate,
  toDate,
  fuelType = 'ALL',
  includeManual = false,
  projectId = null,
  refreshDraftBills = true,
  actorId = null,
  reason = null,
  targetDb = null,
} = {}) {
  const preview = previewFuelReprice({
    fromDate,
    toDate,
    fuelType,
    includeManual,
    projectId,
    targetDb,
  });

  const eligible = preview._eligible || [];
  let repricedCount = 0;
  let draftRefresh = { draftBillsUpdated: 0, draftBillDeltaCents: 0 };

  if (eligible.length > 0) {
    const fiCols = getCols(targetDb, 'fuel_issues');
    const setParts = [];
    const buildParams = (item) => {
      const p = [];
      if (fiCols.has('fuel_price_cents')) p.push(item.newPriceCents);
      if (fiCols.has('price_per_litre_cents')) p.push(item.newPriceCents);
      if (fiCols.has('unit_price')) p.push(item.newPriceCents / 100);
      if (fiCols.has('total_cost_cents')) p.push(item.newTotalCents);
      if (fiCols.has('cost_cents')) p.push(item.newTotalCents);
      if (fiCols.has('total_price')) p.push(item.newTotalCents / 100);
      p.push(item.id);
      return p;
    };

    if (fiCols.has('fuel_price_cents')) setParts.push('fuel_price_cents = ?');
    if (fiCols.has('price_per_litre_cents')) setParts.push('price_per_litre_cents = ?');
    if (fiCols.has('unit_price')) setParts.push('unit_price = ?');
    if (fiCols.has('total_cost_cents')) setParts.push('total_cost_cents = ?');
    if (fiCols.has('cost_cents')) setParts.push('cost_cents = ?');
    if (fiCols.has('total_price')) setParts.push('total_price = ?');
    if (fiCols.has('updated_at')) setParts.push("updated_at = datetime('now')");

    const affectedPeriods = new Set();
    const affectedAssetIds = new Set();

    qTx(targetDb, () => {
      if (setParts.length > 0) {
        const updateSql = `UPDATE fuel_issues SET ${setParts.join(', ')} WHERE id = ?`;
        for (const item of eligible) {
          qRun(targetDb, updateSql, ...buildParams(item));
          repricedCount++;
          affectedPeriods.add(item.periodKey);
          if (item.assetId != null) affectedAssetIds.add(item.assetId);
        }
      }

      if (refreshDraftBills && affectedPeriods.size > 0) {
        draftRefresh = refreshDraftBillsForPeriods([...affectedPeriods], {
          targetDb,
          onlyAssetIds: affectedAssetIds,
        });
      }
    });

    if (!targetDb && repricedCount > 0) {
      const msg = reason || `Re-priced ${repricedCount} fuel slip(s) (${preview.fromDate}..${preview.toDate})`;
      try {
        audit.record({
          userId: actorId,
          entity: 'fuel_price',
          entityId: null,
          action: 'fuel.issues.repriced',
          after: {
            fromDate: preview.fromDate,
            toDate: preview.toDate,
            fuelType: preview.fuelType,
            repricedCount,
            totalLitres: preview.totalLitres,
            deltaCostCents: preview.deltaCostCents,
            draftBillsUpdated: draftRefresh.draftBillsUpdated,
          },
          reason: msg,
        });
        if (draftRefresh.draftBillsUpdated > 0) {
          audit.record({
            userId: actorId,
            entity: 'fleet_bill',
            entityId: null,
            action: 'hire.drafts.repriced',
            after: {
              fromDate: preview.fromDate,
              toDate: preview.toDate,
              draftBillsUpdated: draftRefresh.draftBillsUpdated,
              draftBillDeltaCents: draftRefresh.draftBillDeltaCents,
            },
            reason: msg,
          });
        }
      } catch (_) {}
    }
  }

  const { _eligible, ...summary } = preview;
  return {
    ...summary,
    repricedCount,
    draftBillsUpdated: draftRefresh.draftBillsUpdated,
    draftBillDeltaCents: draftRefresh.draftBillDeltaCents,
  };
}

module.exports = {
  resolveTariffCents,
  previewFuelReprice,
  refreshDraftBillsForPeriods,
  applyFuelReprice,
};
