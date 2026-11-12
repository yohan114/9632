'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth } = require('../lib/auth');
const { requireModule } = require('../lib/permissions');
const { asyncHandler } = require('../lib/http');
const emitter = require('../lib/emitter');

const router = express.Router();

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function toFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function clean(s) {
  return typeof s === 'string' ? s.trim() : '';
}

// -----------------------------------------------------------------------------
// 1. LIST & CREATE BULK TANKS
// -----------------------------------------------------------------------------
router.get('/', requireAuth, requireModule('fuel'), asyncHandler((_req, res) => {
  const tanks = all(`
    SELECT bt.*,
           p.name project_name,
           ROUND((bt.current_litres / NULLIF(bt.capacity_litres, 0)) * 100, 1) pct_full
      FROM bulk_tanks bt
      LEFT JOIN projects p ON p.id = bt.project_id
     ORDER BY bt.name
  `);
  res.json(tanks);
}));

router.post('/', requireAuth, requireModule('fuel', 'add'), asyncHandler((req, res) => {
  const code = clean(req.body.tank_code) || `TANK-${Date.now().toString().slice(-4)}`;
  const name = clean(req.body.name);
  const capacity = toFloat(req.body.capacity_litres);
  const current = toFloat(req.body.current_litres) || 0;
  const fuelKind = clean(req.body.fuel_kind) || 'AUTO_DIESEL';
  const projectId = toInt(req.body.project_id);

  if (!name || capacity <= 0) {
    return res.status(400).json({ error: 'name and capacity_litres > 0 are required' });
  }

  const info = run(`
    INSERT INTO bulk_tanks (tank_code, name, capacity_litres, current_litres, fuel_kind, project_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `, code, name, capacity, current, fuelKind, projectId);

  emitter.emit('data_changed', { type: 'bulk_tank', id: info.lastInsertRowid });
  res.json({ ok: true, id: info.lastInsertRowid, tank_code: code, name });
}));

router.get('/:id', requireAuth, requireModule('fuel'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const tank = get(`
    SELECT bt.*, p.name project_name,
           ROUND((bt.current_litres / NULLIF(bt.capacity_litres, 0)) * 100, 1) pct_full
      FROM bulk_tanks bt
      LEFT JOIN projects p ON p.id = bt.project_id
     WHERE bt.id = ?
  `, id);

  if (!tank) return res.status(404).json({ error: 'Bulk tank not found' });

  const dips = all(`
    SELECT td.*, u.full_name recorded_by_name
      FROM tank_dips td
      LEFT JOIN users u ON u.id = td.recorded_by
     WHERE td.bulk_tank_id = ?
     ORDER BY td.dip_date DESC, td.id DESC
     LIMIT 30
  `, id);

  const recentDispenses = all(`
    SELECT fi.id, fi.issue_no, fi.issue_date, fi.litres, fi.total_price, fi.recipient_name,
           a.code asset_code, a.registration asset_reg
      FROM fuel_issues fi
      JOIN assets a ON a.id = fi.asset_id
     WHERE fi.bulk_tank_id = ? AND (fi.voided IS NULL OR fi.voided = 0)
     ORDER BY fi.issue_date DESC, fi.id DESC
     LIMIT 20
  `, id);

  res.json({ tank, dips, recent_dispenses: recentDispenses });
}));

