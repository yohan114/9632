'use strict';

/**
 * Advanced Service & Filter Plan Engine (4-Stage Pipeline)
 *
 * Strictly READ-ONLY. Computes per-vehicle and fleet-wide monthly service plans by:
 *   1. Resolving one canonical vehicle and aggregating ALL non-voided fuel issues across
 *      every site, tank, bowser, and external station (in Asia/Colombo +05:30 dates).
 *   2. Pulling the vehicle's unified breakdown history for the target month (YYYY-MM)
 *      across all sites/sources (job cards, job requests, daily conditions, manual overrides).
 *   3. Calculating the service status, active working-day run rate (net of breakdowns),
 *      and projected service date — plus flagging "Service on Breakdown" opportunities.
 *   4. Evaluating each filter in the vehicle's kit independently (CHANGE 'X', CLEAN 'E',
 *      or SKIP 'OK') so only the filters actually due at this service milestone are
 *      requested and netted against stock/equivalents.
 */

const { all, get } = require('../db');
const { normF } = require('./filter_no');
const stock = require('./stock');
const breakdownsLib = require('./billing/breakdowns');
const {
  DEFAULT_CATEGORY_RULES,
  defaultRuleFor,
  splitTopLevelParts,
  isUsablePartToken,
  parseNumericMeter,
} = require('../migrate/060_service_filter_plan');

const RULE_VERSION = '2026-11-16.advanced';
const ACTIVE_DAYS = 180;
const COLOMBO_OFFSET_MS = 5.5 * 3600 * 1000;
const ABSOLUTE_MAX = { HOURS: 100000, KM: 2000000 };
const MAX_DAILY_DELTA = { HOURS: 24, KM: 1500 };

const PREFIX_CATEGORY_MAP = {
  AP: 'Asphalt Paver',
  BB: 'Bitumen Bowser',
  BL: 'Backhoe Loader',
  BM: 'Boom Truck',
  BS: 'Bitumen Sprayer',
  CR: 'Mobile Crane',
  DB: 'Diesel Bowser',
  DC: 'Double Cab',
  DT: 'Dump Truck',
  FL: 'Fork Lift',
  FT: 'Farm Tractor',
  GEN: 'Generator',
  HCC: 'Crew Cab',
  HEX: 'Excavator',
  LB: 'Backhoe Loader',
  LD: 'Wheel Loader',
  LT: 'Lorry Trailer',
  MB: 'Motor Bicycle',
  MG: 'Motor Grader',
  PM: 'Prime Mover - Bed',
  PR: 'Pneumatic Roller',
  PT: 'Pump Truck',
  SC: 'Single Cab',
  SL: 'Self Loader Mixer',
  SR: 'Static Roller',
  SS: 'Skid Steer',
  TB: 'Tractor Bowser',
  TM: 'Truck Mixer',
  TR: 'Trailer',
  VN: 'Van',
  VR: 'Vibrating Roller',
  WB: 'Water Bowser',
  WL: 'Wheel Loader',
};

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const codeKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const tableExists = (name) => !!get("SELECT 1 v FROM sqlite_master WHERE type = 'table' AND name = ?", name);
const tableCols = (name) => new Set(tableExists(name) ? all(`PRAGMA table_info(${name})`).map((c) => c.name) : []);

