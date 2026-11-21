'use strict';
// ===========================================================================
// CCOM Outsourced Service & Repair Requests UI Subsystem
// ===========================================================================

function outsourcingStatusBadge(s) {
  const map = {
    draft: ['Draft', ''],
    pending_approval: ['Pending Review', 'amber'],
    returned: ['Returned for Correction', 'red'],
    approved: ['Approved & Signed', 'green'],
    sent: ['Sent to C.COM', 'blue'],
    acknowledged: ['Acknowledged by C.COM', 'blue'],
    in_progress: ['Work in Progress', 'violet'],
    completed: ['Work Verified', 'green'],
    closed: ['Closed (Cost Posted)', 'teal'],
    cancelled: ['Cancelled', '']
  };
  const [label, color] = map[s] || [s || '—', ''];
  return `<span class="badge ${color}">${esc(label)}</span>`;
}

function renderOutsourcingJobSectionHtml(job, reqs = []) {
  const isClosed = job.status === 'CLOSED';
  const canCreate = canDo('outsourcing.create') && !isClosed;
  const count = reqs.length;

  return `
    <div class="card section" id="outsourcing-section" style="border-left:4px solid var(--blue, #2563eb)">
      <div class="toolbar" style="margin:0 0 8px">
        <div style="display:flex;align-items:center;gap:8px">
          <h3 style="margin:0">⚙️ C.COM Outsourced Service &amp; Repairs</h3>
          <span class="badge ${count > 0 ? 'blue' : ''}">${count}</span>
        </div>
        <div class="spacer"></div>
        ${canCreate ? '<button class="sm primary" id="btn-new-ccom-req">+ New C.COM Request</button>' : ''}
      </div>
      <p class="muted" style="margin:0 0 12px;font-size:12.5px">
        Authorised equipment repairs and component overhauls sent to <b>C.COM</b> with dual electronic signatures (Storekeeper + Mechanical Engineer) and PDF generation.
        Verified invoice cost posts directly to <b>External Cost</b> upon completion.
      </p>
      ${!reqs.length ? `
        <div style="text-align:center;padding:16px;background:rgba(0,0,0,0.02);border:1px dashed var(--border);border-radius:8px" class="muted">
          No external C.COM requests attached to this job card yet.
          ${canCreate ? '<div style="margin-top:6px"><button class="sm" id="btn-new-ccom-req-empty">+ Raise C.COM Request</button></div>' : ''}
        </div>
      ` : tableWrap([
        { label: 'Ref / Rev' },
        { label: 'Type & Priority' },
        { label: 'Work Items / Contact' },
        { label: 'Engineer' },
        { label: 'Status' },
        { label: 'Cost Status', num: true },
        { label: 'Actions' }
      ], reqs.map((r) => {
        const canApprove = (canDo('outsourcing.approve') || isAdmin()) && r.status === 'pending_approval' && r.created_by !== (ME && ME.id);
        const canEditDraft = (canDo('outsourcing.edit_draft') || isAdmin()) && ['draft', 'returned'].includes(r.status);
        const canSubmit = (canDo('outsourcing.create') || canDo('outsourcing.edit_draft') || isAdmin()) && ['draft', 'returned'].includes(r.status);
        const canSend = (canDo('outsourcing.send') || isAdmin()) && ['approved', 'sent'].includes(r.status);
        const canVerify = (canDo('outsourcing.verify_completion') || canDo('outsourcing.approve') || isAdmin()) && ['sent', 'acknowledged', 'in_progress'].includes(r.status);
        const canPostCost = (canDo('outsourcing.cost.post') || isAdmin()) && ['approved', 'sent', 'acknowledged', 'in_progress', 'completed'].includes(r.status) && r.status !== 'closed';
        const canCancel = (canDo('outsourcing.cancel') || isAdmin()) && !['closed', 'cancelled'].includes(r.status);
        const isApprovedOrPast = ['approved', 'sent', 'acknowledged', 'in_progress', 'completed', 'closed'].includes(r.status);

        const actions = [];
        actions.push(`<button class="sm" data-os-view="${r.id}" title="View details">👁️ View</button>`);
        if (canEditDraft) {
          actions.push(`<button class="sm" data-os-edit="${r.id}" title="Edit request">✏️ Edit</button>`);
        }
        if (canSubmit) {
          actions.push(`<button class="sm primary" data-os-submit="${r.id}" title="Submit to Engineer">📤 Submit</button>`);
        }
        actions.push(`<button class="sm" data-os-preview="${r.id}" title="Preview Letterhead">📄 Preview</button>`);
        if (isApprovedOrPast) {
          actions.push(`<a class="btn sm" href="/api/outsourcing/requests/${r.id}/pdf" target="_blank" title="Download official signed PDF">⬇️ PDF</a>`);
        }
        if (canApprove) {
          actions.push(`<button class="sm primary" data-os-review="${r.id}" style="background:#059669;border-color:#059669" title="Engineer review & e-sign">✍️ E-Sign</button>`);
        }
        if (canSend) {
          actions.push(`<button class="sm" data-os-email="${r.id}" title="Email to C.COM">✉️ Email</button>`);
        }
        if (['sent', 'acknowledged', 'in_progress'].includes(r.status)) {
          actions.push(`<button class="sm" data-os-progress="${r.id}" title="Update progress">🔄 Progress</button>`);
        }
        if (canVerify) {
          actions.push(`<button class="sm" data-os-verify="${r.id}" style="color:#059669" title="Verify completed work">✅ Verify</button>`);
        }
        if (canPostCost) {
          actions.push(`<button class="sm primary" data-os-cost="${r.id}" style="background:#7c3aed;border-color:#7c3aed" title="Post actual invoice cost">💰 Post Cost</button>`);
        }
        if (canCancel) {
          actions.push(`<button class="sm danger" data-os-cancel="${r.id}" title="Cancel request">✕</button>`);
        }

        const prioBadge = r.priority === 'critical' ? '<span class="badge red">Critical</span>' : (r.priority === 'high' ? '<span class="badge amber">High</span>' : '<span class="badge">Routine</span>');
        const costHtml = r.posted_invoice_amount
          ? `<b style="color:var(--green)">${money(r.posted_invoice_amount)}</b><div class="muted" style="font-size:11px">Inv: ${esc(r.posted_invoice_no || '—')}</div>`
          : `<span class="muted" style="font-size:12px">Rs 0.00 (Pending)</span>`;

        return `<tr>
          <td>
            <b>${esc(r.ref_no || '(Draft)')}</b>
            <div class="muted" style="font-size:11px">Rev ${r.version || 1} · ${esc((r.created_at || '').slice(0, 10))}</div>
          </td>
          <td>
            <span class="badge" style="text-transform:capitalize">${esc((r.request_type || 'repair').replace(/_/g, ' '))}</span>
            <div style="margin-top:2px">${prioBadge}</div>
          </td>
          <td>
            <b>${esc(r.contact_name || 'C.COM')}</b>
            <div class="muted" style="font-size:11px">${esc(r.informed_by ? 'Informed by ' + r.informed_by : '')}</div>
          </td>
          <td>
            ${esc(r.assigned_engineer_name || 'Unassigned')}
          </td>
          <td>
            ${outsourcingStatusBadge(r.status)}
            ${r.status === 'returned' ? '<div style="font-size:11px;color:var(--red);margin-top:2px">Needs revision</div>' : ''}
          </td>
          <td class="num">
            ${costHtml}
          </td>
          <td>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              ${actions.join('')}
            </div>
          </td>
        </tr>`;
      }), { scroll: true })}
    </div>
  `;
}

