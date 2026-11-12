const http = require('http');

async function testVehicleWithActivity() {
  const loginRes = await new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: 1949, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ headers: res.headers }));
    });
    // Credentials from the environment, never from this file: WO_USER=admin WO_PASSWORD=... node scripts/test_active_vehicle.js
    if (!process.env.WO_PASSWORD) throw new Error('Set WO_PASSWORD (and WO_USER if not admin).');
    req.write(JSON.stringify({ username: process.env.WO_USER || 'admin', password: process.env.WO_PASSWORD }));
    req.end();
  });

  const cookie = loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

  // Get active vehicle from fleet summary
  const sumRes = await new Promise((resolve) => {
    http.get({
      hostname: 'localhost', port: 1949, path: '/api/vehicle-costing/fleet-summary?month=2026-08',
      headers: { Cookie: cookie }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });

  const activeVehicles = (sumRes.vehicles || []).filter(v => v.diesel_cost > 0 || v.repair_cost > 0);
  console.log('Total vehicles with active cost in 2026-08:', activeVehicles.length);

  if (activeVehicles.length > 0) {
    const v = activeVehicles[0];
    const vid = v.id || v.asset_id;
    console.log(`\nTesting Single Vehicle Costing Statement for Vehicle ${v.code} (ID: ${vid})...`);

    const rep = await new Promise((resolve) => {
      http.get({
        hostname: 'localhost', port: 1949, path: `/api/vehicle-costing/single-vehicle?asset_id=${vid}&month=2026-08`,
        headers: { Cookie: cookie }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      });
    });

    console.log('Asset Code:', rep.asset.code);
    console.log('Registration:', rep.asset.registration);
    console.log('Summary P&L:', rep.summary);
    console.log('Store Material Issues Count:', (rep.breakdown.repair_costs ? rep.breakdown.repair_costs.store_issues.length : 0));
    console.log('Diesel Dispense Slips Count:', (rep.breakdown.diesel_costs ? rep.breakdown.diesel_costs.issues.length : 0));
  }
}

testVehicleWithActivity().catch(console.error);
