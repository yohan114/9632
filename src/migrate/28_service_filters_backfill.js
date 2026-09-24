'use strict';

// Backfill service-filter lines that the original import dropped.
//
// 21_service_filters skipped any ServiceFilters row with a BLANK filter number
// (`if (!fn) continue`). That is how the workshop logs a filter it CLEANED rather than
// replaced — "Air Filter Inner, action E, no part number, price 0" — so those services
// came through with their air-filter work missing from the record.
//
// The lines carry no price and cannot join the price book (that join is on
// filter_no_norm), so nothing about any cost changes: this only restores the history.
//
// Idempotent by multiset: for each service, each distinct line shape is counted in the
// source and in the live table, and only the shortfall is inserted. Re-running inserts
// nothing, and a line legitimately recorded twice on one service stays twice.
//
// Run:  node src/migrate/run.js --step service-filters-backfill          (dry run)
//       node src/migrate/run.js --step service-filters-backfill --apply

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { get, all, run, tx } = require('../db');

const SOURCE = path.join(__dirname, '..', '..', 'sources', 'service', 'service.db');
const clean = (v) => (v == null ? null : String(v).trim() || null);
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');

// One line's identity: everything that distinguishes it on a service.
const shapeOf = (filterNo, category, action, qty, price) =>
  [normF(filterNo || ''), (category || '').toLowerCase().trim(), (action || '').toLowerCase().trim(),
    Number(qty) || 1, Math.round((Number(price) || 0) * 100)].join('|');

function runStep(opts = {}) {
  const apply = !!opts.apply;
  const rep = { apply, source: SOURCE, no_file: false, services_checked: 0, services_short: 0, inserted: 0, lines: [] };
  if (!fs.existsSync(SOURCE)) { rep.no_file = true; return rep; }

  const sdb = new Database(SOURCE, { readonly: true });
  try {
    const srcByService = new Map();
    for (const f of sdb.prepare('SELECT * FROM ServiceFilters ORDER BY ServiceFilterID').all()) {
      if (!srcByService.has(f.ServiceID)) srcByService.set(f.ServiceID, []);
      srcByService.get(f.ServiceID).push(f);
    }

    const pending = [];
    for (const s of all('SELECT id, legacy_service_id, service_date, job_no, vehicle_label FROM service_jobs WHERE legacy_service_id IS NOT NULL')) {
      const srcRows = srcByService.get(s.legacy_service_id);
      if (!srcRows || !srcRows.length) continue;
      rep.services_checked++;

      const liveCount = new Map();
      for (const l of all('SELECT filter_no, category, action_type, qty, price FROM service_filters WHERE service_id = ?', s.id)) {
        const k = shapeOf(l.filter_no, l.category, l.action_type, l.qty, l.price);
        liveCount.set(k, (liveCount.get(k) || 0) + 1);
      }
      let short = false;
      for (const f of srcRows) {
        const k = shapeOf(f.FilterNo, f.FilterCategory, f.ActionType, f.Quantity, f.Price);
        const have = liveCount.get(k) || 0;
        if (have > 0) { liveCount.set(k, have - 1); continue; } // already present — consume it
        short = true;
        const fn = clean(f.FilterNo);
        pending.push({
          service_id: s.id, legacy_service_id: s.legacy_service_id, service_date: s.service_date,
          job_no: s.job_no, vehicle: s.vehicle_label,
          filter_no: fn, filter_no_norm: fn ? normF(fn) : null,
          category: clean(f.FilterCategory), action_type: clean(f.ActionType),
          qty: f.Quantity || 1, price: f.Price || 0,
        });
      }
      if (short) rep.services_short++;
    }
    rep.lines = pending;

    if (apply && pending.length) {
      tx(() => {
        for (const p of pending) {
          run(`INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            p.service_id, p.filter_no, p.filter_no_norm, p.category, p.action_type, p.qty, p.price);
          rep.inserted++;
        }
      });
    }
  } finally { sdb.close(); }

  rep.total_now = get('SELECT COUNT(*) c FROM service_filters').c;
  return rep;
}

module.exports = { runStep, shapeOf };
