'use strict';

// Tyre & Battery issue ledger + category price book. Issues are imported from the workshop's
// issue-details workbook (src/import/tyre_battery.js); prices are set here — by category (the
// common case) or per individual issue (override). The Monthly Cost Report's Tyre & Battery
// sheets read cost = qty × COALESCE(per-issue price, category price, 0).

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth } = require('../lib/auth');
const { asyncHandler, toInt, toNum } = require('../lib/http');

const router = express.Router();
const KINDS = ['tyre', 'battery'];
const MONTH_RE = /^\d{4}-\d{2}$/;
const reqKind = (v) => (KINDS.includes(String(v)) ? String(v) : null);

// Landing summary: totals + how much of the ledger is priced (by category or per-issue).
router.get('/summary', requireAuth, asyncHandler((_req, res) => {
  const out = {};
  for (const kind of KINDS) {
    const base = get('SELECT COUNT(*) issues, COALESCE(SUM(qty),0) qty, COUNT(DISTINCT category_norm) categories FROM tyre_battery_issues WHERE kind = ?', kind);
    const priced = get(
      `SELECT COUNT(*) n FROM tyre_battery_issues i
         LEFT JOIN tyre_battery_prices p ON p.kind = i.kind AND p.category_norm = i.category_norm
        WHERE i.kind = ? AND COALESCE(i.unit_price, p.unit_price, 0) > 0`, kind);
    const pricedCats = get('SELECT COUNT(*) n FROM tyre_battery_prices WHERE kind = ? AND COALESCE(unit_price,0) > 0', kind);
    out[kind] = { issues: base.issues, qty: base.qty, categories: base.categories, priced_issues: priced.n, priced_categories: pricedCats.n };
  }
  res.json(out);
}));

// Distinct categories for the price editor — frequency-sorted, with the current price.
router.get('/categories', requireAuth, asyncHandler((req, res) => {
  const kind = reqKind(req.query.kind);
  if (!kind) return res.status(400).json({ error: 'kind must be tyre or battery' });
  const rows = all(
    `SELECT i.category_norm, MAX(i.category) category, COUNT(*) issues, ROUND(COALESCE(SUM(i.qty),0),2) qty,
            MAX(p.unit_price) unit_price
       FROM tyre_battery_issues i
       LEFT JOIN tyre_battery_prices p ON p.kind = i.kind AND p.category_norm = i.category_norm
      WHERE i.kind = ? AND COALESCE(i.category_norm,'') <> ''
      GROUP BY i.category_norm ORDER BY issues DESC, i.category_norm`, kind);
  res.json({ kind, categories: rows });
}));

// Issue list — filter by kind (required), optional month (YYYY-MM) and free-text query.
router.get('/issues', requireAuth, asyncHandler((req, res) => {
  const kind = reqKind(req.query.kind);
  if (!kind) return res.status(400).json({ error: 'kind must be tyre or battery' });
  const clauses = ['i.kind = ?'];
  const params = [kind];
  if (req.query.month) {
    if (!MONTH_RE.test(String(req.query.month))) return res.status(400).json({ error: 'month must be YYYY-MM' });
    clauses.push("substr(i.issue_date,1,7) = ?"); params.push(req.query.month);
  }
  if (req.query.q) {
    clauses.push('(i.vehicle LIKE ? OR i.category LIKE ? OR i.site LIKE ?)');
    const like = '%' + String(req.query.q) + '%'; params.push(like, like, like);
  }
  const limit = Math.max(1, Math.min(toInt(req.query.limit) || 500, 2000)); // clamp low too — a negative LIMIT is unbounded in SQLite
  const where = 'WHERE ' + clauses.join(' AND ');
  const summary = get(
    `SELECT COUNT(*) count, ROUND(COALESCE(SUM(i.qty),0),2) qty,
            ROUND(COALESCE(SUM(i.qty * COALESCE(i.unit_price, p.unit_price, 0)),0),2) cost
       FROM tyre_battery_issues i LEFT JOIN tyre_battery_prices p ON p.kind = i.kind AND p.category_norm = i.category_norm ${where}`, ...params);
  const issues = all(
    `SELECT i.id, i.issue_date, i.vehicle, i.site, i.qty, i.qty_raw, i.category, i.category_norm,
            i.unit_price, ROUND(COALESCE(i.unit_price, p.unit_price, 0),2) effective_price,
            ROUND(i.qty * COALESCE(i.unit_price, p.unit_price, 0),2) cost, a.code asset_code
       FROM tyre_battery_issues i
       LEFT JOIN tyre_battery_prices p ON p.kind = i.kind AND p.category_norm = i.category_norm
       LEFT JOIN assets a ON a.id = i.asset_id
       ${where} ORDER BY i.issue_date DESC, i.id DESC LIMIT ?`, ...params, limit);
  res.json({ kind, summary, issues });
}));

// Save category prices (bulk upsert). Body: { kind, prices: [{ category_norm, category?, unit_price }] }.
router.post('/prices', requireAuth, asyncHandler((req, res) => {
  const b = req.body || {};
  const kind = reqKind(b.kind);
  if (!kind) return res.status(400).json({ error: 'kind must be tyre or battery' });
  const prices = Array.isArray(b.prices) ? b.prices.filter((p) => p && typeof p === 'object' && p.category_norm) : [];
  const by = req.user ? (req.user.fullName || req.user.username) : null;
  let saved = 0;
  tx(() => {
    for (const p of prices) {
      const cat = String(p.category_norm);
      const n = toNum(p.unit_price);
      const price = (p.unit_price == null || p.unit_price === '' || !(n >= 0)) ? null : n; // negatives are invalid → unset
      run(
        `INSERT INTO tyre_battery_prices (kind, category_norm, category, unit_price, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(kind, category_norm) DO UPDATE SET
           unit_price = excluded.unit_price,
           category = COALESCE(excluded.category, tyre_battery_prices.category),
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        kind, cat, p.category == null ? null : String(p.category), price, by);
      saved++;
    }
  });
  res.json({ ok: true, kind, saved });
}));

// Per-issue price override. Body: { unit_price } — null/'' clears it (falls back to category price).
router.patch('/issues/:id', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const row = get('SELECT id FROM tyre_battery_issues WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: 'Issue not found' });
  const raw = (req.body || {}).unit_price;
  const n = toNum(raw);
  const price = (raw == null || raw === '' || !(n >= 0)) ? null : n; // negatives are invalid → clear the override
  run('UPDATE tyre_battery_issues SET unit_price = ? WHERE id = ?', price, id);
  res.json({ ok: true, id, unit_price: price });
}));

module.exports = router;
