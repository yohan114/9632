'use strict';

// ===========================================================================
// Capabilities — WHAT a person may do, one named action at a time.
//
// Access Resolution Order (WorkshopOne Plan Part B):
//   1. Admin role always holds every capability.
//   2. Temporary access expiration (user.access_until): expired -> none.
//   3. Role starting template: base set from role_capabilities.
//   4. Person-by-person overrides in user_capabilities:
//      granted = 1 -> granted specifically to this user
//      granted = 0 -> explicitly revoked from this user
// ===========================================================================

const { all, run } = require('../db');

const C = (key, module, label, legacy, needs = null, section = null) => ({
  key, module, label, legacy, needs, section: section || module
});

const CAPABILITIES = [
  // ---- administration ------------------------------------------------------------------------
  C('users.manage', 'users', 'Create accounts, reset passwords, assign roles', [], null, 'access'),
  C('access.manage', 'users', 'Create and edit roles, their permissions and section clearance', [], null, 'access'),
  C('system.status', 'users', 'See backup and system health', [], null, 'access'),

  // ---- fleet ---------------------------------------------------------------------------------
  C('assets.create', 'assets', 'Register a new vehicle or machine', ['storekeeper'], 'assets', 'assets'),
  C('assets.edit', 'assets', 'Edit a vehicle or machine', ['storekeeper'], 'assets', 'assets'),
  C('assets.move', 'assets', 'Move a machine to another project or site', ['transport_manager', 'operational_manager', 'manager'], null, 'operations'),
  C('aliases.vehicle.resolve', 'aliases', 'Link or dismiss an unrecognised vehicle name', ['storekeeper'], null, 'aliases'),
  C('aliases.mechanic.resolve', 'aliases', 'Link an unrecognised mechanic name', ['storekeeper', 'manager'], null, 'aliases'),
  C('projects.manage', 'projects', 'Create and edit projects and their sites', ['manager'], null, 'projects'),
  C('workshops.manage', 'projects', 'Add, rename and retire workshops', [], null, 'workshops'),
  C('workshops.all', 'users', 'Work across all workshops (head office)', ['manager', 'operational_manager', 'purchase_head_office', 'purchase_local'], null, 'workshops'),
  C('fleet.capacities.edit', 'assets', 'Add, edit or delete vehicle lubricant capacities', [], null, 'lubricants'),

  // ---- labour --------------------------------------------------------------------------------
  C('mechanics.create', 'labour', 'Add a mechanic', ['manager'], null, 'labour'),
  C('labour.rates.edit', 'labour', 'Set a mechanic\'s labour rate', ['manager'], null, 'labour'),
  C('mechanics.move', 'labour', 'Move a mechanic to another workshop', ['manager'], null, 'labour'),

  // ---- job cards -----------------------------------------------------------------------------
  C('jobs.create', 'jobs', 'Open a new job card', ['transport_manager', 'workshop'], 'jobs', 'jobs'),
  C('jobs.edit', 'jobs', 'Change a job card\'s vehicle, description or type', ['workshop', 'operational_manager', 'manager'], 'jobs', 'jobs'),
  C('jobs.edit_closed', 'jobs', 'Change items on a CLOSED job card', ['workshop', 'storekeeper', 'manager'], 'jobs', 'jobs'),
  C('jobs.approve_transport', 'jobs', 'Approve a job card — transport step', ['transport_manager'], 'jobs', 'jobs'),
  C('jobs.approve_operations', 'jobs', 'Approve a job card — operations step', ['operational_manager'], 'jobs', 'jobs'),
  C('jobs.assign_workshop', 'jobs', 'Take an approved job card into the workshop', ['workshop'], 'jobs', 'jobs'),
  C('jobs.start', 'jobs', 'Start work on a job card', ['workshop'], 'jobs', 'jobs'),
  C('jobs.complete', 'jobs', 'Mark a job card\'s work complete', ['workshop'], 'jobs', 'jobs'),
  C('jobs.close', 'jobs', 'Close a job card', ['operational_manager', 'workshop'], 'jobs', 'jobs'),
  C('jobs.close_on_date', 'jobs', 'Close a job card on a chosen (past) date', ['operational_manager', 'workshop', 'manager'], 'jobs', 'jobs'),
  C('jobs.reject', 'jobs', 'Reject a job card at an approval step', ['transport_manager', 'operational_manager'], 'jobs', 'jobs'),
  C('jobs.return', 'jobs', 'Send a job card back to "requested"', ['transport_manager', 'operational_manager'], 'jobs', 'jobs'),
  C('jobs.reopen', 'jobs', 'Reopen a CLOSED job card', ['operational_manager', 'manager', 'workshop'], 'jobs', 'jobs'),
  C('jobs.reason', 'jobs', 'Say why a job in the workshop is not being worked on', ['workshop', 'transport_manager', 'operational_manager', 'manager'], 'jobs', 'jobs'),
  C('jobs.dailywork', 'jobs', 'Add or remove daily work on a job card', ['workshop'], 'jobs', 'jobs'),
  C('jobs.parts', 'jobs', 'Add, price or remove parts on a job card', ['workshop', 'storekeeper'], 'jobs', 'jobs'),
  C('jobs.flat_labour', 'jobs', 'Set a service job\'s flat labour charge', ['workshop', 'operational_manager'], 'jobs', 'jobs'),
  C('jobs.triage', 'jobs', 'Review stuck job cards and reject or close them in bulk', [], 'jobs', 'jobs'),
  C('jobs.partial_close', 'jobs', 'Partly close a job card (work done, prices still missing)', ['operational_manager', 'workshop'], 'jobs', 'jobs'),
  C('jobs.reopen_request', 'jobs', 'Ask for a partly closed or closed job card to be reopened', ['workshop', 'operational_manager', 'manager'], 'jobs', 'jobs'),
  C('jobs.settings', 'jobs', 'Switch partial close and reopen requests on or off', [], null, 'jobs'),
  C('jobs.breakdown', 'jobs', 'Report a breakdown in the field (opens a field job card)', ['transport_manager', 'assistant_transport_manager', 'workshop', 'operational_manager', 'manager'], null, 'field'),
  C('jobs.field', 'jobs', 'Record field work on a job card (site, times, km)', ['workshop', 'operational_manager', 'manager'], 'jobs', 'field'),

  // ---- job requests --------------------------------------------------------------------------
  C('jobrequests.create', 'jobrequests', 'Raise a job request', ['assistant_transport_manager'], 'jobrequests', 'jobs'),
  C('jobrequests.certify', 'jobrequests', 'Certify a job request', ['transport_manager'], 'jobrequests', 'jobs'),
  C('jobrequests.approve', 'jobrequests', 'Approve a job request', ['operational_manager', 'manager'], 'jobrequests', 'jobs'),
  C('jobrequests.reject', 'jobrequests', 'Reject a job request', ['transport_manager', 'operational_manager', 'manager'], 'jobrequests', 'jobs'),

  // ---- daily work ----------------------------------------------------------------------------
  C('dailywork.add', 'dailywork', 'Add daily work entries', ['workshop', 'manager', 'storekeeper'], 'dailywork', 'dailywork'),
  C('dailywork.edit', 'dailywork', 'Edit, bulk-log or delete daily work', ['workshop', 'manager'], 'dailywork', 'dailywork'),

  // ---- attendance (src/lib/attendance.js) ----------------------------------------------------
  C('attendance.record', 'dailywork', 'Record and edit mechanic attendance (today and yesterday)', ['workshop', 'manager'], null, 'dailywork'),
  C('attendance.unlock', 'dailywork', 'Unlock an attendance day older than yesterday, or already signed off', ['manager', 'operational_manager'], null, 'dailywork'),
  C('attendance.signoff', 'dailywork', 'Sign off a day\'s attendance and work tallies (locks the day)', ['workshop', 'manager'], null, 'dailywork'),
  C('attendance.settings', 'dailywork', 'Switch attendance and workday sign-offs on or off', [], null, 'dailywork'),

  // ---- stores (stores plan) ------------------------------------------------------------------
  C('stores.items.edit', 'stores', 'Create or edit store catalogue items and their prices', ['storekeeper'], 'stores', 'stores'),
  C('stores.items.txn', 'stores', 'Record manual stock receipts, adjustments and issues', ['storekeeper'], 'stores', 'stores'),
  C('stores.categories.edit', 'stores', 'Add or rename store item categories', ['storekeeper'], 'stores', 'stores'),
  C('stores.mrn.create', 'stores', 'Raise a Material Requisition Note (MRN)', ['storekeeper', 'workshop', 'assistant_transport_manager'], 'stores', 'stores'),
  C('stores.mrn.edit', 'stores', 'Change or cancel an open MRN', ['storekeeper', 'workshop'], 'stores', 'stores'),
  C('stores.mrn.certify', 'stores', 'Certify an MRN (workshop step)', ['workshop'], null, 'stores'),
  C('stores.mrn.approve', 'stores', 'Approve an MRN (operations step, up to your limit)', ['operational_manager', 'manager'], null, 'stores'),
  C('stores.mrn.reject', 'stores', 'Reject an MRN at certify or approve step', ['workshop', 'operational_manager', 'manager'], null, 'stores'),
  C('stores.mrn.amend_settled', 'stores', 'Amend a settled MRN after issues have posted', ['operational_manager', 'manager'], 'stores', 'stores'),
  C('stores.grn.receive', 'stores', 'Receive goods into the workshop store (GRN)', ['storekeeper'], 'stores', 'stores'),
  C('stores.grn.edit', 'stores', 'Price or edit a goods receipt (GRN)', ['storekeeper'], 'stores', 'stores'),
  C('stores.issue', 'stores', 'Hand over parts against an approved MRN', ['storekeeper'], 'stores', 'stores'),
  C('stores.stock_issue', 'stores', 'Issue catalogue parts from the shelf onto a job card', ['storekeeper'], 'stores', 'stores'),
  C('stores.reorder_mrn', 'stores', 'Generate restock MRNs from stock cockpit reorder lines', ['storekeeper', 'manager'], 'stores', 'stores'),
  C('stores.stock.rebuild', 'stores', 'Rebuild stock balances from the ledgers (maintenance)', ['storekeeper', 'manager'], 'stores', 'stores'),
  C('stores.mtn.edit', 'stores', 'Create, send, receive or cancel Material Transfer Notes (MTN)', ['storekeeper'], 'stores', 'stores'),
  C('stores.issue_return', 'stores', 'Return an issued part to store stock', ['storekeeper'], 'stores', 'stores'),
  C('stores.stock.count', 'stores', 'Open and record physical stock counts', ['storekeeper', 'manager'], 'stores', 'stores'),
  C('stores.stock.levels', 'stores', 'Set a store\'s reorder levels', ['storekeeper', 'manager'], 'stores', 'stores'),
  C('stores.count.approve', 'stores', 'Approve a stock take and put its corrections into stock (head office)', ['operational_manager', 'manager'], null, 'stores'),
  C('stores.disposal.edit', 'stores', 'Write a disposal note (scrap and waste oil to sell)', ['storekeeper'], 'stores', 'stores'),
  C('stores.disposal.approve', 'stores', 'Approve a disposal note, with the buyer, amount and date', ['operational_manager', 'manager'], null, 'stores'),
  C('general.items.edit', 'stores', 'Add a general rack item', ['storekeeper'], 'stores', 'stores'),
  C('general.stock.adjust', 'stores', 'Adjust a general rack item\'s stock', ['storekeeper'], 'stores', 'stores'),
  C('general.items.price', 'stores', 'Set a general rack item\'s price', ['storekeeper'], 'stores', 'stores'),

  // ---- oil & lubricants ----------------------------------------------------------------------
  C('oil.identity.resolve', 'oil', 'Decide which oil-book product a lubricant name is', ['storekeeper'], 'oil', 'stores'),
  C('oil.products.edit', 'oil', 'Add or edit an oil product', ['storekeeper'], 'oil', 'stores'),
  C('oil.prices.edit', 'oil', 'Set oil prices', ['storekeeper'], 'oil', 'stores'),
  C('oil.ledger.post', 'oil', 'Post oil receipts and issues', ['storekeeper'], 'oil', 'stores'),
  C('oil.count', 'oil', 'Record an oil stock count', ['storekeeper'], 'oil', 'stores'),

  // ---- batteries -----------------------------------------------------------------------------
  C('batteries.register', 'batteries', 'Register a battery', ['storekeeper'], 'batteries', 'stores'),
  C('batteries.photos', 'batteries', 'Add, change or remove battery photos', ['storekeeper'], 'batteries', 'stores'),
  C('batteries.event', 'batteries', 'Record a battery event (fitted, removed, returned …)', ['storekeeper'], 'batteries', 'stores'),

  // ---- filters & service records -------------------------------------------------------------
  C('services.attachments', 'filters', 'Upload or delete service record attachments', ['workshop', 'storekeeper', 'operational_manager', 'manager'], null, 'services'),
  C('filters.stock.edit', 'filters', 'Add a filter stock item', ['storekeeper'], 'filters', 'stores'),
  C('filters.stock.receive', 'filters', 'Receive filters into stock', ['storekeeper'], 'filters', 'stores'),
  C('filters.stock.issue', 'filters', 'Issue filters from stock', ['storekeeper'], 'filters', 'stores'),

  // ---- tyres & batteries (requests) ----------------------------------------------------------
  C('tb.specs.edit', 'tb_request', 'Edit tyre and battery specifications', ['manager', 'operational_manager'], null, 'tb_requests'),

  // ---- purchasing ----------------------------------------------------------------------------
  C('purchasing.head_office', 'purchasing', 'Work the Head Office purchasing channel', ['purchase_head_office'], 'purchasing', 'purchasing'),
  C('purchasing.local', 'purchasing', 'Work the Local purchasing channel', ['purchase_local'], 'purchasing', 'purchasing'),
  C('purchasing.all_channels', 'purchasing', 'Work both purchasing channels (managers)', ['manager', 'operational_manager'], 'purchasing', 'purchasing'),

  // ---- reports -------------------------------------------------------------------------------
  C('reports.daily.notes', 'reports', 'Write notes on the daily reports', ['workshop', 'operational_manager', 'manager', 'storekeeper'], null, 'daily_progress'),
  C('reports.repair_sections.sync', 'reports', 'Re-sync labour into the repair sections report', ['operational_manager', 'workshop'], null, 'reports'),
  C('reports.monthly_cost.edit', 'reports', 'Edit monthly vehicle cost inputs (fuel, depreciation, insurance, etc.)', ['manager', 'operational_manager'], null, 'reports'),
];

