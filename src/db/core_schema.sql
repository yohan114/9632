-- WorkshopOne Core Schema (36 Shared Tables + Architecture Tables)

CREATE TABLE projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE,                 -- CEP-03, etc.
  name          TEXT NOT NULL,               -- "Iginimitiya Project"
  location      TEXT,
  name_norm     TEXT,                        -- normalised name for resolving project references
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id),
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assets (
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
, current_site_id INTEGER REFERENCES sites(id));

CREATE TABLE asset_aliases (
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

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  full_name            TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,  -- force a change on first login
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
, signature TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0, mfa_secret TEXT, mfa_pending_secret TEXT, mfa_last_step INTEGER, mfa_enabled_at TEXT, workshop_id INTEGER REFERENCES workshops(id), access_until TEXT, approval_limit REAL);

CREATE TABLE roles (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  label TEXT
, description TEXT, is_system INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, require_mfa INTEGER NOT NULL DEFAULT 0);

CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT
, mfa_verified INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT);

CREATE TABLE audit_log (
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

CREATE TABLE store_items (
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
, item_no TEXT, catalogue_kind TEXT, part_numbers TEXT, req_count INTEGER, unit_cost REAL DEFAULT 0, total_value REAL GENERATED ALWAYS AS (balance * unit_cost) VIRTUAL, description TEXT, category_id INTEGER);

CREATE TABLE products (
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
, stock_qty REAL DEFAULT 0);

CREATE TABLE product_prices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  unit_price     REAL NOT NULL,
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE service_specs (
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

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE role_permissions (
    role   TEXT NOT NULL,
    module TEXT NOT NULL,
    level  TEXT NOT NULL DEFAULT 'none',
    PRIMARY KEY (role, module)
  );

CREATE TABLE filter_prices (
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

CREATE TABLE oil_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT DEFAULT 'L', sort_order INTEGER DEFAULT 0
  );

CREATE TABLE filter_category_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0
  );

CREATE TABLE oil_type_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, unit_price REAL DEFAULT 0
  );

CREATE TABLE filter_catalogue (
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

CREATE TABLE filter_xrefs (
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

CREATE TABLE tyre_battery_prices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,               -- 'tyre' | 'battery'
    category_norm TEXT NOT NULL,
    category      TEXT,                         -- display form
    unit_price    REAL,
    updated_by    TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(kind, category_norm)
  );

CREATE TABLE item_categories (
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

CREATE TABLE stock_items (
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

CREATE TABLE "tb_specs" (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('tyre','battery','tube','flap')),
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

CREATE TABLE user_seen_marks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );

CREATE TABLE vehicle_lubricant_capacities (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id             INTEGER REFERENCES assets(id) ON DELETE SET NULL,
      sheet_id             INTEGER,
      ec_no                TEXT,
      registration         TEXT,
      category             TEXT,
      brand                TEXT,
      model                TEXT,
      year                 TEXT,
      engine_oil_l         REAL,
      engine_oil_grade     TEXT,
      gearbox_oil_l        REAL,
      gearbox_oil_grade    TEXT,
      diff_oil_l           REAL,
      diff_oil_grade       TEXT,
      front_axle_oil_l     REAL,
      hydraulic_oil_l      REAL,
      final_drive_oil_l    REAL,
      swing_oil_l          REAL,
      other_gearbox_oil_l  REAL,
      coolant_l            REAL,
      brake_fluid_l        REAL,
      engine_oil_basis     TEXT,
      engine_oil_records   INTEGER DEFAULT 0,
      notes                TEXT,
      updated_by           TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE role_capabilities (
    role       TEXT NOT NULL,
    capability TEXT NOT NULL,
    granted    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (role, capability)
  );

CREATE TABLE mfa_recovery_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE auth_challenges (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip         TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

CREATE TABLE approval_limits (
  role        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  max_amount  REAL NOT NULL CHECK (max_amount >= 0),
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (role, kind)
);

CREATE TABLE workshops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,              -- short, e.g. CW
  name        TEXT NOT NULL UNIQUE,              -- "Central Workshop — Badalgama"
  place       TEXT,                              -- town or address
  is_default  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
, own_store INTEGER NOT NULL DEFAULT 0, uses_store INTEGER REFERENCES workshops(id), store_opened TEXT);

CREATE TABLE asset_moves (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id         INTEGER NOT NULL REFERENCES assets(id),
  move_date        TEXT NOT NULL,                  -- YYYY-MM-DD: at the new place from this day
  from_project_id  INTEGER REFERENCES projects(id),
  from_site_id     INTEGER REFERENCES sites(id),
  to_project_id    INTEGER REFERENCES projects(id),
  to_site_id       INTEGER REFERENCES sites(id),
  note             TEXT,
  moved_by         INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_permissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    section    TEXT NOT NULL,
    level      TEXT NOT NULL DEFAULT 'none',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    UNIQUE(user_id, section)
  );

CREATE TABLE user_capabilities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    granted    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    UNIQUE(user_id, capability)
  );

CREATE TABLE stand_in_delegations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  granter_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stand_in_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date      TEXT NOT NULL,          -- YYYY-MM-DD
  end_date        TEXT NOT NULL,          -- YYYY-MM-DD
  reason          TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at      TEXT,
  revoked_by      INTEGER REFERENCES users(id),
  revoked_reason  TEXT
);

CREATE TABLE idempotency_keys (
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


CREATE TABLE IF NOT EXISTS workshop_databases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workshop_id  INTEGER NOT NULL UNIQUE,
  code         TEXT NOT NULL UNIQUE,
  db_file      TEXT NOT NULL,
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  state        TEXT NOT NULL DEFAULT 'live',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at  TEXT
);

CREATE TABLE IF NOT EXISTS workshop_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workshop_id  INTEGER NOT NULL UNIQUE,
  wrapped_key  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at   TEXT
);

