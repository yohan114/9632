'use strict';

// ===========================================================================
// Stock take: count sessions, store by store (stores plan, Part 2).
//
// A count session lists what one store should hold of one kind of stock, or of every kind, and the
// store counts it: what is physically on the shelf (the physical figure) against what the book
// says (the system figure).
//
//   counting ─▶ submitted ─▶ approved          (the corrections go into stock)
//       ▲            │
//       └─ sent back ┘          cancelled from either, with a reason
//
// - The book figure is kept from the moment the count began (ST-D4), and again when each item is
//   counted. Whatever moved in between is shown apart ("moved during the count"), and the
//   difference is taken against the book when the item was counted, so a part issued while the
//   store was counting is not counted twice.
// - Nothing changes in stock until head office approves (ST-D5). The approval writes one
//   store_counts row per item that differs; stock_moves takes them from there as corrections
//   ('adjust'), exactly like the single counts made before this part, so a rebuild keeps them.
// - Lubricants are counted in litres (ST-D16): full drums or cans × their size, plus the part-used
//   one by dip reading.
// - A quick count (ST-D14) is a session of one item: counted and sent in one step. It is how a
//   storekeeper puts right an item the book shows at 0 while it sits on the shelf.
// ===========================================================================

const { get, all, run, tx } = require('../db');
const stock = require('./stock');
const stores = require('./stores');
const scope = require('./scope');

const KINDS = ['all', ...stock.SECTIONS];
const OPEN = ['counting', 'submitted'];

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const audit = (...a) => require('./audit').record(...a);
const hasCap = (user, cap) => require('./auth').hasCap(user, cap);
const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max) || null;

const sectionsOf = (kind) => (kind === 'all' ? stock.SECTIONS : [kind]);
const covers = (kind, section) => kind === 'all' || kind === section;

/**
 * The store a count is in: the one asked for; else, for store staff, their own; with a single store,
 * that store. Head office names the store.
 */
function storeFor(storeId, actor) {
  const own = actor && scope.enabled() && !scope.headOffice(actor) ? stores.homeStore(actor) : null;
  const id = Number(storeId) || own || (stores.isMulti() ? null : require('./workshops').defaultId());
  const s = id && stores.byId(id);
  if (!s || !s.active) fail(400, 'Choose a store');
  return s;
}

/** Head office approves the corrections (ST-D5). */
const mayApprove = (user) => hasCap(user, 'stores.count.approve') && (!scope.enabled() || scope.headOffice(user));
/** The store's own staff (or head office) count it. */
const mayCount = (user, storeId) => hasCap(user, 'stores.stock.count') && stores.mayManage(user, storeId);

// ---- what the book says ---------------------------------------------------------------------

/** Every item a store's book knows in one section, with its balance there. */
function bookOf(storeId, section) {
  const rows = all(
    `SELECT item_key,
            ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0 WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END), 0), 2) AS balance,
            SUM(counts) AS live
       FROM stock_moves WHERE section = ? AND store_id = ? GROUP BY item_key`, section, storeId);
  const levels = all('SELECT item_key FROM store_reorder WHERE store_id = ? AND section = ?', storeId, section);
  const out = new Map();
  // An item belongs on the list when it holds stock, has moved since its section began counting,
  // or the store keeps a reorder level for it. Old history alone (before the cut-over) does not.
  for (const r of rows) if (r.live > 0 || r.balance !== 0) out.set(r.item_key, r.balance);
  for (const l of levels) if (!out.has(l.item_key)) out.set(l.item_key, 0);
  return out;
}

/** The last price paid for each item of a section (any store), else its catalogue price. */
function pricesOf(section) {
  const p = new Map();
  for (const r of all("SELECT item_key, unit_price FROM stock_items WHERE section = ? AND unit_price > 0", section)) p.set(r.item_key, r.unit_price);
  for (const r of all(`SELECT item_key, unit_price FROM stock_moves
                        WHERE section = ? AND unit_price > 0 AND kind IN ('in','opening')
                        ORDER BY txn_date, id`, section)) p.set(r.item_key, r.unit_price);
  return p;
}

