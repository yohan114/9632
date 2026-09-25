'use strict';

// ===========================================================================
// WorkshopOne Permission Matrix & Person-by-Person Access Control (Plan Part B).
//
// 22 Canonical Sections across 6 Operational Domains.
// 5 Levels: none < view < add < edit < full.
//
// Access Resolution Order:
//   1. Admin role always holds 'full' clearance on every section.
//   2. Temporary access expiration (user.access_until): expired -> 'none'.
//   3. Person-by-person override in `user_permissions`:
//      If an explicit (user_id, section) row exists, this personal level is returned.
//   4. Role starting template:
//      Highest level among user's assigned roles in `role_permissions`.
//
// Enforcement:
//   requireModule(section, neededLevel) gates routers and endpoints.
//   GET/HEAD -> 'view'
//   POST -> 'add'
//   PUT/PATCH -> 'edit'
//   DELETE -> 'full'
// ===========================================================================

const { get, all, run } = require('../db');

const LEVELS = ['none', 'view', 'add', 'edit', 'full'];
const rank = (lvl) => Math.max(0, LEVELS.indexOf(lvl));
const meets = (have, need) => rank(have) >= rank(need);

// The 22 Canonical Sections (WorkshopOne Plan §B.2)
const SECTIONS = [
  { id: 1, key: 'dashboard', label: 'Dashboard', icon: '📊', group: 'Operations', enforce: true },
  { id: 2, key: 'jobs', label: 'Job Cards', icon: '📋', group: 'Operations', enforce: true, parts: [{ key: 'jobrequests', label: 'Job Requests' }] },
  { id: 3, key: 'field', label: 'Field Work', icon: '🚜', group: 'Operations', enforce: true },
  { id: 4, key: 'operations', label: 'Operations', icon: '🗺️', group: 'Operations', enforce: true },
  { id: 5, key: 'dailywork', label: 'Daily Work', icon: '📅', group: 'Operations', enforce: true },
  { id: 6, key: 'services', label: 'Service Records', icon: '🛠️', group: 'Operations', enforce: true },
  { id: 7, key: 'lubricants', label: 'Lubricant Capacities', icon: '🛢️', group: 'Fleet', enforce: true },
  { id: 8, key: 'assets', label: 'Assets', icon: '🚛', group: 'Fleet', enforce: true },
  { id: 9, key: 'labour', label: 'Labour Rates', icon: '💼', group: 'Fleet', enforce: true },
  { id: 10, key: 'stores', label: 'Stores', icon: '📦', group: 'Inventory', enforce: true, parts: [{ key: 'oil', label: 'Oil & Lube' }, { key: 'batteries', label: 'Batteries' }, { key: 'filters', label: 'Filters & Prices' }] },
  { id: 11, key: 'service_plan', label: 'Service & Filter Plan', icon: '📈', group: 'Operations', enforce: true },
  { id: 12, key: 'projects', label: 'Projects', icon: '🏗️', group: 'Fleet', enforce: true },
  { id: 13, key: 'aliases', label: 'Alias Queue', icon: '🏷️', group: 'Fleet', enforce: true },
  { id: 14, key: 'attention', label: 'Needs Attention', icon: '⚠️', group: 'Analysis', enforce: true },
  { id: 15, key: 'daily_progress', label: 'Daily Progress', icon: '📝', group: 'Analysis', enforce: true },
  { id: 16, key: 'cost_teardown', label: 'Cost Teardown', icon: '🔍', group: 'Analysis', enforce: true },
  { id: 17, key: 'purchasing', label: 'Purchasing', icon: '🛒', group: 'Procurement', enforce: true },
  { id: 18, key: 'tb_requests', label: 'Tyre & Battery Requests', icon: '🔄', group: 'Procurement', enforce: true, parts: [{ key: 'tb_request', label: 'T&B Request' }, { key: 'tb_purchase', label: 'T&B Purchase' }, { key: 'tb_grn', label: 'T&B Receive' }, { key: 'tb_issue', label: 'T&B Issue' }] },
  { id: 19, key: 'tb_reports', label: 'Tyre & Battery', icon: '📊', group: 'Analysis', enforce: true },
  { id: 20, key: 'reports', label: 'Reports', icon: '📑', group: 'Analysis', enforce: true },
  { id: 21, key: 'workshops', label: 'Workshops', icon: '🏢', group: 'Admin', enforce: true },
  { id: 22, key: 'access', label: 'Access Control', icon: '🔐', group: 'Admin', enforce: true, parts: [{ key: 'users', label: 'Users & Access' }] },
];

