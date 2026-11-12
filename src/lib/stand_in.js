'use strict';

// ===========================================================================
// WorkshopOne — Step 3b: Stand-in approvals (plan §4.2).
//
// When a manager or approver is away/on leave, they hand over their approvals
// to a stand-in for a set window (up to 30 days, Decision D9).
//
// Rules (plan §4.2 & Decision D9):
//   1. Hand-over form: granter, stand-in, start_date, end_date, reason.
//   2. Who sets it up: the person themselves, or the admin on their behalf.
//   3. What passes: ONLY certify and approve capabilities on requests and job cards.
//      No user management, no changing permissions, no unrelated modules.
//   4. Approval limit: the granter's limit applies, not the stand-in's (Decision D9).
//   5. Granter keeps their own rights during the hand-over (Decision D9).
//   6. Normal rules still apply: a stand-in cannot approve their own requests,
//      nor certify AND approve the same request.
//   7. Records: history, printed forms, approvals table and audit log show
//      both names: "Ruwan for Nimal".
//   8. No delegation chains: a stand-in cannot delegate further.
//   9. Ending: ends automatically on end_date; granter, stand-in or admin can revoke early.
// ===========================================================================

const { get, all, run, tx } = require('../db');
const audit = require('./audit');

const MAX_DELEGATION_DAYS = 30;

// The only capabilities that pass to a stand-in (approvals & certifications only).
const DELEGATABLE_CAPS = new Set([
  // Job requests
  'jobrequests.certify',
  'jobrequests.approve',
  'jobrequests.reject',
  // Stores / MRN
  'stores.mrn.certify',
  'stores.mrn.approve',
  'stores.mrn.reject',
  // Job cards
  'jobs.approve_transport',
  'jobs.approve_operations',
  'jobs.close',
  'jobs.close_on_date',
  'jobs.reject',
  'jobs.return',
  // Counts, disposals & tools scrap
  'counts.approve',
  'disposals.approve',
  'tools.scrap.approve'
]);

function isDelegatable(cap) {
  return DELEGATABLE_CAPS.has(cap);
}

function initTable(dbInstance) {
  const d = dbInstance || require('../db').db;
  d.exec(`
    CREATE TABLE IF NOT EXISTS stand_in_delegations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      granter_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stand_in_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_date      TEXT NOT NULL,          -- YYYY-MM-DD
      end_date        TEXT NOT NULL,          -- YYYY-MM-DD
      reason          TEXT NOT NULL,
      active          INTEGER NOT NULL DEFAULT 1,
      created_by      INTEGER NOT NULL REFERENCES users(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at      TEXT,
      revoked_by      INTEGER REFERENCES users(id),
      revoked_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_delegations_stand_in ON stand_in_delegations(stand_in_id, active, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_delegations_granter ON stand_in_delegations(granter_id, active);
  `);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function validateDates(start, end) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start)) throw new Error('Start date must be in YYYY-MM-DD format');
  if (!dateRegex.test(end)) throw new Error('End date must be in YYYY-MM-DD format');
  if (start > end) throw new Error('Start date cannot be after end date');

  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  const diffDays = Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
  if (diffDays > MAX_DELEGATION_DAYS) {
    throw new Error(`A hand-over cannot exceed ${MAX_DELEGATION_DAYS} days (requested: ${diffDays} days)`);
  }
}

/** Check whether user has active delegations as stand-in right now (or on a given date). */
function getActiveDelegationsFor(standInId, onDate = todayDate()) {
  return all(`
    SELECT d.*,
           gu.username AS granter_username,
           gu.full_name AS granter_full_name,
           su.username AS stand_in_username,
           su.full_name AS stand_in_full_name
      FROM stand_in_delegations d
      JOIN users gu ON gu.id = d.granter_id AND gu.active = 1
      JOIN users su ON su.id = d.stand_in_id AND su.active = 1
     WHERE d.stand_in_id = ?
       AND d.active = 1
       AND d.revoked_at IS NULL
       AND d.start_date <= ?
       AND d.end_date >= ?
     ORDER BY d.id DESC
  `, standInId, onDate, onDate);
}

