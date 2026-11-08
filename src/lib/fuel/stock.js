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

function recordDip({ tankId, dipLitres, recordedBy, note }) {
  const tank = getTank(tankId);
  if (!tank) throw new Error(`Bulk tank not found: ${tankId}`);

  const physical = Number(dipLitres);
  if (isNaN(physical) || physical < 0) throw new Error('Physical dip litres must be a positive number');

  const computed = Number(tank.current_litres) || 0;
  const variance = physical - computed;
  const dipId = `dip-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  return tx(() => {
    run(`
      INSERT INTO fuel_tank_dips (
        id, tank_id, dip_litres, computed_balance, variance_litres, dip_date, note, recorded_by
      ) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `, dipId, String(tankId), physical, computed, variance, note || null, recordedBy || 1);

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
      dip_litres: physical,
      computed_balance: computed,
      variance_litres: variance,
    };
  });
}

function recordBulkDelivery({ tankId, litres, fuelType, supplier, invoiceNumber, costCents, deliveryDate, receivedBy, note }) {
  const tank = getTank(tankId);
  if (!tank) throw new Error(`Bulk tank not found: ${tankId}`);

  const vol = Number(litres);
  if (isNaN(vol) || vol <= 0) throw new Error('Delivery volume must be greater than 0 litres');

  const deliveryId = `deliv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  return tx(() => {
    run(`
      INSERT INTO fuel_bulk_deliveries (
        id, tank_id, litres, fuel_type, supplier, invoice_number, cost_cents, delivery_date, status, received_by, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DELIVERED', ?, ?)
    `, deliveryId, String(tankId), vol, fuelType || tank.fuel_type || 'AUTO_DIESEL',
       supplier || 'Ceylon Petroleum Corporation (Ceypetco)', invoiceNumber || null,
       costCents || 0, deliveryDate || new Date().toISOString().slice(0, 10),
       receivedBy || 1, note || null);

    restoreStock(tankId, vol);

    return {
      id: deliveryId,
      tank_id: tankId,
      litres: vol,
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
};
