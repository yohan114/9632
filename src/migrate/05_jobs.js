'use strict';

// Phase — Job history import (unified). Per the owner: c_job + requested_job are
// NOT separate — they are all "job requested". Import every job keyed by its job
// number with description + start date + (close date where present). A job with a
// close date is CLOSED; without one it is an open REQUEST. c_job rows additionally
// carry the recorded cost / ref and are the completed record for their job number.
//
// Source = the committed job CSVs (identical to the uploaded
// Job_Record_Requested_and_Cjob.xlsx: 3,039 requested + 510 c_job).

const { get, run, tx } = require('../db');
const aliases = require('../lib/aliases');
const { load, clean } = require('./csv');

const todayISO = () => new Date().toISOString().slice(0, 10);

function parseDate(s) {
  s = clean(s);
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function jobType(jobNo) {
  const m = clean(jobNo).match(/\/([RS])\//i);
  return m && m[1].toUpperCase() === 'S' ? 'service' : 'repair';
}

// read-only resolve (no pending-alias mutation): the registry already holds every code
function lookupAsset(v) {
  const n = aliases.normalize(v);
  if (!n) return null;
  const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
  if (a) return a.id;
  const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
  return al ? al.asset_id : null;
}

function runStep() {
  const rep = { requested_rows: 0, cjob_rows: 0, created: 0, enriched_from_cjob: 0,
    duplicates_skipped: 0, unlinked_vehicle: 0, unresolved_samples: [] };

  tx(() => {
    // 1) requested_job — the base set of jobs
    for (const r of load('jobs/requested_job.csv')) {
      const jobNo = clean(r.col_1);
      if (!jobNo) continue;
      rep.requested_rows++;
      if (get('SELECT id FROM job_cards WHERE job_no = ?', jobNo)) { rep.duplicates_skipped++; continue; }
      const assetId = lookupAsset(r.Vehicle);
      if (!assetId && clean(r.Vehicle)) { rep.unlinked_vehicle++; if (rep.unresolved_samples.length < 8) rep.unresolved_samples.push(clean(r.Vehicle)); }
      const start = parseDate(r.Start);
      const end = parseDate(r.End);
      run(
        `INSERT INTO job_cards (job_no, asset_id, type, description, site, status, requested_at, completed_at, is_historical, requested_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'imported')`,
        jobNo, assetId || null, jobType(jobNo), clean(r['Repair Description']) || null, clean(r.Site) || null,
        end ? 'CLOSED' : 'REQUESTED', start || end || todayISO(), end || null
      );
      rep.created++;
    }

    // 2) c_job — the completed record: enrich the matching job (or add if new),
    //    carrying the recorded cost, ref and close date.
    for (const c of load('jobs/c_job.csv')) {
      const jobNo = clean(c['Job no']);
      if (!jobNo) continue;
      rep.cjob_rows++;
      const start = parseDate(c.Start);
      const end = parseDate(c.End);
      const cost = parseFloat(clean(c.Cost)) || 0;
      const ref = clean(c['Ref.']) || null;
      const assetId = lookupAsset(c.Vehicle);
      const existing = get('SELECT id FROM job_cards WHERE job_no = ?', jobNo);
      if (existing) {
        run(
          `UPDATE job_cards SET legacy_ref = ?, total_cost = ?, completed_at = COALESCE(?, completed_at),
             status = 'CLOSED', is_historical = 1, asset_id = COALESCE(asset_id, ?) WHERE id = ?`,
          ref, cost, end, assetId || null, existing.id
        );
        rep.enriched_from_cjob++;
      } else {
        if (!assetId && clean(c.Vehicle)) rep.unlinked_vehicle++;
        run(
          `INSERT INTO job_cards (job_no, legacy_ref, asset_id, type, description, site, status, requested_at, completed_at, total_cost, is_historical, requested_by)
           VALUES (?, ?, ?, ?, ?, ?, 'CLOSED', ?, ?, ?, 1, 'imported')`,
          jobNo, ref, assetId || null, jobType(jobNo), clean(c['Repair Description']) || null, clean(c.Site) || null,
          start || end || todayISO(), end || null, cost
        );
        rep.created++;
      }
    }
  });

  rep.total_jobs = get('SELECT COUNT(*) c FROM job_cards').c;
  rep.closed = get(`SELECT COUNT(*) c FROM job_cards WHERE status = 'CLOSED'`).c;
  rep.open = get(`SELECT COUNT(*) c FROM job_cards WHERE status = 'REQUESTED'`).c;
  rep.with_recorded_cost = get(`SELECT COUNT(*) c FROM job_cards WHERE total_cost > 0`).c;
  rep.recorded_cost_sum = Math.round(get(`SELECT COALESCE(SUM(total_cost),0) s FROM job_cards`).s);
  return rep;
}

module.exports = { runStep };
