'use strict';

/**
 * Migration 046: Cross-Sync General Item Issues, Link store_items, and Reconcile Balances.
 *
 * Backfills unlinked General Store Issues (Consumables, Hardware, Electrical, Tools, Bearings,
 * Cotton Waste, etc.) from `issues` into `general_item_txns`, ensures store_items rows exist
 * with is_general = 1, sets running balances, and recalculates vehicle monthly rollups.
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

  try {
    const res = aliases.resolveAsset(raw, { record: false });
    if (res && res.resolved && res.assetId) return res.assetId;
  } catch {}

  let a = targetDb.prepare('SELECT id FROM assets WHERE code_norm = ? LIMIT 1').get(norm);
  if (a) return a.id;

  a = targetDb.prepare("SELECT id FROM assets WHERE UPPER(REPLACE(REPLACE(registration, '-', ''), ' ', '')) = ? LIMIT 1").get(norm);
  if (a) return a.id;

  a = targetDb.prepare("SELECT id FROM assets WHERE UPPER(REPLACE(REPLACE(ec_code, '-', ''), ' ', '')) = ? LIMIT 1").get(norm);
  if (a) return a.id;

  const token = aliases.extractCode(raw);
  if (token) {
    const tNorm = aliases.normalize(token);
    if (tNorm && tNorm !== norm) {
      a = targetDb.prepare('SELECT id FROM assets WHERE code_norm = ? LIMIT 1').get(tNorm);
      if (a) return a.id;
    }
  }

  if (raw.toUpperCase().startsWith('SERVICE TRUCK')) {
    a = targetDb.prepare("SELECT id FROM assets WHERE code LIKE 'Service Truck%' LIMIT 1").get();
    if (a) return a.id;
  }

  return null;
}

function migrateSingleDb(targetDb, label) {
  console.log(`\n--- [046] Migrating ${label} ---`);

  ensureCol(targetDb, 'general_item_txns', 'source_issue_id', 'INTEGER');
  ensureCol(targetDb, 'issues', 'store_item_id', 'INTEGER');
  ensureCol(targetDb, 'store_items', 'is_general', 'INTEGER DEFAULT 0');

  targetDb.exec('CREATE INDEX IF NOT EXISTS idx_git_src_issue ON general_item_txns(source_issue_id);');
  targetDb.exec('CREATE INDEX IF NOT EXISTS idx_issues_store_item ON issues(store_item_id);');

  // Find candidate unlinked issues in issues table
  const candidates = targetDb.prepare(`
    SELECT i.id, i.asset_id, i.job_id, i.store_item_id, i.description, i.qty, i.unit_price, i.issue_date,
           i.issued_by, i.category, i.purpose, i.store_id, i.physical_store_id, i.min_no
      FROM issues i
     WHERE COALESCE(i.voided, 0) = 0
       AND (i.source_table IS NULL OR i.source_table NOT IN ('general_item_txns', 'stock_ledger'))
       AND NOT EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.source_issue_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM general_item_txns git WHERE git.source_issue_id = i.id)
       AND i.grn_id IS NULL
       AND i.mrn_no IS NULL
       AND i.mrn_line_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM job_parts jp
          WHERE jp.job_id = i.job_id
            AND (jp.source_type = 'issue' OR jp.mrn_line_id = i.id OR LOWER(TRIM(jp.description)) = LOWER(TRIM(i.description)))
       )
       AND COALESCE(i.category, '') NOT IN ('Battery', 'Tyres & Wheels', 'Filters')
       AND LOWER(i.description) NOT LIKE '%filter%'
  `).all();

  console.log(`Found ${candidates.length} unlinked candidate issues in ${label}`);
  if (!candidates.length) {
    console.log(`No unlinked general item issues to sync in ${label}.`);
    return;
  }

  let oilsSynced = 0;
  let generalSynced = 0;

  targetDb.transaction(() => {
    for (const iss of candidates) {
      const desc = String(iss.description || '').trim();
      const isCotton = desc.toUpperCase().includes('COTTON');
      const match = !isCotton ? lubricants.resolveLubricant(desc, { record: false, on: iss.issue_date }) : { resolved: false };

      // Check if this issue is an actual lubricant/oil product
      let prodId = match.resolved && match.productId ? match.productId : null;
      if (!prodId) {
        const d = desc.toUpperCase();
        if (d.includes('BREAK OIL') || d.includes('BRAKE OIL')) {
          prodId = (targetDb.prepare("SELECT id FROM products WHERE name LIKE '%Brake Oil%' LIMIT 1").get() || {}).id;
        } else if (d.includes('RUBBER GREASE')) {
          prodId = (targetDb.prepare("SELECT id FROM products WHERE name = 'Rubber Grease' LIMIT 1").get() || {}).id;
        } else if (d.includes('WD-40') || d.includes('WD 40')) {
          prodId = (targetDb.prepare("SELECT id FROM products WHERE name = 'WD-40' LIMIT 1").get() || {}).id;
        } else if (d.includes('CV GREASE')) {
          prodId = (targetDb.prepare("SELECT id FROM products WHERE name = 'CV Grease' LIMIT 1").get() || {}).id;
        } else if (d.includes('COOLANT')) {
          prodId = (targetDb.prepare("SELECT id FROM products WHERE name = 'Coolant' LIMIT 1").get() || {}).id;
        } else if (d.includes('PETROL ENGINE OIL')) {
          prodId = (targetDb.prepare("SELECT id FROM products WHERE name = '20W-50' OR category = 'engine_oil' LIMIT 1").get() || {}).id;
        } else if (d.includes('GREASE') && !d.includes('SEAL') && !d.includes('GUN') && !d.includes('NOZZLE')) {
          prodId = (targetDb.prepare("SELECT id FROM products WHERE name = 'Grease' LIMIT 1").get() || {}).id;
        }
      }

      if (prodId) {
        // Actual oil stock -> sync to stock_ledger
        const already = targetDb.prepare('SELECT id FROM stock_ledger WHERE source_issue_id = ?').get(iss.id);
        if (!already) {
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

          targetDb.prepare(`
            INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, job_id, consumer, mr_no, txn_date, store_id, physical_store_id, source_issue_id)
            VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(prodId, -Math.abs(iss.qty), newBal, price, assetId || null, iss.job_id || null, iss.purpose || iss.description, iss.min_no || 'Store Issue', iss.issue_date, iss.store_id || 1, iss.physical_store_id || 2, iss.id);
          targetDb.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(newBal, prodId);
          oilsSynced++;
        }
        continue;
      }

      // General store item (consumables, hardware, electrical, tools, bearings, cotton waste, etc.)
      let storeItemId = iss.store_item_id;
      if (!storeItemId && desc) {
        const existing = targetDb.prepare('SELECT id FROM store_items WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1').get(desc);
        if (existing) {
          storeItemId = existing.id;
        } else {
          const ins = targetDb.prepare(`
            INSERT INTO store_items (name, category, unit, rack, is_general, balance, unit_cost)
            VALUES (?, COALESCE(?, 'General Items'), 'nos', 'General', 1, 0, ?)
          `).run(desc, iss.category || 'General Items', iss.unit_price || 0);
          storeItemId = ins.lastInsertRowid;
        }
        targetDb.prepare('UPDATE issues SET store_item_id = ? WHERE id = ?').run(storeItemId, iss.id);
      }

      if (storeItemId) {
        targetDb.prepare('UPDATE store_items SET is_general = 1 WHERE id = ? AND is_general = 0').run(storeItemId);
        const si = targetDb.prepare('SELECT unit_cost, balance FROM store_items WHERE id = ?').get(storeItemId);
        const price = iss.unit_price != null && iss.unit_price > 0 ? iss.unit_price : (si?.unit_cost || 0);
        const prev = (targetDb.prepare('SELECT balance_after FROM general_item_txns WHERE store_item_id = ? ORDER BY txn_date DESC, id DESC LIMIT 1').get(storeItemId) || {}).balance_after || si?.balance || 0;
        const newBal = prev - Math.abs(iss.qty);

        let assetId = iss.asset_id;
        if (!assetId && iss.job_id) {
          const j = targetDb.prepare('SELECT asset_id FROM job_cards WHERE id = ?').get(iss.job_id);
          if (j && j.asset_id) assetId = j.asset_id;
        }
        if (!assetId) {
          assetId = resolveAssetResilient(targetDb, iss.purpose) || resolveAssetResilient(targetDb, iss.description);
        }

        targetDb.prepare(`
          INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, unit_price, asset_id, job_id, ref, txn_date, store_id, physical_store_id, source_issue_id)
          VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(storeItemId, -Math.abs(iss.qty), newBal, price, assetId || null, iss.job_id || null, iss.min_no || iss.purpose || 'Store Issue', iss.issue_date, iss.store_id || 1, iss.physical_store_id || 2, iss.id);
        targetDb.prepare('UPDATE store_items SET balance = ? WHERE id = ?').run(newBal, storeItemId);
        generalSynced++;
      }
    }
  })();

  console.log(`Synced ${generalSynced} general store items and ${oilsSynced} oil issues into ledgers in ${label}.`);
}

function runMigration(optionalDb) {
  console.log('=== Running Migration 046: General Item Issues & Ledgers Sync ===');

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
        migrateSingleDb(multidb.activeDb(), `Workshop ${ws.code || ws.id}`);
      });
    }
  }

  // Recalculate vehicle monthly costs for affected vehicles
  console.log('\nRecalculating vehicle_monthly_costs...');
  const costing = require('../lib/costing');
  const targetDb = optionalDb || (multidb.isMultiDb() ? multidb.activeDb() : rawDb);
  try {
    const vMonths = targetDb.prepare(`
      SELECT DISTINCT asset_id, substr(issue_date, 1, 7) ym FROM issues WHERE asset_id IS NOT NULL AND issue_date IS NOT NULL
      UNION
      SELECT DISTINCT j.asset_id, substr(jl.work_date, 1, 7) ym FROM job_labour jl JOIN job_cards j ON j.id = jl.job_id WHERE j.asset_id IS NOT NULL AND jl.work_date IS NOT NULL
      UNION
      SELECT DISTINCT sl.asset_id, substr(sl.txn_date, 1, 7) ym FROM stock_ledger sl WHERE sl.asset_id IS NOT NULL AND sl.txn_date IS NOT NULL
      UNION
      SELECT DISTINCT gt.asset_id, substr(gt.txn_date, 1, 7) ym FROM general_item_txns gt WHERE gt.asset_id IS NOT NULL AND gt.txn_date IS NOT NULL
    `).all();

    let recalced = 0;
    for (const vm of vMonths) {
      if (!vm.asset_id || !vm.ym || !/^\d{4}-\d{2}$/.test(vm.ym)) continue;
      const [yr, mo] = vm.ym.split('-').map(Number);
      if (yr < 2020 || yr > 2030) continue;
      try {
        costing.recalcVehicleMonth(vm.asset_id, yr, mo);
        recalced++;
      } catch {}
    }
    console.log(`Recalculated monthly costs for ${recalced} vehicle-month combinations.`);
  } catch (err) {
    console.warn('Vehicle monthly cost recalculation skipped:', err.message);
  }

  console.log('=== Migration 046 Completed Successfully ===');
}

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
