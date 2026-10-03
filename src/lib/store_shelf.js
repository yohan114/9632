'use strict';

// ===========================================================================
// One store's shelf (improvement plan, Step 2) -- what the stock cockpit, the stock value report
// and the dashboard show someone kept to their own store (src/lib/scope.js ownStore).
// ===========================================================================

const { all } = require('../db');
const scope = require('./scope');

// The company-wide boards hold one balance per item and every battery. Someone kept to their own
// store gets the same figures for their store — its shelf, its own reorder levels, its batteries —
// from the stock ledger the Stores page reads (src/lib/stock.js).
const STORE_SECTIONS = [['general', 'General Items', 'nos'], ['oil', 'Lubricants & Oil', 'L'], ['filter', 'Filters', 'nos']];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function storeShelf(store) {
  const stock = require('./stock');
  return STORE_SECTIONS.map(([section, label, unit]) => ({
    section, label, unit, rows: stock.items(section, null, 100000, { store }),
  }));
}
const storeBatteries = (store) => all(
  `SELECT b.id, b.serial_no, b.brand, b.capacity_ah, b.condition, b.state, a.code AS asset_code
     FROM batteries b LEFT JOIN assets a ON a.id = b.current_asset_id WHERE ${scope.storeOfRow('b.store_id')} = ?`, store);

/** Every item at or below the store's own reorder level, out of stock first. */
function reorderAlerts(store, shelves = storeShelf(store)) {
  const alerts = [];
  for (const sh of shelves) {
    for (const r of sh.rows) {
      const level = Number(r.reorder_level) || 0;
      if (!(level > 0 && r.balance <= level)) continue;
      const shortfall = Math.max(1, r2(level - r.balance));
      alerts.push({
        // Not a store_items id — the restock note below matches a general item by name instead.
        section: sh.section, section_label: sh.label, item_id: `${sh.section}:${r.item_key}`, name: r.item_name, code: r.item_key,
        category: sh.label, unit: sh.unit, current_stock: r.balance, reorder_level: level, shortfall,
        unit_cost: r.unit_price || 0, estimated_cost: r2(shortfall * (r.unit_price || 0)),
        urgency: r.balance <= 0 ? 'CRITICAL' : 'LOW',
      });
    }
  }
  alerts.sort((a, b) => (a.urgency === b.urgency ? b.estimated_cost - a.estimated_cost : (a.urgency === 'CRITICAL' ? -1 : 1)));
  return alerts;
}

function storeOverview(store) {
  const shelves = storeShelf(store);
  const value = (sec) => r2(shelves.find((s) => s.section === sec).rows.reduce((t, r) => t + (r.value || 0), 0));
  const count = (sec) => shelves.find((s) => s.section === sec).rows.length;
  const alerts = reorderAlerts(store, shelves);
  return {
    store_id: store,
    total_valuation: r2(value('general') + value('oil') + value('filter')),
    valuation_breakdown: { general: value('general'), oil: value('oil'), filters: value('filter') },
    sku_counts: {
      total: count('general') + count('oil') + count('filter'),
      general: count('general'), oil: count('oil'), filters: count('filter'),
      in_store_batteries: storeBatteries(store).filter((b) => b.state === 'in_store').length,
    },
    reorder_summary: {
      total_alerts: alerts.length,
      critical_count: alerts.filter((a) => a.urgency === 'CRITICAL').length,
      low_count: alerts.filter((a) => a.urgency === 'LOW').length,
      total_estimated_cost: r2(alerts.reduce((t, a) => t + a.estimated_cost, 0)),
    },
    reorder_alerts: alerts.slice(0, 150),
  };
}

function storeSearch(store, sectionFilter) {
  const out = [];
  for (const sh of storeShelf(store)) {
    if (sectionFilter !== 'all' && sectionFilter !== sh.section) continue;
    for (const r of sh.rows) {
      const level = Number(r.reorder_level) || 0;
      out.push({
        id: `${sh.section}-${r.item_key}`, raw_id: `${sh.section}:${r.item_key}`, section: sh.section, section_label: sh.label,
        code: r.item_key, name: r.item_name || r.item_key, brand: null, category: sh.label, unit: sh.unit,
        balance: r.balance, reorder_level: level, unit_cost: r.unit_price || 0, total_value: r.value || 0,
        location: null, status: r.balance <= 0 ? 'critical' : (level > 0 && r.balance <= level ? 'low' : 'ok'),
      });
    }
  }
  if (sectionFilter === 'all' || sectionFilter === 'battery') {
    for (const b of storeBatteries(store)) {
      out.push({
        id: `bat-${b.id}`, raw_id: b.id, section: 'battery', section_label: 'Batteries', code: b.serial_no || '—',
        name: `Battery ${b.brand || ''} ${b.capacity_ah ? b.capacity_ah + 'Ah' : ''} (${b.condition || 'new'})`.trim(),
        brand: b.brand || null, category: 'Batteries', unit: 'nos', balance: b.state === 'in_store' ? 1 : 0,
        reorder_level: 0, unit_cost: 0, total_value: 0,
        location: b.state === 'in_store' ? 'Battery Room' : (b.asset_code ? `On ${b.asset_code}` : b.state),
        status: b.state === 'in_store' ? 'ok' : 'low',
      });
    }
  }
  return out;
}

/** The store's stock value, by section: the stock value report's figures for one store. */
function valuation(store) {
  const shelves = storeShelf(store);
  const by = (sec) => shelves.find((s) => s.section === sec);
  const value = (sec) => r2(by(sec).rows.reduce((t, r) => t + (r.value || 0), 0));
  const general = value('general'), oil = value('oil'), filter = value('filter');
  return {
    store_id: store, general_parts_value: general, oil_value: oil, filter_value: filter,
    grand_total: r2(general + oil + filter),
    counts: { general: by('general').rows.length, oil: by('oil').rows.length, filter: by('filter').rows.length },
    // The shelf keeps no category of its own, so the breakdown is by kind of stock.
    by_category: shelves.map((s) => ({ category: s.label, kind: s.section, value: value(s.section), items: s.rows.length }))
      .filter((c) => c.value > 0).sort((a, b) => b.value - a.value),
  };
}

module.exports = { STORE_SECTIONS, storeShelf, storeBatteries, reorderAlerts, storeOverview, storeSearch, valuation };
