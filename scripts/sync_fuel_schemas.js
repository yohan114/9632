const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'workshopone_merged.db');
const db = new Database(dbPath);

console.log('--- SYNCING FUEL SCHEMAS & COLUMN BRIDGES (V9) ---');

// Populate fleet_bills from bill_line_items + bills + assets if empty
const fbCount = db.prepare('SELECT count(*) as count FROM fleet_bills').get().count;
if (fbCount === 0) {
  db.exec(`
    INSERT OR REPLACE INTO fleet_bills (
      id, invoice_number, year, month, period_key, period_start, period_end,
      asset_id, asset_code, asset_reg_no,
      billing_mode, rate_basis, rate_cents,
      actual_units, minimum_units, billable_units,
      rental_amount_cents, subtotal_cents, sscl_cents, vat_cents, grand_total_cents,
      project_id, status, created_at
    )
    SELECT
      CAST(bli.id AS TEXT),
      COALESCE(b.bill_no, 'INV-' || b.id) || '-' || bli.id,
      CAST(COALESCE(strftime('%Y', b.period_start), strftime('%Y', b.created_at), '2026') AS INTEGER),
      CAST(COALESCE(strftime('%m', b.period_start), strftime('%m', b.created_at), '8') AS INTEGER),
      strftime('%Y-%m', COALESCE(b.period_start, b.created_at, '2026-08-01')),
      COALESCE(b.period_start, '2026-08-01'),
      COALESCE(b.period_end, '2026-08-31'),
      bli.asset_id,
      COALESCE(a.code, 'ASSET-' || bli.asset_id),
      a.registration,
      'DRY',
      'HOURLY',
      CAST(ROUND(COALESCE(bli.rate, 0) * 100) AS INTEGER),
      COALESCE(bli.hours_or_days, 0),
      0,
      COALESCE(bli.hours_or_days, 0),
      CAST(ROUND(COALESCE(bli.base_amount, 0) * 100) AS INTEGER),
      CAST(ROUND(COALESCE(bli.base_amount, 0) * 100) AS INTEGER),
      0,
      0,
      CAST(ROUND(COALESCE(bli.net_amount, 0) * 100) AS INTEGER),
      b.project_id,
      CASE UPPER(COALESCE(b.status, 'DRAFT'))
        WHEN 'ISSUED' THEN 'ISSUED'
        ELSE 'DRAFT'
      END,
      COALESCE(bli.created_at, datetime('now'))
    FROM bill_line_items bli
    JOIN bills b ON b.id = bli.bill_id
    LEFT JOIN assets a ON a.id = bli.asset_id;
  `);
  console.log('Populated fleet_bills from bill_line_items:', db.prepare('SELECT count(*) as count FROM fleet_bills').get().count, 'rows.');
}

// Ensure migration 055 indexes are created now that columns exist
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_date ON fuel_issues(issue_date);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_tank ON fuel_issues(source_tank_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_target_proj ON fuel_issues(target_project_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_asset_code ON fuel_issues(asset_code);
    CREATE INDEX IF NOT EXISTS idx_fuel_issues_voided ON fuel_issues(is_voided);
  `);
  console.log('Created migration 055 indexes successfully.');
} catch (e) {
  console.warn('Index creation warning:', e.message);
}

// Mark migration_055_done
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_055_done', '1')").run();

console.log('=== All Fuel Schemas and Bridges are Synced! ===');
