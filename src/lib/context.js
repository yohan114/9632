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
 */
function isMainStoreUser(user) {
  if (!user) return false;
  if ((user.roles || []).includes('admin')) return true;
  if ((user.roles || []).includes('main_storekeeper')) return true;
  if (Array.isArray(user.caps) && (user.caps.includes('workshops.all') || user.caps.includes('stores.all'))) return true;
  if (Array.isArray(user.capabilities) && (user.capabilities.includes('workshops.all') || user.capabilities.includes('stores.all'))) return true;

  try {
    const auth = require('./auth');
    if (auth.hasCap(user, 'workshops.all') || auth.hasCap(user, 'stores.all')) {
      return true;
    }
  } catch (_) {}

  return false;
}

/**
 * Resolve the user's home / assigned site store location ID.
 */
function getUserAssignedStoreId(user) {
  if (!user) {
    const err = new Error('No store assigned — contact administrator');
    err.status = 403;
    throw err;
  }

  let uStores = null;
  try {
    uStores = storeLocations.getUserStoreLocations(user.id);
  } catch (err) {
    console.error('Error resolving user store locations:', err);
    throw err;
  }

  if (uStores && uStores.length > 0) {
    const site = uStores.find((s) => s.store_type === 'SITE_STORE') || uStores[0];
    return site.store_location_id || site.id;
  }

  if (user.store_location_id) {
    return Number(user.store_location_id);
  }

  // Workshop fallback only if user explicitly has a workshop_id assigned
  let userWs = user.workshop_id;
  if (!userWs && user.id) {
    try {
      const u = get('SELECT workshop_id, store_location_id FROM users WHERE id = ?', user.id);
      if (u && u.store_location_id) return Number(u.store_location_id);
      userWs = u ? u.workshop_id : null;
    } catch (err) {
      console.error('Error fetching user workshop_id:', err);
      throw err;
    }
  }

  if (userWs) {
    try {
      const allStores = storeLocations.listStoreLocations() || [];
      const matched = allStores.find((s) => s.workshop_id === userWs && s.active);
      if (matched) return matched.id;
    } catch (err) {
      console.error('Error matching workshop store location:', err);
      throw err;
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
    activeStoreId = getUserAssignedStoreId(user);
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
  try {
    storeLoc = storeLocations.getStoreLocationById(activeStoreId);
  } catch (_) {}

  if (!storeLoc) {
    try {
      const allStores = storeLocations.listStoreLocations() || [];
      storeLoc = allStores.find((s) => s.store_type === 'MAIN_STORE') || allStores[0];
    } catch (_) {}
    if (!storeLoc) {
      storeLoc = { id: 1, code: 'MAIN-STORES', name: 'Central Main Stores', store_type: 'MAIN_STORE', workshop_id: null, project_id: null };
    }
    activeStoreId = storeLoc.id;
  }

  const isAllSitesMode = isMainStore && storeLoc.store_type === 'MAIN_STORE';
  const activeWorkshopId = storeLoc.workshop_id || null;
  const activeProjectId = storeLoc.project_id || null;

  const ctx = {
    isMainStoreUser: isMainStore,
    isAllSitesMode,
    activeStoreId,
    activeStoreCode: storeLoc.code,
    activeStoreName: storeLoc.name,
    activeStoreType: storeLoc.store_type,
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

  // If site store is not a workshop store (e.g. project-only store), return 0 or empty depending on design
  return { sql: '', params: [] };
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

  // 2. Look up primary store_location_id from user object or users table
  let primaryId = user.store_location_id ? Number(user.store_location_id) : null;
  if (!primaryId && user.id) {
    try {
      const uRow = get('SELECT store_location_id, workshop_id FROM users WHERE id = ?', user.id);
      if (uRow && uRow.store_location_id) primaryId = Number(uRow.store_location_id);
      if (!primaryId && uRow && uRow.workshop_id) {
        const mapped = storeLocations.resolvePhysicalStore(uRow.workshop_id);
        if (mapped) primaryId = Number(mapped.id);
      }
    } catch (_) {}
  } else if (!primaryId && user.workshop_id) {
    try {
      const mapped = storeLocations.resolvePhysicalStore(user.workshop_id);
      if (mapped) primaryId = Number(mapped.id);
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
