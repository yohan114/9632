'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-ccom-test-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, all, db } = require('../src/db');
const auth = require('../src/lib/auth');
const storeLocations = require('../src/lib/store_locations');

migrate();

// Ensure workshops, projects, assets exist
run("INSERT OR IGNORE INTO workshops (id, code, name, is_default, active) VALUES (1, 'CW', 'Central Workshop', 1, 1)");
run("INSERT OR IGNORE INTO workshops (id, code, name, is_default, active) VALUES (2, 'GWS', 'Galagedara', 0, 1)");
run("INSERT OR IGNORE INTO projects (id, name, active) VALUES (1, 'CEP-03 Project', 1)");

storeLocations.seedStoreLocations(db);
storeLocations.migrateStoreLocationsStage2(db);

// Ensure asset
const assetId = run(`
  INSERT INTO assets (code, code_norm, registration, brand, model_no, type, asset_class, status)
  VALUES ('CAT-EX-01', 'CATEX01', 'EX-5421', 'Caterpillar', '320D Excavator', 'Excavator', 'vehicle', 'active')
`).lastInsertRowid;

// Seed roles
for (const n of ['admin', 'storekeeper', 'engineer', 'viewer']) {
  run('INSERT OR IGNORE INTO roles (name) VALUES (?)', n);
}
const adminRoleId = get("SELECT id FROM roles WHERE name = 'admin'").id;
const skRoleId = get("SELECT id FROM roles WHERE name = 'storekeeper'").id;
const engRoleId = get("SELECT id FROM roles WHERE name = 'engineer'").id;
const viewerRoleId = get("SELECT id FROM roles WHERE name = 'viewer'").id;

// Seed capabilities for testing
const caps = [
  'outsourcing.view', 'outsourcing.create', 'outsourcing.edit_draft', 'outsourcing.submit',
  'outsourcing.approve', 'outsourcing.send', 'outsourcing.record_progress',
  'outsourcing.verify_completion', 'outsourcing.cost.view', 'outsourcing.cost.post', 'outsourcing.cancel'
];
for (const c of caps) {
  run("INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES ('admin', ?, 1)", c);
  run("INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES ('engineer', ?, 1)", c);
  if (!['outsourcing.approve', 'outsourcing.verify_completion'].includes(c)) {
    run("INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES ('storekeeper', ?, 1)", c);
  }
}
run("INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES ('viewer', 'outsourcing.view', 1)");

// Users
// 1. Storekeeper (requester)
const uidSk = run("INSERT INTO users (username, password_hash, active, workshop_id, full_name) VALUES ('sk_tester', ?, 1, 1, 'Sunil Storekeeper')", auth.hashPassword('pw123')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", uidSk, skRoleId);

// 2. Mechanical Engineer (approver)
const uidEng = run("INSERT INTO users (username, password_hash, active, workshop_id, full_name) VALUES ('eng_tester', ?, 1, 1, 'Mahesh Aththanayaka')", auth.hashPassword('pw123')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", uidEng, engRoleId);

// 3. Unauthorized Viewer
const uidViewer = run("INSERT INTO users (username, password_hash, active, workshop_id, full_name) VALUES ('viewer_tester', ?, 1, 1, 'Viewer Only')", auth.hashPassword('pw123')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", uidViewer, viewerRoleId);

// 4. Admin
const uidAdmin = run("INSERT INTO users (username, password_hash, active, workshop_id, full_name) VALUES ('admin_ccom', ?, 1, 1, 'Admin')", auth.hashPassword('pw123')).lastInsertRowid;
run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", uidAdmin, adminRoleId);

const app = require('../src/server');
let server;
let base;
let cookieSk;
let cookieEng;
let cookieViewer;
let cookieAdmin;

async function loginUser(username) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw123' }),
  });
  assert.strictEqual(r.status, 200, `Login for ${username} should succeed`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;

  cookieSk = await loginUser('sk_tester');
  cookieEng = await loginUser('eng_tester');
  cookieViewer = await loginUser('viewer_tester');
  cookieAdmin = await loginUser('admin_ccom');
});

test.after(() => {
  if (server) server.close();
});

