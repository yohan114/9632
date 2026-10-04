'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const scope = require('../lib/scope');
const workshops = require('../lib/workshops');

const router = express.Router();
router.use(requireAuth);

// Improvement plan, Step 2: a tool is its workshop's (workshop_tools.workshop_id, src/db/index.js),
// and so are its issue log and its scrap requests. With the workshops kept apart, someone outside
// head office sees and works on their own workshop's tools only — store staff, those of every
// workshop their store serves, as with job cards (src/lib/scope.js).
const ownTools = (user, col = 't.workshop_id') => scope.filter(user, col);
/** Route guard: refuse a tool of another workshop, found from the :id the route takes. */
const reach = (toolOf) => (req, res, next) => {
  const toolId = toolOf(toInt(req.params.id));
  const no = toolId && scope.toolRefusal(req.user, toolId);
  return no ? res.status(403).json(no) : next();
};
const reachTool = reach((id) => id);
const reachLog = reach((id) => (get('SELECT tool_id FROM tool_issue_logs WHERE id = ?', id) || {}).tool_id);
const reachScrap = reach((id) => (get('SELECT tool_id FROM tool_scrap_requests WHERE id = ?', id) || {}).tool_id);
const forbid = (body) => { const e = new Error(body.error); e.status = 403; e.data = body; throw e; };
/** A mechanic named on a tool must be one of the workshops you may reach. */
function mustReachMechanic(user, mechanicId) {
  if (!mechanicId || !scope.enabled()) return;
  const w = workshops.mechanicWorkshop(mechanicId);
  if (w && !scope.mayReach(user, w)) forbid(scope.refusal('mechanic', w));
}

