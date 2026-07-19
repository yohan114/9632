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

const router = express.Router();

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
            a.code AS asset_code, p.name AS project_name
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
