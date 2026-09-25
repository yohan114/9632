'use strict';

// ===========================================================================
// Role-based access control — a live-editable permission matrix.
//
// Each (role × module) has a LEVEL: none < view < edit < full. Admin is always
// 'full' (and bypasses every check). The matrix is stored in role_permissions
// and seeded once from the DEFAULT_MATRIX below (the current code policy), then
// edited by admins on the Access Control board.
//
// LEVELS (access plan, Part 2): none < view < add < edit < full. View reads; Add
// also adds new records (a POST); Edit also changes and removes them (PUT, PATCH,
// DELETE, and the few POSTs that change a record, which ask for edit themselves);
// Full is everything in the section.
//
// A PERSON's level on a switch is their own, when one was set for them on the
// People screen (user_permissions), else the best of their roles'. So a role is the
// starting template and each person can be given more, or less, than it. A level of
// their own can end on a date (Part 3); after it, their roles decide again.
//
// Every section is checked on the server, not only hidden in the sidebar (access
// plan, Part 1). requireModule() gates a router by level (GET → view, writes →
// edit); requireView() gates a section whose actions are decided by their own
// permissions (src/lib/capabilities.js). The lists that fill drop-downs elsewhere
// (project names, mechanic names) stay open to everyone signed in, but only the
// names: costs, rates and history need the section.
// ===========================================================================

const { get, all, run } = require('../db');

const LEVELS = ['none', 'view', 'add', 'edit', 'full'];

// "Access until" (access plan, Part 3). A change made for one person — a level, a permission —
// can carry a last day, for cover during someone's leave. From the day after, it is ignored and the
// person is back to their roles; the row stays, so the screen can say it has ended.
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const isLive = (until) => !until || String(until) >= today();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));

/** An end date as typed: null for none; a real date, today or later. */
function cleanUntil(until) {
  if (until === null || until === undefined || String(until).trim() === '') return null;
  const s = String(until).trim().slice(0, 10);
  if (!isDate(s)) { const e = new Error('The end date is not a date.'); e.status = 400; throw e; }
  if (s < today()) { const e = new Error('The end date has already passed.'); e.status = 400; throw e; }
  return s;
}
const rank = (lvl) => Math.max(0, LEVELS.indexOf(lvl));
const meets = (have, need) => rank(have) >= rank(need);

// Board columns, in the sidebar's order. Every one is checked on the server (access plan, Part 1):
// requireModule() guards the routers of most; the tyre-and-battery steps are checked by each action.
// `from`: a section that used to share another's switch (Field Work shared Job Cards, and so on).
// When it was split off, every role was given the level it had on that switch, so nobody's access
// changed (splitSections below).
const MODULES = [
  { key: 'jobs', label: 'Job Cards', enforce: true },
  { key: 'jobrequests', label: 'Job Cards · Job requests', enforce: true },
  { key: 'field', label: 'Field Work', enforce: true, from: 'jobs' },
  { key: 'operations', label: 'Operations', enforce: true, from: 'assets' },
  { key: 'dailywork', label: 'Daily Work', enforce: true },
  { key: 'services', label: 'Service Records', enforce: true, from: 'filters' },
  { key: 'lubecapacities', label: 'Lubricant Capacities', enforce: true, from: 'jobs' },
  { key: 'assets', label: 'Assets', enforce: true },
  { key: 'labour', label: 'Labour Rates', enforce: true },
  { key: 'stores', label: 'Stores', enforce: true },
  { key: 'oil', label: 'Stores · Oil & Lube', enforce: true },
  { key: 'batteries', label: 'Stores · Batteries', enforce: true },
  { key: 'filters', label: 'Stores · Filters & Prices', enforce: true },
  { key: 'serviceplan', label: 'Service & Filter Plan', enforce: true, from: 'filters' },
  { key: 'projects', label: 'Projects', enforce: true },
  { key: 'aliases', label: 'Alias Queue', enforce: true },
  { key: 'attention', label: 'Needs Attention', enforce: true, from: 'reports' },
  { key: 'progress', label: 'Daily Progress', enforce: true, from: 'reports' },
  { key: 'teardown', label: 'Cost Teardown', enforce: true, from: 'reports' },
  // Buying what the workshop asked for. Only the two purchasing officers (and the managers above
  // them) see the queue at all — and each officer sees their own channel. The channel filtering is
  // done by ROLE inside the router, not by this level.
  { key: 'purchasing', label: 'Purchasing', enforce: true },
  // Tyres and batteries are held in MAIN STORES, and asking for one, taking it in from the
  // supplier and handing it out are three different jobs done by three different people. One
  // column cannot say that — a fitter who may raise a request must not be able to issue against
  // it — so the steps stand on their own. They gate the ACTIONS, not the whole router: the size
  // picklist stays open to anyone signed in, or the request form comes up with an empty dropdown.
  { key: 'tb_request', label: 'Tyre & Battery Requests', enforce: true },
  { key: 'tb_purchase', label: 'T&B · Send to purchase', enforce: true },
  { key: 'tb_grn', label: 'T&B · Receive (GRN)', enforce: true },
  { key: 'tb_issue', label: 'T&B · Issue', enforce: true },
  { key: 'tyrebattery', label: 'Tyre & Battery', enforce: true, from: 'reports' },
  { key: 'reports', label: 'Reports', enforce: true },
  { key: 'users', label: 'Users & Access', enforce: false },
];
const MODULE_KEYS = MODULES.map((m) => m.key);
const SPLIT = MODULES.filter((m) => m.from).map((m) => [m.key, m.from]);

