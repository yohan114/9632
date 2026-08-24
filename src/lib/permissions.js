'use strict';

// ===========================================================================
// Role-based access control — a live-editable permission matrix.
//
// Each (role × module) has a LEVEL: none < view < edit < full. Admin is always
// 'full' (and bypasses every check). The matrix is stored in role_permissions
// and seeded once from the DEFAULT_MATRIX below (the current code policy), then
// edited by admins on the Access Control board.
//
// Enforcement is layered and additive: requireModule() gates a router by level
// (GET → view, writes → edit) for the "operational" modules; the existing
// requireRole() guards inside routes stay as a finer second gate. Reference /
// analytics modules (projects, labour, aliases, reports) are NOT API-gated
// (they feed dropdowns and dashboards everywhere) — they are hidden at the nav
// level only. So tightening the matrix can only further restrict, never break a
// role's own core workflow, and admins can loosen any cell live.
// ===========================================================================

const { get, all, run } = require('../db');

const LEVELS = ['none', 'view', 'edit', 'full'];
const rank = (lvl) => Math.max(0, LEVELS.indexOf(lvl));
const meets = (have, need) => rank(have) >= rank(need);

// Board columns. enforce=true → requireModule() guards its API router.
const MODULES = [
  { key: 'assets', label: 'Assets', enforce: true },
  { key: 'jobs', label: 'Job Cards', enforce: true },
  { key: 'jobrequests', label: 'Job Requests', enforce: true },
  { key: 'dailywork', label: 'Daily Work', enforce: true },
  { key: 'stores', label: 'Stores', enforce: true },
  { key: 'oil', label: 'Oil & Lube', enforce: true },
  { key: 'batteries', label: 'Batteries', enforce: true },
  { key: 'filters', label: 'Filters & Prices', enforce: true },
  // Tyres and batteries are held in MAIN STORES, and asking for one, taking it in from the
  // supplier and handing it out are three different jobs done by three different people. One
  // column cannot say that — a fitter who may raise a request must not be able to issue against
  // it — so the three stand on their own. They gate the ACTIONS, not the whole router: the size
  // picklist stays open to anyone signed in, or the request form comes up with an empty dropdown.
  { key: 'tb_request', label: 'T&B · Request', enforce: false },
  { key: 'tb_grn', label: 'T&B · Receive (GRN)', enforce: false },
  { key: 'tb_issue', label: 'T&B · Issue', enforce: false },
  { key: 'labour', label: 'Labour Rates', enforce: false },
  { key: 'projects', label: 'Projects', enforce: false },
  { key: 'aliases', label: 'Alias Queue', enforce: false },
  { key: 'reports', label: 'Reports', enforce: false },
  { key: 'users', label: 'Users & Access', enforce: false },
];
const MODULE_KEYS = MODULES.map((m) => m.key);

// Seed policy — mirrors today's effective access. Admin omitted (always full).
const DEFAULT_MATRIX = {
  storekeeper: { tb_request: 'edit', tb_grn: 'edit', tb_issue: 'edit', assets: 'view', jobs: 'view', jobrequests: 'none', dailywork: 'none', stores: 'full', oil: 'full', batteries: 'full', filters: 'full', labour: 'none', projects: 'view', aliases: 'view', reports: 'view', users: 'none' },
  transport_manager: { tb_request: 'view', tb_grn: 'none', tb_issue: 'none', assets: 'edit', jobs: 'edit', jobrequests: 'edit', dailywork: 'view', stores: 'none', oil: 'none', batteries: 'view', filters: 'view', labour: 'view', projects: 'view', aliases: 'view', reports: 'view', users: 'none' },
  assistant_transport_manager: { tb_request: 'view', tb_grn: 'none', tb_issue: 'none', assets: 'view', jobs: 'view', jobrequests: 'edit', dailywork: 'view', stores: 'none', oil: 'none', batteries: 'view', filters: 'view', labour: 'none', projects: 'view', aliases: 'none', reports: 'view', users: 'none' },
  operational_manager: { tb_request: 'edit', tb_grn: 'view', tb_issue: 'view', assets: 'edit', jobs: 'edit', jobrequests: 'edit', dailywork: 'view', stores: 'view', oil: 'view', batteries: 'view', filters: 'view', labour: 'view', projects: 'edit', aliases: 'view', reports: 'full', users: 'none' },
  manager: { tb_request: 'edit', tb_grn: 'view', tb_issue: 'view', assets: 'view', jobs: 'edit', jobrequests: 'edit', dailywork: 'view', stores: 'view', oil: 'view', batteries: 'view', filters: 'view', labour: 'view', projects: 'view', aliases: 'view', reports: 'full', users: 'none' },
  workshop: { tb_request: 'edit', tb_grn: 'none', tb_issue: 'none', assets: 'view', jobs: 'edit', jobrequests: 'none', dailywork: 'edit', stores: 'view', oil: 'edit', batteries: 'edit', filters: 'full', labour: 'edit', projects: 'view', aliases: 'edit', reports: 'view', users: 'none' },
  viewer: { tb_request: 'view', tb_grn: 'view', tb_issue: 'view', assets: 'view', jobs: 'view', jobrequests: 'view', dailywork: 'view', stores: 'view', oil: 'view', batteries: 'view', filters: 'view', labour: 'view', projects: 'view', aliases: 'view', reports: 'view', users: 'none' },
};

// Backfill any missing (role, module) cell from the seed policy — idempotent, and
// never overwrites an existing cell (so admin edits and new modules both survive).
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

// Highest level a set of roles has for a module. Admin → full.
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

// The full {module: level} map for a user (drives the nav + control gating).
function userPermissions(roles) {
  const out = {};
  for (const m of MODULE_KEYS) out[m] = levelForRoles(roles, m);
  return out;
}

// Router guard: GET needs view, writes need edit. Only used on enforce:true modules.
function requireModule(moduleKey) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.roles.includes('admin')) return next();
    const need = req.method === 'GET' || req.method === 'HEAD' ? 'view' : 'edit';
    if (meets(levelForRoles(req.user.roles, moduleKey), need)) return next();
    return res.status(403).json({ error: `Your role has no ${need} access to ${moduleKey}` });
  };
}

// Full board for the Access Control page.
function getMatrix() {
  const roles = all('SELECT name, label FROM roles ORDER BY id');
  const grid = {};
  for (const r of roles) {
    grid[r.name] = {};
    for (const m of MODULE_KEYS) {
      grid[r.name][m] = r.name === 'admin' ? 'full' : levelForRoles([r.name], m);
    }
  }
  return { modules: MODULES, levels: LEVELS, roles, grid };
}

function setPermission(role, moduleKey, level) {
  if (role === 'admin') { const e = new Error('Admin always has full access and cannot be changed'); e.status = 400; throw e; }
  if (!MODULE_KEYS.includes(moduleKey)) { const e = new Error('Unknown module'); e.status = 400; throw e; }
  if (!LEVELS.includes(level)) { const e = new Error('Level must be none/view/edit/full'); e.status = 400; throw e; }
  if (!get('SELECT id FROM roles WHERE name = ?', role)) { const e = new Error('Unknown role'); e.status = 400; throw e; }
  run(`INSERT INTO role_permissions (role, module, level) VALUES (?, ?, ?)
       ON CONFLICT(role, module) DO UPDATE SET level = excluded.level`, role, moduleKey, level);
  return getMatrix();
}

module.exports = {
  LEVELS, MODULES, MODULE_KEYS, rank, meets,
  seedDefaults, levelForRoles, userPermissions, requireModule, getMatrix, setPermission,
};