function describe(section, key) {
  const si = get('SELECT name, unit FROM stock_items WHERE section = ? AND item_key = ?', section, key);
  const name = (si && si.name) || stores.itemName(section, key);
  return name ? { name, unit: (si && si.unit) || (section === 'oil' ? 'L' : 'nos') } : null;
}

/** The item's last correction in this store — a count made now has seen it. */
const lastCorrection = (storeId, section, key) =>
  get('SELECT MAX(id) id FROM store_counts WHERE store_id = ? AND section = ? AND item_key = ?', storeId, section, key).id;

function nextNo() {
  const y = today().slice(0, 4);
  const last = get("SELECT count_no FROM count_sessions WHERE count_no LIKE ? ORDER BY id DESC LIMIT 1", `ST-${y}-%`);
  const n = last ? (parseInt(String(last.count_no).split('-').pop(), 10) || 0) : 0;
  return `ST-${y}-${String(n + 1).padStart(4, '0')}`;
}

function countDay(date, notBefore) {
  const day = date ? String(date).slice(0, 10) : today();
  if (!isDate(day)) fail(400, 'Give the date of the count (YYYY-MM-DD).');
  if (day > today()) fail(400, 'The count date cannot be in the future.');
  if (notBefore && day < notBefore) fail(400, `This count began on ${notBefore}. An item cannot be counted before that.`);
  return day;
}

// ---- a count session ------------------------------------------------------------------------

function session(id) {
  const s = get('SELECT * FROM count_sessions WHERE id = ?', Number(id));
  if (!s) fail(404, 'No such stock take');
  return s;
}

function mustSee(user, s) {
  if (!stores.mayManage(user, s.store_id)) fail(403, `This stock take is in ${stores.label(s.store_id)}. You see only your own store.`);
}

/** Start a full count of one kind of stock — or of every kind — in one store. */
function start(actor, { storeId, kind, date, note }) {
  const s = storeFor(storeId, actor);
  if (!mayCount(actor, s.id)) fail(403, `You count only your own store (${stores.label(stores.homeStore(actor))}).`);
  const k = String(kind || '').toLowerCase();
  if (!KINDS.includes(k)) fail(400, 'Choose what to count: one kind of stock, or all.');
  const day = countDay(date);
  // One count at a time of the same shelf: two would each correct the same difference.
  const clash = all(`SELECT count_no, kind FROM count_sessions WHERE store_id = ? AND scope = 'full' AND status IN ('counting','submitted')`, s.id)
    .find((o) => o.kind === 'all' || k === 'all' || o.kind === k);
  if (clash) fail(409, `Stock take ${clash.count_no} of this store is still open. Finish or cancel it first.`);
  return tx(() => {
    const id = run(`INSERT INTO count_sessions (count_no, store_id, kind, scope, status, count_date, note, started_by)
                    VALUES (?, ?, ?, 'full', 'counting', ?, ?, ?)`, nextNo(), s.id, k, day, clean(note), actor.id).lastInsertRowid;
    let lines = 0;
    for (const section of sectionsOf(k)) {
      const prices = pricesOf(section);
      for (const [key, balance] of bookOf(s.id, section)) {
        const d = describe(section, key);
        if (!d) continue;
        run(`INSERT INTO count_lines (session_id, section, item_key, item_name, unit, unit_price, book_start)
             VALUES (?, ?, ?, ?, ?, ?, ?)`, id, section, key, d.name, d.unit, prices.get(key) || null, balance);
        lines++;
      }
    }
    audit({ userId: actor.id, entity: 'count_session', entityId: id, action: 'start', after: { store: s.name, kind: k, date: day, lines } });
    return detail(actor, id);
  });
}