function colomboToday() {
  return new Date(Date.now() + COLOMBO_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Convert a stored date or UTC timestamp into an Asia/Colombo YYYY-MM-DD calendar key.
 * Bare YYYY-MM-DD strings represent local dates and are preserved directly.
 */
function toColomboDay(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const isoLike = s.includes('T') ? s : s.replace(' ', 'T');
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(isoLike) ? isoLike : `${isoLike}Z`;
  const ms = Date.parse(withZone);
  if (!Number.isFinite(ms)) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  return new Date(ms + COLOMBO_OFFSET_MS).toISOString().slice(0, 10);
}

function daysBetween(laterIso, earlierIso) {
  if (!laterIso || !earlierIso) return 0;
  return Math.round((Date.parse(`${laterIso}T00:00:00Z`) - Date.parse(`${earlierIso}T00:00:00Z`)) / 86400000);
}

function daysInclusive(startIso, endIso) {
  if (!startIso || !endIso || endIso < startIso) return 0;
  return daysBetween(endIso, startIso) + 1;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthWindow(month) {
  const today = colomboToday();
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) : today.slice(0, 7);
  const year = Number(m.slice(0, 4));
  const mon = Number(m.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
  const monthStart = `${m}-01`;
  const asOf = today < monthStart ? monthStart : (today <= lastDay ? today : lastDay);
  return { month: m, monthStart, monthEnd: lastDay, asOf, today };
}

function inferCategoryName(asset, rateCard) {
  if (asset.type && String(asset.type).trim()) return String(asset.type).trim();
  if (rateCard && rateCard.category_name && String(rateCard.category_name).trim()) return String(rateCard.category_name).trim();
  const code = String(asset.ec_code || asset.code || '').toUpperCase();
  const prefix = code.split(/[-\s]/)[0];
  if (prefix && PREFIX_CATEGORY_MAP[prefix]) return PREFIX_CATEGORY_MAP[prefix];
  return asset.asset_class ? String(asset.asset_class) : 'General Fleet';
}

function inferMeterType(asset, rateCard, overrideRow) {
  if (overrideRow && overrideRow.basis) return overrideRow.basis;
  const cat = String(asset.type || (rateCard && rateCard.category_name) || '').toUpperCase();
  const code = String(asset.ec_code || asset.code || '').toUpperCase();
  if (
    /DUMP|TRUCK|CAB|BUS|BOWSER|LORRY|VAN|CAR|BIKE|MIXER|MOVER|BOOM/.test(cat) ||
    /^(DT|DC|SC|HCC|TM|BD|DB|WB|BS|PV|BM|MB|VN|LT|PM)-/.test(code) ||
    /^\d{2,3}-\d{4}$/.test(code)
  ) {
    return 'KM';
  }
  if (
    /EXCAVATOR|LOADER|BACKHOE|GRADER|ROLLER|CRANE|FORKLIFT|GENERATOR|TRACTOR|DOZER|SKID|PAVER|PUMP/.test(cat) ||
    /^(HEX|LB|LD|MG|VR|SR|PR|BL|FL|GEN|FT|SS|AP|CR|PT|TR|SL)-/.test(code)
  ) {
    return 'HOURS';
  }
  if (rateCard && rateCard.fuel_cons_basis === 'km') return 'KM';
  if (rateCard && rateCard.fuel_cons_basis === 'hr') return 'HOURS';
  return 'HOURS';
}

/**
 * Validate a textual service meter reading against the asset's expected basis.
 */
function parseServiceMeter(raw, expectedBasis) {
  const s = String(raw || '').trim();
  if (!s) return { value: null, usable: false, reason: 'missing' };
  if (/^(mnw|m\.?n\.?r|nw|not\s*word|n|m\s*req|-)$/i.test(s)) {
    return { value: null, usable: false, reason: 'meter_not_working' };
  }
  const saysKm = /\bkm\b/i.test(s) || /\d\s*km$/i.test(s);
  const saysHr = /\bh(?:r|rs|our|ours)?\b/i.test(s);
  if (expectedBasis === 'HOURS' && saysKm) {
    return { value: null, usable: false, reason: 'unit_mismatch_km_on_hours' };
  }
  if (expectedBasis === 'KM' && saysHr) {
    return { value: null, usable: false, reason: 'unit_mismatch_hr_on_km' };
  }
  const v = parseNumericMeter(s);
  if (v == null) return { value: null, usable: false, reason: 'non_numeric' };
  const max = ABSOLUTE_MAX[expectedBasis] || ABSOLUTE_MAX.KM;
  if (v > max) return { value: null, usable: false, reason: 'absurd_value' };
  return { value: v, usable: true, reason: 'ok' };
}

function withinReference(value, refMin, refMax) {
  const lo = Math.min(refMin, refMax) * 0.5;
  const hi = Math.max(refMin, refMax) * 2 + 1000;
  return value >= lo && value <= hi;
}

/**
 * Compute trusted meter growth between an anchor date/reading and latest readings.
 * Rejects backward steps, unit mismatches, dual-meter scale conflicts, and impossible daily spikes.
 */
function computeTrustedMeterGrowth({ anchorDate, anchorMeter, anchorHadService, meterPoints, basis, asOf }) {
  const warnings = [];
  const maxAllowed = ABSOLUTE_MAX[basis] || ABSOLUTE_MAX.KM;
  const dailyCeiling = MAX_DAILY_DELTA[basis] || MAX_DAILY_DELTA.KM;

  const validPoints = [];
  for (const pt of meterPoints) {
    if (pt.day > asOf) continue;
    if (pt.meterType && pt.meterType !== 'NONE' && pt.meterType !== basis) {
      warnings.push(`Ignored ${pt.day} reading (${pt.value} ${pt.meterType}) — conflicts with ${basis}`);
      continue;
    }
    if (!Number.isFinite(pt.value) || pt.value <= 0 || pt.value > maxAllowed) {
      warnings.push(`Ignored ${pt.day} reading (${pt.value}) — out of physical bounds`);
      continue;
    }
    validPoints.push(pt);
  }

  const refMin = validPoints.length ? Math.min(...validPoints.map((p) => p.value)) : null;
  const refMax = validPoints.length ? Math.max(...validPoints.map((p) => p.value)) : null;

  // Readings strictly after the last service (or >= commissioning anchor)
  const postPoints = validPoints.filter((p) => (anchorHadService ? p.day > anchorDate : p.day >= anchorDate));
  if (!postPoints.length) {
    return {
      recordedSince: null,
      currentMeter: null,
      meterNote: 'No valid fuel/log meter reading recorded since anchor',
      warnings,
    };
  }

  // Filter out anomalous step spikes/drops cleanly using chronological progression
  const cleanPost = [];
  for (const pt of postPoints) {
    if (cleanPost.length === 0) {
      cleanPost.push(pt);
      continue;
    }
    const prev = cleanPost[cleanPost.length - 1];
    const diff = pt.value - prev.value;
    if (diff < 0) {
      warnings.push(`Ignored ${pt.day} rollback reading (${pt.value} < ${prev.value})`);
      continue;
    }
    const spanDays = Math.max(1, daysBetween(pt.day, prev.day));
    if (diff > dailyCeiling * spanDays) {
      warnings.push(`Ignored ${pt.day} jump (${pt.value} vs ${prev.value} over ${spanDays}d)`);
      continue;
    }
    cleanPost.push(pt);
  }

  const latest = cleanPost[cleanPost.length - 1];
  const currentMeter = latest ? latest.value : null;

  if (anchorMeter != null && currentMeter != null) {
    if (refMin != null && !withinReference(anchorMeter, refMin, refMax)) {
      warnings.push(`Service meter (${anchorMeter}) and fuel meter (${currentMeter}) appear to track different instruments`);
      // Measure window across fuel readings alone when service meter is on a different scale
      if (cleanPost.length >= 2) {
        return {
          recordedSince: r1(currentMeter - cleanPost[0].value),
          currentMeter,
          meterNote: `Dual-meter scale mismatch vs service (${anchorMeter}); measured across fuel-issue readings instead`,
          warnings,
        };
      }
      return {
        recordedSince: null,
        currentMeter,
        meterNote: `Service meter (${anchorMeter}) and fuel meter (${currentMeter}) are on different scales`,
        warnings,
      };
    }
    if (currentMeter < anchorMeter) {
      warnings.push(`Current meter (${currentMeter}) is below service meter (${anchorMeter}) — possible reset`);
      return { recordedSince: null, currentMeter, meterNote: 'Meter went backwards since service', warnings };
    }
    const elapsedDays = Math.max(1, daysBetween(latest.day, anchorDate));
    const delta = currentMeter - anchorMeter;
    if (delta > dailyCeiling * elapsedDays) {
      warnings.push(`Delta ${delta} over ${elapsedDays}d exceeds physical max`);
      return { recordedSince: null, currentMeter, meterNote: 'Meter jump exceeded physical daily ceiling', warnings };
    }
    return {
      recordedSince: r1(delta),
      currentMeter,
      meterNote: `Meter ${anchorMeter.toLocaleString()} -> ${currentMeter.toLocaleString()}`,
      warnings,
    };
  }

  // No service meter recorded: measure growth across fuel/log readings since anchor
  if (cleanPost.length >= 2) {
    const delta = cleanPost[cleanPost.length - 1].value - cleanPost[0].value;
    return {
      recordedSince: r1(delta),
      currentMeter,
      meterNote: `No service meter recorded; measured ${cleanPost[0].value.toLocaleString()} -> ${currentMeter.toLocaleString()}`,
      warnings,
    };
  }

  return {
    recordedSince: null,
    currentMeter,
    meterNote: 'Single reading only; fuel-derived running used if rate band exists',
    warnings,
  };
}

/**
 * Evaluate consumption rate comparability (mirrors Fuel-System-V2/src/lib/consumption/band.ts).
 */
function resolveConsumptionRate(rateCard, meterType) {
  if (!rateCard || !rateCard.fuel_cons_typ || Number(rateCard.fuel_cons_typ) <= 0) {
    return { comparable: false, typ: null, basis: null, reason: 'no_rate_band' };
  }
  const typ = Number(rateCard.fuel_cons_typ);
  const meterBasis = meterType === 'KM' ? 'km' : 'hr';
  const storedBasis = rateCard.fuel_cons_basis === 'km' || rateCard.fuel_cons_basis === 'hr'
    ? rateCard.fuel_cons_basis
    : (typ < 1 ? 'km' : 'hr');
  if (storedBasis !== meterBasis) {
    return { comparable: false, typ: null, basis: storedBasis, reason: 'basis_conflict' };
  }
  return { comparable: true, typ, basis: storedBasis, reason: 'ok' };
}

function breakdownRiskCategories(episodes) {
  const risks = new Map(); // category -> Set<reason>
  const add = (cats, reason) => {
    for (const c of cats) {
      if (!risks.has(c)) risks.set(c, new Set());
      risks.get(c).add(reason);
    }
  };
  for (const ep of episodes) {
    const txt = String(ep.reason || '').toLowerCase();
    if (!txt) continue;
    if (/fuel|diesel|injector|water\s*sep|sediment|fuel\s*pump|contamination/.test(txt)) {
      add(['Primary Fuel Filter', 'Water Separator', 'Fuel Sedimentary', 'Fuel Tank Filter', 'Engine fuel Filter - S'], ep.reason);
    }
    if (/engine\s*oil|oil\s*pressure|overheat|radiator|coolant|seiz|knock|smoke/.test(txt)) {
      add(['Engine Oil Filter', 'Engine Oil Filter - S', 'Coolant Filter'], ep.reason);
    }
    if (/hydraul|cylinder|boom|bucket|hose|swing/.test(txt)) {
      add(['Hydraulic Filter - S', 'Line Filter'], ep.reason);
    }
    if (/trans|gearbox|clutch|converter/.test(txt)) {
      add(['Trans: Filter'], ep.reason);
    }
    if (/air\s*filter|turbo|dust|breather|intake|compressor|air\s*dryer/.test(txt)) {
      add(['Air Filter', 'Air Filter Outer', 'Air Filter Inner', 'Engine Air Filter - S', 'Air Breather Filter', 'Air Dryer Filter'], ep.reason);
    }
  }
  return risks;
}

function stockAndPriceContext() {
  const prices = new Map();
  if (tableExists('filter_prices')) {
    for (const p of all('SELECT filter_no_norm, unit_price FROM filter_prices WHERE unit_price > 0')) {
      if (p.filter_no_norm) prices.set(p.filter_no_norm, p.unit_price);
    }
  }

  const stockMap = new Map();
  if (tableExists('filter_stock')) {
    for (const f of all('SELECT part_no, qty_in_stock FROM filter_stock WHERE part_no IS NOT NULL')) {
      const k = normF(f.part_no);
      if (!k) continue;
      const cur = stockMap.get(k) || { qty: 0, rows: 0 };
      cur.qty += Number(f.qty_in_stock) || 0;
      cur.rows += 1;
      stockMap.set(k, cur);
    }
  }

  // Build equivalent lookup from filter_catalogue + filter_xrefs
  const xrefsByNorm = new Map();
  if (tableExists('filter_catalogue') && tableExists('filter_xrefs')) {
    const byCat = new Map();
    for (const c of all('SELECT id, oem_pn, hifi_pn FROM filter_catalogue')) {
      const set = [];
      if (c.oem_pn) set.push({ part_number: c.oem_pn, norm: normF(c.oem_pn), brand: 'OEM' });
      if (c.hifi_pn) set.push({ part_number: c.hifi_pn, norm: normF(c.hifi_pn), brand: 'HIFI' });
      byCat.set(c.id, set);
    }
    for (const x of all('SELECT catalogue_id, brand, part_number, part_number_norm FROM filter_xrefs')) {
      if (!byCat.has(x.catalogue_id)) byCat.set(x.catalogue_id, []);
      byCat.get(x.catalogue_id).push({ part_number: x.part_number, norm: x.part_number_norm || normF(x.part_number), brand: x.brand || 'XREF' });
    }
    for (const list of byCat.values()) {
      for (const item of list) {
        if (!item.norm) continue;
        if (!xrefsByNorm.has(item.norm)) {
          xrefsByNorm.set(item.norm, list.filter((o) => o.norm && o.norm !== item.norm));
        }
      }
    }
  }

  return { prices, stockMap, xrefsByNorm };
}

function equivalentsInStock(partNorm, ctx) {
  if (!partNorm) return [];
  const candidates = ctx.xrefsByNorm.get(partNorm) || [];
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c.norm || seen.has(c.norm)) continue;
    seen.add(c.norm);
    const st = ctx.stockMap.get(c.norm);
    if (st && st.qty > 0) {
      out.push({
        part_no: c.part_number,
        brand: c.brand,
        in_stock: st.qty,
        unit_price: ctx.prices.get(c.norm) || null,
      });
    }
  }
  return out.sort((a, b) => b.in_stock - a.in_stock);
}

function splitFilterTokens(partNo) {
  if (!partNo) return [];
  const split = splitTopLevelParts(partNo).filter(isUsablePartToken);
  if (split.length) {
    const out = [];
    for (const seg of split) {
      const fromStock = stock.filterParts(seg);
      if (fromStock.length) {
        for (const p of fromStock) out.push({ part: p.text, norm: p.key });
      } else {
        const n = normF(seg);
        if (n) out.push({ part: seg, norm: n });
      }
    }
    if (out.length) return out;
  }
  const fromStock = stock.filterParts(partNo);
  if (fromStock.length) {
    return fromStock.map((p) => ({ part: p.text, norm: p.key }));
  }
  const single = normF(partNo);
  return single && isUsablePartToken(partNo) ? [{ part: String(partNo).trim(), norm: single }] : [];
}

/**
 * Load all fleet data once and compute the full 4-stage plan for month YYYY-MM.
 */
function buildAdvancedServicePlan({
  month,
  includeLongOverdue = false,
  includeOk = false,
  site = '',
  search = '',
  assetId = null,
} = {}) {
  const win = monthWindow(month);
  const { monthStart, monthEnd, asOf } = win;

  // 1. Canonical assets & lookup maps
  const aCols = tableCols('assets');
  const assets = all(`
    SELECT a.id, a.code, a.code_norm, a.registration, a.ec_code, a.type, a.model_no,
           a.asset_class, a.status, a.in_register, a.current_project_id, a.home_project_id,
           a.running_hours,
           ${aCols.has('category') ? 'a.category' : 'NULL'} AS category,
           ${aCols.has('meter_type') ? 'a.meter_type' : 'NULL'} AS meter_type,
           ${aCols.has('current_hours') ? 'a.current_hours' : 'NULL'} AS current_hours,
           p.name AS current_project_name, p.code AS current_project_code
      FROM assets a
      LEFT JOIN projects p ON p.id = COALESCE(a.current_project_id, a.home_project_id)
     WHERE LOWER(COALESCE(a.status, 'active')) NOT IN ('decommissioned', 'disposed', 'retired')
       ${assetId ? 'AND a.id = ?' : ''}
     ORDER BY a.code
  `, ...(assetId ? [Number(assetId)] : []));

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const byKey = new Map();
  const regKey = (k, id) => { if (k && !byKey.has(k)) byKey.set(k, id); };
  for (const a of assets) {
    regKey(codeKey(a.ec_code), a.id);
    regKey(a.code_norm || codeKey(a.code), a.id);
    regKey(codeKey(a.registration), a.id);
  }
  if (tableExists('asset_aliases')) {
    for (const al of all('SELECT raw_norm, asset_id FROM asset_aliases WHERE resolved = 1 AND asset_id IS NOT NULL')) {
      if (assetById.has(al.asset_id)) regKey(al.raw_norm, al.asset_id);
    }
  }
  if (tableExists('fleet_identity_mappings')) {
    for (const fm of all("SELECT source_id, source_code, target_id FROM fleet_identity_mappings WHERE entity_type = 'ASSET'")) {
      const aid = Number(fm.target_id);
      if (assetById.has(aid)) {
        regKey(codeKey(fm.source_code), aid);
        regKey(String(fm.source_id || ''), aid);
      }
    }
  }
  const resolveAssetId = (aid, rawCode, rawReg) => {
    if (aid && assetById.has(Number(aid))) return Number(aid);
    for (const cand of [rawCode, rawReg]) {
      const k = codeKey(cand);
      if (k && byKey.has(k)) return byKey.get(k);
    }
    return null;
  };

  // Rate cards, intervals, overrides, current assignments
  const rateCards = new Map();
  if (tableExists('fleet_rental_rates')) {
    for (const r of all('SELECT * FROM fleet_rental_rates WHERE asset_id IS NOT NULL')) {
      if (!rateCards.has(r.asset_id)) rateCards.set(r.asset_id, r);
    }
  }
  const intervalsByCat = new Map();
  if (tableExists('service_intervals')) {
    for (const inv of all('SELECT * FROM service_intervals')) {
      intervalsByCat.set(String(inv.category || '').toUpperCase(), inv);
    }
  }
  const overridesByAsset = new Map();
  if (tableExists('service_interval_overrides')) {
    for (const ov of all('SELECT * FROM service_interval_overrides')) {
      overridesByAsset.set(ov.asset_id, ov);
    }
  }
  const specsByAsset = new Map();
  if (tableExists('service_specs')) {
    for (const sp of all('SELECT * FROM service_specs WHERE asset_id IS NOT NULL')) {
      if (!specsByAsset.has(sp.asset_id)) specsByAsset.set(sp.asset_id, sp);
    }
  }
  const assignmentsByAsset = new Map();
  if (tableExists('fleet_asset_assignments')) {
    for (const fa of all(`
      SELECT fa.asset_id, fa.project_id, p.name AS project_name, p.code AS project_code, fa.start_date, fa.end_date
        FROM fleet_asset_assignments fa
        LEFT JOIN projects p ON p.id = fa.project_id
       ORDER BY CASE WHEN fa.end_date IS NULL THEN 0 ELSE 1 END, fa.start_date DESC
    `)) {
      if (!assignmentsByAsset.has(fa.asset_id)) assignmentsByAsset.set(fa.asset_id, fa);
    }
  }

  // 2. Stage 1 data: ALL-SITE fuel issues + meter logs
  const fuelByAsset = new Map();
  const meterByAsset = new Map();
  const pushFuel = (aid, row) => {
    if (!fuelByAsset.has(aid)) fuelByAsset.set(aid, []);
    fuelByAsset.get(aid).push(row);
  };
  const pushMeter = (aid, row) => {
    if (!meterByAsset.has(aid)) meterByAsset.set(aid, []);
    meterByAsset.get(aid).push(row);
  };

  if (tableExists('fuel_issues')) {
    const fiCols = tableCols('fuel_issues');
    const hasTanks = tableExists('fuel_tanks');
    const tankCols = hasTanks ? tableCols('fuel_tanks') : new Set();
    const tankIdExpr = (fiCols.has('source_tank_id') && fiCols.has('bulk_tank_id'))
      ? 'COALESCE(fi.source_tank_id, fi.bulk_tank_id)'
      : (fiCols.has('source_tank_id') ? 'fi.source_tank_id' : (fiCols.has('bulk_tank_id') ? 'fi.bulk_tank_id' : 'NULL'));
    const voidConds = [];
    if (fiCols.has('is_voided')) voidConds.push('COALESCE(fi.is_voided, 0) = 0');
    if (fiCols.has('voided')) voidConds.push('COALESCE(fi.voided, 0) = 0');
    const voidWhere = voidConds.length ? voidConds.join(' AND ') : '1=1';
    const siteFallbacks = [
      fiCols.has('target_project_id') ? 'tp.name' : null,
      fiCols.has('project_id') ? 'ip.name' : null,
      fiCols.has('source_project_id') ? 'sp.name' : null,
      (hasTanks && tankCols.has('project_id')) ? 'tkp.name' : null,
      fiCols.has('station_name') ? 'fi.station_name' : null,
      fiCols.has('pump_location') ? 'fi.pump_location' : null,
      (hasTanks && tankCols.has('name')) ? 't.name' : null,
      "'Unallocated Pump'",
    ].filter(Boolean);

    const fuelRows = all(`
      SELECT fi.id,
             ${fiCols.has('issue_no') ? 'fi.issue_no' : 'NULL'} AS issue_no,
             fi.asset_id,
             ${fiCols.has('asset_code') ? 'fi.asset_code' : 'NULL'} AS asset_code,
             ${fiCols.has('vehicle_ref') ? 'fi.vehicle_ref' : 'NULL'} AS vehicle_ref,
             fi.litres,
             ${fiCols.has('meter_reading') ? 'fi.meter_reading' : 'NULL'} AS meter_reading,
             ${fiCols.has('meter_type') ? 'fi.meter_type' : 'NULL'} AS meter_type,
             fi.issue_date,
             ${fiCols.has('station_name') ? 'fi.station_name' : 'NULL'} AS station_name,
             ${fiCols.has('pump_location') ? 'fi.pump_location' : 'NULL'} AS pump_location,
             ${fiCols.has('driver_name') ? 'fi.driver_name' : 'NULL'} AS driver_name,
             COALESCE(${siteFallbacks.join(', ')}) AS site_name,
             ${(hasTanks && tankCols.has('name')) ? 't.name' : 'NULL'} AS tank_name
        FROM fuel_issues fi
        ${hasTanks ? `LEFT JOIN fuel_tanks t ON t.id = ${tankIdExpr}` : ''}
        ${(hasTanks && tankCols.has('project_id')) ? 'LEFT JOIN projects tkp ON tkp.id = t.project_id' : ''}
        ${fiCols.has('target_project_id') ? 'LEFT JOIN projects tp ON tp.id = fi.target_project_id' : ''}
        ${fiCols.has('project_id') ? 'LEFT JOIN projects ip ON ip.id = fi.project_id' : ''}
        ${fiCols.has('source_project_id') ? 'LEFT JOIN projects sp ON sp.id = fi.source_project_id' : ''}
       WHERE ${voidWhere}
         AND fi.litres > 0
       ORDER BY fi.issue_date ASC, fi.created_at ASC
    `);
    for (const r of fuelRows) {
      const aid = resolveAssetId(r.asset_id, r.asset_code, r.vehicle_ref);
      if (!aid) continue;
      const day = toColomboDay(r.issue_date);
      if (!day || day > asOf) continue;
      pushFuel(aid, {
        id: r.id,
        issue_no: r.issue_no,
        day,
        raw_date: r.issue_date,
        litres: Number(r.litres) || 0,
        meter_reading: r.meter_reading != null ? Number(r.meter_reading) : null,
        meter_type: r.meter_type || null,
        site_name: String(r.site_name || 'Unallocated Pump').trim(),
        tank_name: r.tank_name || r.station_name || null,
        driver_name: r.driver_name || null,
      });
      if (r.meter_reading != null && Number(r.meter_reading) > 0) {
        pushMeter(aid, { day, value: Number(r.meter_reading), meterType: r.meter_type || null, source: 'FUEL_ISSUE' });
      }
    }
  }

  if (tableExists('meter_readings')) {
    for (const mr of all('SELECT asset_id, reading, meter_type, reading_date, source FROM meter_readings WHERE reading > 0 ORDER BY reading_date ASC')) {
      const aid = resolveAssetId(mr.asset_id);
      if (!aid) continue;
      const day = toColomboDay(mr.reading_date);
      if (!day || day > asOf) continue;
      pushMeter(aid, { day, value: Number(mr.reading), meterType: mr.meter_type || null, source: mr.source || 'MANUAL' });
    }
  }
  if (tableExists('fuel_meter_readings')) {
    for (const fmr of all('SELECT asset_id, asset_code, meter_reading, meter_type, reading_date, source FROM fuel_meter_readings WHERE meter_reading > 0 ORDER BY reading_date ASC')) {
      const aid = resolveAssetId(fmr.asset_id, fmr.asset_code);
      if (!aid) continue;
      const day = toColomboDay(fmr.reading_date);
      if (!day || day > asOf) continue;
      pushMeter(aid, { day, value: Number(fmr.meter_reading), meterType: fmr.meter_type || null, source: fmr.source || 'FUEL_LOG' });
    }
  }
  for (const pts of meterByAsset.values()) {
    pts.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.value - b.value));
  }

  // 3. Stage 2 data: Unified Breakdowns + Repair-Job Consumed Filters
  const breakdownsByAsset = new Map();
  let allBreakdowns = [];
  try {
    allBreakdowns = breakdownsLib.buildUnifiedRecords({ assetId: assetId ? Number(assetId) : null, scopeMode: 'all' });
  } catch {
    allBreakdowns = [];
  }
  for (const b of allBreakdowns) {
    if (String(b.status || '').toUpperCase() === 'WAIVED') continue;
    const aid = resolveAssetId(b.asset_id, b.vehicle_code, b.registration);
    if (!aid) continue;
    if (!breakdownsByAsset.has(aid)) breakdownsByAsset.set(aid, []);
    breakdownsByAsset.get(aid).push(b);
  }

  // Filters/parts already issued on repair job cards in [monthStart, asOf]
  const repairReplacedByAsset = new Map();
  const issCols = tableCols('issues');
  if (tableExists('issues') && tableExists('job_cards')) {
    const issVoidClause = issCols.has('voided') ? 'COALESCE(i.voided, 0) = 0' : '1=1';
    for (const iss of all(`
      SELECT COALESCE(i.asset_id, j.asset_id) AS asset_id,
             ${issCols.has('category') ? 'i.category' : 'NULL'} AS category,
             i.description, i.issue_date, j.job_no
        FROM issues i
        JOIN job_cards j ON j.id = i.job_id
       WHERE ${issVoidClause}
         AND j.type = 'repair'
         AND date(i.issue_date) >= ? AND date(i.issue_date) <= ?
    `, monthStart, asOf)) {
      const aid = iss.asset_id;
      if (!aid) continue;
      const desc = `${iss.category || ''} ${iss.description || ''}`.toLowerCase();
      if (!desc.includes('filter') && !desc.includes('water separator')) continue;
      if (!repairReplacedByAsset.has(aid)) repairReplacedByAsset.set(aid, []);
      repairReplacedByAsset.get(aid).push({
        category: iss.category || null,
        description: iss.description,
        date: String(iss.issue_date).slice(0, 10),
        job_no: iss.job_no,
      });
    }
  }

  // 4. Activity signals (180d) & Service Visits
  const activeSet = new Set();
  const markActive = (rows) => { for (const r of rows) if (r.asset_id) activeSet.add(r.asset_id); };
  const activeStart = addDays(asOf, -ACTIVE_DAYS);
  if (tableExists('job_daily_work') && tableExists('job_cards')) {
    markActive(all(`SELECT DISTINCT j.asset_id FROM job_daily_work w JOIN job_cards j ON j.id = w.job_id WHERE j.asset_id IS NOT NULL AND date(w.work_date) >= ? AND date(w.work_date) <= ?`, activeStart, asOf));
  }
  if (tableExists('issues')) {
    const issVoidPlain = issCols.has('voided') ? 'AND COALESCE(voided, 0) = 0' : '';
    markActive(all(`SELECT DISTINCT asset_id FROM issues WHERE asset_id IS NOT NULL ${issVoidPlain} AND date(issue_date) >= ? AND date(issue_date) <= ?`, activeStart, asOf));
  }
  if (tableExists('mrn')) {
    markActive(all(`SELECT DISTINCT asset_id FROM mrn WHERE asset_id IS NOT NULL AND date(req_date) >= ? AND date(req_date) <= ?`, activeStart, asOf));
  }

  const visitsByAsset = new Map();
  if (tableExists('service_jobs')) {
    const sjRows = all(`
      SELECT s.id, s.asset_id, date(s.service_date) AS d, s.meter_reading, s.next_service_meter, s.site_location, s.service_type
        FROM service_jobs s
       WHERE s.asset_id IS NOT NULL AND s.service_date IS NOT NULL AND TRIM(s.service_date) <> ''
         AND date(s.service_date) <= ?
         ${assetId ? 'AND s.asset_id = ?' : ''}
       ORDER BY s.asset_id, date(s.service_date), s.id
    `, asOf, ...(assetId ? [Number(assetId)] : []));

    const sfBySvc = new Map();
    if (tableExists('service_filters')) {
      for (const sf of all('SELECT service_id, filter_no, filter_no_norm, category, action_type, qty FROM service_filters ORDER BY id')) {
        if (!sfBySvc.has(sf.service_id)) sfBySvc.set(sf.service_id, []);
        sfBySvc.get(sf.service_id).push(sf);
      }
    }

    const seenVisit = new Map();
    for (const r of sjRows) {
      const k = `${r.asset_id}|${r.d}`;
      let v = seenVisit.get(k);
      if (!v) {
        v = {
          asset_id: r.asset_id,
          date: r.d,
          service_ids: [],
          meter_reading: r.meter_reading,
          next_service_meter: r.next_service_meter,
          site_location: r.site_location,
          service_type: r.service_type,
          lines: [],
        };
        seenVisit.set(k, v);
        if (!visitsByAsset.has(r.asset_id)) visitsByAsset.set(r.asset_id, []);
        visitsByAsset.get(r.asset_id).push(v);
      }
      v.service_ids.push(r.id);
      v.lines.push(...(sfBySvc.get(r.id) || []));
      if (!v.meter_reading && r.meter_reading) v.meter_reading = r.meter_reading;
      if (!v.next_service_meter && r.next_service_meter) v.next_service_meter = r.next_service_meter;
    }
  }

  // 5. Filter category rules, per-vehicle schedules, PM master tasks, stock & prices
  const rulesMap = new Map();
  for (const r of DEFAULT_CATEGORY_RULES) rulesMap.set(r.category, r);
  if (tableExists('filter_category_rules')) {
    for (const r of all('SELECT * FROM filter_category_rules')) rulesMap.set(r.category, r);
  }

  const schedulesByAsset = new Map();
  if (tableExists('vehicle_filter_schedules')) {
    for (const s of all('SELECT * FROM vehicle_filter_schedules WHERE active = 1 ORDER BY id')) {
      if (!schedulesByAsset.has(s.asset_id)) schedulesByAsset.set(s.asset_id, []);
      schedulesByAsset.get(s.asset_id).push(s);
    }
  }

  const pmFiltersByCat = new Map();
  if (tableExists('pm_tasks')) {
    for (const pm of all(`
      SELECT category, interval_hours, component, description, parts
        FROM pm_tasks
       WHERE interval_hours >= 250
         AND LOWER(COALESCE(component,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(parts,'')) LIKE '%filter%'
       ORDER BY category, interval_hours, sort_order
    `)) {
      const ck = String(pm.category || '').trim().toLowerCase();
      if (!pmFiltersByCat.has(ck)) pmFiltersByCat.set(ck, []);
      pmFiltersByCat.get(ck).push(pm);
    }
  }

  const spCtx = stockAndPriceContext();

  // 6. Evaluate each canonical vehicle across all 4 stages
  const fleetCounts = {
    registered: 0,
    tracked: 0,
    overdue: 0,
    due_soon: 0,
    service_on_breakdown: 0,
    on_breakdown: 0,
    ok: 0,
    unknown: 0,
    unknown_why: { never_serviced: 0, parked: 0, no_usage_data: 0 },
  };

  const overdueList = [];
  const dueList = [];
  const breakdownOppList = [];
  const onBreakdownList = [];
  const okList = [];
  const parkedList = [];
  const allVehicleRows = [];

  for (const asset of assets) {
    const rateCard = rateCards.get(asset.id) || null;
    const overrideRow = overridesByAsset.get(asset.id) || null;
    const specRow = specsByAsset.get(asset.id) || null;
    const categoryName = inferCategoryName(asset, rateCard);
    const meterType = inferMeterType(asset, rateCard, overrideRow);
    const unitLabel = meterType === 'KM' ? 'km' : 'hr';

    const visits = visitsByAsset.get(asset.id) || [];
    const lastVisit = visits.length ? visits[visits.length - 1] : null;
    const fuelIssuesAll = fuelByAsset.get(asset.id) || [];
    const meterPoints = meterByAsset.get(asset.id) || [];
    const bdRecords = breakdownsByAsset.get(asset.id) || [];

    const hasRecentFuel = fuelIssuesAll.some((f) => f.day >= activeStart);
    const hasRecentMeter = meterPoints.some((m) => m.day >= activeStart);
    const hasRecentService = !!lastVisit && lastVisit.date >= activeStart;
    const active180 = activeSet.has(asset.id) || hasRecentFuel || hasRecentMeter || hasRecentService;

    // Determine site display label (current assignment or asset project)
    const assignment = assignmentsByAsset.get(asset.id) || null;
    const currentSite = (assignment && assignment.project_name)
      || asset.current_project_name
      || (lastVisit && lastVisit.site_location ? String(lastVisit.site_location).trim().toUpperCase() : null)
      || null;

    // Resolve service interval
    const codePrefix = String(asset.ec_code || asset.code || '').toUpperCase().split(/[-\s]/)[0];
    const catInv = intervalsByCat.get(codePrefix) || intervalsByCat.get(categoryName.toUpperCase()) || null;
    let intervalValue = meterType === 'KM' ? 5000 : 500;
    let warnThreshold = meterType === 'KM' ? 500 : 50;
    let intervalSource = 'default';
    const combinePct = overrideRow && overrideRow.combine_pct != null ? Number(overrideRow.combine_pct) : 0.2;

    if (overrideRow && overrideRow.interval_value > 0) {
      intervalValue = Number(overrideRow.interval_value);
      warnThreshold = overrideRow.warn_threshold != null ? Number(overrideRow.warn_threshold) : r1(intervalValue * 0.1);
      intervalSource = 'override';
    } else if (specRow && specRow.interval_hours > 0 && meterType === 'HOURS') {
      intervalValue = Number(specRow.interval_hours);
      warnThreshold = r1(intervalValue * 0.1);
      intervalSource = 'spec';
    } else if (catInv) {
      intervalValue = meterType === 'KM' ? Number(catInv.interval_km || 5000) : Number(catInv.interval_hours || 500);
      warnThreshold = meterType === 'KM' ? Number(catInv.warn_km || 500) : Number(catInv.warn_hours || 50);
      intervalSource = 'category';
    }

    // Parse last service meter carefully
    const lastMeterParsed = lastVisit ? parseServiceMeter(lastVisit.meter_reading, meterType) : { value: null, usable: false, reason: 'none' };
    const anchorHadService = !!lastVisit;
    const anchorDate = lastVisit
      ? lastVisit.date
      : (fuelIssuesAll.length ? fuelIssuesAll[0].day : (meterPoints.length ? meterPoints[0].day : null));

    // Check whether lastVisit.next_service_meter gives a plausible asset-specific interval
    if (intervalSource === 'default' && lastVisit && lastMeterParsed.usable) {
      const nextParsed = parseServiceMeter(lastVisit.next_service_meter, meterType);
      if (nextParsed.usable && nextParsed.value > lastMeterParsed.value) {
        const implied = nextParsed.value - lastMeterParsed.value;
        const plausible = meterType === 'KM' ? (implied >= 1000 && implied <= 30000) : (implied >= 100 && implied <= 2500);
        if (plausible) {
          intervalValue = implied;
          warnThreshold = r1(implied * 0.1);
          intervalSource = 'last_service';
        }
      }
    }

    // ---- Stage 1: All-Site Fuel Issues (since anchor + in target month) ----
    const fuelSince = anchorDate
      ? fuelIssuesAll.filter((f) => (anchorHadService ? f.day > anchorDate : f.day >= anchorDate) && f.day <= asOf)
      : [];
    const fuelInMonth = fuelIssuesAll.filter((f) => f.day >= monthStart && f.day <= asOf);

    const groupBySite = (list) => {
      const map = new Map();
      for (const f of list) {
        const key = f.site_name || 'Unallocated Pump';
        let entry = map.get(key);
        if (!entry) {
          entry = { site_name: key, tank_names: new Set(), litres: 0, issues: 0, first_date: f.day, last_date: f.day };
          map.set(key, entry);
        }
        if (f.tank_name) entry.tank_names.add(f.tank_name);
        entry.litres += f.litres;
        entry.issues += 1;
        if (f.day < entry.first_date) entry.first_date = f.day;
        if (f.day > entry.last_date) entry.last_date = f.day;
      }
      return [...map.values()]
        .map((s) => ({
          site_name: s.site_name,
          tanks: [...s.tank_names],
          litres: r1(s.litres),
          issues: s.issues,
          first_date: s.first_date,
          last_date: s.last_date,
        }))
        .sort((a, b) => b.litres - a.litres);
    };

    const sitesSince = groupBySite(fuelSince);
    const monthSites = groupBySite(fuelInMonth);
    const fuelLitresSince = r1(fuelSince.reduce((s, f) => s + f.litres, 0));
    const monthLitres = r1(fuelInMonth.reduce((s, f) => s + f.litres, 0));

    const rateInfo = resolveConsumptionRate(rateCard, meterType);
    const fuelDerivedSince = rateInfo.comparable && fuelLitresSince > 0 ? r1(fuelLitresSince / rateInfo.typ) : null;
    const monthFuelDerived = rateInfo.comparable && monthLitres > 0 ? r1(monthLitres / rateInfo.typ) : null;

    const meterRes = anchorDate
      ? computeTrustedMeterGrowth({
          anchorDate,
          anchorMeter: lastMeterParsed.usable ? lastMeterParsed.value : null,
          anchorHadService,
          meterPoints,
          basis: meterType,
          asOf,
        })
      : { recordedSince: null, currentMeter: null, meterNote: 'No anchor date', warnings: [] };

    // Month meter growth (for active monthly run-rate velocity)
    const monthMeters = meterPoints.filter((m) => m.day >= monthStart && m.day <= asOf && (!m.meterType || m.meterType === 'NONE' || m.meterType === meterType));
    let monthMeterDelta = null;
    if (monthMeters.length >= 2) {
      const d = monthMeters[monthMeters.length - 1].value - monthMeters[0].value;
      const span = Math.max(1, daysBetween(monthMeters[monthMeters.length - 1].day, monthMeters[0].day));
      if (d >= 0 && d <= (MAX_DAILY_DELTA[meterType] || 1500) * span) monthMeterDelta = r1(d);
    }

    // ---- Stage 2: Monthly Breakdown History ----
    const monthEpisodes = [];
    const monthDownDays = new Set();
    const sinceDownDays = new Set();
    let openBreakdown = null;

    for (const b of bdRecords) {
      const bStart = b.breakdown_start;
      const bEnd = b.breakdown_end || null;
      if (!bStart || bStart > asOf) continue;

      if (b.is_open && (!openBreakdown || bStart < openBreakdown.breakdown_start)) {
        openBreakdown = b;
      }

      // Overlap with target month [monthStart, asOf]
      if (!bEnd || bEnd >= monthStart) {
        const s = bStart < monthStart ? monthStart : bStart;
        const e = !bEnd || bEnd > asOf ? asOf : bEnd;
        let cur = s;
        let daysInMonth = 0;
        for (let guard = 0; guard < 35 && cur <= e; guard++) {
          monthDownDays.add(cur);
          daysInMonth++;
          cur = addDays(cur, 1);
        }
        monthEpisodes.push({
          id: b.id,
          source_type: b.source_type,
          job_no: b.job_no || null,
          jr_no: b.jr_no || null,
          site: b.project_name || null,
          start: bStart,
          end: bEnd,
          days_in_month: daysInMonth,
          status: b.is_open ? 'OPEN' : 'CLOSED',
          reason: b.reason || 'Breakdown',
        });
      }

      // Overlap with since-service window [anchorDate, asOf]
      if (anchorDate && (!bEnd || bEnd >= anchorDate)) {
        const s = bStart < anchorDate ? anchorDate : bStart;
        const e = !bEnd || bEnd > asOf ? asOf : bEnd;
        let cur = s;
        for (let guard = 0; guard < 400 && cur <= e; guard++) {
          sinceDownDays.add(cur);
          cur = addDays(cur, 1);
        }
      }
    }

    const breakdownDaysInMonth = monthDownDays.size;
    const breakdownDaysSince = sinceDownDays.size;
    const isCurrentlyDown = !!openBreakdown;
    const riskCategories = breakdownRiskCategories(monthEpisodes);
    const repairReplacedList = repairReplacedByAsset.get(asset.id) || [];

    // ---- Stage 3: Service Time & Status Calculation ----
    const candidates = [meterRes.recordedSince, fuelDerivedSince].filter((v) => v != null && v >= 0);
    const usedSince = candidates.length ? Math.max(...candidates) : null;
    const usedSource = usedSince == null
      ? 'none'
      : (meterRes.recordedSince != null && meterRes.recordedSince >= (fuelDerivedSince ?? -1) ? 'meter' : 'fuel');
    const remainingUnits = usedSince != null ? r1(intervalValue - usedSince) : null;

    const monthElapsedDays = daysInclusive(monthStart, asOf);
    const monthActiveDays = Math.max(1, monthElapsedDays - breakdownDaysInMonth);
    const sinceElapsedDays = anchorDate ? Math.max(1, daysBetween(asOf, anchorDate)) : 0;
    const sinceActiveDays = Math.max(1, sinceElapsedDays - breakdownDaysSince);

    const monthUnitsRun = Math.max(monthMeterDelta || 0, monthFuelDerived || 0);
    const monthRatePerDay = monthUnitsRun > 0 ? r2(monthUnitsRun / monthActiveDays) : null;
    const sinceRatePerDay = usedSince != null && usedSince > 0 ? r2(usedSince / sinceActiveDays) : null;
    const activeRatePerDay = (monthRatePerDay && monthActiveDays >= 3)
      ? monthRatePerDay
      : (sinceRatePerDay || monthRatePerDay || null);

    let status = 'UNKNOWN';
    let unknownWhy = null;
    let projectedDueDate = null;
    let daysUntilDue = null;
    let combineOnBreakdown = false;

    if (usedSince == null) {
      if (isCurrentlyDown) {
        status = 'ON_BREAKDOWN';
      } else {
        status = 'UNKNOWN';
        unknownWhy = !lastVisit ? 'never_serviced' : (!active180 ? 'parked' : 'no_usage_data');
      }
    } else if (remainingUnits <= 0) {
      status = 'OVERDUE';
      if (isCurrentlyDown) combineOnBreakdown = true;
    } else if (isCurrentlyDown) {
      combineOnBreakdown = remainingUnits <= r1(intervalValue * combinePct);
      status = combineOnBreakdown ? 'SERVICE_ON_BREAKDOWN' : 'ON_BREAKDOWN';
    } else {
      daysUntilDue = activeRatePerDay && activeRatePerDay > 0 ? Math.ceil(remainingUnits / activeRatePerDay) : null;
      projectedDueDate = daysUntilDue != null ? addDays(asOf, daysUntilDue) : null;
      if (remainingUnits <= warnThreshold || (projectedDueDate && projectedDueDate <= monthEnd)) {
        status = 'DUE_SOON';
      } else if (!active180) {
        status = 'UNKNOWN';
        unknownWhy = 'parked';
      } else {
        status = 'OK';
      }
    }

    const isTracked = fuelIssuesAll.length > 0 || meterPoints.length > 0 || visits.length > 0 || isCurrentlyDown;
    if (asset.in_register) {
      fleetCounts.registered++;
    }
    if (isTracked) {
      fleetCounts.tracked++;
      if (status === 'OVERDUE') fleetCounts.overdue++;
      else if (status === 'DUE_SOON') fleetCounts.due_soon++;
      else if (status === 'SERVICE_ON_BREAKDOWN') fleetCounts.service_on_breakdown++;
      else if (status === 'ON_BREAKDOWN') fleetCounts.on_breakdown++;
      else if (status === 'OK') fleetCounts.ok++;
      else {
        fleetCounts.unknown++;
        if (unknownWhy) fleetCounts.unknown_why[unknownWhy]++;
      }
    }

    // ---- Stage 4: Selective Filter Plan ("every service no need to change all filters") ----
    const nextServiceSeq = visits.length + 1;
    let scheduleRows = schedulesByAsset.get(asset.id) || [];

    // Dynamic read-only fallback if vehicle_filter_schedules wasn't materialized (e.g. unit tests)
    if (!scheduleRows.length && visits.length > 0) {
      scheduleRows = deriveDynamicSchedule(visits, rulesMap);
    }
    // Second fallback: PM Master filter tasks for the machine category when no filter history exists
    if (!scheduleRows.length) {
      const pmRows = pmFiltersByCat.get(categoryName.toLowerCase()) || [];
      if (pmRows.length) {
        scheduleRows = deriveScheduleFromPmTasks(pmRows, meterType, intervalValue);
      }
    }

    const filterMatrix = [];
    for (const sch of scheduleRows) {
      const rule = rulesMap.get(sch.category) || defaultRuleFor(rulesMap, sch.category);
      const everyN = Math.max(1, Number(sch.every_n_services || rule.every_n_services || 1));
      const betweenAction = sch.between_action === 'E' ? 'E' : 'SKIP';
      const intervalUnits = sch.interval_units != null ? Number(sch.interval_units) : null;

      // Count visits completed AFTER last_replaced_date
      let visitsSinceX = 0;
      if (sch.last_replaced_date) {
        visitsSinceX = visits.filter((v) => v.date > sch.last_replaced_date).length;
      } else {
        visitsSinceX = visits.length;
      }

      // Compute running units accumulated since last_replaced_date up to asOf
      let unitsSinceX = usedSince;
      if (sch.last_replaced_date) {
        const fuelSinceX = fuelIssuesAll
          .filter((f) => f.day > sch.last_replaced_date && f.day <= asOf)
          .reduce((s, f) => s + f.litres, 0);
        const fuelDerivedX = rateInfo.comparable && fuelSinceX > 0 ? r1(fuelSinceX / rateInfo.typ) : null;
        let meterDeltaX = null;
        if (sch.last_replaced_meter != null && meterRes.currentMeter != null && meterRes.currentMeter >= sch.last_replaced_meter) {
          meterDeltaX = r1(meterRes.currentMeter - sch.last_replaced_meter);
        }
        const candX = [meterDeltaX, fuelDerivedX].filter((x) => x != null && x >= 0);
        unitsSinceX = candX.length ? Math.max(...candX) : usedSince;
      }

      const projectedUnitsAtService = (unitsSinceX || 0) + Math.max(0, remainingUnits || 0);
      const cycleDue = (visitsSinceX + 1) >= everyN;
      const unitsDue = intervalUnits != null && projectedUnitsAtService >= intervalUnits;
      const riskReasons = riskCategories.get(sch.category);
      const breakdownDue = !!(riskReasons && riskReasons.size > 0);
      const alreadyOnRepair = repairReplacedList.find((rp) =>
        (rp.category && rp.category.toLowerCase() === sch.category.toLowerCase()) ||
        rp.description.toLowerCase().includes(sch.category.toLowerCase().replace(' - s', '').replace(':', ''))
      );

      let decision;
      let action;
      let decisionReason;
      const remainingServices = Math.max(0, everyN - (visitsSinceX + 1));

      if (alreadyOnRepair) {
        decision = 'SKIP';
        action = 'SKIP_RECENT';
        decisionReason = `Already issued on repair job ${alreadyOnRepair.job_no} (${alreadyOnRepair.date})`;
      } else if (cycleDue || unitsDue || breakdownDue) {
        decision = 'CHANGE';
        action = 'X';
        if (breakdownDue && !cycleDue && !unitsDue) {
          decisionReason = `Triggered by month breakdown (${[...riskReasons][0].slice(0, 60)})`;
        } else if (unitsDue && !cycleDue) {
          decisionReason = `Due by interval (${Math.round(projectedUnitsAtService)} >= ${intervalUnits} ${unitLabel})`;
        } else {
          decisionReason = everyN === 1
            ? 'Every service replacement'
            : `Due at cycle (${visitsSinceX + 1} of ${everyN} services since last change)`;
        }
      } else if (betweenAction === 'E') {
        decision = 'CLEAN';
        action = 'E';
        decisionReason = `Clean / inspect only — replace in ${remainingServices} more service(s)`;
      } else {
        decision = 'SKIP';
        action = 'SKIP';
        decisionReason = `No change needed this service — next in ${remainingServices} service(s)`;
      }

      const tokens = splitFilterTokens(sch.part_no);
      const primaryNorm = tokens[0] ? tokens[0].norm : (sch.part_no_norm || null);
      const unitPrice = primaryNorm ? (spCtx.prices.get(primaryNorm) || null) : null;
      const stockInfo = primaryNorm ? (spCtx.stockMap.get(primaryNorm) || { qty: 0, rows: 0 }) : { qty: 0, rows: 0 };
      const equivs = primaryNorm && stockInfo.qty <= 0 ? equivalentsInStock(primaryNorm, spCtx) : [];

      filterMatrix.push({
        category: sch.category,
        part_no: sch.part_no || null,
        part_no_norm: primaryNorm,
        qty: Number(sch.qty) > 0 ? Number(sch.qty) : 1,
        every_n_services: everyN,
        interval_units: intervalUnits,
        between_action: betweenAction,
        last_replaced_date: sch.last_replaced_date || null,
        last_replaced_meter: sch.last_replaced_meter || null,
        visits_since_change: visitsSinceX,
        units_since_change: unitsSinceX,
        remaining_services: remainingServices,
        decision,
        action,
        reason: decisionReason,
        unit_price: unitPrice,
        in_stock: stockInfo.qty,
        equivalents_in_stock: equivs,
        locked: !!sch.locked,
        source: sch.source || 'history',
      });
    }

    const wantedFilters = filterMatrix.filter((f) => f.decision === 'CHANGE');
    const cleanFilters = filterMatrix.filter((f) => f.decision === 'CLEAN');
    const skippedFilters = filterMatrix.filter((f) => f.decision === 'SKIP');

    const row = {
      asset_id: asset.id,
      asset_code: asset.code,
      asset_reg: asset.registration,
      asset_ec: asset.ec_code,
      category: categoryName,
      in_register: asset.in_register,
      site: currentSite,
      meter_type: meterType,
      unit: unitLabel,
      last_service: lastVisit ? lastVisit.date : null,
      last_service_meter: lastMeterParsed.usable ? lastMeterParsed.value : (lastVisit ? lastVisit.meter_reading : null),
      visits: visits.length,
      next_service_seq: nextServiceSeq,
      next_milestone_units: nextServiceSeq * intervalValue,
      interval: intervalValue,
      interval_source: intervalSource,
      warn_threshold: warnThreshold,
      fuel: {
        litres_since_service: fuelLitresSince,
        issues_since_service: fuelSince.length,
        sites_count_since: sitesSince.length,
        sites_since: sitesSince,
        month_litres: monthLitres,
        month_issues: fuelInMonth.length,
        month_sites_count: monthSites.length,
        month_sites: monthSites,
        rate_typ: rateInfo.comparable ? rateInfo.typ : null,
        rate_basis: rateInfo.basis,
        rate_status: rateInfo.reason,
        issues_detail: assetId ? fuelSince.concat(fuelInMonth.filter((m) => !fuelSince.some((s) => s.id === m.id))).slice(-120) : undefined,
      },
      breakdowns: {
        episodes_in_month: monthEpisodes,
        count_in_month: monthEpisodes.length,
        breakdown_days_in_month: breakdownDaysInMonth,
        breakdown_days_since_service: breakdownDaysSince,
        is_currently_down: isCurrentlyDown,
        open_breakdown: openBreakdown ? {
          id: openBreakdown.id,
          start: openBreakdown.breakdown_start,
          site: openBreakdown.project_name,
          job_no: openBreakdown.job_no,
          jr_no: openBreakdown.jr_no,
          reason: openBreakdown.reason,
        } : null,
        combine_on_breakdown: combineOnBreakdown,
        repair_replaced_filters: repairReplacedList,
      },
      timing: {
        recorded_since: meterRes.recordedSince,
        current_meter: meterRes.currentMeter,
        meter_note: meterRes.meterNote,
        meter_warnings: meterRes.warnings,
        fuel_derived_since: fuelDerivedSince,
        used_since: usedSince,
        used_source: usedSource,
        remaining_units: remainingUnits,
        month_active_days: monthActiveDays,
        month_elapsed_days: monthElapsedDays,
        since_active_days: sinceActiveDays,
        month_rate_per_day: monthRatePerDay,
        since_rate_per_day: sinceRatePerDay,
        active_rate_per_day: activeRatePerDay,
        days_until_due: daysUntilDue,
        projected_due_date: projectedDueDate,
      },
      state: status,
      unknown_why: unknownWhy,
      active: active180,
      filter_matrix: filterMatrix,
      wanted_filters: wantedFilters,
      clean_filters: cleanFilters,
      skipped_filters: skippedFilters,
      // Compatibility aliases for existing Excel/table consumers
      due_date: projectedDueDate,
      core: wantedFilters.map((f) => ({
        category: f.category,
        part: f.part_no,
        part_norm: f.part_no_norm,
        qty: f.qty,
        last_fitted: f.last_replaced_date,
        every_n_services: f.every_n_services,
        reason: f.reason,
      })),
    };

    if (!isTracked && !assetId) continue;

    // Optional site/search filters apply to the displayed working list (NEVER to the underlying fuel/breakdown math!)
    if (site && String(site).trim() && String(site).trim().toUpperCase() !== 'ALL') {
      const sq = String(site).trim().toLowerCase();
      const siteHit = (row.site && row.site.toLowerCase().includes(sq))
        || row.fuel.month_sites.some((s) => s.site_name.toLowerCase().includes(sq))
        || row.fuel.sites_since.some((s) => s.site_name.toLowerCase().includes(sq));
      if (!siteHit) continue;
    }
    if (search && String(search).trim()) {
      const q = codeKey(search);
      const rawQ = String(search).trim().toLowerCase();
      const hit = codeKey(row.asset_code).includes(q)
        || codeKey(row.asset_reg).includes(q)
        || codeKey(row.asset_ec).includes(q)
        || String(row.category || '').toLowerCase().includes(rawQ)
        || String(row.site || '').toLowerCase().includes(rawQ);
      if (!hit) continue;
    }

    allVehicleRows.push(row);
    if (status === 'SERVICE_ON_BREAKDOWN') breakdownOppList.push(row);
    else if (status === 'OVERDUE') overdueList.push(row);
    else if (status === 'DUE_SOON') dueList.push(row);
    else if (status === 'ON_BREAKDOWN') onBreakdownList.push(row);
    else if (status === 'OK') okList.push(row);
    else parkedList.push(row);
  }

  const sortUrgency = (a, b) =>
    (a.timing.remaining_units ?? 1e9) - (b.timing.remaining_units ?? 1e9) ||
    (b.visits || 0) - (a.visits || 0);

  overdueList.sort(sortUrgency);
  dueList.sort(sortUrgency);
  breakdownOppList.sort(sortUrgency);
  onBreakdownList.sort(sortUrgency);
  okList.sort(sortUrgency);
  parkedList.sort((a, b) => (b.visits || 0) - (a.visits || 0));

  // Only vehicles that need servicing now/this month contribute to the wanted filter purchase order
  const actionRows = [
    ...breakdownOppList,
    ...overdueList,
    ...dueList,
    ...(includeLongOverdue ? parkedList : []),
  ];

  const order = consolidateWantedFilters(actionRows, spCtx);
  const filtersSavedCount = actionRows.reduce(
    (s, r) => s + r.clean_filters.length + r.skipped_filters.length,
    0
  );

  const sitesAvailable = [...new Set(
    allVehicleRows.flatMap((r) => [r.site, ...r.fuel.month_sites.map((s) => s.site_name)]).filter(Boolean)
  )].sort();

  return {
    month: win.month,
    month_start: monthStart,
    month_end: monthEnd,
    as_of: asOf,
    rule_version: RULE_VERSION,
    source: 'unified_4stage',
    fleet: fleetCounts,
    totals: {
      overdue: overdueList.length,
      due_in_month: dueList.length,
      service_on_breakdown: breakdownOppList.length,
      on_breakdown: onBreakdownList.length,
      ok: okList.length,
      parked: parkedList.length,
      total_actionable: actionRows.length,
      filters_saved_by_plan: filtersSavedCount,
      ...order.totals,
    },
    breakdown_opportunities: breakdownOppList,
    carry: overdueList,
    due: dueList,
    on_breakdown: onBreakdownList,
    ok: includeOk ? okList : [],
    parked: includeLongOverdue ? parkedList : [],
    categories: order.categories,
    parts: order.parts,
    sites_available: sitesAvailable,
  };
}

