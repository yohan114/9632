'use strict';

// Seed representative data grounded in the real codes from the build brief:
// vehicle codes (28-4314 ...), projects (CEP-03, Marawila, Muthur, Iginimitiya,
// Port City), products (CI4, HD46, HD68, 80W90, MP140 ...), mechanics
// (Anura 425, Buddhika 425, Chaminda 250 ...), the shared battery serial
// M158752495, and job numbers like 2024/3/R/161.
//
// Run:  npm run reset   (migrate --reset && seed)   or   npm run seed

const { db, migrate, get, run, tx } = require('./index');
const auth = require('../lib/auth');
const aliases = require('../lib/aliases');
const costing = require('../lib/costing');
const mechanicsLib = require('../lib/mechanics');

migrate();

if (get('SELECT id FROM users WHERE username = ?', 'admin') && !process.argv.includes('--force')) {
  console.log('Already seeded (admin user exists). Use `npm run reset` for a clean seed.');
  process.exit(0);
}

const EARLY = '2020-01-01'; // effective-from for rates/prices so history resolves

tx(() => {
  // ---- roles ----
  const roles = [
    ['admin', 'Administrator'],
    ['storekeeper', 'Storekeeper'],
    ['transport_manager', 'Transport Manager'],
    ['assistant_transport_manager', 'Assistant Transport Manager'],
    ['operational_manager', 'Operational Manager'],
    ['workshop', 'Workshop / Mechanic Supervisor'],
    ['manager', 'Manager'],
    ['viewer', 'Viewer'],
  ];
  for (const [name, label] of roles) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', name, label);
  const roleId = (n) => get('SELECT id FROM roles WHERE name = ?', n).id;

  // ---- users (username == password for the demo) ----
  const users = [
    ['admin', 'admin', 'System Admin', ['admin']],
    ['store', 'store', 'Sunil (Storekeeper)', ['storekeeper']],
    ['transport', 'transport', 'Transport Manager', ['transport_manager']],
    ['asst', 'asst', 'Assistant Transport Manager', ['assistant_transport_manager']],
    ['ops', 'ops', 'Operational Manager', ['operational_manager', 'manager']],
    ['mech', 'mech', 'Workshop Supervisor', ['workshop']],
    ['viewer', 'viewer', 'Read-only Viewer', ['viewer']],
  ];
  for (const [u, p, fn, rs] of users) {
    const info = run('INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)', u, auth.hashPassword(p), fn);
    for (const r of rs) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', info.lastInsertRowid, roleId(r));
  }

  // ---- projects (the real ones) ----
  const projects = [
    ['CEP-03', 'CEP-03', 'Central'],
    ['MRW', 'Marawila', 'Marawila'],
    ['MTR', 'Muthur', 'Muthur'],
    ['IGM', 'Iginimitiya Project', 'Iginimitiya'],
    ['PC', 'Port City', 'Colombo'],
    ['BDG', 'Badalgama Workshop', 'Badalgama'],
    ['HAM', 'Hambantota', 'Hambantota'],
    ['KUR', 'Kurunegala', 'Kurunegala'],
    ['ANU', 'Anuradhapura', 'Anuradhapura'],
    ['TRC', 'Trincomalee', 'Trincomalee'],
    ['HO', 'Head Office', 'Colombo'],
  ];
  const projId = {};
  for (const [code, name, loc] of projects) {
    const info = run('INSERT INTO projects (code, name, location) VALUES (?, ?, ?)', code, name, loc);
    projId[code] = info.lastInsertRowid;
  }
  run('INSERT INTO sites (project_id, name) VALUES (?, ?)', projId.MTR, 'Muthur Plant Yard');
  run('INSERT INTO sites (project_id, name) VALUES (?, ?)', projId.IGM, 'Iginimitiya Main Camp');

  // ---- products (21 lubricants/fuels) ----
  const products = [
    ['CI4', 'CI4 15W40 Engine Oil', 'L', 'engine_oil', 60, 1250],
    ['HD46', 'HD46 Hydraulic Oil', 'L', 'hydraulic', 80, 980],
    ['HD68', 'HD68 Hydraulic Oil', 'L', 'hydraulic', 80, 1010],
    ['80W90', '80W90 Gear Oil', 'L', 'gear', 40, 1150],
    ['MP140', 'MP140 Gear Oil', 'L', 'gear', 30, 1300],
    ['GREASE', 'Multipurpose Grease', 'kg', 'grease', 25, 720],
    ['DIESEL', 'Diesel', 'L', 'fuel', 500, 365],
    ['CH4', 'CH4 20W50 Engine Oil', 'L', 'engine_oil', 40, 1180],
    ['ATF', 'ATF Transmission Fluid', 'L', 'transmission', 30, 1420],
    ['SAE30', 'SAE30 Engine Oil', 'L', 'engine_oil', 20, 990],
    ['SAE40', 'SAE40 Engine Oil', 'L', 'engine_oil', 20, 1005],
    ['15W40', '15W40 Diesel Engine Oil', 'L', 'engine_oil', 50, 1240],
    ['COOLANT', 'Radiator Coolant', 'L', 'coolant', 20, 640],
    ['BRAKE', 'Brake Fluid DOT4', 'L', 'brake', 10, 880],
    ['85W140', '85W140 Gear Oil', 'L', 'gear', 25, 1360],
    ['EP90', 'EP90 Gear Oil', 'L', 'gear', 25, 1200],
    ['ISO32', 'ISO32 Hydraulic Oil', 'L', 'hydraulic', 40, 940],
    ['ISO46', 'ISO46 Hydraulic Oil', 'L', 'hydraulic', 40, 960],
    ['WGREASE', 'Wheel Bearing Grease', 'kg', 'grease', 15, 800],
    ['2T', '2T Two-Stroke Oil', 'L', 'engine_oil', 10, 1090],
    ['PETROL', 'Petrol', 'L', 'fuel', 200, 375],
  ];
  const prodId = {};
  for (const [code, name, unit, cat, ro, price] of products) {
    const info = run('INSERT INTO products (code, name, unit, category, reorder_level, unit_price) VALUES (?, ?, ?, ?, ?, ?)', code, name, unit, cat, ro, price);
    prodId[code] = info.lastInsertRowid;
    run('INSERT INTO product_prices (product_id, unit_price, effective_from) VALUES (?, ?, ?)', info.lastInsertRowid, price, EARLY);
  }

  // ---- labour rates (from "Labor Hour") ----
  const mechRates = [
    ['Anura', 425], ['Buddhika', 425], ['Chaminda', 250], ['Nuwan', 350],
    ['Saman', 300], ['Kasun', 400], ['Pradeep', 375], ['Ruwan', 325],
    ['Seethananda/seetha', 250], // a person known by two spellings (kept as one)
  ];
  for (const [m, r] of mechRates) {
    mechanicsLib.findOrCreateMechanic(m);          // canonical registry
    run('INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES (?, ?, ?)', m, r, EARLY);
  }
  // Resolver demo: "seetha" is an alias of "Seethananda/seetha"; "Vinod M" is an
  // unknown spelling queued for a human to link (mirrors the asset alias queue).
  const seeAlias = mechanicsLib.resolveMechanic('seetha', { source: 'seed' });
  mechanicsLib.linkMechanicAlias(seeAlias.aliasId, get('SELECT id FROM mechanics WHERE name_norm = ?', mechanicsLib.normalizeMechanic('Seethananda/seetha')).id);
  mechanicsLib.resolveMechanic('Vinod M', { source: 'seed' }); // stays pending

  // ---- assets (canonical fleet, real-style codes) ----
  const assets = [
    ['28-4314', 'Toyota', 'Double Cab', 'vehicle', 'CEP-03'],
    ['28-4315', 'Toyota', 'Double Cab', 'vehicle', 'MRW'],
    ['PB-1145', 'Nissan', 'Lorry', 'vehicle', 'IGM'],
    ['NC-8842', 'Ashok Leyland', 'Tipper', 'vehicle', 'MTR'],
    ['CAT-320', 'Caterpillar', 'Excavator', 'plant', 'IGM'],
    ['CAT-330', 'Caterpillar', 'Excavator', 'plant', 'MTR'],
    ['JCB-3DX', 'JCB', 'Backhoe Loader', 'plant', 'PC'],
    ['KOM-PC200', 'Komatsu', 'Excavator', 'plant', 'IGM'],
    ['HITA-200', 'Hitachi', 'Excavator', 'plant', 'MTR'],
    ['GEN-125', 'Cummins', '125kVA Generator', 'generator', 'PC'],
    ['GEN-250', 'Perkins', '250kVA Generator', 'generator', 'IGM'],
    ['RC-9021', 'Bomag', 'Road Roller', 'plant', 'MRW'],
    ['GRD-140', 'Caterpillar', 'Motor Grader', 'plant', 'MTR'],
    ['WL-966', 'Caterpillar', 'Wheel Loader', 'plant', 'IGM'],
    ['LT-5567', 'Isuzu', 'Water Bowser', 'vehicle', 'PC'],
    ['CM-7788', 'Mitsubishi', 'Concrete Mixer', 'plant', 'PC'],
    ['FL-2200', 'Toyota', 'Forklift', 'plant', 'BDG'],
    ['CP-4410', 'Atlas Copco', 'Air Compressor', 'tool', 'MTR'],
  ];
  const assetId = {};
  for (const [code, brand, type, cls, proj] of assets) {
    const a = aliases.findOrCreateAsset(code, { brand, type, asset_class: cls, home_project_id: projId[proj], current_project_id: projId[proj] });
    assetId[code] = a.id;
  }
  // running hours for a couple, to drive service-due
  run("UPDATE assets SET running_hours = 520 WHERE code = 'CAT-320'");
  run("UPDATE assets SET running_hours = 240 WHERE code = 'KOM-PC200'");

  // ---- service specs (from "Muthur plant") ----
  run('INSERT INTO service_specs (asset_id, machine_label, interval_hours, filter_cost, oil_qty, hydraulic_qty, transmission_qty, expected_cost, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    assetId['CAT-320'], 'CAT 320 Excavator', 500, 8500, 24, 120, 18, 42000, 'Every 500 hours');
  run('INSERT INTO service_specs (asset_id, machine_label, interval_hours, filter_cost, oil_qty, hydraulic_qty, transmission_qty, expected_cost, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    assetId['KOM-PC200'], 'Komatsu PC200', 500, 7800, 22, 110, 16, 38000, 'Every 500 hours');

  // ---- pending aliases (messy strings that need a human link) ----
  aliases.resolveAsset('SL-08, Waker (HC401199)', { source: 'import' });
  aliases.resolveAsset('Bowser lorry Port City', { source: 'import' });
  aliases.resolveAsset('28-4314 Double Cab', { source: 'import' }); // this one auto-resolves via extracted code

  // ---- store items (general consumables + spares) ----
  const genItems = [
    ['Cotton Waste', 'GEN-001', 'consumable', 'kg', 10, 8],
    ['Air Filter Element', 'FLT-AIR-01', 'filter', 'nos', 5, 12],
    ['Oil Filter', 'FLT-OIL-01', 'filter', 'nos', 8, 20],
    ['Hydraulic Filter', 'FLT-HYD-01', 'filter', 'nos', 4, 6],
    ['Welding Rods', 'GEN-002', 'consumable', 'kg', 5, 15],
  ];
  const itemId = {};
  for (const [name, pn, cat, unit, minStock, opening] of genItems) {
    const info = run('INSERT INTO store_items (name, part_number, category, unit, min_stock, is_general, balance) VALUES (?, ?, ?, ?, ?, 1, ?)', name, pn, cat, unit, minStock, opening);
    itemId[name] = info.lastInsertRowid;
    run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, txn_date, ref) VALUES (?, 'opening', ?, ?, ?, 'opening')", info.lastInsertRowid, opening, opening, EARLY);
  }
  // Non-general spare
  run("INSERT INTO store_items (name, part_number, category, unit, is_general) VALUES ('Brake Pad Set', 'BRK-PAD-01', 'spare', 'set', 0)");

  // ---- oil ledger: opening balances + recent receipts/issues (drives forecast) ----
  const seedLedger = (code, kind, qty, date, extra = {}) => {
    const pid = prodId[code];
    const prev = get('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', pid);
    const prevBal = prev ? prev.balance_after : 0;
    let signed;
    let bal;
    if (kind === 'opening') { bal = qty; signed = qty - prevBal; }
    else if (kind === 'issue') { signed = -qty; bal = prevBal - qty; }
    else { signed = qty; bal = prevBal + qty; }
    const price = extra.unit_price != null ? extra.unit_price : costing.productPriceOn(pid, date);
    run('INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, project_id, job_id, txn_date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      pid, kind, signed, bal, price, extra.asset_id || null, extra.project_id || null, extra.job_id || null, date, extra.note || null);
  };
  const today = new Date();
  const daysAgo = (n) => new Date(today.getTime() - n * 86400 * 1000).toISOString().slice(0, 10);
  for (const code of Object.keys(prodId)) seedLedger(code, 'opening', code === 'DIESEL' ? 800 : 100, daysAgo(120));
  // consumption over the window so forecast has a rate
  seedLedger('CI4', 'issue', 40, daysAgo(30), { asset_id: assetId['CAT-320'], project_id: projId.IGM });
  seedLedger('CI4', 'issue', 35, daysAgo(10), { asset_id: assetId['CAT-330'], project_id: projId.MTR });
  seedLedger('HD46', 'issue', 70, daysAgo(20), { asset_id: assetId['CAT-320'], project_id: projId.IGM });
  seedLedger('DIESEL', 'issue', 400, daysAgo(15), { project_id: projId.IGM });
  seedLedger('GREASE', 'issue', 20, daysAgo(25), { asset_id: assetId['JCB-3DX'] });

  // a stock count with variance
  run("INSERT INTO stock_counts (product_id, period, book_qty, counted_qty, variance, note, counted_by) VALUES (?, ?, ?, ?, ?, 'Monthly count', 'Sunil')",
    prodId.CI4, daysAgo(5).slice(0, 7), 25, 23, -2);

  // ---- demo anomalies so the "Needs Attention" panel is illustrative ----
  // Unusual consumption: GRD-140 sips 15W40 historically, then a recent 3x+ spike.
  seedLedger('15W40', 'issue', 5, daysAgo(80), { asset_id: assetId['GRD-140'] });
  seedLedger('15W40', 'issue', 5, daysAgo(50), { asset_id: assetId['GRD-140'] });
  seedLedger('15W40', 'issue', 30, daysAgo(3), { asset_id: assetId['GRD-140'] });
  // GRN price spike: same item, normal prices then a spike (20000 vs ~8600 avg).
  run("INSERT INTO grn (grn_no, description, qty, unit_price, supplier, purchase_source, invoice_date) VALUES ('GRN-90020','Brake Pad Set',1,8700,'Auto Parts Lanka','local_purchase',?)", daysAgo(20));
  run("INSERT INTO grn (grn_no, description, qty, unit_price, supplier, purchase_source, invoice_date) VALUES ('GRN-90031','Brake Pad Set',1,20000,'New Supplier','local_purchase',?)", daysAgo(2));
  // Duplicate MRN double-entry: same asset + item + qty + date on two MRNs.
  const dmA = run("INSERT INTO mrn (mrn_no, req_date, asset_id, purpose, requested_by, status) VALUES ('167444', ?, ?, 'Air filter', 'Kasun', 'open')", daysAgo(6), assetId['28-4315']).lastInsertRowid;
  run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Air Filter Element', 2, 'nos')", dmA);
  const dmB = run("INSERT INTO mrn (mrn_no, req_date, asset_id, purpose, requested_by, status) VALUES ('167445', ?, ?, 'Air filter', 'Kasun', 'open')", daysAgo(6), assetId['28-4315']).lastInsertRowid;
  run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Air Filter Element', 2, 'nos')", dmB);

  // ---- batteries (merged; includes the shared serial M158752495) ----
  const bat1 = run("INSERT INTO batteries (serial_no, brand, capacity_ah, condition, purchase_date, warranty_date, current_asset_id, state) VALUES ('M158752495', 'Exide', 150, 'new', ?, ?, ?, 'installed')",
    daysAgo(200), new Date(today.getTime() + 40 * 86400 * 1000).toISOString().slice(0, 10), assetId['28-4314']);
  run("INSERT INTO battery_events (battery_id, event_type, to_asset_id, reason, event_date) VALUES (?, 'add', ?, 'Migrated from both systems', ?)", bat1.lastInsertRowid, assetId['28-4314'], daysAgo(200));
  run("INSERT INTO battery_events (battery_id, event_type, to_asset_id, reason, event_date) VALUES (?, 'install', ?, 'Installed', ?)", bat1.lastInsertRowid, assetId['28-4314'], daysAgo(200));

  const bat2 = run("INSERT INTO batteries (serial_no, brand, capacity_ah, condition, purchase_date, state) VALUES ('AMR-778201', 'Amaron', 100, 'new', ?, 'in_store')", daysAgo(30));
  run("INSERT INTO battery_events (battery_id, event_type, reason, event_date) VALUES (?, 'add', 'New stock', ?)", bat2.lastInsertRowid, daysAgo(30));

  const bat3 = run("INSERT INTO batteries (serial_no, brand, capacity_ah, condition, purchase_date, warranty_date, current_asset_id, state) VALUES ('EXD-990112', 'Exide', 200, 'old', ?, ?, ?, 'installed')",
    daysAgo(400), new Date(today.getTime() + 20 * 86400 * 1000).toISOString().slice(0, 10), assetId['CAT-320']);
  run("INSERT INTO battery_events (battery_id, event_type, to_asset_id, reason, event_date) VALUES (?, 'install', ?, 'Installed', ?)", bat3.lastInsertRowid, assetId['CAT-320'], daysAgo(400));

  // ---- Stores documents: an MRN + GRN + an MTN ----
  const mrn1 = run("INSERT INTO mrn (mrn_no, req_date, asset_id, project_id, purpose, requested_by, status) VALUES ('167443', ?, ?, ?, 'Brake overhaul', 'Anura', 'received')", daysAgo(40), assetId['28-4314'], projId['CEP-03']);
  const mrnLine1 = run("INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received) VALUES (?, 'Brake Pad Set', 1, 'set', 1)", mrn1.lastInsertRowid);
  run("INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, supplier, invoice_no, invoice_date, delivery_date, purchase_source) VALUES ('GRN-90011', ?, ?, 'Brake Pad Set', 1, 8500, 'Auto Parts Lanka', 'INV-5521', ?, ?, 'local_purchase')",
    mrn1.lastInsertRowid, mrnLine1.lastInsertRowid, daysAgo(38), daysAgo(37));
  run("INSERT INTO mtn (mtn_no, txn_date, description, qty, from_location, to_location, from_asset_id, to_asset_id, transferred_by, received_by, reason) VALUES ('57815', ?, 'Hydraulic Filter', 2, 'Head Office Store', 'Iginimitiya Camp', NULL, ?, 'Store', 'Kasun', 'Stock replenish')",
    daysAgo(12), assetId['KOM-PC200']);

  // =====================================================================
  // JOB CARDS — three states to demonstrate the whole lifecycle
  // =====================================================================

  // Job A: historical CLOSED repair (2024/3/R/161), fully priced, snapshotted.
  const jobA = run(
    `INSERT INTO job_cards (job_no, asset_id, project_id, type, severity, description, status, requested_by,
        requested_at, approved_transport_at, approved_ops_at, started_at, completed_at, closed_at)
     VALUES ('2024/3/R/161', ?, ?, 'repair', 'major', 'Engine overhaul and brake system repair',
        'CLOSED', 'Anura', '2024-03-05', '2024-03-05', '2024-03-06', '2024-03-07', '2024-03-15', '2024-03-20')`,
    assetId['28-4314'], projId['CEP-03']
  ).lastInsertRowid;
  run("INSERT INTO job_approvals (job_id, role, decision, reason, created_at) VALUES (?, 'transport_manager', 'approved', 'Critical repair', '2024-03-05')", jobA);
  run("INSERT INTO job_approvals (job_id, role, decision, reason, created_at) VALUES (?, 'operational_manager', 'approved', 'Approved', '2024-03-06')", jobA);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, '2024-03-07', 'Anura', 'Strip engine', 8)", jobA);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, '2024-03-08', 'Buddhika', 'Rebuild head', 6)", jobA);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, '2024-03-10', 'Chaminda', 'Reassembly', 5)", jobA);
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'grn', 'Brake Pad Set', 1, 8500)", jobA);
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'issue', 'Gasket kit', 1, 4200)", jobA);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value) VALUES (?, '2024-03-12', NULL, 'Crankshaft grinding (outside)', 0, 1, 6500)", jobA);
  seedLedger('CI4', 'issue', 18, '2024-03-10', { asset_id: assetId['28-4314'], project_id: projId['CEP-03'], job_id: jobA, unit_price: 1250 });
  costing.snapshotJobCost(jobA);

  // Job B: at WORK_COMPLETE but blocked by the closure gate (one unpriced part).
  const jobB = run(
    `INSERT INTO job_cards (job_no, asset_id, project_id, type, severity, description, status, requested_by,
        requested_at, approved_transport_at, approved_ops_at, started_at, completed_at)
     VALUES ('2025/4/R/188', ?, ?, 'repair', 'minor', 'Hydraulic hose replacement',
        'WORK_COMPLETE', 'Kasun', ?, ?, ?, ?, ?)`,
    assetId['CAT-320'], projId['IGM'], daysAgo(9), daysAgo(9), daysAgo(8), daysAgo(7), daysAgo(2)
  ).lastInsertRowid;
  run("INSERT INTO job_approvals (job_id, role, decision, created_at) VALUES (?, 'transport_manager', 'approved', datetime('now'))", jobB);
  run("INSERT INTO job_approvals (job_id, role, decision, created_at) VALUES (?, 'operational_manager', 'approved', datetime('now'))", jobB);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'Nuwan', 'Replace hydraulic hose', 4)", jobB, daysAgo(3));
  run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'grn', 'Hydraulic hose 1m', 2, NULL)", jobB); // UNPRICED -> blocks closure
  seedLedger('HD46', 'issue', 12, daysAgo(3), { asset_id: assetId['CAT-320'], project_id: projId['IGM'], job_id: jobB, unit_price: 980 });
  costing.refreshJobTotals(jobB);

  // Job C: fresh service job awaiting approvals — service labour is a FLAT charge
  // (not hours×rate), demonstrating the second labour model.
  const jobC = run(
    `INSERT INTO job_cards (job_no, asset_id, project_id, type, severity, description, status, requested_by, requested_at, flat_labour)
     VALUES ('2025/7/S/12', ?, ?, 'service', 'minor', '500-hour service — filters + oil change', 'REQUESTED', 'Pradeep', ?, 1500)`,
    assetId['KOM-PC200'], projId['IGM'], daysAgo(1)
  ).lastInsertRowid;
  costing.refreshJobTotals(jobC);
});

console.log('Seed complete.');
console.log('Login: admin/admin, store/store, transport/transport, asst/asst, ops/ops, mech/mech, viewer/viewer');
db.close();
