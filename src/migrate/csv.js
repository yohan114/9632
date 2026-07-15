'use strict';

// CSV loading for the source dataset under sources/. Robust to quoted fields
// with embedded commas/newlines. Everything is UTF-8.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'sources');

function parseCSV(text) {
  const rows = [];
  let field = '', row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Load a source CSV as an array of row objects keyed by header. Drops all-empty rows. */
function load(rel) {
  const rows = parseCSV(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
}

const clean = (s) => String(s == null ? '' : s).trim();

module.exports = { parseCSV, load, clean, SRC };