/** What was counted for one line: a quantity, or — for lubricants — drums × size + the dip. */
function readCount(section, body) {
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  if (section === 'oil' && (has(body.containers) || has(body.loose_qty))) {
    const containers = has(body.containers) ? Number(body.containers) : 0;
    const size = has(body.container_size) ? Number(body.container_size) : null;
    const loose = has(body.loose_qty) ? Number(body.loose_qty) : 0;
    if (!Number.isFinite(containers) || containers < 0 || !Number.isInteger(containers)) fail(400, 'Full drums or cans: a whole number, 0 or more.');
    if (containers > 0 && !(Number.isFinite(size) && size > 0)) fail(400, 'Give the size of one drum or can, in litres.');
    if (!Number.isFinite(loose) || loose < 0) fail(400, 'The part-used drum: litres by dip reading, 0 or more.');
    return { counted: n2(containers * (size || 0) + loose), containers, container_size: containers > 0 ? size : null, loose_qty: n2(loose) };
  }
  if (!has(body.counted)) return null;
  const q = Number(body.counted);
  if (!Number.isFinite(q) || q < 0) fail(400, 'Give the quantity counted (0 or more).');
  return { counted: n2(q), containers: null, container_size: null, loose_qty: null };
}

/** Count one item of an open session (or clear its count to count it again). */
function countLine(actor, sessionId, lineId, body = {}) {
  const s = session(sessionId);
  mustSee(actor, s);
  if (!mayCount(actor, s.store_id)) fail(403, 'Your role does not count stock.');
  if (s.status !== 'counting') fail(409, `Stock take ${s.count_no} is ${s.status}. It cannot be counted now.`);
  const l = get('SELECT * FROM count_lines WHERE id = ? AND session_id = ?', Number(lineId), s.id);
  if (!l) fail(404, 'No such item on this stock take');
  const c = readCount(l.section, body);
  if (!c) {
    run(`UPDATE count_lines SET counted_qty = NULL, containers = NULL, container_size = NULL, loose_qty = NULL,
           book_at_count = NULL, counted_by = NULL, counted_on = NULL, counted_at = NULL, note = ? WHERE id = ?`, clean(body.note), l.id);
    return lineOut(get('SELECT * FROM count_lines WHERE id = ?', l.id));
  }
  const day = countDay(body.date, s.count_date);
  run(`UPDATE count_lines SET counted_qty = ?, containers = ?, container_size = ?, loose_qty = ?, book_at_count = ?,
         counted_by = ?, counted_on = ?, counted_at = datetime('now'), note = ?, seen_count_id = ? WHERE id = ?`,
  c.counted, c.containers, c.container_size, c.loose_qty, stock.balanceOf(l.section, l.item_key, s.store_id),
  actor.id, day, clean(body.note), lastCorrection(s.store_id, l.section, l.item_key), l.id);
  return lineOut(get('SELECT * FROM count_lines WHERE id = ?', l.id));
}

