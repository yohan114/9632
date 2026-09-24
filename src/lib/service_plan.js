'use strict';

// Service & filter plan — which machines are candidates for service in a given month, and
// what filters each would need, worked out from what that machine actually took at its own
// past services.
//
// READ-ONLY. Nothing in here writes.
//
// WHAT THIS IS NOT
// ----------------
// It is not a forecast. Measured on this fleet's own history (hold out each machine's last
// service, predict its date from the earlier ones), the median error is about 70 days and the
// answer is more than 60 days out on 61% of machines. A typical month sees 26–49 services
// while the candidate list runs to ~150. So this narrows 380 machines down to a shortlist the
// storekeeper ticks through — the tick is what makes the order right, not the arithmetic.
//
// WHY DATE INTERVAL AND NOTHING ELSE
// ----------------------------------
// There is no usable meter anywhere: assets.running_hours is NULL on all 1,169 assets,
// service_specs.interval_hours is NULL on all 5 of its rows (which is why the old
// intelligence.serviceDue() has always returned nothing), service_jobs.service_type is NULL on
// 94.8% of rows, and 214 services record the meter as broken outright ("MNW", "M.N.R"). Where
// meter readings ARE written they are internally consistent, but projecting them to a date
// loses to the plain date interval even on the machines where it can be computed (median error
// 80 days vs 70), and collapses on slow-meter machines — one predicted 11,019 days out. The
// meter is therefore shown as text and never calculated with.

const { all, get } = require('../db');
const { normF } = require('./filter_no');
const planner = require('./service_planner_client');

const RULE_VERSION = '2026-08-17.1';
// Machines with a thin history are pulled toward the fleet's own median gap. Weight 3 was
// the best of the values swept: per-machine history only beats a flat fleet constant once a
// machine has 6+ services, and shrinkage gets the benefit without a separate special case.
const SHRINK = 3;
// A machine that is not running is not falling due. The reference planner gets this from
// meters and fuel; here it comes from whether the workshop has touched the machine at all —
// work done on it, parts issued to it, a request raised for it, or a service. 265 of the 504
// registered machines show activity in the six months to August 2026. Without this gate a
// parked machine accrues "overdue" forever and buries the ones actually running.
const ACTIVE_DAYS = 180;
// Past twice its own rhythm, a machine is not "due for its next service" in any useful sense
// — it has no recent service record at all. Measured on this fleet, the cut separates two
// different populations: of the 56 it keeps, 40 have 4+ services; of the 67 it moves aside,
// 40 have only one or two, mostly a single visit back in 2023. The chance of a machine
// actually being serviced also collapses past this point.
const MAX_OVERDUE_RATIO = 2;
// A category counts as part of the machine's kit if it appears on at least half its services.
const KIT_THRESHOLD = 0.5;

const d10 = (v) => String(v || '').slice(0, 10);
const days = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A part number the list can actually put in front of someone: it has to survive
// normalisation, carry a digit, and be short enough to be a number rather than a sentence.
// 252 of the 4,050 filter lines fail this — "REQ", "changed", "full inspection". Their
// CATEGORY still counts: the filter was fitted, only its number went unwritten.
const usablePart = (norm) => !!norm && /[0-9]/.test(norm) && norm.length <= 20;

/**
 * Every service, collapsed to one VISIT per machine per day.
 *
 * 37 (asset, date) pairs hold more than one service row, and 29 of them carry filter lines on
 * two or more — so the duplicates are merged, never dropped, or real filter demand goes with
 * them. Collapsing also removes 38 zero-day gaps that would otherwise read as "due forever".
 */
