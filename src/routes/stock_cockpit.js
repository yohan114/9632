'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const emitter = require('../lib/emitter');

const router = express.Router();

function currentOilBalance(productId) {
  const r = get('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', productId);
  return r ? (Number(r.balance_after) || 0) : 0;
}

// ---- Overview & KPI Metrics ----------------------------------------------
router.get('/overview', requireAuth, asyncHandler((_req, res) => {
  // 1. General Stock Valuation & Metrics
  const genRow = get(`SELECT
      COUNT(*) AS total_items,
      ROUND(COALESCE(SUM(balance * COALESCE(unit_cost, 0)), 0), 2) AS total_val,
      COALESCE(SUM(CASE WHEN balance <= 0 THEN 1 ELSE 0 END), 0) AS zero_stock,
      COALESCE(SUM(CASE WHEN balance > 0 AND balance <= COALESCE(min_stock, 0) THEN 1 ELSE 0 END), 0) AS low_stock
    FROM store_items WHERE is_general = 1`);
  const genVal = genRow ? Number(genRow.total_val || 0) : 0;

  // 2. Filter Stock Valuation & Metrics
  const filRow = get(`SELECT
      COUNT(*) AS total_items,
      ROUND(COALESCE(SUM(qty_in_stock * COALESCE(unit_cost, 0)), 0), 2) AS total_val,
      COALESCE(SUM(CASE WHEN qty_in_stock <= 0 THEN 1 ELSE 0 END), 0) AS zero_stock,
      COALESCE(SUM(CASE WHEN qty_in_stock > 0 AND qty_in_stock <= COALESCE(reorder_level, 0) THEN 1 ELSE 0 END), 0) AS low_stock
    FROM filter_stock`);
  const filVal = filRow ? Number(filRow.total_val || 0) : 0;

  // 3. Oil & Lubricants Valuation & Metrics
  const oilProducts = all(`SELECT p.id, p.code, p.name, p.unit, p.reorder_level, p.unit_price FROM products p`);
  let oilVal = 0;
  let oilZeroStock = 0;
  let oilLowStock = 0;
  const oilProductsWithBal = oilProducts.map((p) => {
    const bal = currentOilBalance(p.id);
    const reorder = Number(p.reorder_level || 0);
    const price = Number(p.unit_price || 0);
    if (bal > 0) oilVal += bal * price;
    if (bal <= 0) oilZeroStock++;
    else if (reorder > 0 && bal <= reorder) oilLowStock++;
    return { ...p, balance: bal, reorder_level: reorder, unit_price: price };
  });
  oilVal = Math.round(oilVal * 100) / 100;

  // 4. Batteries In Store
  const batInStore = get("SELECT COUNT(*) AS count FROM batteries WHERE state = 'in_store'");
  const inStoreBatteries = batInStore ? batInStore.count : 0;

  // Consolidated Valuation
  const totalValuation = Math.round((genVal + filVal + oilVal) * 100) / 100;

  // 5. Build Reorder Alerts
  const alerts = [];

  // Oil Alerts
  for (const p of oilProductsWithBal) {
    if (p.reorder_level > 0 && p.balance <= p.reorder_level) {
      const shortfall = Math.max(1, Math.round((p.reorder_level - p.balance) * 100) / 100);
      alerts.push({
        section: 'oil',
        section_label: 'Lubricants & Oil',
        item_id: p.id,
        name: p.name,
        code: p.code || '—',
        category: 'Lubricants & Fluids',
        unit: p.unit || 'L',
        current_stock: p.balance,
        reorder_level: p.reorder_level,
        shortfall,
        unit_cost: p.unit_price,
        estimated_cost: Math.round(shortfall * p.unit_price * 100) / 100,
        urgency: p.balance <= 0 ? 'CRITICAL' : 'LOW',
      });
    }
  }

  // Filter Alerts
  const lowFilters = all(`SELECT id, filter_type, brand, part_no, unit, qty_in_stock, reorder_level, unit_cost
    FROM filter_stock
    WHERE reorder_level > 0 AND qty_in_stock <= reorder_level`);
  for (const f of lowFilters) {
    const bal = Number(f.qty_in_stock || 0);
    const reorder = Number(f.reorder_level || 0);
    const cost = Number(f.unit_cost || 0);
    const shortfall = Math.max(1, Math.round((reorder - bal) * 100) / 100);
    alerts.push({
      section: 'filter',
      section_label: 'Filters',
      item_id: f.id,
      name: `${f.filter_type || 'Filter'} (${f.part_no || f.brand || 'Unspecified'})`,
      code: f.part_no || '—',
      category: 'Filters',
      unit: f.unit || 'nos',
      current_stock: bal,
      reorder_level: reorder,
      shortfall,
      unit_cost: cost,
      estimated_cost: Math.round(shortfall * cost * 100) / 100,
      urgency: bal <= 0 ? 'CRITICAL' : 'LOW',
    });
  }

  // General Stock Alerts
  const lowGen = all(`SELECT id, item_no, name, category, unit, balance, min_stock, unit_cost
    FROM store_items
    WHERE is_general = 1 AND min_stock > 0 AND balance <= min_stock`);
  for (const g of lowGen) {
    const bal = Number(g.balance || 0);
    const min = Number(g.min_stock || 0);
    const cost = Number(g.unit_cost || 0);
    const shortfall = Math.max(1, Math.round((min - bal) * 100) / 100);
    alerts.push({
      section: 'general',
      section_label: 'General Items',
      item_id: g.id,
      name: g.name,
      code: g.item_no || '—',
      category: g.category || 'General Items',
      unit: g.unit || 'nos',
      current_stock: bal,
      reorder_level: min,
      shortfall,
      unit_cost: cost,
      estimated_cost: Math.round(shortfall * cost * 100) / 100,
      urgency: bal <= 0 ? 'CRITICAL' : 'LOW',
    });
  }

  // Sort alerts: CRITICAL first, then by estimated restock cost DESC
  alerts.sort((a, b) => {
    if (a.urgency === 'CRITICAL' && b.urgency !== 'CRITICAL') return -1;
    if (b.urgency === 'CRITICAL' && a.urgency !== 'CRITICAL') return 1;
    return b.estimated_cost - a.estimated_cost;
  });

  const criticalCount = alerts.filter((a) => a.urgency === 'CRITICAL').length;
  const lowCount = alerts.filter((a) => a.urgency === 'LOW').length;
  const totalEstCost = alerts.reduce((s, a) => s + (a.estimated_cost || 0), 0);

  res.json({
    total_valuation: totalValuation,
    valuation_breakdown: {
      general: genVal,
      oil: oilVal,
      filters: filVal,
    },
    sku_counts: {
      total: (genRow ? genRow.total_items : 0) + (filRow ? filRow.total_items : 0) + oilProducts.length,
      general: genRow ? genRow.total_items : 0,
      oil: oilProducts.length,
      filters: filRow ? filRow.total_items : 0,
      in_store_batteries: inStoreBatteries,
    },
    reorder_summary: {
      total_alerts: alerts.length,
      critical_count: criticalCount,
      low_count: lowCount,
      total_estimated_cost: Math.round(totalEstCost * 100) / 100,
    },
    reorder_alerts: alerts.slice(0, 150),
  });
}));

