'use strict';

// Unified stock movements across the four inventory sections.
//
// Each section keeps its own source of truth (the oil ledger, general item txns, the
// tyre/battery issue ledger, service filter lines, and GRN receipts) — this module folds
// them into ONE movement table so every section can answer the same questions:
//
//     on order  →  received  →  issued  →  balance
//
// The gap it closes: receiving a GRN never added to stock. 3,837 receipts existed and
// stock only ever went down, which is why almost nothing carried a balance.
//
// Rebuilds are idempotent — stock_moves is keyed UNIQUE(source_table, source_id, kind),
// so replaying a source can never double-count a movement.

const { get, all, run, tx } = require('../db');
const lubricants = require('./lubricants');
const { normF } = require('./filter_no');

const SECTIONS = ['oil', 'filter', 'battery', 'tyre', 'general'];

/** Which inventory section a free-text category belongs to. */
function sectionOf(category) {
  const t = String(category || '').toLowerCase();
  if (t.includes('filter')) return 'filter';
  if (t.includes('batter')) return 'battery';
  if (t.includes('tyre') || t.includes('tire')) return 'tyre';
  if (t.includes('lubric') || t.includes('oil')) return 'oil';
  return 'general';
}

/** Identity of an item WITHIN its section — how two movements are recognised as the same thing. */
function itemKey(section, name, extra) {
  const base = String(extra || name || '').toUpperCase()
    .replace(/\([^)]*\)/g, ' ')          // drop bracketed notes ("(2 Nos)")
    .replace(/[^A-Z0-9]/g, '');
  return base || 'UNKNOWN';
}

const d10 = (v) => (v ? String(v).slice(0, 10) : null);
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Opening rules — how far back each section counts. */
function openingRules() {
  const rows = all('SELECT * FROM stock_opening');
  const byId = {};
  for (const r of rows) byId[r.section] = r;
  return byId;
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild every movement from the underlying records.
 * `opts.wipe` clears stock_moves first (a full recalculation); otherwise existing rows
 * are kept and only missing ones are inserted.
 */
// The part number a filter is really known by, dug out of however it was written down.
//
// "Oil Filter (C-206)" is C206. "C-206" is C206. "Oil Filter" alone is nothing — a description
// with no number in it is left in its generic bucket rather than guessed at, because there are
// dozens of oil filters and picking one would be inventing a fact.
//
// A candidate only counts if the workshop's own filter catalogue recognises it (filter_prices,
// then the cross-reference table). That is what stops "(2 Nos)" or "(Tata)" being read as a part
// number: they are not in the catalogue, so they are not numbers.
const knownFilterNo = new Map();
let knownFilterStamp = null;
function filterCatalogue() {
  // Cached, because it is asked once per movement — but NOT for the life of the process. A filter
  // priced today has to be recognised today, and a cache that never lets go would keep it
  // invisible until the server was restarted. The row counts are the cheap stamp that catches it.
  const stamp = get(`SELECT (SELECT COUNT(*) FROM filter_prices) AS p, (SELECT COUNT(*) FROM filter_xrefs) AS x`);
  const key = stamp.p + ':' + stamp.x;
  if (knownFilterStamp === key) return knownFilterNo;
  knownFilterNo.clear();
  for (const r of all(`SELECT filter_no_norm AS k FROM filter_prices WHERE NULLIF(filter_no_norm,'') IS NOT NULL
                       UNION SELECT part_number_norm FROM filter_xrefs WHERE NULLIF(part_number_norm,'') IS NOT NULL`)) {
    knownFilterNo.set(r.k, true);
  }
  knownFilterStamp = key;
  return knownFilterNo;
}
function filterKey(text) {
  const s = String(text || '');
  const cat = filterCatalogue();
  // A BRACKET IS THE SAME FILTER SPELT ANOTHER WAY, not a second filter. "C-112 (C-1111)" is one
  // element and its cross-reference; "TH-93286 (2534 1813 0129 tata)" is one element and its Tata
  // number. So the number OUTSIDE the bracket wins when the catalogue knows it, and the bracket
  // is only consulted when it does not — which is the "Oil Filter (C-206)" case, where the words
  // outside carry nothing and the number is in the bracket.
  const bare = s.replace(/\([^)]*\)/g, ' ');
  const tried = [bare];
  for (const m of s.matchAll(/\(([^)]*)\)/g)) tried.push(m[1]);
  // SPLIT BEFORE ACCEPTING THE WHOLE STRING. The joined-up form of a two-filter line
  // (FF5052FS1275) is itself in filter_prices — a junk catalogue entry built from these same
  // lines — so checking the line as written first would accept the nonsense key.
  tried.push(...bare.split(/[&+]| and /i));
  tried.push(s);
  for (const c of tried) {
    const k = normF(c);
    if (k && cat.has(k)) return k;
  }
  return null;
}

/**
 * EVERY filter named on one line, not just the first. The owner confirmed (2026-08-21) that a
 * line reading "JS-1030 & 278 607 989 916" means both were fitted, so both come off the shelf.
 * Each is returned with the words it was written as, so the movement can be read back.
 * Falls back to a single entry when the line names one filter, and to none when it names no
 * number the catalogue recognises — "Hy. return filter replaced" is not guessed at.
 */
function filterParts(text) {
  const s = String(text || '');
  // ONLY AN "&" MEANS A SECOND FILTER. A bracket is the same filter written another way, so it
  // must not be split off — "C-112 (C-1111)" is one element, and reading it as two would take a
  // filter off the shelf that was never fitted.
  //
  // An "&" INSIDE a bracket is prose, not a separator: "AF-25910/11 (inner & outer Fleet Guard)"
  // describes one part. So the line is split only at the TOP level, and each segment is then
  // resolved on its own — brackets and all.
  const segs = ['']; let depth = 0;
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === '&' || c === '+')) { segs.push(''); continue; }
    segs[segs.length - 1] += c;
  }
  const out = []; const taken = new Set();
  for (const seg of segs.flatMap((x) => x.split(/ and /i))) {
    const frag = seg.trim();
    if (!frag) continue;
    const k = filterKey(frag);
    if (!k || taken.has(k)) continue;
    taken.add(k); out.push({ key: k, text: frag });
  }
  return out;
}

