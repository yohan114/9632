'use strict';

/**
 * Fuel-Driven Site Costing Timeline & Auto-Allocation Engine
 *
 * Implements the unified rules linking fuel dispensing -> site costing -> monthly auto-allocation:
 *   1. Site attribution resolves tank's site first (`fuel_tanks.project_id`), then
 *      `target_project_id`, `project_id`, `source_project_id` (transfers/adjustments excluded).
 *   2. Calendar dates are extracted in Sri Lanka Standard Time (UTC+05:30).
 *   3. Zero double-billing: every day in a month is assigned to at most ONE site per vehicle.
 *   4. Single-site month: full month if first fuel is on/before Early-Month Cutoff Day
 *      (default Day 10) OR vehicle was at the same site in the prior month (or mode=ALWAYS_FULL);
 *      otherwise prorated from first fuel date through month end.
 *   5. Mid-month site changes: prior site ends on `D_change - 1`, new site starts on `D_change`,
 *      and every site keeps 100% of fuel dispensed at its own pumps.
 *   6. Auto-allocation (`origin='AUTO_FUEL'`): allocates vehicles for the month from fuel activity
 *      while filtering short transit refuels (`< autoAllocMinConsecutive` issues) and never
 *      overwriting `MANUAL` or `locked=1` allocations.
 */

const { get, all, run, tx } = require('../../db');
const audit = require('../audit');

const NON_MACHINE_CODE_RE = /^(TRANSFER|CORRECTION|LABORATORY|LAB|PUMP[-_ ]?ADJ|STOCK[-_ ]?ADJ)[-_ ]|^SITE[-_]|^(OTH-CEP03E|DATABASE CHANGING ERROR|ERROR CORRECTION|FIRE DRILL|GENERAL\s*\/\s*CLEANING)$/i;
const NON_MACHINE_TEXT_RE = /\b(not a machine|transferred out|pump correction|stock adjustment|laboratory work)\b/i;
const HIRED_ASSET_TEXT_RE = /\(hired\)|ownership:\s*hired|\b(billed[_ ]?direct|settled direct|billed[_ ]?outside|paid outside)\b/i;

function isHiredAsset(asset) {
  if (!asset) return false;
  if (String(asset.ownership || '').trim().toUpperCase() === 'HIRED') return true;
  const text = `${asset.type || ''} ${asset.notes || ''} ${asset.category || ''}`;
  return HIRED_ASSET_TEXT_RE.test(text);
}

const COSTING_OPTION_DEFAULTS = Object.freeze({
  earlyMonthCutoffDay: 10,
  workingDaysPerMonth: 25,
  autoAllocMinConsecutive: 2,
  singleSiteFullMonthMode: 'EARLY_CUTOFF', // 'EARLY_CUTOFF' | 'ALWAYS_FULL' | 'ACTUAL_FROM_FIRST_FUEL'
});

const ALLOWED_SINGLE_SITE_MODES = new Set([
  'EARLY_CUTOFF',
  'ALWAYS_FULL',
  'ACTUAL_FROM_FIRST_FUEL',
]);

function hasTable(name) {
  return Boolean(get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name));
}

function getColumnSet(table) {
  if (!hasTable(table)) return new Set();
  return new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name));
}

/**
 * Convert an ISO date or SQLite timestamp to a YYYY-MM-DD calendar date in SLST (+05:30).
 */
function slstDate10(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  let ms = NaN;
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    ms = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    const iso = s.includes('T') ? `${s}Z` : `${s.replace(' ', 'T')}Z`;
    ms = Date.parse(iso);
  }
  if (Number.isFinite(ms)) {
    return new Date(ms + 330 * 60000).toISOString().slice(0, 10);
  }
  const prefix = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(prefix) ? prefix : null;
}

function todaySlst() {
  return slstDate10(new Date().toISOString());
}

function currentMonthKey() {
  return todaySlst().slice(0, 7);
}

function addDays(isoDate, deltaDays) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(startDay, endDay) {
  if (!startDay || !endDay || endDay < startDay) return 0;
  const ms = Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 86400000) + 1;
}

function monthBounds(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  const periodKey = `${m[1]}-${m[2]}`;
  return {
    periodKey,
    year,
    month,
    daysInMonth,
    start: `${periodKey}-01`,
    end: `${periodKey}-${String(daysInMonth).padStart(2, '0')}`,
  };
}

function clampDate(d, minD, maxD) {
  if (!d) return null;
  const s = slstDate10(d);
  if (!s) return null;
  if (s < minD) return minD;
  if (s > maxD) return maxD;
  return s;
}

function mergeIntervals(intervals) {
  if (!intervals || !intervals.length) return [];
  const sorted = [...intervals]
    .map((x) => ({ start: x.start, end: x.end }))
    .filter((x) => x.start && x.end && x.end >= x.start)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  if (!sorted.length) return [];
  const out = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = out[out.length - 1];
    if (cur.start <= addDays(prev.end, 1)) {
      if (cur.end > prev.end) prev.end = cur.end;
    } else {
      out.push(cur);
    }
  }
  return out;
}

function fmtShortDay(iso) {
  if (!iso || iso.length < 10) return iso || '';
  const mNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return `${d} ${mNames[m - 1] || iso.slice(5, 7)}`;
}

function formatIntervalsLabel(intervals) {
  return mergeIntervals(intervals)
    .map((seg) => (seg.start === seg.end ? fmtShortDay(seg.start) : `${fmtShortDay(seg.start)}–${fmtShortDay(seg.end)}`))
    .join(', ');
}

function getCostingOptions() {
  const out = { ...COSTING_OPTION_DEFAULTS };
  if (!hasTable('settings')) return out;
  try {
    const rows = all(`
      SELECT key, value
        FROM settings
       WHERE key IN (
         'billing.earlyMonthCutoffDay',
         'billing.workingDaysPerMonth',
         'billing.autoAllocMinConsecutive',
         'billing.singleSiteFullMonthMode'
       )
    `);
    for (const r of rows) {
      if (r.key === 'billing.earlyMonthCutoffDay') {
        const v = parseInt(r.value, 10);
        if (Number.isFinite(v) && v >= 1 && v <= 28) out.earlyMonthCutoffDay = v;
      } else if (r.key === 'billing.workingDaysPerMonth') {
        const v = parseInt(r.value, 10);
        if (Number.isFinite(v) && v >= 1 && v <= 31) out.workingDaysPerMonth = v;
      } else if (r.key === 'billing.autoAllocMinConsecutive') {
        const v = parseInt(r.value, 10);
        if (Number.isFinite(v) && v >= 1 && v <= 10) out.autoAllocMinConsecutive = v;
      } else if (r.key === 'billing.singleSiteFullMonthMode') {
        const m = String(r.value || '').trim().toUpperCase();
        if (ALLOWED_SINGLE_SITE_MODES.has(m)) out.singleSiteFullMonthMode = m;
      }
    }
  } catch (_) {}
  return out;
}

