'use strict';

/**
 * ===========================================================================
 * Step 7 & 8: Dynamic Reorder Point (ROP) & Inter-Store Stock Rebalancing
 *
 * 1. Physical Store Location & Topology Integration:
 *    - Operates across Central Main Stores (1), Central Main Workshop (2),
 *      and unified Site Stores (3+) via `store_locations`.
 *    - Seamless backward-compatibility with legacy workshop store IDs.
 *
 * 2. Demand & Consumption Analytics:
 *    - Tracks actual issues (`stock_moves WHERE kind = 'out'`) across a rolling window
 *    - Computes Average Daily Demand (ADD) and Monthly Demand per physical shelf
 *
 * 3. Dynamic Safety Stock & Reorder Point:
 *    - Safety Stock: SS = max(1, ceil(ADD * Safety_Days))
 *    - Reorder Point: ROP = ceil((ADD * Lead_Time_Days) + SS)
 *    - Recommended Order/Transfer Qty: ROQ = max(ceil(ADD * 30), ceil(SS * 2), 1)
 *
 * 4. Multi-Site Stock Health & Rebalancing Engine:
 *    - Deficit: Balance <= ROP (STOCKOUT, CRITICAL, LOW)
 *    - Surplus: Balance > ROP + SS (excess available for donation)
 *    - Intelligent matching prioritizing direct Site-to-Site transfers
 *    - Donor Protection: Transfer Qty = min(Shortfall, Surplus)
 *      Donor store balance NEVER drops below its own safe threshold (ROP + SS)!
 *
 * 5. 1-Click Material Transfer Note (MTN) Generation:
 *    - Scaffolds draft MTN with universal chain tracking (CHN-YYYY-XXXXX)
 *    - Links physical store locations (from_store_location_id, to_store_location_id)
 *    - On dispatch & destination acceptance, updates physical shelf balances.
 * ===========================================================================
 */

const { get, all, run, tx } = require('../db');
const audit = require('./audit');
const emitter = require('./emitter');
const chainPipeline = require('./chain_pipeline');
const stock = require('./stock');
const stores = require('./stores');
const storeLocations = require('./store_locations');
const storeLocs = storeLocations;
const multidb = require('../db/multidb');

function inWorkshop(wsId, fn) {
  if (multidb.isMultiDb() && wsId && wsId !== multidb.activeWorkshopId()) {
    return multidb.withWorkshop(wsId, fn);
  }
  return fn();
}

/**
 * Resolves a unified store context representing either a physical store location
 * (store_locations) or a legacy workshop store.
 * Returns { physical_store_id, store_id, name, code, store_type }.
 */
