'use strict';

/**
 * ===========================================================================
 * Step 7: Automated Reorder Point (ROP) & Inter-Workshop Stock Rebalancing
 *
 * 1. Demand & Consumption Analytics:
 *    - Tracks actual issues (stock_moves WHERE kind = 'out') across a rolling window
 *    - Computes Average Daily Demand (ADD) and Monthly Demand
 *
 * 2. Dynamic Safety Stock & Reorder Point:
 *    - Safety Stock: SS = max(1, ceil(ADD * Safety_Days))
 *    - Reorder Point: ROP = ceil((ADD * Lead_Time_Days) + SS)
 *    - Recommended Order/Transfer Qty: ROQ = max(ceil(ADD * 30), ceil(SS * 2), 1)
 *
 * 3. Multi-Site Stock Health & Rebalancing Engine:
 *    - Deficit: Balance <= ROP (STOCKOUT, CRITICAL, LOW)
 *    - Surplus: Balance > ROP + SS (excess available for donation)
 *    - Intelligent matching between deficit and surplus workshops
 *    - Transfer Qty: min(Shortfall, Surplus) — donor never drops below safe buffer!
 *
 * 4. 1-Click Material Transfer Note (MTN) Generation:
 *    - Automatically scaffolds draft MTN with universal chain tracking (CHN-YYYY-XXXXX)
 *    - Seamlessly moves stock between workshops without procurement delay
 * ===========================================================================
 */

const { get, all, run, tx } = require('../db');
const audit = require('./audit');
const emitter = require('./emitter');
const chainPipeline = require('./chain_pipeline');
const stock = require('./stock');
const stores = require('./stores');

/**
 * Historical demand consumption curve and metrics for a specific item.
 * @param {string} section - 'general' | 'oil' | 'filter' | 'battery'
 * @param {string} itemKey - Unique item identifier
 * @param {number|null} storeId - Optional store filter (null = all stores)
 * @param {object} opts - { days: 90 }
 */
function getItemDemandHistory(section, itemKey, storeId = null, opts = {}) {
  const days = Math.max(7, Number(opts.days) || 90);
  const stFilter = storeId ? ' AND store_id = ?' : '';
  const params = storeId ? [section, itemKey, storeId, days] : [section, itemKey, days];

  const summary = get(`
    SELECT
      ROUND(COALESCE(SUM(qty), 0), 2) AS total_issued,
      COUNT(*) AS issue_count,
      MIN(txn_date) AS first_issue_date,
      MAX(txn_date) AS last_issue_date
    FROM stock_moves
    WHERE section = ? AND item_key = ? AND kind = 'out'
      ${stFilter}
      AND date(txn_date) >= date('now', 'localtime', '-' || ? || ' day')
  `, ...params) || { total_issued: 0, issue_count: 0 };

  const dailyHistory = all(`
    SELECT
      date(txn_date) AS txn_date,
      ROUND(SUM(qty), 2) AS qty,
      COUNT(*) AS moves_count
    FROM stock_moves
    WHERE section = ? AND item_key = ? AND kind = 'out'
      ${stFilter}
      AND date(txn_date) >= date('now', 'localtime', '-' || ? || ' day')
    GROUP BY date(txn_date)
    ORDER BY date(txn_date) ASC
  `, ...params);

  const totalIssued = Number(summary.total_issued) || 0;
  const avgDailyDemand = days > 0 ? Math.round((totalIssued / days) * 1000) / 1000 : 0;
  const monthlyDemand = Math.round(avgDailyDemand * 30 * 100) / 100;

  return {
    section,
    item_key: itemKey,
    store_id: storeId,
    days_analyzed: days,
    total_issued: totalIssued,
    issue_count: summary.issue_count || 0,
    first_issue_date: summary.first_issue_date || null,
    last_issue_date: summary.last_issue_date || null,
    avg_daily_demand: avgDailyDemand,
    monthly_demand: monthlyDemand,
    daily_history: dailyHistory
  };
}

