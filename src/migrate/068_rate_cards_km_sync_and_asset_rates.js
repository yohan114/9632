'use strict';

/**
 * Migration 068: Sync km/L Road Vehicle Rate Cards, Fix 3 Misclassified Plant Items,
 * and Upsert Confirmed Asset Rate Cards (Single Cabs, Welding Generators, Generators)
 *
 * Idempotent across live and fresh test databases.
 * Never modifies existing fleet_bills rows.
 */

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function getColumnSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function ensureCol(db, table, col, def) {
  const cols = getColumnSet(db, table);
  if (cols.size > 0 && !cols.has(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

const SINGLE_CAB_RATE = {
  equip_type: 'FLEET',
  category_name: 'Single Cab',
  rate_basis: 'KM',
  default_basis: 'WET',
  rate_cents: 4500,
  dry_rate_cents: 4500,
  wet_rate_cents: 7000,
  fully_wet_rate_cents: 11000,
  km_dry_cents: 4500,
  km_wet_cents: 7000,
  km_fw_cents: 11000,
  hr_dry_cents: 60000,
  hr_wet_cents: 106000,
  hr_fw_cents: 106000,
  dy_dry_cents: 230000,
  dy_wet_cents: 400000,
  dy_fw_cents: 400000,
  port_dd_cents: null,
  port_dw_cents: null,
  min_bill_hours: 3000,
  fuel_cons_basis: 'km',
  fuel_cons_econ: 0.07092198581560284,
  fuel_cons_typ: 0.09090909090909091,
  fuel_cons_heavy: 0.11363636363636363,
  source_label: 'Single Cab standard rate (km/L)',
  note: 'Single Cab standard rate (Dry Rs 45 / Wet Rs 70 / FW Rs 110 per km)',
};

const WELDING_PLANT_RATE = {
  equip_type: 'PORTABLE',
  category_name: 'Welding Plant',
  rate_basis: 'DAILY',
  default_basis: 'DRY',
  rate_cents: 650000,
  dry_rate_cents: 650000,
  wet_rate_cents: 950000,
  fully_wet_rate_cents: 950000,
  km_dry_cents: null,
  km_wet_cents: null,
  km_fw_cents: null,
  hr_dry_cents: null,
  hr_wet_cents: null,
  hr_fw_cents: null,
  dy_dry_cents: null,
  dy_wet_cents: null,
  dy_fw_cents: null,
  port_dd_cents: 650000,
  port_dw_cents: 950000,
  min_bill_hours: 0,
  fuel_cons_basis: null,
  fuel_cons_econ: null,
  fuel_cons_typ: null,
  fuel_cons_heavy: null,
  source_label: 'Welding Plant · 300 A diesel (engine-driven)',
  note: 'Welding generator standard rate (Dry Rs 6,500 / Wet Rs 9,500 per day)',
};

const GENERATOR_20_25_KVA_RATE = {
  equip_type: 'PORTABLE',
  category_name: 'Generator · 20–25 kVA (diesel, 3-ph)',
  rate_basis: 'DAILY',
  default_basis: 'DRY',
  rate_cents: 600000,
  dry_rate_cents: 600000,
  wet_rate_cents: 1200000,
  fully_wet_rate_cents: 1200000,
  km_dry_cents: null,
  km_wet_cents: null,
  km_fw_cents: null,
  hr_dry_cents: null,
  hr_wet_cents: null,
  hr_fw_cents: null,
  dy_dry_cents: null,
  dy_wet_cents: null,
  dy_fw_cents: null,
  port_dd_cents: 600000,
  port_dw_cents: 1200000,
  min_bill_hours: 0,
  fuel_cons_basis: null,
  fuel_cons_econ: null,
  fuel_cons_typ: null,
  fuel_cons_heavy: null,
  source_label: 'Generator · 20–25 kVA (diesel, 3-ph)',
  note: 'Generator 20-25 kVA standard rate (Dry Rs 6,000 / Wet Rs 12,000 per day)',
};

const GENERATOR_10_KVA_RATE = {
  equip_type: 'PORTABLE',
  category_name: 'Generator · 10 kVA (diesel, 1-ph)',
  rate_basis: 'DAILY',
  default_basis: 'DRY',
  rate_cents: 350000,
  dry_rate_cents: 350000,
  wet_rate_cents: 700000,
  fully_wet_rate_cents: 700000,
  km_dry_cents: null,
  km_wet_cents: null,
  km_fw_cents: null,
  hr_dry_cents: null,
  hr_wet_cents: null,
  hr_fw_cents: null,
  dy_dry_cents: null,
  dy_wet_cents: null,
  dy_fw_cents: null,
  port_dd_cents: 350000,
  port_dw_cents: 700000,
  min_bill_hours: 0,
  fuel_cons_basis: null,
  fuel_cons_econ: null,
  fuel_cons_typ: null,
  fuel_cons_heavy: null,
  source_label: 'Generator · 10 kVA (diesel, 1-ph)',
  note: 'Generator 10 kVA standard rate (Dry Rs 3,500 / Wet Rs 7,000 per day)',
};

const COMPARE_RATE_KEYS = [
  'equip_type', 'category_name', 'rate_basis', 'default_basis',
  'rate_cents', 'dry_rate_cents', 'wet_rate_cents', 'fully_wet_rate_cents',
  'km_dry_cents', 'km_wet_cents', 'km_fw_cents',
  'hr_dry_cents', 'hr_wet_cents', 'hr_fw_cents',
  'dy_dry_cents', 'dy_wet_cents', 'dy_fw_cents',
  'port_dd_cents', 'port_dw_cents', 'min_bill_hours',
  'fuel_cons_basis', 'source_label', 'note',
];

function rateRowMatches(existing, expected) {
  return COMPARE_RATE_KEYS.every((k) => (existing[k] ?? null) === (expected[k] ?? null));
}

function updateAssetMetadata(db, assetCols, assetId, updates) {
  if (!updates || !assetId) return;
  const sets = [];
  const params = [];

  if (updates.type && assetCols.has('type')) {
    if (updates.onlyIfEmptyType) {
      sets.push("type = COALESCE(NULLIF(TRIM(type), ''), ?)");
    } else {
      sets.push('type = ?');
    }
    params.push(updates.type);
  }
  if (updates.brand && assetCols.has('brand')) {
    sets.push('brand = ?');
    params.push(updates.brand);
  }
  if (updates.model_no && assetCols.has('model_no')) {
    sets.push("model_no = COALESCE(NULLIF(TRIM(model_no), ''), ?)");
    params.push(updates.model_no);
  }
  if (updates.meter_type && assetCols.has('meter_type')) {
    if (updates.onlyIfNullMeter) {
      sets.push('meter_type = COALESCE(meter_type, ?)');
    } else {
      sets.push('meter_type = ?');
    }
    params.push(updates.meter_type);
  }

  if (sets.length === 0) return;
  if (assetCols.has('updated_at')) sets.push("updated_at = datetime('now')");
  params.push(assetId);
  db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function upsertAssetRate(db, assetCols, code, assetUpdates, rateValues) {
  const asset = db.prepare('SELECT id, code FROM assets WHERE UPPER(TRIM(code)) = UPPER(?) LIMIT 1').get(code);
  if (!asset) return false;

  updateAssetMetadata(db, assetCols, asset.id, assetUpdates);

  const existing = db.prepare(
    'SELECT * FROM fleet_rental_rates WHERE asset_id = ? ORDER BY updated_at DESC, id ASC LIMIT 1'
  ).get(asset.id);

  if (existing) {
    if (rateRowMatches(existing, rateValues)) return false;
    db.prepare(`
      UPDATE fleet_rental_rates
         SET equip_type = ?,
             category_name = ?,
             rate_basis = ?,
             default_basis = ?,
             rate_cents = ?,
             dry_rate_cents = ?,
             wet_rate_cents = ?,
             fully_wet_rate_cents = ?,
             km_dry_cents = ?,
             km_wet_cents = ?,
             km_fw_cents = ?,
             hr_dry_cents = ?,
             hr_wet_cents = ?,
             hr_fw_cents = ?,
             dy_dry_cents = ?,
             dy_wet_cents = ?,
             dy_fw_cents = ?,
             port_dd_cents = ?,
             port_dw_cents = ?,
             min_bill_hours = ?,
             fuel_cons_basis = ?,
             fuel_cons_econ = ?,
             fuel_cons_typ = ?,
             fuel_cons_heavy = ?,
             source_label = ?,
             note = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(
      rateValues.equip_type,
      rateValues.category_name,
      rateValues.rate_basis,
      rateValues.default_basis,
      rateValues.rate_cents,
      rateValues.dry_rate_cents,
      rateValues.wet_rate_cents,
      rateValues.fully_wet_rate_cents,
      rateValues.km_dry_cents,
      rateValues.km_wet_cents,
      rateValues.km_fw_cents,
      rateValues.hr_dry_cents,
      rateValues.hr_wet_cents,
      rateValues.hr_fw_cents,
      rateValues.dy_dry_cents,
      rateValues.dy_wet_cents,
      rateValues.dy_fw_cents,
      rateValues.port_dd_cents,
      rateValues.port_dw_cents,
      rateValues.min_bill_hours,
      rateValues.fuel_cons_basis,
      rateValues.fuel_cons_econ,
      rateValues.fuel_cons_typ,
      rateValues.fuel_cons_heavy,
      rateValues.source_label,
      rateValues.note,
      existing.id
    );
    return true;
  }

  const rateId = `rate-asset-${asset.id}`;
  db.prepare(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, equip_type, category_name, rate_basis, default_basis,
      rate_cents, dry_rate_cents, wet_rate_cents, fully_wet_rate_cents,
      km_dry_cents, km_wet_cents, km_fw_cents,
      hr_dry_cents, hr_wet_cents, hr_fw_cents,
      dy_dry_cents, dy_wet_cents, dy_fw_cents,
      port_dd_cents, port_dw_cents, min_bill_hours,
      fuel_cons_basis, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy,
      source_label, note, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, datetime('now'), datetime('now')
    )
  `).run(
    rateId,
    asset.id,
    rateValues.equip_type,
    rateValues.category_name,
    rateValues.rate_basis,
    rateValues.default_basis,
    rateValues.rate_cents,
    rateValues.dry_rate_cents,
    rateValues.wet_rate_cents,
    rateValues.fully_wet_rate_cents,
    rateValues.km_dry_cents,
    rateValues.km_wet_cents,
    rateValues.km_fw_cents,
    rateValues.hr_dry_cents,
    rateValues.hr_wet_cents,
    rateValues.hr_fw_cents,
    rateValues.dy_dry_cents,
    rateValues.dy_wet_cents,
    rateValues.dy_fw_cents,
    rateValues.port_dd_cents,
    rateValues.port_dw_cents,
    rateValues.min_bill_hours,
    rateValues.fuel_cons_basis,
    rateValues.fuel_cons_econ,
    rateValues.fuel_cons_typ,
    rateValues.fuel_cons_heavy,
    rateValues.source_label,
    rateValues.note
  );
  return true;
}

function runMigration(targetDb) {
  if (!targetDb || !tableExists(targetDb, 'fleet_rental_rates') || !tableExists(targetDb, 'assets')) {
    return { skipped: true };
  }

  for (const [col, def] of [
    ['hr_dry_cents', 'INTEGER'],
    ['hr_wet_cents', 'INTEGER'],
    ['hr_fw_cents', 'INTEGER'],
    ['dy_dry_cents', 'INTEGER'],
    ['dy_wet_cents', 'INTEGER'],
    ['dy_fw_cents', 'INTEGER'],
    ['km_dry_cents', 'INTEGER'],
    ['km_wet_cents', 'INTEGER'],
    ['km_fw_cents', 'INTEGER'],
    ['port_dd_cents', 'INTEGER'],
    ['port_dw_cents', 'INTEGER'],
    ['equip_type', "TEXT DEFAULT 'FLEET'"],
    ['default_basis', "TEXT DEFAULT 'DRY'"],
    ['fully_wet_rate_cents', 'INTEGER'],
    ['source_label', 'TEXT'],
    ['fuel_cons_econ', 'REAL'],
    ['fuel_cons_typ', 'REAL'],
    ['fuel_cons_heavy', 'REAL'],
    ['fuel_cons_basis', 'TEXT'],
  ]) {
    ensureCol(targetDb, 'fleet_rental_rates', col, def);
  }

  const assetCols = getColumnSet(targetDb, 'assets');

  let misclassifiedFixed = 0;
  let kmSynced = 0;
  let singleCabsUpserted = 0;
  let weldingUpserted = 0;
  let generatorsUpserted = 0;
  let portableSynced = 0;

  targetDb.transaction(() => {
    // 1. Fix 3 misclassified heavy plant / machinery items BEFORE bulk KM sync
    // 1a. DB-02: delete spurious duplicate KM (45/70/110) row when a valid HOURLY Bowser row exists
    const db02 = targetDb.prepare("SELECT id FROM assets WHERE UPPER(TRIM(code)) = 'DB-02' LIMIT 1").get();
    if (db02) {
      const hasHourlyBowser = targetDb.prepare(
        "SELECT 1 FROM fleet_rental_rates WHERE asset_id = ? AND rate_basis = 'HOURLY' LIMIT 1"
      ).get(db02.id);
      if (hasHourlyBowser) {
        const delInfo = targetDb.prepare(
          "DELETE FROM fleet_rental_rates WHERE asset_id = ? AND rate_basis = 'KM' AND km_wet_cents = 7000"
        ).run(db02.id);
        if (delInfo.changes > 0) misclassifiedFixed += delInfo.changes;
      }
      updateAssetMetadata(targetDb, assetCols, db02.id, { meter_type: 'HOURS' });
    }

    // 1b. 3 ton roller: reclassify from Double Cab (Pickup) to Vibrating Roller (L/hr, HOURLY)
    const roller = targetDb.prepare("SELECT id FROM assets WHERE UPPER(TRIM(code)) = '3 TON ROLLER' LIMIT 1").get();
    if (roller) {
      const updRoller = targetDb.prepare(`
        UPDATE fleet_rental_rates
           SET equip_type = 'FLEET',
               category_name = 'Vibrating Roller',
               rate_basis = 'HOURLY',
               fuel_cons_basis = 'hr',
               rate_cents = 113000,
               dry_rate_cents = 113000,
               wet_rate_cents = 226000,
               fully_wet_rate_cents = 226000,
               hr_dry_cents = 113000,
               hr_wet_cents = 226000,
               hr_fw_cents = 226000,
               km_dry_cents = NULL,
               km_wet_cents = NULL,
               km_fw_cents = NULL,
               fuel_cons_econ = 1.9,
               fuel_cons_typ = 2.7,
               fuel_cons_heavy = 3.6,
               source_label = 'Vibrating Roller standard rate (reclassified from Double Cab)',
               note = 'Reclassified from Double Cab to Vibrating Roller (L/hr)',
               updated_at = datetime('now')
         WHERE asset_id = ?
           AND (
             COALESCE(category_name, '') != 'Vibrating Roller'
             OR rate_basis != 'HOURLY'
             OR COALESCE(fuel_cons_basis, '') != 'hr'
             OR km_wet_cents IS NOT NULL
             OR COALESCE(dry_rate_cents, 0) != 113000
           )
      `).run(roller.id);
      if (updRoller.changes > 0) misclassifiedFixed += updRoller.changes;
      updateAssetMetadata(targetDb, assetCols, roller.id, { type: 'Vibrating Roller', meter_type: 'HOURS' });
    }

    // 1c. COMPRESHOR AC 01: reclassify from Double Cab (Pickup) to Air Compressor (PORTABLE, DAILY, hr)
    const comp = targetDb.prepare("SELECT id FROM assets WHERE UPPER(TRIM(code)) = 'COMPRESHOR AC 01' LIMIT 1").get();
    if (comp) {
      const updComp = targetDb.prepare(`
        UPDATE fleet_rental_rates
           SET equip_type = 'PORTABLE',
               category_name = 'Air Compressor',
               rate_basis = 'DAILY',
               default_basis = 'DRY',
               fuel_cons_basis = 'hr',
               rate_cents = 450000,
               dry_rate_cents = 450000,
               wet_rate_cents = 650000,
               fully_wet_rate_cents = 650000,
               port_dd_cents = 450000,
               port_dw_cents = 650000,
               hr_dry_cents = NULL,
               hr_wet_cents = NULL,
               hr_fw_cents = NULL,
               km_dry_cents = NULL,
               km_wet_cents = NULL,
               km_fw_cents = NULL,
               source_label = 'Air Compressor standard rate (reclassified from Double Cab)',
               note = 'Reclassified from Double Cab to Air Compressor (Portable Daily)',
               updated_at = datetime('now')
         WHERE asset_id = ?
           AND (
             COALESCE(equip_type, '') != 'PORTABLE'
             OR COALESCE(category_name, '') != 'Air Compressor'
             OR rate_basis != 'DAILY'
             OR km_wet_cents IS NOT NULL
             OR COALESCE(port_dd_cents, 0) != 450000
           )
      `).run(comp.id);
      if (updComp.changes > 0) misclassifiedFixed += updComp.changes;
      updateAssetMetadata(targetDb, assetCols, comp.id, { type: 'Air Compressor', meter_type: 'HOURS' });
    }

    // 2. Sync all genuine FLEET road vehicles with km rates to rate_basis = 'KM' and fuel_cons_basis = 'km'
    // Preserves hourly tariffs in hr_*_cents and preserves 0 Dry on manual tippers with NULL km_dry_cents.
    const kmInfo = targetDb.prepare(`
      UPDATE fleet_rental_rates
         SET hr_dry_cents = COALESCE(hr_dry_cents, CASE WHEN rate_basis = 'HOURLY' THEN dry_rate_cents ELSE NULL END),
             hr_wet_cents = COALESCE(hr_wet_cents, CASE WHEN rate_basis = 'HOURLY' THEN wet_rate_cents ELSE NULL END),
             hr_fw_cents = COALESCE(hr_fw_cents, CASE WHEN rate_basis = 'HOURLY' THEN fully_wet_rate_cents ELSE NULL END),
             rate_basis = 'KM',
             fuel_cons_basis = 'km',
             dry_rate_cents = COALESCE(km_dry_cents, CASE WHEN rate_basis = 'KM' THEN COALESCE(dry_rate_cents, 0) ELSE 0 END),
             wet_rate_cents = COALESCE(km_wet_cents, CASE WHEN rate_basis = 'KM' THEN COALESCE(wet_rate_cents, 0) ELSE 0 END),
             fully_wet_rate_cents = COALESCE(km_fw_cents, CASE WHEN rate_basis = 'KM' THEN COALESCE(fully_wet_rate_cents, 0) ELSE 0 END),
             rate_cents = COALESCE(NULLIF(km_dry_cents, 0), km_wet_cents, NULLIF(dry_rate_cents, 0), wet_rate_cents, 0),
             updated_at = datetime('now')
       WHERE COALESCE(equip_type, 'FLEET') = 'FLEET'
         AND (COALESCE(km_wet_cents, 0) > 0 OR COALESCE(km_dry_cents, 0) > 0 OR rate_basis = 'KM')
         AND (
           rate_basis != 'KM'
           OR COALESCE(fuel_cons_basis, '') != 'km'
           OR COALESCE(dry_rate_cents, -1) != COALESCE(km_dry_cents, CASE WHEN rate_basis = 'KM' THEN COALESCE(dry_rate_cents, 0) ELSE 0 END)
           OR COALESCE(wet_rate_cents, -1) != COALESCE(km_wet_cents, CASE WHEN rate_basis = 'KM' THEN COALESCE(wet_rate_cents, 0) ELSE 0 END)
           OR COALESCE(fully_wet_rate_cents, -1) != COALESCE(km_fw_cents, CASE WHEN rate_basis = 'KM' THEN COALESCE(fully_wet_rate_cents, 0) ELSE 0 END)
         )
    `).run();
    kmSynced = kmInfo.changes || 0;

    if (assetCols.has('meter_type')) {
      targetDb.prepare(`
        UPDATE assets
           SET meter_type = 'KM'
         WHERE meter_type IS NULL
           AND id IN (
             SELECT asset_id FROM fleet_rental_rates
              WHERE asset_id IS NOT NULL
                AND COALESCE(equip_type, 'FLEET') = 'FLEET'
                AND rate_basis = 'KM'
           )
      `).run();
    }

    // 3. Upsert the 3 Single Cabs: DAI-9757 (SC-17, Bolero), DAI-9762, DAI-9770
    if (upsertAssetRate(targetDb, assetCols, 'DAI-9757', { type: 'Single Cab', brand: 'Mahindra', model_no: 'Bolero', meter_type: 'KM' }, SINGLE_CAB_RATE)) {
      singleCabsUpserted++;
    }
    for (const code of ['DAI-9762', 'DAI-9770']) {
      if (upsertAssetRate(targetDb, assetCols, code, { type: 'Single Cab', meter_type: 'KM' }, SINGLE_CAB_RATE)) {
        singleCabsUpserted++;
      }
    }

    // 4. Upsert Welding Generators: WG-08, WG-13 (Welding Plant standard: Dry 6,500 / Wet 9,500 per day)
    for (const code of ['WG-08', 'WG-13']) {
      if (upsertAssetRate(targetDb, assetCols, code, { type: 'Welding Generator', onlyIfEmptyType: true, meter_type: 'HOURS', onlyIfNullMeter: true }, WELDING_PLANT_RATE)) {
        weldingUpserted++;
      }
    }

    // 5. Upsert Generators: GE-11 & GE-69 (20-25 kVA: Dry 6,000 / Wet 12,000), GE-117 (10 kVA: Dry 3,500 / Wet 7,000)
    for (const code of ['GE-11', 'GE-69']) {
      if (upsertAssetRate(targetDb, assetCols, code, { type: 'Generator', onlyIfEmptyType: true, meter_type: 'HOURS', onlyIfNullMeter: true }, GENERATOR_20_25_KVA_RATE)) {
        generatorsUpserted++;
      }
    }
    if (upsertAssetRate(targetDb, assetCols, 'GE-117', { type: 'Generator', onlyIfEmptyType: true, meter_type: 'HOURS', onlyIfNullMeter: true }, GENERATOR_10_KVA_RATE)) {
      generatorsUpserted++;
    }

    // 6. Sync all remaining PORTABLE rows where dry_rate_cents or wet_rate_cents is 0 while port_dd/port_dw is set
    const portInfo = targetDb.prepare(`
      UPDATE fleet_rental_rates
         SET dry_rate_cents = COALESCE(NULLIF(dry_rate_cents, 0), port_dd_cents, 0),
             wet_rate_cents = COALESCE(NULLIF(wet_rate_cents, 0), port_dw_cents, 0),
             fully_wet_rate_cents = COALESCE(NULLIF(fully_wet_rate_cents, 0), port_dw_cents, 0),
             rate_cents = COALESCE(NULLIF(rate_cents, 0), port_dd_cents, dry_rate_cents, 0),
             updated_at = datetime('now')
       WHERE equip_type = 'PORTABLE'
         AND (COALESCE(port_dd_cents, 0) > 0 OR COALESCE(port_dw_cents, 0) > 0)
         AND (
           (COALESCE(port_dd_cents, 0) > 0 AND COALESCE(dry_rate_cents, 0) = 0)
           OR (COALESCE(port_dw_cents, 0) > 0 AND COALESCE(wet_rate_cents, 0) = 0)
           OR (COALESCE(port_dd_cents, 0) > 0 AND COALESCE(rate_cents, 0) = 0)
         )
    `).run();
    portableSynced = portInfo.changes || 0;
  })();

  return {
    kmSynced,
    misclassifiedFixed,
    singleCabsUpserted,
    weldingUpserted,
    generatorsUpserted,
    portableSynced,
  };
}

module.exports = {
  runMigration,
  SINGLE_CAB_RATE,
  WELDING_PLANT_RATE,
  GENERATOR_20_25_KVA_RATE,
  GENERATOR_10_KVA_RATE,
};
