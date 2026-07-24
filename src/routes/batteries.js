'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');

const router = express.Router();

function resolveAsset(text) {
  if (!text) return null;
  const r = aliases.resolveAsset(text, { source: 'battery' });
  return r.assetId;
}

// Battery photos are stored as resized base64 data URLs (same as e-signatures) so
// they travel with the DB backups. Validate type + cap size (client resizes first).
const PHOTO_RE = /^data:image\/(png|jpe?g|webp);base64,/;
function photoError(p) {
  if (!p) return null;
  if (!PHOTO_RE.test(String(p))) return { status: 400, error: 'Photo must be a PNG, JPEG or WebP image' };
  if (String(p).length > 900000) return { status: 413, error: 'Image too large — please choose a smaller photo (max ~700 KB)' };
  return null;
}

router.get('/', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.state) { clauses.push('b.state = ?'); params.push(req.query.state); }
  if (req.query.q) { clauses.push('(b.serial_no LIKE ? OR b.brand LIKE ?)'); params.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  // The list omits the photo blob (only a has_photo flag) to keep the payload light;
  // the full image is returned by GET /:id.
  res.json(all(`SELECT b.id, b.serial_no, b.brand, b.capacity_ah, b.condition, b.purchase_date, b.warranty_date,
                       b.current_asset_id, b.state, (b.photo_path IS NOT NULL AND b.photo_path <> '') AS has_photo,
                       a.code AS current_asset_code
                  FROM batteries b LEFT JOIN assets a ON a.id = b.current_asset_id ${where} ORDER BY b.serial_no`, ...params));
}));

