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
const { requireAuth, requireCap } = require('../lib/auth');
const jobstate = require('../lib/jobstate');
const { requireModule } = require('../lib/permissions');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const tb = require('../lib/tyre_battery');

const audit = require('../lib/audit');
const units = require('../lib/tb_units');
const unitPhotos = require('../lib/unit_photos');
const stock = require('../lib/stock');
const stockRule = require('../lib/stock_rule');

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };

const router = express.Router();
const KINDS = ['tyre', 'battery'];
const clean = (v) => (v == null ? null : String(v).trim() || null);
const kindOf = (v) => (KINDS.includes(String(v)) ? String(v) : null);

// A TYRE RARELY GOES ON ALONE. The register has been writing "750 X 16 TYER /TUBE/COLLER" into the
// tyre's own description for want of anywhere else to put it, so one tyre request carries the tyre,
// its tube and its flap. A battery has no such companions.
const ALLOWED_LINES = { tyre: ['tyre', 'tube', 'flap'], battery: ['battery'] };
const LINE_LABEL = { tyre: 'tyre', tube: 'tube', flap: 'flap', battery: 'battery' };

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
router.patch('/specs/:id', requireCap('tb.specs.edit'), asyncHandler((req, res) => {
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

router.post('/requests', requireModule('tb_request'),
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
    // Naming a job card: it must exist, and a finished card takes no new request (jobstate.checkAdd).
    if (jobId) {
      // Stage 3: only your own workshop's cards (head office and store staff: any).
      const no = require('../lib/scope').jobRefusal(req.user, jobId);
      if (no) return res.status(403).json(no);
      const g = jobstate.checkAdd(get('SELECT id, job_no, status FROM job_cards WHERE id = ?', jobId), 'tb_request', { user: req.user });
      if (!g.ok) return res.status(g.status).json(g.body);
    }
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
      if (!ALLOWED_LINES[kind].includes(spec.kind)) {
        return res.status(400).json({
          error: `Line ${i + 1}: a ${LINE_LABEL[spec.kind] || spec.kind} does not belong on a ${kind} request`,
        });
      }
      const qty = toNum(ln.qty, 0);
      if (!(qty > 0)) return res.status(400).json({ error: `Line ${i + 1}: how many?` });
      // The reason belongs to the JOB, so a tube going on with a worn tyre inherits it rather than
      // asking the fitter to justify a tube separately.
      const reason = clean(ln.reason) || clean(b.reason);
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
        // request_type keeps its own meaning — general vs vehicle — which stores and daily work
        // both read on all 1,709 existing requests. The tyre/battery kind has a column of its own.
        `INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, purpose, requested_by, status, approval_status, request_type, tb_kind, workshop_id)
         VALUES (?, date('now'), ?, ?, ?, ?, 'open', 'requested', 'vehicle', ?, ?)`,
        mrnNo, asset.id, jobId, clean(b.purpose) || (kind === 'tyre' ? 'Tyre replacement' : 'Battery replacement'),
        clean(b.requested_by) || req.user.username, kind, require('../lib/workshops').forRequest(req.user, jobId)).lastInsertRowid;

      for (const p of prepared) {
        const lineId = run(
          `INSERT INTO mrn_lines (mrn_id, description, qty, unit, category)
           VALUES (?, ?, ?, 'nos', ?)`,
          mrnId, p.spec.label, p.qty, kind === 'tyre' ? 'Tyres & Wheels' : 'Battery').lastInsertRowid;
        run(
          `INSERT INTO tb_request_lines (mrn_line_id, kind, spec_id, asset_id, site, position,
                                         km_reading, km_remark, reason, priority, old_serial, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          // The LINE's own kind, not the request's — a tyre request holds tubes and flaps too, and
          // recording them all as "tyre" would make "how many tubes did we fit" unanswerable.
          lineId, p.spec.kind, p.spec.id, asset.id, clean(b.site), p.position,
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
  const w = ['m.tb_kind IS NOT NULL'];
  const p = [];
  if (kind) { w.push('m.tb_kind = ?'); p.push(kind); }
  if (req.query.status) { w.push('m.approval_status = ?'); p.push(String(req.query.status)); }
  // Approved, but nobody has sent it to Head Office to be bought yet — the queue the Workshop
  // Store works from, and the one thing an approved request used to fall silently out of.
  if (req.query.awaiting_purchase) w.push("m.approval_status = 'approved' AND m.purchase_requested_at IS NULL");
  // Stage 3: your own workshop's requests only (head office and store staff: all).
  const own = require('../lib/scope').filter(req.user, 'm.workshop_id');
  if (own.sql) { w.push(own.sql); p.push(...own.params); }
  res.json(all(
    `SELECT m.id, m.mrn_no, m.req_date, m.tb_kind AS kind, m.approval_status, m.status,
            m.purchase_requested_at, m.purchase_requested_by, m.purchase_ref, m.purchase_source,
            m.requested_by, m.certified_by, m.approved_by, m.purpose,
            a.code AS asset_code, a.registration, j.job_no,
            (SELECT COUNT(*) FROM mrn_lines l WHERE l.mrn_id = m.id) AS lines,
            (SELECT COALESCE(SUM(l.qty),0) FROM mrn_lines l WHERE l.mrn_id = m.id) AS qty,
            -- A line is issued when all of it has gone out (a tyre goes one row a tyre, Part 4).
            (SELECT COUNT(*) FROM mrn_lines l WHERE l.mrn_id = m.id
                AND (SELECT COALESCE(SUM(i.qty), 0) FROM tyre_battery_issues i WHERE i.mrn_line_id = l.id) >= l.qty - 0.001) AS issued_lines
       FROM mrn m
       LEFT JOIN assets a ON a.id = m.asset_id
       LEFT JOIN job_cards j ON j.id = m.job_id
      WHERE ${w.join(' AND ')}
      ORDER BY m.req_date DESC, m.id DESC
      LIMIT ${toInt(req.query.limit, 200)}`, ...p));
}));

router.get('/requests/:id', requireAuth, asyncHandler((req, res) => {
  { const no = require('../lib/scope').mrnRefusal(req.user, toInt(req.params.id)); if (no) return res.status(403).json(no); }
  const m = get(
    `SELECT m.*, a.code AS asset_code, a.registration, j.job_no
       FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id LEFT JOIN job_cards j ON j.id = m.job_id
      WHERE m.id = ?`, toInt(req.params.id));
  if (!m) return res.status(404).json({ error: 'No such request' });
  const lines = all(
    `SELECT l.id AS mrn_line_id, l.description, l.qty, l.qty_received,
            r.*, s.label AS spec_label, s.unit_price, s.kind AS spec_kind,
            (SELECT COALESCE(SUM(i.qty), 0) FROM tyre_battery_issues i WHERE i.mrn_line_id = l.id) AS issued
       FROM mrn_lines l
       LEFT JOIN tb_request_lines r ON r.mrn_line_id = l.id
       LEFT JOIN tb_specs s ON s.id = r.spec_id
      WHERE l.mrn_id = ? ORDER BY l.id`, m.id);
  res.json({ ...m, lines, approvals: all('SELECT * FROM mrn_approvals WHERE mrn_id = ? ORDER BY id', m.id) });
}));

// ---------------------------------------------------------------------------
// Sending it to be bought
//
// THE WORKSHOP STORE DOES NOT BUY TYRES. It raises the request and has it approved, and then the
// request goes to Head Office, who purchase. So for a tyre or a battery an approval is not the end
// of the story the way it is for an ordinary part off the workshop shelf — and without this step
// an approved request simply sat there, with nobody able to say whether anyone had been asked to
// buy it. An ordinary workshop MRN is untouched: only tyres and batteries carry this stage.
// ---------------------------------------------------------------------------
router.post('/requests/:id/purchase', requireModule('tb_purchase'), asyncHandler((req, res) => {
  const m = get('SELECT * FROM mrn WHERE id = ? AND tb_kind IS NOT NULL', toInt(req.params.id));
  if (!m) return res.status(404).json({ error: 'That is not a tyre or battery request' });
  if (m.approval_status !== 'approved') {
    return res.status(409).json({
      error: `Request ${m.mrn_no} is ${m.approval_status || 'not approved'} — nothing is sent to be bought before it is approved`,
    });
  }
  if (m.purchase_requested_at) {
    return res.status(409).json({ error: `Request ${m.mrn_no} was already sent to be bought on ${String(m.purchase_requested_at).slice(0, 10)}` });
  }
  // Head Office by default, because that is who buys these. A line bought locally instead is a
  // deliberate exception and says so.
  const source = ['head_office', 'local_purchase'].includes(String(req.body.purchase_source))
    ? String(req.body.purchase_source) : 'head_office';

  run(`UPDATE mrn SET purchase_requested_at = ?, purchase_requested_by = ?, purchase_ref = ?, purchase_source = ?
        WHERE id = ?`,
  /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || '')) ? req.body.date : new Date().toISOString().slice(0, 10),
  clean(req.body.requested_by) || req.user.username, clean(req.body.purchase_ref), source, m.id);
  // The lines carry it too, so a receipt against one of them knows where it came from.
  run(`UPDATE mrn_lines SET purchase_source = ? WHERE mrn_id = ?`, source, m.id);

  audit.record({ userId: req.user.id, entity: 'mrn', entityId: m.id, action: 'purchase_request',
    after: { mrn_no: m.mrn_no, purchase_source: source, ref: clean(req.body.purchase_ref) } });
  res.json(get('SELECT id, mrn_no, purchase_requested_at, purchase_requested_by, purchase_ref, purchase_source FROM mrn WHERE id = ?', m.id));
}));

// ---------------------------------------------------------------------------
// Issuing against an approved request
// ---------------------------------------------------------------------------
router.post('/issue', requireModule('tb_issue'), asyncHandler((req, res) => {
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

  // Stores plan, Part 4: a tyre or a battery goes out by its serial number, one unit at a time, and
  // is fixed to the vehicle at that moment (ST-D6, D7). A tube or a flap goes out as before.
  const byUnit = units.isUnitKind(line.kind);
  let wanted = [];
  if (byUnit) {
    wanted = Array.isArray(b.units) ? b.units
      : [{ serial_no: b.serial_no, position: b.position, old_serial: b.old_serial, old_condition: b.old_condition, old_reason: b.old_reason, photo: b.photo }];
    if (!Number.isInteger(qty) || wanted.length !== qty || wanted.some((u) => !units.cleanSerial(u && u.serial_no))) {
      return res.status(400).json({ error: `Give the serial number of each ${line.kind} going out (${qty}).` });
    }
    const serials = wanted.map((u) => units.cleanSerial(u.serial_no).toUpperCase());
    if (new Set(serials).size !== serials.length) return res.status(400).json({ error: 'The same serial number is given twice.' });
    const going = wanted.map((u) => (clean(u.old_serial) || '').toUpperCase()).filter(Boolean);
    if (going.some((o) => serials.includes(o))) return res.status(400).json({ error: 'A serial is given both going on and coming off.' });
    if (new Set(going).size !== going.length) return res.status(400).json({ error: 'The same old serial is given twice.' });
    if (line.kind === 'tyre') {
      const wheels = wanted.map((u) => String(clean(u.position) || line.position || '').toUpperCase()).filter(Boolean);
      const twice = wheels.find((w, i) => wheels.indexOf(w) !== i);
      if (twice) return res.status(400).json({ error: `Two tyres cannot go on at ${twice}. Give each one its own wheel.` });
    }
    if (!line.asset_id) return res.status(400).json({ error: 'This request names no vehicle, so nothing can be fitted.' });
    // ST-D8: what came off this vehicle last time has to be written down before the next one goes on.
    const due = get(`SELECT i.issue_date, i.category, i.min_number FROM tyre_battery_issues i
                      WHERE i.asset_id = ? AND i.kind = ? AND i.source = 'request' AND i.issue_date < ?
                        AND NOT EXISTS (SELECT 1 FROM tb_returns r WHERE r.issue_id = i.id)
                      ORDER BY i.issue_date, i.id LIMIT 1`, line.asset_id, line.kind, issueDate);
    if (due) {
      return res.status(409).json({ error: `Record what came off ${asset ? asset.code : 'this vehicle'} first: the ${due.category || line.kind} issued on ${due.issue_date}${due.min_number ? ' (request ' + due.min_number + ')' : ''}.` });
    }
  }

  const write = (q, serial, position) => run(
    `INSERT INTO tyre_battery_issues
       (kind, issue_date, vehicle, asset_id, site, qty, qty_raw, category, category_norm,
        min_number, km, unit_price, source, spec_id, mrn_line_id, serial_no, position, issued_by, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'request', ?, ?, ?, ?, ?, ?)`,
    line.kind, issueDate, asset ? asset.code : null, line.asset_id, line.site, q, String(q),
    line.spec_label, tb.parse(line.kind, line.spec_label || '').spec_key,
    line.mrn_no, line.km_reading == null ? '' : String(line.km_reading),
    price == null ? null : price, line.spec_id, line.id, serial, position,
    clean(b.issued_by) || req.user.username, line.job_id).lastInsertRowid;

  const ids = tx(() => {
    const rows = [];
    if (!byUnit) rows.push(write(qty, clean(b.serial_no), line.position));
    for (const u of wanted) {
      const kind = line.kind;
      const position = kind === 'tyre' ? (clean(u.position) || line.position) : null;
      const serial = units.cleanSerial(u.serial_no);
      // The one coming off: named, or — for a tyre — whatever is at that wheel now.
      let old = null;
      const oldSerial = clean(u.old_serial);
      if (oldSerial) {
        old = units.bySerial(kind, oldSerial);
        if (!old) fail(404, `There is no ${kind} ${oldSerial} in the register.`);
      } else if (kind === 'tyre' && position) {
        old = units.onVehicle('tyre', line.asset_id, position)[0] || null;
      }
      const id = write(1, serial, position ? position.toUpperCase() : null);
      if (old) {
        units.takeOff(kind, old, { assetId: line.asset_id, issueId: id, userId: req.user.id, date: issueDate, km: line.km_reading });
        run('UPDATE tyre_battery_issues SET old_unit_id = ? WHERE id = ?', old.id, id);
      }
      const storeId = get('SELECT store_id FROM tyre_battery_issues WHERE id = ?', id).store_id;
      const unitId = units.fit(kind, { serial, specId: line.spec_id, assetId: line.asset_id, position, storeId, issueId: id,
        userId: req.user.id, date: issueDate, km: line.km_reading, reason: 'Issued on request ' + line.mrn_no });
      run('UPDATE tyre_battery_issues SET unit_id = ? WHERE id = ?', unitId, id);
      // The serial plate, photographed (ST-D6: recommended, not required).
      if (u.photo) {
        const err = unitPhotos.add(kind, unitId, [u.photo], req.user.id, 'Serial plate, at issue');
        if (err) fail(err.status, err.error);
      }
      // What came off, when the store already knows.
      if (clean(u.old_condition)) {
        recordReturn(get('SELECT * FROM tyre_battery_issues WHERE id = ?', id),
          { condition: u.old_condition, exception_reason: u.old_reason, serial_no: old ? old.serial_no : null, km_reading: line.km_reading }, req.user);
      }
      rows.push(id);
    }

    // NO stock_moves ROW IS WRITTEN BY HAND HERE. stock_moves is a projection, and its rebuild
    // already reads tyre_battery_issues for both sections — writing one by hand would key it
    // slightly differently from the rebuild and leave the shelf holding the movement twice. The
    // register is the source; since the stores plan, Part 3, stock.sync projects these rows at
    // once by the rebuild's own rule — and, since Part 4, only what the store holds goes out.
    run(`UPDATE mrn_lines SET qty_received = COALESCE(qty_received,0) + ? WHERE id = ?`, qty, line.id);
    stockRule.check(stock.sync({ tyre_battery_issues: rows }));
    return rows;
  });

  audit.record({ userId: req.user.id, entity: 'tyre_battery_issues', entityId: ids[0], action: 'issue',
    after: { mrn_no: line.mrn_no, kind: line.kind, qty, spec: line.spec_label, asset: asset && asset.code,
      serials: wanted.map((u) => units.cleanSerial(u.serial_no)) } });
  const due = byUnit ? get(`SELECT COUNT(*) n FROM tyre_battery_issues i WHERE i.id IN (${ids.join(',')})
                              AND NOT EXISTS (SELECT 1 FROM tb_returns r WHERE r.issue_id = i.id)`).n : 0;
  res.status(201).json({
    id: ids[0], ids, mrn_no: line.mrn_no, kind: line.kind, qty,
    // The storekeeper is told immediately what still has to come back, rather than finding out
    // at month end that nobody recorded the old one.
    old_unit_due: due > 0,
    message: due ? `Issued against ${line.mrn_no}. Record what came off before this is finished.` : `Issued against ${line.mrn_no}.`,
  });
}));

// ---------------------------------------------------------------------------
// What came off
// ---------------------------------------------------------------------------

/**
 * Record what came off one issue, and move the old unit on in its register (Part 4): repaired,
 * retreaded, reused, on warranty, scrap, or not returned — which must say why.
 */
function recordReturn(issue, b, user) {
  const condition = String(b.condition || '');
  if (!CONDITIONS.includes(condition)) fail(400, `Say what became of the old one (${CONDITIONS.join(', ')})`);
  // "Not returned" is a real answer — a tyre bursts on the road, a supplier takes the old battery
  // in exchange. It just has to say WHY, or the gap is indistinguishable from forgetting.
  const reason = clean(b.exception_reason);
  if (condition === 'not_returned' && !reason) fail(400, 'Say why the old one is not coming back');
  if (get('SELECT id FROM tb_returns WHERE issue_id = ?', issue.id)) fail(409, 'What came off this issue is already recorded');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.return_date || '')) ? b.return_date : new Date().toISOString().slice(0, 10);
  const serial = clean(b.serial_no);
  const id = run(
    `INSERT INTO tb_returns (issue_id, kind, asset_id, serial_no, condition, exception_reason,
                             km_reading, returned_to, received_by, notes, return_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    issue.id, issue.kind === 'battery' ? 'battery' : 'tyre', issue.asset_id, serial, condition, reason,
    b.km_reading == null || b.km_reading === '' ? null : toNum(b.km_reading),
    clean(b.returned_to), clean(b.received_by) || user.username, clean(b.notes), date).lastInsertRowid;
  // The old unit: the one the issue took off, else the one with this serial — or, for a unit the
  // register never knew, a record of it now, so a scrap tyre can still go on a disposal note.
  if (units.isUnitKind(issue.kind)) {
    let unitId = issue.old_unit_id || (serial && (units.bySerial(issue.kind, serial) || {}).id) || null;
    if (!unitId && serial) {
      unitId = issue.kind === 'tyre'
        ? run("INSERT INTO tyres (serial_no, spec_id, state, store_id) VALUES (?, ?, 'removed', ?)", units.cleanSerial(serial), issue.spec_id || null, issue.store_id || null).lastInsertRowid
        : run("INSERT INTO batteries (serial_no, spec_id, condition, state, store_id) VALUES (?, ?, 'old', 'removed', ?)", units.cleanSerial(serial), issue.spec_id || null, issue.store_id || null).lastInsertRowid;
      run('UPDATE tyre_battery_issues SET old_unit_id = ? WHERE id = ?', unitId, issue.id);
    }
    if (unitId) units.settle(issue.kind, unitId, condition, { userId: user.id, date, reason: reason || clean(b.notes), storeId: issue.store_id });
  }
  audit.record({ userId: user.id, entity: 'tb_returns', entityId: id, action: 'create',
    after: { issue_id: issue.id, condition, kind: issue.kind } });
  return id;
}

router.post('/returns', requireModule('tb_issue'), asyncHandler((req, res) => {
  const b = req.body || {};
  require_(b, ['issue_id', 'condition']);
  const issue = get('SELECT * FROM tyre_battery_issues WHERE id = ?', toInt(b.issue_id));
  if (!issue) return res.status(404).json({ error: 'No such issue' });
  const id = tx(() => recordReturn(issue, b, req.user));
  res.status(201).json(get('SELECT * FROM tb_returns WHERE id = ?', id));
}));

// A vehicle's tyres (by wheel) and batteries, and every one fitted and taken off (Part 4).
router.get('/vehicle/:assetId', requireAuth, asyncHandler((req, res) => res.json(units.vehicle(toInt(req.params.assetId)))));

// ---------------------------------------------------------------------------
// The tyre register (stores plan, Part 4): every tyre by its serial number, like the batteries.
// ---------------------------------------------------------------------------
const TYRE_STATES = ['in_store', 'installed', 'removed', 'repair', 'retread', 'warranty', 'scrap', 'lost', 'disposed'];

router.get('/tyres', requireAuth, asyncHandler((req, res) => {
  const w = []; const p = [];
  if (TYRE_STATES.includes(req.query.state)) { w.push('t.state = ?'); p.push(req.query.state); }
  if (req.query.q) {
    const like = '%' + String(req.query.q).trim() + '%';
    w.push('(t.serial_no LIKE ? OR s.label LIKE ? OR a.code LIKE ? OR a.registration LIKE ?)'); p.push(like, like, like, like);
  }
  res.json(all(`SELECT t.id, t.serial_no, t.state, t.position, t.current_asset_id, t.store_id, t.warranty_date,
                       s.label AS spec, a.code AS asset_code, a.registration AS asset_reg,
                       (SELECT COUNT(*) FROM tyre_photos f WHERE f.tyre_id = t.id) AS photo_count
                  FROM tyres t LEFT JOIN tb_specs s ON s.id = t.spec_id LEFT JOIN assets a ON a.id = t.current_asset_id
                 ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY t.serial_no LIMIT ${Math.min(toInt(req.query.limit, 500), 2000)}`, ...p));
}));

router.get('/tyres/:id', requireAuth, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const tyre = get(`SELECT t.*, s.label AS spec, a.code AS asset_code, a.registration AS asset_reg
                      FROM tyres t LEFT JOIN tb_specs s ON s.id = t.spec_id LEFT JOIN assets a ON a.id = t.current_asset_id WHERE t.id = ?`, id);
  if (!tyre) return res.status(404).json({ error: 'No such tyre' });
  const events = all(`SELECT e.*, af.code AS from_asset_code, at2.code AS to_asset_code, u.username
                        FROM tyre_events e LEFT JOIN assets af ON af.id = e.from_asset_id LEFT JOIN assets at2 ON at2.id = e.to_asset_id
                        LEFT JOIN users u ON u.id = e.user_id WHERE e.tyre_id = ? ORDER BY e.id DESC`, id);
  res.json({ tyre, events, photos: unitPhotos.list('tyre', id), max_photos: unitPhotos.MAX_PHOTOS });
}));

router.post('/tyres/:id/photos', requireModule('tb_issue'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!units.byId('tyre', id)) return res.status(404).json({ error: 'No such tyre' });
  const photos = (Array.isArray(req.body.photos) ? req.body.photos : [req.body.photo]).filter(Boolean);
  if (!photos.length) return res.status(400).json({ error: 'No photo given' });
  const err = unitPhotos.add('tyre', id, photos, req.user.id, req.body.note);
  if (err) return res.status(err.status).json({ error: err.error });
  audit.record({ userId: req.user.id, entity: 'tyre', entityId: id, action: 'add_photos', after: { added: photos.length } });
  res.status(201).json(unitPhotos.list('tyre', id));
}));

