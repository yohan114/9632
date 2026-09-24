'use strict';

// ===========================================================================
// Stuck job cards — the REQUESTED cards that hold their vehicle but will never move.
//
// A card in REQUESTED counts as open, and a vehicle may have only one open card. The office
// database held 254 of them: most imported from the old job book (imported with no end date → REQUESTED),
// each one blocking a new job for its vehicle, and — once partial close exists (W2) — blocking the
// "open a new job for this vehicle" that partial close depends on.
//
// Nothing here changes a card on its own. listStuck() SUGGESTS what to do with each; a person
// chooses and applyReview() does exactly what was chosen, in one transaction, audited.
//
// Suggestions (owner decision W-D11 in docs/WORKSHOPONE_PLAN.md):
//   reject  no activity at all (no daily work, parts, requests, issues, oil, cost) and nothing for
//           more than 90 days — "not carried out". Pre-ticked.
//   close   has activity, but nothing for more than 90 days — the work was done, the card was never
//           closed. Offered on the last activity date; NOT pre-ticked, because closing puts the card
//           in that month's cost report.
//   keep    anything touched in the last 90 days, or raised in the last 90 days.
//
// AGE IS NOT requested_at FOR IMPORTED CARDS: the import stamped them all with the day it ran
// (2026-07-16), so a card numbered 2023/3/R/62 looked two months old. An imported card's own period
// is read from its job number instead.
// ===========================================================================

const { get, all, run, tx } = require('../db');
const jobstate = require('./jobstate');
const costing = require('./costing');

const STALE_DAYS = 90;
const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);

// Container cards belong to no vehicle and are never "stuck": the general workshop card, the
// auto-created holders for stores materials and daily work.
const CONTAINER_SQL = `(j.asset_id IS NULL
   OR COALESCE(j.legacy_ref, '') IN ('general-workshop')
   OR COALESCE(j.legacy_ref, '') LIKE 'auto-container%'
   OR COALESCE(j.description, '') LIKE 'Stores materials%'
   OR COALESCE(j.description, '') LIKE 'auto-created container%')`;