router.post('/', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['serial_no']);
  if (get('SELECT id FROM batteries WHERE serial_no = ?', b.serial_no)) return res.status(409).json({ error: 'Serial already exists' });
  const pe = photoError(b.photo_path); if (pe) return res.status(pe.status).json({ error: pe.error });
  const assetId = toInt(b.current_asset_id) || resolveAsset(b.current_asset);
  const state = b.state || (assetId ? 'installed' : 'in_store');
  const result = tx(() => {
    const info = run(
      `INSERT INTO batteries (serial_no, brand, capacity_ah, condition, purchase_date, warranty_date, current_asset_id, state, photo_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.serial_no, b.brand || null, toNum(b.capacity_ah), b.condition === 'old' ? 'old' : 'new',
      b.purchase_date || null, b.warranty_date || null, assetId || null, state, b.photo_path || null
    );
    const batId = info.lastInsertRowid;
    run(`INSERT INTO battery_events (battery_id, event_type, to_asset_id, reason, photo_path, user_id, event_date)
         VALUES (?, 'add', ?, ?, ?, ?, ?)`,
      batId, assetId || null, 'Battery added', b.photo_path || null, req.user.id, new Date().toISOString().slice(0, 10));
    if (assetId && state === 'installed') {
      run(`INSERT INTO battery_events (battery_id, event_type, to_asset_id, reason, user_id, event_date)
           VALUES (?, 'install', ?, ?, ?, ?)`,
        batId, assetId, 'Installed on add', req.user.id, new Date().toISOString().slice(0, 10));
    }
    return batId;
  });
  audit.record({ userId: req.user.id, entity: 'battery', entityId: result, action: 'create', after: { serial_no: b.serial_no } });
  res.status(201).json(get('SELECT * FROM batteries WHERE id = ?', result));
}));

router.get('/warranty-radar', asyncHandler((_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const in60 = new Date(Date.now() + 60 * 86400 * 1000).toISOString().slice(0, 10);
  res.json({
    expiring: all(
      `SELECT b.*, a.code AS current_asset_code FROM batteries b LEFT JOIN assets a ON a.id=b.current_asset_id
        WHERE b.warranty_date IS NOT NULL AND b.warranty_date >= ? AND b.warranty_date <= ?
          AND b.state <> 'decommissioned' ORDER BY b.warranty_date`, today, in60
    ),
    idle_in_store: all(`SELECT * FROM batteries WHERE state = 'in_store' ORDER BY serial_no`),
  });
}));

router.get('/whereis/:serial', asyncHandler((req, res) => {
  const battery = get('SELECT * FROM batteries WHERE serial_no = ?', req.params.serial);
  if (!battery) return res.status(404).json({ error: 'Serial not found' });
  const current_asset = battery.current_asset_id ? get('SELECT * FROM assets WHERE id = ?', battery.current_asset_id) : null;
  res.json({ serial: req.params.serial, battery, current_asset });
}));

router.get('/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const battery = get('SELECT b.*, a.code AS current_asset_code FROM batteries b LEFT JOIN assets a ON a.id = b.current_asset_id WHERE b.id = ?', id);
  if (!battery) return res.status(404).json({ error: 'Battery not found' });
  const events = all(
    `SELECT e.*, af.code AS from_asset_code, at2.code AS to_asset_code, u.username FROM battery_events e
       LEFT JOIN assets af ON af.id = e.from_asset_id LEFT JOIN assets at2 ON at2.id = e.to_asset_id
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.battery_id = ? ORDER BY e.id DESC`, id
  );
  res.json({ battery, events });
}));

// Set / replace / clear a battery's photo (no lifecycle event).
router.patch('/:id/photo', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM batteries WHERE id = ?', id)) return res.status(404).json({ error: 'Battery not found' });
  const p = req.body.photo_path;
  const pe = photoError(p); if (pe) return res.status(pe.status).json({ error: pe.error });
  run('UPDATE batteries SET photo_path = ? WHERE id = ?', p || null, id);
  audit.record({ userId: req.user.id, entity: 'battery', entityId: id, action: p ? 'set_photo' : 'clear_photo' });
  res.json(get('SELECT * FROM batteries WHERE id = ?', id));
}));

router.post('/:id/event', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const battery = get('SELECT * FROM batteries WHERE id = ?', id);
  if (!battery) return res.status(404).json({ error: 'Battery not found' });
  const b = req.body;
  require_(b, ['event_type']);
  const valid = ['install', 'transfer', 'return', 'decommission', 'warranty'];
  if (!valid.includes(b.event_type)) return res.status(400).json({ error: 'Invalid event_type' });
  const pe = photoError(b.photo_path); if (pe) return res.status(pe.status).json({ error: pe.error });
  const toAssetId = toInt(b.to_asset_id) || resolveAsset(b.to_asset);
  const fromAssetId = toInt(b.from_asset_id) || resolveAsset(b.from_asset) || battery.current_asset_id;
  // install/transfer must land on a real vehicle — otherwise the battery would be marked
  // 'installed' with current_asset_id NULL (an inconsistent state).
  if ((b.event_type === 'install' || b.event_type === 'transfer') && !toAssetId) {
    return res.status(400).json({ error: 'A known target vehicle is required to install or transfer a battery' });
  }

  const result = tx(() => {
    const info = run(
      `INSERT INTO battery_events (battery_id, event_type, from_asset_id, to_asset_id, reason, mtn_ref, photo_path, user_id, event_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, b.event_type, fromAssetId || null, toAssetId || null, b.reason || null, b.mtn_ref || null,
      b.photo_path || null, req.user.id, b.event_date || new Date().toISOString().slice(0, 10)
    );
    let newAsset = battery.current_asset_id;
    let newState = battery.state;
    switch (b.event_type) {
      case 'install':
      case 'transfer': newAsset = toAssetId || null; newState = 'installed'; break;
      case 'return': newAsset = null; newState = 'in_store'; break;
      case 'warranty': newState = 'handed_over'; break;
      case 'decommission': newAsset = null; newState = 'decommissioned'; break;
    }
    run('UPDATE batteries SET current_asset_id = ?, state = ? WHERE id = ?', newAsset, newState, id);
    return info.lastInsertRowid;
  });
  audit.record({ userId: req.user.id, entity: 'battery', entityId: id, action: 'event', after: { event: b.event_type } });
  res.status(201).json({
    battery: get('SELECT * FROM batteries WHERE id = ?', id),
    event: get('SELECT * FROM battery_events WHERE id = ?', result),
  });
}));

module.exports = router;