function resolveStoreContext(storeOrLocId, opts = {}) {
  let physId = opts.physical_store_id != null ? Number(opts.physical_store_id) : (opts.physicalStoreId != null ? Number(opts.physicalStoreId) : (opts.location_id != null ? Number(opts.location_id) : null));
  let legId = opts.store_id != null ? Number(opts.store_id) : (opts.storeId != null ? Number(opts.storeId) : (opts.store != null ? Number(opts.store) : null));

  if (typeof storeOrLocId === 'object' && storeOrLocId !== null) {
    if (storeOrLocId.physical_store_id != null) physId = Number(storeOrLocId.physical_store_id);
    else if (storeOrLocId.location_id != null) physId = Number(storeOrLocId.location_id);
    if (storeOrLocId.store_id != null) legId = Number(storeOrLocId.store_id);
    else if (storeOrLocId.id != null && !physId && !legId) {
      if (storeOrLocId.store_type !== undefined) physId = Number(storeOrLocId.id);
      else legId = Number(storeOrLocId.id);
    }
  } else if (storeOrLocId != null) {
    const num = Number(storeOrLocId);
    if (!isNaN(num) && num > 0) {
      if (opts.isPhysicalStore) {
        physId = num;
      } else {
        // Check if a workshop exists with this ID (legacy store_id prioritization)
        let ws = null;
        try { ws = get('SELECT id, name, code FROM workshops WHERE id = ?', num); } catch {}
        if (ws) {
          legId = ws.id;
          let mapped = null;
          try { mapped = get('SELECT store_location_id FROM store_location_mappings WHERE legacy_store_id = ? LIMIT 1', legId); } catch {}
          if (mapped) {
            physId = mapped.store_location_id;
          } else {
            let byWs = null;
            try { byWs = get('SELECT id FROM store_locations WHERE workshop_id = ? AND active = 1 ORDER BY is_default DESC, id ASC LIMIT 1', legId); } catch {}
            if (byWs) physId = byWs.id;
          }
        } else {
          // If no workshop, check store_locations
          let loc = null;
          try { loc = get('SELECT id, name, code, store_type, workshop_id FROM store_locations WHERE id = ?', num); } catch {}
          if (loc) {
            physId = loc.id;
            let mapped = null;
            try { mapped = get('SELECT legacy_store_id FROM store_location_mappings WHERE store_location_id = ? LIMIT 1', loc.id); } catch {}
            legId = mapped ? mapped.legacy_store_id : (loc.workshop_id || 1);
          } else {
            legId = num;
          }
        }
      }
    }
  }

  // Look up metadata via store_locations (queried from coreDb)
  let locRow = null;
  if (physId) {
    try { locRow = storeLocs.getStoreLocationById(physId); } catch {}
  }
  if (physId && !legId) {
    try {
      legId = storeLocs.resolveLegacyStoreId(physId);
      if (!legId && locRow && locRow.workshop_id) {
        legId = locRow.workshop_id;
      } else if (!legId) {
        legId = physId;
      }
    } catch {}
  }
  if (legId && !physId) {
    try {
      physId = storeLocs.resolvePhysicalStore(legId);
      if (physId && !locRow) {
        locRow = storeLocs.getStoreLocationById(physId);
      }
    } catch {}
  }
  let wsRow = null;
  if (legId) {
    try { wsRow = stores.byId(legId); } catch {}
  }

  const isExplicitPhysical = opts.isPhysicalStore || (opts.physical_store_id != null) || (typeof storeOrLocId === 'object' && storeOrLocId && storeOrLocId.physical_store_id != null);
  const name = (!isExplicitPhysical && wsRow ? wsRow.name : null) || (locRow && locRow.name) || (wsRow && wsRow.name) || `Store #${physId || legId || 1}`;
  const code = (!isExplicitPhysical && wsRow ? wsRow.code : null) || (locRow && locRow.code) || (wsRow && wsRow.code) || `STORE-${physId || legId || 1}`;
  const storeType = (locRow && locRow.store_type) || null;

  return {
    physical_store_id: physId || (locRow ? locRow.id : null),
    store_id: legId || (wsRow ? wsRow.id : 1),
    name,
    code,
    store_type: storeType
  };
}

/**
 * Retrieves all active physical store locations across the organization.
 * Seamlessly integrates physical store locations and unmapped active workshops.
 */
function getAllActiveStores() {
  const storesList = [];
  const coveredWs = new Set();

  try {
    const locRows = storeLocs.listStoreLocations({ activeOnly: true });

    for (const s of locRows) {
      const legId = s.legacy_store_id || s.workshop_id || null;
      if (legId) coveredWs.add(legId);

      storesList.push({
        key: 'p:' + s.id,
        id: s.id,
        physical_store_id: s.id,
        store_id: legId || 1,
        code: s.code,
        name: s.name,
        store_type: s.store_type
      });
    }
  } catch {}

  // Include any active workshops that do not yet have a physical store_location record
  try {
    const wsRows = stores.allStores ? stores.allStores() : all("SELECT id, code, name FROM workshops WHERE own_store = 1 AND active = 1 ORDER BY id");
    for (const w of wsRows) {
      if (!coveredWs.has(w.id)) {
        storesList.push({
          key: 'w:' + w.id,
          id: w.id,
          physical_store_id: null,
          store_id: w.id,
          code: w.code,
          name: w.name,
          store_type: 'SITE_STORE'
        });
      }
    }
  } catch {}

  return storesList;
}

/**
 * Historical demand consumption curve and metrics for a specific item.
 * Supports filtering by physical store location or legacy store ID.
 * @param {string} section - 'general' | 'oil' | 'filter' | 'battery'
 * @param {string} itemKey - Unique item identifier
 * @param {number|object|null} storeOrLocId - Physical store location ID or workshop ID (null = all)
 * @param {object} opts - { days: 90 }
 */
