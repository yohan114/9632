'use strict';

/**
 * Unified Breakdown Monitoring & Billing Guard Engine.
 *
 * Aggregates machine breakdowns across ALL sites/workshops from:
 *   1. Non-historical repair job cards (job_cards) joined with job_requests (reason from jr.description)
 *   2. Unlinked repair job requests awaiting job card creation (job_requests)
 *   3. Daily working/breakdown logs (daily_conditions & fuel_daily_conditions)
 *   4. Manual entries & Admin date adjustments (fleet_breakdowns)
 *
 * Enforces the rule: "If a machine is on breakdown, we cannot bill"
 *   - Open (unclosed) breakdowns overlapping a billing period block bill generation/finalisation.
 *   - Closed breakdowns deduct unique downtime days inside the billing period.
 */

const { get, all, run } = require('../../db');
const audit = require('../audit');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPLETE_STATUSES = new Set(['WORK_COMPLETE', 'PARTIALLY_CLOSED', 'CLOSED']);

function todayStr() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function d10(v) {
  if (!v) return null;
  const s = String(v).trim().slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(startDay, endDay) {
  const s = d10(startDay);
  const e = d10(endDay);
  if (!s || !e) return 0;
  const ms = Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 86400000) + 1;
}

function monthBounds(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const lastDay = new Date(year, mon, 0).getDate();
  const key = `${m[1]}-${m[2]}`;
  return {
    periodKey: key,
    year,
    month: mon,
    daysInMonth: lastDay,
    start: `${key}-01`,
    end: `${key}-${String(lastDay).padStart(2, '0')}`,
  };
}

function overlapDays(startA, endA, startB, endB) {
  const s = startA > startB ? startA : startB;
  const e = endA < endB ? endA : endB;
  if (!s || !e || e < s) return 0;
  return daysBetweenInclusive(s, e);
}

function cleanJobDescription(jrDesc, jcDesc) {
  const jr = jrDesc ? String(jrDesc).trim() : '';
  if (jr) return jr;
  const jc = jcDesc ? String(jcDesc).trim() : '';
  if (!jc) return 'Mechanical breakdown / repair';
  return jc.split(/\n\nWorkshop note:/i)[0].trim() || jc;
}

function estimateDailyUnbillableCents(rateCard, daysInMonth = 30) {
  if (!rateCard) return 0;
  const rate = Number(rateCard.dry_rate_cents || rateCard.rate_cents || rateCard.wet_rate_cents || 0);
  if (!rate || rate <= 0) return 0;
  const basis = String(rateCard.rate_basis || 'HOURLY').toUpperCase();
  if (basis === 'DAILY') return rate;
  if (basis === 'MONTHLY' || basis === 'FLAT') return Math.round(rate / Math.max(1, daysInMonth));
  const minUnits = Number(rateCard.min_bill_hours) > 0
    ? Number(rateCard.min_bill_hours)
    : (basis === 'KM' ? 1000 : 100);
  return Math.round((rate * minUnits) / Math.max(1, daysInMonth));
}

function loadRateCardMap() {
  const map = new Map();
  try {
    for (const r of all('SELECT * FROM fleet_rental_rates WHERE asset_id IS NOT NULL')) {
      if (!map.has(r.asset_id)) map.set(r.asset_id, r);
    }
  } catch (_) {}
  return map;
}

function loadActiveBillAssetSet(periodKey) {
  const set = new Set();
  if (!periodKey) return set;
  try {
    for (const r of all("SELECT DISTINCT asset_id FROM fleet_bills WHERE period_key = ? AND status != 'VOID' AND asset_id IS NOT NULL", periodKey)) {
      set.add(r.asset_id);
    }
  } catch (_) {}
  return set;
}

