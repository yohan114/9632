-- ===========================================================================
-- WorkshopOne — unified schema
-- Edward & Christie (Pvt) Ltd — Central Work Shop, Badalgama
--
-- One database. The ASSET is the master key, the JOB CARD is the hub, every
-- part / litre / battery / labour-hour rolls up to COST.
--
-- Portability: standard SQL types only (no SQLite-only tricks) so the schema
-- ports cleanly to PostgreSQL. Dates are ISO-8601 TEXT. Money is REAL.
-- Normalisation of asset codes is done in app logic (lib/aliases), not via
-- SQLite-specific generated columns.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- MASTER & REFERENCE
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE,                 -- CEP-03, etc.
  name          TEXT NOT NULL,               -- "Iginimitiya Project"
  location      TEXT,
  name_norm     TEXT,                        -- normalised name for resolving project references
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id),
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The canonical fleet register: one row per physical vehicle / machine.
CREATE TABLE IF NOT EXISTS assets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT NOT NULL,          -- canonical, e.g. 28-4314
  code_norm          TEXT NOT NULL UNIQUE,   -- 284314 (uppercase, symbols stripped)
  registration       TEXT,
  ec_code            TEXT,
  brand              TEXT,
  type               TEXT,
  model_no           TEXT,
  capacity           TEXT,
  yom                TEXT,                    -- year of manufacture
  serial_no          TEXT,
  chassis_no         TEXT,
  engine_no          TEXT,
  asset_class        TEXT NOT NULL DEFAULT 'vehicle'
                       CHECK (asset_class IN ('plant','vehicle','generator','tool','machine','other')),
  home_project_id    INTEGER REFERENCES projects(id),
  current_project_id INTEGER REFERENCES projects(id),
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','idle','under_repair','decommissioned')),
  running_hours      REAL,                    -- for service-interval reminders
  in_register        INTEGER NOT NULL DEFAULT 0, -- 1 = from the fleet register; 0 = seen only in Stores/Jobs (review)
  legacy_fleet_id    INTEGER,                 -- source fleet_assets.id (old->new id map)
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_code_norm ON assets(code_norm);
CREATE INDEX IF NOT EXISTS idx_assets_current_project ON assets(current_project_id);

-- The learning resolver: any raw text -> one asset. Unresolved rows are queued.
CREATE TABLE IF NOT EXISTS asset_aliases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text     TEXT NOT NULL,
  raw_norm     TEXT NOT NULL,                 -- normalised form of raw_text
  asset_id     INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  resolved     INTEGER NOT NULL DEFAULT 0,    -- 0 = pending human link
  hit_count    INTEGER NOT NULL DEFAULT 0,
  source       TEXT,                          -- which module/import created it
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (raw_norm)
);
CREATE INDEX IF NOT EXISTS idx_aliases_asset ON asset_aliases(asset_id);
CREATE INDEX IF NOT EXISTS idx_aliases_resolved ON asset_aliases(resolved);

