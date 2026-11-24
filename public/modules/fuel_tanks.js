'use strict';

/**
 * Native WorkshopOne Bulk Tanks & Bowsers Module (Plan V2)
 *
 * Provides:
 * - Real-time visual cards of all 32 bulk tanks and mobile bowsers
 * - Dipstick physical verification and theoretical balance variance auditing
 * - Bulk fuel delivery receipts into storage tanks
 */

(function () {
  async function renderFuelTanks(content) {
    const isAdm = typeof isAdmin === 'function' && isAdmin();
    const canManageTanks = isAdm || (typeof canDo === 'function' && canDo('fuel.tanks.manage'));
    const canDip = isAdm || (typeof canDo === 'function' && canDo('fuel.tanks.dip'));
    const canRefill = isAdm || (typeof canDo === 'function' && canDo('fuel.tanks.refill'));
    const canSeeCost = isAdm || (typeof canDo === 'function' && canDo('fuel.prices.view', 'fuel.reports.view', 'fuel.tanks.manage'));

    let curFilter = 'all';
    let lastReconcile = null;

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / <a href="#/fuel">Fuel</a> / Bulk Tanks</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Storage Tanks &amp; Mobile Bowsers</h1>
          <p class="muted" style="margin:4px 0 0 0">Bulk diesel inventory, dipstick reconciliation, opening-stock calibration, and site Bowser deployments</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${(canManageTanks || canDip) ? '<button class="btn" id="btn_tank_wizard">🧭 Opening Stock &amp; Dip Wizard</button>' : ''}
          <a class="btn" href="#/fuel?tab=sites-overview">🎯 Site Fuel Budgets →</a>
          ${canManageTanks ? '<button class="btn primary" id="btn_new_tank">+ New Tank / Bowser</button>' : ''}
        </div>
      </div>

      <div id="tank_recon_strip" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px"></div>

      <div class="pill-row" id="tank_filter_pills" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
        <button type="button" class="btn sm primary" data-tfilter="all">All Active Tanks</button>
        <button type="button" class="btn sm" data-tfilter="zero">Zero Stock (0 L)</button>
        <button type="button" class="btn sm" data-tfilter="low">Low Stock (&lt;20%)</button>
        <button type="button" class="btn sm" data-tfilter="variance">Unresolved Dip Variance</button>
      </div>

      <div class="tank-grid" id="tanks_container" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:16px">
        <div class="card" style="padding:24px;text-align:center" class="muted">Loading storage tanks...</div>
      </div>
    `;

    const wizardBtn = qs('#btn_tank_wizard', content);
    if (wizardBtn) {
      wizardBtn.onclick = () => openReconciliationWizard();
    }

    const newTankBtn = qs('#btn_new_tank', content);
    if (newTankBtn) {
      newTankBtn.onclick = async () => {
        let projects = [];
        try {
          const pRes = await api('/projects?active=1').catch(() => []);
          projects = Array.isArray(pRes) ? pRes : (pRes.projects || []);
        } catch (_) {}
        const modal = document.createElement('div');
        modal.className = 'modal-bg modal-backdrop';
        modal.innerHTML = `
          <div class="modal" style="max-width:480px;padding:24px">
            <h2 style="margin-top:0">🛢️ Add / Update Bulk Tank or Bowser</h2>
            <form id="form_new_tank" style="display:flex;flex-direction:column;gap:12px">
              <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:10px">
                <div>
                  <label style="font-size:12px;font-weight:600">Tank Code *</label>
                  <input type="text" id="nt_code" required class="input" placeholder="e.g. TK-CEP03-01" style="width:100%">
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Tank / Bowser Name *</label>
                  <input type="text" id="nt_name" required class="input" placeholder="e.g. CEP-03 Site Tank" style="width:100%">
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div>
                  <label style="font-size:12px;font-weight:600">Tank Type</label>
                  <select id="nt_type" class="input" style="width:100%">
                    <option value="FIXED">Fixed Storage Tank</option>
                    <option value="BOWSER">Mobile Bowser</option>
                  </select>
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Fuel Kind</label>
                  <select id="nt_fuel" class="input" style="width:100%">
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
                  <label style="font-size:12px;font-weight:600">Capacity (Litres)</label>
                  <input type="number" step="1" min="0" id="nt_cap" class="input" value="10000" style="width:100%">
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600">Opening Stock (Litres)</label>
                  <input type="number" step="1" min="0" id="nt_curr" class="input" value="0" style="width:100%">
                </div>
              </div>
              <div>
                <label style="font-size:12px;font-weight:600">Assigned Project Site</label>
                <select id="nt_proj" class="input" style="width:100%">
                  <option value="">— Central / Unassigned —</option>
                  ${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.code || p.id)})</option>`).join('')}
                </select>
              </div>
              <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
                <button type="button" class="btn" id="btn_nt_cancel">Cancel</button>
                <button type="submit" class="btn primary">Save Tank</button>
              </div>
            </form>
          </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#btn_nt_cancel').onclick = () => modal.remove();
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        modal.querySelector('#form_new_tank').onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api('/fuel/tanks', {
              method: 'POST',
              body: {
                code: modal.querySelector('#nt_code').value.trim(),
                name: modal.querySelector('#nt_name').value.trim(),
                tankType: modal.querySelector('#nt_type').value,
                fuelType: modal.querySelector('#nt_fuel').value,
                capacityLitres: Number(modal.querySelector('#nt_cap').value || 0),
                currentLitres: Number(modal.querySelector('#nt_curr').value || 0),
                projectId: modal.querySelector('#nt_proj').value ? Number(modal.querySelector('#nt_proj').value) : null,
              },
            });
            toast('Fuel tank saved successfully');
            modal.remove();
            loadTanks();
          } catch (err) {
            if (typeof toast === 'function') toast('Error saving tank: ' + err.message, 'err');
          }
        };
      };
    }

    async function openReconciliationWizard() {
      const dlg = document.createElement('div');
      dlg.className = 'modal-bg modal-backdrop';
      dlg.innerHTML = `
        <div class="modal" style="max-width:860px;width:96%;max-height:88vh;overflow-y:auto;padding:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div>
              <h2 style="margin:0">🧭 Opening Stock &amp; Tank Dip Reconciliation Wizard</h2>
              <p class="muted" style="margin:4px 0 0 0;font-size:12px">Set opening stock calibration without triggering variance alerts, and clear historical dip discrepancies with audit notes.</p>
            </div>
            <button type="button" class="btn sm" id="wiz_close">✕ Close</button>
          </div>
          <div id="wiz_body" class="muted" style="padding:18px;text-align:center">Loading reconciliation data…</div>
        </div>
      `;
      document.body.appendChild(dlg);
      dlg.querySelector('#wiz_close').onclick = () => dlg.remove();
      dlg.onclick = (e) => { if (e.target === dlg) dlg.remove(); };

      async function paintWizard() {
        const body = dlg.querySelector('#wiz_body');
        try {
          const [recon, tRes] = await Promise.all([
            api('/fuel/tanks/reconciliation'),
            api('/fuel/tanks'),
          ]);
          const allTanks = (tRes.tanks || []).filter((t) => t.active !== 0 && !t.hide_stock);
          const unres = recon.unresolved_dips || [];
          const sortedTanks = [...allTanks].sort((a, b) => (Number(a.current_litres) || 0) - (Number(b.current_litres) || 0));

          body.innerHTML = `
            <div style="text-align:left">
              <h3 style="margin:0 0 6px 0;font-size:15px">1. Unresolved High-Variance Physical Dips (&gt; ${esc(recon.threshold_litres || 50)} L) — ${unres.length}</h3>
              ${unres.length ? `
                <div style="max-height:220px;overflow-y:auto;margin-bottom:16px;border:1px solid var(--border);border-radius:6px">
                  <table class="table" style="width:100%;font-size:12px;margin:0">
                    <thead><tr><th>Tank</th><th>Date</th><th style="text-align:right">Dip (L)</th><th style="text-align:right">Book (L)</th><th style="text-align:right">Variance (L)</th><th>Reconciliation Note *</th><th></th></tr></thead>
                    <tbody>
                      ${unres.map((d) => `
                        <tr>
                          <td><b>${esc(d.tank_name)}</b><div class="muted" style="font-size:10.5px">${esc(d.tank_code)}</div></td>
                          <td style="white-space:nowrap">${esc(String(d.dip_date || '').slice(0, 16))}</td>
                          <td style="text-align:right">${Number(d.dip_litres || 0).toLocaleString()} L</td>
                          <td style="text-align:right">${Number(d.computed_balance || 0).toLocaleString()} L</td>
                          <td style="text-align:right;font-weight:700;color:#dc2626">${d.variance_litres > 0 ? '+' : ''}${Number(d.variance_litres || 0).toLocaleString()} L</td>
                          <td><input type="text" class="input sm wiz-rec-note" data-dip="${esc(d.id)}" placeholder="Reason / physical audit sign-off" style="min-width:190px"></td>
                          <td><button type="button" class="btn sm primary wiz-rec-btn" data-dip="${esc(d.id)}">✓ Reconcile</button></td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>` : '<div class="card" style="padding:10px 12px;margin-bottom:14px;border-left:3px solid #10b981;font-size:12.5px">✅ No unresolved tank dip discrepancies above threshold.</div>'}

              <h3 style="margin:0 0 6px 0;font-size:15px">2. Bulk Opening Stock Calibration (${(recon.counts && recon.counts.zero_stock_count) || 0} tanks at 0 L)</h3>
              <p class="muted" style="margin:0 0 8px 0;font-size:11.5px">Enter opening physical stock (L) for any tank you want to initialize or recalibrate. Blank rows are skipped.</p>
              <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
                <table class="table" style="width:100%;font-size:12px;margin:0">
                  <thead><tr><th>Tank</th><th>Site</th><th style="text-align:right">Current</th><th style="text-align:right">Capacity</th><th>New Opening Stock (L)</th><th>Audit Note</th></tr></thead>
                  <tbody>
                    ${sortedTanks.map((t) => `
                      <tr class="wiz-os-row" data-tid="${esc(t.id)}">
                        <td><b>${esc(t.name)}</b> <span class="badge">${esc(t.tank_type)}</span></td>
                        <td>${esc(t.project_name || 'Central')}</td>
                        <td style="text-align:right;font-weight:700;color:${(Number(t.current_litres) || 0) <= 0 ? '#dc2626' : 'inherit'}">${Number(t.current_litres || 0).toLocaleString()} L</td>
                        <td style="text-align:right">${Number(t.capacity_litres || 0).toLocaleString()} L</td>
                        <td><input type="number" step="0.1" min="0" class="input sm wiz-os-val" placeholder="Leave blank to skip" style="width:135px"></td>
                        <td><input type="text" class="input sm wiz-os-note" placeholder="Opening physical gauge" style="width:170px"></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
              <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
                <button type="button" class="btn primary" id="wiz_save_os">💾 Apply Opening Stock Updates</button>
              </div>
            </div>
          `;

          qsa('.wiz-rec-btn', body).forEach((btn) => {
            btn.onclick = async () => {
              const dipId = btn.dataset.dip;
              const noteInp = body.querySelector(`.wiz-rec-note[data-dip="${CSS.escape(dipId)}"]`);
              const note = noteInp ? noteInp.value.trim() : '';
              if (note.length < 3) {
                if (typeof toast === 'function') toast('Enter a reconciliation explanation (min 3 characters)', 'err');
                return;
              }
              try {
                await api(`/fuel/tanks/dips/${encodeURIComponent(dipId)}/reconcile`, {
                  method: 'POST',
                  body: { note },
                });
                if (typeof toast === 'function') toast('Tank dip variance reconciled');
                paintWizard();
                loadTanks();
              } catch (err) {
                if (typeof toast === 'function') toast(err.message, 'err');
              }
            };
          });

          const saveOsBtn = body.querySelector('#wiz_save_os');
          if (saveOsBtn) {
            saveOsBtn.onclick = async () => {
              const items = [];
              qsa('.wiz-os-row', body).forEach((row) => {
                const raw = row.querySelector('.wiz-os-val').value;
                if (raw === '' || raw === null) return;
                items.push({
                  tankId: row.dataset.tid,
                  openingLitres: Number(raw),
                  note: row.querySelector('.wiz-os-note').value.trim() || 'Opening stock calibration',
                });
              });
              if (!items.length) {
                if (typeof toast === 'function') toast('Enter opening litres for at least one tank', 'err');
                return;
              }
              try {
                const res = await api('/fuel/tanks/opening-stock', {
                  method: 'POST',
                  body: { items },
                });
                if (typeof toast === 'function') toast(`Updated opening stock on ${res.updated_count || items.length} tank(s)`);
                paintWizard();
                loadTanks();
              } catch (err) {
                if (typeof toast === 'function') toast(err.message, 'err');
              }
            };
          }
        } catch (err) {
          body.innerHTML = `<div class="err">${esc(err.message)}</div>`;
        }
      }

      paintWizard();
    }

    async function loadTanks() {
      const container = qs('#tanks_container');
      try {
        const [{ tanks }, recon] = await Promise.all([
          api('/fuel/tanks'),
          api('/fuel/tanks/reconciliation').catch(() => null),
        ]);
        lastReconcile = recon;
        const unresolvedTankIds = new Set((recon && recon.unresolved_dips ? recon.unresolved_dips : []).map((d) => String(d.tank_id)));

        const strip = qs('#tank_recon_strip', content);
        if (strip && recon && recon.counts) {
          const rc = recon.counts;
          strip.innerHTML = `
            <div class="card kpi-card" style="padding:12px 14px"><div class="muted" style="font-size:11px;font-weight:600">ACTIVE TANKS</div><div style="font-size:22px;font-weight:800">${rc.total_tanks}</div></div>
            <div class="card kpi-card" style="padding:12px 14px;${rc.zero_stock_count ? 'border-left:4px solid #dc2626' : ''}"><div class="muted" style="font-size:11px;font-weight:600">AT 0 L (NEEDS OPENING)</div><div style="font-size:22px;font-weight:800;color:${rc.zero_stock_count ? '#dc2626' : '#059669'}">${rc.zero_stock_count}</div></div>
            <div class="card kpi-card" style="padding:12px 14px"><div class="muted" style="font-size:11px;font-weight:600">LOW STOCK (&lt;20%)</div><div style="font-size:22px;font-weight:800;color:${rc.low_stock_count ? '#d97706' : '#059669'}">${rc.low_stock_count}</div></div>
            <div class="card kpi-card" style="padding:12px 14px;${rc.unresolved_dip_count ? 'border-left:4px solid #dc2626' : ''}"><div class="muted" style="font-size:11px;font-weight:600">UNRESOLVED DIP VARIANCES</div><div style="font-size:22px;font-weight:800;color:${rc.unresolved_dip_count ? '#dc2626' : '#059669'}">${rc.unresolved_dip_count}</div></div>
          `;
        }

        qsa('[data-tfilter]', content).forEach((b) => {
          b.classList.toggle('primary', b.dataset.tfilter === curFilter);
          b.onclick = () => {
            curFilter = b.dataset.tfilter;
            loadTanks();
          };
        });

        const visibleTanks = (tanks || []).filter((t) => {
          const isHidden = !!t.hide_stock || t.current_litres == null;
          if (curFilter === 'all') return true;
          if (curFilter === 'zero') return !isHidden && (Number(t.current_litres) || 0) <= 0;
          if (curFilter === 'low') {
            const cap = Number(t.capacity_litres) || 0;
            const cur = Number(t.current_litres) || 0;
            return !isHidden && cap > 0 && cur > 0 && (cur / cap) < 0.2;
          }
          if (curFilter === 'variance') return unresolvedTankIds.has(String(t.id));
          return true;
        });

        if (!visibleTanks.length) {
          container.innerHTML = '<div class="card" style="padding:24px;text-align:center" class="muted">No storage tanks match this filter.</div>';
          return;
        }

        container.innerHTML = visibleTanks.map((t) => {
          const isHidden = !!t.hide_stock || t.current_litres == null;
          const cap = Number(t.capacity_litres) || 1;
          const curr = isHidden ? 0 : (Number(t.current_litres) || 0);
          const pct = isHidden ? 0 : Math.min(100, Math.round((curr / cap) * 100));
          const isLow = !isHidden && pct < 20;
          const hasVar = unresolvedTankIds.has(String(t.id));
          const barColor = isLow ? '#ef4444' : (pct > 75 ? '#10b981' : '#3b82f6');

          return `
            <div class="card" style="padding:18px;display:flex;flex-direction:column;justify-content:space-between;${hasVar ? 'border:1px solid #ef4444' : ''}">
              <div>
                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                  <div>
                    <h3 style="margin:0 0 4px 0;font-size:16px">${esc(t.name)}</h3>
                    <span class="badge ${t.tank_type === 'BOWSER' ? 'info' : 'secondary'}">${esc(t.tank_type)}</span>
                    ${hasVar ? '<span class="badge red" style="margin-left:4px">⚠️ Dip Variance</span>' : ''}
                    ${t.project_name ? `<span class="muted" style="font-size:11px;margin-left:6px">📍 ${esc(t.project_name)}</span>` : ''}
                  </div>
                  <span style="font-size:18px">${t.tank_type === 'BOWSER' ? '🚛' : '🛢️'}</span>
                </div>

                <div style="margin:16px 0">
                  ${isHidden ? `
                    <div class="badge warn" style="padding:6px 10px">🔒 Stock Balance Hidden by Admin Policy</div>
                  ` : `
                    <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
                      <span class="muted">Current Stock:</span>
                      <span style="font-weight:700;font-size:15px">${curr.toLocaleString()} / ${cap.toLocaleString()} L</span>
                    </div>
                    <div style="width:100%;height:10px;background:rgba(0,0,0,0.06);border-radius:6px;overflow:hidden">
                      <div style="width:${pct}%;height:100%;background:${barColor};transition:width 0.3s"></div>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px" class="muted">
                      <span>${pct}% Available</span>
                      ${isLow ? '<span style="color:#ef4444;font-weight:700">⚠️ LOW STOCK</span>' : '<span>Optimal</span>'}
                    </div>
                  `}
                </div>
              </div>

              <div style="display:flex;gap:6px;border-top:1px solid var(--border);padding-top:12px;margin-top:8px">
                ${canDip ? `<button class="btn sm primary btn-dip" data-id="${esc(t.id)}" data-name="${esc(t.name)}" style="flex:1">📏 Dip</button>` : ''}
                ${canRefill ? `<button class="btn sm btn-refill" data-id="${esc(t.id)}" data-name="${esc(t.name)}" style="flex:1">📥 Refill</button>` : ''}
                <button class="btn sm btn-history" data-id="${esc(t.id)}" data-name="${esc(t.name)}" style="flex:1">📜 History</button>
              </div>
            </div>
          `;
        }).join('');

        // Wire History buttons (Deliveries + Dips)
        qsa('.btn-history', container).forEach((btn) => {
          btn.onclick = async () => {
            const tankId = btn.getAttribute('data-id');
            const tankName = btn.getAttribute('data-name');
            const modal = document.createElement('div');
            modal.className = 'modal-bg modal-backdrop';
            modal.innerHTML = `<div class="modal" style="max-width:720px;padding:24px"><h2 style="margin-top:0">📜 Tank Delivery &amp; Dip History — ${esc(tankName)}</h2><div id="th_body" class="muted">Loading...</div><div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" id="th_close">Close</button></div></div>`;
            document.body.appendChild(modal);
            modal.querySelector('#th_close').onclick = () => modal.remove();
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
            try {
              const res = await api(`/fuel/tanks/${encodeURIComponent(tankId)}`);
              const dels = res.deliveries || [];
              const dips = res.dips || [];
              modal.querySelector('#th_body').innerHTML = `
                <h4 style="margin:6px 0">🚛 Bulk Fuel Deliveries Added (${dels.length})</h4>
                <div style="max-height:220px;overflow-y:auto;margin-bottom:14px">
                  <table class="table" style="width:100%;font-size:12px">
                    <thead><tr><th>Date</th><th style="text-align:right">Litres</th>${canSeeCost ? '<th style="text-align:right">Value (LKR)</th>' : ''}<th>Supplier</th><th>Invoice</th><th>Received By</th></tr></thead>
                    <tbody>${dels.length ? dels.map((d) => `<tr><td>${esc(String(d.delivery_date || '').slice(0, 10))}</td><td style="text-align:right;font-weight:700;color:#059669">+${Number(d.litres || 0).toLocaleString()} L</td>${canSeeCost ? `<td style="text-align:right">${Number(d.cost_cents) > 0 ? 'Rs ' + (Number(d.cost_cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '—'}</td>` : ''}<td>${esc(d.supplier || '—')}</td><td>${esc(d.invoice_number || '—')}</td><td>${esc(d.receiver_name || '—')}</td></tr>`).join('') : `<tr><td colspan="${canSeeCost ? 6 : 5}" class="muted" style="text-align:center">No deliveries recorded</td></tr>`}</tbody>
                  </table>
                </div>
                <h4 style="margin:6px 0">📏 Physical Dipstick Audits (${dips.length})</h4>
                <div style="max-height:180px;overflow-y:auto">
                  <table class="table" style="width:100%;font-size:12px">
                    <thead><tr><th>Date</th><th>Type</th><th style="text-align:right">Dip (L)</th><th style="text-align:right">Variance (L)</th><th>Status</th><th>Recorded By</th><th>Notes</th></tr></thead>
                    <tbody>${dips.length ? dips.map((d) => `<tr><td>${esc(String(d.dip_date || '').slice(0, 10))}</td><td><span class="badge" style="font-size:10px">${esc(d.dip_type || 'PHYSICAL_DIP')}</span></td><td style="text-align:right">${Number(d.dip_litres || 0).toLocaleString()} L</td><td style="text-align:right;font-weight:700">${d.variance_litres > 0 ? '+' : ''}${Number(d.variance_litres || 0).toLocaleString()} L</td><td>${d.reconciled ? '<span class="badge green">Reconciled</span>' : (Math.abs(Number(d.variance_litres || 0)) > 50 ? '<span class="badge red">Open Variance</span>' : '<span class="badge">OK</span>')}</td><td>${esc(d.recorder_name || '—')}</td><td>${esc(d.reconciled_note || d.note || d.notes || '—')}</td></tr>`).join('') : '<tr><td colspan="7" class="muted" style="text-align:center">No dips recorded</td></tr>'}</tbody>
                  </table>
                </div>
              `;
            } catch (err) {
              modal.querySelector('#th_body').innerHTML = `<div class="err">${esc(err.message)}</div>`;
            }
          };
        });

        // Wire Dip buttons
        qsa('.btn-dip', container).forEach((btn) => {
          btn.onclick = () => {
            const tankId = btn.getAttribute('data-id');
            const tankName = btn.getAttribute('data-name');

            const modal = document.createElement('div');
            modal.className = 'modal-bg modal-backdrop';
            modal.innerHTML = `
              <div class="modal" style="max-width:440px;padding:24px">
                <h2 style="margin-top:0">📏 Physical Tank Dip Audit</h2>
                <p class="muted" style="margin-top:0">Tank: <b>${esc(tankName)}</b></p>
                <form id="form_dip" style="display:flex;flex-direction:column;gap:12px">
                  <div>
                    <label style="font-size:12px;font-weight:600">Physical Dip Measurement (Litres) *</label>
                    <input type="number" step="0.1" id="dip_litres" required class="input" placeholder="Actual litres measured" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:12px;font-weight:600">Audit Notes / Observer</label>
                    <textarea id="dip_notes" class="input" placeholder="Dipstick reading details" style="width:100%;height:60px"></textarea>
                  </div>
                  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
                    <button type="button" class="btn" id="btn_cancel_dip">Cancel</button>
                    <button type="submit" class="btn primary">Verify & Save</button>
                  </div>
                </form>
              </div>
            `;
            document.body.appendChild(modal);
            modal.querySelector('#btn_cancel_dip').onclick = () => modal.remove();
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

            modal.querySelector('#form_dip').onsubmit = async (e) => {
              e.preventDefault();
              const dipLitres = Number(modal.querySelector('#dip_litres').value);
              const note = modal.querySelector('#dip_notes').value.trim();
              try {
                const res = await api(`/fuel/tanks/${tankId}/dip`, {
                  method: 'POST',
                  body: { dipLitres, note }
                });
                const varSign = res.variance_litres >= 0 ? `+${res.variance_litres}` : `${res.variance_litres}`;
                toast(`Physical dip saved. Variance: ${varSign} L`);
                modal.remove();
                loadTanks();
              } catch (err) {
                if (typeof toast === 'function') toast('Error recording dip: ' + err.message, 'err');
              }
            };
          };
        });

        // Wire Refill buttons
        qsa('.btn-refill', container).forEach((btn) => {
          btn.onclick = () => {
            const tankId = btn.getAttribute('data-id');
            const tankName = btn.getAttribute('data-name');

            const modal = document.createElement('div');
            modal.className = 'modal-bg modal-backdrop';
            modal.innerHTML = `
              <div class="modal" style="max-width:480px;padding:24px">
                <h2 style="margin-top:0">📥 Receive Bulk Fuel Delivery</h2>
                <p class="muted" style="margin-top:0">Target Tank: <b>${esc(tankName)}</b></p>
                <form id="form_refill" style="display:flex;flex-direction:column;gap:12px">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                    <div>
                      <label style="font-size:12px;font-weight:600">Delivered Volume (Litres) *</label>
                      <input type="number" step="0.1" id="refill_litres" required class="input" placeholder="e.g. 5000" style="width:100%">
                    </div>
                    <div>
                      <label style="font-size:12px;font-weight:600">Fuel Type</label>
                      <select id="refill_type" class="input" style="width:100%">
                        <option value="AUTO_DIESEL">Auto Diesel</option>
                        <option value="SUPER_DIESEL">Super Diesel</option>
                        <option value="PETROL_92">Petrol 92</option>
                      </select>
                    </div>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                    <div>
                      <label style="font-size:12px;font-weight:600">Supplier Name</label>
                      <input type="text" id="refill_supplier" class="input" value="Ceylon Petroleum Corporation" style="width:100%">
                    </div>
                    <div>
                      <label style="font-size:12px;font-weight:600">Invoice / Bowzer Ticket #</label>
                      <input type="text" id="refill_invoice" class="input" placeholder="e.g. CP-88772" style="width:100%">
                    </div>
                  </div>
                  <div>
                    <label style="font-size:12px;font-weight:600">Delivery Date</label>
                    <input type="date" id="refill_date" class="input" style="width:100%">
                  </div>
                  ${canSeeCost ? `
                  <div>
                    <label style="font-size:12px;font-weight:600">Total Cost (LKR, optional)</label>
                    <input type="number" step="0.01" min="0" id="refill_cost" class="input" placeholder="Leave blank to auto-price via Ceypetco tariff" style="width:100%">
                  </div>` : ''}
                  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
                    <button type="button" class="btn" id="btn_cancel_refill">Cancel</button>
                    <button type="submit" class="btn primary">Accept Delivery</button>
                  </div>
                </form>
              </div>
            `;
            document.body.appendChild(modal);
            modal.querySelector('#refill_date').value = new Date().toISOString().slice(0, 10);
            modal.querySelector('#btn_cancel_refill').onclick = () => modal.remove();
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

            modal.querySelector('#form_refill').onsubmit = async (e) => {
              e.preventDefault();
              const litres = Number(modal.querySelector('#refill_litres').value);
              const fuelType = modal.querySelector('#refill_type').value;
              const supplier = modal.querySelector('#refill_supplier').value.trim();
              const invoiceNumber = modal.querySelector('#refill_invoice').value.trim();
              const deliveryDate = modal.querySelector('#refill_date').value;
              const costInp = modal.querySelector('#refill_cost');
              const costRs = costInp ? Number(costInp.value || 0) : 0;
              const costCents = costRs > 0 ? Math.round(costRs * 100) : 0;

              try {
                const res = await api(`/fuel/tanks/${tankId}/refill`, {
                  method: 'POST',
                  body: { litres, fuelType, supplier, invoiceNumber, costCents, deliveryDate }
                });
                const balMsg = res.hide_stock || res.new_balance == null ? '' : `. New balance: ${Number(res.new_balance).toLocaleString()} L`;
                toast(`Added ${res.litres} L to ${tankName}${balMsg}`);
                modal.remove();
                loadTanks();
              } catch (err) {
                if (typeof toast === 'function') toast('Error recording refill: ' + err.message, 'err');
              }
            };
          };
        });

      } catch (err) {
        container.innerHTML = `<div class="card" style="padding:24px;text-align:center" class="err">Error loading tanks: ${esc(err.message)}</div>`;
      }
    }

    loadTanks();
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel-tanks'] = renderFuelTanks;
  }
})();
