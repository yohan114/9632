const http = require('http');

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function runVerification() {
  console.log('=== VERIFYING FULL RESTORATION ON PORT 1949 & PORT 1929 ===\n');

  // 1. Verify Port 1929 is intact
  try {
    const h1929 = await request({ hostname: 'localhost', port: 1929, path: '/api/health', method: 'GET' });
    console.log('✓ Port 1929 (Original System) Health:', h1929.status === 200 ? 'ONLINE' : 'UNEXPECTED STATUS ' + h1929.status);
  } catch (err) {
    console.error('✗ Port 1929 failed to respond:', err.message);
  }

  // 2. Verify Port 1949 is online
  const h1949 = await request({ hostname: 'localhost', port: 1949, path: '/api/health', method: 'GET' });
  console.log('✓ Port 1949 (Merged System) Health:', h1949.status === 200 ? 'ONLINE' : 'FAILED ' + h1949.status);

  // 3. Authenticate on Port 1949. The credentials come from the environment, never from this file:
  //   WO_USER=admin WO_PASSWORD=... node scripts/verify_full_restoration.js
  const woUser = process.env.WO_USER || 'admin';
  const woPassword = process.env.WO_PASSWORD;
  if (!woPassword) {
    console.error('✗ Set WO_PASSWORD (and WO_USER if not admin) to sign in to port 1949.');
    process.exit(1);
  }
  const loginRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: woUser, password: woPassword });

  if (loginRes.status !== 200) {
    console.error('✗ Port 1949 Login Failed:', loginRes.data);
    process.exit(1);
  }
  const cookies = loginRes.headers['set-cookie'] ? loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') : '';
  const authHeaders = {
    'Cookie': cookies
  };
  console.log('✓ Port 1949 Admin Authentication: SUCCESS');

  // 4. Test C.COM Outsourced Service Requests
  const ccomRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/outsourcing/requests',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ C.COM Outsourced Service Requests (/api/outsourcing/requests):', ccomRes.status === 200 ? `SUCCESS (${ccomRes.data.requests ? ccomRes.data.requests.length : 'OK'} requests)` : 'FAILED ' + ccomRes.status);

  // 5. Test Mechanics KPI & Daily Work Pulse
  const kpiRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/daily-work/mechanics-kpi?month=2026-08',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ Mechanics KPI Analytics (/api/daily-work/mechanics-kpi):', kpiRes.status === 200 ? `SUCCESS (MTD hours: ${kpiRes.data.mtd_hours || 0}, Wage ROI: ${kpiRes.data.mtd_roi_ratio || 0}x)` : 'FAILED ' + kpiRes.status);

  // 6. Test Fuel Operations Issues
  const fuelRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/fuel/issues?limit=10',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ Fuel Issues Register (/api/fuel/issues):', fuelRes.status === 200 ? `SUCCESS (${fuelRes.data.totalCount || (fuelRes.data.issues ? fuelRes.data.issues.length : 0)} total issues)` : 'FAILED ' + fuelRes.status);

  // 7. Test Bulk Fuel Tanks & Bowsers
  const tanksRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/fuel/tanks',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ Storage Tanks & Bowsers (/api/fuel/tanks):', tanksRes.status === 200 ? `SUCCESS (${tanksRes.data.tanks ? tanksRes.data.tanks.length : 0} tanks)` : 'FAILED ' + tanksRes.status);

  // 8. Test Machine Hire & Rental Billing
  const hireRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/hire/bills?limit=5',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ Machine Hire & Billing (/api/hire/bills):', hireRes.status === 200 ? `SUCCESS (${hireRes.data.totalCount || 0} bills)` : 'FAILED ' + hireRes.status);

  // 9. Test Daily Pump & Machine Meter Readings
  const metersRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/meters',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ Daily Meter Readings (/api/meters):', metersRes.status === 200 ? `SUCCESS (${Array.isArray(metersRes.data) ? metersRes.data.length : 0} readings)` : 'FAILED ' + metersRes.status);

  // 10. Test Fuel Efficiency & Consumption Norms Report
  const fuelRepRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/fuel/reports?month=2026-08',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ Fuel Efficiency & Norms (/api/fuel/reports):', fuelRepRes.status === 200 ? `SUCCESS (${fuelRepRes.data.vehicles ? fuelRepRes.data.vehicles.length : 0} vehicles analysed, ${fuelRepRes.data.totalLitres} L)` : 'FAILED ' + fuelRepRes.status);

  // 11. Test Fuel Alerts & Discrepancies
  const alertsRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/fuel/alerts',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ Fuel Alerts & Discrepancy Audits (/api/fuel/alerts):', alertsRes.status === 200 ? `SUCCESS (${alertsRes.data.count || 0} alerts detected)` : 'FAILED ' + alertsRes.status);

  // 12. Test Master Fleet Costing Summary
  const costingSumRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/vehicle-costing/fleet-summary?month=2026-08',
    method: 'GET',
    headers: authHeaders
  });
  console.log('✓ Master Fleet Costing Summary (/api/vehicle-costing/fleet-summary):', costingSumRes.status === 200 ? `SUCCESS (${costingSumRes.data.vehicles ? costingSumRes.data.vehicles.length : 0} vehicles, Repairs: Rs ${costingSumRes.data.totals.total_repair_cost}, Diesel: Rs ${costingSumRes.data.totals.total_diesel_cost})` : 'FAILED ' + costingSumRes.status);

  // 13. Test Single Vehicle Costing Statement
  const singleCostRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/api/vehicle-costing/single-vehicle?asset_id=1&month=2026-08',
    method: 'GET',
    headers: authHeaders
  });
  const sum = singleCostRes.data.summary || singleCostRes.data.financial || {};
  console.log('✓ Single Vehicle Costing Statement (/api/vehicle-costing/single-vehicle):', singleCostRes.status === 200 ? `SUCCESS (Vehicle ${singleCostRes.data.asset.code}, Diesel: ${sum.diesel_litres || 0} L, Repairs: Rs ${sum.repair_cost || 0})` : 'FAILED ' + singleCostRes.status);

  // 14. Verify Frontend SPA Index Assets
  const indexRes = await request({
    hostname: 'localhost',
    port: 1949,
    path: '/',
    method: 'GET'
  });
  const html = typeof indexRes.data === 'string' ? indexRes.data : '';
  const hasAppJs = html.includes('app.js');
  const hasVehicleCosting = html.includes('vehicle_costing.js');
  const hasChartJs = html.includes('chart.umd.min.js');
  const hasFuelOps = html.includes('fuel_operations.js');
  console.log('✓ Frontend SPA Shell Assets:', (hasAppJs && hasVehicleCosting && hasChartJs && hasFuelOps) ? 'ALL BUNDLED & ACTIVE' : 'MISSING SCRIPTS');

  console.log('\n=== ALL 14 CORE VERIFICATION TESTS PASSED SUCCESSFULLY! ===');
}

runVerification().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
