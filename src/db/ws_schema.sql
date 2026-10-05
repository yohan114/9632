-- WorkshopOne Per-Workshop Schema (70 Workshop Tables + Meta)

CREATE TABLE mrn_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn_id        INTEGER NOT NULL REFERENCES mrn(id) ON DELETE CASCADE,
  store_item_id INTEGER,
  description   TEXT NOT NULL,
  qty           REAL NOT NULL DEFAULT 0,
  unit          TEXT DEFAULT 'nos',
  qty_received  REAL NOT NULL DEFAULT 0,
  legacy_item_id INTEGER                     -- source items.id (bridges receipts.itemId -> GRN)
, category TEXT, purchase_source TEXT, category_id INTEGER, added_after_approval INTEGER NOT NULL DEFAULT 0, added_by TEXT, added_at TEXT, added_reason TEXT, purchased_at TEXT, purchased_by TEXT, supplier TEXT, invoice_no TEXT, invoice_date TEXT, purchase_amount REAL, source_changed_at TEXT, source_changed_by TEXT, source_changed_reason TEXT, source_changed_from TEXT, buying_priority TEXT DEFAULT 'P3_ROUTINE', priority_note TEXT, priority_updated_at TEXT, priority_updated_by TEXT, supply_route TEXT DEFAULT 'main_store', qty_approved REAL DEFAULT 0, qty_sent REAL DEFAULT 0, qty_issued REAL DEFAULT 0, auto_mtn_id INTEGER REFERENCES mtn(id), route_assigned_by TEXT, route_assigned_at TEXT, route_assigned_reason TEXT, qty_short REAL DEFAULT 0, discrepancy_reason TEXT);

CREATE TABLE grn (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_no         TEXT,
  mrn_id         INTEGER REFERENCES mrn(id),
  mrn_line_id    INTEGER REFERENCES mrn_lines(id),
  store_item_id  INTEGER,
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
, priced_at TEXT, grn_date TEXT, received_part_no TEXT, store_id INTEGER, voucher_id INTEGER REFERENCES grn_vouchers(id), po_no TEXT, delivery_note_no TEXT, bin_card_page TEXT, prepared_by TEXT, prepared_sig TEXT, prepared_at TEXT, approved_by TEXT, approved_sig TEXT, approved_at TEXT, unit TEXT DEFAULT "nos", status TEXT DEFAULT "received", project_site TEXT, rejection_reason TEXT, chain_no TEXT);

CREATE TABLE issues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id      INTEGER,
  job_id        INTEGER REFERENCES job_cards(id),
  store_item_id INTEGER,
  description   TEXT NOT NULL,
  qty           REAL NOT NULL DEFAULT 1,
  unit_price    REAL,                         -- NULL = awaiting price
  issue_date    TEXT NOT NULL DEFAULT (date('now')),
  issued_by     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
, category TEXT, total_cost REAL GENERATED ALWAYS AS (qty * COALESCE(unit_price, 0)) VIRTUAL, service_id INTEGER REFERENCES service_jobs(id), category_id INTEGER, grn_id INTEGER, mrn_no TEXT, voided INTEGER NOT NULL DEFAULT 0, voided_reason TEXT, store_id INTEGER, min_id INTEGER REFERENCES min_notes(id), min_no TEXT, purpose TEXT, unit TEXT DEFAULT "nos", mrn_line_id INTEGER REFERENCES mrn_lines(id), chain_no TEXT);

CREATE TABLE mtn (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mtn_no         TEXT NOT NULL UNIQUE,        -- continues existing seq (~57xxx)
  txn_date       TEXT NOT NULL DEFAULT (date('now')),
  store_item_id  INTEGER,
  description    TEXT,
  qty            REAL NOT NULL DEFAULT 0,
  from_location  TEXT,
  to_location    TEXT,
  from_asset_id  INTEGER,
  to_asset_id    INTEGER,
  transferred_by TEXT,
  received_by    TEXT,
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
, category TEXT, category_id INTEGER, from_place TEXT, to_place TEXT, mr_no TEXT, prepared_by TEXT, prepared_sig TEXT, prepared_at TEXT, approved_by TEXT, approved_sig TEXT, approved_at TEXT, received_sig TEXT, received_at TEXT, accepted_by TEXT, accepted_sig TEXT, accepted_at TEXT, status TEXT DEFAULT "draft", prepared_designation TEXT, approved_designation TEXT, received_designation TEXT, accepted_designation TEXT, rejection_reason TEXT, workshop_id INTEGER, mrn_id INTEGER REFERENCES mrn(id), auto_generated INTEGER DEFAULT 0, chain_no TEXT);

CREATE TABLE general_item_txns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_item_id  INTEGER NOT NULL,
  txn_type       TEXT NOT NULL CHECK (txn_type IN ('receipt','issue','opening','adjustment')),
  qty            REAL NOT NULL,               -- signed by convention: + receipt, - issue
  balance_after  REAL NOT NULL,
  asset_id       INTEGER,
  job_id         INTEGER REFERENCES job_cards(id),
  unit_price     REAL,
  ref            TEXT,
  txn_date       TEXT NOT NULL DEFAULT (date('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
, source TEXT, store_id INTEGER);

CREATE TABLE stock_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('receipt','issue','opening','adjustment','transfer')),
  qty           REAL NOT NULL,               -- signed: + in, - out
  balance_after REAL NOT NULL,
  unit_price    REAL,                         -- price at time of txn
  asset_id      INTEGER,
  project_id    INTEGER,
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
, store_id INTEGER);

CREATE TABLE stock_counts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL,
  period        TEXT NOT NULL,               -- 'YYYY-MM'
  book_qty      REAL,
  counted_qty   REAL,
  variance      REAL,                         -- counted - book
  note          TEXT,
  counted_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, period)
);

CREATE TABLE batteries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_no        TEXT NOT NULL UNIQUE,      -- one serial = one battery
  brand            TEXT,
  capacity_ah      REAL,
  condition        TEXT,                       -- raw (real: new/old/Expired/...)
  purchase_date    TEXT,
  warranty_date    TEXT,                       -- expiry / warranty end
  current_asset_id INTEGER,
  state            TEXT NOT NULL DEFAULT 'in_store', -- raw (real: In Store/Disposed/...)
  state_norm       TEXT,                       -- normalised: installed/in_store/handed_over/decommissioned
  photo_path       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
, store_id INTEGER, spec_id INTEGER);