/** "2023/3/R/62" → "2023-03-01"; null if the number is not in that shape. */
function periodFromJobNo(jobNo) {
  const m = String(jobNo || '').match(/^(\d{4})\/(\d{1,2})\//);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]}-${String(month).padStart(2, '0')}-01` : null;
}

function describe(r, now = today()) {
  const own = r.is_historical ? (periodFromJobNo(r.job_no) || String(r.requested_at || '').slice(0, 10))
    : String(r.requested_at || '').slice(0, 10);
  const lastActivity = [r.last_dw, r.last_mrn, r.last_issue, r.last_oil, r.last_general].filter(Boolean).sort().pop() || null;
  const ref = [own, lastActivity].filter(Boolean).sort().pop() || own;
  const ageDays = ref ? Math.floor((Date.parse(now) - Date.parse(ref)) / DAY) : null;
  const activity = r.daily_work + r.parts + r.mrns + r.issues + r.oil + r.general;
  const hasActivity = activity > 0 || (r.total_cost || 0) > 0;
  let suggestion = 'keep';
  if (ageDays != null && ageDays > STALE_DAYS) suggestion = hasActivity ? 'close' : 'reject';
  const closeDate = suggestion === 'close' ? (lastActivity || own) : null;
  return {
    id: r.id, job_no: r.job_no, imported: !!r.is_historical, description: r.description,
    vehicle: r.asset_code || r.asset_reg || null, asset_id: r.asset_id,
    period: own, last_activity: lastActivity, age_days: ageDays,
    activity: { daily_work: r.daily_work, parts: r.parts, mrns: r.mrns, issues: r.issues, oil: r.oil, general: r.general },
    total_cost: r.total_cost || 0,
    suggestion,
    preselected: suggestion === 'reject',
    close_date: closeDate,
    report_month: closeDate ? closeDate.slice(0, 7) : null,
  };
}

/** Every stuck REQUESTED card with a suggestion, and the vehicles that carry more than one open card. */
function listStuck({ now } = {}) {
  const rows = all(`
    SELECT j.id, j.job_no, j.is_historical, j.description, j.asset_id, j.requested_at,
           COALESCE(j.total_cost, 0) total_cost, a.code asset_code, a.registration asset_reg,
           (SELECT COUNT(*) FROM job_daily_work w WHERE w.job_id = j.id) daily_work,
           (SELECT COUNT(*) FROM job_parts p WHERE p.job_id = j.id) parts,
           (SELECT COUNT(*) FROM mrn m WHERE m.job_id = j.id) mrns,
           (SELECT COUNT(*) FROM issues i WHERE i.job_id = j.id) issues,
           (SELECT COUNT(*) FROM stock_ledger l WHERE l.job_id = j.id) oil,
           (SELECT COUNT(*) FROM general_item_txns g WHERE g.job_id = j.id) general,
           (SELECT MAX(w.work_date) FROM job_daily_work w WHERE w.job_id = j.id) last_dw,
           (SELECT MAX(substr(m.req_date, 1, 10)) FROM mrn m WHERE m.job_id = j.id) last_mrn,
           (SELECT MAX(substr(i.issue_date, 1, 10)) FROM issues i WHERE i.job_id = j.id) last_issue,
           (SELECT MAX(substr(l.txn_date, 1, 10)) FROM stock_ledger l WHERE l.job_id = j.id) last_oil,
           (SELECT MAX(substr(g.txn_date, 1, 10)) FROM general_item_txns g WHERE g.job_id = j.id) last_general
      FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
     WHERE j.status = 'REQUESTED' AND NOT ${CONTAINER_SQL}
     ORDER BY j.job_no`);
  const cards = rows.map((r) => describe(r, now));
  const counts = { reject: 0, close: 0, keep: 0 };
  for (const c of cards) counts[c.suggestion]++;
  return { stale_days: STALE_DAYS, total: cards.length, counts, cards, duplicate_vehicles: jobstate.duplicateOpenJobs() };
}

const fail = (msg, extra) => { const e = new Error(msg); e.status = 400; if (extra) e.extra = extra; throw e; };

/**
 * Do what the person chose. `actions`: [{ job_id, action: 'reject'|'close', close_date? }].
 * All or nothing: one invalid entry refuses the whole batch, because a half-applied clean-up is
 * worse than none. Returns { rejected, closed, jobs: [...] }.
 */
function applyReview(actions, { userId, user = null, reason, approvalRole = 'transport_manager' }) {
  if (!Array.isArray(actions) || !actions.length) fail('Choose at least one card.');
  const why = String(reason || '').trim();
  if (why.length < 5) fail('Say why (a few words) — it goes on every card changed.');
  const problems = [];
  const plan = [];
  const seen = new Set();
  for (const a of actions) {
    const id = Number(a && a.job_id);
    if (!id || seen.has(id)) { problems.push(`job ${a && a.job_id}: missing or repeated`); continue; }
    seen.add(id);
    const job = get(`SELECT j.* FROM job_cards j WHERE j.id = ? AND NOT ${CONTAINER_SQL}`, id);
    if (!job) { problems.push(`job ${id}: not found, or a container card`); continue; }
    if (job.status !== 'REQUESTED') { problems.push(`${job.job_no}: is ${job.status}, not REQUESTED — left alone`); continue; }
    if (a.action === 'reject') { plan.push({ job, action: 'reject' }); continue; }
    if (a.action === 'close') {
      const d = String(a.close_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) { problems.push(`${job.job_no}: needs a close date`); continue; }
      if (d > today()) { problems.push(`${job.job_no}: close date is in the future`); continue; }
      // A close is a close: the person's approval limit applies here as on the job card.
      if (user) {
        const limits = require('./approval_limits');
        const within = limits.check(user, 'job_close', limits.jobValue(job.id));
        if (!within.ok) { problems.push(`${job.job_no}: costs ${limits.rs(within.value)}, above your limit of ${limits.rs(within.limit)}`); continue; }
      }
      plan.push({ job, action: 'close', date: d });
      continue;
    }
    problems.push(`${job.job_no}: unknown action "${a.action}"`);
  }
  if (problems.length) fail(`Nothing was changed — ${problems.length} problem(s): ${problems.slice(0, 5).join('; ')}`, { problems });

  const done = { rejected: 0, closed: 0, jobs: [] };
  tx(() => {
    for (const p of plan) {
      const { job } = p;
      if (p.action === 'reject') {
        run(`UPDATE job_cards SET status = 'REJECTED', updated_at = datetime('now') WHERE id = ?`, job.id);
        // job_approvals.role only takes the two approval stages; the caller picks one the same way an
        // ordinary rejection does (jobcards.js), so the card's history reads like any other reject.
        run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, ?, ?, 'rejected', ?)`,
          job.id, approvalRole, userId, `Not carried out — ${why}`);
        done.rejected++;
      } else {
        // Exactly what "close on date" does, so reports and the integrity check see the same thing.
        run(`UPDATE job_cards SET status = 'CLOSED', completed_at = ?, closed_at = ?, original_completed_at = NULL,
               updated_at = datetime('now') WHERE id = ?`, p.date, p.date, job.id);
        run(`UPDATE job_reopens SET reclosed_at = datetime('now') WHERE job_id = ? AND reclosed_at IS NULL`, job.id);
        costing.snapshotJobCost(job.id);
        done.closed++;
      }
      // The vehicle is back in service only if no other card still holds it.
      if (job.asset_id && !jobstate.openJobFor(job.asset_id)) {
        run(`UPDATE assets SET status = 'active' WHERE id = ? AND status = 'under_repair'`, job.asset_id);
      }
      done.jobs.push({ id: job.id, job_no: job.job_no, action: p.action, date: p.date || null });
    }
  });
  return done;
}

module.exports = { listStuck, applyReview, periodFromJobNo, STALE_DAYS, _describe: describe };
