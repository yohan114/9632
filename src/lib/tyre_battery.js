'use strict';

// What a tyre is, and what a battery is.
//
// The register kept since 2012 holds 804 different spellings of about 170 real tyre sizes —
// "1000 X 20", "1000X20", "10.00 X 20", "1000 x 20 ORIGIONAL", "1000X20 ORIGINAL CANVES" — and a
// third of tyre issues never reached a price because the spelling on the line matched no price
// row. Batteries are milder but the same shape: "12V - 95 AMP", "95 AMP", "95 Amp".
//
// So a size is read as NUMBERS, and a type and a rating are read from a fixed vocabulary. Anything
// the vocabulary does not know is left as NOT SPECIFIED rather than guessed — the same rule the
// owner's own analysis used, and the same rule the oil book follows for a name it cannot place.
//
// THIS IS A STORED JOIN KEY (tb_specs.spec_key). Changing how it is built silently re-points
// history to different shelves, so improve it as a deliberate migration, never in passing.

const { get, all, run } = require('../db');

// ---- tyre type ------------------------------------------------------------
// The workshop writes the same four ideas a dozen ways. A compound like
// "ORIGINAL - RADIAL" is a real distinction (an original-fit radial) and is kept whole.
const TYPE_WORDS = [
  [/\bORIGIONAL\b|\bORIGINAL\b|\bORIGIOAL\b|\bORIGENAL\b|\bOROGIONAL\b|\bORIGNAL\b|\bORI\b|\bOR\b/g, 'ORIGINAL'],
  [/\bCANVES\b|\bCANVAS\b|\bCANWAS\b|\bCANVUS\b|\bCANAVAS\b/g, 'CANVAS'],
  [/\bRADIAL\b|\bRADIYAL\b|\bRADIEL\b|\bRADIALL\b/g, 'RADIAL'],
  [/\bDAG\b|\bDUG\b/g, 'DAG'],
  [/\bANITE\b|\bANIT\b/g, 'ANITE'],
];
const TYPE_ORDER = ['ORIGINAL', 'CANVAS', 'RADIAL', 'DAG', 'ANITE'];

/** The type words present in a description, in a fixed order so "RADIAL ORIGINAL" == "ORIGINAL - RADIAL". */
function tyreType(text) {
  const s = ' ' + String(text || '').toUpperCase().replace(/[^A-Z0-9.]+/g, ' ') + ' ';
  const found = new Set();
  for (const [re, canon] of TYPE_WORDS) { if (s.match(re)) found.add(canon); }
  const parts = TYPE_ORDER.filter((t) => found.has(t));
  return parts.length ? parts.join(' - ') : 'NOT SPECIFIED';
}

/**
 * The size, as numbers only. "1000 X 20", "1000X20", "10.00-20" and "1000 x 20 R" are one size.
 * The R that marks a radial is NOT part of the size — it is a type word — so 265X65R 16 and
 * 265 X 65 X 16 do not become two different tyres.
 */
function tyreSize(text) {
  // A BRACKET IS A NOTE, NOT A SIZE. The register writes "1000 X 20 (ORIG-04)", "1000 X 20 USE
  // TYRE (43-3416)" — a quantity and a vehicle number. Harvesting every number in the line turned
  // those into the phantom sizes "1000 X 20 X 04" and "1000 X 20 X 43".
  // THE RADIAL R IS NOT PART OF THE SIZE. "275X70R 22.5" and "275 X 70 X 22.5" are one tyre, and
  // leaving the R in place cut the run short and lost the rim diameter altogether. It is dropped
  // here and recorded separately by hasRadialMark(), exactly as the owner's analysis does. Only an
  // R sitting against a digit goes — the R in RADIAL and ORIGINAL must survive for the type.
  const s = String(text || '').toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(\d)\s*R\s*(?=\d)/g, '$1 X ')   // 11R22.5, 195R15 — the ISO form, R between digits
    .replace(/(\d)\s*R\b\s*/g, '$1 X ')       // 275X70R 22.5 — R after the width
    .replace(/\bR\s*(?=\d)/g, ' X ');
  // The size is the LEADING run of numbers joined as a size is written. A third component is real
  // (12.5 X 80 X 18) but only when an explicit separator joins it — a bare trailing number is a
  // quantity, not a rim.
  const m = s.match(/(\d+(?:\.\d+)?)(?:\s*[X/\-]\s*|\s+)(\d+(?:\.\d+)?)(?:\s*[X/\-]\s*(\d+(?:\.\d+)?))?/);
  if (!m) return null;
  const parts = [m[1], m[2]];
  if (m[3]) parts.push(m[3]);
  if (parts.some((p) => !(Number(p) > 0))) return null;
  return parts.join(' X ');
}