// The 22 sections of the sidebar, in its order, and the switches that open each. The Dashboard is
// always there (each of its parts follows its own section); Workshops and Access Control are opened
// by their permissions (workshops.manage / mechanics.move, access.manage / users.manage).
const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', always: true },
  { key: 'jobs', label: 'Job Cards', modules: ['jobs', 'jobrequests'] },
  { key: 'field', label: 'Field Work', modules: ['field'] },
  { key: 'operations', label: 'Operations', modules: ['operations'] },
  { key: 'dailywork', label: 'Daily Work', modules: ['dailywork'] },
  { key: 'services', label: 'Service Records', modules: ['services'] },
  { key: 'lubecapacities', label: 'Lubricant Capacities', modules: ['lubecapacities'] },
  { key: 'assets', label: 'Assets', modules: ['assets'] },
  { key: 'labour', label: 'Labour Rates', modules: ['labour'] },
  { key: 'stores', label: 'Stores', modules: ['stores', 'oil', 'batteries', 'filters'] },
  { key: 'serviceplan', label: 'Service & Filter Plan', modules: ['serviceplan'] },
  { key: 'projects', label: 'Projects', modules: ['projects'] },
  { key: 'aliases', label: 'Alias Queue', modules: ['aliases'] },
  { key: 'attention', label: 'Needs Attention', modules: ['attention'] },
  { key: 'progress', label: 'Daily Progress', modules: ['progress'] },
  { key: 'teardown', label: 'Cost Teardown', modules: ['teardown'] },
  { key: 'purchasing', label: 'Purchasing', modules: ['purchasing'] },
  { key: 'tbrequests', label: 'Tyre & Battery Requests', modules: ['tb_request', 'tb_purchase', 'tb_grn', 'tb_issue'] },
  { key: 'tyrebattery', label: 'Tyre & Battery', modules: ['tyrebattery'] },
  { key: 'reports', label: 'Reports', modules: ['reports'] },
  { key: 'workshops', label: 'Workshops', special: ['workshops.manage', 'mechanics.move'] },
  { key: 'access', label: 'Access Control', special: ['access.manage', 'users.manage'], modules: ['users'] },
];

