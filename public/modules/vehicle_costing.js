'use strict';

/**
 * Native WorkshopOne Vehicle Costing & Master P&L Module
 *
 * Mounts at window.routes['vehicle-costing']
 * Integrates:
 * 1. Fleet-wide Monthly Costing & P&L Summary
 * 2. Printable Single-Vehicle Monthly Final Costing Report (combining Revenue, Workshop, Diesel, Driver Costs)
 * 3. Vehicle Hiring Revenue Entry & Management
 * 4. Driver & Other Vehicle Costs Entry & Management
 */

(function () {
  function notify(msg, kind = 'err') {
    if (typeof toast === 'function') toast(msg, kind);
    else console[kind === 'err' ? 'error' : 'log'](msg);
  }

  async function renderVehicleCosting(content) {
    const today = new Date().toISOString().slice(0, 7);
    let selectedMonth = today;
    let currentTab = 'fleet-summary';
    let fleetSummaryData = null;
    let selectedVehicleId = null;

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / <a href="#/master-dashboard">Master Cockpit</a> / Vehicle Final Costing</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Vehicle Costing &amp; Profitability P&amp;L</h1>
          <p class="muted" style="margin:4px 0 0 0">Authoritative combined costing: Hiring Revenue, Workshop Repairs, Diesel Burn, and Driver/Other Expenses</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label style="font-size:12px;font-weight:600">Month:</label>
          <input type="month" id="costing_filter_month" class="input sm" value="${selectedMonth}" style="width:140px">
          <button class="btn sm" id="btn_sync_hire_to_costing" style="background:#059669;color:#fff;border-color:#059669">⚡ Sync from Hire Rate Cards</button>
          <button class="btn primary sm" id="btn_refresh_costing">🔄 Reload</button>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <div class="tabs" style="display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border);flex-wrap:wrap">
        <button class="tab active" id="tab_fleet_summary" style="padding:8px 16px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2px solid var(--primary,#0066ff)">📊 Fleet Summary</button>
        <button class="tab" id="tab_single_vehicle" style="padding:8px 16px;font-weight:600;border:none;background:none;cursor:pointer;color:var(--muted)">🚗 Single Vehicle Report</button>
        <button class="tab" id="tab_revenue" style="padding:8px 16px;font-weight:600;border:none;background:none;cursor:pointer;color:var(--muted)">💵 Hiring Revenue</button>
        <button class="tab" id="tab_driver_costs" style="padding:8px 16px;font-weight:600;border:none;background:none;cursor:pointer;color:var(--muted)">👨‍✈️ Driver &amp; Other Costs</button>
      </div>

      <!-- Tab Content Container -->
      <div id="costing_tab_content">Loading costing data...</div>
    `;

    function setActiveTab(tabId) {
      currentTab = tabId;
      ['fleet_summary', 'single_vehicle', 'revenue', 'driver_costs'].forEach(t => {
        const btn = qs('#tab_' + t);
        if (btn) {
          if (t === tabId.replace('-', '_')) {
            btn.style.borderBottom = '2px solid var(--primary,#0066ff)';
            btn.style.color = 'var(--text)';
            btn.classList.add('active');
          } else {
            btn.style.borderBottom = 'none';
            btn.style.color = 'var(--muted)';
            btn.classList.remove('active');
          }
        }
      });
      renderCurrentTab();
    }

    qs('#tab_fleet_summary').onclick = () => setActiveTab('fleet-summary');
    qs('#tab_single_vehicle').onclick = () => setActiveTab('single-vehicle');
    qs('#tab_revenue').onclick = () => setActiveTab('revenue');
    qs('#tab_driver_costs').onclick = () => setActiveTab('driver-costs');

    qs('#costing_filter_month').onchange = (e) => {
      selectedMonth = e.target.value;
      renderCurrentTab();
    };
    qs('#btn_refresh_costing').onclick = () => renderCurrentTab();
    if (qs('#btn_sync_hire_to_costing')) {
      qs('#btn_sync_hire_to_costing').onclick = async () => {
        try {
          const r = await api('/hire/sync-to-costing', { method: 'POST', body: { month: selectedMonth } });
          toast(`Synced ${r.generatedBills} new rental bills (${r.totalMonthBills} active for ${selectedMonth})!`);
          renderCurrentTab();
        } catch (err) {
          notify('Sync error: ' + err.message, 'err');
        }
      };
    }

    async function renderCurrentTab() {
      const container = qs('#costing_tab_content');
      if (!container) return;
      container.innerHTML = `<div class="card muted" style="padding:30px;text-align:center">Loading ${esc(currentTab)}...</div>`;

      try {
        if (currentTab === 'fleet-summary') {
          await renderFleetSummaryTab(container);
        } else if (currentTab === 'single-vehicle') {
          await renderSingleVehicleTab(container);
        } else if (currentTab === 'revenue') {
          await renderRevenueTab(container);
        } else if (currentTab === 'driver-costs') {
          await renderDriverCostsTab(container);
        }
      } catch (err) {
        container.innerHTML = `<div class="card" style="padding:20px;border-left:4px solid var(--red,#ef4444)">Error loading costing tab: ${esc(err.message)}</div>`;
      }
    }

    // --- Tab 1: Fleet Summary ---
    async function renderFleetSummaryTab(container) {
      const res = await api(`/vehicle-costing/fleet-summary?month=${selectedMonth}`);
      fleetSummaryData = res;

      const totals = res.totals || {};
      const vehicles = res.vehicles || [];

      container.innerHTML = `
        <!-- KPI Cards -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;margin-bottom:16px">
          <div class="card" style="padding:14px;border-left:4px solid var(--primary,#0066ff)">
            <div class="muted" style="font-size:11px;font-weight:600">HIRING REVENUE</div>
            <div style="font-size:20px;font-weight:800;margin-top:4px;color:var(--primary,#0066ff)">${moneyC(totals.total_hiring_revenue || 0)}</div>
          </div>
          <div class="card" style="padding:14px;border-left:4px solid var(--cost-amber,#b45309)">
            <div class="muted" style="font-size:11px;font-weight:600">WORKSHOP REPAIRS</div>
            <div style="font-size:20px;font-weight:800;margin-top:4px;color:var(--cost-amber,#b45309)">${moneyC(totals.total_repair_cost || 0)}</div>
          </div>
          <div class="card" style="padding:14px;border-left:4px solid var(--cost-diesel,#4f46e5)">
            <div class="muted" style="font-size:11px;font-weight:600">DIESEL COST (${num(totals.total_diesel_litres || 0)} L)</div>
            <div style="font-size:20px;font-weight:800;margin-top:4px;color:var(--cost-diesel,#4f46e5)">${moneyC(totals.total_diesel_cost || 0)}</div>
          </div>
          <div class="card" style="padding:14px;border-left:4px solid var(--cost-driver,#be185d)">
            <div class="muted" style="font-size:11px;font-weight:600">DRIVER &amp; OTHER COSTS</div>
            <div style="font-size:20px;font-weight:800;margin-top:4px;color:var(--cost-driver,#be185d)">${moneyC(totals.total_driver_other_cost || 0)}</div>
          </div>
          <div class="card" style="padding:14px;border-left:4px solid ${(totals.total_net_profit || 0) >= 0 ? 'var(--cost-pos,#047857)' : 'var(--cost-neg,#dc2626)'}">
            <div class="muted" style="font-size:11px;font-weight:600">NET FLEET PROFIT / LOSS</div>
            <div style="font-size:20px;font-weight:800;margin-top:4px;color:${(totals.total_net_profit || 0) >= 0 ? 'var(--cost-pos,#047857)' : 'var(--cost-neg,#dc2626)'}">${moneyC(totals.total_net_profit || 0)}</div>
          </div>
          <div class="card" style="padding:14px;border-left:4px solid #dc2626">
            <div class="muted" style="font-size:11px;font-weight:600">BREAKDOWN IMPACT (LESS BD = LESS COST)</div>
            <div style="font-size:20px;font-weight:800;margin-top:4px;color:#dc2626">${moneyC(totals.total_breakdown_impact || 0)}</div>
            <div class="muted" style="font-size:10.5px;margin-top:2px">${num(totals.total_breakdown_days || 0)} BD d · ${num(totals.fleet_availability_percent != null ? totals.fleet_availability_percent : 100)}% Avail · Lost Hire ${moneyC(totals.total_lost_hire_revenue || 0)}</div>
          </div>
        </div>

        <!-- Filter and Search -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px;flex-wrap:wrap">
          <input type="text" id="costing_search_input" class="input sm" placeholder="Search vehicle code, reg no, category..." style="width:280px">
          <div class="muted" style="font-size:12px">${vehicles.length} active fleet vehicles with operational data</div>
        </div>

        <!-- Table -->
        <div class="card" style="overflow-x:auto;padding:0">
          <table class="table" style="width:100%;margin:0;font-size:13px" id="costing_fleet_table">
            <thead>
              <tr>
                <th>Asset Code</th>
                <th>Registration</th>
                <th>Category</th>
                <th style="text-align:right">Revenue</th>
                <th style="text-align:right">Repair Cost</th>
                <th style="text-align:right">BD / Avail</th>
                <th style="text-align:right">Lost Hire</th>
                <th style="text-align:right">Diesel (L)</th>
                <th style="text-align:right">Diesel Cost</th>
                <th style="text-align:right">Driver/Other</th>
                <th style="text-align:right">Net Profit / Loss</th>
                <th style="text-align:center">Action</th>
              </tr>
            </thead>
            <tbody>
              ${vehicles.slice(0, 150).map(v => {
                const profit = v.net_profit || 0;
                const profitColor = profit > 0 ? 'var(--cost-pos,#047857)' : (profit < 0 ? 'var(--cost-neg,#dc2626)' : 'inherit');
                const vId = v.id || v.asset_id;
                const bdDays = v.breakdown_days || 0;
                const availPct = v.availability_percent != null ? v.availability_percent : 100;
                return `
                  <tr>
                    <td><b>${esc(v.code || '-')}</b></td>
                    <td>${esc(v.registration || '-')}</td>
                    <td class="muted">${esc(v.category || '-')}</td>
                    <td style="text-align:right;color:var(--primary,#0066ff)">${money(v.hiring_revenue || 0)}</td>
                    <td style="text-align:right;color:var(--cost-amber,#b45309)">${money(v.repair_cost || 0)}</td>
                    <td style="text-align:right;white-space:nowrap">${bdDays > 0 ? `<span class="badge red" style="font-size:10.5px">${bdDays}d · ${availPct}%</span>` : `<span class="muted">${availPct}%</span>`}</td>
                    <td style="text-align:right;color:${v.lost_hire_revenue > 0 ? '#dc2626' : 'var(--muted)'}">${money(v.lost_hire_revenue || 0)}</td>
                    <td style="text-align:right">${num(v.diesel_litres || 0)}</td>
                    <td style="text-align:right;color:var(--cost-diesel,#4f46e5)">${money(v.diesel_cost || 0)}</td>
                    <td style="text-align:right;color:var(--cost-driver,#be185d)">${money(v.driver_other_cost || 0)}</td>
                    <td style="text-align:right;font-weight:700;color:${profitColor}">${money(profit)}</td>
                    <td style="text-align:center">
                      <button class="btn sm" data-view-report="${vId}" style="padding:2px 8px;font-size:11px">📄 Costing Report</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      // Wire search filter
      qs('#costing_search_input').oninput = (e) => {
        const q = e.target.value.toLowerCase();
        const rows = qsa('#costing_fleet_table tbody tr');
        rows.forEach(r => {
          r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      };

      // Wire action buttons
      qsa('#costing_fleet_table [data-view-report]').forEach(btn => {
        btn.onclick = () => {
          selectedVehicleId = btn.getAttribute('data-view-report');
          setActiveTab('single-vehicle');
        };
      });
    }

    // --- Tab 2: Single Vehicle Costing Report ---
    async function renderSingleVehicleTab(container) {
      if (!selectedVehicleId) {
        // Look up first vehicle with data from summary
        if (fleetSummaryData && fleetSummaryData.vehicles && fleetSummaryData.vehicles.length) {
          selectedVehicleId = fleetSummaryData.vehicles[0].id || fleetSummaryData.vehicles[0].asset_id;
        } else {
          selectedVehicleId = 1;
        }
      }

      const rep = await api(`/vehicle-costing/single-vehicle?asset_id=${selectedVehicleId}&month=${selectedMonth}`);
      const asset = rep.asset || {};
      const financial = rep.summary || rep.financial || {};
      const breakdown = rep.breakdown || {};
      const repairIssues = breakdown.repair_costs ? (breakdown.repair_costs.store_issues || []) : (breakdown.issues || []);
      const dieselIssues = breakdown.diesel_costs ? (breakdown.diesel_costs.issues || []) : (breakdown.fuel_issues || []);
      const profit = financial.net_profit || 0;
      const profitColor = profit >= 0 ? 'var(--cost-pos,#047857)' : 'var(--cost-neg,#dc2626)';

      container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div style="display:flex;gap:8px;align-items:center">
            <label style="font-size:12px;font-weight:600">Select Vehicle:</label>
            <select id="single_vehicle_picker" class="input sm" style="width:280px">
              ${(fleetSummaryData && fleetSummaryData.vehicles || []).map(v => {
                const vid = v.id || v.asset_id;
                return `<option value="${vid}" ${String(vid) === String(selectedVehicleId) ? 'selected' : ''}>${esc(v.code)} - ${esc(v.registration || v.category || '')}</option>`;
              }).join('')}
            </select>
          </div>
          <button class="btn primary sm" id="btn_print_costing_sheet">🖨️ Print Costing Sheet</button>
        </div>

        <!-- Printable Costing Sheet Section -->
        <div id="printable_costing_card" class="card" style="padding:24px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px">
          <!-- Letterhead -->
          <div style="display:flex;justify-content:space-between;border-bottom:2px solid var(--border);padding-bottom:14px;margin-bottom:16px">
            <div>
              <h2 style="margin:0;font-size:20px;font-weight:800;letter-spacing:0.5px;color:var(--text)">CENTRAL WORKSHOP &amp; FLEET MANAGEMENT</h2>
              <div class="muted" style="font-size:12px;margin-top:2px">Authoritative Monthly Vehicle Operational &amp; Financial Costing Statement</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:14px;font-weight:700;color:var(--text)">PERIOD: ${esc(rep.month || selectedMonth)}</div>
              <div class="muted" style="font-size:11px">Generated: ${new Date().toLocaleDateString('en-GB')}</div>
            </div>
          </div>

          <!-- Vehicle Meta Box -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;margin-bottom:20px;color:var(--text)">
            <div><span class="muted" style="font-size:11px;font-weight:600">ASSET CODE:</span><br><b>${esc(asset.code || '-')}</b></div>
            <div><span class="muted" style="font-size:11px;font-weight:600">REGISTRATION NO:</span><br><b>${esc(asset.registration || '-')}</b></div>
            <div><span class="muted" style="font-size:11px;font-weight:600">CATEGORY / MAKE:</span><br><b>${esc(asset.category || '-')}</b></div>
            <div><span class="muted" style="font-size:11px;font-weight:600">CURRENT METER:</span><br><b>${num(asset.current_hours || 0)} hrs / km</b></div>
            <div><span class="muted" style="font-size:11px;font-weight:600">ALLOCATED PROJECT:</span><br><b>${esc(asset.project_name || 'Central Workshop')}</b></div>
            <div><span class="muted" style="font-size:11px;font-weight:600">AVAILABILITY / REPAIR DAYS:</span><br><b>${num(financial.availability_percent != null ? financial.availability_percent : 100)}% (${num(financial.breakdown_days || 0)} BD d)</b></div>
          </div>

          <!-- Financial Statement P&L Summary Table -->
          <h3 style="margin:0 0 8px 0;font-size:15px;font-weight:700;color:var(--text);text-transform:none;letter-spacing:0">1. Operational Contribution &amp; Net Margin Statement</h3>
          <table class="table" style="width:100%;margin-bottom:24px;border:1px solid var(--border)">
            <thead>
              <tr>
                <th>Cost / Revenue Component</th>
                <th>Reference Details</th>
                <th style="text-align:right">Amount (LKR)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>(+) Gross Vehicle Hiring Revenue</b></td>
                <td class="muted">Monthly machine hire, client billing &amp; hourly rental</td>
                <td style="text-align:right;font-weight:700;color:var(--primary,#0066ff)">${moneyC(financial.hiring_revenue || 0)}</td>
              </tr>
              <tr>
                <td><b>(−) Workshop Maintenance &amp; Spare Parts</b></td>
                <td class="muted">Direct material issues, job card parts, filters and servicing</td>
                <td style="text-align:right;font-weight:700;color:var(--cost-amber,#b45309)">${moneyC(financial.repair_cost || 0)}</td>
              </tr>
              <tr>
                <td><b>(−) Diesel Fuel Consumption</b></td>
                <td class="muted">Total ${num(financial.diesel_litres || 0)} Litres dispensed via Bowser/Bulk Tanks</td>
                <td style="text-align:right;font-weight:700;color:var(--cost-diesel,#4f46e5)">${moneyC(financial.diesel_cost || 0)}</td>
              </tr>
              <tr>
                <td><b>(−) Driver Salary, Bata &amp; Other Expenses</b></td>
                <td class="muted">Operator salaries, daily allowance/bata &amp; statutory vehicle costs</td>
                <td style="text-align:right;font-weight:700;color:var(--cost-driver,#be185d)">${moneyC(financial.driver_other_cost || 0)}</td>
              </tr>
              <tr style="border-top:2px solid var(--border);background:var(--surface-2);color:var(--text);font-size:15px">
                <td><b>(=) FINAL NET OPERATING PROFIT / LOSS</b></td>
                <td class="muted">Revenue − Total Operational Costs</td>
                <td style="text-align:right;font-weight:900;color:${profitColor}">${moneyC(profit)}</td>
              </tr>
              ${(financial.breakdown_days || 0) > 0 || (financial.repair_cost || 0) > 0 ? `
              <tr style="background:rgba(220,38,38,0.05)">
                <td><b style="color:#b91c1c">Company Breakdown Cost Impact (Non-Billable)</b></td>
                <td class="muted">${num(financial.breakdown_days || 0)} BD day(s) (${num(financial.availability_percent != null ? financial.availability_percent : 100)}% Avail) · Repairs ${moneyC(financial.repair_cost || 0)} + Lost Hire ${moneyC(financial.lost_hire_revenue || 0)}</td>
                <td style="text-align:right;font-weight:800;color:#b91c1c">${moneyC(financial.total_breakdown_impact || 0)}</td>
              </tr>
              ` : ''}
            </tbody>
          </table>

          <!-- 2. Itemized Workshop Issues -->
          <h3 style="margin:0 0 8px 0;font-size:15px;font-weight:700;color:var(--text);text-transform:none;letter-spacing:0">2. Itemized Workshop Material Issues &amp; Job Card Spares</h3>
          <div style="overflow-x:auto;margin-bottom:24px;border:1px solid var(--border);border-radius:6px">
            <table class="table" style="width:100%;font-size:12px;margin:0">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Issue Slip</th>
                  <th>Item / Spare Part Name</th>
                  <th>Recipient</th>
                  <th style="text-align:right">Qty</th>
                  <th style="text-align:right">Unit Price</th>
                  <th style="text-align:right">Total (LKR)</th>
                </tr>
              </thead>
              <tbody>
                ${repairIssues.length === 0 ? '<tr><td colspan="7" class="muted" style="text-align:center;padding:12px">No workshop material issues recorded for this vehicle in this period.</td></tr>' :
                  repairIssues.map(it => `
                    <tr>
                      <td>${esc(it.date || it.issue_date || '-')}</td>
                      <td>${esc(it.slip_no || it.issue_no || '-')}</td>
                      <td><b>${esc(it.item_name || it.description || '-')}</b></td>
                      <td class="muted">${esc(it.recipient || it.recipient_name || '-')}</td>
                      <td style="text-align:right">${num(it.quantity || it.qty || 1)}</td>
                      <td style="text-align:right">${money(it.unit_price || 0)}</td>
                      <td style="text-align:right;font-weight:600">${money(it.total_cost || it.total_price || (it.quantity * it.unit_price) || 0)}</td>
                    </tr>
                  `).join('')
                }
              </tbody>
            </table>
          </div>

          <!-- 3. Itemized Diesel Dispense Logs -->
          <h3 style="margin:0 0 8px 0;font-size:15px;font-weight:700;color:var(--text);text-transform:none;letter-spacing:0">3. Itemized Diesel Dispense &amp; Bowser Fuel Logs</h3>
          <div style="overflow-x:auto;border:1px solid var(--border);border-radius:6px">
            <table class="table" style="width:100%;font-size:12px;margin:0">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Slip No</th>
                  <th>Dispensing Bowser / Tank</th>
                  <th>Meter Reading</th>
                  <th style="text-align:right">Litres</th>
                  <th style="text-align:right">Rate / Litre</th>
                  <th style="text-align:right">Total Cost (LKR)</th>
                </tr>
              </thead>
              <tbody>
                ${dieselIssues.length === 0 ? '<tr><td colspan="7" class="muted" style="text-align:center;padding:12px">No diesel dispense logs recorded for this vehicle in this period.</td></tr>' :
                  dieselIssues.map(f => `
                    <tr>
                      <td>${esc(f.issue_date || f.date || '-')}</td>
                      <td><b>${esc(f.issue_no || f.slip_no || '-')}</b></td>
                      <td class="muted">${esc(f.tank_name || f.bowser_name || 'Bowser')}</td>
                      <td>${num(f.meter_reading || 0)}</td>
                      <td style="text-align:right">${num(f.litres || 0)} L</td>
                      <td style="text-align:right">${money(f.unit_price || (f.price_per_litre_cents ? f.price_per_litre_cents / 100 : 0))}</td>
                      <td style="text-align:right;font-weight:600">${money(f.total_price || (f.cost_cents ? f.cost_cents / 100 : 0))}</td>
                    </tr>
                  `).join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Wire vehicle picker
      qs('#single_vehicle_picker').onchange = (e) => {
        selectedVehicleId = e.target.value;
        renderSingleVehicleTab(container);
      };

      // Wire Print Button
      qs('#btn_print_costing_sheet').onclick = () => {
        const printContent = qs('#printable_costing_card').innerHTML;
        const printWin = window.open('', '_blank', 'width=900,height=750');
        printWin.document.write(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Vehicle Costing Report - ${esc(asset.code || '')}</title>
            <style>
              :root { --surface: #ffffff; --surface-2: #f1f5f9; --border: #cbd5e1; --text: #111827; --muted: #4b5563; --primary: #0052cc; --cost-amber: #b45309; --cost-diesel: #4f46e5; --cost-driver: #be185d; --cost-pos: #047857; --cost-neg: #dc2626; }
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #fff; color: #111827; padding: 20px; line-height: 1.4; }
              table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
              th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; }
              th { background: #f1f5f9; color: #334155; }
              .muted { color: #4b5563; font-size: 11px; }
              @media print {
                body { padding: 0; }
                button { display: none !important; }
              }
            </style>
          </head>
          <body>
            ${printContent}
            <div style="margin-top:40px;display:flex;justify-content:space-between;padding-top:20px;font-size:12px">
              <div>____________________________<br>Prepared By (Cost Accountant)</div>
              <div>____________________________<br>Certified By (Mechanical Engineer)</div>
              <div>____________________________<br>Approved By (Managing Director)</div>
            </div>
          </body>
          </html>
        `);
        printWin.document.close();
        printWin.focus();
        setTimeout(() => printWin.print(), 300);
      };
    }

    // --- Tab 3: Hiring Revenue Management ---
    async function renderRevenueTab(container) {
      const res = await api(`/vehicle-costing/hiring-revenue?month=${selectedMonth}`);
      const rows = res.rows || [];

      container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
          <div>
            <h2 style="margin:0;font-size:18px;font-weight:700">Vehicle Hiring Revenue Entries</h2>
            <div class="muted" style="font-size:12px">Record machine rental contracts, hourly billable work, and project hiring revenues</div>
          </div>
          <button class="btn primary sm" id="btn_new_revenue_entry">+ Record Hiring Revenue</button>
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:13px">
            <thead>
              <tr>
                <th>Date</th>
                <th>Vehicle Code</th>
                <th>Project / Hirer</th>
                <th>Rate Basis</th>
                <th style="text-align:right">Hours / Days</th>
                <th style="text-align:right">Rate (LKR)</th>
                <th style="text-align:right">Total Revenue (LKR)</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0 ? '<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">No hiring revenue entries recorded for this month.</td></tr>' :
                rows.map(r => `
                  <tr>
                    <td>${esc(r.revenue_date || '-')}</td>
                    <td><b>${esc(r.asset_code || '-')}</b></td>
                    <td>${esc(r.project_name || r.hirer_name || '-')}</td>
                    <td><span class="badge blue">${esc(r.rate_type || 'HOURLY')}</span></td>
                    <td style="text-align:right">${num(r.hours_or_days || 0)}</td>
                    <td style="text-align:right">${money(r.rate || 0)}</td>
                    <td style="text-align:right;font-weight:700;color:var(--primary,#0066ff)">${moneyC(r.total_revenue || 0)}</td>
                    <td class="muted">${esc(r.notes || '-')}</td>
                  </tr>
                `).join('')
              }
            </tbody>
          </table>
        </div>
      `;

      qs('#btn_new_revenue_entry').onclick = () => showRevenueEntryModal();
    }

    // --- Tab 4: Driver & Other Costs ---
    async function renderDriverCostsTab(container) {
      const res = await api(`/vehicle-costing/driver-costs?month=${selectedMonth}`);
      const rows = res.rows || [];

      container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
          <div>
            <h2 style="margin:0;font-size:18px;font-weight:700">Driver Salaries &amp; Vehicle Operating Expenses</h2>
            <div class="muted" style="font-size:12px">Track operator wages, OT/bata, road tax, insurance, and direct machine overheads</div>
          </div>
          <button class="btn primary sm" id="btn_new_driver_cost_entry">+ Record Driver / Vehicle Cost</button>
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:13px">
            <thead>
              <tr>
                <th>Date</th>
                <th>Vehicle Code</th>
                <th>Cost Category</th>
                <th>Recipient / Payee</th>
                <th style="text-align:right">Amount (LKR)</th>
                <th>Reference / Description</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0 ? '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px">No driver or other vehicle costs recorded for this month.</td></tr>' :
                rows.map(r => `
                  <tr>
                    <td>${esc(r.cost_date || '-')}</td>
                    <td><b>${esc(r.asset_code || '-')}</b></td>
                    <td><span class="badge ${r.cost_type === 'SALARY' ? 'green' : 'amber'}">${esc(r.cost_type || 'DRIVER_EXPENSE')}</span></td>
                    <td>${esc(r.driver_name || r.payee || '-')}</td>
                    <td style="text-align:right;font-weight:700;color:var(--cost-driver,#be185d)">${moneyC(r.amount || 0)}</td>
                    <td class="muted">${esc(r.description || r.notes || '-')}</td>
                  </tr>
                `).join('')
              }
            </tbody>
          </table>
        </div>
      `;

      qs('#btn_new_driver_cost_entry').onclick = () => showDriverCostEntryModal();
    }

    // Modal: Record Hiring Revenue
    function showRevenueEntryModal() {
      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal card" style="max-width:480px;padding:24px">
          <h2 style="margin:0 0 16px 0;font-size:18px">Record Vehicle Hiring Revenue</h2>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label class="label">Vehicle Asset ID or Code:</label>
              <input type="text" id="rev_asset_id" class="input" placeholder="e.g. 101 or DA-4251">
            </div>
            <div>
              <label class="label">Date:</label>
              <input type="date" id="rev_date" class="input" value="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label class="label">Hours / Days:</label>
                <input type="number" id="rev_hours" class="input" value="1" step="0.5">
              </div>
              <div>
                <label class="label">Rate per Unit (LKR):</label>
                <input type="number" id="rev_rate" class="input" placeholder="e.g. 12000">
              </div>
            </div>
            <div>
              <label class="label">Total Hiring Revenue (LKR):</label>
              <input type="number" id="rev_total" class="input" placeholder="Auto-calculated" readonly style="background:var(--surface-2);color:var(--text)">
            </div>
            <div>
              <label class="label">Notes / Client:</label>
              <input type="text" id="rev_notes" class="input" placeholder="Project or client contract details">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
              <button class="btn" id="btn_cancel_rev">Cancel</button>
              <button class="btn primary" id="btn_save_rev">Save Revenue</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const calcTotal = () => {
        const h = parseFloat(modal.querySelector('#rev_hours').value) || 0;
        const r = parseFloat(modal.querySelector('#rev_rate').value) || 0;
        modal.querySelector('#rev_total').value = (h * r).toFixed(2);
      };
      modal.querySelector('#rev_hours').oninput = calcTotal;
      modal.querySelector('#rev_rate').oninput = calcTotal;

      modal.querySelector('#btn_cancel_rev').onclick = () => modal.remove();
      modal.querySelector('#btn_save_rev').onclick = async () => {
        const assetId = modal.querySelector('#rev_asset_id').value.trim();
        const revDate = modal.querySelector('#rev_date').value;
        const hours = parseFloat(modal.querySelector('#rev_hours').value) || 0;
        const rate = parseFloat(modal.querySelector('#rev_rate').value) || 0;
        const total = parseFloat(modal.querySelector('#rev_total').value) || 0;
        const notes = modal.querySelector('#rev_notes').value;

        if (!assetId || total <= 0) {
          notify('Please enter valid vehicle and revenue amounts.', 'err');
          return;
        }

        try {
          await api('/vehicle-costing/hiring-revenue', {
            method: 'POST',
            body: { asset_id: assetId, revenue_date: revDate, hours_or_days: hours, rate, total_revenue: total, notes }
          });
          modal.remove();
          renderCurrentTab();
        } catch (e) {
          notify('Failed to save revenue: ' + e.message, 'err');
        }
      };
    }

    // Modal: Record Driver Cost
    function showDriverCostEntryModal() {
      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal card" style="max-width:480px;padding:24px">
          <h2 style="margin:0 0 16px 0;font-size:18px">Record Driver / Vehicle Expense</h2>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label class="label">Vehicle Asset ID or Code:</label>
              <input type="text" id="dc_asset_id" class="input" placeholder="e.g. 101 or DA-4251">
            </div>
            <div>
              <label class="label">Date:</label>
              <input type="date" id="dc_date" class="input" value="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div>
              <label class="label">Cost Category:</label>
              <select id="dc_type" class="input">
                <option value="SALARY">Driver Salary</option>
                <option value="BATA">Driver Bata / Daily Allowance</option>
                <option value="OVERTIME">Driver OT</option>
                <option value="REVENUE_LICENCE">Revenue Licence</option>
                <option value="INSURANCE">Insurance Premium</option>
                <option value="OTHER">Other Operational Expense</option>
              </select>
            </div>
            <div>
              <label class="label">Driver Name / Payee:</label>
              <input type="text" id="dc_payee" class="input" placeholder="Name of driver or payee">
            </div>
            <div>
              <label class="label">Amount (LKR):</label>
              <input type="number" id="dc_amount" class="input" placeholder="e.g. 35000">
            </div>
            <div>
              <label class="label">Description / Receipt Ref:</label>
              <input type="text" id="dc_notes" class="input" placeholder="Voucher / Cheque / Reason">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
              <button class="btn" id="btn_cancel_dc">Cancel</button>
              <button class="btn primary" id="btn_save_dc">Save Cost</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#btn_cancel_dc').onclick = () => modal.remove();
      modal.querySelector('#btn_save_dc').onclick = async () => {
        const assetId = modal.querySelector('#dc_asset_id').value.trim();
        const costDate = modal.querySelector('#dc_date').value;
        const costType = modal.querySelector('#dc_type').value;
        const payee = modal.querySelector('#dc_payee').value;
        const amount = parseFloat(modal.querySelector('#dc_amount').value) || 0;
        const notes = modal.querySelector('#dc_notes').value;

        if (!assetId || amount <= 0) {
          notify('Please enter valid vehicle and cost amount.', 'err');
          return;
        }

        try {
          await api('/vehicle-costing/driver-costs', {
            method: 'POST',
            body: { asset_id: assetId, cost_date: costDate, cost_type: costType, driver_name: payee, amount, notes }
          });
          modal.remove();
          renderCurrentTab();
        } catch (e) {
          notify('Failed to save cost: ' + e.message, 'err');
        }
      };
    }

    // Initial load
    renderCurrentTab();
  }

  // Register route
  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['vehicle-costing'] = renderVehicleCosting;
  }
})();