/** Write one movement (once: the source, kind and item are its key). True when it was new. */
function writeMove(m, counts, mainStore) {
  return run(
    `INSERT OR IGNORE INTO stock_moves
      (section, kind, item_key, item_name, qty, unit_price, txn_date, asset_id, job_id,
       mrn_line_id, grn_id, store_item_id, ref, note, source_table, source_id, counts, store_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    m.section, m.kind, m.item_key, m.item_name || null, n2(m.qty), m.unit_price == null ? null : n2(m.unit_price),
    d10(m.txn_date), m.asset_id || null, m.job_id || null, m.mrn_line_id || null, m.grn_id || null,
    m.store_item_id || null, m.ref || null, m.note || null, m.source_table, m.source_id, counts,
    m.store_id || mainStore).changes > 0;
}

/** A store's stock-take correction as a movement: the difference the count found. */
const countMove = (c) => ({
  section: c.section, kind: 'adjust', item_key: c.item_key, item_name: c.item_name, qty: c.delta,
  txn_date: c.count_date, ref: 'Stock take', note: `counted ${c.counted_qty}, book ${c.book_qty}`,
  source_table: 'store_counts', source_id: c.id, store_id: c.store_id, keep_key: true, counts: 1,
});

/** Record a count just made (the rebuild writes the same row from store_counts). */
function recordCount(c) {
  const m = countMove(c);
  writeMove(m, 1, null);
}

function rebuild(opts = {}) {
  const rep = { in: 0, out: 0, history_only: 0, by_section: {} };
  const rules = openingRules();
  const bump = (section, kind) => {
    rep.by_section[section] = rep.by_section[section] || { in: 0, out: 0 };
    rep.by_section[section][kind === 'in' ? 'in' : 'out']++;
    if (kind === 'in') rep.in++; else rep.out++;
  };
  // Every movement is recorded. Ones before a section's cut-over are stored with counts = 0
  // so the history is still there to look at, but the balance starts clean from the cut-over.
  const countsToward = (section, date) => {
    const r = rules[section];
    if (!r || r.mode !== 'cutover' || !r.cutover) return 1;
    return (date && d10(date) >= r.cutover) ? 1 : 0;
  };

  // A lubricant's identity is the PRODUCT in the oil book, not the words written on the paper.
  // The oil ledger keys its rows by the product code (itemKey('oil', name, 'OIL-0021') ->
  // OIL0021) while every other door keys by the written name (HD68OIL, HD68OILVALVOLINE), so one
  // product's receipts and issues landed in DIFFERENT rows: HD 68 Oil read -573 under its code
  // while 1,000 L of the same oil sat under two spellings of its name. Keyed by product, all its
  // spellings collapse to one row and the balance is simply right.
  // The code form is used rather than the name form because itemKey() strips brackets — the
  // brand lives in the bracket, so "HD 68 Oil (Servo)" and "HD 68 Oil (Valvoline)" would merge
  // into one row. The code cannot collide.
  const lubeKeyCache = new Map();
  const lubeKey = (productId) => {
    if (!lubeKeyCache.has(productId)) {
      const p = get('SELECT code, name FROM products WHERE id = ?', productId);
      lubeKeyCache.set(productId, p && (p.code || p.name) ? itemKey('oil', p.name, p.code || p.name) : null);
    }
    return lubeKeyCache.get(productId);
  };

  // Stage 4: every movement is in a store — the one stamped on its source row, else the main one.
  const mainStore = (get('SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1') || {}).id || null;

  const insert = (m) => {
    // A stock-take correction is already keyed to the shelf it counted: the name is not re-read.
    if (m.keep_key) {
      if (writeMove(m, m.counts == null ? 1 : m.counts, mainStore)) bump(m.section, m.kind);
      return;
    }
    // The section rule runs BOTH ways. A drum of kerosene bought on a request someone
    // categorised "General Items" is still kerosene, and leaving it in the general section put
    // its receipts in one book and its issues in another — which is how five lubricants came
    // to show a NEGATIVE balance (WD-40 -46, Karosine -49.5) while the general balance
    // carried 1,100 units of oil, diesel and grease that were never general items.
    // A lubricant is oil stock wherever it was written down — and is identified by its product.
    const lube = lubricants.resolveLubricant(m.item_name, { record: false, on: m.txn_date });
    if (lube.resolved && lube.productId) {
      m.section = 'oil';
      const k = lubeKey(lube.productId);
      if (k) m.item_key = k;
    }
    // force_history: a real movement that must not affect the balance (already counted
    // elsewhere). Still stored so the paperwork stays visible.
    // An explicit `counts` beats the date rule: a handover of a pre-cut-over receipt is dated
    // today, so the date rule would count it out of a balance it was never counted into.
    let counts = m.force_history ? 0
      : (m.counts != null ? m.counts : countsToward(m.section, m.txn_date));
    // A thing is lubricant STOCK only if it is a lubricant. The section is decided by the
    // category — and where there is no category, by the words in the description — which is
    // how "Front Crank Oil Seal", "Oil Seal (small)" and "Hub Oil Seal" came to be deducted
    // from the oil balance, and how Grease Gun, Oil Pump and Brake Oil Tank came to sit in it.
    // The oil book itself is the allowlist: a name that resolves to one of its products is
    // fluid, anything else is remembered as an unknown spelling for the owner to identify and
    // meanwhile does not move the balance either way. Nothing is guessed, and nothing is
    // recategorised — the row stays exactly where it is, it just stops counting as litres.
    // Asked AS AT the movement's own date: a name can mean one product then and another now
    // (HD-68 was Caltex, then Valvoline), so a 2025 receipt must be judged by what the name
    // meant in 2025.
    if (counts && m.section === 'oil' && !(lube.resolved && lube.productId)) {
      lubricants.resolveLubricant(m.item_name, { source: m.source_table });  // remember it
      counts = 0;
    }
    if (!counts) rep.history_only++;
    if (writeMove(m, counts, mainStore)) bump(m.section, m.kind);
  };

  // TRANSFERS BETWEEN TWO STORES (Stage 4). A transfer note's item that went from one store to
  // another (src/lib/stores.js stampTransfer) comes out of the first and goes into the second, on
  // the transfer date. Keyed like a receipt of the same words, so it meets the shelf it came from.
  // Anything else on a transfer note — to a site, to a machine — stays the paper record it was.
  const transfers = (mtnId) => {
    const storeName = new Map(all('SELECT id, code FROM workshops').map((w) => [w.id, w.code]));
    for (const l of all(
      `SELECT l.id, l.description, l.qty, l.category, l.store_item_id, l.from_store_id, l.to_store_id,
              t.mtn_no, t.txn_date, si.name AS item_name, si.category AS item_cat
         FROM mtn_lines l JOIN mtn t ON t.id = l.mtn_id
         LEFT JOIN store_items si ON si.id = l.store_item_id
        WHERE l.from_store_id IS NOT NULL AND l.to_store_id IS NOT NULL AND l.from_store_id <> l.to_store_id
          AND COALESCE(l.qty,0) > 0 ${mtnId ? 'AND l.mtn_id = ?' : ''}`, ...(mtnId ? [mtnId] : []))) {
      const section = sectionOf(l.category || l.item_cat || l.description);
      const name = l.description || l.item_name || '';
      const key = section === 'filter' ? (filterKey(name) || itemKey(section, name)) : itemKey(section, name);
      const base = { section, item_key: key, item_name: name, qty: l.qty, txn_date: l.txn_date,
        store_item_id: l.store_item_id, ref: 'MTN ' + l.mtn_no, source_table: 'mtn_lines', source_id: l.id };
      insert({ ...base, kind: 'out', store_id: l.from_store_id, note: 'to ' + (storeName.get(l.to_store_id) || 'another store') });
      insert({ ...base, kind: 'in', store_id: l.to_store_id, note: 'from ' + (storeName.get(l.from_store_id) || 'another store') });
    }
  };

  tx(() => {
    // One transfer note just written: its movements again, and nothing else (opts.transfersOf).
    if (opts.transfersOf) {
      run(`DELETE FROM stock_moves WHERE source_table = 'mtn_lines'
             AND (source_id IN (SELECT id FROM mtn_lines WHERE mtn_id = ?) OR source_id NOT IN (SELECT id FROM mtn_lines))`, opts.transfersOf);
      transfers(opts.transfersOf);
      return;
    }
    if (opts.wipe) run('DELETE FROM stock_moves');

    // 1. RECEIPTS (all sections) — the link that was missing entirely.
    for (const g of all(
      `SELECT g.id, g.qty, g.unit_price, g.delivery_date, g.description, g.grn_no, g.mrn_line_id, g.store_item_id, g.store_id,
              ml.category AS line_cat, ml.description AS line_desc, si.category AS item_cat, si.name AS item_name,
              m.mrn_no, m.asset_id, m.job_id
         FROM grn g
         LEFT JOIN mrn_lines ml ON ml.id = g.mrn_line_id
         LEFT JOIN store_items si ON si.id = g.store_item_id
         LEFT JOIN mrn m ON m.id = g.mrn_id
        WHERE COALESCE(g.qty,0) > 0`)) {
      const section = sectionOf(g.line_cat || g.item_cat);
      const name = g.description || g.line_desc || g.item_name || '';
      // A FILTER IS ITS PART NUMBER, and on 74% of receipts that number is written inside the
      // brackets — "Oil Filter (C-206)". itemKey() drops brackets, so those receipts all piled
      // into three generic buckets (OILFILTER, FUELFILTER, AIRFILTER) while the service that
      // fitted the filter went out against C206. 149 receipt keys against 1,070 issue keys, and
      // only 10 keys ever carried both, so a filter could be received and fitted and never once
      // meet itself. Here the number is pulled OUT of the bracket instead of thrown away.
      const key = section === 'filter' ? (filterKey(name) || itemKey(section, name)) : itemKey(section, name);
      // Oil bought through stores used to be muted wholesale, because some of it was ALSO
      // booked as a top-up in the oil book's own ledger and would have been counted twice.
      // That blanket rule hid 17 genuine deliveries the ledger never knew about — more than
      // it protected. The seven that really were written twice are now settled on the other
      // side: their ledger row is voided (scripts/reconcile_oil_receipts.js), and a voided
      // ledger row is skipped a few blocks below. So a receipt is simply a receipt.
      insert({ section, kind: 'in', item_key: key, item_name: name,
        qty: g.qty, unit_price: g.unit_price, txn_date: g.delivery_date, asset_id: g.asset_id, job_id: g.job_id,
        mrn_line_id: g.mrn_line_id, store_item_id: g.store_item_id,
        ref: g.grn_no || g.mrn_no || null, source_table: 'grn', source_id: g.id, store_id: g.store_id });
    }

    // 2. GENERAL issues / receipts / openings — its own running ledger.
    for (const t of all(
      `SELECT t.id, t.txn_type, t.qty, t.unit_price, t.txn_date, t.asset_id, t.job_id, t.ref, t.store_item_id, t.store_id,
              si.name, si.category
         FROM general_item_txns t JOIN store_items si ON si.id = t.store_item_id`)) {
      const section = sectionOf(t.category);
      const kind = t.txn_type === 'issue' ? 'out' : (t.txn_type === 'opening' ? 'opening' : 'in');
      // Its 'receipt' rows are the same deliveries the GRN already records (23 of 32 match a
      // GRN on date + quantity, and their ref is the MRN number). GRN is the source of truth
      // for goods coming in, so these stay visible but are not counted a second time.
      const dup = kind === 'in';
      insert({ section, kind, item_key: itemKey(section, si_name(t)), item_name: t.name,
        qty: Math.abs(t.qty), unit_price: t.unit_price, txn_date: t.txn_date, asset_id: t.asset_id, job_id: t.job_id,
        store_item_id: t.store_item_id, ref: t.ref, source_table: 'general_item_txns', source_id: t.id, store_id: t.store_id,
        force_history: dup, note: dup ? 'same delivery as the GRN receipt — counted there' : null });
    }

    // A STOCK-TAKE CORRECTION CAN GO DOWN, and the book does not say so in its qty. All 24
    // adjustments in the oil ledger are stored as a positive MAGNITUDE, but ten of them are
    // write-DOWNS — the level they were counted at is in balance_after, and the level the book
    // claimed is the previous row's. Read from qty alone, `Math.abs()` turned every write-down
    // into a write-up: HD-46 was counted at 221.75 L and the shelf carried 629.75, exactly twice
    // the 204 L that was written off. Against the owner's July count the whole section read
    // 3,111 L for a counted 1,384 L.
    //
    // The signed delta is the gap between the two figures, and BOTH are already recorded — it is
    // not a new number. Where an adjustment is the first thing a product ever had (nothing to
    // compare against) the old reading stands, because there is no book figure to difference.
    const adjustDelta = new Map();
    {
      let prev = null; let prevProduct = null;
      for (const r of all(`SELECT id, product_id, kind, balance_after FROM stock_ledger
                            WHERE COALESCE(voided,0) = 0 ORDER BY product_id, txn_date, id`)) {
        if (r.product_id !== prevProduct) { prevProduct = r.product_id; prev = null; }
        if (r.kind === 'adjustment' && r.balance_after != null && prev != null) {
          adjustDelta.set(r.id, n2(r.balance_after - prev));
        }
        if (r.balance_after != null) prev = r.balance_after;
      }
    }

    // 3. OIL — its own ledger already carries receipts and issues.
    for (const s of all(
      `SELECT s.id, s.kind, s.qty, s.unit_price, s.txn_date, s.asset_id, s.job_id, s.mr_no, s.consumer, s.store_id,
              p.name, p.code
         FROM stock_ledger s JOIN products p ON p.id = s.product_id
        WHERE COALESCE(s.voided,0) = 0`)) {
      const kind = s.kind === 'issue' ? 'out' : (s.kind === 'opening' ? 'opening' : (s.kind === 'adjustment' ? 'adjust' : 'in'));
      // `adjust` is the one kind that carries a sign: every balance reads it as `THEN qty`, so a
      // negative delta subtracts with no change to a single balance query.
      const qty = kind === 'adjust' && adjustDelta.has(s.id) ? adjustDelta.get(s.id) : Math.abs(s.qty);
      insert({ section: 'oil', kind, item_key: itemKey('oil', s.name, s.code || s.name), item_name: s.name,
        qty, unit_price: s.unit_price, txn_date: s.txn_date, asset_id: s.asset_id, job_id: s.job_id,
        ref: s.mr_no, note: s.consumer, source_table: 'stock_ledger', source_id: s.id, store_id: s.store_id });
    }

    // 4. FILTERS consumed on a service — the only record of filters actually used.
    for (const f of all(
      `SELECT f.id, f.filter_no, f.filter_no_norm, f.category, f.qty, f.price,
              s.service_date, s.asset_id, s.job_no, s.store_id
         FROM service_filters f JOIN service_jobs s ON s.id = f.service_id
        WHERE COALESCE(f.qty,0) > 0`)) {
      // The issue side needs the number dug out of the writing just as much as the receipt side.
      // 105 service lines name TWO filters at once — "JS-1030 & 278 607 989 916" — and joined up
      // they made a key no receipt could ever carry, so a filter was fitted and never once met
      // the one that was bought.
      //
      // The owner confirmed (2026-08-21) that BOTH filters are fitted on such a line, so both
      // come off the shelf: one movement each, at the line's own quantity. That is why
      // stock_moves' unique key includes item_key — otherwise the second movement collides with
      // the first and INSERT OR IGNORE drops it without a word.
      const found = filterParts(f.filter_no);
      const lines = found.length
        ? found.map((p) => ({ key: p.key, name: p.text }))
        : [{ key: itemKey('filter', f.filter_no, f.filter_no_norm || f.filter_no), name: f.filter_no || f.category }];
      for (const ln of lines) {
        insert({ section: 'filter', kind: 'out', item_key: ln.key,
          item_name: ln.name, qty: f.qty, unit_price: null, txn_date: f.service_date,
          asset_id: f.asset_id, ref: f.job_no,
          // The line as the fitter wrote it, so a split movement can always be read back to it.
          note: lines.length > 1 ? `${f.category || 'filter'} · fitted with ${f.filter_no}` : f.category,
          source_table: 'service_filters', source_id: f.id, store_id: f.store_id });
      }
    }

    // 4b. THE FILTER SHELF ITSELF, as the workshop counts it.
    //
    // The filter section starts from a cut-over instead of counting all history, because filter
    // purchases were never recorded in stores — and nothing was ever brought in to open it FROM.
    // rebuild() read the GRNs, the services, the tyre and battery ledgers and the oil book, and
    // never once read filter_stock: 144 rows, 663 units, kept from the owner's own filter folders
    // and backed by its own ledger. So every filter fitted after the cut-over came off a shelf the
    // system believed was empty, and read minus one.
    //
    // The count is placed ON the cut-over date, which is what a cut-over means: this is what was
    // there when we started counting. Only a filter the catalogue recognises is opened — the key
    // has to be the one the services issue against, or the opening would sit in its own row and
    // help nothing.
    const filterCutover = (rules.filter && rules.filter.mode === 'cutover' && rules.filter.cutover) || null;
    if (filterCutover) {
      for (const f of all(`SELECT id, part_no, filter_type, qty_in_stock, unit_cost FROM filter_stock
                            WHERE COALESCE(qty_in_stock,0) > 0 AND NULLIF(part_no,'') IS NOT NULL`)) {
        const key = filterKey(f.part_no) || normF(f.part_no);
        if (!key) continue;
        insert({ section: 'filter', kind: 'opening', item_key: key,
          item_name: f.part_no + (f.filter_type ? ' — ' + f.filter_type : ''),
          qty: f.qty_in_stock, unit_price: f.unit_cost, txn_date: filterCutover,
          note: 'on the shelf at the cut-over, from the filter register',
          source_table: 'filter_stock', source_id: f.id, counts: 1 });
      }
    }

    // 5. TYRE / BATTERY issues from their imported ledger.
    for (const t of all(
      `SELECT id, kind, issue_date, vehicle, asset_id, qty, category, category_norm, site, store_id
         FROM tyre_battery_issues WHERE COALESCE(qty,0) > 0`)) {
      const section = t.kind === 'battery' ? 'battery' : 'tyre';
      insert({ section, kind: 'out', item_key: itemKey(section, t.category, t.category_norm || t.category),
        item_name: t.category, qty: t.qty, txn_date: t.issue_date, asset_id: t.asset_id,
        ref: t.vehicle, note: t.site, source_table: 'tyre_battery_issues', source_id: t.id, store_id: t.store_id });
    }

    // A HANDOVER FROM THE TRACKER STILL KNOWS WHICH RECEIPT IT CAME OUT OF — through the MR
    // number the storekeeper wrote on it. The import flattened the item into free text,
    // "AC-Belt (45) — Mellawagedara (to Madushan)": itemKey() drops the bracket so the recipient
    // falls away, but "— Mellawagedara" is the SITE and it survives into the key, filing the
    // handover apart from the receipt of the very same belt. Six items read negative for want of
    // this link. The description is left exactly as written — the site and the recipient are
    // information the receipt does not carry — and only the KEY follows the receipt.
    const mrnLinesByNo = new Map();
    for (const l of all(`SELECT m.mrn_no, ml.id, ml.description, ml.category,
                                (SELECT g.id FROM grn g WHERE g.mrn_line_id = ml.id LIMIT 1) AS grn_id
                           FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
                          WHERE NULLIF(m.mrn_no,'') IS NOT NULL`)) {
      if (!mrnLinesByNo.has(l.mrn_no)) mrnLinesByNo.set(l.mrn_no, []);
      mrnLinesByNo.get(l.mrn_no).push(l);
    }
    // What the storekeeper actually handed over, with the recipient and the site stripped off.
    const baseItem = (desc) => String(desc || '').split(' — ')[0].replace(/\(\s*to\b[^)]*\)/gi, ' ').trim();

    // 6. Stores issues booked straight to a vehicle.
    for (const i of all(
      `SELECT i.id, i.description, i.qty, i.unit_price, i.issue_date, i.asset_id, i.job_id, i.store_item_id,
              i.grn_id, i.mrn_no, COALESCE(i.voided,0) AS voided, si.category, si.name, i.store_id,
              g.description AS grn_desc, gml.category AS grn_category, gml.id AS grn_mrn_line_id,
              (SELECT sm.counts FROM stock_moves sm
                WHERE sm.source_table = 'grn' AND sm.source_id = i.grn_id LIMIT 1) AS grn_counts
         FROM issues i
         LEFT JOIN store_items si ON si.id = i.store_item_id
         LEFT JOIN grn g          ON g.id = i.grn_id
         LEFT JOIN mrn_lines gml  ON gml.id = g.mrn_line_id
        WHERE COALESCE(i.qty,0) > 0`)) {
      // An issue raised against a specific receipt mirrors that receipt: same section, same
      // key, and the same counts flag — a cut-over receipt was never added to the balance, so
      // taking it out must not subtract from one either.
      const fromReceipt = i.grn_id != null;
      let name = (fromReceipt ? (i.grn_desc || i.description) : (i.name || i.description)) || '';
      let section = sectionOf(fromReceipt ? (i.grn_category || name) : (i.category || i.description));
      let key = itemKey(section, name);
      // No GRN on the row, but an MR number that names one: file it under the line it came from.
      // Matched on the item alone, and only when exactly ONE line on that request is that item —
      // a request listing the same thing twice is not something to guess between.
      if (!fromReceipt && i.mrn_no && mrnLinesByNo.has(i.mrn_no)) {
        const want = itemKey(section, baseItem(i.description));
        const hits = mrnLinesByNo.get(i.mrn_no)
          .filter((l) => itemKey(sectionOf(l.category || l.description), l.description) === want);
        if (hits.length === 1) {
          const l = hits[0];
          section = sectionOf(l.category || l.description);
          key = itemKey(section, l.description);
          name = i.description;                     // what the storekeeper wrote stays on the row
        }
      }
      insert({ section, kind: 'out', item_key: key, item_name: name,
        qty: i.qty, unit_price: i.unit_price, txn_date: i.issue_date, asset_id: i.asset_id, job_id: i.job_id,
        store_item_id: i.store_item_id, grn_id: i.grn_id || null, mrn_line_id: i.grn_mrn_line_id || null,
        source_table: 'issues', source_id: i.id, store_id: i.store_id,
        // A handover written down twice stays visible and stops counting the second time — the
        // free-hand row is the only place the recipient's name survives, so it is muted, never
        // deleted.
        force_history: i.voided ? true : undefined,
        // Only a receipt-sourced handover overrides the rule; leave everything else to the
        // section's cut-over date, or pre-cut-over issues would start counting out of a
        // balance they were never counted into.
        counts: fromReceipt && i.grn_counts != null ? i.grn_counts : undefined });
    }

    // 6b. RETURNS (Stage 6): parts brought back unused go back onto the shelf they left — the
    // mirror of the issue's own movement written just above: same item, same store, same count.
    for (const r of all(`SELECT r.id, r.qty, r.return_date, r.note, r.issue_id FROM issue_returns r`)) {
      const om = get("SELECT * FROM stock_moves WHERE source_table = 'issues' AND source_id = ? AND kind = 'out' LIMIT 1", r.issue_id);
      if (!om) continue;
      if (writeMove({ section: om.section, kind: 'in', item_key: om.item_key, item_name: om.item_name, qty: r.qty,
        unit_price: om.unit_price, txn_date: r.return_date, asset_id: om.asset_id, job_id: om.job_id, mrn_line_id: om.mrn_line_id,
        grn_id: om.grn_id, store_item_id: om.store_item_id, ref: 'Return', note: r.note, source_table: 'issue_returns',
        source_id: r.id, store_id: om.store_id }, om.counts, mainStore)) bump(om.section, 'in');
    }

    // 7. TRANSFERS BETWEEN TWO STORES (Stage 4) — see transfers() above.
    transfers(null);

    // 8. STOCK TAKES, store by store (Stage 4): the difference each count found.
    for (const c of all('SELECT * FROM store_counts WHERE delta <> 0')) insert(countMove(c));
  });

  return rep;
}

// general_item_txns rows carry the store item's name in `name`.
function si_name(t) { return t.name || ''; }

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

// Stage 4: every read takes a store. `store` = one store's shelf (transfers in and out of it
// included); none = every store together, where a transfer between two stores is left out of the
// received and issued figures (it is one store's issue and another's receipt, and cancels out).
const storeWhere = (alias, store) => (store
  ? { sql: ` AND ${alias}store_id = ?`, params: [store] }
  : { sql: ` AND ${alias}source_table <> 'mtn_lines'`, params: [] });

/** Headline figures for a section: received, issued, balance — in one store, or in all. */
function summary(section, opts = {}) {
  const st = storeWhere('', opts.store);
  const rows = all(
    `SELECT kind, ROUND(COALESCE(SUM(qty),0),2) v, COUNT(*) c
       FROM stock_moves WHERE section = ? AND counts = 1${st.sql} GROUP BY kind`, section, ...st.params);
  // History that predates the cut-over — shown, but deliberately outside the balance.
  const hist = get(
    `SELECT COUNT(*) c, ROUND(COALESCE(SUM(CASE WHEN kind='out' THEN qty ELSE 0 END),0),2) issued
       FROM stock_moves WHERE section = ? AND counts = 0${st.sql}`, section, ...st.params);
  const by = {};
  for (const r of rows) by[r.kind] = r;
  const inQty = (by.in ? by.in.v : 0) + (by.opening ? by.opening.v : 0) + (by.adjust ? by.adjust.v : 0);
  const outQty = by.out ? by.out.v : 0;
  return {
    section,
    store_id: opts.store || null,
    opening: openingRules()[section] || null,
    received: n2(inQty), received_lines: (by.in ? by.in.c : 0),
    issued: n2(outQty), issued_lines: (by.out ? by.out.c : 0),
    balance: n2(inQty - outQty),
    items: get(`SELECT COUNT(DISTINCT item_key) c FROM stock_moves WHERE section = ?${opts.store ? ' AND store_id = ?' : ''}`,
      section, ...(opts.store ? [opts.store] : [])).c,
    history_moves: hist.c, history_issued: hist.issued,
  };
}

/** What one item holds on the shelf: in one store, or in all. */
function balanceOf(section, itemKey, store) {
  return get(
    `SELECT ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0 WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),0),2) v
       FROM stock_moves WHERE section = ? AND item_key = ?${store ? ' AND store_id = ?' : ''}`,
    section, itemKey, ...(store ? [store] : [])).v;
}

/**
 * Per-item position within a section. opts.store: one store's shelf, with its reorder level
 * (reorder_level) — and opts.low keeps only what is at or under it. With no store and opts.byStore,
 * each item also says what every store holds (by_store).
 */
function items(section, q, limit = 500, opts = {}) {
  const like = q ? '%' + String(q).trim() + '%' : null;
  const store = opts.store || null;
  const st = storeWhere('sm.', store);
  const match = (col) => (like ? `AND ${col} IN (
              -- Pick which ITEMS match, then total ALL of each one's movements. Filtering the
              -- movements instead would show a partial balance: several spellings share one row
              -- now, so searching "HD-68" would total only the rows spelt that way (600 of 427).
              SELECT item_key FROM stock_moves WHERE section = ? AND (item_name LIKE ? OR item_key LIKE ?)
              UNION
              SELECT item_key FROM stock_items WHERE section = ? AND (name LIKE ? OR code LIKE ?))` : '');
  const matchParams = like ? [section, like, like, section, like, like] : [];
  const rows = all(
    // Several spellings now share one row (a lubricant is keyed by its product), so MAX(item_name)
    // would label the shelf with whichever spelling sorted last — "Grease (to RA-3051)" for the
    // grease. Where the catalogue knows the item, its name is the one the workshop agreed on.
    `SELECT sm.item_key, COALESCE(MAX(ci.name), MAX(sm.item_name)) AS item_name,
            -- A stock-take write-down is a negative 'adjust'. It belongs in the balance, but not
            -- in "Received" — nothing arrived. So the column stays a receipts figure, and a
            -- corrected shelf reads lower than received minus issued, which is what happened.
            ROUND(COALESCE(SUM(CASE WHEN counts = 1 AND (kind IN ('in','opening') OR (kind = 'adjust' AND qty > 0)) THEN qty ELSE 0 END),0),2) AS received,
            ROUND(COALESCE(SUM(CASE WHEN counts = 1 AND kind = 'out' THEN qty ELSE 0 END),0),2) AS issued,
            ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0 WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),0),2) AS balance,
            ROUND(COALESCE(SUM(CASE WHEN kind = 'out' THEN qty ELSE 0 END),0),2) AS issued_all_time,
            MAX(txn_date) AS last_move,
            SUM(CASE WHEN kind = 'out' THEN 1 ELSE 0 END) AS issue_count
            ${store ? ', (SELECT r.level FROM store_reorder r WHERE r.store_id = ? AND r.section = sm.section AND r.item_key = sm.item_key) AS reorder_level' : ''}
       FROM stock_moves sm
       LEFT JOIN stock_items ci ON ci.section = sm.section AND ci.item_key = sm.item_key
      WHERE sm.section = ?${st.sql} ${match('sm.item_key')}
      GROUP BY sm.item_key
      ${store && opts.low ? 'HAVING reorder_level > 0 AND balance <= reorder_level' : ''}
      -- Stock on hand first; then, for a section that has just cut over (every balance 0),
      -- the items that actually move — most used, most recent — rather than an arbitrary order.
      ORDER BY balance DESC, issued_all_time DESC, last_move DESC
      LIMIT ${Number(limit) || 500}`,
    ...(store ? [store] : []), section, ...st.params, ...matchParams);

  if (store) {
    // An item the store keeps a level for but has never moved there: nothing on its shelf, so it
    // is due for reorder.
    const extra = all(
      `SELECT r.item_key, COALESCE(ci.name, (SELECT sm.item_name FROM stock_moves sm WHERE sm.section = r.section AND sm.item_key = r.item_key LIMIT 1)) AS item_name,
              0 AS received, 0 AS issued, 0 AS balance, 0 AS issued_all_time, NULL AS last_move, 0 AS issue_count, r.level AS reorder_level
         FROM store_reorder r LEFT JOIN stock_items ci ON ci.section = r.section AND ci.item_key = r.item_key
        WHERE r.store_id = ? AND r.section = ? ${match('r.item_key')}
          AND NOT EXISTS (SELECT 1 FROM stock_moves sm WHERE sm.store_id = r.store_id AND sm.section = r.section AND sm.item_key = r.item_key)`,
      store, section, ...matchParams);
    rows.push(...extra);
  }
  if (rows.length) {
    // When each item was last counted (in this store, or in any), and what it is worth (stores plan, Part 2).
    const last = new Map(all(`SELECT item_key, MAX(count_date) d FROM store_counts WHERE section = ?${store ? ' AND store_id = ?' : ''} GROUP BY item_key`,
      section, ...(store ? [store] : [])).map((r) => [r.item_key, r.d]));
    for (const r of rows) r.last_count = last.get(r.item_key) || null;
  }
  priceRows(section, rows);
  if (!store && opts.byStore && rows.length) {
    const keys = rows.map((r) => r.item_key);
    const per = new Map();
    for (const b of all(
      `SELECT sm.item_key, sm.store_id, w.code AS store_code,
              ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0 WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),0),2) AS balance
         FROM stock_moves sm LEFT JOIN workshops w ON w.id = sm.store_id
        WHERE sm.section = ? AND sm.item_key IN (${keys.map(() => '?').join(',')})
        GROUP BY sm.item_key, sm.store_id ORDER BY w.is_default DESC, w.code`, section, ...keys)) {
      if (!per.has(b.item_key)) per.set(b.item_key, []);
      per.get(b.item_key).push({ store_id: b.store_id, store_code: b.store_code, balance: b.balance });
    }
    for (const r of rows) r.by_store = per.get(r.item_key) || [];
  }
  return rows;
}

/**
 * What each item is worth: its last price paid (any store), else its catalogue price; the value of
 * the stock is that price × what is on the shelf (nothing for a shelf at or under 0).
 */
function priceRows(section, rows) {
  if (!rows.length) return;
  const price = new Map();
  for (const r of all("SELECT item_key, unit_price FROM stock_items WHERE section = ? AND unit_price > 0", section)) price.set(r.item_key, r.unit_price);
  for (const r of all(`SELECT item_key, unit_price FROM stock_moves WHERE section = ? AND unit_price > 0 AND kind IN ('in','opening')
                        ORDER BY txn_date, id`, section)) price.set(r.item_key, r.unit_price);
  for (const r of rows) {
    r.unit_price = price.has(r.item_key) ? n2(price.get(r.item_key)) : null;
    r.value = r.unit_price != null && r.balance > 0 ? n2(r.balance * r.unit_price) : 0;
  }
}

/** The value of what a section holds — in one store, or in all. */
function valueOf(section, store) {
  const rows = items(section, null, 100000, { store });
  return { value: n2(rows.reduce((t, r) => t + r.value, 0)), unpriced: rows.filter((r) => r.balance > 0 && r.unit_price == null).length };
}

/** Every movement, newest first — the audit trail behind a section or one item (in one store, or all). */
function moves(section, opts = {}) {
  const w = ['sm.section = ?'];
  const p = [section];
  if (opts.store) { w.push('sm.store_id = ?'); p.push(opts.store); }
  if (opts.item_key) { w.push('sm.item_key = ?'); p.push(opts.item_key); }
  if (opts.kind) { w.push('sm.kind = ?'); p.push(opts.kind); }
  if (opts.q) { const l = '%' + String(opts.q).trim() + '%'; w.push('(sm.item_name LIKE ? OR sm.ref LIKE ? OR a.code LIKE ? OR a.registration LIKE ?)'); p.push(l, l, l, l); }
  return all(
    `SELECT sm.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, j.job_no, sw.code AS store_code
       FROM stock_moves sm
       LEFT JOIN assets a ON a.id = sm.asset_id
       LEFT JOIN job_cards j ON j.id = sm.job_id
       LEFT JOIN workshops sw ON sw.id = sm.store_id
      WHERE ${w.join(' AND ')}
      ORDER BY sm.txn_date DESC, sm.id DESC
      LIMIT ${Number(opts.limit) || 500}`, ...p);
}

// ---------------------------------------------------------------------------
// Item registry — one unique code per issuable item, across every section
// ---------------------------------------------------------------------------

const PREFIX = { oil: 'OIL', filter: 'FIL', battery: 'BAT', tyre: 'TYR', general: 'GEN' };

/** Next free code for a section, continuing the existing sequence. */
function nextCode(section) {
  const p = PREFIX[section] || 'ITM';
  const row = get(
    `SELECT code FROM stock_items WHERE section = ? AND code LIKE ? ORDER BY LENGTH(code) DESC, code DESC LIMIT 1`,
    section, p + '-%');
  const n = row ? (parseInt(String(row.code).split('-').pop(), 10) || 0) : 0;
  return p + '-' + String(n + 1).padStart(4, '0');
}

/**
 * Build/refresh the registry from the source tables. Existing codes are never reissued or
 * changed — an item keeps the code it was given, so paperwork stays valid.
 */
function syncItems() {
  const rep = { added: 0, updated: 0, by_section: {} };
  const add = (section, name, opts = {}) => {
    const key = itemKey(section, name, opts.key_source || name);
    if (!key || key === 'UNKNOWN') return;
    const found = get('SELECT id, code FROM stock_items WHERE section = ? AND item_key = ?', section, key);
    if (found) {
      run(`UPDATE stock_items SET name = COALESCE(?, name), part_no = COALESCE(?, part_no),
             unit = COALESCE(?, unit), unit_price = COALESCE(?, unit_price), source_table = ?, source_id = COALESCE(?, source_id)
           WHERE id = ?`,
        name || null, opts.part_no || null, opts.unit || null, opts.unit_price == null ? null : n2(opts.unit_price),
        opts.source_table, opts.source_id || null, found.id);
      rep.updated++;
      return;
    }
    // General stock already carries its own numbering — keep it rather than inventing another.
    const code = opts.code || nextCode(section);
    run(`INSERT OR IGNORE INTO stock_items (code, section, name, part_no, item_key, unit, unit_price, source_table, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code, section, name, opts.part_no || null, key, opts.unit || null,
      opts.unit_price == null ? null : n2(opts.unit_price), opts.source_table, opts.source_id || null);
    rep.added++;
    rep.by_section[section] = (rep.by_section[section] || 0) + 1;
  };

  tx(() => {
    for (const p of all('SELECT id, code, name, unit, unit_price FROM products'))
      add('oil', p.name, { part_no: p.code, unit: p.unit, unit_price: p.unit_price, source_table: 'products', source_id: p.id, key_source: p.code || p.name });

    for (const f of all('SELECT id, filter_no, filter_no_norm, category, unit_price FROM filter_prices'))
      add('filter', f.filter_no, { part_no: f.filter_no, unit: 'nos', unit_price: f.unit_price, source_table: 'filter_prices', source_id: f.id, key_source: f.filter_no_norm || f.filter_no });

    for (const t of all("SELECT id, kind, category, category_norm, unit_price FROM tyre_battery_prices"))
      add(t.kind === 'battery' ? 'battery' : 'tyre', t.category, { unit: 'nos', unit_price: t.unit_price, source_table: 'tyre_battery_prices', source_id: t.id, key_source: t.category_norm || t.category });

    for (const s of all("SELECT id, item_no, name, part_number, unit, category FROM store_items WHERE COALESCE(name,'') <> ''"))
      add('general', s.name, { code: s.item_no || undefined, part_no: s.part_number, unit: s.unit, source_table: 'store_items', source_id: s.id, key_source: s.name });
  });
  return rep;
}