function buildUnifiedRecords({ assetId = null, scopeMode = 'all' } = {}) {
  const nowDay = todayStr();
  const hasBreakdownsTable = !!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fleet_breakdowns'");

  const fbRows = hasBreakdownsTable
    ? all(`
        SELECT fb.*,
               COALESCE(a.code, a.ec_code, fb.asset_code) AS resolved_code,
               a.registration, a.type AS category,
               COALESCE(p.name, fb.site_name, cp.name) AS resolved_site_name,
               COALESCE(u.full_name, u.username) AS adjusted_by_name
          FROM fleet_breakdowns fb
          LEFT JOIN assets a ON a.id = fb.asset_id
          LEFT JOIN projects p ON p.id = fb.project_id
          LEFT JOIN projects cp ON cp.id = a.current_project_id
          LEFT JOIN users u ON u.id = fb.adjusted_by
         ${assetId ? 'WHERE fb.asset_id = ?' : ''}
         ORDER BY fb.breakdown_start DESC
      `, ...(assetId ? [Number(assetId)] : []))
    : [];

  const fbByJobCard = new Map();
  const fbByJobReq = new Map();
  const manualRows = [];
  for (const fb of fbRows) {
    if (fb.job_card_id) fbByJobCard.set(Number(fb.job_card_id), fb);
    else if (fb.job_request_id) fbByJobReq.set(Number(fb.job_request_id), fb);
    else manualRows.push(fb);
  }

  // 1. All-site repair job cards (excluding historical imports & test artifacts)
  const jobCards = all(`
    SELECT j.id AS job_card_id, j.job_no, j.asset_id, j.project_id, j.site, j.field_location,
           j.workshop_id, w.name AS workshop_name, j.type, j.severity, j.status AS job_status,
           j.breakdown AS is_breakdown_flag, j.field AS is_field_flag,
           j.requested_at, j.started_at, j.completed_at, j.closed_at, j.partial_closed_at,
           j.reported_at, j.working_at, j.description AS job_description,
           j.job_request_id, jr.jr_no, jr.req_date AS jr_req_date, jr.priority AS jr_priority,
           jr.description AS jr_description,
           COALESCE(a.code, a.ec_code) AS vehicle_code, a.registration, a.type AS category,
           COALESCE(j.project_id,
                    (SELECT fa.project_id FROM fleet_asset_assignments fa
                      WHERE fa.asset_id = j.asset_id
                      ORDER BY CASE WHEN fa.end_date IS NULL THEN 0 ELSE 1 END, fa.start_date DESC LIMIT 1),
                    a.current_project_id) AS resolved_project_id,
           COALESCE(p.name, NULLIF(TRIM(j.field_location), ''), NULLIF(TRIM(j.site), ''),
                    (SELECT p2.name FROM fleet_asset_assignments fa2 JOIN projects p2 ON p2.id = fa2.project_id
                      WHERE fa2.asset_id = j.asset_id
                      ORDER BY CASE WHEN fa2.end_date IS NULL THEN 0 ELSE 1 END, fa2.start_date DESC LIMIT 1),
                    cp.name, w.name) AS resolved_site_name
      FROM job_cards j
      LEFT JOIN job_requests jr ON jr.id = j.job_request_id
      LEFT JOIN assets a ON a.id = j.asset_id
      LEFT JOIN projects p ON p.id = j.project_id
      LEFT JOIN projects cp ON cp.id = a.current_project_id
      LEFT JOIN workshops w ON w.id = j.workshop_id
     WHERE j.type = 'repair'
       AND j.status <> 'REJECTED'
       AND COALESCE(j.is_historical, 0) = 0
       AND j.asset_id IS NOT NULL
       AND j.job_no NOT LIKE 'TEST/%'
       AND j.job_no NOT LIKE 'DC/TEST/%'
       ${assetId ? 'AND j.asset_id = ?' : ''}
     ORDER BY COALESCE(j.reported_at, j.requested_at) DESC, j.id DESC
  `, ...(assetId ? [Number(assetId)] : []));

  const records = [];
  const coveredJobReqIds = new Set();

  for (const j of jobCards) {
    if (j.job_request_id) coveredJobReqIds.add(Number(j.job_request_id));
    if (scopeMode === 'flagged' && !j.is_breakdown_flag && !j.is_field_flag && !['urgent', 'breakdown'].includes(String(j.jr_priority || '').toLowerCase())) {
      continue;
    }

    const origStart = d10(j.reported_at) || d10(j.jr_req_date) || d10(j.started_at) || d10(j.requested_at) || nowDay;
    let origEnd = null;
    if (j.is_field_flag) {
      origEnd = d10(j.working_at) || (COMPLETE_STATUSES.has(j.job_status) ? (d10(j.completed_at) || d10(j.closed_at) || d10(j.partial_closed_at)) : null);
    } else if (COMPLETE_STATUSES.has(j.job_status)) {
      origEnd = d10(j.completed_at) || d10(j.closed_at) || d10(j.partial_closed_at) || d10(j.working_at);
    }

    const ov = fbByJobCard.get(Number(j.job_card_id)) || (j.job_request_id ? fbByJobReq.get(Number(j.job_request_id)) : null);
    const start = (ov && d10(ov.breakdown_start)) || origStart;
    let end;
    let status;
    if (ov) {
      if (ov.status === 'WAIVED') {
        status = 'WAIVED';
        end = d10(ov.breakdown_end) || origEnd || start;
      } else if (ov.status === 'OPEN' || !ov.breakdown_end) {
        status = 'OPEN';
        end = null;
      } else {
        status = 'CLOSED';
        end = d10(ov.breakdown_end);
      }
    } else {
      end = origEnd;
      status = end ? 'CLOSED' : 'OPEN';
    }
    if (end && end < start) end = start;

    const effectiveEndForDays = end || (start <= nowDay ? nowDay : start);
    const totalDays = ov && ov.total_days != null && status !== 'OPEN'
      ? Number(ov.total_days)
      : (status === 'WAIVED' ? 0 : daysBetweenInclusive(start, effectiveEndForDays));

    records.push({
      id: ov ? ov.id : `jc-${j.job_card_id}`,
      key: `jc-${j.job_card_id}`,
      source_type: 'JOB_CARD',
      asset_id: j.asset_id,
      vehicle_code: j.vehicle_code,
      registration: j.registration,
      category: j.category,
      project_id: (ov && ov.project_id) || j.resolved_project_id || null,
      project_name: (ov && ov.resolved_site_name) || j.resolved_site_name || 'Central Workshop',
      workshop_name: j.workshop_name || null,
      job_card_id: j.job_card_id,
      job_no: j.job_no,
      job_status: j.job_status,
      job_request_id: j.job_request_id || null,
      jr_no: j.jr_no || null,
      is_breakdown_flag: !!j.is_breakdown_flag,
      is_field_flag: !!j.is_field_flag,
      breakdown_start: start,
      breakdown_end: end,
      orig_start_date: origStart,
      orig_end_date: origEnd,
      total_days: totalDays,
      is_open: status === 'OPEN',
      status,
      reason: (ov && ov.reason) || cleanJobDescription(j.jr_description, j.job_description),
      jr_description: j.jr_description || null,
      job_description: j.job_description || null,
      admin_adjusted: !!(ov && ov.adjusted_at),
      adjusted_by_name: ov ? ov.adjusted_by_name : null,
      adjusted_at: ov ? ov.adjusted_at : null,
      adjustment_note: ov ? ov.adjustment_note : null,
    });
  }

  // 2. Unlinked repair job requests across ALL sites (breakdown logged via JR before job card opened)
  const unlinkedJrs = all(`
    SELECT jr.id AS job_request_id, jr.jr_no, jr.req_date, jr.asset_id, jr.project_id,
           jr.priority, jr.approval_status, jr.description AS jr_description, jr.created_at,
           w.name AS workshop_name,
           COALESCE(a.code, a.ec_code) AS vehicle_code, a.registration, a.type AS category,
           COALESCE(jr.project_id,
                    (SELECT fa.project_id FROM fleet_asset_assignments fa
                      WHERE fa.asset_id = jr.asset_id
                      ORDER BY CASE WHEN fa.end_date IS NULL THEN 0 ELSE 1 END, fa.start_date DESC LIMIT 1),
                    a.current_project_id) AS resolved_project_id,
           COALESCE(p.name,
                    (SELECT p2.name FROM fleet_asset_assignments fa2 JOIN projects p2 ON p2.id = fa2.project_id
                      WHERE fa2.asset_id = jr.asset_id
                      ORDER BY CASE WHEN fa2.end_date IS NULL THEN 0 ELSE 1 END, fa2.start_date DESC LIMIT 1),
                    cp.name, w.name) AS resolved_site_name
      FROM job_requests jr
      LEFT JOIN assets a ON a.id = jr.asset_id
      LEFT JOIN projects p ON p.id = jr.project_id
      LEFT JOIN projects cp ON cp.id = a.current_project_id
      LEFT JOIN workshops w ON w.id = jr.workshop_id
     WHERE jr.type = 'repair'
       AND jr.approval_status <> 'rejected'
       AND jr.job_id IS NULL
       AND jr.asset_id IS NOT NULL
       AND jr.jr_no NOT LIKE 'JR-TEST-%'
       ${assetId ? 'AND jr.asset_id = ?' : ''}
     ORDER BY jr.req_date DESC, jr.id DESC
  `, ...(assetId ? [Number(assetId)] : []));

  for (const jr of unlinkedJrs) {
    if (coveredJobReqIds.has(Number(jr.job_request_id))) continue;
    if (scopeMode === 'flagged' && !['urgent', 'breakdown'].includes(String(jr.priority || '').toLowerCase())) {
      continue;
    }

    const origStart = d10(jr.req_date) || d10(jr.created_at) || nowDay;
    const ov = fbByJobReq.get(Number(jr.job_request_id));
    const start = (ov && d10(ov.breakdown_start)) || origStart;
    let end = null;
    let status = 'OPEN';
    if (ov) {
      if (ov.status === 'WAIVED') {
        status = 'WAIVED';
        end = d10(ov.breakdown_end) || start;
      } else if (ov.status === 'OPEN' || !ov.breakdown_end) {
        status = 'OPEN';
        end = null;
      } else {
        status = 'CLOSED';
        end = d10(ov.breakdown_end);
      }
    }
    if (end && end < start) end = start;
    const effectiveEnd = end || (start <= nowDay ? nowDay : start);
    const totalDays = status === 'WAIVED' ? 0 : daysBetweenInclusive(start, effectiveEnd);

    records.push({
      id: ov ? ov.id : `jr-${jr.job_request_id}`,
      key: `jr-${jr.job_request_id}`,
      source_type: 'JOB_REQUEST',
      asset_id: jr.asset_id,
      vehicle_code: jr.vehicle_code,
      registration: jr.registration,
      category: jr.category,
      project_id: (ov && ov.project_id) || jr.resolved_project_id || null,
      project_name: (ov && ov.resolved_site_name) || jr.resolved_site_name || 'Central Workshop',
      workshop_name: jr.workshop_name || null,
      job_card_id: null,
      job_no: null,
      job_status: `JR:${jr.approval_status}`,
      job_request_id: jr.job_request_id,
      jr_no: jr.jr_no,
      is_breakdown_flag: String(jr.priority || '').toLowerCase() === 'breakdown',
      is_field_flag: false,
      breakdown_start: start,
      breakdown_end: end,
      orig_start_date: origStart,
      orig_end_date: null,
      total_days: totalDays,
      is_open: status === 'OPEN',
      status,
      reason: (ov && ov.reason) || cleanJobDescription(jr.jr_description, null),
      jr_description: jr.jr_description || null,
      job_description: null,
      admin_adjusted: !!(ov && ov.adjusted_at),
      adjusted_by_name: ov ? ov.adjusted_by_name : null,
      adjusted_at: ov ? ov.adjusted_at : null,
      adjustment_note: ov ? ov.adjustment_note : null,
    });
  }

  // 3. Standalone manual breakdowns in fleet_breakdowns
  for (const fb of manualRows) {
    const start = d10(fb.breakdown_start) || nowDay;
    const end = fb.status === 'OPEN' ? null : d10(fb.breakdown_end);
    const status = fb.status === 'WAIVED' ? 'WAIVED' : (end ? 'CLOSED' : 'OPEN');
    const effEnd = end || (start <= nowDay ? nowDay : start);
    const totalDays = fb.total_days != null && status !== 'OPEN'
      ? Number(fb.total_days)
      : (status === 'WAIVED' ? 0 : daysBetweenInclusive(start, effEnd));

    records.push({
      id: fb.id,
      key: fb.id,
      source_type: fb.source_type || 'MANUAL',
      asset_id: fb.asset_id,
      vehicle_code: fb.resolved_code || fb.asset_code,
      registration: fb.registration || null,
      category: fb.category || null,
      project_id: fb.project_id || null,
      project_name: fb.resolved_site_name || 'Central',
      workshop_name: null,
      job_card_id: null,
      job_no: fb.job_no || null,
      job_status: status,
      job_request_id: null,
      jr_no: fb.jr_no || null,
      is_breakdown_flag: true,
      is_field_flag: false,
      breakdown_start: start,
      breakdown_end: end,
      orig_start_date: fb.orig_start_date || start,
      orig_end_date: fb.orig_end_date || end,
      total_days: totalDays,
      is_open: status === 'OPEN',
      status,
      reason: fb.reason || 'Mechanical breakdown',
      jr_description: null,
      job_description: null,
      admin_adjusted: !!fb.adjusted_at,
      adjusted_by_name: fb.adjusted_by_name || null,
      adjusted_at: fb.adjusted_at || null,
      adjustment_note: fb.adjustment_note || null,
    });
  }

  // 4. Daily Condition logs flagged BREAKDOWN (both daily_conditions and fuel_daily_conditions when present)
  const hasDc = !!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_conditions'");
  const hasFdc = !!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fuel_daily_conditions'");
  const condRows = [];
  if (hasDc) {
    condRows.push(...all(`
      SELECT dc.id, dc.asset_id, substr(dc.condition_date, 1, 10) AS cond_date,
             dc.project_id, dc.notes AS reason,
             COALESCE(a.code, a.ec_code) AS vehicle_code, a.registration, a.type AS category,
             COALESCE(p.name, cp.name) AS project_name, 'dc' AS tbl
        FROM daily_conditions dc
        LEFT JOIN assets a ON a.id = dc.asset_id
        LEFT JOIN projects p ON p.id = dc.project_id
        LEFT JOIN projects cp ON cp.id = a.current_project_id
       WHERE UPPER(dc.state) = 'BREAKDOWN'
         ${assetId ? 'AND dc.asset_id = ?' : ''}
    `, ...(assetId ? [Number(assetId)] : [])));
  }
  if (hasFdc) {
    condRows.push(...all(`
      SELECT fdc.id, fdc.asset_id, substr(fdc.condition_date, 1, 10) AS cond_date,
             a.current_project_id AS project_id, fdc.breakdown_reason AS reason,
             COALESCE(a.code, a.ec_code, fdc.asset_code) AS vehicle_code, a.registration, a.type AS category,
             COALESCE(fdc.location, cp.name) AS project_name, 'fdc' AS tbl
        FROM fuel_daily_conditions fdc
        LEFT JOIN assets a ON a.id = fdc.asset_id
        LEFT JOIN projects cp ON cp.id = a.current_project_id
       WHERE UPPER(fdc.working_status) = 'BREAKDOWN'
         ${assetId ? 'AND fdc.asset_id = ?' : ''}
    `, ...(assetId ? [Number(assetId)] : [])));
  }

  for (const c of condRows) {
    const dt = d10(c.cond_date);
    if (!dt) continue;
    records.push({
      id: `${c.tbl}-${c.id}`,
      key: `${c.tbl}-${c.id}`,
      source_type: 'DAILY_CONDITION',
      asset_id: c.asset_id,
      vehicle_code: c.vehicle_code,
      registration: c.registration,
      category: c.category,
      project_id: c.project_id || null,
      project_name: c.project_name || 'Site Log',
      workshop_name: null,
      job_card_id: null,
      job_no: null,
      job_status: 'CONDITION',
      job_request_id: null,
      jr_no: null,
      is_breakdown_flag: true,
      is_field_flag: false,
      breakdown_start: dt,
      breakdown_end: dt,
      orig_start_date: dt,
      orig_end_date: dt,
      total_days: 1,
      is_open: false,
      status: 'CLOSED',
      reason: c.reason || 'Logged breakdown on daily condition sheet',
      jr_description: null,
      job_description: null,
      admin_adjusted: false,
      adjusted_by_name: null,
      adjusted_at: null,
      adjustment_note: null,
    });
  }

  return records;
}

