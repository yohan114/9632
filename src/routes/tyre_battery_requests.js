'use strict';

// Asking for a tyre or a battery, and accounting for the one that came off.
//
// THE REQUEST IS AN ORDINARY MRN. Same number series, same certify-then-approve trail, same inbox
// the managers already sign in — a tyre is not special enough to deserve a second approval system,
// and two inboxes is how things stop being read. What a wheel or a battery needs on top of an
// ordinary line (which wheel, what the meter read, why, what is coming off) lives in
// tb_request_lines beside it.
//
// The one rule that makes this worth doing: THE ITEM IS CHOSEN FROM A LIST. Ten years of free text
// left 804 spellings of about 170 tyre sizes and a third of issues with no price. Every request
// here names a tb_specs row.
//
// And a replacement is not finished when the new one goes on. The old tyre may be worth repairing
// or retreading and the old battery has scrap value, so an issue stays OPEN until the old unit is
// accounted for — including "not returned", which is a real answer as long as it carries a reason.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const tb = require('../lib/tyre_battery');

const audit = require('../lib/audit');

const router = express.Router();
const KINDS = ['tyre', 'battery'];
const clean = (v) => (v == null ? null : String(v).trim() || null);
const kindOf = (v) => (KINDS.includes(String(v)) ? String(v) : null);

// Old units, and what the store decided about each.
const CONDITIONS = ['repairable', 'retreadable', 'reusable', 'warranty', 'scrap', 'not_returned'];
// Why the machine needs one. Free text hides the pattern; a list makes "how many burst this year"
// a question the system can answer.
const REASONS = {
  tyre: ['worn', 'puncture', 'sidewall', 'burst', 'accident', 'rotation', 'planned', 'other'],
  battery: ['low_capacity', 'no_crank', 'leakage', 'damage', 'warranty', 'planned', 'other'],
};

// ---------------------------------------------------------------------------
// The picklist. Deliberately only requireAuth: a list of tyre sizes is not a secret, and gating
// reference data behind a module is how dropdowns come up empty for the person filling the form.
// ---------------------------------------------------------------------------
router.get('/specs', requireAuth, asyncHandler((req, res) => {
  const kind = kindOf(req.query.kind);
  if (!kind) return res.status(400).json({ error: 'Say whether you want tyres or batteries' });
  res.json(tb.catalogue(kind, req.query.q));
}));

router.get('/reasons', requireAuth, asyncHandler((_req, res) => res.json(REASONS)));

// Read a written line and say which shelf it is — so the form can suggest one when somebody
// types instead of picking, and say plainly when it does not recognise the words.
router.get('/specs/resolve', requireAuth, asyncHandler((req, res) => {
  const kind = kindOf(req.query.kind);
  if (!kind) return res.status(400).json({ error: 'Say whether you want tyres or batteries' });
  const parsed = tb.parse(kind, req.query.text || '');
  res.json({ parsed, match: tb.resolve(kind, req.query.text || '') });
}));

// Setting a price is a manager's call, not a storekeeper's. Marked as set by a person so the
// workbook re-seed never overwrites it.
router.patch('/specs/:id', requireRole('manager', 'operational_manager'), asyncHandler((req, res) => {
  const spec = get('SELECT * FROM tb_specs WHERE id = ?', toInt(req.params.id));
  if (!spec) return res.status(404).json({ error: 'No such specification' });
  const price = req.body.unit_price === '' || req.body.unit_price == null ? null : toNum(req.body.unit_price);
  if (price != null && !(price > 0)) return res.status(400).json({ error: 'A price has to be more than nothing' });
  run(`UPDATE tb_specs SET unit_price = ?, source = ? WHERE id = ?`, price, req.user.username, spec.id);
  audit.record({ userId: req.user.id, entity: 'tb_specs', entityId: spec.id, action: 'price',
    before: { unit_price: spec.unit_price }, after: { unit_price: price } });
  res.json(get('SELECT * FROM tb_specs WHERE id = ?', spec.id));
}));

// ---------------------------------------------------------------------------
// Raising the request
// ---------------------------------------------------------------------------

/** The next request number, continuing the series the workshop already uses. */
function nextMrnNo() {
  const last = get(`SELECT mrn_no FROM mrn WHERE mrn_no GLOB '[0-9]*' ORDER BY CAST(mrn_no AS INTEGER) DESC LIMIT 1`);
  return String((last ? parseInt(last.mrn_no, 10) : 167000) + 1);
}