CREATE TABLE battery_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  battery_id    INTEGER NOT NULL REFERENCES batteries(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,                 -- raw action (real: register/add/decommission/transfer/...)
  from_asset_id INTEGER,
  to_asset_id   INTEGER,
  reason        TEXT,
  mtn_ref       TEXT,                          -- e.g. MTN-57814
  photo_path    TEXT,
  user_id       INTEGER,
  event_date    TEXT NOT NULL DEFAULT (date('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE labour_rates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanic       TEXT NOT NULL,
  rate           REAL NOT NULL,               -- hourly rate
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mechanics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,               -- canonical display name (matches labour_rates.mechanic)
  name_norm  TEXT NOT NULL UNIQUE,        -- uppercase, symbols stripped
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, status TEXT NOT NULL DEFAULT 'active', left_date TEXT, left_reason TEXT, notes TEXT);

CREATE TABLE mechanic_aliases (
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

CREATE TABLE historical_job_costs (
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

CREATE TABLE job_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('transport_manager','operational_manager')),
  approver_id INTEGER,
  decision    TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
, signed_name TEXT);

CREATE TABLE job_daily_work (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  work_date     TEXT NOT NULL DEFAULT (date('now')),
  mechanic      TEXT,
  description   TEXT,
  hours         REAL NOT NULL DEFAULT 0,
  is_external   INTEGER NOT NULL DEFAULT 0,
  external_value REAL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
, outside_labour REAL, asset_id INTEGER, travel INTEGER NOT NULL DEFAULT 0);

CREATE TABLE job_labour (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  mechanic  TEXT,
  hours     REAL NOT NULL DEFAULT 0,
  rate      REAL,
  amount    REAL,
  work_date TEXT
);

CREATE TABLE job_costs (
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

CREATE TABLE mrn_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_id      INTEGER NOT NULL REFERENCES mrn(id) ON DELETE CASCADE,
    stage       TEXT NOT NULL,          -- 'certify' | 'approve'
    role        TEXT,                   -- role the signer acted as
    approver_id INTEGER,
    signed_name TEXT,                   -- e-signature: signer's full name at signing
    decision    TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  , signature TEXT);

CREATE TABLE job_requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    jr_no             TEXT NOT NULL UNIQUE,      -- editable, continues from the last number
    req_date          TEXT NOT NULL DEFAULT (date('now')),
    asset_id          INTEGER,
    project_id        INTEGER,
    type              TEXT NOT NULL DEFAULT 'repair',  -- repair | service
    severity          TEXT,                     -- major | minor
    priority          TEXT,                     -- normal | urgent
    description       TEXT,
    required_date     TEXT,
    approval_status   TEXT NOT NULL DEFAULT 'requested', -- requested | certified | approved | rejected
    requested_by      TEXT,
    requested_by_user INTEGER,
    requested_sig     TEXT,
    certified_by      TEXT, certified_at TEXT, certified_sig TEXT,
    approved_by       TEXT, approved_at TEXT, approved_sig TEXT,
    job_id            INTEGER REFERENCES job_cards(id),  -- the job card created on final approval
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  , workshop_id INTEGER, certified_seal TEXT);

CREATE TABLE job_request_approvals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
    stage          TEXT NOT NULL,          -- 'certify' | 'approve'
    role           TEXT,
    approver_id    INTEGER,
    signed_name    TEXT,
    signature      TEXT,
    decision       TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason         TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE service_jobs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_service_id  INTEGER,
    vehicle_label      TEXT,
    asset_id           INTEGER,
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
  , upkeeping TEXT, reg_id TEXT, model_no TEXT, labour_rate REAL DEFAULT 20, sundry_rate REAL DEFAULT 5, outside_estimate REAL DEFAULT 0, store_id INTEGER, workshop_id INTEGER);

CREATE TABLE service_filters (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id     INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
    filter_no      TEXT,
    filter_no_norm TEXT,
    category       TEXT,
    action_type    TEXT,
    qty            INTEGER DEFAULT 1,
    price          REAL DEFAULT 0
  , required_no TEXT, required_no_norm TEXT);

CREATE TABLE service_oils (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
    oil_name    TEXT,
    oil_type    TEXT,
    action_type TEXT,
    qty         REAL DEFAULT 0,
    price       REAL DEFAULT 0
  );

CREATE TABLE service_parts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
    description TEXT,
    unit        TEXT,
    rate        REAL DEFAULT 0,
    qty         REAL DEFAULT 0,
    amount      REAL DEFAULT 0
  );

CREATE TABLE vehicle_monthly_costs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id    INTEGER NOT NULL,
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
  );

