'use strict';

// Phase B — an MRN can be raised for ANY vehicle (job card optional) and for ANY item
// (catalogue pick, or a brand-new item added on the spot). Isolated DB + real server.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-mrn-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const aliases = require('../src/lib/aliases');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();
require('../src/migrate/26_subcategories').runStep();

for (const n of ['admin', 'storekeeper', 'workshop']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}
// Two vehicles: one with an open job card, one with none at all.
const busy = aliases.findOrCreateAsset('28-4314', {}).id;
const idle = aliases.findOrCreateAsset('LO-5981', {}).id;
const openJob = run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status) VALUES ('2026/7/R/1', ?, 'repair', 'gearbox', 'IN_PROGRESS')`, busy).lastInsertRowid;
const otherJob = run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status) VALUES ('2026/7/R/2', ?, 'repair', 'brakes', 'IN_PROGRESS')`, idle).lastInsertRowid;
run(`INSERT INTO store_items (name, item_no, unit, part_numbers, category, category_id)
     VALUES ('Air Filter Element', 'FIL-0009', 'nos', 'AF-2554|P181050', 'Filters',
             (SELECT c.id FROM item_categories c JOIN item_categories p ON p.id = c.parent_id
               WHERE p.name = 'Filters' AND c.name = 'Air Filter'))`);

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.strictEqual((await req('/api/auth/login', { method: 'POST', body: { username: 'sk', password: 'pw' } })).status, 200);
});
test.after(() => server && server.close());

async function req(path_, opts = {}) {
  const res = await fetch(base + path_, {
    method: opts.method || 'GET',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}
const mrn = (body) => req('/api/stores/mrn', { method: 'POST', body: { lines: [{ description: 'Thing', qty: 1 }], ...body } });

test('a vehicle with NO open job card can still be requested for', async () => {
  const r = await mrn({ request_type: 'vehicle', asset_id: idle });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.mrn.asset_id, idle);
  assert.strictEqual(r.body.mrn.job_id, null);
});

test('a vehicle request without a vehicle is rejected', async () => {
  const r = await mrn({ request_type: 'vehicle' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /vehicle/i);
});

test('a job card may be linked, and sets nothing the vehicle disagrees with', async () => {
  const ok = await mrn({ request_type: 'vehicle', asset_id: busy, job_id: openJob });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.mrn.job_id, openJob);
  assert.strictEqual(ok.body.mrn.asset_id, busy);

  const clash = await mrn({ request_type: 'vehicle', asset_id: busy, job_id: otherJob });
  assert.strictEqual(clash.status, 409);
  assert.match(clash.body.error, /different vehicle/i);

  const unknown = await mrn({ request_type: 'vehicle', asset_id: busy, job_id: 99999 });
  assert.strictEqual(unknown.status, 400);
});

test('a job card alone still fills in its vehicle', async () => {
  const r = await mrn({ request_type: 'vehicle', job_id: openJob });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.mrn.asset_id, busy);
});

test('an unknown vehicle name is queued for linking rather than refused', async () => {
  const r = await mrn({ request_type: 'vehicle', asset: 'Big Yellow Digger' });
  assert.strictEqual(r.status, 201);
  assert.ok(r.body.unresolved, 'the raw text should be queued in the alias queue');
});

