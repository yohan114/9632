'use strict';

// Filter Price Book — every filter number ever used, with its price. Numbers
// missing a price are flagged; adding a price (or typing a brand-new number with
// one) upserts the book so it is remembered and auto-fills on the next service.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const { requireCap } = require('../lib/auth');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const servicePlan = require('../lib/service_plan');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

const clean = (v) => (v == null ? null : String(v).trim() || null);
const { normF } = require('../lib/filter_no');
const stores = require('../lib/stores');

// A service's live cost = priced filters (book × qty) + oils (line total) + labour + sundry.
const COST_SQL = `(
    (SELECT COALESCE(SUM(COALESCE(p.unit_price,0) * COALESCE(f.qty,1)),0)
       FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm WHERE f.service_id = s.id)
  + (SELECT COALESCE(SUM(COALESCE(o.price,0)),0) FROM service_oils o WHERE o.service_id = s.id)
  + COALESCE(s.labour_charge,0) + COALESCE(s.sundry_amount,0))`;

// Record a filter number's use on the book: bump the usage count, fill/refresh its
// price when one is supplied, and create the entry if the number is new (the auto-save).
// `countUse` is false when a service is being edited and this number was already on it —
// the price and category still refresh, but the usage tally must not climb every time
// someone corrects a date.
function bookTouch(filterNo, category, price, by, countUse = true) {
  const norm = normF(filterNo);
  if (!norm) return;
  const ex = get('SELECT id FROM filter_prices WHERE filter_no_norm = ?', norm);
  if (ex) {
    run(`UPDATE filter_prices SET uses = uses + ?, category = COALESCE(category, ?),
           unit_price = CASE WHEN ? IS NOT NULL AND ? > 0 THEN ? ELSE unit_price END,
           updated_by = COALESCE(?, updated_by), updated_at = datetime('now') WHERE id = ?`,
      countUse ? 1 : 0, clean(category), price, price, price, by, ex.id);
  } else {
    run(`INSERT INTO filter_prices (filter_no, filter_no_norm, category, unit_price, uses, source, updated_by)
         VALUES (?, ?, ?, ?, ?, 'service', ?)`, clean(filterNo), norm, clean(category), (price && price > 0) ? price : null, countUse ? 1 : 0, by);
  }
}

// ---- reference lists that drive the paper service form --------------------
router.get('/reference', asyncHandler((_req, res) => {
  res.json({
    oils: all('SELECT name, unit FROM oil_list ORDER BY sort_order, id'),
    filterCategories: all('SELECT name FROM filter_category_list ORDER BY sort_order, id').map((r) => r.name),
    oilTypes: all('SELECT code, unit_price FROM oil_type_prices ORDER BY code'),
    labourRate: 20, sundryRate: 5,
  });
}));

// ---- oil consumption → Lubricants (stock_ledger) issue --------------------
function currentBalance(pid) {
  const r = get('SELECT balance_after FROM stock_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1', pid);
  return r ? r.balance_after : 0;
}
// Best-effort: match a service oil (type first, then name) to a WorkshopOne oil
// product. Products here mostly key on name ("HD-68 Hy/Oil Caltex"), not code.
function resolveProduct(oilName, oilType) {
  const N = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cands = [oilType, oilName].filter(Boolean).map(N).filter((x) => x.length >= 3);
  const prods = all('SELECT id, code, name FROM products');
  for (const cand of cands) {
    for (const p of prods) {
      const pc = N(p.code), pn = N(p.name);
      if (pc && pc.length >= 3 && cand.includes(pc)) return p.id;         // candidate contains the product code
      if (pn && pn.length >= 3 && (pn.includes(cand) || cand.includes(pn))) return p.id; // name ⊇ candidate (or vice-versa)
    }
  }
  return null;
}
// Post an oil issue tied to the service. Returns true if a product resolved.
// Every stock movement this service owns. The service id is written into the note in one
// fixed shape so an edit can find its own movements later; the " · " (or end of string)
// after the number is what stops "#165" matching "#1654".
const oilNote = (serviceId, oilName) => 'Service record #' + serviceId + (oilName ? ' · ' + oilName : '');
// Matches the bare note and every "#N <anything>" variant. The space after the number is what
// keeps "#165" from swallowing "#1654" — so any suffix is safe as long as a space starts it.
const OIL_NOTE_LIKE = (serviceId) => ['Service record #' + serviceId, 'Service record #' + serviceId + ' %'];

// Stage 4: a service's oil comes out of the service's own store (service_jobs.store_id).
const serviceStore = (serviceId) => (get('SELECT store_id FROM service_jobs WHERE id = ?', serviceId) || {}).store_id || null;

// ---- stores plan, Part 3: a service takes its filters and oil from the store's stock ----------
const stock = require('../lib/stock');
const stockRule = require('../lib/stock_rule');

/** The shelf a filter number sits on: its catalogue number, as receipts and services file it. */
const filterStockKey = (no) => ((stock.filterParts(no)[0] || {}).key || stock.itemKey('filter', no));

/** The shelf a lubricant product sits on (the rebuild files every spelling under its product). */
const productKey = (p) => stock.itemKey('oil', p.name, p.code || p.name);

/**
 * Once the store's rule has started for lubricants, a service's oil must be one the oil book knows —
 * otherwise nothing would come off the shelf for it, and the stock would never show it went.
 */
function mustBeStockOil(storeId, oilName, oilType, liters) {
  if (!(liters > 0) || !stockRule.since(storeId, 'oil')) return;
  if (!resolveProduct(oilName, oilType)) {
    const e = new Error(`${oilName}${oilType ? ' (' + oilType + ')' : ''} is not in the oil book, so it cannot come out of stock. Choose the oil type from the list.`);
    e.status = 409; throw e;
  }
}

/** Every number that is the same filter as `no` (the catalogue and its cross-references). */
function equivalentNumbers(no) {
  const cid = catalogueIdForNo(no);
  if (!cid) return [];
  const cat = get('SELECT oem_pn, hifi_pn FROM filter_catalogue WHERE id = ?', cid) || {};
  const out = new Map();
  for (const n of [cat.oem_pn, cat.hifi_pn, ...xrefsFor(cid).map((x) => x.part_number)]) {
    const k = normF(n);
    if (k && k !== normF(no) && !out.has(k)) out.set(k, n);
  }
  return [...out.values()];
}

/** The equivalents of `no` that one store holds, most first. */
function equivalentsInStock(no, storeId) {
  if (!storeId) return [];
  return equivalentNumbers(no)
    .map((n) => ({ filter_no: n, in_stock: stock.balanceOf('filter', filterStockKey(n), storeId),
      unit_price: (get('SELECT unit_price FROM filter_prices WHERE filter_no_norm = ?', normF(n)) || {}).unit_price ?? null }))
    .filter((e) => e.in_stock > 0)
    .sort((a, b) => b.in_stock - a.in_stock);
}