-- ---------------------------------------------------------------------------
-- USERS, ROLES, SESSIONS, AUDIT
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  full_name            TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,  -- force a change on first login
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roles (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  label TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  entity      TEXT NOT NULL,                  -- 'job_card', 'asset', 'grn', ...
  entity_id   INTEGER,
  action      TEXT NOT NULL,                  -- 'create','update','delete','transition',...
  before_json TEXT,
  after_json  TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- ---------------------------------------------------------------------------
-- STORES & INVENTORY  (MRN -> GRN -> Issue -> MTN + general items)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS store_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  part_number  TEXT,
  category     TEXT,
  unit         TEXT DEFAULT 'nos',
  rack         TEXT,
  min_stock    REAL DEFAULT 0,
  is_general   INTEGER NOT NULL DEFAULT 0,    -- general consumable with running balance
  balance      REAL DEFAULT 0,                -- running balance for general items
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_store_items_part ON store_items(part_number);

-- Material Request Note (header)
CREATE TABLE IF NOT EXISTS mrn (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn_no        TEXT NOT NULL UNIQUE,         -- continues existing seq (~167xxx)
  req_date      TEXT NOT NULL DEFAULT (date('now')),
  asset_id      INTEGER REFERENCES assets(id),
  project_id    INTEGER REFERENCES projects(id),
  job_id        INTEGER REFERENCES job_cards(id),
  purpose       TEXT,
  requested_by  TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','partially_received','received','cancelled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mrn_asset ON mrn(asset_id);
CREATE INDEX IF NOT EXISTS idx_mrn_job ON mrn(job_id);

CREATE TABLE IF NOT EXISTS mrn_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn_id        INTEGER NOT NULL REFERENCES mrn(id) ON DELETE CASCADE,
  store_item_id INTEGER REFERENCES store_items(id),
  description   TEXT NOT NULL,
  qty           REAL NOT NULL DEFAULT 0,
  unit          TEXT DEFAULT 'nos',
  qty_received  REAL NOT NULL DEFAULT 0,
  legacy_item_id INTEGER                     -- source items.id (bridges receipts.itemId -> GRN)
);
CREATE INDEX IF NOT EXISTS idx_mrn_lines_mrn ON mrn_lines(mrn_id);

-- Goods Received Note — priced delivery against an MRN line.
CREATE TABLE IF NOT EXISTS grn (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_no         TEXT,
  mrn_id         INTEGER REFERENCES mrn(id),
  mrn_line_id    INTEGER REFERENCES mrn_lines(id),
  store_item_id  INTEGER REFERENCES store_items(id),
  description    TEXT,
  qty            REAL NOT NULL DEFAULT 0,
  unit_price     REAL,                        -- NULL = awaiting price (blocks job closure)
  supplier       TEXT,
  invoice_no     TEXT,
  invoice_date   TEXT,
  delivery_date  TEXT,
  purchase_source TEXT,                       -- raw value (real data has 4 clean values + combos)
  purchase_source_norm TEXT,                  -- normalised bucket for cost-by-source reporting
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_grn_mrn ON grn(mrn_id);
-- Receipts are looked up per REQUEST LINE all over the stores views (search, pending, the
-- receive/price workspace, the job report). Without this each lookup scans the whole GRN
-- table, which made the Stores search take seconds.
CREATE INDEX IF NOT EXISTS idx_grn_line ON grn(mrn_line_id);
CREATE INDEX IF NOT EXISTS idx_grn_unpriced ON grn(mrn_line_id) WHERE unit_price IS NULL;
CREATE INDEX IF NOT EXISTS idx_mrn_lines_legacy ON mrn_lines(legacy_item_id);
CREATE INDEX IF NOT EXISTS idx_mrn_job ON mrn(job_id);
-- idx_jp_line / idx_dw_date live with job_parts and job_daily_work further down: this file is
-- executed top to bottom against an empty database, so an index cannot precede its table.

-- ---------------------------------------------------------------------------
-- Unified stock movements — one row per physical movement, whichever inventory
-- section it belongs to (oil / filter / battery / tyre / general).
--
-- Receiving a GRN was never adding to stock: 3,837 receipts existed and stock only
-- ever went down. This table is the single place a movement is recorded, so every
-- section can answer the same four questions: on order, received, issued, balance.
--
-- `source_table` + `source_id` point back at the record that caused the movement
-- (grn / issues / general_item_txns / stock_ledger / tyre_battery_issues …) so a
-- rebuild is idempotent — a movement is only ever written once per source row.
CREATE TABLE IF NOT EXISTS stock_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  section       TEXT NOT NULL,              -- oil | filter | battery | tyre | general
  kind          TEXT NOT NULL,              -- in | out | opening | adjust
  item_key      TEXT NOT NULL,              -- normalised item identity within the section
  item_name     TEXT,                       -- readable description as recorded
  qty           REAL NOT NULL DEFAULT 0,    -- always positive; `kind` gives the direction
  unit_price    REAL,
  txn_date      TEXT,
  asset_id      INTEGER REFERENCES assets(id),
  job_id        INTEGER REFERENCES job_cards(id),
  mrn_line_id   INTEGER REFERENCES mrn_lines(id),
  store_item_id INTEGER REFERENCES store_items(id),
  ref           TEXT,                       -- MRN/GRN/MTN number, service job no, etc.
  note          TEXT,
  source_table  TEXT NOT NULL,
  source_id     INTEGER NOT NULL,
  -- 1 = counts toward the balance. Movements from before a section's cut-over are kept at 0:
  -- they stay fully visible as history without dragging the balance negative.
  counts        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- item_key is part of the key because ONE source row can move TWO DIFFERENT items: a service
  -- line that reads "JS-1030 & 278 607 989 916" fits two filters. Without it the second movement
  -- collided with the first and INSERT OR IGNORE dropped it in silence. A rebuild stays
  -- idempotent — the same source row always produces the same (source, kind, item) tuples.
  UNIQUE (source_table, source_id, kind, item_key)
);
CREATE INDEX IF NOT EXISTS idx_sm_section ON stock_moves(section, item_key);
CREATE INDEX IF NOT EXISTS idx_sm_date ON stock_moves(txn_date);
CREATE INDEX IF NOT EXISTS idx_sm_asset ON stock_moves(asset_id);
CREATE INDEX IF NOT EXISTS idx_sm_kind ON stock_moves(section, kind);
-- "How much of this delivery has already gone out" — asked once per row by the received-stock
-- panel in the issue form, so without this it re-scans the whole ledger per line.
CREATE INDEX IF NOT EXISTS idx_sm_mrn_line ON stock_moves(mrn_line_id);

-- Where each section's balance starts counting. Sections whose purchase history was
-- never captured in stores (filters, batteries) open from a cut-over date instead of
-- replaying history, which would otherwise show a large negative balance.
-- Every issuable item across all five sections, each with ONE unique code.
-- The row points back at whatever table owns it (products / store_items / filter_prices /
-- tyre_battery_prices) so the source systems keep working untouched and can be re-imported.
-- General stock keeps the codes it already has (ELE-0057, GEN-0245 — 1,874 of them, no
-- duplicates); the other sections get OIL- / FIL- / BAT- / TYR- prefixes on the same pattern.
CREATE TABLE IF NOT EXISTS stock_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,       -- OIL-0001 | FIL-0001 | BAT-0001 | TYR-0001 | ELE-0057
  section      TEXT NOT NULL,              -- oil | filter | battery | tyre | general
  name         TEXT NOT NULL,
  part_no      TEXT,                       -- manufacturer / supplier number, when there is one
  item_key     TEXT NOT NULL,              -- ties the item to its stock_moves history
  unit         TEXT,
  unit_price   REAL,
  source_table TEXT NOT NULL,
  source_id    INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (section, item_key)
);
CREATE INDEX IF NOT EXISTS idx_si_section ON stock_items(section, active);
CREATE INDEX IF NOT EXISTS idx_si_name ON stock_items(name);
CREATE INDEX IF NOT EXISTS idx_si_part ON stock_items(part_no);

