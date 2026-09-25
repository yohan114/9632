'use strict';

// ===========================================================================
// Disposal notes (stores plan, Part 4): what leaves the store as scrap — worn-out tyres, dead
// batteries, other scrap parts and waste oil (in litres) — and who took it, for how much, when.
//
//   open ─▶ approved      a manager approves, with the buyer, the amount and the date (ST-D9);
//     └──▶ cancelled      the tyres and batteries on it are then disposed of in their registers.
//
// Nothing here moves stock: a scrapped unit came off a vehicle, it was never on the shelf's books.
// ===========================================================================

const { get, all, run, tx } = require('../db');
const stores = require('./stores');
const scope = require('./scope');
const units = require('./tb_units');

const KINDS = ['tyre', 'battery', 'part', 'waste_oil'];
/** A unit that may go on a note: scrapped (a battery also: decommissioned). */
const SCRAP = { tyre: ['scrap'], battery: ['scrap', 'decommissioned'] };
const OPEN_OR_DONE = "d.status IN ('open','approved')";

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max) || null;
const hasCap = (user, cap) => require('./auth').hasCap(user, cap);
const audit = (...a) => require('./audit').record(...a);

const mayApprove = (user) => hasCap(user, 'stores.disposal.approve') && (!scope.enabled() || scope.headOffice(user));
const own = (user) => (scope.enabled() && !scope.headOffice(user) ? stores.homeStore(user) : null);

/** The store a note is for: the one named; for store staff, their own; with one store, that one. */
function storeFor(user, storeId) {
  const id = own(user) || Number(storeId) || (stores.isMulti() ? null : require('./workshops').defaultId());
  const s = id && stores.byId(id);
  if (!s || !s.active) fail(400, 'Choose a store');
  return s.id;
}

/** Scrap tyres and batteries not yet on a note — what a new note can list. */
function scrap(user, storeId) {
  const store = own(user) || Number(storeId) || null;
  const st = store ? ' AND (u.store_id = ? OR u.store_id IS NULL)' : '';
  const free = (kind) => `NOT EXISTS (SELECT 1 FROM disposal_lines l JOIN disposals d ON d.id = l.disposal_id
                                        WHERE l.${kind}_id = u.id AND ${OPEN_OR_DONE})`;
  const q = (kind) => all(`SELECT u.id, u.serial_no, u.state, s.label AS spec, '${kind}' AS kind
                             FROM ${units.TABLE[kind]} u LEFT JOIN tb_specs s ON s.id = u.spec_id
                            WHERE u.state IN (${SCRAP[kind].map(() => '?').join(',')}) AND ${free(kind)}${st} ORDER BY u.serial_no`,
  ...SCRAP[kind], ...(store ? [store] : []));
  return { tyres: q('tyre'), batteries: q('battery') };
}

function readLines(lines, storeId) {
  if (!Array.isArray(lines) || !lines.length) fail(400, 'Put at least one thing on the note.');
  const out = [];
  const seen = new Set();
  for (const [i, l] of lines.entries()) {
    const kind = String((l && l.kind) || '');
    if (!KINDS.includes(kind)) fail(400, `Line ${i + 1}: say what it is (tyre, battery, part or waste oil).`);
    if (kind === 'tyre' || kind === 'battery') {
      const u = units.byId(kind, Number(l[kind + '_id']));
      if (!u) fail(404, `Line ${i + 1}: no such ${kind}.`);
      if (!SCRAP[kind].includes(u.state)) fail(409, `${units.LABEL[kind]} ${u.serial_no} is ${u.state}, not scrap. Mark it scrap first.`);
      if (seen.has(kind + u.id)) fail(400, `${units.LABEL[kind]} ${u.serial_no} is on the note twice.`);
      if (u.store_id && storeId && Number(u.store_id) !== Number(storeId)) {
        fail(409, `${units.LABEL[kind]} ${u.serial_no} belongs to ${stores.label(u.store_id)}. Put it on that store's note.`);
      }
      seen.add(kind + u.id);
      const spec = u.spec_id ? (get('SELECT label FROM tb_specs WHERE id = ?', u.spec_id) || {}).label : null;
      out.push({ kind, tyre_id: kind === 'tyre' ? u.id : null, battery_id: kind === 'battery' ? u.id : null,
        description: [u.serial_no, spec].filter(Boolean).join(' · '), qty: 1, unit: 'nos', serial: u.serial_no });
      continue;
    }
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) fail(400, `Line ${i + 1}: how much?`);
    const desc = clean(l.description) || (kind === 'waste_oil' ? 'Waste oil' : null);
    if (!desc) fail(400, `Line ${i + 1}: say what the part is.`);
    out.push({ kind, tyre_id: null, battery_id: null, description: desc, qty: n2(qty),
      unit: kind === 'waste_oil' ? 'L' : (clean(l.unit, 12) || 'nos') });
  }
  return out;
}

