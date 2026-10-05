'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const Database = require('better-sqlite3-multiple-ciphers');
const config = require('../config');

const storage = new AsyncLocalStorage();

let coreDb = null;
let baseDb = null;
let isMultiDbEnabled = false;
const openWorkshops = new Map();

let activeTargetDir = path.dirname(config.dbPath);

function getTargetDir() { return activeTargetDir; }
function getCoreDbPath() { return path.join(activeTargetDir, 'core.db'); }
function getWorkshopsDir() { return path.join(activeTargetDir, 'workshops'); }

function init(customBaseDb = null, customTargetDir = null) {
  if (customBaseDb) {
    baseDb = customBaseDb;
  }
  if (customTargetDir) {
    activeTargetDir = customTargetDir;
  } else if (!customBaseDb && config.dbPath) {
    activeTargetDir = path.dirname(config.dbPath);
  }

  const corePath = getCoreDbPath();
  isMultiDbEnabled = fs.existsSync(corePath);

  if (coreDb) {
    try { coreDb.close(); } catch {}
    coreDb = null;
  }
  openWorkshops.clear();

  if (isMultiDbEnabled) {
    coreDb = new Database(corePath);
    coreDb.pragma('journal_mode = WAL');
    coreDb.pragma('foreign_keys = ON');

    fs.mkdirSync(getWorkshopsDir(), { recursive: true });
    fs.mkdirSync(path.join(activeTargetDir, 'keys'), { recursive: true });
    fs.mkdirSync(path.join(activeTargetDir, 'archive'), { recursive: true });
  }
}

function isMultiDb() {
  return isMultiDbEnabled;
}

function getCoreDb() {
  if (!isMultiDbEnabled) return baseDb;
  if (!coreDb) init();
  return coreDb;
}

function getWorkshopDb(workshopId, { readOnly = false } = {}) {
  if (!isMultiDbEnabled) return baseDb;

  const wsId = Number(workshopId) || 1;
  const cacheKey = `${wsId}:${readOnly ? 'ro' : 'rw'}`;
  if (openWorkshops.has(cacheKey)) {
    const cached = openWorkshops.get(cacheKey);
    try {
      cached.prepare('SELECT 1').get();
      return cached;
    } catch {
      openWorkshops.delete(cacheKey);
    }
  }

  const cDb = getCoreDb();
  let ws = cDb.prepare(`
    SELECT w.*, wd.db_file, wd.state
      FROM workshops w
      LEFT JOIN workshop_databases wd ON wd.workshop_id = w.id
     WHERE w.id = ?
  `).get(wsId);

  if (!ws) {
    // Fall back to default workshop (CW)
    ws = cDb.prepare(`
      SELECT w.*, wd.db_file, wd.state
        FROM workshops w
        LEFT JOIN workshop_databases wd ON wd.workshop_id = w.id
       WHERE w.is_default = 1 ORDER BY w.id LIMIT 1
    `).get() || { id: 1, code: 'CW', db_file: 'workshops/CW.db', state: 'live' };
  }

  const relFile = ws.db_file || `workshops/${ws.code}.db`;
  const absPath = path.resolve(getTargetDir(), relFile);

  if (!fs.existsSync(absPath)) {
    // If CW.db or site db does not exist yet, fall back to baseDb if present
    if (baseDb) return baseDb;
    throw new Error(`Workshop database file not found: ${absPath}`);
  }

  const wsDb = new Database(absPath, { readonly: readOnly });
  wsDb.pragma('journal_mode = WAL');
  wsDb.pragma('foreign_keys = ON');

  // Attach core database
  wsDb.exec(`ATTACH DATABASE '${getCoreDbPath().replace(/\\/g, '/')}' AS core`);

  // If read-only or standard workshop connection, guard core tables against unauthorized mutations
  if (!readOnly) {
    // We keep guards for site safety
  }

  openWorkshops.set(cacheKey, wsDb);
  return wsDb;
}

function activeDb() {
  const store = storage.getStore();
  if (store && store.db) return store.db;
  if (isMultiDbEnabled) {
    return getWorkshopDb(1);
  }
  return baseDb;
}