function saveCostingOptions(partial = {}, actorId = null) {
  const cur = getCostingOptions();
  const next = { ...cur };

  if (partial.earlyMonthCutoffDay !== undefined) {
    const v = parseInt(partial.earlyMonthCutoffDay, 10);
    if (!Number.isFinite(v) || v < 1 || v > 28) {
      const err = new Error('Early-month cutoff day must be an integer between 1 and 28');
      err.status = 400;
      throw err;
    }
    next.earlyMonthCutoffDay = v;
  }
  if (partial.workingDaysPerMonth !== undefined) {
    const v = parseInt(partial.workingDaysPerMonth, 10);
    if (!Number.isFinite(v) || v < 1 || v > 31) {
      const err = new Error('Working days per month must be an integer between 1 and 31');
      err.status = 400;
      throw err;
    }
    next.workingDaysPerMonth = v;
  }
  if (partial.autoAllocMinConsecutive !== undefined) {
    const v = parseInt(partial.autoAllocMinConsecutive, 10);
    if (!Number.isFinite(v) || v < 1 || v > 10) {
      const err = new Error('Transit auto-allocation threshold must be an integer between 1 and 10');
      err.status = 400;
      throw err;
    }
    next.autoAllocMinConsecutive = v;
  }
  if (partial.singleSiteFullMonthMode !== undefined) {
    const m = String(partial.singleSiteFullMonthMode || '').trim().toUpperCase();
    if (!ALLOWED_SINGLE_SITE_MODES.has(m)) {
      const err = new Error('Single-site full-month mode must be EARLY_CUTOFF, ALWAYS_FULL, or ACTUAL_FROM_FIRST_FUEL');
      err.status = 400;
      throw err;
    }
    next.singleSiteFullMonthMode = m;
  }

  if (hasTable('settings')) {
    tx(() => {
      const up = [
        ['billing.earlyMonthCutoffDay', String(next.earlyMonthCutoffDay)],
        ['billing.workingDaysPerMonth', String(next.workingDaysPerMonth)],
        ['billing.autoAllocMinConsecutive', String(next.autoAllocMinConsecutive)],
        ['billing.singleSiteFullMonthMode', String(next.singleSiteFullMonthMode)],
      ];
      for (const [k, v] of up) {
        run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', k, v);
      }
    });
  }

  try {
    audit.record({
      userId: actorId,
      entity: 'settings',
      entityId: null,
      action: 'hire.costing_options.updated',
      before: cur,
      after: next,
    });
  } catch (_) {}

  return next;
}

function isNonMachineFuelRow(issue, asset) {
  const code = String((asset && (asset.code || asset.ec_code)) || (issue && (issue.asset_code || issue.vehicle_ref)) || '').trim();
  const text = `${(asset && asset.type) || ''} ${(asset && asset.notes) || ''} ${(issue && issue.notes) || ''}`;
  if (NON_MACHINE_CODE_RE.test(code)) return true;
  if (NON_MACHINE_TEXT_RE.test(text)) return true;
  if (issue && Number(issue.litres) < 0) return true;
  return false;
}

function loadTankProjectMap() {
  const map = new Map();
  if (!hasTable('fuel_tanks')) return map;
  for (const t of all('SELECT id, project_id FROM fuel_tanks')) {
    map.set(String(t.id), t.project_id != null ? Number(t.project_id) : null);
  }
  return map;
}

/**
 * Resolve issuing site project_id for one fuel_issues row.
 * Pump tank's site (`fuel_tanks.project_id`) takes priority over raw issue columns.
 */
function resolveIssueProjectId(fi, tankProjMap) {
  if (!fi) return null;
  const tankId = fi.source_tank_id || fi.bulk_tank_id;
  if (tankId != null && tankProjMap) {
    const tp = tankProjMap.get(String(tankId));
    if (tp != null && Number.isFinite(Number(tp)) && Number(tp) > 0) {
      return Number(tp);
    }
  }
  const cand = fi.target_project_id || fi.project_id || fi.source_project_id || null;
  return cand != null && Number(cand) > 0 ? Number(cand) : null;
}

function computeFuelIssueCostCents(fi) {
  const l = Number(fi.litres) || 0;
  const p = Number(fi.price_per_litre_cents || fi.fuel_price_cents || 0) || Math.round((Number(fi.unit_price) || 0) * 100);
  const c = Number(fi.total_cost_cents || fi.cost_cents || 0) || Math.round(l * p);
  return { litres: l, priceCents: p, costCents: Math.round(c) };
}

/**
 * Compute continuous runs from chronological fuel issues for one asset in a month:
 *   runs = [{ projectId, firstDate, lastDate, issueCount, totalLitres, issues }]
 */
function buildFuelRuns(issuesSorted, tankProjMap) {
  // Group issues by SLST calendar date -> determine day's primary site if two sites on same day
  const byDay = new Map();
  for (const fi of issuesSorted) {
    const day = slstDate10(fi.issue_date);
    const pid = resolveIssueProjectId(fi, tankProjMap);
    if (!day || !pid) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ fi, pid, litres: Number(fi.litres) || 0 });
  }

  const orderedDays = [...byDay.keys()].sort();
  const runs = [];
  for (const day of orderedDays) {
    const dayItems = byDay.get(day);
    // Pick site with largest total litres on that day (ties broken by last chronological issue)
    const litresBySite = new Map();
    for (const item of dayItems) {
      litresBySite.set(item.pid, (litresBySite.get(item.pid) || 0) + item.litres);
    }
    let primaryPid = dayItems[0].pid;
    let bestLitres = -1;
    for (const [pid, l] of litresBySite.entries()) {
      if (l >= bestLitres) {
        bestLitres = l;
        primaryPid = pid;
      }
    }
    const dayLitres = dayItems.filter((x) => x.pid === primaryPid).reduce((s, x) => s + x.litres, 0);
    const dayCount = dayItems.filter((x) => x.pid === primaryPid).length;

    const prev = runs[runs.length - 1];
    if (prev && prev.projectId === primaryPid) {
      prev.lastDate = day;
      prev.issueCount += dayCount;
      prev.totalLitres += dayLitres;
    } else {
      runs.push({
        projectId: primaryPid,
        firstDate: day,
        lastDate: day,
        issueCount: dayCount,
        totalLitres: dayLitres,
      });
    }
  }
  return runs;
}

/**
 * Filter short middle transit stops out of runs for Monthly Site Auto-Allocation.
 * E.g. Galagedara (3 issues) -> Badalgama (1 issue) -> Galagedara (4 issues) becomes Galagedara only.
 */
function smoothRunsForAutoAllocation(runs, minConsecutive = 2) {
  if (!runs || runs.length <= 1) return runs ? runs.map((r) => ({ ...r })) : [];
  let current = runs.map((r) => ({ ...r }));
  let changed = true;
  while (changed && current.length >= 3) {
    changed = false;
    const next = [];
    for (let i = 0; i < current.length; i++) {
      const r = current[i];
      if (
        i > 0 &&
        i < current.length - 1 &&
        r.issueCount < minConsecutive &&
        current[i - 1].projectId === current[i + 1].projectId
      ) {
        changed = true;
        continue;
      }
      const prev = next[next.length - 1];
      if (prev && prev.projectId === r.projectId) {
        prev.lastDate = r.lastDate;
        prev.issueCount += r.issueCount;
        prev.totalLitres += r.totalLitres;
      } else {
        next.push({ ...r });
      }
    }
    current = next;
  }
  return current;
}

