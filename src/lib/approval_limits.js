'use strict';

// ===========================================================================
// Approval limits (Stage 1) — the most money a role may sign off on its own.
//
// An admin sets an amount per ROLE and per KIND of approval, on Access Control → Approval limits.
// No amount set = no limit, so nothing changes until one is typed in. Admin never has a limit.
//
// A person with several roles gets the highest limit among the roles that give them that
// approval; if any of those roles has no limit, neither do they. Roles that do not give the
// approval do not count — a "viewer" role with no limit set must not lift a manager's limit.
//
// A PERSON can have a limit of their own (access plan, Part 3), set on the People screen. It
// replaces their roles' limit for that kind of approval — higher or lower.
//
// Only approvals where the money is known at the moment of signing carry a limit:
//   mrn_approve  approving an MRN — its estimated value: each line's quantity × the last price
//                paid for that item. Lines with no known price are counted as nothing and shown.
//   job_close    closing a job card fully — the job's total cost.
// A job card's approval and a job request's approval carry no amount (the cost is not known until
// the work is done), so the limit on a job sits where its cost becomes final: the full close.
// A partial close is not a full close and is not checked; closing it fully later is.
// ===========================================================================

const { get, all, run } = require('../db');

const KINDS = {
  mrn_approve: {
    label: 'Approve an MRN',
    measure: 'Estimated value: quantity × last price paid',
    caps: ['stores.mrn.approve'],
  },
  job_close: {
    label: 'Close a job card fully',
    measure: 'Total cost of the job',
    caps: ['jobs.close', 'jobs.close_on_date', 'jobs.triage'],
  },
};
const KIND_KEYS = Object.keys(KINDS);

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const kindDef = (kind) => KINDS[kind] || fail(400, `Unknown approval kind: ${kind}`);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rs = (n) => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-US');
const isAdminRoles = (roles) => (roles || []).includes('admin');

/** Of these roles, the ones that give an approval of this kind (active roles only). */
function rolesGiving(roles, kind) {
  const { caps } = kindDef(kind);
  if (!roles || !roles.length) return [];
  const r = roles.map(() => '?').join(',');
  const c = caps.map(() => '?').join(',');
  return all(`SELECT DISTINCT rc.role FROM role_capabilities rc
                JOIN roles ro ON ro.name = rc.role AND COALESCE(ro.active, 1) = 1
               WHERE rc.granted = 1 AND rc.role IN (${r}) AND rc.capability IN (${c})`, ...roles, ...caps)
    .map((x) => x.role);
}

const limitRow = (role, kind) => get('SELECT max_amount FROM approval_limits WHERE role = ? AND kind = ?', role, kind);
const ownRow = (userId, kind) => (userId ? get('SELECT max_amount, set_by, set_at FROM user_approval_limits WHERE user_id = ? AND kind = ?', userId, kind) : null);

/** A person's own limits: { kind: { max_amount, set_by, set_at } }. */
function personalFor(userId) {
  if (!userId) return {};
  return Object.fromEntries(all('SELECT kind, max_amount, set_by, set_at FROM user_approval_limits WHERE user_id = ?', userId)
    .filter((r) => KINDS[r.kind]).map((r) => [r.kind, { max_amount: r.max_amount, set_by: r.set_by, set_at: r.set_at }]));
}

/** Does this person give approvals of this kind (hold any of its permissions)? */
const gives = (user, kind) => {
  const held = require('./auth').capsOf(user);
  return kindDef(kind).caps.some((c) => held.includes(c));
};

/** The limit this person's ROLES give for a kind of approval: an amount, or null for no limit. */
function roleLimitFor(user, kind) {
  kindDef(kind);
  const roles = (user && user.roles) || [];
  if (isAdminRoles(roles)) return null;
  const giving = rolesGiving(roles, kind);
  if (!giving.length) return null;   // the route's own capability check refuses them first
  let best = 0;
  for (const role of giving) {
    const row = limitRow(role, kind);
    if (!row) return null;
    best = Math.max(best, row.max_amount);
  }
  return best;
}

