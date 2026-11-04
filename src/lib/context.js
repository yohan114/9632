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
  if (user.username === 'mstore') return true;

  try {
    const auth = require('./auth');
    if (auth.hasCap(user, 'workshops.all') || auth.hasCap(user, 'stores.all')) {
      return true;
    }
  } catch (_) {}

  // Check if primary assigned store is MAIN_STORE
  try {
    const uStores = storeLocations.getUserStoreLocations(user.id);
    if (uStores && uStores.some((s) => s.store_type === 'MAIN_STORE')) {
      return true;
    }
  } catch (_) {}

  return false;
}

/**
 * Resolve the user's home / assigned site store location ID.
 */
function getUserAssignedStoreId(user) {
  if (!user) return 1;
  try {
    const uStores = storeLocations.getUserStoreLocations(user.id);
    if (uStores && uStores.length > 0) {
      // If user has a site store, return that
      const site = uStores.find((s) => s.store_type === 'SITE_STORE') || uStores[0];
      return site.store_location_id || site.id;
    }
  } catch (_) {}

  // Workshop fallback
  const homeWs = workshops.homeOf(user);
  if (homeWs) {
    try {
      const allStores = storeLocations.listStoreLocations() || [];
      const matched = allStores.find((s) => s.workshop_id === homeWs && s.active);
      if (matched) return matched.id;
    } catch (_) {}
  }

  return 1;
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
    // Main Store / Admin users: header or query parameter wins, fallback to 1 (Central Main Stores)
    const rawHeader = req.headers['x-store-location-id'] || (req.query && req.query.store_location_id);
    if (rawHeader && Number(rawHeader)) {
      activeStoreId = Number(rawHeader);
    } else {
      activeStoreId = 1;
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
function activeContextMiddleware(req, _res, next) {
  if (req.user) {
    const ctx = resolveRequestContext(req);
    req.user.activeContext = ctx;
    req.user.activeStoreId = ctx.activeStoreId;
    req.user.activeWorkshopId = ctx.activeWorkshopId;
    req.user.activeProjectId = ctx.activeProjectId;
    req.user.isAllSitesMode = ctx.isAllSitesMode;
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
 * Assert that the user is permitted to query or mutate a specific physical store's inventory.
 * Sub-stores are blocked from other stores; transfers must proceed via MTN.
 */
function assertStoreAccess(req, physicalStoreId) {
  const ctx = resolveRequestContext(req);
  const targetId = Number(physicalStoreId);
  if (!targetId) return true;

  if (ctx.isMainStoreUser) {
    return true; // Main Storekeeper & Admin can inspect any store
  }

  if (ctx.activeStoreId !== targetId) {
    const err = new Error(`Access Denied: Sub-stores are restricted to their local site store. Cross-store requisitions must use Material Transfer Notes (MTN).`);
    err.status = 403;
    throw err;
  }

  return true;
}

module.exports = {
  isMainStoreUser,
  getUserAssignedStoreId,
  resolveRequestContext,
  activeContextMiddleware,
  getWorkshopScopeSql,
  getProjectScopeSql,
  getStoreScopeSql,
  assertStoreAccess
};
