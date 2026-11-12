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
// 1. RENTAL RATES
// -----------------------------------------------------------------------------
router.get('/rates', requireAuth, requireModule('fuel'), asyncHandler((_req, res) => {
  const rates = all(`
    SELECT rr.*,
           a.code asset_code, a.registration asset_reg,
           p.name project_name
      FROM rental_rates rr
      LEFT JOIN assets a ON a.id = rr.asset_id
      LEFT JOIN projects p ON p.id = rr.project_id
     ORDER BY rr.category, a.code
  `);
  res.json(rates);
}));

router.post('/rates', requireAuth, requireModule('fuel', 'edit'), asyncHandler((req, res) => {
  const category = clean(req.body.category);
  const assetId = toInt(req.body.asset_id);
  const rateType = clean(req.body.rate_type) || 'hourly';
  const rateAmount = toFloat(req.body.rate_amount);
  const currency = clean(req.body.currency) || 'LKR';
  const effectiveFrom = clean(req.body.effective_from) || new Date().toISOString().slice(0, 10);
  const notes = clean(req.body.notes);

  if (rateAmount <= 0) {
    return res.status(400).json({ error: 'rate_amount > 0 is required' });
  }

  const info = run(`
    INSERT INTO rental_rates (category, asset_id, rate_type, rate_amount, currency, effective_from, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, category || null, assetId || null, rateType, rateAmount, currency, effectiveFrom, notes);

  emitter.emit('data_changed', { type: 'rental_rate', id: info.lastInsertRowid });
  res.json({ ok: true, id: info.lastInsertRowid, rate_amount: rateAmount });
}));

// -----------------------------------------------------------------------------
// 2. EQUIPMENT BILLS & INVOICES
// -----------------------------------------------------------------------------
router.get('/bills', requireAuth, requireModule('fuel'), asyncHandler((req, res) => {
  const projectId = toInt(req.query.project_id);
  const where = projectId ? 'WHERE b.project_id = ?' : '';
  const params = projectId ? [projectId] : [];

  const rows = all(`
    SELECT b.*,
           p.name project_name,
           u.full_name generated_by_name,
           COALESCE(SUM(p_sub.amount), 0) paid_amount,
           ROUND(b.total_amount - COALESCE(SUM(p_sub.amount), 0), 2) balance_due
      FROM bills b
      JOIN projects p ON p.id = b.project_id
      LEFT JOIN users u ON u.id = b.generated_by
      LEFT JOIN payments p_sub ON p_sub.bill_id = b.id
     ${where}
     GROUP BY b.id
     ORDER BY b.period_start DESC, b.id DESC
  `, ...params);

  res.json(rows);
}));

router.get('/bills/:id', requireAuth, requireModule('fuel'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const bill = get(`
    SELECT b.*, p.name project_name, u.full_name generated_by_name
      FROM bills b
      JOIN projects p ON p.id = b.project_id
      LEFT JOIN users u ON u.id = b.generated_by
     WHERE b.id = ?
  `, id);

  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  const items = all(`
    SELECT bli.*,
           a.code asset_code, a.registration asset_reg, a.category asset_category
      FROM bill_line_items bli
      JOIN assets a ON a.id = bli.asset_id
     WHERE bli.bill_id = ?
     ORDER BY a.code
  `, id);

  const payments = all(`
    SELECT p.*, u.full_name recorded_by_name
      FROM payments p
      LEFT JOIN users u ON u.id = p.recorded_by
     WHERE p.bill_id = ?
     ORDER BY p.payment_date DESC, p.id DESC
  `, id);

  const paidAmount = payments.reduce((acc, p) => acc + (p.amount || 0), 0);
  const balanceDue = Math.round((bill.total_amount - paidAmount) * 100) / 100;

  res.json({ bill, items, payments, paid_amount: paidAmount, balance_due: balanceDue });
}));

router.post('/generate', requireAuth, requireModule('fuel', 'add'), asyncHandler((req, res) => {
  const projectId = toInt(req.body.project_id);
  const periodStart = clean(req.body.period_start);
  const periodEnd = clean(req.body.period_end);

  if (!projectId || !periodStart || !periodEnd) {
    return res.status(400).json({ error: 'project_id, period_start, and period_end are required' });
  }

  const project = get('SELECT id, name FROM projects WHERE id = ?', projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const result = tx(() => {
    // 1. Find all machinery running for this project during the period
    const assetsWorked = all(`
      SELECT DISTINCT asset_id FROM daily_conditions
       WHERE project_id = ? AND condition_date >= ? AND condition_date <= ?
       UNION
      SELECT DISTINCT asset_id FROM fuel_issues
       WHERE project_id = ? AND date(issue_date) >= ? AND date(issue_date) <= ? AND (voided IS NULL OR voided = 0)
    `, projectId, periodStart, periodEnd, projectId, periodStart, periodEnd);

    if (assetsWorked.length === 0) {
      throw new Error('No machinery activity found for this project in the given period');
    }

    const nextBillNo = `INV-PLANT-${periodStart.replace(/-/g, '').slice(0, 6)}-${String(projectId).padStart(3, '0')}`;

    const info = run(`
      INSERT INTO bills (bill_no, project_id, period_start, period_end, status, generated_by)
      VALUES (?, ?, ?, ?, 'draft', ?)
    `, nextBillNo, projectId, periodStart, periodEnd, req.user.id);

    const billId = info.lastInsertRowid;
    let subtotal = 0;

    for (const aw of assetsWorked) {
      const asset = get('SELECT id, code, category FROM assets WHERE id = ?', aw.asset_id);
      if (!asset) continue;

      // Rate
      const rateRow = get(`
        SELECT rate_amount FROM rental_rates
         WHERE (asset_id = ? OR category = ?)
         ORDER BY asset_id DESC, id DESC LIMIT 1
      `, asset.id, asset.category);
      const rate = rateRow ? rateRow.rate_amount : 4500.00;

      // Hours worked from conditions
      const hoursWorked = get(`
        SELECT COALESCE(SUM(hours_worked), 0) h FROM daily_conditions
         WHERE asset_id = ? AND project_id = ? AND condition_date >= ? AND condition_date <= ?
      `, asset.id, projectId, periodStart, periodEnd).h || 160;

      const baseAmount = Math.round(hoursWorked * rate * 100) / 100;

      // Fuel dispensed on site
      const fuelCost = get(`
        SELECT COALESCE(SUM(total_price), 0) cost FROM fuel_issues
         WHERE asset_id = ? AND project_id = ? AND date(issue_date) >= ? AND date(issue_date) <= ? AND (voided IS NULL OR voided = 0)
      `, asset.id, projectId, periodStart, periodEnd).cost || 0;

      const netAmount = Math.max(0, Math.round((baseAmount - fuelCost) * 100) / 100);
      subtotal += netAmount;

      run(`
        INSERT INTO bill_line_items (bill_id, asset_id, hours_or_days, rate, base_amount, fuel_deduction, net_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, billId, asset.id, hoursWorked, rate, baseAmount, fuelCost, netAmount);
    }

    run(`UPDATE bills SET subtotal = ?, total_amount = ? WHERE id = ?`, subtotal, subtotal, billId);

    return { id: billId, bill_no: nextBillNo, subtotal, total_amount: subtotal };
  });

  emitter.emit('data_changed', { type: 'bill', id: result.id });
  res.json({ ok: true, ...result });
}));

router.post('/bills/:id/payments', requireAuth, requireModule('fuel', 'edit'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const amount = toFloat(req.body.amount);
  const paymentDate = clean(req.body.payment_date) || new Date().toISOString().slice(0, 10);
  const paymentMethod = clean(req.body.payment_method) || 'bank_transfer';
  const reference = clean(req.body.reference);

  if (amount <= 0) return res.status(400).json({ error: 'amount > 0 is required' });

  const bill = get('SELECT id FROM bills WHERE id = ?', id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  run(`
    INSERT INTO payments (bill_id, amount, payment_date, payment_method, reference, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `, id, amount, paymentDate, paymentMethod, reference, req.user.id);

  emitter.emit('data_changed', { type: 'payment', bill_id: id });
  res.json({ ok: true, bill_id: id, amount });
}));

module.exports = router;