function getItemDemandHistory(section, itemKey, storeOrLocId = null, opts = {}) {
  const storeCtx = storeOrLocId ? resolveStoreContext(storeOrLocId, opts) : null;
  const targetWsId = storeCtx ? storeCtx.store_id : null;
  const physId = storeCtx ? storeCtx.physical_store_id : null;

  return inWorkshop(targetWsId, () => {
    const days = Math.max(7, Number(opts.days) || 90);
    let stFilter = '';
    const params = [section, itemKey];

    if (physId != null) {
      stFilter = ' AND (physical_store_id = ? OR (physical_store_id IS NULL AND store_id = ?))';
      params.push(physId, targetWsId || 1);
    } else if (targetWsId != null) {
      stFilter = ' AND store_id = ?';
      params.push(targetWsId);
    }

    params.push(days);

    const summary = get(`
      SELECT
        ROUND(COALESCE(SUM(qty), 0), 2) AS total_issued,
        COUNT(*) AS issue_count,
        MIN(txn_date) AS first_issue_date,
        MAX(txn_date) AS last_issue_date
      FROM stock_moves
      WHERE section = ? AND item_key = ? AND kind = 'out'
        AND (source_table IS NULL OR source_table <> 'mtn_lines')
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
        AND (source_table IS NULL OR source_table <> 'mtn_lines')
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
      store_id: targetWsId,
      physical_store_id: physId,
      store_name: storeCtx ? storeCtx.name : null,
      store_code: storeCtx ? storeCtx.code : null,
      days_analyzed: days,
      total_issued: totalIssued,
      issue_count: summary.issue_count || 0,
      first_issue_date: summary.first_issue_date || null,
      last_issue_date: summary.last_issue_date || null,
      avg_daily_demand: avgDailyDemand,
      monthly_demand: monthlyDemand,
      daily_history: dailyHistory
    };
  });
}

/**
 * Calculates dynamic ROP, Safety Stock, ROQ, and stock health status for a single SKU.
 * Operates on physical store location if available, otherwise on legacy store.
 */
function calculateItemRop(section, itemKey, storeOrLocId, opts = {}) {
  const ctx = resolveStoreContext(storeOrLocId, opts);
  const physId = ctx.physical_store_id;
  const storeId = ctx.store_id;

  return inWorkshop(storeId, () => {
    let existing = null;
    if (physId != null) {
      existing = get(`
        SELECT * FROM store_reorder
        WHERE (physical_store_id = ? OR (physical_store_id IS NULL AND store_id = ?))
          AND section = ? AND item_key = ?
        ORDER BY CASE WHEN physical_store_id = ? THEN 1 ELSE 2 END ASC
        LIMIT 1
      `, physId, storeId, section, itemKey, physId);
    } else {
      existing = get(`
        SELECT * FROM store_reorder
        WHERE store_id = ? AND section = ? AND item_key = ?
      `, storeId, section, itemKey);
    }

    const leadTimeDays = Math.max(1, Number(opts.leadTimeDays || (existing && existing.lead_time_days) || 7));
    const safetyDays = Math.max(1, Number(opts.safetyDays || 7));
    const demandDays = Math.max(14, Number(opts.demandDays || 90));

    const demand = getItemDemandHistory(section, itemKey, ctx, { days: demandDays });
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
    let balance = 0;
    if (physId != null) {
      balance = Number(stock.balanceOf(section, itemKey, null, { physical_store_id: physId })) || 0;
      if (balance === 0) {
        const hasPhysMoves = get('SELECT 1 FROM stock_moves WHERE physical_store_id = ? LIMIT 1', physId);
        if (!hasPhysMoves) {
          balance = Number(stock.balanceOf(section, itemKey, storeId)) || 0;
        }
      }
    } else {
      balance = Number(stock.balanceOf(section, itemKey, storeId)) || 0;
    }

    // Determine stock health status
    let status;
    if (balance <= 0) {
      status = 'STOCKOUT';
    } else if (safetyStock > 0 && balance <= safetyStock) {
      status = 'CRITICAL';
    } else if (rop > 0 && balance < rop) {
      status = 'LOW';
    } else if (rop > 0 && balance > (rop + safetyStock)) {
      status = 'SURPLUS';
    } else {
      status = 'HEALTHY';
    }

    // Calculate Shortfall (for restocking/transfer into store)
    const shortfall = (balance < rop && rop > 0)
      ? Math.max(1, Math.ceil(rop - balance))
      : 0;

    // Calculate Available Surplus (safe quantity to transfer OUT to another store)
    // Donor store balance must NEVER drop below its own safe threshold (ROP + SS)!
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
      physical_store_id: physId,
      store_name: ctx.name,
      store_code: ctx.code,
      store_type: ctx.store_type,
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
  });
}

/**
 * Calculates ROP and health metrics across all items for a physical store or workshop store.
 */
function calculateStoreRop(storeOrLocId, opts = {}) {
  const ctx = resolveStoreContext(storeOrLocId, opts);
  const physId = ctx.physical_store_id;
  const storeId = ctx.store_id;

  return inWorkshop(storeId, () => {
    const itemsMap = new Map();

    // Gather all items that have had movements in this store or have a configured reorder level
    let smItems = [];
    let srItems = [];

    if (physId != null) {
      const pId = Number(physId);
      const sId = storeId != null ? Number(storeId) : null;
      smItems = all(`
        SELECT DISTINCT section, item_key
        FROM stock_moves
        WHERE physical_store_id = ? OR (physical_store_id IS NULL AND store_id = ?)
      `, pId, sId);

      srItems = all(`
        SELECT DISTINCT section, item_key
        FROM store_reorder
        WHERE physical_store_id = ? OR (physical_store_id IS NULL AND store_id = ?)
      `, pId, sId);
    } else {
      const sId = storeId != null ? Number(storeId) : 1;
      smItems = all(`
        SELECT DISTINCT section, item_key
        FROM stock_moves
        WHERE store_id = ?
      `, sId);

      srItems = all(`
        SELECT DISTINCT section, item_key
        FROM store_reorder
        WHERE store_id = ?
      `, sId);
    }

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
      const calc = calculateItemRop(it.section, it.item_key, ctx, opts);
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
      physical_store_id: physId,
      store_name: ctx.name,
      store_code: ctx.code,
      store_type: ctx.store_type,
      kpis,
      items: results
    };
  });
}

/**
 * Discovers and pairs inter-store rebalance opportunities across physical store locations:
 * Matches deficit stores (balance <= ROP) with donating surplus stores (balance > ROP + SS).
 * Prioritizes direct site-to-site rebalancing between remote Site Stores when available!
 */
function findRebalanceOpportunities({ storeId = null, physicalStoreId = null, section = null, limit = 100 } = {}) {
  const storeRows = getAllActiveStores();
  if (!storeRows || storeRows.length === 0) return [];

  // Filter target store if requested
  let targetFilter = null;
  if (physicalStoreId != null) {
    targetFilter = resolveStoreContext(physicalStoreId, { isPhysicalStore: true });
  } else if (storeId != null) {
    targetFilter = resolveStoreContext(storeId);
  }

  // Pre-calculate store ROP items keyed by unique store key
  const storeCaches = new Map();
  if (targetFilter) {
    const targetStore = storeRows.find((s) => {
      const matchPhys = targetFilter.physical_store_id && s.physical_store_id === targetFilter.physical_store_id;
      const matchWs = targetFilter.store_id && s.store_id === targetFilter.store_id;
      return matchPhys || matchWs;
    }) || targetFilter;
    const calculated = calculateStoreRop(targetStore);
    storeCaches.set(targetStore.key || ('p:' + targetStore.physical_store_id), calculated.items);
  } else {
    for (const s of storeRows) {
      const calculated = calculateStoreRop(s);
      storeCaches.set(s.key, calculated.items);
    }
  }

  const opportunities = [];

  for (const s of storeRows) {
    const targetStore = s;

    if (targetFilter) {
      const matchPhys = targetFilter.physical_store_id && targetStore.physical_store_id === targetFilter.physical_store_id;
      const matchWs = targetFilter.store_id && targetStore.store_id === targetFilter.store_id;
      if (!matchPhys && !matchWs) continue;
    }

    const items = storeCaches.get(targetStore.key) || [];
    for (const item of items) {
      if (section && item.section !== section) continue;
      if (item.shortfall <= 0) continue; // Not in deficit

      // Target store has shortfall! Search donor stores for available surplus.
      let bestDonor = null;

      for (const donorStore of storeRows) {
        if (donorStore.key === targetStore.key) continue; // Don't transfer from self
        if (donorStore.physical_store_id && targetStore.physical_store_id && donorStore.physical_store_id === targetStore.physical_store_id) continue;
        if (!donorStore.physical_store_id && !targetStore.physical_store_id && donorStore.store_id === targetStore.store_id) continue;

        let donorItem = null;
        if (storeCaches.has(donorStore.key)) {
          donorItem = (storeCaches.get(donorStore.key) || []).find((di) => di.section === item.section && di.item_key === item.item_key);
        } else {
          donorItem = calculateItemRop(item.section, item.item_key, donorStore);
        }

        if (donorItem && donorItem.available_surplus > 0) {
          // Found a donor store with surplus!
          // Prioritize direct inter-site transfer (Site Store -> Site Store) to avoid central bottleneck!
          const isInterSite = targetStore.store_type === 'SITE_STORE' && donorStore.store_type === 'SITE_STORE';
          const bestIsInterSite = bestDonor && (targetStore.store_type === 'SITE_STORE' && bestDonor.donorStore.store_type === 'SITE_STORE');

          let chooseDonor = false;
          if (!bestDonor) {
            chooseDonor = true;
          } else if (isInterSite && !bestIsInterSite) {
            chooseDonor = true;
          } else if (isInterSite === bestIsInterSite && donorItem.available_surplus > bestDonor.available_surplus) {
            chooseDonor = true;
          }

          if (chooseDonor) {
            bestDonor = {
              donorStore,
              ...donorItem
            };
          }
        }
      }

      if (bestDonor) {
        const transferQty = Math.min(item.shortfall, bestDonor.available_surplus);
        const urgency = (item.status === 'STOCKOUT' || item.status === 'CRITICAL') ? 'HIGH' : 'NORMAL';

        opportunities.push({
          id: `REC-${item.section.toUpperCase()}-${item.item_key}-${bestDonor.donorStore.store_id || bestDonor.donorStore.id}-${targetStore.store_id || targetStore.id}`,
          section: item.section,
          item_key: item.item_key,
          item_name: item.item_name,
          unit: item.unit,
          from_store_id: bestDonor.donorStore.store_id,
          from_store_location_id: bestDonor.donorStore.physical_store_id,
          from_store_code: bestDonor.donorStore.code,
          from_store_name: bestDonor.donorStore.name,
          from_store_type: bestDonor.donorStore.store_type,
          from_balance: bestDonor.balance,
          from_rop: bestDonor.rop,
          from_safety_stock: bestDonor.safety_stock,
          from_available_surplus: bestDonor.available_surplus,
          to_store_id: targetStore.store_id,
          to_store_location_id: targetStore.physical_store_id,
          to_store_code: targetStore.code,
          to_store_name: targetStore.name,
          to_store_type: targetStore.store_type,
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
 * 1-Click Atomic Material Transfer Note (MTN) Generator for inter-store stock rebalancing.
 * Creates an official MTN with universal chain tracking (CHN-YYYY-XXXXX) and links
 * both physical store locations (store_locations) and legacy workshops.
 */
function createRebalanceMtn({ fromStoreId, toStoreId, fromStoreLocationId, toStoreLocationId, items, reason, user = null }) {
  const fromWs = fromStoreId ? stores.byId(fromStoreId) : null;
  const toWs = toStoreId ? stores.byId(toStoreId) : null;
  const fromLoc = fromStoreLocationId ? storeLocations.getStoreLocationById(fromStoreLocationId) : null;
  const toLoc = toStoreLocationId ? storeLocations.getStoreLocationById(toStoreLocationId) : null;

  if (fromStoreLocationId && toStoreLocationId && Number(fromStoreLocationId) === Number(toStoreLocationId)) {
    throw new Error('Valid, distinct source and destination stores are required.');
  }
  if (fromStoreId && toStoreId && Number(fromStoreId) === Number(toStoreId)) {
    throw new Error('Valid, distinct source and destination stores are required.');
  }
  if (!fromStoreLocationId && !fromStoreId) {
    throw new Error('Valid, distinct source and destination stores are required.');
  }
  if (!toStoreLocationId && !toStoreId) {
    throw new Error('Valid, distinct source and destination stores are required.');
  }

  const fromName = fromLoc ? fromLoc.name : (fromWs ? fromWs.name : 'Store #' + fromStoreId);
  const toName = toLoc ? toLoc.name : (toWs ? toWs.name : 'Store #' + toStoreId);

  // Look up mapped physical store locations without false fallback
  let fromPhys = fromLoc;
  if (!fromPhys && fromWs) {
    const byMap = get('SELECT sl.* FROM store_location_mappings m JOIN store_locations sl ON sl.id = m.store_location_id WHERE m.legacy_store_id = ? LIMIT 1', fromWs.id);
    const byWs = get('SELECT * FROM store_locations WHERE workshop_id = ? AND active = 1 ORDER BY is_default DESC, id ASC LIMIT 1', fromWs.id);
    fromPhys = byMap || byWs || null;
  }
  let toPhys = toLoc;
  if (!toPhys && toWs) {
    const byMap = get('SELECT sl.* FROM store_location_mappings m JOIN store_locations sl ON sl.id = m.store_location_id WHERE m.legacy_store_id = ? LIMIT 1', toWs.id);
    const byWs = get('SELECT * FROM store_locations WHERE workshop_id = ? AND active = 1 ORDER BY is_default DESC, id ASC LIMIT 1', toWs.id);
    toPhys = byMap || byWs || null;
  }

  const fromPhysId = fromPhys ? fromPhys.id : null;
  const toPhysId = toPhys ? toPhys.id : null;
  const fromWsId = fromWs ? fromWs.id : (fromPhys ? (fromPhys.workshop_id || 1) : 1);
  const toWsId = toWs ? toWs.id : (toPhys ? (toPhys.workshop_id || 1) : 1);

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one item must be selected for transfer.');
  }

  const prepName = user ? (user.fullName || user.username) : 'System Rebalance Engine';

  return inWorkshop(fromWsId, () => {
    return tx(() => {
      // Determine next sequential MTN number (~58xxx)
      const lastMtn = get("SELECT mtn_no FROM mtn WHERE mtn_no GLOB '[0-9]*' ORDER BY CAST(mtn_no AS INTEGER) DESC LIMIT 1");
      const nextNo = lastMtn && Number(lastMtn.mtn_no) ? String(Number(lastMtn.mtn_no) + 1) : String(58000 + Math.floor(Math.random() * 900) + 100);

      // Universal chain number
      const chainNo = chainPipeline.nextChainNo();

      const mtnReason = reason || `Automated stock rebalance: transfer surplus parts from ${fromName} to ${toName}`;

      const fromPlace = 'w:' + fromWsId;
      const toPlace = 'w:' + toWsId;

      const info = run(`
        INSERT INTO mtn (
          mtn_no, chain_no, txn_date, from_location, to_location,
          from_place, to_place, workshop_id,
          from_store_location_id, to_store_location_id,
          reason, prepared_by, prepared_at, prepared_designation, status
        ) VALUES (
          ?, ?, date('now'), ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, datetime('now'), 'Store In-Charge', 'draft'
        )
      `, nextNo, chainNo, fromName, toName,
         fromPlace, toPlace, fromWsId,
         fromPhysId, toPhysId,
         mtnReason, prepName);

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
            category, from_store_id, to_store_id,
            from_store_location_id, to_store_location_id,
            from_location, to_location,
            from_place, to_place, reason
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?
          )
        `, mtnId, lineNo++, si ? si.id : null, desc, q, unit,
           cat, fromWsId, toWsId,
           fromPhysId, toPhysId,
           fromName, toName,
           fromPlace, toPlace, 'Stock Rebalance');
      }

      audit.record({
        userId: user ? user.id : null,
        entity: 'mtn',
        entityId: mtnId,
        action: 'rebalance_created',
        after: {
          mtn_no: nextNo,
          chain_no: chainNo,
          from_store: fromName,
          to_store: toName,
          from_store_location_id: fromPhysId,
          to_store_location_id: toPhysId,
          lines_count: lineNo - 1
        }
      });

      emitter.emit('data_changed', { what: 'stores', mtn_id: mtnId });

      // Cross-workshop synchronization: if MULTIDB is active, sync draft MTN into destination workshop DB
      if (multidb.isMultiDb() && fromWsId !== toWsId) {
        try {
          multidb.withWorkshop(toWsId, () => {
            const destExisting = get('SELECT id FROM mtn WHERE chain_no = ? OR mtn_no = ?', chainNo, nextNo);
            if (!destExisting) {
              const dInfo = run(`
                INSERT INTO mtn (
                  mtn_no, chain_no, txn_date, from_location, to_location,
                  from_place, to_place, workshop_id,
                  from_store_location_id, to_store_location_id,
                  reason, prepared_by, prepared_at, prepared_designation, status
                ) VALUES (
                  ?, ?, date('now'), ?, ?,
                  ?, ?, ?,
                  ?, ?,
                  ?, ?, datetime('now'), 'Store In-Charge', 'draft'
                )
              `, nextNo, chainNo, fromName, toName,
                 fromPlace, toPlace, toWsId,
                 fromPhysId, toPhysId,
                 mtnReason, prepName);
              const destMtnId = dInfo.lastInsertRowid;
              let dLineNo = 1;
              for (const it of items) {
                const q = Number(it.qty) || 0;
                if (q <= 0) continue;
                const desc = String(it.item_name || it.item_key || '').trim();
                const unit = it.unit || 'nos';
                const cat = it.section || it.category || null;
                const si = get('SELECT id FROM store_items WHERE description = ? OR name = ? LIMIT 1', desc, desc);
                run(`
                  INSERT INTO mtn_lines (
                    mtn_id, line_no, store_item_id, description, qty, unit,
                    category, from_store_id, to_store_id,
                    from_store_location_id, to_store_location_id,
                    from_location, to_location,
                    from_place, to_place, reason
                  ) VALUES (
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?, ?
                  )
                `, destMtnId, dLineNo++, si ? si.id : null, desc, q, unit,
                   cat, fromWsId, toWsId,
                   fromPhysId, toPhysId,
                   fromName, toName,
                   fromPlace, toPlace, 'Stock Rebalance');
              }
            }
          });
        } catch {}
      }

      return {
        ok: true,
        mtn_id: mtnId,
        mtn_no: nextNo,
        chain_no: chainNo,
        from_store: fromName,
        to_store: toName,
        from_store_location_id: fromPhysId,
        to_store_location_id: toPhysId,
        items_count: lineNo - 1
      };
    });
  });
}

