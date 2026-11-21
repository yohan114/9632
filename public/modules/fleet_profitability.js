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
    const yearOpts = [curYear + 1, curYear, curYear - 1, curYear - 2];
    const canSeal = (typeof isAdmin === 'function' && isAdmin()) || (typeof canDo === 'function' && canDo('finance.period.close'));
    const notifyMsg = (msg, type) => {
      if (typeof toast === 'function') toast(msg, type);
      else console[type === 'err' ? 'error' : 'log'](msg);
    };

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / Fleet Financial Reports / Profitability</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <h1 style="margin:0;font-size:24px;font-weight:700">Vehicle Profitability &amp; Cost Efficiency</h1>
            <span id="pl_sealed_badge" class="badge secondary">Open Period</span>
          </div>
          <p class="muted" style="margin:4px 0 0 0">Audited operating contribution, diesel burn, workshop maintenance, tyres/batteries, C.COM &amp; driver costs</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="btn_export_pl_csv">📥 Export P&amp;L Excel</button>
          ${canSeal ? '<button class="btn primary" id="btn_seal_period">🔒 Seal Period</button>' : ''}
        </div>
      </div>

      <!-- Filter & Period Bar -->
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <label style="font-size:12px;font-weight:600">Accounting Period:</label>
        <select id="pl_filter_year" class="input sm">
          ${yearOpts.map((y) => `<option value="${y}" ${y === curYear ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
        <select id="pl_filter_month" class="input sm">
          ${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === curMonth ? 'selected' : ''}>${new Date(curYear, i).toLocaleString('en', { month: 'long' })}</option>`).join('')}
        </select>
        <input type="text" id="pl_filter_search" placeholder="Filter vehicle code..." class="input sm" style="width:160px">
        <label style="font-size:12px;display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none">
          <input type="checkbox" id="pl_filter_active_only">
          <span>Active only (non-zero)</span>
        </label>
        <button class="btn sm primary" id="btn_load_pl">Compute P&amp;L</button>
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
          <div class="muted" style="font-size:12px;font-weight:600">WORKSHOP, T&amp;B &amp; C.COM</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px;color:#ef4444" id="pl_summary_maint">Rs ...</div>
          <div class="muted" style="font-size:11px" id="pl_summary_maint_sub">Labour, Parts, Oil, T&amp;B &amp; Driver</div>
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
                <th style="padding:10px 14px">Type &amp; Ownership</th>
                <th style="padding:10px 14px">Assigned Site</th>
                <th style="padding:10px 14px;text-align:right">Gross Revenue</th>
                <th style="padding:10px 14px;text-align:right">Diesel Cost</th>
                <th style="padding:10px 14px;text-align:right">Workshop &amp; C.COM</th>
                <th style="padding:10px 14px;text-align:right">Tyre &amp; Battery</th>
                <th style="padding:10px 14px;text-align:right">Driver / Other</th>
                <th style="padding:10px 14px;text-align:right">Total Direct Costs</th>
                <th style="padding:10px 14px;text-align:right">Operating Contribution</th>
                <th style="padding:10px 14px;text-align:center">Margin</th>
              </tr>
            </thead>
            <tbody id="pl_tbody">
              <tr><td colspan="11" style="padding:24px;text-align:center" class="muted">Loading vehicle profitability report...</td></tr>
            </tbody>
          </table>
        </div>
        <div id="pl_pager" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-top:1px solid var(--border);font-size:12px;flex-wrap:wrap;gap:8px"></div>
      </div>
    `;

    let allRows = [];
    let currentPage = 1;
    let showAll = false;
    const pageSize = 100;

    function renderRows() {
      const tbody = qs('#pl_tbody');
      const pager = qs('#pl_pager');
      const activeOnly = Boolean(qs('#pl_filter_active_only')?.checked);
      const filtered = activeOnly
        ? allRows.filter((r) => Number(r.grossRevenueCents || 0) > 0 || Number(r.totalDirectCostCents || 0) > 0)
        : allRows;

      if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="11" style="padding:24px;text-align:center" class="muted">No matching vehicle records found.</td></tr>';
        if (pager) pager.innerHTML = `<span class="muted">0 of ${allRows.length.toLocaleString()} vehicle(s)</span>`;
        return;
      }

      const totalPages = showAll ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
      if (currentPage > totalPages) currentPage = totalPages;
      const startIdx = showAll ? 0 : (currentPage - 1) * pageSize;
      const pageRows = showAll ? filtered : filtered.slice(startIdx, startIdx + pageSize);

      tbody.innerHTML = pageRows.map((r) => {
        const contrib = Number(r.operatingContributionCents) / 100;
        const isProfitable = contrib >= 0;
        const contribColor = isProfitable ? '#10b981' : '#ef4444';
        const coreMaintCents = Number(r.maintenanceLabourCents || 0) + Number(r.maintenancePartsCents || 0) + Number(r.maintenanceOilCents || 0) + Number(r.ccomOutsourceCents || 0);

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
            <td style="padding:10px 14px;text-align:right;font-weight:700">Rs ${(r.grossRevenueCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td style="padding:10px 14px;text-align:right">Rs ${(r.fuelCostCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td style="padding:10px 14px;text-align:right" title="Workshop + C.COM Outsourcing">Rs ${(coreMaintCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td style="padding:10px 14px;text-align:right">Rs ${(Number(r.tyreBatteryCostCents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td style="padding:10px 14px;text-align:right">Rs ${(Number(r.driverOtherCostCents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td style="padding:10px 14px;text-align:right;font-weight:600">Rs ${(r.totalDirectCostCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td style="padding:10px 14px;text-align:right;font-weight:800;color:${contribColor}">Rs ${contrib.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td style="padding:10px 14px;text-align:center">
              <span class="badge ${isProfitable ? 'success' : 'danger'}">${esc(r.marginPct)}%</span>
            </td>
          </tr>
        `;
      }).join('');

      if (pager) {
        const showingEnd = startIdx + pageRows.length;
        pager.innerHTML = `
          <div class="muted">
            Showing <b>${(startIdx + 1).toLocaleString()}–${showingEnd.toLocaleString()}</b> of <b>${filtered.length.toLocaleString()}</b> vehicle(s)
            ${activeOnly ? ` (filtered from ${allRows.length.toLocaleString()})` : ''}
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <button type="button" class="btn sm" id="btn_pl_prev" ${showAll || currentPage <= 1 ? 'disabled' : ''}>◀ Prev</button>
            <span class="muted">Page <b>${currentPage}</b> of <b>${totalPages}</b></span>
            <button type="button" class="btn sm" id="btn_pl_next" ${showAll || currentPage >= totalPages ? 'disabled' : ''}>Next ▶</button>
            <button type="button" class="btn sm" id="btn_pl_toggle_all">${showAll ? `Paginate (${pageSize})` : 'Show All'}</button>
          </div>
        `;
        const prevBtn = qs('#btn_pl_prev');
        if (prevBtn) prevBtn.onclick = () => { if (currentPage > 1) { currentPage--; renderRows(); } };
        const nextBtn = qs('#btn_pl_next');
        if (nextBtn) nextBtn.onclick = () => { if (currentPage < totalPages) { currentPage++; renderRows(); } };
        const toggleBtn = qs('#btn_pl_toggle_all');
        if (toggleBtn) toggleBtn.onclick = () => { showAll = !showAll; currentPage = 1; renderRows(); };
      }
    }

    function currentParams() {
      const year = qs('#pl_filter_year').value;
      const month = qs('#pl_filter_month').value;
      const search = qs('#pl_filter_search').value.trim();
      const params = new URLSearchParams({ year, month });
      if (search) params.set('assetCode', search);
      return { year, month, search, params };
    }

    async function loadReport() {
      const { params } = currentParams();
      const tbody = qs('#pl_tbody');
      tbody.innerHTML = '<tr><td colspan="11" style="padding:24px;text-align:center" class="muted">Calculating reconciled P&amp;L facts...</td></tr>';

      try {
        const res = await api(`/fleet/finance/vehicle-profitability?${params.toString()}`);

        const sealedBadge = qs('#pl_sealed_badge');
        if (sealedBadge) {
          if (res.sealedCount > 0) {
            sealedBadge.className = 'badge green';
            sealedBadge.textContent = `🔒 Sealed (${res.sealedCount} assets${res.lastSealedAt ? ' · ' + String(res.lastSealedAt).slice(0, 10) : ''})`;
          } else {
            sealedBadge.className = 'badge secondary';
            sealedBadge.textContent = 'Open Period';
          }
        }

        const s = res.summary || {};
        qs('#pl_summary_rev').textContent = `Rs ${(Number(s.totalGrossRevenueCents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        qs('#pl_summary_fuel').textContent = `Rs ${(Number(s.totalFuelCostCents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        qs('#pl_summary_litres').textContent = `${Number(s.totalDieselLitres || 0).toLocaleString()} Litres issued`;
        qs('#pl_summary_maint').textContent = `Rs ${(Number(s.totalMaintenanceCents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        const maintSub = qs('#pl_summary_maint_sub');
        if (maintSub) {
          const tbRs = (Number(s.totalTyreBatteryCents || 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
          const drvRs = (Number(s.totalDriverOtherCents || 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
          maintSub.textContent = `Incl. T&B Rs ${tbRs} · Driver/Other Rs ${drvRs}`;
        }
        qs('#pl_summary_contrib').textContent = `Rs ${(Number(s.totalOperatingContributionCents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

        const overallMargin = Number(s.totalGrossRevenueCents || 0) > 0
          ? ((Number(s.totalOperatingContributionCents || 0) / Number(s.totalGrossRevenueCents)) * 100).toFixed(1)
          : '0.0';
        qs('#pl_summary_margin').textContent = `Overall Margin: ${overallMargin}%`;

        allRows = res.report || [];
        currentPage = 1;
        renderRows();
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="11" style="padding:24px;text-align:center" class="err">Error calculating profitability: ${esc(err.message)}</td></tr>`;
        const pager = qs('#pl_pager');
        if (pager) pager.innerHTML = '';
      }
    }

    const expBtn = qs('#btn_export_pl_csv');
    if (expBtn) {
      expBtn.onclick = () => {
        const { params } = currentParams();
        window.location.href = `/api/fleet/finance/vehicle-profitability.xlsx?${params.toString()}`;
      };
    }

    const sealBtn = qs('#btn_seal_period');
    if (sealBtn) {
      sealBtn.onclick = async () => {
        const { year, month } = currentParams();
        const periodKey = `${year}-${String(month).padStart(2, '0')}`;
        if (!confirm(`Seal Fleet P&L snapshots for ${periodKey}? This freezes monthly financial metrics into fleet_monthly_snapshots.`)) return;
        sealBtn.disabled = true;
        const origText = sealBtn.textContent;
        sealBtn.textContent = 'Sealing...';
        try {
          const res = await api('/fleet/finance/seal-period', {
            method: 'POST',
            body: { year: Number(year), month: Number(month) },
          });
          notifyMsg(`Sealed ${res.sealedCount || 0} asset snapshots for ${periodKey}`);
          await loadReport();
        } catch (err) {
          notifyMsg(err.message || 'Failed to seal period', 'err');
        } finally {
          sealBtn.disabled = false;
          sealBtn.textContent = origText;
        }
      };
    }

    qs('#btn_load_pl').onclick = loadReport;
    qs('#pl_filter_active_only').onchange = () => { currentPage = 1; renderRows(); };
    qs('#pl_filter_search').onkeydown = (e) => { if (e.key === 'Enter') loadReport(); };
    loadReport();
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fleet-profitability'] = renderFleetProfitability;
  }
})();
