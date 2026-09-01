'use strict';

// Phase A — Category → Sub-category tree, end to end over HTTP on an isolated DB.
// Mirrors test/http.test.js: temp DB, minimal fixture, a real listening server.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-categories-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

for (const n of ['admin', 'storekeeper', 'workshop']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}
// Two legacy rows the migration has to fold in: the old 'Belts' label and a blank one.
run("INSERT INTO store_items (name, category) VALUES ('Fan Belt 8PK1200', 'Belts')");
run("INSERT INTO store_items (name, category) VALUES ('Mystery Widget', '')");
run("INSERT INTO issues (description, category, qty, issue_date) VALUES ('Air Filter', 'Filters', 1, '2026-01-05')");

// Same order a real install uses: the ERP gap-fill (issues.service_id,
// vehicle_monthly_costs…) lands before the category tree is seeded on top.
require('../src/migrate/015_phase4_erp_gaps').runStep();
const seeded = require('../src/migrate/26_subcategories').runStep();

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await req('/api/auth/login', { method: 'POST', body: { username: 'sk', password: 'pw' } });
  assert.strictEqual(r.status, 200);
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
const tree = async () => (await req('/api/stores/categories/tree')).body.tree;
const findParent = async (name) => (await tree()).find((p) => p.name === name);

test('migration seeds the tree and is idempotent', async () => {
  assert.strictEqual(seeded.total_parents, 19);
  assert.ok(seeded.total_subs > 50);
  const again = require('../src/migrate/26_subcategories').runStep();
  assert.strictEqual(again.parents_created, 0);
  assert.strictEqual(again.subs_created, 0);
  assert.strictEqual(again.backfilled.store_items, 0);
});

test('legacy labels fold into the canonical vocabulary', () => {
  // 'Belts' is not a category any more — the row now reads 'Belts & Hoses'.
  const belt = get("SELECT category, category_id FROM store_items WHERE name = 'Fan Belt 8PK1200'");
  assert.strictEqual(belt.category, 'Belts & Hoses');
  assert.ok(belt.category_id);
  // A blank category still gets a home rather than being left orphaned.
  const widget = get("SELECT category, category_id FROM store_items WHERE name = 'Mystery Widget'");
  assert.strictEqual(widget.category, 'Other');
  assert.ok(widget.category_id);
});

test('keyword placement puts an obvious item in the right sub-category', () => {
  const row = get(`SELECT c.name sub FROM issues i JOIN item_categories c ON c.id = i.category_id WHERE i.description = 'Air Filter'`);
  assert.strictEqual(row.sub, 'Air Filter');
});

test('every categorised record points at a LEAF, never a parent', () => {
  for (const t of ['store_items', 'issues', 'mrn_lines', 'mtn']) {
    const bad = get(`SELECT COUNT(*) c FROM ${t} JOIN item_categories ic ON ic.id = ${t}.category_id WHERE ic.parent_id IS NULL`).c;
    assert.strictEqual(bad, 0, `${t} has a record linked to a top-level category`);
  }
});

test('the tree is two levels — a sub-category cannot have children', async () => {
  const created = await req('/api/stores/categories', { method: 'POST', body: { name: 'Test Cat', code: 'TST' } });
  assert.strictEqual(created.status, 201);
  const parentId = created.body.id;
  // A new category comes with its General bucket already in place.
  const p = (await tree()).find((x) => x.id === parentId);
  assert.deepStrictEqual(p.subs.map((s) => s.name), ['General']);

  const sub = await req('/api/stores/categories', { method: 'POST', body: { parent_id: parentId, name: 'Test Sub' } });
  assert.strictEqual(sub.status, 201);
  const deep = await req('/api/stores/categories', { method: 'POST', body: { parent_id: sub.body.id, name: 'Too Deep' } });
  assert.strictEqual(deep.status, 400);
  const dupe = await req('/api/stores/categories', { method: 'POST', body: { parent_id: parentId, name: 'test sub' } });
  assert.strictEqual(dupe.status, 409);
});

