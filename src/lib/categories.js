'use strict';

// ===========================================================================
// Item category tree — Category → Sub-category (exactly two levels).
//
// The single place that turns a category_id into the (leaf id, parent label) pair
// every write path stores. Two rules hold everywhere:
//
//   * a record is always linked to a LEAF (a sub-category), never to a parent —
//     passing a parent id resolves to that parent's "General" bucket;
//   * the free-text `category` column is written in step with category_id and always
//     holds the PARENT name. Every existing report groups by that text, so it stays
//     the stable reporting key while category_id carries the finer detail.
//
// Legacy text-only writes still get a category_id: the label is matched against the
// tree (including the old 9-value vocabulary) and lands in that parent's General.
// ===========================================================================

const { get, all, run, tx } = require('../db');

const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const GENERAL = 'General';

// The old 9-value vocabulary (mrn_lines / issues / mtn used it before the tree) folded
// into the canonical parents, so a legacy label still resolves to the right category.
const ALIASES = {
  'BELTS': 'Belts & Hoses',
  'TYRE': 'Tyres & Wheels',
  'TYRES': 'Tyres & Wheels',
  'OIL LUBRICANTS': 'Lubricants & Fluids',
  'OIL AND LUBRICANTS': 'Lubricants & Fluids',
  'LUBRICANTS': 'Lubricants & Fluids',
  'BATTERIES': 'Battery',
  'HARDWARE': 'Hardware & Fasteners',
  'UNCATEGORISED': 'Other',
  'UNCATEGORIZED': 'Other',
};

const isParent = (row) => !!row && row.parent_id == null;

/** Every category row, parents first, then children in display order. */
function rows() {
  return all(`SELECT id, parent_id, name, name_norm, code, sort_order, active
                FROM item_categories ORDER BY (parent_id IS NOT NULL), sort_order, name`);
}

/** Usage counts per leaf across every table that carries a category. */
function counts() {
  const out = new Map();
  const bump = (id, key, n) => {
    if (id == null) return;
    const e = out.get(id) || { items: 0, mrn_lines: 0, issues: 0, transfers: 0 };
    e[key] += n;
    out.set(id, e);
  };
  const tables = [['store_items', 'items'], ['mrn_lines', 'mrn_lines'], ['issues', 'issues'], ['mtn', 'transfers']];
  for (const [table, key] of tables) {
    for (const r of all(`SELECT category_id id, COUNT(*) n FROM ${table} WHERE category_id IS NOT NULL GROUP BY 1`)) {
      bump(r.id, key, r.n);
    }
  }
  return out;
}

/**
 * The full tree: parents, each with its `subs` and both own + rolled-up counts.
 * @param {{activeOnly?: boolean}} opts
 */
function tree(opts = {}) {
  const all_ = rows().filter((r) => (opts.activeOnly ? r.active : true));
  const use = counts();
  const zero = () => ({ items: 0, mrn_lines: 0, issues: 0, transfers: 0 });
  const add = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k]; return a; };

  const parents = new Map();
  for (const r of all_) {
    if (r.parent_id == null) parents.set(r.id, { ...r, subs: [], counts: zero() });
  }
  for (const r of all_) {
    if (r.parent_id == null) continue;
    const p = parents.get(r.parent_id);
    if (!p) continue; // orphan (parent deactivated + activeOnly)
    const c = use.get(r.id) || zero();
    p.subs.push({ ...r, counts: c });
    add(p.counts, c);
  }
  return [...parents.values()];
}

/** Flat list for pickers: [{id, name, parent_id, parent_name, path}] of LEAVES only. */
function leaves() {
  const out = [];
  for (const p of tree({ activeOnly: true })) {
    for (const s of p.subs) out.push({ id: s.id, name: s.name, parent_id: p.id, parent_name: p.name, path: `${p.name} › ${s.name}` });
  }
  return out;
}

/** The parent's General bucket, created on demand so a parent always has a home. */
function ensureGeneral(parentId) {
  const found = get('SELECT id FROM item_categories WHERE parent_id = ? AND name_norm = ?', parentId, norm(GENERAL));
  if (found) return found.id;
  const order = get('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM item_categories WHERE parent_id = ?', parentId).n;
  return run('INSERT INTO item_categories (parent_id, name, name_norm, sort_order) VALUES (?, ?, ?, ?)',
    parentId, GENERAL, norm(GENERAL), order).lastInsertRowid;
}

/**
 * Resolve any category id to the LEAF it should be stored against.
 * A parent id resolves to its General bucket; an unknown id yields null.
 */
function leafId(id) {
  if (!id) return null;
  const row = get('SELECT id, parent_id FROM item_categories WHERE id = ?', id);
  if (!row) return null;
  return isParent(row) ? ensureGeneral(row.id) : row.id;
}

