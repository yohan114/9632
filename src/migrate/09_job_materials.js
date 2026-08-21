'use strict';

// Phase — Assign store items to job cards. Each MRN's requested items and each stock
// issue is matched to the NEAREST job for the same vehicle (by date; ANY distance —
// the owner's chosen rule), and attached as job_parts so material cost shows.
//
// Safe-allocation guards (Phase 1, initiative 4 — "keep nearest + safe fixes"):
//   • Date quarantine — MRN/issue dates outside [DATE_FLOOR .. today] are data errors
//     (e.g. 1996/2001) and are NOT attached to the nearest card; they go to review.
//   • Container jobs — a REAL vehicle (plate/fleet-code shaped) that received materials
//     but owns no job card gets an auto-created container card so its items attach.
//     Non-vehicle "assets" (Stores, rooms, tools, names, sites) never get a card; their
//     lines stay in the review file (overhead, handled later).
//
// Priced from the item's GRN receipts where available, else listed awaiting-price.
// Historical job TOTALS are preserved by refreshJobTotals; this step itemises
// material_cost only — run reconcile-costs (step 15) afterwards to settle totals.
// Re-runnable: clears the parts it previously created and re-derives them; container
// jobs, once created, make the vehicle "have a job" so they are reused, not duplicated.

const fs = require('fs');
const path = require('path');
const { get, all, run, tx } = require('../db');
const config = require('../config');

const DATE_FLOOR = '2015-01-01'; // fleet-era floor; MRN dates before this are data errors
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayGap = (a, b) => Math.abs(Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000));
const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').slice(0, 10));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayISO = () => new Date().toISOString().slice(0, 10);
// First token looks like a plate / fleet code (BDI-8556, PC-7812, 48-4849, EH-12, PTR-10).
const VEHICLE_CODE = /^([A-Z]{1,4}|\d{2,3})-?\d{2,4}[A-Z]?\b/i;
const looksLikeVehicle = (code) => VEHICLE_CODE.test(String(code || '').trim());

