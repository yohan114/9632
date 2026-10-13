'use strict';

// Access Control — roles, what each role may do, and each role's section clearance.
//
//   GET  /matrix                 the clearance board (role × module level)
//   POST /matrix                 set one board cell
//   GET  /roles                  every role, with its permissions and how many people hold it
//   POST /roles                  create a role (optionally a copy of an existing one)
//   PATCH /roles/:name           rename / describe / retire / reinstate a role
//   GET  /capabilities           the permission catalogue and every role's grants
//   POST /capabilities           give or take away one permission from one role
//   GET  /approval-limits        each role's money limit per kind of approval
//   PUT  /approval-limits        set or clear one role's limit (src/lib/approval_limits.js)
//
// Every change is audited, and all of it is subject to src/lib/access_rules.js: you can only give
// what you hold, only an admin touches the admin role, and there is always an active admin.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt } = require('../lib/http');
const permissions = require('../lib/permissions');
const capabilities = require('../lib/capabilities');
const rules = require('../lib/access_rules');
const audit = require('../lib/audit');

const router = express.Router();

const bad = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

function roleRow(name) {
  return get('SELECT id, name, label, description, is_system, active, require_mfa, created_at FROM roles WHERE name = ?', name);
}

function describeRoles() {
  const holders = new Map(all(`SELECT r.name, COUNT(u.id) n FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id JOIN users u ON u.id = ur.user_id AND u.active = 1
      GROUP BY r.name`).map((r) => [r.name, r.n]));
  return all('SELECT name, label, description, is_system, active, require_mfa, created_at FROM roles ORDER BY active DESC, id')
    .map((r) => ({
      ...r,
      is_system: !!r.is_system,
      active: r.active !== 0,
      require_mfa: !!r.require_mfa,
      locked: r.name === 'admin',
      users: holders.get(r.name) || 0,
      caps: capabilities.capsForRole(r.name),
    }));
}

// A role's permanent key, from its label: "Site Storekeeper — Matara" → site_storekeeper_matara.
// Never one of the built-in names (it would silently inherit that role's seeded permissions), and
// never an existing role's.
function newRoleName(label) {
  const base = (label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role').slice(0, 40);
  let name = base;
  for (let i = 2; capabilities.RESERVED_ROLE_NAMES.has(name) || roleRow(name); i++) name = `${base}_${i}`;
  return name;
}

// ---- clearance board ------------------------------------------------------------------------

router.get('/matrix', requireCap('access.manage'), asyncHandler((_req, res) => res.json(permissions.getMatrix())));

// Set one cell (role × module → level). Admin row is locked (always full).
router.post('/matrix', requireCap('access.manage'), asyncHandler((req, res) => {
  require_(req.body, ['role', 'module', 'level']);
  rules.assertCanSetLevel(req.user, req.body.module, req.body.level);
  const before = permissions.levelForRoles([req.body.role], req.body.module);
  const matrix = permissions.setPermission(req.body.role, req.body.module, req.body.level);
  audit.record({ userId: req.user.id, entity: 'role_permission', action: 'update',
    before: { role: req.body.role, module: req.body.module, level: before },
    after: { role: req.body.role, module: req.body.module, level: req.body.level } });
  res.json(matrix);
}));

// ---- roles ----------------------------------------------------------------------------------

router.get('/roles', requireCap('access.manage', 'users.manage'), asyncHandler((_req, res) => {
  const admins = rules.activeAdminIds().length;
  res.json({ roles: describeRoles(), active_admins: admins });
}));

router.post('/roles', requireCap('access.manage'), asyncHandler((req, res) => {
  const label = clean(req.body.label, 60);
  const description = clean(req.body.description, 300) || null;
  if (!label) bad(400, 'A role needs a name.');
  if (get('SELECT 1 x FROM roles WHERE LOWER(label) = LOWER(?)', label)) bad(409, `A role called "${label}" already exists.`);

  // Copying a role: its permissions and its clearance levels, all subject to "only what you hold".
  const from = req.body.clone_from ? String(req.body.clone_from) : null;
  let caps = [];
  let levels = {};
  if (from) {
    if (from === 'admin') bad(400, 'The admin role cannot be copied. Create a role and choose its permissions instead.');
    if (!roleRow(from)) bad(404, `No role "${from}" to copy.`);
    caps = capabilities.capsForRole(from);
    for (const m of permissions.MODULE_KEYS) levels[m] = permissions.levelForRoles([from], m);
    rules.assertCanGrantCaps(req.user, caps);
    for (const [m, lvl] of Object.entries(levels)) rules.assertCanSetLevel(req.user, m, lvl);
  }

  const name = newRoleName(label);
  tx(() => {
    run("INSERT INTO roles (name, label, description, is_system, active, created_at) VALUES (?, ?, ?, 0, 1, datetime('now'))", name, label, description);
    // Every capability gets an explicit row, granted or not, so the role's state is on record.
    for (const c of capabilities.CAP_KEYS) capabilities.setCapability(name, c, caps.includes(c));
    for (const m of permissions.MODULE_KEYS) {
      run('INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES (?, ?, ?)', name, m, levels[m] || 'none');
    }
  });
  audit.record({ userId: req.user.id, entity: 'role', action: 'create',
    after: { name, label, description, clone_from: from, caps } });
  res.status(201).json(describeRoles().find((r) => r.name === name));
}));

router.patch('/roles/:name', requireCap('access.manage'), asyncHandler((req, res) => {
  const role = roleRow(req.params.name);
  if (!role) bad(404, 'Role not found');
  // The admin role is fixed, with one exception: whether it requires two-factor sign-in.
  const keys = Object.keys(req.body || {});
  if (role.name === 'admin' && keys.some((k) => k !== 'require_mfa')) bad(400, 'The admin role cannot be changed.');
  const sets = [];
  const params = [];
  if (req.body.require_mfa !== undefined) {
    const on = !!req.body.require_mfa;
    // Asking for MORE proof at sign-in only tightens things, so whoever manages roles may switch it
    // on. Switching it OFF loosens every holder's sign-in, and is an admin's call.
    if (!on && !rules.isAdmin(req.user)) bad(403, 'Only an admin can stop a role requiring two-factor sign-in.');
    if (role.name === 'admin' && !rules.isAdmin(req.user)) bad(403, 'Only an admin can change this for the admin role.');
    sets.push('require_mfa = ?'); params.push(on ? 1 : 0);
  }
  if (req.body.label !== undefined) {
    const label = clean(req.body.label, 60);
    if (!label) bad(400, 'A role needs a name.');
    if (get('SELECT 1 x FROM roles WHERE LOWER(label) = LOWER(?) AND name <> ?', label, role.name)) bad(409, `A role called "${label}" already exists.`);
    sets.push('label = ?'); params.push(label);
  }
  if (req.body.description !== undefined) { sets.push('description = ?'); params.push(clean(req.body.description, 300) || null); }
  if (req.body.active !== undefined) {
    const active = !!req.body.active;
    if (!active) {
      // Retiring a role that people still hold would silently strip their access. Move them to
      // another role first — the screen shows how many hold it.
      const holders = get(`SELECT COUNT(*) n FROM user_roles ur JOIN users u ON u.id = ur.user_id
                            WHERE ur.role_id = ? AND u.active = 1`, role.id).n;
      if (holders) bad(409, `${holders} active user(s) still hold this role. Give them another role first.`);
    } else {
      // Reinstating brings back every permission the role holds, so the same "only what you
      // hold" rule applies as when those permissions were first given.
      rules.assertCanGrantCaps(req.user, capabilities.capsForRole(role.name));
    }
    sets.push('active = ?'); params.push(active ? 1 : 0);
  }
  if (sets.length) run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, ...params, role.id);
  audit.record({ userId: req.user.id, entity: 'role', entityId: role.id, action: 'update', before: role, after: roleRow(role.name) });
  res.json(describeRoles().find((r) => r.name === role.name));
}));