function deriveDynamicSchedule(visits, rulesMap) {
  const totalV = visits.filter((v) => v.lines && v.lines.length > 0).length || visits.length;
  const byCat = new Map();
  for (let idx = 0; idx < visits.length; idx++) {
    const v = visits[idx];
    for (const l of v.lines || []) {
      const cat = String(l.category || '').trim();
      if (!cat) continue;
      const act = String(l.action_type || 'X').trim().toUpperCase();
      if (!byCat.has(cat)) byCat.set(cat, { replaced: new Set(), cleaned: new Set(), lastX: null });
      const rec = byCat.get(cat);
      if (act === 'E') {
        rec.cleaned.add(idx);
      } else {
        rec.replaced.add(idx);
        const rawFn = l.filter_no ? String(l.filter_no).trim() : null;
        const split = splitTopLevelParts(rawFn).filter(isUsablePartToken);
        const partNo = split.length ? split.join(' & ') : (isUsablePartToken(rawFn) ? rawFn : null);
        rec.lastX = {
          date: v.date,
          meter: parseNumericMeter(v.meter_reading),
          part_no: partNo,
          part_no_norm: partNo ? normF(split[0] || partNo) : null,
          qty: split.length > 1 ? split.length : (Number(l.qty) > 0 ? Number(l.qty) : 1),
        };
      }
    }
  }
  const out = [];
  for (const [cat, rec] of byCat) {
    const rule = defaultRuleFor(rulesMap, cat);
    const repCount = rec.replaced.size;
    let everyN = rule.every_n_services || 1;
    if (totalV >= 3 && repCount >= 1) {
      const ratio = repCount / totalV;
      if (/engine oil filter/i.test(cat)) everyN = 1;
      else if (ratio >= 0.65) everyN = 1;
      else if (repCount >= 2) everyN = Math.min(4, Math.max(2, Math.round(totalV / repCount)));
      else everyN = Math.max(2, rule.every_n_services || 2);
    }
    const lastX = rec.lastX;
    out.push({
      category: cat,
      part_no: lastX ? lastX.part_no : null,
      part_no_norm: lastX ? lastX.part_no_norm : null,
      qty: lastX ? lastX.qty : 1,
      every_n_services: everyN,
      interval_units: null,
      between_action: rec.cleaned.size > 0 ? 'E' : (rule.between_action || 'SKIP'),
      last_replaced_date: lastX ? lastX.date : null,
      last_replaced_meter: lastX ? lastX.meter : null,
      source: 'dynamic_history',
      locked: 0,
    });
  }
  return out;
}

