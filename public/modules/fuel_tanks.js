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
    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / <a href="#/fuel">Fuel</a> / Bulk Tanks</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Storage Tanks & Mobile Bowsers</h1>
          <p class="muted" style="margin:4px 0 0 0">Bulk diesel inventory, dipstick audits, and site Bowser deployments</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="btn_new_tank">+ New Tank / Bowser</button>
        </div>
      </div>

      <div class="tank-grid" id="tanks_container" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:16px">
        <div class="card" style="padding:24px;text-align:center" class="muted">Loading storage tanks...</div>
      </div>
    `;

    async function loadTanks() {
      const container = qs('#tanks_container');
      try {
        const { tanks } = await api('/fuel/tanks');
        if (!tanks || !tanks.length) {
          container.innerHTML = '<div class="card" style="padding:24px;text-align:center" class="muted">No storage tanks configured.</div>';
          return;
        }

        container.innerHTML = tanks.map((t) => {
          const cap = Number(t.capacity_litres) || 1;
          const curr = Number(t.current_litres) || 0;
          const pct = Math.min(100, Math.round((curr / cap) * 100));
          const isLow = pct < 20;
          const barColor = isLow ? '#ef4444' : (pct > 75 ? '#10b981' : '#3b82f6');

          return `
            <div class="card" style="padding:18px;display:flex;flex-direction:column;justify-content:space-between">
              <div>
                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                  <div>
                    <h3 style="margin:0 0 4px 0;font-size:16px">${esc(t.name)}</h3>
                    <span class="badge ${t.tank_type === 'BOWSER' ? 'info' : 'secondary'}">${esc(t.tank_type)}</span>
                    ${t.project_name ? `<span class="muted" style="font-size:11px;margin-left:6px">📍 ${esc(t.project_name)}</span>` : ''}
                  </div>
                  <span style="font-size:18px">${t.tank_type === 'BOWSER' ? '🚛' : '🛢️'}</span>
                </div>

                <div style="margin:16px 0">
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
                </div>
              </div>

              <div style="display:flex;gap:8px;border-top:1px solid var(--border);padding-top:12px;margin-top:8px">
                <button class="btn sm primary btn-dip" data-id="${esc(t.id)}" data-name="${esc(t.name)}" style="flex:1">📏 Record Dip</button>
                <button class="btn sm btn-refill" data-id="${esc(t.id)}" data-name="${esc(t.name)}" style="flex:1">📥 Refill Stock</button>
              </div>
            </div>
          `;
        }).join('');

        // Wire Dip buttons
        qsa('.btn-dip', container).forEach((btn) => {
          btn.onclick = () => {
            const tankId = btn.getAttribute('data-id');
            const tankName = btn.getAttribute('data-name');

            const modal = document.createElement('div');
            modal.className = 'modal-backdrop';
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
                alert('Error recording dip: ' + err.message);
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
            modal.className = 'modal-backdrop';
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

              try {
                const res = await api(`/fuel/tanks/${tankId}/refill`, {
                  method: 'POST',
                  body: { litres, fuelType, supplier, invoiceNumber, deliveryDate }
                });
                toast(`Added ${res.litres} L to ${tankName}. New balance: ${res.new_balance.toLocaleString()} L`);
                modal.remove();
                loadTanks();
              } catch (err) {
                alert('Error recording refill: ' + err.message);
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