// -----------------------------------------------------------------------------
// 2. TANK DIPS (PHYSICAL STOCKTAKE RECONCILIATION)
// -----------------------------------------------------------------------------
router.post('/:id/dips', requireAuth, requireModule('fuel', 'edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const tank = get('SELECT id, current_litres FROM bulk_tanks WHERE id = ?', id);
  if (!tank) return res.status(404).json({ error: 'Bulk tank not found' });

  const dipCm = toFloat(req.body.dip_cm);
  const calculatedLitres = toFloat(req.body.calculated_litres);
  const dipDate = clean(req.body.dip_date) || new Date().toISOString().slice(0, 10);
  const notes = clean(req.body.notes);
  const reconcile = req.body.reconcile_stock === true || req.body.reconcile_stock === 'true';

  if (dipCm < 0 || calculatedLitres < 0) {
    return res.status(400).json({ error: 'Valid dip_cm and calculated_litres are required' });
  }

  const systemLitres = tank.current_litres;
  const varianceLitres = Math.round((calculatedLitres - systemLitres) * 100) / 100;

  tx(() => {
    run(`
      INSERT INTO tank_dips (bulk_tank_id, dip_date, dip_cm, calculated_litres, system_litres, variance_litres, recorded_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, id, dipDate, dipCm, calculatedLitres, systemLitres, varianceLitres, req.user.id, notes);

    if (reconcile) {
      run(`UPDATE bulk_tanks SET current_litres = ?, updated_at = datetime('now') WHERE id = ?`, calculatedLitres, id);
    }
  });

  emitter.emit('data_changed', { type: 'tank_dip', tank_id: id });
  res.json({ ok: true, dip_cm: dipCm, calculated_litres: calculatedLitres, variance_litres: varianceLitres });
}));

// -----------------------------------------------------------------------------
// 3. BULK DIESEL PROCUREMENT & REFILLS
// -----------------------------------------------------------------------------
router.get('/orders/list', requireAuth, requireModule('fuel'), asyncHandler((_req, res) => {
  const orders = all(`
    SELECT br.*,
           bt.name bulk_tank_name,
           req_u.full_name requested_by_name,
           rev_u.full_name reviewed_by_name
      FROM bulk_requests br
      JOIN bulk_tanks bt ON bt.id = br.bulk_tank_id
      LEFT JOIN users req_u ON req_u.id = br.requested_by
      LEFT JOIN users rev_u ON rev_u.id = br.reviewed_by
     ORDER BY br.id DESC
  `);
  res.json(orders);
}));

router.post('/orders', requireAuth, requireModule('fuel', 'add'), asyncHandler((req, res) => {
  const tankId = toInt(req.body.bulk_tank_id);
  const litres = toFloat(req.body.requested_litres);
  const supplier = clean(req.body.supplier) || 'Ceypetco';
  const notes = clean(req.body.notes);

  if (!tankId || litres <= 0) {
    return res.status(400).json({ error: 'bulk_tank_id and requested_litres > 0 are required' });
  }

  const nextSeq = (get('SELECT COUNT(*) c FROM bulk_requests').c || 0) + 1;
  const orderNo = `BRQ-${String(nextSeq).padStart(5, '0')}`;

  const info = run(`
    INSERT INTO bulk_requests (request_no, bulk_tank_id, requested_litres, supplier, requested_by, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `, orderNo, tankId, litres, supplier, req.user.id, notes);

  emitter.emit('data_changed', { type: 'bulk_request', id: info.lastInsertRowid });
  res.json({ ok: true, id: info.lastInsertRowid, request_no: orderNo });
}));

router.post('/orders/:id/receive', requireAuth, requireModule('fuel', 'edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const order = get('SELECT * FROM bulk_requests WHERE id = ?', id);
  if (!order) return res.status(404).json({ error: 'Bulk order not found' });
  if (order.status === 'received') return res.status(400).json({ error: 'Order already received' });

  const receivedLitres = toFloat(req.body.received_litres) || order.requested_litres;
  const unitPrice = toFloat(req.body.unit_price) || 329.00;
  const totalPrice = Math.round(receivedLitres * unitPrice * 100) / 100;
  const receivedDate = clean(req.body.received_date) || new Date().toISOString().slice(0, 10);
  const orderRef = clean(req.body.order_ref);

  tx(() => {
    run(`
      UPDATE bulk_requests
         SET status = 'received', received_litres = ?, unit_price = ?, total_price = ?,
             received_date = ?, order_ref = ?, reviewed_by = ?, updated_at = datetime('now')
       WHERE id = ?
    `, receivedLitres, unitPrice, totalPrice, receivedDate, orderRef, req.user.id, id);

    run(`
      UPDATE bulk_tanks
         SET current_litres = current_litres + ?, updated_at = datetime('now')
       WHERE id = ?
    `, receivedLitres, order.bulk_tank_id);
  });

  emitter.emit('data_changed', { type: 'bulk_tank', id: order.bulk_tank_id });
  res.json({ ok: true, id, status: 'received', received_litres: receivedLitres, total_price: totalPrice });
}));

module.exports = router;
