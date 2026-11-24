'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-site-summary-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { rawDb, migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const capabilities = require('../src/lib/capabilities');
const siteSummary = require('../src/lib/billing/site_summary');
const app = require('../src/server');

let server;
let baseUrl;
let adminCookie;

async function reqRaw(urlPath, { method = 'GET', body = null, cookie = adminCookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8') };
}

test('Setup fresh database & fixtures for Site Summary Bill tests', async () => {
  migrate();
  capabilities.seedCapabilities();

  run("INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (1, 'CW', 'Central Workshop', 'Peliyagoda', 1, 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (117, 'CEP-03F', 'CEP-03 F (Galagedara)', 'cep 03 f galagedara', 1)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (119, 'CEP-03W', 'CEP-03 Wadakada', 'cep 03 wadakada', 1)");

  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('tk-cep3f', 'TANK-14', 'CEP-03 F Tank', 'BOWSER', 'AUTO_DIESEL', 10000, 5000, 117, 1)");
  run("INSERT INTO fuel_tanks (id, code, name, tank_type, fuel_type, capacity_litres, current_litres, project_id, active) VALUES ('tk-cep3w', 'TANK-4', 'CEP-03 W Tank', 'BOWSER', 'AUTO_DIESEL', 10000, 5000, 119, 1)");

  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, status, in_register, created_at, updated_at)
    VALUES
      (1, 'HEX-45', 'HEX45', 'HEX-45', 'CAT', 'Excavator', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now')),
      (2, 'DC-32', 'DC32', 'PH-9072', 'TOYOTA', 'Double Cab', 'vehicle', 'KM', 'active', 1, datetime('now'), datetime('now')),
      (3, 'DT-15', 'DT15', 'LM-5722', 'ISUZU', 'Dump Truck', 'vehicle', 'KM', 'active', 1, datetime('now'), datetime('now')),
      (4, 'GE-69', 'GE69', NULL, 'DENYO', 'Generator', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now')),
      (5, 'DB-05', 'DB05', NULL, 'BOWSER', 'Diesel Bowser', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now')),
      (6, 'D4D-01', 'D4D01', NULL, 'JCB', 'JCB backhoe loader (hired)', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now')),
      (7, 'UNR-01', 'UNR01', NULL, 'GENERIC', 'Roller', 'vehicle', 'HOURS', 'active', 1, datetime('now'), datetime('now')),
      (8, 'TRANSFER-CEP-03-WADAKADA', 'TRANSFERCEP03WADAKADA', NULL, 'SYSTEM', 'Site transfer to CEP-03 Wadakada (billed outside) — not a machine', 'vehicle', 'HOURS', 'active', 0, datetime('now'), datetime('now')),
      (9, 'CORRECTION-2025.05.29', 'CORRECTION20250529', NULL, 'SYSTEM', 'Pump correction / adjustment (billed outside) — not a machine', 'vehicle', 'HOURS', 'active', 0, datetime('now'), datetime('now'))
  `);

  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents,
      dry_rate_cents, wet_rate_cents, fully_wet_rate_cents,
      hr_dry_cents, hr_wet_cents, hr_fw_cents,
      km_dry_cents, km_wet_cents, km_fw_cents,
      port_dd_cents, port_dw_cents,
      equip_type, default_basis, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis
    ) VALUES
      ('rc-hex45', 1, 'Excavator', 'HOURLY', 455000, 455000, 555000, 1010000, 455000, 555000, 1010000, NULL, NULL, NULL, NULL, NULL, 'FLEET', 'DRY', 12, 16, 20, 'hr'),
      ('rc-dc32',  2, 'Double Cab (Pickup)', 'KM', 4500, 4500, 7000, 11000, NULL, NULL, NULL, 4500, 7000, 11000, NULL, NULL, 'FLEET', 'DRY', 0.08, 0.1, 0.125, 'km'),
      ('rc-dt15',  3, 'Dump Truck (Tipper)', 'KM', 9500, 9500, 12000, 23000, NULL, NULL, NULL, 9500, 12000, 23000, NULL, NULL, 'FLEET', 'DRY', 0.25, 0.333333, 0.4, 'km'),
      ('rc-ge69',  4, 'PORTABLE', 'DAILY', 600000, 600000, 600000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 600000, 600000, 'PORTABLE', 'DRY', NULL, NULL, NULL, NULL),
      ('rc-db05',  5, 'Diesel Bowser', 'HOURLY', 100000, 100000, 142000, 200000, 100000, 142000, 200000, NULL, NULL, NULL, NULL, NULL, 'FLEET', 'DRY', 3, 4.5, 6, 'hr')
  `);

  // September 2026 postings (30 calendar days):
  // - HEX-45 full month (30 days)
  // - DC-32 15 days at CEP-03F (2026-09-01..2026-09-15) & 15 days at CEP-03W -> tests proration (3000 * 15/30 = 1500 km min)
  // - DT-15 full month (also overlap in both tables to verify no double-counting)
  // - GE-69 full month portable
  // - DB-05 full month, 0 fuel -> goes to noFuelHere
  // - D4D-01 hired direct -> goes to billedDirect
  // - UNR-01 unrated with fuel -> goes to unrated
  run(`
    INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, end_date, billing_type)
    VALUES
      ('asg-1', 1, 'HEX-45', 117, '2026-09-01', '2026-09-30', 'DRY'),
      ('asg-2', 2, 'DC-32',  117, '2026-09-01', '2026-09-15', 'DRY'),
      ('asg-2b', 2, 'DC-32', 119, '2026-09-16', '2026-09-30', 'DRY'),
      ('asg-3', 3, 'DT-15',  117, '2026-09-01', '2026-09-30', 'DRY'),
      ('asg-4', 4, 'GE-69',  117, '2026-09-01', '2026-09-30', 'DRY'),
      ('asg-5', 5, 'DB-05',  117, '2026-09-01', '2026-09-30', 'DRY'),
      ('asg-6', 6, 'D4D-01', 117, '2026-09-01', '2026-09-30', 'DRY'),
      ('asg-7', 7, 'UNR-01', 117, '2026-09-01', '2026-09-30', 'WET')
  `);
  run(`
    INSERT INTO fleet_vehicle_allocations (id, dedupe_key, asset_id, vehicle_no, project_id, site_name, basis, date_from, date_to, month, is_current, active)
    VALUES ('al-3', 'DT15-CEP03F-202609', 3, 'DT-15', 117, 'CEP-03 F (Galagedara)', 'DRY', '2026-09-01', '2026-09-30', '2026-09', 0, 1)
  `);

  // Fuel issues from CEP-03F tank (Rs 382.00/L = 38200 cents)
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, bulk_tank_id, source_tank_id, is_voided)
    VALUES
      ('fi-hex45', 'FI-1', 1, 'HEX-45', 'HEX-45', 'AUTO_DIESEL', 2278, 38200, 38200, 87019600, 87019600, '2026-09-10 08:00:00', 'tk-cep3f', 'tk-cep3f', 0),
      ('fi-dc32-1', 'FI-2', 2, 'DC-32', 'PH-9072', 'AUTO_DIESEL', 200, 38200, 38200, 7640000, 7640000, '2026-09-05 08:00:00', 'tk-cep3f', 'tk-cep3f', 0),
      ('fi-dc32-2', 'FI-3', 2, 'DC-32', 'PH-9072', 'AUTO_DIESEL', 195, 38200, 38200, 7449000, 7449000, '2026-09-20 08:00:00', 'tk-cep3w', 'tk-cep3w', 0),
      ('fi-dt15', 'FI-4', 3, 'DT-15', 'LM-5722', 'AUTO_DIESEL', 70, 38200, 38200, 2674000, 2674000, '2026-09-12 08:00:00', 'tk-cep3f', 'tk-cep3f', 0),
      ('fi-ge69', 'FI-5', 4, 'GE-69', 'GE-69', 'AUTO_DIESEL', 140, 38200, 38200, 5348000, 5348000, '2026-09-14 08:00:00', 'tk-cep3f', 'tk-cep3f', 0),
      ('fi-d4d', 'FI-6', 6, 'D4D-01', 'D4D-01', 'AUTO_DIESEL', 120, 38200, 38200, 4584000, 4584000, '2026-09-14 09:00:00', 'tk-cep3f', 'tk-cep3f', 0),
      ('fi-unr', 'FI-7', 7, 'UNR-01', 'UNR-01', 'AUTO_DIESEL', 50, 38200, 38200, 1910000, 1910000, '2026-09-15 09:00:00', 'tk-cep3f', 'tk-cep3f', 0),
      ('fi-xfer', 'FI-8', 8, 'TRANSFER-CEP-03-WADAKADA', 'TRANSFER-CEP-03-WADAKADA', 'AUTO_DIESEL', 400, 38200, 38200, 15280000, 15280000, '2026-09-16 09:00:00', 'tk-cep3f', 'tk-cep3f', 0),
      ('fi-corr', 'FI-9', 9, 'CORRECTION-2025.05.29', 'CORRECTION-2025.05.29', 'AUTO_DIESEL', -70, 38200, 38200, -2674000, -2674000, '2026-09-16 10:00:00', 'tk-cep3f', 'tk-cep3f', 0)
  `);

  // Coherent meter readings:
  // DC-32 has valid coherent delta inside Sep 1..15: 10000 -> 11850 = 1850 km (beats consTyp 200/0.1=2000? no, consTyp=2000 beats 1850 and prorated 1500!)
  // Wait let's also give DT-15 coherent meter readings vs huge corrupted spike: 50000 -> 50900 (+900 valid), then 999999 (spike rejected!)
  run(`
    INSERT INTO fuel_meter_readings (asset_id, asset_code, meter_reading, meter_type, reading_date, source)
    VALUES
      (2, 'DC-32', 10000, 'KM', '2026-09-02', 'FUEL_ISSUE'),
      (2, 'DC-32', 11850, 'KM', '2026-09-14', 'FUEL_ISSUE'),
      (3, 'DT-15', 50000, 'KM', '2026-09-02', 'FUEL_ISSUE'),
      (3, 'DT-15', 50900, 'KM', '2026-09-12', 'FUEL_ISSUE'),
      (3, 'DT-15', 999999, 'KM', '2026-09-13', 'FUEL_ISSUE')
  `);

  run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('admin', 'Administrator', 1, 1)");
  const adminRole = get("SELECT id FROM roles WHERE name = 'admin'");
  const pwHash = auth.hashPassword('SumPass#2026!');
  run("INSERT INTO users (id, username, password_hash, full_name, active, must_change_password) VALUES (1, 'admin_sum', ?, 'Summary Admin', 1, 0)", pwHash);
  run('INSERT INTO user_roles (user_id, role_id) VALUES (1, ?)', adminRole.id);

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const login = await reqRaw('/api/auth/login', {
    method: 'POST',
    cookie: null,
    body: { username: 'admin_sum', password: 'SumPass#2026!' },
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
});

test('Site Summary engine calculates consTyp, coherentMeterDelta, prorated min, exclusions, transfers & taxes accurately', () => {
  const sum = siteSummary.buildSiteSummary('CEP-03F', '2026-09');
  assert.equal(sum.siteCode, 'CEP-03F');
  assert.equal(sum.periodKey, '2026-09');
  assert.equal(sum.daysInMonth, 30);

  const byCode = Object.fromEntries(sum.lines.map((l) => [l.code, l]));

  // HEX-45: 2278 L / 16 L/hr = 142.375 hr * Rs 5,550 = Rs 790,181.25 (79018125 cents), billed on fuel
  assert.ok(byCode['HEX-45']);
  assert.equal(byCode['HEX-45'].daysHere, 30);
  assert.equal(byCode['HEX-45'].billedOn, 'fuel');
  assert.equal(byCode['HEX-45'].rateCents, 555000);
  assert.equal(byCode['HEX-45'].rentalCents, 79018125);
  assert.equal(byCode['HEX-45'].fuelLitres, 2278);

  // DC-32: 15 days / 30 days -> minimumProrated = 1500 km, actualMeter = 1850 km, consTyp = 200/0.1 = 2000 km -> on fuel (only CEP-03F tank's 200L counted!)
  assert.ok(byCode['DC-32']);
  assert.equal(byCode['DC-32'].daysHere, 15);
  assert.equal(byCode['DC-32'].minimumProrated, 1500);
  assert.equal(byCode['DC-32'].actualUnits, 1850);
  assert.equal(byCode['DC-32'].consRefUnits, 2000);
  assert.equal(byCode['DC-32'].billableUnits, 2000);
  assert.equal(byCode['DC-32'].billedOn, 'fuel');
  assert.equal(byCode['DC-32'].fuelLitres, 200);
  assert.equal(byCode['DC-32'].rentalCents, 2000 * 7000);

  // DT-15: 30 days (not 60 from overlapping allocation+assignment!), rejected 999999 spike so actualUnits=900, minimum=3000 -> on minimum
  assert.ok(byCode['DT-15']);
  assert.equal(byCode['DT-15'].daysHere, 30);
  assert.equal(byCode['DT-15'].actualUnits, 900);
  assert.equal(byCode['DT-15'].billableUnits, 3000);
  assert.equal(byCode['DT-15'].billedOn, 'minimum');
  assert.equal(byCode['DT-15'].rateCents, 12000);
  assert.equal(byCode['DT-15'].rentalCents, 36000000);

  // GE-69: portable perday -> 25 working days/month * Rs 6,000 = 150,000 (not 30 calendar days)
  assert.ok(byCode['GE-69']);
  assert.equal(byCode['GE-69'].billingMode, 'perday');
  assert.equal(byCode['GE-69'].unit, 'days');
  assert.equal(byCode['GE-69'].workingDaysHere, 25);
  assert.equal(byCode['GE-69'].billableUnits, 25);
  assert.equal(byCode['GE-69'].rentalCents, 15000000);

  // Exclusions & Callouts
  assert.deepEqual(sum.noFuelHere, ['DB-05']);
  assert.deepEqual(sum.billedDirect, ['D4D-01']);
  assert.deepEqual(sum.unrated, ['UNR-01']);

  // Transfers & Corrections Excluded (400 L - 70 L = 330 L)
  assert.equal(sum.transfersExcluded.length, 2);
  assert.equal(sum.transfersExcludedLitres, 330);
  assert.equal(sum.transfersExcludedCents, 330 * 38200);

  // Tax math: SSCL 2.5%, VAT 18%
  assert.equal(sum.subtotalCents, sum.rentalCents + sum.fuelCostCents);
  assert.equal(sum.ssclCents, Math.round(sum.subtotalCents * 0.025));
  assert.equal(sum.vatLiableCents, sum.subtotalCents + sum.ssclCents);
  assert.equal(sum.vatCents, Math.round(sum.vatLiableCents * 0.18));
  assert.equal(sum.grandTotalCents, sum.vatLiableCents + sum.vatCents);
});

test('Site Summary HTTP endpoints: JSON, CSP-safe print HTML, PDF/Excel download, and batch Bill Generation', async () => {
  // 1. JSON single & ALL
  const singleRes = await reqRaw('/api/hire/bills/site-summary?projectId=117&month=2026-09');
  assert.equal(singleRes.status, 200);
  const singleJson = JSON.parse(singleRes.text);
  assert.equal(singleJson.mode, 'SINGLE');
  assert.equal(singleJson.summary.siteCode, 'CEP-03F');
  assert.equal(singleJson.summary.lines.length, 5);

  const allRes = await reqRaw('/api/hire/bills/site-summary?projectId=ALL&month=2026-09');
  assert.equal(allRes.status, 200);
  const allJson = JSON.parse(allRes.text);
  assert.equal(allJson.mode, 'ALL');
  assert.equal(allJson.summaries.length, 2);

  // 2. Print HTML (matches E&C PDF layout & uses CSP-safe dom-actions.js)
  const htmlRes = await reqRaw('/api/hire/bills/site-summary/print.html?projectId=117&month=2026-09');
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /SITE SUMMARY BILL/);
  assert.match(htmlRes.text, /EC40\.WS\.IV\.8\.12\.25\.3/);
  assert.match(htmlRes.text, /TRANSFERS &amp; CORRECTIONS EXCLUDED/);
  assert.match(htmlRes.text, /TRANSFER-CEP-03-WADAKADA/);
  assert.match(htmlRes.text, /dom-actions\.js/);
  assert.doesNotMatch(htmlRes.text, /\sonclick=/i);

  // 3. Excel Export
  const xlsxRes = await reqRaw('/api/hire/bills/site-summary/download.xlsx?projectId=117&month=2026-09');
  assert.equal(xlsxRes.status, 200);
  assert.equal(xlsxRes.buf.slice(0, 2).toString('utf8'), 'PK');

  // 4. PDF Export (returns valid PDF if Edge/Chrome available, or graceful HTML fallback)
  const pdfRes = await reqRaw('/api/hire/bills/site-summary/download.pdf?projectId=117&month=2026-09');
  assert.equal(pdfRes.status, 200);
  const ct = pdfRes.headers.get('content-type') || '';
  if (ct.includes('pdf')) {
    assert.equal(pdfRes.buf.slice(0, 5).toString('utf8'), '%PDF-');
  } else {
    assert.match(pdfRes.text, /SITE SUMMARY BILL/);
  }

  // 5. Commit all listed rated machines as FINAL site bills in one action
  const genRes = await reqRaw('/api/hire/bills/site-summary/generate', {
    method: 'POST',
    body: { projectId: 117, month: '2026-09', finalise: true },
  });
  assert.equal(genRes.status, 201);
  const genJson = JSON.parse(genRes.text);
  assert.equal(genJson.generatedBills, 4); // HEX-45, DC-32, DT-15, GE-69 (UNR-01 skipped for missing rate)
  assert.equal(genJson.skippedUnrated, 1);

  const hexBill = get("SELECT * FROM fleet_bills WHERE asset_id = 1 AND project_id = 117 AND period_key = '2026-09'");
  assert.ok(hexBill);
  assert.equal(hexBill.status, 'FINAL');
  assert.equal(hexBill.rental_amount_cents, 79018125);
  assert.equal(hexBill.fuel_litres, 2278);

  // Re-running generate skips existing bills cleanly
  const genAgain = await reqRaw('/api/hire/bills/site-summary/generate', {
    method: 'POST',
    body: { projectId: 117, month: '2026-09', finalise: true },
  });
  assert.equal(JSON.parse(genAgain.text).generatedBills, 0);
  assert.equal(JSON.parse(genAgain.text).skippedExisting, 4);
});

test('Sites catalog, active=0 sites, sub-site scoping, fleet_bills fallback, tankless fuel & breakdown period exclusion', async () => {
  // Seed active=0 operational site (BGP), tankless active=0 site (TANKLESS), empty site (EMPTY-00), and child sub-site (501)
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (120, 'BGP', 'Badalgama Plant', 'badalgama plant', 0)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (121, 'TANKLESS', 'Tankless Site', 'tankless site', 0)");
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (122, 'EMPTY-00', 'Empty Inactive Test', 'empty inactive test', 1)");
  run("INSERT INTO sites (id, project_id, name, created_at) VALUES (501, 117, 'Galagedara Quarry', datetime('now'))");
  run('UPDATE assets SET current_site_id = 501 WHERE id = 1');

  // Verify /api/hire/sites-catalog returns active=1 AND active=0 projects plus child sub-site
  const catRes = await reqRaw('/api/hire/sites-catalog');
  assert.equal(catRes.status, 200);
  const cat = JSON.parse(catRes.text);
  assert.ok(cat.projects.some((p) => Number(p.id) === 120 && Number(p.active) === 0), 'sites-catalog must include active=0 operational projects');
  assert.ok(cat.sites.some((s) => Number(s.id) === 501 && Number(s.project_id) === 117), 'sites-catalog must include child sites');
  assert.ok(cat.projects.find((p) => Number(p.id) === 117).sites.some((s) => Number(s.id) === 501), 'parent project must include child sites');

  // Verify sub-site scoping via ?projectId=site:501 filters 2026-09 down to HEX-45 only
  const subRes = await reqRaw('/api/hire/bills/site-summary?projectId=site:501&month=2026-09');
  assert.equal(subRes.status, 200);
  const subJson = JSON.parse(subRes.text);
  assert.equal(subJson.summary.lines.length, 1);
  assert.equal(subJson.summary.lines[0].code, 'HEX-45');

  // Seed 2026-10 (31 days) fixtures for breakdown exclusion & pre-breakdown costing at BGP (id=120, active=0):
  // - DT-20: Dump Truck (km, Rs 100/km), stay Oct 1..31, OPEN breakdown from 2026-10-16 -> 16 BD days, 15 active pre-breakdown days
  //   Pre-breakdown meter delta = 1800 km (Oct 2..14) > prorated min (~1451.61 km) + 100 L tankless central fuel (target_project_id=120)
  // - GE-70: Portable Daily (Rs 6,000/day), stay Oct 1..31, CLOSED breakdown Oct 11..20 -> 10 BD days, 21 active days = Rs 126,000
  // - GE-71: Portable Daily (Rs 6,000/day), stay Oct 1..31, OPEN breakdown since Sep 25 -> 31 BD days, 0 active days = Rs 0
  // - CR-10: Assigned via existing fleet_bills only on tankless site 121 -> fallback recovers bill line
  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, status, in_register, current_project_id, created_at, updated_at)
    VALUES
      (10, 'DT-20', 'DT20', 'WP-DT-20', 'ISUZU', 'Dump Truck', 'vehicle', 'KM', 'active', 1, 120, datetime('now'), datetime('now')),
      (11, 'GE-70', 'GE70', NULL, 'DENYO', 'Generator', 'vehicle', 'HOURS', 'active', 1, 120, datetime('now'), datetime('now')),
      (12, 'GE-71', 'GE71', NULL, 'DENYO', 'Generator', 'vehicle', 'HOURS', 'active', 1, 120, datetime('now'), datetime('now')),
      (13, 'CR-10', 'CR10', 'CR-10', 'TADANO', 'Crane', 'vehicle', 'HOURS', 'active', 1, 121, datetime('now'), datetime('now'))
  `);
  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents,
      dry_rate_cents, wet_rate_cents, km_dry_cents, km_wet_cents, port_dd_cents, port_dw_cents,
      equip_type, default_basis, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis
    ) VALUES
      ('rc-dt20', 10, 'Dump Truck (Tipper)', 'KM', 10000, 10000, 13000, 10000, 13000, NULL, NULL, 'FLEET', 'DRY', 0.25, 0.333333, 0.4, 'km'),
      ('rc-ge70', 11, 'PORTABLE', 'DAILY', 600000, 600000, 600000, NULL, NULL, 600000, 600000, 'PORTABLE', 'DRY', NULL, NULL, NULL, NULL),
      ('rc-ge71', 12, 'PORTABLE', 'DAILY', 600000, 600000, 600000, NULL, NULL, 600000, 600000, 'PORTABLE', 'DRY', NULL, NULL, NULL, NULL)
  `);
  run(`
    INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, end_date, billing_type)
    VALUES
      ('asg-dt20', 10, 'DT-20', 120, '2026-10-01', '2026-10-31', 'DRY'),
      ('asg-ge70', 11, 'GE-70', 120, '2026-10-01', '2026-10-31', 'DRY'),
      ('asg-ge71', 12, 'GE-71', 120, '2026-10-01', '2026-10-31', 'DRY')
  `);
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, bulk_tank_id, source_tank_id, target_project_id, is_voided)
    VALUES
      ('fi-dt20', 'FI-DT20', 10, 'DT-20', 'WP-DT-20', 'AUTO_DIESEL', 100, 38200, 38200, 3820000, 3820000, '2026-10-10 08:00:00', NULL, NULL, 120, 0),
      ('fi-ge70', 'FI-GE70', 11, 'GE-70', 'GE-70', 'AUTO_DIESEL', 50, 38200, 38200, 1910000, 1910000, '2026-10-05 08:00:00', NULL, NULL, 120, 0)
  `);
  run(`
    INSERT INTO fuel_meter_readings (asset_id, asset_code, meter_reading, meter_type, reading_date, source)
    VALUES
      (10, 'DT-20', 1000, 'KM', '2026-10-02', 'FUEL_ISSUE'),
      (10, 'DT-20', 2800, 'KM', '2026-10-14', 'FUEL_ISSUE')
  `);
  // Breakdowns:
  // 1) DT-20 OPEN breakdown starting 2026-10-16 -> pre-breakdown Oct 1..15 (15 days) must still be billed; Oct 16..31 (16 days) = Rs 0
  // 2) GE-70 CLOSED breakdown 2026-10-11..2026-10-20 -> 10 BD days excluded, 21 active days billed
  // 3) GE-71 OPEN breakdown starting 2026-09-25 -> all 31 days in Oct are BD = Rs 0
  run(`
    INSERT INTO job_cards (id, job_no, asset_id, project_id, workshop_id, type, severity, status, breakdown, reported_at, closed_at, description, requested_by, is_historical)
    VALUES
      (401, 'CW/2026/BD-OPEN', 10, 120, 1, 'repair', 'major', 'IN_PROGRESS', 1, '2026-10-16', NULL, 'Transmission failure mid-month', 1, 0),
      (402, 'CW/2026/BD-CLOSED', 11, 120, 1, 'repair', 'minor', 'CLOSED', 1, '2026-10-11', '2026-10-20', 'AVR repaired', 1, 0),
      (403, 'CW/2026/BD-FULL', 12, 120, 1, 'repair', 'major', 'IN_PROGRESS', 1, '2026-09-25', NULL, 'Alternator burnt out', 1, 0)
  `);
  // Tankless site 121 (no fuel_tanks, no allocations) has a fleet_bills record -> fallback recovers it for summary & PDF
  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, project_name, project_code,
      billing_mode, rate_basis, rate_cents, actual_units, minimum_units, billable_units,
      rental_amount_cents, fuel_litres, fuel_cost_cents, breakdown_days,
      subtotal_cents, sscl_cents, vat_cents, grand_total_cents, status
    ) VALUES (
      'fb-cr10', 'INV-TANKLESS-1', 2026, 10, '2026-10', '2026-10-01', '2026-10-31',
      13, 'CR-10', 121, 'Tankless Site', 'TANKLESS',
      'DRY', 'HOURLY', 500000, 90, 0, 90, 45000000, 0, 0, 0,
      45000000, 1125000, 8302500, 54427500, 'FINAL'
    )
  `);

  const bgp = siteSummary.buildSiteSummary(120, '2026-10');
  assert.equal(bgp.siteCode, 'BGP');
  assert.equal(bgp.daysInMonth, 31);
  const byCodeOct = Object.fromEntries(bgp.lines.map((l) => [l.code, l]));

  // DT-20: pre-breakdown 15 working days costed (1800 km * WET Rs 130/km because fuel was issued = Rs 234,000 + Rs 38,200 central fuel), 16 BD days zeroed
  assert.ok(byCodeOct['DT-20']);
  assert.equal(byCodeOct['DT-20'].daysHere, 15);
  assert.equal(byCodeOct['DT-20'].breakdownDays, 16);
  assert.equal(byCodeOct['DT-20'].actualUnits, 1800);
  assert.equal(byCodeOct['DT-20'].billableUnits, 1800);
  assert.equal(byCodeOct['DT-20'].rentalCents, 23400000);
  assert.equal(byCodeOct['DT-20'].fuelLitres, 100);
  assert.equal(byCodeOct['DT-20'].fuelCostCents, 3820000);
  assert.equal(byCodeOct['DT-20'].hasOpenBreakdown, true);

  // GE-70: 10 closed breakdown days excluded, 25 - 10 = 15 working days billed at Rs 6,000/day
  assert.ok(byCodeOct['GE-70']);
  assert.equal(byCodeOct['GE-70'].daysHere, 21);
  assert.equal(byCodeOct['GE-70'].workingDaysHere, 15);
  assert.equal(byCodeOct['GE-70'].billableUnits, 15);
  assert.equal(byCodeOct['GE-70'].breakdownDays, 10);
  assert.equal(byCodeOct['GE-70'].lostHireRevenueCents, 10 * 600000);
  assert.equal(byCodeOct['GE-70'].rentalCents, 15 * 600000);

  // GE-71: full month breakdown (0 fuel, 0 active days) -> omitted from default fuel-active list; with includeZeroFuel shows Rs 0 rental
  const bgpAll = siteSummary.buildSiteSummary(120, '2026-10', { includeZeroFuel: true });
  const ge71 = bgpAll.lines.find((l) => l.code === 'GE-71');
  assert.ok(ge71);
  assert.equal(ge71.daysHere, 0);
  assert.equal(ge71.breakdownDays, 31);
  assert.equal(ge71.rentalCents, 0);

  // buildAllSiteSummaries('2026-10') includes active=0 BGP and TANKLESS, excludes EMPTY-00 (0 details)
  const allOct = await reqRaw('/api/hire/bills/site-summary?projectId=ALL&month=2026-10');
  assert.equal(allOct.status, 200);
  const allOctJson = JSON.parse(allOct.text);
  const siteCodes = allOctJson.summaries.map((s) => s.siteCode);
  assert.ok(siteCodes.includes('BGP'), 'All Sites must include active=0 site BGP with details');
  assert.ok(siteCodes.includes('TANKLESS'), 'All Sites must include tankless site via fleet_bills fallback');
  assert.equal(siteCodes.includes('EMPTY-00'), false, 'All Sites must skip sites with zero detail lines');

  // Verify print HTML displays breakdown deduction badge and fallback details
  const octHtml = await reqRaw('/api/hire/bills/site-summary/print.html?projectId=ALL&month=2026-10');
  assert.equal(octHtml.status, 200);
  assert.match(octHtml.text, /BD excl\./);
  assert.match(octHtml.text, /CR-10/);
  assert.match(octHtml.text, /DT-20/);

  // Verify empty ALL period returns 404 from download.pdf with JSON error (no silent blank PDF)
  const emptyPdf = await reqRaw('/api/hire/bills/site-summary/download.pdf?projectId=ALL&month=2026-12');
  assert.equal(emptyPdf.status, 404);
  assert.match(emptyPdf.text, /No site summary data found/i);

  // Generate bills for BGP: generates DT-20 (15 pre-BD days) & GE-70 (21 active days), skips GE-71 (0 active days & 0 fuel)
  const genBgp = await reqRaw('/api/hire/bills/site-summary/generate', {
    method: 'POST',
    body: { projectId: 120, month: '2026-10', finalise: true },
  });
  assert.equal(genBgp.status, 201);
  const genBgpJson = JSON.parse(genBgp.text);
  assert.equal(genBgpJson.generatedBills, 2);
  const dt20Bill = get("SELECT * FROM fleet_bills WHERE asset_id = 10 AND project_id = 120 AND period_key = '2026-10'");
  assert.ok(dt20Bill);
  assert.equal(dt20Bill.breakdown_days, 16);
  assert.equal(dt20Bill.rental_amount_cents, 23400000);
  assert.equal(dt20Bill.fuel_litres, 100);
  assert.equal(dt20Bill.fuel_cost_cents, 3820000);
});

test('25-working-day breakdown deduction (120 hr Hourly & 3,000 km Per-KM) deducts breakdown days and rental cost accurately', async () => {
  run("INSERT INTO projects (id, code, name, name_norm, active) VALUES (123, 'MIN25', 'Min 25 Working Days Site', 'min 25 working days site', 1)");
  run(`
    INSERT INTO assets (id, code, code_norm, registration, brand, type, asset_class, meter_type, status, in_register, current_project_id, created_at, updated_at)
    VALUES
      (14, 'EX-120', 'EX120', 'EX-120', 'CAT', 'Excavator', 'vehicle', 'HOURS', 'active', 1, 123, datetime('now'), datetime('now')),
      (15, 'DT-30',  'DT30',  'WP-DT-30', 'ISUZU', 'Dump Truck', 'vehicle', 'KM', 'active', 1, 123, datetime('now'), datetime('now'))
  `);
  // min_bill_hours left 0 so engine defaults 120 hr for HOURLY and 3,000 km for KM
  run(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents,
      dry_rate_cents, wet_rate_cents, hr_dry_cents, hr_wet_cents, km_dry_cents, km_wet_cents,
      equip_type, default_basis, fuel_cons_basis
    ) VALUES
      ('rc-ex120', 14, 'Excavator', 'HOURLY', 500000, 500000, 500000, 500000, 500000, NULL, NULL, 'FLEET', 'WET', 'hr'),
      ('rc-dt30',  15, 'Dump Truck (Tipper)', 'KM', 12000, 12000, 12000, NULL, NULL, 12000, 12000, 'FLEET', 'WET', 'km')
  `);
  run(`
    INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, end_date, billing_type)
    VALUES
      ('asg-ex120', 14, 'EX-120', 123, '2026-11-01', '2026-11-30', 'WET'),
      ('asg-dt30',  15, 'DT-30',  123, '2026-11-01', '2026-11-30', 'WET')
  `);
  run(`
    INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, target_project_id, is_voided)
    VALUES
      ('fi-ex120', 'FI-EX120', 14, 'EX-120', 'EX-120', 'AUTO_DIESEL', 40, 38200, 38200, 1528000, 1528000, '2026-11-05 08:00:00', 123, 0),
      ('fi-dt30',  'FI-DT30',  15, 'DT-30',  'WP-DT-30', 'AUTO_DIESEL', 50, 38200, 38200, 1910000, 1910000, '2026-11-05 08:00:00', 123, 0)
  `);
  run(`
    INSERT INTO job_cards (id, job_no, asset_id, project_id, workshop_id, type, severity, status, breakdown, reported_at, closed_at, description, requested_by, is_historical)
    VALUES
      (404, 'CW/2026/BD-EX120', 14, 123, 1, 'repair', 'major', 'CLOSED', 1, '2026-11-11', '2026-11-15', 'Track motor seal repair', 1, 0),
      (405, 'CW/2026/BD-DT30',  15, 123, 1, 'repair', 'major', 'CLOSED', 1, '2026-11-21', '2026-11-25', 'Leaf spring replacement', 1, 0)
  `);

  const sum = siteSummary.buildSiteSummary(123, '2026-11');
  assert.equal(sum.workingDaysInMonth, 25);
  const byCode = Object.fromEntries(sum.lines.map((l) => [l.code, l]));

  // EX-120: 25 working days - 5 BD = 20 working days; min 120 hr -> deduct 24 hr (-Rs 120,000), net 96 hr (Rs 480,000)
  assert.equal(byCode['EX-120'].workingDaysHere, 20);
  assert.equal(byCode['EX-120'].breakdownDays, 5);
  assert.equal(byCode['EX-120'].minimumFull, 120);
  assert.equal(byCode['EX-120'].breakdownDeductUnits, 24);
  assert.equal(byCode['EX-120'].minimumProrated, 96);
  assert.equal(byCode['EX-120'].billableUnits, 96);
  assert.equal(byCode['EX-120'].billedOn, 'minimum');
  assert.equal(byCode['EX-120'].grossRentalCents, 60000000);
  assert.equal(byCode['EX-120'].breakdownDeductCents, 12000000);
  assert.equal(byCode['EX-120'].rentalCents, 48000000);

  // DT-30: 25 working days - 5 BD = 20 working days; min 3,000 km -> deduct 600 km (-Rs 72,000), net 2,400 km (Rs 288,000)
  assert.equal(byCode['DT-30'].workingDaysHere, 20);
  assert.equal(byCode['DT-30'].breakdownDays, 5);
  assert.equal(byCode['DT-30'].minimumFull, 3000);
  assert.equal(byCode['DT-30'].breakdownDeductUnits, 600);
  assert.equal(byCode['DT-30'].minimumProrated, 2400);
  assert.equal(byCode['DT-30'].billableUnits, 2400);
  assert.equal(byCode['DT-30'].billedOn, 'minimum');
  assert.equal(byCode['DT-30'].grossRentalCents, 36000000);
  assert.equal(byCode['DT-30'].breakdownDeductCents, 7200000);
  assert.equal(byCode['DT-30'].rentalCents, 28800000);

  // Totals & taxes
  assert.equal(sum.grossRentalCents, 96000000);
  assert.equal(sum.breakdownDeductCents, 19200000);
  assert.equal(sum.rentalCents, 76800000);
  assert.equal(sum.subtotalCents, 76800000 + 1528000 + 1910000);
  assert.equal(sum.ssclCents, Math.round(sum.subtotalCents * 0.025));
  assert.equal(sum.vatCents, Math.round((sum.subtotalCents + sum.ssclCents) * 0.18));
  assert.equal(sum.grandTotalCents, sum.subtotalCents + sum.ssclCents + sum.vatCents);

  // Printable HTML renders working days & breakdown deduction rows
  const htmlRes = await reqRaw('/api/hire/bills/site-summary/print.html?projectId=123&month=2026-11');
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /20 \/ 25/);
  assert.match(htmlRes.text, /Gross machine rental/);
  assert.match(htmlRes.text, /Less: Breakdown rental deduction/);
  assert.match(htmlRes.text, /SITE TOTAL \(FINAL BILL\)/);
  assert.doesNotMatch(htmlRes.text, /Breakdown period/i);
  assert.doesNotMatch(htmlRes.text, /COMPANY REPAIR &amp; DOWNTIME COST IMPACT/i);
  assert.doesNotMatch(htmlRes.text, /COMPANY REPAIR & DOWNTIME COST IMPACT/i);

  // Persist bills and verify breakdown deduction line item + net subtotal in fleet_bills
  const genRes = await reqRaw('/api/hire/bills/site-summary/generate', {
    method: 'POST',
    body: { projectId: 123, month: '2026-11', finalise: true },
  });
  assert.equal(genRes.status, 201);
  assert.equal(JSON.parse(genRes.text).generatedBills, 2);

  const exBill = get("SELECT * FROM fleet_bills WHERE asset_id = 14 AND project_id = 123 AND period_key = '2026-11'");
  assert.ok(exBill);
  assert.equal(exBill.minimum_units, 120);
  assert.equal(exBill.rental_amount_cents, 60000000);
  assert.equal(exBill.breakdown_days, 5);
  assert.equal(exBill.breakdown_deduct_cents, 12000000);
  assert.equal(exBill.subtotal_cents, 48000000 + 1528000);

  const bdLi = get("SELECT * FROM fleet_bill_line_items WHERE bill_id = ? AND item_type = 'BREAKDOWN_DEDUCT'", exBill.id);
  assert.ok(bdLi && bdLi.amount_cents === 12000000 && bdLi.is_deduction === 1);
});