// ---- Universal Real-Time Inventory Search --------------------------------
router.get('/search', requireAuth, asyncHandler((req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const sectionFilter = String(req.query.section || 'all').toLowerCase();
  const statusFilter = String(req.query.status || 'all').toLowerCase();
  const limit = Math.min(500, toInt(req.query.limit, 250));

  const results = [];

  // 1. General Items
  if (sectionFilter === 'all' || sectionFilter === 'general') {
    const genRows = all(`SELECT id, item_no, name, category, unit, balance, min_stock, COALESCE(unit_cost, 0) AS unit_cost, rack
      FROM store_items WHERE is_general = 1`);
    for (const g of genRows) {
      const bal = Number(g.balance || 0);
      const min = Number(g.min_stock || 0);
      const cost = Number(g.unit_cost || 0);
      const status = bal <= 0 ? 'critical' : (min > 0 && bal <= min ? 'low' : 'ok');
      results.push({
        id: `gen-${g.id}`,
        raw_id: g.id,
        section: 'general',
        section_label: 'General Items',
        code: g.item_no || '—',
        name: g.name || 'Unnamed item',
        brand: null,
        category: g.category || 'General Items',
        unit: g.unit || 'nos',
        balance: bal,
        reorder_level: min,
        unit_cost: cost,
        total_value: Math.round(bal * cost * 100) / 100,
        location: g.rack || null,
        status,
      });
    }
  }

  // 2. Oil Products
  if (sectionFilter === 'all' || sectionFilter === 'oil') {
    const oilRows = all(`SELECT id, code, name, unit, category, reorder_level, unit_price FROM products`);
    for (const p of oilRows) {
      const bal = currentOilBalance(p.id);
      const reorder = Number(p.reorder_level || 0);
      const cost = Number(p.unit_price || 0);
      const status = bal <= 0 ? 'critical' : (reorder > 0 && bal <= reorder ? 'low' : 'ok');
      results.push({
        id: `oil-${p.id}`,
        raw_id: p.id,
        section: 'oil',
        section_label: 'Lubricants & Oil',
        code: p.code || '—',
        name: p.name || 'Unnamed lubricant',
        brand: null,
        category: p.category || 'Lubricants & Fluids',
        unit: p.unit || 'L',
        balance: bal,
        reorder_level: reorder,
        unit_cost: cost,
        total_value: Math.round(Math.max(0, bal) * cost * 100) / 100,
        location: 'Oil Store',
        status,
      });
    }
  }

  // 3. Filter Stock
  if (sectionFilter === 'all' || sectionFilter === 'filter') {
    const filRows = all(`SELECT id, filter_type, brand, part_no, unit, qty_in_stock, reorder_level, COALESCE(unit_cost, 0) AS unit_cost
      FROM filter_stock`);
    for (const f of filRows) {
      const bal = Number(f.qty_in_stock || 0);
      const reorder = Number(f.reorder_level || 0);
      const cost = Number(f.unit_cost || 0);
      const status = bal <= 0 ? 'critical' : (reorder > 0 && bal <= reorder ? 'low' : 'ok');
      results.push({
        id: `fil-${f.id}`,
        raw_id: f.id,
        section: 'filter',
        section_label: 'Filters',
        code: f.part_no || '—',
        name: `${f.filter_type || 'Filter'} (${f.part_no || 'No part no'})`,
        brand: f.brand || null,
        category: 'Filters',
        unit: f.unit || 'nos',
        balance: bal,
        reorder_level: reorder,
        unit_cost: cost,
        total_value: Math.round(Math.max(0, bal) * cost * 100) / 100,
        location: 'Filter Bay',
        status,
      });
    }
  }

  // 4. Batteries
  if (sectionFilter === 'all' || sectionFilter === 'battery') {
    const batRows = all(`SELECT b.id, b.serial_no, b.brand, b.capacity_ah, b.condition, b.state,
      a.code AS asset_code FROM batteries b LEFT JOIN assets a ON a.id = b.current_asset_id`);
    for (const b of batRows) {
      const status = b.state === 'in_store' ? 'ok' : 'low';
      results.push({
        id: `bat-${b.id}`,
        raw_id: b.id,
        section: 'battery',
        section_label: 'Batteries',
        code: b.serial_no || '—',
        name: `Battery ${b.brand || ''} ${b.capacity_ah ? b.capacity_ah + 'Ah' : ''} (${b.condition || 'new'})`.trim(),
        brand: b.brand || null,
        category: 'Batteries',
        unit: 'nos',
        balance: b.state === 'in_store' ? 1 : 0,
        reorder_level: 0,
        unit_cost: 0,
        total_value: 0,
        location: b.state === 'in_store' ? 'Battery Room' : (b.asset_code ? `On ${b.asset_code}` : b.state),
        status,
      });
    }
  }

  // Filter by search string
  let filtered = results;
  if (q) {
    filtered = filtered.filter((it) => {
      const target = `${it.code} ${it.name} ${it.brand || ''} ${it.category} ${it.location || ''}`.toLowerCase();
      return target.includes(q);
    });
  }

  // Filter by status
  if (statusFilter !== 'all') {
    filtered = filtered.filter((it) => it.status === statusFilter);
  }

  // Sort: Critical first, then Low, then total_value DESC, then name
  filtered.sort((a, b) => {
    const order = { critical: 1, low: 2, ok: 3 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    if (b.total_value !== a.total_value) return b.total_value - a.total_value;
    return a.name.localeCompare(b.name);
  });

  res.json(filtered.slice(0, limit));
}));

// ---- 1-Click Auto-Draft Restock MRN ---------------------------------------
router.post('/create-reorder-mrn', requireCap('stores.reorder_mrn'), asyncHandler((req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'At least one item must be selected to generate a restock MRN' });

  const mrnId = tx(() => {
    // Generate next MRN number
    const r = get(`SELECT MAX(CAST(mrn_no AS INTEGER)) m FROM mrn WHERE mrn_no GLOB '[0-9]*'`);
    const mrnNo = String((r && r.m ? r.m : 167442) + 1);

    const u = get('SELECT full_name, username, signature FROM users WHERE id = ?', req.user.id);
    const reqBy = (u ? (u.full_name || u.username) : 'Storekeeper');
    const today = new Date().toISOString().slice(0, 10);
    const purpose = b.purpose ? String(b.purpose).trim() : `Restock: Central Stock Cockpit (${items.length} items)`;

    // Create header
    const info = run(
      `INSERT INTO mrn (mrn_no, req_date, request_type, purpose, requested_by, requested_sig)
       VALUES (?, ?, 'general', ?, ?, ?)`,
      mrnNo, today, purpose, reqBy, u ? u.signature : null
    );
    const newMrnId = info.lastInsertRowid;

    // Insert lines
    for (const it of items) {
      const desc = String(it.name || '').trim();
      const qty = Math.max(1, toNum(it.qty, 1));
      const unit = String(it.unit || 'nos').trim();
      const cat = String(it.category || 'General Items').trim();
      const source = it.purchase_source || 'Head Office';

      // Ensure item exists in store_items for general inventory linkage
      let storeItemId = toInt(it.store_item_id);
      if (!storeItemId && it.section === 'general' && toInt(it.item_id)) {
        storeItemId = toInt(it.item_id);
      }
      if (!storeItemId) {
        const existing = get('SELECT id FROM store_items WHERE name = ? LIMIT 1', desc);
        if (existing) {
          storeItemId = existing.id;
        } else {
          const catRow = get('SELECT id FROM item_categories WHERE name = ? LIMIT 1', cat);
          const si = run(
            `INSERT INTO store_items (name, category, category_id, unit, min_stock, is_general, balance)
             VALUES (?, ?, ?, ?, ?, 1, 0)`,
            desc, cat, catRow ? catRow.id : null, unit, toNum(it.reorder_level, 0)
          );
          storeItemId = si.lastInsertRowid;
        }
      }

      run(
        `INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, category, purchase_source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newMrnId, storeItemId, desc, qty, unit, cat, source
      );
    }

    audit.record({
      userId: req.user.id,
      entity: 'mrn',
      entityId: newMrnId,
      action: 'create',
      after: { mrn_no: mrnNo, purpose, lines_count: items.length, source: 'stock_cockpit' },
    });

    return newMrnId;
  });

  const mrn = get('SELECT id, mrn_no FROM mrn WHERE id = ?', mrnId);
  emitter.emit('data_changed', { entity: 'mrn', action: 'create', id: mrnId });

  res.status(201).json({
    success: true,
    mrn_id: mrn.id,
    mrn_no: mrn.mrn_no,
    lines_count: items.length,
  });
}));

module.exports = router;