const clean = (v, max = 255) => (v == null ? '' : String(v).trim().slice(0, max));
const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const money = (v) => (v == null || v === '' ? '0.00' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Format sequence numbers
function nextSeq(prefix, table, col = 'log_no') {
  const year = new Date().getFullYear();
  const pattern = `${prefix}-${year}-%`;
  const row = get(`SELECT ${col} FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`, pattern);
  let seq = 1;
  if (row && row[col]) {
    const parts = row[col].split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) seq = lastNum + 1;
  }
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

// ---- TOOLS INVENTORY & CATALOGUE ------------------------------------------

// List tools with filters
router.get('/', asyncHandler((req, res) => {
  const type = clean(req.query.type); // 'common' | 'mechanic' | 'all'
  const category = clean(req.query.category);
  const status = clean(req.query.status);
  const condition = clean(req.query.condition);
  const mechanicId = toInt(req.query.mechanic_id);
  const workshopId = toInt(req.query.workshop_id);
  const q = clean(req.query.q).toLowerCase();
  const includeScrapped = req.query.include_scrapped === '1' || status === 'scrapped';

  const where = [];
  const params = [];

  if (!includeScrapped) {
    where.push('t.active = 1');
  }

  if (type && type !== 'all') {
    where.push('t.type = ?');
    params.push(type);
  }

  if (category) {
    where.push('t.category = ?');
    params.push(category);
  }

  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }

  if (condition) {
    where.push('t.condition = ?');
    params.push(condition);
  }

  if (mechanicId) {
    where.push('t.mechanic_id = ?');
    params.push(mechanicId);
  }

  if (workshopId) {
    where.push('t.workshop_id = ?');
    params.push(workshopId);
  }
  { const own = ownTools(req.user); if (own.sql) { where.push(own.sql); params.push(...own.params); } }

  if (q) {
    where.push(`(
      LOWER(t.tool_code) LIKE ? OR
      LOWER(t.name) LIKE ? OR
      LOWER(COALESCE(t.brand, '')) LIKE ? OR
      LOWER(COALESCE(t.model_no, '')) LIKE ? OR
      LOWER(COALESCE(t.serial_no, '')) LIKE ? OR
      LOWER(COALESCE(t.mechanic_name, '')) LIKE ? OR
      LOWER(COALESCE(t.toolbox_name, '')) LIKE ? OR
      LOWER(COALESCE(t.location, '')) LIKE ?
    )`);
    const lk = `%${q}%`;
    params.push(lk, lk, lk, lk, lk, lk, lk, lk);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const query = `
    SELECT t.*,
           (SELECT til.issued_to_name FROM tool_issue_logs til WHERE til.tool_id = t.id AND til.return_date IS NULL ORDER BY til.id DESC LIMIT 1) AS current_borrower,
           (SELECT til.issue_date FROM tool_issue_logs til WHERE til.tool_id = t.id AND til.return_date IS NULL ORDER BY til.id DESC LIMIT 1) AS borrowed_since,
           (SELECT til.id FROM tool_issue_logs til WHERE til.tool_id = t.id AND til.return_date IS NULL ORDER BY til.id DESC LIMIT 1) AS active_issue_id,
           (SELECT tsr.request_no FROM tool_scrap_requests tsr WHERE tsr.tool_id = t.id ORDER BY tsr.id DESC LIMIT 1) AS last_scrap_request_no
      FROM workshop_tools t
     ${whereSql}
     ORDER BY t.type ASC, t.name ASC, t.id ASC
  `;

  const tools = all(query, ...params);
  res.json({ tools, total: tools.length });
}));

// KPI stats
router.get('/stats', asyncHandler((req, res) => {
  const own = ownTools(req.user, 'workshop_id');
  const mine = own.sql ? ` AND ${own.sql}` : '';
  const n = (where) => get(`SELECT COUNT(*) AS c FROM workshop_tools WHERE (${where})${mine}`, ...own.params).c;
  const total = n('active = 1');
  const common = n("active = 1 AND type = 'common'");
  const mechanic = n("active = 1 AND type = 'mechanic'");
  const inStore = n("active = 1 AND status = 'in_store'");
  const issued = n("active = 1 AND (status = 'issued' OR status = 'in_use')");
  const damaged = n("active = 1 AND (status = 'damaged' OR condition IN ('damaged', 'broken'))");
  const pendingScrap = get(`SELECT COUNT(*) AS c FROM tool_scrap_requests WHERE status = 'pending_approval'
                              AND tool_id IN (SELECT id FROM workshop_tools WHERE 1 = 1${mine})`, ...own.params).c;
  const scrapped = n("status = 'scrapped' OR active = 0");
  const mechsWithTools = get(`SELECT COUNT(DISTINCT mechanic_id) AS c FROM workshop_tools WHERE active = 1 AND mechanic_id IS NOT NULL${mine}`, ...own.params).c;

  res.json({
    total_active: total,
    total_tools: total,
    common_tools: common,
    mechanic_tools: mechanic,
    in_store: inStore,
    in_use: issued,
    borrowed_now: issued,
    damaged,
    pending_scrap: pendingScrap,
    pending_scrap_count: pendingScrap,
    scrapped_total: scrapped,
    scrapped,
    mechanics_count: mechsWithTools,
    mechanics_with_boxes: mechsWithTools,
  });
}));

// List mechanics with personal toolbox counts & summary
router.get('/mechanic-boxes', asyncHandler((req, res) => {
  const ownT = ownTools(req.user);
  const ownM = ownTools(req.user, workshops.mechanicWorkshopSql('m'));
  const mechs = all(`
    SELECT m.id, m.name, m.status, m.active,
           COUNT(t.id) AS tool_count,
           COUNT(t.id) AS assigned_tools_count,
           SUM(CASE WHEN t.status IN ('in_store', 'in_use') AND t.condition NOT IN ('damaged', 'broken', 'scrapped') THEN 1 ELSE 0 END) AS good_tools_count,
           SUM(CASE WHEN t.status IN ('in_store', 'in_use') THEN 1 ELSE 0 END) AS active_tools,
           SUM(CASE WHEN t.status = 'damaged' OR t.condition IN ('damaged', 'broken') THEN 1 ELSE 0 END) AS damaged_tools,
           SUM(CASE WHEN t.status = 'damaged' OR t.condition IN ('damaged', 'broken') THEN 1 ELSE 0 END) AS damaged_tools_count,
           CASE WHEN COUNT(t.id) > 0 THEN COALESCE(MAX(t.toolbox_name), m.name || '''s Tool Box') ELSE NULL END AS toolbox_name,
           CASE WHEN COUNT(t.id) > 0 THEN 1 ELSE 0 END AS has_toolbox,
           CASE WHEN m.id IN (1, 11, 13, 17, 19) THEN 1 ELSE 0 END AS is_responsible_holder,
           SUM(t.replacement_cost) AS total_value,
           SUM(t.replacement_cost) AS total_box_value
      FROM mechanics m
      LEFT JOIN workshop_tools t ON t.mechanic_id = m.id AND t.active = 1${ownT.sql ? ` AND ${ownT.sql}` : ''}
     ${ownM.sql ? `WHERE ${ownM.sql}` : ''}
     GROUP BY m.id
     ORDER BY has_toolbox DESC, m.active DESC, tool_count DESC, m.name ASC
  `, ...ownT.params, ...ownM.params);
  res.json(mechs);
}));

// Tool detail
// Only a number is a tool: as `/:id` this route stood in front of /logs and /scrap-requests below
// and answered both with "Tool not found".
router.get('/:id(\\d+)', reachTool, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const tool = get('SELECT * FROM workshop_tools WHERE id = ?', id);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });

  const activeIssue = get('SELECT * FROM tool_issue_logs WHERE tool_id = ? AND return_date IS NULL ORDER BY id DESC LIMIT 1', id);
  const pastLogs = all('SELECT * FROM tool_issue_logs WHERE tool_id = ? ORDER BY id DESC LIMIT 20', id);
  const scrapRequests = all('SELECT * FROM tool_scrap_requests WHERE tool_id = ? ORDER BY id DESC', id);

  tool.current_borrower = activeIssue ? activeIssue.issued_to_name : null;
  tool.current_log_id = activeIssue ? activeIssue.id : null;
  tool.current_borrow_date = activeIssue ? activeIssue.issue_date : null;

  res.json({
    tool,
    active_issue: activeIssue || null,
    logs: pastLogs,
    scrap_requests: scrapRequests,
  });
}));