router.post('/requests', requireRole('workshop', 'storekeeper', 'manager', 'operational_manager', 'transport_manager'),
  asyncHandler((req, res) => {
    const b = req.body || {};
    require_(b, ['kind', 'lines']);
    const kind = kindOf(b.kind);
    if (!kind) return res.status(400).json({ error: 'Say whether this is for tyres or batteries' });
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) return res.status(400).json({ error: 'A request needs at least one item on it' });

    // A tyre or a battery is always FOR something. Without the machine there is no cost to carry
    // and no history to build, which is the whole point of asking.
    const jobId = toInt(b.job_id) || null;
    // A job card knows its own vehicle, so naming the job is enough — the same courtesy the
    // stores issue screen already extends.
    let assetId = toInt(b.asset_id);
    if (!assetId && jobId) {
      const j = get('SELECT asset_id FROM job_cards WHERE id = ?', jobId);
      assetId = j ? j.asset_id : null;
    }
    if (!assetId) return res.status(400).json({ error: 'Which vehicle or machine is this for?' });
    const asset = get('SELECT id, code FROM assets WHERE id = ?', assetId);
    if (!asset) return res.status(400).json({ error: 'That vehicle is not on the register' });

    const prepared = [];
    for (const [i, ln] of lines.entries()) {
      const spec = get('SELECT * FROM tb_specs WHERE id = ? AND COALESCE(active,1) = 1', toInt(ln.spec_id));
      if (!spec) return res.status(400).json({ error: `Line ${i + 1}: pick the size or rating from the list` });
      if (spec.kind !== kind) return res.status(400).json({ error: `Line ${i + 1}: that is a ${spec.kind}, not a ${kind}` });
      const qty = toNum(ln.qty, 0);
      if (!(qty > 0)) return res.status(400).json({ error: `Line ${i + 1}: how many?` });
      const reason = clean(ln.reason);
      if (!reason || !REASONS[kind].includes(reason)) {
        return res.status(400).json({ error: `Line ${i + 1}: say why it is needed (${REASONS[kind].join(', ')})` });
      }
      // The meter reading is what makes "how long did that tyre last" answerable later. A meter
      // that does not work is a fact too — it goes in the remark, not as a fake zero.
      const kmRaw = ln.km_reading;
      const km = kmRaw === '' || kmRaw == null ? null : toNum(kmRaw);
      prepared.push({
        spec, qty, reason,
        position: clean(ln.position),
        km_reading: km != null && km >= 0 ? km : null,
        km_remark: clean(ln.km_remark),
        old_serial: clean(ln.old_serial),
        priority: ['normal', 'urgent', 'breakdown'].includes(String(ln.priority)) ? String(ln.priority) : 'normal',
        notes: clean(ln.notes),
      });
    }

    const mrnNo = nextMrnNo();
    const out = tx(() => {
      const mrnId = run(
        `INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, purpose, requested_by, status, approval_status, request_type)
         VALUES (?, date('now'), ?, ?, ?, ?, 'open', 'requested', ?)`,
        mrnNo, asset.id, jobId, clean(b.purpose) || (kind === 'tyre' ? 'Tyre replacement' : 'Battery replacement'),
        clean(b.requested_by) || req.user.username, kind).lastInsertRowid;

      for (const p of prepared) {
        const lineId = run(
          `INSERT INTO mrn_lines (mrn_id, description, qty, unit, category)
           VALUES (?, ?, ?, 'nos', ?)`,
          mrnId, p.spec.label, p.qty, kind === 'tyre' ? 'Tyres & Wheels' : 'Battery').lastInsertRowid;
        run(
          `INSERT INTO tb_request_lines (mrn_line_id, kind, spec_id, asset_id, site, position,
                                         km_reading, km_remark, reason, priority, old_serial, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          lineId, kind, p.spec.id, asset.id, clean(b.site), p.position,
          p.km_reading, p.km_remark, p.reason, p.priority, p.old_serial, p.notes);
      }
      return mrnId;
    });

    audit.record({ userId: req.user.id, entity: 'mrn', entityId: out, action: 'create',
      after: { mrn_no: mrnNo, kind, lines: prepared.length, asset: asset.code } });
    res.status(201).json({ id: out, mrn_no: mrnNo, lines: prepared.length });
  }));

/** Requests, with where each one has got to. */
router.get('/requests', requireAuth, asyncHandler((req, res) => {
  const kind = kindOf(req.query.kind);
  const w = ['m.request_type IN (\'tyre\',\'battery\')'];
  const p = [];
  if (kind) { w.push('m.request_type = ?'); p.push(kind); }
  if (req.query.status) { w.push('m.approval_status = ?'); p.push(String(req.query.status)); }
  res.json(all(
    `SELECT m.id, m.mrn_no, m.req_date, m.request_type AS kind, m.approval_status, m.status,
            m.requested_by, m.certified_by, m.approved_by, m.purpose,
            a.code AS asset_code, a.registration, j.job_no,
            (SELECT COUNT(*) FROM mrn_lines l WHERE l.mrn_id = m.id) AS lines,
            (SELECT COALESCE(SUM(l.qty),0) FROM mrn_lines l WHERE l.mrn_id = m.id) AS qty,
            (SELECT COUNT(*) FROM mrn_lines l JOIN tyre_battery_issues i ON i.mrn_line_id = l.id
              WHERE l.mrn_id = m.id) AS issued_lines
       FROM mrn m
       LEFT JOIN assets a ON a.id = m.asset_id
       LEFT JOIN job_cards j ON j.id = m.job_id
      WHERE ${w.join(' AND ')}
      ORDER BY m.req_date DESC, m.id DESC
      LIMIT ${toInt(req.query.limit, 200)}`, ...p));
}));

router.get('/requests/:id', requireAuth, asyncHandler((req, res) => {
  const m = get(
    `SELECT m.*, a.code AS asset_code, a.registration, j.job_no
       FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id LEFT JOIN job_cards j ON j.id = m.job_id
      WHERE m.id = ?`, toInt(req.params.id));
  if (!m) return res.status(404).json({ error: 'No such request' });
  const lines = all(
    `SELECT l.id AS mrn_line_id, l.description, l.qty, l.qty_received,
            r.*, s.label AS spec_label, s.unit_price, s.kind AS spec_kind,
            (SELECT COUNT(*) FROM tyre_battery_issues i WHERE i.mrn_line_id = l.id) AS issued
       FROM mrn_lines l
       LEFT JOIN tb_request_lines r ON r.mrn_line_id = l.id
       LEFT JOIN tb_specs s ON s.id = r.spec_id
      WHERE l.mrn_id = ? ORDER BY l.id`, m.id);
  res.json({ ...m, lines, approvals: all('SELECT * FROM mrn_approvals WHERE mrn_id = ? ORDER BY id', m.id) });
}));

// ---------------------------------------------------------------------------
// Issuing against an approved request
// ---------------------------------------------------------------------------
router.post('/issue', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body || {};
  require_(b, ['mrn_line_id', 'qty']);
  const line = get(
    `SELECT l.id, l.mrn_id, l.qty, l.description, m.mrn_no, m.approval_status, m.asset_id, m.job_id,
            r.kind, r.spec_id, r.site, r.position, r.km_reading, r.km_remark, r.old_serial,
            s.label AS spec_label, s.unit_price
       FROM mrn_lines l
       JOIN mrn m ON m.id = l.mrn_id
       JOIN tb_request_lines r ON r.mrn_line_id = l.id
       LEFT JOIN tb_specs s ON s.id = r.spec_id
      WHERE l.id = ?`, toInt(b.mrn_line_id));
  if (!line) return res.status(404).json({ error: 'That is not a tyre or battery request line' });

  // NOTHING LEAVES THE STORE ON A REQUEST NOBODY HAS APPROVED. This is the whole point of the
  // module: the old register recorded issues with no request behind them at all.
  if (line.approval_status !== 'approved') {
    return res.status(409).json({
      error: `Request ${line.mrn_no} is ${line.approval_status || 'not approved'} — it has to be approved before anything leaves the store`,
    });
  }

  const qty = toNum(b.qty, 0);
  if (!(qty > 0)) return res.status(400).json({ error: 'How many are going out?' });
  const already = get('SELECT COALESCE(SUM(qty),0) v FROM tyre_battery_issues WHERE mrn_line_id = ?', line.id).v;
  if (already + qty > line.qty + 0.001) {
    return res.status(400).json({ error: `${line.description}: ${line.qty} was approved and ${already} already went out` });
  }

  const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.issue_date || '')) ? b.issue_date : new Date().toISOString().slice(0, 10);
  const price = b.unit_price === '' || b.unit_price == null ? line.unit_price : toNum(b.unit_price);
  const asset = line.asset_id ? get('SELECT code, registration FROM assets WHERE id = ?', line.asset_id) : null;
  const serial = clean(b.serial_no);

  const issueId = tx(() => {
    const id = run(
      `INSERT INTO tyre_battery_issues
         (kind, issue_date, vehicle, asset_id, site, qty, qty_raw, category, category_norm,
          min_number, km, unit_price, source, spec_id, mrn_line_id, serial_no, position, issued_by, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'request', ?, ?, ?, ?, ?, ?)`,
      line.kind, issueDate, asset ? asset.code : null, line.asset_id, line.site, qty, String(qty),
      line.spec_label, tb.parse(line.kind, line.spec_label || '').spec_key,
      line.mrn_no, line.km_reading == null ? '' : String(line.km_reading),
      price == null ? null : price, line.spec_id, line.id, serial, line.position,
      clean(b.issued_by) || req.user.username, line.job_id).lastInsertRowid;

    // NO stock_moves ROW IS WRITTEN HERE ON PURPOSE. stock_moves is a projection, and its
    // rebuild already reads tyre_battery_issues for both sections — writing one by hand would key
    // it slightly differently from the rebuild and leave the shelf holding the movement twice.
    // The register is the source; the ledger catches up on the next rebuild.
    run(`UPDATE mrn_lines SET qty_received = COALESCE(qty_received,0) + ? WHERE id = ?`, qty, line.id);
    return id;
  });

  audit.record({ userId: req.user.id, entity: 'tyre_battery_issues', entityId: issueId, action: 'issue',
    after: { mrn_no: line.mrn_no, kind: line.kind, qty, spec: line.spec_label, asset: asset && asset.code } });
  res.status(201).json({
    id: issueId, mrn_no: line.mrn_no, kind: line.kind, qty,
    // The storekeeper is told immediately what still has to come back, rather than finding out
    // at month end that nobody recorded the old one.
    old_unit_due: true,
    message: `Issued against ${line.mrn_no}. Record what came off before this is finished.`,
  });
}));

// ---------------------------------------------------------------------------
// What came off
// ---------------------------------------------------------------------------
router.post('/returns', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body || {};
  require_(b, ['issue_id', 'condition']);
  const issue = get('SELECT * FROM tyre_battery_issues WHERE id = ?', toInt(b.issue_id));
  if (!issue) return res.status(404).json({ error: 'No such issue' });
  const condition = String(b.condition);
  if (!CONDITIONS.includes(condition)) {
    return res.status(400).json({ error: `Say what became of the old one (${CONDITIONS.join(', ')})` });
  }
  // "Not returned" is a real answer — a tyre bursts on the road, a supplier takes the old battery
  // in exchange. It just has to say WHY, or the gap is indistinguishable from forgetting.
  const reason = clean(b.exception_reason);
  if (condition === 'not_returned' && !reason) {
    return res.status(400).json({ error: 'Say why the old one is not coming back' });
  }
  if (get('SELECT id FROM tb_returns WHERE issue_id = ?', issue.id)) {
    return res.status(409).json({ error: 'What came off this issue is already recorded' });
  }

  const id = run(
    `INSERT INTO tb_returns (issue_id, kind, asset_id, serial_no, condition, exception_reason,
                             km_reading, returned_to, received_by, notes, return_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    issue.id, issue.kind, issue.asset_id, clean(b.serial_no), condition, reason,
    b.km_reading == null || b.km_reading === '' ? null : toNum(b.km_reading),
    clean(b.returned_to), clean(b.received_by) || req.user.username, clean(b.notes),
    /^\d{4}-\d{2}-\d{2}$/.test(String(b.return_date || '')) ? b.return_date : new Date().toISOString().slice(0, 10)
  ).lastInsertRowid;

  audit.record({ userId: req.user.id, entity: 'tb_returns', entityId: id, action: 'create',
    after: { issue_id: issue.id, condition, kind: issue.kind } });
  res.status(201).json(get('SELECT * FROM tb_returns WHERE id = ?', id));
}));

/** Issues still waiting for someone to say what came off. This is the list that stops old units
 *  quietly disappearing — an old battery is worth money and an old tyre may be retreadable. */
router.get('/returns/outstanding', requireAuth, asyncHandler((req, res) => {
  const kind = kindOf(req.query.kind);
  res.json(all(
    `SELECT i.id AS issue_id, i.kind, i.issue_date, i.qty, i.category AS spec_label, i.serial_no,
            i.position, i.min_number AS mrn_no, a.code AS asset_code, a.registration, i.issued_by
       FROM tyre_battery_issues i
       LEFT JOIN assets a ON a.id = i.asset_id
      WHERE i.source = 'request'
        AND NOT EXISTS (SELECT 1 FROM tb_returns r WHERE r.issue_id = i.id)
        ${kind ? 'AND i.kind = ?' : ''}
      ORDER BY i.issue_date, i.id
      LIMIT ${toInt(req.query.limit, 200)}`, ...(kind ? [kind] : [])));
}));

/** What the store is holding in old units, by what it decided about them. */
router.get('/returns/summary', requireAuth, asyncHandler((_req, res) => {
  res.json(all(
    `SELECT kind, condition, COUNT(*) n
       FROM tb_returns GROUP BY kind, condition ORDER BY kind, n DESC`));
}));

module.exports = router;