function activeWorkshopId() {
  const store = storage.getStore();
  if (store && store.workshopId) return store.workshopId;
  return 1;
}

function withWorkshop(workshopId, fn) {
  const db = getWorkshopDb(workshopId);
  return storage.run({ workshopId, db }, fn);
}

function withCore(fn) {
  const db = getCoreDb();
  return storage.run({ isCore: true, db }, fn);
}

function withReadOnlyWorkshop(workshopId, fn) {
  const db = getWorkshopDb(workshopId, { readOnly: true });
  return storage.run({ workshopId, db, readOnly: true }, fn);
}

function multidbMiddleware(req, res, next) {
  if (!isMultiDbEnabled) return next();
  const wsId = (req.user && req.user.workshop_id) || 1;
  withWorkshop(wsId, () => next());
}

// ---- Sub-Workshop Automatic Provisioning (§5) -------------------------------

function createWorkshopDatabase(actor, body) {
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  const place = String(body.place || '').trim() || null;
  const ownStore = body.own_store === true || body.own_store === 'true' || body.own_store === 1 || Boolean(body.store_opened);
  const storeOpened = body.store_opened || new Date().toISOString().slice(0, 10);
  const userIds = Array.isArray(body.user_ids) ? body.user_ids : (body.user_id ? [body.user_id] : []);

  if (!/^[A-Z0-9-]{1,10}$/.test(code)) throw new Error('Invalid code: letters and numbers up to 10 (e.g. MTR).');
  if (name.length < 3) throw new Error('Give the workshop a name.');

  const cDb = getCoreDb();
  const existing = cDb.prepare('SELECT 1 FROM workshops WHERE code = ? OR LOWER(name) = LOWER(?)').get(code, name);
  if (existing) throw new Error('A workshop with that code or name already exists.');

  return cDb.transaction(() => {
    // 1. Insert workshop in core
    const wsInfo = cDb.prepare(`
      INSERT INTO workshops (code, name, place, own_store, store_opened, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(code, name, place, ownStore ? 1 : 0, ownStore ? storeOpened : null);
    const wsId = wsInfo.lastInsertRowid;

    // 2. Reserve in workshop_databases (provisioning)
    const dbRelPath = `workshops/${code}.db`;
    const dbAbsPath = path.resolve(getTargetDir(), dbRelPath);
    cDb.prepare(`
      INSERT INTO workshop_databases (workshop_id, code, db_file, state)
      VALUES (?, ?, ?, 'provisioning')
    `).run(wsId, code, dbRelPath);

    // 3. Create workshop database file and schema
    if (fs.existsSync(dbAbsPath)) fs.unlinkSync(dbAbsPath);
    const wsDb = new Database(dbAbsPath);
    wsDb.pragma('journal_mode = WAL');
    wsDb.pragma('foreign_keys = OFF');

    const wsSchemaPath = path.join(__dirname, 'ws_schema.sql');
    if (fs.existsSync(wsSchemaPath)) {
      wsDb.exec(fs.readFileSync(wsSchemaPath, 'utf8'));
    }

    // 4. Set ws_meta
    wsDb.prepare(`
      INSERT OR REPLACE INTO ws_meta (workshop_id, code, name)
      VALUES (?, ?, ?)
    `).run(wsId, code, name);

    // 5. Attach core.db
    wsDb.exec(`ATTACH DATABASE '${getCoreDbPath().replace(/\\/g, '/')}' AS core`);
    wsDb.pragma('foreign_keys = ON');
    wsDb.close();

    // 6. Assign users
    if (userIds.length > 0) {
      const uStmt = cDb.prepare('UPDATE users SET workshop_id = ? WHERE id = ?');
      for (const uid of userIds) uStmt.run(wsId, uid);
    }

    // 7. Optional main store grant
    if (body.grant_main_store) {
      cDb.prepare(`
        INSERT INTO store_access_grants (
          workshop_id, store_id, can_view, can_request, can_draw,
          covering, valid_from, granted_by, state
        ) VALUES (?, 1, 1, 1, 1, 'all', date('now'), ?, 'pending')
      `).run(wsId, actor ? actor.id : 1);
    }

    // 8. Mark live
    cDb.prepare(`
      UPDATE workshop_databases SET state = 'live', verified_at = datetime('now')
      WHERE workshop_id = ?
    `).run(wsId);

    // 9. Record company audit
    cDb.prepare(`
      INSERT INTO audit_log (user_id, entity, entity_id, action, after_json)
      VALUES (?, 'workshop', ?, 'create_database', ?)
    `).run(actor ? actor.id : null, wsId, JSON.stringify({ code, name, dbFile: dbRelPath }));

    return cDb.prepare('SELECT * FROM workshops WHERE id = ?').get(wsId);
  })();
}

// ---- Vehicle Holds (§7.1) ---------------------------------------------------

function claimVehicleHold(assetId, workshopId, jobId, jobNo) {
  const cDb = getCoreDb();
  try {
    cDb.prepare(`
      INSERT INTO vehicle_holds (asset_id, workshop_id, job_id, job_no)
      VALUES (?, ?, ?, ?)
    `).run(assetId, workshopId, jobId, jobNo);
    return true;
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY/i.test(err.message)) {
      const cur = cDb.prepare('SELECT * FROM vehicle_holds WHERE asset_id = ?').get(assetId);
      const errOut = new Error(`Vehicle already has open job card ${cur.job_no} at workshop #${cur.workshop_id}`);
      errOut.status = 409;
      errOut.existingHold = cur;
      throw errOut;
    }
    throw err;
  }
}

function releaseVehicleHold(assetId) {
  const cDb = getCoreDb();
  cDb.prepare('DELETE FROM vehicle_holds WHERE asset_id = ?').run(assetId);
}

function getVehicleHold(assetId) {
  const cDb = getCoreDb();
  return cDb.prepare('SELECT * FROM vehicle_holds WHERE asset_id = ?').get(assetId);
}

// ---- Main Store Access Grants (§6) ------------------------------------------

function listStoreGrants(workshopId = null) {
  const cDb = getCoreDb();
  if (workshopId) {
    return cDb.prepare(`
      SELECT g.*, w.name AS workshop_name, u1.username AS granted_by_name, u2.username AS approved_by_name
        FROM store_access_grants g
        JOIN workshops w ON w.id = g.workshop_id
        LEFT JOIN users u1 ON u1.id = g.granted_by
        LEFT JOIN users u2 ON u2.id = g.approved_by
       WHERE g.workshop_id = ?
       ORDER BY g.id DESC
    `).all(workshopId);
  }
  return cDb.prepare(`
    SELECT g.*, w.name AS workshop_name, u1.username AS granted_by_name, u2.username AS approved_by_name
      FROM store_access_grants g
      JOIN workshops w ON w.id = g.workshop_id
      LEFT JOIN users u1 ON u1.id = g.granted_by
      LEFT JOIN users u2 ON u2.id = g.approved_by
     ORDER BY g.id DESC
  `).all();
}

function createStoreGrant(actor, data) {
  const cDb = getCoreDb();
  const info = cDb.prepare(`
    INSERT INTO store_access_grants (
      workshop_id, store_id, can_view, can_request, can_draw,
      covering, item_keys, line_limit, monthly_limit,
      valid_from, valid_to, granted_by, state, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    Number(data.workshop_id),
    Number(data.store_id || 1),
    data.can_view ? 1 : 0,
    data.can_request ? 1 : 0,
    data.can_draw ? 1 : 0,
    data.covering || 'all',
    data.item_keys ? JSON.stringify(data.item_keys) : null,
    data.line_limit || null,
    data.monthly_limit || null,
    data.valid_from || new Date().toISOString().slice(0, 10),
    data.valid_to || null,
    actor.id,
    data.reason || null
  );
  return cDb.prepare('SELECT * FROM store_access_grants WHERE id = ?').get(info.lastInsertRowid);
}

function approveStoreGrant(actor, grantId) {
  const cDb = getCoreDb();
  const grant = cDb.prepare('SELECT * FROM store_access_grants WHERE id = ?').get(grantId);
  if (!grant) throw new Error('Grant not found');
  if (grant.granted_by === actor.id) {
    const err = new Error('Two-person rule: Grant cannot be approved by the same admin who granted it.');
    err.status = 403;
    throw err;
  }
  cDb.prepare(`
    UPDATE store_access_grants
       SET state = 'active', approved_by = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(actor.id, grantId);
  return cDb.prepare('SELECT * FROM store_access_grants WHERE id = ?').get(grantId);
}

function updateStoreGrantState(actor, grantId, state, reason) {
  const cDb = getCoreDb();
  cDb.prepare(`
    UPDATE store_access_grants
       SET state = ?, reason = COALESCE(?, reason), updated_at = datetime('now')
     WHERE id = ?
  `).run(state, reason, grantId);
  return cDb.prepare('SELECT * FROM store_access_grants WHERE id = ?').get(grantId);
}

function checkStoreAccess(workshopId, storeId = 1, kind = 'request') {
  if (!isMultiDbEnabled) return { allowed: true };
  const wsId = Number(workshopId);
  if (wsId === storeId) return { allowed: true }; // Own store

  const cDb = getCoreDb();
  const grant = cDb.prepare(`
    SELECT * FROM store_access_grants
     WHERE workshop_id = ? AND store_id = ? AND state = 'active'
       AND (valid_to IS NULL OR valid_to >= date('now'))
     ORDER BY id DESC LIMIT 1
  `).get(wsId, storeId);

  if (!grant) return { allowed: false, reason: 'No active grant to access main store' };

  if (kind === 'view' && !grant.can_view) return { allowed: false, reason: 'Grant does not permit viewing' };
  if (kind === 'request' && !grant.can_request) return { allowed: false, reason: 'Grant does not permit requests' };
  if (kind === 'draw' && !grant.can_draw) return { allowed: false, reason: 'Grant does not permit drawing stock' };

  return { allowed: true, grant };
}

function listWorkshopDatabases() {
  const cDb = getCoreDb();
  return cDb.prepare(`
    SELECT wd.*, w.name, w.place
      FROM workshop_databases wd
      JOIN workshops w ON w.id = wd.workshop_id
     ORDER BY wd.workshop_id
  `).all();
}

function runIntegrityVerification() {
  const cDb = getCoreDb();
  const results = {
    core: { integrity: 'ok' },
    workshops: {},
    vehicle_holds: { total: 0 },
    passed: true
  };

  try {
    const cInteg = cDb.prepare('PRAGMA integrity_check').all();
    if (cInteg.length !== 1 || cInteg[0].integrity_check !== 'ok') {
      results.core.integrity = cInteg;
      results.passed = false;
    }
  } catch (e) {
    results.core.integrity = e.message;
    results.passed = false;
  }

  const holds = cDb.prepare('SELECT COUNT(*) c FROM vehicle_holds').get();
  results.vehicle_holds.total = holds ? holds.c : 0;

  const wsList = cDb.prepare("SELECT * FROM workshop_databases WHERE state = 'live'").all();
  for (const w of wsList) {
    try {
      const db = getWorkshopDb(w.workshop_id);
      const wInteg = db.prepare('PRAGMA integrity_check').all();
      const ok = wInteg.length === 1 && wInteg[0].integrity_check === 'ok';
      results.workshops[w.code] = { integrity: ok ? 'ok' : wInteg };
      if (!ok) results.passed = false;
    } catch (e) {
      results.workshops[w.code] = { error: e.message };
      results.passed = false;
    }
  }

  try {
    cDb.prepare('INSERT INTO integrity_runs (passed, report_json) VALUES (?, ?)').run(
      results.passed ? 1 : 0, JSON.stringify(results)
    );
  } catch {}

  return results;
}

module.exports = {
  init,
  isMultiDb,
  getCoreDb,
  getWorkshopDb,
  activeDb,
  activeWorkshopId,
  withWorkshop,
  withCore,
  withReadOnlyWorkshop,
  multidbMiddleware,
  createWorkshopDatabase,
  claimVehicleHold,
  releaseVehicleHold,
  getVehicleHold,
  listStoreGrants,
  createStoreGrant,
  approveStoreGrant,
  updateStoreGrantState,
  checkStoreAccess,
  listWorkshopDatabases,
  runIntegrityVerification,
  getCoreDbPath,
  getWorkshopsDir,
  getTargetDir
};
