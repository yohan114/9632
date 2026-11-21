'use strict';

/**
 * Migration 060: Advanced Service & Filter Plan Schema & History Seeding
 *
 * Adds:
 *   1. filter_category_rules      — fleet-wide default replacement cycle per filter category
 *   2. vehicle_filter_schedules   — per-vehicle, per-category filter kit + cycle + last replaced anchor
 *   3. service_interval_overrides — optional per-asset base interval overrides & breakdown combine %
 *
 * Idempotent: safe across empty test databases and live merged databases.
 * Never overwrites rows marked locked = 1.
 */

const { normF } = require('../lib/filter_no');

const DEFAULT_CATEGORY_RULES = [
  // Every service (1x)
  { category: 'Engine Oil Filter', every_n_services: 1, default_hours: 500, default_km: 5000, between_action: 'SKIP', notes: 'Change every service' },
  { category: 'Engine Oil Filter - S', every_n_services: 1, default_hours: 500, default_km: 5000, between_action: 'SKIP', notes: 'Secondary oil filter — change every service' },
  { category: 'Primary Fuel Filter', every_n_services: 1, default_hours: 500, default_km: 5000, between_action: 'SKIP', notes: 'Change every service' },
  { category: 'Water Separator', every_n_services: 1, default_hours: 500, default_km: 5000, between_action: 'SKIP', notes: 'Drain daily; replace element every service' },
  { category: 'Fuel Sedimentary', every_n_services: 1, default_hours: 500, default_km: 5000, between_action: 'SKIP', notes: 'Change every service' },

  // Every 2nd service (2x) — clean/inspect between changes for air filters
  { category: 'Air Filter Outer', every_n_services: 2, default_hours: 1000, default_km: 10000, between_action: 'E', notes: 'Clean/inspect between; replace every 2nd service or when restricted' },
  { category: 'Air Filter', every_n_services: 2, default_hours: 1000, default_km: 10000, between_action: 'E', notes: 'Clean/inspect between; replace every 2nd service' },
  { category: 'Engine Air Filter - S', every_n_services: 2, default_hours: 1000, default_km: 10000, between_action: 'E', notes: 'Clean/inspect between; replace every 2nd service' },
  { category: 'Engine fuel Filter - S', every_n_services: 2, default_hours: 1000, default_km: 10000, between_action: 'SKIP', notes: 'Secondary fuel filter — every 2nd service' },
  { category: 'Coolant Filter', every_n_services: 2, default_hours: 1000, default_km: 10000, between_action: 'SKIP', notes: 'Every 2nd service' },

  // Every 4th / major service (4x) — long-life hydraulic, transmission, breather & inner air filters
  { category: 'Air Filter Inner', every_n_services: 4, default_hours: 2000, default_km: 20000, between_action: 'E', notes: 'Inspect only between; replace every 4th (major) service' },
  { category: 'Hydraulic Filter - S', every_n_services: 4, default_hours: 2000, default_km: 20000, between_action: 'SKIP', notes: 'Major hydraulic service interval' },
  { category: 'Trans: Filter', every_n_services: 4, default_hours: 2000, default_km: 20000, between_action: 'SKIP', notes: 'Major transmission service interval' },
  { category: 'Line Filter', every_n_services: 4, default_hours: 2000, default_km: 20000, between_action: 'SKIP', notes: 'High-pressure / line filter — major interval' },
  { category: 'Power Steering Filter', every_n_services: 4, default_hours: 2000, default_km: 20000, between_action: 'SKIP', notes: 'Major service interval' },
  { category: 'Air Dryer Filter', every_n_services: 4, default_hours: 2000, default_km: 20000, between_action: 'SKIP', notes: 'Major pneumatic service interval' },
  { category: 'Air Breather Filter', every_n_services: 4, default_hours: 2000, default_km: 20000, between_action: 'SKIP', notes: 'Major tank breather interval' },
  { category: 'Fuel Tank Filter', every_n_services: 4, default_hours: 2000, default_km: 20000, between_action: 'SKIP', notes: 'Major fuel strainer interval' },
];

