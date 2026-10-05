'use strict';

// ===========================================================================
// Scoping (multi-site Stage 3) — each workshop sees its own work.
//
// People outside head office see and work on only their own workshop's job cards, job requests,
// requests (MRN), daily work and approval queues. Everything here is switched off until the admin
// turns on "Separate workshops" (Workshops page) AND there is more than one active workshop; until
// then every check below lets everything through and nobody sees less than before.
//
// Who still sees every workshop: head office — the admin, and anyone holding workshops.all
// (Manager, Operational Manager, Purchasing by default — src/lib/capabilities.js).
//
// Store staff (who receive or issue goods) see the job cards and requests of every workshop their
// store serves (Stage 4, src/lib/stores.js): their own workshop's store, and each workshop that uses
// it. While one store serves every workshop, that is every workshop, as in Stage 3.
//
// Shared, not scoped here: vehicles (they move between workshops), and reports (Stage 5). Stock is
// kept per store (src/lib/stores.js) and attendance per workshop. The one-open-card-per-vehicle rule
// stays across all workshops.
// ===========================================================================

const { get, all, run } = require('../db');
const workshops = require('./workshops');

const FLAG = 'workshops_separate';

function switchedOn() {
  const r = get('SELECT value FROM settings WHERE key = ?', FLAG);
  return !!(r && r.value === '1');
}

function setSwitch(actor, on) {
  run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, FLAG, on ? '1' : '0');
  require('./audit').record({ userId: actor.id, entity: 'settings', entityId: null, action: on ? 'workshops_separate_on' : 'workshops_separate_off' });
}

/** Scoping is in force: switched on, and there is more than one workshop to keep apart. */
const enabled = () => switchedOn() && workshops.isMulti();

const isAdmin = (user) => !!(user && (user.roles || []).includes('admin'));
const headOffice = (user) => isAdmin(user) || require('./auth').hasCap(user, 'workshops.all');
const storeStaff = (user) => require('./auth').hasCap(user, 'stores.grn.receive', 'stores.issue');

/** Sees every workshop's job requests (scoping off, or head office). */
const seesAll = (user) => !enabled() || headOffice(user);

/**
 * The workshops a person sees, or null when they see them all. Store staff (unless opts.store is
 * false): every workshop their store serves. Anyone else: their home workshop.
 */
function reach(user, { store = true } = {}) {
  if (seesAll(user)) return null;
  const home = workshops.homeOf(user);
  if (store && storeStaff(user)) {
    const stores = require('./stores');
    const served = stores.servedBy(stores.storeOf(home));
    // One store serving every workshop: everything, exactly as before there were several.
    if (all('SELECT id FROM workshops WHERE active = 1').every((w) => served.includes(w.id))) return null;
    return served.includes(home) ? served : [home, ...served];
  }
  return [home];
}

/** Sees every workshop's job cards and requests (MRN): head office, or a store serving them all. */
const seesAllJobs = (user) => reach(user) == null;

/** The one workshop a scoped person works in (their home), or null when they see them all. */
function onlyWorkshop(user, opts) {
  return reach(user, opts) == null ? null : workshops.homeOf(user);
}

/**
 * A WHERE fragment keeping a list to the person's workshops: { sql, params }. `sql` is '' when they
 * see everything, so callers can push it onto their clauses unchanged.
 */
function filter(user, column, opts) {
  const r = reach(user, opts);
  if (r == null) return { sql: '', params: [] };
  return r.length === 1 ? { sql: `${column} = ?`, params: r } : { sql: `${column} IN (${r.map(() => '?').join(',')})`, params: r };
}

/** May this person see a record that belongs to `workshopId`? */
function mayReach(user, workshopId, opts) {
  const r = reach(user, opts);
  return r == null || r.includes(workshopId);
}

/**
 * Three states: mine (mayReach), visible (mayRead), or out of reach.
 * Cross-workshop viewing applies to 'job' and 'service' records for users holding jobs.view_other_workshops.
 */
function mayRead(user, workshopId, kind) {
  if (mayReach(user, workshopId)) return true;
  if ((kind === 'job' || kind === 'service') && require('./auth').hasCap(user, 'jobs.view_other_workshops')) {
    return true;
  }
  return false;
}

/**
 * Filter for readable records: shows all workshops when the person holds cross-workshop read capability.
 */
function readFilter(user, column, kind) {
  if (seesAll(user)) return { sql: '', params: [] };
  if ((kind === 'job' || kind === 'service') && require('./auth').hasCap(user, 'jobs.view_other_workshops')) {
    return { sql: '', params: [] };
  }
  return filter(user, column);
}

/**
 * True when a record is visible but cannot be edited by this person.
 */
function isReadOnly(user, workshopId) {
  if (!enabled() || headOffice(user)) return false;
  return !mayReach(user, workshopId);
}

/**
 * Whose reports a person reads (Stage 5). { ws, fixed, choices }: `ws` null = every workshop;
 * `choices` null = any workshop or all of them.
 *   - one workshop: the whole company, as always;
 *   - head office (and everyone, while the workshops are not kept apart): the one asked for, else all;
 *   - anyone else: their own workshop — store staff may pick among the workshops their store serves.
 */
function reportWorkshop(user, asked) {
  if (!workshops.isMulti()) return { ws: null, fixed: false, choices: null };
  const a = Number(asked) || null;
  const r = reach(user);
  if (r == null) return { ws: a && workshops.byId(a) ? a : null, fixed: false, choices: null };
  return { ws: a && r.includes(a) ? a : workshops.homeOf(user), fixed: r.length === 1, choices: r };
}