/** The PARENT name for a leaf — what goes in the free-text `category` column. */
function labelFor(leaf) {
  if (!leaf) return null;
  const row = get(
    `SELECT COALESCE(p.name, c.name) label FROM item_categories c
       LEFT JOIN item_categories p ON p.id = c.parent_id WHERE c.id = ?`, leaf);
  return row ? row.label : null;
}

/** Match a free-text label (incl. the legacy 9-value vocabulary) to a parent row. */
function parentByLabel(text) {
  const n = norm(text);
  if (!n) return null;
  const direct = get('SELECT id, name FROM item_categories WHERE parent_id IS NULL AND name_norm = ?', n);
  if (direct) return direct;
  const aliased = ALIASES[n];
  if (aliased) return get('SELECT id, name FROM item_categories WHERE parent_id IS NULL AND name_norm = ?', norm(aliased));
  return null;
}

/**
 * Turn a request body into the pair every write path stores.
 * Accepts `category_id` (preferred) or a free-text `category` (legacy clients).
 * @returns {{category_id: number|null, category: string|null}}
 */
function resolve(body = {}) {
  if (body.category_id) {
    const leaf = leafId(parseInt(body.category_id, 10));
    if (leaf) return { category_id: leaf, category: labelFor(leaf) };
  }
  if (body.category) {
    const parent = parentByLabel(body.category);
    if (parent) { const leaf = ensureGeneral(parent.id); return { category_id: leaf, category: parent.name }; }
    return { category_id: null, category: String(body.category) }; // unknown label — keep it verbatim
  }
  return { category_id: null, category: null };
}

// ---- mutations -------------------------------------------------------------

function create({ parent_id, name, code, sort_order }) {
  const nm = String(name || '').trim();
  if (!nm) { const e = new Error('A name is required'); e.status = 400; throw e; }
  let parentId = null;
  if (parent_id) {
    const p = get('SELECT id, parent_id FROM item_categories WHERE id = ?', parent_id);
    if (!p) { const e = new Error('Unknown parent category'); e.status = 400; throw e; }
    if (!isParent(p)) { const e = new Error('The tree is two levels — a sub-category cannot have children'); e.status = 400; throw e; }
    parentId = p.id;
  }
  const dupe = parentId
    ? get('SELECT id FROM item_categories WHERE parent_id = ? AND name_norm = ?', parentId, norm(nm))
    : get('SELECT id FROM item_categories WHERE parent_id IS NULL AND name_norm = ?', norm(nm));
  if (dupe) { const e = new Error(`"${nm}" already exists here`); e.status = 409; throw e; }
  const order = sort_order != null ? parseInt(sort_order, 10) : (parentId
    ? get('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM item_categories WHERE parent_id = ?', parentId).n
    : get('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM item_categories WHERE parent_id IS NULL').n);
  const id = run('INSERT INTO item_categories (parent_id, name, name_norm, code, sort_order) VALUES (?, ?, ?, ?, ?)',
    parentId, nm, norm(nm), code ? String(code).toUpperCase().slice(0, 4) : null, order).lastInsertRowid;
  // A brand-new parent needs its fallback bucket immediately.
  if (!parentId) ensureGeneral(id);
  return get('SELECT * FROM item_categories WHERE id = ?', id);
}