router.delete('/tyres/:id/photos/:photoId', requireModule('tb_issue'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!unitPhotos.remove('tyre', id, toInt(req.params.photoId))) return res.status(404).json({ error: 'Photo not found' });
  audit.record({ userId: req.user.id, entity: 'tyre', entityId: id, action: 'delete_photo' });
  res.json(unitPhotos.list('tyre', id));
}));

// A tyre's own story after it was fitted: taken off (a rotation), fitted again, sent for repair or
// retreading, back in the store, claimed on warranty, or scrapped.
router.post('/tyres/:id/event', requireModule('tb_issue'), asyncHandler((req, res) => {
  const b = req.body || {};
  const tyre = units.byId('tyre', toInt(req.params.id));
  if (!tyre) return res.status(404).json({ error: 'No such tyre' });
  const type = String(b.event_type || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.event_date || '')) ? b.event_date : new Date().toISOString().slice(0, 10);
  const ctx = { userId: req.user.id, date, reason: clean(b.reason) };
  tx(() => {
    if (type === 'install') {
      const assetId = toInt(b.to_asset_id);
      if (!assetId || !get('SELECT id FROM assets WHERE id = ?', assetId)) fail(400, 'Which vehicle is it going on?');
      if (!['in_store', 'removed'].includes(tyre.state)) fail(409, `Tyre ${tyre.serial_no} is ${tyre.state}. Only a tyre in the store can be fitted.`);
      units.fit('tyre', { serial: tyre.serial_no, assetId, position: b.position, ...ctx, reason: ctx.reason || 'Fitted again' });
    } else if (type === 'remove') {
      units.takeOff('tyre', tyre, { assetId: tyre.current_asset_id, ...ctx });
    } else if (type === 'return') {
      if (units.FINISHED.includes(tyre.state)) fail(409, `Tyre ${tyre.serial_no} is ${tyre.state}.`);
      if (tyre.current_asset_id) units.takeOff('tyre', tyre, { assetId: tyre.current_asset_id, ...ctx });
      run("UPDATE tyres SET state = 'in_store' WHERE id = ?", tyre.id);
      units.event('tyre', tyre.id, { type: 'return', ...ctx });
    } else if (['repair', 'retread', 'warranty', 'scrap'].includes(type)) {
      if (units.FINISHED.includes(tyre.state)) fail(409, `Tyre ${tyre.serial_no} is ${tyre.state}.`);
      if (tyre.current_asset_id) units.takeOff('tyre', tyre, { assetId: tyre.current_asset_id, ...ctx });
      run('UPDATE tyres SET state = ? WHERE id = ?', type, tyre.id);
      units.event('tyre', tyre.id, { type, ...ctx });
    } else fail(400, 'Say what happened to the tyre.');
  });
  audit.record({ userId: req.user.id, entity: 'tyre', entityId: tyre.id, action: 'event', after: { event: type } });
  res.status(201).json(units.byId('tyre', tyre.id));
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
      WHERE i.source = 'request' AND i.kind IN ('tyre','battery')
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
