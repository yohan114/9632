'use strict';
// ===========================================================================
// ---- Vehicle Documents & Statutory Compliance (Phase 4)
// ===========================================================================
routes.vehicledocuments = async (c, parts = []) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = sp.get('tab') || 'compliance';
  const TABS = [
    ['compliance', '📊 Fleet Compliance'],
    ['upcoming', '⏳ Upcoming Expirations'],
    ['tasks', '📋 Renewal Tasks']
  ];

  const tabToolbar = `<div class="toolbar" style="margin-bottom:12px">${TABS
    .map(([t, l]) => `<button class="sm ${t === tab ? 'primary' : ''}" data-nav="#/vehicledocuments?tab=${t}">${l}</button>`).join('')}</div>`;

  c.innerHTML = pageHeader('Vehicle Documents & Statutory Compliance') + tabToolbar + '<div id="vdocbody" class="muted">Loading…</div>';
  const body = qs('#vdocbody', c);

  if (tab === 'compliance') {
    return renderVdocCompliance(body, sp);
  } else if (tab === 'upcoming') {
    return renderVdocUpcoming(body, sp);
  } else if (tab === 'tasks') {
    return renderVdocTasks(body, sp);
  }
};

async function renderVdocCompliance(body, sp) {
  let sum;
  try {
    sum = await api('/vehicle-documents/compliance-summary');
  } catch (e) {
    body.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
    return;
  }

  const kp = sum.kpis || {};
  const tb = sum.type_breakdown || {};
  const vehicles = sum.vehicles || [];

  // Traffic-light KPI Ribbon
  const pctColor = kp.compliance_percentage >= 90 ? 'var(--green)' : (kp.compliance_percentage >= 70 ? 'var(--amber)' : 'var(--red)');
  const kpiCards = `
    <div class="grid section" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px">
      <div class="card stat"><span class="n">${kp.total_vehicles ?? 0}</span><span class="l">Registered Fleet</span></div>
      <div class="card stat"><span class="n" style="color:${pctColor}">${kp.compliance_percentage ?? 100}%</span><span class="l">Compliance Rate</span></div>
      <div class="card stat"><span class="n" style="color:var(--green)">${kp.fully_compliant ?? 0}</span><span class="l">Fully Compliant</span></div>
      <div class="card stat"><span class="n" style="color:var(--red)">${kp.critical_count ?? 0}</span><span class="l">Critical (≤7d)</span></div>
      <div class="card stat"><span class="n" style="color:var(--amber)">${kp.warning_count ?? 0}</span><span class="l">Expiring Soon (8-30d)</span></div>
      <div class="card stat"><span class="n" style="color:var(--red)">${kp.expired_count ?? 0}</span><span class="l">Expired / Overdue</span></div>
      <div class="card stat"><span class="n">${kp.exempt_count ?? 0}</span><span class="l">Laid-up / Exempt</span></div>
    </div>`;

  // Category summary pills
  const typeChips = [
    { label: 'Revenue Licence (eRL)', key: 'revenue_licence', icon: '🏛️' },
    { label: 'Vehicle Insurance', key: 'insurance', icon: '🛡️' },
    { label: 'Emission Test (VET)', key: 'emission', icon: '💨' },
    { label: 'Fitness Certificate', key: 'fitness', icon: '🩺' },
  ].map((tc) => {
    const s = tb[tc.key] || { valid: 0, critical: 0, warning: 0, expired: 0, exempt: 0 };
    const issueCount = (s.critical || 0) + (s.expired || 0);
    return `<div class="card" style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:600">${tc.icon} ${tc.label}</div>
      <div style="display:flex;gap:6px;font-size:12px">
        <span class="badge green" title="Valid">${s.valid || 0} valid</span>
        ${s.warning ? `<span class="badge amber" title="Expiring Soon">${s.warning} soon</span>` : ''}
        ${issueCount ? `<span class="badge red" title="Critical or Expired">${issueCount} alert</span>` : ''}
        ${s.exempt ? `<span class="badge" title="Exempt">${s.exempt} exempt</span>` : ''}
      </div>
    </div>`;
  }).join('');

  const typeGrid = `<div class="grid section" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-bottom:14px">${typeChips}</div>`;

  const canBulkImport = isAdmin() || canDo('vehicle_docs.renew', 'vehicle_docs.edit');
  // Filter toolbar
  const filterToolbar = `
    <div class="toolbar" style="margin-bottom:10px">
      <input type="search" id="vdoc-q" placeholder="Search vehicle code / registration / type…" style="max-width:280px">
      <select id="vdoc-status-filter" style="max-width:200px">
        <option value="">All Compliance Statuses</option>
        <option value="compliant">Fully Compliant</option>
        <option value="critical">Critical (≤7 days)</option>
        <option value="warning">Expiring Soon (8–30 days)</option>
        <option value="expired">Expired</option>
        <option value="missing">Missing Documents</option>
        <option value="exempt">Laid-up / Exempt</option>
      </select>
      <div class="spacer"></div>
      ${canBulkImport ? '<button type="button" class="sm primary" id="btn_vdoc_bulk_import">📥 Bulk Import Expiries</button>' : ''}
      <a href="/api/vehicle-documents/export.xlsx" class="btn sm" style="text-decoration:none">📊 Export Excel</a>
      <span class="muted" id="vdoc-count" style="font-size:12px">${vehicles.length} vehicles</span>
    </div>`;

  body.innerHTML = kpiCards + typeGrid + filterToolbar + '<div id="vdoc-table-container"></div>';

  const container = qs('#vdoc-table-container', body);

  function renderRows() {
    const q = (qs('#vdoc-q', body).value || '').trim().toLowerCase();
    const st = qs('#vdoc-status-filter', body).value;

    const filtered = vehicles.filter((v) => {
      if (st && v.overall_status !== st) return false;
      if (q) {
        const text = `${v.code || ''} ${v.registration || ''} ${v.type || ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    qs('#vdoc-count', body).textContent = `${filtered.length} of ${vehicles.length} vehicles`;

    const rows = filtered.map((v) => {
      const stBadge = v.overall_status === 'compliant'
        ? '<span class="badge green">Compliant</span>'
        : (v.overall_status === 'warning'
            ? '<span class="badge amber">Expiring Soon</span>'
            : (v.overall_status === 'critical'
                ? '<span class="badge red">Critical</span>'
                : (v.overall_status === 'expired'
                    ? '<span class="badge red">Expired</span>'
                    : (v.overall_status === 'missing'
                        ? '<span class="badge red">Missing Docs</span>'
                        : '<span class="badge">Exempt</span>'))));

      // Mini document chips
      const docChips = (v.documents || []).filter((d) => ['cr', 'revenue_licence', 'insurance', 'emission', 'fitness'].includes(d.doc_type_code)).map((d) => {
        const ev = d.evaluation || {};
        const b = ev.badge || { text: '—', color: 'gray' };
        const color = b.color === 'green' ? 'green' : (b.color === 'red' ? 'red' : (b.color === 'amber' ? 'amber' : ''));
        const shortName = d.doc_type_code === 'revenue_licence' ? 'eRL' : (d.doc_type_code === 'insurance' ? 'INS' : (d.doc_type_code === 'emission' ? 'VET' : (d.doc_type_code === 'fitness' ? 'VCR' : 'CR')));
        return `<span class="badge ${color}" style="font-size:10px;padding:1px 5px" title="${esc(d.doc_type_name)}: ${esc(b.text)}">${shortName}: ${esc(b.text)}</span>`;
      }).join(' ');

      return `<tr>
        <td>
          <a href="#/assets/${v.asset_id}" style="font-weight:700;text-decoration:none">🚜 ${esc(v.code)}</a>
          ${v.registration ? `<span style="margin-left:6px;font-size:12px;color:var(--text)">[${esc(v.registration)}]</span>` : ''}
          <div class="muted" style="font-size:11px">${esc(v.type || '—')}</div>
        </td>
        <td>${stBadge}</td>
        <td><div style="display:flex;gap:4px;flex-wrap:wrap">${docChips}</div></td>
        <td style="white-space:nowrap;text-align:right">
          <a href="#/assets/${v.asset_id}" class="btn sm" style="text-decoration:none;padding:2px 8px;font-size:11px">Inspect Asset</a>
          <button class="sm btn-vdoc-erl" data-id="${v.asset_id}" data-name="${esc(v.registration || v.code)}" style="padding:2px 8px;font-size:11px">📋 eRL Check</button>
        </td>
      </tr>`;
    });

    container.innerHTML = tableWrap(
      [{ label: 'Vehicle / Asset' }, { label: 'Compliance Status' }, { label: 'Statutory Certificates' }, { label: 'Actions', cls: 'num' }],
      rows,
      { scroll: true }
    );

    qsa('.btn-vdoc-erl', container).forEach((btn) => {
      btn.onclick = () => showErlChecklistModal(btn.dataset.id, btn.dataset.name);
    });
  }

  qs('#vdoc-q', body).oninput = renderRows;
  qs('#vdoc-status-filter', body).onchange = renderRows;
  if (qs('#btn_vdoc_bulk_import', body)) {
    qs('#btn_vdoc_bulk_import', body).onclick = () => openVdocBulkImportModal(() => renderVdocCompliance(body, sp));
  }
  renderRows();
}

function openVdocBulkImportModal(onDone) {
  const canVerify = isAdmin() || canDo('vehicle_docs.verify');

  const splitLine = (line, delim) => {
    if (delim === '\t') return line.split('\t').map((c) => c.trim().replace(/^"|"$/g, ''));
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === delim && !inQ) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const normalizeDateStr = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const slashYmd = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (slashYmd) return `${slashYmd[1]}-${slashYmd[2].padStart(2, '0')}-${slashYmd[3].padStart(2, '0')}`;
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    return s;
  };

  const parseBulkText = (text) => {
    const rawLines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!rawLines.length) return [];
    const delim = rawLines[0].includes('\t') ? '\t' : ',';
    const parsed = [];
    for (let idx = 0; idx < rawLines.length; idx++) {
      const cols = splitLine(rawLines[idx], delim);
      if (idx === 0 && /^(vehicle|code|asset|reg)/i.test(cols[0] || '') && /^(doc|type)/i.test(cols[1] || '')) {
        continue;
      }
      if (!cols[0] && !cols[1]) continue;
      parsed.push({
        vehicle: cols[0] || '',
        doc_type: cols[1] || '',
        valid_until: normalizeDateStr(cols[2] || ''),
        doc_number: cols[3] || '',
        issuer_name: cols[4] || '',
        valid_from: normalizeDateStr(cols[5] || ''),
        cost_amount: cols[6] !== undefined && cols[6] !== '' ? Number(cols[6]) || 0 : 0,
      });
    }
    return parsed;
  };

  modal('Bulk Import Vehicle Document Expiries', `
    <p class="muted" style="margin-top:0;font-size:12px">
      Upload a <code>.csv</code> file or paste rows copied from Excel.<br>
      <b>Columns:</b> <code>vehicle, doc_type, valid_until, doc_number, issuer_name, valid_from, cost_amount</code><br>
      <b>Valid doc_type codes:</b> <code>revenue_licence</code>, <code>insurance</code>, <code>emission</code>, <code>fitness</code>, <code>cr</code>, <code>permit</code>, <code>company_doc</code>
    </p>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <input type="file" id="vdbi-file" accept=".csv,.txt,.tsv" style="max-width:260px">
      <button type="button" class="sm" id="vdbi-tpl">⬇ Download CSV Template</button>
    </div>
    <label>Paste CSV / Excel Rows</label>
    <textarea id="vdbi-text" rows="6" placeholder="WP-1234,revenue_licence,2027-06-30,RL-99881,WP DMT,2026-07-01,12500&#10;WP-1234,insurance,2027-03-31,POL-5521,Sri Lanka Insurance" style="font-family:monospace;font-size:12px"></textarea>
    ${canVerify ? `
      <label style="display:flex;align-items:center;gap:6px;margin:8px 0;font-weight:normal;cursor:pointer">
        <input type="checkbox" id="vdbi-verify" checked style="width:auto">
        <span>Auto-verify imported certificates immediately</span>
      </label>` : ''}
    <div id="vdbi-preview" style="margin-top:8px"></div>
    <div id="vdbi-result" style="margin-top:8px"></div>
    <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px">
      <button type="button" id="vdbi-cancel">Cancel</button>
      <button type="button" class="primary" id="vdbi-submit" disabled>📥 Import Rows</button>
    </div>`, (b, close) => {
    const txtEl = qs('#vdbi-text', b);
    const prevEl = qs('#vdbi-preview', b);
    const resEl = qs('#vdbi-result', b);
    const subBtn = qs('#vdbi-submit', b);
    let currentRows = [];

    const repaintPreview = () => {
      currentRows = parseBulkText(txtEl.value);
      subBtn.disabled = !currentRows.length;
      if (!currentRows.length) {
        prevEl.innerHTML = '<span class="muted" style="font-size:12px">No rows parsed yet.</span>';
        return;
      }
      const head = currentRows.slice(0, 20);
      prevEl.innerHTML = `
        <div class="muted" style="font-size:12px;margin-bottom:4px">Parsed <b>${currentRows.length}</b> row(s)${currentRows.length > 20 ? ' (showing first 20)' : ''}:</div>
        <div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:6px">
          ${tableWrap(
            [{ label: 'Vehicle' }, { label: 'Doc Type' }, { label: 'Valid Until' }, { label: 'Certificate #' }, { label: 'Issuer' }],
            head.map((r) => `<tr><td><b>${esc(r.vehicle)}</b></td><td><code>${esc(r.doc_type)}</code></td><td>${esc(r.valid_until || '—')}</td><td>${esc(r.doc_number || '(auto)')}</td><td>${esc(r.issuer_name || '—')}</td></tr>`)
          )}
        </div>`;
    };

    qs('#vdbi-tpl', b).onclick = () => {
      const sample = 'vehicle,doc_type,valid_until,doc_number,issuer_name,valid_from,cost_amount\nVH-01,revenue_licence,2027-06-30,RL-2026-001,WP DMT,2026-07-01,12500\nVH-01,insurance,2027-03-31,POL-2026-881,SLIC,2026-04-01,45000\n';
      const blob = new Blob([sample], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vehicle-documents-template.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    qs('#vdbi-file', b).onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      txtEl.value = await f.text();
      repaintPreview();
    };

    txtEl.oninput = repaintPreview;
    repaintPreview();

    qs('#vdbi-cancel', b).onclick = close;
    subBtn.onclick = async () => {
      if (!currentRows.length) return;
      subBtn.disabled = true;
      subBtn.textContent = 'Importing...';
      resEl.innerHTML = '';
      try {
        const autoVerifyEl = qs('#vdbi-verify', b);
        const out = await api('/vehicle-documents/bulk-import', {
          method: 'POST',
          body: {
            rows: currentRows,
            auto_verify: Boolean(autoVerifyEl && autoVerifyEl.checked),
          },
        });
        toast(`Imported ${out.imported_count || 0} certificates (${out.skipped_count || 0} skipped)`);
        if (out.skipped_count > 0 && out.skipped && out.skipped.length) {
          resEl.innerHTML = `<div class="card" style="padding:10px;border-left:4px solid var(--amber);font-size:12px">
            <b>Imported ${out.imported_count}</b> · <b>Skipped ${out.skipped_count}</b>:
            <ul style="margin:4px 0 0 18px">${out.skipped.slice(0, 10).map((s) => `<li>Row #${Number(s.index) + 1}: ${esc(s.reason)}${s.input ? ` (${esc(s.input)})` : ''}</li>`).join('')}</ul>
          </div>`;
          subBtn.textContent = '📥 Import Rows';
          subBtn.disabled = false;
          if (out.imported_count > 0 && onDone) onDone();
        } else {
          close();
          if (onDone) onDone();
        }
      } catch (e) {
        toast(e.message, 'err');
        subBtn.disabled = false;
        subBtn.textContent = '📥 Import Rows';
      }
    };
  }, { wide: true });
}

async function renderVdocUpcoming(body, sp) {
  const days = Number(sp.get('days')) || 30;
  let upcoming;
  try {
    upcoming = await api(`/vehicle-documents/upcoming-expirations?daysAhead=${days}`);
  } catch (e) {
    body.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
    return;
  }

  const horizons = [14, 30, 60, 90];
  const horizonButtons = horizons.map((h) => `
    <button class="sm ${h === days ? 'primary' : ''}" data-nav="#/vehicledocuments?tab=upcoming&days=${h}">${h} Days</button>
  `).join('');

  const toolbar = `
    <div class="toolbar" style="margin-bottom:12px">
      <span style="font-size:13px;font-weight:600;margin-right:8px">Horizon:</span>
      ${horizonButtons}
      <div class="spacer"></div>
      <a href="/api/vehicle-documents/export.xlsx" class="btn sm" style="text-decoration:none">📊 Export Excel</a>
      <span class="muted" style="font-size:12px">${upcoming.length} certificates expiring within ${days} days</span>
    </div>`;

  const rows = upcoming.map((u) => {
    const badgeColor = u.badge && u.badge.color;
    const badgeCls = badgeColor === 'green' ? 'green' : (badgeColor === 'red' ? 'red' : (badgeColor === 'amber' ? 'amber' : 'blue'));
    const attLink = u.version_id
      ? `<button class="sm btn-up-hist" data-id="${u.document_id}" data-name="${esc(u.doc_type_name)}" style="padding:2px 8px;font-size:11px">History / Scans</button>`
      : '<span class="muted">—</span>';

    return `<tr>
      <td>
        <a href="#/assets/${u.asset_id}" style="font-weight:700;text-decoration:none">🚜 ${esc(u.asset_code)}</a>
        ${u.registration ? `<span style="margin-left:6px;font-size:12px;color:var(--text)">[${esc(u.registration)}]</span>` : ''}
        <div class="muted" style="font-size:11px">${esc(u.asset_type || '')}</div>
      </td>
      <td><b>${esc(u.doc_type_name)}</b></td>
      <td><code>${esc(u.doc_number || '—')}</code></td>
      <td><b>${esc(u.valid_until)}</b></td>
      <td><span class="badge ${badgeCls}">${esc((u.badge && u.badge.text) || u.days_remaining + 'd')}</span></td>
      <td>${attLink}</td>
      <td style="white-space:nowrap;text-align:right">
        ${canDo('vehicle_docs.renew') ? `<button class="sm btn-up-renew" data-id="${u.document_id}" data-name="${esc(u.doc_type_name)}" style="padding:2px 8px;font-size:11px">+ Renew</button>` : ''}
        <a href="#/assets/${u.asset_id}" class="btn sm" style="text-decoration:none;padding:2px 8px;font-size:11px">Inspect Asset</a>
      </td>
    </tr>`;
  });

  body.innerHTML = toolbar + tableWrap(
    [{ label: 'Vehicle' }, { label: 'Document Type' }, { label: 'Certificate No' }, { label: 'Valid Until' }, { label: 'Countdown' }, { label: 'Files' }, { label: 'Actions', cls: 'num' }],
    rows,
    { scroll: true }
  );

  qsa('.btn-up-renew', body).forEach((btn) => {
    btn.onclick = () => showRenewDocumentModal(btn.dataset.id, btn.dataset.name, () => renderVdocUpcoming(body, sp));
  });
  qsa('.btn-up-hist', body).forEach((btn) => {
    btn.onclick = () => showDocumentHistoryModal(btn.dataset.id, btn.dataset.name);
  });
}

async function renderVdocTasks(body, sp) {
  const activeOnly = sp.get('active_only') !== '0';
  const stage = sp.get('stage') || '';

  let tasks;
  try {
    const qParts = [];
    if (activeOnly) qParts.push('active_only=1');
    if (stage) qParts.push('stage=' + encodeURIComponent(stage));
    tasks = await api('/vehicle-documents/tasks' + (qParts.length ? '?' + qParts.join('&') : ''));
  } catch (e) {
    body.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
    return;
  }

  const STAGES = [
    { value: '', label: 'All Stages' },
    { value: 'assigned', label: 'Assigned' },
    { value: 'application_submitted', label: 'Application Submitted' },
    { value: 'pending_verification', label: 'Pending Verification' },
    { value: 'completed', label: 'Completed' },
  ];

  const stageOpts = STAGES.map((s) => `<option value="${s.value}" ${s.value === stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('');

  const toolbar = `
    <div class="toolbar" style="margin-bottom:12px">
      <label style="display:flex;align-items:center;gap:6px;flex-direction:row;font-size:13px;width:auto">
        <input type="checkbox" id="task-active-only" ${activeOnly ? 'checked' : ''} style="width:auto"> Active tasks only
      </label>
      <select id="task-stage-filter" style="max-width:200px">${stageOpts}</select>
      <div class="spacer"></div>
      <span class="muted" style="font-size:12px">${tasks.length} tasks</span>
    </div>`;

  const rows = tasks.map((t) => {
    const stageBadge = t.stage === 'completed'
      ? '<span class="badge green">Completed</span>'
      : (t.stage === 'application_submitted' || t.stage === 'pending_verification'
          ? '<span class="badge amber">' + esc(t.stage) + '</span>'
          : '<span class="badge blue">' + esc(t.stage) + '</span>');

    const costStr = t.actual_cost != null ? money(t.actual_cost) : (t.estimated_cost != null ? money(t.estimated_cost) + ' (est)' : '—');

    return `<tr>
      <td>#${t.id} <div class="muted" style="font-size:11px">${String(t.created_at || '').slice(0, 10)}</div></td>
      <td>
        <a href="#/assets/${t.asset_id}" style="font-weight:700;text-decoration:none">🚜 ${esc(t.asset_code)}</a>
        ${t.registration ? `<span style="margin-left:6px;font-size:12px;color:var(--text)">[${esc(t.registration)}]</span>` : ''}
      </td>
      <td><b>${esc(t.doc_type_name)}</b></td>
      <td>${stageBadge}${inlineDelayBadgeHtml(m.req_date, l.last_received, remaining > 0 && !l.is_cancelled && m.approval_status !== 'rejected')}</td>
      <td>${esc(t.target_date || '—')}</td>
      <td>${costStr}</td>
      <td>${esc(t.assigned_to_name || '—')}</td>
      <td>${t.temporary_receipt_no ? `<span class="badge" style="font-size:10px">RCP: ${esc(t.temporary_receipt_no)}</span> ` : ''}${esc(t.notes || '—')}</td>
      <td style="white-space:nowrap;text-align:right">
        ${canDo('vehicle_docs.renew') ? `<button class="sm btn-task-edit" data-id="${t.id}" style="padding:2px 8px;font-size:11px">Update</button>` : ''}
        <button class="sm btn-task-hist" data-id="${t.document_id}" data-name="${esc(t.doc_type_name)}" style="padding:2px 8px;font-size:11px">Doc</button>
      </td>
    </tr>`;
  });

  body.innerHTML = toolbar + tableWrap(
    [{ label: 'Task' }, { label: 'Vehicle' }, { label: 'Document Type' }, { label: 'Stage' }, { label: 'Target Date' }, { label: 'Fee / Cost' }, { label: 'Assigned To' }, { label: 'Notes / Receipt' }, { label: 'Actions', cls: 'num' }],
    rows,
    { scroll: true }
  );

  qs('#task-active-only', body).onchange = (e) => {
    location.hash = `#/vehicledocuments?tab=tasks&active_only=${e.target.checked ? '1' : '0'}&stage=${encodeURIComponent(qs('#task-stage-filter', body).value)}`;
  };
  qs('#task-stage-filter', body).onchange = (e) => {
    location.hash = `#/vehicledocuments?tab=tasks&active_only=${qs('#task-active-only', body).checked ? '1' : '0'}&stage=${encodeURIComponent(e.target.value)}`;
  };

  qsa('.btn-task-edit', body).forEach((btn) => {
    btn.onclick = () => showUpdateRenewalTaskModal(btn.dataset.id, () => renderVdocTasks(body, sp));
  });
  qsa('.btn-task-hist', body).forEach((btn) => {
    btn.onclick = () => showDocumentHistoryModal(btn.dataset.id, btn.dataset.name);
  });
}

async function showErlChecklistModal(assetId, assetName) {
  let erl;
  try {
    erl = await api('/assets/' + assetId + '/erl-checklist');
  } catch (e) {
    return toast(e.message, 'err');
  }

  const alertBox = erl.ready_for_renewal
    ? `<div style="padding:12px 16px;background:rgba(46,125,50,0.12);border:1px solid var(--green);border-radius:6px;color:var(--green);font-weight:600;margin-bottom:14px">
        ✅ All prerequisite documents verified! Eligible for DMT Electronic Revenue Licence (eRL) online renewal.
       </div>`
    : `<div style="padding:12px 16px;background:rgba(198,40,40,0.1);border:1px solid var(--red);border-radius:6px;color:var(--red);margin-bottom:14px">
        <div style="font-weight:700">⚠️ eRL Online Renewal Prerequisites Incomplete:</div>
        <ul style="margin:6px 0 0 18px;font-size:13px">${(erl.blockers || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
       </div>`;

  const windowBox = `
    <div class="card" style="margin-bottom:14px;padding:12px 14px;background:var(--surface)">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <b>1-Calendar-Month Renewal Window</b>
          <div class="muted" style="font-size:12px">Motor Traffic Act: Annual Revenue Licence can only be renewed within one calendar month of expiration.</div>
        </div>
        <div>
          <span class="badge blue">Target Date: ${esc(String(erl.evaluated_at || '').slice(0, 10))}</span>
        </div>
      </div>
    </div>`;

  const rows = (erl.items || []).map((it) => {
    const badge = it.passed
      ? '<span class="badge green">Pass</span>'
      : (it.required ? '<span class="badge red">Action Required</span>' : '<span class="badge">Optional</span>');

    return `<tr>
      <td><b>${esc(it.label)}</b> ${it.required ? '<span class="badge blue" style="font-size:10px;margin-left:4px">Mandatory</span>' : '<span class="muted" style="font-size:10px">Optional</span>'}</td>
      <td>${badge}</td>
      <td style="font-size:13px">${esc(it.details || '—')}</td>
    </tr>`;
  });

  const bodyHtml = alertBox + windowBox + tableWrap(
    [{ label: 'Prerequisite Requirement' }, { label: 'Status' }, { label: 'Verification Details' }],
    rows,
    { scroll: true }
  ) + `<div style="margin-top:16px;text-align:right"><button class="primary" id="btn-erl-close">Close</button></div>`;

  modal(`eRL Renewal Readiness · ${assetName || ('Asset #' + assetId)}`, bodyHtml, (body, close) => {
    qs('#btn-erl-close', body).onclick = close;
  }, { wide: true });
}

async function showRenewDocumentModal(docId, docName, onDone) {
  let doc;
  try {
    doc = await api('/vehicle-documents/' + docId);
  } catch (e) {
    return toast(e.message, 'err');
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const nextYear = new Date();
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  const nextYearStr = nextYear.toISOString().slice(0, 10);

  const bodyHtml = `
    <p class="muted" style="margin-top:0">Vehicle: <b>${esc(doc.asset_code || '')}</b> ${doc.registration ? `[${esc(doc.registration)}]` : ''} · Category: <b>${esc(doc.doc_type_category || '')}</b></p>
    <div class="row">
      ${field('Document / Certificate No *', 'doc_number', { placeholder: 'e.g. RL-2026-992 or POL-88123' })}
      ${field('Issuing Authority / Company', 'issuer_name', { placeholder: 'e.g. DMT Western Province / SLIC / DriveGreen' })}
    </div>
    <div class="row">
      ${field('Issue Date', 'issue_date', { type: 'date', value: todayStr })}
      ${field('Valid From', 'valid_from', { type: 'date', value: todayStr })}
    </div>
    <div class="row">
      ${field('Valid Until *', 'valid_until', { type: 'date', value: nextYearStr })}
      ${field('Cost / Fee (LKR)', 'cost_amount', { type: 'number', placeholder: '0' })}
    </div>
    ${field('Notes / Policy Details', 'notes', { type: 'textarea', placeholder: 'e.g. Annual renewal cover note' })}
    <div style="margin-top:10px">
      <label>Certificate / Cover Note Scan (PDF, Image)</label>
      <input type="file" id="renewal_scan_file" accept=".pdf,image/*" style="margin-top:4px">
      <div class="muted" style="font-size:11px;margin-top:2px">Supported: PDF, JPG, PNG (Max 15 MB)</div>
    </div>
    ${canDo('vehicle_docs.verify') ? `
      <div style="margin-top:12px;padding:8px 12px;background:rgba(46,125,50,0.08);border-radius:6px">
        <label style="display:flex;align-items:center;gap:8px;flex-direction:row;font-size:13px;width:auto;cursor:pointer">
          <input type="checkbox" name="fast_track" checked style="width:auto"> ⚡ Fast-track Manager Verification (immediately promote to active coverage)
        </label>
      </div>` : ''}
    <div style="margin-top:16px;text-align:right">
      <button class="primary" id="btn-submit-renewal">Submit Renewal</button>
    </div>`;

  modal(`Submit Renewal · ${docName}`, bodyHtml, (body, close) => {
    qs('#btn-submit-renewal', body).onclick = async () => {
      const f = formData(body);
      if (!f.doc_number || !f.doc_number.trim()) return toast('Document / Certificate number is required', 'err');
      if (!f.valid_until) return toast('Valid until expiration date is required', 'err');

      const fileInput = qs('#renewal_scan_file', body);
      const file = fileInput && fileInput.files && fileInput.files[0];

      let filePayload = null;
      if (file) {
        if (file.size > 15 * 1024 * 1024) return toast('File size exceeds 15 MB limit', 'err');
        try {
          filePayload = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res({ dataUrl: reader.result, originalFilename: file.name, mimeType: file.type });
            reader.onerror = rej;
            reader.readAsDataURL(file);
          });
        } catch (e) {
          return toast('Could not read scan file: ' + e.message, 'err');
        }
      }

      const payload = {
        doc_number: f.doc_number.trim(),
        issuer_name: f.issuer_name ? f.issuer_name.trim() : null,
        issue_date: f.issue_date || todayStr,
        valid_from: f.valid_from || todayStr,
        valid_until: f.valid_until,
        cost_amount: f.cost_amount ? Number(f.cost_amount) : 0,
        notes: f.notes ? f.notes.trim() : null,
      };

      try {
        const ver = await api(`/vehicle-documents/${docId}/versions`, { method: 'POST', body: payload });
        if (filePayload && ver && ver.id) {
          await api(`/vehicle-documents/versions/${ver.id}/attachments`, {
            method: 'POST',
            body: {
              dataUrl: filePayload.dataUrl,
              originalFilename: filePayload.originalFilename,
              mimeType: filePayload.mimeType,
              kind: 'certificate'
            }
          });
        }
        if (f.fast_track && canDo('vehicle_docs.verify') && ver && ver.id) {
          await api(`/vehicle-documents/versions/${ver.id}/verify`, {
            method: 'POST',
            body: { decision: 'approve', notes: 'Fast-track verification on renewal submission' }
          });
        }
        toast('Renewal version submitted successfully');
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
}

async function showDocumentHistoryModal(docId, docName) {
  let doc, history;
  try {
    [doc, history] = await Promise.all([
      api('/vehicle-documents/' + docId),
      api('/vehicle-documents/' + docId + '/history'),
    ]);
  } catch (e) {
    return toast(e.message, 'err');
  }

  const containerInfo = `
    <div style="margin-bottom:14px;padding:10px 14px;background:var(--surface);border-radius:6px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div>
        <b>${esc(doc.doc_type_name || docName)}</b> · Vehicle: <b>${esc(doc.asset_code || '')}</b> ${doc.registration ? `[${esc(doc.registration)}]` : ''}
        <div class="muted" style="font-size:12px">Category: ${esc(doc.doc_type_category || '')} · Mandatory: ${doc.is_required ? 'Yes' : 'No'}</div>
      </div>
      <div>
        ${doc.is_exempt ? `<span class="badge" style="background:var(--border)">Exempt: ${esc(doc.exemption_reason || 'Off-road / Laid up')}</span>` : '<span class="badge green">Active Tracking</span>'}
      </div>
    </div>`;

  const rows = (history || []).map((v) => {
    const isCurrent = doc.current_version_id === v.id;
    const stBadge = v.status === 'verified'
      ? `<span class="badge green">Verified${isCurrent ? ' (Active)' : ''}</span>`
      : (v.status === 'pending_verification'
          ? '<span class="badge amber">Pending Verification</span>'
          : (v.status === 'superseded' ? '<span class="badge">Superseded</span>' : '<span class="badge">' + esc(v.status) + '</span>'));

    const attList = (v.attachments || []).map((att) => `
      <a href="/api/vehicle-documents/attachments/${att.id}/download" target="_blank" class="btn sm" style="text-decoration:none;padding:2px 8px;font-size:11px;margin:2px" title="SHA-256: ${esc(att.sha256 || '')}">
        📄 ${esc(att.original_filename)} (${Math.round(att.file_size / 1024)} KB)
      </a>
    `).join(' ');

    const verifyActions = (v.status === 'pending_verification' && canDo('vehicle_docs.verify')) ? `
      <div style="margin-top:4px">
        <button class="sm green btn-ver-approve" data-id="${v.id}" style="padding:2px 8px;font-size:11px">Approve</button>
        <button class="sm red btn-ver-reject" data-id="${v.id}" style="padding:2px 8px;font-size:11px">Reject</button>
      </div>` : '';

    return `<tr>
      <td><b>v${v.version_no}</b></td>
      <td><code>${esc(v.doc_number)}</code></td>
      <td>${esc(v.valid_from || '—')} → <b>${esc(v.valid_until)}</b></td>
      <td>${esc(v.issuer_name || '—')}</td>
      <td>
        ${stBadge}
        ${v.verified_by_name ? `<div class="muted" style="font-size:11px">By ${esc(v.verified_by_name)} on ${String(v.verified_at || '').slice(0, 10)}</div>` : ''}
        ${v.verification_notes ? `<div class="muted" style="font-size:11px">Note: ${esc(v.verification_notes)}</div>` : ''}
        ${verifyActions}
      </td>
      <td>${attList || '<span class="muted" style="font-size:11px">No scans attached</span>'}</td>
      <td>${v.cost_amount ? money(v.cost_amount) : '—'}</td>
    </tr>`;
  });

  const bodyHtml = containerInfo + tableWrap(
    [{ label: 'Ver' }, { label: 'Certificate No' }, { label: 'Validity Period' }, { label: 'Issuer' }, { label: 'Verification Status' }, { label: 'Attached Scans' }, { label: 'Cost' }],
    rows,
    { scroll: true }
  ) + `<div style="margin-top:14px;text-align:right"><button class="primary" id="btn-hist-close">Close</button></div>`;

  modal(`Version History & Audits · ${docName}`, bodyHtml, (body, close) => {
    qs('#btn-hist-close', body).onclick = close;

    qsa('.btn-ver-approve', body).forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/vehicle-documents/versions/${btn.dataset.id}/verify`, { method: 'POST', body: { decision: 'approve', notes: 'Approved by Manager' } });
          toast('Version verified and promoted');
          close();
          showDocumentHistoryModal(docId, docName);
        } catch (e) { toast(e.message, 'err'); }
      };
    });

    qsa('.btn-ver-reject', body).forEach((btn) => {
      btn.onclick = async () => {
        const reason = prompt('Reason for rejection:');
        if (reason === null) return;
        try {
          await api(`/vehicle-documents/versions/${btn.dataset.id}/verify`, { method: 'POST', body: { decision: 'reject', notes: reason } });
          toast('Version rejected');
          close();
          showDocumentHistoryModal(docId, docName);
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }, { wide: true });
}

function showDocumentExemptionModal(docId, docName, isCurrentlyExempt, onDone) {
  if (isCurrentlyExempt) {
    modal(`Re-activate Statutory Monitoring · ${docName}`, `
      <p>This statutory requirement is currently marked <b>EXEMPT</b> (laid-up / off-road fleet).</p>
      <p>Re-activating will restore statutory compliance tracking, expiration countdowns, and renewal reminders.</p>
      <div style="margin-top:16px;text-align:right">
        <button class="primary" id="btn-confirm-unexempt">Confirm Re-activation</button>
      </div>`, (body, close) => {
      qs('#btn-confirm-unexempt', body).onclick = async () => {
        try {
          await api(`/vehicle-documents/${docId}/exemption`, { method: 'PUT', body: { isExempt: false } });
          toast('Statutory monitoring re-activated');
          close();
          if (onDone) onDone();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  } else {
    modal(`Exempt Statutory Requirement · ${docName}`, `
      <p class="muted" style="margin-top:0">Exempting this requirement indicates the vehicle is formally laid up in the workshop for major overhaul or operated strictly off-road. Expiration alerts will be paused.</p>
      ${field('Reason for Exemption *', 'reason', { placeholder: 'e.g. Laid up in workshop for major engine overhaul' })}
      <div style="margin-top:16px;text-align:right">
        <button class="primary" id="btn-confirm-exempt">Confirm Exemption</button>
      </div>`, (body, close) => {
      qs('#btn-confirm-exempt', body).onclick = async () => {
        const r = (formData(body).reason || '').trim();
        if (!r) return toast('Please specify an exemption reason', 'err');
        try {
          await api(`/vehicle-documents/${docId}/exemption`, { method: 'PUT', body: { isExempt: true, reason: r } });
          toast('Vehicle document requirement marked exempt');
          close();
          if (onDone) onDone();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }
}

async function showUpdateRenewalTaskModal(taskId, onDone) {
  let tasks;
  try {
    tasks = await api('/vehicle-documents/tasks');
  } catch (e) {
    return toast(e.message, 'err');
  }
  const task = tasks.find((t) => String(t.id) === String(taskId));
  if (!task) return toast('Task not found', 'err');

  const STAGES = [
    { value: 'assigned', label: 'Assigned' },
    { value: 'application_submitted', label: 'Application Submitted' },
    { value: 'pending_verification', label: 'Pending Verification' },
    { value: 'completed', label: 'Completed' },
  ];

  const bodyHtml = `
    <p class="muted" style="margin-top:0">Vehicle: <b>${esc(task.asset_code)}</b> ${task.registration ? `[${esc(task.registration)}]` : ''} · <b>${esc(task.doc_type_name)}</b></p>
    <div class="row">
      ${field('Workflow Stage', 'stage', { type: 'select', options: STAGES, value: task.stage })}
      ${field('Target Completion Date', 'target_date', { type: 'date', value: task.target_date || '' })}
    </div>
    <div class="row">
      ${field('Estimated Cost (LKR)', 'estimated_cost', { type: 'number', value: task.estimated_cost || '' })}
      ${field('Actual Cost (LKR)', 'actual_cost', { type: 'number', value: task.actual_cost || '' })}
    </div>
    ${field('Temporary Receipt No', 'temporary_receipt_no', { placeholder: 'e.g. RCP-DMT-12345', value: task.temporary_receipt_no || '' })}
    ${field('Notes', 'notes', { type: 'textarea', value: task.notes || '' })}
    <div style="margin-top:16px;text-align:right">
      <button class="primary" id="btn-save-task">Update Task</button>
    </div>`;

  modal(`Update Renewal Task #${taskId}`, bodyHtml, (body, close) => {
    qs('#btn-save-task', body).onclick = async () => {
      const f = formData(body);
      try {
        await api(`/vehicle-documents/tasks/${taskId}`, {
          method: 'PUT',
          body: {
            stage: f.stage,
            target_date: f.target_date || null,
            estimated_cost: f.estimated_cost ? Number(f.estimated_cost) : null,
            actual_cost: f.actual_cost ? Number(f.actual_cost) : null,
            temporary_receipt_no: f.temporary_receipt_no ? f.temporary_receipt_no.trim() : null,
            notes: f.notes ? f.notes.trim() : null,
          }
        });
        toast('Renewal task updated');
        close();
        if (onDone) onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}
