'use strict';

/**
 * Fuel Tank Stock & Dip Reconciler (Plan V2)
 *
 * Enforces authoritative physical stock tracking across bulk tanks and mobile bowsers.
 * Implements dipstick variance tracking and bulk supply receipts.
 */

const { get, all, run, tx } = require('../../db');

function getTank(tankId) {
  return get('SELECT * FROM fuel_tanks WHERE id = ?', String(tankId));
}

function getAllTanks() {
  return all(`
    SELECT t.*, p.name AS project_name, p.code AS project_code, a.ec_code AS bowser_code
      FROM fuel_tanks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN assets a ON a.id = t.bowser_asset_id
     ORDER BY t.active DESC, t.name ASC
  `);
}

function deductStock(tankId, litres) {
  if (!tankId || !litres || litres <= 0) return;
  const num = Number(litres);
  run(`
    UPDATE fuel_tanks
       SET current_litres = MAX(0, current_litres - ?),
           updated_at = datetime('now')
     WHERE id = ?
  `, num, String(tankId));
}

function restoreStock(tankId, litres) {
  if (!tankId || !litres || litres <= 0) return;
  const num = Number(litres);
  run(`
    UPDATE fuel_tanks
       SET current_litres = current_litres + ?,
           updated_at = datetime('now')
     WHERE id = ?
  `, num, String(tankId));
}

function hasDipReconcileCols() {
  try {
    const cols = all('PRAGMA table_info("fuel_tank_dips")').map((c) => c.name);
    return cols.includes('dip_type') && cols.includes('reconciled') && cols.includes('reconciled_note');
  } catch (_) {
    return false;
  }
}

function getDipVarianceThreshold() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'fuel.dip_variance_threshold_litres'");
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 50;
  } catch (_) {
    return 50;
  }
}

