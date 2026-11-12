'use strict';

/**
 * WorkshopOne + Fuel-System-V2 Machine Hire, Costing Options, Rate Cards,
 * Consumption Bands, Site Allocator, Breakdowns & Billing Module (:1949)
 *
 * Mounts at window.routes['hire-billing'] and window.routes['hire']
 * 5 Integrated Tabs:
 *   1. 📑 Rental Bills & Revisions (Auto-Prefill from Fuel/Meters, SSCL 2.5% + VAT 18%, Revise, Finalise)
 *   2. 🏷️ Rate Cards & Consumption Bands (495 Fleet Rate Cards + 59 Portable Plant Classes + Econ/Typ/Heavy Editor)
 *   3. 📍 Site Allocator Console (Assign/Transfer Machines to Projects with DRY / WET / FUEL_ONLY basis)
 *   4. 🛠️ Breakdown Days Log (Machine downtime log for rental deduction)
 *   5. 💰 Payments & Receivables Aging (0–30, 31–60, 61–90, 90+ days buckets & payment recording)
 */

(function () {
  function fmtLkr(val) {
    return 'Rs ' + Number(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtCents(c) {
    return fmtLkr(Number(c || 0) / 100);
  }

  function fmtNum(val, dec = 1) {
    if (val === null || val === undefined || isNaN(Number(val))) return '—';
    return Number(val).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  async function renderHireBilling(content) {
    const hashParts = (location.hash || '').split('?');
    const qParams = new URLSearchParams(hashParts[1] || '');
    let activeTab = qParams.get('tab') || 'bills';
    let curYear = 2026;
    let curMonth = 8;

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / Machine Hire, Costing Options, Rates &amp; Billing</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:800">📑 Machine Hire, Costing Options &amp; Rate Cards</h1>
          <p class="muted" style="margin:4px 0 0 0">Dry/Wet/Fully-Wet tariffs, Econ–Typ–Heavy consumption bands, Portable Plant rates, Site Allocator, Breakdowns &amp; Billing</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="btn_generate_bill">⚡ + Generate Rental Bill</button>
          <button class="btn" id="btn_sync_costing" style="background:#059669;color:#fff;border-color:#059669">🔄 Sync Bills to Vehicle Costing P&amp;L</button>
          <a href="#/vehicle-costing" class="btn">💰 Final Costing P&amp;L</a>
        </div>
      </div>

      <!-- 5-Tab Bar -->
      <div class="tabs" id="hire_tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid var(--border);padding-bottom:8px">
        <button class="btn sm" data-tab="bills">📑 Rental Bills &amp; Revisions</button>
        <button class="btn sm" data-tab="rates">🏷️ Rate Cards &amp; Consumption Bands</button>
        <button class="btn sm" data-tab="allocations">📍 Site Allocator Console</button>
        <button class="btn sm" data-tab="breakdowns">🛠️ Breakdown Days Log</button>
        <button class="btn sm" data-tab="aging">💰 Payments &amp; Receivables Aging</button>
      </div>

      <div id="hire_tab_content"></div>
    `;

    function switchTab(t) {
      activeTab = t;
      qsa('#hire_tabs button').forEach((b) => b.classList.toggle('primary', b.getAttribute('data-tab') === t));
      const box = qs('#hire_tab_content');
      if (t === 'bills') renderBillsTab(box);
      else if (t === 'rates') renderRatesTab(box);
      else if (t === 'allocations') renderAllocationsTab(box);
      else if (t === 'breakdowns') renderBreakdownsTab(box);
      else if (t === 'aging') renderAgingTab(box);
    }

    qsa('#hire_tabs button').forEach((b) => {
      b.onclick = () => switchTab(b.getAttribute('data-tab'));
    });

    // 1-Click Sync to Vehicle Costing P&L
    qs('#btn_sync_costing').onclick = async () => {
      const m = prompt('Enter period month (YYYY-MM) to auto-generate & sync rental bills from Rate Cards and Fuel/Meter ledger into Vehicle Costing P&L:', `${curYear}-${String(curMonth).padStart(2, '0')}`);
      if (!m) return;
      try {
        const res = await api('/hire/sync-to-costing', { method: 'POST', body: { month: m.trim() } });
        toast(`Synced ${res.generatedBills} new rental bills (${res.totalMonthBills} total bills active for ${res.month})!`);
        if (activeTab === 'bills') switchTab('bills');
      } catch (err) {
        alert('Sync error: ' + err.message);
      }
    };

    // Smart Generate Bill Modal with Auto-Prefill from Fuel & Meter Ledger
    qs('#btn_generate_bill').onclick = () => openGenerateBillModal(() => switchTab('bills'));

    function openGenerateBillModal(onDone) {
      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal" style="max-width:580px;padding:24px">
          <h2 style="margin:0 0 4px 0">⚡ Generate Machine Rental Bill</h2>
          <p class="muted" style="margin:0 0 12px 0;font-size:12px">Auto-fills Rate Card, Meter Span, Fuel Litres, and Breakdown Days from the database</p>
          <form id="form_generate_bill" style="display:flex;flex-direction:column;gap:12px">
            <div style="display:grid;grid-template-columns:1.2fr 0.8fr 0.8fr auto;gap:8px;align-items:flex-end">
              <div>
                <label style="font-size:11px;font-weight:600">Vehicle / Machine Code *</label>
                <input type="text" id="gen_asset_code" required class="input sm" placeholder="e.g. LB-22, EX-01" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Year *</label>
                <input type="number" id="gen_year" class="input sm" value="${curYear}" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Month *</label>
                <input type="number" id="gen_month" class="input sm" min="1" max="12" value="${curMonth}" style="width:100%">
              </div>
              <button type="button" class="btn sm primary" id="btn_gen_prefill">⚡ Auto-Fill</button>
            </div>

            <div id="gen_prefill_banner" style="display:none;padding:8px 12px;border-radius:6px;background:rgba(16,185,129,0.1);font-size:12px"></div>

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;font-weight:600">Billing Basis *</label>
                <select id="gen_billing_mode" class="input sm" style="width:100%">
                  <option value="DRY">DRY (Fuel by Client / Recharged)</option>
                  <option value="WET">WET (With Operator + Fuel Recharged)</option>
                  <option value="FULLY_WET">FULLY WET (Fuel Inclusive)</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Rate Unit</label>
                <select id="gen_rate_basis" class="input sm" style="width:100%">
                  <option value="HOURLY">HOURLY (Rs/hr)</option>
                  <option value="DAILY">DAILY (Rs/day)</option>
                  <option value="KM">KM (Rs/km)</option>
                  <option value="MONTHLY">MONTHLY</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Tariff Rate (Rs / Unit) *</label>
                <input type="number" step="1" id="gen_rate_rs" required class="input sm" placeholder="2800" style="width:100%">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;font-weight:600">Actual Units Worked *</label>
                <input type="number" step="0.1" id="gen_actual_units" required class="input sm" placeholder="Hours / KM" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Min Guarantee Units</label>
                <input type="number" step="0.1" id="gen_min_units" class="input sm" value="0" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Breakdown Days</label>
                <input type="number" id="gen_breakdown_days" class="input sm" value="0" style="width:100%">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;font-weight:600">Issued Fuel in Month (Litres)</label>
                <input type="number" step="0.1" id="gen_fuel_litres" class="input sm" value="0" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Notes / Contract Ref</label>
                <input type="text" id="gen_notes" class="input sm" placeholder="Monthly hire invoice" style="width:100%">
              </div>
            </div>

            <div style="background:rgba(0,102,255,0.06);border:1px solid rgba(0,102,255,0.2);padding:10px;border-radius:8px;font-size:12px">
              ℹ️ Automatically computes <b>Rental + Fuel Recharge − Breakdown Deduction + SSCL 2.5% + VAT 18%</b>.
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
              <button type="button" class="btn" id="btn_cancel_gen">Cancel</button>
              <button type="submit" class="btn primary" id="btn_submit_gen">Generate Bill</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modal);

      let prefilledProjectId = null;
      let prefilledOpenMeter = null;
      let prefilledCloseMeter = null;

      modal.querySelector('#btn_gen_prefill').onclick = async () => {
        const code = modal.querySelector('#gen_asset_code').value.trim();
        const y = modal.querySelector('#gen_year').value;
        const m = modal.querySelector('#gen_month').value;
        if (!code) return alert('Enter a vehicle code first');
        try {
          const p = await api(`/hire/bills/prefill?assetCode=${encodeURIComponent(code)}&year=${y}&month=${m}`);
          prefilledProjectId = p.projectId;
          prefilledOpenMeter = p.openingMeter;
          prefilledCloseMeter = p.closingMeter;

          modal.querySelector('#gen_billing_mode').value = p.billingMode || 'DRY';
          modal.querySelector('#gen_rate_basis').value = p.rateBasis || 'HOURLY';
          modal.querySelector('#gen_rate_rs').value = Math.round((p.rateCents || 0) / 100);
          modal.querySelector('#gen_actual_units').value = p.actualUnits || p.minBillHours || 100;
          modal.querySelector('#gen_min_units').value = p.minBillHours || 0;
          modal.querySelector('#gen_fuel_litres').value = p.fuelLitres || 0;
          modal.querySelector('#gen_breakdown_days').value = p.breakdownDays || 0;

          const ban = modal.querySelector('#gen_prefill_banner');
          ban.style.display = 'block';
          ban.innerHTML = `✅ <b>${esc(p.asset.code)}</b> (${esc(p.asset.category || '')}) · Site: <b>${esc(p.projectName || 'Central')}</b> · Meter Span: <b>${p.openingMeter ?? '—'} → ${p.closingMeter ?? '—'} (+${p.actualUnits})</b> · Fuel: <b>${p.fuelLitres} L</b>`;
        } catch (err) {
          alert('Prefill lookup: ' + err.message);
        }
      };

      modal.querySelector('#btn_cancel_gen').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelector('#form_generate_bill').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const res = await api('/hire/bills/generate', {
            method: 'POST',
            body: {
              assetCode: modal.querySelector('#gen_asset_code').value.trim(),
              year: Number(modal.querySelector('#gen_year').value),
              month: Number(modal.querySelector('#gen_month').value),
              billingMode: modal.querySelector('#gen_billing_mode').value,
              rateBasis: modal.querySelector('#gen_rate_basis').value,
              rateCents: Math.round(Number(modal.querySelector('#gen_rate_rs').value) * 100),
              actualUnits: Number(modal.querySelector('#gen_actual_units').value),
              minBillHours: Number(modal.querySelector('#gen_min_units').value) || 0,
              fuelLitres: Number(modal.querySelector('#gen_fuel_litres').value) || 0,
              breakdownDays: Number(modal.querySelector('#gen_breakdown_days').value) || 0,
              projectId: prefilledProjectId,
              openingMeter: prefilledOpenMeter,
              closingMeter: prefilledCloseMeter,
              notes: modal.querySelector('#gen_notes').value.trim(),
            },
          });
          toast(`Bill generated! Grand Total: ${fmtCents(res.calculation.grandTotalCents)}`);
          modal.remove();
          if (typeof onDone === 'function') onDone();
        } catch (err) {
          alert(err.message);
        }
      };
    }

    // =========================================================================
    // TAB 1: RENTAL BILLS & REVISIONS
    // =========================================================================
    function renderBillsTab(box) {
      box.innerHTML = `
        <div class="card" style="padding:12px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="bill_search" placeholder="Search invoice #, vehicle code, site..." class="input sm" style="flex:1;min-width:190px">
          <select id="bill_year" class="input sm">
            <option value="2026" selected>2026</option>
            <option value="2025">2025</option>
          </select>
          <select id="bill_month" class="input sm">
            <option value="">All Months</option>
            ${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === curMonth ? 'selected' : ''}>${new Date(2026, i).toLocaleString('en', { month: 'long' })}</option>`).join('')}
          </select>
          <select id="bill_status" class="input sm">
            <option value="">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="FINAL">Final</option>
            <option value="PAID">Paid</option>
          </select>
          <button class="btn sm primary" id="btn_bill_filter">Filter</button>
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:12.5px">
            <thead>
              <tr style="background:rgba(0,0,0,0.02)">
                <th style="padding:10px 12px">Period</th>
                <th style="padding:10px 12px">Invoice #</th>
                <th style="padding:10px 12px">Vehicle</th>
                <th style="padding:10px 12px">Project / Site</th>
                <th style="padding:10px 12px">Mode</th>
                <th style="padding:10px 12px;text-align:right">Billable Units</th>
                <th style="padding:10px 12px;text-align:right">Rental Amt</th>
                <th style="padding:10px 12px;text-align:right">Fuel Recharge</th>
                <th style="padding:10px 12px;text-align:right">Grand Total</th>
                <th style="padding:10px 12px;text-align:right">Balance Due</th>
                <th style="padding:10px 12px;text-align:center">Status</th>
                <th style="padding:10px 12px;text-align:center">Actions</th>
              </tr>
            </thead>
            <tbody id="bills_tbody">
              <tr><td colspan="12" style="padding:24px;text-align:center" class="muted">Loading rental bills...</td></tr>
            </tbody>
          </table>
        </div>
      `;

      async function loadBills() {
        const q = new URLSearchParams({ limit: 150 });
        const s = qs('#bill_search', box).value.trim();
        const y = qs('#bill_year', box).value;
        const m = qs('#bill_month', box).value;
        const st = qs('#bill_status', box).value;
        if (s) q.set('search', s);
        if (y) q.set('year', y);
        if (m) q.set('month', m);
        if (st) q.set('status', st);

        const tbody = qs('#bills_tbody', box);
        try {
          const res = await api(`/hire/bills?${q.toString()}`);
          const bills = res.bills || [];
          if (!bills.length) {
            tbody.innerHTML = '<tr><td colspan="12" style="padding:24px;text-align:center" class="muted">No rental bills found for this filter. Click "🔄 Sync Bills to Vehicle Costing P&L" or "+ Generate Rental Bill".</td></tr>';
            return;
          }

          tbody.innerHTML = bills.map((b) => {
            const stBadge = b.status === 'PAID'
              ? '<span class="badge ok">PAID</span>'
              : (b.status === 'FINAL' ? '<span class="badge primary">FINAL</span>' : '<span class="badge warn">DRAFT</span>');
            return `
              <tr>
                <td style="padding:9px 12px;white-space:nowrap">${esc(b.period_key)}</td>
                <td style="padding:9px 12px;font-family:monospace;font-weight:700">
                  ${esc(b.invoice_number || 'DRAFT')}
                  ${b.revision_count > 0 ? `<span class="badge" style="font-size:10px">Rev ${b.revision_count}</span>` : ''}
                </td>
                <td style="padding:9px 12px"><a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(b.asset_code)}" style="font-weight:700">${esc(b.asset_code)}</a></td>
                <td style="padding:9px 12px">${esc(b.project_name || 'Central')}</td>
                <td style="padding:9px 12px"><span class="badge">${esc(b.billing_mode || 'DRY')} · ${esc(b.rate_basis || 'HOURLY')}</span></td>
                <td style="padding:9px 12px;text-align:right">${fmtNum(b.billable_units, 1)}</td>
                <td style="padding:9px 12px;text-align:right">${fmtCents(b.rental_amount_cents)}</td>
                <td style="padding:9px 12px;text-align:right">${fmtCents(b.fuel_cost_cents)}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:800;color:var(--primary,#0066ff)">${fmtCents(b.grand_total_cents)}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:700;color:${b.balance_cents > 0 ? '#d97706' : '#059669'}">${fmtCents(b.balance_cents)}</td>
                <td style="padding:9px 12px;text-align:center">${stBadge}</td>
                <td style="padding:9px 12px;text-align:center;white-space:nowrap">
                  <button class="btn sm btn-bill-detail" data-id="${esc(b.id)}">🔍 Revise / Pay</button>
                  ${b.status === 'DRAFT' ? `<button class="btn sm primary btn-bill-final" data-id="${esc(b.id)}" style="margin-left:4px">Finalise</button>` : ''}
                </td>
              </tr>
            `;
          }).join('');

          qsa('.btn-bill-final', tbody).forEach((btn) => {
            btn.onclick = async () => {
              const id = btn.getAttribute('data-id');
              try {
                const r = await api(`/hire/bills/${id}/finalise`, { method: 'POST' });
                toast(`Bill finalised (${r.invoice_number})`);
                loadBills();
              } catch (err) {
                alert(err.message);
              }
            };
          });

          qsa('.btn-bill-detail', tbody).forEach((btn) => {
            btn.onclick = () => openBillDetailModal(btn.getAttribute('data-id'), loadBills);
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="12" class="err" style="padding:20px">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#btn_bill_filter', box).onclick = loadBills;
      qs('#bill_search', box).onkeydown = (e) => { if (e.key === 'Enter') loadBills(); };
      loadBills();
    }

    async function openBillDetailModal(billId, onDone) {
      const data = await api(`/hire/bills/${billId}`);
      const b = data.bill;
      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal" style="max-width:740px;width:95%;max-height:88vh;overflow-y:auto;padding:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div>
              <h2 style="margin:0">📑 Invoice ${esc(b.invoice_number || b.id)} — ${esc(b.asset_code)} (${esc(b.period_key)})</h2>
              <div class="muted" style="font-size:12px">Site: <b>${esc(b.project_name || 'Central')}</b> · Status: <b>${esc(b.status)}</b> · Grand Total: <b>${fmtCents(b.grand_total_cents)}</b> · Balance: <b>${fmtCents(b.balance_cents)}</b></div>
            </div>
            <button class="btn sm" id="btn_bd_close">✕ Close</button>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
            <!-- Amend / Create Revision -->
            <div class="card" style="padding:14px">
              <h3 style="margin:0 0 8px 0;font-size:14px">✏️ Amend Bill &amp; Save Revision Snapshot</h3>
              <form id="form_revise_bill" style="display:flex;flex-direction:column;gap:8px">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                  <div>
                    <label style="font-size:11px;font-weight:600">Actual Units</label>
                    <input type="number" step="0.1" id="rv_units" class="input sm" value="${b.actual_units || 0}" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Rate (Rs / Unit)</label>
                    <input type="number" step="1" id="rv_rate" class="input sm" value="${Math.round((b.rate_cents || 0) / 100)}" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Fuel Litres</label>
                    <input type="number" step="0.1" id="rv_fuel" class="input sm" value="${b.fuel_litres || 0}" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Breakdown Days</label>
                    <input type="number" id="rv_bd" class="input sm" value="${b.breakdown_days || 0}" style="width:100%">
                  </div>
                </div>
                <input type="text" id="rv_reason" required class="input sm" placeholder="Reason for revision (e.g. Verified site log hours)" style="width:100%">
                <button type="submit" class="btn sm primary">Save Revision &amp; Recalculate</button>
              </form>
            </div>

            <!-- Record Payment -->
            <div class="card" style="padding:14px">
              <h3 style="margin:0 0 8px 0;font-size:14px">💰 Record Client / Project Payment</h3>
              <form id="form_pay_bill" style="display:flex;flex-direction:column;gap:8px">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                  <div>
                    <label style="font-size:11px;font-weight:600">Amount (LKR) *</label>
                    <input type="number" step="0.01" id="py_amount" required class="input sm" value="${(b.balance_cents / 100).toFixed(2)}" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Payment Date *</label>
                    <input type="date" id="py_date" required class="input sm" value="${new Date().toISOString().slice(0, 10)}" style="width:100%">
                  </div>
                </div>
                <input type="text" id="py_ref" class="input sm" placeholder="Cheque / Bank Transfer Ref #" style="width:100%">
                <button type="submit" class="btn sm" style="background:#059669;color:#fff;border-color:#059669">Record Payment</button>
              </form>
            </div>
          </div>

          <h4 style="margin:8px 0 4px 0;font-size:13px">Revision History (${(data.revisions || []).length})</h4>
          <div style="font-size:12px;margin-bottom:10px">
            ${(data.revisions || []).length ? data.revisions.map((r) => `<div class="muted">• <b>Rev #${r.revision_number}</b> (${esc(String(r.created_at || '').slice(0, 16))} by ${esc(r.creator_name || 'User')}): ${esc(r.reason)}</div>`).join('') : '<span class="muted">Original version (no revisions)</span>'}
          </div>

          <h4 style="margin:8px 0 4px 0;font-size:13px">Payments Received (${(data.payments || []).length})</h4>
          <div style="font-size:12px">
            ${(data.payments || []).length ? data.payments.map((p) => `<div class="muted">• <b>${fmtCents(p.amount_cents)}</b> on ${esc(p.paid_date)} (${esc(p.reference || p.method || 'Transfer')})</div>`).join('') : '<span class="muted">No payments recorded yet</span>'}
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('#btn_bd_close').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelector('#form_revise_bill').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(`/hire/bills/${billId}/revise`, {
            method: 'POST',
            body: {
              actualUnits: Number(modal.querySelector('#rv_units').value),
              rateCents: Math.round(Number(modal.querySelector('#rv_rate').value) * 100),
              fuelLitres: Number(modal.querySelector('#rv_fuel').value),
              breakdownDays: Number(modal.querySelector('#rv_bd').value),
              reason: modal.querySelector('#rv_reason').value.trim(),
            },
          });
          toast('Bill revised and snapshot saved!');
          modal.remove();
          if (onDone) onDone();
        } catch (err) {
          alert(err.message);
        }
      };

      modal.querySelector('#form_pay_bill').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(`/hire/bills/${billId}/payments`, {
            method: 'POST',
            body: {
              amountLkr: Number(modal.querySelector('#py_amount').value),
              paidDate: modal.querySelector('#py_date').value,
              reference: modal.querySelector('#py_ref').value.trim(),
            },
          });
          toast('Payment recorded!');
          modal.remove();
          if (onDone) onDone();
        } catch (err) {
          alert(err.message);
        }
      };
    }

    // =========================================================================
    // TAB 2: RATE CARDS, PORTABLE PLANT & CONSUMPTION BANDS
    // =========================================================================
    async function renderRatesTab(box) {
      let mode = 'FLEET';
      let searchQ = '';
      let catFilter = '';

      box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Fleet Rate Cards, Portable Plant &amp; Consumption Bands...</div>`;

      try {
        const data = await api('/hire/rates-overview');
        const fleet = data.fleet || [];
        const portable = data.portable || [];
        const cats = data.categories || [];

        function draw() {
          const filteredFleet = fleet.filter((r) => {
            if (catFilter && String(r.category || '').toLowerCase() !== catFilter.toLowerCase()) return false;
            if (searchQ) {
              const q = searchQ.toUpperCase();
              return String(r.asset_code || '').toUpperCase().includes(q) ||
                     String(r.asset_reg || '').toUpperCase().includes(q) ||
                     String(r.category || '').toUpperCase().includes(q) ||
                     String(r.source_label || '').toUpperCase().includes(q);
            }
            return true;
          });

          box.innerHTML = `
            <div class="card" style="padding:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
              <div style="display:flex;gap:6px">
                <button class="btn sm ${mode === 'FLEET' ? 'primary' : ''}" id="btn_rt_fleet">🚜 Fleet Vehicles &amp; Heavy Plant (${fleet.length})</button>
                <button class="btn sm ${mode === 'PORTABLE' ? 'primary' : ''}" id="btn_rt_port">🧰 Portable Plant &amp; Small Equipment (${portable.length})</button>
              </div>
              ${mode === 'FLEET' ? `
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <input type="text" id="rt_search" value="${esc(searchQ)}" placeholder="Search vehicle code, reg, model..." class="input sm" style="min-width:210px">
                  <select id="rt_cat" class="input sm">
                    <option value="">All Categories</option>
                    ${cats.map((c) => `<option value="${esc(c)}" ${c === catFilter ? 'selected' : ''}>${esc(c)}</option>`).join('')}
                  </select>
                </div>
              ` : ''}
            </div>

            ${mode === 'FLEET' ? `
              <div class="card" style="padding:0;overflow-x:auto">
                <table class="table" style="width:100%;margin:0;font-size:12.5px">
                  <thead>
                    <tr style="background:rgba(0,0,0,0.02)">
                      <th style="padding:10px 12px">Vehicle</th>
                      <th style="padding:10px 12px">Category / Model</th>
                      <th style="padding:10px 12px">Basis</th>
                      <th style="padding:10px 12px;text-align:right">Dry Rate</th>
                      <th style="padding:10px 12px;text-align:right">Wet Rate</th>
                      <th style="padding:10px 12px;text-align:right">Fully Wet</th>
                      <th style="padding:10px 12px">Standard Band (Econ / Typ / Heavy)</th>
                      <th style="padding:10px 12px">Measured Burn</th>
                      <th style="padding:10px 12px;text-align:center">Edit</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filteredFleet.slice(0, 200).map((r, idx) => `
                      <tr>
                        <td style="padding:9px 12px">
                          <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(r.asset_code || '')}" style="font-weight:800;color:var(--primary,#0066ff)">${esc(r.asset_code || r.category)}</a>
                          <div class="muted" style="font-size:11px">${esc(r.asset_reg || '—')}</div>
                        </td>
                        <td style="padding:9px 12px">
                          <div>${esc(r.category || '—')}</div>
                          <div class="muted" style="font-size:11px">${esc(r.source_label || r.note || '')}</div>
                        </td>
                        <td style="padding:9px 12px"><span class="badge">${esc(r.default_basis || 'DRY')} · ${esc(r.rate_basis || 'HOURLY')}</span></td>
                        <td style="padding:9px 12px;text-align:right;font-weight:700">${fmtCents(r.dry_rate_cents || r.rate_cents)}</td>
                        <td style="padding:9px 12px;text-align:right">${r.wet_rate_cents ? fmtCents(r.wet_rate_cents) : '—'}</td>
                        <td style="padding:9px 12px;text-align:right">${r.fully_wet_rate_cents ? fmtCents(r.fully_wet_rate_cents) : '—'}</td>
                        <td style="padding:9px 12px">
                          ${r.typ_display != null ? `<b>${r.econ_display ?? '—'}</b> / <b style="color:#059669">${r.typ_display}</b> / <b style="color:#dc2626">${r.heavy_display ?? '—'}</b> <span class="muted">${r.display_unit}</span>` : '<span class="muted">Not set</span>'}
                        </td>
                        <td style="padding:9px 12px">
                          ${r.measured_display != null ? `<b>${r.measured_display} ${r.display_unit}</b>` : '<span class="muted">—</span>'}
                        </td>
                        <td style="padding:9px 12px;text-align:center">
                          <button class="btn sm btn-edit-rate" data-idx="${idx}">✏️ Edit</button>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : `
              <div class="card" style="padding:0;overflow-x:auto">
                <table class="table" style="width:100%;margin:0;font-size:12.5px">
                  <thead>
                    <tr style="background:rgba(0,0,0,0.02)">
                      <th style="padding:10px 12px">Equipment Category</th>
                      <th style="padding:10px 12px">Specification / Capacity</th>
                      <th style="padding:10px 12px">Rate Basis</th>
                      <th style="padding:10px 12px;text-align:right">Dry Rate (Rs / Day)</th>
                      <th style="padding:10px 12px;text-align:right">Wet Rate (Rs / Day)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${portable.map((p) => `
                      <tr>
                        <td style="padding:9px 12px"><b>${esc(p.category_name)}</b></td>
                        <td style="padding:9px 12px">${esc(p.source_label || p.note || '')}</td>
                        <td style="padding:9px 12px"><span class="badge">DAILY</span></td>
                        <td style="padding:9px 12px;text-align:right;font-weight:700">${fmtCents(p.port_dd_cents || p.dry_rate_cents)}</td>
                        <td style="padding:9px 12px;text-align:right;font-weight:700;color:#059669">${fmtCents(p.port_dw_cents || p.wet_rate_cents)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          `;

          qs('#btn_rt_fleet', box).onclick = () => { mode = 'FLEET'; draw(); };
          qs('#btn_rt_port', box).onclick = () => { mode = 'PORTABLE'; draw(); };
          if (mode === 'FLEET') {
            const sInp = qs('#rt_search', box);
            sInp.oninput = (e) => { searchQ = e.target.value; draw(); sInp.focus(); };
            qs('#rt_cat', box).onchange = (e) => { catFilter = e.target.value; draw(); };
            qsa('.btn-edit-rate', box).forEach((b) => {
              b.onclick = () => openEditRateModal(filteredFleet[Number(b.getAttribute('data-idx'))], () => renderRatesTab(box));
            });
          }
        }

        draw();
      } catch (err) {
        box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
      }
    }

    function openEditRateModal(r, onDone) {
      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal" style="max-width:520px;padding:24px">
          <h2 style="margin:0 0 8px 0">✏️ Edit Rate Card &amp; Consumption Band — ${esc(r.asset_code || r.category)}</h2>
          <form id="form_edit_rate" style="display:flex;flex-direction:column;gap:10px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;font-weight:600">Default Billing Basis</label>
                <select id="er_def_basis" class="input sm" style="width:100%">
                  <option value="DRY" ${r.default_basis === 'DRY' ? 'selected' : ''}>DRY</option>
                  <option value="WET" ${r.default_basis === 'WET' ? 'selected' : ''}>WET</option>
                  <option value="FUEL_ONLY" ${r.default_basis === 'FUEL_ONLY' ? 'selected' : ''}>FUEL_ONLY</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Rate Unit</label>
                <select id="er_rate_basis" class="input sm" style="width:100%">
                  <option value="HOURLY" ${r.rate_basis === 'HOURLY' ? 'selected' : ''}>HOURLY</option>
                  <option value="DAILY" ${r.rate_basis === 'DAILY' ? 'selected' : ''}>DAILY</option>
                  <option value="KM" ${r.rate_basis === 'KM' ? 'selected' : ''}>KM</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
              <div>
                <label style="font-size:11px;font-weight:600">Dry Rate (Rs)</label>
                <input type="number" id="er_dry" class="input sm" value="${Math.round((r.dry_rate_cents || r.rate_cents || 0) / 100)}" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Wet Rate (Rs)</label>
                <input type="number" id="er_wet" class="input sm" value="${Math.round((r.wet_rate_cents || 0) / 100)}" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Fully Wet (Rs)</label>
                <input type="number" id="er_fw" class="input sm" value="${Math.round((r.fully_wet_rate_cents || 0) / 100)}" style="width:100%">
              </div>
            </div>
            <div style="padding:10px;background:rgba(16,185,129,0.06);border-radius:6px">
              <div style="font-size:11px;font-weight:700;margin-bottom:6px">Standard Consumption Band (${esc(r.display_unit || 'L/hr')})</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                <div>
                  <label style="font-size:10px">Economical</label>
                  <input type="number" step="0.01" id="er_econ" class="input sm" value="${r.econ_display ?? ''}" style="width:100%">
                </div>
                <div>
                  <label style="font-size:10px">Typical (Norm)</label>
                  <input type="number" step="0.01" id="er_typ" class="input sm" value="${r.typ_display ?? ''}" style="width:100%">
                </div>
                <div>
                  <label style="font-size:10px">Heavy Limit</label>
                  <input type="number" step="0.01" id="er_heavy" class="input sm" value="${r.heavy_display ?? ''}" style="width:100%">
                </div>
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn sm" id="btn_er_cancel">Cancel</button>
              <button type="submit" class="btn sm primary">Save Rate &amp; Band</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('#btn_er_cancel').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelector('#form_edit_rate').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/hire/rates', {
            method: 'POST',
            body: {
              id: r.id,
              assetId: r.asset_id,
              categoryName: r.category,
              defaultBasis: modal.querySelector('#er_def_basis').value,
              rateBasis: modal.querySelector('#er_rate_basis').value,
              rateCents: Math.round(Number(modal.querySelector('#er_dry').value) * 100),
              dryRateCents: Math.round(Number(modal.querySelector('#er_dry').value) * 100),
              wetRateCents: Math.round(Number(modal.querySelector('#er_wet').value) * 100),
              fullyWetRateCents: Math.round(Number(modal.querySelector('#er_fw').value) * 100),
              econDisplay: modal.querySelector('#er_econ').value,
              typDisplay: modal.querySelector('#er_typ').value,
              heavyDisplay: modal.querySelector('#er_heavy').value,
              fuelConsBasis: r.fuel_cons_basis || (r.display_unit === 'km/L' ? 'km' : 'hr'),
            },
          });
          toast('Rate card and consumption band updated!');
          modal.remove();
          if (onDone) onDone();
        } catch (err) {
          alert(err.message);
        }
      };
    }

    // =========================================================================
    // TAB 3: SITE ALLOCATOR CONSOLE
    // =========================================================================
    async function renderAllocationsTab(box) {
      let projects = [];
      try {
        const pRes = await api('/projects');
        projects = Array.isArray(pRes) ? pRes : (pRes.projects || []);
      } catch (_) {}

      box.innerHTML = `
        <div class="card" style="padding:14px;margin-bottom:14px;background:linear-gradient(90deg, rgba(37,99,235,0.06), rgba(16,185,129,0.05))">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px">📍 Assign / Transfer Machine to Project Site (Updates Active Site &amp; Billing Basis)</div>
          <form id="form_alloc" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div>
              <label style="font-size:11px;font-weight:600">Vehicle Code *</label>
              <input type="text" id="al_code" required class="input sm" placeholder="e.g. LB-22" style="width:120px">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Project / Site *</label>
              <select id="al_proj" required class="input sm" style="min-width:210px">
                <option value="">-- Select Site --</option>
                ${projects.map((p) => `<option value="${p.id}">${esc(p.code ? p.code + ' · ' + p.name : p.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Billing Basis</label>
              <select id="al_basis" class="input sm">
                <option value="DRY">DRY (Client Fuel)</option>
                <option value="WET">WET (Fuel Recharged)</option>
                <option value="FUEL_ONLY">FUEL_ONLY</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Month</label>
              <input type="month" id="al_month" class="input sm" value="2026-08">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Driver / Operator</label>
              <input type="text" id="al_driver" class="input sm" placeholder="Operator" style="width:130px">
            </div>
            <button type="submit" class="btn sm primary">📍 Allocate Machine</button>
          </form>
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:12.5px">
            <thead>
              <tr>
                <th style="padding:10px 12px">Month</th>
                <th style="padding:10px 12px">Vehicle</th>
                <th style="padding:10px 12px">Category</th>
                <th style="padding:10px 12px">Assigned Site / Project</th>
                <th style="padding:10px 12px">Billing Basis</th>
                <th style="padding:10px 12px">Driver / Notes</th>
              </tr>
            </thead>
            <tbody id="alloc_tbody">
              <tr><td colspan="6" class="muted" style="padding:20px;text-align:center">Loading allocations...</td></tr>
            </tbody>
          </table>
        </div>
      `;

      async function loadAllocs() {
        const tbody = qs('#alloc_tbody', box);
        try {
          const { allocations } = await api('/hire/allocations');
          if (!allocations || !allocations.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="muted" style="padding:20px;text-align:center">No site allocations found.</td></tr>';
            return;
          }
          tbody.innerHTML = allocations.slice(0, 200).map((a) => `
            <tr>
              <td style="padding:9px 12px">${esc(a.month || '—')}</td>
              <td style="padding:9px 12px"><a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(a.vehicle_no)}" style="font-weight:700">${esc(a.vehicle_no)}</a></td>
              <td style="padding:9px 12px">${esc(a.asset_type || a.vehicle_type || '—')}</td>
              <td style="padding:9px 12px"><b>${esc(a.project_name || a.site_name || '—')}</b></td>
              <td style="padding:9px 12px"><span class="badge">${esc(a.assigned_basis || 'DRY')}</span></td>
              <td style="padding:9px 12px" class="muted">${esc(a.driver_name || a.notes || '—')}</td>
            </tr>
          `).join('');
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="6" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#form_alloc', box).onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/hire/allocations', {
            method: 'POST',
            body: {
              assetCode: qs('#al_code', box).value.trim(),
              projectId: Number(qs('#al_proj', box).value),
              assignedBasis: qs('#al_basis', box).value,
              month: qs('#al_month', box).value,
              driverName: qs('#al_driver', box).value.trim(),
            },
          });
          toast('Machine allocated to project site!');
          loadAllocs();
        } catch (err) {
          alert(err.message);
        }
      };

      loadAllocs();
    }

    // =========================================================================
    // TAB 4: BREAKDOWN DAYS LOG
    // =========================================================================
    async function renderBreakdownsTab(box) {
      box.innerHTML = `
        <div class="card" style="padding:14px;margin-bottom:14px">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px">🛠️ Log Machine Breakdown Period (Deducts from Monthly Hire Bill)</div>
          <form id="form_bd" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div>
              <label style="font-size:11px;font-weight:600">Vehicle Code *</label>
              <input type="text" id="bd_code" required class="input sm" placeholder="e.g. LB-22" style="width:120px">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Start Date *</label>
              <input type="date" id="bd_start" required class="input sm" value="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">End Date</label>
              <input type="date" id="bd_end" class="input sm" value="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Total Days</label>
              <input type="number" step="0.5" id="bd_days" class="input sm" value="1" style="width:80px">
            </div>
            <div style="flex:1;min-width:180px">
              <label style="font-size:11px;font-weight:600">Breakdown Reason</label>
              <input type="text" id="bd_reason" class="input sm" placeholder="Hydraulic pump / engine repair" style="width:100%">
            </div>
            <button type="submit" class="btn sm primary">Record Breakdown</button>
          </form>
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:12.5px">
            <thead>
              <tr>
                <th style="padding:10px 12px">Start Date</th>
                <th style="padding:10px 12px">End Date</th>
                <th style="padding:10px 12px">Vehicle</th>
                <th style="padding:10px 12px">Category</th>
                <th style="padding:10px 12px;text-align:right">Days Down</th>
                <th style="padding:10px 12px">Reason / Defect</th>
                <th style="padding:10px 12px">Site</th>
              </tr>
            </thead>
            <tbody id="bd_tbody">
              <tr><td colspan="7" class="muted" style="padding:20px;text-align:center">Loading breakdown logs...</td></tr>
            </tbody>
          </table>
        </div>
      `;

      async function loadBds() {
        const tbody = qs('#bd_tbody', box);
        try {
          const { breakdowns } = await api('/hire/breakdowns');
          if (!breakdowns || !breakdowns.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="muted" style="padding:20px;text-align:center">No breakdowns logged.</td></tr>';
            return;
          }
          tbody.innerHTML = breakdowns.slice(0, 150).map((b) => `
            <tr>
              <td style="padding:9px 12px">${esc(String(b.breakdown_start || '').slice(0, 10))}</td>
              <td style="padding:9px 12px">${esc(String(b.breakdown_end || b.breakdown_start || '').slice(0, 10))}</td>
              <td style="padding:9px 12px"><b>${esc(b.vehicle_code)}</b></td>
              <td style="padding:9px 12px">${esc(b.category || '—')}</td>
              <td style="padding:9px 12px;text-align:right;font-weight:700;color:#dc2626">${b.total_days || 1} d</td>
              <td style="padding:9px 12px">${esc(b.reason || b.notes || 'Breakdown')}</td>
              <td style="padding:9px 12px">${esc(b.project_name || '—')}</td>
            </tr>
          `).join('');
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="7" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#form_bd', box).onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/hire/breakdowns', {
            method: 'POST',
            body: {
              assetCode: qs('#bd_code', box).value.trim(),
              breakdownStart: qs('#bd_start', box).value,
              breakdownEnd: qs('#bd_end', box).value,
              totalDays: Number(qs('#bd_days', box).value),
              reason: qs('#bd_reason', box).value.trim(),
            },
          });
          toast('Breakdown logged!');
          loadBds();
        } catch (err) {
          alert(err.message);
        }
      };

      loadBds();
    }

    // =========================================================================
    // TAB 5: PAYMENTS & RECEIVABLES AGING
    // =========================================================================
    async function renderAgingTab(box) {
      box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Receivables Aging Report...</div>`;
      try {
        const { buckets, items } = await api('/hire/aging');
        box.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:10px;margin-bottom:14px">
            <div class="card" style="padding:12px;border-left:4px solid #10b981">
              <div class="muted" style="font-size:11px;font-weight:700">0–30 DAYS CURRENT</div>
              <div style="font-size:20px;font-weight:800;margin-top:4px">${fmtCents(buckets.b0_30.balance_cents)}</div>
              <div class="muted" style="font-size:11px">${buckets.b0_30.count} invoices</div>
            </div>
            <div class="card" style="padding:12px;border-left:4px solid #3b82f6">
              <div class="muted" style="font-size:11px;font-weight:700">31–60 DAYS</div>
              <div style="font-size:20px;font-weight:800;margin-top:4px">${fmtCents(buckets.b31_60.balance_cents)}</div>
              <div class="muted" style="font-size:11px">${buckets.b31_60.count} invoices</div>
            </div>
            <div class="card" style="padding:12px;border-left:4px solid #f59e0b">
              <div class="muted" style="font-size:11px;font-weight:700">61–90 DAYS</div>
              <div style="font-size:20px;font-weight:800;margin-top:4px">${fmtCents(buckets.b61_90.balance_cents)}</div>
              <div class="muted" style="font-size:11px">${buckets.b61_90.count} invoices</div>
            </div>
            <div class="card" style="padding:12px;border-left:4px solid #dc2626">
              <div class="muted" style="font-size:11px;font-weight:700">90+ DAYS OVERDUE</div>
              <div style="font-size:20px;font-weight:800;margin-top:4px;color:#dc2626">${fmtCents(buckets.b90_plus.balance_cents)}</div>
              <div class="muted" style="font-size:11px">${buckets.b90_plus.count} invoices</div>
            </div>
          </div>

          <div class="card" style="padding:0;overflow-x:auto">
            <table class="table" style="width:100%;margin:0;font-size:12.5px">
              <thead>
                <tr>
                  <th style="padding:10px 12px">Invoice #</th>
                  <th style="padding:10px 12px">Period</th>
                  <th style="padding:10px 12px">Vehicle</th>
                  <th style="padding:10px 12px">Project / Site</th>
                  <th style="padding:10px 12px;text-align:right">Grand Total</th>
                  <th style="padding:10px 12px;text-align:right">Paid</th>
                  <th style="padding:10px 12px;text-align:right">Balance Due</th>
                  <th style="padding:10px 12px">Aging Bucket</th>
                  <th style="padding:10px 12px;text-align:center">Action</th>
                </tr>
              </thead>
              <tbody>
                ${(items || []).map((i) => `
                  <tr>
                    <td style="padding:9px 12px;font-family:monospace;font-weight:700">${esc(i.invoice_number || i.id.slice(0, 10))}</td>
                    <td style="padding:9px 12px">${esc(i.period_key)}</td>
                    <td style="padding:9px 12px"><b>${esc(i.asset_code)}</b></td>
                    <td style="padding:9px 12px">${esc(i.project_name || 'Central')}</td>
                    <td style="padding:9px 12px;text-align:right">${fmtCents(i.grand_total_cents)}</td>
                    <td style="padding:9px 12px;text-align:right;color:#059669">${fmtCents(i.paid_cents)}</td>
                    <td style="padding:9px 12px;text-align:right;font-weight:800;color:${i.balance_cents > 0 ? '#dc2626' : '#059669'}">${fmtCents(i.balance_cents)}</td>
                    <td style="padding:9px 12px"><span class="badge ${i.aging_bucket === '90+' ? 'danger' : (i.aging_bucket === 'PAID' ? 'ok' : 'warn')}">${esc(i.aging_bucket)} (${i.age_days}d)</span></td>
                    <td style="padding:9px 12px;text-align:center">
                      <button class="btn sm primary btn-age-pay" data-id="${esc(i.id)}">💰 Pay / View</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;

        qsa('.btn-age-pay', box).forEach((b) => {
          b.onclick = () => openBillDetailModal(b.getAttribute('data-id'), () => renderAgingTab(box));
        });
      } catch (err) {
        box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
      }
    }

    switchTab(activeTab);
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['hire-billing'] = renderHireBilling;
    window.routes['hire'] = renderHireBilling;
  }
})();