const SECTION_KEYS = SECTIONS.map((s) => s.key);

// For backwards compatibility and granular part gating inside sections
const PART_MODULES = [
  { key: 'jobrequests', label: 'Job Requests', enforce: true, parent: 'jobs' },
  { key: 'oil', label: 'Oil & Lube', enforce: true, parent: 'stores' },
  { key: 'batteries', label: 'Batteries', enforce: true, parent: 'stores' },
  { key: 'filters', label: 'Filters & Prices', enforce: true, parent: 'stores' },
  { key: 'tb_request', label: 'T&B · Request', enforce: false, parent: 'tb_requests' },
  { key: 'tb_purchase', label: 'T&B · Send to purchase', enforce: false, parent: 'tb_requests' },
  { key: 'tb_grn', label: 'T&B · Receive (GRN)', enforce: false, parent: 'tb_requests' },
  { key: 'tb_issue', label: 'T&B · Issue', enforce: false, parent: 'tb_requests' },
  { key: 'users', label: 'Users & Access', enforce: false, parent: 'access' },
];

const MODULES = [
  ...SECTIONS.map((s) => ({ key: s.key, label: s.label, enforce: s.enforce, group: s.group, icon: s.icon })),
  ...PART_MODULES.map((p) => ({ key: p.key, label: p.label, enforce: p.enforce, parent: p.parent })),
];

const MODULE_KEYS = MODULES.map((m) => m.key);

