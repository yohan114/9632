'use strict';

/**
 * Dual Vehicle Identifier Helper (E&C Code + Vehicle Registration Number)
 *
 * Ensures WorkshopOne consistently displays both the internal E&C plant/vehicle
 * number (e.g. `DT-15`, `WB-04`, `SC-14`) AND the registration plate number
 * (e.g. `LM-5722`, `LI-3405`, `DAH-2491`) without duplicating identical values.
 */

function squashCode(s) {
  return String(s || '').trim().toUpperCase().replace(/[-\s/().]/g, '');
}

function cleanToken(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^[-—]+$/.test(s)) return '';
  if (/^(NO\s*REG|NO\s*PLATE|N\/A|NONE|NULL|UNKNOWN)$/i.test(s)) return '';
  return s;
}

function isPlaceholderLocationReg(s) {
  return /\b(PLANT|WORKSHOP|HEAD\s*OFFICE|WAREHOUSE)\b/i.test(s);
}

/**
 * Resolve canonical `{ ec_code, registration, primary, display }` from any
 * asset / fuel_request / fuel_issue / join row.
 */
function resolveVehicleIdentity(row = {}) {
  const src = row || {};
  const rawEc = cleanToken(src.asset_ec_code ?? src.ec_code);
  const rawCode = cleanToken(src.asset_master_code ?? src.asset_code ?? src.code ?? src.vehicle_code);
  let rawReg = cleanToken(src.asset_registration ?? src.registration ?? src.asset_reg ?? src.vehicle_ref);
  if (rawReg && isPlaceholderLocationReg(rawReg)) rawReg = '';

  let ecNo = rawEc || '';
  if (!ecNo && rawCode && (!rawReg || squashCode(rawCode) !== squashCode(rawReg))) {
    ecNo = rawCode;
  }

  let regNo = rawReg || '';
  if (ecNo && regNo && squashCode(ecNo) === squashCode(regNo)) {
    // Only treat as pure E&C or pure Reg: keep regNo null if they are identical
    if (rawEc) {
      regNo = '';
    } else if (src.registration || src.asset_registration || src.asset_reg) {
      // Master code matched registration directly (e.g. code='57-3062', ec_code=null, reg='57-3062')
      ecNo = '';
    }
  }

  const primary = ecNo || rawCode || regNo || '';
  let display = primary;
  if (ecNo && regNo && squashCode(ecNo) !== squashCode(regNo)) {
    display = `${ecNo} (${regNo})`;
  } else if (rawCode && regNo && squashCode(rawCode) !== squashCode(regNo)) {
    display = `${rawCode} (${regNo})`;
  }

  return {
    ec_code: ecNo || null,
    registration: regNo || null,
    primary,
    display,
  };
}

/**
 * Attach standardized `asset_ec_code`, `asset_registration`, and `asset_display`
 * properties to a row object without losing its existing fields.
 */
function attachVehicleLabels(row) {
  if (!row || typeof row !== 'object') return row;
  const id = resolveVehicleIdentity(row);
  return {
    ...row,
    asset_ec_code: id.ec_code,
    asset_registration: id.registration,
    asset_display: id.display,
  };
}

module.exports = {
  squashCode,
  resolveVehicleIdentity,
  attachVehicleLabels,
};
