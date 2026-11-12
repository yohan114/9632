'use strict';
/* =============================================================================
 * WorkshopOne - Master Administrator Fleet Costing & Profitability Dashboard
 * Fleet-wide consolidated metrics and per-vehicle profit / loss analysis
 * ============================================================================= */

(function () {
  const routes = window.routes = window.routes || {};

  routes.masterdashboard = async function (c) {
    if (!isAdmin() && !canView('costing')) {
      c.innerHTML = `
        <div class="card err" style="margin-top:20px">
          <h2>Access Restricted</h2>
          <p class="muted">The Master Administrator Dashboard is restricted to System Administrators and Costing Executives.</p>
          <a class="btn sm" href="#/dashboard">← Return to Main Dashboard</a>
        </div>`;
      return;
    }

    const sp = new URLSearchParams(location.hash.split('?')[1] || '');
    const nowMonth = new Date().toISOString().slice(0, 7);
    const initialMonth = sp.get('month') || nowMonth;

    c.innerHTML = `
      <div class="no-print">
        ${pageHeader('Master Fleet Costing & Profitability Dashboard', 'Fleet-wide executive audit: Revenue, Repairs, Diesel, and Net Profit Margin')}
        <div class="card" style="margin-bottom:16px">
          <div style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap">
            <div style="width:170px">
              <label>Reporting Month</label>
              <input type="month" id="master-month-input" value="${esc(initialMonth)}">
            </div>
            <div style="width:180px">
              <label>Filter Category</label>
              <select id="master-cat-select">
                <option value="">— All Categories —</option>
                <option value="DT">Dump Trucks (DT)</option>
                <option value="EX">Excavators (EX)</option>
                <option value="BL">Backhoe Loaders (BL)</option>
                <option value="WA">Water Bowsers (WA)</option>
                <option value="RO">Rollers & Compactors (RO)</option>
                <option value="CR">Cranes (CR)</option>
                <option value="TR">Tractors (TR)</option>
              </select>
            </div>
            <div style="flex:1;min-width:200px">
              <label>Search Vehicle</label>
              <input type="text" id="master-search-input" placeholder="Search machine code, reg, brand…">
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn primary" id="btn-master-refresh">🔄 Refresh</button>
              <button class="btn" id="btn-master-print">🖨️ Print Summary</button>
            </div>
            <div class="spacer"></div>
            <div style="display:flex;gap:8px">
              ${canAdd('costing') ? '<button class="btn sm" id="btn-master-add-rev">➕ Log Revenue</button>' : ''}
              ${canAdd('costing') ? '<button class="btn sm" id="btn-master-add-cost">➕ Log Driver Cost</button>' : ''}
              ${canAdd('fuel') ? '<button class="btn sm" id="btn-master-dispense">⛽ Dispense Fuel</button>' : ''}
            </div>
          </div>
        </div>
      </div>
      <div id="master-summary-pane"><div class="muted">Loading fleet costing data…</div></div>
    `;

    const inMonth = qs('#master-month-input', c);
    const selCat = qs('#master-cat-select', c);
    const inSearch = qs('#master-search-input', c);
    const btnRef = qs('#btn-master-refresh', c);
    const btnPrint = qs('#btn-master-print', c);
    const btnRev = qs('#btn-master-add-rev', c);
    const btnCost = qs('#btn-master-add-cost', c);
    const btnFuel = qs('#btn-master-dispense', c);

    const loadData = async () => {
      const m = inMonth.value || nowMonth;
      history.replaceState(null, '', `#/masterdashboard?month=${m}`);
      await renderMasterFleetView(m, selCat.value, inSearch.value, qs('#master-summary-pane', c));
    };

    btnRef.onclick = loadData;
    inMonth.onchange = loadData;
    selCat.onchange = loadData;
    btnPrint.onclick = () => window.print();

    if (inSearch) {
      inSearch.oninput = () => {
        const q = inSearch.value.toLowerCase().trim();
        qsa('tbody tr', c).forEach((tr) => {
          if (tr.classList.contains('summary-total-row')) return;
          tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      };
    }

    if (btnRev && window.openAddRevenueModal) {
      btnRev.onclick = () => window.openAddRevenueModal('', inMonth.value, loadData);
    }
    if (btnCost && window.openAddDriverCostModal) {
      btnCost.onclick = () => window.openAddDriverCostModal('', inMonth.value, loadData);
    }
    if (btnFuel && window.openNewDispenseModal) {
      btnFuel.onclick = () => window.openNewDispenseModal(loadData);
    }

    await loadData();
  };

  async function renderMasterFleetView(month, categoryFilter, searchQuery, container) {
    container.innerHTML = '<div class="muted">Calculating fleet revenue, workshop expenses, diesel & profit margins…</div>';
    try {
      const res = await api(`/vehicle-costing/fleet-summary?month=${month}`);
      const t = res.totals || {};
      let vehicles = res.vehicles || [];

      if (categoryFilter) {
        vehicles = vehicles.filter((v) => (v.category || '').toUpperCase() === categoryFilter.toUpperCase());
      }
      if (searchQuery) {
        const sq = searchQuery.toLowerCase().trim();
        vehicles = vehicles.filter((v) =>
          (v.code || '').toLowerCase().includes(sq) ||
          (v.registration || '').toLowerCase().includes(sq) ||
          (v.model || '').toLowerCase().includes(sq)
        );
      }

      const fleetProfitCls = t.total_net_profit >= 0 ? 'color:#15803d' : 'color:#b91c1c';
      const fleetProfitBorder = t.total_net_profit >= 0 ? '#22c55e' : '#ef4444';

      // KPI Scorecards
      const kpisHtml = `
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:18px">
          <div class="card stat" style="border-top:3px solid #0284c7">
            <div class="stat">
              <div class="l">TOTAL FLEET HIRING REVENUE</div>
              <div class="n" style="color:#0284c7">${money(t.total_hiring_revenue)}</div>
              <div style="font-size:11px;color:var(--muted)">Site hire & billed machinery</div>
            </div>
          </div>

          <div class="card stat" style="border-top:3px solid #c2410c">
            <div class="stat">
              <div class="l">TOTAL WORKSHOP REPAIRS</div>
              <div class="n" style="color:#c2410c">${money(t.total_repair_cost)}</div>
              <div style="font-size:11px;color:var(--muted)">Job cards, parts & materials</div>
            </div>
          </div>

          <div class="card stat" style="border-top:3px solid #b45309">
            <div class="stat">
              <div class="l">TOTAL DIESEL FUEL COST</div>
              <div class="n" style="color:#b45309">${money(t.total_diesel_cost)}</div>
              <div style="font-size:11px;color:var(--muted)">${num(t.total_diesel_litres)} Litres dispensed</div>
            </div>
          </div>

          <div class="card stat" style="border-top:3px solid #7c2d12">
            <div class="stat">
              <div class="l">DRIVER & OTHER COSTS</div>
              <div class="n" style="color:#7c2d12">${money(t.total_driver_other_costs)}</div>
              <div style="font-size:11px;color:var(--muted)">Salaries, bata, OT & expenses</div>
            </div>
          </div>

          <div class="card stat" style="border-top:3px solid #64748b">
            <div class="stat">
              <div class="l">TOTAL FLEET EXPENSES</div>
              <div class="n" style="color:#475569">${money(t.total_expenses)}</div>
              <div style="font-size:11px;color:var(--muted)">Repairs + Diesel + Driver Costs</div>
            </div>
          </div>

          <div class="card stat" style="border-top:3px solid ${fleetProfitBorder}">
            <div class="stat">
              <div class="l">FINAL NET FLEET PROFIT</div>
              <div class="n" style="${fleetProfitCls}">${money(t.total_net_profit)}</div>
              <div style="font-size:12px;font-weight:700;${fleetProfitCls}">${t.fleet_profit_margin_percent}% Overall Margin</div>
            </div>
          </div>
        </div>
      `;

      // Master Vehicle Rows
      const rows = vehicles.map((v) => {
        const netProfitCls = v.net_profit >= 0 ? 'color:#15803d;font-weight:700' : 'color:#b91c1c;font-weight:700';
        return `
          <tr>
            <td>
              <a href="#/vehiclecosting?asset_id=${v.id}&month=${month}"><b>${esc(v.code)}</b></a>
            </td>
            <td>${esc(v.registration || '—')}</td>
            <td>${esc(v.category || '—')} · ${esc(v.model || '')}</td>
            <td>${esc(v.project_name || 'Central')}</td>
            <td class="num"><b>${money(v.hiring_revenue)}</b></td>
            <td class="num">${money(v.repair_cost)}</td>
            <td class="num">${money(v.diesel_cost)}</td>
            <td class="num">${money(v.driver_other_costs)}</td>
            <td class="num"><b>${money(v.total_expenses)}</b></td>
            <td class="num" style="${netProfitCls}">${money(v.net_profit)}</td>
            <td class="num" style="${netProfitCls}">${v.margin_percent}%</td>
            <td style="text-align:right">
              <a class="btn sm" href="#/vehiclecosting?asset_id=${v.id}&month=${month}" title="View Comprehensive Statement">📄 Statement</a>
            </td>
          </tr>
        `;
      });

      // Bottom Totals Row
      const totalRow = `
        <tr class="summary-total-row" style="background:#f1f5f9;font-weight:800;border-top:2px solid #94a3b8">
          <td colspan="4" style="text-align:right">FLEET TOTALS (${vehicles.length} VEHICLES):</td>
          <td class="num">${money(t.total_hiring_revenue)}</td>
          <td class="num">${money(t.total_repair_cost)}</td>
          <td class="num">${money(t.total_diesel_cost)}</td>
          <td class="num">${money(t.total_driver_other_costs)}</td>
          <td class="num">${money(t.total_expenses)}</td>
          <td class="num" style="${fleetProfitCls}">${money(t.total_net_profit)}</td>
          <td class="num" style="${fleetProfitCls}">${t.fleet_profit_margin_percent}%</td>
          <td></td>
        </tr>
      `;

      const headers = [
        { label: 'Vehicle Code' }, { label: 'Registration' }, { label: 'Type / Model' },
        { label: 'Operating Site' }, { label: 'Hiring Revenue (LKR)', num: true },
        { label: 'Repair Cost (LKR)', num: true }, { label: 'Diesel Cost (LKR)', num: true },
        { label: 'Driver Costs (LKR)', num: true }, { label: 'Total Expenses (LKR)', num: true },
        { label: 'Net Profit / (Loss)', num: true }, { label: 'Margin', num: true },
        { label: 'Action', width: '90px' }
      ];

      container.innerHTML = `
        ${kpisHtml}
        <div class="card">
          <div class="toolbar" style="margin-bottom:10px">
            <h3 style="margin:0">Fleet Performance & Vehicle Costing Breakdown (${monthName(month)})</h3>
            <div class="spacer"></div>
            <span class="muted" style="font-size:12px">Showing ${vehicles.length} vehicles</span>
          </div>
          ${tableWrap(headers, [...rows, totalRow], { scroll: true })}
        </div>
      `;
    } catch (e) {
      container.innerHTML = `<div class="card err">Failed to load fleet costing summary: ${esc(e.message)}</div>`;
    }
  }
})();
