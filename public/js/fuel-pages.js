'use strict';
/* =============================================================================
 * WorkshopOne - Fuel & Bowser Management Module (Ported from Fuel-System-V2)
 * Handles diesel dispensing, bulk tanks, physical dips, telemetry & hire billing.
 * ============================================================================= */

(function () {
  const routes = window.routes = window.routes || {};

  routes.fuel = async function (c) {
    if (!canView('fuel')) {
      c.innerHTML = `
        <div class="card err" style="margin-top:20px">
          <h2>Access Restricted</h2>
          <p class="muted">You do not have permission to access the Fuel System. Please contact your System Administrator.</p>
          <a class="btn sm" href="#/dashboard">← Return to Dashboard</a>
        </div>`;
      return;
    }

    const sp = new URLSearchParams(location.hash.split('?')[1] || '');
    const tab = sp.get('tab') || 'issues';

    const TABS = [
      ['issues', '⛽ Dispense Logs'],
      ['tanks', '🛢️ Bulk Tanks & Dips'],
      ['meters', '⏱️ Telemetry & Condition'],
      ['billing', '🧾 Hire Billing'],
      ['prices', '💵 Diesel Price'],
      ['service', '🛠️ Service Planner']
    ];

    c.innerHTML = `
      ${pageHeader('Fuel & Bowser Management', 'Bulk diesel storage, machine dispensing, telemetry tracking & equipment billing')}
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px">
        <div class="pill-row">
          ${TABS.map(([k, label]) => `<button class="btn sm ${tab === k ? 'primary' : ''}" data-ftab="${k}">${esc(label)}</button>`).join('')}
        </div>
        <div style="display:flex;gap:8px">
          ${canAdd('fuel') ? '<button class="btn sm primary" id="btn-fuel-new-issue">⛽ New Dispense</button>' : ''}
          ${canAdd('fuel_tanks') ? '<button class="btn sm" id="btn-fuel-log-dip">📏 Log Dip</button>' : ''}
          ${canAdd('fuel_tanks') ? '<button class="btn sm" id="btn-fuel-rcv-bowser">🚚 Receive Bowser</button>' : ''}
          ${canAdd('fuel') ? '<button class="btn sm" id="btn-fuel-log-meter">⏱️ Log Meter</button>' : ''}
        </div>
      </div>
      <div id="fuel-content"><div class="muted">Loading fuel data…</div></div>
    `;

    qsa('[data-ftab]', c).forEach((b) => {
      b.onclick = () => { location.hash = '#/fuel?tab=' + b.dataset.ftab; };
    });

    const btnNew = qs('#btn-fuel-new-issue', c);
    if (btnNew) btnNew.onclick = () => openNewDispenseModal(() => renderFuelTab(tab));

    const btnDip = qs('#btn-fuel-log-dip', c);
    if (btnDip) btnDip.onclick = () => openLogDipModal(() => renderFuelTab(tab));

    const btnBowser = qs('#btn-fuel-rcv-bowser', c);
    if (btnBowser) btnBowser.onclick = () => openReceiveBowserModal(() => renderFuelTab(tab));

    const btnMeter = qs('#btn-fuel-log-meter', c);
    if (btnMeter) btnMeter.onclick = () => openLogMeterModal(() => renderFuelTab(tab));

    await renderFuelTab(tab);
  };

  async function renderFuelTab(tab) {
    const pane = qs('#fuel-content');
    if (!pane) return;

    if (tab === 'issues') await renderIssuesTab(pane);
    else if (tab === 'tanks') await renderTanksTab(pane);
    else if (tab === 'meters') await renderMetersTab(pane);
    else if (tab === 'billing') await renderBillingTab(pane);
    else if (tab === 'prices') await renderPricesTab(pane);
    else if (tab === 'service') await renderServiceTab(pane);
  }

  // ---------------------------------------------------------------------------
  // TAB 1: DISPENSE LOGS (ISSUES)
  // ---------------------------------------------------------------------------
  async function renderIssuesTab(pane) {
    pane.innerHTML = '<div class="muted">Loading fuel issues…</div>';
    try {
      const [issues, summary, tanks] = await Promise.all([
        api('/fuel/issues?limit=50'),
        api('/fuel/summary').catch(() => null),
        api('/tanks').catch(() => [])
      ]);

      const sumHtml = summary ? `
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));margin-bottom:14px">
          <div class="card"><div class="stat"><div class="l">TODAY'S FUEL ISSUES</div><div class="n">${num(summary.today_litres || 0)} L</div><div style="font-size:12px;color:var(--muted)">${money(summary.today_cost || 0)}</div></div></div>
          <div class="card"><div class="stat"><div class="l">THIS MONTH'S FUEL</div><div class="n">${num(summary.month_litres || 0)} L</div><div style="font-size:12px;color:var(--muted)">${money(summary.month_cost || 0)}</div></div></div>
          <div class="card"><div class="stat"><div class="l">TOTAL BULK STOCK</div><div class="n">${num(summary.bulk_stock_litres || 0)} L</div><div style="font-size:12px;color:var(--muted)">Across ${tanks.length} bulk storage tanks</div></div></div>
          <div class="card"><div class="stat"><div class="l">DIESEL UNIT PRICE</div><div class="n">${money(summary.current_price || 0)}</div><div style="font-size:12px;color:var(--muted)">Per litre (active standard)</div></div></div>
        </div>
      ` : '';

      const rows = (issues || []).map((i) => {
        const isVoid = !!i.is_void;
        const voidBadge = isVoid ? '<span class="badge red">VOIDED</span>' : '<span class="badge green">ISSUED</span>';
        const voidBtn = (!isVoid && canEdit('fuel'))
          ? `<button class="btn sm danger" data-void="${i.id}" style="padding:2px 8px;font-size:11px">Void</button>`
          : '';
        return `
          <tr class="${isVoid ? 'muted' : ''}">
            <td><b>${esc(i.issue_no || ('#' + i.id))}</b></td>
            <td>${esc(i.date || (i.created_at ? i.created_at.slice(0, 10) : '—'))}</td>
            <td><a href="#/vehiclecosting?asset_id=${i.asset_id}"><b>${esc(i.asset_code || '—')}</b></a> <span style="font-size:11px;color:var(--muted)">(${esc(i.registration || 'No Reg')})</span></td>
            <td>${esc(i.tank_name || 'Bowser/Direct')}</td>
            <td class="num"><b>${num(i.litres)} L</b></td>
            <td class="num">${money(i.unit_price)}</td>
            <td class="num"><b>${money(i.total_cost)}</b></td>
            <td class="num">${i.meter_reading ? num(i.meter_reading) + ' ' + (i.meter_type || 'hrs') : '—'}</td>
            <td>${esc(i.driver_name || i.dispensed_by || '—')}</td>
            <td>${voidBadge}</td>
            <td style="text-align:right">${voidBtn}</td>
          </tr>
        `;
      });

      const headers = [
        { label: 'Issue No' }, { label: 'Date' }, { label: 'Vehicle / Machine' },
        { label: 'Bulk Tank' }, { label: 'Quantity', num: true }, { label: 'Price/L', num: true },
        { label: 'Total (LKR)', num: true }, { label: 'Meter Reading', num: true },
        { label: 'Driver / Dispenser' }, { label: 'Status' }, { label: 'Action', width: '70px' }
      ];

      pane.innerHTML = `
        ${sumHtml}
        <div class="card" style="margin-top:10px">
          <div class="toolbar" style="margin-bottom:8px">
            <h3 style="margin:0">Recent Fuel Dispense Log</h3>
            <div class="spacer"></div>
            <input type="text" id="filter-issue-veh" placeholder="Search vehicle code…" style="width:190px">
          </div>
          ${tableWrap(headers, rows, { scroll: true })}
        </div>
      `;

      // Filter input
      const filterInput = qs('#filter-issue-veh', pane);
      if (filterInput) {
        filterInput.oninput = () => {
          const q = filterInput.value.toLowerCase().trim();
          qsa('tbody tr', pane).forEach((tr) => {
            tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
          });
        };
      }

      // Void buttons
      qsa('[data-void]', pane).forEach((b) => {
        b.onclick = () => {
          const id = b.dataset.void;
          modal('Void Fuel Dispense', `
            <p class="err">Are you sure you want to void fuel issue #${esc(id)}?</p>
            <p class="muted">This will reverse stock deductions from the bulk tank and update vehicle cost summaries.</p>
            ${field('Reason for voiding', 'reason', { placeholder: 'e.g., Meter reading entered incorrectly' })}
            <div style="margin-top:14px;text-align:right">
              <button class="btn sm danger" id="btn-confirm-void">Confirm Void</button>
            </div>
          `, (mbody, close) => {
            qs('#btn-confirm-void', mbody).onclick = async () => {
              const reason = qs('input[name="reason"]', mbody).value.trim();
              if (!reason) { toast('Please provide a reason', 'err'); return; }
              try {
                await api(`/fuel/issues/${id}/void`, { method: 'POST', body: { reason } });
                toast('Fuel issue voided');
                close();
                renderIssuesTab(pane);
              } catch (e) {
                toast(e.message, 'err');
              }
            };
          });
        };
      });
    } catch (e) {
      pane.innerHTML = `<div class="card err">Error loading fuel issues: ${esc(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // TAB 2: BULK FUEL TANKS & PHYSICAL DIPS
  // ---------------------------------------------------------------------------
  async function renderTanksTab(pane) {
    pane.innerHTML = '<div class="muted">Loading tank stock & dip logs…</div>';
    try {
      const tanks = await api('/tanks');
      const dipPromises = tanks.map((t) => api(`/tanks/${t.id}/dips?limit=5`).catch(() => []));
      const dipsByTank = await Promise.all(dipPromises);

      const cardsHtml = tanks.map((t) => {
        const pct = Math.min(100, Math.round(((t.current_litres || 0) / (t.capacity_litres || 1)) * 100));
        const color = pct < 20 ? 'var(--red)' : pct < 40 ? 'var(--amber)' : 'var(--green)';
        return `
          <div class="card stat" style="border-top:3px solid ${color}">
            <div class="stat">
              <div class="l">${esc(t.name)} · ${esc(t.fuel_type || 'Diesel')}</div>
              <div class="n">${num(t.current_litres)} L</div>
              <div style="margin-top:6px">
                <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:3px">
                  <span>Capacity: ${num(t.capacity_litres)} L</span>
                  <span><b>${pct}%</b></span>
                </div>
                <div style="height:8px;background:var(--surface-2);border-radius:4px;overflow:hidden">
                  <div style="width:${pct}%;height:100%;background:${color}"></div>
                </div>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-top:8px">
                📍 Location: ${esc(t.location || 'Central Workshop')} · ${esc(t.status || 'Active')}
              </div>
            </div>
          </div>
        `;
      }).join('');

      // Flatten dips for combined table
      const allDips = [];
      tanks.forEach((t, idx) => {
        const dList = dipsByTank[idx] || [];
        dList.forEach((d) => allDips.push({ ...d, tank_name: t.name }));
      });
      allDips.sort((a, b) => (b.dip_date || '').localeCompare(a.dip_date || ''));

      const dipRows = allDips.map((d) => {
        const diff = (d.calculated_litres || 0) - (d.system_litres || 0);
        const diffCls = Math.abs(diff) > 100 ? 'red' : diff !== 0 ? 'amber' : 'green';
        return `
          <tr>
            <td><b>${esc(d.tank_name)}</b></td>
            <td>${esc(d.dip_date || '—')}</td>
            <td class="num">${d.dip_cm != null ? num(d.dip_cm) + ' cm' : '—'}</td>
            <td class="num"><b>${num(d.calculated_litres)} L</b></td>
            <td class="num">${num(d.system_litres)} L</td>
            <td class="num"><span class="badge ${diffCls}">${diff > 0 ? '+' : ''}${num(diff)} L</span></td>
            <td>${esc(d.recorded_by_name || '—')}</td>
            <td>${esc(d.notes || '—')}</td>
          </tr>
        `;
      });

      const headers = [
        { label: 'Bulk Tank' }, { label: 'Dip Date' }, { label: 'Dip Level', num: true },
        { label: 'Measured Volume', num: true }, { label: 'System Stock', num: true },
        { label: 'Variance', num: true }, { label: 'Recorded By' }, { label: 'Notes' }
      ];

      pane.innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));margin-bottom:16px">
          ${cardsHtml || '<div class="card muted">No bulk tanks configured</div>'}
        </div>
        <div class="card">
          <div class="toolbar" style="margin-bottom:8px">
            <h3 style="margin:0">Physical Dip & Reconciliation Log</h3>
            <div class="spacer"></div>
            <button class="btn sm" id="btn-tab-dip">📏 Log New Dip</button>
          </div>
          ${tableWrap(headers, dipRows, { scroll: true })}
        </div>
      `;

      const tDip = qs('#btn-tab-dip', pane);
      if (tDip) tDip.onclick = () => openLogDipModal(() => renderTanksTab(pane));
    } catch (e) {
      pane.innerHTML = `<div class="card err">Error loading bulk tanks: ${esc(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // TAB 3: METER READINGS & CONDITION TELEMETRY
  // ---------------------------------------------------------------------------
  async function renderMetersTab(pane) {
    pane.innerHTML = '<div class="muted">Loading machine telemetry & status…</div>';
    try {
      const [readings, assets] = await Promise.all([
        api('/meters?limit=60'),
        api('/assets').catch(() => [])
      ]);

      const rows = (readings || []).map((r) => {
        let condBadge = '—';
        if (r.daily_condition === 'RUNNING') condBadge = '<span class="badge green">RUNNING</span>';
        else if (r.daily_condition === 'BREAKDOWN') condBadge = '<span class="badge red">BREAKDOWN</span>';
        else if (r.daily_condition === 'IDLE') condBadge = '<span class="badge amber">IDLE</span>';
        else if (r.daily_condition === 'MAINTENANCE') condBadge = '<span class="badge" style="background:rgba(59,130,246,0.15);color:#2563eb">MAINTENANCE</span>';

        return `
          <tr>
            <td><a href="#/vehiclecosting?asset_id=${r.asset_id}"><b>${esc(r.asset_code)}</b></a></td>
            <td>${esc(r.registration || '—')}</td>
            <td>${esc(r.category || '—')}</td>
            <td>${esc(r.reading_date || '—')}</td>
            <td class="num"><b>${num(r.reading_value)} ${esc(r.meter_type || 'hrs')}</b></td>
            <td>${condBadge}</td>
            <td>${esc(r.project_name || 'Central')}</td>
            <td>${esc(r.notes || '—')}</td>
          </tr>
        `;
      });

      const headers = [
        { label: 'Vehicle Code' }, { label: 'Registration' }, { label: 'Category' },
        { label: 'Date' }, { label: 'Meter Reading', num: true }, { label: 'Operational Status' },
        { label: 'Site / Project' }, { label: 'Notes' }
      ];

      pane.innerHTML = `
        <div class="card">
          <div class="toolbar" style="margin-bottom:8px">
            <h3 style="margin:0">Machine Meter Telemetry & Operational State</h3>
            <div class="spacer"></div>
            <button class="btn sm primary" id="btn-tab-meter">⏱️ Log Meter Reading</button>
          </div>
          ${tableWrap(headers, rows, { scroll: true })}
        </div>
      `;

      const tMeter = qs('#btn-tab-meter', pane);
      if (tMeter) tMeter.onclick = () => openLogMeterModal(() => renderMetersTab(pane));
    } catch (e) {
      pane.innerHTML = `<div class="card err">Error loading meter logs: ${esc(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // TAB 4: EQUIPMENT HIRE BILLING
  // ---------------------------------------------------------------------------
  async function renderBillingTab(pane) {
    pane.innerHTML = '<div class="muted">Loading equipment hire bills…</div>';
    try {
      const [bills, rates] = await Promise.all([
        api('/billing/bills'),
        api('/billing/rates').catch(() => [])
      ]);

      const billRows = (bills || []).map((b) => {
        const bal = (b.net_amount || 0) - (b.paid_amount || 0);
        const statusBadge = bal <= 0
          ? '<span class="badge green">PAID</span>'
          : b.paid_amount > 0 ? '<span class="badge amber">PARTIAL</span>' : '<span class="badge red">UNPAID</span>';
        return `
          <tr>
            <td><b>${esc(b.bill_no)}</b></td>
            <td>${esc(b.period_start || '')} to ${esc(b.period_end || '')}</td>
            <td><b>${esc(b.project_name || 'Direct Client')}</b></td>
            <td class="num">${money(b.total_amount)}</td>
            <td class="num" style="color:var(--red)">-${money(b.fuel_deduction)}</td>
            <td class="num"><b>${money(b.net_amount)}</b></td>
            <td class="num" style="color:var(--green)">${money(b.paid_amount)}</td>
            <td class="num"><b>${money(bal)}</b></td>
            <td>${statusBadge}</td>
          </tr>
        `;
      });

      const billHeaders = [
        { label: 'Bill No' }, { label: 'Billing Period' }, { label: 'Project / Client' },
        { label: 'Gross Hire', num: true }, { label: 'Diesel Deduction', num: true },
        { label: 'Net Payable', num: true }, { label: 'Paid', num: true },
        { label: 'Balance Due', num: true }, { label: 'Status' }
      ];

      const rateRows = (rates || []).map((r) => `
        <tr>
          <td><b>${esc(r.asset_code || r.category || 'All')}</b></td>
          <td>${esc(r.rate_type)}</td>
          <td class="num"><b>${money(r.rate_amount)}</b></td>
          <td class="num">${r.minimum_hours || 0} hrs</td>
          <td>${esc(r.notes || '—')}</td>
        </tr>
      `);

      const rateHeaders = [
        { label: 'Asset / Category' }, { label: 'Rate Type' },
        { label: 'Rate (LKR)', num: true }, { label: 'Min Hours', num: true }, { label: 'Notes' }
      ];

      pane.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <div class="toolbar" style="margin-bottom:8px">
            <h3 style="margin:0">Equipment Hire Bills (With Diesel Deductions)</h3>
            <div class="spacer"></div>
            <button class="btn sm primary" id="btn-tab-gen-bill">🧾 Generate Monthly Bill</button>
          </div>
          ${tableWrap(billHeaders, billRows, { scroll: true })}
        </div>

        <div class="card">
          <div class="toolbar" style="margin-bottom:8px">
            <h3 style="margin:0">Equipment Rental Rate Cards</h3>
            <div class="spacer"></div>
            <button class="btn sm" id="btn-tab-add-rate">➕ Set Rate Card</button>
          </div>
          ${tableWrap(rateHeaders, rateRows, { scroll: true })}
        </div>
      `;

      const bGen = qs('#btn-tab-gen-bill', pane);
      if (bGen) bGen.onclick = () => openGenerateBillModal(() => renderBillingTab(pane));

      const bRate = qs('#btn-tab-add-rate', pane);
      if (bRate) bRate.onclick = () => openAddRateModal(() => renderBillingTab(pane));
    } catch (e) {
      pane.innerHTML = `<div class="card err">Error loading billing: ${esc(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // TAB 5: DIESEL PRICE MANAGEMENT
  // ---------------------------------------------------------------------------
  async function renderPricesTab(pane) {
    pane.innerHTML = '<div class="muted">Loading diesel price records…</div>';
    try {
      const [latest, prices] = await Promise.all([
        api('/fuel/prices/latest'),
        api('/fuel/prices')
      ]);

      const rows = (prices || []).map((p) => `
        <tr>
          <td><b>${esc(p.effective_date)}</b></td>
          <td class="num"><b>${money(p.price_per_litre)}</b></td>
          <td>${esc(p.created_by_name || 'System')}</td>
          <td>${esc(p.notes || '—')}</td>
          <td>${esc(p.created_at ? p.created_at.slice(0, 16).replace('T', ' ') : '—')}</td>
        </tr>
      `);

      const headers = [
        { label: 'Effective Date' }, { label: 'Price per Litre (LKR)', num: true },
        { label: 'Updated By' }, { label: 'Notes' }, { label: 'Recorded At' }
      ];

      pane.innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr));margin-bottom:16px">
          <div class="card stat" style="border-top:3px solid var(--primary)">
            <div class="stat">
              <div class="l">CURRENT ACTIVE DIESEL PRICE</div>
              <div class="n">${money(latest ? latest.price_per_litre : 0)} / L</div>
              <div style="font-size:12px;color:var(--muted);margin-top:4px">
                Effective since: <b>${latest ? latest.effective_date : '—'}</b>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="toolbar" style="margin-bottom:8px">
            <h3 style="margin:0">Diesel Price History</h3>
            <div class="spacer"></div>
            ${canEdit('fuel') ? '<button class="btn sm primary" id="btn-tab-new-price">💵 Update Fuel Price</button>' : ''}
          </div>
          ${tableWrap(headers, rows, { scroll: true })}
        </div>
      `;

      const bPrice = qs('#btn-tab-new-price', pane);
      if (bPrice) bPrice.onclick = () => openUpdatePriceModal(() => renderPricesTab(pane));
    } catch (e) {
      pane.innerHTML = `<div class="card err">Error loading prices: ${esc(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // TAB 6: SERVICE PLANNER (PM)
  // ---------------------------------------------------------------------------
  async function renderServiceTab(pane) {
    pane.innerHTML = '<div class="muted">Loading machine service planner…</div>';
    try {
      const data = await api('/portal/service');
      const items = (data && data.items) || [];

      const rows = items.map((s) => {
        let badge = '<span class="badge green">OK</span>';
        if (s.status === 'OVERDUE') badge = '<span class="badge red">OVERDUE</span>';
        else if (s.status === 'DUE_SOON') badge = '<span class="badge amber">DUE SOON</span>';

        return `
          <tr>
            <td><a href="#/vehiclecosting?asset_id=${s.asset_id}"><b>${esc(s.asset_code)}</b></a></td>
            <td>${esc(s.registration || '—')}</td>
            <td>${esc(s.category || '—')}</td>
            <td>${esc(s.brand || '')} ${esc(s.type || '')}</td>
            <td class="num">${num(s.current_hours)} hrs</td>
            <td class="num"><b>${num(s.next_service_hours)} hrs</b></td>
            <td class="num"><b style="color:${s.hours_remaining < 0 ? 'var(--red)' : s.hours_remaining < 50 ? 'var(--amber)' : 'inherit'}">${num(s.hours_remaining)} hrs</b></td>
            <td>${badge}</td>
          </tr>
        `;
      });

      const headers = [
        { label: 'Vehicle Code' }, { label: 'Registration' }, { label: 'Category' },
        { label: 'Model' }, { label: 'Current Meter', num: true }, { label: 'Next Service At', num: true },
        { label: 'Remaining Hours', num: true }, { label: 'Service Status' }
      ];

      pane.innerHTML = `
        <div class="card">
          <div class="toolbar" style="margin-bottom:8px">
            <h3 style="margin:0">Preventative Maintenance & Service Threshold Planner</h3>
          </div>
          ${tableWrap(headers, rows, { scroll: true })}
        </div>
      `;
    } catch (e) {
      pane.innerHTML = `<div class="card err">Error loading service planner: ${esc(e.message)}</div>`;
    }
  }

  // ===========================================================================
  // MODALS & FORMS
  // ===========================================================================

  // 1. New Fuel Dispense Modal
  async function openNewDispenseModal(onSuccess) {
    let assets = [], tanks = [], latestPrice = null;
    try {
      [assets, tanks, latestPrice] = await Promise.all([
        api('/assets'),
        api('/tanks'),
        api('/fuel/prices/latest').catch(() => null)
      ]);
    } catch (e) {
      toast('Failed to load assets/tanks: ' + e.message, 'err');
      return;
    }

    const curPrice = latestPrice ? Number(latestPrice.price_per_litre) : 329.00;
    const assetOpts = assets.map((a) => ({ value: a.id, label: `${a.code} — ${a.registration || 'No Reg'} (${a.type || a.brand || 'Vehicle'})` }));
    const tankOpts = tanks.map((t) => ({ value: t.id, label: `${t.name} (Stock: ${num(t.current_litres)} L)` }));

    modal('New Fuel Dispense Entry', `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>${field('Select Vehicle / Machine', 'asset_id', { type: 'select', options: [{ value: '', label: '— Select Vehicle —' }, ...assetOpts] })}</div>
        <div>${field('Select Bulk Tank', 'tank_id', { type: 'select', options: tankOpts })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Dispense Date', 'date', { type: 'date', value: today() })}</div>
        <div>${field('Quantity (Litres)', 'litres', { type: 'number', placeholder: 'e.g. 150', step: '0.1' })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Unit Price (LKR / L)', 'unit_price', { type: 'number', value: curPrice, step: '0.01' })}</div>
        <div>
          <label>Estimated Total Cost</label>
          <div id="dispense-total-preview" style="font-size:16px;font-weight:700;padding:8px 0;color:var(--primary)">Rs 0.00</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Current Meter Reading (Hrs/Km)', 'meter_reading', { type: 'number', placeholder: 'e.g. 2450' })}</div>
        <div>${field('Driver / Recipient Name', 'driver_name', { placeholder: 'Name of machine driver' })}</div>
      </div>
      <div style="margin-top:8px">
        ${field('Notes / Fuel Request No', 'notes', { placeholder: 'Optional reference or work description' })}
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-dispense">Dispense Diesel</button>
      </div>
    `, (mbody, close) => {
      const qLitres = qs('input[name="litres"]', mbody);
      const qPrice = qs('input[name="unit_price"]', mbody);
      const qPreview = qs('#dispense-total-preview', mbody);

      const updateCalc = () => {
        const l = Number(qLitres.value) || 0;
        const p = Number(qPrice.value) || 0;
        qPreview.textContent = money(l * p);
      };
      qLitres.oninput = updateCalc;
      qPrice.oninput = updateCalc;

      qs('#btn-submit-dispense', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.asset_id) { toast('Please select a vehicle', 'err'); return; }
        if (!d.litres || Number(d.litres) <= 0) { toast('Please enter a valid litre quantity', 'err'); return; }

        try {
          await api('/fuel/issues', {
            method: 'POST',
            body: {
              asset_id: parseInt(d.asset_id, 10),
              tank_id: d.tank_id ? parseInt(d.tank_id, 10) : undefined,
              date: d.date,
              litres: Number(d.litres),
              unit_price: Number(d.unit_price),
              meter_reading: d.meter_reading ? Number(d.meter_reading) : undefined,
              driver_name: d.driver_name,
              notes: d.notes
            }
          });
          toast('Diesel dispensed successfully');
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    }, { wide: true });
  }

  // 2. Log Dip Modal
  async function openLogDipModal(onSuccess) {
    let tanks = [];
    try { tanks = await api('/tanks'); } catch { return; }
    const tankOpts = tanks.map((t) => ({ value: t.id, label: `${t.name} (Capacity: ${num(t.capacity_litres)} L)` }));

    modal('Record Physical Bulk Tank Dip', `
      ${field('Bulk Tank', 'tank_id', { type: 'select', options: tankOpts })}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Dip Date', 'dip_date', { type: 'date', value: today() })}</div>
        <div>${field('Dip Measurement (cm)', 'dip_cm', { type: 'number', step: '0.1', placeholder: 'e.g. 185.5' })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Measured Volume (Litres)', 'calculated_litres', { type: 'number', step: '1', placeholder: 'e.g. 18500' })}</div>
        <div>${field('Water Level (cm)', 'water_cm', { type: 'number', step: '0.1', value: '0' })}</div>
      </div>
      <div style="margin-top:8px">
        ${field('Dip Notes / Observations', 'notes', { placeholder: 'e.g. Verified by site engineer' })}
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-dip">Save Dip Record</button>
      </div>
    `, (mbody, close) => {
      qs('#btn-submit-dip', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.tank_id || !d.calculated_litres) { toast('Please complete tank and litres fields', 'err'); return; }
        try {
          await api(`/tanks/${d.tank_id}/dips`, {
            method: 'POST',
            body: {
              dip_date: d.dip_date,
              dip_cm: d.dip_cm ? Number(d.dip_cm) : undefined,
              calculated_litres: Number(d.calculated_litres),
              water_cm: d.water_cm ? Number(d.water_cm) : 0,
              notes: d.notes
            }
          });
          toast('Tank dip recorded');
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
  }

  // 3. Receive Bowser Modal
  async function openReceiveBowserModal(onSuccess) {
    let tanks = [];
    try { tanks = await api('/tanks'); } catch { return; }
    const tankOpts = tanks.map((t) => ({ value: t.id, label: `${t.name} (Current: ${num(t.current_litres)} L)` }));

    modal('Receive Diesel Bowser / Bulk Stock', `
      ${field('Target Tank', 'tank_id', { type: 'select', options: tankOpts })}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Receipt Date', 'order_date', { type: 'date', value: today() })}</div>
        <div>${field('Litres Received', 'ordered_litres', { type: 'number', placeholder: 'e.g. 6600' })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Supplier / Bowser No', 'supplier_name', { placeholder: 'e.g. CPC Bowser #WP-DA-4421' })}</div>
        <div>${field('Invoice / Delivery No', 'invoice_no', { placeholder: 'e.g. INV-CPC-9821' })}</div>
      </div>
      <div style="margin-top:8px">
        ${field('Unit Price (LKR / L)', 'unit_price', { type: 'number', value: '329', step: '0.01' })}
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-bowser">Confirm Bowser Receipt</button>
      </div>
    `, (mbody, close) => {
      qs('#btn-submit-bowser', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.tank_id || !d.ordered_litres) { toast('Please complete all required fields', 'err'); return; }
        try {
          const ord = await api(`/tanks/${d.tank_id}/orders`, {
            method: 'POST',
            body: {
              order_date: d.order_date,
              ordered_litres: Number(d.ordered_litres),
              supplier_name: d.supplier_name,
              invoice_no: d.invoice_no,
              unit_price: Number(d.unit_price)
            }
          });
          // Auto receive order
          if (ord && ord.id) {
            await api(`/tanks/orders/${ord.id}/receive`, {
              method: 'POST',
              body: { received_litres: Number(d.ordered_litres) }
            });
          }
          toast('Bowser received & tank stock replenished');
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
  }

  // 4. Log Meter Reading Modal
  async function openLogMeterModal(onSuccess) {
    let assets = [];
    try { assets = await api('/assets'); } catch { return; }
    const assetOpts = assets.map((a) => ({ value: a.id, label: `${a.code} — ${a.registration || 'No Reg'}` }));

    modal('Log Machine Telemetry & Operational State', `
      ${field('Vehicle / Machine', 'asset_id', { type: 'select', options: [{ value: '', label: '— Select Asset —' }, ...assetOpts] })}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Date', 'reading_date', { type: 'date', value: today() })}</div>
        <div>${field('Meter Reading', 'reading_value', { type: 'number', step: '1', placeholder: 'e.g. 1540' })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Meter Type', 'meter_type', { type: 'select', options: [{ value: 'hours', label: 'Hours (hrs)' }, { value: 'km', label: 'Kilometres (km)' }] })}</div>
        <div>
          ${field('Daily Operational Condition', 'condition', {
            type: 'select',
            options: [
              { value: 'RUNNING', label: 'RUNNING (Active)' },
              { value: 'BREAKDOWN', label: 'BREAKDOWN (Under Repair)' },
              { value: 'IDLE', label: 'IDLE (Available / Standby)' },
              { value: 'MAINTENANCE', label: 'MAINTENANCE (Servicing)' }
            ]
          })}
        </div>
      </div>
      <div style="margin-top:8px">
        ${field('Notes / Location', 'notes', { placeholder: 'Site remarks, working hours, etc.' })}
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-meter">Log Telemetry</button>
      </div>
    `, (mbody, close) => {
      qs('#btn-submit-meter', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.asset_id || !d.reading_value) { toast('Asset and reading are required', 'err'); return; }
        try {
          await api('/meters', {
            method: 'POST',
            body: {
              asset_id: parseInt(d.asset_id, 10),
              reading_date: d.reading_date,
              reading_value: Number(d.reading_value),
              meter_type: d.meter_type,
              notes: d.notes
            }
          });
          if (d.condition) {
            await api('/meters/conditions', {
              method: 'POST',
              body: {
                asset_id: parseInt(d.asset_id, 10),
                condition_date: d.reading_date,
                condition: d.condition,
                notes: d.notes
              }
            });
          }
          toast('Meter reading logged');
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
  }

  // 5. Generate Monthly Bill Modal
  async function openGenerateBillModal(onSuccess) {
    let projects = [];
    try { projects = await api('/projects'); } catch { return; }
    const projOpts = projects.map((p) => ({ value: p.id, label: p.name }));
    const nowMonth = new Date().toISOString().slice(0, 7);

    modal('Generate Monthly Hire Bill (With Diesel Deductions)', `
      ${field('Target Project / Client', 'project_id', { type: 'select', options: [{ value: '', label: '— Select Project —' }, ...projOpts] })}
      <div style="margin-top:8px">
        ${field('Billing Month', 'month', { type: 'month', value: nowMonth })}
      </div>
      <p class="muted" style="margin-top:10px">
        This will calculate all equipment rental hours for the project during this month using active rate cards,
        and automatically deduct the cost of diesel consumed by those machines.
      </p>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-gen-bill">Generate Bill</button>
      </div>
    `, (mbody, close) => {
      qs('#btn-submit-gen-bill', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.project_id || !d.month) { toast('Please choose project and month', 'err'); return; }
        try {
          const res = await api('/billing/generate', {
            method: 'POST',
            body: { project_id: parseInt(d.project_id, 10), month: d.month }
          });
          toast(`Bill ${res.bill_no} generated! Net: ${money(res.net_amount)}`);
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
  }

  // 6. Set Rate Modal
  async function openAddRateModal(onSuccess) {
    let assets = [];
    try { assets = await api('/assets'); } catch { return; }
    const assetOpts = assets.map((a) => ({ value: a.id, label: `${a.code} — ${a.registration || 'No Reg'}` }));

    modal('Set Equipment Rental Rate Card', `
      ${field('Asset (Leave empty for Category Default)', 'asset_id', { type: 'select', options: [{ value: '', label: '— Category Default —' }, ...assetOpts] })}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Rate Type', 'rate_type', { type: 'select', options: [{ value: 'hourly', label: 'Hourly' }, { value: 'daily', label: 'Daily' }, { value: 'monthly', label: 'Monthly' }] })}</div>
        <div>${field('Rate Amount (LKR)', 'rate_amount', { type: 'number', step: '100', placeholder: 'e.g. 4500' })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Minimum Hours / Day', 'minimum_hours', { type: 'number', value: '8' })}</div>
        <div>${field('Category (if general)', 'category', { placeholder: 'e.g. DT or EX' })}</div>
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-rate">Save Rate Card</button>
      </div>
    `, (mbody, close) => {
      qs('#btn-submit-rate', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.rate_amount) { toast('Rate amount required', 'err'); return; }
        try {
          await api('/billing/rates', {
            method: 'POST',
            body: {
              asset_id: d.asset_id ? parseInt(d.asset_id, 10) : undefined,
              category: d.category,
              rate_type: d.rate_type,
              rate_amount: Number(d.rate_amount),
              minimum_hours: d.minimum_hours ? Number(d.minimum_hours) : 8
            }
          });
          toast('Rate card saved');
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
  }

  // 7. Update Fuel Price Modal
  async function openUpdatePriceModal(onSuccess) {
    modal('Update Standard Diesel Unit Price', `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>${field('Effective Date', 'effective_date', { type: 'date', value: today() })}</div>
        <div>${field('Price per Litre (LKR)', 'price_per_litre', { type: 'number', step: '0.01', placeholder: 'e.g. 335.00' })}</div>
      </div>
      <div style="margin-top:8px">
        ${field('Revision Reason / Notes', 'notes', { placeholder: 'e.g. Monthly CPC price revision' })}
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-price">Publish New Price</button>
      </div>
    `, (mbody, close) => {
      qs('#btn-submit-price', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.price_per_litre) { toast('Please enter the new price', 'err'); return; }
        try {
          await api('/fuel/prices', {
            method: 'POST',
            body: {
              price_per_litre: Number(d.price_per_litre),
              effective_date: d.effective_date,
              notes: d.notes
            }
          });
          toast('Diesel price updated');
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
  }

  // Expose modals for use by other views
  window.openNewDispenseModal = openNewDispenseModal;
  window.openLogDipModal = openLogDipModal;
  window.openReceiveBowserModal = openReceiveBowserModal;
  window.openLogMeterModal = openLogMeterModal;
})();