CREATE TABLE filter_stock (
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

CREATE TABLE filter_stock_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filter_id     INTEGER NOT NULL REFERENCES filter_stock(id),
    kind          TEXT NOT NULL CHECK (kind IN ('receipt','issue','adjustment')),
    qty           REAL NOT NULL,
    balance_after REAL NOT NULL,
    asset_id      INTEGER,
    job_id        INTEGER REFERENCES job_cards(id),
    unit_price    REAL,
    note          TEXT,
    txn_date      TEXT NOT NULL DEFAULT (date('now')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE monthly_report_inputs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    year       INTEGER NOT NULL,
    month      INTEGER NOT NULL,            -- 1..12
    sheet      TEXT NOT NULL,               -- 'tyre' | 'battery' | 'fuel' | 'other' | 'salary'
    seq        INTEGER NOT NULL DEFAULT 0,  -- row order within the sheet
    asset_id   INTEGER,
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
  , line_date TEXT, workshop_id INTEGER);

CREATE TABLE tyre_battery_issues (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,               -- 'tyre' | 'battery'
    issue_date    TEXT,                         -- YYYY-MM-DD (carried forward on blank rows at import)
    vehicle       TEXT,                         -- raw vehicle / machine label
    asset_id      INTEGER,
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
  , spec_id INTEGER, mrn_line_id INTEGER REFERENCES mrn_lines(id), serial_no TEXT, position TEXT, issued_by TEXT, job_id INTEGER REFERENCES job_cards(id), store_id INTEGER, unit_id INTEGER, old_unit_id INTEGER);

CREATE TABLE stock_opening (
  section    TEXT PRIMARY KEY,              -- oil | filter | battery | tyre | general
  mode       TEXT NOT NULL,                 -- history | cutover | count
  cutover    TEXT,                          -- YYYY-MM-DD when mode = cutover
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE job_reopens (
  id                INTEGER PRIMARY KEY,
  job_id            INTEGER NOT NULL REFERENCES job_cards(id),
  reopened_at       TEXT NOT NULL DEFAULT (datetime('now')),
  reopened_by       INTEGER,
  reason            TEXT NOT NULL,
  prev_status       TEXT,
  prev_completed_at TEXT,
  prev_closed_at    TEXT,
  prev_total_cost   REAL,
  reclosed_at       TEXT
);

CREATE TABLE service_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id  INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes  INTEGER NOT NULL,
  note        TEXT,
  data        BLOB NOT NULL,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE job_summary_notes (
  job_id            INTEGER PRIMARY KEY REFERENCES job_cards(id) ON DELETE CASCADE,
  completed_repairs TEXT,
  pending_repairs   TEXT,
  job_status        TEXT,          -- free text: Ongoing / No Technicians / sent to Colombo …
  spare_parts       TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by        INTEGER
);

CREATE TABLE pending_part_notes (
  mrn_line_id INTEGER PRIMARY KEY REFERENCES mrn_lines(id) ON DELETE CASCADE,
  remarks     TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER
);

CREATE TABLE receipt_price_notes (
  grn_id     INTEGER PRIMARY KEY REFERENCES grn(id) ON DELETE CASCADE,
  remarks    TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
);

CREATE TABLE mtn_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mtn_id         INTEGER NOT NULL REFERENCES mtn(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 1,
  store_item_id  INTEGER,
  description    TEXT,
  qty            REAL NOT NULL DEFAULT 0,
  unit           TEXT,
  category       TEXT,
  category_id    INTEGER,
  from_location  TEXT,
  to_location    TEXT,
  from_asset_id  INTEGER,
  to_asset_id    INTEGER,
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
, from_place TEXT, to_place TEXT, from_store_id INTEGER, to_store_id INTEGER, value REAL DEFAULT 0, mr_no TEXT, remarks TEXT, mrn_id INTEGER REFERENCES mrn(id), mrn_line_id INTEGER REFERENCES mrn_lines(id), qty_received REAL, qty_short REAL DEFAULT 0, discrepancy_reason TEXT);

CREATE TABLE battery_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  battery_id  INTEGER NOT NULL REFERENCES batteries(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL DEFAULT 1,
  photo       TEXT NOT NULL,              -- data:image/...;base64,...
  note        TEXT,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE stock_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  section       TEXT NOT NULL,              -- oil | filter | battery | tyre | general
  kind          TEXT NOT NULL,              -- in | out | opening | adjust
  item_key      TEXT NOT NULL,              -- normalised item identity within the section
  item_name     TEXT,                       -- readable description as recorded
  qty           REAL NOT NULL DEFAULT 0,    -- always positive; `kind` gives the direction
  unit_price    REAL,
  txn_date      TEXT,
  asset_id      INTEGER,
  job_id        INTEGER REFERENCES job_cards(id),
  mrn_line_id   INTEGER REFERENCES mrn_lines(id),
  store_item_id INTEGER,
  ref           TEXT,                       -- MRN/GRN/MTN number, service job no, etc.
  note          TEXT,
  source_table  TEXT NOT NULL,
  source_id     INTEGER NOT NULL,
  -- 1 = counts toward the balance. Movements from before a section's cut-over are kept at 0:
  -- they stay fully visible as history without dragging the balance negative.
  counts        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')), grn_id INTEGER, store_id INTEGER,
  -- item_key is part of the key because ONE source row can move TWO DIFFERENT items: a service
  -- line that reads "JS-1030 & 278 607 989 916" fits two filters. Without it the second movement
  -- collided with the first and INSERT OR IGNORE dropped it in silence. A rebuild stays
  -- idempotent — the same source row always produces the same (source, kind, item) tuples.
  UNIQUE (source_table, source_id, kind, item_key)
);

CREATE TABLE tb_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id       INTEGER REFERENCES tyre_battery_issues(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('tyre','battery')),
  asset_id       INTEGER,
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

CREATE TABLE "tb_request_lines" (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn_line_id    INTEGER NOT NULL REFERENCES mrn_lines(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('tyre','battery','tube','flap')),
  spec_id        INTEGER,
  asset_id       INTEGER,
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

CREATE TABLE mrn_line_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_line_id INTEGER NOT NULL REFERENCES mrn_lines(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    image TEXT NOT NULL,
    note TEXT,
    uploaded_by INTEGER,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE job_reopen_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES job_cards(id),
  requested_by  INTEGER,
  requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','refused')),
  decided_by    INTEGER,
  decided_at    TEXT,
  decision_note TEXT
);

CREATE TABLE mechanic_attendance (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanic_id     INTEGER NOT NULL REFERENCES mechanics(id),
  work_date       TEXT NOT NULL,              -- YYYY-MM-DD, the day the shift started
  time_in         TEXT,                       -- HH:MM (24 h)
  time_out        TEXT,                       -- HH:MM; earlier than time_in = an overnight shift
  break_minutes   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'present'
                  CHECK (status IN ('present','absent','leave','half_day','holiday')),
  note            TEXT,                       -- e.g. "at site X"
  unbooked_reason TEXT,                       -- why some hours at work are not on a job
  recorded_by     INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mechanic_id, work_date)
);

CREATE TABLE "job_cards" (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_no               TEXT NOT NULL UNIQUE,  -- YYYY/M/R/seq (repair) or YYYY/M/S/seq (service)
  ref                  TEXT,
  legacy_ref           TEXT,                  -- c_job "Ref." (e.g. 24-063)
  is_historical        INTEGER NOT NULL DEFAULT 0, -- imported history: keep recorded totals, don't recompute
  synthesized_no       INTEGER NOT NULL DEFAULT 0, -- job_no was generated (source had none)
  asset_id             INTEGER,
  project_id           INTEGER,
  site                 TEXT,
  type                 TEXT NOT NULL DEFAULT 'repair' CHECK (type IN ('repair','service')),
  severity             TEXT CHECK (severity IN ('major','minor')),
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'REQUESTED'
                         CHECK (status IN ('PARTIALLY_CLOSED','REQUESTED','APPROVED_TRANSPORT','APPROVED_OPERATIONS',
                                           'IN_WORKSHOP','IN_PROGRESS','WORK_COMPLETE','CLOSED','REJECTED')),
  requested_by         TEXT,
  requested_by_user    INTEGER,
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
, recorded_cost REAL, other_cost REAL NOT NULL DEFAULT 0, outside_estimate REAL DEFAULT 0, original_completed_at TEXT, partial_closed_at TEXT, partial_closed_by INTEGER, partial_note TEXT, continues_job_id INTEGER REFERENCES job_cards(id), workshop_id INTEGER, field INTEGER NOT NULL DEFAULT 0, field_place TEXT, field_location TEXT, breakdown INTEGER NOT NULL DEFAULT 0, reported_at TEXT, arrived_at TEXT, working_at TEXT, field_km REAL, field_km_rate REAL, job_request_id INTEGER REFERENCES job_requests(id));

CREATE TABLE mechanic_workshops (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanic_id  INTEGER NOT NULL REFERENCES mechanics(id),
  workshop_id  INTEGER NOT NULL,
  from_date    TEXT NOT NULL,                    -- YYYY-MM-DD
  set_by       INTEGER,
  set_at       TEXT NOT NULL DEFAULT (datetime('now')),
  note         TEXT,
  UNIQUE (mechanic_id, from_date)
);

CREATE TABLE store_counts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL,
  section      TEXT NOT NULL,
  item_key     TEXT NOT NULL,
  item_name    TEXT,
  count_date   TEXT NOT NULL,                    -- YYYY-MM-DD
  book_qty     REAL NOT NULL,
  counted_qty  REAL NOT NULL,
  delta        REAL NOT NULL,                    -- counted - book
  note         TEXT,
  counted_by   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
, session_id INTEGER REFERENCES count_sessions(id));

CREATE TABLE store_reorder (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL,
  section    TEXT NOT NULL,
  item_key   TEXT NOT NULL,
  level      REAL NOT NULL,
  set_by     INTEGER,
  set_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, section, item_key)
);

