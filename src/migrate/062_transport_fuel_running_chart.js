// Migration 062: Transport Fuel & Running Chart workflow + "No Request, No Issue" gate + Cross-check columns

function ensureColumn(db, table, column, definition) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!hasTable) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function runMigration(db) {
  const requestCols = [
    ['project_id', 'INTEGER'],
    ['target_tank_id', 'TEXT'],
    ['source_mode', "TEXT NOT NULL DEFAULT 'TANK'"],
    ['station_name', 'TEXT'],
    ['running_chart_no', 'TEXT'],
    ['driver_name', 'TEXT'],
    ['trip_purpose', 'TEXT'],
    ['prev_meter_reading', 'REAL'],
    ['meter_reading', 'REAL'],
    ['meter_type', 'TEXT'],
    ['approx_km', 'REAL'],
    ['consumption_norm', 'REAL'],
    ['consumption_basis', 'TEXT'],
    ['recommended_litres', 'REAL'],
    ['trip_total_fuel', 'REAL'],
    ['is_full_tank', 'INTEGER NOT NULL DEFAULT 0'],
    ['needs_approval', 'INTEGER NOT NULL DEFAULT 0'],
    ['actual_issued_litres', 'REAL'],
    ['fuel_issue_id', 'TEXT'],
    ['fulfilled_by', 'INTEGER'],
    ['fulfilled_at', 'TEXT'],
    ['notes', 'TEXT'],
  ];

  for (const [col, def] of requestCols) {
    ensureColumn(db, 'fuel_requests', col, def);
  }

  const issueCols = [
    ['fuel_request_id', 'TEXT'],
    ['running_chart_no', 'TEXT'],
    ['driver_name', 'TEXT'],
    ['trip_purpose', 'TEXT'],
    ['approx_km_snapshot', 'REAL'],
    ['recommended_litres_snapshot', 'REAL'],
    ['trip_fuel_snapshot', 'REAL'],
    ['is_full_tank', 'INTEGER NOT NULL DEFAULT 0'],
    ['variance_litres', 'REAL'],
    ['variance_pct', 'REAL'],
    ['trip_variance_litres', 'REAL'],
    ['cross_check_status', 'TEXT'],
    ['cross_check_notes', 'TEXT'],
  ];

  for (const [col, def] of issueCols) {
    ensureColumn(db, 'fuel_issues', col, def);
  }

  // Enforce strict 1:1 link between an active (non-voided) fuel issue and a fuel request
  const hasIssues = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fuel_issues'").get();
  if (hasIssues) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fuel_issues_req_active
        ON fuel_issues(fuel_request_id)
        WHERE fuel_request_id IS NOT NULL AND COALESCE(is_voided, 0) = 0;
      CREATE INDEX IF NOT EXISTS idx_fuel_issues_cross_check
        ON fuel_issues(cross_check_status, issue_date);
    `);
  }

  const hasRequests = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fuel_requests'").get();
  if (hasRequests) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fuel_requests_status_tank
        ON fuel_requests(status, target_tank_id);
      CREATE INDEX IF NOT EXISTS idx_fuel_requests_project
        ON fuel_requests(project_id, requested_at);
    `);
  }
}

module.exports = { runMigration };
