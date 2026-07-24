'use strict';

// Phase 4 — ERP schema gap-fill (SQLite / better-sqlite3).
// Additive, idempotent schema deltas: adds missing columns + inventory tables.
// Safe to run repeatedly — every column is guarded by a PRAGMA table_info check
// (and a try/catch belt-and-braces), and every table uses CREATE TABLE IF NOT EXISTS.
//
// NOTE ON CURRENT STATE: most of the "approval/workflow" columns this file targets
// (issues.category, the 11 mrn approval columns, mrn_approvals, users.full_name /
// .signature, grn.priced_at, mrn_lines.purchase_source, several store_items
// catalogue fields) are ALREADY present via the ensureColumn deltas in
// src/db/index.js, so they report as "existing" here and are left untouched. The
// genuinely-new pieces are store_items.unit_cost/total_value/description,
// products.stock_qty, and the vehicle_monthly_costs / filter_stock /
// filter_stock_ledger tables.
//
// total_value is a VIRTUAL GENERATED column (balance * unit_cost). SQLite supports
// adding VIRTUAL — not STORED — generated columns via ALTER TABLE, so it stays
// correct automatically with no trigger (and no trigger-recursion risk).
//
// Run:  node src/migrate/run.js --step erp-gaps

const { db, get } = require('../db');

