'use strict';

/**
 * Native WorkshopOne Fuel Prices & Ceypetco Tracker Module
 *
 * Mounts at window.routes['fuel-prices']
 * Manages Ceypetco official fuel price revisions, effective dates, and retail pricing
 */

(function () {
  async function renderFuelPrices(content) {
    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / <a href="#/fuel">Fuel</a> / Price Management</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Ceypetco Fuel Prices &amp; Tariff History</h1>
          <p class="muted" style="margin:4px 0 0 0">Official date-effective per-litre price points for Auto Diesel, Super Diesel, and Petrol</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="btn_new_fuel_price">+ Update / Set Price</button>
          <button class="btn" id="btn_reload_prices">🔄 Refresh</button>
        </div>
      </div>

      <div class="card" style="padding:0;overflow-x:auto">
        <table class="table" style="width:100%;margin:0;font-size:13px">
          <thead>
            <tr style="background:rgba(255,255,255,0.02)">
              <th>Effective Date</th>
              <th>Fuel Type</th>
              <th style="text-align:right">Price / Litre (LKR)</th>
              <th>Entered By</th>
              <th>Notes / Revision Ref</th>
            </tr>
          </thead>
          <tbody id="fuel_prices_tbody">
            <tr><td colspan="5" style="text-align:center;padding:20px" class="muted">Loading prices...</td></tr>
          </tbody>
        </table>
      </div>
    `;

    async function loadPrices() {
      const tbody = qs('#fuel_prices_tbody');
      try {
        const res = await api('/fuel/prices');
        const list = res.prices || [];
        if (list.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px" class="muted">No price points configured yet.</td></tr>';
          return;
        }

        tbody.innerHTML = list.map(p => `
          <tr>
            <td><b>${esc(p.effective_date || '-')}</b></td>
            <td><span class="badge blue">${esc(p.fuel_type || 'AUTO_DIESEL')}</span></td>
            <td style="text-align:right;font-size:14px;font-weight:700;color:var(--primary,#0066ff)">
              ${money(p.price_per_litre_cents ? p.price_per_litre_cents / 100 : (p.price_per_litre || 0))}
            </td>
            <td>${esc(p.creator_name || '-')}</td>
            <td class="muted">${esc(p.notes || '-')}</td>
          </tr>
        `).join('');
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red,#ef4444);padding:20px">Error loading prices: ${esc(err.message)}</td></tr>`;
      }
    }

    qs('#btn_reload_prices').onclick = loadPrices;

    qs('#btn_new_fuel_price').onclick = () => {
      const modal = document.createElement('div');
      modal.className = 'modal-bg modal-backdrop';
      modal.innerHTML = `
        <div class="modal card" style="max-width:440px;padding:24px">
          <h2 style="margin:0 0 16px 0;font-size:18px">Set / Update Fuel Price Point</h2>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label class="label">Fuel Product:</label>
              <select id="fp_type" class="input">
                <option value="AUTO_DIESEL">Auto Diesel (Lanka Auto Diesel)</option>
                <option value="SUPER_DIESEL">Super Diesel (Lanka Super Diesel 4 Star)</option>
                <option value="PETROL_92">Petrol 92 Octane</option>
                <option value="PETROL_95">Petrol 95 Octane</option>
                <option value="KEROSENE">Industrial Kerosene</option>
              </select>
            </div>
            <div>
              <label class="label">Effective Date:</label>
              <input type="date" id="fp_date" class="input" value="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div>
              <label class="label">Retail Price per Litre (LKR):</label>
              <input type="number" id="fp_price" class="input" placeholder="e.g. 385.00" step="0.5">
            </div>
            <div>
              <label class="label">Notes / Ministry Gazette Ref:</label>
              <input type="text" id="fp_notes" class="input" placeholder="e.g. Ceypetco monthly price revision">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
              <button class="btn" id="btn_fp_cancel">Cancel</button>
              <button class="btn primary" id="btn_fp_save">Save Price</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#btn_fp_cancel').onclick = () => modal.remove();
      modal.querySelector('#btn_fp_save').onclick = async () => {
        const fuelType = modal.querySelector('#fp_type').value;
        const effectiveDate = modal.querySelector('#fp_date').value;
        const price = parseFloat(modal.querySelector('#fp_price').value);
        const notes = modal.querySelector('#fp_notes').value;

        if (isNaN(price) || price <= 0) {
          alert('Please enter a valid price per litre.');
          return;
        }

        try {
          await api('/fuel/prices', {
            method: 'POST',
            body: { fuelType, pricePerLitreCents: Math.round(price * 100), effectiveDate, notes }
          });
          modal.remove();
          loadPrices();
        } catch (e) {
          alert('Failed to update price: ' + e.message);
        }
      };
    };

    loadPrices();
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel-prices'] = renderFuelPrices;
  }
})();