function recordDip({ tankId, dipLitres, recordedBy, note, dipType = 'PHYSICAL_DIP', dipDate = null }) {
  const tank = getTank(tankId);
  if (!tank) throw new Error(`Bulk tank not found: ${tankId}`);

  const physical = Number(dipLitres);
  if (isNaN(physical) || physical < 0) throw new Error('Physical dip litres must be zero or positive');

  const computed = Number(tank.current_litres) || 0;
  const variance = Math.round((physical - computed) * 1000) / 1000;
  const dipId = `dip-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const rawType = String(dipType || 'PHYSICAL_DIP').trim().toUpperCase();
  const normType = ['OPENING_STOCK', 'RECONCILIATION', 'PHYSICAL_DIP'].includes(rawType) ? rawType : 'PHYSICAL_DIP';
  const isOpening = normType === 'OPENING_STOCK';
  const effDate = dipDate ? String(dipDate).trim() : null;

  return tx(() => {
    if (hasDipReconcileCols()) {
      run(`
        INSERT INTO fuel_tank_dips (
          id, tank_id, dip_litres, computed_balance, variance_litres, dip_date, note, recorded_by,
          dip_type, reconciled, reconciled_at, reconciled_by, reconciled_note
        ) VALUES (
          ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?,
          CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
          ?, ?
        )
      `,
        dipId, String(tankId), physical, computed, variance, effDate, note || null, recordedBy || 1,
        normType, isOpening ? 1 : 0, isOpening ? 1 : 0,
        isOpening ? (recordedBy || 1) : null,
        isOpening ? (note || 'Opening stock calibration') : null
      );
    } else {
      run(`
        INSERT INTO fuel_tank_dips (
          id, tank_id, dip_litres, computed_balance, variance_litres, dip_date, note, recorded_by
        ) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
      `, dipId, String(tankId), physical, computed, variance, effDate, note || null, recordedBy || 1);
    }

    // Update tank current litres to physical reading after dip verification
    run(`
      UPDATE fuel_tanks
         SET current_litres = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `, physical, String(tankId));

    return {
      id: dipId,
      tank_id: tankId,
      dip_type: normType,
      dip_litres: physical,
      computed_balance: computed,
      variance_litres: variance,
      reconciled: isOpening ? 1 : 0,
    };
  });
}

function getReconciliationSummary({ allowedTankIds = null } = {}) {
  const threshold = getDipVarianceThreshold();
  const allTanks = getAllTanks().filter((t) => t.active !== 0);
  const tanks = Array.isArray(allowedTankIds)
    ? allTanks.filter((t) => allowedTankIds.includes(String(t.id)))
    : allTanks;

  const tankIds = new Set(tanks.map((t) => String(t.id)));
  const zeroStockTanks = tanks.filter((t) => (Number(t.current_litres) || 0) <= 0);
  const lowStockTanks = tanks.filter((t) => {
    const cap = Number(t.capacity_litres) || 0;
    const cur = Number(t.current_litres) || 0;
    return cap > 0 && cur > 0 && (cur / cap) < 0.2;
  });

  const hasCols = hasDipReconcileCols();
  const unresolvedSql = hasCols
    ? `SELECT td.*, t.code AS tank_code, t.name AS tank_name, t.project_id,
              p.name AS project_name, COALESCE(u.full_name, u.username) AS recorder_name
         FROM fuel_tank_dips td
         JOIN fuel_tanks t ON t.id = td.tank_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = td.recorded_by
        WHERE ABS(td.variance_litres) > ?
          AND COALESCE(td.reconciled, 0) = 0
          AND COALESCE(td.dip_type, 'PHYSICAL_DIP') <> 'OPENING_STOCK'
        ORDER BY td.dip_date DESC`
    : `SELECT td.*, t.code AS tank_code, t.name AS tank_name, t.project_id,
              p.name AS project_name, COALESCE(u.full_name, u.username) AS recorder_name
         FROM fuel_tank_dips td
         JOIN fuel_tanks t ON t.id = td.tank_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = td.recorded_by
        WHERE ABS(td.variance_litres) > ?
        ORDER BY td.dip_date DESC`;

  const unresolvedDips = all(unresolvedSql, threshold).filter((d) => tankIds.has(String(d.tank_id)));

  const recentDips = all(`
    SELECT td.*, t.code AS tank_code, t.name AS tank_name,
           COALESCE(u.full_name, u.username) AS recorder_name,
           COALESCE(ru.full_name, ru.username) AS reconciler_name
      FROM fuel_tank_dips td
      JOIN fuel_tanks t ON t.id = td.tank_id
      LEFT JOIN users u ON u.id = td.recorded_by
      LEFT JOIN users ru ON ru.id = td.reconciled_by
     ORDER BY td.dip_date DESC
     LIMIT 40
  `).filter((d) => tankIds.has(String(d.tank_id)));

  return {
    threshold_litres: threshold,
    counts: {
      total_tanks: tanks.length,
      zero_stock_count: zeroStockTanks.length,
      low_stock_count: lowStockTanks.length,
      unresolved_dip_count: unresolvedDips.length,
      healthy_count: tanks.length - zeroStockTanks.length - lowStockTanks.length,
    },
    zero_stock_tanks: zeroStockTanks,
    unresolved_dips: unresolvedDips,
    recent_dips: recentDips,
  };
}

function reconcileDip({ dipId, userId, note }) {
  const dip = get('SELECT * FROM fuel_tank_dips WHERE id = ?', String(dipId));
  if (!dip) {
    const err = new Error(`Tank dip record not found: ${dipId}`);
    err.status = 404;
    throw err;
  }
  const cleanNote = String(note || '').trim();
  if (cleanNote.length < 3) {
    const err = new Error('Reconciliation note must be at least 3 characters');
    err.status = 400;
    throw err;
  }
  if (!hasDipReconcileCols()) {
    throw new Error('fuel_tank_dips reconciliation columns missing; run migration 078');
  }
  run(`
    UPDATE fuel_tank_dips
       SET reconciled = 1,
           reconciled_at = datetime('now'),
           reconciled_by = ?,
           reconciled_note = ?
     WHERE id = ?
  `, userId || 1, cleanNote, String(dipId));

  return get('SELECT * FROM fuel_tank_dips WHERE id = ?', String(dipId));
}

function bulkSetOpeningStock(items, userId) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('items must be a non-empty array');
    err.status = 400;
    throw err;
  }
  if (items.length > 100) {
    const err = new Error('Cannot update more than 100 tanks in a single batch');
    err.status = 400;
    throw err;
  }
  const results = tx(() => {
    const out = [];
    for (const it of items) {
      const tankId = String(it && (it.tankId || it.tank_id) || '').trim();
      const val = Number(it && (it.openingLitres != null ? it.openingLitres : it.opening_litres));
      if (!tankId || isNaN(val) || val < 0) {
        const err = new Error(`Invalid opening stock payload for tank "${tankId}"`);
        err.status = 400;
        throw err;
      }
      out.push(recordDip({
        tankId,
        dipLitres: val,
        recordedBy: userId || 1,
        note: (it.note && String(it.note).trim()) || 'Opening stock calibration',
        dipType: 'OPENING_STOCK',
      }));
    }
    return out;
  });
  return { updated_count: results.length, results };
}

function recordBulkDelivery({ tankId, litres, fuelType, supplier, invoiceNumber, costCents, deliveryDate, receivedBy, note }) {
  const tank = getTank(tankId);
  if (!tank) throw new Error(`Bulk tank not found: ${tankId}`);

  const vol = Number(litres);
  if (isNaN(vol) || vol <= 0) throw new Error('Delivery volume must be greater than 0 litres');

  const deliveryId = `deliv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const effFuelType = String(fuelType || tank.fuel_type || 'AUTO_DIESEL').trim().toUpperCase();
  const effDate = deliveryDate ? String(deliveryDate).trim().slice(0, 10) : new Date().toISOString().slice(0, 10);

  let resolvedCostCents = Number(costCents) > 0 ? Math.round(Number(costCents)) : 0;
  if (!resolvedCostCents) {
    let unitCents = 0;
    try {
      const issueMod = require('./issue');
      if (typeof issueMod.getCurrentPrice === 'function') {
        unitCents = Number(issueMod.getCurrentPrice(effFuelType, effDate)) || 0;
      }
    } catch (_) {}
    if (!unitCents) {
      const row = get(
        `SELECT price_per_litre_cents FROM fuel_prices
          WHERE UPPER(COALESCE(fuel_type, fuel_kind)) = ?
          ORDER BY (CASE WHEN effective_date <= ? THEN 0 ELSE 1 END) ASC, effective_date DESC, id DESC LIMIT 1`,
        effFuelType, effDate
      );
      unitCents = Number(row && row.price_per_litre_cents) || 0;
    }
    if (unitCents > 0) {
      resolvedCostCents = Math.round(vol * unitCents);
    }
  }

  return tx(() => {
    run(`
      INSERT INTO fuel_bulk_deliveries (
        id, tank_id, litres, fuel_type, supplier, invoice_number, cost_cents, delivery_date, status, received_by, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DELIVERED', ?, ?)
    `, deliveryId, String(tankId), vol, effFuelType,
       supplier || 'Ceylon Petroleum Corporation (Ceypetco)', invoiceNumber || null,
       resolvedCostCents, effDate,
       receivedBy || 1, note || null);

    restoreStock(tankId, vol);

    return {
      id: deliveryId,
      tank_id: tankId,
      litres: vol,
      cost_cents: resolvedCostCents,
      new_balance: (Number(tank.current_litres) || 0) + vol,
    };
  });
}

module.exports = {
  getTank,
  getAllTanks,
  deductStock,
  restoreStock,
  recordDip,
  recordBulkDelivery,
  getDipVarianceThreshold,
  getReconciliationSummary,
  reconcileDip,
  bulkSetOpeningStock,
};