function loadVisits() {
  const rows = all(`
    SELECT s.id, s.asset_id, date(s.service_date) AS d, s.meter_reading, s.next_service_meter,
           s.site_location, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
           a.in_register
      FROM service_jobs s JOIN assets a ON a.id = s.asset_id
     WHERE s.service_date IS NOT NULL AND TRIM(s.service_date) <> ''
     ORDER BY s.asset_id, date(s.service_date), s.id`);

  const lines = all(`
    SELECT f.service_id, f.filter_no, f.filter_no_norm, f.category
      FROM service_filters f`);
  const byService = new Map();
  for (const l of lines) {
    if (!byService.has(l.service_id)) byService.set(l.service_id, []);
    byService.get(l.service_id).push(l);
  }

  const visits = new Map();          // asset_id -> [visit]
  const seen = new Map();            // asset_id|date -> visit
  for (const r of rows) {
    const key = r.asset_id + '|' + r.d;
    let v = seen.get(key);
    if (!v) {
      v = { asset_id: r.asset_id, date: r.d, service_ids: [], lines: [],
        meter: r.meter_reading, next_meter: r.next_service_meter, site: r.site_location,
        asset_code: r.asset_code, asset_reg: r.asset_reg, asset_ec: r.asset_ec, in_register: r.in_register };
      seen.set(key, v);
      if (!visits.has(r.asset_id)) visits.set(r.asset_id, []);
      visits.get(r.asset_id).push(v);
    }
    v.service_ids.push(r.id);
    v.lines.push(...(byService.get(r.id) || []));
    if (!v.meter && r.meter_reading) v.meter = r.meter_reading;
  }
  return visits;
}

/** The fleet's own median gap, from the collapsed visits — the prior a thin history leans on. */
function fleetPrior(visits) {
  const gaps = [];
  for (const list of visits.values()) {
    for (let i = 1; i < list.length; i++) {
      const g = days(list[i].date, list[i - 1].date);
      if (g > 0) gaps.push(g);
    }
  }
  return { prior: median(gaps) || 153, gaps: gaps.length };
}

const expectedGap = (own, k, prior) => (k === 0 ? prior : (k * own + SHRINK * prior) / (k + SHRINK));

/**
 * The machine's filter kit: the categories it takes at least half the time, each with the
 * part number it most recently took in that category.
 *
 * The CATEGORY is what this promises. The part number is a suggestion — measured against the
 * held-out last service it is right 46% of the time — so it always travels with when it was
 * last fitted, how many different numbers the machine has used, and the alternates.
 */
function kitFor(list) {
  const filtered = list.filter((v) => v.lines.length);
  const catCount = new Map();
  const perCat = new Map();          // category -> [{date, norm, raw}]
  let unreadable = 0;
  for (const v of filtered) {
    const cats = new Set();
    for (const l of v.lines) {
      const cat = (l.category || '').trim() || '(uncategorised)';
      cats.add(cat);
      const norm = l.filter_no_norm || normF(l.filter_no);
      if (!usablePart(norm)) { if (String(l.filter_no || '').trim()) unreadable++; continue; }
      if (!perCat.has(cat)) perCat.set(cat, []);
      perCat.get(cat).push({ date: v.date, norm, raw: String(l.filter_no || '').trim() });
    }
    for (const c of cats) catCount.set(c, (catCount.get(c) || 0) + 1);
  }

  const n = filtered.length;
  const core = []; const sometimes = [];
  for (const [cat, count] of [...catCount.entries()].sort((a, b) => b[1] - a[1])) {
    const uses = (perCat.get(cat) || []).sort((a, b) => (a.date < b.date ? 1 : -1));
    const distinct = [...new Set(uses.map((u) => u.norm))];
    const latest = uses[0] || null;
    // Worth a second look at the machine when the history disagrees with itself.
    const confirm = distinct.length >= 4
      || (uses.length >= 2 && uses[0].norm !== uses[1].norm)
      || /fuel|water separator|hydraulic/i.test(cat);
    const row = {
      category: cat, seen: count, of: n, share: n ? count / n : 0,
      part: latest ? latest.raw : null, part_norm: latest ? latest.norm : null,
      last_fitted: latest ? latest.date : null,
      times_used: uses.length, distinct_numbers: distinct.length,
      alternates: distinct.slice(0, 8), confirm,
    };
    (n && count / n >= KIT_THRESHOLD ? core : sometimes).push(row);
  }
  return { core, sometimes, filtered_visits: n, unreadable };
}

const tableExists = (name) => !!get("SELECT 1 v FROM sqlite_master WHERE type = 'table' AND name = ?", name);

/**
 * Machines the workshop has touched lately — the stand-in for "still running".
 * Any of: work booked against it, parts issued to it, a request raised for it, or a service.
 */
