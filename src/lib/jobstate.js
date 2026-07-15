'use strict';

// ===========================================================================
// Job Card lifecycle — an explicit state machine (brief §6).
// A card only moves forward when the step's conditions are met; closure is
// gated by the costing engine (every consumed line must be priced).
// ===========================================================================

const STATES = [
  'REQUESTED',
  'APPROVED_TRANSPORT',
  'APPROVED_OPERATIONS',
  'IN_WORKSHOP',
  'IN_PROGRESS',
  'WORK_COMPLETE',
  'CLOSED',
  'REJECTED',
];

// target -> { from:[...], roles:[...], action:label }
// admin is implicitly allowed everywhere (checked in the route layer).
const TRANSITIONS = {
  APPROVED_TRANSPORT: { from: ['REQUESTED'], roles: ['transport_manager'], action: 'transport_approve' },
  APPROVED_OPERATIONS: { from: ['APPROVED_TRANSPORT'], roles: ['operational_manager'], action: 'ops_approve' },
  IN_WORKSHOP: { from: ['APPROVED_OPERATIONS'], roles: ['workshop'], action: 'assign' },
  IN_PROGRESS: {
    from: ['IN_WORKSHOP', 'WORK_COMPLETE', 'CLOSED'],
    roles: ['workshop'],
    action: 'start_or_reopen',
  },
  WORK_COMPLETE: { from: ['IN_PROGRESS'], roles: ['workshop'], action: 'mark_complete' },
  CLOSED: { from: ['WORK_COMPLETE'], roles: ['operational_manager', 'workshop'], action: 'close', gated: true },
  // Rejection at either approval step.
  REJECTED: { from: ['REQUESTED', 'APPROVED_TRANSPORT'], roles: ['transport_manager', 'operational_manager'], action: 'reject' },
  // A rejection can also bounce back to REQUESTED (with a reason).
  REQUESTED: { from: ['APPROVED_TRANSPORT', 'REJECTED'], roles: ['transport_manager', 'operational_manager'], action: 'return' },
};

function isValidState(s) {
  return STATES.includes(s);
}

/** Which target states are reachable from `current`. */
function nextStates(current) {
  return Object.keys(TRANSITIONS).filter((to) => TRANSITIONS[to].from.includes(current));
}

/**
 * Validate a transition. Reopening CLOSED -> IN_PROGRESS is admin-only.
 * @returns {{ok:boolean, error?:string, def?:object}}
 */
function checkTransition(current, target, roles = []) {
  const def = TRANSITIONS[target];
  if (!def) return { ok: false, error: `Unknown target state ${target}` };
  if (!def.from.includes(current)) {
    return { ok: false, error: `Cannot move ${current} -> ${target}` };
  }
  const held = new Set(roles);
  const isAdmin = held.has('admin');
  // Reopening a CLOSED card is admin-only and audited.
  if (current === 'CLOSED' && !isAdmin) {
    return { ok: false, error: 'Reopening a closed job requires admin' };
  }
  if (!isAdmin && !def.roles.some((r) => held.has(r))) {
    return { ok: false, error: `Requires one of role: ${def.roles.join(', ')}` };
  }
  return { ok: true, def };
}

module.exports = { STATES, TRANSITIONS, isValidState, nextStates, checkTransition };
