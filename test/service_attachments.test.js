'use strict';

// Scanned service sheets attached to a service record.
//
// The bytes are kept IN the database on purpose: a backup is a SQLite .backup() of the one .db
// file and a restore swaps that file, so a PDF written beside it would quietly not be backed up
// and would not survive a restore. These tests pin that, plus the checks that stop an unopenable
// file being stored and stop a whole PDF being dragged into memory just to list a service.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-svc-attach-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

for (const n of ['admin', 'workshop', 'viewer']) run('INSERT INTO roles (name) VALUES (?)', n);
const mkUser = (name, roles) => {
  const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', name, auth.hashPassword('pw')).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
  return uid;
};
mkUser('sk', ['workshop']);
mkUser('looker', ['viewer']);

const serviceId = run(
  `INSERT INTO service_jobs (vehicle_label, service_date, job_no) VALUES ('28-4314', '2026-04-01', 'S/1')`
).lastInsertRowid;

// A short but structurally real PDF, and something that only pretends to be one.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>', 'latin1');
const NOT_PDF = Buffer.from('MZ this is an executable, renamed');

const app = require('../src/server');
let server; let base; let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function login(username) {
  cookie = null;
  const r = await req('/api/auth/login', { method: 'POST', body: { username, password: 'pw' } });
  assert.strictEqual(r.status, 200, `login as ${username}`);
}

async function req(p, opts = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}) };
  let body;
  if (opts.raw) { headers['Content-Type'] = 'application/pdf'; body = opts.raw; }
  else if (opts.body) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(base + p, { method: opts.method || 'GET', headers, body });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return {
    status: res.status,
    headers: res.headers,
    body: ct.includes('json') ? await res.json() : (ct.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : await res.text()),
  };
}

const upload = (name, buf) => req(`/api/filters/services/${serviceId}/attachments?filename=${encodeURIComponent(name)}`,
  { method: 'POST', raw: buf });

test('a PDF attaches to a service and comes back byte for byte', async () => {
  await login('sk');
  const up = await upload('Service Sheet.pdf', PDF);
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.body.attachment.filename, 'Service Sheet.pdf');
  assert.strictEqual(up.body.attachment.size_bytes, PDF.length, 'stored at its real size, not base64-inflated');

  const back = await req(`/api/filters/attachments/${up.body.attachment.id}`);
  assert.strictEqual(back.status, 200);
  assert.ok(Buffer.isBuffer(back.body));
  assert.strictEqual(crypto.createHash('sha256').update(back.body).digest('hex'),
    crypto.createHash('sha256').update(PDF).digest('hex'), 'the file is unchanged by the round trip');
  assert.match(back.headers.get('content-disposition'), /^inline; filename="Service Sheet\.pdf"/);

  const dl = await req(`/api/filters/attachments/${up.body.attachment.id}?download=1`);
  assert.match(dl.headers.get('content-disposition'), /^attachment;/, '?download=1 saves instead of previewing');
});

test('a file that is not really a PDF is refused', async () => {
  await login('sk');
  const r = await upload('actually-an-exe.pdf', NOT_PDF);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /not a PDF/);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_attachments WHERE filename = ?', 'actually-an-exe.pdf').c, 0);
});

test('an empty upload is refused', async () => {
  await login('sk');
  const r = await upload('empty.pdf', Buffer.alloc(0));
  assert.strictEqual(r.status, 400);
});

test('a path in the filename is stripped before it is stored', async () => {
  await login('sk');
  const r = await upload('..\\..\\windows\\system32\\evil.pdf', PDF);
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.attachment.filename, 'evil.pdf', 'no directory part survives');
});

test('listing a service does not drag the file bytes along', async () => {
  await login('sk');
  const list = await req(`/api/filters/services/${serviceId}/attachments`);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.length >= 1);
  for (const a of list.body) {
    assert.ok(!('data' in a), 'the blob must never reach the browser in a listing');
    assert.ok(a.size_bytes > 0);
  }
  const detail = await req(`/api/filters/services/${serviceId}`);
  assert.ok(Array.isArray(detail.body.attachments), 'the service payload carries the list');
  assert.ok(!('data' in (detail.body.attachments[0] || {})));
});

