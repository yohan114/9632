'use strict';
async function renderGovernanceTab(c, sp, defaultView = '') {
  const canAuditSections = canDo('access.manage');
  const views = [];
  if (canAuditSections) views.push(['sections', '🔐 Who Has Access? (Sections & Stores)']);
  views.push(['stand_ins', '🤝 Stand-in Hand-overs']);

  const candidate = defaultView || (sp && sp.get('view')) || '';
  const activeView = views.some((v) => v[0] === candidate) ? candidate : views[0][0];

  c.innerHTML = `
    <div class="card" style="padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div class="pill-row">
        ${views.map(([k, lbl]) => `<button class="btn sm ${activeView === k ? 'primary' : ''}" data-gov-view="${k}">${esc(lbl)}</button>`).join('')}
      </div>
      <div class="muted" style="font-size:12px">
        ${activeView === 'sections' ? 'Audit effective clearances by system section or physical store location' : 'Temporary approval hand-overs during leave or absence'}
      </div>
    </div>
    <div id="gov-sub-pane"><div class="muted">Loading…</div></div>
  `;

  qsa('[data-gov-view]', c).forEach((b) => {
    b.onclick = () => { location.hash = '#/access?tab=governance&view=' + b.dataset.govView; };
  });

  const subPane = qs('#gov-sub-pane', c);
  if (activeView === 'sections') {
    await renderSectionsAudit(subPane, sp ? sp.get('section') : null, sp ? sp.get('store') : null);
  } else {
    await renderStandIns(subPane);
  }
}

// Approval limits: the most money each role may sign off on its own. Empty = no limit, which is
// how every role starts, so nothing changes until an amount is typed in. Saved on leaving the box.
async function renderApprovalLimits(c) {
  const d = await api('/access/approval-limits');
  const mine = new Set(ME.roles || []);
  const cell = (r, k) => {
    if (!r.gives[k.key] && r.limits[k.key] == null) return '<td class="muted">—</td>';
    const v = r.limits[k.key];
    const locked = !isAdmin() && mine.has(r.name);
    return `<td><input type="number" min="0" step="1" style="max-width:160px" placeholder="No limit" data-lrole="${esc(r.name)}" data-lkind="${esc(k.key)}"
      value="${v == null ? '' : esc(v)}" data-was="${v == null ? '' : esc(v)}" ${locked ? 'disabled title="Your own role — ask an admin"' : ''}></td>`;
  };
  c.innerHTML = `<div class="card">
    <h3 style="margin:0 0 6px">Approval limits</h3>
    <p class="muted" style="margin:0 0 10px">The most money (Rs) a role may sign off on its own. Leave a box empty for <b>no limit</b>.
      Above the limit, the approval waits for someone with a higher limit. Admin never has a limit.
      A person with two roles gets the higher limit.</p>
    ${d.roles.length ? tableWrap([{ label: 'Role' }].concat(d.kinds.map((k) => ({ label: k.label }))),
      d.roles.map((r) => `<tr><td><b>${esc(r.label)}</b>${r.active ? '' : ' <span class="badge">retired</span>'}</td>${d.kinds.map((k) => cell(r, k)).join('')}</tr>`))
      : '<p class="muted">No role gives these approvals yet.</p>'}
    <ul class="muted" style="font-size:12px;margin:10px 0 0">${d.kinds.map((k) => `<li><b>${esc(k.label)}</b> — ${esc(k.measure)}.</li>`).join('')}
      <li>Job cards and job requests have no amount when they are approved, so the limit for a job is checked when it is closed fully.</li></ul>
  </div>`;
  qsa('[data-lrole]', c).forEach((inp) => {
    inp.onchange = async () => {
      const val = inp.value.trim();
      if (val === inp.dataset.was) return;
      try {
        await api('/access/approval-limits', { method: 'PUT', body: { role: inp.dataset.lrole, kind: inp.dataset.lkind, max_amount: val === '' ? null : val } });
        inp.dataset.was = val;
        toast(val === '' ? 'No limit' : `Limit saved: ${money(val)}`);
      } catch (e) { inp.value = inp.dataset.was; toast(e.message, 'err'); }
    };
  });
}

// Stand-in Approvals (Step 3b, Decision D9)
async function renderStandIns(c) {
  const [data, usersResp] = await Promise.all([
    api('/access/stand-ins'),
    api('/access/report').catch(() => ({ users: [] }))
  ]);
  const delegations = (data && data.delegations) || [];
  const activeUsers = (usersResp && (usersResp.users || usersResp.people)) || [];
  const today = new Date().toISOString().slice(0, 10);

  c.innerHTML = `<div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <div>
        <h3 style="margin:0 0 4px">Stand-in Approvals (Hand-overs)</h3>
        <p class="muted" style="margin:0">When away or on leave, delegate approval authority to a stand-in for up to 30 days (Decision D9). Only certify and approve capabilities pass.</p>
      </div>
      <button class="btn sm primary" id="btn-new-standin">+ Hand over approvals</button>
    </div>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin-bottom:14px;font-size:12px;line-height:1.5" class="muted">
      <b>Delegation rules (Decision D9):</b>
      • The manager keeps their own signing rights during the hand-over.
      • The manager's approval limit applies to the stand-in.
      • Maximum duration is strictly 30 days. No delegation chains (a stand-in cannot re-delegate).
      • Normal segregation of duties applies: a stand-in cannot approve their own requests or both certify and approve.
      • All records, approvals and printed forms show both names (e.g. <i>"Ruwan for Nimal"</i>).
    </div>

    ${tableWrap([
      { label: 'Granter (Manager)' },
      { label: 'Stand-in' },
      { label: 'Period' },
      { label: 'Reason' },
      { label: 'Status' },
      { label: 'Set up by' },
      { label: 'Actions' }
    ], delegations.map(d => {
      const isPast = d.end_date < today;
      const isFuture = d.start_date > today;
      const isRevoked = !d.active || !!d.revoked_at;
      let badge = '<span class="badge" style="background:#dcfce7;color:#166534">Active</span>';
      if (isRevoked) badge = '<span class="badge" style="background:#fee2e2;color:#991b1b">Revoked</span>';
      else if (isPast) badge = '<span class="badge" style="background:#f1f5f9;color:#475569">Expired</span>';
      else if (isFuture) badge = '<span class="badge" style="background:#e0f2fe;color:#075985">Upcoming</span>';

      const canRevoke = !isRevoked && !isPast && (isAdmin() || d.granter_id === ME.id || d.stand_in_id === ME.id);
      const revokeBtn = canRevoke
        ? `<button class="btn sm danger" data-revoke="${d.id}" style="padding:2px 6px;font-size:11px">End early</button>`
        : '<span class="muted">—</span>';

      return `<tr>
        <td><b>${esc(d.granter_full_name || d.granter_username)}</b></td>
        <td><b>${esc(d.stand_in_full_name || d.stand_in_username)}</b></td>
        <td><code>${esc(d.start_date)}</code> to <code>${esc(d.end_date)}</code></td>
        <td>${esc(d.reason || '')}</td>
        <td>${badge}</td>
        <td class="muted" style="font-size:11px">${esc(d.created_by_full_name || d.created_by_username || '')}</td>
        <td>${revokeBtn}</td>
      </tr>`;
    }))}
  </div>`;

  // Bind revoke buttons
  qsa('[data-revoke]', c).forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.revoke;
      modal('End Hand-over Early', `
        <p>Are you sure you want to revoke this delegation early?</p>
        ${field('Reason for ending early', 'revoke_reason', { placeholder: 'e.g. Returned from leave early' })}
        <div style="margin-top:12px;text-align:right"><button class="btn danger" id="btn-confirm-revoke">End delegation</button></div>
      `, (body, close) => {
        qs('#btn-confirm-revoke', body).onclick = async () => {
          try {
            const reason = qs('[name="revoke_reason"]', body).value.trim();
            await api('/access/stand-ins/' + id + '/revoke', { method: 'POST', body: { reason } });
            toast('Delegation ended');
            close();
            renderStandIns(c);
            renderStandInBanner();
          } catch (e) {
            toast(e.message, 'err');
          }
        };
      });
    };
  });

  // Bind new delegation button
  const newBtn = qs('#btn-new-standin', c);
  if (newBtn) {
    newBtn.onclick = () => {
      const isAdm = isAdmin();
      const granterOpts = activeUsers.map(u =>
        `<option value="${u.id}" ${u.id === ME.id ? 'selected' : ''}>${esc(u.full_name || u.username)} (${esc(u.roles || '')})</option>`
      ).join('');

      const standInOpts = activeUsers.filter(u => u.id !== ME.id).map(u =>
        `<option value="${u.id}">${esc(u.full_name || u.username)} (${esc(u.roles || '')})</option>`
      ).join('');

      const defaultEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

      modal('Hand Over Approvals to Stand-in', `
        <p class="muted" style="font-size:12px">Delegate your certifying and approving authority while away (maximum 30 days).</p>
        ${isAdm ? `<div class="field"><label>Manager (Granter)</label><select name="granter_id" class="input">${granterOpts}</select></div>` : `<input type="hidden" name="granter_id" value="${ME.id}">`}
        <div class="field"><label>Stand-in Person</label><select name="stand_in_id" class="input">${standInOpts}</select></div>
        <div class="row" style="display:flex;gap:10px">
          <div style="flex:1">${field('Start Date', 'start_date', { type: 'date', value: today })}</div>
          <div style="flex:1">${field('End Date', 'end_date', { type: 'date', value: defaultEnd })}</div>
        </div>
        ${field('Reason', 'reason', { placeholder: 'e.g. Annual leave, Medical leave, Site visit' })}
        <div style="margin-top:14px;text-align:right"><button class="btn primary" id="btn-save-standin">Create Hand-over</button></div>
      `, (body, close) => {
        qs('#btn-save-standin', body).onclick = async () => {
          try {
            const granter_id = isAdm ? qs('[name="granter_id"]', body).value : ME.id;
            const stand_in_id = qs('[name="stand_in_id"]', body).value;
            const start_date = qs('[name="start_date"]', body).value;
            const end_date = qs('[name="end_date"]', body).value;
            const reason = qs('[name="reason"]', body).value.trim();

            await api('/access/stand-ins', {
              method: 'POST',
              body: { granter_id, stand_in_id, start_date, end_date, reason }
            });
            toast('Approvals handed over successfully');
            close();
            renderStandIns(c);
            renderStandInBanner();
          } catch (e) {
            toast(e.message, 'err');
          }
        };
      });
    };
  }
}

const lvlChip = (lvl) => {
  const cls = lvl === 'full' ? 'amber' : lvl === 'edit' ? 'green' : lvl === 'add' ? 'blue' : '';
  const txt = lvl === 'none' ? '—' : String(lvl).toUpperCase();
  return `<span class="badge ${cls}"${lvl === 'none' ? ' style="opacity:.4"' : ''}>${txt}</span>`;
};