// Create new tool (common or assigned to mechanic toolbox)
router.post('/', requireCap('tools.manage', 'stores.items.edit'), asyncHandler((req, res) => {
  const b = req.body || {};
  require_(b, ['name']);

  const name = clean(b.name, 120);
  const category = clean(b.category, 40) || 'hand_tool';
  let type = clean(b.type, 20) || 'common';
  const mechanicId = toInt(b.mechanic_id);
  let mechanicName = null;
  let toolboxName = clean(b.toolbox_name, 100);
  mustReachMechanic(req.user, mechanicId);
  const workshopId = toInt(b.workshop_id) || (mechanicId && workshops.mechanicWorkshop(mechanicId)) || workshops.homeOf(req.user);
  if (scope.enabled() && !scope.mayReach(req.user, workshopId)) forbid(scope.refusal('workshop', workshopId));

  if (mechanicId) {
    type = 'mechanic';
    const m = get('SELECT name FROM mechanics WHERE id = ?', mechanicId);
    if (m) {
      mechanicName = m.name;
      if (!toolboxName) toolboxName = `${m.name}'s Service Tool Box`;
    }
  }

  // Generate tool code if omitted
  let toolCode = clean(b.tool_code, 30);
  if (!toolCode) {
    const prefix = type === 'mechanic' ? 'TL-MECH' : 'TL-COM';
    const last = get('SELECT id FROM workshop_tools WHERE type = ? ORDER BY id DESC LIMIT 1', type);
    const nextNum = (last ? last.id : 0) + 1;
    toolCode = `${prefix}-${String(nextNum).padStart(3, '0')}`;
  }

  const existing = get('SELECT id FROM workshop_tools WHERE tool_code = ?', toolCode);
  if (existing) return res.status(409).json({ error: `Tool code ${toolCode} is already registered` });

  const info = run(`
    INSERT INTO workshop_tools (
      tool_code, name, category, type, mechanic_id, mechanic_name, toolbox_name,
      location, brand, model_no, serial_no, specifications,
      workshop_id, store_id, purchase_date, purchase_cost, replacement_cost,
      condition, status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    toolCode, name, category, type, mechanicId || null, mechanicName, toolboxName || null,
    clean(b.location, 80) || (type === 'mechanic' ? `Mechanic Locker #${mechanicId || ''}` : 'Tool Crib'),
    clean(b.brand, 60) || null, clean(b.model_no, 60) || null, clean(b.serial_no, 60) || null, clean(b.specifications, 255) || null,
    workshopId, toInt(b.store_id) || null,
    clean(b.purchase_date, 10) || new Date().toISOString().slice(0, 10),
    toNum(b.purchase_cost, 0), toNum(b.replacement_cost, 0),
    clean(b.condition, 20) || 'good',
    type === 'mechanic' ? 'in_use' : 'in_store',
    clean(b.notes, 255) || null
  );

  audit.record({
    userId: req.user.id,
    entity: 'workshop_tools',
    entityId: info.lastInsertRowid,
    action: 'create',
    details: { toolCode, name, type, mechanicName }
  });

  res.status(201).json(get('SELECT * FROM workshop_tools WHERE id = ?', info.lastInsertRowid));
}));

// Update tool profile / location / assignment
router.patch('/:id', requireCap('tools.manage', 'stores.items.edit'), reachTool, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const tool = get('SELECT * FROM workshop_tools WHERE id = ?', id);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });

  const b = req.body || {};
  if (b.mechanic_id !== undefined) mustReachMechanic(req.user, toInt(b.mechanic_id));
  const updates = [];
  const params = [];

  if (b.name !== undefined) { updates.push('name = ?'); params.push(clean(b.name, 120)); }
  if (b.category !== undefined) { updates.push('category = ?'); params.push(clean(b.category, 40)); }
  if (b.location !== undefined) { updates.push('location = ?'); params.push(clean(b.location, 80)); }
  if (b.brand !== undefined) { updates.push('brand = ?'); params.push(clean(b.brand, 60)); }
  if (b.model_no !== undefined) { updates.push('model_no = ?'); params.push(clean(b.model_no, 60)); }
  if (b.serial_no !== undefined) { updates.push('serial_no = ?'); params.push(clean(b.serial_no, 60)); }
  if (b.specifications !== undefined) { updates.push('specifications = ?'); params.push(clean(b.specifications, 255)); }
  if (b.condition !== undefined) { updates.push('condition = ?'); params.push(clean(b.condition, 20)); }
  if (b.purchase_cost !== undefined) { updates.push('purchase_cost = ?'); params.push(toNum(b.purchase_cost, 0)); }
  if (b.replacement_cost !== undefined) { updates.push('replacement_cost = ?'); params.push(toNum(b.replacement_cost, 0)); }
  if (b.notes !== undefined) { updates.push('notes = ?'); params.push(clean(b.notes, 255)); }

  // Reassignment to mechanic or common store
  if (b.mechanic_id !== undefined) {
    const mId = toInt(b.mechanic_id);
    if (mId) {
      const m = get('SELECT name FROM mechanics WHERE id = ?', mId);
      updates.push('type = ?, mechanic_id = ?, mechanic_name = ?, toolbox_name = ?');
      params.push('mechanic', mId, m ? m.name : null, b.toolbox_name || (m ? `${m.name}'s Tool Box` : null));
    } else {
      updates.push('type = ?, mechanic_id = NULL, mechanic_name = NULL, toolbox_name = NULL');
      params.push('common');
    }
  }

  if (updates.length) {
    updates.push("updated_at = datetime('now')");
    params.push(id);
    run(`UPDATE workshop_tools SET ${updates.join(', ')} WHERE id = ?`, ...params);
  }

  audit.record({ userId: req.user.id, entity: 'workshop_tools', entityId: id, action: 'update', details: b });
  res.json(get('SELECT * FROM workshop_tools WHERE id = ?', id));
}));

// Delete tool (if no logs or scrap history)
router.delete('/:id', requireCap('tools.manage'), reachTool, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const tool = get('SELECT * FROM workshop_tools WHERE id = ?', id);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });

  const hasLogs = get('SELECT 1 FROM tool_issue_logs WHERE tool_id = ? LIMIT 1', id);
  const hasScrap = get('SELECT 1 FROM tool_scrap_requests WHERE tool_id = ? LIMIT 1', id);

  if (hasLogs || hasScrap) {
    // Soft-delete to preserve foreign-key audit integrity
    run('UPDATE workshop_tools SET active = 0 WHERE id = ?', id);
    audit.record({ userId: req.user.id, entity: 'workshop_tools', entityId: id, action: 'deactivate' });
    return res.json({ deleted: false, deactivated: true, message: 'Tool has history records; deactivated instead of purged' });
  }

  run('DELETE FROM workshop_tools WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'workshop_tools', entityId: id, action: 'delete' });
  res.json({ deleted: true });
}));

