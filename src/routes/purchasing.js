'use strict';

// Buying what the workshop asked for.
//
// Two officers do the buying — one on the Head Office account, one locally — and the split is per
// ITEM, not per request: an MRN can be part local and part head office, and an item one of them
// cannot source gets handed to the other. Each officer sees their own channel and nothing else,
// which is the entire point of the screen; managers and admin see both.
//
// BOUGHT IS NOT RECEIVED. Nothing here touches stock. stock_moves is a projection rebuilt from
// grn, so a tick that added stock would be counted a second time the moment the storekeeper posts
// the real GRN against the same line. The officer records that they bought it and what the invoice
// said; the goods arriving is still the storekeeper's GRN, and that is still the only thing that
// moves a balance.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, hasRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const emitter = require('../lib/emitter');

const router = express.Router();

const CHANNELS = ['head_office', 'local_purchase'];
const CHANNEL_LABEL = { head_office: 'Head Office', local_purchase: 'Local Purchase' };

/**
 * Which channels this person may act on.
 *
 * By ROLE, not by permission level. A level can say "may use this screen"; it cannot say "may use
 * the local half of it", and that distinction is the whole reason there are two officers.
 */
function channelsFor(user) {
  if (hasRole(user, 'admin', 'manager', 'operational_manager')) return CHANNELS.slice();
  const mine = [];
  if (hasRole(user, 'purchase_head_office')) mine.push('head_office');
  if (hasRole(user, 'purchase_local')) mine.push('local_purchase');
  return mine;
}
const seesBoth = (user) => channelsFor(user).length === CHANNELS.length;

/**
 * What has reached the buying stage: approved, or explicitly sent to be bought — and not yet fully
 * delivered. Deliberately NOT every open request. 1,709 of 1,738 requests sit at 'requested' and
 * most will never be bought as written; putting them all in front of an officer would bury the
 * handful that matter.
 */
const AT_BUYING_STAGE = `(m.approval_status = 'approved' OR m.purchase_requested_at IS NOT NULL)`;
const NOT_FULLY_RECEIVED = `COALESCE(l.qty_received, 0) < l.qty`;

const LINE_COLS = `
  l.id, l.mrn_id, l.description, l.qty, l.unit, l.qty_received, l.category,
  l.purchase_source, l.purchased_at, l.purchased_by, l.supplier, l.invoice_no,
  l.invoice_date, l.purchase_amount,
  l.source_changed_at, l.source_changed_by, l.source_changed_reason, l.source_changed_from,
  m.mrn_no, m.req_date, m.required_date, m.requested_by, m.purpose, m.approval_status,
  m.purchase_requested_at, m.job_id,
  a.code AS asset_code, a.registration AS asset_reg,
  (SELECT COUNT(*) FROM mrn_line_invoices i WHERE i.mrn_line_id = l.id) AS invoice_images`;

const LINE_FROM = `
  FROM mrn_lines l
  JOIN mrn m ON m.id = l.mrn_id
  LEFT JOIN assets a ON a.id = m.asset_id`;

/** A channel the caller is actually allowed to act on, or null. */
function claimChannel(user, value) {
  const v = String(value || '');
  if (!CHANNELS.includes(v)) return null;
  return channelsFor(user).includes(v) ? v : null;
}

// ---- the queue -------------------------------------------------------------

