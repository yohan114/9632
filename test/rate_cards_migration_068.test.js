'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mig068-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const mig068 = require('../src/migrate/068_rate_cards_km_sync_and_asset_rates');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;

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

test('Setup fixture DB mirroring hourly-stuck KM vehicles, 3 misclassified machines & 10 target assets', async () => {
  migrate();
  capabilities.seedCapabilities();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (38, 'CEP03', 'Galagedara Site', 'galagedara site', 1)");

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, model_no, asset_class, meter_type, current_project_id, status, in_register, created_at, updated_at)
    VALUES
      (297, 'DT-53', 'DT53', 'LO-7183', 'TATA', 'Dump Truck', 'LPK1615TC', 'vehicle', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (299, 'DT-55', 'DT55', 'LO-7182', 'TATA', 'Dump Truck', 'LPK1615TC', 'vehicle', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (799, 'LO-4925', 'LO4925', NULL, NULL, NULL, NULL, 'vehicle', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (1443, 'LO-4625', 'LO4625', 'LO-4625', NULL, 'Tipper', NULL, 'vehicle', 'KM', 38, 'active', 1, datetime('now'), datetime('now')),
      (220, 'DC-20', 'DC20', 'PH-0765', 'MITSUBISHI', 'Double Cab', NULL, 'vehicle', 'KM', 38, 'active', 1, datetime('now'), datetime('now')),
      (250, 'SC-10', 'SC10', 'DAH-2228', 'MAHINDRA', 'Single Cab', NULL, 'vehicle', 'KM', 38, 'active', 1, datetime('now'), datetime('now')),
      (341, 'DB-02', 'DB02', '68-5115', 'ISUZU', 'DIESEL BOUSER', '207 DI', 'machine', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (1178, '3 ton roller', '3TONROLLER', NULL, NULL, NULL, NULL, 'machine', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (1469, 'COMPRESHOR AC 01', 'COMPRESHORAC01', 'compreshor AC 01', NULL, 'Vehicle', NULL, 'machine', 'KM', 38, 'active', 1, datetime('now'), datetime('now')),
      (1368, 'DAI-9757', 'DAI9757', 'Badalgama Plant', 'Bolero', 'Mahindra', NULL, 'vehicle', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (1609, 'DAI-9762', 'DAI9762', NULL, 'Quick Added', 'Other Asset', NULL, 'vehicle', 'KM', 38, 'active', 1, datetime('now'), datetime('now')),
      (1612, 'DAI-9770', 'DAI9770', NULL, 'Quick Added', 'Other Asset', NULL, 'vehicle', 'KM', 38, 'active', 1, datetime('now'), datetime('now')),
      (1316, 'WG-08', 'WG08', NULL, NULL, NULL, NULL, 'generator', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (1330, 'WG-13', 'WG13', NULL, NULL, NULL, NULL, 'generator', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (1086, 'GE-11', 'GE11', NULL, NULL, NULL, NULL, 'generator', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (429, 'GE-69', 'GE69', NULL, NULL, NULL, NULL, 'generator', NULL, 38, 'active', 1, datetime('now'), datetime('now')),
      (454, 'GE-117', 'GE117', NULL, NULL, NULL, NULL, 'generator', NULL, 38, 'active', 1, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, fully_wet_rate_cents,
      km_dry_cents, km_wet_cents, km_fw_cents, hr_dry_cents, hr_wet_cents, hr_fw_cents,
      port_dd_cents, port_dw_cents, min_bill_hours, equip_type, default_basis,
      fuel_cons_basis, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, source_label, note
    ) VALUES
      ('r-dt53', 297, 'Dump Truck (Tipper)', 'HOURLY', 155000, 155000, 235000, 325000, 9500, 12000, 23000, 155000, 235000, 325000, NULL, NULL, 0, 'FLEET', 'WET', 'km', 0.169, 0.217, 0.270, 'DT-53', 'DT-53'),
      ('r-dt55', 299, 'Dump Truck (Tipper)', 'HOURLY', 155000, 155000, 235000, 325000, 9500, 12000, 23000, 155000, 235000, 325000, NULL, NULL, 0, 'FLEET', 'WET', 'km', 0.169, 0.217, 0.270, 'DT-55', 'DT-55'),
      ('r-lo4925', 799, 'Dump Truck (Tipper)', 'HOURLY', 155000, 155000, 235000, 325000, 9500, 12000, 23000, NULL, NULL, NULL, NULL, NULL, 0, 'FLEET', 'WET', NULL, NULL, NULL, NULL, 'LO-4925', 'LO-4925'),
      ('r-lo4625', 1443, NULL, 'KM', 12000, 0, 12000, NULL, NULL, 12000, NULL, NULL, NULL, NULL, NULL, NULL, 0, 'FLEET', 'DRY', NULL, NULL, NULL, NULL, 'LO-4625', 'Manual'),
      ('r-dc20', 220, 'Double Cab (Pickup)', 'HOURLY', 87000, 87000, 161000, 161000, 4500, 7000, 11000, 87000, 161000, 161000, NULL, NULL, 0, 'FLEET', 'WET', 'km', 0.08, 0.1, 0.125, 'DC-20', 'DC-20'),
      ('r-sc10', 250, 'Single Cab', 'HOURLY', 60000, 60000, 106000, 106000, 4500, 7000, 11000, 60000, 106000, 106000, NULL, NULL, 0, 'FLEET', 'WET', 'km', 0.07, 0.09, 0.11, 'SC-10', 'SC-10'),
      ('r-db02-hr', 341, 'Diesel Bowser', 'HOURLY', 78000, 78000, 142000, 142000, NULL, NULL, NULL, 78000, 142000, 142000, NULL, NULL, 0, 'FLEET', 'WET', 'hr', 3.6, 5.0, 6.8, 'DB-02 hr', 'DB-02 hr'),
      ('r-db02-km', 341, 'Bitumen Bowser', 'KM', 4500, 4500, 7000, 11000, 4500, 7000, 11000, NULL, NULL, NULL, NULL, NULL, 0, 'FLEET', 'DRY', NULL, NULL, NULL, NULL, 'DB-02 km', 'Spurious km'),
      ('r-roller', 1178, 'Double Cab (Pickup)', 'HOURLY', 87000, 87000, 161000, 161000, 4500, 7000, 11000, 87000, 161000, 161000, NULL, NULL, 0, 'FLEET', 'DRY', NULL, NULL, NULL, NULL, 'roller', 'roller'),
      ('r-comp', 1469, 'Double Cab (Pickup)', 'HOURLY', 87000, 87000, 161000, 161000, 4500, 7000, 11000, 87000, 161000, 161000, NULL, NULL, 0, 'FLEET', 'DRY', NULL, NULL, NULL, NULL, 'comp', 'comp'),
      ('r-wg08', 1316, 'Generator', 'DAILY', 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, 650000, 950000, 0, 'PORTABLE', 'DRY', NULL, NULL, NULL, NULL, 'WG-08', 'WG-08'),
      ('r-wg13', 1330, 'Workshop Plant / Equipment', 'DAILY', 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, 650000, 950000, 0, 'PORTABLE', 'DRY', NULL, NULL, NULL, NULL, 'WG-13', 'WG-13'),
      ('r-ge11', 1086, NULL, 'DAILY', 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, 600000, 1200000, 0, 'PORTABLE', 'DRY', NULL, NULL, NULL, NULL, 'GE-11', 'GE-11'),
      ('r-ge69', 429, NULL, 'DAILY', 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, 600000, 1200000, 0, 'PORTABLE', 'DRY', NULL, NULL, NULL, NULL, 'GE-69', 'GE-69')
  `);

  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  const hash = auth.hashPassword('Mig068Pass#2026!');
  run("INSERT INTO users (id, username, full_name, password_hash, active, must_change_password) VALUES (1, 'admin068', 'Admin User', ?, 1, 0)", hash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (1, ?)', adminRole.id);

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const login = await reqJson('/api/auth/login', {
    method: 'POST',
    cookie: null,
    body: { username: 'admin068', password: 'Mig068Pass#2026!' },
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('Migration 068 fixes hourly-stuck KM vehicles, misclassified machinery, and 10 asset rates idempotently', async () => {
  const res1 = mig068.runMigration(rawDb);
  assert.equal(res1.misclassifiedFixed, 3);
  assert.equal(res1.kmSynced, 6); // DT-53, DT-55, LO-4925, LO-4625 (fuel_cons_basis NULL->km), DC-20, SC-10
  assert.equal(res1.singleCabsUpserted, 3);
  assert.equal(res1.weldingUpserted, 2);
  assert.equal(res1.generatorsUpserted, 3);

  // Check hourly-stuck KM vehicles synced and hourly tiers preserved
  for (const code of ['DT-53', 'DT-55', 'LO-4925']) {
    const r = get('SELECT r.*, a.meter_type FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', code);
    assert.equal(r.rate_basis, 'KM', `${code} rate_basis`);
    assert.equal(r.fuel_cons_basis, 'km', `${code} fuel_cons_basis`);
    assert.equal(r.dry_rate_cents, 9500);
    assert.equal(r.wet_rate_cents, 12000);
    assert.equal(r.fully_wet_rate_cents, 23000);
    assert.equal(r.meter_type, 'KM');
  }
  const lo4925 = get('SELECT r.* FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', 'LO-4925');
  assert.equal(lo4925.hr_dry_cents, 155000);
  assert.equal(lo4925.hr_wet_cents, 235000);
  assert.equal(lo4925.hr_fw_cents, 325000);

  // Manual tipper LO-4625 keeps 0 Dry and 120 Wet
  const lo4625 = get('SELECT r.* FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', 'LO-4625');
  assert.equal(lo4625.rate_basis, 'KM');
  assert.equal(lo4625.fuel_cons_basis, 'km');
  assert.equal(lo4625.dry_rate_cents, 0);
  assert.equal(lo4625.wet_rate_cents, 12000);

  // 3 misclassified machines
  const db02Rows = all('SELECT r.*, a.meter_type FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', 'DB-02');
  assert.equal(db02Rows.length, 1);
  assert.equal(db02Rows[0].category_name, 'Diesel Bowser');
  assert.equal(db02Rows[0].rate_basis, 'HOURLY');
  assert.equal(db02Rows[0].meter_type, 'HOURS');

  const roller = get('SELECT r.*, a.type, a.meter_type FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', '3 ton roller');
  assert.equal(roller.category_name, 'Vibrating Roller');
  assert.equal(roller.rate_basis, 'HOURLY');
  assert.equal(roller.fuel_cons_basis, 'hr');
  assert.equal(roller.dry_rate_cents, 113000);
  assert.equal(roller.wet_rate_cents, 226000);
  assert.equal(roller.km_wet_cents, null);
  assert.equal(roller.type, 'Vibrating Roller');
  assert.equal(roller.meter_type, 'HOURS');

  const comp = get('SELECT r.*, a.type, a.meter_type FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', 'COMPRESHOR AC 01');
  assert.equal(comp.equip_type, 'PORTABLE');
  assert.equal(comp.category_name, 'Air Compressor');
  assert.equal(comp.rate_basis, 'DAILY');
  assert.equal(comp.dry_rate_cents, 450000);
  assert.equal(comp.wet_rate_cents, 650000);
  assert.equal(comp.port_dd_cents, 450000);
  assert.equal(comp.port_dw_cents, 650000);
  assert.equal(comp.km_wet_cents, null);
  assert.equal(comp.type, 'Air Compressor');
  assert.equal(comp.meter_type, 'HOURS');

  // 3 Single Cabs
  for (const code of ['DAI-9757', 'DAI-9762', 'DAI-9770']) {
    const r = get('SELECT r.*, a.type, a.brand, a.model_no, a.meter_type FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', code);
    assert.equal(r.category_name, 'Single Cab');
    assert.equal(r.rate_basis, 'KM');
    assert.equal(r.fuel_cons_basis, 'km');
    assert.equal(r.dry_rate_cents, 4500);
    assert.equal(r.wet_rate_cents, 7000);
    assert.equal(r.fully_wet_rate_cents, 11000);
    assert.equal(r.type, 'Single Cab');
    assert.equal(r.meter_type, 'KM');
  }
  const dai9757Asset = get("SELECT brand, model_no FROM assets WHERE code = 'DAI-9757'");
  assert.equal(dai9757Asset.brand, 'Mahindra');
  assert.equal(dai9757Asset.model_no, 'Bolero');

  // Welding & Generators
  for (const code of ['WG-08', 'WG-13']) {
    const r = get('SELECT * FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', code);
    assert.equal(r.equip_type, 'PORTABLE');
    assert.equal(r.category_name, 'Welding Plant');
    assert.equal(r.dry_rate_cents, 650000);
    assert.equal(r.wet_rate_cents, 950000);
    assert.equal(r.port_dd_cents, 650000);
    assert.equal(r.port_dw_cents, 950000);
  }
  for (const code of ['GE-11', 'GE-69']) {
    const r = get('SELECT * FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', code);
    assert.equal(r.equip_type, 'PORTABLE');
    assert.equal(r.dry_rate_cents, 600000);
    assert.equal(r.wet_rate_cents, 1200000);
    assert.equal(r.port_dd_cents, 600000);
    assert.equal(r.port_dw_cents, 1200000);
  }
  const ge117 = get('SELECT * FROM fleet_rental_rates r JOIN assets a ON a.id = r.asset_id WHERE a.code = ?', 'GE-117');
  assert.equal(ge117.equip_type, 'PORTABLE');
  assert.equal(ge117.dry_rate_cents, 350000);
  assert.equal(ge117.wet_rate_cents, 700000);
  assert.equal(ge117.port_dd_cents, 350000);
  assert.equal(ge117.port_dw_cents, 700000);

  // Idempotency: second run makes zero changes and keeps identical counts
  const res2 = mig068.runMigration(rawDb);
  assert.equal(res2.misclassifiedFixed, 0);
  assert.equal(res2.kmSynced, 0);
  assert.equal(res2.singleCabsUpserted, 0);
  assert.equal(res2.weldingUpserted, 0);
  assert.equal(res2.generatorsUpserted, 0);
  assert.equal(res2.portableSynced, 0);

  // API /hire/rates-overview verification
  const ov = await reqJson('/api/hire/rates-overview');
  assert.equal(ov.status, 200);
  const kmCodes = new Set((ov.body.vehicles_km || []).map((x) => x.asset_code));
  for (const c of ['DAI-9757', 'DAI-9762', 'DAI-9770', 'DT-53', 'DT-55', 'LO-4925', 'DC-20', 'SC-10']) {
    assert.ok(kmCodes.has(c), `${c} should appear in vehicles_km`);
  }
  for (const c of ['DB-02', '3 ton roller', 'COMPRESHOR AC 01']) {
    assert.ok(!kmCodes.has(c), `${c} must NOT appear in vehicles_km`);
  }
  const portByCode = new Map((ov.body.portable || []).filter((p) => p.asset_code).map((p) => [p.asset_code, p]));
  assert.equal(portByCode.get('GE-117').port_dw_cents, 700000);
  assert.equal(portByCode.get('WG-08').port_dd_cents, 650000);
  assert.equal(portByCode.get('COMPRESHOR AC 01').port_dw_cents, 650000);
});