// ---- DAILY STORE ISSUE & RETURN LOG ---------------------------------------

// List daily logs
router.get('/logs', asyncHandler((req, res) => {
  const status = clean(req.query.status); // 'issued' | 'returned' | 'all'
  const date = clean(req.query.date);
  const mechanicId = toInt(req.query.mechanic_id);
  const q = clean(req.query.q).toLowerCase();

  const where = [];
  const params = [];

  if (status === 'issued') where.push('l.return_date IS NULL');
  else if (status === 'returned') where.push('l.return_date IS NOT NULL');

  if (date) {
    where.push('l.issue_date = ?');
    params.push(date);
  }

  if (mechanicId) {
    where.push('l.mechanic_id = ?');
    params.push(mechanicId);
  }

  if (q) {
    where.push(`(
      LOWER(l.log_no) LIKE ? OR
      LOWER(l.issued_to_name) LIKE ? OR
      LOWER(t.tool_code) LIKE ? OR
      LOWER(t.name) LIKE ? OR
      LOWER(COALESCE(l.job_no, '')) LIKE ?
    )`);
    const lk = `%${q}%`;
    params.push(lk, lk, lk, lk, lk);
  }
  { const own = ownTools(req.user); if (own.sql) { where.push(own.sql); params.push(...own.params); } }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = all(`
    SELECT l.*,
           t.tool_code, t.name AS tool_name, t.category AS tool_category, t.brand AS tool_brand, t.type AS tool_type
      FROM tool_issue_logs l
      JOIN workshop_tools t ON t.id = l.tool_id
     ${whereSql}
     ORDER BY l.id DESC
     LIMIT 200
  `, ...params);

  res.json(rows);
}));

// Issue a tool from stores (Check out)
router.post('/logs/issue', requireCap('tools.issue', 'stores.issue', 'tools.manage'), asyncHandler((req, res) => {
  const b = req.body || {};
  require_(b, ['tool_id', 'issued_to_name']);

  const toolId = toInt(b.tool_id);
  const tool = get('SELECT * FROM workshop_tools WHERE id = ?', toolId);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  { const no = scope.toolRefusal(req.user, toolId) || (toInt(b.job_id) && scope.jobRefusal(req.user, toInt(b.job_id))); if (no) return res.status(403).json(no); }
  if (!tool.active || tool.status === 'scrapped') return res.status(409).json({ error: 'Cannot issue a scrapped or inactive tool' });

  // Check if already borrowed
  const activeIssue = get('SELECT id, issued_to_name FROM tool_issue_logs WHERE tool_id = ? AND return_date IS NULL', toolId);
  if (activeIssue) {
    return res.status(409).json({ error: `Tool ${tool.tool_code} is already checked out to ${activeIssue.issued_to_name}` });
  }

  const logNo = nextSeq('TIL', 'tool_issue_logs', 'log_no');
  const now = new Date();
  const issueDate = clean(b.issue_date, 10) || now.toISOString().slice(0, 10);
  const issueTime = clean(b.issue_time, 8) || now.toTimeString().slice(0, 5);

  let jobNo = null;
  const jobId = toInt(b.job_id);
  if (jobId) {
    const j = get('SELECT job_no FROM job_cards WHERE id = ?', jobId);
    if (j) jobNo = j.job_no;
  }

  const info = run(`
    INSERT INTO tool_issue_logs (
      log_no, tool_id, mechanic_id, issued_to_name, job_id, job_no,
      issue_date, issue_time, condition_out, issued_by, issued_by_name,
      purpose, expected_return_date, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')
  `,
    logNo, toolId, toInt(b.mechanic_id) || null, clean(b.issued_to_name, 100),
    jobId || null, jobNo, issueDate, issueTime, clean(b.condition_out, 20) || 'good',
    req.user.id, req.user.username, clean(b.purpose, 255) || null,
    clean(b.expected_return_date, 10) || null
  );

  run("UPDATE workshop_tools SET status = 'issued' WHERE id = ?", toolId);

  audit.record({
    userId: req.user.id,
    entity: 'tool_issue_logs',
    entityId: info.lastInsertRowid,
    action: 'issue',
    details: { logNo, toolCode: tool.tool_code, issuedTo: b.issued_to_name }
  });

  res.status(201).json(get('SELECT * FROM tool_issue_logs WHERE id = ?', info.lastInsertRowid));
}));

