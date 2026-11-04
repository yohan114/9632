'use strict';

/**
 * Migration 047: Deduplicate General Items, Remove Cross-Section Overlaps,
 * Clean Cotton Waste from Oil Stock, and Recalculate Job & Vehicle Costs.
 *
 * Enforces strict single-bucket allocation:
 * 1. Spare parts & MRN/GRN handovers -> 2. Repair cost (job_parts) only.
 * 2. Filters -> 3. Service cost (service_filters) or 2. Repair cost only.
 * 3. Oils, Greases, Fluids, WD-40 in stock_ledger -> 6. Oils & Lubrication only.
 * 4. Cotton Waste -> 7. General Items (store_items) only, removed from lube stock_ledger.
 * 5. General Items -> 7. General Items (general_item_txns) only for pure store consumables.
 *
 * Runs across both monolithic database (rawDb) and all workshop databases when multidb is active.
 * Idempotent: safe to run on every boot / deploy.
 */

const { rawDb, multidb } = require('../db');

function migrateSingleDb(targetDb, label) {
  console.log(`\n--- [047] Deduplicating General Items & Cleaning Overlaps for ${label} ---`);

  targetDb.transaction(() => {
    // 1. Remove Cotton Waste from stock_ledger and disable in products/aliases
    const cottonProds = targetDb.prepare("SELECT id FROM products WHERE LOWER(name) LIKE '%cotton waste%'").all();
    for (const cp of cottonProds) {
      const slDel = targetDb.prepare('DELETE FROM stock_ledger WHERE product_id = ?').run(cp.id);
      console.log(`Deleted ${slDel.changes} stock_ledger rows for Cotton Waste (product_id: ${cp.id}).`);
      targetDb.prepare("DELETE FROM issues WHERE source_table = 'stock_ledger' AND description LIKE '%cotton waste%'").run();
      targetDb.prepare('DELETE FROM lubricant_aliases WHERE product_id = ?').run(cp.id);
      targetDb.prepare("UPDATE products SET active = 0, category = 'consumable', stock_qty = 0 WHERE id = ?").run(cp.id);
    }

    // 2. Identify duplicate rows in general_item_txns:
    //    A) MRN/GRN spare part handovers (already counted in job_parts / Repair cost)
    //    B) Already booked in job_parts
    //    C) Filters (belong to Service or Repair)
    //    D) Already in stock_ledger (Oils/Fluids/Greases/WD-40)
    //    E) Store item category is Lubricants & Fluids (not cotton)
    const dupGitRows = targetDb.prepare(`
      SELECT DISTINCT git.id, git.source_issue_id
        FROM general_item_txns git
        LEFT JOIN store_items si ON si.id = git.store_item_id
        LEFT JOIN issues i ON i.id = git.source_issue_id
       WHERE (i.id IS NOT NULL AND (i.grn_id IS NOT NULL OR i.mrn_no IS NOT NULL OR i.mrn_line_id IS NOT NULL))
          OR (i.id IS NOT NULL AND EXISTS (
               SELECT 1 FROM job_parts jp
                WHERE jp.job_id = i.job_id
                  AND (jp.source_type = 'issue' OR jp.mrn_line_id = i.id OR LOWER(TRIM(jp.description)) = LOWER(TRIM(i.description)))
             ))
          OR (si.category = 'Filters' OR LOWER(si.name) LIKE '%filter%' OR (i.id IS NOT NULL AND (i.category = 'Filters' OR LOWER(i.description) LIKE '%filter%')))
          OR EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.source_issue_id = git.source_issue_id)
          OR (si.category = 'Lubricants & Fluids' AND LOWER(si.name) NOT LIKE '%cotton%')
    `).all();

    console.log(`Found ${dupGitRows.length} duplicate rows to purge from general_item_txns.`);

    if (dupGitRows.length > 0) {
      const gitIds = dupGitRows.map((r) => r.id);
      const CHUNK = 500;
      for (let i = 0; i < gitIds.length; i += CHUNK) {
        const slice = gitIds.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        targetDb.prepare(`DELETE FROM general_item_txns WHERE id IN (${placeholders})`).run(...slice);
      }
      console.log(`Purged ${gitIds.length} duplicate general_item_txns rows.`);

      // Also clean up any orphan issues created with source_table = 'general_item_txns' pointing to deleted rows
      const issDel = targetDb.prepare(`
        DELETE FROM issues
         WHERE source_table = 'general_item_txns'
           AND source_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM general_item_txns git WHERE git.id = issues.source_id)
      `).run();
      if (issDel.changes > 0) {
        console.log(`Cleaned up ${issDel.changes} orphan issues created from deleted general_item_txns.`);
      }
    }

    // 3. Synchronize store_items.balance and products.stock_qty
    console.log('Recalculating store_items.balance and products.stock_qty...');
    const items = targetDb.prepare('SELECT id FROM store_items').all();
    for (const item of items) {
      const lastRow = targetDb.prepare('SELECT balance_after FROM general_item_txns WHERE store_item_id = ? ORDER BY txn_date DESC, id DESC LIMIT 1').get(item.id);
      const bal = lastRow && lastRow.balance_after != null ? lastRow.balance_after : 0;
      targetDb.prepare('UPDATE store_items SET balance = ? WHERE id = ?').run(bal, item.id);
    }

    const prods = targetDb.prepare('SELECT id FROM products').all();
    for (const p of prods) {
      const lastRow = targetDb.prepare('SELECT balance_after FROM stock_ledger WHERE product_id = ? AND COALESCE(voided, 0) = 0 ORDER BY txn_date DESC, id DESC LIMIT 1').get(p.id);
      const bal = lastRow && lastRow.balance_after != null ? lastRow.balance_after : 0;
      targetDb.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(bal, p.id);
    }
  })();

  // 4. Recompute job cards cost where general_cost or material_cost may have changed
  console.log('Recomputing affected job_cards costs...');
  const costing = require('../lib/costing');
  const jobsToRecompute = targetDb.prepare(`
    SELECT id FROM job_cards
     WHERE general_cost > 0
        OR EXISTS (SELECT 1 FROM general_item_txns git WHERE git.job_id = job_cards.id)
  `).all();

  let jobsUpdated = 0;
  for (const j of jobsToRecompute) {
    try {
      costing.computeJobCost(j.id);
      jobsUpdated++;
    } catch {}
  }
  console.log(`Recomputed costs for ${jobsUpdated} job card(s).`);

  // 5. Recalculate vehicle_monthly_costs
  console.log('Recalculating vehicle_monthly_costs...');
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
    console.warn('Vehicle monthly cost recalculation warning:', err.message);
  }

  console.log(`=== [047] Deduplication Completed for ${label} ===`);
}

function runMigration(optionalDb) {
  console.log('=== Running Migration 047: Deduplicate General Items & Clean Overlaps ===');

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

  console.log('=== Migration 047 Completed Successfully ===');
}

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
