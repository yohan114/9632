'use strict';

/**
 * ===========================================================================
 * Physical Store Locations REST Router (Plan Revision 2, Phase 1)
 *
 * Provides endpoints for:
 * - Listing and retrieving physical store locations.
 * - Retrieving store hierarchy tree (Main Stores -> Site Stores & Main Workshop Stores -> Site Workshop Stores).
 * - Creating, updating, and retiring physical store locations.
 * - Managing user-by-user store location access grants.
 * ===========================================================================
 */

const express = require('express');
const storeLocs = require('../lib/store_locations');
const { requireCap } = require('../lib/auth');
const { asyncHandler, toInt } = require('../lib/http');

const multidb = require('../db/multidb');

const router = express.Router();

/**
 * GET /
 * List physical store locations.
 */
router.get('/', requireCap('stores.locations.view'), asyncHandler((req, res) => {
  const activeOnly = req.query.active_only === 'true' || req.query.activeOnly === 'true';
  const type = req.query.type ? String(req.query.type).trim() : undefined;
  const parentStoreId = req.query.parent_store_id !== undefined ? toInt(req.query.parent_store_id) : undefined;
  const siteId = req.query.site_id ? toInt(req.query.site_id) : undefined;
  const workshopId = req.query.workshop_id ? toInt(req.query.workshop_id) : undefined;

  const stores = storeLocs.listStoreLocations({
    activeOnly,
    type,
    parentStoreId,
    siteId,
    workshopId
  });

  res.json(stores);
}));

/**
 * GET /tree
 * Get full visual store hierarchy tree.
 */
router.get('/tree', requireCap('stores.locations.view'), asyncHandler((req, res) => {
  const tree = storeLocs.getStoreHierarchyTree();
  res.json(tree);
}));

/**
 * GET /reconciliation
 * Shadow stock reconciliation report comparing legacy workshop balances and physical store balances.
 */
router.get('/reconciliation', requireCap('stores.locations.view'), asyncHandler((req, res) => {
  const stock = require('../lib/stock');
  const report = stock.reconcileLegacyAndPhysicalStores();
  res.json(report);
}));

/**
 * GET /in-transit
 * Goods currently in transit between physical store locations.
 */
router.get('/in-transit', requireCap('stores.locations.view'), asyncHandler((req, res) => {
  const stock = require('../lib/stock');
  const section = req.query.section ? String(req.query.section).trim() : null;
  const items = stock.inTransit(section);
  res.json(items);
}));

/**
 * GET /:id
 * Get single store location details.
 */
router.get('/:id', requireCap('stores.locations.view'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const store = storeLocs.getStoreLocationById(id);
  if (!store) {
    return res.status(404).json({ error: `Store location with ID ${id} not found.` });
  }
  res.json(store);
}));

/**
 * GET /:id/stock
 * Get stock summary across sections (and optional item list) for a physical store location.
 */
router.get('/:id/stock', requireCap('stores.locations.view'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const store = storeLocs.getStoreLocationById(id);
  if (!store) {
    return res.status(404).json({ error: `Store location with ID ${id} not found.` });
  }
  const stock = require('../lib/stock');
  const summaries = {};
  for (const sec of stock.SECTIONS) {
    summaries[sec] = stock.summary(sec, { physical_store_id: id });
  }

  let items = null;
  if (req.query.section && stock.SECTIONS.includes(req.query.section)) {
    items = stock.items(req.query.section, req.query.q || null, 500, { physical_store_id: id });
  }

  res.json({
    store,
    summaries,
    items,
  });
}));

/**
 * POST /
 * Create a new physical store location.
 */
router.post('/', requireCap('stores.locations.manage'), asyncHandler((req, res) => {
  try {
    const created = storeLocs.createStoreLocation(req.body, req.user);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/**
 * PUT /:id
 * Update an existing physical store location.
 */
router.put('/:id', requireCap('stores.locations.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  try {
    const updated = storeLocs.updateStoreLocation(id, req.body, req.user);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/**
 * PUT /:id/retire
 * Retire a physical store location.
 */
router.put('/:id/retire', requireCap('stores.locations.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  try {
    const retired = storeLocs.retireStoreLocation(id, req.user);
    res.json(retired);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/**
 * GET /:id/access
 * List user access grants for this store location.
 */
router.get('/:id/access', requireCap('stores.locations.access'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const access = storeLocs.getStoreLocationAccess(id);
  res.json(access);
}));

/**
 * POST /:id/access
 * Set or update user access grants for this store location.
 */
router.post('/:id/access', requireCap('stores.locations.access'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const userId = toInt(req.body.user_id || req.body.userId);
  if (!userId) {
    return res.status(400).json({ error: 'user_id is required.' });
  }

  try {
    const saved = storeLocs.setUserStoreLocationAccess(userId, id, req.body, req.user);
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

module.exports = router;