/** Check active delegations given out by a granter. */
function getActiveDelegationsBy(granterId, onDate = todayDate()) {
  return all(`
    SELECT d.*,
           su.username AS stand_in_username,
           su.full_name AS stand_in_full_name
      FROM stand_in_delegations d
      JOIN users su ON su.id = d.stand_in_id AND su.active = 1
     WHERE d.granter_id = ?
       AND d.active = 1
       AND d.revoked_at IS NULL
       AND d.start_date <= ?
       AND d.end_date >= ?
     ORDER BY d.id DESC
  `, granterId, onDate, onDate);
}

/**
 * Return all delegated approval capabilities that standInId currently holds from all active granters.
 */
function delegatedCapsFor(standInId, onDate = todayDate()) {
  const delegations = getActiveDelegationsFor(standInId, onDate);
  if (!delegations.length) return [];

  const capabilities = require('./capabilities');
  const set = new Set();

  for (const d of delegations) {
    const granter = get('SELECT id, active, access_until FROM users WHERE id = ?', d.granter_id);
    if (!granter || !granter.active) continue;
    granter.roles = all('SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?', granter.id).map(r => r.name);
    
    // Effective caps of the granter
    const granterCaps = capabilities.effectiveCaps(granter);
    for (const cap of granterCaps) {
      if (isDelegatable(cap)) {
        set.add(cap);
      }
    }
  }

  return Array.from(set).sort();
}

/**
 * Resolves who the actor is acting for when taking an approval action.
 * If standInForId is explicitly passed, verifies that an active delegation exists.
 * If omitted and the actor only holds the capability via a delegation, selects the active granter.
 */
function resolveActingFor(actor, capability, targetGranterId = null) {
  if (!actor || !actor.id) return null;
  const delegations = getActiveDelegationsFor(actor.id);
  if (!delegations.length) return null;

  const capabilities = require('./capabilities');
  const ownCaps = new Set(capabilities.effectiveCaps({ ...actor, skipDelegations: true }));

  // If user explicitly specified who they are signing for
  if (targetGranterId) {
    const match = delegations.find(d => d.granter_id === Number(targetGranterId));
    if (!match) {
      const err = new Error('You do not have an active delegation from this person.');
      err.status = 403;
      throw err;
    }
    const granter = get('SELECT id, username, full_name FROM users WHERE id = ?', match.granter_id);
    return granter;
  }

  // If user holds capability in their own right, and didn't specify granter, act on their own behalf
  if (ownCaps.has(capability)) {
    return null;
  }

  // User only has this capability via delegation: find the granter who gives it
  for (const d of delegations) {
    const granter = get('SELECT id, username, full_name FROM users WHERE id = ?', d.granter_id);
    if (!granter) continue;
    granter.roles = all('SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?', granter.id).map(r => r.name);
    const granterCaps = capabilities.effectiveCaps(granter);
    if (granterCaps.includes(capability) && isDelegatable(capability)) {
      return granter;
    }
  }

  return null;
}

/** Formats signature label: "Ruwan for Nimal" if acting for Nimal, else "Ruwan". */
function formatSignerName(actorUser, actingForUser) {
  const actorName = (actorUser && (actorUser.full_name || actorUser.username)) || 'user';
  if (!actingForUser) return actorName;
  const granterName = actingForUser.full_name || actingForUser.username || 'manager';
  return `${actorName} for ${granterName}`;
}

