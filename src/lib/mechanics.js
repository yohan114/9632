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
// Split a daily-work mechanic cell into individual names. Separators inside brackets do NOT
// split: the office writes group entries like "UTE trainees (Silva, Jayakodi)", and cutting on
// that inner comma invented two mechanics ("UTE trainees (Silva" and "Jayakodi)"), each of whom
// then earned the default rate — so one entry was charged twice over.
function splitMechanics(raw) {
  if (raw == null) return [];
  const out = [];
  let cur = '';
  let depth = 0;
  const s = String(raw);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);

    if (!depth) {
      if (ch === ',' || ch === '&' || ch === '+') { out.push(cur); cur = ''; continue; }
      // " and " as a separator, but not the "and" inside a name
      if ((ch === 'a' || ch === 'A') && /^\s?and\s/i.test(s.slice(i - 1, i + 4)) && /\s$/.test(cur)) {
        out.push(cur); cur = ''; i += 2; continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
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

/** Re-sync job_labour entries from job_daily_work for a given YYYY-MM month. */
function syncJobLabourForMonth(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return;
  run(`DELETE FROM job_labour WHERE substr(work_date,1,7) = ?`, ym);
  const dwRows = all(`
    SELECT w.id, w.job_id, w.work_date, w.mechanic, w.hours, w.is_external
      FROM job_daily_work w
     WHERE substr(w.work_date,1,7) = ? AND (w.is_external IS NULL OR w.is_external = 0)
  `, ym);

  for (const w of dwRows) {
    const hrs = Number(w.hours) || 0;
    if (!hrs) continue;
    const names = splitMechanics(w.mechanic);
    if (!names.length) continue;

    for (const rawName of names) {
      const canonical = resolveMechanicName(rawName);
      // The rate that applied ON THE DAY, not the newest one on file. Without the date bound a
      // rebuild silently re-prices history: a rise recorded in August was being applied back
      // through every earlier month, inflating labour that was already reported.
      const r = get(
        `SELECT rate FROM labour_rates WHERE mechanic = ? AND effective_from <= ?
          ORDER BY effective_from DESC, id DESC LIMIT 1`, canonical, w.work_date);
      const rate = r ? r.rate : 250;
      const amt = hrs * rate;

      run(`
        INSERT INTO job_labour (job_id, work_date, mechanic, hours, rate, amount)
        VALUES (?, ?, ?, ?, ?, ?)
      `, w.job_id, w.work_date, canonical, hrs, rate, amt);
    }
  }
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
  syncJobLabourForMonth,
};