/** Search issuable items — by code, name or supplier part number. */
function searchItems(q, section, limit = 25, store = null) {
  const t = String(q || '').trim();
  const like = '%' + t + '%';
  const where = ['si.active = 1'];
  const p = [];
  if (section && SECTIONS.includes(section)) { where.push('si.section = ?'); p.push(section); }
  if (t) { where.push('(si.code LIKE ? OR si.name LIKE ? OR si.part_no LIKE ?)'); p.push(like, like, like); }
  // Stage 4: the balance is the one on the shelf the issue comes out of, when that is known.
  const inStore = store ? ' AND sm.store_id = ?' : '';
  return all(
    `SELECT si.*,
            ROUND(COALESCE((SELECT SUM(CASE WHEN sm.counts = 0 THEN 0
                                            WHEN sm.kind IN ('in','opening','adjust') THEN sm.qty ELSE -sm.qty END)
                              FROM stock_moves sm
                             WHERE sm.section = si.section AND sm.item_key = si.item_key${inStore}), 0), 2) AS balance,
            (SELECT MAX(sm.txn_date) FROM stock_moves sm WHERE sm.section = si.section AND sm.item_key = si.item_key${inStore}) AS last_move
       FROM stock_items si
      WHERE ${where.join(' AND ')}
      ORDER BY (si.code = ?) DESC, balance DESC, si.name
      LIMIT ${Number(limit) || 25}`, ...(store ? [store, store] : []), ...p, t.toUpperCase());
}

