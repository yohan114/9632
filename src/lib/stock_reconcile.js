'use strict';

/**
 * Stage B Pillar 2 — Negative Stock Reconciliation & Issue Guard Policy
 *
 * Identifies negative balances across:
 *   1. store_items (general items register)
 *   2. products / stock_ledger (oil & lubricants) + cache drift detection
 *   3. stock_moves (unified multi-store shelf ledger)
 * and provides an audited, atomic reconciliation workflow + configurable
 * non-negative stock issue guard toggle.
 */

const { get, all, run, tx } = require('../db');
const stock = require('./stock');
const stores = require('./stores');
const scope = require('./scope');
const stockRule = require('./stock_rule');
const workshops = require('./workshops');
const audit = require('./audit');

const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function slToday() {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}

function fail(status, msg) {
  const e = new Error(msg);
  e.status = status;
  throw e;
}

function getGuardPolicy() {
  const allWs = all('SELECT id, code, name FROM workshops WHERE active = 1 ORDER BY id');
  return {
    block_negative_issue: stockRule.isGlobalBlockEnabled(),
    per_store: allWs.map((w) => ({
      store_id: w.id,
      store_code: w.code,
      store_name: w.name,
      rules: stockRule.status(w.id),
    })),
  };
}

function setGuardPolicy({ blockNegativeIssue }, actor) {
  const val = blockNegativeIssue ? '1' : '0';
  run(
    `INSERT INTO settings (key, value) VALUES ('stock.block_negative_issue', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    val
  );
  if (actor) {
    audit.record({
      userId: actor.id,
      entity: 'settings',
      action: 'stock_guard_policy',
      after: { block_negative_issue: !!blockNegativeIssue },
    });
  }
  return getGuardPolicy();
}

function listNegativeStock(user) {
  const ownStore = scope.ownStore(user);

  const generalItems = ownStore
    ? []
    : all(`
        SELECT id, item_no, name, category, unit, balance,
               COALESCE(unit_cost, 0) AS unit_cost, rack
          FROM store_items
         WHERE balance < -0.001
         ORDER BY balance ASC, name ASC
      `);

  const oilProducts = ownStore
    ? []
    : all(`
        SELECT p.id, p.code, p.name, p.category, p.unit,
               COALESCE(p.stock_qty, 0) AS stock_qty,
               COALESCE(p.unit_price, 0) AS unit_price,
               (SELECT sl.balance_after
                  FROM stock_ledger sl
                 WHERE sl.product_id = p.id AND COALESCE(sl.voided, 0) = 0
                 ORDER BY sl.id DESC LIMIT 1) AS ledger_balance
          FROM products p
         WHERE COALESCE(p.stock_qty, 0) < -0.001
            OR COALESCE((SELECT sl.balance_after
                           FROM stock_ledger sl
                          WHERE sl.product_id = p.id AND COALESCE(sl.voided, 0) = 0
                          ORDER BY sl.id DESC LIMIT 1), 0) < -0.001
         ORDER BY COALESCE(p.stock_qty, 0) ASC, p.name ASC
      `).map((p) => {
        const legBal = p.ledger_balance != null ? Number(p.ledger_balance) : Number(p.stock_qty);
        return {
          ...p,
          ledger_balance: n2(legBal),
          stock_qty: n2(p.stock_qty),
          has_drift: Math.abs(Number(p.stock_qty) - legBal) > 0.01,
        };
      });

  const oilDriftCount = ownStore
    ? 0
    : (get(`
        SELECT COUNT(*) AS n
          FROM products p
         WHERE EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.product_id = p.id AND COALESCE(sl.voided, 0) = 0)
           AND ABS(COALESCE(p.stock_qty, 0) - COALESCE((
                 SELECT sl.balance_after
                   FROM stock_ledger sl
                  WHERE sl.product_id = p.id AND COALESCE(sl.voided, 0) = 0
                  ORDER BY sl.id DESC LIMIT 1
               ), 0)) > 0.01
      `) || {}).n || 0;

  const shelfParams = [];
  const shelfStoreClause = ownStore ? ' AND sm.store_id = ?' : '';
  if (ownStore) shelfParams.push(ownStore);

  const shelfItems = all(`
    SELECT sm.section, sm.item_key, sm.store_id,
           w.code AS store_code, w.name AS store_name,
           COALESCE(MAX(si.name), MAX(sm.item_name)) AS item_name,
           COALESCE(MAX(si.unit), CASE WHEN sm.section = 'oil' THEN 'L' ELSE 'nos' END) AS unit,
           ROUND(SUM(CASE WHEN sm.kind IN ('in','opening','adjust') THEN sm.qty ELSE -sm.qty END), 2) AS balance
      FROM stock_moves sm
      LEFT JOIN workshops w ON w.id = sm.store_id
      LEFT JOIN stock_items si ON si.section = sm.section AND si.item_key = sm.item_key
     WHERE sm.counts = 1${shelfStoreClause}
     GROUP BY sm.section, sm.item_key, sm.store_id
    HAVING balance < -0.001
     ORDER BY balance ASC, item_name ASC
     LIMIT 500
  `, ...shelfParams);

  return {
    summary: {
      general_count: generalItems.length,
      oil_count: oilProducts.length,
      shelf_count: shelfItems.length,
      oil_drift_count: oilDriftCount,
      total_ledger_negatives: generalItems.length + oilProducts.length,
    },
    general_items: generalItems,
    oil_products: oilProducts,
    shelf_items: shelfItems,
    policy: getGuardPolicy(),
  };
}

function syncOilStockCache(actor) {
  const drifted = all(`
    SELECT p.id, p.name, p.stock_qty,
           (SELECT sl.balance_after
              FROM stock_ledger sl
             WHERE sl.product_id = p.id AND COALESCE(sl.voided, 0) = 0
             ORDER BY sl.id DESC LIMIT 1) AS ledger_balance
      FROM products p
     WHERE EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.product_id = p.id AND COALESCE(sl.voided, 0) = 0)
       AND ABS(COALESCE(p.stock_qty, 0) - COALESCE((
             SELECT sl.balance_after
               FROM stock_ledger sl
              WHERE sl.product_id = p.id AND COALESCE(sl.voided, 0) = 0
              ORDER BY sl.id DESC LIMIT 1
           ), 0)) > 0.01
  `);

  tx(() => {
    for (const r of drifted) {
      run('UPDATE products SET stock_qty = ? WHERE id = ?', n2(r.ledger_balance), r.id);
    }
  });

  if (drifted.length && actor) {
    audit.record({
      userId: actor.id,
      entity: 'products',
      action: 'sync_oil_stock_cache',
      after: { synced: drifted.length, ids: drifted.map((r) => r.id) },
    });
  }

  return { ok: true, synced: drifted.length };
}

function reconcileNegativeItems(items, actor) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) fail(400, 'Select at least one negative-stock item to reconcile');

  const today = slToday();
  const defaultStore = workshops.defaultId();
  const results = [];

  for (const it of list) {
    const type = String(it && it.target_type || '').trim();
    if (!['general_item', 'oil_product', 'shelf'].includes(type)) {
      fail(400, `Unsupported reconciliation target_type: ${type || '(empty)'}`);
    }
    const counted = Number(it.counted_qty);
    if (!Number.isFinite(counted) || counted < 0) {
      fail(400, 'Physical counted quantity must be a number >= 0');
    }
    const reason = String(it.reason || '').trim();
    if (reason.length < 3) {
      fail(400, 'Reconciliation reason (at least 3 characters) is required');
    }
  }

  tx(() => {
    for (const it of list) {
      const type = String(it.target_type).trim();
      const counted = n2(it.counted_qty);
      const reason = String(it.reason).trim().slice(0, 180);
      const storeId = Number(it.store_id) || defaultStore;
      const ownStore = scope.ownStore(actor);
      if (ownStore && storeId !== ownStore) {
        fail(403, `Cannot reconcile another store's shelf (#${storeId})`);
      }

      if (type === 'general_item') {
        const itemId = Number(it.id);
        const si = get('SELECT * FROM store_items WHERE id = ?', itemId);
        if (!si) fail(404, `Store item #${itemId} not found`);

        const prevRow = get('SELECT balance_after FROM general_item_txns WHERE store_item_id = ? ORDER BY id DESC LIMIT 1', si.id);
        const prev = prevRow ? Number(prevRow.balance_after) : Number(si.balance || 0);
        const delta = n2(counted - prev);
        const txnId = run(
          `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, ref, txn_date, store_id)
           VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?)`,
          si.id, delta, counted, si.unit_cost || null, `NEG-RECON: ${reason}`, today, storeId
        ).lastInsertRowid;
        run('UPDATE store_items SET balance = ? WHERE id = ?', counted, si.id);
        stock.sync({ general_item_txns: [txnId] });

        const sec = stock.sectionOf(si.category);
        const itemKey = stock.itemKey(sec, si.name);
        const shelfBal = stock.balanceOf(sec, itemKey, storeId);
        if (Math.abs(shelfBal - counted) > 0.001) {
          const shelfDelta = n2(counted - shelfBal);
          const scId = run(
            `INSERT INTO store_counts (store_id, section, item_key, item_name, count_date, book_qty, counted_qty, delta, note, counted_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            storeId, sec, itemKey, si.name, today, shelfBal, counted, shelfDelta,
            `NEG-RECON: ${reason}`.slice(0, 200), actor ? actor.id : null
          ).lastInsertRowid;
          stock.recordCount(get('SELECT * FROM store_counts WHERE id = ?', scId));
        }

        results.push({ target_type: type, id: si.id, name: si.name, before: prev, after: counted });
      } else if (type === 'oil_product') {
        const prodId = Number(it.id);
        const p = get('SELECT * FROM products WHERE id = ?', prodId);
        if (!p) fail(404, `Oil product #${prodId} not found`);

        const lastRow = get('SELECT id, balance_after, txn_date FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', p.id);
        const prev = lastRow ? Number(lastRow.balance_after) : Number(p.stock_qty || 0);
        const delta = n2(counted - prev);
        const effDate = lastRow && lastRow.txn_date > today ? lastRow.txn_date : today;

        const ledgerId = run(
          `INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, note, store_id)
           VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?)`,
          p.id, delta, counted, p.unit_price || null, effDate, `NEG-RECON: ${reason}`, storeId
        ).lastInsertRowid;
        run('UPDATE products SET stock_qty = ? WHERE id = ?', counted, p.id);
        stock.sync({ stock_ledger: [ledgerId] });

        const oilKey = stock.itemKey('oil', p.name, p.code || p.name);
        const shelfBal = stock.balanceOf('oil', oilKey, storeId);
        if (Math.abs(shelfBal - counted) > 0.001) {
          const shelfDelta = n2(counted - shelfBal);
          const scId = run(
            `INSERT INTO store_counts (store_id, section, item_key, item_name, count_date, book_qty, counted_qty, delta, note, counted_by)
             VALUES (?, 'oil', ?, ?, ?, ?, ?, ?, ?, ?)`,
            storeId, oilKey, p.name, today, shelfBal, counted, shelfDelta,
            `NEG-RECON: ${reason}`.slice(0, 200), actor ? actor.id : null
          ).lastInsertRowid;
          stock.recordCount(get('SELECT * FROM store_counts WHERE id = ?', scId));
        }

        results.push({ target_type: type, id: p.id, name: p.name, before: prev, after: counted });
      } else if (type === 'shelf') {
        const section = String(it.section || '').toLowerCase();
        const itemKey = String(it.item_key || '').trim();
        if (!stock.SECTIONS.includes(section) || !itemKey) {
          fail(400, 'Shelf reconciliation requires valid section and item_key');
        }
        const si = get('SELECT name FROM stock_items WHERE section = ? AND item_key = ?', section, itemKey);
        const mv = get('SELECT item_name FROM stock_moves WHERE section = ? AND item_key = ? ORDER BY id DESC LIMIT 1', section, itemKey);
        const itemName = String(it.item_name || (si && si.name) || (mv && mv.item_name) || itemKey);
        const book = stock.balanceOf(section, itemKey, storeId);
        const delta = n2(counted - book);
        if (Math.abs(delta) > 0.001) {
          const scId = run(
            `INSERT INTO store_counts (store_id, section, item_key, item_name, count_date, book_qty, counted_qty, delta, note, counted_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            storeId, section, itemKey, itemName, today, book, counted, delta,
            `NEG-RECON: ${reason}`.slice(0, 200), actor ? actor.id : null
          ).lastInsertRowid;
          stock.recordCount(get('SELECT * FROM store_counts WHERE id = ?', scId));
        }
        results.push({ target_type: type, section, item_key: itemKey, store_id: storeId, before: book, after: counted });
      }
    }
  });

  if (actor) {
    audit.record({
      userId: actor.id,
      entity: 'stock_reconciliation',
      action: 'reconcile_negative',
      reason: String(list[0].reason || '').trim(),
      after: { reconciled: results.length, items: results.slice(0, 30) },
    });
  }

  return { ok: true, reconciled: results.length, results };
}

module.exports = {
  getGuardPolicy,
  setGuardPolicy,
  listNegativeStock,
  syncOilStockCache,
  reconcileNegativeItems,
};
