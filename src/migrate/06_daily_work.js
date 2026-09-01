'use strict';

// Phase — Daily Work Done import. Attach each "Daily Work Done" line to the job
// it belongs to. Per the owner: match a daily-work row to a job for the SAME
// vehicle whose active window contains the work date, allowing ±3 days of slack
// (recorded start/end dates are approximate). A row with no job inside that window
// is routine work with no repair/service card — it is skipped and written to a
// review CSV so nothing is lost, rather than forced onto an unrelated job.
//
// Idempotent: a line already present on its job (same date + mechanic + description
// + hours) is never duplicated, so the step is safe to re-run.
//
// Source = sources/jobs/daily_work.csv (identical to the uploaded
// "Daily_Work_Done updated.xlsx", sheet "From 1st Dec2025").

const fs = require('fs');
const path = require('path');
const { get, all, run, tx } = require('../db');
const config = require('../config');
const aliases = require('../lib/aliases');
const { load, clean } = require('./csv');

const SLACK = 3; // days of tolerance around a job's [start, end] window

function parseDate(s) {
  s = clean(s);
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const md = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // MM/DD/YYYY (as recorded)
  if (md) return `${md[3]}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const addDays = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayGap = (a, b) => Math.abs(Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000));

// read-only resolve (the registry already holds every code)
function lookupAsset(v) {
  const n = aliases.normalize(v);
  if (!n) return null;
  const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
  if (a) return a.id;
  const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
  return al ? al.asset_id : null;
}

// Pick the SINGLE best job for (asset, date): the daily work is attached to exactly
// one job. Prefer a job whose [start, end] window contains the date; otherwise the
// nearest one still inside the ±SLACK window. Tie-break on the latest start ≤ date
// (the most recently opened card).
function bestJob(assetId, date) {
  const jobs = all('SELECT id, job_no, requested_at, completed_at FROM job_cards WHERE asset_id = ?', assetId);
  let best = null, bestScore = null;
  for (const j of jobs) {
    const start = String(j.requested_at).slice(0, 10);
    const end = j.completed_at ? String(j.completed_at).slice(0, 10) : start;
    if (date < addDays(start, -SLACK) || date > addDays(end, SLACK)) continue;
    const contains = date >= start && date <= end ? 1 : 0;
    const gap = contains ? 0 : Math.min(dayGap(date, start), dayGap(date, end));
    const score = { contains, gap, start };
    if (!best
      || score.contains > bestScore.contains
      || (score.contains === bestScore.contains && score.gap < bestScore.gap)
      || (score.contains === bestScore.contains && score.gap === bestScore.gap && score.start > bestScore.start)) {
      best = j; bestScore = score;
    }
  }
  return best;
}

function runStep() {
  const rep = { rows: 0, no_date: 0, no_vehicle: 0, unresolved: 0, no_job: 0,
    matched: 0, inserted: 0, duplicates: 0, unresolved_samples: [] };
  const unmatched = [];
  const rows = load('jobs/daily_work.csv');

  tx(() => {
    for (const r of rows) {
      rep.rows++;
      const date = parseDate(r.Date);
      const veh = clean(r['Vehicle No']);
      const desc = clean(r['Description of work']) || null;
      const mech = clean(r.Mechanic) || null;
      const hours = parseFloat(clean(r['Time(Hrs)'])) || 0;

      if (!date) { rep.no_date++; unmatched.push({ ...r, _reason: 'no date' }); continue; }
      if (!veh) { rep.no_vehicle++; unmatched.push({ ...r, _reason: 'no vehicle' }); continue; }
      const assetId = lookupAsset(veh);
      if (!assetId) {
        rep.unresolved++;
        if (rep.unresolved_samples.length < 8) rep.unresolved_samples.push(veh);
        unmatched.push({ ...r, _reason: 'vehicle not in registry' });
        continue;
      }
      const job = bestJob(assetId, date);
      if (!job) { rep.no_job++; unmatched.push({ ...r, _reason: 'no job within ±3 days' }); continue; }
      rep.matched++;

      const dup = get(
        `SELECT id FROM job_daily_work
          WHERE job_id = ? AND work_date = ?
            AND IFNULL(mechanic,'') = IFNULL(?, '')
            AND IFNULL(description,'') = IFNULL(?, '')
            AND hours = ?`,
        job.id, date, mech, desc, hours
      );
      if (dup) { rep.duplicates++; continue; }

      run(
        `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
        job.id, date, mech, desc, hours
      );
      rep.inserted++;
    }
  });

  // Write the skipped rows to a review CSV so none are silently lost.
  if (unmatched.length) {
    const cols = ['Date', 'Vehicle No', 'Description of work', 'Mechanic', 'Time(Hrs)', 'Outside Value(Rs.)', 'Remarks', '_reason'];
    const q = (v) => { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const out = [cols.join(',')].concat(unmatched.map((u) => cols.map((c) => q(u[c])).join(',')));
    rep.review_file = path.join(config.root, 'daily_work_unmatched_review.csv');
    fs.writeFileSync(rep.review_file, out.join('\n') + '\n');
  }

  rep.total_daily_work = get('SELECT COUNT(*) c FROM job_daily_work').c;
  rep.jobs_with_daily_work = get('SELECT COUNT(DISTINCT job_id) c FROM job_daily_work').c;
  return rep;
}

module.exports = { runStep };
