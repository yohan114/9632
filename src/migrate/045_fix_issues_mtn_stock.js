'use strict';

/**
 * Migration 045: Fix General Item Issues, Lubricant Issues, Vehicle Attribution,
 * Material Transfers (MTN) and Stock Balance Reconciliation.
 *
 * Runs across both monolithic database (rawDb) and all workshop databases when multidb is active.
 * Idempotent: safe to run on every boot / deploy.
 */

const { rawDb, multidb } = require('../db');
const aliases = require('../lib/aliases');
const lubricants = require('../lib/lubricants');

function ensureCol(d, table, col, def) {
  const tbl = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tbl) return;
  const exists = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`Added column ${col} to ${table}`);
  }
}

function resolveAssetResilient(targetDb, text) {
  if (!text) return null;
  const raw = String(text).trim();
  const norm = aliases.normalize(raw);
  if (!norm) return null;

  // 1. Try aliases resolver
  try {
    const res = aliases.resolveAsset(raw, { record: false });
    if (res && res.resolved && res.assetId) return res.assetId;
  } catch {}

  // 2. Direct code_norm match
  let a = targetDb.prepare('SELECT id FROM assets WHERE code_norm = ? LIMIT 1').get(norm);
  if (a) return a.id;

  // 3. Normalized registration match
  a = targetDb.prepare("SELECT id FROM assets WHERE UPPER(REPLACE(REPLACE(registration, '-', ''), ' ', '')) = ? LIMIT 1").get(norm);
  if (a) return a.id;

  // 4. Normalized ec_code match
  a = targetDb.prepare("SELECT id FROM assets WHERE UPPER(REPLACE(REPLACE(ec_code, '-', ''), ' ', '')) = ? LIMIT 1").get(norm);
  if (a) return a.id;

  // 5. Code token extraction
  const token = aliases.extractCode(raw);
  if (token) {
    const tNorm = aliases.normalize(token);
    if (tNorm && tNorm !== norm) {
      a = targetDb.prepare('SELECT id FROM assets WHERE code_norm = ? LIMIT 1').get(tNorm);
      if (a) return a.id;
    }
  }

  // 6. Service truck
  if (raw.toUpperCase().startsWith('SERVICE TRUCK')) {
    a = targetDb.prepare("SELECT id FROM assets WHERE code LIKE 'Service Truck%' LIMIT 1").get();
    if (a) return a.id;
  }

  return null;
}

function resolveProject(targetDb, text) {
  if (!text) return null;
  const t = String(text).toUpperCase();
  const prjs = targetDb.prepare('SELECT id, name FROM projects').all();
  for (const p of prjs) {
    const pName = p.name.toUpperCase();
    if (t.includes('MARAWILA') && pName.includes('MARAWILA')) return p.id;
    if (t.includes('RUWANWELLA') && pName.includes('RUWANWELLA')) return p.id;
    if (t.includes('BATTICALOA') && pName.includes('BATTICALOA')) return p.id;
    if (t.includes('BATTICOLOA') && pName.includes('BATTICALOA')) return p.id;
    if (t.includes('IGINIMITIYA') && pName.includes('IGINIMITIYA')) return p.id;
    if (t.includes('MUTHUR') && pName.includes('MUTHUR')) return p.id;
    if (t.includes('CEP-03') && pName.includes('CEP-03')) return p.id;
    if (t.includes('PORT CITY') && pName.includes('PORT CITY')) return p.id;
    if (t.includes('AWISSAWELLA') && pName.includes('AWISSAWELLA')) return p.id;
    if (t.includes('MUSALI') && pName.includes('MUSALI')) return p.id;
  }
  return null;
}