/** Does the written form carry the radial R (275X70R 22.5)? Kept separately, as the owner's analysis does. */
const hasRadialMark = (text) => /\d\s*R\b|\bR\s*\d/.test(String(text || '').toUpperCase());

/**
 * A battery is its rating in amps. "12 V / 95 AMP" is 95 Amp, not 12 — the number immediately
 * before AMP wins, which is the rule the owner's analysis used. Where no AMP word appears the
 * largest plausible number is taken, because 12V is a voltage on nearly every battery here.
 */
function batteryRating(text) {
  const s = String(text || '').toUpperCase();
  const before = s.match(/(\d+(?:\.\d+)?)\s*(?:AMP|AH|A\b)/);
  if (before) return trimNum(before[1]) + ' Amp';
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0);
  const plausible = nums.filter((n) => n !== 12 && n !== 24);          // the voltage, not the capacity
  const pick = (plausible.length ? plausible : nums).sort((a, b) => b - a)[0];
  return pick ? trimNum(String(pick)) + ' Amp' : 'NOT SPECIFIED';
}
const trimNum = (n) => String(Number(n)).replace(/\.0+$/, '');

/** The stored join key. Built from the pieces, never from the words as written. */
function specKey(kind, parts) {
  if (kind === 'battery') return String(parts.rating || 'NOT SPECIFIED').toUpperCase().replace(/[^A-Z0-9.]/g, '');
  const size = String(parts.size || 'UNKNOWN').replace(/[^0-9.]/g, 'X').replace(/X+/g, 'X');
  return size + '|' + String(parts.tyre_type || 'NOT SPECIFIED').replace(/[^A-Z]/g, '');
}

/** Read a free-text register line into the pieces a spec is made of. */
function parse(kind, text) {
  if (kind === 'battery') {
    const rating = batteryRating(text);
    return { kind, rating, label: rating, spec_key: specKey('battery', { rating }) };
  }
  const size = tyreSize(text);
  const tyre_type = tyreType(text);
  const label = (size || 'NOT SPECIFIED') + (tyre_type === 'NOT SPECIFIED' ? '' : ' · ' + tyre_type);
  return { kind, size, tyre_type, label, radial: hasRadialMark(text), spec_key: specKey('tyre', { size, tyre_type }) };
}

/** The catalogue row a written line belongs to, or null when the picklist has never seen it. */
function resolve(kind, text) {
  const p = parse(kind, text);
  if (!p.spec_key) return null;
  return get('SELECT * FROM tb_specs WHERE kind = ? AND spec_key = ? AND COALESCE(active,1) = 1', kind, p.spec_key) || null;
}

/** The picklist, commonest first — what the workshop actually fits, not an alphabet. */
function catalogue(kind, q) {
  const like = q ? '%' + String(q).trim().toUpperCase() + '%' : null;
  return all(
    `SELECT s.*,
            (SELECT COUNT(*) FROM tyre_battery_issues i
              WHERE i.kind = s.kind AND i.category_norm IS NOT NULL AND i.spec_id = s.id) AS used
       FROM tb_specs s
      WHERE s.kind = ? AND COALESCE(s.active,1) = 1
        ${like ? 'AND (UPPER(s.label) LIKE ? OR UPPER(s.spec_key) LIKE ?)' : ''}
      ORDER BY used DESC, s.label`,
    ...(like ? [kind, like, like] : [kind]));
}

module.exports = { tyreType, tyreSize, hasRadialMark, batteryRating, specKey, parse, resolve, catalogue };
