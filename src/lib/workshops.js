'use strict';

// ===========================================================================
// Workshops (multi-site Stage 2) — the places that repair vehicles.
//
// A WORKSHOP has its own mechanics and job cards. A SITE is where a vehicle works: that is the
// projects list and its sites, not this. The system starts with one workshop, Central Workshop —
// Badalgama, the default, and every existing record belongs to it (src/db/index.js).
//
// Stage 2 records who and what belongs where; nobody sees less than before. Showing each person
// only their own workshop is Stage 3, stock per workshop Stage 4. Until a second workshop is
// added, `isMulti()` is false and the screens look exactly as they did.
//
//   users.workshop_id       the person's home workshop ("All workshops" is the workshops.all
//                           permission, from the role — the head-office view)
//   job_cards.workshop_id   who does the repair (separate from project_id: who the vehicle works for)
//   mrn.workshop_id         which workshop asked (its job card's, else the person's)
//   mechanic_workshops      a mechanic's workshop from a date, so old hours stay where they were
// ===========================================================================

const { get, all, run, tx } = require('../db');

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const audit = (...a) => require('./audit').record(...a);

function defaultId() {
  const w = get('SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1');
  return w ? w.id : null;
}

const byId = (id) => get('SELECT * FROM workshops WHERE id = ?', id);
const activeCount = () => get('SELECT COUNT(*) n FROM workshops WHERE active = 1').n;
/** More than one active workshop: only then do the screens show workshop pickers and filters. */
const isMulti = () => activeCount() > 1;

/**
 * The mechanic's workshop on a day: the row with the latest from_date on or before it (the
 * earliest row if the day is before them all). SQL, for use inside a query.
 */
function mechanicWorkshopSql(mechAlias, dateExpr = 'date(\'now\')') {
  return `COALESCE(
    (SELECT mw.workshop_id FROM mechanic_workshops mw WHERE mw.mechanic_id = ${mechAlias}.id AND mw.from_date <= ${dateExpr}
      ORDER BY mw.from_date DESC, mw.id DESC LIMIT 1),
    (SELECT mw.workshop_id FROM mechanic_workshops mw WHERE mw.mechanic_id = ${mechAlias}.id ORDER BY mw.from_date, mw.id LIMIT 1),
    (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1))`;
}

function mechanicWorkshop(mechanicId, date = today()) {
  const r = get(`SELECT ${mechanicWorkshopSql('m', '?')} AS w FROM mechanics m WHERE m.id = ?`, date, mechanicId);
  return r ? r.w : null;
}

/** Every workshop, with how many people, mechanics and open job cards belong to it. */
function list() {
  const { notFinalSql } = require('./jobstate');
  return all(`SELECT w.*,
      (SELECT COUNT(*) FROM users u WHERE u.workshop_id = w.id AND u.active = 1) AS users,
      (SELECT COUNT(*) FROM mechanics m WHERE COALESCE(m.active, 1) = 1 AND ${mechanicWorkshopSql('m')} = w.id) AS mechanics,
      (SELECT COUNT(*) FROM job_cards j WHERE j.workshop_id = w.id AND ${notFinalSql('j')}) AS open_jobs
    FROM workshops w ORDER BY w.active DESC, w.is_default DESC, w.name`);
}

/** A workshop someone chose: it must exist and be in use. */
function mustBeActive(id) {
  const w = byId(Number(id));
  if (!w) fail(400, 'No such workshop');
  if (!w.active) fail(400, `${w.name} is retired`);
  return w;
}

/** This person's home workshop (the default if they have none). */
function homeOf(user) {
  if (!user) return defaultId();
  const u = get('SELECT workshop_id FROM users WHERE id = ?', user.id);
  const w = u && u.workshop_id && byId(u.workshop_id);
  return w && w.active ? w.id : defaultId();
}

/**
 * The workshop for a new record: the one asked for (must be active), else the person's home.
 * `asked` is whatever came in the request body — blank means "not asked".
 */
function forNew(user, asked) {
  if (asked !== undefined && asked !== null && String(asked).trim() !== '') return mustBeActive(asked).id;
  return homeOf(user);
}

/** A new request (MRN): its job card's workshop, else the person's home workshop. */
function forRequest(user, jobId) {
  const j = jobId ? get('SELECT workshop_id FROM job_cards WHERE id = ?', jobId) : null;
  return (j && j.workshop_id) || homeOf(user);
}

// ---- managing the list ---------------------------------------------------------------------

function create(actor, body) {
  const code = clean(body.code, 10).toUpperCase();
  const name = clean(body.name, 80);
  if (!/^[A-Z0-9-]{1,10}$/.test(code)) fail(400, 'Give a short code: letters and numbers, up to 10 (e.g. MTR).');
  if (name.length < 3) fail(400, 'Give the workshop a name.');
  if (get('SELECT 1 FROM workshops WHERE code = ? OR LOWER(name) = LOWER(?)', code, name)) fail(409, 'A workshop with that code or name already exists.');
  const id = run('INSERT INTO workshops (code, name, place) VALUES (?, ?, ?)', code, name, clean(body.place, 80) || null).lastInsertRowid;
  audit({ userId: actor.id, entity: 'workshop', entityId: id, action: 'create', after: byId(id) });
  return byId(id);
}

