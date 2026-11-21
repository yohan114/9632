'use strict';

/**
 * Migration 063: Fuel Site RBAC Roles (`pump_operator`, `fuel_requester`),
 * Fuel Tank Deduplication & Historical Link Repair, and Fuel Site Project Activation.
 *
 * Safe & idempotent on both fresh test databases and production merged databases.
 */

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasCol(db, table, col) {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info("${table}")`).all().some((c) => c.name === col);
}

function deduplicateTanksAndActivateSites(db) {
  const stats = {
    groupsMerged: 0,
    duplicateTanksRemoved: 0,
    issuesRemapped: 0,
    deliveriesRemapped: 0,
    dipsRemapped: 0,
    requestsRemapped: 0,
    usersRemapped: 0,
    projectsActivated: 0,
  };

  if (!hasTable(db, 'fuel_tanks')) return stats;

  const allTanks = db.prepare(`
    SELECT id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active
      FROM fuel_tanks
     ORDER BY active DESC,
              CASE WHEN CAST(id AS INTEGER) > 0 AND CAST(CAST(id AS INTEGER) AS TEXT) = id THEN 0 ELSE 1 END ASC,
              CAST(id AS INTEGER) ASC,
              id ASC
  `).all();

  // Group tanks that represent the same physical site tank (same normalized name + project)
  const groups = new Map();
  for (const t of allTanks) {
    const key = `${String(t.name || '').trim().toLowerCase()}|${t.project_id != null ? Number(t.project_id) : 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const fkBefore = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const doWork = db.transaction(() => {
      for (const [, list] of groups) {
        if (list.length <= 1) continue;

        // First item is canonical (active=1, lowest numeric ID, holding the authoritative balance)
        const canonical = list[0];
        const dupIds = list.slice(1).map((x) => String(x.id));
        if (!dupIds.length) continue;

        const canonicalId = String(canonical.id);
        stats.groupsMerged++;

        for (const dupId of dupIds) {
          if (hasTable(db, 'fuel_issues')) {
            if (hasCol(db, 'fuel_issues', 'source_tank_id')) {
              stats.issuesRemapped += db.prepare('UPDATE fuel_issues SET source_tank_id = ? WHERE source_tank_id = ?').run(canonicalId, dupId).changes;
            }
            if (hasCol(db, 'fuel_issues', 'bulk_tank_id')) {
              db.prepare('UPDATE fuel_issues SET bulk_tank_id = ? WHERE bulk_tank_id = ?').run(canonicalId, dupId);
            }
          }
          if (hasTable(db, 'fuel_bulk_deliveries') && hasCol(db, 'fuel_bulk_deliveries', 'tank_id')) {
            stats.deliveriesRemapped += db.prepare('UPDATE fuel_bulk_deliveries SET tank_id = ? WHERE tank_id = ?').run(canonicalId, dupId).changes;
          }
          if (hasTable(db, 'fuel_tank_dips') && hasCol(db, 'fuel_tank_dips', 'tank_id')) {
            stats.dipsRemapped += db.prepare('UPDATE fuel_tank_dips SET tank_id = ? WHERE tank_id = ?').run(canonicalId, dupId).changes;
          }
          if (hasTable(db, 'fuel_requests') && hasCol(db, 'fuel_requests', 'target_tank_id')) {
            stats.requestsRemapped += db.prepare('UPDATE fuel_requests SET target_tank_id = ? WHERE target_tank_id = ?').run(canonicalId, dupId).changes;
          }
          if (hasTable(db, 'users') && hasCol(db, 'users', 'bulk_tank_id')) {
            stats.usersRemapped += db.prepare('UPDATE users SET bulk_tank_id = ? WHERE bulk_tank_id = ?').run(canonicalId, dupId).changes;
          }
          stats.duplicateTanksRemoved += db.prepare('DELETE FROM fuel_tanks WHERE id = ?').run(dupId).changes;
        }
      }

      // Deactivate dummy test tanks from prior automated test pollution
      db.prepare(`
        UPDATE fuel_tanks
           SET active = 0
         WHERE id = 'tank-test-cw'
            OR LOWER(TRIM(name)) = 'test tank'
            OR UPPER(TRIM(code)) = 'TEST-TANK'
      `).run();

      // Activate legitimate site projects referenced by active fuel tanks (excluding dummy TEST/FOREIGN)
      if (hasTable(db, 'projects') && hasCol(db, 'projects', 'active')) {
        stats.projectsActivated += db.prepare(`
          UPDATE projects
             SET active = 1
           WHERE active = 0
             AND LOWER(TRIM(COALESCE(name, ''))) != 'test'
             AND UPPER(TRIM(COALESCE(code, ''))) NOT IN ('TEST', 'FOREIGN')
             AND id IN (SELECT DISTINCT project_id FROM fuel_tanks WHERE active = 1 AND project_id IS NOT NULL)
        `).run().changes;
      }
    });
    doWork();
  } finally {
    db.pragma(`foreign_keys = ${fkBefore ? 'ON' : 'OFF'}`);
  }

  return stats;
}

