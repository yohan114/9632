'use strict';

// Phase — Labour hourly rates import (from the "Labor Hour" sheet). Creates one
// canonical mechanic per labour name and an effective-dated hourly rate that
// applies to all history (effective_from = EARLY). Also seeds the one known
// dual-spelling ("Seethananda/seetha" is written "Seethananda"/"seetha" in the
// daily-work log) so labour cost resolves.
//
// Idempotent: an existing (mechanic, rate, effective_from) row is not re-inserted.
// Source = sources/jobs/labour_rates.csv (the "Labor Hour" sheet of the uploaded
// "Daily_Work_Done updated.xlsx").

const { get, run, tx } = require('../db');
const mechanics = require('../lib/mechanics');
const { load, clean } = require('./csv');

const EARLY = '2020-01-01';

function runStep() {
  const rep = { rates_read: 0, mechanics_created: 0, rates_inserted: 0, rates_skipped: 0,
    aliases_seeded: 0, aliases_relinked: 0, aliases_skipped: 0, alias_canonical_missing: [] };
  const rows = load('jobs/labour_rates.csv');

  tx(() => {
    for (const r of rows) {
      const name = clean(r['Labour Name']);
      const rate = parseFloat(clean(r['Hour Price']));
      if (!name || !Number.isFinite(rate)) continue;
      rep.rates_read++;

      const before = get('SELECT COUNT(*) c FROM mechanics').c;
      const m = mechanics.findOrCreateMechanic(name);
      if (get('SELECT COUNT(*) c FROM mechanics').c > before) rep.mechanics_created++;

      if (get('SELECT id FROM labour_rates WHERE mechanic = ? AND rate = ? AND effective_from = ?', m.name, rate, EARLY)) {
        rep.rates_skipped++;
        continue;
      }
      run('INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES (?, ?, ?)', m.name, rate, EARLY);
      rep.rates_inserted++;
    }

    // Seed resolved alias mappings (alternate spellings → canonical mechanic) so
    // daily-work labour costs correctly. Source = sources/jobs/labour_aliases.csv.
    for (const a of load('jobs/labour_aliases.csv')) {
      const alias = clean(a.Alias);
      const canonical = clean(a.Canonical);
      if (!alias || !canonical) continue;
      const m = get('SELECT id FROM mechanics WHERE name_norm = ?', mechanics.normalizeMechanic(canonical));
      if (!m) { rep.alias_canonical_missing.push(`${alias} → ${canonical}`); continue; }
      const norm = mechanics.normalizeMechanic(alias);
      if (!norm) continue;
      const existing = get('SELECT id, mechanic_id, resolved FROM mechanic_aliases WHERE raw_norm = ?', norm);
      if (existing) {
        if (existing.mechanic_id !== m.id || !existing.resolved) {
          run(`UPDATE mechanic_aliases SET mechanic_id = ?, resolved = 1, updated_at = datetime('now') WHERE id = ?`, m.id, existing.id);
          rep.aliases_relinked++;
        } else {
          rep.aliases_skipped++;
        }
        continue;
      }
      run(
        `INSERT INTO mechanic_aliases (raw_text, raw_norm, mechanic_id, resolved, hit_count, source)
         VALUES (?, ?, ?, 1, 0, 'labour_aliases')`,
        alias, norm, m.id
      );
      rep.aliases_seeded++;
    }
  });

  rep.total_mechanics = get('SELECT COUNT(*) c FROM mechanics').c;
  rep.total_rates = get('SELECT COUNT(*) c FROM labour_rates').c;
  return rep;
}

module.exports = { runStep };
