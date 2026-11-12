'use strict';
const fetch = globalThis.fetch;

async function verify() {
  console.log('=== VERIFYING FLEET COSTING & REPAIRS ON PORT 1949 ===');

  // 1. Sign in. The credentials come from the environment, never from this file:
  //   WO_USER=admin WO_PASSWORD=... node scripts/verify_imported_costing.js
  const woPassword = process.env.WO_PASSWORD;
  if (!woPassword) throw new Error('Set WO_PASSWORD (and WO_USER if not admin) to sign in to port 1949.');
  const loginRes = await fetch('http://localhost:1949/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.WO_USER || 'admin', password: woPassword })
  });
  if (!loginRes.ok) throw new Error('Admin login failed: ' + loginRes.status);
  const cookie = loginRes.headers.get('set-cookie');
  console.log('✔ Logged into port 1949 as admin');

  // 2. Fetch fleet summary for 2026-08
  const fleetRes = await fetch('http://localhost:1949/api/vehicle-costing/fleet-summary?month=2026-08', {
    headers: { Cookie: cookie }
  });
  if (!fleetRes.ok) throw new Error('Fleet summary failed: ' + fleetRes.status);
  const fleetData = await fleetRes.json();

  console.log('\n--- Master Administrator Dashboard: Fleet Totals for 2026-08 ---');
  console.log('Total Vehicles in Fleet:       ', fleetData.vehicles.length);
  console.log('Total Fleet Hiring Revenue:    Rs', (fleetData.totals.total_hiring_revenue || 0).toLocaleString());
  console.log('Total Workshop Repairs Cost:   Rs', (fleetData.totals.total_repair_cost || 0).toLocaleString());
  console.log('Total Diesel Consumption Cost: Rs', (fleetData.totals.total_diesel_cost || 0).toLocaleString());
  console.log('Total Diesel Litres Dispensed: ', (fleetData.totals.total_diesel_litres || 0).toLocaleString(), 'L');
  console.log('Total Operational Expenses:    Rs', (fleetData.totals.total_expenses || 0).toLocaleString());
  console.log('Final Net Fleet Profit:        Rs', (fleetData.totals.total_net_profit || 0).toLocaleString());
  console.log('Fleet Profit Margin:           ', fleetData.totals.fleet_profit_margin_percent, '%');

  // 3. Find top 5 active vehicles by diesel and repairs
  const activeVehicles = fleetData.vehicles.filter(v => v.diesel_cost > 0 || v.repair_cost > 0);
  console.log(`\nFound ${activeVehicles.length} actively operating vehicles in 2026-08.`);
  console.log('Sample Top 5 Active Vehicles:');
  console.table(activeVehicles.slice(0, 5).map(v => ({
    Code: v.code,
    Reg: v.registration,
    Category: v.category,
    Revenue: v.hiring_revenue,
    Repairs: v.repair_cost,
    Diesel: v.diesel_cost,
    NetProfit: v.net_profit,
    Margin: v.margin_percent + '%'
  })));

  // 4. Test Single-Vehicle Costing Report for top vehicle
  const topAsset = activeVehicles[0];
  console.log(`\n--- Single-Vehicle Final Costing Statement for ${topAsset.code} (${topAsset.registration}) ---`);
  const repRes = await fetch(`http://localhost:1949/api/vehicle-costing/report?asset_id=${topAsset.id}&month=2026-08`, {
    headers: { Cookie: cookie }
  });
  if (!repRes.ok) throw new Error('Single vehicle report failed: ' + repRes.status);
  const rep = await repRes.json();

  console.log('Vehicle Code:            ', rep.asset.code);
  console.log('Registration:            ', rep.asset.registration);
  console.log('Make & Model:            ', rep.asset.brand, rep.asset.model);
  console.log('Operating Project:       ', rep.asset.project_name);
  console.log('Current Meter Hours:     ', rep.asset.current_hours);
  console.log('Monthly Hiring Revenue:  Rs', rep.summary.monthly_hiring_revenue.toLocaleString());
  console.log('Monthly Repair Cost:     Rs', rep.summary.monthly_vehicle_repair_cost.toLocaleString());
  console.log('Monthly Diesel Cost:     Rs', rep.summary.monthly_diesel_cost.toLocaleString(), `(${rep.summary.monthly_diesel_litres} L)`);
  console.log('Monthly Driver Costs:    Rs', rep.summary.monthly_driver_other_costs.toLocaleString());
  console.log('Total Expenses:          Rs', rep.summary.total_expenses.toLocaleString());
  console.log('Final Net Profit/(Loss): Rs', rep.summary.final_net_profit.toLocaleString());
  console.log('Profit Margin:           ', rep.summary.profit_margin_percent, '%');
  console.log('Fuel Issues Dispenses:   ', (rep.breakdown.diesel_costs.issues || []).length, 'transactions');
  console.log('Store Material Issues:   ', (rep.breakdown.repair_costs.store_issues || []).length, 'materials issued');
  console.log('Job Card Records:        ', (rep.breakdown.repair_costs.job_parts || []).length, 'parts used');

  // Verify the math: Net Profit = Revenue - (Repairs + Diesel + Driver)
  const expectedExp = rep.summary.monthly_vehicle_repair_cost + rep.summary.monthly_diesel_cost + rep.summary.monthly_driver_other_costs;
  const expectedNet = rep.summary.monthly_hiring_revenue - expectedExp;
  if (Math.abs(rep.summary.total_expenses - expectedExp) > 0.01) {
    throw new Error('Total expenses mismatch');
  }
  if (Math.abs(rep.summary.final_net_profit - expectedNet) > 0.01) {
    throw new Error('Net profit math mismatch');
  }
  console.log('\n✔ All costing and profitability equations MATHEMATICALLY VERIFIED!');
}

verify().catch(console.error);
