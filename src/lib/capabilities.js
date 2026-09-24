'use strict';

// ===========================================================================
// Capabilities — WHAT a person may do, one named action at a time.
//
// Access used to be decided by role NAME in about 170 places: requireRole('storekeeper') in the
// routes, can('workshop', 'manager') on the screens. That works for eleven fixed roles and cannot
// work for any other: a role an admin creates ("Site Storekeeper — Matara") is not in any of those
// lists, so it could never do anything. Every one of those checks now asks for a capability
// instead, and a role is simply the set of capabilities it has been given.
//
// Two layers, and both stay:
//   - the MODULE LEVEL (none/view/edit/full, src/lib/permissions.js) opens a whole section — the
//     sidebar, and the router gate on the operational modules;
//   - the CAPABILITY decides each action inside it: receive a GRN, approve an MRN, reopen a card.
// `needs` names the module whose EDIT level the action's router also requires, so the Access
// Control screen can warn when a role has been given an action it cannot reach.
//
// NOTHING CHANGED FOR THE EXISTING ROLES. `legacy` is, for every capability, exactly the list of
// roles the replaced check named (admin left out: admin holds every capability). The built-in
// roles are seeded with those, and test/capabilities.test.js pins it.
//
// Keys are permanent: they are stored against roles. Rename one only with a migration that moves
// its grants.
// ===========================================================================

const { all, run } = require('../db');

const C = (key, module, label, legacy, needs = null) => ({ key, module, label, legacy, needs });

