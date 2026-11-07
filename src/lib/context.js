'use strict';

/**
 * ===========================================================================
 * Active Store & Site Location Context Engine (Unified Scoping)
 *
 * Implements:
 * 1. Role-based Context Determination:
 *    - Main Stores / Admin: Can operate as Central Main Stores (Global Overview)
 *      or switch active store context to any remote Site Store to inspect its
 *      inventory and site operations.
 *    - Sub Stores (Site Stores): Locked strictly to their assigned site store.
 *      Cannot switch context to view other stores' private inventories.
 * 2. Cascading Scoping:
 *    - Resolves activeStoreId, activeWorkshopId, activeProjectId from request headers:
 *      'X-Store-Location-Id', 'X-Workshop-Id', 'X-Project-Id' (or query params).
 * 3. Inter-Store MTN Boundary Enforcement:
 *    - Validates that sub-stores cannot directly query or alter other store stock;
 *      all inter-store transfers must proceed via Material Transfer Notes (MTN).
 * ===========================================================================
 */

const { get, all } = require('../db');
const storeLocations = require('./store_locations');
const workshops = require('./workshops');

/**
 * Check if a user has Main Store / Executive clearance to inspect all stores or switch context.
 * Strict authority: no username-based privileges, explicit capabilities or active assignments required.
 */
function isMainStoreUser(user) {
  if (!user || user.active === 0) return false;

  const roles = user.roles || [];
  const caps = user.caps || user.capabilities || [];

  if (roles.includes('admin') || caps.includes('workshops.all') || caps.includes('stores.all')) {
    return true;
  }

  try {
    const auth = require('./auth');
    if (auth.hasCap(user, 'workshops.all') || auth.hasCap(user, 'stores.all')) {
      return true;
    }
  } catch (_) {}

  // main_storekeeper role must hold an active assignment to a MAIN_STORE with can_view = 1
  if (roles.includes('main_storekeeper')) {
    try {
      const uStores = storeLocations.getUserStoreLocations(user.id) || [];
      const hasActiveMainStore = uStores.some((s) => s.store_type === 'MAIN_STORE' && s.can_view === 1 && (s.store_active === 1 || s.store_active == null));
      if (hasActiveMainStore) return true;
    } catch (_) {}
  }

  return false;
}

/**
 * Resolve the user's home / assigned site store location ID.
 * On missing, inactive, or unresolved assignments, denies scoped operations (throws 403).
 */
function getUserAssignedStoreId(user) {
  if (!user || user.active === 0) {
    const err = new Error('User inactive or unauthenticated — access denied');
    err.status = 403;
    throw err;
  }

  let uStores = [];
  try {
    uStores = storeLocations.getUserStoreLocations(user.id) || [];
  } catch (err) {
    console.error('Error resolving user store locations:', err);
    throw err;
  }

  // Filter to active store locations where user has active can_view clearance
  const activeStores = uStores.filter((s) => (s.store_active === 1 || s.store_active == null) && s.can_view === 1);
  if (activeStores && activeStores.length > 0) {
    const site = activeStores.find((s) => s.store_type === 'SITE_STORE') || activeStores[0];
    return site.store_location_id || site.id;
  }

  if (user.store_location_id) {
    try {
      const s = storeLocations.getStoreLocationById(Number(user.store_location_id));
      if (s && (s.active === 1 || s.active == null)) return s.id;
    } catch (_) {}
  }

  if (user.id) {
    try {
      const u = get('SELECT store_location_id, active FROM users WHERE id = ?', user.id);
      if (u && u.active === 0) {
        const err = new Error('User account is deactivated');
        err.status = 403;
        throw err;
      }
      if (u && u.store_location_id) {
        const s = storeLocations.getStoreLocationById(Number(u.store_location_id));
        if (s && (s.active === 1 || s.active == null)) return s.id;
      }
    } catch (err) {
      if (err.status === 403) throw err;
    }
  }

  const err = new Error('No store assigned — contact administrator');
  err.status = 403;
  throw err;
}

/**
 * Resolve active context from Express request (headers, query, user identity).
 */
