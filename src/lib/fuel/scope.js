'use strict';

/**
 * Fuel Site / Tank Tenancy & Unified Access Scope Engine
 *
 * Enforces:
 * 1. Strict site/tank isolation for site-scoped fuel users (Pump Operators, Site Fuel Requesters,
 *    Site Storekeepers, or any non-admin assigned to a project/tank without `fuel.all_sites`).
 * 2. Strict `hide_stock` balance masking across all tank/console/stats responses.
 * 3. Unified Section + Capability gating so `section = none` (at role OR personal override level)
 *    ALWAYS denies access even if a legacy role capability exists.
 */

const { get, all } = require('../../db');
const { hasCap } = require('../auth');
const permissions = require('../permissions');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isAdminUser(user) {
  return !!(user && Array.isArray(user.roles) && user.roles.includes('admin'));
}

/**
 * Resolve a user's authoritative fuel tenancy & workspace profile from DB + session.
 */
function getFuelScope(user) {
  if (!user) {
    return {
      isAdmin: false,
      isGlobal: false,
      scoped: true,
      unassigned: true,
      projectId: null,
      tankId: null,
      allowedTankIds: [],
      hideStock: true,
      fuelRole: null,
      isPumpOnly: false,
      isRequesterOnly: false,
    };
  }

  const admin = isAdminUser(user);
  const roles = user.roles || [];

  // Always read latest scope columns from DB if user.id exists so admin updates take effect immediately
  let dbRow = null;
  if (user.id) {
    try {
      dbRow = get('SELECT project_id, bulk_tank_id, hide_stock, fuel_role FROM users WHERE id = ?', user.id);
    } catch (_) {}
  }

  const projectId = dbRow && dbRow.project_id != null
    ? Number(dbRow.project_id)
    : (user.project_id != null ? Number(user.project_id) : null);
  const tankId = dbRow && dbRow.bulk_tank_id
    ? String(dbRow.bulk_tank_id)
    : (user.bulk_tank_id ? String(user.bulk_tank_id) : null);
  const fuelRole = (dbRow && dbRow.fuel_role) || user.fuel_role || null;
  const hideStock = !admin && Boolean((dbRow && dbRow.hide_stock) || user.hide_stock);

  if (admin) {
    return {
      isAdmin: true,
      isGlobal: true,
      scoped: false,
      unassigned: false,
      projectId,
      tankId,
      allowedTankIds: null, // null = all active tanks
      hideStock: false,
      fuelRole,
      isPumpOnly: false,
      isRequesterOnly: false,
    };
  }

  const hasAllSitesCap = hasCap(user, 'fuel.all_sites');
  const isStrictRole = roles.includes('pump_operator')
    || roles.includes('fuel_requester')
    || fuelRole === 'SITE_OPERATOR'
    || fuelRole === 'WORKSHOP_FUEL';

  // Non-admins are strictly scoped if they hold a site-scoped role/fuel_role,
  // OR if they have a project_id / bulk_tank_id assigned and do NOT hold `fuel.all_sites`.
  const scoped = isStrictRole || (!hasAllSitesCap && (projectId != null || tankId != null));

  let resolvedProjectId = projectId;
  let allowedTankIds = null;

  if (scoped) {
    const tankSet = new Set();
    if (tankId) {
      const t = get('SELECT id, project_id FROM fuel_tanks WHERE id = ? AND active = 1', tankId);
      if (t) {
        tankSet.add(String(t.id));
        if (resolvedProjectId == null && t.project_id != null) {
          resolvedProjectId = Number(t.project_id);
        }
      } else {
        // Keep assigned tankId even if inactive/not yet created so cross-tank checks still fail closed
        tankSet.add(String(tankId));
      }
    } else if (resolvedProjectId != null) {
      const projTanks = all('SELECT id FROM fuel_tanks WHERE project_id = ? AND active = 1', resolvedProjectId);
      for (const pt of projTanks) tankSet.add(String(pt.id));
    }
    allowedTankIds = Array.from(tankSet);
  }

  const unassigned = scoped && resolvedProjectId == null && (!allowedTankIds || allowedTankIds.length === 0);

  const canIssueOrRefill = hasCap(user, 'fuel.issue', 'fuel.tanks.refill');
  const canRequest = hasCap(user, 'fuel.transport.request', 'fuel.request');
  const hasAnalyticsOrAdmin = hasAllSitesCap
    || hasCap(user, 'fuel.reports.view', 'fuel.prices.view', 'fuel.alerts.view', 'fuel.approve_request', 'fuel.approve_site_request', 'fuel.approve_correction', 'fuel.tanks.manage');

  const isPumpOnly = (roles.includes('pump_operator') && !hasAllSitesCap)
    || fuelRole === 'SITE_OPERATOR'
    || (canIssueOrRefill && !canRequest && !hasAnalyticsOrAdmin);

  const isRequesterOnly = (roles.includes('fuel_requester') && !canIssueOrRefill && !hasAllSitesCap)
    || (canRequest && !canIssueOrRefill && !hasAnalyticsOrAdmin);

  return {
    isAdmin: false,
    isGlobal: !scoped,
    scoped,
    unassigned,
    projectId: resolvedProjectId,
    tankId: tankId || (allowedTankIds && allowedTankIds.length === 1 ? allowedTankIds[0] : null),
    allowedTankIds,
    hideStock,
    fuelRole,
    isPumpOnly,
    isRequesterOnly,
  };
}