// ---- permissions ----------------------------------------------------------------------------

// ---- permissions ----------------------------------------------------------------------------

const DOMAINS = [
  { id: 'Operations', name: 'Operations & Execution', icon: '⚙️', description: 'Workshop floor execution, job cards, breakdowns, field work, and daily technician labor' },
  { id: 'Fleet', name: 'Fleet Management', icon: '🚛', description: 'Equipment registry, statutory compliance, lubricant capacities, mechanic trades, and sites' },
  { id: 'Inventory', name: 'Inventory & Warehousing', icon: '📦', description: 'Central & site stores, MRN demands, tool control, bulk oils, and parts catalogue' },
  { id: 'Procurement', name: 'Procurement & Purchasing', icon: '🛒', description: 'Purchase requisitions, supplier orders, Tyre & Battery workflows' },
  { id: 'Analysis', name: 'Analysis & Intelligence', icon: '📊', description: 'Attention cockpit, daily progress, cost teardowns, and executive fleet analytics' },
  { id: 'Admin', name: 'Governance & Administration', icon: '🛡️', description: 'Workshop tenancies, access control profiles, and user credential management' }
];

const serializeCaps = () => capabilities.CAPABILITIES.map(({ key, module, label, needs, section, actvt, domain, dualAuth }) => ({
  key, module, label, needs, section: section || module, actvt: actvt || '02', domain: domain || 'Operations', dualAuth: !!dualAuth
}));

router.get('/capabilities', requireCap('access.manage'), asyncHandler((_req, res) => {
  res.json({
    domains: DOMAINS,
    sections: FUNCTIONAL_SECTIONS,
    capabilities: serializeCaps(),
    modules: permissions.MODULES,
    roles: describeRoles(),
  });
}));

// ---- 24 Functional Sections across 6 SAP Operational Domains --------------------------------

