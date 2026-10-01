'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-'));
const TEST_DB = path.join(TMP, 'test_tools.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

// Roles
const rolesToCreate = [
  ['admin', 'Administrator'],
  ['storekeeper', 'Storekeeper'],
  ['engineer', 'Mechanical / Workshop Engineer'],
  ['assistant_engineer', 'Assistant Engineer'],
  ['mechanic_user', 'Workshop Mechanic'],
];

for (const [r, l] of rolesToCreate) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', r, l);
}

// Users
function createUser(username, roleName, fullName) {
  const uid = run(
    'INSERT INTO users (username, full_name, password_hash, active) VALUES (?, ?, ?, 1)',
    username, fullName, auth.hashPassword('pw123')
  ).lastInsertRowid;
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, roleName);
  return { id: uid, username, fullName };
}

const adminUser = createUser('admin_test', 'admin', 'Chief Admin');
const storeUser = createUser('store_test', 'storekeeper', 'Kamal Stores');
const engUser = createUser('eng_test', 'engineer', 'Eng. Rohan Jayawardena');
const asstEngUser = createUser('asst_eng_test', 'assistant_engineer', 'Asst Eng. Nimal Silva');

const app = require('../src/server');
let server;
let base;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

async function loginAs(username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw123' }),
  });
  assert.strictEqual(res.status, 200, `Login should succeed for ${username}`);
  const setc = res.headers.get('set-cookie');
  return setc ? setc.split(';')[0] : '';
}

