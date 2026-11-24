'use strict';

/**
 * Migration 075: Prepare Clean, Zero-Double-Billing November 2026 (2026-11)
 * Site DRAFT Bills Across All Operational Sites (Including Sites With 0 Fuel)
 *
 * 1. Voids stale pre-fix `2026-11` non-VOID bills (the `2026-11-21` `Auto-synced` batch
 *    that had wrong HOURLY-on-KM rates, double-billed vehicles, and legacy/null projects,
 *    plus prior pre-075 site drafts) and deletes their `fleet_financial_events`.
 * 2. Creates unlocked `CARRY_FORWARD` `2026-11` allocations for owned + rated vehicles
 *    whose latest confirmed operational site has 0 November fuel uploaded yet (so they
 *    appear cleanly in Vehicle Allocations & Site Summary Bill without double-billing,
 *    and automatically yield the moment November fuel arrives).
 * 3. Generates clean `DRAFT` bills + `fleet_bill_line_items` (Summary Standard `WET` tier,
 *    latest KM/HOURLY/25-day DAILY rate cards, 25-day breakdown deductions, SSCL 2.5% +
 *    VAT 18%) across all coded operational sites.
 */

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
}

function prepareMonthSiteDrafts(targetDb, { periodKey = '2026-11', actorId = 1 } = {}) {
  if (
    !targetDb ||
    !tableExists(targetDb, 'assets') ||
    !tableExists(targetDb, 'projects') ||
    !tableExists(targetDb, 'fleet_bills') ||
    !tableExists(targetDb, 'fleet_rental_rates')
  ) {
    return { skipped: true };
  }

  // Lazy-require billing modules inside execution to avoid circular require when invoked from db/index.js
  const breakdowns = require('../lib/billing/breakdowns');
  const fuelTimeline = require('../lib/billing/fuel_timeline');
  const siteSummary = require('../lib/billing/site_summary');
  const calc = require('../lib/billing/calc');

  const period = breakdowns.monthBounds(String(periodKey || '2026-11').trim().slice(0, 7));
  if (!period) {
    throw new Error(`Invalid periodKey: ${periodKey}`);
  }

  // Skip cleanly on empty schema-only test databases
  const winStart = fuelTimeline.addDays(period.start, -1);
  const winEnd = `${fuelTimeline.addDays(period.end, 1)} 23:59:59`;
  const hasExistingBills = Number(
    targetDb.prepare("SELECT COUNT(*) AS c FROM fleet_bills WHERE period_key = ? AND status != 'VOID'").get(period.periodKey).c || 0
  );
  const hasPeriodFuel = tableExists(targetDb, 'fuel_issues')
    ? Number(
        targetDb.prepare(
          'SELECT COUNT(*) AS c FROM fuel_issues WHERE COALESCE(is_voided,0) = 0 AND issue_date >= ? AND issue_date <= ?'
        ).get(winStart, winEnd).c || 0
      )
    : 0;
  const hasAllocs = tableExists(targetDb, 'fleet_vehicle_allocations')
    ? Number(targetDb.prepare('SELECT COUNT(*) AS c FROM fleet_vehicle_allocations WHERE COALESCE(active,1) = 1').get().c || 0)
    : 0;
  const hasOpenAssigns = tableExists(targetDb, 'fleet_asset_assignments')
    ? Number(targetDb.prepare('SELECT COUNT(*) AS c FROM fleet_asset_assignments WHERE end_date IS NULL').get().c || 0)
    : 0;

  if (!hasExistingBills && !hasPeriodFuel && !hasAllocs && !hasOpenAssigns) {
    return {
      periodKey: period.periodKey,
      billsVoided: 0,
      revEventsCleared: 0,
      carryForwardAllocsCreated: 0,
      draftsCreated: 0,
      sitesBilled: [],
      skippedFullBreakdowns: 0,
      skippedUnrated: 0,
    };
  }

  let billsVoided = 0;
  let revEventsCleared = 0;
  let carryForwardAllocsCreated = 0;
  const fueledSites = new Set();

  const codedProjects = targetDb.prepare(`
    SELECT id, code, name
      FROM projects
     WHERE code IS NOT NULL
       AND TRIM(code) != ''
       AND UPPER(TRIM(code)) != 'TEST'
     ORDER BY name ASC
  `).all();
  const codedProjById = new Map(codedProjects.map((p) => [Number(p.id), p]));

  targetDb.transaction(() => {
    // Phase 1: Void stale non-VOID bills for periodKey & clear their revenue events
    const staleBills = targetDb.prepare(
      "SELECT id, notes FROM fleet_bills WHERE period_key = ? AND status != 'VOID' AND id NOT LIKE ?"
    ).all(period.periodKey, `bill-draft-${period.periodKey}-%`);

    if (staleBills.length > 0) {
      const updBill = targetDb.prepare(
        "UPDATE fleet_bills SET status = 'VOID', notes = ?, updated_at = datetime('now') WHERE id = ?"
      );
      const delFin = tableExists(targetDb, 'fleet_financial_events')
        ? targetDb.prepare("DELETE FROM fleet_financial_events WHERE source_table = 'fleet_bills' AND source_id = ?")
        : null;

      for (const b of staleBills) {
        const curNote = String(b.notes || '').trim();
        const tag = `Voided: replaced by clean zero-double-billing site DRAFT bills (Migration 075)`;
        const nextNote = curNote.includes('Migration 075') ? curNote : (curNote ? `${curNote} | ${tag}` : tag);
        updBill.run(nextNote, b.id);
        billsVoided++;
        if (delFin) {
          const info = delFin.run(b.id);
          revEventsCleared += info.changes || 0;
        }
      }
    }

    // Phase 2: Identify fueled sites vs zero-fuel coded sites & upsert CARRY_FORWARD allocations
    const assetsList = targetDb.prepare('SELECT * FROM assets').all();
    const assetsMap = new Map(assetsList.map((a) => [a.id, a]));
    const rateSet = new Set(
      targetDb.prepare('SELECT DISTINCT asset_id FROM fleet_rental_rates WHERE asset_id IS NOT NULL').all().map((r) => r.asset_id)
    );

    const tankProjMap = new Map();
    if (tableExists(targetDb, 'fuel_tanks')) {
      for (const t of targetDb.prepare('SELECT id, project_id FROM fuel_tanks').all()) {
        tankProjMap.set(String(t.id), t.project_id != null ? Number(t.project_id) : null);
      }
    }

    const fueledAssetIds = new Set();
    if (tableExists(targetDb, 'fuel_issues')) {
      const fiCols = getColSet(targetDb, 'fuel_issues');
      const voidExpr = fiCols.has('voided')
        ? 'COALESCE(is_voided, 0) = 0 AND COALESCE(voided, 0) = 0'
        : 'COALESCE(is_voided, 0) = 0';
      const periodIssues = targetDb.prepare(
        `SELECT * FROM fuel_issues WHERE ${voidExpr} AND issue_date >= ? AND issue_date <= ? ORDER BY issue_date ASC, id ASC`
      ).all(winStart, winEnd);

      for (const fi of periodIssues) {
        const day = fuelTimeline.slstDate10(fi.issue_date);
        if (!day || day < period.start || day > period.end) continue;
        const asset = fi.asset_id ? assetsMap.get(fi.asset_id) : null;
        if (fuelTimeline.isNonMachineFuelRow(fi, asset)) continue;
        if (asset && fuelTimeline.isHiredAsset(asset)) continue;
        if (Number(fi.is_direct_billed) === 1) continue;

        const pid = fuelTimeline.resolveIssueProjectId(fi, tankProjMap);
        if (pid && codedProjById.has(pid)) {
          fueledSites.add(pid);
        }
        if (fi.asset_id) {
          fueledAssetIds.add(fi.asset_id);
        }
      }
    }

    if (tableExists(targetDb, 'fleet_vehicle_allocations') && codedProjects.length > 0) {
      const fvaCols = getColSet(targetDb, 'fleet_vehicle_allocations');
      const hasOrigin = fvaCols.has('origin');
      const hasLocked = fvaCols.has('locked');

      const allAllocs = targetDb.prepare(`
        SELECT asset_id, project_id, basis, driver_name, month,
               ${hasOrigin ? "COALESCE(origin, 'MANUAL')" : "'MANUAL'"} AS origin,
               ${hasLocked ? 'COALESCE(locked, 0)' : '0'} AS locked
          FROM fleet_vehicle_allocations
         WHERE asset_id IS NOT NULL
           AND project_id IS NOT NULL
           AND COALESCE(active, 1) = 1
           AND month <= ?
         ORDER BY month DESC, ${fvaCols.has('is_current') ? 'COALESCE(is_current, 0) DESC,' : ''} id DESC
      `).all(period.periodKey);

      const manualLockedInPeriod = new Set();
      const latestCodedAllocByAsset = new Map();
      for (const r of allAllocs) {
        const pid = Number(r.project_id);
        if (!codedProjById.has(pid)) continue;
        if (
          r.month === period.periodKey &&
          (String(r.origin || '').toUpperCase() === 'MANUAL' || Number(r.locked) === 1)
        ) {
          manualLockedInPeriod.add(r.asset_id);
        }
        if (!latestCodedAllocByAsset.has(r.asset_id)) {
          const basisUp = String(r.basis || '').toUpperCase();
          if (basisUp !== 'BILLED_DIRECT' && basisUp !== 'FREE_OF_CHARGE') {
            latestCodedAllocByAsset.set(r.asset_id, {
              projectId: pid,
              driverName: r.driver_name || null,
            });
          }
        }
      }

      const latestOpenAssignByAsset = new Map();
      const activeManualAssignAssets = new Set();
      if (tableExists(targetDb, 'fleet_asset_assignments')) {
        const asgCols = getColSet(targetDb, 'fleet_asset_assignments');
        const hasAsgOrigin = asgCols.has('origin');
        const openAssigns = targetDb.prepare(`
          SELECT asset_id, project_id, billing_type, driver_name,
                 ${hasAsgOrigin ? "COALESCE(origin, 'MANUAL')" : "'MANUAL'"} AS origin
            FROM fleet_asset_assignments
           WHERE asset_id IS NOT NULL
             AND project_id IS NOT NULL
             AND substr(start_date, 1, 10) <= ?
             AND (end_date IS NULL OR substr(end_date, 1, 10) >= ?)
           ORDER BY start_date DESC, id DESC
        `).all(period.end, period.start);
        for (const a of openAssigns) {
          const pid = Number(a.project_id);
          if (!codedProjById.has(pid)) continue;
          if (String(a.origin || '').toUpperCase() !== 'FUEL') {
            activeManualAssignAssets.add(a.asset_id);
          }
          if (latestOpenAssignByAsset.has(a.asset_id)) continue;
          const bUp = String(a.billing_type || '').toUpperCase();
          if (bUp !== 'BILLED_DIRECT' && bUp !== 'FREE_OF_CHARGE') {
            latestOpenAssignByAsset.set(a.asset_id, {
              projectId: pid,
              driverName: a.driver_name || null,
            });
          }
        }
      }

      const yearStart = `${period.year}-01-01`;
      const earlierFuelProjByAsset = new Map();
      if (tableExists(targetDb, 'fuel_issues')) {
        const priorIssues = targetDb.prepare(`
          SELECT asset_id, source_tank_id, bulk_tank_id, target_project_id, project_id, source_project_id, driver_name, issue_date
            FROM fuel_issues
           WHERE COALESCE(is_voided, 0) = 0
             AND asset_id IS NOT NULL
             AND issue_date >= ?
             AND issue_date < ?
           ORDER BY issue_date DESC, id DESC
        `).all(yearStart, period.start);
        for (const fi of priorIssues) {
          if (earlierFuelProjByAsset.has(fi.asset_id)) continue;
          const pid = fuelTimeline.resolveIssueProjectId(fi, tankProjMap);
          if (pid && codedProjById.has(pid)) {
            earlierFuelProjByAsset.set(fi.asset_id, {
              projectId: pid,
              driverName: fi.driver_name || null,
            });
          }
        }
      }

      const chkDedupe = targetDb.prepare('SELECT 1 FROM fleet_vehicle_allocations WHERE dedupe_key = ? LIMIT 1');

      const insertCols = ['id', 'dedupe_key', 'asset_id', 'vehicle_no', 'project_id', 'site_name', 'month', 'owner_code', 'basis', 'active'];
      if (fvaCols.has('month_from')) insertCols.push('month_from');
      if (fvaCols.has('month_to')) insertCols.push('month_to');
      if (fvaCols.has('date_from')) insertCols.push('date_from');
      if (fvaCols.has('date_to')) insertCols.push('date_to');
      if (fvaCols.has('is_current')) insertCols.push('is_current');
      if (fvaCols.has('driver_name')) insertCols.push('driver_name');
      if (fvaCols.has('machine_type')) insertCols.push('machine_type');
      if (fvaCols.has('origin')) insertCols.push('origin');
      if (fvaCols.has('locked')) insertCols.push('locked');
      if (fvaCols.has('notes')) insertCols.push('notes');

      const insAlloc = targetDb.prepare(
        `INSERT INTO fleet_vehicle_allocations (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`
      );

      for (const a of assetsList) {
        if (fueledAssetIds.has(a.id)) continue;
        if (manualLockedInPeriod.has(a.id)) continue;
        if (activeManualAssignAssets.has(a.id)) continue;
        if (!rateSet.has(a.id)) continue;
        if (['decommissioned', 'DISPOSED', 'scrapped'].includes(String(a.status || '').toLowerCase())) continue;
        if (fuelTimeline.isNonMachineFuelRow({}, a)) continue;
        if (fuelTimeline.isHiredAsset(a)) continue;

        const hint =
          latestCodedAllocByAsset.get(a.id) ||
          latestOpenAssignByAsset.get(a.id) ||
          earlierFuelProjByAsset.get(a.id) ||
          null;
        if (!hint) continue;
        if (fueledSites.has(hint.projectId)) continue;

        const proj = codedProjById.get(hint.projectId);
        if (!proj) continue;

        const dedupeKey = `CF-${period.periodKey}-${a.id}-${proj.id}`;
        if (chkDedupe.get(dedupeKey)) continue;

        const rowId = `va-cf-${period.periodKey}-${a.id}-${proj.id}`;
        const noteText = `Carried forward from latest confirmed site posting for ${period.periodKey} DRAFT billing (0 fuel uploaded yet)`;
        const vals = [rowId, dedupeKey, a.id, a.code || `A-${a.id}`, proj.id, proj.name, period.periodKey, 'E&C', 'WET', 1];
        if (fvaCols.has('month_from')) vals.push(period.periodKey);
        if (fvaCols.has('month_to')) vals.push(period.periodKey);
        if (fvaCols.has('date_from')) vals.push(period.start);
        if (fvaCols.has('date_to')) vals.push(null);
        if (fvaCols.has('is_current')) vals.push(1);
        if (fvaCols.has('driver_name')) vals.push(hint.driverName || null);
        if (fvaCols.has('machine_type')) vals.push(a.type || null);
        if (fvaCols.has('origin')) vals.push('CARRY_FORWARD');
        if (fvaCols.has('locked')) vals.push(0);
        if (fvaCols.has('notes')) vals.push(noteText);

        insAlloc.run(...vals);
        carryForwardAllocsCreated++;
      }
    }
  })();

  // Phase 3: Compute Site Summaries and insert clean DRAFT fleet_bills + fleet_bill_line_items
  let draftsCreated = 0;
  let skippedFullBreakdowns = 0;
  let skippedUnrated = 0;
  const sitesBilledMap = new Map();
  const pendingBills = [];

  for (const p of codedProjects) {
    const isFueledSite = fueledSites.has(p.id);
    const summary = siteSummary.buildSiteSummary(p.id, period.periodKey, {
      basisMode: 'SUMMARY_WET',
      fuelPolicy: 'ALL_SITE_PUMPS',
      includeZeroFuel: !isFueledSite,
    });

    for (const l of summary.lines) {
      if (l.existingBill) continue;
      if (l.daysHere === 0 && l.fuelCostCents === 0) {
        skippedFullBreakdowns++;
        continue;
      }
      if (l.rateCents == null || l.rateCents <= 0) {
        skippedUnrated++;
        continue;
      }

      const bdDeductCents = l.breakdownDeductCents || 0;
      const grossRentalCents = l.grossRentalCents != null ? l.grossRentalCents : (l.rentalCents + bdDeductCents);
      const subtotalCents = l.rentalCents + l.fuelCostCents;
      const ssclCents = Math.round(subtotalCents * summary.ssclRate);
      const vatCents = Math.round((subtotalCents + ssclCents) * summary.vatRate);
      const grandTotalCents = subtotalCents + ssclCents + vatCents;

      const actualUnits = l.actualUnits != null ? l.actualUnits : (l.consRefUnits || 0);
      const minimumUnits = bdDeductCents > 0 ? (l.grossMinimumUnits || l.minimumProrated) : l.minimumProrated;
      const billableUnits = bdDeductCents > 0 && l.billedOn === 'minimum'
        ? (l.grossMinimumUnits || l.billableUnits)
        : l.billableUnits;
      const rentalAmountCents = bdDeductCents > 0 ? grossRentalCents : l.rentalCents;

      const bdNote = l.breakdownDays > 0 ? `; ${l.breakdownDays}d BD excluded` : '';
      const zeroFuelNote = l.fuelLitres <= 0 ? '; 0 fuel uploaded yet' : '';
      const billId = `bill-draft-${period.periodKey}-p${p.id}-a${l.assetId}`;

      pendingBills.push({
        billId,
        project: p,
        line: l,
        summary,
        bdDeductCents,
        actualUnits,
        minimumUnits,
        billableUnits,
        rentalAmountCents,
        subtotalCents,
        ssclCents,
        vatCents,
        grandTotalCents,
        notes: `Site Summary DRAFT (${l.billedOn}${bdNote}${zeroFuelNote}) — ${p.name} (${period.periodKey})`,
      });
    }
  }

  if (pendingBills.length > 0) {
    const fbCols = getColSet(targetDb, 'fleet_bills');
    const hasDerived = fbCols.has('derived_from_fuel');
    const hasLineItems = tableExists(targetDb, 'fleet_bill_line_items');

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

    const insBill = targetDb.prepare(
      `INSERT OR IGNORE INTO fleet_bills (${billCols.join(', ')}) VALUES (${billCols.map(() => '?').join(', ')})`
    );
    const insItem = hasLineItems
      ? targetDb.prepare(`
          INSERT OR REPLACE INTO fleet_bill_line_items (
            id, bill_id, item_type, description, quantity, unit_price_cents, amount_cents, is_deduction
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
      : null;

    targetDb.transaction(() => {
      for (const item of pendingBills) {
        const { billId, project: p, line: l, summary: s } = item;
        const vals = [
          billId, null, period.year, period.month, period.periodKey, period.start, period.end,
          l.assetId, l.code, l.regNo || null, l.driverName || null, p.id, p.name, p.code,
          l.billingModeCode, l.rateBasis, Number(l.rateCents) || 0, null, null,
          item.actualUnits, item.minimumUnits, item.billableUnits, item.rentalAmountCents,
          l.fuelLitres, l.fuelCostCents, l.breakdownDays || 0, item.bdDeductCents,
          item.subtotalCents, s.ssclRate, item.ssclCents, s.vatRate, item.vatCents, item.grandTotalCents,
          'DRAFT', null, null, null, item.notes, actorId,
        ];
        if (hasDerived) vals.push(l.fuelLitres > 0 ? 1 : 0);

        const info = insBill.run(...vals);
        if (info.changes > 0) {
          draftsCreated++;
          sitesBilledMap.set(p.code, (sitesBilledMap.get(p.code) || 0) + 1);
          if (insItem) {
            insItem.run(
              `li-${billId}-rental`,
              billId,
              'RENTAL',
              `Machine Hire Rental (${item.billableUnits} ${String(l.rateBasis).toLowerCase()} · ${calc.basisLabel(l.billingModeCode)})`,
              item.billableUnits,
              Number(l.rateCents) || 0,
              item.rentalAmountCents,
              0
            );
            if (l.fuelCostCents > 0) {
              const fuelPriceCents = l.fuelLitres > 0 ? Math.round(l.fuelCostCents / l.fuelLitres) : 0;
              insItem.run(
                `li-${billId}-fuel`,
                billId,
                'FUEL',
                `Fuel Recharge (${l.fuelLitres} Litres @ Rs ${(fuelPriceCents / 100).toFixed(2)})`,
                l.fuelLitres,
                fuelPriceCents,
                l.fuelCostCents,
                0
              );
            }
            if (item.bdDeductCents > 0) {
              const bdDays = l.breakdownDays || 0;
              insItem.run(
                `li-${billId}-bd`,
                billId,
                'BREAKDOWN_DEDUCT',
                `Breakdown Deduction (${bdDays} days)`,
                bdDays,
                Math.round(item.bdDeductCents / Math.max(1, bdDays)),
                item.bdDeductCents,
                1
              );
            }
          }
        }
      }
    })();
  }

  return {
    periodKey: period.periodKey,
    billsVoided,
    revEventsCleared,
    carryForwardAllocsCreated,
    draftsCreated,
    sitesBilled: [...sitesBilledMap.entries()].map(([siteCode, count]) => ({ siteCode, count })),
    skippedFullBreakdowns,
    skippedUnrated,
  };
}

function runMigration(targetDb) {
  return prepareMonthSiteDrafts(targetDb, { periodKey: '2026-11', actorId: 1 });
}

module.exports = { runMigration, prepareMonthSiteDrafts };