function update(id, patch = {}) {
  const row = get('SELECT * FROM item_categories WHERE id = ?', id);
  if (!row) { const e = new Error('Category not found'); e.status = 404; throw e; }
  const sets = [];
  const params = [];
  if (patch.name !== undefined) {
    const nm = String(patch.name).trim();
    if (!nm) { const e = new Error('A name is required'); e.status = 400; throw e; }
    const dupe = row.parent_id
      ? get('SELECT id FROM item_categories WHERE parent_id = ? AND name_norm = ? AND id <> ?', row.parent_id, norm(nm), id)
      : get('SELECT id FROM item_categories WHERE parent_id IS NULL AND name_norm = ? AND id <> ?', norm(nm), id);
    if (dupe) { const e = new Error(`"${nm}" already exists here`); e.status = 409; throw e; }
    sets.push('name = ?', 'name_norm = ?');
    params.push(nm, norm(nm));
  }
  if (patch.parent_id !== undefined && row.parent_id != null) {
    // Move a sub-category under a different parent.
    const p = get('SELECT id, parent_id FROM item_categories WHERE id = ?', patch.parent_id);
    if (!p || !isParent(p)) { const e = new Error('Move target must be a top-level category'); e.status = 400; throw e; }
    if (get('SELECT id FROM item_categories WHERE parent_id = ? AND name_norm = ? AND id <> ?', p.id, row.name_norm, id)) {
      const e = new Error(`"${row.name}" already exists under that category — merge instead`); e.status = 409; throw e;
    }
    sets.push('parent_id = ?');
    params.push(p.id);
  }
  if (patch.code !== undefined) { sets.push('code = ?'); params.push(patch.code ? String(patch.code).toUpperCase().slice(0, 4) : null); }
  if (patch.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(parseInt(patch.sort_order, 10) || 0); }
  if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active ? 1 : 0); }
  if (!sets.length) return row;
  sets.push("updated_at = datetime('now')");

  return tx(() => {
    run(`UPDATE item_categories SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    // A rename/move changes the parent label stored on every affected record.
    if (patch.name !== undefined || patch.parent_id !== undefined) relabel(id);
    return get('SELECT * FROM item_categories WHERE id = ?', id);
  });
}

/** Rewrite the denormalised `category` text for every record under a category. */
function relabel(id) {
  const row = get('SELECT id, parent_id FROM item_categories WHERE id = ?', id);
  if (!row) return 0;
  const leafIds = isParent(row)
    ? all('SELECT id FROM item_categories WHERE parent_id = ?', id).map((r) => r.id)
    : [id];
  let n = 0;
  for (const leaf of leafIds) {
    const label = labelFor(leaf);
    for (const table of ['store_items', 'mrn_lines', 'issues', 'mtn']) {
      n += run(`UPDATE ${table} SET category = ? WHERE category_id = ?`, label, leaf).changes;
    }
  }
  return n;
}

/** Usage across every table for one category (a parent counts its children too). */
function usage(id) {
  const row = get('SELECT id, parent_id FROM item_categories WHERE id = ?', id);
  if (!row) return null;
  const ids = isParent(row)
    ? [id, ...all('SELECT id FROM item_categories WHERE parent_id = ?', id).map((r) => r.id)]
    : [id];
  const marks = ids.map(() => '?').join(',');
  const out = { items: 0, mrn_lines: 0, issues: 0, transfers: 0, children: 0 };
  const map = { store_items: 'items', mrn_lines: 'mrn_lines', issues: 'issues', mtn: 'transfers' };
  for (const [table, key] of Object.entries(map)) {
    out[key] = get(`SELECT COUNT(*) c FROM ${table} WHERE category_id IN (${marks})`, ...ids).c;
  }
  out.children = isParent(row) ? get('SELECT COUNT(*) c FROM item_categories WHERE parent_id = ?', id).c : 0;
  out.total = out.items + out.mrn_lines + out.issues + out.transfers;
  return out;
}

/**
 * Move every record (and, for a parent, every child) into `intoId`, then delete the
 * source. This is how the imported free-text mess gets cleaned up.
 */
function merge(fromId, intoId) {
  const from = get('SELECT * FROM item_categories WHERE id = ?', fromId);
  const into = get('SELECT * FROM item_categories WHERE id = ?', intoId);
  if (!from || !into) { const e = new Error('Category not found'); e.status = 404; throw e; }
  if (from.id === into.id) { const e = new Error('Pick a different target'); e.status = 400; throw e; }
  if (isParent(from) !== isParent(into)) {
    const e = new Error('Merge a category into a category, or a sub-category into a sub-category'); e.status = 400; throw e;
  }
  const moved = { records: 0, children: 0 };
  tx(() => {
    if (isParent(from)) {
      // Fold each child into the target's same-named child, else re-parent it.
      for (const child of all('SELECT * FROM item_categories WHERE parent_id = ?', from.id)) {
        const twin = get('SELECT id FROM item_categories WHERE parent_id = ? AND name_norm = ?', into.id, child.name_norm);
        if (twin) { moved.records += moveRecords(child.id, twin.id); run('DELETE FROM item_categories WHERE id = ?', child.id); }
        else { run('UPDATE item_categories SET parent_id = ? WHERE id = ?', into.id, child.id); relabel(child.id); }
        moved.children++;
      }
      moved.records += moveRecords(from.id, ensureGeneral(into.id));
    } else {
      moved.records += moveRecords(from.id, into.id);
    }
    run('DELETE FROM item_categories WHERE id = ?', from.id);
  });
  return moved;
}

function moveRecords(fromLeaf, toLeaf) {
  const label = labelFor(toLeaf);
  let n = 0;
  for (const table of ['store_items', 'mrn_lines', 'issues', 'mtn']) {
    n += run(`UPDATE ${table} SET category_id = ?, category = ? WHERE category_id = ?`, toLeaf, label, fromLeaf).changes;
  }
  return n;
}

function remove(id) {
  const row = get('SELECT * FROM item_categories WHERE id = ?', id);
  if (!row) { const e = new Error('Category not found'); e.status = 404; throw e; }
  const u = usage(id);
  if (u.total || u.children) {
    const e = new Error(`In use — ${u.total} record(s)${u.children ? ` and ${u.children} sub-categor${u.children === 1 ? 'y' : 'ies'}` : ''}. Merge it into another category instead.`);
    e.status = 409;
    throw e;
  }
  run('DELETE FROM item_categories WHERE id = ?', id);
  return { deleted: id };
}

module.exports = {
  norm, ALIASES, tree, leaves, counts, leafId, labelFor, parentByLabel, resolve,
  create, update, remove, merge, usage, relabel, ensureGeneral,
};
