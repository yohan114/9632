'use strict';

// Daily Work — read + light-edit views over job_daily_work for reviewing what was
// done day by day (across all jobs/vehicles). Also resolves each entry's mechanic(s)
// to their hourly rate and computes the labour cost for that line.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, toNum, toInt } = require('../lib/http');
const audit = require('../lib/audit');
const costing = require('../lib/costing');
const mechanics = require('../lib/mechanics');
const aliases = require('../lib/aliases');
const attendance = require('../lib/attendance');
const { sendXlsx } = require('../lib/export');

const router = express.Router();
const jobstate = require('../lib/jobstate');
const workshops = require('../lib/workshops');
const scope = require('../lib/scope');

// Daily work on a card follows the same rule as the job card's own Daily Work section
// (jobstate.checkAdd 'daily_work'): a CLOSED card needs "Change items on a CLOSED job card".
// This page used to add to, edit and delete lines on closed cards without asking. Throws, so a
// batch that touches one closed card it may not change is refused whole, not half-applied.
//
// `dates`: the work dates the write touches (a moved line touches two). A day that has been
// signed off (attendance, src/lib/attendance.js) is locked — nothing on it changes until a
// manager unlocks it. While attendance is switched off there is no lock.
function assertDailyWorkAllowed(jobId, user, dates = []) {
  // The day lock of the card's own workshop (Stage 4; the whole company's while not kept apart).
  const card = jobId ? get('SELECT workshop_id FROM job_cards WHERE id = ?', jobId) : null;
  attendance.assertDaysOpen(dates, card && card.workshop_id);
  if (!jobId) return;
  // Stage 3: only your own workshop's cards (head office and store staff: any).
  const notMine = scope.jobRefusal(user, jobId);
  if (notMine) { const e = new Error(notMine.error); e.status = 403; throw e; }
  // The dates also matter on a partly closed card: only work up to its partial-close day.
  const g = jobstate.checkAdd(get('SELECT id, job_no, status, asset_id, partial_closed_at FROM job_cards WHERE id = ?', jobId), 'daily_work', { user, dates });
  if (!g.ok) { const e = new Error(g.body.error); e.status = g.status; throw e; }
}

// How far outside a card's own window a day's work may still be claimed by it. An open card
// legitimately runs past its start, so this is generous — but it is a LIMIT. Without one, the
// newest open card for a vehicle swallowed every entry regardless of date: one REQUESTED card
// ended up holding nine months of work, and a 2026 work day could attach to a 2023 card simply
// because it was that vehicle's only other card.
const JOB_MATCH_SLACK_DAYS = 45;

// Resolve the (asset, date) to the job a manually-logged entry belongs to. Preference order:
// a card whose own window contains the date, then the nearest card within the slack window,
// then nothing — and "nothing" is the right answer, because the caller raises a fresh card for
// the day rather than hanging the work on an unrelated job.
function jobForEntry(assetId, date) {
  // A partly closed card takes no work dated after its partial-close day (jobstate.checkAdd), so
  // it is never the answer for one: that work belongs on the vehicle's new card.
  const jobs = all('SELECT id, job_no, requested_at, completed_at, closed_at, partial_closed_at, status FROM job_cards WHERE asset_id = ?', assetId)
    .filter((j) => !(j.status === jobstate.PARTIAL && date > jobstate.partialDay(j)));
  if (!jobs.length) return null;
  const day = (v) => String(v || '').slice(0, 10);
  const isOpen = (j) => jobstate.isOpen(j.status);
  const span = (j) => {
    const s = day(j.requested_at);
    // An open card has no end yet, so its window runs to today. A partly closed one ends on its
    // partial-close day: later work belongs on the vehicle's new card.
    const e = isOpen(j) ? new Date().toISOString().slice(0, 10) : day(j.closed_at || j.partial_closed_at || j.completed_at || j.requested_at);
    return [s, e < s ? s : e];
  };
  const gap = (j) => {
    const [s, e] = span(j);
    if (date >= s && date <= e) return 0;
    return Math.min(Math.abs(new Date(date) - new Date(s)), Math.abs(new Date(date) - new Date(e))) / 86400000;
  };

  // Cards that actually cover the day — an open one wins over a closed one.
  const covering = jobs.filter((j) => gap(j) === 0);
  if (covering.length) {
    const open = covering.filter(isOpen);
    return (open.length ? open : covering)
      .sort((a, b) => day(b.requested_at).localeCompare(day(a.requested_at)))[0];
  }

  // Otherwise the nearest card, but only if it is genuinely near.
  let best = null; let bg = Infinity;
  for (const j of jobs) { const g = gap(j); if (g < bg) { bg = g; best = j; } }
  return bg <= JOB_MATCH_SLACK_DAYS ? best : null;
}

// Shared container job for general (non-vehicle) workshop daily work — one per workshop
// (src/lib/workshops.js). No workshop given: the main workshop's, the card that always existed.
function generalWorkshopJob(workshopId = null) {
  return workshops.generalCardId(workshopId, { create: true, description: 'General workshop daily work (not vehicle-specific)' });
}

