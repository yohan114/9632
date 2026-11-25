'use strict';

/**
 * Migration 079: Site-to-Transport Fuel Approval Gate, Tiered Transport Roles & Dual Vehicle Hygiene
 *
 * 1. Adds `requested_channel` ('SITE'|'TRANSPORT'), `approved_litres`, `review_note`, and `exceeds_norm`
 *    columns to `fuel_requests` so Transport Section reviews all site requests and can adjust approved litres.
 * 2. Seeds `fuel.require_transport_approval = 'SITE_ALL'` in `settings`.
 * 3. Cleans dirty placeholder registration on asset 1368 (`SC-17` / `DAI-9757`) and any stray `_bench_tmp` user.
 * 4. Aligns Transport Section role permissions & fuel capabilities for live DB roles:
 *    - `transport_manager`
 *    - `transport_assistant_manager` & `assistant_transport_manager`
 *    - `transport_assistant` (can approve standard site requests; >20% over-norm escalates)
 */

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColumnSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function runMigration(db) {
  const addedColumns = [];
  let assetFixed = 0;
  let benchCleaned = 0;
  let capsGranted = 0;
  let permsGranted = 0;

  if (tableExists(db, 'fuel_requests')) {
    const cols = getColumnSet(db, 'fuel_requests');
    const additions = [
      ['requested_channel', "TEXT DEFAULT 'SITE'"],
      ['approved_litres', 'REAL'],
      ['review_note', 'TEXT'],
      ['exceeds_norm', 'INTEGER DEFAULT 0'],
    ];
    for (const [col, def] of additions) {
      if (!cols.has(col)) {
        db.exec(`ALTER TABLE fuel_requests ADD COLUMN ${col} ${def}`);
        addedColumns.push(col);
      }
    }
    db.exec('UPDATE fuel_requests SET exceeds_norm = 1 WHERE COALESCE(needs_approval, 0) = 1 AND COALESCE(exceeds_norm, 0) = 0');
    db.exec("UPDATE fuel_requests SET requested_channel = 'TRANSPORT' WHERE requested_channel IS NULL");
  }

  if (tableExists(db, 'settings')) {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fuel.require_transport_approval', 'SITE_ALL')").run();
  }

  if (tableExists(db, 'assets')) {
    const info = db.prepare(
      "UPDATE assets SET registration = 'DAI-9757', updated_at = datetime('now') WHERE id = 1368 AND UPPER(code) = 'DAI-9757' AND registration = 'Badalgama Plant'"
    ).run();
    assetFixed += info ? info.changes : 0;
  }

  if (tableExists(db, 'users')) {
    const benchUser = db.prepare("SELECT id FROM users WHERE username = '_bench_tmp'").get();
    if (benchUser) {
      if (tableExists(db, 'sessions')) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(benchUser.id);
      }
      if (tableExists(db, 'user_roles')) {
        db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(benchUser.id);
      }
      const del = db.prepare('DELETE FROM users WHERE id = ?').run(benchUser.id);
      benchCleaned += del ? del.changes : 0;
    }
  }

  // Align live Transport role permissions & fuel capabilities (without overwriting unrelated permissions)
  // Only insert custom role rows when roles are already populated (keeps empty-DB tests like http.test.js clean)
  if (tableExists(db, 'roles') && db.prepare('SELECT 1 FROM roles LIMIT 1').get()) {
    const roleDefs = [
      ['transport_assistant_manager', 'Transport Assistant Manager', 'Assists transport management & approves fuel requests across all sites', 0],
      ['transport_assistant', 'Transport Assistant', 'Reviews standard site fuel requests, running charts & cross-check across all sites', 0],
    ];
    const insRole = db.prepare('INSERT OR IGNORE INTO roles (name, label, description, is_system, active) VALUES (?, ?, ?, ?, 1)');
    for (const [name, label, desc, isSys] of roleDefs) {
      insRole.run(name, label, desc, isSys);
    }
  }

  if (tableExists(db, 'role_permissions')) {
    const transportPerms = {
      transport_assistant_manager: {
        fuel: 'edit', fuel_transport: 'edit', fuel_tanks: 'view',
        fuel_readings: 'view', fuel_prices: 'view', fuel_reports: 'view', fuel_alerts: 'view',
      },
      assistant_transport_manager: {
        fuel: 'edit', fuel_transport: 'edit', fuel_tanks: 'view',
        fuel_readings: 'view', fuel_prices: 'view', fuel_reports: 'view', fuel_alerts: 'view',
      },
      transport_assistant: {
        fuel: 'edit', fuel_transport: 'edit', fuel_tanks: 'view',
        fuel_readings: 'view', fuel_prices: 'view', fuel_reports: 'view', fuel_alerts: 'view',
      },
    };
    const getPerm = db.prepare('SELECT level FROM role_permissions WHERE role = ? AND module = ?');
    const insPerm = db.prepare('INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES (?, ?, ?)');
    for (const [role, mods] of Object.entries(transportPerms)) {
      for (const [mod, lvl] of Object.entries(mods)) {
        const cur = getPerm.get(role, mod);
        if (!cur || cur.level === 'none') {
          const info = insPerm.run(role, mod, lvl);
          permsGranted += info ? info.changes : 0;
        }
      }
    }
  }

  if (tableExists(db, 'role_capabilities')) {
    const capMap = {
      transport_assistant_manager: [
        'fuel.view', 'fuel.all_sites', 'fuel.request', 'fuel.approve', 'fuel.approve_request',
        'fuel.approve_site_request', 'fuel.export', 'fuel.tanks.view', 'fuel.readings.view',
        'fuel.prices.view', 'fuel.reports.view', 'fuel.alerts.view',
        'fuel.transport.view', 'fuel.transport.request', 'fuel.transport.crosscheck',
      ],
      assistant_transport_manager: [
        'fuel.all_sites', 'fuel.approve', 'fuel.approve_request', 'fuel.approve_site_request', 'fuel.export',
      ],
      transport_assistant: [
        'fuel.view', 'fuel.all_sites', 'fuel.request', 'fuel.approve_site_request',
        'fuel.tanks.view', 'fuel.readings.view', 'fuel.prices.view', 'fuel.reports.view', 'fuel.alerts.view',
        'fuel.transport.view', 'fuel.transport.request', 'fuel.transport.crosscheck',
      ],
      transport_manager: ['fuel.approve_site_request'],
      operational_manager: ['fuel.approve_site_request'],
      manager: ['fuel.approve_site_request'],
    };
    const insCap = db.prepare('INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES (?, ?, 1)');
    for (const [role, caps] of Object.entries(capMap)) {
      for (const cap of caps) {
        const info = insCap.run(role, cap);
        capsGranted += info ? info.changes : 0;
      }
    }
  }

  return { addedColumns, assetFixed, benchCleaned, permsGranted, capsGranted };
}

module.exports = { runMigration };
