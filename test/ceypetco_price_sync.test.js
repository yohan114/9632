'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-ceypetco-sync-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.CEYPETCO_SYNC_ENABLED = 'true';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const ceypetcoSync = require('../src/lib/fuel/ceypetco_sync');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;
let viewerCookie;

const SAMPLE_ACTIVE_API = {
  success: true,
  data: [
    {
      product: 'Lanka Auto Diesel',
      price: 397,
      effectiveDate: '2026-11-02T00:00:00.000Z',
      status: 'active',
    },
    {
      product: 'Lanka Super Diesel 4 Star Euro 4',
      price: 543,
      effectiveDate: '2026-11-02T00:00:00.000Z',
      status: 'active',
    },
    {
      product: 'Lanka Petrol 92 Octane',
      price: 424,
      effectiveDate: '2026-11-02T00:00:00.000Z',
      status: 'active',
    },
    {
      product: 'Lanka Petrol 95 Octane Euro 4',
      price: 490,
      effectiveDate: '2026-11-02T00:00:00.000Z',
      status: 'active',
    },
    {
      product: 'Lanka Kerosene',
      price: 285,
      effectiveDate: '2026-05-30T00:00:00.000Z',
      status: 'active',
    },
    {
      product: 'Lanka Industrial Kerosene',
      price: 382,
      effectiveDate: '2026-07-01T00:00:00.000Z',
      status: 'active',
    },
    {
      product: 'Lanka Fuel Oil 1500 Sec. · High Sulphur',
      price: 332,
      effectiveDate: '2026-04-01T00:00:00.000Z',
      status: 'active',
    },
  ],
};

const SAMPLE_HISTORICAL_API = {
  success: true,
  data: [
    { kind: 'bitumen', dateLabel: '2021.01.05', sortKey: 20210105, values: ['79.00', '79.00', ''] },
    {
      kind: 'fuel',
      dateLabel: '01.10.2026',
      sortKey: 20261001,
      values: ['475', '414', '392', '528', '285', '382', '322', '322', '322'],
    },
    {
      kind: 'fuel',
      dateLabel: '02.11.2026',
      sortKey: 20261102,
      values: ['490', '424', '397', '543', '285', '382', '322', '322', '322'],
    },
  ],
};

const SAMPLE_LEGACY_HTML = `
  <table>
    <thead>
      <tr>
        <th>Effective Date</th>
        <th>LP 95</th>
        <th>LP 92</th>
        <th>LAD</th>
        <th>LSD</th>
        <th>LK</th>
        <th>LIK</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>02.11.2026</td>
        <td>Rs. 490.00</td>
        <td>Rs. 424.00</td>
        <td>Rs. 397.00</td>
        <td>Rs. 543.00</td>
        <td>Rs. 285.00</td>
        <td>Rs. 382.00</td>
      </tr>
    </tbody>
  </table>
`;

async function reqJson(urlPath, { method = 'GET', body = null, cookie = adminCookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, headers: res.headers, body: json };
}

async function loginAs(username, password) {
  const res = await reqJson('/api/auth/login', {
    method: 'POST',
    cookie: null,
    body: { username, password },
  });
  assert.equal(res.status, 200, `Login failed for ${username}: ${JSON.stringify(res.body)}`);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, `Missing set-cookie for ${username}`);
  return setCookie.split(';')[0];
}