/**
 * Calculates dynamic ROP, Safety Stock, ROQ, and stock health status for a single SKU.
 */
function calculateItemRop(section, itemKey, storeId, opts = {}) {
  const existing = get(`
    SELECT * FROM store_reorder
    WHERE store_id = ? AND section = ? AND item_key = ?
  `, storeId, section, itemKey);

  const leadTimeDays = Math.max(1, Number(opts.leadTimeDays || (existing && existing.lead_time_days) || 7));
  const safetyDays = Math.max(1, Number(opts.safetyDays || 7));
  const demandDays = Math.max(14, Number(opts.demandDays || 90));

  const demand = getItemDemandHistory(section, itemKey, storeId, { days: demandDays });
  const add = demand.avg_daily_demand;

  // Calculate dynamic Safety Stock
  let safetyStock;
  if (add > 0) {
    safetyStock = Math.max(1, Math.ceil(add * safetyDays));
  } else if (existing && existing.safety_stock > 0) {
    safetyStock = Number(existing.safety_stock);
  } else {
    safetyStock = 0;
  }

  // Calculate dynamic Reorder Point (ROP)
  let rop;
  if (add > 0) {
    rop = Math.ceil((add * leadTimeDays) + safetyStock);
  } else if (existing && existing.level > 0) {
    rop = Number(existing.level);
  } else {
    rop = 0;
  }

  // Calculate Recommended Order / Rebalance Qty (ROQ)
  let roq;
  if (add > 0) {
    roq = Math.max(Math.ceil(add * 30), Math.ceil(safetyStock * 2), 1);
  } else if (safetyStock > 0) {
    roq = Math.max(Math.ceil(safetyStock * 2), 1);
  } else {
    roq = Math.max(rop, 1);
  }

  // Get current on-hand balance at this store
  const balRow = get(`
    SELECT ROUND(COALESCE(SUM(CASE
      WHEN counts = 0 THEN 0
      WHEN kind IN ('in', 'opening', 'adjust') THEN qty
      ELSE -qty
    END), 0), 2) AS balance
    FROM stock_moves
    WHERE section = ? AND item_key = ? AND store_id = ?
  `, section, itemKey, storeId);
  const balance = balRow ? Number(balRow.balance) : 0;

  // Determine stock health status
  let status;
  if (balance <= 0) {
    status = 'STOCKOUT';
  } else if (safetyStock > 0 && balance <= safetyStock) {
    status = 'CRITICAL';
  } else if (rop > 0 && balance <= rop) {
    status = 'LOW';
  } else if (rop > 0 && balance > (rop + safetyStock)) {
    status = 'SURPLUS';
  } else {
    status = 'HEALTHY';
  }

  // Calculate Shortfall (for restocking/transfer into store)
  const shortfall = (balance <= rop && rop > 0)
    ? Math.max(1, Math.ceil(rop - balance))
    : 0;

  // Calculate Available Surplus (safe quantity to transfer OUT to another store)
  let availableSurplus = 0;
  if (rop > 0 && balance > (rop + safetyStock)) {
    availableSurplus = Math.max(0, Math.floor(balance - (rop + safetyStock)));
  } else if (rop === 0 && balance > 5) {
    // If no ROP is configured yet but large buffer exists
    availableSurplus = Math.max(0, Math.floor(balance - 2));
  }

  // Unit and Item Name
  const itemName = stores.itemName(section, itemKey);
  const ci = get('SELECT unit FROM stock_items WHERE section = ? AND item_key = ?', section, itemKey);
  const unit = (ci && ci.unit) || (section === 'oil' ? 'L' : 'nos');

  return {
    store_id: storeId,
    section,
    item_key: itemKey,
    item_name: itemName,
    unit,
    balance,
    avg_daily_demand: add,
    monthly_demand: demand.monthly_demand,
    lead_time_days: leadTimeDays,
    safety_days: safetyDays,
    safety_stock: safetyStock,
    rop,
    roq,
    current_level: existing ? Number(existing.level) : 0,
    status,
    shortfall,
    available_surplus: availableSurplus,
    auto_calc: existing ? Boolean(existing.auto_calc) : true,
    last_calculated_at: existing ? existing.last_calculated_at : null,
    demand_summary: {
      total_issued: demand.total_issued,
      issue_count: demand.issue_count,
      days_analyzed: demand.days_analyzed
    }
  };
}