const CAP_KEYS = CAPABILITIES.map((c) => c.key);
const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));
const isCapability = (k) => BY_KEY.has(k);

const RESERVED_ROLE_NAMES = new Set(['admin', ...CAPABILITIES.flatMap((c) => c.legacy),
  ...Object.keys(require('./permissions').DEFAULT_MATRIX)]);

function seedCapabilities() {
  let seeded = 0;
  for (const c of CAPABILITIES) {
    for (const role of c.legacy) {
      seeded += run('INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES (?, ?, 1)', role, c.key).changes;
    }
  }
  return { seeded };
}

/** Every capability a set of roles holds. Admin holds all. */
function capsForRoles(roles) {
  if (!roles || !roles.length) return [];
  if (roles.includes('admin')) return CAP_KEYS.slice();
  const marks = roles.map(() => '?').join(',');
  return all(`SELECT DISTINCT capability FROM role_capabilities WHERE granted = 1 AND role IN (${marks})`, ...roles)
    .map((r) => r.capability)
    .filter(isCapability)
    .sort();
}

/** Every capability a specific USER holds (incorporates user_capabilities overrides on top of role template). */
function effectiveCaps(user) {
  if (!user) return [];
  const roles = user.roles || [];
  if (roles.includes('admin')) return CAP_KEYS.slice();

  // Temporary access check
  if (user.access_until) {
    const until = new Date(user.access_until);
    if (!isNaN(until.getTime()) && until < new Date()) {
      return [];
    }
  }

  // Start with role capabilities
  const set = new Set(capsForRoles(roles));

  // Apply user-level capability overrides
  if (user.id) {
    const userCaps = all('SELECT capability, granted FROM user_capabilities WHERE user_id = ?', user.id);
    for (const uc of userCaps) {
      if (isCapability(uc.capability)) {
        if (uc.granted) set.add(uc.capability);
        else set.delete(uc.capability);
      }
    }
  }

  return Array.from(set).sort();
}