function renderOutsourcingServiceSectionHtml(service, reqs = []) {
  const count = reqs.length;
  const canCreate = canDo('outsourcing.create');

  return `
    <div class="card section" id="outsourcing-section" style="border-left:4px solid var(--blue, #2563eb)">
      <div class="toolbar" style="margin:0 0 8px">
        <div style="display:flex;align-items:center;gap:8px">
          <h3 style="margin:0">⚙️ C.COM Outsourced Service &amp; Specialist Work</h3>
          <span class="badge ${count > 0 ? 'blue' : ''}">${count}</span>
        </div>
        <div class="spacer"></div>
        ${canCreate ? '<button class="sm primary" id="btn-new-ccom-req">+ New C.COM Request</button>' : ''}
      </div>
      <p class="muted" style="margin:0 0 12px;font-size:12.5px">
        Official C.COM equipment repairs and periodic service requests linked to this Service Record.
        Verified invoice cost posts directly to <b>Outside Estimate / Grand Total</b> upon completion.
      </p>
      ${!reqs.length ? `
        <div style="text-align:center;padding:16px;background:rgba(0,0,0,0.02);border:1px dashed var(--border);border-radius:8px" class="muted">
          No external C.COM requests attached to this service record yet.
          ${canCreate ? '<div style="margin-top:6px"><button class="sm" id="btn-new-ccom-req-empty">+ Raise C.COM Request</button></div>' : ''}
        </div>
      ` : tableWrap([
        { label: 'Ref / Rev' },
        { label: 'Type & Priority' },
        { label: 'Contact' },
        { label: 'Engineer' },
        { label: 'Status' },
        { label: 'Cost Status', num: true },
        { label: 'Actions' }
      ], reqs.map((r) => {
        const canApprove = (canDo('outsourcing.approve') || isAdmin()) && r.status === 'pending_approval' && r.created_by !== (ME && ME.id);
        const canEditDraft = (canDo('outsourcing.edit_draft') || isAdmin()) && ['draft', 'returned'].includes(r.status);
        const canSubmit = (canDo('outsourcing.create') || canDo('outsourcing.edit_draft') || isAdmin()) && ['draft', 'returned'].includes(r.status);
        const canSend = (canDo('outsourcing.send') || isAdmin()) && ['approved', 'sent'].includes(r.status);
        const canVerify = (canDo('outsourcing.verify_completion') || canDo('outsourcing.approve') || isAdmin()) && ['sent', 'acknowledged', 'in_progress'].includes(r.status);
        const canPostCost = (canDo('outsourcing.cost.post') || isAdmin()) && ['approved', 'sent', 'acknowledged', 'in_progress', 'completed'].includes(r.status) && r.status !== 'closed';
        const canCancel = (canDo('outsourcing.cancel') || isAdmin()) && !['closed', 'cancelled'].includes(r.status);
        const isApprovedOrPast = ['approved', 'sent', 'acknowledged', 'in_progress', 'completed', 'closed'].includes(r.status);

        const actions = [];
        actions.push(`<button class="sm" data-os-view="${r.id}" title="View details">👁️ View</button>`);
        if (canEditDraft) {
          actions.push(`<button class="sm" data-os-edit="${r.id}" title="Edit request">✏️ Edit</button>`);
        }
        if (canSubmit) {
          actions.push(`<button class="sm primary" data-os-submit="${r.id}" title="Submit to Engineer">📤 Submit</button>`);
        }
        actions.push(`<button class="sm" data-os-preview="${r.id}" title="Preview Letterhead">📄 Preview</button>`);
        if (isApprovedOrPast) {
          actions.push(`<a class="btn sm" href="/api/outsourcing/requests/${r.id}/pdf" target="_blank" title="Download official signed PDF">⬇️ PDF</a>`);
        }
        if (canApprove) {
          actions.push(`<button class="sm primary" data-os-review="${r.id}" style="background:#059669;border-color:#059669" title="Engineer review & e-sign">✍️ E-Sign</button>`);
        }
        if (canSend) {
          actions.push(`<button class="sm" data-os-email="${r.id}" title="Email to C.COM">✉️ Email</button>`);
        }
        if (['sent', 'acknowledged', 'in_progress'].includes(r.status)) {
          actions.push(`<button class="sm" data-os-progress="${r.id}" title="Update progress">🔄 Progress</button>`);
        }
        if (canVerify) {
          actions.push(`<button class="sm" data-os-verify="${r.id}" style="color:#059669" title="Verify completed work">✅ Verify</button>`);
        }
        if (canPostCost) {
          actions.push(`<button class="sm primary" data-os-cost="${r.id}" style="background:#7c3aed;border-color:#7c3aed" title="Post actual invoice cost">💰 Post Cost</button>`);
        }
        if (canCancel) {
          actions.push(`<button class="sm danger" data-os-cancel="${r.id}" title="Cancel request">✕</button>`);
        }

        const prioBadge = r.priority === 'critical' ? '<span class="badge red">Critical</span>' : (r.priority === 'high' ? '<span class="badge amber">High</span>' : '<span class="badge">Routine</span>');
        const costHtml = r.posted_invoice_amount
          ? `<b style="color:var(--green)">${money(r.posted_invoice_amount)}</b><div class="muted" style="font-size:11px">Inv: ${esc(r.posted_invoice_no || '—')}</div>`
          : `<span class="muted" style="font-size:12px">Rs 0.00 (Pending)</span>`;

        return `<tr>
          <td>
            <b>${esc(r.ref_no || '(Draft)')}</b>
            <div class="muted" style="font-size:11px">Rev ${r.version || 1} · ${esc((r.created_at || '').slice(0, 10))}</div>
          </td>
          <td>
            <span class="badge" style="text-transform:capitalize">${esc((r.request_type || 'repair').replace(/_/g, ' '))}</span>
            <div style="margin-top:2px">${prioBadge}</div>
          </td>
          <td>
            <b>${esc(r.contact_name || 'C.COM')}</b>
          </td>
          <td>
            ${esc(r.assigned_engineer_name || 'Unassigned')}
          </td>
          <td>
            ${outsourcingStatusBadge(r.status)}
            ${r.status === 'returned' ? '<div style="font-size:11px;color:var(--red);margin-top:2px">Needs revision</div>' : ''}
          </td>
          <td class="num">
            ${costHtml}
          </td>
          <td>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              ${actions.join('')}
            </div>
          </td>
        </tr>`;
      }), { scroll: true })}
    </div>
  `;
}