/**
 * Calculates ROP and health metrics across all items for a store.
 */
function calculateStoreRop(storeId, opts = {}) {
  const s = stores.byId(storeId);
  const storeName = s ? s.name : `Store #${storeId}`;

  const itemsMap = new Map();

  // 1. Gather all items that have had movements in this store or have a configured reorder level
  const smItems = all(`
    SELECT DISTINCT section, item_key
    FROM stock_moves
    WHERE store_id = ?
  `, storeId);

  const srItems = all(`
    SELECT DISTINCT section, item_key
    FROM store_reorder
    WHERE store_id = ?
  `, storeId);

  for (const it of [...smItems, ...srItems]) {
    const key = `${it.section}:${it.item_key}`;
    if (!itemsMap.has(key)) {
      itemsMap.set(key, it);
    }
  }

  const results = [];
  const kpis = {
    total_items: 0,
    stockouts: 0,
    critical: 0,
    low: 0,
    surplus: 0,
    healthy: 0,
    total_shortfall: 0,
    total_surplus_available: 0
  };

  for (const it of itemsMap.values()) {
    const calc = calculateItemRop(it.section, it.item_key, storeId, opts);
    results.push(calc);

    kpis.total_items++;
    if (calc.status === 'STOCKOUT') kpis.stockouts++;
    else if (calc.status === 'CRITICAL') kpis.critical++;
    else if (calc.status === 'LOW') kpis.low++;
    else if (calc.status === 'SURPLUS') kpis.surplus++;
    else kpis.healthy++;

    if (calc.shortfall > 0) kpis.total_shortfall += calc.shortfall;
    if (calc.available_surplus > 0) kpis.total_surplus_available += calc.available_surplus;
  }

  // Sort: STOCKOUT & CRITICAL first, then LOW, then SURPLUS, then HEALTHY
  const statusWeight = { STOCKOUT: 1, CRITICAL: 2, LOW: 3, SURPLUS: 4, HEALTHY: 5 };
  results.sort((a, b) => (statusWeight[a.status] || 99) - (statusWeight[b.status] || 99));

  return {
    store_id: storeId,
    store_name: storeName,
    kpis,
    items: results
  };
}

/**
 * Discovers and pairs inter-workshop rebalance opportunities:
 * Matches deficit stores (balance <= ROP) with donating surplus stores (balance > ROP + SS).
 */
