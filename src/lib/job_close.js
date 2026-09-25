'use strict';

// ===========================================================================
// Partial close, full close and reopen requests (docs/WORKSHOPONE_PLAN.md §A.2, Stage W2).
//
//   IN_PROGRESS / WORK_COMPLETE ──"Partly close"──► PARTIALLY_CLOSED ──"Close fully"──► CLOSED
//                                                         │
//                                       "Request reopen" ─┴─► (approved) ─► IN_PROGRESS
//
// PARTLY CLOSE is for when the work is finished and the vehicle has left, but prices or records are
// still missing. The card stops holding the vehicle — a new card can be opened for it at once —
// and from then on takes only prices, what was already requested, general items and daily work up
// to the partial-close day (jobstate.checkAdd). Its report month is the partial-close month: a
// later full close does not move it (decision W-D9, the same principle as the reopen anchor).
//
// CLOSE FULLY needs the closure check to pass, which now includes "work done is recorded".
//
// A REOPEN, of a partly closed or a closed card, is ASKED FOR and approved by somebody else who
// holds jobs.reopen — and only when the vehicle has no other open card.
// ===========================================================================

const { get, all, run, tx } = require('../db');
const jobstate = require('./jobstate');
const costing = require('./costing');
const jobno = require('./jobno');

const bad = (msg, status = 400, extra = {}) => { const e = new Error(msg); e.status = status; e.extra = extra; return e; };
const today = () => new Date().toISOString().slice(0, 10);

function setEnabled(on) {
  run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    jobstate.PARTIAL_FLAG, on ? '1' : '0');
  return jobstate.partialCloseEnabled();
}

/** Is some work done recorded? A repair: a daily-work line. A service: its flat labour. */
function workRecorded(job) {
  if (job.type === 'service') return job.flat_labour != null;
  return !!get('SELECT 1 x FROM job_daily_work WHERE job_id = ? LIMIT 1', job.id);
}

// Full close: the closure check has to pass. closeCheck says whether the Close button would let this
// card through; closeGate turns a "no" into the 409 body. The Ready to close list uses closeCheck, so
// the list and the button always agree (job cards plan, Part 3).
// Switched off (the flow before W2): only a card's FIRST close is checked — a card that was closed
// once already cleared it, or was closed by import / close-on-date, which never checked. Switched
// on, nothing needs that excuse any more (an unfinished card can be partly closed), so every live
// card is checked, including "work done is recorded"; only reopened imported history is excused.
function closeCheck(job) {
  const readiness = costing.closureReadiness(job.id);
  if (readiness.ready) return { ok: true, readiness };
  const wasReopened = !!get('SELECT 1 v FROM job_reopens WHERE job_id = ? LIMIT 1', job.id);
  return { ok: jobstate.partialCloseEnabled() ? wasReopened && !!job.is_historical : wasReopened, readiness };
}

/** null (may close) or the 409 body. */
function closeGate(job) {
  const { ok, readiness } = closeCheck(job);
  if (ok) return null;
  if (!jobstate.partialCloseEnabled()) return { error: 'Job is not fully priced — cannot close', missing: readiness.missing };
  const n = readiness.missing.length;
  return {
    error: `Not ready to close fully — ${n} thing${n === 1 ? '' : 's'} still missing.`
      + (job.status === jobstate.PARTIAL ? '' : ' Partly close it instead, and close it fully once they are done.'),
    missing: readiness.missing,
  };
}

/** Put the vehicle back in service if no other card holds it. */
function releaseVehicle(job) {
  if (!job.asset_id) return;
  if (jobstate.openJobFor(job.asset_id, { excludeJobId: job.id })) return;
  run(`UPDATE assets SET status = 'active' WHERE id = ? AND status = 'under_repair'`, job.asset_id);
}

/**
 * Partly close a card.
 * @param {object} job   the job_cards row
 * @param {{user: object, note?: string, date?: string, openNew?: boolean, newJob?: {description?, type?},
 *          fromStatuses?: string[], onDate?: boolean}} opts
 *   date:   the partial-close day; defaults to now. A chosen date (close on date) also sets the
 *           report month to it and drops a reopen anchor — explicit intent wins, as it does for
 *           close-on-date.
 *   openNew: also open a new card for the vehicle, pointing back to this one.
 * @returns {{ job, newJobId, missing }}
 */