function listBreakdowns(filters = {}) {
  const {
    month = '',
    projectId = '',
    assetCode = '',
    status = '',
    source = '',
    search = '',
    scopeMode = 'all',
  } = filters;

  const bounds = month ? monthBounds(month) : null;
  const nowDay = todayStr();
  const rateCards = loadRateCardMap();
  const billedAssets = loadActiveBillAssetSet(bounds ? bounds.periodKey : null);

  const allRecords = buildUnifiedRecords({ scopeMode });

  // Collect all distinct sites for filter dropdown
  const siteMap = new Map();
  for (const r of allRecords) {
    if (r.project_id) siteMap.set(String(r.project_id), { id: r.project_id, name: r.project_name });
    else if (r.project_name) siteMap.set(`name:${r.project_name}`, { id: null, name: r.project_name });
  }

  const filtered = [];
  for (const r of allRecords) {
    // Period overlap filter if month is chosen
    let periodDays = r.total_days || 0;
    if (bounds) {
      const effEnd = r.breakdown_end || (bounds.end < nowDay ? bounds.end : nowDay);
      if (r.breakdown_start > bounds.end) continue;
      if (r.breakdown_end && r.breakdown_end < bounds.start) continue;
      periodDays = r.status === 'WAIVED' ? 0 : overlapDays(r.breakdown_start, effEnd < r.breakdown_start ? r.breakdown_start : effEnd, bounds.start, bounds.end);
    }

    if (projectId && String(projectId) !== 'ALL') {
      if (String(r.project_id || '') !== String(projectId) && String(r.project_name || '').toLowerCase() !== String(projectId).toLowerCase()) {
        continue;
      }
    }
    if (assetCode) {
      const q = String(assetCode).trim().toUpperCase();
      if (!String(r.vehicle_code || '').toUpperCase().includes(q) && !String(r.registration || '').toUpperCase().includes(q)) {
        continue;
      }
    }
    if (status && status !== 'ALL') {
      if (status === 'OPEN' && !r.is_open) continue;
      if (status === 'CLOSED' && (r.is_open || r.status === 'WAIVED')) continue;
      if (status === 'WAIVED' && r.status !== 'WAIVED') continue;
    }
    if (source && source !== 'ALL') {
      if (source === 'JOB_RECORDS' && r.source_type !== 'JOB_CARD' && r.source_type !== 'JOB_REQUEST') continue;
      if (source !== 'JOB_RECORDS' && r.source_type !== source) continue;
    }
    if (search) {
      const q = String(search).trim().toLowerCase();
      const hay = [
        r.vehicle_code, r.registration, r.project_name, r.job_no, r.jr_no, r.reason, r.category,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
    }

    const rc = r.asset_id ? rateCards.get(r.asset_id) : null;
    const dailyEstCents = estimateDailyUnbillableCents(rc, bounds ? bounds.daysInMonth : 30);
    const estUnbillableCents = r.status === 'WAIVED' ? 0 : Math.round(dailyEstCents * (periodDays || 0));

    filtered.push({
      ...r,
      period_days: periodDays,
      billing_blocked: r.is_open,
      has_active_bill_in_period: r.asset_id ? billedAssets.has(r.asset_id) : false,
      estimated_unbillable_cents: estUnbillableCents,
    });
  }

  // Sort: Open (Billing Blocked) first, then newest start date
  filtered.sort((a, b) => {
    if (a.is_open !== b.is_open) return a.is_open ? -1 : 1;
    return String(b.breakdown_start || '').localeCompare(String(a.breakdown_start || '')) || String(a.vehicle_code || '').localeCompare(String(b.vehicle_code || ''));
  });

  // Deduplicated downtime day count across filtered records
  const daySetsByAsset = new Map();
  const blockedAssets = new Set();
  const sitesSet = new Set();
  let estTotalCents = 0;

  for (const r of filtered) {
    if (r.is_open && r.asset_id) blockedAssets.add(r.asset_id);
    if (r.project_name) sitesSet.add(r.project_name);
    estTotalCents += r.estimated_unbillable_cents || 0;

    if (r.status === 'WAIVED' || !r.asset_id) continue;
    const wStart = bounds ? (r.breakdown_start < bounds.start ? bounds.start : r.breakdown_start) : r.breakdown_start;
    const rawEnd = r.breakdown_end || (bounds && bounds.end < nowDay ? bounds.end : nowDay);
    const wEnd = bounds ? (rawEnd > bounds.end ? bounds.end : rawEnd) : rawEnd;
    if (!wStart || !wEnd || wEnd < wStart) continue;

    if (!daySetsByAsset.has(r.asset_id)) daySetsByAsset.set(r.asset_id, new Set());
    const set = daySetsByAsset.get(r.asset_id);
    // Cap loop safely at 400 days per record to prevent runaway ranges
    let cur = wStart;
    for (let i = 0; i < 400 && cur <= wEnd; i++) {
      set.add(cur);
      cur = addDays(cur, 1);
    }
  }

  let totalUniqueDays = 0;
  for (const set of daySetsByAsset.values()) totalUniqueDays += set.size;

  return {
    breakdowns: filtered,
    summary: {
      totalRecords: filtered.length,
      openCount: filtered.filter((r) => r.is_open).length,
      blockedAssetsCount: blockedAssets.size,
      totalBreakdownDays: totalUniqueDays,
      sitesAffected: sitesSet.size,
      estimatedUnbillableCents: estTotalCents,
    },
    sites: [...siteMap.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

/**
 * Evaluate breakdown status for one asset in a billing period ('YYYY-MM').
 * Returns:
 *   - billingBlocked: true if any open (unclosed) breakdown overlaps the billing period
 *   - blockReason: human-readable message explaining which job/breakdown blocks billing
 *   - breakdownDays: unique closed downtime calendar days inside [monthStart, monthEnd]
 *   - records: overlapping breakdown records
 */
function getAssetBillingBreakdownStatus(assetId, periodKey) {
  const bounds = monthBounds(periodKey);
  if (!assetId || !bounds) {
    return {
      billingBlocked: false,
      blockReason: null,
      breakdownDays: 0,
      openBreakdowns: [],
      records: [],
    };
  }

  const nowDay = todayStr();
  const records = buildUnifiedRecords({ assetId: Number(assetId), scopeMode: 'all' });
  const overlapping = [];
  const openBreakdowns = [];
  const closedDaySet = new Set();

  for (const r of records) {
    if (r.status === 'WAIVED') continue;
    if (r.breakdown_start > bounds.end) continue;
    if (r.breakdown_end && r.breakdown_end < bounds.start) continue;

    overlapping.push(r);
    if (r.is_open) {
      openBreakdowns.push(r);
    } else {
      const s = r.breakdown_start < bounds.start ? bounds.start : r.breakdown_start;
      const e = (r.breakdown_end || r.breakdown_start) > bounds.end ? bounds.end : (r.breakdown_end || r.breakdown_start);
      let cur = s;
      for (let i = 0; i < 32 && cur <= e; i++) {
        closedDaySet.add(cur);
        cur = addDays(cur, 1);
      }
    }
  }

  let blockReason = null;
  if (openBreakdowns.length > 0) {
    const first = openBreakdowns[0];
    const ref = first.job_no ? `Job ${first.job_no}` : (first.jr_no ? `Request ${first.jr_no}` : `Breakdown ${first.id}`);
    blockReason = `Cannot bill ${first.vehicle_code || 'machine'} for ${bounds.periodKey}: open breakdown since ${first.breakdown_start} (${ref} — ${first.reason}). Close the job or adjust the close date in Breakdown Monitoring first.`;
  } else if (closedDaySet.size >= bounds.daysInMonth) {
    // Broken down the entire month -> cannot bill rental
    const first = overlapping[0];
    blockReason = `Machine ${first ? first.vehicle_code : ''} was broken down for all ${bounds.daysInMonth} days of ${bounds.periodKey} and cannot be billed.`;
  }

  // Note: if open breakdown exists AND has already accumulated days in this month up to today/monthEnd
  const allDaysSet = new Set(closedDaySet);
  for (const r of openBreakdowns) {
    const s = r.breakdown_start < bounds.start ? bounds.start : r.breakdown_start;
    const rawEnd = bounds.end < nowDay ? bounds.end : nowDay;
    const e = rawEnd > bounds.end ? bounds.end : rawEnd;
    let cur = s;
    for (let i = 0; i < 32 && cur <= e; i++) {
      allDaysSet.add(cur);
      cur = addDays(cur, 1);
    }
  }

  return {
    billingBlocked: openBreakdowns.length > 0,
    fullMonthDown: closedDaySet.size >= bounds.daysInMonth,
    blockReason,
    breakdownDays: openBreakdowns.length > 0 ? allDaysSet.size : closedDaySet.size,
    closedBreakdownDays: closedDaySet.size,
    openBreakdowns,
    records: overlapping,
  };
}

/**
 * Admin adjustment of start date, close date, reason, or waived status for any breakdown record.
 * Persists override in fleet_breakdowns without altering original workshop audit dates.
 */
function adjustBreakdownRecord(actor, idOrKey, body = {}) {
  const key = String(idOrKey || '').trim();
  if (!key) {
    const err = new Error('Breakdown ID or record key is required');
    err.status = 400;
    throw err;
  }

  const actorId = actor ? actor.id : null;
  const startIn = body.breakdownStart !== undefined ? d10(body.breakdownStart) : undefined;
  const rawEnd = body.breakdownEnd;
  const endIn = rawEnd === undefined
    ? undefined
    : (rawEnd === null || String(rawEnd).trim() === '' ? null : d10(rawEnd));

  if (body.breakdownStart !== undefined && !startIn) {
    const err = new Error('Start date must be a valid YYYY-MM-DD date');
    err.status = 400;
    throw err;
  }
  if (rawEnd !== undefined && rawEnd !== null && String(rawEnd).trim() !== '' && !endIn) {
    const err = new Error('Close date must be a valid YYYY-MM-DD date or left blank if still down');
    err.status = 400;
    throw err;
  }

  const requestedStatus = body.status ? String(body.status).toUpperCase() : null;
  if (requestedStatus && !['OPEN', 'CLOSED', 'WAIVED'].includes(requestedStatus)) {
    const err = new Error('Status must be OPEN, CLOSED, or WAIVED');
    err.status = 400;
    throw err;
  }

  // Locate existing record in unified view
  const allRecs = buildUnifiedRecords({ scopeMode: 'all' });
  const existing = allRecs.find((r) => r.id === key || r.key === key);
  if (!existing) {
    const err = new Error(`Breakdown record not found: ${key}`);
    err.status = 404;
    throw err;
  }

  const nextStart = startIn || existing.breakdown_start;
  let nextEnd = endIn !== undefined ? endIn : existing.breakdown_end;
  let nextStatus = requestedStatus;
  if (!nextStatus) {
    nextStatus = nextEnd ? 'CLOSED' : 'OPEN';
  }
  if (nextStatus === 'OPEN') {
    nextEnd = null;
  } else if (nextStatus === 'CLOSED' && !nextEnd) {
    nextEnd = todayStr();
  }

  if (nextEnd && nextEnd < nextStart) {
    const err = new Error('Close date cannot be earlier than start date');
    err.status = 400;
    throw err;
  }

  const nextReason = body.reason !== undefined && String(body.reason).trim() !== ''
    ? String(body.reason).trim()
    : existing.reason;
  const adjNote = body.adjustmentNote !== undefined ? String(body.adjustmentNote || '').trim() : existing.adjustment_note;
  const nextDays = nextStatus === 'WAIVED'
    ? 0
    : (nextEnd ? daysBetweenInclusive(nextStart, nextEnd) : null);

  let savedId;
  if (existing.source_type === 'JOB_CARD' && existing.job_card_id) {
    const ov = get('SELECT * FROM fleet_breakdowns WHERE job_card_id = ?', existing.job_card_id);
    if (ov) {
      savedId = ov.id;
      run(`
        UPDATE fleet_breakdowns
           SET breakdown_start = ?,
               breakdown_end = ?,
               total_days = ?,
               reason = ?,
               status = ?,
               adjusted_by = ?,
               adjusted_at = datetime('now'),
               adjustment_note = ?,
               updated_at = datetime('now')
         WHERE id = ?
      `, nextStart, nextEnd, nextDays, nextReason, nextStatus, actorId, adjNote || null, savedId);
    } else {
      savedId = `fbd-jc-${existing.job_card_id}`;
      run(`
        INSERT INTO fleet_breakdowns (
          id, asset_id, asset_code, project_id, site_name,
          source_type, job_card_id, job_no, job_request_id, jr_no,
          breakdown_start, breakdown_end, orig_start_date, orig_end_date,
          total_days, reason, status, adjusted_by, adjusted_at, adjustment_note,
          reported_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'JOB_CARD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, datetime('now'), datetime('now'))
      `, savedId, existing.asset_id, existing.vehicle_code || 'UNKNOWN', existing.project_id || null,
         existing.project_name || null, existing.job_card_id, existing.job_no || null,
         existing.job_request_id || null, existing.jr_no || null,
         nextStart, nextEnd, existing.orig_start_date || nextStart, existing.orig_end_date || null,
         nextDays, nextReason, nextStatus, actorId, adjNote || null, actorId);
    }
  } else if (existing.source_type === 'JOB_REQUEST' && existing.job_request_id) {
    const ov = get('SELECT * FROM fleet_breakdowns WHERE job_request_id = ? AND job_card_id IS NULL', existing.job_request_id);
    if (ov) {
      savedId = ov.id;
      run(`
        UPDATE fleet_breakdowns
           SET breakdown_start = ?,
               breakdown_end = ?,
               total_days = ?,
               reason = ?,
               status = ?,
               adjusted_by = ?,
               adjusted_at = datetime('now'),
               adjustment_note = ?,
               updated_at = datetime('now')
         WHERE id = ?
      `, nextStart, nextEnd, nextDays, nextReason, nextStatus, actorId, adjNote || null, savedId);
    } else {
      savedId = `fbd-jr-${existing.job_request_id}`;
      run(`
        INSERT INTO fleet_breakdowns (
          id, asset_id, asset_code, project_id, site_name,
          source_type, job_card_id, job_no, job_request_id, jr_no,
          breakdown_start, breakdown_end, orig_start_date, orig_end_date,
          total_days, reason, status, adjusted_by, adjusted_at, adjustment_note,
          reported_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'JOB_REQUEST', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, datetime('now'), datetime('now'))
      `, savedId, existing.asset_id, existing.vehicle_code || 'UNKNOWN', existing.project_id || null,
         existing.project_name || null, existing.job_request_id, existing.jr_no || null,
         nextStart, nextEnd, existing.orig_start_date || nextStart, existing.orig_end_date || null,
         nextDays, nextReason, nextStatus, actorId, adjNote || null, actorId);
    }
  } else if (existing.source_type === 'MANUAL') {
    savedId = existing.id;
    run(`
      UPDATE fleet_breakdowns
         SET breakdown_start = ?,
             breakdown_end = ?,
             total_days = ?,
             reason = ?,
             status = ?,
             adjusted_by = ?,
             adjusted_at = datetime('now'),
             adjustment_note = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `, nextStart, nextEnd, nextDays, nextReason, nextStatus, actorId, adjNote || null, savedId);
  } else {
    // Daily condition converted to an adjusted breakdown record
    savedId = `fbd-cond-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    run(`
      INSERT INTO fleet_breakdowns (
        id, asset_id, asset_code, project_id, site_name,
        source_type, breakdown_start, breakdown_end, orig_start_date, orig_end_date,
        total_days, reason, status, adjusted_by, adjusted_at, adjustment_note,
        reported_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'DAILY_CONDITION', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, datetime('now'), datetime('now'))
    `, savedId, existing.asset_id, existing.vehicle_code || 'UNKNOWN', existing.project_id || null,
       existing.project_name || null, nextStart, nextEnd, existing.orig_start_date || nextStart,
       existing.orig_end_date || null, nextDays, nextReason, nextStatus, actorId, adjNote || null, actorId);
  }

  audit.record({
    userId: actorId,
    entity: 'fleet_breakdown',
    entityId: existing.job_card_id || existing.job_request_id || existing.asset_id || null,
    action: 'hire.breakdown.adjusted',
    before: {
      key,
      start: existing.breakdown_start,
      end: existing.breakdown_end,
      status: existing.status,
    },
    after: {
      id: savedId,
      start: nextStart,
      end: nextEnd,
      status: nextStatus,
      total_days: nextDays,
      note: adjNote || null,
    },
    reason: adjNote || `Admin adjusted breakdown dates for ${existing.vehicle_code}`,
  });

  const updated = buildUnifiedRecords({ assetId: existing.asset_id, scopeMode: 'all' })
    .find((r) => r.id === savedId || r.key === existing.key);

  return updated || {
    id: savedId,
    breakdown_start: nextStart,
    breakdown_end: nextEnd,
    status: nextStatus,
    total_days: nextDays,
    reason: nextReason,
  };
}

module.exports = {
  todayStr,
  d10,
  monthBounds,
  daysBetweenInclusive,
  buildUnifiedRecords,
  listBreakdowns,
  getAssetBillingBreakdownStatus,
  adjustBreakdownRecord,
};
