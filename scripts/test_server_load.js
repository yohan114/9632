const path = require('path');
const config = require('../src/config');

console.log('--- TESTING SERVER CONFIGURATION ---');
console.log('Port:', config.port);
console.log('Host:', config.host);
console.log('DB Path:', config.dbPath);

if (config.port !== 1949) {
  console.error('ERROR: Port is NOT 1949! Actual:', config.port);
  process.exit(1);
}
if (!config.dbPath.includes('workshopone_merged.db')) {
  console.error('ERROR: DB Path is NOT workshopone_merged.db! Actual:', config.dbPath);
  process.exit(1);
}

const db = require('../src/db');
console.log('DB initialized successfully.');

// Test requiring all routes to ensure no module resolution or syntax errors
const routes = [
  'auth', 'access', 'dual_auth', 'notifications', 'audit_logs',
  'assets', 'aliases', 'jobflow', 'projects', 'stores',
  'store_locations', 'general_stock', 'oil', 'batteries', 'filters',
  'filter_stock', 'tools', 'stock_cockpit', 'jobcards', 'jobrequests',
  'fabrication', 'dailywork', 'attendance', 'field', 'operations',
  'dashboard', 'mechanics', 'workshops', 'users', 'reports',
  'lubricant_capacities', 'tyre_battery', 'vehicle_documents',
  'tyre_battery_requests', 'purchasing', 'outsourcing',
  'fuel_tanks', 'fuel', 'hire_billing', 'fleet_finance',
  'master_dashboard', 'vehicle_costing', 'meters'
];

console.log('Verifying all 43 backend route modules...');
for (const r of routes) {
  try {
    require(`../src/routes/${r}`);
    console.log(`  ✓ Route /api/${r} loaded successfully`);
  } catch (err) {
    console.error(`  ✗ Route /api/${r} FAILED:`, err.message);
    process.exit(1);
  }
}

console.log('All 43 backend routes loaded perfectly with zero errors!');
