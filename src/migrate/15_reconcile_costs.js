'use strict';

// Phase 1 — Cost reconciliation. Every job is is_historical=1, so refreshJobTotals
// used to freeze total_cost at the imported value (often 0) while still recomputing
// the components — stranding real cost on jobs that reported Rs 0. This step:
//   1. Freezes the original imported total into recorded_cost (once).
//   2. Recomputes every job under the reconcile rule (costing.refreshJobTotals):
//        total_cost = recorded_cost when > 0, else the computed component total;
//        other_cost balances any recorded-vs-itemised gap so the columns always
//        sum to total_cost.
// Idempotent: recorded_cost is only backfilled while NULL; re-running just recomputes.

const fs = require('fs');
const path = require('path');
const { get, all, run } = require('../db');
const config = require('../config');
const costing = require('../lib/costing');

function runStep() {
  const rep = { jobs: 0, recorded_backfilled: 0, used_recorded: 0, used_computed: 0,
    recovered: 0, mismatches: 0, unreconciled: 0 };

  // 1. Freeze the imported recorded total once, before total_cost is recomputed.
  rep.recorded_backfilled = run('UPDATE job_cards SET recorded_cost = total_cost WHERE recorded_cost IS NULL').changes;

  const before = get('SELECT ROUND(SUM(COALESCE(total_cost,0))) s FROM job_cards').s || 0;
  const before0 = get('SELECT COUNT(*) c FROM job_cards WHERE COALESCE(total_cost,0)=0').c;

  // 2. Recompute every job's components + total under the reconcile rule.
  for (const j of all('SELECT id FROM job_cards')) { costing.refreshJobTotals(j.id); rep.jobs++; }

  // 3. Classify + reconciliation report.
  const after = get('SELECT ROUND(SUM(COALESCE(total_cost,0))) s FROM job_cards').s || 0;
  const after0 = get('SELECT COUNT(*) c FROM job_cards WHERE COALESCE(total_cost,0)=0').c;
  rep.recovered = Math.round(after - before);
  rep.zero_before = before0;
  rep.zero_after = after0;
  rep.total_after = after;
  rep.used_recorded = get('SELECT COUNT(*) c FROM job_cards WHERE is_historical=1 AND recorded_cost > 0').c;
  rep.used_computed = get('SELECT COUNT(*) c FROM job_cards WHERE (recorded_cost IS NULL OR recorded_cost <= 0) AND COALESCE(total_cost,0) > 0').c;

  // Every job's columns must sum to its total (invariant introduced by other_cost).
  rep.unreconciled = get(`SELECT COUNT(*) c FROM job_cards
     WHERE ABS(COALESCE(labour_cost,0)+COALESCE(material_cost,0)+COALESCE(oil_cost,0)
             + COALESCE(general_cost,0)+COALESCE(external_cost,0)+COALESCE(other_cost,0)
             - COALESCE(total_cost,0)) > 0.5`).c;

  // Jobs whose recorded total differs from the itemised sum (carried in other_cost).
  const mism = all(`SELECT job_no, recorded_cost,
      (COALESCE(labour_cost,0)+COALESCE(material_cost,0)+COALESCE(oil_cost,0)+COALESCE(general_cost,0)+COALESCE(external_cost,0)) comp,
      other_cost, total_cost
    FROM job_cards WHERE ABS(COALESCE(other_cost,0)) > 0.01 ORDER BY ABS(other_cost) DESC`);
  rep.mismatches = mism.length;
  if (mism.length) {
    const q = (v) => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const out = ['Job No,Recorded,Itemised Components,Other (balancing),Total']
      .concat(mism.map((m) => [m.job_no, m.recorded_cost, m.comp, m.other_cost, m.total_cost].map(q).join(',')));
    rep.review_file = path.join(config.root, 'cost_reconciliation.csv');
    fs.writeFileSync(rep.review_file, out.join('\n') + '\n');
  }
  return rep;
}

module.exports = { runStep };
