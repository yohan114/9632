-- ============================================================================
-- WorkshopOne & Fuel-System-V2 Merged Schema Extensions
-- Dedicated Fuel Management, Meter Telemetry, Equipment Billing, and Costing
-- ============================================================================

-- 1. Bulk Fuel Storage & Inventory
CREATE TABLE IF NOT EXISTS bulk_tanks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tank_code       TEXT UNIQUE,
  name            TEXT NOT NULL,
  capacity_litres REAL NOT NULL DEFAULT 0,
  current_litres  REAL NOT NULL DEFAULT 0,
  fuel_kind       TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
  project_id      INTEGER REFERENCES projects(id),
  status          TEXT DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bulk_tanks_project ON bulk_tanks(project_id);

-- 2. Physical Tank Dips
CREATE TABLE IF NOT EXISTS tank_dips (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  bulk_tank_id      INTEGER NOT NULL REFERENCES bulk_tanks(id) ON DELETE CASCADE,
  dip_date          TEXT NOT NULL DEFAULT (date('now')),
  dip_cm            REAL NOT NULL,
  calculated_litres REAL NOT NULL,
  system_litres     REAL,
  variance_litres   REAL,
  recorded_by       INTEGER REFERENCES users(id),
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tank_dips_tank ON tank_dips(bulk_tank_id);

-- 3. Bulk Diesel Replenishment Orders
CREATE TABLE IF NOT EXISTS bulk_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no       TEXT UNIQUE,
  bulk_tank_id     INTEGER NOT NULL REFERENCES bulk_tanks(id),
  requested_litres REAL NOT NULL,
  fuel_kind        TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
  status           TEXT NOT NULL DEFAULT 'pending',
  order_ref        TEXT,
  supplier         TEXT DEFAULT 'Ceypetco',
  received_litres  REAL,
  received_date    TEXT,
  unit_price       REAL,
  total_price      REAL,
  requested_by     INTEGER REFERENCES users(id),
  reviewed_by      INTEGER REFERENCES users(id),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bulk_requests_tank ON bulk_requests(bulk_tank_id);

-- 4. Official Fuel Prices (Ceypetco)
CREATE TABLE IF NOT EXISTS fuel_prices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_kind        TEXT NOT NULL,
  price_per_litre  REAL NOT NULL,
  effective_date   TEXT NOT NULL,
  end_date         TEXT,
  source           TEXT DEFAULT 'Ceypetco',
  entered_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_prices_kind ON fuel_prices(fuel_kind);

-- 5. Machine Fuel Requests
CREATE TABLE IF NOT EXISTS fuel_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no       TEXT UNIQUE,
  asset_id         INTEGER NOT NULL REFERENCES assets(id),
  project_id       INTEGER REFERENCES projects(id),
  fuel_kind        TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
  requested_litres REAL NOT NULL,
  meter_reading    REAL,
  reason           TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  requested_by     INTEGER REFERENCES users(id),
  reviewed_by      INTEGER REFERENCES users(id),
  reviewed_at      TEXT,
  photo_path       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_requests_asset ON fuel_requests(asset_id);
CREATE INDEX IF NOT EXISTS idx_fuel_requests_status ON fuel_requests(status);

-- 6. Fuel Dispensing Issues (Direct Pump & Requisition Fulfillment)
CREATE TABLE IF NOT EXISTS fuel_issues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_no        TEXT UNIQUE,
  asset_id        INTEGER NOT NULL REFERENCES assets(id),
  bulk_tank_id    INTEGER REFERENCES bulk_tanks(id),
  project_id      INTEGER REFERENCES projects(id),
  fuel_request_id INTEGER REFERENCES fuel_requests(id),
  fuel_kind       TEXT NOT NULL DEFAULT 'AUTO_DIESEL',
  litres          REAL NOT NULL,
  unit_price      REAL NOT NULL DEFAULT 0,
  total_price     REAL NOT NULL DEFAULT 0,
  meter_reading   REAL,
  issue_date      TEXT NOT NULL DEFAULT (datetime('now')),
  issued_by       INTEGER REFERENCES users(id),
  recipient_name  TEXT,
  source          TEXT DEFAULT 'pump',
  voided          INTEGER NOT NULL DEFAULT 0,
  void_reason     TEXT,
  voided_at       TEXT,
  voided_by       INTEGER REFERENCES users(id),
  photo_path      TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_issues_asset ON fuel_issues(asset_id);
CREATE INDEX IF NOT EXISTS idx_fuel_issues_tank ON fuel_issues(bulk_tank_id);
CREATE INDEX IF NOT EXISTS idx_fuel_issues_date ON fuel_issues(issue_date);

-- 7. Fuel Corrections Audit Trail
CREATE TABLE IF NOT EXISTS fuel_issue_corrections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_issue_id  INTEGER NOT NULL REFERENCES fuel_issues(id) ON DELETE CASCADE,
  requested_by   INTEGER REFERENCES users(id),
  reason         TEXT NOT NULL,
  changes_json   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  reviewed_by    INTEGER REFERENCES users(id),
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_corrections_issue ON fuel_issue_corrections(fuel_issue_id);

-- 8. Vehicle & Machinery Meter Readings (Hours / KM)
CREATE TABLE IF NOT EXISTS meter_readings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id      INTEGER NOT NULL REFERENCES assets(id),
  reading       REAL NOT NULL,
  meter_type    TEXT NOT NULL DEFAULT 'HOURS',
  reading_date  TEXT NOT NULL DEFAULT (date('now')),
  recorded_by   INTEGER REFERENCES users(id),
  source        TEXT DEFAULT 'manual',
  photo_path    TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meter_readings_asset ON meter_readings(asset_id);
CREATE INDEX IF NOT EXISTS idx_meter_readings_date ON meter_readings(reading_date);

-- 9. Daily Plant Operational Conditions (Running / Breakdown / Idle)
CREATE TABLE IF NOT EXISTS daily_conditions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id       INTEGER NOT NULL REFERENCES assets(id),
  condition_date TEXT NOT NULL DEFAULT (date('now')),
  project_id     INTEGER REFERENCES projects(id),
  state          TEXT NOT NULL DEFAULT 'RUNNING',
  hours_worked   REAL DEFAULT 0,
  recorded_by    INTEGER REFERENCES users(id),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asset_id, condition_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_conditions_asset ON daily_conditions(asset_id);

-- 10. Machinery Rental Rates
CREATE TABLE IF NOT EXISTS rental_rates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id       INTEGER REFERENCES assets(id),
  category       TEXT,
  project_id     INTEGER REFERENCES projects(id),
  rate_type      TEXT NOT NULL DEFAULT 'hourly',
  rate_amount    REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'LKR',
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rental_rates_asset ON rental_rates(asset_id);
CREATE INDEX IF NOT EXISTS idx_rental_rates_cat ON rental_rates(category);

-- 11. Monthly Equipment Billing (Plant Invoices)
CREATE TABLE IF NOT EXISTS bills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no      TEXT NOT NULL UNIQUE,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  subtotal     REAL NOT NULL DEFAULT 0,
  tax          REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  generated_by INTEGER REFERENCES users(id),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bills_project ON bills(project_id);
CREATE INDEX IF NOT EXISTS idx_bills_period ON bills(period_start, period_end);

-- 12. Equipment Billing Line Items
CREATE TABLE IF NOT EXISTS bill_line_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id          INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  asset_id         INTEGER NOT NULL REFERENCES assets(id),
  hours_or_days    REAL NOT NULL DEFAULT 0,
  rate             REAL NOT NULL DEFAULT 0,
  base_amount      REAL NOT NULL DEFAULT 0,
  fuel_deduction   REAL NOT NULL DEFAULT 0,
  repair_deduction REAL NOT NULL DEFAULT 0,
  net_amount       REAL NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_line_items(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_asset ON bill_line_items(asset_id);

-- 13. Billing Payments
CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id        INTEGER NOT NULL REFERENCES bills(id),
  amount         REAL NOT NULL,
  payment_date   TEXT NOT NULL DEFAULT (date('now')),
  payment_method TEXT DEFAULT 'bank_transfer',
  reference      TEXT,
  recorded_by    INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);

-- 14. Project Monthly Budgets
CREATE TABLE IF NOT EXISTS budgets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  month         TEXT NOT NULL,
  fuel_budget   REAL NOT NULL DEFAULT 0,
  repair_budget REAL NOT NULL DEFAULT 0,
  hire_budget   REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, month)
);

