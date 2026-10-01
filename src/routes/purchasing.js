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
const { requireAuth, hasCap } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const emitter = require('../lib/emitter');
const flow = require('../lib/purchasing_flow');

const router = express.Router();

const CHANNELS = flow.CHANNELS;
const CHANNEL_LABEL = flow.CHANNEL_LABEL;
const channelsFor = flow.channelsFor;
const seesBoth = flow.seesBoth;

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
  l.buying_priority, l.priority_note, l.priority_updated_at, l.priority_updated_by,
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

// ---- the monitor & queue ---------------------------------------------------

router.get('/flow/monitor', requireAuth, asyncHandler((req, res) => {
  res.json(flow.monitor(req.user));
}));

router.get('/queue', requireAuth, asyncHandler((req, res) => {
  const result = flow.lines(req.user, req.query);
  res.json(result);
}));

/** Counts for the tab badges and monitor deck */
router.get('/counts', requireAuth, asyncHandler((req, res) => {
  const m = flow.monitor(req.user);
  const mine = flow.channelsFor(req.user);
  const to_buy = !mine.length ? 0
    : (mine.length === flow.CHANNELS.length ? m.pipeline.to_buy_total
      : (mine.includes('head_office') ? m.pipeline.to_buy_ho : m.pipeline.to_buy_local));

  res.json({
    to_buy,
    to_buy_ho: m.pipeline.to_buy_ho,
    to_buy_local: m.pipeline.to_buy_local,
    urgent: m.urgency.urgent_total,
    p1_critical: m.urgency.p1_critical,
    p2_urgent: m.urgency.p2_urgent,
    p3_routine: m.urgency.p3_routine,
    p4_low: m.urgency.p4_low,
    unassigned: m.pipeline.unassigned,
    ordered: m.pipeline.ordered,
    bought: m.pipeline.bought_total,
    unpriced: m.watch.unpriced,
  });
}));

router.post('/seen', requireAuth, asyncHandler((req, res) => {
  run(`INSERT INTO user_seen_marks (user_id, key, seen_at) VALUES (?, 'purchasing', datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET seen_at = datetime('now')`, req.user.id);
  res.json({ ok: true });
}));

// ---- moving an item between the two channels -------------------------------

// Changing where a line is bought, and marking it bought, change the line: edit (a POST alone asks add).
const editsLine = require('../lib/permissions').requireModule('purchasing', 'edit');
router.post('/lines/:id/source', requireAuth, editsLine, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get('SELECT l.*, m.mrn_no FROM mrn_lines l JOIN mrn m ON m.id = l.mrn_id WHERE l.id = ?', id);
  if (!line) return res.status(404).json({ error: 'Item not found' });
  if (line.purchased_at) {
    return res.status(409).json({ error: 'Already bought — the channel cannot be changed afterwards' });
  }

  const to = String(req.body.purchase_source || '');
  if (!CHANNELS.includes(to)) return res.status(400).json({ error: 'Choose Head Office or Local Purchase' });
  if (to === line.purchase_source) return res.status(400).json({ error: `Already ${CHANNEL_LABEL[to]}` });

  // Both Head Office and Local Purchase officers (and managers) may change an item's buying channel
  // between Head Office and Local Purchase, or claim an unassigned item.
  const mine = channelsFor(req.user);
  const canReassign = mine.length > 0 || hasCap(req.user, 'purchasing.all_channels');
  if (!canReassign) return res.status(403).json({ error: 'You do not have permission to assign purchasing channels' });

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

// ---- workshop day-to-day priority adjustment -------------------------------

router.post('/lines/:id/priority', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get('SELECT l.*, m.mrn_no FROM mrn_lines l JOIN mrn m ON m.id = l.mrn_id WHERE l.id = ?', id);
  if (!line) return res.status(404).json({ error: 'Item not found' });
  if (line.purchased_at) {
    return res.status(409).json({ error: 'Already bought — priority cannot be changed afterwards' });
  }

  const canEdit = hasCap(req.user, 'purchasing.priority_edit')
    || hasCap(req.user, 'purchasing.all_channels')
    || hasCap(req.user, 'stores.mrn.edit')
    || (req.user.roles && (
      req.user.roles.includes('workshop')
      || req.user.roles.includes('operational_manager')
      || req.user.roles.includes('manager')
      || req.user.roles.includes('purchase_head_office')
      || req.user.roles.includes('purchase_local')
    ));
  if (!canEdit) return res.status(403).json({ error: 'Permission denied to adjust buying priority' });

  const priority = String(req.body.buying_priority || '').trim();
  if (!flow.PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority. Choose P1_CRITICAL, P2_URGENT, P3_ROUTINE, or P4_LOW' });
  }

  const note = req.body.note != null ? String(req.body.note).trim() : (line.priority_note || '');
  const oldPriority = line.buying_priority || 'P3_ROUTINE';

  tx(() => {
    run(`UPDATE mrn_lines
            SET buying_priority = ?, priority_note = ?, priority_updated_at = datetime('now'),
                priority_updated_by = ?
          WHERE id = ?`,
      priority, note || null, req.user.username, id);

    run(`INSERT INTO mrn_line_priority_history (mrn_line_id, old_priority, new_priority, note, changed_by)
         VALUES (?, ?, ?, ?, ?)`,
      id, oldPriority, priority, note || null, req.user.username);
  });

  audit.record({
    userId: req.user.id,
    entity: 'mrn_lines',
    entityId: id,
    action: 'buying_priority',
    before: { buying_priority: oldPriority },
    after: { buying_priority: priority, note }
  });

  emitter.emit('data_changed', { what: 'purchasing' });
  res.json({ ok: true, buying_priority: priority, message: `Priority set to ${flow.PRIORITY_LABELS[priority]}` });
}));