/** The line a refusal adds for a filter that is short: what is on the shelf instead. */
function equivalentsHint(short) {
  const bits = short.filter((x) => x.section === 'filter').map((x) => {
    const eq = equivalentsInStock(x.name, x.store_id);
    return eq.length ? `${x.name}: ${eq.slice(0, 3).map((e) => `${e.filter_no} (${e.in_stock})`).join(', ')}` : null;
  }).filter(Boolean);
  return bits.length ? `Equivalents in stock — ${bits.join('; ')}.` : null;
}

function postOilIssue(oilName, oilType, liters, unitPrice, assetId, date, serviceId) {
  const pid = resolveProduct(oilName, oilType);
  if (!pid || !(liters > 0)) return false;
  const prev = currentBalance(pid);
  // consumer_type='service' marks this as a stock-only movement: the COST is owned
  // by the service record, so every oil-cost report excludes these to avoid double-counting.
  return run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, consumer, consumer_type, job_id, txn_date, note, store_id)
       VALUES (?, 'issue', ?, ?, ?, ?, 'Service', 'service', NULL, ?, ?, ?)`,
    pid, -Math.abs(liters), prev - Math.abs(liters), unitPrice || null, assetId || null,
    date, oilNote(serviceId, oilName), serviceStore(serviceId)).lastInsertRowid;
}

// What this service has actually taken off the shelf so far, per product, read from the
// ledger rather than re-derived from its oil lines — the ledger is the record, and reading it
// back means repeated edits settle against reality instead of compounding.
function oilIssuedSoFar(serviceId) {
  const [exact, like] = OIL_NOTE_LIKE(serviceId);
  const m = new Map();
  for (const r of all(
    `SELECT product_id, SUM(-qty) AS liters FROM stock_ledger
      WHERE consumer_type = 'service' AND (note = ? OR note LIKE ?)
      GROUP BY product_id`, exact, like)) m.set(r.product_id, r.liters);
  return m;
}

// Correct the shelf by the difference, never by rewriting history: balances here are a
// running balance_after carried on each row, so voiding or deleting an old movement would
// leave every later balance untouched and the stock silently wrong. A service that now uses
// more oil issues the extra; one that uses less gives the difference back.
function postOilDelta(pid, deltaLiters, unitPrice, assetId, date, serviceId, oilName) {
  if (!pid || !deltaLiters) return false;
  const prev = currentBalance(pid);
  const qty = -deltaLiters;                       // more used → negative movement
  return run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, consumer, consumer_type, job_id, txn_date, note, store_id)
       VALUES (?, ?, ?, ?, ?, ?, 'Service', 'service', NULL, ?, ?, ?)`,
    pid, deltaLiters > 0 ? 'issue' : 'adjustment', qty, prev + qty, unitPrice || null,
    assetId || null, date,
    oilNote(serviceId, oilName) + (deltaLiters > 0 ? ' (edited — extra)' : ' (edited — returned)'), serviceStore(serviceId)).lastInsertRowid;
}

// ---- stats ----------------------------------------------------------------
router.get('/stats', asyncHandler((_req, res) => {
  const r = get(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN unit_price > 0 THEN 1 ELSE 0 END), 0) priced FROM filter_prices`);
  res.json({ total: r.total, priced: r.priced, missing: r.total - r.priced });
}));

// ---- price book -----------------------------------------------------------
router.get('/prices', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.q) { const like = '%' + String(req.query.q).trim() + '%'; clauses.push('(filter_no LIKE ? OR category LIKE ?)'); params.push(like, like); }
  if (req.query.missing === '1') clauses.push('(unit_price IS NULL OR unit_price = 0)');
  if (req.query.category) { clauses.push('category = ?'); params.push(req.query.category); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT id, filter_no, category, unit_price, uses, source, notes, updated_by, updated_at,
            (unit_price IS NOT NULL AND unit_price > 0) AS has_price
       FROM filter_prices ${where}
      ORDER BY has_price ASC, uses DESC, filter_no LIMIT ${toInt(req.query.limit, 500)}`,
    ...params
  ));
}));

// Categories (for the add form + filter dropdown).
router.get('/categories', asyncHandler((_req, res) =>
  res.json(all(`SELECT category, COUNT(*) n FROM filter_prices WHERE category IS NOT NULL AND TRIM(category) <> '' GROUP BY category ORDER BY n DESC`).map((r) => r.category))));

// Look up a price by filter number (auto-fill).
router.get('/prices/lookup', asyncHandler((req, res) => {
  const norm = normF(req.query.no);
  if (!norm) return res.json({ found: false });
  const r = get('SELECT filter_no, category, unit_price FROM filter_prices WHERE filter_no_norm = ?', norm);
  res.json(r ? { found: true, filter_no: r.filter_no, category: r.category, unit_price: r.unit_price } : { found: false });
}));

// Type-ahead over every filter number we know: the price book, the OEM/HIFI catalogue and
// the cross-reference table. Ranked so the useful ones come first — numbers that start with
// what was typed, then the priced ones, then by how often they have been used.
router.get('/search', asyncHandler((req, res) => {
  res.json(searchFilters(req.query.q, req.query.category, toInt(req.query.limit, 12)));
}));