// Job number for a system-created daily-work card: YYYY/M/R/G<n> for the work month. The "G"
// keeps these out of the office's own numeric sequence, so a real card imported later can never
// collide with one of these (job_no is UNIQUE).
function nextAutoJobNo(date) {
  const [y, m] = date.split('-');
  const prefix = `${Number(y)}/${Number(m)}/R/G`;
  let max = 0;
  for (const r of all('SELECT job_no FROM job_cards WHERE job_no LIKE ?', prefix + '%')) {
    const n = parseInt(String(r.job_no).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + (max + 1);
}

function assetLabel(assetId, fallback) {
  const a = get('SELECT code, registration, ec_code FROM assets WHERE id = ?', assetId);
  if (!a) return fallback || ('asset ' + assetId);
  const reg = a.registration, code = a.ec_code || a.code;
  if (reg && code && reg !== code) return `${reg} (${code})`;
  return reg || code || fallback || ('asset ' + assetId);
}

// The job card that carries general daily work booked to a VEHICLE. Order of preference:
//   1. a real open card for that vehicle — never run a parallel card beside live work;
//   2. this month's existing auto card for the vehicle (one per vehicle per month), with its
//      date window widened to cover the new day;
//   3. a new card, CLOSED on the work date, so the cost lands in that month under the vehicle.
// Exempt from "a card needs an approved job request" (routes/jobcards.js): the monthly container
// is created already CLOSED, to carry a cost to a vehicle and a month. Nobody requests it.
function autoVehicleJob(assetId, date, rawLabel, user = null) {
  // Reuse the vehicle's open card only if this day's work actually falls in its life. Without
  // the date bound the newest open card claimed everything: one REQUESTED card ended up holding
  // nine months of daily work for its vehicle.
  const open = get(
    `SELECT id FROM job_cards WHERE asset_id = ? AND ${jobstate.openSql()}
        AND date(COALESCE(requested_at, created_at)) <= date(?, '+' || ? || ' day')
        AND date(?) <= date('now', '+' || ? || ' day')
      ORDER BY date(COALESCE(requested_at, created_at)) DESC, id DESC LIMIT 1`,
    assetId, date, JOB_MATCH_SLACK_DAYS, date, JOB_MATCH_SLACK_DAYS);
  // Stage 3: the vehicle's open card only if this person may work on it; otherwise their own
  // workshop's auto card for the month (one per vehicle per month per workshop).
  if (open && !(user && scope.jobRefusal(user, open.id))) return { id: open.id, created: false };
  const ws = user ? workshops.homeOf(user) : workshops.defaultId();

  const mine = get(
    `SELECT id FROM job_cards WHERE asset_id = ? AND legacy_ref = 'auto-container-labour'
        AND substr(COALESCE(completed_at, requested_at), 1, 7) = ? AND COALESCE(workshop_id, 0) = ? ORDER BY id DESC LIMIT 1`,
    assetId, date.slice(0, 7), ws || 0);
  if (mine) {
    run(`UPDATE job_cards
            SET requested_at = MIN(COALESCE(requested_at, ?), ?),
                completed_at = MAX(COALESCE(completed_at, ?), ?),
                closed_at    = MAX(COALESCE(closed_at, ?), ?),
                updated_at   = datetime('now')
          WHERE id = ?`, date, date, date, date, date, date, mine.id);
    return { id: mine.id, created: false };
  }

  const id = run(
    `INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_by,
        requested_at, started_at, completed_at, closed_at, synthesized_no, legacy_ref, workshop_id)
     VALUES (?, ?, 'repair', ?, 'CLOSED', 'system', ?, ?, ?, ?, 1, 'auto-container-labour', ?)`,
    nextAutoJobNo(date), assetId, `Daily work for ${assetLabel(assetId, rawLabel)} (auto container)`,
    date, date, date, date, ws
  ).lastInsertRowid;
  return { id, created: true };
}

// Current hourly rate for a raw mechanic name (via the resolver), or null.
const rateCache = new Map();
function currentRate(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  if (rateCache.has(key)) return rateCache.get(key);
  const look = mechanics.lookupMechanic(key);
  const canonical = look.resolved ? look.name : key;
  const r = get('SELECT rate FROM labour_rates WHERE mechanic = ? ORDER BY effective_from DESC, id DESC LIMIT 1', canonical);
  const rate = r ? r.rate : null;
  rateCache.set(key, rate);
  return rate;
}

// Labour cost for one daily-work line: EACH named mechanic worked the full hours,
// so cost = hours × Σ(each mechanic's rate). e.g. "Anura, Krishna" @ 10h =
// 425×10 + 250×10 = 6,750.
function labourFor(entry) {
  if (entry.is_external) return { labour_cost: 0, crew: 0, rated: 0, unrated: [] };
  const names = mechanics.splitMechanics(entry.mechanic);
  if (!names.length) return { labour_cost: 0, crew: 0, rated: 0, unrated: [] };
  const hours = Number(entry.hours) || 0;
  let cost = 0, rated = 0;
  const unrated = [];
  for (const n of names) {
    const rate = currentRate(n);
    if (rate == null) unrated.push(n);
    else { cost += hours * rate; rated++; }
  }
  return { labour_cost: Math.round(cost * 100) / 100, crew: names.length, rated, unrated };
}

// Monthly summary of daily work: selected month's total hours + breakdown per mechanic/laborer.
// Supports ?month=YYYY-MM (defaults to latest month) and optional ?format=xlsx for Excel export.
router.get('/monthly-summary', requireCap('dailywork.view'), asyncHandler(async (req, res) => {
  rateCache.clear();
  // Step 2b: your own workshops' month, like the rest of this page.
  const own = scope.filter(req.user, 'j.workshop_id');
  const andOwn = own.sql ? ` AND ${own.sql}` : '';

  const months = all(
    `SELECT DISTINCT strftime('%Y-%m', w.work_date) AS month
       FROM job_daily_work w LEFT JOIN job_cards j ON j.id = w.job_id
      WHERE w.work_date IS NOT NULL${andOwn}
      ORDER BY month DESC`, ...own.params
  ).map((r) => r.month).filter(Boolean);

  let month = String(req.query.month || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    month = months.length ? months[0] : new Date().toISOString().slice(0, 7);
  }

  const rows = all(
    `SELECT w.*, j.job_no, a.code AS asset_code
       FROM job_daily_work w
       JOIN job_cards j ON j.id = w.job_id
       LEFT JOIN assets a ON a.id = j.asset_id
      WHERE strftime('%Y-%m', w.work_date) = ?${andOwn}
      ORDER BY w.work_date, w.id`,
    month, ...own.params
  );

  const jlRows = all(
    `SELECT jl.mechanic, SUM(jl.amount) AS total_cost, COUNT(*) AS entries
       FROM job_labour jl LEFT JOIN job_cards j ON j.id = jl.job_id
      WHERE substr(jl.work_date,1,7) = ?${andOwn}
      GROUP BY jl.mechanic`,
    month, ...own.params
  );
  const jlMap = new Map();
  for (const r of jlRows) {
    const canonical = mechanics.resolveMechanicName(r.mechanic);
    const existing = jlMap.get(canonical) || { total_cost: 0, entries: 0 };
    jlMap.set(canonical, {
      total_cost: existing.total_cost + (Number(r.total_cost) || 0),
      entries: existing.entries + (Number(r.entries) || 0)
    });
  }

  const mechMap = new Map();
  let totalLineHours = 0;
  let externalValueTotal = 0;

  for (const w of rows) {
    if (w.is_external) {
      externalValueTotal += Number(w.external_value) || 0;
      continue;
    }
    const hrs = Number(w.hours) || 0;
    totalLineHours += hrs;

    const names = mechanics.splitMechanics(w.mechanic);
    if (!names.length) continue;

    for (const rawName of names) {
      const canonical = mechanics.resolveMechanicName(rawName);
      if (!mechMap.has(canonical)) {
        const rate = currentRate(canonical);
        const jlData = jlMap.get(canonical) || { total_cost: 0, entries: 0 };
        mechMap.set(canonical, {
          mechanic: canonical,
          total_hours: 0,
          rate,
          total_cost: jlData.total_cost,
          entries: jlData.entries
        });
      }
      const m = mechMap.get(canonical);
      m.total_hours += hrs;
    }
  }

  // Add any mechanics in job_labour not in daily_work rows
  for (const [canonical, jlData] of jlMap.entries()) {
    if (!mechMap.has(canonical)) {
      mechMap.set(canonical, {
        mechanic: canonical,
        total_hours: 0,
        rate: currentRate(canonical),
        total_cost: jlData.total_cost,
        entries: jlData.entries
      });
    }
  }

  const totalLabourCost = [...mechMap.values()].reduce((s, m) => s + (m.total_cost || 0), 0);
  const mechStatusMap = new Map(all('SELECT name, status, active, left_date, left_reason FROM mechanics').map((m) => [m.name, m]));

  const laborSummary = [...mechMap.values()]
    .map((m) => {
      const st = mechStatusMap.get(m.mechanic) || {};
      return {
        ...m,
        status: st.status || 'active',
        active: st.active !== undefined ? st.active : 1,
        left_date: st.left_date || null,
        left_reason: st.left_reason || null,
        total_hours: Math.round(m.total_hours * 100) / 100,
        total_cost: Math.round(m.total_cost * 100) / 100,
      };
    })
    .sort((a, b) => b.total_cost - a.total_cost);
  const mechanicsCount = laborSummary.length;

  // Attendance (when switched on): hours at work, hours booked and utilisation, over the days the
  // tally runs. A mechanic who was at work but booked nothing this month still gets a row — that is
  // exactly the case worth seeing. Labour cost is untouched: it stays booked hours × rate.
  let att = null;
  if (attendance.isEnabled()) {
    // Step 2b: your own workshop's attendance when you are kept to it (head office: everyone's).
    att = attendance.month(month, { ws: scope.enabled() ? scope.onlyWorkshop(req.user, { store: false }) : null });
    const byNorm = new Map(att.mechanics.map((m) => [mechanics.normalizeMechanic(m.name), m]));
    for (const l of laborSummary) {
      const a = byNorm.get(mechanics.normalizeMechanic(l.mechanic));
      byNorm.delete(mechanics.normalizeMechanic(l.mechanic));
      l.attended_hours = a ? a.attended_hours : 0;
      l.booked_hours = a ? a.booked_hours : 0;
      l.utilisation = a ? a.utilisation : null;
    }
    for (const a of byNorm.values()) {
      laborSummary.push({ mechanic: a.name, total_hours: 0, rate: currentRate(a.name), total_cost: 0, entries: 0,
        attended_hours: a.attended_hours, booked_hours: a.booked_hours, utilisation: a.utilisation });
    }
  }

  const monthLabels = {
    '01': 'January', '02': 'February', '03': 'March', '04': 'April',
    '05': 'May', '06': 'June', '07': 'July', '08': 'August',
    '09': 'September', '10': 'October', '11': 'November', '12': 'December'
  };
  const formatMonthLabel = (m) => {
    const [y, mm] = m.split('-');
    return `${monthLabels[mm] || mm} ${y}`;
  };

  const availableMonths = months.map((m) => ({
    month: m,
    label: formatMonthLabel(m),
  }));

  if (req.query.format === 'xlsx') {
    const exportRows = laborSummary.map((l) => ({
      mechanic: l.mechanic,
      total_hours: l.total_hours,
      rate: l.rate != null ? l.rate : 'No Rate',
      total_cost: l.total_cost,
      entries: l.entries,
      attended_hours: l.attended_hours,
      booked_hours: l.booked_hours,
      utilisation: l.utilisation == null ? '' : l.utilisation,
    }));
    const columns = [
      { header: 'Laborer / Mechanic', key: 'mechanic', width: 26 },
      { header: 'Monthly Working Hours', key: 'total_hours', width: 22 },
      { header: 'Hourly Rate (Rs/h)', key: 'rate', width: 18 },
      { header: 'Monthly Labour Cost (Rs)', key: 'total_cost', width: 24 },
      { header: 'Work Entries', key: 'entries', width: 14 },
    ];
    if (att) {
      columns.push({ header: 'Attended (h)', key: 'attended_hours', width: 14 },
        { header: 'Booked (h)', key: 'booked_hours', width: 12 },
        { header: 'Utilisation %', key: 'utilisation', width: 14 });
    }
    return sendXlsx(res, `labor-hours-${month}.xlsx`, [{
      name: `Labor Hours ${month}`,
      columns,
      rows: exportRows
    }]);
  }

  res.json({
    month,
    month_label: formatMonthLabel(month),
    available_months: availableMonths,
    total_line_hours: Math.round(totalLineHours * 100) / 100,
    total_labour_cost: Math.round(totalLabourCost * 100) / 100,
    external_value_total: Math.round(externalValueTotal * 100) / 100,
    mechanics_count: mechanicsCount,
    entries_count: rows.length,
    labor_summary: laborSummary,
    ...(att ? { attendance: { from: att.from, to: att.to } } : {}),
  });
}));

// ===========================================================================
// Mechanics KPI & Outside Cost vs. Internal Hourly Rate Analytics Engine
// ===========================================================================
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function requireKpiAccess(req, res, next) {
  const permissions = require('../lib/permissions');
  const { hasCap } = require('../lib/auth');
  if (
    hasCap(req.user, 'dailywork.view') ||
    permissions.reaches(req.user, 'dailywork') ||
    permissions.reaches(req.user, 'labour') ||
    permissions.reaches(req.user, 'reports')
  ) {
    return next();
  }
  return res.status(403).json({ error: 'Requires Daily Work, Mechanics/Labour, or Reports access' });
}

router.get('/mechanics-kpi', requireKpiAccess, asyncHandler(async (req, res) => {
  rateCache.clear();
  const own = scope.filter(req.user, 'j.workshop_id');
  const andOwn = own.sql ? ` AND ${own.sql}` : '';

  const months = all(
    `SELECT DISTINCT strftime('%Y-%m', w.work_date) AS month
       FROM job_daily_work w LEFT JOIN job_cards j ON j.id = w.job_id
      WHERE w.work_date IS NOT NULL${andOwn}
      ORDER BY month DESC`, ...own.params
  ).map((r) => r.month).filter(Boolean);

  const qFrom = String(req.query.from || '').slice(0, 10);
  const qTo = String(req.query.to || '').slice(0, 10);
  const isCustomRange = /^\d{4}-\d{2}-\d{2}$/.test(qFrom) && /^\d{4}-\d{2}-\d{2}$/.test(qTo);

  let month = String(req.query.month || '').slice(0, 7);
  if (!isCustomRange && !/^\d{4}-\d{2}$/.test(month)) {
    const slCurMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date()).slice(0, 7);
    month = months.length ? months[0] : slCurMonth;
  }

  const wsFilterId = toInt(req.query.workshop_id);
  const mechFilterRaw = String(req.query.mechanic || '').trim();
  const mechFilterCanon = mechFilterRaw ? mechanics.resolveMechanicName(mechFilterRaw) : '';

  const conds = [];
  const params = [];
  if (isCustomRange) {
    conds.push('w.work_date >= ? AND w.work_date <= ?');
    params.push(qFrom, qTo);
  } else {
    conds.push("strftime('%Y-%m', w.work_date) = ?");
    params.push(month);
  }
  if (wsFilterId) {
    conds.push('j.workshop_id = ?');
    params.push(wsFilterId);
  }
  if (own.sql) {
    conds.push(own.sql);
    params.push(...own.params);
  }

  const rows = all(
    `SELECT w.*, j.job_no, j.asset_id AS job_asset_id, j.workshop_id, j.outside_estimate AS job_outside_estimate,
            j.status AS job_status, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            ws.name AS workshop_name, ws.code AS workshop_code
       FROM job_daily_work w
       JOIN job_cards j ON j.id = w.job_id
       LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN workshops ws ON ws.id = j.workshop_id
      WHERE ${conds.join(' AND ')}
      ORDER BY w.work_date DESC, w.id DESC`,
    ...params
  );

  const wsOn = workshops.mechanicWorkshopSql('m');
  const mechProfiles = new Map(
    all(`SELECT m.id, m.name, m.status, m.active,
                ws.name AS workshop_name, ws.code AS workshop_code,
                (${wsOn}) AS workshop_id
           FROM mechanics m
           LEFT JOIN workshops ws ON ws.id = (${wsOn})`).map((m) => [m.name, m])
  );

  const mechMap = new Map();
  const dailyTrendMap = new Map();
  const vehicleMap = new Map();
  const unpricedLines = [];
  const distinctJobs = new Map();
  const distinctVehicles = new Set();

  let totalLineHours = 0;
  let totalBookedMechanicHours = 0;
  let totalRegularHours = 0;
  let totalTravelHours = 0;
  let totalInternalCost = 0;
  let totalOutsideCost = 0;
  let externalOutsourceTotal = 0;
  let pricedEntriesCount = 0;
  let unpricedEntriesCount = 0;

  const ensureMechanic = (canonical) => {
    if (!mechMap.has(canonical)) {
      const prof = mechProfiles.get(canonical) || {};
      const rate = currentRate(canonical);
      mechMap.set(canonical, {
        mechanic: canonical,
        status: prof.status || 'active',
        active: prof.active !== undefined ? prof.active : 1,
        workshop_id: prof.workshop_id || null,
        workshop_name: prof.workshop_name || null,
        workshop_code: prof.workshop_code || null,
        current_rate: rate,
        regular_hours: 0,
        travel_hours: 0,
        total_hours: 0,
        internal_cost: 0,
        outside_cost: 0,
        raw_outside_cost: 0,
        entries_count: 0,
        priced_entries_count: 0,
        unpriced_entries_count: 0,
        solo_entries_count: 0,
        crew_entries_count: 0,
        jobs_set: new Set(),
        vehicles_set: new Set(),
      });
    }
    return mechMap.get(canonical);
  };

  for (const w of rows) {
    if (w.is_external) {
      externalOutsourceTotal += Number(w.external_value) || 0;
      continue;
    }

    const names = mechanics.splitMechanics(w.mechanic);
    const canonNames = names.length
      ? names.map((n) => mechanics.resolveMechanicName(n) || n)
      : (w.mechanic ? [mechanics.resolveMechanicName(w.mechanic) || w.mechanic] : []);

    if (mechFilterCanon && !canonNames.includes(mechFilterCanon)) {
      continue;
    }

    const hrs = Number(w.hours) || 0;
    const isTravel = Boolean(w.travel);
    const outsideVal = Number(w.outside_labour) || 0;
    const hasOutside = outsideVal > 0;

    totalLineHours += hrs;
    if (hasOutside) pricedEntriesCount++;
    else unpricedEntriesCount++;

    if (w.job_id) {
      distinctJobs.set(w.job_id, Number(w.job_outside_estimate) || 0);
    }
    if (w.job_asset_id) {
      distinctVehicles.add(w.job_asset_id);
    }

    // Calculate each crew member's effective rate & internal cost on this line
    const crewCosts = canonNames.map((canon) => {
      const effRate = costing.labourRateFor(canon, w.work_date) ?? currentRate(canon) ?? 0;
      const cost = hrs * effRate;
      return { canon, effRate, cost };
    });
    const lineInternalCost = crewCosts.reduce((s, c) => s + c.cost, 0);
    const crewCount = crewCosts.length || 1;

    totalOutsideCost += outsideVal;
    totalInternalCost += lineInternalCost;

    // Attribute outside cost proportionally across the crew so workshop totals never double-count
    for (const member of crewCosts) {
      const share = lineInternalCost > 0 ? (member.cost / lineInternalCost) : (1 / crewCount);
      const attrOutside = outsideVal * share;

      const m = ensureMechanic(member.canon);
      if (isTravel) {
        m.travel_hours += hrs;
        totalTravelHours += hrs;
      } else {
        m.regular_hours += hrs;
        totalRegularHours += hrs;
      }
      m.total_hours += hrs;
      totalBookedMechanicHours += hrs;
      m.internal_cost += member.cost;
      m.outside_cost += attrOutside;
      m.raw_outside_cost += outsideVal;
      m.entries_count += 1;
      if (hasOutside) m.priced_entries_count += 1;
      else m.unpriced_entries_count += 1;
      if (crewCount === 1) m.solo_entries_count += 1;
      else m.crew_entries_count += 1;
      if (w.job_id) m.jobs_set.add(w.job_id);
      if (w.job_asset_id) m.vehicles_set.add(w.job_asset_id);
    }

    // Daily trend accumulation
    const dKey = String(w.work_date || '').slice(0, 10);
    if (dKey) {
      const dt = dailyTrendMap.get(dKey) || { date: dKey, hours: 0, internal_cost: 0, outside_cost: 0, entries: 0 };
      dt.hours += hrs * crewCount;
      dt.internal_cost += lineInternalCost;
      dt.outside_cost += outsideVal;
      dt.entries += 1;
      dailyTrendMap.set(dKey, dt);
    }

    // Vehicle breakdown accumulation
    const vKey = w.job_asset_id || 'general';
    const vLabel = [w.asset_reg, w.asset_ec, w.asset_code].filter(Boolean).join(' · ') || 'General Workshop';
    const vb = vehicleMap.get(vKey) || { asset_id: w.job_asset_id, vehicle: vLabel, hours: 0, internal_cost: 0, outside_cost: 0, entries: 0 };
    vb.hours += hrs * crewCount;
    vb.internal_cost += lineInternalCost;
    vb.outside_cost += outsideVal;
    vb.entries += 1;
    vehicleMap.set(vKey, vb);

    // Collect unpriced lines so supervisors can fill in missing outside costs inline
    if (!hasOutside && unpricedLines.length < 150) {
      unpricedLines.push({
        id: w.id,
        work_date: w.work_date,
        job_id: w.job_id,
        job_no: w.job_no,
        vehicle: vLabel,
        mechanic: canonNames.join(', '),
        description: w.description || '',
        hours: r2(hrs),
        crew_count: crewCount,
        internal_cost: r2(lineInternalCost),
        outside_labour: w.outside_labour,
      });
    }
  }

  // Attendance & Utilisation merge (when viewing a single month and attendance is enabled)
  let attInfo = null;
  if (!isCustomRange && attendance.isEnabled()) {
    try {
      const attWs = wsFilterId || (scope.enabled() ? scope.onlyWorkshop(req.user, { store: false }) : null);
      const att = attendance.month(month, { ws: attWs });
      attInfo = { from: att.from, to: att.to };
      const byNorm = new Map(att.mechanics.map((m) => [mechanics.normalizeMechanic(m.name), m]));
      for (const m of mechMap.values()) {
        const a = byNorm.get(mechanics.normalizeMechanic(m.mechanic));
        if (a) {
          byNorm.delete(mechanics.normalizeMechanic(m.mechanic));
          m.attended_hours = a.attended_hours;
          m.booked_hours = a.booked_hours;
          m.utilisation = a.utilisation;
        }
      }
      if (!mechFilterCanon) {
        for (const a of byNorm.values()) {
          if ((a.attended_hours || 0) > 0) {
            const m = ensureMechanic(a.name);
            m.attended_hours = a.attended_hours;
            m.booked_hours = a.booked_hours;
            m.utilisation = a.utilisation;
          }
        }
      }
    } catch (e) { /* attendance optional */ }
  }

  const mechanicsScorecard = [...mechMap.values()].map((m) => {
    const intCost = r2(m.internal_cost);
    const outCost = r2(m.outside_cost);
    const netSav = r2(outCost - intCost);
    const totHrs = r2(m.total_hours);
    const roi = intCost > 0 ? r2(outCost / intCost) : 0;
    const effValPerHr = totHrs > 0 ? r2(outCost / totHrs) : 0;
    const netSavPerHr = totHrs > 0 ? r2(netSav / totHrs) : 0;
    const covPct = m.entries_count > 0 ? Math.round((m.priced_entries_count / m.entries_count) * 100) : 0;
    return {
      mechanic: m.mechanic,
      status: m.status,
      active: m.active,
      workshop_id: m.workshop_id,
      workshop_name: m.workshop_name,
      workshop_code: m.workshop_code,
      hourly_rate: m.current_rate,
      regular_hours: r2(m.regular_hours),
      travel_hours: r2(m.travel_hours),
      total_hours: totHrs,
      attended_hours: m.attended_hours !== undefined ? r2(m.attended_hours) : null,
      utilisation: m.utilisation !== undefined ? m.utilisation : null,
      internal_cost: intCost,
      outside_cost: outCost,
      raw_outside_cost: r2(m.raw_outside_cost),
      net_savings: netSav,
      roi_ratio: roi,
      effective_value_per_hr: effValPerHr,
      net_saving_per_hr: netSavPerHr,
      entries_count: m.entries_count,
      priced_entries_count: m.priced_entries_count,
      unpriced_entries_count: m.unpriced_entries_count,
      coverage_pct: covPct,
      solo_entries_count: m.solo_entries_count,
      crew_entries_count: m.crew_entries_count,
      jobs_count: m.jobs_set.size,
      vehicles_count: m.vehicles_set.size,
    };
  }).sort((a, b) => (b.net_savings - a.net_savings) || (b.total_hours - a.total_hours));

  const jobOutsideEstimateTotal = r2([...distinctJobs.values()].reduce((s, v) => s + v, 0));
  const totalEntries = pricedEntriesCount + unpricedEntriesCount;
  const coveragePct = totalEntries > 0 ? Math.round((pricedEntriesCount / totalEntries) * 100) : 0;
  const netSavingsTotal = r2(totalOutsideCost - totalInternalCost);
  const overallRoi = totalInternalCost > 0 ? r2(totalOutsideCost / totalInternalCost) : 0;
  const avgValuePerHr = totalBookedMechanicHours > 0 ? r2(totalOutsideCost / totalBookedMechanicHours) : 0;
  const avgWagePerHr = totalBookedMechanicHours > 0 ? r2(totalInternalCost / totalBookedMechanicHours) : 0;

  const dailyTrend = [...dailyTrendMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      hours: r2(d.hours),
      internal_cost: r2(d.internal_cost),
      outside_cost: r2(d.outside_cost),
      net_savings: r2(d.outside_cost - d.internal_cost),
      entries: d.entries,
    }));

  const topVehicles = [...vehicleMap.values()]
    .map((v) => ({
      ...v,
      hours: r2(v.hours),
      internal_cost: r2(v.internal_cost),
      outside_cost: r2(v.outside_cost),
      net_savings: r2(v.outside_cost - v.internal_cost),
    }))
    .sort((a, b) => b.outside_cost - a.outside_cost || b.hours - a.hours)
    .slice(0, 15);

  const monthLabels = {
    '01': 'January', '02': 'February', '03': 'March', '04': 'April',
    '05': 'May', '06': 'June', '07': 'July', '08': 'August',
    '09': 'September', '10': 'October', '11': 'November', '12': 'December'
  };
  const formatMonthLabel = (m) => {
    const [y, mm] = String(m || '').split('-');
    return `${monthLabels[mm] || mm} ${y || ''}`.trim();
  };

  if (req.query.format === 'xlsx') {
    const scorecardCols = [
      { header: 'Mechanic', key: 'mechanic', width: 24 },
      { header: 'Workshop', key: 'workshop_name', width: 18 },
      { header: 'Hourly Rate (Rs/hr)', key: 'hourly_rate', width: 18 },
      { header: 'Regular Hrs', key: 'regular_hours', width: 14 },
      { header: 'Travel Hrs', key: 'travel_hours', width: 13 },
      { header: 'Total Working Hrs', key: 'total_hours', width: 18 },
      { header: 'Attended Hrs', key: 'attended_hours', width: 14 },
      { header: 'Utilisation %', key: 'utilisation', width: 14 },
      { header: 'Internal Wage Cost (Rs)', key: 'internal_cost', width: 22 },
      { header: 'Outside Cost Value (Rs)', key: 'outside_cost', width: 22 },
      { header: 'Net Savings (Rs)', key: 'net_savings', width: 20 },
      { header: 'ROI Multiplier (x)', key: 'roi_ratio', width: 16 },
      { header: 'Value Generated / Hr (Rs)', key: 'effective_value_per_hr', width: 22 },
      { header: 'Distinct Jobs', key: 'jobs_count', width: 14 },
      { header: 'Distinct Vehicles', key: 'vehicles_count', width: 16 },
      { header: 'Outside Cost Coverage %', key: 'coverage_pct', width: 20 },
    ];
    const unpricedCols = [
      { header: 'Line ID', key: 'id', width: 10 },
      { header: 'Date', key: 'work_date', width: 12 },
      { header: 'Job No', key: 'job_no', width: 16 },
      { header: 'Vehicle', key: 'vehicle', width: 20 },
      { header: 'Mechanic(s)', key: 'mechanic', width: 24 },
      { header: 'Work Description', key: 'description', width: 42 },
      { header: 'Hours', key: 'hours', width: 10 },
      { header: 'Internal Wage Cost (Rs)', key: 'internal_cost', width: 20 },
      { header: 'Outside Cost (Rs) [To Fill]', key: 'outside_labour', width: 24 },
    ];
    const periodSlug = isCustomRange ? `${qFrom}_to_${qTo}` : month;
    return sendXlsx(res, `mechanics-kpi-${periodSlug}.xlsx`, [
      { name: 'Mechanics KPI Scorecard', columns: scorecardCols, rows: mechanicsScorecard },
      { name: 'Missing Outside Cost Lines', columns: unpricedCols, rows: unpricedLines },
    ]);
  }

  const workshopsList = all('SELECT id, code, name FROM workshops WHERE active = 1 ORDER BY is_default DESC, name');

  res.json({
    month: isCustomRange ? null : month,
    from: isCustomRange ? qFrom : `${month}-01`,
    to: isCustomRange ? qTo : `${month}-31`,
    period_label: isCustomRange ? `${qFrom} to ${qTo}` : formatMonthLabel(month),
    available_months: months.map((m) => ({ month: m, label: formatMonthLabel(m) })),
    workshops: workshopsList,
    period: {
      mode: isCustomRange ? 'range' : 'month',
      month: isCustomRange ? null : month,
      month_label: isCustomRange ? `${qFrom} to ${qTo}` : formatMonthLabel(month),
      from: isCustomRange ? qFrom : `${month}-01`,
      to: isCustomRange ? qTo : `${month}-31`,
      available_months: months.map((m) => ({ month: m, label: formatMonthLabel(m) })),
      workshops: workshopsList,
      attendance: attInfo,
    },
    summary: {
      mechanics_count: mechanicsScorecard.length,
      entries_count: totalEntries,
      priced_entries_count: pricedEntriesCount,
      unpriced_entries_count: unpricedEntriesCount,
      coverage_pct: coveragePct,
      total_line_hours: r2(totalLineHours),
      total_mechanic_hours: r2(totalBookedMechanicHours),
      total_hours: r2(totalBookedMechanicHours),
      regular_hours: r2(totalRegularHours),
      travel_hours: r2(totalTravelHours),
      total_internal_cost: r2(totalInternalCost),
      total_outside_cost: r2(totalOutsideCost),
      job_outside_estimate_total: jobOutsideEstimateTotal,
      external_outsource_total: r2(externalOutsourceTotal),
      net_savings: netSavingsTotal,
      roi_ratio: overallRoi,
      avg_value_per_hr: avgValuePerHr,
      avg_wage_per_hr: avgWagePerHr,
      distinct_jobs_count: distinctJobs.size,
      distinct_vehicles_count: distinctVehicles.size,
    },
    mechanics: mechanicsScorecard,
    unpriced_lines: unpricedLines,
    daily_trend: dailyTrend,
    top_vehicles: topVehicles,
  });
}));

