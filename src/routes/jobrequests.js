'use strict';

// Job Request (Transport) — a formal 3-stage e-signed request that a job be done
// on a vehicle/machine. Assistant Transport Manager raises it → Transport Manager
// certifies → Operational Manager approves. On final approval a Job Card is created
// (already past both approval gates) and linked back to the request.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireRole, hasRole } = require('../lib/auth');
const { asyncHandler, require_, toInt } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const costing = require('../lib/costing');
const jobstate = require('../lib/jobstate');

const router = express.Router();

// One generator, shared with routes/jobcards.js. This file used to carry its own copy — identical,
// separately maintained, and therefore free to drift: a card raised from a job request would have
// numbered itself by whichever copy had been changed last.
const jobNo = (type) => require('../lib/jobno').nextJobNo(type);

// Next request number — continues from the last JR-#### (editable in the form).
function nextJrNo() {
  let max = 0;
  for (const r of all("SELECT jr_no FROM job_requests WHERE jr_no LIKE 'JR-%'")) {
    const m = String(r.jr_no).match(/(\d+)\s*$/);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return 'JR-' + String(max + 1).padStart(4, '0');
}

const signer = (userId) => { const u = get('SELECT full_name, username, signature FROM users WHERE id = ?', userId); return { name: u ? (u.full_name || u.username) : 'user', sig: u ? u.signature : null }; };

const TYPES = ['repair', 'service'];
const SEVERITIES = ['major', 'minor'];
const PRIORITIES = ['normal', 'urgent'];

// ---- next number ----------------------------------------------------------
router.get('/numbers', asyncHandler((_req, res) => res.json({ next_jr: nextJrNo() })));

// ---- list -----------------------------------------------------------------
router.get('/', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.q) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(r.jr_no LIKE ? OR r.description LIKE ? OR a.code LIKE ? OR a.registration LIKE ? OR a.ec_code LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT r.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            p.name AS project_name, j.job_no AS job_no
       FROM job_requests r
       LEFT JOIN assets a ON a.id = r.asset_id
       LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN job_cards j ON j.id = r.job_id
       ${where} ORDER BY r.id DESC LIMIT ${toInt(req.query.limit, 300)}`,
    ...params
  ));
}));

// ---- detail ---------------------------------------------------------------
router.get('/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const jr = get(
    `SELECT r.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            p.name AS project_name, j.job_no AS job_no, j.status AS job_status
       FROM job_requests r
       LEFT JOIN assets a ON a.id = r.asset_id
       LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN job_cards j ON j.id = r.job_id
      WHERE r.id = ?`, id);
  if (!jr) return res.status(404).json({ error: 'Job request not found' });
  res.json({
    request: jr,
    approvals: all('SELECT a.*, u.username FROM job_request_approvals a LEFT JOIN users u ON u.id = a.approver_id WHERE a.job_request_id = ? ORDER BY a.id', id),
  });
}));

// ---- create (Assistant Transport Manager) ---------------------------------
router.post('/', requireRole('assistant_transport_manager'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['description']);
  const type = TYPES.includes(b.type) ? b.type : 'repair';
  const severity = SEVERITIES.includes(b.severity) ? b.severity : null;
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';

  // Resolve the vehicle/machine through the master resolver.
  let assetId = toInt(b.asset_id);
  let unresolved = null;
  if (!assetId && b.asset) {
    const r = aliases.resolveAsset(b.asset, { source: 'job_request' });
    assetId = r.assetId;
    if (!r.resolved) unresolved = { aliasId: r.aliasId, raw: b.asset };
  }
  const jrNo = String(b.jr_no || '').trim() || nextJrNo();
  if (get('SELECT id FROM job_requests WHERE jr_no = ?', jrNo)) {
    return res.status(409).json({ error: `Job request number ${jrNo} already exists` });
  }
  const ru = get('SELECT full_name, username, signature FROM users WHERE id = ?', req.user.id);
  const reqBy = String(b.requested_by || '').trim() || (ru ? (ru.full_name || ru.username) : null);
  const result = run(
    `INSERT INTO job_requests (jr_no, req_date, asset_id, project_id, type, severity, priority, description,
                               required_date, requested_by, requested_by_user, requested_sig)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    jrNo, b.req_date || new Date().toISOString().slice(0, 10), assetId || null, toInt(b.project_id),
    type, severity, priority, b.description, b.required_date || null, reqBy, req.user.id, ru ? ru.signature : null
  );
  audit.record({ userId: req.user.id, entity: 'job_request', entityId: result.lastInsertRowid, action: 'create', after: { jr_no: jrNo } });
  // Raising a request is never blocked — transport must always be able to log a fault.
  // The one-open-card rule bites at approval, so flag it here as a heads-up instead.
  res.status(201).json({
    request: get('SELECT * FROM job_requests WHERE id = ?', result.lastInsertRowid),
    unresolved,
    open_job: jobstate.openJobFor(assetId),
  });
}));

