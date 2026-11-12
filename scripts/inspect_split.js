'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

const db = new Database(config.dbPath);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
console.log('Total tables in live database:', tables.length);

const coreTables = [
  'users', 'roles', 'user_roles', 'role_capabilities', 'role_permissions',
  'user_capabilities', 'user_permissions', 'sessions', 'auth_challenges',
  'mfa_recovery_codes', 'user_seen_marks', 'approval_limits',
  'workshops', 'projects', 'sites', 'settings',
  'assets', 'asset_aliases', 'asset_moves', 'vehicle_lubricant_capacities',
  'service_specs', 'tb_specs',
  'store_items', 'item_categories', 'stock_items', 'products', 'product_prices',
  'oil_list', 'oil_type_prices', 'lubricant_aliases', 'filter_catalogue',
  'filter_category_list', 'filter_xrefs', 'filter_prices', 'tyre_battery_prices',
  'audit_log'
];

const perWsTables = [
  'job_cards', 'job_approvals', 'job_costs', 'job_daily_work', 'job_hold_reasons',
  'job_labour', 'job_parts', 'job_reopen_requests', 'job_reopens', 'job_requests',
  'job_request_approvals', 'job_summary_notes', 'job_workshop_moves',
  'historical_job_costs', 'pending_part_notes',
  'mechanics', 'mechanic_aliases', 'mechanic_workshops', 'labour_rates',
  'mechanic_attendance', 'workday_signoffs',
  'mrn', 'mrn_lines', 'mrn_approvals', 'mrn_line_invoices', 'mrn_line_priority_history',
  'grn', 'grn_approvals', 'grn_vouchers', 'issues', 'issue_returns',
  'min_notes', 'min_approvals', 'mtn', 'mtn_lines', 'mtn_approvals',
  'receipt_price_notes',
  'stock_moves', 'stock_ledger', 'stock_opening', 'stock_counts', 'store_counts',
  'store_reorder', 'count_sessions', 'count_lines', 'general_item_txns',
  'disposals', 'disposal_lines', 'filter_stock',
  'batteries', 'battery_events', 'battery_photos', 'tyres', 'tyre_events',
  'tyre_photos', 'tyre_battery_issues', 'tb_request_lines', 'tb_returns',
  'service_jobs', 'service_attachments', 'service_filters', 'service_oils',
  'service_parts',
  'workshop_tools', 'tool_issue_logs', 'tool_scrap_requests',
  'daily_report_snapshots', 'monthly_report_inputs', 'vehicle_monthly_costs'
];

console.log('Core tables defined in plan:', coreTables.length);
console.log('Per-workshop tables defined in plan:', perWsTables.length);
const allPlanTables = new Set([...coreTables, ...perWsTables]);

const unclassified = tables.filter(t => !allPlanTables.has(t.name));
console.log('Tables in DB not in plan list:', unclassified.map(t => t.name));

for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) c FROM ${t.name}`).get().c;
    if (c > 0) {
      const type = coreTables.includes(t.name) ? 'CORE' : (perWsTables.includes(t.name) ? 'WS  ' : '????');
      console.log(`[${type}] ${t.name.padEnd(35)} : ${c}`);
    }
  } catch (e) {
    console.log(`${t.name.padEnd(35)} : ERR ${e.message}`);
  }
}
db.close();
