'use strict';

/**
 * Self-Service Asset Merge & Ownership / Meter Triage (Stage C — Pillar 2)
 *
 * Safely folds duplicate/typo asset records onto canonical fleet assets:
 *  - Discovers all SQLite FKs pointing to `assets(id)` plus non-FK fuel/billing/fleet tables
 *  - Deduplicates composite UNIQUE tables (`vehicle_monthly_costs`, `vehicle_documents`,
 *    `vehicle_filter_schedules`, `fleet_monthly_snapshots`, `fleet_rental_rates`,
 *    `vehicle_lubricant_capacities`) before repointing
 *  - Syncs denormalized `asset_code`, `vehicle_ref`, `vehicle_no`, `asset_reg_no` text columns
 *  - Backs up blank metadata & max meter readings onto target
 *  - Records resolved aliases in `asset_aliases` so legacy spellings still resolve
 *  - Enforces confirmation guard when merging an already-registered (`in_register = 1`) source
 */

const { get, all, run, tx } = require('../db');
const audit = require('./audit');
const aliases = require('./aliases');

const VMC_COMPONENTS = ['fuel_cost', 'oil_cost', 'filter_cost', 'battery_cost', 'parts_cost', 'labour_cost', 'total_cost'];
const bad = (msg, status = 400, extra = {}) => {
  const e = new Error(msg);
  e.status = status;
  e.extra = extra;
  return e;
};

const SPECIAL_UNIQUE_TABLES = new Set([
  'vehicle_monthly_costs',
  'vehicle_documents',
  'vehicle_filter_schedules',
  'fleet_monthly_snapshots',
  'fleet_rental_rates',
  'vehicle_lubricant_capacities',
]);

// Non-FK or code-carrying tables mapped explicitly
const EXTRA_REF_TABLES = [
  { table: 'fuel_issues', col: 'asset_id', syncCols: { asset_code: 'code', vehicle_ref: 'code' }, matchNormCol: 'asset_code', category: 'fuel' },
  { table: 'fuel_requests', col: 'asset_id', syncCols: { asset_code: 'code' }, matchNormCol: 'asset_code', category: 'fuel' },
  { table: 'fuel_meter_readings', col: 'asset_id', syncCols: { asset_code: 'code' }, matchNormCol: 'asset_code', category: 'fuel' },
  { table: 'fuel_corrections', col: 'asset_id', syncCols: { asset_code: 'code' }, category: 'fuel' },
  { table: 'fuel_daily_conditions', col: 'asset_id', syncCols: { asset_code: 'code' }, category: 'fuel' },
  { table: 'fuel_pm_tasks', col: 'asset_id', category: 'fuel' },
  { table: 'fuel_tanks', col: 'bowser_asset_id', category: 'fuel' },
  { table: 'fleet_bills', col: 'asset_id', syncCols: { asset_code: 'code', asset_reg_no: 'registration' }, category: 'billing' },
  { table: 'fleet_asset_assignments', col: 'asset_id', syncCols: { asset_code: 'code' }, category: 'billing' },
  { table: 'fleet_vehicle_allocations', col: 'asset_id', syncCols: { vehicle_no: 'code' }, category: 'billing' },
  { table: 'fleet_rental_rates', col: 'asset_id', category: 'billing' },
  { table: 'fleet_breakdowns', col: 'asset_id', syncCols: { asset_code: 'code' }, category: 'billing' },
  { table: 'fleet_financial_events', col: 'asset_id', syncCols: { asset_code: 'code' }, category: 'billing' },
  { table: 'fleet_monthly_snapshots', col: 'asset_id', syncCols: { asset_code: 'code' }, category: 'costing' },
  { table: 'fleet_billing_site_overrides', col: 'asset_id', category: 'billing' },
  { table: 'outsourcing_requests', col: 'asset_id', category: 'workshop' },
];

function schemaIntrospect() {
  const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  const tableSet = new Set(tables);
  const colsByTable = new Map();
  const fkCols = [];

  for (const t of tables) {
    const cols = new Set(all(`PRAGMA table_info("${t}")`).map((c) => c.name));
    colsByTable.set(t, cols);
    if (t === 'assets') continue;
    for (const fk of all(`PRAGMA foreign_key_list("${t}")`)) {
      if (fk.table === 'assets') {
        fkCols.push({ table: t, col: fk.from });
      }
    }
  }

  return { tableSet, colsByTable, fkCols };
}