// ---- certify (Transport Manager) ------------------------------------------
router.post('/:id/certify', requireRole('transport_manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const jr = get('SELECT * FROM job_requests WHERE id = ?', id);
  if (!jr) return res.status(404).json({ error: 'Job request not found' });
  if (jr.approval_status === 'approved') return res.status(409).json({ error: 'Already approved — cannot re-certify' });
  if (jr.approval_status === 'rejected') return res.status(409).json({ error: 'This request was rejected' });
  const s = signer(req.user.id); const sig = req.body.signature || s.sig || null;
  tx(() => {
    run(`UPDATE job_requests SET approval_status = 'certified', certified_by = ?, certified_at = datetime('now'), certified_sig = ? WHERE id = ?`, s.name, sig, id);
    run(`INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, 'certify', 'transport_manager', ?, ?, ?, 'approved', ?)`, id, req.user.id, s.name, sig, req.body.reason || null);
  });
  audit.record({ userId: req.user.id, entity: 'job_request', entityId: id, action: 'certify', after: { certified_by: s.name }, reason: req.body.reason });
  res.json(get('SELECT * FROM job_requests WHERE id = ?', id));
}));

// ---- approve (Operational Manager) → creates the job card ------------------
router.post('/:id/approve', requireRole('operational_manager', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const jr = get('SELECT * FROM job_requests WHERE id = ?', id);
  if (!jr) return res.status(404).json({ error: 'Job request not found' });
  if (jr.approval_status === 'rejected') return res.status(409).json({ error: 'This request was rejected' });
  if (jr.approval_status !== 'certified') return res.status(409).json({ error: 'Request must be certified (Transport Manager) before Operational Manager approval' });
  // Approval is what creates the job card — so the one-open-card-per-vehicle rule
  // applies here too. Checked BEFORE anything is written, so a blocked approval
  // leaves the request exactly as it was.
  const guard = jobstate.checkOneOpenJob(jr.asset_id);
  if (!guard.ok) {
    return res.status(409).json({
      error: `${guard.blocking.job_no} (${guard.blocking.status}) is still open for this vehicle — close it, or add this work to that card.`,
      blocking_job: guard.blocking,
    });
  }
  const s = signer(req.user.id); const sig = req.body.signature || s.sig || null;
  const out = tx(() => {
    // Create the job card — already past both approval gates (this request WAS the approval).
    const no = jobNo(jr.type);
    const info = run(
      `INSERT INTO job_cards (job_no, asset_id, project_id, type, severity, description, status,
                              requested_by, requested_by_user, requested_at, approved_transport_at, approved_ops_at)
       VALUES (?, ?, ?, ?, ?, ?, 'APPROVED_OPERATIONS', ?, ?, ?, datetime('now'), datetime('now'))`,
      no, jr.asset_id, jr.project_id, jr.type, jr.severity, jr.description,
      jr.requested_by, jr.requested_by_user, jr.req_date || new Date().toISOString().slice(0, 10)
    );
    const jobId = info.lastInsertRowid;
    // Mirror the two approvals onto the job card's own audit trail.
    const certRow = get(`SELECT approver_id FROM job_request_approvals WHERE job_request_id = ? AND stage = 'certify' AND decision = 'approved' ORDER BY id DESC LIMIT 1`, id);
    run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, 'transport_manager', ?, 'approved', ?)`,
      jobId, certRow ? certRow.approver_id : null, `Certified via Job Request ${jr.jr_no}${jr.certified_by ? ' by ' + jr.certified_by : ''}`);
    run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason) VALUES (?, 'operational_manager', ?, 'approved', ?)`,
      jobId, req.user.id, `Approved via Job Request ${jr.jr_no}`);
    run(`UPDATE job_requests SET approval_status = 'approved', approved_by = ?, approved_at = datetime('now'), approved_sig = ?, job_id = ? WHERE id = ?`, s.name, sig, jobId, id);
    run(`INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, 'approve', 'operational_manager', ?, ?, ?, 'approved', ?)`, id, req.user.id, s.name, sig, req.body.reason || null);
    return jobId;
  });
  costing.refreshJobTotals(out);
  audit.record({ userId: req.user.id, entity: 'job_request', entityId: id, action: 'approve', after: { approved_by: s.name, job_id: out }, reason: req.body.reason });
  res.json({ request: get('SELECT * FROM job_requests WHERE id = ?', id), job: get('SELECT id, job_no FROM job_cards WHERE id = ?', out) });
}));