/**
 * Build non-overlapping monthly site timelines for every active/allocated/fueled asset.
 *
 * Guarantees:
 *   - sum(postedDays across all sites for any asset) <= bounds.daysInMonth
 *   - 100% of non-transfer fuel issues at every site are attached to that site's stay
 *   - Explicit manual multi-site boundaries (e.g. Sep 1-15 Site A, Sep 16-30 Site B) are
 *     preserved verbatim when all fuel issues match those manual spans
 */
function buildMonthlyVehicleTimelines(periodKey, opts = {}) {
  const bounds = monthBounds(periodKey);
  if (!bounds) {
    const err = new Error('Valid month (YYYY-MM) is required');
    err.status = 400;
    throw err;
  }

  const savedOpts = getCostingOptions();
  const options = {
    earlyMonthCutoffDay: opts.earlyMonthCutoffDay != null ? Number(opts.earlyMonthCutoffDay) : savedOpts.earlyMonthCutoffDay,
    workingDaysPerMonth: opts.workingDaysPerMonth != null ? Number(opts.workingDaysPerMonth) : savedOpts.workingDaysPerMonth,
    autoAllocMinConsecutive: opts.autoAllocMinConsecutive != null ? Number(opts.autoAllocMinConsecutive) : savedOpts.autoAllocMinConsecutive,
    singleSiteFullMonthMode: opts.singleSiteFullMonthMode || savedOpts.singleSiteFullMonthMode,
  };

  const tankProjMap = opts._tankProjMap || loadTankProjectMap();
  const assetsMap = opts._assetsMap || new Map(all('SELECT * FROM assets').map((a) => [a.id, a]));

  // Widen SQL query by +/- 1 day so midnight SLST (+05:30) conversions are exact in JS
  const sqlWinStart = addDays(bounds.start, -1);
  const sqlWinEnd = `${addDays(bounds.end, 1)} 23:59:59`;
  const rawMonthIssues = opts._rawMonthIssues || all(`
    SELECT fi.*
      FROM fuel_issues fi
     WHERE COALESCE(fi.is_voided, 0) = 0
       AND COALESCE(fi.voided, 0) = 0
       AND fi.issue_date >= ?
       AND fi.issue_date <= ?
     ORDER BY fi.issue_date ASC, fi.id ASC
  `, sqlWinStart, sqlWinEnd);

  // Organize valid machine fuel issues by (assetId) and by (assetId -> projectId -> issues[])
  const issuesByAsset = new Map();
  const issuesByAssetSite = new Map();
  for (const fi of rawMonthIssues) {
    if (!fi.asset_id) continue;
    const day = slstDate10(fi.issue_date);
    if (!day || day < bounds.start || day > bounds.end) continue;
    const asset = assetsMap.get(fi.asset_id);
    if (isNonMachineFuelRow(fi, asset)) continue;
    const pid = resolveIssueProjectId(fi, tankProjMap);
    if (!pid) continue;

    if (!issuesByAsset.has(fi.asset_id)) issuesByAsset.set(fi.asset_id, []);
    issuesByAsset.get(fi.asset_id).push({ ...fi, _slstDay: day, _resolvedProjectId: pid });

    if (!issuesByAssetSite.has(fi.asset_id)) issuesByAssetSite.set(fi.asset_id, new Map());
    const siteMap = issuesByAssetSite.get(fi.asset_id);
    if (!siteMap.has(pid)) siteMap.set(pid, []);
    siteMap.get(pid).push({ ...fi, _slstDay: day, _resolvedProjectId: pid });
  }

  // Prior-month lookback (45 days before bounds.start) to detect continuous same-site presence
  const lookbackStart = addDays(bounds.start, -45);
  const lookbackEnd = `${bounds.start} 23:59:59`;
  const rawPriorIssues = all(`
    SELECT fi.asset_id, fi.source_tank_id, fi.bulk_tank_id, fi.target_project_id,
           fi.project_id, fi.source_project_id, fi.issue_date, fi.asset_code, fi.vehicle_ref, fi.litres, fi.notes
      FROM fuel_issues fi
     WHERE COALESCE(fi.is_voided, 0) = 0
       AND COALESCE(fi.voided, 0) = 0
       AND fi.asset_id IS NOT NULL
       AND fi.issue_date >= ?
       AND fi.issue_date <= ?
     ORDER BY fi.issue_date ASC, fi.id ASC
  `, lookbackStart, lookbackEnd);

  const priorFuelSiteByAsset = new Map(); // assetId -> { day, projectId }
  for (const fi of rawPriorIssues) {
    const day = slstDate10(fi.issue_date);
    if (!day || day >= bounds.start) continue;
    const asset = assetsMap.get(fi.asset_id);
    if (isNonMachineFuelRow(fi, asset)) continue;
    const pid = resolveIssueProjectId(fi, tankProjMap);
    if (!pid) continue;
    const prev = priorFuelSiteByAsset.get(fi.asset_id);
    if (!prev || day >= prev.day) {
      priorFuelSiteByAsset.set(fi.asset_id, { day, projectId: pid });
    }
  }

  // Load manual allocations (respect schema cleanly whether Migration 067 ran or not)
  const fvaCols = getColumnSet('fleet_vehicle_allocations');
  const fvaOriginExpr = fvaCols.has('origin') ? "COALESCE(va.origin, 'MANUAL')" : "'MANUAL'";
  const fvaLockedExpr = fvaCols.has('locked') ? 'COALESCE(va.locked, 0)' : '0';

  const allocRows = hasTable('fleet_vehicle_allocations')
    ? all(`
        SELECT va.id, va.asset_id, va.project_id, va.month, va.basis, va.driver_name, va.is_current, va.site_name,
               ${fvaOriginExpr} AS origin,
               ${fvaLockedExpr} AS locked,
               COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') AS eff_from,
               COALESCE(va.date_to,
                 CASE WHEN va.is_current = 1 THEN NULL
                      ELSE date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day') END) AS eff_to
          FROM fleet_vehicle_allocations va
         WHERE va.asset_id IS NOT NULL
           AND va.project_id IS NOT NULL
           AND COALESCE(va.active, 1) = 1
           AND (
             va.month = ?
             OR (
               COALESCE(va.date_from, COALESCE(va.month_from, va.month) || '-01') <= ?
               AND (va.is_current = 1 OR COALESCE(va.date_to, date(COALESCE(va.month_to, va.month) || '-01', '+1 month', '-1 day')) >= ?)
             )
           )
         ORDER BY COALESCE(va.is_current, 0) DESC, eff_from DESC
      `, bounds.periodKey, bounds.end, bounds.start)
    : [];

  const manualAssignRows = hasTable('fleet_asset_assignments')
    ? all(`
        SELECT fa.id, fa.asset_id, fa.project_id, fa.billing_type AS basis, fa.driver_name,
               COALESCE(fa.origin, 'MANUAL') AS origin,
               substr(fa.start_date, 1, 10) AS eff_from,
               CASE WHEN fa.end_date IS NOT NULL THEN substr(fa.end_date, 1, 10) ELSE NULL END AS eff_to
          FROM fleet_asset_assignments fa
         WHERE fa.asset_id IS NOT NULL
           AND fa.project_id IS NOT NULL
           AND COALESCE(fa.origin, 'MANUAL') != 'FUEL'
           AND substr(fa.start_date, 1, 10) <= ?
           AND (fa.end_date IS NULL OR substr(fa.end_date, 1, 10) >= ?)
         ORDER BY fa.start_date DESC
      `, bounds.end, bounds.start)
    : [];

  const manualSpansByAsset = new Map();
  const addManualSpan = (assetId, projectId, rawStart, rawEnd, basis, driverName, siteName, sourcePriority, origin, locked) => {
    const s = clampDate(rawStart || bounds.start, bounds.start, bounds.end) || bounds.start;
    const e = clampDate(rawEnd || bounds.end, bounds.start, bounds.end) || bounds.end;
    if (e < s) return;
    if (!manualSpansByAsset.has(assetId)) manualSpansByAsset.set(assetId, []);
    manualSpansByAsset.get(assetId).push({
      projectId: Number(projectId),
      start: s,
      end: e,
      basis: basis ? String(basis).toUpperCase() : null,
      driverName: driverName || null,
      siteName: siteName || null,
      sourcePriority,
      origin,
      locked: Boolean(locked),
    });
  };

  const carryForwardByAsset = new Map();
  for (const r of allocRows) {
    const origUp = String(r.origin || '').toUpperCase();
    // Only MANUAL (or locked) allocations drive explicit manual boundary preservation
    if (origUp === 'MANUAL' || Number(r.locked) === 1) {
      addManualSpan(r.asset_id, r.project_id, r.eff_from, r.is_current ? bounds.end : r.eff_to, r.basis, r.driver_name, r.site_name, 2, r.origin, r.locked);
    } else if (origUp === 'CARRY_FORWARD' && String(r.month || '') === bounds.periodKey && !carryForwardByAsset.has(r.asset_id)) {
      carryForwardByAsset.set(r.asset_id, {
        projectId: Number(r.project_id),
        basis: r.basis ? String(r.basis).toUpperCase() : 'WET',
        driverName: r.driver_name || null,
        siteName: r.site_name || null,
      });
    }
  }
  for (const r of manualAssignRows) {
    addManualSpan(r.asset_id, r.project_id, r.eff_from, r.eff_to || bounds.end, r.basis, r.driver_name, null, 1, r.origin, false);
  }

  // Also capture auto allocations/current_project_id hints (basis, driverName, zero-fuel current month)
  const allocHintsByAssetSite = new Map();
  for (const r of allocRows) {
    const k = `${r.asset_id}:${r.project_id}`;
    if (!allocHintsByAssetSite.has(k)) {
      allocHintsByAssetSite.set(k, {
        basis: r.basis ? String(r.basis).toUpperCase() : null,
        driverName: r.driver_name || null,
        siteName: r.site_name || null,
        origin: r.origin,
      });
    }
  }

  // Gather candidate assetIds across fuel, manual spans, carry-forward allocations, and current_project_id
  const allCandidateAssetIds = new Set([
    ...issuesByAsset.keys(),
    ...manualSpansByAsset.keys(),
    ...carryForwardByAsset.keys(),
  ]);
  for (const a of assetsMap.values()) {
    if (a.current_project_id && !['decommissioned', 'DISPOSED'].includes(String(a.status || '').toLowerCase())) {
      allCandidateAssetIds.add(a.id);
    }
  }

  const isCurMonth = bounds.periodKey === currentMonthKey();
  const byAsset = new Map();
  const bySite = new Map();

  for (const assetId of allCandidateAssetIds) {
    const asset = assetsMap.get(assetId);
    if (!asset || isNonMachineFuelRow({}, asset)) continue;

    const assetFuel = issuesByAsset.get(assetId) || [];
    const assetSiteFuel = issuesByAssetSite.get(assetId) || new Map();
    const manualSpans = manualSpansByAsset.get(assetId) || [];

    // Check Case 1: Manual spans exist AND either 0 fuel issues OR every fuel issue falls on a date covered by manual spans for the SAME projectId
    const everyFuelMatchesManual = manualSpans.length > 0 && assetFuel.every((fi) =>
      manualSpans.some((ms) => ms.projectId === fi._resolvedProjectId && fi._slstDay >= ms.start && fi._slstDay <= ms.end)
    );
    const hasLockedSpan = manualSpans.some((ms) => ms.locked);

    // Day-to-site map guarantees zero double-billing (at most 1 site owns each calendar day)
    const dayOwner = new Map(); // isoDate -> { projectId, origin, basis, driverName, siteName }
    const priorEntry = priorFuelSiteByAsset.get(assetId);
    let priorSiteId = priorEntry ? priorEntry.projectId : null;
    if (!priorSiteId && manualSpans.length > 0) {
      priorSiteId = manualSpans[0].projectId;
    }

    if (everyFuelMatchesManual || (hasLockedSpan && manualSpans.length > 0)) {
      // Case 1: Paint days per manual span, higher priority / later start date wins ties cleanly
      const orderedManual = [...manualSpans].sort((a, b) => a.sourcePriority - b.sourcePriority || a.start.localeCompare(b.start));
      for (const ms of orderedManual) {
        let d = ms.start;
        for (let i = 0; i < 32 && d <= ms.end; i++) {
          dayOwner.set(d, {
            projectId: ms.projectId,
            origin: ms.origin || 'MANUAL',
            basis: ms.basis,
            driverName: ms.driverName,
            siteName: ms.siteName,
          });
          d = addDays(d, 1);
        }
      }
      // If locked manual span was combined with outside fuel on a specific day, keep locked manual day owner
      // unless a fuel day isn't covered by any manual span at all
      for (const fi of assetFuel) {
        if (!dayOwner.has(fi._slstDay)) {
          dayOwner.set(fi._slstDay, {
            projectId: fi._resolvedProjectId,
            origin: 'FUEL_TIMELINE',
            basis: null,
            driverName: fi.driver_name || null,
            siteName: null,
          });
        }
      }
    } else if (assetFuel.length > 0) {
      // Case 2: Fuel-driven chronological partition across sites
      const runs = buildFuelRuns(assetFuel, tankProjMap);
      if (runs.length === 1) {
        const r = runs[0];
        const firstDayNum = Number(r.firstDate.slice(8, 10));
        const useFull =
          options.singleSiteFullMonthMode === 'ALWAYS_FULL' ||
          priorSiteId === r.projectId ||
          (options.singleSiteFullMonthMode === 'EARLY_CUTOFF' && firstDayNum <= options.earlyMonthCutoffDay);
        const segStart = useFull ? bounds.start : r.firstDate;
        const segEnd = bounds.end;
        const hint = allocHintsByAssetSite.get(`${assetId}:${r.projectId}`);
        let d = segStart;
        for (let i = 0; i < 32 && d <= segEnd; i++) {
          dayOwner.set(d, {
            projectId: r.projectId,
            origin: hint ? (hint.origin || 'AUTO_FUEL') : 'FUEL_TIMELINE',
            basis: hint ? hint.basis : null,
            driverName: (hint && hint.driverName) || assetFuel[0].driver_name || null,
            siteName: hint ? hint.siteName : null,
          });
          d = addDays(d, 1);
        }
      } else if (runs.length >= 2) {
        const isShortTransit = (idx) =>
          idx > 0 &&
          idx < runs.length - 1 &&
          runs[idx].issueCount < options.autoAllocMinConsecutive &&
          runs[idx - 1].projectId === runs[idx + 1].projectId;

        for (let idx = 0; idx < runs.length; idx++) {
          const r = runs[idx];
          let segStart = (idx > 0 && isShortTransit(idx - 1))
            ? addDays(runs[idx - 1].lastDate, 1)
            : r.firstDate;
          if (idx === 0) {
            const firstDayNum = Number(r.firstDate.slice(8, 10));
            const useFullStart =
              options.singleSiteFullMonthMode === 'ALWAYS_FULL' ||
              priorSiteId === r.projectId ||
              (options.singleSiteFullMonthMode === 'EARLY_CUTOFF' && firstDayNum <= options.earlyMonthCutoffDay);
            if (useFullStart) segStart = bounds.start;
          }
          const segEnd = isShortTransit(idx)
            ? r.lastDate
            : (idx === runs.length - 1 ? bounds.end : addDays(runs[idx + 1].firstDate, -1));
          const effEnd = segEnd < segStart ? segStart : segEnd;
          const hint = allocHintsByAssetSite.get(`${assetId}:${r.projectId}`);
          let d = segStart;
          for (let i = 0; i < 32 && d <= effEnd; i++) {
            dayOwner.set(d, {
              projectId: r.projectId,
              origin: hint ? (hint.origin || 'AUTO_FUEL') : 'FUEL_TIMELINE',
              basis: hint ? hint.basis : null,
              driverName: (hint && hint.driverName) || null,
              siteName: hint ? hint.siteName : null,
            });
            d = addDays(d, 1);
          }
        }
      }
    } else if (carryForwardByAsset.has(assetId)) {
      const cf = carryForwardByAsset.get(assetId);
      let d = bounds.start;
      for (let i = 0; i < 32 && d <= bounds.end; i++) {
        dayOwner.set(d, {
          projectId: cf.projectId,
          origin: 'CARRY_FORWARD',
          basis: cf.basis,
          driverName: cf.driverName,
          siteName: cf.siteName,
        });
        d = addDays(d, 1);
      }
    } else if (asset.current_project_id && !['decommissioned', 'DISPOSED'].includes(String(asset.status || '').toLowerCase())) {
      // Zero fuel & zero manual allocation in this month: only assign if explicitly requested for current/zero-fuel visibility
      if (isCurMonth || opts.includeCurrentProjectZeroFuel) {
        const pid = Number(asset.current_project_id);
        let d = bounds.start;
        for (let i = 0; i < 32 && d <= bounds.end; i++) {
          dayOwner.set(d, {
            projectId: pid,
            origin: 'CURRENT_SITE',
            basis: null,
            driverName: null,
            siteName: null,
          });
          d = addDays(d, 1);
        }
      }
    }

    // Group dayOwner into intervals per site, AND ensure any site that dispensed fuel to this asset
    // (even on a day owned by another site on the same day) gets its fuel entry attached cleanly.
    const daysBySite = new Map();
    const metaBySite = new Map();
    for (const [day, owner] of [...dayOwner.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!daysBySite.has(owner.projectId)) {
        daysBySite.set(owner.projectId, []);
        metaBySite.set(owner.projectId, owner);
      }
      daysBySite.get(owner.projectId).push(day);
      const m = metaBySite.get(owner.projectId);
      if (owner.basis && !m.basis) m.basis = owner.basis;
      if (owner.driverName && !m.driverName) m.driverName = owner.driverName;
      if (owner.siteName && !m.siteName) m.siteName = owner.siteName;
    }

    // Ensure every fuel-issuing site for this asset has an entry (handles two sites on exact same day)
    for (const [pid, fList] of assetSiteFuel.entries()) {
      if (!daysBySite.has(pid)) {
        daysBySite.set(pid, []);
        const hint = allocHintsByAssetSite.get(`${assetId}:${pid}`);
        metaBySite.set(pid, {
          projectId: pid,
          origin: 'FUEL_TIMELINE',
          basis: hint ? hint.basis : null,
          driverName: (hint && hint.driverName) || (fList[0] && fList[0].driver_name) || null,
          siteName: hint ? hint.siteName : null,
        });
      }
    }

    const stays = [];
    for (const [pid, dayList] of daysBySite.entries()) {
      const sortedDays = [...new Set(dayList)].sort();
      const intervals = mergeIntervals(sortedDays.map((d) => ({ start: d, end: d })));
      const postedDays = sortedDays.length;
      const meta = metaBySite.get(pid) || {};
      const fIssues = assetSiteFuel.get(pid) || [];
      let fuelLitres = 0;
      let fuelCostCents = 0;
      let minMeter = null;
      let maxMeter = null;
      const siteNames = [];
      if (meta.siteName) siteNames.push(meta.siteName);

      // Direct billed check: preserve basis from manual spans too
      const allocBases = [];
      if (meta.basis) allocBases.push(meta.basis);
      for (const ms of manualSpans) {
        if (ms.projectId === pid && ms.basis && !allocBases.includes(ms.basis)) {
          allocBases.push(ms.basis);
        }
        if (ms.projectId === pid && ms.siteName) siteNames.push(ms.siteName);
      }

      for (const fi of fIssues) {
        const fc = computeFuelIssueCostCents(fi);
        if (Number(fi.is_direct_billed) !== 1) {
          fuelLitres += fc.litres;
          fuelCostCents += fc.costCents;
        }
        const m = Number(fi.meter_reading);
        if (Number.isFinite(m) && m > 0) {
          if (minMeter == null || m < minMeter) minMeter = m;
          if (maxMeter == null || m > maxMeter) maxMeter = m;
        }
      }
      fuelLitres = Math.round(fuelLitres * 100) / 100;
      fuelCostCents = Math.round(fuelCostCents);

      const entry = {
        assetId,
        projectId: pid,
        intervals,
        stayDatesLabel: intervals.length ? formatIntervalsLabel(intervals) : (fIssues[0] ? fmtShortDay(fIssues[0]._slstDay) : ''),
        postedDays,
        allocBases,
        driverName: meta.driverName || null,
        siteNames,
        origin: meta.origin || 'FUEL_TIMELINE',
        fuelIssues: fIssues,
        allSiteFuelIssues: fIssues,
        fuelLitres,
        fuelCostCents,
        issueCount: fIssues.length,
        minMeter,
        maxMeter,
        firstFuelDate: fIssues.length ? fIssues[0]._slstDay : null,
        lastFuelDate: fIssues.length ? fIssues[fIssues.length - 1]._slstDay : null,
      };
      stays.push(entry);

      if (!bySite.has(pid)) bySite.set(pid, new Map());
      bySite.get(pid).set(assetId, entry);
    }

    const totalPostedDays = stays.reduce((s, st) => s + st.postedDays, 0);
    byAsset.set(assetId, {
      assetId,
      priorSiteId,
      totalPostedDays,
      stays,
    });
  }

  return {
    periodKey: bounds.periodKey,
    bounds,
    options,
    byAsset,
    bySite,
  };
}