async function apiReq(path_, opts = {}, cookie = '') {
  const res = await fetch(base + path_, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return {
    status: res.status,
    text: !ct.includes('json') ? await res.text() : '',
    body: ct.includes('json') ? await res.json() : null,
  };
}

test('Tools Management & Scrap Approval Workflow Lifecycle', async (t) => {
  let adminCookie;
  let storeCookie;
  let engCookie;
  let asstEngCookie;

  await t.test('Authenticate users', async () => {
    adminCookie = await loginAs('admin_test');
    storeCookie = await loginAs('store_test');
    engCookie = await loginAs('eng_test');
    asstEngCookie = await loginAs('asst_eng_test');
    assert.ok(adminCookie && storeCookie && engCookie && asstEngCookie);
  });

  const mechId = run(
    'INSERT INTO mechanics (name, name_norm, active) VALUES (?, ?, 1)',
    'Sunil Perera', 'sunil perera'
  ).lastInsertRowid;

  let commonToolId;
  let mechanicToolId;

  await t.test('1. Register Common Workshop Tool and Personal Mechanic Tool', async () => {
    // Register Common Tool
    const res1 = await apiReq('/api/tools', {
      method: 'POST',
      body: {
        tool_code: 'CT-TORQUE-01',
        name: '3/4 inch Heavy Duty Torque Wrench',
        category: 'Hand Tool',
        type: 'common',
        brand: 'Snap-on',
        model_no: 'TRQ-750',
        serial_no: 'SN-90123',
        location: 'Store Rack A-02',
        purchase_cost: 65000,
        condition: 'good',
        notes: 'High precision calibration torque wrench',
      },
    }, adminCookie);

    assert.strictEqual(res1.status, 201);
    assert.strictEqual(res1.body.tool_code, 'CT-TORQUE-01');
    assert.strictEqual(res1.body.type, 'common');
    assert.strictEqual(res1.body.status, 'in_store');
    commonToolId = res1.body.id;

    // Register Mechanic Tool directly assigned to Sunil Perera
    const res2 = await apiReq('/api/tools', {
      method: 'POST',
      body: {
        tool_code: 'MT-IMPACT-01',
        name: '1/2 inch Cordless Impact Wrench',
        category: 'Power Tool',
        type: 'mechanic',
        mechanic_id: mechId,
        toolbox_name: 'Main Field Box',
        brand: 'Makita',
        model_no: 'DTW-1002',
        serial_no: 'MK-88219',
        purchase_cost: 48000,
        condition: 'good',
        notes: 'Issued to Sunil for plant overhaul jobs',
      },
    }, adminCookie);

    assert.strictEqual(res2.status, 201);
    assert.strictEqual(res2.body.tool_code, 'MT-IMPACT-01');
    assert.strictEqual(res2.body.type, 'mechanic');
    assert.strictEqual(res2.body.mechanic_id, mechId);
    assert.strictEqual(res2.body.mechanic_name, 'Sunil Perera');
    assert.strictEqual(res2.body.status, 'in_use');
    mechanicToolId = res2.body.id;
  });

  await t.test('2. Query Stats and Mechanic Toolboxes summary', async () => {
    const statsRes = await apiReq('/api/tools/stats', {}, storeCookie);
    assert.strictEqual(statsRes.status, 200);
    assert.ok(statsRes.body.total_tools >= 2);
    assert.ok(statsRes.body.common_tools >= 1);
    assert.ok(statsRes.body.mechanic_tools >= 1);

    const boxesRes = await apiReq('/api/tools/mechanic-boxes', {}, storeCookie);
    assert.strictEqual(boxesRes.status, 200);
    const sunilBox = boxesRes.body.find((b) => b.id === mechId);
    assert.ok(sunilBox, 'Sunil Perera must appear in mechanic boxes');
    assert.strictEqual(sunilBox.assigned_tools_count, 1);
    assert.strictEqual(sunilBox.good_tools_count, 1);
  });

  await t.test('3. Daily Store Issue and Return Log (handled on Stores)', async () => {
    // Create an asset and open job card for realistic checkout
    const assetId = run("INSERT INTO assets (code, code_norm, status) VALUES ('CAT-320', 'CAT320', 'active')").lastInsertRowid;
    const jobId = run("INSERT INTO job_cards (job_no, asset_id, type, status) VALUES ('2026/09/R/1045', ?, 'repair', 'IN_PROGRESS')", assetId).lastInsertRowid;

    // Issue Common Tool from Store to Sunil
    const issueRes = await apiReq('/api/tools/logs/issue', {
      method: 'POST',
      body: {
        tool_id: commonToolId,
        mechanic_id: mechId,
        issued_to_name: 'Sunil Perera',
        job_id: jobId,
        condition_out: 'good',
        issue_date: '2026-09-26',
        issue_time: '08:30',
        issued_by: 'Kamal Stores',
      },
    }, storeCookie);

    assert.strictEqual(issueRes.status, 201);
    assert.strictEqual(issueRes.body.status, 'issued');
    const logId = issueRes.body.id;

    // Check tool status transitioned to in_use (or issued)
    const toolCheck = await apiReq(`/api/tools/${commonToolId}`, {}, storeCookie);
    assert.ok(toolCheck.body.tool.status === 'in_use' || toolCheck.body.tool.status === 'issued');
    assert.strictEqual(toolCheck.body.tool.current_borrower, 'Sunil Perera');

    // Return the tool to Store
    const returnRes = await apiReq(`/api/tools/logs/${logId}/return`, {
      method: 'POST',
      body: {
        return_date: '2026-09-26',
        return_time: '17:15',
        condition_in: 'good',
        received_by: 'Kamal Stores',
        return_notes: 'Returned in clean working order',
      },
    }, storeCookie);

    assert.strictEqual(returnRes.status, 200);
    assert.strictEqual(returnRes.body.status, 'returned');

    // Tool should be back in_store
    const toolAfterReturn = await apiReq(`/api/tools/${commonToolId}`, {}, storeCookie);
    assert.strictEqual(toolAfterReturn.body.tool.status, 'in_store');
    assert.strictEqual(toolAfterReturn.body.tool.current_borrower, null);
  });

  let scrapRequestId;

  await t.test('4. Broken Tool Damage Report for specific mechanic tool', async () => {
    // Sunil's impact wrench is broken on an excavator job
    const scrapRes = await apiReq('/api/tools/scrap-requests', {
      method: 'POST',
      body: {
        tool_id: mechanicToolId,
        damage_date: '2026-09-26',
        damage_reason: 'cracked',
        incident_description: 'Anvil housing cracked and gear stripped during final drive track bolt removal.',
        reported_by: 'Kamal Stores (Reported by Sunil Perera)',
        replacement_requested: true,
      },
    }, storeCookie);

    assert.strictEqual(scrapRes.status, 201);
    assert.strictEqual(scrapRes.body.status, 'pending_approval');
    assert.strictEqual(scrapRes.body.tool_id, mechanicToolId);
    assert.strictEqual(scrapRes.body.mechanic_id, mechId);
    assert.strictEqual(scrapRes.body.mechanic_name, 'Sunil Perera');
    assert.ok(scrapRes.body.request_no.startsWith('TSR-'));
    scrapRequestId = scrapRes.body.id;

    // Tool status should be pending_scrap
    const toolCheck = await apiReq(`/api/tools/${mechanicToolId}`, {}, storeCookie);
    assert.strictEqual(toolCheck.body.tool.status, 'pending_scrap');
  });

  await t.test('5. Non-Engineer cannot approve scrap (403 Forbidden)', async () => {
    // Basic storekeeper cannot condemn tools to scrap
    const unauthRes = await apiReq(`/api/tools/scrap-requests/${scrapRequestId}/approve`, {
      method: 'POST',
      body: {
        decision: 'approved',
        remarks: 'Stores says scrap it',
      },
    }, storeCookie);

    assert.strictEqual(unauthRes.status, 403, 'Non-engineer must receive 403 Forbidden');
  });

  await t.test('6. Engineer / Assistant Engineer Approves Condemnation to Scrap', async () => {
    // Eng. Rohan Jayawardena inspects and approves condemnation
    const approveRes = await apiReq(`/api/tools/scrap-requests/${scrapRequestId}/approve`, {
      method: 'POST',
      body: {
        decision: 'approved',
        remarks: 'Physically inspected gear housing. Fatigue crack propagation prevents safe operation. Tool condemned into scrap yard.',
        scrap_bin_ref: 'SCRAP-YARD-BAY-02',
        signature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    }, engCookie);

    assert.strictEqual(approveRes.status, 200);
    assert.strictEqual(approveRes.body.status, 'approved');
    assert.strictEqual(approveRes.body.engineer_name, 'Eng. Rohan Jayawardena');
    assert.strictEqual(approveRes.body.scrap_bin_ref, 'SCRAP-YARD-BAY-02');

    // Tool status must now be 'scrapped' and active = 0 (removed from mechanic active box)
    const toolCheck = await apiReq(`/api/tools/${mechanicToolId}`, {}, storeCookie);
    assert.strictEqual(toolCheck.body.tool.status, 'scrapped');
    assert.strictEqual(toolCheck.body.tool.condition, 'scrapped');
    assert.strictEqual(toolCheck.body.tool.active, 0);

    // Mechanic toolbox summary should show 0 active tools now
    const boxesRes = await apiReq('/api/tools/mechanic-boxes', {}, storeCookie);
    const sunilBox = boxesRes.body.find((b) => b.id === mechId);
    assert.strictEqual(sunilBox.assigned_tools_count, 0);
  });

  await t.test('7. Official Tool Condemnation Certificate Print HTML (EC1.ST.FO.06)', async () => {
    const printRes = await apiReq(`/api/tools/scrap-requests/${scrapRequestId}/print.html`, {}, storeCookie);

    assert.strictEqual(printRes.status, 200);
    assert.ok(printRes.text.includes('EC1.ST.FO.06'), 'Print note must contain ISO Quality Doc No. EC1.ST.FO.06');
    assert.ok(printRes.text.includes('TOOL CONDEMNATION &amp; SCRAP NOTE') || printRes.text.includes('TOOL CONDEMNATION & SCRAP NOTE'), 'Print note must contain Title');
    assert.ok(printRes.text.includes('Sunil Perera'), 'Print note must name the mechanic who had the tool');
    assert.ok(printRes.text.includes('MT-IMPACT-01'), 'Print note must have the tool code');
    assert.ok(printRes.text.includes('Eng. Rohan Jayawardena'), 'Print note must have the approving Engineer');
    assert.ok(printRes.text.includes('SCRAP-YARD-BAY-02'), 'Print note must have the scrap bin reference');
  });

  await t.test('8. Assistant Engineer alternative repair rejection workflow', async () => {
    // Create another tool
    const newToolRes = await apiReq('/api/tools', {
      method: 'POST',
      body: {
        tool_code: 'CT-JACK-01',
        name: '50-Ton Hydraulic Bottle Jack',
        category: 'Hydraulic',
        type: 'common',
        brand: 'Mega',
        condition: 'good',
      },
    }, adminCookie);
    assert.strictEqual(newToolRes.status, 201);
    const jackId = newToolRes.body.id;

    // Report damage
    const reqRes = await apiReq('/api/tools/scrap-requests', {
      method: 'POST',
      body: {
        tool_id: jackId,
        damage_date: '2026-09-26',
        damage_reason: 'hydraulic_leak',
        incident_description: 'Oil leaking past piston seal under full load',
      },
    }, storeCookie);
    assert.strictEqual(reqRes.status, 201);
    const reqId = reqRes.body.id;

    // Assistant Engineer inspects and sends for repair instead of scrap
    const repairRes = await apiReq(`/api/tools/scrap-requests/${reqId}/approve`, {
      method: 'POST',
      body: {
        decision: 'send_for_repair',
        remarks: 'Seal replacement possible in-house. Cylinder walls in good condition.',
      },
    }, asstEngCookie);

    assert.strictEqual(repairRes.status, 200);
    assert.strictEqual(repairRes.body.status, 'under_repair');

    // Jack should remain active, condition damaged
    const jackCheck = await apiReq(`/api/tools/${jackId}`, {}, storeCookie);
    assert.strictEqual(jackCheck.body.tool.active, 1);
    assert.strictEqual(jackCheck.body.tool.condition, 'damaged');
  });
});
