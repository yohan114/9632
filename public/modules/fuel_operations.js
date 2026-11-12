'use strict';

/**
 * WorkshopOne + Fuel-System-V2 Unified Fuel Operations Command Center (:1949)
 *
 * 6 Integrated Workspaces in #/fuel:
 *   1. ⛽ Fuel Issues Register (Source/Fuel filters, Live Meter Guard, Adjust/Void)
 *   2. 🔧 Fuel Adjustments / Corrections (4-Eyes workflow, Before->After diff, Stock/Cost delta)
 *   3. 🏗️ Site Fuel Operators Console (Site bowser dispensing, 14-day guard, Refuel delivery, Site fleet)
 *   4. 🗺️ Site Fuel Overview & Budgets (Site cards, 6-month sparklines, Budget vs Pace, Monthly Site Sheet)
 *   5. 🚗 Vehicle-Wise Fuel & Meter 360° View (Fleet directory + Single-vehicle 360° charts, meters, filters, rate card)
 *   6. 📩 Fuel Requests Queue (Requisition & 1-click Approve & Dispense)
 */

(function () {
  const FUEL_LABELS = {
    AUTO_DIESEL: 'Auto Diesel',
    SUPER_DIESEL: 'Super Diesel',
    PETROL_92: 'Petrol 92',
    PETROL_95: 'Petrol 95',
    KEROSENE: 'Kerosene',
  };

  function fmtLkr(val) {
    return 'Rs ' + Number(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtNum(val, dec = 1) {
    if (val === null || val === undefined || isNaN(Number(val))) return '—';
    return Number(val).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function verdictBadge(v) {
    const map = {
      OVER: '<span class="badge danger" style="background:#dc2626;color:#fff">🔴 OVER BAND (Repair Candidate)</span>',
      HEAVY: '<span class="badge warn" style="background:#d97706;color:#fff">🟠 HEAVY BURN</span>',
      NORMAL: '<span class="badge ok" style="background:#059669;color:#fff">🟢 NORMAL BAND</span>',
      BELOW_ECON: '<span class="badge" style="background:#2563eb;color:#fff">🔵 BELOW ECON (Check Meter)</span>',
      NO_METER: '<span class="badge" style="background:#64748b;color:#fff">⚪ NO METER SPAN</span>',
      NO_NORM: '<span class="badge" style="background:#94a3b8;color:#fff">⚪ NO BAND NORM</span>',
    };
    return map[v] || `<span class="badge">${esc(v || '—')}</span>`;
  }

  // Shared modal to submit a Fuel Issue Adjustment / Correction
  window.openFuelCorrectionModal = function (issue, onDone) {
    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    const curLitres = Number(issue.litres || 0);
    const curMeter = issue.meter_reading != null ? Number(issue.meter_reading) : '';
    const curDate = String(issue.issue_date || '').slice(0, 10);
    const curKind = issue.fuel_type || issue.fuel_kind || 'AUTO_DIESEL';

    modal.innerHTML = `
      <div class="modal" style="max-width:540px;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h2 style="margin:0;font-size:18px">✏️ Adjust / Correct Fuel Issue</h2>
          <span class="badge">${esc(issue.issue_no || issue.id)}</span>
        </div>
        <div class="card" style="padding:10px 12px;margin-bottom:14px;background:rgba(37,99,235,0.06);font-size:12px">
          <b>Vehicle:</b> ${esc(issue.asset_code || '—')} &nbsp;|&nbsp;
          <b>Current Litres:</b> ${curLitres} L &nbsp;|&nbsp;
          <b>Meter:</b> ${curMeter !== '' ? curMeter : '—'} &nbsp;|&nbsp;
          <b>Date:</b> ${esc(curDate)}
        </div>
        <form id="form_fuel_corr" style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:600">Adjustment Type *</label>
            <select id="fc_type" class="input" style="width:100%">
              <option value="EDIT">Full Edit (Litres / Meter / Date / Fuel Type)</option>
              <option value="LITRES">Litres Correction Only</option>
              <option value="METER">Meter Reading Correction Only</option>
              <option value="VOID">Request Void / Cancellation</option>
            </select>
          </div>
          <div id="fc_fields_wrap" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Corrected Litres</label>
              <input type="number" step="0.1" id="fc_litres" class="input" value="${curLitres}" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Corrected Meter Reading</label>
              <input type="number" step="0.1" id="fc_meter" class="input" value="${curMeter}" placeholder="Hours or KM" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Corrected Issue Date</label>
              <input type="date" id="fc_date" class="input" value="${esc(curDate)}" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Corrected Fuel Kind</label>
              <select id="fc_kind" class="input" style="width:100%">
                ${Object.entries(FUEL_LABELS).map(([k, lbl]) => `<option value="${k}" ${k === curKind ? 'selected' : ''}>${lbl}</option>`).join('')}
              </select>
            </div>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600">Documented Reason for Adjustment *</label>
            <textarea id="fc_reason" required rows="2" class="input" placeholder="Explain why this slip is being adjusted (e.g. typo on running chart, wrong meter digit)..." style="width:100%"></textarea>
          </div>
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="fc_auto_approve" checked>
            <span>Apply immediately if my account holds approval rights (Admin / Fuel Officer)</span>
          </label>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
            <button type="button" class="btn" id="btn_fc_cancel">Cancel</button>
            <button type="submit" class="btn primary" id="btn_fc_submit">Submit Adjustment</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    const typeSel = modal.querySelector('#fc_type');
    typeSel.onchange = () => {
      modal.querySelector('#fc_fields_wrap').style.display = typeSel.value === 'VOID' ? 'none' : 'grid';
    };
    modal.querySelector('#btn_fc_cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.querySelector('#form_fuel_corr').onsubmit = async (e) => {
      e.preventDefault();
      const btn = modal.querySelector('#btn_fc_submit');
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      try {
        const res = await api('/fuel/corrections', {
          method: 'POST',
          body: {
            fuelIssueId: issue.id,
            correctionType: typeSel.value,
            newLitres: modal.querySelector('#fc_litres').value ? Number(modal.querySelector('#fc_litres').value) : curLitres,
            newMeter: modal.querySelector('#fc_meter').value !== '' ? Number(modal.querySelector('#fc_meter').value) : null,
            newIssueDate: modal.querySelector('#fc_date').value || curDate,
            newFuelKind: modal.querySelector('#fc_kind').value || curKind,
            reason: modal.querySelector('#fc_reason').value.trim(),
            autoApprove: modal.querySelector('#fc_auto_approve').checked,
          },
        });
        toast(res.status === 'APPROVED' ? 'Fuel issue adjustment applied & stock updated!' : 'Fuel adjustment submitted for approval.');
        modal.remove();
        if (typeof onDone === 'function') onDone(res);
      } catch (err) {
        alert('Adjustment error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Submit Adjustment';
      }
    };
  };

  // Shared Issue Fuel Modal with Live Meter Guard
  window.openIssueFuelModal = async function (defaults = {}, onDone) {
    let tanks = [];
    let projects = [];
    try {
      const [tRes, pRes] = await Promise.all([
        api('/fuel/tanks').catch(() => ({ tanks: [] })),
        api('/projects').catch(() => []),
      ]);
      tanks = tRes.tanks || [];
      projects = Array.isArray(pRes) ? pRes : (pRes.projects || []);
    } catch (_) {}

    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:580px;padding:24px">
        <h2 style="margin-top:0;margin-bottom:4px">⛽ Dispense & Record Fuel Issue</h2>
        <p class="muted" style="margin:0 0 14px 0;font-size:12px">Includes Live Meter Guard, Bowser vs Station/Direct options, and automatic tank stock deduction</p>
        <form id="form_fuel_issue" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Vehicle / Machine Code or Reg *</label>
              <input type="text" id="fi_asset_code" required class="input" value="${esc(defaults.assetCode || '')}" placeholder="e.g. LB-22, EX-01, WP-CAB-1934" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Issue Source Option *</label>
              <select id="fi_source_mode" class="input" style="width:100%">
                <option value="BOWSER">Bulk Tank / Site Bowser</option>
                <option value="STATION">External Filling Station</option>
                <option value="DIRECT_BILLED">Direct Billed to Project</option>
              </select>
            </div>
          </div>

          <div id="fi_meter_guard_banner" style="display:none;padding:10px 12px;border-radius:8px;font-size:12px"></div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Litres Issued *</label>
              <input type="number" step="0.01" id="fi_litres" required class="input" placeholder="0.00" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Fuel Kind</label>
              <select id="fi_fuel_type" class="input" style="width:100%">
                <option value="AUTO_DIESEL">Auto Diesel</option>
                <option value="SUPER_DIESEL">Super Diesel</option>
                <option value="PETROL_92">Petrol 92</option>
                <option value="PETROL_95">Petrol 95</option>
                <option value="KEROSENE">Kerosene</option>
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Issue Date & Time</label>
              <input type="datetime-local" id="fi_date" class="input" style="width:100%">
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Current Meter Reading (KM / HRS)</label>
              <input type="number" step="0.1" id="fi_meter" class="input" placeholder="Enter odometer or hour-meter" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Meter Unit</label>
              <select id="fi_meter_type" class="input" style="width:100%">
                <option value="HOURS">Hours (HRS)</option>
                <option value="KM">Kilometres (KM)</option>
                <option value="NONE">No Meter / Broken</option>
              </select>
            </div>
          </div>

          <div id="fi_bowser_wrap" style="display:grid;grid-template-columns:1.2fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Source Storage Tank / Site Bowser</label>
              <select id="fi_source_tank" class="input" style="width:100%">
                <option value="">-- Select Tank / Bowser --</option>
                ${tanks.map((t) => `<option value="${esc(t.id)}" ${defaults.tankId === t.id ? 'selected' : ''}>${esc(t.name)} (${fmtNum(t.current_litres, 0)} L)</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Target Project / Site</label>
              <select id="fi_project_id" class="input" style="width:100%">
                <option value="">Auto from Tank / Vehicle</option>
                ${projects.map((p) => `<option value="${p.id}" ${Number(defaults.projectId) === Number(p.id) ? 'selected' : ''}>${esc(p.code ? p.code + ' · ' + p.name : p.name)}</option>`).join('')}
              </select>
            </div>
          </div>

          <div id="fi_station_wrap" style="display:none;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Filling Station / Supplier Name</label>
              <input type="text" id="fi_station_name" class="input" placeholder="e.g. Ceypetco Peliyagoda, IOC" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Receipt / Chit Number</label>
              <input type="text" id="fi_receipt_no" class="input" placeholder="Pump slip / invoice #" style="width:100%">
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Driver / Operator Name</label>
              <input type="text" id="fi_driver" class="input" placeholder="Operator or driver name" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Running Chart / Remarks</label>
              <input type="text" id="fi_remarks" class="input" placeholder="Running chart page / work note" style="width:100%">
            </div>
          </div>

          <label id="fi_override_wrap" style="display:none;font-size:12px;color:#b45309;align-items:center;gap:6px;cursor:pointer;background:rgba(245,158,11,0.1);padding:8px 10px;border-radius:6px">
            <input type="checkbox" id="fi_override_meter">
            <span><b>Override Meter Guard Warning:</b> Confirm this reading is physically verified on the machine</span>
          </label>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
            <button type="button" class="btn" id="btn_cancel_fi">Cancel</button>
            <button type="submit" class="btn primary" id="btn_save_fi">⛽ Save & Dispense Fuel</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    modal.querySelector('#fi_date').value = now.toISOString().slice(0, 16);

    const srcMode = modal.querySelector('#fi_source_mode');
    srcMode.onchange = () => {
      const isBowser = srcMode.value === 'BOWSER';
      modal.querySelector('#fi_bowser_wrap').style.display = isBowser ? 'grid' : 'grid';
      modal.querySelector('#fi_station_wrap').style.display = isBowser ? 'none' : 'grid';
      if (!isBowser) modal.querySelector('#fi_source_tank').value = '';
    };

    const banner = modal.querySelector('#fi_meter_guard_banner');
    const overrideWrap = modal.querySelector('#fi_override_wrap');
    let checkTimer = null;

    async function runLiveMeterCheck() {
      const code = modal.querySelector('#fi_asset_code').value.trim();
      const meter = modal.querySelector('#fi_meter').value;
      const date = modal.querySelector('#fi_date').value;
      if (!code) {
        banner.style.display = 'none';
        return;
      }
      try {
        const q = new URLSearchParams({ assetCode: code });
        if (meter !== '') q.set('meter', meter);
        if (date) q.set('date', date);
        const res = await api(`/fuel/meter-check?${q.toString()}`);
        banner.style.display = 'block';
        if (!res.found) {
          banner.style.background = 'rgba(239,68,68,0.1)';
          banner.style.border = '1px solid rgba(239,68,68,0.3)';
          banner.innerHTML = `⚠️ <b>Unrecognised Vehicle Code "${esc(code)}"</b> — will be logged as unlinked text unless corrected.`;
          return;
        }
        if (res.asset && res.asset.meter_type) {
          modal.querySelector('#fi_meter_type').value = res.asset.meter_type;
        }
        const prevTxt = res.previous
          ? `Last Meter: <b>${fmtNum(res.previous.reading, 1)} ${esc(res.asset.meter_type)}</b> (${esc(String(res.previous.date || '').slice(0, 10))})`
          : 'No prior meter reading on file';
        const deltaTxt = res.delta != null ? ` &nbsp;·&nbsp; Delta: <b>${res.delta >= 0 ? '+' : ''}${fmtNum(res.delta, 1)}</b>` : '';
        const bandTxt = res.consumptionBand && res.consumptionBand.typ
          ? ` &nbsp;·&nbsp; Norm Band: <b>${res.consumptionBand.econ || '—'} / ${res.consumptionBand.typ} / ${res.consumptionBand.heavy || '—'} ${res.consumptionBand.unit}</b>`
          : '';

        if (!res.ok && res.warning) {
          banner.style.background = 'rgba(220,38,38,0.12)';
          banner.style.border = '1px solid #dc2626';
          banner.innerHTML = `🛑 <b>METER GUARD ALERT:</b> ${esc(res.warning)}<br><span class="muted">${prevTxt}${deltaTxt}</span>`;
          overrideWrap.style.display = 'flex';
        } else if (res.warning) {
          banner.style.background = 'rgba(245,158,11,0.12)';
          banner.style.border = '1px solid #d97706';
          banner.innerHTML = `⚠️ <b>Meter Spike Notice:</b> ${esc(res.warning)}<br><span>✅ <b>${esc(res.asset.code)}</b> (${esc(res.asset.registration || res.asset.category || '')}) · ${prevTxt}${deltaTxt}${bandTxt}</span>`;
          overrideWrap.style.display = 'none';
        } else {
          banner.style.background = 'rgba(16,185,129,0.1)';
          banner.style.border = '1px solid rgba(16,185,129,0.35)';
          banner.innerHTML = `✅ <b>${esc(res.asset.code)}</b> (${esc(res.asset.registration || 'No Reg')} · ${esc(res.asset.category || '')}) &nbsp;|&nbsp; ${prevTxt}${deltaTxt}${bandTxt}`;
          overrideWrap.style.display = 'none';
        }
      } catch (_) {}
    }

    modal.querySelector('#fi_asset_code').oninput = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(runLiveMeterCheck, 220);
    };
    modal.querySelector('#fi_meter').oninput = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(runLiveMeterCheck, 220);
    };
    if (defaults.assetCode) runLiveMeterCheck();

    modal.querySelector('#btn_cancel_fi').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.querySelector('#form_fuel_issue').onsubmit = async (e) => {
      e.preventDefault();
      const saveBtn = modal.querySelector('#btn_save_fi');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      const sourceMode = srcMode.value;
      const sourceTankId = sourceMode === 'BOWSER' ? (modal.querySelector('#fi_source_tank').value || null) : null;
      const stationName = sourceMode !== 'BOWSER'
        ? (modal.querySelector('#fi_station_name').value.trim() || (sourceMode === 'DIRECT_BILLED' ? 'Direct Billed' : 'External Filling Station'))
        : null;

      try {
        const created = await api('/fuel/issues', {
          method: 'POST',
          body: {
            assetCode: modal.querySelector('#fi_asset_code').value.trim(),
            litres: Number(modal.querySelector('#fi_litres').value),
            fuelType: modal.querySelector('#fi_fuel_type').value,
            meterReading: modal.querySelector('#fi_meter').value !== '' ? Number(modal.querySelector('#fi_meter').value) : null,
            meterType: modal.querySelector('#fi_meter_type').value,
            sourceTankId,
            targetProjectId: modal.querySelector('#fi_project_id').value ? Number(modal.querySelector('#fi_project_id').value) : null,
            stationName,
            stationReceiptNo: modal.querySelector('#fi_receipt_no').value.trim() || null,
            driverName: modal.querySelector('#fi_driver').value.trim() || null,
            remarks: modal.querySelector('#fi_remarks').value.trim() || null,
            issueDate: modal.querySelector('#fi_date').value ? modal.querySelector('#fi_date').value.replace('T', ' ') : null,
            ignoreMeterWarning: modal.querySelector('#fi_override_meter').checked,
          },
        });
        toast(`Fuel issue recorded (${created.litres} L to ${created.asset_code})`);
        modal.remove();
        if (typeof onDone === 'function') onDone(created);
      } catch (err) {
        alert('Error recording fuel issue: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = '⛽ Save & Dispense Fuel';
      }
    };
  };

  // Main Fuel Operations Workspace
  async function renderFuelOperations(content) {
    const hashParts = (location.hash || '').split('?');
    const queryParams = new URLSearchParams(hashParts[1] || '');
    let activeTab = queryParams.get('tab') || 'issues';
    let selectedVehicleCode = queryParams.get('vehicle') || '';

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / Fuel System V2 Command Center</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:800">⛽ Fuel System Command Center</h1>
          <p class="muted" style="margin:4px 0 0 0">Issues Register, 4-Eyes Adjustments, Site Fuel Operators Console, Site Budgets, and Vehicle 360° Fuel & Meter Profiles</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="btn_top_issue_fuel">⛽ Issue Fuel</button>
          <a href="#/fuel-readings" class="btn">📟 Meter Readings</a>
          <a href="#/fuel-reports" class="btn">📊 Consumption Graphs & PM Plan</a>
          <a href="#/hire" class="btn">🏷️ Costing & Rate Cards</a>
        </div>
      </div>

      <!-- Top KPI Strip -->
      <div class="kpi-grid" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(185px, 1fr));gap:10px;margin-bottom:14px">
        <div class="card" style="padding:12px 14px">
          <div class="muted" style="font-size:11px;font-weight:700">PEAK / MONTH CONSUMPTION</div>
          <div style="font-size:20px;font-weight:800;margin-top:3px;color:var(--primary,#0066ff)" id="kpi_month_litres">... L</div>
          <div class="muted" style="font-size:11px" id="kpi_month_cost">Rs ...</div>
        </div>
        <div class="card" style="padding:12px 14px">
          <div class="muted" style="font-size:11px;font-weight:700">BULK TANK & BOWSER STOCK</div>
          <div style="font-size:20px;font-weight:800;margin-top:3px;color:#10b981" id="kpi_tank_stock">... L</div>
          <div class="muted" style="font-size:11px" id="kpi_tank_count">Across ... tanks</div>
        </div>
        <div class="card" style="padding:12px 14px;cursor:pointer" id="card_kpi_corrections">
          <div class="muted" style="font-size:11px;font-weight:700">PENDING ADJUSTMENTS</div>
          <div style="font-size:20px;font-weight:800;margin-top:3px;color:#d97706" id="kpi_pending_corr">0</div>
          <div class="muted" style="font-size:11px">Click to review corrections</div>
        </div>
        <div class="card" style="padding:12px 14px;cursor:pointer" id="card_kpi_requests">
          <div class="muted" style="font-size:11px;font-weight:700">FUEL REQUESTS QUEUE</div>
          <div style="font-size:20px;font-weight:800;margin-top:3px;color:#7c3aed" id="kpi_pending_req">0</div>
          <div class="muted" style="font-size:11px">Pending requisitions</div>
        </div>
        <div class="card" style="padding:12px 14px">
          <div class="muted" style="font-size:11px;font-weight:700">CEYPETCO AUTO DIESEL</div>
          <div style="font-size:20px;font-weight:800;margin-top:3px" id="kpi_diesel_rate">Rs ... / L</div>
          <div class="muted" style="font-size:11px"><a href="#/fuel-prices">Manage Fuel Tariffs →</a></div>
        </div>
      </div>

      <!-- 6-Tab Navigation Bar -->
      <div class="tabs" id="fuel_main_tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid var(--border);padding-bottom:8px">
        <button class="btn sm" data-tab="issues">⛽ Fuel Issues Register</button>
        <button class="btn sm" data-tab="corrections">🔧 Fuel Adjustments <span id="tab_badge_corr" class="badge warn" style="display:none;margin-left:4px">0</span></button>
        <button class="btn sm" data-tab="site-console">🏗️ Site Fuel Operators Console</button>
        <button class="btn sm" data-tab="sites-overview">🗺️ Site Fuel Overview & Budgets</button>
        <button class="btn sm" data-tab="vehicle-360">🚗 Vehicle-Wise Fuel & Meter 360°</button>
        <button class="btn sm" data-tab="requests">📩 Fuel Requests</button>
      </div>

      <div id="fuel_tab_container"></div>
    `;

    async function refreshKpis() {
      try {
        const stats = await api('/fuel/stats');
        if (qs('#kpi_month_litres')) qs('#kpi_month_litres').textContent = `${fmtNum(stats.month.total_litres, 1)} L`;
        if (qs('#kpi_month_cost')) qs('#kpi_month_cost').textContent = `${fmtLkr(Number(stats.month.total_cost_cents || 0) / 100)} (${stats.month.issues_count || 0} slips)`;
        if (qs('#kpi_tank_stock')) qs('#kpi_tank_stock').textContent = `${fmtNum(stats.tanks.total_stock_litres, 0)} L`;
        if (qs('#kpi_tank_count')) qs('#kpi_tank_count').textContent = `Across ${stats.tanks.total_tanks} active tanks/bowsers`;
        if (qs('#kpi_diesel_rate')) qs('#kpi_diesel_rate').textContent = `Rs ${(Number(stats.currentDieselCents || 34100) / 100).toFixed(2)} / L`;
        if (qs('#kpi_pending_corr')) qs('#kpi_pending_corr').textContent = String(stats.pendingCorrections || 0);
        if (qs('#kpi_pending_req')) qs('#kpi_pending_req').textContent = String(stats.pendingRequests || 0);
        const bCorr = qs('#tab_badge_corr');
        if (bCorr) {
          bCorr.textContent = String(stats.pendingCorrections || 0);
          bCorr.style.display = stats.pendingCorrections > 0 ? 'inline-block' : 'none';
        }
      } catch (_) {}
    }

    qs('#btn_top_issue_fuel').onclick = () => {
      window.openIssueFuelModal({ assetCode: selectedVehicleCode }, () => {
        refreshKpis();
        switchTab(activeTab);
      });
    };
    qs('#card_kpi_corrections').onclick = () => switchTab('corrections');
    qs('#card_kpi_requests').onclick = () => switchTab('requests');

    function switchTab(tabKey, extraVehicle) {
      activeTab = tabKey;
      if (extraVehicle !== undefined) selectedVehicleCode = extraVehicle;
      qsa('#fuel_main_tabs button').forEach((b) => {
        const isAct = b.getAttribute('data-tab') === tabKey;
        b.classList.toggle('primary', isAct);
      });
      const box = qs('#fuel_tab_container');
      if (!box) return;
      if (tabKey === 'issues') renderIssuesTab(box);
      else if (tabKey === 'corrections') renderCorrectionsTab(box);
      else if (tabKey === 'site-console') renderSiteConsoleTab(box);
      else if (tabKey === 'sites-overview') renderSitesOverviewTab(box);
      else if (tabKey === 'vehicle-360') renderVehicle360Tab(box, selectedVehicleCode);
      else if (tabKey === 'requests') renderRequestsTab(box);
    }

    qsa('#fuel_main_tabs button').forEach((b) => {
      b.onclick = () => switchTab(b.getAttribute('data-tab'));
    });

    // Expose quick vehicle profile opener globally
    window.openVehicleFuel360 = function (code) {
      switchTab('vehicle-360', code);
    };

    refreshKpis();
    switchTab(activeTab, selectedVehicleCode);

    // =========================================================================
    // TAB 1: FUEL ISSUES REGISTER
    // =========================================================================
    async function renderIssuesTab(box) {
      box.innerHTML = `
        <div class="card" style="padding:12px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="fi_search" placeholder="Search vehicle code, reg, slip #, driver..." class="input sm" style="flex:1;min-width:190px">
          <select id="fi_source_filter" class="input sm">
            <option value="">All Issue Sources</option>
            <option value="BOWSER">Bulk Tank / Site Bowser</option>
            <option value="STATION">Filling Station</option>
            <option value="DIRECT_BILLED">Direct Billed</option>
            <option value="MANUAL">Manual / External</option>
          </select>
          <select id="fi_fuel_filter" class="input sm">
            <option value="">All Fuel Kinds</option>
            <option value="AUTO_DIESEL">Auto Diesel</option>
            <option value="SUPER_DIESEL">Super Diesel</option>
            <option value="PETROL_92">Petrol 92</option>
            <option value="PETROL_95">Petrol 95</option>
            <option value="KEROSENE">Kerosene</option>
          </select>
          <select id="fi_tank_filter" class="input sm" style="max-width:190px">
            <option value="">All Tanks / Bowsers</option>
          </select>
          <input type="date" id="fi_from" class="input sm" title="From Date">
          <input type="date" id="fi_to" class="input sm" title="To Date">
          <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="checkbox" id="fi_voided"> Voided
          </label>
          <button class="btn sm primary" id="btn_fi_filter">Filter</button>
        </div>

        <div class="card" style="padding:0;overflow:hidden">
          <div style="overflow-x:auto">
            <table class="table" style="width:100%;margin:0;font-size:12.5px">
              <thead>
                <tr style="background:rgba(0,0,0,0.02)">
                  <th style="padding:10px 12px">Date</th>
                  <th style="padding:10px 12px">Slip #</th>
                  <th style="padding:10px 12px">Vehicle (360° Link)</th>
                  <th style="padding:10px 12px">Fuel Kind</th>
                  <th style="padding:10px 12px;text-align:right">Litres</th>
                  <th style="padding:10px 12px;text-align:right">Total Cost</th>
                  <th style="padding:10px 12px">Meter Reading</th>
                  <th style="padding:10px 12px">Source / Bowser</th>
                  <th style="padding:10px 12px">Site / Project</th>
                  <th style="padding:10px 12px">Driver</th>
                  <th style="padding:10px 12px;text-align:center">Options</th>
                </tr>
              </thead>
              <tbody id="fi_tbody">
                <tr><td colspan="11" style="padding:24px;text-align:center" class="muted">Loading fuel issues...</td></tr>
              </tbody>
            </table>
          </div>
          <div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border)">
            <div class="muted" style="font-size:12px" id="fi_page_info">Showing 0 of 0</div>
            <div style="display:flex;gap:6px">
              <button class="btn sm" id="btn_fi_prev" disabled>← Prev</button>
              <button class="btn sm" id="btn_fi_next" disabled>Next →</button>
            </div>
          </div>
        </div>
      `;

      let offset = 0;
      const limit = 50;
      let currentRows = [];

      api('/fuel/tanks').then(({ tanks }) => {
        const sel = qs('#fi_tank_filter', box);
        if (sel && tanks) {
          tanks.forEach((t) => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = `${t.name} (${fmtNum(t.current_litres, 0)}L)`;
            sel.appendChild(opt);
          });
        }
      }).catch(() => {});

      async function loadIssues() {
        const params = new URLSearchParams({ limit, offset });
        const s = qs('#fi_search', box).value.trim();
        const src = qs('#fi_source_filter', box).value;
        const fk = qs('#fi_fuel_filter', box).value;
        const tk = qs('#fi_tank_filter', box).value;
        const fr = qs('#fi_from', box).value;
        const to = qs('#fi_to', box).value;
        const vd = qs('#fi_voided', box).checked;

        if (s) params.set('search', s);
        if (src) params.set('sourceType', src);
        if (fk) params.set('fuelType', fk);
        if (tk) params.set('tankId', tk);
        if (fr) params.set('fromDate', fr);
        if (to) params.set('toDate', to);
        if (vd) params.set('showVoided', 'true');

        const tbody = qs('#fi_tbody', box);
        tbody.innerHTML = '<tr><td colspan="11" style="padding:20px;text-align:center" class="muted">Loading...</td></tr>';

        try {
          const res = await api(`/fuel/issues?${params.toString()}`);
          currentRows = res.rows || [];
          if (!currentRows.length) {
            tbody.innerHTML = '<tr><td colspan="11" style="padding:24px;text-align:center" class="muted">No matching fuel issues found.</td></tr>';
            qs('#fi_page_info', box).textContent = '0 records';
            return;
          }

          tbody.innerHTML = currentRows.map((r, idx) => {
            const isVoid = r.is_voided === 1;
            const corrBadge = r.correction_status === 'PENDING'
              ? '<span class="badge warn" style="font-size:10px;margin-left:4px">⏳ PENDING ADJ</span>'
              : (r.correction_status === 'APPROVED' ? '<span class="badge ok" style="font-size:10px;margin-left:4px">✓ ADJUSTED</span>' : '');
            const srcBadge = r.source_tank_id || r.bulk_tank_id
              ? `<span class="badge" style="background:rgba(16,185,129,0.12);color:#047857">🛢️ ${esc(r.tank_name || 'Bowser')}</span>`
              : `<span class="badge" style="background:rgba(59,130,246,0.12);color:#1d4ed8">⛽ ${esc(r.station_name || r.source_type || 'External')}</span>`;

            return `
              <tr style="${isVoid ? 'opacity:0.55;background:rgba(239,68,68,0.05)' : ''}">
                <td style="padding:9px 12px;white-space:nowrap">${esc(String(r.issue_date || '').slice(0, 16))}</td>
                <td style="padding:9px 12px;font-family:monospace;font-size:11.5px">${esc(r.issue_no || r.id.slice(0, 10))}</td>
                <td style="padding:9px 12px">
                  <a href="javascript:void(0)" class="btn-veh-360" data-code="${esc(r.asset_code)}" style="font-weight:700;color:var(--primary,#0066ff);text-decoration:underline">${esc(r.asset_code)}</a>
                  ${isVoid ? '<span class="badge danger" style="margin-left:4px">VOID</span>' : ''}
                  ${corrBadge}
                </td>
                <td style="padding:9px 12px">${esc(FUEL_LABELS[r.fuel_type] || r.fuel_type || 'Auto Diesel')}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:800">${fmtNum(r.litres, 1)} L</td>
                <td style="padding:9px 12px;text-align:right;font-weight:600">${fmtLkr(Number(r.total_cost_cents || r.cost_cents || 0) / 100)}</td>
                <td style="padding:9px 12px">${r.meter_reading ? `<b>${fmtNum(r.meter_reading, 1)}</b> <span class="muted" style="font-size:11px">${esc(r.meter_type || 'HRS')}</span>` : '<span class="muted">—</span>'}</td>
                <td style="padding:9px 12px">${srcBadge}</td>
                <td style="padding:9px 12px">${esc(r.target_project_name || '—')}</td>
                <td style="padding:9px 12px">${esc(r.driver_name || '—')}</td>
                <td style="padding:9px 12px;text-align:center;white-space:nowrap">
                  ${!isVoid ? `<button class="btn sm btn-adj-issue" data-idx="${idx}" title="Adjust / Correct Litres, Meter or Date">✏️ Adjust</button>` : ''}
                  ${!isVoid ? `<button class="btn sm danger btn-void-issue" data-id="${esc(r.id)}" data-no="${esc(r.issue_no || r.id)}" style="margin-left:4px">Void</button>` : ''}
                </td>
              </tr>
            `;
          }).join('');

          qs('#fi_page_info', box).textContent = `Showing ${offset + 1}–${Math.min(offset + currentRows.length, res.total)} of ${res.total.toLocaleString()} fuel issues`;
          qs('#btn_fi_prev', box).disabled = offset === 0;
          qs('#btn_fi_next', box).disabled = offset + limit >= res.total;

          qsa('.btn-veh-360', tbody).forEach((a) => {
            a.onclick = () => switchTab('vehicle-360', a.getAttribute('data-code'));
          });
          qsa('.btn-adj-issue', tbody).forEach((btn) => {
            btn.onclick = () => {
              const row = currentRows[Number(btn.getAttribute('data-idx'))];
              if (row) window.openFuelCorrectionModal(row, () => { loadIssues(); refreshKpis(); });
            };
          });
          qsa('.btn-void-issue', tbody).forEach((btn) => {
            btn.onclick = async () => {
              const id = btn.getAttribute('data-id');
              const no = btn.getAttribute('data-no');
              const reason = prompt(`Enter documented reason to VOID fuel issue ${no}:\n(Tank stock will be automatically restored)`);
              if (!reason || !reason.trim()) return;
              try {
                await api(`/fuel/issues/${id}/void`, { method: 'POST', body: { reason: reason.trim() } });
                toast('Fuel issue voided and tank stock restored.');
                loadIssues();
                refreshKpis();
              } catch (e) {
                alert('Void error: ' + e.message);
              }
            };
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="11" style="padding:24px;text-align:center" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#btn_fi_filter', box).onclick = () => { offset = 0; loadIssues(); };
      qs('#fi_search', box).onkeydown = (e) => { if (e.key === 'Enter') { offset = 0; loadIssues(); } };
      qs('#btn_fi_prev', box).onclick = () => { if (offset >= limit) { offset -= limit; loadIssues(); } };
      qs('#btn_fi_next', box).onclick = () => { offset += limit; loadIssues(); };

      loadIssues();
    }

    // =========================================================================
    // TAB 2: FUEL ISSUE ADJUSTMENTS / CORRECTIONS WORKFLOW
    // =========================================================================
    async function renderCorrectionsTab(box) {
      box.innerHTML = `
        <div class="card" style="padding:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="corr_status_pills">
            <button class="btn sm primary" data-status="ALL">All Adjustments</button>
            <button class="btn sm" data-status="PENDING">⏳ Pending Approval</button>
            <button class="btn sm" data-status="APPROVED">✅ Approved & Applied</button>
            <button class="btn sm" data-status="REJECTED">❌ Rejected</button>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="corr_search" placeholder="Search vehicle code or reason..." class="input sm" style="min-width:220px">
            <button class="btn sm" id="btn_corr_refresh">🔄 Refresh</button>
          </div>
        </div>

        <div class="card" style="padding:0;overflow:hidden">
          <div style="overflow-x:auto">
            <table class="table" style="width:100%;margin:0;font-size:12.5px">
              <thead>
                <tr style="background:rgba(0,0,0,0.02)">
                  <th style="padding:10px 12px">Requested</th>
                  <th style="padding:10px 12px">Vehicle / Site</th>
                  <th style="padding:10px 12px">Type</th>
                  <th style="padding:10px 12px">Litres (Before → After)</th>
                  <th style="padding:10px 12px">Meter (Before → After)</th>
                  <th style="padding:10px 12px">Stock / Cost Delta</th>
                  <th style="padding:10px 12px">Reason & Audit</th>
                  <th style="padding:10px 12px">Status</th>
                  <th style="padding:10px 12px;text-align:center">Review Action</th>
                </tr>
              </thead>
              <tbody id="corr_tbody">
                <tr><td colspan="9" style="padding:24px;text-align:center" class="muted">Loading adjustments...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      let curStatus = 'ALL';

      async function loadCorrections() {
        const search = qs('#corr_search', box).value.trim();
        const tbody = qs('#corr_tbody', box);
        try {
          const res = await api(`/fuel/corrections?status=${encodeURIComponent(curStatus)}&search=${encodeURIComponent(search)}`);
          const rows = res.rows || [];
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center" class="muted">No fuel adjustments in this view. Click "✏️ Adjust" on any row in the Fuel Issues Register to create one.</td></tr>';
            return;
          }

          tbody.innerHTML = rows.map((c) => {
            const deltaL = Number(c.after_litres || 0) - Number(c.before_litres || 0);
            const deltaColor = deltaL > 0 ? '#dc2626' : (deltaL < 0 ? '#059669' : '#64748b');
            const stBadge = c.status === 'APPROVED'
              ? '<span class="badge ok">APPROVED</span>'
              : (c.status === 'REJECTED' ? '<span class="badge danger">REJECTED</span>' : '<span class="badge warn">PENDING</span>');

            return `
              <tr>
                <td style="padding:10px 12px;white-space:nowrap">${esc(String(c.requested_at || '').slice(0, 16))}</td>
                <td style="padding:10px 12px">
                  <a href="javascript:void(0)" class="btn-corr-veh" data-code="${esc(c.asset_code || '')}" style="font-weight:700">${esc(c.asset_code || '—')}</a>
                  <div class="muted" style="font-size:11px">${esc(c.project_name || c.tank_name || 'Central')}</div>
                </td>
                <td style="padding:10px 12px"><span class="badge">${esc(c.correction_type || 'EDIT')}</span></td>
                <td style="padding:10px 12px;font-weight:700">
                  ${fmtNum(c.before_litres, 1)} L → <span style="color:var(--primary,#0066ff)">${fmtNum(c.after_litres, 1)} L</span>
                </td>
                <td style="padding:10px 12px">
                  ${c.before_meter != null ? fmtNum(c.before_meter, 1) : '—'} → <b>${c.after_meter != null ? fmtNum(c.after_meter, 1) : '—'}</b>
                </td>
                <td style="padding:10px 12px;color:${deltaColor};font-weight:700">
                  ${deltaL >= 0 ? '+' : ''}${fmtNum(deltaL, 1)} L
                </td>
                <td style="padding:10px 12px;max-width:260px">
                  <div>${esc(c.reason || '—')}</div>
                  <div class="muted" style="font-size:11px">By: ${esc(c.requester_name || 'Operator')}${c.approver_name ? ` · Reviewed by ${esc(c.approver_name)}` : ''}</div>
                </td>
                <td style="padding:10px 12px">${stBadge}</td>
                <td style="padding:10px 12px;text-align:center;white-space:nowrap">
                  ${c.status === 'PENDING' ? `
                    <button class="btn sm primary btn-corr-act" data-id="${esc(c.id)}" data-act="APPROVE">✅ Approve</button>
                    <button class="btn sm danger btn-corr-act" data-id="${esc(c.id)}" data-act="REJECT" style="margin-left:4px">❌ Reject</button>
                  ` : `<span class="muted" style="font-size:11px">${esc(String(c.approved_at || '').slice(0, 10))}</span>`}
                </td>
              </tr>
            `;
          }).join('');

          qsa('.btn-corr-veh', tbody).forEach((a) => {
            a.onclick = () => { if (a.getAttribute('data-code')) switchTab('vehicle-360', a.getAttribute('data-code')); };
          });
          qsa('.btn-corr-act', tbody).forEach((btn) => {
            btn.onclick = async () => {
              const id = btn.getAttribute('data-id');
              const act = btn.getAttribute('data-act');
              const note = act === 'REJECT' ? prompt('Reason for rejecting this fuel adjustment?') : 'Approved & applied';
              if (act === 'REJECT' && !note) return;
              try {
                await api(`/fuel/corrections/${id}/review`, {
                  method: 'POST',
                  body: { action: act, reviewNote: note },
                });
                toast(`Adjustment ${act === 'APPROVE' ? 'approved and applied to tank stock & ledger' : 'rejected'}.`);
                loadCorrections();
                refreshKpis();
              } catch (err) {
                alert('Review error: ' + err.message);
              }
            };
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="9" style="padding:24px;text-align:center" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      qsa('#corr_status_pills button', box).forEach((b) => {
        b.onclick = () => {
          curStatus = b.getAttribute('data-status');
          qsa('#corr_status_pills button', box).forEach((x) => x.classList.toggle('primary', x === b));
          loadCorrections();
        };
      });
      qs('#btn_corr_refresh', box).onclick = loadCorrections;
      qs('#corr_search', box).onkeydown = (e) => { if (e.key === 'Enter') loadCorrections(); };

      loadCorrections();
    }

    // =========================================================================
    // TAB 3: SITE FUEL OPERATORS CONSOLE
    // =========================================================================
    async function renderSiteConsoleTab(box) {
      box.innerHTML = `<div class="card" style="padding:24px;text-align:center" class="muted">Loading Site Fuel Operator Console...</div>`;
      let selectedTankId = '';
      let selectedProjectId = '';

      async function loadConsole() {
        try {
          const q = new URLSearchParams();
          if (selectedTankId) q.set('tankId', selectedTankId);
          if (selectedProjectId) q.set('projectId', selectedProjectId);
          const data = await api(`/fuel/site-console?${q.toString()}`);
          const activeTank = data.activeTank;
          const activeProj = data.activeProject;
          const hideStock = !!data.hideStock;

          const stockPct = activeTank && activeTank.capacity_litres > 0
            ? Math.min(100, Math.round((activeTank.current_litres / activeTank.capacity_litres) * 100))
            : 0;

          box.innerHTML = `
            <!-- Site & Bowser Selector Bar -->
            <div class="card" style="padding:14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;background:linear-gradient(90deg, rgba(16,185,129,0.08), rgba(37,99,235,0.05))">
              <div>
                <div style="font-size:11px;font-weight:700;color:#047857;text-transform:uppercase">🏗️ Active Site Bowser / Bulk Tank Console</div>
                <div style="font-size:18px;font-weight:800;margin-top:2px">
                  ${activeTank ? `${esc(activeTank.name)} (${esc(activeTank.code)})` : 'Select a Bulk Tank'}
                  ${activeProj ? ` · <span style="color:var(--primary,#0066ff)">${esc(activeProj.name)}</span>` : ''}
                </div>
              </div>
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                <select id="sc_tank_select" class="input sm" style="min-width:240px">
                  ${(data.allTanks || []).map((t) => `<option value="${esc(t.id)}" ${activeTank && activeTank.id === t.id ? 'selected' : ''}>🛢️ ${esc(t.name)} (${esc(t.project_name || t.code)})</option>`).join('')}
                </select>
                ${!hideStock && activeTank ? `
                  <div class="card" style="padding:6px 12px;margin:0;background:#fff;border:1px solid #10b981">
                    <span class="muted" style="font-size:11px">Current Tank Stock:</span>
                    <b style="font-size:15px;color:#047857;margin-left:6px">${fmtNum(activeTank.current_litres, 1)} L</b>
                    <span class="muted" style="font-size:11px"> / ${fmtNum(activeTank.capacity_litres, 0)} L (${stockPct}%)</span>
                  </div>
                ` : (hideStock ? `<span class="badge warn">🔒 Tank Stock Hidden by Admin Policy</span>` : '')}
              </div>
            </div>

            <!-- Two-Column Operator Action Forms: Dispense Fuel & Receive Tank Delivery -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:14px;margin-bottom:16px">
              <!-- 1. Dispense Site Fuel -->
              <div class="card" style="padding:16px">
                <h3 style="margin:0 0 10px 0;font-size:15px">⛽ 1. Dispense Fuel from ${esc(activeTank ? activeTank.name : 'Site Bowser')}</h3>
                <form id="sc_form_issue" style="display:flex;flex-direction:column;gap:10px">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                    <div>
                      <label style="font-size:11px;font-weight:600">Vehicle Code / Reg *</label>
                      <input type="text" id="sc_asset" required list="sc_veh_list" class="input sm" placeholder="e.g. LB-22, EX-04" style="width:100%">
                      <datalist id="sc_veh_list">
                        ${(data.siteVehicles || []).map((v) => `<option value="${esc(v.code)}">${esc(v.registration || '')} · ${esc(v.category || '')}</option>`).join('')}
                      </datalist>
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:600">Litres Issued *</label>
                      <input type="number" step="0.1" id="sc_litres" required class="input sm" placeholder="0.0" style="width:100%">
                    </div>
                  </div>
                  <div id="sc_meter_preview" style="display:none;padding:6px 10px;border-radius:6px;font-size:11.5px"></div>
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                    <div>
                      <label style="font-size:11px;font-weight:600">Meter Reading</label>
                      <input type="number" step="0.1" id="sc_meter" class="input sm" placeholder="KM / HRS" style="width:100%">
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:600">Driver / Operator</label>
                      <input type="text" id="sc_driver" class="input sm" placeholder="Operator" style="width:100%">
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:600">Date (14d Max Backdate)</label>
                      <input type="date" id="sc_date" class="input sm" value="${new Date().toISOString().slice(0, 10)}" style="width:100%">
                    </div>
                  </div>
                  <button type="submit" class="btn primary sm" style="align-self:flex-start">⛽ Record Site Bowser Issue</button>
                </form>
              </div>

              <!-- 2. Log Bulk Tank Refuel Delivery -->
              <div class="card" style="padding:16px">
                <h3 style="margin:0 0 10px 0;font-size:15px">🚛 2. Receive Bulk Fuel Delivery into Tank</h3>
                <form id="sc_form_refuel" style="display:flex;flex-direction:column;gap:10px">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                    <div>
                      <label style="font-size:11px;font-weight:600">Litres Delivered *</label>
                      <input type="number" step="1" id="sc_del_litres" required class="input sm" placeholder="e.g. 6600" style="width:100%">
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:600">Price / L (Rs)</label>
                      <input type="number" step="0.01" id="sc_del_price" class="input sm" value="341.00" style="width:100%">
                    </div>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                    <div>
                      <label style="font-size:11px;font-weight:600">Supplier / Ceypetco</label>
                      <input type="text" id="sc_del_sup" class="input sm" value="Ceypetco Bulk" style="width:100%">
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:600">Invoice / Bowser No</label>
                      <input type="text" id="sc_del_inv" class="input sm" placeholder="INV-..." style="width:100%">
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:600">Delivery Date</label>
                      <input type="date" id="sc_del_date" class="input sm" value="${new Date().toISOString().slice(0, 10)}" style="width:100%">
                    </div>
                  </div>
                  <button type="submit" class="btn sm" style="align-self:flex-start;background:#059669;color:#fff;border-color:#059669">📥 Log Tank Delivery & Add Stock</button>
                </form>
              </div>
            </div>

            <!-- Assigned Site Fleet + Recent Site Issues -->
            <div style="display:grid;grid-template-columns:1fr 1.6fr;gap:14px">
              <div class="card" style="padding:14px">
                <h3 style="margin:0 0 8px 0;font-size:14px">🚜 Vehicles Assigned to Site (${(data.siteVehicles || []).length})</h3>
                <div style="max-height:360px;overflow-y:auto">
                  <table class="table" style="width:100%;font-size:12px">
                    <thead>
                      <tr><th>Code</th><th>Reg</th><th>Category</th><th>Hours/KM</th><th></th></tr>
                    </thead>
                    <tbody>
                      ${(data.siteVehicles || []).length ? data.siteVehicles.map((v) => `
                        <tr>
                          <td><a href="javascript:void(0)" class="sc-veh-360" data-code="${esc(v.code)}" style="font-weight:700">${esc(v.code)}</a></td>
                          <td>${esc(v.registration || '—')}</td>
                          <td>${esc(v.category || '—')}</td>
                          <td>${v.current_hours ? fmtNum(v.current_hours, 0) : '—'}</td>
                          <td><button class="btn sm sc-quick-pick" data-code="${esc(v.code)}" style="padding:2px 6px;font-size:11px">Select</button></td>
                        </tr>
                      `).join('') : '<tr><td colspan="5" class="muted" style="text-align:center;padding:16px">No vehicles currently allocated to this site</td></tr>'}
                    </tbody>
                  </table>
                </div>
              </div>

              <div class="card" style="padding:14px">
                <h3 style="margin:0 0 8px 0;font-size:14px">📋 Recent Site Bowser Issues (${(data.recentIssues || []).length})</h3>
                <div style="max-height:360px;overflow-y:auto">
                  <table class="table" style="width:100%;font-size:12px">
                    <thead>
                      <tr><th>Date</th><th>Vehicle</th><th style="text-align:right">Litres</th><th>Meter</th><th>Driver</th><th></th></tr>
                    </thead>
                    <tbody>
                      ${(data.recentIssues || []).length ? data.recentIssues.map((r, idx) => `
                        <tr>
                          <td>${esc(String(r.issue_date || '').slice(0, 10))}</td>
                          <td><a href="javascript:void(0)" class="sc-veh-360" data-code="${esc(r.asset_code)}" style="font-weight:700">${esc(r.asset_code)}</a></td>
                          <td style="text-align:right;font-weight:700">${fmtNum(r.litres, 1)} L</td>
                          <td>${r.meter_reading ? fmtNum(r.meter_reading, 1) : '—'}</td>
                          <td>${esc(r.driver_name || '—')}</td>
                          <td><button class="btn sm sc-adj-btn" data-idx="${idx}" style="padding:2px 6px;font-size:11px">✏️ Adjust</button></td>
                        </tr>
                      `).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">No recent issues recorded on this tank</td></tr>'}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          `;

          qs('#sc_tank_select', box).onchange = (e) => {
            selectedTankId = e.target.value;
            loadConsole();
          };

          qsa('.sc-quick-pick', box).forEach((b) => {
            b.onclick = () => {
              const inp = qs('#sc_asset', box);
              inp.value = b.getAttribute('data-code');
              inp.dispatchEvent(new Event('input'));
              qs('#sc_litres', box).focus();
            };
          });
          qsa('.sc-veh-360', box).forEach((a) => {
            a.onclick = () => switchTab('vehicle-360', a.getAttribute('data-code'));
          });
          qsa('.sc-adj-btn', box).forEach((b) => {
            b.onclick = () => {
              const row = (data.recentIssues || [])[Number(b.getAttribute('data-idx'))];
              if (row) window.openFuelCorrectionModal(row, () => loadConsole());
            };
          });

          // Live meter check inside Site Console
          const scAsset = qs('#sc_asset', box);
          const scMeter = qs('#sc_meter', box);
          const scPrev = qs('#sc_meter_preview', box);
          async function checkSiteMeter() {
            const c = scAsset.value.trim();
            if (!c) { scPrev.style.display = 'none'; return; }
            try {
              const res = await api(`/fuel/meter-check?assetCode=${encodeURIComponent(c)}&meter=${encodeURIComponent(scMeter.value)}`);
              scPrev.style.display = 'block';
              if (!res.found) {
                scPrev.style.background = 'rgba(239,68,68,0.1)';
                scPrev.innerHTML = `⚠️ Vehicle "${esc(c)}" not found in master register`;
              } else if (!res.ok) {
                scPrev.style.background = 'rgba(220,38,38,0.15)';
                scPrev.innerHTML = `🛑 ${esc(res.warning)}`;
              } else {
                scPrev.style.background = 'rgba(16,185,129,0.1)';
                scPrev.innerHTML = `✅ <b>${esc(res.asset.code)}</b> (${esc(res.asset.registration || res.asset.category || '')}) · Previous Meter: <b>${res.previous ? fmtNum(res.previous.reading, 1) : 'None'}</b>${res.delta != null ? ` · Delta: <b>+${fmtNum(res.delta, 1)}</b>` : ''}`;
              }
            } catch (_) {}
          }
          scAsset.oninput = checkSiteMeter;
          scMeter.oninput = checkSiteMeter;

          qs('#sc_form_issue', box).onsubmit = async (e) => {
            e.preventDefault();
            try {
              await api('/fuel/site-console/issue', {
                method: 'POST',
                body: {
                  assetCode: scAsset.value.trim(),
                  litres: Number(qs('#sc_litres', box).value),
                  meterReading: scMeter.value !== '' ? Number(scMeter.value) : null,
                  driverName: qs('#sc_driver', box).value.trim() || null,
                  issueDate: qs('#sc_date', box).value,
                  sourceTankId: activeTank ? activeTank.id : null,
                  targetProjectId: activeProj ? activeProj.id : (activeTank ? activeTank.project_id : null),
                },
              });
              toast('Site fuel issue recorded & deducted from bowser!');
              loadConsole();
              refreshKpis();
            } catch (err) {
              alert('Site issue error: ' + err.message);
            }
          };

          qs('#sc_form_refuel', box).onsubmit = async (e) => {
            e.preventDefault();
            if (!activeTank) return alert('Select a tank first');
            try {
              await api('/fuel/site-console/refuel', {
                method: 'POST',
                body: {
                  tankId: activeTank.id,
                  litresDelivered: Number(qs('#sc_del_litres', box).value),
                  pricePerLitreCents: Math.round(Number(qs('#sc_del_price', box).value || 341) * 100),
                  supplierName: qs('#sc_del_sup', box).value.trim(),
                  invoiceNo: qs('#sc_del_inv', box).value.trim(),
                  deliveryDate: qs('#sc_del_date', box).value,
                },
              });
              toast('Tank delivery logged & stock incremented!');
              loadConsole();
              refreshKpis();
            } catch (err) {
              alert('Delivery error: ' + err.message);
            }
          };
        } catch (err) {
          box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
        }
      }

      loadConsole();
    }

    // =========================================================================
    // TAB 4: SITE FUEL OVERVIEW, SPARKLINES & BUDGETS
    // =========================================================================
    async function renderSitesOverviewTab(box) {
      let curMonth = '2026-08';

      async function loadOverview() {
        box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Site Fuel Overview & Budgets...</div>`;
        try {
          const data = await api(`/fuel/sites-overview?month=${encodeURIComponent(curMonth)}`);
          const cards = data.cards || [];

          box.innerHTML = `
            <div class="card" style="padding:12px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
              <div>
                <h3 style="margin:0;font-size:16px">🗺️ Site-Wise Fuel Consumption, 6-Month Sparklines & Monthly Litre Budgets</h3>
                <div class="muted" style="font-size:12px">Total for ${esc(data.month)}: <b>${fmtNum(data.totals.litres, 1)} L</b> (${fmtLkr(data.totals.costLkr)}) across ${cards.length} active sites</div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <label style="font-size:12px;font-weight:600">Period Month:</label>
                <input type="month" id="so_month" class="input sm" value="${esc(data.month)}">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(330px, 1fr));gap:14px">
              ${cards.map((c) => {
                const maxSpark = Math.max(1, ...(c.sparkline || []).map((s) => s.litres || 0));
                const sparkBars = (c.sparkline || []).map((s) => {
                  const h = Math.max(4, Math.round(((s.litres || 0) / maxSpark) * 38));
                  const isCur = s.month === data.month;
                  return `<div title="${s.month}: ${fmtNum(s.litres, 0)} L" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
                    <div style="width:100%;height:40px;display:flex;align-items:flex-end;background:rgba(0,0,0,0.03);border-radius:3px;padding:0 2px">
                      <div style="width:100%;height:${h}px;background:${isCur ? '#2563eb' : '#94a3b8'};border-radius:2px"></div>
                    </div>
                    <span style="font-size:9px;color:#64748b">${esc(s.month.slice(5))}</span>
                  </div>`;
                }).join('');

                const pct = c.budgetPct != null ? Math.min(100, c.budgetPct) : 0;
                const barColor = c.paceVerdict === 'OVER' ? '#dc2626' : (c.paceVerdict === 'NEAR' ? '#d97706' : '#10b981');

                return `
                  <div class="card" style="padding:16px;display:flex;flex-direction:column;justify-content:space-between;gap:10px">
                    <div>
                      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
                        <div>
                          <div style="font-weight:800;font-size:15px">${esc(c.project_name)}</div>
                          <div class="muted" style="font-size:11px">${esc(c.project_code || 'SITE')} · ${c.vehicles} vehicles · ${c.issues} slips</div>
                        </div>
                        <button class="btn sm btn-edit-budget" data-pid="${c.project_id}" data-name="${esc(c.project_name)}" data-bud="${c.budgetLitres || ''}" style="font-size:11px;padding:3px 8px">🎯 Budget</button>
                      </div>

                      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;padding:8px 10px;background:rgba(0,0,0,0.02);border-radius:6px">
                        <div>
                          <div class="muted" style="font-size:10px">MONTH LITRES</div>
                          <div style="font-size:17px;font-weight:800;color:var(--primary,#0066ff)">${fmtNum(c.litres, 1)} L</div>
                        </div>
                        <div>
                          <div class="muted" style="font-size:10px">MONTH COST</div>
                          <div style="font-size:15px;font-weight:700">${fmtLkr(c.costLkr)}</div>
                        </div>
                      </div>

                      <!-- Budget Progress Bar -->
                      <div style="margin-top:10px">
                        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
                          <span>Budget: <b>${c.budgetLitres ? fmtNum(c.budgetLitres, 0) + ' L' : 'Not set'}</b></span>
                          ${c.budgetPct != null ? `<b style="color:${barColor}">${c.budgetPct}% (${c.paceVerdict})</b>` : ''}
                        </div>
                        <div style="width:100%;height:7px;background:rgba(0,0,0,0.08);border-radius:4px;overflow:hidden">
                          <div style="width:${pct}%;height:100%;background:${barColor}"></div>
                        </div>
                      </div>

                      <!-- 6-Month Sparkline -->
                      <div style="margin-top:10px">
                        <div class="muted" style="font-size:10px;margin-bottom:4px">6-MONTH CONSUMPTION TREND</div>
                        <div style="display:flex;gap:4px;align-items:flex-end">${sparkBars}</div>
                      </div>
                    </div>

                    <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid var(--border);font-size:11px">
                      <span class="muted">Bowser: ${fmtNum(c.bowserLitres, 0)}L · Ext: ${fmtNum(c.externalLitres, 0)}L</span>
                      <button class="btn sm primary btn-site-sheet" data-pid="${c.project_id}">📄 Monthly Sheet</button>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `;

          qs('#so_month', box).onchange = (e) => {
            curMonth = e.target.value;
            loadOverview();
          };

          qsa('.btn-edit-budget', box).forEach((b) => {
            b.onclick = async () => {
              const pid = Number(b.getAttribute('data-pid'));
              const name = b.getAttribute('data-name');
              const cur = b.getAttribute('data-bud');
              const val = prompt(`Set monthly diesel budget (Litres) for "${name}" in ${curMonth}:`, cur || '5000');
              if (val === null) return;
              const [y, m] = curMonth.split('-').map(Number);
              try {
                await api('/fuel/budgets', {
                  method: 'POST',
                  body: { projectId: pid, year: y, month: m, budgetLitres: Number(val) },
                });
                toast(`Updated monthly fuel budget for ${name}`);
                loadOverview();
              } catch (err) {
                alert('Budget error: ' + err.message);
              }
            };
          });

          qsa('.btn-site-sheet', box).forEach((b) => {
            b.onclick = () => openSiteMonthlySheetModal(b.getAttribute('data-pid'), curMonth);
          });
        } catch (err) {
          box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
        }
      }

      async function openSiteMonthlySheetModal(projectId, month) {
        const res = await api(`/fuel/sites-overview/${projectId}?month=${encodeURIComponent(month)}`);
        const modal = document.createElement('div');
        modal.className = 'modal-bg modal-backdrop';
        modal.innerHTML = `
          <div class="modal" style="max-width:920px;width:95%;max-height:88vh;overflow-y:auto;padding:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
              <div>
                <h2 style="margin:0">📄 Site Monthly Fuel Sheet — ${esc(res.project.name)} (${esc(res.month)})</h2>
                <div class="muted" style="font-size:12px">Total Litres: <b>${fmtNum(res.totals.litres, 1)} L</b> · Total Cost: <b>${fmtLkr(res.totals.costLkr)}</b> · ${res.totals.issues} slips across ${res.totals.vehicles} vehicles</div>
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn sm" onclick="window.print()">🖨️ Print Sheet</button>
                <button class="btn sm" id="btn_close_ss">✕ Close</button>
              </div>
            </div>

            <h3 style="font-size:14px;margin:12px 0 6px 0">1. Vehicle-Wise Summary at ${esc(res.project.name)}</h3>
            <table class="table" style="width:100%;font-size:12px;margin-bottom:16px">
              <thead>
                <tr><th>Vehicle</th><th>Reg</th><th>Category</th><th style="text-align:right">Fills</th><th style="text-align:right">Litres</th><th style="text-align:right">Cost</th><th>Meter Span</th><th>Measured Rate</th></tr>
              </thead>
              <tbody>
                ${(res.vehicles || []).map((v) => `
                  <tr>
                    <td><b>${esc(v.code)}</b></td>
                    <td>${esc(v.registration || '—')}</td>
                    <td>${esc(v.category || '—')}</td>
                    <td style="text-align:right">${v.fills}</td>
                    <td style="text-align:right;font-weight:700">${fmtNum(v.litres, 1)} L</td>
                    <td style="text-align:right">${fmtLkr(v.costLkr)}</td>
                    <td>${v.meterSpan > 0 ? `${fmtNum(v.minMeter, 0)} → ${fmtNum(v.maxMeter, 0)} (+${fmtNum(v.meterSpan, 1)})` : '—'}</td>
                    <td>${v.measuredRate != null ? `<b>${fmtNum(v.measuredRate, 2)} ${v.unit}</b>` : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>

            <h3 style="font-size:14px;margin:12px 0 6px 0">2. Chronological Site Fuel Issue Ledger (${(res.issues || []).length} slips)</h3>
            <div style="max-height:300px;overflow-y:auto">
              <table class="table" style="width:100%;font-size:12px">
                <thead>
                  <tr><th>Date</th><th>Slip #</th><th>Vehicle</th><th style="text-align:right">Litres</th><th style="text-align:right">Cost</th><th>Meter</th><th>Tank / Source</th><th>Driver</th></tr>
                </thead>
                <tbody>
                  ${(res.issues || []).map((i) => `
                    <tr>
                      <td>${esc(String(i.issue_date || '').slice(0, 10))}</td>
                      <td>${esc(i.issue_no || i.id.slice(0, 8))}</td>
                      <td><b>${esc(i.asset_code)}</b></td>
                      <td style="text-align:right;font-weight:700">${fmtNum(i.litres, 1)} L</td>
                      <td style="text-align:right">${fmtLkr(Number(i.total_cost_cents || i.cost_cents || 0) / 100)}</td>
                      <td>${i.meter_reading ? fmtNum(i.meter_reading, 1) : '—'}</td>
                      <td>${esc(i.tank_name || i.station_name || 'Direct')}</td>
                      <td>${esc(i.driver_name || '—')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#btn_close_ss').onclick = () => modal.remove();
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      }

      loadOverview();
    }

    // =========================================================================
    // TAB 5: VEHICLE-WISE FUEL & METER 360° VIEW
    // =========================================================================
    async function renderVehicle360Tab(box, initialCode) {
      box.innerHTML = `
        <div class="card" style="padding:12px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input type="text" id="v360_search" value="${esc(initialCode || '')}" placeholder="Type vehicle code or registration (e.g. LB-22, EX-01, WP-CAB-1934)..." class="input sm" style="flex:1;min-width:240px">
          <select id="v360_cat" class="input sm">
            <option value="">All Categories</option>
          </select>
          <button class="btn sm primary" id="btn_v360_open">🔍 Open 360° Vehicle Profile</button>
          <button class="btn sm" id="btn_v360_dir">📋 Show All Fleet Fuel Directory</button>
        </div>
        <div id="v360_body"></div>
      `;

      const body = qs('#v360_body', box);

      async function loadDirectory() {
        const q = qs('#v360_search', box).value.trim();
        const cat = qs('#v360_cat', box).value;
        body.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Fleet Fuel & Meter Directory...</div>`;
        try {
          const res = await api(`/fuel/fleet-directory?search=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`);
          const catSel = qs('#v360_cat', box);
          if (catSel && catSel.options.length <= 1 && res.categories) {
            res.categories.forEach((c) => {
              const o = document.createElement('option');
              o.value = c;
              o.textContent = c;
              catSel.appendChild(o);
            });
          }

          body.innerHTML = `
            <div class="card" style="padding:0;overflow:hidden">
              <div style="overflow-x:auto">
                <table class="table" style="width:100%;margin:0;font-size:12.5px">
                  <thead>
                    <tr style="background:rgba(0,0,0,0.02)">
                      <th style="padding:10px 12px">Vehicle Code</th>
                      <th style="padding:10px 12px">Registration</th>
                      <th style="padding:10px 12px">Category</th>
                      <th style="padding:10px 12px">Current Site</th>
                      <th style="padding:10px 12px;text-align:right">Total Issues</th>
                      <th style="padding:10px 12px;text-align:right">Total Litres</th>
                      <th style="padding:10px 12px;text-align:right">Total Fuel Cost</th>
                      <th style="padding:10px 12px">Latest Meter</th>
                      <th style="padding:10px 12px">Standard Norm Band</th>
                      <th style="padding:10px 12px;text-align:center">360° Profile</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${(res.vehicles || []).map((v) => {
                      const basis = v.fuel_cons_basis || 'hr';
                      const unit = basis === 'km' ? 'km/L' : 'L/hr';
                      const typ = v.fuel_cons_typ ? (basis === 'km' ? (1 / v.fuel_cons_typ).toFixed(1) : Number(v.fuel_cons_typ).toFixed(1)) : null;
                      return `
                        <tr>
                          <td style="padding:9px 12px"><b style="color:var(--primary,#0066ff)">${esc(v.code)}</b></td>
                          <td style="padding:9px 12px">${esc(v.registration || '—')}</td>
                          <td style="padding:9px 12px">${esc(v.category || '—')}</td>
                          <td style="padding:9px 12px">${esc(v.current_site || 'Central')}</td>
                          <td style="padding:9px 12px;text-align:right">${v.issue_count || 0}</td>
                          <td style="padding:9px 12px;text-align:right;font-weight:700">${fmtNum(v.total_litres, 1)} L</td>
                          <td style="padding:9px 12px;text-align:right">${fmtLkr(v.total_cost)}</td>
                          <td style="padding:9px 12px">${v.max_meter || v.current_hours ? fmtNum(v.max_meter || v.current_hours, 1) : '—'}</td>
                          <td style="padding:9px 12px">${typ ? `Typ: <b>${typ} ${unit}</b>` : '<span class="muted">—</span>'}</td>
                          <td style="padding:9px 12px;text-align:center">
                            <button class="btn sm primary btn-open-360" data-code="${esc(v.code)}">🔍 360° View</button>
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `;

          qsa('.btn-open-360', body).forEach((b) => {
            b.onclick = () => loadSingleProfile(b.getAttribute('data-code'));
          });
        } catch (err) {
          body.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
        }
      }

      async function loadSingleProfile(code) {
        qs('#v360_search', box).value = code;
        body.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading 360° Fuel & Meter Profile for ${esc(code)}...</div>`;
        try {
          const p = await api(`/fuel/vehicle-profile/${encodeURIComponent(code)}`);
          const a = p.asset;
          const st = p.stats;
          const cb = p.consumptionBand;
          const sv = p.serviceStatus;

          // Build SVG Meter Progression Line Chart
          const meterPts = (p.meterReadings || []).filter((m) => m.reading > 0).slice(0, 30).reverse();
          let meterSvg = '<div class="muted" style="padding:20px;text-align:center">Insufficient meter points for chart</div>';
          if (meterPts.length >= 2) {
            const minM = Math.min(...meterPts.map((m) => m.reading));
            const maxM = Math.max(...meterPts.map((m) => m.reading));
            const spanM = Math.max(1, maxM - minM);
            const w = 440, h = 130, pad = 22;
            const coords = meterPts.map((m, i) => {
              const x = pad + (i / (meterPts.length - 1)) * (w - pad * 2);
              const y = h - pad - ((m.reading - minM) / spanM) * (h - pad * 2);
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            });
            meterSvg = `
              <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:140px;background:rgba(37,99,235,0.03);border-radius:8px">
                <polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="${coords.join(' ')}" />
                ${meterPts.map((m, i) => {
                  const x = pad + (i / (meterPts.length - 1)) * (w - pad * 2);
                  const y = h - pad - ((m.reading - minM) / spanM) * (h - pad * 2);
                  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#1d4ed8"><title>${m.date}: ${m.reading} ${a.meter_type}</title></circle>`;
                }).join('')}
                <text x="${pad}" y="14" font-size="10" fill="#64748b">Min: ${fmtNum(minM, 0)} ${a.meter_type}</text>
                <text x="${w - pad}" y="14" font-size="10" fill="#1d4ed8" text-anchor="end">Latest: ${fmtNum(maxM, 0)} ${a.meter_type}</text>
              </svg>
            `;
          }

          // Build Fill-to-Fill Consumption vs Band Bar Chart
          const segs = (p.fillSeries || []).slice(-18);
          let fillSvg = '<div class="muted" style="padding:20px;text-align:center">Requires 2+ consecutive metered fills</div>';
          if (segs.length > 0) {
            const maxRate = Math.max(cb.heavy || 10, ...segs.map((s) => s.displayRate || 0), 1);
            fillSvg = `
              <div style="display:flex;align-items:flex-end;gap:6px;height:140px;padding:12px 8px;background:rgba(0,0,0,0.02);border-radius:8px">
                ${segs.map((s) => {
                  const bh = Math.max(8, Math.min(110, Math.round(((s.displayRate || 0) / maxRate) * 110)));
                  const col = s.verdict === 'OVER' ? '#dc2626' : (s.verdict === 'HEAVY' ? '#d97706' : '#10b981');
                  return `<div title="${s.date}: ${s.displayRate} ${cb.unit} (${s.litres}L over +${s.deltaMeter} ${a.meter_type})" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
                    <span style="font-size:9px;font-weight:700;color:${col}">${s.displayRate}</span>
                    <div style="width:100%;max-width:22px;height:${bh}px;background:${col};border-radius:3px 3px 0 0"></div>
                    <span style="font-size:8.5px;color:#64748b">${esc(s.date.slice(5))}</span>
                  </div>`;
                }).join('')}
              </div>
            `;
          }

          body.innerHTML = `
            <!-- Vehicle 360 Header Banner -->
            <div class="card" style="padding:16px;margin-bottom:14px;background:linear-gradient(90deg, rgba(37,99,235,0.07), rgba(16,185,129,0.06))">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
                <div>
                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <h2 style="margin:0;font-size:22px;font-weight:800">${esc(a.code)}</h2>
                    <span class="badge">${esc(a.registration || 'No Plate')}</span>
                    <span class="badge">${esc(a.category || a.type || 'Machine')}</span>
                    ${verdictBadge(cb.verdict)}
                  </div>
                  <div class="muted" style="font-size:12px;margin-top:4px">
                    Site: <b>${esc(a.current_site || p.allocation?.project_name || 'Central Workshop')}</b> &nbsp;·&nbsp;
                    Meter Unit: <b>${esc(a.meter_type)}</b> &nbsp;·&nbsp;
                    Standard Band: <b>Econ ${cb.econ ?? '—'} / Typ ${cb.typ ?? '—'} / Heavy ${cb.heavy ?? '—'} ${cb.unit}</b>
                  </div>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn sm primary" id="btn_360_issue">⛽ Issue Fuel to ${esc(a.code)}</button>
                  <button class="btn sm" id="btn_360_back">← All Vehicles</button>
                </div>
              </div>

              <!-- 6 KPI Tiles for Vehicle -->
              <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:10px;margin-top:14px">
                <div class="card" style="padding:10px;margin:0">
                  <div class="muted" style="font-size:10px">TOTAL FUEL ISSUED</div>
                  <div style="font-size:18px;font-weight:800;color:var(--primary,#0066ff)">${fmtNum(st.totalLitres, 1)} L</div>
                  <div class="muted" style="font-size:10px">${st.totalIssues} fuel slips</div>
                </div>
                <div class="card" style="padding:10px;margin:0">
                  <div class="muted" style="font-size:10px">TOTAL FUEL COST</div>
                  <div style="font-size:17px;font-weight:800">${fmtLkr(st.totalCostLkr)}</div>
                  <div class="muted" style="font-size:10px">All-time diesel/petrol</div>
                </div>
                <div class="card" style="padding:10px;margin:0">
                  <div class="muted" style="font-size:10px">MEASURED BURN RATE</div>
                  <div style="font-size:18px;font-weight:800">${cb.measuredDisplay != null ? `${cb.measuredDisplay} ${cb.unit}` : 'No Span'}</div>
                  <div class="muted" style="font-size:10px">Typ Norm: ${cb.typ ?? '—'} ${cb.unit}</div>
                </div>
                <div class="card" style="padding:10px;margin:0">
                  <div class="muted" style="font-size:10px">RECORDED METER SPAN</div>
                  <div style="font-size:17px;font-weight:800">${fmtNum(st.recordedSpan, 1)} ${a.meter_type}</div>
                  <div class="muted" style="font-size:10px">${st.firstMeter ? `${fmtNum(st.firstMeter, 0)} → ${fmtNum(st.latestMeter, 0)}` : 'No meter logged'}</div>
                </div>
                <div class="card" style="padding:10px;margin:0">
                  <div class="muted" style="font-size:10px">FUEL-DERIVED RUNNING</div>
                  <div style="font-size:17px;font-weight:800;color:#7c3aed">${st.recommendedRunning != null ? `${fmtNum(st.recommendedRunning, 0)} ${a.meter_type}` : '—'}</div>
                  <div class="muted" style="font-size:10px">Variance: ${st.meterVariance != null ? `${st.meterVariance >= 0 ? '+' : ''}${fmtNum(st.meterVariance, 0)}` : '—'}</div>
                </div>
                <div class="card" style="padding:10px;margin:0">
                  <div class="muted" style="font-size:10px">DUAL-BASIS PM SERVICE</div>
                  <div style="font-size:15px;font-weight:800;color:${sv.status === 'OVERDUE' ? '#dc2626' : (sv.status === 'DUE_SOON' ? '#d97706' : '#059669')}">
                    ${sv.status} (${sv.remaining >= 0 ? `${fmtNum(sv.remaining, 0)} rem` : `${fmtNum(Math.abs(sv.remaining), 0)} over`})
                  </div>
                  <div class="muted" style="font-size:10px">Basis: ${sv.governingBasis} (${fmtNum(sv.usedSinceService, 0)}/${sv.interval})</div>
                </div>
              </div>
            </div>

            <!-- Charts Row: Meter Progression + Fill-to-Fill Burn vs Band -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(380px, 1fr));gap:14px;margin-bottom:14px">
              <div class="card" style="padding:14px">
                <h3 style="margin:0 0 8px 0;font-size:14px">📈 Meter Reading Progression (${esc(a.meter_type)})</h3>
                ${meterSvg}
              </div>
              <div class="card" style="padding:14px">
                <h3 style="margin:0 0 8px 0;font-size:14px">📊 Fill-to-Fill Consumption vs Standard Band (${esc(cb.unit)})</h3>
                ${fillSvg}
              </div>
            </div>

            <!-- Service & Fitted Filters + Fuel Issues + Meter Readings -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
              <div class="card" style="padding:14px">
                <h3 style="margin:0 0 8px 0;font-size:14px">🛠️ Fitted Filters, Lubricants & PM Tasks</h3>
                <div style="font-size:12px">
                  <div style="margin-bottom:8px"><b>Fitted Filters (${(p.fittedFilters || []).length}):</b>
                    ${(p.fittedFilters || []).length ? p.fittedFilters.map((f) => `<span class="badge" style="margin:2px">${esc(f.filter_type)}: ${esc(f.part_number)} (x${f.qty || 1})</span>`).join(' ') : '<span class="muted">None recorded</span>'}
                  </div>
                  <div style="margin-bottom:8px"><b>Lubricant Capacities (${(p.lubricants || []).length}):</b>
                    ${(p.lubricants || []).length ? p.lubricants.map((l) => `<span class="badge" style="margin:2px">${esc(l.compartment || l.oil_grade || 'Sump')}: ${esc(l.capacity_litres || l.engine_oil_l || '')}L</span>`).join(' ') : '<span class="muted">Standard OEM</span>'}
                  </div>
                  <div><b>PM Checklist Tasks (${(p.pmTasks || []).length}):</b>
                    ${(p.pmTasks || []).slice(0, 6).map((t) => `<div class="muted">• ${esc(t.task_name || t.description || '')} (${esc(t.interval_hours || t.interval_km || '')})</div>`).join('')}
                  </div>
                </div>
              </div>

              <div class="card" style="padding:14px">
                <h3 style="margin:0 0 8px 0;font-size:14px">📟 Unified Meter Readings Ledger (${(p.meterReadings || []).length})</h3>
                <div style="max-height:220px;overflow-y:auto">
                  <table class="table" style="width:100%;font-size:12px">
                    <thead><tr><th>Date</th><th>Reading</th><th>Unit</th><th>Source</th><th>Remarks</th></tr></thead>
                    <tbody>
                      ${(p.meterReadings || []).slice(0, 40).map((m) => `
                        <tr>
                          <td>${esc(String(m.date || '').slice(0, 10))}</td>
                          <td style="font-weight:700">${fmtNum(m.reading, 1)}</td>
                          <td>${esc(m.unit || a.meter_type)}</td>
                          <td><span class="badge">${esc(m.source)}</span></td>
                          <td>${esc(m.remarks || '—')}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <!-- Vehicle Fuel Issues Table -->
            <div class="card" style="padding:14px">
              <h3 style="margin:0 0 8px 0;font-size:14px">⛽ Complete Vehicle Fuel Issues Ledger (${(p.issues || []).length})</h3>
              <div style="max-height:360px;overflow-y:auto">
                <table class="table" style="width:100%;font-size:12px">
                  <thead>
                    <tr><th>Date</th><th>Slip #</th><th style="text-align:right">Litres</th><th style="text-align:right">Cost</th><th>Meter</th><th>Tank / Source</th><th>Site</th><th>Driver</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    ${(p.issues || []).map((r, idx) => `
                      <tr style="${r.is_voided ? 'opacity:0.5' : ''}">
                        <td>${esc(String(r.issue_date || '').slice(0, 16))}</td>
                        <td>${esc(r.issue_no || r.id.slice(0, 8))}</td>
                        <td style="text-align:right;font-weight:700">${fmtNum(r.litres, 1)} L</td>
                        <td style="text-align:right">${fmtLkr(Number(r.total_cost_cents || r.cost_cents || 0) / 100)}</td>
                        <td>${r.meter_reading ? fmtNum(r.meter_reading, 1) : '—'}</td>
                        <td>${esc(r.tank_name || r.station_name || 'Direct')}</td>
                        <td>${esc(r.project_name || '—')}</td>
                        <td>${esc(r.driver_name || '—')}</td>
                        <td>${!r.is_voided ? `<button class="btn sm btn-v360-adj" data-idx="${idx}">✏️ Adjust</button>` : 'VOID'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `;

          qs('#btn_360_back', body).onclick = () => loadDirectory();
          qs('#btn_360_issue', body).onclick = () => {
            window.openIssueFuelModal({ assetCode: a.code }, () => loadSingleProfile(a.code));
          };
          qsa('.btn-v360-adj', body).forEach((b) => {
            b.onclick = () => {
              const row = (p.issues || [])[Number(b.getAttribute('data-idx'))];
              if (row) window.openFuelCorrectionModal(row, () => loadSingleProfile(a.code));
            };
          });
        } catch (err) {
          body.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
        }
      }

      qs('#btn_v360_open', box).onclick = () => {
        const c = qs('#v360_search', box).value.trim();
        if (c) loadSingleProfile(c);
        else loadDirectory();
      };
      qs('#btn_v360_dir', box).onclick = () => {
        qs('#v360_search', box).value = '';
        loadDirectory();
      };
      qs('#v360_cat', box).onchange = loadDirectory;
      qs('#v360_search', box).onkeydown = (e) => {
        if (e.key === 'Enter') {
          const c = qs('#v360_search', box).value.trim();
          if (c) loadSingleProfile(c);
          else loadDirectory();
        }
      };

      if (initialCode) loadSingleProfile(initialCode);
      else loadDirectory();
    }

    // =========================================================================
    // TAB 6: FUEL REQUESTS QUEUE
    // =========================================================================
    async function renderRequestsTab(box) {
      box.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:14px">
          <div class="card" style="padding:16px">
            <h3 style="margin:0 0 10px 0;font-size:15px">📩 Raise Fuel Requisition</h3>
            <form id="form_fuel_req" style="display:flex;flex-direction:column;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Vehicle Code *</label>
                <input type="text" id="fr_code" required class="input sm" placeholder="e.g. LB-22, EX-01" style="width:100%">
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div>
                  <label style="font-size:12px;font-weight:600">Requested Litres *</label>
                  <input type="number" step="1" id="fr_litres" required class="input sm" placeholder="50" style="width:100%">
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Current Meter</label>
                  <input type="number" step="0.1" id="fr_meter" class="input sm" placeholder="KM / HRS" style="width:100%">
                </div>
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Work Purpose / Site Note</label>
                <input type="text" id="fr_reason" class="input sm" placeholder="Site excavation / transport duty" style="width:100%">
              </div>
              <button type="submit" class="btn primary sm">Submit Fuel Request</button>
            </form>
          </div>

          <div class="card" style="padding:16px">
            <h3 style="margin:0 0 10px 0;font-size:15px">📋 Fuel Requisitions Queue</h3>
            <table class="table" style="width:100%;font-size:12.5px">
              <thead>
                <tr><th>Req #</th><th>Date</th><th>Vehicle</th><th style="text-align:right">Litres</th><th>Meter</th><th>Reason</th><th>Status</th><th>Action</th></tr>
              </thead>
              <tbody id="fr_tbody">
                <tr><td colspan="8" class="muted" style="text-align:center;padding:20px">Loading requests...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      async function loadReqs() {
        const tbody = qs('#fr_tbody', box);
        try {
          const { requests } = await api('/fuel/requests');
          if (!requests || !requests.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">No fuel requests in queue.</td></tr>';
            return;
          }
          tbody.innerHTML = requests.map((r) => `
            <tr>
              <td style="font-family:monospace;font-size:11px">${esc(r.request_no || r.id.slice(0, 8))}</td>
              <td>${esc(String(r.requested_at || '').slice(0, 10))}</td>
              <td><b>${esc(r.asset_code)}</b></td>
              <td style="text-align:right;font-weight:700">${fmtNum(r.requested_litres, 1)} L</td>
              <td>${r.meter_reading ? fmtNum(r.meter_reading, 1) : '—'}</td>
              <td>${esc(r.reason || '—')}</td>
              <td><span class="badge ${r.status === 'APPROVED' ? 'ok' : (r.status === 'REJECTED' ? 'danger' : 'warn')}">${esc(r.status)}</span></td>
              <td>
                ${r.status === 'PENDING' ? `
                  <button class="btn sm primary btn-fr-act" data-id="${esc(r.id)}" data-act="APPROVE">✅ Approve & Issue</button>
                  <button class="btn sm danger btn-fr-act" data-id="${esc(r.id)}" data-act="REJECT">✕</button>
                ` : '—'}
              </td>
            </tr>
          `).join('');

          qsa('.btn-fr-act', tbody).forEach((b) => {
            b.onclick = async () => {
              const id = b.getAttribute('data-id');
              const act = b.getAttribute('data-act');
              try {
                await api(`/fuel/requests/${id}/review`, {
                  method: 'POST',
                  body: { action: act, dispenseNow: act === 'APPROVE' },
                });
                toast(act === 'APPROVE' ? 'Request approved and fuel dispensed!' : 'Request rejected.');
                loadReqs();
                refreshKpis();
              } catch (err) {
                alert(err.message);
              }
            };
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="8" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#form_fuel_req', box).onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/fuel/requests', {
            method: 'POST',
            body: {
              assetCode: qs('#fr_code', box).value.trim(),
              requestedLitres: Number(qs('#fr_litres', box).value),
              meterReading: qs('#fr_meter', box).value !== '' ? Number(qs('#fr_meter', box).value) : null,
              reason: qs('#fr_reason', box).value.trim(),
            },
          });
          toast('Fuel request submitted!');
          qs('#form_fuel_req', box).reset();
          loadReqs();
          refreshKpis();
        } catch (err) {
          alert(err.message);
        }
      };

      loadReqs();
    }
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel'] = renderFuelOperations;
  }
})();
