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
  function notify(msg, kind = 'err') {
    if (typeof toast === 'function') toast(msg, kind);
    else console[kind === 'err' ? 'error' : 'log'](msg);
  }

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

  function localTodayStr() {
    if (typeof slToday === 'function') return slToday();
    return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function effectiveFuelRateCents(row) {
    if (!row) return 0;
    const direct = Number(row.effective_price_cents || row.fuel_price_cents || row.price_per_litre_cents || 0);
    if (direct > 0) return direct;
    if (row.unit_price && Number(row.unit_price) > 0) return Math.round(Number(row.unit_price) * 100);
    const litres = Number(row.litres || 0);
    const costCents = Number(row.total_cost_cents || row.cost_cents || (row.total_price ? Number(row.total_price) * 100 : 0) || 0);
    if (litres > 0 && costCents > 0) return Math.round(costCents / litres);
    return 0;
  }

  function fmtRateRs(cents) {
    const n = Number(cents || 0);
    if (n <= 0) return '—';
    return 'Rs ' + (n / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '/L';
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

  function vehBadge(r, opts) {
    if (typeof window.fmtVehicleBadge === 'function') return window.fmtVehicleBadge(r, opts);
    return `<b>${esc((r && (r.asset_display || r.asset_code || r.code)) || '—')}</b>`;
  }

  function vehText(r) {
    if (typeof window.fmtVehicleText === 'function') return window.fmtVehicleText(r);
    return (r && (r.asset_display || r.asset_code || r.code)) || '—';
  }

  function canApproveFuelReq(r) {
    if (typeof isAdmin === 'function' && isAdmin()) return true;
    const overOk = typeof canDo === 'function' && canDo('fuel.approve_request', 'fuel.approve');
    if (r && r.exceeds_norm) return overOk;
    return overOk || (typeof canDo === 'function' && canDo('fuel.approve_site_request'));
  }

  // Shared modal to submit a Fuel Issue Adjustment / Correction
  window.openFuelCorrectionModal = function (issue, onDone) {
    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    const curLitres = Number(issue.litres || 0);
    const curMeter = issue.meter_reading != null ? Number(issue.meter_reading) : '';
    const curDate = String(issue.issue_date || '').slice(0, 10);
    const curKind = issue.fuel_type || issue.fuel_kind || 'AUTO_DIESEL';
    const curRateCents = effectiveFuelRateCents(issue);
    const curRateRs = curRateCents > 0 ? (curRateCents / 100).toFixed(2) : '';
    const canAutoApprove = typeof isAdmin === 'function' && isAdmin();

    modal.innerHTML = `
      <div class="modal" style="max-width:560px;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h2 style="margin:0;font-size:18px">${canAutoApprove ? '✏️ Adjust / Correct Fuel Issue' : '📩 Request Issue Change to Admin'}</h2>
          <span class="badge">${esc(issue.issue_no || issue.id)}</span>
        </div>
        <div class="card" style="padding:10px 12px;margin-bottom:14px;background:rgba(37,99,235,0.06);font-size:12px">
          <b>Vehicle (E&amp;C · Reg):</b> ${vehBadge(issue)} &nbsp;|&nbsp;
          <b>Current Litres:</b> ${curLitres} L &nbsp;|&nbsp;
          <b>Rate:</b> ${fmtRateRs(curRateCents)} &nbsp;|&nbsp;
          <b>Meter:</b> ${curMeter !== '' ? curMeter : '—'} &nbsp;|&nbsp;
          <b>Date:</b> ${esc(curDate)}
        </div>
        <form id="form_fuel_corr" style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:600">Adjustment Type *</label>
            <select id="fc_type" class="input" style="width:100%">
              <option value="EDIT">Full Edit (Litres / Rate / Meter / Date / Fuel Type)</option>
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
              <label style="font-size:12px;font-weight:600">Corrected Fuel Rate (Rs/L)</label>
              <input type="number" step="0.01" min="0" id="fc_price_rs" class="input" value="${curRateRs}" placeholder="Auto by date tariff" style="width:100%">
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
            <div style="display:flex;flex-direction:column;justify-content:flex-end">
              <div class="muted" style="font-size:11px;margin-bottom:4px">Projected Total Cost</div>
              <div id="fc_cost_preview" style="padding:7px 10px;border-radius:6px;background:rgba(15,23,42,0.04);font-weight:700;font-size:13px">—</div>
            </div>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600">Documented Reason for Change Request *</label>
            <textarea id="fc_reason" required rows="2" class="input" placeholder="Explain why this slip needs changing (e.g. typo on running chart, wrong meter digit, duplicate entry)..." style="width:100%"></textarea>
          </div>
          ${canAutoApprove ? `
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="fc_auto_approve" checked>
            <span>Apply immediately (Administrator privilege)</span>
          </label>` : `
          <div style="padding:8px 10px;border-radius:6px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.35);font-size:12px;color:#92400e">
            🛡️ <b>Admin Approval Required:</b> This request will be sent to an Administrator for review before any issue record or tank stock is changed.
          </div>`}
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
            <button type="button" class="btn" id="btn_fc_cancel">Cancel</button>
            <button type="submit" class="btn primary" id="btn_fc_submit">${canAutoApprove ? 'Submit Adjustment' : '📩 Send Change Request to Admin'}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    const typeSel = modal.querySelector('#fc_type');
    const fcLitresInp = modal.querySelector('#fc_litres');
    const fcPriceInp = modal.querySelector('#fc_price_rs');
    const fcDateInp = modal.querySelector('#fc_date');
    const fcKindSel = modal.querySelector('#fc_kind');
    const fcCostPrev = modal.querySelector('#fc_cost_preview');
    let fcPriceEdited = false;

    function updateFcCostPreview() {
      const l = Number(fcLitresInp.value || 0);
      const r = Number(fcPriceInp.value || 0);
      fcCostPrev.textContent = (l > 0 && r > 0) ? fmtLkr(l * r) : '—';
    }
    updateFcCostPreview();

    async function refreshFcTariff() {
      if (fcPriceEdited) return;
      try {
        const q = new URLSearchParams({ fuelType: fcKindSel.value || curKind });
        if (fcDateInp.value) q.set('date', fcDateInp.value);
        const res = await api(`/fuel/prices/lookup?${q.toString()}`);
        if (!fcPriceEdited && res && res.pricePerLitreCents > 0) {
          fcPriceInp.value = (res.pricePerLitreCents / 100).toFixed(2);
          updateFcCostPreview();
        }
      } catch (_) {}
    }

    fcLitresInp.oninput = updateFcCostPreview;
    fcPriceInp.oninput = () => { fcPriceEdited = true; updateFcCostPreview(); };
    fcKindSel.onchange = refreshFcTariff;
    fcDateInp.onchange = refreshFcTariff;

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
        const rawRate = fcPriceInp.value.trim();
        const autoBox = modal.querySelector('#fc_auto_approve');
        const res = await api('/fuel/corrections', {
          method: 'POST',
          body: {
            fuelIssueId: issue.id,
            correctionType: typeSel.value,
            newLitres: fcLitresInp.value ? Number(fcLitresInp.value) : curLitres,
            newPricePerLitre: rawRate !== '' ? Number(rawRate) : null,
            newMeter: modal.querySelector('#fc_meter').value !== '' ? Number(modal.querySelector('#fc_meter').value) : null,
            newIssueDate: fcDateInp.value || curDate,
            newFuelKind: fcKindSel.value || curKind,
            reason: modal.querySelector('#fc_reason').value.trim(),
            autoApprove: canAutoApprove && !!(autoBox && autoBox.checked),
          },
        });
        toast(res.status === 'APPROVED' ? 'Fuel issue adjustment applied & stock updated!' : 'Change request submitted to Administrator for approval.');
        modal.remove();
        if (typeof onDone === 'function') onDone(res);
      } catch (err) {
        notify('Adjustment error: ' + err.message);
        btn.disabled = false;
        btn.textContent = canAutoApprove ? 'Submit Adjustment' : '📩 Send Change Request to Admin';
      }
    };
  };

  // Shared Issue Fuel Modal with Live Meter Guard & "No Request, No Issue" Gate
  window.openIssueFuelModal = async function (defaults = {}, onDone) {
    let tanks = [];
    let projects = [];
    let approvedReqs = [];
    try {
      const [tRes, pRes, rRes] = await Promise.all([
        api('/fuel/tanks').catch(() => ({ tanks: [] })),
        api('/projects').catch(() => []),
        api('/fuel/requests?status=APPROVED&limit=200').catch(() => ({ requests: [] })),
      ]);
      tanks = tRes.tanks || [];
      projects = Array.isArray(pRes) ? pRes : (pRes.projects || []);
      approvedReqs = rRes.requests || [];
    } catch (_) {}

    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:600px;padding:24px">
        <h2 style="margin-top:0;margin-bottom:4px">⛽ Dispense &amp; Record Fuel Issue</h2>
        <p class="muted" style="margin:0 0 12px 0;font-size:12px"><b>No Request, No Issue:</b> Select an approved Transport Fuel Request first (Full Tank requests allow entering exact litres after filling).</p>
        <form id="form_fuel_issue" style="display:flex;flex-direction:column;gap:12px">
          <div style="padding:10px;border-radius:8px;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.22)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <label style="font-size:12px;font-weight:700;color:#1d4ed8">Approved Transport Fuel Request *</label>
              <a href="#/transport-fuel" id="fi_go_transport" style="font-size:11.5px;font-weight:600">+ Raise New Request →</a>
            </div>
            <select id="fi_request_id" class="input" style="width:100%">
              <option value="">-- Select Approved Request (${approvedReqs.length} awaiting pump) --</option>
              ${approvedReqs.map((r) => `<option value="${esc(r.id)}" ${defaults.requestId === r.id ? 'selected' : ''}>${esc(r.request_no)} · ${esc(vehText(r))} · RC:${esc(r.running_chart_no || 'Site Log')} · ${r.is_full_tank ? 'FULL TANK' : fmtNum(r.approved_litres || r.requested_litres, 1) + 'L'} (${esc(r.project_name || 'Central')})</option>`).join('')}
            </select>
            <div id="fi_req_meta" class="muted" style="font-size:11.5px;margin-top:5px"></div>
          </div>

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

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px;border-radius:8px;background:rgba(15,23,42,0.03);border:1px solid var(--border)">
            <div>
              <label style="font-size:12px;font-weight:600">Fuel Rate (Rs / L)</label>
              <input type="number" step="0.01" min="0" id="fi_price_rs" class="input" placeholder="Auto from Ceypetco tariff" style="width:100%">
              <div class="muted" id="fi_price_meta" style="font-size:11px;margin-top:3px">Loading active tariff...</div>
            </div>
            <div style="display:flex;flex-direction:column;justify-content:center">
              <div class="muted" style="font-size:11px;font-weight:600">ESTIMATED TOTAL COST</div>
              <div id="fi_est_cost" style="font-size:18px;font-weight:800;color:var(--primary,#0066ff);margin-top:2px">Rs 0.00</div>
              <div class="muted" style="font-size:10.5px">Auto-updates from date tariff unless overridden</div>
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

          <div style="padding:8px 10px;border-radius:6px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.28)">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#92400e;cursor:pointer">
              <input type="checkbox" id="fi_meter_faulty">
              <span>⚠️ Meter Faulty / Not Working (logs repair alert; reason required)</span>
            </label>
            <div id="fi_fault_reason_wrap" style="display:none;margin-top:6px">
              <input type="text" id="fi_meter_fault_reason" class="input" placeholder="Fault reason * (e.g. Hour meter blank / cable snapped)" style="width:100%">
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

    const litresInp = modal.querySelector('#fi_litres');
    const fuelTypeSel = modal.querySelector('#fi_fuel_type');
    const issueDateInp = modal.querySelector('#fi_date');
    const sourceTankSel = modal.querySelector('#fi_source_tank');
    const priceRsInp = modal.querySelector('#fi_price_rs');
    const priceMetaEl = modal.querySelector('#fi_price_meta');
    const estCostEl = modal.querySelector('#fi_est_cost');
    let priceOverridden = false;

    function updateEstCost() {
      const l = Number(litresInp.value || 0);
      const r = Number(priceRsInp.value || 0);
      estCostEl.textContent = fmtLkr(l > 0 && r > 0 ? l * r : 0);
    }

    async function syncIssueTariff() {
      if (priceOverridden) return;
      const ft = fuelTypeSel.value || 'AUTO_DIESEL';
      const dt = String(issueDateInp.value || localTodayStr()).slice(0, 10);
      try {
        const res = await api(`/fuel/prices/lookup?fuelType=${encodeURIComponent(ft)}&date=${encodeURIComponent(dt)}`);
        if (!priceOverridden && res && res.pricePerLitreCents > 0) {
          priceRsInp.value = (res.pricePerLitreCents / 100).toFixed(2);
          priceMetaEl.textContent = res.isFallback
            ? `Default reference tariff (no entry on/before ${dt})`
            : `Tariff ${res.effectiveDate} · ${res.source || 'CEYPETCO'}`;
          updateEstCost();
        }
      } catch (_) {}
    }

    litresInp.oninput = updateEstCost;
    priceRsInp.oninput = () => {
      priceOverridden = priceRsInp.value.trim() !== '';
      priceMetaEl.textContent = priceOverridden
        ? 'Custom slip rate override applied'
        : 'Using date-effective tariff';
      updateEstCost();
      if (!priceOverridden) syncIssueTariff();
    };
    fuelTypeSel.onchange = () => { syncIssueTariff(); };
    issueDateInp.onchange = () => { syncIssueTariff(); };
    sourceTankSel.onchange = () => {
      const selTank = tanks.find((t) => String(t.id) === String(sourceTankSel.value));
      if (selTank && selTank.fuel_type && FUEL_LABELS[selTank.fuel_type]) {
        fuelTypeSel.value = selTank.fuel_type;
        syncIssueTariff();
      }
    };
    if (defaults.tankId) {
      const defTank = tanks.find((t) => String(t.id) === String(defaults.tankId));
      if (defTank && defTank.fuel_type && FUEL_LABELS[defTank.fuel_type]) {
        fuelTypeSel.value = defTank.fuel_type;
      }
    }
    syncIssueTariff();

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
          banner.innerHTML = `⚠️ <b>Meter Spike Notice:</b> ${esc(res.warning)}<br><span>✅ ${vehBadge(res.asset)} <span class="muted">(${esc(res.asset.category || '')})</span> · ${prevTxt}${deltaTxt}${bandTxt}</span>`;
          overrideWrap.style.display = 'none';
        } else {
          banner.style.background = 'rgba(16,185,129,0.1)';
          banner.style.border = '1px solid rgba(16,185,129,0.35)';
          banner.innerHTML = `✅ ${vehBadge(res.asset)} <span class="muted">(${esc(res.asset.category || '')})</span> &nbsp;|&nbsp; ${prevTxt}${deltaTxt}${bandTxt}`;
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

    modal.querySelector('#fi_go_transport').onclick = () => { modal.remove(); };
    const reqSel = modal.querySelector('#fi_request_id');
    const reqMeta = modal.querySelector('#fi_req_meta');
    const fiFaultChk = modal.querySelector('#fi_meter_faulty');
    const fiFaultWrap = modal.querySelector('#fi_fault_reason_wrap');
    const fiFaultReasonInp = modal.querySelector('#fi_meter_fault_reason');
    const fiMeterInp = modal.querySelector('#fi_meter');

    function syncFiFaultyUi() {
      const faulty = !!(fiFaultChk && fiFaultChk.checked);
      if (fiFaultWrap) fiFaultWrap.style.display = faulty ? '' : 'none';
      if (fiMeterInp) {
        fiMeterInp.disabled = faulty;
        if (faulty) fiMeterInp.value = '';
      }
    }
    if (fiFaultChk) {
      fiFaultChk.onchange = () => {
        syncFiFaultyUi();
        runLiveMeterCheck();
      };
    }

    function applySelectedRequest() {
      const r = approvedReqs.find((x) => x.id === reqSel.value);
      if (!r) {
        reqMeta.innerHTML = approvedReqs.length
          ? 'Pick an approved Transport Fuel Request above (required for all vehicle fuel issues).'
          : '<span style="color:#b91c1c;font-weight:600">No approved requests ready — raise one in Transport Fuel &amp; Chart first.</span>';
        return;
      }
      modal.querySelector('#fi_asset_code').value = r.asset_code || '';
      if (fiFaultChk) fiFaultChk.checked = !!r.meter_faulty;
      if (fiFaultReasonInp) fiFaultReasonInp.value = r.meter_fault_reason || '';
      if (!r.meter_faulty && r.meter_reading != null) fiMeterInp.value = r.meter_reading;
      syncFiFaultyUi();
      if (r.meter_type) modal.querySelector('#fi_meter_type').value = r.meter_type;
      if (r.driver_name) modal.querySelector('#fi_driver').value = r.driver_name;
      if (r.project_id) modal.querySelector('#fi_project_id').value = String(r.project_id);
      if (r.source_mode === 'STATION') {
        srcMode.value = 'STATION';
        srcMode.dispatchEvent(new Event('change'));
        if (r.station_name) modal.querySelector('#fi_station_name').value = r.station_name;
      } else {
        srcMode.value = 'BOWSER';
        srcMode.dispatchEvent(new Event('change'));
        if (r.target_tank_id) sourceTankSel.value = r.target_tank_id;
      }
      if (r.fuel_type && FUEL_LABELS[r.fuel_type]) fuelTypeSel.value = r.fuel_type;
      if (r.is_full_tank) {
        litresInp.value = '';
        litresInp.placeholder = 'Enter actual L after full';
        reqMeta.innerHTML = `🟣 <b>FULL TANK MODE:</b> Recommended <b>${r.recommended_litres != null ? fmtNum(r.recommended_litres, 1) + ' L' : 'N/A'}</b> · Fill tank completely first, then enter actual dispensed litres above.`;
      } else {
        const effApp = r.approved_litres || r.trip_total_fuel || r.requested_litres || '';
        litresInp.value = effApp;
        reqMeta.innerHTML = `✅ Linked <b>${esc(r.request_no)}</b> · Recommended: <b>${r.recommended_litres != null ? fmtNum(r.recommended_litres, 1) + ' L' : '—'}</b> · Approved: <b>${fmtNum(effApp || r.requested_litres, 1)} L</b>`;
      }
      updateEstCost();
      syncIssueTariff();
      runLiveMeterCheck();
    }
    reqSel.onchange = applySelectedRequest;
    if (!defaults.requestId && defaults.assetCode) {
      const targetDef = String(defaults.assetCode).trim().toUpperCase();
      const match = approvedReqs.find((x) =>
        [x.asset_code, x.asset_ec_code, x.asset_registration].some((k) => k && String(k).trim().toUpperCase() === targetDef)
      );
      if (match) reqSel.value = match.id;
    }
    applySelectedRequest();

    modal.querySelector('#btn_cancel_fi').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.querySelector('#form_fuel_issue').onsubmit = async (e) => {
      e.preventDefault();
      const chosenReqId = reqSel.value || null;
      const enteredCode = modal.querySelector('#fi_asset_code').value.trim().toUpperCase();
      const isSiteTransfer = enteredCode.startsWith('SITE-');
      if (!chosenReqId && !isSiteTransfer) {
        notify('No Request, No Issue: Select an Approved Transport Fuel Request before dispensing fuel.');
        return;
      }
      const isFaulty = !!(fiFaultChk && fiFaultChk.checked);
      const faultReason = fiFaultReasonInp ? fiFaultReasonInp.value.trim() : '';
      const meterVal = !isFaulty && fiMeterInp && fiMeterInp.value !== '' ? Number(fiMeterInp.value) : null;
      if (!isSiteTransfer) {
        if (isFaulty) {
          if (faultReason.length < 3) {
            notify('Faulty meter reason (at least 3 characters) is required when Meter Faulty is checked.');
            return;
          }
        } else if (!(Number.isFinite(meterVal) && meterVal > 0)) {
          notify('Enter a valid Meter Reading (> 0) or check Meter Faulty with a reason.');
          return;
        }
      }
      const saveBtn = modal.querySelector('#btn_save_fi');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      const sourceMode = srcMode.value;
      const sourceTankId = sourceMode === 'BOWSER' ? (modal.querySelector('#fi_source_tank').value || null) : null;
      const stationName = sourceMode !== 'BOWSER'
        ? (modal.querySelector('#fi_station_name').value.trim() || (sourceMode === 'DIRECT_BILLED' ? 'Direct Billed' : 'External Filling Station'))
        : null;

      try {
        const rawRateRs = priceRsInp.value.trim();
        const fuelPriceCents = rawRateRs !== '' && Number(rawRateRs) > 0 ? Math.round(Number(rawRateRs) * 100) : null;
        const created = await api('/fuel/issues', {
          method: 'POST',
          body: {
            fuelRequestId: chosenReqId,
            assetCode: modal.querySelector('#fi_asset_code').value.trim(),
            litres: Number(litresInp.value),
            fuelType: fuelTypeSel.value,
            fuelPriceCents,
            meterReading: meterVal,
            meterType: modal.querySelector('#fi_meter_type').value,
            meterFaulty: isFaulty,
            meterFaultReason: isFaulty ? faultReason : null,
            sourceTankId,
            targetProjectId: modal.querySelector('#fi_project_id').value ? Number(modal.querySelector('#fi_project_id').value) : null,
            stationName,
            stationReceiptNo: modal.querySelector('#fi_receipt_no').value.trim() || null,
            driverName: modal.querySelector('#fi_driver').value.trim() || null,
            remarks: modal.querySelector('#fi_remarks').value.trim() || null,
            issueDate: issueDateInp.value ? issueDateInp.value.replace('T', ' ') : null,
            ignoreMeterWarning: modal.querySelector('#fi_override_meter').checked,
          },
        });
        toast(`Fuel issue recorded (${created.litres} L to ${created.asset_code})`);
        modal.remove();
        if (typeof onDone === 'function') onDone(created);
      } catch (err) {
        notify('Error recording fuel issue: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = '⛽ Save & Dispense Fuel';
      }
    };
  };

  // Main Fuel Operations Workspace
  async function renderFuelOperations(content) {
    const hashParts = (location.hash || '').split('?');
    const queryParams = new URLSearchParams(hashParts[1] || '');
    const fuelScope = (typeof ME === 'object' && ME && ME.fuelScope) ? ME.fuelScope : {};
    const isPumpOnly = !!fuelScope.isPumpOnly;
    const isAdm = typeof isAdmin === 'function' && isAdmin();

    const canIssueFuel = isAdm || (typeof canDo === 'function' && canDo('fuel.issue'));
    const canRefillTank = isAdm || (typeof canDo === 'function' && canDo('fuel.tanks.refill'));
    const canRaiseReq = isAdm || (typeof canDo === 'function' && canDo('fuel.transport.request', 'fuel.request'));
    const canVoidIssue = isAdm || (typeof canDo === 'function' && canDo('fuel.void'));
    const canReqCorr = isAdm || (typeof canDo === 'function' && canDo('fuel.correction.request', 'fuel.issue', 'fuel.correct'));
    const canApproveCorr = isAdm || (typeof canDo === 'function' && canDo('fuel.approve_correction', 'fuel.correct'));
    const canManagePrices = isAdm || (typeof canDo === 'function' && canDo('fuel.prices.manage'));
    const canViewPrices = isAdm || (typeof canView === 'function' && canView('fuel_prices') && typeof canDo === 'function' && canDo('fuel.prices.view', 'fuel.prices.manage'));
    const canViewReports = isAdm || (typeof canView === 'function' && canView('fuel_reports') && typeof canDo === 'function' && canDo('fuel.reports.view'));
    const canViewReadings = isAdm || (typeof canView === 'function' && canView('fuel_readings') && typeof canDo === 'function' && canDo('fuel.readings.view', 'fuel.readings.record'));
    const canViewTransport = isAdm || (typeof canView === 'function' && canView('fuel_transport') && typeof canDo === 'function' && canDo('fuel.transport.view', 'fuel.transport.request'));
    const canViewHire = isAdm || (typeof canView === 'function' && canView('hire'));
    const canViewDash = isAdm || (typeof canView === 'function' && canView('dashboard'));
    const canViewOverview = isAdm || canViewReports || (typeof canDo === 'function' && canDo('fuel.all_sites'));
    const canViewRegister = !isPumpOnly && (isAdm || (typeof canDo === 'function' && canDo('fuel.view')));
    const canViewConsole = isAdm || isPumpOnly || canIssueFuel || canRefillTank || (typeof canDo === 'function' && canDo('fuel.console.view', 'fuel.view'));

    const allowedTabs = [];
    if (isPumpOnly) {
      allowedTabs.push('site-console');
    } else {
      if (canViewRegister) allowedTabs.push('issues');
      if (canViewRegister || canReqCorr || canApproveCorr) allowedTabs.push('corrections');
      if (canViewConsole) allowedTabs.push('site-console');
      if (canViewOverview) allowedTabs.push('sites-overview');
      if (canViewOverview || canViewTransport) allowedTabs.push('vehicle-360');
      if (canViewTransport || canApproveCorr) allowedTabs.push('requests');
    }

    let activeTab = queryParams.get('tab') || (isPumpOnly ? 'site-console' : (allowedTabs[0] || 'site-console'));
    if (!allowedTabs.includes(activeTab)) activeTab = allowedTabs[0] || 'site-console';
    let selectedVehicleCode = queryParams.get('vehicle') || '';

    if (isPumpOnly) {
      content.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:12px">
          <div>
            <h1 style="margin:0;font-size:22px;font-weight:800">⛽ Site Pump Operator Console</h1>
            <p class="muted" style="margin:4px 0 0 0;font-size:12.5px">
              <b>4 Authorized Sections:</b> 1) Fuel Issue (Approved Queue) · 2) Fuel Issue History &amp; Admin Change Requests · 3) Fuel Add to Tank · 4) Fuel Add History
            </p>
          </div>
          <span class="badge blue" style="font-size:12px;padding:5px 10px">🔒 Site-Locked Pump Operator</span>
        </div>
        <div id="fuel_tab_container"></div>
      `;
    } else {
      content.innerHTML = `
        ${canViewDash ? '<div class="crumb"><a href="#/dashboard">Dashboard</a> / Fuel System V2 Command Center</div>' : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:12px">
          <div>
            <h1 style="margin:0;font-size:24px;font-weight:800">⛽ Fuel System Command Center</h1>
            <p class="muted" style="margin:4px 0 0 0">Issues Register, 4-Eyes Adjustments, Site Fuel Operators Console, Site Budgets, and Vehicle 360° Fuel & Meter Profiles</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${canIssueFuel ? '<button class="btn primary" id="btn_top_issue_fuel">⛽ Issue Fuel</button>' : ''}
            ${canViewReadings ? '<a href="#/fuel-readings" class="btn">📟 Meter Readings</a>' : ''}
            ${canViewReports ? '<a href="#/fuel-reports" class="btn">📊 Consumption Graphs & PM Plan</a>' : ''}
            ${canViewHire ? '<a href="#/hire-billing" class="btn">🏷️ Costing & Rate Cards</a>' : ''}
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
          ${canViewTransport ? `<div class="card" style="padding:12px 14px;cursor:pointer" id="card_kpi_requests">
            <div class="muted" style="font-size:11px;font-weight:700">FUEL REQUESTS QUEUE</div>
            <div style="font-size:20px;font-weight:800;margin-top:3px;color:#7c3aed" id="kpi_pending_req">0</div>
            <div class="muted" style="font-size:11px">Pending requisitions</div>
          </div>` : ''}
          ${canViewPrices ? `<div class="card" style="padding:12px 14px">
            <div class="muted" style="font-size:11px;font-weight:700">CEYPETCO AUTO DIESEL</div>
            <div style="font-size:20px;font-weight:800;margin-top:3px" id="kpi_diesel_rate">Rs ... / L</div>
            <div class="muted" style="font-size:11px" id="kpi_diesel_eff">Effective —</div>
            <div class="muted" style="font-size:10.5px;margin-top:2px" id="kpi_diesel_sync"></div>
            <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <a href="#/fuel-prices" style="font-size:11px">Tariffs →</a>
              ${canManagePrices ? '<button type="button" class="btn sm" id="btn_quick_fuel_rate" style="padding:2px 8px;font-size:11px">+ Update Rate</button><button type="button" class="btn sm" id="btn_sync_ceypetco" style="padding:2px 8px;font-size:11px" title="Fetch latest prices from ceypetco.gov.lk">↻ Sync</button>' : ''}
            </div>
          </div>` : ''}
        </div>

        <!-- Tab Navigation Bar (Capability Gated) -->
        <div class="tabs" id="fuel_main_tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid var(--border);padding-bottom:8px">
          ${allowedTabs.includes('issues') ? '<button class="btn sm" data-tab="issues">⛽ Fuel Issues Register</button>' : ''}
          ${allowedTabs.includes('corrections') ? '<button class="btn sm" data-tab="corrections">🔧 Fuel Adjustments <span id="tab_badge_corr" class="badge warn" style="display:none;margin-left:4px">0</span></button>' : ''}
          ${allowedTabs.includes('site-console') ? '<button class="btn sm" data-tab="site-console">🏗️ Site Fuel Operators Console</button>' : ''}
          ${allowedTabs.includes('sites-overview') ? '<button class="btn sm" data-tab="sites-overview">🗺️ Site Fuel Overview & Budgets</button>' : ''}
          ${allowedTabs.includes('vehicle-360') ? '<button class="btn sm" data-tab="vehicle-360">🚗 Vehicle-Wise Fuel & Meter 360°</button>' : ''}
          ${allowedTabs.includes('requests') ? '<button class="btn sm" data-tab="requests">📩 Fuel Requests</button>' : ''}
        </div>

        <div id="fuel_tab_container"></div>
      `;
    }

    let latestFuelStats = null;

    async function refreshKpis() {
      if (isPumpOnly) return;
      try {
        const stats = await api('/fuel/stats');
        latestFuelStats = stats;
        if (qs('#kpi_month_litres')) qs('#kpi_month_litres').textContent = `${fmtNum(stats.month.total_litres, 1)} L`;
        if (qs('#kpi_month_cost')) qs('#kpi_month_cost').textContent = `${fmtLkr(Number(stats.month.total_cost_cents || 0) / 100)} (${stats.month.issues_count || 0} slips)`;
        if (qs('#kpi_tank_stock')) qs('#kpi_tank_stock').textContent = stats.tanks.hide_stock || stats.tanks.total_stock_litres == null ? 'Hidden' : `${fmtNum(stats.tanks.total_stock_litres, 0)} L`;
        if (qs('#kpi_tank_count')) qs('#kpi_tank_count').textContent = `Across ${stats.tanks.total_tanks} active tanks/bowsers`;
        if (qs('#kpi_diesel_rate')) qs('#kpi_diesel_rate').textContent = `Rs ${(Number(stats.currentDieselCents || 38200) / 100).toFixed(2)} / L`;
        if (qs('#kpi_diesel_eff')) qs('#kpi_diesel_eff').textContent = stats.currentDieselEffectiveDate ? `Effective ${stats.currentDieselEffectiveDate}` : 'Reference tariff';
        const syncEl = qs('#kpi_diesel_sync');
        if (syncEl) {
          const sync = stats.ceypetcoSync || null;
          if (!sync) {
            syncEl.textContent = '';
          } else if (sync.lastSyncStatus === 'error') {
            syncEl.innerHTML = '<span style="color:#d97706">⚠ Auto-sync failed (click Sync to retry)</span>';
            syncEl.title = sync.lastSyncError || 'Sync failed';
          } else if (!sync.enabled) {
            syncEl.textContent = 'Auto-sync paused';
            syncEl.title = '';
          } else if (sync.lastSyncAt) {
            const hhmm = new Date(sync.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            syncEl.textContent = `Auto-sync · Checked ${hhmm}`;
            syncEl.title = sync.lastSyncSource ? `Source: ${sync.lastSyncSource}` : '';
          } else {
            syncEl.textContent = 'Auto-sync on · Pending first check';
            syncEl.title = '';
          }
        }
        if (qs('#kpi_pending_corr')) qs('#kpi_pending_corr').textContent = String(stats.pendingCorrections || 0);
        if (qs('#kpi_pending_req')) qs('#kpi_pending_req').textContent = String(stats.pendingRequests || 0);
        const bCorr = qs('#tab_badge_corr');
        if (bCorr) {
          bCorr.textContent = String(stats.pendingCorrections || 0);
          bCorr.style.display = stats.pendingCorrections > 0 ? 'inline-block' : 'none';
        }
      } catch (_) {}
    }

    function openQuickFuelRateModal() {
      const activePrices = (latestFuelStats && latestFuelStats.activePrices) || {};
      const m = document.createElement('div');
      m.className = 'modal-bg modal-backdrop';
      const defCents = (activePrices.AUTO_DIESEL && activePrices.AUTO_DIESEL.pricePerLitreCents) || (latestFuelStats && latestFuelStats.currentDieselCents) || 38200;
      m.innerHTML = `
        <div class="modal" style="max-width:460px;padding:22px">
          <h2 style="margin:0 0 6px 0;font-size:18px">⛽ Publish Timely Fuel Rate</h2>
          <p class="muted" style="margin:0 0 14px 0;font-size:12px">Applies automatically to fuel issues & billing from the chosen effective date onward. Earlier slips keep their historical rate.</p>
          <form id="form_quick_fuel_rate" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:600">Fuel Kind *</label>
              <select id="qfr_kind" class="input" style="width:100%">
                ${Object.entries(FUEL_LABELS).map(([k, lbl]) => `<option value="${k}">${lbl}</option>`).join('')}
              </select>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">New Rate (LKR / L) *</label>
                <input type="number" step="0.01" min="1" required id="qfr_rs" class="input" value="${(defCents / 100).toFixed(2)}" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Effective Date *</label>
                <input type="date" required id="qfr_date" class="input" value="${localTodayStr()}" style="width:100%">
              </div>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Revision Notes / Circular Ref</label>
              <input type="text" id="qfr_notes" class="input" placeholder="e.g. Ceypetco monthly price revision" style="width:100%">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
              <button type="button" class="btn" id="btn_qfr_cancel">Cancel</button>
              <button type="submit" class="btn primary" id="btn_qfr_save">Save Fuel Tariff</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(m);
      const kindSel = m.querySelector('#qfr_kind');
      const rsInp = m.querySelector('#qfr_rs');
      kindSel.onchange = () => {
        const entry = activePrices[kindSel.value];
        if (entry && entry.pricePerLitreCents) {
          rsInp.value = (entry.pricePerLitreCents / 100).toFixed(2);
        }
      };
      m.querySelector('#btn_qfr_cancel').onclick = () => m.remove();
      m.onclick = (e) => { if (e.target === m) m.remove(); };
      m.querySelector('#form_quick_fuel_rate').onsubmit = async (e) => {
        e.preventDefault();
        const btn = m.querySelector('#btn_qfr_save');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        try {
          await api('/fuel/prices', {
            method: 'POST',
            body: {
              fuelType: kindSel.value,
              pricePerLitre: Number(rsInp.value),
              effectiveDate: m.querySelector('#qfr_date').value,
              notes: m.querySelector('#qfr_notes').value.trim(),
              source: 'CEYPETCO',
            },
          });
          toast(`${FUEL_LABELS[kindSel.value] || kindSel.value} rate updated to Rs ${Number(rsInp.value).toFixed(2)} / L`);
          m.remove();
          await refreshKpis();
          switchTab(activeTab);
        } catch (err) {
          notify('Failed to update fuel tariff: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Save Fuel Tariff';
        }
      };
    }

    if (qs('#btn_quick_fuel_rate')) {
      qs('#btn_quick_fuel_rate').onclick = openQuickFuelRateModal;
    }

    if (qs('#btn_sync_ceypetco')) {
      qs('#btn_sync_ceypetco').onclick = async () => {
        const btn = qs('#btn_sync_ceypetco');
        if (!btn) return;
        btn.disabled = true;
        const origLabel = btn.textContent;
        btn.textContent = 'Syncing...';
        try {
          const res = await api('/fuel/prices/sync', { method: 'POST', body: {} });
          const updCount = (res.stored ? res.stored.length : 0) + (res.updated ? res.updated.length : 0);
          const dieselCents = res.activePrices && res.activePrices.AUTO_DIESEL
            ? res.activePrices.AUTO_DIESEL.pricePerLitreCents
            : null;
          const dieselLabel = dieselCents ? ` · Auto Diesel Rs ${(dieselCents / 100).toFixed(2)} / L` : '';
          toast(updCount > 0
            ? `Ceypetco synced (${updCount} tariff change${updCount === 1 ? '' : 's'})${dieselLabel}`
            : `Ceypetco prices already up to date${dieselLabel}`);
          await refreshKpis();
        } catch (err) {
          notify('Ceypetco sync failed: ' + err.message);
          await refreshKpis();
        } finally {
          btn.disabled = false;
          btn.textContent = origLabel;
        }
      };
    }

    if (qs('#btn_top_issue_fuel')) {
      qs('#btn_top_issue_fuel').onclick = () => {
        window.openIssueFuelModal({ assetCode: selectedVehicleCode }, () => {
          refreshKpis();
          switchTab(activeTab);
        });
      };
    }
    if (qs('#card_kpi_corrections')) qs('#card_kpi_corrections').onclick = () => switchTab('corrections');
    if (qs('#card_kpi_requests')) qs('#card_kpi_requests').onclick = () => switchTab('requests');

    function switchTab(tabKey, extraVehicle) {
      if (!allowedTabs.includes(tabKey)) tabKey = allowedTabs[0] || 'site-console';
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
                  <th style="padding:10px 12px;text-align:right">Fuel Rate (Rs/L)</th>
                  <th style="padding:10px 12px;text-align:right">Total Cost</th>
                  <th style="padding:10px 12px">Meter Reading</th>
                  <th style="padding:10px 12px">Source / Bowser</th>
                  <th style="padding:10px 12px">Site / Project</th>
                  <th style="padding:10px 12px">Driver</th>
                  <th style="padding:10px 12px;text-align:center">Options</th>
                </tr>
              </thead>
              <tbody id="fi_tbody">
                <tr><td colspan="12" style="padding:24px;text-align:center" class="muted">Loading fuel issues...</td></tr>
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
        tbody.innerHTML = '<tr><td colspan="12" style="padding:20px;text-align:center" class="muted">Loading...</td></tr>';

        try {
          const res = await api(`/fuel/issues?${params.toString()}`);
          currentRows = res.rows || [];
          if (!currentRows.length) {
            tbody.innerHTML = '<tr><td colspan="12" style="padding:24px;text-align:center" class="muted">No matching fuel issues found.</td></tr>';
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
                  <a href="#" data-nolink class="btn-veh-360" data-code="${esc(r.asset_code)}" style="font-weight:700;color:var(--primary,#0066ff);text-decoration:underline">${vehBadge(r, { stacked: true })}</a>
                  ${isVoid ? '<span class="badge danger" style="margin-left:4px">VOID</span>' : ''}
                  ${corrBadge}
                </td>
                <td style="padding:9px 12px">${esc(FUEL_LABELS[r.fuel_type] || r.fuel_type || 'Auto Diesel')}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:800">${fmtNum(r.litres, 1)} L</td>
                <td style="padding:9px 12px;text-align:right;white-space:nowrap;font-weight:600;color:#475569">${fmtRateRs(effectiveFuelRateCents(r))}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:600">${fmtLkr(Number(r.total_cost_cents || r.cost_cents || 0) / 100)}</td>
                <td style="padding:9px 12px">${r.meter_faulty ? `<span class="badge warn" title="${esc(r.meter_fault_reason || 'Meter Faulty')}">⚠️ FAULTY</span>` : (r.meter_reading ? `<b>${fmtNum(r.meter_reading, 1)}</b> <span class="muted" style="font-size:11px">${esc(r.meter_type || 'HRS')}</span>` : '<span class="muted">—</span>')}</td>
                <td style="padding:9px 12px">${srcBadge}</td>
                <td style="padding:9px 12px">${esc(r.target_project_name || '—')}</td>
                <td style="padding:9px 12px">${esc(r.driver_name || '—')}</td>
                <td style="padding:9px 12px;text-align:center;white-space:nowrap">
                  ${!isVoid && canReqCorr ? `<button class="btn sm btn-adj-issue" data-idx="${idx}" title="${isAdm ? 'Adjust / Correct Litres, Meter or Date' : 'Request Issue Change to Admin'}">✏️ ${isAdm ? 'Adjust' : 'Req Change'}</button>` : ''}
                  ${!isVoid && canVoidIssue ? `<button class="btn sm danger btn-void-issue" data-id="${esc(r.id)}" data-no="${esc(r.issue_no || r.id)}" style="margin-left:4px">Void</button>` : ''}
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
                notify('Void error: ' + e.message);
              }
            };
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="12" style="padding:24px;text-align:center" class="err">${esc(err.message)}</td></tr>`;
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
                  <a href="#" data-nolink class="btn-corr-veh" data-code="${esc(c.asset_code || '')}" style="font-weight:700">${vehBadge(c, { stacked: true })}</a>
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
                  <div>${deltaL >= 0 ? '+' : ''}${fmtNum(deltaL, 1)} L</div>
                  ${(c.before_price_cents && c.after_price_cents && Number(c.before_price_cents) !== Number(c.after_price_cents))
                    ? `<div class="muted" style="font-size:11px">Rate: ${fmtRateRs(c.before_price_cents)} → <b>${fmtRateRs(c.after_price_cents)}</b></div>`
                    : ''}
                </td>
                <td style="padding:10px 12px;max-width:260px">
                  <div>${esc(c.reason || '—')}</div>
                  <div class="muted" style="font-size:11px">By: ${esc(c.requester_name || 'Operator')}${c.approver_name ? ` · Reviewed by ${esc(c.approver_name)}` : ''}</div>
                </td>
                <td style="padding:10px 12px">${stBadge}</td>
                <td style="padding:10px 12px;text-align:center;white-space:nowrap">
                  ${c.status === 'PENDING' && canApproveCorr && (isAdm || Number(c.requested_by) !== Number(ME && ME.id)) ? `
                    <button class="btn sm primary btn-corr-act" data-id="${esc(c.id)}" data-act="APPROVE">✅ Approve</button>
                    <button class="btn sm danger btn-corr-act" data-id="${esc(c.id)}" data-act="REJECT" style="margin-left:4px">❌ Reject</button>
                  ` : `<span class="muted" style="font-size:11px">${c.status === 'PENDING' ? 'Awaiting Admin' : esc(String(c.approved_at || '').slice(0, 10))}</span>`}
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
                notify('Review error: ' + err.message);
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
    // TAB 3: SITE FUEL OPERATORS CONSOLE (4 Dedicated Sections for Pump Operator)
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
          const [data, priceData] = await Promise.all([
            api(`/fuel/site-console?${q.toString()}`),
            api('/fuel/prices/lookup?fuelType=AUTO_DIESEL').catch(() => ({ activePrices: {} })),
          ]);
          const activeTank = data.activeTank;
          const activeProj = data.activeProject;
          const hideStock = !!data.hideStock;
          const scScope = data.fuelScope || fuelScope || {};
          const activePrices = (priceData && priceData.activePrices) || (latestFuelStats && latestFuelStats.activePrices) || {};
          const tankFuelKind = (activeTank && activeTank.fuel_type) || 'AUTO_DIESEL';
          const defaultRateCents = (activePrices[tankFuelKind] && activePrices[tankFuelKind].pricePerLitreCents)
            || (activePrices.AUTO_DIESEL && activePrices.AUTO_DIESEL.pricePerLitreCents)
            || (priceData && priceData.pricePerLitreCents)
            || (latestFuelStats && latestFuelStats.currentDieselCents)
            || 38200;
          const defaultRateRs = (defaultRateCents / 100).toFixed(2);
          const todayStr = localTodayStr();

          if (scScope.unassigned) {
            box.innerHTML = `<div class="card" style="padding:24px;text-align:center;border:1px solid #f59e0b;background:#fffbeb">
              <div style="font-size:28px;margin-bottom:6px">⚠️</div>
              <h3 style="margin:0 0 6px 0">No Site or Bulk Tank Assigned</h3>
              <p class="muted" style="margin:0">Your account is site-scoped, but no project site or bulk tank has been assigned yet. Please ask an Administrator to assign your site tank in Access Control.</p>
            </div>`;
            return;
          }

          const stockPct = !hideStock && activeTank && activeTank.capacity_litres > 0 && activeTank.current_litres != null
            ? Math.min(100, Math.round((activeTank.current_litres / activeTank.capacity_litres) * 100))
            : 0;
          const lockTankPicker = !!(scScope.scoped && (data.allTanks || []).length <= 1);
          const myCorrs = data.myCorrections || [];
          const deliveries = data.recentDeliveries || [];

          box.innerHTML = `
            <!-- Site & Bowser Header Bar -->
            <div class="card" style="padding:14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;background:linear-gradient(90deg, rgba(16,185,129,0.08), rgba(37,99,235,0.05))">
              <div>
                <div style="font-size:11px;font-weight:700;color:#047857;text-transform:uppercase">🏗️ Active Site Tank / Pump</div>
                <div style="font-size:18px;font-weight:800;margin-top:2px">
                  ${activeTank ? `${esc(activeTank.name)} (${esc(activeTank.code)})` : 'No Active Tank Selected'}
                  ${activeProj ? ` · <span style="color:var(--primary,#0066ff)">${esc(activeProj.name)}</span>` : ''}
                </div>
              </div>
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                ${lockTankPicker ? `
                  <span class="badge blue" style="font-size:12px;padding:6px 10px">🛢️ Locked Tank: ${esc(activeTank ? activeTank.name : '—')}</span>
                ` : `
                  <select id="sc_tank_select" class="input sm" style="min-width:250px">
                    ${(data.allTanks || []).map((t) => `<option value="${esc(t.id)}" ${activeTank && activeTank.id === t.id ? 'selected' : ''}>🛢️ ${esc(t.name)} (${esc(t.project_name || t.code)})${t.pending_request_count ? ` · ${t.pending_request_count} awaiting` : ''}</option>`).join('')}
                  </select>
                `}
                ${!hideStock && activeTank && activeTank.current_litres != null ? `
                  <div class="card" style="padding:6px 12px;margin:0;background:#fff;border:1px solid #10b981">
                    <span class="muted" style="font-size:11px">Current Tank Stock:</span>
                    <b style="font-size:15px;color:#047857;margin-left:6px">${fmtNum(activeTank.current_litres, 1)} L</b>
                    <span class="muted" style="font-size:11px"> / ${fmtNum(activeTank.capacity_litres, 0)} L (${stockPct}%)</span>
                  </div>
                ` : (hideStock ? `<span class="badge warn">🔒 Tank Stock Hidden by Admin Policy</span>` : '')}
              </div>
            </div>

            <!-- TOP ROW: Section 1 (Fuel Issue) & Section 2 (Fuel Add to Tank) -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(380px, 1fr));gap:14px;margin-bottom:16px">
              <!-- SECTION 1: Fuel Issue (Approved Requests Queue — No Request, No Issue) -->
              <div class="card" style="padding:16px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
                  <div>
                    <h3 style="margin:0;font-size:15px">⛽ 1. Fuel Issue Section — Approved Queue (${(data.pendingPumpRequests || []).length})</h3>
                    <div class="muted" style="font-size:11px">No Request, No Issue · Dispense fuel only against approved requests for this tank</div>
                  </div>
                  ${canRaiseReq ? '<a href="#/transport-fuel" class="btn sm primary">+ Raise Fuel Request</a>' : ''}
                </div>
                <div style="max-height:300px;overflow-y:auto">
                  ${(data.pendingPumpRequests || []).length ? `
                    <table class="table" style="width:100%;font-size:12px">
                      <thead>
                        <tr><th>Req #</th><th>Vehicle / Chart</th><th style="text-align:right">Rec / Req</th><th></th></tr>
                      </thead>
                      <tbody>
                        ${(data.pendingPumpRequests || []).map((reqItem) => `
                          <tr>
                            <td>
                              <div style="font-family:monospace;font-weight:700">${esc(reqItem.request_no)}</div>
                              <div class="muted" style="font-size:10.5px">${esc(reqItem.driver_name || '—')}</div>
                            </td>
                            <td>
                              ${vehBadge(reqItem, { stacked: true })}
                              <div class="muted" style="font-size:10.5px;margin-top:2px">RC:${esc(reqItem.running_chart_no || 'Site Log')} · ${reqItem.meter_faulty ? `<span class="badge warn" title="${esc(reqItem.meter_fault_reason || '')}">⚠️ FAULTY</span>` : (reqItem.meter_reading ? fmtNum(reqItem.meter_reading, 1) : '—')}</div>
                            </td>
                            <td style="text-align:right">
                              <div style="color:#0369a1;font-weight:700">${reqItem.recommended_litres != null ? fmtNum(reqItem.recommended_litres, 1) + 'L rec' : 'No norm'}</div>
                              <div>${reqItem.is_full_tank ? '<span class="badge" style="background:#7c3aed;color:#fff;font-size:10px">FULL TANK</span>' : `<b>${fmtNum(reqItem.approved_litres || reqItem.requested_litres, 1)} L app</b>`}</div>
                            </td>
                            <td style="text-align:right">
                              ${canIssueFuel ? `<button class="btn sm primary sc-pump-dispense" data-req-id="${esc(reqItem.id)}">⛽ ${reqItem.is_full_tank ? 'Full Tank Qty' : 'Dispense'}</button>` : ''}
                            </td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  ` : `
                    <div class="muted" style="padding:20px;text-align:center;border:1px dashed var(--border);border-radius:8px">
                      No approved Fuel Requests awaiting pump dispatch for <b>${esc(activeTank ? activeTank.name : 'this pump')}</b>.<br>
                      ${canRaiseReq
                        ? '<a href="#/transport-fuel" style="font-weight:600">Create a Transport Fuel &amp; Running Chart Request →</a>'
                        : '<span style="font-size:11.5px">Ask your Site Fuel Requester to raise a fuel request first.</span>'}
                    </div>
                  `}
                </div>
              </div>

              <!-- SECTION 2: Fuel Add Section (Receive Bulk Fuel into Tank) -->
              <div class="card" style="padding:16px">
                <h3 style="margin:0 0 4px 0;font-size:15px">🚛 2. Fuel Add Section — Receive Fuel into Tank</h3>
                <div class="muted" style="font-size:11px;margin-bottom:10px">Add received bulk fuel deliveries into <b>${esc(activeTank ? activeTank.name : 'assigned tank')}</b></div>
                ${canRefillTank ? `
                <form id="sc_form_refuel" style="display:flex;flex-direction:column;gap:10px">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                    <div>
                      <label style="font-size:11px;font-weight:600">Litres Received *</label>
                      <input type="number" step="1" min="1" id="sc_del_litres" required class="input sm" placeholder="e.g. 6600" style="width:100%">
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:600">Rate / L (Rs)</label>
                      <input type="number" step="0.01" min="1" id="sc_del_price" class="input sm" value="${defaultRateRs}" style="width:100%">
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
                      <input type="date" id="sc_del_date" class="input sm" value="${todayStr}" style="width:100%">
                    </div>
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Remarks / Bowser Seal Note (optional)</label>
                    <input type="text" id="sc_del_note" class="input sm" placeholder="e.g. Verified seal & dip before offload" style="width:100%">
                  </div>
                  <button type="submit" class="btn sm" style="align-self:flex-start;background:#059669;color:#fff;border-color:#059669">📥 Add Received Fuel to Tank</button>
                </form>` : `<div class="muted" style="padding:16px">Your account does not have permission to add bulk fuel deliveries.</div>`}
              </div>
            </div>

            <!-- BOTTOM ROW: Section 3 (Fuel Issue History + Admin Change Requests) & Section 4 (Fuel Add History) -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(420px, 1fr));gap:14px;margin-bottom:16px">
              <!-- SECTION 3: Fuel Issue History -->
              <div class="card" style="padding:14px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
                  <div>
                    <h3 style="margin:0;font-size:14.5px">📋 3. Fuel Issue History (${(data.recentIssues || []).length})</h3>
                    <div class="muted" style="font-size:11px">Need to change or cancel a past issue? Click <b>Request Change</b> to notify Admin.</div>
                  </div>
                </div>
                <div style="max-height:360px;overflow-y:auto">
                  <table class="table" style="width:100%;font-size:12px">
                    <thead>
                      <tr><th>Date</th><th>Slip / Req</th><th>Vehicle</th><th style="text-align:right">Litres</th><th style="text-align:right">Cost</th><th>Meter</th><th>Driver</th><th></th></tr>
                    </thead>
                    <tbody>
                      ${(data.recentIssues || []).length ? data.recentIssues.map((r, idx) => {
                        const isVoid = r.is_voided === 1;
                        const corrTag = r.correction_status === 'PENDING'
                          ? '<span class="badge warn" style="font-size:9.5px;margin-left:3px">⏳ Admin Review</span>'
                          : (r.correction_status === 'APPROVED' ? '<span class="badge ok" style="font-size:9.5px;margin-left:3px">✓ Changed</span>' : '');
                        const vehHtml = (!isPumpOnly && canViewReports)
                          ? `<a href="#" data-nolink class="sc-veh-360" data-code="${esc(r.asset_code)}" style="font-weight:700">${vehBadge(r, { stacked: true })}</a>`
                          : vehBadge(r, { stacked: true });
                        return `
                          <tr style="${isVoid ? 'opacity:0.55;background:rgba(239,68,68,0.05)' : ''}">
                            <td style="white-space:nowrap">${esc(String(r.issue_date || '').slice(0, 10))}</td>
                            <td style="font-family:monospace;font-size:11px">
                              <div>${esc(r.issue_no || r.id.slice(0, 8))}</div>
                              ${r.request_no ? `<div class="muted" style="font-size:10px">${esc(r.request_no)}</div>` : ''}
                            </td>
                            <td>${vehHtml}${isVoid ? ' <span class="badge danger" style="font-size:9.5px">VOID</span>' : ''}${corrTag}</td>
                            <td style="text-align:right;font-weight:700;white-space:nowrap">${fmtNum(r.litres, 1)} L</td>
                            <td style="text-align:right;white-space:nowrap">${fmtLkr(Number(r.total_cost_cents || r.cost_cents || 0) / 100)}</td>
                            <td>${r.meter_faulty ? `<span class="badge warn" title="${esc(r.meter_fault_reason || 'Meter Faulty')}">⚠️ FAULTY</span>` : (r.meter_reading ? fmtNum(r.meter_reading, 1) : '—')}</td>
                            <td>${esc(r.driver_name || '—')}</td>
                            <td style="white-space:nowrap">
                              ${!isVoid && canReqCorr && r.correction_status !== 'PENDING'
                                ? `<button class="btn sm sc-adj-btn" data-idx="${idx}" style="padding:2px 7px;font-size:11px">✏️ ${isAdm ? 'Adjust' : 'Req Change'}</button>`
                                : (r.correction_status === 'PENDING' ? '<span class="muted" style="font-size:10.5px">Pending</span>' : '')}
                            </td>
                          </tr>
                        `;
                      }).join('') : '<tr><td colspan="8" class="muted" style="text-align:center;padding:18px">No fuel issues recorded on this tank yet</td></tr>'}
                    </tbody>
                  </table>
                </div>

                ${myCorrs.length ? `
                  <div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border)">
                    <div style="font-size:12px;font-weight:700;margin-bottom:6px">📩 Issue Change Requests Sent to Admin (${myCorrs.length})</div>
                    <div style="max-height:190px;overflow-y:auto">
                      <table class="table" style="width:100%;font-size:11.5px">
                        <thead>
                          <tr><th>Date</th><th>Vehicle / Slip</th><th>Change</th><th>Reason / Admin Note</th><th>Status</th></tr>
                        </thead>
                        <tbody>
                          ${myCorrs.map((mc) => {
                            const st = mc.status === 'APPROVED'
                              ? '<span class="badge ok">APPROVED</span>'
                              : (mc.status === 'REJECTED' ? '<span class="badge danger">REJECTED</span>' : '<span class="badge warn">PENDING ADMIN</span>');
                            return `
                              <tr>
                                <td style="white-space:nowrap">${esc(String(mc.requested_at || '').slice(0, 10))}</td>
                                <td>${vehBadge(mc, { stacked: true })}<div class="muted" style="font-size:10px">${esc(mc.issue_no || '')}</div></td>
                                <td><span class="badge" style="font-size:10px">${esc(mc.correction_type || 'EDIT')}</span> ${fmtNum(mc.before_litres, 1)}→<b>${fmtNum(mc.after_litres, 1)}L</b></td>
                                <td><div>${esc(mc.reason || '—')}</div>${mc.review_note ? `<div class="muted" style="font-size:10px">Admin: ${esc(mc.review_note)}</div>` : ''}</td>
                                <td>${st}</td>
                              </tr>
                            `;
                          }).join('')}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ` : ''}
              </div>

              <!-- SECTION 4: Fuel Add History (Tank Deliveries) -->
              <div class="card" style="padding:14px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                  <div>
                    <h3 style="margin:0;font-size:14.5px">📜 4. Fuel Add History — Tank Deliveries (${deliveries.length})</h3>
                    <div class="muted" style="font-size:11px">Received bulk fuel stock added into <b>${esc(activeTank ? activeTank.name : 'this tank')}</b></div>
                  </div>
                </div>
                <div style="max-height:360px;overflow-y:auto">
                  <table class="table" style="width:100%;font-size:12px">
                    <thead>
                      <tr><th>Date</th><th style="text-align:right">Litres Added</th><th>Fuel</th><th>Supplier / Invoice</th><th style="text-align:right">Total Cost</th><th>Received By</th></tr>
                    </thead>
                    <tbody>
                      ${deliveries.length ? deliveries.map((d) => `
                        <tr>
                          <td style="white-space:nowrap">${esc(String(d.delivery_date || '').slice(0, 10))}</td>
                          <td style="text-align:right;font-weight:800;color:#059669;white-space:nowrap">+${fmtNum(d.litres, 1)} L</td>
                          <td>${esc(FUEL_LABELS[d.fuel_type] || d.fuel_type || 'Auto Diesel')}</td>
                          <td>
                            <div style="font-weight:600">${esc(d.supplier || 'Bulk Delivery')}</div>
                            ${d.invoice_number ? `<div class="muted" style="font-size:10.5px;font-family:monospace">${esc(d.invoice_number)}</div>` : ''}
                            ${d.notes ? `<div class="muted" style="font-size:10.5px">${esc(d.notes)}</div>` : ''}
                          </td>
                          <td style="text-align:right;white-space:nowrap">${d.cost_cents ? fmtLkr(Number(d.cost_cents) / 100) : '—'}</td>
                          <td>${esc(d.receiver_name || 'Operator')}</td>
                        </tr>
                      `).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:18px">No bulk fuel deliveries logged for this tank yet</td></tr>'}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            ${!isPumpOnly ? `
            <!-- Vehicles Assigned to Site (for Fuel Officers / Managers / Admins) -->
            <div class="card" style="padding:14px">
              <h3 style="margin:0 0 8px 0;font-size:14px">🚜 Vehicles Assigned to Site (${(data.siteVehicles || []).length})</h3>
              <div style="max-height:260px;overflow-y:auto">
                <table class="table" style="width:100%;font-size:12px">
                  <thead>
                    <tr><th>E&amp;C No</th><th>Vehicle Reg No</th><th>Category</th><th>Hours/KM</th><th></th></tr>
                  </thead>
                  <tbody>
                    ${(data.siteVehicles || []).length ? data.siteVehicles.map((v) => {
                      const vid = typeof window.resolveVehicleIdentity === 'function' ? window.resolveVehicleIdentity(v) : { ec_code: v.code, registration: v.registration };
                      return `
                      <tr>
                        <td><a href="#" data-nolink class="sc-veh-360" data-code="${esc(v.code)}" style="font-weight:700">${esc(vid.ec_code || v.code)}</a></td>
                        <td>${esc(vid.registration || v.registration || '—')}</td>
                        <td>${esc(v.category || '—')}</td>
                        <td>${v.current_hours ? fmtNum(v.current_hours, 0) : '—'}</td>
                        <td>${canRaiseReq ? `<button class="btn sm sc-quick-pick" data-code="${esc(v.code)}" style="padding:2px 6px;font-size:11px">Request Fuel</button>` : ''}</td>
                      </tr>
                    `; }).join('') : '<tr><td colspan="5" class="muted" style="text-align:center;padding:16px">No vehicles currently allocated to this site</td></tr>'}
                  </tbody>
                </table>
              </div>
            </div>` : ''}
          `;

          const tankSelectEl = qs('#sc_tank_select', box);
          if (tankSelectEl) {
            tankSelectEl.onchange = (e) => {
              selectedTankId = e.target.value;
              loadConsole();
            };
          }

          qsa('.sc-quick-pick', box).forEach((b) => {
            b.onclick = () => {
              const code = b.getAttribute('data-code') || '';
              location.hash = `#/transport-fuel?tab=request${code ? '&vehicle=' + encodeURIComponent(code) : ''}`;
            };
          });
          qsa('.sc-pump-dispense', box).forEach((b) => {
            b.onclick = () => {
              const reqObj = (data.pendingPumpRequests || []).find((x) => x.id === b.getAttribute('data-req-id'));
              if (reqObj) {
                window.openPumpDispatchModal(reqObj, () => {
                  loadConsole();
                  refreshKpis();
                });
              }
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

          const refuelForm = qs('#sc_form_refuel', box);
          if (refuelForm) {
            refuelForm.onsubmit = async (e) => {
              e.preventDefault();
              if (!activeTank) return notify('Select a tank first');
              try {
                await api('/fuel/site-console/refuel', {
                  method: 'POST',
                  body: {
                    tankId: activeTank.id,
                    litresDelivered: Number(qs('#sc_del_litres', box).value),
                    pricePerLitreCents: Math.round(Number(qs('#sc_del_price', box).value || defaultRateRs) * 100),
                    supplierName: qs('#sc_del_sup', box).value.trim(),
                    invoiceNo: qs('#sc_del_inv', box).value.trim(),
                    deliveryDate: qs('#sc_del_date', box).value,
                    note: (qs('#sc_del_note', box) && qs('#sc_del_note', box).value.trim()) || undefined,
                  },
                });
                toast('Received fuel added to tank & logged in Fuel Add History!');
                loadConsole();
                refreshKpis();
              } catch (err) {
                notify('Delivery error: ' + err.message);
              }
            };
          }
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
      let curMonth = localTodayStr().slice(0, 7);
      const canManageBudgets = (typeof isAdmin === 'function' && isAdmin()) || (typeof canDo === 'function' && canDo('fuel.prices.manage', 'fuel.tanks.manage'));

      async function openSiteBudgetsModal(focusProjectId = null) {
        const dlg = document.createElement('div');
        dlg.className = 'modal-bg modal-backdrop';
        dlg.innerHTML = `
          <div class="modal" style="max-width:920px;width:96%;max-height:88vh;overflow-y:auto;padding:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
              <div>
                <h2 style="margin:0">🎯 Monthly Site Fuel Budgets (${esc(curMonth)})</h2>
                <p class="muted" style="margin:4px 0 0 0;font-size:12px">Set target monthly litre caps per site, auto-fill from 3-month rolling usage, or copy last month’s targets.</p>
              </div>
              <button type="button" class="btn sm" id="bdg_close">✕ Close</button>
            </div>
            <div id="bdg_body" class="muted" style="padding:20px;text-align:center">Loading site budget targets…</div>
          </div>
        `;
        document.body.appendChild(dlg);
        dlg.querySelector('#bdg_close').onclick = () => dlg.remove();
        dlg.onclick = (e) => { if (e.target === dlg) dlg.remove(); };

        async function loadModalData() {
          const mBody = dlg.querySelector('#bdg_body');
          try {
            const res = await api(`/fuel/budgets?month=${encodeURIComponent(curMonth)}`);
            const items = res.items || [];
            const sm = res.summary || {};

            mBody.innerHTML = `
              <div style="text-align:left">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">
                  <div style="display:flex;gap:6px;flex-wrap:wrap;font-size:12px">
                    <span class="badge blue">Budgeted: ${sm.budgeted_sites || 0}/${sm.total_sites || 0}</span>
                    <span class="badge ok" style="background:#10b981;color:#fff">On Track: ${sm.on_track || 0}</span>
                    <span class="badge warn" style="background:#d97706;color:#fff">Watch (≥${res.warn_pct || 85}%): ${sm.watch || 0}</span>
                    <span class="badge danger" style="background:#dc2626;color:#fff">Over: ${sm.over_budget || 0}</span>
                  </div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                    ${canManageBudgets ? '<button type="button" class="btn sm" id="bdg_fill_sug">✨ Fill Suggested Targets</button>' : ''}
                    ${canManageBudgets ? `<button type="button" class="btn sm" id="bdg_copy_prev">📋 Copy from ${esc(res.prev_month)}</button>` : ''}
                  </div>
                </div>
                <div style="max-height:380px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
                  <table class="table" style="width:100%;font-size:12px;margin:0">
                    <thead>
                      <tr>
                        <th>Site / Project</th>
                        <th style="text-align:right">Actual (${esc(curMonth)})</th>
                        <th style="text-align:right">3M Avg</th>
                        <th style="text-align:right">Suggested (+10%)</th>
                        <th>Monthly Budget (L)</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${items.map((it) => `
                        <tr class="bdg-row" data-pid="${esc(it.project_id)}" data-sug="${it.suggested_budget_litres != null ? esc(it.suggested_budget_litres) : ''}" style="${focusProjectId && Number(focusProjectId) === Number(it.project_id) ? 'background:rgba(37,99,235,0.08)' : ''}">
                          <td><b>${esc(it.project_name)}</b><div class="muted" style="font-size:10.5px">${esc(it.project_code)}</div></td>
                          <td style="text-align:right;font-weight:700">${fmtNum(it.actual_litres, 1)} L ${it.budget_pct != null ? `<span class="badge ${it.pace_verdict === 'OVER' ? 'danger' : (it.pace_verdict === 'NEAR' ? 'warn' : '')}" style="font-size:10px">${it.budget_pct}%</span>` : ''}</td>
                          <td style="text-align:right">${fmtNum(it.avg_3m_litres, 1)} L</td>
                          <td style="text-align:right">${it.suggested_budget_litres != null ? fmtNum(it.suggested_budget_litres, 0) + ' L' : '—'}</td>
                          <td><input type="number" step="10" min="0" class="input sm bdg-val" ${canManageBudgets ? '' : 'disabled'} value="${it.budget_litres != null ? esc(it.budget_litres) : ''}" placeholder="Unset" style="width:120px"></td>
                          <td><input type="text" class="input sm bdg-note" ${canManageBudgets ? '' : 'disabled'} value="${esc(it.note || '')}" placeholder="Site note" style="width:160px"></td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
                ${canManageBudgets ? `
                  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
                    <button type="button" class="btn primary" id="bdg_save_all">💾 Save All Budgets</button>
                  </div>` : ''}
              </div>
            `;

            if (canManageBudgets) {
              const fillBtn = mBody.querySelector('#bdg_fill_sug');
              if (fillBtn) {
                fillBtn.onclick = () => {
                  let filled = 0;
                  qsa('.bdg-row', mBody).forEach((r) => {
                    const inp = r.querySelector('.bdg-val');
                    const sug = r.dataset.sug;
                    if (inp && !inp.value && sug) {
                      inp.value = sug;
                      filled += 1;
                    }
                  });
                  toast(filled ? `Filled ${filled} suggested site budget(s)` : 'No empty rows with 3-month history to fill');
                };
              }

              const copyBtn = mBody.querySelector('#bdg_copy_prev');
              if (copyBtn) {
                copyBtn.onclick = async () => {
                  try {
                    const [yr, mo] = curMonth.split('-').map(Number);
                    const out = await api('/fuel/budgets/bulk', {
                      method: 'POST',
                      body: { year: yr, month: mo, copyFromMonth: res.prev_month },
                    });
                    toast(`Copied ${out.saved_count || 0} budget(s) from ${res.prev_month}`);
                    loadModalData();
                    loadOverview();
                  } catch (err) {
                    notify('Copy error: ' + err.message);
                  }
                };
              }

              const saveBtn = mBody.querySelector('#bdg_save_all');
              if (saveBtn) {
                saveBtn.onclick = async () => {
                  const [yr, mo] = curMonth.split('-').map(Number);
                  const payloadItems = [];
                  qsa('.bdg-row', mBody).forEach((r) => {
                    const valStr = r.querySelector('.bdg-val').value.trim();
                    const noteStr = r.querySelector('.bdg-note').value.trim();
                    if (valStr !== '') {
                      payloadItems.push({
                        projectId: Number(r.dataset.pid),
                        budgetLitres: Number(valStr),
                        note: noteStr || null,
                      });
                    }
                  });
                  if (!payloadItems.length) {
                    notify('Enter at least one monthly budget in litres');
                    return;
                  }
                  try {
                    const out = await api('/fuel/budgets/bulk', {
                      method: 'POST',
                      body: { year: yr, month: mo, items: payloadItems },
                    });
                    toast(`Saved ${out.saved_count || 0} monthly site budget(s)`);
                    dlg.remove();
                    loadOverview();
                  } catch (err) {
                    notify('Budget save error: ' + err.message);
                  }
                };
              }
            }
          } catch (err) {
            mBody.innerHTML = `<div class="err">${esc(err.message)}</div>`;
          }
        }

        loadModalData();
      }

      async function loadOverview() {
        box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Site Fuel Overview & Budgets...</div>`;
        try {
          const [data, bRes] = await Promise.all([
            api(`/fuel/sites-overview?month=${encodeURIComponent(curMonth)}`),
            api(`/fuel/budgets?month=${encodeURIComponent(curMonth)}`).catch(() => null),
          ]);
          const cards = data.cards || [];
          const bSum = (bRes && bRes.summary) || {};

          box.innerHTML = `
            <div class="card" style="padding:12px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
              <div>
                <h3 style="margin:0;font-size:16px">🗺️ Site-Wise Fuel Consumption, 6-Month Sparklines &amp; Monthly Litre Budgets</h3>
                <div class="muted" style="font-size:12px">
                  Total for ${esc(data.month)}: <b>${fmtNum(data.totals.litres, 1)} L</b> (${fmtLkr(data.totals.costLkr)}) across ${cards.length} active sites
                  ${bRes ? ` · Budgets Set: <b>${bSum.budgeted_sites || 0}/${bSum.total_sites || 0}</b>${bSum.over_budget ? ` · <span style="color:#dc2626;font-weight:700">${bSum.over_budget} Over Budget</span>` : ''}` : ''}
                </div>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                ${canManageBudgets ? '<button type="button" class="btn sm primary" id="so_manage_budgets">🎯 Manage Site Budgets</button>' : ''}
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

          const mgrBtn = qs('#so_manage_budgets', box);
          if (mgrBtn) {
            mgrBtn.onclick = () => openSiteBudgetsModal();
          }

          qsa('.btn-edit-budget', box).forEach((b) => {
            b.onclick = () => openSiteBudgetsModal(Number(b.getAttribute('data-pid')));
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
                <button class="btn sm" data-print>🖨️ Print Sheet</button>
                <button class="btn sm" id="btn_close_ss">✕ Close</button>
              </div>
            </div>

            <h3 style="font-size:14px;margin:12px 0 6px 0">1. Vehicle-Wise Summary at ${esc(res.project.name)}</h3>
            <table class="table" style="width:100%;font-size:12px;margin-bottom:16px">
              <thead>
                <tr><th>E&amp;C No</th><th>Vehicle Reg No</th><th>Category</th><th style="text-align:right">Fills</th><th style="text-align:right">Litres</th><th style="text-align:right">Cost</th><th>Meter Span</th><th>Measured Rate</th></tr>
              </thead>
              <tbody>
                ${(res.vehicles || []).map((v) => `
                  <tr>
                    <td><b>${esc(v.ec_code || v.code)}</b></td>
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
                  <tr><th>Date</th><th>Slip #</th><th>Vehicle (E&amp;C · Reg)</th><th style="text-align:right">Litres</th><th style="text-align:right">Rate (Rs/L)</th><th style="text-align:right">Cost</th><th>Meter</th><th>Tank / Source</th><th>Driver</th></tr>
                </thead>
                <tbody>
                  ${(res.issues || []).map((i) => `
                    <tr>
                      <td>${esc(String(i.issue_date || '').slice(0, 10))}</td>
                      <td>${esc(i.issue_no || i.id.slice(0, 8))}</td>
                      <td>${vehBadge(i, { stacked: true })}</td>
                      <td style="text-align:right;font-weight:700">${fmtNum(i.litres, 1)} L</td>
                      <td style="text-align:right;white-space:nowrap">${fmtRateRs(effectiveFuelRateCents(i))}</td>
                      <td style="text-align:right">${fmtLkr(Number(i.total_cost_cents || i.cost_cents || 0) / 100)}</td>
                      <td>${i.meter_faulty ? `<span class="badge warn" title="${esc(i.meter_fault_reason || 'Meter Faulty')}">⚠️ FAULTY</span>` : (i.meter_reading ? fmtNum(i.meter_reading, 1) : '—')}</td>
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
                      <th style="padding:10px 12px">E&amp;C No</th>
                      <th style="padding:10px 12px">Vehicle Reg No</th>
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
                          <td style="padding:9px 12px"><b style="color:var(--primary,#0066ff)">${esc(v.ec_code || v.code)}</b></td>
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
                    <h2 style="margin:0;font-size:22px;font-weight:800">${vehBadge(a)}</h2>
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
                    <tr><th>Date</th><th>Slip #</th><th style="text-align:right">Litres</th><th style="text-align:right">Rate (Rs/L)</th><th style="text-align:right">Cost</th><th>Meter</th><th>Tank / Source</th><th>Site</th><th>Driver</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    ${(p.issues || []).map((r, idx) => `
                      <tr style="${r.is_voided ? 'opacity:0.5' : ''}">
                        <td>${esc(String(r.issue_date || '').slice(0, 16))}</td>
                        <td>${esc(r.issue_no || r.id.slice(0, 8))}</td>
                        <td style="text-align:right;font-weight:700">${fmtNum(r.litres, 1)} L</td>
                        <td style="text-align:right;white-space:nowrap">${fmtRateRs(effectiveFuelRateCents(r))}</td>
                        <td style="text-align:right">${fmtLkr(Number(r.total_cost_cents || r.cost_cents || 0) / 100)}</td>
                        <td>${r.meter_faulty ? `<span class="badge warn" title="${esc(r.meter_fault_reason || 'Meter Faulty')}">⚠️ FAULTY</span>` : (r.meter_reading ? fmtNum(r.meter_reading, 1) : '—')}</td>
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
      let tanks = [];
      try {
        const tRes = await api('/fuel/tanks').catch(() => ({ tanks: [] }));
        tanks = (tRes.tanks || []).filter((t) => t.active !== 0);
      } catch (_) {}

      box.innerHTML = `
        <div class="card" style="padding:12px 16px;margin-bottom:14px;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.2);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div style="font-size:12.5px"><b>Full Running Chart, Recommended Fuel &amp; Cross-Check Workspace:</b> Use the dedicated Transport Fuel section for live norm calculation, Full Tank issues &amp; Excel cross-check reports.</div>
          <a href="#/transport-fuel" class="btn sm primary">🚛 Open Transport Fuel &amp; Chart →</a>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:14px">
          <div class="card" style="padding:16px">
            <h3 style="margin:0 0 10px 0;font-size:15px">📩 Quick Transport Requisition</h3>
            <form id="form_fuel_req" style="display:flex;flex-direction:column;gap:10px">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div>
                  <label style="font-size:12px;font-weight:600">Vehicle E&amp;C No or Reg *</label>
                  <input type="text" id="fr_code" required class="input sm" placeholder="e.g. DT-15, LM-5722, EX-01" style="width:100%">
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Running Chart / Log # <span class="muted">(Opt. for Hr)</span></label>
                  <input type="text" id="fr_chart" class="input sm" placeholder="RC-2026-... or Site Log" style="width:100%">
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div>
                  <label style="font-size:12px;font-weight:600">Current Meter <span id="fr_meter_star">*</span></label>
                  <input type="number" step="0.1" id="fr_meter" required class="input sm" placeholder="KM / HRS" style="width:100%">
                  <label style="display:flex;align-items:center;gap:5px;margin-top:4px;font-size:11px;font-weight:600;color:#b45309;cursor:pointer">
                    <input type="checkbox" id="fr_meter_faulty">
                    <span>⚠️ Meter Faulty</span>
                  </label>
                  <div id="fr_fault_wrap" style="display:none;margin-top:4px">
                    <input type="text" id="fr_meter_fault_reason" class="input sm" placeholder="Fault reason *" style="width:100%">
                  </div>
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Approx KM / Hrs</label>
                  <input type="number" step="0.1" id="fr_approx" class="input sm" placeholder="Optional / auto delta" style="width:100%">
                </div>
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Target Tank / Pump *</label>
                <select id="fr_tank" required class="input sm" style="width:100%">
                  <option value="">-- Select Site Pump / Tank --</option>
                  ${tanks.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${esc(t.project_name || t.code)})</option>`).join('')}
                </select>
              </div>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#6d28d9;cursor:pointer">
                <input type="checkbox" id="fr_full_tank">
                <span>⛽ Full Tank (enter actual litres at pump after fill)</span>
              </label>
              <div>
                <label style="font-size:12px;font-weight:600">Trip Total Fuel (L)</label>
                <input type="number" step="0.1" id="fr_litres" class="input sm" placeholder="50 (optional if Full Tank)" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Work Purpose / Route Note</label>
                <input type="text" id="fr_reason" class="input sm" placeholder="Site excavation / transport duty" style="width:100%">
              </div>
              <button type="submit" class="btn primary sm">Submit Fuel Request</button>
            </form>
          </div>

          <div class="card" style="padding:16px">
            <h3 style="margin:0 0 10px 0;font-size:15px">📋 Fuel Requisitions Queue</h3>
            <table class="table" style="width:100%;font-size:12.5px">
              <thead>
                <tr><th>Req #</th><th>Date</th><th>Vehicle / RC</th><th style="text-align:right">Rec / Req</th><th>Meter</th><th>Pump / Site</th><th>Status</th><th>Action</th></tr>
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
              <td>${vehBadge(r, { stacked: true })}<div class="muted" style="font-size:10.5px;margin-top:2px">RC:${esc(r.running_chart_no || 'Site Log')}</div></td>
              <td style="text-align:right;font-weight:700">${r.recommended_litres != null ? fmtNum(r.recommended_litres, 1) + 'L rec / ' : ''}${r.is_full_tank ? '<span class="badge" style="background:#7c3aed;color:#fff">FULL TANK</span>' : fmtNum(r.approved_litres || r.requested_litres, 1) + ' L'}</td>
              <td>${r.meter_faulty ? `<span class="badge warn" title="${esc(r.meter_fault_reason || 'Meter Faulty')}">⚠️ FAULTY</span>` : (r.meter_reading ? fmtNum(r.meter_reading, 1) : '—')}</td>
              <td>${esc(r.target_tank_name || r.station_name || r.project_name || '—')}</td>
              <td><span class="badge ${r.status === 'FULFILLED' || r.status === 'APPROVED' ? 'ok' : (r.status === 'REJECTED' ? 'danger' : 'warn')}">${r.status === 'PENDING' ? (r.exceeds_norm ? 'NEEDS MGR (>20%)' : 'AWAITING TRANSPORT') : (r.status === 'APPROVED' ? 'READY AT PUMP' : esc(r.status))}</span></td>
              <td style="white-space:nowrap">
                ${r.status === 'PENDING' && canApproveFuelReq(r) ? `
                  <button class="btn sm primary btn-fr-review" data-id="${esc(r.id)}">🛡️ Review</button>
                ` : (r.status === 'APPROVED' && canIssueFuel ? `
                  <button class="btn sm primary btn-fr-dispense" data-id="${esc(r.id)}">⛽ Dispense</button>
                ` : '—')}
              </td>
            </tr>
          `).join('');

          qsa('.btn-fr-review', tbody).forEach((b) => {
            b.onclick = () => {
              const reqObj = requests.find((x) => x.id === b.getAttribute('data-id'));
              if (!reqObj) return;
              if (typeof window.openTransportReviewModal === 'function') {
                window.openTransportReviewModal(reqObj, tanks, () => { loadReqs(); refreshKpis(); });
              }
            };
          });
          qsa('.btn-fr-dispense', tbody).forEach((b) => {
            b.onclick = () => {
              const reqObj = requests.find((x) => x.id === b.getAttribute('data-id'));
              if (reqObj && window.openPumpDispatchModal) {
                window.openPumpDispatchModal(reqObj, () => { loadReqs(); refreshKpis(); });
              }
            };
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="8" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      const frFaultChk = qs('#fr_meter_faulty', box);
      const frFaultWrap = qs('#fr_fault_wrap', box);
      const frFaultReasonInp = qs('#fr_meter_fault_reason', box);
      const frMeterInp = qs('#fr_meter', box);
      function syncFrFaultyUi() {
        const faulty = !!(frFaultChk && frFaultChk.checked);
        if (qs('#fr_meter_star', box)) qs('#fr_meter_star', box).style.display = faulty ? 'none' : 'inline';
        if (frMeterInp) {
          frMeterInp.required = !faulty;
          frMeterInp.disabled = faulty;
          if (faulty) frMeterInp.value = '';
        }
        if (frFaultWrap) frFaultWrap.style.display = faulty ? '' : 'none';
        if (frFaultReasonInp) frFaultReasonInp.required = faulty;
      }
      if (frFaultChk) frFaultChk.onchange = syncFrFaultyUi;

      qs('#form_fuel_req', box).onsubmit = async (e) => {
        e.preventDefault();
        const isFaulty = !!(frFaultChk && frFaultChk.checked);
        const faultReason = frFaultReasonInp ? frFaultReasonInp.value.trim() : '';
        const meterVal = !isFaulty && frMeterInp && frMeterInp.value !== '' ? Number(frMeterInp.value) : null;
        if (isFaulty) {
          if (faultReason.length < 3) return notify('Enter faulty meter reason (at least 3 characters)');
        } else if (!(Number.isFinite(meterVal) && meterVal > 0)) {
          return notify('Enter a valid Meter Reading (> 0) or mark Meter Faulty');
        }
        try {
          const isFull = qs('#fr_full_tank', box).checked;
          const rawLit = qs('#fr_litres', box).value;
          await api('/fuel/requests', {
            method: 'POST',
            body: {
              assetCode: qs('#fr_code', box).value.trim(),
              runningChartNo: qs('#fr_chart', box).value.trim() || null,
              meterReading: isFaulty ? null : meterVal,
              meterFaulty: isFaulty,
              meterFaultReason: isFaulty ? faultReason : null,
              approxKm: qs('#fr_approx', box).value !== '' ? Number(qs('#fr_approx', box).value) : null,
              targetTankId: qs('#fr_tank', box).value,
              isFullTank: isFull,
              tripTotalFuel: rawLit !== '' ? Number(rawLit) : null,
              tripPurpose: qs('#fr_reason', box).value.trim() || null,
            },
          });
          toast('Transport fuel request submitted!');
          qs('#form_fuel_req', box).reset();
          syncFrFaultyUi();
          loadReqs();
          refreshKpis();
        } catch (err) {
          notify(err.message);
        }
      };

      loadReqs();
    }

    if (window.LiveERP && typeof window.LiveERP.on === 'function') {
      let rtFuelTimer = null;
      const onLiveFuelOp = () => {
        if (!document.body.contains(content)) return;
        clearTimeout(rtFuelTimer);
        rtFuelTimer = setTimeout(() => {
          if (!document.body.contains(content)) return;
          refreshKpis();
          if (['site-console', 'requests', 'issues', 'corrections'].includes(activeTab)) {
            switchTab(activeTab, selectedVehicleCode);
          }
        }, 380);
      };
      window.LiveERP.on('fuel_request_updated', onLiveFuelOp);
      window.LiveERP.on('fuel_issue_updated', onLiveFuelOp);
    }
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel'] = renderFuelOperations;
  }
})();