/**
 * Mask current_litres on a tank object if hideStock applies to this user.
 */
function maskTankForUser(tank, scopeOrUser) {
  if (!tank) return null;
  const scope = scopeOrUser && typeof scopeOrUser.hideStock === 'boolean'
    ? scopeOrUser
    : getFuelScope(scopeOrUser);
  if (!scope.hideStock) return tank;
  return {
    ...tank,
    current_litres: null,
    hide_stock: true,
  };
}

/**
 * Ensure the specified tank is within the user's assigned scope.
 */
function assertTankInScope(user, targetTankId, actionLabel = 'access this fuel tank') {
  const scope = getFuelScope(user);
  if (!scope.scoped) return scope;
  if (scope.unassigned) {
    throw httpError(403, `No fuel site or tank assigned to your account. Contact an Administrator before attempting to ${actionLabel}.`);
  }
  if (!targetTankId) {
    throw httpError(403, `A valid assigned site tank is required to ${actionLabel}.`);
  }
  const tid = String(targetTankId);
  if (!scope.allowedTankIds || !scope.allowedTankIds.includes(tid)) {
    throw httpError(403, `Site/Tank isolation denied: your account is locked to your assigned fuel tank and cannot ${actionLabel} on another site's tank.`);
  }
  return scope;
}

/**
 * Ensure the specified project/site is within the user's assigned scope.
 */
function assertProjectInScope(user, targetProjectId, actionLabel = 'access this site') {
  const scope = getFuelScope(user);
  if (!scope.scoped) return scope;
  if (scope.unassigned) {
    throw httpError(403, `No fuel site assigned to your account. Contact an Administrator before attempting to ${actionLabel}.`);
  }
  if (targetProjectId != null && scope.projectId != null && Number(targetProjectId) !== Number(scope.projectId)) {
    throw httpError(403, `Site isolation denied: your account is restricted to your assigned site and cannot ${actionLabel} for another site.`);
  }
  return scope;
}

/**
 * Ensure a fuel_issues row belongs to the user's assigned tank/site.
 */
function assertIssueInScope(user, issue, actionLabel = 'access this fuel issue') {
  const scope = getFuelScope(user);
  if (!scope.scoped) return scope;
  if (scope.unassigned) {
    throw httpError(403, `No fuel site or tank assigned to your account. Contact an Administrator.`);
  }
  if (!issue) return scope;

  const issueTankId = issue.source_tank_id || issue.bulk_tank_id || null;
  const issueProjId = issue.target_project_id || issue.project_id || issue.source_project_id || null;

  // If user is locked to specific tank(s), check tank match first; fall back to project match only if issue has no tank
  if (scope.allowedTankIds && scope.allowedTankIds.length > 0) {
    if (issueTankId && scope.allowedTankIds.includes(String(issueTankId))) return scope;
    if (!issueTankId && scope.projectId != null && issueProjId != null && Number(issueProjId) === Number(scope.projectId)) {
      return scope;
    }
    throw httpError(403, `Site/Tank isolation denied: you cannot ${actionLabel} from another site or tank.`);
  }

  if (scope.projectId != null && issueProjId != null && Number(issueProjId) !== Number(scope.projectId)) {
    throw httpError(403, `Site isolation denied: you cannot ${actionLabel} from another site.`);
  }
  return scope;
}

/**
 * Ensure a fuel_requests row belongs to the user's assigned tank/site.
 */
function assertRequestInScope(user, fr, actionLabel = 'access this fuel request') {
  const scope = getFuelScope(user);
  if (!scope.scoped) return scope;
  if (scope.unassigned) {
    throw httpError(403, `No fuel site or tank assigned to your account. Contact an Administrator.`);
  }
  if (!fr) return scope;

  if (fr.target_tank_id && scope.allowedTankIds && scope.allowedTankIds.length > 0) {
    if (!scope.allowedTankIds.includes(String(fr.target_tank_id))) {
      throw httpError(403, `Site/Tank isolation denied: you cannot ${actionLabel} for another site's tank.`);
    }
    return scope;
  }

  if (fr.project_id != null && scope.projectId != null && Number(fr.project_id) !== Number(scope.projectId)) {
    throw httpError(403, `Site isolation denied: you cannot ${actionLabel} for another site.`);
  }
  return scope;
}