/** An item found on the shelf that the list did not name. */
function addLine(actor, sessionId, { section, itemKey }) {
  const s = session(sessionId);
  mustSee(actor, s);
  if (!mayCount(actor, s.store_id)) fail(403, 'Your role does not count stock.');
  if (s.status !== 'counting') fail(409, `Stock take ${s.count_no} is ${s.status}. Nothing can be added now.`);
  const sec = String(section || '').toLowerCase();
  if (!stock.SECTIONS.includes(sec) || !covers(s.kind, sec)) fail(400, 'That kind of stock is not part of this count.');
  const key = String(itemKey || '').trim();
  const d = key && describe(sec, key);
  if (!d) fail(404, 'No such item in this section');
  if (get('SELECT 1 x FROM count_lines WHERE session_id = ? AND section = ? AND item_key = ?', s.id, sec, key)) fail(409, `${d.name} is already on the list.`);
  const id = run(`INSERT INTO count_lines (session_id, section, item_key, item_name, unit, unit_price, book_start, added)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  s.id, sec, key, d.name, d.unit, pricesOf(sec).get(key) || null, stock.balanceOf(sec, key, s.store_id)).lastInsertRowid;
  return lineOut(get('SELECT * FROM count_lines WHERE id = ?', id));
}

/** Send the count to head office. Every item must have been counted (0 is a count). */
function submit(actor, sessionId) {
  const s = session(sessionId);
  mustSee(actor, s);
  if (!mayCount(actor, s.store_id)) fail(403, 'Your role does not count stock.');
  if (s.status !== 'counting') fail(409, `Stock take ${s.count_no} is ${s.status}.`);
  const left = get('SELECT COUNT(*) n FROM count_lines WHERE session_id = ? AND counted_qty IS NULL', s.id).n;
  if (left) fail(400, `${left} item${left === 1 ? ' is' : 's are'} not counted yet. Count ${left === 1 ? 'it' : 'them'} (0 if none is there).`);
  if (!get('SELECT 1 x FROM count_lines WHERE session_id = ?', s.id)) fail(400, 'Nothing was counted.');
  run("UPDATE count_sessions SET status = 'submitted', submitted_by = ?, submitted_at = datetime('now') WHERE id = ?", actor.id, s.id);
  audit({ userId: actor.id, entity: 'count_session', entityId: s.id, action: 'submit', after: totals(s.id) });
  return detail(actor, s.id);
}

/** Head office approves: every difference goes into the store's stock as a correction. */
function approve(actor, sessionId) {
  const s = session(sessionId);
  if (!mayApprove(actor)) fail(403, 'Head office approves a stock take.');
  if (s.status !== 'submitted') fail(409, `Stock take ${s.count_no} is ${s.status}. Only a count sent for approval can be approved.`);
  // An item corrected by another count after it was counted here would be corrected twice.
  const stale = all(`SELECT DISTINCT l.item_name FROM count_lines l
                      JOIN store_counts c ON c.store_id = ? AND c.section = l.section AND c.item_key = l.item_key
                       AND c.id > COALESCE(l.seen_count_id, 0) AND COALESCE(c.session_id, 0) <> ?
                     WHERE l.session_id = ? AND l.counted_qty IS NOT NULL`, s.store_id, s.id, s.id).map((r) => r.item_name);
  if (stale.length) {
    fail(409, `Another count corrected ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ` and ${stale.length - 5} more` : ''} after it was counted here. Send it back to count again.`);
  }
  return tx(() => {
    let posted = 0;
    for (const l of all('SELECT * FROM count_lines WHERE session_id = ? AND counted_qty IS NOT NULL', s.id)) {
      const delta = n2(l.counted_qty - l.book_at_count);
      if (!delta) continue;
      const id = run(`INSERT INTO store_counts (store_id, section, item_key, item_name, count_date, book_qty, counted_qty, delta, note, counted_by, session_id)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.store_id, l.section, l.item_key, l.item_name, l.counted_on || s.count_date, l.book_at_count, l.counted_qty, delta,
      [s.count_no, l.note].filter(Boolean).join(' · ').slice(0, 200), l.counted_by, s.id).lastInsertRowid;
      stock.recordCount(get('SELECT * FROM store_counts WHERE id = ?', id));
      posted++;
    }
    run("UPDATE count_sessions SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?", actor.id, s.id);
    audit({ userId: actor.id, entity: 'count_session', entityId: s.id, action: 'approve', after: { ...totals(s.id), corrections: posted } });
    return detail(actor, s.id);
  });
}

/** Head office sends a count back to be counted again, saying why. */
function sendBack(actor, sessionId, reason) {
  const s = session(sessionId);
  if (!mayApprove(actor)) fail(403, 'Head office approves a stock take.');
  if (s.status !== 'submitted') fail(409, `Stock take ${s.count_no} is ${s.status}.`);
  const why = clean(reason);
  if (!why || why.length < 3) fail(400, 'Say what to count again.');
  run("UPDATE count_sessions SET status = 'counting', decision_note = ?, submitted_at = NULL, submitted_by = NULL WHERE id = ?", why, s.id);
  audit({ userId: actor.id, entity: 'count_session', entityId: s.id, action: 'send_back', reason: why });
  return detail(actor, s.id);
}