test('creating an item stores the sub-category id and the parent label', async () => {
  const filters = await findParent('Filters');
  const oil = filters.subs.find((s) => s.name === 'Oil Filter');
  const r = await req('/api/stores/items', { method: 'POST', body: { name: 'Test Oil Filter', category_id: oil.id } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.category_id, oil.id);
  assert.strictEqual(r.body.category, 'Filters');
});

test('a parent id resolves to that parent’s General bucket', async () => {
  const filters = await findParent('Filters');
  const r = await req('/api/stores/items', { method: 'POST', body: { name: 'Vague Filter', category_id: filters.id } });
  assert.strictEqual(r.body.category, 'Filters');
  const sub = get('SELECT name FROM item_categories WHERE id = ?', r.body.category_id);
  assert.strictEqual(sub.name, 'General');
});

test('a legacy free-text category still resolves to the tree', async () => {
  const r = await req('/api/stores/items', { method: 'POST', body: { name: 'Old Style Belt', category: 'Belts' } });
  assert.strictEqual(r.body.category, 'Belts & Hoses');
  assert.ok(r.body.category_id, 'legacy text should still land on a sub-category');
});

test('renaming a category relabels every record under it', async () => {
  const p = await findParent('Welding & Gas');
  const sub = p.subs.find((s) => s.name === 'Electrodes');
  await req('/api/stores/items', { method: 'POST', body: { name: 'Test Electrode 3.2mm', category_id: sub.id } });
  const before = get("SELECT category FROM store_items WHERE name = 'Test Electrode 3.2mm'").category;
  assert.strictEqual(before, 'Welding & Gas');

  const r = await req('/api/stores/categories/' + p.id, { method: 'PATCH', body: { name: 'Welding and Gas' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(get("SELECT category FROM store_items WHERE name = 'Test Electrode 3.2mm'").category, 'Welding and Gas');
  assert.strictEqual(get("SELECT COUNT(*) c FROM store_items WHERE category = 'Welding & Gas'").c, 0);
  await req('/api/stores/categories/' + p.id, { method: 'PATCH', body: { name: 'Welding & Gas' } }); // restore
});

test('merging a sub-category moves its records and removes the source', async () => {
  const p = await findParent('Tools');
  const from = p.subs.find((s) => s.name === 'Hand Tools');
  const into = p.subs.find((s) => s.name === 'Power Tools');
  await req('/api/stores/items', { method: 'POST', body: { name: 'Test Spanner Set', category_id: from.id } });

  const r = await req(`/api/stores/categories/${from.id}/merge`, { method: 'POST', body: { into_id: into.id } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.records >= 1);
  assert.strictEqual(get('SELECT COUNT(*) c FROM item_categories WHERE id = ?', from.id).c, 0);
  assert.strictEqual(get("SELECT category_id FROM store_items WHERE name = 'Test Spanner Set'").category_id, into.id);
});

test('an in-use category cannot be deleted, an empty one can', async () => {
  const filters = await findParent('Filters');
  const busy = await req('/api/stores/categories/' + filters.id, { method: 'DELETE' });
  assert.strictEqual(busy.status, 409);
  assert.match(busy.body.error, /Merge it into another/);

  const spare = await req('/api/stores/categories', { method: 'POST', body: { parent_id: filters.id, name: 'Disposable Sub' } });
  const gone = await req('/api/stores/categories/' + spare.body.id, { method: 'DELETE' });
  assert.strictEqual(gone.status, 200);
});

test('catalogue filters by category at either level', async () => {
  const filters = await findParent('Filters');
  const oil = filters.subs.find((s) => s.name === 'Oil Filter');
  run("UPDATE store_items SET item_no = 'FIL-9001' WHERE name = 'Test Oil Filter'");
  const byParent = await req('/api/stores/catalogue?category_id=' + filters.id);
  const bySub = await req('/api/stores/catalogue?category_id=' + oil.id);
  assert.ok(byParent.body.length >= bySub.body.length);
  assert.ok(bySub.body.every((r) => r.category_id === oil.id));
  assert.ok(bySub.body.some((r) => r.item_no === 'FIL-9001'));
  assert.strictEqual(bySub.body[0].parent_category, 'Filters');
});

test('an issue records the sub-category it was filed under', async () => {
  const p = await findParent('Electrical');
  const sub = p.subs.find((s) => s.name === 'Lights & Lamps');
  const job = run("INSERT INTO job_cards (job_no, type, description, status) VALUES ('T/1/R/1', 'repair', 'test', 'IN_PROGRESS')").lastInsertRowid;
  const r = await req('/api/stores/issues', { method: 'POST', body: { job_id: job, description: 'Head Lamp', qty: 2, unit_price: 500, category_id: sub.id } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.issue.category_id, sub.id);
  assert.strictEqual(r.body.issue.category, 'Electrical');
});