// Detailed drill-down for a single mechanic over the selected month or date range
router.get('/mechanics-kpi/detail', requireKpiAccess, asyncHandler((req, res) => {
  rateCache.clear();
  const rawMech = String(req.query.mechanic || '').trim();
  if (!rawMech) return res.status(400).json({ error: 'mechanic parameter is required' });
  const targetCanon = mechanics.resolveMechanicName(rawMech) || rawMech;

  const own = scope.filter(req.user, 'j.workshop_id');
  const andOwn = own.sql ? ` AND ${own.sql}` : '';
  const qFrom = String(req.query.from || '').slice(0, 10);
  const qTo = String(req.query.to || '').slice(0, 10);
  const isCustomRange = /^\d{4}-\d{2}-\d{2}$/.test(qFrom) && /^\d{4}-\d{2}-\d{2}$/.test(qTo);
  let month = String(req.query.month || '').slice(0, 7);
  if (!isCustomRange && !/^\d{4}-\d{2}$/.test(month)) {
    const slCurMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date()).slice(0, 7);
    const months = all(
      `SELECT DISTINCT strftime('%Y-%m', w.work_date) AS month
         FROM job_daily_work w LEFT JOIN job_cards j ON j.id = w.job_id
        WHERE w.work_date IS NOT NULL${andOwn}
        ORDER BY month DESC`, ...own.params
    ).map((r) => r.month).filter(Boolean);
    month = months.length ? months[0] : slCurMonth;
  }

  const conds = [];
  const params = [];
  if (isCustomRange) {
    conds.push('w.work_date >= ? AND w.work_date <= ?');
    params.push(qFrom, qTo);
  } else {
    conds.push("strftime('%Y-%m', w.work_date) = ?");
    params.push(month);
  }
  if (req.query.workshop_id) {
    conds.push('j.workshop_id = ?');
    params.push(toInt(req.query.workshop_id));
  }
  if (own.sql) {
    conds.push(own.sql);
    params.push(...own.params);
  }

  const rows = all(
    `SELECT w.*, j.job_no, j.asset_id AS job_asset_id, j.outside_estimate AS job_outside_estimate,
            a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
       FROM job_daily_work w
       JOIN job_cards j ON j.id = w.job_id
       LEFT JOIN assets a ON a.id = j.asset_id
      WHERE ${conds.join(' AND ')}
      ORDER BY w.work_date DESC, w.id DESC`,
    ...params
  );

  const lines = [];
  for (const w of rows) {
    if (w.is_external) continue;
    const names = mechanics.splitMechanics(w.mechanic);
    const canonNames = names.length
      ? names.map((n) => mechanics.resolveMechanicName(n) || n)
      : (w.mechanic ? [mechanics.resolveMechanicName(w.mechanic) || w.mechanic] : []);
    if (!canonNames.includes(targetCanon)) continue;

    const hrs = Number(w.hours) || 0;
    const outsideVal = Number(w.outside_labour) || 0;
    const crewCosts = canonNames.map((canon) => {
      const effRate = costing.labourRateFor(canon, w.work_date) ?? currentRate(canon) ?? 0;
      return { canon, effRate, cost: hrs * effRate };
    });
    const lineInternalCost = crewCosts.reduce((s, c) => s + c.cost, 0);
    const me = crewCosts.find((c) => c.canon === targetCanon) || { effRate: currentRate(targetCanon) || 0, cost: 0 };
    const share = lineInternalCost > 0 ? (me.cost / lineInternalCost) : (1 / (crewCosts.length || 1));
    const attrOutside = outsideVal * share;

    lines.push({
      id: w.id,
      work_date: w.work_date,
      job_id: w.job_id,
      job_no: w.job_no,
      vehicle: [w.asset_reg, w.asset_ec, w.asset_code].filter(Boolean).join(' · ') || 'General Workshop',
      description: w.description || '',
      crew: canonNames,
      is_crew: canonNames.length > 1,
      travel: Boolean(w.travel),
      hours: r2(hrs),
      hourly_rate: me.effRate,
      internal_cost: r2(me.cost),
      line_outside_cost: r2(outsideVal),
      attributed_outside_cost: r2(attrOutside),
      net_saving: r2(attrOutside - me.cost),
    });
  }

  res.json({
    mechanic: targetCanon,
    hourly_rate: currentRate(targetCanon),
    lines_count: lines.length,
    lines,
  });
}));

