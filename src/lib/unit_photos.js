'use strict';

// Photographs of a battery or a tyre — the serial plate, its condition, the damage behind a warranty
// claim. Stored as resized base64 data URLs like the e-signatures, so they travel with the backups.
// Up to six a unit; the first is the unit's cover (photo_path), kept in step here, never set alone.
// (Moved out of src/routes/batteries.js in the stores plan, Part 4, so tyres share it.)

const { get, all, run, tx } = require('../db');

const MAX_PHOTOS = 6;
const T = {
  battery: { photos: 'battery_photos', unit: 'batteries', col: 'battery_id', name: 'A battery' },
  tyre: { photos: 'tyre_photos', unit: 'tyres', col: 'tyre_id', name: 'A tyre' },
};

const PHOTO_RE = /^data:image\/(png|jpe?g|webp);base64,/;
function photoError(p) {
  if (!p) return null;
  if (!PHOTO_RE.test(String(p))) return { status: 400, error: 'Photo must be a PNG, JPEG or WebP image' };
  if (String(p).length > 900000) return { status: 413, error: 'Image too large — please choose a smaller photo (max ~700 KB)' };
  return null;
}

/** Photos are the record; the unit's photo_path is the cover, rebuilt from them. */
function syncCover(kind, unitId) {
  const t = T[kind];
  const first = get(`SELECT photo FROM ${t.photos} WHERE ${t.col} = ? ORDER BY seq, id LIMIT 1`, unitId);
  run(`UPDATE ${t.unit} SET photo_path = ? WHERE id = ?`, first ? first.photo : null, unitId);
}

/** Add photos; returns null, or { status, error } when refused. */
function add(kind, unitId, photos, userId, note) {
  const t = T[kind];
  const have = get(`SELECT COUNT(*) c FROM ${t.photos} WHERE ${t.col} = ?`, unitId).c;
  if (have + photos.length > MAX_PHOTOS) {
    return { status: 409,
      error: `${t.name} holds at most ${MAX_PHOTOS} photos — it has ${have}, so ${MAX_PHOTOS - have} more can be added.` };
  }
  for (const p of photos) { const e = photoError(p); if (e) return e; }
  tx(() => {
    let seq = (get(`SELECT MAX(seq) m FROM ${t.photos} WHERE ${t.col} = ?`, unitId).m || 0);
    for (const p of photos) {
      run(`INSERT INTO ${t.photos} (${t.col}, seq, photo, note, uploaded_by) VALUES (?, ?, ?, ?, ?)`, unitId, ++seq, p, note || null, userId || null);
    }
    syncCover(kind, unitId);
  });
  return null;
}

/** Remove one photo and close the gap, so "photo 3 of 5" keeps meaning what it says. */
function remove(kind, unitId, photoId) {
  const t = T[kind];
  const p = get(`SELECT id FROM ${t.photos} WHERE id = ? AND ${t.col} = ?`, photoId, unitId);
  if (!p) return false;
  tx(() => {
    run(`DELETE FROM ${t.photos} WHERE id = ?`, p.id);
    all(`SELECT id FROM ${t.photos} WHERE ${t.col} = ? ORDER BY seq, id`, unitId)
      .forEach((row, i) => run(`UPDATE ${t.photos} SET seq = ? WHERE id = ?`, i + 1, row.id));
    syncCover(kind, unitId);
  });
  return true;
}

const list = (kind, unitId) => all(
  `SELECT p.id, p.seq, p.photo, p.note, p.uploaded_at, u.username AS uploaded_by_name
     FROM ${T[kind].photos} p LEFT JOIN users u ON u.id = p.uploaded_by
    WHERE p.${T[kind].col} = ? ORDER BY p.seq, p.id`, unitId);

module.exports = { MAX_PHOTOS, photoError, syncCover, add, remove, list };
