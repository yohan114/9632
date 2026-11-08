'use strict';

/**
 * Native WorkshopOne Consolidated Master Dashboard Module (Plan V2)
 *
 * Provides:
 * - Real-time unified executive dashboard spanning Maintenance, Fuel, Hire, and Stores
 * - Cross-system KPIs: Revenue, Fuel Litres, Maintenance Expense, Net Contribution
 * - Low-stock bulk storage tank alerts and quick-action triggers
 */

(function () {
  async function renderMasterDashboard(content) {
    content.innerHTML = `
      <div class="crumb">Executive Overview / Master System</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px">Master Fleet & Workshop Cockpit</h1>
          <p class="muted" style="margin:4px 0 0 0">Unified live operations across Maintenance, Fuel Stocks, and Machine Hire</p>
        </div>
        <div style="display:flex;gap:8px">
          <a class="btn primary" href="#/fuel">⛽ Fuel Operations</a>
          <a class="btn primary" href="#/hire-billing">📑 Machine Billing</a>
          <a class="btn" href="#/fleet-profitability">📊 Fleet P&L</a>
        </div>
      </div>

      <!-- Quick Alert Banners -->
      <div id="md_alerts_area"></div>

      <!-- Main Operational KPIs -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:14px;margin-bottom:20px">
        <div class="card" style="padding:16px;border-left:4px solid var(--primary,#0066ff)">
          <div class="muted" style="font-size:12px;font-weight:600">ACTIVE FLEET ASSETS</div>
          <div style="font-size:26px;font-weight:800;margin-top:6px" id="md_fleet_count">...</div>
          <div class="muted" style="font-size:11.5px" id="md_open_jobs">... Active Job Cards</div>
        </div>
        <div class="card" style="padding:16px;border-left:4px solid #10b981">
          <div class="muted" style="font-size:12px;font-weight:600">TODAY'S FUEL DISPENSED</div>
          <div style="font-size:26px;font-weight:800;margin-top:6px;color:#10b981" id="md_today_fuel">... L</div>
          <div class="muted" style="font-size:11.5px" id="md_today_cost">Rs ...</div>
        </div>
        <div class="card" style="padding:16px;border-left:4px solid #f59e0b">
          <div class="muted" style="font-size:12px;font-weight:600">MONTHLY FUEL RECHARGE</div>
          <div style="font-size:26px;font-weight:800;margin-top:6px;color:#f59e0b" id="md_month_fuel">... L</div>
          <div class="muted" style="font-size:11.5px" id="md_month_cost">Rs ...</div>
        </div>
        <div class="card" style="padding:16px;border-left:4px solid #8b5cf6">
          <div class="muted" style="font-size:12px;font-weight:600">FINALIZED HIRE REVENUE</div>
          <div style="font-size:26px;font-weight:800;margin-top:6px;color:#8b5cf6" id="md_hire_revenue">Rs ...</div>
          <div class="muted" style="font-size:11.5px" id="md_bills_count">Across ... bills</div>
        </div>
      </div>

      <!-- Two-Column Operational Panels -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;flex-wrap:wrap">
        <!-- Panel 1: Fuel Tank Levels & Low Stock Warnings -->
        <div class="card" style="padding:18px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <h3 style="margin:0;font-size:16px;font-weight:700">🛢️ Storage Tank Stock Cockpit</h3>
            <a href="#/fuel-tanks" class="btn sm">View All Tanks</a>
          </div>
          <div id="md_tank_list" style="display:flex;flex-direction:column;gap:12px">
            <div class="muted" style="font-size:13px">Loading bulk tanks...</div>
          </div>
        </div>

        <!-- Panel 2: Quick Links & Fast Actions -->
        <div class="card" style="padding:18px">
          <h3 style="margin:0 0 14px 0;font-size:16px;font-weight:700">⚡ Master Workflow Actions</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <a href="#/fuel" class="card" style="padding:14px;text-decoration:none;color:inherit;background:rgba(0,102,255,0.03);border:1px solid rgba(0,102,255,0.15)">
              <div style="font-size:20px;margin-bottom:4px">⛽</div>
              <div style="font-weight:700;font-size:14px">Issue Vehicle Fuel</div>
              <div class="muted" style="font-size:11px">Dispense fuel & record meters</div>
            </a>
            <a href="#/fuel-tanks" class="card" style="padding:14px;text-decoration:none;color:inherit;background:rgba(16,185,129,0.03);border:1px solid rgba(16,185,129,0.15)">
              <div style="font-size:20px;margin-bottom:4px">📏</div>
              <div style="font-weight:700;font-size:14px">Record Tank Dip</div>
              <div class="muted" style="font-size:11px">Verify physical vs pump balance</div>
            </a>
            <a href="#/hire-billing" class="card" style="padding:14px;text-decoration:none;color:inherit;background:rgba(139,92,246,0.03);border:1px solid rgba(139,92,246,0.15)">
              <div style="font-size:20px;margin-bottom:4px">📑</div>
              <div style="font-weight:700;font-size:14px">Generate Hire Bills</div>
              <div class="muted" style="font-size:11px">SSCL 2.5% + VAT 18% calculation</div>
            </a>
            <a href="#/fleet-profitability" class="card" style="padding:14px;text-decoration:none;color:inherit;background:rgba(245,158,11,0.03);border:1px solid rgba(245,158,11,0.15)">
              <div style="font-size:20px;margin-bottom:4px">📊</div>
              <div style="font-weight:700;font-size:14px">Vehicle P&L Margins</div>
              <div class="muted" style="font-size:11px">Operating contribution by machine</div>
            </a>
          </div>
        </div>
      </div>
    `;

    try {
      const data = await api('/master-dashboard/summary');
      qs('#md_fleet_count').textContent = `${data.fleet.active} / ${data.fleet.total}`;
      qs('#md_open_jobs').textContent = `${data.fleet.openJobCards} Open Job Cards`;

      qs('#md_today_fuel').textContent = `${Number(data.fuel.todayLitres).toFixed(1)} L`;
      qs('#md_today_cost').textContent = `Rs ${(Number(data.fuel.todayCostCents) / 100).toLocaleString()}`;

      qs('#md_month_fuel').textContent = `${Number(data.fuel.monthLitres).toLocaleString()} L`;
      qs('#md_month_cost').textContent = `Rs ${(Number(data.fuel.monthCostCents) / 100).toLocaleString()}`;

      qs('#md_hire_revenue').textContent = `Rs ${(Number(data.billing.rentalRevenueCents) / 100).toLocaleString()}`;
      qs('#md_bills_count').textContent = `${data.billing.finalBillsCount} Finalized Invoices`;

      // Low tank alerts
      const alertsEl = qs('#md_alerts_area');
      if (data.fuel.lowStockTanks && data.fuel.lowStockTanks.length) {
        alertsEl.innerHTML = `
          <div style="background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #ef4444;color:#991b1b;padding:12px 16px;border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
            <div>
              <b>⚠️ LOW FUEL WARNING:</b> ${data.fuel.lowStockTanks.length} bulk storage tanks are below 20% capacity!
              (${data.fuel.lowStockTanks.map(t => `${t.name}: ${t.pct_full}%`).join(', ')})
            </div>
            <a href="#/fuel-tanks" class="btn sm danger" style="white-space:nowrap">Refill Now</a>
          </div>
        `;
      }

      // Render top 5 storage tanks
      const tanksEl = qs('#md_tank_list');
      const { tanks } = await api('/fuel/tanks');
      if (tanks && tanks.length) {
        tanksEl.innerHTML = tanks.slice(0, 5).map(t => {
          const cap = Number(t.capacity_litres) || 1;
          const curr = Number(t.current_litres) || 0;
          const pct = Math.min(100, Math.round((curr / cap) * 100));
          const barColor = pct < 20 ? '#ef4444' : (pct > 75 ? '#10b981' : '#3b82f6');
          return `
            <div>
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
                <span><b>${esc(t.name)}</b> <span class="muted">(${esc(t.tank_type)})</span></span>
                <span style="font-weight:700">${curr.toLocaleString()} / ${cap.toLocaleString()} L (${pct}%)</span>
              </div>
              <div style="width:100%;height:8px;background:rgba(0,0,0,0.06);border-radius:4px;overflow:hidden">
                <div style="width:${pct}%;height:100%;background:${barColor}"></div>
              </div>
            </div>
          `;
        }).join('');
      } else {
        tanksEl.innerHTML = '<div class="muted">No storage tanks configured.</div>';
      }

    } catch (err) {
      console.warn('Error loading master dashboard summary:', err);
    }
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['master-dashboard'] = renderMasterDashboard;
  }
})();
