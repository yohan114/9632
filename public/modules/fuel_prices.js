'use strict';

/**
 * Native WorkshopOne Fuel Prices & Ceypetco Tracker Module
 *
 * Mounts at window.routes['fuel-prices']
 * Manages Ceypetco official fuel price revisions, effective dates, and retail pricing
 */

(function () {
  const FUEL_TYPES = [
    { key: 'AUTO_DIESEL', label: 'Auto Diesel' },
    { key: 'SUPER_DIESEL', label: 'Super Diesel' },
    { key: 'PETROL_92', label: 'Petrol 92' },
    { key: 'PETROL_95', label: 'Petrol 95' },
    { key: 'KEROSENE', label: 'Kerosene' },
  ];

  function localTodayStr() {
    if (typeof slToday === 'function') return slToday();
    return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  async function renderFuelPrices(content) {
    let latestActivePrices = {};
    const canManage = (typeof isAdmin === 'function' && isAdmin()) || (typeof canDo === 'function' && canDo('fuel.prices.manage'));

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / <a href="#/fuel">Fuel</a> / Price Management</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Ceypetco Fuel Prices &amp; Tariff History</h1>
          <p class="muted" style="margin:4px 0 0 0">Official date-effective per-litre price points for Auto Diesel, Super Diesel, Petrol &amp; Kerosene</p>
          <div class="muted" id="fp_sync_status" style="font-size:12px;margin-top:4px"></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${canManage ? '<button class="btn" id="btn_sync_ceypetco_prices">🌐 Sync from Ceypetco</button>' : ''}
          ${canManage ? '<button class="btn" id="btn_reprice_slips">⚡ Re-Price Slips</button>' : ''}
          ${canManage ? '<button class="btn primary" id="btn_new_fuel_price">+ Update / Set Price</button>' : ''}
          <button class="btn" id="btn_reload_prices">🔄 Refresh</button>
        </div>
      </div>

      <div id="fp_active_cards" class="kpi-grid" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(175px, 1fr));gap:10px;margin-bottom:16px"></div>

      <div class="card" style="padding:0;overflow-x:auto">
        <table class="table" style="width:100%;margin:0;font-size:13px">
          <thead>
            <tr style="background:rgba(255,255,255,0.02)">
              <th>Effective Date</th>
              <th>Fuel Type</th>
              <th style="text-align:right">Price / Litre (LKR)</th>
              <th>Entered By</th>
              <th>Notes / Revision Ref</th>
              <th style="text-align:center">Action</th>
            </tr>
          </thead>
          <tbody id="fuel_prices_tbody">
            <tr><td colspan="6" style="text-align:center;padding:20px" class="muted">Loading prices...</td></tr>
          </tbody>
        </table>
      </div>
    `;

    function openPriceModal(defaults = {}) {
      const defType = defaults.fuelType || 'AUTO_DIESEL';
      const activeEntry = latestActivePrices[defType];
      const defPriceRs = defaults.pricePerLitre != null
        ? Number(defaults.pricePerLitre).toFixed(2)
        : (activeEntry && activeEntry.pricePerLitreCents ? (activeEntry.pricePerLitreCents / 100).toFixed(2) : '');

      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal card" style="max-width:450px;padding:24px">
          <h2 style="margin:0 0 6px 0;font-size:18px">Set / Update Fuel Price Point</h2>
          <p class="muted" style="margin:0 0 14px 0;font-size:12px">New tariff applies to issues &amp; billing dated on/after the Effective Date.</p>
          <form id="form_fuel_price" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label class="label">Fuel Product:</label>
              <select id="fp_type" class="input" style="width:100%">
                <option value="AUTO_DIESEL" ${defType === 'AUTO_DIESEL' ? 'selected' : ''}>Auto Diesel (Lanka Auto Diesel)</option>
                <option value="SUPER_DIESEL" ${defType === 'SUPER_DIESEL' ? 'selected' : ''}>Super Diesel (Lanka Super Diesel 4 Star)</option>
                <option value="PETROL_92" ${defType === 'PETROL_92' ? 'selected' : ''}>Petrol 92 Octane</option>
                <option value="PETROL_95" ${defType === 'PETROL_95' ? 'selected' : ''}>Petrol 95 Octane</option>
                <option value="KEROSENE" ${defType === 'KEROSENE' ? 'selected' : ''}>Industrial Kerosene</option>
              </select>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label class="label">Effective Date:</label>
                <input type="date" id="fp_date" required class="input" value="${esc(defaults.effectiveDate || localTodayStr())}" style="width:100%">
              </div>
              <div>
                <label class="label">Retail Price / Litre (LKR):</label>
                <input type="number" id="fp_price" required class="input" placeholder="e.g. 385.00" step="0.01" min="0.01" value="${esc(defPriceRs)}" style="width:100%">
              </div>
            </div>
            <div>
              <label class="label">Notes / Ministry Gazette Ref:</label>
              <input type="text" id="fp_notes" class="input" placeholder="e.g. Ceypetco monthly price revision" value="${esc(defaults.notes || '')}" style="width:100%">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
              <button type="button" class="btn" id="btn_fp_cancel">Cancel</button>
              <button type="submit" class="btn primary" id="btn_fp_save">Save Price</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modal);

      const typeSel = modal.querySelector('#fp_type');
      const priceInp = modal.querySelector('#fp_price');
      typeSel.onchange = () => {
        const entry = latestActivePrices[typeSel.value];
        if (entry && entry.pricePerLitreCents) {
          priceInp.value = (entry.pricePerLitreCents / 100).toFixed(2);
        }
      };

      modal.querySelector('#btn_fp_cancel').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      modal.querySelector('#form_fuel_price').onsubmit = async (e) => {
        e.preventDefault();
        const fuelType = typeSel.value;
        const effectiveDate = modal.querySelector('#fp_date').value;
        const price = parseFloat(priceInp.value);
        const notes = modal.querySelector('#fp_notes').value.trim();

        if (isNaN(price) || price <= 0) {
          if (typeof toast === 'function') toast('Please enter a valid price per litre.', 'err');
          return;
        }

        const btn = modal.querySelector('#btn_fp_save');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        try {
          await api('/fuel/prices', {
            method: 'POST',
            body: { fuelType, pricePerLitreCents: Math.round(price * 100), effectiveDate, notes }
          });
          if (typeof toast === 'function') toast(`Updated ${fuelType} rate to Rs ${price.toFixed(2)} / L`);
          modal.remove();
          loadPrices();
        } catch (err) {
          if (typeof toast === 'function') toast('Failed to update price: ' + err.message, 'err');
          btn.disabled = false;
          btn.textContent = 'Save Price';
        }
      };
    }

    function renderActiveCards(activePrices) {
      const wrap = qs('#fp_active_cards');
      if (!wrap) return;
      wrap.innerHTML = FUEL_TYPES.map((ft) => {
        const info = (activePrices && activePrices[ft.key]) || null;
        const cents = info ? Number(info.pricePerLitreCents || 0) : 0;
        const eff = info && info.effectiveDate ? info.effectiveDate : 'Reference';
        return `
          <div class="card" style="padding:12px 14px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <div class="muted" style="font-size:11px;font-weight:700">${esc(ft.label.toUpperCase())}</div>
              ${canManage ? `<button type="button" class="btn sm btn-fp-card-upd" data-fuel="${esc(ft.key)}" style="padding:2px 7px;font-size:11px">Update</button>` : ''}
            </div>
            <div style="font-size:19px;font-weight:800;margin-top:4px;color:var(--primary,#0066ff)">
              ${cents > 0 ? `${money(cents / 100)} / L` : '—'}
            </div>
            <div class="muted" style="font-size:11px;margin-top:2px">Effective ${esc(eff)}</div>
          </div>
        `;
      }).join('');
      qsa('.btn-fp-card-upd', wrap).forEach((b) => {
        b.onclick = () => openPriceModal({ fuelType: b.getAttribute('data-fuel') });
      });
    }

    async function loadPrices() {
      const tbody = qs('#fuel_prices_tbody');
      try {
        const res = await api('/fuel/prices');
        latestActivePrices = res.activePrices || {};
        renderActiveCards(latestActivePrices);

        const syncEl = qs('#fp_sync_status');
        if (syncEl) {
          const sync = res.ceypetcoSync || null;
          if (!sync) {
            syncEl.textContent = '';
          } else if (sync.lastSyncStatus === 'error') {
            syncEl.innerHTML = `<span style="color:#d97706;font-weight:600">⚠ Ceypetco auto-sync error: ${esc(sync.lastSyncError || 'Unknown error')}</span>`;
          } else if (!sync.enabled) {
            syncEl.textContent = 'Ceypetco auto-sync is paused';
          } else if (sync.lastSyncAt) {
            const whenStr = new Date(sync.lastSyncAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
            const srcTag = sync.lastSyncSource ? ` · Source: ${sync.lastSyncSource}` : '';
            syncEl.textContent = `Auto-sync every ${sync.intervalMinutes || 30}m · Last checked ${whenStr}${srcTag}`;
          } else {
            syncEl.textContent = `Auto-sync every ${sync.intervalMinutes || 30}m · Pending first check`;
          }
        }

        const list = res.prices || [];
        if (list.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px" class="muted">No price points configured yet.</td></tr>';
          return;
        }

        tbody.innerHTML = list.map((p) => {
          const rs = p.price_per_litre_cents ? p.price_per_litre_cents / 100 : (p.price_per_litre || 0);
          const fKind = p.fuel_type || 'AUTO_DIESEL';
          return `
            <tr>
              <td><b>${esc(String(p.effective_date || '-').slice(0, 10))}</b></td>
              <td><span class="badge blue">${esc(fKind)}</span></td>
              <td style="text-align:right;font-size:14px;font-weight:700;color:var(--primary,#0066ff)">
                ${money(rs)}
              </td>
              <td>${esc(p.creator_name || '-')}</td>
              <td class="muted">${esc(p.notes || '-')}</td>
              <td style="text-align:center">
                ${canManage ? `<button type="button" class="btn sm btn-fp-row-upd" data-fuel="${esc(fKind)}" data-rs="${Number(rs || 0).toFixed(2)}">Update</button>` : '<span class="muted" style="font-size:11px">View only</span>'}
              </td>
            </tr>
          `;
        }).join('');

        qsa('.btn-fp-row-upd', tbody).forEach((b) => {
          b.onclick = () => openPriceModal({
            fuelType: b.getAttribute('data-fuel'),
            pricePerLitre: b.getAttribute('data-rs'),
          });
        });
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red,#ef4444);padding:20px">Error loading prices: ${esc(err.message)}</td></tr>`;
      }
    }

    qs('#btn_reload_prices').onclick = loadPrices;
    if (qs('#btn_new_fuel_price')) qs('#btn_new_fuel_price').onclick = () => openPriceModal();
    if (qs('#btn_sync_ceypetco_prices')) {
      qs('#btn_sync_ceypetco_prices').onclick = async () => {
        const btn = qs('#btn_sync_ceypetco_prices');
        if (!btn) return;
        btn.disabled = true;
        const origLabel = btn.textContent;
        btn.textContent = 'Syncing...';
        try {
          const res = await api('/fuel/prices/sync', { method: 'POST', body: {} });
          const updCount = (res.stored ? res.stored.length : 0) + (res.updated ? res.updated.length : 0);
          if (typeof toast === 'function') {
            toast(updCount > 0
              ? `Synced ${updCount} tariff change${updCount === 1 ? '' : 's'} from Ceypetco`
              : 'Ceypetco tariffs are already up to date');
          }
          await loadPrices();
        } catch (err) {
          if (typeof toast === 'function') toast('Ceypetco sync failed: ' + err.message, 'err');
          await loadPrices();
        } finally {
          btn.disabled = false;
          btn.textContent = origLabel;
        }
      };
    }

    function openRepriceModal() {
      const defFrom = (latestActivePrices.AUTO_DIESEL && latestActivePrices.AUTO_DIESEL.effectiveDate)
        || (localTodayStr().slice(0, 7) + '-01');
      const defTo = localTodayStr();

      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal card" style="max-width:680px;padding:24px">
          <h2 style="margin:0 0 6px 0;font-size:18px">⚡ Re-Price Historical Fuel Slips to Effective Tariff</h2>
          <p class="muted" style="margin:0 0 14px 0;font-size:12px">
            Aligns fuel issues in the selected date window with official Ceypetco tariffs on each slip's date and updates unlocked DRAFT rental bills. FINAL/PAID bills and locked periods are never touched.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
            <div>
              <label class="label">From Date *</label>
              <input type="date" id="rp_from" class="input" value="${esc(defFrom)}" style="width:100%">
            </div>
            <div>
              <label class="label">To Date *</label>
              <input type="date" id="rp_to" class="input" value="${esc(defTo)}" style="width:100%">
            </div>
            <div>
              <label class="label">Fuel Product</label>
              <select id="rp_fuel_type" class="input" style="width:100%">
                <option value="ALL">All Fuel Types</option>
                ${FUEL_TYPES.map((ft) => `<option value="${esc(ft.key)}">${esc(ft.label)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;font-size:12.5px">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" id="rp_include_manual"> Include manual override slips
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" id="rp_refresh_drafts" checked> Refresh unlocked DRAFT rental bills
            </label>
          </div>
          <div style="margin-bottom:12px">
            <label class="label">Audit Reason / Note</label>
            <input type="text" id="rp_reason" class="input" placeholder="e.g. Align Nov 2+ slips with official Ceypetco tariff revision" style="width:100%">
          </div>
          <div id="rp_preview_box" style="margin-bottom:14px"></div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn" id="btn_rp_cancel">Cancel</button>
            <button type="button" class="btn" id="btn_rp_preview">🔍 Preview Impact</button>
            <button type="button" class="btn primary" id="btn_rp_apply" disabled>⚡ Apply Re-Pricing</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const prevBox = modal.querySelector('#rp_preview_box');
      const applyBtn = modal.querySelector('#btn_rp_apply');
      const prevBtn = modal.querySelector('#btn_rp_preview');

      const invalidatePreview = () => {
        applyBtn.disabled = true;
      };
      ['#rp_from', '#rp_to', '#rp_fuel_type', '#rp_include_manual'].forEach((sel) => {
        const el = modal.querySelector(sel);
        if (el) el.addEventListener('change', invalidatePreview);
      });

      const getPayload = () => ({
        fromDate: modal.querySelector('#rp_from').value,
        toDate: modal.querySelector('#rp_to').value,
        fuelType: modal.querySelector('#rp_fuel_type').value,
        includeManual: modal.querySelector('#rp_include_manual').checked,
        refreshDraftBills: modal.querySelector('#rp_refresh_drafts').checked,
        reason: modal.querySelector('#rp_reason').value.trim() || null,
      });

      modal.querySelector('#btn_rp_cancel').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      prevBtn.onclick = async () => {
        const body = getPayload();
        if (!body.fromDate || !body.toDate) {
          if (typeof toast === 'function') toast('Please choose both From and To dates.', 'err');
          return;
        }
        prevBtn.disabled = true;
        prevBtn.textContent = 'Checking...';
        try {
          const p = await api('/fuel/prices/reprice-preview', { method: 'POST', body });
          const deltaSign = p.deltaCostCents >= 0 ? '+' : '-';
          const absDeltaRs = Math.abs(p.deltaCostCents || 0) / 100;
          const sampleRows = (p.sample || []).slice(0, 8).map((s) => `
            <tr>
              <td>${esc(s.slstDate)}</td>
              <td><b>${esc(s.assetCode || '-')}</b></td>
              <td>${esc(s.fuelType)}</td>
              <td style="text-align:right">${Number(s.litres || 0).toFixed(1)} L</td>
              <td style="text-align:right">Rs ${(s.oldPriceCents / 100).toFixed(2)} → <b>Rs ${(s.newPriceCents / 100).toFixed(2)}</b></td>
              <td style="text-align:right">${s.deltaCents >= 0 ? '+' : ''}${(s.deltaCents / 100).toFixed(2)}</td>
            </tr>
          `).join('');

          prevBox.innerHTML = `
            <div style="padding:12px;border-radius:8px;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.2)">
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:8px;font-size:12.5px">
                <div><div class="muted" style="font-size:11px">ELIGIBLE SLIPS</div><b>${p.eligibleCount}</b> (${Number(p.totalLitres || 0).toLocaleString()} L)</div>
                <div><div class="muted" style="font-size:11px">COST CHANGE</div><b>${deltaSign}Rs ${absDeltaRs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
                <div><div class="muted" style="font-size:11px">DRAFT BILLS AFFECTED</div><b>${p.impactedDraftBillsCount || 0}</b></div>
                <div><div class="muted" style="font-size:11px">SKIPPED (MANUAL / LOCKED)</div><b>${p.skippedManualCount || 0}</b> / <b>${p.skippedLockedCount || 0}</b></div>
              </div>
              ${p.impactedFinalBillsCount > 0 ? `<div class="muted" style="font-size:11.5px;margin-bottom:6px">Note: ${p.impactedFinalBillsCount} FINAL/PAID bill(s) exist in this range and will remain untouched.</div>` : ''}
              ${sampleRows ? `
                <div style="max-height:170px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;background:var(--card)">
                  <table class="table" style="width:100%;margin:0;font-size:11.5px">
                    <thead><tr><th>Date</th><th>Vehicle</th><th>Fuel</th><th style="text-align:right">Litres</th><th style="text-align:right">Tariff</th><th style="text-align:right">Delta (Rs)</th></tr></thead>
                    <tbody>${sampleRows}</tbody>
                  </table>
                </div>
              ` : '<div class="muted" style="font-size:12px">All non-manual slips in this range already match the effective tariff.</div>'}
            </div>
          `;
          applyBtn.disabled = !(p.eligibleCount > 0);
        } catch (err) {
          prevBox.innerHTML = `<div class="card err" style="padding:10px;font-size:12px">${esc(err.message)}</div>`;
          applyBtn.disabled = true;
        } finally {
          prevBtn.disabled = false;
          prevBtn.textContent = '🔍 Preview Impact';
        }
      };

      applyBtn.onclick = async () => {
        const body = getPayload();
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying...';
        try {
          const res = await api('/fuel/prices/reprice-apply', { method: 'POST', body });
          if (typeof toast === 'function') {
            toast(`Re-priced ${res.repricedCount || 0} fuel slip(s), refreshed ${res.draftBillsUpdated || 0} DRAFT bill(s).`);
          }
          modal.remove();
          await loadPrices();
        } catch (err) {
          if (typeof toast === 'function') toast('Re-pricing failed: ' + err.message, 'err');
          applyBtn.disabled = false;
          applyBtn.textContent = '⚡ Apply Re-Pricing';
        }
      };
    }

    if (qs('#btn_reprice_slips')) qs('#btn_reprice_slips').onclick = openRepriceModal;

    loadPrices();
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel-prices'] = renderFuelPrices;
  }
})();