test('Welding generator (WG) & Generators bill max 25 working days in 31-day months across Site Summary, site-preview, and Migration 071', async () => {
  const mig071 = require('../src/migrate/071_cap_daily_draft_bills_25_days');
  run("INSERT INTO assets (id, code, code_norm, type, asset_class, meter_type, status, in_register, current_project_id, created_at, updated_at) VALUES (20, 'WG-13', 'WG13', 'Welding Generator', 'generator', 'HOURS', 'active', 1, 120, datetime('now'), datetime('now'))");
  run("INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, dry_rate_cents, wet_rate_cents, port_dd_cents, port_dw_cents, equip_type, default_basis) VALUES ('rc-wg13', 20, 'Welding Plant', 'DAILY', 650000, 650000, 950000, 650000, 950000, 'PORTABLE', 'DRY')");
  run("INSERT INTO fleet_asset_assignments (id, asset_id, asset_code, project_id, start_date, end_date, billing_type) VALUES ('asg-wg13', 20, 'WG-13', 120, '2026-10-01', '2026-10-31', 'DRY')");
  run("INSERT INTO fuel_issues (id, issue_no, asset_id, asset_code, vehicle_ref, fuel_type, litres, fuel_price_cents, price_per_litre_cents, total_cost_cents, cost_cents, issue_date, target_project_id, is_voided) VALUES ('fi-wg13', 'FI-WG13', 20, 'WG-13', 'WG-13', 'AUTO_DIESEL', 25, 38200, 38200, 955000, 955000, '2026-10-03 08:00:00', 120, 0)");

  const sumOct = siteSummary.buildSiteSummary(120, '2026-10');
  const wg = sumOct.lines.find((l) => l.code === 'WG-13');
  assert.ok(wg);
  assert.equal(wg.workingDaysHere, 25);
  assert.equal(wg.billableUnits, 25);
  assert.equal(wg.rentalCents, 25 * 950000);

  const prevRes = await reqRaw('/api/hire/bills/site-preview?projectId=120&month=2026-10');
  assert.equal(prevRes.status, 200);
  const prevJson = JSON.parse(prevRes.text);
  const wgPrev = prevJson.items.find((it) => it.assetCode === 'WG-13');
  assert.ok(wgPrev);
  assert.equal(wgPrev.actualUnits, 25);
  assert.equal(wgPrev.calculation.billableUnits, 25);
  assert.equal(wgPrev.calculation.rentalAmountCents, 25 * 650000);

  // Seed legacy 31-day DRAFT DAILY bill + 31-day FINAL DAILY bill; Migration 071 recalculates only DRAFT -> 25 days
  run(`
    INSERT INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, project_id, billing_mode, rate_basis, rate_cents,
      actual_units, minimum_units, billable_units, rental_amount_cents, fuel_litres, fuel_cost_cents,
      subtotal_cents, sscl_rate, sscl_cents, vat_rate, vat_cents, grand_total_cents, status
    ) VALUES
      ('b-wg13-draft', NULL, 2026, 10, '2026-10', '2026-10-01', '2026-10-31', 20, 'WG-13', 120, 'DRY', 'DAILY', 650000, 31, 0, 31, 20150000, 0, 0, 20150000, 0.025, 503750, 0.18, 3717675, 24371425, 'DRAFT'),
      ('b-wg13-final', 'INV-WG-FINAL', 2026, 10, '2026-10', '2026-10-01', '2026-10-31', 20, 'WG-13', 120, 'DRY', 'DAILY', 650000, 31, 0, 31, 20150000, 0, 0, 20150000, 0.025, 503750, 0.18, 3717675, 24371425, 'FINAL')
  `);
  const r071 = mig071.runMigration(rawDb);
  assert.equal(r071.draftBillsRecalculated, 1);
  assert.equal(get("SELECT billable_units FROM fleet_bills WHERE id = 'b-wg13-draft'").billable_units, 25);
  assert.equal(get("SELECT rental_amount_cents FROM fleet_bills WHERE id = 'b-wg13-draft'").rental_amount_cents, 25 * 650000);
  assert.equal(get("SELECT billable_units FROM fleet_bills WHERE id = 'b-wg13-final'").billable_units, 31);
  assert.equal(mig071.runMigration(rawDb).draftBillsRecalculated, 0);
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