function resolveRequestContext(req) {
  if (req.activeContext) return req.activeContext;

  const user = req.user;
  const isMainStore = isMainStoreUser(user);
  let activeStoreId = null;

  if (!isMainStore) {
    // Sub-store users are strictly locked to their assigned site store
    try {
      activeStoreId = getUserAssignedStoreId(user);
    } catch (_) {
      activeStoreId = null;
    }
  } else {
    // Main Store / Admin users: validate can_view grant for non-admins and audit context switches
    const rawHeader = req.headers && (req.headers['x-store-location-id'] || (req.query && req.query.store_location_id));
    let requestedStoreId = rawHeader && Number(rawHeader) ? Number(rawHeader) : null;

    const isAdmin = (user && (user.roles || []).includes('admin'));
    if (requestedStoreId && !isAdmin && user) {
      let canView = false;
      try {
        const access = get('SELECT can_view FROM store_location_access WHERE user_id = ? AND store_location_id = ?', user.id, requestedStoreId);
        canView = access && access.can_view === 1;
      } catch (_) {}
      if (!canView) {
        requestedStoreId = null;
      }
    }

    const prevStoreId = (req.session && req.session.activeStoreId) != null ? req.session.activeStoreId : null;
    activeStoreId = requestedStoreId || prevStoreId || 1;

    if (req.session && prevStoreId != null && activeStoreId !== prevStoreId && user) {
      req.session.activeStoreId = activeStoreId;
      try {
        const audit = require('./audit');
        const ip = req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1';
        audit.record({
          userId: user.id,
          entity: 'store_context',
          entityId: activeStoreId,
          action: 'switch_context',
          before: { from_store_id: prevStoreId },
          after: { to_store_id: activeStoreId, ip }
        });
      } catch (_) {}
    } else if (req.session && req.session.activeStoreId == null) {
      req.session.activeStoreId = activeStoreId;
    }
  }

  // Load store location master record from storeLocations helper (core.db in multidb)
  let storeLoc = null;
  if (activeStoreId) {
    try {
      storeLoc = storeLocations.getStoreLocationById(activeStoreId);
    } catch (_) {}
  }

  if (!storeLoc && isMainStore) {
    try {
      const allStores = storeLocations.listStoreLocations() || [];
      storeLoc = allStores.find((s) => s.store_type === 'MAIN_STORE') || allStores[0];
    } catch (_) {}
    if (!storeLoc) {
      storeLoc = { id: 1, code: 'MAIN-STORES', name: 'Central Main Stores', store_type: 'MAIN_STORE', workshop_id: null, project_id: null };
    }
    activeStoreId = storeLoc.id;
  }

  const isAllSitesMode = isMainStore && storeLoc?.store_type === 'MAIN_STORE';
  const activeWorkshopId = storeLoc?.workshop_id || (user && user.workshop_id) || null;
  const activeProjectId = storeLoc?.project_id || null;

  const ctx = {
    isMainStoreUser: isMainStore,
    isAllSitesMode,
    activeStoreId: storeLoc ? storeLoc.id : null,
    activeStoreCode: storeLoc ? storeLoc.code : null,
    activeStoreName: storeLoc ? storeLoc.name : null,
    activeStoreType: storeLoc ? storeLoc.store_type : null,
    activeWorkshopId,
    activeProjectId,
    storeLocation: storeLoc
  };

  req.activeContext = ctx;
  return ctx;
}

/**
 * Express middleware to automatically resolve active context on every authenticated request.
 */
function activeContextMiddleware(req, res, next) {
  if (req.user) {
    try {
      const ctx = resolveRequestContext(req);
      req.user.activeContext = ctx;
      req.user.activeStoreId = ctx.activeStoreId;
      req.user.activeWorkshopId = ctx.activeWorkshopId;
      req.user.activeProjectId = ctx.activeProjectId;
      req.user.isAllSitesMode = ctx.isAllSitesMode;
    } catch (err) {
      if (err.status === 403) {
        return res.status(403).json({ error: err.message });
      }
      return next(err);
    }
  }
  next();
}

/**
 * SQL WHERE clause fragment for workshop-scoped tables (e.g. job_cards, service_jobs, daily_work).
 * Returns { sql: string, params: array }.
 */
function getWorkshopScopeSql(req, column = 'workshop_id') {
  const ctx = resolveRequestContext(req);
  if (ctx.isAllSitesMode) {
    // In All Sites / Central Main Stores mode, allow viewing across all workshops (unless specific workshop requested)
    const requestedWs = req.query && req.query.workshop_id ? Number(req.query.workshop_id) : null;
    if (requestedWs) {
      return { sql: `${column} = ?`, params: [requestedWs] };
    }
    return { sql: '', params: [] };
  }

  if (ctx.activeWorkshopId) {
    return { sql: `${column} = ?`, params: [ctx.activeWorkshopId] };
  }

  // Project-only store: isolated from workshop-scoped data
  return { sql: '0 = 1', params: [] };
}

/**
 * SQL WHERE clause fragment for project-scoped tables (e.g. assets, projects).
 * Returns { sql: string, params: array }.
 */
function getProjectScopeSql(req, column = 'project_id') {
  const ctx = resolveRequestContext(req);
  if (ctx.isAllSitesMode) {
    const requestedProj = req.query && req.query.project_id ? Number(req.query.project_id) : null;
    if (requestedProj) {
      return { sql: `${column} = ?`, params: [requestedProj] };
    }
    return { sql: '', params: [] };
  }

  if (ctx.activeProjectId) {
    return { sql: `${column} = ?`, params: [ctx.activeProjectId] };
  }

  return { sql: '', params: [] };
}

/**
 * SQL WHERE clause fragment for store-scoped inventory tables (e.g. store_items, grn, issues).
 * Returns { sql: string, params: array }.
 */
