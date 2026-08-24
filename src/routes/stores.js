'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireRole, hasRole } = require('../lib/auth');
const { asyncHandler, require_, toInt, toNum } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');
const categories = require('../lib/categories');
const costing = require('../lib/costing');
const { sendXlsx } = require('../lib/export');
const emitter = require('../lib/emitter');
const stock = require('../lib/stock');
const jobstate = require('../lib/jobstate');
const permissions = require('../lib/permissions');
const { lineReceiptSql, mrnReceiptSql, receivedLabel, d10 } = require('../lib/received_date');
const lubricants = require('../lib/lubricants');

// One cell's worth of "when did this arrive", for a sheet or a printout. A spreadsheet has no
// tooltip, so whatever the hover would have said has to be in the cell itself.
const exportReceived = (r) => {
  const l = receivedLabel(r);
  if (!l.text || !l.split) return l.text;
  return `${l.text} (+${l.split} from ${d10(r.first_received)})`;
};

// Stock section -> the category label an issue is tagged with, so lines raised from the
// unified issue form land in the same buckets as the rest of the catalogue.
const SECTION_CATEGORY = {
  oil: 'Lubricants & Fluids',
  filter: 'Filters',
  battery: 'Battery',
  tyre: 'Tyres & Wheels',
  general: 'General Items',
};

// money rounding for issue lines
const n2price = (v) => Math.round((Number(v) || 0) * 100) / 100;
// trim to a string or null (blank fields must not become empty strings in the DB)
const clean = (v) => (v == null ? null : (String(v).trim() || null));

const router = express.Router();

// ---- numbering (continues existing sequences) -----------------------------
function nextMrnNo() {
  const r = get(`SELECT MAX(CAST(mrn_no AS INTEGER)) m FROM mrn WHERE mrn_no GLOB '[0-9]*'`);
  return String((r && r.m ? r.m : 167442) + 1);
}
function nextMtnNo() {
  const r = get(`SELECT MAX(CAST(mtn_no AS INTEGER)) m FROM mtn WHERE mtn_no GLOB '[0-9]*'`);
  return String((r && r.m ? r.m : 57814) + 1);
}
function resolveAssetId(body, prefix) {
  const idKey = prefix ? `${prefix}_asset_id` : 'asset_id';
  const textKey = prefix ? `${prefix}_asset` : 'asset';
  if (body[idKey]) return { assetId: toInt(body[idKey]), unresolved: null };
  if (body[textKey]) {
    const r = aliases.resolveAsset(body[textKey], { source: 'stores' });
    return { assetId: r.assetId, unresolved: r.resolved ? null : { aliasId: r.aliasId, raw: body[textKey] } };
  }
  return { assetId: null, unresolved: null };
}

// The shared container job for stores issues that aren't tied to a specific vehicle job
// (general consumables). Same 'general-workshop' card daily-work uses — every issue keeps
// a cost object. Created once, reused thereafter.
function generalWorkshopJobId() {
  const j = get("SELECT id FROM job_cards WHERE legacy_ref = 'general-workshop' LIMIT 1");
  if (j) return j.id;
  return run(`INSERT INTO job_cards (job_no, type, description, status, requested_by, requested_at, is_historical, synthesized_no, legacy_ref)
              VALUES ('GENERAL-WS', 'repair', 'General workshop stores issues (not vehicle-specific)', 'REQUESTED', 'system', date('now'), 0, 1, 'general-workshop')`).lastInsertRowid;
}

router.get('/numbers', asyncHandler((_req, res) => res.json({ next_mrn: nextMrnNo(), next_mtn: nextMtnNo() })));

// ---- store items ----------------------------------------------------------
router.get('/items', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.q) { clauses.push('(s.name LIKE ? OR s.part_number LIKE ?)'); params.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  if (req.query.is_general !== undefined) { clauses.push('s.is_general = ?'); params.push(toInt(req.query.is_general)); }
  if (req.query.category_id) {
    clauses.push('s.category_id IN (SELECT id FROM item_categories WHERE id = ? OR parent_id = ?)');
    params.push(toInt(req.query.category_id), toInt(req.query.category_id));
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT s.*, sub.name AS sub_category, p.name AS parent_category
       FROM store_items s
       LEFT JOIN item_categories sub ON sub.id = s.category_id
       LEFT JOIN item_categories p ON p.id = sub.parent_id
       ${where} ORDER BY s.name LIMIT ${toInt(req.query.limit, 500)}`, ...params));
}));

router.post('/items', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['name']);
  const cat = categories.resolve(b);
  const info = run(
    `INSERT INTO store_items (name, part_number, category, category_id, unit, rack, min_stock, is_general, balance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.name, b.part_number || null, cat.category, cat.category_id, b.unit || 'nos', b.rack || null,
    toNum(b.min_stock, 0), b.is_general ? 1 : 0, toNum(b.balance, 0)
  );
  audit.record({ userId: req.user.id, entity: 'store_item', entityId: info.lastInsertRowid, action: 'create' });
  res.status(201).json(get('SELECT * FROM store_items WHERE id = ?', info.lastInsertRowid));
}));

router.patch('/items/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const sets = [];
  const params = [];
  for (const c of ['name', 'part_number', 'unit', 'rack', 'min_stock']) {
    if (req.body[c] !== undefined) { sets.push(`${c} = ?`); params.push(req.body[c]); }
  }
  // category / category_id always move together (the label is the parent's name).
  if (req.body.category_id !== undefined || req.body.category !== undefined) {
    const cat = categories.resolve(req.body);
    sets.push('category = ?', 'category_id = ?');
    params.push(cat.category, cat.category_id);
  }
  if (sets.length) run(`UPDATE store_items SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  res.json(get('SELECT * FROM store_items WHERE id = ?', id));
}));

router.get('/items/:id/ledger', asyncHandler((req, res) =>
  res.json(all('SELECT * FROM general_item_txns WHERE store_item_id = ? ORDER BY id DESC', toInt(req.params.id)))));

router.post('/items/:id/txn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const itemId = toInt(req.params.id);
  const item = get('SELECT * FROM store_items WHERE id = ?', itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const b = req.body;
  require_(b, ['txn_type', 'qty']);
  const qtyMag = Math.abs(toNum(b.qty, 0));
  const prevRow = get('SELECT balance_after FROM general_item_txns WHERE store_item_id = ? ORDER BY id DESC LIMIT 1', itemId);
  const prev = prevRow ? prevRow.balance_after : (item.balance || 0);
  let signedQty;
  let balanceAfter;
  switch (b.txn_type) {
    case 'receipt': signedQty = qtyMag; balanceAfter = prev + qtyMag; break;
    case 'issue': signedQty = -qtyMag; balanceAfter = prev - qtyMag; break;
    case 'opening': balanceAfter = qtyMag; signedQty = qtyMag - prev; break;
    case 'adjustment': balanceAfter = qtyMag; signedQty = qtyMag - prev; break;
    default: return res.status(400).json({ error: 'Invalid txn_type' });
  }
  const { assetId } = resolveAssetId(b);
  const result = tx(() => {
    const info = run(
      `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, asset_id, job_id, unit_price, ref, txn_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      itemId, b.txn_type, signedQty, balanceAfter, assetId || null, toInt(b.job_id),
      b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price), b.ref || null,
      b.txn_date || new Date().toISOString().slice(0, 10)
    );
    run('UPDATE store_items SET balance = ? WHERE id = ?', balanceAfter, itemId);
    return get('SELECT * FROM general_item_txns WHERE id = ?', info.lastInsertRowid);
  });
  audit.record({ userId: req.user.id, entity: 'general_item_txn', entityId: result.id, action: 'create' });
  res.status(201).json(result);
}));

router.get('/reorder', asyncHandler((_req, res) =>
  res.json(all('SELECT * FROM store_items WHERE is_general = 1 AND min_stock > 0 AND balance <= min_stock ORDER BY name'))));

// ---- item picker + on-the-fly catalogue entries ---------------------------
// One search across the whole catalogue for the "which item?" pickers: item number,
// name, every part number ever seen for it, and the category. Most-requested first,
// so the items the workshop actually asks for surface at the top.
// The category a lubricant line is filed under. Looked up once and remembered — it is the same
// row for every search, and it may not exist on a bare database.
let _lubeCat;
function lubeCategoryId() {
  if (_lubeCat === undefined) {
    const c = get(`SELECT id FROM item_categories WHERE name = 'Lubricants & Fluids' LIMIT 1`);
    _lubeCat = c ? c.id : null;
  }
  return _lubeCat;
}

router.get('/items/search', asyncHandler((req, res) => {
  const raw = String(req.query.q || '').trim();
  if (!raw) return res.json([]);
  const like = '%' + raw + '%';
  const starts = raw + '%';
  const rows = all(
    `SELECT s.id, s.item_no, s.name, s.part_number, s.part_numbers, s.unit, s.is_general, s.balance,
            s.category, s.category_id, s.req_count, s.unit_cost,
            sub.name AS sub_category, p.name AS parent_category,
            -- What it last actually cost. Imported GRNs carry no store_item_id (they
            -- predate the catalogue), so fall back to the newest priced receipt whose
            -- description IS the item name, then to the maintained general-stock cost.
            COALESCE(
              (SELECT g.unit_price FROM grn g
                WHERE g.store_item_id = s.id AND g.unit_price IS NOT NULL
                ORDER BY g.id DESC LIMIT 1),
              (SELECT g.unit_price FROM grn g
                WHERE g.unit_price IS NOT NULL AND LOWER(TRIM(g.description)) = LOWER(TRIM(s.name))
                ORDER BY g.id DESC LIMIT 1),
              NULLIF(s.unit_cost, 0)) AS last_price
       FROM store_items s
       LEFT JOIN item_categories sub ON sub.id = s.category_id
       LEFT JOIN item_categories p ON p.id = sub.parent_id
      WHERE s.name LIKE ? OR s.item_no LIKE ? OR s.part_number LIKE ? OR s.part_numbers LIKE ? OR s.category LIKE ?
      ORDER BY (s.name LIKE ?) DESC, COALESCE(s.req_count, 0) DESC, s.name
      LIMIT ${toInt(req.query.limit, 20)}`,
    like, like, like, like, like, starts);

  // Lubricants live in the oil book, not the stores catalogue — 19 of the 30 have no
  // store_items row at all, so until now HD-68 could only be typed free-hand on a request or
  // a transfer. That is precisely how the same drum came to be written five different ways.
  // They are offered here by their own code (OIL-0021), and picking one writes the CANONICAL
  // product name, so the line resolves to that product with no alias needed. No second
  // catalogue row is created: the oil book stays the one place a lubricant is defined.
  // Searched by every name it has ever been known by, not just its catalogue spelling: the
  // storekeeper types "Kerosine" and the book calls it "Karosine Oil". That is what the alias
  // table is for, and without it the picker sends them back to typing free-hand.
  const lubes = all(
    `SELECT p.id, p.code, p.name, p.unit, p.category, p.unit_price
       FROM products p
      WHERE COALESCE(p.active, 1) = 1
        AND (p.name LIKE ? OR p.code LIKE ? OR p.category LIKE ?
             OR EXISTS (SELECT 1 FROM lubricant_aliases a
                         WHERE a.product_id = p.id AND a.resolved = 1 AND a.raw_norm LIKE ?))
      ORDER BY (p.name LIKE ?) DESC, p.code
      LIMIT 10`, like, like, like, '%' + lubricants.normLube(raw) + '%', starts)
    .map((p) => ({
      id: null,                       // not a store_items row — the name carries the identity
      lubricant_id: p.id,
      item_no: p.code,
      name: p.name,
      unit: p.unit,
      category: 'Lubricants & Fluids',
      // So the line is filed under Lubricants & Fluids like the rest. The stock section does
      // not depend on it — a lubricant is promoted to the oil book by its name whatever the
      // category says — but a request that reads "(uncategorised)" is a request nobody trusts.
      category_id: lubeCategoryId(),
      last_price: p.unit_price,
      is_lubricant: 1,
      balance: null,
    }));

  res.json(lubes.concat(rows));
}));

// Next catalogue number for a category, e.g. FIL-0037. The 3-letter prefix comes from
// the parent category's `code`, so a new item slots into the existing numbering.
function nextItemNo(categoryId) {
  let code = 'GEN';
  if (categoryId) {
    const row = get(`SELECT COALESCE(p.code, c.code) code FROM item_categories c
                       LEFT JOIN item_categories p ON p.id = c.parent_id WHERE c.id = ?`, categoryId);
    if (row && row.code) code = row.code;
  }
  const last = get(`SELECT item_no FROM store_items WHERE item_no LIKE ? ORDER BY item_no DESC LIMIT 1`, code + '-%');
  const n = last ? (parseInt(String(last.item_no).split('-')[1], 10) || 0) + 1 : 1;
  return `${code}-${String(n).padStart(4, '0')}`;
}

/**
 * Normalise one requested line. Picking a catalogue item snapshots its name, unit and
 * sub-category so descriptions stop drifting; `create_item` adds a brand-new item to
 * the catalogue (numbered in its category) and links the line to it. Free text with
 * neither still works exactly as before.
 */
function itemLine(l) {
  const cat = categories.resolve(l);
  let itemId = toInt(l.store_item_id) || null;
  let description = String(l.description || '').trim();
  let unit = l.unit || null;

  if (itemId) {
    const it = get('SELECT name, unit, category, category_id FROM store_items WHERE id = ?', itemId);
    if (it) {
      if (!description) description = it.name;
      if (!unit) unit = it.unit;
      if (!cat.category_id && it.category_id) { cat.category_id = it.category_id; cat.category = it.category; }
    } else {
      itemId = null; // stale id — keep the typed text rather than failing the request
    }
  } else if (l.create_item && description) {
    const dupe = get('SELECT id FROM store_items WHERE LOWER(TRIM(name)) = LOWER(?)', description);
    if (dupe) itemId = dupe.id;
    else {
      itemId = run(
        `INSERT INTO store_items (name, category, category_id, unit, item_no, catalogue_kind, req_count, is_general, balance)
         VALUES (?, ?, ?, ?, ?, 'part', 0, 0, 0)`,
        description, cat.category, cat.category_id, unit || 'nos', nextItemNo(cat.category_id)
      ).lastInsertRowid;
    }
  }
  return { store_item_id: itemId, description, unit: unit || 'nos', category: cat.category, category_id: cat.category_id };
}

// ---- Category tree (Category → Sub-category) ------------------------------
// The tree is the master; the free-text `category` column below it always holds the
// PARENT name (kept in step by lib/categories) so every existing report still groups
// the same way. Literal paths are registered before '/categories/:id'.
const CAT = "COALESCE(NULLIF(TRIM(category),''),'(uncategorised)')";

router.get('/categories/tree', asyncHandler((req, res) =>
  res.json({ tree: categories.tree({ activeOnly: req.query.active === '1' }) })));

// Flat leaf list for the Category → Sub-category pickers.
router.get('/categories/options', asyncHandler((_req, res) => res.json(categories.leaves())));

