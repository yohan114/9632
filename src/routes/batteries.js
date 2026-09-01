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

// A battery holds up to six pictures — enough for the serial plate, the condition on arrival
// and the damage behind a warranty claim, without a single record carrying megabytes of image
// into every backup.
const MAX_PHOTOS = 6;

// A vehicle takes at most two batteries. Heavy machines run a pair in series; a third means
// something was recorded wrong, most often an old battery never returned before the new one
// was fitted — so the message says exactly that rather than only refusing.
const MAX_PER_VEHICLE = 2;

/** The batteries the system currently believes are on this vehicle. */
const batteriesOn = (assetId, exceptId) => all(
  `SELECT id, serial_no FROM batteries WHERE current_asset_id = ? AND id <> ? ORDER BY serial_no`,
  assetId, exceptId || 0);

function vehicleFullError(assetId, exceptId) {
  if (!assetId) return null;
  const on = batteriesOn(assetId, exceptId);
  if (on.length < MAX_PER_VEHICLE) return null;
  const a = get('SELECT code, registration FROM assets WHERE id = ?', assetId);
  const name = a ? (a.code || a.registration || `asset ${assetId}`) : `asset ${assetId}`;
  return { status: 409,
    error: `${name} already has ${on.length} batteries (${on.map((b) => b.serial_no).join(', ')}). `
      + 'Return or decommission the one coming off first, then install this one.' };
}

/** Photos are the record; batteries.photo_path is the cover, rebuilt from them. */
function syncCoverPhoto(batteryId) {
  const first = get('SELECT photo FROM battery_photos WHERE battery_id = ? ORDER BY seq, id LIMIT 1', batteryId);
  run('UPDATE batteries SET photo_path = ? WHERE id = ?', first ? first.photo : null, batteryId);
}

function addPhotos(batteryId, photos, userId, note) {
  const have = get('SELECT COUNT(*) c FROM battery_photos WHERE battery_id = ?', batteryId).c;
  if (have + photos.length > MAX_PHOTOS) {
    return { status: 409,
      error: `A battery holds at most ${MAX_PHOTOS} photos — it has ${have}, so ${MAX_PHOTOS - have} more can be added.` };
  }
  for (const p of photos) { const e = photoError(p); if (e) return e; }
  tx(() => {
    let seq = (get('SELECT MAX(seq) m FROM battery_photos WHERE battery_id = ?', batteryId).m || 0);
    for (const p of photos) {
      run('INSERT INTO battery_photos (battery_id, seq, photo, note, uploaded_by) VALUES (?, ?, ?, ?, ?)',
        batteryId, ++seq, p, note || null, userId || null);
    }
    syncCoverPhoto(batteryId);
  });
  return null;
}

