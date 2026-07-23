'use strict';

// Daily Work — read + light-edit views over job_daily_work for reviewing what was
// done day by day (across all jobs/vehicles). Also resolves each entry's mechanic(s)
// to their hourly rate and computes the labour cost for that line.

const express = require('express');
const { get, all, run } = require('../db');
const { requireRole } = require('../lib/auth');
const { asyncHandler, toNum, toInt } = require('../lib/http');
const audit = require('../lib/audit');
const costing = require('../lib/costing');
const mechanics = require('../lib/mechanics');
const aliases = require('../lib/aliases');

const router = express.Router();

// Resolve the (asset, date) to the job a manually-logged entry belongs to: prefer an
// OPEN card for the vehicle (live work can run well past the ±3-day import window), else
// the job whose window is nearest the date.
function jobForEntry(assetId, date) {
  const jobs = all('SELECT id, job_no, requested_at, completed_at, closed_at, status FROM job_cards WHERE asset_id = ?', assetId);
  if (!jobs.length) return null;
  const day = (v) => String(v || '').slice(0, 10);
  const pick = (arr) => arr.filter((j) => day(j.requested_at) <= date).sort((a, b) => day(b.requested_at).localeCompare(day(a.requested_at)))[0]
    || arr.slice().sort((a, b) => day(a.requested_at).localeCompare(day(b.requested_at)))[0];
  const open = jobs.filter((j) => j.status !== 'CLOSED');
  if (open.length) return pick(open);
  let best = null, bg = Infinity;
  for (const j of jobs) {
    const s = day(j.requested_at), e = day(j.closed_at || j.completed_at || j.requested_at);
    const g = (date >= s && date <= e) ? 0 : Math.min(Math.abs(new Date(date) - new Date(s)), Math.abs(new Date(date) - new Date(e))) / 86400000;
    if (g < bg) { bg = g; best = j; }
  }
  return best;
}

// Shared container job for general (non-vehicle) workshop daily work.
function generalWorkshopJob() {
  const j = get("SELECT id FROM job_cards WHERE legacy_ref = 'general-workshop' LIMIT 1");
  if (j) return j.id;
  return run(`INSERT INTO job_cards (job_no, type, description, status, requested_by, requested_at, is_historical, synthesized_no, legacy_ref)
              VALUES ('GENERAL-WS', 'repair', 'General workshop daily work (not vehicle-specific)', 'REQUESTED', 'system', date('now'), 0, 1, 'general-workshop')`).lastInsertRowid;
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

// Distinct days that have daily work logged, newest first, with per-day totals.
router.get('/days', asyncHandler((_req, res) => {
  const days = all(
    `SELECT work_date AS date,
            COUNT(*)               AS entries,
            COUNT(DISTINCT job_id) AS jobs,
            ROUND(SUM(hours), 2)   AS hours
       FROM job_daily_work
      GROUP BY work_date
      ORDER BY work_date DESC`
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
  const rows = all(
    `SELECT w.id, w.work_date, w.mechanic, w.description, w.hours, w.is_external, w.external_value,
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
  });
}));

// Log a new daily-work entry from the Daily Work section (one at a time, day by day).
// Attaches to the vehicle's open/nearest job; each named mechanic is charged full hours.
router.post('/', requireRole('workshop', 'manager', 'storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  const date = String(b.work_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid work date (YYYY-MM-DD) is required' });
  const isExternal = b.is_external ? 1 : 0;
  const hours = isExternal ? 0 : toNum(b.hours, 0);
  const mechanic = String(b.mechanic || '').trim() || null;
  const description = String(b.description || '').trim() || null;
  if (!isExternal && !(hours > 0)) return res.status(400).json({ error: 'Enter the hours worked' });
  if (!isExternal && !mechanic) return res.status(400).json({ error: 'Enter the mechanic(s) who did the work' });

  let jobId = null;
  let unresolved = null;
  if (b.request_type === 'general') {
    jobId = generalWorkshopJob();               // general daily programme → workshop container job
  } else if (toInt(b.job_id)) {
    jobId = toInt(b.job_id);                     // machine/vehicle → the picked job card
  } else {
    let assetId = toInt(b.asset_id);
    if (!assetId && String(b.asset || '').trim()) {
      const r = aliases.resolveAsset(b.asset, { source: 'daily_work' });
      assetId = r.assetId; if (!r.resolved) unresolved = { raw: b.asset };
    }
    if (!assetId) return res.status(422).json({ error: 'Choose General, or pick the machine/vehicle job card.' });
    const job = jobForEntry(assetId, date);
    if (!job) return res.status(409).json({ error: 'No job card exists for this vehicle — create the job card first, then log its daily work.' });
    jobId = job.id;
  }
  const job = get('SELECT * FROM job_cards WHERE id = ?', jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const info = run(
    `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    jobId, date, mechanic, description, hours, isExternal, isExternal ? toNum(b.external_value, 0) : 0
  );
  costing.refreshJobTotals(jobId);
  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: info.lastInsertRowid, action: 'create', after: { job_no: job.job_no, date } });
  rateCache.clear();
  res.status(201).json({ id: info.lastInsertRowid, job_no: job.job_no, date, unresolved });
}));

// Edit a daily-work line (hours, and optionally the mechanic string).
router.patch('/:id', requireRole('admin', 'workshop', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const w = get('SELECT * FROM job_daily_work WHERE id = ?', id);
  if (!w) return res.status(404).json({ error: 'Entry not found' });

  const sets = [];
  const params = [];
  if (req.body.hours !== undefined) { sets.push('hours = ?'); params.push(toNum(req.body.hours, 0)); }
  if (req.body.mechanic !== undefined) { sets.push('mechanic = ?'); params.push(String(req.body.mechanic).trim() || null); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update (send hours and/or mechanic)' });

  run(`UPDATE job_daily_work SET ${sets.join(', ')} WHERE id = ?`, ...params, id);

  // Keep live jobs' totals correct; historical (imported) jobs keep recorded totals.
  const job = get('SELECT id, is_historical FROM job_cards WHERE id = ?', w.job_id);
  if (job && !job.is_historical) costing.refreshJobTotals(job.id);

  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: id, action: 'edit',
    before: { hours: w.hours, mechanic: w.mechanic }, after: { hours: req.body.hours, mechanic: req.body.mechanic } });

  const updated = get('SELECT * FROM job_daily_work WHERE id = ?', id);
  rateCache.clear();
  res.json({ ...updated, ...labourFor(updated) });
}));

module.exports = router;