/**
 * Derive desired monthly AUTO_FUEL allocations for one month (and optional assetId/projectId filter),
 * smoothing out short 1-day transit refuels (`< autoAllocMinConsecutive`) and never overwriting MANUAL/locked rows.
 */
function deriveMonthlyAllocationsFromFuel(periodKey, { assetId = null, projectId = null, options = null } = {}) {
  const bounds = monthBounds(periodKey);
  if (!bounds) {
    const err = new Error('Valid month (YYYY-MM) is required');
    err.status = 400;
    throw err;
  }

  const opts = options || getCostingOptions();
  const tankProjMap = loadTankProjectMap();
  const assetsMap = new Map(all('SELECT * FROM assets').map((a) => [a.id, a]));
  const projectsMap = new Map(all('SELECT id, code, name FROM projects').map((p) => [p.id, p]));
  const rateCardBasisMap = new Map(
    all('SELECT asset_id, default_basis FROM fleet_rental_rates WHERE asset_id IS NOT NULL')
      .map((r) => [r.asset_id, r.default_basis])
  );

  const sqlWinStart = addDays(bounds.start, -1);
  const sqlWinEnd = `${addDays(bounds.end, 1)} 23:59:59`;
  const rawMonthIssues = all(`
    SELECT fi.*
      FROM fuel_issues fi
     WHERE COALESCE(fi.is_voided, 0) = 0
       AND COALESCE(fi.voided, 0) = 0
       AND fi.asset_id IS NOT NULL
       ${assetId ? 'AND fi.asset_id = ?' : ''}
       AND fi.issue_date >= ?
       AND fi.issue_date <= ?
     ORDER BY fi.issue_date ASC, fi.id ASC
  `, ...(assetId ? [Number(assetId), sqlWinStart, sqlWinEnd] : [sqlWinStart, sqlWinEnd]));

  const issuesByAsset = new Map();
  for (const fi of rawMonthIssues) {
    const day = slstDate10(fi.issue_date);
    if (!day || day < bounds.start || day > bounds.end) continue;
    const asset = assetsMap.get(fi.asset_id);
    if (!asset || isNonMachineFuelRow(fi, asset)) continue;
    const pid = resolveIssueProjectId(fi, tankProjMap);
    if (!pid) continue;
    if (!issuesByAsset.has(fi.asset_id)) issuesByAsset.set(fi.asset_id, []);
    issuesByAsset.get(fi.asset_id).push({ ...fi, _slstDay: day, _resolvedProjectId: pid });
  }

  // Prior-month fuel site for full-month start rule
  const lookbackStart = addDays(bounds.start, -45);
  const lookbackEnd = `${bounds.start} 23:59:59`;
  const rawPrior = all(`
    SELECT fi.asset_id, fi.source_tank_id, fi.bulk_tank_id, fi.target_project_id,
           fi.project_id, fi.source_project_id, fi.issue_date, fi.asset_code, fi.vehicle_ref, fi.litres, fi.notes
      FROM fuel_issues fi
     WHERE COALESCE(fi.is_voided, 0) = 0
       AND COALESCE(fi.voided, 0) = 0
       AND fi.asset_id IS NOT NULL
       ${assetId ? 'AND fi.asset_id = ?' : ''}
       AND fi.issue_date >= ?
       AND fi.issue_date <= ?
     ORDER BY fi.issue_date ASC, fi.id ASC
  `, ...(assetId ? [Number(assetId), lookbackStart, lookbackEnd] : [lookbackStart, lookbackEnd]));

  const priorSiteByAsset = new Map();
  for (const fi of rawPrior) {
    const day = slstDate10(fi.issue_date);
    if (!day || day >= bounds.start) continue;
    const pid = resolveIssueProjectId(fi, tankProjMap);
    if (pid) priorSiteByAsset.set(fi.asset_id, pid);
  }

  // Existing allocations for this month
  const fvaCols = getColumnSet('fleet_vehicle_allocations');
  const originSel = fvaCols.has('origin') ? "COALESCE(va.origin, 'MANUAL')" : "'MANUAL'";
  const lockedSel = fvaCols.has('locked') ? 'COALESCE(va.locked, 0)' : '0';
  const existingRows = hasTable('fleet_vehicle_allocations')
    ? all(`
        SELECT va.*, ${originSel} AS origin, ${lockedSel} AS locked
          FROM fleet_vehicle_allocations va
         WHERE va.asset_id IS NOT NULL
           AND va.month = ?
           AND COALESCE(va.active, 1) = 1
           ${assetId ? 'AND va.asset_id = ?' : ''}
      `, ...(assetId ? [bounds.periodKey, Number(assetId)] : [bounds.periodKey]))
    : [];

  const manualAssetsInMonth = new Set();
  const existingAutoByAsset = new Map();
  for (const r of existingRows) {
    if (String(r.origin).toUpperCase() === 'MANUAL' || Number(r.locked) === 1) {
      manualAssetsInMonth.add(r.asset_id);
    } else {
      if (!existingAutoByAsset.has(r.asset_id)) existingAutoByAsset.set(r.asset_id, []);
      existingAutoByAsset.get(r.asset_id).push(r);
    }
  }

  const isCurMonth = bounds.periodKey === currentMonthKey();
  const items = [];
  const staleAutoIds = [];
  const targetProjFilter = projectId && String(projectId).toUpperCase() !== 'ALL' ? Number(projectId) : null;

  // Check existing AUTO_FUEL rows whose asset now has 0 fuel issues (e.g. fuel voided) -> mark for removal
  for (const [aid, autoRows] of existingAutoByAsset.entries()) {
    if (!issuesByAsset.has(aid) || manualAssetsInMonth.has(aid)) {
      for (const r of autoRows) staleAutoIds.push(r.id);
    }
  }

  for (const [aid, fList] of issuesByAsset.entries()) {
    const asset = assetsMap.get(aid);
    const assetCode = asset ? (asset.code || asset.ec_code || asset.registration || `A-${aid}`) : `A-${aid}`;

    if (manualAssetsInMonth.has(aid)) {
      // Respect manual/locked allocation for this asset & month
      const primaryPid = resolveIssueProjectId(fList[0], tankProjMap);
      if (targetProjFilter && !fList.some((f) => f._resolvedProjectId === targetProjFilter)) continue;
      const proj = projectsMap.get(primaryPid);
      items.push({
        assetId: aid,
        assetCode,
        projectId: primaryPid,
        siteName: proj ? proj.name : `Project ${primaryPid}`,
        dateFrom: bounds.start,
        dateTo: bounds.end,
        isCurrent: false,
        basis: rateCardBasisMap.get(aid) || 'DRY_WITH_DRIVER',
        issueCount: fList.length,
        totalLitres: Math.round(fList.reduce((s, f) => s + (Number(f.litres) || 0), 0) * 100) / 100,
        action: 'SKIP_MANUAL',
        skippedManual: true,
      });
      continue;
    }

    const rawRuns = buildFuelRuns(fList, tankProjMap);
    const smoothed = smoothRunsForAutoAllocation(rawRuns, opts.autoAllocMinConsecutive);
    const priorPid = priorSiteByAsset.get(aid) || null;
    const existingAuto = existingAutoByAsset.get(aid) || [];
    const existingByDedup = new Map(existingAuto.map((r) => [r.dedupe_key, r]));
    const wantedDedupes = new Set();

    for (let idx = 0; idx < smoothed.length; idx++) {
      const r = smoothed[idx];
      if (targetProjFilter && r.projectId !== targetProjFilter) continue;

      let dateFrom = r.firstDate;
      if (idx === 0) {
        const dNum = Number(r.firstDate.slice(8, 10));
        const useFull =
          opts.singleSiteFullMonthMode === 'ALWAYS_FULL' ||
          priorPid === r.projectId ||
          (opts.singleSiteFullMonthMode === 'EARLY_CUTOFF' && dNum <= opts.earlyMonthCutoffDay);
        if (useFull) dateFrom = bounds.start;
      }

      const isFinalSegment = idx === smoothed.length - 1;
      const dateTo = isFinalSegment
        ? (isCurMonth ? null : bounds.end)
        : addDays(smoothed[idx + 1].firstDate, -1);
      const effDateTo = dateTo && dateTo < dateFrom ? dateFrom : dateTo;
      const isCurrent = isCurMonth && isFinalSegment;

      const proj = projectsMap.get(r.projectId);
      const siteName = proj ? proj.name : `Project ${r.projectId}`;
      const projectCode = proj ? proj.code : null;
      const dedupeKey = idx === 0 && smoothed.length === 1
        ? `AUTO-${aid}-${r.projectId}-${bounds.periodKey}`
        : `AUTO-${aid}-${r.projectId}-${bounds.periodKey}-${idx}`;
      wantedDedupes.add(dedupeKey);

      const hired = isHiredAsset(asset);
      const ownerCode = hired ? 'HIRED' : 'E&C';
      const basis = hired ? 'BILLED_DIRECT' : (rateCardBasisMap.get(aid) || 'DRY_WITH_DRIVER');
      const existing = existingByDedup.get(dedupeKey);
      let action = 'CREATE';
      if (existing) {
        const sameSpan =
          existing.date_from === dateFrom &&
          (existing.date_to || null) === (effDateTo || null) &&
          Number(existing.is_current || 0) === (isCurrent ? 1 : 0) &&
          String(existing.owner_code || 'E&C').toUpperCase() === ownerCode &&
          (!hired || String(existing.basis || '').toUpperCase() === 'BILLED_DIRECT');
        action = sameSpan ? 'UNCHANGED' : 'UPDATE';
      }

      // Compute all fuel litres for this site in the month (including if absorbed middle stop was separate, total litres from fList at r.projectId)
      const siteLitres = fList
        .filter((f) => f._resolvedProjectId === r.projectId)
        .reduce((s, f) => s + (Number(f.litres) || 0), 0);
      const siteIssuesCount = fList.filter((f) => f._resolvedProjectId === r.projectId).length;

      items.push({
        assetId: aid,
        assetCode,
        machineType: asset ? asset.type : null,
        projectId: r.projectId,
        projectCode,
        siteName,
        dedupeKey,
        dateFrom,
        dateTo: effDateTo,
        isCurrent,
        ownerCode,
        basis,
        driverName: fList.find((f) => f._resolvedProjectId === r.projectId && f.driver_name)?.driver_name || null,
        issueCount: siteIssuesCount || r.issueCount,
        totalLitres: Math.round((siteLitres || r.totalLitres) * 100) / 100,
        firstFuelDate: r.firstDate,
        lastFuelDate: r.lastDate,
        action,
        skippedManual: false,
      });
    }

    for (const ex of existingAuto) {
      if (!wantedDedupes.has(ex.dedupe_key)) {
        staleAutoIds.push(ex.id);
      }
    }
  }

  return {
    periodKey: bounds.periodKey,
    bounds,
    options: opts,
    items,
    staleAutoIds,
  };
}

