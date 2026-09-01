'use strict';

// Phase — Service form reference lists. Loads the fixed oil list (19), filter
// category list (18) and oil-type price reference (8) from the Service Record
// export so the New Service form's grid matches the paper form exactly.
// Idempotent: each table is filled only when empty.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { get, run, tx } = require('../db');
const config = require('../config');

const clean = (v) => (v == null ? null : String(v).trim() || null);

function runStep() {
  const rep = { no_file: false, oils: 0, categories: 0, oil_types: 0 };
  const src = path.join(config.root, 'sources/service/service.db');
  if (!fs.existsSync(src)) { rep.no_file = true; return rep; }
  const sdb = new Database(src, { readonly: true });
  try {
    tx(() => {
      if (get('SELECT COUNT(*) c FROM oil_list').c === 0) {
        for (const r of sdb.prepare('SELECT Name, Unit, SortOrder FROM OilList WHERE Active = 1 ORDER BY SortOrder, OilID').all()) {
          run('INSERT INTO oil_list (name, unit, sort_order) VALUES (?, ?, ?)', clean(r.Name), clean(r.Unit) || 'L', r.SortOrder || 0);
          rep.oils++;
        }
      }
      if (get('SELECT COUNT(*) c FROM filter_category_list').c === 0) {
        for (const r of sdb.prepare('SELECT Name, SortOrder FROM FilterCategoryList WHERE Active = 1 ORDER BY SortOrder, CategoryID').all()) {
          run('INSERT INTO filter_category_list (name, sort_order) VALUES (?, ?)', clean(r.Name), r.SortOrder || 0);
          rep.categories++;
        }
      }
      if (get('SELECT COUNT(*) c FROM oil_type_prices').c === 0) {
        for (const r of sdb.prepare('SELECT OilTypeCode, UnitPriceLKR FROM OilPrices WHERE OilTypeCode IS NOT NULL ORDER BY PriceID').all()) {
          run('INSERT INTO oil_type_prices (code, unit_price) VALUES (?, ?)', clean(r.OilTypeCode), r.UnitPriceLKR || 0);
          rep.oil_types++;
        }
      }
    });
  } finally { sdb.close(); }
  return rep;
}

module.exports = { runStep };