/**
 * What has actually been RECEIVED for a vehicle (or a job, or one MRN) and how much of it is
 * still on the shelf.
 *
 * This answers a different question from searchItems: not "what does the catalogue call this
 * item" but "what did we buy for this vehicle, and is it still here". The two are deliberately
 * kept apart, because a receipt's description carries the identity the catalogue loses — a
 * GRN line reads "Oil Filter (C-519)" while itemKey collapses it to OILFILTER along with every
 * other oil filter. Issuing from a receipt therefore quotes the receipt, not the catalogue.
 *
 * `issued` is counted per RECEIPT, not per request line: 56 MRN lines were delivered in more
 * than one GRN, and a per-line total would be subtracted from every one of those rows at once,
 * hiding stock that is physically on the shelf. It reads from `issues` rather than the ledger
 * so that rebuilding stock_moves cannot resurrect stock that has already been handed out.
 */
function receivedLines({ assetId, jobId, mrn, q, limit = 200, includeDone = false, allowEmpty = false, store = null } = {}) {
  const where = [];
  const p = [];
  if (assetId) { where.push('(m.asset_id = ? OR j.asset_id = ?)'); p.push(assetId, assetId); }
  if (jobId) { where.push('(m.job_id = ? OR jp.job_id = ?)'); p.push(jobId, jobId); }
  if (mrn) { where.push('m.mrn_no LIKE ?'); p.push('%' + String(mrn).trim() + '%'); }
  if (q) {
    where.push("(COALESCE(g.description, ml.description) LIKE ? OR m.mrn_no LIKE ? OR g.grn_no LIKE ? OR a.code LIKE ? OR a.registration LIKE ?)");
    const like = '%' + String(q).trim() + '%';
    p.push(like, like, like, like, like);
  }
  if (!where.length && !allowEmpty) return [];
  // Stage 4: only what is on this store's shelf (the store that received it).
  if (store) { where.push('g.store_id = ?'); p.push(store); }

  const rows = all(
    `SELECT g.id                                   AS grn_id,
            g.grn_no, g.qty, g.unit_price, g.supplier, g.invoice_no, g.store_id,
            -- delivery_date alone. created_at is when the ROW was written, which for 3270 of
            -- these receipts is the import run — a fallback onto it would tell the storekeeper
            -- the part arrived on the day the system was loaded. See src/lib/received_date.js.
            date(NULLIF(g.delivery_date, '')) AS received_date,
            COALESCE(g.description, ml.description) AS description,
            -- What is actually on the box, when a cross-referenced part was supplied.
            g.received_part_no,
            ml.id                                   AS mrn_line_id,
            ml.category, ml.unit,
            m.mrn_no, m.req_date, m.asset_id        AS mrn_asset_id,
            COALESCE(m.asset_id, j.asset_id)        AS asset_id,
            COALESCE(m.purchase_source, g.purchase_source_norm) AS source,
            a.code AS asset_code, a.registration AS asset_reg,
            COALESCE(jc.id, m.job_id, jp.job_id)    AS job_id,
            jc.job_no,
            -- Stage 6: what came back unused (return notes) is on the shelf again.
            ROUND((COALESCE((SELECT SUM(i.qty) FROM issues i WHERE i.grn_id = g.id), 0) - COALESCE((SELECT SUM(r.qty) FROM issue_returns r JOIN issues ir ON ir.id = r.issue_id WHERE ir.grn_id = g.id), 0)), 2) AS issued
       FROM grn g
       JOIN mrn_lines ml ON ml.id = g.mrn_line_id
       JOIN mrn m        ON m.id  = ml.mrn_id
       LEFT JOIN job_parts jp ON jp.mrn_line_id = ml.id
       LEFT JOIN job_cards j  ON j.id = jp.job_id
       LEFT JOIN job_cards jc ON jc.id = COALESCE(m.job_id, jp.job_id)
       LEFT JOIN assets a     ON a.id = COALESCE(m.asset_id, j.asset_id)
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY g.id
      ${includeDone ? '' : 'HAVING COALESCE(g.qty,0) - (COALESCE((SELECT SUM(i2.qty) FROM issues i2 WHERE i2.grn_id = g.id), 0) - COALESCE((SELECT SUM(r2.qty) FROM issue_returns r2 JOIN issues ir2 ON ir2.id = r2.issue_id WHERE ir2.grn_id = g.id), 0)) > 0.001'}
      ORDER BY date(NULLIF(g.delivery_date, '')) IS NULL, date(NULLIF(g.delivery_date, '')) DESC, g.id DESC
      LIMIT ${Number(limit) || 200}`, ...p);

  for (const r of rows) {
    r.section = sectionOf(r.category);
    r.item_key = itemKey(r.section, r.description);
    r.remaining = Math.round((Number(r.qty || 0) - Number(r.issued || 0)) * 100) / 100;
    r.vehicle = r.asset_reg || r.asset_code || null;
  }
  // The "still on the shelf" test is applied in SQL (HAVING) rather than here, so the LIMIT
  // counts rows the user can actually act on — filtering after the cut would let a busy
  // vehicle's outstanding stock fall off the end of the page and look like nothing is there.
  return rows;
}