const FUNCTIONAL_SECTIONS = [
  // DOMAIN 1: OPERATIONS
  {
    id: 'dashboard', name: 'Dashboard & Executive KPIs', icon: '📊', domain: 'Operations',
    description: 'High-level operational overview, pending action counters and fleet KPIs',
    modules: ['dashboard'],
    presets: {
      none: { modules: { dashboard: 'none' }, caps: [] },
      view: { modules: { dashboard: 'view' }, caps: ['dashboard.view'] },
      operator: { modules: { dashboard: 'view' }, caps: ['dashboard.view', 'dashboard.kpi.view'] },
      manager: { modules: { dashboard: 'full' }, caps: ['dashboard.view', 'dashboard.kpi.view', 'dashboard.export'] }
    }
  },
  {
    id: 'jobs', name: 'Job Cards & Work Orders', icon: '📋', domain: 'Operations',
    description: 'Job cards, bay assignments, repair progress, and job closures',
    modules: ['jobs'],
    presets: {
      none: { modules: { jobs: 'none' }, caps: [] },
      view: { modules: { jobs: 'view' }, caps: ['jobs.view'] },
      operator: { modules: { jobs: 'edit' }, caps: ['jobs.view', 'jobs.start', 'jobs.complete', 'jobs.dailywork', 'jobs.parts'] },
      manager: { modules: { jobs: 'full' }, caps: ['jobs.view', 'jobs.create', 'jobs.edit', 'jobs.approve_transport', 'jobs.approve_operations', 'jobs.assign_workshop', 'jobs.start', 'jobs.complete', 'jobs.close', 'jobs.close_on_date', 'jobs.reject', 'jobs.return', 'jobs.reason', 'jobs.dailywork', 'jobs.parts', 'jobs.flat_labour', 'jobs.triage', 'jobs.partial_close', 'jobs.reopen_request', 'jobs.reopen', 'jobs.settings', 'jobs.cost.view', 'jobs.export', 'jobs.view_other_workshops'] }
    }
  },
  {
    id: 'jobrequests', name: 'Job Requests', icon: '📝', domain: 'Operations',
    description: 'Incoming vehicle repair requests from drivers and transport officers',
    modules: ['jobrequests'],
    presets: {
      none: { modules: { jobrequests: 'none' }, caps: [] },
      view: { modules: { jobrequests: 'view' }, caps: ['jobrequests.view'] },
      operator: { modules: { jobrequests: 'edit' }, caps: ['jobrequests.view', 'jobrequests.create'] },
      manager: { modules: { jobrequests: 'full' }, caps: ['jobrequests.view', 'jobrequests.create', 'jobrequests.certify', 'jobrequests.approve', 'jobrequests.reject', 'jobrequests.delete'] }
    }
  },
  {
    id: 'field', name: 'Field Work & Breakdowns', icon: '🚜', domain: 'Operations',
    description: 'Mobile road assistance, site breakdowns, and field service allowances',
    modules: ['field'],
    presets: {
      none: { modules: { field: 'none' }, caps: [] },
      view: { modules: { field: 'view' }, caps: ['field.view'] },
      operator: { modules: { field: 'edit' }, caps: ['field.view', 'field.create', 'field.edit', 'jobs.breakdown', 'jobs.field'] },
      manager: { modules: { field: 'full' }, caps: ['field.view', 'field.create', 'field.edit', 'field.approve', 'field.export', 'jobs.breakdown', 'jobs.field'] }
    }
  },
  {
    id: 'operations', name: 'Operations & Deployments', icon: '🗺️', domain: 'Operations',
    description: 'Fleet operating sites, carrier dispatches, and machine deployment movements',
    modules: ['operations'],
    presets: {
      none: { modules: { operations: 'none' }, caps: [] },
      view: { modules: { operations: 'view' }, caps: ['operations.view'] },
      operator: { modules: { operations: 'edit' }, caps: ['operations.view', 'operations.dispatch', 'operations.site_change'] },
      manager: { modules: { operations: 'full' }, caps: ['operations.view', 'operations.dispatch', 'operations.site_change', 'operations.export'] }
    }
  },
  {
    id: 'dailywork', name: 'Daily Work & Attendance', icon: '📅', domain: 'Operations',
    description: 'Daily technician labor timesheets, attendance logs, and workday sign-offs',
    modules: ['dailywork'],
    presets: {
      none: { modules: { dailywork: 'none' }, caps: [] },
      view: { modules: { dailywork: 'view' }, caps: ['dailywork.view'] },
      operator: { modules: { dailywork: 'edit' }, caps: ['dailywork.view', 'dailywork.add', 'dailywork.bulk_log', 'attendance.record'] },
      manager: { modules: { dailywork: 'full' }, caps: ['dailywork.view', 'dailywork.add', 'dailywork.edit', 'dailywork.delete', 'dailywork.bulk_log', 'dailywork.export', 'attendance.record', 'attendance.unlock', 'attendance.signoff', 'attendance.settings'] }
    }
  },
  {
    id: 'services', name: 'Service Records & Passports', icon: '🛠️', domain: 'Operations',
    description: 'Preventative maintenance history, scheduled services, and passport certification',
    modules: ['services'],
    presets: {
      none: { modules: { services: 'none' }, caps: [] },
      view: { modules: { services: 'view' }, caps: ['services.view'] },
      operator: { modules: { services: 'edit' }, caps: ['services.view', 'services.create', 'services.edit', 'services.attachments'] },
      manager: { modules: { services: 'full' }, caps: ['services.view', 'services.create', 'services.edit', 'services.certify', 'services.delete', 'services.attachments', 'services.export'] }
    }
  },
  {
    id: 'service_plan', name: 'Service & Filter Plan', icon: '📈', domain: 'Operations',
    description: 'Interval-based service plans, upcoming service countdowns, and filter kits',
    modules: ['service_plan'],
    presets: {
      none: { modules: { service_plan: 'none' }, caps: [] },
      view: { modules: { service_plan: 'view' }, caps: ['service_plan.view'] },
      operator: { modules: { service_plan: 'edit' }, caps: ['service_plan.view', 'service_plan.manage'] },
      manager: { modules: { service_plan: 'full' }, caps: ['service_plan.view', 'service_plan.manage', 'service_plan.export'] }
    }
  },

  // DOMAIN 2: FLEET MANAGEMENT
  {
    id: 'assets', name: 'Fleet Register & Assets', icon: '🚛', domain: 'Fleet',
    description: 'Heavy machinery, trucks, light vehicles, asset master, and gallery photos',
    modules: ['assets'],
    presets: {
      none: { modules: { assets: 'none' }, caps: [] },
      view: { modules: { assets: 'view' }, caps: ['assets.view'] },
      operator: { modules: { assets: 'view' }, caps: ['assets.view', 'assets.photo.upload'] },
      manager: { modules: { assets: 'full' }, caps: ['assets.view', 'assets.create', 'assets.edit', 'assets.delete', 'assets.deactivate', 'assets.photo.upload', 'assets.repoint', 'assets.move', 'assets.export'] }
    }
  },
  {
    id: 'vehicle_docs', name: 'Statutory Vehicle Documents', icon: '📜', domain: 'Fleet',
    description: 'Revenue licenses, insurance, eco-tests, fitness certificates, and exemptions',
    modules: ['vehicle_docs'],
    presets: {
      none: { modules: { vehicle_docs: 'none' }, caps: [] },
      view: { modules: { vehicle_docs: 'view' }, caps: ['vehicle_docs.view', 'vehicle_docs.download'] },
      operator: { modules: { vehicle_docs: 'edit' }, caps: ['vehicle_docs.view', 'vehicle_docs.upload', 'vehicle_docs.renew', 'vehicle_docs.download'] },
      manager: { modules: { vehicle_docs: 'full' }, caps: ['vehicle_docs.view', 'vehicle_docs.create', 'vehicle_docs.edit', 'vehicle_docs.delete', 'vehicle_docs.upload', 'vehicle_docs.renew', 'vehicle_docs.verify', 'vehicle_docs.download', 'vehicle_docs.exempt', 'vehicle_docs.export'] }
    }
  },
  {
    id: 'lubricants', name: 'Lubricant Capacities', icon: '🛢️', domain: 'Fleet',
    description: 'OEM fluid capacities, sump, transmission, and hydraulic specifications',
    modules: ['lubricants'],
    presets: {
      none: { modules: { lubricants: 'none' }, caps: [] },
      view: { modules: { lubricants: 'view' }, caps: ['lubricants.view', 'lubricants.export'] },
      operator: { modules: { lubricants: 'edit' }, caps: ['lubricants.view', 'lubricants.create', 'lubricants.edit', 'fleet.capacities.edit'] },
      manager: { modules: { lubricants: 'full' }, caps: ['lubricants.view', 'lubricants.create', 'lubricants.edit', 'fleet.capacities.edit', 'lubricants.delete', 'lubricants.import', 'lubricants.export'] }
    }
  },
  {
    id: 'labour', name: 'Labour Rates & Mechanics', icon: '💼', domain: 'Fleet',
    description: 'Mechanic directory, trade specialties, hourly wages, and charge-out rates',
    modules: ['labour'],
    presets: {
      none: { modules: { labour: 'none' }, caps: [] },
      view: { modules: { labour: 'view' }, caps: ['labour.mechanics.view'] },
      operator: { modules: { labour: 'view' }, caps: ['labour.mechanics.view'] },
      manager: { modules: { labour: 'full' }, caps: ['labour.mechanics.view', 'labour.mechanics.create', 'labour.mechanics.edit', 'labour.mechanics.move', 'labour.mechanics.deactivate', 'labour.rates.view', 'labour.rates.edit'] }
    }
  },
  {
    id: 'projects', name: 'Projects & Sites', icon: '🏗️', domain: 'Fleet',
    description: 'Civil contracts, quarry locations, road schemes, and project yards',
    modules: ['projects'],
    presets: {
      none: { modules: { projects: 'none' }, caps: [] },
      view: { modules: { projects: 'view' }, caps: ['projects.view'] },
      operator: { modules: { projects: 'view' }, caps: ['projects.view'] },
      manager: { modules: { projects: 'full' }, caps: ['projects.view', 'projects.manage', 'projects.close', 'projects.export'] }
    }
  },
  {
    id: 'aliases', name: 'Alias Queue', icon: '🏷️', domain: 'Fleet',
    description: 'Fuzzy resolution queue for non-standard vehicle names and mechanic text',
    modules: ['aliases'],
    presets: {
      none: { modules: { aliases: 'none' }, caps: [] },
      view: { modules: { aliases: 'view' }, caps: ['aliases.view'] },
      operator: { modules: { aliases: 'edit' }, caps: ['aliases.view', 'aliases.vehicle.resolve', 'aliases.mechanic.resolve', 'aliases.allocate'] },
      manager: { modules: { aliases: 'full' }, caps: ['aliases.view', 'aliases.vehicle.resolve', 'aliases.mechanic.resolve', 'aliases.allocate', 'aliases.ignore'] }
    }
  },

  // DOMAIN 3: INVENTORY & WAREHOUSING
  {
    id: 'stores', name: 'Stores & Stock Locations', icon: '📦', domain: 'Inventory',
    description: 'Parts catalogue, multi-store physical hierarchy, bin cards, MRN and GRN ledgers',
    modules: ['stores'],
    presets: {
      none: { modules: { stores: 'none' }, caps: [] },
      view: { modules: { stores: 'view' }, caps: ['stores.view', 'stores.locations.view'] },
      operator: { modules: { stores: 'edit' }, caps: ['stores.view', 'stores.items.create', 'stores.items.edit', 'stores.items.txn', 'stores.mrn.create', 'stores.mrn.edit', 'stores.grn.receive', 'stores.issue', 'stores.stock_issue', 'stores.mtn.edit', 'stores.issue_return', 'stores.stock.count'] },
      manager: { modules: { stores: 'full' }, caps: ['stores.view', 'stores.items.create', 'stores.items.edit', 'stores.items.price', 'stores.items.delete', 'stores.items.txn', 'stores.categories.edit', 'stores.locations.view', 'stores.locations.manage', 'stores.locations.access', 'stores.stock.rebuild', 'stores.stock.levels', 'stores.export', 'stores.mrn.create', 'stores.mrn.edit', 'stores.mrn.certify', 'stores.mrn.site_authority', 'stores.mrn.approve', 'stores.mrn.reject', 'stores.mrn.amend_settled', 'stores.grn.receive', 'stores.grn.edit', 'stores.grn.approve', 'stores.grn.reject', 'stores.issue', 'stores.stock_issue', 'stores.min.approve', 'stores.min.reject', 'stores.reorder_mrn', 'stores.mtn.edit', 'stores.mtn.approve', 'stores.mtn.reject', 'stores.issue_return', 'stores.stock.count', 'stores.count.approve', 'stores.disposal.edit', 'stores.disposal.approve', 'general.items.edit', 'general.stock.adjust', 'general.items.price'] }
    }
  },
  {
    id: 'tools', name: 'Tools, Toolboxes & Scrap Control', icon: '🧰', domain: 'Inventory',
    description: 'Specialized tools catalogue, mechanic toolboxes, daily logs, and scrap approval',
    modules: ['tools'],
    presets: {
      none: { modules: { tools: 'none' }, caps: [] },
      view: { modules: { tools: 'view' }, caps: ['tools.view'] },
      operator: { modules: { tools: 'edit' }, caps: ['tools.view', 'tools.manage', 'tools.issue', 'tools.damage.report', 'tools.toolbox.audit'] },
      manager: { modules: { tools: 'full' }, caps: ['tools.view', 'tools.manage', 'tools.delete', 'tools.issue', 'tools.damage.report', 'tools.scrap.approve', 'tools.toolbox.audit', 'tools.export'] }
    }
  },
  {
    id: 'oil', name: 'Oil & Bulk Lubricants', icon: '🛢️', domain: 'Inventory',
    description: 'Bulk engine/hydraulic oil barrels, dipstick stock counts, and dispensing logs',
    modules: ['oil'],
    presets: {
      none: { modules: { oil: 'none' }, caps: [] },
      view: { modules: { oil: 'view' }, caps: ['oil.view'] },
      operator: { modules: { oil: 'edit' }, caps: ['oil.view', 'oil.identity.resolve', 'oil.ledger.post', 'oil.count'] },
      manager: { modules: { oil: 'full' }, caps: ['oil.view', 'oil.identity.resolve', 'oil.products.edit', 'oil.prices.edit', 'oil.ledger.post', 'oil.count', 'oil.export'] }
    }
  },
  {
    id: 'batteries', name: 'Batteries Inventory & Pool', icon: '🔋', domain: 'Inventory',
    description: 'Serial-tracked commercial battery pool, warranty logs, voltage tests, and swaps',
    modules: ['batteries'],
    presets: {
      none: { modules: { batteries: 'none' }, caps: [] },
      view: { modules: { batteries: 'view' }, caps: ['batteries.view'] },
      operator: { modules: { batteries: 'edit' }, caps: ['batteries.view', 'batteries.register', 'batteries.photos', 'batteries.event', 'batteries.swap'] },
      manager: { modules: { batteries: 'full' }, caps: ['batteries.view', 'batteries.register', 'batteries.photos', 'batteries.event', 'batteries.swap', 'batteries.warranty.claim', 'batteries.scrap.approve', 'batteries.export'] }
    }
  },
  {
    id: 'filters', name: 'Filters Catalogue & Prices', icon: '⚙️', domain: 'Inventory',
    description: 'OEM & replacement air/oil/hydraulic filters catalogue, stock, and pricing',
    modules: ['filters'],
    presets: {
      none: { modules: { filters: 'none' }, caps: [] },
      view: { modules: { filters: 'view' }, caps: ['filters.view'] },
      operator: { modules: { filters: 'edit' }, caps: ['filters.view', 'filters.stock.receive', 'filters.stock.issue'] },
      manager: { modules: { filters: 'full' }, caps: ['filters.view', 'filters.items.manage', 'filters.prices.edit', 'filters.stock.edit', 'filters.stock.receive', 'filters.stock.issue', 'filters.export'] }
    }
  },

  // DOMAIN 4: PROCUREMENT & PURCHASING
  {
    id: 'purchasing', name: 'Purchasing & Requisitions', icon: '🛒', domain: 'Procurement',
    description: 'Purchase requests, head office vs local procurement channels, and PO tracking',
    modules: ['purchasing'],
    presets: {
      none: { modules: { purchasing: 'none' }, caps: [] },
      view: { modules: { purchasing: 'view' }, caps: ['purchasing.view'] },
      operator: { modules: { purchasing: 'edit' }, caps: ['purchasing.view', 'purchasing.local'] },
      manager: { modules: { purchasing: 'full' }, caps: ['purchasing.view', 'purchasing.head_office', 'purchasing.local', 'purchasing.all_channels', 'purchasing.po.create', 'purchasing.po.approve', 'purchasing.export'] }
    }
  },
  {
    id: 'tb_requests', name: 'Tyre & Battery Workflows', icon: '🔄', domain: 'Procurement',
    description: 'End-to-end Tyre & Battery requests, purchasing approvals, and GRN receipts',
    modules: ['tb_requests'],
    presets: {
      none: { modules: { tb_requests: 'none' }, caps: [] },
      view: { modules: { tb_requests: 'view' }, caps: ['tb_requests.view'] },
      operator: { modules: { tb_requests: 'edit' }, caps: ['tb_requests.view', 'tb_requests.create', 'tb_requests.purchase', 'tb_requests.receive', 'tb_requests.issue'] },
      manager: { modules: { tb_requests: 'full' }, caps: ['tb_requests.view', 'tb_requests.create', 'tb_requests.purchase', 'tb_requests.receive', 'tb_requests.issue', 'tb_requests.approve', 'tb.specs.edit'] }
    }
  },

  // DOMAIN 5: ANALYSIS & INTELLIGENCE
  {
    id: 'tb_reports', name: 'Tyre & Battery Analytics', icon: '📊', domain: 'Analysis',
    description: 'Tyre and battery life expectancy analytics, scrap ratios, and cost summaries',
    modules: ['tb_reports'],
    presets: {
      none: { modules: { tb_reports: 'none' }, caps: [] },
      view: { modules: { tb_reports: 'view' }, caps: ['tb_reports.view'] },
      operator: { modules: { tb_reports: 'view' }, caps: ['tb_reports.view'] },
      manager: { modules: { tb_reports: 'full' }, caps: ['tb_reports.view', 'tb_reports.export'] }
    }
  },
  {
    id: 'reports', name: 'Reports & Business Intelligence', icon: '📑', domain: 'Analysis',
    description: 'Needs attention cockpit, daily progress, cost teardown, and analytical reports',
    modules: ['attention', 'daily_progress', 'cost_teardown', 'reports'],
    presets: {
      none: { modules: { attention: 'none', daily_progress: 'none', cost_teardown: 'none', reports: 'none' }, caps: [] },
      view: { modules: { attention: 'view', daily_progress: 'view', cost_teardown: 'view', reports: 'view' }, caps: ['attention.view', 'daily_progress.view', 'cost_teardown.view', 'reports.view'] },
      operator: { modules: { attention: 'view', daily_progress: 'view', cost_teardown: 'view', reports: 'view' }, caps: ['attention.view', 'daily_progress.view', 'cost_teardown.view', 'reports.view', 'reports.daily.notes'] },
      manager: { modules: { attention: 'full', daily_progress: 'full', cost_teardown: 'full', reports: 'full' }, caps: ['attention.view', 'attention.override', 'daily_progress.view', 'daily_progress.export', 'cost_teardown.view', 'cost_teardown.unmask', 'cost_teardown.export', 'reports.view', 'reports.daily.notes', 'reports.export', 'reports.repair_sections.sync'] }
    }
  },

  // DOMAIN 6: GOVERNANCE & ADMINISTRATION
  {
    id: 'access', name: 'Governance, Workshops & Access', icon: '🔐', domain: 'Admin',
    description: 'Workshop multi-tenancy locations, role capability profiles, and user accounts',
    modules: ['workshops', 'access', 'users'],
    presets: {
      none: { modules: { workshops: 'none', access: 'none', users: 'none' }, caps: [] },
      view: { modules: { workshops: 'view', access: 'none', users: 'none' }, caps: ['workshops.view'] },
      operator: { modules: { workshops: 'view', access: 'none', users: 'none' }, caps: ['workshops.view'] },
      manager: { modules: { workshops: 'full', access: 'full', users: 'full' }, caps: ['workshops.view', 'workshops.manage', 'workshops.all', 'access.manage', 'users.manage', 'system.status', 'audit.view'] }
    }
  }
];