function deriveScheduleFromPmTasks(pmRows, meterType, baseInterval) {
  const seen = new Set();
  const out = [];
  const unitFactor = meterType === 'KM' ? 10 : 1;
  for (const pm of pmRows) {
    const comp = String(pm.component || pm.parts || pm.description || '').trim();
    const lc = comp.toLowerCase();
    let cat = null;
    if (/oil\s*filter|full-flow/.test(lc)) cat = 'Engine Oil Filter';
    else if (/primary\s*fuel/.test(lc)) cat = 'Primary Fuel Filter';
    else if (/secondary.*fuel|fine\s*fuel/.test(lc)) cat = 'Engine fuel Filter - S';
    else if (/water\s*separator/.test(lc)) cat = 'Water Separator';
    else if (/air.*inner|secondary\s*air/.test(lc)) cat = 'Air Filter Inner';
    else if (/air/.test(lc)) cat = 'Air Filter Outer';
    else if (/hydraul|return\s*filter|suction|high\s*pressure/.test(lc)) cat = 'Hydraulic Filter - S';
    else if (/transmission|tm\s*filter/.test(lc)) cat = 'Trans: Filter';
    if (!cat || seen.has(cat)) continue;
    seen.add(cat);
    const stepUnits = Number(pm.interval_hours) * unitFactor;
    const everyN = Math.max(1, Math.min(4, Math.round(stepUnits / Math.max(1, baseInterval))));
    out.push({
      category: cat,
      part_no: null,
      part_no_norm: null,
      qty: 1,
      every_n_services: everyN,
      interval_units: stepUnits,
      between_action: /air/i.test(cat) ? 'E' : 'SKIP',
      last_replaced_date: null,
      last_replaced_meter: null,
      source: 'pm_master',
      locked: 0,
    });
  }
  return out;
}