router.get('/lines/:id/priority-history', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const rows = all('SELECT * FROM mrn_line_priority_history WHERE mrn_line_id = ? ORDER BY id DESC', id);
  res.json({ rows });
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

router.post('/lines/:id/purchase', requireAuth, editsLine, asyncHandler((req, res) => {
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
  const ownIt = claimChannel(req.user, line.purchase_source) || hasCap(req.user, 'purchasing.all_channels');
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
  line.priority_history = all('SELECT * FROM mrn_line_priority_history WHERE mrn_line_id = ? ORDER BY id DESC', id);

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

const { sendXlsx } = require('../lib/export');

router.get('/export.xlsx', requireAuth, asyncHandler(async (req, res) => {
  const result = flow.lines(req.user, { ...req.query, limit: 5000 });
  const rows = result.rows.map((r) => ({
    priority: flow.PRIORITY_LABELS[r.buying_priority] || 'P3 Routine',
    priority_note: r.priority_note || '',
    priority_updated_by: r.priority_updated_by || '',
    mrn_no: r.mrn_no || '',
    asset: r.asset_code || r.asset_reg || '',
    item: r.description || '',
    qty: r.qty,
    unit: r.unit || '',
    channel: flow.CHANNEL_LABEL[r.purchase_source] || (r.purchase_source ? r.purchase_source : 'Unassigned'),
    req_date: r.req_date ? String(r.req_date).slice(0, 10) : '',
    required_date: r.required_date ? String(r.required_date).slice(0, 10) : '',
    supplier: r.supplier || '',
    invoice_no: r.invoice_no || '',
    purchase_amount: r.purchase_amount != null ? r.purchase_amount : '',
    purchased_at: r.purchased_at ? String(r.purchased_at).slice(0, 10) : '',
    purchased_by: r.purchased_by || '',
  }));

  await sendXlsx(res, `procurement-${req.query.tab || 'queue'}.xlsx`, [{
    name: 'Procurement Backlog',
    columns: [
      { header: 'Priority', key: 'priority', width: 14 },
      { header: 'Priority Note', key: 'priority_note', width: 28 },
      { header: 'MRN No', key: 'mrn_no', width: 14 },
      { header: 'Vehicle', key: 'asset', width: 14 },
      { header: 'Item Description', key: 'item', width: 36 },
      { header: 'Qty', key: 'qty', width: 8 },
      { header: 'Unit', key: 'unit', width: 8 },
      { header: 'Channel', key: 'channel', width: 16 },
      { header: 'Required Date', key: 'required_date', width: 14 },
      { header: 'Req Date', key: 'req_date', width: 12 },
      { header: 'Supplier', key: 'supplier', width: 20 },
      { header: 'Invoice No', key: 'invoice_no', width: 14 },
      { header: 'Amount', key: 'purchase_amount', width: 12 },
      { header: 'Bought Date', key: 'purchased_at', width: 12 },
      { header: 'Bought By', key: 'purchased_by', width: 14 },
    ],
    rows,
  }]);
}));

module.exports = router;