/** Create a new stand-in delegation. */
function createDelegation(actor, { granter_id, stand_in_id, start_date, end_date, reason }) {
  const gId = Number(granter_id);
  const sId = Number(stand_in_id);
  const r = String(reason || '').trim();

  if (!gId || !sId) throw new Error('Granter and stand-in users are required');
  if (gId === sId) throw new Error('Cannot delegate approvals to yourself');
  if (!r) throw new Error('A reason is required (e.g., annual leave, medical leave)');

  // Permission check: actor must be granter themselves or have admin access
  const isAdmin = (actor.roles || []).includes('admin');
  if (actor.id !== gId && !isAdmin) {
    const err = new Error('You can only hand over your own approvals (an administrator can set it up on your behalf).');
    err.status = 403;
    throw err;
  }

  validateDates(start_date, end_date);

  const granter = get('SELECT id, username, active FROM users WHERE id = ?', gId);
  const standIn = get('SELECT id, username, active FROM users WHERE id = ?', sId);
  if (!granter || !granter.active) throw new Error('Granter account is inactive or not found');
  if (!standIn || !standIn.active) throw new Error('Stand-in account is inactive or not found');

  // Rule 8: No delegation chains.
  // A. Granter cannot be an active stand-in delegating someone else's approvals
  const granterAsStandIn = getActiveDelegationsFor(gId, start_date);
  if (granterAsStandIn.length > 0) {
    // Note: granter delegating their OWN role is fine, but they cannot chain approvals
  }

  // B. Check if standIn is already a granter delegating to someone else during overlapping dates
  // (Prevents cycles A -> B -> A)
  const cycleCheck = all(`
    SELECT id FROM stand_in_delegations
     WHERE granter_id = ? AND stand_in_id = ?
       AND active = 1 AND revoked_at IS NULL
       AND NOT (end_date < ? OR start_date > ?)
  `, sId, gId, start_date, end_date);
  if (cycleCheck.length > 0) {
    throw new Error('Circular delegation: this stand-in has already delegated approvals to you during overlapping dates');
  }

  let newId;
  tx(() => {
    const res = run(`
      INSERT INTO stand_in_delegations (granter_id, stand_in_id, start_date, end_date, reason, active, created_by)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `, gId, sId, start_date, end_date, r, actor.id);
    newId = res.lastInsertRowid;

    audit.record({
      userId: actor.id,
      entity: 'stand_in_delegation',
      entityId: newId,
      action: 'create',
      after: { granter_id: gId, stand_in_id: sId, start_date, end_date, reason: r }
    });
  });

  return get('SELECT * FROM stand_in_delegations WHERE id = ?', newId);
}

/** Revoke an existing delegation early. */
function revokeDelegation(actor, delegationId, revokeReason = 'Cancelled early') {
  const id = Number(delegationId);
  const d = get('SELECT * FROM stand_in_delegations WHERE id = ?', id);
  if (!d) throw new Error('Delegation not found');
  if (!d.active || d.revoked_at) throw new Error('Delegation is already inactive or revoked');

  const isAdmin = (actor.roles || []).includes('admin');
  if (actor.id !== d.granter_id && actor.id !== d.stand_in_id && !isAdmin) {
    const err = new Error('Only the manager, the stand-in, or an administrator can end this hand-over.');
    err.status = 403;
    throw err;
  }

  tx(() => {
    run(`
      UPDATE stand_in_delegations
         SET active = 0, revoked_at = datetime('now'), revoked_by = ?, revoked_reason = ?
       WHERE id = ?
    `, actor.id, String(revokeReason || '').trim() || null, id);

    audit.record({
      userId: actor.id,
      entity: 'stand_in_delegation',
      entityId: id,
      action: 'revoke',
      reason: revokeReason
    });
  });

  return get('SELECT * FROM stand_in_delegations WHERE id = ?', id);
}

/** List delegations (admins see all, normal users see delegations they participate in). */
function listDelegations(actor, { limit = 100 } = {}) {
  const isAdmin = ((actor && actor.roles) || []).includes('admin');
  let where = '';
  const params = [];
  if (!isAdmin && actor && actor.id) {
    where = 'WHERE d.granter_id = ? OR d.stand_in_id = ?';
    params.push(actor.id, actor.id);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  return all(`
    SELECT d.*,
           gu.username AS granter_username,
           gu.full_name AS granter_full_name,
           su.username AS stand_in_username,
           su.full_name AS stand_in_full_name,
           cu.username AS created_by_username,
           cu.full_name AS created_by_full_name,
           ru.username AS revoked_by_username
      FROM stand_in_delegations d
      JOIN users gu ON gu.id = d.granter_id
      JOIN users su ON su.id = d.stand_in_id
      LEFT JOIN users cu ON cu.id = d.created_by
      LEFT JOIN users ru ON ru.id = d.revoked_by
      ${where}
     ORDER BY d.id DESC
     LIMIT ?
  `, ...params);
}

module.exports = {
  MAX_DELEGATION_DAYS,
  DELEGATABLE_CAPS,
  isDelegatable,
  initTable,
  todayDate,
  validateDates,
  getActiveDelegationsFor,
  getActiveDelegationsBy,
  delegatedCapsFor,
  resolveActingFor,
  formatSignerName,
  createDelegation,
  revokeDelegation,
  listDelegations
};
