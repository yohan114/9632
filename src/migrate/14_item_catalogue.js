'use strict';

// Phase — Consolidated item catalogue. Takes the deduped item list built from all
// mrn_lines descriptions (sources/stores/item_catalogue.csv: synonym/spelling variants
// merged, part numbers unioned, classified part/consumable/service, category-prefixed
// item numbers like FIL-0001) and stores each as a store_items row with its item_no.
//
// Upsert strategy (idempotent):
//   1. row already carries this item_no  -> update in place (re-run).
//   2. an existing store_item matches the canonical name (and has no item_no yet)
//      -> adopt it: stamp the item_no + catalogue fields (avoids a duplicate).
//   3. otherwise                          -> insert a new catalogue row.

const { get, all, run, tx } = require('../db');
const { load, clean } = require('./csv');

const nameNorm = (s) => clean(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function runStep() {
  const rep = { rows: 0, created: 0, adopted: 0, updated: 0, by_kind: { part: 0, consumable: 0, service: 0 } };

  const rows = load('stores/item_catalogue.csv');

  // Existing rows: index by item_no (re-run) and by normalized name (adopt-once).
  const byItemNo = new Map();
  const byName = new Map(); // name_norm -> [ids without an item_no]
  for (const s of all('SELECT id, name, item_no FROM store_items')) {
    if (s.item_no) byItemNo.set(s.item_no, s.id);
    else { const k = nameNorm(s.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(s.id); }
  }

  tx(() => {
    for (const r of rows) {
      const item_no = clean(r.item_no);
      const name = clean(r.item_name);
      if (!item_no || !name) continue;
      rep.rows++;

      const kind = clean(r.kind) || 'part';
      // Services are labour lines, not stocked parts — drop the (often junk: dates)
      // codes the extractor picked up so the catalogue's part numbers stay meaningful.
      const pns = kind === 'service' ? '' : clean(r.part_numbers);
      const firstPn = pns ? pns.split('|')[0].trim() : null;
      const category = clean(r.category) || null;
      const reqCount = parseInt(clean(r.requests), 10) || 0;
      const isGeneral = kind === 'consumable' ? 1 : 0;
      if (rep.by_kind[kind] != null) rep.by_kind[kind]++;

      const fields = [name, firstPn, category, kind, pns || null, reqCount, isGeneral];

      let id = byItemNo.get(item_no);
      if (id) {
        run(`UPDATE store_items SET name=?, part_number=?, category=?, catalogue_kind=?, part_numbers=?, req_count=?, is_general=?, item_no=? WHERE id=?`,
          ...fields, item_no, id);
        rep.updated++;
        continue;
      }

      const k = nameNorm(name);
      const pool = byName.get(k);
      if (pool && pool.length) {
        id = pool.shift(); // adopt one existing same-name row
        run(`UPDATE store_items SET name=?, part_number=?, category=?, catalogue_kind=?, part_numbers=?, req_count=?, is_general=?, item_no=? WHERE id=?`,
          ...fields, item_no, id);
        rep.adopted++;
      } else {
        run(`INSERT INTO store_items (name, part_number, category, catalogue_kind, part_numbers, req_count, is_general, item_no, unit, balance)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'nos', 0)`, ...fields, item_no);
        rep.created++;
      }
      byItemNo.set(item_no, get('SELECT id FROM store_items WHERE item_no = ?', item_no).id);
    }
  });

  rep.total_catalogue = get('SELECT COUNT(*) c FROM store_items WHERE item_no IS NOT NULL').c;
  return rep;
}

module.exports = { runStep };