function categoryOf(table) {
  if (/^fuel_/.test(table)) return 'fuel';
  if (/^fleet_/.test(table) && table !== 'fleet_monthly_snapshots') return 'billing';
  if (/^(job_|service_|mrn|issues|mtn|tb_|tyre|batter|filter_stock|general_item|stock_moves|stock_ledger|min_notes|outsourcing)/.test(table)) return 'workshop';
  return 'costing_docs';
}

function collectRefTargets(intro) {
  const seen = new Set();
  const targets = [];

  for (const extra of EXTRA_REF_TABLES) {
    if (!intro.tableSet.has(extra.table)) continue;
    const cols = intro.colsByTable.get(extra.table);
    if (!cols || !cols.has(extra.col)) continue;
    const key = `${extra.table}.${extra.col}`;
    seen.add(key);
    targets.push({ ...extra, cols });
  }

  for (const fk of intro.fkCols) {
    const key = `${fk.table}.${fk.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cols = intro.colsByTable.get(fk.table);
    targets.push({
      table: fk.table,
      col: fk.col,
      cols,
      category: categoryOf(fk.table),
    });
  }

  return targets;
}

function unlinkedNormCondition(t, fromNorm) {
  if (!t.matchNormCol || !fromNorm || !t.cols.has(t.matchNormCol)) return { sql: '', params: [] };
  return {
    sql: ` OR (${t.col} IS NULL AND UPPER(REPLACE(REPLACE(COALESCE(${t.matchNormCol}, ''), '-', ''), ' ', '')) = ?)`,
    params: [fromNorm],
  };
}

function inspectMergePair(sourceId, targetId) {
  const sId = Number(sourceId);
  const tId = Number(targetId);
  if (!sId || !tId) throw bad('Both source_id and target_id are required', 400);
  if (sId === tId) throw bad('Source and target asset cannot be the same record', 400);

  const source = get('SELECT * FROM assets WHERE id = ?', sId);
  if (!source) throw bad(`Source asset #${sId} not found`, 404);
  const target = get('SELECT * FROM assets WHERE id = ?', tId);
  if (!target) throw bad(`Target asset #${tId} not found`, 404);

  const intro = schemaIntrospect();
  const refTargets = collectRefTargets(intro);
  const fromNorm = aliases.normalize(source.code_norm || source.code);

  const countsByTable = {};
  const countsByGroup = { fuel: 0, billing: 0, workshop: 0, costing_docs: 0 };
  let totalAffected = 0;

  for (const t of refTargets) {
    const extraCond = unlinkedNormCondition(t, fromNorm);
    const row = get(
      `SELECT COUNT(*) AS c FROM "${t.table}" WHERE ${t.col} = ?${extraCond.sql}`,
      sId, ...extraCond.params
    );
    const c = row ? row.c : 0;
    if (c > 0) {
      countsByTable[`${t.table}.${t.col}`] = c;
      const cat = t.category || categoryOf(t.table);
      countsByGroup[cat] = (countsByGroup[cat] || 0) + c;
      totalAffected += c;
    }
  }

  let draftBills = 0;
  let finalBills = 0;
  if (intro.tableSet.has('fleet_bills')) {
    const billStats = get(
      `SELECT SUM(CASE WHEN status IN ('FINAL', 'ISSUED', 'PAID') THEN 1 ELSE 0 END) AS fin,
              SUM(CASE WHEN status NOT IN ('FINAL', 'ISSUED', 'PAID', 'VOID') THEN 1 ELSE 0 END) AS dft
         FROM fleet_bills
        WHERE asset_id = ?`,
      sId
    );
    draftBills = Number(billStats && billStats.dft) || 0;
    finalBills = Number(billStats && billStats.fin) || 0;
  }

  let overlappingVmcMonths = 0;
  if (intro.tableSet.has('vehicle_monthly_costs')) {
    overlappingVmcMonths = get(
      `SELECT COUNT(*) AS c
         FROM vehicle_monthly_costs s
         JOIN vehicle_monthly_costs t ON t.year = s.year AND t.month = s.month
        WHERE s.asset_id = ? AND t.asset_id = ?`,
      sId, tId
    ).c;
  }

  const warnings = [];
  if (source.in_register === 1) {
    warnings.push({
      code: 'REGISTERED_SOURCE',
      severity: 'HIGH',
      message: `Source asset ${source.code} is marked IN REGISTER (in_register = 1). Confirm explicitly if merging two registered assets.`,
    });
  }
  if (finalBills > 0) {
    warnings.push({
      code: 'FINAL_BILLS_ON_SOURCE',
      severity: 'MEDIUM',
      message: `Source asset ${source.code} has ${finalBills} FINAL/ISSUED/PAID hire bill(s) that will be repointed to ${target.code}.`,
    });
  }
  if (overlappingVmcMonths > 0) {
    warnings.push({
      code: 'OVERLAPPING_MONTHLY_COSTS',
      severity: 'INFO',
      message: `${overlappingVmcMonths} overlapping month(s) in vehicle_monthly_costs will be summed together.`,
    });
  }

  return {
    source,
    target,
    intro,
    refTargets,
    fromNorm,
    countsByTable,
    countsByGroup,
    totalAffected,
    draftBills,
    finalBills,
    overlappingVmcMonths,
    warnings,
    requiresRegisteredConfirm: source.in_register === 1,
  };
}

function previewMerge(sourceId, targetId) {
  const info = inspectMergePair(sourceId, targetId);
  return {
    ok: true,
    source: info.source,
    target: info.target,
    total_records: info.totalAffected,
    counts_by_group: info.countsByGroup,
    counts_by_table: info.countsByTable,
    bills_breakdown: { draft: info.draftBills, final: info.finalBills },
    overlapping_vmc_months: info.overlappingVmcMonths,
    requires_registered_confirm: info.requiresRegisteredConfirm,
    warnings: info.warnings,
  };
}

function handleVehicleMonthlyCosts(fromId, toId) {
  let changes = 0;
  for (const vr of all('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ?', fromId)) {
    const ex = get('SELECT id FROM vehicle_monthly_costs WHERE asset_id = ? AND year = ? AND month = ?', toId, vr.year, vr.month);
    if (ex) {
      run(
        `UPDATE vehicle_monthly_costs SET ${VMC_COMPONENTS.map((c) => `${c} = COALESCE(${c}, 0) + ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...VMC_COMPONENTS.map((c) => vr[c] || 0),
        ex.id
      );
      run('DELETE FROM vehicle_monthly_costs WHERE id = ?', vr.id);
    } else {
      run('UPDATE vehicle_monthly_costs SET asset_id = ?, updated_at = datetime("now") WHERE id = ?', toId, vr.id);
    }
    changes += 1;
  }
  return changes;
}

function handleVehicleDocuments(fromId, toId, intro) {
  let changes = 0;
  const hasVersions = intro.tableSet.has('vehicle_doc_versions');
  const hasTasks = intro.tableSet.has('vehicle_renewal_tasks');

  for (const srcDoc of all('SELECT * FROM vehicle_documents WHERE asset_id = ?', fromId)) {
    const tgtDoc = get(
      'SELECT * FROM vehicle_documents WHERE asset_id = ? AND doc_type_id = ?',
      toId, srcDoc.doc_type_id
    );
    if (tgtDoc) {
      if (hasVersions) {
        run('UPDATE vehicle_doc_versions SET document_id = ? WHERE document_id = ?', tgtDoc.id, srcDoc.id);
      }
      if (hasTasks) {
        run('UPDATE vehicle_renewal_tasks SET document_id = ? WHERE document_id = ?', tgtDoc.id, srcDoc.id);
      }
      if (!tgtDoc.current_version_id && srcDoc.current_version_id) {
        run(
          "UPDATE vehicle_documents SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?",
          srcDoc.current_version_id, tgtDoc.id
        );
      }
      run('DELETE FROM vehicle_documents WHERE id = ?', srcDoc.id);
    } else {
      run("UPDATE vehicle_documents SET asset_id = ?, updated_at = datetime('now') WHERE id = ?", toId, srcDoc.id);
    }
    changes += 1;
  }
  return changes;
}

function handleFilterSchedules(fromId, toId) {
  let changes = 0;
  for (const s of all('SELECT id, category FROM vehicle_filter_schedules WHERE asset_id = ?', fromId)) {
    const ex = get('SELECT id FROM vehicle_filter_schedules WHERE asset_id = ? AND category = ?', toId, s.category);
    if (ex) {
      run('DELETE FROM vehicle_filter_schedules WHERE id = ?', s.id);
    } else {
      run("UPDATE vehicle_filter_schedules SET asset_id = ?, updated_at = datetime('now') WHERE id = ?", toId, s.id);
    }
    changes += 1;
  }
  return changes;
}

function handleMonthlySnapshots(fromId, toId, target) {
  let changes = 0;
  for (const s of all('SELECT id, year, month FROM fleet_monthly_snapshots WHERE asset_id = ?', fromId)) {
    const ex = get('SELECT id FROM fleet_monthly_snapshots WHERE asset_id = ? AND year = ? AND month = ?', toId, s.year, s.month);
    if (ex) {
      run('DELETE FROM fleet_monthly_snapshots WHERE id = ?', s.id);
    } else {
      run("UPDATE fleet_monthly_snapshots SET asset_id = ?, asset_code = ?, updated_at = datetime('now') WHERE id = ?", toId, target.code, s.id);
    }
    changes += 1;
  }
  return changes;
}

function handleRentalRates(fromId, toId) {
  const srcRows = all('SELECT id FROM fleet_rental_rates WHERE asset_id = ?', fromId);
  if (!srcRows.length) return 0;
  const tgtHas = !!get('SELECT 1 FROM fleet_rental_rates WHERE asset_id = ? LIMIT 1', toId);
  if (tgtHas) {
    return run('DELETE FROM fleet_rental_rates WHERE asset_id = ?', fromId).changes;
  }
  return run("UPDATE fleet_rental_rates SET asset_id = ?, updated_at = datetime('now') WHERE asset_id = ?", toId, fromId).changes;
}

function handleLubricantCapacities(fromId, toId) {
  const srcRows = all('SELECT id FROM vehicle_lubricant_capacities WHERE asset_id = ?', fromId);
  if (!srcRows.length) return 0;
  const tgtHas = !!get('SELECT 1 FROM vehicle_lubricant_capacities WHERE asset_id = ? LIMIT 1', toId);
  if (tgtHas) {
    return run('DELETE FROM vehicle_lubricant_capacities WHERE asset_id = ?', fromId).changes;
  }
  return run("UPDATE vehicle_lubricant_capacities SET asset_id = ?, updated_at = datetime('now') WHERE asset_id = ?", toId, fromId).changes;
}

function executeMerge({ sourceId, targetId, user, reason = '', keepAlias = true, confirmRegistered = false }) {
  const info = inspectMergePair(sourceId, targetId);
  const { source, target, intro, refTargets, fromNorm } = info;

  if (source.in_register === 1 && !confirmRegistered) {
    throw bad(
      `Source asset ${source.code} is a registered fleet asset (in_register = 1). Set confirm_registered: true to merge it into ${target.code}.`,
      409,
      { requires_registered_confirm: true }
    );
  }

  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 3) {
    throw bad('Enter a merge reason (at least 3 characters) for the audit trail.', 400);
  }

  let totalRepointed = 0;

  tx(() => {
    for (const t of refTargets) {
      if (SPECIAL_UNIQUE_TABLES.has(t.table)) {
        if (t.table === 'vehicle_monthly_costs') totalRepointed += handleVehicleMonthlyCosts(source.id, target.id);
        else if (t.table === 'vehicle_documents') totalRepointed += handleVehicleDocuments(source.id, target.id, intro);
        else if (t.table === 'vehicle_filter_schedules') totalRepointed += handleFilterSchedules(source.id, target.id);
        else if (t.table === 'fleet_monthly_snapshots') totalRepointed += handleMonthlySnapshots(source.id, target.id, target);
        else if (t.table === 'fleet_rental_rates') totalRepointed += handleRentalRates(source.id, target.id);
        else if (t.table === 'vehicle_lubricant_capacities') totalRepointed += handleLubricantCapacities(source.id, target.id);
        continue;
      }

      const sets = [`${t.col} = ?`];
      const setParams = [target.id];
      if (t.syncCols) {
        for (const [textCol, assetField] of Object.entries(t.syncCols)) {
          if (!t.cols.has(textCol)) continue;
          if (assetField === 'code') {
            sets.push(`${textCol} = ?`);
            setParams.push(target.code);
          } else if (assetField === 'registration' && target.registration) {
            sets.push(`${textCol} = ?`);
            setParams.push(target.registration);
          }
        }
      }

      const extraCond = unlinkedNormCondition(t, fromNorm);
      totalRepointed += run(
        `UPDATE "${t.table}" SET ${sets.join(', ')} WHERE ${t.col} = ?${extraCond.sql}`,
        ...setParams, source.id, ...extraCond.params
      ).changes;
    }

    // Backfill blank metadata and higher meter readings onto target
    const backfillSets = [];
    const backfillParams = [];
    for (const field of ['registration', 'ec_code', 'brand', 'type', 'model_no', 'chassis_no', 'engine_no', 'meter_type', 'category']) {
      if ((!target[field] || !String(target[field]).trim()) && source[field] && String(source[field]).trim()) {
        backfillSets.push(`${field} = ?`);
        backfillParams.push(source[field]);
      }
    }
    const maxCurHrs = Math.max(Number(target.current_hours || 0), Number(source.current_hours || 0));
    const maxRunHrs = Math.max(Number(target.running_hours || 0), Number(source.running_hours || 0));
    if (maxCurHrs > Number(target.current_hours || 0)) {
      backfillSets.push('current_hours = ?');
      backfillParams.push(maxCurHrs);
    }
    if (maxRunHrs > Number(target.running_hours || 0)) {
      backfillSets.push('running_hours = ?');
      backfillParams.push(maxRunHrs);
    }
    if (backfillSets.length) {
      backfillSets.push("updated_at = datetime('now')");
      run(`UPDATE assets SET ${backfillSets.join(', ')} WHERE id = ?`, ...backfillParams, target.id);
    }

    // Preserve legacy spelling as a resolved alias pointing to canonical target
    if (keepAlias !== false && intro.tableSet.has('asset_aliases')) {
      for (const rawLabel of [source.code, source.registration, source.ec_code]) {
        const clean = String(rawLabel || '').trim();
        const rn = aliases.normalize(clean);
        if (!clean || !rn || rn === target.code_norm) continue;
        run(
          `INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source, updated_at)
             VALUES (?, ?, ?, 1, 0, 'manual-merge', datetime('now'))
           ON CONFLICT(raw_norm) DO UPDATE SET asset_id = excluded.asset_id, resolved = 1, source = 'manual-merge', updated_at = datetime('now')`,
          clean, rn, target.id
        );
      }
    }

    run('DELETE FROM assets WHERE id = ?', source.id);
  });

  audit.record({
    userId: user ? user.id : null,
    entity: 'asset',
    entityId: target.id,
    action: 'merge_duplicate',
    before: { source, target },
    after: {
      source_deleted_id: source.id,
      source_code: source.code,
      target_id: target.id,
      target_code: target.code,
      total_repointed: totalRepointed,
      counts_by_table: info.countsByTable,
      reason: cleanReason,
    },
    reason: cleanReason,
  });

  return {
    ok: true,
    source_id: source.id,
    source_code: source.code,
    target_id: target.id,
    target_code: target.code,
    total_repointed: totalRepointed,
    counts_by_group: info.countsByGroup,
    counts_by_table: info.countsByTable,
    target: get('SELECT * FROM assets WHERE id = ?', target.id),
  };
}

