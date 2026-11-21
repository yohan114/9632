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
        </div>
        <div style="display:flex;gap:8px">
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

    loadPrices();
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel-prices'] = renderFuelPrices;
  }
})();