// Fast inline update for outside_labour on a single daily work line from Mechanics KPI view
router.patch('/:id/outside-cost', requireCap('dailywork.edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const w = get('SELECT * FROM job_daily_work WHERE id = ?', id);
  if (!w) return res.status(404).json({ error: 'Daily work entry not found' });
  assertDailyWorkAllowed(w.job_id, req.user, [w.work_date]);

  const rawVal = req.body.outside_labour;
  const newOutside = (rawVal === null || rawVal === '' || rawVal === undefined) ? null : toNum(rawVal, 0);
  if (newOutside !== null && newOutside < 0) {
    return res.status(400).json({ error: 'Outside cost cannot be negative' });
  }

  run('UPDATE job_daily_work SET outside_labour = ? WHERE id = ?', newOutside, id);
  if (w.job_id) costing.refreshJobTotals(w.job_id);

  audit.record({
    userId: req.user.id,
    entity: 'job_daily_work',
    entityId: id,
    action: 'edit_outside_cost',
    before: { outside_labour: w.outside_labour },
    after: { outside_labour: newOutside },
  });

  const emitter = require('../lib/emitter');
  emitter.emit('data_changed', { entity: 'daily_work', id, job_id: w.job_id });

  res.json({ ok: true, id, outside_labour: newOutside });
}));