// ---- reject (Transport Manager or Operational Manager) --------------------
router.post('/:id/reject', requireRole('transport_manager', 'operational_manager', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const jr = get('SELECT * FROM job_requests WHERE id = ?', id);
  if (!jr) return res.status(404).json({ error: 'Job request not found' });
  if (jr.approval_status === 'approved') return res.status(409).json({ error: 'Already approved — cannot reject' });
  if (!String(req.body.reason || '').trim()) return res.status(400).json({ error: 'A reason is required to reject' });
  const s = signer(req.user.id);
  const asApprover = hasRole(req.user, 'operational_manager') || hasRole(req.user, 'manager');
  const stage = asApprover ? 'approve' : 'certify';
  tx(() => {
    run(`UPDATE job_requests SET approval_status = 'rejected' WHERE id = ?`, id);
    run(`INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?)`,
      id, stage, asApprover ? 'operational_manager' : 'transport_manager', req.user.id, s.name, req.body.signature || s.sig || null, req.body.reason);
  });
  audit.record({ userId: req.user.id, entity: 'job_request', entityId: id, action: 'reject', after: { by: s.name }, reason: req.body.reason });
  res.json(get('SELECT * FROM job_requests WHERE id = ?', id));
}));

// ---- printable Job Request form (with e-signature blocks) -----------------
router.get('/:id/print.html', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const jr = get(
    `SELECT r.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, p.name AS project_name, j.job_no AS job_no
       FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN job_cards j ON j.id = r.job_id WHERE r.id = ?`, id);
  if (!jr) return res.status(404).send('Job request not found');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  // Vehicle number first, then E&C number (matches the on-screen convention).
  const veh = [jr.asset_reg, (jr.asset_ec && jr.asset_ec !== jr.asset_reg) ? jr.asset_ec : ''].filter(Boolean).join(' · ') || jr.asset_code || '';
  // Only render a signature image when it is a genuine base64 image data-URL (prevents an
  // attribute-breakout XSS from an arbitrary stored signature string).
  const sigSrc = (v) => (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(String(v || '')) ? String(v) : '');
  const sigBlock = (title, name, dateVal, designation, sigImg, isLast) => {
    const safe = sigSrc(sigImg);
    return `
    <div class="${isLast ? '' : 'l'}"><b>${title}</b>
      ${safe ? `<div style="height:36px;margin:2px 0"><img src="${safe}" style="max-height:36px;max-width:160px"></div>`
        : '<div class="sig-line" style="margin-top:22px">Signature</div>'}
      <div class="rowline"><span class="k">Name:</span> ${name ? esc(name) + (safe ? '' : ' <span style="color:#0a7a0a;font-size:9px">&#10003; e-signed</span>') : ''}</div>
      <div class="rowline"><span class="k">Designation:</span> ${esc(designation)}</div>
      <div class="rowline"><span class="k">Date:</span> ${dateVal ? esc(d(dateVal)) : ''}</div></div>`;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Job Request ${esc(jr.jr_no)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: Arial, sans-serif; color: #000; margin: 0; font-size: 12px; }
  .sheet { border: 1.5px solid #000; }
  .hd { display: flex; align-items: stretch; border-bottom: 1.5px solid #000; }
  .hd .co { flex: 1; padding: 6px 10px; font-weight: bold; font-size: 15px; border-right: 1.5px solid #000; display:flex; align-items:center; }
  .hd .ti { width: 210px; padding: 6px 10px; font-weight: bold; font-size: 15px; display:flex; align-items:center; justify-content:center; }
  .meta { display: grid; grid-template-columns: 1fr 1fr 1fr; border-bottom: 1.5px solid #000; }
  .meta div { padding: 4px 10px; border-right: 1px solid #000; }
  .meta div:last-child { border-right: none; }
  .meta b { display:inline-block; min-width: 74px; }
  .desc { padding: 8px 10px; border-bottom: 1.5px solid #000; min-height: 90px; }
  .desc .k { font-weight: bold; display:block; margin-bottom: 4px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr 1fr; }
  .sign > div { padding: 8px 10px; }
  .sign .l { border-right: 1.5px solid #000; }
  .sig-line { margin-top: 26px; border-top: 1px solid #000; padding-top: 2px; font-size: 11px; }
  .foot { display:flex; justify-content: space-between; padding: 4px 10px; border-top: 1.5px solid #000; font-size: 10px; color:#222; }
  .rowline { display:flex; gap:6px; margin: 6px 0; font-size: 11px; } .rowline .k { min-width: 78px; }
  button { padding: 8px 14px; font-size: 14px; margin: 10px; cursor: pointer; }
  @media print { .noprint { display: none; } }
</style></head>
<body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<div class="sheet">
  <div class="hd"><div class="co">Edward and Christie (Pvt) Ltd</div><div class="ti">Job Request</div></div>
  <div class="meta">
    <div><b>JR No.:</b> ${esc(jr.jr_no)}</div>
    <div><b>Date:</b> ${esc(d(jr.req_date))}</div>
    <div><b>Type:</b> ${esc((jr.type || '').toUpperCase())}${jr.severity ? ' / ' + esc(jr.severity) : ''}</div>
    <div><b>Vehicle:</b> ${esc(veh)}</div>
    <div><b>Project:</b> ${esc(jr.project_name || '')}</div>
    <div><b>Required Date:</b> ${esc(d(jr.required_date))}</div>
    <div><b>Priority:</b> ${esc(jr.priority || 'normal')}</div>
    <div><b>Job Card:</b> ${esc(jr.job_no || '(created on approval)')}</div>
    <div><b>Requested by:</b> ${esc(jr.requested_by || '')}</div>
  </div>
  <div class="desc"><span class="k">Work requested</span>${esc(jr.description || '')}</div>
  <div class="sign">
    ${sigBlock('Requested By', jr.requested_by, jr.req_date, 'Assistant Transport Manager', jr.requested_sig, false)}
    ${sigBlock('Certified By', jr.certified_by, jr.certified_at, 'Transport Manager', jr.certified_sig, false)}
    ${sigBlock('Approved By', jr.approved_by, jr.approved_at, 'Operational Manager', jr.approved_sig, true)}
  </div>
  <div class="foot"><span>Doc. No.: EC1.TR.FO.01</span><span>WorkshopOne — Job Request</span></div>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

module.exports = router;