CREATE TABLE issue_returns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id     INTEGER NOT NULL REFERENCES issues(id),
  qty          REAL NOT NULL,
  return_date  TEXT NOT NULL,                    -- YYYY-MM-DD
  note         TEXT,
  store_id     INTEGER,
  job_part_id  INTEGER REFERENCES job_parts(id), -- the negative line that takes the cost off a job, if any
  returned_by  INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE job_workshop_moves (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  from_workshop_id  INTEGER,
  to_workshop_id    INTEGER,
  reason            TEXT NOT NULL,
  moved_by          INTEGER,
  moved_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE count_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  count_no       TEXT UNIQUE,                    -- ST-2026-0001
  store_id       INTEGER NOT NULL,
  kind           TEXT NOT NULL,                  -- all | general | oil | filter | tyre | battery
  scope          TEXT NOT NULL DEFAULT 'full',   -- full (every item) | quick (one item, ST-D14)
  status         TEXT NOT NULL DEFAULT 'counting', -- counting | submitted | approved | cancelled
  count_date     TEXT NOT NULL,                  -- YYYY-MM-DD the count began
  note           TEXT,
  started_by     INTEGER,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_by   INTEGER,
  submitted_at   TEXT,
  decided_by     INTEGER,
  decided_at     TEXT,
  decision_note  TEXT                            -- why it was sent back or cancelled
);

CREATE TABLE count_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  section         TEXT NOT NULL,
  item_key        TEXT NOT NULL,
  item_name       TEXT,
  unit            TEXT,
  unit_price      REAL,                          -- to value the difference
  book_start      REAL NOT NULL,                 -- the book when the count began
  book_at_count   REAL,                          -- the book when this item was counted
  counted_qty     REAL,                          -- NULL = not counted yet
  containers      REAL,                          -- lubricants (ST-D16): full drums or cans …
  container_size  REAL,                          -- … of this many litres each …
  loose_qty       REAL,                          -- … plus the part-used one, by dip reading
  note            TEXT,
  added           INTEGER NOT NULL DEFAULT 0,    -- found on the shelf, not on the list
  counted_by      INTEGER,
  counted_on      TEXT,                          -- YYYY-MM-DD
  counted_at      TEXT,
  seen_count_id   INTEGER,                       -- the item's last correction (store_counts.id) when counted
  UNIQUE (session_id, section, item_key)
);

