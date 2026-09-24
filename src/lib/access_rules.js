'use strict';

// ===========================================================================
// The rules for changing who may do what.
//
// Being allowed onto the Access Control screen (access.manage) or the Users screen (users.manage)
// must not be a quiet route to everything else. Without these rules, whoever can edit roles can
// tick every box on their own role, and whoever can assign roles can hand themselves the admin
// role. So:
//
//   1. You can only give what you hold. A permission, a section clearance level, or a role whose
//      permissions you do not have yourself is refused — to anyone who is not an admin.
//   2. Admin is the admin's business. Only an admin may give the admin role, take it away, or
//      change an account that holds it (password, active, roles).
//   3. There is always an admin. The last active admin cannot be switched off or demoted — by
//      anyone, including themselves — because recovering from that needs shell access to the
//      server (scripts/admin.js).
//
// Admins pass rules 1 and 2 by definition; rule 3 applies to everybody.
// ===========================================================================

const { get, all } = require('../db');
const capabilities = require('./capabilities');
const permissions = require('./permissions');

const isAdmin = (user) => !!(user && Array.isArray(user.roles) && user.roles.includes('admin'));
const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };

function capsOf(user) {
  if (!user) return [];
  return Array.isArray(user.caps) ? user.caps : capabilities.capsForRoles(user.roles || []);
}

/** Rule 1, for permissions. */
function assertCanGrantCaps(actor, caps) {
  if (isAdmin(actor)) return;
  const mine = new Set(capsOf(actor));
  const missing = caps.filter((c) => !mine.has(c));
  if (missing.length) {
    fail(403, `You can only give permissions you hold yourself. Not yours: ${missing.map((c) => (capabilities.get(c) || { label: c }).label).join('; ')}`);
  }
}

/** Rule 1, for section clearance levels. */
function assertCanSetLevel(actor, moduleKey, level) {
  if (isAdmin(actor)) return;
  const mine = permissions.levelForRoles(actor.roles || [], moduleKey);
  if (permissions.rank(level) > permissions.rank(mine)) {
    fail(403, `You can only set ${moduleKey} as high as your own clearance (${mine}).`);
  }
}

/** Rule 1 + 2, for handing out roles: every role must be within what the actor holds. */
function assertCanAssignRoles(actor, roleNames) {
  if (isAdmin(actor)) return;
  if (roleNames.includes('admin')) fail(403, 'Only an admin can give the admin role.');
  for (const role of roleNames) {
    const theirs = capabilities.capsForRole(role);
    const mine = new Set(capsOf(actor));
    const missing = theirs.filter((c) => !mine.has(c));
    if (missing.length) fail(403, `You cannot give the role "${role}": it has permissions you do not hold (${missing.length}).`);
    for (const m of permissions.MODULE_KEYS) {
      const need = permissions.levelForRoles([role], m);
      const have = permissions.levelForRoles(actor.roles || [], m);
      if (permissions.rank(need) > permissions.rank(have)) {
        fail(403, `You cannot give the role "${role}": it has more ${m} clearance than you (${need}).`);
      }
    }
  }
}

/** Does this account hold the admin role (active or not)? */
function userIsAdmin(userId) {
  return !!get(`SELECT 1 x FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                 WHERE ur.user_id = ? AND r.name = 'admin'`, userId);
}

/**
 * Rules 1 + 2 for changing an ACCOUNT (its password, whether it is active, its roles).
 *
 * A non-admin may only manage someone whose access is entirely within their own. Otherwise
 * "reset password" is a way in: reset the password of someone with more permissions, sign in as
 * them, and every rule above has been stepped around. So an admin account is off limits, and so is
 * any account holding a role the actor could not have given.
 */
function assertCanManageUser(actor, targetUserId) {
  if (isAdmin(actor)) return;
  if (userIsAdmin(targetUserId)) fail(403, 'Only an admin can change an admin account.');
  const theirRoles = all(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                           WHERE ur.user_id = ?`, targetUserId).map((r) => r.name);
  try {
    assertCanAssignRoles(actor, theirRoles);
  } catch (e) {
    fail(403, 'You can only change accounts whose access is within your own. Ask an admin.');
  }
}

function activeAdminIds() {
  return all(`SELECT DISTINCT u.id FROM users u
                JOIN user_roles ur ON ur.user_id = u.id
                JOIN roles r ON r.id = ur.role_id
               WHERE r.name = 'admin' AND u.active = 1`).map((r) => r.id);
}

/**
 * Rule 3. `change` describes what is about to happen to one account: { userId, deactivate?,
 * newRoles? }. Refuses if it would leave no active admin.
 */
function assertKeepsAnAdmin({ userId, deactivate = false, newRoles = null }) {
  const admins = activeAdminIds();
  if (!admins.includes(userId)) return;
  const losesAdmin = deactivate || (Array.isArray(newRoles) && !newRoles.includes('admin'));
  if (losesAdmin && admins.length <= 1) {
    fail(409, 'This is the only active admin. Make another account an admin first — otherwise nobody could manage the system without logging in to the server.');
  }
}

module.exports = {
  isAdmin, assertCanGrantCaps, assertCanSetLevel, assertCanAssignRoles, assertCanManageUser,
  assertKeepsAnAdmin, activeAdminIds, userIsAdmin,
};