/**
 * Apply (or preview with dryRun=true) fuel-driven monthly allocations into `fleet_vehicle_allocations`,
 * `fleet_asset_assignments` (`origin='FUEL'`), and `assets.current_project_id`.
 */
function syncFuelAllocations({ periodKey, assetId = null, projectId = null, dryRun = false, actorId = 1 } = {}) {
  const plan = deriveMonthlyAllocationsFromFuel(periodKey, { assetId, projectId });
  const isCurMonth = plan.periodKey === currentMonthKey();

  const summary = {
    periodKey: plan.periodKey,
    dryRun: Boolean(dryRun),
    created: 0,
    updated: 0,
    removed: plan.staleAutoIds.length,
    skippedManual: 0,
    unchanged: 0,
    items: plan.items,
  };

  for (const it of plan.items) {
    if (it.action === 'CREATE') summary.created++;
    else if (it.action === 'UPDATE') summary.updated++;
    else if (it.action === 'SKIP_MANUAL') summary.skippedManual++;
    else summary.unchanged++;
  }

  if (dryRun) return summary;

  const fvaCols = getColumnSet('fleet_vehicle_allocations');
  const hasOriginCol = fvaCols.has('origin') && fvaCols.has('locked');

  tx(() => {
    // 1. Delete stale AUTO_FUEL rows whose fuel was voided or smoothed away
    if (plan.staleAutoIds.length > 0) {
      const ph = plan.staleAutoIds.map(() => '?').join(',');
      const staleAssets = all(`SELECT DISTINCT asset_id FROM fleet_vehicle_allocations WHERE id IN (${ph}) AND asset_id IS NOT NULL`, ...plan.staleAutoIds);
      run(`DELETE FROM fleet_vehicle_allocations WHERE id IN (${ph}) AND COALESCE(locked, 0) = 0`, ...plan.staleAutoIds);
      if (hasTable('fleet_asset_assignments')) {
        for (const sa of staleAssets) {
          const stillHasPlan = plan.items.some((x) => !x.skippedManual && x.assetId === sa.asset_id);
          if (!stillHasPlan) {
            run("DELETE FROM fleet_asset_assignments WHERE asset_id = ? AND origin = 'FUEL' AND substr(start_date, 1, 7) = ?", sa.asset_id, plan.periodKey);
          }
        }
      }
    }

    // Also remove superseded AUTO_FUEL assignments in fleet_asset_assignments for affected assets whose fuel was voided
    const assetsToSyncAssign = new Map();

    // 2. Upsert desired AUTO_FUEL rows
    for (const it of plan.items) {
      if (it.skippedManual) continue;

      const noteStr = `Auto-allocated from site fuel (${it.issueCount} issue${it.issueCount === 1 ? '' : 's'}, ${it.totalLitres} L)`;

      if (it.isCurrent) {
        // Clear is_current on older non-locked AUTO_FUEL rows for this asset
        if (hasOriginCol) {
          run(`
            UPDATE fleet_vehicle_allocations
               SET is_current = 0,
                   date_to = COALESCE(date_to, ?),
                   updated_at = datetime('now')
             WHERE asset_id = ?
               AND is_current = 1
               AND COALESCE(origin, 'MANUAL') = 'AUTO_FUEL'
               AND COALESCE(locked, 0) = 0
               AND dedupe_key != ?
          `, addDays(it.dateFrom, -1), it.assetId, it.dedupeKey);
        }
      }

      if (it.action === 'CREATE' || it.action === 'UPDATE') {
        const allocId = `va-auto-${plan.periodKey}-${it.assetId}-${it.projectId}-${Math.random().toString(36).slice(2, 6)}`;
        const rowOwnerCode = it.ownerCode || 'E&C';
        if (hasOriginCol) {
          run(`
            INSERT INTO fleet_vehicle_allocations (
              id, dedupe_key, asset_id, vehicle_no, project_id, site_name,
              month, month_from, month_to, date_from, date_to, is_current, machine_type, owner_code,
              basis, active, driver_name, notes, origin, locked, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'AUTO_FUEL', 0, datetime('now'), datetime('now'))
            ON CONFLICT(dedupe_key) DO UPDATE SET
              project_id = excluded.project_id,
              site_name = excluded.site_name,
              month_from = excluded.month_from,
              month_to = excluded.month_to,
              date_from = excluded.date_from,
              date_to = excluded.date_to,
              is_current = excluded.is_current,
              owner_code = excluded.owner_code,
              basis = CASE
                WHEN excluded.owner_code = 'HIRED' THEN 'BILLED_DIRECT'
                ELSE COALESCE(fleet_vehicle_allocations.basis, excluded.basis)
              END,
              active = 1,
              driver_name = COALESCE(excluded.driver_name, fleet_vehicle_allocations.driver_name),
              notes = excluded.notes,
              origin = 'AUTO_FUEL',
              updated_at = datetime('now')
             WHERE COALESCE(fleet_vehicle_allocations.origin, 'AUTO_FUEL') = 'AUTO_FUEL'
               AND COALESCE(fleet_vehicle_allocations.locked, 0) = 0
          `, allocId, it.dedupeKey, it.assetId, it.assetCode, it.projectId, it.siteName,
             plan.periodKey, plan.periodKey, plan.periodKey, it.dateFrom, it.dateTo || null,
             it.isCurrent ? 1 : 0, it.machineType || null, rowOwnerCode, it.basis, it.driverName || null, noteStr);
        } else {
          run(`
            INSERT INTO fleet_vehicle_allocations (
              id, dedupe_key, asset_id, vehicle_no, project_id, site_name,
              month, month_from, month_to, date_from, date_to, is_current, machine_type, owner_code,
              basis, active, driver_name, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(dedupe_key) DO UPDATE SET
              date_from = excluded.date_from,
              date_to = excluded.date_to,
              is_current = excluded.is_current,
              owner_code = excluded.owner_code,
              basis = CASE
                WHEN excluded.owner_code = 'HIRED' THEN 'BILLED_DIRECT'
                ELSE fleet_vehicle_allocations.basis
              END,
              active = 1,
              notes = excluded.notes,
              updated_at = datetime('now')
          `, allocId, it.dedupeKey, it.assetId, it.assetCode, it.projectId, it.siteName,
             plan.periodKey, plan.periodKey, plan.periodKey, it.dateFrom, it.dateTo || null,
             it.isCurrent ? 1 : 0, it.machineType || null, rowOwnerCode, it.basis, it.driverName || null, noteStr);
        }
      }

      if (!assetsToSyncAssign.has(it.assetId)) assetsToSyncAssign.set(it.assetId, []);
      assetsToSyncAssign.get(it.assetId).push(it);
    }

    // 3. Keep fleet_asset_assignments ('FUEL' origin) and assets.current_project_id synchronized for active/current month
    if (hasTable('fleet_asset_assignments')) {
      for (const [aid, segs] of assetsToSyncAssign.entries()) {
        run(`
          DELETE FROM fleet_asset_assignments
           WHERE asset_id = ?
             AND origin = 'FUEL'
             AND substr(start_date, 1, 7) = ?
        `, aid, plan.periodKey);

        for (let i = 0; i < segs.length; i++) {
          const it = segs[i];
          const assignId = `fa-fuel-${plan.periodKey}-${aid}-${it.projectId}-${i}`;
          run(`
            INSERT OR REPLACE INTO fleet_asset_assignments (
              id, asset_id, asset_code, project_id, project_code, driver_name,
              start_date, end_date, billing_type, origin, note, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FUEL', ?, ?, datetime('now'), datetime('now'))
          `, assignId, aid, it.assetCode, it.projectId, it.projectCode || null, it.driverName || null,
             it.dateFrom, it.dateTo || null, it.basis,
             `Auto from site fuel (${it.issueCount} issues, ${it.totalLitres} L)`, actorId || null);

          if (isCurMonth && it.isCurrent) {
            const hasManualCur = hasOriginCol && Boolean(get(`
              SELECT 1 FROM fleet_vehicle_allocations
               WHERE asset_id = ? AND is_current = 1 AND COALESCE(active, 1) = 1
                 AND (COALESCE(origin, 'MANUAL') = 'MANUAL' OR COALESCE(locked, 0) = 1)
               LIMIT 1
            `, aid));
            if (!hasManualCur) {
              run(`
                UPDATE assets
                   SET current_project_id = ?, updated_at = datetime('now')
                 WHERE id = ?
              `, it.projectId, aid);
            }
          }
        }
      }
    }
  });

  if (summary.created > 0 || summary.updated > 0 || summary.removed > 0) {
    try {
      audit.record({
        userId: actorId,
        entity: 'fleet_vehicle_allocation',
        entityId: assetId ? Number(assetId) : null,
        action: 'hire.allocations.synced_from_fuel',
        after: {
          periodKey: plan.periodKey,
          created: summary.created,
          updated: summary.updated,
          removed: summary.removed,
          skippedManual: summary.skippedManual,
        },
      });
    } catch (_) {}
  }

  return summary;
}