/** This person's limit for a kind of approval: their own if one was set, else their roles'. */
function limitFor(user, kind) {
  kindDef(kind);
  if (isAdminRoles((user && user.roles) || [])) return null;
  const own = ownRow(user && user.id, kind);
  return own ? own.max_amount : roleLimitFor(user, kind);
}

/**
 * The roles (by label) that may sign off this amount — for the refusal, and the screens. Only
 * roles somebody active holds: "needs: Senior Approver" is no help when nobody is one.
 */
function whoCan(kind, value) {
  const { caps } = kindDef(kind);
  const c = caps.map(() => '?').join(',');
  const rows = all(`SELECT DISTINCT ro.name, COALESCE(NULLIF(ro.label, ''), ro.name) AS label
                      FROM roles ro JOIN role_capabilities rc ON rc.role = ro.name
                     WHERE COALESCE(ro.active, 1) = 1 AND rc.granted = 1 AND rc.capability IN (${c})
                       AND ro.name <> 'admin'
                       AND EXISTS (SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id AND u.active = 1
                                    WHERE ur.role_id = ro.id)
                     ORDER BY label`, ...caps);
  const ok = rows.filter((r) => { const row = limitRow(r.name, kind); return !row || row.max_amount + 0.005 >= value; });
  // People whose own limit covers it, and who give this approval.
  const people = all(`SELECT u.id, COALESCE(NULLIF(u.full_name, ''), u.username) AS name FROM user_approval_limits ul
                        JOIN users u ON u.id = ul.user_id AND u.active = 1
                       WHERE ul.kind = ? AND ul.max_amount + 0.005 >= ? ORDER BY name`, kind, value)
    .filter((p) => gives({ id: p.id, roles: require('./auth').rolesForUser(p.id) }, kind));
  return ok.map((r) => r.label).concat(people.map((p) => p.name)).concat('Admin');
}

/**
 * Does this person's limit cover this amount? Returns { ok, kind, value, limit, who_can }.
 * who_can is filled only when the answer is no.
 */
function check(user, kind, value) {
  const limit = limitFor(user, kind);
  const v = round2(value);
  const ok = limit == null || v <= limit + 0.005;
  return { ok, kind, value: v, limit, who_can: ok ? [] : whoCan(kind, v) };
}

/** The words for a refusal. `what` is e.g. "This MRN is worth about" / "This job costs". */
function refusalText(result, what) {
  const verb = result.kind === 'job_close' ? 'close it' : 'approve it';
  return `${what} ${rs(result.value)}. Your limit is ${rs(result.limit)}. `
    + `Someone with a higher limit must ${verb}: ${result.who_can.join(', ')}.`;
}

/** A 403 body for a refused approval: the words plus the numbers, for the screens. */
function refusal(result, what) {
  return { error: refusalText(result, what), over_limit: true, kind: result.kind,
    value: result.value, limit: result.limit, who_can: result.who_can };
}

// ---- what an approval is worth -------------------------------------------------------------

/**
 * An MRN's estimated value. For each line, the first price found of:
 *   1. what was paid for this very line (a receipt already priced),
 *   2. the newest priced receipt of the same store item,
 *   3. the newest priced receipt whose description is the store item's name (imported receipts
 *      carry no store_item_id — the same fallback the item search uses),
 *   4. the store item's maintained cost,
 *   5. the oil book price, when the line names a lubricant,
 *   6. the newest priced receipt with the same description as the line.
 * A line with none of these has no known price: it adds nothing and is counted in `unpriced`.
 */
