'use strict';

const assert = require('assert');

async function runTests() {
  console.log('====================================================');
  console.log('Testing Active Store & Site Location Context Cascading');
  console.log('====================================================\n');

  const BASE = 'http://localhost:1929/api';

  // Helper for requests
  async function req(path, { method = 'GET', body = null, cookie = null, headers = {} } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  // 1. Log in as mstore (Main Storekeeper)
  console.log('1. Logging in as mstore (Main Storekeeper)...');
  const loginMstore = await req('/auth/login', {
    method: 'POST',
    body: { username: 'mstore', password: 'ChangeMe1!' }
  });
  assert.strictEqual(loginMstore.status, 200, 'mstore login should succeed');
  const mstoreCookie = loginMstore.headers.get('set-cookie');
  console.log('   mstore logged in successfully. User:', loginMstore.data.username);
  console.log('   isMainStore:', loginMstore.data.isMainStore);
  assert.strictEqual(loginMstore.data.isMainStore, true, 'mstore must have isMainStore = true');

  // 2. Query Dashboard as Central Main Stores (Global)
  console.log('\n2. Querying Dashboard as Central Main Stores (X-Store-Location-Id: 1)...');
  const dashCentral = await req('/dashboard/overview', {
    cookie: mstoreCookie,
    headers: { 'X-Store-Location-Id': '1' }
  });
  assert.strictEqual(dashCentral.status, 200, 'Dashboard overview should return 200');
  console.log('   Central Dashboard active_jobs:', dashCentral.data.active_jobs);
  console.log('   Central Dashboard pending_requests:', dashCentral.data.pending_requests);

  // 3. Switch Context to Galagedara Site Store (X-Store-Location-Id: 3)
  console.log('\n3. Querying Dashboard under Galagedara Site Store Context (X-Store-Location-Id: 3)...');
  const dashGws = await req('/dashboard/overview', {
    cookie: mstoreCookie,
    headers: { 'X-Store-Location-Id': '3' }
  });
  assert.strictEqual(dashGws.status, 200, 'Dashboard overview for Galagedara should return 200');
  console.log('   Galagedara Dashboard active_jobs:', dashGws.data.active_jobs);
  console.log('   Galagedara Dashboard pending_requests:', dashGws.data.pending_requests);

  // 4. Query Job Cards under Galagedara Context (X-Store-Location-Id: 3)
  console.log('\n4. Querying Job Cards under Galagedara Context (X-Store-Location-Id: 3)...');
  const jobsGws = await req('/jobs', {
    cookie: mstoreCookie,
    headers: { 'X-Store-Location-Id': '3' }
  });
  assert.strictEqual(jobsGws.status, 200, 'Jobs list should return 200');
  console.log(`   Found ${jobsGws.data.length} job cards.`);
  for (const j of jobsGws.data) {
    assert.strictEqual(j.workshop_id, 2, `Job ${j.job_no} must belong to Galagedara (workshop 2)`);
  }
  console.log('   All returned job cards belong strictly to Galagedara workshop!');

  // 5. Query Mechanics KPI under Galagedara Context (X-Store-Location-Id: 3)
  console.log('\n5. Querying Mechanics KPI under Galagedara Context (X-Store-Location-Id: 3)...');
  const kpiGws = await req('/daily-work/mechanics-kpi', {
    cookie: mstoreCookie,
    headers: { 'X-Store-Location-Id': '3' }
  });
  assert.strictEqual(kpiGws.status, 200, 'Mechanics KPI should return 200');
  console.log('   Mechanics KPI returned successfully for Galagedara.');

  // 6. Query Assets under CEP-03 Project Site Store Context (X-Store-Location-Id: 4)
  console.log('\n6. Querying Assets under CEP-03 Project Site Store Context (X-Store-Location-Id: 4)...');
  const assetsCep = await req('/assets', {
    cookie: mstoreCookie,
    headers: { 'X-Store-Location-Id': '4' }
  });
  assert.strictEqual(assetsCep.status, 200, 'Assets list should return 200');
  console.log(`   Found ${assetsCep.data.length} assets assigned to CEP-03.`);
  for (const a of assetsCep.data) {
    assert.ok(
      a.current_project_id === 1 || a.home_project_id === 1,
      `Asset ${a.code} must belong to CEP-03 Project (id 1)`
    );
  }
  console.log('   All returned assets belong strictly to CEP-03 Project!');

  // 7. Query Alias Queue Missing Allocations under Galagedara Context (X-Store-Location-Id: 3)
  console.log('\n7. Querying Alias Queue under Galagedara Context (X-Store-Location-Id: 3)...');
  const aliasGws = await req('/aliases/sections-audit', {
    cookie: mstoreCookie,
    headers: { 'X-Store-Location-Id': '3' }
  });
  assert.strictEqual(aliasGws.status, 200, 'Alias audit should return 200');
  console.log('   Missing allocations counts for Galagedara:', aliasGws.data.counts);

  // 8. Log in as Sub-Store User: galagedara
  console.log('\n8. Logging in as Sub-Store User: galagedara...');
  const loginGws = await req('/auth/login', {
    method: 'POST',
    body: { username: 'galagedara', password: 'ChangeMe1!' }
  });
  assert.strictEqual(loginGws.status, 200, 'galagedara login should succeed');
  const gwsCookie = loginGws.headers.get('set-cookie');
  console.log('   galagedara logged in successfully.');
  console.log('   isMainStore:', loginGws.data.isMainStore);
  console.log('   storeLocationId:', loginGws.data.storeLocationId);
  console.log('   storeName:', loginGws.data.storeName);
  assert.strictEqual(loginGws.data.isMainStore, false, 'galagedara must NOT be Main Store');
  assert.strictEqual(loginGws.data.storeLocationId, 3, 'galagedara must be locked to Galagedara Site Store (id 3)');

  // 9. Sub-store attempts to query another store's inventory directly -> must be 403 Forbidden!
  console.log('\n9. Sub-store attempting to query Central Store cockpit directly (physical_store_id: 1)...');
  const subCrossStore = await req('/stores/cockpit?physical_store_id=1', {
    cookie: gwsCookie,
    headers: { 'X-Store-Location-Id': '1' } // Attempt to spoof header
  });
  console.log('   Response status:', subCrossStore.status, subCrossStore.data.error || '');
  assert.strictEqual(subCrossStore.status, 403, 'Cross-store query by sub-store MUST return 403 Forbidden');
  console.log('   Cross-store direct access was correctly blocked by MTN governance rule!');

  // 10. Sub-store queries its own store cockpit -> must succeed (200 OK)
  console.log('\n10. Sub-store querying its own Galagedara cockpit...');
  const subOwnCockpit = await req('/stores/cockpit?physical_store_id=3', {
    cookie: gwsCookie
  });
  assert.strictEqual(subOwnCockpit.status, 200, 'Own store cockpit query should return 200');
  console.log('   Sub-store successfully accessed its own store cockpit:', subOwnCockpit.data.store.name);

  console.log('\n====================================================');
  console.log('ALL VERIFICATION TESTS PASSED SUCCESSFULLY! (10/10)');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
