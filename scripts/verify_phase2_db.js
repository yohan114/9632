'use strict';
const { db } = require('../src/db');
const permissions = require('../src/lib/permissions');

console.log('=== VERIFYING PHASE 2 DB SCHEMA IN 9632-Fuel-Merged ===');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log('Total Tables in DB:', tables.length);

const fuelTables = [
  'bulk_tanks', 'tank_dips', 'bulk_requests', 'fuel_prices',
  'fuel_requests', 'fuel_issues', 'fuel_issue_corrections',
  'meter_readings', 'daily_conditions', 'rental_rates',
  'bills', 'bill_line_items', 'payments', 'budgets',
  'credit_notes', 'pm_tasks', 'service_intervals',
  'vehicle_hiring_revenue', 'vehicle_driver_other_costs',
  'mrn_attachments'
];

for (const t of fuelTables) {
  const exists = tables.includes(t);
  console.log(`Table [${t}]:`, exists ? 'EXISTS' : 'MISSING');
}

const issuesCols = db.prepare('PRAGMA table_info(issues)').all().map(c => c.name);
console.log('issues.recipient_name:', issuesCols.includes('recipient_name') ? 'EXISTS' : 'MISSING');
console.log('issues.total_price:', issuesCols.includes('total_price') ? 'EXISTS' : 'MISSING');

const adminUser = { id: 1, username: 'admin', roles: ['admin'] };
const opManagerUser = { id: 2, username: 'op_mgr', roles: ['operational_manager'] };
const viewerUser = { id: 3, username: 'viewer', roles: ['viewer'] };

console.log('Admin level on dashboard:', permissions.effectiveLevel(adminUser, 'dashboard'));
console.log('Admin level on fuel:', permissions.effectiveLevel(adminUser, 'fuel'));
console.log('Admin level on costing:', permissions.effectiveLevel(adminUser, 'costing'));
console.log('Op Manager level on fuel:', permissions.effectiveLevel(opManagerUser, 'fuel'));
console.log('Viewer level on fuel:', permissions.effectiveLevel(viewerUser, 'fuel'));
console.log('Viewer level on access:', permissions.effectiveLevel(viewerUser, 'access'));

console.log('=== DB SCHEMA VERIFICATION COMPLETE ===');