function partialClose(job, { user, note = '', date = null, openNew = false, newJob = {}, fromStatuses = ['IN_PROGRESS', 'WORK_COMPLETE'] } = {}) {
  if (!job) throw bad('Job not found', 404);
  if (job.status === jobstate.PARTIAL) throw bad(`${job.job_no} is already partly closed`, 409);
  if (!fromStatuses.includes(job.status)) {
    throw bad(`A ${job.status.replace(/_/g, ' ')} job cannot be partly closed — only one that is in progress or work complete`, 409);
  }
  const text = String(note || '').trim();
  if (text.length > 500) throw bad('The note is too long (500 characters at most)');
  // W-D7: some work must be recorded — or the note says why there is none.
  if (!workRecorded(job) && !text) {
    throw bad(job.type === 'service'
      ? 'No work is recorded on this job (the service labour is not set). Set it, or write why in the note.'
      : 'No work is recorded on this job (no daily work). Add it, or write why in the note.');
  }
  const readiness = costing.closureReadiness(job.id);
  if (readiness.ready) throw bad('Nothing is outstanding on this job — close it fully instead.', 409);

  let newType = null;
  if (openNew) {
    if (!job.asset_id) throw bad('This job has no vehicle, so there is no new job to open for it', 400);
    if (!(user && Array.isArray(user.caps) ? user.caps : require('./capabilities').capsForRoles((user && user.roles) || [])).includes('jobs.create')) {
      throw bad('Opening a new job needs the permission "Open a new job card"', 403);
    }
    const guard = jobstate.checkOneOpenJob(job.asset_id, { excludeJobId: job.id });
    if (!guard.ok) {
      throw bad(`The vehicle already has an open job (${guard.blocking.job_no}) — untick "Open a new job".`, 409, { blocking_job: guard.blocking });
    }
    newType = newJob.type === 'service' || newJob.type === 'repair' ? newJob.type : job.type;
  }

  const onDate = !!date;
  const day = onDate ? String(date).slice(0, 10) : null;
  let newJobId = null;
  tx(() => {
    if (onDate) {
      run(`UPDATE job_cards SET status = ?, partial_closed_at = ?, partial_closed_by = ?, partial_note = ?,
             completed_at = ?, original_completed_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      jobstate.PARTIAL, day, user ? user.id : null, text || null, day, job.id);
    } else {
      // The report month: a reopened card goes back to the month it was first closed in; otherwise
      // it is this month (W-D9). Kept when the card is closed fully later.
      run(`UPDATE job_cards SET status = ?, partial_closed_at = datetime('now'), partial_closed_by = ?, partial_note = ?,
             completed_at = COALESCE(original_completed_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`,
      jobstate.PARTIAL, user ? user.id : null, text || null, job.id);
    }
    run(`UPDATE job_reopens SET reclosed_at = datetime('now') WHERE job_id = ? AND reclosed_at IS NULL`, job.id);
    costing.refreshJobTotals(job.id);
    releaseVehicle(job);
    if (openNew) {
      const desc = String(newJob.description || '').trim() || `Continued from ${job.job_no}${job.description ? ': ' + job.description : ''}`;
      newJobId = run(
        // Same workshop as the card it continues (Stage 2).
        `INSERT INTO job_cards (job_no, asset_id, project_id, site, type, description, status, requested_by, requested_by_user, continues_job_id, workshop_id)
         VALUES (?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?)`,
        jobno.nextJobNo(newType), job.asset_id, job.project_id || null, job.site || null, newType, desc.slice(0, 500),
        (user && (user.fullName || user.username)) || null, user ? user.id : null, job.id, job.workshop_id || null).lastInsertRowid;
    }
  });
  return { job: get('SELECT * FROM job_cards WHERE id = ?', job.id), newJobId, missing: readiness.missing };
}

/**
 * Reopen a closed or partly closed card: back to IN_PROGRESS. Records the close being undone in
 * job_reopens, and keeps the month the card was FIRST closed in (original_completed_at), so a
 * report already issued does not change when it is closed again. Call inside a transaction; the
 * caller has already checked who may, and the one-open-card rule.
 */
function applyReopen(job, { userId, reason }) {
  run(
    `INSERT INTO job_reopens (job_id, reopened_by, reason, prev_status, prev_completed_at, prev_closed_at, prev_total_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    job.id, userId || null, String(reason).trim(), job.status, job.completed_at, job.closed_at, job.total_cost);
  // Leaving completed_at/closed_at set on an IN_PROGRESS card makes the status and the dates
  // disagree everywhere (dashboard counts, the closed-this-month figure, and the card's own MRN
  // window, which would stay clipped at the old close date and hide the very parts the job was
  // reopened to add). First reopen wins: the anchor is the month the card was ORIGINALLY closed in.
  run(`UPDATE job_cards
          SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, datetime('now')),
              original_completed_at = COALESCE(original_completed_at, completed_at),
              completed_at = NULL, closed_at = NULL,
              partial_closed_at = NULL, partial_closed_by = NULL, partial_note = NULL,
              updated_at = datetime('now')
        WHERE id = ?`, job.id);
  if (job.asset_id) run(`UPDATE assets SET status = 'under_repair' WHERE id = ? AND status <> 'decommissioned'`, job.asset_id);
}

/** The one-open-card rule for a reopen: the vehicle's new card has to be finished first. */
function reopenBlocker(job) {
  const guard = jobstate.checkOneOpenJob(job.asset_id, { excludeJobId: job.id });
  if (guard.ok) return null;
  return { status: 409, error: `Cannot reopen — ${guard.blocking.job_no} is open for this vehicle. Finish or close it first.`, blocking_job: guard.blocking };
}

// ---- reopen requests ----------------------------------------------------------------------------

function pendingFor(jobId) {
  return get(`SELECT * FROM job_reopen_requests WHERE job_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`, jobId) || null;
}

/** Ask for a reopen. Who may ask (jobs.reopen_request) is the route's to check. */
function requestReopen(job, { userId, reason }) {
  if (!job) throw bad('Job not found', 404);
  if (!jobstate.REOPENABLE.includes(job.status)) throw bad(`Only a partly closed or closed job can be reopened (${job.job_no} is ${job.status})`, 409);
  const why = String(reason == null ? '' : reason).trim();
  if (!why) throw bad('Give the reason for reopening');
  if (why.length > 500) throw bad('The reason is too long (500 characters at most)');
  const open = pendingFor(job.id);
  if (open) throw bad(`A reopen of ${job.job_no} has already been asked for — it is waiting for approval`, 409);
  const id = run('INSERT INTO job_reopen_requests (job_id, requested_by, reason) VALUES (?, ?, ?)', job.id, userId || null, why).lastInsertRowid;
  return get('SELECT * FROM job_reopen_requests WHERE id = ?', id);
}

/**
 * Approve or refuse a reopen request. The approver holds jobs.reopen (the route checks) and is not
 * the person who asked (an admin excepted, as for the other approvals). Approving carries out the
 * reopen — only when the vehicle has no other open card.
 */
function decideReopen(requestId, { user, approve, note, isAdmin = false }) {
  const r = get('SELECT * FROM job_reopen_requests WHERE id = ?', requestId);
  if (!r) throw bad('Reopen request not found', 404);
  if (r.status !== 'pending') throw bad(`This request was already ${r.status}`, 409);
  if (r.requested_by && user && r.requested_by === user.id && !isAdmin) {
    throw bad('You asked for this reopen, so somebody else has to approve or refuse it.', 403);
  }
  const text = String(note == null ? '' : note).trim();
  if (text.length > 500) throw bad('The note is too long (500 characters at most)');
  const job = get('SELECT * FROM job_cards WHERE id = ?', r.job_id);
  if (!approve) {
    if (!text) throw bad('Say why the reopen is refused');
    run(`UPDATE job_reopen_requests SET status = 'refused', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`,
      user ? user.id : null, text, r.id);
    return { request: get('SELECT * FROM job_reopen_requests WHERE id = ?', r.id), job };
  }
  if (!job || !jobstate.REOPENABLE.includes(job.status)) throw bad(`${job ? job.job_no : 'The job'} is no longer closed — nothing to reopen`, 409);
  const blocked = reopenBlocker(job);
  if (blocked) throw bad(blocked.error, blocked.status, { blocking_job: blocked.blocking_job });
  tx(() => {
    applyReopen(job, { userId: user ? user.id : null, reason: `${r.reason} (request #${r.id})` });
    run(`UPDATE job_reopen_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`,
      user ? user.id : null, text || null, r.id);
  });
  return { request: get('SELECT * FROM job_reopen_requests WHERE id = ?', r.id), job: get('SELECT * FROM job_cards WHERE id = ?', job.id), before: job };
}

/** Requests waiting for a decision — for "Pending your approval". */
function pendingRequests({ excludeRequester = null, workshopId = null } = {}) {
  // workshopId: only that workshop's cards (Stage 3 scoping), else every workshop.
  const params = [];
  const inWs = require('./jobstate').workshopIn('j.workshop_id', workshopId);
  if (excludeRequester) params.push(excludeRequester);
  params.push(...inWs.params);
  return all(
    `SELECT r.id, r.job_id, r.reason, r.requested_at, r.requested_by, u.username AS requested_by_name,
            j.job_no, j.status AS job_status, j.description, j.workshop_id,
            a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
       FROM job_reopen_requests r
       JOIN job_cards j ON j.id = r.job_id
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN assets a ON a.id = j.asset_id
      WHERE r.status = 'pending' ${excludeRequester ? 'AND COALESCE(r.requested_by, 0) <> ?' : ''}
        ${inWs.sql}
      ORDER BY r.id DESC LIMIT 50`, ...params);
}

function requestsFor(jobId) {
  return all(
    `SELECT r.*, u.username AS requested_by_name, d.username AS decided_by_name
       FROM job_reopen_requests r
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN users d ON d.id = r.decided_by
      WHERE r.job_id = ? ORDER BY r.id DESC`, jobId);
}

module.exports = {
  setEnabled, workRecorded, closeCheck, closeGate, releaseVehicle, partialClose, applyReopen, reopenBlocker,
  pendingFor, requestReopen, decideReopen, pendingRequests, requestsFor, today,
};