function searchFilters(q, category, lim) {
  const raw = String(q || '').trim();
  const norm = normF(raw);
  const cat = String(category || '').trim();
  // Empty box + a category (clicking into a row) lists that category's filters; otherwise
  // search from the very first character typed.
  if (!norm && !cat) return [];
  const like = norm ? '%' + norm + '%' : '%';
  const pre = norm ? norm + '%' : '%';
  const limit = Math.min(lim || 12, 40);
  const catKey = cat.toLowerCase();

  const rows = all(
    `SELECT * FROM (
       SELECT p.filter_no AS filter_no, p.filter_no_norm AS norm, p.category AS category,
              p.unit_price AS unit_price, COALESCE(p.uses,0) AS uses, 'price book' AS src
         FROM filter_prices p WHERE p.filter_no_norm LIKE ?
       UNION ALL
       SELECT c.oem_pn, c.oem_pn_norm, c.category,
              (SELECT unit_price FROM filter_prices q WHERE q.filter_no_norm = c.oem_pn_norm),
              COALESCE(c.uses,0), 'catalogue (OEM)'
         FROM filter_catalogue c WHERE c.oem_pn_norm LIKE ? AND COALESCE(c.oem_pn,'') <> ''
       UNION ALL
       SELECT c.hifi_pn, c.hifi_pn_norm, c.category,
              (SELECT unit_price FROM filter_prices q WHERE q.filter_no_norm = c.hifi_pn_norm),
              COALESCE(c.uses,0), 'catalogue (HIFI)'
         FROM filter_catalogue c WHERE c.hifi_pn_norm LIKE ? AND COALESCE(c.hifi_pn,'') <> ''
       UNION ALL
       SELECT x.part_number, x.part_number_norm, (SELECT category FROM filter_catalogue fc WHERE fc.id = x.catalogue_id),
              (SELECT unit_price FROM filter_prices q WHERE q.filter_no_norm = x.part_number_norm),
              0, 'cross-ref' || COALESCE(' ' || x.brand, '')
         FROM filter_xrefs x WHERE x.part_number_norm LIKE ?
     )
     ORDER BY (CASE WHEN ? <> '' AND LOWER(COALESCE(category,'')) = ? THEN 0 ELSE 1 END),
              (CASE WHEN norm LIKE ? THEN 0 ELSE 1 END),
              (CASE WHEN unit_price IS NOT NULL AND unit_price > 0 THEN 0 ELSE 1 END),
              uses DESC, length(norm), norm
     LIMIT 400`, like, like, like, like, catKey, catKey, pre);

  // One entry per distinct filter number; keep the best-ranked source, note the rest.
  const seen = new Map();
  for (const r of rows) {
    if (!r.norm) continue;
    const hit = seen.get(r.norm);
    if (!hit) seen.set(r.norm, { filter_no: r.filter_no, norm: r.norm, category: r.category || null, unit_price: r.unit_price, uses: r.uses, src: r.src });
    else {
      if (hit.unit_price == null && r.unit_price != null) hit.unit_price = r.unit_price;
      if (!hit.category && r.category) hit.category = r.category;
      if (r.uses > hit.uses) hit.uses = r.uses;
    }
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

// ---- stores plan, Part 3: what the service form offers from stock ------------------------------
// The store a service's filters and oil come out of: the service's own (an edit), else its job
// card's workshop's, else yours — as the save will decide.
function serviceStoreFor(req) {
  const sid = toInt(req.query.service_id);
  if (sid) return serviceStore(sid);
  const jobNo = clean(req.query.job_no);
  const j = jobNo ? get('SELECT id FROM job_cards WHERE job_no = ? ORDER BY id DESC LIMIT 1', jobNo) : null;
  return stores.forEntry(req.user, j ? j.id : null, req.query.date);
}
// What a service already holds of each shelf (net): an edit may keep it without the shelf having it.
function takenBy(serviceId) {
  const m = new Map();
  if (!serviceId) return m;
  const [exact, like] = OIL_NOTE_LIKE(serviceId);
  for (const r of all(`SELECT section, item_key,
                              -SUM(CASE WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END) AS q
                         FROM stock_moves
                        WHERE counts = 1 AND ((source_table = 'service_filters' AND source_id IN (SELECT id FROM service_filters WHERE service_id = ?))
                           OR (source_table = 'stock_ledger' AND source_id IN (SELECT id FROM stock_ledger
                                 WHERE consumer_type = 'service' AND (note = ? OR note LIKE ?))))
                        GROUP BY section, item_key`, serviceId, exact, like)) m.set(r.section + '|' + r.item_key, r.q);
  return m;
}
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const storeInfo = (id) => (id ? { id, name: stores.label(id), multi: stores.isMulti() } : null);

// The store, whether its rule has started for oil and filters, and the litres of each lubricant
// the oil rows may resolve to — by oil type first, then by name, exactly as the save resolves it.
router.get('/stock-context', asyncHandler((req, res) => {
  const store = serviceStoreFor(req);
  const taken = takenBy(toInt(req.query.service_id));
  const productOf = (id) => {
    if (!id) return null;
    const p = get('SELECT id, code, name, unit FROM products WHERE id = ?', id);
    const k = productKey(p);
    return { id: p.id, name: p.name, unit: p.unit || 'L', in_stock: n2(stock.balanceOf('oil', k, store) + (taken.get('oil|' + k) || 0)) };
  };
  const types = {};
  for (const t of all('SELECT code FROM oil_type_prices')) types[t.code] = productOf(resolveProduct(null, t.code));
  const names = {};
  for (const o of all('SELECT name FROM oil_list')) names[o.name] = productOf(resolveProduct(o.name, null));
  res.json({ store: storeInfo(store), rule: { oil: stockRule.since(store, 'oil'), filter: stockRule.since(store, 'filter') }, types, names });
}));

// Filters for a service row: the numbers that match, what the store holds of each, and — when the
// number asked for is not on the shelf — its equivalents that are (ST-D15).
router.get('/stock-search', asyncHandler((req, res) => {
  const store = serviceStoreFor(req);
  const taken = takenBy(toInt(req.query.service_id));
  const avail = (no) => { const k = filterStockKey(no); return n2(stock.balanceOf('filter', k, store) + (taken.get('filter|' + k) || 0)); };
  const items = searchFilters(req.query.q, req.query.category, toInt(req.query.limit, 12)).map((it) => ({ ...it, in_stock: avail(it.filter_no) }));
  const q = String(req.query.q || '').trim();
  const exact = normF(q) ? items.find((i) => i.norm === normF(q)) : null;
  const equivalents = normF(q) && !(exact && exact.in_stock > 0) ? equivalentsInStock(q, store) : [];
  res.json({ store: storeInfo(store), rule: stockRule.since(store, 'filter'), items, equivalents });
}));

// Add / update a filter price. Typing a NEW number here creates it (the learning
// catalogue); an existing number updates its price. This is the auto-save.
// Sets the price of a filter, new or already listed: a change, so it needs edit (a POST alone asks add).
router.post('/prices', require('../lib/permissions').requireModule('filters', 'edit'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['filter_no']);
  const fn = clean(b.filter_no);
  const norm = normF(fn);
  if (!norm) return res.status(400).json({ error: 'Enter a filter number' });
  const price = b.unit_price === '' || b.unit_price == null ? null : toNum(b.unit_price);
  if (price != null && price < 0) return res.status(400).json({ error: 'Price cannot be negative' });
  const by = req.user ? (req.user.fullName || req.user.username) : null;
  const existing = get('SELECT id, uses FROM filter_prices WHERE filter_no_norm = ?', norm);
  if (existing) {
    run(`UPDATE filter_prices SET unit_price = ?, category = COALESCE(?, category), source = 'manual', updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
      price, clean(b.category), by, existing.id);
    audit.record({ userId: req.user && req.user.id, entity: 'filter_price', entityId: existing.id, action: 'update', after: { filter_no: fn, unit_price: price } });
    return res.json(get('SELECT *, (unit_price IS NOT NULL AND unit_price > 0) AS has_price FROM filter_prices WHERE id = ?', existing.id));
  }
  const info = run(`INSERT INTO filter_prices (filter_no, filter_no_norm, category, unit_price, uses, source, updated_by) VALUES (?, ?, ?, ?, 0, 'manual', ?)`,
    fn, norm, clean(b.category), price, by);
  audit.record({ userId: req.user && req.user.id, entity: 'filter_price', entityId: info.lastInsertRowid, action: 'create', after: { filter_no: fn, unit_price: price } });
  res.status(201).json(get('SELECT *, (unit_price IS NOT NULL AND unit_price > 0) AS has_price FROM filter_prices WHERE id = ?', info.lastInsertRowid));
}));

// ---- filter cross-references (VIC / Sakura / HIFI / … for the SL market) ----
// All cross-ref part numbers for a catalogue filter, priced from the book, with
// the brands you buy (VIC, Sakura) sorted first.
function xrefsFor(catalogueId) {
  return all(
    `SELECT x.brand, x.part_number, x.part_number_norm, x.ref_type, x.source, x.note,
            (SELECT unit_price FROM filter_prices p WHERE p.filter_no_norm = x.part_number_norm) AS price
       FROM filter_xrefs x WHERE x.catalogue_id = ?
      ORDER BY CASE UPPER(COALESCE(x.brand,'')) WHEN 'VIC' THEN 1 WHEN 'SAKURA' THEN 2 WHEN 'HIFI' THEN 3
                 WHEN 'FLEETGUARD' THEN 4 WHEN 'DONALDSON' THEN 5 WHEN 'BALDWIN' THEN 6 ELSE 9 END,
               x.ref_type, x.part_number`, catalogueId);
}
function catalogueIdForNo(no) {
  const norm = normF(no);
  if (!norm) return null;
  const x = get('SELECT catalogue_id FROM filter_xrefs WHERE part_number_norm = ? AND catalogue_id IS NOT NULL LIMIT 1', norm);
  if (x) return x.catalogue_id;
  const c = get('SELECT id FROM filter_catalogue WHERE oem_pn_norm = ? OR hifi_pn_norm = ? LIMIT 1', norm, norm);
  return c ? c.id : null;
}

router.get('/xref/brands', asyncHandler((_req, res) =>
  res.json(all(`SELECT brand, COUNT(*) n FROM filter_xrefs WHERE brand IS NOT NULL AND TRIM(brand)<>'' GROUP BY brand ORDER BY n DESC`))));

// Look up every equivalent for a part number.
router.get('/xref/lookup', asyncHandler((req, res) => {
  const no = String(req.query.no || '').trim();
  const cid = catalogueIdForNo(no);
  if (!cid) return res.json({ found: false, query: no });
  const cat = get('SELECT * FROM filter_catalogue WHERE id = ?', cid);
  const crossRefs = xrefsFor(cid);
  res.json({ found: true, query: no, catalogue: cat, crossRefs });
}));

// Every filter this vehicle actually uses (from its service history) + how many
// cross-ref brands each one has.
router.get('/xref/vehicle/:assetId', asyncHandler((req, res) => {
  const assetId = toInt(req.params.assetId);
  const asset = get('SELECT id, code, registration, ec_code FROM assets WHERE id = ?', assetId);
  const used = all(
    `SELECT sf.filter_no, sf.filter_no_norm, sf.category, COUNT(*) uses
       FROM service_filters sf JOIN service_jobs s ON s.id = sf.service_id
      WHERE s.asset_id = ? AND sf.filter_no IS NOT NULL AND TRIM(sf.filter_no) <> ''
      GROUP BY sf.filter_no_norm ORDER BY uses DESC`, assetId);
  const filters = used.map((u) => {
    const cid = catalogueIdForNo(u.filter_no);
    const refs = cid ? xrefsFor(cid) : [];
    const brands = [...new Set(refs.map((r) => r.brand).filter(Boolean))];
    return { filter_no: u.filter_no, category: u.category, uses: u.uses, catalogue_id: cid, brands, xref_count: refs.length };
  });
  res.json({ asset, filters });
}));

router.get('/xref/catalogue/:id', asyncHandler((req, res) => {
  const cid = toInt(req.params.id);
  const cat = get('SELECT * FROM filter_catalogue WHERE id = ?', cid);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  res.json({ catalogue: cat, crossRefs: xrefsFor(cid) });
}));

// Add a cross-reference you've confirmed at a supplier (e.g. a VIC / Sakura no.).
router.post('/xref', asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['part_number']);
  let cid = toInt(b.catalogue_id);
  if (!cid && b.match_no) cid = catalogueIdForNo(b.match_no);
  if (!cid) return res.status(400).json({ error: 'Unknown filter — provide catalogue_id or a known part number to match' });
  const pn = clean(b.part_number);
  run(`INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type, source, note)
       VALUES (?, ?, ?, ?, 'cross', 'manual', ?)`, cid, clean(b.brand), pn, normF(pn), clean(b.note));
  audit.record({ userId: req.user && req.user.id, entity: 'filter_xref', action: 'create', after: { catalogue_id: cid, brand: b.brand, part_number: pn } });
  res.status(201).json({ catalogue_id: cid, crossRefs: xrefsFor(cid) });
}));

// ---- service records ------------------------------------------------------
router.get('/services', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  // A machine answers to several names — the code we file it under, its registration, its E&C
  // number, and whatever the paperwork called it that day. Matching only the free-text label
  // and the code meant the registration found FEWER services than the E&C number for the very
  // same vehicle (ZA-2964 found 5 of its 7; LN-8278 found 13 of 16), because 145 services
  // carry a label that does not contain the registration. Resolve the ASSET and every one of
  // its services comes back, whichever name was typed — the same rule the job-card search uses.
  if (req.query.q && String(req.query.q).trim()) {
    const raw = String(req.query.q).trim();
    // % and _ are LIKE's own wildcards. Left unescaped, typing a single "%" matched every
    // service — the search appeared to ignore what was typed and list the lot.
    const esc = raw.replace(/[\\%_]/g, (ch) => '\\' + ch);
    const like = '%' + esc + '%';
    const normq = raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
    const L = (col) => `${col} LIKE ? ESCAPE '\\'`;
    const ors = [L('s.vehicle_label'), L('a.code'), L('a.registration'), L('a.ec_code'),
      L('s.site_location'), L('s.service_type'), L('s.job_no')];
    params.push(like, like, like, like, like, like, like);
    if (normq) {
      const normLike = '%' + normq + '%';
      // "LO 5981", "lo-5981" and "LO5981" are one vehicle — and that has to hold for the
      // registration and the E&C number too, not just the code we happen to file it under.
      const bare = (col) => `REPLACE(REPLACE(REPLACE(UPPER(COALESCE(${col},'')),'-',''),' ',''),'/','')`;
      ors.push(L('a.code_norm'));
      params.push(normLike);
      for (const col of ['s.vehicle_label', 'a.registration', 'a.ec_code', 'a.code']) {
        ors.push(L(bare(col)));
        params.push(normLike);
      }
      ors.push(`s.asset_id IN (SELECT asset_id FROM asset_aliases WHERE asset_id IS NOT NULL
                                AND (${L('raw_text')} OR ${L('raw_norm')}))`);
      params.push(like, normLike);
    }
    clauses.push('(' + ors.join(' OR ') + ')');
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT s.id, s.vehicle_label, s.service_date, s.service_type, s.site_location, s.grand_total,
            s.labour_charge, s.outside_estimate, s.meter_reading, s.next_service_meter, s.job_no,
            s.repair_details, s.upkeeping,
            a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            (SELECT COUNT(*) FROM service_filters f WHERE f.service_id = s.id) AS filter_count,
            -- Only NUMBERED lines can ever be priced. A blank-number line is a cleaned
            -- filter logged against a category, so it must not count as "needs a price".
            (SELECT COUNT(*) FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm
               WHERE f.service_id = s.id AND COALESCE(p.unit_price, 0) = 0
                 AND f.filter_no IS NOT NULL AND TRIM(f.filter_no) <> '') AS missing_count,
            ${COST_SQL} AS computed_cost
       FROM service_jobs s LEFT JOIN assets a ON a.id = s.asset_id
       ${where} ORDER BY s.service_date DESC, s.id DESC LIMIT ${toInt(req.query.limit, 300)}`,
    ...params
  ));
}));