/** The 403 body for a record of another workshop: what it is and whose it is. */
function refusal(what, workshopId) {
  const w = workshops.byId(workshopId);
  const name = w ? w.name : 'another workshop';
  return { error: `This ${what} belongs to ${name}.`, other_workshop: w ? { id: w.id, name: w.name } : null };
}

/**
 * Guard a job card by id: null when the person may reach it (or it does not exist — the route's
 * own 404 says so), else the 403 body.
 */
function jobRefusal(user, jobId) {
  if (!enabled()) return null;
  const j = get('SELECT workshop_id FROM job_cards WHERE id = ?', jobId);
  if (!j || mayReach(user, j.workshop_id)) return null;
  return refusal('job card', j.workshop_id);
}

function jobReadRefusal(user, jobId) {
  if (!enabled()) return null;
  const j = get('SELECT workshop_id FROM job_cards WHERE id = ?', jobId);
  if (!j || mayRead(user, j.workshop_id, 'job')) return null;
  return refusal('job card', j.workshop_id);
}

function mrnRefusal(user, mrnId) {
  if (!enabled()) return null;
  const m = get('SELECT workshop_id FROM mrn WHERE id = ?', mrnId);
  if (!m || mayReach(user, m.workshop_id)) return null;
  return refusal('request', m.workshop_id);
}

function jobRequestRefusal(user, jrId) {
  if (!enabled()) return null;
  const r = get('SELECT workshop_id FROM job_requests WHERE id = ?', jrId);
  if (!r || mayReach(user, r.workshop_id, { store: false })) return null;
  return refusal('job request', r.workshop_id);
}

/** Express guard for routers whose `:id` is a job card (router.param). */
function jobParam(req, res, next, id) {
  const no = jobRefusal(req.user, Number(id));
  return no ? res.status(403).json(no) : next();
}

function jobReadParam(req, res, next, id) {
  const no = jobReadRefusal(req.user, Number(id));
  return no ? res.status(403).json(no) : next();
}

// ---- The rest of a workshop's own records (improvement plan, Step 2) --------------------------
// Service records and tools belong to a workshop, like job cards. Stock and the things kept on a
// store's shelf — oil, general items, tyres, batteries — belong to a store (Stage 4), and someone
// kept to their own workshop sees their own store's.

/** A service record by id: null when the person may reach it (or it does not exist), else the 403 body. */
function serviceRefusal(user, serviceId) {
  if (!enabled()) return null;
  const s = get('SELECT workshop_id FROM service_jobs WHERE id = ?', serviceId);
  if (!s || mayReach(user, s.workshop_id)) return null;
  return refusal('service record', s.workshop_id);
}

function serviceReadRefusal(user, serviceId) {
  if (!enabled()) return null;
  const s = get('SELECT workshop_id FROM service_jobs WHERE id = ?', serviceId);
  if (!s || mayRead(user, s.workshop_id, 'service')) return null;
  return refusal('service record', s.workshop_id);
}

/** A tool by id: as serviceRefusal. */
function toolRefusal(user, toolId) {
  if (!enabled()) return null;
  const t = get('SELECT workshop_id FROM workshop_tools WHERE id = ?', toolId);
  if (!t || mayReach(user, t.workshop_id)) return null;
  return refusal('tool', t.workshop_id);
}

/**
 * The store a person's stock screens are kept to, or null when they see every store: with the
 * workshops kept apart and more than one store, someone outside head office sees their own.
 */
function ownStore(user) {
  const stores = require('./stores');
  if (!enabled() || headOffice(user) || !stores.isMulti()) return null;
  return stores.homeStore(user);
}

/** A row filed with no store is the main store's — everything recorded before Stage 4 is. */
const storeOfRow = (column) => `COALESCE(${column}, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1))`;

/** A WHERE fragment keeping store-filed rows to the person's store: { sql, params }, '' for all. */
function storeFilter(user, column) {
  const s = ownStore(user);
  return s == null ? { sql: '', params: [] } : { sql: `${storeOfRow(column)} = ?`, params: [s] };
}

/** Something filed in `storeId`, by id: null when the person may reach it, else the 403 body. */
function storeRefusal(user, what, storeId) {
  const s = ownStore(user);
  const at = storeId || workshops.defaultId();
  if (s == null || at === s) return null;
  const w = workshops.byId(at);
  return { error: `This ${what} is in ${w ? w.name : 'another workshop'}'s store.`, other_workshop: w ? { id: w.id, name: w.name } : null };
}

// ---- Reports (improvement plan, Step 2b) ------------------------------------------------------

/** Whose report this is: one workshop's id, or null for the whole company (reportWorkshop). */
const reportWs = (user, asked) => reportWorkshop(user, asked).ws;

/**
 * SQL keeping a report's rows to `ws`: null (every workshop), one workshop id, or a list of them
 * (scope.reach). '' when it is every workshop, else ' AND …'. A row with no workshop is the main
 * one's, as everything recorded before there were several is. Ids are numbers, so they are written
 * into the SQL as they are.
 */
function wsSql(column, ws) {
  if (ws == null) return '';
  const ids = [].concat(ws).map(Number).filter(Number.isInteger);
  if (!ids.length) return ' AND 0';
  return ` AND ${storeOfRow(column)} ${ids.length === 1 ? `= ${ids[0]}` : `IN (${ids.join(',')})`}`;
}

module.exports = {
  FLAG, switchedOn, setSwitch, enabled, headOffice, storeStaff, seesAll, seesAllJobs, reach, onlyWorkshop,
  filter, mayReach, mayRead, readFilter, isReadOnly, reportWorkshop, refusal, jobRefusal, jobReadRefusal, mrnRefusal, jobRequestRefusal, jobParam,
  jobReadParam, serviceRefusal, serviceReadRefusal, toolRefusal, ownStore, storeOfRow, storeFilter, storeRefusal, reportWs, wsSql,
};