/**
 * Check whether a user's section clearance meets the required level for a fuel section/sub-part.
 *
 * Rules:
 *   1. Admin always passes.
 *   2. Expired temporary access fails (via permissions.effectiveLevel -> 'none').
 *   3. Explicit personal override on `section` (in user_permissions) ALWAYS takes precedence.
 *   4. For top-level 'fuel': effectiveLevel(user, 'fuel') must meet `level`.
 *      If a list of alternative sections is given (e.g. ['fuel', 'fuel_tanks']), passing ANY is sufficient
 *      UNLESS the primary requested section was explicitly overridden to 'none' for this user.
 *   5. For a sub-part (e.g. 'fuel_prices', 'fuel_reports', 'fuel_alerts', 'fuel_tanks', 'fuel_transport', 'fuel_readings'):
 *      - If user_permissions has an explicit row for that sub-part -> use it strictly.
 *      - Else if any of the user's roles has a row in role_permissions for that sub-part -> use highest level strictly.
 *      - Else (e.g., custom role created in tests with only `fuel = full` and no sub-part row) -> fall back to `effectiveLevel(user, 'fuel')`.
 */
function effectiveFuelSectionLevel(user, sectionKey) {
  if (!user) return 'none';
  if (isAdminUser(user)) return 'full';

  if (permissions.isAccessExpired(user)) {
    return permissions.effectiveLevel(user, sectionKey);
  }

  // 1. Personal override on this exact section wins unconditionally
  if (user.id) {
    const personal = get('SELECT level FROM user_permissions WHERE user_id = ? AND section = ?', user.id, sectionKey);
    if (personal && permissions.LEVELS.includes(personal.level)) {
      return personal.level;
    }
  }

  // 2. If this is the parent 'fuel' section, delegate straight to effectiveLevel
  if (sectionKey === 'fuel') {
    return permissions.effectiveLevel(user, 'fuel');
  }

  // 3. For a sub-part, check whether any assigned role explicitly defines a row for this sub-part
  const roles = user.roles || [];
  if (roles.length > 0) {
    const marks = roles.map(() => '?').join(',');
    const explicitRoleRows = all(
      `SELECT level FROM role_permissions WHERE module = ? AND role IN (${marks})`,
      sectionKey, ...roles
    );
    if (explicitRoleRows.length > 0) {
      let best = 'none';
      for (const r of explicitRoleRows) {
        if (permissions.rank(r.level) > permissions.rank(best)) best = r.level;
      }
      // If personal override turned parent 'fuel' explicitly to 'none' and fuel_* sub-part has no personal override,
      // deny access so revoking 'fuel' revokes its fuel_* children cleanly.
      if (user.id && sectionKey.startsWith('fuel_')) {
        const parentOverride = get("SELECT level FROM user_permissions WHERE user_id = ? AND section = 'fuel'", user.id);
        if (parentOverride && parentOverride.level === 'none') return 'none';
      }
      return best;
    }
  }

  // 4. Custom role without sub-part rows: fall back to parent 'fuel' level only for fuel_* sub-parts
  if (sectionKey.startsWith('fuel_')) {
    return permissions.effectiveLevel(user, 'fuel');
  }
  return permissions.effectiveLevel(user, sectionKey);
}

/**
 * Express middleware: enforces BOTH section clearance AND capability grant.
 *
 * @param {Object} opts
 * @param {string|string[]} opts.sections - Section key(s) (e.g. 'fuel', 'fuel_prices', ['fuel', 'fuel_tanks'])
 * @param {string} [opts.level] - Required clearance level ('view'|'add'|'edit'|'full'); defaults by HTTP method
 * @param {string[]} [opts.caps] - Required capability keys (user must hold at least one)
 */
function requireFuelAccess({ sections = 'fuel', level = null, caps = [] } = {}) {
  const secList = Array.isArray(sections) ? sections : [sections];
  const capList = Array.isArray(caps) ? caps : (caps ? [caps] : []);
  const capLib = require('../capabilities');
  const unknown = capList.filter((c) => !capLib.isCapability(c));
  if (unknown.length) throw new Error(`requireFuelAccess: unknown capability ${unknown.join(', ')}`);

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (isAdminUser(req.user)) return next();

    const need = level || permissions.needFor(req.method);
    const secOk = secList.some((sec) => permissions.meets(effectiveFuelSectionLevel(req.user, sec), need));
    if (!secOk) {
      return res.status(403).json({
        error: `Your account does not have ${need} access to ${secList.join(' / ')}`,
        needSection: secList,
        needLevel: need,
      });
    }

    if (capList.length > 0 && !hasCap(req.user, ...capList)) {
      const labels = capList.map((c) => capLib.get(c).label);
      return res.status(403).json({
        error: `Your role does not allow this: ${labels.join(' / ')}`,
        need: capList,
      });
    }

    return next();
  };
}

module.exports = {
  getFuelScope,
  maskTankForUser,
  assertTankInScope,
  assertProjectInScope,
  assertIssueInScope,
  assertRequestInScope,
  effectiveFuelSectionLevel,
  requireFuelAccess,
};
