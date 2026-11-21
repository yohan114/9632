'use strict';

/**
 * Site Summary Bill Engine
 *
 * Computes the single-site (or all-sites) monthly SITE SUMMARY BILL matching the
 * E&C Heavy Equipment & Fleet Division statement format:
 *   - Pulls from all Projects & Project Sites in the Projects section (without hiding active=0 imported V2 sites)
 *   - Days posted to the site minus breakdown period days inside the stay:
 *       * Breakdown period = Rs 0 rental cost
 *       * Active working days before/outside breakdown = prorated minimum + actual meter/fuel work costed
 *   - Fuel physically issued from this site's own pumps during the machine's stay
 *   - Fallback inclusion of existing fleet_bills for sites without direct tank links
 *   - Actual work via Consumption Typ (fuel / L-per-unit) AND Coherent Meter Delta
 *   - Billable = max(meter, consTyp, minProrated(activeDays)), tagged: on fuel | on meter | on minimum | days on site
 *   - SSCL (2.5%) + VAT (18%) site rollup
 *   - Exclusions callouts: Zero Fuel Here, Direct Settled (hired), Breakdown Period Exclusions, Unrated, Transfers & Corrections Excluded
 */

const { get, all } = require('../../db');
const breakdowns = require('./breakdowns');

const MAX_PER_DAY = { KM: 1500, HOURS: 24 };
const DEFAULT_SSCL_RATE = 0.025;
const DEFAULT_VAT_RATE = 0.18;
const DEFAULT_WORKING_DAYS_PER_MONTH = 25;

const NON_MACHINE_CODE_RE = /^(TRANSFER|CORRECTION|LABORATORY|LAB|PUMP[-_ ]?ADJ|STOCK[-_ ]?ADJ)[-_ ]/i;
const NON_MACHINE_TEXT_RE = /\b(not a machine|transferred out|pump correction|stock adjustment|laboratory work)\b/i;
const HIRED_DIRECT_TEXT_RE = /\(hired\)|ownership:\s*hired|\b(billed[_ ]?direct|settled direct)\b/i;
const PORTABLE_CODE_RE = /^(WG|GE|WP|CP|CV|RM|PP|LT)-/i;

function addIsoDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function clampDate(d, minD, maxD) {
  if (!d) return null;
  const s = String(d).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  if (s < minD) return minD;
  if (s > maxD) return maxD;
  return s;
}

function mergeDateIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const merged = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = merged[merged.length - 1];
    const nextDayAfterPrev = addIsoDays(prev.end, 1);
    if (cur.start <= nextDayAfterPrev) {
      if (cur.end > prev.end) prev.end = cur.end;
    } else {
      merged.push({ start: cur.start, end: cur.end });
    }
  }
  return merged;
}

/**
 * Subtract merged `excludeIntervals` from merged `stayIntervals`.
 * Used so only the breakdown days get zeroed out while active days before/after remain intact.
 */
function subtractDateIntervals(stayIntervals, excludeIntervals) {
  if (!stayIntervals.length || !excludeIntervals.length) return [...stayIntervals];
  let current = stayIntervals.map((x) => ({ start: x.start, end: x.end }));
  for (const ex of excludeIntervals) {
    const next = [];
    for (const seg of current) {
      if (ex.end < seg.start || ex.start > seg.end) {
        next.push(seg);
        continue;
      }
      if (ex.start > seg.start) {
        const beforeEnd = addIsoDays(ex.start, -1);
        if (beforeEnd >= seg.start) next.push({ start: seg.start, end: beforeEnd });
      }
      if (ex.end < seg.end) {
        const afterStart = addIsoDays(ex.end, 1);
        if (afterStart <= seg.end) next.push({ start: afterStart, end: seg.end });
      }
    }
    current = next;
  }
  return current;
}

function intersectDateIntervals(intervalsA, intervalsB) {
  if (!intervalsA.length || !intervalsB.length) return [];
  const out = [];
  for (const a of intervalsA) {
    for (const b of intervalsB) {
      const s = a.start > b.start ? a.start : b.start;
      const e = a.end < b.end ? a.end : b.end;
      if (s <= e) out.push({ start: s, end: e });
    }
  }
  return mergeDateIntervals(out);
}

function daysInIntervals(intervals) {
  return intervals.reduce((sum, seg) => sum + breakdowns.daysBetweenInclusive(seg.start, seg.end), 0);
}

function dateInIntervals(dateStr, intervals) {
  const d = String(dateStr || '').trim().slice(0, 10);
  if (!d) return false;
  return intervals.some((seg) => d >= seg.start && d <= seg.end);
}

function fmtShortDay(iso) {
  if (!iso || iso.length < 10) return iso || '';
  const mNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return `${d} ${mNames[m - 1] || iso.slice(5, 7)}`;
}

function formatIntervalSpans(intervals) {
  return (intervals || []).map((seg) => (seg.start === seg.end
    ? fmtShortDay(seg.start)
    : `${fmtShortDay(seg.start)}–${fmtShortDay(seg.end)}`)).join(', ');
}

function currentMonthKey() {
  return breakdowns.todayStr().slice(0, 7);
}

/**
 * Coherent forward-step meter delta across chronologically ordered readings.
 * Rejects impossible negative drops or single-day keying spikes (> 24 hr/d or 1500 km/d).
 * Returns null if fewer than 2 readings or no accepted positive step survives.
 */
function coherentMeterDelta(readings, meterType) {
  if (!Array.isArray(readings) || readings.length < 2) return null;
  const perDay = MAX_PER_DAY[String(meterType || '').toUpperCase()] || MAX_PER_DAY.HOURS;

  const normalized = readings
    .map((r) => ({
      value: Number(r.value),
      ts: Date.parse(String(r.date).length === 10 ? `${r.date}T12:00:00Z` : String(r.date).replace(' ', 'T') + (String(r.date).includes('Z') || String(r.date).includes('+') ? '' : 'Z')),
    }))
    .filter((r) => Number.isFinite(r.value) && r.value > 0 && Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);

  if (normalized.length < 2) return null;

  let total = 0;
  let accepted = 0;
  for (let i = 1; i < normalized.length; i++) {
    const step = normalized[i].value - normalized[i - 1].value;
    if (step < 0) continue;
    if (step === 0 && normalized[i].ts === normalized[i - 1].ts) continue;
    const spanDays = Math.max(1, (normalized[i].ts - normalized[i - 1].ts) / 86400000);
    if (step > perDay * spanDays) continue;
    total += step;
    accepted++;
  }

  return accepted > 0 ? Math.round(total * 100) / 100 : null;
}

