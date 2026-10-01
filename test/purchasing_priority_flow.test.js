'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-purchasing-flow-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const flow = require('../src/lib/purchasing_flow');

migrate();
permissions.seedDefaults();

function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)',
    username, auth.hashPassword('pw')).lastInsertRowid;
  for (const r of roles) {
    run('INSERT OR IGNORE INTO roles (name) VALUES (?)', r);
    run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  }
  return id;
}

mkUser('hq_buyer', ['purchase_head_office']);
mkUser('loc_buyer', ['purchase_local']);
mkUser('shop_sup', ['workshop']);
mkUser('op_mgr', ['manager']);
mkUser('str_clerk', ['stores']);
mkUser('unauth_user', ['driver']);

const ASSET = require('../src/lib/aliases').findOrCreateAsset('TR-900').id;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

// Create an approved MRN with multiple lines for priority and channel testing
const MRN = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status, approval_status, requested_by, required_date)
   VALUES ('M-8001', '2026-09-01', ?, 'open', 'approved', 'fitter_kamal', '2026-09-10')`, ASSET).lastInsertRowid;

const mkLine = (desc, qty, source, priority = 'P3_ROUTINE', note = null) => run(
  `INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received, purchase_source, buying_priority, priority_note)
   VALUES (?, ?, ?, 'nos', 0, ?, ?, ?)`,
  MRN, desc, qty, source, priority, note).lastInsertRowid;

const L1_ROUTINE = mkLine('Standard Oil Filter', 2, 'head_office', 'P3_ROUTINE', 'Scheduled service');
const L2_LOW = mkLine('Spare Cabin Mat', 1, 'local_purchase', 'P4_LOW', 'Buffer stock');
const L3_URGENT = mkLine('Brake Master Cylinder', 1, 'head_office', 'P2_URGENT', 'Brake pedal soft');
const L4_CRITICAL = mkLine('Alternator Assembly', 1, 'local_purchase', 'P1_CRITICAL', 'Vehicle breakdown on highway');
const L5_UNASSIGNED = mkLine('Fan Belt', 3, null, 'P3_ROUTINE', null);

const app = require('../src/server');
let server;
let base;
const cookies = {};

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['hq_buyer', 'loc_buyer', 'shop_sup', 'op_mgr', 'str_clerk', 'unauth_user']) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'pw' }),
    });
    cookies[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
});

test.after(() => server && server.close());

const api = async (who, p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', cookie: cookies[who] },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---------------------------------------------------------------------------
// 1. Day-to-Day Workshop Priority Adjustment
// ---------------------------------------------------------------------------

test('workshop supervisor can adjust buying priority and record daily operational note', async () => {
  const res = await api('shop_sup', `/purchasing/lines/${L1_ROUTINE}/priority`, {
    method: 'POST',
    body: {
      buying_priority: 'P1_CRITICAL',
      note: 'Driver reported oil leak on main shaft - urgent breakdown',
    },
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.buying_priority, 'P1_CRITICAL');

  const row = get('SELECT buying_priority, priority_note, priority_updated_by FROM mrn_lines WHERE id = ?', L1_ROUTINE);
  assert.strictEqual(row.buying_priority, 'P1_CRITICAL');
  assert.match(row.priority_note, /urgent breakdown/);
  assert.strictEqual(row.priority_updated_by, 'shop_sup');
});

test('priority change records chronological audit trail in mrn_line_priority_history', async () => {
  // Second change by manager
  await api('op_mgr', `/purchasing/lines/${L1_ROUTINE}/priority`, {
    method: 'POST',
    body: {
      buying_priority: 'P2_URGENT',
      note: 'Temporary seal fitted, downgraded from breakdown to urgent',
    },
  });

  const histRes = await api('shop_sup', `/purchasing/lines/${L1_ROUTINE}/priority-history`);
  assert.strictEqual(histRes.status, 200);
  assert.strictEqual(histRes.body.rows.length, 2);

  const [latest, initial] = histRes.body.rows;
  assert.strictEqual(latest.old_priority, 'P1_CRITICAL');
  assert.strictEqual(latest.new_priority, 'P2_URGENT');
  assert.strictEqual(latest.changed_by, 'op_mgr');
  assert.match(latest.note, /downgraded/);

  assert.strictEqual(initial.old_priority, 'P3_ROUTINE');
  assert.strictEqual(initial.new_priority, 'P1_CRITICAL');
  assert.strictEqual(initial.changed_by, 'shop_sup');
});

test('invalid priority code is rejected', async () => {
  const res = await api('shop_sup', `/purchasing/lines/${L1_ROUTINE}/priority`, {
    method: 'POST',
    body: { buying_priority: 'SUPER_URGENT' },
  });
  assert.strictEqual(res.status, 400);
});

test('user without purchasing or workshop capability cannot change priority', async () => {
  const res = await api('unauth_user', `/purchasing/lines/${L1_ROUTINE}/priority`, {
    method: 'POST',
    body: { buying_priority: 'P2_URGENT' },
  });
  assert.strictEqual(res.status, 403);
});

// ---------------------------------------------------------------------------
// 2. Priority Sorting in Queue
// ---------------------------------------------------------------------------

test('procurement queue sorts by workshop urgency priority first (P1 -> P2 -> P3 -> P4)', async () => {
  // L4_CRITICAL is P1_CRITICAL
  // L1_ROUTINE was updated to P2_URGENT
  // L3_URGENT is P2_URGENT
  // L2_LOW is P4_LOW
  const res = await api('op_mgr', '/purchasing/queue?tab=to_buy');
  assert.strictEqual(res.status, 200);

  const ids = res.body.rows.map((r) => r.id);
  const p1Index = ids.indexOf(L4_CRITICAL);
  const p2Index1 = ids.indexOf(L1_ROUTINE);
  const p2Index2 = ids.indexOf(L3_URGENT);
  const p4Index = ids.indexOf(L2_LOW);

  assert.ok(p1Index !== -1, 'P1 critical must be in queue');
  assert.ok(p1Index < p2Index1, 'P1 item must appear before P2 items');
  assert.ok(p1Index < p2Index2, 'P1 item must appear before P2 items');
  assert.ok(p2Index1 < p4Index, 'P2 item must appear before P4 item');
  assert.ok(p2Index2 < p4Index, 'P2 item must appear before P4 item');
});

// ---------------------------------------------------------------------------
// 3. Bilateral Channel Reassignment (Both HO & Local)
// ---------------------------------------------------------------------------

test('local officer can reassign head office item to local purchase with reason', async () => {
  // L3_URGENT is initially head_office
  const res = await api('loc_buyer', `/purchasing/lines/${L3_URGENT}/source`, {
    method: 'POST',
    body: {
      purchase_source: 'local_purchase',
      reason: 'Sourced immediately at Panchikawatta auto market',
    },
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.purchase_source, 'local_purchase');

  const row = get('SELECT purchase_source, source_changed_from, source_changed_by, source_changed_reason FROM mrn_lines WHERE id = ?', L3_URGENT);
  assert.strictEqual(row.purchase_source, 'local_purchase');
  assert.strictEqual(row.source_changed_from, 'head_office');
  assert.strictEqual(row.source_changed_by, 'loc_buyer');
  assert.match(row.source_changed_reason, /Panchikawatta/);
});

test('head office officer can reassign local purchase item to head office with reason', async () => {
  // L4_CRITICAL is initially local_purchase
  const res = await api('hq_buyer', `/purchasing/lines/${L4_CRITICAL}/source`, {
    method: 'POST',
    body: {
      purchase_source: 'head_office',
      reason: 'HQ contracted supplier offers 30% discount and express dispatch',
    },
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.purchase_source, 'head_office');

  const row = get('SELECT purchase_source, source_changed_from, source_changed_by, source_changed_reason FROM mrn_lines WHERE id = ?', L4_CRITICAL);
  assert.strictEqual(row.purchase_source, 'head_office');
  assert.strictEqual(row.source_changed_from, 'local_purchase');
  assert.strictEqual(row.source_changed_by, 'hq_buyer');
  assert.match(row.source_changed_reason, /contracted supplier/);
});

test('unassigned item can be claimed by either officer', async () => {
  const res = await api('loc_buyer', `/purchasing/lines/${L5_UNASSIGNED}/source`, {
    method: 'POST',
    body: {
      purchase_source: 'local_purchase',
      reason: 'Claimed by local team',
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.purchase_source, 'local_purchase');
});

// ---------------------------------------------------------------------------
// 4. Monitor Cockpit & Counts API
// ---------------------------------------------------------------------------

test('flow monitor returns accurate pipeline and urgency counts', async () => {
  const res = await api('op_mgr', '/purchasing/flow/monitor');
  assert.strictEqual(res.status, 200);

  const { pipeline, urgency, watch } = res.body;
  assert.ok(typeof pipeline.to_buy_total === 'number');
  assert.ok(typeof pipeline.to_buy_ho === 'number');
  assert.ok(typeof pipeline.to_buy_local === 'number');
  assert.strictEqual(pipeline.to_buy_total, pipeline.to_buy_ho + pipeline.to_buy_local);

  assert.ok(typeof urgency.p1_critical === 'number');
  assert.ok(typeof urgency.p2_urgent === 'number');
  assert.ok(typeof urgency.p3_routine === 'number');
  assert.ok(typeof urgency.p4_low === 'number');
  assert.strictEqual(urgency.urgent_total, urgency.p1_critical + urgency.p2_urgent);

  assert.ok(typeof watch.overdue_needed === 'number');
  assert.ok(typeof watch.unpriced === 'number');
});

// ---------------------------------------------------------------------------
// 5. Buying An Item Prevents Further Priority Modification
// ---------------------------------------------------------------------------

test('once bought, priority cannot be altered afterwards', async () => {
  // L4_CRITICAL was moved to head_office, buy it as hq_buyer
  const buyRes = await api('hq_buyer', `/purchasing/lines/${L4_CRITICAL}/purchase`, {
    method: 'POST',
    body: {
      supplier: 'Hayleys Auto',
      invoice_no: 'INV-HA-101',
      invoice_date: '2026-09-05',
      purchase_amount: 45000,
      images: [PNG],
    },
  });
  assert.strictEqual(buyRes.status, 200);

  // Attempt priority update should fail with 409 Conflict
  const prioRes = await api('shop_sup', `/purchasing/lines/${L4_CRITICAL}/priority`, {
    method: 'POST',
    body: { buying_priority: 'P4_LOW' },
  });
  assert.strictEqual(prioRes.status, 409);
  assert.match(prioRes.body.error, /already bought/i);
});