-- 15. Credit Notes
CREATE TABLE IF NOT EXISTS credit_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_no TEXT NOT NULL UNIQUE,
  bill_id        INTEGER NOT NULL REFERENCES bills(id),
  amount         REAL NOT NULL,
  reason         TEXT NOT NULL,
  issued_by      INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 16. Preventive Maintenance Ladder Tasks
CREATE TABLE IF NOT EXISTS pm_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  category       TEXT NOT NULL,
  task_code      TEXT,
  interval_hours REAL NOT NULL,
  interval_label TEXT NOT NULL,
  system         TEXT,
  component      TEXT,
  description    TEXT NOT NULL,
  parts          TEXT,
  labor_hours    REAL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pm_tasks_cat ON pm_tasks(category, interval_hours);

-- 17. Fleet Service Intervals
CREATE TABLE IF NOT EXISTS service_intervals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  category       TEXT NOT NULL UNIQUE,
  interval_hours REAL NOT NULL DEFAULT 500,
  interval_km    REAL NOT NULL DEFAULT 5000,
  warn_hours     REAL NOT NULL DEFAULT 50,
  warn_km        REAL NOT NULL DEFAULT 500,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 18. Vehicle Hiring Revenue (For Final Vehicle Costing & Profitability)
CREATE TABLE IF NOT EXISTS vehicle_hiring_revenue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id      INTEGER NOT NULL REFERENCES assets(id),
  date          TEXT NOT NULL,
  month         TEXT NOT NULL,
  project_id    INTEGER REFERENCES projects(id),
  hire_type     TEXT NOT NULL DEFAULT 'hours',
  quantity      REAL NOT NULL DEFAULT 0,
  hire_rate     REAL NOT NULL DEFAULT 0,
  total_revenue REAL NOT NULL DEFAULT 0,
  invoice_no    TEXT,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vhr_asset_month ON vehicle_hiring_revenue(asset_id, month);

-- 19. Driver & Other Vehicle Costs (For Final Vehicle Costing & Profitability)
CREATE TABLE IF NOT EXISTS vehicle_driver_other_costs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id       INTEGER NOT NULL REFERENCES assets(id),
  date           TEXT NOT NULL,
  month          TEXT NOT NULL,
  project_id     INTEGER REFERENCES projects(id),
  cost_type      TEXT NOT NULL,
  driver_name    TEXT,
  driver_salary  REAL NOT NULL DEFAULT 0,
  bata_ot        REAL NOT NULL DEFAULT 0,
  other_expenses REAL NOT NULL DEFAULT 0,
  amount         REAL NOT NULL DEFAULT 0,
  description    TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vdoc_asset_month ON vehicle_driver_other_costs(asset_id, month);

-- 20. MRN File Attachments
CREATE TABLE IF NOT EXISTS mrn_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn_id      INTEGER NOT NULL REFERENCES mrn(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime_type   TEXT,
  file_size   INTEGER,
  data        BLOB,
  file_path   TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mrn_attach ON mrn_attachments(mrn_id);