function isTransferOrAdjustmentIssue(issue, asset) {
  const code = String((asset && (asset.code || asset.ec_code)) || issue.asset_code || issue.vehicle_ref || '').trim();
  const text = `${(asset && asset.type) || ''} ${(asset && asset.notes) || ''} ${issue.notes || ''}`;
  if (NON_MACHINE_CODE_RE.test(code)) return true;
  if (NON_MACHINE_TEXT_RE.test(text)) return true;
  if (Number(issue.litres) < 0) return true;
  return false;
}

function isBilledDirectAsset(asset, allocBasesSet) {
  if (allocBasesSet && (allocBasesSet.has('BILLED_DIRECT') || allocBasesSet.has('FREE_OF_CHARGE'))) return true;
  if (!asset) return false;
  const text = `${asset.type || ''} ${asset.notes || ''} ${asset.category || ''}`;
  return HIRED_DIRECT_TEXT_RE.test(text);
}

function resolveModeForAsset(asset, rateCard) {
  const eq = String((rateCard && rateCard.equip_type) || '').toUpperCase();
  const cat = String((rateCard && rateCard.category_name) || (asset && (asset.category || asset.type)) || '').toUpperCase();
  const rb = String((rateCard && rateCard.rate_basis) || '').toUpperCase();
  const fcb = String((rateCard && rateCard.fuel_cons_basis) || '').toLowerCase();
  const mt = String((asset && asset.meter_type) || '').toUpperCase();
  const code = String((asset && (asset.code || asset.ec_code)) || '');

  if (eq === 'PORTABLE' || cat === 'PORTABLE' || rb === 'DAILY' || (!rateCard && PORTABLE_CODE_RE.test(code))) {
    return 'perday';
  }
  if (rb === 'KM' || fcb === 'km' || (!rateCard && mt === 'KM')) {
    return 'perkm';
  }
  if (PORTABLE_CODE_RE.test(code) && !(rateCard && (rateCard.dry_rate_cents || rateCard.wet_rate_cents || rateCard.hr_wet_cents || rateCard.hr_dry_cents))) {
    return 'perday';
  }
  return 'hourly';
}

function resolveHireBasis(basisMode, allocBasisList) {
  const req = String(basisMode || 'SUMMARY_WET').trim().toUpperCase();
  if (req === 'DRY' || req === 'DRY_WITH_DRIVER' || req === 'D') return 'd';
  if (req === 'WET' || req === 'W') return 'w';
  if (req === 'FULLY_WET' || req === 'FW') return 'fw';

  const primary = String((allocBasisList && allocBasisList[0]) || '').toUpperCase();
  if (req === 'ALLOCATION') {
    if (primary === 'FULLY_WET' || primary === 'FW') return 'fw';
    if (primary === 'WET' || primary === 'W') return 'w';
    return 'd';
  }

  if (primary === 'FULLY_WET' || primary === 'FW') return 'fw';
  return 'w';
}

function pickRateCentsForSummary(rateCard, mode, hireBasis, fallbackDailyCents = null) {
  if (!rateCard) return fallbackDailyCents || null;
  const pickPositive = (...vals) => {
    for (const v of vals) {
      if (v != null && Number(v) > 0) return Math.round(Number(v));
    }
    return null;
  };

  if (mode === 'perkm') {
    if (hireBasis === 'fw') return pickPositive(rateCard.km_fw_cents, rateCard.fully_wet_rate_cents, rateCard.km_wet_cents, rateCard.wet_rate_cents, rateCard.km_dry_cents, rateCard.dry_rate_cents, rateCard.rate_cents);
    if (hireBasis === 'd') return pickPositive(rateCard.km_dry_cents, rateCard.dry_rate_cents, rateCard.rate_cents, rateCard.km_wet_cents, rateCard.wet_rate_cents);
    return pickPositive(rateCard.km_wet_cents, rateCard.wet_rate_cents, rateCard.km_dry_cents, rateCard.dry_rate_cents, rateCard.rate_cents);
  }

  if (mode === 'perday') {
    const picked = hireBasis === 'd'
      ? pickPositive(rateCard.port_dd_cents, rateCard.dy_dry_cents, rateCard.dry_rate_cents, rateCard.rate_cents, rateCard.port_dw_cents, rateCard.dy_wet_cents, rateCard.wet_rate_cents)
      : hireBasis === 'fw'
        ? pickPositive(rateCard.dy_fw_cents, rateCard.fully_wet_rate_cents, rateCard.port_dw_cents, rateCard.dy_wet_cents, rateCard.wet_rate_cents, rateCard.port_dd_cents, rateCard.dry_rate_cents)
        : pickPositive(rateCard.port_dw_cents, rateCard.dy_wet_cents, rateCard.wet_rate_cents, rateCard.port_dd_cents, rateCard.dy_dry_cents, rateCard.dry_rate_cents, rateCard.rate_cents);
    return picked || fallbackDailyCents || null;
  }

  if (hireBasis === 'fw') return pickPositive(rateCard.hr_fw_cents, rateCard.fully_wet_rate_cents, rateCard.hr_wet_cents, rateCard.wet_rate_cents, rateCard.hr_dry_cents, rateCard.dry_rate_cents, rateCard.rate_cents);
  if (hireBasis === 'd') return pickPositive(rateCard.hr_dry_cents, rateCard.dry_rate_cents, rateCard.rate_cents, rateCard.hr_wet_cents, rateCard.wet_rate_cents);
  return pickPositive(rateCard.hr_wet_cents, rateCard.wet_rate_cents, rateCard.hr_dry_cents, rateCard.dry_rate_cents, rateCard.rate_cents);
}

function resolveProject(projectIdOrCode) {
  if (projectIdOrCode == null || projectIdOrCode === '' || String(projectIdOrCode).toUpperCase() === 'ALL') {
    return null;
  }
  const s = String(projectIdOrCode).trim();
  if (/^\d+$/.test(s)) {
    return get('SELECT * FROM projects WHERE id = ?', Number(s));
  }
  return get(
    'SELECT * FROM projects WHERE UPPER(TRIM(code)) = UPPER(?) OR UPPER(TRIM(name)) = UPPER(?) LIMIT 1',
    s,
    s
  );
}

function readTaxRatesFromSettings() {
  const map = {};
  try {
    for (const r of all("SELECT key, value FROM settings WHERE key IN ('billing.ssclRate', 'billing.vatRate', 'billing_sscl_rate', 'billing_vat_rate')")) {
      map[r.key] = parseFloat(r.value);
    }
  } catch (_) {}
  const sscl = Number.isFinite(map['billing.ssclRate']) ? map['billing.ssclRate'] : (Number.isFinite(map.billing_sscl_rate) ? map.billing_sscl_rate : DEFAULT_SSCL_RATE);
  const vat = Number.isFinite(map['billing.vatRate']) ? map['billing.vatRate'] : (Number.isFinite(map.billing_vat_rate) ? map.billing_vat_rate : DEFAULT_VAT_RATE);
  return { ssclRate: sscl, vatRate: vat };
}