function runStep() {
  const rep = { columns_added: [], columns_existing: [], tables_created: [], tables_existing: [], indexes: 0, errors: [] };

  const addColumn = (table, col, def) => {
    // table_xinfo (not table_info) so the check also sees VIRTUAL generated + hidden columns.
    const exists = db.prepare(`PRAGMA table_xinfo(${table})`).all().some((c) => c.name === col);
    if (exists) { rep.columns_existing.push(`${table}.${col}`); return; }
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); rep.columns_added.push(`${table}.${col}`); }
    catch (e) { rep.errors.push(`${table}.${col}: ${e.message}`); }
  };
  const createTable = (name, ddl, indexes = []) => {
    const existed = !!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", name);
    try {
      db.exec(ddl);
      for (const ix of indexes) { db.exec(ix); rep.indexes++; }
      (existed ? rep.tables_existing : rep.tables_created).push(name);
    } catch (e) { rep.errors.push(`${name}: ${e.message}`); }
  };

  // -- store_items: cost + valuation + description --------------------------
  addColumn('store_items', 'unit_cost', 'REAL DEFAULT 0');
  // Depends on unit_cost above existing first (added, or already present).
  addColumn('store_items', 'total_value', 'REAL GENERATED ALWAYS AS (balance * unit_cost) VIRTUAL');
  addColumn('store_items', 'description', 'TEXT');
  // Catalogue fields (already present via ensureColumn — recorded for completeness).
  addColumn('store_items', 'item_no', 'TEXT');
  addColumn('store_items', 'catalogue_kind', "TEXT DEFAULT 'part'");
  addColumn('store_items', 'req_count', 'INTEGER DEFAULT 0');
  addColumn('store_items', 'part_numbers', 'TEXT');

  // -- issues: category + generated line total ------------------------------
  addColumn('issues', 'category', 'TEXT');
  // total_cost mirrors store_items.total_value: a VIRTUAL generated column, so it is
  // always qty × unit_price on read — no trigger, no recursion risk, and correct even
  // when a row is edited. (SQLite ALTER TABLE supports adding VIRTUAL — not STORED —
  // generated columns; this file already relies on that for store_items.total_value.)
  addColumn('issues', 'total_cost', 'REAL GENERATED ALWAYS AS (qty * COALESCE(unit_price, 0)) VIRTUAL');

  // -- mrn: approval / workflow columns ------------------------------------
  addColumn('mrn', 'approval_status', "TEXT NOT NULL DEFAULT 'requested'");
  addColumn('mrn', 'request_type', "TEXT NOT NULL DEFAULT 'vehicle'");
  addColumn('mrn', 'purchase_source', 'TEXT');
  addColumn('mrn', 'required_date', 'TEXT');
  addColumn('mrn', 'requested_sig', 'TEXT');
  addColumn('mrn', 'certified_by', 'TEXT');
  addColumn('mrn', 'certified_at', 'TEXT');
  addColumn('mrn', 'certified_sig', 'TEXT');
  addColumn('mrn', 'approved_by', 'TEXT');
  addColumn('mrn', 'approved_at', 'TEXT');
  addColumn('mrn', 'approved_sig', 'TEXT');

  // -- mrn_lines: per-item purchase source ---------------------------------
  addColumn('mrn_lines', 'purchase_source', 'TEXT');

  // -- grn: procurement pricing timestamp ----------------------------------
  addColumn('grn', 'priced_at', 'TEXT');

  // -- users: signer identity + e-signature --------------------------------
  addColumn('users', 'full_name', 'TEXT');
  addColumn('users', 'signature', 'TEXT');

  // -- products (oil): quick stock lookup ----------------------------------
  addColumn('products', 'stock_qty', 'REAL DEFAULT 0');
  // Initialise stock_qty from the oil ledger's latest running balance (idempotent
  // absolute set — matches oil.js currentBalance()). oil.js keeps it in lock-step on
  // every ledger write thereafter. Without this, every existing product reads 0 L.
  try {
    db.exec(`UPDATE products SET stock_qty = COALESCE(
      (SELECT balance_after FROM stock_ledger WHERE product_id = products.id ORDER BY id DESC LIMIT 1), 0)`);
    rep.stock_qty_backfill = 'products.stock_qty set from latest ledger balance';
  } catch (e) { rep.errors.push('stock_qty backfill: ' + e.message); }

  // -- mrn_approvals (e-signature approval trail) --------------------------
  createTable('mrn_approvals', `CREATE TABLE IF NOT EXISTS mrn_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_id      INTEGER NOT NULL REFERENCES mrn(id) ON DELETE CASCADE,
    stage       TEXT NOT NULL,
    role        TEXT NOT NULL,
    approver_id INTEGER REFERENCES users(id),
    signed_name TEXT,
    signature   TEXT,
    decision    TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`, ['CREATE INDEX IF NOT EXISTS idx_mrn_approvals_mrn ON mrn_approvals(mrn_id)']);

  // -- vehicle_monthly_costs (per-asset × month rollup for the dashboard) ---
  createTable('vehicle_monthly_costs', `CREATE TABLE IF NOT EXISTS vehicle_monthly_costs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id    INTEGER NOT NULL REFERENCES assets(id),
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL,
    fuel_cost   REAL DEFAULT 0,
    oil_cost    REAL DEFAULT 0,
    filter_cost REAL DEFAULT 0,
    battery_cost REAL DEFAULT 0,
    parts_cost  REAL DEFAULT 0,
    labour_cost REAL DEFAULT 0,
    total_cost  REAL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(asset_id, year, month)
  )`, ['CREATE INDEX IF NOT EXISTS idx_vmc_period ON vehicle_monthly_costs(year, month)']);

  // -- vehicle_monthly_costs: initialise the parts component from issues ----
  // Idempotent ABSOLUTE recompute (not incremental) so re-running never double-counts.
  // Cost basis is qty × COALESCE(unit_price, 0) — the SAME formula POST /issues, the
  // issues.total_cost generated column, the KPIs and the category doughnut all use, so
  // a re-run stays state-preserving relative to the live rollup (no store-item unit_cost
  // fallback, which would let a re-run silently re-price NULL-priced issues). total_cost
  // is then rederived as Σ(component columns) so the invariant the POST upsert relies on
  // (parts += Δ, total += Δ) holds.
  try {
    db.exec(`
      INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost)
      SELECT i.asset_id,
             CAST(strftime('%Y', i.issue_date) AS INTEGER),
             CAST(strftime('%m', i.issue_date) AS INTEGER),
             ROUND(SUM(i.qty * COALESCE(i.unit_price, 0)), 2),
             ROUND(SUM(i.qty * COALESCE(i.unit_price, 0)), 2)
        FROM issues i
       WHERE i.asset_id IS NOT NULL AND i.issue_date IS NOT NULL AND length(i.issue_date) >= 7
       GROUP BY i.asset_id, 2, 3
      ON CONFLICT(asset_id, year, month) DO UPDATE SET parts_cost = excluded.parts_cost;
      UPDATE vehicle_monthly_costs
         SET total_cost = COALESCE(fuel_cost,0) + COALESCE(oil_cost,0) + COALESCE(filter_cost,0)
                        + COALESCE(battery_cost,0) + COALESCE(parts_cost,0) + COALESCE(labour_cost,0),
             updated_at = datetime('now');
    `);
    rep.vmc_backfill = 'vehicle_monthly_costs.parts recomputed from issues';
  } catch (e) { rep.errors.push('vmc backfill: ' + e.message); }

  // -- filter_stock (dedicated filter inventory) ---------------------------
  createTable('filter_stock', `CREATE TABLE IF NOT EXISTS filter_stock (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filter_type   TEXT NOT NULL,
    brand         TEXT,
    part_no       TEXT,
    unit          TEXT DEFAULT 'nos',
    qty_in_stock  REAL DEFAULT 0,
    reorder_level REAL DEFAULT 5,
    unit_cost     REAL DEFAULT 0,
    supplier      TEXT,
    compatible_assets TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`, [
    'CREATE INDEX IF NOT EXISTS idx_filter_stock_type ON filter_stock(filter_type)',
    'CREATE INDEX IF NOT EXISTS idx_filter_stock_part ON filter_stock(part_no)',
  ]);

  // -- filter_stock_ledger (running balance for filter inventory) ----------
  createTable('filter_stock_ledger', `CREATE TABLE IF NOT EXISTS filter_stock_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filter_id     INTEGER NOT NULL REFERENCES filter_stock(id),
    kind          TEXT NOT NULL CHECK (kind IN ('receipt','issue','adjustment')),
    qty           REAL NOT NULL,
    balance_after REAL NOT NULL,
    asset_id      INTEGER REFERENCES assets(id),
    job_id        INTEGER REFERENCES job_cards(id),
    unit_price    REAL,
    note          TEXT,
    txn_date      TEXT NOT NULL DEFAULT (date('now')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`, [
    'CREATE INDEX IF NOT EXISTS idx_fsl_filter ON filter_stock_ledger(filter_id)',
    'CREATE INDEX IF NOT EXISTS idx_fsl_asset ON filter_stock_ledger(asset_id)',
    'CREATE INDEX IF NOT EXISTS idx_fsl_job ON filter_stock_ledger(job_id)',
    'CREATE INDEX IF NOT EXISTS idx_fsl_date ON filter_stock_ledger(txn_date)',
  ]);

  return rep;
}

module.exports = { runStep };