function getTriageSummary() {
  const row = get(`
    SELECT COUNT(*) AS total_assets,
           SUM(CASE WHEN in_register = 1 THEN 1 ELSE 0 END) AS registered_count,
           SUM(CASE WHEN in_register = 0 THEN 1 ELSE 0 END) AS unregistered_count,
           SUM(CASE WHEN UPPER(COALESCE(ownership, 'OWNED')) = 'HIRED' THEN 1 ELSE 0 END) AS hired_count,
           SUM(CASE WHEN in_register = 1 AND status = 'active' AND (meter_type IS NULL OR TRIM(meter_type) = '' OR COALESCE(current_hours, 0) <= 0) THEN 1 ELSE 0 END) AS missing_meter_count
      FROM assets
  `);
  return row || {
    total_assets: 0,
    registered_count: 0,
    unregistered_count: 0,
    hired_count: 0,
    missing_meter_count: 0,
  };
}

function findDuplicateCandidates({ limit = 50 } = {}) {
  const assets = all(`
    SELECT a.id, a.code, a.code_norm, a.registration, a.ec_code, a.brand, a.type, a.category,
           a.in_register, a.ownership, a.status, a.meter_type, a.current_hours,
           COALESCE(fc.cnt, 0) AS fuel_count,
           COALESCE(jc.cnt, 0) AS job_count,
           COALESCE(bc.cnt, 0) AS bill_count
      FROM assets a
      LEFT JOIN (SELECT asset_id, COUNT(*) AS cnt FROM fuel_issues WHERE is_voided = 0 GROUP BY asset_id) fc ON fc.asset_id = a.id
      LEFT JOIN (SELECT asset_id, COUNT(*) AS cnt FROM job_cards GROUP BY asset_id) jc ON jc.asset_id = a.id
      LEFT JOIN (SELECT asset_id, COUNT(*) AS cnt FROM fleet_bills GROUP BY asset_id) bc ON bc.asset_id = a.id
     ORDER BY a.in_register DESC, a.id ASC
  `);

  const groups = new Map();
  const addKey = (key, a, matchType) => {
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key, matchType, items: [] });
    const g = groups.get(key);
    if (!g.items.some((x) => x.id === a.id)) g.items.push(a);
  };

  for (const a of assets) {
    const regNorm = aliases.normalize(a.registration);
    if (regNorm && regNorm.length >= 4) {
      addKey(`REG:${regNorm}`, a, 'registration_match');
    }
    const cn = String(a.code_norm || '');
    if (cn.length >= 5 && /\d{4}$/.test(cn)) {
      addKey(`NUM:${cn.slice(-4)}`, a, '4_digit_suffix');
    }
  }

  const pairs = [];
  const seenPairs = new Set();

  for (const grp of groups.values()) {
    if (grp.items.length < 2) continue;
    const sorted = [...grp.items].sort((a, b) =>
      (b.in_register - a.in_register)
      || (b.bill_count - a.bill_count)
      || (b.fuel_count - a.fuel_count)
      || (a.id - b.id)
    );
    const target = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const source = sorted[i];
      const pairKey = `${Math.min(source.id, target.id)}:${Math.max(source.id, target.id)}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const hasMixedRegister = target.in_register === 1 && source.in_register === 0;
      const confidence = grp.matchType === 'registration_match'
        ? (hasMixedRegister ? 'HIGH' : 'MEDIUM')
        : (hasMixedRegister ? 'MEDIUM' : 'LOW');

      pairs.push({
        source,
        target,
        match_type: grp.matchType,
        match_key: grp.key,
        confidence,
        score: (confidence === 'HIGH' ? 90 : confidence === 'MEDIUM' ? 70 : 40) + (hasMixedRegister ? 10 : 0),
      });
    }
  }

  pairs.sort((a, b) => b.score - a.score || (b.source.fuel_count + b.source.job_count) - (a.source.fuel_count + a.source.job_count));
  return pairs.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200));
}

function triageAsset(assetId, patch = {}, user = null) {
  const id = Number(assetId);
  const before = get('SELECT * FROM assets WHERE id = ?', id);
  if (!before) throw bad('Asset not found', 404);

  const sets = [];
  const params = [];

  if (patch.ownership !== undefined) {
    const own = String(patch.ownership || '').trim().toUpperCase();
    if (!['OWNED', 'HIRED'].includes(own)) throw bad('ownership must be OWNED or HIRED', 400);
    sets.push('ownership = ?');
    params.push(own);
  }

  if (patch.in_register !== undefined) {
    const ir = Number(patch.in_register) ? 1 : 0;
    sets.push('in_register = ?');
    params.push(ir);
  }

  if (patch.meter_type !== undefined) {
    const mt = patch.meter_type == null || String(patch.meter_type).trim() === ''
      ? null
      : String(patch.meter_type).trim().toUpperCase();
    if (mt && !['KM', 'HOURS', 'NONE'].includes(mt)) {
      throw bad('meter_type must be KM, HOURS, NONE, or blank', 400);
    }
    sets.push('meter_type = ?');
    params.push(mt);
  }

  if (patch.current_hours !== undefined && patch.current_hours !== '' && patch.current_hours !== null) {
    const hrs = Number(patch.current_hours);
    if (!Number.isFinite(hrs) || hrs < 0) throw bad('current_hours must be a non-negative number', 400);
    sets.push('current_hours = ?');
    params.push(hrs);
  }

  if (patch.status !== undefined) {
    const st = String(patch.status || '').trim().toLowerCase();
    if (!['active', 'idle', 'under_repair', 'decommissioned'].includes(st)) {
      throw bad('status must be active, idle, under_repair, or decommissioned', 400);
    }
    sets.push('status = ?');
    params.push(st);
  }

  if (!sets.length) return before;

  sets.push("updated_at = datetime('now')");
  run(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  const after = get('SELECT * FROM assets WHERE id = ?', id);

  audit.record({
    userId: user ? user.id : null,
    entity: 'asset',
    entityId: id,
    action: 'triage',
    before,
    after,
    reason: patch.reason ? String(patch.reason).trim() : null,
  });

  return after;
}

module.exports = {
  previewMerge,
  executeMerge,
  getTriageSummary,
  findDuplicateCandidates,
  triageAsset,
};