const CAPABILITIES = [
  // ---- administration ------------------------------------------------------------------------
  C('users.manage', 'users', 'Create accounts, reset passwords, assign roles', []),
  C('access.manage', 'users', 'Create and edit roles, their permissions and section clearance', []),
  C('system.status', 'users', 'See backup and system health', []),

  // ---- fleet ---------------------------------------------------------------------------------
  C('assets.create', 'assets', 'Register a new vehicle or machine', ['storekeeper'], 'assets'),
  C('assets.edit', 'assets', 'Edit a vehicle or machine', ['storekeeper'], 'assets'),
  // Stage 7: moving a machine to another project or site, kept as a dated move (src/lib/operations.js).
  C('assets.move', 'assets', 'Move a machine to another project or site', ['transport_manager', 'operational_manager', 'manager']),
  C('aliases.vehicle.resolve', 'aliases', 'Link or dismiss an unrecognised vehicle name', ['storekeeper']),
  C('aliases.mechanic.resolve', 'aliases', 'Link an unrecognised mechanic name', ['storekeeper', 'manager']),
  C('projects.manage', 'projects', 'Create and edit projects and their sites', ['manager']),
  // Multi-site Stage 2 (src/lib/workshops.js). Adding and retiring workshops: admin only unless
  // given on purpose. "All workshops" is the head-office view — recorded now, used for scoping in
  // Stage 3; until then nobody sees less than before.
  C('workshops.manage', 'projects', 'Add, rename and retire workshops', []),
  C('workshops.all', 'users', 'Work across all workshops (head office)', ['manager', 'operational_manager', 'purchase_head_office', 'purchase_local']),
  C('fleet.capacities.edit', 'assets', 'Add, edit or delete vehicle lubricant capacities', []),

  // ---- labour --------------------------------------------------------------------------------
  C('mechanics.create', 'labour', 'Add a mechanic', ['manager']),
  C('labour.rates.edit', 'labour', 'Set a mechanic\'s labour rate', ['manager']),
  C('mechanics.move', 'labour', 'Move a mechanic to another workshop', ['manager']),

  // ---- job cards -----------------------------------------------------------------------------
  C('jobs.create', 'jobs', 'Open a new job card', ['transport_manager', 'workshop'], 'jobs'),
  C('jobs.edit', 'jobs', 'Change a job card\'s vehicle, description or type', ['workshop', 'operational_manager', 'manager'], 'jobs'),
  C('jobs.edit_closed', 'jobs', 'Change items on a CLOSED job card', ['workshop', 'storekeeper', 'manager'], 'jobs'),
  C('jobs.approve_transport', 'jobs', 'Approve a job card — transport step', ['transport_manager'], 'jobs'),
  C('jobs.approve_operations', 'jobs', 'Approve a job card — operations step', ['operational_manager'], 'jobs'),
  C('jobs.assign_workshop', 'jobs', 'Take an approved job card into the workshop', ['workshop'], 'jobs'),
  C('jobs.start', 'jobs', 'Start work on a job card', ['workshop'], 'jobs'),
  C('jobs.complete', 'jobs', 'Mark a job card\'s work complete', ['workshop'], 'jobs'),
  C('jobs.close', 'jobs', 'Close a job card', ['operational_manager', 'workshop'], 'jobs'),
  C('jobs.close_on_date', 'jobs', 'Close a job card on a chosen (past) date', ['operational_manager', 'workshop', 'manager'], 'jobs'),
  C('jobs.reject', 'jobs', 'Reject a job card at an approval step', ['transport_manager', 'operational_manager'], 'jobs'),
  C('jobs.return', 'jobs', 'Send a job card back to "requested"', ['transport_manager', 'operational_manager'], 'jobs'),
  C('jobs.reopen', 'jobs', 'Reopen a CLOSED job card', ['operational_manager', 'manager', 'workshop'], 'jobs'),
  C('jobs.dailywork', 'jobs', 'Add or remove daily work on a job card', ['workshop'], 'jobs'),
  C('jobs.parts', 'jobs', 'Add, price or remove parts on a job card', ['workshop', 'storekeeper'], 'jobs'),
  C('jobs.flat_labour', 'jobs', 'Set a service job\'s flat labour charge', ['workshop', 'operational_manager'], 'jobs'),
  // A bulk clean-up of stuck REQUESTED cards: admin-only unless given to a role on purpose.
  C('jobs.triage', 'jobs', 'Review stuck job cards and reject or close them in bulk', [], 'jobs'),
  // Partial close (W2): the same people who close a card; asking for a reopen, the people who
  // edit one. Approving a reopen request is jobs.reopen, above.
  C('jobs.partial_close', 'jobs', 'Partly close a job card (work done, prices still missing)', ['operational_manager', 'workshop'], 'jobs'),
  C('jobs.reopen_request', 'jobs', 'Ask for a partly closed or closed job card to be reopened', ['workshop', 'operational_manager', 'manager'], 'jobs'),
  // Switching partial close and reopen requests on or off: admin only unless given on purpose.
  C('jobs.settings', 'jobs', 'Switch partial close and reopen requests on or off', []),
  // Stage 6: field work (src/lib/field.js). Reporting a breakdown is for whoever the site calls:
  // the transport managers and their assistants, the workshop, and head office.
  C('jobs.breakdown', 'jobs', 'Report a breakdown in the field (opens a field job card)', ['transport_manager', 'assistant_transport_manager', 'workshop', 'operational_manager', 'manager']),
  C('jobs.field', 'jobs', 'Record field work on a job card (site, times, km)', ['workshop', 'operational_manager', 'manager'], 'jobs'),

  // ---- job requests --------------------------------------------------------------------------
  C('jobrequests.create', 'jobrequests', 'Raise a job request', ['assistant_transport_manager'], 'jobrequests'),
  C('jobrequests.certify', 'jobrequests', 'Certify a job request', ['transport_manager'], 'jobrequests'),
  C('jobrequests.approve', 'jobrequests', 'Approve a job request', ['operational_manager', 'manager'], 'jobrequests'),
  C('jobrequests.reject', 'jobrequests', 'Reject a job request', ['transport_manager', 'operational_manager', 'manager'], 'jobrequests'),

  // ---- daily work ----------------------------------------------------------------------------
  C('dailywork.add', 'dailywork', 'Add daily work entries', ['workshop', 'manager', 'storekeeper'], 'dailywork'),
  C('dailywork.edit', 'dailywork', 'Edit, bulk-log or delete daily work', ['workshop', 'manager'], 'dailywork'),

  // ---- attendance (src/lib/attendance.js) ----------------------------------------------------
  // No `needs`: a manager holds Daily Work at VIEW and still signs off and unlocks days. The
  // attendance routes check these capabilities themselves; reading needs Daily Work view.
  C('attendance.record', 'dailywork', 'Enter and change today\'s and yesterday\'s attendance', ['workshop', 'manager']),
  C('attendance.signoff', 'dailywork', 'Sign off a day (locks its attendance and daily work)', ['workshop', 'manager']),
  C('attendance.unlock', 'dailywork', 'Unlock a signed-off day, or change attendance older than yesterday', ['manager', 'operational_manager']),
  // Switching attendance on, its start date and its rules: admin only unless given on purpose.
  C('attendance.settings', 'dailywork', 'Switch attendance on or off and set its rules', []),

  // ---- stores --------------------------------------------------------------------------------
  C('stores.items.edit', 'stores', 'Add or edit a store item', ['storekeeper'], 'stores'),
  C('stores.items.txn', 'stores', 'Post a manual transaction on a store item', ['storekeeper'], 'stores'),
  C('stores.categories.edit', 'stores', 'Create, rename, merge or delete item categories', ['storekeeper'], 'stores'),
  C('stores.mrn.create', 'stores', 'Raise a material request (MRN)', ['storekeeper'], 'stores'),
  C('stores.mrn.edit', 'stores', 'Edit an MRN and its lines', ['storekeeper'], 'stores'),
  // The three MRN sign-offs are let past the stores gate on purpose (src/server.js): the engineer
  // and manager who sign hold stores=view and must not edit stock.
  C('stores.mrn.certify', 'stores', 'Certify an MRN (workshop sign-off)', ['workshop', 'manager']),
  C('stores.mrn.approve', 'stores', 'Approve an MRN (operations sign-off)', ['operational_manager', 'manager']),
  C('stores.mrn.reject', 'stores', 'Reject an MRN', ['workshop', 'operational_manager', 'manager']),
  C('stores.mrn.amend_settled', 'stores', 'Add an item to an MRN that is already approved or filed', [], 'stores'),
  C('stores.grn.receive', 'stores', 'Receive goods (GRN)', ['storekeeper'], 'stores'),
  C('stores.grn.edit', 'stores', 'Price and correct received goods (GRN)', ['storekeeper'], 'stores'),
  C('stores.issue', 'stores', 'Issue stock (issue notes)', ['storekeeper'], 'stores'),
  C('stores.stock_issue', 'stores', 'Issue shelf stock straight to a job', ['storekeeper', 'workshop', 'manager'], 'stores'),
  C('stores.reorder_mrn', 'stores', 'Raise a reorder MRN from the stock cockpit', ['storekeeper', 'workshop', 'manager']),
  C('stores.stock.rebuild', 'stores', 'Rebuild stock balances and sync stock items', ['storekeeper', 'manager'], 'stores'),
  C('stores.mtn.edit', 'stores', 'Create and edit transfer notes (MTN)', ['storekeeper'], 'stores'),
  C('stores.issue_return', 'stores', 'Return unused parts from a job to the store', ['storekeeper'], 'stores'),
  // Stage 4: a store per workshop (src/lib/stores.js) — the stock take and reorder levels of a store.
  C('stores.stock.count', 'stores', 'Count stock in a store (stock take)', ['storekeeper', 'manager'], 'stores'),
  C('stores.stock.levels', 'stores', 'Set a store\'s reorder levels', ['storekeeper', 'manager'], 'stores'),
  C('general.items.edit', 'stores', 'Add a general rack item', ['storekeeper'], 'stores'),
  C('general.stock.adjust', 'stores', 'Adjust a general rack item\'s stock', ['storekeeper'], 'stores'),
  C('general.items.price', 'stores', 'Set a general rack item\'s price', ['storekeeper'], 'stores'),

  // ---- oil & lubricants ----------------------------------------------------------------------
  C('oil.identity.resolve', 'oil', 'Decide which oil-book product a lubricant name is', ['storekeeper'], 'oil'),
  C('oil.products.edit', 'oil', 'Add or edit an oil product', ['storekeeper'], 'oil'),
  C('oil.prices.edit', 'oil', 'Set oil prices', ['storekeeper'], 'oil'),
  C('oil.ledger.post', 'oil', 'Post oil receipts and issues', ['storekeeper'], 'oil'),
  C('oil.count', 'oil', 'Record an oil stock count', ['storekeeper'], 'oil'),

  // ---- batteries -----------------------------------------------------------------------------
  C('batteries.register', 'batteries', 'Register a battery', ['storekeeper'], 'batteries'),
  C('batteries.photos', 'batteries', 'Add, change or remove battery photos', ['storekeeper'], 'batteries'),
  C('batteries.event', 'batteries', 'Record a battery event (fitted, removed, returned …)', ['storekeeper'], 'batteries'),

  // ---- filters & service records -------------------------------------------------------------
  C('services.attachments', 'filters', 'Upload or delete service record attachments', ['workshop', 'storekeeper', 'operational_manager', 'manager'], 'filters'),
  C('filters.stock.edit', 'filters', 'Add a filter stock item', ['storekeeper'], 'filters'),
  C('filters.stock.receive', 'filters', 'Receive filters into stock', ['storekeeper'], 'filters'),
  C('filters.stock.issue', 'filters', 'Issue filters from stock', ['storekeeper'], 'filters'),

  // ---- tyres & batteries (requests) ----------------------------------------------------------
  C('tb.specs.edit', 'tb_request', 'Edit tyre and battery specifications', ['manager', 'operational_manager']),

  // ---- purchasing ----------------------------------------------------------------------------
  // Which of the two buying channels a person works. "All channels" is the managers' view.
  C('purchasing.head_office', 'purchasing', 'Work the Head Office purchasing channel', ['purchase_head_office'], 'purchasing'),
  C('purchasing.local', 'purchasing', 'Work the Local purchasing channel', ['purchase_local'], 'purchasing'),
  C('purchasing.all_channels', 'purchasing', 'Work both purchasing channels (managers)', ['manager', 'operational_manager'], 'purchasing'),

  // ---- reports -------------------------------------------------------------------------------
  C('reports.daily.notes', 'reports', 'Write notes on the daily reports', ['workshop', 'operational_manager', 'manager', 'storekeeper']),
  C('reports.repair_sections.sync', 'reports', 'Re-sync labour into the repair sections report', ['operational_manager', 'workshop']),
];