function activeAssets(asOf) {
  const s = new Set();
  const add = (rows) => rows.forEach((r) => r.asset_id && s.add(r.asset_id));
  const win = [asOf, asOf];
  add(all(`SELECT DISTINCT j.asset_id FROM job_daily_work w JOIN job_cards j ON j.id = w.job_id
            WHERE j.asset_id IS NOT NULL AND date(w.work_date) >= date(?, '-${ACTIVE_DAYS} day') AND date(w.work_date) <= date(?)`, ...win));
  add(all(`SELECT DISTINCT asset_id FROM issues
            WHERE asset_id IS NOT NULL AND date(issue_date) >= date(?, '-${ACTIVE_DAYS} day') AND date(issue_date) <= date(?)`, ...win));
  add(all(`SELECT DISTINCT asset_id FROM service_jobs
            WHERE asset_id IS NOT NULL AND date(service_date) >= date(?, '-${ACTIVE_DAYS} day') AND date(service_date) <= date(?)`, ...win));
  add(all(`SELECT DISTINCT asset_id FROM mrn
            WHERE asset_id IS NOT NULL AND date(req_date) >= date(?, '-${ACTIVE_DAYS} day') AND date(req_date) <= date(?)`, ...win));
  return s;
}

/** On hand per normalised part number. Summed — six numbers sit on more than one stock row. */
function stockOnHand() {
  const m = new Map();
  // The filter register arrives with a migration step, so a database that has not had it
  // yet gets a plan with nothing on hand rather than a crash.
  if (!tableExists('filter_stock')) return m;
  for (const f of all('SELECT part_no, qty_in_stock FROM filter_stock WHERE part_no IS NOT NULL')) {
    const k = normF(f.part_no);
    if (!k) continue;
    const cur = m.get(k) || { qty: 0, rows: 0 };
    cur.qty += Number(f.qty_in_stock) || 0;
    cur.rows += 1;
    m.set(k, cur);
  }
  return m;
}

/**
 * Turn the listed machines into one order: a line per filter category, and a line per
 * suggested part number netted against what is on the shelf.
 */
function consolidate(rows, stock, prices) {
  const byPart = new Map(); const byCat = new Map(); let noPart = 0;
  for (const v of rows) {
    for (const c of v.core || []) {
      const cat = byCat.get(c.category) || { category: c.category, qty: 0, vehicles: 0, on_hand: 0 };
      cat.qty += 1; cat.vehicles += 1;
      byCat.set(c.category, cat);
      if (!c.part_norm) { noPart++; continue; }
      const p = byPart.get(c.part_norm) || {
        part: c.part, part_norm: c.part_norm, category: c.category, vehicles: 0, qty: 0,
        on_hand: (stock.get(c.part_norm) || {}).qty || 0,
        stock_rows: (stock.get(c.part_norm) || {}).rows || 0,
        unit_price: prices.get(c.part_norm) || null,
      };
      p.qty += 1; p.vehicles += 1;
      byPart.set(c.part_norm, p);
    }
  }
  const parts = [...byPart.values()].map((p) => ({
    ...p,
    to_buy: Math.max(0, p.qty - p.on_hand),
    covered: Math.min(p.qty, p.on_hand),
    value: p.unit_price ? r2(Math.max(0, p.qty - p.on_hand) * p.unit_price) : null,
    no_stock_row: p.stock_rows === 0,
    duplicate_stock_rows: p.stock_rows > 1,
  })).sort((a, b) => b.qty - a.qty || (a.part_norm < b.part_norm ? -1 : 1));

  // A category's cover comes only from the parts actually suggested inside it — filter_stock's
  // own filter_type cannot be mapped to these categories (10 values against 13, many-to-many).
  for (const p of parts) {
    const cat = byCat.get(p.category);
    if (cat) cat.on_hand += p.covered;
  }
  const categories = [...byCat.values()]
    .map((c) => ({ ...c, shortfall: Math.max(0, c.qty - c.on_hand) }))
    .sort((a, b) => b.qty - a.qty);

  const priced = parts.filter((p) => p.unit_price != null);
  return {
    categories, parts,
    totals: {
      category_lines: rows.reduce((s, v) => s + (v.core ? v.core.length : 0), 0),
      lines_without_a_part: noPart,
      distinct_parts: parts.length,
      qty_needed: parts.reduce((s, p) => s + p.qty, 0),
      qty_covered: parts.reduce((s, p) => s + p.covered, 0),
      qty_to_buy: parts.reduce((s, p) => s + p.to_buy, 0),
      // Two numbers, never one: a single rupee total would hide everything unpriced.
      value_priced: r2(priced.reduce((s, p) => s + (p.value || 0), 0)),
      qty_unpriced: parts.filter((p) => p.unit_price == null).reduce((s, p) => s + p.to_buy, 0),
    },
  };
}