// Seed policy — mirrors today's effective access. Admin omitted (always full).
const DEFAULT_MATRIX = {
  storekeeper: { tb_request: 'edit', tb_purchase: 'edit', tb_grn: 'edit', tb_issue: 'edit', assets: 'view', jobs: 'view', jobrequests: 'none', dailywork: 'none', stores: 'full', oil: 'full', batteries: 'full', filters: 'full', purchasing: 'view', labour: 'none', projects: 'view', aliases: 'view', reports: 'view', users: 'none' },
  // Main Stores buys what the workshop asks for. It sees the requests and the purchase queue but
  // does NOT issue out of the workshop store, and does not post workshop receipts — those belong
  // to the keeper who holds that shelf. Loosen any cell on the board when the split needs to move.
  main_storekeeper: { tb_request: 'view', tb_purchase: 'view', tb_grn: 'view', tb_issue: 'none', assets: 'view', jobs: 'view', jobrequests: 'none', dailywork: 'none', stores: 'view', oil: 'view', batteries: 'view', filters: 'view', purchasing: 'view', labour: 'none', projects: 'view', aliases: 'view', reports: 'view', users: 'none' },
  transport_manager: { tb_request: 'view', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none', assets: 'edit', jobs: 'edit', jobrequests: 'edit', dailywork: 'view', stores: 'none', oil: 'none', batteries: 'view', filters: 'view', purchasing: 'none', labour: 'view', projects: 'view', aliases: 'view', reports: 'view', users: 'none' },
  assistant_transport_manager: { tb_request: 'view', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none', assets: 'view', jobs: 'view', jobrequests: 'edit', dailywork: 'view', stores: 'none', oil: 'none', batteries: 'view', filters: 'view', purchasing: 'none', labour: 'none', projects: 'view', aliases: 'none', reports: 'view', users: 'none' },
  operational_manager: { tb_request: 'edit', tb_purchase: 'view', tb_grn: 'view', tb_issue: 'view', assets: 'edit', jobs: 'edit', jobrequests: 'edit', dailywork: 'view', stores: 'view', oil: 'view', batteries: 'view', filters: 'view', purchasing: 'full', labour: 'view', projects: 'edit', aliases: 'view', reports: 'full', users: 'none' },
  manager: { tb_request: 'edit', tb_purchase: 'view', tb_grn: 'view', tb_issue: 'view', assets: 'view', jobs: 'edit', jobrequests: 'edit', dailywork: 'view', stores: 'view', oil: 'view', batteries: 'view', filters: 'view', purchasing: 'full', labour: 'view', projects: 'view', aliases: 'view', reports: 'full', users: 'none' },
  workshop: { tb_request: 'edit', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none', assets: 'view', jobs: 'edit', jobrequests: 'none', dailywork: 'edit', stores: 'view', oil: 'edit', batteries: 'edit', filters: 'full', purchasing: 'none', labour: 'edit', projects: 'view', aliases: 'edit', reports: 'view', users: 'none' },
  // The two buying roles. They see the purchase queue and nothing else that matters — a person
  // whose job is to buy has no business issuing stock or editing a job card. Which of the two
  // channels each one sees is decided inside the router by their ROLE, not by a level here: a
  // level can say "may use this screen", it cannot say "may use the local half of it".
  // THE PURCHASING OFFICERS SEE ONE SCREEN AND NOTHING ELSE.
  //
  // These two buy what has been approved; they do not run the workshop. Handing them a read-only
  // view of job cards, stores, filters and the fleet — which the first cut of this did — puts the
  // company's costs, stock and vehicle history in front of two people whose job needs none of it,
  // and buries the one list they actually work from behind nine they never open.
  //
  // Every module is 'none' on purpose. Adding a cell here should take an argument about why that
  // person's job cannot be done without it.
  purchase_head_office: { tb_request: 'none', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none', purchasing: 'full', assets: 'none', jobs: 'none', jobrequests: 'none', dailywork: 'none', stores: 'none', oil: 'none', batteries: 'none', filters: 'none', labour: 'none', projects: 'none', aliases: 'none', reports: 'none', users: 'none' },
  purchase_local:       { tb_request: 'none', tb_purchase: 'none', tb_grn: 'none', tb_issue: 'none', purchasing: 'full', assets: 'none', jobs: 'none', jobrequests: 'none', dailywork: 'none', stores: 'none', oil: 'none', batteries: 'none', filters: 'none', labour: 'none', projects: 'none', aliases: 'none', reports: 'none', users: 'none' },
  viewer: { tb_request: 'view', tb_purchase: 'view', tb_grn: 'view', tb_issue: 'view', assets: 'view', jobs: 'view', jobrequests: 'view', dailywork: 'view', stores: 'view', oil: 'view', batteries: 'view', filters: 'view', purchasing: 'view', labour: 'view', projects: 'view', aliases: 'view', reports: 'view', users: 'none' },
};

// A split-off section starts where its old switch was, for the built-in roles as for the rest.
for (const levels of Object.values(DEFAULT_MATRIX)) {
  for (const [key, from] of SPLIT) if (levels[key] === undefined) levels[key] = levels[from] || 'none';
}

/**
 * Give every role, for each split-off section, the level it has on the switch the section used to
 * share — so the split changes nobody's access. Runs before seedDefaults on every start; it never
 * overwrites a level already set (an admin's change stands), so after the first start it does
 * nothing, and a role made later by old code is covered the next time the server starts.
 */
function splitSections() {
  let copied = 0;
  for (const [key, from] of SPLIT) {
    copied += run(`INSERT OR IGNORE INTO role_permissions (role, module, level)
                   SELECT role, ?, level FROM role_permissions WHERE module = ?`, key, from).changes;
  }
  return { copied };
}

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

// The full {module: level} map for a set of roles (the role template).
function userPermissions(roles) {
  const out = {};
  for (const m of MODULE_KEYS) out[m] = levelForRoles(roles, m);
  return out;
}

const isAdminUser = (user) => !!(user && Array.isArray(user.roles) && user.roles.includes('admin'));

/**
 * A person's own levels, set for them on the People screen: { module: { level, until, set_by, set_at } }.
 * Only those still in force, unless `ended` is asked for (each row then says whether it has ended).
 */
function personalFor(userId, { ended = false } = {}) {
  if (!userId) return {};
  return Object.fromEntries(all('SELECT module, level, until, set_by, set_at FROM user_permissions WHERE user_id = ?', userId)
    .filter((r) => MODULE_KEYS.includes(r.module) && LEVELS.includes(r.level) && (ended || isLive(r.until)))
    .map((r) => [r.module, { level: r.level, until: r.until || null, set_by: r.set_by, set_at: r.set_at, ...(ended ? { ended: !isLive(r.until) } : {}) }]));
}

/** Every switch's level for a person: their own where set, else their roles'. Admin: full. */
function userLevels(user) {
  const roles = (user && user.roles) || [];
  const out = userPermissions(roles);
  if (isAdminUser(user)) return out;
  for (const [m, p] of Object.entries(personalFor(user && user.id))) out[m] = p.level;
  return out;
}

/** A person's level on one switch. Read from the map made once per request (auth.authenticate). */
function levelFor(user, moduleKey) {
  if (!user) return 'none';
  if (user.levels && user.levels[moduleKey] !== undefined) return user.levels[moduleKey];
  return userLevels(user)[moduleKey] || 'none';
}

/** Does this user reach any of these switches at this level (admin: always)? */
function reaches(user, keys, need = 'view') {
  return (Array.isArray(keys) ? keys : [keys]).some((k) => meets(levelFor(user, k), need));
}

/**
 * Router guard for a section whose actions are decided by their own permissions: every request
 * needs view on one of these switches. Writes are then checked by the action's capability.
 */
function requireView(...keys) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (reaches(req.user, keys)) return next();
    return res.status(403).json({ error: `Your role has no view access to ${keys.join(' or ')}` });
  };
}

// What a request needs: reading is view, adding a record (POST) is add, changing or removing one
// (PUT, PATCH, DELETE) is edit. A POST that changes an existing record asks for edit itself.
const needFor = (method) => (method === 'GET' || method === 'HEAD' ? 'view' : (method === 'POST' ? 'add' : 'edit'));

// Router guard: the level the request needs (needFor), or the level given.
function requireModule(moduleKey, level = null) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const need = level || needFor(req.method);
    if (meets(levelFor(req.user, moduleKey), need)) return next();
    return res.status(403).json({ error: `You have no ${need} access to ${moduleKey}` });
  };
}