const CAP_KEYS = CAPABILITIES.map((c) => c.key);
const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));
const isCapability = (k) => BY_KEY.has(k);

// The roles that ship with the system: every role named by an old check (its capabilities are
// seeded by name) AND every role in the default clearance matrix (its section levels are seeded by
// name). A new role may not take one of these names, or it would silently inherit that seeding —
// and they are marked built-in on the Access screen. Viewer and main storekeeper are only in the
// second list: no old check ever named them.
const RESERVED_ROLE_NAMES = new Set(['admin', ...CAPABILITIES.flatMap((c) => c.legacy),
  ...Object.keys(require('./permissions').DEFAULT_MATRIX)]);

/**
 * Give every built-in role the capabilities it had under the old checks. Idempotent (INSERT OR
 * IGNORE), keyed by role NAME so a role created later — by the seed, a migration or a test —
 * is covered the moment it exists. It never re-grants a capability an admin has taken away:
 * taking one away stores granted = 0 rather than deleting the row.
 */
function seedCapabilities() {
  let seeded = 0;
  for (const c of CAPABILITIES) {
    for (const role of c.legacy) {
      seeded += run('INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES (?, ?, 1)', role, c.key).changes;
    }
  }
  return { seeded };
}

/** Every capability a set of roles holds. Admin holds all of them. */
function capsForRoles(roles) {
  if (!roles || !roles.length) return [];
  if (roles.includes('admin')) return CAP_KEYS.slice();
  const marks = roles.map(() => '?').join(',');
  return all(`SELECT DISTINCT capability FROM role_capabilities WHERE granted = 1 AND role IN (${marks})`, ...roles)
    .map((r) => r.capability)
    .filter(isCapability)
    .sort();
}

/** For the screens: which of these capabilities also need EDIT clearance on a section. */
function needsFor(caps) {
  const out = {};
  for (const k of caps) { const c = BY_KEY.get(k); if (c && c.needs) out[k] = c.needs; }
  return out;
}

/** Capabilities granted to one role (admin: all). */
function capsForRole(role) {
  return capsForRoles([role]);
}

/** Grant or take away one capability. Admin is not editable — it always holds everything. */
function setCapability(role, capability, granted) {
  if (role === 'admin') { const e = new Error('Admin always holds every permission and cannot be changed'); e.status = 400; throw e; }
  if (!isCapability(capability)) { const e = new Error(`Unknown permission: ${capability}`); e.status = 400; throw e; }
  run(`INSERT INTO role_capabilities (role, capability, granted, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(role, capability) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at`,
    role, capability, granted ? 1 : 0);
}

module.exports = {
  CAPABILITIES, CAP_KEYS, RESERVED_ROLE_NAMES,
  isCapability, seedCapabilities, capsForRoles, capsForRole, setCapability, needsFor,
  get: (k) => BY_KEY.get(k),
};
