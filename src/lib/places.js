'use strict';

// ===========================================================================
// Places (multi-site Stage 2) — where goods move to and from on a transfer note (MTN).
//
// A place is a workshop ('w:<id>'), a project ('p:<id>') or one of a project's sites ('s:<id>').
// A note's two ends were only ever free text, and the same place is written many ways ("Work Shop
// Stores", "Work SHop", "Main Store"; "CEP-03", "CEP-03 Wadakada Machanic"). Each end now ALSO
// points at a place from the list; the text stays exactly as written, and an end that is a
// machine (HEX-19) or somewhere not on the list stays text only.
//
// Matching is deliberately cautious: a name links only when exactly one place fits. A wrong
// link is worse than none — it would put one project's goods in another's history.
// ===========================================================================

const { get, all } = require('../db');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Words that describe a place rather than name it: "Marawila SITE", "Iginimitiya PROJECT".
const TAIL = /(PROJECT|PROJ|SITE|YARD|CAMP|MECHANIC|MACHANIC|STORES?)+$/;
const strip = (n) => { const s = n.replace(TAIL, ''); return s.length >= 4 ? s : n; };
// What the workshop's own store has been called on paper. Only the DEFAULT workshop answers to
// these: it is the one that has always been "the workshop".
const DEFAULT_WORKSHOP_NAMES = ['WORKSHOP', 'WORKSHOPSTORE', 'WORKSHOPSTORES', 'MAINSTORE', 'MAINSTORES', 'CENTRALWORKSHOP', 'CENTRALSTORES'];

/** Every place still in use, for the pick-list. */
function list() {
  const out = [];
  for (const w of all('SELECT id, name, code FROM workshops WHERE active = 1 ORDER BY is_default DESC, name')) {
    out.push({ key: `w:${w.id}`, kind: 'workshop', label: w.name });
  }
  for (const p of all('SELECT id, name, code FROM projects WHERE COALESCE(active, 1) = 1 ORDER BY name')) {
    out.push({ key: `p:${p.id}`, kind: 'project', label: p.name });
  }
  for (const s of all(`SELECT s.id, s.name, p.name AS project FROM sites s LEFT JOIN projects p ON p.id = s.project_id
                        WHERE COALESCE(p.active, 1) = 1 ORDER BY p.name, s.name`)) {
    out.push({ key: `s:${s.id}`, kind: 'site', label: s.project ? `${s.name} (${s.project})` : s.name });
  }
  return out;
}

/** The place a key names, or null if it names nothing (or nothing that still exists). */
function byKey(key) {
  const m = /^([wps]):(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  const id = Number(m[2]);
  if (m[1] === 'w') { const w = get('SELECT id, name FROM workshops WHERE id = ?', id); return w && { key, kind: 'workshop', label: w.name }; }
  if (m[1] === 'p') { const p = get('SELECT id, name FROM projects WHERE id = ?', id); return p && { key, kind: 'project', label: p.name }; }
  const s = get('SELECT s.id, s.name, p.name AS project FROM sites s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?', id);
  return s && { key, kind: 'site', label: s.project ? `${s.name} (${s.project})` : s.name };
}

/** Each place with the names it answers to. Built per call: the lists are short. */
function candidates() {
  const out = [];
  for (const w of all('SELECT id, name, code, place, is_default FROM workshops')) {
    const names = [norm(w.name), norm(w.code), norm(w.place)].filter((n) => n.length >= 2);
    if (w.is_default) names.push(...DEFAULT_WORKSHOP_NAMES);
    out.push({ key: `w:${w.id}`, names, prefixes: [] });
  }
  for (const p of all('SELECT id, name, code, name_norm FROM projects')) {
    const full = norm(p.name);
    const names = [full, strip(full), norm(p.code)].filter((n) => n.length >= 4);
    // "CEP-03 Wadakada Machanic" is CEP-03's own mechanic: a name that STARTS with the project's.
    out.push({ key: `p:${p.id}`, names, prefixes: names.filter((n) => n.length >= 5) });
  }
  for (const s of all('SELECT id, name FROM sites')) {
    const n = norm(s.name);
    if (n.length >= 4) out.push({ key: `s:${s.id}`, names: [n, strip(n)], prefixes: [] });
  }
  return out;
}

/**
 * The place a piece of text names, or null. Exact names first; failing those, the text may start
 * with a project's name ("CEP-03 Wadakada…") or be the start of one ("Marawila Site" for
 * "Marawila Road Project"). In every case exactly one place must fit.
 */
function resolve(text, cands = candidates()) {
  const n = norm(text);
  if (n.length < 4 && !DEFAULT_WORKSHOP_NAMES.includes(n)) return null;
  const s = strip(n);
  const one = (hits) => { const keys = [...new Set(hits.map((c) => c.key))]; return keys.length === 1 ? keys[0] : null; };
  const exact = cands.filter((c) => c.names.includes(n) || c.names.includes(s));
  if (exact.length) return one(exact);
  const loose = cands.filter((c) => c.prefixes.some((p) => n.startsWith(p))
    || (s.length >= 6 && c.key.startsWith('p:') && c.names.some((nm) => nm.startsWith(s))));
  return one(loose);
}

/**
 * The place for one end of a note: the key the person picked (it must exist), else what the text
 * names. `given` undefined means "not sent" — then only the text decides.
 */
function forEnd(given, text) {
  if (given !== undefined && given !== null && String(given).trim() !== '') {
    const p = byKey(given);
    if (!p) { const e = new Error('That place is not on the list'); e.status = 400; throw e; }
    return p.key;
  }
  return resolve(text);
}

/**
 * Link the transfer notes already written to the places their text names — once, at the first
 * start after the update (src/db/index.js). Only ends with no place yet are touched, and the text
 * is never changed. Returns how many ends were linked and how many were left as text.
 */
function matchOldTransfers() {
  const { run } = require('../db');
  const cands = candidates();
  let linked = 0; let left = 0;
  for (const table of ['mtn', 'mtn_lines']) {
    for (const r of all(`SELECT id, from_location, to_location, from_place, to_place FROM ${table}
                          WHERE (from_place IS NULL AND TRIM(COALESCE(from_location, '')) <> '')
                             OR (to_place IS NULL AND TRIM(COALESCE(to_location, '')) <> '')`)) {
      for (const side of ['from', 'to']) {
        if (r[`${side}_place`] || !String(r[`${side}_location`] || '').trim()) continue;
        const key = resolve(r[`${side}_location`], cands);
        if (key) { run(`UPDATE ${table} SET ${side}_place = ? WHERE id = ?`, key, r.id); linked++; } else left++;
      }
    }
  }
  return { linked, left };
}

module.exports = { list, byKey, resolve, forEnd, candidates, matchOldTransfers, norm };