/**
 * Lightweight hook called on fuel issue creation or voiding to keep one vehicle's month allocated.
 */
function syncFuelAllocationForAsset(assetId, issueDateOrMonth, actorId = 1) {
  if (!assetId) return null;
  const d10 = slstDate10(issueDateOrMonth);
  const ym = d10 ? d10.slice(0, 7) : (/^\d{4}-\d{2}/.test(String(issueDateOrMonth || '')) ? String(issueDateOrMonth).slice(0, 7) : currentMonthKey());
  if (!monthBounds(ym)) return null;
  return syncFuelAllocations({ periodKey: ym, assetId: Number(assetId), dryRun: false, actorId });
}

module.exports = {
  COSTING_OPTION_DEFAULTS,
  getCostingOptions,
  saveCostingOptions,
  slstDate10,
  todaySlst,
  currentMonthKey,
  addDays,
  daysBetweenInclusive,
  monthBounds,
  mergeIntervals,
  formatIntervalsLabel,
  isNonMachineFuelRow,
  HIRED_ASSET_TEXT_RE,
  isHiredAsset,
  loadTankProjectMap,
  resolveIssueProjectId,
  buildFuelRuns,
  smoothRunsForAutoAllocation,
  buildMonthlyVehicleTimelines,
  deriveMonthlyAllocationsFromFuel,
  syncFuelAllocations,
  syncFuelAllocationForAsset,
};