function mrnValue(mrnId) {
  const lines = all(
    `SELECT ml.id, ml.description, ml.qty,
            COALESCE(
              (SELECT g.unit_price FROM grn g WHERE g.mrn_line_id = ml.id AND g.unit_price > 0 ORDER BY g.id DESC LIMIT 1),
              (SELECT g.unit_price FROM grn g WHERE ml.store_item_id IS NOT NULL AND g.store_item_id = ml.store_item_id
                  AND g.unit_price > 0 ORDER BY g.id DESC LIMIT 1),
              (SELECT g.unit_price FROM grn g JOIN store_items s ON s.id = ml.store_item_id
                WHERE g.unit_price > 0 AND LOWER(TRIM(g.description)) = LOWER(TRIM(s.name)) ORDER BY g.id DESC LIMIT 1),
              (SELECT NULLIF(s.unit_cost, 0) FROM store_items s WHERE s.id = ml.store_item_id),
              (SELECT p.unit_price FROM products p WHERE p.unit_price > 0
                  AND LOWER(TRIM(p.name)) = LOWER(TRIM(ml.description)) LIMIT 1),
              (SELECT g.unit_price FROM grn g WHERE g.unit_price > 0
                  AND LOWER(TRIM(g.description)) = LOWER(TRIM(ml.description)) ORDER BY g.id DESC LIMIT 1)
            ) AS unit_price
       FROM mrn_lines ml WHERE ml.mrn_id = ? ORDER BY ml.id`, mrnId);
  let value = 0;
  let unpriced = 0;
  for (const l of lines) {
    if (l.unit_price == null) { unpriced++; l.amount = null; continue; }
    l.amount = round2((Number(l.qty) || 0) * l.unit_price);
    value += l.amount;
  }
  return { value: round2(value), unpriced, lines };
}

/** A job's total cost — the same figure the job card and the cost report show. */
function jobValue(jobId) {
  return require('./costing').reconciledCost(jobId).total_cost;
}

// ---- the settings screen -------------------------------------------------------------------

/** Everything the Approval limits screen needs. */
function listForScreen() {
  const roles = all(`SELECT name, COALESCE(NULLIF(label, ''), name) AS label, COALESCE(active, 1) AS active
                       FROM roles WHERE name <> 'admin' ORDER BY COALESCE(active, 1) DESC, label`);
  const limits = {};
  for (const r of all('SELECT role, kind, max_amount, updated_at FROM approval_limits')) {
    (limits[r.role] = limits[r.role] || {})[r.kind] = r.max_amount;
  }
  const out = [];
  for (const r of roles) {
    const gives = {};
    for (const k of KIND_KEYS) gives[k] = rolesGiving([r.name], k).length > 0;
    // A role that gives none of these approvals has nothing to limit — unless an old limit is
    // still stored for it, which must stay visible so it can be cleared.
    if (KIND_KEYS.some((k) => gives[k] || (limits[r.name] && limits[r.name][k] != null))) {
      out.push({ name: r.name, label: r.label, active: !!r.active, gives, limits: limits[r.name] || {} });
    }
  }
  return {
    kinds: KIND_KEYS.map((k) => ({ key: k, label: KINDS[k].label, measure: KINDS[k].measure })),
    roles: out,
  };
}

/**
 * Set or clear one limit. `amount` null or '' clears it (no limit).
 * Rules for someone who is not an admin, in the spirit of "only give what you hold":
 *   - they set limits only for approvals they give themselves;
 *   - they cannot change the limit of a role they hold themselves (no raising your own limit);
 *   - they cannot set a limit above their own for that kind, nor remove one while they have one.
 */