function priceBook() {
  const m = new Map();
  for (const p of all('SELECT filter_no_norm, unit_price FROM filter_prices WHERE unit_price > 0')) {
    if (p.filter_no_norm) m.set(p.filter_no_norm, p.unit_price);
  }
  return m;
}

/**
 * Build the plan for a month.
 *
 * `month` is 'YYYY-MM'. The list is measured as at TODAY when the month is the current one,
 * and as at the month's last day once it is over. It has to be today: measuring the current
 * month from its first day hid every service done since, so HU-5097 — serviced on 12 August —
 * kept appearing on the August list as though it were still due from March. Checking this
 * list each morning should show one fewer machine each time one is done.
 */
function buildServicePlan({ month, includeLongOverdue = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : today.slice(0, 7);
  const monthStart = m + '-01';
  const monthEnd = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 10);
  // Today, held inside the month asked for: a finished month stops at its own last day, a
  // month still to come starts at its first. Only the month in progress moves with the day.
  const asOf = today < monthStart ? monthStart : (today < monthEnd ? today : addDays(monthEnd, -1));

  const visits = loadVisits();
  const { prior, gaps } = fleetPrior(visits);
  const stock = stockOnHand();
  const prices = priceBook();

  const active = activeAssets(asOf);
  // Every machine on the register gets a state, so the counts describe the whole fleet the
  // way the yard does — not just the ones that happen to have a service history.
  const registered = all('SELECT id, code, registration, ec_code FROM assets WHERE in_register = 1');
  const onRegister = new Set(registered.map((a) => a.id));
  const state = { overdue: 0, due_soon: 0, ok: 0, unknown: 0 };
  const unknownWhy = { never_serviced: 0, parked: 0, no_recent_record: 0 };
  const seenAsset = new Set();
  let offRegister = 0;      // serviced machines no longer on the register — counted apart

  const dueIn = []; const carryIn = []; const parked = [];
  for (const [assetId, listRaw] of visits) {
    const list = listRaw.filter((v) => v.date <= asOf);      // only what was known by then
    if (!list.length) continue;
    seenAsset.add(assetId);
    const last = list[list.length - 1];
    const gapsOwn = [];
    for (let i = 1; i < list.length; i++) { const g = days(list[i].date, list[i - 1].date); if (g > 0) gapsOwn.push(g); }
    const k = gapsOwn.length;
    const gap = Math.round(expectedGap(median(gapsOwn) || prior, k, prior));
    const dueDate = addDays(last.date, gap);
    const idle = days(asOf, last.date);
    const ratio = gap > 0 ? idle / gap : 0;

    const row = {
      asset_id: assetId, asset_code: last.asset_code, asset_reg: last.asset_reg, asset_ec: last.asset_ec,
      in_register: last.in_register,
      site: (last.site || '').trim().toUpperCase() || null,
      last_service: last.date, visits: list.length, gaps: k,
      expected_gap: gap, due_date: dueDate, days_idle: idle,
      overdue_ratio: r2(ratio),
      // Say where the number came from rather than presenting all rows as equal.
      basis: k >= 5 ? 'own history' : (k >= 1 ? 'part fleet default' : `fleet default ${prior} d`),
      meter: (last.meter || '').trim() || null,
      meter_broken: /^(mnw|m\.?n\.?r|nw|not\s*word|n|m\s*req)$/i.test(String(last.meter || '').trim()),
      ...kitFor(list),
    };

    row.active = active.has(assetId);
    row.on_register = onRegister.has(assetId);
    // The counts describe the REGISTER, so they add up to the fleet the yard knows. A machine
    // that has been serviced but taken off the register is still listed if it is due — it is
    // just counted separately, rather than making the four states exceed the fleet size.
    if (!row.on_register) offRegister++;

    // Four states, the way the yard reads it. Only a machine that is actually running can be
    // overdue — otherwise a parked machine accrues overdue days for ever and hides the rest.
    const count = (bucket, why) => {
      if (!row.on_register) return;
      state[bucket]++;
      if (why) unknownWhy[why]++;
    };
    if (!row.active) {
      row.state = 'unknown'; row.why = 'parked — nothing booked against it in 180 days';
      count('unknown', 'parked');
      parked.push(row);
    } else if (dueDate < asOf && ratio > MAX_OVERDUE_RATIO) {
      // Running, but so far past its rhythm that the record, not the service, is what is
      // missing. Counted and reachable, never mixed into the working list.
      row.state = 'unknown'; row.why = `no service recorded in ${idle} days`;
      count('unknown', 'no_recent_record');
      parked.push(row);
    } else if (dueDate < asOf) {
      row.state = 'overdue'; row.block = 'overdue'; count('overdue'); carryIn.push(row);
    } else if (dueDate < monthEnd) {
      row.state = 'due_soon'; row.block = 'due'; count('due_soon'); dueIn.push(row);
    } else {
      row.state = 'ok'; count('ok');
    }
  }

  // Machines on the register that have never been serviced cannot be placed at all.
  for (const a of registered) {
    if (seenAsset.has(a.id)) continue;
    state.unknown++; unknownWhy.never_serviced++;
  }

  // Most services first. Sorting most-overdue-first is the obvious choice and measurably the
  // wrong one — top-40 precision 7% against 27% for history depth, and 11% for a random pick.
  const bySort = (a, b) => b.visits - a.visits || (a.due_date < b.due_date ? -1 : 1);
  dueIn.sort(bySort); carryIn.sort(bySort);

  // ---- consolidate -------------------------------------------------------
  // The order covers exactly what the list shows: due soon + overdue. Parked machines are
  // counted and reachable, but they must not put filters on an order nobody will fit.
  const rows = includeLongOverdue ? [...dueIn, ...carryIn, ...parked] : [...dueIn, ...carryIn];
  if (includeLongOverdue) parked.sort(bySort);
  const { categories, parts, totals: orderTotals } = consolidate(rows, stock, prices);
  const totals = {
    due_in_month: dueIn.length, carry_in: carryIn.length, total: rows.length,
    parked: parked.length, ...orderTotals,
  };

  return {
    month: m, as_of: asOf, rule_version: RULE_VERSION,
    fleet_prior: prior, fleet_gaps: gaps,
    // `active` counts the REGISTER only — activeAssets() also sees machines that were
    // retired off it, and a count larger than the fleet reads as a bug.
    fleet: {
      registered: registered.length,
      active: registered.filter((a) => active.has(a.id)).length,
      ...state, unknown_why: unknownWhy, off_register_listed: offRegister,
    },
    totals, due: dueIn, carry: carryIn, parked: includeLongOverdue ? parked : [],
    categories, parts,
    warnings: [
      'The list is the machines that are OVERDUE or DUE SOON — the rest of the fleet is counted above but not listed. A machine only counts as overdue if the workshop has touched it in the last 180 days; one nobody has touched is parked, not overdue.',
      'This is a candidate list, not a forecast. Predicting a machine’s next service from its own history is about 70 days out on average — tick the machines you will actually service.',
      'Stock is the Filter Stock sheet only, and it is NOT reduced when a filter is fitted on a service. Between June and August 2026 services recorded 253 filter units while only 115 went out through Filter Stock. Check the shelf before ordering.',
      'The filter stock sheet covers 133 part numbers; services have used over a thousand. A part showing nothing on hand is usually one the sheet does not track.',
      'The suggested part number is the one the machine took last time. The CATEGORY is what this list is confident about — confirm the number at the machine.',
    ],
  };
}