// Seed policy — mirrors today's effective access across all 22 sections. Admin omitted (always full).
const DEFAULT_MATRIX = {
  storekeeper: {
    dashboard: 'view', jobs: 'view', jobrequests: 'none', field: 'view', operations: 'view',
    dailywork: 'none', services: 'view', lubricants: 'view', assets: 'view', labour: 'none',
    stores: 'full', oil: 'full', batteries: 'full', filters: 'full', service_plan: 'view',
    projects: 'view', aliases: 'view', attention: 'view', daily_progress: 'view', cost_teardown: 'view',
    purchasing: 'view', tb_requests: 'edit', tb_request: 'edit', tb_purchase: 'edit', tb_grn: 'edit', tb_issue: 'edit',
    tb_reports: 'view', reports: 'view', workshops: 'none', access: 'none', users: 'none'
  },
  main_storekeeper: {
    dashboard: 'view', jobs: 'view', jobrequests: 'none', field: 'view', operations: 'view',
    dailywork: 'none', services: 'view', lubricants: 'view', assets: 'view', labour: 'none',
    stores: 'view', oil: 'view', batteries: 'view', filters: 'view', service_plan: 'view',
    projects: 'view', aliases: 'view', attention: 'view', daily_progress: 'view', cost_teardown: 'view',
    purchasing: 'view', tb_requests: 'view', tb_request: 'view', tb_purchase: 'view', tb_grn: 'view', tb_issue: 'none',
    tb_reports: 'view', reports: 'view', workshops: 'none', access: 'none', users: 'none'
  },
  transport_manager: {
    dashboard: 'view', jobs: 'edit', jobrequests: 'edit', field: 'edit', operations: 'edit',
    dailywork: 'view', services: 'view', lubricants: 'view', assets: 'edit', labour: 'view',
    stores: 'none', oil: 'none', batteries: 'view', filters: 'view', service_plan: 'view',
    projects: 'view', aliases: 'view', attention: 'view', daily_progress: 'view', cost_teardown: 'view',
    purchasing: 'none', tb_requests: 'view', tb_request: 'view', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none',
    tb_reports: 'view', reports: 'view', workshops: 'none', access: 'none', users: 'none'
  },
  assistant_transport_manager: {
    dashboard: 'view', jobs: 'view', jobrequests: 'edit', field: 'view', operations: 'view',
    dailywork: 'view', services: 'view', lubricants: 'view', assets: 'view', labour: 'none',
    stores: 'none', oil: 'none', batteries: 'view', filters: 'view', service_plan: 'view',
    projects: 'view', aliases: 'none', attention: 'view', daily_progress: 'view', cost_teardown: 'view',
    purchasing: 'none', tb_requests: 'view', tb_request: 'view', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none',
    tb_reports: 'view', reports: 'view', workshops: 'none', access: 'none', users: 'none'
  },
  operational_manager: {
    dashboard: 'view', jobs: 'edit', jobrequests: 'edit', field: 'edit', operations: 'edit',
    dailywork: 'view', services: 'edit', lubricants: 'edit', assets: 'edit', labour: 'view',
    stores: 'view', oil: 'view', batteries: 'view', filters: 'view', service_plan: 'edit',
    projects: 'edit', aliases: 'view', attention: 'full', daily_progress: 'full', cost_teardown: 'full',
    purchasing: 'full', tb_requests: 'edit', tb_request: 'edit', tb_purchase: 'view', tb_grn: 'view', tb_issue: 'view',
    tb_reports: 'full', reports: 'full', workshops: 'edit', access: 'none', users: 'none'
  },
  manager: {
    dashboard: 'view', jobs: 'edit', jobrequests: 'edit', field: 'edit', operations: 'edit',
    dailywork: 'view', services: 'edit', lubricants: 'edit', assets: 'view', labour: 'view',
    stores: 'view', oil: 'view', batteries: 'view', filters: 'view', service_plan: 'edit',
    projects: 'view', aliases: 'view', attention: 'full', daily_progress: 'full', cost_teardown: 'full',
    purchasing: 'full', tb_requests: 'edit', tb_request: 'edit', tb_purchase: 'view', tb_grn: 'view', tb_issue: 'view',
    tb_reports: 'full', reports: 'full', workshops: 'edit', access: 'none', users: 'none'
  },
  workshop: {
    dashboard: 'view', jobs: 'edit', jobrequests: 'none', field: 'edit', operations: 'view',
    dailywork: 'edit', services: 'edit', lubricants: 'edit', assets: 'view', labour: 'edit',
    stores: 'view', oil: 'edit', batteries: 'edit', filters: 'full', service_plan: 'view',
    projects: 'view', aliases: 'edit', attention: 'view', daily_progress: 'view', cost_teardown: 'view',
    purchasing: 'none', tb_requests: 'edit', tb_request: 'edit', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none',
    tb_reports: 'view', reports: 'view', workshops: 'none', access: 'none', users: 'none'
  },
  purchase_head_office: {
    dashboard: 'view', jobs: 'none', jobrequests: 'none', field: 'none', operations: 'none',
    dailywork: 'none', services: 'none', lubricants: 'none', assets: 'none', labour: 'none',
    stores: 'none', oil: 'none', batteries: 'none', filters: 'none', service_plan: 'none',
    projects: 'none', aliases: 'none', attention: 'none', daily_progress: 'none', cost_teardown: 'none',
    purchasing: 'full', tb_requests: 'none', tb_request: 'none', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none',
    tb_reports: 'none', reports: 'none', workshops: 'none', access: 'none', users: 'none'
  },
  purchase_local: {
    dashboard: 'view', jobs: 'none', jobrequests: 'none', field: 'none', operations: 'none',
    dailywork: 'none', services: 'none', lubricants: 'none', assets: 'none', labour: 'none',
    stores: 'none', oil: 'none', batteries: 'none', filters: 'none', service_plan: 'none',
    projects: 'none', aliases: 'none', attention: 'none', daily_progress: 'none', cost_teardown: 'none',
    purchasing: 'full', tb_requests: 'none', tb_request: 'none', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none',
    tb_reports: 'none', reports: 'none', workshops: 'none', access: 'none', users: 'none'
  },
  viewer: {
    dashboard: 'view', jobs: 'view', jobrequests: 'view', field: 'view', operations: 'view',
    dailywork: 'view', services: 'view', lubricants: 'view', assets: 'view', labour: 'view',
    stores: 'view', oil: 'view', batteries: 'view', filters: 'view', service_plan: 'view',
    projects: 'view', aliases: 'view', attention: 'view', daily_progress: 'view', cost_teardown: 'view',
    purchasing: 'view', tb_requests: 'view', tb_request: 'view', tb_purchase: 'view', tb_grn: 'view', tb_issue: 'view',
    tb_reports: 'view', reports: 'view', workshops: 'view', access: 'none', users: 'none'
  }
};

// Backfill any missing (role, module) cell from seed policy
function seedDefaults() {
  let seeded = 0;
  for (const role of Object.keys(DEFAULT_MATRIX)) {
    for (const mod of MODULE_KEYS) {
      const lvl = DEFAULT_MATRIX[role][mod] || 'none';
      const info = run('INSERT OR IGNORE INTO role_permissions (role, module, level) VALUES (?, ?, ?)', role, mod, lvl);
      if (info.changes) seeded++;
    }
  }
  return { seeded };
}

// Highest level a set of roles has for a module/section. Admin -> full.
function levelForRoles(roles, moduleKey) {
  if (!roles || !roles.length) return 'none';
  if (roles.includes('admin')) return 'full';
  let best = 'none';
  for (const r of roles) {
    const row = get('SELECT level FROM role_permissions WHERE role = ? AND module = ?', r, moduleKey);
    if (row && rank(row.level) > rank(best)) best = row.level;
  }
  return best;
}