function setLimit(actor, role, kind, amount) {
  kindDef(kind);
  const r = get('SELECT id, name FROM roles WHERE name = ?', String(role || ''));
  if (!r) fail(404, `No role called "${role}"`);
  if (r.name === 'admin') fail(400, 'Admin never has a limit.');
  const clear = amount === null || amount === undefined || String(amount).trim() === '';
  let value = null;
  if (!clear) {
    value = Number(String(amount).replace(/,/g, ''));
    if (!Number.isFinite(value) || value < 0) fail(400, 'The limit must be an amount of 0 or more — or empty for no limit.');
    value = round2(value);
  }
  if (!isAdminRoles(actor && actor.roles)) {
    if (!rolesGiving(actor.roles || [], kind).length) fail(403, 'You can only set limits for approvals you give yourself. Ask an admin.');
    if ((actor.roles || []).includes(r.name)) fail(403, 'You cannot change the limit of your own role. Ask an admin.');
    const mine = limitFor(actor, kind);
    if (mine != null && (clear || value > mine)) {
      fail(403, `You can only set limits up to your own (${rs(mine)}). Ask an admin.`);
    }
  }
  const before = limitRow(r.name, kind);
  if (clear) run('DELETE FROM approval_limits WHERE role = ? AND kind = ?', r.name, kind);
  else {
    run(`INSERT INTO approval_limits (role, kind, max_amount, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(role, kind) DO UPDATE SET max_amount = excluded.max_amount, updated_by = excluded.updated_by,
                                               updated_at = excluded.updated_at`,
      r.name, kind, value, actor ? actor.id : null);
  }
  require('./audit').record({
    userId: actor ? actor.id : null, entity: 'approval_limit', entityId: r.id, action: clear ? 'clear' : 'set',
    before: { role: r.name, kind, max_amount: before ? before.max_amount : null },
    after: { role: r.name, kind, max_amount: value },
  });
  return { role: r.name, kind, max_amount: value };
}

// ---- a person's own limit (access plan, Part 3) ---------------------------------------------

/**
 * Set or clear one person's own limit. `amount` null or '' clears it (back to their roles' limit).
 * The route checks first that the actor may change this person at all (not their own, not an admin,
 * within their access), and records the change once it is saved. Someone who is not an admin also
 * sets limits only for approvals they give, and never above their own. Returns { before, after }.
 */
function setPersonalLimit(actor, userId, kind, amount) {
  kindDef(kind);
  const clear = amount === null || amount === undefined || String(amount).trim() === '';
  let value = null;
  if (!clear) {
    value = Number(String(amount).replace(/,/g, ''));
    if (!Number.isFinite(value) || value < 0) fail(400, 'The limit must be an amount of 0 or more — or empty for the role\'s limit.');
    value = round2(value);
  }
  if (!isAdminRoles(actor && actor.roles)) {
    if (!gives(actor, kind)) fail(403, 'You can only set limits for approvals you give yourself. Ask an admin.');
    const mine = limitFor(actor, kind);
    if (mine != null && !clear && value > mine + 0.005) fail(403, `You can only set limits up to your own (${rs(mine)}). Ask an admin.`);
  }
  const before = ownRow(userId, kind);
  if (clear) run('DELETE FROM user_approval_limits WHERE user_id = ? AND kind = ?', userId, kind);
  else {
    run(`INSERT INTO user_approval_limits (user_id, kind, max_amount, set_by, set_at) VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, kind) DO UPDATE SET max_amount = excluded.max_amount, set_by = excluded.set_by, set_at = excluded.set_at`,
    userId, kind, value, actor ? actor.id : null);
  }
  return { before: { kind, max_amount: before ? before.max_amount : null }, after: { kind, max_amount: value } };
}

/**
 * "Only what you hold", for money: for each kind of approval where the actor has a limit, the person
 * — if they give that approval — must have a limit no higher. Returns the first kind where they do
 * not, as { kind, label, mine, theirs, text } (theirs null = no limit), or null.
 */
function outsideLimits(actor, target) {
  if (isAdminRoles(actor && actor.roles)) return null;
  for (const kind of KIND_KEYS) {
    const mine = limitFor(actor, kind);
    if (mine == null || !gives(target, kind)) continue;
    const theirs = limitFor(target, kind);
    if (theirs == null || theirs > mine + 0.005) {
      return { kind, label: KINDS[kind].label, mine, theirs,
        text: `${theirs == null ? 'no limit' : rs(theirs)} to "${KINDS[kind].label}", above your ${rs(mine)}` };
    }
  }
  return null;
}

module.exports = {
  KINDS, KIND_KEYS, limitFor, roleLimitFor, whoCan, check, refusal, refusalText, mrnValue, jobValue,
  listForScreen, setLimit, rs, personalFor, gives, setPersonalLimit, outsideLimits,
};