test('CCOM Outsourced Service & Repair Requests Suite', async (t) => {
  // Setup parent repair job card
  const repairJobId = run(`
    INSERT INTO job_cards (job_no, asset_id, workshop_id, status, type, description, external_cost, total_cost)
    VALUES ('JOB-2026-9001', ?, 1, 'IN_PROGRESS', 'repair', 'Major hydraulic steering failure', 0, 15000)
  `, assetId).lastInsertRowid;

  // Setup parent service job
  const serviceJobId = run(`
    INSERT INTO service_jobs (job_no, asset_id, workshop_id, service_type, outside_estimate, grand_total)
    VALUES ('SRV-2026-5001', ?, 1, '1000h Service', 0, 45000)
  `, assetId).lastInsertRowid;

  let vendorId = 1; // Seeded C.COM vendor
  let contactId = 1; // Seeded default contact
  let requestId = null;
  let refNo = null;

  await t.test('1. Get active vendors and verify C.COM is seeded', async () => {
    const res = await fetch(`${base}/api/outsourcing/vendors`, {
      headers: { cookie: cookieSk }
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.ok(json.vendors && json.vendors.length >= 1);
    const ccom = json.vendors.find((v) => v.code === 'CCOM');
    assert.ok(ccom, 'C.COM vendor must exist');
    assert.ok(ccom.contacts && ccom.contacts.length >= 1, 'Default contact must exist');
    vendorId = ccom.id;
    contactId = ccom.contacts[0].id;
  });

  await t.test('2. Storekeeper creates a CCOM draft request on ongoing Repair Job', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        repair_job_id: repairJobId,
        vendor_id: vendorId,
        vendor_contact_id: contactId,
        assigned_engineer_id: uidEng,
        request_type: 'repair',
        required_date: '2026-11-15',
        priority: 'high',
        meter_reading: 3450.5,
        meter_unit: 'hours',
        contact_name: 'W.R. Malinga Livera',
        contact_number: '075-2303039',
        informed_by: 'Transport Officer - Badalgama',
        lines: [
          {
            description: 'Inspect and overhaul hydraulic steering cylinder seals',
            location: 'Badalgama Workshop Bay 2',
            remarks: 'Requires pressure test before return'
          }
        ]
      })
    });

    assert.strictEqual(res.status, 201, 'Request creation should succeed');
    const json = await res.json();
    assert.ok(json.id, 'Request ID should be returned');
    assert.strictEqual(json.status, 'draft');
    assert.strictEqual(json.repair_job_id, repairJobId);
    assert.strictEqual(json.meter_reading, 3450.5);
    requestId = json.id;
  });

  await t.test('3. Validation rule: reject request linked to BOTH repair job and service record', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        repair_job_id: repairJobId,
        service_record_id: serviceJobId,
        vendor_id: vendorId,
        request_type: 'repair'
      })
    });
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /cannot be linked to both/i);
  });

  await t.test('4. Storekeeper updates draft lines and attendance details', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests/${requestId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        meter_reading: 3452,
        lines: [
          {
            description: 'Inspect and overhaul hydraulic steering cylinder seals',
            location: 'Badalgama Workshop Bay 2',
            remarks: 'Urgent turnaround requested'
          },
          {
            description: 'Calibrate steering control valve assembly',
            location: 'C.COM Workshop',
            remarks: 'OEM calibration kit required'
          }
        ]
      })
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.meter_reading, 3452);

    const getRes = await fetch(`${base}/api/outsourcing/requests/${requestId}`, {
      headers: { cookie: cookieSk }
    });
    const details = await getRes.json();
    assert.strictEqual(details.lines.length, 2, 'Should have 2 lines');
  });

  await t.test('5. Storekeeper submits request: allocates ref_no and freezes revision', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests/${requestId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({})
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'pending_approval');
    assert.match(json.ref_no, /^CCOM-\d{4}-\d{4}$/, 'Reference number must match CCOM-YYYY-XXXX format');
    refNo = json.ref_no;

    // Check revision was stored
    const rev = get('SELECT * FROM outsourcing_revisions WHERE request_id = ? AND revision_no = 1', requestId);
    assert.ok(rev, 'Revision 1 must exist');
    assert.ok(rev.content_hash, 'Hash must be generated');
  });

  await t.test('6. Separation of duties rule: Requester CANNOT approve own request', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests/${requestId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({ password: 'pw123' })
    });

    assert.strictEqual(res.status, 403, 'Self-approval must be blocked with 403');
    const json = await res.json();
    assert.match(json.error, /cannot approve their own/i);
  });

  await t.test('7. Unauthorized viewer cannot approve or return request', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests/${requestId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieViewer },
      body: JSON.stringify({ password: 'pw123' })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('8. Engineer checks inbox and returns request for correction', async () => {
    // Check inbox
    const inboxRes = await fetch(`${base}/api/outsourcing/approval-inbox`, {
      headers: { cookie: cookieEng }
    });
    assert.strictEqual(inboxRes.status, 200);
    const inbox = await inboxRes.json();
    assert.ok(inbox.requests.some((r) => r.id === requestId), 'Request must appear in assigned engineer inbox');

    // Return request
    const retRes = await fetch(`${base}/api/outsourcing/requests/${requestId}/return`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieEng },
      body: JSON.stringify({ reason: 'Please specify exact serial number of valve assembly' })
    });

    assert.strictEqual(retRes.status, 200);
    const retJson = await retRes.json();
    assert.strictEqual(retJson.status, 'returned');
  });

  await t.test('9. Storekeeper clarifies description and re-submits revision 2', async () => {
    // Update lines
    await fetch(`${base}/api/outsourcing/requests/${requestId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        lines: [
          {
            description: 'Inspect and overhaul hydraulic steering cylinder seals',
            location: 'Badalgama Workshop Bay 2',
            remarks: 'Urgent turnaround requested'
          },
          {
            description: 'Calibrate steering control valve assembly (S/N: VLV-9921-B)',
            location: 'C.COM Workshop',
            remarks: 'OEM calibration kit required'
          }
        ]
      })
    });

    // Re-submit
    const subRes = await fetch(`${base}/api/outsourcing/requests/${requestId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk }
    });
    assert.strictEqual(subRes.status, 200);

    const rev2 = get('SELECT * FROM outsourcing_revisions WHERE request_id = ? AND revision_no = 2', requestId);
    assert.ok(rev2, 'Revision 2 must exist');
  });

  await t.test('10. Engineer approves & electronically signs: generates approved PDF', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests/${requestId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieEng },
      body: JSON.stringify({
        password: 'pw123',
        approval_note: 'Approved for C.COM inspection & repair.'
      })
    });

    assert.strictEqual(res.status, 200, 'Approval should succeed');
    const json = await res.json();
    assert.strictEqual(json.status, 'approved');
    assert.ok(json.document, 'Approved PDF document record must be returned');

    // Verify file exists on disk and hash is valid
    assert.ok(fs.existsSync(json.document.file_path), 'PDF file must exist on disk');
    assert.ok(json.document.file_hash, 'File hash must be recorded');
  });

  await t.test('11. Preview endpoint returns valid HTML with letterhead and dual signatures', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests/${requestId}/preview`, {
      headers: { cookie: cookieSk }
    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /EDWARD &amp; CHRISTIE/i);
    assert.match(html, /REQUEST FOR REPAIR/i);
    assert.match(html, /C\.COM \(United Motors Lanka PLC\)/i);
    assert.match(html, /EX-5421/i);
    assert.match(html, /Mahesh Aththanayaka/i);
  });

  await t.test('12. Download PDF endpoint serves the approved document', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests/${requestId}/pdf`, {
      headers: { cookie: cookieEng }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 1000, 'PDF buffer must have valid content');
  });

  await t.test('13. Queue reviewed email and dispatch to C.COM agent', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests/${requestId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        to: [{ email: 'service@ccom.lk', name: 'C.COM Service Desk' }],
        cc: [{ email: 'workshop@edwardchristie.com', name: 'Central Workshop' }],
        subject: `C.COM Repair Request — ${refNo} — EX-5421`,
        body: 'Please find attached the approved Request for Repair from Edward & Christie Central Workshop.'
      })
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.outbox.status, 'sent');
    assert.ok(json.outbox.provider_msg_id, 'Provider message ID must be recorded');

    // Check request status updated to 'sent'
    const reqRow = get('SELECT status FROM outsourcing_requests WHERE id = ?', requestId);
    assert.strictEqual(reqRow.status, 'sent');
  });

  await t.test('14. Work progress tracking: C.COM acknowledges and starts work', async () => {
    const progRes = await fetch(`${base}/api/outsourcing/requests/${requestId}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        status: 'in_progress',
        notes: 'C.COM technician mobilized to site for disassembly'
      })
    });
    assert.strictEqual(progRes.status, 200);

    const reqRow = get('SELECT status FROM outsourcing_requests WHERE id = ?', requestId);
    assert.strictEqual(reqRow.status, 'in_progress');
  });

  await t.test('15. Engineer verifies completion of outsourced work', async () => {
    const verRes = await fetch(`${base}/api/outsourcing/requests/${requestId}/verify-completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieEng },
      body: JSON.stringify({
        verification_note: 'Hydraulic steering tested under load, zero leaks observed'
      })
    });
    assert.strictEqual(verRes.status, 200);

    const reqRow = get('SELECT status FROM outsourcing_requests WHERE id = ?', requestId);
    assert.strictEqual(reqRow.status, 'completed');
  });

  await t.test('16. Post verified CCOM invoice cost to parent repair job', async () => {
    const postRes = await fetch(`${base}/api/outsourcing/requests/${requestId}/post-cost`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        invoice_no: 'CCOM-INV-2026-8812',
        invoice_date: '2026-11-20',
        amount: 85000,
        notes: 'Replaced seal kit and calibrated control valves'
      })
    });

    assert.strictEqual(postRes.status, 200);
    const postJson = await postRes.json();
    assert.strictEqual(postJson.status, 'closed');
    assert.strictEqual(postJson.amount, 85000);

    // Verify parent job card external_cost and total_cost was updated
    const parentJob = get('SELECT external_cost, total_cost FROM job_cards WHERE id = ?', repairJobId);
    assert.strictEqual(parentJob.external_cost, 85000, 'Job card external_cost must be 85,000');
    assert.strictEqual(parentJob.total_cost, 100000, 'Job card total_cost must reflect the addition (15000 + 85000 = 100000)');

    // Verify duplicate cost posting is blocked
    const dupRes = await fetch(`${base}/api/outsourcing/requests/${requestId}/post-cost`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        invoice_no: 'CCOM-INV-2026-8812',
        amount: 85000
      })
    });
    assert.strictEqual(dupRes.status, 400, 'Duplicate cost posting must be blocked');
  });

  await t.test('17. Service record CCOM flow: create and post cost to outside_estimate', async () => {
    // Create CCOM request for Service Record
    const srvRes = await fetch(`${base}/api/outsourcing/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        service_record_id: serviceJobId,
        vendor_id: vendorId,
        vendor_contact_id: contactId,
        assigned_engineer_id: uidEng,
        request_type: 'service',
        meter_reading: 1000,
        meter_unit: 'hours',
        lines: [
          { description: '1000-hour specialized electronic pump diagnostic calibration', location: 'Site' }
        ]
      })
    });
    assert.strictEqual(srvRes.status, 201);
    const srvReq = await srvRes.json();

    // Submit
    await fetch(`${base}/api/outsourcing/requests/${srvReq.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk }
    });

    // Approve
    await fetch(`${base}/api/outsourcing/requests/${srvReq.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieEng },
      body: JSON.stringify({ password: 'pw123' })
    });

    // Post cost
    const costRes = await fetch(`${base}/api/outsourcing/requests/${srvReq.id}/post-cost`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        invoice_no: 'CCOM-SRV-INV-4410',
        amount: 32000
      })
    });
    assert.strictEqual(costRes.status, 200);

    // Verify service job outside_estimate and grand_total updated
    const srvRow = get('SELECT outside_estimate, grand_total FROM service_jobs WHERE id = ?', serviceJobId);
    assert.strictEqual(srvRow.outside_estimate, 32000, 'Service job outside_estimate must be 32,000');
    assert.strictEqual(srvRow.grand_total, 77000, 'Service job grand_total must be 45000 + 32000 = 77000');
  });

  await t.test('18. Cancellation of request with reason', async () => {
    // Create new draft
    const draftRes = await fetch(`${base}/api/outsourcing/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieSk },
      body: JSON.stringify({
        repair_job_id: repairJobId,
        vendor_id: vendorId,
        request_type: 'repair',
        lines: [{ description: 'Work to be cancelled' }]
      })
    });
    const draft = await draftRes.json();

    // Cancel
    const cancelRes = await fetch(`${base}/api/outsourcing/requests/${draft.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieEng },
      body: JSON.stringify({ reason: 'Internal workshop decided to overhaul in-house instead' })
    });
    assert.strictEqual(cancelRes.status, 200);
    const cancelJson = await cancelRes.json();
    assert.strictEqual(cancelJson.status, 'cancelled');

    const draftRow = get('SELECT status, cancellation_reason FROM outsourcing_requests WHERE id = ?', draft.id);
    assert.strictEqual(draftRow.status, 'cancelled');
    assert.strictEqual(draftRow.cancellation_reason, 'Internal workshop decided to overhaul in-house instead');
  });

  await t.test('19. Global register listing without query parameters returns requests with parent_job_no and invoice cost', async () => {
    const res = await fetch(`${base}/api/outsourcing/requests`, {
      headers: { cookie: cookieSk }
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.requests), 'Must return requests array');
    assert.ok(json.requests.length >= 2, 'Should contain created requests');

    const verifiedReq = json.requests.find((r) => r.id === requestId);
    assert.ok(verifiedReq, 'Completed request must be present in global register');
    assert.strictEqual(verifiedReq.vendor_name, 'C.COM (United Motors Lanka PLC)');
    assert.strictEqual(verifiedReq.posted_invoice_amount, 85000);
    assert.strictEqual(verifiedReq.posted_invoice_no, 'CCOM-INV-2026-8812');
    assert.ok(verifiedReq.parent_job_no, 'Parent job number should be populated');
  });
});