// Read a service payload the same way whichever verb sent it, so a record cannot come out
// with different totals depending on whether it was created or edited.
function readServicePayload(b, user) {
  let assetId = toInt(b.asset_id);
  let vehicleLabel = clean(b.vehicle_label);
  if (!assetId && b.asset) {
    const r = aliases.resolveAsset(b.asset, { source: 'service' });
    assetId = r.assetId;
    if (!vehicleLabel) vehicleLabel = clean(b.asset);
  }
  const filters = (Array.isArray(b.filters) ? b.filters : []).filter((f) => clean(f.filter_no));
  const oils = (Array.isArray(b.oils) ? b.oils : []).filter((o) => clean(o.oil_name) && (toNum(o.qty, 0) > 0 || toNum(o.price, 0) > 0));
  const parts = (Array.isArray(b.parts) ? b.parts : []).filter((p) => clean(p.description));
  const labourRate = toNum(b.labour_rate, 20);
  const sundryRate = toNum(b.sundry_rate, 5);
  // Parts subtotal = filter lines (unit × qty) + oil lines (line total) + other costs.
  const filterSub = filters.reduce((s, f) => s + toNum(f.price, 0) * toNum(f.qty, 1), 0);
  const oilSub = oils.reduce((s, o) => s + toNum(o.price, 0), 0);
  const partSub = parts.reduce((s, p) => s + (toNum(p.amount, 0) || toNum(p.rate, 0) * toNum(p.qty, 0)), 0);
  const partsSubtotal = Math.round((filterSub + oilSub + partSub) * 100) / 100;
  const labourCharge = Math.round(partsSubtotal * labourRate) / 100;
  const sundryAmount = Math.round(partsSubtotal * sundryRate) / 100;
  return {
    assetId: assetId || null, vehicleLabel, filters, oils, parts, labourRate, sundryRate,
    partsSubtotal, labourCharge, sundryAmount,
    grandTotal: Math.round((partsSubtotal + labourCharge + sundryAmount) * 100) / 100,
    by: user ? (user.fullName || user.username) : null,
    date: clean(b.service_date) || new Date().toISOString().slice(0, 10),
  };
}