function consolidateWantedFilters(rows, spCtx) {
  const byPart = new Map();
  const byCat = new Map();
  let noPart = 0;

  for (const v of rows) {
    for (const wf of v.wanted_filters || []) {
      const q = Number(wf.qty) > 0 ? Number(wf.qty) : 1;
      const cat = byCat.get(wf.category) || { category: wf.category, qty: 0, vehicles: 0, on_hand: 0 };
      cat.qty += q;
      cat.vehicles += 1;
      byCat.set(wf.category, cat);

      const tokens = splitFilterTokens(wf.part_no);
      if (!tokens.length) {
        noPart++;
        continue;
      }
      const perTokenQty = tokens.length > 1 ? 1 : q;
      for (const tok of tokens) {
        const st = spCtx.stockMap.get(tok.norm) || { qty: 0, rows: 0 };
        const p = byPart.get(tok.norm) || {
          part: tok.part,
          part_norm: tok.norm,
          category: wf.category,
          vehicles: 0,
          qty: 0,
          on_hand: st.qty,
          stock_rows: st.rows,
          unit_price: spCtx.prices.get(tok.norm) || null,
          equivalents_in_stock: st.qty <= 0 ? equivalentsInStock(tok.norm, spCtx) : [],
        };
        p.qty += perTokenQty;
        p.vehicles += 1;
        byPart.set(tok.norm, p);
      }
    }
  }

  const parts = [...byPart.values()].map((p) => {
    const toBuy = Math.max(0, p.qty - p.on_hand);
    const covered = Math.min(p.qty, p.on_hand);
    return {
      ...p,
      covered,
      to_buy: toBuy,
      value: p.unit_price ? r2(toBuy * p.unit_price) : null,
      no_stock_row: p.stock_rows === 0,
      duplicate_stock_rows: p.stock_rows > 1,
    };
  }).sort((a, b) => b.qty - a.qty || (a.part_norm < b.part_norm ? -1 : 1));

  for (const p of parts) {
    const cat = byCat.get(p.category);
    if (cat) cat.on_hand += p.covered;
  }
  const categories = [...byCat.values()]
    .map((c) => ({ ...c, shortfall: Math.max(0, c.qty - c.on_hand) }))
    .sort((a, b) => b.qty - a.qty);

  const priced = parts.filter((p) => p.unit_price != null);
  return {
    categories,
    parts,
    totals: {
      category_lines: rows.reduce((s, v) => s + (v.wanted_filters ? v.wanted_filters.length : 0), 0),
      lines_without_a_part: noPart,
      distinct_parts: parts.length,
      qty_needed: parts.reduce((s, p) => s + p.qty, 0),
      qty_covered: parts.reduce((s, p) => s + p.covered, 0),
      qty_to_buy: parts.reduce((s, p) => s + p.to_buy, 0),
      value_priced: r2(priced.reduce((s, p) => s + (p.value || 0), 0)),
      qty_unpriced: parts.filter((p) => p.unit_price == null).reduce((s, p) => s + p.to_buy, 0),
    },
  };
}

