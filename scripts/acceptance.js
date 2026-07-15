'use strict';

// Go-live acceptance checklist (Phase 4 Step 6). Runs against a LIVE server and
// exercises the real HTTP flows the team depends on, printing PASS/FAIL per item.
//
//   ACCEPTANCE_URL=http://<server-ip>:<port> node scripts/acceptance.js
//
// Requires a seeded DB with the demo/role accounts usable (run this BEFORE
// `admin.js rotate-seed`, or point it at dedicated test accounts). Exits non-zero
// if any check fails.

const BASE = process.env.ACCEPTANCE_URL || process.argv[2] || 'http://localhost:3000';

function session() {
  let cookie = null;
  return {
    async req(path, opts = {}) {
      const res = await fetch(BASE + path, {
        method: opts.method || 'GET',
        headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const ct = res.headers.get('content-type') || '';
      return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
    },
    async login(u, p) { return this.req('/api/auth/login', { method: 'POST', body: { username: u, password: p } }); },
  };
}

const results = [];
const check = (name, cond, detail) => { results.push({ name, ok: !!cond, detail }); };

async function run() {
  // ---- 1. storekeeper MRN -> priced GRN -> issue ----
  try {
    const s = session();
    await s.login('store', 'store');
    const mrn = await s.req('/api/stores/mrn', { method: 'POST', body: { asset: '28-4314', purpose: 'acceptance', lines: [{ description: 'Acc part', qty: 1 }] } });
    const lineId = mrn.body.lines && mrn.body.lines[0] && mrn.body.lines[0].id;
    const grn = await s.req('/api/stores/grn', { method: 'POST', body: { mrn_id: mrn.body.mrn.id, mrn_line_id: lineId, description: 'Acc part', qty: 1, unit_price: 1000, supplier: 'Acc', purchase_source: 'local_purchase' } });
    const iss = await s.req('/api/stores/issues', { method: 'POST', body: { asset: '28-4314', description: 'Acc issue', qty: 1, unit_price: 500 } });
    check('Storekeeper: MRN -> priced GRN -> issue', mrn.status === 201 && grn.status === 201 && iss.status === 201, `mrn ${mrn.status} grn ${grn.status} issue ${iss.status}`);
  } catch (e) { check('Storekeeper: MRN -> priced GRN -> issue', false, e.message); }

  // ---- 2. full job lifecycle incl. multi-mechanic split + closure gate ----
  try {
    const t = session(); await t.login('transport', 'transport');
    const o = session(); await o.login('ops', 'ops');
    const m = session(); await m.login('mech', 'mech');
    const st = session(); await st.login('store', 'store');

    const created = await t.req('/api/jobs', { method: 'POST', body: { asset: '28-4314', type: 'repair', description: 'acceptance job' } });
    const id = created.body.job.id;
    await t.req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'APPROVED_TRANSPORT' } });
    await o.req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'APPROVED_OPERATIONS' } });
    await m.req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'IN_WORKSHOP' } });
    await m.req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'IN_PROGRESS' } });

    const dw = await m.req(`/api/jobs/${id}/daily-work`, { method: 'POST', body: { mechanic: 'Anura, Buddhika', hours: 4 } });
    const split = Array.isArray(dw.body) && dw.body.length === 2 && dw.body.every((r) => r.hours === 2);
    check('Daily work: multi-mechanic entry split (2 rows, hours halved)', split, `rows ${Array.isArray(dw.body) ? dw.body.length : '?'}`);

    await m.req(`/api/jobs/${id}/parts`, { method: 'POST', body: { source_type: 'grn', description: 'unpriced part', qty: 1 } });
    await m.req(`/api/jobs/${id}/daily-work`, { method: 'POST', body: { is_external: true, external_value: 2000, description: 'outside repair' } });
    const products = (await st.req('/api/oil/products')).body;
    const ci4 = products.find((p) => p.code === 'CI4');
    if (ci4) await st.req('/api/oil/ledger', { method: 'POST', body: { product_id: ci4.id, kind: 'issue', qty: 5, job_id: id, asset: '28-4314' } });
    await m.req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'WORK_COMPLETE' } });

    const blocked = await o.req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'CLOSED' } });
    check('Closure gate: blocks an unpriced line (409 + missing list)', blocked.status === 409 && Array.isArray(blocked.body.missing) && blocked.body.missing.length >= 1, `status ${blocked.status}`);

    const detail = await m.req(`/api/jobs/${id}`);
    const partId = detail.body.parts[0].id;
    await m.req(`/api/jobs/${id}/parts/${partId}`, { method: 'PATCH', body: { unit_price: 1500 } });
    const closed = await o.req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'CLOSED' } });
    const c = closed.body;
    const expected = (c.labour_cost + c.material_cost + c.oil_cost + c.general_cost + c.external_cost);
    check('Job card: closes once priced, total = sum of components', closed.status === 200 && c.status === 'CLOSED' && Math.abs(expected - c.total_cost) < 0.01, `total ${c.total_cost}`);
  } catch (e) { check('Full job lifecycle + closure gate', false, e.message); }

  // ---- 3. oil ledger balance + stock count variance ----
  try {
    const s = session(); await s.login('store', 'store');
    const balances = (await s.req('/api/oil/balances')).body;
    const p = balances[0];
    const count = await s.req('/api/oil/counts', { method: 'POST', body: { product_id: p.product_id, period: '2099-01', counted_qty: p.balance - 3 } });
    check('Oil: running balance readable + stock count computes variance', count.status === 201 && Math.abs(count.body.variance - (-3)) < 0.01, `variance ${count.body && count.body.variance}`);
  } catch (e) { check('Oil ledger + stock count variance', false, e.message); }

  // ---- 4. battery whereis + history ----
  try {
    const s = session(); await s.login('store', 'store');
    const w = await s.req('/api/batteries/whereis/M158752495');
    const det = await s.req(`/api/batteries/${w.body.battery.id}`);
    check('Battery: which battery is in vehicle X + serial history', w.body.current_asset && w.body.current_asset.code === '28-4314' && det.body.events.length >= 1, `at ${w.body.current_asset && w.body.current_asset.code}, ${det.body.events.length} events`);
  } catch (e) { check('Battery whereis + history', false, e.message); }

  // ---- 5. dashboards load ----
  try {
    const s = session(); await s.login('ops', 'ops');
    const d = await s.req('/api/reports/dashboard');
    check('Dashboards: open jobs / low-stock / cost-by-project / awaiting-price', d.status === 200 && Array.isArray(d.body.jobs_by_status) && 'month_cost_by_project' in d.body, `status ${d.status}`);
  } catch (e) { check('Dashboards load', false, e.message); }

  // ---- 6. permissions: viewer cannot write ----
  try {
    const v = session(); await v.login('viewer', 'viewer');
    const w = await v.req('/api/stores/issues', { method: 'POST', body: { asset: '28-4314', description: 'nope' } });
    check('Permissions: viewer is read-only (write forbidden)', w.status === 403, `status ${w.status}`);
  } catch (e) { check('Permissions: viewer read-only', false, e.message); }

  // ---- report ----
  console.log(`\nGo-live acceptance — ${BASE}\n` + '='.repeat(60));
  let pass = 0;
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
    if (r.ok) pass++;
  }
  console.log('='.repeat(60));
  console.log(`  ${pass}/${results.length} checks passed\n`);
  process.exit(pass === results.length ? 0 : 1);
}

run().catch((e) => { console.error('Acceptance run crashed:', e.message); process.exit(1); });
