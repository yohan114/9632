'use strict';

/**
 * Shared Dual Vehicle Identifier Formatter (Frontend)
 *
 * Shows BOTH E&C Number (e.g. DT-15, WB-04, SC-14) and Vehicle Registration
 * Number (e.g. LM-5722, LI-3405, DAH-2491) consistently across Fuel & Fleet UI.
 *
 * Exposes on window:
 *   resolveVehicleIdentity(row)
 *   fmtVehicleText(row)
 *   fmtVehicleBadge(row, opts)
 *   vehicleSearchBlob(row)
 */
(function () {
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

  function safeEsc(v) {
    if (typeof window.esc === 'function') return window.esc(v);
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function resolveVehicleIdentity(row) {
    const src = row && typeof row === 'object' ? row : { code: row };
    const rawEc = cleanToken(src.asset_ec_code != null ? src.asset_ec_code : src.ec_code);
    const rawCode = cleanToken(
      src.asset_master_code != null ? src.asset_master_code
        : (src.asset_code != null ? src.asset_code
          : (src.code != null ? src.code : src.vehicle_code))
    );
    let rawReg = cleanToken(
      src.asset_registration != null ? src.asset_registration
        : (src.registration != null ? src.registration
          : (src.asset_reg != null ? src.asset_reg : src.vehicle_ref))
    );
    if (rawReg && isPlaceholderLocationReg(rawReg)) rawReg = '';

    let ecNo = rawEc || '';
    if (!ecNo && rawCode && (!rawReg || squashCode(rawCode) !== squashCode(rawReg))) {
      ecNo = rawCode;
    }

    let regNo = rawReg || '';
    if (ecNo && regNo && squashCode(ecNo) === squashCode(regNo)) {
      if (rawEc) {
        regNo = '';
      } else if (src.registration || src.asset_registration || src.asset_reg) {
        ecNo = '';
      }
    }

    const primary = ecNo || rawCode || regNo || '—';
    let display = cleanToken(src.asset_display) || cleanToken(src.display) || primary;
    if (!src.asset_display && !src.display) {
      if (ecNo && regNo && squashCode(ecNo) !== squashCode(regNo)) {
        display = ecNo + ' (' + regNo + ')';
      } else if (rawCode && regNo && squashCode(rawCode) !== squashCode(regNo)) {
        display = rawCode + ' (' + regNo + ')';
      } else {
        display = primary;
      }
    }

    return {
      ec_code: ecNo || null,
      registration: regNo || null,
      primary: primary === '—' ? (rawCode || regNo || '') : primary,
      display: display || '—',
    };
  }

  function fmtVehicleText(row) {
    if (!row) return '—';
    return resolveVehicleIdentity(row).display || '—';
  }

  function fmtVehicleBadge(row, opts) {
    const options = opts || {};
    const id = resolveVehicleIdentity(row);
    const ec = id.ec_code;
    const reg = id.registration;
    if (ec && reg && squashCode(ec) !== squashCode(reg)) {
      if (options.stacked) {
        return '<div><b>' + safeEsc(ec) + '</b></div>' +
          '<div><span class="badge" style="font-size:10.5px;font-family:monospace;background:rgba(15,23,42,0.08);color:inherit;margin-top:2px">' + safeEsc(reg) + '</span></div>';
      }
      return '<span><b>' + safeEsc(ec) + '</b> <span class="badge" style="font-size:10.5px;font-family:monospace;background:rgba(15,23,42,0.08);color:inherit;margin-left:3px">' + safeEsc(reg) + '</span></span>';
    }
    return '<b>' + safeEsc(id.display || '—') + '</b>';
  }

  function vehicleSearchBlob(row) {
    const src = row && typeof row === 'object' ? row : {};
    const parts = [
      src.asset_ec_code, src.ec_code,
      src.asset_master_code, src.asset_code, src.code, src.vehicle_code,
      src.asset_registration, src.registration, src.asset_reg, src.vehicle_ref,
      src.asset_display, src.display, src.category,
    ].filter(Boolean);
    return (parts.join(' ') + ' ' + parts.map(squashCode).join(' ')).toUpperCase();
  }

  if (typeof window !== 'undefined') {
    window.resolveVehicleIdentity = resolveVehicleIdentity;
    window.fmtVehicleText = fmtVehicleText;
    window.fmtVehicleBadge = fmtVehicleBadge;
    window.vehicleSearchBlob = vehicleSearchBlob;
  }
})();