/** A unit on this note may not be on another open or approved one. */
function mustBeFree(lines, exceptId) {
  for (const l of lines.filter((x) => x.tyre_id || x.battery_id)) {
    const col = l.tyre_id ? 'tyre_id' : 'battery_id';
    const other = get(`SELECT d.disposal_no FROM disposal_lines l JOIN disposals d ON d.id = l.disposal_id
                        WHERE l.${col} = ? AND ${OPEN_OR_DONE} AND d.id <> ?`, l.tyre_id || l.battery_id, exceptId || 0);
    if (other) fail(409, `${l.serial} is already on disposal note ${other.disposal_no}.`);
  }
}

function header(b) {
  const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) fail(400, 'The amount is money: 0 or more.');
  if (b.sale_date && !isDate(b.sale_date)) fail(400, 'Give the date as YYYY-MM-DD.');
  return { buyer: clean(b.buyer), amount: amount == null ? null : n2(amount), sale_date: b.sale_date || null, note: clean(b.note, 500) };
}

function nextNo() {
  const y = today().slice(0, 4);
  const last = get('SELECT disposal_no FROM disposals WHERE disposal_no LIKE ? ORDER BY id DESC LIMIT 1', `DN-${y}-%`);
  return `DN-${y}-${String((last ? parseInt(last.disposal_no.split('-').pop(), 10) || 0 : 0) + 1).padStart(4, '0')}`;
}