function runStep() {
  const CEIL = todayISO();
  const validDate = (d) => isISO(d) && d >= DATE_FLOOR && d <= CEIL;

  const rep = { mrn_matched: 0, items_added: 0, priced_items: 0, backfilled_items: 0, unpriced_items: 0,
    issue_matched: 0, issue_unmatched: 0, no_job: 0, no_vehicle: 0, quarantined: 0,
    container_jobs: 0, container_skipped_nonvehicle: 0, container_lines: 0,
    jobs_touched: 0, material_value: 0, total_material: 0 };
  const nameNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const unassigned = [];

  const jobsByAsset = new Map();
  for (const j of all('SELECT id, asset_id, requested_at, completed_at, closed_at FROM job_cards WHERE asset_id IS NOT NULL')) {
    if (!jobsByAsset.has(j.asset_id)) jobsByAsset.set(j.asset_id, []);
    jobsByAsset.get(j.asset_id).push(j);
  }
  // Nearest job for the vehicle, any distance (window-containing counts as gap 0).
  const nearestJob = (assetId, date) => {
    const js = jobsByAsset.get(assetId) || [];
    if (!js.length) return null;
    let best = null, bg = Infinity;
    for (const j of js) {
      const s = String(j.requested_at).slice(0, 10);
      const e = String(j.closed_at || j.completed_at || j.requested_at).slice(0, 10);
      const g = date >= s && date <= e ? 0 : Math.min(dayGap(date, s), dayGap(date, e));
      if (g < bg) { bg = g; best = j; }
    }
    return best;
  };
  function containerJobNo(startDate) {
    const [y, m] = startDate.split('-');
    const prefix = `${y}/${parseInt(m, 10)}/R/`;
    let max = 0;
    for (const r of all('SELECT job_no FROM job_cards WHERE job_no LIKE ?', prefix + '%')) {
      const s = parseInt(String(r.job_no).split('/').pop(), 10);
      if (Number.isFinite(s) && s > max) max = s;
    }
    return prefix + (max + 1);
  }

  // This is a one-time ETL that rebuilds grn/issue job_parts from the imported source
  // data (DELETE + re-derive). Once the app is live, POST /issues creates its OWN
  // source_type='issue' job_parts (with issues.job_id set) — re-running this step would
  // delete them and re-home issues by nearest-date. Imported issues have job_id NULL, so
  // refuse to run destructively as soon as any live (job_id-tagged) issue exists.
  if (get('SELECT COUNT(*) c FROM issues WHERE job_id IS NOT NULL').c > 0) {
    rep.skipped_live = 'job-materials ETL skipped: live stock issues exist (issues.job_id set). Re-running would clobber live-created job_parts.';
    return rep;
  }

  const touched = new Set();
  tx(() => {
    const prev = all("SELECT DISTINCT job_id FROM job_parts WHERE source_type IN ('grn','issue')").map((r) => r.job_id);
    run("DELETE FROM job_parts WHERE source_type IN ('grn','issue')");
    for (const jid of prev) run('UPDATE job_cards SET material_cost = 0 WHERE id = ?', jid);
    run('UPDATE mrn SET job_id = NULL'); // re-derived below (init 9: enables the closure gate)

    // --- container jobs: real vehicles with materials but no job card ---
    for (const r of all(
      `SELECT m.asset_id, a.code,
              MIN(CASE WHEN substr(m.req_date,1,10) BETWEEN ? AND ? THEN substr(m.req_date,1,10) END) mn,
              MAX(CASE WHEN substr(m.req_date,1,10) BETWEEN ? AND ? THEN substr(m.req_date,1,10) END) mx,
              COUNT(ml.id) lines
         FROM mrn m JOIN assets a ON a.id = m.asset_id
         LEFT JOIN mrn_lines ml ON ml.mrn_id = m.id
        WHERE m.asset_id IS NOT NULL GROUP BY m.asset_id`,
      DATE_FLOOR, CEIL, DATE_FLOOR, CEIL
    )) {
      if (jobsByAsset.has(r.asset_id)) continue; // already owns a job (incl. a prior container)
      if (!r.mn) continue;                       // no valid-date material to hang a card on
      if (!looksLikeVehicle(r.code)) { rep.container_skipped_nonvehicle++; continue; }
      const start = r.mn, end = r.mx || r.mn;
      const info = run(
        `INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_by,
                                requested_at, completed_at, closed_at, is_historical, synthesized_no, legacy_ref)
         VALUES (?, ?, 'repair', ?, 'CLOSED', 'imported', ?, ?, ?, 1, 1, 'auto-container')`,
        containerJobNo(start), r.asset_id, `Stores materials for ${r.code} (auto-created container)`, start, end, end
      );
      jobsByAsset.set(r.asset_id, [{ id: info.lastInsertRowid, asset_id: r.asset_id, requested_at: start, completed_at: end, closed_at: end }]);
      rep.container_jobs++;
      rep.container_lines += r.lines;
    }

    const lineRecv = new Map();
    for (const g of all('SELECT mrn_line_id, qty, unit_price FROM grn WHERE mrn_line_id IS NOT NULL AND unit_price IS NOT NULL')) {
      const cur = lineRecv.get(g.mrn_line_id) || { value: 0, qty: 0 };
      cur.value += (g.qty || 0) * g.unit_price;
      cur.qty += (g.qty || 0);
      lineRecv.set(g.mrn_line_id, cur);
    }
    // How much actually turned up, priced or not. lineRecv above only knows about PRICED
    // receipts, so it cannot answer "did anything arrive" — a delivery still awaiting its
    // invoice looks identical to one that never came.
    const lineDelivered = new Map();
    for (const g of all('SELECT mrn_line_id, qty FROM grn WHERE mrn_line_id IS NOT NULL')) {
      lineDelivered.set(g.mrn_line_id, (lineDelivered.get(g.mrn_line_id) || 0) + (g.qty || 0));
    }

    // Fallback price-by-item-name (initiative 6): a line with no priced GRN of its own
    // borrows the average price of the SAME item name from any priced GRN receipt.
    const priceByName = new Map();
    for (const g of all(`SELECT ml.description d, g.qty, g.unit_price FROM grn g
                           JOIN mrn_lines ml ON ml.id = g.mrn_line_id
                          WHERE g.unit_price IS NOT NULL AND g.mrn_line_id IS NOT NULL`)) {
      const k = nameNorm(g.d); if (!k) continue;
      const cur = priceByName.get(k) || { value: 0, qty: 0 };
      cur.value += (g.qty || 0) * g.unit_price; cur.qty += (g.qty || 0);
      priceByName.set(k, cur);
    }
    const fallbackPrice = (desc) => { const c = priceByName.get(nameNorm(desc)); return c && c.qty > 0 ? round2(c.value / c.qty) : null; };

    for (const m of all('SELECT m.id, m.mrn_no, m.asset_id, m.req_date, a.code AS asset_code FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id')) {
      const lines = all('SELECT id, description, qty, category FROM mrn_lines WHERE mrn_id = ?', m.id);
      const d = String(m.req_date || '').slice(0, 10);
      let job = null, reason = null;
      if (!m.asset_id) { reason = 'no vehicle'; rep.no_vehicle += lines.length; }
      else if (!isISO(d)) { reason = 'no/invalid date'; rep.no_job += lines.length; }
      else if (!validDate(d)) { reason = `impossible date ${d} (quarantined)`; rep.quarantined += lines.length; }
      else { job = nearestJob(m.asset_id, d); if (!job) { reason = 'vehicle has no job card'; rep.no_job += lines.length; } }

      if (!job) {
        for (const l of lines) unassigned.push({ mrn_no: m.mrn_no, vehicle: m.asset_code || '', description: l.description, qty: l.qty, category: l.category, reason });
        continue;
      }
      rep.mrn_matched++;
      run('UPDATE mrn SET job_id = ? WHERE id = ?', job.id, m.id); // init 9: closure gate can now traverse mrn.job_id
      for (const l of lines) {
        const rv = lineRecv.get(l.id);
        const delivered = lineDelivered.get(l.id) || 0;
        // Nothing ever turned up against this request, so nothing was fitted to the vehicle and
        // nothing may be charged to it. The line stays visible as a request through mrn.job_id
        // (set just above); it simply is not a consumed part.
        if (!(delivered > 0)) { rep.never_received = (rep.never_received || 0) + 1; continue; }
        let qty, price;
        if (rv && rv.value > 0 && rv.qty > 0) { qty = rv.qty; price = round2(rv.value / rv.qty); rep.priced_items++; rep.material_value += rv.value; }
        else {
          // It arrived but carries no price — charge the quantity that actually ARRIVED, not the
          // quantity ordered, so a part-delivery is not billed as if it came in full.
          qty = delivered;
          const fb = fallbackPrice(l.description);
          if (fb != null) { price = fb; rep.backfilled_items++; rep.material_value += qty * fb; }
          else { price = null; rep.unpriced_items++; }
        }
        run(
          `INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price, is_external_repair)
           VALUES (?, 'grn', ?, ?, ?, ?, ?, 0)`,
          job.id, l.id, l.id, l.description || null, qty, price
        );
        rep.items_added++;
      }
      touched.add(job.id);
    }

    for (const i of all('SELECT id, asset_id, issue_date, description, qty, unit_price FROM issues WHERE asset_id IS NOT NULL')) {
      const d = String(i.issue_date || '').slice(0, 10);
      const job = validDate(d) ? nearestJob(i.asset_id, d) : null;
      if (!job) { rep.issue_unmatched++; continue; }
      run(
        `INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, is_external_repair)
         VALUES (?, 'issue', ?, ?, ?, ?, 0)`,
        job.id, i.id, i.description || null, i.qty || 0, i.unit_price == null || i.unit_price === '' ? null : i.unit_price
      );
      rep.issue_matched++;
      touched.add(job.id);
    }

    for (const jid of touched) {
      const mm = get(
        `SELECT COALESCE(SUM(qty * unit_price), 0) v FROM job_parts
          WHERE job_id = ? AND source_type IN ('grn','issue') AND is_external_repair = 0 AND unit_price IS NOT NULL`,
        jid
      ).v;
      run('UPDATE job_cards SET material_cost = ? WHERE id = ?', round2(mm), jid);
    }
  });

  // Write the un-assignable items to a review table.
  if (unassigned.length) {
    unassigned.sort((a, b) => (b.reason < a.reason ? -1 : 1) || String(a.vehicle).localeCompare(String(b.vehicle)));
    const q = (v) => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const out = ['MRN No,Vehicle,Item,Qty,Category,Reason']
      .concat(unassigned.map((u) => [u.mrn_no, u.vehicle, u.description, u.qty, u.category, u.reason].map(q).join(',')));
    rep.unassigned_file = path.join(config.root, 'job_materials_unassigned.csv');
    fs.writeFileSync(rep.unassigned_file, out.join('\n') + '\n');
    rep.unassigned_count = unassigned.length;
  }

  rep.jobs_touched = touched.size;
  rep.material_value = Math.round(rep.material_value);
  rep.total_material = Math.round(get('SELECT COALESCE(SUM(material_cost), 0) v FROM job_cards').v);
  return rep;
}

module.exports = { runStep };
