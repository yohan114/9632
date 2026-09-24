'use strict';

// Repoint every assets-FK from one asset id to another during a de-dup merge.
//
// Most FK tables can be moved with a blind `UPDATE t SET asset_id = base WHERE asset_id
// = variant`. vehicle_monthly_costs is the exception: it is a derived rollup carrying
// UNIQUE(asset_id, year, month), so a blind repoint hits that constraint whenever the
// canonical and the folded variant both already have a row for the same month (which
// only happens when a merge step is re-run AFTER 015 created the table). For that table
// we fold overlapping months — summing every cost component so total = Σ(components) is
// preserved — and move the non-overlapping rows.

const { get, all, run } = require('../db');

const VMC_COMPONENTS = ['fuel_cost', 'oil_cost', 'filter_cost', 'battery_cost', 'parts_cost', 'labour_cost', 'total_cost'];

function repointAssetRefs(refCols, fromId, toId) {
  let changes = 0;
  for (const { table, col } of refCols) {
    if (table === 'vehicle_monthly_costs' && col === 'asset_id') {
      for (const vr of all('SELECT * FROM vehicle_monthly_costs WHERE asset_id = ?', fromId)) {
        const ex = get('SELECT id FROM vehicle_monthly_costs WHERE asset_id = ? AND year = ? AND month = ?', toId, vr.year, vr.month);
        if (ex) {
          run(
            `UPDATE vehicle_monthly_costs SET ${VMC_COMPONENTS.map((c) => `${c} = ${c} + ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
            ...VMC_COMPONENTS.map((c) => vr[c] || 0), ex.id
          );
          run('DELETE FROM vehicle_monthly_costs WHERE id = ?', vr.id);
        } else {
          run('UPDATE vehicle_monthly_costs SET asset_id = ? WHERE id = ?', toId, vr.id);
        }
        changes++;
      }
      continue;
    }
    changes += run(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, toId, fromId).changes;
  }
  return changes;
}

module.exports = { repointAssetRefs };
