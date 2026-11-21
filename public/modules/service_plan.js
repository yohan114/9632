(function () {
  'use strict';

  /* Service & Filter Plan Module — 4-Stage Selective Lifecycle UI
   *   1. All-site fuel issues per canonical vehicle (Colombo +05:30 dates)
   *   2. Unified month breakdown history & downtime adjustments
   *   3. True service timing + "Service on Breakdown" bundling opportunities
   *   4. Per-filter lifecycle matrix: CHANGE (X), CLEAN (E), SKIP (OK)
   */

  function colomboMonthNow() {
    return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
  }

  function parseHashParams() {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    return new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : '');
  }

  const f1 = (v) => (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const f0 = (v) => (v == null || !Number.isFinite(Number(v))) ? '—' : Math.round(Number(v)).toLocaleString('en-US');

  const STATUS_META = {
    SERVICE_ON_BREAKDOWN: { label: 'Service on Breakdown', cls: 'amber', color: '#b45309', bg: 'rgba(217,119,6,0.12)' },
    OVERDUE: { label: 'Overdue', cls: 'red', color: '#dc2626', bg: 'rgba(220,38,38,0.1)' },
    DUE_SOON: { label: 'Due This Month', cls: 'amber', color: '#d97706', bg: 'rgba(217,119,6,0.08)' },
    ON_BREAKDOWN: { label: 'On Breakdown', cls: 'badge', color: '#4338ca', bg: 'rgba(67,56,202,0.08)' },
    OK: { label: 'OK', cls: 'green', color: '#15803d', bg: 'rgba(22,163,74,0.08)' },
    PARKED: { label: 'Parked', cls: 'badge', color: '#6b7280', bg: 'rgba(107,114,128,0.08)' },
    UNKNOWN: { label: 'No Usage', cls: 'badge', color: '#6b7280', bg: 'rgba(107,114,128,0.08)' },
  };

  function statusBadgeHtml(st) {
    const m = STATUS_META[st] || { label: st || 'Unknown', color: '#374151', bg: '#f3f4f6' };
    return `<span class="badge" style="color:${m.color};background:${m.bg};border:1px solid ${m.color}33;font-weight:700">${esc(m.label)}</span>`;
  }

  function decisionBadgeHtml(d) {
    if (d === 'CHANGE') {
      return '<span class="badge" style="background:rgba(220,38,38,0.12);color:#b91c1c;border:1px solid #fecaca;font-weight:700">CHANGE (X)</span>';
    }
    if (d === 'CLEAN') {
      return '<span class="badge" style="background:rgba(217,119,6,0.12);color:#b45309;border:1px solid #fde68a;font-weight:700">CLEAN (E)</span>';
    }
    return '<span class="badge" style="background:rgba(22,163,74,0.1);color:#15803d;border:1px solid #bbf7d0">SKIP (OK)</span>';
  }

  function buildVehicleRow(v, opts) {
    const f = v.fuel || {};
    const bd = v.breakdowns || {};
    const t = v.timing || {};
    const canManage = opts.canManage;

    const sites = f.sites_since || [];
    const multiSiteBadge = f.sites_count_since > 1
      ? `<span class="badge" title="${esc(sites.map((s) => `${s.site_name}: ${f1(s.litres)}L`).join(', '))}" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe">${f.sites_count_since} sites fuel</span>`
      : '';

    const bdDays = bd.breakdown_days_in_month || 0;
    const bdPill = bd.combine_on_breakdown
      ? '<div style="margin-top:2px"><span class="badge" style="background:#fef3c7;color:#b45309;border:1px solid #fcd34d;font-weight:700">COMBINE ON BD</span></div>'
      : (bd.is_currently_down
        ? '<div style="margin-top:2px"><span class="badge" style="background:#e0e7ff;color:#3730a3;border:1px solid #c7d2fe">OPEN BD</span></div>'
        : '');

    const pct = v.interval > 0 ? Math.min(140, Math.round(((t.used_since || 0) / v.interval) * 100)) : 0;
    const barColor = pct >= 100 ? '#dc2626' : (pct >= 80 ? '#d97706' : '#16a34a');

    const dueNote = t.remaining_units != null
      ? (t.remaining_units < 0
        ? `<b style="color:#dc2626">Over ${f1(-t.remaining_units)} ${esc(v.unit)}</b>`
        : `<span style="color:#0f766e">${f1(t.remaining_units)} ${esc(v.unit)} left</span>`)
      : '<span class="muted">No rate/usage</span>';

    const wantedChips = (v.wanted_filters || []).map((w) => `
      <span class="badge" style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;margin:2px 3px 2px 0;display:inline-block" title="${esc(w.reason || '')}">
        <b>${esc(w.category)}</b>${w.part_no ? ` · ${esc(w.part_no)}` : ''}${w.qty > 1 ? ` ×${w.qty}` : ''}
      </span>
    `).join('');

    const savedSummary = ((v.clean_filters || []).length || (v.skipped_filters || []).length)
      ? `<div class="muted" style="font-size:11px;margin-top:3px">+${(v.clean_filters || []).length} clean (E) · ${(v.skipped_filters || []).length} skipped</div>`
      : '';

    return `
      <tr>
        <td>
          <button type="button" class="link-btn sp-veh-btn" data-aid="${v.asset_id}" style="font-weight:800;font-size:14px;padding:0;background:none;border:none;color:var(--primary,#0066ff);cursor:pointer;text-decoration:underline">${esc(v.asset_code)}</button>
          <div class="muted" style="font-size:11px">${esc(v.asset_reg || v.asset_ec || '')}${v.category ? ` · ${esc(v.category)}` : ''}</div>
          <div style="margin-top:4px">${statusBadgeHtml(v.state)}</div>
        </td>
        <td>
          <div><b>${esc(v.site || 'Unassigned')}</b></div>
          <div style="margin-top:3px">${multiSiteBadge}</div>
        </td>
        <td>
          <div>${v.last_service ? `<b>${esc(v.last_service)}</b>` : '<span class="muted">No record</span>'}</div>
          <div class="muted" style="font-size:11px">${v.last_service_meter != null ? `@ ${f0(v.last_service_meter)} ${esc(v.unit)}` : ''}</div>
          <div style="font-size:11px;margin-top:2px">Next: <b>#${v.next_service_seq || 1}</b> (${f0(v.next_milestone_units)} ${esc(v.unit)})</div>
        </td>
        <td class="num">
          <div><b>${f1(f.litres_since_service || 0)} L</b></div>
          <div class="muted" style="font-size:11px">${f.issues_since_service || 0} iss · ${f.sites_count_since || 0} site(s)</div>
          <div class="muted" style="font-size:11px">Month: ${f1(f.month_litres || 0)} L</div>
        </td>
        <td>
          <div>${bdDays > 0 ? `<b style="color:#b91c1c">${bdDays} d</b> in month` : '<span class="muted">0 d in month</span>'}</div>
          <div class="muted" style="font-size:11px">${bd.count_in_month || 0} episode(s)</div>
          ${bdPill}
        </td>
        <td>
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px">
            <b>${f1(t.used_since || 0)} / ${f0(v.interval)} ${esc(v.unit)}</b>
            <span class="muted">${t.used_source || ''}</span>
          </div>
          <div style="height:6px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin:4px 0">
            <div style="width:${Math.min(100, pct)}%;height:100%;background:${barColor}"></div>
          </div>
          <div class="muted" style="font-size:11px">
            ${t.active_rate_per_day != null ? `${f1(t.active_rate_per_day)} ${esc(v.unit)}/active d` : (f.rate_status || 'Rate pending')}
            ${t.month_active_days != null ? ` · ${t.month_active_days}/${t.month_elapsed_days} active d` : ''}
          </div>
        </td>
        <td>
          <div><b>${esc(t.projected_due_date || '—')}</b></div>
          <div style="font-size:12px;margin-top:2px">${dueNote}</div>
        </td>
        <td>
          <div>${wantedChips || '<span class="muted">None to change</span>'}</div>
          ${savedSummary}
        </td>
        <td style="white-space:nowrap">
          <button type="button" class="sm sp-inspect-btn" data-aid="${v.asset_id}">Inspect</button>
          ${canManage ? ` <button type="button" class="sm primary sp-jr-btn" data-aid="${v.asset_id}">Create JR</button>` : ''}
        </td>
      </tr>
    `;
  }

  function openCategoryRulesModal(onSaved) {
    modal('Filter Category Default Cycles (1x / 2x / 4x)', '<div class="muted">Loading rules…</div>', async (body, close) => {
      try {
        const res = await api('/filters/service-plan/category-rules');
        const rules = res.rules || [];
        const canEditRules = canDo('service_plan.override_interval');

        const rowsHtml = rules.map((r, i) => `
          <tr data-idx="${i}">
            <td><b>${esc(r.category)}</b></td>
            <td>
              <select class="cr-every" style="width:110px" ${canEditRules ? '' : 'disabled'}>
                <option value="1" ${r.every_n_services === 1 ? 'selected' : ''}>Every 1x (All)</option>
                <option value="2" ${r.every_n_services === 2 ? 'selected' : ''}>Every 2x</option>
                <option value="3" ${r.every_n_services === 3 ? 'selected' : ''}>Every 3x</option>
                <option value="4" ${r.every_n_services === 4 ? 'selected' : ''}>Every 4x</option>
              </select>
            </td>
            <td>
              <select class="cr-between" style="width:130px" ${canEditRules ? '' : 'disabled'}>
                <option value="SKIP" ${r.between_action === 'SKIP' ? 'selected' : ''}>SKIP (Not needed)</option>
                <option value="E" ${r.between_action === 'E' ? 'selected' : ''}>CLEAN / INSPECT (E)</option>
              </select>
            </td>
            <td><input type="number" class="cr-hours" value="${r.default_hours ?? ''}" style="width:85px" ${canEditRules ? '' : 'disabled'}></td>
            <td><input type="number" class="cr-km" value="${r.default_km ?? ''}" style="width:95px" ${canEditRules ? '' : 'disabled'}></td>
            <td><input type="text" class="cr-notes" value="${esc(r.notes || '')}" style="width:220px" ${canEditRules ? '' : 'disabled'}></td>
          </tr>
        `).join('');

        body.innerHTML = `
          <p class="muted" style="margin-top:0">
            Fleet-wide defaults determine how often each filter type changes vs when it is cleaned or skipped on intermediate services.
          </p>
          <div class="table-wrap scroll" style="max-height:420px">
            <table>
              <thead>
                <tr>
                  <th>Filter Category</th><th>Cycle</th><th>Between Changes</th>
                  <th>Default Hours</th><th>Default KM</th><th>Notes</th>
                </tr>
              </thead>
              <tbody id="cr-tbody">${rowsHtml}</tbody>
            </table>
          </div>
          <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="sm" id="cr-close">Close</button>
            ${canEditRules ? '<button type="button" class="primary" id="cr-save">Save Category Rules</button>' : ''}
          </div>
        `;

        qs('#cr-close', body).onclick = close;
        const saveBtn = qs('#cr-save', body);
        if (saveBtn) {
          saveBtn.onclick = async () => {
            const payload = [];
            qsa('#cr-tbody tr', body).forEach((tr) => {
              const idx = Number(tr.dataset.idx);
              const orig = rules[idx];
              if (!orig) return;
              payload.push({
                category: orig.category,
                every_n_services: Number(qs('.cr-every', tr).value),
                between_action: qs('.cr-between', tr).value,
                default_hours: qs('.cr-hours', tr).value ? Number(qs('.cr-hours', tr).value) : null,
                default_km: qs('.cr-km', tr).value ? Number(qs('.cr-km', tr).value) : null,
                notes: qs('.cr-notes', tr).value.trim() || null,
              });
            });
            try {
              saveBtn.disabled = true;
              await api('/filters/service-plan/category-rules', { method: 'PUT', body: { rules: payload } });
              toast('Category lifecycle rules updated');
              close();
              if (onSaved) onSaved();
            } catch (e) {
              toast(e.message, 'err');
              saveBtn.disabled = false;
            }
          };
        }
      } catch (e) {
        body.innerHTML = `<p class="err">${esc(e.message)}</p>`;
      }
    }, { wide: true });
  }

  function openVehicleModal(assetIdOrCode, month, onRefresh) {
    modal(`Service & Filter Plan — ${assetIdOrCode}`, '<div class="muted">Loading vehicle trace…</div>', async (body, close) => {
      try {
        const detail = await api(`/filters/service-plan/vehicle/${encodeURIComponent(assetIdOrCode)}?month=${encodeURIComponent(month)}`);
        const v = detail.vehicle;
        if (!v) {
          body.innerHTML = '<p class="err">Vehicle trace unavailable.</p>';
          return;
        }
        const f = v.fuel || {};
        const bd = v.breakdowns || {};
        const t = v.timing || {};
        const canOverride = canDo('service_plan.override_interval');
        const canManage = canDo('service_plan.manage', 'jobrequests.create');

        const headerEl = qs('.modal h2 span', body.closest('.modal-bg'));
        if (headerEl) headerEl.textContent = `${v.asset_code}${v.asset_reg ? ` (${v.asset_reg})` : ''} — Service & Filter Trace (${detail.month})`;

        let curTab = 'fuel';

        const renderTabs = () => `
          <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:12px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
            <div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                ${statusBadgeHtml(v.state)}
                <span><b>Site:</b> ${esc(v.site || 'Unassigned')}</span>
                <span><b>Category:</b> ${esc(v.category || 'General')}</span>
                <span><b>Next Milestone:</b> #${v.next_service_seq || 1} (${f0(v.next_milestone_units)} ${esc(v.unit)})</span>
              </div>
              <div class="muted" style="font-size:12px;margin-top:4px">
                Last service: <b>${esc(v.last_service || 'None')}</b> @ ${v.last_service_meter != null ? f0(v.last_service_meter) : '—'} ${esc(v.unit)}
                · Governing usage: <b>${f1(t.used_since || 0)} / ${f0(v.interval)} ${esc(v.unit)}</b> (${esc(t.used_source)})
                · Projected due: <b>${esc(t.projected_due_date || '—')}</b>
              </div>
            </div>
            ${canManage ? '<button type="button" class="primary sm" id="vd-create-jr">Create Planned Service JR</button>' : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:8px">
            <button type="button" class="sm vd-tab ${curTab === 'fuel' ? 'primary' : ''}" data-tab="fuel">1. All-Site Fuel (${(f.issues_detail || []).length})</button>
            <button type="button" class="sm vd-tab ${curTab === 'bd' ? 'primary' : ''}" data-tab="bd">2. Month Breakdowns (${(bd.episodes_in_month || []).length})</button>
            <button type="button" class="sm vd-tab ${curTab === 'calc' ? 'primary' : ''}" data-tab="calc">3. Service Time Math</button>
            <button type="button" class="sm vd-tab ${curTab === 'filters' ? 'primary' : ''}" data-tab="filters">4. Filter Kit (${(v.filter_matrix || []).length})</button>
          </div>
          <div id="vd-pane"></div>
        `;

        const drawTab = () => {
          const pane = qs('#vd-pane', body);
          if (!pane) return;

          if (curTab === 'fuel') {
            const sitesSince = (f.sites_since || []).map((s) => `
              <span class="badge" style="margin:2px 4px 2px 0;background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe">
                <b>${esc(s.site_name)}</b>: ${f1(s.litres)} L (${s.issues} iss)
              </span>
            `).join('');
            const rows = (f.issues_detail || []).slice().reverse().map((iss) => `
              <tr>
                <td>${esc(iss.day)}</td>
                <td><b>${esc(iss.site_name)}</b><div class="muted" style="font-size:11px">${esc(iss.tank_name || '')}</div></td>
                <td class="num"><b>${f1(iss.litres)} L</b></td>
                <td class="num">${iss.meter_reading != null ? f0(iss.meter_reading) : '—'} ${esc(iss.meter_type || '')}</td>
                <td>${esc(iss.issue_no || '—')}</td>
                <td>${esc(iss.driver_name || '—')}</td>
              </tr>
            `).join('');
            pane.innerHTML = `
              <div style="margin-bottom:10px">
                <div style="font-size:12px;font-weight:700;margin-bottom:4px">
                  All Sites Since Last Service (${f1(f.litres_since_service || 0)} L total · Month ${detail.month}: ${f1(f.month_litres || 0)} L):
                </div>
                <div>${sitesSince || '<span class="muted">No non-voided fuel issues recorded since last service.</span>'}</div>
              </div>
              <div class="table-wrap scroll" style="max-height:360px">
                <table>
                  <thead><tr><th>Date (+05:30)</th><th>Site / Tank</th><th class="num">Litres</th><th class="num">Meter</th><th>Issue No</th><th>Driver</th></tr></thead>
                  <tbody>${rows || '<tr><td colspan="6" class="muted" style="text-align:center">No fuel issues found</td></tr>'}</tbody>
                </table>
              </div>
            `;
          } else if (curTab === 'bd') {
            const eps = bd.episodes_in_month || [];
            const rows = eps.map((ep) => `
              <tr>
                <td><b>${esc(ep.start)}</b></td>
                <td>${esc(ep.end || 'Open')}</td>
                <td class="num"><b>${ep.days_in_month}</b></td>
                <td>${esc(ep.site || '—')}</td>
                <td><span class="badge">${esc(ep.source || '')}</span></td>
                <td>${esc(ep.job_no || ep.jr_no || '—')}</td>
                <td>${esc(ep.status || 'OPEN')}</td>
                <td>${esc(ep.reason || '—')}</td>
              </tr>
            `).join('');
            const repaired = (bd.repair_replaced_filters || []).map((r) => `<li><b>${esc(r.date)}</b> (${esc(r.job_no || 'Repair')}): ${esc(r.description)}</li>`).join('');
            pane.innerHTML = `
              <div class="card" style="padding:10px 12px;margin-bottom:10px;background:#f8fafc">
                <b>Month Breakdown Summary (${esc(detail.month)}):</b>
                ${bd.breakdown_days_in_month || 0} breakdown day(s) in month ·
                ${bd.breakdown_days_since_service || 0} breakdown day(s) since last service ·
                Current status: <b>${bd.is_currently_down ? 'DOWN NOW' : 'Operational'}</b>
                ${bd.combine_on_breakdown ? ' · <span style="color:#b45309;font-weight:700">Within combine threshold — schedule service before returning machine to site</span>' : ''}
              </div>
              <div class="table-wrap scroll" style="max-height:280px">
                <table>
                  <thead><tr><th>Start</th><th>End</th><th class="num">Days in Month</th><th>Site</th><th>Source</th><th>Ref</th><th>Status</th><th>Reason / Defect</th></tr></thead>
                  <tbody>${rows || '<tr><td colspan="8" class="muted" style="text-align:center">No breakdown episodes recorded in this month</td></tr>'}</tbody>
                </table>
              </div>
              ${repaired ? `<div style="margin-top:10px"><b>Filter parts already issued on repair jobs (deduped if matched):</b><ul style="margin:4px 0 0 18px;font-size:12px">${repaired}</ul></div>` : ''}
            `;
          } else if (curTab === 'calc') {
            const meterWarns = (t.meter_warnings || []).length
              ? `<div style="margin-top:8px;padding:8px 10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:12px">
                  <b>Rejected Meter Readings:</b>
                  <ul style="margin:4px 0 0 16px">${t.meter_warnings.map((w) => `<li>${esc(w.day)} (${esc(w.source)}): <code>${w.value}</code> — ${esc(w.reason)}</li>`).join('')}</ul>
                </div>`
              : '';
            pane.innerHTML = `
              <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:12px">
                <div class="card" style="padding:10px 12px">
                  <div class="muted" style="font-size:11px">Trusted Meter Growth</div>
                  <div style="font-size:18px;font-weight:800">${f1(t.recorded_since)} ${esc(v.unit)}</div>
                  <div class="muted" style="font-size:11px">Current meter: ${t.current_meter != null ? f0(t.current_meter) : '—'} · ${esc(t.meter_note || 'ok')}</div>
                </div>
                <div class="card" style="padding:10px 12px">
                  <div class="muted" style="font-size:11px">All-Site Fuel Derived</div>
                  <div style="font-size:18px;font-weight:800">${f1(t.fuel_derived_since)} ${esc(v.unit)}</div>
                  <div class="muted" style="font-size:11px">${f1(f.litres_since_service)} L ÷ rate ${f.rate_typ ?? '—'} (${esc(f.rate_basis || v.meter_type)}) · ${esc(f.rate_status || '')}</div>
                </div>
                <div class="card" style="padding:10px 12px">
                  <div class="muted" style="font-size:11px">Active Burn Rate (Excl. Breakdowns)</div>
                  <div style="font-size:18px;font-weight:800">${t.active_rate_per_day != null ? `${f1(t.active_rate_per_day)} ${esc(v.unit)}/d` : '—'}</div>
                  <div class="muted" style="font-size:11px">Month active days: ${t.month_active_days ?? '—'} / ${t.month_elapsed_days ?? '—'} · Since active days: ${t.since_active_days ?? '—'}</div>
                </div>
                <div class="card" style="padding:10px 12px">
                  <div class="muted" style="font-size:11px">Governing Service Countdown</div>
                  <div style="font-size:18px;font-weight:800">${f1(t.used_since)} / ${f0(v.interval)} ${esc(v.unit)}</div>
                  <div class="muted" style="font-size:11px">Interval source: ${esc(v.interval_source)} · Due: <b>${esc(t.projected_due_date || '—')}</b></div>
                </div>
              </div>
              ${meterWarns}
              ${canOverride ? `
                <div class="card" style="padding:10px 12px;margin-top:10px;background:#f8fafc">
                  <b>Vehicle Base Service Interval Override</b>
                  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
                    <div>
                      <label class="muted" style="font-size:11px;display:block">Basis</label>
                      <select id="ov-basis"><option value="HOURS" ${v.meter_type === 'HOURS' ? 'selected' : ''}>HOURS</option><option value="KM" ${v.meter_type === 'KM' ? 'selected' : ''}>KM</option></select>
                    </div>
                    <div>
                      <label class="muted" style="font-size:11px;display:block">Service Every (${esc(v.unit)})</label>
                      <input type="number" id="ov-val" value="${v.interval}" style="width:110px">
                    </div>
                    <div>
                      <label class="muted" style="font-size:11px;display:block">Warn Threshold</label>
                      <input type="number" id="ov-warn" value="${v.warn_threshold}" style="width:95px">
                    </div>
                    <button type="button" class="primary sm" id="ov-save">Save Interval</button>
                    <button type="button" class="sm" id="ov-clear">Reset to Default</button>
                  </div>
                </div>
              ` : ''}
            `;

            if (canOverride) {
              qs('#ov-save', pane).onclick = async () => {
                try {
                  await api(`/filters/service-plan/vehicle/${v.asset_id}/filter-schedule`, {
                    method: 'PUT',
                    body: {
                      month: detail.month,
                      interval_override: {
                        basis: qs('#ov-basis', pane).value,
                        interval_value: Number(qs('#ov-val', pane).value),
                        warn_threshold: Number(qs('#ov-warn', pane).value),
                      },
                    },
                  });
                  toast('Service interval updated');
                  close();
                  if (onRefresh) onRefresh();
                  openVehicleModal(v.asset_id, detail.month, onRefresh);
                } catch (e) { toast(e.message, 'err'); }
              };
              qs('#ov-clear', pane).onclick = async () => {
                try {
                  await api(`/filters/service-plan/vehicle/${v.asset_id}/filter-schedule`, {
                    method: 'PUT',
                    body: { month: detail.month, interval_override: { clear: true } },
                  });
                  toast('Interval reset to category default');
                  close();
                  if (onRefresh) onRefresh();
                  openVehicleModal(v.asset_id, detail.month, onRefresh);
                } catch (e) { toast(e.message, 'err'); }
              };
            }
          } else if (curTab === 'filters') {
            const matrix = v.filter_matrix || [];
            const mRows = matrix.map((m, idx) => `
              <tr data-idx="${idx}">
                <td><b>${esc(m.category)}</b>${m.locked ? ' <span class="badge" title="Manually locked schedule">Locked</span>' : ''}</td>
                <td>${decisionBadgeHtml(m.decision)}</td>
                <td>
                  ${canOverride
                    ? `<select class="fm-every" style="width:95px">
                        <option value="1" ${m.every_n_services === 1 ? 'selected' : ''}>1x (Every)</option>
                        <option value="2" ${m.every_n_services === 2 ? 'selected' : ''}>2x</option>
                        <option value="3" ${m.every_n_services === 3 ? 'selected' : ''}>3x</option>
                        <option value="4" ${m.every_n_services === 4 ? 'selected' : ''}>4x</option>
                      </select>`
                    : `Every ${m.every_n_services}x`}
                </td>
                <td>
                  ${canOverride
                    ? `<select class="fm-between" style="width:95px">
                        <option value="SKIP" ${m.between_action === 'SKIP' ? 'selected' : ''}>SKIP</option>
                        <option value="E" ${m.between_action === 'E' ? 'selected' : ''}>CLEAN (E)</option>
                      </select>`
                    : esc(m.between_action)}
                </td>
                <td>
                  ${canOverride
                    ? `<input type="text" class="fm-part" value="${esc(m.part_no || '')}" style="width:130px">`
                    : esc(m.part_no || '—')}
                </td>
                <td class="num">
                  ${canOverride
                    ? `<input type="number" class="fm-qty" value="${m.qty || 1}" min="1" step="1" style="width:55px">`
                    : (m.qty || 1)}
                </td>
                <td>${esc(m.last_replaced_date || '—')}</td>
                <td class="num">
                  ${m.in_stock > 0 ? `<b style="color:#15803d">${m.in_stock}</b>` : '0'}
                  ${(m.equivalents_in_stock || []).length ? `<div class="muted" style="font-size:10px">Eq: ${esc(m.equivalents_in_stock.map((e) => `${e.part_no}(${e.in_stock})`).join(', '))}</div>` : ''}
                </td>
                <td style="font-size:12px">${esc(m.reason || '')}</td>
              </tr>
            `).join('');

            pane.innerHTML = `
              <p class="muted" style="margin-top:0">
                Only filters marked <b>CHANGE (X)</b> enter the purchase order and store picklist for service #${v.next_service_seq || 1}.
              </p>
              <div class="table-wrap scroll" style="max-height:360px">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th><th>Decision</th><th>Cycle</th><th>Between</th>
                      <th>Part No</th><th class="num">Qty</th><th>Last Changed</th>
                      <th class="num">Stock</th><th>Reason</th>
                    </tr>
                  </thead>
                  <tbody id="fm-tbody">${mRows || '<tr><td colspan="9" class="muted" style="text-align:center">No filter kit lines found in history or PM master</td></tr>'}</tbody>
                </table>
              </div>
              ${canOverride ? `
                <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between">
                  <div style="display:flex;gap:6px;align-items:center">
                    <input type="text" id="fm-new-cat" placeholder="Add category (e.g. Coolant Filter)" style="width:200px">
                    <input type="text" id="fm-new-part" placeholder="Part No" style="width:120px">
                    <button type="button" class="sm" id="fm-add-btn">+ Add Filter</button>
                  </div>
                  <button type="button" class="primary sm" id="fm-save-btn">Save Filter Schedule (Lock)</button>
                </div>
              ` : ''}
            `;

            if (canOverride) {
              const saveBtn = qs('#fm-save-btn', pane);
              if (saveBtn) {
                saveBtn.onclick = async () => {
                  const schedules = [];
                  qsa('#fm-tbody tr', pane).forEach((tr) => {
                    const m = matrix[Number(tr.dataset.idx)];
                    if (!m) return;
                    schedules.push({
                      category: m.category,
                      every_n_services: Number(qs('.fm-every', tr).value),
                      between_action: qs('.fm-between', tr).value,
                      part_no: qs('.fm-part', tr).value.trim() || null,
                      qty: Math.max(1, Number(qs('.fm-qty', tr).value) || 1),
                      locked: 1,
                    });
                  });
                  try {
                    await api(`/filters/service-plan/vehicle/${v.asset_id}/filter-schedule`, {
                      method: 'PUT',
                      body: { month: detail.month, schedules },
                    });
                    toast('Filter lifecycle schedule saved');
                    close();
                    if (onRefresh) onRefresh();
                    openVehicleModal(v.asset_id, detail.month, onRefresh);
                  } catch (e) { toast(e.message, 'err'); }
                };
              }
              const addBtn = qs('#fm-add-btn', pane);
              if (addBtn) {
                addBtn.onclick = async () => {
                  const cat = qs('#fm-new-cat', pane).value.trim();
                  if (!cat) return toast('Enter a filter category', 'err');
                  try {
                    await api(`/filters/service-plan/vehicle/${v.asset_id}/filter-schedule`, {
                      method: 'PUT',
                      body: {
                        month: detail.month,
                        schedules: [{
                          category: cat,
                          part_no: qs('#fm-new-part', pane).value.trim() || null,
                          every_n_services: 1,
                          between_action: 'SKIP',
                          qty: 1,
                          locked: 1,
                        }],
                      },
                    });
                    toast(`Added ${cat} to ${v.asset_code}`);
                    close();
                    if (onRefresh) onRefresh();
                    openVehicleModal(v.asset_id, detail.month, onRefresh);
                  } catch (e) { toast(e.message, 'err'); }
                };
              }
            }
          }
        };

        body.innerHTML = renderTabs();
        qsa('.vd-tab', body).forEach((btn) => {
          btn.onclick = () => {
            curTab = btn.dataset.tab;
            qsa('.vd-tab', body).forEach((b) => b.classList.toggle('primary', b === btn));
            drawTab();
          };
        });
        const jrBtn = qs('#vd-create-jr', body);
        if (jrBtn) {
          jrBtn.onclick = async () => {
            try {
              jrBtn.disabled = true;
              const resp = await api(`/filters/service-plan/vehicle/${v.asset_id}/create-service-request`, {
                method: 'POST',
                body: { month: detail.month },
              });
              toast(`Created Service JR ${resp.jr_no} (${resp.change_filters.length} change, ${resp.clean_filters.length} clean)`);
              close();
              if (onRefresh) onRefresh();
            } catch (e) {
              toast(e.message, 'err');
              jrBtn.disabled = false;
            }
          };
        }
        drawTab();
      } catch (e) {
        body.innerHTML = `<p class="err">${esc(e.message)}</p>`;
      }
    }, { wide: true });
  }

  async function renderServicePlanPage(c) {
    if (!canView('service_plan') && !canView('filters')) {
      c.innerHTML = '<div class="card"><p class="err">You do not have access to Service &amp; Filter Plan.</p></div>';
      return;
    }

    const hp = parseHashParams();
    const state = {
      month: hp.get('month') || colomboMonthNow(),
      search: hp.get('search') || hp.get('q') || '',
      site: hp.get('site') || '',
      statusTab: 'ACTIONABLE',
      includeLongOverdue: false,
      orderTab: 'cat',
    };

    const canExport = canDo('service_plan.export');
    const canManage = canDo('service_plan.manage', 'jobrequests.create');

    c.innerHTML = pageHeader(
      'Service & Filter Plan',
      'All-site fuel + month breakdowns → true service timing &amp; selective filter kit (Change / Clean / Skip)'
    ) + `
      <div class="toolbar" style="flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <label class="muted" style="font-size:12px">Month <input type="month" id="sp_month" value="${esc(state.month)}" style="width:150px"></label>
        <input type="search" id="sp_search" value="${esc(state.search)}" placeholder="Search vehicle / reg / E&amp;C / type…" style="width:220px">
        <select id="sp_site" style="width:190px"><option value="">All Sites (Fuel Always All-Site)</option></select>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px"><input type="checkbox" id="sp_long"> Show Parked / Inactive</label>
        <div class="spacer"></div>
        <button type="button" class="sm" id="sp_rules_btn">Category Cycles (1x/2x/4x)</button>
        ${canExport ? '<a class="btn sm primary" id="sp_xlsx" href="#">Download Excel Plan</a>' : ''}
      </div>
      <div id="sp_kpis" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:10px;margin-bottom:12px"></div>
      <div id="sp_tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div>
      <div id="sp_list"><div class="card muted">Calculating all-site fuel, breakdowns, and selective filter kits…</div></div>
      <div class="card section" id="sp_order_card" style="margin-top:16px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <h3 style="margin:0">Store Picklist &amp; Purchase Order <span class="muted" style="font-size:12px;font-weight:400">— ONLY CHANGE (X) filters for due &amp; overdue vehicles</span></h3>
          <div class="spacer"></div>
          <button type="button" class="sm primary" id="sptab_cat">Order by Category</button>
          <button type="button" class="sm" id="sptab_part">Order by Part</button>
        </div>
        <div id="sp_order"></div>
      </div>
    `;

    let lastPlan = null;

    const drawOrder = () => {
      if (!lastPlan) return;
      const box = qs('#sp_order', c);
      if (state.orderTab === 'cat') {
        box.innerHTML = tableWrap(
          [
            { label: 'Filter Category', cls: 'desc-col' },
            { label: 'Qty Needed (Change)', num: true, width: '140px' },
            { label: 'Vehicles', num: true, width: '90px' },
            { label: 'On Hand', num: true, width: '90px' },
            { label: 'Shortfall', num: true, width: '90px' },
          ],
          (lastPlan.categories || []).map((x) => `
            <tr${x.shortfall > 0 ? ' style="background:rgba(217,119,6,0.06)"' : ''}>
              <td class="desc-col"><b>${esc(x.category)}</b></td>
              <td class="num">${num(x.qty)}</td>
              <td class="num">${num(x.vehicles)}</td>
              <td class="num">${num(x.on_hand)}</td>
              <td class="num">${x.shortfall > 0 ? `<b style="color:#b45309">${num(x.shortfall)}</b>` : '0'}</td>
            </tr>
          `),
          { scroll: true }
        );
      } else {
        box.innerHTML = tableWrap(
          [
            { label: 'Part Number', width: '180px' },
            { label: 'Category', cls: 'desc-col' },
            { label: 'Vehicles', num: true, width: '80px' },
            { label: 'Needed', num: true, width: '80px' },
            { label: 'On Hand', num: true, width: '85px' },
            { label: 'To Buy', num: true, width: '85px' },
            { label: 'Unit Price', num: true, width: '105px' },
            { label: 'Value', num: true, width: '115px' },
          ],
          (lastPlan.parts || []).map((p) => {
            const eq = (p.equivalents_in_stock || []).map((e) => `${e.part_no} (${e.in_stock})`).join(', ');
            return `
              <tr${p.to_buy > 0 ? ' style="background:rgba(217,119,6,0.06)"' : ''}>
                <td>
                  <b>${esc(p.part)}</b>
                  ${p.no_stock_row ? ' <span class="badge">not in stock sheet</span>' : ''}
                  ${eq ? `<div style="font-size:11px;color:#0f766e">Equiv in stock: ${esc(eq)}</div>` : ''}
                </td>
                <td class="desc-col">${esc(p.category)}</td>
                <td class="num">${num(p.vehicles)}</td>
                <td class="num">${num(p.qty)}</td>
                <td class="num">${num(p.on_hand)}</td>
                <td class="num">${p.to_buy > 0 ? `<b style="color:#b45309">${num(p.to_buy)}</b>` : '0'}</td>
                <td class="num">${p.unit_price == null ? '<span class="muted">no price</span>' : money(p.unit_price)}</td>
                <td class="num">${p.value == null ? '—' : money(p.value)}</td>
              </tr>
            `;
          }),
          { scroll: true }
        );
      }
    };

    const drawTable = () => {
      if (!lastPlan) return;
      const bdOpp = lastPlan.breakdown_opportunities || [];
      const carry = lastPlan.carry || [];
      const due = lastPlan.due || [];
      const onBd = lastPlan.on_breakdown || [];
      const ok = lastPlan.ok || [];
      const parked = lastPlan.parked || [];

      const actionable = [...bdOpp, ...carry, ...due];
      const allTracked = [...bdOpp, ...carry, ...due, ...onBd, ...ok];

      let shown = actionable;
      if (state.statusTab === 'OVERDUE') shown = carry;
      else if (state.statusTab === 'DUE_SOON') shown = due;
      else if (state.statusTab === 'SERVICE_ON_BREAKDOWN') shown = bdOpp;
      else if (state.statusTab === 'ON_BREAKDOWN') shown = onBd;
      else if (state.statusTab === 'ALL_TRACKED') shown = allTracked;
      else if (state.statusTab === 'PARKED') shown = parked;

      const tabs = [
        { k: 'ACTIONABLE', lbl: `Actionable (${actionable.length})` },
        { k: 'SERVICE_ON_BREAKDOWN', lbl: `Service on Breakdown (${lastPlan.totals.service_on_breakdown || 0})` },
        { k: 'OVERDUE', lbl: `Overdue (${lastPlan.totals.overdue || 0})` },
        { k: 'DUE_SOON', lbl: `Due This Month (${lastPlan.totals.due_in_month || 0})` },
        { k: 'ON_BREAKDOWN', lbl: `On Breakdown (${lastPlan.totals.on_breakdown || 0})` },
        { k: 'ALL_TRACKED', lbl: `All Tracked (${allTracked.length})` },
      ];
      if (state.includeLongOverdue || parked.length) {
        tabs.push({ k: 'PARKED', lbl: `Parked (${parked.length})` });
      }

      const tabsEl = qs('#sp_tabs', c);
      tabsEl.innerHTML = tabs.map((tb) => `<button type="button" class="sm sp-st-tab ${state.statusTab === tb.k ? 'primary' : ''}" data-st="${tb.k}">${esc(tb.lbl)}</button>`).join('');
      qsa('.sp-st-tab', tabsEl).forEach((b) => {
        b.onclick = () => {
          state.statusTab = b.dataset.st;
          if (state.statusTab === 'ALL_TRACKED' && !ok.length && (lastPlan.totals.ok || 0) > 0) {
            load(true);
            return;
          }
          drawTable();
        };
      });

      const listEl = qs('#sp_list', c);
      listEl.innerHTML = tableWrap(
        [
          { label: 'Vehicle', width: '165px' },
          { label: 'Site / Multi-Site Fuel', width: '150px' },
          { label: 'Last Service & Next Seq', width: '145px' },
          { label: 'All-Site Fuel', num: true, width: '115px' },
          { label: 'Month Breakdowns', width: '130px' },
          { label: 'Usage & Active Burn Rate', width: '185px' },
          { label: 'Projected Due', width: '120px' },
          { label: 'Filters To Change (X) · Clean / Skip' },
          { label: 'Actions', width: '140px' },
        ],
        shown.map((v) => buildVehicleRow(v, { canManage })),
        { scroll: true }
      );

      qsa('.sp-veh-btn, .sp-inspect-btn', listEl).forEach((btn) => {
        btn.onclick = () => openVehicleModal(btn.dataset.aid, state.month, () => load(state.statusTab === 'ALL_TRACKED'));
      });
      qsa('.sp-jr-btn', listEl).forEach((btn) => {
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            const resp = await api(`/filters/service-plan/vehicle/${btn.dataset.aid}/create-service-request`, {
              method: 'POST',
              body: { month: state.month },
            });
            toast(`Created ${resp.jr_no} (${resp.change_filters.length} CHANGE, ${resp.clean_filters.length} CLEAN)`);
            btn.disabled = false;
          } catch (e) {
            toast(e.message, 'err');
            btn.disabled = false;
          }
        };
      });
    };

    const load = async (wantOk = false) => {
      const qsParams = new URLSearchParams({
        month: state.month,
        include_long_overdue: state.includeLongOverdue ? '1' : '0',
        include_ok: (wantOk || state.statusTab === 'ALL_TRACKED') ? '1' : '0',
      });
      if (state.site) qsParams.set('site', state.site);
      if (state.search) qsParams.set('search', state.search);

      const xlsxLink = qs('#sp_xlsx', c);
      if (xlsxLink) {
        const base = (window.WORKSHOPONE_API_BASE || '').replace(/\/+$/, '');
        xlsxLink.href = `${base}/api/filters/service-plan?month=${encodeURIComponent(state.month)}&site=${encodeURIComponent(state.site)}&search=${encodeURIComponent(state.search)}&format=xlsx`;
      }

      try {
        lastPlan = await api(`/filters/service-plan?${qsParams.toString()}`);

        const siteSel = qs('#sp_site', c);
        const prevSite = state.site;
        const sites = lastPlan.sites_available || [];
        siteSel.innerHTML = '<option value="">All Sites (Fuel Always All-Site)</option>'
          + sites.map((s) => `<option value="${esc(s)}"${s === prevSite ? ' selected' : ''}>${esc(s)}</option>`).join('');

        const t = lastPlan.totals || {};
        qs('#sp_kpis', c).innerHTML = `
          <div class="card" style="padding:10px 12px;border-left:4px solid #dc2626">
            <div class="muted" style="font-size:11px">Overdue Services</div>
            <div style="font-size:22px;font-weight:800;color:#dc2626">${num(t.overdue || 0)}</div>
          </div>
          <div class="card" style="padding:10px 12px;border-left:4px solid #d97706">
            <div class="muted" style="font-size:11px">Due This Month</div>
            <div style="font-size:22px;font-weight:800;color:#d97706">${num(t.due_in_month || 0)}</div>
          </div>
          <div class="card" style="padding:10px 12px;border-left:4px solid #b45309">
            <div class="muted" style="font-size:11px">Service on Breakdown</div>
            <div style="font-size:22px;font-weight:800;color:#b45309">${num(t.service_on_breakdown || 0)}</div>
          </div>
          <div class="card" style="padding:10px 12px;border-left:4px solid #0284c7">
            <div class="muted" style="font-size:11px">Filters to Change (Qty / Est. Buy)</div>
            <div style="font-size:20px;font-weight:800">${num(t.qty_needed || 0)} <span class="muted" style="font-size:12px">(${num(t.qty_to_buy || 0)} buy)</span></div>
            <div class="muted" style="font-size:11px">${money(t.value_priced || 0)}</div>
          </div>
          <div class="card" style="padding:10px 12px;border-left:4px solid #16a34a">
            <div class="muted" style="font-size:11px">Saved by Selective Lifecycle</div>
            <div style="font-size:22px;font-weight:800;color:#15803d">${num(t.filters_saved_by_plan || 0)}</div>
            <div class="muted" style="font-size:11px">Cleaned or skipped lines</div>
          </div>
        `;

        drawTable();
        drawOrder();
      } catch (e) {
        qs('#sp_list', c).innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
      }
    };

    qs('#sp_month', c).onchange = () => { state.month = qs('#sp_month', c).value || colomboMonthNow(); load(); };
    qs('#sp_site', c).onchange = () => { state.site = qs('#sp_site', c).value; load(); };
    qs('#sp_long', c).onchange = () => { state.includeLongOverdue = qs('#sp_long', c).checked; load(); };

    let searchTimer = null;
    qs('#sp_search', c).addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = qs('#sp_search', c).value.trim(); load(); }, 220);
    });

    qs('#sp_rules_btn', c).onclick = () => openCategoryRulesModal(() => load());
    qs('#sptab_cat', c).onclick = () => {
      state.orderTab = 'cat';
      qs('#sptab_cat', c).classList.add('primary');
      qs('#sptab_part', c).classList.remove('primary');
      drawOrder();
    };
    qs('#sptab_part', c).onclick = () => {
      state.orderTab = 'part';
      qs('#sptab_part', c).classList.add('primary');
      qs('#sptab_cat', c).classList.remove('primary');
      drawOrder();
    };

    await load();

    const preVeh = hp.get('vehicle');
    if (preVeh) {
      openVehicleModal(preVeh, state.month, () => load());
    }
  }

  window.ServicePlanUI = {
    render: renderServicePlanPage,
    openVehicleModal,
    openCategoryRulesModal,
  };
})();