CREATE TABLE IF NOT EXISTS stock_opening (
  section    TEXT PRIMARY KEY,              -- oil | filter | battery | tyre | general
  mode       TEXT NOT NULL,                 -- history | cutover | count
  cutover    TEXT,                          -- YYYY-MM-DD when mode = cutover
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_grn_no ON grn(grn_no);

-- Item / repair charge issued directly to an asset.
CREATE TABLE IF NOT EXISTS issues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id      INTEGER REFERENCES assets(id),
  job_id        INTEGER REFERENCES job_cards(id),
  store_item_id INTEGER REFERENCES store_items(id),
  description   TEXT NOT NULL,
  qty           REAL NOT NULL DEFAULT 1,
  unit_price    REAL,                         -- NULL = awaiting price
  issue_date    TEXT NOT NULL DEFAULT (date('now')),
  issued_by     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_issues_asset ON issues(asset_id);
CREATE INDEX IF NOT EXISTS idx_issues_job ON issues(job_id);

-- Material Transfer Note between locations / vehicles.
CREATE TABLE IF NOT EXISTS mtn (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mtn_no         TEXT NOT NULL UNIQUE,        -- continues existing seq (~57xxx)
  txn_date       TEXT NOT NULL DEFAULT (date('now')),
  store_item_id  INTEGER REFERENCES store_items(id),
  description    TEXT,
  qty            REAL NOT NULL DEFAULT 0,
  from_location  TEXT,
  to_location    TEXT,
  from_asset_id  INTEGER REFERENCES assets(id),
  to_asset_id    INTEGER REFERENCES assets(id),
  transferred_by TEXT,
  received_by    TEXT,
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mtn_no ON mtn(mtn_no);

-- The items on a transfer note. One note carries as many as the paper does; before this
-- existed the store faked it by suffixing the number (58631, 58631-2 … 58631-5 is ONE note
-- with five items), which is why 93 of the first 190 rows carry a -N.
--
-- from/to/reason repeat here because they genuinely vary line by line: transfer 64965 moved
-- three filters off three DIFFERENT machines to one mechanic, and 58605 carried a separate
-- invoice value per line. A line's own value wins; blank means "same as the note".
--
-- The mtn header keeps description/qty as a SUMMARY of these rows, maintained on write, so
-- everything that already reads a transfer as one line keeps working.
CREATE TABLE IF NOT EXISTS mtn_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mtn_id         INTEGER NOT NULL REFERENCES mtn(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 1,
  store_item_id  INTEGER REFERENCES store_items(id),
  description    TEXT,
  qty            REAL NOT NULL DEFAULT 0,
  unit           TEXT,
  category       TEXT,
  category_id    INTEGER REFERENCES item_categories(id),
  from_location  TEXT,
  to_location    TEXT,
  from_asset_id  INTEGER REFERENCES assets(id),
  to_asset_id    INTEGER REFERENCES assets(id),
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mtn_lines_mtn ON mtn_lines(mtn_id);

-- Running-balance ledger for general consumables.
CREATE TABLE IF NOT EXISTS general_item_txns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_item_id  INTEGER NOT NULL REFERENCES store_items(id),
  txn_type       TEXT NOT NULL CHECK (txn_type IN ('receipt','issue','opening','adjustment')),
  qty            REAL NOT NULL,               -- signed by convention: + receipt, - issue
  balance_after  REAL NOT NULL,
  asset_id       INTEGER REFERENCES assets(id),
  job_id         INTEGER REFERENCES job_cards(id),
  unit_price     REAL,
  ref            TEXT,
  txn_date       TEXT NOT NULL DEFAULT (date('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gen_txn_item ON general_item_txns(store_item_id);
CREATE INDEX IF NOT EXISTS idx_gen_txn_job ON general_item_txns(job_id);

-- ---------------------------------------------------------------------------
-- OIL & LUBRICANT STOCK BOOK
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE,
  name          TEXT NOT NULL,               -- CI4, HD46, HD68, 80W90, MP140, grease, diesel...
  sheet_name    TEXT,                         -- source key for matching oil_prices back to products
  unit          TEXT NOT NULL DEFAULT 'L',
  category      TEXT,                         -- engine_oil / hydraulic / gear / grease / fuel
  reorder_level REAL DEFAULT 0,
  unit_price    REAL,                         -- latest price (history in product_prices)
  sort_order    INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The oil stock ledger — keeps the running balance_after design (auditable).
CREATE TABLE IF NOT EXISTS stock_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  kind          TEXT NOT NULL CHECK (kind IN ('receipt','issue','opening','adjustment','transfer')),
  qty           REAL NOT NULL,               -- signed: + in, - out
  balance_after REAL NOT NULL,
  unit_price    REAL,                         -- price at time of txn
  asset_id      INTEGER REFERENCES assets(id),
  project_id    INTEGER REFERENCES projects(id),
  job_id        INTEGER REFERENCES job_cards(id),
  consumer      TEXT,                         -- free-text internal consumer if not an asset
  consumer_type TEXT,                         -- asset / project / unknown / internal (from source)
  mr_no         TEXT,                         -- cross-links to Stores MRN
  mtn_no        TEXT,                         -- cross-links to Stores MTN
  voided        INTEGER NOT NULL DEFAULT 0,
  legacy_id     INTEGER,                      -- source transactions.id
  txn_date      TEXT NOT NULL DEFAULT (date('now')),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_product ON stock_ledger(product_id);
CREATE INDEX IF NOT EXISTS idx_ledger_asset ON stock_ledger(asset_id);
CREATE INDEX IF NOT EXISTS idx_ledger_job ON stock_ledger(job_id);
CREATE INDEX IF NOT EXISTS idx_ledger_date ON stock_ledger(txn_date);

-- Monthly physical stock count vs book, with variance. (product, period) unique.
CREATE TABLE IF NOT EXISTS stock_counts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  period        TEXT NOT NULL,               -- 'YYYY-MM'
  book_qty      REAL,
  counted_qty   REAL,
  variance      REAL,                         -- counted - book
  note          TEXT,
  counted_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, period)
);

-- Price history so a job dated in March uses March's price.
CREATE TABLE IF NOT EXISTS product_prices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  unit_price     REAL NOT NULL,
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prices_product ON product_prices(product_id, effective_from);

-- ---------------------------------------------------------------------------
-- BATTERY LIFECYCLE (the TWO old systems merged into ONE)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS batteries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_no        TEXT NOT NULL UNIQUE,      -- one serial = one battery
  brand            TEXT,
  capacity_ah      REAL,
  condition        TEXT,                       -- raw (real: new/old/Expired/...)
  purchase_date    TEXT,
  warranty_date    TEXT,                       -- expiry / warranty end
  current_asset_id INTEGER REFERENCES assets(id),
  state            TEXT NOT NULL DEFAULT 'in_store', -- raw (real: In Store/Disposed/...)
  state_norm       TEXT,                       -- normalised: installed/in_store/handed_over/decommissioned
  photo_path       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batteries_current ON batteries(current_asset_id);

-- What a lubricant is called everywhere else.
--
-- The oil book keeps 22 products with proper codes (OIL-0001…), but a drum of the same oil is
-- written differently on every piece of paper it touches: "Karosine Oil" in the oil ledger,
-- "Kerosine Oil" on the request, "HD 68 Oil Valvoline" on the receipt against "HD 68 Oil
-- (Valvoline)" in the book. Until these resolve to one product, a receipt and a top-up cannot
-- be recognised as the same delivery.
--
-- Same shape as asset_aliases / mechanic_aliases: an unrecognised spelling is RECORDED with
-- resolved = 0 rather than guessed at, so the owner decides what it is instead of the system
-- inventing a match. hit_count shows which unknowns are worth resolving first.
-- effective_from lets ONE name mean different products over time. The workshop bought HD-68
-- in Caltex and then in Valvoline, wrote both simply as "HD-68 Oil", and the two overlapped
-- for nine months — so a single mapping is wrong at one end of the book or the other.
-- '' means "since the beginning" (NOT null: SQLite counts NULLs as distinct in a UNIQUE
-- constraint, so ON CONFLICT would never fire and every save would add another row). A dated
-- row takes over from its date on, and '' sorts before every real date so the newest meaning
-- wins naturally. Three brands of 80W90 and three of 15W40 sit in the same catalogue, so this
-- will be needed again.
CREATE TABLE IF NOT EXISTS lubricant_aliases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text       TEXT NOT NULL,
  raw_norm       TEXT NOT NULL,
  product_id     INTEGER REFERENCES products(id),
  effective_from TEXT NOT NULL DEFAULT '',   -- '' = has always meant this
  resolved       INTEGER NOT NULL DEFAULT 0,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  source         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (raw_norm, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_lube_alias_norm ON lubricant_aliases(raw_norm);

-- Photographs of a battery — the serial plate, its condition on arrival, the damage behind a
-- warranty claim. A claim is argued with several pictures, so a battery holds up to six.
-- Stored as resized base64 data URLs like the e-signatures, so they travel with the backups
-- rather than living in a directory that has to be backed up separately.
--
-- batteries.photo_path stays as the COVER — the first of these — because the battery list and
-- its 📷 flag read a battery as having one photo. It is maintained from this table, never
-- written on its own.
CREATE TABLE IF NOT EXISTS battery_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  battery_id  INTEGER NOT NULL REFERENCES batteries(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL DEFAULT 1,
  photo       TEXT NOT NULL,              -- data:image/...;base64,...
  note        TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_battery_photos ON battery_photos(battery_id, seq);

CREATE TABLE IF NOT EXISTS battery_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  battery_id    INTEGER NOT NULL REFERENCES batteries(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,                 -- raw action (real: register/add/decommission/transfer/...)
  from_asset_id INTEGER REFERENCES assets(id),
  to_asset_id   INTEGER REFERENCES assets(id),
  reason        TEXT,
  mtn_ref       TEXT,                          -- e.g. MTN-57814
  photo_path    TEXT,
  user_id       INTEGER REFERENCES users(id),
  event_date    TEXT NOT NULL DEFAULT (date('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batt_events_batt ON battery_events(battery_id);

-- ---------------------------------------------------------------------------
-- JOB CARD / WORK ORDER  (the hub) + costing
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS labour_rates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanic       TEXT NOT NULL,
  rate           REAL NOT NULL,               -- hourly rate
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_labour_mech ON labour_rates(mechanic, effective_from);

-- Canonical mechanic registry + resolver (mirrors assets / asset_aliases).
-- The source daily-work data spells the same person several ways
-- ("seetha" vs "Seethananda/seetha", "Vinod" vs "Vinod M") — the resolver maps
-- any raw spelling to one canonical mechanic so labour rates cost correctly.
CREATE TABLE IF NOT EXISTS mechanics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,               -- canonical display name (matches labour_rates.mechanic)
  name_norm  TEXT NOT NULL UNIQUE,        -- uppercase, symbols stripped
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mechanic_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text    TEXT NOT NULL,
  raw_norm    TEXT NOT NULL UNIQUE,
  mechanic_id INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,   -- 0 = pending human link
  hit_count   INTEGER NOT NULL DEFAULT 0,
  source      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mech_alias_mech ON mechanic_aliases(mechanic_id);
CREATE INDEX IF NOT EXISTS idx_mech_alias_resolved ON mechanic_aliases(resolved);

-- Standalone historical cost log from the Excel `job cost` sheet. Its numbers
-- are its OWN sequence (4-984) with 0/410 matches to C-job.ref or job_no, so it
-- is imported as a standalone log and NOT auto-linked to job_cards (job_id is
-- left NULL until a mapping is confirmed by the owner).
CREATE TABLE IF NOT EXISTS historical_job_costs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  seq              TEXT,                    -- the sheet's own running number
  description      TEXT,
  spare_parts_cost REAL,
  external_cost    REAL,
  labour_cost      REAL,
  total_cost       REAL,
  raw_ref          TEXT,                    -- any ref text carried verbatim
  job_id           INTEGER REFERENCES job_cards(id),  -- intentionally NULL (no auto-link)
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_cards (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_no               TEXT NOT NULL UNIQUE,  -- YYYY/M/R/seq (repair) or YYYY/M/S/seq (service)
  ref                  TEXT,
  legacy_ref           TEXT,                  -- c_job "Ref." (e.g. 24-063)
  is_historical        INTEGER NOT NULL DEFAULT 0, -- imported history: keep recorded totals, don't recompute
  synthesized_no       INTEGER NOT NULL DEFAULT 0, -- job_no was generated (source had none)
  asset_id             INTEGER REFERENCES assets(id),
  project_id           INTEGER REFERENCES projects(id),
  site                 TEXT,
  type                 TEXT NOT NULL DEFAULT 'repair' CHECK (type IN ('repair','service')),
  severity             TEXT CHECK (severity IN ('major','minor')),
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'REQUESTED'
                         CHECK (status IN ('REQUESTED','APPROVED_TRANSPORT','APPROVED_OPERATIONS',
                                           'IN_WORKSHOP','IN_PROGRESS','WORK_COMPLETE','CLOSED','REJECTED')),
  requested_by         TEXT,
  requested_by_user    INTEGER REFERENCES users(id),
  requested_at         TEXT NOT NULL DEFAULT (datetime('now')),
  approved_transport_at TEXT,
  approved_ops_at      TEXT,
  started_at           TEXT,
  completed_at         TEXT,
  closed_at            TEXT,
  -- Service jobs use a FLAT labour charge (not hours×rate). When set, costing
  -- uses this as labour_cost and does NOT run the hourly engine. Repairs leave
  -- it NULL and cost labour hourly (split across the crew).
  flat_labour          REAL,
  -- live running totals (a snapshot is frozen in job_costs on CLOSE)
  labour_cost          REAL DEFAULT 0,
  material_cost        REAL DEFAULT 0,
  oil_cost             REAL DEFAULT 0,
  general_cost         REAL DEFAULT 0,
  external_cost        REAL DEFAULT 0,
  total_cost           REAL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_asset ON job_cards(asset_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_cards(status);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON job_cards(project_id);

CREATE TABLE IF NOT EXISTS job_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('transport_manager','operational_manager')),
  approver_id INTEGER REFERENCES users(id),
  decision    TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_job ON job_approvals(job_id);

CREATE TABLE IF NOT EXISTS job_daily_work (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  work_date     TEXT NOT NULL DEFAULT (date('now')),
  mechanic      TEXT,
  description   TEXT,
  hours         REAL NOT NULL DEFAULT 0,
  is_external   INTEGER NOT NULL DEFAULT 0,
  external_value REAL DEFAULT 0,
  outside_labour REAL,                        -- owner-entered outside labor value for this entry
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_job ON job_daily_work(job_id);
-- The Daily Work day view and the monthly report both scan by date.
CREATE INDEX IF NOT EXISTS idx_dw_date ON job_daily_work(work_date);

-- Parts consumed by a job, each linked to its source document. Bridge to Stores/Oil.
CREATE TABLE IF NOT EXISTS job_parts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  source_type        TEXT NOT NULL CHECK (source_type IN ('grn','issue','oil','general','external')),
  source_id          INTEGER,               -- id in grn / issues / stock_ledger / general_item_txns
  description        TEXT,
  qty                REAL NOT NULL DEFAULT 1,
  unit_price         REAL,                   -- NULL = awaiting price (blocks closure)
  is_external_repair INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_parts_job ON job_parts(job_id);
-- idx_jp_line is created in db/index.js instead: mrn_line_id is added by ensureColumn, which
-- runs after this file, so on a fresh database the column does not exist yet here.

-- Computed labour lines (materialised from daily work × rate for the cost sheet).
CREATE TABLE IF NOT EXISTS job_labour (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  mechanic  TEXT,
  hours     REAL NOT NULL DEFAULT 0,
  rate      REAL,
  amount    REAL,
  work_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_labour_job ON job_labour(job_id);
-- The monthly report scopes a closed job's labour to the report month by work_date.
CREATE INDEX IF NOT EXISTS idx_jl_date ON job_labour(work_date);

-- ---------------------------------------------------------------------------
-- Daily reports: "Pending Parts" and the "Maintenance Summery" job record.
--
-- Both were kept as a hand-typed sheet per day (3HP/3LP/4HP… and 12/25/26). The narrative
-- columns — what was completed, what is still pending, the job's status, parts on order — are
-- the supervisor's words, not anything the system can derive, and they change little from one
-- day to the next. So they are stored against the JOB (or the request line) and carried forward
-- until edited, rather than retyped every morning.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_summary_notes (
  job_id            INTEGER PRIMARY KEY REFERENCES job_cards(id) ON DELETE CASCADE,
  completed_repairs TEXT,
  pending_repairs   TEXT,
  job_status        TEXT,          -- free text: Ongoing / No Technicians / sent to Colombo …
  spare_parts       TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by        INTEGER REFERENCES users(id)
);

-- A remark against a RECEIPT waiting for its price ("invoice chased 12/8", "supplier to confirm").
-- Keyed on the receipt rather than the request line, because one request can arrive in several
-- deliveries and each carries its own invoice.
CREATE TABLE IF NOT EXISTS receipt_price_notes (
  grn_id     INTEGER PRIMARY KEY REFERENCES grn(id) ON DELETE CASCADE,
  remarks    TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pending_part_notes (
  mrn_line_id INTEGER PRIMARY KEY REFERENCES mrn_lines(id) ON DELETE CASCADE,
  remarks     TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER REFERENCES users(id)
);

-- One frozen copy per day per report. The day's sheet must still read the same next month even
-- though the underlying jobs have moved on, which is exactly what the hand-kept workbook did.
CREATE TABLE IF NOT EXISTS daily_report_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,               -- 'pending_parts' | 'job_summary'
  report_date  TEXT NOT NULL,               -- YYYY-MM-DD
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  generated_by INTEGER REFERENCES users(id),
  row_count    INTEGER NOT NULL DEFAULT 0,
  payload      TEXT NOT NULL,               -- the rendered rows, as JSON
  UNIQUE(kind, report_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_snap ON daily_report_snapshots(kind, report_date DESC);

-- Scanned service sheets attached to a service record.
--
-- The bytes live in the database, not beside it: a backup is a SQLite .backup() of the single
-- .db file and a restore swaps that file, so anything kept on disk would silently not be backed
-- up and would not come back after a restore. Held as a BLOB rather than base64 so the stored
-- size is the real file size.
CREATE TABLE IF NOT EXISTS service_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id  INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes  INTEGER NOT NULL,
  note        TEXT,
  data        BLOB NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_svc_attach ON service_attachments(service_id);

-- Per-asset × month cost rollup behind the dashboard and the per-vehicle cost report.
-- Also declared by migrate/015 (which additionally backfills it); repeated here because
-- costing.refreshJobTotals writes to it on every job cost change, so it has to exist on a
-- brand-new database too — not only on one that has had the 015 step run against it.
-- Invariant: total_cost = Σ(component columns). Every writer moves a component and the
-- total together.
CREATE TABLE IF NOT EXISTS vehicle_monthly_costs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id     INTEGER NOT NULL REFERENCES assets(id),
  year         INTEGER NOT NULL,
  month        INTEGER NOT NULL,
  fuel_cost    REAL DEFAULT 0,
  oil_cost     REAL DEFAULT 0,
  filter_cost  REAL DEFAULT 0,
  battery_cost REAL DEFAULT 0,
  parts_cost   REAL DEFAULT 0,
  labour_cost  REAL DEFAULT 0,
  total_cost   REAL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asset_id, year, month)
);
CREATE INDEX IF NOT EXISTS idx_vmc_period ON vehicle_monthly_costs(year, month);

-- Every reopen of a closed card, with the close it undid. Two jobs at once: the audit
-- record ("who reopened 2026/5/R/281 and why"), and the anchor that keeps the card in its
-- ORIGINAL cost-report month when it is closed again — prev_completed_at is copied to
-- job_cards.original_completed_at so a month already reported to the owner never changes.
CREATE TABLE IF NOT EXISTS job_reopens (
  id                INTEGER PRIMARY KEY,
  job_id            INTEGER NOT NULL REFERENCES job_cards(id),
  reopened_at       TEXT NOT NULL DEFAULT (datetime('now')),
  reopened_by       INTEGER REFERENCES users(id),
  reason            TEXT NOT NULL,
  prev_status       TEXT,
  prev_completed_at TEXT,
  prev_closed_at    TEXT,
  prev_total_cost   REAL,
  reclosed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_reopens_job ON job_reopens(job_id);

-- Frozen cost snapshot taken on CLOSE (historical costs never shift afterwards).
CREATE TABLE IF NOT EXISTS job_costs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  labour_cost   REAL DEFAULT 0,
  material_cost REAL DEFAULT 0,
  oil_cost      REAL DEFAULT 0,
  general_cost  REAL DEFAULT 0,
  external_cost REAL DEFAULT 0,
  total_cost    REAL DEFAULT 0,
  snapshot_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_costs_job ON job_costs(job_id);

-- Per-asset service template (filter costs, oil quantities). From "Muthur plant".
CREATE TABLE IF NOT EXISTS service_specs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id          INTEGER REFERENCES assets(id),
  machine_label     TEXT,
  interval_hours    REAL,                     -- service every N running hours (NOT in source — owner sets it)
  filter_cost       REAL,                     -- total of the individual filters below
  diesel_filter     REAL,
  oil_filter        REAL,
  air_filter        REAL,
  trans_filter      REAL,
  hy_filter         REAL,
  oil_qty           REAL,
  hydraulic_qty     REAL,
  transmission_qty  REAL,
  expected_cost     REAL,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_service_specs_asset ON service_specs(asset_id);

-- ---------------------------------------------------------------------------
-- SETTINGS (small key/value for runtime config that isn't env)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------------------
-- TYRES & BATTERIES — request, approval, issue, and what came off
--
-- The register the workshop has kept since 2012 holds 4,305 tyre lines and
-- 1,781 battery lines, and its weakness is that the item was always free text:
-- 804 spellings of about 170 real tyre sizes, so a third of tyre issues never
-- reached a price. These tables put a picklist in front of the storekeeper so
-- the next ten years read better than the last ten.
--
-- The REQUEST is an ordinary MRN — same number, same certify/approve trail,
-- same inbox the managers already sign. Only the detail a tyre or battery
-- needs (which wheel, what the meter read, why, what came off) lives here.
-- ---------------------------------------------------------------------------

-- The catalogue. One row per thing that can be asked for: a tyre size in a
-- given type, or a battery rating. spec_key is what an old free-text line is
-- matched back to, so history and new requests meet on the same shelf.
CREATE TABLE IF NOT EXISTS tb_specs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('tyre','battery')),
  size        TEXT,                       -- tyre only: "1000 X 20", normalised
  tyre_type   TEXT,                       -- ORIGINAL | CANVAS | RADIAL | DAG | ORIGINAL - RADIAL | …
  rating      TEXT,                       -- battery only: "95 Amp"
  label       TEXT NOT NULL,              -- what the storekeeper reads on the picklist
  spec_key    TEXT NOT NULL,              -- normalised join key
  unit_price  REAL,
  active      INTEGER NOT NULL DEFAULT 1,
  source      TEXT,                       -- where the row came from (workbook import, or a person)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, spec_key)
);
CREATE INDEX IF NOT EXISTS idx_tb_specs_kind ON tb_specs(kind, active);

-- The tyre/battery detail of one MRN line. The line itself (description, qty,
-- category) stays where every other requested item lives; this is what a wheel
-- or a battery needs on top of it.
CREATE TABLE IF NOT EXISTS tb_request_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn_line_id    INTEGER NOT NULL REFERENCES mrn_lines(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('tyre','battery')),
  spec_id        INTEGER REFERENCES tb_specs(id),
  asset_id       INTEGER REFERENCES assets(id),
  site           TEXT,
  position       TEXT,                    -- tyre: FL, FR, RL1, RR1, SPARE …
  km_reading     REAL,                    -- odometer or hour meter as found
  km_remark      TEXT,                    -- "NOT WORK" and the like, kept out of the number
  reason         TEXT NOT NULL,           -- worn, puncture, burst, no-crank, accident …
  priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent','breakdown')),
  old_serial     TEXT,                    -- what is coming off, if it is known
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mrn_line_id)
);
CREATE INDEX IF NOT EXISTS idx_tb_reqline_asset ON tb_request_lines(asset_id);

-- What came off the machine. A replacement is not finished until the old unit
-- is accounted for: an old battery has scrap value and an old tyre may still be
-- worth repairing or retreading. Where it genuinely cannot be returned (lost on
-- the road, taken by the supplier in exchange) that is recorded as an exception
-- with a reason, rather than left blank and forgotten.
CREATE TABLE IF NOT EXISTS tb_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id       INTEGER REFERENCES tyre_battery_issues(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('tyre','battery')),
  asset_id       INTEGER REFERENCES assets(id),
  serial_no      TEXT,
  condition      TEXT NOT NULL CHECK (condition IN
                   ('repairable','retreadable','reusable','warranty','scrap','not_returned')),
  exception_reason TEXT,                  -- required when condition = not_returned
  km_reading     REAL,
  returned_to    TEXT,                    -- which store took it in
  received_by    TEXT,
  notes          TEXT,
  return_date    TEXT NOT NULL DEFAULT (date('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tb_returns_issue ON tb_returns(issue_id);
CREATE INDEX IF NOT EXISTS idx_tb_returns_cond ON tb_returns(kind, condition);
