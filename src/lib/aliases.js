'use strict';

// ===========================================================================
// The learning alias resolver — the single most important glue in WorkshopOne.
// Any raw text a user or import throws at it resolves to ONE canonical asset:
//   1. exact match on code_norm
//   2. match on the alias table (previously resolved)
//   3. otherwise queue a PENDING alias for a human to link — never lose it.
// Every resolved link bumps hit_count so common variants auto-resolve next time.
// ===========================================================================

const { get, all, run } = require('../db');

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

/** Link a pending alias to an asset (a human's decision). Auto-resolves next time and cascades to unallocated records. */
function linkAlias(aliasId, assetId) {
  const existing = get('SELECT * FROM asset_aliases WHERE id = ?', aliasId);
  run(
    `UPDATE asset_aliases
       SET asset_id = ?, resolved = 1, hit_count = hit_count + 1, updated_at = datetime('now')
     WHERE id = ?`,
    assetId, aliasId
  );

  // Retroactive cascade linking:
  if (existing && existing.raw_text) {
    const raw = String(existing.raw_text).trim();
    const norm = existing.raw_norm;
    try {
      // 1. service_jobs with matching vehicle_label where asset_id is missing
      run('UPDATE service_jobs SET asset_id = ? WHERE asset_id IS NULL AND (vehicle_label = ? OR vehicle_label = ?)', assetId, raw, norm);
      // 2. job_daily_work with matching vehicle
      run('UPDATE job_daily_work SET asset_id = ? WHERE asset_id IS NULL AND (vehicle = ? OR vehicle = ?)', assetId, raw, norm);
      // 3. issues with matching description/purpose
      run('UPDATE issues SET asset_id = ? WHERE asset_id IS NULL AND (purpose = ? OR purpose LIKE ?)', assetId, raw, '%' + raw + '%');
      // 4. job_requests where asset is missing and description matches
      run('UPDATE job_requests SET asset_id = ? WHERE asset_id IS NULL AND (description LIKE ? OR description LIKE ?)', assetId, '%' + raw + '%', '%' + norm + '%');
    } catch (e) {
      // Best effort cascade
    }
  }

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

/**
 * Shared query helper for alias queues (vehicles and mechanics).
 * Keeps sorting, filtering, and pagination unified across entities.
 */
function queryAliasQueue(opts = {}) {
  const {
    table = 'asset_aliases',
    targetTable = 'assets',
    targetIdCol = 'asset_id',
    targetNameCol = 'code',
    targetAlias = 'asset_code',
    resolved,
    q,
    limit = 500,
    source
  } = opts;
  const clauses = [];
  const params = [];
  if (resolved !== undefined && resolved !== null && resolved !== '') {
    clauses.push('al.resolved = ?');
    params.push(Number(resolved) ? 1 : 0);
  }
  if (source && String(source).trim()) {
    clauses.push('al.source = ?');
    params.push(String(source).trim());
  }
  if (q && String(q).trim()) {
    clauses.push('al.raw_text LIKE ?');
    params.push('%' + String(q).trim() + '%');
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = `SELECT al.*, tgt.${targetNameCol} AS ${targetAlias} FROM ${table} al
     LEFT JOIN ${targetTable} tgt ON tgt.id = al.${targetIdCol}
     ${where}
    ORDER BY al.resolved ASC, al.updated_at DESC, al.hit_count DESC
    LIMIT ${Number(limit) || 500}`;
  return all(sql, ...params);
}

/**
 * Comprehensive audit of missing vehicle allocations across jobs, job requests, services, issues, and MRN.
 */
function getMissingAllocations() {
  const missingJobs = all(`
    SELECT j.id, j.job_no, j.type, j.description, j.status, j.site, j.requested_at, j.workshop_id,
           COALESCE(w.name, 'Default Workshop') AS workshop_name
      FROM job_cards j
      LEFT JOIN workshops w ON w.id = j.workshop_id
     WHERE j.asset_id IS NULL
     ORDER BY j.id DESC
     LIMIT 200
  `);

  const missingJobRequests = all(`
    SELECT r.id, r.jr_no, r.req_date, r.type, r.description, r.approval_status, r.requested_by, r.workshop_id,
           COALESCE(w.name, 'Central Workshop') AS workshop_name
      FROM job_requests r
      LEFT JOIN workshops w ON w.id = r.workshop_id
     WHERE r.asset_id IS NULL
     ORDER BY r.id DESC
     LIMIT 200
  `);

  const missingServices = all(`
    SELECT s.id, s.service_date, s.vehicle_label, s.service_type, s.site_location, s.repair_details,
           s.parts_subtotal, s.labour_charge, s.grand_total, s.workshop_id,
           COALESCE(w.name, 'Central Workshop') AS workshop_name
      FROM service_jobs s
      LEFT JOIN workshops w ON w.id = s.workshop_id
     WHERE s.asset_id IS NULL
     ORDER BY s.id DESC
     LIMIT 200
  `);

  const missingIssues = all(`
    SELECT i.id, i.issue_date, i.description, i.qty, i.unit, i.purpose, i.min_no, i.chain_no,
           i.store_id, COALESCE(w.name, 'Central Stores') AS store_name
      FROM issues i
      LEFT JOIN workshops w ON w.id = i.store_id
     WHERE i.asset_id IS NULL
     ORDER BY i.id DESC
     LIMIT 200
  `);

  const missingMrn = all(`
    SELECT m.id, m.mrn_no, m.req_date, m.purpose, m.requested_by, m.status, m.workshop_id,
           COALESCE(w.name, 'Central Workshop') AS workshop_name
      FROM mrn m
      LEFT JOIN workshops w ON w.id = m.workshop_id
     WHERE m.asset_id IS NULL
     ORDER BY m.id DESC
     LIMIT 200
  `);

  const aliasSections = all(`
    SELECT COALESCE(source, 'general') AS section, COUNT(*) AS count
      FROM asset_aliases
     WHERE resolved = 0
     GROUP BY source
     ORDER BY count DESC
  `);

  return {
    missingJobs,
    missingJobRequests,
    missingServices,
    missingIssues,
    missingMrn,
    aliasSections,
    counts: {
      jobs: missingJobs.length,
      jobRequests: missingJobRequests.length,
      services: missingServices.length,
      issues: missingIssues.length,
      mrn: missingMrn.length,
      totalMissing: missingJobs.length + missingJobRequests.length + missingServices.length + missingIssues.length + missingMrn.length
    }
  };
}

module.exports = {
  normalize,
  extractCode,
  resolveAsset,
  bumpAlias,
  linkAlias,
  pendingAliases,
  findOrCreateAsset,
  queryAliasQueue,
  getMissingAllocations,
};