// Return a borrowed tool to stores (Check in & inspect condition)
router.post('/logs/:id/return', requireCap('tools.issue', 'stores.issue', 'tools.manage'), reachLog, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const log = get('SELECT * FROM tool_issue_logs WHERE id = ?', id);
  if (!log) return res.status(404).json({ error: 'Issue log entry not found' });
  if (log.return_date) return res.status(409).json({ error: 'This tool has already been recorded as returned' });

  const b = req.body || {};
  const conditionIn = clean(b.condition_in, 20) || 'good';
  const returnNotes = clean(b.return_notes, 255) || null;
  const now = new Date();
  const returnDate = clean(b.return_date, 10) || now.toISOString().slice(0, 10);
  const returnTime = clean(b.return_time, 8) || now.toTimeString().slice(0, 5);

  const isDamaged = conditionIn === 'damaged' || conditionIn === 'broken';
  const logStatus = isDamaged ? 'damaged_on_return' : 'returned';

  run(`
    UPDATE tool_issue_logs
       SET return_date = ?,
           return_time = ?,
           condition_in = ?,
           received_by = ?,
           received_by_name = ?,
           return_notes = ?,
           status = ?
     WHERE id = ?
  `, returnDate, returnTime, conditionIn, req.user.id, req.user.username, returnNotes, logStatus, id);

  // Update tool state
  const tool = get('SELECT * FROM workshop_tools WHERE id = ?', log.tool_id);
  if (tool) {
    let nextStatus = 'in_store';
    if (isDamaged) {
      nextStatus = 'damaged';
    } else if (tool.type === 'mechanic') {
      nextStatus = 'in_use';
    }
    run('UPDATE workshop_tools SET status = ?, condition = ? WHERE id = ?', nextStatus, conditionIn, tool.id);
  }

  audit.record({
    userId: req.user.id,
    entity: 'tool_issue_logs',
    entityId: id,
    action: 'return',
    details: { conditionIn, isDamaged }
  });

  res.json(get('SELECT * FROM tool_issue_logs WHERE id = ?', id));
}));

// ---- BROKEN / DAMAGED TOOLS & ENGINEER SCRAP APPROVAL --------------------

// List scrap requests
router.get('/scrap-requests', asyncHandler((req, res) => {
  const status = clean(req.query.status);
  const q = clean(req.query.q).toLowerCase();

  const where = [];
  const params = [];

  if (status && status !== 'all') {
    where.push('sr.status = ?');
    params.push(status);
  }

  if (q) {
    where.push(`(
      LOWER(sr.request_no) LIKE ? OR
      LOWER(sr.tool_code) LIKE ? OR
      LOWER(sr.tool_name) LIKE ? OR
      LOWER(COALESCE(sr.mechanic_name, '')) LIKE ? OR
      LOWER(COALESCE(sr.damage_reason, '')) LIKE ?
    )`);
    const lk = `%${q}%`;
    params.push(lk, lk, lk, lk, lk);
  }
  { const own = ownTools(req.user); if (own.sql) { where.push(own.sql); params.push(...own.params); } }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = all(`
    SELECT sr.*,
           t.brand AS tool_brand, t.model_no AS tool_model, t.purchase_cost, t.replacement_cost, t.category
      FROM tool_scrap_requests sr
      JOIN workshop_tools t ON t.id = sr.tool_id
     ${whereSql}
     ORDER BY sr.id DESC
  `, ...params);

  res.json(rows);
}));

// Single scrap request details
router.get('/scrap-requests/:id', reachScrap, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const sr = get(`
    SELECT sr.*,
           t.brand AS tool_brand, t.model_no AS tool_model, t.serial_no AS tool_serial,
           t.specifications AS tool_specs, t.purchase_cost, t.replacement_cost, t.location, t.category
      FROM tool_scrap_requests sr
      JOIN workshop_tools t ON t.id = sr.tool_id
     WHERE sr.id = ?
  `, id);
  if (!sr) return res.status(404).json({ error: 'Scrap request not found' });
  res.json(sr);
}));

// Raise a broken/damaged tool scrap request
router.post('/scrap-requests', requireCap('tools.damage.report', 'stores.items.edit', 'dailywork.edit'), asyncHandler((req, res) => {
  const b = req.body || {};
  require_(b, ['tool_id', 'damage_reason']);

  const toolId = toInt(b.tool_id);
  const tool = get('SELECT * FROM workshop_tools WHERE id = ?', toolId);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  { const no = scope.toolRefusal(req.user, toolId); if (no) return res.status(403).json(no); }

  // Generate request number
  const requestNo = nextSeq('TSR', 'tool_scrap_requests', 'request_no');
  const damageDate = clean(b.damage_date, 10) || new Date().toISOString().slice(0, 10);
  const damageReason = clean(b.damage_reason, 255);
  const incidentDesc = clean(b.incident_description, 500) || null;
  const replacementReq = b.replacement_requested ? 1 : 0;

  const info = run(`
    INSERT INTO tool_scrap_requests (
      request_no, tool_id, tool_code, tool_name, type, mechanic_id, mechanic_name,
      damage_date, damage_reason, incident_description,
      reported_by, reported_by_name, status, replacement_requested
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)
  `,
    requestNo, toolId, tool.tool_code, tool.name, tool.type,
    tool.mechanic_id || null, tool.mechanic_name || null,
    damageDate, damageReason, incidentDesc,
    req.user.id, req.user.username, replacementReq
  );

  // Mark tool as damaged & pending scrap
  run("UPDATE workshop_tools SET status = 'pending_scrap', condition = 'damaged' WHERE id = ?", toolId);

  audit.record({
    userId: req.user.id,
    entity: 'tool_scrap_requests',
    entityId: info.lastInsertRowid,
    action: 'report_damage',
    details: { requestNo, toolCode: tool.tool_code, damageReason }
  });

  res.status(201).json(get('SELECT * FROM tool_scrap_requests WHERE id = ?', info.lastInsertRowid));
}));