function isAccessExpired(user) {
  if (!user || !user.access_until) return false;
  const until = new Date(user.access_until);
  return !isNaN(until.getTime()) && until < new Date();
}

// Effective level for a specific USER (resolves user_permissions override on top of role template)
function effectiveLevel(user, sectionKey) {
  if (!user) return 'none';
  const roles = user.roles || [];
  if (roles.includes('admin')) return 'full';

  // Check temporary access expiration if access_until is set
  if (isAccessExpired(user)) {
    return 'none';
  }

  // 1. Check user-specific override in user_permissions
  if (user.id) {
    const row = get('SELECT level FROM user_permissions WHERE user_id = ? AND section = ?', user.id, sectionKey);
    if (row && LEVELS.includes(row.level)) {
      return row.level;
    }
  }

  // 2. Fall back to role template (highest level among user's roles)
  return levelForRoles(roles, sectionKey);
}

// Full effective {section: level} map for a specific user
function effectiveUserPermissions(user) {
  const out = {};
  for (const m of MODULE_KEYS) {
    out[m] = effectiveLevel(user, m);
  }
  return out;
}

// Backwards-compatible roles-only permission map
function userPermissions(roles) {
  const out = {};
  for (const m of MODULE_KEYS) out[m] = levelForRoles(roles, m);
  return out;
}

// Router guard: checks effective user level against neededLevel (defaults by HTTP method)
function requireModule(moduleKey, neededLevel) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.roles && req.user.roles.includes('admin')) return next();

    let need = neededLevel;
    if (!need) {
      const m = req.method;
      if (m === 'GET' || m === 'HEAD') need = 'view';
      else if (m === 'POST') need = 'add';
      else need = 'edit';
    }

    const have = effectiveLevel(req.user, moduleKey);
    if (meets(have, need)) return next();
    return res.status(403).json({ error: `Your account does not have ${need} access to ${moduleKey}` });
  };
}

// Full matrix for the Access Control Roles tab
function getMatrix() {
  const roles = all('SELECT name, label, COALESCE(active, 1) AS active FROM roles ORDER BY COALESCE(active, 1) DESC, id');
  const grid = {};
  for (const r of roles) {
    grid[r.name] = {};
    for (const m of MODULE_KEYS) {
      grid[r.name][m] = r.name === 'admin' ? 'full' : levelForRoles([r.name], m);
    }
  }
  return { sections: SECTIONS, modules: MODULES, levels: LEVELS, roles, grid };
}

function setPermission(role, moduleKey, level) {
  if (role === 'admin') { const e = new Error('Admin always has full access and cannot be changed'); e.status = 400; throw e; }
  if (!MODULE_KEYS.includes(moduleKey)) { const e = new Error('Unknown module ' + moduleKey); e.status = 400; throw e; }
  if (!LEVELS.includes(level)) { const e = new Error('Level must be none/view/add/edit/full'); e.status = 400; throw e; }
  if (!get('SELECT id FROM roles WHERE name = ?', role)) { const e = new Error('Unknown role'); e.status = 400; throw e; }
  run(`INSERT INTO role_permissions (role, module, level) VALUES (?, ?, ?)
       ON CONFLICT(role, module) DO UPDATE SET level = excluded.level`, role, moduleKey, level);
  return getMatrix();
}

function setUserPermission(userId, section, level) {
  if (!MODULE_KEYS.includes(section)) { const e = new Error('Unknown section ' + section); e.status = 400; throw e; }
  if (!LEVELS.includes(level)) { const e = new Error('Level must be none/view/add/edit/full'); e.status = 400; throw e; }
  run(`INSERT INTO user_permissions (user_id, section, level, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, section) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    userId, section, level);
}

function removeUserPermission(userId, section) {
  run('DELETE FROM user_permissions WHERE user_id = ? AND section = ?', userId, section);
}

function clearUserPermissions(userId) {
  run('DELETE FROM user_permissions WHERE user_id = ?', userId);
}

module.exports = {
  LEVELS, SECTIONS, SECTION_KEYS, MODULES, MODULE_KEYS, DEFAULT_MATRIX, rank, meets,
  seedDefaults, levelForRoles, effectiveLevel, effectiveUserPermissions, userPermissions,
  isAccessExpired, requireModule, getMatrix, setPermission, setUserPermission, removeUserPermission, clearUserPermissions,
};
