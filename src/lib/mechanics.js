'use strict';

// ===========================================================================
// Mechanic-name resolver — mirrors the asset alias resolver, for labour rates.
// The source daily-work data spells one person several ways; this maps any raw
// spelling to one canonical mechanic so `labour_rates` cost correctly.
//
// It also splits a single daily-work entry that lists several mechanics
// ("Buddhika, Krishna", "Amal & Nuwan") into individual names — WITHOUT
// breaking a slash-joined alias spelling ("Seethananda/seetha" is ONE person).
// ===========================================================================

const { get, all, run } = require('../db');

/** Uppercase, keep only A-Z / 0-9. "Vinod M" -> "VINODM". */
function normalizeMechanic(name) {
  if (name == null) return '';
  return String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Split a daily-work "mechanic" cell into individual mechanics.
 * Separators: comma, ampersand, plus, and the word "and". NOT the slash — a
 * slash joins two spellings of the SAME person (kept intact, resolver handles).
 */
function splitMechanics(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(/\s*(?:,|&|\+|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read-only lookup — never writes. Returns {mechanicId, name, resolved} or unresolved. */
function lookupMechanic(raw) {
  const norm = normalizeMechanic(raw);
  if (!norm) return { mechanicId: null, name: raw, resolved: false, via: 'empty' };
  const m = get('SELECT id, name FROM mechanics WHERE name_norm = ?', norm);
  if (m) return { mechanicId: m.id, name: m.name, resolved: true, via: 'canonical' };
  const a = get(
    `SELECT ma.id, ma.mechanic_id, m.name FROM mechanic_aliases ma
       LEFT JOIN mechanics m ON m.id = ma.mechanic_id
      WHERE ma.raw_norm = ? AND ma.resolved = 1 AND ma.mechanic_id IS NOT NULL`,
    norm
  );
  if (a) return { mechanicId: a.mechanic_id, name: a.name, resolved: true, via: 'alias' };
  return { mechanicId: null, name: raw, resolved: false, via: 'pending' };
}

/** Read-only canonical name for costing/reporting (returns raw when unresolved). */
function resolveMechanicName(raw) {
  const r = lookupMechanic(raw);
  return r.resolved ? r.name : raw;
}

function bumpAlias(rawNorm, rawText, mechanicId, resolved, source) {
  const existing = get('SELECT id FROM mechanic_aliases WHERE raw_norm = ?', rawNorm);
  if (existing) {
    run(
      `UPDATE mechanic_aliases SET hit_count = hit_count + 1,
         mechanic_id = COALESCE(?, mechanic_id), resolved = MAX(resolved, ?), updated_at = datetime('now')
       WHERE id = ?`,
      mechanicId, resolved ? 1 : 0, existing.id
    );
    return existing.id;
  }
  return run(
    `INSERT INTO mechanic_aliases (raw_text, raw_norm, mechanic_id, resolved, hit_count, source)
     VALUES (?, ?, ?, ?, 1, ?)`,
    rawText, rawNorm, mechanicId || null, resolved ? 1 : 0, source || null
  ).lastInsertRowid;
}

/**
 * Resolve a raw mechanic name, learning as it goes. When it can't resolve and
 * `register` is set, it queues a PENDING alias for a human to link — never lost.
 * @returns {{mechanicId, name, resolved, aliasId, via}}
 */
function resolveMechanic(raw, opts = {}) {
  const register = opts.register !== false;
  const found = lookupMechanic(raw);
  const norm = normalizeMechanic(raw);
  if (!norm) return { ...found, aliasId: null };
  if (found.resolved) {
    const aliasId = register ? bumpAlias(norm, raw, found.mechanicId, true, opts.source) : null;
    return { ...found, aliasId };
  }
  const aliasId = register ? bumpAlias(norm, raw, null, false, opts.source) : null;
  return { mechanicId: null, name: raw, resolved: false, aliasId, via: 'pending' };
}

/** Find-or-create a canonical mechanic (used by seed/migration). */
function findOrCreateMechanic(name) {
  const norm = normalizeMechanic(name);
  let m = get('SELECT * FROM mechanics WHERE name_norm = ?', norm);
  if (m) return m;
  const id = run('INSERT INTO mechanics (name, name_norm) VALUES (?, ?)', name, norm).lastInsertRowid;
  return get('SELECT * FROM mechanics WHERE id = ?', id);
}

function linkMechanicAlias(aliasId, mechanicId) {
  run(
    `UPDATE mechanic_aliases SET mechanic_id = ?, resolved = 1, hit_count = hit_count + 1, updated_at = datetime('now') WHERE id = ?`,
    mechanicId, aliasId
  );
  return get('SELECT * FROM mechanic_aliases WHERE id = ?', aliasId);
}

function pendingMechanicAliases() {
  return all('SELECT * FROM mechanic_aliases WHERE resolved = 0 ORDER BY hit_count DESC, updated_at DESC');
}

module.exports = {
  normalizeMechanic,
  splitMechanics,
  lookupMechanic,
  resolveMechanicName,
  resolveMechanic,
  findOrCreateMechanic,
  linkMechanicAlias,
  pendingMechanicAliases,
};
