'use strict';

/**
 * Migration 061: Separate Rate Cards & Consumption Bands into L/hr (Hourly Rate) vs km/L (Per-KM Rate)
 *
 * Ensures:
 *   - Road vehicles (km/L band) store Per-KM rates (rate_basis = 'KM', fuel_cons_basis = 'km')
 *     while retaining Hourly (hr_*_cents) & Daily (dy_*_cents) reference tiers.
 *   - Machinery & heavy plant (L/hr band) store Hourly rates (rate_basis = 'HOURLY', fuel_cons_basis = 'hr').
 *   - Idempotent across live and fresh test databases; respects existing manual audit edits.
 */

const fs = require('fs');
const path = require('path');

const CATEGORY_KM_RATES_CENTS = {
  'Prime Mover / Bed': { d: 11500, w: 13500, fw: 28500 },
  'Double Cab (Pickup)': { d: 4500, w: 7000, fw: 11000 },
  'Single Cab': { d: 4500, w: 7000, fw: 11000 },
  'Crew Cab': { d: 4500, w: 7000, fw: 11500 },
  Van: { d: 4500, w: 7000, fw: 11000 },
  'Dump Truck (Tipper)': { d: 9500, w: 12000, fw: 23000 },
  Trailer: { d: 12500, w: 13000, fw: 14500 },
  'Lorry Trailer': { d: 21500, w: 22500, fw: 25500 },
  'Motor Bicycle': { d: 2500, w: 2500, fw: 4500 },
};