function update(actor, id, body) {
  const before = byId(id);
  if (!before) fail(404, 'No such workshop');
  const next = {
    code: body.code !== undefined ? clean(body.code, 10).toUpperCase() : before.code,
    name: body.name !== undefined ? clean(body.name, 80) : before.name,
    place: body.place !== undefined ? (clean(body.place, 80) || null) : before.place,
  };
  if (!/^[A-Z0-9-]{1,10}$/.test(next.code)) fail(400, 'Give a short code: letters and numbers, up to 10 (e.g. MTR).');
  if (next.name.length < 3) fail(400, 'Give the workshop a name.');
  if (get('SELECT 1 FROM workshops WHERE id <> ? AND (code = ? OR LOWER(name) = LOWER(?))', id, next.code, next.name)) {
    fail(409, 'A workshop with that code or name already exists.');
  }
  run('UPDATE workshops SET code = ?, name = ?, place = ? WHERE id = ?', next.code, next.name, next.place, id);
  audit({ userId: actor.id, entity: 'workshop', entityId: id, action: 'update', before, after: byId(id) });
  return byId(id);
}

/**
 * Retire or reinstate. The default workshop cannot be retired, nor one that still has people,
 * mechanics or open job cards — they would belong to a place that no longer exists. Move them first.
 */
function setActive(actor, id, active) {
  const w = list().find((x) => x.id === id);
  if (!w) fail(404, 'No such workshop');
  if (!active) {
    if (w.is_default) fail(409, `${w.name} is the main workshop and cannot be retired.`);
    const left = [w.users && `${w.users} user(s)`, w.mechanics && `${w.mechanics} mechanic(s)`, w.open_jobs && `${w.open_jobs} open job card(s)`].filter(Boolean);
    if (left.length) fail(409, `${w.name} still has ${left.join(', ')}. Move them to another workshop first.`);
  }
  run('UPDATE workshops SET active = ? WHERE id = ?', active ? 1 : 0, id);
  audit({ userId: actor.id, entity: 'workshop', entityId: id, action: active ? 'reinstate' : 'retire' });
  return byId(id);
}

// ---- people and mechanics ------------------------------------------------------------------

/** A mechanic's workshops over time, newest first. */
function mechanicHistory(mechanicId) {
  return all(`SELECT mw.*, w.name AS workshop_name, u.username AS set_by_name
                FROM mechanic_workshops mw JOIN workshops w ON w.id = mw.workshop_id
                LEFT JOIN users u ON u.id = mw.set_by
               WHERE mw.mechanic_id = ? ORDER BY mw.from_date DESC, mw.id DESC`, mechanicId);
}

/**
 * Move a mechanic to a workshop from a date (today or earlier). Not before their last move:
 * history is added to, never rewritten. A move on the same day as the last one replaces it.
 */
function moveMechanic(actor, mechanicId, workshopId, fromDate, note) {
  const m = get('SELECT id, name FROM mechanics WHERE id = ?', mechanicId);
  if (!m) fail(404, 'Mechanic not found');
  const w = mustBeActive(workshopId);
  const date = fromDate ? String(fromDate).slice(0, 10) : today();
  if (!isDate(date)) fail(400, 'Give the date of the move (YYYY-MM-DD).');
  if (date > today()) fail(400, 'The move date cannot be in the future.');
  const last = get('SELECT * FROM mechanic_workshops WHERE mechanic_id = ? ORDER BY from_date DESC, id DESC LIMIT 1', m.id);
  if (last && date < last.from_date) fail(409, `${m.name} last moved on ${last.from_date}. A new move must be on or after that day.`);
  if (mechanicWorkshop(m.id, date) === w.id && !(last && last.from_date === date)) fail(409, `${m.name} is already at ${w.name} on ${date}.`);
  tx(() => {
    if (last && last.from_date === date) {
      run('UPDATE mechanic_workshops SET workshop_id = ?, set_by = ?, set_at = datetime(\'now\'), note = ? WHERE id = ?',
        w.id, actor.id, clean(note, 200) || null, last.id);
    } else {
      run('INSERT INTO mechanic_workshops (mechanic_id, workshop_id, from_date, set_by, note) VALUES (?, ?, ?, ?, ?)',
        m.id, w.id, date, actor.id, clean(note, 200) || null);
    }
  });
  audit({ userId: actor.id, entity: 'mechanic', entityId: m.id, action: 'move_workshop',
    before: { workshop_id: last ? last.workshop_id : null }, after: { workshop_id: w.id, from_date: date }, reason: clean(note, 200) || null });
  return { mechanic: m.name, workshop: w.name, from_date: date };
}

module.exports = {
  defaultId, byId, activeCount, isMulti, list, mustBeActive, homeOf, forNew, forRequest,
  create, update, setActive, mechanicWorkshop, mechanicWorkshopSql, mechanicHistory, moveMechanic,
};
