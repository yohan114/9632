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
  // stock_moves' unique key gained item_key, so one service line can record BOTH of the filters
  // it fits. CREATE TABLE IF NOT EXISTS cannot change a constraint, and SQLite cannot alter one
  // in place — but stock_moves is a PROJECTION, regenerated from the source tables by
  // rebuild({ wipe: true }), so dropping it loses nothing that is not rebuilt. Detected by
  // reading the constraint back rather than by a version number, so it runs once and then never.
  const sm = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='stock_moves'").get();
  if (sm) {
    const uniq = (String(sm.sql).match(/UNIQUE\s*\([^)]*\)/i) || [''])[0];
    if (uniq && !/item_key/i.test(uniq)) db.exec('DROP TABLE stock_moves');
  }
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
  // Item category tree — exactly TWO levels: parent_id NULL = a top-level Category,
  // otherwise a Sub-category of that parent (the API refuses a third level). `code`
  // carries the 3-letter item_no prefix (ELE, TRN, FIL…) so catalogue numbering stays
  // stable: a sub-category never renumbers an item.
  db.exec(`CREATE TABLE IF NOT EXISTS item_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id  INTEGER REFERENCES item_categories(id),
    name       TEXT NOT NULL,
    name_norm  TEXT NOT NULL,             -- uppercased, symbols stripped (uniqueness key)
    code       TEXT,                      -- item_no prefix, parents only
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_item_cat_uniq ON item_categories(COALESCE(parent_id, 0), name_norm);
  CREATE INDEX IF NOT EXISTS idx_item_cat_parent ON item_categories(parent_id);`);
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
  // Owner-entered "outside labor value" per daily-work entry — what this piece of work would cost
  // sent to an outside repairer. Rolls into the Job Cost Report's make-or-buy comparison.
  ensureColumn('job_daily_work', 'outside_labour', 'REAL');
  // WHICH MACHINE THE WORK WAS ON, recorded rather than inferred.
  //
  // The line never carried one: the machine was only implied by the job card, and for work booked
  // to the GENERAL-WS catch-all it was implied by nothing at all — written into the description if
  // the mechanic happened to type it ("AC-06 — Compressor clean and repair"). Reading it back out
  // of that prose was tried and measured: over the 2,535 rows whose job already names a vehicle it
  // answered 86 times and was RIGHT 7, because 223 registry rows are cost centres whose code has no
  // digit, so "Service bay door fixing" confidently became the asset "Service". A column ends that.
  ensureColumn('job_daily_work', 'asset_id', 'INTEGER REFERENCES assets(id)');
  // Backfill from the job card, which is authoritative wherever it names a vehicle: a line on
  // AC-06's card is work on AC-06. Rows on the catch-all stay NULL — genuinely unknown, and better
  // shown as unknown than filled with a guess. Runs on every boot and only fills NULLs, so it also
  // heals a row whose vehicle was never set.
  db.exec(`UPDATE job_daily_work
              SET asset_id = (SELECT asset_id FROM job_cards WHERE job_cards.id = job_daily_work.job_id)
            WHERE asset_id IS NULL
              AND (SELECT asset_id FROM job_cards WHERE job_cards.id = job_daily_work.job_id) IS NOT NULL`);
  // Movements before a section's stock cut-over stay visible as history but are excluded
  // from the balance (CREATE TABLE IF NOT EXISTS won't add this to an existing table).
  ensureColumn('stock_moves', 'counts', 'INTEGER NOT NULL DEFAULT 1');
  // The MR number the storekeeper writes on every handover in the tracker. All 299 imported rows
  // carry one and the importer threw it away, so a handover could never be recognised as the
  // handover OF ITS OWN RECEIPT — the receipt sat under one item key and the issue under another,
  // and six items read negative for want of the link. Kept here so the tie survives the import.
  ensureColumn('issues', 'mrn_no', 'TEXT');
  // One handover, written down twice — once free-hand in the storekeeper's tracker and once
  // against the receipt through Stores. Voiding keeps the row (it carries the recipient's name
  // and who issued it, which the receipt-linked row does not) but stops it deducting a second
  // time. Same idea as stock_ledger.voided, and the rebuild honours it the same way.
  ensureColumn('issues', 'voided', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('issues', 'voided_reason', 'TEXT');
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
  // Sub-category link (item_categories.id, always a LEAF/sub-category). The free-text
  // `category` column above stays and is written in step with it — every existing
  // report groups by that text — but category_id is the master from here on.
  ensureColumn('store_items', 'category_id', 'INTEGER');
  ensureColumn('mrn_lines', 'category_id', 'INTEGER');
  ensureColumn('issues', 'category_id', 'INTEGER');
  ensureColumn('mtn', 'category_id', 'INTEGER');
  ensureColumn('mrn', 'purchase_source', 'TEXT'); // Head Office / Local Purchase / ...
  ensureColumn('mrn', 'required_date', 'TEXT');   // "Required Date" on the printed requisition form
  ensureColumn('mrn_lines', 'purchase_source', 'TEXT'); // per-item Head Office / Local Purchase (one MRN can mix)
  ensureColumn('mrn', 'request_type', "TEXT NOT NULL DEFAULT 'vehicle'"); // 'general' (store) | 'vehicle' (against a job card)
  // Which KIND of tyre/battery request this is. It needs a column of its own: request_type already
  // means general-vs-vehicle on all 1,709 existing requests, and writing 'tyre' into it would
  // quietly redefine a field that stores and daily work both read.
  ensureColumn('mrn', 'tb_kind', 'TEXT');                                // 'tyre' | 'battery' | NULL
  // THE WORKSHOP STORE DOES NOT BUY TYRES. It raises the request, the request is approved, and then
  // it goes to Head Office to be purchased — so an approved request is not the end of the story
  // here the way it is for an ordinary part off the workshop shelf. These three record that step.
  ensureColumn('mrn', 'purchase_requested_at', 'TEXT');
  ensureColumn('mrn', 'purchase_requested_by', 'TEXT');
  ensureColumn('mrn', 'purchase_ref', 'TEXT');                           // Head Office's own reference, when they give one
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
  ensureColumn('job_cards', 'outside_estimate', 'REAL DEFAULT 0'); // outside workshop quote / estimate for comparison
  // Set the FIRST time a closed card is reopened and never overwritten after: the month the
  // card was originally closed in. Re-closing restores completed_at from it, so a cost report
  // the owner has already issued cannot change because someone reopened an old job.
  ensureColumn('job_cards', 'original_completed_at', 'TEXT');
  ensureColumn('service_jobs', 'outside_estimate', 'REAL DEFAULT 0'); // outside service value without transport
  // Unambiguous link from a job_part to the MRN request line it came from (Phase 3):
  // avoids overloading the polymorphic source_id (a manual GRN part won't mislink to mrn_lines).
  ensureColumn('job_parts', 'mrn_line_id', 'INTEGER');
  // Which physical RECEIPT a handover came out of. An MRN line can be delivered in several
  // GRNs (56 are), so "how much of this delivery is left" has to be counted per receipt, not
  // per request line. Held on `issues` because that is a source table: a stock_moves rebuild
  // regenerates the ledger from it, so the link survives.
  // The date written on the GRN itself. Distinct from delivery_date (when the goods actually
  // arrived) and invoice_date (the supplier's own document) — the source system only ever held
  // those two, so this is blank on everything imported and is captured from now on.
  ensureColumn('grn', 'grn_date', 'TEXT');
  // What physically arrived, when it is not the number that was asked for. Filters are
  // routinely supplied as an equivalent — a VIC or Sakura part against a genuine number — and
  // the receipt has to record the box on the shelf, not the wish on the request, or nobody
  // can find it later. grn.description stays as the requested text.
  ensureColumn('grn', 'received_part_no', 'TEXT');
  ensureColumn('issues', 'grn_id', 'INTEGER');
  ensureColumn('stock_moves', 'grn_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_grn ON issues(grn_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sm_grn ON stock_moves(grn_id)');
  // Indexed here rather than in schema.sql — the column only exists once the line above has run.
  // The job report resolves requested/received spares through this link.
  db.exec('CREATE INDEX IF NOT EXISTS idx_jp_line ON job_parts(mrn_line_id)');
  // lubricant_aliases was first created with raw_norm UNIQUE on its own, which allows a name
  // exactly one meaning for all time. HD-68 was bought as Caltex and later as Valvoline under
  // the same written name, so the key has to be (name, effective_from). Rebuild it once,
  // carrying the rows over — CREATE TABLE IF NOT EXISTS cannot change a constraint.
  if (!db.prepare('PRAGMA table_info(lubricant_aliases)').all().some((c) => c.name === 'effective_from')) {
    db.exec(`
      ALTER TABLE lubricant_aliases RENAME TO lubricant_aliases_old;
      CREATE TABLE lubricant_aliases (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_text       TEXT NOT NULL,
        raw_norm       TEXT NOT NULL,
        product_id     INTEGER REFERENCES products(id),
        effective_from TEXT NOT NULL DEFAULT '',
        resolved       INTEGER NOT NULL DEFAULT 0,
        hit_count      INTEGER NOT NULL DEFAULT 0,
        source         TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (raw_norm, effective_from)
      );
      INSERT INTO lubricant_aliases (id, raw_text, raw_norm, product_id, effective_from, resolved, hit_count, source, created_at, updated_at)
        SELECT id, raw_text, raw_norm, product_id, '', resolved, hit_count, source, created_at, updated_at
          FROM lubricant_aliases_old;
      DROP TABLE lubricant_aliases_old;
      CREATE INDEX IF NOT EXISTS idx_lube_alias_norm ON lubricant_aliases(raw_norm);`);
  }
  // An item put on a request AFTER it was approved. The Operational Manager signed for the
  // items in front of them, so anything added later has to carry its own mark — who added it,
  // when and why — or the request would silently claim authority for something nobody approved.
  // Only an admin can do it; the approval itself stands so that receiving already in progress
  // is not interrupted (17 of the 25 approved requests already have goods against them).
  ensureColumn('mrn_lines', 'added_after_approval', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('mrn_lines', 'added_by', 'TEXT');
  ensureColumn('mrn_lines', 'added_at', 'TEXT');
  ensureColumn('mrn_lines', 'added_reason', 'TEXT');
  // Give every lubricant the code the unified catalogue already minted for it (OIL-0001…).
  // products.code has sat NULL since the oil book was imported, so the oil section had no way
  // to name a product that a request, receipt, issue or transfer could point back at.
  db.exec(`UPDATE products SET code = (
             SELECT si.code FROM stock_items si
              WHERE si.section = 'oil' AND si.source_table = 'products' AND si.source_id = products.id)
           WHERE code IS NULL
             AND EXISTS (SELECT 1 FROM stock_items si
                          WHERE si.section = 'oil' AND si.source_table = 'products' AND si.source_id = products.id)`);
  // Every product answers to its own name, seeded through the SAME normaliser the resolver
  // uses — a second copy of that rule in SQL would drift from it. Required here rather than at
  // the top of the file because lubricants.js needs this module back.
  require('../lib/lubricants').seedCatalogueAliases();
  // Carry a battery's single photo into the gallery, so nothing taken before it existed is
  // stranded on a column nothing renders any more. Keyed on "has no photos yet", so it is a
  // no-op on re-run and never re-adds one the storekeeper deleted.
  db.exec(`INSERT INTO battery_photos (battery_id, seq, photo, uploaded_at)
           SELECT b.id, 1, b.photo_path, b.created_at
             FROM batteries b
            WHERE b.photo_path IS NOT NULL AND b.photo_path <> ''
              AND NOT EXISTS (SELECT 1 FROM battery_photos p WHERE p.battery_id = b.id)`);
  // Give every transfer written before mtn_lines existed its one item, so the note and its
  // contents are read the same way everywhere from here on. Keyed on "has no lines yet", so
  // re-running is a no-op and a note deliberately emptied is never silently refilled — a
  // transfer always keeps at least one line, enforced by the API.
  db.exec(`INSERT INTO mtn_lines (mtn_id, line_no, store_item_id, description, qty, category, category_id, created_at)
           SELECT m.id, 1, m.store_item_id, m.description, m.qty, m.category, m.category_id, m.created_at
             FROM mtn m
            WHERE NOT EXISTS (SELECT 1 FROM mtn_lines l WHERE l.mtn_id = m.id)`);
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
  // Ten years of these were written as free text — 804 spellings of about 170 real tyre sizes, so
  // a third of tyre issues never reached a price. spec_id ties each line to the catalogue row it
  // really is, so the old register and a new request meet on the same shelf. The rest is what a
  // request-driven issue carries that an imported one never did.
  // These sit HERE, after the table is created a few lines above — up with the other ensureColumn
  // calls they ran before the table existed and broke every fresh install.
  ensureColumn('tyre_battery_issues', 'spec_id', 'INTEGER REFERENCES tb_specs(id)');
  ensureColumn('tyre_battery_issues', 'mrn_line_id', 'INTEGER REFERENCES mrn_lines(id)');
  ensureColumn('tyre_battery_issues', 'serial_no', 'TEXT');
  ensureColumn('tyre_battery_issues', 'position', 'TEXT');
  ensureColumn('tyre_battery_issues', 'issued_by', 'TEXT');
  ensureColumn('tyre_battery_issues', 'job_id', 'INTEGER REFERENCES job_cards(id)');
  // A TYRE RARELY GOES ON ALONE. The register has been writing "750 X 16 TYER /TUBE/COLLER" into
  // the tyre's own description because there was nowhere else to put the tube and the flap. They
  // are their own items, sized like the tyre they go inside, so 'tube' and 'flap' join the kinds.
  // SQLite cannot alter a CHECK, and these tables are young — but tyre_battery_issues.spec_id
  // already points at 6,061 rows of tb_specs, so the table is rebuilt in place with its ids kept
  // rather than dropped. Detected by reading the constraint back, so it runs once and then never.
  for (const [table, cols] of [
    ['tb_specs', 'id, kind, size, tyre_type, rating, label, spec_key, unit_price, active, source, created_at'],
    ['tb_request_lines', 'id, mrn_line_id, kind, spec_id, asset_id, site, position, km_reading, km_remark, reason, priority, old_serial, notes, created_at'],
  ]) {
    const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    if (!cur || /'tube'/.test(cur.sql)) continue;
    const widened = cur.sql
      .replace(/CREATE TABLE (IF NOT EXISTS )?tb_/, 'CREATE TABLE tmp_tb_')
      .replace(/kind\s+TEXT NOT NULL CHECK \(kind IN \('tyre','battery'\)\)/,
        "kind        TEXT NOT NULL CHECK (kind IN ('tyre','battery','tube','flap'))");
    db.pragma('foreign_keys = OFF');
    db.exec(`${widened};
             INSERT INTO tmp_${table} (${cols}) SELECT ${cols} FROM ${table};
             DROP TABLE ${table};
             ALTER TABLE tmp_${table} RENAME TO ${table};`);
    db.pragma('foreign_keys = ON');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tb_specs_kind ON tb_specs(kind, active);
           CREATE INDEX IF NOT EXISTS idx_tb_reqline_asset ON tb_request_lines(asset_id);`);

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
