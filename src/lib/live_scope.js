'use strict';

// ===========================================================================
// Who receives each live update (access plan, Part 4).
//
// The screens refresh themselves when the server says something changed. That note used to go to
// every open screen, whatever the person may see. It carries little (what kind of record, the
// action, an id), but a storekeeper's screen still had no business hearing that a labour rate or a
// person's access had just changed. Now each note goes only to the people who can open a section
// that shows that kind of record:
//
//   - a kind of record lists the section switches whose screens show it; a person receives the
//     note if they have at least View on any of them (their own level, Part 2);
//   - ACCESS: changes to people, roles and access go to those who manage access or accounts;
//   - EVERYONE: a few notes every screen needs (the list of workshops, the settings);
//   - anything not listed goes to admins only, and test/live_scope.test.js fails until each kind
//     of record the code writes is listed here.
// ===========================================================================

const permissions = require('./permissions');

const EVERYONE = 'everyone';
const ACCESS = 'access';

const STORES = ['stores', 'oil', 'batteries', 'filters'];
const JOBS = ['jobs', 'jobrequests', 'field', 'operations', 'dailywork', 'progress', 'attention', 'teardown', 'reports'];
const TB = ['tb_request', 'tb_purchase', 'tb_grn', 'tb_issue', 'tyrebattery', 'stores'];
const FILTERS = ['filters', 'stores', 'services', 'serviceplan'];

// Kind of record (the audit entity) → the switches whose screens show it.
const ENTITY = {
  // job cards and the work on them
  job_card: JOBS,
  job_parts: ['jobs', 'stores'],
  job_daily_work: ['dailywork', 'jobs', 'progress'],
  job_request: ['jobrequests', 'jobs'],
  job_reopen_request: ['jobs'],
  mechanic_attendance: ['dailywork'],
  workday_signoff: ['dailywork'],
  // stores
  store_item: STORES,
  item_category: STORES,
  count_session: STORES,
  store_reorder: STORES,
  stock_items: STORES,
  stock_moves: STORES,
  general_item_txn: STORES,
  mtn: ['stores'],
  disposal: ['stores'],
  issue: ['stores', 'jobs'],
  issues: ['stores', 'jobs'],
  issue_returns: ['stores', 'jobs'],
  mrn: ['stores', 'purchasing', 'jobs'],
  mrn_lines: ['stores', 'purchasing', 'jobs'],
  mrn_line: ['stores', 'purchasing', 'jobs'],
  grn: ['stores', 'purchasing', 'jobs'],
  // oil & lube
  stock_count: ['oil', 'stores'],
  stock_ledger: ['oil', 'stores'],
  product: ['oil', 'stores'],
  product_price: ['oil', 'stores'],
  lubricant_alias: ['oil', 'stores'],
  // filters and service records
  filter_stock: FILTERS,
  filter_price: FILTERS,
  filter_xref: FILTERS,
  service_job: ['services', 'filters', 'serviceplan'],
  service_attachment: ['services'],
  // batteries, tyres and their requests
  battery: ['batteries', 'stores'],
  tyre: TB,
  tyre_battery_issues: TB,
  tb_specs: TB,
  tb_returns: TB,
  // the fleet
  asset: ['assets', 'operations', 'jobs'],
  asset_alias: ['aliases', 'assets'],
  vehicle_lubricant_capacity: ['lubecapacities'],
  // labour and projects
  mechanic: ['labour', 'dailywork', 'aliases'],
  mechanic_alias: ['aliases', 'labour'],
  labour_rate: ['labour'],
  project: ['projects'],
  // every screen: pickers and switches
  workshop: EVERYONE,
  settings: EVERYONE,
  // people and access
  user: ACCESS,
  session: ACCESS,
  role: ACCESS,
  role_permission: ACCESS,
  role_capability: ACCESS,
  user_permission: ACCESS,
  user_capability: ACCESS,
  user_approval_limit: ACCESS,
  approval_limit: ACCESS,
  access_report: ACCESS,
};

// The named events some routes still send beside data_changed. Nothing on the screens listens to
// them today; they follow the same rule, by the records they are about.
const EVENT = {
  job_updated: JOBS,
  dashboard_refresh: JOBS,
  stock_updated: STORES,
  oil_updated: ['oil', 'stores'],
  filter_updated: FILTERS,
  request_updated: ['stores', 'purchasing', 'jobrequests', 'jobs', 'tb_request'],
};

/** Which switches a note is for: an array, EVERYONE, ACCESS, or null (not listed: admins only). */
function audienceOf(event, data) {
  if (event === 'data_changed') return ENTITY[data && data.entity] || null;
  return EVENT[event] || null;
}

const isAdmin = (user) => !!(user && (user.roles || []).includes('admin'));

/**
 * May this person receive this note? `user` is { id, roles, caps, levels } — the same shape a
 * request's user has (src/lib/auth.js), worked out for the open socket.
 */
function allowed(event, data, user) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const who = audienceOf(event, data);
  if (who === EVERYONE) return true;
  if (who === ACCESS) return (user.caps || []).some((c) => c === 'access.manage' || c === 'users.manage');
  if (!who) return false;
  return permissions.reaches(user, who, 'view');
}

// Kinds of record that change who may see what: when one of them changes, every open socket's
// person is worked out again before the next note.
const ACCESS_ENTITIES = new Set(Object.keys(ENTITY).filter((k) => ENTITY[k] === ACCESS && k !== 'session' && k !== 'access_report'));

module.exports = { ENTITY, EVENT, EVERYONE, ACCESS, ACCESS_ENTITIES, audienceOf, allowed };
