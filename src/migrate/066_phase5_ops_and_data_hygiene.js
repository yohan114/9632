'use strict';

/**
 * Migration 066: Phase 5A Production Operations & Safe Data Hygiene
 *
 * 1. Deactivate leftover active test accounts ('testone', 'test', 'test_u') & revoke sessions.
 * 2. Auto-link strictly unambiguous 1-to-1 pending asset_aliases (skips multi-vehicle strings).
 * 3. Backfill unpriced store issues from exact unambiguous store_items.unit_cost & refresh costing.
 * 4. Auto-close legacy overdue (>30d) open MRNs that only have zero-quantity lines.
 */

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function safePrep(db, sql) {
  try { return db.prepare(sql); } catch (_) { return null; }
}

function normalizeText(text) {
  if (text === null || text === undefined) return '';
  return String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractCodeTokens(text) {
  if (!text) return [];
  return String(text).match(/\b\d{1,3}[- ]?\d{2,5}\b|\b[A-Z]{1,3}[- ]?\d{2,6}\b/gi) || [];
}

function runMigration(db) {
  let testAccountsDeactivated = 0;
  let aliasesAutoLinked = 0;
  let issuesPriced = 0;
  let zeroQtyMrnsClosed = 0;

  // 1. Deactivate leftover active test accounts
  if (tableExists(db, 'users')) {
    const testUsers = db.prepare(`
      SELECT id FROM users
       WHERE LOWER(username) IN ('testone', 'test', 'test_u')
         AND active = 1
    `).all();
    const deactStmt = db.prepare('UPDATE users SET active = 0 WHERE id = ?');
    const delSessStmt = tableExists(db, 'sessions')
      ? db.prepare('DELETE FROM sessions WHERE user_id = ?')
      : null;

    for (const u of testUsers) {
      deactStmt.run(u.id);
      if (delSessStmt) delSessStmt.run(u.id);
      testAccountsDeactivated++;
    }
  }

  // 2. Auto-link strictly unambiguous 1-to-1 pending asset aliases
  if (tableExists(db, 'asset_aliases') && tableExists(db, 'assets')) {
    const pending = db.prepare('SELECT id, raw_text, raw_norm FROM asset_aliases WHERE resolved = 0').all();
    const assets = db.prepare('SELECT id, code, code_norm, registration, ec_code FROM assets').all();

    const byNorm = new Map();
    for (const a of assets) {
      const keys = [
        normalizeText(a.code_norm || a.code),
        normalizeText(a.registration),
        normalizeText(a.ec_code),
      ].filter(Boolean);
      for (const k of keys) {
        if (!byNorm.has(k)) byNorm.set(k, new Set());
        byNorm.get(k).add(a.id);
      }
    }

    const updAlias = db.prepare(`
      UPDATE asset_aliases
         SET asset_id = ?, resolved = 1, hit_count = hit_count + 1, updated_at = datetime('now')
       WHERE id = ?
    `);
    const casSvc = safePrep(db, 'UPDATE service_jobs SET asset_id = ? WHERE asset_id IS NULL AND (vehicle_label = ? OR vehicle_label = ?)');
    const casDw = safePrep(db, 'UPDATE job_daily_work SET asset_id = ? WHERE asset_id IS NULL AND (vehicle = ? OR vehicle = ?)');
    const casIss = safePrep(db, 'UPDATE issues SET asset_id = ? WHERE asset_id IS NULL AND (purpose = ? OR purpose LIKE ?)');
    const casJr = safePrep(db, 'UPDATE job_requests SET asset_id = ? WHERE asset_id IS NULL AND (description LIKE ? OR description LIKE ?)');

    const applyAliases = db.transaction(() => {
      for (const al of pending) {
        const rn = normalizeText(al.raw_norm || al.raw_text);
        let matchedAssetId = null;

        const direct = rn ? byNorm.get(rn) : null;
        if (direct && direct.size === 1) {
          matchedAssetId = [...direct][0];
        } else {
          const tokens = [...new Set(
            extractCodeTokens(al.raw_text)
              .map(normalizeText)
              .filter((t) => t.length >= 4)
          )];
          if (tokens.length === 1) {
            const set = byNorm.get(tokens[0]);
            if (set && set.size === 1) {
              matchedAssetId = [...set][0];
            }
          }
        }

        if (!matchedAssetId) continue;

        updAlias.run(matchedAssetId, al.id);
        const raw = String(al.raw_text || '').trim();
        const norm = al.raw_norm || rn;
        if (raw) {
          try { if (casSvc) casSvc.run(matchedAssetId, raw, norm); } catch (_) {}
          try { if (casDw) casDw.run(matchedAssetId, raw, norm); } catch (_) {}
          try { if (casIss) casIss.run(matchedAssetId, raw, '%' + raw + '%'); } catch (_) {}
          try { if (casJr) casJr.run(matchedAssetId, '%' + raw + '%', '%' + norm + '%'); } catch (_) {}
        }
        aliasesAutoLinked++;
      }
    });
    applyAliases();
  }

  // 3. Backfill unpriced store issues from unambiguous exact-name store_items catalog unit_cost
  const affectedJobIds = new Set();
  const affectedBuckets = new Map();

  if (tableExists(db, 'issues') && tableExists(db, 'store_items')) {
    const catalogRows = db.prepare(`
      SELECT LOWER(TRIM(name)) AS nm,
             MIN(id) AS si_id,
             MIN(unit_cost) AS min_c,
             MAX(unit_cost) AS max_c
        FROM store_items
       WHERE unit_cost > 0 AND TRIM(COALESCE(name, '')) <> ''
       GROUP BY LOWER(TRIM(name))
      HAVING ABS(MIN(unit_cost) - MAX(unit_cost)) < 0.005
    `).all();

    const priceByName = new Map();
    for (const c of catalogRows) {
      priceByName.set(c.nm, { storeItemId: c.si_id, unitCost: Number(c.min_c) });
    }

    if (priceByName.size) {
      const unpriced = db.prepare(`
        SELECT id, description, job_id, asset_id, issue_date
          FROM issues
         WHERE (unit_price IS NULL OR unit_price <= 0)
           AND COALESCE(voided, 0) = 0
           AND TRIM(COALESCE(description, '')) <> ''
      `).all();

      const updIss = db.prepare('UPDATE issues SET unit_price = ?, store_item_id = COALESCE(store_item_id, ?) WHERE id = ?');
      const updSm = tableExists(db, 'stock_moves')
        ? db.prepare("UPDATE stock_moves SET unit_price = ? WHERE source_table = 'issues' AND source_id = ? AND (unit_price IS NULL OR unit_price <= 0)")
        : null;
      const updJp = tableExists(db, 'job_parts')
        ? db.prepare("UPDATE job_parts SET unit_price = ? WHERE source_type = 'issue' AND source_id = ? AND (unit_price IS NULL OR unit_price <= 0)")
        : null;

      const applyPricing = db.transaction(() => {
        for (const iss of unpriced) {
          const match = priceByName.get(String(iss.description || '').trim().toLowerCase());
          if (!match || !(match.unitCost > 0)) continue;

          updIss.run(match.unitCost, match.storeItemId, iss.id);
          if (updSm) updSm.run(match.unitCost, iss.id);
          if (updJp) updJp.run(match.unitCost, iss.id);
          issuesPriced++;

          if (iss.job_id) affectedJobIds.add(iss.job_id);
          if (iss.asset_id && iss.issue_date) {
            const ym = String(iss.issue_date).slice(0, 7);
            if (/^\d{4}-\d{2}$/.test(ym)) {
              const [year, month] = ym.split('-').map(Number);
              if (year && month) affectedBuckets.set(`${iss.asset_id}:${ym}`, { assetId: iss.asset_id, year, month });
            }
          }
        }
      });
      applyPricing();
    }
  }

  // Refresh affected non-closed jobs and vehicle monthly rollups
  if (issuesPriced > 0) {
    try {
      const costing = require('../lib/costing');
      const jobStatusStmt = db.prepare('SELECT id, status FROM job_cards WHERE id = ?');
      for (const jid of affectedJobIds) {
        try {
          const jc = jobStatusStmt.get(jid);
          if (jc && jc.status !== 'CLOSED') costing.refreshJobTotals(jid);
        } catch (_) {}
      }
      for (const b of affectedBuckets.values()) {
        try { costing.recalcVehicleMonth(b.assetId, b.year, b.month); } catch (_) {}
      }
    } catch (_) {}
  }

  // 4. Auto-close zero-quantity legacy overdue (>30d) open MRNs
  if (tableExists(db, 'mrn') && tableExists(db, 'mrn_lines')) {
    const res = db.prepare(`
      UPDATE mrn
         SET status = 'closed',
             closed_by = COALESCE(closed_by, 'System Hygiene'),
             closed_at = COALESCE(closed_at, datetime('now')),
             closure_notes = COALESCE(closure_notes, 'Auto-closed zero-quantity legacy MRN (Migration 066)')
       WHERE status IN ('open', 'pending', 'approved', 'ordered')
         AND req_date < date('now', '-30 days')
         AND EXISTS (SELECT 1 FROM mrn_lines ml WHERE ml.mrn_id = mrn.id)
         AND NOT EXISTS (
           SELECT 1 FROM mrn_lines ml
            WHERE ml.mrn_id = mrn.id
              AND COALESCE(ml.is_cancelled, 0) = 0
              AND (COALESCE(ml.qty, 0) > 0 OR COALESCE(ml.qty_received, 0) > 0)
         )
    `).run();
    zeroQtyMrnsClosed = res.changes || 0;
  }

  return {
    testAccountsDeactivated,
    aliasesAutoLinked,
    issuesPriced,
    zeroQtyMrnsClosed,
  };
}

module.exports = { runMigration };
