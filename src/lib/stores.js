'use strict';

// ===========================================================================
// Stores (multi-site Stage 4, part B) — a store per workshop.
//
// A workshop either has its OWN store or uses another workshop's ("Muthur uses Central's store").
// A store is known by the workshop that owns it, so a store id is a workshop id. The main workshop
// always has its own store, and everything recorded before this stage is in it.
//
// Every stock movement is stamped with the store it happened in, ON THE SOURCE RECORD (the triggers
// in src/db/index.js), so rebuilding stock_moves keeps it:
//   goods received (grn)              the store of the request's workshop
//   an issue of a received line       the store that received it
//   other issues, the oil book,       the store of the job card's workshop; without a card, the
//     general items, services           store of the person who wrote it down
//   tyres and batteries               the store of the job card's (else the request's) workshop
//   a transfer note (mtn_lines)       out of one store and into another, when its two ends are
//                                      workshops with different stores (stampTransfer below)
// The store of a workshop is read AS AT the movement's date: before a workshop opened its own store
// it used another's, and what happened then stays there.
//
// With one store nothing changes: every movement is in it, and no screen shows a store.
// ===========================================================================

const { get, all, run } = require('../db');
const workshops = require('./workshops');

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const audit = (...a) => require('./audit').record(...a);

const DEF = '(SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)';

/**
 * SQL for the store a workshop used on a date; `ws` and `date` are SQL expressions. Its own store
 * from the day it opened, before that (or without one) the store it uses, else the main one's.
 * The alias `sw` is its own, so it can sit inside a query over workshops.
 */
function storeSql(ws, date = "date('now')") {
  return `COALESCE((SELECT CASE WHEN sw.own_store = 1 AND (sw.store_opened IS NULL OR sw.store_opened <= ${date})
                                THEN sw.id ELSE COALESCE(sw.uses_store, ${DEF}) END
                      FROM workshops sw WHERE sw.id = (${ws})), ${DEF})`;
}

/** The store a workshop used on a date (today if none). */
function storeOf(workshopId, date) {
  return get(`SELECT ${storeSql('@ws', '@date')} AS s`, { ws: workshopId || null, date: isDate(date) ? date : today() }).s;
}

const byId = (id) => get('SELECT * FROM workshops WHERE id = ? AND own_store = 1', id);
const activeCount = () => get('SELECT COUNT(*) n FROM workshops WHERE own_store = 1 AND active = 1').n;
/** More than one store: only then is stock kept, shown and counted store by store. */
const isMulti = () => activeCount() > 1;
const label = (storeId) => { const w = workshops.byId(storeId); return w ? w.name : 'another store'; };

/** The active workshops a store serves today: its own, and every one that uses it. */
function servedBy(storeId, date) {
  return all(`SELECT w.id FROM workshops w WHERE w.active = 1 AND ${storeSql('w.id', '@date')} = @store ORDER BY w.id`,
    { date: isDate(date) ? date : today(), store: storeId }).map((r) => r.id);
}

/** Every store, with the workshops it serves. */
function list() {
  const ws = all(`SELECT w.id, w.code, w.name, ${storeSql('w.id')} AS store FROM workshops w WHERE w.active = 1`);
  return all('SELECT id, code, name, is_default, store_opened FROM workshops WHERE own_store = 1 AND active = 1 ORDER BY is_default DESC, name')
    .map((s) => ({ ...s, serves: ws.filter((w) => w.store === s.id).map((w) => ({ id: w.id, code: w.code, name: w.name })) }));
}

/** The store of this person's home workshop. */
const homeStore = (user) => storeOf(workshops.homeOf(user));

/** The store a book entry comes out of: its job card's workshop's, else the person's own. */
function forEntry(user, jobId, date) {
  const j = jobId ? get('SELECT workshop_id FROM job_cards WHERE id = ?', jobId) : null;
  return storeOf(j ? j.workshop_id : workshops.homeOf(user), date);
}

