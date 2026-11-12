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
 * Get stock summary across sections (and optional item list, in-transit MTNs, and recent moves) for a physical store location.
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
  const reqSec = String(req.query.section || '').trim();
  if (reqSec === 'all' || req.query.include_items === '1' || req.query.include_items === 'true') {
    items = [];
    for (const sec of stock.SECTIONS) {
      const secItems = stock.items(sec, req.query.q || null, 300, { physical_store_id: id });
      for (const it of secItems) items.push({ ...it, section: sec });
    }
  } else if (reqSec && stock.SECTIONS.includes(reqSec)) {
    items = stock.items(reqSec, req.query.q || null, 500, { physical_store_id: id }).map((it) => ({ ...it, section: reqSec }));
  }

  const in_transit = stock.inTransit(null, { location_id: id });

  // Recent movements at this store location
  const db = require('../db');
  let recent_moves = [];
  try {
    recent_moves = db.all(`
      SELECT sm.id, sm.section, sm.kind, sm.item_key, sm.item_name, sm.qty, sm.unit_price,
             sm.txn_date, sm.ref, sm.note, a.code AS asset_code, j.job_no
        FROM stock_moves sm
        LEFT JOIN assets a ON a.id = sm.asset_id
        LEFT JOIN job_cards j ON j.id = sm.job_id
       WHERE sm.physical_store_id = ?
       ORDER BY sm.txn_date DESC, sm.id DESC
       LIMIT 40
    `, id);
  } catch (_) {}

  res.json({
    store,
    summaries,
    items,
    in_transit,
    recent_moves,
  });
}));

/**
 * POST /:id/quick-adjust
 * Set or adjust physical count / opening balance and/or reorder level for an item in a physical store location.
 */
router.post('/:id/quick-adjust', requireCap('stores.stock.count', 'stores.locations.manage', 'stores.stock.levels', 'stores.items.txn'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const store = storeLocs.getStoreLocationById(id);
  if (!store) return res.status(404).json({ error: `Store location ID ${id} not found.` });

  const stock = require('../lib/stock');
  const db = require('../db');
  const audit = require('../lib/audit');
  const emitter = require('../lib/events');

  const section = String(req.body.section || 'general').trim();
  if (!stock.SECTIONS.includes(section)) {
    return res.status(400).json({ error: `Invalid section '${section}'.` });
  }
  const itemName = String(req.body.item_name || '').trim();
  const itemKey = String(req.body.item_key || '').trim() || stock.itemKey(section, itemName);
  if (!itemKey || itemKey === 'UNKNOWN') {
    return res.status(400).json({ error: 'Valid item_key or item_name is required.' });
  }

  const legacyStoreId = store.legacy_store_id || store.workshop_id || storeLocs.resolveLegacyStoreId(id) || 1;
  const today = new Date().toISOString().slice(0, 10);
  const note = String(req.body.note || 'Site store quick stock adjustment').trim();

  let countResult = null;
  let reorderResult = null;

  db.tx(() => {
    if (req.body.counted_qty !== undefined && req.body.counted_qty !== null && req.body.counted_qty !== '') {
      const countedQty = Number(req.body.counted_qty);
      if (!Number.isFinite(countedQty) || countedQty < 0) {
        throw new Error('Counted / opening balance quantity must be 0 or greater.');
      }
      const bookQty = stock.balanceOf(section, itemKey, null, { physical_store_id: id });
      const delta = Math.round((countedQty - bookQty) * 100) / 100;

      const info = db.run(`
        INSERT INTO store_counts (store_id, physical_store_id, section, item_key, item_name, count_date, book_qty, counted_qty, delta, note, counted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, legacyStoreId, id, section, itemKey, itemName || itemKey, today, bookQty, countedQty, delta, note, req.user ? req.user.id : null);

      stock.recordCount({
        id: info.lastInsertRowid,
        store_id: legacyStoreId,
        physical_store_id: id,
        section,
        item_key: itemKey,
        item_name: itemName || itemKey,
        count_date: today,
        book_qty: bookQty,
        counted_qty: countedQty,
        delta,
      });

      countResult = { book_qty: bookQty, counted_qty: countedQty, delta };
    }

    if (req.body.reorder_level !== undefined && req.body.reorder_level !== null && req.body.reorder_level !== '') {
      const level = Math.max(0, Number(req.body.reorder_level) || 0);
      const existing = db.get('SELECT id FROM store_reorder WHERE physical_store_id = ? AND section = ? AND item_key = ?', id, section, itemKey);
      if (existing) {
        db.run('UPDATE store_reorder SET level = ?, set_by = ?, set_at = datetime(\'now\') WHERE id = ?', level, req.user ? req.user.id : null, existing.id);
      } else {
        db.run(`
          INSERT INTO store_reorder (store_id, physical_store_id, section, item_key, level, set_by, set_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(store_id, section, item_key) DO UPDATE SET
            physical_store_id = excluded.physical_store_id,
            level = excluded.level,
            set_by = excluded.set_by,
            set_at = datetime('now')
        `, legacyStoreId, id, section, itemKey, level, req.user ? req.user.id : null);
      }
      reorderResult = { reorder_level: level };
    }
  });

  if (audit && req.user) {
    try {
      audit.record({
        userId: req.user.id,
        entity: 'store_location_stock',
        entityId: id,
        action: 'quick_adjust',
        after: { store_code: store.code, section, item_key: itemKey, item_name: itemName, countResult, reorderResult, note }
      });
    } catch (_) {}
  }

  emitter.emit('data_changed', { entity: 'stores', store_location_id: id });
  res.json({ ok: true, store_id: id, section, item_key: itemKey, count: countResult, reorder: reorderResult });
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

/**
 * DELETE /:id/access/:userId
 * Revoke user access grants for this store location.
 */
router.delete('/:id/access/:userId', requireCap('stores.locations.access'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const userId = toInt(req.params.userId);
  if (!userId) {
    return res.status(400).json({ error: 'userId is required.' });
  }

  try {
    const result = storeLocs.revokeUserStoreLocationAccess(userId, id, req.user);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/**
 * GET /user/:userId
 * List all store locations assigned to a user.
 */
router.get('/user/:userId', requireCap('stores.locations.access'), asyncHandler((req, res) => {
  const userId = toInt(req.params.userId);
  const access = storeLocs.getUserStoreLocations(userId);
  res.json(access);
}));

module.exports = router;