// All daily-work entries for a FULL MONTH (for month-wise checking & time updating).
// Optional ?mechanic= filters by specific mechanic.
// Optional ?q= filters by vehicle code, registration, mechanic, description, job number.
// Optional ?format=xlsx exports the full month log as Excel.
router.get('/month', requireCap('dailywork.view'), asyncHandler(async (req, res) => {
  rateCache.clear();

  let month = String(req.query.month || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    const latest = get(`SELECT strftime('%Y-%m', work_date) AS m FROM job_daily_work WHERE work_date IS NOT NULL ORDER BY work_date DESC LIMIT 1`);
    month = latest ? latest.m : new Date().toISOString().slice(0, 7);
  }

  const params = [month];
  const conditions = [`strftime('%Y-%m', w.work_date) = ?`];

  // The ?mechanic= filter is applied in JS AFTER the query, by RESOLVED canonical name — a raw entry
  // "Seetha" or "Seethananda" both resolve to the same person as the canonical "Seethananda/seetha",
  // so a plain SQL LIKE on the canonical name (with its slash) would wrongly show no logs.

  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    conditions.push('(a.code LIKE ? OR a.registration LIKE ? OR w.mechanic LIKE ? OR w.description LIKE ? OR j.job_no LIKE ?)');
    params.push(like, like, like, like, like);
  }
  // Stage 3: your own workshop's work only.
  const own = scope.filter(req.user, 'j.workshop_id');
  if (own.sql) { conditions.push(own.sql); params.push(...own.params); }

  let rows = all(
    `SELECT w.id, w.work_date, w.mechanic, w.description, w.hours, w.is_external, w.external_value, w.outside_labour, w.travel,
            j.id AS job_id, j.job_no, j.type, j.status,
            a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, p.name AS project_name
       FROM job_daily_work w
       JOIN job_cards j ON j.id = w.job_id
       LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN projects p ON p.id = j.project_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY w.work_date DESC, a.code, w.id`,
    ...params
  );

  // Match by resolved canonical mechanic so every raw spelling / crew of the person shows up.
  const mechQ = String(req.query.mechanic || '').trim();
  if (mechQ) {
    const targetNorm = mechanics.normalizeMechanic(mechanics.resolveMechanicName(mechQ));
    rows = rows.filter((e) => mechanics.splitMechanics(e.mechanic)
      .some((nm) => mechanics.normalizeMechanic(mechanics.resolveMechanicName(nm)) === targetNorm));
  }

  const entries = rows.map((e) => ({ ...e, ...labourFor(e) }));
  const total_hours = entries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
  const total_labour = entries.reduce((s, e) => s + (Number(e.labour_cost) || 0), 0);
  const external_value = entries.reduce((s, e) => s + (Number(e.external_value) || 0), 0);

  if (req.query.format === 'xlsx') {
    const exportRows = entries.map((e) => ({
      date: e.work_date,
      asset: e.asset_code || '',
      job_no: e.job_no,
      mechanic: e.mechanic || '',
      description: e.description || '',
      hours: e.hours,
      labour_cost: e.is_external ? e.external_value : e.labour_cost,
      outside_labour: e.outside_labour || '',
      type: e.is_external ? 'External' : 'Internal'
    }));
    return sendXlsx(res, `daily-work-log-${month}.xlsx`, [{
      name: `Daily Work Log ${month}`,
      columns: [
        { header: 'Date', key: 'date', width: 14 },
        { header: 'Vehicle', key: 'asset', width: 16 },
        { header: 'Job No', key: 'job_no', width: 18 },
        { header: 'Mechanic / Crew', key: 'mechanic', width: 26 },
        { header: 'Description of Work', key: 'description', width: 40 },
        { header: 'Hours', key: 'hours', width: 12 },
        { header: 'Labour Cost (Rs)', key: 'labour_cost', width: 18 },
        { header: 'Outside Labor (Rs)', key: 'outside_labour', width: 18 },
        { header: 'Type', key: 'type', width: 12 }
      ],
      rows: exportRows
    }]);
  }

  res.json({
    month,
    count: entries.length,
    total_hours: Math.round(total_hours * 100) / 100,
    total_labour: Math.round(total_labour * 100) / 100,
    external_value: Math.round(external_value * 100) / 100,
    entries,
  });
}));