/**
 * Bulk or single application of calculated ROP thresholds to store_reorder table.
 * Supports physical store locations and legacy workshop stores.
 */
function applyRopLevels(storeOrLocId, items, user = null) {
  const ctx = resolveStoreContext(storeOrLocId);
  const physId = ctx.physical_store_id;
  const sId = ctx.store_id;

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No items provided for ROP application.');
  }

  const userId = user ? user.id : null;

  return inWorkshop(sId, () => {
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
            store_id, physical_store_id, section, item_key, level, safety_stock, reorder_qty,
            avg_daily_demand, lead_time_days, auto_calc, last_calculated_at, set_by, set_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, datetime('now'), ?, datetime('now')
          )
          ON CONFLICT(store_id, section, item_key) DO UPDATE SET
            physical_store_id = COALESCE(excluded.physical_store_id, store_reorder.physical_store_id),
            level = excluded.level,
            safety_stock = excluded.safety_stock,
            reorder_qty = excluded.reorder_qty,
            avg_daily_demand = excluded.avg_daily_demand,
            lead_time_days = excluded.lead_time_days,
            auto_calc = excluded.auto_calc,
            last_calculated_at = excluded.last_calculated_at,
            set_by = excluded.set_by,
            set_at = datetime('now')
        `, sId, physId, sec, key, level, ss, roq, add, lt, autoCalc, userId);

        updated++;
      }

      audit.record({
        userId,
        entity: 'store_reorder',
        entityId: sId,
        action: 'apply_rop_levels',
        after: { store_id: sId, physical_store_id: physId, applied_count: updated }
      });

      emitter.emit('data_changed', { what: 'stores', store_id: sId });

      return {
        ok: true,
        store_id: sId,
        physical_store_id: physId,
        applied_count: updated
      };
    });
  });
}

module.exports = {
  resolveStoreContext,
  getAllActiveStores,
  getItemDemandHistory,
  calculateItemRop,
  calculateStoreRop,
  findRebalanceOpportunities,
  createRebalanceMtn,
  applyRopLevels
};
