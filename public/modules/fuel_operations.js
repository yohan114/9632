'use strict';

/**
 * Native WorkshopOne Fuel Operations Module (Plan V2)
 *
 * Provides:
 * - Authoritative fuel issues register with pagination, search, date filtering
 * - Direct fuel dispensing / issue modal with tank stock deduction
 * - Documented soft voiding with automatic tank stock restoration
 * - Ceypetco price point monitoring
 */

(function () {
  async function renderFuelOperations(content) {
    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / Fuel Management</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Fuel Operations</h1>
          <p class="muted" style="margin:4px 0 0 0">Authoritative diesel & petrol issues, vehicle meter readings, and pump reconciliations</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="btn_new_fuel_issue">⛽ Issue Fuel</button>
          <button class="btn" id="btn_export_fuel_csv">📥 Export Excel</button>
        </div>
      </div>

      <!-- KPI Summary Cards -->
      <div class="kpi-grid" id="fuel_kpi_cards" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;margin-bottom:16px">
        <div class="card" style="padding:14px">
          <div class="muted" style="font-size:12px;font-weight:600">TODAY'S FUEL ISSUED</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px;color:var(--primary,#0066ff)" id="kpi_today_litres">... L</div>
          <div class="muted" style="font-size:11px" id="kpi_today_cost">Rs ...</div>
        </div>
        <div class="card" style="padding:14px">
          <div class="muted" style="font-size:12px;font-weight:600">THIS MONTH'S CONSUMPTION</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px" id="kpi_month_litres">... L</div>
          <div class="muted" style="font-size:11px" id="kpi_month_cost">Rs ...</div>
        </div>
        <div class="card" style="padding:14px">
          <div class="muted" style="font-size:12px;font-weight:600">STORAGE TANK STOCK</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px;color:#10b981" id="kpi_tank_stock">... L</div>
          <div class="muted" style="font-size:11px" id="kpi_tank_count">Across ... bulk tanks</div>
        </div>
        <div class="card" style="padding:14px">
          <div class="muted" style="font-size:12px;font-weight:600">CEYPETCO DIESEL RATE</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px" id="kpi_diesel_rate">Rs ... / L</div>
          <div class="muted" style="font-size:11px">Auto Diesel</div>
        </div>
      </div>

      <!-- Filter Bar -->
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <input type="text" id="fuel_filter_search" placeholder="Search vehicle code, plate, driver..." style="flex:1;min-width:200px" class="input sm">
        <input type="date" id="fuel_filter_from" class="input sm" title="From Date">
        <input type="date" id="fuel_filter_to" class="input sm" title="To Date">
        <select id="fuel_filter_tank" class="input sm" style="min-width:160px">
          <option value="">All Storage Tanks / Bowsers</option>
        </select>
        <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" id="fuel_filter_voided"> Show Voided
        </label>
        <button class="btn sm" id="btn_apply_fuel_filter">Filter</button>
      </div>

      <!-- Fuel Issues Table -->
      <div class="card" style="padding:0;overflow:hidden">
        <div style="overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:13px">
            <thead>
              <tr style="background:rgba(0,0,0,0.02)">
                <th style="padding:10px 14px">Date & Time</th>
                <th style="padding:10px 14px">Vehicle / Plant</th>
                <th style="padding:10px 14px">Fuel</th>
                <th style="padding:10px 14px;text-align:right">Litres</th>
                <th style="padding:10px 14px;text-align:right">Unit Price</th>
                <th style="padding:10px 14px;text-align:right">Total Cost</th>
                <th style="padding:10px 14px">Meter Reading</th>
                <th style="padding:10px 14px">Source Tank</th>
                <th style="padding:10px 14px">Driver / Operator</th>
                <th style="padding:10px 14px;text-align:center">Actions</th>
              </tr>
            </thead>
            <tbody id="fuel_issues_tbody">
              <tr><td colspan="10" style="padding:24px;text-align:center" class="muted">Loading fuel issues...</td></tr>
            </tbody>
          </table>
        </div>
        <div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,0.01);border-top:1px solid var(--border)">
          <div class="muted" style="font-size:12px" id="fuel_pagination_info">Showing 0 of 0</div>
          <div style="display:flex;gap:6px">
            <button class="btn sm" id="btn_fuel_prev" disabled>Previous</button>
            <button class="btn sm" id="btn_fuel_next" disabled>Next</button>
          </div>
        </div>
      </div>
    `;

    let currentOffset = 0;
    const limit = 50;

    // Load Stats
    try {
      const stats = await api('/fuel/stats');
      qs('#kpi_today_litres').textContent = `${Number(stats.today.total_litres).toLocaleString()} L`;
      qs('#kpi_today_cost').textContent = `Rs ${(Number(stats.today.total_cost_cents) / 100).toLocaleString()}`;
      qs('#kpi_month_litres').textContent = `${Number(stats.month.total_litres).toLocaleString()} L`;
      qs('#kpi_month_cost').textContent = `Rs ${(Number(stats.month.total_cost_cents) / 100).toLocaleString()}`;
      qs('#kpi_tank_stock').textContent = `${Number(stats.tanks.total_stock_litres).toLocaleString()} L`;
      qs('#kpi_tank_count').textContent = `Across ${stats.tanks.total_tanks} bulk tanks`;
      qs('#kpi_diesel_rate').textContent = `Rs ${(Number(stats.currentDieselCents) / 100).toFixed(2)}`;
    } catch (_) {}

    // Load Tanks for Filter
    try {
      const { tanks } = await api('/fuel/tanks');
      const sel = qs('#fuel_filter_tank');
      if (tanks && sel) {
        for (const t of tanks) {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = `${t.name} (${Number(t.current_litres).toLocaleString()}L)`;
          sel.appendChild(opt);
        }
      }
    } catch (_) {}

    async function loadTable() {
      const search = qs('#fuel_filter_search').value.trim();
      const from = qs('#fuel_filter_from').value;
      const to = qs('#fuel_filter_to').value;
      const tankId = qs('#fuel_filter_tank').value;
      const showVoided = qs('#fuel_filter_voided').checked;

      const params = new URLSearchParams({ limit, offset: currentOffset });
      if (search) params.set('search', search);
      if (from) params.set('fromDate', from);
      if (to) params.set('toDate', to);
      if (tankId) params.set('tankId', tankId);
      if (showVoided) params.set('showVoided', 'true');

      const tbody = qs('#fuel_issues_tbody');
      tbody.innerHTML = '<tr><td colspan="10" style="padding:24px;text-align:center" class="muted">Loading...</td></tr>';

      try {
        const res = await api(`/fuel/issues?${params.toString()}`);
        if (!res.rows || !res.rows.length) {
          tbody.innerHTML = '<tr><td colspan="10" style="padding:24px;text-align:center" class="muted">No fuel issue records found.</td></tr>';
          qs('#fuel_pagination_info').textContent = 'Showing 0 of 0';
          qs('#btn_fuel_prev').disabled = true;
          qs('#btn_fuel_next').disabled = true;
          return;
        }

        tbody.innerHTML = res.rows.map((r) => {
          const isVoid = r.is_voided === 1;
          const trStyle = isVoid ? 'style="opacity:0.6;background:rgba(239,68,68,0.05)"' : '';
          const statusBadge = isVoid ? '<span class="badge danger" style="margin-left:4px">VOIDED</span>' : '';
          return `
            <tr ${trStyle}>
              <td style="padding:10px 14px;white-space:nowrap">${esc(String(r.issue_date || '').slice(0, 16))}</td>
              <td style="padding:10px 14px">
                <b>${esc(r.asset_code)}</b>
                ${statusBadge}
                ${r.vehicle_ref && r.vehicle_ref !== r.asset_code ? `<br><span class="muted" style="font-size:11px">${esc(r.vehicle_ref)}</span>` : ''}
              </td>
              <td style="padding:10px 14px">${esc(r.fuel_type || 'AUTO_DIESEL')}</td>
              <td style="padding:10px 14px;text-align:right;font-weight:700">${Number(r.litres).toFixed(1)} L</td>
              <td style="padding:10px 14px;text-align:right">Rs ${(Number(r.fuel_price_cents) / 100).toFixed(2)}</td>
              <td style="padding:10px 14px;text-align:right;font-weight:700">Rs ${(Number(r.total_cost_cents) / 100).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
              <td style="padding:10px 14px">${r.meter_reading ? `${Number(r.meter_reading).toLocaleString()} ${esc(r.meter_type || 'HRS')}` : '<span class="muted">-</span>'}</td>
              <td style="padding:10px 14px">${esc(r.tank_name || r.station_name || 'Direct')}</td>
              <td style="padding:10px 14px">${esc(r.driver_name || '-')}</td>
              <td style="padding:10px 14px;text-align:center;white-space:nowrap">
                ${!isVoid && canDo('fuel.void') ? `<button class="btn sm danger btn-void-fuel" data-id="${esc(r.id)}" data-no="${esc(r.issue_no || r.id)}">Void</button>` : ''}
              </td>
            </tr>
          `;
        }).join('');

        qs('#fuel_pagination_info').textContent = `Showing ${currentOffset + 1}–${Math.min(currentOffset + res.rows.length, res.total)} of ${res.total}`;
        qs('#btn_fuel_prev').disabled = currentOffset === 0;
        qs('#btn_fuel_next').disabled = currentOffset + limit >= res.total;

        // Wire void buttons
        qsa('.btn-void-fuel', tbody).forEach((btn) => {
          btn.onclick = async () => {
            const id = btn.getAttribute('data-id');
            const no = btn.getAttribute('data-no');
            const reason = prompt(`Reason for VOIDING fuel issue ${no}?\n(This will restore litres back into the storage tank stock)`);
            if (!reason || !reason.trim()) return;
            try {
              await api(`/fuel/issues/${id}/void`, { method: 'POST', body: { reason: reason.trim() } });
              toast('Fuel issue voided successfully. Tank stock restored.');
              loadTable();
            } catch (err) {
              alert('Error voiding issue: ' + err.message);
            }
          };
        });

      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="10" style="padding:24px;text-align:center" class="err">Error loading fuel issues: ${esc(err.message)}</td></tr>`;
      }
    }

    qs('#btn_apply_fuel_filter').onclick = () => { currentOffset = 0; loadTable(); };
    qs('#fuel_filter_search').onkeydown = (e) => { if (e.key === 'Enter') { currentOffset = 0; loadTable(); } };
    qs('#btn_fuel_prev').onclick = () => { if (currentOffset >= limit) { currentOffset -= limit; loadTable(); } };
    qs('#btn_fuel_next').onclick = () => { currentOffset += limit; loadTable(); };

    // New Fuel Issue Modal
    qs('#btn_new_fuel_issue').onclick = async () => {
      let tanks = [];
      try { const r = await api('/fuel/tanks'); tanks = r.tanks || []; } catch (_) {}

      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal" style="max-width:520px;padding:24px">
          <h2 style="margin-top:0">⛽ Dispense & Record Fuel Issue</h2>
          <form id="form_fuel_issue" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:600">Vehicle / Machine Code *</label>
              <input type="text" id="fi_asset_code" required class="input" placeholder="e.g. PQ-8773, EX-01, SL-08" style="width:100%">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Litres Issued *</label>
                <input type="number" step="0.1" id="fi_litres" required class="input" placeholder="0.0" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Fuel Type</label>
                <select id="fi_fuel_type" class="input" style="width:100%">
                  <option value="AUTO_DIESEL">Auto Diesel</option>
                  <option value="SUPER_DIESEL">Super Diesel</option>
                  <option value="PETROL_92">Petrol 92</option>
                  <option value="PETROL_95">Petrol 95</option>
                  <option value="KEROSENE">Kerosene</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Current Meter Reading</label>
                <input type="number" step="0.1" id="fi_meter" class="input" placeholder="Hours or KM" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Meter Unit</label>
                <select id="fi_meter_type" class="input" style="width:100%">
                  <option value="HOURS">Hours (hrs)</option>
                  <option value="KM">Kilometres (km)</option>
                  <option value="NONE">None</option>
                </select>
              </div>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Source Storage Tank / Bowser</label>
              <select id="fi_source_tank" class="input" style="width:100%">
                <option value="">Direct Fuel Supply (No Tank Stock)</option>
                ${tanks.map(t => `<option value="${esc(t.id)}">${esc(t.name)} (Stock: ${Number(t.current_litres).toLocaleString()} L)</option>`).join('')}
              </select>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Driver / Operator Name</label>
                <input type="text" id="fi_driver" class="input" placeholder="Operator name" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Issue Date & Time</label>
                <input type="datetime-local" id="fi_date" class="input" style="width:100%">
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
              <button type="button" class="btn" id="btn_cancel_fi">Cancel</button>
              <button type="submit" class="btn primary" id="btn_save_fi">Save & Dispense</button>
            </div>
          </form>
        </div>
      `;

      document.body.appendChild(modal);

      // Set default datetime to now in local format
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      modal.querySelector('#fi_date').value = now.toISOString().slice(0, 16);

      modal.querySelector('#btn_cancel_fi').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelector('#form_fuel_issue').onsubmit = async (e) => {
        e.preventDefault();
        const assetCode = modal.querySelector('#fi_asset_code').value.trim();
        const litres = Number(modal.querySelector('#fi_litres').value);
        const fuelType = modal.querySelector('#fi_fuel_type').value;
        const meterReading = modal.querySelector('#fi_meter').value ? Number(modal.querySelector('#fi_meter').value) : null;
        const meterType = modal.querySelector('#fi_meter_type').value;
        const sourceTankId = modal.querySelector('#fi_source_tank').value || null;
        const driverName = modal.querySelector('#fi_driver').value.trim() || null;
        const issueDate = modal.querySelector('#fi_date').value ? modal.querySelector('#fi_date').value.replace('T', ' ') : null;

        const saveBtn = modal.querySelector('#btn_save_fi');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
          await api('/fuel/issues', {
            method: 'POST',
            body: { assetCode, litres, fuelType, meterReading, meterType, sourceTankId, driverName, issueDate }
          });
          toast(`Issued ${litres} L to ${assetCode} successfully!`);
          modal.remove();
          loadTable();
        } catch (err) {
          alert('Error recording fuel issue: ' + err.message);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & Dispense';
        }
      };
    };

    loadTable();
  }

  // Register on window.routes
  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel'] = renderFuelOperations;
  }
})();