function splitTopLevelParts(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const segs = [''];
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === '&' || ch === '+')) {
      segs.push('');
      continue;
    }
    segs[segs.length - 1] += ch;
  }
  return segs.map((x) => x.trim()).filter(Boolean);
}

function isUsablePartToken(raw) {
  const n = normF(raw);
  return !!n && /[0-9]/.test(n) && n.length <= 20;
}

function parseNumericMeter(raw) {
  const s = String(raw || '').trim();
  if (!s || !/\d/.test(s)) return null;
  if (/^(mnw|m\.?n\.?r|nw|not\s*word|n|m\s*req)$/i.test(s)) return null;
  const cleaned = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!cleaned) return null;
  const v = Number(cleaned[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function defaultRuleFor(rulesMap, category) {
  const key = String(category || '').trim();
  if (rulesMap.has(key)) return rulesMap.get(key);
  const lower = key.toLowerCase();
  if (/oil\s*filter/.test(lower)) return { category: key, every_n_services: 1, between_action: 'SKIP' };
  if (/primary\s*fuel|water\s*sep|sediment/.test(lower)) return { category: key, every_n_services: 1, between_action: 'SKIP' };
  if (/air.*inner/.test(lower)) return { category: key, every_n_services: 4, between_action: 'E' };
  if (/air/.test(lower)) return { category: key, every_n_services: 2, between_action: 'E' };
  if (/hyd|trans|line|steering|dryer|breather|tank/.test(lower)) return { category: key, every_n_services: 4, between_action: 'SKIP' };
  return { category: key, every_n_services: 1, between_action: 'SKIP' };
}

/**
 * Derive per-vehicle filter replacement cycles from historical service_jobs + service_filters.
 * Safe to run repeatedly; skips rows where locked = 1.
 */
function backfillVehicleFilterSchedules(targetDb) {
  const hasSvc = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_jobs'").get();
  const hasFil = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_filters'").get();
  if (!hasSvc || !hasFil) return 0;

  const svcCount = targetDb.prepare('SELECT COUNT(*) n FROM service_jobs').get().n;
  if (!svcCount) return 0;

  const rulesMap = new Map();
  for (const r of targetDb.prepare('SELECT * FROM filter_category_rules').all()) {
    rulesMap.set(r.category, r);
  }

  const lockedSet = new Set(
    targetDb.prepare('SELECT asset_id, category FROM vehicle_filter_schedules WHERE locked = 1').all()
      .map((r) => `${r.asset_id}|${r.category}`)
  );

  const jobs = targetDb.prepare(`
    SELECT s.id, s.asset_id, date(s.service_date) AS d, s.meter_reading
      FROM service_jobs s
     WHERE s.asset_id IS NOT NULL AND s.service_date IS NOT NULL AND TRIM(s.service_date) <> ''
     ORDER BY s.asset_id, date(s.service_date), s.id
  `).all();

  const filtersBySvc = new Map();
  for (const f of targetDb.prepare(`
    SELECT id, service_id, filter_no, filter_no_norm, category, action_type, qty
      FROM service_filters
     WHERE category IS NOT NULL AND TRIM(category) <> ''
     ORDER BY id
  `).all()) {
    if (!filtersBySvc.has(f.service_id)) filtersBySvc.set(f.service_id, []);
    filtersBySvc.get(f.service_id).push(f);
  }

  // Collapse same-day rows into logical visits per asset
  const visitsByAsset = new Map();
  const seenVisit = new Map();
  for (const j of jobs) {
    const key = `${j.asset_id}|${j.d}`;
    let v = seenVisit.get(key);
    if (!v) {
      v = {
        asset_id: j.asset_id,
        date: j.d,
        last_service_id: j.id,
        meter: parseNumericMeter(j.meter_reading),
        lines: [],
      };
      seenVisit.set(key, v);
      if (!visitsByAsset.has(j.asset_id)) visitsByAsset.set(j.asset_id, []);
      visitsByAsset.get(j.asset_id).push(v);
    }
    v.last_service_id = j.id;
    if (!v.meter) v.meter = parseNumericMeter(j.meter_reading);
    v.lines.push(...(filtersBySvc.get(j.id) || []));
  }

  const upsert = targetDb.prepare(`
    INSERT INTO vehicle_filter_schedules (
      asset_id, category, part_no, part_no_norm, qty,
      every_n_services, between_action,
      last_replaced_service_id, last_replaced_date, last_replaced_meter,
      active, source, locked, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'history', 0, datetime('now'))
    ON CONFLICT(asset_id, category) DO UPDATE SET
      part_no = COALESCE(excluded.part_no, vehicle_filter_schedules.part_no),
      part_no_norm = COALESCE(excluded.part_no_norm, vehicle_filter_schedules.part_no_norm),
      qty = excluded.qty,
      every_n_services = excluded.every_n_services,
      between_action = excluded.between_action,
      last_replaced_service_id = excluded.last_replaced_service_id,
      last_replaced_date = excluded.last_replaced_date,
      last_replaced_meter = COALESCE(excluded.last_replaced_meter, vehicle_filter_schedules.last_replaced_meter),
      updated_at = datetime('now')
    WHERE vehicle_filter_schedules.locked = 0
  `);

  let written = 0;
  targetDb.transaction(() => {
    for (const [assetId, visits] of visitsByAsset) {
      const filteredVisits = visits.filter((v) => v.lines.length > 0);
      const totalV = filteredVisits.length || visits.length;
      if (!totalV) continue;

      const byCat = new Map();
      for (let idx = 0; idx < visits.length; idx++) {
        const v = visits[idx];
        const catsSeenInVisit = new Set();
        for (const l of v.lines) {
          const cat = String(l.category || '').trim();
          if (!cat) continue;
          const act = String(l.action_type || 'X').trim().toUpperCase();
          const isClean = act === 'E';

          if (!byCat.has(cat)) {
            byCat.set(cat, { replacedVisits: new Set(), cleanedVisits: new Set(), lastX: null });
          }
          const rec = byCat.get(cat);
          if (isClean) {
            rec.cleanedVisits.add(idx);
          } else {
            rec.replacedVisits.add(idx);
            const rawFn = l.filter_no ? String(l.filter_no).trim() : null;
            const split = splitTopLevelParts(rawFn);
            const usable = split.filter(isUsablePartToken);
            const qtyFromParts = usable.length > 1 ? usable.length : (Number(l.qty) > 0 ? Number(l.qty) : 1);
            const partNo = usable.length ? usable.join(' & ') : (isUsablePartToken(rawFn) ? rawFn : null);
            const partNorm = partNo ? normF(usable[0] || partNo) : null;
            rec.lastX = {
              service_id: v.last_service_id,
              date: v.date,
              meter: v.meter,
              part_no: partNo,
              part_no_norm: partNorm,
              qty: qtyFromParts,
            };
          }
          catsSeenInVisit.add(cat);
        }
      }

      for (const [cat, rec] of byCat) {
        if (lockedSet.has(`${assetId}|${cat}`)) continue;
        const rule = defaultRuleFor(rulesMap, cat);
        const repCount = rec.replacedVisits.size;
        if (repCount === 0 && rec.cleanedVisits.size === 0) continue;

        let everyN = rule.every_n_services || 1;
        // Let a machine's own clear multi-service history inform the cycle when >= 3 visits exist
        if (totalV >= 3 && repCount >= 1) {
          const ratio = repCount / totalV;
          if (/engine oil filter/i.test(cat)) {
            everyN = 1;
          } else if (ratio >= 0.65) {
            everyN = 1;
          } else if (repCount >= 2) {
            everyN = Math.min(4, Math.max(2, Math.round(totalV / repCount)));
          } else {
            everyN = Math.max(2, rule.every_n_services || 2);
          }
        }
        const betweenAction = rec.cleanedVisits.size > 0 ? 'E' : (rule.between_action || 'SKIP');
        const lastX = rec.lastX;

        upsert.run(
          assetId,
          cat,
          lastX ? lastX.part_no : null,
          lastX ? lastX.part_no_norm : null,
          lastX ? lastX.qty : 1,
          everyN,
          betweenAction,
          lastX ? lastX.service_id : null,
          lastX ? lastX.date : null,
          lastX ? lastX.meter : null
        );
        written++;
      }
    }
  })();

  return written;
}

function runMigration(targetDb) {
  if (!targetDb) return;

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS filter_category_rules (
      category          TEXT PRIMARY KEY,
      every_n_services  INTEGER NOT NULL DEFAULT 1,
      default_hours     REAL,
      default_km        REAL,
      between_action    TEXT NOT NULL DEFAULT 'SKIP' CHECK (between_action IN ('SKIP', 'E')),
      notes             TEXT,
      updated_by        TEXT,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vehicle_filter_schedules (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id                 INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      category                 TEXT NOT NULL,
      part_no                  TEXT,
      part_no_norm             TEXT,
      qty                      REAL NOT NULL DEFAULT 1,
      every_n_services         INTEGER NOT NULL DEFAULT 1,
      interval_units           REAL,
      between_action           TEXT NOT NULL DEFAULT 'SKIP' CHECK (between_action IN ('SKIP', 'E')),
      last_replaced_service_id INTEGER,
      last_replaced_date       TEXT,
      last_replaced_meter      REAL,
      active                   INTEGER NOT NULL DEFAULT 1,
      source                   TEXT NOT NULL DEFAULT 'history',
      locked                   INTEGER NOT NULL DEFAULT 0,
      notes                    TEXT,
      updated_by               TEXT,
      updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(asset_id, category)
    );
    CREATE INDEX IF NOT EXISTS idx_vfs_asset ON vehicle_filter_schedules(asset_id);

    CREATE TABLE IF NOT EXISTS service_interval_overrides (
      asset_id       INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      basis          TEXT CHECK (basis IN ('HOURS', 'KM')),
      interval_value REAL NOT NULL,
      warn_threshold REAL,
      combine_pct    REAL NOT NULL DEFAULT 0.2,
      notes          TEXT,
      updated_by     TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const seedRule = targetDb.prepare(`
    INSERT OR IGNORE INTO filter_category_rules (
      category, every_n_services, default_hours, default_km, between_action, notes
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  targetDb.transaction(() => {
    for (const r of DEFAULT_CATEGORY_RULES) {
      seedRule.run(r.category, r.every_n_services, r.default_hours, r.default_km, r.between_action, r.notes);
    }
    // Ensure any custom category already in filter_category_list gets a baseline row too
    const hasCatList = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='filter_category_list'").get();
    if (hasCatList) {
      for (const c of targetDb.prepare('SELECT name FROM filter_category_list WHERE name IS NOT NULL').all()) {
        const name = String(c.name).trim();
        if (!name) continue;
        const fallback = defaultRuleFor(new Map(), name);
        seedRule.run(name, fallback.every_n_services, fallback.every_n_services * 500, fallback.every_n_services * 5000, fallback.between_action, 'Auto-seeded from category list');
      }
    }
  })();

  backfillVehicleFilterSchedules(targetDb);
}

module.exports = {
  runMigration,
  backfillVehicleFilterSchedules,
  DEFAULT_CATEGORY_RULES,
  defaultRuleFor,
  splitTopLevelParts,
  isUsablePartToken,
  parseNumericMeter,
};