/** One received line by its GRN id, with the same derived fields. */
function receivedLine(grnId) {
  const r = get(
    `SELECT g.id AS grn_id, g.grn_no, g.qty, g.unit_price, g.store_id,
            COALESCE(g.description, ml.description) AS description,
            -- What is actually on the box, when a cross-referenced part was supplied.
            g.received_part_no,
            -- The picker (receivedLines above) shows when this arrived; carry it through the
            -- selection instead of dropping it the moment the line is chosen.
            date(NULLIF(g.delivery_date, '')) AS received_date,
            ml.id AS mrn_line_id, ml.category, ml.unit, ml.store_item_id,
            m.mrn_no, m.asset_id AS mrn_asset_id, m.job_id AS mrn_job_id
       FROM grn g JOIN mrn_lines ml ON ml.id = g.mrn_line_id JOIN mrn m ON m.id = ml.mrn_id
      WHERE g.id = ?`, grnId);
  if (!r) return null;
  r.section = sectionOf(r.category);
  r.item_key = itemKey(r.section, r.description);
  r.issued = get(`SELECT ROUND(COALESCE(SUM(qty),0) - COALESCE((SELECT SUM(r.qty) FROM issue_returns r JOIN issues ir ON ir.id = r.issue_id
                                                          WHERE ir.grn_id = ?), 0), 2) v
                    FROM issues WHERE grn_id = ?`, grnId, grnId).v;
  r.remaining = Math.round((Number(r.qty || 0) - Number(r.issued || 0)) * 100) / 100;
  // Whether the receipt itself counts toward the section balance. Filters, batteries, tyres and
  // oil open from a cut-over, so their older receipts are history (counts = 0) and were never
  // added to the balance — taking one out with a counting move would push the section negative
  // for stock that was never counted in. The handover mirrors whatever the receipt did.
  const inMove = get(
    "SELECT counts FROM stock_moves WHERE source_table = 'grn' AND source_id = ? LIMIT 1", grnId);
  r.counts = inMove ? inMove.counts : 1;
  return r;
}

module.exports = { filterParts, filterKey, SECTIONS, PREFIX, sectionOf, itemKey, rebuild, summary, items, moves, openingRules,
  nextCode, syncItems, searchItems, receivedLines, receivedLine, balanceOf, recordCount, valueOf };
