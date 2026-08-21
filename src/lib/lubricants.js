'use strict';

// What counts as a lubricant, and which one.
//
// The oil book holds 22 products, each with a code the unified catalogue already minted
// (OIL-0001 … OIL-0022). Everywhere else the same drum is written differently — "Karosine Oil"
// in the oil ledger, "Kerosine Oil" on the request, "HD 68 Oil Valvoline" on the receipt
// against "HD 68 Oil (Valvoline)" in the book — so until a name resolves to a product, a
// receipt and a top-up cannot be recognised as the same delivery.
//
// WHY AN ALLOWLIST, NOT A WORD MATCH. A section used to be decided by whether the CATEGORY
// contained "oil" or "lubric". The workshop files Grease Gun, Oil Pump, Brake Oil Tank, Oil
// Spray Gun, Grease Nozzle and even repair notes like "Fuel Feed Pump repair (Oil leak)" under
// "Lubricants & Fluids" — so a word match counted tools, tanks and job descriptions as fluid
// stock. A thing is a lubricant when it RESOLVES TO A PRODUCT IN THE OIL BOOK, and not
// otherwise. Those items keep their category; they simply stop being stock in litres.
//
// NOTHING IS GUESSED. An unrecognised spelling is recorded with resolved = 0 and counted, the
// same way asset_aliases and mechanic_aliases work, so the owner decides what it is. Guessing
// would quietly merge two real oils: "HD-68 Hy/Oil Caltex" and "HD 68 Oil (Valvoline)" are
// different brands of the same grade and the workshop buys both.

const { get, all, run } = require('../db');

/**
 * Identity of a lubricant name: punctuation and spacing go, everything else stays, so
 * "HD-68", "HD 68" and "HD68" are one name.
 *
 * Brackets are KEPT, unlike the generic itemKey() in stock.js which throws them away. The
 * brand lives in the bracket here — "HD 68 Oil (Valvoline)" and "HD 68 Oil (Servo)" are two
 * different oils the workshop buys separately, and dropping the bracket makes them the same
 * name. It also leaves a bare "HD 68 Oil" resolving to NEITHER, which is the point: nobody
 * knows which brand that receipt was, so it is recorded as unknown for the owner to say.
 */
function normLube(name) {
  return String(name == null ? '' : name)
    .toUpperCase()
    // "(to Ruwan)", "(to Work Shop Stores)" — an issue carries who took it in its own
    // description. That is the recipient, never part of what the thing IS, and leaving it in
    // makes every issue of the same oil a different product.
    .replace(/\(\s*TO\b[^)]*\)/g, ' ')
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * The name as it should READ in a list of products to identify: the recipient annotation an
 * issue carries in its own description is dropped, since "Kerosene Oil (to W/S)" and
 * "Kerosene Oil (to Stores)" are one name to identify, not two.
 */
const displayName = (name) => String(name == null ? '' : name)
  .replace(/\(\s*[Tt][Oo]\b[^)]*\)/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

/** Give every catalogue product an alias to its own name. Idempotent. */
function seedCatalogueAliases() {
  for (const p of all(`SELECT id, name FROM products WHERE name IS NOT NULL AND TRIM(name) <> ''`)) {
    const norm = normLube(p.name);
    if (!norm) continue;
    run(`INSERT INTO lubricant_aliases (raw_text, raw_norm, product_id, effective_from, resolved, source)
         VALUES (?, ?, ?, '', 1, 'catalogue')
         ON CONFLICT(raw_norm, effective_from) DO UPDATE SET
           product_id = COALESCE(lubricant_aliases.product_id, excluded.product_id),
           resolved   = MAX(lubricant_aliases.resolved, excluded.resolved),
           updated_at = datetime('now')`, p.name, norm, p.id);
  }
}

/**
 * Which lubricant is this text? Returns { productId, product, resolved, aliasId }.
 * An unknown name is remembered (resolved = 0) so it can be resolved once, by hand, later —
 * `record: false` looks without writing, for read-only callers and reports.
 */
function resolveLubricant(text, { source = null, record = true, on = null } = {}) {
  const norm = normLube(text);
  if (!norm) return { productId: null, product: null, resolved: false, aliasId: null };

  // A name can mean different products at different times — HD-68 was Caltex and is now
  // Valvoline — so take the latest meaning that had started by the movement's own date.
  // '' sorts before any real date, so that falls out of a plain DESC: the undated row is the
  // fallback and wins only when no dated one applies yet. With no date given, the newest wins,
  // because that is what someone typing the name today means.
  const day = on ? String(on).slice(0, 10) : null;
  const hit = day
    ? get(`SELECT * FROM lubricant_aliases
            WHERE raw_norm = ? AND effective_from <= ?
            ORDER BY effective_from DESC LIMIT 1`, norm, day)
    : get(`SELECT * FROM lubricant_aliases WHERE raw_norm = ?
            ORDER BY effective_from DESC LIMIT 1`, norm);
  if (hit) {
    if (record) run('UPDATE lubricant_aliases SET hit_count = hit_count + 1, updated_at = datetime(\'now\') WHERE id = ?', hit.id);
    return {
      productId: hit.product_id,
      product: hit.product_id ? get('SELECT * FROM products WHERE id = ?', hit.product_id) : null,
      resolved: !!(hit.resolved && hit.product_id),
      aliasId: hit.id,
    };
  }
  if (!record) return { productId: null, product: null, resolved: false, aliasId: null };
  const info = run(`INSERT INTO lubricant_aliases (raw_text, raw_norm, product_id, effective_from, resolved, hit_count, source)
                    VALUES (?, ?, NULL, '', 0, 1, ?)
                    ON CONFLICT(raw_norm, effective_from) DO UPDATE SET hit_count = lubricant_aliases.hit_count + 1`,
  displayName(text), norm, source);
  return { productId: null, product: null, resolved: false, aliasId: info.lastInsertRowid || null };
}

