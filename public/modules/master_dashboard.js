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
  function openCutoverParityModal(content) {
    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:780px;width:94vw;padding:22px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <h2 style="margin:0;font-size:19px;font-weight:800">🔍 Legacy :1929 → :1949 Cutover Parity Check</h2>
            <div class="muted" style="font-size:12px">Read-only record comparison across core.db, CW.db &amp; MTR.db</div>
          </div>
          <button type="button" class="btn sm" id="btn_cutover_close_x">✕</button>
        </div>
        <div id="cutover_modal_body" style="min-height:140px">
          <div class="muted" style="padding:20px 0">Scanning :1929 vs :1949 tables (strict read-only)...</div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    modal.querySelector('#btn_cutover_close_x').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    (async () => {
      const bodyEl = modal.querySelector('#cutover_modal_body');
      try {
        const report = await api('/master-dashboard/cutover-status');
        const rows = [...(report.tables || [])].sort((a, b) => {
          if (a.missingRealCount !== b.missingRealCount) return b.missingRealCount - a.missingRealCount;
          return `${a.source}:${a.table}`.localeCompare(`${b.source}:${b.table}`);
        });

        const banner = report.readyForCutover
          ? `<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-left:4px solid #10b981;color:#065f46;padding:12px 14px;border-radius:8px;margin-bottom:14px">
               <b>✅ Ready for Cutover — 0 real production records missing from :1949.</b>
               ${Number(report.syntheticTestIgnoredTotal || 0) > 0
                 ? `<div style="font-size:12px;margin-top:4px">${Number(report.syntheticTestIgnoredTotal).toLocaleString()} legacy synthetic test/junk row(s) in :1929 were safely ignored.</div>`
                 : ''}
             </div>`
          : `<div style="background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;color:#92400e;padding:12px 14px;border-radius:8px;margin-bottom:14px">
               <b>⚠️ ${Number(report.realMissingTotal || 0).toLocaleString()} real record(s) exist in :1929 not yet in :1949.</b>
               <div style="font-size:12px;margin-top:4px">Use Safe Delta Sync below to pull missing rows without overwriting :1949 pricing, closures, or allocations.</div>
             </div>`;

        bodyEl.innerHTML = `
          ${banner}
          <div style="max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
            <table class="table" style="width:100%;margin:0;font-size:12.5px">
              <thead style="position:sticky;top:0;background:var(--card,#fff)">
                <tr>
                  <th style="padding:8px 10px">Source</th>
                  <th style="padding:8px 10px">Table</th>
                  <th style="padding:8px 10px;text-align:right">:1929</th>
                  <th style="padding:8px 10px;text-align:right">:1949</th>
                  <th style="padding:8px 10px;text-align:right">Missing Real</th>
                  <th style="padding:8px 10px;text-align:center">Status</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length ? rows.map((t) => {
                  const isMissing = Number(t.missingRealCount || 0) > 0;
                  const stBadge = isMissing
                    ? '<span class="badge warn">MISSING_IN_1949</span>'
                    : '<span class="badge ok">SYNCED</span>';
                  return `
                    <tr>
                      <td style="padding:7px 10px">${esc(t.source)}</td>
                      <td style="padding:7px 10px;font-weight:600">${esc(t.table)}</td>
                      <td style="padding:7px 10px;text-align:right">${Number(t.sourceCount || 0).toLocaleString()}</td>
                      <td style="padding:7px 10px;text-align:right">${Number(t.mergedCount || 0).toLocaleString()}</td>
                      <td style="padding:7px 10px;text-align:right;font-weight:700;color:${isMissing ? '#b45309' : '#047857'}">${Number(t.missingRealCount || 0).toLocaleString()}</td>
                      <td style="padding:7px 10px;text-align:center">${stBadge}</td>
                    </tr>
                  `;
                }).join('') : '<tr><td colspan="6" style="padding:16px;text-align:center" class="muted">No legacy :1929 source tables detected on disk.</td></tr>'}
              </tbody>
            </table>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px">
            <div class="muted" style="font-size:11.5px">Safe Sync creates an automatic pre-sync backup snapshot and uses non-destructive <code>INSERT OR IGNORE</code>.</div>
            <div style="display:flex;gap:8px">
              <button type="button" class="btn" id="btn_cutover_close">Close</button>
              <button type="button" class="btn primary" id="btn_cutover_safe_sync">🔄 Run Safe Delta Sync (INSERT OR IGNORE)</button>
            </div>
          </div>
        `;

        modal.querySelector('#btn_cutover_close').onclick = closeModal;
        const safeSyncBtn = modal.querySelector('#btn_cutover_safe_sync');
        safeSyncBtn.onclick = async () => {
          safeSyncBtn.disabled = true;
          safeSyncBtn.textContent = '⏳ Backing up & syncing...';
          try {
            const res = await api('/master-dashboard/sync-live', { method: 'POST', body: {} });
            const st = res.stats || {};
            if (typeof toast === 'function') {
              const snapInfo = res.preSyncBackup ? ` · backup ${res.preSyncBackup}` : '';
              toast(
                `Safe sync complete: +${Number(st.rowsInserted || 0).toLocaleString()} inserted, ${Number(st.rowsSkippedExisting || 0).toLocaleString()} preserved, ${Number(st.syntheticRowsSkipped || 0).toLocaleString()} synthetic skipped${snapInfo}`
              );
            }
            closeModal();
            await renderMasterDashboard(content);
          } catch (err) {
            if (typeof toast === 'function') toast(err.message || 'Safe delta sync failed', 'err');
            safeSyncBtn.disabled = false;
            safeSyncBtn.textContent = '🔄 Run Safe Delta Sync (INSERT OR IGNORE)';
          }
        };
      } catch (err) {
        bodyEl.innerHTML = `
          <div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:12px;border-radius:8px">
            <b>Cutover check failed:</b> ${esc(err.message || 'Unable to inspect legacy databases')}
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:14px">
            <button type="button" class="btn" id="btn_cutover_err_close">Close</button>
          </div>
        `;
        const errClose = modal.querySelector('#btn_cutover_err_close');
        if (errClose) errClose.onclick = closeModal;
      }
    })();
  }

  async function renderMasterDashboard(content) {
    const isAdm = typeof isAdmin === 'function' && isAdmin();
    content.innerHTML = `
      <div class="crumb">Executive Overview / Master System</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px">Master Fleet & Workshop Cockpit</h1>
          <p class="muted" style="margin:4px 0 0 0">Unified live operations across Maintenance, Fuel Stocks, and Machine Hire</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${isAdm ? '<button class="btn" id="btn_md_cutover_check" title="Inspect :1929 vs :1949 parity and run non-destructive sync">🔍 Cutover Check (:1929)</button>' : ''}
          <a class="btn" href="#/access">🔐 Role &amp; User Permissions</a>
          <a class="btn primary" href="#/fuel">⛽ Fuel Operations</a>
          <a class="btn primary" href="#/hire-billing">📑 Machine Billing</a>
          <a class="btn" href="#/fleet-profitability">📊 Fleet P&amp;L</a>
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

      <!-- Data Completeness & Hygiene Health Panel -->
      <div class="card" style="padding:18px;margin-top:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div>
            <h3 style="margin:0;font-size:16px;font-weight:700">🧹 Data Completeness &amp; Hygiene</h3>
            <div class="muted" style="font-size:12px">Exceptions &amp; stale master records requiring stores, fleet, or fuel admin action</div>
          </div>
          <a class="btn sm primary" href="/api/master-dashboard/data-hygiene.xlsx" style="text-decoration:none">📥 Export Hygiene Worklist (.xlsx)</a>
        </div>
        <div id="md_health_grid" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));gap:10px">
          <div class="muted" style="font-size:13px">Checking data health...</div>
        </div>
        <div id="md_backup_bar" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:none"></div>
      </div>
    `;

    const cutoverBtn = qs('#btn_md_cutover_check');
    if (cutoverBtn) {
      cutoverBtn.onclick = () => openCutoverParityModal(content);
    }

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

      // Render Data Completeness & Hygiene indicators
      const healthEl = qs('#md_health_grid');
      if (healthEl && data.dataHealth) {
        const h = data.dataHealth;
        const staleDays = h.staleFuelTariffDays != null ? h.staleFuelTariffDays : null;
        const tiles = [
          {
            label: 'Unpriced Store Issues',
            value: Number(h.unpricedStoreIssues || 0).toLocaleString(),
            sub: Number(h.unpricedStoreIssues || 0) > 0 ? 'Missing MIN/GRN unit price' : 'All issues priced',
            warn: Number(h.unpricedStoreIssues || 0) > 0,
            href: '#/stores?tab=grn',
          },
          {
            label: 'Overdue Open MRNs (>30d)',
            value: Number(h.overdueOpenMrns || 0).toLocaleString(),
            sub: Number(h.overdueOpenMrns || 0) > 0 ? 'Close or fulfill aging requests' : 'No aging open MRNs',
            warn: Number(h.overdueOpenMrns || 0) > 0,
            href: '#/stores?tab=mrn',
          },
          {
            label: 'Unresolved Asset Aliases',
            value: Number(h.unresolvedAssetAliases || 0).toLocaleString(),
            sub: Number(h.unresolvedAssetAliases || 0) > 0 ? 'Link messy vehicle refs to fleet' : 'All aliases linked',
            warn: Number(h.unresolvedAssetAliases || 0) > 0,
            href: '#/aliases',
          },
          {
            label: 'Fuel Tariff Age',
            value: staleDays != null ? `${staleDays}d` : 'None',
            sub: h.latestFuelTariffDate ? `Latest tariff: ${esc(h.latestFuelTariffDate)}` : 'No fuel tariffs configured',
            warn: staleDays == null || staleDays > 30,
            href: '#/fuel-prices',
          },
          {
            label: 'Missing Vehicle Docs',
            value: Number(h.missingVehicleDocVersions || 0).toLocaleString(),
            sub: Number(h.missingVehicleDocVersions || 0) > 0 ? 'Required statutory slots empty' : 'Statutory slots covered',
            warn: Number(h.missingVehicleDocVersions || 0) > 0,
            href: '#/vehicledocuments',
          },
        ];
        healthEl.innerHTML = tiles.map((t) => {
          const border = t.warn ? '1px solid #fde68a;border-left:4px solid #f59e0b;background:rgba(245,158,11,0.04)' : '1px solid #bbf7d0;border-left:4px solid #10b981;background:rgba(16,185,129,0.04)';
          const numColor = t.warn ? '#b45309' : '#047857';
          return `
            <a href="${t.href}" class="card" style="padding:12px 14px;text-decoration:none;color:inherit;${border}">
              <div class="muted" style="font-size:11.5px;font-weight:600">${t.label}</div>
              <div style="font-size:22px;font-weight:800;margin:4px 0;color:${numColor}">${t.value}</div>
              <div class="muted" style="font-size:11px">${t.sub}</div>
            </a>
          `;
        }).join('');
      }

      // Admin Backup Hygiene Bar
      const backupEl = qs('#md_backup_bar');
      if (backupEl && typeof isAdmin === 'function' && isAdmin()) {
        const renderBackupsBar = async () => {
          try {
            const b = await api('/master-dashboard/backups');
            backupEl.style.display = 'flex';
            backupEl.style.justifyContent = 'space-between';
            backupEl.style.alignItems = 'center';
            backupEl.style.flexWrap = 'wrap';
            backupEl.style.gap = '10px';
            backupEl.innerHTML = `
              <div style="font-size:12.5px">
                <b>💾 Database Backups:</b>
                <b>${Number(b.autoCount || 0)}</b> automatic + <b>${Number(b.manualCount || 0)}</b> manual
                <span class="muted">(${Number(b.totalMB || 0).toLocaleString()} MB total · policy keep ${Number(b.retention || 10)} auto snapshots${b.sidecarCount ? ` · ${b.sidecarCount} sidecar(s)` : ''})</span>
              </div>
              <button type="button" class="btn sm" id="btn_md_prune_backups">🧹 Prune Old Snapshots</button>
            `;
            const pruneBtn = qs('#btn_md_prune_backups');
            if (pruneBtn) {
              pruneBtn.onclick = async () => {
                pruneBtn.disabled = true;
                const orig = pruneBtn.textContent;
                pruneBtn.textContent = 'Pruning...';
                try {
                  const res = await api('/master-dashboard/backups/prune', { method: 'POST', body: {} });
                  if (typeof toast === 'function') {
                    toast(`Pruned ${res.snapshotsDeleted || 0} old snapshot(s) and ${res.sidecarsRemoved || 0} sidecar(s) · freed ${res.freedMB || 0} MB`);
                  }
                  await renderBackupsBar();
                } catch (err) {
                  if (typeof toast === 'function') toast(err.message || 'Backup prune failed', 'err');
                  pruneBtn.disabled = false;
                  pruneBtn.textContent = orig;
                }
              };
            }
          } catch (_) {}
        };
        await renderBackupsBar();
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