// Write a service's line tables. Shared by create and edit; on edit the old lines have
// already been cleared, so this always starts from nothing.
function writeServiceLines(sid, p, opts = {}) {
  const alreadyCounted = opts.alreadyCounted || new Set();
  const ids = [];
  for (const f of p.filters) {
    const fn = clean(f.filter_no);
    const price = f.price === '' || f.price == null ? null : toNum(f.price);
    // An equivalent fitted in place of the vehicle's own number keeps both (ST-D15).
    const reqNo = clean(f.required_no) && normF(f.required_no) !== normF(fn) ? clean(f.required_no) : null;
    ids.push(run(`INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price, required_no, required_no_norm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, sid, fn, normF(fn), clean(f.category), clean(f.xe) || clean(f.action_type), toNum(f.qty, 1), price || 0,
    reqNo, reqNo ? normF(reqNo) : null).lastInsertRowid);
    // Editing a service must not keep re-counting the same filter number as a fresh use.
    bookTouch(fn, f.category, price, p.by, !alreadyCounted.has(normF(fn)));
  }
  for (const p2 of p.parts) {
    const amount = toNum(p2.amount, 0) || toNum(p2.rate, 0) * toNum(p2.qty, 0);
    run(`INSERT INTO service_parts (service_id, description, unit, rate, qty, amount) VALUES (?, ?, ?, ?, ?, ?)`,
      sid, clean(p2.description), clean(p2.unit), toNum(p2.rate, 0), toNum(p2.qty, 0), Math.round(amount * 100) / 100);
  }
  return ids;
}

router.post('/services', asyncHandler((req, res) => {
  const b = req.body;
  const p = readServicePayload(b, req.user);
  const { assetId, vehicleLabel, oils, labourRate, sundryRate,
    partsSubtotal, labourCharge, sundryAmount, grandTotal, date } = p;

  const out = tx(() => {
    const info = run(
      `INSERT INTO service_jobs (vehicle_label, asset_id, service_date, job_no, reg_id, model_no, meter_reading, next_service_meter,
                                 service_type, site_location, repair_details, upkeeping, labour_rate, sundry_rate,
                                 parts_subtotal, labour_charge, sundry_amount, grand_total, store_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      vehicleLabel, assetId || null, date, clean(b.job_no), clean(b.reg_id), clean(b.model_no),
      clean(b.meter_reading), clean(b.next_service_meter), clean(b.service_type), clean(b.site_location),
      clean(b.repair_details), clean(b.upkeeping), labourRate, sundryRate,
      partsSubtotal, labourCharge, sundryAmount, grandTotal,
      // Stage 4: the store its filters and oil come out of — its job card's workshop's, else yours.
      stores.forEntry(req.user, (get('SELECT id FROM job_cards WHERE job_no = ? ORDER BY id DESC LIMIT 1', clean(b.job_no)) || {}).id, date)
    );
    const sid = info.lastInsertRowid;
    const store = serviceStore(sid);
    let oilIssues = 0;
    const filterLines = writeServiceLines(sid, p);
    const ledger = [];
    for (const o of oils) {
      const on = clean(o.oil_name);
      const liters = toNum(o.qty, 0);
      run(`INSERT INTO service_oils (service_id, oil_name, oil_type, action_type, qty, price)
           VALUES (?, ?, ?, ?, ?, ?)`, sid, on, clean(o.oil_type), clean(o.cv) || clean(o.action_type), liters, toNum(o.price, 0));
      mustBeStockOil(store, on, clean(o.oil_type), liters);
      // Issue the lubricant against this service (reduces oil stock, traceable to the service id).
      const unit = liters > 0 ? toNum(o.price, 0) / liters : null;
      const lid = postOilIssue(on, clean(o.oil_type), liters, unit, assetId, date, sid);
      if (lid) { oilIssues++; ledger.push(lid); }
    }
    // Stores plan, Part 3: the filters and the oil come off the store's shelf now — and, once the
    // store's rule has started, only what is on it.
    stockRule.check(stock.sync({ service_filters: filterLines, stock_ledger: ledger }), { hint: equivalentsHint });
    return { sid, oilIssues };
  });
  audit.record({ userId: req.user && req.user.id, entity: 'service_job', entityId: out.sid, action: 'create', after: { asset_id: assetId, grand_total: grandTotal } });
  res.status(201).json({ service: get('SELECT * FROM service_jobs WHERE id = ?', out.sid), oil_issues: out.oilIssues });
}));