router.get('/categories/:id/usage', asyncHandler((req, res) => {
  const u = categories.usage(toInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Category not found' });
  res.json(u);
}));

router.post('/categories', requireRole('storekeeper'), asyncHandler((req, res) => {
  const row = categories.create(req.body);
  audit.record({ userId: req.user.id, entity: 'item_category', entityId: row.id, action: 'create', after: { name: row.name, parent_id: row.parent_id } });
  res.status(201).json(row);
}));

router.patch('/categories/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM item_categories WHERE id = ?', id);
  const row = categories.update(id, req.body);
  audit.record({ userId: req.user.id, entity: 'item_category', entityId: id, action: 'update', before, after: row });
  res.json(row);
}));

// Move every record (and, for a category, every sub-category) into another, then drop
// the source — how the imported free-text vocabulary gets tidied up.
router.post('/categories/:id/merge', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const into = toInt(req.body.into_id);
  if (!into) return res.status(400).json({ error: 'into_id is required' });
  const before = get('SELECT * FROM item_categories WHERE id = ?', id);
  const moved = categories.merge(id, into);
  audit.record({ userId: req.user.id, entity: 'item_category', entityId: id, action: 'merge', before, after: { into_id: into, ...moved } });
  res.json({ ok: true, ...moved });
}));

router.delete('/categories/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM item_categories WHERE id = ?', id);
  const out = categories.remove(id);
  audit.record({ userId: req.user.id, entity: 'item_category', entityId: id, action: 'delete', before });
  res.json(out);
}));

// Breakdown for the Categories tab: the tree with usage counts, plus the flat
// per-label totals the tab has always shown.
router.get('/categories', asyncHandler((_req, res) => {
  res.json({
    tree: categories.tree(),
    lines: all(`SELECT ${CAT} category, COUNT(*) lines, COUNT(DISTINCT description) distinct_items,
                       ROUND(COALESCE(SUM(qty),0),1) qty, ROUND(COALESCE(SUM(qty_received),0),1) received
                  FROM mrn_lines GROUP BY category ORDER BY lines DESC`),
    issues: all(`SELECT ${CAT} category, COUNT(*) issues, ROUND(COALESCE(SUM(qty),0),1) qty
                   FROM issues GROUP BY category ORDER BY issues DESC`),
    // From the items, not the notes: one transfer can carry a filter and a battery, and the
    // header's category is only a summary ('Mixed') when they disagree.
    transfers: all(`SELECT ${CAT} category, COUNT(*) transfers, ROUND(COALESCE(SUM(qty),0),1) qty
                      FROM mtn_lines GROUP BY category ORDER BY transfers DESC`),
    catalogue: all(`SELECT ${CAT} category, COUNT(*) items FROM store_items GROUP BY category ORDER BY items DESC`),
  });
}));

// ---- General item catalogue (deduped MRN items, each with an item number) --
// The consolidated master built from every MRN request description: synonym /
// spelling variants merged, all part numbers unioned, classified and numbered
// (see migrate/14_item_catalogue). These are the rows where item_no IS NOT NULL.
const CAT_KIND = "COALESCE(NULLIF(TRIM(catalogue_kind),''),'part')";

router.get('/catalogue/facets', asyncHandler((_req, res) => {
  res.json({
    total: get('SELECT COUNT(*) c FROM store_items WHERE item_no IS NOT NULL').c,
    by_kind: all(`SELECT ${CAT_KIND} kind, COUNT(*) count FROM store_items WHERE item_no IS NOT NULL GROUP BY kind ORDER BY count DESC`),
    categories: all(`SELECT ${CAT} category, COUNT(*) count FROM store_items WHERE item_no IS NOT NULL GROUP BY category ORDER BY category`),
    // Category → Sub-category counts for the two-level filter.
    by_sub_category: all(
      `SELECT p.id parent_id, p.name parent_name, sub.id id, sub.name name, COUNT(s.id) count
         FROM item_categories sub
         JOIN item_categories p ON p.id = sub.parent_id
         LEFT JOIN store_items s ON s.category_id = sub.id AND s.item_no IS NOT NULL
        WHERE sub.active = 1
        GROUP BY sub.id ORDER BY p.sort_order, p.name, sub.sort_order, sub.name`),
  });
}));

// store_items is aliased `s` because the category joins also carry a `name` column.
router.get('/catalogue', asyncHandler((req, res) => {
  const clauses = ['s.item_no IS NOT NULL'];
  const params = [];
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(s.item_no LIKE ? OR s.name LIKE ? OR s.part_numbers LIKE ?)');
    params.push(like, like, like);
  }
  if (req.query.category) { clauses.push(`COALESCE(NULLIF(TRIM(s.category),''),'(uncategorised)') = ?`); params.push(req.query.category); }
  if (req.query.kind) { clauses.push(`COALESCE(NULLIF(TRIM(s.catalogue_kind),''),'part') = ?`); params.push(req.query.kind); }
  // category_id accepts either level: a parent matches every sub-category under it.
  if (req.query.category_id) {
    clauses.push('s.category_id IN (SELECT id FROM item_categories WHERE id = ? OR parent_id = ?)');
    params.push(toInt(req.query.category_id), toInt(req.query.category_id));
  }
  res.json(all(
    `SELECT s.id, s.item_no, s.name, s.category, s.category_id, s.catalogue_kind, s.req_count,
            s.part_numbers, s.part_number, s.unit, s.is_general, s.balance,
            sub.name AS sub_category, p.name AS parent_category
       FROM store_items s
       LEFT JOIN item_categories sub ON sub.id = s.category_id
       LEFT JOIN item_categories p ON p.id = sub.parent_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.item_no LIMIT ${toInt(req.query.limit, 2000)}`, ...params));
}));

router.get('/export/catalogue.xlsx', asyncHandler(async (_req, res) => {
  const rows = all(`SELECT item_no, name, category, ${CAT_KIND} kind, req_count AS requests, COALESCE(part_numbers,'') part_numbers
                      FROM store_items WHERE item_no IS NOT NULL ORDER BY item_no`);
  await sendXlsx(res, 'item_catalogue.xlsx', [{
    name: 'Item Catalogue',
    columns: [
      { header: 'Item No', key: 'item_no' }, { header: 'Item Name', key: 'name' },
      { header: 'Category', key: 'category' }, { header: 'Kind', key: 'kind' },
      { header: 'Requests', key: 'requests' }, { header: 'Part Numbers', key: 'part_numbers' },
    ], rows,
  }]);
}));

// ---- MRN ------------------------------------------------------------------
// Two consolidated purchase sources: Head Office (absorbs Direct Purchase) and
// Local Purchase (absorbs Local Store).
const PURCHASE_SOURCES = ['head_office', 'local_purchase'];

// ---- cross-referenced filters ---------------------------------------------
// A filter request names one number; the shop supplies an equivalent. Recording what actually
// arrived is the point, but the equivalence itself is worth keeping: next time the same number
// is requested, the storekeeper should be offered what was accepted for it before.
const { normF } = require('../lib/filter_no');

// A description like "Oil Filter (2766199999)" or "Fuel Filter FC-1503" — pull out the number.
function requestedPartNo(description) {
  const s = String(description || '');
  const bracket = s.match(/\(([^)]*)\)/);
  const cand = bracket ? bracket[1] : s.replace(/^\s*[a-z/\s&-]*filter[a-z\s]*/i, '');
  const norm = normF(cand);
  return /[0-9]/.test(norm) && norm.length >= 3 ? { raw: cand.trim(), norm } : null;
}

/**
 * Remember that `receivedRaw` was supplied against `description`.
 * Only ever ADDS a cross-reference to the catalogue entry the requested number already belongs
 * to — it never creates a catalogue entry, and never rewrites filter_no_norm, which is a stored
 * join key for prices.
 */
function learnCrossRef(description, receivedRaw, userId) {
  const want = requestedPartNo(description);
  const got = normF(receivedRaw);
  if (!want || !got || got === want.norm) return null;      // same part, nothing to learn
  const hit = get(
    `SELECT catalogue_id FROM filter_xrefs WHERE part_number_norm = ? LIMIT 1`, want.norm)
    || get(`SELECT id AS catalogue_id FROM filter_catalogue WHERE oem_pn_norm = ? OR hifi_pn_norm = ? LIMIT 1`, want.norm, want.norm);
  if (!hit) return null;                                    // the requested number is not in the book
  const already = get(
    `SELECT 1 v FROM filter_xrefs WHERE catalogue_id = ? AND part_number_norm = ?`, hit.catalogue_id, got);
  if (already) return null;
  run(`INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type, source, note)
       VALUES (?, NULL, ?, ?, 'cross', 'received', ?)`,
    hit.catalogue_id, String(receivedRaw).trim(), got, `supplied against ${want.raw} on receipt`);
  audit.record({ userId, entity: 'filter_xref', action: 'learn_from_receipt',
    after: { requested: want.raw, received: String(receivedRaw).trim(), catalogue_id: hit.catalogue_id } });
  return hit.catalogue_id;
}
function purchaseSourceNorm(s) {
  s = String(s == null ? '' : s).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('direct') || s.includes('head office') || s === 'head_office') return 'head_office';
  if (s.includes('local')) return 'local_purchase'; // local purchase OR local store
  return 'head_office'; // combos / anything else roll up to Head Office
}
const MRN_SORTS = {
  date_desc: 'm.req_date DESC, m.id DESC',
  date_asc: 'm.req_date ASC, m.id ASC',
  mrn_desc: 'CAST(m.mrn_no AS INTEGER) DESC, m.id DESC',
  mrn_asc: 'CAST(m.mrn_no AS INTEGER) ASC, m.id ASC',
};

// ---- Item-level search across every stores line ---------------------------
// One row per requested item, with its receipt/price state — the "find anything" view.
// Search hits the MRN number, vehicle (code / registration / E&C), item name, category,
// job number, supplier and invoice number. Every column is sortable.
const LINE_SORTS = {
  date_desc: 'm.req_date DESC, m.id DESC', date_asc: 'm.req_date ASC, m.id ASC',
  mrn_desc: 'CAST(m.mrn_no AS INTEGER) DESC', mrn_asc: 'CAST(m.mrn_no AS INTEGER) ASC',
  vehicle_asc: "COALESCE(a.registration, a.code, '') ASC, m.req_date DESC",
  vehicle_desc: "COALESCE(a.registration, a.code, '') DESC, m.req_date DESC",
  item_asc: 'ml.description ASC', item_desc: 'ml.description DESC',
  qty_desc: 'ml.qty DESC', qty_asc: 'ml.qty ASC',
  pending_desc: 'pending DESC, m.req_date DESC', pending_asc: 'pending ASC, m.req_date DESC',
  value_desc: 'value DESC', value_asc: 'value ASC',
  status_asc: 'status ASC, m.req_date DESC', status_desc: 'status DESC, m.req_date DESC',
  // Nothing-received sorts last either way rather than clumping with the oldest deliveries.
  received_desc: 'last_received IS NULL, last_received DESC, m.req_date DESC',
  received_asc: 'last_received IS NULL, last_received ASC, m.req_date DESC',
};

function lineSearchRows(query) {
  const clauses = [];
  const params = [];
  const q = String(query.q || '').trim();
  if (q) {
    const like = '%' + q + '%';
    clauses.push(`(m.mrn_no LIKE ? OR a.code LIKE ? OR a.registration LIKE ? OR a.ec_code LIKE ?
                   OR ml.description LIKE ? OR ml.category LIKE ? OR j.job_no LIKE ?
                   OR EXISTS (SELECT 1 FROM grn g WHERE g.mrn_line_id = ml.id
                                AND (g.supplier LIKE ? OR g.invoice_no LIKE ? OR g.grn_no LIKE ?)))`);
    for (let i = 0; i < 10; i++) params.push(like);
  }
  if (query.source && PURCHASE_SOURCES.includes(query.source)) {
    clauses.push('COALESCE(ml.purchase_source, m.purchase_source) = ?');
    params.push(query.source);
  }
  if (query.status === 'pending') clauses.push('COALESCE(ml.qty_received,0) < ml.qty');
  else if (query.status === 'received') clauses.push('COALESCE(ml.qty_received,0) >= ml.qty');
  else if (query.status === 'unpriced') clauses.push('EXISTS (SELECT 1 FROM grn g WHERE g.mrn_line_id = ml.id AND g.unit_price IS NULL)');
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const order = LINE_SORTS[query.sort] || LINE_SORTS.date_desc;

  return all(
    `SELECT ml.id, m.id AS mrn_id, m.mrn_no, m.req_date, ml.description, ml.category,
            ml.qty, COALESCE(ml.qty_received,0) AS qty_received,
            (ml.qty - COALESCE(ml.qty_received,0)) AS pending,
            CASE WHEN COALESCE(ml.qty_received,0) >= ml.qty THEN 'received'
                 WHEN COALESCE(ml.qty_received,0) > 0 THEN 'partial' ELSE 'not received' END AS status,
            COALESCE(ml.purchase_source, m.purchase_source) AS source,
            a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            j.job_no,
            ${lineReceiptSql('ml.id')},
            (SELECT COUNT(*) FROM grn g WHERE g.mrn_line_id = ml.id) AS receipts,
            (SELECT COUNT(*) FROM grn g WHERE g.mrn_line_id = ml.id AND g.unit_price IS NULL) AS unpriced,
            (SELECT ROUND(COALESCE(SUM(g.qty * COALESCE(g.unit_price,0)),0),2) FROM grn g WHERE g.mrn_line_id = ml.id) AS value,
            (SELECT g.supplier FROM grn g WHERE g.mrn_line_id = ml.id AND g.supplier IS NOT NULL LIMIT 1) AS supplier
       FROM mrn_lines ml
       JOIN mrn m ON m.id = ml.mrn_id
       LEFT JOIN assets a ON a.id = m.asset_id
       LEFT JOIN job_cards j ON j.id = m.job_id
       ${where} ORDER BY ${order} LIMIT ${toInt(query.limit, 500)}`, ...params);
}

router.get('/search', asyncHandler((req, res) => res.json(lineSearchRows(req.query))));

router.get('/search/export.xlsx', asyncHandler(async (req, res) => {
  const rows = lineSearchRows({ ...req.query, limit: 10000 });
  await sendXlsx(res, 'stores-search.xlsx', [{
    name: 'Stores items',
    columns: [
      { header: 'MRN No', key: 'mrn_no', width: 14 }, { header: 'Req Date', key: 'req_date', width: 12 },
      { header: 'Vehicle', key: 'vehicle', width: 16 }, { header: 'Job No', key: 'job_no', width: 16 },
      { header: 'Item', key: 'description', width: 40 }, { header: 'Category', key: 'category', width: 18 },
      { header: 'Qty', key: 'qty', width: 9 }, { header: 'Received', key: 'qty_received', width: 10 },
      // Wide enough for the longest thing it can say — "2026-08-04 (+1 from 2026-07-27)" —
      // rather than clipping away the very note it exists to carry.
      { header: 'Received date', key: 'received_date', width: 32 },
      { header: 'Pending', key: 'pending', width: 9 }, { header: 'Status', key: 'status', width: 13 },
      { header: 'Source', key: 'source', width: 15 }, { header: 'Supplier', key: 'supplier', width: 20 },
      { header: 'Value (Rs)', key: 'value', width: 13 }, { header: 'Awaiting price', key: 'unpriced', width: 13 },
    ],
    rows: rows.map((r) => ({
      ...r, vehicle: r.asset_reg || r.asset_code || '',
      req_date: String(r.req_date || '').slice(0, 10),
      // Same rule the screen uses, so a sheet and the tab it came from never disagree — the
      // split note included, and "not recorded" rather than a blank that reads as "nothing came".
      received_date: exportReceived(r),
      source: r.source === 'head_office' ? 'Head Office' : (r.source === 'local_purchase' ? 'Local Purchase' : ''),
    })),
  }]);
}));