router.get('/queue', requireAuth, asyncHandler((req, res) => {
  const mine = channelsFor(req.user);
  const tab = ['to_buy', 'unassigned', 'bought'].includes(req.query.tab) ? req.query.tab : 'to_buy';
  const limit = toInt(req.query.limit, 300);

  const where = [AT_BUYING_STAGE];
  const params = [];

  if (tab === 'unassigned') {
    // Nobody has said whose job this is. Both officers see it and either may claim it — 1,714 of
    // 1,738 requests carry no channel, so without this tray the queue would simply be empty.
    where.push('l.purchase_source IS NULL', NOT_FULLY_RECEIVED, 'l.purchased_at IS NULL');
  } else if (!mine.length) {
    // Signed in, may open the screen (a viewer or a storekeeper), but owns no channel.
    return res.json({ rows: [], channels: mine, tab, sees_both: false });
  } else {
    where.push(`l.purchase_source IN (${mine.map(() => '?').join(',')})`);
    params.push(...mine);
    if (tab === 'bought') where.push('l.purchased_at IS NOT NULL');
    else where.push('l.purchased_at IS NULL', NOT_FULLY_RECEIVED);
  }

  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push(`(l.description LIKE ? ESCAPE '\\' OR m.mrn_no LIKE ? ESCAPE '\\'
                 OR a.code LIKE ? ESCAPE '\\' OR a.registration LIKE ? ESCAPE '\\'
                 OR l.supplier LIKE ? ESCAPE '\\' OR l.invoice_no LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like, like, like);
  }

  const order = tab === 'bought'
    ? 'datetime(l.purchased_at) DESC, l.id DESC'
    // Oldest request first: the thing somebody has been waiting longest for is the thing to buy.
    : 'date(m.required_date) IS NULL, date(m.required_date) ASC, date(m.req_date) ASC, l.id ASC';

  const rows = all(
    `SELECT ${LINE_COLS} ${LINE_FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`,
    ...params
  );

  // What arrived since this person last looked. Per user, because two officers sharing one flag
  // would clear each other's badge, and "what is new" is a different answer for each of them.
  const mark = get('SELECT seen_at FROM user_seen_marks WHERE user_id = ? AND key = ?', req.user.id, 'purchasing');
  const since = mark ? mark.seen_at : null;
  for (const r of rows) r.is_new = since ? String(r.req_date || '') > String(since).slice(0, 10) : true;

  res.json({ rows, channels: mine, tab, sees_both: seesBoth(req.user), seen_at: since });
}));

/** Counts for the tab badges, in one call so the screen does not fetch three lists to count them. */
router.get('/counts', requireAuth, asyncHandler((req, res) => {
  const mine = channelsFor(req.user);
  const inMine = mine.length ? `l.purchase_source IN (${mine.map(() => '?').join(',')})` : '0';
  const c = (extra, ...p) => get(
    `SELECT COUNT(*) n ${LINE_FROM} WHERE ${AT_BUYING_STAGE} AND ${extra}`, ...p).n;
  res.json({
    to_buy: mine.length ? c(`${inMine} AND l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED}`, ...mine) : 0,
    unassigned: c(`l.purchase_source IS NULL AND l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED}`),
    bought: mine.length ? c(`${inMine} AND l.purchased_at IS NOT NULL`, ...mine) : 0,
  });
}));

router.post('/seen', requireAuth, asyncHandler((req, res) => {
  run(`INSERT INTO user_seen_marks (user_id, key, seen_at) VALUES (?, 'purchasing', datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET seen_at = datetime('now')`, req.user.id);
  res.json({ ok: true });
}));

// ---- moving an item between the two channels -------------------------------

router.post('/lines/:id/source', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get('SELECT l.*, m.mrn_no FROM mrn_lines l JOIN mrn m ON m.id = l.mrn_id WHERE l.id = ?', id);
  if (!line) return res.status(404).json({ error: 'Item not found' });
  if (line.purchased_at) {
    return res.status(409).json({ error: 'Already bought — the channel cannot be changed afterwards' });
  }

  const to = String(req.body.purchase_source || '');
  if (!CHANNELS.includes(to)) return res.status(400).json({ error: 'Choose Head Office or Local Purchase' });
  if (to === line.purchase_source) return res.status(400).json({ error: `Already ${CHANNEL_LABEL[to]}` });

  // You may hand away what is yours, or claim what belongs to nobody. You may not reach into the
  // other officer's queue and take an item off them.
  const mine = channelsFor(req.user);
  const ownsIt = line.purchase_source === null || mine.includes(line.purchase_source);
  if (!ownsIt) return res.status(403).json({ error: `That item is on the ${CHANNEL_LABEL[line.purchase_source]} list` });
  if (!mine.length) return res.status(403).json({ error: 'You are not a purchasing officer' });

  // The reason is the point. A few months of "Head Office has no account with this supplier" is
  // the case for opening one — and without it a channel switch is indistinguishable from a slip.
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'Say why it has to move — one line is enough' });

  run(`UPDATE mrn_lines
          SET purchase_source = ?, source_changed_from = ?, source_changed_at = datetime('now'),
              source_changed_by = ?, source_changed_reason = ?
        WHERE id = ?`,
  to, line.purchase_source, req.user.username, reason, id);

  syncHeaderSource(line.mrn_id);
  audit.record({ userId: req.user.id, entity: 'mrn_lines', entityId: id, action: 'purchase_source',
    before: { purchase_source: line.purchase_source }, after: { purchase_source: to, reason } });
  emitter.emit('data_changed', { what: 'purchasing' });
  res.json({ ok: true, purchase_source: to, message: `Moved to ${CHANNEL_LABEL[to]}` });
}));

/**
 * The MRN header's purchase_source is a SUMMARY of its lines, not a second truth.
 * 'mixed' when the lines disagree, which is a normal state here and must not be flattened to
 * whichever line happened to be updated last.
 */
function syncHeaderSource(mrnId) {
  const kinds = all('SELECT DISTINCT purchase_source s FROM mrn_lines WHERE mrn_id = ? AND purchase_source IS NOT NULL', mrnId)
    .map((r) => r.s);
  const value = kinds.length === 1 ? kinds[0] : (kinds.length > 1 ? 'mixed' : null);
  run('UPDATE mrn SET purchase_source = ? WHERE id = ?', value, mrnId);
}

// ---- the tick --------------------------------------------------------------

const IMAGE_RE = /^data:image\/(png|jpe?g|webp);base64,/;
const MAX_IMAGE_CHARS = 900000;   // ~700 KB once decoded
const MAX_IMAGES = 3;

function imageError(list) {
  if (!Array.isArray(list) || !list.length) return { status: 400, error: 'Attach a photo of the invoice' };
  if (list.length > MAX_IMAGES) return { status: 400, error: `At most ${MAX_IMAGES} photos` };
  for (const img of list) {
    if (typeof img !== 'string' || !IMAGE_RE.test(img)) return { status: 400, error: 'That is not an image file' };
    // The database is copied whole every 30 minutes. An unbounded invoice photo does not just make
    // the row big, it multiplies every backup from here on.
    if (img.length > MAX_IMAGE_CHARS) return { status: 413, error: 'Photo too large — about 700 KB is the limit' };
  }
  return null;
}

router.post('/lines/:id/purchase', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get('SELECT l.*, m.mrn_no FROM mrn_lines l JOIN mrn m ON m.id = l.mrn_id WHERE l.id = ?', id);
  if (!line) return res.status(404).json({ error: 'Item not found' });
  if (line.purchased_at) return res.status(409).json({ error: `Already marked bought on ${String(line.purchased_at).slice(0, 10)}` });

  const channel = claimChannel(req.user, line.purchase_source);
  if (!channel) {
    return res.status(403).json({
      error: line.purchase_source
        ? `That item is on the ${CHANNEL_LABEL[line.purchase_source]} list`
        : 'Claim it to your list first — an item with no channel has no officer',
    });
  }

  require_(req.body, ['supplier', 'invoice_no']);
  const imgErr = imageError(req.body.images);
  if (imgErr) return res.status(imgErr.status).json({ error: imgErr.error });

  const invoiceDate = String(req.body.invoice_date || '').slice(0, 10);
  if (invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
    return res.status(400).json({ error: 'Invoice date must be YYYY-MM-DD' });
  }
  // The LINE TOTAL from the invoice, not a unit price. Stated because the same ambiguity in
  // service_filters/oils cost a reconciliation: those columns are line totals and were being
  // multiplied by quantity again.
  const amount = req.body.purchase_amount === '' || req.body.purchase_amount == null
    ? null : toNum(req.body.purchase_amount, 0);

  tx(() => {
    run(`UPDATE mrn_lines
            SET purchased_at = datetime('now'), purchased_by = ?, supplier = ?, invoice_no = ?,
                invoice_date = ?, purchase_amount = ?
          WHERE id = ?`,
    req.user.username, String(req.body.supplier).trim(), String(req.body.invoice_no).trim(),
    invoiceDate || null, amount, id);
    let seq = 0;
    for (const img of req.body.images) {
      run('INSERT INTO mrn_line_invoices (mrn_line_id, seq, image, uploaded_by) VALUES (?, ?, ?, ?)',
        id, seq++, img, req.user.id);
    }
  });

  audit.record({ userId: req.user.id, entity: 'mrn_lines', entityId: id, action: 'purchased',
    after: { mrn_no: line.mrn_no, supplier: req.body.supplier, invoice_no: req.body.invoice_no, amount } });
  emitter.emit('data_changed', { what: 'purchasing' });
  res.json({ ok: true, message: 'Marked bought' });
}));

/** Undoing a tick — a wrong invoice number should be correctable without a database edit. */
router.delete('/lines/:id/purchase', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get('SELECT * FROM mrn_lines WHERE id = ?', id);
  if (!line) return res.status(404).json({ error: 'Item not found' });
  if (!line.purchased_at) return res.status(409).json({ error: 'That item is not marked bought' });

  // The officer who bought it, or a manager. Not the other officer.
  const ownIt = claimChannel(req.user, line.purchase_source) || hasRole(req.user, 'admin', 'manager', 'operational_manager');
  if (!ownIt) return res.status(403).json({ error: 'Only the officer who bought it, or a manager, can undo this' });
  // Once the goods are in, the purchase record is part of the receipt's history.
  if (Number(line.qty_received) > 0) {
    return res.status(409).json({ error: 'Some of this has already been received — the purchase cannot be undone' });
  }

  tx(() => {
    run('DELETE FROM mrn_line_invoices WHERE mrn_line_id = ?', id);
    run(`UPDATE mrn_lines SET purchased_at = NULL, purchased_by = NULL, supplier = NULL,
            invoice_no = NULL, invoice_date = NULL, purchase_amount = NULL WHERE id = ?`, id);
  });
  audit.record({ userId: req.user.id, entity: 'mrn_lines', entityId: id, action: 'purchase_undone',
    before: { invoice_no: line.invoice_no, supplier: line.supplier } });
  emitter.emit('data_changed', { what: 'purchasing' });
  res.json({ ok: true, message: 'Purchase cleared' });
}));

// ---- one item in full ------------------------------------------------------

router.get('/lines/:id', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get(`SELECT ${LINE_COLS} ${LINE_FROM} WHERE l.id = ?`, id);
  if (!line) return res.status(404).json({ error: 'Item not found' });

  line.invoices = all('SELECT id, seq, image, note, uploaded_at FROM mrn_line_invoices WHERE mrn_line_id = ? ORDER BY seq, id', id);

  // What the storekeeper actually received against this line, and what it cost when it arrived.
  line.receipts = all(
    `SELECT id, grn_no, qty, unit_price, ROUND(qty * COALESCE(unit_price, 0), 2) AS value,
            supplier, invoice_no, delivery_date
       FROM grn WHERE mrn_line_id = ? ORDER BY id`, id);

  // A purchase price recorded BEFORE the goods arrive is new — until now the only price was the
  // one on the receipt. When the two disagree it is worth someone's attention rather than one
  // silently replacing the other, so it is reported, not resolved.
  const received = line.receipts.reduce((s, r) => s + (Number(r.value) || 0), 0);
  line.price_check = (line.purchase_amount != null && line.receipts.length && Math.abs(received - line.purchase_amount) > 0.5)
    ? { invoice: line.purchase_amount, received, difference: Number((received - line.purchase_amount).toFixed(2)) }
    : null;

  res.json(line);
}));

module.exports = router;
