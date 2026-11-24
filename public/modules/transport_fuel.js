'use strict';

/**
 * Transport Fuel & Running Chart + "No Request, No Issue" Pump Dispatch & Cross-Check
 *
 * Route: #/transport-fuel
 * Tabs:
 *   1. New Request & Running Chart (Meter Reading, Approx KM/Hr, Live Recommended Fuel, Full Tank, All Sites)
 *   2. Pump Dispatch & Requests Queue (Manager >20% Approval + Pump Operator Dispense & Full Tank Post-Fill Entry)
 *   3. Cross-Check & Variance Audit (Running Chart vs Recommended vs Requested vs Actual + Excel Export)
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

  function fmtNum(val, dec = 1) {
    if (val === null || val === undefined || isNaN(Number(val))) return '—';
    return Number(val).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function fmtLkr(val) {
    return 'Rs ' + Number(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function localNowInputStr() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function localTodayStr() {
    if (typeof slToday === 'function') return slToday();
    return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function crossCheckBadge(status, varianceLitres, variancePct) {
    const varTxt = varianceLitres != null
      ? ` (${varianceLitres > 0 ? '+' : ''}${fmtNum(varianceLitres, 1)} L${variancePct != null ? ` / ${variancePct > 0 ? '+' : ''}${fmtNum(variancePct, 1)}%` : ''})`
      : '';
    const map = {
      OK: { cls: 'ok', bg: '#059669', txt: 'OK · Within Norm' },
      OVER_RECOMMENDED: { cls: 'danger', bg: '#dc2626', txt: 'OVER RECOMMENDED (>15%)' },
      UNDER_RECOMMENDED: { cls: 'warn', bg: '#d97706', txt: 'UNDER RECOMMENDED' },
      OVER_REQUESTED: { cls: 'danger', bg: '#b91c1c', txt: 'OVER REQUESTED (>10%)' },
      METER_MISMATCH: { cls: 'danger', bg: '#7f1d1d', txt: 'METER MISMATCH' },
      METER_FAULTY: { cls: 'warn', bg: '#b45309', txt: '⚠️ METER FAULTY' },
      NO_NORM: { cls: '', bg: '#64748b', txt: 'NO RATE NORM' },
    };
    const m = map[status] || { cls: '', bg: '#64748b', txt: status || 'PENDING' };
    return `<span class="badge ${m.cls}" style="background:${m.bg};color:#fff;white-space:nowrap">${esc(m.txt)}${esc(varTxt)}</span>`;
  }

  const tfComplianceCache = new Map();
  async function loadVehicleComplianceWarning(bannerEl, { assetId = null, assetCode = '' } = {}) {
    if (!bannerEl) return;
    const key = assetId ? `id:${assetId}` : `code:${String(assetCode || '').trim().toUpperCase()}`;
    if (!assetId && !String(assetCode || '').trim()) {
      bannerEl.style.display = 'none';
      return;
    }
    try {
      let info = tfComplianceCache.get(key);
      if (info === undefined) {
        const q = assetId
          ? `asset_ids=${encodeURIComponent(assetId)}`
          : `asset_code=${encodeURIComponent(String(assetCode).trim())}`;
        const res = await api(`/vehicle-documents/compliance-badges?${q}`);
        const byId = res && res.by_asset_id ? res.by_asset_id : {};
        const byCode = res && res.by_code ? res.by_code : {};
        const norm = String(assetCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        info = (assetId && byId[String(assetId)])
          || byCode[String(assetCode || '').trim().toUpperCase()]
          || byCode[norm]
          || Object.values(byId)[0]
          || null;
        tfComplianceCache.set(key, info);
      }
      if (!info || !info.badge) {
        bannerEl.style.display = 'none';
        return;
      }
      const isRed = info.badge.level === 'red';
      bannerEl.style.display = 'flex';
      bannerEl.style.background = isRed ? 'rgba(220,38,38,0.1)' : 'rgba(245,158,11,0.12)';
      bannerEl.style.border = `1px solid ${isRed ? '#dc2626' : '#d97706'}`;
      bannerEl.style.color = isRed ? '#991b1b' : '#92400e';
      bannerEl.innerHTML = `<span>${isRed ? '🚨' : '⚠️'} <b>Statutory Compliance Notice (Non-Blocking):</b> ${esc(info.badge.label)}${info.badge.detail ? ` — ${esc(info.badge.detail)}` : ''}</span><a class="btn sm" href="#/assets/${info.asset_id}" style="white-space:nowrap">View Docs →</a>`;
    } catch (_) {
      bannerEl.style.display = 'none';
    }
  }

  function statusBadge(r) {
    if (r.status === 'FULFILLED') return '<span class="badge ok" style="background:#059669;color:#fff">FULFILLED</span>';
    if (r.status === 'APPROVED') return '<span class="badge" style="background:#2563eb;color:#fff">READY AT PUMP</span>';
    if (r.status === 'PENDING') return '<span class="badge warn" style="background:#d97706;color:#fff">NEEDS APPROVAL (&gt;20%)</span>';
    if (r.status === 'REJECTED') return '<span class="badge danger" style="background:#dc2626;color:#fff">REJECTED</span>';
    if (r.status === 'CANCELLED') return '<span class="badge" style="background:#64748b;color:#fff">CANCELLED</span>';
    return `<span class="badge">${esc(r.status)}</span>`;
  }

  // Shared Pump Operator Dispatch Modal (supports both Fixed & Full Tank post-fill quantity entry)
  window.openPumpDispatchModal = async function (reqRow, onDone) {
    let tanks = [];
    try {
      const tRes = await api('/fuel/tanks').catch(() => ({ tanks: [] }));
      tanks = (tRes.tanks || []).filter((t) => t.active !== 0);
    } catch (_) {}

    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    const isFullTank = !!reqRow.is_full_tank;
    const isStation = reqRow.source_mode === 'STATION';
    const recLitres = reqRow.recommended_litres != null ? Number(reqRow.recommended_litres) : null;
    const defaultLitres = isFullTank ? '' : (reqRow.trip_total_fuel || reqRow.requested_litres || '');

    modal.innerHTML = `
      <div class="modal" style="max-width:600px;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <h2 style="margin:0;font-size:18px">⛽ Pump Operator Dispatch (1 Request = 1 Issue)</h2>
          <span class="badge" style="font-family:monospace">${esc(reqRow.request_no || reqRow.id)}</span>
        </div>
        <p class="muted" style="margin:0 0 12px 0;font-size:12px">
          ${isFullTank
            ? '<b>FULL TANK MODE:</b> Fill vehicle tank completely at the pump, then enter the exact dispensed litres below.'
            : 'Verify metered litres &amp; odometer/hour-meter against the approved Transport Fuel Request.'}
        </p>

        <div class="card" style="padding:12px;margin-bottom:14px;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.2);font-size:12px">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
            <div><span class="muted">Vehicle:</span><br><b>${esc(reqRow.asset_code)}</b></div>
            <div><span class="muted">Running Chart #:</span><br><b>${esc(reqRow.running_chart_no || '—')}</b></div>
            <div><span class="muted">Site / Project:</span><br><b>${esc(reqRow.project_name || 'Central')}</b></div>
            <div><span class="muted">Req Meter / Delta:</span><br><b>${reqRow.meter_faulty ? `<span class="badge warn" title="${esc(reqRow.meter_fault_reason || '')}">⚠️ METER FAULTY</span>` : (reqRow.meter_reading ? fmtNum(reqRow.meter_reading, 1) : '—')}</b> ${reqRow.approx_km ? `(${fmtNum(reqRow.approx_km, 1)} ${reqRow.meter_type === 'KM' ? 'km' : 'hr'})` : ''}</div>
            <div><span class="muted">Recommended Norm:</span><br><b style="color:#0369a1">${recLitres != null ? fmtNum(recLitres, 1) + ' L' : 'No Norm'}</b></div>
            <div><span class="muted">Requested / Mode:</span><br>${isFullTank ? '<span class="badge" style="background:#7c3aed;color:#fff">FULL TANK (Enter After Fill)</span>' : `<b>${fmtNum(reqRow.requested_litres, 1)} L</b>`}</div>
          </div>
          ${reqRow.driver_name || reqRow.trip_purpose ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed rgba(37,99,235,0.2)"><b>Driver:</b> ${esc(reqRow.driver_name || '—')} &nbsp;·&nbsp; <b>Trip:</b> ${esc(reqRow.trip_purpose || '—')}</div>` : ''}
        </div>
        <div id="pd_compliance_banner" style="display:none;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;margin-bottom:10px;font-size:12px"></div>

        <form id="form_pump_dispatch" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600;color:${isFullTank ? '#6d28d9' : 'inherit'}">
                ${isFullTank ? 'Actual Filled Litres (Post-Fill) *' : 'Actual Dispensed Litres *'}
              </label>
              <input type="number" step="0.01" min="0.1" id="pd_litres" required class="input" value="${esc(defaultLitres)}" placeholder="${isFullTank ? 'Enter exact L after full' : '0.00'}" style="width:100%;${isFullTank ? 'border-color:#7c3aed;font-weight:700' : ''}">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Fuel Rate (Rs / L)</label>
              <input type="number" step="0.01" min="0" id="pd_price_rs" class="input" placeholder="Auto tariff" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Issue Date &amp; Time</label>
              <input type="datetime-local" id="pd_date" class="input" style="width:100%">
            </div>
          </div>

          <div id="pd_variance_banner" style="display:none;padding:9px 12px;border-radius:8px;font-size:12px"></div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">${isStation ? 'Filling Station *' : 'Pump / Bulk Tank *'}</label>
              ${isStation
                ? `<input type="text" id="pd_station" required class="input" value="${esc(reqRow.station_name || '')}" style="width:100%">`
                : `<select id="pd_tank_id" required class="input" style="width:100%" ${ME && ME.fuelScope && ME.fuelScope.scoped && tanks.length <= 1 ? 'disabled' : ''}>
                    ${!(ME && ME.fuelScope && ME.fuelScope.scoped && tanks.length <= 1) ? '<option value="">-- Select Tank / Bowser --</option>' : ''}
                    ${tanks.map((t) => `<option value="${esc(t.id)}" ${String(reqRow.target_tank_id || (tanks.length === 1 ? t.id : '')) === String(t.id) ? 'selected' : ''}>${esc(t.name)} (${esc(t.project_name || t.code)})</option>`).join('')}
                  </select>`}
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Pump Verified Meter (${esc(reqRow.meter_type || 'KM/HR')})</label>
              <input type="number" step="0.1" id="pd_meter" class="input" value="${!reqRow.meter_faulty && reqRow.meter_reading != null ? esc(reqRow.meter_reading) : ''}" ${reqRow.meter_faulty ? 'disabled' : ''} placeholder="Enter meter reading" style="width:100%">
            </div>
          </div>

          <div style="padding:8px 10px;border-radius:6px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.28)">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#92400e;cursor:pointer">
              <input type="checkbox" id="pd_meter_faulty" ${reqRow.meter_faulty ? 'checked' : ''}>
              <span>⚠️ Meter Faulty / Not Working (logs repair alert instead of blank reading)</span>
            </label>
            <div id="pd_fault_reason_wrap" style="margin-top:6px;${reqRow.meter_faulty ? '' : 'display:none'}">
              <input type="text" id="pd_meter_fault_reason" class="input" value="${esc(reqRow.meter_fault_reason || '')}" placeholder="Fault reason * (e.g. Hour meter blank / cable snapped)" style="width:100%">
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Pump Operator / Driver</label>
              <input type="text" id="pd_driver" class="input" value="${esc(reqRow.driver_name || '')}" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Pump Slip / Remarks</label>
              <input type="text" id="pd_notes" class="input" placeholder="Optional meter slip or full-tank check note" style="width:100%">
            </div>
          </div>

          <label id="pd_override_wrap" style="display:none;font-size:12px;color:#b45309;align-items:center;gap:6px;background:rgba(245,158,11,0.12);padding:8px 10px;border-radius:6px">
            <input type="checkbox" id="pd_override_meter">
            <span>Override Meter Guard warning (confirmed physical reading)</span>
          </label>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
            <button type="button" class="btn" id="pd_cancel">Cancel</button>
            <button type="submit" class="btn primary" id="pd_submit">⛽ Confirm Dispatch &amp; Cross-Check</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    const dateInp = modal.querySelector('#pd_date');
    dateInp.value = localNowInputStr();
    loadVehicleComplianceWarning(modal.querySelector('#pd_compliance_banner'), {
      assetId: reqRow.asset_id,
      assetCode: reqRow.asset_code,
    });
    const litresInp = modal.querySelector('#pd_litres');
    const priceRsInp = modal.querySelector('#pd_price_rs');
    const varBanner = modal.querySelector('#pd_variance_banner');
    let priceEdited = false;

    async function loadTariff() {
      if (priceEdited) return;
      try {
        const ft = reqRow.fuel_type || 'AUTO_DIESEL';
        const dt = String(dateInp.value || localTodayStr()).slice(0, 10);
        const res = await api(`/fuel/prices/lookup?fuelType=${encodeURIComponent(ft)}&date=${encodeURIComponent(dt)}`);
        if (!priceEdited && res && res.pricePerLitreCents > 0) {
          priceRsInp.value = (res.pricePerLitreCents / 100).toFixed(2);
        }
      } catch (_) {}
    }
    loadTariff();
    dateInp.onchange = loadTariff;
    priceRsInp.oninput = () => { priceEdited = priceRsInp.value.trim() !== ''; };

    function updateVariancePreview() {
      const l = Number(litresInp.value || 0);
      if (!l || l <= 0) {
        varBanner.style.display = 'none';
        return;
      }
      varBanner.style.display = 'block';
      if (recLitres != null && recLitres > 0) {
        const diff = Math.round((l - recLitres) * 10) / 10;
        const pct = Math.round(((l - recLitres) / recLitres) * 1000) / 10;
        const over = l > recLitres * 1.15;
        const under = l < recLitres * 0.65;
        varBanner.style.background = over ? 'rgba(220,38,38,0.12)' : (under ? 'rgba(245,158,11,0.12)' : 'rgba(16,185,129,0.1)');
        varBanner.style.border = over ? '1px solid #dc2626' : (under ? '1px solid #d97706' : '1px solid rgba(16,185,129,0.35)');
        varBanner.innerHTML = `${over ? '🚨 <b>CROSS-CHECK WARNING:</b> Exceeds recommended fuel by ' : (under ? '⚠️ <b>LOW FILL NOTICE:</b> Below recommended by ' : '✅ <b>CROSS-CHECK OK:</b> Variance vs Recommended: ')}<b>${diff > 0 ? '+' : ''}${fmtNum(diff, 1)} L (${pct > 0 ? '+' : ''}${fmtNum(pct, 1)}%)</b>`;
      } else {
        varBanner.style.background = 'rgba(100,116,139,0.1)';
        varBanner.style.border = '1px solid rgba(100,116,139,0.3)';
        varBanner.innerHTML = `ℹ️ Issuing <b>${fmtNum(l, 1)} L</b> against request <b>${esc(reqRow.request_no)}</b> (No vehicle consumption norm configured).`;
      }
    }
    litresInp.oninput = updateVariancePreview;
    updateVariancePreview();

    const pdFaultyChk = modal.querySelector('#pd_meter_faulty');
    const pdFaultWrap = modal.querySelector('#pd_fault_reason_wrap');
    const pdFaultReasonInp = modal.querySelector('#pd_meter_fault_reason');
    const pdMeterInp = modal.querySelector('#pd_meter');
    if (pdFaultyChk) {
      pdFaultyChk.onchange = () => {
        const isFaulty = pdFaultyChk.checked;
        if (pdFaultWrap) pdFaultWrap.style.display = isFaulty ? '' : 'none';
        if (pdMeterInp) {
          pdMeterInp.disabled = isFaulty;
          if (isFaulty) pdMeterInp.value = '';
        }
      };
    }

    modal.querySelector('#pd_cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.querySelector('#form_pump_dispatch').onsubmit = async (e) => {
      e.preventDefault();
      const isFaulty = !!(pdFaultyChk && pdFaultyChk.checked);
      const faultReason = pdFaultReasonInp ? pdFaultReasonInp.value.trim() : '';
      const meterVal = !isFaulty && pdMeterInp && pdMeterInp.value !== '' ? Number(pdMeterInp.value) : null;
      if (isFaulty) {
        if (faultReason.length < 3) {
          notify('Enter the faulty meter reason (at least 3 characters)', 'err');
          return;
        }
      } else if (!(Number.isFinite(meterVal) && meterVal > 0)) {
        notify('Enter a valid Pump Verified Meter reading (> 0), or mark Meter Faulty', 'err');
        return;
      }

      const btn = modal.querySelector('#pd_submit');
      btn.disabled = true;
      btn.textContent = 'Recording...';
      try {
        const rawRate = priceRsInp.value.trim();
        const fuelPriceCents = rawRate !== '' && Number(rawRate) > 0 ? Math.round(Number(rawRate) * 100) : null;
        const tankSel = modal.querySelector('#pd_tank_id');
        const stInp = modal.querySelector('#pd_station');
        const body = {
          litres: Number(litresInp.value),
          fuelPriceCents,
          issueDate: dateInp.value ? dateInp.value.replace('T', ' ') : null,
          sourceTankId: tankSel ? (tankSel.value || null) : null,
          stationName: stInp ? stInp.value.trim() : null,
          meterReading: meterVal,
          meterFaulty: isFaulty,
          meterFaultReason: isFaulty ? faultReason : null,
          driverName: modal.querySelector('#pd_driver').value.trim() || null,
          notes: modal.querySelector('#pd_notes').value.trim() || null,
          ignoreMeterWarning: modal.querySelector('#pd_override_meter').checked,
        };
        const res = await api(`/fuel/requests/${encodeURIComponent(reqRow.id)}/issue`, { method: 'POST', body });
        const iss = res.issue || {};
        toast(`Issued ${fmtNum(iss.litres, 1)} L (${iss.issue_no || 'Saved'}) · Cross-Check: ${iss.cross_check_status || 'OK'}`);
        modal.remove();
        if (typeof onDone === 'function') onDone(res);
      } catch (err) {
        if (String(err.message || '').toLowerCase().includes('backwards') || String(err.message || '').toLowerCase().includes('last recorded')) {
          modal.querySelector('#pd_override_wrap').style.display = 'flex';
        }
        notify(err.message || 'Failed to record pump issue', 'err');
        btn.disabled = false;
        btn.textContent = '⛽ Confirm Dispatch & Cross-Check';
      }
    };
  };

  async function renderTransportFuel(content) {
    const hashParts = (location.hash || '').split('?');
    const queryParams = new URLSearchParams(hashParts[1] || '');
    let activeTab = queryParams.get('tab') || 'request';

    const canReq = isAdmin() || canDo('fuel.transport.request', 'fuel.request');
    const canApprove = isAdmin() || canDo('fuel.approve_request', 'fuel.approve');
    const canIssue = isAdmin() || canDo('fuel.issue');
    const canAudit = isAdmin() || canDo('fuel.transport.crosscheck', 'fuel.reports.view');

    let bootstrap = { tanks: [], projects: [], vehicles: [], fuelScope: (ME && ME.fuelScope) || {} };
    try {
      const tbRes = await api('/fuel/transport-bootstrap').catch(() => null);
      if (tbRes) {
        bootstrap.tanks = tbRes.tanks || [];
        bootstrap.projects = tbRes.projects || [];
        bootstrap.vehicles = tbRes.vehicles || [];
        if (tbRes.fuelScope) bootstrap.fuelScope = tbRes.fuelScope;
      }
    } catch (_) {}

    const tfScope = bootstrap.fuelScope || (ME && ME.fuelScope) || {};
    const isScopedSite = !!tfScope.scoped;
    const defaultProjectId = isScopedSite && tfScope.projectId != null
      ? String(tfScope.projectId)
      : ((ME && (ME.assignedProjectId || ME.activeProjectId)) ? String(ME.assignedProjectId || ME.activeProjectId) : 'ALL');
    const defaultTankId = (tfScope.tankId ? String(tfScope.tankId) : '')
      || ((ME && ME.assignedTankId) ? String(ME.assignedTankId) : '')
      || (isScopedSite && bootstrap.tanks.length === 1 ? String(bootstrap.tanks[0].id) : '');

    if (activeTab === 'crosscheck' && !canAudit) activeTab = canReq ? 'request' : 'queue';

    content.innerHTML = `
      <div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:14px">
        <div>
          <h1 style="margin:0;font-size:22px">🚛 Transport Fuel &amp; Running Chart</h1>
          <p class="muted" style="margin:4px 0 0 0;font-size:12.5px">
            <b>No Request, No Issue</b> · Raise site fuel requests with Meter Reading, Recommended Fuel &amp; Full Tank Post-Fill
            ${isScopedSite && bootstrap.projects[0] ? ` · <span class="badge blue">🔒 Site-Locked: ${esc(bootstrap.projects[0].name)}</span>` : ''}
          </p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="tf_global_site" class="input sm" style="min-width:190px" ${isScopedSite && bootstrap.projects.length <= 1 ? 'disabled' : ''}>
            ${!isScopedSite ? '<option value="ALL">🌐 All Sites &amp; Projects</option>' : ''}
            ${bootstrap.projects.map((p) => `<option value="${esc(p.id)}" ${defaultProjectId === String(p.id) ? 'selected' : ''}>${esc(p.code ? p.code + ' · ' + p.name : p.name)}</option>`).join('')}
          </select>
          <select id="tf_global_tank" class="input sm" style="min-width:210px" ${isScopedSite && bootstrap.tanks.length <= 1 ? 'disabled' : ''}>
            ${!isScopedSite ? '<option value="ALL">🛢️ All Site Pumps / Tanks</option>' : ''}
            ${bootstrap.tanks.map((t) => `<option value="${esc(t.id)}" ${defaultTankId === String(t.id) ? 'selected' : ''}>${esc(t.name)} (${esc(t.project_name || 'Central')})</option>`).join('')}
          </select>
        </div>
      </div>

      <div id="tf_summary_strip" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:10px;margin-bottom:14px"></div>

      <div class="tabs" id="tf_tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:8px">
        <button class="btn tf-tab ${activeTab === 'request' ? 'primary' : ''}" data-tab="request">📝 1. Request &amp; Running Chart</button>
        <button class="btn tf-tab ${activeTab === 'queue' ? 'primary' : ''}" data-tab="queue">⛽ 2. Pump Dispatch &amp; Requests Queue <span id="tf_queue_badge" class="badge" style="margin-left:4px">0</span></button>
        ${canAudit ? `<button class="btn tf-tab ${activeTab === 'crosscheck' ? 'primary' : ''}" data-tab="crosscheck">🔍 3. Cross-Check &amp; Variance Audit</button>` : ''}
      </div>

      <div id="tf_tab_body"></div>
    `;

    const siteSel = qs('#tf_global_site', content);
    const tankSel = qs('#tf_global_tank', content);

    async function refreshSummary() {
      const strip = qs('#tf_summary_strip', content);
      try {
        const q = new URLSearchParams();
        if (siteSel.value && siteSel.value !== 'ALL') q.set('projectId', siteSel.value);
        if (tankSel.value && tankSel.value !== 'ALL') q.set('tankId', tankSel.value);
        const [reqRes, ccRes] = await Promise.all([
          api(`/fuel/requests?${q.toString()}`),
          canAudit ? api(`/fuel/cross-check?${q.toString()}`).catch(() => ({ summary: {} })) : Promise.resolve({ summary: null }),
        ]);
        const reqs = reqRes.requests || [];
        const readyPump = reqs.filter((r) => r.status === 'APPROVED').length;
        const needMgr = reqs.filter((r) => r.status === 'PENDING').length;
        const fulfilledLocal = reqs.filter((r) => r.status === 'FULFILLED').length;
        const fullTankLocal = reqs.filter((r) => r.is_full_tank).length;
        const s = (ccRes && ccRes.summary) || {
          fulfilledCount: fulfilledLocal,
          fullTankCount: fullTankLocal,
        };
        const qBadge = qs('#tf_queue_badge', content);
        if (qBadge) qBadge.textContent = String(readyPump + needMgr);

        strip.innerHTML = `
          <div class="card kpi-card" style="padding:12px 14px">
            <div class="muted" style="font-size:11px;font-weight:600">READY AT PUMP (APPROVED)</div>
            <div style="font-size:22px;font-weight:800;color:#2563eb">${readyPump}</div>
            <div class="muted" style="font-size:11px">${needMgr} pending manager (&gt;20%)</div>
          </div>
          <div class="card kpi-card" style="padding:12px 14px">
            <div class="muted" style="font-size:11px;font-weight:600">FULFILLED AT PUMP</div>
            <div style="font-size:22px;font-weight:800;color:#059669">${s.fulfilledCount || 0}</div>
            <div class="muted" style="font-size:11px">${s.fullTankCount || 0} Full Tank post-fill</div>
          </div>
          ${canAudit ? `
          <div class="card kpi-card" style="padding:12px 14px">
            <div class="muted" style="font-size:11px;font-weight:600">RECOMMENDED VS ACTUAL</div>
            <div style="font-size:20px;font-weight:800">${fmtNum(s.totalActualLitres || 0, 1)} L <span class="muted" style="font-size:12px">/ ${fmtNum(s.totalRecommendedLitres || 0, 1)} L</span></div>
            <div class="muted" style="font-size:11px">Net Variance: <b>${(s.netVarianceLitres || 0) > 0 ? '+' : ''}${fmtNum(s.netVarianceLitres || 0, 1)} L</b></div>
          </div>
          <div class="card kpi-card" style="padding:12px 14px;${(s.flaggedCount || 0) > 0 ? 'border-color:#dc2626' : ''}">
            <div class="muted" style="font-size:11px;font-weight:600">CROSS-CHECK FLAGS</div>
            <div style="font-size:22px;font-weight:800;color:${(s.flaggedCount || 0) > 0 ? '#dc2626' : '#059669'}">${s.flaggedCount || 0}</div>
            <div class="muted" style="font-size:11px">${s.overRecommendedCount || 0} over-norm · ${s.meterMismatchCount || 0} meter flag</div>
          </div>` : `
          <div class="card kpi-card" style="padding:12px 14px">
            <div class="muted" style="font-size:11px;font-weight:600">TOTAL SITE REQUESTS</div>
            <div style="font-size:22px;font-weight:800">${reqs.length}</div>
            <div class="muted" style="font-size:11px">Scoped to your assigned site</div>
          </div>`}
        `;
      } catch (_) {}
    }

    function switchTab(tab) {
      activeTab = tab;
      qsa('.tf-tab', content).forEach((b) => b.classList.toggle('primary', b.getAttribute('data-tab') === tab));
      renderActiveTab();
    }

    qsa('.tf-tab', content).forEach((b) => {
      b.onclick = () => switchTab(b.getAttribute('data-tab'));
    });

    siteSel.onchange = () => {
      // Filter tank selector choices optionally or keep all visible while filtering data
      refreshSummary();
      renderActiveTab();
    };
    tankSel.onchange = () => {
      refreshSummary();
      renderActiveTab();
    };

    async function renderActiveTab() {
      const box = qs('#tf_tab_body', content);
      if (activeTab === 'request') await renderRequestTab(box);
      else if (activeTab === 'queue') await renderQueueTab(box);
      else if (activeTab === 'crosscheck') await renderCrossCheckTab(box);
    }

    // -----------------------------------------------------------------------
    // TAB 1: Raise Transport Fuel Request & Running Chart
    // -----------------------------------------------------------------------
    async function renderRequestTab(box) {
      const initTank = tankSel.value !== 'ALL'
        ? tankSel.value
        : (defaultTankId || (bootstrap.tanks[0] && bootstrap.tanks[0].id) || '');

      box.innerHTML = `
        <div style="display:grid;grid-template-columns:1.25fr 1fr;gap:14px;align-items:start">
          <div class="card" style="padding:18px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <h3 style="margin:0;font-size:16px">📝 New Transport Fuel &amp; Running Chart Request</h3>
              <span class="badge" style="background:#0f172a;color:#fff">Auto Recommended Fuel</span>
            </div>
            ${!canReq ? `<div class="card" style="padding:12px;background:rgba(245,158,11,0.1);border:1px solid #d97706">You have view-only access to Transport Fuel.</div>` : `
            <form id="tf_form_request" style="display:flex;flex-direction:column;gap:12px">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div>
                  <label style="font-size:12px;font-weight:600">Vehicle / Machine Code *</label>
                  <input type="text" id="tfr_asset" required list="tfr_veh_list" class="input" placeholder="e.g. DC-25, LB-22, EX-01" style="width:100%">
                  <datalist id="tfr_veh_list">
                    ${bootstrap.vehicles.map((v) => `<option value="${esc(v.code)}">${esc(v.registration || '')} · ${esc(v.category || '')} · ${esc(v.current_site || '')}</option>`).join('')}
                  </datalist>
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Site / Project</label>
                  <select id="tfr_project" class="input" style="width:100%" ${isScopedSite && bootstrap.projects.length <= 1 ? 'disabled' : ''}>
                    ${!isScopedSite ? '<option value="">Auto from Target Tank / Asset</option>' : ''}
                    ${bootstrap.projects.map((p) => `<option value="${esc(p.id)}" ${(siteSel.value === String(p.id) || (isScopedSite && bootstrap.projects.length === 1)) ? 'selected' : ''}>${esc(p.code ? p.code + ' · ' + p.name : p.name)}</option>`).join('')}
                  </select>
                </div>
              </div>

              <div id="tfr_compliance_banner" style="display:none;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;font-size:12px"></div>

              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
                <div>
                  <label style="font-size:12px;font-weight:600">Running Chart No *</label>
                  <input type="text" id="tfr_chart_no" required class="input" placeholder="e.g. RC-2026-1042" style="width:100%">
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Driver / Operator</label>
                  <input type="text" id="tfr_driver" class="input" placeholder="Driver name" style="width:100%">
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Trip Purpose / Route</label>
                  <input type="text" id="tfr_purpose" class="input" placeholder="e.g. Badalgama -> CEP-03 haul" style="width:100%">
                </div>
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:10px;border-radius:8px;background:rgba(15,23,42,0.03);border:1px solid var(--border)">
                <div>
                  <label style="font-size:12px;font-weight:600">Previous Meter Reading</label>
                  <input type="number" step="0.1" id="tfr_prev_meter" class="input" placeholder="Auto loaded" style="width:100%;background:rgba(148,163,184,0.1)">
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Current Meter Reading <span id="tfr_meter_star">*</span></label>
                  <input type="number" step="0.1" min="0.1" id="tfr_meter" required class="input" placeholder="Running chart meter" style="width:100%">
                  <label style="display:flex;align-items:center;gap:6px;margin-top:5px;font-size:11.5px;font-weight:600;color:#b45309;cursor:pointer">
                    <input type="checkbox" id="tfr_meter_faulty">
                    <span>⚠️ Meter Faulty / Not Working</span>
                  </label>
                  <div id="tfr_fault_wrap" style="display:none;margin-top:5px">
                    <input type="text" id="tfr_meter_fault_reason" class="input" placeholder="Fault reason * (e.g. Hour meter blank)" style="width:100%;font-size:11.5px">
                  </div>
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Approx KM / Hours <span id="tfr_approx_src" class="muted" style="font-weight:400">(auto or manual)</span></label>
                  <input type="number" step="0.1" min="0" id="tfr_approx_km" class="input" placeholder="Auto from delta or manual" style="width:100%">
                </div>
              </div>

              <div id="tfr_calc_banner" style="padding:12px;border-radius:8px;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.2);font-size:12.5px">
                Enter vehicle code and Running Chart meter reading / Approx KM to calculate <b>Recommended Fuel Quantity</b>.
              </div>

              <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:10px;align-items:end">
                <div>
                  <label style="font-size:12px;font-weight:600">Fuel Source *</label>
                  <select id="tfr_source_mode" class="input" style="width:100%">
                    <option value="TANK">Site Pump / Bulk Tank / Bowser</option>
                    <option value="STATION">External Filling Station</option>
                  </select>
                </div>
                <div id="tfr_tank_wrap">
                  <label style="font-size:12px;font-weight:600">Target Pump Operator / Tank *</label>
                  <select id="tfr_tank_id" class="input" style="width:100%" ${isScopedSite && bootstrap.tanks.length <= 1 ? 'disabled' : ''}>
                    ${!(isScopedSite && bootstrap.tanks.length <= 1) ? '<option value="">-- Select Site Tank / Pump --</option>' : ''}
                    ${bootstrap.tanks.map((t) => `<option value="${esc(t.id)}" ${String(initTank) === String(t.id) ? 'selected' : ''}>🛢️ ${esc(t.name)} (${esc(t.project_name || 'Central')})</option>`).join('')}
                  </select>
                </div>
                <div id="tfr_station_wrap" style="display:none">
                  <label style="font-size:12px;font-weight:600">External Filling Station Name *</label>
                  <input type="text" id="tfr_station_name" class="input" placeholder="e.g. Ceypetco Divulapitiya" style="width:100%">
                </div>
              </div>

              <div style="padding:12px;border-radius:8px;border:1px solid rgba(124,58,237,0.28);background:rgba(124,58,237,0.05)">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;font-size:13px;color:#5b21b6">
                  <input type="checkbox" id="tfr_full_tank">
                  <span>⛽ Full Tank Issue (Pump operator fills full tank first &amp; enters actual litres after)</span>
                </label>
                <div id="tfr_trip_fuel_row" style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
                  <div>
                    <label style="font-size:12px;font-weight:600">Trip Total Fuel Requested (L) <span id="tfr_fuel_req_star">*</span></label>
                    <input type="number" step="0.1" min="0" id="tfr_trip_fuel" class="input" placeholder="e.g. 45.0" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:12px;font-weight:600">Fuel Kind</label>
                    <select id="tfr_fuel_type" class="input" style="width:100%">
                      <option value="AUTO_DIESEL">Auto Diesel</option>
                      <option value="SUPER_DIESEL">Super Diesel</option>
                      <option value="PETROL_92">Petrol 92</option>
                      <option value="PETROL_95">Petrol 95</option>
                      <option value="KEROSENE">Kerosene</option>
                    </select>
                  </div>
                </div>
              </div>

              <div id="tfr_approval_warn" style="display:none;padding:10px 12px;border-radius:8px;background:rgba(245,158,11,0.14);border:1px solid #d97706;font-size:12px;color:#92400e"></div>

              <div style="display:flex;justify-content:flex-end;gap:8px">
                <button type="submit" class="btn primary" id="tfr_submit">📨 Submit Request to Pump / Queue</button>
              </div>
            </form>`}
          </div>

          <div class="card" style="padding:16px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <h3 style="margin:0;font-size:15px">⏱️ Recent Requests (This Filter)</h3>
              <button class="btn sm" id="tfr_go_queue">Open Dispatch Queue →</button>
            </div>
            <div id="tfr_recent_list" class="muted" style="font-size:12.5px">Loading...</div>
          </div>
        </div>
      `;

      qs('#tfr_go_queue', box).onclick = () => switchTab('queue');

      const form = qs('#tf_form_request', box);
      if (form) {
        const assetInp = qs('#tfr_asset', box);
        const prevMeterInp = qs('#tfr_prev_meter', box);
        const meterInp = qs('#tfr_meter', box);
        const meterFaultyChk = qs('#tfr_meter_faulty', box);
        const faultWrap = qs('#tfr_fault_wrap', box);
        const meterFaultReasonInp = qs('#tfr_meter_fault_reason', box);
        const approxInp = qs('#tfr_approx_km', box);
        const approxSrcEl = qs('#tfr_approx_src', box);
        const calcBanner = qs('#tfr_calc_banner', box);
        const srcModeSel = qs('#tfr_source_mode', box);
        const tankWrap = qs('#tfr_tank_wrap', box);
        const stationWrap = qs('#tfr_station_wrap', box);
        const tankIdSel = qs('#tfr_tank_id', box);
        const projectSel = qs('#tfr_project', box);
        const fullChk = qs('#tfr_full_tank', box);
        const tripFuelInp = qs('#tfr_trip_fuel', box);
        const approvalWarn = qs('#tfr_approval_warn', box);

        let lastRecommended = null;
        let manualApproxEdited = false;
        let calcTimer = null;

        function syncFaultyUi() {
          const faulty = !!(meterFaultyChk && meterFaultyChk.checked);
          if (qs('#tfr_meter_star', box)) qs('#tfr_meter_star', box).style.display = faulty ? 'none' : 'inline';
          if (meterInp) {
            meterInp.required = !faulty;
            meterInp.disabled = faulty;
            if (faulty) meterInp.value = '';
          }
          if (faultWrap) faultWrap.style.display = faulty ? '' : 'none';
          if (meterFaultReasonInp) meterFaultReasonInp.required = faulty;
        }
        if (meterFaultyChk) {
          meterFaultyChk.onchange = () => {
            syncFaultyUi();
            runRecommendCalc();
          };
        }

        srcModeSel.onchange = () => {
          const isSt = srcModeSel.value === 'STATION';
          tankWrap.style.display = isSt ? 'none' : 'block';
          stationWrap.style.display = isSt ? 'block' : 'none';
        };

        tankIdSel.onchange = () => {
          const t = bootstrap.tanks.find((x) => String(x.id) === String(tankIdSel.value));
          if (t) {
            if (t.fuel_type && FUEL_LABELS[t.fuel_type]) qs('#tfr_fuel_type', box).value = t.fuel_type;
            if (t.project_id && !projectSel.value) projectSel.value = String(t.project_id);
          }
        };

        function checkApprovalBand() {
          const trip = Number(tripFuelInp.value || 0);
          if (!fullChk.checked && lastRecommended != null && lastRecommended > 0 && trip > lastRecommended * 1.2) {
            const pct = Math.round(((trip - lastRecommended) / lastRecommended) * 100);
            approvalWarn.style.display = 'block';
            approvalWarn.innerHTML = `⚠️ <b>Manager Approval Required:</b> Trip Total Fuel (${fmtNum(trip, 1)} L) exceeds Recommended (${fmtNum(lastRecommended, 1)} L) by <b>+${pct}%</b> (&gt;20% threshold). Request will route to Manager approval first before reaching the Pump Operator.`;
          } else {
            approvalWarn.style.display = 'none';
          }
        }

        fullChk.onchange = () => {
          qs('#tfr_fuel_req_star', box).style.display = fullChk.checked ? 'none' : 'inline';
          tripFuelInp.required = !fullChk.checked;
          if (fullChk.checked) tripFuelInp.placeholder = 'Optional estimate (entered at pump after fill)';
          else tripFuelInp.placeholder = 'e.g. 45.0';
          checkApprovalBand();
        };

        async function runRecommendCalc() {
          const code = assetInp.value.trim();
          if (!code) return;
          try {
            const q = new URLSearchParams({ assetCode: code });
            if (meterInp.value !== '') q.set('meterReading', meterInp.value);
            if (prevMeterInp.value !== '') q.set('prevMeterReading', prevMeterInp.value);
            if (manualApproxEdited && approxInp.value !== '') q.set('approxKm', approxInp.value);
            const res = await api(`/fuel/recommend-calc?${q.toString()}`);

            if (res.prevMeter != null && !prevMeterInp.matches(':focus') && prevMeterInp.value === '') {
              prevMeterInp.value = res.prevMeter;
            }
            if (!manualApproxEdited && res.meterDelta != null && res.meterDelta > 0) {
              approxInp.value = res.meterDelta;
              approxSrcEl.textContent = `(auto delta: +${fmtNum(res.meterDelta, 1)})`;
            }

            lastRecommended = res.recommendedLitres;
            if (!res.found) {
              calcBanner.style.background = 'rgba(245,158,11,0.1)';
              calcBanner.style.borderColor = '#d97706';
              calcBanner.innerHTML = `⚠️ Vehicle <b>${esc(code)}</b> not in master register — norm lookup unavailable.`;
            } else if (!res.ok) {
              calcBanner.style.background = 'rgba(220,38,38,0.12)';
              calcBanner.style.borderColor = '#dc2626';
              calcBanner.innerHTML = `🛑 <b>Meter Error:</b> ${esc(res.warning)}`;
            } else {
              calcBanner.style.background = res.recommendedLitres ? 'rgba(16,185,129,0.1)' : 'rgba(37,99,235,0.06)';
              calcBanner.style.borderColor = res.recommendedLitres ? 'rgba(16,185,129,0.4)' : 'rgba(37,99,235,0.25)';
              const normTxt = res.displayNorm != null ? `${res.displayNorm} ${res.displayUnit}` : 'No rate norm configured';
              const recTxt = res.recommendedLitres != null
                ? `<b style="font-size:15px;color:#047857">${fmtNum(res.recommendedLitres, 1)} L</b>`
                : '<span class="muted">N/A (enter norm on Fleet Rates or fill manually)</span>';
              const bandDetail = res.recommendedBand && res.recommendedBand.econ != null
                ? ` <span class="muted">(Range: ${fmtNum(res.recommendedBand.econ, 1)} – ${fmtNum(res.recommendedBand.heavy, 1)} L)</span>`
                : '';
              calcBanner.innerHTML = `
                ✅ <b>${esc(res.asset.code)}</b> (${esc(res.asset.category || 'Vehicle')} · ${esc(res.meterType)})
                &nbsp;|&nbsp; Norm: <b>${esc(normTxt)}</b>
                <div style="margin-top:4px">
                  💡 <b>Recommended Fuel Quantity</b> for <b>${fmtNum(res.approxKm || 0, 1)} ${res.basis === 'hr' ? 'hrs' : 'km'}</b>: ${recTxt}${bandDetail}
                </div>
              `;
              if (!fullChk.checked && res.recommendedLitres && tripFuelInp.value === '') {
                tripFuelInp.value = res.recommendedLitres;
              }
            }
            checkApprovalBand();
          } catch (_) {}
        }

        assetInp.oninput = () => {
          prevMeterInp.value = '';
          if (!manualApproxEdited) approxInp.value = '';
          clearTimeout(calcTimer);
          calcTimer = setTimeout(() => {
            runRecommendCalc();
            loadVehicleComplianceWarning(qs('#tfr_compliance_banner', box), { assetCode: assetInp.value.trim() });
          }, 240);
        };
        meterInp.oninput = () => { clearTimeout(calcTimer); calcTimer = setTimeout(runRecommendCalc, 240); };
        prevMeterInp.oninput = () => { clearTimeout(calcTimer); calcTimer = setTimeout(runRecommendCalc, 240); };
        approxInp.oninput = () => {
          manualApproxEdited = approxInp.value.trim() !== '';
          approxSrcEl.textContent = manualApproxEdited ? '(manual entry)' : '(auto from delta)';
          clearTimeout(calcTimer);
          calcTimer = setTimeout(runRecommendCalc, 240);
        };
        tripFuelInp.oninput = checkApprovalBand;

        form.onsubmit = async (e) => {
          e.preventDefault();
          const faulty = !!(meterFaultyChk && meterFaultyChk.checked);
          const faultReason = meterFaultReasonInp ? meterFaultReasonInp.value.trim() : '';
          const mVal = !faulty && meterInp.value !== '' ? Number(meterInp.value) : null;
          if (faulty) {
            if (faultReason.length < 3) {
              notify('Enter the faulty meter reason (at least 3 characters)', 'err');
              return;
            }
          } else if (!(Number.isFinite(mVal) && mVal > 0)) {
            notify('Enter Current Meter Reading (> 0) or mark Meter Faulty with a reason', 'err');
            return;
          }
          const btn = qs('#tfr_submit', box);
          btn.disabled = true;
          btn.textContent = 'Submitting...';
          try {
            const isSt = srcModeSel.value === 'STATION';
            const created = await api('/fuel/requests', {
              method: 'POST',
              body: {
                assetCode: assetInp.value.trim(),
                projectId: projectSel.value ? Number(projectSel.value) : null,
                runningChartNo: qs('#tfr_chart_no', box).value.trim(),
                driverName: qs('#tfr_driver', box).value.trim() || null,
                tripPurpose: qs('#tfr_purpose', box).value.trim() || null,
                prevMeterReading: prevMeterInp.value !== '' ? Number(prevMeterInp.value) : null,
                meterReading: faulty ? null : mVal,
                meterFaulty: faulty,
                meterFaultReason: faulty ? faultReason : null,
                approxKm: approxInp.value !== '' ? Number(approxInp.value) : null,
                sourceMode: srcModeSel.value,
                targetTankId: isSt ? null : (tankIdSel.value || null),
                stationName: isSt ? qs('#tfr_station_name', box).value.trim() : null,
                isFullTank: fullChk.checked,
                tripTotalFuel: tripFuelInp.value !== '' ? Number(tripFuelInp.value) : null,
                fuelType: qs('#tfr_fuel_type', box).value,
              },
            });
            toast(created.status === 'PENDING'
              ? `${created.request_no} submitted for Manager Approval (>20% over recommended).`
              : `${created.request_no} sent straight to Pump Operator Queue!`);
            form.reset();
            syncFaultyUi();
            manualApproxEdited = false;
            lastRecommended = null;
            approvalWarn.style.display = 'none';
            await Promise.all([refreshSummary(), loadRecent()]);
          } catch (err) {
            notify(err.message || 'Failed to submit Transport Fuel Request', 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '📨 Submit Request to Pump / Queue';
          }
        };
      }

      async function loadRecent() {
        const el = qs('#tfr_recent_list', box);
        try {
          const q = new URLSearchParams({ limit: '15' });
          if (siteSel.value !== 'ALL') q.set('projectId', siteSel.value);
          if (tankSel.value !== 'ALL') q.set('tankId', tankSel.value);
          const { requests } = await api(`/fuel/requests?${q.toString()}`);
          if (!requests || !requests.length) {
            el.innerHTML = '<div style="padding:18px;text-align:center">No Transport Fuel Requests yet for this selection.</div>';
            return;
          }
          el.innerHTML = requests.map((r) => `
            <div style="padding:9px 10px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;align-items:center">
              <div>
                <div><b style="font-family:monospace">${esc(r.request_no)}</b> · <b>${esc(r.asset_code)}</b> ${r.running_chart_no ? `<span class="muted">RC:${esc(r.running_chart_no)}</span>` : ''}</div>
                <div class="muted" style="font-size:11.5px">${esc(r.project_name)} · ${esc(r.target_tank_name || r.station_name || '—')} · Rec: <b>${r.recommended_litres != null ? fmtNum(r.recommended_litres, 1) + 'L' : '—'}</b> · ${r.is_full_tank ? 'Full Tank' : 'Req: ' + fmtNum(r.requested_litres, 1) + 'L'}</div>
              </div>
              <div style="text-align:right">
                ${statusBadge(r)}
                ${r.status === 'APPROVED' && canIssue ? `<div style="margin-top:4px"><button class="btn sm primary tfr-quick-issue" data-id="${esc(r.id)}" style="padding:2px 8px;font-size:11px">⛽ Dispense</button></div>` : ''}
              </div>
            </div>
          `).join('');
          qsa('.tfr-quick-issue', el).forEach((b) => {
            b.onclick = () => {
              const reqObj = requests.find((x) => x.id === b.getAttribute('data-id'));
              if (reqObj) window.openPumpDispatchModal(reqObj, () => { refreshSummary(); loadRecent(); });
            };
          });
        } catch (err) {
          el.innerHTML = `<div class="err">${esc(err.message)}</div>`;
        }
      }
      loadRecent();
    }

    // -----------------------------------------------------------------------
    // TAB 2: Pump Dispatch & Requests Queue
    // -----------------------------------------------------------------------
    async function renderQueueTab(box) {
      box.innerHTML = `
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px">
            <h3 style="margin:0;font-size:16px">⛽ Pump Operator Queue &amp; Manager Approvals</h3>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <select id="tfq_status" class="input sm">
                <option value="OPEN">Open Queue (Ready at Pump + Pending Approval)</option>
                <option value="APPROVED">Ready at Pump Operator Only</option>
                <option value="PENDING">Pending Manager Approval (&gt;20%)</option>
                <option value="FULFILLED">Fulfilled</option>
                <option value="REJECTED">Rejected</option>
                <option value="ALL">All Statuses</option>
              </select>
              <input type="text" id="tfq_search" class="input sm" placeholder="Search Req #, Vehicle, Chart #..." style="min-width:210px">
              ${canReq ? '<button class="btn sm primary" id="tfq_new_btn">+ New Transport Request</button>' : ''}
            </div>
          </div>
          <div style="overflow-x:auto">
            <table class="table" style="width:100%;font-size:12.5px">
              <thead>
                <tr>
                  <th>Req #</th>
                  <th>Site &amp; Pump/Station</th>
                  <th>Vehicle &amp; Chart</th>
                  <th>Meter &amp; Approx</th>
                  <th style="text-align:right">Recommended</th>
                  <th style="text-align:right">Requested</th>
                  <th style="text-align:right">Actual Issued</th>
                  <th>Status / Cross-Check</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="tfq_tbody">
                <tr><td colspan="9" class="muted" style="text-align:center;padding:24px">Loading requests...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      if (qs('#tfq_new_btn', box)) qs('#tfq_new_btn', box).onclick = () => switchTab('request');
      const statusEl = qs('#tfq_status', box);
      const searchEl = qs('#tfq_search', box);

      async function loadQueue() {
        const tbody = qs('#tfq_tbody', box);
        try {
          const q = new URLSearchParams({ status: statusEl.value, limit: '200' });
          if (siteSel.value !== 'ALL') q.set('projectId', siteSel.value);
          if (tankSel.value !== 'ALL') q.set('tankId', tankSel.value);
          if (searchEl.value.trim()) q.set('search', searchEl.value.trim());

          const { requests } = await api(`/fuel/requests?${q.toString()}`);
          if (!requests || !requests.length) {
            tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">No requests match this filter.</td></tr>';
            return;
          }

          tbody.innerHTML = requests.map((r) => `
            <tr>
              <td>
                <div style="font-family:monospace;font-weight:700">${esc(r.request_no)}</div>
                <div class="muted" style="font-size:11px">${esc(String(r.requested_at || '').slice(0, 16).replace('T', ' '))}</div>
              </td>
              <td>
                <div><b>${esc(r.project_name)}</b></div>
                <div class="muted" style="font-size:11px">${r.source_mode === 'STATION' ? '⛽ ' + esc(r.station_name || 'External Station') : '🛢️ ' + esc(r.target_tank_name || 'Unassigned Tank')}</div>
              </td>
              <td>
                <div><b>${esc(r.asset_code)}</b></div>
                <div class="muted" style="font-size:11px">RC: <b>${esc(r.running_chart_no || '—')}</b>${r.driver_name ? ' · ' + esc(r.driver_name) : ''}</div>
              </td>
              <td>
                <div>${r.meter_faulty ? `<span class="badge warn" title="${esc(r.meter_fault_reason || 'Meter Faulty')}">⚠️ FAULTY</span>` : `${r.prev_meter_reading != null ? fmtNum(r.prev_meter_reading, 1) + ' → ' : ''}<b>${r.meter_reading != null ? fmtNum(r.meter_reading, 1) : '—'}</b>`}</div>
                <div class="muted" style="font-size:11px">Approx: <b>${r.approx_km != null ? fmtNum(r.approx_km, 1) : '—'} ${r.meter_type === 'KM' ? 'km' : 'hr'}</b></div>
              </td>
              <td style="text-align:right;font-weight:700;color:#0369a1">${r.recommended_litres != null ? fmtNum(r.recommended_litres, 1) + ' L' : '—'}</td>
              <td style="text-align:right">
                ${r.is_full_tank ? '<span class="badge" style="background:#7c3aed;color:#fff">FULL TANK</span>' : `<b>${fmtNum(r.requested_litres, 1)} L</b>`}
              </td>
              <td style="text-align:right;font-weight:700">${r.actual_issued_litres != null ? fmtNum(r.actual_issued_litres, 1) + ' L' : '—'}</td>
              <td>
                <div>${statusBadge(r)}</div>
                ${r.linked_cross_check_status ? `<div style="margin-top:4px">${crossCheckBadge(r.linked_cross_check_status, r.linked_variance_litres, r.linked_variance_pct)}</div>` : ''}
              </td>
              <td style="white-space:nowrap">
                ${r.status === 'PENDING' && canApprove ? `
                  <button class="btn sm primary tfq-act" data-id="${esc(r.id)}" data-act="APPROVE">✅ Approve</button>
                  <button class="btn sm danger tfq-act" data-id="${esc(r.id)}" data-act="REJECT">✕ Reject</button>
                ` : ''}
                ${r.status === 'APPROVED' && canIssue ? `
                  <button class="btn sm primary tfq-dispense" data-id="${esc(r.id)}">⛽ ${r.is_full_tank ? 'Full Tank · Enter Qty' : 'Dispense at Pump'}</button>
                ` : ''}
                ${(r.status === 'PENDING' || r.status === 'APPROVED') && canReq ? `
                  <button class="btn sm tfq-cancel" data-id="${esc(r.id)}" title="Cancel request">Cancel</button>
                ` : ''}
              </td>
            </tr>
          `).join('');

          qsa('.tfq-act', tbody).forEach((b) => {
            b.onclick = async () => {
              const id = b.getAttribute('data-id');
              const act = b.getAttribute('data-act');
              let rejectionReason = null;
              if (act === 'REJECT') {
                rejectionReason = prompt('Reason for rejecting this fuel request:');
                if (rejectionReason === null) return;
              }
              try {
                await api(`/fuel/requests/${encodeURIComponent(id)}/review`, {
                  method: 'POST',
                  body: { action: act, rejectionReason },
                });
                toast(act === 'APPROVE' ? 'Approved! Request is now in Pump Operator queue.' : 'Request rejected.');
                await Promise.all([refreshSummary(), loadQueue()]);
              } catch (err) {
                notify(err.message || 'Action failed', 'err');
              }
            };
          });

          qsa('.tfq-dispense', tbody).forEach((b) => {
            b.onclick = () => {
              const r = requests.find((x) => x.id === b.getAttribute('data-id'));
              if (r) window.openPumpDispatchModal(r, () => { refreshSummary(); loadQueue(); });
            };
          });

          qsa('.tfq-cancel', tbody).forEach((b) => {
            b.onclick = async () => {
              const reason = prompt('Reason for cancelling request:');
              if (reason === null) return;
              try {
                await api(`/fuel/requests/${encodeURIComponent(b.getAttribute('data-id'))}/cancel`, {
                  method: 'POST',
                  body: { reason: reason || 'Cancelled' },
                });
                toast('Request cancelled');
                await Promise.all([refreshSummary(), loadQueue()]);
              } catch (err) {
                notify(err.message || 'Cancel failed', 'err');
              }
            };
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="9" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      statusEl.onchange = loadQueue;
      let sTimer = null;
      searchEl.oninput = () => { clearTimeout(sTimer); sTimer = setTimeout(loadQueue, 220); };
      loadQueue();
    }

    // -----------------------------------------------------------------------
    // TAB 3: Cross-Check & Variance Audit (All Sites)
    // -----------------------------------------------------------------------
    async function renderCrossCheckTab(box) {
      box.innerHTML = `
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px">
            <h3 style="margin:0;font-size:16px">🔍 Fuel Request vs Recommended vs Pump Issue Cross-Check</h3>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <select id="tfcc_flag" class="input sm">
                <option value="ALL">All Cross-Check Rows</option>
                <option value="FLAGGED">⚠️ All Discrepancies Only</option>
                <option value="OVER_RECOMMENDED">🔴 Over Recommended (&gt;15%)</option>
                <option value="UNDER_RECOMMENDED">🟠 Under Recommended</option>
                <option value="OVER_REQUESTED">🚨 Over Requested (&gt;10%)</option>
                <option value="METER_MISMATCH">🛑 Meter Unchanged / Mismatch</option>
                <option value="METER_FAULTY">⚠️ Meter Faulty</option>
                <option value="OK">🟢 OK Only</option>
              </select>
              <input type="date" id="tfcc_from" class="input sm">
              <input type="date" id="tfcc_to" class="input sm">
              <input type="text" id="tfcc_search" class="input sm" placeholder="Search Req, Issue, Vehicle, Chart...">
              <button class="btn sm" id="tfcc_export" style="background:#0f766e;color:#fff">📥 Export Excel (.xlsx)</button>
            </div>
          </div>
          <div style="overflow-x:auto">
            <table class="table" style="width:100%;font-size:12px">
              <thead>
                <tr>
                  <th>Request / Issue</th>
                  <th>Site &amp; Pump/Station</th>
                  <th>Vehicle &amp; Chart #</th>
                  <th>Meter Movement</th>
                  <th style="text-align:right">Approx KM/Hr</th>
                  <th style="text-align:right">Recommended</th>
                  <th style="text-align:right">Requested</th>
                  <th style="text-align:right">Actual Issued</th>
                  <th style="text-align:right">Variance</th>
                  <th>Cross-Check Flag</th>
                </tr>
              </thead>
              <tbody id="tfcc_tbody">
                <tr><td colspan="10" class="muted" style="text-align:center;padding:24px">Loading cross-check report...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      const flagEl = qs('#tfcc_flag', box);
      const fromEl = qs('#tfcc_from', box);
      const toEl = qs('#tfcc_to', box);
      const searchEl = qs('#tfcc_search', box);

      function buildQuery() {
        const q = new URLSearchParams();
        if (siteSel.value !== 'ALL') q.set('projectId', siteSel.value);
        if (tankSel.value !== 'ALL') q.set('tankId', tankSel.value);
        if (flagEl.value !== 'ALL') q.set('flag', flagEl.value);
        if (fromEl.value) q.set('fromDate', fromEl.value);
        if (toEl.value) q.set('toDate', toEl.value);
        if (searchEl.value.trim()) q.set('search', searchEl.value.trim());
        return q.toString();
      }

      qs('#tfcc_export', box).onclick = () => {
        window.open(`/api/fuel/cross-check.xlsx?${buildQuery()}`, '_blank');
      };

      async function loadCrossCheck() {
        const tbody = qs('#tfcc_tbody', box);
        try {
          const res = await api(`/fuel/cross-check?${buildQuery()}`);
          const rows = res.rows || [];
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">No cross-check records found for this filter.</td></tr>';
            return;
          }
          tbody.innerHTML = rows.map((r) => `
            <tr>
              <td>
                <div style="font-family:monospace;font-weight:700">${esc(r.request_no)}</div>
                <div class="muted" style="font-size:11px">${r.issue_no ? esc(r.issue_no) + ' · ' + esc(String(r.issue_date || '').slice(0, 10)) : 'Awaiting pump issue'}</div>
              </td>
              <td>
                <div><b>${esc(r.project_name)}</b></div>
                <div class="muted" style="font-size:11px">${esc(r.pump_or_station)}</div>
              </td>
              <td>
                <div><b>${esc(r.asset_code)}</b></div>
                <div class="muted" style="font-size:11px">RC: ${esc(r.running_chart_no || '—')}${r.driver_name ? ' · ' + esc(r.driver_name) : ''}</div>
              </td>
              <td>${r.meter_faulty ? `<span class="badge warn" title="${esc(r.meter_fault_reason || 'Meter Faulty')}">⚠️ FAULTY</span>` : (r.prev_meter_reading != null ? fmtNum(r.prev_meter_reading, 1) + ' → ' : '') + (r.issue_meter_reading || r.request_meter_reading ? '<b>' + fmtNum(r.issue_meter_reading || r.request_meter_reading, 1) + '</b>' : '—')}</td>
              <td style="text-align:right">${r.approx_km != null ? fmtNum(r.approx_km, 1) : '—'}</td>
              <td style="text-align:right;font-weight:700;color:#0369a1">${r.recommended_litres != null ? fmtNum(r.recommended_litres, 1) + ' L' : '—'}</td>
              <td style="text-align:right">${r.is_full_tank ? '<span class="badge" style="background:#7c3aed;color:#fff">FULL TANK</span>' : fmtNum(r.requested_litres, 1) + ' L'}</td>
              <td style="text-align:right;font-weight:700">${r.actual_litres != null ? fmtNum(r.actual_litres, 1) + ' L' : '—'}</td>
              <td style="text-align:right;font-weight:700;color:${(r.variance_litres || 0) > 0 ? '#dc2626' : '#059669'}">${r.variance_litres != null ? (r.variance_litres > 0 ? '+' : '') + fmtNum(r.variance_litres, 1) + ' L' : '—'}</td>
              <td>${r.actual_litres != null ? crossCheckBadge(r.cross_check_status, null, r.variance_pct) : statusBadge({ status: r.request_status })}</td>
            </tr>
          `).join('');
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="10" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      flagEl.onchange = loadCrossCheck;
      fromEl.onchange = loadCrossCheck;
      toEl.onchange = loadCrossCheck;
      let cTimer = null;
      searchEl.oninput = () => { clearTimeout(cTimer); cTimer = setTimeout(loadCrossCheck, 220); };
      loadCrossCheck();
    }

    await refreshSummary();
    await renderActiveTab();
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['transport-fuel'] = renderTransportFuel;
  }
})();