router.get('/section-matrix', requireCap('access.manage'), asyncHandler((_req, res) => {
  res.json({
    domains: DOMAINS,
    sections: FUNCTIONAL_SECTIONS,
    capabilities: serializeCaps(),
    modules: permissions.MODULES,
    roles: describeRoles(),
    matrix: permissions.getMatrix(),
  });
}));

router.post('/capabilities', requireCap('access.manage'), asyncHandler((req, res) => {
  require_(req.body, ['role', 'capability']);
  const role = roleRow(req.body.role);
  if (!role) bad(404, 'Role not found');
  const granted = !!req.body.granted;
  if (granted) rules.assertCanGrantCaps(req.user, [req.body.capability]);
  const before = capabilities.capsForRole(role.name).includes(req.body.capability);
  capabilities.setCapability(role.name, req.body.capability, granted);
  audit.record({ userId: req.user.id, entity: 'role_capability', entityId: role.id, action: granted ? 'grant' : 'revoke',
    before: { role: role.name, capability: req.body.capability, granted: before },
    after: { role: role.name, capability: req.body.capability, granted } });
  res.json(describeRoles().find((r) => r.name === role.name));
}));

router.post('/section-save', requireCap('access.manage'), asyncHandler((req, res) => {
  require_(req.body, ['role']);
  const role = roleRow(req.body.role);
  if (!role) bad(404, 'Role not found');
  if (role.name === 'admin') bad(400, 'The admin role holds full access and cannot be changed.');

  const roleName = role.name;
  const modUpdates = req.body.modules || {};
  const capUpdates = req.body.capabilities || {};

  // Check permissions before writing
  for (const [m, lvl] of Object.entries(modUpdates)) {
    rules.assertCanSetLevel(req.user, m, lvl);
  }
  const toGrant = Object.entries(capUpdates).filter(([, v]) => !!v).map(([k]) => k);
  if (toGrant.length) {
    rules.assertCanGrantCaps(req.user, toGrant);
  }

  tx(() => {
    // 1. Update module clearance levels
    for (const [m, lvl] of Object.entries(modUpdates)) {
      const before = permissions.levelForRoles([roleName], m);
      permissions.setPermission(roleName, m, lvl);
      audit.record({ userId: req.user.id, entity: 'role_permission', action: 'update',
        before: { role: roleName, module: m, level: before },
        after: { role: roleName, module: m, level: lvl } });
    }

    // 2. Update capabilities
    for (const [capKey, granted] of Object.entries(capUpdates)) {
      const before = capabilities.capsForRole(roleName).includes(capKey);
      capabilities.setCapability(roleName, capKey, !!granted);
      audit.record({ userId: req.user.id, entity: 'role_capability', entityId: role.id,
        action: granted ? 'grant' : 'revoke',
        before: { role: roleName, capability: capKey, granted: before },
        after: { role: roleName, capability: capKey, granted: !!granted } });
    }
  });

  res.json({
    role: describeRoles().find((r) => r.name === roleName),
    matrix: permissions.getMatrix(),
  });
}));