/** Has anything ever moved in or out of this store? */
function hasMovements(storeId) {
  for (const t of ['grn', 'issues', 'general_item_txns', 'stock_ledger', 'tyre_battery_issues', 'service_jobs', 'store_counts']) {
    if (get(`SELECT 1 x FROM ${t} WHERE store_id = ? LIMIT 1`, storeId)) return true;
  }
  return !!get('SELECT 1 x FROM mtn_lines WHERE from_store_id = ? OR to_store_id = ? LIMIT 1', storeId, storeId);
}

/**
 * A workshop's store: open its own (from a date, today or earlier), close it again (only while
 * nothing has moved in it and no other workshop uses it), or choose whose store it uses.
 */
function setStore(actor, workshopId, body = {}) {
  const w = workshops.byId(workshopId);
  if (!w) fail(404, 'No such workshop');
  const before = { own_store: w.own_store, uses_store: w.uses_store, store_opened: w.store_opened };
  const own = body.own === undefined ? !!w.own_store : !!body.own;
  let uses = w.uses_store;
  if (body.uses !== undefined) {
    uses = body.uses === null || body.uses === '' ? null : Number(body.uses);
    if (uses != null) {
      const u = workshops.byId(uses);
      if (!u || !u.own_store || !u.active) fail(400, 'That workshop has no store to use.');
      if (u.id === w.id) fail(400, 'A workshop cannot use its own store as another\'s.');
    }
  }
  let opened = w.store_opened;
  if (own && !w.own_store) {
    if (!w.active) fail(400, `${w.name} is retired`);
    opened = body.opened ? String(body.opened).slice(0, 10) : today();
    if (!isDate(opened)) fail(400, 'Give the date the store opens (YYYY-MM-DD).');
    if (opened > today()) fail(400, 'The store cannot open in the future.');
  }
  if (!own && w.own_store) {
    if (w.is_default) fail(409, `${w.name} is the main workshop and always has its own store.`);
    const others = servedBy(w.id).filter((id) => id !== w.id);
    if (others.length) fail(409, `${others.map((id) => workshops.byId(id).name).join(', ')} still use this store. Give them another store first.`);
    if (hasMovements(w.id)) fail(409, `Stock has already moved in ${w.name}'s store, so it cannot be closed.`);
    opened = null;
  }
  run('UPDATE workshops SET own_store = ?, uses_store = ?, store_opened = ? WHERE id = ?', own ? 1 : 0, uses, own ? opened : null, w.id);
  const after = workshops.byId(w.id);
  audit({ userId: actor.id, entity: 'workshop', entityId: w.id, action: 'store',
    before, after: { own_store: after.own_store, uses_store: after.uses_store, store_opened: after.store_opened } });
  return after;
}

// ---- transfers between stores ---------------------------------------------------------------

/** The store at one end of a transfer: a workshop place ('w:<id>') on the transfer date, else none. */
function storeAtPlace(placeKey, date) {
  const m = /^w:(\d+)$/.exec(String(placeKey || ''));
  if (!m || !workshops.byId(Number(m[1]))) return null;
  return storeOf(Number(m[1]), date);
}

/**
 * Stamp each item of a transfer note with the two stores it moves between. A line's own ends win
 * over the note's. Only a move between two DIFFERENT stores moves stock; anything else — to a
 * site, to a machine, between two workshops sharing one store — stays a paper record, as before.
 */
function stampTransfer(mtnId) {
  const t = get('SELECT id, txn_date, from_place, to_place FROM mtn WHERE id = ?', mtnId);
  if (!t) return;
  const date = String(t.txn_date || '').slice(0, 10);
  for (const l of all('SELECT id, from_place, to_place FROM mtn_lines WHERE mtn_id = ?', mtnId)) {
    const from = storeAtPlace(l.from_place || t.from_place, date);
    const to = storeAtPlace(l.to_place || t.to_place, date);
    const moves = from && to && from !== to;
    run('UPDATE mtn_lines SET from_store_id = ?, to_store_id = ? WHERE id = ?', moves ? from : null, moves ? to : null, l.id);
  }
}

