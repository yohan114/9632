'use strict';

/**
 * Native WorkshopOne Fuel Alerts & Discrepancy Audits Module
 *
 * Mounts at window.routes['fuel-alerts']
 * Detects low tank stock, high variance physical dips, duplicate slips, and fuel anomalies
 */

(function () {
  async function renderFuelAlerts(content) {
    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / <a href="#/fuel">Fuel</a> / Alerts &amp; Audits</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:700">Fuel Alerts &amp; Discrepancy Audits</h1>
          <p class="muted" style="margin:4px 0 0 0">Real-time discrepancy detection: Low bulk tank stocks, dip variances, duplicate slips, and telemetry gaps</p>
        </div>
        <button class="btn primary sm" id="btn_reload_alerts">🔄 Scan &amp; Refresh</button>
      </div>

      <div id="alerts_container" style="display:flex;flex-direction:column;gap:12px">
        <div class="card" style="padding:24px;text-align:center" class="muted">Scanning system for alerts...</div>
      </div>
    `;

    async function loadAlerts() {
      const container = qs('#alerts_container');
      try {
        const res = await api('/fuel/alerts');
        const alerts = res.alerts || [];

        if (alerts.length === 0) {
          container.innerHTML = `
            <div class="card" style="padding:30px;text-align:center;border-left:4px solid #10b981">
              <div style="font-size:32px;margin-bottom:8px">✅</div>
              <h3 style="margin:0;font-size:16px;color:#10b981">Zero Integrity Alerts</h3>
              <p class="muted" style="margin:4px 0 0 0">All bulk storage tanks, dip measurements, and fuel dispensing logs pass validation.</p>
            </div>
          `;
          return;
        }

        container.innerHTML = alerts.map(a => {
          const borderCol = a.severity === 'HIGH' ? '#ef4444' : (a.severity === 'MEDIUM' ? '#f59e0b' : '#3b82f6');
          const badgeBg = a.severity === 'HIGH' ? 'rgba(239,68,68,0.1)' : (a.severity === 'MEDIUM' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)');
          const badgeCol = a.severity === 'HIGH' ? '#ef4444' : (a.severity === 'MEDIUM' ? '#f59e0b' : '#3b82f6');

          return `
            <div class="card" style="padding:16px;border-left:4px solid ${borderCol};display:flex;justify-content:space-between;align-items:flex-start;gap:14px">
              <div>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
                  <span class="badge" style="background:${badgeBg};color:${badgeCol};font-weight:700">${esc(a.severity)}</span>
                  <span class="muted" style="font-size:11px;font-weight:600">${esc(a.category)}</span>
                </div>
                <div style="font-size:15px;font-weight:700">${esc(a.title)}</div>
                <div class="muted" style="font-size:13px;margin-top:2px">${esc(a.message)}</div>
              </div>
              <div>
                ${a.tank_id ? `<a class="btn sm" href="#/fuel-tanks">Inspect Tank →</a>` : ''}
              </div>
            </div>
          `;
        }).join('');
      } catch (err) {
        container.innerHTML = `<div class="card" style="padding:20px;border-left:4px solid #ef4444">Error loading alerts: ${esc(err.message)}</div>`;
      }
    }

    qs('#btn_reload_alerts').onclick = loadAlerts;
    loadAlerts();
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['fuel-alerts'] = renderFuelAlerts;
  }
})();