// Full board for the Access Control page.
function getMatrix() {
  const roles = all('SELECT name, label, COALESCE(active, 1) AS active FROM roles ORDER BY COALESCE(active, 1) DESC, id');
  const grid = {};
  for (const r of roles) {
    grid[r.name] = {};
    for (const m of MODULE_KEYS) {
      grid[r.name][m] = r.name === 'admin' ? 'full' : levelForRoles([r.name], m);
    }
  }
  return { modules: MODULES, sections: SECTIONS, levels: LEVELS, roles, grid };
}

function setPermission(role, moduleKey, level) {
  if (role === 'admin') { const e = new Error('Admin always has full access and cannot be changed'); e.status = 400; throw e; }
  if (!MODULE_KEYS.includes(moduleKey)) { const e = new Error('Unknown module'); e.status = 400; throw e; }
  if (!LEVELS.includes(level)) { const e = new Error(`Level must be ${LEVELS.join('/')}`); e.status = 400; throw e; }
  if (!get('SELECT id FROM roles WHERE name = ?', role)) { const e = new Error('Unknown role'); e.status = 400; throw e; }
  run(`INSERT INTO role_permissions (role, module, level) VALUES (?, ?, ?)
       ON CONFLICT(role, module) DO UPDATE SET level = excluded.level`, role, moduleKey, level);
  return getMatrix();
}

/**
 * Set one person's own level on one switch, or clear it (level null: back to their roles'). The
 * rules for who may do this are in src/lib/access_rules.js; the route checks them first.
 */
function setPersonal(userId, moduleKey, level, setBy, until = null) {
  if (!MODULE_KEYS.includes(moduleKey)) { const e = new Error('Unknown section'); e.status = 400; throw e; }
  if (level === null || level === undefined || level === '') {
    return run('DELETE FROM user_permissions WHERE user_id = ? AND module = ?', userId, moduleKey).changes;
  }
  if (!LEVELS.includes(level)) { const e = new Error(`Level must be ${LEVELS.join('/')}`); e.status = 400; throw e; }
  return run(`INSERT INTO user_permissions (user_id, module, level, until, set_by, set_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(user_id, module) DO UPDATE SET level = excluded.level, until = excluded.until,
                                                        set_by = excluded.set_by, set_at = excluded.set_at`,
  userId, moduleKey, level, cleanUntil(until), setBy || null).changes;
}

module.exports = {
  LEVELS, MODULES, MODULE_KEYS, SECTIONS, SPLIT, DEFAULT_MATRIX, rank, meets, needFor, today, isLive, cleanUntil,
  splitSections, seedDefaults, levelForRoles, userPermissions, personalFor, userLevels, levelFor, setPersonal,
  reaches, requireView, requireModule, getMatrix, setPermission,
};