test('a general (store) request needs no vehicle at all', async () => {
  const r = await mrn({ request_type: 'general' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.mrn.asset_id, null);
});

test('picking a catalogue item snapshots its name, unit and sub-category', async () => {
  const found = await req('/api/stores/items/search?q=air filter');
  assert.strictEqual(found.status, 200);
  const item = found.body.find((i) => i.item_no === 'FIL-0009');
  assert.ok(item, 'search should find the item by name');

  const r = await mrn({ request_type: 'vehicle', asset_id: idle, lines: [{ store_item_id: item.id, qty: 2 }] });
  const line = r.body.lines[0];
  assert.strictEqual(line.store_item_id, item.id);
  assert.strictEqual(line.description, 'Air Filter Element'); // filled from the catalogue
  assert.strictEqual(line.unit, 'nos');
  assert.strictEqual(line.category, 'Filters');
  assert.strictEqual(line.category_id, item.category_id);
});

test('the item search matches part numbers and item numbers too', async () => {
  assert.ok((await req('/api/stores/items/search?q=P181050')).body.some((i) => i.item_no === 'FIL-0009'));
  assert.ok((await req('/api/stores/items/search?q=FIL-0009')).body.some((i) => i.item_no === 'FIL-0009'));
  assert.strictEqual((await req('/api/stores/items/search?q=')).body.length, 0);
});

test('a brand-new item can be added to the catalogue while requesting it', async () => {
  const cat = get(`SELECT c.id FROM item_categories c JOIN item_categories p ON p.id = c.parent_id
                    WHERE p.name = 'Hydraulics' AND c.name = 'Hoses & Fittings'`);
  const r = await mrn({
    request_type: 'vehicle', asset_id: idle,
    lines: [{ description: 'Hydraulic Hose 3/4 x 2m', qty: 1, unit: 'nos', create_item: true, category_id: cat.id }],
  });
  assert.strictEqual(r.status, 201);
  const line = r.body.lines[0];
  assert.ok(line.store_item_id, 'the line should link to the newly created item');
  const item = get('SELECT * FROM store_items WHERE id = ?', line.store_item_id);
  assert.strictEqual(item.name, 'Hydraulic Hose 3/4 x 2m');
  assert.strictEqual(item.category, 'Hydraulics');
  assert.match(item.item_no, /^HYD-\d{4}$/); // numbered inside its own category
});

test('requesting the same new item twice reuses the catalogue entry', async () => {
  const before = get("SELECT COUNT(*) c FROM store_items WHERE name = 'Hydraulic Hose 3/4 x 2m'").c;
  await mrn({ request_type: 'vehicle', asset_id: idle, lines: [{ description: 'hydraulic hose 3/4 X 2M', qty: 1, create_item: true }] });
  assert.strictEqual(get("SELECT COUNT(*) c FROM store_items WHERE name = 'Hydraulic Hose 3/4 x 2m'").c, before);
});

test('free text with no catalogue link still works', async () => {
  const r = await mrn({ request_type: 'vehicle', asset_id: idle, lines: [{ description: 'Something unusual', qty: 3 }] });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.lines[0].store_item_id, null);
  assert.strictEqual(r.body.lines[0].description, 'Something unusual');
});

test('the list and detail expose the linked job card', async () => {
  const list = await req('/api/stores/mrn?limit=100');
  const linked = list.body.find((m) => m.job_id === openJob);
  assert.strictEqual(linked.job_no, '2026/7/R/1');
  const detail = await req('/api/stores/mrn/' + linked.id);
  assert.strictEqual(detail.body.mrn.job_no, '2026/7/R/1');
  assert.strictEqual(detail.body.mrn.job_status, 'IN_PROGRESS');
});

test('a linked request still gates its job’s closure; an unlinked one does not', async () => {
  const costing = require('../src/lib/costing');
  // The linked MRN above is unreceived, so the job it names cannot close yet.
  assert.ok(costing.closureReadiness(openJob).missing.some((m) => /awaiting GRN/.test(m)));
  // A request raised against the same vehicle WITHOUT a job link leaves it alone.
  const solo = await mrn({ request_type: 'vehicle', asset_id: idle, lines: [{ description: 'Unlinked part', qty: 5 }] });
  assert.strictEqual(solo.body.mrn.job_id, null);
  assert.ok(!costing.closureReadiness(otherJob).missing.some((m) => /Unlinked part/.test(m)));
  assert.ok(all('SELECT id FROM mrn WHERE job_id IS NULL AND asset_id IS NOT NULL').length > 0);
});