// ---- Person-by-Person Access Control (WorkshopOne Plan Part B) --------------

// 1. List all people with effective 22-section permissions, role, and override counts
router.get('/people', requireCap('access.manage'), asyncHandler((_req, res) => {
  const users = all(`
    SELECT u.id, u.username, u.full_name, u.active, u.workshop_id AS home_workshop_id,
           u.approval_limit, u.access_until, w.name AS home_workshop_name
      FROM users u
      LEFT JOIN workshops w ON w.id = u.workshop_id
     ORDER BY u.active DESC, u.username
  `);

  const result = users.map((u) => {
    const roles = all(`
      SELECT r.id, r.name, r.label
        FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?
       ORDER BY r.id
    `, u.id);

    const roleNames = roles.map((r) => r.name);
    const userObj = { ...u, roles: roleNames };

    const permOverrides = all('SELECT section, level FROM user_permissions WHERE user_id = ?', u.id);
    const capOverrides = all('SELECT capability, granted FROM user_capabilities WHERE user_id = ?', u.id);
    const overridesCount = permOverrides.length + capOverrides.length;

    return {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      active: !!u.active,
      home_workshop_id: u.home_workshop_id,
      home_workshop_name: u.home_workshop_name,
      approval_limit: u.approval_limit,
      access_until: u.access_until,
      roles,
      overrides_count: overridesCount,
      override_count: overridesCount,
      permissions: permissions.effectiveUserPermissions(userObj),
      caps: capabilities.effectiveCaps(userObj),
    };
  });

  res.json({ people: result });
}));

