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

router.get('/capabilities', requireCap('access.manage'), asyncHandler((_req, res) => {
  res.json({
    capabilities: capabilities.CAPABILITIES.map(({ key, module, label, needs }) => ({ key, module, label, needs })),
    modules: permissions.MODULES,
    roles: describeRoles(),
  });
}));

// ---- section-wise access control (Single point per section) --------------------------------

const FUNCTIONAL_SECTIONS = [
  {
    id: 'operations',
    name: 'Operations & Workshop',
    icon: '🔧',
    description: 'Job cards, job requests, repairs, field service and workshop management',
    modules: ['jobs', 'jobrequests'],
    presets: {
      none: { modules: { jobs: 'none', jobrequests: 'none' }, caps: [] },
      view: { modules: { jobs: 'view', jobrequests: 'view' }, caps: [] },
      operator: {
        modules: { jobs: 'edit', jobrequests: 'edit' },
        caps: ['jobs.create', 'jobs.start', 'jobs.complete', 'jobs.dailywork', 'jobs.parts', 'jobs.field', 'jobrequests.create']
      },
      manager: {
        modules: { jobs: 'full', jobrequests: 'full' },
        caps: ['jobs.create', 'jobs.edit', 'jobs.approve_transport', 'jobs.approve_operations', 'jobs.assign_workshop', 'jobs.start', 'jobs.complete', 'jobs.close', 'jobs.close_on_date', 'jobs.reject', 'jobs.return', 'jobs.reopen_request', 'jobs.reopen', 'jobs.reason', 'jobs.dailywork', 'jobs.parts', 'jobs.flat_labour', 'jobs.partial_close', 'jobs.breakdown', 'jobs.field', 'jobs.triage', 'jobrequests.create', 'jobrequests.certify', 'jobrequests.approve', 'jobrequests.reject']
      }
    }
  },
  {
    id: 'stores',
    name: 'Inventory & Stores',
    icon: '📦',
    description: 'Store items, MRNs, receipts (GRN), issues, transfer notes (MTN), lubricants and filters',
    modules: ['stores', 'oil', 'filters'],
    presets: {
      none: { modules: { stores: 'none', oil: 'none', filters: 'none' }, caps: [] },
      view: { modules: { stores: 'view', oil: 'view', filters: 'view' }, caps: [] },
      operator: {
        modules: { stores: 'edit', oil: 'edit', filters: 'edit' },
        caps: ['stores.items.edit', 'stores.mrn.create', 'stores.grn.receive', 'stores.grn.edit', 'stores.issue', 'stores.stock_issue', 'stores.issue_return', 'stores.mtn.edit', 'stores.stock.count', 'oil.ledger.post', 'oil.count', 'filters.stock.receive', 'filters.stock.issue']
      },
      manager: {
        modules: { stores: 'full', oil: 'full', filters: 'full' },
        caps: ['stores.items.edit', 'stores.items.txn', 'stores.categories.edit', 'stores.mrn.create', 'stores.mrn.edit', 'stores.mrn.certify', 'stores.mrn.approve', 'stores.mrn.reject', 'stores.mrn.amend_settled', 'stores.grn.receive', 'stores.grn.edit', 'stores.issue', 'stores.stock_issue', 'stores.reorder_mrn', 'stores.stock.rebuild', 'stores.mtn.edit', 'stores.issue_return', 'stores.stock.count', 'stores.stock.levels', 'stores.count.approve', 'stores.disposal.edit', 'stores.disposal.approve', 'general.items.edit', 'general.stock.adjust', 'general.items.price', 'oil.identity.resolve', 'oil.products.edit', 'oil.prices.edit', 'oil.ledger.post', 'oil.count', 'services.attachments', 'filters.stock.edit', 'filters.stock.receive', 'filters.stock.issue']
      }
    }
  },
  {
    id: 'fleet',
    name: 'Fleet & Assets',
    icon: '🚜',
    description: 'Vehicles, heavy machinery, projects, workshops and mechanics roster',
    modules: ['assets', 'projects', 'labour', 'aliases'],
    presets: {
      none: { modules: { assets: 'none', projects: 'none', labour: 'none', aliases: 'none' }, caps: [] },
      view: { modules: { assets: 'view', projects: 'view', labour: 'view', aliases: 'view' }, caps: [] },
      operator: {
        modules: { assets: 'view', projects: 'view', labour: 'view', aliases: 'view' },
        caps: ['aliases.vehicle.resolve', 'aliases.mechanic.resolve']
      },
      manager: {
        modules: { assets: 'full', projects: 'full', labour: 'full', aliases: 'full' },
        caps: ['assets.create', 'assets.edit', 'assets.move', 'fleet.capacities.edit', 'aliases.vehicle.resolve', 'aliases.mechanic.resolve', 'projects.manage', 'workshops.manage', 'workshops.all', 'mechanics.create', 'labour.rates.edit', 'mechanics.move']
      }
    }
  },
  {
    id: 'dailywork',
    name: 'Daily Work & Attendance',
    icon: '📅',
    description: 'Mechanics daily labor booking, attendance logs, day-end sign-offs and unlock overrides',
    modules: ['dailywork'],
    presets: {
      none: { modules: { dailywork: 'none' }, caps: [] },
      view: { modules: { dailywork: 'view' }, caps: [] },
      operator: {
        modules: { dailywork: 'edit' },
        caps: ['dailywork.add', 'attendance.record']
      },
      manager: {
        modules: { dailywork: 'full' },
        caps: ['dailywork.add', 'dailywork.edit', 'attendance.record', 'attendance.signoff', 'attendance.unlock', 'attendance.settings']
      }
    }
  },
  {
    id: 'purchasing',
    name: 'Procurement & Purchasing',
    icon: '🛒',
    description: 'Head office and local purchasing channels, supplier orders and technical specifications',
    modules: ['purchasing', 'tb_request'],
    presets: {
      none: { modules: { purchasing: 'none', tb_request: 'none' }, caps: [] },
      view: { modules: { purchasing: 'view', tb_request: 'view' }, caps: [] },
      operator: {
        modules: { purchasing: 'edit', tb_request: 'edit' },
        caps: ['purchasing.head_office', 'purchasing.local']
      },
      manager: {
        modules: { purchasing: 'full', tb_request: 'full' },
        caps: ['purchasing.head_office', 'purchasing.local', 'purchasing.all_channels', 'tb.specs.edit']
      }
    }
  },
  {
    id: 'batteries',
    name: 'Batteries & Tyres Management',
    icon: '🔋',
    description: 'Battery registration, warranty tracking, swaps, events and photos',
    modules: ['batteries'],
    presets: {
      none: { modules: { batteries: 'none' }, caps: [] },
      view: { modules: { batteries: 'view' }, caps: [] },
      operator: {
        modules: { batteries: 'edit' },
        caps: ['batteries.register', 'batteries.photos', 'batteries.event']
      },
      manager: {
        modules: { batteries: 'full' },
        caps: ['batteries.register', 'batteries.photos', 'batteries.event']
      }
    }
  },
  {
    id: 'admin',
    name: 'System & Administration',
    icon: '🛡️',
    description: 'User accounts, role access control, system diagnostics and daily report notes',
    modules: ['users', 'reports'],
    presets: {
      none: { modules: { users: 'none', reports: 'none' }, caps: [] },
      view: { modules: { users: 'none', reports: 'view' }, caps: [] },
      operator: {
        modules: { users: 'none', reports: 'view' },
        caps: ['reports.daily.notes']
      },
      manager: {
        modules: { users: 'full', reports: 'full' },
        caps: ['users.manage', 'access.manage', 'system.status', 'jobs.settings', 'reports.daily.notes', 'reports.repair_sections.sync']
      }
    }
  }
];

router.get('/section-matrix', requireCap('access.manage'), asyncHandler((_req, res) => {
  res.json({
    sections: FUNCTIONAL_SECTIONS,
    capabilities: capabilities.CAPABILITIES.map(({ key, module, label, needs }) => ({ key, module, label, needs })),
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

module.exports = router;