// Engineer / Assistant Engineer Approval to remove tool to Scrap
router.post('/scrap-requests/:id/approve', requireCap('tools.scrap.approve'), reachScrap, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const sr = get('SELECT * FROM tool_scrap_requests WHERE id = ?', id);
  if (!sr) return res.status(404).json({ error: 'Scrap request not found' });
  if (sr.status === 'approved') return res.status(409).json({ error: 'This scrap request has already been approved' });

  const b = req.body || {};
  const decision = clean(b.decision) === 'send_for_repair' ? 'send_for_repair' : 'approved';
  const remarks = clean(b.remarks, 255) || (decision === 'send_for_repair' ? 'Assigned for workshop repair' : 'Approved for scrap disposal');
  const scrapBin = clean(b.scrap_bin_ref, 80) || 'Workshop Metal Scrap Bin';
  const signature = clean(b.signature, 50000) || null;
  const engineerName = req.user.fullName || req.user.full_name || req.user.username;

  // Determine engineer title
  const userRoles = req.user.roles || [];
  let roleTitle = 'Mechanical Engineer';
  if (userRoles.includes('assistant_engineer')) roleTitle = 'Assistant Engineer';
  else if (userRoles.includes('engineer')) roleTitle = 'Mechanical Engineer';
  else if (userRoles.includes('operational_manager')) roleTitle = 'Operational Manager';
  else if (userRoles.includes('manager')) roleTitle = 'Workshop Manager';
  else if (userRoles.includes('admin')) roleTitle = 'Chief Engineer / Administrator';

  tx(() => {
    if (decision === 'send_for_repair') {
      run(`
        UPDATE tool_scrap_requests
           SET status = 'under_repair',
               engineer_id = ?,
               engineer_name = ?,
               engineer_role = ?,
               engineer_decision = 'send_for_repair',
               engineer_remarks = ?,
               engineer_signature = ?,
               decided_at = datetime('now')
         WHERE id = ?
      `, req.user.id, engineerName, roleTitle, remarks, signature, id);

      run(`
        UPDATE workshop_tools
           SET status = 'damaged',
               condition = 'damaged',
               notes = COALESCE(notes || ' · ', '') || 'Sent for repair via ' || ? || ' on ' || date('now')
         WHERE id = ?
      `, sr.request_no, sr.tool_id);
    } else {
      run(`
        UPDATE tool_scrap_requests
           SET status = 'approved',
               engineer_id = ?,
               engineer_name = ?,
               engineer_role = ?,
               engineer_decision = 'approved',
               engineer_remarks = ?,
               engineer_signature = ?,
               decided_at = datetime('now'),
               scrap_date = date('now'),
               scrap_bin_ref = ?
         WHERE id = ?
      `, req.user.id, engineerName, roleTitle, remarks, signature, scrapBin, id);

      // Decommission the tool into scrap and mark inactive
      run(`
        UPDATE workshop_tools
           SET status = 'scrapped',
               condition = 'scrapped',
               active = 0,
               notes = COALESCE(notes || ' · ', '') || 'Scrapped via ' || ? || ' on ' || date('now')
         WHERE id = ?
      `, sr.request_no, sr.tool_id);
    }
  });

  audit.record({
    userId: req.user.id,
    entity: 'tool_scrap_requests',
    entityId: id,
    action: 'approve_scrap',
    details: { requestNo: sr.request_no, roleTitle, remarks }
  });

  res.json(get('SELECT * FROM tool_scrap_requests WHERE id = ?', id));
}));

// Engineer / Assistant Engineer Rejection or Send for Repair
router.post('/scrap-requests/:id/reject', requireCap('tools.scrap.approve'), reachScrap, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const sr = get('SELECT * FROM tool_scrap_requests WHERE id = ?', id);
  if (!sr) return res.status(404).json({ error: 'Scrap request not found' });

  const b = req.body || {};
  const decision = b.decision === 'repair' ? 'repair' : 'rejected';
  const remarks = clean(b.remarks, 255) || (decision === 'repair' ? 'Returned for workshop local repair' : 'Scrap request rejected by engineer');

  const userRoles = req.user.roles || [];
  let roleTitle = userRoles.includes('assistant_engineer') ? 'Assistant Engineer' : 'Mechanical Engineer';

  tx(() => {
    run(`
      UPDATE tool_scrap_requests
         SET status = ?,
             engineer_id = ?,
             engineer_name = ?,
             engineer_role = ?,
             engineer_decision = ?,
             engineer_remarks = ?,
             decided_at = datetime('now')
       WHERE id = ?
    `, decision === 'repair' ? 'under_repair' : 'rejected', req.user.id, req.user.username, roleTitle, decision, remarks, id);

    // Update tool status accordingly
    const nextStatus = decision === 'repair' ? 'under_repair' : (sr.type === 'mechanic' ? 'in_use' : 'in_store');
    const nextCondition = decision === 'repair' ? 'damaged' : 'fair';
    run('UPDATE workshop_tools SET status = ?, condition = ? WHERE id = ?', nextStatus, nextCondition, sr.tool_id);
  });

  audit.record({
    userId: req.user.id,
    entity: 'tool_scrap_requests',
    entityId: id,
    action: 'reject_scrap',
    details: { decision, remarks }
  });

  res.json(get('SELECT * FROM tool_scrap_requests WHERE id = ?', id));
}));

// ---- OFFICIAL TOOL SCRAP CERTIFICATE (EC1.ST.FO.06) -----------------------