function getStoreScopeSql(req, column = 'physical_store_id') {
  const ctx = resolveRequestContext(req);
  if (ctx.isAllSitesMode) {
    // Main Stores: can inspect any store if query specifies, else defaults to store 1
    const requestedStore = req.query && (req.query.physical_store_id || req.query.store_id);
    if (requestedStore && Number(requestedStore)) {
      return { sql: `${column} = ?`, params: [Number(requestedStore)] };
    }
    return { sql: `${column} = ?`, params: [1] };
  }

  return { sql: `${column} = ?`, params: [ctx.activeStoreId] };
}

/**
 * Shared helper: storeScopeFor(user)
 *
 * Implements strict store-level tenancy & boundary checks (Plan Phase 3).
 *
 * Rules:
 * - Admin or users holding 'stores.all' / 'workshops.all' clearance have global access (all stores).
 * - Central Main Stores personnel cover central operations.
 * - Site Store users see, request, receive, count, and issue strictly for their assigned store location(s).
 * - Multi-store assignments: users with multiple rows in `store_location_access` are authorized across all their assigned stores.
 * - Out-of-scope requests reject with 403 status and a clear tenancy violation message.
 */
function storeScopeFor(user) {
  if (!user) {
    const err = new Error('Authentication required');
    err.status = 401;
    throw err;
  }

  const isGlobal = isMainStoreUser(user);

  if (isGlobal) {
    return {
      isGlobal: true,
      storeIds: null, // null denotes unconstrained / global
      primaryStoreId: user.store_location_id ? Number(user.store_location_id) : 1,
      canAccess: (_storeId, _action) => true,
      assertAccess: (_storeId, _action) => true
    };
  }

  const allowedStoreMap = new Map();

  // 1. Look up granular store assignments in store_location_access
  try {
    const rows = storeLocations.getUserStoreLocations(user.id) || [];
    for (const r of rows) {
      const sid = Number(r.store_location_id || r.id);
      if (sid) {
        allowedStoreMap.set(sid, r);
      }
    }
  } catch (_) {}

  // 2. Look up primary store_location_id from user object, user_store_locations, or workshop mapping
  let primaryId = user.store_location_id ? Number(user.store_location_id) : null;
  if (!primaryId && user.workshop_id) {
    try {
      const mapped = storeLocations.resolvePhysicalStore(user.workshop_id);
      if (mapped) primaryId = Number(mapped.id);
    } catch (_) {}
  }
  if (!primaryId && user.id) {
    try {
      const uRow = get('SELECT workshop_id FROM users WHERE id = ?', user.id);
      if (uRow && uRow.workshop_id) {
        const mapped = storeLocations.resolvePhysicalStore(uRow.workshop_id);
        if (mapped) primaryId = Number(mapped.id);
      }
    } catch (_) {}
  }

  if (primaryId && !allowedStoreMap.has(primaryId)) {
    allowedStoreMap.set(primaryId, {
      store_location_id: primaryId,
      can_view: 1,
      can_request: 1,
      can_issue: 1,
      can_receive: 1,
      can_dispatch: 1,
      can_count: 1
    });
  }

  const storeIds = Array.from(allowedStoreMap.keys());

  const canAccess = (targetStoreId, action = 'view') => {
    if (!targetStoreId) return true;
    const sid = Number(targetStoreId);
    if (!allowedStoreMap.has(sid)) return false;

    if (!action || action === 'view') return true;
    const perms = allowedStoreMap.get(sid);
    const actionKey = `can_${action}`;
    if (perms[actionKey] !== undefined) {
      return perms[actionKey] === 1;
    }
    return true;
  };

  const assertAccess = (targetStoreId, action = 'view') => {
    if (!targetStoreId) return true;
    const sid = Number(targetStoreId);
    if (!canAccess(sid, action)) {
      let storeDesc = `Store ID ${sid}`;
      try {
        const s = storeLocations.getStoreLocationById(sid);
        if (s) storeDesc = `'${s.name}' (${s.code})`;
      } catch (_) {}

      const err = new Error(
        `Tenancy / store boundary violation: You do not have authorization to ${action} in ${storeDesc}. Site store operations are strictly restricted to your assigned store location.`
      );
      err.status = 403;
      throw err;
    }
    return true;
  };

  return {
    isGlobal: false,
    storeIds,
    primaryStoreId: primaryId || (storeIds.length ? storeIds[0] : null),
    canAccess,
    assertAccess
  };
}

/**
 * Assert that the user is permitted to query or mutate a specific physical store's inventory.
 * Sub-stores are blocked from other stores; transfers must proceed via MTN.
 */
function assertStoreAccess(req, physicalStoreId, action = 'view') {
  const targetId = Number(physicalStoreId);
  if (!targetId) return true;
  if (!req || !req.user) return true;
  const scope = storeScopeFor(req.user);
  return scope.assertAccess(targetId, action);
}

module.exports = {
  isMainStoreUser,
  getUserAssignedStoreId,
  resolveRequestContext,
  activeContextMiddleware,
  getWorkshopScopeSql,
  getProjectScopeSql,
  getStoreScopeSql,
  storeScopeFor,
  assertStoreAccess
};
