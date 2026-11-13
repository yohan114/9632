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

function hasTable(db, name) {
  return Boolean(db && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function runMigration(targetDb, options = {}) {
  console.log('=== Running Migration 055: Storekeeper Grants & Price Sync ===');
  if (!targetDb) return { affectedJobIds: [] };

  const coreDb = options.coreDb || null;
  const isWsDb = hasTable(targetDb, 'ws_meta') || !hasTable(targetDb, 'users');
  const grantDb = !isWsDb ? targetDb : coreDb;
  const itemsDb = hasTable(targetDb, 'store_items') ? targetDb : (hasTable(coreDb, 'store_items') ? coreDb : null);
  const affectedJobIds = new Set();

  // 1. Ensure store_location_access table exists (core/single DB) & grant CW store roles dual Central Stores [1, 2]
  if (grantDb && hasTable(grantDb, 'users') && hasTable(grantDb, 'store_locations')) {
    try {
      grantDb.exec(`
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

      const hasStores = grantDb.prepare('SELECT COUNT(*) AS c FROM store_locations WHERE id IN (1, 2)').get();
      if (hasStores && hasStores.c > 0) {
        // Grant Store 1 & 2 ONLY to active Central storekeepers/workshop heads, never site-locked users or unmapped clerks.
        const candidateUsers = grantDb.prepare(`
          SELECT DISTINCT u.id, u.username, u.workshop_id
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
           WHERE u.active = 1
             AND r.name IN ('storekeeper', 'main_storekeeper', 'workshop')
             AND (u.workshop_id = 1 OR u.workshop_id IS NULL)
             AND NOT EXISTS (
               SELECT 1 FROM store_location_access s2
                WHERE s2.user_id = u.id AND s2.store_location_id > 2
             )
        `).all();

        const upsertAccess = grantDb.prepare(`
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

  // Stop here when running purely against core.db (which has no grn/issues/job_parts tables)
  if (!hasTable(targetDb, 'grn') || !hasTable(targetDb, 'issues')) {
    console.log('=== Migration 055 Completed (Core DB Only) ===');
    return { affectedJobIds: [] };
  }

  // 2. Backfill store_items.unit_cost from priced GRN records
  if (itemsDb) {
    try {
      const unpricedItems = itemsDb.prepare(`
        SELECT id, name FROM store_items WHERE unit_cost IS NULL OR unit_cost = 0
      `).all();

      const findGrnPrice = targetDb.prepare(`
        SELECT unit_price FROM grn
         WHERE (store_item_id = ? OR LOWER(TRIM(description)) = LOWER(TRIM(?)))
           AND unit_price IS NOT NULL AND unit_price > 0
         ORDER BY id DESC LIMIT 1
      `);

      const updateItemCost = itemsDb.prepare('UPDATE store_items SET unit_cost = ? WHERE id = ?');

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
  }

  // 3. Backfill issues.unit_price from linked grn.unit_price
  try {
    const grnLinkedUnpriced = targetDb.prepare(`
      SELECT i.id, i.job_id, g.unit_price
        FROM issues i
        JOIN grn g ON g.id = i.grn_id
       WHERE (i.unit_price IS NULL OR i.unit_price = 0)
         AND i.grn_id IS NOT NULL
         AND g.unit_price IS NOT NULL AND g.unit_price > 0
    `).all();
    const updIss = targetDb.prepare('UPDATE issues SET unit_price = ? WHERE id = ?');
    for (const row of grnLinkedUnpriced) {
      updIss.run(row.unit_price, row.id);
      if (row.job_id) affectedJobIds.add(row.job_id);
    }
    if (grnLinkedUnpriced.length > 0) console.log(`[055] Backfilled unit_price on ${grnLinkedUnpriced.length} issue(s) from GRN.`);
  } catch (err) {
    console.warn('[055] Issues price backfill warning:', err.message);
  }

  // 3b. Materialise missing job_parts for priced job-linked GRN/MRN issues (without double-counting)
  if (hasTable(targetDb, 'job_parts')) {
    try {
      const missingParts = targetDb.prepare(`
        SELECT i.id, i.job_id, i.mrn_line_id, i.description, i.qty, i.unit_price
          FROM issues i
         WHERE i.job_id IS NOT NULL
           AND i.unit_price IS NOT NULL AND i.unit_price > 0
           AND i.grn_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM job_parts jp WHERE jp.source_type = 'issue' AND jp.source_id = i.id)
           AND NOT (i.mrn_line_id IS NOT NULL AND EXISTS (SELECT 1 FROM job_parts jp WHERE jp.mrn_line_id = i.mrn_line_id AND jp.source_type = 'grn'))
           AND NOT EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.source_issue_id = i.id)
           AND NOT EXISTS (SELECT 1 FROM general_item_txns git WHERE git.source_issue_id = i.id)
      `).all();
      const insPart = targetDb.prepare(`
        INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price, is_external_repair)
        VALUES (?, 'issue', ?, ?, ?, ?, ?, 0)
      `);
      for (const mp of missingParts) {
        insPart.run(mp.job_id, mp.id, mp.mrn_line_id || null, mp.description, mp.qty, mp.unit_price);
        affectedJobIds.add(mp.job_id);
      }
      if (missingParts.length > 0) console.log(`[055] Created ${missingParts.length} missing job_part(s) from priced issues.`);
    } catch (err) {
      console.warn('[055] Missing job_parts backfill warning:', err.message);
    }
  }

  // 4. Backfill job_parts.unit_price from issues, grn, and mrn_lines
  if (hasTable(targetDb, 'job_parts')) {
    try {
      for (const r of targetDb.prepare(`
        SELECT DISTINCT job_id FROM job_parts
         WHERE (unit_price IS NULL OR unit_price = 0)
           AND job_id IS NOT NULL
           AND (
             (source_type = 'issue' AND EXISTS (SELECT 1 FROM issues i WHERE i.id = job_parts.source_id AND i.unit_price > 0))
             OR (source_type = 'grn' AND EXISTS (SELECT 1 FROM grn g WHERE g.id = job_parts.source_id AND g.unit_price > 0))
             OR (mrn_line_id IS NOT NULL AND EXISTS (SELECT 1 FROM grn g WHERE g.mrn_line_id = job_parts.mrn_line_id AND g.unit_price > 0))
           )
      `).all()) {
        affectedJobIds.add(r.job_id);
      }

      const resPartsFromIssues = targetDb.prepare(`
        UPDATE job_parts
           SET unit_price = (SELECT i.unit_price FROM issues i WHERE i.id = job_parts.source_id)
         WHERE (unit_price IS NULL OR unit_price = 0)
           AND source_type = 'issue'
           AND EXISTS (SELECT 1 FROM issues i WHERE i.id = job_parts.source_id AND i.unit_price IS NOT NULL AND i.unit_price > 0)
      `).run();

      const resPartsFromGrn = targetDb.prepare(`
        UPDATE job_parts
           SET unit_price = (SELECT g.unit_price FROM grn g WHERE g.id = job_parts.source_id)
         WHERE (unit_price IS NULL OR unit_price = 0)
           AND source_type = 'grn'
           AND EXISTS (SELECT 1 FROM grn g WHERE g.id = job_parts.source_id AND g.unit_price IS NOT NULL AND g.unit_price > 0)
      `).run();

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
  }

  // 5. Backfill general_item_txns.unit_price from issues or store_items (and update linked job_parts if any)
  if (hasTable(targetDb, 'general_item_txns')) {
    try {
      for (const r of targetDb.prepare(`
        SELECT t.id, t.job_id, i.unit_price AS iss_price
          FROM general_item_txns t
          JOIN issues i ON i.id = t.source_issue_id
         WHERE (t.unit_price IS NULL OR t.unit_price = 0)
           AND i.unit_price IS NOT NULL AND i.unit_price > 0
      `).all()) {
        targetDb.prepare('UPDATE general_item_txns SET unit_price = ? WHERE id = ?').run(r.iss_price, r.id);
        if (r.job_id) affectedJobIds.add(r.job_id);
      }

      if (itemsDb) {
        const unpricedGit = targetDb.prepare(`
          SELECT id, store_item_id, job_id FROM general_item_txns
           WHERE (unit_price IS NULL OR unit_price = 0) AND store_item_id IS NOT NULL
        `).all();
        const getItemCost = itemsDb.prepare('SELECT unit_cost FROM store_items WHERE id = ?');
        const updGit = targetDb.prepare('UPDATE general_item_txns SET unit_price = ? WHERE id = ?');
        let gitFromItems = 0;
        for (const g of unpricedGit) {
          const item = getItemCost.get(g.store_item_id);
          if (item && item.unit_cost != null && item.unit_cost > 0) {
            updGit.run(item.unit_cost, g.id);
            gitFromItems++;
            if (g.job_id) affectedJobIds.add(g.job_id);
          }
        }
        if (gitFromItems > 0) console.log(`[055] Backfilled unit_price on ${gitFromItems} general item transaction(s).`);

        // Also backfill unpriced issues & issue-linked job_parts whose store_item_id now has unit_cost > 0
        const unpricedIss = targetDb.prepare(`
          SELECT i.id, i.store_item_id, i.job_id FROM issues i
           WHERE (i.unit_price IS NULL OR i.unit_price = 0) AND i.store_item_id IS NOT NULL
        `).all();
        const updIss = targetDb.prepare('UPDATE issues SET unit_price = ? WHERE id = ?');
        const updJp = targetDb.prepare("UPDATE job_parts SET unit_price = ? WHERE source_type = 'issue' AND source_id = ? AND (unit_price IS NULL OR unit_price = 0)");
        let issFromItems = 0;
        for (const iss of unpricedIss) {
          const item = getItemCost.get(iss.store_item_id);
          if (item && item.unit_cost != null && item.unit_cost > 0) {
            updIss.run(item.unit_cost, iss.id);
            updJp.run(item.unit_cost, iss.id);
            issFromItems++;
            if (iss.job_id) affectedJobIds.add(iss.job_id);
          }
        }
        if (issFromItems > 0) console.log(`[055] Backfilled unit_price on ${issFromItems} general issue(s) from store_items.`);
      }
    } catch (err) {
      console.warn('[055] General item txns price backfill warning:', err.message);
    }
  }

  console.log('=== Migration 055 Completed Successfully ===');
  return { affectedJobIds: Array.from(affectedJobIds) };
}

module.exports = { runMigration };