// Distinct days that have daily work logged, newest first, with per-day totals.
router.get('/days', requireCap('dailywork.view'), asyncHandler((req, res) => {
  const own = scope.filter(req.user, 'j.workshop_id');   // Stage 3: your own workshop's work only
  const days = all(
    `SELECT w.work_date AS date,
            COUNT(*)                 AS entries,
            COUNT(DISTINCT w.job_id) AS jobs,
            ROUND(SUM(w.hours), 2)   AS hours
       FROM job_daily_work w JOIN job_cards j ON j.id = w.job_id
      ${own.sql ? 'WHERE ' + own.sql : ''}
      GROUP BY w.work_date
      ORDER BY w.work_date DESC`, ...own.params
  );
  res.json(days);
}));

// All daily-work entries for ONE day, with job + vehicle context and labour cost.
// Optional ?q= filters by vehicle / mechanic / description / job number.
router.get('/', requireCap('dailywork.view'), asyncHandler((req, res) => {
  rateCache.clear();
  const date = String(req.query.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A valid ?date=YYYY-MM-DD is required' });
  }
  const params = [date];
  let filter = '';
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    filter = 'AND (a.code LIKE ? OR a.registration LIKE ? OR w.mechanic LIKE ? OR w.description LIKE ? OR j.job_no LIKE ?)';
    params.push(like, like, like, like, like);
  }
  // Stage 3: your own workshop's work only.
  const own = scope.filter(req.user, 'j.workshop_id');
  if (own.sql) { filter += ` AND ${own.sql}`; params.push(...own.params); }
  const rows = all(
    `SELECT w.id, w.work_date, w.mechanic, w.description, w.hours, w.is_external, w.external_value, w.outside_labour,
            j.id AS job_id, j.job_no, j.type, j.status,
            a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, p.name AS project_name
       FROM job_daily_work w
       JOIN job_cards j ON j.id = w.job_id
       LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN projects p ON p.id = j.project_id
      WHERE w.work_date = ? ${filter}
      ORDER BY a.code, w.id`,
    ...params
  );
  const entries = rows.map((e) => ({ ...e, ...labourFor(e) }));
  const total_hours = entries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
  const total_labour = entries.reduce((s, e) => s + (Number(e.labour_cost) || 0), 0);
  const external_value = entries.reduce((s, e) => s + (Number(e.external_value) || 0), 0);
  res.json({
    date,
    count: entries.length,
    total_hours: Math.round(total_hours * 100) / 100,
    total_labour: Math.round(total_labour * 100) / 100,
    external_value: Math.round(external_value * 100) / 100,
    entries,
    // Only while attendance is on: a signed-off day's lines cannot be changed.
    ...(attendance.isEnabled() ? { locked: attendance.isLocked(date, attendance.settings(), scope.onlyWorkshop(req.user, { store: false }) || workshops.homeOf(req.user)) } : {}),
  });
}));