CREATE TABLE tyres (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_no         TEXT NOT NULL UNIQUE,
  spec_id           INTEGER,
  brand             TEXT,
  state             TEXT NOT NULL DEFAULT 'in_store', -- in_store | installed | removed | repair | retread | warranty | scrap | lost | disposed
  current_asset_id  INTEGER,
  position          TEXT,                              -- FL, FR, RL1, RR1, SPARE … while fitted
  store_id          INTEGER,
  warranty_date     TEXT,
  photo_path        TEXT,                              -- the cover: the first of tyre_photos
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tyre_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tyre_id     INTEGER NOT NULL REFERENCES tyres(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL DEFAULT 1,
  photo       TEXT NOT NULL,              -- data:image/...;base64,...
  note        TEXT,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tyre_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tyre_id       INTEGER NOT NULL REFERENCES tyres(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,                 -- add | install | remove | repair | retread | warranty | scrap | lost | return | dispose
  from_asset_id INTEGER,
  to_asset_id   INTEGER,
  position      TEXT,
  km_reading    REAL,
  reason        TEXT,
  issue_id      INTEGER REFERENCES tyre_battery_issues(id),
  user_id       INTEGER,
  event_date    TEXT NOT NULL DEFAULT (date('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE disposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  disposal_no   TEXT UNIQUE,                   -- DN-2026-0001
  store_id      INTEGER,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | approved | cancelled
  buyer         TEXT,
  amount        REAL,                          -- what the buyer pays (Rs)
  sale_date     TEXT,                          -- YYYY-MM-DD it leaves the store
  note          TEXT,
  created_by    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by    INTEGER,
  decided_at    TEXT,
  decision_note TEXT
);

CREATE TABLE disposal_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  disposal_id  INTEGER NOT NULL REFERENCES disposals(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('tyre','battery','part','waste_oil')),
  tyre_id      INTEGER REFERENCES tyres(id),
  battery_id   INTEGER REFERENCES batteries(id),
  description  TEXT,
  qty          REAL NOT NULL DEFAULT 1,
  unit         TEXT                            -- nos | L | kg
);

CREATE TABLE "workday_signoffs" (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date     TEXT NOT NULL,
        workshop_id   INTEGER NOT NULL DEFAULT 0,
        signed_by     INTEGER,
        signed_at     TEXT,
        unlocked_by   INTEGER,
        unlocked_at   TEXT,
        unlock_reason TEXT,
        UNIQUE (work_date, workshop_id)
      );

CREATE TABLE "daily_report_snapshots" (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          kind         TEXT NOT NULL,
          report_date  TEXT NOT NULL,
          workshop_id  INTEGER NOT NULL DEFAULT 0,
          generated_at TEXT NOT NULL DEFAULT (datetime('now')),
          generated_by INTEGER,
          row_count    INTEGER NOT NULL DEFAULT 0,
          payload      TEXT NOT NULL,
          UNIQUE(kind, report_date, workshop_id)
        );

CREATE TABLE "job_parts" (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  source_type        TEXT NOT NULL CHECK (source_type IN ('return','grn','issue','oil','general','external')),
  source_id          INTEGER,               -- id in grn / issues / stock_ledger / general_item_txns
  description        TEXT,
  qty                REAL NOT NULL DEFAULT 1,
  unit_price         REAL,                   -- NULL = awaiting price (blocks closure)
  is_external_repair INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
, mrn_line_id INTEGER);

CREATE TABLE job_hold_reasons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  reason    TEXT NOT NULL,          -- waiting_mechanic | waiting_parts | outside_repair | waiting_decision | vehicle_away | other
  note      TEXT,
  set_by    INTEGER,
  set_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mrn_line_priority_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn_line_id   INTEGER NOT NULL REFERENCES mrn_lines(id) ON DELETE CASCADE,
  old_priority  TEXT,
  new_priority  TEXT NOT NULL,
  note          TEXT,
  changed_by    TEXT NOT NULL,
  changed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE "grn_vouchers" (
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
      , chain_no TEXT);

CREATE TABLE grn_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id  INTEGER NOT NULL,
    stage       TEXT NOT NULL,          -- 'prepare' | 'approve'
    role        TEXT,
    approver_id INTEGER,
    signed_name TEXT,
    signature   TEXT,
    decision    TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE min_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    min_id      INTEGER NOT NULL,
    stage       TEXT NOT NULL,          -- 'request' | 'approve' | 'receive'
    role        TEXT,
    approver_id INTEGER,
    signed_name TEXT,
    signature   TEXT,
    decision    TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE mtn_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mtn_id      INTEGER NOT NULL REFERENCES mtn(id) ON DELETE CASCADE,
    stage       TEXT NOT NULL,          -- 'prepare' | 'approve' | 'dispatch' | 'accept'
    role        TEXT,
    approver_id INTEGER,
    signed_name TEXT,
    signature   TEXT,
    decision    TEXT NOT NULL,          -- 'approved' | 'rejected'
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE workshop_tools (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_code           TEXT UNIQUE NOT NULL,             -- e.g. TL-MECH-001, TL-COM-014
  name                TEXT NOT NULL,                    -- Tool title / description
  category            TEXT NOT NULL DEFAULT 'hand_tool',-- hand_tool, power_tool, pneumatic, measuring, lifting, welding, special
  type                TEXT NOT NULL DEFAULT 'common',   -- 'common' (shared workshop tool) | 'mechanic' (assigned toolbox)
  mechanic_id         INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  mechanic_name       TEXT,                             -- Denormalized for display & history
  toolbox_name        TEXT,                             -- e.g. "Sunil's Heavy Tool Chest"
  brand               TEXT,                             -- e.g. Koken, Makita, Snap-on, Stanley
  model_no            TEXT,
  serial_no           TEXT,
  specifications      TEXT,
  workshop_id         INTEGER,
  store_id            INTEGER,
  location            TEXT,                             -- Tool Crib / Locker / Bay
  purchase_date       TEXT,                             -- YYYY-MM-DD
  purchase_cost       REAL DEFAULT 0,
  replacement_cost    REAL DEFAULT 0,
  condition           TEXT NOT NULL DEFAULT 'good',     -- 'good', 'fair', 'worn', 'damaged', 'broken', 'scrapped'
  status              TEXT NOT NULL DEFAULT 'in_store', -- 'in_store', 'issued', 'in_use', 'damaged', 'pending_scrap', 'scrapped', 'missing'
  active              INTEGER NOT NULL DEFAULT 1,       -- 0 when scrapped
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tool_issue_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  log_no              TEXT UNIQUE NOT NULL,             -- e.g. TIL-2026-0001
  tool_id             INTEGER NOT NULL REFERENCES workshop_tools(id),
  mechanic_id         INTEGER REFERENCES mechanics(id),
  issued_to_name      TEXT NOT NULL,                    -- Borrower name
  job_id              INTEGER REFERENCES job_cards(id), -- Optional job card link
  job_no              TEXT,
  issue_date          TEXT NOT NULL,                    -- YYYY-MM-DD
  issue_time          TEXT,                             -- HH:MM
  condition_out       TEXT NOT NULL DEFAULT 'good',
  issued_by           INTEGER NOT NULL,
  issued_by_name      TEXT,
  purpose             TEXT,                             -- Task / purpose
  expected_return_date TEXT,
  return_date         TEXT,                             -- YYYY-MM-DD (NULL while out)
  return_time         TEXT,                             -- HH:MM
  condition_in        TEXT,                             -- 'good', 'fair', 'damaged', 'broken', 'missing'
  received_by         INTEGER,
  received_by_name    TEXT,
  return_notes        TEXT,
  status              TEXT NOT NULL DEFAULT 'issued',   -- 'issued', 'returned', 'damaged_on_return', 'scrapped', 'lost'
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tool_scrap_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no          TEXT UNIQUE NOT NULL,             -- e.g. TSR-2026-0001
  tool_id             INTEGER NOT NULL REFERENCES workshop_tools(id),
  tool_code           TEXT NOT NULL,
  tool_name           TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'common',   -- 'common' | 'mechanic'
  mechanic_id         INTEGER REFERENCES mechanics(id),
  mechanic_name       TEXT,                             -- Specific mechanic whose tool broke
  damage_date         TEXT NOT NULL,                    -- YYYY-MM-DD
  damage_reason       TEXT NOT NULL,                    -- Cause of damage / breakage
  incident_description TEXT,
  reported_by         INTEGER NOT NULL,
  reported_by_name    TEXT,
  reported_at         TEXT NOT NULL DEFAULT (datetime('now')),
  status              TEXT NOT NULL DEFAULT 'pending_approval', -- 'pending_approval', 'approved', 'rejected', 'under_repair'
  engineer_id         INTEGER,     -- Engineer who reviewed
  engineer_name       TEXT,
  engineer_role       TEXT,                             -- "Mechanical Engineer" / "Assistant Engineer"
  engineer_decision   TEXT,                             -- 'approved', 'rejected', 'repair'
  engineer_remarks    TEXT,                             -- Technical assessment notes
  engineer_signature  TEXT,                             -- e-signature image or data URI
  decided_at          TEXT,
  scrap_date          TEXT,
  scrap_bin_ref       TEXT,                             -- e.g. "Scrap Yard Bin A"
  replacement_requested INTEGER NOT NULL DEFAULT 0,
  replacement_mrn_id  INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE delivery_discrepancies (
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
  reported_by_user    INTEGER,
  reported_at         TEXT DEFAULT (datetime('now')),
  resolution_notes    TEXT,
  resolved_by         TEXT,
  resolved_at         TEXT,
  created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "min_notes" (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          min_no        TEXT NOT NULL UNIQUE,
          issue_date    TEXT NOT NULL DEFAULT (date('now')),
          project_id    INTEGER,
          asset_id      INTEGER,
          job_id        INTEGER REFERENCES job_cards(id),
          workshop_id   INTEGER,
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
        , chain_no TEXT);

CREATE TABLE "mrn" (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn_no        TEXT NOT NULL UNIQUE,         -- continues existing seq (~167xxx)
  req_date      TEXT NOT NULL DEFAULT (date('now')),
  asset_id      INTEGER,
  project_id    INTEGER,
  job_id        INTEGER REFERENCES job_cards(id),
  purpose       TEXT,
  requested_by  TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('closed','open','partially_received','received','cancelled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
, purchase_source TEXT, required_date TEXT, approval_status TEXT NOT NULL DEFAULT 'requested', certified_by TEXT, certified_at TEXT, approved_by TEXT, approved_at TEXT, requested_sig TEXT, certified_sig TEXT, approved_sig TEXT, request_type TEXT NOT NULL DEFAULT 'vehicle', tb_kind TEXT, purchase_requested_at TEXT, purchase_requested_by TEXT, purchase_ref TEXT, workshop_id INTEGER, raised_by_user INTEGER, certified_seal TEXT, chain_no TEXT);


CREATE TABLE IF NOT EXISTS ws_meta (
  workshop_id INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mrn_lines_mrn ON mrn_lines(mrn_id);
CREATE INDEX idx_grn_mrn ON grn(mrn_id);
CREATE INDEX idx_grn_no ON grn(grn_no);
CREATE INDEX idx_issues_asset ON issues(asset_id);
CREATE INDEX idx_issues_job ON issues(job_id);
CREATE INDEX idx_mtn_no ON mtn(mtn_no);
CREATE INDEX idx_gen_txn_item ON general_item_txns(store_item_id);
CREATE INDEX idx_gen_txn_job ON general_item_txns(job_id);
CREATE INDEX idx_ledger_product ON stock_ledger(product_id);
CREATE INDEX idx_ledger_asset ON stock_ledger(asset_id);
CREATE INDEX idx_ledger_job ON stock_ledger(job_id);
CREATE INDEX idx_ledger_date ON stock_ledger(txn_date);
CREATE INDEX idx_batteries_current ON batteries(current_asset_id);
CREATE INDEX idx_batt_events_batt ON battery_events(battery_id);
CREATE INDEX idx_labour_mech ON labour_rates(mechanic, effective_from);
CREATE INDEX idx_mech_alias_mech ON mechanic_aliases(mechanic_id);
CREATE INDEX idx_mech_alias_resolved ON mechanic_aliases(resolved);
CREATE INDEX idx_approvals_job ON job_approvals(job_id);
CREATE INDEX idx_daily_job ON job_daily_work(job_id);
CREATE INDEX idx_job_labour_job ON job_labour(job_id);
CREATE INDEX idx_job_costs_job ON job_costs(job_id);
CREATE INDEX idx_mrn_approvals ON mrn_approvals(mrn_id);
CREATE INDEX idx_job_requests_asset ON job_requests(asset_id);
CREATE INDEX idx_job_requests_status ON job_requests(approval_status);
CREATE INDEX idx_jr_approvals ON job_request_approvals(job_request_id);
CREATE INDEX idx_service_jobs_asset ON service_jobs(asset_id);
CREATE INDEX idx_service_jobs_date ON service_jobs(service_date);
CREATE INDEX idx_service_filters_svc ON service_filters(service_id);
CREATE INDEX idx_service_filters_norm ON service_filters(filter_no_norm);
CREATE INDEX idx_service_oils_svc ON service_oils(service_id);
CREATE INDEX idx_service_parts_svc ON service_parts(service_id);
CREATE INDEX idx_mrn_approvals_mrn ON mrn_approvals(mrn_id);
CREATE INDEX idx_vmc_period ON vehicle_monthly_costs(year, month);
CREATE INDEX idx_filter_stock_type ON filter_stock(filter_type);
CREATE INDEX idx_filter_stock_part ON filter_stock(part_no);
CREATE INDEX idx_fsl_filter ON filter_stock_ledger(filter_id);
CREATE INDEX idx_fsl_asset ON filter_stock_ledger(asset_id);
CREATE INDEX idx_fsl_job ON filter_stock_ledger(job_id);
CREATE INDEX idx_fsl_date ON filter_stock_ledger(txn_date);
CREATE INDEX idx_mri_period ON monthly_report_inputs(year, month, sheet);
CREATE INDEX idx_tbi_kind_date ON tyre_battery_issues(kind, issue_date);
CREATE INDEX idx_tbi_catnorm ON tyre_battery_issues(kind, category_norm);
CREATE INDEX idx_grn_line ON grn(mrn_line_id);
CREATE INDEX idx_grn_unpriced ON grn(mrn_line_id) WHERE unit_price IS NULL;
CREATE INDEX idx_mrn_lines_legacy ON mrn_lines(legacy_item_id);
CREATE INDEX idx_dw_date ON job_daily_work(work_date);
CREATE INDEX idx_jl_date ON job_labour(work_date);
CREATE INDEX idx_job_reopens_job ON job_reopens(job_id);
CREATE INDEX idx_issues_grn ON issues(grn_id);
CREATE INDEX idx_svc_attach ON service_attachments(service_id);
CREATE INDEX idx_mtn_lines_mtn ON mtn_lines(mtn_id);
CREATE INDEX idx_battery_photos ON battery_photos(battery_id, seq);
CREATE INDEX idx_sm_section ON stock_moves(section, item_key);
CREATE INDEX idx_sm_date ON stock_moves(txn_date);
CREATE INDEX idx_sm_asset ON stock_moves(asset_id);
CREATE INDEX idx_sm_kind ON stock_moves(section, kind);
CREATE INDEX idx_sm_mrn_line ON stock_moves(mrn_line_id);
CREATE INDEX idx_sm_grn ON stock_moves(grn_id);
CREATE INDEX idx_tb_returns_issue ON tb_returns(issue_id);
CREATE INDEX idx_tb_returns_cond ON tb_returns(kind, condition);
CREATE INDEX idx_tb_reqline_asset ON tb_request_lines(asset_id);
CREATE INDEX idx_mrn_line_invoices_line ON mrn_line_invoices(mrn_line_id);
CREATE INDEX idx_mrn_lines_purchase ON mrn_lines(purchase_source, purchased_at);
CREATE INDEX idx_job_reopen_req_job ON job_reopen_requests(job_id);
CREATE INDEX idx_job_reopen_req_status ON job_reopen_requests(status);
CREATE INDEX idx_attendance_date ON mechanic_attendance(work_date);
CREATE INDEX idx_jobs_asset ON job_cards(asset_id);
CREATE INDEX idx_jobs_status ON job_cards(status);
CREATE INDEX idx_jobs_project ON job_cards(project_id);
CREATE INDEX idx_grn_item ON grn(store_item_id, id);
CREATE INDEX idx_grn_desc ON grn(LOWER(TRIM(description)));
CREATE INDEX idx_mech_ws ON mechanic_workshops(mechanic_id, from_date);
CREATE INDEX idx_store_counts ON store_counts(store_id, section, item_key);
CREATE INDEX idx_issue_returns ON issue_returns(issue_id);
CREATE INDEX idx_job_ws_moves ON job_workshop_moves(job_id);
CREATE INDEX idx_job_ws_moves_at ON job_workshop_moves(moved_at);
CREATE INDEX idx_count_sessions ON count_sessions(store_id, status);
CREATE INDEX idx_count_lines ON count_lines(session_id);
CREATE INDEX idx_tyres_asset ON tyres(current_asset_id, position);
CREATE INDEX idx_tyre_photos ON tyre_photos(tyre_id, seq);
CREATE INDEX idx_tyre_events ON tyre_events(tyre_id);
CREATE INDEX idx_disposals ON disposals(status, store_id);
CREATE INDEX idx_disposal_lines ON disposal_lines(disposal_id);
CREATE INDEX idx_jobs_workshop ON job_cards(workshop_id);
CREATE INDEX idx_jr_workshop ON job_requests(workshop_id);
CREATE INDEX idx_sm_store ON stock_moves(store_id, section, item_key);
CREATE INDEX idx_daily_snap ON daily_report_snapshots(kind, workshop_id, report_date DESC);
CREATE INDEX idx_mri_ws ON monthly_report_inputs(year, month, sheet, workshop_id);
CREATE INDEX idx_jobs_field ON job_cards(field, status);
CREATE INDEX idx_job_parts_job ON job_parts(job_id);
CREATE INDEX idx_jp_line ON job_parts(mrn_line_id);
CREATE INDEX idx_job_hold_reasons ON job_hold_reasons(job_id, id);
CREATE INDEX idx_mrn_line_pri_hist ON mrn_line_priority_history(mrn_line_id);
CREATE INDEX idx_mrn_lines_priority ON mrn_lines(buying_priority, purchased_at);
CREATE INDEX idx_issues_min_id ON issues(min_id);
CREATE INDEX idx_issues_min_no ON issues(min_no);
CREATE INDEX idx_grn_vouchers_no ON grn_vouchers(grn_no);
CREATE INDEX idx_grn_approvals_voucher ON grn_approvals(voucher_id);
CREATE INDEX idx_min_approvals_min ON min_approvals(min_id);
CREATE INDEX idx_mtn_approvals_mtn ON mtn_approvals(mtn_id);
CREATE INDEX idx_tools_type ON workshop_tools(type, active);
CREATE INDEX idx_tools_mech ON workshop_tools(mechanic_id);
CREATE INDEX idx_tools_status ON workshop_tools(status);
CREATE INDEX idx_tool_logs_date ON tool_issue_logs(issue_date);
CREATE INDEX idx_tool_logs_status ON tool_issue_logs(status);
CREATE INDEX idx_tool_scrap_status ON tool_scrap_requests(status);
CREATE INDEX idx_jobs_job_request ON job_cards(job_request_id);
CREATE INDEX idx_service_jobs_workshop ON service_jobs(workshop_id);
CREATE INDEX idx_service_jobs_ws ON service_jobs(workshop_id);
CREATE INDEX idx_tools_ws ON workshop_tools(workshop_id);
CREATE INDEX idx_mtn_ws ON mtn(workshop_id);
CREATE INDEX idx_mrn_lines_route ON mrn_lines(supply_route);
CREATE INDEX idx_mtn_mrn ON mtn(mrn_id);
CREATE INDEX idx_mtn_lines_mrn_line ON mtn_lines(mrn_line_id);
CREATE INDEX idx_issues_mrn_line ON issues(mrn_line_id);
CREATE INDEX idx_discrepancies_status ON delivery_discrepancies(status);
CREATE INDEX idx_discrepancies_mrn ON delivery_discrepancies(mrn_id);
CREATE INDEX idx_mtn_chain_no ON mtn(chain_no);
CREATE INDEX idx_grn_chain_no ON grn(chain_no);
CREATE INDEX idx_grn_vouchers_chain_no ON grn_vouchers(chain_no);
CREATE INDEX idx_issues_chain_no ON issues(chain_no);
CREATE INDEX idx_discrepancies_chain_no ON delivery_discrepancies(chain_no);
CREATE INDEX idx_min_notes_no ON min_notes(min_no);
CREATE INDEX idx_min_notes_job ON min_notes(job_id);
CREATE INDEX idx_min_notes_asset ON min_notes(asset_id);
CREATE INDEX idx_min_notes_chain_no ON min_notes(chain_no);
CREATE INDEX idx_mrn_asset ON mrn(asset_id);
CREATE INDEX idx_mrn_job ON mrn(job_id);
CREATE INDEX idx_mrn_workshop ON mrn(workshop_id);
CREATE INDEX idx_mrn_chain_no ON mrn(chain_no);
CREATE TRIGGER trg_job_cards_workshop AFTER INSERT ON job_cards WHEN NEW.workshop_id IS NULL
    BEGIN UPDATE job_cards SET workshop_id = (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1) WHERE id = NEW.id; END;
CREATE TRIGGER trg_mechanics_workshop AFTER INSERT ON mechanics
    BEGIN INSERT OR IGNORE INTO mechanic_workshops (mechanic_id, workshop_id, from_date) VALUES (NEW.id, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1), '2000-01-01'); END;
CREATE TRIGGER trg_job_requests_workshop AFTER INSERT ON job_requests WHEN NEW.workshop_id IS NULL
    BEGIN UPDATE job_requests SET workshop_id = COALESCE((SELECT u.workshop_id FROM users u WHERE u.id = NEW.requested_by_user), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1))
           WHERE id = NEW.id; END;
CREATE TRIGGER trg_issues_store AFTER INSERT ON issues WHEN NEW.store_id IS NULL
             BEGIN UPDATE issues SET store_id = COALESCE((SELECT g.store_id FROM grn g WHERE g.id = NEW.grn_id), COALESCE((SELECT CASE WHEN sw.own_store = 1 AND (sw.store_opened IS NULL OR sw.store_opened <= date(COALESCE(NULLIF(NEW.issue_date, ''), 'now')))
                                THEN sw.id ELSE COALESCE(sw.uses_store, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) END
                      FROM workshops sw WHERE sw.id = ((SELECT j.workshop_id FROM job_cards j WHERE j.id = NEW.job_id))), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1))) WHERE id = NEW.id; END;
CREATE TRIGGER trg_general_item_txns_store AFTER INSERT ON general_item_txns WHEN NEW.store_id IS NULL
             BEGIN UPDATE general_item_txns SET store_id = COALESCE((SELECT CASE WHEN sw.own_store = 1 AND (sw.store_opened IS NULL OR sw.store_opened <= date(COALESCE(NULLIF(NEW.txn_date, ''), 'now')))
                                THEN sw.id ELSE COALESCE(sw.uses_store, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) END
                      FROM workshops sw WHERE sw.id = ((SELECT j.workshop_id FROM job_cards j WHERE j.id = NEW.job_id))), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
CREATE TRIGGER trg_stock_ledger_store AFTER INSERT ON stock_ledger WHEN NEW.store_id IS NULL
             BEGIN UPDATE stock_ledger SET store_id = COALESCE((SELECT CASE WHEN sw.own_store = 1 AND (sw.store_opened IS NULL OR sw.store_opened <= date(COALESCE(NULLIF(NEW.txn_date, ''), 'now')))
                                THEN sw.id ELSE COALESCE(sw.uses_store, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) END
                      FROM workshops sw WHERE sw.id = ((SELECT j.workshop_id FROM job_cards j WHERE j.id = NEW.job_id))), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
CREATE TRIGGER trg_service_jobs_store AFTER INSERT ON service_jobs WHEN NEW.store_id IS NULL
             BEGIN UPDATE service_jobs SET store_id = COALESCE((SELECT CASE WHEN sw.own_store = 1 AND (sw.store_opened IS NULL OR sw.store_opened <= date(COALESCE(NULLIF(NEW.service_date, ''), 'now')))
                                THEN sw.id ELSE COALESCE(sw.uses_store, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) END
                      FROM workshops sw WHERE sw.id = (SELECT j.workshop_id FROM job_cards j WHERE j.job_no = NEW.job_no ORDER BY j.id DESC LIMIT 1)), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
CREATE TRIGGER trg_mri_workshop AFTER INSERT ON monthly_report_inputs WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE monthly_report_inputs SET workshop_id = (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)
                  WHERE id = NEW.id; END;
CREATE TRIGGER trg_service_jobs_workshop AFTER INSERT ON service_jobs WHEN NEW.workshop_id IS NULL
  BEGIN
    UPDATE service_jobs SET workshop_id = COALESCE(
      (SELECT j.workshop_id FROM job_cards j WHERE j.job_no = NEW.job_no ORDER BY j.id DESC LIMIT 1),
      (SELECT w.id FROM workshops w WHERE w.own_store = 1 AND w.id = NEW.store_id),
      (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)
    ) WHERE id = NEW.id;
  END;
CREATE TRIGGER trg_service_jobs_ws AFTER INSERT ON service_jobs WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE service_jobs SET workshop_id = COALESCE((SELECT j.workshop_id FROM job_cards j WHERE j.job_no = NEW.job_no AND COALESCE(NEW.job_no, '') <> '' ORDER BY j.id DESC LIMIT 1), NEW.store_id, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
CREATE TRIGGER trg_tools_ws AFTER INSERT ON workshop_tools WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE workshop_tools SET workshop_id = COALESCE((SELECT COALESCE(
    (SELECT mw.workshop_id FROM mechanic_workshops mw WHERE mw.mechanic_id = m.id AND mw.from_date <= date('now')
      ORDER BY mw.from_date DESC, mw.id DESC LIMIT 1),
    (SELECT mw.workshop_id FROM mechanic_workshops mw WHERE mw.mechanic_id = m.id ORDER BY mw.from_date, mw.id LIMIT 1),
    (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) FROM mechanics m WHERE m.id = NEW.mechanic_id), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
CREATE TRIGGER trg_mtn_ws AFTER INSERT ON mtn WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE mtn SET workshop_id = COALESCE((SELECT w.id FROM workshops w WHERE NEW.from_place = 'w:' || w.id), (SELECT w.id FROM workshops w WHERE NEW.to_place = 'w:' || w.id), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
CREATE TRIGGER trg_min_notes_ws AFTER INSERT ON min_notes WHEN NEW.workshop_id IS NULL
           BEGIN UPDATE min_notes SET workshop_id = COALESCE((SELECT j.workshop_id FROM job_cards j WHERE j.id = NEW.job_id), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
CREATE TRIGGER trg_mrn_workshop AFTER INSERT ON mrn WHEN NEW.workshop_id IS NULL
    BEGIN UPDATE mrn SET workshop_id = COALESCE((SELECT j.workshop_id FROM job_cards j WHERE j.id = NEW.job_id), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1))
           WHERE id = NEW.id; END;
CREATE TRIGGER trg_grn_store AFTER INSERT ON grn WHEN NEW.store_id IS NULL
             BEGIN UPDATE grn SET store_id = COALESCE((SELECT CASE WHEN sw.own_store = 1 AND (sw.store_opened IS NULL OR sw.store_opened <= date(COALESCE(NULLIF(NEW.delivery_date, ''), 'now')))
                                THEN sw.id ELSE COALESCE(sw.uses_store, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) END
                      FROM workshops sw WHERE sw.id = (SELECT m.workshop_id FROM mrn m WHERE m.id = COALESCE(NEW.mrn_id,
                     (SELECT ml.mrn_id FROM mrn_lines ml WHERE ml.id = NEW.mrn_line_id)))), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
CREATE TRIGGER trg_tyre_battery_issues_store AFTER INSERT ON tyre_battery_issues WHEN NEW.store_id IS NULL
             BEGIN UPDATE tyre_battery_issues SET store_id = COALESCE((SELECT CASE WHEN sw.own_store = 1 AND (sw.store_opened IS NULL OR sw.store_opened <= date(COALESCE(NULLIF(NEW.issue_date, ''), 'now')))
                                THEN sw.id ELSE COALESCE(sw.uses_store, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) END
                      FROM workshops sw WHERE sw.id = (COALESCE((SELECT j.workshop_id FROM job_cards j WHERE j.id = NEW.job_id),
                     (SELECT m.workshop_id FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id WHERE ml.id = NEW.mrn_line_id)))), (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) WHERE id = NEW.id; END;
