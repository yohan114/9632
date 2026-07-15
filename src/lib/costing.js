'use strict';

// ===========================================================================
// The Costing Engine (brief §7).
//   labour_cost   = Σ (daily_work.hours × labour_rate(mechanic, on job date))
//   material_cost = Σ (job_parts grn/issue: qty × unit_price)
//   oil_cost      = Σ (oil ledger issues to this job: qty × price on date)
//   general_cost  = Σ (general items issued to this job: qty × price)
//   external_cost = Σ (daily_work.external_value) + Σ (job_parts external repair)
//   TOTAL_COST    = labour + material + oil + general + external
//
// Prices use the value effective on the transaction/job date (price history).
// Unpriced lines contribute 0 AND block closure (the §6 gate).
// A frozen snapshot is written on CLOSE so historical costs never shift.
// ===========================================================================

const { get, all, run, tx } = require('../db');
const mechanics = require('./mechanics');

/** Hourly rate effective for a mechanic on a given date (via the name resolver). */
function labourRateFor(mechanic, onDate) {
  if (!mechanic) return null;
  // Resolve any raw spelling to the canonical mechanic name (read-only).
  const name = mechanics.resolveMechanicName(mechanic);
  const row = get(
    `SELECT rate FROM labour_rates
      WHERE mechanic = ? AND effective_from <= ?
      ORDER BY effective_from DESC, id DESC LIMIT 1`,
    name,
    onDate || todayISO()
  );
  if (row) return row.rate;
  // fall back to the most recent rate regardless of date
  const any = get('SELECT rate FROM labour_rates WHERE mechanic = ? ORDER BY effective_from DESC, id DESC LIMIT 1', name);
  return any ? any.rate : null;
}