router.get('/mrn', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.asset_id) { clauses.push('m.asset_id = ?'); params.push(toInt(req.query.asset_id)); }
  if (req.query.status) { clauses.push('m.status = ?'); params.push(req.query.status); }
  // Approval-workflow tabs. 'pending' = live MRNs awaiting certification (excludes
  // imported history, whose approval_status is 'requested' but has no requester).
  if (req.query.approval) {
    if (req.query.approval === 'pending') clauses.push("m.approval_status = 'requested' AND m.requested_by IS NOT NULL AND TRIM(m.requested_by) <> ''");
    else { clauses.push('m.approval_status = ?'); params.push(req.query.approval); }
  }
  // Free-text search: MRN number, vehicle, purpose, or any item description on the MRN.
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push(`(m.mrn_no LIKE ? OR a.code LIKE ? OR m.purpose LIKE ?
                   OR EXISTS (SELECT 1 FROM mrn_lines ml WHERE ml.mrn_id = m.id AND ml.description LIKE ?))`);
    params.push(like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const order = MRN_SORTS[req.query.sort] || 'm.id DESC';
  res.json(all(
    `SELECT m.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, j.job_no,
            (SELECT COUNT(*)            FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS line_count,
            (SELECT COALESCE(SUM(qty),0)          FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS qty_requested,
            (SELECT COALESCE(SUM(qty_received),0) FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS qty_received,
            ${mrnReceiptSql('m.id')}
       FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id LEFT JOIN job_cards j ON j.id = m.job_id
       ${where} ORDER BY ${order} LIMIT ${toInt(req.query.limit, 300)}`,
    ...params
  ));
}));