/** Machines on the register that have never been serviced — no baseline, so no forecast. */
function neverServiced() {
  return all(`
    SELECT a.id, a.code, a.registration, a.ec_code, a.asset_class, a.brand, a.type
      FROM assets a
     WHERE a.in_register = 1
       AND NOT EXISTS (SELECT 1 FROM service_jobs s WHERE s.asset_id = a.id)
     ORDER BY a.code LIMIT 500`);
}

/**
 * The plan, with the Service Planner deciding WHICH machines are due.
 *
 * The planner measures what each machine has actually run — meter growth and fuel-derived
 * hours/km — which WorkshopOne cannot. Its OVERDUE / DUE_SOON rows become the list; this
 * system supplies the filters each of those machines takes, from its own service history.
 * If the planner cannot be reached the date-based plan is returned untouched, flagged so the
 * screen can say the numbers are WorkshopOne's estimate rather than the planner's answer.
 */
async function buildServicePlanLinked({ month, includeLongOverdue = false } = {}) {
  const local = buildServicePlan({ month, includeLongOverdue });
  const res = await planner.fetchServiceStatus({ asOf: local.as_of });
  if (!res.ok) {
    return { ...local, source: 'workshopone', planner_error: res.reason };
  }

  // Index this system's machines by E&C code — the identity both systems share.
  const byCode = new Map();
  for (const v of [...local.due, ...local.carry, ...local.parked]) {
    for (const k of [v.asset_ec, v.asset_code, v.asset_reg]) {
      const key = planner.codeKey(k);
      if (key && !byCode.has(key)) byCode.set(key, v);
    }
  }
  // And everything else with history, so a machine the planner calls due is still found even
  // when this system's own date rule had it filed as OK.
  const spare = new Map();
  for (const a of all(`SELECT id, code, registration, ec_code FROM assets`)) {
    for (const k of [a.ec_code, a.code, a.registration]) {
      const key = planner.codeKey(k);
      if (key && !spare.has(key)) spare.set(key, a);
    }
  }

  const due = []; const overdue = []; const unmatched = [];
  for (const m of res.machines) {
    if (m.state !== 'OVERDUE' && m.state !== 'DUE_SOON') continue;
    const row = byCode.get(m.code_key);
    if (row) {
      // Keep this system's filter knowledge; take the planner's verdict and its running figures.
      const merged = { ...row, state: m.state === 'OVERDUE' ? 'overdue' : 'due_soon', planner: m };
      (m.state === 'OVERDUE' ? overdue : due).push(merged);
      continue;
    }
    const a = spare.get(m.code_key);
    if (!a) { unmatched.push(m.code); continue; }
    // Known machine, but this system has no filter history for it — list it with the
    // categories blank rather than dropping a machine the planner says is due.
    const bare = {
      asset_id: a.id, asset_code: a.code, asset_reg: a.registration, asset_ec: a.ec_code,
      site: m.site, last_service: m.lastServiceDate, visits: 0, expected_gap: null,
      due_date: m.projectedDueDate, days_idle: null, basis: 'service planner',
      core: [], sometimes: [], filtered_visits: 0, unreadable: 0,
      state: m.state === 'OVERDUE' ? 'overdue' : 'due_soon', planner: m,
    };
    (m.state === 'OVERDUE' ? overdue : due).push(bare);
  }

  const bySort = (a, b) => (b.visits || 0) - (a.visits || 0)
    || String(a.due_date || '').localeCompare(String(b.due_date || ''));
  due.sort(bySort); overdue.sort(bySort);

  const listed = [...due, ...overdue];
  const { categories, parts, totals: orderTotals } = consolidate(listed, stockOnHand(), priceBook());
  return {
    ...local,
    source: 'service planner',
    planner_as_of: res.asOf, planner_generated_at: res.generated_at,
    fleet: {
      registered: res.counts.tracked ?? local.fleet.registered,
      tracked: res.counts.tracked ?? null,
      overdue: res.counts.overdue ?? overdue.length,
      due_soon: res.counts.dueSoon ?? due.length,
      ok: res.counts.ok ?? 0,
      unknown: res.counts.unknown ?? 0,
      unknown_why: local.fleet.unknown_why,
      off_register_listed: 0,
    },
    due, carry: overdue, parked: [],
    categories, parts,
    totals: { due_in_month: due.length, carry_in: overdue.length, total: listed.length, parked: 0, ...orderTotals },
    unmatched_codes: unmatched,
    warnings: [
      'The machines listed are the ones the Service Planner says are OVERDUE or DUE SOON — it measures what each machine has actually run (meter growth, and hours/km derived from its fuel), which this system does not hold.',
      ...local.warnings.slice(2),
      ...(unmatched.length ? [`${unmatched.length} machine(s) the planner lists are not in this system's asset register: ${unmatched.slice(0, 8).join(', ')}${unmatched.length > 8 ? '…' : ''}`] : []),
    ],
  };
}

module.exports = { buildServicePlan, buildServicePlanLinked, neverServiced, RULE_VERSION };