function resolveProductResilient(targetDb, desc, date) {
  if (!desc) return null;
  try {
    const match = lubricants.resolveLubricant(desc, { record: false, on: date });
    if (match && match.resolved && match.productId) return match.productId;
  } catch {}

  const d = String(desc).toUpperCase();
  if (d.includes('BREAK OIL') || d.includes('BRAKE OIL')) {
    const p = targetDb.prepare("SELECT id FROM products WHERE name LIKE '%Brake Oil%' OR name LIKE '%Break Oil%' LIMIT 1").get();
    if (p) return p.id;
  }
  if (d.includes('RUBBER GREASE')) {
    const p = targetDb.prepare("SELECT id FROM products WHERE name = 'Rubber Grease' LIMIT 1").get();
    if (p) return p.id;
  }
  if (d.includes('WD-40') || d.includes('WD 40')) {
    const p = targetDb.prepare("SELECT id FROM products WHERE name = 'WD-40' LIMIT 1").get();
    if (p) return p.id;
  }
  if (d.includes('CV GREASE')) {
    const p = targetDb.prepare("SELECT id FROM products WHERE name = 'CV Grease' LIMIT 1").get();
    if (p) return p.id;
  }
  if (d.includes('COOLANT')) {
    const p = targetDb.prepare("SELECT id FROM products WHERE name = 'Coolant' LIMIT 1").get();
    if (p) return p.id;
  }
  if (d.includes('PETROL ENGINE OIL')) {
    const p = targetDb.prepare("SELECT id FROM products WHERE name = '20W-50' OR category = 'engine_oil' LIMIT 1").get();
    if (p) return p.id;
  }
  if (d.includes('HAVOLINE')) {
    const p = targetDb.prepare("SELECT id FROM products WHERE name LIKE 'Havoline%' LIMIT 1").get();
    if (p) return p.id;
  }
  if (d.includes('GREASE') && !d.includes('SEAL') && !d.includes('GUN') && !d.includes('NOZZLE')) {
    const p = targetDb.prepare("SELECT id FROM products WHERE name = 'Grease' LIMIT 1").get();
    if (p) return p.id;
  }
  return null;
}