/**
 * Full Projects & Project Sites catalog (matches the #/projects section without
 * hiding imported V2 operational sites that carry active = 0).
 */
function listSitesCatalog() {
  const projRows = all(`
    SELECT p.id, p.code, p.name, p.location, p.active,
           (SELECT COUNT(*) FROM fuel_tanks ft WHERE ft.project_id = p.id) AS tank_count,
           (SELECT COUNT(*) FROM fleet_vehicle_allocations va WHERE va.project_id = p.id AND COALESCE(va.active,1) = 1) AS alloc_count,
           (SELECT COUNT(*) FROM fleet_asset_assignments fa WHERE fa.project_id = p.id) AS assign_count,
           (SELECT COUNT(*) FROM fleet_bills fb WHERE fb.project_id = p.id AND fb.status != 'VOID') AS bill_count,
           (SELECT COUNT(*) FROM assets a WHERE a.current_project_id = p.id AND COALESCE(a.status,'active') NOT IN ('decommissioned','DISPOSED')) AS asset_count
      FROM projects p
     ORDER BY p.name ASC
  `);

  const siteRows = all(`
    SELECT s.id, s.project_id, s.name, p.code AS project_code, p.name AS project_name,
           (SELECT COUNT(*) FROM assets a WHERE a.current_site_id = s.id) AS asset_count
      FROM sites s
      JOIN projects p ON p.id = s.project_id
     ORDER BY p.name ASC, s.name ASC
  `);

  const monthRows = all(`
    SELECT m AS ym FROM (
      SELECT DISTINCT substr(issue_date, 1, 7) AS m FROM fuel_issues WHERE is_voided = 0 AND issue_date IS NOT NULL
      UNION
      SELECT DISTINCT period_key AS m FROM fleet_bills WHERE status != 'VOID' AND period_key IS NOT NULL
      UNION
      SELECT DISTINCT month AS m FROM fleet_vehicle_allocations WHERE COALESCE(active,1) = 1 AND month IS NOT NULL
    )
    WHERE length(m) = 7
    ORDER BY m DESC
    LIMIT 36
  `);

  const projects = projRows.map((p) => {
    const hasBillingData = (p.tank_count + p.alloc_count + p.assign_count + p.bill_count) > 0;
    return {
      ...p,
      hasBillingData,
      hasAnyData: hasBillingData || p.asset_count > 0 || p.active !== 0,
      sites: siteRows.filter((s) => s.project_id === p.id),
    };
  });

  // Sort operational / active sites first cleanly while preserving alphabetical order
  projects.sort((a, b) => {
    const scoreA = (a.hasBillingData ? 2 : (a.active !== 0 ? 1 : 0));
    const scoreB = (b.hasBillingData ? 2 : (b.active !== 0 ? 1 : 0));
    if (scoreA !== scoreB) return scoreB - scoreA;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  return {
    projects,
    sites: siteRows,
    availableMonths: monthRows.map((r) => r.ym),
  };
}

/**
 * Preload breakdown intervals per asset overlapping [periodStart .. periodEnd].
 * Breakdown days inside [periodStart .. periodEnd]:
 *   - CLOSED: [breakdown_start .. breakdown_end]
 *   - OPEN:   [breakdown_start .. periodEnd] (so work BEFORE breakdown_start stays billable!)
 */
function buildBreakdownMapForMonth(bounds, allUnifiedRecords = null) {
  const records = allUnifiedRecords || breakdowns.buildUnifiedRecords({ scopeMode: 'all' });
  const byAsset = new Map(); // assetId -> [{ start, end, isOpen, reason }]

  for (const r of records) {
    if (!r.asset_id || r.status === 'WAIVED') continue;
    const rawStart = breakdowns.d10(r.breakdown_start);
    if (!rawStart || rawStart > bounds.end) continue;
    const rawEnd = r.is_open ? bounds.end : (breakdowns.d10(r.breakdown_end) || rawStart);
    if (rawEnd < bounds.start) continue;

    const s = rawStart < bounds.start ? bounds.start : rawStart;
    const e = rawEnd > bounds.end ? bounds.end : rawEnd;
    if (e < s) continue;

    if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, []);
    byAsset.get(r.asset_id).push({
      start: s,
      end: e,
      isOpen: !!r.is_open,
      reason: r.reason || 'Breakdown',
      ref: r.job_no || r.jr_no || r.id,
    });
  }
  return byAsset;
}

function buildSiteSummary(projectIdOrCode, periodKey, options = {}) {
  const bounds = breakdowns.monthBounds(String(periodKey || currentMonthKey()).trim().slice(0, 7));
  if (!bounds) {
    const err = new Error('Valid month (YYYY-MM) is required');
    err.status = 400;
    throw err;
  }

  let subSite = null;
  if (options.siteId) {
    subSite = get('SELECT * FROM sites WHERE id = ?', Number(options.siteId));
  }

  let project = resolveProject(projectIdOrCode);
  if (!project && subSite) {
    project = resolveProject(subSite.project_id);
  }
  if (!project) {
    const err = new Error(`Site / project '${projectIdOrCode}' not found`);
    err.status = 404;
    throw err;
  }

  const effDaysInMonth = Math.max(1, Math.min(31, Number(options.effectiveDaysInMonth) || bounds.daysInMonth));
  const workingDaysInMonth = Math.max(1, Math.min(31, Number(options.workingDaysInMonth) || DEFAULT_WORKING_DAYS_PER_MONTH));
  const includeZeroFuel = Boolean(options.includeZeroFuel);
  const basisMode = options.basisMode || options.basis || 'SUMMARY_WET';
  const fuelPolicy = String(options.fuelPolicy || 'ALL_SITE_PUMPS').toUpperCase();
  const minHoursDefault = options.minHours != null ? Number(options.minHours) : 120;
  const minKmDefault = options.minKm != null ? Number(options.minKm) : 3000;
  const minDaysDefault = options.minDays != null ? Number(options.minDays) : workingDaysInMonth;

  const { ssclRate, vatRate } = readTaxRatesFromSettings();

  // Tank -> Project lookup (covers site-owned tanks AND Central/unlinked bowsers via target_project_id)
  const tankProjectById = new Map();
  const siteTanks = [];
  for (const t of all('SELECT id, code, name, project_id FROM fuel_tanks')) {
    tankProjectById.set(String(t.id), t.project_id != null ? Number(t.project_id) : null);
    if (Number(t.project_id) === project.id) siteTanks.push(t);
  }
  const siteTankIds = new Set(siteTanks.map((t) => String(t.id)));

  // Collect all posted intervals per asset at this site overlapping [bounds.start .. bounds.end]
  const stayMap = new Map();
  const addStay = (assetId, rawStart, rawEnd, basis, driverName, siteName) => {
    if (!assetId) return;
    const s = clampDate(rawStart || bounds.start, bounds.start, bounds.end) || bounds.start;
    const e = clampDate(rawEnd || bounds.end, bounds.start, bounds.end) || bounds.end;
    if (e < s) return;
    const cur = stayMap.get(assetId) || { assetId, intervals: [], allocBases: [], driverName: null, siteNames: [] };
    cur.intervals.push({ start: s, end: e });
    if (basis) cur.allocBases.push(String(basis).toUpperCase());
    if (driverName && !cur.driverName) cur.driverName = driverName;
    if (siteName) cur.siteNames.push(siteName);
    stayMap.set(assetId, cur);
  };

  const allocRows = all(`
    SELECT va.asset_id, va.basis, va.driver_name, va.is_current, va.site_name,
           COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') AS eff_from,
           COALESCE(va.date_to,
             CASE WHEN va.is_current = 1 THEN NULL
                  ELSE date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day') END) AS eff_to
      FROM fleet_vehicle_allocations va
     WHERE va.project_id = ?
       AND va.asset_id IS NOT NULL
       AND COALESCE(va.active, 1) = 1
       AND (
         va.month = ?
         OR (
           COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') <= ?
           AND (va.is_current = 1 OR COALESCE(va.date_to, date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day')) >= ?)
         )
       )
     ORDER BY va.is_current DESC, eff_from DESC
  `, project.id, bounds.periodKey, bounds.end, bounds.start);

  for (const r of allocRows) {
    addStay(r.asset_id, r.eff_from, r.is_current ? bounds.end : r.eff_to, r.basis, r.driver_name, r.site_name);
  }

  const assignRows = all(`
    SELECT fa.asset_id, fa.billing_type, fa.driver_name,
           substr(fa.start_date, 1, 10) AS eff_from,
           CASE WHEN fa.end_date IS NOT NULL THEN substr(fa.end_date, 1, 10) ELSE NULL END AS eff_to
      FROM fleet_asset_assignments fa
     WHERE fa.project_id = ?
       AND fa.asset_id IS NOT NULL
       AND substr(fa.start_date, 1, 10) <= ?
       AND (fa.end_date IS NULL OR substr(fa.end_date, 1, 10) >= ?)
     ORDER BY fa.start_date DESC
  `, project.id, bounds.end, bounds.start);

  for (const r of assignRows) {
    addStay(r.asset_id, r.eff_from, r.eff_to || bounds.end, r.billing_type, r.driver_name, null);
  }

  // Non-voided fuel issues in this month filtered to this site's pumps or direct target_project_id
  const monthIssues = options._preloadedMonthIssues || all(`
    SELECT fi.*
      FROM fuel_issues fi
     WHERE fi.is_voided = 0
       AND COALESCE(fi.voided, 0) = 0
       AND substr(fi.issue_date, 1, 10) BETWEEN ? AND ?
     ORDER BY fi.issue_date ASC
  `, bounds.start, bounds.end);

  const siteIssues = [];
  for (const fi of monthIssues) {
    const tankId = fi.bulk_tank_id || fi.source_tank_id;
    const tankProjId = tankId != null ? tankProjectById.get(String(tankId)) : null;
    const fromSiteTank = tankProjId === project.id || (tankId != null && siteTankIds.has(String(tankId)));
    const matchesProjectDirect = Number(fi.target_project_id || fi.project_id || 0) === project.id;
    const fromUnassignedTank = tankId == null || tankProjId == null;
    if (fromSiteTank || (fromUnassignedTank && matchesProjectDirect) || (siteTankIds.size === 0 && Number(fi.source_project_id || 0) === project.id)) {
      siteIssues.push(fi);
    }
  }

  const assetsMap = options._preloadedAssetsMap || new Map(all('SELECT * FROM assets').map((a) => [a.id, a]));
  const rateCards = options._preloadedRateCards || new Map(
    all('SELECT * FROM fleet_rental_rates WHERE asset_id IS NOT NULL').reduce((acc, rc) => {
      if (!acc.has(rc.asset_id)) acc.set(rc.asset_id, rc);
      return acc;
    }, new Map())
  );
  const perdayHistoryRates = options._preloadedPerdayRates || new Map(
    all("SELECT asset_id, rate_cents FROM fleet_bills WHERE asset_id IS NOT NULL AND billing_mode = 'perday' AND rate_cents > 0 AND status != 'VOID' ORDER BY period_key DESC")
      .reduce((acc, fb) => {
        if (!acc.has(fb.asset_id)) acc.set(fb.asset_id, fb.rate_cents);
        return acc;
      }, new Map())
  );

  const otherAssignedAssetSet = new Set(
    all(`
      SELECT DISTINCT asset_id FROM fleet_asset_assignments
       WHERE project_id != ? AND asset_id IS NOT NULL
         AND substr(start_date, 1, 10) <= ? AND (end_date IS NULL OR substr(end_date, 1, 10) >= ?)
      UNION
      SELECT DISTINCT asset_id FROM fleet_vehicle_allocations
       WHERE project_id != ? AND asset_id IS NOT NULL AND COALESCE(active, 1) = 1
         AND (month = ? OR (COALESCE(date_from, COALESCE(month_from, month) || '-01') <= ? AND (is_current = 1 OR COALESCE(date_to, date(COALESCE(month_to, month) || '-01', '+1 month', '-1 day')) >= ?)))
    `, project.id, bounds.end, bounds.start, project.id, bounds.periodKey, bounds.end, bounds.start)
      .map((r) => r.asset_id)
  );

  const transfersMap = new Map();
  const fuelByAsset = new Map();
  for (const fi of siteIssues) {
    const asset = fi.asset_id ? assetsMap.get(fi.asset_id) : null;
    if (isTransferOrAdjustmentIssue(fi, asset)) {
      const ref = String((asset && (asset.code || asset.ec_code)) || fi.asset_code || fi.vehicle_ref || 'ADJUSTMENT').trim();
      const desc = (asset && asset.type) || fi.notes || ref;
      const litres = Number(fi.litres) || 0;
      const priceCents = Number(fi.price_per_litre_cents || fi.fuel_price_cents || 0) || Math.round((Number(fi.unit_price) || 0) * 100);
      const amountCents = Number(fi.total_cost_cents || fi.cost_cents || 0) || Math.round(litres * priceCents);
      const cur = transfersMap.get(ref) || {
        ref,
        description: desc,
        litres: 0,
        amountCents: 0,
        issueCount: 0,
        issueDate: String(fi.issue_date).slice(0, 10),
      };
      cur.litres += litres;
      cur.amountCents += amountCents;
      cur.issueCount += 1;
      transfersMap.set(ref, cur);
      continue;
    }

    if (fi.asset_id) {
      if (!fuelByAsset.has(fi.asset_id)) fuelByAsset.set(fi.asset_id, []);
      fuelByAsset.get(fi.asset_id).push(fi);
      if (!stayMap.has(fi.asset_id)) {
        if (otherAssignedAssetSet.has(fi.asset_id)) {
          const d = String(fi.issue_date).slice(0, 10);
          addStay(fi.asset_id, d, d, null, fi.driver_name, null);
        } else {
          addStay(fi.asset_id, bounds.start, bounds.end, null, fi.driver_name, null);
        }
      }
    }
  }

  // Existing generated bills for this project & period
  const existingBills = all(
    "SELECT * FROM fleet_bills WHERE period_key = ? AND project_id = ? AND status != 'VOID' ORDER BY asset_code ASC",
    bounds.periodKey,
    project.id
  );
  const existingBillsByAsset = new Map();
  for (const b of existingBills) {
    if (b.asset_id && !existingBillsByAsset.has(b.asset_id)) existingBillsByAsset.set(b.asset_id, b);
  }

  // Include active stationed machines in current month (or when includeZeroFuel is set)
  if (bounds.periodKey === currentMonthKey() || includeZeroFuel) {
    for (const a of assetsMap.values()) {
      if (Number(a.current_project_id) === project.id && !['decommissioned', 'DISPOSED'].includes(String(a.status || '').toLowerCase())) {
        if (!stayMap.has(a.id) && !isTransferOrAdjustmentIssue({}, a)) {
          addStay(a.id, bounds.start, bounds.end, null, null, null);
        }
      }
    }
  }

  // Optional Project Site (`sites` table) filter
  if (subSite) {
    const targetName = String(subSite.name || '').trim().toLowerCase();
    for (const [assetId, stay] of [...stayMap.entries()]) {
      const a = assetsMap.get(assetId);
      const matchesSiteId = a && Number(a.current_site_id) === Number(subSite.id);
      const matchesSiteName = stay.siteNames.some((sn) => String(sn || '').trim().toLowerCase() === targetName);
      if (!matchesSiteId && !matchesSiteName) {
        stayMap.delete(assetId);
      }
    }
  }

  // Breakdown windows for the month (computed once per call or shared in bulk calls)
  const breakdownMap = options._preloadedBreakdownMap || buildBreakdownMapForMonth(bounds);

  // Preload meter readings inside the month
  const candidateIds = [...stayMap.keys()];
  const readingsByAsset = new Map();
  if (candidateIds.length > 0) {
    const placeholders = candidateIds.map(() => '?').join(',');
    const mRows = all(`
      SELECT asset_id, meter_reading, reading_date
        FROM fuel_meter_readings
       WHERE asset_id IN (${placeholders})
         AND meter_reading > 0
         AND substr(reading_date, 1, 10) BETWEEN ? AND ?
       ORDER BY reading_date ASC
    `, ...candidateIds, bounds.start, bounds.end);
    for (const r of mRows) {
      if (!readingsByAsset.has(r.asset_id)) readingsByAsset.set(r.asset_id, []);
      readingsByAsset.get(r.asset_id).push({ value: Number(r.meter_reading), date: r.reading_date });
    }
  }

  const lines = [];
  const noFuelHere = [];
  const billedDirect = [];
  const unrated = [];
  const breakdownAdjustments = [];
  const distinctFuelPrices = new Set();
  const handledAssetIds = new Set();

  for (const [assetId, stay] of stayMap.entries()) {
    const asset = assetsMap.get(assetId);
    if (!asset) continue;
    const code = asset.code || asset.ec_code || asset.registration || `A-${asset.id}`;
    if (isTransferOrAdjustmentIssue({}, asset)) continue;

    const mergedIntervals = mergeDateIntervals(stay.intervals);
    const postedDays = Math.min(effDaysInMonth, daysInIntervals(mergedIntervals));
    if (!postedDays) continue;

    const allocBasesSet = new Set(stay.allocBases);
    if (isBilledDirectAsset(asset, allocBasesSet)) {
      handledAssetIds.add(assetId);
      billedDirect.push(code);
      continue;
    }

    const assetSiteIssues = (fuelByAsset.get(assetId) || []).filter((fi) => dateInIntervals(fi.issue_date, mergedIntervals));
    const directIssueOnly = assetSiteIssues.length > 0 && assetSiteIssues.every((fi) => Number(fi.is_direct_billed) === 1);
    if (directIssueOnly) {
      handledAssetIds.add(assetId);
      billedDirect.push(code);
      continue;
    }

    const billableFuelIssues = assetSiteIssues.filter((fi) => Number(fi.is_direct_billed) !== 1);
    let fuelLitres = 0;
    let fuelCostCents = 0;
    for (const fi of billableFuelIssues) {
      const l = Number(fi.litres) || 0;
      const p = Number(fi.price_per_litre_cents || fi.fuel_price_cents || 0) || Math.round((Number(fi.unit_price) || 0) * 100);
      const c = Number(fi.total_cost_cents || fi.cost_cents || 0) || Math.round(l * p);
      fuelLitres += l;
      fuelCostCents += c;
      if (p > 0) distinctFuelPrices.add(p);
      else if (l > 0 && c > 0) distinctFuelPrices.add(Math.round(c / l));
    }
    fuelLitres = Math.round(fuelLitres * 100) / 100;
    fuelCostCents = Math.round(fuelCostCents);

    const existingBill = existingBillsByAsset.get(assetId) || null;
    if (fuelLitres <= 0 && !includeZeroFuel && !existingBill) {
      handledAssetIds.add(assetId);
      noFuelHere.push(code);
      continue;
    }
    handledAssetIds.add(assetId);

    // Compute exact breakdown period inside this site stay:
    //   breakdown period = 0 rental cost (deducted from 25 monthly working days & monthly minimum rental)
    //   active working period (before breakdown / outside breakdown) = costed
    const rawBdList = breakdownMap.get(assetId) || [];
    const bdMergedIntervals = mergeDateIntervals(
      rawBdList.map((r) => ({ start: r.start, end: r.end }))
    );
    const bdOverlapStayIntervals = intersectDateIntervals(mergedIntervals, bdMergedIntervals);
    const activeIntervals = subtractDateIntervals(mergedIntervals, bdOverlapStayIntervals);
    const activeDays = Math.min(effDaysInMonth, daysInIntervals(activeIntervals));
    const breakdownDaysInStay = Math.max(0, postedDays - activeDays);
    const stayWorkingDaysRaw = postedDays >= effDaysInMonth
      ? workingDaysInMonth
      : (workingDaysInMonth * (postedDays / effDaysInMonth));
    const stayWorkingDays = Math.round(stayWorkingDaysRaw * 100) / 100;
    const breakdownDaysDeducted = Math.min(stayWorkingDays, breakdownDaysInStay);
    const workingDaysHere = Math.max(0, Math.round((stayWorkingDays - breakdownDaysDeducted) * 100) / 100);
    const hasOpenBd = rawBdList.some((r) => r.isOpen && intersectDateIntervals(mergedIntervals, [{ start: r.start, end: r.end }]).length > 0);
    const bdSpans = breakdownDaysInStay > 0 ? formatIntervalSpans(bdOverlapStayIntervals) : null;

    const rateCard = rateCards.get(assetId) || null;
    const mode = resolveModeForAsset(asset, rateCard);
    const hireBasis = resolveHireBasis(basisMode, stay.allocBases);
    const rateCents = pickRateCentsForSummary(rateCard, mode, hireBasis, mode === 'perday' ? perdayHistoryRates.get(assetId) : null);
    if (rateCents == null) unrated.push(code);

    const unit = mode === 'perkm' ? 'km' : (mode === 'perday' ? 'days' : 'hr');
    const rateBasisCode = mode === 'perkm' ? 'KM' : (mode === 'perday' ? 'DAILY' : 'HOURLY');
    const billingModeCode = hireBasis === 'fw' ? 'FULLY_WET' : (hireBasis === 'w' ? 'WET' : 'DRY_WITH_DRIVER');

    // Prorate minimum guarantee over 25 working days/month, deducting breakdown days:
    //   Hourly: 120 hr / 25d = 4.8 hr deducted per breakdown day
    //   Per-KM: 3000 km / 25d = 120 km deducted per breakdown day
    const minimumFull = (rateCard && Number(rateCard.min_bill_hours) > 0)
      ? Number(rateCard.min_bill_hours)
      : (mode === 'perkm' ? minKmDefault : (mode === 'perday' ? effDaysInMonth : minHoursDefault));
    const grossMinUnits = mode === 'perday'
      ? postedDays
      : (minimumFull * (stayWorkingDays / workingDaysInMonth));
    const bdDeductUnits = mode === 'perday'
      ? breakdownDaysInStay
      : (minimumFull * (breakdownDaysDeducted / workingDaysInMonth));
    const rawMinProrated = activeDays === 0
      ? 0
      : (mode === 'perday'
          ? activeDays
          : Math.max(0, minimumFull * (workingDaysHere / workingDaysInMonth)));

    // Work performed during non-breakdown intervals (e.g., before breakdown started & after closed breakdown)
    const workIntervals = activeIntervals;
    let workFuelLitres = 0;
    for (const fi of billableFuelIssues) {
      if (dateInIntervals(fi.issue_date, workIntervals)) {
        workFuelLitres += Number(fi.litres) || 0;
      }
    }
    workFuelLitres = Math.round(workFuelLitres * 100) / 100;

    const consTypRate = (rateCard && Number(rateCard.fuel_cons_typ) > 0) ? Number(rateCard.fuel_cons_typ) : null;
    const consTypDisplay = consTypRate != null ? Math.round(consTypRate * 1000) / 1000 : null;
    const isMeterMode = mode === 'hourly' || mode === 'perkm';
    const rawConsRefUnits = (activeDays > 0 && isMeterMode && consTypRate && workFuelLitres > 0)
      ? (workFuelLitres / consTypRate)
      : null;

    const combinedReadings = [];
    if (activeDays > 0) {
      for (const mr of (readingsByAsset.get(assetId) || [])) {
        if (dateInIntervals(mr.date, workIntervals)) combinedReadings.push(mr);
      }
      for (const fi of billableFuelIssues) {
        if (Number(fi.meter_reading) > 0 && dateInIntervals(fi.issue_date, workIntervals)) {
          combinedReadings.push({ value: Number(fi.meter_reading), date: fi.issue_date });
        }
      }
    }
    const actualUnits = activeDays === 0
      ? 0
      : (mode === 'perday'
          ? activeDays
          : coherentMeterDelta(combinedReadings, asset.meter_type || (mode === 'perkm' ? 'KM' : 'HOURS')));

    let rawBillableUnits = activeDays === 0
      ? 0
      : Math.max(actualUnits != null ? actualUnits : 0, rawConsRefUnits != null ? rawConsRefUnits : 0, rawMinProrated);

    let billedOn = rawBillableUnits > rawMinProrated + 1e-9
      ? (actualUnits != null && Math.abs(rawBillableUnits - actualUnits) < 1e-6
          ? (mode === 'perday' ? 'days on site' : 'meter')
          : 'fuel')
      : (activeDays === 0 ? 'full breakdown' : 'minimum');

    let rentalCents = activeDays === 0 || rateCents == null ? 0 : Math.round(rawBillableUnits * rateCents);
    let breakdownDeductCents = 0;
    if (rateCents != null && breakdownDaysInStay > 0) {
      if (billedOn === 'minimum' || billedOn === 'full breakdown' || billedOn === 'days on site') {
        breakdownDeductCents = Math.round(bdDeductUnits * rateCents);
      }
    }
    let grossRentalCents = rentalCents + breakdownDeductCents;
    let fuelChargedCents = (fuelPolicy === 'BASIS_ONLY' && hireBasis === 'd') ? 0 : fuelCostCents;
    let effectiveActualUnits = actualUnits;
    let effectiveConsRef = rawConsRefUnits;
    let effectiveMinProrated = rawMinProrated;
    let effectiveGrossMin = grossMinUnits;
    let effectiveBdDeductUnits = bdDeductUnits;
    let effectiveRateCents = rateCents;

    // If no fuel activity occurred here but an existing fleet_bill exists (e.g. CEP-03 Project bills), reflect its figures
    if (fuelLitres <= 0 && existingBill) {
      const bdDedCol = Number(existingBill.breakdown_deduct_cents) || 0;
      const rawRentalCol = Number(existingBill.rental_amount_cents) || 0;
      const fuelC = Number(existingBill.fuel_cost_cents) || 0;
      rawBillableUnits = Number(existingBill.billable_units) || 0;
      effectiveActualUnits = existingBill.actual_units != null ? Number(existingBill.actual_units) : null;
      effectiveMinProrated = Number(existingBill.minimum_units) || rawMinProrated;
      effectiveGrossMin = effectiveMinProrated;
      effectiveBdDeductUnits = 0;
      effectiveRateCents = existingBill.rate_cents != null ? Number(existingBill.rate_cents) : rateCents;
      if (bdDedCol > 0 && existingBill.subtotal_cents != null && Number(existingBill.subtotal_cents) <= rawRentalCol + fuelC - bdDedCol + 1) {
        grossRentalCents = rawRentalCol;
        breakdownDeductCents = bdDedCol;
        rentalCents = Math.max(0, rawRentalCol - bdDedCol);
      } else {
        rentalCents = rawRentalCol;
        breakdownDeductCents = bdDedCol;
        grossRentalCents = rawRentalCol + bdDedCol;
      }
      fuelLitres = Number(existingBill.fuel_litres) || 0;
      fuelChargedCents = fuelC;
      billedOn = rawBillableUnits > effectiveMinProrated + 1e-6 ? 'meter' : 'minimum';
      if (effectiveRateCents != null && unrated.includes(code)) unrated.splice(unrated.indexOf(code), 1);
    }

    if (breakdownDaysInStay > 0) {
      breakdownAdjustments.push({
        assetId,
        code,
        postedDays,
        activeDays,
        stayWorkingDays,
        workingDaysHere,
        breakdownDays: breakdownDaysInStay,
        breakdownDaysDeducted,
        breakdownDeductUnits: Math.round(effectiveBdDeductUnits * 100) / 100,
        breakdownDeductCents,
        spans: bdSpans,
        isOpen: hasOpenBd,
      });
    }

    const lineTotalCents = rentalCents + fuelChargedCents;
    const regNo = asset.registration && asset.registration !== code ? asset.registration : null;

    lines.push({
      assetId,
      code,
      regNo,
      typeLabel: asset.type || null,
      billingMode: mode,
      rateBasis: rateBasisCode,
      hireBasis,
      billingModeCode,
      driverName: stay.driverName || null,
      unit,
      daysHere: activeDays,
      postedDays,
      daysInMonth: effDaysInMonth,
      workingDaysInMonth,
      stayWorkingDays,
      workingDaysHere,
      breakdownDaysDeducted,
      allocDateFrom: mergedIntervals[0].start,
      allocDateTo: mergedIntervals[mergedIntervals.length - 1].end,
      minimumFull: Math.round(minimumFull * 100) / 100,
      grossMinimumUnits: Math.round(effectiveGrossMin * 100) / 100,
      breakdownDeductUnits: Math.round(effectiveBdDeductUnits * 100) / 100,
      minimumProrated: Math.round(effectiveMinProrated * 100) / 100,
      consRefUnits: effectiveConsRef != null ? Math.round(effectiveConsRef * 100) / 100 : null,
      consTypRate: consTypDisplay,
      consTypRaw: consTypRate,
      actualUnits: effectiveActualUnits,
      billableUnits: Math.round(rawBillableUnits * 100) / 100,
      billedOn,
      rateCents: effectiveRateCents,
      grossRentalCents,
      breakdownDeductCents,
      rentalCents,
      fuelLitres,
      fuelCostCents: fuelChargedCents,
      fuelIssues: billableFuelIssues.length,
      lineTotalCents,
      breakdownDays: breakdownDaysInStay,
      breakdownSpans: bdSpans,
      hasOpenBreakdown: hasOpenBd,
      billingBlocked: false,
      blockReason: breakdownDaysInStay > 0 ? `${breakdownDaysInStay}d breakdown (${bdSpans}) excluded from rental` : null,
      existingBill,
    });
  }

  // Add any remaining existing fleet_bills for this project & period that weren't in stayMap (unless filtered to a sub-site)
  if (!subSite) {
    for (const b of existingBills) {
      if (b.asset_id && handledAssetIds.has(b.asset_id)) continue;
      const asset = b.asset_id ? assetsMap.get(b.asset_id) : null;
      const code = (asset && (asset.code || asset.ec_code)) || b.asset_code || `BILL-${b.id}`;
      const regNo = b.asset_reg_no || (asset && asset.registration !== code ? asset.registration : null);
      const bm = String(b.billing_mode || '').toLowerCase();
      const rb = String(b.rate_basis || 'HOURLY').toUpperCase();
      const mode = (bm === 'perday' || rb === 'DAILY') ? 'perday' : ((bm === 'perkm' || rb === 'KM') ? 'perkm' : 'hourly');
      const unit = mode === 'perkm' ? 'km' : (mode === 'perday' ? 'days' : 'hr');
      const rawRentalCol = Number(b.rental_amount_cents) || 0;
      const bdDedCol = Number(b.breakdown_deduct_cents) || 0;
      const fuelL = Number(b.fuel_litres) || 0;
      const fuelC = Number(b.fuel_cost_cents) || 0;
      let rentalAmt = rawRentalCol;
      let grossRental = rawRentalCol + bdDedCol;
      if (bdDedCol > 0 && b.subtotal_cents != null && Number(b.subtotal_cents) <= rawRentalCol + fuelC - bdDedCol + 1) {
        grossRental = rawRentalCol;
        rentalAmt = Math.max(0, rawRentalCol - bdDedCol);
      }
      const billUnits = Number(b.billable_units) || 0;
      const minUnits = Number(b.minimum_units) || 0;
      const actUnits = b.actual_units != null ? Number(b.actual_units) : null;
      const bdDays = Number(b.breakdown_days) || 0;
      const activeDays = Math.max(0, effDaysInMonth - bdDays);
      const workingDaysHereFallback = Math.max(0, workingDaysInMonth - Math.min(workingDaysInMonth, bdDays));
      if (fuelL > 0 && fuelC > 0) distinctFuelPrices.add(Math.round(fuelC / fuelL));

      lines.push({
        assetId: b.asset_id || null,
        code,
        regNo,
        typeLabel: asset ? asset.type : null,
        billingMode: mode,
        rateBasis: rb,
        hireBasis: b.rate_basis === 'd' ? 'd' : (b.rate_basis === 'fw' ? 'fw' : 'w'),
        billingModeCode: bm.toUpperCase() || 'WET',
        driverName: b.driver_name || null,
        unit,
        daysHere: activeDays,
        postedDays: effDaysInMonth,
        daysInMonth: effDaysInMonth,
        workingDaysInMonth,
        stayWorkingDays: workingDaysInMonth,
        workingDaysHere: workingDaysHereFallback,
        breakdownDaysDeducted: Math.min(workingDaysInMonth, bdDays),
        allocDateFrom: bounds.start,
        allocDateTo: bounds.end,
        minimumFull: minUnits,
        grossMinimumUnits: minUnits,
        breakdownDeductUnits: 0,
        minimumProrated: minUnits,
        consRefUnits: null,
        consTypRate: null,
        consTypRaw: null,
        actualUnits: actUnits,
        billableUnits: Math.round(billUnits * 100) / 100,
        billedOn: billUnits > minUnits + 1e-6 ? 'meter' : 'minimum',
        rateCents: b.rate_cents != null ? Number(b.rate_cents) : null,
        grossRentalCents: grossRental,
        breakdownDeductCents: bdDedCol,
        rentalCents: rentalAmt,
        fuelLitres: fuelL,
        fuelCostCents: fuelC,
        fuelIssues: 0,
        lineTotalCents: rentalAmt + fuelC,
        breakdownDays: bdDays,
        breakdownSpans: null,
        hasOpenBreakdown: false,
        billingBlocked: false,
        blockReason: null,
        existingBill: b,
      });
    }
  }

  lines.sort((a, b) => a.code.localeCompare(b.code));
  noFuelHere.sort((a, b) => a.localeCompare(b));
  billedDirect.sort((a, b) => a.localeCompare(b));
  unrated.sort((a, b) => a.localeCompare(b));
  breakdownAdjustments.sort((a, b) => a.code.localeCompare(b.code));

  const transfersExcluded = [...transfersMap.values()]
    .map((t) => ({ ...t, litres: Math.round(t.litres * 100) / 100, amountCents: Math.round(t.amountCents) }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
  const transfersExcludedLitres = Math.round(transfersExcluded.reduce((n, t) => n + t.litres, 0) * 100) / 100;
  const transfersExcludedCents = Math.round(transfersExcluded.reduce((n, t) => n + t.amountCents, 0));

  const grossRentalCents = lines.reduce((n, l) => n + (l.grossRentalCents != null ? l.grossRentalCents : l.rentalCents), 0);
  const breakdownDeductCents = lines.reduce((n, l) => n + (l.breakdownDeductCents || 0), 0);
  const rentalCents = lines.reduce((n, l) => n + l.rentalCents, 0);
  const fuelLitres = Math.round(lines.reduce((n, l) => n + l.fuelLitres, 0) * 100) / 100;
  const fuelCostCents = lines.reduce((n, l) => n + l.fuelCostCents, 0);
  const subtotalCents = rentalCents + fuelCostCents;
  const ssclCents = Math.round(subtotalCents * ssclRate);
  const vatLiableCents = subtotalCents + ssclCents;
  const vatCents = Math.round(vatLiableCents * vatRate);
  const grandTotalCents = vatLiableCents + vatCents;

  const billedCount = lines.filter((l) => !!l.existingBill).length;
  const finalCount = lines.filter((l) => l.existingBill && (l.existingBill.status === 'FINAL' || l.existingBill.status === 'PAID')).length;
  const statusLabel = lines.length > 0 && finalCount === lines.length ? 'FINAL' : 'DRAFT';

  const monthLabel = new Date(Date.UTC(bounds.year, bounds.month - 1, 15)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Colombo',
  });

  const displayName = subSite ? `${project.name} — ${subSite.name}` : (project.name || project.code || `Site ${project.id}`);

  return {
    projectId: project.id,
    siteId: subSite ? subSite.id : null,
    siteCode: project.code || String(project.id),
    siteName: displayName,
    periodKey: bounds.periodKey,
    year: bounds.year,
    month: bounds.month,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    monthLabel,
    daysInMonth: effDaysInMonth,
    workingDaysInMonth,
    calendarDaysInMonth: bounds.daysInMonth,
    status: statusLabel,
    billedCount,
    finalCount,
    basisMode,
    fuelPolicy,
    tanksCount: siteTanks.length,
    lines,
    grossRentalCents,
    breakdownDeductCents,
    rentalCents,
    fuelLitres,
    fuelCostCents,
    subtotalCents,
    fuelRateCents: fuelLitres > 0 ? Math.round(fuelCostCents / fuelLitres) : null,
    fuelRateBlended: distinctFuelPrices.size > 1,
    ssclRate,
    ssclCents,
    vatRate,
    vatLiableCents,
    vatCents,
    grandTotalCents,
    noFuelHere,
    billedDirect,
    unrated,
    breakdownAdjustments,
    transfersExcluded,
    transfersExcludedLitres,
    transfersExcludedCents,
  };
}

/**
 * Build summaries across ALL Projects in the Projects section (both active and V2 operational sites)
 * that have billable lines, pump fuel, generated bills, or excluded transfers for `periodKey`.
 */
function buildAllSiteSummaries(periodKey, options = {}) {
  const bounds = breakdowns.monthBounds(String(periodKey || currentMonthKey()).trim().slice(0, 7));
  if (!bounds) {
    const err = new Error('Valid month (YYYY-MM) is required');
    err.status = 400;
    throw err;
  }

  const projectRows = all("SELECT id, code, name, active FROM projects WHERE UPPER(COALESCE(TRIM(code), '')) != 'TEST' ORDER BY name ASC");
  const preloadedAssetsMap = new Map(all('SELECT * FROM assets').map((a) => [a.id, a]));
  const preloadedRateCards = new Map();
  for (const rc of all('SELECT * FROM fleet_rental_rates WHERE asset_id IS NOT NULL')) {
    if (!preloadedRateCards.has(rc.asset_id)) preloadedRateCards.set(rc.asset_id, rc);
  }
  const preloadedPerdayRates = new Map();
  for (const fb of all("SELECT asset_id, rate_cents FROM fleet_bills WHERE asset_id IS NOT NULL AND billing_mode = 'perday' AND rate_cents > 0 AND status != 'VOID' ORDER BY period_key DESC")) {
    if (!preloadedPerdayRates.has(fb.asset_id)) preloadedPerdayRates.set(fb.asset_id, fb.rate_cents);
  }
  const preloadedMonthIssues = all(`
    SELECT fi.*
      FROM fuel_issues fi
     WHERE fi.is_voided = 0
       AND COALESCE(fi.voided, 0) = 0
       AND substr(fi.issue_date, 1, 10) BETWEEN ? AND ?
     ORDER BY fi.issue_date ASC
  `, bounds.start, bounds.end);
  const preloadedBreakdownMap = buildBreakdownMapForMonth(bounds);

  const sharedOpts = {
    ...options,
    _preloadedAssetsMap: preloadedAssetsMap,
    _preloadedRateCards: preloadedRateCards,
    _preloadedPerdayRates: preloadedPerdayRates,
    _preloadedMonthIssues: preloadedMonthIssues,
    _preloadedBreakdownMap: preloadedBreakdownMap,
  };

  const summaries = [];
  for (const p of projectRows) {
    const s = buildSiteSummary(p.id, bounds.periodKey, sharedOpts);
    // Skip zero-detail sites from All-Sites summary so PDFs never contain blank pages
    if (s.lines.length === 0 && s.fuelLitres === 0 && s.transfersExcluded.length === 0) {
      continue;
    }
    summaries.push(s);
  }
  return summaries;
}

module.exports = {
  buildSiteSummary,
  buildAllSiteSummaries,
  listSitesCatalog,
  coherentMeterDelta,
  mergeDateIntervals,
  subtractDateIntervals,
  buildBreakdownMapForMonth,
};