function runMigration(db) {
  console.log('=== Running Migration 063: Fuel Site RBAC & Tank/Site Integrity Repair ===');

  const tankStats = deduplicateTanksAndActivateSites(db);
  if (tankStats.duplicateTanksRemoved > 0 || tankStats.projectsActivated > 0) {
    console.log('[063] Tank & site cleanup:', JSON.stringify(tankStats));
  }

  // Seed dedicated strict roles for site-wise fuel workflows
  if (hasTable(db, 'roles')) {
    const hasDesc = hasCol(db, 'roles', 'description');
    const hasSys = hasCol(db, 'roles', 'is_system');
    if (hasDesc && hasSys) {
      db.prepare(`
        INSERT OR IGNORE INTO roles (name, label, description, is_system, active)
        VALUES ('pump_operator', 'Site Pump Operator',
                'Site-locked pump operator: issue fuel against approved requests, add received fuel to assigned tank, view own issue & tank add history, request issue changes from Admin', 1, 1)
      `).run();
      db.prepare(`
        INSERT OR IGNORE INTO roles (name, label, description, is_system, active)
        VALUES ('fuel_requester', 'Site Fuel Requester',
                'Site-scoped requester: raise transport fuel & running chart requests and track request status', 1, 1)
      `).run();
    } else {
      db.prepare("INSERT OR IGNORE INTO roles (name, label, active) VALUES ('pump_operator', 'Site Pump Operator', 1)").run();
      db.prepare("INSERT OR IGNORE INTO roles (name, label, active) VALUES ('fuel_requester', 'Site Fuel Requester', 1)").run();
    }
  }

  // Clean obsolete ghost module keys from legacy migrations & seed role_permissions for new strict roles
  if (hasTable(db, 'role_permissions')) {
    db.prepare("DELETE FROM role_permissions WHERE module IN ('fuel_billing', 'fuel_dispense')").run();
    try {
      const permissions = require('../lib/permissions');
      const insPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role, module, level) VALUES (?, ?, ?)');
      for (const rName of ['pump_operator', 'fuel_requester']) {
        const tpl = permissions.DEFAULT_MATRIX[rName] || {};
        for (const mod of permissions.MODULE_KEYS) {
          insPerm.run(rName, mod, tpl[mod] || 'none');
        }
      }
    } catch (_) {}
  }
  if (hasTable(db, 'user_permissions')) {
    db.prepare("DELETE FROM user_permissions WHERE section IN ('fuel_billing', 'fuel_dispense')").run();
  }

  // Enforce clean Fuel RBAC templates on existing databases once (removes legacy toxic SoD & non-fuel role leaks
  // without overriding future admin changes on restart)
  if (hasTable(db, 'role_capabilities')) {
    const hasMeta = hasTable(db, 'settings');
    const alreadyDone = hasMeta && !!db.prepare("SELECT value FROM settings WHERE key = 'migration_063_caps_cleaned'").get();
    if (!alreadyDone) {
      db.prepare("DELETE FROM role_capabilities WHERE role IN ('purchase_head_office', 'purchase_local', 'fabrication_officer') AND capability LIKE 'fuel.%'").run();
      db.prepare("DELETE FROM role_capabilities WHERE role IN ('storekeeper', 'site_storekeeper', 'workshop', 'operational_manager', 'manager') AND capability = 'fuel.issue'").run();
      db.prepare("DELETE FROM role_capabilities WHERE role IN ('storekeeper', 'site_storekeeper', 'workshop') AND capability IN ('fuel.tanks.dip', 'fuel.tanks.refill')").run();
      db.prepare("DELETE FROM role_capabilities WHERE role = 'viewer' AND capability = 'fuel.prices.view'").run();
      db.prepare("DELETE FROM role_capabilities WHERE role = 'fuel_officer' AND capability IN ('fuel.request', 'fuel.transport.request', 'fuel.approve_request', 'fuel.correct', 'fuel.approve_correction')").run();
      db.prepare("DELETE FROM role_capabilities WHERE role IN ('operational_manager', 'manager') AND capability IN ('fuel.correct', 'fuel.approve_correction', 'fuel.void')").run();
      if (hasMeta) {
        try {
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_063_caps_cleaned', '1')").run();
        } catch (_) {}
      }
    }

    // Seed strict capabilities for pump_operator & fuel_requester + new capabilities for existing roles
    const seedPairs = [
      // Site Pump Operator — strictly 4 functions (Issue, Own Issue History, Add to Tank, Request Change to Admin)
      ['pump_operator', 'fuel.console.view'],
      ['pump_operator', 'fuel.issue'],
      ['pump_operator', 'fuel.tanks.refill'],
      ['pump_operator', 'fuel.correction.request'],
      // Site Fuel Requester — strictly raise & view transport fuel requests
      ['fuel_requester', 'fuel.transport.view'],
      ['fuel_requester', 'fuel.transport.request'],
      ['fuel_requester', 'fuel.request'],
      // Existing roles' new granular capabilities
      ['fuel_officer', 'fuel.console.view'],
      ['fuel_officer', 'fuel.transfer'],
      ['fuel_officer', 'fuel.correction.request'],
      ['operational_manager', 'fuel.all_sites'],
      ['operational_manager', 'fuel.console.view'],
      ['operational_manager', 'fuel.transfer'],
      ['operational_manager', 'fuel.correction.request'],
      ['manager', 'fuel.all_sites'],
      ['manager', 'fuel.console.view'],
      ['manager', 'fuel.transfer'],
      ['manager', 'fuel.correction.request'],
      ['transport_manager', 'fuel.all_sites'],
      ['accountant', 'fuel.all_sites'],
      ['workshop', 'fuel.correction.request'],
      ['storekeeper', 'fuel.correction.request'],
      ['site_storekeeper', 'fuel.correction.request'],
    ];
    const insCap = db.prepare('INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES (?, ?, 1)');
    for (const [role, cap] of seedPairs) {
      insCap.run(role, cap);
    }
  }

  console.log('=== Migration 063 Completed Successfully ===');
  return tankStats;
}

module.exports = { runMigration, deduplicateTanksAndActivateSites };