// Log a new daily-work entry from the Daily Work section (one at a time, day by day).
// Attaches to the vehicle's open/nearest job; each named mechanic is charged full hours.
router.post('/', requireCap('dailywork.add'), asyncHandler((req, res) => {
  const b = req.body;
  const date = String(b.work_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid work date (YYYY-MM-DD) is required' });
  const isExternal = b.is_external ? 1 : 0;
  const hours = isExternal ? 0 : toNum(b.hours, 0);
  const mechanic = String(b.mechanic || '').trim() || null;
  let description = String(b.description || '').trim() || null;
  if (!isExternal && !(hours > 0)) return res.status(400).json({ error: 'Enter the hours worked' });
  if (!isExternal && !mechanic) return res.status(400).json({ error: 'Enter the mechanic(s) who did the work' });

  let jobId = null;
  let unresolved = null;
  let autoCreated = false;
  const rawVeh = String(b.asset || '').trim();
  // Before anything is created: a vehicle with no card would otherwise get a new one for a locked day.
  attendance.assertDaysOpen([date], workshops.homeOf(req.user));

  const forVehicle = (assetId) => {
    const r = autoVehicleJob(assetId, date, rawVeh || null, req.user);
    autoCreated = r.created;
    return r.id;
  };

  if (b.request_type === 'general') {
    // General workshop work. Naming a vehicle books the cost to THAT vehicle for the month:
    // it goes on the vehicle's open card, or on a card created and closed on this work date —
    // so it reports under the vehicle instead of the shared workshop container.
    let assetId = toInt(b.asset_id);
    if (!assetId && rawVeh) {
      const r = aliases.resolveAsset(rawVeh, { source: 'daily_work' });
      assetId = r.assetId; if (!r.resolved) unresolved = { raw: rawVeh };
    }
    if (assetId) {
      jobId = forVehicle(assetId);
    } else {
      jobId = generalWorkshopJob(workshops.homeOf(req.user));   // no vehicle named (or not recognised yet)
      // Keep an unrecognised vehicle name on the line so the work isn't lost to the container.
      if (rawVeh) description = description ? `${rawVeh} — ${description}` : rawVeh;
    }
  } else if (toInt(b.job_id)) {
    jobId = toInt(b.job_id);                     // machine/vehicle → the picked job card
  } else {
    let assetId = toInt(b.asset_id);
    if (!assetId && rawVeh) {
      const r = aliases.resolveAsset(rawVeh, { source: 'daily_work' });
      assetId = r.assetId; if (!r.resolved) unresolved = { raw: rawVeh };
    }
    if (!assetId) return res.status(422).json({ error: 'Choose General, or pick the machine/vehicle job card.' });
    const job = jobForEntry(assetId, date);
    jobId = job ? job.id : forVehicle(assetId);  // no card at all → create one, closed on this date
  }
  const job = get('SELECT * FROM job_cards WHERE id = ?', jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  assertDailyWorkAllowed(job.id, req.user, [date]);

  // The machine goes ON THE LINE now, not just into the choice of job card. This route already
  // worked the asset out — to find or create the card — and then threw it away, which is why the
  // GENERAL-WS pool has 159 rows whose vehicle is knowable only from the prose someone typed.
  const lineAsset = toInt(b.asset_id) || job.asset_id || null;
  const outsideLabour = b.outside_labour !== undefined && b.outside_labour !== null && b.outside_labour !== ''
    ? Math.max(0, toNum(b.outside_labour, 0))
    : null;

  const info = run(
    `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, outside_labour, asset_id, travel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    jobId, date, mechanic, description, hours, isExternal, isExternal ? toNum(b.external_value, 0) : 0, outsideLabour, lineAsset,
    b.travel && !isExternal ? 1 : 0   // Stage 6: travel to a field job — costed like any hour, shown apart
  );
  costing.refreshJobTotals(jobId);
  mechanics.syncJobLabourForMonth(date.slice(0, 7));
  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: info.lastInsertRowid, action: 'create', after: { job_no: job.job_no, date, auto_created: autoCreated, outside_labour: outsideLabour } });
  rateCache.clear();
  res.status(201).json({ id: info.lastInsertRowid, job_no: job.job_no, date, unresolved, auto_created: autoCreated });
}));

// Rapid multi-row timesheet logging endpoint
router.post('/bulk-log', requireCap('dailywork.bulk_log', 'dailywork.edit'), asyncHandler((req, res) => {
  const b = req.body || {};
  const date = String(b.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) required' });

  const rawEntries = Array.isArray(b.entries) ? b.entries : [];
  if (!rawEntries.length) return res.status(400).json({ error: 'entries array required' });
  attendance.assertDaysOpen([date], workshops.homeOf(req.user));

  const affectedJobs = new Set();
  const createdIds = [];

  tx(() => {
    for (let i = 0; i < rawEntries.length; i++) {
      const e = rawEntries[i];
      const mechanic = String(e.mechanic || '').trim();
      const hours = toNum(e.hours, 0);
      let description = String(e.description || '').trim();
      const isExternal = e.is_external ? 1 : 0;
      const rawVeh = String(e.asset || '').trim();
      const outsideLabour = e.outside_labour !== undefined && e.outside_labour !== null && e.outside_labour !== ''
        ? Math.max(0, toNum(e.outside_labour, 0))
        : null;

      if (!mechanic) continue; // skip blank row
      if (hours <= 0 && !isExternal) continue;

      let jobId = null;
      let lineAsset = toInt(e.asset_id) || null;

      if (e.request_type === 'general') {
        let assetId = lineAsset;
        if (!assetId && rawVeh) {
          const r = aliases.resolveAsset(rawVeh, { source: 'daily_work' });
          assetId = r.assetId;
        }
        if (assetId) {
          jobId = autoVehicleJob(assetId, date, rawVeh || null, req.user).id;
          lineAsset = assetId;
        } else {
          jobId = generalWorkshopJob(workshops.homeOf(req.user));
          if (rawVeh) description = description ? `${rawVeh} — ${description}` : rawVeh;
        }
      } else if (toInt(e.job_id)) {
        jobId = toInt(e.job_id);
      } else {
        let assetId = lineAsset;
        if (!assetId && rawVeh) {
          const r = aliases.resolveAsset(rawVeh, { source: 'daily_work' });
          assetId = r.assetId;
        }
        if (assetId) {
          const job = jobForEntry(assetId, date);
          jobId = job ? job.id : autoVehicleJob(assetId, date, rawVeh || null, req.user).id;
          lineAsset = assetId;
        } else {
          jobId = generalWorkshopJob(workshops.homeOf(req.user));
        }
      }

      const job = get('SELECT id, asset_id, job_no FROM job_cards WHERE id = ?', jobId);
      if (!job) continue;
      if (!lineAsset && job.asset_id) lineAsset = job.asset_id;

      assertDailyWorkAllowed(jobId, req.user, [date]);   // a whole batch is refused, not half-applied
      const info = run(
        `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, outside_labour, asset_id, travel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        jobId, date, mechanic, description, hours, isExternal, isExternal ? toNum(e.external_value, 0) : 0, outsideLabour, lineAsset,
        e.travel && !isExternal ? 1 : 0   // Stage 6: a travel line
      );
      createdIds.push(info.lastInsertRowid);
      affectedJobs.add(jobId);
    }
  });

  for (const jId of affectedJobs) {
    costing.refreshJobTotals(jId);
  }
  mechanics.syncJobLabourForMonth(date.slice(0, 7));
  rateCache.clear();

  audit.record({
    userId: req.user.id,
    entity: 'job_daily_work',
    action: 'bulk_log',
    after: { date, count: createdIds.length, jobs: [...affectedJobs] }
  });

  res.status(201).json({
    ok: true,
    date,
    entries_logged: createdIds.length,
    jobs_affected: affectedJobs.size
  });
}));

