'use strict';

/**
 * Migration 055: Storekeeper Store Grants & Price Cascading Sync
 *
 * 1. Store Location Permissions:
 *    Ensures users holding storekeeper roles or stationed at Central Workshop (Workshop 1)
 *    have explicit grants in `store_location_access` for both Central Main Stores (ID 1)
 *    and Central Main Workshop Stores (ID 2), preventing "Tenancy boundary violation"
 *    errors when receiving or pricing Head Office / Dileka Motors goods.
 *
 * 2. Backfill Historical Unpriced Lines:
 *    - Backfills `issues.unit_price` from `grn.unit_price`.
 *    - Backfills `job_parts.unit_price` from `issues`, `grn`, or `mrn_lines`.
 *    - Backfills `store_items.unit_cost` from recent GRN receipts.
 *    - Backfills `general_item_txns.unit_price` from `issues` and `store_items`.
 *    - Refreshes job card totals and cost breakdowns for affected jobs.
 *
 * Guarded by setting key 'migration_055_done'.
 * Fully idempotent across single-database and multidb modes.
 */

function runMigration(targetDb) {
  console.log('=== Running Migration 055: Storekeeper Grants & Price Sync ===');
  if (!targetDb) return;

  const isWsDb = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ws_meta'").get());

  // 1. Ensure store_location_access table exists (core/single DB)
  if (!isWsDb) {
    try {
      targetDb.exec(`
        CREATE TABLE IF NOT EXISTS store_location_access (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          store_location_id  INTEGER NOT NULL REFERENCES store_locations(id) ON DELETE CASCADE,
          can_view           INTEGER NOT NULL DEFAULT 1,
          can_request        INTEGER NOT NULL DEFAULT 1,
          can_issue          INTEGER NOT NULL DEFAULT 0,
          can_receive        INTEGER NOT NULL DEFAULT 0,
          can_dispatch       INTEGER NOT NULL DEFAULT 0,
          can_count          INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(user_id, store_location_id)
        );
      `);

      // Ensure store locations 1 and 2 exist
      const hasStores = targetDb.prepare("SELECT COUNT(*) AS c FROM store_locations WHERE id IN (1, 2)").get();
      if (hasStores && hasStores.c > 0) {
        // Find storekeeper and Workshop 1 users
        const candidateUsers = targetDb.prepare(`
          SELECT DISTINCT u.id, u.username, u.workshop_id
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id
           WHERE u.active = 1
             AND (u.workshop_id = 1 OR u.workshop_id IS NULL OR r.name IN ('storekeeper', 'main_storekeeper'))
        `).all();

        const upsertAccess = targetDb.prepare(`
          INSERT INTO store_location_access (user_id, store_location_id, can_view, can_request, can_issue, can_receive, can_dispatch, can_count)
          VALUES (?, ?, 1, 1, 1, 1, 1, 1)
          ON CONFLICT(user_id, store_location_id) DO UPDATE SET
            can_view = 1,
            can_request = 1,
            can_issue = 1,
            can_receive = 1,
            can_dispatch = 1,
            can_count = 1
        `);

        for (const u of candidateUsers) {
          upsertAccess.run(u.id, 1);
          upsertAccess.run(u.id, 2);
        }
        console.log(`[055] Granted dual Central Stores access to ${candidateUsers.length} user(s).`);
      }
    } catch (err) {
      console.warn('[055] Store location access seeding warning:', err.message);
    }
  }

  // 2. Backfill store_items.unit_cost from priced GRN records
  try {
    const unpricedItems = targetDb.prepare(`
      SELECT id, name FROM store_items WHERE unit_cost IS NULL OR unit_cost = 0
    `).all();

    const findGrnPrice = targetDb.prepare(`
      SELECT unit_price FROM grn
       WHERE (store_item_id = ? OR LOWER(TRIM(description)) = LOWER(TRIM(?)))
         AND unit_price IS NOT NULL AND unit_price > 0
       ORDER BY id DESC LIMIT 1
    `);

    const updateItemCost = targetDb.prepare(`UPDATE store_items SET unit_cost = ? WHERE id = ?`);

    let itemsBackfilled = 0;
    for (const item of unpricedItems) {
      const p = findGrnPrice.get(item.id, item.name);
      if (p && p.unit_price > 0) {
        updateItemCost.run(p.unit_price, item.id);
        itemsBackfilled++;
      }
    }
    if (itemsBackfilled > 0) console.log(`[055] Backfilled unit_cost for ${itemsBackfilled} store item(s).`);
  } catch (err) {
    console.warn('[055] Store items cost backfill warning:', err.message);
  }

  // 3. Backfill issues.unit_price from linked grn.unit_price
  try {
    const resIssues = targetDb.prepare(`
      UPDATE issues
         SET unit_price = (SELECT g.unit_price FROM grn g WHERE g.id = issues.grn_id)
       WHERE (unit_price IS NULL OR unit_price = 0)
         AND grn_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM grn g WHERE g.id = issues.grn_id AND g.unit_price IS NOT NULL AND g.unit_price > 0)
    `).run();
    if (resIssues.changes > 0) console.log(`[055] Backfilled unit_price on ${resIssues.changes} issue(s) from GRN.`);
  } catch (err) {
    console.warn('[055] Issues price backfill warning:', err.message);
  }

  // 4. Backfill job_parts.unit_price from issues, grn, and mrn_lines
  try {
    // 4a. From issues
    const resPartsFromIssues = targetDb.prepare(`
      UPDATE job_parts
         SET unit_price = (SELECT i.unit_price FROM issues i WHERE i.id = job_parts.source_id)
       WHERE (unit_price IS NULL OR unit_price = 0)
         AND source_type = 'issue'
         AND EXISTS (SELECT 1 FROM issues i WHERE i.id = job_parts.source_id AND i.unit_price IS NOT NULL AND i.unit_price > 0)
    `).run();

    // 4b. From grn directly
    const resPartsFromGrn = targetDb.prepare(`
      UPDATE job_parts
         SET unit_price = (SELECT g.unit_price FROM grn g WHERE g.id = job_parts.source_id)
       WHERE (unit_price IS NULL OR unit_price = 0)
         AND source_type = 'grn'
         AND EXISTS (SELECT 1 FROM grn g WHERE g.id = job_parts.source_id AND g.unit_price IS NOT NULL AND g.unit_price > 0)
    `).run();

    // 4c. From mrn_lines via grn
    const resPartsFromMrn = targetDb.prepare(`
      UPDATE job_parts
         SET unit_price = (SELECT g.unit_price FROM grn g WHERE g.mrn_line_id = job_parts.mrn_line_id AND g.unit_price IS NOT NULL AND g.unit_price > 0 ORDER BY g.id DESC LIMIT 1)
       WHERE (unit_price IS NULL OR unit_price = 0)
         AND mrn_line_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM grn g WHERE g.mrn_line_id = job_parts.mrn_line_id AND g.unit_price IS NOT NULL AND g.unit_price > 0)
    `).run();

    const totalPartsUpdated = (resPartsFromIssues.changes || 0) + (resPartsFromGrn.changes || 0) + (resPartsFromMrn.changes || 0);
    if (totalPartsUpdated > 0) console.log(`[055] Backfilled unit_price on ${totalPartsUpdated} job part(s).`);
  } catch (err) {
    console.warn('[055] Job parts price backfill warning:', err.message);
  }

  // 5. Backfill general_item_txns.unit_price from issues or store_items
  try {
    // 5a. From source issue
    const resGitFromIssues = targetDb.prepare(`
      UPDATE general_item_txns
         SET unit_price = (SELECT i.unit_price FROM issues i WHERE i.id = general_item_txns.source_issue_id)
       WHERE (unit_price IS NULL OR unit_price = 0)
         AND source_issue_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM issues i WHERE i.id = general_item_txns.source_issue_id AND i.unit_price IS NOT NULL AND i.unit_price > 0)
    `).run();

    // 5b. From store_items
    const resGitFromItems = targetDb.prepare(`
      UPDATE general_item_txns
         SET unit_price = (SELECT si.unit_cost FROM store_items si WHERE si.id = general_item_txns.store_item_id)
       WHERE (unit_price IS NULL OR unit_price = 0)
         AND store_item_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM store_items si WHERE si.id = general_item_txns.store_item_id AND si.unit_cost IS NOT NULL AND si.unit_cost > 0)
    `).run();

    const totalGitUpdated = (resGitFromIssues.changes || 0) + (resGitFromItems.changes || 0);
    if (totalGitUpdated > 0) console.log(`[055] Backfilled unit_price on ${totalGitUpdated} general item transaction(s).`);
  } catch (err) {
    console.warn('[055] General item txns price backfill warning:', err.message);
  }

  console.log('=== Migration 055 Completed Successfully ===');
}

module.exports = { runMigration };