/** Stop a count that is not approved yet. Nothing goes into stock. */
function cancel(actor, sessionId, reason) {
  const s = session(sessionId);
  mustSee(actor, s);
  if (!mayApprove(actor) && !mayCount(actor, s.store_id)) fail(403, 'Your role does not count stock.');
  if (!OPEN.includes(s.status)) fail(409, `Stock take ${s.count_no} is ${s.status}.`);
  const why = clean(reason);
  if (!why || why.length < 3) fail(400, 'Say why the count is cancelled.');
  run("UPDATE count_sessions SET status = 'cancelled', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?", actor.id, why, s.id);
  audit({ userId: actor.id, entity: 'count_session', entityId: s.id, action: 'cancel', reason: why });
  return detail(actor, s.id);
}

/**
 * A quick count of one item (ST-D14): counted and sent for approval in one step. Head office's own
 * quick count needs nobody else's approval and goes in at once.
 */
function quick(actor, { storeId, section, itemKey, counted, date, note, containers, container_size, loose_qty }) {
  const s = storeFor(storeId, actor);
  if (!mayCount(actor, s.id)) fail(403, `You count only your own store (${stores.label(stores.homeStore(actor))}).`);
  const sec = String(section || '').toLowerCase();
  if (!stock.SECTIONS.includes(sec)) fail(400, 'Unknown section');
  const key = String(itemKey || '').trim();
  const d = key && describe(sec, key);
  if (!d) fail(404, 'No such item in this section');
  const c = readCount(sec, { counted, containers, container_size, loose_qty });
  if (!c) fail(400, 'Give the quantity counted (0 or more).');
  const day = countDay(date);
  const open = get(`SELECT id FROM count_sessions WHERE store_id = ? AND scope = 'quick' AND status = 'submitted'
                      AND id IN (SELECT session_id FROM count_lines WHERE section = ? AND item_key = ?)`, s.id, sec, key);
  if (open) fail(409, `${d.name} already has a count waiting for head office.`);
  const out = tx(() => {
    const book = stock.balanceOf(sec, key, s.id);
    const id = run(`INSERT INTO count_sessions (count_no, store_id, kind, scope, status, count_date, note, started_by, submitted_by, submitted_at)
                    VALUES (?, ?, ?, 'quick', 'submitted', ?, ?, ?, ?, datetime('now'))`,
    nextNo(), s.id, sec, day, clean(note), actor.id, actor.id).lastInsertRowid;
    run(`INSERT INTO count_lines (session_id, section, item_key, item_name, unit, unit_price, book_start, book_at_count, counted_qty,
           containers, container_size, loose_qty, note, counted_by, counted_on, counted_at, seen_count_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    id, sec, key, d.name, d.unit, pricesOf(sec).get(key) || null, book, book, c.counted, c.containers, c.container_size, c.loose_qty,
    clean(note), actor.id, day, lastCorrection(s.id, sec, key));
    audit({ userId: actor.id, entity: 'count_session', entityId: id, action: 'quick', after: { store: s.name, item: d.name, book, counted: c.counted } });
    return id;
  });
  const done = mayApprove(actor) ? approve(actor, out) : detail(actor, out);
  const l = done.lines[0];
  return { id: out, session_id: out, count_no: done.count_no, status: done.status, store_id: s.id, section: sec, item_key: key,
    item_name: d.name, book: l.book_at_count, counted: l.counted_qty, delta: l.diff, balance: stock.balanceOf(sec, key, s.id) };
}

// ---- reading --------------------------------------------------------------------------------

function lineOut(l) {
  const counted = l.counted_qty != null;
  const diff = counted ? n2(l.counted_qty - l.book_at_count) : null;
  return {
    ...l,
    counted,
    // What moved in or out between the start of the count and the moment this item was counted.
    moved_during: counted ? n2(l.book_at_count - l.book_start) : null,
    diff,
    diff_value: counted && l.unit_price ? n2(diff * l.unit_price) : null,
  };
}

function totals(sessionId) {
  const lines = all('SELECT * FROM count_lines WHERE session_id = ?', sessionId).map(lineOut);
  const t = { lines: lines.length, counted: 0, differ: 0, over_value: 0, short_value: 0, net_value: 0, unpriced: 0 };
  for (const l of lines) {
    if (!l.counted) continue;
    t.counted++;
    if (!l.diff) continue;
    t.differ++;
    if (l.diff_value == null) { t.unpriced++; continue; }
    if (l.diff_value > 0) t.over_value = n2(t.over_value + l.diff_value);
    else t.short_value = n2(t.short_value + l.diff_value);
  }
  t.net_value = n2(t.over_value + t.short_value);
  return t;
}

const HEAD = `SELECT s.*, w.name AS store_name, w.code AS store_code,
                     us.username AS started_by_name, ub.username AS submitted_by_name, ud.username AS decided_by_name
                FROM count_sessions s
                LEFT JOIN workshops w ON w.id = s.store_id
                LEFT JOIN users us ON us.id = s.started_by
                LEFT JOIN users ub ON ub.id = s.submitted_by
                LEFT JOIN users ud ON ud.id = s.decided_by`;

/** One count with all its lines, what this person may do with it, and its totals. */
function detail(user, id) {
  const s = get(`${HEAD} WHERE s.id = ?`, Number(id));
  if (!s) fail(404, 'No such stock take');
  mustSee(user, s);
  const lines = all(`SELECT l.*, u.username AS counted_by_name FROM count_lines l LEFT JOIN users u ON u.id = l.counted_by
                      WHERE l.session_id = ? ORDER BY l.section, l.item_name`, s.id).map(lineOut);
  const count = mayCount(user, s.store_id);
  return {
    ...s,
    lines,
    totals: totals(s.id),
    can: {
      count: count && s.status === 'counting',
      submit: count && s.status === 'counting',
      approve: mayApprove(user) && s.status === 'submitted',
      send_back: mayApprove(user) && s.status === 'submitted',
      cancel: (count || mayApprove(user)) && OPEN.includes(s.status),
    },
  };
}

/** The counts this person can see: their own store's — head office, every store's. */
function list(user, { status, store_id: storeId, scope: sc, limit } = {}) {
  const w = []; const p = [];
  if (scope.enabled() && !scope.headOffice(user)) { w.push('s.store_id = ?'); p.push(stores.homeStore(user)); }
  else if (storeId) { w.push('s.store_id = ?'); p.push(Number(storeId)); }
  if (status === 'open') w.push("s.status IN ('counting','submitted')");
  else if (['counting', 'submitted', 'approved', 'cancelled'].includes(status)) { w.push('s.status = ?'); p.push(status); }
  if (sc === 'full' || sc === 'quick') { w.push('s.scope = ?'); p.push(sc); }
  const rows = all(`${HEAD} ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
                    ORDER BY CASE s.status WHEN 'submitted' THEN 0 WHEN 'counting' THEN 1 ELSE 2 END, s.id DESC
                    LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`, ...p);
  for (const r of rows) {
    r.totals = totals(r.id);
    if (r.scope === 'quick') {
      const l = get('SELECT item_name, section FROM count_lines WHERE session_id = ?', r.id);
      r.item_name = l ? l.item_name : null;
    }
  }
  return rows;
}

/** Counts waiting: being counted, and sent to head office — in one store, or in all. */
function waiting(storeId) {
  const st = storeId ? ' AND store_id = ?' : '';
  const n = (status) => get(`SELECT COUNT(*) n FROM count_sessions WHERE status = ?${st}`, status, ...(storeId ? [storeId] : [])).n;
  return { counting: n('counting'), submitted: n('submitted') };
}

/**
 * The date one store's first full count of a kind of stock was approved, or null. The "must be in
 * stock" rule (ST-D13, Part 3) starts from it: before it, the numbers are not yet ones to block on.
 */
function fullyCounted(storeId, section) {
  const r = get(`SELECT MIN(date(decided_at)) d FROM count_sessions
                  WHERE store_id = ? AND scope = 'full' AND status = 'approved' AND kind IN ('all', ?)`, storeId, section);
  return r ? r.d : null;
}

module.exports = {
  KINDS, start, countLine, addLine, submit, approve, sendBack, cancel, quick, detail, list, waiting, fullyCounted,
  mayApprove, mayCount, storeFor,
};
