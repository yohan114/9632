'use strict';

/**
 * ===========================================================================
 * Physical Store Locations & Central Hierarchy Engine (Plan Revision 2, Phase 1)
 *
 * Implements:
 * 1. Physical store-location master:
 *    MAIN STORES
 *    ├── SITE STORES (Site Store A, B, C...)
 *    └── MAIN WORKSHOP STORES
 *        └── SITE WORKSHOP STORES (Site Workshop Store A, B, C...)
 * 2. Hierarchy validation & cycle prevention.
 * 3. Store location access grants per user.
 * 4. Legacy store ID & workshop bridge mapping (backward compatibility contract).
 * 5. Idempotent baseline seeding preserving existing stock balances.
 * ===========================================================================
 */

const db = require('../db');
const multidb = require('../db/multidb');

function getCoreHelper() {
  if (multidb && typeof multidb.isMultiDb === 'function' && multidb.isMultiDb()) {
    const core = multidb.getCoreDb();
    if (core) {
      return {
        get: (sql, ...p) => core.prepare(sql).get(...p),
        all: (sql, ...p) => core.prepare(sql).all(...p),
        run: (sql, ...p) => core.prepare(sql).run(...p),
        tx: (fn) => core.transaction(fn)()
      };
    }
  }
  return db;
}

const get = (sql, ...p) => getCoreHelper().get(sql, ...p);
const all = (sql, ...p) => getCoreHelper().all(sql, ...p);
const run = (sql, ...p) => getCoreHelper().run(sql, ...p);
const tx = (fn) => getCoreHelper().tx(fn);
const audit = require('./audit');

const STORE_TYPES = {
  MAIN_STORE: 'MAIN_STORE',
  SITE_STORE: 'SITE_STORE',
  MAIN_WORKSHOP_STORE: 'MAIN_WORKSHOP_STORE',
  SITE_WORKSHOP_STORE: 'SITE_WORKSHOP_STORE'
};

const STORE_TYPE_LABELS = {
  MAIN_STORE: 'Central Main Store',
  SITE_STORE: 'Site Store',
  MAIN_WORKSHOP_STORE: 'Main Workshop Store',
  SITE_WORKSHOP_STORE: 'Site Workshop Store'
};

/**
 * Validate physical store hierarchy rules.
 * Throws an Error with descriptive message if invalid.
 */
function validateHierarchy(storeType, parentStoreId, selfId = null, queryHelper = null) {
  const g = queryHelper ? queryHelper.get : get;

  if (!Object.values(STORE_TYPES).includes(storeType)) {
    throw new Error(`Invalid store_type '${storeType}'. Must be one of: ${Object.keys(STORE_TYPES).join(', ')}`);
  }

  // 1. Root rule: MAIN_STORE must have no parent
  if (storeType === STORE_TYPES.MAIN_STORE) {
    if (parentStoreId) {
      throw new Error('Central Main Store cannot have a parent store (it is the top central authority).');
    }
    return;
  }

  // 2. Child stores must have a parent
  if (!parentStoreId) {
    throw new Error(`${STORE_TYPE_LABELS[storeType]} must have a valid parent store.`);
  }

  // Prevent self-parenting
  if (selfId && Number(parentStoreId) === Number(selfId)) {
    throw new Error('A store location cannot be its own parent.');
  }

  const parent = g('SELECT id, code, name, store_type, active FROM store_locations WHERE id = ?', parentStoreId);
  if (!parent) {
    throw new Error(`Parent store ID ${parentStoreId} does not exist.`);
  }
  if (!parent.active) {
    throw new Error(`Parent store '${parent.name}' (${parent.code}) is inactive and cannot accept child stores.`);
  }

  // 3. Allowed parent-child relationships
  if (storeType === STORE_TYPES.SITE_STORE || storeType === STORE_TYPES.SITE_WORKSHOP_STORE) {
    if (parent.store_type !== STORE_TYPES.MAIN_STORE && parent.store_type !== STORE_TYPES.MAIN_WORKSHOP_STORE) {
      throw new Error(`Site Store parent must be a Central Main Store or Main Workshop Store, but '${parent.name}' is a ${STORE_TYPE_LABELS[parent.store_type]}.`);
    }
  } else if (storeType === STORE_TYPES.MAIN_WORKSHOP_STORE) {
    if (parent.store_type !== STORE_TYPES.MAIN_STORE) {
      throw new Error(`Main Workshop Store parent must be a Central Main Store for replenishment & purchasing authority, but '${parent.name}' is a ${STORE_TYPE_LABELS[parent.store_type]}.`);
    }
  }

  // 4. Cycle prevention: walk up ancestors
  if (selfId) {
    let curr = parentStoreId;
    const visited = new Set([Number(selfId)]);
    while (curr) {
      if (visited.has(Number(curr))) {
        throw new Error('Circular store hierarchy detected: a store cannot be an ancestor of itself.');
      }
      visited.add(Number(curr));
      const next = g('SELECT parent_store_id FROM store_locations WHERE id = ?', curr);
      curr = next ? next.parent_store_id : null;
    }
  }
}

/**
 * List physical store locations with parent, site, and workshop details.
 */