CREATE TABLE IF NOT EXISTS store_access_grants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workshop_id  INTEGER NOT NULL REFERENCES workshops(id),
  store_id     INTEGER NOT NULL,
  can_view     INTEGER NOT NULL DEFAULT 1,
  can_request  INTEGER NOT NULL DEFAULT 1,
  can_draw     INTEGER NOT NULL DEFAULT 0,
  covering     TEXT NOT NULL DEFAULT 'all',
  item_keys    TEXT,
  line_limit   REAL,
  monthly_limit REAL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  granted_by   INTEGER NOT NULL REFERENCES users(id),
  approved_by  INTEGER REFERENCES users(id),
  state        TEXT NOT NULL DEFAULT 'pending',
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS store_access_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id    INTEGER NOT NULL REFERENCES store_access_grants(id),
  transfer_id TEXT,
  item_key    TEXT,
  qty         REAL,
  cost        REAL,
  month       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_holds (
  asset_id     INTEGER PRIMARY KEY,
  workshop_id  INTEGER NOT NULL,
  job_id       INTEGER NOT NULL,
  job_no       TEXT NOT NULL,
  claimed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transfers (
  id           TEXT PRIMARY KEY,
  from_ws      INTEGER NOT NULL,
  to_ws        INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  dispatched_at TEXT,
  accepted_at  TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS integrity_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  passed      INTEGER NOT NULL,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  report_json TEXT NOT NULL
);
CREATE INDEX idx_assets_code_norm ON assets(code_norm);
CREATE INDEX idx_assets_current_project ON assets(current_project_id);
CREATE INDEX idx_aliases_asset ON asset_aliases(asset_id);
CREATE INDEX idx_aliases_resolved ON asset_aliases(resolved);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_store_items_part ON store_items(part_number);
CREATE INDEX idx_prices_product ON product_prices(product_id, effective_from);
CREATE INDEX idx_service_specs_asset ON service_specs(asset_id);
CREATE INDEX idx_filter_prices_norm ON filter_prices(filter_no_norm);
CREATE INDEX idx_filter_xrefs_cat ON filter_xrefs(catalogue_id);
CREATE INDEX idx_filter_xrefs_norm ON filter_xrefs(part_number_norm);
CREATE INDEX idx_filter_xrefs_brand ON filter_xrefs(brand);
CREATE UNIQUE INDEX idx_item_cat_uniq ON item_categories(COALESCE(parent_id, 0), name_norm);
CREATE INDEX idx_item_cat_parent ON item_categories(parent_id);
CREATE INDEX idx_si_section ON stock_items(section, active);
CREATE INDEX idx_si_name ON stock_items(name);
CREATE INDEX idx_si_part ON stock_items(part_no);
CREATE INDEX idx_lube_alias_norm ON lubricant_aliases(raw_norm);
CREATE INDEX idx_tb_specs_kind ON tb_specs(kind, active);
CREATE INDEX idx_vlc_asset ON vehicle_lubricant_capacities(asset_id);
CREATE INDEX idx_vlc_ec ON vehicle_lubricant_capacities(ec_no);
CREATE INDEX idx_vlc_reg ON vehicle_lubricant_capacities(registration);
CREATE INDEX idx_vlc_cat ON vehicle_lubricant_capacities(category);
CREATE INDEX idx_mfa_rc_user ON mfa_recovery_codes(user_id);
CREATE INDEX idx_asset_moves ON asset_moves(asset_id, move_date);
CREATE INDEX idx_user_perms_user ON user_permissions(user_id);
CREATE INDEX idx_user_perms_sec ON user_permissions(section);
CREATE INDEX idx_user_caps_user ON user_capabilities(user_id);
CREATE INDEX idx_user_caps_cap ON user_capabilities(capability);
CREATE INDEX idx_delegations_stand_in ON stand_in_delegations(stand_in_id, active, start_date, end_date);
CREATE INDEX idx_delegations_granter ON stand_in_delegations(granter_id, active);
CREATE INDEX idx_idempotency_key ON idempotency_keys(key);
CREATE TRIGGER trg_users_workshop AFTER INSERT ON users WHEN NEW.workshop_id IS NULL
    BEGIN UPDATE users SET workshop_id = (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1) WHERE id = NEW.id; END;