function needsFor(caps) {
  const out = {};
  for (const k of caps) { const c = BY_KEY.get(k); if (c && c.needs) out[k] = c.needs; }
  return out;
}

function capsForRole(role) {
  return capsForRoles([role]);
}

function setCapability(role, capability, granted) {
  if (role === 'admin') { const e = new Error('Admin always holds every permission and cannot be changed'); e.status = 400; throw e; }
  if (!isCapability(capability)) { const e = new Error(`Unknown permission: ${capability}`); e.status = 400; throw e; }
  run(`INSERT INTO role_capabilities (role, capability, granted, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(role, capability) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at`,
    role, capability, granted ? 1 : 0);
}

function setUserCapability(userId, capability, granted) {
  if (!isCapability(capability)) { const e = new Error(`Unknown permission: ${capability}`); e.status = 400; throw e; }
  run(`INSERT INTO user_capabilities (user_id, capability, granted, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, capability) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at`,
    userId, capability, granted ? 1 : 0);
}

function removeUserCapability(userId, capability) {
  run('DELETE FROM user_capabilities WHERE user_id = ? AND capability = ?', userId, capability);
}

function clearUserCapabilities(userId) {
  run('DELETE FROM user_capabilities WHERE user_id = ?', userId);
}

module.exports = {
  CAPABILITIES, CAP_KEYS, RESERVED_ROLE_NAMES,
  isCapability, seedCapabilities, capsForRoles, effectiveCaps, capsForRole, setCapability,
  setUserCapability, removeUserCapability, clearUserCapabilities, needsFor,
  get: (k) => BY_KEY.get(k),
};
