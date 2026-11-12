'use strict';

/**
 * WorkshopOne + Fuel-System-V2 Smart Meter Readings & Daily Condition Module (:1949)
 *
 * Mounts at window.routes['fuel-readings']
 * Provides:
 *   1. Unified Meter Readings Ledger (merges meter_readings + fuel_meter_readings + fuel_issues)
 *   2. Smart Meter Entry with Vehicle Code/Plate lookup & Live Meter Guard (rollback/spike check)
 *   3. Daily Fleet Working vs Breakdown Condition log (WORKING / BREAKDOWN)
 */

(function () {
  function fmtNum(val, dec = 1) {
    if (val === null || val === undefined || isNaN(Number(val))) return '—';
    return Number(val).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  async function renderFuelReadings(content) {
    let activeTab = 'meters';

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / <a href="#/fuel">Fuel System</a> / Smart Meter Readings &amp; Daily Condition</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:800">📟 Smart Meter Readings &amp; Daily Condition</h1>
          <p class="muted" style="margin:4px 0 0 0">Unified odometer/hour-meter ledger with Live Meter Guard coherence check and daily Working/Breakdown log</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="btn_new_reading">📟 + Enter Meter Reading</button>
          <button class="btn" id="btn_new_condition">🛠️ + Log Breakdown / Condition</button>
          <a href="#/fuel?tab=vehicle-360" class="btn">🚗 Vehicle 360° View</a>
        </div>
      </div>

      <div class="tabs" id="mr_tabs" style="display:flex;gap:6px;margin-bottom:14px;border-bottom:2px solid var(--border);padding-bottom:8px">
        <button class="btn sm primary" data-tab="meters">📟 Unified Meter Readings Ledger</button>
        <button class="btn sm" data-tab="conditions">🛠️ Daily Working vs Breakdown Condition</button>
      </div>

      <div id="mr_tab_box"></div>
    `;

    function switchTab(t) {
      activeTab = t;
      qsa('#mr_tabs button').forEach((b) => b.classList.toggle('primary', b.getAttribute('data-tab') === t));
      const box = qs('#mr_tab_box');
      if (t === 'meters') renderMetersTab(box);
      else renderConditionsTab(box);
    }

    qsa('#mr_tabs button').forEach((b) => {
      b.onclick = () => switchTab(b.getAttribute('data-tab'));
    });

    // Smart Meter Entry Modal with Live Meter Guard
    qs('#btn_new_reading').onclick = () => {
      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal card" style="max-width:500px;padding:24px">
          <h2 style="margin:0 0 6px 0;font-size:18px">📟 Enter Vehicle / Machine Meter Reading</h2>
          <p class="muted" style="margin:0 0 14px 0;font-size:12px">Search by Vehicle Code (e.g. LB-22, EX-01) or Registration Plate</p>
          <form id="form_smart_meter" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:600">Vehicle Code or Registration *</label>
              <input type="text" id="nr_asset_code" required class="input" placeholder="e.g. LB-22, EX-01, WP-CAB-1934" style="width:100%">
            </div>
            <div id="nr_guard_box" style="display:none;padding:10px 12px;border-radius:8px;font-size:12px"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Meter Reading Value *</label>
                <input type="number" id="nr_value" required class="input" placeholder="e.g. 4520.5" step="0.1" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Meter Unit</label>
                <select id="nr_type" class="input" style="width:100%">
                  <option value="HOURS">Hours (Machinery)</option>
                  <option value="KM">Kilometres (Road Vehicles)</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Reading Date *</label>
                <input type="date" id="nr_date" required class="input" value="${new Date().toISOString().slice(0, 10)}" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Source / Remarks</label>
                <input type="text" id="nr_notes" class="input" placeholder="Running chart / Daily log" style="width:100%">
              </div>
            </div>
            <label id="nr_override_wrap" style="display:none;font-size:12px;color:#b45309;align-items:center;gap:6px;cursor:pointer;background:rgba(245,158,11,0.1);padding:8px 10px;border-radius:6px">
              <input type="checkbox" id="nr_override">
              <span><b>Override Meter Guard:</b> Confirm meter replacement or verified reading</span>
            </label>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" id="btn_nr_cancel">Cancel</button>
              <button type="submit" class="btn primary" id="btn_nr_save">Save Meter Reading</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modal);

      const codeInp = modal.querySelector('#nr_asset_code');
      const valInp = modal.querySelector('#nr_value');
      const guardBox = modal.querySelector('#nr_guard_box');
      const overWrap = modal.querySelector('#nr_override_wrap');
      let timer = null;

      async function checkLive() {
        const c = codeInp.value.trim();
        if (!c) { guardBox.style.display = 'none'; return; }
        try {
          const res = await api(`/meters/check?asset_code=${encodeURIComponent(c)}&reading=${encodeURIComponent(valInp.value)}&date=${encodeURIComponent(modal.querySelector('#nr_date').value)}`);
          guardBox.style.display = 'block';
          if (!res.found) {
            guardBox.style.background = 'rgba(239,68,68,0.1)';
            guardBox.innerHTML = `⚠️ Vehicle "${esc(c)}" not found in master register`;
            return;
          }
          if (res.asset && res.asset.meter_type) {
            modal.querySelector('#nr_type').value = res.asset.meter_type;
          }
          const prevStr = res.previous
            ? `Previous Reading: <b>${fmtNum(res.previous.reading, 1)} ${esc(res.asset.meter_type)}</b> (${esc(String(res.previous.date || '').slice(0, 10))})`
            : 'No previous meter reading';
          const deltaStr = res.delta != null ? ` &nbsp;·&nbsp; Delta: <b>${res.delta >= 0 ? '+' : ''}${fmtNum(res.delta, 1)}</b>` : '';

          if (!res.ok && res.warning) {
            guardBox.style.background = 'rgba(220,38,38,0.12)';
            guardBox.style.border = '1px solid #dc2626';
            guardBox.innerHTML = `🛑 <b>METER ROLLBACK ALERT:</b> ${esc(res.warning)}<br><span class="muted">${prevStr}${deltaStr}</span>`;
            overWrap.style.display = 'flex';
          } else if (res.warning) {
            guardBox.style.background = 'rgba(245,158,11,0.12)';
            guardBox.innerHTML = `⚠️ <b>${esc(res.warning)}</b><br><span>✅ <b>${esc(res.asset.code)}</b> (${esc(res.asset.registration || '')}) · ${prevStr}${deltaStr}</span>`;
            overWrap.style.display = 'none';
          } else {
            guardBox.style.background = 'rgba(16,185,129,0.1)';
            guardBox.innerHTML = `✅ <b>${esc(res.asset.code)}</b> (${esc(res.asset.registration || 'No Reg')} · ${esc(res.asset.category || '')})<br>${prevStr}${deltaStr}`;
            overWrap.style.display = 'none';
          }
        } catch (_) {}
      }

      codeInp.oninput = () => { clearTimeout(timer); timer = setTimeout(checkLive, 200); };
      valInp.oninput = () => { clearTimeout(timer); timer = setTimeout(checkLive, 200); };

      modal.querySelector('#btn_nr_cancel').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelector('#form_smart_meter').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/meters', {
            method: 'POST',
            body: {
              asset_code: codeInp.value.trim(),
              reading: Number(valInp.value),
              meter_type: modal.querySelector('#nr_type').value,
              reading_date: modal.querySelector('#nr_date').value,
              notes: modal.querySelector('#nr_notes').value.trim(),
              ignore_warning: modal.querySelector('#nr_override').checked,
            },
          });
          toast('Meter reading saved and synced to asset profile!');
          modal.remove();
          switchTab('meters');
        } catch (err) {
          alert('Meter Guard: ' + err.message);
        }
      };
    };

    // Log Daily Working / Breakdown Condition Modal
    qs('#btn_new_condition').onclick = () => {
      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal card" style="max-width:460px;padding:24px">
          <h2 style="margin:0 0 12px 0;font-size:18px">🛠️ Log Daily Machine Condition</h2>
          <form id="form_cond" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:600">Vehicle / Machine Code *</label>
              <input type="text" id="cd_code" required class="input" placeholder="e.g. LB-22, EX-01" style="width:100%">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:600">Date *</label>
                <input type="date" id="cd_date" required class="input" value="${new Date().toISOString().slice(0, 10)}" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Condition Status *</label>
                <select id="cd_status" class="input" style="width:100%">
                  <option value="BREAKDOWN">🔴 BREAKDOWN (Down)</option>
                  <option value="WORKING">🟢 WORKING (Operational)</option>
                </select>
              </div>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Breakdown Reason / Defect</label>
              <input type="text" id="cd_reason" class="input" placeholder="e.g. Hydraulic hose burst / Engine overheat" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Remarks / Job Card Ref</label>
              <input type="text" id="cd_notes" class="input" placeholder="Notes" style="width:100%">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn" id="btn_cd_cancel">Cancel</button>
              <button type="submit" class="btn primary">Save Condition</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('#btn_cd_cancel').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      modal.querySelector('#form_cond').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/meters/conditions', {
            method: 'POST',
            body: {
              asset_code: modal.querySelector('#cd_code').value.trim(),
              date: modal.querySelector('#cd_date').value,
              status: modal.querySelector('#cd_status').value,
              reason: modal.querySelector('#cd_reason').value.trim(),
              notes: modal.querySelector('#cd_notes').value.trim(),
            },
          });
          toast('Daily condition logged!');
          modal.remove();
          switchTab('conditions');
        } catch (err) {
          alert(err.message);
        }
      };
    };

    // TAB 1: Unified Meter Readings
    async function renderMetersTab(box) {
      box.innerHTML = `
        <div class="card" style="padding:12px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input type="text" id="mr_search" class="input sm" placeholder="Search vehicle code, reg no, notes..." style="flex:1;min-width:220px">
          <select id="mr_source" class="input sm">
            <option value="ALL">All Reading Sources</option>
            <option value="MANUAL">Manual / Running Chart</option>
            <option value="FUEL_ISSUE">Fuel Dispense Slip</option>
          </select>
          <button class="btn sm primary" id="btn_mr_filter">Filter</button>
          <span class="muted" style="font-size:12px" id="mr_count">...</span>
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:12.5px">
            <thead>
              <tr style="background:rgba(0,0,0,0.02)">
                <th style="padding:10px 12px">Date</th>
                <th style="padding:10px 12px">Vehicle (360° Link)</th>
                <th style="padding:10px 12px">Registration</th>
                <th style="padding:10px 12px">Category</th>
                <th style="padding:10px 12px">Unit</th>
                <th style="padding:10px 12px;text-align:right">Meter Reading</th>
                <th style="padding:10px 12px">Source</th>
                <th style="padding:10px 12px">Recorded By</th>
                <th style="padding:10px 12px">Notes</th>
              </tr>
            </thead>
            <tbody id="mr_tbody">
              <tr><td colspan="9" style="text-align:center;padding:24px" class="muted">Loading unified meter readings...</td></tr>
            </tbody>
          </table>
        </div>
      `;

      async function load() {
        const search = qs('#mr_search', box).value.trim();
        const source = qs('#mr_source', box).value;
        const tbody = qs('#mr_tbody', box);
        try {
          const rows = await api(`/meters?search=${encodeURIComponent(search)}&source=${encodeURIComponent(source)}&limit=350`);
          qs('#mr_count', box).textContent = `Showing ${rows.length} meter records`;
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px" class="muted">No matching meter readings found.</td></tr>';
            return;
          }
          tbody.innerHTML = rows.map((r) => `
            <tr>
              <td style="padding:9px 12px;white-space:nowrap">${esc(String(r.reading_date || '').slice(0, 10))}</td>
              <td style="padding:9px 12px">
                <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(r.asset_code || '')}" style="font-weight:700;color:var(--primary,#0066ff);text-decoration:underline">${esc(r.asset_code || '—')}</a>
              </td>
              <td style="padding:9px 12px">${esc(r.asset_reg || '—')}</td>
              <td style="padding:9px 12px" class="muted">${esc(r.asset_category || '—')}</td>
              <td style="padding:9px 12px"><span class="badge">${esc(r.meter_type || 'HOURS')}</span></td>
              <td style="padding:9px 12px;text-align:right;font-weight:800">${fmtNum(r.reading, 1)}</td>
              <td style="padding:9px 12px"><span class="badge" style="background:rgba(37,99,235,0.1);color:#1d4ed8">${esc(r.origin || r.source || 'MANUAL')}</span></td>
              <td style="padding:9px 12px">${esc(r.recorded_by_name || 'System')}</td>
              <td style="padding:9px 12px" class="muted">${esc(r.notes || '—')}</td>
            </tr>
          `).join('');
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="9" class="err" style="padding:20px">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#btn_mr_filter', box).onclick = load;
      qs('#mr_search', box).onkeydown = (e) => { if (e.key === 'Enter') load(); };
      qs('#mr_source', box).onchange = load;
      load();
    }

    // TAB 2: Daily Working vs Breakdown Condition
    async function renderConditionsTab(box) {
      box.innerHTML = `
        <div class="card" style="padding:12px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <select id="cd_filter_status" class="input sm">
            <option value="">All Conditions (Working & Breakdown)</option>
            <option value="BREAKDOWN">🔴 Breakdowns Only</option>
            <option value="WORKING">🟢 Working Only</option>
          </select>
          <button class="btn sm primary" id="btn_cd_reload">🔄 Refresh</button>
        </div>
        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:12.5px">
            <thead>
              <tr>
                <th style="padding:10px 12px">Date</th>
                <th style="padding:10px 12px">Vehicle</th>
                <th style="padding:10px 12px">Registration</th>
                <th style="padding:10px 12px">Category</th>
                <th style="padding:10px 12px">Status</th>
                <th style="padding:10px 12px">Reason / Defect</th>
                <th style="padding:10px 12px">Notes</th>
                <th style="padding:10px 12px">Recorded By</th>
              </tr>
            </thead>
            <tbody id="cd_tbody">
              <tr><td colspan="8" style="text-align:center;padding:24px" class="muted">Loading daily conditions...</td></tr>
            </tbody>
          </table>
        </div>
      `;

      async function loadConds() {
        const st = qs('#cd_filter_status', box).value;
        const tbody = qs('#cd_tbody', box);
        try {
          const rows = await api(`/meters/conditions?status=${encodeURIComponent(st)}`);
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px" class="muted">No daily condition records found.</td></tr>';
            return;
          }
          tbody.innerHTML = rows.map((r) => `
            <tr>
              <td style="padding:9px 12px">${esc(String(r.date || '').slice(0, 10))}</td>
              <td style="padding:9px 12px"><b>${esc(r.asset_code || '—')}</b></td>
              <td style="padding:9px 12px">${esc(r.asset_reg || '—')}</td>
              <td style="padding:9px 12px">${esc(r.asset_category || '—')}</td>
              <td style="padding:9px 12px">
                ${r.status === 'BREAKDOWN'
                  ? '<span class="badge danger">🔴 BREAKDOWN</span>'
                  : '<span class="badge ok">🟢 WORKING</span>'}
              </td>
              <td style="padding:9px 12px">${esc(r.reason || '—')}</td>
              <td style="padding:9px 12px" class="muted">${esc(r.notes || '—')}</td>
              <td style="padding:9px 12px">${esc(r.recorded_by_name || 'System')}</td>
            </tr>
          `).join('');
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="8" class="err" style="padding:20px">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#cd_filter_status', box).onchange = loadConds;
      qs('#btn_cd_reload', box).onclick = loadConds;
      loadConds();
    }

    switchTab('meters');
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel-readings'] = renderFuelReadings;
  }
})();