// ---- Tab 1: People & Overrides ------------------------------------------------
async function renderPeopleAccess(c, wantedUserId) {
  const canManageAccess = canDo('access.manage');
  const canManageUsers = canDo('users.manage');

  const [data, rolesList, storeLocsRes, wsd] = await Promise.all([
    api('/access/people'),
    canManageUsers ? api('/users/roles').catch(() => []) : Promise.resolve([]),
    api('/store-locations').catch(() => []),
    workshopsData(true).catch(() => ({ workshops: [], multi: false })),
  ]);

  const people = data.people || [];
  const allStoreLocations = Array.isArray(storeLocsRes) ? storeLocsRes : (storeLocsRes && storeLocsRes.stores) || [];
  const storeOptions = [{ value: '', label: '— No specific store (Workshop / Fleet / General) —' }]
    .concat(allStoreLocations.filter((s) => s.active !== 0).map((s) => {
      const icon = s.store_type === 'MAIN_STORE' ? '🏛️' : (s.store_type === 'MAIN_WORKSHOP_STORE' ? '🔧' : '📦');
      return { value: String(s.id), label: `${icon} ${s.name} (${s.code})` };
    }));

  if (!people.length) {
    c.innerHTML = `<div class="card">
      <div class="toolbar">
        <span class="muted">No users found.</span>
        <div class="spacer"></div>
        ${canManageUsers ? '<button class="primary sm" id="btn-people-new-user">+ New User</button>' : ''}
      </div>
    </div>`;
    const emptyNewBtn = qs('#btn-people-new-user', c);
    if (emptyNewBtn) {
      emptyNewBtn.onclick = () => openNewUserWizard(rolesList, allStoreLocations, storeOptions, wsd, (created) => renderPeopleAccess(c, created && created.id));
    }
    return;
  }

  const sel = people.find((u) => u.id == wantedUserId) || people[0];
  const details = await api('/access/people/' + sel.id);
  const u = details.user;
  const sections = details.sections || [];
  const uRoleNames = (u.roles || []).map((r) => r.name);
  const allRoles = details.all_roles || data.all_roles || [];
  const allProjects = details.all_projects || data.all_projects || [];
  const allTanks = details.all_tanks || data.all_tanks || [];

  // Local state for unsaved override edits & directory filters
  const sectionEdits = {};
  const capEdits = {};
  const selectedRolesSet = new Set(uRoleNames);
  let rolesChanged = false;
  let statusFilter = 'all';

  const canEditTarget = !(!isAdmin() && uRoleNames.includes('admin'));
  const isSelf = ME && ME.id == u.id;
  const canEditScope = canEditTarget && (!isSelf || isAdmin());

  const renderDirectoryRows = () => {
    const q = (qs('#person-search', c) ? qs('#person-search', c).value : '').toLowerCase().trim();
    const filtered = people.filter((p) => {
      if (statusFilter === 'active' && !p.active) return false;
      if (statusFilter === 'inactive' && p.active) return false;
      if (!q) return true;
      const storeMatch = (p.store_locations || []).some((sl) => (sl.store_name || '').toLowerCase().includes(q) || (sl.store_code || '').toLowerCase().includes(q));
      return (p.full_name || '').toLowerCase().includes(q) ||
             (p.username || '').toLowerCase().includes(q) ||
             (p.project_name || '').toLowerCase().includes(q) ||
             (p.bulk_tank_name || '').toLowerCase().includes(q) ||
             storeMatch ||
             p.roles.some((r) => (r.label || r.name).toLowerCase().includes(q));
    });

    const listHtml = filtered.map((p) => {
      const isSel = p.id == u.id;
      const roleStr = p.roles.map((r) => r.label || r.name).join(', ') || 'No roles';
      const siteTag = p.project_name ? ` · <span style="color:#0284c7">🏗️ ${esc(p.project_name)}</span>` : '';
      const tankTag = p.bulk_tank_name ? ` · <span style="color:#d97706">⛽ ${esc(p.bulk_tank_name)}</span>` : '';
      const pStores = p.store_locations || [];
      const storeLabel = pStores.length > 0
        ? (pStores[0].store_name || pStores[0].store_code) + (pStores.length > 1 ? ` +${pStores.length - 1}` : '')
        : (p.primary_store_name || '');
      return `<tr data-pick-user="${p.id}" style="cursor:pointer;${isSel ? 'background:var(--bg-active, #eef2ff);font-weight:600;' : ''}${p.active ? '' : 'opacity:.55;'}">
        <td>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <span>${esc(p.full_name || p.username)}</span>
            <span style="display:flex;gap:4px;align-items:center">
              ${p.mfa_enabled ? '<span class="badge green" style="font-size:9px" title="2FA Enabled">2FA</span>' : ''}
              ${p.overrides_count > 0 ? `<span class="badge amber" style="font-size:10px" title="${p.overrides_count} custom overrides">${p.overrides_count} custom</span>` : ''}
            </span>
          </div>
          <div class="muted" style="font-size:11px;font-weight:normal">${esc(p.username)} · ${esc(roleStr)}${storeLabel ? ` · <span style="color:var(--primary,#0066ff)">📍 ${esc(storeLabel)}</span>` : ''}${siteTag}${tankTag}${p.active ? '' : ' · <span style="color:#dc2626">Inactive</span>'}</div>
        </td>
      </tr>`;
    }).join('') || '<tr><td class="muted" style="text-align:center">No matching people</td></tr>';

    const tbody = qs('#person-list-tbody', c);
    if (tbody) {
      tbody.innerHTML = listHtml;
      qsa('[data-pick-user]', tbody).forEach((tr) => {
        tr.onclick = async () => {
          const uid = tr.dataset.pickUser;
          await renderPeopleAccess(c, uid);
        };
      });
    }
  };

  const renderAll = () => {
    const GROUPS = [
      { id: 'Operations', name: 'Operations & Execution', icon: '⚙️' },
      { id: 'Fleet', name: 'Fleet, Fuel & Hire Management', icon: '🚛' },
      { id: 'Inventory', name: 'Inventory & Warehousing', icon: '📦' },
      { id: 'Procurement', name: 'Procurement & Purchasing', icon: '🛒' },
      { id: 'Analysis', name: 'Analysis, Costing & Intelligence', icon: '📊' },
      { id: 'Admin', name: 'Governance & Administration', icon: '🛡️' },
    ];

    const ACTVT_MAP = {
      '01': { label: '01 · Create', cls: 'badge teal' },
      '02': { label: '02 · Change', cls: 'badge blue' },
      '03': { label: '03 · Display', cls: 'badge' },
      '06': { label: '06 · Delete', cls: 'badge red' },
      '08': { label: '08 · Export', cls: 'badge purple' },
      '10': { label: '10 · Approve', cls: 'badge green' },
      'A1': { label: 'A1 · Certify', cls: 'badge amber' },
    };

    const LV_BTN = [
      { key: 'none', label: 'None' },
      { key: 'view', label: 'View' },
      { key: 'add', label: 'Add' },
      { key: 'edit', label: 'Edit' },
      { key: 'full', label: 'Full' },
    ];

    const groupCards = canManageAccess ? GROUPS.map((grp) => {
      const grpSections = sections.filter((s) => (s.group || '').toLowerCase() === grp.id.toLowerCase());
      if (!grpSections.length) return '';

      const secHtml = grpSections.map((sec) => {
        const curLevel = sectionEdits[sec.key] !== undefined ? sectionEdits[sec.key] : (sec.override_level !== null ? sec.override_level : sec.role_level);
        const isCustom = sectionEdits[sec.key] !== undefined ? (sectionEdits[sec.key] !== sec.role_level) : (sec.override_level !== null && sec.override_level !== sec.role_level);

        const lvlButtons = LV_BTN.map((b) => {
          const isSelected = curLevel === b.key;
          const cls = isSelected
            ? (b.key === 'full' ? 'primary' : (b.key === 'edit' ? 'badge green' : (b.key === 'add' ? 'badge blue' : (b.key === 'view' ? 'badge' : 'badge amber'))))
            : 'btn sm';
          const style = isSelected ? 'font-weight:bold;padding:4px 10px;font-size:12px' : 'opacity:.7;padding:4px 10px;font-size:12px';
          const disabled = isSelf || !canEditTarget ? 'disabled' : '';
          return `<button class="${cls}" style="${style}" data-sec-lvl="${esc(sec.key)}:${b.key}" ${disabled}>${b.label}</button>`;
        }).join(' ');

        let capsHtml = '';
        if (sec.capabilities && sec.capabilities.length > 0) {
          const capItems = sec.capabilities.map((cap) => {
            const hasCap = capEdits[cap.key] !== undefined ? capEdits[cap.key] : cap.effective_granted;
            const isCapOverridden = capEdits[cap.key] !== undefined ? (capEdits[cap.key] !== cap.role_granted) : cap.is_override;
            const disabled = isSelf || !canEditTarget ? 'disabled' : '';
            const actvt = ACTVT_MAP[cap.actvt] || { label: cap.actvt || '02', cls: 'badge' };
            const dualBadge = cap.dualAuth ? `<span class="badge amber" style="font-size:9px;font-weight:600" title="Mandatory 4-Eyes Dual Authorization">👥 4-Eyes Dual Auth</span> ` : '';
            return `<label style="display:flex;align-items:flex-start;gap:8px;margin:5px 0;font-weight:normal;font-size:12px">
              <input type="checkbox" style="width:auto;margin-top:2px" data-pcap="${esc(cap.key)}" ${hasCap ? 'checked' : ''} ${disabled}>
              <div>
                <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                  <span class="${actvt.cls}" style="font-size:9px;font-family:monospace">${actvt.label}</span>
                  ${dualBadge}
                  <span style="font-weight:500">${esc(cap.label)}</span>
                  ${isCapOverridden ? `<span class="badge amber" style="font-size:9px;margin-left:4px">Custom override</span>` : `<span class="muted" style="font-size:10px;margin-left:4px">(${cap.role_granted ? 'Granted by role' : 'Not in role'})</span>`}
                </div>
                <div class="muted" style="font-size:10px;font-family:monospace">${esc(cap.key)}</div>
              </div>
            </label>`;
          }).join('');

          capsHtml = `<details style="margin-top:8px;border-top:1px dashed var(--border-light, #eee);padding-top:6px">
            <summary style="cursor:pointer;font-size:11px;font-weight:600;color:var(--text-muted, #666)">
              Special Capabilities & Approvals (${sec.capabilities.length})
            </summary>
            <div style="margin-top:6px;padding-left:4px">
              ${capItems}
            </div>
          </details>`;
        }

        return `<div class="card" style="margin-bottom:10px;padding:12px;background:var(--card-sub-bg, #fff);border:1px solid var(--border-light, #e2e8f0);border-radius:6px">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:18px">${sec.icon}</span>
              <div>
                <b style="font-size:14px">${esc(sec.label)}</b>
                <div class="muted" style="font-size:11px">${esc(sec.description || '')}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              ${isCustom
                ? `<span class="badge amber" style="font-weight:600">⚡ Custom Override</span> <button class="btn sm" style="font-size:10px;padding:2px 6px" data-reset-sec="${esc(sec.key)}" title="Revert this section to role template">Reset</button>`
                : `<span class="badge blue" style="font-weight:500">Role Default (${sec.role_level.toUpperCase()})</span>`}
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;background:var(--bg-muted, #f8fafc);padding:6px 10px;border-radius:6px">
            <span class="muted" style="font-size:11px;font-weight:600;text-transform:uppercase">Clearance:</span>
            <div style="display:flex;gap:4px;flex-wrap:wrap">${lvlButtons}</div>
          </div>
          ${(sec.parts && sec.parts.length) ? `<div style="margin-top:8px;padding:6px 8px;background:#f8fafc;border:1px dashed var(--border-light, #cbd5e1);border-radius:6px">
            <div class="muted" style="font-size:10.5px;font-weight:700;text-transform:uppercase;margin-bottom:4px">Sub-Sections (${sec.parts.length}):</div>
            ${sec.parts.map((pt) => {
              const pCur = sectionEdits[pt.key] !== undefined ? sectionEdits[pt.key] : (pt.override_level !== null ? pt.override_level : pt.role_level);
              const pCustom = sectionEdits[pt.key] !== undefined ? (sectionEdits[pt.key] !== pt.role_level) : (pt.override_level !== null && pt.override_level !== pt.role_level);
              const pBtns = LV_BTN.map((b) => {
                const isSel = pCur === b.key;
                const cls = isSel
                  ? (b.key === 'full' ? 'primary' : (b.key === 'edit' ? 'badge green' : (b.key === 'add' ? 'badge blue' : (b.key === 'view' ? 'badge' : 'badge amber'))))
                  : 'btn sm';
                const style = isSel ? 'font-weight:bold;padding:2px 7px;font-size:10.5px' : 'opacity:.7;padding:2px 7px;font-size:10.5px';
                const disabled = isSelf || !canEditTarget ? 'disabled' : '';
                return `<button class="${cls}" style="${style}" data-sec-lvl="${esc(pt.key)}:${b.key}" ${disabled}>${b.label}</button>`;
              }).join(' ');
              return `<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding:3px 0;border-top:1px solid rgba(226,232,240,0.6)">
                <span style="font-size:11.5px;font-weight:500">${esc(pt.label)} ${pCustom ? '<span class="badge amber" style="font-size:9px">Custom</span>' : `<span class="muted" style="font-size:10px">(${esc((pt.role_level || 'none').toUpperCase())})</span>`}</span>
                <div style="display:flex;gap:3px;flex-wrap:wrap">${pBtns}${pCustom ? ` <button class="btn sm" style="font-size:9.5px;padding:1px 5px" data-reset-sec="${esc(pt.key)}" ${isSelf || !canEditTarget ? 'disabled' : ''}>↺</button>` : ''}</div>
              </div>`;
            }).join('')}
          </div>` : ''}
          ${capsHtml}
        </div>`;
      }).join('');

      return `<div style="margin-bottom:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 8px">
          <h3 style="margin:0;font-size:14px;color:var(--text-muted, #475569);display:flex;align-items:center;gap:6px">
            <span>${grp.icon}</span> <span>${esc(grp.name)}</span>
          </h3>
          ${!isSelf && canEditTarget ? `<div style="display:flex;gap:4px">
            <button class="btn sm" style="font-size:10px;padding:2px 6px" data-grp-set="${grp.id}:view">All View</button>
            <button class="btn sm" style="font-size:10px;padding:2px 6px" data-grp-set="${grp.id}:edit">All Edit</button>
            <button class="btn sm" style="font-size:10px;padding:2px 6px" data-grp-set="${grp.id}:full">All Full</button>
          </div>` : ''}
        </div>
        ${secHtml}
      </div>`;
    }).join('') : `<div class="card muted" style="font-size:12px">Section and capability override editing requires the <code>access.manage</code> capability. Use the Account & Security controls above to manage roles, passwords, store locations, 2FA, and sessions.</div>`;

    const storeBadgesHtml = (u.store_locations && u.store_locations.length)
      ? u.store_locations.map((sl) => {
          const icon = sl.store_type === 'MAIN_STORE' ? '🏛️' : (sl.store_type === 'MAIN_WORKSHOP_STORE' ? '🔧' : '📦');
          const cls = sl.store_type === 'MAIN_STORE' ? 'blue' : (sl.store_type === 'MAIN_WORKSHOP_STORE' ? 'amber' : 'green');
          const actions = [
            sl.can_view ? 'View' : '',
            sl.can_receive ? 'Rec' : '',
            sl.can_issue ? 'Iss' : '',
            sl.can_count ? 'Cnt' : '',
            sl.can_request ? 'Req' : '',
            sl.can_dispatch ? 'Disp' : '',
          ].filter(Boolean).join('·');
          return `<span class="badge ${cls}" style="font-size:11px;display:inline-flex;align-items:center;gap:4px;margin:2px 4px 2px 0" title="${esc(sl.store_name)}: ${actions || 'Assigned'}">${icon} <b>${esc(sl.store_name || sl.store_code)}</b>${actions ? ` <span style="opacity:.75;font-size:10px">(${actions})</span>` : ''}</span>`;
        }).join('')
      : '<span class="muted" style="font-size:11.5px">All workshops / unassigned store scope</span>';

    const curProjVal = qs('#user-project-id', c) ? qs('#user-project-id', c).value : String(u.project_id || '');
    const curTankVal = qs('#user-bulk-tank-id', c) ? qs('#user-bulk-tank-id', c).value : String(u.bulk_tank_id || '');
    const curFuelRoleVal = qs('#user-fuel-role', c) ? qs('#user-fuel-role', c).value : String(u.fuel_role || '');
    const curHideStockVal = qs('#user-hide-stock', c) ? qs('#user-hide-stock', c).checked : !!u.hide_stock;
    const rolesChipsHtml = allRoles.map((r) => {
      const hasRole = selectedRolesSet.has(r.name);
      const dis = (isSelf || !canEditTarget || (r.name === 'admin' && !isAdmin())) ? 'disabled' : '';
      return `<label style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:16px;border:1px solid ${hasRole ? '#2563eb' : '#cbd5e1'};background:${hasRole ? '#eff6ff' : '#fff'};font-size:11.5px;font-weight:${hasRole ? '600' : '400'};cursor:${dis ? 'not-allowed' : 'pointer'}">
        <input type="checkbox" style="width:auto;margin:0" data-person-role="${esc(r.name)}" ${hasRole ? 'checked' : ''} ${dis}>
        <span>${esc(r.label || r.name)}</span>
      </label>`;
    }).join(' ');
    const prevQ = qs('#person-search', c) ? qs('#person-search', c).value : '';

    c.innerHTML = `<div style="display:grid;grid-template-columns:minmax(250px,320px) 1fr;gap:14px;align-items:start">
      <div class="card" style="padding:12px">
        <div class="toolbar" style="margin:0 0 8px">
          <h3 style="margin:0;font-size:14px">Users (${people.length})</h3>
          <div class="spacer"></div>
          ${canManageUsers ? '<button class="primary sm" id="btn-people-new-user">+ New User</button>' : ''}
        </div>
        <div style="margin-bottom:6px">
          <input type="text" id="person-search" placeholder="Search user, role, store, site, tank..." value="${esc(prevQ)}" style="width:100%;box-sizing:border-box">
        </div>
        <div class="pill-row" style="margin-bottom:8px;gap:4px">
          <button class="btn sm ${statusFilter === 'all' ? 'primary' : ''}" data-pfilter="all" style="font-size:11px;padding:2px 8px">All</button>
          <button class="btn sm ${statusFilter === 'active' ? 'primary' : ''}" data-pfilter="active" style="font-size:11px;padding:2px 8px">Active</button>
          <button class="btn sm ${statusFilter === 'inactive' ? 'primary' : ''}" data-pfilter="inactive" style="font-size:11px;padding:2px 8px">Inactive</button>
        </div>
        <div class="table-wrap scroll" style="max-height:calc(100vh - 280px)">
          <table><tbody id="person-list-tbody"></tbody></table>
        </div>
      </div>

      <div>
        <div class="card" style="margin-bottom:12px;border-top:3px solid var(--accent, #2563eb)">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:10px">
            <div>
              <h2 style="margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span>${esc(u.full_name || u.username)}</span>
                ${u.active ? '<span class="badge green">Active</span>' : '<span class="badge red">Inactive</span>'}
                ${u.mfa_enabled ? '<span class="badge green" title="Two-Factor Sign-in enabled">🔒 2FA On</span>' : '<span class="badge" title="Two-Factor Sign-in not set up">2FA Off</span>'}
              </h2>
              <div class="muted" style="font-size:12px;margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span>Username: <code>${esc(u.username)}</code></span>
                <span>·</span>
                <span>🏠 ${esc(u.home_workshop_name || 'Main Workshop')}</span>
                <span>·</span>
                <span>Roles: ${u.roles.map((r) => `<span class="badge blue">${esc(r.label || r.name)}</span>`).join(' ') || '<span class="muted">None</span>'}</span>
                ${u.project_name ? `<span>·</span><span>Site: <span class="badge blue">🏗️ ${esc(u.project_name)}</span></span>` : ''}
                ${u.bulk_tank_name ? `<span>·</span><span>Bowser: <span class="badge amber">⛽ ${esc(u.bulk_tank_name)}</span></span>` : ''}
              </div>
            </div>
            ${canManageAccess ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn sm" id="btn-compare" title="Compare this person's access with another person or role">🔍 Compare</button>
              <button class="btn sm" id="btn-copy-from" ${isSelf || !canEditTarget ? 'disabled' : ''} title="Copy all overrides from another person">📋 Copy From...</button>
              <button class="btn sm" id="btn-reset-user" ${isSelf || !canEditTarget ? 'disabled' : ''} title="Remove all personal overrides and revert to role template">↺ Reset to Role</button>
              <button class="primary sm" id="btn-save-access" ${!canEditScope ? 'disabled' : ''}>💾 Save Access & Scope</button>
            </div>` : ''}
          </div>

          ${canManageUsers ? `<div style="display:flex;gap:6px;flex-wrap:wrap;padding:8px 10px;background:var(--bg-muted, #f8fafc);border:1px solid var(--border-light, #e2e8f0);border-radius:6px;margin-bottom:10px;align-items:center">
            <span class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;margin-right:4px">Account &amp; Security:</span>
            <button class="btn sm" id="btn-user-roles" ${!canEditTarget ? 'disabled' : ''}>🎭 Roles</button>
            <button class="btn sm" id="btn-user-workshop" ${!canEditTarget ? 'disabled' : ''}>🏠 Home Workshop</button>
            <button class="btn sm" id="btn-user-store-perms" ${!canEditTarget ? 'disabled' : ''}>🏪 Store Permissions</button>
            <button class="btn sm" id="btn-user-reset-pw" ${!canEditTarget ? 'disabled' : ''}>🔑 Reset Password</button>
            ${u.mfa_enabled ? `<button class="btn sm" id="btn-user-reset-2fa" ${!canEditTarget ? 'disabled' : ''} title="Lost or new phone">📱 Reset 2FA</button>` : ''}
            <button class="btn sm" id="btn-user-sessions">💻 Sessions</button>
            <div class="spacer"></div>
            <button class="btn sm ${u.active ? 'danger' : ''}" id="btn-user-toggle-active" ${isSelf || !canEditTarget ? 'disabled' : ''}>${u.active ? '⛔ Deactivate' : '✅ Activate'}</button>
          </div>` : ''}

          ${isSelf ? '<div class="card" style="background:#fffbeb;border-left:4px solid #f59e0b;padding:8px 12px;margin-bottom:10px;font-size:12px">⚠️ <b>Safety Rule:</b> You cannot modify your own access permissions or deactivate yourself.</div>' : ''}
          ${!canEditTarget ? '<div class="card err" style="padding:8px 12px;margin-bottom:10px;font-size:12px">⛔ Only an administrator can modify an administrator account.</div>' : ''}

          ${canManageAccess && allRoles.length ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;padding:10px 12px;border-radius:6px;margin-bottom:10px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:6px">
              <label style="font-size:11.5px;font-weight:700;color:#1e293b;margin:0">🎭 Assigned Roles (Click to toggle roles for this person):</label>
              ${rolesChanged ? '<span class="badge amber">Unsaved role changes — click Save Access & Scope</span>' : ''}
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">${rolesChipsHtml}</div>
          </div>` : ''}

          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(195px, 1fr));gap:10px;background:var(--bg-muted, #f8fafc);padding:10px;border-radius:6px;margin-bottom:10px">
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                <label style="font-size:11px;font-weight:600;margin:0">Assigned Store Permissions:</label>
                ${!canManageUsers ? `<button class="btn sm" id="btn-user-store-perms" type="button" style="padding:2px 7px;font-size:11px">🏪 Manage</button>` : ''}
              </div>
              <div style="min-height:28px;padding:4px 6px;background:var(--card-sub-bg, #fff);border:1px solid var(--border-light, #e2e8f0);border-radius:5px">
                ${storeBadgesHtml}
              </div>
            </div>
            ${canManageAccess ? `<div>
              <label style="font-size:11px;font-weight:600;margin-bottom:4px;display:block">🏗️ Assigned Project Site (Fuel/Site Scope):</label>
              <select id="user-project-id" style="width:100%" ${!canEditScope ? 'disabled' : ''}>
                <option value="">— All Projects / Head Office —</option>
                ${allProjects.map((p) => `<option value="${p.id}" ${curProjVal === String(p.id) ? 'selected' : ''}>${esc(p.name)} (${esc(p.code || p.id)})</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;margin-bottom:4px;display:block">⛽ Assigned Site Bowser / Bulk Tank:</label>
              <select id="user-bulk-tank-id" style="width:100%" ${!canEditScope ? 'disabled' : ''}>
                <option value="">— Any / Workshop Pump —</option>
                ${allTanks.map((t) => `<option value="${esc(t.id)}" ${curTankVal === String(t.id) ? 'selected' : ''}>${esc(t.name)} (${esc(t.code || t.id)})</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;margin-bottom:4px;display:block">🛢️ Fuel Console Role & Blind Stock:</label>
              <div style="display:flex;gap:6px;align-items:center">
                <select id="user-fuel-role" style="flex:1" ${!canEditScope ? 'disabled' : ''}>
                  <option value="">— Auto from Role —</option>
                  <option value="SITE_OPERATOR" ${curFuelRoleVal === 'SITE_OPERATOR' ? 'selected' : ''}>Site Fuel Operator</option>
                  <option value="WORKSHOP_FUEL" ${curFuelRoleVal === 'WORKSHOP_FUEL' ? 'selected' : ''}>Workshop Fuel Attendant</option>
                  <option value="FUEL_MANAGER" ${curFuelRoleVal === 'FUEL_MANAGER' ? 'selected' : ''}>Fuel Manager</option>
                  <option value="APPROVER" ${curFuelRoleVal === 'APPROVER' ? 'selected' : ''}>Fuel Approver</option>
                  <option value="VIEWER" ${curFuelRoleVal === 'VIEWER' ? 'selected' : ''}>Fuel Viewer</option>
                </select>
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap;margin:0" title="Hide running tank balance from this Site Fuel Operator">
                  <input type="checkbox" id="user-hide-stock" style="width:auto;margin:0" ${curHideStockVal ? 'checked' : ''} ${!canEditScope ? 'disabled' : ''}>
                  Hide Stock
                </label>
              </div>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;margin-bottom:4px;display:block">Personal Approval Limit (Rs):</label>
              <input type="number" id="user-limit" placeholder="Role template default" value="${u.approval_limit != null ? esc(u.approval_limit) : ''}" style="width:100%" ${!canEditScope ? 'disabled' : ''}>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;margin-bottom:4px;display:block">Temporary Access Until (Date):</label>
              <input type="date" id="user-until" value="${u.access_until ? esc(u.access_until.slice(0, 10)) : ''}" style="width:100%" ${!canEditScope ? 'disabled' : ''}>
            </div>` : ''}
          </div>
          ${canManageAccess && !isSelf && canEditTarget ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:6px">
            <span class="muted" style="font-size:11px;font-weight:600">⚡ Quick Presets:</span>
            <button class="btn sm" style="font-size:11px" data-quick-preset="all_full">Grant All 28 Full</button>
            <button class="btn sm" style="font-size:11px" data-quick-preset="all_view">Grant All 28 View</button>
            <button class="btn sm" style="font-size:11px" data-quick-preset="pump_operator">⛽ Site Pump Operator (4 Sections)</button>
            <button class="btn sm" style="font-size:11px" data-quick-preset="fuel_requester">📝 Site Fuel Requester Only</button>
            <button class="btn sm" style="font-size:11px" data-quick-preset="fuel_suite">⛽ Fuel, Readings &amp; Hire Full</button>
            <button class="btn sm" style="font-size:11px" data-quick-preset="workshop_suite">🔧 Workshop &amp; Stores Full</button>
            <button class="btn sm" style="font-size:11px" data-quick-preset="costing_suite">📊 Costing &amp; Reports Full</button>
          </div>` : ''}
          ${canManageAccess ? `<div style="margin-top:8px;padding:8px 10px;background:#f8fafc;border-radius:6px;border:1px dashed var(--border, #cbd5e1)">
            <label style="font-size:11px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px">
              <span>🛡️ Emergency Dual Clearance / SoD Justification (optional):</span>
              <span class="muted" style="font-weight:normal">(min 10 chars, required only when authorizing toxic combinations)</span>
            </label>
            <input type="text" id="user-sod-reason" placeholder="e.g. Approved temporary dual clearance during stockkeeper leave (Ref: SEC-2026-01)" style="width:100%;font-size:12px;box-sizing:border-box" ${isSelf || !canEditTarget ? 'disabled' : ''}>
          </div>` : ''}
        </div>

        ${groupCards}
      </div>
    </div>`;

    renderDirectoryRows();

    const searchInp = qs('#person-search', c);
    if (searchInp) {
      searchInp.oninput = () => renderDirectoryRows();
    }
    qsa('[data-pfilter]', c).forEach((btn) => {
      btn.onclick = () => {
        statusFilter = btn.dataset.pfilter;
        qsa('[data-pfilter]', c).forEach((b) => b.classList.toggle('primary', b.dataset.pfilter === statusFilter));
        renderDirectoryRows();
      };
    });

    qsa('[data-person-role]', c).forEach((chk) => {
      chk.onchange = () => {
        const rName = chk.dataset.personRole;
        if (chk.checked) selectedRolesSet.add(rName);
        else selectedRolesSet.delete(rName);
        rolesChanged = true;
        renderAll();
      };
    });

    qsa('[data-grp-set]', c).forEach((btn) => {
      btn.onclick = () => {
        const [grpId, lvl] = btn.dataset.grpSet.split(':');
        sections.filter((s) => (s.group || '').toLowerCase() === grpId.toLowerCase()).forEach((s) => {
          sectionEdits[s.key] = lvl;
        });
        renderAll();
      };
    });

    qsa('[data-quick-preset]', c).forEach((btn) => {
      btn.onclick = () => {
        const p = btn.dataset.quickPreset;
        if (p === 'all_full') sections.forEach((s) => { sectionEdits[s.key] = 'full'; (s.parts || []).forEach((pt) => { sectionEdits[pt.key] = 'full'; }); });
        else if (p === 'all_view') sections.forEach((s) => { sectionEdits[s.key] = 'view'; (s.parts || []).forEach((pt) => { sectionEdits[pt.key] = 'view'; }); });
        else if (p === 'pump_operator') {
          sections.forEach((s) => { sectionEdits[s.key] = 'none'; (s.parts || []).forEach((pt) => { sectionEdits[pt.key] = 'none'; }); });
          sectionEdits.fuel = 'add';
          sectionEdits.fuel_tanks = 'add';
        }
        else if (p === 'fuel_requester') {
          sections.forEach((s) => { sectionEdits[s.key] = 'none'; (s.parts || []).forEach((pt) => { sectionEdits[pt.key] = 'none'; }); });
          sectionEdits.fuel_transport = 'add';
        }
        else if (p === 'fuel_suite') ['fuel', 'fuel_transport', 'fuel_tanks', 'fuel_readings', 'fuel_prices', 'fuel_reports', 'fuel_alerts', 'hire', 'assets', 'services', 'filters', 'oil'].forEach((k) => { sectionEdits[k] = 'full'; });
        else if (p === 'workshop_suite') ['jobrequests', 'jobs', 'fabrication', 'outsourcing', 'services', 'stores', 'oil', 'batteries', 'filters', 'tools'].forEach((k) => { sectionEdits[k] = 'full'; });
        else if (p === 'costing_suite') ['dashboard', 'master_dashboard', 'costing', 'finance', 'hire', 'dailywork', 'reports'].forEach((k) => { sectionEdits[k] = 'full'; });
        toast('Preset staged — click Save Access & Scope to apply');
        renderAll();
      };
    });

    const newUserBtn = qs('#btn-people-new-user', c);
    if (newUserBtn) {
      newUserBtn.onclick = () => openNewUserWizard(rolesList, allStoreLocations, storeOptions, wsd, (created) => {
        renderPeopleAccess(c, created && created.id ? created.id : u.id);
      });
    }

    // Account lifecycle handlers
    const rolesBtn = qs('#btn-user-roles', c);
    if (rolesBtn) {
      rolesBtn.onclick = () => {
        const roleBoxes = rolesList.map((r) => `<label style="flex-direction:row;display:flex;gap:6px;align-items:flex-start;font-weight:normal;margin:6px 0">
          <input type="checkbox" style="width:auto;margin-top:3px" data-urole="${esc(r.name)}" ${uRoleNames.includes(r.name) ? 'checked' : ''}>
          <span><b>${esc(r.label || r.name)}</b>${r.description ? `<br><span class="muted" style="font-size:11px">${esc(r.description)}</span>` : ''}</span>
        </label>`).join('');
        modal(`Roles for ${esc(u.username)}`, roleBoxes + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save Roles</button></div>',
          (body, close) => {
            qs('#s', body).onclick = async () => {
              const pickedRoles = qsa('[data-urole]', body).filter((x) => x.checked).map((x) => x.dataset.urole);
              try {
                await api(`/users/${u.id}/roles`, { method: 'POST', body: { roles: pickedRoles } });
                close();
                toast('Roles saved');
                await renderPeopleAccess(c, u.id);
              } catch (e) { toast(e.message, 'err'); }
            };
          }
        );
      };
    }

    const wsBtn = qs('#btn-user-workshop', c);
    if (wsBtn) {
      wsBtn.onclick = () => {
        modal(`Home workshop — ${esc(u.username)}`, `${field('Workshop', 'workshop_id', { type: 'select', options: wsOptions(wsd), value: u.home_workshop_id || 1 })}
          <p class="muted">New job cards and requests raised by this user default to their home workshop.</p>
          <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`,
          (body, close) => {
            qs('#s', body).onclick = async () => {
              try {
                await api(`/users/${u.id}`, { method: 'PATCH', body: { workshop_id: formData(body).workshop_id } });
                close();
                toast('Home workshop updated');
                await renderPeopleAccess(c, u.id);
              } catch (e) { toast(e.message, 'err'); }
            };
          }
        );
      };
    }

    const resetPwBtn = qs('#btn-user-reset-pw', c);
    if (resetPwBtn) {
      resetPwBtn.onclick = () => {
        modal(`Reset password — ${esc(u.username)}`, `${field('Temporary password *', 'password', { type: 'password' })}
          <p class="muted">${esc(passwordHint())} ${esc(u.username)} is signed out everywhere and must choose a new password at next sign-in.</p>
          <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Reset Password</button></div>`,
          (body, close) => {
            qs('#s', body).onclick = async () => {
              try {
                await api(`/users/${u.id}`, { method: 'PATCH', body: { password: formData(body).password } });
                close();
                toast('Password reset');
              } catch (e) { toast(e.message, 'err'); }
            };
          }
        );
      };
    }

    const reset2faBtn = qs('#btn-user-reset-2fa', c);
    if (reset2faBtn) {
      reset2faBtn.onclick = async () => {
        if (!confirm(`Reset two-factor sign-in for ${u.username}? They are signed out, and set it up again with their new phone at next sign-in (if their role requires it).`)) return;
        try {
          await api(`/users/${u.id}/mfa-reset`, { method: 'POST' });
          toast('Two-factor sign-in reset');
          await renderPeopleAccess(c, u.id);
        } catch (e) { toast(e.message, 'err'); }
      };
    }

    const sessBtn = qs('#btn-user-sessions', c);
    if (sessBtn) {
      sessBtn.onclick = () => userSessionsModal(u);
    }

    const toggleActiveBtn = qs('#btn-user-toggle-active', c);
    if (toggleActiveBtn) {
      toggleActiveBtn.onclick = async () => {
        if (u.active && !confirm(`Deactivate ${u.username}? They are signed out at once and cannot sign in again until reactivated.`)) return;
        try {
          await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
          toast(u.active ? 'User deactivated' : 'User activated');
          await renderPeopleAccess(c, u.id);
        } catch (e) { toast(e.message, 'err'); }
      };
    }

    const btnStorePerms = qs('#btn-user-store-perms', c);
    if (btnStorePerms) {
      btnStorePerms.onclick = () => {
        userStoreAccessModal(u, async () => {
          await renderPeopleAccess(c, u.id);
        });
      };
    }

    qsa('[data-sec-lvl]', c).forEach((btn) => {
      btn.onclick = () => {
        const [secKey, lvl] = btn.dataset.secLvl.split(':');
        sectionEdits[secKey] = lvl;
        renderAll();
      };
    });

    qsa('[data-reset-sec]', c).forEach((btn) => {
      btn.onclick = () => {
        const secKey = btn.dataset.resetSec;
        sectionEdits[secKey] = null;
        renderAll();
      };
    });

    qsa('[data-pcap]', c).forEach((box) => {
      box.onchange = () => {
        capEdits[box.dataset.pcap] = box.checked;
        renderAll();
      };
    });

    const saveBtn = qs('#btn-save-access', c);
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const projVal = qs('#user-project-id', c) ? qs('#user-project-id', c).value : '';
        const tankVal = qs('#user-bulk-tank-id', c) ? qs('#user-bulk-tank-id', c).value : '';
        const fuelRoleVal = qs('#user-fuel-role', c) ? qs('#user-fuel-role', c).value : '';
        const hideStockVal = qs('#user-hide-stock', c) ? qs('#user-hide-stock', c).checked : false;
        const limitVal = qs('#user-limit', c).value.trim();
        const untilVal = qs('#user-until', c).value.trim();
        const sodReasonVal = qs('#user-sod-reason', c) ? qs('#user-sod-reason', c).value.trim() : '';

        const payload = {
          sections: sectionEdits,
          capabilities: capEdits,
          roles: rolesChanged ? Array.from(selectedRolesSet) : undefined,
          project_id: projVal || null,
          bulk_tank_id: tankVal || null,
          fuel_role: fuelRoleVal || null,
          hide_stock: hideStockVal,
          approval_limit: limitVal === '' ? null : Number(limitVal),
          access_until: untilVal || null,
          override_reason: sodReasonVal || null,
        };

        const executeSave = async (extraPayload = {}) => {
          try {
            saveBtn.disabled = true;
            saveBtn.innerText = 'Saving…';
            await api('/access/people/' + u.id + '/save', { method: 'POST', body: { ...payload, ...extraPayload } });
            toast(`Access & operational scope saved for ${u.full_name || u.username}`);
            await renderPeopleAccess(c, u.id);
          } catch (e) {
            saveBtn.disabled = false;
            saveBtn.innerText = '💾 Save Access & Scope';
            if (e.message && (e.message.includes('Segregation of Duties') || e.message.includes('SoD Conflict') || e.message.includes('SOD-'))) {
              modal('Emergency Dual Clearance Authorization', `
                <div style="margin-bottom:12px;padding:10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;color:#991b1b;font-size:13px">
                  <b>⚠️ Segregation of Duties (SoD) Conflict Detected:</b>
                  <p style="margin:6px 0 0;font-size:12px;white-space:pre-wrap">${esc(e.message)}</p>
                </div>
                <p style="font-size:13px;margin:0 0 8px">To authorize emergency dual clearance under SOX/GRC compliance, please provide an approved justification reason (minimum 10 characters):</p>
                <div style="margin-bottom:12px">
                  <textarea id="modal-sod-justification" rows="3" style="width:100%;box-sizing:border-box" placeholder="e.g. Approved temporary dual clearance during stockkeeper leave by Operations Manager (Ref: SEC-2026-42)"></textarea>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:8px">
                  <button class="btn" id="modal-sod-cancel">Cancel</button>
                  <button class="primary" id="modal-sod-submit">Authorize &amp; Save</button>
                </div>`,
                (mbody, close) => {
                  qs('#modal-sod-cancel', mbody).onclick = close;
                  qs('#modal-sod-submit', mbody).onclick = async () => {
                    const reason = (qs('#modal-sod-justification', mbody).value || '').trim();
                    if (reason.length < 10) {
                      return toast('Justification reason must be at least 10 characters', 'err');
                    }
                    close();
                    await executeSave({ override_reason: reason });
                  };
                }
              );
            } else {
              toast(e.message, 'err');
            }
          }
        };

        await executeSave();
      };
    }

    const resetBtn = qs('#btn-reset-user', c);
    if (resetBtn) {
      resetBtn.onclick = async () => {
        if (!confirm(`Reset all personal overrides for ${u.full_name || u.username} back to their role template defaults?`)) return;
        try {
          await api('/access/people/' + u.id + '/reset', { method: 'POST' });
          toast(`Reset ${u.username} to role template.`);
          await renderPeopleAccess(c, u.id);
        } catch (e) { toast(e.message, 'err'); }
      };
    }

    const copyBtn = qs('#btn-copy-from', c);
    if (copyBtn) {
      copyBtn.onclick = () => {
        const others = people.filter((p) => p.id != u.id && p.active);
        modal('Copy Access Overrides', `
          <p class="muted" style="margin-top:0">Copy all section clearance and capability overrides from another person to <b>${esc(u.full_name || u.username)}</b>.</p>
          <div style="margin-bottom:12px">
            <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Copy From Person:</label>
            <select id="source-user-select" style="width:100%">
              ${others.map((p) => `<option value="${p.id}">${esc(p.full_name || p.username)} (${esc(p.username)}) — ${p.overrides_count} override(s)</option>`).join('')}
            </select>
          </div>
          <div style="text-align:right">
            <button class="primary" id="btn-do-copy">Copy Overrides</button>
          </div>`,
          (body, close) => {
            qs('#btn-do-copy', body).onclick = async () => {
              const srcId = qs('#source-user-select', body).value;
              try {
                await api('/access/people/' + u.id + '/copy-from', {
                  method: 'POST',
                  body: { source_user_id: srcId },
                });
                close();
                toast('Access overrides copied');
                await renderPeopleAccess(c, u.id);
              } catch (e) { toast(e.message, 'err'); }
            };
          }
        );
      };
    }

    const compareBtn = qs('#btn-compare', c);
    if (compareBtn) {
      compareBtn.onclick = () => openCompareModal(u, people);
    }
  };

  renderAll();
}

// ---- Tab 1b: All-Persons Access Matrix (Quick Grid across all 31 users × 28 sections) ----
async function renderAllPersonsMatrix(c) {
  const data = await api('/access/people');
  const people = data.people || [];
  const sections = data.sections || [];
  const allRoles = data.all_roles || [];
  const allProjects = data.all_projects || [];
  const allTanks = data.all_tanks || [];
  const selectedIds = new Set();

  let searchQ = '';
  let roleFilter = '';
  let domainFilter = 'ALL';

  const NEXT_LVL = { none: 'view', view: 'add', add: 'edit', edit: 'full', full: 'none' };

  const draw = () => {
    const filteredPeople = people.filter((p) => {
      if (roleFilter && !p.roles.some((r) => r.name === roleFilter)) return false;
      if (searchQ) {
        const hay = `${p.full_name || ''} ${p.username || ''} ${p.project_name || ''} ${p.bulk_tank_name || ''} ${p.roles.map((r) => r.label || r.name).join(' ')}`.toLowerCase();
        if (!hay.includes(searchQ)) return false;
      }
      return true;
    });

    const visibleSections = domainFilter === 'ALL'
      ? sections
      : sections.filter((s) => (s.group || '').toLowerCase() === domainFilter.toLowerCase());

    const rowsHtml = filteredPeople.map((p) => {
      const isSelf = ME && ME.id == p.id;
      const isTargetAdmin = p.roles.some((r) => r.name === 'admin');
      const canModify = (!isSelf && (isAdmin() || !isTargetAdmin));
      const checked = selectedIds.has(p.id) ? 'checked' : '';
      const roleBadges = p.roles.map((r) => `<span class="badge blue" style="font-size:9.5px">${esc(r.label || r.name)}</span>`).join(' ');
      const scopeBadges = [
        p.project_name ? `<span class="badge" style="font-size:9.5px;background:#e0f2fe;color:#0369a1">🏗️ ${esc(p.project_name)}</span>` : '',
        p.bulk_tank_name ? `<span class="badge amber" style="font-size:9.5px">⛽ ${esc(p.bulk_tank_name)}</span>` : '',
        p.hide_stock ? `<span class="badge red" style="font-size:9px">🙈 Blind Stock</span>` : ''
      ].filter(Boolean).join(' ');

      const cells = visibleSections.map((s) => {
        const eff = (p.permissions && p.permissions[s.key]) || 'none';
        const isOv = p.user_overrides && p.user_overrides[s.key] !== undefined;
        return `<td style="text-align:center;padding:4px 3px;cursor:${canModify ? 'pointer' : 'not-allowed'};${isOv ? 'background:rgba(245,158,11,0.09);' : ''}"
          data-mcell="${p.id}:${esc(s.key)}:${eff}" title="${esc(p.full_name || p.username)} · ${esc(s.label)}: ${eff.toUpperCase()}${isOv ? ' (Custom Override)' : ' (Role Default)'} — Click to cycle">
          ${lvlChip(eff)}${isOv ? '<sup style="color:#d97706;font-weight:bold">*</sup>' : ''}
        </td>`;
      }).join('');

      return `<tr style="${p.active ? '' : 'opacity:.55'}">
        <td style="text-align:center"><input type="checkbox" style="width:auto" data-msel="${p.id}" ${checked} ${canModify ? '' : 'disabled'}></td>
        <td style="position:sticky;left:0;background:var(--surface,#fff);z-index:2;min-width:210px;border-right:2px solid var(--border,#e2e8f0)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px">
            <a href="#/access?tab=people&user=${p.id}" style="font-weight:600;text-decoration:none">${esc(p.full_name || p.username)}</a>
            <span class="muted" style="font-size:10px">${esc(p.username)}</span>
          </div>
          <div style="margin-top:2px;display:flex;gap:3px;flex-wrap:wrap">${roleBadges} ${scopeBadges}</div>
        </td>
        ${cells}
      </tr>`;
    }).join('');

    c.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:10px">
          <div>
            <h3 style="margin:0">👥 All-Persons Access Matrix (${filteredPeople.length} of ${people.length} People × ${visibleSections.length} Sections)</h3>
            <p class="muted" style="margin:2px 0 0;font-size:12px">Click any cell to cycle clearance (<b>None → View → Add → Edit → Full</b>), or select multiple people below to bulk-assign Roles, Project Sites, Bowsers, or Domain clearances.</p>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="search" id="mat-search" placeholder="Search person, role, site..." value="${esc(searchQ)}" style="width:200px">
            <select id="mat-role">
              <option value="">All Roles</option>
              ${allRoles.map((r) => `<option value="${esc(r.name)}" ${roleFilter === r.name ? 'selected' : ''}>${esc(r.label || r.name)}</option>`).join('')}
            </select>
            <select id="mat-domain">
              <option value="ALL" ${domainFilter === 'ALL' ? 'selected' : ''}>All 28 Sections</option>
              <option value="Operations" ${domainFilter === 'Operations' ? 'selected' : ''}>⚙️ Operations</option>
              <option value="Fleet" ${domainFilter === 'Fleet' ? 'selected' : ''}>🚛 Fleet, Fuel & Hire</option>
              <option value="Inventory" ${domainFilter === 'Inventory' ? 'selected' : ''}>📦 Inventory & Stores</option>
              <option value="Procurement" ${domainFilter === 'Procurement' ? 'selected' : ''}>🛒 Procurement</option>
              <option value="Analysis" ${domainFilter === 'Analysis' ? 'selected' : ''}>📊 Analysis & Costing</option>
              <option value="Admin" ${domainFilter === 'Admin' ? 'selected' : ''}>🛡️ Admin</option>
            </select>
          </div>
        </div>

        <!-- Bulk Action Toolbar -->
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:700;color:#1e293b">☑️ Selected (${selectedIds.size}):</span>
          <select id="bulk-add-role" style="font-size:12px">
            <option value="">+ Add Role…</option>
            ${allRoles.map((r) => `<option value="${esc(r.name)}">+ ${esc(r.label || r.name)}</option>`).join('')}
          </select>
          <select id="bulk-project" style="font-size:12px">
            <option value="__KEEP__">🏗️ Project Site (No change)</option>
            <option value="">— Clear Project Site —</option>
            ${allProjects.map((p) => `<option value="${p.id}">🏗️ ${esc(p.name)}</option>`).join('')}
          </select>
          <select id="bulk-tank" style="font-size:12px">
            <option value="__KEEP__">⛽ Site Bowser (No change)</option>
            <option value="">— Clear Bowser —</option>
            ${allTanks.map((t) => `<option value="${esc(t.id)}">⛽ ${esc(t.name)}</option>`).join('')}
          </select>
          <select id="bulk-domain" style="font-size:12px">
            <option value="">📂 Domain Preset…</option>
            <option value="ALL">All 28 Sections</option>
            <option value="Operations">⚙️ Operations</option>
            <option value="Fleet">🚛 Fleet, Fuel & Hire</option>
            <option value="Inventory">📦 Inventory & Stores</option>
            <option value="Procurement">🛒 Procurement</option>
            <option value="Analysis">📊 Analysis & Costing</option>
          </select>
          <select id="bulk-level" style="font-size:12px">
            <option value="">Level…</option>
            <option value="full">FULL</option>
            <option value="edit">EDIT</option>
            <option value="add">ADD</option>
            <option value="view">VIEW</option>
            <option value="none">NONE</option>
          </select>
          <button class="primary sm" id="btn-bulk-apply" ${selectedIds.size === 0 ? 'disabled' : ''}>⚡ Apply to ${selectedIds.size} Selected</button>
        </div>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <div class="table-wrap scroll" style="max-height:calc(100vh - 280px)">
          <table style="font-size:11.5px">
            <thead>
              <tr>
                <th style="width:32px;text-align:center"><input type="checkbox" id="mat-sel-all" style="width:auto"></th>
                <th style="position:sticky;left:0;background:var(--surface,#f8fafc);z-index:3;min-width:210px;border-right:2px solid var(--border,#e2e8f0)">Person / Roles / Site Scope</th>
                ${visibleSections.map((s) => `<th style="text-align:center;min-width:68px;white-space:nowrap" title="${esc(s.description || s.label)}"><div>${s.icon}</div><div style="font-size:10px">${esc(s.label)}</div></th>`).join('')}
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;

    qs('#mat-search', c).oninput = (e) => { searchQ = e.target.value.toLowerCase().trim(); draw(); };
    qs('#mat-role', c).onchange = (e) => { roleFilter = e.target.value; draw(); };
    qs('#mat-domain', c).onchange = (e) => { domainFilter = e.target.value; draw(); };

    const selAll = qs('#mat-sel-all', c);
    if (selAll) {
      selAll.onchange = () => {
        filteredPeople.forEach((p) => {
          const isSelf = ME && ME.id == p.id;
          const isTargetAdmin = p.roles.some((r) => r.name === 'admin');
          if (!isSelf && (isAdmin() || !isTargetAdmin)) {
            if (selAll.checked) selectedIds.add(p.id);
            else selectedIds.delete(p.id);
          }
        });
        draw();
      };
    }

    qsa('[data-msel]', c).forEach((chk) => {
      chk.onchange = () => {
        const uid = Number(chk.dataset.msel);
        if (chk.checked) selectedIds.add(uid);
        else selectedIds.delete(uid);
        draw();
      };
    });

    qsa('[data-mcell]', c).forEach((td) => {
      td.onclick = async () => {
        const [uidStr, secKey, curLvl] = td.dataset.mcell.split(':');
        const uid = Number(uidStr);
        const p = people.find((x) => x.id === uid);
        if (!p) return;
        const isSelf = ME && ME.id == p.id;
        const isTargetAdmin = p.roles.some((r) => r.name === 'admin');
        if (isSelf || (!isAdmin() && isTargetAdmin)) return toast('Cannot modify this account directly', 'err');

        const nextLvl = NEXT_LVL[curLvl] || 'view';
        try {
          await api('/access/people/' + uid + '/save', {
            method: 'POST',
            body: { sections: { [secKey]: nextLvl } }
          });
          p.permissions[secKey] = nextLvl;
          if (!p.user_overrides) p.user_overrides = {};
          p.user_overrides[secKey] = nextLvl;
          toast(`${p.username} · ${secKey} → ${nextLvl.toUpperCase()}`);
          draw();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });

    const applyBtn = qs('#btn-bulk-apply', c);
    if (applyBtn) {
      applyBtn.onclick = async () => {
        const addRole = qs('#bulk-add-role', c).value;
        const projVal = qs('#bulk-project', c).value;
        const tankVal = qs('#bulk-tank', c).value;
        const presetDom = qs('#bulk-domain', c).value;
        const presetLvl = qs('#bulk-level', c).value;

        const body = { userIds: Array.from(selectedIds) };
        if (addRole) body.addRole = addRole;
        if (projVal !== '__KEEP__') body.projectId = projVal;
        if (tankVal !== '__KEEP__') body.bulkTankId = tankVal;
        if (presetDom && presetLvl) {
          body.presetDomain = presetDom;
          body.presetLevel = presetLvl;
        }

        try {
          applyBtn.disabled = true;
          applyBtn.innerText = 'Applying…';
          const res = await api('/access/people/bulk-save', { method: 'POST', body });
          toast(`Updated ${res.updated_count} person(s)`);
          await renderAllPersonsMatrix(c);
        } catch (e) {
          toast(e.message, 'err');
          applyBtn.disabled = false;
        }
      };
    }
  };

  draw();
}

function openCompareModal(u, people) {
  modal(`Compare Access: ${esc(u.full_name || u.username)}`, `
    <div style="display:flex;gap:10px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <label style="margin:0;font-weight:600;font-size:12px">Compare with:</label>
      <select id="cmp-target-type" style="padding:4px 8px">
        <option value="user">Another Person</option>
        <option value="role">A Role Template</option>
      </select>
      <select id="cmp-target-val" style="flex:1;min-width:180px;padding:4px 8px"></select>
      <button class="primary sm" id="btn-run-cmp">Compare</button>
    </div>
    <div id="cmp-result"><div class="muted">Select comparison target and click Compare.</div></div>`,
    async (body) => {
      const typeSel = qs('#cmp-target-type', body);
      const valSel = qs('#cmp-target-val', body);
      const resDiv = qs('#cmp-result', body);

      const updateTargetOptions = async () => {
        if (typeSel.value === 'user') {
          valSel.innerHTML = people.filter((p) => p.id != u.id)
            .map((p) => `<option value="${p.id}">${esc(p.full_name || p.username)} (${esc(p.username)})</option>`).join('');
        } else {
          const rData = await api('/access/roles');
          valSel.innerHTML = rData.roles.map((r) => `<option value="${esc(r.name)}">${esc(r.label || r.name)}</option>`).join('');
        }
      };

      typeSel.onchange = updateTargetOptions;
      await updateTargetOptions();

      qs('#btn-run-cmp', body).onclick = async () => {
        try {
          resDiv.innerHTML = '<div class="muted">Comparing…</div>';
          const query = typeSel.value === 'user' ? `user1=${u.id}&user2=${valSel.value}` : `user1=${u.id}&role=${encodeURIComponent(valSel.value)}`;
          const res = await api('/access/compare?' + query);

          const targetTitle = res.target.type === 'user' ? (res.target.full_name || res.target.username) : res.target.label;

          const diffSections = res.sections.filter((s) => s.diff);

          const secRows = res.sections.map((s) => `
            <tr style="${s.diff ? 'background:#fffbeb;' : ''}">
              <td>${s.icon} <b>${esc(s.label)}</b></td>
              <td>${lvlChip(s.user1_level)}</td>
              <td>${lvlChip(s.target_level)}</td>
              <td>${s.diff ? '<span class="badge amber">Different</span>' : '<span class="muted">Same</span>'}</td>
            </tr>
          `).join('');

          const capRows = res.capabilities.map((c) => `
            <tr>
              <td><b>${esc(c.label)}</b><br><span class="muted" style="font-size:10px">${esc(c.key)}</span></td>
              <td>${c.user1_has ? '<span class="badge green">YES</span>' : '<span class="muted">NO</span>'}</td>
              <td>${c.target_has ? '<span class="badge green">YES</span>' : '<span class="muted">NO</span>'}</td>
            </tr>
          `).join('') || '<tr><td colspan="3" class="muted" style="text-align:center">No capability differences</td></tr>';

          resDiv.innerHTML = `
            <div style="margin-bottom:10px;padding:8px 12px;background:var(--bg-muted, #f8fafc);border-radius:6px;font-size:12px">
              Comparing <b>${esc(u.full_name || u.username)}</b> vs <b>${esc(targetTitle)}</b>:
              <b>${diffSections.length}</b> section(s) differ, <b>${res.capabilities.length}</b> special capability difference(s).
            </div>
            <h4 style="margin:10px 0 4px">23 Canonical Sections</h4>
            <div class="table-wrap scroll" style="max-height:220px">
              <table>
                <thead><tr><th>Section</th><th>${esc(u.username)}</th><th>${esc(targetTitle)}</th><th>Status</th></tr></thead>
                <tbody>${secRows}</tbody>
              </table>
            </div>
            <h4 style="margin:14px 0 4px">Capability Differences (${res.capabilities.length})</h4>
            <div class="table-wrap scroll" style="max-height:180px">
              <table>
                <thead><tr><th>Capability</th><th>${esc(u.username)}</th><th>${esc(targetTitle)}</th></tr></thead>
                <tbody>${capRows}</tbody>
              </table>
            </div>
          `;
        } catch (e) { resDiv.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
      };
    }
  );
}

// ---- Tab 3 Sub-view: Access Inspector (Sections & Stores) ---------------------
async function renderSectionsAudit(c, wantedSection, wantedStoreId) {
  const [matrixData, storeLocsRes] = await Promise.all([
    api('/access/section-matrix'),
    api('/store-locations').catch(() => [])
  ]);
  const allSections = (matrixData.matrix && matrixData.matrix.sections) || [];
  const allStores = Array.isArray(storeLocsRes) ? storeLocsRes : (storeLocsRes && storeLocsRes.stores) || [];
  const defSec = wantedSection || (allSections[0] ? allSections[0].key : 'dashboard');
  const defStore = wantedStoreId || (allStores[0] ? String(allStores[0].id) : '');
  let inspectorMode = wantedStoreId ? 'store' : 'section';

  const renderHeader = () => {
    c.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <div class="pill-row">
              <button class="btn sm ${inspectorMode === 'section' ? 'primary' : ''}" data-insp-mode="section">📂 By System Section (${allSections.length})</button>
              <button class="btn sm ${inspectorMode === 'store' ? 'primary' : ''}" data-insp-mode="store">🏪 By Store Location (${allStores.length})</button>
            </div>
            <p class="muted" style="margin:0;font-size:12px">
              ${inspectorMode === 'section' ? 'Instant answer to: Who can view, edit, or approve each system section?' : 'Instant answer to: Who can view, receive, issue, dispatch, or count in each physical store?'}
            </p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${inspectorMode === 'section'
              ? `<label style="font-weight:600;font-size:12px;margin:0">Section:</label>
                 <select id="sec-audit-select" style="padding:4px 10px;font-size:13px;font-weight:bold">
                   ${allSections.map((s) => `<option value="${s.key}" ${s.key === defSec ? 'selected' : ''}>${s.icon} ${esc(s.label)}</option>`).join('')}
                 </select>`
              : `<label style="font-weight:600;font-size:12px;margin:0">Store Location:</label>
                 <select id="store-audit-select" style="padding:4px 10px;font-size:13px;font-weight:bold">
                   ${allStores.map((st) => `<option value="${st.id}" ${String(st.id) === String(defStore) ? 'selected' : ''}>${esc(st.name)} (${esc(st.code)})</option>`).join('') || '<option value="">No stores configured</option>'}
                 </select>`}
          </div>
        </div>
      </div>
      <div id="sec-audit-content"><div class="muted">Loading inspector data…</div></div>
    `;

    qsa('[data-insp-mode]', c).forEach((b) => {
      b.onclick = () => {
        inspectorMode = b.dataset.inspMode;
        renderHeader();
        if (inspectorMode === 'section') loadSection(qs('#sec-audit-select', c).value);
        else loadStoreAudit(qs('#store-audit-select', c).value);
      };
    });
    const secSel = qs('#sec-audit-select', c);
    if (secSel) secSel.onchange = () => loadSection(secSel.value);
    const stSel = qs('#store-audit-select', c);
    if (stSel) stSel.onchange = () => loadStoreAudit(stSel.value);
  };

  const loadSection = async (secKey) => {
    const contentDiv = qs('#sec-audit-content', c);
    try {
      contentDiv.innerHTML = '<div class="muted">Loading section audit data…</div>';
      const data = await api('/access/sections/' + encodeURIComponent(secKey));
      const s = data.section;
      const people = data.people || [];

      const counts = { full: 0, edit: 0, add: 0, view: 0, none: 0 };
      people.forEach((p) => { counts[p.effective_level] = (counts[p.effective_level] || 0) + 1; });

      const rows = people.map((p) => {
        const roleStr = p.roles.map((r) => r.label || r.name).join(', ') || 'None';
        const isCustom = p.is_override;
        const capsBadges = (p.granted_caps || []).map((cap) => `<span class="badge" style="font-size:10px">${esc(cap)}</span>`).join(' ') || '<span class="muted">—</span>';
        return `
          <tr style="${p.effective_level === 'none' ? 'opacity:.5;' : ''}">
            <td><b>${esc(p.full_name || p.username)}</b><br><span class="muted" style="font-size:11px">${esc(p.username)}</span></td>
            <td><span class="muted">${esc(roleStr)}</span></td>
            <td>${esc(p.workshop || '—')}</td>
            <td>${lvlChip(p.effective_level)}</td>
            <td>${isCustom ? '<span class="badge amber">Custom Override</span>' : '<span class="muted">Role Default</span>'}</td>
            <td>${capsBadges}</td>
            <td>
              <button class="btn sm" data-manage-user="${p.id}" title="Open in Users & Access">Manage</button>
            </td>
          </tr>
        `;
      }).join('');

      contentDiv.innerHTML = `
        <div class="card" style="margin-bottom:12px;border-left:4px solid var(--accent, #2563eb)">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
            <div>
              <h2 style="margin:0;display:flex;align-items:center;gap:6px">
                <span>${s.icon}</span> <span>${esc(s.label)}</span>
              </h2>
              <p class="muted" style="margin:2px 0 0;font-size:12px">${esc(s.description || '')}</p>
            </div>
            <div class="pill-row">
              <span class="badge amber">Full: ${counts.full || 0}</span>
              <span class="badge green">Edit: ${counts.edit || 0}</span>
              <span class="badge blue">Add: ${counts.add || 0}</span>
              <span class="badge">View: ${counts.view || 0}</span>
              <span class="muted" style="font-size:11px">No access: ${counts.none || 0}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="table-wrap scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Roles</th>
                  <th>Workshop</th>
                  <th>Effective Level</th>
                  <th>Origin</th>
                  <th>Special Capabilities</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;

      qsa('[data-manage-user]', contentDiv).forEach((b) => {
        b.onclick = () => {
          location.hash = '#/access?tab=people&user=' + b.dataset.manageUser;
        };
      });
    } catch (e) {
      contentDiv.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
    }
  };

  const loadStoreAudit = async (storeId) => {
    const contentDiv = qs('#sec-audit-content', c);
    if (!storeId) {
      contentDiv.innerHTML = '<div class="card muted">No store locations found.</div>';
      return;
    }
    const store = allStores.find((s) => String(s.id) === String(storeId));
    try {
      contentDiv.innerHTML = '<div class="muted">Loading store permissions…</div>';
      const accessList = await api(`/store-locations/${storeId}/access`).catch(() => []);
      const rows = (Array.isArray(accessList) ? accessList : []).map((a) => `
        <tr>
          <td><b>${esc(a.full_name || a.username)}</b> <span class="muted" style="font-size:11px">(@${esc(a.username)})</span></td>
          <td style="text-align:center">${a.can_view ? '✅' : '<span class="muted">—</span>'}</td>
          <td style="text-align:center">${a.can_receive ? '✅' : '<span class="muted">—</span>'}</td>
          <td style="text-align:center">${a.can_issue ? '✅' : '<span class="muted">—</span>'}</td>
          <td style="text-align:center">${a.can_dispatch ? '✅' : '<span class="muted">—</span>'}</td>
          <td style="text-align:center">${a.can_count ? '✅' : '<span class="muted">—</span>'}</td>
          <td style="text-align:center">${a.can_request ? '✅' : '<span class="muted">—</span>'}</td>
          <td style="text-align:right">
            <button class="btn sm" data-manage-user="${a.user_id}">Manage User</button>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="8" class="muted" style="text-align:center;padding:16px">No explicit user restrictions assigned to this store yet.</td></tr>';

      contentDiv.innerHTML = `
        <div class="card" style="margin-bottom:12px;border-left:4px solid var(--accent, #2563eb)">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
            <div>
              <h2 style="margin:0;display:flex;align-items:center;gap:6px">
                <span>🏪</span> <span>${esc(store ? store.name : 'Store')}</span>
                ${store ? `<span class="badge">${esc(store.store_type || '')}</span>` : ''}
              </h2>
              <p class="muted" style="margin:2px 0 0;font-size:12px">Code: <code>${esc(store ? store.code : storeId)}</code> · ${(accessList || []).length} user(s) explicitly assigned</p>
            </div>
            <div>
              ${canDo('stores.locations.access') ? `<button class="primary sm" id="btn-edit-store-matrix">🔑 Edit Store Matrix</button>` : ''}
            </div>
          </div>
        </div>
        <div class="card">
          <div class="table-wrap scroll">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th style="text-align:center">View</th>
                  <th style="text-align:center">Receive</th>
                  <th style="text-align:center">Issue</th>
                  <th style="text-align:center">Dispatch</th>
                  <th style="text-align:center">Count</th>
                  <th style="text-align:center">Request</th>
                  <th style="text-align:right">Action</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;

      const editBtn = qs('#btn-edit-store-matrix', contentDiv);
      if (editBtn && typeof showStoreLocationAccessModal === 'function') {
        editBtn.onclick = () => showStoreLocationAccessModal(Number(storeId));
      }
      qsa('[data-manage-user]', contentDiv).forEach((b) => {
        b.onclick = () => {
          location.hash = '#/access?tab=people&user=' + b.dataset.manageUser;
        };
      });
    } catch (e) {
      contentDiv.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
    }
  };

  renderHeader();
  if (inspectorMode === 'store') await loadStoreAudit(defStore);
  else await loadSection(defSec);
}

// ===========================================================================
// SAP Enterprise User Activity Logs & Security Audit Trail (Z_WO_AUDIT)
// Standard: SAP NetWeaver Security Audit (SM20) & Application Log (SLG1)
// ===========================================================================

routes.auditlogs = async () => { location.hash = '#/access?tab=auditlogs'; };

async function openAuditDiffModal(id) {
  try {
    const d = await api(`/audit-logs/${id}`);
    const dateFormatted = d.created_at ? slDateTime(d.created_at, { seconds: true }) + ' (SLST)' : '—';
    const initials = (d.full_name || d.username || 'SY').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

    const diff = d.diff || { changed: {}, added: {}, removed: {}, unchanged: {} };
    const changedKeys = Object.keys(diff.changed);
    const addedKeys = Object.keys(diff.added);
    const removedKeys = Object.keys(diff.removed);
    const hasDiff = changedKeys.length > 0 || addedKeys.length > 0 || removedKeys.length > 0;

    let deltaTableRows = '';

    // 1. Changed fields (Yellow)
    for (const k of changedKeys) {
      const bVal = JSON.stringify(diff.changed[k].before);
      const aVal = JSON.stringify(diff.changed[k].after);
      deltaTableRows += `
        <tr style="background:#fefce8">
          <td style="font-weight:700;font-family:monospace;font-size:12px">${esc(k)}</td>
          <td style="color:#b91c1c;text-decoration:line-through;word-break:break-all;font-size:12px;font-family:monospace">${esc(bVal)}</td>
          <td style="color:#15803d;font-weight:600;word-break:break-all;font-size:12px;font-family:monospace">${esc(aVal)}</td>
          <td><span class="badge blue">Modified</span></td>
        </tr>`;
    }

    // 2. Added fields (Green)
    for (const k of addedKeys) {
      const aVal = JSON.stringify(diff.added[k]);
      deltaTableRows += `
        <tr style="background:#f0fdf4">
          <td style="font-weight:700;font-family:monospace;font-size:12px">${esc(k)}</td>
          <td class="muted" style="font-size:12px">—</td>
          <td style="color:#15803d;font-weight:600;word-break:break-all;font-size:12px;font-family:monospace">${esc(aVal)}</td>
          <td><span class="badge green">Added</span></td>
        </tr>`;
    }

    // 3. Removed fields (Red)
    for (const k of removedKeys) {
      const bVal = JSON.stringify(diff.removed[k]);
      deltaTableRows += `
        <tr style="background:#fef2f2">
          <td style="font-weight:700;font-family:monospace;font-size:12px">${esc(k)}</td>
          <td style="color:#b91c1c;text-decoration:line-through;word-break:break-all;font-size:12px;font-family:monospace">${esc(bVal)}</td>
          <td class="muted" style="font-size:12px">—</td>
          <td><span class="badge red">Removed</span></td>
        </tr>`;
    }

    const modalHtml = `
      <div style="font-size:13px">
        <!-- Event Meta Header -->
        <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(0,0,0,0.02);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:14px;flex-wrap:wrap;gap:10px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:36px;height:36px;border-radius:50%;background:#e0e7ff;color:#3730a3;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">
              ${esc(initials)}
            </div>
            <div>
              <div style="font-weight:700;color:var(--text)">${esc(d.full_name || d.username)} <span class="muted" style="font-size:11px">(@${esc(d.username)})</span></div>
              <div class="muted" style="font-size:11px">Event ID: <b>#${d.id}</b> · Location: ${esc(d.workshop_name || 'All Sites / Central')}</div>
            </div>
          </div>
          <div style="text-align:right">
            <div><span class="badge blue">${esc(d.entity)}</span> <span class="badge green">${esc(d.action)}</span> ${d.entity_id ? `<span class="badge" style="background:#f1f5f9">ID: ${esc(d.entity_id)}</span>` : ''}</div>
            <div class="muted" style="font-size:11px;margin-top:4px">📅 ${esc(dateFormatted)}</div>
          </div>
        </div>

        ${d.reason ? `<div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:10px 14px;border-radius:4px;margin-bottom:14px;font-size:12px"><b>Reason / Justification:</b> <i>${esc(d.reason)}</i></div>` : ''}

        <!-- Tab switches: Visual Delta vs Raw JSON -->
        <div style="display:flex;gap:8px;border-bottom:1px solid var(--border);margin-bottom:12px">
          <button class="btn sm primary" id="tab-btn-visual-diff">Visual Field Delta</button>
          <button class="btn sm" id="tab-btn-raw-before">Before State (JSON)</button>
          <button class="btn sm" id="tab-btn-raw-after">After State (JSON)</button>
        </div>

        <!-- 1. Visual Delta View -->
        <div id="diff-pane-visual">
          ${hasDiff ? `
            <div class="table-wrap scroll" style="max-height:360px">
              <table>
                <thead>
                  <tr>
                    <th style="width:25%">Property / Column</th>
                    <th style="width:35%">Previous Value (Before)</th>
                    <th style="width:35%">New Value (After)</th>
                    <th style="width:10%">Delta</th>
                  </tr>
                </thead>
                <tbody>${deltaTableRows}</tbody>
              </table>
            </div>
          ` : `
            <div class="card" style="text-align:center;padding:24px;background:#f8fafc">
              <div style="font-size:24px;margin-bottom:6px">ℹ️</div>
              <p class="muted" style="margin:0">No field mutations recorded for this event (e.g. read event, initial authentication, or raw event log).</p>
            </div>
          `}
        </div>

        <!-- 2. Raw JSON Before -->
        <div id="diff-pane-before" style="display:none">
          <pre style="background:#0f172a;color:#e2e8f0;padding:14px;border-radius:6px;max-height:360px;overflow:auto;font-size:11px;font-family:monospace">${esc(JSON.stringify(d.before, null, 2) || 'null')}</pre>
        </div>

        <!-- 3. Raw JSON After -->
        <div id="diff-pane-after" style="display:none">
          <pre style="background:#0f172a;color:#e2e8f0;padding:14px;border-radius:6px;max-height:360px;overflow:auto;font-size:11px;font-family:monospace">${esc(JSON.stringify(d.after, null, 2) || 'null')}</pre>
        </div>
      </div>
    `;

    modal(`Audit Event #${d.id} · ${d.entity} (${d.action})`, modalHtml, (body) => {
      const pVisual = qs('#diff-pane-visual', body);
      const pBefore = qs('#diff-pane-before', body);
      const pAfter = qs('#diff-pane-after', body);
      const bVisual = qs('#tab-btn-visual-diff', body);
      const bBefore = qs('#tab-btn-raw-before', body);
      const bAfter = qs('#tab-btn-raw-after', body);

      const selectTab = (activeBtn, activePane) => {
        [bVisual, bBefore, bAfter].forEach((b) => b.classList.remove('primary'));
        [pVisual, pBefore, pAfter].forEach((p) => { p.style.display = 'none'; });
        activeBtn.classList.add('primary');
        activePane.style.display = 'block';
      };

      bVisual.onclick = () => selectTab(bVisual, pVisual);
      bBefore.onclick = () => selectTab(bBefore, pBefore);
      bAfter.onclick = () => selectTab(bAfter, pAfter);
    }, { wide: true });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function renderAuditLogs(c, opts = {}) {
  const canViewAll = isAdmin() || canDo('audit.logs.view');
  const canViewAccessOnly = !canViewAll && canDo('access.manage');
  if (!canViewAll && !canViewAccessOnly) {
    c.innerHTML = `
      <div class="card" style="margin:24px;max-width:600px;border-left:4px solid #ef4444">
        <h3 style="color:#ef4444;margin:0 0 8px">🔒 Access Denied · Restricted Security Ledger</h3>
        <p class="muted" style="margin:0 0 16px">You do not have permission to view Security Audit Trail &amp; Activity Logs.</p>
        <a class="btn sm" href="#/dashboard">Return to Dashboard</a>
      </div>
    `;
    return;
  }

  const defaultCategory = !canViewAll ? 'access' : (opts.preset || 'all');
  const filters = {
    category: defaultCategory,
    userId: '',
    entity: 'all',
    action: 'all',
    dateFrom: '',
    dateTo: '',
    search: '',
    limit: 50,
    offset: 0,
  };

  let filterOptionsLoaded = false;
  let searchDebounceTimer = null;

  const presetButtonsHtml = canViewAll ? `
    <div class="pill-row">
      <button class="btn sm ${filters.category === 'all' ? 'primary' : ''}" data-audit-cat="all">All System Activity</button>
      <button class="btn sm ${filters.category === 'access' ? 'primary' : ''}" data-audit-cat="access">🔐 Access &amp; Role Changes</button>
      <button class="btn sm ${filters.category === 'auth' ? 'primary' : ''}" data-audit-cat="auth">🔑 Sign-ins &amp; Sessions</button>
      <button class="btn sm ${filters.category === 'critical' ? 'primary' : ''}" data-audit-cat="critical">🗑️ Critical Deletions</button>
    </div>` : `<div class="pill-row"><span class="badge blue">🔐 Scoped to Access, Roles &amp; Governance Events</span></div>`;

  const topHeaderHtml = opts.embedded ? `
    <div class="card" style="padding:10px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      ${presetButtonsHtml}
      <div style="display:flex;gap:8px">
        <button class="btn sm" id="btn-export-audit" title="Download Excel audit report">📥 Export to Excel</button>
        <button class="btn sm primary" id="btn-refresh-audit">🔄 Refresh</button>
      </div>
    </div>` : `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap;gap:12px">
      <div>
        <div class="crumb">Admin / Governance</div>
        <h1 style="margin:0;display:flex;align-items:center;gap:8px">
          <span>🛡️</span> User Activity Logs &amp; Security Audit Trail
        </h1>
        <div class="muted" style="font-size:12px;margin-top:4px">
          SAP NetWeaver Security Audit (SM20) &amp; Application Log (SLG1) compliant immutable audit ledger
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn sm" id="btn-export-audit" title="Download Excel audit report">📥 Export to Excel</button>
        <button class="btn sm primary" id="btn-refresh-audit">🔄 Refresh</button>
      </div>
    </div>
    <div style="margin-bottom:14px">${presetButtonsHtml}</div>`;

  c.innerHTML = `
    ${topHeaderHtml}

    <!-- 1. SAP Fiori Analytical KPI Cards -->
    <div id="audit-kpi-container" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;margin-bottom:16px">
      <div class="card" style="padding:14px;border-left:4px solid #3b82f6">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">${canViewAll ? 'Total System Events' : 'Access & Role Events'}</div>
        <div id="kpi-total" style="font-size:24px;font-weight:700;color:var(--text);margin:4px 0">...</div>
        <div class="muted" style="font-size:11px">All time recorded</div>
      </div>
      <div class="card" style="padding:14px;border-left:4px solid #10b981">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">Events Today</div>
        <div id="kpi-today" style="font-size:24px;font-weight:700;color:#059669;margin:4px 0">...</div>
        <div class="muted" style="font-size:11px">Daily volume</div>
      </div>
      <div class="card" style="padding:14px;border-left:4px solid #ef4444">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">Critical Mutations / Revokes</div>
        <div id="kpi-deletes" style="font-size:24px;font-weight:700;color:#dc2626;margin:4px 0">...</div>
        <div class="muted" style="font-size:11px">Void, revoke, deactivate &amp; delete</div>
      </div>
      ${canViewAll ? `<div class="card" style="padding:14px;border-left:4px solid #f59e0b">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">Sign-Ins Today</div>
        <div id="kpi-logins" style="font-size:24px;font-weight:700;color:#d97706;margin:4px 0">...</div>
        <div class="muted" style="font-size:11px"><span id="kpi-failed-logins" style="color:#ef4444">0</span> failed attempts</div>
      </div>` : ''}
      <div class="card" style="padding:14px;border-left:4px solid #8b5cf6">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">Active Actors Today</div>
        <div id="kpi-active-users" style="font-size:24px;font-weight:700;color:#7c3aed;margin:4px 0">...</div>
        <div class="muted" style="font-size:11px">Unique users performing actions</div>
      </div>
    </div>

    <!-- 2. SAP Fiori Smart Filter Bar -->
    <div class="card" style="padding:16px;margin-bottom:16px;background:var(--surface,#fff)">
      <div style="font-weight:700;font-size:13px;margin-bottom:12px;display:flex;align-items:center;gap:6px">
        <span>🔍</span> Smart Filter Bar
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;align-items:end">
        <div>
          <label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">Actor / User</label>
          <select id="flt-audit-user" style="width:100%;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--border)">
            <option value="">All Actors</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">Module / Entity</label>
          <select id="flt-audit-entity" style="width:100%;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--border)">
            <option value="all">All Modules</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">Action Type</label>
          <select id="flt-audit-action" style="width:100%;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--border)">
            <option value="all">All Actions</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">Date Range Preset</label>
          <select id="flt-audit-preset" style="width:100%;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--border)">
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="7days">Last 7 Days</option>
            <option value="30days">Last 30 Days</option>
            <option value="custom">Custom Dates</option>
          </select>
        </div>
        <div id="flt-custom-date-wrap" style="display:none;grid-column:span 2;gap:8px">
          <div style="flex:1">
            <label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">From Date</label>
            <input type="date" id="flt-audit-date-from" style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border)">
          </div>
          <div style="flex:1">
            <label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">To Date</label>
            <input type="date" id="flt-audit-date-to" style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border)">
          </div>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">Search Reason / Notes / Keyword</label>
          <input type="search" id="flt-audit-search" placeholder="Type keyword..." style="width:100%;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--border)">
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn sm" id="btn-reset-filters" style="width:100%">Clear Filters</button>
        </div>
      </div>
    </div>

    <!-- 3. Table & Pagination Container -->
    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,0.02)">
        <div id="audit-table-count" style="font-size:13px;font-weight:600;color:var(--text)">
          Loading records...
        </div>
        <div style="display:flex;align-items:center;gap:8px;font-size:12px">
          <span class="muted">Per page:</span>
          <select id="sel-audit-limit" style="font-size:12px;padding:2px 6px;border-radius:4px;border:1px solid var(--border)">
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </div>
      </div>

      <div id="audit-table-wrap">
        <div class="muted" style="padding:32px;text-align:center">Fetching security audit events...</div>
      </div>

      <div id="audit-pagination-bar" style="padding:10px 16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,0.01);font-size:12px">
      </div>
    </div>
  `;

  async function loadStats() {
    try {
      const s = await api('/audit-logs/stats');
      if (qs('#kpi-total', c)) qs('#kpi-total', c).innerText = (s.totalEvents || 0).toLocaleString();
      if (qs('#kpi-today', c)) qs('#kpi-today', c).innerText = (s.todayEvents || 0).toLocaleString();
      if (qs('#kpi-deletes', c)) qs('#kpi-deletes', c).innerText = (s.criticalDeletes || 0).toLocaleString();
      if (qs('#kpi-logins', c)) qs('#kpi-logins', c).innerText = (s.todayLogins || 0).toLocaleString();
      if (qs('#kpi-failed-logins', c)) qs('#kpi-failed-logins', c).innerText = s.failedLoginsToday || 0;
      if (qs('#kpi-active-users', c)) qs('#kpi-active-users', c).innerText = (s.activeUsersToday || 0).toLocaleString();
    } catch {}
  }

  async function loadLogs() {
    const wrap = qs('#audit-table-wrap', c);
    const countEl = qs('#audit-table-count', c);
    const pageBar = qs('#audit-pagination-bar', c);

    wrap.innerHTML = '<div class="muted" style="padding:32px;text-align:center">Loading security audit records...</div>';

    const p = new URLSearchParams();
    if (filters.category && filters.category !== 'all') p.set('category', filters.category);
    if (filters.userId) p.set('userId', filters.userId);
    if (filters.entity && filters.entity !== 'all') p.set('entity', filters.entity);
    if (filters.action && filters.action !== 'all') p.set('action', filters.action);
    if (filters.dateFrom) p.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) p.set('dateTo', filters.dateTo);
    if (filters.search) p.set('search', filters.search);
    p.set('limit', filters.limit);
    p.set('offset', filters.offset);

    try {
      const data = await api(`/audit-logs?${p.toString()}`);

      // Populate filter options if not loaded yet
      if (!filterOptionsLoaded && data.filterOptions) {
        filterOptionsLoaded = true;
        const uSel = qs('#flt-audit-user', c);
        const eSel = qs('#flt-audit-entity', c);
        const aSel = qs('#flt-audit-action', c);

        if (data.filterOptions.actors) {
          data.filterOptions.actors.forEach((a) => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.innerText = `${a.full_name || a.username} (@${a.username})`;
            uSel.appendChild(opt);
          });
        }
        if (data.filterOptions.entities) {
          data.filterOptions.entities.forEach((ent) => {
            const opt = document.createElement('option');
            opt.value = ent;
            opt.innerText = ent;
            eSel.appendChild(opt);
          });
        }
        if (data.filterOptions.actions) {
          data.filterOptions.actions.forEach((act) => {
            const opt = document.createElement('option');
            opt.value = act;
            opt.innerText = act;
            aSel.appendChild(opt);
          });
        }
      }

      const total = data.pagination.total || 0;
      const startIdx = total === 0 ? 0 : filters.offset + 1;
      const endIdx = Math.min(filters.offset + (data.logs || []).length, total);

      countEl.innerHTML = `Showing <b>${startIdx} - ${endIdx}</b> of <b>${total.toLocaleString()}</b> events`;

      if (!data.logs || !data.logs.length) {
        wrap.innerHTML = '<div class="muted" style="padding:32px;text-align:center">No audit log records match the current filter criteria.</div>';
        pageBar.innerHTML = '';
        return;
      }

      // Render table rows
      const rowsHtml = data.logs.map((r) => {
        const timeStr = slDateTime(r.created_at, { seconds: true });
        const initials = (r.full_name || r.username || 'SY').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();

        // Entity badge style
        let entColor = 'blue';
        if (r.entity === 'session' || r.entity === 'user') entColor = 'amber';
        else if (r.entity.includes('job')) entColor = 'blue';
        else if (r.entity.includes('store') || r.entity === 'mrn' || r.entity === 'issues') entColor = 'green';
        else if (r.entity.includes('tool') || r.entity === 'vehicle_documents') entColor = 'purple';

        // Action badge style
        let actClass = 'badge';
        let actStyle = 'background:#f1f5f9;color:#334155';
        if (/delete|void|scrap|revoke|lock/i.test(r.action)) {
          actStyle = 'background:#fee2e2;color:#991b1b;font-weight:600';
        } else if (/create|issue|receive|add/i.test(r.action)) {
          actStyle = 'background:#dcfce7;color:#166534;font-weight:600';
        } else if (/approve|sign|close/i.test(r.action)) {
          actStyle = 'background:#f3e8ff;color:#6b21a8;font-weight:600';
        } else if (/edit|update|move/i.test(r.action)) {
          actStyle = 'background:#e0f2fe;color:#0369a1;font-weight:600';
        }

        return `
          <tr>
            <td style="white-space:nowrap;font-size:11px;font-family:monospace;color:var(--text)">
              ${esc(timeStr)}
            </td>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                <div style="width:24px;height:24px;border-radius:50%;background:#e2e8f0;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;color:#475569">
                  ${esc(initials)}
                </div>
                <div>
                  <div style="font-weight:600;font-size:12px;color:var(--text)">${esc(r.username)}</div>
                  ${r.full_name && r.full_name !== r.username ? `<div class="muted" style="font-size:10px">${esc(r.full_name)}</div>` : ''}
                </div>
              </div>
            </td>
            <td style="font-size:11px">
              ${r.workshop_name ? `<span class="badge" style="background:#f8fafc;border:1px solid #cbd5e1">${esc(r.workshop_name)}</span>` : '<span class="muted">—</span>'}
            </td>
            <td>
              <span class="badge ${entColor}">${esc(r.entity)}</span>
              ${r.entity_id ? `<span class="muted" style="font-size:11px;margin-left:4px">#${esc(r.entity_id)}</span>` : ''}
            </td>
            <td>
              <span class="${actClass}" style="${actStyle}">${esc(r.action)}</span>
            </td>
            <td style="max-width:260px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.reason || '')}">
              ${r.reason ? esc(r.reason) : '<span class="muted">—</span>'}
            </td>
            <td>
              ${r.has_changes ? `<span class="badge" style="background:#f1f5f9;font-size:10px" title="${esc(r.changes_summary)}">Delta recorded</span>` : '<span class="muted" style="font-size:10px">—</span>'}
            </td>
            <td style="text-align:right">
              <button class="btn sm btn-view-diff" data-id="${r.id}" style="padding:2px 8px;font-size:11px">🔍 View Diff</button>
            </td>
          </tr>
        `;
      }).join('');

      wrap.innerHTML = `
        <div class="table-wrap scroll" style="max-height:calc(100vh - 360px)">
          <table>
            <thead>
              <tr>
                <th style="width:14%">Timestamp</th>
                <th style="width:18%">Actor</th>
                <th style="width:12%">Location</th>
                <th style="width:15%">Entity</th>
                <th style="width:12%">Action</th>
                <th style="width:15%">Reason / Note</th>
                <th style="width:10%">Changes</th>
                <th style="width:8%;text-align:right">Details</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      `;

      // Bind diff buttons
      qsa('.btn-view-diff', wrap).forEach((btn) => {
        btn.onclick = () => openAuditDiffModal(btn.dataset.id);
      });

      // Pagination controls
      const curPage = data.pagination.currentPage || 1;
      const totalPages = data.pagination.pages || 1;

      pageBar.innerHTML = `
        <div class="muted">Page <b>${curPage}</b> of <b>${totalPages}</b></div>
        <div style="display:flex;gap:6px">
          <button class="btn sm" id="btn-page-first" ${curPage <= 1 ? 'disabled' : ''}>« First</button>
          <button class="btn sm" id="btn-page-prev" ${curPage <= 1 ? 'disabled' : ''}>‹ Prev</button>
          <button class="btn sm" id="btn-page-next" ${curPage >= totalPages ? 'disabled' : ''}>Next ›</button>
          <button class="btn sm" id="btn-page-last" ${curPage >= totalPages ? 'disabled' : ''}>Last »</button>
        </div>
      `;

      const btnFirst = qs('#btn-page-first', pageBar);
      const btnPrev = qs('#btn-page-prev', pageBar);
      const btnNext = qs('#btn-page-next', pageBar);
      const btnLast = qs('#btn-page-last', pageBar);

      if (btnFirst) btnFirst.onclick = () => { filters.offset = 0; loadLogs(); };
      if (btnPrev) btnPrev.onclick = () => { filters.offset = Math.max(0, filters.offset - filters.limit); loadLogs(); };
      if (btnNext) btnNext.onclick = () => { filters.offset = filters.offset + filters.limit; loadLogs(); };
      if (btnLast) btnLast.onclick = () => { filters.offset = (totalPages - 1) * filters.limit; loadLogs(); };

    } catch (err) {
      wrap.innerHTML = `<div class="card err" style="margin:16px">Failed to load audit logs: ${esc(err.message)}</div>`;
    }
  }

  // Bind preset category pills & top level buttons
  qsa('[data-audit-cat]', c).forEach((btn) => {
    btn.onclick = () => {
      filters.category = btn.dataset.auditCat;
      filters.offset = 0;
      qsa('[data-audit-cat]', c).forEach((b) => b.classList.toggle('primary', b.dataset.auditCat === filters.category));
      loadLogs();
    };
  });
  qs('#btn-refresh-audit', c).onclick = () => { loadStats(); loadLogs(); };
  qs('#btn-export-audit', c).onclick = () => {
    const p = new URLSearchParams();
    if (filters.category && filters.category !== 'all') p.set('category', filters.category);
    if (filters.userId) p.set('userId', filters.userId);
    if (filters.entity && filters.entity !== 'all') p.set('entity', filters.entity);
    if (filters.action && filters.action !== 'all') p.set('action', filters.action);
    if (filters.dateFrom) p.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) p.set('dateTo', filters.dateTo);
    if (filters.search) p.set('search', filters.search);
    window.open(`/api/audit-logs/export.xlsx?${p.toString()}`, '_blank');
  };

  // Bind filters
  qs('#flt-audit-user', c).onchange = (e) => { filters.userId = e.target.value; filters.offset = 0; loadLogs(); };
  qs('#flt-audit-entity', c).onchange = (e) => { filters.entity = e.target.value; filters.offset = 0; loadLogs(); };
  qs('#flt-audit-action', c).onchange = (e) => { filters.action = e.target.value; filters.offset = 0; loadLogs(); };

  qs('#sel-audit-limit', c).onchange = (e) => {
    filters.limit = Number(e.target.value) || 50;
    filters.offset = 0;
    loadLogs();
  };

  qs('#flt-audit-preset', c).onchange = (e) => {
    const v = e.target.value;
    const cWrap = qs('#flt-custom-date-wrap', c);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    if (v === 'today') {
      cWrap.style.display = 'none';
      filters.dateFrom = todayStr;
      filters.dateTo = todayStr;
    } else if (v === 'yesterday') {
      cWrap.style.display = 'none';
      const y = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
      filters.dateFrom = y;
      filters.dateTo = y;
    } else if (v === '7days') {
      cWrap.style.display = 'none';
      const d7 = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      filters.dateFrom = d7;
      filters.dateTo = todayStr;
    } else if (v === '30days') {
      cWrap.style.display = 'none';
      const d30 = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      filters.dateFrom = d30;
      filters.dateTo = todayStr;
    } else if (v === 'custom') {
      cWrap.style.display = 'flex';
      return;
    } else {
      cWrap.style.display = 'none';
      filters.dateFrom = '';
      filters.dateTo = '';
    }
    filters.offset = 0;
    loadLogs();
  };

  qs('#flt-audit-date-from', c).onchange = (e) => { filters.dateFrom = e.target.value; filters.offset = 0; loadLogs(); };
  qs('#flt-audit-date-to', c).onchange = (e) => { filters.dateTo = e.target.value; filters.offset = 0; loadLogs(); };

  qs('#flt-audit-search', c).oninput = (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      filters.search = e.target.value.trim();
      filters.offset = 0;
      loadLogs();
    }, 300);
  };

  qs('#btn-reset-filters', c).onclick = () => {
    filters.category = defaultCategory;
    filters.userId = '';
    filters.entity = 'all';
    filters.action = 'all';
    filters.dateFrom = '';
    filters.dateTo = '';
    filters.search = '';
    filters.offset = 0;

    qsa('[data-audit-cat]', c).forEach((b) => b.classList.toggle('primary', b.dataset.auditCat === defaultCategory));
    qs('#flt-audit-user', c).value = '';
    qs('#flt-audit-entity', c).value = 'all';
    qs('#flt-audit-action', c).value = 'all';
    qs('#flt-audit-preset', c).value = 'all';
    qs('#flt-custom-date-wrap', c).style.display = 'none';
    qs('#flt-audit-date-from', c).value = '';
    qs('#flt-audit-date-to', c).value = '';
    qs('#flt-audit-search', c).value = '';

    loadLogs();
  };

  // Initial load
  loadStats();
  loadLogs();
}

async function renderRolesManager(c, wanted, mode = 'editor') {
  const viewMode = (mode === 'board' || mode === 'limits') ? 'board' : 'editor';

  const modeBarHtml = `
    <div class="card" style="padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div class="pill-row">
        <button class="btn sm ${viewMode === 'editor' ? 'primary' : ''}" data-rmode="editor">🛡️ Role Profile Editor</button>
        <button class="btn sm ${viewMode === 'board' ? 'primary' : ''}" data-rmode="board">📊 Compact Clearance Matrix &amp; Limits</button>
      </div>
      <div class="muted" style="font-size:12px">
        ${viewMode === 'editor' ? 'Configure section clearance, 2FA, approval limits &amp; granular capabilities per role' : 'Cross-role clearance grid and financial approval caps in one view'}
      </div>
    </div>
  `;

  if (viewMode === 'board') {
    c.innerHTML = `${modeBarHtml}<div id="role-board-wrap"></div><div id="role-limits-wrap" style="margin-top:14px"></div>`;
    qsa('[data-rmode]', c).forEach((b) => {
      b.onclick = () => {
        const spNow = new URLSearchParams(location.hash.split('?')[1] || '');
        const rParam = wanted || spNow.get('role') || '';
        location.hash = '#/access?tab=roles' + (rParam ? '&role=' + encodeURIComponent(rParam) : '') + '&mode=' + b.dataset.rmode;
      };
    });
    await Promise.all([
      renderClearanceBoard(qs('#role-board-wrap', c)),
      renderApprovalLimits(qs('#role-limits-wrap', c)),
    ]);
    return;
  }

  const [sm, limitsData] = await Promise.all([
    api('/access/section-matrix').catch(async () => {
      const [cat, board] = await Promise.all([api('/access/capabilities'), api('/access/matrix')]);
      return { domains: [], sections: [], capabilities: cat.capabilities, modules: cat.modules, roles: cat.roles, matrix: board };
    }),
    api('/access/approval-limits').catch(() => null),
  ]);
  const roles = sm.roles;
  const sel = roles.find((r) => r.name === wanted) || roles.find((r) => r.active && !r.locked) || roles[0];
  const board = sm.matrix;
  const modLabel = Object.fromEntries(sm.modules.map((m) => [m.key, m.label]));
  modLabel.users = 'Users & Access';
  const levelOf = (role, m) => (board.grid[role] && board.grid[role][m]) || 'none';
  const held = new Set(sel.caps);
  const mine = new Set(ME.caps || []);
  const editable = !sel.locked && sel.active;
  const totalCapsCount = sm.capabilities.length || 248;

  const roleList = roles.map((r) => `<tr data-pick="${esc(r.name)}" style="cursor:pointer;${r.name === sel.name ? 'background:#eef2ff;' : ''}${r.active ? '' : 'opacity:.55;'}">
    <td><b>${esc(r.label || r.name)}</b>${r.locked ? ' <span class="badge amber">everything</span>' : ''}${r.is_system ? '' : ' <span class="badge blue">custom</span>'}${r.active ? '' : ' <span class="badge">retired</span>'}${r.incomplete ? ' <span class="badge red" style="background:#fee2e2;color:#991b1b;border:1px solid #f87171" title="' + esc(r.incomplete_reason || 'Incomplete role: no actions granted') + '">⚠️ incomplete</span>' : ''}
    <br><span class="muted" style="font-size:11px">${r.users} user(s) · ${r.locked ? `all (${totalCapsCount})` : r.caps.length} permission(s)</span></td></tr>`).join('');

  // 6 SAP Operational Domains
  const domains = (sm.domains && sm.domains.length) ? sm.domains : [
    { id: 'Operations', name: 'Operations & Execution', icon: '⚙️', description: 'Workshop floor execution, job cards, breakdowns, field work, and daily technician labor' },
    { id: 'Fleet', name: 'Fleet Management', icon: '🚛', description: 'Equipment registry, statutory compliance, lubricant capacities, mechanic trades, and sites' },
    { id: 'Inventory', name: 'Inventory & Warehousing', icon: '📦', description: 'Central & site stores, MRN demands, tool control, bulk oils, and parts catalogue' },
    { id: 'Procurement', name: 'Procurement & Purchasing', icon: '🛒', description: 'Purchase requisitions, supplier orders, Tyre & Battery workflows' },
    { id: 'Analysis', name: 'Analysis & Intelligence', icon: '📊', description: 'Attention cockpit, daily progress, cost teardowns, and executive fleet analytics' },
    { id: 'Admin', name: 'Governance & Administration', icon: '🛡️', description: 'Workshop tenancies, access control profiles, and user credential management' }
  ];

  const sections = (sm.sections && sm.sections.length) ? sm.sections : [];

  const LVLS = ['none', 'view', 'add', 'edit', 'full'];
  const LV_LABEL = { none: 'None', view: 'View', add: 'Add', edit: 'Edit', full: 'Full' };

  const ACTVT_MAP = {
    '01': { label: '01 · Create', cls: 'badge teal' },
    '02': { label: '02 · Change', cls: 'badge blue' },
    '03': { label: '03 · Display', cls: 'badge' },
    '06': { label: '06 · Delete', cls: 'badge red' },
    '08': { label: '08 · Export', cls: 'badge purple' },
    '10': { label: '10 · Approve', cls: 'badge green' },
    'A1': { label: 'A1 · Certify', cls: 'badge amber' },
  };

  const heldCapsCount = sel.locked ? totalCapsCount : sel.caps.length;
  const heldPct = Math.round((heldCapsCount / totalCapsCount) * 100);

  // Group sections by domain
  const domainSectionsHtml = domains.map((dom) => {
    const domSections = sections.filter((s) => (s.domain || '').toLowerCase() === dom.id.toLowerCase());
    if (!domSections.length) return '';

    // Count capabilities in this domain
    const domCaps = sm.capabilities.filter((c) => (c.domain || '').toLowerCase() === dom.id.toLowerCase());
    const domHeld = domCaps.filter((c) => sel.locked || held.has(c.key)).length;

    const sectionsHtml = domSections.map((sec) => {
      const secCaps = sm.capabilities.filter((cap) => (cap.section === sec.id || (sec.modules || []).includes(cap.module) || cap.module === sec.id));
      const secHeld = secCaps.filter((c) => sel.locked || held.has(c.key)).length;

      // Module Clearance Control
      const modClearanceHtml = (sec.modules || []).map((m) => {
        const curLvl = levelOf(sel.name, m);
        const isLocked = sel.locked || !editable;
        const pills = LVLS.map((lvl) => {
          const isCurrent = (sel.locked && lvl === 'full') || (!sel.locked && curLvl === lvl);
          const cls = isCurrent ? (lvl === 'full' ? 'primary' : (lvl === 'edit' ? 'badge green' : (lvl === 'add' ? 'badge teal' : (lvl === 'view' ? 'badge blue' : 'badge amber')))) : 'btn sm';
          const style = isCurrent ? 'font-weight:bold;' : 'opacity:.7;';
          return `<button class="${cls}" style="${style}padding:2px 8px;font-size:11px" data-setlvl="${esc(m)}:${lvl}" ${isLocked ? 'disabled' : ''}>${LV_LABEL[lvl]}</button>`;
        }).join(' ');
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0">
          <span style="font-size:12px;font-weight:600">${esc(modLabel[m] || m)}:</span>
          <div style="display:flex;gap:4px">${pills}</div>
        </div>`;
      }).join('');

      // Preset Buttons
      const presetsHtml = (sec.presets && editable) ? `
        <div style="display:flex;align-items:center;gap:6px;margin:6px 0 8px;padding:4px 8px;background:var(--bg-muted, #f8f9fa);border-radius:4px;flex-wrap:wrap">
          <span class="muted" style="font-size:11px;font-weight:600">Quick Presets:</span>
          <button class="btn sm" data-preset="${esc(sec.id)}:none" title="Remove all access">❌ None</button>
          <button class="btn sm" data-preset="${esc(sec.id)}:view" title="Read-only clearance">👁️ Read-Only</button>
          <button class="btn sm" data-preset="${esc(sec.id)}:operator" title="Standard operator clearance">⚙️ Operator</button>
          <button class="btn sm" data-preset="${esc(sec.id)}:manager" title="Full clearance and manager capabilities">👑 Full Manager</button>
        </div>` : '';

      // Bulk section actions
      const bulkActionsHtml = editable ? `
        <div style="display:flex;gap:6px;align-items:center;margin:6px 0 8px">
          <button class="btn sm" data-bulk-cap="${esc(sec.id)}:grant" title="Grant all capabilities in this section" style="font-size:11px">+ Grant All (${secCaps.length})</button>
          <button class="btn sm" data-bulk-cap="${esc(sec.id)}:view" title="Grant view capability only" style="font-size:11px">👁️ View Only</button>
          <button class="btn sm danger" data-bulk-cap="${esc(sec.id)}:revoke" title="Revoke all capabilities in this section" style="font-size:11px">– Revoke All</button>
        </div>` : '';

      // Capabilities checkboxes
      const capListHtml = secCaps.map((cap) => {
        const has = sel.locked || held.has(cap.key);
        const canTick = editable && (has || isAdmin() || mine.has(cap.key));
        const needsMod = cap.needs;
        const currentModLvl = needsMod ? levelOf(sel.name, needsMod) : 'full';
        const short = (needsMod && !sel.locked && rankL(currentModLvl) < 2)
          ? ` <span class="badge amber" style="font-size:9px" title="Ticking this will auto-elevate ${esc(modLabel[needsMod] || needsMod)} to EDIT">auto-elevates ${esc(modLabel[needsMod] || needsMod)} to EDIT</span>` : '';
        const actvt = ACTVT_MAP[cap.actvt] || { label: cap.actvt || '02', cls: 'badge' };
        const dualAuthBadge = cap.dualAuth ? `<span class="badge amber" style="font-size:9px;font-weight:600" title="Mandatory 4-Eyes Dual Authorization Required">👥 4-Eyes Dual Auth</span> ` : '';

        return `<div class="cap-row" data-cap-key="${esc(cap.key)}" data-actvt="${esc(cap.actvt || '02')}" data-dual="${cap.dualAuth ? '1' : '0'}" style="display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-light, #f1f5f9)">
          <input type="checkbox" style="width:auto;margin-top:3px" data-cap="${esc(cap.key)}" data-needs="${esc(cap.needs || '')}" ${has ? 'checked' : ''} ${canTick ? '' : 'disabled'}>
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span class="${actvt.cls}" style="font-size:10px;font-family:monospace">${actvt.label}</span>
              ${dualAuthBadge}
              <span style="font-size:13px;font-weight:500">${esc(cap.label)}</span>
              ${short}
            </div>
            <div style="font-size:11px;color:var(--text-muted, #64748b);font-family:monospace;margin-top:1px">${esc(cap.key)}</div>
          </div>
        </div>`;
      }).join('');

      return `
        <div class="card section-card" data-section-id="${esc(sec.id)}" style="margin-bottom:10px;background:var(--card-sub-bg, #fff);border:1px solid var(--border-light, #e2e8f0);border-radius:6px;padding:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:18px">${sec.icon || '📁'}</span>
              <div>
                <b style="font-size:14px">${esc(sec.name)}</b>
                <div class="muted" style="font-size:11px">${esc(sec.description || '')}</div>
              </div>
            </div>
            <span class="badge blue" style="font-size:11px">${secHeld} / ${secCaps.length} granted</span>
          </div>

          ${modClearanceHtml ? `
          <div style="background:var(--bg-muted, #f8fafc);border:1px solid var(--border-light, #eee);border-radius:6px;padding:6px 10px;margin-bottom:8px">
            <div class="muted" style="font-size:10px;font-weight:600;margin-bottom:2px;text-transform:uppercase">Section Clearance:</div>
            ${modClearanceHtml}
          </div>` : ''}

          ${presetsHtml}
          ${bulkActionsHtml}

          <div style="margin-top:8px">
            <div class="muted" style="font-size:10px;font-weight:600;margin-bottom:4px;text-transform:uppercase">Granular Capabilities (${secCaps.length}):</div>
            <div class="caps-list" style="max-height:280px;overflow-y:auto;padding-right:4px">
              ${capListHtml || '<span class="muted" style="font-size:12px">No capabilities configured</span>'}
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <details open class="domain-accordion card" data-domain-id="${esc(dom.id)}" style="margin-bottom:14px;border:1px solid var(--border-light, #cbd5e1);border-radius:8px;padding:0;overflow:hidden">
        <summary style="cursor:pointer;padding:12px 16px;background:var(--bg-muted, #f1f5f9);display:flex;align-items:center;justify-content:space-between;user-select:none;font-weight:600">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:20px">${dom.icon}</span>
            <div>
              <span style="font-size:15px;color:var(--text-normal, #1e293b)">${esc(dom.name)}</span>
              <div class="muted" style="font-size:11px;font-weight:normal">${esc(dom.description || '')}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="badge ${domHeld > 0 ? 'green' : ''}" style="font-size:12px">${domHeld} / ${domCaps.length} granted</span>
            <span class="muted" style="font-size:12px">▾</span>
          </div>
        </summary>
        <div style="padding:14px">
          ${sectionsHtml}
        </div>
      </details>`;
  }).join('');

  const selLimitRole = (limitsData && limitsData.roles || []).find((lr) => lr.name === sel.name);
  const limitKinds = (limitsData && limitsData.kinds) || [];
  const mineRoles = new Set(ME.roles || []);
  const limitLockedForSelf = !isAdmin() && mineRoles.has(sel.name);
  const activeLimitKinds = selLimitRole
    ? limitKinds.filter((k) => selLimitRole.gives[k.key] || selLimitRole.limits[k.key] != null)
    : [];
  const inlineLimitsHtml = (!sel.locked && limitsData) ? (activeLimitKinds.length
    ? `<div style="margin-top:10px;padding:8px 10px;background:var(--bg-muted, #f8fafc);border:1px solid var(--border-light, #e2e8f0);border-radius:6px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted, #475569);margin-bottom:6px">💰 Role Financial Approval Limits (Rs) <span class="muted" style="font-weight:normal;text-transform:none">(Leave empty = no limit; checked on sign-off)</span></div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
          ${activeLimitKinds.map((k) => {
            const v = selLimitRole.limits[k.key];
            return `<label style="display:flex;align-items:center;gap:6px;margin:0;font-size:12px;font-weight:500">
              <span>${esc(k.label)}:</span>
              <input type="number" min="0" step="1" style="max-width:140px" placeholder="No limit" data-inline-limit-kind="${esc(k.key)}" value="${v == null ? '' : esc(v)}" data-was="${v == null ? '' : esc(v)}" ${limitLockedForSelf ? 'disabled title="Your own role — ask an admin"' : ''}>
            </label>`;
          }).join('')}
        </div>
      </div>`
    : `<div class="muted" style="font-size:11px;margin-top:6px">💰 Financial approval limits: No MRN approve or job close capabilities granted on this role yet.</div>`) : '';

  c.innerHTML = `${modeBarHtml}<div style="display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:14px;align-items:start">
    <div class="card">
      <div class="toolbar" style="margin:0 0 8px">
        <h3 style="margin:0">Roles</h3><div class="spacer"></div>
        <button class="primary sm" id="newrole">+ New Role</button>
      </div>
      <div style="margin-bottom:8px">
        <input type="text" id="role-search" placeholder="Search roles..." class="input sm" style="width:100%;box-sizing:border-box">
      </div>
      <div class="table-wrap scroll" style="max-height:calc(100vh - 260px)">
        <table id="role-table"><tbody>${roleList}</tbody></table>
      </div>
    </div>

    <div>
      <div class="card" style="margin-bottom:12px;border-top:3px solid var(--accent, #2563eb)">
        <div class="toolbar" style="margin:0">
          <div>
            <h2 style="margin:0;display:flex;align-items:center;gap:8px">
              <span>${esc(sel.label || sel.name)}</span>
              ${sel.locked ? '<span class="badge amber">System Admin</span>' : (sel.is_system ? '<span class="badge blue">Standard Role</span>' : '<span class="badge purple">Custom Role</span>')}
              ${sel.active ? '' : '<span class="badge red">Retired</span>'}
            </h2>
          </div>
          <div class="spacer"></div>
          ${sel.locked ? '' : `<button class="sm" id="editrole">✎ Rename / describe</button>
          ${sel.active ? '<button class="sm danger" id="retirerole">Retire</button>' : '<button class="sm" id="reinstaterole">Reinstate</button>'}`}
        </div>

        <div style="display:flex;align-items:center;gap:12px;margin:10px 0 8px;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
              <b>Granular Capabilities Coverage:</b>
              <span><b>${heldCapsCount}</b> / ${totalCapsCount} (${heldPct}%)</span>
            </div>
            <div style="height:8px;background:var(--border-light, #e2e8f0);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${heldPct}%;background:var(--accent, #2563eb);transition:width .3s ease"></div>
            </div>
          </div>
        </div>

        <label style="flex-direction:row;display:flex;gap:6px;align-items:center;margin:8px 0 0;font-weight:normal">
          <input type="checkbox" id="rolemfa" style="width:auto" ${sel.require_mfa ? 'checked' : ''} ${sel.active && (!sel.locked || isAdmin()) ? '' : 'disabled'}>
          Require two-factor sign-in for everyone with this role <span class="muted" style="font-size:12px">— recommended for approvers and financial roles</span>
        </label>
        ${inlineLimitsHtml}
        <p class="muted" style="margin:8px 0 0">${esc(sel.description || '')}${sel.description ? '<br>' : ''}Key <code>${esc(sel.name)}</code> · held by ${sel.users} active user(s).
          ${sel.locked ? ' System Administrator always holds every capability and cannot be altered.' : ''}
          ${editable ? ' Single-point SAP Fiori Access: configure section clearance and granular action permissions across the 6 Operational Domains below.' : ''}</p>
      </div>

      <!-- SAP Capability Search & Filter Bar -->
      <div class="card" style="margin-bottom:12px;padding:10px 14px;background:var(--card-sub-bg, #f8fafc)">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <input type="search" id="cap-filter-input" placeholder="🔍 Filter ${totalCapsCount} capabilities (e.g. scrap, delete, wage, mrn, asset, actvt 06)..." style="flex:1;min-width:220px;padding:6px 12px;border:1px solid var(--border-light, #cbd5e1);border-radius:6px">
          <div style="display:flex;gap:4px;flex-wrap:wrap" id="actvt-filter-bar">
            <button class="btn sm active" data-actvt-filter="all">All</button>
            <button class="btn sm" data-actvt-filter="01">01 Create</button>
            <button class="btn sm" data-actvt-filter="02">02 Change</button>
            <button class="btn sm" data-actvt-filter="03">03 View</button>
            <button class="btn sm" data-actvt-filter="06">06 Delete</button>
            <button class="btn sm" data-actvt-filter="08">08 Export</button>
            <button class="btn sm" data-actvt-filter="10">10 Approve</button>
            <button class="btn sm" data-actvt-filter="dual">👥 Dual Auth</button>
          </div>
        </div>
      </div>

      <div id="domains-container">
        ${domainSectionsHtml}
      </div>
    </div>
  </div>`;

  qsa('[data-rmode]', c).forEach((b) => {
    b.onclick = () => {
      location.hash = '#/access?tab=roles&role=' + encodeURIComponent(sel.name) + '&mode=' + b.dataset.rmode;
    };
  });

  qsa('[data-inline-limit-kind]', c).forEach((inp) => {
    inp.onchange = async () => {
      const val = inp.value.trim();
      if (val === inp.dataset.was) return;
      try {
        await api('/access/approval-limits', { method: 'PUT', body: { role: sel.name, kind: inp.dataset.inlineLimitKind, max_amount: val === '' ? null : val } });
        inp.dataset.was = val;
        toast(val === '' ? 'No limit' : `Limit saved: ${money(val)}`);
      } catch (e) { inp.value = inp.dataset.was; toast(e.message, 'err'); }
    };
  });

  const reload = (name) => { location.hash = '#/access?tab=roles&role=' + encodeURIComponent(name || sel.name) + '&mode=' + viewMode; };
  qsa('[data-pick]', c).forEach((tr) => { tr.onclick = () => reload(tr.dataset.pick); });

  if (qs('#role-search', c)) {
    qs('#role-search', c).oninput = (e) => {
      const q = e.target.value.toLowerCase().trim();
      qsa('#role-table tr', c).forEach((tr) => {
        tr.style.display = (!q || tr.textContent.toLowerCase().includes(q)) ? '' : 'none';
      });
    };
  }

  // Capability search and activity badge filter
  const filterCaps = () => {
    const q = (qs('#cap-filter-input', c)?.value || '').toLowerCase().trim();
    const actvt = qs('#actvt-filter-bar .active', c)?.dataset.actvtFilter || 'all';

    qsa('.domain-accordion', c).forEach((domEl) => {
      let domVisibleCount = 0;
      qsa('.section-card', domEl).forEach((secEl) => {
        let secVisibleCount = 0;
        qsa('.cap-row', secEl).forEach((row) => {
          const text = row.textContent.toLowerCase();
          const rowActvt = row.dataset.actvt;
          const isDual = row.dataset.dual === '1';

          let matchesQ = !q || text.includes(q);
          let matchesActvt = actvt === 'all' ||
            (actvt === 'dual' ? isDual : rowActvt === actvt);

          const visible = matchesQ && matchesActvt;
          row.style.display = visible ? 'flex' : 'none';
          if (visible) secVisibleCount++;
        });

        secEl.style.display = (secVisibleCount > 0 || (!q && actvt === 'all')) ? '' : 'none';
        if (secVisibleCount > 0) domVisibleCount += secVisibleCount;
      });

      domEl.style.display = (domVisibleCount > 0 || (!q && actvt === 'all')) ? '' : 'none';
      if (q || actvt !== 'all') domEl.open = true;
    });
  };

  if (qs('#cap-filter-input', c)) qs('#cap-filter-input', c).oninput = filterCaps;

  qsa('#actvt-filter-bar button', c).forEach((btn) => {
    btn.onclick = () => {
      qsa('#actvt-filter-bar button', c).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      filterCaps();
    };
  });

  // Role 2FA toggle
  if (qs('#rolemfa', c)) {
    qs('#rolemfa', c).onchange = async (e) => {
      const on = e.target.checked;
      if (on && !confirm(`Everyone with "${sel.label || sel.name}" will have to set up two-factor sign-in before they can use the system. Continue?`)) { e.target.checked = false; return; }
      try { await api('/access/roles/' + encodeURIComponent(sel.name), { method: 'PATCH', body: { require_mfa: on } }); toast(on ? 'Two-factor sign-in required for this role' : 'No longer required'); reload(); }
      catch (err) { e.target.checked = !on; toast(err.message, 'err'); }
    };
  }

  // Direct section clearance level buttons
  qsa('[data-setlvl]', c).forEach((btn) => {
    btn.onclick = async () => {
      const [mod, lvl] = btn.dataset.setlvl.split(':');
      try {
        await api('/access/section-save', {
          method: 'POST',
          body: { role: sel.name, modules: { [mod]: lvl } }
        });
        toast(`${modLabel[mod] || mod} clearance set to ${lvl.toUpperCase()}`);
        await renderRolesManager(c, sel.name);
      } catch (err) { toast(err.message, 'err'); }
    };
  });

  // Section quick presets
  qsa('[data-preset]', c).forEach((btn) => {
    btn.onclick = async () => {
      const [secId, presetKey] = btn.dataset.preset.split(':');
      const sec = sections.find((s) => s.id === secId);
      if (!sec || !sec.presets || !sec.presets[presetKey]) return;
      const p = sec.presets[presetKey];
      const secCaps = sm.capabilities.filter((cap) => (cap.section === sec.id || (sec.modules || []).includes(cap.module) || cap.module === sec.id));
      const capUpdates = {};
      for (const cap of secCaps) {
        capUpdates[cap.key] = p.caps.includes(cap.key);
      }
      try {
        await api('/access/section-save', {
          method: 'POST',
          body: { role: sel.name, modules: p.modules, capabilities: capUpdates }
        });
        toast(`Applied ${presetKey.toUpperCase()} preset to ${sec.name}`);
        await renderRolesManager(c, sel.name);
      } catch (err) { toast(err.message, 'err'); }
    };
  });

  // Bulk section action buttons
  qsa('[data-bulk-cap]', c).forEach((btn) => {
    btn.onclick = async () => {
      const [secId, action] = btn.dataset.bulkCap.split(':');
      const sec = sections.find((s) => s.id === secId);
      if (!sec) return;
      const secCaps = sm.capabilities.filter((cap) => (cap.section === sec.id || (sec.modules || []).includes(cap.module) || cap.module === sec.id));
      const capUpdates = {};
      const modUpdates = {};

      if (action === 'grant') {
        for (const cap of secCaps) {
          capUpdates[cap.key] = true;
          if (cap.needs) modUpdates[cap.needs] = 'edit';
        }
      } else if (action === 'revoke') {
        for (const cap of secCaps) capUpdates[cap.key] = false;
      } else if (action === 'view') {
        for (const cap of secCaps) {
          capUpdates[cap.key] = cap.actvt === '03' || cap.key.endsWith('.view');
        }
        for (const m of (sec.modules || [])) modUpdates[m] = 'view';
      }

      try {
        await api('/access/section-save', {
          method: 'POST',
          body: { role: sel.name, modules: modUpdates, capabilities: capUpdates }
        });
        toast(`Updated capabilities for ${sec.name}`);
        await renderRolesManager(c, sel.name);
      } catch (err) { toast(err.message, 'err'); }
    };
  });

  // Checkbox toggling with auto-elevation if required
  qsa('[data-cap]', c).forEach((box) => {
    box.onchange = async () => {
      const capKey = box.dataset.cap;
      const needs = box.dataset.needs;
      const willGrant = box.checked;
      const modUpdates = {};
      if (willGrant && needs && rankL(levelOf(sel.name, needs)) < 2) {
        modUpdates[needs] = 'edit';
      }
      try {
        if (Object.keys(modUpdates).length) {
          await api('/access/section-save', {
            method: 'POST',
            body: { role: sel.name, modules: modUpdates, capabilities: { [capKey]: willGrant } }
          });
          toast(`Granted ${capKey} and elevated ${modLabel[needs] || needs} to EDIT`);
        } else {
          await api('/access/section-save', {
            method: 'POST',
            body: { role: sel.name, capabilities: { [capKey]: willGrant } }
          });
          toast(willGrant ? `Granted ${capKey}` : `Revoked ${capKey}`);
        }
        await renderRolesManager(c, sel.name);
      } catch (e) { box.checked = !box.checked; toast(e.message, 'err'); }
    };
  });

  if (qs('#newrole', c)) qs('#newrole', c).onclick = () => modal('New role', `
    ${field('Name *', 'label', { placeholder: 'e.g. Site Storekeeper' })}
    ${field('What this role is for', 'description', { type: 'textarea' })}
    ${field('Start from', 'clone_from', { type: 'select', options: [{ value: '', label: '— no permissions (tick them after) —' }]
      .concat(roles.filter((r) => !r.locked && r.active).map((r) => ({ value: r.name, label: 'a copy of ' + (r.label || r.name) }))) })}
    <p class="muted">A copy takes the other role's permissions and section clearance. You can then change either.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create</button></div>`,
    (body, close) => {
      qs('#s', body).onclick = async () => {
        const d = formData(body);
        try { const r = await api('/access/roles', { method: 'POST', body: d }); close(); toast('Role created'); reload(r.name); }
        catch (e) { toast(e.message, 'err'); }
      };
    });

  if (qs('#editrole', c)) qs('#editrole', c).onclick = () => modal('Rename / describe', `
    ${field('Name *', 'label', { value: sel.label || '' })}
    ${field('What this role is for', 'description', { type: 'textarea', value: sel.description || '' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`,
    (body, close) => {
      qs('#s', body).onclick = async () => {
        try { await api('/access/roles/' + encodeURIComponent(sel.name), { method: 'PATCH', body: formData(body) }); close(); reload(); }
        catch (e) { toast(e.message, 'err'); }
      };
    });

  const setActive = async (active) => {
    try { await api('/access/roles/' + encodeURIComponent(sel.name), { method: 'PATCH', body: { active } }); toast(active ? 'Role reinstated' : 'Role retired'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (qs('#retirerole', c)) qs('#retirerole', c).onclick = () => { if (confirm(`Retire "${sel.label || sel.name}"? It will grant nothing until reinstated.`)) setActive(false); };
  if (qs('#reinstaterole', c)) qs('#reinstaterole', c).onclick = () => setActive(true);
}

async function renderClearanceBoard(c) {
  const m = await api('/access/matrix');
  const LV = m.levels;
  const headCols = m.modules.map((mod) => `<th style="text-align:center">${esc(mod.label)}${mod.enforce ? '' : ' <span class="muted" title="Hidden in the sidebar but not API-blocked (reference/analytics)">*</span>'}</th>`).join('');
  const rows = m.roles.map((r) => `<tr${r.active ? '' : ' style="opacity:.5"'}><td><b>${esc(r.label || r.name)}</b>${r.active ? '' : ' <span class="badge">retired</span>'}<br><span class="muted" style="font-size:11px">${esc(r.name)}</span></td>${m.modules.map((mod) => {
    const lvl = m.grid[r.name][mod.key];
    const locked = r.name === 'admin';
    return `<td style="text-align:center;cursor:${locked ? 'default' : 'pointer'}"${locked ? '' : ` data-cell="${esc(r.name)}:${mod.key}" data-lvl="${lvl}" title="click to change"`}>${lvlChip(lvl)}</td>`;
  }).join('')}</tr>`).join('');
  c.innerHTML = `<div class="card">
    <h3 style="margin:0 0 6px">Compact Clearance Matrix</h3>
    <p class="muted" style="margin-top:0">Section clearance opens a whole section; permissions in the <b>Role Profile Editor</b> decide individual actions inside it. Click any cell to cycle: — → VIEW → ADD → EDIT → FULL. <b>Admin</b> is always full. <span title="nav-level only">*</span> = hidden in the sidebar but not blocked (reference data used by other screens).</p>
    <div class="table-wrap scroll"><table><thead><tr><th>Role</th>${headCols}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pill-row" style="margin-top:12px"><span class="muted">Legend:</span> ${lvlChip('full')} manage ${lvlChip('edit')} modify ${lvlChip('add')} add/submit ${lvlChip('view')} read-only ${lvlChip('none')} no access</div>
  </div>`;
  qsa('[data-cell]', c).forEach((td) => td.onclick = async () => {
    const [role, mod] = td.dataset.cell.split(':');
    const next = LV[(LV.indexOf(td.dataset.lvl) + 1) % LV.length];
    try { await api('/access/matrix', { method: 'POST', body: { role, module: mod, level: next } }); renderClearanceBoard(c); }
    catch (e) { toast(e.message, 'err'); }
  });
}

async function userStoreAccessModal(u, onSave) {
  modal(`Store & Site Store Access — ${esc(u.username)}`, '<div class="muted" style="padding:20px">Loading user store access…</div>', async (mBody, close) => {
    try {
      const res = await api(`/users/${u.id}/stores`);
      const stores = res.stores || [];
      const render = () => {
        mBody.innerHTML = `
          <div style="font-size:13px">
            <div style="background:var(--subtle,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:12px 14px;margin-bottom:14px">
              <div style="font-weight:700;font-size:14px">${esc(u.full_name || u.username)} <span class="muted" style="font-size:12px;font-weight:normal">(@${esc(u.username)})</span></div>
              <div class="muted" style="font-size:11.5px;margin-top:2px">Configure which Central Main Stores, Workshop Stores, and Project Site Stores this user can operate.</div>
            </div>
            <div style="overflow-x:auto;max-height:420px;border:1px solid var(--border,#e5e7eb);border-radius:6px;margin-bottom:14px">
              <table class="table" style="width:100%;margin:0;font-size:12px">
                <thead>
                  <tr style="background:var(--subtle,#f9fafb);border-bottom:1px solid var(--border,#e5e7eb);text-align:left">
                    <th style="padding:8px 10px">Physical Store Location</th>
                    <th style="padding:8px 10px;text-align:center" title="Grant access to this store">Access</th>
                    <th style="padding:8px 10px;text-align:center" title="Can view on-hand stock and bin cards">View</th>
                    <th style="padding:8px 10px;text-align:center" title="Can receive goods (GRN / inbound MTN)">Receive</th>
                    <th style="padding:8px 10px;text-align:center" title="Can issue parts to Job Cards / Vehicles (MIN)">Issue</th>
                    <th style="padding:8px 10px;text-align:center" title="Can dispatch outbound MTNs to other stores">Dispatch</th>
                    <th style="padding:8px 10px;text-align:center" title="Can perform physical stock counts">Count</th>
                    <th style="padding:8px 10px;text-align:center" title="Can raise MRN replenishment requests">Request</th>
                  </tr>
                </thead>
                <tbody>
                  ${stores.map((s) => {
                    const icon = s.store_type === 'MAIN_STORE' ? '🏛️' : (s.store_type === 'MAIN_WORKSHOP_STORE' ? '🔧' : '📦');
                    const badgeCls = s.store_type === 'MAIN_STORE' ? 'blue' : (s.store_type === 'MAIN_WORKSHOP_STORE' ? 'amber' : 'green');
                    return `
                      <tr style="border-bottom:1px solid var(--border,#f1f5f9)" data-store-row="${s.store_id}">
                        <td style="padding:8px 10px">
                          <span style="font-size:14px;margin-right:4px">${icon}</span>
                          <b>${esc(s.store_name)}</b> <span class="code" style="font-size:10px">(${esc(s.store_code)})</span>
                          <br><span class="badge ${badgeCls} sm" style="font-size:10px">${esc(s.store_type)}</span>
                        </td>
                        <td style="padding:8px 10px;text-align:center">
                          <input type="checkbox" class="chk-has-access" data-sid="${s.store_id}" ${s.has_access ? 'checked' : ''} />
                        </td>
                        <td style="padding:8px 10px;text-align:center">
                          <input type="checkbox" data-sid="${s.store_id}" data-perm="can_view" ${s.can_view ? 'checked' : ''} ${!s.has_access ? 'disabled' : ''} />
                        </td>
                        <td style="padding:8px 10px;text-align:center">
                          <input type="checkbox" data-sid="${s.store_id}" data-perm="can_receive" ${s.can_receive ? 'checked' : ''} ${!s.has_access ? 'disabled' : ''} />
                        </td>
                        <td style="padding:8px 10px;text-align:center">
                          <input type="checkbox" data-sid="${s.store_id}" data-perm="can_issue" ${s.can_issue ? 'checked' : ''} ${!s.has_access ? 'disabled' : ''} />
                        </td>
                        <td style="padding:8px 10px;text-align:center">
                          <input type="checkbox" data-sid="${s.store_id}" data-perm="can_dispatch" ${s.can_dispatch ? 'checked' : ''} ${!s.has_access ? 'disabled' : ''} />
                        </td>
                        <td style="padding:8px 10px;text-align:center">
                          <input type="checkbox" data-sid="${s.store_id}" data-perm="can_count" ${s.can_count ? 'checked' : ''} ${!s.has_access ? 'disabled' : ''} />
                        </td>
                        <td style="padding:8px 10px;text-align:center">
                          <input type="checkbox" data-sid="${s.store_id}" data-perm="can_request" ${s.can_request ? 'checked' : ''} ${!s.has_access ? 'disabled' : ''} />
                        </td>
                      </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
              <span class="muted" style="font-size:11.5px">Changes take effect immediately for stock visibility and transactions.</span>
              <div style="display:flex;gap:6px">
                <button type="button" class="btn sm" id="btn_cancel_store_access">Cancel</button>
                <button type="button" class="btn sm primary" id="btn_save_store_access">Save Store Access</button>
              </div>
            </div>
          </div>
        `;

        qsa('.chk-has-access', mBody).forEach((ch) => {
          ch.onchange = () => {
            const sid = ch.dataset.sid;
            const checked = ch.checked;
            const row = qs(`[data-store-row="${sid}"]`, mBody);
            if (row) {
              qsa('[data-perm]', row).forEach((p) => {
                p.disabled = !checked;
                if (checked) p.checked = true;
              });
            }
          };
        });

        qs('#btn_cancel_store_access', mBody).onclick = close;
        qs('#btn_save_store_access', mBody).onclick = async () => {
          const payload = [];
          stores.forEach((s) => {
            const sid = s.store_id;
            const row = qs(`[data-store-row="${sid}"]`, mBody);
            if (!row) return;
            const hasAccess = qs('.chk-has-access', row).checked;
            const getVal = (perm) => {
              const el = qs(`[data-perm="${perm}"]`, row);
              return el && el.checked ? 1 : 0;
            };
            payload.push({
              store_id: sid,
              has_access: hasAccess,
              can_view: hasAccess ? getVal('can_view') : 0,
              can_receive: hasAccess ? getVal('can_receive') : 0,
              can_issue: hasAccess ? getVal('can_issue') : 0,
              can_dispatch: hasAccess ? getVal('can_dispatch') : 0,
              can_count: hasAccess ? getVal('can_count') : 0,
              can_request: hasAccess ? getVal('can_request') : 0
            });
          });

          try {
            await api(`/users/${u.id}/stores`, { method: 'POST', body: { stores: payload } });
            close();
            toast('Store permissions saved');
            if (typeof onSave === 'function') onSave();
          } catch (e) {
            toast(e.message, 'err');
          }
        };
      };

      render();
    } catch (err) {
      mBody.innerHTML = `<div class="card alert red">Error loading store permissions: ${esc(err.message)}</div>`;
    }
  }, { wide: true });
}


// ===========================================================================
// Multi-Step New User Provisioning & Granular Clearance Wizard (Plan Phase 2)
// 1. Account credentials & Role Template
// 2. Physical Store & Site Scope + Expiry (access_until)
// 3. Action Checklist grouped by section, prefilled from template, "custom" tag
// ===========================================================================
async function openNewUserWizard(roles, allStoreLocations, storeOptions, wsd, onComplete) {
  let sm = null;
  let allProjects = [];
  let allTanks = [];
  try {
    const [smRes, projRes, tankRes] = await Promise.all([
      api('/access/section-matrix').catch(() => api('/access/capabilities').catch(() => null)),
      api('/projects?active=1').catch(() => []),
      api('/fuel/tanks').catch(() => ({ tanks: [] })),
    ]);
    sm = smRes;
    allProjects = Array.isArray(projRes) ? projRes : (projRes && projRes.projects ? projRes.projects : []);
    allTanks = Array.isArray(tankRes) ? tankRes : (tankRes && tankRes.tanks ? tankRes.tanks : []);
  } catch (_) {}

  const defaultRole = roles.find(r => r.name === 'site_storekeeper') || roles.find(r => r.name === 'storekeeper') || roles[0] || { name: 'site_storekeeper', label: 'Site Storekeeper' };
  const multi = Boolean(wsd && wsd.multi);

  const state = {
    step: 1,
    username: '',
    password: '',
    full_name: '',
    selectedRole: defaultRole.name,
    workshop_id: '1',
    store_location_id: '',
    project_id: '',
    bulk_tank_id: '',
    fuel_role: '',
    hide_stock: false,
    access_until: '',
    override_reason: '',
    sectionEdits: {},
    capEdits: {},
  };

  const pickDefaultStore = (roleName) => {
    if (roleName === 'main_storekeeper') {
      const ms = allStoreLocations.find(s => s.store_type === 'MAIN_STORE');
      if (ms) return String(ms.id);
    } else if (roleName === 'site_storekeeper') {
      const ss = allStoreLocations.find(s => s.store_type === 'SITE_STORE' || s.store_type === 'MAIN_WORKSHOP_STORE');
      if (ss) return String(ss.id);
    }
    return '';
  };
  state.store_location_id = pickDefaultStore(state.selectedRole);

  const getRoleTemplateDefaults = (roleName) => {
    const levels = {};
    const caps = new Set();
    if (sm && sm.matrix && sm.matrix.grid && sm.matrix.grid[roleName]) {
      Object.assign(levels, sm.matrix.grid[roleName]);
    }
    if (roleName === 'admin') {
      if (sm && sm.capabilities) sm.capabilities.forEach((c) => caps.add(c.key));
    } else if (sm && Array.isArray(sm.roles)) {
      const rEntry = sm.roles.find((r) => r.name === roleName);
      if (rEntry && Array.isArray(rEntry.caps)) {
        rEntry.caps.forEach((k) => caps.add(k));
      }
    }
    return { levels, caps };
  };

  modal('New User Provisioning & Access Clearance', '<div id="nu-wizard-container"></div>', (body, close) => {
    const container = qs('#nu-wizard-container', body);

    const render = () => {
      const roleDef = roles.find(r => r.name === state.selectedRole) || { name: state.selectedRole, label: state.selectedRole };
      const template = getRoleTemplateDefaults(state.selectedRole);

      let overrideCount = 0;
      for (const [sKey, lvl] of Object.entries(state.sectionEdits)) {
        if (lvl && lvl !== (template.levels[sKey] || 'none')) overrideCount++;
      }
      for (const [cKey, val] of Object.entries(state.capEdits)) {
        if (val !== undefined && val !== template.caps.has(cKey)) overrideCount++;
      }

      const steps = [
        { num: 1, title: 'Account & Role Template' },
        { num: 2, title: 'Store & Site Scope' },
        { num: 3, title: 'Action Checklist & Clearance' },
      ];
      const stepperHtml = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding:8px 12px;background:var(--bg-muted, #f1f5f9);border-radius:8px">
          ${steps.map(s => {
            const isCur = state.step === s.num;
            const isDone = state.step > s.num;
            const bg = isCur ? 'var(--primary, #0066ff)' : (isDone ? '#10b981' : '#cbd5e1');
            const color = isCur || isDone ? '#fff' : '#64748b';
            return `
              <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:${isCur ? '700' : '500'}">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${bg};color:${color};font-size:11px">
                  ${isDone ? '✓' : s.num}
                </span>
                <span style="${isCur ? 'color:var(--primary, #0066ff);' : (isDone ? 'color:#10b981;' : 'color:#64748b;')}">${s.title}</span>
              </div>
            `;
          }).join('<span class="muted" style="margin:0 4px">→</span>')}
        </div>
      `;

      let contentHtml = '';

      if (state.step === 1) {
        contentHtml = `
          ${stepperHtml}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div>
              <label style="display:block;font-weight:600;font-size:12px;margin-bottom:4px">Username *</label>
              <input class="input" style="width:100%" id="nu_username" value="${esc(state.username)}" placeholder="e.g. saman_p" />
            </div>
            <div>
              <label style="display:block;font-weight:600;font-size:12px;margin-bottom:4px">Full Name</label>
              <input class="input" style="width:100%" id="nu_fullname" value="${esc(state.full_name)}" placeholder="e.g. Saman Perera" />
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:block;font-weight:600;font-size:12px;margin-bottom:4px">Temporary Password *</label>
            <input class="input" style="width:100%" type="password" id="nu_password" value="${esc(state.password)}" placeholder="Must be at least 10 characters" />
            <p class="muted" style="font-size:11.5px;margin:3px 0 0">${esc(passwordHint())} They must choose their own at first sign-in.</p>
          </div>

          <div style="margin-bottom:14px">
            <label style="display:block;font-weight:700;font-size:13px;margin-bottom:6px">Select Primary Role Template *</label>
            <p class="muted" style="font-size:11.5px;margin:0 0 8px">The starting baseline for what this person can do. You can fine-tune specific actions in Step 3.</p>
            <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:8px;max-height:220px;overflow-y:auto;padding:4px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:var(--card,#fff)">
              ${roles.map(r => {
                const checked = state.selectedRole === r.name;
                const isSiteSk = r.name === 'site_storekeeper';
                return `
                  <label style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:6px;border:1px solid ${checked ? 'var(--primary,#0066ff)' : 'transparent'};background:${checked ? '#eff6ff' : 'transparent'};cursor:pointer">
                    <input type="radio" name="nu_role" value="${esc(r.name)}" ${checked ? 'checked' : ''} style="margin-top:3px" />
                    <div>
                      <div style="font-weight:600;font-size:12.5px;color:${checked ? 'var(--primary,#0066ff)' : 'inherit'}">
                        ${esc(r.label || r.name)}
                        ${isSiteSk ? '<span class="badge green" style="font-size:9.5px;margin-left:4px">Recommended for Sites</span>' : ''}
                      </div>
                      <div class="muted" style="font-size:11px">${esc(r.description || 'Standard role template')}</div>
                    </div>
                  </label>
                `;
              }).join('')}
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
            <button class="btn" id="nu_cancel">Cancel</button>
            <button class="primary" id="nu_step1_next">Next: Store & Site Scope →</button>
          </div>
        `;
      } else if (state.step === 2) {
        contentHtml = `
          ${stepperHtml}
          <div class="card" style="padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:14px">
            <span class="muted" style="font-size:11.5px">Configuring for:</span> <b>${esc(state.full_name || state.username)}</b>
            <span class="muted" style="font-size:11.5px;margin-left:12px">Role Template:</span> <span class="badge blue">${esc(roleDef.label || roleDef.name)}</span>
          </div>

          <div style="margin-bottom:14px">
            <label style="display:block;font-weight:600;font-size:12.5px;margin-bottom:4px">Physical Store & Site Location Assignment</label>
            <select class="input" id="nu_store_select" style="width:100%">
              ${storeOptions.map(o => `<option value="${esc(o.value)}" ${String(state.store_location_id) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
            </select>
            <p class="muted" style="font-size:11.5px;margin:4px 0 0">
              ${state.selectedRole === 'site_storekeeper'
                ? '⭐ <b>Site Storekeeper selected:</b> Assign to their project site store (e.g. Galagedara Site Store). Transactions (MRN, issues, receipts) will be scoped to this store location.'
                : (state.selectedRole === 'main_storekeeper'
                  ? '🏛️ <b>Main Storekeeper selected:</b> Assign to Central Main Stores for company-wide store oversight.'
                  : 'Assigning a physical store isolates stock balances and requisitions for this user.')}
            </p>
          </div>

          ${multi ? `
          <div style="margin-bottom:14px">
            <label style="display:block;font-weight:600;font-size:12.5px;margin-bottom:4px">Home Workshop Branch</label>
            <select class="input" id="nu_workshop_select" style="width:100%">
              ${wsOptions(wsd).map(o => `<option value="${esc(o.value)}" ${String(state.workshop_id) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
            </select>
            <p class="muted" style="font-size:11.5px;margin:4px 0 0">New job cards and requests they raise originate from this workshop.</p>
          </div>` : ''}

          <div style="margin-bottom:14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px">
            <div style="font-weight:700;font-size:12.5px;color:#1e3a8a;margin-bottom:8px">⛽ Fuel Site &amp; Bulk Tank Scope ${['pump_operator', 'fuel_requester', 'fuel_officer'].includes(state.selectedRole) ? '(Required for Site Fuel Roles)' : '(Optional)'}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px">
              <div>
                <label style="display:block;font-weight:600;font-size:12px;margin-bottom:4px">Assigned Project Site</label>
                <select class="input" id="nu_project_select" style="width:100%">
                  <option value="">— All Sites / Head Office —</option>
                  ${allProjects.map((p) => `<option value="${esc(p.id)}" ${String(state.project_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)} (${esc(p.code || p.id)})</option>`).join('')}
                </select>
              </div>
              <div>
                <label style="display:block;font-weight:600;font-size:12px;margin-bottom:4px">Assigned Site Bulk Tank / Pump</label>
                <select class="input" id="nu_tank_select" style="width:100%">
                  <option value="">— Any / Auto from Site —</option>
                  ${allTanks.map((t) => `<option value="${esc(t.id)}" ${String(state.bulk_tank_id) === String(t.id) ? 'selected' : ''}>${esc(t.name)} (${esc(t.code || t.id)})</option>`).join('')}
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center">
              <div>
                <label style="display:block;font-weight:600;font-size:12px;margin-bottom:4px">Fuel Console Mode</label>
                <select class="input" id="nu_fuel_role" style="width:100%">
                  <option value="">— Auto from Role Template —</option>
                  <option value="SITE_OPERATOR" ${state.fuel_role === 'SITE_OPERATOR' ? 'selected' : ''}>Site Pump Operator (4 Sections Only)</option>
                  <option value="WORKSHOP_FUEL" ${state.fuel_role === 'WORKSHOP_FUEL' ? 'selected' : ''}>Workshop Fuel Attendant</option>
                  <option value="FUEL_MANAGER" ${state.fuel_role === 'FUEL_MANAGER' ? 'selected' : ''}>Fuel Manager</option>
                  <option value="VIEWER" ${state.fuel_role === 'VIEWER' ? 'selected' : ''}>Fuel Viewer</option>
                </select>
              </div>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;margin-top:16px">
                <input type="checkbox" id="nu_hide_stock" ${state.hide_stock ? 'checked' : ''} style="width:auto;margin:0" />
                <span>Hide Running Tank Stock Balance</span>
              </label>
            </div>
            <p class="muted" style="font-size:11px;margin:6px 0 0">
              ${state.selectedRole === 'pump_operator'
                ? '🔒 <b>Site Pump Operator:</b> Locked to their assigned tank. Can ONLY view Fuel Issue, Issue History, Fuel Add, and Fuel Add History, and must submit change requests to Admin.'
                : (state.selectedRole === 'fuel_requester'
                  ? '📝 <b>Site Fuel Requester:</b> Locked to their assigned site/tank to raise Transport Fuel &amp; Running Chart requests (cannot dispense fuel).'
                  : 'Assign a Project Site and/or Bulk Tank to isolate fuel operations to that site.')}
            </p>
          </div>

          <div style="margin-bottom:14px;background:#fefce8;border:1px solid #fef08a;border-radius:8px;padding:12px">
            <label style="display:block;font-weight:600;font-size:12.5px;color:#854d0e;margin-bottom:4px">⏱️ Temporary Access Expiry (Optional)</label>
            <input class="input" type="datetime-local" id="nu_access_until" value="${esc(state.access_until ? state.access_until.slice(0, 16) : '')}" style="width:260px" />
            <p class="muted" style="font-size:11.5px;margin:4px 0 0">
              Leave blank for standard permanent access. Set an expiry date/time for relief cover, temporary contractors, or audited probationary access. Once expired, all actions are automatically revoked.
            </p>
          </div>

          <div style="display:flex;justify-content:space-between;margin-top:16px">
            <button class="btn" id="nu_step2_back">← Back</button>
            <button class="primary" id="nu_step2_next">Next: Review & Customize Actions →</button>
          </div>
        `;
      } else if (state.step === 3) {
        const GROUPS = [
          { id: 'Operations', name: 'Operations & Execution', icon: '⚙️' },
          { id: 'Fleet', name: 'Fleet Management', icon: '🚛' },
          { id: 'Inventory', name: 'Inventory & Warehousing', icon: '📦' },
          { id: 'Procurement', name: 'Procurement & Purchasing', icon: '🛒' },
          { id: 'Analysis', name: 'Analysis & Intelligence', icon: '📊' },
          { id: 'Admin', name: 'Governance & Administration', icon: '🛡️' },
        ];

        const ACTVT_MAP = {
          '01': { label: '01 · Create', cls: 'badge teal' },
          '02': { label: '02 · Change', cls: 'badge blue' },
          '03': { label: '03 · Display', cls: 'badge' },
          '06': { label: '06 · Delete', cls: 'badge red' },
          '08': { label: '08 · Export', cls: 'badge purple' },
          '10': { label: '10 · Approve', cls: 'badge green' },
          'A1': { label: 'A1 · Certify', cls: 'badge amber' },
        };

        const LV_BTN = [
          { key: 'none', label: 'None' },
          { key: 'view', label: 'View' },
          { key: 'add', label: 'Add' },
          { key: 'edit', label: 'Edit' },
          { key: 'full', label: 'Full' },
        ];

        const allSections = (sm && sm.sections) || [];
        const allCapabilities = (sm && sm.capabilities) || [];

        const groupsHtml = GROUPS.map(grp => {
          const grpSections = allSections.filter(s => (s.domain || s.group || '').toLowerCase() === grp.id.toLowerCase());
          if (!grpSections.length) return '';

          const sectionsHtml = grpSections.map(sec => {
            const roleLvl = template.levels[sec.id || sec.key] || 'none';
            const curLvl = state.sectionEdits[sec.id || sec.key] !== undefined ? state.sectionEdits[sec.id || sec.key] : roleLvl;
            const isLvlCustom = curLvl !== roleLvl;

            const lvlButtons = LV_BTN.map(b => {
              const isSel = curLvl === b.key;
              const cls = isSel ? 'primary' : 'btn sm';
              const style = isSel ? 'font-weight:700;padding:2px 8px;font-size:11px' : 'opacity:.7;padding:2px 8px;font-size:11px';
              return `<button type="button" class="${cls}" style="${style}" data-wizard-sec="${esc(sec.id || sec.key)}" data-lvl="${b.key}">${b.label}</button>`;
            }).join(' ');

            const secCaps = allCapabilities.filter(c => (c.section || c.module) === (sec.id || sec.key));
            let capsHtml = '';
            if (secCaps.length > 0) {
              const capItems = secCaps.map(c => {
                const roleGranted = template.caps.has(c.key);
                const isChecked = state.capEdits[c.key] !== undefined ? state.capEdits[c.key] : roleGranted;
                const isCapCustom = isChecked !== roleGranted;
                const actvt = ACTVT_MAP[c.actvt] || { label: c.actvt || '02', cls: 'badge' };
                const dualBadge = c.dualAuth ? `<span class="badge amber" style="font-size:9px">👥 4-Eyes</span> ` : '';

                return `
                  <label style="display:flex;align-items:flex-start;gap:8px;margin:4px 0;font-size:12px;font-weight:normal">
                    <input type="checkbox" data-wizard-cap="${esc(c.key)}" ${isChecked ? 'checked' : ''} style="margin-top:2px" />
                    <div>
                      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                        <span class="${actvt.cls}" style="font-size:9px;font-family:monospace">${actvt.label}</span>
                        ${dualBadge}
                        <span style="font-weight:${isChecked ? '600' : '400'}">${esc(c.label)}</span>
                        ${isCapCustom ? '<span class="badge amber" style="font-size:9px">⚡ Custom Override</span>' : ''}
                      </div>
                      <div class="muted" style="font-size:10px;font-family:monospace">${esc(c.key)}</div>
                    </div>
                  </label>
                `;
              }).join('');

              capsHtml = `
                <details style="margin-top:6px;border-top:1px dashed #e2e8f0;padding-top:4px">
                  <summary style="cursor:pointer;font-size:11px;font-weight:600;color:var(--text-muted, #64748b)">
                    Individual Action Capabilities (${secCaps.length})
                  </summary>
                  <div style="margin-top:4px;padding-left:6px">${capItems}</div>
                </details>
              `;
            }

            return `
              <div class="card" style="padding:10px;margin-bottom:8px;border:1px solid #e2e8f0;border-radius:6px;background:#fff">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                  <div style="display:flex;align-items:center;gap:6px">
                    <span style="font-size:16px">${sec.icon || '📦'}</span>
                    <div>
                      <b style="font-size:13px">${esc(sec.name || sec.label)}</b>
                      <div class="muted" style="font-size:11px">${esc(sec.description || '')}</div>
                    </div>
                  </div>
                  <div>
                    ${isLvlCustom ? '<span class="badge amber" style="font-size:10px">⚡ Custom Clearance</span>' : `<span class="badge blue" style="font-size:10px">Template (${roleLvl.toUpperCase()})</span>`}
                  </div>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;background:#f8fafc;padding:4px 8px;border-radius:4px">
                  <span class="muted" style="font-size:10.5px;font-weight:600">SECTION CLEARANCE:</span>
                  <div style="display:flex;gap:3px">${lvlButtons}</div>
                </div>
                ${capsHtml}
              </div>
            `;
          }).join('');

          return `
            <div style="margin-bottom:14px">
              <div style="font-weight:700;font-size:13px;color:#1e293b;margin-bottom:6px;display:flex;align-items:center;gap:6px">
                <span>${grp.icon}</span> <span>${grp.name}</span>
              </div>
              ${sectionsHtml}
            </div>
          `;
        }).join('');

        contentHtml = `
          ${stepperHtml}
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px">
            <div style="font-size:12.5px">
              User: <b>${esc(state.username)}</b> (${esc(state.full_name || '—')}) |
              Template: <span class="badge blue">${esc(roleDef.label || roleDef.name)}</span> |
              Overrides: <span class="badge ${overrideCount > 0 ? 'amber' : 'green'}">${overrideCount > 0 ? `${overrideCount} custom` : '0 (Template default)'}</span>
            </div>
            <div>
              <button class="btn sm" id="nu_reset_template" title="Discard customizations and revert to role template">↺ Reset to Role Template</button>
            </div>
          </div>

          ${overrideCount > 0 ? `
          <div style="margin-bottom:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 12px">
            <label style="display:block;font-weight:600;font-size:12px;color:#92400e;margin-bottom:4px">
              📝 Audit Justification for Custom Overrides (Recorded in Security Log)
            </label>
            <input class="input" id="nu_override_reason" value="${esc(state.override_reason)}" placeholder="e.g. Authorized stand-in for store manager during audit" style="width:100%;font-size:12px" />
          </div>` : ''}

          <div style="margin-bottom:10px">
            <input class="input" id="nu_action_search" placeholder="🔍 Filter sections and actions (e.g. issue, mrn, price, grn)..." style="width:100%;font-size:12px" />
          </div>

          <div id="nu_actions_scroll" style="max-height:360px;overflow-y:auto;padding-right:4px">
            ${groupsHtml}
          </div>

          <div style="display:flex;justify-content:space-between;margin-top:16px">
            <button class="btn" id="nu_step3_back">← Back to Scope</button>
            <button class="primary" id="nu_submit_create">Create User & Provision Access</button>
          </div>
        `;
      }

      container.innerHTML = contentHtml;

      if (state.step === 1) {
        qs('#nu_cancel', container).onclick = () => close();
        qsa('input[name="nu_role"]', container).forEach(r => {
          r.onchange = () => {
            state.selectedRole = r.value;
            state.store_location_id = pickDefaultStore(r.value);
            render();
          };
        });
        qs('#nu_step1_next', container).onclick = () => {
          state.username = qs('#nu_username', container).value.trim();
          state.full_name = qs('#nu_fullname', container).value.trim();
          state.password = qs('#nu_password', container).value;
          if (!state.username) return toast('Username is required', 'err');
          if (!state.password || state.password.length < passwordMinLength()) return toast(passwordHint(), 'err');
          state.step = 2;
          render();
        };
      } else if (state.step === 2) {
        qs('#nu_step2_back', container).onclick = () => { state.step = 1; render(); };
        qs('#nu_step2_next', container).onclick = () => {
          state.store_location_id = qs('#nu_store_select', container).value;
          if (qs('#nu_workshop_select', container)) state.workshop_id = qs('#nu_workshop_select', container).value;
          if (qs('#nu_project_select', container)) state.project_id = qs('#nu_project_select', container).value;
          if (qs('#nu_tank_select', container)) state.bulk_tank_id = qs('#nu_tank_select', container).value;
          if (qs('#nu_fuel_role', container)) state.fuel_role = qs('#nu_fuel_role', container).value;
          if (qs('#nu_hide_stock', container)) state.hide_stock = qs('#nu_hide_stock', container).checked;
          state.access_until = qs('#nu_access_until', container).value;
          state.step = 3;
          render();
        };
      } else if (state.step === 3) {
        qs('#nu_step3_back', container).onclick = () => { state.step = 2; render(); };

        const searchInput = qs('#nu_action_search', container);
        if (searchInput) {
          searchInput.oninput = () => {
            const term = searchInput.value.toLowerCase().trim();
            qsa('#nu_actions_scroll .card', container).forEach(card => {
              const text = card.textContent.toLowerCase();
              card.style.display = (!term || text.includes(term)) ? '' : 'none';
              const details = qs('details', card);
              if (details && term && text.includes(term)) details.open = true;
            });
          };
        }

        qsa('[data-wizard-sec]', container).forEach(btn => {
          btn.onclick = () => {
            const secKey = btn.dataset.wizardSec;
            const lvl = btn.dataset.lvl;
            state.sectionEdits[secKey] = lvl;
            render();
          };
        });

        qsa('[data-wizard-cap]', container).forEach(cb => {
          cb.onchange = () => {
            const capKey = cb.dataset.wizardCap;
            state.capEdits[capKey] = cb.checked;
            render();
          };
        });

        const resetBtn = qs('#nu_reset_template', container);
        if (resetBtn) {
          resetBtn.onclick = () => {
            state.sectionEdits = {};
            state.capEdits = {};
            state.override_reason = '';
            toast('Reverted all actions to role template defaults');
            render();
          };
        }

        qs('#nu_submit_create', container).onclick = async () => {
          const reasonInput = qs('#nu_override_reason', container);
          if (reasonInput) state.override_reason = reasonInput.value.trim();

          const template = getRoleTemplateDefaults(state.selectedRole);

          const sectionsPayload = {};
          for (const [secKey, lvl] of Object.entries(state.sectionEdits)) {
            if (lvl && lvl !== (template.levels[secKey] || 'none')) {
              sectionsPayload[secKey] = lvl;
            }
          }

          const capsPayload = {};
          for (const [capKey, val] of Object.entries(state.capEdits)) {
            if (val !== undefined && val !== template.caps.has(capKey)) {
              capsPayload[capKey] = val;
            }
          }

          const payload = {
            username: state.username,
            password: state.password,
            full_name: state.full_name || null,
            roles: [state.selectedRole],
            workshop_id: state.workshop_id ? Number(state.workshop_id) : 1,
            store_location_id: state.store_location_id ? Number(state.store_location_id) : null,
            project_id: state.project_id ? Number(state.project_id) : null,
            bulk_tank_id: state.bulk_tank_id || null,
            fuel_role: state.fuel_role || null,
            hide_stock: !!state.hide_stock,
            access_until: state.access_until ? new Date(state.access_until).toISOString() : null,
            sections: sectionsPayload,
            capabilities: capsPayload,
            override_reason: state.override_reason || null,
          };

          try {
            const created = await api('/users', { method: 'POST', body: payload });
            close();
            toast(`User ${state.username} created successfully with customized clearance`);
            if (onComplete) onComplete(created);
          } catch (err) {
            toast(err.message, 'err');
          }
        };
      }
    };

    render();
  }, { wide: true });
}

// ---- Stage D: Security & Hardening Cockpit (#/access?tab=security) -------------------------
async function renderSecurityHardeningTab(c) {
  const canManageAccess = canDo('access.manage');
  const canManageUsers = canDo('users.manage');
  let userFilter = 'active';
  let showAllRoles = false;
  const selectedUserIds = new Set();

  let posture = await api('/access/security-posture');

  const applyMfaPolicy = async (roleNames, requireMfa) => {
    const send = async (confirmSelf = false) => {
      try {
        const res = await api('/access/security-posture/mfa-policy', {
          method: 'POST',
          body: { roles: roleNames, require_mfa: !!requireMfa, confirm_self_unenrolled: confirmSelf },
        });
        posture = res.posture;
        toast(requireMfa
          ? `2FA enforced on ${roleNames.join(', ')}`
          : `2FA policy relaxed on ${roleNames.join(', ')}`, 'ok');
        draw();
      } catch (e) {
        if (e && e.status === 409 && e.data && e.data.requires_self_mfa_confirm) {
          const affected = (e.data.affected_self_roles || []).join(', ');
          modal('Confirm Enforcing 2FA on Your Own Role', `
            <div style="padding:10px 12px;border-radius:6px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;margin-bottom:12px;font-size:13px">
              <b>⚠️ Heads up:</b> Your own account holds <b>${esc(affected)}</b> and does not have an authenticator app enrolled yet.
            </div>
            <p style="font-size:13px;margin:0 0 8px">
              If you enforce 2FA now, your next sign-in will prompt you to scan the TOTP setup key with Google/Microsoft Authenticator before opening any screen.
            </p>
            <p class="muted" style="font-size:12px;margin:0 0 14px">
              Tip: You can cancel here and click <b>Set up My 2FA Now</b> first, or confirm to enforce immediately (CLI recovery: <code>node scripts/admin.js reset-mfa &lt;username&gt;</code>).
            </p>
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button type="button" class="btn" id="sec-mfa-cancel">Cancel</button>
              <button type="button" class="primary" id="sec-mfa-confirm">Enforce 2FA Anyway</button>
            </div>`,
            (body, close) => {
              qs('#sec-mfa-cancel', body).onclick = close;
              qs('#sec-mfa-confirm', body).onclick = async () => {
                close();
                await send(true);
              };
            }
          );
          return;
        }
        toast(e.message || 'Failed to update 2FA policy', 'err');
      }
    };
    await send(false);
  };

  const draw = () => {
    const s = posture.summary || {};
    const roles = posture.roles || [];
    const users = posture.users || [];
    const b = posture.backup || {};
    const rt = posture.runtime || {};

    const visibleRoles = showAllRoles ? roles : roles.filter((r) => r.is_privileged);
    const privRolesUnforced = roles.filter((r) => r.active && r.is_privileged && !r.require_mfa).map((r) => r.name);

    const activeUsers = users.filter((u) => u.active);
    const filterCounts = {
      active: activeUsers.length,
      pending_pw: activeUsers.filter((u) => u.must_change_password).length,
      dormant: activeUsers.filter((u) => u.is_dormant || u.is_default_seed).length,
      priv_no_mfa: activeUsers.filter((u) => u.is_privileged && !u.mfa_enabled).length,
      inactive: users.filter((u) => !u.active).length,
    };

    const filteredUsers = users.filter((u) => {
      if (userFilter === 'active') return u.active;
      if (userFilter === 'pending_pw') return u.active && u.must_change_password;
      if (userFilter === 'dormant') return u.active && (u.is_dormant || u.is_default_seed);
      if (userFilter === 'priv_no_mfa') return u.active && u.is_privileged && !u.mfa_enabled;
      if (userFilter === 'inactive') return !u.active;
      return true;
    });

    for (const id of [...selectedUserIds]) {
      const hit = users.find((u) => u.id === id);
      if (!hit || !hit.can_deactivate) selectedUserIds.delete(id);
    }

    const newest = b.newest_snapshot || null;
    const lastVerify = b.last_verify || null;
    const backupMb = newest && newest.bytes != null ? (newest.bytes / (1024 * 1024)).toFixed(2) : null;

    const roleRowsHtml = visibleRoles.map((r) => {
      const mfaBadge = r.require_mfa
        ? '<span class="badge green">Required</span>'
        : '<span class="badge">Optional</span>';
      const privBadge = r.is_privileged
        ? '<span class="badge amber" style="font-size:10px">Privileged</span>'
        : '<span class="badge" style="font-size:10px">Standard</span>';
      let actionHtml = '<span class="muted">—</span>';
      if (canManageAccess && r.active) {
        if (!r.require_mfa) {
          actionHtml = (r.name === 'admin' && !isAdmin())
            ? '<span class="muted" style="font-size:11px">Admin only</span>'
            : `<button type="button" class="btn sm primary" data-sec-mfa-role="${esc(r.name)}" data-sec-mfa-val="1">Enforce 2FA</button>`;
        } else {
          actionHtml = isAdmin()
            ? `<button type="button" class="btn sm" data-sec-mfa-role="${esc(r.name)}" data-sec-mfa-val="0">Relax 2FA</button>`
            : '<span class="muted" style="font-size:11px">Admin to relax</span>';
        }
      }
      return `<tr>
        <td><b>${esc(r.label)}</b><br><code style="font-size:11px">${esc(r.name)}</code></td>
        <td>${privBadge}${r.active ? '' : ' <span class="badge red">Retired</span>'}</td>
        <td class="num">${r.active_holders}</td>
        <td class="num">${r.mfa_enrolled_holders} / ${r.active_holders}</td>
        <td>${mfaBadge}</td>
        <td style="text-align:right">${actionHtml}</td>
      </tr>`;
    });

    const userRowsHtml = filteredUsers.map((u) => {
      const roleBadges = (u.role_labels || u.roles || []).map((rn) => `<span class="badge blue" style="font-size:10px">${esc(rn)}</span>`).join(' ');
      const mfaCol = u.mfa_enabled
        ? '<span class="badge green">2FA On</span>'
        : (u.mfa_required_by_role
          ? '<span class="badge amber">Setup Due</span>'
          : (u.is_privileged ? '<span class="badge red">Privileged Off</span>' : '<span class="muted">Off</span>'));
      const pwCol = u.must_change_password
        ? '<span class="badge amber">Temp Password</span>'
        : '<span class="badge green">Set</span>';
      const actCol = u.last_activity_at
        ? `<span style="font-size:11.5px">${esc(String(u.last_activity_at).slice(0, 16).replace('T', ' '))}</span><div class="muted" style="font-size:10.5px">${u.audit_count} audit event(s)</div>`
        : '<span class="badge amber" style="font-size:10.5px">Dormant (0 events)</span>';
      const statusCol = u.active
        ? (u.is_expired_access ? '<span class="badge red">Access Expired</span>' : '<span class="badge green">Active</span>')
        : '<span class="badge">Inactive</span>';
      const canSel = canManageUsers && u.can_deactivate;
      return `<tr style="${u.active ? '' : 'opacity:.6'}">
        <td style="text-align:center"><input type="checkbox" style="width:auto" data-sec-uid="${u.id}" ${selectedUserIds.has(u.id) ? 'checked' : ''} ${canSel ? '' : 'disabled'}></td>
        <td>
          <a href="#/access?tab=people&amp;user=${u.id}" style="font-weight:600;text-decoration:none">${esc(u.full_name || u.username)}</a>
          <div class="muted" style="font-size:11px"><code>${esc(u.username)}</code>${u.is_default_seed ? ' · <span class="badge amber" style="font-size:9.5px">Default Seed</span>' : ''}</div>
        </td>
        <td>${roleBadges || '<span class="muted">No roles</span>'}</td>
        <td>${mfaCol}</td>
        <td>${pwCol}</td>
        <td>${actCol}</td>
        <td class="num">${u.active_sessions}</td>
        <td>${statusCol}</td>
      </tr>`;
    });

    c.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:10px;margin-bottom:12px">
        <div class="card" style="padding:12px">
          <div class="muted" style="font-size:11px;font-weight:600">2FA ENROLLED USERS</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px">${s.mfa_enrolled_users || 0} / ${s.active_users || 0}</div>
          <div class="muted" style="font-size:11.5px">${s.mfa_enrolled_pct || 0}% of active accounts</div>
        </div>
        <div class="card" style="padding:12px">
          <div class="muted" style="font-size:11px;font-weight:600">PRIVILEGED ROLES 2FA</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px">${s.privileged_roles_enforced || 0} / ${s.privileged_roles_total || 0}</div>
          <div class="muted" style="font-size:11.5px">${s.privileged_mfa_enrolled || 0}/${s.privileged_active_users || 0} holders enrolled</div>
        </div>
        <div class="card" style="padding:12px">
          <div class="muted" style="font-size:11px;font-weight:600">TEMP PASSWORDS DUE</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px">${s.must_change_password_count || 0}</div>
          <div class="muted" style="font-size:11.5px">${s.default_seed_active_count || 0} default/seed still active</div>
        </div>
        <div class="card" style="padding:12px">
          <div class="muted" style="font-size:11px;font-weight:600">DORMANT ACTIVE ACCOUNTS</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px">${s.dormant_accounts_count || 0}</div>
          <div class="muted" style="font-size:11.5px">${s.active_sessions_total || 0} active session(s) live</div>
        </div>
        <div class="card" style="padding:12px;border-left:4px solid ${b.ok ? '#16a34a' : '#d97706'}">
          <div class="muted" style="font-size:11px;font-weight:600">COLD BACKUP &amp; VERIFY</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px;color:${b.ok ? '#166534' : '#92400e'}">${b.ok ? 'VERIFIED OK' : 'CHECK NEEDED'}</div>
          <div class="muted" style="font-size:11.5px">${b.snapshot_count || 0} snapshot(s) on disk</div>
        </div>
      </div>

      ${!s.actor_mfa_enabled ? `
        <div class="card" style="border-left:4px solid #d97706;background:#fffbeb;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div style="font-size:12.5px">
            <b>⚠️ Enroll your own authenticator before enforcing mandatory 2FA:</b>
            <span class="muted">If you turn on 2FA for your role first, your next login will ask you to scan a TOTP code before opening WorkshopOne.</span>
          </div>
          <button type="button" class="btn sm primary" id="btn-sec-enroll-self">🔐 Set up My 2FA Now</button>
        </div>` : ''}

      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
          <div>
            <h3 style="margin:0">🛡️ Two-Factor Authentication (2FA) Policy</h3>
            <p class="muted" style="margin:2px 0 0;font-size:12px">Enforce TOTP authenticator sign-in across Admin, Manager, Operational Manager, and Cost Accountant roles.</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn sm" id="btn-sec-toggle-roles">${showAllRoles ? 'Show Privileged Only' : 'Show All Roles'}</button>
            ${canManageAccess && privRolesUnforced.length ? '<button type="button" class="btn sm primary" id="btn-sec-enforce-priv">🔒 Enforce 2FA on Privileged Roles</button>' : ''}
          </div>
        </div>
        ${tableWrap([
          { label: 'Role' },
          { label: 'Tier' },
          { label: 'Active Users', num: true },
          { label: '2FA Enrolled', num: true },
          { label: 'Policy' },
          { label: '' },
        ], roleRowsHtml, { scroll: true })}
      </div>

      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
          <div>
            <h3 style="margin:0">👤 Account Hygiene &amp; Dormant / Seed Review</h3>
            <p class="muted" style="margin:2px 0 0;font-size:12px">Review pending password resets, default seed accounts, and zero-activity users. Deactivating revokes all active sessions cleanly.</p>
          </div>
          ${canManageUsers ? `<button type="button" class="btn sm danger" id="btn-sec-deactivate-sel" ${selectedUserIds.size ? '' : 'disabled'}>🚫 Deactivate Selected (${selectedUserIds.size})</button>` : ''}
        </div>
        <div class="pill-row" style="margin-bottom:10px;flex-wrap:wrap;gap:6px">
          <button type="button" class="btn sm ${userFilter === 'active' ? 'primary' : ''}" data-sec-ufilter="active">All Active (${filterCounts.active})</button>
          <button type="button" class="btn sm ${userFilter === 'pending_pw' ? 'primary' : ''}" data-sec-ufilter="pending_pw">Temp Password (${filterCounts.pending_pw})</button>
          <button type="button" class="btn sm ${userFilter === 'dormant' ? 'primary' : ''}" data-sec-ufilter="dormant">Dormant / Seed (${filterCounts.dormant})</button>
          <button type="button" class="btn sm ${userFilter === 'priv_no_mfa' ? 'primary' : ''}" data-sec-ufilter="priv_no_mfa">Privileged No-2FA (${filterCounts.priv_no_mfa})</button>
          <button type="button" class="btn sm ${userFilter === 'inactive' ? 'primary' : ''}" data-sec-ufilter="inactive">Inactive (${filterCounts.inactive})</button>
        </div>
        ${userRowsHtml.length
          ? tableWrap([
            { label: '' },
            { label: 'Account' },
            { label: 'Roles' },
            { label: '2FA' },
            { label: 'Password' },
            { label: 'Last Activity' },
            { label: 'Sessions', num: true },
            { label: 'Status' },
          ], userRowsHtml, { scroll: true })
          : '<div class="muted" style="padding:10px 0">No accounts match this filter.</div>'}
      </div>

      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
          <div>
            <h3 style="margin:0">💾 Cold Backup, Restore Verify &amp; Release Readiness</h3>
            <p class="muted" style="margin:2px 0 0;font-size:12px">Takes an online SQLite snapshot and runs read-only <code>PRAGMA integrity_check</code> without interrupting live users.</p>
          </div>
          ${canManageAccess ? '<button type="button" class="btn sm primary" id="btn-sec-backup-now">🛡️ Take Cold Backup &amp; Verify Now</button>' : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:12px">
          <span class="badge">Node ${esc(rt.node_version || '—')}</span>
          <span class="badge">Env: ${esc(rt.node_env || 'development')}</span>
          <span class="badge">Bind: ${esc(rt.host || '—')}:${esc(rt.port || '—')}</span>
          <span class="badge">DB: ${esc(rt.db_file || '—')} (${rt.multidb ? 'MultiDB' : 'Single DB'})</span>
          <span class="badge">Retention: ${b.retention || 10} · Schedule: ${b.interval_minutes || 0} min</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;font-size:12.5px">
          <div style="padding:10px;border:1px solid var(--border,#e2e8f0);border-radius:6px">
            <div class="muted" style="font-size:11px;font-weight:600">LATEST SNAPSHOT ON DISK</div>
            ${newest ? `
              <div style="margin-top:4px"><code>${esc(newest.name)}</code></div>
              <div class="muted" style="font-size:11.5px;margin-top:2px">${backupMb || '0.00'} MB · ${newest.ageMinutes} min ago · Users table: ${newest.hasUsers ? 'Present' : 'Missing'}</div>
            ` : '<div class="muted" style="margin-top:4px">No snapshot created yet in configured backup directory.</div>'}
          </div>
          <div style="padding:10px;border:1px solid var(--border,#e2e8f0);border-radius:6px">
            <div class="muted" style="font-size:11px;font-weight:600">LAST INTEGRITY VERIFICATION</div>
            ${lastVerify ? `
              <div style="margin-top:4px">
                <span class="badge ${lastVerify.ok ? 'green' : 'red'}">${lastVerify.ok ? 'PASSED (integrity_check = ok)' : 'FAILED'}</span>
              </div>
              <div class="muted" style="font-size:11.5px;margin-top:2px">${esc(lastVerify.snapshot || '')} · ${esc(String(lastVerify.at || '').slice(0, 19).replace('T', ' '))} UTC</div>
            ` : '<div class="muted" style="margin-top:4px">No restore verification recorded yet. Click Verify Now above.</div>'}
          </div>
        </div>
        <details style="margin-top:12px">
          <summary class="muted" style="cursor:pointer;font-size:12px;font-weight:600">Operator Break-Glass &amp; VPS Deployment Reference</summary>
          <div style="margin-top:8px;padding:10px;background:#f8fafc;border-radius:6px;font-size:12px;line-height:1.7">
            <div>Reset lost 2FA from server CLI: <code>node scripts/admin.js reset-mfa &lt;username&gt;</code></div>
            <div>Cold backup + non-destructive restore check: <code>npm run backup &amp;&amp; npm run restore -- --verify --latest</code></div>
            <div>Login/DB/network health diagnosis: <code>node scripts/doctor.js</code></div>
            <div>Controlled VPS deploy (auto-detects unified/legacy unit + verifies backup + auto-rollback): <code>sudo bash /opt/workshopone-unified/app/deploy/update.sh</code></div>
          </div>
        </details>
      </div>`;

    const enrollSelfBtn = qs('#btn-sec-enroll-self', c);
    if (enrollSelfBtn) {
      enrollSelfBtn.onclick = () => {
        if (typeof runMfaSetup === 'function') {
          runMfaSetup({ onDone: () => renderSecurityHardeningTab(c) });
        } else if (typeof mfaSettingsModal === 'function') {
          mfaSettingsModal();
        }
      };
    }

    const toggleRolesBtn = qs('#btn-sec-toggle-roles', c);
    if (toggleRolesBtn) {
      toggleRolesBtn.onclick = () => { showAllRoles = !showAllRoles; draw(); };
    }

    const enforcePrivBtn = qs('#btn-sec-enforce-priv', c);
    if (enforcePrivBtn) {
      enforcePrivBtn.onclick = () => applyMfaPolicy(privRolesUnforced, true);
    }

    qsa('[data-sec-mfa-role]', c).forEach((btn) => {
      btn.onclick = () => applyMfaPolicy([btn.dataset.secMfaRole], btn.dataset.secMfaVal === '1');
    });

    qsa('[data-sec-ufilter]', c).forEach((btn) => {
      btn.onclick = () => { userFilter = btn.dataset.secUfilter; draw(); };
    });

    qsa('[data-sec-uid]', c).forEach((chk) => {
      chk.onchange = () => {
        const uid = Number(chk.dataset.secUid);
        if (chk.checked) selectedUserIds.add(uid);
        else selectedUserIds.delete(uid);
        draw();
      };
    });

    const deactBtn = qs('#btn-sec-deactivate-sel', c);
    if (deactBtn) {
      deactBtn.onclick = () => {
        const picked = users.filter((u) => selectedUserIds.has(u.id));
        if (!picked.length) return;
        modal(`Deactivate ${picked.length} Selected Account(s)`, `
          <p style="font-size:13px;margin-top:0">
            The following accounts will be marked <b>inactive</b> and signed out everywhere immediately:
          </p>
          <div style="margin-bottom:10px;padding:8px 10px;background:#f8fafc;border-radius:6px;font-size:12px">
            ${picked.map((u) => `<code>${esc(u.username)}</code> (${esc(u.full_name || '—')})`).join(', ')}
          </div>
          <label style="font-size:12px;font-weight:600">Audit Reason (required) *</label>
          <input type="text" id="sec-deact-reason" placeholder="e.g. Unused default/seed account retired in Stage D security audit" style="width:100%">
          <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn" id="sec-deact-cancel">Cancel</button>
            <button type="button" class="btn danger" id="sec-deact-go">Confirm Deactivation</button>
          </div>`,
          (body, close) => {
            qs('#sec-deact-cancel', body).onclick = close;
            qs('#sec-deact-go', body).onclick = async () => {
              const reason = (qs('#sec-deact-reason', body).value || '').trim();
              if (reason.length < 3) return toast('Enter an audit reason (min 3 characters)', 'err');
              try {
                const res = await api('/access/security-posture/deactivate-users', {
                  method: 'POST',
                  body: { user_ids: picked.map((u) => u.id), reason },
                });
                selectedUserIds.clear();
                posture = res.posture;
                close();
                toast(`Deactivated ${(res.deactivated || []).length} account(s)`, 'ok');
                draw();
              } catch (e) {
                toast(e.message || 'Failed to deactivate accounts', 'err');
              }
            };
          }
        );
      };
    }

    const backupBtn = qs('#btn-sec-backup-now', c);
    if (backupBtn) {
      backupBtn.onclick = async () => {
        backupBtn.disabled = true;
        backupBtn.textContent = 'Running snapshot & integrity check…';
        try {
          const res = await api('/access/security-posture/backup-verify', { method: 'POST' });
          toast(`Backup verified OK: ${res.snapshot} (${res.verify?.tables || 0} tables, ${res.verify?.users || 0} users)`, 'ok');
          posture = await api('/access/security-posture');
          draw();
        } catch (e) {
          toast(e.message || 'Cold backup verification failed', 'err');
          backupBtn.disabled = false;
          backupBtn.textContent = '🛡️ Take Cold Backup & Verify Now';
        }
      };
    }
  };

  draw();
}