function findRebalanceOpportunities({ storeId = null, section = null, limit = 100 } = {}) {
  // Get all active stores
  const storeRows = all("SELECT id, code, name FROM workshops WHERE own_store = 1 AND active = 1 ORDER BY id");
  if (!storeRows || storeRows.length === 0) return [];

  // Map of store data
  const storeMap = new Map(storeRows.map((s) => [s.id, s]));

  // Cache calculated store items
  const storeCaches = new Map();
  for (const s of storeRows) {
    const calculated = calculateStoreRop(s.id);
    storeCaches.set(s.id, calculated.items);
  }

  const opportunities = [];

  // Loop through stores to find deficits
  for (const s of storeRows) {
    const targetStoreId = s.id;
    // If storeId is requested, filter target store (or allow matching where either donor or receiver matches)
    if (storeId && targetStoreId !== Number(storeId)) continue;

    const items = storeCaches.get(targetStoreId) || [];
    for (const item of items) {
      if (section && item.section !== section) continue;
      if (item.shortfall <= 0) continue; // Not in deficit

      // Item has a shortfall at targetStoreId! Search all OTHER stores for available surplus.
      let bestDonor = null;

      for (const donorStore of storeRows) {
        if (donorStore.id === targetStoreId) continue; // Don't transfer from self

        const donorItems = storeCaches.get(donorStore.id) || [];
        const donorItem = donorItems.find((di) => di.section === item.section && di.item_key === item.item_key);

        if (donorItem && donorItem.available_surplus > 0) {
          // Found a donor store with surplus!
          if (!bestDonor || donorItem.available_surplus > bestDonor.available_surplus) {
            bestDonor = {
              store_id: donorStore.id,
              store_name: donorStore.name,
              store_code: donorStore.code,
              ...donorItem
            };
          }
        }
      }

      if (bestDonor) {
        const transferQty = Math.min(item.shortfall, bestDonor.available_surplus);
        const urgency = (item.status === 'STOCKOUT' || item.status === 'CRITICAL') ? 'HIGH' : 'NORMAL';

        opportunities.push({
          id: `REC-${item.section.toUpperCase()}-${item.item_key}-${bestDonor.store_id}-${targetStoreId}`,
          section: item.section,
          item_key: item.item_key,
          item_name: item.item_name,
          unit: item.unit,
          from_store_id: bestDonor.store_id,
          from_store_code: bestDonor.store_code,
          from_store_name: bestDonor.store_name,
          from_balance: bestDonor.balance,
          from_rop: bestDonor.rop,
          from_safety_stock: bestDonor.safety_stock,
          from_available_surplus: bestDonor.available_surplus,
          to_store_id: targetStoreId,
          to_store_code: s.code,
          to_store_name: s.name,
          to_balance: item.balance,
          to_rop: item.rop,
          to_safety_stock: item.safety_stock,
          to_status: item.status,
          shortfall: item.shortfall,
          suggested_transfer_qty: transferQty,
          urgency,
          avg_daily_demand: item.avg_daily_demand
        });
      }
    }
  }

  // Sort: HIGH urgency first, then by suggested_transfer_qty descending
  opportunities.sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency === 'HIGH' ? -1 : 1;
    return b.suggested_transfer_qty - a.suggested_transfer_qty;
  });

  return opportunities.slice(0, Number(limit) || 100);
}

/**
 * 1-Click Atomic Material Transfer Note (MTN) Generator for inter-workshop rebalancing.
 */
function createRebalanceMtn({ fromStoreId, toStoreId, items, reason, user = null }) {
  const fromId = Number(fromStoreId);
  const toId = Number(toStoreId);

  if (!fromId || !toId || fromId === toId) {
    throw new Error('Valid, distinct source and destination stores are required.');
  }

  const fromWs = stores.byId(fromId);
  const toWs = stores.byId(toId);
  if (!fromWs || !toWs) {
    throw new Error('One or both specified workshop stores do not exist.');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one item must be selected for transfer.');
  }

  const now = new Date().toISOString();
  const prepName = user ? (user.fullName || user.username) : 'System Rebalance Engine';

  return tx(() => {
    // Determine next sequential MTN number (~58xxx)
    const lastMtn = get("SELECT mtn_no FROM mtn WHERE mtn_no GLOB '[0-9]*' ORDER BY CAST(mtn_no AS INTEGER) DESC LIMIT 1");
    const nextNo = lastMtn && Number(lastMtn.mtn_no) ? String(Number(lastMtn.mtn_no) + 1) : String(58000 + Math.floor(Math.random() * 900) + 100);

    // Universal chain number
    const chainNo = chainPipeline.nextChainNo();

    const mtnReason = reason || `Automated stock rebalance: transfer surplus parts from ${fromWs.name} to ${toWs.name}`;

    const info = run(`
      INSERT INTO mtn (
        mtn_no, chain_no, txn_date, from_location, to_location,
        reason, prepared_by, prepared_at, prepared_designation, status
      ) VALUES (
        ?, ?, date('now'), ?, ?,
        ?, ?, datetime('now'), 'Store In-Charge', 'draft'
      )
    `, nextNo, chainNo, fromWs.name, toWs.name, mtnReason, prepName);

    const mtnId = info.lastInsertRowid;

    let lineNo = 1;
    for (const it of items) {
      const q = Number(it.qty) || 0;
      if (q <= 0) continue;

      const desc = String(it.item_name || it.item_key || '').trim();
      const unit = it.unit || 'nos';
      const cat = it.section || it.category || null;

      // Lookup store_item_id if exists
      const si = get('SELECT id FROM store_items WHERE description = ? OR name = ? LIMIT 1', desc, desc);

      run(`
        INSERT INTO mtn_lines (
          mtn_id, line_no, store_item_id, description, qty, unit,
          category, from_store_id, to_store_id, from_location, to_location, reason
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
      `, mtnId, lineNo++, si ? si.id : null, desc, q, unit,
         cat, fromId, toId, fromWs.name, toWs.name, 'Stock Rebalance');
    }

    audit.record({
      userId: user ? user.id : null,
      entity: 'mtn',
      entityId: mtnId,
      action: 'rebalance_created',
      after: {
        mtn_no: nextNo,
        chain_no: chainNo,
        from_store: fromWs.name,
        to_store: toWs.name,
        lines_count: lineNo - 1
      }
    });

    emitter.emit('data_changed', { what: 'stores', mtn_id: mtnId });

    return {
      ok: true,
      mtn_id: mtnId,
      mtn_no: nextNo,
      chain_no: chainNo,
      from_store: fromWs.name,
      to_store: toWs.name,
      items_count: lineNo - 1
    };
  });
}