/** Unit price of a product effective on a date (price history, else latest). */
function productPriceOn(productId, onDate) {
  const row = get(
    `SELECT unit_price FROM product_prices
      WHERE product_id = ? AND effective_from <= ?
      ORDER BY effective_from DESC, id DESC LIMIT 1`,
    productId,
    onDate || todayISO()
  );
  if (row) return row.unit_price;
  const p = get('SELECT unit_price FROM products WHERE id = ?', productId);
  return p ? p.unit_price : null;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compute the five cost components for a job from the authoritative source
 * tables. Each source contributes to exactly one bucket (no double counting).
 */
function computeJobCost(jobId) {
  const job = get('SELECT * FROM job_cards WHERE id = ?', jobId);
  if (!job) throw new Error('Job not found');
  const jobDate = (job.requested_at || todayISO()).slice(0, 10);

  // --- labour ---
  // Two models: SERVICE jobs carry a flat recorded labour amount (not hours×rate);
  // REPAIRS cost hourly. For repairs, a multi-mechanic entry already stores one
  // row per mechanic with the hours split across the crew (H/N each), so simply
  // summing (row.hours × rate) yields (H/N)×Σ(crew rates).
  const labourLines = [];
  let labour = 0;
  if (job.type === 'service') {
    labour = job.flat_labour != null ? job.flat_labour : 0;
    if (job.flat_labour != null) {
      labourLines.push({ mechanic: '(service flat charge)', hours: 0, rate: null, amount: job.flat_labour, work_date: jobDate, flat: true });
    }
  } else {
    for (const w of all('SELECT * FROM job_daily_work WHERE job_id = ? AND is_external = 0', jobId)) {
      const rate = labourRateFor(w.mechanic, (w.work_date || jobDate).slice(0, 10));
      const amount = rate != null ? (w.hours || 0) * rate : 0;
      labour += amount;
      labourLines.push({ mechanic: w.mechanic, hours: w.hours || 0, rate, amount, work_date: w.work_date });
    }
  }

  // --- material (job_parts grn/issue, non-external repair) ---
  let material = 0;
  for (const p of all(
    `SELECT * FROM job_parts WHERE job_id = ? AND source_type IN ('grn','issue') AND is_external_repair = 0`,
    jobId
  )) {
    if (p.unit_price != null) material += (p.qty || 0) * p.unit_price;
  }

  // --- oil (stock ledger issues to this job) ---
  let oil = 0;
  for (const l of all(`SELECT * FROM stock_ledger WHERE job_id = ? AND kind = 'issue'`, jobId)) {
    const qty = Math.abs(l.qty || 0);
    const price = l.unit_price != null ? l.unit_price : productPriceOn(l.product_id, (l.txn_date || jobDate).slice(0, 10));
    if (price != null) oil += qty * price;
  }

  // --- general (general item issues to this job) ---
  let general = 0;
  for (const g of all(`SELECT * FROM general_item_txns WHERE job_id = ? AND txn_type = 'issue'`, jobId)) {
    if (g.unit_price != null) general += Math.abs(g.qty || 0) * g.unit_price;
  }

  // --- external (daily-work external value + job_parts external repairs) ---
  let external = 0;
  for (const w of all('SELECT * FROM job_daily_work WHERE job_id = ? AND is_external = 1', jobId)) {
    external += w.external_value || 0;
  }
  for (const p of all('SELECT * FROM job_parts WHERE job_id = ? AND is_external_repair = 1', jobId)) {
    if (p.unit_price != null) external += (p.qty || 0) * p.unit_price;
  }

  const total = labour + material + oil + general + external;
  return {
    labour_cost: round2(labour),
    material_cost: round2(material),
    oil_cost: round2(oil),
    general_cost: round2(general),
    external_cost: round2(external),
    total_cost: round2(total),
    labourLines,
  };
}

/**
 * Closure gate (brief §6): a card may close only when EVERY consumed line is
 * fully documented and priced. Returns { ready, missing:[...] }.
 */
function closureReadiness(jobId) {
  const missing = [];
  const job = get('SELECT type, flat_labour FROM job_cards WHERE id = ?', jobId);

  // every requested part has a GRN (MRN lines fully received)
  for (const l of all(
    `SELECT ml.*, m.mrn_no FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id WHERE m.job_id = ?`,
    jobId
  )) {
    if ((l.qty_received || 0) < (l.qty || 0)) {
      missing.push(`MRN ${l.mrn_no}: "${l.description}" received ${l.qty_received || 0}/${l.qty} — awaiting GRN`);
    }
  }

  // every material / external part line priced
  for (const p of all('SELECT * FROM job_parts WHERE job_id = ?', jobId)) {
    if (p.unit_price == null) {
      missing.push(`Part "${p.description || p.source_type}" awaiting price`);
    }
  }

  // every oil issue priced (either explicit or via price history)
  for (const l of all(`SELECT * FROM stock_ledger WHERE job_id = ? AND kind = 'issue'`, jobId)) {
    const price = l.unit_price != null ? l.unit_price : productPriceOn(l.product_id, l.txn_date);
    if (price == null) missing.push(`Oil issue (product #${l.product_id}) awaiting price`);
  }

  // every general issue priced
  for (const g of all(`SELECT * FROM general_item_txns WHERE job_id = ? AND txn_type = 'issue'`, jobId)) {
    if (g.unit_price == null) missing.push(`General item issue #${g.id} awaiting price`);
  }

  // labour: services need a flat charge set; repairs need a rate per labour line
  if (job && job.type === 'service') {
    if (job.flat_labour == null) missing.push('Service labour (flat charge) not set');
  } else {
    for (const w of all('SELECT * FROM job_daily_work WHERE job_id = ? AND is_external = 0', jobId)) {
      if (labourRateFor(w.mechanic, w.work_date) == null) {
        missing.push(`Labour rate missing for mechanic "${w.mechanic || '(unnamed)'}"`);
      }
    }
  }

  // external repairs have a value
  for (const w of all('SELECT * FROM job_daily_work WHERE job_id = ? AND is_external = 1', jobId)) {
    if (w.external_value == null || w.external_value === '') {
      missing.push(`External repair on ${w.work_date} awaiting value`);
    }
  }

  return { ready: missing.length === 0, missing };
}

/** Recompute live totals on the job card and rebuild job_labour lines. */
function refreshJobTotals(jobId) {
  const c = computeJobCost(jobId);
  tx(() => {
    run('DELETE FROM job_labour WHERE job_id = ?', jobId);
    const stmt = require('../db').db.prepare(
      'INSERT INTO job_labour (job_id, mechanic, hours, rate, amount, work_date) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const l of c.labourLines) stmt.run(jobId, l.mechanic, l.hours, l.rate, l.amount, l.work_date);
    run(
      `UPDATE job_cards
         SET labour_cost=?, material_cost=?, oil_cost=?, general_cost=?, external_cost=?, total_cost=?,
             updated_at=datetime('now')
       WHERE id=?`,
      c.labour_cost, c.material_cost, c.oil_cost, c.general_cost, c.external_cost, c.total_cost, jobId
    );
  });
  return c;
}

/** Freeze a cost snapshot (called on CLOSE). Historical costs never shift after. */
function snapshotJobCost(jobId) {
  const c = refreshJobTotals(jobId);
  run(
    `INSERT INTO job_costs (job_id, labour_cost, material_cost, oil_cost, general_cost, external_cost, total_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    jobId, c.labour_cost, c.material_cost, c.oil_cost, c.general_cost, c.external_cost, c.total_cost
  );
  return c;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = {
  labourRateFor,
  productPriceOn,
  computeJobCost,
  closureReadiness,
  refreshJobTotals,
  snapshotJobCost,
};