router.get('/scrap-requests/:id/print.html', reachScrap, asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const sr = get(`
    SELECT sr.*,
           t.brand AS tool_brand, t.model_no AS tool_model, t.serial_no AS tool_serial,
           t.specifications AS tool_specs, t.purchase_cost, t.replacement_cost, t.location, t.category
      FROM tool_scrap_requests sr
      JOIN workshop_tools t ON t.id = sr.tool_id
     WHERE sr.id = ?
  `, id);
  if (!sr) return res.status(404).send('Scrap request not found');

  const html = renderScrapCertificateHtml(sr, false);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

router.get('/scrap-requests/:id/download.pdf', reachScrap, asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const sr = get(`
    SELECT sr.*,
           t.brand AS tool_brand, t.model_no AS tool_model, t.serial_no AS tool_serial,
           t.specifications AS tool_specs, t.purchase_cost, t.replacement_cost, t.location, t.category
      FROM tool_scrap_requests sr
      JOIN workshop_tools t ON t.id = sr.tool_id
     WHERE sr.id = ?
  `, id);
  if (!sr) return res.status(404).json({ error: 'Scrap request not found' });

  try {
    const { htmlToPdfBuffer } = require('../lib/pdf_generator');
    const html = renderScrapCertificateHtml(sr, true);
    const pdfBuf = await htmlToPdfBuffer(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sr.request_no}_Scrap_Certificate.pdf"`);
    res.send(pdfBuf);
  } catch (err) {
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
}));

