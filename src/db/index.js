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
  // → Operational Manager approves. The workshop then opens the job card against the approved
  // request; job_id is that card, set when the workshop opens it (it used to be set by the approval).
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
  // A person's own level on a section switch, set on the People screen (access plan, Part 2). It
  // replaces their roles' level on that switch — more or less. No row: their roles decide.
  // user_permissions is defined below, keyed by `section`. main's lineage declared the same table
  // here keyed by `module`; both arrived in this merge and CREATE TABLE IF NOT EXISTS meant the
  // first one won silently, leaving the index on `section` to fail at boot. This branch keeps the
  // `section` spelling, so main's copy is gone rather than duplicated.
  // Capabilities — the individual actions a role may take (src/lib/capabilities.js). Keyed by role
  // NAME like role_permissions. Taking a capability away sets granted = 0 instead of deleting the
  // row, so the boot-time seed (INSERT OR IGNORE) can never quietly give it back.
  db.exec(`CREATE TABLE IF NOT EXISTS role_capabilities (
    role       TEXT NOT NULL,
    capability TEXT NOT NULL,
    granted    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (role, capability)
  );`);

  // MIGRATION, and it has to run before the table below is touched. Two lineages built this table:
  // one keyed by `module` with set_by/set_at, this one by `section` with updated_by/updated_at. On a
  // database the other one created, CREATE TABLE IF NOT EXISTS below does nothing (the table is
  // already there, with `module`), and then the index on `section` throws "no such column: section"
  // out of migrate() -- so the server does not start at all, and nobody can sign in. A fresh
  // database never shows it, which is every test, so it has to be caught here by looking at what is
  // actually on disk. The rows are a person's own access levels and are carried across, not dropped.
  const upExists = db.prepare(
    "SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'user_permissions'").get();
  if (upExists) {
    const cols = db.prepare('PRAGMA table_info(user_permissions)').all().map((c) => c.name);
    if (cols.includes('module') && !cols.includes('section')) {
      const hadSetBy = cols.includes('set_by');
      const hadSetAt = cols.includes('set_at');
      db.exec('BEGIN');
      try {
        db.exec(`CREATE TABLE user_permissions__new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          section    TEXT NOT NULL,
          level      TEXT NOT NULL DEFAULT 'none',
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_by INTEGER REFERENCES users(id),
          UNIQUE(user_id, section)
        );`);
        // Only rows whose person still exists. The old table put no foreign key on user_id and the
        // new one does, so a level left behind by a deleted account would fail the insert and roll
        // the whole migration back -- which would leave the server unable to start over a row that
        // means nothing anyway. Orphans are counted and reported rather than silently lost.
        const total = db.prepare('SELECT COUNT(*) c FROM user_permissions').get().c;
        db.exec(`INSERT OR IGNORE INTO user_permissions__new (user_id, section, level, updated_at, updated_by)
                 SELECT p.user_id, p.module, p.level,
                        ${hadSetAt ? 'p.set_at' : "datetime('now')"},
                        ${hadSetBy ? '(SELECT u.id FROM users u WHERE u.id = p.set_by)' : 'NULL'}
                   FROM user_permissions p
                  WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id);`);
        const moved = db.prepare('SELECT COUNT(*) c FROM user_permissions__new').get().c;
        if (moved < total) {
          console.log(`user_permissions: ${total - moved} level(s) belonged to accounts that no longer exist; not carried over.`);
        }
        db.exec('DROP TABLE user_permissions;');
        db.exec('ALTER TABLE user_permissions__new RENAME TO user_permissions;');
        db.exec('COMMIT');
        console.log(`user_permissions: re-keyed from module to section, ${moved} personal level(s) carried over.`);
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  // Person-by-person access overrides (WorkshopOne Plan Part B):
  // Every person can have their own 5-level clearance per section, and their own capability ticks.
  db.exec(`CREATE TABLE IF NOT EXISTS user_permissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    section    TEXT NOT NULL,
    level      TEXT NOT NULL DEFAULT 'none',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    UNIQUE(user_id, section)
  );
  CREATE INDEX IF NOT EXISTS idx_user_perms_user ON user_permissions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_perms_sec ON user_permissions(section);

  CREATE TABLE IF NOT EXISTS user_capabilities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    granted    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    UNIQUE(user_id, capability)
  );
  CREATE INDEX IF NOT EXISTS idx_user_caps_user ON user_capabilities(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_caps_cap ON user_capabilities(capability);`);

  // Roles become data an admin manages: a description, whether it shipped with the system, and
  // whether it is still in use (a retired role grants nothing, and is kept for the history).
  ensureColumn('roles', 'description', 'TEXT');
  ensureColumn('roles', 'is_system', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('roles', 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('roles', 'created_at', 'TEXT');
  ensureColumn('users', 'access_until', 'TEXT');
  ensureColumn('users', 'approval_limit', 'REAL');
  // Two-factor sign-in (src/lib/mfa.js). The keys are stored encrypted (src/lib/secretbox.js).
  ensureColumn('roles', 'require_mfa', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'mfa_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'mfa_secret', 'TEXT');
  ensureColumn('users', 'mfa_pending_secret', 'TEXT');
  ensureColumn('users', 'mfa_last_step', 'INTEGER');   // the last code's time step — a code works once
  ensureColumn('users', 'mfa_enabled_at', 'TEXT');
  ensureColumn('sessions', 'mfa_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('sessions', 'last_seen_at', 'TEXT');   // last real input (mouse/keys/touch), for the idle timeout
  db.exec(`CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mfa_rc_user ON mfa_recovery_codes(user_id);
  -- Between a right password and a right code: no session yet, only this short-lived token.
  CREATE TABLE IF NOT EXISTS auth_challenges (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip         TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
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
  // The oil balance the dashboard reads. It was only ever created by src/migrate/015, a one-off
  // data script run with `npm run migrate:real` — so a FRESH install never got it, and the very
  // first thing a new deployment loads, /api/dashboard/overview, answered 500 with
  // "no such column: stock_qty". Nobody hit it because every existing database had been through
  // 015 years ago. oil.js keeps the value in step on every ledger write, so starting at 0 is right.
  ensureColumn('products', 'stock_qty', 'REAL DEFAULT 0');

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

  // ---- buying what the workshop asked for ---------------------------------
  //
  // Two officers do the buying, one on the Head Office account and one locally, and the split is
  // per ITEM: a request can be part local and part head office, and an item one of them cannot
  // source has to be handed to the other. mrn_lines.purchase_source already carried that split;
  // what was missing was the state BETWEEN asking and receiving — "bought, invoice in hand, not
  // yet delivered".
  //
  // BOUGHT IS NOT RECEIVED, and these columns must never be mistaken for a receipt. stock_moves is
  // a projection rebuilt from grn, so anything here that added stock would be counted a second
  // time the moment the storekeeper posts the real GRN. The tick records the purchase; the GRN
  // stays the only thing that moves stock.
  ensureColumn('mrn_lines', 'purchased_at', 'TEXT');
  ensureColumn('mrn_lines', 'purchased_by', 'TEXT');
  ensureColumn('mrn_lines', 'supplier', 'TEXT');
  ensureColumn('mrn_lines', 'invoice_no', 'TEXT');
  ensureColumn('mrn_lines', 'invoice_date', 'TEXT');
  ensureColumn('mrn_lines', 'purchase_amount', 'REAL');
  // Why an item moved channel. The reason is the valuable part: a few months of "Head Office has
  // no account with this supplier" is the case for opening one.
  ensureColumn('mrn_lines', 'source_changed_at', 'TEXT');
  ensureColumn('mrn_lines', 'source_changed_by', 'TEXT');
  ensureColumn('mrn_lines', 'source_changed_reason', 'TEXT');
  ensureColumn('mrn_lines', 'source_changed_from', 'TEXT');

  // Dynamic workshop buying priority (P1_CRITICAL, P2_URGENT, P3_ROUTINE, P4_LOW) and daily notes
  ensureColumn('mrn_lines', 'buying_priority', "TEXT DEFAULT 'P3_ROUTINE'");
  ensureColumn('mrn_lines', 'priority_note', 'TEXT');
  ensureColumn('mrn_lines', 'priority_updated_at', 'TEXT');
  ensureColumn('mrn_lines', 'priority_updated_by', 'TEXT');

  db.exec(`CREATE TABLE IF NOT EXISTS mrn_line_priority_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_line_id   INTEGER NOT NULL REFERENCES mrn_lines(id) ON DELETE CASCADE,
    old_priority  TEXT,
    new_priority  TEXT NOT NULL,
    note          TEXT,
    changed_by    TEXT NOT NULL,
    changed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mrn_line_pri_hist ON mrn_line_priority_history(mrn_line_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mrn_lines_priority ON mrn_lines(buying_priority, purchased_at)');

  db.exec(`CREATE TABLE IF NOT EXISTS mrn_line_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_line_id INTEGER NOT NULL REFERENCES mrn_lines(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    image TEXT NOT NULL,
    note TEXT,
    uploaded_by INTEGER,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mrn_line_invoices_line ON mrn_line_invoices(mrn_line_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mrn_lines_purchase ON mrn_lines(purchase_source, purchased_at)');

  // "New since I last looked", per person. A status column could not do this: two officers sharing
  // one flag would clear each other's badge, and the answer to "what is new" differs by who is
  // asking. Generic on purpose — any screen can claim a key.
  db.exec(`CREATE TABLE IF NOT EXISTS user_seen_marks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  )`);

  // The two buying roles. seed.js only runs on a fresh install, so a role added there never
  // reaches a server that is already live — this is what puts them on the real machine.
  db.exec(`INSERT OR IGNORE INTO roles (name, label) VALUES
    ('purchase_head_office', 'Purchasing Officer — Head Office'),
    ('purchase_local', 'Purchasing Officer — Local')`);

  // ONE-TIME CORRECTION. The first cut of these two roles handed them read-only access to job
  // cards, stores, filters, projects and the fleet. seedDefaults() only INSERTs missing cells, so
  // fixing the policy in code does not fix a database that already has the wrong rows. This clears
  // them once, letting the corrected defaults seed in their place.
  //
  // Guarded by a marker rather than run every boot, because role_permissions is admin-editable and
  // a permanent overwrite would silently undo a deliberate change made from the Access screen.
  const purgeKey = 'purchasing_roles_scoped_v2';
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(purgeKey);
  if (!done) {
    db.exec(`DELETE FROM role_permissions WHERE role IN ('purchase_head_office', 'purchase_local')`);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now'))").run(purgeKey);
  }

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
  ensureColumn('job_approvals', 'signed_name', 'TEXT'); // e-signature snapshot / stand-in label
  ensureColumn('general_item_txns', 'source', 'TEXT'); // import source tag (idempotent re-import)
  // Consolidated MRN item catalogue (deduped from mrn_lines descriptions).
  ensureColumn('store_items', 'unit_cost', 'REAL DEFAULT 0');
  ensureColumn('store_items', 'item_no', 'TEXT');          // catalogue number, e.g. FIL-0001
  ensureColumn('store_items', 'catalogue_kind', 'TEXT');   // part | consumable | service
  ensureColumn('store_items', 'part_numbers', 'TEXT');     // all merged part/reference codes ( | -joined)
  ensureColumn('store_items', 'description', 'TEXT');
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
  // Partial close (docs/WORKSHOPONE_PLAN.md §A.2, W2): the work is finished and the vehicle has
  // left, but prices or records are still missing. The card keeps when and by whom it was partly
  // closed, and a new card for the vehicle points back to it through continues_job_id.
  ensureColumn('job_cards', 'partial_closed_at', 'TEXT');
  ensureColumn('job_cards', 'partial_closed_by', 'INTEGER REFERENCES users(id)');
  ensureColumn('job_cards', 'partial_note', 'TEXT');
  ensureColumn('job_cards', 'continues_job_id', 'INTEGER REFERENCES job_cards(id)');
  allowPartiallyClosed();
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
           CREATE INDEX IF NOT EXISTS idx_tb_reqline_asset ON tb_request_lines(asset_id);
           CREATE TABLE IF NOT EXISTS filter_stock (
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
           );
           CREATE INDEX IF NOT EXISTS idx_filter_stock_type ON filter_stock(filter_type);
           CREATE INDEX IF NOT EXISTS idx_filter_stock_part ON filter_stock(part_no);`);

  workshopsStage2();
  storesStage4();
  signoffsPerWorkshop();
  reportsPerWorkshop();
  fieldStage6();
  operationsStage7();
  storesCountsPart2();
  jobCardNeedsRequest();
  storesServicesPart3();
  storesUnitsPart4();
  storesDocumentsProcess();
  // After storesDocumentsProcess(), which is what adds mtn.status: on a database from before the
  // 4-document lifecycle the column does not exist yet, and reading it here stopped migrate()
  // dead — no column, no server, nobody can sign in.
  transferStockByStage();
  labourLifecycleProcess();
  toolsAndToolboxesProcess();
  ownRecordsStep2();
  ownRecordsStep2c();
  supplyRoutesAndPipeline();
  chainNumberAndShortDelivery();
  closureRulesAndUniversalTrace();

  // Seed the RBAC matrix once (safe to require here — db exports are already set).
  // Sections split off a shared switch start at that switch's level (access plan, Part 1) — before
  // the defaults, so a level an admin set on the old switch carries over rather than the default.
  try { require('../lib/permissions').splitSections(); } catch (e) { /* table may not exist yet on very first pass */ }
  try { require('../lib/permissions').seedDefaults(); } catch (e) { /* table may not exist yet on very first pass */ }
  // Seed the built-in roles' capabilities (idempotent) and mark those roles as shipped with the
  // system, so the Access screen can tell them apart from roles an admin created.
  {
    const caps = require('../lib/capabilities');
    caps.seedCapabilities();
    const names = [...caps.RESERVED_ROLE_NAMES];
    db.prepare(`UPDATE roles SET is_system = 1 WHERE is_system = 0 AND name IN (${names.map(() => '?').join(',')})`).run(...names);
    // The job title as the workshop says it: Transport Assistant Manager, not Assistant Transport
    // Manager. The role's KEY never changes — capabilities, the access matrix and every user_roles
    // row are keyed on assistant_transport_manager — only the words people read. A database the
    // old wording was seeded into keeps it otherwise, because the seed is INSERT OR IGNORE.
    // Matching on the old label makes this run once and never again, and leaves alone a label
    // somebody has since set themselves.
    db.prepare("UPDATE roles SET label = 'Transport Assistant Manager' WHERE name = 'assistant_transport_manager' AND label = 'Assistant Transport Manager'").run();
    // Opening a job card belongs to the workshop now (see jobCardNeedsRequest). Has to be here,
    // after seedCapabilities(): it is INSERT OR IGNORE, so revoking before it runs is undone.
    jobCardCreateToWorkshop();
  }
  // Improvement plan, Step 3a: who raised each request, and the seal of what was certified.
  requestRulesStep3a();
  return db;
}

// PARTIALLY_CLOSED joins the job_cards status CHECK. SQLite cannot change a CHECK constraint, so
// the table is rebuilt in place — the same way tb_specs was above: a copy with the widened
// constraint, every row copied with its id, the old table dropped and the copy renamed. Foreign
// keys are off during the swap, so the fifteen tables that point at job_cards keep pointing at the
// same ids. Its indexes are re-created from their own definitions and the id sequence is kept, so
// a deleted card's number is never handed out again. Detected by reading the constraint back:
// it runs once, on the first start after the update, and never again.
function allowPartiallyClosed() {
  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_cards'").get();
  if (!cur || /'PARTIALLY_CLOSED'/.test(cur.sql)) return;
  const list = /(CHECK\s*\(\s*status\s+IN\s*\()/i;
  if (!list.test(cur.sql)) return;                    // no status list at all: nothing to widen
  const widened = cur.sql
    .replace(/^CREATE TABLE (IF NOT EXISTS )?("?)job_cards\2/i, 'CREATE TABLE tmp_job_cards')
    .replace(list, "$1'PARTIALLY_CLOSED',");
  if (!/^CREATE TABLE tmp_job_cards/.test(widened)) throw new Error('job_cards: unexpected table definition — status not widened');
  const cols = db.prepare('PRAGMA table_info(job_cards)').all().map((c) => `"${c.name}"`).join(', ');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='job_cards' AND sql IS NOT NULL").all();
  const triggers = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='job_cards'").all();
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='job_cards'").get();
  // Old imported data may already hold a few dangling references; those are not this rebuild's to
  // judge. What it must never do is ADD one — so the references to job_cards are counted before
  // and after, and any difference undoes the whole swap.
  const dangling = () => db.prepare('PRAGMA foreign_key_check').all().filter((r) => r.parent === 'job_cards').length;
  const before = dangling();
  const count = db.prepare('SELECT COUNT(*) n FROM job_cards').get().n;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`${widened};
               INSERT INTO tmp_job_cards (${cols}) SELECT ${cols} FROM job_cards;
               DROP TABLE job_cards;
               ALTER TABLE tmp_job_cards RENAME TO job_cards;`);
      for (const x of [...indexes, ...triggers]) db.exec(x.sql);
      if (seq) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'job_cards'").run(seq.seq);
      if (db.prepare('SELECT COUNT(*) n FROM job_cards').get().n !== count || dangling() !== before) {
        throw new Error('job_cards rebuild did not keep every card and reference — not applied');
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// Multi-site Stage 2: every user, job card and request belongs to a workshop. The first start
// creates Central Workshop — Badalgama as the default and gives it everything that exists. New
// rows that arrive without a workshop take one from a trigger, so no insert path (imports, the
// container cards, tests) can leave a gap: a request takes its job card's workshop, anything else
// the default. A mechanic gets a starting row in mechanic_workshops the same way.
function workshopsStage2() {
  if (!db.prepare('SELECT 1 FROM workshops LIMIT 1').get()) {
    db.prepare("INSERT INTO workshops (code, name, place, is_default) VALUES ('CW', 'Central Workshop — Badalgama', 'Badalgama', 1)").run();
  }
  // Transfer notes name their two ends as free text; each end can now also point at a place from
  // the list ('w:<id>' a workshop, 'p:<id>' a project, 's:<id>' a site). The text stays as written.
  ensureColumn('users', 'workshop_id', 'INTEGER REFERENCES workshops(id)');
  ensureColumn('job_cards', 'workshop_id', 'INTEGER REFERENCES workshops(id)');
  ensureColumn('mrn', 'workshop_id', 'INTEGER REFERENCES workshops(id)');
  ensureColumn('mtn', 'from_place', 'TEXT');
  ensureColumn('mtn', 'to_place', 'TEXT');
  ensureColumn('mtn_lines', 'from_place', 'TEXT');
  ensureColumn('mtn_lines', 'to_place', 'TEXT');
  const DEF = "(SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)";
  db.exec(`
    UPDATE users SET workshop_id = ${DEF} WHERE workshop_id IS NULL;
    UPDATE job_cards SET workshop_id = ${DEF} WHERE workshop_id IS NULL;
    UPDATE mrn SET workshop_id = COALESCE((SELECT j.workshop_id FROM job_cards j WHERE j.id = mrn.job_id), ${DEF})
     WHERE workshop_id IS NULL;
    INSERT INTO mechanic_workshops (mechanic_id, workshop_id, from_date)
      SELECT m.id, ${DEF}, '2000-01-01' FROM mechanics m
       WHERE NOT EXISTS (SELECT 1 FROM mechanic_workshops mw WHERE mw.mechanic_id = m.id);
    CREATE INDEX IF NOT EXISTS idx_jobs_workshop ON job_cards(workshop_id);
    CREATE INDEX IF NOT EXISTS idx_mrn_workshop ON mrn(workshop_id);
    CREATE TRIGGER IF NOT EXISTS trg_users_workshop AFTER INSERT ON users WHEN NEW.workshop_id IS NULL
    BEGIN UPDATE users SET workshop_id = ${DEF} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_job_cards_workshop AFTER INSERT ON job_cards WHEN NEW.workshop_id IS NULL
    BEGIN UPDATE job_cards SET workshop_id = ${DEF} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_mrn_workshop AFTER INSERT ON mrn WHEN NEW.workshop_id IS NULL
    BEGIN UPDATE mrn SET workshop_id = COALESCE((SELECT j.workshop_id FROM job_cards j WHERE j.id = NEW.job_id), ${DEF})
           WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_mechanics_workshop AFTER INSERT ON mechanics
    BEGIN INSERT OR IGNORE INTO mechanic_workshops (mechanic_id, workshop_id, from_date) VALUES (NEW.id, ${DEF}, '2000-01-01'); END;`);
  // Job requests (Stage 3): the workshop they are for — the card they became, else the raiser's.
  ensureColumn('job_requests', 'workshop_id', 'INTEGER REFERENCES workshops(id)');
  db.exec(`
    UPDATE job_requests SET workshop_id = COALESCE(
        (SELECT j.workshop_id FROM job_cards j WHERE j.id = job_requests.job_id),
        (SELECT u.workshop_id FROM users u WHERE u.id = job_requests.requested_by_user), ${DEF})
     WHERE workshop_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_jr_workshop ON job_requests(workshop_id);
    CREATE TRIGGER IF NOT EXISTS trg_job_requests_workshop AFTER INSERT ON job_requests WHEN NEW.workshop_id IS NULL
    BEGIN UPDATE job_requests SET workshop_id = COALESCE((SELECT u.workshop_id FROM users u WHERE u.id = NEW.requested_by_user), ${DEF})
           WHERE id = NEW.id; END;`);
  // The transfer notes already written: link each end to the place its text clearly names. Once.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'mtn_places_matched'").get()) {
    const r = require('../lib/places').matchOldTransfers();
    db.prepare("INSERT INTO settings (key, value) VALUES ('mtn_places_matched', ?)").run(JSON.stringify({ at: new Date().toISOString(), ...r }));
  }
}

// Stage 4, part B: a store per workshop (src/lib/stores.js). A workshop has its own store or uses
// another's; the main one always has its own, and everything recorded until now is in it. Each
// source of stock movements carries the store it happened in, stamped when the row is written (the
// triggers below — a route that knows better writes store_id itself), so rebuilding stock_moves
// keeps it. A transfer note's items carry the two stores they move between (set by the route).
function storesStage4() {
  ensureColumn('workshops', 'own_store', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('workshops', 'uses_store', 'INTEGER REFERENCES workshops(id)');
  ensureColumn('workshops', 'store_opened', 'TEXT');
  db.exec('UPDATE workshops SET own_store = 1 WHERE is_default = 1 AND own_store = 0');
  const DEF = "(SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)";
  const tables = ['grn', 'issues', 'general_item_txns', 'stock_ledger', 'tyre_battery_issues', 'service_jobs', 'stock_moves'];
  for (const t of tables) {
    ensureColumn(t, 'store_id', 'INTEGER REFERENCES workshops(id)');
    db.exec(`UPDATE ${t} SET store_id = ${DEF} WHERE store_id IS NULL`);
  }
  ensureColumn('mtn_lines', 'from_store_id', 'INTEGER REFERENCES workshops(id)');
  ensureColumn('mtn_lines', 'to_store_id', 'INTEGER REFERENCES workshops(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sm_store ON stock_moves(store_id, section, item_key)');

  const { storeSql } = require('../lib/stores');
  const jobWs = (jobCol) => `(SELECT j.workshop_id FROM job_cards j WHERE j.id = NEW.${jobCol})`;
  const day = (col) => `date(COALESCE(NULLIF(NEW.${col}, ''), 'now'))`;
  const stamp = {
    // Received goods: the store of the request's workshop.
    grn: storeSql(`SELECT m.workshop_id FROM mrn m WHERE m.id = COALESCE(NEW.mrn_id,
                     (SELECT ml.mrn_id FROM mrn_lines ml WHERE ml.id = NEW.mrn_line_id))`, day('delivery_date')),
    // A received line handed over leaves the store that received it; anything else, the job's.
    issues: `COALESCE((SELECT g.store_id FROM grn g WHERE g.id = NEW.grn_id), ${storeSql(jobWs('job_id'), day('issue_date'))})`,
    general_item_txns: storeSql(jobWs('job_id'), day('txn_date')),
    stock_ledger: storeSql(jobWs('job_id'), day('txn_date')),
    tyre_battery_issues: storeSql(`COALESCE(${jobWs('job_id')},
                     (SELECT m.workshop_id FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id WHERE ml.id = NEW.mrn_line_id))`, day('issue_date')),
    service_jobs: storeSql('SELECT j.workshop_id FROM job_cards j WHERE j.job_no = NEW.job_no ORDER BY j.id DESC LIMIT 1', day('service_date')),
  };
  for (const [t, expr] of Object.entries(stamp)) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${t}_store AFTER INSERT ON ${t} WHEN NEW.store_id IS NULL
             BEGIN UPDATE ${t} SET store_id = ${expr} WHERE id = NEW.id; END;`);
  }
}

// A TRANSFER MOVES THE SHELF WHEN THE GOODS MOVE: out of the sending store once the note is
// dispatched, into the receiving store once it is accepted (src/lib/stock.js transfers). It used
// to happen the moment the note was typed, whatever its status, and rejecting a note never put
// the stock back — so the movements on an existing database have to be squared with the rule.
//
// THE SHELVES DO NOT CHANGE ON UPGRADE. A note that is already counted on the shelves and never
// got past the typing stage is marked accepted, which is what it is: every transfer in the book
// happened, and every imported one reads as 'draft' only because the importers never set a
// status and the column defaults to it. The figures therefore come out of the update as they
// went in. What does change is the two cases the old code had wrong — a note still waiting to
// be dispatched, and a rejected one — whose goods go back on the shelf they never left.
//
// Runs once, on the first start after the update, and never again (the settings key).
function transferStockByStage() {
  if (db.prepare("SELECT 1 x FROM settings WHERE key = 'mtn_stock_at_dispatch'").get()) return;
  const counted = `SELECT l.id FROM mtn_lines l JOIN mtn t ON t.id = l.mtn_id`;
  const rep = db.transaction(() => ({
    // Already on the shelves, never dispatched on paper: that is a completed transfer.
    accepted: db.prepare(`UPDATE mtn SET status = 'accepted'
       WHERE COALESCE(status, 'draft') IN ('draft', 'pending_approval')
         AND id IN (SELECT l.mtn_id FROM mtn_lines l
                     JOIN stock_moves sm ON sm.source_table = 'mtn_lines' AND sm.source_id = l.id)`).run().changes,
    // Movements the rule would never have written: the note is not dispatched, or was rejected.
    returned: db.prepare(`DELETE FROM stock_moves WHERE source_table = 'mtn_lines'
         AND source_id IN (${counted} WHERE COALESCE(t.status, '') NOT IN ('dispatched', 'received', 'accepted'))`).run().changes,
    // In transit: gone from the sending store, not yet taken in by the receiving one.
    in_transit: db.prepare(`DELETE FROM stock_moves WHERE source_table = 'mtn_lines' AND kind = 'in'
         AND source_id IN (${counted} WHERE t.status IN ('dispatched', 'received'))`).run().changes,
  }))();
  db.prepare("INSERT INTO settings (key, value) VALUES ('mtn_stock_at_dispatch', ?)")
    .run(JSON.stringify({ at: new Date().toISOString(), ...rep }));
  if (rep.accepted || rep.returned || rep.in_transit) {
    console.log(`mtn: stock now follows the stage — ${rep.accepted} completed transfer(s) marked accepted `
      + `(the shelves keep what they hold), ${rep.returned} movement(s) of notes not yet dispatched or rejected `
      + `put back, ${rep.in_transit} arrival(s) held until the goods are accepted.`);
  }
}

// Stage 4: a day is signed off per workshop once the workshops are kept apart. workday_signoffs was
// made with work_date UNIQUE, which SQLite cannot change in place — so the table is rebuilt once,
// every row kept as a whole-company sign-off (workshop_id 0, which is what it was).
function signoffsPerWorkshop() {
  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workday_signoffs'").get();
  if (!cur || /workshop_id/.test(cur.sql)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE workday_signoffs_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date     TEXT NOT NULL,
        workshop_id   INTEGER NOT NULL DEFAULT 0,
        signed_by     INTEGER REFERENCES users(id),
        signed_at     TEXT,
        unlocked_by   INTEGER REFERENCES users(id),
        unlocked_at   TEXT,
        unlock_reason TEXT,
        UNIQUE (work_date, workshop_id)
      );
      INSERT INTO workday_signoffs_new (id, work_date, workshop_id, signed_by, signed_at, unlocked_by, unlocked_at, unlock_reason)
        SELECT id, work_date, 0, signed_by, signed_at, unlocked_by, unlocked_at, unlock_reason FROM workday_signoffs;
      DROP TABLE workday_signoffs;
      ALTER TABLE workday_signoffs_new RENAME TO workday_signoffs;`);
  })();
}

// Stage 5: reports per workshop. The saved daily reports were keyed UNIQUE(kind, report_date) —
// rebuilt once keyed by (kind, report_date, workshop_id), every saved day kept as the whole
// company's (workshop 0, which is what it was). The monthly report inputs (fuel, salaries,
// overheads, the pending list, outside prices) each belong to a workshop; the ones already
// entered are the main workshop's.
function reportsPerWorkshop() {
  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_report_snapshots'").get();
  if (cur && !/workshop_id/.test(cur.sql)) {
    db.transaction(() => {
      db.exec(`
        DROP INDEX IF EXISTS idx_daily_snap;
        CREATE TABLE daily_report_snapshots_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          kind         TEXT NOT NULL,
          report_date  TEXT NOT NULL,
          workshop_id  INTEGER NOT NULL DEFAULT 0,
          generated_at TEXT NOT NULL DEFAULT (datetime('now')),
          generated_by INTEGER REFERENCES users(id),
          row_count    INTEGER NOT NULL DEFAULT 0,
          payload      TEXT NOT NULL,
          UNIQUE(kind, report_date, workshop_id)
        );
        INSERT INTO daily_report_snapshots_new (id, kind, report_date, workshop_id, generated_at, generated_by, row_count, payload)
          SELECT id, kind, report_date, 0, generated_at, generated_by, row_count, payload FROM daily_report_snapshots;
        DROP TABLE daily_report_snapshots;
        ALTER TABLE daily_report_snapshots_new RENAME TO daily_report_snapshots;
        CREATE INDEX IF NOT EXISTS idx_daily_snap ON daily_report_snapshots(kind, workshop_id, report_date DESC);`);
    })();
  }
  ensureColumn('monthly_report_inputs', 'workshop_id', 'INTEGER REFERENCES workshops(id)');
  db.exec(`UPDATE monthly_report_inputs SET workshop_id = (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)
            WHERE workshop_id IS NULL;
           CREATE INDEX IF NOT EXISTS idx_mri_ws ON monthly_report_inputs(year, month, sheet, workshop_id);
           CREATE TRIGGER IF NOT EXISTS trg_mri_workshop AFTER INSERT ON monthly_report_inputs WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE monthly_report_inputs SET workshop_id = (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)
                  WHERE id = NEW.id; END;`);
}

// Stage 6: field work — a repair done at a site, not in the workshop (src/lib/field.js). A job card
// says whether it is in the field and where, whether it began as a breakdown, and the times that
// give the response time and the downtime; km driven by the field vehicle are charged at the rate in
// force when they were entered. A daily-work line can be travel. Nothing existing changes: every
// card is a workshop card until someone says otherwise.
function fieldStage6() {
  ensureColumn('job_cards', 'field', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('job_cards', 'field_place', 'TEXT');          // 'p:<id>' a project or 's:<id>' a site
  ensureColumn('job_cards', 'field_location', 'TEXT');       // the place as written
  ensureColumn('job_cards', 'breakdown', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('job_cards', 'reported_at', 'TEXT');          // YYYY-MM-DD HH:MM
  ensureColumn('job_cards', 'arrived_at', 'TEXT');
  ensureColumn('job_cards', 'working_at', 'TEXT');
  ensureColumn('job_cards', 'field_km', 'REAL');
  ensureColumn('job_cards', 'field_km_rate', 'REAL');
  ensureColumn('job_daily_work', 'travel', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_field ON job_cards(field, status)');
  allowReturnParts();
}

// A job card is opened by the workshop, against an approved job request, and carries a pointer back
// to it. The approval used to make the card itself, so every card made that way is already linked —
// the other way round, through job_requests.job_id. Both pointers are kept from here on (the routes
// write them in one transaction); this backfills the new one from the old.
//
// There is deliberately NO NOT NULL and no trigger. The rule that a card needs a request is a CHECK
// THE ROUTE MAKES, because four insert paths legitimately have no request and must keep working:
// a breakdown reported at a site (src/lib/field.js), the continuation card at partial close
// (src/lib/job_close.js — it inherits the parent's request), the GENERAL-WS and monthly labour
// container cards, and imported history.
function jobCardNeedsRequest() {
  ensureColumn('job_cards', 'job_request_id', 'INTEGER REFERENCES job_requests(id)');
  db.exec(`
    UPDATE job_cards SET job_request_id = (SELECT r.id FROM job_requests r WHERE r.job_id = job_cards.id)
     WHERE job_request_id IS NULL
       AND EXISTS (SELECT 1 FROM job_requests r WHERE r.job_id = job_cards.id);
    CREATE INDEX IF NOT EXISTS idx_jobs_job_request ON job_cards(job_request_id);`);
}

// jobs.create changes hands: the Transport Manager raised cards directly, and no longer does — the
// workshop opens them from an approved request. Taking it out of the capability TEMPLATE
// (src/lib/capabilities.js) does not move it on a database that has already been seeded: the row
// (transport_manager, jobs.create, 1) is there, and seedCapabilities() only ever INSERTs OR IGNOREs.
// So it is revoked here, by hand, ONCE — guarded by a settings key, so an admin who decides to give
// it back is not overruled on the next start.
//
// Any OTHER role holding it is left exactly as it is and reported instead: a role an admin made and
// granted this to is their decision, not this migration's.
function jobCardCreateToWorkshop() {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'jobs_create_to_workshop'").get()) return;
  const held = db.prepare("SELECT role FROM role_capabilities WHERE capability = 'jobs.create' AND granted = 1").all()
    .map((r) => r.role);
  const moved = db.prepare("UPDATE role_capabilities SET granted = 0, updated_at = datetime('now') WHERE role = 'transport_manager' AND capability = 'jobs.create' AND granted = 1").run().changes;
  // The other half of the same move: the workshop opens cards from approved requests, so it must be
  // able to READ job requests — it was 'none'. seedDefaults() is INSERT OR IGNORE too, so the level
  // on an already-seeded database is lifted here. Only from 'none': a level an admin has already
  // raised is theirs, and is not pushed back down.
  const seen = db.prepare("UPDATE role_permissions SET level = 'view' WHERE role = 'workshop' AND module = 'jobrequests' AND level = 'none'").run().changes;
  const others = held.filter((r) => r !== 'transport_manager' && r !== 'workshop');
  db.prepare("INSERT INTO settings (key, value) VALUES ('jobs_create_to_workshop', ?)")
    .run(JSON.stringify({ at: new Date().toISOString(), revoked_from_transport_manager: moved, workshop_sees_requests: seen, left_alone: others }));
  if (moved) console.log('jobs: opening a job card is the workshop\'s now — taken off the Transport Manager.');
  if (seen) console.log('jobs: the workshop can now see job requests (it needs to, to open cards from them).');
  if (others.length) {
    console.log(`jobs: these roles also open job cards and were left as they are: ${others.join(', ')}. `
      + 'They now need an approved job request like everyone else (Access Control -> Roles to change it).');
  }
}

// Stage 7: a machine can stand at a site of a project, not only at the project (src/lib/operations.js).
function operationsStage7() {
  ensureColumn('assets', 'current_site_id', 'INTEGER REFERENCES sites(id)');
}

// Stores plan, Part 2: a correction posted by an approved count session says which one it came from.
function storesCountsPart2() {
  ensureColumn('store_counts', 'session_id', 'INTEGER REFERENCES count_sessions(id)');
}

// Stores plan, Part 3: a service that fitted an equivalent filter keeps the vehicle's own number too
// (ST-D15). filter_no stays what was fitted — that is what comes off the shelf.
function storesServicesPart3() {
  ensureColumn('service_filters', 'required_no', 'TEXT');
  ensureColumn('service_filters', 'required_no_norm', 'TEXT');
}

// Stores plan, Part 4: a tyre or battery issued is a unit with a serial number (src/lib/tb_units.js):
// the issue names the unit it fitted and the unit that came off; a battery knows its store.
function storesUnitsPart4() {
  ensureColumn('tyre_battery_issues', 'unit_id', 'INTEGER');       // tyres.id or batteries.id, by kind
  ensureColumn('tyre_battery_issues', 'old_unit_id', 'INTEGER');   // the one taken off, when known
  ensureColumn('batteries', 'store_id', 'INTEGER REFERENCES workshops(id)');
  ensureColumn('batteries', 'spec_id', 'INTEGER REFERENCES tb_specs(id)');
  // A tyre or battery received or issued on a request is filed under its specification since
  // Part 4 (src/lib/stock.js), so its receipt and its issue meet on one shelf. The ones already
  // on the books are moved there once, here, rather than waiting for someone to rebuild stock.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'stock_tb_by_spec'").get()) {
    const grn = db.prepare('SELECT g.id FROM grn g JOIN tb_request_lines r ON r.mrn_line_id = g.mrn_line_id WHERE r.spec_id IS NOT NULL').all().map((r) => r.id);
    const issues = db.prepare('SELECT id FROM tyre_battery_issues WHERE spec_id IS NOT NULL').all().map((r) => r.id);
    if (grn.length || issues.length) require('../lib/stock').sync({ grn, tyre_battery_issues: issues });
    db.prepare("INSERT INTO settings (key, value) VALUES ('stock_tb_by_spec', ?)").run(JSON.stringify({ at: new Date().toISOString(), grn: grn.length, issues: issues.length }));
  }
}

// Improvement plan, Step 2: a service record and a tool belong to a workshop, like a job card, so a
// workshop kept apart sees only its own (src/lib/scope.js).
//   - a service record: its job card's workshop; with no card, the store it drew from (a store is
//     known by the workshop that owns it) — the rule the Stage 5 reports already used — else the
//     main workshop. The route writes it on every new record; the trigger covers anything else.
//   - a tool: the workshop it was entered for; a mechanic's toolbox without one, the mechanic's
//     workshop; else the main workshop.
// Nothing moves for anyone while the workshops are not kept apart.
// Improvement plan, Step 2c: an issue note and a transfer note belong to a workshop too. The routes
// write it (the card's workshop, else the writer's); what has none takes it by the same rule.
function ownRecordsStep2c() {
  const DEF = '(SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)';
  // An issue note: its job card's workshop, else the main one's.
  const minWs = (n) => `COALESCE((SELECT j.workshop_id FROM job_cards j WHERE j.id = ${n}.job_id), ${DEF})`;
  db.exec(`UPDATE min_notes SET workshop_id = ${minWs('min_notes')} WHERE workshop_id IS NULL;
           CREATE TRIGGER IF NOT EXISTS trg_min_notes_ws AFTER INSERT ON min_notes WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE min_notes SET workshop_id = ${minWs('NEW')} WHERE id = NEW.id; END;`);
  // A transfer note: the workshop it is sent from, else the one it goes to, else the main one's.
  ensureColumn('mtn', 'workshop_id', 'INTEGER REFERENCES workshops(id)');
  const placeWs = (col) => `(SELECT w.id FROM workshops w WHERE ${col} = 'w:' || w.id)`;
  const mtnWs = (t) => `COALESCE(${placeWs(`${t}.from_place`)}, ${placeWs(`${t}.to_place`)}, ${DEF})`;
  db.exec(`UPDATE mtn SET workshop_id = ${mtnWs('mtn')} WHERE workshop_id IS NULL;
           CREATE INDEX IF NOT EXISTS idx_mtn_ws ON mtn(workshop_id);
           CREATE TRIGGER IF NOT EXISTS trg_mtn_ws AFTER INSERT ON mtn WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE mtn SET workshop_id = ${mtnWs('NEW')} WHERE id = NEW.id; END;`);
}

function ownRecordsStep2() {
  const DEF = '(SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)';
  const jobWs = (s) => `(SELECT j.workshop_id FROM job_cards j WHERE j.job_no = ${s}.job_no AND COALESCE(${s}.job_no, '') <> '' ORDER BY j.id DESC LIMIT 1)`;
  ensureColumn('service_jobs', 'workshop_id', 'INTEGER REFERENCES workshops(id)');
  db.exec(`UPDATE service_jobs SET workshop_id = COALESCE(${jobWs('service_jobs')}, store_id, ${DEF}) WHERE workshop_id IS NULL;
           CREATE INDEX IF NOT EXISTS idx_service_jobs_ws ON service_jobs(workshop_id);
           CREATE TRIGGER IF NOT EXISTS trg_service_jobs_ws AFTER INSERT ON service_jobs WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE service_jobs SET workshop_id = COALESCE(${jobWs('NEW')}, NEW.store_id, ${DEF}) WHERE id = NEW.id; END;`);

  const mechWs = require('../lib/workshops').mechanicWorkshopSql('m');
  const toolWs = (t) => `COALESCE((SELECT ${mechWs} FROM mechanics m WHERE m.id = ${t}.mechanic_id), ${DEF})`;
  db.exec(`UPDATE workshop_tools SET workshop_id = ${toolWs('workshop_tools')} WHERE workshop_id IS NULL;
           CREATE INDEX IF NOT EXISTS idx_tools_ws ON workshop_tools(workshop_id);
           CREATE TRIGGER IF NOT EXISTS trg_tools_ws AFTER INSERT ON workshop_tools WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE workshop_tools SET workshop_id = ${toolWs('NEW')} WHERE id = NEW.id; END;`);
}

// 4-Document Store Lifecycle (MRN, GRN, MIN, MTN) with multi-stage signoffs and PDF support.
function storesDocumentsProcess() {
  // Safe migration of grn_vouchers and min_notes status constraints
  db.pragma('foreign_keys = OFF');
  try {
    const gCur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='grn_vouchers'").get();
    if (gCur && !/'pending_approval'/.test(gCur.sql)) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS grn_vouchers_new (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          grn_no           TEXT NOT NULL UNIQUE,
          received_date    TEXT NOT NULL DEFAULT (date('now')),
          supplier         TEXT,
          project_site     TEXT,
          po_no            TEXT,
          invoice_no       TEXT,
          delivery_note_no TEXT,
          bin_card_page    TEXT,
          prepared_by      TEXT,
          prepared_sig     TEXT,
          prepared_at      TEXT,
          prepared_designation TEXT,
          approved_by      TEXT,
          approved_sig     TEXT,
          approved_at      TEXT,
          approved_designation TEXT,
          status           TEXT NOT NULL DEFAULT 'pending_approval',
          rejection_reason TEXT,
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO grn_vouchers_new (id, grn_no, received_date, supplier, project_site, po_no, invoice_no, delivery_note_no, bin_card_page, prepared_by, prepared_sig, prepared_at, approved_by, approved_sig, approved_at, status, created_at)
          SELECT id, grn_no, received_date, supplier, project_site, po_no, invoice_no, delivery_note_no, bin_card_page, prepared_by, prepared_sig, prepared_at, approved_by, approved_sig, approved_at, status, created_at FROM grn_vouchers;
        DROP TABLE grn_vouchers;
        ALTER TABLE grn_vouchers_new RENAME TO grn_vouchers;
        CREATE INDEX IF NOT EXISTS idx_grn_vouchers_no ON grn_vouchers(grn_no);
      `);
    }

    const mCur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='min_notes'").get();
    if (mCur && !/'pending_approval'/.test(mCur.sql)) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS min_notes_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          min_no        TEXT NOT NULL UNIQUE,
          issue_date    TEXT NOT NULL DEFAULT (date('now')),
          project_id    INTEGER REFERENCES projects(id),
          asset_id      INTEGER REFERENCES assets(id),
          job_id        INTEGER REFERENCES job_cards(id),
          workshop_id   INTEGER REFERENCES workshops(id),
          purpose       TEXT,
          requested_by  TEXT,
          requested_sig TEXT,
          requested_at  TEXT,
          requested_designation TEXT,
          approved_by   TEXT,
          approved_sig  TEXT,
          approved_at   TEXT,
          approved_designation TEXT,
          received_by   TEXT,
          received_sig  TEXT,
          received_at   TEXT,
          received_designation TEXT,
          status        TEXT NOT NULL DEFAULT 'requested',
          rejection_reason TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO min_notes_new (id, min_no, issue_date, project_id, asset_id, job_id, workshop_id, purpose, requested_by, requested_sig, requested_at, approved_by, approved_sig, approved_at, received_by, received_sig, received_at, status, created_at)
          SELECT id, min_no, issue_date, project_id, asset_id, job_id, workshop_id, purpose, requested_by, requested_sig, requested_at, approved_by, approved_sig, approved_at, received_by, received_sig, received_at, status, created_at FROM min_notes;
        DROP TABLE min_notes;
        ALTER TABLE min_notes_new RENAME TO min_notes;
        CREATE INDEX IF NOT EXISTS idx_min_notes_no ON min_notes(min_no);
        CREATE INDEX IF NOT EXISTS idx_min_notes_job ON min_notes(job_id);
        CREATE INDEX IF NOT EXISTS idx_min_notes_asset ON min_notes(asset_id);
      `);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }

  // 1. Material Issue Notes (MIN) — Doc. No. EC1.ST.FO.04
  db.exec(`CREATE TABLE IF NOT EXISTS min_notes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    min_no        TEXT NOT NULL UNIQUE,
    issue_date    TEXT NOT NULL DEFAULT (date('now')),
    project_id    INTEGER REFERENCES projects(id),
    asset_id      INTEGER REFERENCES assets(id),
    job_id        INTEGER REFERENCES job_cards(id),
    workshop_id   INTEGER REFERENCES workshops(id),
    purpose       TEXT,
    requested_by  TEXT,
    requested_sig TEXT,
    requested_at  TEXT,
    requested_designation TEXT,
    approved_by   TEXT,
    approved_sig  TEXT,
    approved_at   TEXT,
    approved_designation TEXT,
    received_by   TEXT,
    received_sig  TEXT,
    received_at   TEXT,
    received_designation TEXT,
    status        TEXT NOT NULL DEFAULT 'requested',
    rejection_reason TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_min_notes_no ON min_notes(min_no);
  CREATE INDEX IF NOT EXISTS idx_min_notes_job ON min_notes(job_id);
  CREATE INDEX IF NOT EXISTS idx_min_notes_asset ON min_notes(asset_id);`);

  ensureColumn('issues', 'min_id', 'INTEGER REFERENCES min_notes(id)');
  ensureColumn('issues', 'min_no', 'TEXT');
  ensureColumn('issues', 'purpose', 'TEXT');
  ensureColumn('issues', 'unit', "TEXT DEFAULT 'nos'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_min_id ON issues(min_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_min_no ON issues(min_no)');

  // 2. Goods Received Notes (GRN) — Doc. No. EC1.ST.FO.2:5:21.12
  db.exec(`CREATE TABLE IF NOT EXISTS grn_vouchers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    grn_no           TEXT NOT NULL UNIQUE,
    received_date    TEXT NOT NULL DEFAULT (date('now')),
    supplier         TEXT,
    project_site     TEXT,
    po_no            TEXT,
    invoice_no       TEXT,
    delivery_note_no TEXT,
    bin_card_page    TEXT,
    prepared_by      TEXT,
    prepared_sig     TEXT,
    prepared_at      TEXT,
    prepared_designation TEXT,
    approved_by      TEXT,
    approved_sig     TEXT,
    approved_at      TEXT,
    approved_designation TEXT,
    status           TEXT NOT NULL DEFAULT 'pending_approval',
    rejection_reason TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_grn_vouchers_no ON grn_vouchers(grn_no);`);

  ensureColumn('grn', 'voucher_id', 'INTEGER REFERENCES grn_vouchers(id)');
  ensureColumn('grn', 'po_no', 'TEXT');
  ensureColumn('grn', 'delivery_note_no', 'TEXT');
  ensureColumn('grn', 'bin_card_page', 'TEXT');
  ensureColumn('grn', 'prepared_by', 'TEXT');
  ensureColumn('grn', 'prepared_sig', 'TEXT');
  ensureColumn('grn', 'prepared_at', 'TEXT');
  ensureColumn('grn', 'approved_by', 'TEXT');
  ensureColumn('grn', 'approved_sig', 'TEXT');
  ensureColumn('grn', 'approved_at', 'TEXT');
  ensureColumn('grn', 'unit', "TEXT DEFAULT 'nos'");
  ensureColumn('grn', 'status', "TEXT DEFAULT 'received'");
  ensureColumn('grn', 'rejection_reason', 'TEXT');
  ensureColumn('grn', 'project_site', 'TEXT');

  // 3. Materials / Goods Transfer Notes (MTN) — Doc. No. EC1.ST.FO.05
  ensureColumn('mtn', 'mr_no', 'TEXT');
  ensureColumn('mtn', 'prepared_by', 'TEXT');
  ensureColumn('mtn', 'prepared_sig', 'TEXT');
  ensureColumn('mtn', 'prepared_at', 'TEXT');
  ensureColumn('mtn', 'prepared_designation', 'TEXT');
  ensureColumn('mtn', 'approved_by', 'TEXT');
  ensureColumn('mtn', 'approved_sig', 'TEXT');
  ensureColumn('mtn', 'approved_at', 'TEXT');
  ensureColumn('mtn', 'approved_designation', 'TEXT');
  ensureColumn('mtn', 'received_by', 'TEXT');
  ensureColumn('mtn', 'received_sig', 'TEXT');
  ensureColumn('mtn', 'received_at', 'TEXT');
  ensureColumn('mtn', 'received_designation', 'TEXT');
  ensureColumn('mtn', 'accepted_by', 'TEXT');
  ensureColumn('mtn', 'accepted_sig', 'TEXT');
  ensureColumn('mtn', 'accepted_at', 'TEXT');
  ensureColumn('mtn', 'accepted_designation', 'TEXT');
  ensureColumn('mtn', 'status', "TEXT DEFAULT 'draft'");
  ensureColumn('mtn', 'rejection_reason', 'TEXT');
  ensureColumn('mtn_lines', 'value', 'REAL DEFAULT 0');
  ensureColumn('mtn_lines', 'mr_no', 'TEXT');
  ensureColumn('mtn_lines', 'remarks', 'TEXT');

  // 4. MRN signatures (requested, certified, approved)
  ensureColumn('mrn', 'requested_sig', 'TEXT');
  ensureColumn('mrn', 'certified_sig', 'TEXT');
  ensureColumn('mrn', 'approved_sig', 'TEXT');

  // 5. Approval Trails for GRN, MIN, and MTN (parity with mrn_approvals)
  db.exec(`CREATE TABLE IF NOT EXISTS grn_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id  INTEGER NOT NULL,
    stage       TEXT NOT NULL,          -- 'prepare' | 'approve'
    role        TEXT,
    approver_id INTEGER REFERENCES users(id),
    signed_name TEXT,
    signature   TEXT,
    decision    TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_grn_approvals_voucher ON grn_approvals(voucher_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS min_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    min_id      INTEGER NOT NULL,
    stage       TEXT NOT NULL,          -- 'request' | 'approve' | 'receive'
    role        TEXT,
    approver_id INTEGER REFERENCES users(id),
    signed_name TEXT,
    signature   TEXT,
    decision    TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_min_approvals_min ON min_approvals(min_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS mtn_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mtn_id      INTEGER NOT NULL REFERENCES mtn(id) ON DELETE CASCADE,
    stage       TEXT NOT NULL,          -- 'prepare' | 'approve' | 'dispatch' | 'accept'
    role        TEXT,
    approver_id INTEGER REFERENCES users(id),
    signed_name TEXT,
    signature   TEXT,
    decision    TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mtn_approvals_mtn ON mtn_approvals(mtn_id);`);
}

// Labour Lifecycle: track active, resigned, and transferred statuses with departure dates.
function labourLifecycleProcess() {
  ensureColumn('mechanics', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn('mechanics', 'left_date', 'TEXT');
  ensureColumn('mechanics', 'left_reason', 'TEXT');
  ensureColumn('mechanics', 'notes', 'TEXT');

  db.exec("UPDATE mechanics SET status = 'resigned' WHERE active = 0 AND status = 'active';");
}

// Workshop Tools, Mechanic Toolboxes, Daily Store Issues & Scrap Workflow
function toolsAndToolboxesProcess() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workshop_tools (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_code           TEXT UNIQUE NOT NULL,
      name                TEXT NOT NULL,
      category            TEXT NOT NULL DEFAULT 'hand_tool',
      type                TEXT NOT NULL DEFAULT 'common',
      mechanic_id         INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
      mechanic_name       TEXT,
      toolbox_name        TEXT,
      brand               TEXT,
      model_no            TEXT,
      serial_no           TEXT,
      specifications      TEXT,
      workshop_id         INTEGER REFERENCES workshops(id) ON DELETE SET NULL,
      store_id            INTEGER,
      location            TEXT,
      purchase_date       TEXT,
      purchase_cost       REAL DEFAULT 0,
      replacement_cost    REAL DEFAULT 0,
      condition           TEXT NOT NULL DEFAULT 'good',
      status              TEXT NOT NULL DEFAULT 'in_store',
      active              INTEGER NOT NULL DEFAULT 1,
      notes               TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tools_type ON workshop_tools(type, active);
    CREATE INDEX IF NOT EXISTS idx_tools_mech ON workshop_tools(mechanic_id);
    CREATE INDEX IF NOT EXISTS idx_tools_status ON workshop_tools(status);

    CREATE TABLE IF NOT EXISTS tool_issue_logs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      log_no              TEXT UNIQUE NOT NULL,
      tool_id             INTEGER NOT NULL REFERENCES workshop_tools(id),
      mechanic_id         INTEGER REFERENCES mechanics(id),
      issued_to_name      TEXT NOT NULL,
      job_id              INTEGER REFERENCES job_cards(id),
      job_no              TEXT,
      issue_date          TEXT NOT NULL,
      issue_time          TEXT,
      condition_out       TEXT NOT NULL DEFAULT 'good',
      issued_by           INTEGER NOT NULL REFERENCES users(id),
      issued_by_name      TEXT,
      purpose             TEXT,
      expected_return_date TEXT,
      return_date         TEXT,
      return_time         TEXT,
      condition_in        TEXT,
      received_by         INTEGER REFERENCES users(id),
      received_by_name    TEXT,
      return_notes        TEXT,
      status              TEXT NOT NULL DEFAULT 'issued',
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tool_logs_date ON tool_issue_logs(issue_date);
    CREATE INDEX IF NOT EXISTS idx_tool_logs_status ON tool_issue_logs(status);

    CREATE TABLE IF NOT EXISTS tool_scrap_requests (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no          TEXT UNIQUE NOT NULL,
      tool_id             INTEGER NOT NULL REFERENCES workshop_tools(id),
      tool_code           TEXT NOT NULL,
      tool_name           TEXT NOT NULL,
      type                TEXT NOT NULL DEFAULT 'common',
      mechanic_id         INTEGER REFERENCES mechanics(id),
      mechanic_name       TEXT,
      damage_date         TEXT NOT NULL,
      damage_reason       TEXT NOT NULL,
      incident_description TEXT,
      reported_by         INTEGER NOT NULL REFERENCES users(id),
      reported_by_name    TEXT,
      reported_at         TEXT NOT NULL DEFAULT (datetime('now')),
      status              TEXT NOT NULL DEFAULT 'pending_approval',
      engineer_id         INTEGER REFERENCES users(id),
      engineer_name       TEXT,
      engineer_role       TEXT,
      engineer_decision   TEXT,
      engineer_remarks    TEXT,
      engineer_signature  TEXT,
      decided_at          TEXT,
      scrap_date          TEXT,
      scrap_bin_ref       TEXT,
      replacement_requested INTEGER NOT NULL DEFAULT 0,
      replacement_mrn_id  INTEGER,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tool_scrap_status ON tool_scrap_requests(status);

    INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('engineer', 'Mechanical / Workshop Engineer', 1, 1);
    INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('assistant_engineer', 'Assistant Engineer', 1, 1);
  `);

  // Seed default tool items if empty
  const countRow = db.prepare('SELECT COUNT(*) AS c FROM workshop_tools').get();
  if (countRow && countRow.c === 0) {
    const mechs = db.prepare('SELECT id, name FROM mechanics WHERE active = 1 ORDER BY id LIMIT 3').all();
    const commonTools = [
      ['TL-COM-001', '1/2-Inch Digital Torque Wrench (40-200 Nm)', 'measuring', 'common', null, null, 'Main Tool Crib Bay A', 'Koken', 'TW-200D', 'Calibrated high precision digital torque wrench', 48500, 52000, 'good', 'in_store'],
      ['TL-COM-002', '1-Inch Heavy Duty Air Impact Wrench', 'pneumatic', 'common', null, null, 'Pneumatic Tool Rack', 'Ingersoll Rand', 'IR-2175', 'Max torque 2700 Nm for heavy truck wheel nuts', 125000, 135000, 'good', 'in_store'],
      ['TL-COM-003', '20-Ton Heavy Hydraulic Bottle Jack', 'lifting', 'common', null, null, 'Bay 1 Heavy Equipment Rack', 'Omega', 'HJ-20T', 'Welded steel base, overload protection', 38000, 42000, 'good', 'in_store'],
      ['TL-COM-004', 'Universal Hydraulic Bearing & Gear Puller Set (10-Ton)', 'special', 'common', null, null, 'Special Tools Shelf C', 'Koken', 'BP-10T', '2 & 3 jaw arms, separator attachments', 64000, 70000, 'good', 'in_store'],
      ['TL-COM-005', 'Automotive Diagnostic Multimeter & Insulation Tester', 'measuring', 'common', null, null, 'Diagnostic Station Locker', 'Fluke', 'Fluke-88V', 'CAT IV 600V with RPM inductive pickup', 95000, 105000, 'good', 'in_store'],
      ['TL-COM-006', 'Angle Grinder 4-Inch 850W with Safety Guard', 'power_tool', 'common', null, null, 'Fabrication Bench 2', 'Makita', '9557HNG', '11000 RPM slide switch grinder', 24500, 26500, 'good', 'in_store'],
      ['TL-COM-007', 'Portable Inverter Arc Welding Plant 200A (IGBT)', 'welding', 'common', null, null, 'Welding Bay Bay W', 'Jasic', 'ARC-200', 'Duty cycle 60%, hot start & anti-stick', 78000, 85000, 'good', 'in_store'],
      ['TL-COM-008', 'Heavy Duty Cooling System Pressure Tester & Vacuum Purge Kit', 'measuring', 'common', null, null, 'Radiator Service Station', 'Stant', 'ST-270', 'Adapters for commercial trucks and heavy machines', 32000, 36000, 'good', 'in_store'],
      ['TL-COM-009', 'Heavy Duty Hydraulic Transmission Floor Jack 1.5-Ton', 'lifting', 'common', null, null, 'Service Pit Bay 3', 'Torin', 'TEL-150', '360-degree rotating handle, safety tie chain', 88000, 95000, 'good', 'in_store'],
      ['TL-COM-010', 'Universal Heavy Diesel Engine Compression Tester Kit', 'measuring', 'common', null, null, 'Engine Clean Room', 'OTC', 'OTC-5020', 'Includes glow plug and injector adapters', 42000, 46000, 'good', 'in_store']
    ];

    const ins = db.prepare(`
      INSERT INTO workshop_tools (tool_code, name, category, type, mechanic_id, mechanic_name, toolbox_name, location, brand, model_no, specifications, purchase_cost, replacement_cost, condition, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const t of commonTools) {
      ins.run(t[0], t[1], t[2], t[3], t[4], t[5], null, t[6], t[7], t[8], t[9], t[10], t[11], t[12], t[13]);
    }

    // Seed authentic mechanic toolboxes (Nimesh, Nawathilaka, Anura, Seethananda, Theminda)
    let seedTools = [];
    try {
      const seedFile = path.join(__dirname, '..', 'data', 'mechanics_tools_seed.json');
      if (fs.existsSync(seedFile)) {
        seedTools = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      }
    } catch (_err) {
      /* ignore */
    }

    if (seedTools.length > 0) {
      // Dynamically map mechanic names to actual IDs in current database
      const existingMechs = db.prepare('SELECT id, name FROM mechanics').all();
      const nameToId = new Map();
      const validIds = new Set();
      for (const m of existingMechs) {
        validIds.add(m.id);
        nameToId.set(m.name.toLowerCase(), m.id);
        const first = m.name.toLowerCase().split(/[\s/]/)[0];
        if (first) nameToId.set(first, m.id);
      }

      for (const t of seedTools) {
        const mKey = (t.mechanic_name || '').toLowerCase();
        const first = mKey.split(/[\s/]/)[0];
        let resolvedId = nameToId.get(mKey) || nameToId.get(first);
        if (!resolvedId && validIds.has(t.mechanic_id)) {
          resolvedId = t.mechanic_id;
        }
        // A mechanic this database has never heard of is NOT invented here. mechanics is master
        // data owned by the labour migration and the alias resolver, and this is schema setup: a
        // toolbox arriving with a name nobody employs yet must not add that person to the payroll.
        // It did, and because migrate() runs for every test, every database in the suite gained
        // Nimesh, Nawathilaka, Seethananda/seetha and Theminda -- so each test that reads back
        // "the mechanics on this day" or "this workshop's mechanics" saw four people it never
        // created. The toolbox is not lost: mechanic_name below keeps the label the sheet came
        // with, and the row links itself the moment that mechanic does exist. On the real database
        // these five are present already (the labour migration imports them from sources/), so
        // there they resolve above and nothing here changes.

        ins.run(
          t.tool_code, t.name, t.category, t.type, resolvedId || null, t.mechanic_name,
          t.toolbox_name, t.location, t.brand || 'Workshop Standard', t.model_no || '',
          t.specifications || '', t.purchase_cost || 0, t.replacement_cost || 0,
          t.condition || 'good', t.status || 'in_use'
        );
      }
    }
  }

  // Link any toolbox still waiting for its mechanic. The tools above are seeded while the schema is
  // being built, which is before the labour migration or the demo seed has created anybody, and the
  // seed block is gated on the table being empty so it never comes round again -- so on a fresh
  // database every toolbox would otherwise stay unlinked for good. This pass runs on every migrate
  // and fills in mechanic_id once that person exists, matching the way the seed does: the whole
  // name, or its first word, since the sheets write "Seethananda" for "Seethananda/seetha". It
  // touches only rows that have no mechanic yet, so it is safe to re-run every boot and will not
  // overwrite a link someone has since corrected by hand.
  const waiting = db.prepare(
    `SELECT id, mechanic_name FROM workshop_tools
      WHERE mechanic_id IS NULL AND mechanic_name IS NOT NULL AND TRIM(mechanic_name) <> ''`
  ).all();
  if (waiting.length) {
    const byName = new Map();
    for (const m of db.prepare('SELECT id, name FROM mechanics').all()) {
      const n = String(m.name || '').toLowerCase();
      if (n && !byName.has(n)) byName.set(n, m.id);
      const first = n.split(/[\s/]/)[0];
      if (first && !byName.has(first)) byName.set(first, m.id);
    }
    const link = db.prepare('UPDATE workshop_tools SET mechanic_id = ? WHERE id = ?');
    for (const t of waiting) {
      const n = String(t.mechanic_name).toLowerCase();
      const id = byName.get(n) || byName.get(n.split(/[\s/]/)[0]);
      if (id) link.run(id, t.id);
    }
  }
}

// Parts brought back unused (Stage 6) come off a job's cost as a 'return' line on job_parts. Its
// source_type is a CHECK list SQLite cannot change in place — rebuilt once the same way as job_cards
// above (allowPartiallyClosed): every row copied with its id, indexes and triggers put back, and the
// swap undone if a single row or reference would be lost.
function allowReturnParts() {
  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_parts'").get();
  if (!cur || /'return'/.test(cur.sql)) return;
  const list = /(CHECK\s*\(\s*source_type\s+IN\s*\()/i;
  if (!list.test(cur.sql)) return;
  const widened = cur.sql
    .replace(/^CREATE TABLE (IF NOT EXISTS )?("?)job_parts\2/i, 'CREATE TABLE tmp_job_parts')
    .replace(list, "$1'return',");
  if (!/^CREATE TABLE tmp_job_parts/.test(widened)) throw new Error('job_parts: unexpected table definition — source_type not widened');
  const cols = db.prepare('PRAGMA table_info(job_parts)').all().map((c) => `"${c.name}"`).join(', ');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='job_parts' AND sql IS NOT NULL").all();
  const triggers = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='job_parts'").all();
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='job_parts'").get();
  const dangling = () => db.prepare('PRAGMA foreign_key_check').all().filter((r) => r.parent === 'job_parts' || r.table === 'job_parts').length;
  const before = dangling();
  const count = db.prepare('SELECT COUNT(*) n FROM job_parts').get().n;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`${widened};
               INSERT INTO tmp_job_parts (${cols}) SELECT ${cols} FROM job_parts;
               DROP TABLE job_parts;
               ALTER TABLE tmp_job_parts RENAME TO job_parts;`);
      for (const x of [...indexes, ...triggers]) db.exec(x.sql);
      if (seq) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'job_parts'").run(seq.seq);
      if (db.prepare('SELECT COUNT(*) n FROM job_parts').get().n !== count || dangling() !== before) {
        throw new Error('job_parts rebuild did not keep every line and reference — not applied');
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// Improvement plan, Step 3a (src/lib/request_rules.js): whoever raised a request does not certify
// or approve it, and what was certified is what gets approved.
//   - mrn.raised_by_user: the user who raised it. A job request has had requested_by_user from
//     the start; an MRN kept only the typed name. Requests raised in the app take it from their
//     'create' line in the audit log; imported ones have none, and the rule passes them by.
//   - certified_seal: the fingerprint of what was certified. Requests already certified are sealed
//     as they stand now.
function requestRulesStep3a() {
  ensureColumn('mrn', 'raised_by_user', 'INTEGER REFERENCES users(id)');
  ensureColumn('mrn', 'certified_seal', 'TEXT');
  ensureColumn('job_requests', 'certified_seal', 'TEXT');
  db.exec(`UPDATE mrn SET raised_by_user = (SELECT a.user_id FROM audit_log a
                                             WHERE a.entity = 'mrn' AND a.action = 'create' AND a.entity_id = mrn.id
                                             ORDER BY a.id LIMIT 1)
            WHERE raised_by_user IS NULL`);
  require('../lib/request_rules').sealMissing();
}

function supplyRoutesAndPipeline() {
  ensureColumn('mrn_lines', 'supply_route', "TEXT DEFAULT 'main_store'");
  ensureColumn('mrn_lines', 'qty_approved', 'REAL DEFAULT 0');
  ensureColumn('mrn_lines', 'qty_sent', 'REAL DEFAULT 0');
  ensureColumn('mrn_lines', 'qty_issued', 'REAL DEFAULT 0');
  ensureColumn('mrn_lines', 'auto_mtn_id', 'INTEGER REFERENCES mtn(id)');
  ensureColumn('mrn_lines', 'route_assigned_by', 'TEXT');
  ensureColumn('mrn_lines', 'route_assigned_at', 'TEXT');
  ensureColumn('mrn_lines', 'route_assigned_reason', 'TEXT');

  db.exec(`UPDATE mrn_lines SET supply_route = CASE
    WHEN purchase_source = 'head_office' THEN 'head_office'
    WHEN purchase_source = 'local_purchase' THEN 'local_purchase'
    ELSE COALESCE(supply_route, 'main_store')
  END WHERE supply_route IS NULL OR supply_route = '';`);

  db.exec(`UPDATE mrn_lines SET qty_approved = qty
   WHERE (qty_approved IS NULL OR qty_approved = 0)
     AND mrn_id IN (SELECT id FROM mrn WHERE approval_status = 'approved');`);

  db.exec(`UPDATE mrn_lines SET qty_issued = COALESCE((
    SELECT SUM(i.qty) FROM issues i
    JOIN grn g ON g.id = i.grn_id
    WHERE g.mrn_line_id = mrn_lines.id
  ), 0) WHERE qty_issued IS NULL OR qty_issued = 0;`);

  ensureColumn('mtn', 'mrn_id', 'INTEGER REFERENCES mrn(id)');
  ensureColumn('mtn', 'auto_generated', 'INTEGER DEFAULT 0');
  ensureColumn('mtn_lines', 'mrn_id', 'INTEGER REFERENCES mrn(id)');
  ensureColumn('mtn_lines', 'mrn_line_id', 'INTEGER REFERENCES mrn_lines(id)');
  ensureColumn('issues', 'mrn_line_id', 'INTEGER REFERENCES mrn_lines(id)');

  db.exec('CREATE INDEX IF NOT EXISTS idx_mrn_lines_route ON mrn_lines(supply_route);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mtn_mrn ON mtn(mrn_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mtn_lines_mrn_line ON mtn_lines(mrn_line_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_mrn_line ON issues(mrn_line_id);');
}

function chainNumberAndShortDelivery() {
  // Step 4b: Universal Chain Number columns across document lifecycle
  ensureColumn('mrn', 'chain_no', 'TEXT');
  ensureColumn('mtn', 'chain_no', 'TEXT');
  ensureColumn('grn', 'chain_no', 'TEXT');
  ensureColumn('grn_vouchers', 'chain_no', 'TEXT');
  ensureColumn('min_notes', 'chain_no', 'TEXT');
  ensureColumn('issues', 'chain_no', 'TEXT');

  // Step 4b: Short delivery columns
  ensureColumn('mrn_lines', 'qty_short', 'REAL DEFAULT 0');
  ensureColumn('mrn_lines', 'discrepancy_reason', 'TEXT');
  ensureColumn('mtn_lines', 'qty_received', 'REAL');
  ensureColumn('mtn_lines', 'qty_short', 'REAL DEFAULT 0');
  ensureColumn('mtn_lines', 'discrepancy_reason', 'TEXT');

  // Step 4b: Delivery discrepancies table
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_discrepancies (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_no            TEXT,
      mrn_id              INTEGER REFERENCES mrn(id),
      mrn_line_id         INTEGER REFERENCES mrn_lines(id),
      mtn_id              INTEGER REFERENCES mtn(id),
      mtn_line_id         INTEGER REFERENCES mtn_lines(id),
      grn_id              INTEGER REFERENCES grn(id),
      item_description    TEXT,
      qty_expected        REAL NOT NULL DEFAULT 0,
      qty_received        REAL NOT NULL DEFAULT 0,
      qty_short           REAL NOT NULL DEFAULT 0,
      reason              TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'open',
      reported_by         TEXT,
      reported_by_user    INTEGER REFERENCES users(id),
      reported_at         TEXT DEFAULT (datetime('now')),
      resolution_notes    TEXT,
      resolved_by         TEXT,
      resolved_at         TEXT,
      created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Step 4b: Idempotency keys table
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      key            TEXT NOT NULL UNIQUE,
      user_id        INTEGER,
      action         TEXT,
      status         TEXT DEFAULT 'pending',
      response_code  INTEGER,
      response_body  TEXT,
      created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Indexes on chain_no and foreign keys
  db.exec('CREATE INDEX IF NOT EXISTS idx_mrn_chain_no ON mrn(chain_no);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mtn_chain_no ON mtn(chain_no);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_grn_chain_no ON grn(chain_no);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_grn_vouchers_chain_no ON grn_vouchers(chain_no);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_min_notes_chain_no ON min_notes(chain_no);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_chain_no ON issues(chain_no);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_discrepancies_chain_no ON delivery_discrepancies(chain_no);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_discrepancies_status ON delivery_discrepancies(status);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_discrepancies_mrn ON delivery_discrepancies(mrn_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_idempotency_key ON idempotency_keys(key);');

  // Backfill chain_no for existing MRNs if any have NULL
  try {
    const unchained = db.prepare(`SELECT id, req_date FROM mrn WHERE chain_no IS NULL ORDER BY id ASC`).all();
    if (unchained.length > 0) {
      const existing = db.prepare(`SELECT MAX(CAST(SUBSTR(chain_no, 10) AS INTEGER)) as max_seq FROM mrn WHERE chain_no LIKE 'CHN-%'`).get();
      let maxSeq = (existing && existing.max_seq) ? Number(existing.max_seq) : 0;

      const updMrn = db.prepare(`UPDATE mrn SET chain_no = ? WHERE id = ?`);
      const updMtn = db.prepare(`UPDATE mtn SET chain_no = ? WHERE mrn_id = ? AND (chain_no IS NULL OR chain_no = '')`);
      const updGrn = db.prepare(`UPDATE grn SET chain_no = ? WHERE mrn_id = ? AND (chain_no IS NULL OR chain_no = '')`);
      const updGrnVoucher = db.prepare(`UPDATE grn_vouchers SET chain_no = ? WHERE id IN (SELECT voucher_id FROM grn WHERE mrn_id = ? AND voucher_id IS NOT NULL) AND (chain_no IS NULL OR chain_no = '')`);
      const updIssues = db.prepare(`UPDATE issues SET chain_no = ? WHERE (mrn_line_id IN (SELECT id FROM mrn_lines WHERE mrn_id = ?) OR grn_id IN (SELECT id FROM grn WHERE mrn_id = ?)) AND (chain_no IS NULL OR chain_no = '')`);

      for (const m of unchained) {
        maxSeq++;
        const y = (m.req_date && String(m.req_date).slice(0, 4)) || new Date().getFullYear();
        const chainNo = `CHN-${y}-${String(maxSeq).padStart(5, '0')}`;
        updMrn.run(chainNo, m.id);
        updMtn.run(chainNo, m.id);
        updGrn.run(chainNo, m.id);
        updGrnVoucher.run(chainNo, m.id);
        updIssues.run(chainNo, m.id);
      }
    }
  } catch (e) {
    // Graceful fallback if tables are empty or newly initialized
  }
}

function allowClosedMrn() {
  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mrn'").get();
  if (!cur || /'closed'/.test(cur.sql)) return;
  const list = /(CHECK\s*\(\s*status\s+IN\s*\()/i;
  if (!list.test(cur.sql)) return;
  const widened = cur.sql
    .replace(/^CREATE TABLE (IF NOT EXISTS )?("?)mrn\2/i, 'CREATE TABLE tmp_mrn')
    .replace(list, "$1'closed',");
  if (!/^CREATE TABLE tmp_mrn/.test(widened)) throw new Error('mrn: unexpected table definition - status not widened');
  const cols = db.prepare('PRAGMA table_info(mrn)').all().map((c) => `"${c.name}"`).join(', ');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='mrn' AND sql IS NOT NULL").all();
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND (tbl_name='mrn' OR sql LIKE '% mrn %' OR sql LIKE '%(mrn %' OR sql LIKE '%,mrn %' OR sql LIKE '%\nmrn %')").all();
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='mrn'").get();
  const dangling = () => db.prepare('PRAGMA foreign_key_check').all().filter((r) => r.parent === 'mrn' || r.table === 'mrn').length;
  const before = dangling();
  const count = db.prepare('SELECT COUNT(*) n FROM mrn').get().n;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
      db.exec(`${widened};
               INSERT INTO tmp_mrn (${cols}) SELECT ${cols} FROM mrn;
               DROP TABLE mrn;
               ALTER TABLE tmp_mrn RENAME TO mrn;`);
      for (const x of indexes) db.exec(x.sql);
      for (const t of triggers) db.exec(t.sql);
      if (seq) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'mrn'").run(seq.seq);
      if (db.prepare('SELECT COUNT(*) n FROM mrn').get().n !== count || dangling() !== before) {
        throw new Error('mrn rebuild did not keep every record and reference - not applied');
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function closureRulesAndUniversalTrace() {
  // Allow 'closed' status on mrn
  allowClosedMrn();

  // Step 4c: MRN formal closure tracking
  ensureColumn('mrn', 'closed_by', 'TEXT');
  ensureColumn('mrn', 'closed_at', 'TEXT');
  ensureColumn('mrn', 'closure_notes', 'TEXT');

  // Step 4c: Line-item cancellation
  ensureColumn('mrn_lines', 'is_cancelled', 'INTEGER DEFAULT 0');
  ensureColumn('mrn_lines', 'cancellation_reason', 'TEXT');
  ensureColumn('mrn_lines', 'cancelled_by', 'TEXT');
  ensureColumn('mrn_lines', 'cancelled_at', 'TEXT');

  // Indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_mrn_status ON mrn(status);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mrn_lines_cancelled ON mrn_lines(is_cancelled);');
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
