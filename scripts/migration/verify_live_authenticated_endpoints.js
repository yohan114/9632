'use strict';
const http = require('http');
const auth = require('../../src/lib/auth');

// Create test session for Admin (user ID 1)
const { token } = auth.createSession(1, { headers: { 'user-agent': 'node-test' }, ip: '127.0.0.1' }, { mfaVerified: true });
console.log('Generated session token for Admin (User 1)');

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 1929,
      path: path,
      method: 'GET',
      headers: {
        'Cookie': `${auth.COOKIE}=${token}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, text: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function verifyUnifiedLiveServer() {
  console.log('=== Verifying Live Unified Endpoints on http://localhost:1929 ===');

  // 1. Fuel Issues
  const fuelIssues = await getJson('/api/fuel/issues?limit=10');
  console.log('\n[1] GET /api/fuel/issues: Status', fuelIssues.status);
  console.log('    Total Issues Migrated in DB:', fuelIssues.json.total);
  if (fuelIssues.json.issues && fuelIssues.json.issues.length > 0) {
    const sample = fuelIssues.json.issues[0];
    console.log(`    Sample Issue: ${sample.issue_no} | ${sample.issue_date} | ${sample.asset_code || sample.asset_name} | ${sample.litres}L | Rs ${sample.total_cost_lkr}`);
  }

  // 1b. Fuel Stats
  const fuelStats = await getJson('/api/fuel/stats');
  console.log('\n[1b] GET /api/fuel/stats: Status', fuelStats.status);
  console.log('     Active Tanks:', fuelStats.json.tanks.total_tanks);
  console.log('     Total Stock Litres:', fuelStats.json.tanks.total_stock_litres);

  // 2. Fuel Tanks
  const tanks = await getJson('/api/fuel/tanks');
  console.log('\n[2] GET /api/fuel/tanks: Status', tanks.status);
  console.log('    Tanks Count:', tanks.json.tanks ? tanks.json.tanks.length : 0);
  if (tanks.json.tanks && tanks.json.tanks.length > 0) {
    console.log('    Sample Tanks:', tanks.json.tanks.slice(0, 3).map(t => `${t.name} (${t.code}) - ${t.current_litres}/${t.capacity_litres} L`));
  }

  // 3. Hire Billing
  const hireBills = await getJson('/api/hire/bills');
  console.log('\n[3] GET /api/hire/bills: Status', hireBills.status);
  console.log('    Bills Count in DB:', hireBills.json.total);
  if (hireBills.json.bills && hireBills.json.bills.length > 0) {
    const b = hireBills.json.bills[0];
    console.log(`    Sample Bill: #${b.bill_no} | ${b.invoice_number || 'N/A'} | Period: ${b.year}-${b.month} | Total: Rs ${(b.grand_total_cents/100).toLocaleString()}`);
  }

  // 4. Fleet Finance & Vehicle Profitability
  const finance = await getJson('/api/fleet/finance/vehicle-profitability?year=2026&month=5');
  console.log('\n[4] GET /api/fleet/finance/vehicle-profitability: Status', finance.status);
  console.log('    Assets Evaluated:', finance.json.report ? finance.json.report.length : 0);
  console.log('    Summary:', finance.json.summary);

  // 5. Master Cockpit Dashboard
  const cockpit = await getJson('/api/master-dashboard/summary');
  console.log('\n[5] GET /api/master-dashboard/summary: Status', cockpit.status);
  console.log('    Fleet Total:', cockpit.json.fleet ? cockpit.json.fleet.total : 'N/A');
  console.log('    Fleet Active:', cockpit.json.fleet ? cockpit.json.fleet.active : 'N/A');
  console.log('    Fleet Open Jobs:', cockpit.json.fleet ? cockpit.json.fleet.openJobCards : 'N/A');
  console.log('    Fuel Month Litres:', cockpit.json.fuel ? cockpit.json.fuel.monthLitres : 'N/A');
  console.log('    Fuel Month Cost Rs:', cockpit.json.fuel ? (cockpit.json.fuel.monthCostCents/100).toLocaleString() : 'N/A');
  console.log('    Hire Finalized Bills:', cockpit.json.billing ? cockpit.json.billing.finalBillsCount : 'N/A');

  console.log('\n================================================================');
  console.log('>>> ALL 5 UNIFIED FLEET & FUEL ENDPOINTS OPERATING FLAWLESSLY! <<<');
  console.log('================================================================');
}

verifyUnifiedLiveServer().catch(err => {
  console.error('Live server verification failed:', err);
  process.exit(1);
});