test('Setup fresh database & auth fixtures', async () => {
  migrate();
  capabilities.seedCapabilities();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  run("INSERT INTO roles (id, name, label, is_system, active) VALUES (58, 'fuel_viewer', 'Fuel Viewer', 0, 1)");
  for (const cap of ['fuel.view', 'fuel.prices.view']) {
    run("INSERT OR REPLACE INTO role_capabilities (role, capability, granted) VALUES ('fuel_viewer', ?, 1)", cap);
  }
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('fuel_viewer', 'fuel', 'view')");
  run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('fuel_viewer', 'fuel_prices', 'view')");

  const pwHash = auth.hashPassword('TestPass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin_sync', ?, 'Admin Sync', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (1, ?)', adminRole.id);
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (2, 'viewer_sync', ?, 'Viewer Sync', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (2, 58)');

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  adminCookie = await loginAs('admin_sync', 'TestPass#2026!');
  viewerCookie = await loginAs('viewer_sync', 'TestPass#2026!');
});

test('Parsers map official Ceypetco products cleanly and exclude Industrial Kerosene', () => {
  const active = ceypetcoSync.parseCeypetcoActiveApi(SAMPLE_ACTIVE_API);
  assert.equal(active.source, 'api_active');
  const activeMap = Object.fromEntries(active.items.map((i) => [i.code, i]));
  assert.equal(Object.keys(activeMap).length, 5);
  assert.equal(activeMap.AUTO_DIESEL.priceCents, 39700);
  assert.equal(activeMap.AUTO_DIESEL.effectiveDate, '2026-11-02');
  assert.equal(activeMap.SUPER_DIESEL.priceCents, 54300);
  assert.equal(activeMap.PETROL_92.priceCents, 42400);
  assert.equal(activeMap.PETROL_95.priceCents, 49000);
  assert.equal(activeMap.KEROSENE.priceCents, 28500); // not 38200 (Industrial Kerosene)
  assert.equal(activeMap.KEROSENE.effectiveDate, '2026-05-30');

  const hist = ceypetcoSync.parseCeypetcoHistoricalApi(SAMPLE_HISTORICAL_API);
  assert.equal(hist.source, 'api_historical');
  const histMap = Object.fromEntries(hist.items.map((i) => [i.code, i]));
  assert.equal(histMap.PETROL_95.priceCents, 49000);
  assert.equal(histMap.PETROL_92.priceCents, 42400);
  assert.equal(histMap.AUTO_DIESEL.priceCents, 39700);
  assert.equal(histMap.SUPER_DIESEL.priceCents, 54300);
  assert.equal(histMap.KEROSENE.priceCents, 28500);
  assert.equal(histMap.AUTO_DIESEL.effectiveDate, '2026-11-02');

  const html = ceypetcoSync.parseCeypetcoHtmlPrices(SAMPLE_LEGACY_HTML);
  assert.equal(html.source, 'html_table');
  const htmlMap = Object.fromEntries(html.items.map((i) => [i.code, i]));
  assert.equal(htmlMap.AUTO_DIESEL.priceCents, 39700);
  assert.equal(htmlMap.KEROSENE.priceCents, 28500); // LIK 382 ignored
  assert.equal(htmlMap.AUTO_DIESEL.effectiveDate, '2026-11-02');
});

test('fetchCeypetcoPrices falls back from api_active -> api_historical -> html_table', async () => {
  const calls1 = [];
  const resHist = await ceypetcoSync.fetchCeypetcoPrices({
    fetchImpl: async (url) => {
      calls1.push(url);
      if (url.includes('fuel-prices/active')) {
        return { ok: false, status: 503 };
      }
      if (url.includes('historical-prices/active')) {
        return { ok: true, status: 200, json: async () => SAMPLE_HISTORICAL_API };
      }
      throw new Error('unexpected url ' + url);
    },
  });
  assert.equal(calls1.length, 2);
  assert.equal(resHist.source, 'api_historical');
  assert.equal(resHist.items.find((i) => i.code === 'AUTO_DIESEL').priceCents, 39700);

  const calls2 = [];
  const resHtml = await ceypetcoSync.fetchCeypetcoPrices({
    fetchImpl: async (url) => {
      calls2.push(url);
      if (url.includes('api.ceypetco.gov.lk')) {
        return { ok: false, status: 404 };
      }
      return { ok: true, status: 200, text: async () => SAMPLE_LEGACY_HTML };
    },
  });
  assert.equal(calls2.length, 3);
  assert.equal(resHtml.source, 'html_table');
  assert.equal(resHtml.items.find((i) => i.code === 'AUTO_DIESEL').priceCents, 39700);
});

test('syncCeypetcoPrices is idempotent, preserves manual overrides, avoids back-dated clutter, and logs changes', async () => {
  // Seed Oct 1 auto-fetched prices including KEROSENE 28500 (newer than active API KEROSENE effectiveDate 2026-05-30)
  for (const [code, cents] of [
    ['AUTO_DIESEL', 39200],
    ['SUPER_DIESEL', 52800],
    ['PETROL_92', 41400],
    ['PETROL_95', 47500],
    ['KEROSENE', 28500],
  ]) {
    run(`
      INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, source)
      VALUES (?, ?, ?, ?, '2026-10-01', 'Auto-fetched from ceypetco.gov.lk', 'Auto-fetched from ceypetco.gov.lk')
    `, code, code, cents, cents / 100);
  }

  // Seed a manual override for SUPER_DIESEL on 2026-11-02 (550.00 Rs) -> must NOT be overwritten
  run(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, source, created_by, entered_by)
    VALUES ('SUPER_DIESEL', 'SUPER_DIESEL', 55000, 550.0, '2026-11-02', 'Manual override', 'Manual Tariff Update', 1, '1')
  `);

  // Seed an auto-fetched row for PETROL_92 on 2026-11-02 with stale value (420.00 Rs) -> MUST be updated to 424.00
  run(`
    INSERT INTO fuel_prices (fuel_type, fuel_kind, price_per_litre_cents, price_per_litre, effective_date, notes, source)
    VALUES ('PETROL_92', 'PETROL_92', 42000, 420.0, '2026-11-02', 'Auto-fetched from ceypetco.gov.lk', 'CEYPETCO_AUTO')
  `);

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => SAMPLE_ACTIVE_API,
  });

  const auditBefore = get("SELECT COUNT(*) n FROM audit_log WHERE entity = 'fuel_price' AND action = 'fuel.price.synced'").n;
  const first = await ceypetcoSync.syncCeypetcoPrices({ trigger: 'test', fetchImpl: mockFetch });
  assert.equal(first.source, 'api_active');
  assert.equal(first.changed, true);

  // Stored: AUTO_DIESEL and PETROL_95 on 2026-11-02
  assert.deepEqual(first.stored.map((s) => s.code).sort(), ['AUTO_DIESEL', 'PETROL_95']);
  // Updated: PETROL_92 (42000 -> 42400)
  assert.deepEqual(first.updated.map((u) => u.code), ['PETROL_92']);
  // Manual override preserved
  assert.deepEqual(first.skippedManual.map((m) => m.code), ['SUPER_DIESEL']);
  // Older identical KEROSENE (2026-05-30 vs 2026-10-01) skipped as unchanged without inserting clutter
  const keroRows = all("SELECT effective_date FROM fuel_prices WHERE fuel_type = 'KEROSENE'");
  assert.equal(keroRows.length, 1);
  assert.equal(keroRows[0].effective_date, '2026-10-01');

  const dieselRow = get("SELECT price_per_litre_cents, source FROM fuel_prices WHERE fuel_type = 'AUTO_DIESEL' AND effective_date = '2026-11-02'");
  assert.equal(dieselRow.price_per_litre_cents, 39700);
  assert.equal(dieselRow.source, 'CEYPETCO_AUTO');

  const superRow = get("SELECT price_per_litre_cents, source FROM fuel_prices WHERE fuel_type = 'SUPER_DIESEL' AND effective_date = '2026-11-02'");
  assert.equal(superRow.price_per_litre_cents, 55000);

  const p92Row = get("SELECT price_per_litre_cents FROM fuel_prices WHERE fuel_type = 'PETROL_92' AND effective_date = '2026-11-02'");
  assert.equal(p92Row.price_per_litre_cents, 42400);

  const auditAfterFirst = get("SELECT COUNT(*) n FROM audit_log WHERE entity = 'fuel_price' AND action = 'fuel.price.synced'").n;
  assert.equal(auditAfterFirst, auditBefore + 1);

  const status = ceypetcoSync.getSyncStatus();
  assert.equal(status.lastSyncStatus, 'ok');
  assert.equal(status.lastSyncSource, 'api_active');
  assert.ok(status.lastSyncAt);

  // Repeat sync is idempotent and does NOT emit another audit log row
  const second = await ceypetcoSync.syncCeypetcoPrices({ trigger: 'test', fetchImpl: mockFetch });
  assert.equal(second.changed, false);
  assert.equal(second.stored.length, 0);
  assert.equal(second.updated.length, 0);
  assert.equal(second.skippedManual.length, 1);
  const auditAfterSecond = get("SELECT COUNT(*) n FROM audit_log WHERE entity = 'fuel_price' AND action = 'fuel.price.synced'").n;
  assert.equal(auditAfterSecond, auditAfterFirst);
});

test('HTTP routes enforce permissions and expose ceypetcoSync status & prices', async () => {
  // Viewer cannot trigger POST /api/fuel/prices/sync
  const denied = await reqJson('/api/fuel/prices/sync', { method: 'POST', cookie: viewerCookie, body: {} });
  assert.equal(denied.status, 403);

  // GET /api/fuel/prices exposes ceypetcoSync & creator_name fallback
  const pricesRes = await reqJson('/api/fuel/prices');
  assert.equal(pricesRes.status, 200);
  assert.ok(pricesRes.body.ceypetcoSync);
  assert.equal(pricesRes.body.ceypetcoSync.lastSyncStatus, 'ok');
  assert.equal(pricesRes.body.activePrices.AUTO_DIESEL.pricePerLitreCents, 39700);
  const novDiesel = pricesRes.body.prices.find((p) => p.fuel_type === 'AUTO_DIESEL' && p.effective_date === '2026-11-02');
  assert.equal(novDiesel.creator_name, 'Ceypetco Auto-Sync');

  // GET /api/fuel/stats exposes ceypetcoSync status & active Auto Diesel price
  const statsRes = await reqJson('/api/fuel/stats');
  assert.equal(statsRes.status, 200);
  assert.ok(statsRes.body.ceypetcoSync);
  assert.equal(statsRes.body.ceypetcoSync.lastSyncStatus, 'ok');
  assert.equal(statsRes.body.currentDieselCents, 39700);

  // Admin can trigger POST /api/fuel/prices/sync (stubbing global.fetch so test stays offline/hermetic)
  const origFetch = global.fetch;
  const newPayload = {
    success: true,
    data: [
      { product: 'Lanka Auto Diesel', price: 401, effectiveDate: '2026-11-24T00:00:00.000Z', status: 'active' },
      { product: 'Lanka Petrol 92 Octane', price: 429, effectiveDate: '2026-11-24T00:00:00.000Z', status: 'active' },
    ],
  };
  global.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return origFetch(url, opts);
    return { ok: true, status: 200, json: async () => newPayload };
  };
  try {
    const syncRes = await reqJson('/api/fuel/prices/sync', { method: 'POST', cookie: adminCookie, body: {} });
    assert.equal(syncRes.status, 200, `Expected 200, got ${syncRes.status}: ${JSON.stringify(syncRes.body)}`);
    assert.equal(syncRes.body.success, true);
    assert.equal(syncRes.body.changed, true);
    assert.equal(syncRes.body.activePrices.AUTO_DIESEL.pricePerLitreCents, 40100);
    assert.equal(syncRes.body.activePrices.AUTO_DIESEL.effectiveDate, '2026-11-24');
  } finally {
    global.fetch = origFetch;
  }
});

test.after(async () => {
  ceypetcoSync.stopScheduler();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