// 2. Detailed 22-section view for a single user (Role base vs Personal override)
router.get('/people/:id', requireCap('access.manage'), asyncHandler((req, res) => {
  const userId = toInt(req.params.id);
  const u = get(`
    SELECT u.id, u.username, u.full_name, u.active, u.workshop_id AS home_workshop_id,
           u.approval_limit, u.access_until, w.name AS home_workshop_name
      FROM users u
      LEFT JOIN workshops w ON w.id = u.workshop_id
     WHERE u.id = ?
  `, userId);
  if (!u) return res.status(404).json({ error: 'User not found' });

  const roles = all(`
    SELECT r.id, r.name, r.label
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ?
     ORDER BY r.id
  `, userId);
  const roleNames = roles.map((r) => r.name);
  const userObj = { ...u, roles: roleNames };

  const userPermRows = all('SELECT section, level FROM user_permissions WHERE user_id = ?', userId);
  const userPermMap = Object.fromEntries(userPermRows.map((r) => [r.section, r.level]));

  const userCapRows = all('SELECT capability, granted FROM user_capabilities WHERE user_id = ?', userId);
  const userCapMap = Object.fromEntries(userCapRows.map((r) => [r.capability, !!r.granted]));

  const roleCaps = new Set(capabilities.capsForRoles(roleNames));

  const sections = permissions.SECTIONS.map((s) => {
    const roleLevel = roleNames.includes('admin') ? 'full' : permissions.levelForRoles(roleNames, s.key);
    const overrideLevel = userPermMap[s.key] !== undefined ? userPermMap[s.key] : null;
    const effectiveLvl = permissions.effectiveLevel(userObj, s.key);

    const sectionCaps = capabilities.CAPABILITIES.filter((c) => (c.section || c.module) === s.key).map((c) => {
      const roleGranted = roleNames.includes('admin') || roleCaps.has(c.key);
      const overrideGranted = userCapMap[c.key] !== undefined ? userCapMap[c.key] : null;
      let effectiveGranted = roleGranted;
      if (overrideGranted !== null) effectiveGranted = overrideGranted;
      if (roleNames.includes('admin')) effectiveGranted = true;

      return {
        key: c.key,
        label: c.label,
        needs: c.needs,
        actvt: c.actvt || '02',
        domain: c.domain || 'Operations',
        dualAuth: !!c.dualAuth,
        role_granted: roleGranted,
        override_granted: overrideGranted,
        effective_granted: effectiveGranted,
        is_override: overrideGranted !== null && overrideGranted !== roleGranted,
      };
    });

    return {
      key: s.key,
      label: s.label,
      icon: s.icon,
      group: s.group,
      description: s.description,
      role_level: roleLevel,
      override_level: overrideLevel,
      effective_level: effectiveLvl,
      origin: overrideLevel !== null ? 'custom' : 'role',
      has_override: overrideLevel !== null,
      is_override: overrideLevel !== null && overrideLevel !== roleLevel,
      capabilities: sectionCaps,
    };
  });

  res.json({
    user: {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      active: !!u.active,
      home_workshop_id: u.home_workshop_id,
      home_workshop_name: u.home_workshop_name,
      approval_limit: u.approval_limit,
      access_until: u.access_until,
      roles,
    },
    sections,
    all_capabilities: capabilities.CAPABILITIES.map(({ key, label, module, section, needs }) => ({
      key, label, module, section: section || module, needs,
    })),
    levels: permissions.LEVELS,
  });
}));

// 3. Save personal overrides and limits for a specific user
router.post('/people/:id/save', requireCap('access.manage'), asyncHandler((req, res) => {
  const userId = toInt(req.params.id);
  const targetUser = get('SELECT id, username FROM users WHERE id = ?', userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  // Safety rule: nobody can change their own access
  rules.assertNotSelf(req.user, userId);

  // Safety rule: only admin can modify an admin account
  rules.assertCanManageUser(req.user, userId);

  const b = req.body || {};
  const sectionUpdates = b.sections || b.permissions || {};
  const capUpdates = b.capabilities || b.caps || {};

  // Check section clearance limits
  for (const [sectionKey, lvl] of Object.entries(sectionUpdates)) {
    if (lvl !== null && lvl !== undefined && lvl !== '') {
      if (!permissions.LEVELS.includes(lvl)) return res.status(400).json({ error: `Invalid level ${lvl}` });
      rules.assertCanSetLevel(req.user, sectionKey, lvl);
    }
  }

  // Check capability limits
  const capsToGrant = Object.entries(capUpdates)
    .filter(([, val]) => val === true)
    .map(([k]) => k);
  if (capsToGrant.length > 0) {
    rules.assertCanGrantCaps(req.user, capsToGrant);
  }

  tx(() => {
    // 1. Save section overrides
    for (const [sectionKey, lvl] of Object.entries(sectionUpdates)) {
      if (lvl === null || lvl === '' || lvl === undefined) {
        permissions.removeUserPermission(userId, sectionKey);
      } else {
        permissions.setUserPermission(userId, sectionKey, lvl, req.user.id);
      }
    }

    // 2. Save capability overrides
    for (const [capKey, granted] of Object.entries(capUpdates)) {
      if (granted === null || granted === undefined || granted === '') {
        capabilities.removeUserCapability(userId, capKey);
      } else {
        capabilities.setUserCapability(userId, capKey, !!granted, req.user.id);
      }
    }

    // 3. User metadata updates
    const sets = [];
    const params = [];
    if (b.approval_limit !== undefined) {
      const limit = b.approval_limit === '' || b.approval_limit === null ? null : Number(b.approval_limit);
      sets.push('approval_limit = ?'); params.push(limit != null && !isNaN(limit) ? limit : null);
    }
    if (b.access_until !== undefined) {
      const until = b.access_until === '' || b.access_until === null ? null : String(b.access_until).trim();
      sets.push('access_until = ?'); params.push(until || null);
    }
    if (b.home_workshop_id !== undefined || b.workshop_id !== undefined) {
      const val = b.home_workshop_id !== undefined ? b.home_workshop_id : b.workshop_id;
      const wsId = val ? toInt(val) : null;
      sets.push('workshop_id = ?'); params.push(wsId);
    }
    if (sets.length > 0) {
      run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, userId);
    }
  });

  audit.record({
    userId: req.user.id,
    entity: 'user_permission',
    entityId: userId,
    action: 'save_overrides',
    reason: b.reason || null,
    after: { sections: sectionUpdates, capabilities: capUpdates },
  });

  res.json({ ok: true, message: `Access saved for ${targetUser.username}` });
}));

