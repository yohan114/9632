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
router.get('/monthly-summary', asyncHandler(async (req, res) => {
  rateCache.clear();

  const months = all(
    `SELECT DISTINCT strftime('%Y-%m', work_date) AS month
       FROM job_daily_work
      WHERE work_date IS NOT NULL
      ORDER BY month DESC`
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
      WHERE strftime('%Y-%m', w.work_date) = ?
      ORDER BY w.work_date, w.id`,
    month
  );

  const jlRows = all(
    `SELECT mechanic, SUM(amount) AS total_cost, COUNT(*) AS entries
       FROM job_labour
      WHERE substr(work_date,1,7) = ?
      GROUP BY mechanic`,
    month
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

  const laborSummary = [...mechMap.values()]
    .map((m) => ({
      ...m,
      total_hours: Math.round(m.total_hours * 100) / 100,
      total_cost: Math.round(m.total_cost * 100) / 100,
    }))
    .sort((a, b) => b.total_cost - a.total_cost);
  const mechanicsCount = laborSummary.length;

  // Attendance (when switched on): hours at work, hours booked and utilisation, over the days the
  // tally runs. A mechanic who was at work but booked nothing this month still gets a row — that is
  // exactly the case worth seeing. Labour cost is untouched: it stays booked hours × rate.
  let att = null;
  if (attendance.isEnabled()) {
    att = attendance.month(month);
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

// All daily-work entries for a FULL MONTH (for month-wise checking & time updating).
// Optional ?mechanic= filters by specific mechanic.
// Optional ?q= filters by vehicle code, registration, mechanic, description, job number.
// Optional ?format=xlsx exports the full month log as Excel.
router.get('/month', asyncHandler(async (req, res) => {
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
router.get('/days', asyncHandler((req, res) => {
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
router.get('/', asyncHandler((req, res) => {
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

  const info = run(
    `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, asset_id, travel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    jobId, date, mechanic, description, hours, isExternal, isExternal ? toNum(b.external_value, 0) : 0, lineAsset,
    b.travel && !isExternal ? 1 : 0   // Stage 6: travel to a field job — costed like any hour, shown apart
  );
  costing.refreshJobTotals(jobId);
  mechanics.syncJobLabourForMonth(date.slice(0, 7));
  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: info.lastInsertRowid, action: 'create', after: { job_no: job.job_no, date, auto_created: autoCreated } });
  rateCache.clear();
  res.status(201).json({ id: info.lastInsertRowid, job_no: job.job_no, date, unresolved, auto_created: autoCreated });
}));

// Rapid multi-row timesheet logging endpoint
router.post('/bulk-log', requireCap('dailywork.edit'), asyncHandler((req, res) => {
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
        `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, asset_id, travel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        jobId, date, mechanic, description, hours, isExternal, isExternal ? toNum(e.external_value, 0) : 0, lineAsset,
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
router.delete('/:id', requireCap('dailywork.edit'), asyncHandler((req, res) => {
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