test('a read-only user cannot attach or remove documents', async () => {
  await login('looker');
  const up = await upload('sneaky.pdf', PDF);
  assert.strictEqual(up.status, 403);
  const existing = get('SELECT id FROM service_attachments ORDER BY id LIMIT 1').id;
  const del = await req(`/api/filters/attachments/${existing}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 403);
  assert.ok(get('SELECT id FROM service_attachments WHERE id = ?', existing), 'and nothing was removed');
});

test('attachments live in the database, so a backup carries them', async () => {
  const dest = path.join(os.tmpdir(), 'workshopone-attach-backup.db');
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(dest + s); } catch {} }
  const Database = require('better-sqlite3');
  await new Database(TEST_DB).backup(dest);          // the same call src/lib/backup uses

  const copy = new Database(dest, { readonly: true });
  const rows = copy.prepare('SELECT filename, size_bytes, data FROM service_attachments').all();
  copy.close();
  assert.ok(rows.length >= 1, 'the backup contains the attachments');
  const sheet = rows.find((r) => r.filename === 'Service Sheet.pdf');
  assert.ok(sheet, 'including the one we uploaded');
  assert.strictEqual(crypto.createHash('sha256').update(sheet.data).digest('hex'),
    crypto.createHash('sha256').update(PDF).digest('hex'), 'and its bytes are intact inside the backup');
});

test('removing a document deletes it, and closing the service takes its papers with it', async () => {
  await login('sk');
  const id = get('SELECT id FROM service_attachments ORDER BY id DESC LIMIT 1').id;
  const del = await req(`/api/filters/attachments/${id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_attachments WHERE id = ?', id).c, 0);

  // The FK is ON DELETE CASCADE, so a deleted service cannot leave orphaned blobs behind.
  run('DELETE FROM service_jobs WHERE id = ?', serviceId);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_attachments WHERE service_id = ?', serviceId).c, 0);
});

// ---------------------------------------------------------------------------
// Daily reports — the two sheets the office used to type by hand.
// ---------------------------------------------------------------------------
const daily = require('../src/lib/daily_reports');

test('today is live and editable; an earlier day reads its frozen copy', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  daily.snapshot('job_summary', { asOf: yesterday });
  const frozen = daily.readSnapshot('job_summary', yesterday);
  assert.ok(frozen, 'yesterday is frozen');

  await login('sk');
  const t = await req(`/api/reports/daily/job_summary?date=${today}`);
  assert.strictEqual(t.body.saved, false, 'today must stay live — the hourly save must not lock it');

  const y = await req(`/api/reports/daily/job_summary?date=${yesterday}`);
  assert.strictEqual(y.body.saved, true, 'an earlier day reads the copy kept for it');
  assert.ok(y.body.generated_at);
});

test('a supervisor note carries forward to later days', async () => {
  const v = require('../src/lib/aliases').findOrCreateAsset('DR-01', {}).id;
  const j = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at)
                 VALUES ('2026/9/R/77', ?, 'repair', 'gearbox strip', 'IN_PROGRESS', date('now'))`, v).lastInsertRowid;

  await login('sk');
  const put = await req(`/api/reports/daily/job-summary/notes/${j}`, {
    method: 'PUT',
    body: { completed_repairs: 'stripped', pending_repairs: 'awaiting bearings', job_status: 'Ongoing', spare_parts: 'on order' },
  });
  assert.strictEqual(put.status, 200);

  // A job with notes stays on the list even with no recent work, and the notes come with it.
  const today = daily.build('job_summary', {});
  const row = today.rows.find((r) => r.job_id === j);
  assert.ok(row, 'a job being tracked stays listed');
  assert.strictEqual(row.completed_repairs, 'stripped');

  const later = daily.build('job_summary', { asOf: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
  const row2 = later.rows.find((r) => r.job_id === j);
  assert.strictEqual(row2.job_status, 'Ongoing', 'still there five days on — it is not retyped daily');
});

test('pending parts groups a multi-item request under one number', () => {
  const d = daily.build('pending_parts', {});
  for (const sec of d.sections) {
    assert.ok(['HP', 'LP', 'NA'].includes(sec.tab));
    // A continuation line repeats neither the number nor the MRN, matching the paper layout.
    const numbered = sec.rows.filter((r) => r.no !== '');
    assert.strictEqual(numbered.length, sec.requests, 'one number per request, not per item');
    for (const r of sec.rows) assert.ok(r.description !== undefined && r.qty !== undefined);
  }
});

test('pending price splits by purchase source and leaves the price column empty', async () => {
  const d = daily.build('pending_price', {});
  assert.ok(Array.isArray(d.sections), 'it is a sectioned report like pending parts');
  for (const sec of d.sections) {
    assert.ok(['HP', 'LP', 'NA'].includes(sec.tab));
    // one number per request, continuation lines blank — same reading as the paper sheet
    assert.strictEqual(sec.rows.filter((r) => r.no !== '').length, sec.requests);
    for (const r of sec.rows) assert.ok('grn_id' in r, 'each line points back at its receipt');
  }
  // Only unpriced receipts belong here.
  const ids = d.sections.flatMap((s) => s.rows).map((r) => r.grn_id);
  if (ids.length) {
    const priced = get(`SELECT COUNT(*) c FROM grn WHERE unit_price IS NOT NULL AND id IN (${ids.join(',')})`).c;
    assert.strictEqual(priced, 0, 'a receipt that already has a price must not be listed');
  }
});

test('a sectioned report can be snapshotted', () => {
  // The row counter used to name one report explicitly, so the next sectioned one added threw
  // inside the scheduler's catch and silently never saved.
  const snap = daily.snapshot('pending_price', {});
  assert.ok(snap && snap.row_count >= 0);
  const back = daily.readSnapshot('pending_price', snap.report_date);
  assert.ok(back && Array.isArray(back.data.sections));
});

test('the summery fills completed work, leaves pending blank, and lists parts not received', async () => {
  const aliases = require('../src/lib/aliases');
  const v = aliases.findOrCreateAsset('SUM-01', {}).id;
  const j = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at)
                 VALUES ('2026/9/R/88', ?, 'repair', 'gearbox strip and rebuild', 'IN_PROGRESS', date('now'))`, v).lastInsertRowid;
  // two days of work, one repeated — a task written twice is one line of work
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, description) VALUES (?, date('now','-2 day'), 'Anura', 4, 'gearbox removed')`, j);
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, description) VALUES (?, date('now','-1 day'), 'Anura', 4, 'gearbox removed')`, j);
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, hours, description) VALUES (?, date('now'), 'Anura', 3, 'bearings pressed out')`, j);
  // one part received, one still awaited
  const m = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, status) VALUES ('900100', date('now'), ?, ?, 'open')`, v, j).lastInsertRowid;
  run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, unit) VALUES (?, 'Bearing set', 2, 2, 'nos')`, m);
  run(`INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, unit) VALUES (?, 'Input shaft', 1, 0, 'nos')`, m);

  const row = daily.build('job_summary', {}).rows.find((r) => r.job_id === j);
  assert.ok(row, 'the job is on the sheet');

  assert.match(row.completed_repairs, /bearings pressed out/, 'the newest work comes first');
  assert.match(row.completed_repairs, /gearbox removed/);
  assert.strictEqual((row.completed_repairs.match(/gearbox removed/g) || []).length, 1,
    'the same task on two days is one line, not two');

  assert.strictEqual(row.pending_repairs, '', 'pending is left for the supervisor to judge');

  assert.match(row.spare_parts, /Input shaft/, 'what has not arrived is listed');
  assert.ok(!/Bearing set/.test(row.spare_parts), 'what already arrived is not');

  // anything typed still wins over the derived text
  await login('sk');
  await req(`/api/reports/daily/job-summary/notes/${j}`, { method: 'PUT', body: { completed_repairs: 'my own words', pending_repairs: 'fit new shaft' } });
  const after = daily.build('job_summary', {}).rows.find((r) => r.job_id === j);
  assert.strictEqual(after.completed_repairs, 'my own words');
  assert.strictEqual(after.pending_repairs, 'fit new shaft');
});