/**
 * With the workshops kept apart, someone outside head office sends stock only from their own store:
 * the store that gives the stock writes the note.
 */
function checkTransfer(user, mtnId) {
  const scope = require('./scope');
  if (!scope.enabled() || scope.headOffice(user)) return;
  const mine = homeStore(user);
  const other = get('SELECT from_store_id FROM mtn_lines WHERE mtn_id = ? AND from_store_id IS NOT NULL AND from_store_id <> ? LIMIT 1', mtnId, mine);
  if (other) fail(403, `You can send stock only from your own store (${label(mine)}). This note sends stock from ${label(other.from_store_id)}.`);
}

/**
 * The old stock takes set ONE figure for the whole company (the oil count, a general item's
 * adjustment). With more than one store there is no such figure: each store counts its own shelf.
 * The refusal, or null while there is one store.
 */
const wholeCountRefusal = () => (isMulti()
  ? 'Stock is kept store by store now. Count it in the Stock panel, in the store it is in.' : null);

/** May this person count or set levels in this store? Head office any; anyone else their own. */
function mayManage(user, storeId) {
  const scope = require('./scope');
  if (!scope.enabled() || scope.headOffice(user)) return true;
  return homeStore(user) === Number(storeId);
}

// ---- reorder levels, per store (a stock take is src/lib/stock_count.js) -------------------------

function mustBeStore(storeId) {
  const s = byId(Number(storeId));
  if (!s || !s.active) fail(400, 'Choose a store');
  return s;
}

function itemName(section, key) {
  const r = get('SELECT name FROM stock_items WHERE section = ? AND item_key = ?', section, key)
    || get('SELECT item_name AS name FROM stock_moves WHERE section = ? AND item_key = ? ORDER BY id DESC LIMIT 1', section, key);
  return r ? r.name : null;
}

/** The level one store reorders an item at. Blank or 0 removes it. */
function setLevel(actor, { storeId, section, itemKey, level }) {
  const stock = require('./stock');
  const s = mustBeStore(storeId);
  if (!stock.SECTIONS.includes(section)) fail(400, 'Unknown section');
  const key = String(itemKey || '').trim();
  const name = key && itemName(section, key);
  if (!name) fail(404, 'No such item in this section');
  const v = level === '' || level == null ? 0 : Number(level);
  if (!Number.isFinite(v) || v < 0) fail(400, 'The reorder level is a quantity: 0 or more.');
  const before = get('SELECT level FROM store_reorder WHERE store_id = ? AND section = ? AND item_key = ?', s.id, section, key);
  if (v > 0) {
    run(`INSERT INTO store_reorder (store_id, section, item_key, level, set_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(store_id, section, item_key) DO UPDATE SET level = excluded.level, set_by = excluded.set_by, set_at = datetime('now')`,
    s.id, section, key, n2(v), actor.id);
  } else {
    run('DELETE FROM store_reorder WHERE store_id = ? AND section = ? AND item_key = ?', s.id, section, key);
  }
  audit({ userId: actor.id, entity: 'store_reorder', entityId: s.id, action: 'level',
    before: { item: name, level: before ? before.level : null }, after: { store: s.name, section, item: name, level: v > 0 ? n2(v) : null } });
  return { store_id: s.id, section, item_key: key, item_name: name, level: v > 0 ? n2(v) : null };
}

module.exports = {
  DEF, storeSql, storeOf, byId, activeCount, isMulti, label, servedBy, list, homeStore, forEntry, hasMovements,
  setStore, storeAtPlace, stampTransfer, checkTransfer, mayManage, wholeCountRefusal, setLevel, itemName,
};
