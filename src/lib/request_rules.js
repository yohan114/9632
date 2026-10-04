'use strict';

// ===========================================================================
// Improvement plan, Step 3a — the permission gaps on requests (plan §4.2).
//
// A job request and a material request (MRN) each go raised → certified → approved. Two rules
// close the gaps the plan names:
//
//   1. Whoever raised a request does not certify or approve it. Someone else does. (The certifier
//      not also approving was already the rule: routes/jobrequests.js, routes/stores.js.) The
//      admin is exempt, as from the certifier rule.
//   2. What was certified is what gets approved. Certifying seals the request: a fingerprint of
//      what was asked for. Approving checks the seal. A request changed since, by any route,
//      goes back to be certified again instead of being approved. (Editing a certified MRN on its
//      own edit routes already withdraws the certification; the seal also catches every other way.)
//
// The seal covers what was asked for: the items, quantities and units, the purpose, the dates, the
// job and who asked. Not the vehicle or an item's category: merging two records of the same vehicle
// (asset_repoint.js) or two categories (categories.js) rewrites those without anyone changing the
// request, and must not stop an approval.
// ===========================================================================

const crypto = require('crypto');
const { get, all, run } = require('../db');
const { isAdmin } = require('./access_rules');

/** The fingerprint of what a request asks for (null if there is no such request). */
function seal(kind, id) {
  let content;
  if (kind === 'mrn') {
    const m = get('SELECT purpose, requested_by, req_date, required_date, project_id, job_id FROM mrn WHERE id = ?', id);
    if (!m) return null;
    content = { m, lines: all('SELECT id, description, qty, unit FROM mrn_lines WHERE mrn_id = ? ORDER BY id', id) };
  } else {
    const r = get(`SELECT description, type, severity, priority, req_date, required_date, project_id, requested_by
                     FROM job_requests WHERE id = ?`, id);
    if (!r) return null;
    content = { r };
  }
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Has a certified request changed since it was certified? (A request with no seal has nothing to compare.) */
const changedSinceCertified = (kind, row) => !!(row && row.certified_seal && row.certified_seal !== seal(kind, row.id));

/** The user who raised a request (null for imported ones, which predate this). */
const raiserOf = (kind, row) => (row ? (kind === 'mrn' ? row.raised_by_user : row.requested_by_user) : null) || null;

/** May this person certify or approve (act) a request they raised? null when they may, else the 403 body. */
function selfRefusal(user, kind, row, act, actingFor = null) {
  const raiser = raiserOf(kind, row);
  if (raiser == null || !user || isAdmin(user)) return null;
  if (raiser === user.id) {
    return { error: `You raised this request. Someone else must ${act} it.`, own_request: true };
  }
  if (actingFor && raiser === actingFor.id) {
    return { error: `You are acting for the person who raised this request. Someone else must ${act} it.`, own_request: true };
  }
  return null;
}

/** Is this the person's own request, for the screens (false for the admin, who is exempt)? */
const raisedBy = (user, kind, row) => !!user && !isAdmin(user) && raiserOf(kind, row) === user.id;

const CHANGED = 'This request was changed after it was certified. It must be certified again.';

/** Send a certified job request back to be certified again, because it changed under the signature. */
function withdrawJobRequest(jr, userId) {
  run(`UPDATE job_requests SET approval_status = 'requested', certified_by = NULL, certified_at = NULL,
              certified_sig = NULL, certified_seal = NULL WHERE id = ?`, jr.id);
  run(`INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, signed_name, decision, reason)
       VALUES (?, 'certify', 'transport_manager', ?, ?, 'rejected', 'certification withdrawn — the request changed after signing')`,
  jr.id, userId, jr.certified_by || null);
}

/** Seal the requests certified before seals existed, as they stand now (run once by migrate). */
function sealMissing() {
  for (const kind of ['mrn', 'job_requests']) {
    for (const r of all(`SELECT id FROM ${kind} WHERE approval_status = 'certified' AND certified_seal IS NULL`)) {
      run(`UPDATE ${kind} SET certified_seal = ? WHERE id = ?`, seal(kind === 'mrn' ? 'mrn' : 'jr', r.id), r.id);
    }
  }
}

module.exports = { seal, changedSinceCertified, raiserOf, selfRefusal, raisedBy, withdrawJobRequest, sealMissing, CHANGED };