// Edit a service that has already been recorded. The header, the oil / filter / other-cost
// lines and the totals are all replaced from the form, exactly as if it were being entered
// again — but the oil already taken off the shelf is settled by difference rather than
// re-issued, so correcting a typo does not consume the stock twice.
router.put('/services/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM service_jobs WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Service not found' });

  const b = req.body;
  const p = readServicePayload(b, req.user);
  // A vehicle is required to record a service, and an edit must not be able to strip it.
  const assetId = p.assetId || before.asset_id || null;
  const vehicleLabel = p.vehicleLabel || before.vehicle_label || null;

  // Filter numbers this service already used — re-saving them must not inflate the book's
  // usage count, but a number added by the edit is a genuine new use.
  const alreadyCounted = new Set(all('SELECT filter_no_norm FROM service_filters WHERE service_id = ?', id)
    .map((r) => r.filter_no_norm).filter(Boolean));

  const out = tx(() => {
    const issued = oilIssuedSoFar(id);          // by product, from the ledger itself

    run(`UPDATE service_jobs SET vehicle_label = ?, asset_id = ?, service_date = ?, job_no = ?, reg_id = ?,
            model_no = ?, meter_reading = ?, next_service_meter = ?, service_type = ?, site_location = ?,
            repair_details = ?, upkeeping = ?, labour_rate = ?, sundry_rate = ?,
            parts_subtotal = ?, labour_charge = ?, sundry_amount = ?, grand_total = ?
          WHERE id = ?`,
      vehicleLabel, assetId, p.date, clean(b.job_no), clean(b.reg_id), clean(b.model_no),
      clean(b.meter_reading), clean(b.next_service_meter), clean(b.service_type), clean(b.site_location),
      clean(b.repair_details), clean(b.upkeeping), p.labourRate, p.sundryRate,
      p.partsSubtotal, p.labourCharge, p.sundryAmount, p.grandTotal, id);

    run('DELETE FROM service_filters WHERE service_id = ?', id);
    run('DELETE FROM service_oils WHERE service_id = ?', id);
    run('DELETE FROM service_parts WHERE service_id = ?', id);
    const filterLines = writeServiceLines(id, p, { alreadyCounted });
    const store = before.store_id || serviceStore(id);
    const ledger = [];

    // What the service says it uses now, per product.
    const wanted = new Map();
    const label = new Map();
    for (const o of p.oils) {
      const on = clean(o.oil_name);
      const liters = toNum(o.qty, 0);
      run(`INSERT INTO service_oils (service_id, oil_name, oil_type, action_type, qty, price)
           VALUES (?, ?, ?, ?, ?, ?)`, id, on, clean(o.oil_type), clean(o.cv) || clean(o.action_type), liters, toNum(o.price, 0));
      mustBeStockOil(store, on, clean(o.oil_type), liters);
      const pid = resolveProduct(on, clean(o.oil_type));
      if (!pid || !(liters > 0)) continue;
      wanted.set(pid, (wanted.get(pid) || 0) + liters);
      if (!label.has(pid)) label.set(pid, { name: on, unit: liters > 0 ? toNum(o.price, 0) / liters : null });
    }

    let moves = 0;
    for (const pid of new Set([...issued.keys(), ...wanted.keys()])) {
      const delta = Math.round(((wanted.get(pid) || 0) - (issued.get(pid) || 0)) * 1000) / 1000;
      if (!delta) continue;
      // An oil taken off the service entirely has no line left to name it, so the note falls
      // back to the product — a give-back that said only "Service record #12" would be far
      // harder to read in the lubricants ledger.
      const l = label.get(pid) || { name: (get('SELECT name FROM products WHERE id = ?', pid) || {}).name || null, unit: null };
      const lid = postOilDelta(pid, delta, l.unit, assetId, p.date, id, l.name);
      if (lid) { moves++; ledger.push(lid); }
    }
    // Only the difference moves (ST-D17): the old filter lines leave the shelf's record and the new
    // ones go on, so a service saved again unchanged takes nothing and is never refused.
    stockRule.check(stock.sync({ service_filters: filterLines, stock_ledger: ledger }), { hint: equivalentsHint });
    return { moves };
  });

  audit.record({
    userId: req.user && req.user.id, entity: 'service_job', entityId: id, action: 'update',
    before: { asset_id: before.asset_id, service_date: before.service_date, grand_total: before.grand_total },
    after: { asset_id: assetId, service_date: p.date, grand_total: p.grandTotal },
  });
  res.json({ service: get('SELECT * FROM service_jobs WHERE id = ?', id), stock_moves: out.moves });
}));

