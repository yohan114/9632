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

  const insert = (m) => {
    // The section rule runs BOTH ways. A drum of kerosene bought on a request someone
    // categorised "General Items" is still kerosene, and leaving it in the general section put
    // its receipts in one book and its issues in another — which is how five lubricants came
    // to show a NEGATIVE balance (WD-40 -46, Karosine -49.5) while the general balance
    // carried 1,100 units of oil, diesel and grease that were never general items.
    // A lubricant is oil stock wherever it was written down. (itemKey ignores the section, so
    // promoting here does not change how the movement is identified.)
    if (m.section !== 'oil' && lubricants.isLubricant(m.item_name, m.txn_date)) m.section = 'oil';
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
    if (counts && m.section === 'oil' && !lubricants.isLubricant(m.item_name, m.txn_date)) {
      lubricants.resolveLubricant(m.item_name, { source: m.source_table });  // remember it
      counts = 0;
    }
    if (!counts) rep.history_only++;
    const info = run(
      `INSERT OR IGNORE INTO stock_moves
        (section, kind, item_key, item_name, qty, unit_price, txn_date, asset_id, job_id,
         mrn_line_id, grn_id, store_item_id, ref, note, source_table, source_id, counts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.section, m.kind, m.item_key, m.item_name || null, n2(m.qty), m.unit_price == null ? null : n2(m.unit_price),
      d10(m.txn_date), m.asset_id || null, m.job_id || null, m.mrn_line_id || null, m.grn_id || null,
      m.store_item_id || null, m.ref || null, m.note || null, m.source_table, m.source_id, counts);
    if (info.changes) bump(m.section, m.kind);
  };

  tx(() => {
    if (opts.wipe) run('DELETE FROM stock_moves');

    // 1. RECEIPTS (all sections) — the link that was missing entirely.
    for (const g of all(
      `SELECT g.id, g.qty, g.unit_price, g.delivery_date, g.description, g.grn_no, g.mrn_line_id, g.store_item_id,
              ml.category AS line_cat, ml.description AS line_desc, si.category AS item_cat, si.name AS item_name,
              m.mrn_no, m.asset_id, m.job_id
         FROM grn g
         LEFT JOIN mrn_lines ml ON ml.id = g.mrn_line_id
         LEFT JOIN store_items si ON si.id = g.store_item_id
         LEFT JOIN mrn m ON m.id = g.mrn_id
        WHERE COALESCE(g.qty,0) > 0`)) {
      const section = sectionOf(g.line_cat || g.item_cat);
      const name = g.description || g.line_desc || g.item_name || '';
      // Oil bought through stores used to be muted wholesale, because some of it was ALSO
      // booked as a top-up in the oil book's own ledger and would have been counted twice.
      // That blanket rule hid 17 genuine deliveries the ledger never knew about — more than
      // it protected. The seven that really were written twice are now settled on the other
      // side: their ledger row is voided (scripts/reconcile_oil_receipts.js), and a voided
      // ledger row is skipped a few blocks below. So a receipt is simply a receipt.
      insert({ section, kind: 'in', item_key: itemKey(section, name), item_name: name,
        qty: g.qty, unit_price: g.unit_price, txn_date: g.delivery_date, asset_id: g.asset_id, job_id: g.job_id,
        mrn_line_id: g.mrn_line_id, store_item_id: g.store_item_id,
        ref: g.grn_no || g.mrn_no || null, source_table: 'grn', source_id: g.id });
    }

    // 2. GENERAL issues / receipts / openings — its own running ledger.
    for (const t of all(
      `SELECT t.id, t.txn_type, t.qty, t.unit_price, t.txn_date, t.asset_id, t.job_id, t.ref, t.store_item_id,
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
        store_item_id: t.store_item_id, ref: t.ref, source_table: 'general_item_txns', source_id: t.id,
        force_history: dup, note: dup ? 'same delivery as the GRN receipt — counted there' : null });
    }

    // 3. OIL — its own ledger already carries receipts and issues.
    for (const s of all(
      `SELECT s.id, s.kind, s.qty, s.unit_price, s.txn_date, s.asset_id, s.job_id, s.mr_no, s.consumer,
              p.name, p.code
         FROM stock_ledger s JOIN products p ON p.id = s.product_id
        WHERE COALESCE(s.voided,0) = 0`)) {
      const kind = s.kind === 'issue' ? 'out' : (s.kind === 'opening' ? 'opening' : (s.kind === 'adjustment' ? 'adjust' : 'in'));
      insert({ section: 'oil', kind, item_key: itemKey('oil', s.name, s.code || s.name), item_name: s.name,
        qty: Math.abs(s.qty), unit_price: s.unit_price, txn_date: s.txn_date, asset_id: s.asset_id, job_id: s.job_id,
        ref: s.mr_no, note: s.consumer, source_table: 'stock_ledger', source_id: s.id });
    }

    // 4. FILTERS consumed on a service — the only record of filters actually used.
    for (const f of all(
      `SELECT f.id, f.filter_no, f.filter_no_norm, f.category, f.qty, f.price,
              s.service_date, s.asset_id, s.job_no
         FROM service_filters f JOIN service_jobs s ON s.id = f.service_id
        WHERE COALESCE(f.qty,0) > 0`)) {
      insert({ section: 'filter', kind: 'out', item_key: itemKey('filter', f.filter_no, f.filter_no_norm || f.filter_no),
        item_name: f.filter_no || f.category, qty: f.qty, unit_price: null, txn_date: f.service_date,
        asset_id: f.asset_id, ref: f.job_no, note: f.category, source_table: 'service_filters', source_id: f.id });
    }

    // 5. TYRE / BATTERY issues from their imported ledger.
    for (const t of all(
      `SELECT id, kind, issue_date, vehicle, asset_id, qty, category, category_norm, site
         FROM tyre_battery_issues WHERE COALESCE(qty,0) > 0`)) {
      const section = t.kind === 'battery' ? 'battery' : 'tyre';
      insert({ section, kind: 'out', item_key: itemKey(section, t.category, t.category_norm || t.category),
        item_name: t.category, qty: t.qty, txn_date: t.issue_date, asset_id: t.asset_id,
        ref: t.vehicle, note: t.site, source_table: 'tyre_battery_issues', source_id: t.id });
    }

    // 6. Stores issues booked straight to a vehicle.
    for (const i of all(
      `SELECT i.id, i.description, i.qty, i.unit_price, i.issue_date, i.asset_id, i.job_id, i.store_item_id,
              i.grn_id, si.category, si.name,
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
      const name = (fromReceipt ? (i.grn_desc || i.description) : (i.name || i.description)) || '';
      const section = sectionOf(fromReceipt ? (i.grn_category || name) : (i.category || i.description));
      insert({ section, kind: 'out', item_key: itemKey(section, name), item_name: name,
        qty: i.qty, unit_price: i.unit_price, txn_date: i.issue_date, asset_id: i.asset_id, job_id: i.job_id,
        store_item_id: i.store_item_id, grn_id: i.grn_id || null, mrn_line_id: i.grn_mrn_line_id || null,
        source_table: 'issues', source_id: i.id,
        // Only a receipt-sourced handover overrides the rule; leave everything else to the
        // section's cut-over date, or pre-cut-over issues would start counting out of a
        // balance they were never counted into.
        counts: fromReceipt && i.grn_counts != null ? i.grn_counts : undefined });
    }
  });

  return rep;
}

// general_item_txns rows carry the store item's name in `name`.
function si_name(t) { return t.name || ''; }

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

/** Headline figures for a section: on order, received, issued, balance. */
function summary(section) {
  const onOrder = get(
    `SELECT ROUND(COALESCE(SUM(ml.qty - COALESCE(ml.qty_received,0)),0),2) v, COUNT(*) c
       FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
      WHERE COALESCE(ml.qty_received,0) < ml.qty AND COALESCE(m.approval_status,'') <> 'rejected'`);
  const rows = all(
    `SELECT kind, ROUND(COALESCE(SUM(qty),0),2) v, COUNT(*) c
       FROM stock_moves WHERE section = ? AND counts = 1 GROUP BY kind`, section);
  // History that predates the cut-over — shown, but deliberately outside the balance.
  const hist = get(
    `SELECT COUNT(*) c, ROUND(COALESCE(SUM(CASE WHEN kind='out' THEN qty ELSE 0 END),0),2) issued
       FROM stock_moves WHERE section = ? AND counts = 0`, section);
  const by = {};
  for (const r of rows) by[r.kind] = r;
  const inQty = (by.in ? by.in.v : 0) + (by.opening ? by.opening.v : 0) + (by.adjust ? by.adjust.v : 0);
  const outQty = by.out ? by.out.v : 0;
  return {
    section,
    opening: openingRules()[section] || null,
    received: n2(inQty), received_lines: (by.in ? by.in.c : 0),
    issued: n2(outQty), issued_lines: (by.out ? by.out.c : 0),
    balance: n2(inQty - outQty),
    items: get('SELECT COUNT(DISTINCT item_key) c FROM stock_moves WHERE section = ?', section).c,
    history_moves: hist.c, history_issued: hist.issued,
  };
}

/** Per-item position within a section. */
function items(section, q, limit = 500) {
  const like = q ? '%' + String(q).trim() + '%' : null;
  return all(
    `SELECT item_key, MAX(item_name) AS item_name,
            ROUND(COALESCE(SUM(CASE WHEN counts = 1 AND kind IN ('in','opening','adjust') THEN qty ELSE 0 END),0),2) AS received,
            ROUND(COALESCE(SUM(CASE WHEN counts = 1 AND kind = 'out' THEN qty ELSE 0 END),0),2) AS issued,
            ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0 WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),0),2) AS balance,
            ROUND(COALESCE(SUM(CASE WHEN kind = 'out' THEN qty ELSE 0 END),0),2) AS issued_all_time,
            MAX(txn_date) AS last_move,
            SUM(CASE WHEN kind = 'out' THEN 1 ELSE 0 END) AS issue_count
       FROM stock_moves
      WHERE section = ? ${like ? 'AND (item_name LIKE ? OR item_key LIKE ?)' : ''}
      GROUP BY item_key
      -- Stock on hand first; then, for a section that has just cut over (every balance 0),
      -- the items that actually move — most used, most recent — rather than an arbitrary order.
      ORDER BY balance DESC, issued_all_time DESC, last_move DESC
      LIMIT ${Number(limit) || 500}`, ...(like ? [section, like, like] : [section]));
}

/** Every movement, newest first — the audit trail behind a section or one item. */
function moves(section, opts = {}) {
  const w = ['sm.section = ?'];
  const p = [section];
  if (opts.item_key) { w.push('sm.item_key = ?'); p.push(opts.item_key); }
  if (opts.kind) { w.push('sm.kind = ?'); p.push(opts.kind); }
  if (opts.q) { const l = '%' + String(opts.q).trim() + '%'; w.push('(sm.item_name LIKE ? OR sm.ref LIKE ? OR a.code LIKE ? OR a.registration LIKE ?)'); p.push(l, l, l, l); }
  return all(
    `SELECT sm.*, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, j.job_no
       FROM stock_moves sm
       LEFT JOIN assets a ON a.id = sm.asset_id
       LEFT JOIN job_cards j ON j.id = sm.job_id
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
function searchItems(q, section, limit = 25) {
  const t = String(q || '').trim();
  const like = '%' + t + '%';
  const where = ['si.active = 1'];
  const p = [];
  if (section && SECTIONS.includes(section)) { where.push('si.section = ?'); p.push(section); }
  if (t) { where.push('(si.code LIKE ? OR si.name LIKE ? OR si.part_no LIKE ?)'); p.push(like, like, like); }
  return all(
    `SELECT si.*,
            ROUND(COALESCE((SELECT SUM(CASE WHEN sm.counts = 0 THEN 0
                                            WHEN sm.kind IN ('in','opening','adjust') THEN sm.qty ELSE -sm.qty END)
                              FROM stock_moves sm
                             WHERE sm.section = si.section AND sm.item_key = si.item_key), 0), 2) AS balance,
            (SELECT MAX(sm.txn_date) FROM stock_moves sm WHERE sm.section = si.section AND sm.item_key = si.item_key) AS last_move
       FROM stock_items si
      WHERE ${where.join(' AND ')}
      ORDER BY (si.code = ?) DESC, balance DESC, si.name
      LIMIT ${Number(limit) || 25}`, ...p, t.toUpperCase());
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
function receivedLines({ assetId, jobId, mrn, q, limit = 200, includeDone = false } = {}) {
  const where = [];
  const p = [];
  if (assetId) { where.push('(m.asset_id = ? OR j.asset_id = ?)'); p.push(assetId, assetId); }
  if (jobId) { where.push('(m.job_id = ? OR jp.job_id = ?)'); p.push(jobId, jobId); }
  if (mrn) { where.push('m.mrn_no LIKE ?'); p.push('%' + String(mrn).trim() + '%'); }
  if (q) {
    where.push("(COALESCE(g.description, ml.description) LIKE ? OR m.mrn_no LIKE ? OR g.grn_no LIKE ?)");
    const like = '%' + String(q).trim() + '%';
    p.push(like, like, like);
  }
  if (!where.length) return [];

  const rows = all(
    `SELECT g.id                                   AS grn_id,
            g.grn_no, g.qty, g.unit_price, g.supplier, g.invoice_no,
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
            COALESCE(m.purchase_source, g.purchase_source_norm) AS source,
            a.code AS asset_code, a.registration AS asset_reg,
            jc.job_no,
            ROUND(COALESCE((SELECT SUM(i.qty) FROM issues i WHERE i.grn_id = g.id), 0), 2) AS issued
       FROM grn g
       JOIN mrn_lines ml ON ml.id = g.mrn_line_id
       JOIN mrn m        ON m.id  = ml.mrn_id
       LEFT JOIN job_parts jp ON jp.mrn_line_id = ml.id
       LEFT JOIN job_cards j  ON j.id = jp.job_id
       LEFT JOIN job_cards jc ON jc.id = COALESCE(m.job_id, jp.job_id)
       LEFT JOIN assets a     ON a.id = m.asset_id
      WHERE ${where.join(' AND ')}
      GROUP BY g.id
      ${includeDone ? '' : 'HAVING COALESCE(g.qty,0) - COALESCE((SELECT SUM(i2.qty) FROM issues i2 WHERE i2.grn_id = g.id), 0) > 0.001'}
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
    `SELECT g.id AS grn_id, g.grn_no, g.qty, g.unit_price,
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
  r.issued = get('SELECT ROUND(COALESCE(SUM(qty),0),2) v FROM issues WHERE grn_id = ?', grnId).v;
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

module.exports = { SECTIONS, PREFIX, sectionOf, itemKey, rebuild, summary, items, moves, openingRules,
  nextCode, syncItems, searchItems, receivedLines, receivedLine };