// 4. Reset all personal overrides for user back to role template
router.post('/people/:id/reset', requireCap('access.manage'), asyncHandler((req, res) => {
  const userId = toInt(req.params.id);
  const targetUser = get('SELECT id, username FROM users WHERE id = ?', userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  rules.assertNotSelf(req.user, userId);
  rules.assertCanManageUser(req.user, userId);

  tx(() => {
    permissions.clearUserPermissions(userId);
    capabilities.clearUserCapabilities(userId);
  });

  audit.record({
    userId: req.user.id,
    entity: 'user_permission',
    entityId: userId,
    action: 'reset_to_role',
    reason: (req.body && req.body.reason) || null,
  });

  res.json({ ok: true, message: `Reset access overrides for ${targetUser.username} to role template.` });
}));

// 5. Copy personal overrides from one person to another
router.post('/people/:id/copy-from', requireCap('access.manage'), asyncHandler((req, res) => {
  const targetId = toInt(req.params.id);
  const sourceId = toInt(req.body && req.body.source_user_id);
  if (!sourceId) return res.status(400).json({ error: 'source_user_id is required' });
  if (targetId === sourceId) return res.status(400).json({ error: 'Cannot copy from same person' });

  const targetUser = get('SELECT id, username FROM users WHERE id = ?', targetId);
  const sourceUser = get('SELECT id, username FROM users WHERE id = ?', sourceId);
  if (!targetUser) return res.status(404).json({ error: 'Target user not found' });
  if (!sourceUser) return res.status(404).json({ error: 'Source user not found' });

  rules.assertNotSelf(req.user, targetId);
  rules.assertCanManageUser(req.user, targetId);

  const sourcePerms = all('SELECT section, level FROM user_permissions WHERE user_id = ?', sourceId);
  const sourceCaps = all('SELECT capability, granted FROM user_capabilities WHERE user_id = ?', sourceId);

  for (const sp of sourcePerms) {
    rules.assertCanSetLevel(req.user, sp.section, sp.level);
  }
  const grantedCaps = sourceCaps.filter((sc) => !!sc.granted).map((sc) => sc.capability);
  if (grantedCaps.length > 0) {
    rules.assertCanGrantCaps(req.user, grantedCaps);
  }

  tx(() => {
    permissions.clearUserPermissions(targetId);
    capabilities.clearUserCapabilities(targetId);
    for (const sp of sourcePerms) {
      permissions.setUserPermission(targetId, sp.section, sp.level, req.user.id);
    }
    for (const sc of sourceCaps) {
      capabilities.setUserCapability(targetId, sc.capability, !!sc.granted, req.user.id);
    }
  });

  audit.record({
    userId: req.user.id,
    entity: 'user_permission',
    entityId: targetId,
    action: 'copy_from',
    reason: (req.body && req.body.reason) || null,
    after: { copied_from_user_id: sourceId, source_username: sourceUser.username },
  });

  res.json({ ok: true, message: `Copied overrides from ${sourceUser.username} to ${targetUser.username}.` });
}));

// 6. Section audit view: who can access a chosen section
router.get('/sections/:section', requireCap('access.manage'), asyncHandler((req, res) => {
  const sectionKey = req.params.section;
  const sectionDef = permissions.SECTIONS.find((s) => s.key === sectionKey);
  if (!sectionDef) return res.status(404).json({ error: 'Unknown section' });

  const users = all(`
    SELECT u.id, u.username, u.full_name, u.active, u.approval_limit, u.access_until,
           w.name AS home_workshop_name
      FROM users u
      LEFT JOIN workshops w ON w.id = u.workshop_id
     WHERE u.active = 1
     ORDER BY u.username
  `);

  const people = users.map((u) => {
    const roles = all('SELECT r.name, r.label FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', u.id);
    const roleNames = roles.map((r) => r.name);
    const userObj = { ...u, roles: roleNames };

    const roleLevel = roleNames.includes('admin') ? 'full' : permissions.levelForRoles(roleNames, sectionKey);
    const overrideRow = get('SELECT level FROM user_permissions WHERE user_id = ? AND section = ?', u.id, sectionKey);
    const effectiveLvl = permissions.effectiveLevel(userObj, sectionKey);

    const sectionCaps = capabilities.CAPABILITIES.filter((c) => (c.section || c.module) === sectionKey);
    const userEffectiveCaps = new Set(capabilities.effectiveCaps(userObj));
    const grantedSectionCaps = sectionCaps.filter((c) => userEffectiveCaps.has(c.key)).map((c) => c.key);

    return {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      roles,
      workshop: u.home_workshop_name,
      role_level: roleLevel,
      override_level: overrideRow ? overrideRow.level : null,
      effective_level: effectiveLvl,
      is_override: !!overrideRow,
      granted_caps: grantedSectionCaps,
    };
  });

  res.json({ section: sectionDef, people });
}));

// 7. Compare two people or a person vs a role template
router.get('/compare', requireCap('access.manage'), asyncHandler((req, res) => {
  const a = req.query.user1 || req.query.a;
  const b = req.query.user2 || req.query.b;
  const user1Id = toInt(a);
  const isRoleB = typeof b === 'string' && b.startsWith('role:');
  const user2Id = !isRoleB ? toInt(b) : null;
  const roleName = req.query.role ? String(req.query.role) : (isRoleB ? b.slice(5) : null);

  if (!user1Id) return res.status(400).json({ error: 'user1 (or a) is required' });
  const u1 = get('SELECT id, username, full_name, approval_limit, access_until FROM users WHERE id = ?', user1Id);
  if (!u1) return res.status(404).json({ error: 'user1 not found' });
  const u1Roles = all('SELECT r.name, r.label FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', user1Id);
  const u1Obj = { ...u1, roles: u1Roles.map((r) => r.name) };
  const u1Perms = permissions.effectiveUserPermissions(u1Obj);
  const u1Caps = new Set(capabilities.effectiveCaps(u1Obj));

  let target = null;
  let targetPerms = {};
  let targetCaps = new Set();
  let targetType = '';

  if (user2Id) {
    const u2 = get('SELECT id, username, full_name, approval_limit, access_until FROM users WHERE id = ?', user2Id);
    if (!u2) return res.status(404).json({ error: 'user2 not found' });
    const u2Roles = all('SELECT r.name, r.label FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', user2Id);
    const u2Obj = { ...u2, roles: u2Roles.map((r) => r.name) };
    target = { id: u2.id, username: u2.username, full_name: u2.full_name, roles: u2Roles };
    targetPerms = permissions.effectiveUserPermissions(u2Obj);
    targetCaps = new Set(capabilities.effectiveCaps(u2Obj));
    targetType = 'user';
  } else if (roleName) {
    const r = roleRow(roleName);
    if (!r) return res.status(404).json({ error: 'Role not found' });
    target = { name: r.name, label: r.label };
    for (const m of permissions.MODULE_KEYS) {
      targetPerms[m] = roleName === 'admin' ? 'full' : permissions.levelForRoles([roleName], m);
    }
    targetCaps = new Set(capabilities.capsForRole(roleName));
    targetType = 'role';
  } else {
    return res.status(400).json({ error: 'Either user2 or role is required for comparison' });
  }

  const sectionDiffs = [];
  for (const s of permissions.SECTIONS) {
    const l1 = u1Perms[s.key] || 'none';
    const l2 = targetPerms[s.key] || 'none';
    sectionDiffs.push({
      key: s.key,
      label: s.label,
      icon: s.icon,
      user1_level: l1,
      target_level: l2,
      level_a: l1,
      level_b: l2,
      diff: l1 !== l2,
    });
  }

  const capDiffs = [];
  for (const c of capabilities.CAPABILITIES) {
    const has1 = u1Caps.has(c.key);
    const has2 = targetCaps.has(c.key);
    if (has1 !== has2) {
      capDiffs.push({
        key: c.key,
        label: c.label,
        section: c.section || c.module,
        user1_has: has1,
        target_has: has2,
      });
    }
  }

  res.json({
    user1: { id: u1.id, username: u1.username, full_name: u1.full_name, roles: u1Roles },
    target: { type: targetType, ...target },
    sections: sectionDiffs,
    capabilities: capDiffs,
  });
}));

// 8. Access control change history from audit log
router.get('/history', requireCap('access.manage'), asyncHandler((req, res) => {
  const limit = Math.min(Math.max(toInt(req.query.limit) || 100, 1), 500);
  const rows = all(`
    SELECT a.id, a.user_id, u.username AS actor_username, a.entity, a.entity_id,
           a.action, a.before_json, a.after_json, a.reason, a.created_at
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity IN ('user_permission', 'user_capability', 'role_permission', 'role_capability', 'role')
     ORDER BY a.id DESC
     LIMIT ?
  `, limit);

  res.json({ history: rows });
}));

// 9. Compliance Access Matrix Report (People × 22 Sections)
router.get('/report', requireCap('access.manage'), asyncHandler(async (req, res) => {
  const users = all(`
    SELECT u.id, u.username, u.full_name, u.active, u.approval_limit, u.access_until,
           w.name AS home_workshop_name
      FROM users u
      LEFT JOIN workshops w ON w.id = u.workshop_id
     WHERE u.active = 1
     ORDER BY u.username
  `);

  const matrix = users.map((u) => {
    const roles = all('SELECT r.name, r.label FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', u.id);
    const roleNames = roles.map((r) => r.name);
    const userObj = { ...u, roles: roleNames };
    const perms = permissions.effectiveUserPermissions(userObj);
    const caps = capabilities.effectiveCaps(userObj);
    const overrides = get(`
      SELECT (SELECT COUNT(*) FROM user_permissions WHERE user_id = ?) +
             (SELECT COUNT(*) FROM user_capabilities WHERE user_id = ?) AS cnt
    `, u.id, u.id).cnt || 0;

    return {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      roles: roleNames.join(', '),
      workshop: u.home_workshop_name || '',
      approval_limit: u.approval_limit,
      access_until: u.access_until,
      has_overrides: overrides > 0,
      overrides_count: overrides,
      caps_count: caps.length,
      levels: perms,
    };
  });

  if (req.query.format === 'xlsx') {
    const { sendXlsx } = require('../lib/export');
    const cols = [
      { header: 'Username', key: 'username', width: 16 },
      { header: 'Full Name', key: 'full_name', width: 22 },
      { header: 'Roles', key: 'roles', width: 20 },
      { header: 'Workshop', key: 'workshop', width: 16 },
      { header: 'Overrides', key: 'overrides_count', width: 12 },
      { header: 'Approval Limit', key: 'approval_limit', width: 15 },
      { header: 'Access Until', key: 'access_until', width: 15 },
    ];
    for (const s of permissions.SECTIONS) {
      cols.push({ header: s.label, key: s.key, width: 14 });
    }
    const rows = matrix.map((m) => {
      const r = { ...m };
      for (const [k, v] of Object.entries(m.levels)) {
        r[k] = String(v).toUpperCase();
      }
      return r;
    });
    return sendXlsx(res, 'Access-Control-Matrix.xlsx', [{ name: 'Access Matrix', columns: cols, rows }]);
  }

  res.json({ sections: permissions.SECTIONS, users: matrix, people: matrix });
}));

// ---- approval limits (src/lib/approval_limits.js) ------------------------------------------
// The Approval Limits screen (Access Control) reads and saves through these two. They were lost
// when this file was rewritten for per-person access; the screen still calls them.

router.get('/approval-limits', requireCap('access.manage'), asyncHandler((_req, res) => {
  res.json(require('../lib/approval_limits').listForScreen());
}));

router.put('/approval-limits', requireCap('access.manage'), asyncHandler((req, res) => {
  require_(req.body, ['role', 'kind']);
  const limits = require('../lib/approval_limits');
  const saved = limits.setLimit(req.user, req.body.role, req.body.kind, req.body.max_amount);
  res.json({ saved, ...limits.listForScreen() });
}));

// ---- stand-in approvals delegation (Step 3b, Decision D9) -------------------
const standIn = require('../lib/stand_in');
standIn.initTable();

// List delegations (admin sees all, user sees delegations they give or hold)
router.get('/stand-ins', asyncHandler((req, res) => {
  const rows = standIn.listDelegations(req.user, { limit: req.query.limit });
  res.json({ delegations: rows });
}));

// Active delegations right now for the logged-in user (as stand-in or granter)
router.get('/stand-ins/active', asyncHandler((req, res) => {
  const asStandIn = standIn.getActiveDelegationsFor(req.user.id);
  const asGranter = standIn.getActiveDelegationsBy(req.user.id);
  res.json({
    as_stand_in: asStandIn,
    as_granter: asGranter,
    active_now: asStandIn.length > 0 || asGranter.length > 0
  });
}));

// Create a new delegation (user for themselves, or admin for anyone)
router.post('/stand-ins', asyncHandler((req, res) => {
  require_(req.body, ['granter_id', 'stand_in_id', 'start_date', 'end_date', 'reason']);
  try {
    const created = standIn.createDelegation(req.user, req.body);
    res.status(201).json(created);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

// Revoke an active delegation early (granter, stand-in, or admin)
router.post('/stand-ins/:id/revoke', asyncHandler((req, res) => {
  try {
    const updated = standIn.revokeDelegation(req.user, req.params.id, req.body.reason);
    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

module.exports = router;
