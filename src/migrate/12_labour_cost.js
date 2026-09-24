'use strict';

// Phase — Calculate labour cost. Recomputes each job's cost components (labour from
// daily work × mechanic rates, material from job_parts, oil/general) and stores them
// on the job card, so labour_cost/material_cost show in lists and reports. Historical
// jobs keep their recorded total_cost (refreshJobTotals preserves it). Idempotent.

const { get, all } = require('../db');
const costing = require('../lib/costing');

function runStep() {
  const rep = { jobs_recosted: 0, jobs_with_labour: 0 };
  const ids = all(
    `SELECT id FROM job_cards
      WHERE EXISTS (SELECT 1 FROM job_daily_work w WHERE w.job_id = job_cards.id)
         OR EXISTS (SELECT 1 FROM job_parts p WHERE p.job_id = job_cards.id)
         OR flat_labour IS NOT NULL`
  ).map((r) => r.id);

  for (const id of ids) { costing.refreshJobTotals(id); rep.jobs_recosted++; }

  rep.jobs_with_labour = get('SELECT COUNT(*) c FROM job_cards WHERE labour_cost > 0').c;
  rep.total_labour = Math.round(get('SELECT COALESCE(SUM(labour_cost), 0) v FROM job_cards').v);
  rep.total_material = Math.round(get('SELECT COALESCE(SUM(material_cost), 0) v FROM job_cards').v);
  rep.unrated_daily_rows = get(
    `SELECT COUNT(*) c FROM job_daily_work WHERE is_external = 0 AND mechanic IS NOT NULL AND mechanic <> ''`
  ).c;
  return rep;
}

module.exports = { runStep };