function writeLines(id, lines) {
  run('DELETE FROM disposal_lines WHERE disposal_id = ?', id);
  for (const l of lines) {
    run('INSERT INTO disposal_lines (disposal_id, kind, tyre_id, battery_id, description, qty, unit) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, l.kind, l.tyre_id, l.battery_id, l.description, l.qty, l.unit);
  }
}

function create(actor, b = {}) {
  if (!hasCap(actor, 'stores.disposal.edit')) fail(403, 'Your role does not write disposal notes.');
  const storeId = storeFor(actor, b.store_id);
  const lines = readLines(b.lines, storeId);
  mustBeFree(lines);
  const h = header(b);
  const id = tx(() => {
    const nid = run(`INSERT INTO disposals (disposal_no, store_id, status, buyer, amount, sale_date, note, created_by)
                     VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`, nextNo(), storeId, h.buyer, h.amount, h.sale_date, h.note, actor.id).lastInsertRowid;
    writeLines(nid, lines);
    return nid;
  });
  audit({ userId: actor.id, entity: 'disposal', entityId: id, action: 'create', after: { lines: lines.length } });
  return detail(actor, id);
}

function note(user, id) {
  const d = get('SELECT * FROM disposals WHERE id = ?', Number(id));
  if (!d) fail(404, 'No such disposal note');
  const mine = own(user);
  if (mine && d.store_id !== mine) fail(403, `This note is for ${stores.label(d.store_id)}. You see only your own store.`);
  return d;
}

/** Change an open note: its lines, the buyer, the amount, the date. */
function update(actor, id, b = {}) {
  const d = note(actor, id);
  if (!hasCap(actor, 'stores.disposal.edit')) fail(403, 'Your role does not write disposal notes.');
  if (d.status !== 'open') fail(409, `Disposal note ${d.disposal_no} is ${d.status}.`);
  const lines = b.lines ? readLines(b.lines, d.store_id) : null;
  if (lines) mustBeFree(lines, d.id);
  const h = header({ ...d, ...b });
  tx(() => {
    run('UPDATE disposals SET buyer = ?, amount = ?, sale_date = ?, note = ? WHERE id = ?', h.buyer, h.amount, h.sale_date, h.note, d.id);
    if (lines) writeLines(d.id, lines);
  });
  return detail(actor, d.id);
}

/** A manager approves: the buyer, the amount and the date are needed; the units are disposed of. */
function approve(actor, id, b = {}) {
  if (!mayApprove(actor)) fail(403, 'A manager approves a disposal note.');
  const d = note(actor, id);
  if (d.status !== 'open') fail(409, `Disposal note ${d.disposal_no} is ${d.status}.`);
  const h = header({ ...d, ...b });
  if (!h.buyer) fail(400, 'Who is buying it?');
  if (h.amount == null) fail(400, 'For how much? (0 if it is taken away for nothing)');
  if (!h.sale_date) fail(400, 'On what date does it leave?');
  tx(() => {
    for (const l of all('SELECT * FROM disposal_lines WHERE disposal_id = ? AND (tyre_id IS NOT NULL OR battery_id IS NOT NULL)', d.id)) {
      const kind = l.tyre_id ? 'tyre' : 'battery';
      const u = units.byId(kind, l.tyre_id || l.battery_id);
      if (!u || !SCRAP[kind].includes(u.state)) fail(409, `${l.description} is no longer scrap. Take it off the note first.`);
      run(`UPDATE ${units.TABLE[kind]} SET state = 'disposed', current_asset_id = NULL WHERE id = ?`, u.id);
      units.event(kind, u.id, { type: 'dispose', reason: `${d.disposal_no} · ${h.buyer}`, userId: actor.id, date: h.sale_date });
    }
    run(`UPDATE disposals SET status = 'approved', buyer = ?, amount = ?, sale_date = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`,
      h.buyer, h.amount, h.sale_date, actor.id, d.id);
  });
  audit({ userId: actor.id, entity: 'disposal', entityId: d.id, action: 'approve', after: { buyer: h.buyer, amount: h.amount, date: h.sale_date } });
  return detail(actor, d.id);
}

function cancel(actor, id, reason) {
  const d = note(actor, id);
  if (!hasCap(actor, 'stores.disposal.edit') && !mayApprove(actor)) fail(403, 'Your role does not write disposal notes.');
  if (d.status !== 'open') fail(409, `Disposal note ${d.disposal_no} is ${d.status}.`);
  const why = clean(reason);
  if (!why || why.length < 3) fail(400, 'Say why the note is cancelled.');
  run("UPDATE disposals SET status = 'cancelled', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?", actor.id, why, d.id);
  audit({ userId: actor.id, entity: 'disposal', entityId: d.id, action: 'cancel', reason: why });
  return detail(actor, d.id);
}

const HEAD = `SELECT d.*, w.name AS store_name, uc.username AS created_by_name, ud.username AS decided_by_name,
                     (SELECT COUNT(*) FROM disposal_lines l WHERE l.disposal_id = d.id) AS lines,
                     (SELECT COALESCE(SUM(l.qty), 0) FROM disposal_lines l WHERE l.disposal_id = d.id AND l.kind = 'waste_oil') AS waste_oil_litres
                FROM disposals d LEFT JOIN workshops w ON w.id = d.store_id
                LEFT JOIN users uc ON uc.id = d.created_by LEFT JOIN users ud ON ud.id = d.decided_by`;

function detail(user, id) {
  const d = note(user, id);
  const row = get(`${HEAD} WHERE d.id = ?`, d.id);
  const lines = all('SELECT * FROM disposal_lines WHERE disposal_id = ? ORDER BY id', d.id);
  const open = d.status === 'open';
  const edit = hasCap(user, 'stores.disposal.edit');
  return { ...row, lines, can: { edit: edit && open, approve: mayApprove(user) && open, cancel: (edit || mayApprove(user)) && open } };
}

function list(user, { status } = {}) {
  const w = []; const p = [];
  const mine = own(user);
  if (mine) { w.push('d.store_id = ?'); p.push(mine); }
  if (['open', 'approved', 'cancelled'].includes(status)) { w.push('d.status = ?'); p.push(status); }
  return all(`${HEAD} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE d.status WHEN 'open' THEN 0 ELSE 1 END, d.id DESC LIMIT 300`, ...p);
}

/** Notes waiting for a manager — in one store, or in all. */
const waiting = (storeId) => get(`SELECT COUNT(*) n FROM disposals WHERE status = 'open'${storeId ? ' AND store_id = ?' : ''}`, ...(storeId ? [storeId] : [])).n;

module.exports = { KINDS, create, update, approve, cancel, detail, list, scrap, waiting, mayApprove };