const photosOf = (batteryId) => all(
  `SELECT p.id, p.seq, p.photo, p.note, p.uploaded_at, u.username AS uploaded_by_name
     FROM battery_photos p LEFT JOIN users u ON u.id = p.uploaded_by
    WHERE p.battery_id = ? ORDER BY p.seq, p.id`, batteryId);

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
                       (SELECT COUNT(*) FROM battery_photos p WHERE p.battery_id = b.id) AS photo_count,
                       -- How many this machine is carrying, so a pair reads as a pair.
                       (SELECT COUNT(*) FROM batteries s WHERE s.current_asset_id = b.current_asset_id) AS on_vehicle,
                       a.code AS current_asset_code
                  FROM batteries b LEFT JOIN assets a ON a.id = b.current_asset_id ${where} ORDER BY b.serial_no`, ...params));
}));

router.post('/', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['serial_no']);
  if (get('SELECT id FROM batteries WHERE serial_no = ?', b.serial_no)) return res.status(409).json({ error: 'Serial already exists' });
  // Accept one photo or several; the old single-photo shape still works.
  const photos = (Array.isArray(b.photos) ? b.photos : [b.photo_path]).filter(Boolean);
  if (photos.length > MAX_PHOTOS) return res.status(409).json({ error: `At most ${MAX_PHOTOS} photos per battery` });
  for (const p of photos) { const e = photoError(p); if (e) return res.status(e.status).json({ error: e.error }); }
  const assetId = toInt(b.current_asset_id) || resolveAsset(b.current_asset);
  const full = vehicleFullError(assetId); if (full) return res.status(full.status).json({ error: full.error });
  const state = b.state || (assetId ? 'installed' : 'in_store');
  const result = tx(() => {
    const info = run(
      `INSERT INTO batteries (serial_no, brand, capacity_ah, condition, purchase_date, warranty_date, current_asset_id, state, photo_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.serial_no, b.brand || null, toNum(b.capacity_ah), b.condition === 'old' ? 'old' : 'new',
      b.purchase_date || null, b.warranty_date || null, assetId || null, state, photos[0] || null
    );
    const batId = info.lastInsertRowid;
    let seq = 0;
    for (const p of photos) {
      run('INSERT INTO battery_photos (battery_id, seq, photo, uploaded_by) VALUES (?, ?, ?, ?)', batId, ++seq, p, req.user.id);
    }
    run(`INSERT INTO battery_events (battery_id, event_type, to_asset_id, reason, photo_path, user_id, event_date)
         VALUES (?, 'add', ?, ?, ?, ?, ?)`,
      batId, assetId || null, 'Battery added', photos[0] || null, req.user.id, new Date().toISOString().slice(0, 10));
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
  res.json({
    battery,
    events,
    photos: photosOf(id),
    max_photos: MAX_PHOTOS,
    // The other battery on the same machine — a pair is fitted and replaced as a pair, so
    // whoever is looking at one needs to see the other.
    on_same_vehicle: battery.current_asset_id
      ? all(`SELECT id, serial_no, brand, capacity_ah, state, warranty_date FROM batteries
              WHERE current_asset_id = ? AND id <> ? ORDER BY serial_no`, battery.current_asset_id, id)
      : [],
    max_per_vehicle: MAX_PER_VEHICLE,
  });
}));

// Add one or several photos to a battery (no lifecycle event).
router.post('/:id/photos', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM batteries WHERE id = ?', id)) return res.status(404).json({ error: 'Battery not found' });
  const photos = (Array.isArray(req.body.photos) ? req.body.photos : [req.body.photo_path]).filter(Boolean);
  if (!photos.length) return res.status(400).json({ error: 'No photo given' });
  const err = addPhotos(id, photos, req.user.id, req.body.note);
  if (err) return res.status(err.status).json({ error: err.error });
  audit.record({ userId: req.user.id, entity: 'battery', entityId: id, action: 'add_photos', after: { added: photos.length } });
  res.status(201).json(photosOf(id));
}));

router.delete('/:id/photos/:photoId', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const p = get('SELECT * FROM battery_photos WHERE id = ? AND battery_id = ?', toInt(req.params.photoId), id);
  if (!p) return res.status(404).json({ error: 'Photo not found' });
  tx(() => {
    run('DELETE FROM battery_photos WHERE id = ?', p.id);
    // Close the gap so "photo 3 of 5" keeps meaning what it says.
    all('SELECT id FROM battery_photos WHERE battery_id = ? ORDER BY seq, id', id)
      .forEach((row, i) => run('UPDATE battery_photos SET seq = ? WHERE id = ?', i + 1, row.id));
    syncCoverPhoto(id);
  });
  audit.record({ userId: req.user.id, entity: 'battery', entityId: id, action: 'delete_photo' });
  res.json(photosOf(id));
}));

// Legacy single-photo endpoint, kept working: a photo is added to the gallery, and clearing
// still clears — which now means removing every photo, as it did when there could only be one.
router.patch('/:id/photo', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM batteries WHERE id = ?', id)) return res.status(404).json({ error: 'Battery not found' });
  const p = req.body.photo_path;
  if (!p) {
    tx(() => { run('DELETE FROM battery_photos WHERE battery_id = ?', id); syncCoverPhoto(id); });
    audit.record({ userId: req.user.id, entity: 'battery', entityId: id, action: 'clear_photo' });
    return res.json(get('SELECT * FROM batteries WHERE id = ?', id));
  }
  const err = addPhotos(id, [p], req.user.id);
  if (err) return res.status(err.status).json({ error: err.error });
  audit.record({ userId: req.user.id, entity: 'battery', entityId: id, action: 'set_photo' });
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
  // Two to a vehicle. The battery being moved does not count against its own destination, so
  // re-seating one already on that vehicle is never blocked by itself.
  if (b.event_type === 'install' || b.event_type === 'transfer') {
    const full = vehicleFullError(toAssetId, id);
    if (full) return res.status(full.status).json({ error: full.error });
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
