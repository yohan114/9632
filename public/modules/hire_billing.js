'use strict';

/**
 * Native WorkshopOne Machine Hire & Rental Billing Module (Plan V2)
 *
 * Provides:
 * - Authoritative rental bills register with SSCL 2.5% and VAT 18% calculation
 * - Dynamic bill generation modal with live calculation preview
 * - Bill finalisation and revision snapshots
 * - Machine hire rate cards & site allocation registers
 */

(function () {
  async function renderHireBilling(content) {
    const curYear = new Date().getFullYear();
    const curMonth = new Date().getMonth() + 1;

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / Machine Hire & Rental Billing</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Machine Hire & Billing</h1>
          <p class="muted" style="margin:4px 0 0 0">Equipment rental tariffs, dry/wet fuel recovery, and client invoice generation</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="btn_generate_bill">⚡ Generate Bill</button>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <div class="tabs" style="display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border)">
        <button class="tab active" id="tab_bills" style="padding:8px 16px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2px solid var(--primary,#0066ff)">📑 Rental Bills</button>
        <button class="tab" id="tab_rates" style="padding:8px 16px;font-weight:600;border:none;background:none;cursor:pointer;color:var(--muted)">🏷️ Rate Cards</button>
        <button class="tab" id="tab_allocations" style="padding:8px 16px;font-weight:600;border:none;background:none;cursor:pointer;color:var(--muted)">📍 Machine Deployments</button>
      </div>

      <!-- Tab Content Area -->
      <div id="hire_tab_content"></div>
    `;

    // -------------------------------------------------------------------------
    // Tab 1: Rental Bills View
    // -------------------------------------------------------------------------
    function showBillsTab() {
      const container = qs('#hire_tab_content');
      container.innerHTML = `
        <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input type="text" id="bill_filter_search" placeholder="Search invoice, vehicle, site..." style="flex:1;min-width:180px" class="input sm">
          <select id="bill_filter_year" class="input sm">
            <option value="2026" ${curYear === 2026 ? 'selected' : ''}>2026</option>
            <option value="2025" ${curYear === 2025 ? 'selected' : ''}>2025</option>
          </select>
          <select id="bill_filter_month" class="input sm">
            <option value="">All Months</option>
            ${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === curMonth ? 'selected' : ''}>${new Date(2026, i).toLocaleString('en', { month: 'long' })}</option>`).join('')}
          </select>
          <select id="bill_filter_status" class="input sm">
            <option value="">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="FINAL">Final</option>
            <option value="ISSUED">Issued</option>
          </select>
          <button class="btn sm" id="btn_apply_bill_filter">Filter</button>
        </div>

        <div class="card" style="padding:0;overflow:hidden">
          <div style="overflow-x:auto">
            <table class="table" style="width:100%;margin:0;font-size:13px">
              <thead>
                <tr style="background:rgba(0,0,0,0.02)">
                  <th style="padding:10px 14px">Period</th>
                  <th style="padding:10px 14px">Invoice #</th>
                  <th style="padding:10px 14px">Vehicle / Machine</th>
                  <th style="padding:10px 14px">Site / Project</th>
                  <th style="padding:10px 14px">Basis</th>
                  <th style="padding:10px 14px;text-align:right">Units</th>
                  <th style="padding:10px 14px;text-align:right">Rental Amt</th>
                  <th style="padding:10px 14px;text-align:right">Fuel Recharge</th>
                  <th style="padding:10px 14px;text-align:right">Grand Total (inc. Tax)</th>
                  <th style="padding:10px 14px;text-align:center">Status</th>
                  <th style="padding:10px 14px;text-align:center">Actions</th>
                </tr>
              </thead>
              <tbody id="bills_tbody">
                <tr><td colspan="11" style="padding:24px;text-align:center" class="muted">Loading bills...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      async function loadBills() {
        const search = qs('#bill_filter_search').value.trim();
        const year = qs('#bill_filter_year').value;
        const month = qs('#bill_filter_month').value;
        const status = qs('#bill_filter_status').value;

        const params = new URLSearchParams({ limit: 100 });
        if (search) params.set('search', search);
        if (year) params.set('year', year);
        if (month) params.set('month', month);
        if (status) params.set('status', status);

        const tbody = qs('#bills_tbody');
        try {
          const res = await api(`/hire/bills?${params.toString()}`);
          if (!res.bills || !res.bills.length) {
            tbody.innerHTML = '<tr><td colspan="11" style="padding:24px;text-align:center" class="muted">No rental bills found for selected period.</td></tr>';
            return;
          }

          tbody.innerHTML = res.bills.map((b) => {
            const isFinal = b.status === 'FINAL' || b.status === 'ISSUED';
            const statusBadge = isFinal ? '<span class="badge success">FINAL</span>' : '<span class="badge warning">DRAFT</span>';
            return `
              <tr>
                <td style="padding:10px 14px;white-space:nowrap">${esc(b.period_key)}</td>
                <td style="padding:10px 14px;font-family:monospace;font-weight:700">${esc(b.invoice_number || 'DRAFT')}</td>
                <td style="padding:10px 14px"><b>${esc(b.asset_code)}</b></td>
                <td style="padding:10px 14px">${esc(b.project_name || 'Central')}</td>
                <td style="padding:10px 14px"><span class="badge secondary">${esc(b.rate_basis || 'DRY')}</span></td>
                <td style="padding:10px 14px;text-align:right">${Number(b.billable_units).toFixed(1)}</td>
                <td style="padding:10px 14px;text-align:right">Rs ${(Number(b.rental_amount_cents) / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td style="padding:10px 14px;text-align:right">Rs ${(Number(b.fuel_cost_cents) / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td style="padding:10px 14px;text-align:right;font-weight:800;color:var(--primary,#0066ff)">Rs ${(Number(b.grand_total_cents) / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td style="padding:10px 14px;text-align:center">${statusBadge}</td>
                <td style="padding:10px 14px;text-align:center;white-space:nowrap">
                  ${!isFinal && canDo('hire.billing.finalise') ? `<button class="btn sm primary btn-finalise-bill" data-id="${esc(b.id)}">Finalise</button>` : ''}
                </td>
              </tr>
            `;
          }).join('');

          // Wire Finalise Buttons
          qsa('.btn-finalise-bill', tbody).forEach((btn) => {
            btn.onclick = async () => {
              const id = btn.getAttribute('data-id');
              if (!confirm('Are you sure you want to FINALISE this bill?\nThis will lock calculation amounts, assign an authoritative Invoice Number, and post revenue facts.')) return;
              try {
                const res = await api(`/hire/bills/${id}/finalise`, { method: 'POST' });
                toast(`Bill finalized with Invoice #${res.invoice_number}`);
                loadBills();
              } catch (err) {
                alert('Error finalizing bill: ' + err.message);
              }
            };
          });

        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="11" style="padding:24px;text-align:center" class="err">Error loading bills: ${esc(err.message)}</td></tr>`;
        }
      }

      qs('#btn_apply_bill_filter').onclick = loadBills;
      loadBills();
    }

    // -------------------------------------------------------------------------
    // Tab 2: Rate Cards View
    // -------------------------------------------------------------------------
    async function showRatesTab() {
      const container = qs('#hire_tab_content');
      container.innerHTML = `
        <div class="card" style="padding:0;overflow:hidden">
          <div style="overflow-x:auto">
            <table class="table" style="width:100%;margin:0;font-size:13px">
              <thead>
                <tr style="background:rgba(0,0,0,0.02)">
                  <th style="padding:10px 14px">Equipment Category / Code</th>
                  <th style="padding:10px 14px">Rate Basis</th>
                  <th style="padding:10px 14px;text-align:right">Dry Rate (Rs/hr)</th>
                  <th style="padding:10px 14px;text-align:right">Wet Rate (Rs/hr)</th>
                  <th style="padding:10px 14px">Contract Terms / Note</th>
                </tr>
              </thead>
              <tbody id="rates_tbody">
                <tr><td colspan="5" style="padding:24px;text-align:center" class="muted">Loading rate cards...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      try {
        const { rates } = await api('/hire/rates');
        const tbody = qs('#rates_tbody');
        if (!rates || !rates.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="padding:24px;text-align:center" class="muted">No rate cards defined.</td></tr>';
          return;
        }

        tbody.innerHTML = rates.map(r => `
          <tr>
            <td style="padding:10px 14px"><b>${esc(r.asset_code || r.category_name || 'All Fleet')}</b></td>
            <td style="padding:10px 14px"><span class="badge secondary">${esc(r.rate_basis)}</span></td>
            <td style="padding:10px 14px;text-align:right">Rs ${(Number(r.dry_rate_cents || r.rate_cents) / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
            <td style="padding:10px 14px;text-align:right">Rs ${(Number(r.wet_rate_cents || 0) / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
            <td style="padding:10px 14px" class="muted">${esc(r.note || '-')}</td>
          </tr>
        `).join('');
      } catch (err) {
        qs('#rates_tbody').innerHTML = `<tr><td colspan="5" style="padding:24px;text-align:center" class="err">Error: ${esc(err.message)}</td></tr>`;
      }
    }

    // -------------------------------------------------------------------------
    // Tab 3: Allocations View
    // -------------------------------------------------------------------------
    async function showAllocationsTab() {
      const container = qs('#hire_tab_content');
      container.innerHTML = `
        <div class="card" style="padding:0;overflow:hidden">
          <div style="overflow-x:auto">
            <table class="table" style="width:100%;margin:0;font-size:13px">
              <thead>
                <tr style="background:rgba(0,0,0,0.02)">
                  <th style="padding:10px 14px">Month</th>
                  <th style="padding:10px 14px">Vehicle No</th>
                  <th style="padding:10px 14px">Assigned Project / Site</th>
                  <th style="padding:10px 14px">Machine Type</th>
                  <th style="padding:10px 14px">Billing Basis</th>
                </tr>
              </thead>
              <tbody id="alloc_tbody">
                <tr><td colspan="5" style="padding:24px;text-align:center" class="muted">Loading machine deployments...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      try {
        const { allocations } = await api('/hire/allocations');
        const tbody = qs('#alloc_tbody');
        if (!allocations || !allocations.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="padding:24px;text-align:center" class="muted">No machine site allocations found.</td></tr>';
          return;
        }

        tbody.innerHTML = allocations.slice(0, 100).map(a => `
          <tr>
            <td style="padding:10px 14px;white-space:nowrap">${esc(a.month)}</td>
            <td style="padding:10px 14px"><b>${esc(a.vehicle_no)}</b></td>
            <td style="padding:10px 14px">${esc(a.project_name || a.site_name)}</td>
            <td style="padding:10px 14px">${esc(a.machine_type || a.asset_type || '-')}</td>
            <td style="padding:10px 14px"><span class="badge secondary">${esc(a.basis || 'DRY')}</span></td>
          </tr>
        `).join('');
      } catch (err) {
        qs('#alloc_tbody').innerHTML = `<tr><td colspan="5" style="padding:24px;text-align:center" class="err">Error: ${esc(err.message)}</td></tr>`;
      }
    }

    // Tab Switching
    function setTab(name) {
      qs('#tab_bills').className = name === 'bills' ? 'tab active' : 'tab';
      qs('#tab_rates').className = name === 'rates' ? 'tab active' : 'tab';
      qs('#tab_allocations').className = name === 'allocations' ? 'tab active' : 'tab';

      qs('#tab_bills').style.borderBottom = name === 'bills' ? '2px solid var(--primary,#0066ff)' : 'none';
      qs('#tab_rates').style.borderBottom = name === 'rates' ? '2px solid var(--primary,#0066ff)' : 'none';
      qs('#tab_allocations').style.borderBottom = name === 'allocations' ? '2px solid var(--primary,#0066ff)' : 'none';

      if (name === 'bills') showBillsTab();
      else if (name === 'rates') showRatesTab();
      else if (name === 'allocations') showAllocationsTab();
    }

    qs('#tab_bills').onclick = () => setTab('bills');
    qs('#tab_rates').onclick = () => setTab('rates');
    qs('#tab_allocations').onclick = () => setTab('allocations');

    // Generate Bill Modal
    qs('#btn_generate_bill').onclick = () => {
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal" style="max-width:540px;padding:24px">
          <h2 style="margin-top:0">⚡ Generate Machine Rental Bill</h2>
          <form id="form_generate_bill" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:600">Vehicle / Machine Code *</label>
              <input type="text" id="gen_asset_code" required class="input" placeholder="e.g. PQ-8773, EX-01" style="width:100%">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Billing Year *</label>
                <input type="number" id="gen_year" class="input" value="${curYear}" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Billing Month *</label>
                <input type="number" id="gen_month" class="input" min="1" max="12" value="${curMonth}" style="width:100%">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Actual Units Worked *</label>
                <input type="number" step="0.1" id="gen_actual_units" required class="input" placeholder="Hours / km / days" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Contract Minimum Guarantee</label>
                <input type="number" step="0.1" id="gen_min_units" class="input" value="0" style="width:100%">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Tariff Rate (Rs per Unit) *</label>
                <input type="number" step="10" id="gen_rate_rs" required class="input" placeholder="e.g. 6000.00" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Billing Mode</label>
                <select id="gen_billing_mode" class="input" style="width:100%">
                  <option value="DRY">Dry (Fuel by Client)</option>
                  <option value="WET">Wet (Fuel Recharged)</option>
                  <option value="FULLY_WET">Fully Wet (Fuel Inclusive)</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Issued Fuel (Litres)</label>
                <input type="number" step="0.1" id="gen_fuel_litres" class="input" value="0" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Breakdown Days</label>
                <input type="number" id="gen_breakdown_days" class="input" value="0" style="width:100%">
              </div>
            </div>

            <!-- Tax Computation Note -->
            <div style="background:rgba(0,102,255,0.06);border:1px solid rgba(0,102,255,0.2);padding:10px;border-radius:8px;font-size:12px">
              ℹ️ Automatically computes <b>SSCL 2.5%</b> and <b>VAT 18%</b> in strict compliance with Sri Lankan Inland Revenue regulations.
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" id="btn_cancel_gen">Cancel</button>
              <button type="submit" class="btn primary" id="btn_submit_gen">Generate Draft Bill</button>
            </div>
          </form>
        </div>
      `;

      document.body.appendChild(modal);
      modal.querySelector('#btn_cancel_gen').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelector('#form_generate_bill').onsubmit = async (e) => {
        e.preventDefault();
        const assetCode = modal.querySelector('#gen_asset_code').value.trim();
        const year = Number(modal.querySelector('#gen_year').value);
        const month = Number(modal.querySelector('#gen_month').value);
        const actualUnits = Number(modal.querySelector('#gen_actual_units').value);
        const minBillHours = Number(modal.querySelector('#gen_min_units').value) || 0;
        const rateRs = Number(modal.querySelector('#gen_rate_rs').value);
        const rateCents = Math.round(rateRs * 100);
        const billingMode = modal.querySelector('#gen_billing_mode').value;
        const fuelLitres = Number(modal.querySelector('#gen_fuel_litres').value) || 0;
        const breakdownDays = Number(modal.querySelector('#gen_breakdown_days').value) || 0;

        const subBtn = modal.querySelector('#btn_submit_gen');
        subBtn.disabled = true;
        subBtn.textContent = 'Generating...';

        try {
          const res = await api('/hire/bills/generate', {
            method: 'POST',
            body: {
              assetCode, year, month, actualUnits, minBillHours, rateCents,
              billingMode, fuelLitres, breakdownDays
            }
          });
          toast(`Draft bill generated! Grand Total: Rs ${(res.calculation.grandTotalCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}`);
          modal.remove();
          setTab('bills');
        } catch (err) {
          alert('Error generating bill: ' + err.message);
          subBtn.disabled = false;
          subBtn.textContent = 'Generate Draft Bill';
        }
      };
    };

    setTab('bills');
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['hire-billing'] = renderHireBilling;
  }
})();