function listStoreLocations(options = {}) {
  const { activeOnly, type, parentStoreId, siteId, workshopId } = options;
  const where = [];
  const params = [];

  if (activeOnly) {
    where.push('sl.active = 1');
  }
  if (type) {
    where.push('sl.store_type = ?');
    params.push(type);
  }
  if (parentStoreId !== undefined) {
    if (parentStoreId === null) {
      where.push('sl.parent_store_id IS NULL');
    } else {
      where.push('sl.parent_store_id = ?');
      params.push(parentStoreId);
    }
  }
  if (siteId) {
    where.push('sl.site_id = ?');
    params.push(siteId);
  }
  if (workshopId) {
    where.push('sl.workshop_id = ?');
    params.push(workshopId);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const sql = `
    SELECT sl.*,
           p.name AS parent_store_name,
           p.code AS parent_store_code,
           w.name AS workshop_name,
           w.code AS workshop_code,
           s.name AS site_name,
           m.legacy_store_id
      FROM store_locations sl
      LEFT JOIN store_locations p ON p.id = sl.parent_store_id
      LEFT JOIN workshops w ON w.id = sl.workshop_id
      LEFT JOIN sites s ON s.id = sl.site_id
      LEFT JOIN store_location_mappings m ON m.store_location_id = sl.id
     ${whereClause}
     ORDER BY
       CASE sl.store_type
         WHEN 'MAIN_STORE' THEN 1
         WHEN 'MAIN_WORKSHOP_STORE' THEN 2
         WHEN 'SITE_STORE' THEN 3
         WHEN 'SITE_WORKSHOP_STORE' THEN 4
         ELSE 5
       END,
       sl.name ASC
  `;

  return all(sql, ...params);
}

/**
 * Get store location by ID.
 */
function getStoreLocationById(id) {
  if (!id) return null;
  const sql = `
    SELECT sl.*,
           p.name AS parent_store_name,
           p.code AS parent_store_code,
           w.name AS workshop_name,
           w.code AS workshop_code,
           s.name AS site_name,
           m.legacy_store_id
      FROM store_locations sl
      LEFT JOIN store_locations p ON p.id = sl.parent_store_id
      LEFT JOIN workshops w ON w.id = sl.workshop_id
      LEFT JOIN sites s ON s.id = sl.site_id
      LEFT JOIN store_location_mappings m ON m.store_location_id = sl.id
     WHERE sl.id = ?
  `;
  return get(sql, id) || null;
}

/**
 * Get store location by code (case-insensitive).
 */
function getStoreLocationByCode(code) {
  if (!code) return null;
  const sql = `
    SELECT sl.*,
           p.name AS parent_store_name,
           p.code AS parent_store_code,
           w.name AS workshop_name,
           w.code AS workshop_code,
           s.name AS site_name,
           m.legacy_store_id
      FROM store_locations sl
      LEFT JOIN store_locations p ON p.id = sl.parent_store_id
      LEFT JOIN workshops w ON w.id = sl.workshop_id
      LEFT JOIN sites s ON s.id = sl.site_id
      LEFT JOIN store_location_mappings m ON m.store_location_id = sl.id
     WHERE UPPER(sl.code) = UPPER(?)
  `;
  return get(sql, String(code).trim()) || null;
}

function ensureStoreMetaCols(targetDb = null) {
  const cols = [
    ['incharge_name', 'TEXT'],
    ['contact_phone', 'TEXT'],
    ['address', 'TEXT'],
    ['allow_direct_grn', 'INTEGER NOT NULL DEFAULT 0'],
    ['allow_direct_issue', 'INTEGER NOT NULL DEFAULT 1'],
  ];
  for (const [col, def] of cols) {
    try {
      const existing = targetDb
        ? targetDb.prepare('PRAGMA table_info(store_locations)').all()
        : all('PRAGMA table_info(store_locations)');
      if (existing.length && !existing.some((c) => c.name === col)) {
        const sql = `ALTER TABLE store_locations ADD COLUMN ${col} ${def}`;
        if (targetDb) targetDb.exec(sql);
        else run(sql);
      }
    } catch (_) {}
  }
}

/**
 * Create a new physical store location.
 */
function createStoreLocation(data, user = null) {
  ensureStoreMetaCols();
  const code = String(data.code || '').trim().toUpperCase();
  const name = String(data.name || '').trim();
  const storeType = String(data.store_type || data.storeType || '').trim();
  const parentStoreId = data.parent_store_id != null ? Number(data.parent_store_id) : null;
  const siteId = data.site_id != null ? Number(data.site_id) : null;
  const workshopId = data.workshop_id != null ? Number(data.workshop_id) : null;
  const isDefault = data.is_default ? 1 : 0;
  const openedAt = data.opened_at ? String(data.opened_at).trim() : null;
  const notes = data.notes ? String(data.notes).trim() : null;
  const inchargeName = data.incharge_name ? String(data.incharge_name).trim() : null;
  const contactPhone = data.contact_phone ? String(data.contact_phone).trim() : null;
  const address = data.address ? String(data.address).trim() : null;
  const allowDirectGrn = data.allow_direct_grn ? 1 : 0;
  const allowDirectIssue = data.allow_direct_issue !== undefined ? (data.allow_direct_issue ? 1 : 0) : 1;

  if (!code) throw new Error('Store location code is required.');
  if (!name) throw new Error('Store location name is required.');
  if (!storeType) throw new Error('Store type is required.');

  // Validate hierarchy rules
  validateHierarchy(storeType, parentStoreId, null);

  // Singleton rules: only one active MAIN_STORE and one active MAIN_WORKSHOP_STORE
  if (storeType === STORE_TYPES.MAIN_STORE) {
    const existing = get('SELECT id, name, code FROM store_locations WHERE store_type = ? AND active = 1', STORE_TYPES.MAIN_STORE);
    if (existing) {
      throw new Error(`An active Central Main Store already exists: '${existing.name}' (${existing.code}).`);
    }
  } else if (storeType === STORE_TYPES.MAIN_WORKSHOP_STORE) {
    const existing = get('SELECT id, name, code FROM store_locations WHERE store_type = ? AND active = 1', STORE_TYPES.MAIN_WORKSHOP_STORE);
    if (existing) {
      throw new Error(`An active Main Workshop Store already exists: '${existing.name}' (${existing.code}).`);
    }
  }

  // Ensure code uniqueness
  const dup = get('SELECT id FROM store_locations WHERE UPPER(code) = UPPER(?)', code);
  if (dup) {
    throw new Error(`A store location with code '${code}' already exists.`);
  }

  const newId = tx(() => {
    const info = run(`
      INSERT INTO store_locations (
        code, name, store_type, parent_store_id, site_id, workshop_id,
        active, is_default, opened_at, notes,
        incharge_name, contact_phone, address, allow_direct_grn, allow_direct_issue,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `, code, name, storeType, parentStoreId, siteId, workshopId, isDefault, openedAt, notes,
       inchargeName, contactPhone, address, allowDirectGrn, allowDirectIssue);

    const id = info.lastInsertRowid;

    // If linked to a workshop, establish legacy mapping if none exists for that workshop
    if (workshopId) {
      run(`
        INSERT OR IGNORE INTO store_location_mappings (legacy_store_id, workshop_id, store_location_id, is_primary, notes)
        VALUES (?, ?, ?, 1, 'Auto-mapped on creation')
      `, workshopId, workshopId, id);
    }

    return id;
  });

  if (audit && user) {
    try {
      audit.record({
        userId: user.id || null,
        entity: 'store_location',
        entityId: newId,
        action: 'create',
        after: { code, name, storeType, parentStoreId, workshopId, siteId, inchargeName, contactPhone, address, allowDirectGrn, allowDirectIssue }
      });
    } catch (_) {}
  }

  return getStoreLocationById(newId);
}

/**
 * Update an existing store location.
 */
function updateStoreLocation(id, data, user = null) {
  ensureStoreMetaCols();
  const store = get('SELECT * FROM store_locations WHERE id = ?', id);
  if (!store) throw new Error(`Store location ID ${id} not found.`);

  const name = data.name !== undefined ? String(data.name).trim() : store.name;
  const parentStoreId = data.parent_store_id !== undefined ? (data.parent_store_id ? Number(data.parent_store_id) : null) : store.parent_store_id;
  const siteId = data.site_id !== undefined ? (data.site_id ? Number(data.site_id) : null) : store.site_id;
  const workshopId = data.workshop_id !== undefined ? (data.workshop_id ? Number(data.workshop_id) : null) : store.workshop_id;
  const notes = data.notes !== undefined ? (data.notes ? String(data.notes).trim() : null) : store.notes;
  const isDefault = data.is_default !== undefined ? (data.is_default ? 1 : 0) : store.is_default;
  const active = data.active !== undefined ? (data.active ? 1 : 0) : store.active;
  const inchargeName = data.incharge_name !== undefined ? (data.incharge_name ? String(data.incharge_name).trim() : null) : store.incharge_name;
  const contactPhone = data.contact_phone !== undefined ? (data.contact_phone ? String(data.contact_phone).trim() : null) : store.contact_phone;
  const address = data.address !== undefined ? (data.address ? String(data.address).trim() : null) : store.address;
  const allowDirectGrn = data.allow_direct_grn !== undefined ? (data.allow_direct_grn ? 1 : 0) : (store.allow_direct_grn || 0);
  const allowDirectIssue = data.allow_direct_issue !== undefined ? (data.allow_direct_issue ? 1 : 0) : (store.allow_direct_issue != null ? store.allow_direct_issue : 1);

  if (!name) throw new Error('Store location name cannot be empty.');

  // Validate hierarchy with cycle checks
  validateHierarchy(store.store_type, parentStoreId, id);

  tx(() => {
    run(`
      UPDATE store_locations
         SET name = ?,
             parent_store_id = ?,
             site_id = ?,
             workshop_id = ?,
             notes = ?,
             is_default = ?,
             active = ?,
             incharge_name = ?,
             contact_phone = ?,
             address = ?,
             allow_direct_grn = ?,
             allow_direct_issue = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `, name, parentStoreId, siteId, workshopId, notes, isDefault, active,
       inchargeName, contactPhone, address, allowDirectGrn, allowDirectIssue, id);

    // Update legacy mapping if workshop changed
    if (workshopId && workshopId !== store.workshop_id) {
      run(`
        INSERT INTO store_location_mappings (legacy_store_id, workshop_id, store_location_id, is_primary)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(legacy_store_id) DO UPDATE SET store_location_id = excluded.store_location_id, workshop_id = excluded.workshop_id
      `, workshopId, workshopId, id);
    }
  });

  if (audit && user) {
    try {
      audit.record({
        userId: user.id || null,
        entity: 'store_location',
        entityId: id,
        action: 'update',
        before: store,
        after: { name, parentStoreId, siteId, workshopId, notes, isDefault, active, inchargeName, contactPhone, address, allowDirectGrn, allowDirectIssue }
      });
    } catch (_) {}
  }

  return getStoreLocationById(id);
}

/**
 * Retire a physical store location.
 */
function retireStoreLocation(id, user = null) {
  const store = get('SELECT * FROM store_locations WHERE id = ?', id);
  if (!store) throw new Error(`Store location ID ${id} not found.`);

  // Cannot retire if it has active child stores
  const activeChildren = all('SELECT id, name, code FROM store_locations WHERE parent_store_id = ? AND active = 1', id);
  if (activeChildren.length > 0) {
    const list = activeChildren.map((c) => `'${c.name}' (${c.code})`).join(', ');
    throw new Error(`Cannot retire store location: active child stores still depend on it: ${list}`);
  }

  tx(() => {
    run(`
      UPDATE store_locations
         SET active = 0,
             closed_at = date('now'),
             updated_at = datetime('now')
       WHERE id = ?
    `, id);
  });

  if (audit && user) {
    try {
      audit.record({
        userId: user.id || null,
        entity: 'store_location',
        entityId: id,
        action: 'retire',
        before: store,
        after: { active: 0, closed_at: new Date().toISOString() }
      });
    } catch (_) {}
  }

  return getStoreLocationById(id);
}

/**
 * Build complete store hierarchy tree for visual UI presentation.
 */
function getStoreHierarchyTree() {
  ensureStoreMetaCols();
  const allStores = listStoreLocations();

  const mainStore = allStores.find((s) => s.store_type === STORE_TYPES.MAIN_STORE && s.active);
  if (!mainStore) return { main_store: null, unlinked: allStores };

  const mainWorkshop = allStores.find((s) => s.store_type === STORE_TYPES.MAIN_WORKSHOP_STORE && s.active);

  // Child site stores directly under Central Main Store
  const directSiteStores = allStores.filter((s) =>
    s.active &&
    (s.store_type === STORE_TYPES.SITE_STORE || s.store_type === STORE_TYPES.SITE_WORKSHOP_STORE) &&
    (!mainWorkshop || Number(s.parent_store_id) !== Number(mainWorkshop.id))
  );

  // Child site/workshop stores parented under Central Main Workshop Store
  const workshopChildStores = mainWorkshop
    ? allStores.filter((s) =>
        s.active &&
        (s.store_type === STORE_TYPES.SITE_STORE || s.store_type === STORE_TYPES.SITE_WORKSHOP_STORE) &&
        Number(s.parent_store_id) === Number(mainWorkshop.id)
      )
    : [];

  return {
    main_store: {
      ...mainStore,
      type_label: STORE_TYPE_LABELS[mainStore.store_type] || 'Central Main Store',
      site_stores: directSiteStores.map((s) => ({ ...s, type_label: STORE_TYPE_LABELS[s.store_type] || 'Site Store' })),
      main_workshop: mainWorkshop
        ? {
            ...mainWorkshop,
            type_label: STORE_TYPE_LABELS[mainWorkshop.store_type] || 'Main Workshop Store',
            site_workshop_stores: workshopChildStores.map((s) => ({ ...s, type_label: STORE_TYPE_LABELS[s.store_type] || 'Site Store' })),
            site_stores: workshopChildStores.map((s) => ({ ...s, type_label: STORE_TYPE_LABELS[s.store_type] || 'Site Store' })),
          }
        : null
    },
    all_stores: allStores
  };
}

/**
 * Compatibility bridge: resolve physical store from legacy store_id or workshop_id.
 */
function resolvePhysicalStore(legacyStoreIdOrWorkshopId) {
  if (!legacyStoreIdOrWorkshopId) return null;
  const idNum = Number(legacyStoreIdOrWorkshopId);

  // 1. Direct mapping from store_location_mappings
  const mapped = get(`
    SELECT sl.* FROM store_location_mappings m
      JOIN store_locations sl ON sl.id = m.store_location_id
     WHERE m.legacy_store_id = ?
     LIMIT 1
  `, idNum);
  if (mapped) return mapped;

  // 2. Direct match by workshop_id in store_locations
  const byWorkshop = get(`
    SELECT * FROM store_locations
     WHERE workshop_id = ? AND active = 1
     ORDER BY is_default DESC, id ASC LIMIT 1
  `, idNum);
  if (byWorkshop) return byWorkshop;

  // 3. Fallback: Main Workshop Store
  const defaultWs = get(`SELECT * FROM store_locations WHERE store_type = ? AND active = 1 LIMIT 1`, STORE_TYPES.MAIN_WORKSHOP_STORE);
  return defaultWs || null;
}

/**
 * Compatibility bridge: resolve legacy store_id from physical store_location_id.
 */
function resolveLegacyStoreId(storeLocationId) {
  if (!storeLocationId) return null;
  const mapped = get('SELECT legacy_store_id FROM store_location_mappings WHERE store_location_id = ? LIMIT 1', storeLocationId);
  if (mapped) return mapped.legacy_store_id;

  const loc = get('SELECT workshop_id FROM store_locations WHERE id = ?', storeLocationId);
  return loc && loc.workshop_id ? loc.workshop_id : 1; // Default to Workshop 1 (CW)
}

/**
 * Get user access grants for a store location.
 */
function getStoreLocationAccess(storeLocationId) {
  return all(`
    SELECT sla.*, u.username, u.full_name, u.active AS user_active
      FROM store_location_access sla
      JOIN users u ON u.id = sla.user_id
     WHERE sla.store_location_id = ?
     ORDER BY u.username ASC
  `, storeLocationId);
}

/**
 * Set user access grants for a store location.
 */
function setUserStoreLocationAccess(userId, storeLocationId, perms = {}, user = null) {
  const store = get('SELECT id FROM store_locations WHERE id = ?', storeLocationId);
  if (!store) throw new Error(`Store location ID ${storeLocationId} not found.`);

  const canView = perms.can_view !== undefined ? (perms.can_view ? 1 : 0) : 1;
  const canRequest = perms.can_request ? 1 : 0;
  const canIssue = perms.can_issue ? 1 : 0;
  const canReceive = perms.can_receive ? 1 : 0;
  const canDispatch = perms.can_dispatch ? 1 : 0;
  const canCount = perms.can_count ? 1 : 0;

  tx(() => {
    run(`
      INSERT INTO store_location_access (
        user_id, store_location_id, can_view, can_request, can_issue, can_receive, can_dispatch, can_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, store_location_id) DO UPDATE SET
        can_view = excluded.can_view,
        can_request = excluded.can_request,
        can_issue = excluded.can_issue,
        can_receive = excluded.can_receive,
        can_dispatch = excluded.can_dispatch,
        can_count = excluded.can_count
    `, userId, storeLocationId, canView, canRequest, canIssue, canReceive, canDispatch, canCount);
  });

  if (audit && user) {
    try {
      audit.record({
        userId: user.id || null,
        entity: 'store_location_access',
        entityId: storeLocationId,
        action: 'grant_access',
        after: { userId, storeLocationId, perms }
      });
    } catch (_) {}
  }

  return get('SELECT * FROM store_location_access WHERE user_id = ? AND store_location_id = ?', userId, storeLocationId);
}

/**
 * Revoke user access grants for a store location.
 */
function revokeUserStoreLocationAccess(userId, storeLocationId, user = null) {
  tx(() => {
    run('DELETE FROM store_location_access WHERE user_id = ? AND store_location_id = ?', userId, storeLocationId);
  });

  if (audit && user) {
    try {
      audit.record({
        userId: user.id || null,
        entity: 'store_location_access',
        entityId: storeLocationId,
        action: 'revoke_access',
        after: { userId, storeLocationId }
      });
    } catch (_) {}
  }

  return { success: true, user_id: userId, store_location_id: storeLocationId };
}

/**
 * Get all physical store locations a user is permitted to access.
 */
function getUserStoreLocations(userId) {
  return all(`
    SELECT sla.*, sl.name AS store_name, sl.code AS store_code, sl.store_type, sl.active AS store_active
      FROM store_location_access sla
      JOIN store_locations sl ON sl.id = sla.store_location_id
     WHERE sla.user_id = ?
     ORDER BY
       CASE sl.store_type
         WHEN 'MAIN_STORE' THEN 1
         WHEN 'MAIN_WORKSHOP_STORE' THEN 2
         WHEN 'SITE_STORE' THEN 3
         WHEN 'SITE_WORKSHOP_STORE' THEN 4
         ELSE 5
       END,
       sl.name ASC
  `, userId);
}

/**
 * Idempotent baseline seed for physical store locations.
 * Preserves existing workshop stock balances by mapping Workshop 1 to Main Workshop Stores.
 */
function seedStoreLocations(targetDb = null) {
  const qGet = (sql, ...p) => (targetDb ? targetDb.prepare(sql).get(...p) : get(sql, ...p));
  const qRun = (sql, ...p) => (targetDb ? targetDb.prepare(sql).run(...p) : run(sql, ...p));
  const qAll = (sql, ...p) => (targetDb ? targetDb.prepare(sql).all(...p) : all(sql, ...p));

  // Ensure tables exist before seeding
  qRun(`
    CREATE TABLE IF NOT EXISTS store_locations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      code             TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      store_type       TEXT NOT NULL CHECK (store_type IN ('MAIN_STORE', 'SITE_STORE', 'MAIN_WORKSHOP_STORE', 'SITE_WORKSHOP_STORE')),
      parent_store_id  INTEGER REFERENCES store_locations(id),
      site_id          INTEGER REFERENCES sites(id),
      workshop_id      INTEGER REFERENCES workshops(id),
      active           INTEGER NOT NULL DEFAULT 1,
      is_default       INTEGER NOT NULL DEFAULT 0,
      opened_at        TEXT,
      closed_at        TEXT,
      notes            TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  qRun(`
    CREATE TABLE IF NOT EXISTS store_location_access (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      store_location_id  INTEGER NOT NULL REFERENCES store_locations(id) ON DELETE CASCADE,
      can_view           INTEGER NOT NULL DEFAULT 1,
      can_request        INTEGER NOT NULL DEFAULT 0,
      can_issue          INTEGER NOT NULL DEFAULT 0,
      can_receive        INTEGER NOT NULL DEFAULT 0,
      can_dispatch       INTEGER NOT NULL DEFAULT 0,
      can_count          INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, store_location_id)
    );
  `);

  qRun(`
    CREATE TABLE IF NOT EXISTS store_location_mappings (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_store_id    INTEGER NOT NULL UNIQUE,
      workshop_id        INTEGER REFERENCES workshops(id),
      store_location_id  INTEGER NOT NULL REFERENCES store_locations(id),
      is_primary         INTEGER NOT NULL DEFAULT 1,
      notes              TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  ensureStoreMetaCols(targetDb);

  // 1. Seed MAIN_STORE: Central Main Stores (Top central authority for sites and purchasing)
  let mainStore = qGet('SELECT * FROM store_locations WHERE code = ?', 'MAIN-STORES');
  if (!mainStore) {
    qRun(`
      INSERT OR IGNORE INTO store_locations (code, name, store_type, parent_store_id, active, is_default, notes)
      VALUES ('MAIN-STORES', 'Central Main Stores', 'MAIN_STORE', NULL, 1, 0, 'Central authority for site-store inventory and procurement')
    `);
    mainStore = qGet('SELECT * FROM store_locations WHERE code = ?', 'MAIN-STORES');
  }

  // 2. Seed MAIN_WORKSHOP_STORE: Central Main Workshop Stores (Mapped from Workshop 1: CW)
  const cw = qGet("SELECT id, code, name FROM workshops WHERE code = 'CW' OR is_default = 1 ORDER BY id ASC LIMIT 1");
  const cwWsId = cw ? cw.id : 1;

  let mainWsStore = qGet('SELECT * FROM store_locations WHERE code = ?', 'MAIN-WORKSHOP');
  if (!mainWsStore) {
    qRun(`
      INSERT OR IGNORE INTO store_locations (code, name, store_type, parent_store_id, workshop_id, active, is_default, notes)
      VALUES ('MAIN-WORKSHOP', 'Central Main Workshop Stores', 'MAIN_WORKSHOP_STORE', ?, ?, 1, 1, 'Central stock source for heavy equipment workshop stores')
    `, mainStore ? mainStore.id : null, cwWsId);
    mainWsStore = qGet('SELECT * FROM store_locations WHERE code = ?', 'MAIN-WORKSHOP');
  }

  // Legacy mapping: CW (id = 1) -> MAIN-WORKSHOP
  if (mainWsStore) {
    qRun(`
      INSERT OR IGNORE INTO store_location_mappings (legacy_store_id, workshop_id, store_location_id, is_primary, notes)
      VALUES (?, ?, ?, 1, 'Central workshop mapped to Main Workshop Stores')
    `, cwWsId, cwWsId, mainWsStore.id);
  }

  // 3. Seed unified SITE_STORE for Workshop 2 (Galagedara / GWS)
  // Automatically migrate any legacy SITE_WORKSHOP_STORE records to SITE_STORE
  qRun(`
    UPDATE store_locations
       SET store_type = 'SITE_STORE',
           code = REPLACE(code, 'SITE-WORKSHOP-', 'SITE-STORE-'),
           name = REPLACE(name, 'Site Workshop Store', 'Site Store'),
           parent_store_id = COALESCE(parent_store_id, ?)
     WHERE store_type = 'SITE_WORKSHOP_STORE'
  `, mainStore ? mainStore.id : 1);

  const gws = qGet("SELECT id, code, name FROM workshops WHERE code = 'GWS' OR id = 2 LIMIT 1");
  if (gws && mainWsStore) {
    let gwsStore = qGet("SELECT * FROM store_locations WHERE code IN ('SITE-STORE-GWS', 'SITE-WORKSHOP-GWS')");
    if (!gwsStore) {
      qRun(`
        INSERT OR IGNORE INTO store_locations (code, name, store_type, parent_store_id, workshop_id, active, is_default, notes)
        VALUES ('SITE-STORE-GWS', 'Galagedara Site Store', 'SITE_STORE', ?, ?, 1, 0, 'Unified site store for Galagedara project')
      `, mainWsStore.id, gws.id);
      gwsStore = qGet("SELECT * FROM store_locations WHERE code = 'SITE-STORE-GWS'");
    } else if (gwsStore.code === 'SITE-WORKSHOP-GWS' || gwsStore.store_type === 'SITE_WORKSHOP_STORE') {
      qRun(`
        UPDATE store_locations
           SET code = 'SITE-STORE-GWS',
               name = 'Galagedara Site Store',
               store_type = 'SITE_STORE',
               parent_store_id = COALESCE(parent_store_id, ?)
         WHERE id = ?
      `, mainWsStore.id, gwsStore.id);
      gwsStore = qGet('SELECT * FROM store_locations WHERE id = ?', gwsStore.id);
    }
    if (gwsStore) {
      qRun(`
        INSERT OR REPLACE INTO store_location_mappings (legacy_store_id, workshop_id, store_location_id, is_primary, notes)
        VALUES (?, ?, ?, 1, 'Galagedara site store mapping')
      `, gws.id, gws.id, gwsStore.id);
    }
  }

  // 4. Seed general Site Stores for projects if sites exist
  if (mainStore) {
    const projects = qAll('SELECT id, name FROM projects WHERE active = 1 LIMIT 5');
    for (const prj of projects) {
      const pCode = 'SITE-STORE-' + prj.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      const exists = qGet('SELECT id FROM store_locations WHERE code = ?', pCode);
      if (!exists) {
        qRun(`
          INSERT OR IGNORE INTO store_locations (code, name, store_type, parent_store_id, active, notes)
          VALUES (?, ?, 'SITE_STORE', ?, 1, ?)
        `, pCode, `${prj.name} Site Store`, mainStore.id, `General materials site store for ${prj.name}`);
      }
    }
  }
}

/**
 * Phase 2 Database Migration & Idempotent Backfill:
 * 1. Ensures physical_store_id on stock_moves, grn, issues, general_item_txns, stock_ledger,
 *    service_jobs, service_filters, tyre_battery_issues, issue_returns, store_counts, store_reorder.
 * 2. Ensures from_store_location_id and to_store_location_id on mtn and mtn_lines.
 * 3. Creates performance indexes.
 * 4. Idempotently backfills physical_store_id from store_location_mappings (CW -> MAIN-WORKSHOP, etc.).
 * 5. Backfills mtn and mtn_lines from/to locations.
 * 6. Creates bidirectional triggers to keep store_id and physical_store_id in sync on inserts.
 */
function migrateStoreLocationsStage2(targetDb) {
  if (!targetDb) return;

  let isWsDb = false;
  try {
    isWsDb = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ws_meta'").get());
  } catch {}
  const colDef = isWsDb ? 'INTEGER' : 'INTEGER REFERENCES store_locations(id)';

  const ensureCol = (table, col, def) => {
    try {
      const exists = targetDb.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      if (!exists) targetDb.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch {}
  };

  const tables = ['grn', 'issues', 'general_item_txns', 'stock_ledger', 'tyre_battery_issues', 'service_jobs', 'service_filters', 'issue_returns', 'store_counts', 'store_reorder', 'stock_moves'];
  for (const t of tables) {
    ensureCol(t, 'physical_store_id', colDef);
  }
  ensureCol('mtn', 'from_store_location_id', colDef);
  ensureCol('mtn', 'to_store_location_id', colDef);
  ensureCol('mtn', 'from_store_id', 'INTEGER');
  ensureCol('mtn', 'to_store_id', 'INTEGER');
  ensureCol('mtn_lines', 'from_store_location_id', colDef);
  ensureCol('mtn_lines', 'to_store_location_id', colDef);
  ensureCol('mrn', 'target_store_location_id', colDef);
  ensureCol('mrn_lines', 'target_store_location_id', colDef);
  ensureCol('grn_vouchers', 'physical_store_id', colDef);

  if (isWsDb) {
    ensureCol('ws_meta', 'physical_store_id', 'INTEGER');
  }

  try {
    targetDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_sm_physical_store ON stock_moves(physical_store_id, section, item_key);
      CREATE INDEX IF NOT EXISTS idx_grn_physical_store ON grn(physical_store_id);
      CREATE INDEX IF NOT EXISTS idx_grnv_physical_store ON grn_vouchers(physical_store_id);
      CREATE INDEX IF NOT EXISTS idx_issues_physical_store ON issues(physical_store_id);
      CREATE INDEX IF NOT EXISTS idx_counts_physical_store ON store_counts(physical_store_id, section, item_key);
      CREATE INDEX IF NOT EXISTS idx_reorder_physical_store ON store_reorder(physical_store_id, section, item_key);
      CREATE INDEX IF NOT EXISTS idx_mtn_from_loc ON mtn(from_store_location_id);
      CREATE INDEX IF NOT EXISTS idx_mtn_to_loc ON mtn(to_store_location_id);
      CREATE INDEX IF NOT EXISTS idx_mtnl_from_loc ON mtn_lines(from_store_location_id);
      CREATE INDEX IF NOT EXISTS idx_mtnl_to_loc ON mtn_lines(to_store_location_id);
      CREATE INDEX IF NOT EXISTS idx_mrn_target_store ON mrn(target_store_location_id);
      CREATE INDEX IF NOT EXISTS idx_mrnl_target_store ON mrn_lines(target_store_location_id);
    `);
  } catch {}

  // Determine prefix for store_location_mappings and store_locations
  let mapTbl = 'store_location_mappings';
  let locTbl = 'store_locations';
  try {
    if (!targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_location_mappings'").get()) {
      mapTbl = 'core.store_location_mappings';
      locTbl = 'core.store_locations';
    }
  } catch {}

  if (isWsDb) {
    try {
      targetDb.exec(`
        UPDATE ws_meta
           SET physical_store_id = COALESCE(
                 (SELECT store_location_id FROM ${mapTbl} WHERE legacy_store_id = ws_meta.store_id LIMIT 1),
                 (SELECT id FROM ${locTbl} WHERE workshop_id = ws_meta.store_id AND active = 1 ORDER BY is_default DESC, id ASC LIMIT 1),
                 2
               )
         WHERE physical_store_id IS NULL;
      `);
    } catch {}
  }

  const resolveExpr = (tbl) => (isWsDb
    ? 'COALESCE((SELECT physical_store_id FROM ws_meta LIMIT 1), 2)'
    : `COALESCE(
    (SELECT store_location_id FROM ${mapTbl} WHERE legacy_store_id = ${tbl}.store_id LIMIT 1),
    (SELECT id FROM ${locTbl} WHERE workshop_id = ${tbl}.store_id AND active = 1 ORDER BY is_default DESC, id ASC LIMIT 1),
    CASE WHEN ${tbl}.store_id = 1 THEN 2 ELSE NULL END
  )`);

  for (const t of tables) {
    try {
      if (t === 'service_filters') {
        const sfExpr = isWsDb
          ? 'COALESCE((SELECT physical_store_id FROM ws_meta LIMIT 1), 2)'
          : `COALESCE(
               (SELECT slm.store_location_id FROM service_jobs sj JOIN ${mapTbl} slm ON slm.legacy_store_id = sj.store_id WHERE sj.id = service_filters.service_id LIMIT 1),
               CASE WHEN (SELECT store_id FROM service_jobs sj WHERE sj.id = service_filters.service_id) = 1 THEN 2 ELSE NULL END
             )`;
        targetDb.exec(`
          UPDATE service_filters
             SET physical_store_id = ${sfExpr}
           WHERE physical_store_id IS NULL;
        `);
      } else {
        targetDb.exec(`UPDATE ${t} SET physical_store_id = ${resolveExpr(t)} WHERE physical_store_id IS NULL AND store_id IS NOT NULL;`);
      }
    } catch {}
  }

  try {
    targetDb.exec(`
      UPDATE mtn_lines
         SET from_store_location_id = COALESCE(
               (SELECT store_location_id FROM ${mapTbl} WHERE legacy_store_id = mtn_lines.from_store_id LIMIT 1),
               (SELECT id FROM ${locTbl} WHERE workshop_id = mtn_lines.from_store_id AND active = 1 ORDER BY is_default DESC, id ASC LIMIT 1)
             )
       WHERE from_store_location_id IS NULL AND from_store_id IS NOT NULL;

      UPDATE mtn_lines
         SET to_store_location_id = COALESCE(
               (SELECT store_location_id FROM ${mapTbl} WHERE legacy_store_id = mtn_lines.to_store_id LIMIT 1),
               (SELECT id FROM ${locTbl} WHERE workshop_id = mtn_lines.to_store_id AND active = 1 ORDER BY is_default DESC, id ASC LIMIT 1)
             )
       WHERE to_store_location_id IS NULL AND to_store_id IS NOT NULL;

      UPDATE mtn
         SET from_store_location_id = (SELECT from_store_location_id FROM mtn_lines WHERE mtn_id = mtn.id AND from_store_location_id IS NOT NULL LIMIT 1)
       WHERE from_store_location_id IS NULL;

      UPDATE mtn
         SET to_store_location_id = (SELECT to_store_location_id FROM mtn_lines WHERE mtn_id = mtn.id AND to_store_location_id IS NOT NULL LIMIT 1)
       WHERE to_store_location_id IS NULL;
    `);
  } catch {}

  for (const t of ['grn', 'issues', 'general_item_txns', 'stock_ledger', 'tyre_battery_issues', 'service_jobs', 'store_counts', 'stock_moves']) {
    try {
      const physExpr = isWsDb ? '(SELECT physical_store_id FROM ws_meta LIMIT 1)' : resolveExpr('NEW');
      const legExpr = isWsDb
        ? 'COALESCE((SELECT store_id FROM ws_meta LIMIT 1), (SELECT workshop_id FROM ws_meta LIMIT 1), 1)'
        : `COALESCE((SELECT legacy_store_id FROM ${mapTbl} WHERE store_location_id = NEW.physical_store_id LIMIT 1), (SELECT workshop_id FROM ${locTbl} WHERE id = NEW.physical_store_id LIMIT 1), 1)`;

      targetDb.exec(`
        DROP TRIGGER IF EXISTS trg_${t}_phys_store;
        DROP TRIGGER IF EXISTS trg_${t}_leg_store;

        CREATE TRIGGER trg_${t}_phys_store AFTER INSERT ON ${t}
        WHEN NEW.physical_store_id IS NULL AND NEW.store_id IS NOT NULL
        BEGIN
          UPDATE ${t} SET physical_store_id = ${physExpr} WHERE id = NEW.id;
        END;

        CREATE TRIGGER trg_${t}_leg_store AFTER INSERT ON ${t}
        WHEN NEW.store_id IS NULL AND NEW.physical_store_id IS NOT NULL
        BEGIN
          UPDATE ${t} SET store_id = ${legExpr} WHERE id = NEW.id;
        END;
      `);
    } catch {}
  }
}

module.exports = {
  STORE_TYPES,
  STORE_TYPE_LABELS,
  validateHierarchy,
  listStoreLocations,
  getStoreLocationById,
  getStoreLocation: getStoreLocationById,
  getStoreLocationByCode,
  createStoreLocation,
  updateStoreLocation,
  retireStoreLocation,
  getStoreHierarchyTree,
  resolvePhysicalStore,
  resolveLegacyStoreId,
  getStoreLocationAccess,
  setUserStoreLocationAccess,
  revokeUserStoreLocationAccess,
  getUserStoreLocations,
  seedStoreLocations,
  migrateStoreLocationsStage2
};
