'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-p4-ui-'));
process.env.DB_PATH = path.join(TMP, 'p4.db');
process.env.MULTIDB = '0';
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.NO_PORT = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, run, migrate } = require('../src/db');
migrate();

const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');

for (const r of ['admin', ...Object.keys(permissions.DEFAULT_MATRIX)]) {
  run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, 1, 1)', r, r);
}
permissions.seedDefaults();
capabilities.seedCapabilities();

run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('p4_viewer', 'P4 Plain Viewer', 0, 1)");

const PW = 'PhaseFour#2026!';
function mkUser(username, roleName) {
  const uid = run(
    'INSERT INTO users (username, full_name, password_hash, active) VALUES (?, ?, ?, 1)',
    username, username, auth.hashPassword(PW)
  ).lastInsertRowid;
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, roleName);
  return uid;
}

mkUser('p4_admin', 'admin');
mkUser('p4_nobody', 'p4_viewer');

const app = require('../src/server');
let server;
let port;
let adminCookie;
let nobodyCookie;

function rawReq(method, p, { headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          json,
          text,
          cookie: sc ? sc[0].split(';')[0] : null,
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
  adminCookie = (await rawReq('POST', '/api/auth/login', { body: { username: 'p4_admin', password: PW } })).cookie;
  nobodyCookie = (await rawReq('POST', '/api/auth/login', { body: { username: 'p4_nobody', password: PW } })).cookie;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('1. Fleet Profitability JSON tracks sealedCount & lastSealedAt before/after seal-period', async () => {
  const aId = run(
    "INSERT INTO assets (code, code_norm, ec_code, registration, type, status, in_register) VALUES ('VH-P4-01', 'VHP401', 'VH-P4-01', 'WP-8801', 'excavator', 'active', 1)"
  ).lastInsertRowid;
  run(
    "INSERT INTO tyre_battery_issues (kind, issue_date, vehicle, asset_id, qty, category, category_norm, unit_price, row_hash, store_id) VALUES ('battery', '2026-11-05', 'VH-P4-01', ?, 1, 'N70', 'N70', 32000, 'p4-tb-1', 1)",
    aId
  );

  const before = await rawReq('GET', '/api/fleet/finance/vehicle-profitability?year=2026&month=11', { cookie: adminCookie });
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.sealedCount, 0);
  assert.equal(before.json.lastSealedAt, null);

  const seal = await rawReq('POST', '/api/fleet/finance/seal-period', {
    cookie: adminCookie,
    body: { year: 2026, month: 11 },
  });
  assert.equal(seal.status, 200, seal.text);
  assert.ok(seal.json.sealedCount >= 1);

  const after = await rawReq('GET', '/api/fleet/finance/vehicle-profitability?year=2026&month=11', { cookie: adminCookie });
  assert.equal(after.status, 200, after.text);
  assert.ok(after.json.sealedCount >= 1);
  assert.ok(after.json.lastSealedAt);
});

test('2. Fleet Profitability Excel export streams valid XLSX workbook & enforces capability RBAC', async () => {
  const denied = await rawReq('GET', '/api/fleet/finance/vehicle-profitability.xlsx?year=2026&month=11', { cookie: nobodyCookie });
  assert.equal(denied.status, 403);

  const ok = await rawReq('GET', '/api/fleet/finance/vehicle-profitability.xlsx?year=2026&month=11', { cookie: adminCookie });
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['content-type'] || ''), /spreadsheetml\.sheet/);
  assert.match(String(ok.headers['content-disposition'] || ''), /attachment;\s*filename="fleet-profitability-2026-11\.xlsx"/);
  // ZIP / XLSX local file header starts with 'PK' (0x50, 0x4B)
  assert.equal(ok.raw[0], 0x50);
  assert.equal(ok.raw[1], 0x4b);
  assert.ok(ok.raw.length > 1000, 'XLSX workbook payload is non-trivial');
});

test('3. Static UI verification: zero alert() in modules + Phase 4 UI hooks wired', () => {
  const root = path.join(__dirname, '..');
  const modDir = path.join(root, 'public', 'modules');
  for (const file of fs.readdirSync(modDir)) {
    const src = fs.readFileSync(path.join(modDir, file), 'utf8');
    assert.equal(/\balert\(/.test(src), false, `Found blocking alert() in public/modules/${file}`);
  }

  const plJs = fs.readFileSync(path.join(modDir, 'fleet_profitability.js'), 'utf8');
  assert.match(plJs, /#btn_export_pl_csv/);
  assert.match(plJs, /\/api\/fleet\/finance\/vehicle-profitability\.xlsx/);
  assert.match(plJs, /#btn_seal_period/);
  assert.match(plJs, /\/fleet\/finance\/seal-period/);
  assert.doesNotMatch(plJs, /value="2025".*value="2026"/);

  const tanksJs = fs.readFileSync(path.join(modDir, 'fuel_tanks.js'), 'utf8');
  assert.match(tanksJs, /d\.cost_cents/);
  assert.match(tanksJs, /refill_cost/);

  const aliasesJs = fs.readFileSync(path.join(modDir, 'asset_aliases.js'), 'utf8');
  assert.match(aliasesJs, /#btn_alias_auto_suggest/);
  assert.match(aliasesJs, /\/aliases\/suggestions/);
  assert.match(aliasesJs, /\/aliases\/bulk-link/);

  const vdocJs = fs.readFileSync(path.join(modDir, 'vehicle_documents.js'), 'utf8');
  assert.match(vdocJs, /#btn_vdoc_bulk_import/);
  assert.match(vdocJs, /\/vehicle-documents\/bulk-import/);
});