function migrateSingleDb(targetDb, label) {
  console.log(`\n--- Migrating ${label} ---`);

  // 1. Ensure columns exist
  ensureCol(targetDb, 'issues', 'source_table', 'TEXT');
  ensureCol(targetDb, 'issues', 'source_id', 'INTEGER');
  ensureCol(targetDb, 'general_item_txns', 'source_issue_id', 'INTEGER');
  ensureCol(targetDb, 'stock_ledger', 'source_issue_id', 'INTEGER');

  targetDb.exec('CREATE INDEX IF NOT EXISTS idx_issues_src ON issues(source_table, source_id);');
  targetDb.exec('CREATE INDEX IF NOT EXISTS idx_git_src_issue ON general_item_txns(source_issue_id);');
  targetDb.exec('CREATE INDEX IF NOT EXISTS idx_sl_src_issue ON stock_ledger(source_issue_id);');

  // Seed lubricant catalogue aliases
  try {
    lubricants.seedCatalogueAliases();
  } catch (e) {
    console.warn('Catalogue alias seeding warning:', e.message);
  }

  // 2. Fix Typo Dates
  console.log('Fixing typo dates...');
  targetDb.exec(`
    UPDATE issues SET issue_date = '2026-07' || substr(issue_date, 8) WHERE issue_date LIKE '0026-07-%';
    UPDATE issues SET issue_date = '2026-08' || substr(issue_date, 8) WHERE issue_date LIKE '0004-08-%';
    UPDATE stock_ledger SET txn_date = '2026-07' || substr(txn_date, 8) WHERE txn_date LIKE '0002-07-%';
    UPDATE stock_moves SET txn_date = '2026-07' || substr(txn_date, 8) WHERE txn_date LIKE '0026-07-%' OR txn_date LIKE '0002-07-%';
    UPDATE stock_moves SET txn_date = '2026-08' || substr(txn_date, 8) WHERE txn_date LIKE '0004-08-%';
  `);

  // 3. Resolve Missing Asset IDs & Project IDs on stock_ledger
  console.log('Resolving missing asset_id & project_id on stock_ledger...');
  const unlinkedOil = targetDb.prepare("SELECT id, consumer, mr_no, job_id, source_issue_id, project_id FROM stock_ledger WHERE kind = 'issue' AND (asset_id IS NULL OR project_id IS NULL)").all();
  let resolvedOil = 0;
  let resolvedPrj = 0;
  for (const row of unlinkedOil) {
    let aid = null;
    if (row.job_id) {
      const j = targetDb.prepare('SELECT asset_id FROM job_cards WHERE id = ?').get(row.job_id);
      if (j && j.asset_id) aid = j.asset_id;
    }
    if (!aid && row.source_issue_id) {
      const i = targetDb.prepare('SELECT asset_id FROM issues WHERE id = ?').get(row.source_issue_id);
      if (i && i.asset_id) aid = i.asset_id;
    }
    if (!aid) {
      aid = resolveAssetResilient(targetDb, row.consumer) || resolveAssetResilient(targetDb, row.mr_no);
    }
    if (aid) {
      targetDb.prepare('UPDATE stock_ledger SET asset_id = ? WHERE id = ?').run(aid, row.id);
      resolvedOil++;
    }

    if (!row.project_id) {
      const prjId = resolveProject(targetDb, row.consumer) || resolveProject(targetDb, row.mr_no);
      if (prjId) {
        targetDb.prepare('UPDATE stock_ledger SET project_id = ? WHERE id = ?').run(prjId, row.id);
        resolvedPrj++;
      }
    }
  }
  console.log(`Resolved ${resolvedOil} vehicles, ${resolvedPrj} projects on stock_ledger.`);

  // Also check issues where asset_id IS NULL but job_id or purpose has vehicle
  const unlinkedIssues = targetDb.prepare('SELECT id, job_id, purpose, description FROM issues WHERE asset_id IS NULL').all();
  let resolvedIssues = 0;
  for (const row of unlinkedIssues) {
    let aid = null;
    if (row.job_id) {
      const j = targetDb.prepare('SELECT asset_id FROM job_cards WHERE id = ?').get(row.job_id);
      if (j && j.asset_id) aid = j.asset_id;
    }
    if (!aid) {
      aid = resolveAssetResilient(targetDb, row.purpose) || resolveAssetResilient(targetDb, row.description);
    }
    if (aid) {
      targetDb.prepare('UPDATE issues SET asset_id = ? WHERE id = ?').run(aid, row.id);
      resolvedIssues++;
    }
  }
  console.log(`Resolved ${resolvedIssues} unlinked issues rows to vehicles.`);

  // 4. Backfill Missing Unit Prices
  console.log('Backfilling missing unit prices...');
  const gitPrices = targetDb.prepare(`
    UPDATE general_item_txns
       SET unit_price = (SELECT si.unit_cost FROM store_items si WHERE si.id = general_item_txns.store_item_id)
     WHERE (unit_price IS NULL OR unit_price = 0)
       AND EXISTS (SELECT 1 FROM store_items si WHERE si.id = general_item_txns.store_item_id AND si.unit_cost > 0)
  `).run();
  console.log(`Backfilled unit_price on ${gitPrices.changes} general_item_txns rows from store_items.`);

  const slPrices = targetDb.prepare(`
    UPDATE stock_ledger
       SET unit_price = (SELECT pr.unit_price FROM products pr WHERE pr.id = stock_ledger.product_id)
     WHERE (unit_price IS NULL OR unit_price = 0)
       AND EXISTS (SELECT 1 FROM products pr WHERE pr.id = stock_ledger.product_id AND pr.unit_price > 0)
  `).run();
  console.log(`Backfilled unit_price on ${slPrices.changes} stock_ledger rows from products.`);

  const issPrices = targetDb.prepare(`
    UPDATE issues
       SET unit_price = (SELECT si.unit_cost FROM store_items si WHERE si.id = issues.store_item_id)
     WHERE (unit_price IS NULL OR unit_price = 0)
       AND store_item_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM store_items si WHERE si.id = issues.store_item_id AND si.unit_cost > 0)
  `).run();
  console.log(`Backfilled unit_price on ${issPrices.changes} issues rows from store_items.`);

  // Backfill oil issue prices from products if still null/0
  const issOilPrices = targetDb.prepare(`
    UPDATE issues
       SET unit_price = (SELECT pr.unit_price FROM products pr WHERE UPPER(pr.name) = UPPER(issues.description) LIMIT 1)
     WHERE (unit_price IS NULL OR unit_price = 0)
       AND (LOWER(category) LIKE '%lubric%' OR LOWER(category) LIKE '%oil%')
       AND EXISTS (SELECT 1 FROM products pr WHERE UPPER(pr.name) = UPPER(issues.description) AND pr.unit_price > 0)
  `).run();
  console.log(`Backfilled unit_price on ${issOilPrices.changes} oil issues from products.`);

  // 5. Material Transfers (MTN) Normalization & Stamping
  console.log('Normalizing and stamping Material Transfers (MTN)...');
  const locMap = {
    'MAIN STORES': 1, 'CENTRAL MAIN STORES': 1, 'MAIN STORE': 1,
    'WORK SHOP STORES': 2, 'BADALGAMA WORK SHOP STORES': 2, 'CENTRAL STORE BADALGAMA': 2, 'CENTRAL WORKSHOP': 2,
    'GALAGEDARA': 3, 'SITE-STORE-GWS': 3, 'CEP/03 GALAGEDARA': 3,
    'CEP-03': 4, 'CEP-03 WADAKADA': 4, 'CEP-03 WADAKADA MECHANIC': 4, 'CEP-03(E)': 4,
    'RUWANWELLA': 5, 'RUWANWELLA WATER PROJECT': 5,
    'MARAWILA': 6, 'MARAWILA ROAD PROJECT': 6,
    'BATTICALOA': 7, 'BATTICALOA LOT/2': 7, 'BATTICALOA LOT/3': 7, 'BATTICALOA WORK SHOP': 7, 'BATTICALOA LOT 03': 7, 'BATTICOLOA': 7,
    'MUTHUR': 8, 'MUTHUR PLANT': 8,
  };

  const normLoc = (str) => {
    if (!str) return null;
    const cleanStr = String(str).toUpperCase().replace(/[^A-Z0-9/ ]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [k, id] of Object.entries(locMap)) {
      if (cleanStr.includes(k) || k.includes(cleanStr)) return id;
    }
    return null;
  };

  const allMtns = targetDb.prepare('SELECT id, from_location, to_location, from_place, to_place, workshop_id, status FROM mtn').all();
  for (const m of allMtns) {
    let fromLocId = normLoc(m.from_location) || normLoc(m.from_place) || (m.workshop_id === 2 ? 3 : 2);
    let toLocId = normLoc(m.to_location) || normLoc(m.to_place);

    let fromStoreId = fromLocId === 3 ? 2 : 1;
    let toStoreId = toLocId === 3 ? 2 : (toLocId ? 1 : null);

    targetDb.prepare(`UPDATE mtn SET from_store_location_id = ?, to_store_location_id = ?, from_store_id = ?, to_store_id = ? WHERE id = ?`).run(
      fromLocId, toLocId, fromStoreId, toStoreId, m.id);

    targetDb.prepare(`UPDATE mtn_lines SET from_store_location_id = ?, to_store_location_id = ?, from_store_id = ?, to_store_id = ? WHERE mtn_id = ?`).run(
      fromLocId, toLocId, fromStoreId, toStoreId, m.id);

    if (m.status === 'draft' || !m.status) {
      targetDb.prepare(`UPDATE mtn SET status = 'dispatched' WHERE id = ?`).run(m.id);
    }
  }
  console.log(`Stamped and activated ${allMtns.length} Material Transfers.`);

  // 6. Cross-Sync Historical Issues
  // A) general_item_txns -> issues
  console.log('Cross-syncing historical general_item_txns into issues...');
  const gitIssues = targetDb.prepare(`
    SELECT t.id, t.store_item_id, t.qty, t.balance_after, t.asset_id, t.job_id, t.unit_price, t.ref, t.txn_date, t.store_id, t.physical_store_id,
           si.name AS item_name, si.unit_cost, si.category
      FROM general_item_txns t
      JOIN store_items si ON si.id = t.store_item_id
     WHERE t.txn_type = 'issue'
       AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.source_table = 'general_item_txns' AND i.source_id = t.id)
       AND t.source_issue_id IS NULL
  `).all();

  let syncedGit = 0;
  for (const g of gitIssues) {
    const price = g.unit_price != null && g.unit_price > 0 ? g.unit_price : (g.unit_cost || 0);
    const info = targetDb.prepare(`
      INSERT INTO issues (asset_id, job_id, store_item_id, description, qty, unit_price, issue_date, issued_by, category, purpose, source_table, source_id, store_id, physical_store_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Store Keeper', COALESCE(?, 'General Items'), ?, 'general_item_txns', ?, ?, ?)
    `).run(g.asset_id || null, g.job_id || null, g.store_item_id, g.item_name, Math.abs(g.qty), price, g.txn_date, g.category, g.ref, g.id, g.store_id || 1, g.physical_store_id || 2);
    targetDb.prepare('UPDATE general_item_txns SET source_issue_id = ? WHERE id = ?').run(info.lastInsertRowid, g.id);
    syncedGit++;
  }
  console.log(`Cross-synced ${syncedGit} general_item_txns issues into issues table.`);

  // B) stock_ledger issues -> issues
  console.log('Cross-syncing historical stock_ledger issues into issues...');
  const slIssues = targetDb.prepare(`
    SELECT sl.id, sl.product_id, sl.qty, sl.balance_after, sl.unit_price, sl.asset_id, sl.job_id, sl.consumer, sl.mr_no, sl.txn_date, sl.store_id, sl.physical_store_id,
           p.name AS product_name, p.unit_price AS prod_price
      FROM stock_ledger sl
      JOIN products p ON p.id = sl.product_id
     WHERE sl.kind = 'issue'
       AND COALESCE(sl.voided, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.source_table = 'stock_ledger' AND i.source_id = sl.id)
       AND sl.source_issue_id IS NULL
  `).all();

  let syncedSl = 0;
  for (const s of slIssues) {
    const price = s.unit_price != null && s.unit_price > 0 ? s.unit_price : (s.prod_price || 0);
    const info = targetDb.prepare(`
      INSERT INTO issues (asset_id, job_id, store_item_id, description, qty, unit_price, issue_date, issued_by, category, purpose, source_table, source_id, store_id, physical_store_id)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 'Store Keeper', 'Lubricants', ?, 'stock_ledger', ?, ?, ?)
    `).run(s.asset_id || null, s.job_id || null, s.product_name, Math.abs(s.qty), price, s.txn_date, s.consumer || s.mr_no, s.id, s.store_id || 1, s.physical_store_id || 2);
    targetDb.prepare('UPDATE stock_ledger SET source_issue_id = ? WHERE id = ?').run(info.lastInsertRowid, s.id);
    syncedSl++;
  }
  console.log(`Cross-synced ${syncedSl} stock_ledger issues into issues table.`);

  // C) Cross-Sync ALL lubricant issues from issues table into stock_ledger
  console.log('Cross-syncing all lubricant issues into stock_ledger...');
  const unlinkedLubeIssues = targetDb.prepare(`
    SELECT i.id, i.asset_id, i.job_id, i.store_item_id, i.description, i.qty, i.unit_price, i.issue_date, i.issued_by, i.category, i.purpose, i.store_id, i.physical_store_id
      FROM issues i
     WHERE (LOWER(i.category) LIKE '%lubric%' OR LOWER(i.category) LIKE '%oil%' OR LOWER(i.category) LIKE '%fluid%')
       AND COALESCE(i.voided, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.source_issue_id = i.id OR (i.source_table = 'stock_ledger' AND sl.id = i.source_id))
  `).all();

  let newSlSynced = 0;
  for (const iss of unlinkedLubeIssues) {
    const prodId = resolveProductResilient(targetDb, iss.description, iss.issue_date);
    if (prodId) {
      const prod = targetDb.prepare('SELECT unit_price FROM products WHERE id = ?').get(prodId);
      const price = iss.unit_price != null && iss.unit_price > 0 ? iss.unit_price : (prod?.unit_price || 0);
      const prev = (targetDb.prepare('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY txn_date DESC, id DESC LIMIT 1').get(prodId) || {}).balance_after || 0;
      const newBal = prev - Math.abs(iss.qty);

      let assetId = iss.asset_id;
      if (!assetId && iss.job_id) {
        const j = targetDb.prepare('SELECT asset_id FROM job_cards WHERE id = ?').get(iss.job_id);
        if (j && j.asset_id) assetId = j.asset_id;
      }
      if (!assetId) {
        assetId = resolveAssetResilient(targetDb, iss.purpose) || resolveAssetResilient(targetDb, iss.description);
      }

      const prjId = resolveProject(targetDb, iss.purpose) || resolveProject(targetDb, iss.description);

      targetDb.prepare(`
        INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, project_id, job_id, consumer, mr_no, txn_date, store_id, physical_store_id, source_issue_id)
        VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(prodId, -Math.abs(iss.qty), newBal, price, assetId || null, prjId || null, iss.job_id || null, iss.purpose || iss.description, 'Store Issue', iss.issue_date, iss.store_id || 1, iss.physical_store_id || 2, iss.id);
      newSlSynced++;
    }
  }
  console.log(`Cross-synced ${newSlSynced} lubricant issues into stock_ledger.`);

  // 7. Synchronize store_items.balance and products.stock_qty
  console.log('Synchronizing store_items.balance and products.stock_qty...');
  const products = targetDb.prepare('SELECT id FROM products').all();
  for (const p of products) {
    const lastRow = targetDb.prepare('SELECT balance_after FROM stock_ledger WHERE product_id = ? AND COALESCE(voided, 0) = 0 ORDER BY txn_date DESC, id DESC LIMIT 1').get(p.id);
    if (lastRow && lastRow.balance_after != null) {
      targetDb.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(lastRow.balance_after, p.id);
    }
  }

  const items = targetDb.prepare('SELECT id FROM store_items').all();
  for (const item of items) {
    const lastRow = targetDb.prepare('SELECT balance_after FROM general_item_txns WHERE store_item_id = ? ORDER BY txn_date DESC, id DESC LIMIT 1').get(item.id);
    if (lastRow && lastRow.balance_after != null) {
      targetDb.prepare('UPDATE store_items SET balance = ? WHERE id = ?').run(lastRow.balance_after, item.id);
    }
  }

  console.log(`Synchronized stock quantities for ${products.length} products and ${items.length} store items.`);
}

function runMigration(optionalDb) {
  console.log('=== Running Migration 045: Issues, Stock & Lubricant Report Fix ===');

  if (optionalDb) {
    migrateSingleDb(optionalDb, 'Database instance');
  } else {
    migrateSingleDb(rawDb, 'Monolithic (rawDb)');
  }

  if (multidb.isMultiDb()) {
    const wsList = multidb.listWorkshopDatabases();
    console.log(`Found ${wsList.length} workshop database(s).`);
    for (const ws of wsList) {
      multidb.withWorkshop(ws.id, () => {
        migrateSingleDb(multidb.activeDb(), `Workshop ${ws.code} (id: ${ws.id})`);
        try {
          const stock = require('../lib/stock');
          stock.rebuild({ wipe: true });
        } catch {}
      });
    }
  } else {
    try {
      const stock = require('../lib/stock');
      stock.rebuild({ wipe: true });
    } catch (e) {
      console.warn('stock_moves rebuild skipped:', e.message);
    }
  }

  // Recalculate vehicle_monthly_costs
  console.log('\nRecalculating vehicle_monthly_costs...');
  const costing = require('../lib/costing');
  const targetDb = optionalDb || rawDb;
  const vMonths = targetDb.prepare(`
    SELECT DISTINCT asset_id, substr(issue_date, 1, 7) ym FROM issues WHERE asset_id IS NOT NULL AND issue_date IS NOT NULL
    UNION
    SELECT DISTINCT j.asset_id, substr(jl.work_date, 1, 7) ym FROM job_labour jl JOIN job_cards j ON j.id = jl.job_id WHERE j.asset_id IS NOT NULL AND jl.work_date IS NOT NULL
    UNION
    SELECT DISTINCT sl.asset_id, substr(sl.txn_date, 1, 7) ym FROM stock_ledger sl WHERE sl.asset_id IS NOT NULL AND sl.txn_date IS NOT NULL
  `).all();

  let recalced = 0;
  for (const vm of vMonths) {
    if (!vm.asset_id || !vm.ym || !/^\d{4}-\d{2}$/.test(vm.ym)) continue;
    const [yr, mo] = vm.ym.split('-').map(Number);
    if (yr < 2020 || yr > 2030) continue;
    costing.recalcVehicleMonth(vm.asset_id, yr, mo);
    recalced++;
  }
  console.log(`Recalculated monthly costs for ${recalced} vehicle-month combinations.`);

  console.log('=== Migration 045 Completed Successfully ===');
}

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