/** Is this a lubricant at all? The one question every section decision should ask. */
const isLubricant = (text, on) => resolveLubricant(text, { record: false, on }).resolved;

/**
 * Split a name in two at a date: what it meant before, and what it means from then on.
 * "HD-68 Oil" was Caltex until the changeover and Valvoline after it.
 */
function splitAliasAt(rawNorm, fromDate, earlierProductId, laterProductId, source) {
  const day = String(fromDate).slice(0, 10);
  const existing = all('SELECT * FROM lubricant_aliases WHERE raw_norm = ?', rawNorm);
  const label = existing.length ? existing[0].raw_text : rawNorm;
  // The undated row becomes the EARLIER meaning; the dated row takes over from `day`.
  const base = existing.find((r) => !r.effective_from);
  if (base) {
    run(`UPDATE lubricant_aliases SET product_id = ?, resolved = ?, source = ?, updated_at = datetime('now') WHERE id = ?`,
      earlierProductId || null, earlierProductId ? 1 : 0, source || base.source, base.id);
  } else {
    run(`INSERT INTO lubricant_aliases (raw_text, raw_norm, product_id, effective_from, resolved, source)
         VALUES (?, ?, ?, '', ?, ?)`, label, rawNorm, earlierProductId || null, earlierProductId ? 1 : 0, source);
  }
  run(`INSERT INTO lubricant_aliases (raw_text, raw_norm, product_id, effective_from, resolved, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(raw_norm, effective_from) DO UPDATE SET
         product_id = excluded.product_id, resolved = excluded.resolved, updated_at = datetime('now')`,
  label, rawNorm, laterProductId || null, day, laterProductId ? 1 : 0, source);
  return all('SELECT * FROM lubricant_aliases WHERE raw_norm = ? ORDER BY effective_from', rawNorm);
}

/** A lubricant by its code — OIL-0007 — for the pickers on requests, receipts and transfers. */
const lubricantByCode = (code) => (code
  ? get('SELECT * FROM products WHERE UPPER(code) = UPPER(?)', String(code).trim()) : null);

/**
 * Say what a remembered spelling is. Three states, and the third one matters:
 *   product given  → it is that lubricant
 *   product null   → DECIDED: not a lubricant at all (a grease gun, an oil seal, a repair note)
 *   reset          → back to unknown, for undoing a mistake
 *
 * "Decided: not a lubricant" has to be distinguishable from "nobody has looked yet", or the
 * nineteen bits of hardware filed under Lubricants & Fluids come back into the queue forever.
 * It is stored as resolved = 1 with no product: a decision has been made, and the answer is no.
 */
function setAlias(aliasId, productId, userName, { reset = false } = {}) {
  const a = get('SELECT * FROM lubricant_aliases WHERE id = ?', aliasId);
  if (!a) return null;
  const decided = reset ? 0 : 1;
  run(`UPDATE lubricant_aliases SET product_id = ?, resolved = ?, source = COALESCE(?, source), updated_at = datetime('now')
        WHERE id = ?`, (reset ? null : productId) || null, decided,
  userName ? (reset ? 'reopened:' : 'resolved:') + userName : null, aliasId);
  return get('SELECT * FROM lubricant_aliases WHERE id = ?', aliasId);
}

/** Spellings nobody has looked at yet, the most-used first. */
const unresolvedAliases = (limit = 200) => all(
  `SELECT * FROM lubricant_aliases WHERE resolved = 0
    ORDER BY hit_count DESC, raw_text LIMIT ?`, limit);

/** Names ruled out — kept visible and reversible, so a wrong call is not a dead end. */
const notLubricantAliases = (limit = 200) => all(
  `SELECT * FROM lubricant_aliases WHERE resolved = 1 AND product_id IS NULL
    ORDER BY hit_count DESC, raw_text LIMIT ?`, limit);

/** The catalogue, with codes — what a picker offers. */
const catalogue = () => all(
  `SELECT p.id, p.code, p.name, p.category, p.unit, p.unit_price
     FROM products p WHERE COALESCE(p.active, 1) = 1 ORDER BY p.code, p.name`);

module.exports = {
  displayName,
  splitAliasAt,
  normLube,
  seedCatalogueAliases,
  resolveLubricant,
  isLubricant,
  lubricantByCode,
  setAlias,
  unresolvedAliases,
  notLubricantAliases,
  catalogue,
};