function getVehicleServicePlanDetail(assetIdOrCode, { month } = {}) {
  let assetId = Number(assetIdOrCode);
  if (!Number.isFinite(assetId) || assetId <= 0) {
    const raw = String(assetIdOrCode || '').trim();
    const k = codeKey(raw);
    const match = all('SELECT id, code, code_norm, ec_code, registration FROM assets')
      .find((a) => a.code_norm === k || codeKey(a.ec_code) === k || codeKey(a.registration) === k);
    assetId = match ? match.id : null;
  }
  if (!assetId) return null;
  const plan = buildAdvancedServicePlan({ month, assetId, includeLongOverdue: true, includeOk: true });
  const vehicle = [
    ...plan.breakdown_opportunities,
    ...plan.carry,
    ...plan.due,
    ...plan.on_breakdown,
    ...plan.ok,
    ...plan.parked,
  ][0] || null;
  if (!vehicle) return null;
  return {
    month: plan.month,
    month_start: plan.month_start,
    month_end: plan.month_end,
    as_of: plan.as_of,
    rule_version: plan.rule_version,
    vehicle,
  };
}

module.exports = {
  RULE_VERSION,
  colomboToday,
  toColomboDay,
  monthWindow,
  parseServiceMeter,
  resolveConsumptionRate,
  computeTrustedMeterGrowth,
  buildAdvancedServicePlan,
  getVehicleServicePlanDetail,
};
