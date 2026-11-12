'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-store-test-'));
process.env.DB_PATH = path.join(TMP, 'fab_store.db');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const storeLocations = require('../src/lib/store_locations');
const stock = require('../src/lib/stock');
const app = require('../src/server');

let server;
let port;

function req(method, p, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json !== undefined ? json : buf,
          cookie: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; '),
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login(username, password = 'password123') {
  const res = await req('POST', '/api/auth/login', { body: { username, password } });
  assert.strictEqual(res.status, 200, `Login failed for ${username}`);
  return res.cookie;
}

let adminCookie;
let wsSkCookie;
let siteCookie;
let fabJobId;
let repairJobId;
let steelItemId;
let plateKey;

test.before(async () => {
  migrate();
  capabilities.seedCapabilities();
  storeLocations.seedStoreLocations();

  // Ensure workshop 2 and its site store exist
  run("INSERT OR IGNORE INTO workshops (id, code, name, is_default, active) VALUES (2, 'GWS', 'Galagedara', 0, 1)");
  run(`INSERT OR IGNORE INTO store_locations (id, code, name, store_type, parent_store_id, workshop_id, active)
       VALUES (3, 'SITE-STORE-GWS', 'Galagedara Site Store', 'SITE_STORE', 1, 2, 1)`);

  // Enable fabrication feature flag
  run("UPDATE settings SET value = '1' WHERE key = 'fabrication.enabled'");

  // Create roles
  for (const r of ['admin', 'storekeeper', 'viewer']) {
    run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', r, r);
  }
  const adminRoleId = get("SELECT id FROM roles WHERE name = 'admin'").id;
  const skRoleId = get("SELECT id FROM roles WHERE name = 'storekeeper'").id;

  // Grant capabilities to storekeeper role
  for (const cap of ['stores.issue', 'stores.issue_return', 'stores.view', 'stores.items', 'jobcards.view', 'jobcards.list']) {
    run('INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES (?, ?, 1)', 'storekeeper', cap);
  }

  // Password hash
  const hash = auth.hashPassword('password123');

  // 1. Admin user
  const adminId = run(`
    INSERT INTO users (username, password_hash, full_name, active, workshop_id)
    VALUES ('admin_usr', ?, 'Admin Master', 1, 1)
  `, hash).lastInsertRowid;
  run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", adminId, adminRoleId);

  // 2. Workshop storekeeper (Central Workshop, workshop_id = 1)
  const wsSkId = run(`
    INSERT INTO users (username, password_hash, full_name, active, workshop_id)
    VALUES ('ws_storekeeper', ?, 'Workshop Storekeeper', 1, 1)
  `, hash).lastInsertRowid;
  run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", wsSkId, skRoleId);
  // Workshop storekeeper has can_issue grant on Central Main Stores (1) and Main Workshop Stores (2)
  storeLocations.setUserStoreLocationAccess(wsSkId, 1, { can_view: 1, can_request: 1, can_issue: 1 }, { id: adminId });
  storeLocations.setUserStoreLocationAccess(wsSkId, 2, { can_view: 1, can_request: 1, can_issue: 1 }, { id: adminId });

  // 3. Site storekeeper (Galagedara Site Store, workshop_id = 2)
  const siteId = run(`
    INSERT INTO users (username, password_hash, full_name, active, workshop_id)
    VALUES ('site_storekeeper', ?, 'Site Storekeeper', 1, 2)
  `, hash).lastInsertRowid;
  run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", siteId, skRoleId);
  // Site storekeeper ONLY has access to Galagedara Site Store (3), NOT Central Main Stores (1)
  storeLocations.setUserStoreLocationAccess(siteId, 3, { can_view: 1, can_request: 1, can_issue: 1 }, { id: adminId });
  storeLocations.setUserStoreLocationAccess(siteId, 1, { can_view: 1, can_request: 1, can_issue: 0 }, { id: adminId });

  // Seed inventory: Steel Plate 10mm
  const insItem = run(`
    INSERT INTO store_items (name, category, unit, rack, is_general, balance, unit_cost)
    VALUES ('Steel Plate 10mm', 'Fabrication Materials', 'nos', 'FAB-01', 1, 100, 4500)
  `);
  steelItemId = insItem.lastInsertRowid;

  plateKey = stock.itemKey('general', 'Steel Plate 10mm');
  // Add stock movement for initial 100 plates in Central Main Stores (physical_store_id = 1)
  run(`
    INSERT INTO stock_moves (section, kind, item_key, item_name, qty, unit_price, txn_date, source_table, source_id, counts, store_id, physical_store_id)
    VALUES ('general', 'in', ?, 'Steel Plate 10mm', 100, 4500, date('now'), 'opening', 1, 1, 1, 1)
  `, plateKey);
  // And 0 plates in Main Workshop Stores (physical_store_id = 2)

  // Seed job cards:
  // 1. Fabrication job card (numbered 2026/11/F/001)
  const insFab = run(`
    INSERT INTO job_cards (job_no, type, fabrication_kind, issue_store_location_id, workshop_id, status, description)
    VALUES ('2026/11/F/001', 'fabrication', 'new', 1, 1, 'IN_PROGRESS', 'Fabricate Flatbed Body')
  `);
  fabJobId = insFab.lastInsertRowid;

  // 2. Normal repair job card
  const insRepair = run(`
    INSERT INTO job_cards (job_no, type, workshop_id, status, description)
    VALUES ('2026/11/R/001', 'repair', 1, 'IN_PROGRESS', 'Engine Repair')
  `);
  repairJobId = insRepair.lastInsertRowid;

  // Start HTTP server
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  adminCookie = await login('admin_usr');
  wsSkCookie = await login('ws_storekeeper');
  siteCookie = await login('site_storekeeper');
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test('Stores forEntry returns issue_store_location_id (1) for fabrication card', () => {
  const stores = require('../src/lib/stores');
  const fabStore = stores.forEntry({ id: 1 }, fabJobId);
  assert.strictEqual(fabStore, 1, 'forEntry on fabrication card must return issue_store_location_id (1)');

  const repairStore = stores.forEntry({ id: 1 }, repairJobId);
  assert.strictEqual(repairStore, 1, 'forEntry on repair card returns workshop store (1)');
});

test('Workshop storekeeper can issue materials from Central Main Stores for a fabrication job card', async () => {
  const initialBalMs = stock.balanceOf('general', plateKey, { physical_store_id: 1 });
  const initialBalWs = stock.balanceOf('general', plateKey, { physical_store_id: 2 });
  assert.strictEqual(initialBalMs, 100, 'Initial Main Stores balance should be 100');
  assert.strictEqual(initialBalWs, 0, 'Initial Main Workshop Stores balance should be 0');

  // Issue 5 steel plates to the fabrication card
  const res = await req('POST', '/api/stores/issues', {
    cookie: wsSkCookie,
    body: {
      job_id: fabJobId,
      store_item_id: steelItemId,
      description: 'Steel Plate 10mm',
      qty: 5,
      unit_price: 4500,
    }
  });

  assert.strictEqual(res.status, 201, `Issue creation failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.issue.physical_store_id, 1, 'Issue physical_store_id must be Central Main Stores (1)');
  assert.strictEqual(res.body.issue.job_id, fabJobId);

  // Check balances
  const afterBalMs = stock.balanceOf('general', plateKey, { physical_store_id: 1 });
  const afterBalWs = stock.balanceOf('general', plateKey, { physical_store_id: 2 });

  assert.strictEqual(afterBalMs, 95, 'Central Main Stores balance must be deducted (100 -> 95)');
  assert.strictEqual(afterBalWs, 0, 'Main Workshop Stores balance must NOT be changed (remains 0)');
});

test('Workshop storekeeper CANNOT issue a general issue without a job from Central Main Stores', async () => {
  const res = await req('POST', '/api/stores/min', {
    cookie: wsSkCookie,
    body: {
      physical_store_id: 1, // Central Main Stores
      items: [
        { store_item_id: steelItemId, description: 'Steel Plate 10mm', qty: 2 }
      ],
      purpose: 'General Issue without Job'
    }
  });

  assert.strictEqual(res.status, 403, 'General issue from Central Main Stores by workshop storekeeper must be rejected with 403');
  assert.ok(String(res.body.error).includes('Central Main Stores'), 'Error must mention Central Main Stores restriction');
});

test('Site storekeeper CANNOT issue materials for a fabrication job card from Central Main Stores', async () => {
  const res = await req('POST', '/api/stores/issues', {
    cookie: siteCookie,
    body: {
      job_id: fabJobId,
      store_item_id: steelItemId,
      description: 'Steel Plate 10mm',
      qty: 2,
      unit_price: 4500,
    }
  });

  assert.strictEqual(res.status, 403, 'Site user must be refused when issuing to main workshop fabrication card');
});

test('Issuing more than available stock in Central Main Stores is refused with 409', async () => {
  const currentBal = stock.balanceOf('general', plateKey, { physical_store_id: 1 });
  assert.strictEqual(currentBal, 95);

  const res = await req('POST', '/api/stores/issues', {
    cookie: wsSkCookie,
    body: {
      job_id: fabJobId,
      store_item_id: steelItemId,
      description: 'Steel Plate 10mm',
      qty: 200, // exceeds 95!
      unit_price: 4500,
    }
  });

  assert.strictEqual(res.status, 409, `Excess issue must be rejected with 409: ${JSON.stringify(res.body)}`);
  assert.ok(String(res.body.error).includes('not enough stock'), 'Error must mention insufficient stock');
});

test('Reversal (issue return) returns stock to Central Main Stores', async () => {
  // Find the issue created in test 2
  const issue = get('SELECT id, qty FROM issues WHERE job_id = ? ORDER BY id DESC LIMIT 1', fabJobId);
  assert.ok(issue, 'Must find issue to reverse');

  const balBefore = stock.balanceOf('general', plateKey, { physical_store_id: 1 });
  assert.strictEqual(balBefore, 95);

  const res = await req('POST', `/api/stores/issues/${issue.id}/return`, {
    cookie: wsSkCookie,
    body: {
      qty: 3,
      note: 'Returning 3 unused plates to Central Main Stores'
    }
  });

  assert.strictEqual(res.status, 201, `Return failed: ${JSON.stringify(res.body)}`);

  // Check balance in Central Main Stores
  const balAfterMs = stock.balanceOf('general', plateKey, { physical_store_id: 1 });
  const balAfterWs = stock.balanceOf('general', plateKey, { physical_store_id: 2 });

  assert.strictEqual(balAfterMs, 98, 'Central Main Stores balance must increase (95 + 3 = 98)');
  assert.strictEqual(balAfterWs, 0, 'Main Workshop Stores balance must NOT be affected (remains 0)');
});