// ---- service & filter plan -------------------------------------------------
// Which machines are candidates for service in a month, and the filters each would need.
// Read-only; the maths and its limits live in src/lib/service_plan.js.
router.get('/service-plan', asyncHandler(async (req, res) => {
  const opts = { month: req.query.month, includeLongOverdue: req.query.include_long_overdue === '1' };
  // The Service Planner decides WHICH machines are due — it measures what each has actually
  // run. `local=1` asks for this system's own date estimate instead, for comparison.
  const plan = req.query.local === '1'
    ? servicePlan.buildServicePlan(opts)
    : await servicePlan.buildServicePlanLinked(opts);
  if (req.query.format !== 'xlsx') {
    if (req.query.never_serviced === '1') plan.never_serviced = servicePlan.neverServiced();
    return res.json(plan);
  }

  // One row per machine-and-category, so the sheet pivots and filters like the office expects,
  // and the two lists sit on their own tabs — overdue is what gets worked, due-soon is what
  // gets prepared for.
  const linked = plan.source === 'service planner';
  const rowsFor = (list) => {
    const out = [];
    for (const v of list) {
      const p = v.planner || {};
      const base = {
        asset: v.asset_code, reg: v.asset_reg, ec: v.asset_ec, site: v.site,
        basis: p.basis || null,
        interval: p.interval != null ? p.interval : null,
        used: p.usedSince != null ? Math.round(p.usedSince) : null,
        // Negative "remaining" is how far past due it already is — spell that out.
        over_by: p.remaining != null && p.remaining < 0 ? Math.round(-p.remaining) : null,
        left: p.remaining != null && p.remaining >= 0 ? Math.round(p.remaining) : null,
        last_service: v.last_service || p.lastServiceDate || null,
        projected_due: p.projectedDueDate || v.due_date || null,
        services: v.visits || 0,
        meter: v.meter_broken ? 'meter not working' : (v.meter || null),
      };
      if (!v.core || !v.core.length) { out.push({ ...base, category: '(no filter history in WorkshopOne)' }); continue; }
      for (const c of v.core) {
        out.push({ ...base,
          category: c.category, part: c.part || '(no number in this machine’s history)',
          last_fitted: c.last_fitted, times_used: c.times_used, different_numbers: c.distinct_numbers,
          alternates: c.alternates.join(', '), confirm: c.confirm ? 'confirm at the machine' : '' });
      }
    }
    return out;
  };

  const machineCols = [
    { header: 'Machine', key: 'asset', width: 14 }, { header: 'Registration', key: 'reg', width: 14 },
    { header: 'E&C', key: 'ec', width: 12 }, { header: 'Site', key: 'site', width: 18 },
    { header: 'Basis', key: 'basis', width: 8 }, { header: 'Service every', key: 'interval', width: 13 },
    { header: 'Run since service', key: 'used', width: 17 },
    { header: 'Over by', key: 'over_by', width: 10 }, { header: 'Still to run', key: 'left', width: 12 },
    { header: 'Last service', key: 'last_service', width: 13 },
    { header: 'Projected due', key: 'projected_due', width: 13 },
    { header: 'Services on record', key: 'services', width: 17 },
    { header: 'Meter', key: 'meter', width: 15 },
    { header: 'Filter', key: 'category', width: 24 }, { header: 'Suggested part', key: 'part', width: 24 },
    { header: 'Last fitted', key: 'last_fitted', width: 12 }, { header: 'Times used', key: 'times_used', width: 11 },
    { header: 'Different numbers', key: 'different_numbers', width: 17 },
    { header: 'Alternates', key: 'alternates', width: 38 }, { header: 'Check', key: 'confirm', width: 22 },
  ];

  await sendXlsx(res, `service-filter-plan-${plan.month}.xlsx`, [
    { name: 'Overdue', columns: machineCols, rows: rowsFor(plan.carry) },
    { name: 'Due Soon', columns: machineCols, rows: rowsFor(plan.due) },
    { name: 'Order by Category',
      columns: [
        { header: 'Category', key: 'category', width: 28 }, { header: 'Qty needed', key: 'qty', width: 12 },
        { header: 'Vehicles', key: 'vehicles', width: 10 }, { header: 'On hand', key: 'on_hand', width: 10 },
        { header: 'Shortfall', key: 'shortfall', width: 11 }],
      rows: plan.categories },
    { name: 'Order by Part',
      columns: [
        { header: 'Part number', key: 'part', width: 24 }, { header: 'Category', key: 'category', width: 26 },
        { header: 'Vehicles', key: 'vehicles', width: 10 }, { header: 'Qty needed', key: 'qty', width: 12 },
        { header: 'On hand', key: 'on_hand', width: 10 }, { header: 'To buy', key: 'to_buy', width: 10 },
        { header: 'Unit price', key: 'unit_price', width: 12 }, { header: 'Value', key: 'value', width: 14 },
        { header: 'Not on the stock sheet', key: 'no_stock_row', width: 22 }],
      rows: plan.parts.map((p) => ({ ...p, no_stock_row: p.no_stock_row ? 'yes' : '' })) },
    { name: 'How this was worked out',
      columns: [{ header: 'Note', key: 'note', width: 120 }],
      rows: [
        { note: linked
          ? `Month ${plan.month} · the Service Planner decided which machines are due, as at ${plan.planner_as_of} — it measures meter growth and fuel-derived running (machinery 500 hr, road 5,000 km).`
          : `Month ${plan.month} · measured as at ${plan.as_of} · WorkshopOne's OWN date estimate — the Service Planner was not used (${plan.planner_error || 'unavailable'}). This system holds no meter or fuel data, so a machine that has barely run can read as overdue.` },
        { note: linked
          ? `Fleet: ${plan.fleet.overdue} overdue · ${plan.fleet.due_soon} due soon · ${plan.fleet.ok} OK · ${plan.fleet.unknown} unknown, of ${plan.fleet.tracked} tracked. This workbook lists the overdue and due-soon machines only.`
          : `Rule ${plan.rule_version} · fleet prior ${plan.fleet_prior} days from ${plan.fleet_gaps} intervals.` },
        { note: 'The filters come from WorkshopOne: what each machine actually took at its own past services.' },
        // plan.warnings already names the unmatched machines — don't say it twice.
        ...plan.warnings.map((w) => ({ note: w })),
      ] },
  ]);
}));

router.get('/services/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const job = get(
    `SELECT s.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, ${COST_SQL} AS computed_cost
       FROM service_jobs s LEFT JOIN assets a ON a.id = s.asset_id WHERE s.id = ?`, id);
  if (!job) return res.status(404).json({ error: 'Service not found' });
  // Each filter line carries the book price so missing ones surface here too.
  const filters = all(
    `SELECT f.id, f.filter_no, f.filter_no_norm, f.category, f.action_type, f.qty, f.price, f.required_no,
            p.unit_price AS book_price
       FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm
      WHERE f.service_id = ? ORDER BY f.id`, id);
  const oils = all('SELECT id, oil_name, oil_type, action_type, qty, price FROM service_oils WHERE service_id = ? ORDER BY id', id);
  const parts = all('SELECT id, description, unit, rate, qty, amount FROM service_parts WHERE service_id = ? ORDER BY id', id);
  res.json({ service: job, filters, oils, parts, attachments: attachmentList(id) });
}));

// ---- scanned service sheets ------------------------------------------------
// Everything EXCEPT the bytes — listing a service must never pull its PDFs into memory.
const attachmentList = (serviceId) => all(
  `SELECT a.id, a.filename, a.mime, a.size_bytes, a.note, a.uploaded_at, u.username AS uploaded_by_name
     FROM service_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.service_id = ? ORDER BY a.id DESC`, serviceId);

const MAX_ATTACHMENT = 15 * 1024 * 1024;   // a scanned sheet; well under SQLite's blob ceiling
const PDF_MAGIC = Buffer.from('%PDF-');

router.get('/services/:id/attachments', asyncHandler((req, res) => {
  res.json(attachmentList(toInt(req.params.id)));
}));

