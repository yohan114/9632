'use strict';

/**
 * WorkshopOne + Fuel-System-V2 Visual Fuel Consumption Graphs, Band Health & Dual-Basis PM Planner (:1949)
 *
 * Mounts at window.routes['fuel-reports']
 * 4 Integrated Analytical Tabs:
 *   1. 📊 Visual Fuel Consumption Graphs (Daily/Monthly trends, Bowser vs External, Top 15 Vehicles, Site bars)
 *   2. 🎯 Consumption Band Health Chart (Econ–Typ–Heavy horizontal visual bars + OVER/HEAVY/NORMAL/BELOW_ECON filter tiles)
 *   3. 🔧 Dual-Basis Service & Filter PM Planner (Recorded Meter vs Fuel-Derived Running countdown + Quick-Log Service)
 *   4. 📑 Printable Monthly Site & Vehicle Efficiency Statement
 */

(function () {
  function fmtLkr(val) {
    return 'Rs ' + Number(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtNum(val, dec = 1) {
    if (val === null || val === undefined || isNaN(Number(val))) return '—';
    return Number(val).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  async function renderFuelReports(content) {
    const hashParts = (location.hash || '').split('?');
    const qParams = new URLSearchParams(hashParts[1] || '');
    let activeTab = qParams.get('tab') || 'graphs';
    let selectedMonth = qParams.get('month') || '2026-08';

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / <a href="#/fuel">Fuel System</a> / Consumption Graphs, Band Health &amp; Service Plan</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:800">📊 Fuel Consumption Graphs, Band Health &amp; PM Planner</h1>
          <p class="muted" style="margin:4px 0 0 0">Interactive consumption graphs, Econ–Typ–Heavy band diagnostics, and Dual-Basis (Meter + Fuel-Derived) Service &amp; Filter Planner</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label style="font-size:12px;font-weight:600">Period Month:</label>
          <input type="month" id="fr_month_input" class="input sm" value="${esc(selectedMonth)}" style="width:145px">
          <button class="btn sm" onclick="window.print()">🖨️ Print View</button>
          <a href="#/fuel" class="btn sm primary">⛽ Fuel Command Center</a>
        </div>
      </div>

      <div class="tabs" id="fr_tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid var(--border);padding-bottom:8px">
        <button class="btn sm" data-tab="graphs">📊 Visual Consumption Graphs</button>
        <button class="btn sm" data-tab="band-health">🎯 Econ–Typ–Heavy Band Health Chart</button>
        <button class="btn sm" data-tab="service-planner">🔧 Dual-Basis Service &amp; Filter Planner</button>
        <button class="btn sm" data-tab="statement">📑 Printable Monthly Statement</button>
      </div>

      <div id="fr_tab_body"></div>
    `;

    function switchTab(t) {
      activeTab = t;
      qsa('#fr_tabs button').forEach((b) => b.classList.toggle('primary', b.getAttribute('data-tab') === t));
      const box = qs('#fr_tab_body');
      if (t === 'graphs') renderGraphsTab(box);
      else if (t === 'band-health') renderBandHealthTab(box);
      else if (t === 'service-planner') renderServicePlannerTab(box);
      else renderStatementTab(box);
    }

    qsa('#fr_tabs button').forEach((b) => {
      b.onclick = () => switchTab(b.getAttribute('data-tab'));
    });

    qs('#fr_month_input').onchange = (e) => {
      selectedMonth = e.target.value;
      switchTab(activeTab);
    };

    // =========================================================================
    // TAB 1: VISUAL FUEL CONSUMPTION GRAPHS
    // =========================================================================
    async function renderGraphsTab(box) {
      box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Fuel Consumption Graphs for ${esc(selectedMonth)}...</div>`;
      try {
        const data = await api(`/fuel/analytics/consumption?month=${encodeURIComponent(selectedMonth)}`);
        const t = data.totals || {};
        const daily = data.dailySeries || [];
        const monthly = data.monthlySeries || [];
        const topVeh = data.topVehicles || [];
        const bySite = data.bySite || [];

        const maxDailyL = Math.max(1, ...daily.map((d) => d.litres || 0));
        const maxMonthlyL = Math.max(1, ...monthly.map((m) => m.litres || 0));
        const maxVehL = Math.max(1, ...topVeh.map((v) => v.litres || 0));
        const maxSiteL = Math.max(1, ...bySite.map((s) => s.litres || 0));
        const bowserPct = t.litres > 0 ? Math.round((t.bowserLitres / t.litres) * 100) : 0;

        box.innerHTML = `
          <!-- Summary Strip -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;margin-bottom:14px">
            <div class="card" style="padding:12px">
              <div class="muted" style="font-size:11px;font-weight:700">PERIOD LITRES (${esc(selectedMonth)})</div>
              <div style="font-size:21px;font-weight:800;color:var(--primary,#0066ff)">${fmtNum(t.litres, 1)} L</div>
              <div class="muted" style="font-size:11px">${t.issues || 0} fuel issues</div>
            </div>
            <div class="card" style="padding:12px">
              <div class="muted" style="font-size:11px;font-weight:700">PERIOD FUEL COST</div>
              <div style="font-size:21px;font-weight:800;color:#10b981">${fmtLkr(t.costLkr)}</div>
              <div class="muted" style="font-size:11px">Avg Rs ${t.litres > 0 ? (t.costLkr / t.litres).toFixed(2) : '341.00'} / L</div>
            </div>
            <div class="card" style="padding:12px">
              <div class="muted" style="font-size:11px;font-weight:700">ACTIVE FUELED FLEET</div>
              <div style="font-size:21px;font-weight:800;color:#f59e0b">${t.vehicles || 0} Machines</div>
              <div class="muted" style="font-size:11px">Across ${bySite.length} sites</div>
            </div>
            <div class="card" style="padding:12px">
              <div class="muted" style="font-size:11px;font-weight:700">BOWSER VS EXTERNAL SPLIT</div>
              <div style="font-size:18px;font-weight:800;color:#047857">${bowserPct}% Site Bowser</div>
              <div class="muted" style="font-size:11px">${fmtNum(t.bowserLitres, 0)}L Bowser · ${fmtNum(t.externalLitres, 0)}L Station</div>
            </div>
          </div>

          <!-- Row 1: Daily Consumption Bar Graph + Monthly Trend Graph -->
          <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:14px;margin-bottom:14px">
            <div class="card" style="padding:16px">
              <h3 style="margin:0 0 12px 0;font-size:15px">📈 Daily Fuel Consumption Graph (${esc(selectedMonth)})</h3>
              ${daily.length ? `
                <div style="display:flex;align-items:flex-end;gap:4px;height:185px;padding:14px 6px 4px 6px;background:rgba(37,99,235,0.03);border-radius:8px;overflow-x:auto">
                  ${daily.map((d) => {
                    const h = Math.max(6, Math.round(((d.litres || 0) / maxDailyL) * 145));
                    return `<div title="${d.day}: ${fmtNum(d.litres, 1)} L (${fmtLkr(d.costLkr)} · ${d.issues} slips)" style="flex:1;min-width:16px;display:flex;flex-direction:column;align-items:center;gap:3px">
                      <span style="font-size:8.5px;color:#1d4ed8;font-weight:700">${Math.round(d.litres)}</span>
                      <div style="width:100%;max-width:22px;height:${h}px;background:linear-gradient(180deg,#2563eb,#60a5fa);border-radius:3px 3px 0 0"></div>
                      <span style="font-size:9px;color:#64748b">${esc(String(d.day || '').slice(8))}</span>
                    </div>`;
                  }).join('')}
                </div>
              ` : '<div class="muted" style="padding:30px;text-align:center">No daily fuel issues in this month</div>'}
            </div>

            <div class="card" style="padding:16px">
              <h3 style="margin:0 0 12px 0;font-size:15px">📊 Multi-Month Fleet Consumption Trend</h3>
              <div style="display:flex;align-items:flex-end;gap:8px;height:185px;padding:14px 8px 4px 8px;background:rgba(16,185,129,0.03);border-radius:8px">
                ${monthly.map((m) => {
                  const h = Math.max(8, Math.round(((m.litres || 0) / maxMonthlyL) * 140));
                  const isSel = m.month === selectedMonth;
                  return `<div title="${m.month}: ${fmtNum(m.litres, 0)} L (${fmtLkr(m.costLkr)})" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
                    <span style="font-size:9px;font-weight:700;color:${isSel ? '#047857' : '#64748b'}">${Math.round((m.litres || 0) / 1000)}k L</span>
                    <div style="width:100%;max-width:34px;height:${h}px;background:${isSel ? '#059669' : '#94a3b8'};border-radius:4px 4px 0 0"></div>
                    <span style="font-size:9.5px;font-weight:${isSel ? '800' : '500'}">${esc(m.month)}</span>
                  </div>`;
                }).join('')}
              </div>
            </div>
          </div>

          <!-- Row 2: Top 15 Consuming Vehicles Horizontal Graph + Site Breakdown Graph -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div class="card" style="padding:16px">
              <h3 style="margin:0 0 12px 0;font-size:15px">🚜 Top 15 Fuel-Consuming Vehicles (${esc(selectedMonth)})</h3>
              <div style="display:flex;flex-direction:column;gap:8px">
                ${topVeh.map((v) => {
                  const wPct = Math.max(4, Math.round(((v.litres || 0) / maxVehL) * 100));
                  return `
                    <div>
                      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">
                        <span>
                          <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(v.code)}" style="font-weight:700;color:var(--primary,#0066ff)">${esc(v.code)}</a>
                          <span class="muted">(${esc(v.category || v.registration || '')})</span>
                        </span>
                        <span><b>${fmtNum(v.litres, 1)} L</b> · <span class="muted">${fmtLkr(v.costLkr)}</span></span>
                      </div>
                      <div style="width:100%;height:8px;background:rgba(0,0,0,0.06);border-radius:4px;overflow:hidden">
                        <div style="width:${wPct}%;height:100%;background:#2563eb;border-radius:4px"></div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <div class="card" style="padding:16px">
              <h3 style="margin:0 0 12px 0;font-size:15px">🏗️ Site-Wise Diesel Distribution Graph (${esc(selectedMonth)})</h3>
              <div style="display:flex;flex-direction:column;gap:8px">
                ${bySite.slice(0, 15).map((s) => {
                  const wPct = Math.max(4, Math.round(((s.litres || 0) / maxSiteL) * 100));
                  return `
                    <div>
                      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">
                        <span><b>${esc(s.project_name)}</b> <span class="muted">(${s.vehicles} veh · ${s.issues} slips)</span></span>
                        <span><b>${fmtNum(s.litres, 1)} L</b> · <span class="muted">${fmtLkr(s.costLkr)}</span></span>
                      </div>
                      <div style="width:100%;height:8px;background:rgba(0,0,0,0.06);border-radius:4px;overflow:hidden">
                        <div style="width:${wPct}%;height:100%;background:#10b981;border-radius:4px"></div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>
        `;
      } catch (err) {
        box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
      }
    }

    // =========================================================================
    // TAB 2: ECON-TYP-HEAVY CONSUMPTION BAND HEALTH CHART
    // =========================================================================
    async function renderBandHealthTab(box) {
      box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Computing Fleet Econ–Typ–Heavy Consumption Band Health...</div>`;
      let activeVerdict = 'ALL';
      let searchQ = '';

      try {
        const data = await api(`/fuel/analytics/consumption?month=${encodeURIComponent(selectedMonth)}`);
        const health = data.fleetHealth || { counts: {}, rows: [] };
        const c = health.counts || {};
        const allRows = health.rows || [];

        function renderView() {
          const filtered = allRows.filter((r) => {
            if (activeVerdict !== 'ALL' && r.verdict !== activeVerdict) return false;
            if (searchQ) {
              const q = searchQ.toUpperCase();
              return String(r.code || '').toUpperCase().includes(q) ||
                     String(r.registration || '').toUpperCase().includes(q) ||
                     String(r.category || '').toUpperCase().includes(q);
            }
            return true;
          });

          box.innerHTML = `
            <!-- 5 Clickable Health Filter Tiles -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(175px, 1fr));gap:10px;margin-bottom:14px">
              <div class="card bh-tile" data-v="OVER" style="padding:12px;cursor:pointer;border-left:4px solid #dc2626;${activeVerdict === 'OVER' ? 'background:rgba(220,38,38,0.08)' : ''}">
                <div style="font-size:11px;font-weight:700;color:#dc2626">🔴 OVER BAND (REPAIR CANDIDATES)</div>
                <div style="font-size:22px;font-weight:800;margin-top:4px">${c.OVER || 0}</div>
                <div class="muted" style="font-size:11px">Burning worse than Heavy limit</div>
              </div>
              <div class="card bh-tile" data-v="HEAVY" style="padding:12px;cursor:pointer;border-left:4px solid #d97706;${activeVerdict === 'HEAVY' ? 'background:rgba(217,119,6,0.08)' : ''}">
                <div style="font-size:11px;font-weight:700;color:#d97706">🟠 HEAVY BURN (TYP – HEAVY)</div>
                <div style="font-size:22px;font-weight:800;margin-top:4px">${c.HEAVY || 0}</div>
                <div class="muted" style="font-size:11px">Above Typical norm</div>
              </div>
              <div class="card bh-tile" data-v="NORMAL" style="padding:12px;cursor:pointer;border-left:4px solid #059669;${activeVerdict === 'NORMAL' ? 'background:rgba(5,150,105,0.08)' : ''}">
                <div style="font-size:11px;font-weight:700;color:#059669">🟢 NORMAL BAND (ECON – TYP)</div>
                <div style="font-size:22px;font-weight:800;margin-top:4px">${c.NORMAL || 0}</div>
                <div class="muted" style="font-size:11px">Within healthy standard band</div>
              </div>
              <div class="card bh-tile" data-v="BELOW_ECON" style="padding:12px;cursor:pointer;border-left:4px solid #2563eb;${activeVerdict === 'BELOW_ECON' ? 'background:rgba(37,99,235,0.08)' : ''}">
                <div style="font-size:11px;font-weight:700;color:#2563eb">🔵 BELOW ECON (CHECK METER)</div>
                <div style="font-size:22px;font-weight:800;margin-top:4px">${c.BELOW_ECON || 0}</div>
                <div class="muted" style="font-size:11px">Possible meter jump or partial fill</div>
              </div>
              <div class="card bh-tile" data-v="NO_METER" style="padding:12px;cursor:pointer;border-left:4px solid #64748b;${activeVerdict === 'NO_METER' ? 'background:rgba(100,116,139,0.08)' : ''}">
                <div style="font-size:11px;font-weight:700;color:#64748b">⚪ NO METER MOVEMENT</div>
                <div style="font-size:22px;font-weight:800;margin-top:4px">${c.NO_METER || 0}</div>
                <div class="muted" style="font-size:11px">Fueled without meter span</div>
              </div>
            </div>

            <div class="card" style="padding:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
              <div style="display:flex;gap:8px;align-items:center">
                <input type="text" id="bh_search" value="${esc(searchQ)}" placeholder="Filter vehicle code, reg, category..." class="input sm" style="min-width:240px">
                <button class="btn sm ${activeVerdict === 'ALL' ? 'primary' : ''}" id="btn_bh_all">Show All (${allRows.length})</button>
              </div>
              <div class="muted" style="font-size:12px">Click any vehicle code to open its 360° Fuel &amp; Meter Profile</div>
            </div>

            <div class="card" style="padding:0;overflow-x:auto">
              <table class="table" style="width:100%;margin:0;font-size:12.5px">
                <thead>
                  <tr style="background:rgba(0,0,0,0.02)">
                    <th style="padding:10px 12px">Vehicle</th>
                    <th style="padding:10px 12px">Category / Site</th>
                    <th style="padding:10px 12px;text-align:right">Litres (${esc(selectedMonth)})</th>
                    <th style="padding:10px 12px;text-align:right">Meter Span</th>
                    <th style="padding:10px 12px">Standard Band (Econ / Typ / Heavy)</th>
                    <th style="padding:10px 12px">Measured Rate</th>
                    <th style="padding:10px 12px;min-width:210px">Visual Consumption Band Bar</th>
                    <th style="padding:10px 12px">Diagnostic Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.map((r) => {
                    // Position pin on 0..100% scale where Econ=25%, Typ=55%, Heavy=80%
                    let pinPct = 50;
                    if (r.verdict === 'BELOW_ECON') pinPct = 12;
                    else if (r.verdict === 'NORMAL') pinPct = 42;
                    else if (r.verdict === 'HEAVY') pinPct = 68;
                    else if (r.verdict === 'OVER') pinPct = 92;

                    return `
                      <tr>
                        <td style="padding:9px 12px">
                          <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(r.code)}" style="font-weight:800;color:var(--primary,#0066ff);text-decoration:underline">${esc(r.code)}</a>
                          <div class="muted" style="font-size:11px">${esc(r.registration || '—')}</div>
                        </td>
                        <td style="padding:9px 12px">
                          <div>${esc(r.category || '—')}</div>
                          <div class="muted" style="font-size:11px">${esc(r.site || 'Central')}</div>
                        </td>
                        <td style="padding:9px 12px;text-align:right;font-weight:700">${fmtNum(r.litres, 1)} L</td>
                        <td style="padding:9px 12px;text-align:right">${r.meterSpan > 0 ? `${fmtNum(r.meterSpan, 1)} ${r.basis}` : '<span class="muted">0</span>'}</td>
                        <td style="padding:9px 12px;font-size:11.5px">
                          ${r.typ != null ? `<b>${r.econ ?? '—'}</b> / <b style="color:#059669">${r.typ}</b> / <b style="color:#dc2626">${r.heavy ?? '—'}</b> ${r.unit}` : '<span class="muted">Not set</span>'}
                        </td>
                        <td style="padding:9px 12px;font-weight:800">
                          ${r.measured != null ? `${r.measured} ${r.unit}` : '—'}
                          ${r.pctOfTyp != null ? `<div class="muted" style="font-size:10px">${r.pctOfTyp >= 0 ? '+' : ''}${r.pctOfTyp}% vs Typ</div>` : ''}
                        </td>
                        <td style="padding:9px 12px">
                          ${r.measured != null && r.typ != null ? `
                            <div style="position:relative;height:14px;border-radius:7px;overflow:hidden;display:flex;background:#e2e8f0">
                              <div style="width:25%;background:#93c5fd" title="Below Econ"></div>
                              <div style="width:30%;background:#34d399" title="Normal (Econ–Typ)"></div>
                              <div style="width:25%;background:#fbbf24" title="Heavy (Typ–Heavy)"></div>
                              <div style="width:20%;background:#f87171" title="Over Heavy"></div>
                              <div style="position:absolute;left:${pinPct}%;top:0;bottom:0;width:4px;background:#111827;border:1px solid #fff" title="Measured: ${r.measured} ${r.unit}"></div>
                            </div>
                          ` : '<span class="muted" style="font-size:11px">No meter span</span>'}
                        </td>
                        <td style="padding:9px 12px">
                          ${r.verdict === 'OVER' ? '<span class="badge danger">🔴 OVER (Repair)</span>' :
                            r.verdict === 'HEAVY' ? '<span class="badge warn">🟠 HEAVY</span>' :
                            r.verdict === 'NORMAL' ? '<span class="badge ok">🟢 NORMAL</span>' :
                            r.verdict === 'BELOW_ECON' ? '<span class="badge">🔵 BELOW ECON</span>' :
                            '<span class="badge">⚪ NO METER</span>'}
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `;

          qsa('.bh-tile', box).forEach((t) => {
            t.onclick = () => {
              const v = t.getAttribute('data-v');
              activeVerdict = activeVerdict === v ? 'ALL' : v;
              renderView();
            };
          });
          qs('#btn_bh_all', box).onclick = () => { activeVerdict = 'ALL'; renderView(); };
          const sInp = qs('#bh_search', box);
          sInp.oninput = (e) => { searchQ = e.target.value; renderView(); sInp.focus(); };
        }

        renderView();
      } catch (err) {
        box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
      }
    }

    // =========================================================================
    // TAB 3: DUAL-BASIS SERVICE & FILTER PM PLANNER
    // =========================================================================
    async function renderServicePlannerTab(box) {
      let curFilter = '';
      let searchQ = '';

      async function loadPlanner() {
        box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Computing Dual-Basis (Recorded Meter vs Fuel-Derived Running) Service Countdowns...</div>`;
        try {
          const data = await api(`/fuel/service-planner?status=${encodeURIComponent(curFilter)}&q=${encodeURIComponent(searchQ)}`);
          const counts = data.counts || {};
          const rows = data.rows || [];

          box.innerHTML = `
            <!-- Quick-Log Service Bar -->
            <div class="card" style="padding:14px;margin-bottom:14px;background:linear-gradient(90deg, rgba(16,185,129,0.08), rgba(37,99,235,0.05))">
              <div style="font-size:12px;font-weight:700;margin-bottom:8px">🛠️ Quick-Log Completed Preventive Maintenance Service (Resets Countdown)</div>
              <form id="form_quick_service" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
                <div>
                  <label style="font-size:11px;font-weight:600">Vehicle Code *</label>
                  <input type="text" id="qs_code" required class="input sm" placeholder="e.g. LB-22" style="width:120px">
                </div>
                <div>
                  <label style="font-size:11px;font-weight:600">Service Date *</label>
                  <input type="date" id="qs_date" required class="input sm" value="${new Date().toISOString().slice(0, 10)}">
                </div>
                <div>
                  <label style="font-size:11px;font-weight:600">Meter at Service</label>
                  <input type="number" step="0.1" id="qs_meter" class="input sm" placeholder="KM / HRS" style="width:120px">
                </div>
                <div>
                  <label style="font-size:11px;font-weight:600">Service Type</label>
                  <input type="text" id="qs_type" class="input sm" placeholder="500HR / 5000KM Service" style="width:160px">
                </div>
                <div>
                  <label style="font-size:11px;font-weight:600">Job Card #</label>
                  <input type="text" id="qs_job" class="input sm" placeholder="JC-..." style="width:110px">
                </div>
                <button type="submit" class="btn sm primary">✅ Log Service</button>
              </form>
            </div>

            <!-- Status Filter Pills -->
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
              <div style="display:flex;gap:6px;flex-wrap:wrap" id="sp_pills">
                <button class="btn sm ${curFilter === '' ? 'primary' : ''}" data-st="">All Fleet (${counts.ALL || 0})</button>
                <button class="btn sm ${curFilter === 'OVERDUE' ? 'primary' : ''}" data-st="OVERDUE" style="border-color:#dc2626;color:${curFilter === 'OVERDUE' ? '#fff' : '#dc2626'}">🔴 Overdue (${counts.OVERDUE || 0})</button>
                <button class="btn sm ${curFilter === 'DUE_SOON' ? 'primary' : ''}" data-st="DUE_SOON" style="border-color:#d97706;color:${curFilter === 'DUE_SOON' ? '#fff' : '#d97706'}">🟠 Due Soon (${counts.DUE_SOON || 0})</button>
                <button class="btn sm ${curFilter === 'OK' ? 'primary' : ''}" data-st="OK">🟢 OK (${counts.OK || 0})</button>
              </div>
              <div style="display:flex;gap:8px">
                <input type="text" id="sp_search" value="${esc(searchQ)}" placeholder="Search vehicle code, reg, site..." class="input sm" style="min-width:220px">
                <button class="btn sm" id="btn_sp_search">Search</button>
              </div>
            </div>

            <div class="card" style="padding:0;overflow-x:auto">
              <table class="table" style="width:100%;margin:0;font-size:12.5px">
                <thead>
                  <tr style="background:rgba(0,0,0,0.02)">
                    <th style="padding:10px 12px">Vehicle</th>
                    <th style="padding:10px 12px">Category / Site</th>
                    <th style="padding:10px 12px">Last Service</th>
                    <th style="padding:10px 12px;text-align:right">Interval</th>
                    <th style="padding:10px 12px;text-align:right">Recorded Meter Growth</th>
                    <th style="padding:10px 12px;text-align:right">Fuel-Derived Running</th>
                    <th style="padding:10px 12px">Governing Basis</th>
                    <th style="padding:10px 12px;text-align:right">Remaining</th>
                    <th style="padding:10px 12px">Status</th>
                    <th style="padding:10px 12px;text-align:center">Filters &amp; 360°</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.slice(0, 200).map((r) => `
                    <tr>
                      <td style="padding:9px 12px">
                        <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(r.code)}" style="font-weight:800;color:var(--primary,#0066ff)">${esc(r.code)}</a>
                        <div class="muted" style="font-size:11px">${esc(r.registration || '—')}</div>
                      </td>
                      <td style="padding:9px 12px">
                        <div>${esc(r.category || '—')}</div>
                        <div class="muted" style="font-size:11px">${esc(r.current_site || 'Central')}</div>
                      </td>
                      <td style="padding:9px 12px">
                        ${r.last_service_date ? `<b>${esc(String(r.last_service_date).slice(0, 10))}</b><div class="muted" style="font-size:11px">@ ${fmtNum(r.last_service_meter, 0)} ${r.meter_type}</div>` : '<span class="muted">Baseline</span>'}
                      </td>
                      <td style="padding:9px 12px;text-align:right">${fmtNum(r.interval, 0)} ${r.meter_type}</td>
                      <td style="padding:9px 12px;text-align:right;font-weight:${r.governing_basis === 'RECORDED' ? '800' : '400'}">
                        +${fmtNum(r.recorded_since, 1)} ${r.meter_type}
                      </td>
                      <td style="padding:9px 12px;text-align:right;color:#7c3aed;font-weight:${r.governing_basis === 'FUEL_DERIVED' ? '800' : '400'}">
                        +${fmtNum(r.fuel_derived_since, 1)} ${r.meter_type}
                        <div class="muted" style="font-size:10px">(${fmtNum(r.fuel_litres_since, 0)} L burned)</div>
                      </td>
                      <td style="padding:9px 12px">
                        <span class="badge" style="background:${r.governing_basis === 'FUEL_DERIVED' ? 'rgba(124,58,237,0.12);color:#6d28d9' : 'rgba(37,99,235,0.12);color:#1d4ed8'}">
                          ${r.governing_basis === 'FUEL_DERIVED' ? '⛽ FUEL-DERIVED' : '📟 METER'}
                        </span>
                      </td>
                      <td style="padding:9px 12px;text-align:right;font-weight:800;color:${r.status === 'OVERDUE' ? '#dc2626' : (r.status === 'DUE_SOON' ? '#d97706' : '#059669')}">
                        ${r.remaining >= 0 ? `${fmtNum(r.remaining, 0)} ${r.meter_type}` : `${fmtNum(Math.abs(r.remaining), 0)} OVER`}
                      </td>
                      <td style="padding:9px 12px">
                        ${r.status === 'OVERDUE' ? '<span class="badge danger">🔴 OVERDUE</span>' :
                          r.status === 'DUE_SOON' ? '<span class="badge warn">🟠 DUE SOON</span>' :
                          '<span class="badge ok">🟢 OK</span>'}
                      </td>
                      <td style="padding:9px 12px;text-align:center">
                        <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(r.code)}" class="btn sm">🧰 Filters &amp; 360°</a>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `;

          qsa('#sp_pills button', box).forEach((b) => {
            b.onclick = () => { curFilter = b.getAttribute('data-st'); loadPlanner(); };
          });
          qs('#btn_sp_search', box).onclick = () => {
            searchQ = qs('#sp_search', box).value.trim();
            loadPlanner();
          };
          qs('#sp_search', box).onkeydown = (e) => {
            if (e.key === 'Enter') { searchQ = qs('#sp_search', box).value.trim(); loadPlanner(); }
          };

          qs('#form_quick_service', box).onsubmit = async (e) => {
            e.preventDefault();
            try {
              await api('/fuel/service-planner/quick-log', {
                method: 'POST',
                body: {
                  assetCode: qs('#qs_code', box).value.trim(),
                  serviceDate: qs('#qs_date', box).value,
                  meterAtService: qs('#qs_meter', box).value !== '' ? Number(qs('#qs_meter', box).value) : null,
                  serviceType: qs('#qs_type', box).value.trim(),
                  jobNo: qs('#qs_job', box).value.trim(),
                },
              });
              toast('Preventive maintenance service logged and countdown reset!');
              loadPlanner();
            } catch (err) {
              alert(err.message);
            }
          };
        } catch (err) {
          box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
        }
      }

      loadPlanner();
    }

    // =========================================================================
    // TAB 4: PRINTABLE MONTHLY SITE & VEHICLE STATEMENT
    // =========================================================================
    async function renderStatementTab(box) {
      box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Monthly Fuel Statement...</div>`;
      try {
        const data = await api(`/fuel/reports?month=${encodeURIComponent(selectedMonth)}`);
        const totalLitres = data.totalLitres || 0;
        const totalCost = data.totalCost || 0;
        const vehicles = data.vehicles || [];
        const sites = data.sites || [];

        box.innerHTML = `
          <div class="card" style="padding:16px;margin-bottom:16px">
            <h2 style="font-size:16px;font-weight:700;margin:0 0 10px 0">1. Site / Project Diesel Consumption Summary (${esc(selectedMonth)})</h2>
            <table class="table" style="width:100%;font-size:12.5px">
              <thead>
                <tr><th>Project / Construction Site</th><th style="text-align:right">Slips</th><th style="text-align:right">Vehicles</th><th style="text-align:right">Total Litres</th><th style="text-align:right">Total Cost (LKR)</th><th style="text-align:right">% Share</th></tr>
              </thead>
              <tbody>
                ${sites.map((s) => {
                  const pct = totalLitres > 0 ? ((s.total_litres / totalLitres) * 100).toFixed(1) : '0.0';
                  return `
                    <tr>
                      <td><b>${esc(s.project_name)}</b></td>
                      <td style="text-align:right">${s.slip_count}</td>
                      <td style="text-align:right">${s.vehicle_count || 0}</td>
                      <td style="text-align:right;font-weight:700">${fmtNum(s.total_litres, 1)} L</td>
                      <td style="text-align:right">${fmtLkr(s.total_cost)}</td>
                      <td style="text-align:right"><span class="badge">${pct}%</span></td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>

          <div class="card" style="padding:16px">
            <h2 style="font-size:16px;font-weight:700;margin:0 0 10px 0">2. Vehicle-Wise Fuel Consumption &amp; Efficiency Statement (${esc(selectedMonth)})</h2>
            <table class="table" style="width:100%;font-size:12.5px">
              <thead>
                <tr><th>Vehicle</th><th>Reg</th><th>Category</th><th style="text-align:right">Litres</th><th style="text-align:right">Cost (LKR)</th><th style="text-align:right">Meter Units Run</th><th style="text-align:right">L / Unit</th></tr>
              </thead>
              <tbody>
                ${vehicles.map((v) => `
                  <tr>
                    <td><a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(v.asset_code)}" style="font-weight:700">${esc(v.asset_code)}</a></td>
                    <td>${esc(v.registration || '—')}</td>
                    <td>${esc(v.category || '—')}</td>
                    <td style="text-align:right;font-weight:700">${fmtNum(v.total_litres, 1)} L</td>
                    <td style="text-align:right">${fmtLkr(v.total_cost)}</td>
                    <td style="text-align:right">${fmtNum(v.meter_units_run, 1)}</td>
                    <td style="text-align:right;font-weight:700">${v.litres_per_unit > 0 ? v.litres_per_unit : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      } catch (err) {
        box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
      }
    }

    switchTab(activeTab);
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel-reports'] = renderFuelReports;
  }
})();
