'use strict';

/**
 * Native WorkshopOne Fleet Profitability & P&L Module (Plan V2)
 *
 * Implements Plan V2 §14:
 * Operating Contribution = Gross Revenue - (Diesel Cost + Maintenance + Driver + Hired-in)
 * Full-Cost Result = Operating Contribution - Allocated Overhead
 */

(function () {
  async function renderFleetProfitability(content) {
    const curYear = new Date().getFullYear();
    const curMonth = new Date().getMonth() + 1;

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / Fleet Financial Reports / Profitability</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Vehicle Profitability & Cost Efficiency</h1>
          <p class="muted" style="margin:4px 0 0 0">Audited operating contribution, diesel burn, and workshop maintenance cost recovery</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="btn_export_pl_csv">📥 Export P&L Excel</button>
        </div>
      </div>

      <!-- Filter & Period Bar -->
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <label style="font-size:12px;font-weight:600">Accounting Period:</label>
        <select id="pl_filter_year" class="input sm">
          <option value="2026" ${curYear === 2026 ? 'selected' : ''}>2026</option>
          <option value="2025" ${curYear === 2025 ? 'selected' : ''}>2025</option>
        </select>
        <select id="pl_filter_month" class="input sm">
          ${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === curMonth ? 'selected' : ''}>${new Date(2026, i).toLocaleString('en', { month: 'long' })}</option>`).join('')}
        </select>
        <input type="text" id="pl_filter_search" placeholder="Filter vehicle code..." class="input sm" style="width:160px">
        <button class="btn sm primary" id="btn_load_pl">Compute P&L</button>
      </div>

      <!-- Financial Summary KPI Cards -->
      <div class="kpi-grid" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;margin-bottom:16px">
        <div class="card" style="padding:14px">
          <div class="muted" style="font-size:12px;font-weight:600">FLEET GROSS REVENUE</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px;color:var(--primary,#0066ff)" id="pl_summary_rev">Rs ...</div>
          <div class="muted" style="font-size:11px">Rental + Fuel Recharge</div>
        </div>
        <div class="card" style="padding:14px">
          <div class="muted" style="font-size:12px;font-weight:600">DIRECT DIESEL COST</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px;color:#f59e0b" id="pl_summary_fuel">Rs ...</div>
          <div class="muted" style="font-size:11px" id="pl_summary_litres">... Litres issued</div>
        </div>
        <div class="card" style="padding:14px">
          <div class="muted" style="font-size:12px;font-weight:600">WORKSHOP MAINTENANCE</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px;color:#ef4444" id="pl_summary_maint">Rs ...</div>
          <div class="muted" style="font-size:11px">Labour, Parts & C.COM</div>
        </div>
        <div class="card" style="padding:14px">
          <div class="muted" style="font-size:12px;font-weight:600">NET CONTRIBUTION</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px;color:#10b981" id="pl_summary_contrib">Rs ...</div>
          <div class="muted" style="font-size:11px" id="pl_summary_margin">Margin: ...%</div>
        </div>
      </div>

      <!-- Profitability Table -->
      <div class="card" style="padding:0;overflow:hidden">
        <div style="overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:13px">
            <thead>
              <tr style="background:rgba(0,0,0,0.02)">
                <th style="padding:10px 14px">Vehicle Code</th>
                <th style="padding:10px 14px">Type & Ownership</th>
                <th style="padding:10px 14px">Assigned Site</th>
                <th style="padding:10px 14px;text-align:right">Gross Revenue</th>
                <th style="padding:10px 14px;text-align:right">Diesel Cost</th>
                <th style="padding:10px 14px;text-align:right">Maintenance Cost</th>
                <th style="padding:10px 14px;text-align:right">Total Direct Costs</th>
                <th style="padding:10px 14px;text-align:right">Operating Contribution</th>
                <th style="padding:10px 14px;text-align:center">Margin</th>
              </tr>
            </thead>
            <tbody id="pl_tbody">
              <tr><td colspan="9" style="padding:24px;text-align:center" class="muted">Loading vehicle profitability report...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    async function loadReport() {
      const year = qs('#pl_filter_year').value;
      const month = qs('#pl_filter_month').value;
      const search = qs('#pl_filter_search').value.trim();

      const params = new URLSearchParams({ year, month });
      if (search) params.set('assetCode', search);

      const tbody = qs('#pl_tbody');
      tbody.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center" class="muted">Calculating reconciled P&L facts...</td></tr>';

      try {
        const res = await api(`/fleet/finance/vehicle-profitability?${params.toString()}`);
        if (!res.report || !res.report.length) {
          tbody.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center" class="muted">No vehicle records found.</td></tr>';
          return;
        }

        // Update Summary Cards
        const s = res.summary;
        qs('#pl_summary_rev').textContent = `Rs ${(s.totalGrossRevenueCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        qs('#pl_summary_fuel').textContent = `Rs ${(s.totalFuelCostCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        qs('#pl_summary_litres').textContent = `${Number(s.totalDieselLitres).toLocaleString()} Litres issued`;
        qs('#pl_summary_maint').textContent = `Rs ${(s.totalMaintenanceCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        qs('#pl_summary_contrib').textContent = `Rs ${(s.totalOperatingContributionCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}`;

        const overallMargin = s.totalGrossRevenueCents > 0
          ? ((s.totalOperatingContributionCents / s.totalGrossRevenueCents) * 100).toFixed(1)
          : '0.0';
        qs('#pl_summary_margin').textContent = `Overall Margin: ${overallMargin}%`;

        tbody.innerHTML = res.report.map((r) => {
          const contrib = Number(r.operatingContributionCents) / 100;
          const isProfitable = contrib >= 0;
          const contribColor = isProfitable ? '#10b981' : '#ef4444';

          return `
            <tr>
              <td style="padding:10px 14px">
                <b>${esc(r.assetCode)}</b>
                ${r.registration && r.registration !== r.assetCode ? `<br><span class="muted" style="font-size:11px">${esc(r.registration)}</span>` : ''}
              </td>
              <td style="padding:10px 14px">
                ${esc(r.assetType || 'Machine')}
                <br><span class="badge ${r.ownership === 'HIRED' ? 'warning' : 'secondary'}">${esc(r.ownership || 'OWNED')}</span>
              </td>
              <td style="padding:10px 14px">${esc(r.projectName)}</td>
              <td style="padding:10px 14px;text-align:right;font-weight:700">Rs ${(r.grossRevenueCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
              <td style="padding:10px 14px;text-align:right">Rs ${(r.fuelCostCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
              <td style="padding:10px 14px;text-align:right">Rs ${(r.totalMaintenanceCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
              <td style="padding:10px 14px;text-align:right;font-weight:600">Rs ${(r.totalDirectCostCents / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
              <td style="padding:10px 14px;text-align:right;font-weight:800;color:${contribColor}">Rs ${contrib.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
              <td style="padding:10px 14px;text-align:center">
                <span class="badge ${isProfitable ? 'success' : 'danger'}">${esc(r.marginPct)}%</span>
              </td>
            </tr>
          `;
        }).join('');

      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="9" style="padding:24px;text-align:center" class="err">Error calculating profitability: ${esc(err.message)}</td></tr>`;
      }
    }

    qs('#btn_load_pl').onclick = loadReport;
    qs('#pl_filter_search').onkeydown = (e) => { if (e.key === 'Enter') loadReport(); };
    loadReport();
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fleet-profitability'] = renderFleetProfitability;
  }
})();