// The PDF arrives as the raw request body — base64 in JSON would inflate it by a third and
// cost a decode on every upload.
router.post(
  '/services/:id/attachments',
  requireCap('services.attachments'),
  express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: MAX_ATTACHMENT }),
  asyncHandler((req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT 1 v FROM service_jobs WHERE id = ?', id)) return res.status(404).json({ error: 'Service not found' });

    const data = Buffer.isBuffer(req.body) ? req.body : null;
    if (!data || !data.length) return res.status(400).json({ error: 'No file received' });
    // Trust the bytes, not the extension — a renamed .doc would be unopenable later.
    if (!data.subarray(0, 5).equals(PDF_MAGIC)) return res.status(400).json({ error: 'That file is not a PDF' });

    const raw = String(req.query.filename || 'service.pdf');
    // Keep a recognisable name but never a path — this is echoed back in a download header.
    const filename = raw.split(/[\\/]/).pop().replace(/[\r\n"]/g, '').slice(0, 160) || 'service.pdf';

    const info = run(
      `INSERT INTO service_attachments (service_id, filename, mime, size_bytes, note, data, uploaded_by)
       VALUES (?, ?, 'application/pdf', ?, ?, ?, ?)`,
      id, filename, data.length, req.query.note ? String(req.query.note).slice(0, 300) : null, data, req.user.id);

    audit.record({ userId: req.user.id, entity: 'service_attachment', entityId: info.lastInsertRowid,
      action: 'upload', after: { service_id: id, filename, size_bytes: data.length } });
    res.status(201).json({ ok: true, attachment: get(
      'SELECT id, filename, mime, size_bytes, note, uploaded_at FROM service_attachments WHERE id = ?', info.lastInsertRowid) });
  })
);

// Open in the browser's viewer by default; ?download=1 saves it instead.
router.get('/attachments/:aid', asyncHandler((req, res) => {
  const a = get('SELECT * FROM service_attachments WHERE id = ?', toInt(req.params.aid));
  if (!a) return res.status(404).send('Attachment not found');
  const disp = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', a.mime || 'application/pdf');
  res.setHeader('Content-Length', a.size_bytes);
  res.setHeader('Content-Disposition', `${disp}; filename="${a.filename.replace(/"/g, '')}"`);
  res.send(a.data);
}));

router.delete(
  '/attachments/:aid',
  requireCap('services.attachments'),
  asyncHandler((req, res) => {
    const aid = toInt(req.params.aid);
    const a = get('SELECT id, service_id, filename, size_bytes FROM service_attachments WHERE id = ?', aid);
    if (!a) return res.status(404).json({ error: 'Attachment not found' });
    run('DELETE FROM service_attachments WHERE id = ?', aid);
    audit.record({ userId: req.user.id, entity: 'service_attachment', entityId: aid, action: 'delete', before: a });
    res.json({ ok: true });
  })
);

// Printable service form — matches the paper "Vehicle/Machinery Service Details".
router.get('/services/:id/print.html', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const s = get(`SELECT s.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec FROM service_jobs s LEFT JOIN assets a ON a.id = s.asset_id WHERE s.id = ?`, id);
  if (!s) return res.status(404).send('Service not found');
  const oils = all('SELECT oil_name, oil_type, action_type, qty, price FROM service_oils WHERE service_id = ? ORDER BY id', id);
  const filters = all(`SELECT f.category, f.filter_no, f.qty, f.action_type, p.unit_price book FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm=f.filter_no_norm WHERE f.service_id=? ORDER BY f.id`, id);
  const parts = all('SELECT description, unit, rate, qty, amount FROM service_parts WHERE service_id = ? ORDER BY id', id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const m = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const veh = [s.asset_reg || s.reg_id, (s.asset_ec && s.asset_ec !== s.asset_reg) ? s.asset_ec : ''].filter(Boolean).join(' · ') || s.vehicle_label || s.asset_code || '';
  const oilRows = oils.map((o) => `<tr><td>${esc(o.oil_name)}</td><td>${esc(o.oil_type || '')}</td><td class="c">${esc(o.action_type || '')}</td><td class="num">${o.qty || ''}</td><td class="num">${o.price ? m(o.price) : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="c" style="color:#666">No oils recorded</td></tr>';
  const filRows = filters.map((f) => `<tr><td>${esc(f.category || '')}</td><td>${esc(f.filter_no || '')}</td><td class="num">${f.qty || ''}</td><td class="c">${esc(f.action_type || '')}</td><td class="num">${f.book ? m(f.book) : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="c" style="color:#666">No filters recorded</td></tr>';
  const partRows = parts.map((p, i) => `<tr><td class="c">${i + 1}</td><td>${esc(p.description || '')}</td><td>${esc(p.unit || '')}</td><td class="num">${p.rate ? m(p.rate) : ''}</td><td class="num">${p.qty || ''}</td><td class="num">${m(p.amount)}</td></tr>`).join('');
  const grand = s.grand_total || 0;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Service ${esc(d(s.service_date))} — ${esc(veh)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; } body { font-family: Arial, sans-serif; color:#000; font-size:11px; margin:0; }
  .sheet { border:1.5px solid #000; }
  .hd { text-align:center; font-weight:bold; padding:6px; border-bottom:1.5px solid #000; } .hd .co { font-size:15px; } .hd .ti { font-size:13px; }
  .meta { display:grid; grid-template-columns:1fr 1fr; } .meta div { padding:3px 8px; border-bottom:1px solid #000; } .meta b { display:inline-block; min-width:96px; }
  .meta div:nth-child(odd){ border-right:1px solid #000; }
  .cols { display:grid; grid-template-columns:1fr 1fr; } .cols > div:first-child { border-right:1.5px solid #000; }
  table { width:100%; border-collapse:collapse; } th,td { border:1px solid #000; padding:2px 5px; } th { background:#eee; font-size:10px; }
  td.c { text-align:center; } td.num { text-align:right; }
  .tot { display:flex; justify-content:flex-end; } .tot table { width:auto; } .tot td { border:none; padding:2px 10px; } .tot .g td { border-top:1.5px solid #000; font-weight:bold; }
  .foot { padding:5px 8px; border-top:1.5px solid #000; } .rd { min-height:48px; }
  button { padding:8px 14px; font-size:14px; margin:10px 0; cursor:pointer; } @media print { .noprint { display:none; } }
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<div class="sheet">
  <div class="hd"><div class="co">Edward and Christie (Pvt) Ltd</div><div class="ti">Vehicle / Machinery Service Details</div></div>
  <div class="meta">
    <div><b>Date:</b> ${esc(d(s.service_date))}</div><div><b>Job/Service No.:</b> ${esc(s.job_no || '')}</div>
    <div><b>Reg. ID:</b> ${esc(s.asset_reg || s.reg_id || '')}</div><div><b>Meter Reading:</b> ${esc(s.meter_reading || '')}</div>
    <div><b>E&amp;C Code:</b> ${esc(s.asset_ec || '')}</div><div><b>Next Service at:</b> ${esc(s.next_service_meter || '')}</div>
    <div><b>Model:</b> ${esc(s.model_no || '')}</div><div><b>Service Type:</b> ${esc(s.service_type || '')}</div>
    <div><b>Vehicle:</b> ${esc(veh)}</div><div><b>Location (Site):</b> ${esc(s.site_location || '')}</div>
  </div>
  <div class="cols">
    <div><table><thead><tr><th>Oil Name</th><th>Type</th><th>C/V</th><th>Liters</th><th>Price</th></tr></thead><tbody>${oilRows}</tbody></table></div>
    <div><table><thead><tr><th>Filter</th><th>Filter No.</th><th>Qty</th><th>X/E</th><th>Price</th></tr></thead><tbody>${filRows}</tbody></table></div>
  </div>
  ${partRows ? `<table><thead><tr><th>No.</th><th>Description (Other Costs)</th><th>Unit</th><th>Rate</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${partRows}</tbody></table>` : ''}
  <div class="tot"><table>
    <tr><td>Parts Subtotal</td><td class="num">${m(s.parts_subtotal)}</td></tr>
    <tr><td>Labour Charge (${s.labour_rate || 20}%)</td><td class="num">${m(s.labour_charge)}</td></tr>
    <tr><td>Sundry (${s.sundry_rate || 5}%)</td><td class="num">${m(s.sundry_amount)}</td></tr>
    <tr class="g"><td>Grand Total</td><td class="num">${m(grand)}</td></tr>
  </table></div>
  <div class="foot"><b>Up-keeping of Equipment/Vehicle:</b> ${esc(s.upkeeping || '')} &nbsp;&nbsp; (Good - G / Fair - F / Bad - B)
    <div style="margin-top:4px"><b>Vehicle/Machinery Repair Details:</b></div><div class="rd">${esc(s.repair_details || '')}</div></div>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

module.exports = router;