router.post('/mrn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  // Request target: 'general' (store stock) or 'vehicle'. The VEHICLE is authoritative —
  // any vehicle can be requested for, whether or not it has a job card open. A job card
  // may be linked as well (it is what makes the request gate that job's closure), and
  // when it is, it must belong to the same vehicle.
  const requestType = b.request_type === 'general' ? 'general' : 'vehicle';
  let assetId = null, unresolved = null, jobId = null;
  if (requestType === 'vehicle') {
    const r = resolveAssetId(b);
    assetId = r.assetId;
    unresolved = r.unresolved;
    jobId = toInt(b.job_id) || null;
    if (jobId) {
      const job = get('SELECT id, asset_id FROM job_cards WHERE id = ?', jobId);
      if (!job) return res.status(400).json({ error: 'Unknown job card' });
      if (assetId && job.asset_id && job.asset_id !== assetId) {
        return res.status(409).json({ error: 'That job card belongs to a different vehicle' });
      }
      if (!assetId) assetId = job.asset_id; // job given, vehicle left blank
    }
    if (!assetId && !unresolved) {
      return res.status(400).json({ error: 'Pick the vehicle / machine this request is for' });
    }
  }
  const mrnNo = String(b.mrn_no || '').trim() || nextMrnNo();
  if (get('SELECT id FROM mrn WHERE mrn_no = ?', mrnNo)) {
    return res.status(409).json({ error: `MRN number ${mrnNo} already exists` });
  }
  const source = b.purchase_source || null;
  if (source && !PURCHASE_SOURCES.includes(source)) return res.status(400).json({ error: 'Invalid purchase_source' });
  // Record the requesting storekeeper (also marks this as a live, in-flow MRN vs imported history).
  const ru = get('SELECT full_name, username FROM users WHERE id = ?', req.user.id);
  const reqBy = String(b.requested_by || '').trim() || (ru ? (ru.full_name || ru.username) : null);
  const result = tx(() => {
    const info = run(
      `INSERT INTO mrn (mrn_no, req_date, asset_id, project_id, job_id, purpose, requested_by, purchase_source, required_date, request_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mrnNo, b.req_date || new Date().toISOString().slice(0, 10), assetId || null,
      toInt(b.project_id), jobId, b.purpose || null, reqBy, source, b.required_date || null, requestType
    );
    const mrnId = info.lastInsertRowid;
    const lines = Array.isArray(b.lines) ? b.lines : [];
    const lineSrcs = new Set();
    for (const l of lines) {
      const ls = PURCHASE_SOURCES.includes(l.purchase_source) ? l.purchase_source : (source || null);
      if (ls) lineSrcs.add(ls);
      const line = itemLine(l);
      run('INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, category, category_id, purchase_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        mrnId, line.store_item_id, line.description, toNum(l.qty, 0), line.unit, line.category, line.category_id, ls);
    }
    // Header source = the single source if every line agrees, else leave the given/default.
    if (lineSrcs.size === 1) run('UPDATE mrn SET purchase_source = ? WHERE id = ?', [...lineSrcs][0], mrnId);
    // Requester's e-signature (the SK who raised it).
    const uSig = get('SELECT signature FROM users WHERE id = ?', req.user.id);
    if (uSig && uSig.signature) run('UPDATE mrn SET requested_sig = ? WHERE id = ?', uSig.signature, mrnId);
    return mrnId;
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: result, action: 'create', after: { mrn_no: mrnNo } });
  emitter.emit('request_updated', { mrn_id: result, mrn_no: mrnNo, action: 'create', approval_status: 'requested' });
  res.status(201).json({
    mrn: get('SELECT * FROM mrn WHERE id = ?', result),
    lines: all('SELECT * FROM mrn_lines WHERE mrn_id = ?', result),
    unresolved,
  });
}));

// Pending counts for notification badges. Registered BEFORE '/mrn/:id' so the
// literal path isn't captured by the :id param. 'pending' counts only LIVE MRNs
// awaiting the Workshop Engineer's certification (approval_status 'requested'
// with a real requester — imported history is excluded); 'certified' counts
// those awaiting the Operational Manager's approval.
router.get('/mrn/pending-count', asyncHandler((_req, res) => {
  const pending = get(`SELECT COUNT(*) c FROM mrn WHERE approval_status = 'requested' AND requested_by IS NOT NULL AND TRIM(requested_by) <> ''`).c;
  const certified = get(`SELECT COUNT(*) c FROM mrn WHERE approval_status = 'certified'`).c;
  res.json({ pending, certified, total_open: pending + certified });
}));

router.get('/mrn/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get(`SELECT m.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
                          j.job_no, j.status AS job_status
                     FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id
                     LEFT JOIN job_cards j ON j.id = m.job_id WHERE m.id = ?`, id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  res.json({
    mrn,
    lines: all(`SELECT ml.*, ${lineReceiptSql('ml.id')} FROM mrn_lines ml WHERE ml.mrn_id = ? ORDER BY ml.id`, id),
    grns: all('SELECT * FROM grn WHERE mrn_id = ? ORDER BY id', id),
    approvals: all('SELECT a.*, u.username FROM mrn_approvals a LEFT JOIN users u ON u.id = a.approver_id WHERE a.mrn_id = ? ORDER BY a.id', id),
  });
}));

// ---- MRN approval flow (e-signatures + logging) ----------------------------
// SK requests (create) → Workshop certifies → Operational Manager approves.
const signer = (userId) => { const u = get('SELECT full_name, username, signature FROM users WHERE id = ?', userId); return { name: u ? (u.full_name || u.username) : 'user', sig: u ? u.signature : null }; };

router.post('/mrn/:id/certify', requireRole('workshop', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  if (mrn.approval_status === 'approved') return res.status(409).json({ error: 'Already approved — cannot re-certify' });
  const s = signer(req.user.id); const sig = req.body.signature || s.sig || null;
  tx(() => {
    run(`UPDATE mrn SET approval_status = 'certified', certified_by = ?, certified_at = datetime('now'), certified_sig = ? WHERE id = ?`, s.name, sig, id);
    run(`INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, 'certify', 'workshop', ?, ?, ?, 'approved', ?)`, id, req.user.id, s.name, sig, req.body.reason || null);
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: id, action: 'certify', after: { certified_by: s.name }, reason: req.body.reason });
  emitter.emit('request_updated', { mrn_id: id, action: 'certify', approval_status: 'certified' });
  res.json(get('SELECT * FROM mrn WHERE id = ?', id));
}));

router.post('/mrn/:id/approve', requireRole('operational_manager', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  if (mrn.approval_status !== 'certified') return res.status(409).json({ error: 'MRN must be certified (Workshop Engineer) before Operational Manager approval' });
  const s = signer(req.user.id); const sig = req.body.signature || s.sig || null;
  tx(() => {
    run(`UPDATE mrn SET approval_status = 'approved', approved_by = ?, approved_at = datetime('now'), approved_sig = ? WHERE id = ?`, s.name, sig, id);
    run(`INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, 'approve', 'operational_manager', ?, ?, ?, 'approved', ?)`, id, req.user.id, s.name, sig, req.body.reason || null);
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: id, action: 'approve', after: { approved_by: s.name }, reason: req.body.reason });
  emitter.emit('request_updated', { mrn_id: id, action: 'approve', approval_status: 'approved' });
  res.json(get('SELECT * FROM mrn WHERE id = ?', id));
}));

router.post('/mrn/:id/reject', requireRole('workshop', 'operational_manager', 'manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });
  if (!String(req.body.reason || '').trim()) return res.status(400).json({ error: 'A reason is required to reject' });
  const s = signer(req.user.id);
  const asApprover = hasRole(req.user, 'operational_manager') || hasRole(req.user, 'manager');
  const stage = asApprover ? 'approve' : 'certify';
  tx(() => {
    run(`UPDATE mrn SET approval_status = 'rejected' WHERE id = ?`, id);
    run(`INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, signed_name, signature, decision, reason) VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?)`,
      id, stage, asApprover ? 'operational_manager' : 'workshop', req.user.id, s.name, req.body.signature || s.sig || null, req.body.reason);
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: id, action: 'reject', after: { by: s.name }, reason: req.body.reason });
  emitter.emit('request_updated', { mrn_id: id, action: 'reject', approval_status: 'rejected' });
  res.json(get('SELECT * FROM mrn WHERE id = ?', id));
}));

// Printable Material Requisition form (matches the paper EC1.ST.FO.01 layout).
router.get('/mrn/:id/print.html', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mrn = get('SELECT m.*, a.code AS asset_code, p.name AS project_name FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?', id);
  if (!mrn) return res.status(404).send('MRN not found');
  const lines = all('SELECT * FROM mrn_lines WHERE mrn_id = ? ORDER BY id', id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const srcLbl = (s) => (s === 'head_office' ? 'H/O' : s === 'local_purchase' ? 'Local' : '');
  const lineSrcs = [...new Set(lines.map((l) => l.purchase_source).filter(Boolean))];
  const srcTag = lineSrcs.length === 1 ? srcLbl(lineSrcs[0]) : lineSrcs.length > 1 ? 'Mixed' : srcLbl(mrn.purchase_source);
  const MIN_ROWS = 12;
  // The mark goes inside the description cell, not in a ninth column — this reproduces the
  // signed paper form EC1.ST.FO.01 and its column widths are fixed. But it must appear: whoever
  // reads the form has to see that this line was not part of what was approved.
  const addedMark = (l) => (l && l.added_after_approval
    ? ` <span style="font-size:9px;border:1px solid #333;padding:0 3px">ADDED AFTER APPROVAL${
      l.added_by ? ' — ' + esc(l.added_by) : ''}${l.added_at ? ', ' + esc(String(l.added_at).slice(0, 10)) : ''}</span>` : '');
  const rowHtml = (l, i) => `<tr>
    <td class="c">${i + 1}</td>
    <td>${esc(l ? l.description : '')}${addedMark(l)}</td>
    <td class="c">${esc(l ? (l.unit || 'nos') : '')}</td>
    <td class="c">${l ? srcLbl(l.purchase_source || mrn.purchase_source) : ''}</td>
    <td class="num">${l && l.qty_received ? l.qty_received : ''}</td>
    <td></td>
    <td class="num">${l && l.qty ? l.qty : ''}</td>
    <td></td></tr>`;
  const rows = [];
  for (let i = 0; i < Math.max(MIN_ROWS, lines.length); i++) rows.push(rowHtml(lines[i], i));
  // Render a signature image ONLY when it is a genuine base64 image data-URL. esc() here
  // does not escape double-quotes, so interpolating an arbitrary stored signature would
  // allow an attribute-breakout XSS (e.g. `x" onerror=...`); the allowlist forecloses it.
  const sigSrc = (v) => (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(String(v || '')) ? String(v) : '');
  const sigBlock = (title, name, dateVal, designation, sigImg, isLast) => {
    const safe = sigSrc(sigImg);
    return `
    <div class="${isLast ? '' : 'l'}"><b>${title}</b>
      ${safe ? `<div style="height:36px;margin:2px 0"><img src="${safe}" style="max-height:36px;max-width:160px"></div>`
        : '<div class="sig-line" style="margin-top:22px">Signature</div>'}
      <div class="rowline"><span class="k">Name:</span> ${name ? esc(name) + (safe ? '' : ' <span style="color:#0a7a0a;font-size:9px">&#10003; e-signed</span>') : ''}</div>
      <div class="rowline"><span class="k">Designation:</span> ${esc(designation)}</div>
      <div class="rowline"><span class="k">Date:</span> ${dateVal ? esc(d(dateVal)) : ''}</div></div>`;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>MRN ${esc(mrn.mrn_no)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: Arial, sans-serif; color: #000; margin: 0; font-size: 12px; }
  .sheet { border: 1.5px solid #000; }
  .hd { display: flex; align-items: stretch; border-bottom: 1.5px solid #000; }
  .hd .co { flex: 1; padding: 6px 10px; font-weight: bold; font-size: 15px; border-right: 1.5px solid #000; display:flex; align-items:center; }
  .hd .ti { width: 210px; padding: 6px 10px; font-weight: bold; font-size: 15px; display:flex; align-items:center; justify-content:center; }
  .meta { display: grid; grid-template-columns: 1fr 1fr 1fr; border-bottom: 1.5px solid #000; }
  .meta div { padding: 4px 10px; border-right: 1px solid #000; }
  .meta div:last-child { border-right: none; }
  .meta b { display:inline-block; min-width: 64px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
  th { background: #f0f0f0; font-size: 11px; text-align: center; }
  td.c { text-align: center; } td.num { text-align: right; }
  td:nth-child(2) { min-width: 260px; }
  tbody td { height: 22px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr 1fr; border-top: 1.5px solid #000; }
  .sign > div { padding: 8px 10px; }
  .sign .l { border-right: 1.5px solid #000; }
  .sig-line { margin-top: 26px; border-top: 1px solid #000; padding-top: 2px; font-size: 11px; }
  .foot { display:flex; justify-content: space-between; padding: 4px 10px; border-top: 1.5px solid #000; font-size: 10px; color:#222; }
  .rowline { display:flex; gap:6px; margin: 6px 0; font-size: 11px; } .rowline .k { min-width: 78px; }
  button { padding: 8px 14px; font-size: 14px; margin: 10px; cursor: pointer; }
  @media print { .noprint { display: none; } }
</style></head>
<body>
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
<div class="sheet">
  <div class="hd"><div class="co">Edward and Christie (Pvt) Ltd</div><div class="ti">Material Requisition</div></div>
  <div class="meta">
    <div><b>Project:</b> ${esc(mrn.project_name || mrn.purpose || '')}</div>
    <div><b>Date:</b> ${esc(d(mrn.req_date))}</div>
    <div><b>MR No.:</b> ${esc(mrn.mrn_no)} ${srcTag ? '&nbsp; <b>' + srcTag + '</b>' : ''}</div>
    <div><b>Vehicle:</b> ${esc(mrn.asset_code || '')}</div>
    <div><b>Required Date:</b> ${esc(d(mrn.required_date))}</div>
    <div><b>Requested by:</b> ${esc(mrn.requested_by || '')}</div>
  </div>
  <table>
    <thead><tr>
      <th style="width:34px">Item No.</th><th>Description</th><th style="width:40px">Unit</th><th style="width:44px">Source</th>
      <th style="width:66px">Received Qty (Cumulative)</th><th style="width:56px">Available Qty</th>
      <th style="width:56px">Required Qty</th><th style="width:66px">Required Date</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <div class="sign">
    ${sigBlock('Requested By', mrn.requested_by, mrn.req_date, 'Storekeeper', mrn.requested_sig, false)}
    ${sigBlock('Certified By', mrn.certified_by, mrn.certified_at, 'Workshop Engineer', mrn.certified_sig, false)}
    ${sigBlock('Approved By', mrn.approved_by, mrn.approved_at, 'Operational Manager', mrn.approved_sig, true)}
  </div>
  <div class="foot"><span>Doc. No.: EC1.ST.FO.01</span><span>Date of Issue: 2018.11.14</span></div>
</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

router.post('/mrn/:id/lines', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  require_(req.body, ['description', 'qty']);
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return res.status(404).json({ error: 'MRN not found' });

  // A SETTLED request is one nobody is supposed to change any more — either signed off by the
  // Operational Manager, or an imported record that predates the approval workflow and is
  // shown as "approved (imported)". Between them that is almost every request in the book:
  // 25 approved and 1,651 imported, against 32 still moving through the workflow.
  //
  // An admin may still put a forgotten item on one, because raising a second request for a
  // single line helps nobody and these records are live work — 166782 is still part-received
  // with an outstanding line. The approval is NOT disturbed, so receiving carries on; instead
  // the LINE carries the mark, and the approval trail records that the request grew later.
  // A reason is required: an override without one is just a hole.
  const isImported = mrn.approval_status === 'requested' && !String(mrn.requested_by || '').trim();
  const settled = mrn.approval_status === 'approved' || isImported;
  const isAdmin = hasRole(req.user, 'admin');
  if (settled && !isAdmin) {
    return res.status(409).json({
      error: isImported
        ? 'This request was already filed — only an admin can add an item to it now.'
        : APPROVED_FROZEN });
  }
  const reason = clean(req.body.reason);
  if (settled && !reason) {
    return res.status(400).json({ error: 'Say why this item is being added to a request already filed' });
  }
  if (!settled) {
    const g = guardEditable(id);
    if (g.error) return res.status(g.code).json({ error: g.error });
  }
  const approved = settled;   // the line is marked, and the trail written, the same way for both

  const line = itemLine(req.body);
  const qty = toNum(req.body.qty, 0);
  let recert = false;
  const info = tx(() => {
    const r = run(
      `INSERT INTO mrn_lines (mrn_id, store_item_id, description, qty, unit, category, category_id,
                              added_after_approval, added_by, added_at, added_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, line.store_item_id, line.description, qty, line.unit, line.category, line.category_id,
      approved ? 1 : 0, approved ? (req.user.username || null) : null,
      approved ? new Date().toISOString().slice(0, 16).replace('T', ' ') : null, approved ? reason : null);
    if (approved) {
      // On the approval record itself, so it is read alongside the signatures rather than
      // only in the audit log.
      run(`INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, signed_name, decision, reason)
           VALUES (?, 'amend', 'admin', ?, ?, 'approved', ?)`,
      id, req.user.id, req.user.username || null,
      `item added after approval: ${line.description} x${qty} — ${reason}`);
    } else {
      recert = resetCertification(mrn, req.user.id, 'an item');
    }
    return r;
  });
  audit.record({ userId: req.user.id, entity: 'mrn_line', entityId: info.lastInsertRowid, action: 'create',
    after: { mrn_id: id, description: line.description, qty, added_after_approval: approved ? 1 : 0 },
    reason: approved ? `added AFTER approval by admin — ${reason}` : 'added before approval' });
  if (approved) emitter.emit('request_updated', { mrn_id: id, action: 'amend', approval_status: 'approved' });
  res.status(201).json({
    ...get('SELECT * FROM mrn_lines WHERE id = ?', info.lastInsertRowid),
    recertification_required: recert,
    added_after_approval: approved,
  });
}));

// ---- GRN ------------------------------------------------------------------
router.get('/grn', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.mrn_id) { clauses.push('g.mrn_id = ?'); params.push(toInt(req.query.mrn_id)); }
  if (req.query.awaiting === '1') clauses.push('g.unit_price IS NULL');
  if (req.query.source && PURCHASE_SOURCES.includes(req.query.source)) { clauses.push('g.purchase_source_norm = ?'); params.push(req.query.source); }
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(g.grn_no LIKE ? OR g.description LIKE ? OR g.supplier LIKE ? OR m.mrn_no LIKE ? OR a.code LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT g.*, m.mrn_no, m.req_date AS mrn_req_date, a.code AS asset_code FROM grn g
       LEFT JOIN mrn m ON m.id = g.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
       ${where} ORDER BY g.id DESC LIMIT ${toInt(req.query.limit, 500)}`, ...params));
}));

// Count of GRN records still awaiting a price (for the badge / progress), split by source.
router.get('/grn/awaiting-count', asyncHandler((_req, res) =>
  res.json({
    awaiting: get('SELECT COUNT(*) c FROM grn WHERE unit_price IS NULL').c,
    total: get('SELECT COUNT(*) c FROM grn').c,
    by_source: all(`SELECT COALESCE(purchase_source_norm,'(unset)') source, COUNT(*) awaiting
                      FROM grn WHERE unit_price IS NULL GROUP BY 1 ORDER BY awaiting DESC`),
    awaiting_grn: get('SELECT COUNT(*) c FROM mrn_lines WHERE COALESCE(qty_received,0) < qty').c,
  })));

// Items requested but not yet received (awaiting a GRN), with the request date.
router.get('/awaiting-grn', asyncHandler((req, res) => {
  const clauses = ['COALESCE(ml.qty_received,0) < ml.qty', "COALESCE(m.approval_status,'') <> 'rejected'"];
  const params = [];
  if (req.query.source && PURCHASE_SOURCES.includes(req.query.source)) { clauses.push('COALESCE(ml.purchase_source, m.purchase_source) = ?'); params.push(req.query.source); }
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(m.mrn_no LIKE ? OR ml.description LIKE ? OR a.code LIKE ?)');
    params.push(like, like, like);
  }
  res.json(all(
    `SELECT ml.id, ml.description, ml.qty, ml.qty_received, ml.category,
            m.id AS mrn_id, m.mrn_no, m.req_date, COALESCE(ml.purchase_source, m.purchase_source) AS purchase_source, a.code AS asset_code,
            ${lineReceiptSql('ml.id')}
       FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.req_date DESC, m.mrn_no LIMIT ${toInt(req.query.limit, 500)}`, ...params));
}));

// ---- Pending purchases (partial + not received), split by purchase source ----
// Source of a pending line = the source of any GRN it already has (partial receipts),
// else the MRN header's intended purchase_source, else unsourced (chosen on receipt).
function pendingRows(query) {
  const outer = [];
  const params = [];
  const src = query.source;
  if (src === 'unsourced') outer.push('source IS NULL');
  else if (src && PURCHASE_SOURCES.includes(src)) { outer.push('source = ?'); params.push(src); }
  if (query.status === 'partial') outer.push("status = 'partial'");
  else if (query.status === 'not_received') outer.push("status = 'not_received'");
  if (query.q && String(query.q).trim()) {
    const like = '%' + String(query.q).trim() + '%';
    outer.push('(mrn_no LIKE ? OR description LIKE ? OR asset_code LIKE ?)');
    params.push(like, like, like);
  }
  const where = outer.length ? 'WHERE ' + outer.join(' AND ') : '';
  return all(
    `SELECT * FROM (
       SELECT ml.id, m.id AS mrn_id, m.mrn_no, m.req_date, a.code AS asset_code, ml.description, ml.category,
              ml.qty AS ordered, COALESCE(ml.qty_received,0) AS received, (ml.qty - COALESCE(ml.qty_received,0)) AS pending,
              CASE WHEN COALESCE(ml.qty_received,0) > 0 THEN 'partial' ELSE 'not_received' END AS status,
              COALESCE((SELECT g.purchase_source_norm FROM grn g WHERE g.mrn_line_id = ml.id AND g.purchase_source_norm IS NOT NULL LIMIT 1), ml.purchase_source, m.purchase_source) AS source,
              (SELECT g.supplier FROM grn g WHERE g.mrn_line_id = ml.id AND g.supplier IS NOT NULL LIMIT 1) AS supplier,
              ${lineReceiptSql('ml.id')}
         FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
        WHERE COALESCE(ml.qty_received,0) < ml.qty AND COALESCE(m.approval_status,'') <> 'rejected'
     ) ${where} ORDER BY source, req_date DESC, mrn_no LIMIT ${toInt(query.limit, 2000)}`, ...params);
}

router.get('/pending', asyncHandler((req, res) => {
  const rows = pendingRows(req.query);
  // For a filter line, hand the grid the numbers already known to be equivalent — the genuine
  // number, the HIFI one, every cross-reference on record, and anything previously accepted
  // against it. The storekeeper picks what is on the box instead of typing it.
  for (const r of rows) {
    const want = requestedPartNo(r.description);
    r.requested_part_no = want ? want.raw : null;
    r.equivalents = [];
    if (!want) continue;
    const hit = get('SELECT catalogue_id FROM filter_xrefs WHERE part_number_norm = ? LIMIT 1', want.norm)
      || get('SELECT id AS catalogue_id FROM filter_catalogue WHERE oem_pn_norm = ? OR hifi_pn_norm = ? LIMIT 1', want.norm, want.norm);
    if (!hit) continue;
    r.equivalents = all(
      `SELECT DISTINCT part_number, brand, ref_type FROM filter_xrefs
        WHERE catalogue_id = ? AND part_number_norm <> ?
          -- "TBD" is a placeholder sitting on a thousand catalogue rows: not a part number,
          -- and offering it would be worse than offering nothing.
          AND part_number_norm <> 'TBD' AND part_number NOT LIKE '%TBD%'
        ORDER BY ref_type, part_number LIMIT 25`,
      hit.catalogue_id, want.norm)
      .map((x) => ({ part_number: x.part_number, brand: x.brand, ref_type: x.ref_type }));
  }
  res.json(rows);
}));

// ---- Items received but still awaiting a price, split by purchase source ----
// A GRN with no unit_price is stock that landed without its cost, so it is missing from every
// job/vehicle total until the invoice price is keyed in.
function awaitingPriceRows(query) {
  const clauses = ['g.unit_price IS NULL'];
  const params = [];
  const src = query.source;
  if (src === 'unsourced') clauses.push('COALESCE(g.purchase_source_norm, ml.purchase_source, m.purchase_source) IS NULL');
  else if (src && PURCHASE_SOURCES.includes(src)) {
    clauses.push('COALESCE(g.purchase_source_norm, ml.purchase_source, m.purchase_source) = ?');
    params.push(src);
  }
  if (query.q && String(query.q).trim()) {
    const like = '%' + String(query.q).trim() + '%';
    clauses.push('(g.grn_no LIKE ? OR g.description LIKE ? OR g.supplier LIKE ? OR m.mrn_no LIKE ? OR a.code LIKE ?)');
    params.push(like, like, like, like, like);
  }
  return all(
    `SELECT g.id, g.grn_no, g.grn_date, g.description, g.received_part_no, g.qty, g.supplier, g.invoice_no, g.invoice_date, g.delivery_date,
            COALESCE(g.purchase_source_norm, ml.purchase_source, m.purchase_source) AS source,
            COALESCE(ml.category, si.category) AS category,
            m.id AS mrn_id, m.mrn_no, m.req_date, a.code AS asset_code
       FROM grn g
       LEFT JOIN mrn m ON m.id = g.mrn_id
       LEFT JOIN mrn_lines ml ON ml.id = g.mrn_line_id
       LEFT JOIN store_items si ON si.id = g.store_item_id
       LEFT JOIN assets a ON a.id = m.asset_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY source, COALESCE(g.delivery_date, g.created_at) DESC, g.id DESC
      LIMIT ${toInt(query.limit, 2000)}`, ...params);
}

router.get('/awaiting-price', asyncHandler((req, res) => res.json(awaitingPriceRows(req.query))));

router.get('/awaiting-price/summary', asyncHandler((_req, res) => {
  res.json(all(
    `SELECT COALESCE(g.purchase_source_norm, ml.purchase_source, m.purchase_source) AS source, COUNT(*) count, ROUND(SUM(g.qty),2) qty
       FROM grn g LEFT JOIN mrn m ON m.id = g.mrn_id LEFT JOIN mrn_lines ml ON ml.id = g.mrn_line_id
      WHERE g.unit_price IS NULL GROUP BY source`));
}));

// ---- shared report plumbing for the two stores lists (pending purchase / awaiting price) ----
const SRC_LABEL = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
const srcTitle = (s) => SRC_LABEL[s] || 'All Sources';

// Split rows into the three source buckets, honouring an explicit ?source= filter.
function bySource(rows, source) {
  const g = { head_office: [], local_purchase: [], unsourced: [] };
  for (const r of rows) (g[r.source] || g.unsourced).push(r);
  if (source && (SRC_LABEL[source] || source === 'unsourced')) {
    return [[source === 'unsourced' ? 'Not Sourced Yet' : SRC_LABEL[source], g[source] || []]];
  }
  return [['Head Office', g.head_office], ['Local Purchase', g.local_purchase], ['Not Sourced Yet', g.unsourced]];
}

function reportHtml(title, subtitle, sections, columns) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const body = sections.filter(([, list]) => list.length).map(([name, list]) => `
    <h2>${esc(name)} — ${list.length} item(s)</h2>
    <table><thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.header)}</th>`).join('')}</tr></thead>
    <tbody>${list.map((r) => `<tr>${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${esc(c.get(r))}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
  const total = sections.reduce((a, [, l]) => a + l.length, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;margin:22px;color:#111}h1{font-size:19px;margin:0 0 2px}
h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #333;padding-bottom:3px}
.meta{color:#555;font-size:12px;margin-bottom:8px}table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}
th,td{border:1px solid #bbb;padding:4px 7px;text-align:left}th{background:#eee}td.num,th.num{text-align:right}
button{padding:8px 14px;font-size:14px;cursor:pointer;margin-bottom:10px}@media print{.noprint{display:none}}</style></head>
<body><button class="noprint" onclick="window.print()">Print / Save PDF</button>
<h1>${esc(title)}</h1><div class="meta">Edward &amp; Christie (Pvt) Ltd — Badalgama W/S · ${esc(subtitle)} · ${total} item(s)</div>
${body || '<p>No items.</p>'}</body></html>`;
}

// Column sets shared by the Excel and print builds of each report.
const PENDING_COLS = [
  { header: 'MRN No', key: 'mrn_no', width: 16, get: (r) => r.mrn_no },
  { header: 'Req Date', key: 'req_date', width: 12, get: (r) => String(r.req_date || '').slice(0, 10) },
  { header: 'Vehicle', key: 'asset_code', width: 14, get: (r) => r.asset_code || '' },
  { header: 'Item', key: 'description', width: 42, get: (r) => r.description || '' },
  { header: 'Category', key: 'category', width: 18, get: (r) => r.category || '' },
  { header: 'Ordered', key: 'ordered', width: 10, num: true, get: (r) => r.ordered },
  { header: 'Received', key: 'received', width: 10, num: true, get: (r) => r.received },
  // Every line here is short, so this is the date of the part-delivery already in — not of the lot.
  { header: 'Received date', key: 'last_received', width: 32, get: (r) => exportReceived(r) },
  { header: 'Pending', key: 'pending', width: 10, num: true, get: (r) => r.pending },
  { header: 'Status', key: 'status_label', width: 14, get: (r) => (r.status === 'partial' ? 'Partial' : 'Not received') },
  { header: 'Supplier', key: 'supplier', width: 22, get: (r) => r.supplier || '' },
];
// A price-entry worksheet: what we know on the left, the columns to fill in on the right.
// (For unpriced stock the GRN no / supplier / invoice are exactly what's still missing, so those
// stay deliberately blank — "Ref" is the record id to key the price back against.)
const AWAITING_PRICE_COLS = [
  { header: 'Ref', key: 'ref', width: 9, num: true, get: (r) => r.id },
  { header: 'GRN No', key: 'grn_no', width: 14, get: (r) => r.grn_no || '' },
  { header: 'GRN Date', key: 'grn_date', width: 12, get: (r) => String(r.grn_date || '').slice(0, 10) },
  { header: 'Received', key: 'delivery_date', width: 12, get: (r) => String(r.delivery_date || '').slice(0, 10) },
  { header: 'MRN No', key: 'mrn_no', width: 16, get: (r) => r.mrn_no || '' },
  { header: 'Vehicle', key: 'asset_code', width: 14, get: (r) => r.asset_code || '' },
  { header: 'Item', key: 'description', width: 42, get: (r) => r.description || '' },
  { header: 'Category', key: 'category', width: 18, get: (r) => r.category || '' },
  { header: 'Qty', key: 'qty', width: 8, num: true, get: (r) => r.qty },
  { header: 'Supplier', key: 'supplier', width: 22, get: (r) => r.supplier || '' },
  { header: 'Invoice No', key: 'invoice_no', width: 16, get: (r) => r.invoice_no || '' },
  { header: 'Unit Price (Rs)', key: 'unit_price', width: 15, num: true, get: () => '' },
  { header: 'Value (Rs)', key: 'value', width: 14, num: true, get: () => '' },
];

const xlsxSheets = (sections, cols) => sections.filter(([, l]) => l.length).map(([name, list]) => ({
  name: name.slice(0, 31),
  columns: cols.map((c) => ({ header: c.header, key: c.key, width: c.width })),
  rows: list.map((r) => Object.fromEntries(cols.map((c) => [c.key, c.get(r)]))),
}));

// Pending purchases → Excel (one sheet per purchase source).
router.get('/pending/export.xlsx', asyncHandler(async (req, res) => {
  const rows = pendingRows({ ...req.query, limit: 5000 });
  const sections = bySource(rows, req.query.source);
  const sheets = xlsxSheets(sections, PENDING_COLS);
  await sendXlsx(res, `pending-purchases-${req.query.source || 'all'}.xlsx`,
    sheets.length ? sheets : [{ name: 'Pending', columns: PENDING_COLS.map((c) => ({ header: c.header, key: c.key, width: c.width })), rows: [] }]);
}));

// Items awaiting a price → Excel (one sheet per purchase source; blank Unit Price column to fill in).
router.get('/awaiting-price/export.xlsx', asyncHandler(async (req, res) => {
  const rows = awaitingPriceRows({ ...req.query, limit: 5000 });
  const sections = bySource(rows, req.query.source);
  const sheets = xlsxSheets(sections, AWAITING_PRICE_COLS);
  await sendXlsx(res, `awaiting-price-${req.query.source || 'all'}.xlsx`,
    sheets.length ? sheets : [{ name: 'Awaiting price', columns: AWAITING_PRICE_COLS.map((c) => ({ header: c.header, key: c.key, width: c.width })), rows: [] }]);
}));

// Items awaiting a price → printable (Save as PDF from the browser).
router.get('/awaiting-price/print.html', asyncHandler((req, res) => {
  const rows = awaitingPriceRows({ ...req.query, limit: 5000 });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(reportHtml(
    `Items Awaiting Price — ${srcTitle(req.query.source)}`,
    'received into stores without a unit price — these are missing from job & vehicle costs until priced',
    bySource(rows, req.query.source), AWAITING_PRICE_COLS));
}));

router.get('/pending/summary', asyncHandler((_req, res) => {
  res.json(all(
    `SELECT source, status, COUNT(*) count FROM (
       SELECT CASE WHEN COALESCE(ml.qty_received,0) > 0 THEN 'partial' ELSE 'not_received' END AS status,
              COALESCE((SELECT g.purchase_source_norm FROM grn g WHERE g.mrn_line_id = ml.id AND g.purchase_source_norm IS NOT NULL LIMIT 1), ml.purchase_source, m.purchase_source) AS source
         FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
        WHERE COALESCE(ml.qty_received,0) < ml.qty AND COALESCE(m.approval_status,'') <> 'rejected'
     ) GROUP BY source, status`));
}));

// Set an MRN's intended purchase source (so not-received items can be planned/printed).
// ---- editing a request before it is approved -------------------------------
// A request can be corrected right up until the Operational Manager approves it. Once
// approved it is the authority to spend, so it is frozen — a change then means a new request.
//
// Editing a CERTIFIED request sends it back for certification. The Workshop Engineer signed
// for particular items and quantities; leaving that signature attached to different ones would
// make the record say something nobody agreed to.
const APPROVED_FROZEN = 'This request is approved — it cannot be changed. Raise a new request for anything further.';

function guardEditable(id) {
  const mrn = get('SELECT * FROM mrn WHERE id = ?', id);
  if (!mrn) return { error: 'MRN not found', code: 404 };
  if (mrn.approval_status === 'approved') return { error: APPROVED_FROZEN, code: 409 };
  return { mrn };
}

/** Undo a certification because the request has changed under it. */
function resetCertification(mrn, userId, what) {
  if (mrn.approval_status !== 'certified') return false;
  run(`UPDATE mrn SET approval_status = 'requested', certified_by = NULL, certified_at = NULL, certified_sig = NULL WHERE id = ?`, mrn.id);
  run(`INSERT INTO mrn_approvals (mrn_id, stage, role, approver_id, signed_name, decision, reason)
       VALUES (?, 'certify', 'workshop', ?, ?, 'rejected', ?)`,
    mrn.id, userId, mrn.certified_by || null, `certification withdrawn — ${what} changed after signing`);
  emitter.emit('request_updated', { mrn_id: mrn.id, action: 'edit', approval_status: 'requested' });
  return true;
}

const MRN_EDITABLE = ['purpose', 'requested_by', 'required_date', 'req_date', 'asset_id', 'project_id', 'job_id'];

router.patch('/mrn/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const g = guardEditable(id);
  if (g.error) return res.status(g.code).json({ error: g.error });
  const mrn = g.mrn;

  const sets = []; const params = []; const before = {}; const after = {};
  if (req.body.purchase_source !== undefined) {
    const s = req.body.purchase_source || null;
    if (s && !PURCHASE_SOURCES.includes(s)) return res.status(400).json({ error: 'Invalid purchase_source' });
    sets.push('purchase_source = ?'); params.push(s);
    before.purchase_source = mrn.purchase_source; after.purchase_source = s;
  }
  for (const c of MRN_EDITABLE) {
    if (req.body[c] === undefined) continue;
    const v = ['asset_id', 'project_id', 'job_id'].includes(c)
      ? (toInt(req.body[c]) || null)
      : clean(req.body[c]);
    sets.push(`${c} = ?`); params.push(v);
    before[c] = mrn[c]; after[c] = v;
  }
  if (!sets.length) return res.json(get('SELECT * FROM mrn WHERE id = ?', id));

  // Changing only the purchase source is a routing detail, not a change to what was asked
  // for — it must not throw away a certification.
  const material = Object.keys(after).some((k) => k !== 'purchase_source');
  let recert = false;
  tx(() => {
    run(`UPDATE mrn SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (material) recert = resetCertification(mrn, req.user.id, 'the request');
  });
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: id, action: 'update', before, after,
    reason: recert ? 'edited before approval — certification withdrawn' : 'edited before approval' });
  res.json({ ...get('SELECT * FROM mrn WHERE id = ?', id), recertification_required: recert });
}));

const LINE_EDITABLE = ['description', 'unit', 'category'];

router.patch('/mrn/line/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get('SELECT * FROM mrn_lines WHERE id = ?', id);
  if (!line) return res.status(404).json({ error: 'MRN line not found' });
  const g = guardEditable(line.mrn_id);
  if (g.error) return res.status(g.code).json({ error: g.error });

  const sets = []; const params = []; const before = {}; const after = {};
  if (req.body.purchase_source !== undefined) {
    const s = req.body.purchase_source || null;
    if (s && !PURCHASE_SOURCES.includes(s)) return res.status(400).json({ error: 'Invalid purchase_source' });
    sets.push('purchase_source = ?'); params.push(s);
    before.purchase_source = line.purchase_source; after.purchase_source = s;
  }
  if (req.body.qty !== undefined) {
    const q = toNum(req.body.qty, 0);
    if (!(q > 0)) return res.status(400).json({ error: 'Quantity must be more than 0' });
    // Some of it may already be on the shelf; the request cannot claim less than that.
    const rec = Number(line.qty_received) || 0;
    if (q < rec) return res.status(409).json({ error: `${rec} already received — the quantity cannot go below that` });
    sets.push('qty = ?'); params.push(q);
    before.qty = line.qty; after.qty = q;
  }
  for (const c of LINE_EDITABLE) {
    if (req.body[c] === undefined) continue;
    sets.push(`${c} = ?`); params.push(clean(req.body[c]));
    before[c] = line[c]; after[c] = clean(req.body[c]);
  }
  if (!sets.length) return res.json(get('SELECT * FROM mrn_lines WHERE id = ?', id));

  const material = Object.keys(after).some((k) => k !== 'purchase_source');
  let recert = false;
  tx(() => {
    run(`UPDATE mrn_lines SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (material) recert = resetCertification(g.mrn, req.user.id, 'an item');
  });
  audit.record({ userId: req.user.id, entity: 'mrn_line', entityId: id, action: 'update', before, after,
    reason: recert ? 'edited before approval — certification withdrawn' : 'edited before approval' });
  res.json({ ...get('SELECT * FROM mrn_lines WHERE id = ?', id), recertification_required: recert });
}));

// Remove a line from a request that has not been approved. Anything already received stays —
// deleting the line would orphan a receipt that is physically on the shelf.
router.delete('/mrn/line/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const line = get('SELECT * FROM mrn_lines WHERE id = ?', id);
  if (!line) return res.status(404).json({ error: 'MRN line not found' });
  const g = guardEditable(line.mrn_id);
  if (g.error) return res.status(g.code).json({ error: g.error });
  if ((Number(line.qty_received) || 0) > 0) {
    return res.status(409).json({ error: `${line.qty_received} already received against this item — it cannot be removed` });
  }
  if (get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ?', line.mrn_id).c <= 1) {
    return res.status(409).json({ error: 'A request needs at least one item — reject the request instead of emptying it' });
  }
  let recert = false;
  tx(() => {
    run('DELETE FROM mrn_lines WHERE id = ?', id);
    recert = resetCertification(g.mrn, req.user.id, 'an item');
  });
  audit.record({ userId: req.user.id, entity: 'mrn_line', entityId: id, action: 'delete',
    before: { description: line.description, qty: line.qty, mrn_id: line.mrn_id },
    reason: 'removed before approval' });
  res.json({ ok: true, recertification_required: recert });
}));

// Printable pending-purchases list, grouped by source.
router.get('/pending/print.html', asyncHandler((req, res) => {
  const rows = pendingRows({ ...req.query, limit: 5000 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  const label = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
  const groups = { head_office: [], local_purchase: [], unsourced: [] };
  for (const r of rows) (groups[r.source] || groups.unsourced).push(r);
  const section = (title, list) => !list.length ? '' : `
    <h2>${esc(title)} — ${list.length} item(s)</h2>
    <table><thead><tr><th>MRN</th><th>Req Date</th><th>Vehicle</th><th>Item</th><th class="num">Ordered</th><th class="num">Received</th><th>Received date</th><th class="num">Pending</th><th>Status</th><th>Supplier</th></tr></thead>
    <tbody>${list.map((r) => `<tr><td>${esc(r.mrn_no)}</td><td>${d(r.req_date)}</td><td>${esc(r.asset_code || '')}</td><td>${esc(r.description)}</td><td class="num">${r.ordered}</td><td class="num">${r.received}</td><td>${esc(exportReceived(r))}</td><td class="num"><b>${r.pending}</b></td><td>${r.status === 'partial' ? 'Partial' : 'Not received'}</td><td>${esc(r.supplier || '')}</td></tr>`).join('')}</tbody></table>`;
  const which = req.query.source && label[req.query.source] ? label[req.query.source] : 'All Sources';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pending Purchases — ${esc(which)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;margin:22px;color:#111}h1{font-size:19px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #333;padding-bottom:3px}
.meta{color:#555;font-size:12px;margin-bottom:8px}table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}th,td{border:1px solid #bbb;padding:4px 7px;text-align:left}th{background:#eee}td.num,th.num{text-align:right}
button{padding:8px 14px;font-size:14px;cursor:pointer;margin-bottom:10px}@media print{.noprint{display:none}}</style></head>
<body><button class="noprint" onclick="window.print()">Print / Save PDF</button>
<h1>Pending Purchases — ${esc(which)}</h1>
<div class="meta">Edward &amp; Christie · items requested but not fully received (partial + not received) · ${rows.length} item(s)</div>
${req.query.source ? section(which, groups[req.query.source] || []) : section('Head Office', groups.head_office) + section('Local Purchase', groups.local_purchase) + section('Not Sourced Yet', groups.unsourced)}
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

/**
 * May this user take THIS request line into stores? Only tyre and battery lines are asked about;
 * everything else is governed by `stores` as before, so a tightened tyre cell can never stop a
 * storekeeper receiving an ordinary part. A line that is not a tyre or a battery — or a receipt
 * with no request line behind it at all — is always allowed through here.
 */
function tbGrnAllowed(user, mrnLineId) {
  if (!mrnLineId) return true;
  if (!user || !user.roles) return false;
  if (user.roles.includes('admin')) return true;
  const line = get('SELECT category FROM mrn_lines WHERE id = ?', mrnLineId);
  const cat = String((line && line.category) || '').toLowerCase();
  if (!/tyre|batter/.test(cat)) return true;
  return permissions.meets(permissions.levelForRoles(user.roles, 'tb_grn'), 'edit');
}

router.post('/grn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['qty']);
  const source = b.purchase_source;
  if (source && !PURCHASE_SOURCES.includes(source)) {
    return res.status(400).json({ error: 'Invalid purchase_source' });
  }
  // TAKING A TYRE OR A BATTERY IN IS ITS OWN PERMISSION. They are high-value and traceable, and
  // the owner asked for receiving to be grantable apart from the rest of stores — so the line's
  // own category decides which board cell applies. Everything else on a request is unaffected,
  // which is why this is checked HERE rather than by gating the whole route.
  if (!tbGrnAllowed(req.user, toInt(b.mrn_line_id))) {
    return res.status(403).json({
      error: 'Your role may not take tyres or batteries into stores — ask an admin for "T&B · Receive (GRN)"',
    });
  }
  const result = tx(() => {
    const info = run(
      `INSERT INTO grn (grn_no, grn_date, mrn_id, mrn_line_id, store_item_id, description, qty, unit_price, supplier, invoice_no, invoice_date, delivery_date, purchase_source, purchase_source_norm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.grn_no || null, b.grn_date || null, toInt(b.mrn_id), toInt(b.mrn_line_id), toInt(b.store_item_id), b.description || null,
      toNum(b.qty, 0), b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price),
      b.supplier || null, b.invoice_no || null, b.invoice_date || null,
      b.delivery_date || new Date().toISOString().slice(0, 10), source || null, purchaseSourceNorm(source)
    );
    if (b.mrn_line_id) {
      run('UPDATE mrn_lines SET qty_received = qty_received + ? WHERE id = ?', toNum(b.qty, 0), toInt(b.mrn_line_id));
      const line = get('SELECT mrn_id FROM mrn_lines WHERE id = ?', toInt(b.mrn_line_id));
      if (line) {
        const open = get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ? AND qty_received < qty', line.mrn_id);
        const any = get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ? AND qty_received > 0', line.mrn_id);
        const status = open.c === 0 ? 'received' : (any.c > 0 ? 'partially_received' : 'open');
        run('UPDATE mrn SET status = ? WHERE id = ?', status, line.mrn_id);
      }
    }
    return info.lastInsertRowid;
  });
  audit.record({ userId: req.user.id, entity: 'grn', entityId: result, action: 'create' });
  res.status(201).json(get('SELECT * FROM grn WHERE id = ?', result));
}));

// ---- Unified stock: one position per inventory section ---------------------
// oil | filter | battery | tyre | general — each answers the same four questions
// (on order → received → issued → balance) over the shared movement table.
router.get('/stock/summary', asyncHandler((_req, res) => {
  res.json(stock.SECTIONS.map((s) => stock.summary(s)));
}));

router.get('/stock/:section', asyncHandler((req, res) => {
  const section = String(req.params.section || '').toLowerCase();
  if (!stock.SECTIONS.includes(section)) return res.status(400).json({ error: 'Unknown section' });
  res.json({
    summary: stock.summary(section),
    items: stock.items(section, req.query.q, toInt(req.query.limit, 500)),
  });
}));

// Every movement — the audit trail. ?item_key= narrows to one item, ?kind=out to issues only.
router.get('/stock/:section/moves', asyncHandler((req, res) => {
  const section = String(req.params.section || '').toLowerCase();
  if (!stock.SECTIONS.includes(section)) return res.status(400).json({ error: 'Unknown section' });
  res.json(stock.moves(section, {
    item_key: req.query.item_key, kind: req.query.kind, q: req.query.q, limit: toInt(req.query.limit, 500),
  }));
}));

// Recalculate every movement from the underlying records (idempotent).
router.post('/stock/rebuild', requireRole('storekeeper', 'manager'), asyncHandler((req, res) => {
  const rep = stock.rebuild({ wipe: true });
  audit.record({ userId: req.user.id, entity: 'stock_moves', action: 'rebuild', after: rep });
  res.json(rep);
}));

// Item search for the issue form — code, name or supplier part number, any section.
router.get('/stock-items/search', asyncHandler((req, res) => {
  res.json(stock.searchItems(req.query.q, String(req.query.section || '').toLowerCase(), toInt(req.query.limit, 25)));
}));

// What was bought for this vehicle / job / MRN and is still on the shelf. Feeds the panel in
// the issue form: the storekeeper picks from what is physically there instead of hunting the
// catalogue for the right name.
router.get('/received', asyncHandler((req, res) => {
  res.json(stock.receivedLines({
    assetId: toInt(req.query.asset_id) || null,
    jobId: toInt(req.query.job_id) || null,
    mrn: req.query.mrn || null,
    q: req.query.q || null,
    limit: toInt(req.query.limit, 200),
    includeDone: req.query.include_done === '1',
  }));
}));

// Rebuild the item registry (new codes for anything not yet registered; existing codes kept).
router.post('/stock-items/sync', requireRole('storekeeper', 'manager'), asyncHandler((req, res) => {
  const rep = stock.syncItems();
  audit.record({ userId: req.user.id, entity: 'stock_items', action: 'sync', after: rep });
  res.json(rep);
}));

// ---- Issue stock ------------------------------------------------------------
// Several lines in one go, against a job card OR a vehicle (either is enough). Each line
// deducts its section's balance. Going negative is reported, not blocked — the part is in
// the storekeeper's hand, so the record follows reality and gets corrected later.
router.post('/stock-issue', requireRole('storekeeper', 'workshop', 'manager'), asyncHandler((req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) return res.status(400).json({ error: 'Add at least one item to issue' });

  let jobId = toInt(b.job_id) || null;
  let assetId = toInt(b.asset_id) || null;
  if (!jobId && !assetId) return res.status(400).json({ error: 'Choose the job card or the vehicle this issue is for' });

  // Every issue must land on a cost object, or its money is invisible to the job-based
  // reports. A job card knows its own vehicle; a bare vehicle is resolved to that
  // vehicle's open card, falling back to the General Workshop container.
  let landedOn = null;
  if (jobId) {
    const j = get('SELECT id, job_no, status, asset_id FROM job_cards WHERE id = ?', jobId);
    if (!j) return res.status(400).json({ error: 'Unknown job card' });
    // A closed card can still take a late issue, but only deliberately.
    if ((j.status === 'CLOSED' || j.status === 'REJECTED') && !b.allow_closed) {
      return res.status(409).json({
        error: `Job ${j.job_no} is ${j.status} — confirm to record a late issue against it`,
        job_no: j.job_no, job_status: j.status, needs_confirm: true,
      });
    }
    if (!assetId) assetId = j.asset_id;
  } else {
    const open = jobstate.openJobFor(assetId);
    jobId = open ? open.id : generalWorkshopJobId();
    landedOn = open ? open.job_no : 'General Workshop';
  }
  const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.issue_date || '')) ? b.issue_date : new Date().toISOString().slice(0, 10);
  const issuedBy = clean(b.issued_by) || null;
  const [yr, mo] = issueDate.split('-').map((n) => parseInt(n, 10)); // rollup period
  const validPeriod = yr >= 1900 && mo >= 1 && mo <= 12;

  const done = [];
  const warnings = [];
  const skipped = [];

  // Hand over something that was bought for this vehicle.
  //
  // The cost is NOT re-booked. A received line is already a source_type='grn' job_part on the
  // job the MRN was raised for (3,444 of them), and computeJobCost sums every job_part — so
  // adding an 'issue' part here would charge the job twice for one part. Issuing records the
  // physical handover and takes the stock out; only a receipt that never landed on a job (no
  // job_part exists) gets one created, because that cost is genuinely unaccounted for.
  const issueReceivedLine = (ln, qty) => {
    const rec = stock.receivedLine(toInt(ln.grn_id));
    if (!rec) { skipped.push(`receipt ${ln.grn_id} no longer exists — nothing issued for it`); return; }
    const price = ln.unit_price === '' || ln.unit_price == null ? rec.unit_price : toNum(ln.unit_price);
    const linePrice = price == null ? null : n2price(price);
    if (qty > rec.remaining + 0.001) {
      warnings.push(`${rec.description}: issuing ${qty} but only ${rec.remaining} of MRN ${rec.mrn_no} is left`);
    }
    const cat = categories.resolve({ category: rec.category || SECTION_CATEGORY[rec.section] });

    const info = run(
      `INSERT INTO issues (asset_id, job_id, grn_id, store_item_id, description, qty, unit_price, issue_date, issued_by, category, category_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assetId, jobId, rec.grn_id, rec.store_item_id || null, rec.description, qty, linePrice, issueDate, issuedBy,
      cat.category, cat.category_id);

    // Was the cost already booked AT RECEIPT? That is specifically a source_type='grn' part —
    // matching any job_part would also match the 'issue' part this very handler writes, so the
    // second half of a split handover would silently lose its cost.
    const alreadyCosted = get(
      "SELECT 1 v FROM job_parts WHERE mrn_line_id = ? AND source_type = 'grn' LIMIT 1", rec.mrn_line_id);
    if (!alreadyCosted) {
      run(
        `INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price, is_external_repair)
         VALUES (?, 'issue', ?, ?, ?, ?, ?, 0)`,
        jobId, info.lastInsertRowid, rec.mrn_line_id, rec.description, qty, linePrice);
    }

    // The per-vehicle rollup is bumped EVERY time, including when the job was already charged.
    // The two are different views on purpose: computeJobCost reads job_parts, while
    // vehicle_monthly_costs.parts_cost is an absolute Σ(issues.qty × unit_price) — that is the
    // basis migrate/015 recomputes from, so skipping the bump here would make the stored rollup
    // disagree with its own definition and shift silently the next time migrations are run.
    const lineCost = qty * (linePrice || 0);
    if (assetId && validPeriod && lineCost) {
      run(
        `INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id, year, month) DO UPDATE SET
           parts_cost = parts_cost + excluded.parts_cost,
           total_cost = total_cost + excluded.parts_cost,
           updated_at = datetime('now')`,
        assetId, yr, mo, lineCost, lineCost);
    }

    // Out of the same bucket the receipt went into, so the ledger stays self-consistent even
    // where the catalogue key is coarser than the receipt description.
    run(
      `INSERT INTO stock_moves (section, kind, item_key, item_name, qty, unit_price, txn_date,
                                asset_id, job_id, mrn_line_id, grn_id, store_item_id, ref, note, source_table, source_id, counts)
       VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issues', ?, ?)`,
      rec.section, rec.item_key, rec.description, qty, linePrice, issueDate,
      assetId, jobId, rec.mrn_line_id, rec.grn_id, rec.store_item_id || null,
      rec.mrn_no ? 'MRN ' + rec.mrn_no : null, clean(ln.note) || null, info.lastInsertRowid, rec.counts);

    done.push({
      code: 'MRN ' + rec.mrn_no, name: rec.description, section: rec.section, qty,
      from_receipt: true, costed_now: !alreadyCosted,
      balance_before: rec.remaining, balance_after: Math.round((rec.remaining - qty) * 100) / 100,
    });
  };

  tx(() => {
    for (const ln of lines) {
      const qty = toNum(ln.qty, 0);
      if (!(qty > 0)) continue;

      // A line is either a catalogue item or a specific RECEIPT being handed over. The two
      // behave differently on cost — see the grn branch below — so they are resolved apart.
      if (ln.grn_id) { issueReceivedLine(ln, qty); continue; }

      const item = get('SELECT * FROM stock_items WHERE id = ?', toInt(ln.stock_item_id));
      if (!item) { skipped.push(`item ${ln.stock_item_id} is not in the catalogue — nothing issued for it`); continue; }

      const before = get(
        `SELECT ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0
                WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),0),2) v
           FROM stock_moves WHERE section = ? AND item_key = ?`, item.section, item.item_key).v;
      const price = ln.unit_price === '' || ln.unit_price == null ? item.unit_price : toNum(ln.unit_price);

      const linePrice = price == null ? null : n2price(price);
      const cat = categories.resolve({ category_id: ln.category_id, category: ln.category || SECTION_CATEGORY[item.section] });

      // The issue document.
      const info = run(
        `INSERT INTO issues (asset_id, job_id, store_item_id, description, qty, unit_price, issue_date, issued_by, category, category_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        assetId, jobId, item.source_table === 'store_items' ? item.source_id : null,
        item.name, qty, linePrice, issueDate, issuedBy, cat.category, cat.category_id);

      // Same three writes POST /issues makes, for the same reasons: the job_part is what
      // makes the line count EXACTLY ONCE in computeJobCost, and the rollup upsert moves a
      // component and the total together so total_cost = Σ(components) holds.
      run(
        `INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, is_external_repair)
         VALUES (?, 'issue', ?, ?, ?, ?, 0)`,
        jobId, info.lastInsertRowid, item.name, qty, linePrice);
      const lineCost = qty * (linePrice || 0);
      if (assetId && validPeriod) {
        run(
          `INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(asset_id, year, month) DO UPDATE SET
             parts_cost = parts_cost + excluded.parts_cost,
             total_cost = total_cost + excluded.parts_cost,
             updated_at = datetime('now')`,
          assetId, yr, mo, lineCost, lineCost);
      }

      // The stock movement — this is what deducts the balance and shows in the section view.
      run(
        `INSERT INTO stock_moves (section, kind, item_key, item_name, qty, unit_price, txn_date,
                                  asset_id, job_id, store_item_id, ref, note, source_table, source_id, counts)
         VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issues', ?, 1)`,
        item.section, item.item_key, item.name, qty, price == null ? null : n2price(price), issueDate,
        assetId, jobId, item.source_table === 'store_items' ? item.source_id : null,
        item.code, clean(ln.note) || null, info.lastInsertRowid);

      const after = Math.round((before - qty) * 100) / 100;
      done.push({ code: item.code, name: item.name, section: item.section, qty, balance_before: before, balance_after: after });
      if (after < 0) warnings.push(`${item.code} ${item.name}: stock is now ${after}`);
    }
  });
  if (!done.length) {
    return res.status(400).json({ error: skipped.length ? skipped.join('; ') : 'Nothing to issue — pick an item and a quantity' });
  }
  // A line that could not be resolved is reported, never dropped in silence — a 201 with a
  // short list reads as "all done" and the storekeeper would never know one item is missing.
  for (const s of skipped) warnings.push(s);

  // Stored job totals feed the job-based reports; computeJobCost is live but the reports
  // read the snapshot columns.
  try { costing.refreshJobTotals(jobId); } catch (e) { /* non-fatal */ }
  audit.record({ userId: req.user.id, entity: 'issues', action: 'issue', after: { job_id: jobId, asset_id: assetId, lines: done.length } });
  emitter.emit('dashboard_refresh', { reason: 'stock_issue' });
  res.status(201).json({ ok: true, issued: done, warnings, landed_on: landedOn });
}));

// ---- Bulk save for the Receiving & Prices workspace ------------------------
// One request for a screenful of edits, instead of a popup per row. Both are transactional:
// either the whole batch lands or nothing does.

// Price (and invoice details) for many existing receipts at once.
// Body: { rows: [{ id, unit_price, supplier?, invoice_no?, invoice_date?, purchase_source? }] }
router.post('/grn/bulk-price', requireRole('storekeeper'), asyncHandler((req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to save' });
  let saved = 0;
  const touched = [];
  tx(() => {
    for (const r of rows) {
      const id = toInt(r.id);
      if (!id) continue;
      const before = get('SELECT id, unit_price, priced_at FROM grn WHERE id = ?', id);
      if (!before) continue;
      const sets = [], params = [];
      if (r.unit_price !== undefined) {
        sets.push('unit_price = ?');
        params.push(r.unit_price === '' || r.unit_price === null ? null : toNum(r.unit_price));
      }
      for (const c of ['supplier', 'invoice_no', 'invoice_date', 'grn_no', 'grn_date', 'delivery_date']) {
        if (r[c] !== undefined) { sets.push(c + ' = ?'); params.push(r[c] === '' ? null : String(r[c])); }
      }
      if (r.purchase_source !== undefined) {
        const s = r.purchase_source || null;
        if (s && !PURCHASE_SOURCES.includes(s)) continue;
        sets.push('purchase_source = ?'); params.push(s);
        sets.push('purchase_source_norm = ?'); params.push(purchaseSourceNorm(s));
      }
      // Stamp the moment a price first lands, so "awaiting price" ages honestly.
      if (r.unit_price !== undefined && r.unit_price !== '' && r.unit_price !== null
          && before.unit_price == null && before.priced_at == null) sets.push("priced_at = datetime('now')");
      if (!sets.length) continue;
      run(`UPDATE grn SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
      touched.push(id); saved++;
    }
  });
  if (saved) audit.record({ userId: req.user.id, entity: 'grn', action: 'bulk_price', after: { count: saved, ids: touched.slice(0, 50) } });
  res.json({ ok: true, saved });
}));

// Receive many MRN lines at once (one row per line the storekeeper filled in).
// Body: { rows: [{ mrn_line_id, qty, unit_price?, supplier?, invoice_no?, invoice_date?,
//                  delivery_date?, grn_no?, purchase_source? }] }
router.post('/grn/bulk-receive', requireRole('storekeeper'), asyncHandler((req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to receive' });
  const created = [];
  const mrnIds = new Set();
  const skipped = [];
  tx(() => {
    for (const r of rows) {
      const lineId = toInt(r.mrn_line_id);
      const qty = toNum(r.qty, 0);
      if (!lineId || !(qty > 0)) continue;
      const line = get('SELECT id, mrn_id, description, qty, COALESCE(qty_received,0) qty_received FROM mrn_lines WHERE id = ?', lineId);
      if (!line) continue;
      // Never let a receipt take a line past what was asked for — flag it instead.
      if (line.qty_received + qty > line.qty + 0.0001) {
        skipped.push({ mrn_line_id: lineId, reason: `would exceed the requested ${line.qty} (already ${line.qty_received})` });
        continue;
      }
      const src = r.purchase_source && PURCHASE_SOURCES.includes(r.purchase_source) ? r.purchase_source : null;
      // A filter often arrives as an equivalent of the number requested. Record the number on
      // the box; the requested text stays in `description` so the two can always be compared.
      const receivedPart = clean(r.received_part_no);
      if (receivedPart) learnCrossRef(line.description, receivedPart, req.user && req.user.id);
      const info = run(
        `INSERT INTO grn (grn_no, grn_date, mrn_id, mrn_line_id, description, received_part_no, qty, unit_price, supplier,
                          invoice_no, invoice_date, delivery_date, purchase_source, purchase_source_norm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.grn_no || null, r.grn_date || null, line.mrn_id, lineId, line.description || null, receivedPart, qty,
        r.unit_price === undefined || r.unit_price === '' || r.unit_price === null ? null : toNum(r.unit_price),
        // The grid pre-fills the received date with today and only sends a field the user
        // actually changed, so an untouched date must not land as NULL — that is the date the
        // whole receiving history is read by.
        r.supplier || null, r.invoice_no || null, r.invoice_date || null,
        r.delivery_date || new Date().toISOString().slice(0, 10), src, purchaseSourceNorm(src));
      run('UPDATE mrn_lines SET qty_received = COALESCE(qty_received,0) + ? WHERE id = ?', qty, lineId);
      created.push(info.lastInsertRowid);
      mrnIds.add(line.mrn_id);
    }
    // Re-derive each affected MRN's header status from its lines.
    for (const mid of mrnIds) {
      const open = get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ? AND COALESCE(qty_received,0) < qty', mid).c;
      const any = get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ? AND COALESCE(qty_received,0) > 0', mid).c;
      run('UPDATE mrn SET status = ? WHERE id = ?', open === 0 ? 'received' : (any > 0 ? 'partially_received' : 'open'), mid);
    }
  });
  if (created.length) audit.record({ userId: req.user.id, entity: 'grn', action: 'bulk_receive', after: { count: created.length, mrns: [...mrnIds] } });
  res.json({ ok: true, received: created.length, mrns: mrnIds.size, skipped });
}));

router.patch('/grn/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM grn WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'GRN not found' });
  if (req.body.purchase_source !== undefined && req.body.purchase_source && !PURCHASE_SOURCES.includes(req.body.purchase_source)) {
    return res.status(400).json({ error: 'Invalid purchase_source' });
  }
  const sets = [];
  const params = [];
  for (const c of ['unit_price', 'supplier', 'invoice_no', 'invoice_date', 'delivery_date', 'purchase_source']) {
    if (req.body[c] !== undefined) {
      sets.push(`${c} = ?`);
      params.push(c === 'unit_price' ? (req.body[c] === '' || req.body[c] === null ? null : toNum(req.body[c])) : req.body[c]);
    }
  }
  // Keep the normalised bucket in step when the source changes.
  if (req.body.purchase_source !== undefined) {
    sets.push('purchase_source_norm = ?');
    params.push(purchaseSourceNorm(req.body.purchase_source));
  }
  // Stamp when a price is first entered (procurement tracking).
  if (req.body.unit_price !== undefined && before.unit_price == null && req.body.unit_price !== '' && req.body.unit_price !== null && before.priced_at == null) {
    sets.push("priced_at = datetime('now')");
  }
  if (sets.length) run(`UPDATE grn SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  const after = get('SELECT * FROM grn WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'grn', entityId: id, action: 'update', before, after, reason: 'late pricing' });
  res.json(after);
}));

// ---- Issues ---------------------------------------------------------------
// KPI headline numbers for the Stock Issues page. Cost is qty × unit_price summed
// (computed inline so it works whether or not the generated total_cost column exists).
router.get('/issues/kpis', asyncHandler((_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const ym = today.slice(0, 7); // 'YYYY-MM'
  const d = get(`SELECT COUNT(*) c, COALESCE(SUM(qty * COALESCE(unit_price, 0)), 0) cost FROM issues WHERE issue_date = ?`, today);
  const m = get(`SELECT COUNT(*) c, COALESCE(SUM(qty * COALESCE(unit_price, 0)), 0) cost FROM issues WHERE substr(issue_date, 1, 7) = ?`, ym);
  res.json({ issues_today: d.c, cost_today: d.cost, issues_month: m.c, cost_month: m.cost });
}));

// Per-vehicle cost history for the charts: monthly totals from the rollup table
// (oldest→newest) plus a live category breakdown from the issues themselves (the
// rollup keeps no per-category split).
router.get('/vehicle-costs', asyncHandler((req, res) => {
  const assetId = toInt(req.query.asset_id);
  if (!assetId) return res.status(400).json({ error: 'asset_id is required' });
  const months = Math.min(Math.max(toInt(req.query.months, 6) || 6, 1), 24);
  const monthly = all(
    `SELECT year, month, parts_cost, fuel_cost, oil_cost, filter_cost, battery_cost, labour_cost, total_cost
       FROM vehicle_monthly_costs WHERE asset_id = ?
       ORDER BY year DESC, month DESC LIMIT ?`, assetId, months).reverse();
  const categories = all(
    `SELECT COALESCE(NULLIF(TRIM(category), ''), 'Uncategorised') AS category,
            ROUND(SUM(qty * COALESCE(unit_price, 0)), 2) AS total, COUNT(*) AS n
       FROM issues WHERE asset_id = ?
       GROUP BY 1 HAVING total > 0 ORDER BY total DESC`, assetId);
  const asset = get(`SELECT id, code, registration, ec_code FROM assets WHERE id = ?`, assetId);
  res.json({ asset, monthly, categories });
}));

// The General Workshop job card — where stores consumption that isn't tied to one
// vehicle lands. Created on first use, then reused; the issue picker offers it as a
// one-click choice so "no vehicle" still means "a real cost object".
router.get('/general-job', asyncHandler((_req, res) => {
  const id = generalWorkshopJobId();
  res.json(get('SELECT id, job_no, status, description FROM job_cards WHERE id = ?', id));
}));

router.get('/issues', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.asset_id) { clauses.push('i.asset_id = ?'); params.push(toInt(req.query.asset_id)); }
  if (req.query.job_id) { clauses.push('i.job_id = ?'); params.push(toInt(req.query.job_id)); }
  if (req.query.category) { clauses.push('i.category = ?'); params.push(req.query.category); }
  if (req.query.date_from) { clauses.push('i.issue_date >= ?'); params.push(req.query.date_from); }
  if (req.query.date_to) { clauses.push('i.issue_date <= ?'); params.push(req.query.date_to); }
  if (req.query.q && String(req.query.q).trim()) {
    const like = '%' + String(req.query.q).trim() + '%';
    clauses.push('(a.code LIKE ? OR a.registration LIKE ? OR a.ec_code LIKE ? OR i.description LIKE ? OR i.issued_by LIKE ? OR i.category LIKE ?)');
    params.push(like, like, like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT i.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, j.job_no,
            sub.name AS sub_category
       FROM issues i
       LEFT JOIN assets a ON a.id = i.asset_id
       LEFT JOIN job_cards j ON j.id = i.job_id
       LEFT JOIN item_categories sub ON sub.id = i.category_id
       ${where} ORDER BY i.issue_date DESC, i.id DESC LIMIT ${toInt(req.query.limit, 500)}`, ...params));
}));

// Distinct issue categories (for the filter dropdown).
router.get('/issue-categories', asyncHandler((_req, res) =>
  res.json(all(`SELECT DISTINCT category FROM issues WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY category`).map((r) => r.category))));

router.post('/issues', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['description']);
  // Cost object: every issue lands on a JOB CARD — no exceptions — and the vehicle is
  // derived from it, so the two can never disagree. Stores consumption that isn't
  // vehicle-specific goes to the General Workshop card, which is a real job card the
  // picker offers (see GET /general-job), not a silent fallback.
  const jobId = toInt(b.job_id) || null;
  if (!jobId) return res.status(400).json({ error: 'Select the job card this issue belongs to' });
  const job = get('SELECT id, job_no, status, asset_id FROM job_cards WHERE id = ?', jobId);
  if (!job) return res.status(400).json({ error: 'Unknown job card' });
  // A closed / rejected card can still take a late issue, but only deliberately: the
  // client has to come back with allow_closed so a mis-picked card can't slip through.
  const isClosed = job.status === 'CLOSED' || job.status === 'REJECTED';
  if (isClosed && !b.allow_closed) {
    return res.status(409).json({
      error: `Job ${job.job_no} is ${job.status} — confirm to record a late issue against it`,
      job_no: job.job_no, job_status: job.status, needs_confirm: true,
    });
  }
  const serviceId = toInt(b.service_id) || null;
  const assetId = job.asset_id;
  const qty = toNum(b.qty, 1);
  const unitPrice = b.unit_price === undefined || b.unit_price === '' ? null : toNum(b.unit_price);
  const issueDate = b.issue_date || new Date().toISOString().slice(0, 10);
  // Require a canonical date so the monthly rollup can't be mis-bucketed (e.g. a
  // DD-MM-YYYY value would land in a garbage year). The UI always sends YYYY-MM-DD.
  if (!/^\d{4}-\d{2}-\d{2}/.test(issueDate)) return res.status(400).json({ error: 'issue_date must be YYYY-MM-DD' });
  const cat = categories.resolve(b);
  const lineCost = qty * (unitPrice || 0);
  const [yr, mo] = issueDate.split('-').map((n) => parseInt(n, 10)); // rollup period
  const validPeriod = yr >= 1900 && mo >= 1 && mo <= 12;

  const issueId = tx(() => {
    const info = run(
      `INSERT INTO issues (asset_id, job_id, service_id, store_item_id, description, qty, unit_price, issue_date, issued_by, category, category_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assetId || null, jobId, serviceId, toInt(b.store_item_id), b.description, qty,
      unitPrice, issueDate, b.issued_by || null, cat.category, cat.category_id
    );
    // Materialise the issue as a source_type='issue' job_part (mirrors migrate/09) so it
    // counts EXACTLY ONCE in the job's cost via computeJobCost's existing parts sum.
    if (jobId) run(
      `INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, is_external_repair)
       VALUES (?, 'issue', ?, ?, ?, ?, 0)`,
      jobId, info.lastInsertRowid, b.description, qty, unitPrice);
    // Roll the line cost into the vehicle's month bucket (parts component). Only for
    // asset-linked issues; general (assetless) issues are counted in KPIs but have no
    // vehicle to attribute to. Incremental upsert keeps total = Σ components, matching
    // the invariant the 015 backfill establishes.
    if (assetId && validPeriod) {
      run(
        `INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id, year, month) DO UPDATE SET
           parts_cost = parts_cost + excluded.parts_cost,
           total_cost = total_cost + excluded.parts_cost,
           updated_at = datetime('now')`,
        assetId, yr, mo, lineCost, lineCost
      );
    }
    return info.lastInsertRowid;
  });
  // Refresh the job's stored totals so job-based cost reports reflect the new issue
  // (computeJobCost is live, but reports read the stored job_cards/job_costs columns).
  if (jobId) { try { costing.refreshJobTotals(jobId); } catch (e) { /* non-fatal */ } }
  audit.record({ userId: req.user.id, entity: 'issue', entityId: issueId, action: 'create',
    after: { asset_id: assetId || null, job_id: jobId, service_id: serviceId, total_cost: lineCost },
    reason: isClosed ? `late issue against ${job.status} job ${job.job_no}` : undefined });
  // KPIs count every issue, so refresh regardless of asset; the vehicle rollup only
  // moved for asset-linked ones.
  emitter.emit('stock_updated', { issue_id: issueId, asset_id: assetId || null, action: 'issue', cost: lineCost });
  emitter.emit('dashboard_refresh', { reason: 'issue', asset_id: assetId || null, year: yr, month: mo });
  res.status(201).json({ issue: get('SELECT * FROM issues WHERE id = ?', issueId) });
}));

// ---- MTN ------------------------------------------------------------------
router.get('/mtn', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  // One box over everything the storekeeper might remember about a transfer — its number,
  // what moved, where it came from or went to, and who handed it over or took it.
  if (req.query.q && String(req.query.q).trim()) {
    const raw = String(req.query.q).trim();
    // % and _ are LIKE's own wildcards; typed literally they must match themselves.
    const like = '%' + raw.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
    const L = (c) => `${c} LIKE ? ESCAPE '\\'`;
    const ors = [L('t.mtn_no'), L('t.description'), L('t.from_location'), L('t.to_location'),
      L('t.transferred_by'), L('t.received_by'), L('t.reason'), L('t.category'),
      L('af.code'), L('af.registration'), L('at2.code'), L('at2.registration'),
      // The header only summarises a multi-item note ("Fly Wheel + 4 more"), so searching for
      // the fifth item has to reach the items themselves.
      `EXISTS (SELECT 1 FROM mtn_lines ml LEFT JOIN assets mla ON mla.id = ml.from_asset_id
                                          LEFT JOIN assets mlb ON mlb.id = ml.to_asset_id
                WHERE ml.mtn_id = t.id AND (${['ml.description', 'ml.from_location', 'ml.to_location',
    'ml.reason', 'ml.category', 'mla.code', 'mla.registration', 'mlb.code', 'mlb.registration'].map(L).join(' OR ')}))`];
    params.push(...Array(12).fill(like), ...Array(9).fill(like));
    clauses.push('(' + ors.join(' OR ') + ')');
  }
  if (req.query.from && String(req.query.from).trim()) { clauses.push('date(t.txn_date) >= date(?)'); params.push(String(req.query.from).trim()); }
  if (req.query.to && String(req.query.to).trim()) { clauses.push('date(t.txn_date) <= date(?)'); params.push(String(req.query.to).trim()); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT t.*, af.code AS from_asset_code, at2.code AS to_asset_code,
            (SELECT COUNT(*) FROM mtn_lines ml WHERE ml.mtn_id = t.id) AS item_count
       FROM mtn t
       LEFT JOIN assets af ON af.id = t.from_asset_id LEFT JOIN assets at2 ON at2.id = t.to_asset_id
       ${where}
      ORDER BY t.id DESC LIMIT ${toInt(req.query.limit, 300)}`, ...params));
}));

// The transfer note number. It continues a paper sequence, so the storekeeper has to be able
// to type the one written on the book in front of them — the suggestion is only a default.
// UNIQUE on the column, so a clash has to come back as a readable message rather than a 500.
function mtnNoOrFail(given, exceptId) {
  const no = String(given == null ? '' : given).trim();
  if (!no) return { no: nextMtnNo() };
  const clash = exceptId
    ? get('SELECT id FROM mtn WHERE mtn_no = ? AND id <> ?', no, exceptId)
    : get('SELECT id FROM mtn WHERE mtn_no = ?', no);
  if (clash) return { error: `MTN ${no} already exists — pick another number` };
  return { no };
}

// ---- the items on a transfer ----------------------------------------------
// A note carries as many items as the paper does. The header keeps `description` and `qty` as
// a SUMMARY of the lines, rebuilt on every write, so the list, the search, the asset timeline
// and the exports — all of which read a transfer as one row — keep working unchanged.
function syncMtnHeader(mtnId) {
  const lines = all('SELECT * FROM mtn_lines WHERE mtn_id = ? ORDER BY line_no, id', mtnId);
  if (!lines.length) return;
  const cats = [...new Set(lines.map((l) => l.category).filter(Boolean))];
  run(`UPDATE mtn SET description = ?, qty = ?, store_item_id = ?, category = ?, category_id = ? WHERE id = ?`,
    lines.length === 1
      ? lines[0].description
      // Enough to recognise the note in a list; the items themselves are one click away.
      : `${lines[0].description || 'Item'} + ${lines.length - 1} more`,
    Math.round(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0) * 1000) / 1000,
    lines.length === 1 ? lines[0].store_item_id : null,
    cats.length === 1 ? cats[0] : (cats.length ? 'Mixed' : null),
    lines.length === 1 ? lines[0].category_id : null,
    mtnId);
}

// A line's from/to is usually a place ("Head Office") but is just as often a machine the part
// was pulled off. When the text IS a machine on the books, link it as well as keeping the text,
// so the transfer reaches that machine's history. A pure lookup — an unrecognised place stays
// plain text and never invents an asset or an alias for it.
function assetByCode(text) {
  const t = clean(text);
  if (!t) return null;
  const hit = get('SELECT id FROM assets WHERE code_norm = ?', aliases.normalize(t));
  return hit ? hit.id : null;
}

/** One item as it arrives from the client, resolved against the catalogue and the asset book. */
function mtnLineValues(raw) {
  const cat = categories.resolve(raw);
  return {
    store_item_id: toInt(raw.store_item_id),
    description: clean(raw.description),
    qty: toNum(raw.qty, 0),
    unit: clean(raw.unit),
    category: cat.category,
    category_id: cat.category_id,
    // Blank means "same as the note" — only a line that genuinely differs carries its own.
    from_location: clean(raw.from_location),
    to_location: clean(raw.to_location),
    from_asset_id: resolveAssetId(raw, 'from').assetId || assetByCode(raw.from_location),
    to_asset_id: resolveAssetId(raw, 'to').assetId || assetByCode(raw.to_location),
    reason: clean(raw.reason),
  };
}

function insertMtnLine(mtnId, raw, lineNo) {
  const v = mtnLineValues(raw);
  return run(
    `INSERT INTO mtn_lines (mtn_id, line_no, store_item_id, description, qty, unit, category, category_id,
                            from_location, to_location, from_asset_id, to_asset_id, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    mtnId, lineNo, v.store_item_id, v.description, v.qty, v.unit, v.category, v.category_id,
    v.from_location, v.to_location, v.from_asset_id, v.to_asset_id, v.reason
  ).lastInsertRowid;
}

/** The items as the client sent them, whether as `lines[]` or as the old one-item shape. */
function incomingMtnLines(b) {
  if (Array.isArray(b.lines) && b.lines.length) {
    return b.lines.filter((l) => l && (clean(l.description) || Number(l.qty) > 0));
  }
  // A transfer raised the way it always was: description + qty on the note itself.
  return b.description !== undefined || b.qty !== undefined
    ? [{ description: b.description, qty: b.qty, unit: b.unit, store_item_id: b.store_item_id,
      category: b.category, category_id: b.category_id }]
    : [];
}

router.post('/mtn', requireRole('storekeeper'), asyncHandler((req, res) => {
  const b = req.body;
  const items = incomingMtnLines(b);
  if (!items.length) return res.status(400).json({ error: 'A transfer needs at least one item' });
  const bad = items.findIndex((l) => !(Number(l.qty) > 0));
  if (bad >= 0) return res.status(400).json({ error: `Item ${bad + 1}: quantity must be more than 0` });

  const from = resolveAssetId(b, 'from');
  const to = resolveAssetId(b, 'to');
  const n = mtnNoOrFail(b.mtn_no);
  if (n.error) return res.status(409).json({ error: n.error });
  const mtnNo = n.no;
  const id = tx(() => {
    const info = run(
      `INSERT INTO mtn (mtn_no, txn_date, from_location, to_location, from_asset_id, to_asset_id, transferred_by, received_by, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mtnNo, b.txn_date || new Date().toISOString().slice(0, 10),
      b.from_location || null, b.to_location || null, from.assetId || null, to.assetId || null,
      b.transferred_by || null, b.received_by || null, b.reason || null
    );
    items.forEach((l, i) => insertMtnLine(info.lastInsertRowid, l, i + 1));
    syncMtnHeader(info.lastInsertRowid);
    return info.lastInsertRowid;
  });
  audit.record({ userId: req.user.id, entity: 'mtn', entityId: id, action: 'create',
    after: { mtn_no: mtnNo, items: items.length } });
  res.status(201).json({ ...get('SELECT * FROM mtn WHERE id = ?', id), lines: mtnLines(id) });
}));

const mtnLines = (mtnId) => all(
  `SELECT l.*, af.code AS from_asset_code, at2.code AS to_asset_code
     FROM mtn_lines l
     LEFT JOIN assets af  ON af.id  = l.from_asset_id
     LEFT JOIN assets at2 ON at2.id = l.to_asset_id
    WHERE l.mtn_id = ? ORDER BY l.line_no, l.id`, mtnId);

router.get('/mtn/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const mtn = get(`SELECT t.*, af.code AS from_asset_code, at2.code AS to_asset_code FROM mtn t
                     LEFT JOIN assets af ON af.id = t.from_asset_id
                     LEFT JOIN assets at2 ON at2.id = t.to_asset_id WHERE t.id = ?`, id);
  if (!mtn) return res.status(404).json({ error: 'MTN not found' });
  res.json({ mtn, lines: mtnLines(id) });
}));

// Add an item to an existing note.
router.post('/mtn/:id/lines', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM mtn WHERE id = ?', id)) return res.status(404).json({ error: 'MTN not found' });
  if (!(toNum(req.body.qty, 0) > 0)) return res.status(400).json({ error: 'Quantity must be more than 0' });
  if (!clean(req.body.description)) return res.status(400).json({ error: 'Describe the item' });
  const lineId = tx(() => {
    const next = (get('SELECT MAX(line_no) m FROM mtn_lines WHERE mtn_id = ?', id).m || 0) + 1;
    const newId = insertMtnLine(id, req.body, next);
    syncMtnHeader(id);
    return newId;
  });
  audit.record({ userId: req.user.id, entity: 'mtn', entityId: id, action: 'update',
    after: { added_item: clean(req.body.description) } });
  res.status(201).json(get('SELECT * FROM mtn_lines WHERE id = ?', lineId));
}));

const MTN_LINE_EDITABLE = ['description', 'unit', 'from_location', 'to_location', 'reason'];

router.patch('/mtn/line/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const lineId = toInt(req.params.id);
  const before = get('SELECT * FROM mtn_lines WHERE id = ?', lineId);
  if (!before) return res.status(404).json({ error: 'Item not found' });
  const sets = []; const params = []; const after = {};
  if (req.body.qty !== undefined) {
    const q = toNum(req.body.qty, 0);
    if (!(q > 0)) return res.status(400).json({ error: 'Quantity must be more than 0' });
    sets.push('qty = ?'); params.push(q); after.qty = q;
  }
  for (const c of MTN_LINE_EDITABLE) {
    if (req.body[c] === undefined) continue;
    sets.push(`${c} = ?`); params.push(clean(req.body[c])); after[c] = clean(req.body[c]);
  }
  if (req.body.category_id !== undefined || req.body.category !== undefined) {
    const cat = categories.resolve(req.body);
    sets.push('category = ?', 'category_id = ?'); params.push(cat.category, cat.category_id);
    after.category = cat.category;
  }
  // Re-derive the machine link whenever either the link OR the text it came from is edited,
  // so correcting "LO-4925" to "Head Office" does not leave the old machine attached.
  for (const side of ['from', 'to']) {
    const given = req.body[`${side}_asset_id`] !== undefined || req.body[`${side}_asset`] !== undefined;
    if (!given && req.body[`${side}_location`] === undefined) continue;
    sets.push(`${side}_asset_id = ?`);
    params.push(given ? (resolveAssetId(req.body, side).assetId || null) : assetByCode(req.body[`${side}_location`]));
  }
  if (!sets.length) return res.json(before);
  tx(() => {
    run(`UPDATE mtn_lines SET ${sets.join(', ')} WHERE id = ?`, ...params, lineId);
    syncMtnHeader(before.mtn_id);
  });
  audit.record({ userId: req.user.id, entity: 'mtn', entityId: before.mtn_id, action: 'update',
    before: Object.fromEntries(Object.keys(after).map((k) => [k, before[k]])), after });
  res.json(get('SELECT * FROM mtn_lines WHERE id = ?', lineId));
}));

router.delete('/mtn/line/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const lineId = toInt(req.params.id);
  const line = get('SELECT * FROM mtn_lines WHERE id = ?', lineId);
  if (!line) return res.status(404).json({ error: 'Item not found' });
  // A note is a record of goods that moved; emptying it would leave a number standing for
  // nothing. Delete the transfer itself instead.
  if (get('SELECT COUNT(*) c FROM mtn_lines WHERE mtn_id = ?', line.mtn_id).c <= 1) {
    return res.status(409).json({ error: 'A transfer keeps at least one item — delete the transfer instead' });
  }
  tx(() => {
    run('DELETE FROM mtn_lines WHERE id = ?', lineId);
    syncMtnHeader(line.mtn_id);
  });
  audit.record({ userId: req.user.id, entity: 'mtn', entityId: line.mtn_id, action: 'update',
    before: { removed_item: line.description, qty: line.qty }, after: {} });
  res.json({ ok: true });
}));

// Correct a transfer note — the number included. A transfer is a movement between stores,
// not an authority to spend, so there is no approval to invalidate; it is simply corrected
// and audited.
const MTN_EDITABLE = ['txn_date', 'description', 'from_location', 'to_location',
  'transferred_by', 'received_by', 'reason'];

router.patch('/mtn/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM mtn WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'MTN not found' });

  const sets = []; const params = []; const after = {};
  if (req.body.mtn_no !== undefined) {
    const n = mtnNoOrFail(req.body.mtn_no, id);
    if (n.error) return res.status(409).json({ error: n.error });
    sets.push('mtn_no = ?'); params.push(n.no); after.mtn_no = n.no;
  }
  // qty / description / category describe an ITEM, and on a one-item note editing them here is
  // how the storekeeper has always corrected it — so they are passed through to that item.
  // On a note carrying several, there is no one item they could mean.
  const itemFields = ['qty', 'description', 'unit', 'category', 'category_id']
    .filter((k) => req.body[k] !== undefined);
  const lines = all('SELECT * FROM mtn_lines WHERE mtn_id = ? ORDER BY line_no, id', id);
  if (itemFields.length && lines.length > 1) {
    return res.status(409).json({
      error: `This transfer carries ${lines.length} items — edit the item itself, not the note`,
    });
  }
  if (req.body.qty !== undefined && !(toNum(req.body.qty, 0) > 0)) {
    return res.status(400).json({ error: 'Quantity must be more than 0' });
  }
  for (const c of MTN_EDITABLE) {
    if (req.body[c] === undefined) continue;
    sets.push(`${c} = ?`); params.push(clean(req.body[c])); after[c] = clean(req.body[c]);
  }
  if (!sets.length && !itemFields.length) return res.json(before);

  tx(() => {
    if (sets.length) run(`UPDATE mtn SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (itemFields.length && lines.length === 1) {
      const v = mtnLineValues({ ...lines[0], ...req.body });
      run(`UPDATE mtn_lines SET description = ?, qty = ?, unit = ?, category = ?, category_id = ? WHERE id = ?`,
        v.description, v.qty, v.unit, v.category, v.category_id, lines[0].id);
      Object.assign(after, { qty: v.qty, description: v.description });
      syncMtnHeader(id);
    }
  });
  audit.record({ userId: req.user.id, entity: 'mtn', entityId: id, action: 'update',
    before: Object.fromEntries(Object.keys(after).map((k) => [k, before[k]])), after });
  res.json({ ...get('SELECT * FROM mtn WHERE id = ?', id), lines: mtnLines(id) });
}));

// ---- exports --------------------------------------------------------------
router.get('/export/mrn.xlsx', asyncHandler(async (_req, res) => {
  const rows = all(`SELECT m.mrn_no, m.req_date, a.code AS asset_code, m.purpose, m.status,
                           ${mrnReceiptSql('m.id')}
                      FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id ORDER BY m.id DESC`);
  await sendXlsx(res, 'mrn.xlsx', [{
    name: 'MRN',
    columns: [
      { header: 'MRN No', key: 'mrn_no' }, { header: 'Date', key: 'req_date' },
      { header: 'Asset', key: 'asset_code' }, { header: 'Purpose', key: 'purpose' }, { header: 'Status', key: 'status' },
      // 'Status' says received; this says when the last goods against the request came in.
      { header: 'Received date', key: 'received_date', width: 32 },
    ],
    // A request has no single qty_received, so judge it by whether anything is dated against it.
    rows: rows.map((r) => ({ ...r, received_date: exportReceived({ ...r, qty_received: r.last_received ? 1 : 0 }) })),
  }]);
}));

module.exports = router;