// Edit a daily-work line (hours, and optionally the mechanic string).
router.patch('/:id', requireCap('dailywork.edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const w = get('SELECT * FROM job_daily_work WHERE id = ?', id);
  if (!w) return res.status(404).json({ error: 'Entry not found' });
  // Moving a line to another day touches both days.
  assertDailyWorkAllowed(w.job_id, req.user, [w.work_date, req.body.work_date !== undefined ? String(req.body.work_date).slice(0, 10) : null]);

  const sets = [];
  const params = [];
  const put = (col, v) => { sets.push(col + ' = ?'); params.push(v); };
  if (req.body.hours !== undefined) put('hours', toNum(req.body.hours, 0));
  if (req.body.mechanic !== undefined) put('mechanic', String(req.body.mechanic).trim() || null);
  if (req.body.description !== undefined) put('description', String(req.body.description).trim() || null);
  // Stage 6: mark (or unmark) a line as travel to a field job.
  if (req.body.travel !== undefined) put('travel', req.body.travel && !w.is_external ? 1 : 0);
  // Blank clears the outside labor value; a number sets it.
  if (req.body.outside_labour !== undefined) {
    const v = req.body.outside_labour;
    put('outside_labour', (v === null || v === '') ? null : toNum(v, 0));
  }
  if (req.body.work_date !== undefined) {
    const d = String(req.body.work_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'A valid work date (YYYY-MM-DD) is required' });
    put('work_date', d);
  }
  // Naming the machine on an existing line. This is how the unassigned pool improves: somebody who
  // recognises "Compressor clean and repair" says which compressor, and it is recorded from then on.
  // Blank clears it back to unknown, which is honest — better than a wrong vehicle.
  if (req.body.asset_id !== undefined) {
    const v = req.body.asset_id;
    if (v === null || v === '') put('asset_id', null);
    else {
      const a = toInt(v);
      if (!a || !get('SELECT id FROM assets WHERE id = ?', a)) return res.status(400).json({ error: 'Unknown vehicle' });
      put('asset_id', a);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  run(`UPDATE job_daily_work SET ${sets.join(', ')} WHERE id = ?`, ...params, id);

  // Recompute the job total after a daily-programme edit. Reconstructed jobs (recorded_cost 0)
  // let the edit drive their total via historicalTotal; jobs with a real recorded_cost stay
  // frozen inside refreshJobTotals — so this is safe to run for every job.
  const job = get('SELECT id FROM job_cards WHERE id = ?', w.job_id);
  if (job) costing.refreshJobTotals(job.id);
  // Moving an entry across months has to re-cost BOTH months' labour.
  const months = new Set([w.work_date, req.body.work_date].filter(Boolean).map((d) => String(d).slice(0, 7)));
  for (const m of months) mechanics.syncJobLabourForMonth(m);

  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: id, action: 'edit',
    before: { hours: w.hours, mechanic: w.mechanic, description: w.description, work_date: w.work_date, outside_labour: w.outside_labour },
    after: req.body });

  const updated = get('SELECT * FROM job_daily_work WHERE id = ?', id);
  rateCache.clear();
  res.json({ ...updated, ...labourFor(updated) });
}));

// Remove a daily-work line (mis-keyed entry / duplicate). The job total and that month's labour
// are re-costed straight away, and the deletion is audited with the full line it removed.
router.delete('/:id', requireCap('dailywork.delete', 'dailywork.edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const w = get('SELECT * FROM job_daily_work WHERE id = ?', id);
  if (!w) return res.status(404).json({ error: 'Entry not found' });
  assertDailyWorkAllowed(w.job_id, req.user, [w.work_date]);

  run('DELETE FROM job_daily_work WHERE id = ?', id);
  if (w.job_id) costing.refreshJobTotals(w.job_id);
  if (w.work_date) mechanics.syncJobLabourForMonth(String(w.work_date).slice(0, 7));

  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: id, action: 'delete',
    before: { job_id: w.job_id, work_date: w.work_date, mechanic: w.mechanic, description: w.description, hours: w.hours, outside_labour: w.outside_labour } });
  rateCache.clear();
  res.json({ ok: true, deleted: id });
}));

// Batch update working hours for multiple daily work entries at once.
router.post('/batch-update', requireCap('dailywork.edit'), asyncHandler((req, res) => {
  const updates = req.body.updates;
  if (!Array.isArray(updates) || !updates.length) {
    return res.status(400).json({ error: 'Provide an array of updates: [{ id, hours?, outside_labour? }]' });
  }

  const affectedJobIds = new Set();
  let updatedCount = 0;

  tx(() => {
    for (const item of updates) {
      const id = toInt(item.id);
      if (!id) continue;
      const hasHours = item.hours !== undefined && item.hours !== null && item.hours !== '';
      const hasOutside = item.outside_labour !== undefined;
      if (!hasHours && !hasOutside) continue;

      const w = get('SELECT id, job_id, work_date, hours, outside_labour FROM job_daily_work WHERE id = ?', id);
      if (!w) continue;
      assertDailyWorkAllowed(w.job_id, req.user, [w.work_date]);

      const hours = hasHours ? toNum(item.hours, 0) : w.hours;
      if (hasHours && hours < 0) continue;
      // Blank clears the outside labor value; a number sets it.
      const outside = hasOutside
        ? ((item.outside_labour === null || item.outside_labour === '') ? null : toNum(item.outside_labour, 0))
        : w.outside_labour;

      run('UPDATE job_daily_work SET hours = ?, outside_labour = ? WHERE id = ?', hours, outside, id);
      if (w.job_id) affectedJobIds.add(w.job_id);
      updatedCount++;

      audit.record({
        userId: req.user.id,
        entity: 'job_daily_work',
        entityId: id,
        action: 'batch_edit_hours',
        before: { hours: w.hours, outside_labour: w.outside_labour },
        after: { hours, outside_labour: outside }
      });
    }

    // Refresh totals for all affected job cards in transaction
    for (const jobId of affectedJobIds) {
      if (jobId) costing.refreshJobTotals(jobId);
    }
  });

  rateCache.clear();
  res.json({ success: true, updated_count: updatedCount, affected_jobs: affectedJobIds.size });
}));

module.exports = router;
// Exported so the bulk importers use the SAME matching rule as the live screen. It used to be
// copied into scripts/_import_new_dw.js, the copy kept the unbounded version, and a bulk import
// re-created the very mis-attribution the screen had been fixed for.
module.exports.jobForEntry = jobForEntry;
module.exports.JOB_MATCH_SLACK_DAYS = JOB_MATCH_SLACK_DAYS;
// The attendance screen books a mechanic's unbooked hours to the same General Workshop card.
module.exports.generalWorkshopJob = generalWorkshopJob;