function renderScrapCertificateHtml(sr, forPdf = false) {
  const isApproved = sr.status === 'approved';
  const statusBadge = isApproved
    ? '<span style="color:#16a34a;font-weight:bold;border:1.5px solid #16a34a;padding:2px 8px;border-radius:3px">APPROVED FOR SCRAP</span>'
    : `<span style="color:#d97706;font-weight:bold;border:1.5px solid #d97706;padding:2px 8px;border-radius:3px">${esc(sr.status.toUpperCase())}</span>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Tool Condemnation &amp; Scrap Note — ${esc(sr.request_no)}</title>
  <style>
    @page { size: A4 portrait; margin: 10mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; color: #000; margin: 0; padding: 0; font-size: 11px; background: #fff; }
    .sheet { border: 1.5px solid #000; width: 100%; margin: 0 auto; background: #fff; }
    .hd { display: flex; align-items: stretch; border-bottom: 1.5px solid #000; min-height: 40px; }
    .hd .co { flex: 1.3; padding: 8px 12px; font-weight: bold; font-size: 16px; border-right: 1.5px solid #000; display:flex; align-items:center; }
    .hd .ti { flex: 1.2; padding: 8px 12px; font-weight: bold; font-size: 15px; display:flex; align-items:center; justify-content:center; text-align: center; }
    .addr-sub { border-bottom: 1.5px solid #000; padding: 3px 12px; font-size: 10px; text-align: center; font-weight: 500; }
    .meta-grid { display: grid; grid-template-columns: 1.2fr 1fr; border-bottom: 1.5px solid #000; font-size: 11.5px; }
    .meta-cell { padding: 5px 10px; border-bottom: 1px solid #ccc; display: flex; align-items: center; }
    .meta-cell:last-child { border-bottom: none; }
    .meta-cell .k { font-weight: bold; min-width: 140px; }
    .meta-cell .v { flex: 1; border-bottom: 1px dotted #888; min-height: 16px; padding-left: 4px; }
    .meta-cell .stamp-no { font-family: "Courier New", Courier, monospace; font-size: 16px; font-weight: 900; color: #b30000; }
    table.data-table { width: 100%; border-collapse: collapse; margin-top: 0; }
    table.data-table th, table.data-table td { border: 1px solid #000; padding: 5px 8px; vertical-align: top; }
    table.data-table th { background: #f2f2f2; font-size: 11px; text-align: left; font-weight: bold; }
    .sig-table { width: 100%; border-collapse: collapse; border-top: 1.5px solid #000; }
    .sig-table th, .sig-table td { border: 1px solid #000; padding: 5px 8px; font-size: 11px; }
    .sig-table th { background: #fafafa; font-weight: bold; text-align: center; padding: 6px; }
    .sig-img { max-height: 36px; max-width: 140px; display: block; margin: 4px auto 0; }
    .foot { display: flex; justify-content: space-between; padding: 4px 10px; border-top: 1.5px solid #000; font-size: 9.5px; color: #333; font-weight: bold; }
    .toolbar { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 10px; }
    .toolbar button, .toolbar a { padding: 6px 14px; font-size: 13px; font-weight: bold; cursor: pointer; text-decoration: none; border: 1px solid #000; background: #f0f0f0; color: #000; border-radius: 4px; }
    .toolbar button.primary, .toolbar a.primary { background: #0056b3; color: #fff; border-color: #004085; }
    @media print {
      .noprint { display: none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  ${forPdf ? '' : `
  <div class="toolbar noprint">
    <button onclick="window.print()">🖨 Print Certificate</button>
    <a class="primary" href="/api/tools/scrap-requests/${sr.id}/download.pdf" download>⬇ Download PDF</a>
  </div>`}
  <div class="sheet">
    <div class="hd">
      <div class="co">EASTERN CONCRETE (PVT) LTD.</div>
      <div class="ti">TOOL CONDEMNATION &amp; SCRAP NOTE</div>
    </div>
    <div class="addr-sub">Central Workshop · Badalgama &amp; Sites · Heavy Machinery &amp; Vehicle Division</div>

    <div class="meta-grid">
      <div>
        <div class="meta-cell"><span class="k">Note No.:</span><span class="v"><b class="stamp-no">${esc(sr.request_no)}</b></span></div>
        <div class="meta-cell"><span class="k">Tool Ownership:</span><span class="v"><b>${sr.type === 'mechanic' ? 'Mechanic Personal Tool Box' : 'Common Workshop Store Tool'}</b></span></div>
        <div class="meta-cell"><span class="k">Assigned Mechanic / User:</span><span class="v"><b>${esc(sr.mechanic_name || 'Workshop Shared')}</b></span></div>
        <div class="meta-cell"><span class="k">Location / Tool Crib:</span><span class="v">${esc(sr.location || 'Central Workshop')}</span></div>
      </div>
      <div>
        <div class="meta-cell"><span class="k">Reported Date:</span><span class="v"><b>${esc(sr.damage_date)}</b></span></div>
        <div class="meta-cell"><span class="k">Authorization Status:</span><span class="v">${statusBadge}</span></div>
        <div class="meta-cell"><span class="k">Disposal Bin Ref:</span><span class="v"><b>${esc(sr.scrap_bin_ref || 'Scrap Yard Yard Bin A')}</b></span></div>
        <div class="meta-cell"><span class="k">Doc. Reference:</span><span class="v"><b>EC1.ST.FO.06</b></span></div>
      </div>
    </div>

    <div style="padding:8px 12px;background:#fafafa;border-bottom:1.5px solid #000">
      <h4 style="margin:0 0 6px">1. Equipment &amp; Tool Identification</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:110px">Tool Code</th>
            <th>Description &amp; Specifications</th>
            <th style="width:120px">Brand / Model</th>
            <th style="width:100px">Serial No.</th>
            <th style="width:110px;text-align:right">Estimated Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>${esc(sr.tool_code)}</b></td>
            <td><b>${esc(sr.tool_name)}</b><br><span style="color:#555;font-size:10px">${esc(sr.tool_specs || 'Standard workshop specification')}</span></td>
            <td>${esc(sr.tool_brand || '—')} ${esc(sr.tool_model ? '· ' + sr.tool_model : '')}</td>
            <td>${esc(sr.tool_serial || '—')}</td>
            <td style="text-align:right"><b>Rs ${money(sr.replacement_cost || sr.purchase_cost || 0)}</b></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div style="padding:8px 12px;border-bottom:1.5px solid #000">
      <h4 style="margin:0 0 4px">2. Damage Description &amp; Technical Failure Root Cause</h4>
      <p style="margin:4px 0;font-size:12px"><b>Failure Reason:</b> ${esc(sr.damage_reason)}</p>
      ${sr.incident_description ? `<p style="margin:4px 0;font-size:11.5px;color:#444"><b>Incident / Operation Context:</b> ${esc(sr.incident_description)}</p>` : ''}
      <div style="margin-top:6px;font-size:11px;color:#666">Reported by: <b>${esc(sr.reported_by_name || 'Storekeeper')}</b> on ${esc(String(sr.reported_at || '').slice(0, 16))}</div>
    </div>

    <div style="padding:8px 12px;background:#f9fafb;border-bottom:1.5px solid #000">
      <h4 style="margin:0 0 4px">3. Engineering Inspection &amp; Condemnation Assessment</h4>
      <p style="margin:4px 0;font-size:12px"><b>Assessment / Remarks:</b> ${esc(sr.engineer_remarks || 'Inspected by engineering division. Found beyond economical repair. Tool authorized for metal scrap disposal.')}</p>
      <p style="margin:4px 0;font-size:11px"><b>Replacement Recommendation:</b> ${sr.replacement_requested ? '✓ Replacement tool to be requisitioned through Stores (MRN)' : 'No immediate replacement requisition required'}</p>
    </div>

    <table class="sig-table">
      <thead>
        <tr>
          <th style="width:33%">1 · Reported By (Store / Workshop)</th>
          <th style="width:34%">2 · Inspected &amp; Approved By (Engineer)</th>
          <th style="width:33%">3 · Decommissioned &amp; Binned (Stores)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="height:70px;vertical-align:bottom">
            <div style="border-top:1px dotted #888;padding-top:4px">
              <b>${esc(sr.reported_by_name || 'Storekeeper')}</b><br>
              <span style="font-size:10px;color:#555">Workshop Storekeeper / Supervisor</span><br>
              <span style="font-size:10px;color:#555">Date: ${esc(sr.damage_date)}</span>
            </div>
          </td>
          <td style="height:70px;vertical-align:bottom">
            ${sr.engineer_signature ? `<img class="sig-img" src="${sr.engineer_signature}">` : ''}
            <div style="border-top:1px dotted #888;padding-top:4px">
              <b>${esc(sr.engineer_name || 'Pending Approval')}</b><br>
              <span style="font-size:10px;color:#555"><b>${esc(sr.engineer_role || 'Mechanical Engineer / Asst. Engineer')}</b></span><br>
              <span style="font-size:10px;color:#555">Date: ${esc(String(sr.decided_at || '').slice(0, 10) || 'Pending')}</span>
            </div>
          </td>
          <td style="height:70px;vertical-align:bottom">
            <div style="border-top:1px dotted #888;padding-top:4px">
              <b>${esc(sr.status === 'approved' ? 'Stores Custodian' : 'Pending')}</b><br>
              <span style="font-size:10px;color:#555">Scrap Disposal Confirmation</span><br>
              <span style="font-size:10px;color:#555">Bin: ${esc(sr.scrap_bin_ref || 'Scrap Yard')}</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="foot">
      <span>EC1.ST.FO.06 — Tool Condemnation &amp; Scrap Certificate</span>
      <span>Original: Stores File · Copy 1: Mechanical Engineering · Copy 2: Accounts / Audit</span>
      <span>Page 1 of 1</span>
    </div>
  </div>
</body>
</html>`;
}

module.exports = router;