/**
 * Bulk or single application of calculated ROP thresholds to store_reorder table.
 */
function applyRopLevels(storeId, items, user = null) {
  const sId = Number(storeId);
  const s = stores.byId(sId);
  if (!s) throw new Error(`Store #${storeId} not found.`);

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No items provided for ROP application.');
  }

  const userId = user ? user.id : null;

  return tx(() => {
    let updated = 0;
    for (const it of items) {
      const sec = String(it.section || '').trim().toLowerCase();
      const key = String(it.item_key || '').trim();
      const level = Math.max(0, Number(it.rop !== undefined ? it.rop : it.level) || 0);
      const ss = Math.max(0, Number(it.safety_stock) || 0);
      const roq = Math.max(0, Number(it.roq !== undefined ? it.roq : it.reorder_qty) || 0);
      const add = Math.max(0, Number(it.avg_daily_demand) || 0);
      const lt = Math.max(1, Number(it.lead_time_days) || 7);
      const autoCalc = it.auto_calc !== undefined ? (it.auto_calc ? 1 : 0) : 1;

      if (!sec || !key) continue;

      run(`
        INSERT INTO store_reorder (
          store_id, section, item_key, level, safety_stock, reorder_qty,
          avg_daily_demand, lead_time_days, auto_calc, last_calculated_at, set_by, set_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, datetime('now'), ?, datetime('now')
        )
        ON CONFLICT(store_id, section, item_key) DO UPDATE SET
          level = excluded.level,
          safety_stock = excluded.safety_stock,
          reorder_qty = excluded.reorder_qty,
          avg_daily_demand = excluded.avg_daily_demand,
          lead_time_days = excluded.lead_time_days,
          auto_calc = excluded.auto_calc,
          last_calculated_at = excluded.last_calculated_at,
          set_by = excluded.set_by,
          set_at = datetime('now')
      `, sId, sec, key, level, ss, roq, add, lt, autoCalc, userId);

      updated++;
    }

    audit.record({
      userId,
      entity: 'store_reorder',
      entityId: sId,
      action: 'apply_rop_levels',
      after: { store_id: sId, applied_count: updated }
    });

    emitter.emit('data_changed', { what: 'stores', store_id: sId });

    return {
      ok: true,
      store_id: sId,
      applied_count: updated
    };
  });
}

module.exports = {
  getItemDemandHistory,
  calculateItemRop,
  calculateStoreRop,
  findRebalanceOpportunities,
  createRebalanceMtn,
  applyRopLevels
};
