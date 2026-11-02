'use strict';

/**
 * Migration 045: Fix General Item Issues, Lubricant Issues, Vehicle Attribution,
 * Material Transfers (MTN) and Stock Balance Reconciliation.
 *
 * Runs across both monolithic database (rawDb) and all workshop databases when multidb is active.
 */

const { rawDb, multidb } = require('../db');
const aliases = require('../lib/aliases');

function ensureCol(d, table, col, def) {
  const tbl = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tbl) return;
  const exists = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`Added column ${col} to ${table}`);
  }
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

  // 2. Fix Typo Dates
  console.log('Fixing typo dates...');
  targetDb.exec(`
    UPDATE issues SET issue_date = '2026-07' || substr(issue_date, 8) WHERE issue_date LIKE '0026-07-%';
    UPDATE issues SET issue_date = '2026-08' || substr(issue_date, 8) WHERE issue_date LIKE '0004-08-%';
    UPDATE stock_ledger SET txn_date = '2026-07' || substr(txn_date, 8) WHERE txn_date LIKE '0002-07-%';
    UPDATE stock_moves SET txn_date = '2026-07' || substr(txn_date, 8) WHERE txn_date LIKE '0026-07-%' OR txn_date LIKE '0002-07-%';
    UPDATE stock_moves SET txn_date = '2026-08' || substr(txn_date, 8) WHERE txn_date LIKE '0004-08-%';
  `);

  // 3. Resolve Missing Asset IDs on stock_ledger
  console.log('Resolving missing asset_id on stock_ledger...');
  const unlinkedOil = targetDb.prepare("SELECT id, consumer, job_id FROM stock_ledger WHERE kind = 'issue' AND asset_id IS NULL AND consumer IS NOT NULL").all();
  let resolvedOil = 0;
  for (const row of unlinkedOil) {
    let aid = null;
    if (row.job_id) {
      const j = targetDb.prepare('SELECT asset_id FROM job_cards WHERE id = ?').get(row.job_id);
      if (j && j.asset_id) aid = j.asset_id;
    }
    if (!aid && row.consumer) {
      const r = aliases.resolveAsset(row.consumer, { record: false });
      if (r.resolved && r.assetId) aid = r.assetId;
    }
    if (aid) {
      targetDb.prepare('UPDATE stock_ledger SET asset_id = ? WHERE id = ?').run(aid, row.id);
      resolvedOil++;
    }
  }
  console.log(`Resolved ${resolvedOil} / ${unlinkedOil.length} unlinked stock_ledger rows to vehicles.`);

  // Also check issues where asset_id IS NULL but job_id is populated
  const unlinkedIssues = targetDb.prepare('SELECT id, job_id, purpose, description FROM issues WHERE asset_id IS NULL AND job_id IS NOT NULL').all();
  let resolvedIssues = 0;
  for (const row of unlinkedIssues) {
    const j = targetDb.prepare('SELECT asset_id FROM job_cards WHERE id = ?').get(row.job_id);
    if (j && j.asset_id) {
      targetDb.prepare('UPDATE issues SET asset_id = ? WHERE id = ?').run(j.asset_id, row.id);
      resolvedIssues++;
    }
  }
  console.log(`Resolved ${resolvedIssues} unlinked issues rows from their job cards.`);

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

  // C) Newer issues -> general_item_txns (if general) and stock_ledger (if oil)
  console.log('Cross-syncing newer issues into general_item_txns and stock_ledger...');
  const recentIssues = targetDb.prepare(`
    SELECT i.id, i.asset_id, i.job_id, i.store_item_id, i.description, i.qty, i.unit_price, i.issue_date, i.issued_by, i.category, i.store_id, i.physical_store_id,
           si.is_general, si.balance AS item_balance
      FROM issues i
      LEFT JOIN store_items si ON si.id = i.store_item_id
     WHERE i.source_table IS NULL
       AND COALESCE(i.voided, 0) = 0
  `).all();

  const lubricants = require('../lib/lubricants');
  let newGitSynced = 0;
  let newSlSynced = 0;

  for (const iss of recentIssues) {
    const isLube = iss.category === 'Lubricants' || lubricants.isLubricant(iss.description, iss.issue_date);
    if (isLube) {
      const match = lubricants.resolveLubricant(iss.description, { record: false, on: iss.issue_date });
      if (match.resolved && match.productId) {
        const already = targetDb.prepare('SELECT id FROM stock_ledger WHERE source_issue_id = ?').get(iss.id);
        if (!already) {
          const prev = (targetDb.prepare('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY txn_date DESC, id DESC LIMIT 1').get(match.productId) || {}).balance_after || 0;
          const newBal = prev - Math.abs(iss.qty);
          targetDb.prepare(`
            INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, job_id, consumer, mr_no, txn_date, store_id, physical_store_id, source_issue_id)
            VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(match.productId, -Math.abs(iss.qty), newBal, iss.unit_price, iss.asset_id, iss.job_id, iss.description, 'Store Issue', iss.issue_date, iss.store_id || 1, iss.physical_store_id || 2, iss.id);
          newSlSynced++;
        }
      }
    } else if (iss.store_item_id && iss.is_general) {
      const already = targetDb.prepare('SELECT id FROM general_item_txns WHERE source_issue_id = ?').get(iss.id);
      if (!already) {
        const prev = (targetDb.prepare('SELECT balance_after FROM general_item_txns WHERE store_item_id = ? ORDER BY txn_date DESC, id DESC LIMIT 1').get(iss.store_item_id) || {}).balance_after || iss.item_balance || 0;
        const newBal = prev - Math.abs(iss.qty);
        targetDb.prepare(`
          INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, asset_id, job_id, ref, txn_date, store_id, physical_store_id, source_issue_id)
          VALUES (?, 'issue', ?, ?, ?, ?, ?, 'Store Issue', ?, ?, ?, ?)
        `).run(iss.store_item_id, -Math.abs(iss.qty), newBal, iss.unit_price, iss.asset_id, iss.job_id, iss.issue_date, iss.store_id || 1, iss.physical_store_id || 2, iss.id);
        newGitSynced++;
      }
    }
  }
  console.log(`Synced ${newGitSynced} recent general issues to general_item_txns, ${newSlSynced} recent oil issues to stock_ledger.`);

  // 7. Synchronize store_items.balance and products.stock_qty
  console.log('Synchronizing store_items.balance and products.stock_qty...');
  const products = targetDb.prepare('SELECT id FROM products').all();
  for (const p of products) {
    const lastRow = targetDb.prepare('SELECT balance_after FROM stock_ledger WHERE product_id = ? AND COALESCE(voided, 0) = 0 ORDER BY txn_date DESC, id DESC LIMIT 1').get(p.id);
    if (lastRow && lastRow.balance_after != null) {
      targetDb.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(lastRow.balance_after, p.id);
    }
  }

  const generalItems = targetDb.prepare('SELECT id FROM store_items WHERE is_general = 1').all();
  for (const gi of generalItems) {
    const lastRow = targetDb.prepare('SELECT balance_after FROM general_item_txns WHERE store_item_id = ? ORDER BY txn_date DESC, id DESC LIMIT 1').get(gi.id);
    if (lastRow && lastRow.balance_after != null) {
      targetDb.prepare('UPDATE store_items SET balance = ? WHERE id = ?').run(lastRow.balance_after, gi.id);
    }
  }
}

function runMigration() {
  console.log('=== Starting Migration 045 ===');

  // Migrate rawDb
  migrateSingleDb(rawDb, 'rawDb (workshopone.db)');

  // Migrate all workshop databases if multidb is active
  if (multidb.isMultiDb()) {
    const wsList = multidb.listWorkshopDatabases();
    console.log(`Found ${wsList.length} workshop database(s).`);
    for (const ws of wsList) {
      multidb.withWorkshop(ws.id, () => {
        migrateSingleDb(multidb.activeDb(), `Workshop ${ws.code} (id: ${ws.id})`);
        console.log(`Rebuilding stock_moves for workshop ${ws.code}...`);
        const stock = require('../lib/stock');
        const rep = stock.rebuild({ wipe: true });
        console.log(`stock_moves rebuild completed for workshop ${ws.code}:`, rep);
      });
    }
  } else {
    console.log('Rebuilding stock_moves for rawDb...');
    const stock = require('../lib/stock');
    const rep = stock.rebuild({ wipe: true });
    console.log('stock_moves rebuild completed:', rep);
  }

  // Recalculate vehicle_monthly_costs
  console.log('\nRecalculating vehicle_monthly_costs...');
  const costing = require('../lib/costing');
  const { all } = require('../db');
  const vMonths = all(`
    SELECT DISTINCT asset_id, substr(issue_date, 1, 7) ym FROM issues WHERE asset_id IS NOT NULL AND issue_date IS NOT NULL
    UNION
    SELECT DISTINCT j.asset_id, substr(jl.work_date, 1, 7) ym FROM job_labour jl JOIN job_cards j ON j.id = jl.job_id WHERE j.asset_id IS NOT NULL AND jl.work_date IS NOT NULL
  `);

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