function wireOutsourcingSection(c, ctx) {
  const root = qs('#outsourcing-section', c) || c;
  const onNew = () => openNewOutsourcingModal(ctx, ctx.onRefresh);

  if (qs('#btn-new-ccom-req', root)) qs('#btn-new-ccom-req', root).onclick = onNew;
  if (qs('#btn-new-ccom-req-empty', root)) qs('#btn-new-ccom-req-empty', root).onclick = onNew;

  qsa('[data-os-view]', root).forEach((b) => b.onclick = () => openOutsourcingDetailModal(b.dataset.osView, ctx.onRefresh));
  qsa('[data-os-edit]', root).forEach((b) => b.onclick = () => openEditOutsourcingModal(b.dataset.osEdit, ctx.onRefresh));
  qsa('[data-os-submit]', root).forEach((b) => b.onclick = async () => {
    if (!confirm('Submit this C.COM request to the assigned Mechanical Engineer for review & approval?')) return;
    try {
      const res = await api(`/outsourcing/requests/${b.dataset.osSubmit}/submit`, { method: 'POST' });
      toast(`✓ Submitted! Allocated Reference ${res.ref_no}`);
      if (ctx.onRefresh) ctx.onRefresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  qsa('[data-os-preview]', root).forEach((b) => b.onclick = () => openOutsourcingPreviewModal(b.dataset.osPreview));
  qsa('[data-os-review]', root).forEach((b) => b.onclick = () => openOutsourcingReviewModal(b.dataset.osReview, ctx.onRefresh));
  qsa('[data-os-email]', root).forEach((b) => b.onclick = () => openOutsourcingEmailModal(b.dataset.osEmail, ctx.onRefresh));
  qsa('[data-os-progress]', root).forEach((b) => b.onclick = () => openOutsourcingProgressModal(b.dataset.osProgress, ctx.onRefresh));
  qsa('[data-os-verify]', root).forEach((b) => b.onclick = () => openOutsourcingVerifyModal(b.dataset.osVerify, ctx.onRefresh));
  qsa('[data-os-cost]', root).forEach((b) => b.onclick = () => openOutsourcingCostModal(b.dataset.osCost, ctx.onRefresh));
  qsa('[data-os-cancel]', root).forEach((b) => b.onclick = () => openOutsourcingCancelModal(b.dataset.osCancel, ctx.onRefresh));
}

async function jobsOutsourcing(body, sp) {
  let reqs = [];
  try {
    const res = await api('/outsourcing/requests');
    reqs = res.requests || [];
  } catch (err) {
    body.innerHTML = `<div class="card err">${esc(err.message)}</div>`;
    return;
  }

  const curStatus = sp.get('status') || 'all';
  const filtered = curStatus === 'all' ? reqs : reqs.filter((r) => r.status === curStatus);

  const pendingCount = reqs.filter((r) => r.status === 'pending_approval').length;
  const sentCount = reqs.filter((r) => ['sent', 'acknowledged', 'in_progress'].includes(r.status)).length;
  const completedCount = reqs.filter((r) => r.status === 'completed').length;
  const closedCount = reqs.filter((r) => r.status === 'closed').length;

  body.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;margin-bottom:14px">
      <a class="card stat" href="#/jobs?tab=outsourcing&status=all" style="text-decoration:none">
        <span class="n">${reqs.length}</span>
        <span class="l">All Requests</span>
      </a>
      <a class="card stat" href="#/jobs?tab=outsourcing&status=pending_approval" style="text-decoration:none">
        <span class="n" style="color:var(--amber)">${pendingCount}</span>
        <span class="l">Pending Engineer Review</span>
      </a>
      <a class="card stat" href="#/jobs?tab=outsourcing&status=in_progress" style="text-decoration:none">
        <span class="n" style="color:var(--blue)">${sentCount}</span>
        <span class="l">At C.COM / In Progress</span>
      </a>
      <a class="card stat" href="#/jobs?tab=outsourcing&status=completed" style="text-decoration:none">
        <span class="n" style="color:var(--green)">${completedCount}</span>
        <span class="l">Work Verified (Awaiting Invoice)</span>
      </a>
    </div>

    <div class="card section">
      <div class="toolbar" style="margin:0 0 10px">
        <h3 style="margin:0">C.COM Equipment Outsourcing Register</h3>
        <div class="spacer"></div>
        <div class="pill-row">
          <a class="btn sm ${curStatus === 'all' ? 'primary' : ''}" href="#/jobs?tab=outsourcing&status=all">All (${reqs.length})</a>
          <a class="btn sm ${curStatus === 'pending_approval' ? 'primary' : ''}" href="#/jobs?tab=outsourcing&status=pending_approval">Pending Engineer (${pendingCount})</a>
          <a class="btn sm ${curStatus === 'in_progress' ? 'primary' : ''}" href="#/jobs?tab=outsourcing&status=in_progress">Active at C.COM (${sentCount})</a>
          <a class="btn sm ${curStatus === 'completed' ? 'primary' : ''}" href="#/jobs?tab=outsourcing&status=completed">Verified (${completedCount})</a>
          <a class="btn sm ${curStatus === 'closed' ? 'primary' : ''}" href="#/jobs?tab=outsourcing&status=closed">Closed (${closedCount})</a>
        </div>
      </div>

      <div id="outsourcing-table-wrap">
        ${renderOutsourcingJobSectionHtml({ status: 'OPEN' }, filtered)}
      </div>
    </div>
  `;

  wireOutsourcingSection(body, { onRefresh: () => jobsOutsourcing(body, sp) });
}

async function openNewOutsourcingModal(ctx, onDone) {
  let vData = { vendors: [] };
  let users = [];
  let openJobs = [];
  try {
    vData = await api('/outsourcing/vendors');
    users = await api('/users').catch(() => []);
    if (!ctx.repairJobId && !ctx.serviceRecordId) {
      const jRes = await api('/jobs?open=1&limit=50').catch(() => []);
      openJobs = Array.isArray(jRes) ? jRes : (jRes.jobs || []);
    }
  } catch (err) {
    console.error(err);
  }

  const vendors = vData.vendors || [];
  const ccom = vendors.find((v) => v.code === 'CCOM') || vendors[0] || { id: 1, name: 'C.COM Engineering (Pvt) Ltd', contacts: [] };
  const contacts = ccom.contacts || [];

  const engineers = users.filter((u) => u.active !== 0 && (
    (u.roles || []).some((r) => ['mechanical_engineer', 'engineer', 'workshop', 'operational_manager', 'manager', 'admin'].includes(r))
    || (u.role && ['mechanical_engineer', 'engineer', 'workshop', 'operational_manager', 'manager', 'admin'].includes(u.role))
  ));

  const engineerOptions = engineers.map((u) => ({
    value: u.id,
    label: `${u.full_name || u.username} (${(u.roles || [u.role || '']).join(', ')})`
  }));

  const vendorOptions = vendors.map((v) => ({ value: v.id, label: `${v.code} — ${v.name}` }));
  const contactOptions = contacts.map((c) => ({ value: c.id, label: `${c.contact_name} (${c.email || c.phone || 'Service'})` }));

  const defaultDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

  const parentJobHtml = (!ctx.repairJobId && !ctx.serviceRecordId) ? `
    <div class="field" style="margin-bottom:12px">
      ${field('Parent Repair Job Card *', 'repair_job_id', {
        type: 'select',
        options: [
          { value: '', label: '— Select Active Job Card —' },
          ...openJobs.map((j) => ({
            value: j.id,
            label: `${j.job_no} — ${j.asset_reg || j.asset_code || ('Asset #' + j.asset_id)} (${j.status || 'OPEN'})`
          }))
        ]
      })}
    </div>
  ` : '';

  const html = `
    ${parentJobHtml}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field">
        ${field('Vendor', 'vendor_id', { type: 'select', options: vendorOptions, value: ccom.id })}
      </div>
      <div class="field">
        ${field('Vendor Contact', 'vendor_contact_id', { type: 'select', options: contactOptions, value: contacts[0]?.id })}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px">
      <div class="field">
        ${field('Assigned Mechanical Engineer *', 'assigned_engineer_id', { type: 'select', options: [{ value: '', label: '— Select Engineer —' }, ...engineerOptions] })}
      </div>
      <div class="field">
        ${field('Request Type', 'request_type', {
          type: 'select',
          options: [
            { value: 'repair', label: 'Equipment Repair' },
            { value: 'periodic_service', label: 'Periodic Service' },
            { value: 'overhaul', label: 'Component Overhaul' },
            { value: 'inspection', label: 'Technical Inspection / Assessment' }
          ]
        })}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:6px">
      <div class="field">
        ${field('Priority', 'priority', {
          type: 'select',
          options: [
            { value: 'routine', label: 'Routine' },
            { value: 'high', label: 'High' },
            { value: 'critical', label: 'Critical / Breakdown' }
          ],
          value: 'high'
        })}
      </div>
      <div class="field">
        ${field('Required Date', 'required_date', { type: 'date', value: defaultDate })}
      </div>
      <div class="field">
        <label>Meter Reading &amp; Unit</label>
        <div style="display:flex;gap:4px">
          <input type="number" step="0.1" name="meter_reading" placeholder="e.g. 1250.0" style="flex:2">
          <select name="meter_unit" style="flex:1">
            <option value="hours">Hours</option>
            <option value="km">km</option>
          </select>
        </div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:6px">
      <div class="field">
        ${field('Site Contact Person', 'contact_name', { value: 'W.R. Malinga Livera' })}
      </div>
      <div class="field">
        ${field('Site Contact Phone', 'contact_number', { value: '075-2303039' })}
      </div>
      <div class="field">
        ${field('Informed By', 'informed_by', { placeholder: 'e.g. Driver / Site Foreman' })}
      </div>
    </div>

    <div style="margin-top:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <label style="font-weight:700;margin:0">Scope of Work / Defect Items *</label>
        <button type="button" class="sm" id="btn-add-line">+ Add Item</button>
      </div>
      <table style="width:100%;font-size:13px;border-collapse:collapse" id="tbl-lines">
        <thead>
          <tr style="background:var(--surface);border-bottom:1px solid var(--border)">
            <th style="width:36px;text-align:center">#</th>
            <th>Description of Work Required *</th>
            <th style="width:180px">Location on Machine</th>
            <th style="width:180px">Remarks</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody id="tbl-lines-body">
          <tr>
            <td style="text-align:center;color:var(--muted)">1</td>
            <td><input type="text" class="line-desc" placeholder="Specific component defect or service task" style="width:100%"></td>
            <td><input type="text" class="line-loc" placeholder="e.g. Workshop Bay 2" style="width:100%"></td>
            <td><input type="text" class="line-rem" placeholder="e.g. Pressure test required" style="width:100%"></td>
            <td style="text-align:center"><button type="button" class="sm btn-del-line" title="Remove">✕</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
      <button type="button" class="btn" id="btn-cancel">Cancel</button>
      <button type="button" class="btn" id="btn-save-draft">Save as Draft</button>
      <button type="button" class="primary" id="btn-save-submit">Save &amp; Submit for Approval</button>
    </div>
  `;

  modal('New C.COM Outsourced Request', html, (body, close) => {
    const linesBody = qs('#tbl-lines-body', body);

    const reindex = () => {
      qsa('tr', linesBody).forEach((tr, i) => {
        const cell = tr.children[0];
        if (cell) cell.textContent = String(i + 1);
      });
    };

    qs('#btn-add-line', body).onclick = () => {
      const idx = qsa('tr', linesBody).length + 1;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="text-align:center;color:var(--muted)">${idx}</td>
        <td><input type="text" class="line-desc" placeholder="Specific component defect or service task" style="width:100%"></td>
        <td><input type="text" class="line-loc" placeholder="e.g. Workshop Bay 2" style="width:100%"></td>
        <td><input type="text" class="line-rem" placeholder="e.g. Pressure test required" style="width:100%"></td>
        <td style="text-align:center"><button type="button" class="sm btn-del-line" title="Remove">✕</button></td>
      `;
      linesBody.appendChild(tr);
      qs('.btn-del-line', tr).onclick = () => { tr.remove(); reindex(); };
    };

    qsa('.btn-del-line', linesBody).forEach((b) => {
      b.onclick = (e) => {
        if (qsa('tr', linesBody).length <= 1) return toast('At least one item is required', 'err');
        e.target.closest('tr').remove();
        reindex();
      };
    });

    qs('#btn-cancel', body).onclick = close;

    const collectData = () => {
      const form = formData(body);
      const lines = [];
      qsa('tr', linesBody).forEach((tr) => {
        const desc = qs('.line-desc', tr)?.value?.trim();
        const loc = qs('.line-loc', tr)?.value?.trim();
        const rem = qs('.line-rem', tr)?.value?.trim();
        if (desc) {
          lines.push({ description: desc, location: loc || null, remarks: rem || null });
        }
      });

      if (!form.assigned_engineer_id) {
        toast('Please select an assigned Mechanical Engineer', 'err');
        return null;
      }
      if (!lines.length) {
        toast('Please enter at least one work item description', 'err');
        return null;
      }

      const payload = {
        vendor_id: Number(form.vendor_id),
        vendor_contact_id: Number(form.vendor_contact_id) || null,
        assigned_engineer_id: Number(form.assigned_engineer_id),
        request_type: form.request_type,
        priority: form.priority,
        required_date: form.required_date,
        meter_reading: form.meter_reading ? Number(form.meter_reading) : null,
        meter_unit: form.meter_unit || 'hours',
        contact_name: form.contact_name,
        contact_number: form.contact_number,
        informed_by: form.informed_by,
        lines
      };

      if (ctx.repairJobId) payload.repair_job_id = Number(ctx.repairJobId);
      else if (form.repair_job_id) payload.repair_job_id = Number(form.repair_job_id);

      if (ctx.serviceRecordId) payload.service_record_id = Number(ctx.serviceRecordId);
      else if (form.service_record_id) payload.service_record_id = Number(form.service_record_id);

      if (!payload.repair_job_id && !payload.service_record_id) {
        toast('Please select an active Job Card to link this C.COM request to', 'err');
        return null;
      }

      return payload;
    };

    qs('#btn-save-draft', body).onclick = async () => {
      const payload = collectData();
      if (!payload) return;
      try {
        await api('/outsourcing/requests', { method: 'POST', body: payload });
        toast('✓ Draft request saved');
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    qs('#btn-save-submit', body).onclick = async () => {
      const payload = collectData();
      if (!payload) return;
      try {
        const created = await api('/outsourcing/requests', { method: 'POST', body: payload });
        const sub = await api(`/outsourcing/requests/${created.id}/submit`, { method: 'POST' });
        toast(`✓ Submitted to Engineer! Allocated ${sub.ref_no}`);
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }, { wide: true });
}

async function openEditOutsourcingModal(requestId, onDone) {
  let r = null;
  let vData = { vendors: [] };
  let users = [];
  try {
    r = await api(`/outsourcing/requests/${requestId}`);
    vData = await api('/outsourcing/vendors');
    users = await api('/users').catch(() => []);
  } catch (err) {
    return toast(err.message, 'err');
  }

  const vendors = vData.vendors || [];
  const ccom = vendors.find((v) => v.id === r.vendor_id) || vendors[0] || { id: 1, name: 'C.COM', contacts: [] };
  const contacts = ccom.contacts || [];

  const engineers = users.filter((u) => u.active !== 0 && (
    (u.roles || []).some((role) => ['mechanical_engineer', 'engineer', 'workshop', 'operational_manager', 'manager', 'admin'].includes(role))
    || (u.role && ['mechanical_engineer', 'engineer', 'workshop', 'operational_manager', 'manager', 'admin'].includes(u.role))
  ));

  const engineerOptions = engineers.map((u) => ({
    value: u.id,
    label: `${u.full_name || u.username} (${(u.roles || [u.role || '']).join(', ')})`
  }));

  const vendorOptions = vendors.map((v) => ({ value: v.id, label: `${v.code} — ${v.name}` }));
  const contactOptions = contacts.map((c) => ({ value: c.id, label: `${c.contact_name} (${c.email || c.phone || 'Service'})` }));

  const html = `
    ${r.status === 'returned' ? `
      <div style="padding:10px 14px;background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;margin-bottom:12px;color:#991b1b">
        <b>Returned for Correction:</b> ${esc(r.approval_note || 'Please amend work items or details.')}
      </div>
    ` : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field">
        ${field('Vendor', 'vendor_id', { type: 'select', options: vendorOptions, value: r.vendor_id })}
      </div>
      <div class="field">
        ${field('Vendor Contact', 'vendor_contact_id', { type: 'select', options: contactOptions, value: r.vendor_contact_id })}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px">
      <div class="field">
        ${field('Assigned Mechanical Engineer *', 'assigned_engineer_id', { type: 'select', options: [{ value: '', label: '— Select Engineer —' }, ...engineerOptions], value: r.assigned_engineer_id })}
      </div>
      <div class="field">
        ${field('Request Type', 'request_type', {
          type: 'select',
          options: [
            { value: 'repair', label: 'Equipment Repair' },
            { value: 'periodic_service', label: 'Periodic Service' },
            { value: 'overhaul', label: 'Component Overhaul' },
            { value: 'inspection', label: 'Technical Inspection / Assessment' }
          ],
          value: r.request_type
        })}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:6px">
      <div class="field">
        ${field('Priority', 'priority', {
          type: 'select',
          options: [
            { value: 'routine', label: 'Routine' },
            { value: 'high', label: 'High' },
            { value: 'critical', label: 'Critical / Breakdown' }
          ],
          value: r.priority
        })}
      </div>
      <div class="field">
        ${field('Required Date', 'required_date', { type: 'date', value: r.required_date || '' })}
      </div>
      <div class="field">
        <label>Meter Reading &amp; Unit</label>
        <div style="display:flex;gap:4px">
          <input type="number" step="0.1" name="meter_reading" value="${r.meter_reading ?? ''}" style="flex:2">
          <select name="meter_unit" style="flex:1">
            <option value="hours" ${r.meter_unit === 'hours' ? 'selected' : ''}>Hours</option>
            <option value="km" ${r.meter_unit === 'km' ? 'selected' : ''}>km</option>
          </select>
        </div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:6px">
      <div class="field">
        ${field('Site Contact Person', 'contact_name', { value: r.contact_name || '' })}
      </div>
      <div class="field">
        ${field('Site Contact Phone', 'contact_number', { value: r.contact_number || '' })}
      </div>
      <div class="field">
        ${field('Informed By', 'informed_by', { value: r.informed_by || '' })}
      </div>
    </div>

    <div style="margin-top:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <label style="font-weight:700;margin:0">Scope of Work / Defect Items *</label>
        <button type="button" class="sm" id="btn-add-line">+ Add Item</button>
      </div>
      <table style="width:100%;font-size:13px;border-collapse:collapse" id="tbl-lines">
        <thead>
          <tr style="background:var(--surface);border-bottom:1px solid var(--border)">
            <th style="width:36px;text-align:center">#</th>
            <th>Description of Work Required *</th>
            <th style="width:180px">Location on Machine</th>
            <th style="width:180px">Remarks</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody id="tbl-lines-body">
          ${(r.lines || [{ description: '' }]).map((l, i) => `
            <tr>
              <td style="text-align:center;color:var(--muted)">${i + 1}</td>
              <td><input type="text" class="line-desc" value="${esc(l.description || '')}" placeholder="Specific component defect or service task" style="width:100%"></td>
              <td><input type="text" class="line-loc" value="${esc(l.location || '')}" placeholder="e.g. Workshop Bay 2" style="width:100%"></td>
              <td><input type="text" class="line-rem" value="${esc(l.remarks || '')}" placeholder="e.g. Pressure test required" style="width:100%"></td>
              <td style="text-align:center"><button type="button" class="sm btn-del-line" title="Remove">✕</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
      <button type="button" class="btn" id="btn-cancel">Cancel</button>
      <button type="button" class="btn" id="btn-save-draft">Save Changes</button>
      <button type="button" class="primary" id="btn-save-submit">Save &amp; Submit for Approval</button>
    </div>
  `;

  modal('Edit C.COM Request: ' + (r.ref_no || `REQ-${r.id}`), html, (body, close) => {
    const linesBody = qs('#tbl-lines-body', body);

    const reindex = () => {
      qsa('tr', linesBody).forEach((tr, i) => {
        const cell = tr.children[0];
        if (cell) cell.textContent = String(i + 1);
      });
    };

    qs('#btn-add-line', body).onclick = () => {
      const idx = qsa('tr', linesBody).length + 1;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="text-align:center;color:var(--muted)">${idx}</td>
        <td><input type="text" class="line-desc" placeholder="Specific component defect or service task" style="width:100%"></td>
        <td><input type="text" class="line-loc" placeholder="e.g. Workshop Bay 2" style="width:100%"></td>
        <td><input type="text" class="line-rem" placeholder="e.g. Pressure test required" style="width:100%"></td>
        <td style="text-align:center"><button type="button" class="sm btn-del-line" title="Remove">✕</button></td>
      `;
      linesBody.appendChild(tr);
      qs('.btn-del-line', tr).onclick = () => { tr.remove(); reindex(); };
    };

    qsa('.btn-del-line', linesBody).forEach((b) => {
      b.onclick = (e) => {
        if (qsa('tr', linesBody).length <= 1) return toast('At least one item is required', 'err');
        e.target.closest('tr').remove();
        reindex();
      };
    });

    qs('#btn-cancel', body).onclick = close;

    const collectData = () => {
      const form = formData(body);
      const lines = [];
      qsa('tr', linesBody).forEach((tr) => {
        const desc = qs('.line-desc', tr)?.value?.trim();
        const loc = qs('.line-loc', tr)?.value?.trim();
        const rem = qs('.line-rem', tr)?.value?.trim();
        if (desc) {
          lines.push({ description: desc, location: loc || null, remarks: rem || null });
        }
      });

      if (!form.assigned_engineer_id) {
        toast('Please select an assigned Mechanical Engineer', 'err');
        return null;
      }
      if (!lines.length) {
        toast('Please enter at least one work item description', 'err');
        return null;
      }

      return {
        vendor_id: Number(form.vendor_id),
        vendor_contact_id: Number(form.vendor_contact_id) || null,
        assigned_engineer_id: Number(form.assigned_engineer_id),
        request_type: form.request_type,
        priority: form.priority,
        required_date: form.required_date,
        meter_reading: form.meter_reading ? Number(form.meter_reading) : null,
        meter_unit: form.meter_unit || 'hours',
        contact_name: form.contact_name,
        contact_number: form.contact_number,
        informed_by: form.informed_by,
        lines
      };
    };

    qs('#btn-save-draft', body).onclick = async () => {
      const payload = collectData();
      if (!payload) return;
      try {
        await api(`/outsourcing/requests/${r.id}`, { method: 'PATCH', body: payload });
        toast('✓ Changes saved');
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    qs('#btn-save-submit', body).onclick = async () => {
      const payload = collectData();
      if (!payload) return;
      try {
        await api(`/outsourcing/requests/${r.id}`, { method: 'PATCH', body: payload });
        const sub = await api(`/outsourcing/requests/${r.id}/submit`, { method: 'POST' });
        toast(`✓ Submitted to Engineer! Allocated ${sub.ref_no}`);
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }, { wide: true });
}

async function openOutsourcingDetailModal(requestId, onDone) {
  let r = null;
  try {
    r = await api(`/outsourcing/requests/${requestId}`);
  } catch (err) {
    return toast(err.message, 'err');
  }

  const lines = r.lines || [];
  const costLinks = r.cost_links || [];

  const html = `
    <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:12px">
      <div>
        <h3 style="margin:0">${esc(r.ref_no || `(Draft #${r.id})`)}</h3>
        <span class="muted" style="font-size:12px">Version ${r.version || 1} · Created ${esc(String(r.created_at || '').slice(0, 16))} by ${esc(r.created_by_name || 'Storekeeper')}</span>
      </div>
      <div>
        ${outsourcingStatusBadge(r.status)}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;font-size:13px">
      <div class="card" style="margin:0;padding:10px">
        <b>Machine / Vehicle Details:</b>
        <div>Reg / Code: <b>${esc(r.asset_reg || r.asset_code || '—')}</b></div>
        <div>Brand / Model: ${esc(r.asset_brand || '—')} ${esc(r.asset_model || '')}</div>
        <div>Chassis: ${esc(r.asset_chassis || '—')} · Engine: ${esc(r.asset_engine || '—')}</div>
        <div>Meter: <b>${r.meter_reading != null ? `${num(r.meter_reading)} ${esc(r.meter_unit || 'hours')}` : '—'}</b></div>
      </div>
      <div class="card" style="margin:0;padding:10px">
        <b>Vendor &amp; Attendance Details:</b>
        <div>Vendor: <b>${esc(r.vendor_name || 'C.COM')}</b></div>
        <div>Site Contact: <b>${esc(r.contact_name || '—')}</b> (${esc(r.contact_number || '—')})</div>
        <div>Assigned Engineer: <b>${esc(r.assigned_engineer_name || '—')}</b></div>
        <div>Informed By: ${esc(r.informed_by || '—')}</div>
      </div>
    </div>

    <h4>Scope of Work Items (${lines.length})</h4>
    ${tableWrap([
      { label: '#' },
      { label: 'Description' },
      { label: 'Location on Machine' },
      { label: 'Remarks' }
    ], lines.map((l, i) => `<tr>
      <td>${i + 1}</td>
      <td><b>${esc(l.description)}</b></td>
      <td>${esc(l.location || '—')}</td>
      <td>${esc(l.remarks || '—')}</td>
    </tr>`))}

    ${costLinks.length ? `
      <div class="card section" style="background:#f0fdf4;border:1px solid #86efac;margin-top:14px">
        <h4 style="margin:0 0 6px;color:#166534">💰 Posted Actual Invoice Cost</h4>
        ${tableWrap([
          { label: 'Invoice No' },
          { label: 'Invoice Date' },
          { label: 'Amount (Rs)', num: true },
          { label: 'Posted By' },
          { label: 'Posted At' }
        ], costLinks.map((c) => `<tr>
          <td><b>${esc(c.invoice_no)}</b></td>
          <td>${esc((c.invoice_date || '').slice(0, 10))}</td>
          <td class="num"><b>${money(c.amount)}</b></td>
          <td>${esc(c.posted_by_name || 'User')}</td>
          <td>${esc((c.posted_at || '').slice(0, 16))}</td>
        </tr>`))}
      </div>
    ` : ''}

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
      <button type="button" class="btn" id="btn-detail-close">Close</button>
      <a class="btn primary sm" href="/api/outsourcing/requests/${r.id}/preview" target="_blank">📄 Official Letterhead</a>
    </div>
  `;

  modal('Outsourced Request Details: ' + (r.ref_no || `REQ-${r.id}`), html, (body, close) => {
    qs('#btn-detail-close', body).onclick = close;
  }, { wide: true });
}

async function openOutsourcingReviewModal(requestId, onDone) {
  let r = null;
  try {
    r = await api(`/outsourcing/requests/${requestId}`);
  } catch (err) {
    return toast(err.message, 'err');
  }

  const html = `
    <div style="background:#f8fafc;padding:12px;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <b style="font-size:16px">${esc(r.ref_no || `REQ-${r.id}`)}</b>
          <span class="badge ${r.priority === 'critical' ? 'red' : (r.priority === 'high' ? 'amber' : '')}">${esc(r.priority)}</span>
          <span class="badge">${esc(r.request_type)}</span>
        </div>
        <div>${outsourcingStatusBadge(r.status)}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;font-size:13px">
        <div><b>Vehicle / Plant:</b> ${esc(r.asset_reg || r.asset_code || '—')} (${esc(r.asset_brand || '')} ${esc(r.asset_model || '')})</div>
        <div><b>Site Contact:</b> ${esc(r.contact_name || '—')} (${esc(r.contact_number || '—')})</div>
        <div><b>Requested By:</b> ${esc(r.created_by_name || 'Storekeeper')}</div>
        <div><b>Required Date:</b> ${esc(r.required_date || '—')}</div>
      </div>
      <div style="margin-top:8px">
        <a class="btn sm" href="/api/outsourcing/requests/${r.id}/preview" target="_blank">📄 View Official Letterhead Preview in New Window</a>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="card" style="border-left:4px solid var(--red);margin:0">
        <h4 style="margin:0 0 6px;color:var(--red)">↩ Return for Correction</h4>
        <p class="muted" style="font-size:12px;margin:0 0 8px">
          If scope of work, meter reading, or details need amendment, specify the required changes and return to the storekeeper.
        </p>
        <textarea id="txt-return-reason" rows="3" placeholder="Explain the reason for returning this request..." style="width:100%"></textarea>
        <div style="margin-top:8px;text-align:right">
          <button type="button" class="danger sm" id="btn-do-return">Return Request</button>
        </div>
      </div>

      <div class="card" style="border-left:4px solid var(--green);margin:0">
        <h4 style="margin:0 0 6px;color:var(--green)">✓ Approve &amp; Electronically Sign</h4>
        <p class="muted" style="font-size:12px;margin:0 0 8px">
          Approve request for C.COM. In accordance with policy, re-enter your password to apply your electronic signature.
        </p>
        <div style="margin-bottom:8px">
          <label style="font-size:12px">Approval Note (Optional)</label>
          <input type="text" id="txt-app-note" value="Approved for C.COM inspection &amp; repair" style="width:100%">
        </div>
        <div style="margin-bottom:8px">
          <label style="font-size:12px;font-weight:700">Account Password (E-Sign Verification) *</label>
          <input type="password" id="txt-app-pw" placeholder="Enter your login password" autocomplete="current-password" style="width:100%">
        </div>
        <div style="margin-top:8px;text-align:right">
          <button type="button" class="primary sm" id="btn-do-approve" style="background:#059669;border-color:#059669">Approve &amp; Sign PDF</button>
        </div>
      </div>
    </div>
  `;

  modal('Review & Electronic Sign-off: ' + (r.ref_no || `REQ-${r.id}`), html, (body, close) => {
    qs('#btn-do-return', body).onclick = async () => {
      const reason = qs('#txt-return-reason', body).value.trim();
      if (!reason) return toast('A clear reason is required when returning a request', 'err');
      try {
        await api(`/outsourcing/requests/${r.id}/return`, { method: 'POST', body: { reason } });
        toast('Request returned for correction');
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    qs('#btn-do-approve', body).onclick = async () => {
      const password = qs('#txt-app-pw', body).value;
      const approval_note = qs('#txt-app-note', body).value.trim();
      if (!password) return toast('Password is required to electronically sign', 'err');
      try {
        await api(`/outsourcing/requests/${r.id}/approve`, { method: 'POST', body: { password, approval_note } });
        toast('✓ Approved and electronically signed! PDF generated.');
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }, { wide: true });
}

async function openOutsourcingEmailModal(requestId, onDone) {
  let r = null;
  try {
    r = await api(`/outsourcing/requests/${requestId}`);
  } catch (err) {
    return toast(err.message, 'err');
  }

  const assetLabel = r.asset_reg || r.asset_code || 'Equipment';
  const defaultSubject = `[C.COM REQUEST FOR REPAIR] Ref: ${r.ref_no} — Vehicle: ${assetLabel}`;
  const defaultBody = `Dear C.COM Service Team,

Please find attached our official approved Request for Repair (${r.ref_no}) for ${assetLabel}.

Details:
- Reference No: ${r.ref_no}
- Site Location: ${r.site_name || 'Central Workshop Badalgama'}
- Site Contact: ${r.contact_name || 'W.R. Malinga Livera'} (${r.contact_number || '075-2303039'})
- Required Date: ${r.required_date || 'Earliest convenience'}

Please arrange technical inspection and provide your quotation and estimated turnaround time.

Thank you,
Edward & Christie Central Workshop Administration`;

  const html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field">
        <label>To (C.COM Service Contact) *</label>
        <input type="email" id="txt-email-to" value="${esc(r.vendor_contact_email || 'service@ccom.lk')}" style="width:100%">
      </div>
      <div class="field">
        <label>CC (Internal / Workshop Notification)</label>
        <input type="text" id="txt-email-cc" placeholder="e.g. workshop@edwardchristie.com" style="width:100%">
      </div>
    </div>
    <div style="margin-top:8px">
      <label>Email Subject *</label>
      <input type="text" id="txt-email-subject" value="${esc(defaultSubject)}" style="width:100%">
    </div>
    <div style="margin-top:8px">
      <label>Email Message Body *</label>
      <textarea id="txt-email-body" rows="7" style="width:100%">${esc(defaultBody)}</textarea>
    </div>
    <div style="margin-top:10px;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;display:flex;align-items:center;gap:8px">
      <span style="font-size:18px">📎</span>
      <div>
        <b>Official PDF Attachment:</b>
        <a href="/api/outsourcing/requests/${r.id}/pdf" target="_blank">${esc(r.ref_no || `REQ-${r.id}`)}.pdf</a>
        <span class="muted" style="font-size:11px">(Dual signed with SHA256 integrity hash)</span>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
      <button type="button" class="btn" id="btn-email-cancel">Cancel</button>
      <button type="button" class="primary" id="btn-email-send">📤 Send Email to C.COM</button>
    </div>
  `;

  modal('Email Official Request to C.COM: ' + r.ref_no, html, (body, close) => {
    qs('#btn-email-cancel', body).onclick = close;
    qs('#btn-email-send', body).onclick = async () => {
      const toVal = qs('#txt-email-to', body).value.trim();
      const ccVal = qs('#txt-email-cc', body).value.trim();
      const subject = qs('#txt-email-subject', body).value.trim();
      const bodyText = qs('#txt-email-body', body).value.trim();

      if (!toVal) return toast('Recipient email is required', 'err');
      if (!subject) return toast('Subject is required', 'err');
      if (!bodyText) return toast('Body is required', 'err');

      const toList = toVal.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
      const ccList = ccVal ? ccVal.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : [];

      try {
        await api(`/outsourcing/requests/${r.id}/send`, {
          method: 'POST',
          body: { to: toList, cc: ccList, subject, body: bodyText }
        });
        toast('✓ Email queued and dispatched to C.COM!');
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }, { wide: true });
}

async function openOutsourcingProgressModal(requestId, onDone) {
  let r = null;
  try {
    r = await api(`/outsourcing/requests/${requestId}`);
  } catch (err) {
    return toast(err.message, 'err');
  }

  const html = `
    <div style="margin-bottom:12px">
      <label>Update Repair Progress Status *</label>
      <select id="sel-progress-status" style="width:100%">
        <option value="acknowledged" ${r.status === 'acknowledged' ? 'selected' : ''}>Acknowledged by C.COM / Technician Scheduled</option>
        <option value="in_progress" ${r.status === 'in_progress' ? 'selected' : ''}>Work In Progress / Components Stripped &amp; Tested</option>
        <option value="completed" ${r.status === 'completed' ? 'selected' : ''}>Work Finished by C.COM (Awaiting Inspection)</option>
      </select>
    </div>
    <div style="margin-bottom:12px">
      <label>Progress Notes / Workshop Log</label>
      <textarea id="txt-progress-notes" rows="3" placeholder="Enter status update notes from C.COM technician or driver..." style="width:100%"></textarea>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button type="button" class="btn" id="btn-prog-cancel">Cancel</button>
      <button type="button" class="primary" id="btn-prog-save">Update Status</button>
    </div>
  `;

  modal('C.COM Progress Tracking: ' + (r.ref_no || `REQ-${r.id}`), html, (body, close) => {
    qs('#btn-prog-cancel', body).onclick = close;
    qs('#btn-prog-save', body).onclick = async () => {
      const status = qs('#sel-progress-status', body).value;
      const notes = qs('#txt-progress-notes', body).value.trim();
      try {
        await api(`/outsourcing/requests/${r.id}/progress`, { method: 'POST', body: { status, notes } });
        toast('✓ Status updated to ' + status);
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
}

async function openOutsourcingCostModal(requestId, onDone) {
  let r = null;
  try {
    r = await api(`/outsourcing/requests/${requestId}`);
  } catch (err) {
    return toast(err.message, 'err');
  }

  const isRepair = !!r.repair_job_id;
  const targetLabel = isRepair ? 'Repair Job Card (External Cost)' : 'Service Record (Outside Estimate)';
  const today = new Date().toISOString().slice(0, 10);

  const html = `
    <div style="padding:10px 14px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:14px;color:#92400e;font-size:13px">
      <b>⚠️ Authoritative Cost Posting:</b><br>
      Recording this C.COM vendor invoice will post the verified cost directly into the parent <b>${esc(targetLabel)}</b>.
      The request will transition to <b>Closed</b>.
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field">
        <label>Invoice Number *</label>
        <input type="text" id="txt-inv-no" placeholder="e.g. CCOM-INV-2026-089" style="width:100%">
      </div>
      <div class="field">
        <label>Invoice Date *</label>
        <input type="date" id="txt-inv-date" value="${today}" style="width:100%">
      </div>
    </div>
    <div style="margin-top:8px">
      <label>Invoice Amount (Rs.) *</label>
      <input type="number" step="0.01" id="txt-inv-amount" placeholder="0.00" style="width:100%;font-size:16px;font-weight:700">
    </div>
    <div style="margin-top:8px">
      <label>Notes / Voucher Details</label>
      <input type="text" id="txt-inv-notes" placeholder="Optional invoice notes or payment voucher reference" style="width:100%">
    </div>

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
      <button type="button" class="btn" id="btn-cost-cancel">Cancel</button>
      <button type="button" class="primary" id="btn-cost-save" style="background:#7c3aed;border-color:#7c3aed">Post Cost &amp; Close Request</button>
    </div>
  `;

  modal('Post C.COM Invoice Cost: ' + (r.ref_no || `REQ-${r.id}`), html, (body, close) => {
    qs('#btn-cost-cancel', body).onclick = close;
    qs('#btn-cost-save', body).onclick = async () => {
      const invoice_no = qs('#txt-inv-no', body).value.trim();
      const invoice_date = qs('#txt-inv-date', body).value;
      const amount = Number(qs('#txt-inv-amount', body).value);
      const notes = qs('#txt-inv-notes', body).value.trim() || undefined;

      if (!invoice_no) return toast('Invoice number is required', 'err');
      if (!amount || amount <= 0) return toast('Invoice amount must be greater than 0', 'err');

      try {
        await api(`/outsourcing/requests/${r.id}/post-cost`, {
          method: 'POST',
          body: { invoice_no, invoice_date, amount, notes }
        });
        toast('✓ Invoice cost successfully posted to parent job!');
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
}

function openOutsourcingNoteModal(cfg, onDone) {
  const html = `
    <p style="margin-top:0;font-size:13px;color:var(--muted,#64748b)">${esc(cfg.intro)}</p>
    <div class="field">
      <label for="${esc(cfg.fieldId)}">${esc(cfg.label)}</label>
      <textarea id="${esc(cfg.fieldId)}" rows="3" placeholder="${esc(cfg.placeholder)}" style="width:100%">${esc(cfg.defaultValue || '')}</textarea>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button type="button" class="btn" id="btn-note-abort">${esc(cfg.cancelLabel || 'Cancel')}</button>
      <button type="button" class="${esc(cfg.submitClass || 'btn primary')}" id="btn-note-confirm">${esc(cfg.submitLabel)}</button>
    </div>
  `;
  modal(cfg.title, html, (bodyEl, close) => {
    qs('#btn-note-abort', bodyEl).onclick = close;
    qs('#btn-note-confirm', bodyEl).onclick = async () => {
      const value = qs('#' + cfg.fieldId, bodyEl).value.trim();
      if (cfg.required && !value) return toast(cfg.requiredMsg || 'Input is required', 'err');
      const btn = qs('#btn-note-confirm', bodyEl);
      btn.disabled = true;
      try {
        await api(cfg.endpoint, { method: 'POST', body: { [cfg.bodyKey]: value } });
        toast(cfg.successMsg);
        close();
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    };
  });
}

function openOutsourcingVerifyModal(requestId, onDone) {
  openOutsourcingNoteModal({
    title: 'Verify C.COM Work Completion',
    intro: 'Record the engineer inspection note before marking this outsourced work complete.',
    fieldId: 'txt-verify-notes',
    label: 'Engineer Verification Note',
    placeholder: 'Inspection summary...',
    defaultValue: 'Work completed by C.COM and inspected satisfactorily.',
    required: false,
    submitLabel: '✓ Verify Completion',
    submitClass: 'btn primary',
    endpoint: `/outsourcing/requests/${requestId}/verify-completion`,
    bodyKey: 'notes',
    successMsg: '✓ Work completion verified!',
  }, onDone);
}

async function openOutsourcingCancelModal(requestId, onDone) {
  openOutsourcingNoteModal({
    title: 'Cancel C.COM Request',
    intro: 'Provide a clear reason for cancelling this C.COM outsourcing request.',
    fieldId: 'txt-cancel-reason',
    label: 'Cancellation Reason *',
    placeholder: 'Enter reason for cancelling request...',
    defaultValue: '',
    required: true,
    requiredMsg: 'A cancellation reason is required',
    cancelLabel: 'Back',
    submitLabel: 'Cancel Request',
    submitClass: 'btn danger',
    endpoint: `/outsourcing/requests/${requestId}/cancel`,
    bodyKey: 'reason',
    successMsg: 'Request cancelled',
  }, onDone);
}

function openOutsourcingPreviewModal(requestId) {
  modal('C.COM Request Letterhead Preview', `
    <div style="margin-bottom:8px;display:flex;justify-content:flex-end;gap:6px">
      <a class="btn sm" href="/api/outsourcing/requests/${requestId}/pdf" target="_blank">⬇️ Download PDF</a>
      <a class="btn sm" href="/api/outsourcing/requests/${requestId}/preview" target="_blank">🗗 Open in New Tab</a>
    </div>
    <iframe src="/api/outsourcing/requests/${requestId}/preview" style="width:100%;height:680px;border:1px solid #cbd5e1;border-radius:6px;background:#ffffff"></iframe>
  `, null, { wide: true });
}
