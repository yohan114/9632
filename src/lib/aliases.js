'use strict';

// ===========================================================================
// The learning alias resolver — the single most important glue in WorkshopOne.
// Any raw text a user or import throws at it resolves to ONE canonical asset:
//   1. exact match on code_norm
//   2. match on the alias table (previously resolved)
//   3. otherwise queue a PENDING alias for a human to link — never lose it.
// Every resolved link bumps hit_count so common variants auto-resolve next time.
// ===========================================================================

const { get, run } = require('../db');

/**
 * Normalise any asset/vehicle string to a comparable key: uppercase, keep only
 * A-Z and 0-9. "28-4314" -> "284314"; "SL-08, Waker (HC401199)" -> "SL08WAKERHC401199".
 */
function normalize(text) {
  if (text === null || text === undefined) return '';
  return String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Try to pull a plausible asset code out of a messy string, e.g.
 * "28-4314 Double Cab" -> "28-4314". Returns the raw token or null.
 */
function extractCode(text) {
  if (!text) return null;
  const m = String(text).match(/\b\d{1,3}[- ]?\d{2,5}\b|\b[A-Z]{1,3}[- ]?\d{2,6}\b/i);
  return m ? m[0] : null;
}

function bumpAlias(rawNorm, rawText, assetId, resolved, source) {
  const existing = get('SELECT id, hit_count FROM asset_aliases WHERE raw_norm = ?', rawNorm);
  if (existing) {
    run(
      `UPDATE asset_aliases
         SET hit_count = hit_count + 1,
             asset_id = COALESCE(?, asset_id),
             resolved = MAX(resolved, ?),
             updated_at = datetime('now')
       WHERE id = ?`,
      assetId, resolved ? 1 : 0, existing.id
    );
    return existing.id;
  }
  const info = run(
    `INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source)
     VALUES (?, ?, ?, ?, 1, ?)`,
    rawText, rawNorm, assetId || null, resolved ? 1 : 0, source || null
  );
  return info.lastInsertRowid;
}

/**
 * Resolve raw text to an asset id, learning as it goes.
 * @returns {{assetId:number|null, aliasId:number, resolved:boolean, via:string}}
 */
function resolveAsset(rawText, opts = {}) {
  const source = opts.source || null;
  const norm = normalize(rawText);
  if (!norm) return { assetId: null, aliasId: null, resolved: false, via: 'empty' };

  // 1. exact match on canonical code_norm
  let asset = get('SELECT id FROM assets WHERE code_norm = ?', norm);
  if (asset) {
    const aliasId = bumpAlias(norm, rawText, asset.id, true, source);
    return { assetId: asset.id, aliasId, resolved: true, via: 'code_norm' };
  }

  // 2. previously-resolved alias
  const alias = get('SELECT id, asset_id, resolved FROM asset_aliases WHERE raw_norm = ?', norm);
  if (alias && alias.resolved && alias.asset_id) {
    bumpAlias(norm, rawText, alias.asset_id, true, source);
    return { assetId: alias.asset_id, aliasId: alias.id, resolved: true, via: 'alias' };
  }

  // 2b. try an extracted code token (e.g. "28-4314 Double Cab")
  const token = extractCode(rawText);
  if (token) {
    const tokenNorm = normalize(token);
    if (tokenNorm && tokenNorm !== norm) {
      asset = get('SELECT id FROM assets WHERE code_norm = ?', tokenNorm);
      if (asset) {
        const aliasId = bumpAlias(norm, rawText, asset.id, true, source);
        return { assetId: asset.id, aliasId, resolved: true, via: 'extracted_code' };
      }
    }
  }

  // 3. queue a pending alias for a human to link — never lost
  const aliasId = bumpAlias(norm, rawText, null, false, source);
  return { assetId: null, aliasId, resolved: false, via: 'pending' };
}

/** Link a pending alias to an asset (a human's decision). Auto-resolves next time. */
function linkAlias(aliasId, assetId) {
  run(
    `UPDATE asset_aliases
       SET asset_id = ?, resolved = 1, hit_count = hit_count + 1, updated_at = datetime('now')
     WHERE id = ?`,
    assetId, aliasId
  );
  return get('SELECT * FROM asset_aliases WHERE id = ?', aliasId);
}

/** All aliases still awaiting a human link. */
function pendingAliases() {
  return require('../db').all(
    'SELECT * FROM asset_aliases WHERE resolved = 0 ORDER BY hit_count DESC, updated_at DESC'
  );
}

/**
 * Find an asset by any code, creating it if missing (used by import/seed and
 * "create on the fly" flows). Returns the asset row.
 */
function findOrCreateAsset(code, extra = {}) {
  const norm = normalize(code);
  let asset = get('SELECT * FROM assets WHERE code_norm = ?', norm);
  if (asset) return asset;
  const info = run(
    `INSERT INTO assets (code, code_norm, brand, type, asset_class, home_project_id, current_project_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    extra.code || code,
    norm,
    extra.brand || null,
    extra.type || null,
    extra.asset_class || 'vehicle',
    extra.home_project_id || null,
    extra.current_project_id || extra.home_project_id || null,
    extra.status || 'active'
  );
  return get('SELECT * FROM assets WHERE id = ?', info.lastInsertRowid);
}

module.exports = {
  normalize,
  extractCode,
  resolveAsset,
  linkAlias,
  pendingAliases,
  findOrCreateAsset,
};
