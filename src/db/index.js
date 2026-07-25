'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

// Ensure the data directory exists.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Apply the schema. Idempotent — every statement is CREATE ... IF NOT EXISTS.
 */
function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // MRN approval trail (SK request → Workshop certify → Operational Manager approve).
  // Each row is an e-signature: who signed, the role they signed as, the decision, when.
  db.exec(`CREATE TABLE IF NOT EXISTS mrn_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_id      INTEGER NOT NULL REFERENCES mrn(id) ON DELETE CASCADE,
    stage       TEXT NOT NULL,          -- 'certify' | 'approve'
    role        TEXT,                   -- role the signer acted as
    approver_id INTEGER REFERENCES users(id),
    signed_name TEXT,                   -- e-signature: signer's full name at signing
    decision    TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mrn_approvals ON mrn_approvals(mrn_id);`);
  // Job Request (Transport) — Assistant Transport raises → Transport Manager certifies
  // → Operational Manager approves; on final approval a job card is auto-created.
  db.exec(`CREATE TABLE IF NOT EXISTS job_requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    jr_no             TEXT NOT NULL UNIQUE,      -- editable, continues from the last number
    req_date          TEXT NOT NULL DEFAULT (date('now')),
    asset_id          INTEGER REFERENCES assets(id),
    project_id        INTEGER REFERENCES projects(id),
    type              TEXT NOT NULL DEFAULT 'repair',  -- repair | service
    severity          TEXT,                     -- major | minor
    priority          TEXT,                     -- normal | urgent
    description       TEXT,
    required_date     TEXT,
    approval_status   TEXT NOT NULL DEFAULT 'requested', -- requested | certified | approved | rejected
    requested_by      TEXT,
    requested_by_user INTEGER REFERENCES users(id),
    requested_sig     TEXT,
    certified_by      TEXT, certified_at TEXT, certified_sig TEXT,
    approved_by       TEXT, approved_at TEXT, approved_sig TEXT,
    job_id            INTEGER REFERENCES job_cards(id),  -- the job card created on final approval
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_job_requests_asset ON job_requests(asset_id);
  CREATE INDEX IF NOT EXISTS idx_job_requests_status ON job_requests(approval_status);
  CREATE TABLE IF NOT EXISTS job_request_approvals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
    stage          TEXT NOT NULL,          -- 'certify' | 'approve'
    role           TEXT,
    approver_id    INTEGER REFERENCES users(id),
    signed_name    TEXT,
    signature      TEXT,
    decision       TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason         TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jr_approvals ON job_request_approvals(job_request_id);`);
  // Role-based access control — one row per (role, module) with a level
  // (none/view/edit/full). Seeded once from the code policy, then admin-editable.
  db.exec(`CREATE TABLE IF NOT EXISTS role_permissions (
    role   TEXT NOT NULL,
    module TEXT NOT NULL,
    level  TEXT NOT NULL DEFAULT 'none',
    PRIMARY KEY (role, module)
  );`);
  // Filter price book — one row per distinct filter number (as typed on a service).
  // unit_price NULL/0 = missing. Typing a new number saves a row here (the learning
  // catalogue), so a filter's price is remembered and auto-fills on the next service.
  db.exec(`CREATE TABLE IF NOT EXISTS filter_prices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    filter_no      TEXT NOT NULL,
    filter_no_norm TEXT NOT NULL UNIQUE,   -- uppercased, symbols/parens stripped, for matching
    category       TEXT,
    unit_price     REAL,                   -- NULL / 0 = price still missing
    uses           INTEGER NOT NULL DEFAULT 0, -- times seen in the service history (ranking)
    source         TEXT DEFAULT 'manual',  -- import | manual | auto
    notes          TEXT,
    updated_by     TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_filter_prices_norm ON filter_prices(filter_no_norm);
  CREATE TABLE IF NOT EXISTS service_jobs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_service_id  INTEGER,
    vehicle_label      TEXT,
    asset_id           INTEGER REFERENCES assets(id),
    service_date       TEXT,
    job_no             TEXT,
    meter_reading      TEXT,
    next_service_meter TEXT,
    service_type       TEXT,
    site_location      TEXT,
    repair_details     TEXT,
    parts_subtotal     REAL DEFAULT 0,
    labour_charge      REAL DEFAULT 0,
    sundry_amount      REAL DEFAULT 0,
    grand_total        REAL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_service_jobs_asset ON service_jobs(asset_id);
  CREATE INDEX IF NOT EXISTS idx_service_jobs_date ON service_jobs(service_date);
  CREATE TABLE IF NOT EXISTS service_filters (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id     INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
    filter_no      TEXT,
    filter_no_norm TEXT,
    category       TEXT,
    action_type    TEXT,
    qty            INTEGER DEFAULT 1,
    price          REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_service_filters_svc ON service_filters(service_id);
  CREATE INDEX IF NOT EXISTS idx_service_filters_norm ON service_filters(filter_no_norm);
  CREATE TABLE IF NOT EXISTS service_oils (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
    oil_name    TEXT,
    oil_type    TEXT,
    action_type TEXT,
    qty         REAL DEFAULT 0,
    price       REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_service_oils_svc ON service_oils(service_id);
  -- "Other Costs" lines on a service (parts / consumables not in the oil/filter grids).
  CREATE TABLE IF NOT EXISTS service_parts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
    description TEXT,
    unit        TEXT,
    rate        REAL DEFAULT 0,
    qty         REAL DEFAULT 0,
    amount      REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_service_parts_svc ON service_parts(service_id);
  -- Reference lists that drive the fixed rows of the paper service form.
  CREATE TABLE IF NOT EXISTS oil_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT DEFAULT 'L', sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS filter_category_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS oil_type_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, unit_price REAL DEFAULT 0
  );
  -- Filter cross-reference catalogue: one row per physical filter, with the brands
  -- available in the Sri Lankan market (OEM, HIFI, VIC, Sakura, Fleetguard, Donaldson…).
  CREATE TABLE IF NOT EXISTS filter_catalogue (
    id            INTEGER PRIMARY KEY,   -- source FilterID
    category      TEXT,
    oem_pn        TEXT, oem_pn_norm TEXT,
    hifi_pn       TEXT, hifi_pn_norm TEXT,
    description   TEXT,
    top_vehicle   TEXT,
    fleet_types   TEXT,
    uses          INTEGER DEFAULT 0,
    cross_refs_text TEXT
  );
  CREATE TABLE IF NOT EXISTS filter_xrefs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    catalogue_id     INTEGER REFERENCES filter_catalogue(id) ON DELETE CASCADE,
    brand            TEXT,
    part_number      TEXT NOT NULL,
    part_number_norm TEXT NOT NULL,
    ref_type         TEXT DEFAULT 'cross',   -- oem | hifi | cross
    source           TEXT DEFAULT 'import',  -- import | manual | research
    note             TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_filter_xrefs_cat ON filter_xrefs(catalogue_id);
  CREATE INDEX IF NOT EXISTS idx_filter_xrefs_norm ON filter_xrefs(part_number_norm);
  CREATE INDEX IF NOT EXISTS idx_filter_xrefs_brand ON filter_xrefs(brand);`);
  // Service header extras for the paper form.
  ensureColumn('service_jobs', 'upkeeping', 'TEXT');            // Good | Fair | Bad
  ensureColumn('service_jobs', 'reg_id', 'TEXT');               // registration snapshot at service time
  ensureColumn('service_jobs', 'model_no', 'TEXT');
  ensureColumn('service_jobs', 'labour_rate', "REAL DEFAULT 20"); // % of parts
  ensureColumn('service_jobs', 'sundry_rate', "REAL DEFAULT 5");   // % of parts
  // Upgrade-safe additive column checks (CREATE TABLE IF NOT EXISTS won't add
  // columns to a table that already exists).
  ensureColumn('job_cards', 'flat_labour', 'REAL');
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  // Phase 1 migration deltas (additive; CHECK relaxations live in schema.sql).
  ensureColumn('assets', 'in_register', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('assets', 'legacy_fleet_id', 'INTEGER');
  ensureColumn('projects', 'name_norm', 'TEXT');
  ensureColumn('mrn_lines', 'legacy_item_id', 'INTEGER');
  // Preserve the source item category on stores records (9-category breakdown).
  ensureColumn('mrn_lines', 'category', 'TEXT');
  ensureColumn('issues', 'category', 'TEXT');
  ensureColumn('mtn', 'category', 'TEXT');
  ensureColumn('mrn', 'purchase_source', 'TEXT'); // Head Office / Local Purchase / ...
  ensureColumn('mrn', 'required_date', 'TEXT');   // "Required Date" on the printed requisition form
  ensureColumn('mrn_lines', 'purchase_source', 'TEXT'); // per-item Head Office / Local Purchase (one MRN can mix)
  ensureColumn('mrn', 'request_type', "TEXT NOT NULL DEFAULT 'vehicle'"); // 'general' (store) | 'vehicle' (against a job card)
  // MRN approval flow (request → certify → approve) with e-signature names + timestamps.
  ensureColumn('mrn', 'approval_status', "TEXT NOT NULL DEFAULT 'requested'"); // requested | certified | approved | rejected
  ensureColumn('mrn', 'certified_by', 'TEXT'); ensureColumn('mrn', 'certified_at', 'TEXT');
  ensureColumn('mrn', 'approved_by', 'TEXT'); ensureColumn('mrn', 'approved_at', 'TEXT');
  // Visual e-signatures (drawn or uploaded PNG data URLs).
  ensureColumn('users', 'signature', 'TEXT');       // each user's saved signature image
  ensureColumn('mrn', 'requested_sig', 'TEXT'); ensureColumn('mrn', 'certified_sig', 'TEXT'); ensureColumn('mrn', 'approved_sig', 'TEXT');
  ensureColumn('mrn_approvals', 'signature', 'TEXT'); // signature snapshot applied at signing
  ensureColumn('general_item_txns', 'source', 'TEXT'); // import source tag (idempotent re-import)
  // Consolidated MRN item catalogue (deduped from mrn_lines descriptions).
  ensureColumn('store_items', 'item_no', 'TEXT');          // catalogue number, e.g. FIL-0001
  ensureColumn('store_items', 'catalogue_kind', 'TEXT');   // part | consumable | service
  ensureColumn('store_items', 'part_numbers', 'TEXT');     // all merged part/reference codes ( | -joined)
  ensureColumn('store_items', 'req_count', 'INTEGER');     // historical MRN request count
  ensureColumn('grn', 'purchase_source_norm', 'TEXT');
  ensureColumn('grn', 'priced_at', 'TEXT'); // when a unit price was first entered (procurement tracking)
  ensureColumn('stock_ledger', 'consumer_type', 'TEXT');
  ensureColumn('stock_ledger', 'voided', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('stock_ledger', 'legacy_id', 'INTEGER');
  ensureColumn('products', 'sheet_name', 'TEXT');
  ensureColumn('products', 'sort_order', 'INTEGER');
  ensureColumn('products', 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('batteries', 'state_norm', 'TEXT');
  for (const c of ['diesel_filter', 'oil_filter', 'air_filter', 'trans_filter', 'hy_filter']) ensureColumn('service_specs', c, 'REAL');
  ensureColumn('job_cards', 'legacy_ref', 'TEXT');
  ensureColumn('job_cards', 'is_historical', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('job_cards', 'synthesized_no', 'INTEGER NOT NULL DEFAULT 0');
  // Cost reconciliation (Phase 1): freeze the imported recorded total once, and
  // carry a balancing bucket so labour+material+oil+general+external+other == total_cost.
  ensureColumn('job_cards', 'recorded_cost', 'REAL');   // original imported total; total falls back to computed when this is 0/NULL
  ensureColumn('job_cards', 'other_cost', 'REAL NOT NULL DEFAULT 0'); // total_cost − Σ(components) so columns always reconcile
  // Unambiguous link from a job_part to the MRN request line it came from (Phase 3):
  // avoids overloading the polymorphic source_id (a manual GRN part won't mislink to mrn_lines).
  ensureColumn('job_parts', 'mrn_line_id', 'INTEGER');
  // Monthly Cost Report — manual inputs for the sheets the system can't source from
  // transactions (Tyre, Battery, Fuel, Other/overhead, Staff/Security salaries). One row
  // per line item, keyed by (year, month, sheet); generic columns cover all five sheets
  // (see src/lib/monthly_cost_report.js for the per-sheet column mapping).
  db.exec(`CREATE TABLE IF NOT EXISTS monthly_report_inputs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    year       INTEGER NOT NULL,
    month      INTEGER NOT NULL,            -- 1..12
    sheet      TEXT NOT NULL,               -- 'tyre' | 'battery' | 'fuel' | 'other' | 'salary'
    seq        INTEGER NOT NULL DEFAULT 0,  -- row order within the sheet
    asset_id   INTEGER REFERENCES assets(id),
    line_date  TEXT,                        -- date shown on the line (tyre/battery/fuel)
    vehicle    TEXT,                        -- free-text Reg / machine label
    label      TEXT,                        -- details / cost type / battery category / staff name
    project    TEXT,                        -- Project / Plant
    qty        TEXT,                        -- "02 Nos" / litres / headcount (free text like the paper form)
    rate       REAL,                        -- fuel: per-litre rate (fuel cost = qty * rate)
    amount1    REAL NOT NULL DEFAULT 0,     -- primary cost (tyre/battery/other/salary cost)
    amount2    REAL NOT NULL DEFAULT 0,     -- secondary (tube&flap / battery-other / salary-other / fuel standard-rate)
    amount3    REAL NOT NULL DEFAULT 0,     -- tertiary (tyre outside-work)
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mri_period ON monthly_report_inputs(year, month, sheet);`);
  ensureColumn('monthly_report_inputs', 'line_date', 'TEXT'); // additive for tables created before this column existed
  // Tyre & Battery issue ledger (imported from the workshop's issue-details workbook). One row per
  // issue; price is filled later — per issue (unit_price) or by category via tyre_battery_prices.
  // row_hash makes re-import idempotent. category_norm is the pricing join key.
  db.exec(`CREATE TABLE IF NOT EXISTS tyre_battery_issues (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,               -- 'tyre' | 'battery'
    issue_date    TEXT,                         -- YYYY-MM-DD (carried forward on blank rows at import)
    vehicle       TEXT,                         -- raw vehicle / machine label
    asset_id      INTEGER REFERENCES assets(id),
    site          TEXT,
    qty           REAL NOT NULL DEFAULT 0,      -- numeric parsed from "02 Nos"
    qty_raw       TEXT,                         -- original text
    category      TEXT,                         -- "1000 X 20" (tyre) / "120Amp" (battery)
    category_norm TEXT,                         -- pricing join key (uppercased, spaces stripped)
    min_number    TEXT,
    km            TEXT,
    unit_price    REAL,                         -- per-issue override; NULL = fall back to category price
    source        TEXT,                         -- import tag
    row_hash      TEXT UNIQUE,                  -- idempotent re-import key
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tbi_kind_date ON tyre_battery_issues(kind, issue_date);
  CREATE INDEX IF NOT EXISTS idx_tbi_catnorm ON tyre_battery_issues(kind, category_norm);
  CREATE TABLE IF NOT EXISTS tyre_battery_prices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,               -- 'tyre' | 'battery'
    category_norm TEXT NOT NULL,
    category      TEXT,                         -- display form
    unit_price    REAL,
    updated_by    TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(kind, category_norm)
  );`);
  // Seed the RBAC matrix once (safe to require here — db exports are already set).
  try { require('../lib/permissions').seedDefaults(); } catch (e) { /* table may not exist yet on very first pass */ }
  return db;
}

function ensureColumn(table, col, def) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

// Thin helpers so route code reads the same everywhere.
const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

/**
 * Run fn() inside a transaction. better-sqlite3 transactions are synchronous.
 */
function tx(fn) {
  return db.transaction(fn)();
}

module.exports = { db, migrate, get, all, run, tx };