function ensureCol(targetDb, tableName, colName, colType) {
  const exists = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!exists) return;
  const cols = targetDb.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
  if (!cols.includes(colName)) {
    targetDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`);
  }
}

const alnum = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

function kmCategoryForRow(row) {
  const cat = String(row.category_name || '').toLowerCase();
  const typ = String(row.asset_type || '').toLowerCase();
  const combined = `${cat} ${typ}`;

  // Stationary / PTO / heavy machinery with L/hr meters MUST stay on HOURLY + L/hr
  if (
    !/lorry.*trailer/.test(combined) &&
    /(boom|pump|mixer|bowser|excavator|backhoe|loader|grader|roller|crane|skid|paver|forklift|generator|compressor|tractor)/.test(combined)
  ) {
    return null;
  }

  if (/prime\s*mover|\bbed\b/.test(combined)) return 'Prime Mover / Bed';
  if (/lorry.*trailer/.test(combined)) return 'Lorry Trailer';
  if (/\btrailer\b/.test(combined)) return 'Trailer';
  if (/double\s*cab|d\/cab|pickup|two\s*cab/.test(combined)) return 'Double Cab (Pickup)';
  if (/crew\s*cab|c\/cab/.test(combined)) return 'Crew Cab';
  if (/single\s*cab|s\/cab|bolero/.test(combined)) return 'Single Cab';
  if (/\bvan\b/.test(combined)) return 'Van';
  if (/dump\s*truck|tipper/.test(combined)) return 'Dump Truck (Tipper)';
  if (/motor\s*bicycle|bicycle|\bbike\b/.test(combined)) return 'Motor Bicycle';

  if (row.fuel_cons_basis === 'km' || row.rate_basis === 'KM') {
    const code = String(row.asset_code || '').toUpperCase();
    if (/^(DT|L[EOP])/.test(code)) return 'Dump Truck (Tipper)';
    if (/^DC/.test(code)) return 'Double Cab (Pickup)';
    if (/^SC/.test(code)) return 'Single Cab';
    if (/^(HCC|CC)/.test(code)) return 'Crew Cab';
    if (/^(MB|BFR)/.test(code)) return 'Motor Bicycle';
    if (/^(BD|BM|PM)/.test(code)) return 'Prime Mover / Bed';
    if (/^VN/.test(code)) return 'Van';
    if (/^LT/.test(code)) return 'Lorry Trailer';
    if (/^TR/.test(code)) return 'Trailer';
    return 'Single Cab';
  }

  return null;
}

function loadRateCardsJson() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'Fuel-System-V2-Ref', 'scripts', 'data', 'rate_cards.json'),
    path.join(__dirname, '..', '..', 'data', 'rate_cards.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function runMigration(targetDb) {
  if (!targetDb) return { updatedKm: 0, updatedHr: 0 };

  const hasRates = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fleet_rental_rates'").get();
  if (!hasRates) return { updatedKm: 0, updatedHr: 0 };

  for (const col of [
    'hr_dry_cents', 'hr_wet_cents', 'hr_fw_cents',
    'dy_dry_cents', 'dy_wet_cents', 'dy_fw_cents',
    'km_dry_cents', 'km_wet_cents', 'km_fw_cents',
  ]) {
    ensureCol(targetDb, 'fleet_rental_rates', col, 'INTEGER');
  }

  const rc = loadRateCardsJson();
  const byCode = new Map();
  const byReg = new Map();
  const byMid = new Map();
  if (rc && Array.isArray(rc.fleet)) {
    for (const c of rc.fleet) {
      if (c.ec) byCode.set(alnum(c.ec), c);
      if (c.reg) byReg.set(alnum(c.reg), c);
      if (c.id != null) byMid.set(`M${c.id}`, c);
    }
  }

  const hasAudit = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
  const manuallyAuditedAssets = new Set();
  if (hasAudit) {
    for (const r of targetDb.prepare("SELECT DISTINCT entity_id FROM audit_log WHERE entity = 'fleet_rental_rate' AND entity_id IS NOT NULL").all()) {
      manuallyAuditedAssets.add(Number(r.entity_id));
    }
  }

  const hasAssetMeterCol = targetDb.prepare('PRAGMA table_info(assets)').all().some((c) => c.name === 'meter_type');

  const rows = targetDb.prepare(`
    SELECT r.*,
           a.code AS asset_code, a.ec_code AS asset_ec, a.registration AS asset_reg, a.type AS asset_type
      FROM fleet_rental_rates r
      LEFT JOIN assets a ON a.id = r.asset_id
     WHERE COALESCE(r.equip_type, 'FLEET') = 'FLEET'
  `).all();

  const updRateStmt = targetDb.prepare(`
    UPDATE fleet_rental_rates
       SET rate_basis = ?,
           rate_cents = ?,
           dry_rate_cents = ?,
           wet_rate_cents = ?,
           fully_wet_rate_cents = ?,
           fuel_cons_basis = ?,
           category_name = COALESCE(?, category_name),
           source_label = COALESCE(source_label, ?),
           hr_dry_cents = COALESCE(hr_dry_cents, ?),
           hr_wet_cents = COALESCE(hr_wet_cents, ?),
           hr_fw_cents = COALESCE(hr_fw_cents, ?),
           dy_dry_cents = COALESCE(dy_dry_cents, ?),
           dy_wet_cents = COALESCE(dy_wet_cents, ?),
           dy_fw_cents = COALESCE(dy_fw_cents, ?),
           km_dry_cents = COALESCE(km_dry_cents, ?),
           km_wet_cents = COALESCE(km_wet_cents, ?),
           km_fw_cents = COALESCE(km_fw_cents, ?),
           updated_at = datetime('now')
     WHERE id = ?
  `);

  const updMeterStmt = hasAssetMeterCol
    ? targetDb.prepare("UPDATE assets SET meter_type = COALESCE(meter_type, ?) WHERE id = ?")
    : null;

  let updatedKm = 0;
  let updatedHr = 0;

  targetDb.transaction(() => {
    for (const r of rows) {
      const jsonMatch =
        byCode.get(alnum(r.asset_code)) ||
        byCode.get(alnum(r.asset_ec)) ||
        byReg.get(alnum(r.asset_reg)) ||
        byMid.get(alnum(r.asset_code)) ||
        null;

      const toCents = (v) => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : null);

      const jsonHr = jsonMatch && jsonMatch.r && jsonMatch.r.h
        ? { d: toCents(jsonMatch.r.h.d), w: toCents(jsonMatch.r.h.w), fw: toCents(jsonMatch.r.h.fw) }
        : { d: null, w: null, fw: null };
      const jsonDy = jsonMatch && jsonMatch.r && jsonMatch.r.dy
        ? { d: toCents(jsonMatch.r.dy.d), w: toCents(jsonMatch.r.dy.w), fw: toCents(jsonMatch.r.dy.fw) }
        : { d: null, w: null, fw: null };
      const jsonKm = jsonMatch && jsonMatch.r && jsonMatch.r.km
        ? { d: toCents(jsonMatch.r.km.d), w: toCents(jsonMatch.r.km.w), fw: toCents(jsonMatch.r.km.fw) }
        : { d: null, w: null, fw: null };

      // Preserve existing hourly rates on hr_* columns when currently HOURLY
      const prevHrD = r.rate_basis === 'HOURLY' ? (r.dry_rate_cents ?? r.rate_cents ?? null) : null;
      const prevHrW = r.rate_basis === 'HOURLY' ? (r.wet_rate_cents ?? null) : null;
      const prevHrFw = r.rate_basis === 'HOURLY' ? (r.fully_wet_rate_cents ?? null) : null;

      const hrD = jsonHr.d ?? r.hr_dry_cents ?? prevHrD;
      const hrW = jsonHr.w ?? r.hr_wet_cents ?? prevHrW;
      const hrFw = jsonHr.fw ?? r.hr_fw_cents ?? prevHrFw;

      const kmCat = kmCategoryForRow(r);
      const isKm = jsonMatch ? !!(jsonMatch.km && jsonMatch.r && jsonMatch.r.km) : (kmCat !== null);

      if (r.asset_id && manuallyAuditedAssets.has(Number(r.asset_id))) {
        // Still store tier snapshots if missing, without altering audited rate_basis or active dry/wet/fw
        updRateStmt.run(
          r.rate_basis, r.rate_cents, r.dry_rate_cents, r.wet_rate_cents, r.fully_wet_rate_cents,
          r.fuel_cons_basis, null, jsonMatch ? jsonMatch.label : null,
          hrD, hrW, hrFw, jsonDy.d, jsonDy.w, jsonDy.fw, jsonKm.d, jsonKm.w, jsonKm.fw, r.id
        );
        continue;
      }

      if (isKm) {
        const fallbackKm = (kmCat && CATEGORY_KM_RATES_CENTS[kmCat]) || CATEGORY_KM_RATES_CENTS['Single Cab'];
        const useKmD = jsonKm.d ?? r.km_dry_cents ?? (r.rate_basis === 'KM' ? r.dry_rate_cents : null) ?? fallbackKm.d;
        const useKmW = jsonKm.w ?? r.km_wet_cents ?? (r.rate_basis === 'KM' ? r.wet_rate_cents : null) ?? fallbackKm.w;
        const useKmFw = jsonKm.fw ?? r.km_fw_cents ?? (r.rate_basis === 'KM' ? r.fully_wet_rate_cents : null) ?? fallbackKm.fw;

        const cleanCat = kmCat || (jsonMatch && jsonMatch.cat) || null;
        updRateStmt.run(
          'KM', useKmD || r.rate_cents || 0, useKmD, useKmW, useKmFw,
          'km', cleanCat, jsonMatch ? jsonMatch.label : null,
          hrD, hrW, hrFw, jsonDy.d, jsonDy.w, jsonDy.fw, useKmD, useKmW, useKmFw, r.id
        );
        if (updMeterStmt && r.asset_id) updMeterStmt.run('KM', r.asset_id);
        updatedKm++;
      } else {
        const useHrD = r.dry_rate_cents ?? jsonHr.d;
        const useHrW = r.wet_rate_cents ?? jsonHr.w;
        const useHrFw = r.fully_wet_rate_cents ?? jsonHr.fw;
        const basis = r.rate_basis === 'DAILY' || r.rate_basis === 'MONTHLY' || r.rate_basis === 'FLAT'
          ? r.rate_basis
          : 'HOURLY';

        updRateStmt.run(
          basis,
          r.rate_cents || useHrD || 0,
          useHrD,
          useHrW,
          useHrFw,
          r.fuel_cons_basis || 'hr',
          (jsonMatch && jsonMatch.cat) || null,
          jsonMatch ? jsonMatch.label : null,
          useHrD, useHrW, useHrFw, jsonDy.d, jsonDy.w, jsonDy.fw, jsonKm.d, jsonKm.w, jsonKm.fw,
          r.id
        );
        if (updMeterStmt && r.asset_id) updMeterStmt.run('HOURS', r.asset_id);
        updatedHr++;
      }
    }
  })();

  return { updatedKm, updatedHr };
}

module.exports = {
  runMigration,
  kmCategoryForRow,
  CATEGORY_KM_RATES_CENTS,
};
