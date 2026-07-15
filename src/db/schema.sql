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
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  qty_received  REAL NOT NULL DEFAULT 0
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
  purchase_source TEXT
                  CHECK (purchase_source IN ('local_purchase','head_office','local_store')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_grn_mrn ON grn(mrn_id);
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
  unit          TEXT NOT NULL DEFAULT 'L'    CHECK (unit IN ('L','kg','nos')),
  category      TEXT,                         -- engine_oil / hydraulic / gear / grease / fuel
  reorder_level REAL DEFAULT 0,
  unit_price    REAL,                         -- latest price (history in product_prices)
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
  mr_no         TEXT,                         -- cross-links to Stores MRN
  mtn_no        TEXT,                         -- cross-links to Stores MTN
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
  condition        TEXT DEFAULT 'new' CHECK (condition IN ('new','old')),
  purchase_date    TEXT,
  warranty_date    TEXT,                       -- expiry / warranty end
  current_asset_id INTEGER REFERENCES assets(id),
  state            TEXT NOT NULL DEFAULT 'in_store'
                     CHECK (state IN ('installed','in_store','handed_over','decommissioned')),
  photo_path       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batteries_current ON batteries(current_asset_id);

CREATE TABLE IF NOT EXISTS battery_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  battery_id    INTEGER NOT NULL REFERENCES batteries(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL
                  CHECK (event_type IN ('add','install','transfer','return','decommission','warranty')),
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
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_job ON job_daily_work(job_id);

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
  interval_hours    REAL,                     -- service every N running hours
  filter_cost       REAL,
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
