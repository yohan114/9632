'use strict';

const ALIAS_PAGE_SIZE = 50;

function wireLazyAssetPickers(root, aopts) {
  if (!root || !aopts) return;
  qsa('select[data-lazy-assets]', root).forEach((sel) => {
    const populate = () => {
      if (sel.dataset.assetsLoaded === '1') return;
      sel.dataset.assetsLoaded = '1';
      const prev = sel.value;
      if (sel.dataset.lazyAssets === 'optgroup') {
        sel.insertAdjacentHTML('beforeend', `<optgroup label="All Registered Assets">${aopts}</optgroup>`);
      } else {
        sel.insertAdjacentHTML('beforeend', aopts);
      }
      if (prev) sel.value = prev;
    };
    sel.onmousedown = populate;
    sel.onfocus = populate;
  });
}

function renderAliasPagerHtml(total, page, pageSize, idPrefix) {
  if (total <= pageSize) return '';
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, start + pageSize - 1);
  return `
    <div id="${idPrefix}" style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px 2px;font-size:12px;flex-wrap:wrap;gap:8px">
      <span class="muted">Showing <b>${start.toLocaleString()}–${end.toLocaleString()}</b> of <b>${total.toLocaleString()}</b> record(s)</span>
      <div style="display:flex;gap:6px;align-items:center">
        <button type="button" class="sm" data-pager-dir="prev" ${page <= 1 ? 'disabled' : ''}>◀ Prev</button>
        <span class="muted">Page <b>${page}</b> of <b>${totalPages}</b></span>
        <button type="button" class="sm" data-pager-dir="next" ${page >= totalPages ? 'disabled' : ''}>Next ▶</button>
      </div>
    </div>
  `;
}

function wireAliasPager(container, page, totalPages, onPage) {
  if (!container) return;
  const prevBtn = qs('[data-pager-dir="prev"]', container);
  if (prevBtn) prevBtn.onclick = () => { if (page > 1) onPage(page - 1); };
  const nextBtn = qs('[data-pager-dir="next"]', container);
  if (nextBtn) nextBtn.onclick = () => { if (page < totalPages) onPage(page + 1); };
}

// ---- Alias queue (assets + mechanics) with Section Division & Missing Vehicle Allocation
routes.aliases = async (c) => {
  const [pending, all, assets, mPending, mechs, audit] = await Promise.all([
    api('/aliases?resolved=0'),
    api('/aliases?resolved=1&limit=500'),
    api('/assets?limit=10000'),
    api('/mechanics/aliases?resolved=0'),
    api('/mechanics'),
    api('/aliases/sections-audit').catch(() => ({ missingJobs: [], missingJobRequests: [], missingServices: [], missingIssues: [], missingMrn: [], counts: { jobs: 0, jobRequests: 0, services: 0, issues: 0, mrn: 0, totalMissing: 0 } })),
  ]);

  const aopts = assets.map((a) => {
    const regPart = (a.registration && a.registration !== a.code) ? ` (${a.registration})` : '';
    const descPart = [a.brand, a.type].filter(Boolean).join(' ');
    return `<option value="${a.id}">${esc(a.code)}${esc(regPart)}${descPart ? ' — ' + esc(descPart) : ''}</option>`;
  }).join('');
  const mopts = mechs.map((m) => `<option value="${m.id}">${esc(m.name)}${m.rate ? ' (Rs ' + m.rate + '/h)' : ''}</option>`).join('');

  // Local state
  let pendingList = [...pending];
  let missingJobs = [...(audit.missingJobs || [])];
  let missingJobRequests = [...(audit.missingJobRequests || [])];
  let missingServices = [...(audit.missingServices || [])];
  let missingIssues = [...(audit.missingIssues || [])];
  let missingMrn = [...(audit.missingMrn || [])];

  let currentMainTab = 'aliases';
  let currentSecFilter = 'all';
  let currentAllocTab = 'jobs';
  let vehSearchQuery = '';
  let allocSearchQuery = '';
  let aliasPage = 1;
  let allocPage = 1;

  const secMeta = {
    oilbook: { label: 'Oil & Fuel', icon: '🛢️', badgeCls: 'blue' },
    stores: { label: 'Stores & Requisitions', icon: '📦', badgeCls: 'green' },
    battery: { label: 'Tyres & Batteries', icon: '🔋', badgeCls: 'amber' },
    daily_work: { label: 'Daily Work', icon: '🚜', badgeCls: 'violet' },
    fleet: { label: 'Fleet Register', icon: '🚚', badgeCls: '' },
    general: { label: 'General / Other', icon: '🏷️', badgeCls: '' },
  };
  const getSecBadge = (s) => {
    const meta = secMeta[s] || secMeta.general;
    return `<span class="badge ${meta.badgeCls}">${meta.icon} ${esc(meta.label)}</span>`;
  };

  const getSecCounts = () => {
    const counts = { all: pendingList.length, oilbook: 0, stores: 0, battery: 0, daily_work: 0, other: 0 };
    for (const item of pendingList) {
      if (item.source === 'oilbook') counts.oilbook++;
      else if (item.source === 'stores') counts.stores++;
      else if (item.source === 'battery') counts.battery++;
      else if (item.source === 'daily_work') counts.daily_work++;
      else counts.other++;
    }
    return counts;
  };
  const getTotalMissing = () => missingJobs.length + missingJobRequests.length + missingServices.length + missingIssues.length + missingMrn.length;

  const updateHeaderCounters = () => {
    const sc = getSecCounts();
    const totMis = getTotalMissing();
    const valAliases = qs('#kpi-val-aliases', c); if (valAliases) valAliases.textContent = pendingList.length;
    const subAliases = qs('#kpi-sub-aliases', c); if (subAliases) subAliases.textContent = `Oil ${sc.oilbook} · Stores ${sc.stores} · Tyre ${sc.battery} · Daily ${sc.daily_work}`;
    const valJobs = qs('#kpi-val-jobs', c); if (valJobs) valJobs.textContent = missingJobs.length;
    const valJR = qs('#kpi-val-jobrequests', c); if (valJR) valJR.textContent = missingJobRequests.length;
    const valSvc = qs('#kpi-val-services', c); if (valSvc) valSvc.textContent = missingServices.length;
    const valIss = qs('#kpi-val-issues', c); if (valIss) valIss.textContent = missingIssues.length;
    const valMrn = qs('#kpi-val-mrn', c); if (valMrn) valMrn.textContent = missingMrn.length;

    const tabAliases = qs('#tab-cnt-aliases', c); if (tabAliases) tabAliases.textContent = pendingList.length;
    const tabMissing = qs('#tab-cnt-missing', c); if (tabMissing) tabMissing.textContent = totMis;

    const cntSecAll = qs('#cnt-sec-all', c); if (cntSecAll) cntSecAll.textContent = sc.all;
    const cntSecOil = qs('#cnt-sec-oilbook', c); if (cntSecOil) cntSecOil.textContent = sc.oilbook;
    const cntSecSto = qs('#cnt-sec-stores', c); if (cntSecSto) cntSecSto.textContent = sc.stores;
    const cntSecBat = qs('#cnt-sec-battery', c); if (cntSecBat) cntSecBat.textContent = sc.battery;
    const cntSecDai = qs('#cnt-sec-daily', c); if (cntSecDai) cntSecDai.textContent = sc.daily_work;
    const cntSecOth = qs('#cnt-sec-other', c); if (cntSecOth) cntSecOth.textContent = sc.other;

    const cntAlJobs = qs('#cnt-alloc-jobs', c); if (cntAlJobs) cntAlJobs.textContent = missingJobs.length;
    const cntAlJR = qs('#cnt-alloc-jobrequests', c); if (cntAlJR) cntAlJR.textContent = missingJobRequests.length;
    const cntAlSvc = qs('#cnt-alloc-services', c); if (cntAlSvc) cntAlSvc.textContent = missingServices.length;
    const cntAlIss = qs('#cnt-alloc-issues', c); if (cntAlIss) cntAlIss.textContent = missingIssues.length;
    const cntAlMrn = qs('#cnt-alloc-mrn', c); if (cntAlMrn) cntAlMrn.textContent = missingMrn.length;
  };

  const canResolve = canDo('aliases.vehicle.resolve') || isAdmin();
  const sc = getSecCounts();
  const totMis = getTotalMissing();

  c.innerHTML = `${pageHeader('Resolver Queues & Vehicle Allocation', 'Divided by section: unrecognised vehicle & mechanic text, plus missing vehicle allocations across jobs, job requests, services, issues, and stores.')}
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;margin-bottom:14px">
      <div class="card" id="kpi-aliases" style="cursor:pointer;padding:12px;border-left:4px solid var(--primary);transition:transform .15s">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:600">Pending Vehicle Aliases</div>
        <div style="font-size:22px;font-weight:700;margin:4px 0" id="kpi-val-aliases">${pendingList.length}</div>
        <div class="muted" style="font-size:11px" id="kpi-sub-aliases">Oil ${sc.oilbook} · Stores ${sc.stores} · Tyre ${sc.battery} · Daily ${sc.daily_work}</div>
      </div>
      <div class="card" id="kpi-jobs" style="cursor:pointer;padding:12px;border-left:4px solid ${missingJobs.length ? 'var(--amber,#f2a900)' : 'var(--green,#3c7d5a)'}">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:600">Job Cards Missing Vehicle</div>
        <div style="font-size:22px;font-weight:700;margin:4px 0;color:${missingJobs.length ? 'var(--amber,#d9822b)' : 'inherit'}" id="kpi-val-jobs">${missingJobs.length}</div>
        <div class="muted" style="font-size:11px">${missingJobs.length ? 'Needs vehicle allocation' : 'All jobs allocated'}</div>
      </div>
      <div class="card" id="kpi-jobrequests" style="cursor:pointer;padding:12px;border-left:4px solid ${missingJobRequests.length ? 'var(--amber,#f2a900)' : 'var(--green,#3c7d5a)'}">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:600">Job Requests Missing Vehicle</div>
        <div style="font-size:22px;font-weight:700;margin:4px 0;color:${missingJobRequests.length ? 'var(--amber,#d9822b)' : 'inherit'}" id="kpi-val-jobrequests">${missingJobRequests.length}</div>
        <div class="muted" style="font-size:11px">${missingJobRequests.length ? 'Needs vehicle allocation' : 'All requests allocated'}</div>
      </div>
      <div class="card" id="kpi-services" style="cursor:pointer;padding:12px;border-left:4px solid ${missingServices.length ? 'var(--amber,#f2a900)' : 'var(--green,#3c7d5a)'}">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:600">Services Missing Vehicle</div>
        <div style="font-size:22px;font-weight:700;margin:4px 0;color:${missingServices.length ? 'var(--amber,#d9822b)' : 'inherit'}" id="kpi-val-services">${missingServices.length}</div>
        <div class="muted" style="font-size:11px">${missingServices.length ? 'Needs vehicle allocation' : 'All services allocated'}</div>
      </div>
      <div class="card" id="kpi-issues" style="cursor:pointer;padding:12px;border-left:4px solid ${missingIssues.length ? 'var(--amber,#f2a900)' : 'var(--green,#3c7d5a)'}">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:600">Store Issues Missing Vehicle</div>
        <div style="font-size:22px;font-weight:700;margin:4px 0;color:${missingIssues.length ? 'var(--amber,#d9822b)' : 'inherit'}" id="kpi-val-issues">${missingIssues.length}</div>
        <div class="muted" style="font-size:11px">${missingIssues.length ? 'Unassigned issue lines' : 'All issues allocated'}</div>
      </div>
      <div class="card" id="kpi-mrn" style="cursor:pointer;padding:12px;border-left:4px solid ${missingMrn.length ? 'var(--primary)' : 'var(--green,#3c7d5a)'}">
        <div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:600">MRN Requisitions</div>
        <div style="font-size:22px;font-weight:700;margin:4px 0" id="kpi-val-mrn">${missingMrn.length}</div>
        <div class="muted" style="font-size:11px">${missingMrn.length ? 'General / unassigned vehicle' : 'All MRNs assigned'}</div>
      </div>
    </div>

    <div class="toolbar" style="margin:0 0 12px;gap:8px;flex-wrap:wrap">
      <div class="pill-row" id="alias_main_tabs" style="margin:0">
        <button class="sm primary" data-tab="aliases">🏷️ Pending Aliases (<span id="tab-cnt-aliases">${pendingList.length}</span>)</button>
        <button class="sm" data-tab="missing">⚠️ Missing Vehicle Allocations (<span id="tab-cnt-missing">${totMis}</span>)</button>
        <button class="sm" data-tab="mechanics">👨‍🔧 Mechanic Names (${mPending.length})</button>
        <button class="sm" data-tab="resolved">📜 Resolved History &amp; Rates</button>
      </div>
    </div>

    <!-- Tab 1: Pending Vehicle Aliases Divided by Section -->
    <div id="pane_aliases" class="card section">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <div class="pill-row" id="alias_sec_filters" style="margin:0">
          <button class="sm primary" data-sec="all">All Sections (<span id="cnt-sec-all">${sc.all}</span>)</button>
          <button class="sm" data-sec="oilbook">🛢️ Oil &amp; Fuel (<span id="cnt-sec-oilbook">${sc.oilbook}</span>)</button>
          <button class="sm" data-sec="stores">📦 Stores (<span id="cnt-sec-stores">${sc.stores}</span>)</button>
          <button class="sm" data-sec="battery">🔋 Tyres &amp; Battery (<span id="cnt-sec-battery">${sc.battery}</span>)</button>
          <button class="sm" data-sec="daily_work">🚜 Daily Work (<span id="cnt-sec-daily">${sc.daily_work}</span>)</button>
          ${sc.other ? `<button class="sm" data-sec="other">Other (<span id="cnt-sec-other">${sc.other}</span>)</button>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${canResolve ? '<button class="sm primary" id="btn_alias_auto_suggest" title="Scan pending aliases for fuzzy matches against registered fleet assets">✨ Auto-Match Suggestions</button>' : ''}
          <input id="alias_veh_filter" type="search" placeholder="Search text or section…" style="max-width:240px;margin:0;font-size:12px;padding:4px 8px">
        </div>
      </div>
      <div id="alias_veh_table_wrap"></div>
    </div>

    <!-- Tab 2: Missing Vehicle Allocations Across Sections -->
    <div id="pane_missing" class="card section" style="display:none">
      <p class="muted" style="margin-top:0;font-size:12px">Records where vehicle was not specified upon entry. Assigning a vehicle here directly links costs, stock moves, and workshop logs to the selected vehicle register.</p>
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <div class="pill-row" id="alloc_sub_tabs" style="margin:0">
          <button class="sm primary" data-alloc="jobs">🔧 Job Cards (<span id="cnt-alloc-jobs">${missingJobs.length}</span>)</button>
          <button class="sm" data-alloc="jobrequests">📋 Job Requests (<span id="cnt-alloc-jobrequests">${missingJobRequests.length}</span>)</button>
          <button class="sm" data-alloc="services">⚙️ Service Records (<span id="cnt-alloc-services">${missingServices.length}</span>)</button>
          <button class="sm" data-alloc="issues">📦 Store Issues (<span id="cnt-alloc-issues">${missingIssues.length}</span>)</button>
          <button class="sm" data-alloc="mrn">📄 Material Requisitions (<span id="cnt-alloc-mrn">${missingMrn.length}</span>)</button>
        </div>
        <input id="alloc_filter" type="search" placeholder="Search records…" style="max-width:240px;margin:0;font-size:12px;padding:4px 8px">
      </div>
      <div id="alloc_table_wrap"></div>
    </div>

    <!-- Tab 3: Mechanic Aliases -->
    <div id="pane_mechanics" class="card section" style="display:none">
      <h3 style="margin-top:0">Mechanic names — pending link (${mPending.length})</h3>
      ${mPending.length ? tableWrap([
        { label: 'Raw Text' },
        { label: 'Hits', num: true, width: '70px' },
        { label: 'Source', width: '110px' },
        { label: 'Link to Mechanic', width: '340px' }
      ],
      mPending.map((a) => `<tr><td>${esc(a.raw_text)}</td><td class="num">${a.hit_count}</td><td>${esc(a.source || '')}</td>
          <td style="white-space:nowrap">${(canDo('aliases.mechanic.resolve') || isAdmin()) ? `<select data-malias="${a.id}" style="width:auto;display:inline-block;max-width:260px"><option value="">— pick —</option>${mopts}</select> <button class="sm primary" data-mlink="${a.id}" style="margin-left:6px">Link</button>` : '<span class="muted">read-only</span>'}</td></tr>`), { fit: true }) : '<span class="muted">Queue empty — every mechanic name resolves.</span>'}
    </div>

    <!-- Tab 4: Resolved History & Rates -->
    <div id="pane_resolved" style="display:none">
      <div class="grid">
        <div class="card"><h3>Resolved vehicle aliases (${all.length})</h3>
          ${tableWrap([{ label: 'Raw Text' }, { label: 'Asset' }, { label: 'Hits', num: true }], all.map((a) => `<tr><td>${esc(a.raw_text)}</td><td>${esc(a.asset_code || '')}</td><td class="num">${a.hit_count}</td></tr>`), { scroll: true })}</div>
        <div class="card"><h3>Mechanics &amp; rates</h3>
          ${tableWrap([{ label: 'Mechanic' }, { label: 'Rate/h', num: true }], mechs.map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${m.rate == null ? '<span class="badge amber">no rate</span>' : money(m.rate)}</td></tr>`), { scroll: true })}</div>
      </div>
    </div>`;

  const renderAliasesTable = () => {
    const wrap = qs('#alias_veh_table_wrap', c);
    if (!wrap) return;
    let filtered = pendingList;
    if (currentSecFilter !== 'all') {
      if (currentSecFilter === 'other') {
        filtered = filtered.filter((a) => !['oilbook', 'stores', 'battery', 'daily_work'].includes(a.source));
      } else {
        filtered = filtered.filter((a) => a.source === currentSecFilter);
      }
    }
    if (vehSearchQuery) {
      filtered = filtered.filter((a) =>
        (a.raw_text && a.raw_text.toLowerCase().includes(vehSearchQuery)) ||
        (a.source && a.source.toLowerCase().includes(vehSearchQuery))
      );
    }

    if (!filtered.length) {
      wrap.innerHTML = `<div class="muted" style="text-align:center;padding:24px">No pending aliases found${currentSecFilter !== 'all' ? ' for ' + esc(secMeta[currentSecFilter]?.label || currentSecFilter) : ''}.</div>`;
      return;
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / ALIAS_PAGE_SIZE));
    if (aliasPage > totalPages) aliasPage = totalPages;
    const pageRows = filtered.slice((aliasPage - 1) * ALIAS_PAGE_SIZE, aliasPage * ALIAS_PAGE_SIZE);

    wrap.innerHTML = tableWrap([
      { label: 'Raw Unrecognised Text', cls: 'desc-col', width: '220px' },
      { label: 'Link to Registered Asset', width: '290px' },
      { label: 'Section / Source', width: '150px' },
      { label: 'Hits', num: true, width: '70px' }
    ],
    pageRows.map((a) => `<tr data-alias-row="${a.id}">
      <td class="desc-col"><b>${esc(a.raw_text)}</b></td>
      <td style="white-space:nowrap">
        ${canResolve ? `
          <div style="display:flex;align-items:center;gap:6px">
            <select data-alias="${a.id}" data-lazy-assets="1" style="width:190px;max-width:210px;font-size:12px;padding:3px 6px;margin:0">
              <option value="">— pick asset —</option>
            </select>
            <button class="sm primary" data-link="${a.id}" style="padding:3px 10px;font-size:12px;flex-shrink:0">Link</button>
            ${isAdmin() ? `<button class="sm" data-del-alias="${a.id}" style="padding:3px 6px;font-size:12px;flex-shrink:0" title="Ignore / Delete raw alias">✕</button>` : ''}
          </div>
        ` : '<span class="muted">read-only</span>'}
      </td>
      <td>${getSecBadge(a.source)}</td>
      <td class="num">${a.hit_count}</td>
    </tr>`), { fit: true, scroll: true }) + renderAliasPagerHtml(filtered.length, aliasPage, ALIAS_PAGE_SIZE, 'alias_veh_pager');

    wireLazyAssetPickers(wrap, aopts);
    wireAliasPager(qs('#alias_veh_pager', wrap), aliasPage, totalPages, (nextPage) => {
      aliasPage = nextPage;
      renderAliasesTable();
    });

    qsa('[data-link]', wrap).forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.link;
        const sel = qs(`[data-alias="${id}"]`, wrap);
        if (!sel || !sel.value) return toast('Pick an asset first', 'err');
        try {
          await api(`/aliases/${id}/link`, { method: 'POST', body: { asset_id: sel.value } });
          toast('Linked asset & cascaded to matching records', 'ok');
          pendingList = pendingList.filter((x) => String(x.id) !== String(id));
          updateHeaderCounters();
          renderAliasesTable();
        } catch (e) { toast(e.message, 'err'); }
      };
    });

    qsa('[data-del-alias]', wrap).forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.delAlias;
        if (!confirm('Remove this unrecognized text entry from the alias queue?')) return;
        try {
          await api(`/aliases/${id}`, { method: 'DELETE' });
          toast('Alias removed', 'ok');
          pendingList = pendingList.filter((x) => String(x.id) !== String(id));
          updateHeaderCounters();
          renderAliasesTable();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  };

  const renderAllocTable = () => {
    const wrap = qs('#alloc_table_wrap', c);
    if (!wrap) return;

    const paginateAlloc = (list) => {
      const totalPages = Math.max(1, Math.ceil(list.length / ALIAS_PAGE_SIZE));
      if (allocPage > totalPages) allocPage = totalPages;
      const pageList = list.slice((allocPage - 1) * ALIAS_PAGE_SIZE, allocPage * ALIAS_PAGE_SIZE);
      return { pageList, totalPages, total: list.length };
    };
    const bindAllocExtras = (totalPages) => {
      wireLazyAssetPickers(wrap, aopts);
      wireAliasPager(qs('#alloc_table_pager', wrap), allocPage, totalPages, (nextPage) => {
        allocPage = nextPage;
        renderAllocTable();
      });
    };

    if (currentAllocTab === 'jobs') {
      let list = missingJobs;
      if (allocSearchQuery) {
        list = list.filter((j) =>
          (j.job_no && j.job_no.toLowerCase().includes(allocSearchQuery)) ||
          (j.description && j.description.toLowerCase().includes(allocSearchQuery)) ||
          (j.workshop_name && j.workshop_name.toLowerCase().includes(allocSearchQuery))
        );
      }
      if (!list.length) {
        wrap.innerHTML = '<div class="muted" style="text-align:center;padding:24px">All job cards have vehicles allocated! No unassigned jobs found.</div>';
        return;
      }
      const { pageList, totalPages, total } = paginateAlloc(list);
      wrap.innerHTML = tableWrap([
        { label: 'Job Card', width: '130px' },
        { label: 'Allocate Vehicle', width: '280px' },
        { label: 'Date', width: '95px' },
        { label: 'Workshop', width: '150px' },
        { label: 'Type', width: '80px' },
        { label: 'Description / Task', cls: 'desc-col' }
      ],
      pageList.map((j) => `<tr data-job-row="${j.id}">
        <td><a href="#/jobs/${j.id}"><b>${esc(j.job_no)}</b></a></td>
        <td style="white-space:nowrap">
          ${canResolve ? `
            <div style="display:flex;align-items:center;gap:6px">
              <select data-job-sel="${j.id}" data-lazy-assets="1" style="width:190px;max-width:210px;font-size:12px;padding:3px 6px;margin:0">
                <option value="">— pick vehicle —</option>
              </select>
              <button class="sm primary" data-job-btn="${j.id}" style="padding:3px 10px;font-size:12px;flex-shrink:0">Allocate</button>
            </div>
          ` : '<span class="muted">read-only</span>'}
        </td>
        <td>${esc(j.requested_at ? j.requested_at.slice(0, 10) : '-')}</td>
        <td style="font-size:12px;white-space:normal;max-width:150px;line-height:1.3">${esc(j.workshop_name)}</td>
        <td><span class="badge ${j.type === 'repair' ? 'amber' : 'blue'}">${esc(j.type || 'job')}</span></td>
        <td class="desc-col">${esc(j.description || '-')}</td>
      </tr>`), { fit: true, scroll: true }) + renderAliasPagerHtml(total, allocPage, ALIAS_PAGE_SIZE, 'alloc_table_pager');
      bindAllocExtras(totalPages);

      qsa('[data-job-btn]', wrap).forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.dataset.jobBtn;
          const sel = qs(`[data-job-sel="${id}"]`, wrap);
          if (!sel || !sel.value) return toast('Pick an asset first', 'err');
          try {
            await api('/aliases/allocate-job', { method: 'POST', body: { job_id: id, asset_id: sel.value } });
            toast('Vehicle allocated to Job Card', 'ok');
            missingJobs = missingJobs.filter((x) => String(x.id) !== String(id));
            updateHeaderCounters();
            renderAllocTable();
          } catch (e) { toast(e.message, 'err'); }
        };
      });

    } else if (currentAllocTab === 'jobrequests') {
      let list = missingJobRequests;
      if (allocSearchQuery) {
        list = list.filter((r) =>
          (r.jr_no && r.jr_no.toLowerCase().includes(allocSearchQuery)) ||
          (r.description && r.description.toLowerCase().includes(allocSearchQuery)) ||
          (r.requested_by && r.requested_by.toLowerCase().includes(allocSearchQuery)) ||
          (r.workshop_name && r.workshop_name.toLowerCase().includes(allocSearchQuery))
        );
      }
      if (!list.length) {
        wrap.innerHTML = '<div class="muted" style="text-align:center;padding:24px">All job requests have vehicles allocated! No unassigned job requests found.</div>';
        return;
      }
      const { pageList, totalPages, total } = paginateAlloc(list);
      wrap.innerHTML = tableWrap([
        { label: 'Job Request', width: '130px' },
        { label: 'Allocate Vehicle', width: '280px' },
        { label: 'Date', width: '95px' },
        { label: 'Workshop', width: '150px' },
        { label: 'Status', width: '90px' },
        { label: 'Requested By', width: '120px' },
        { label: 'Work Description', cls: 'desc-col' }
      ],
      pageList.map((r) => `<tr data-jr-row="${r.id}">
        <td><a href="#/jobrequests/${r.id}"><b>${esc(r.jr_no)}</b></a></td>
        <td style="white-space:nowrap">
          ${canResolve ? `
            <div style="display:flex;align-items:center;gap:6px">
              <select data-jr-sel="${r.id}" data-lazy-assets="1" style="width:190px;max-width:210px;font-size:12px;padding:3px 6px;margin:0">
                <option value="">— pick vehicle —</option>
              </select>
              <button class="sm primary" data-jr-btn="${r.id}" style="padding:3px 10px;font-size:12px;flex-shrink:0">Allocate</button>
            </div>
          ` : '<span class="muted">read-only</span>'}
        </td>
        <td>${esc(r.req_date ? r.req_date.slice(0, 10) : '-')}</td>
        <td style="font-size:12px;white-space:normal;max-width:150px;line-height:1.3">${esc(r.workshop_name)}</td>
        <td><span class="badge ${r.approval_status === 'approved' ? 'green' : (r.approval_status === 'rejected' ? 'red' : 'amber')}">${esc(r.approval_status || 'requested')}</span></td>
        <td>${esc(r.requested_by || '-')}</td>
        <td class="desc-col">${esc(r.description || '-')}</td>
      </tr>`), { fit: true, scroll: true }) + renderAliasPagerHtml(total, allocPage, ALIAS_PAGE_SIZE, 'alloc_table_pager');
      bindAllocExtras(totalPages);

      qsa('[data-jr-btn]', wrap).forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.dataset.jrBtn;
          const sel = qs(`[data-jr-sel="${id}"]`, wrap);
          if (!sel || !sel.value) return toast('Pick an asset first', 'err');
          try {
            await api('/aliases/allocate-job-request', { method: 'POST', body: { job_request_id: id, asset_id: sel.value } });
            toast('Vehicle allocated to Job Request', 'ok');
            missingJobRequests = missingJobRequests.filter((x) => String(x.id) !== String(id));
            updateHeaderCounters();
            renderAllocTable();
          } catch (e) { toast(e.message, 'err'); }
        };
      });

    } else if (currentAllocTab === 'services') {
      let list = missingServices;
      if (allocSearchQuery) {
        list = list.filter((s) =>
          (s.vehicle_label && s.vehicle_label.toLowerCase().includes(allocSearchQuery)) ||
          (s.repair_details && s.repair_details.toLowerCase().includes(allocSearchQuery)) ||
          (s.site_location && s.site_location.toLowerCase().includes(allocSearchQuery))
        );
      }
      if (!list.length) {
        wrap.innerHTML = '<div class="muted" style="text-align:center;padding:24px">All service records have vehicles allocated! No unassigned services found.</div>';
        return;
      }
      const { pageList, totalPages, total } = paginateAlloc(list);
      wrap.innerHTML = tableWrap([
        { label: 'Service Date', width: '100px' },
        { label: 'Allocate Vehicle', width: '280px' },
        { label: 'Recorded Label', width: '120px' },
        { label: 'Site / Location', width: '130px' },
        { label: 'Repair Details', cls: 'desc-col' },
        { label: 'Total (Rs)', num: true, width: '100px' }
      ],
      pageList.map((s) => `<tr data-svc-row="${s.id}">
        <td>${esc(s.service_date || '-')}</td>
        <td style="white-space:nowrap">
          ${canResolve ? `
            <div style="display:flex;align-items:center;gap:6px">
              <select data-svc-sel="${s.id}" data-lazy-assets="1" style="width:190px;max-width:210px;font-size:12px;padding:3px 6px;margin:0">
                <option value="">— pick vehicle —</option>
              </select>
              <button class="sm primary" data-svc-btn="${s.id}" style="padding:3px 10px;font-size:12px;flex-shrink:0">Allocate</button>
            </div>
          ` : '<span class="muted">read-only</span>'}
        </td>
        <td><code>${esc(s.vehicle_label || '(blank)')}</code></td>
        <td style="font-size:12px;white-space:normal;max-width:130px">${esc(s.site_location || '-')}</td>
        <td class="desc-col">${esc(s.repair_details || '-')}</td>
        <td class="num">${money(s.grand_total || 0)}</td>
      </tr>`), { fit: true, scroll: true }) + renderAliasPagerHtml(total, allocPage, ALIAS_PAGE_SIZE, 'alloc_table_pager');
      bindAllocExtras(totalPages);

      qsa('[data-svc-btn]', wrap).forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.dataset.svcBtn;
          const sel = qs(`[data-svc-sel="${id}"]`, wrap);
          if (!sel || !sel.value) return toast('Pick an asset first', 'err');
          try {
            await api('/aliases/allocate-service', { method: 'POST', body: { service_id: id, asset_id: sel.value } });
            toast('Vehicle allocated to Service record', 'ok');
            missingServices = missingServices.filter((x) => String(x.id) !== String(id));
            updateHeaderCounters();
            renderAllocTable();
          } catch (e) { toast(e.message, 'err'); }
        };
      });

    } else if (currentAllocTab === 'issues') {
      let list = missingIssues;
      if (allocSearchQuery) {
        list = list.filter((i) =>
          (i.min_no && i.min_no.toLowerCase().includes(allocSearchQuery)) ||
          (i.description && i.description.toLowerCase().includes(allocSearchQuery)) ||
          (i.purpose && i.purpose.toLowerCase().includes(allocSearchQuery))
        );
      }
      if (!list.length) {
        wrap.innerHTML = '<div class="muted" style="text-align:center;padding:24px">All store issues have vehicles allocated! No unassigned issue lines found.</div>';
        return;
      }
      const { pageList, totalPages, total } = paginateAlloc(list);
      wrap.innerHTML = tableWrap([
        { label: 'Issue Date', width: '100px' },
        { label: 'MIN No', width: '130px' },
        { label: 'Allocate Vehicle', width: '280px' },
        { label: 'Item / Spares Description', cls: 'desc-col' },
        { label: 'Qty', num: true, width: '70px' },
        { label: 'Purpose / Job', cls: 'desc-col' },
        { label: 'Store', width: '140px' }
      ],
      pageList.map((i) => `<tr data-issue-row="${i.id}">
        <td>${esc(i.issue_date || '-')}</td>
        <td><b>${esc(i.min_no || '-')}</b></td>
        <td style="white-space:nowrap">
          ${canResolve ? `
            <div style="display:flex;align-items:center;gap:6px">
              <select data-issue-sel="${i.id}" data-lazy-assets="1" style="width:190px;max-width:210px;font-size:12px;padding:3px 6px;margin:0">
                <option value="">— pick vehicle —</option>
              </select>
              <button class="sm primary" data-issue-btn="${i.id}" style="padding:3px 10px;font-size:12px;flex-shrink:0">Allocate</button>
            </div>
          ` : '<span class="muted">read-only</span>'}
        </td>
        <td class="desc-col">${esc(i.description || '-')}</td>
        <td class="num">${i.qty} ${esc(i.unit || '')}</td>
        <td class="desc-col">${esc(i.purpose || '-')}</td>
        <td style="font-size:12px;white-space:normal;max-width:140px">${esc(i.store_name)}</td>
      </tr>`), { fit: true, scroll: true }) + renderAliasPagerHtml(total, allocPage, ALIAS_PAGE_SIZE, 'alloc_table_pager');
      bindAllocExtras(totalPages);

      qsa('[data-issue-btn]', wrap).forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.dataset.issueBtn;
          const sel = qs(`[data-issue-sel="${id}"]`, wrap);
          if (!sel || !sel.value) return toast('Pick an asset first', 'err');
          try {
            await api('/aliases/allocate-issue', { method: 'POST', body: { issue_id: id, asset_id: sel.value } });
            toast('Vehicle allocated to Store Issue', 'ok');
            missingIssues = missingIssues.filter((x) => String(x.id) !== String(id));
            updateHeaderCounters();
            renderAllocTable();
          } catch (e) { toast(e.message, 'err'); }
        };
      });

    } else if (currentAllocTab === 'mrn') {
      let list = missingMrn;
      if (allocSearchQuery) {
        list = list.filter((m) =>
          (m.mrn_no && m.mrn_no.toLowerCase().includes(allocSearchQuery)) ||
          (m.purpose && m.purpose.toLowerCase().includes(allocSearchQuery)) ||
          (m.requested_by && m.requested_by.toLowerCase().includes(allocSearchQuery))
        );
      }
      if (!list.length) {
        wrap.innerHTML = '<div class="muted" style="text-align:center;padding:24px">All MRNs have vehicles allocated!</div>';
        return;
      }
      const { pageList, totalPages, total } = paginateAlloc(list);
      wrap.innerHTML = tableWrap([
        { label: 'MRN No', width: '110px' },
        { label: 'Allocate Vehicle', width: '280px' },
        { label: 'Date', width: '95px' },
        { label: 'Requested By', width: '120px' },
        { label: 'Purpose / Notes', cls: 'desc-col' },
        { label: 'Workshop', width: '150px' },
        { label: 'Status', width: '80px' }
      ],
      pageList.map((m) => `<tr data-mrn-row="${m.id}">
        <td><a href="#/stores/mrn/${m.id}"><b>${esc(m.mrn_no || m.id)}</b></a></td>
        <td style="white-space:nowrap">
          ${canResolve ? `
            <div style="display:flex;align-items:center;gap:6px">
              <select data-mrn-sel="${m.id}" data-lazy-assets="1" style="width:190px;max-width:210px;font-size:12px;padding:3px 6px;margin:0">
                <option value="">— pick vehicle —</option>
              </select>
              <button class="sm primary" data-mrn-btn="${m.id}" style="padding:3px 10px;font-size:12px;flex-shrink:0">Allocate</button>
            </div>
          ` : '<span class="muted">read-only</span>'}
        </td>
        <td>${esc(m.req_date || '-')}</td>
        <td>${esc(m.requested_by || '-')}</td>
        <td class="desc-col">${esc(m.purpose || '-')}</td>
        <td style="font-size:12px;white-space:normal;max-width:150px">${esc(m.workshop_name)}</td>
        <td><span class="badge ${m.status === 'open' ? 'blue' : ''}">${esc(m.status || '')}</span></td>
      </tr>`), { fit: true, scroll: true }) + renderAliasPagerHtml(total, allocPage, ALIAS_PAGE_SIZE, 'alloc_table_pager');
      bindAllocExtras(totalPages);

      qsa('[data-mrn-btn]', wrap).forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.dataset.mrnBtn;
          const sel = qs(`[data-mrn-sel="${id}"]`, wrap);
          if (!sel || !sel.value) return toast('Pick an asset first', 'err');
          try {
            await api('/aliases/allocate-mrn', { method: 'POST', body: { mrn_id: id, asset_id: sel.value } });
            toast('Vehicle allocated to MRN', 'ok');
            missingMrn = missingMrn.filter((x) => String(x.id) !== String(id));
            updateHeaderCounters();
            renderAllocTable();
          } catch (e) { toast(e.message, 'err'); }
        };
      });
    }
  };

  const switchMainTab = (tab) => {
    currentMainTab = tab;
    qsa('#alias_main_tabs button', c).forEach((b) => b.classList.toggle('primary', b.dataset.tab === tab));
    const pAliases = qs('#pane_aliases', c); if (pAliases) pAliases.style.display = tab === 'aliases' ? '' : 'none';
    const pMissing = qs('#pane_missing', c); if (pMissing) pMissing.style.display = tab === 'missing' ? '' : 'none';
    const pMechs = qs('#pane_mechanics', c); if (pMechs) pMechs.style.display = tab === 'mechanics' ? '' : 'none';
    const pResolved = qs('#pane_resolved', c); if (pResolved) pResolved.style.display = tab === 'resolved' ? '' : 'none';
    if (tab === 'aliases') renderAliasesTable();
    if (tab === 'missing') renderAllocTable();
  };

  qsa('#alias_main_tabs button', c).forEach((b) => {
    b.onclick = () => switchMainTab(b.dataset.tab);
  });

  const kpiAliases = qs('#kpi-aliases', c);
  if (kpiAliases) kpiAliases.onclick = () => switchMainTab('aliases');
  const kpiJobs = qs('#kpi-jobs', c);
  if (kpiJobs) kpiJobs.onclick = () => {
    switchMainTab('missing');
    currentAllocTab = 'jobs';
    allocPage = 1;
    qsa('#alloc_sub_tabs button', c).forEach((b) => b.classList.toggle('primary', b.dataset.alloc === 'jobs'));
    renderAllocTable();
  };
  const kpiJR = qs('#kpi-jobrequests', c);
  if (kpiJR) kpiJR.onclick = () => {
    switchMainTab('missing');
    currentAllocTab = 'jobrequests';
    allocPage = 1;
    qsa('#alloc_sub_tabs button', c).forEach((b) => b.classList.toggle('primary', b.dataset.alloc === 'jobrequests'));
    renderAllocTable();
  };
  const kpiSvc = qs('#kpi-services', c);
  if (kpiSvc) kpiSvc.onclick = () => {
    switchMainTab('missing');
    currentAllocTab = 'services';
    allocPage = 1;
    qsa('#alloc_sub_tabs button', c).forEach((b) => b.classList.toggle('primary', b.dataset.alloc === 'services'));
    renderAllocTable();
  };
  const kpiIss = qs('#kpi-issues', c);
  if (kpiIss) kpiIss.onclick = () => {
    switchMainTab('missing');
    currentAllocTab = 'issues';
    allocPage = 1;
    qsa('#alloc_sub_tabs button', c).forEach((b) => b.classList.toggle('primary', b.dataset.alloc === 'issues'));
    renderAllocTable();
  };
  const kpiMrn = qs('#kpi-mrn', c);
  if (kpiMrn) kpiMrn.onclick = () => {
    switchMainTab('missing');
    currentAllocTab = 'mrn';
    allocPage = 1;
    qsa('#alloc_sub_tabs button', c).forEach((b) => b.classList.toggle('primary', b.dataset.alloc === 'mrn'));
    renderAllocTable();
  };

  qsa('#alias_sec_filters button', c).forEach((b) => {
    b.onclick = () => {
      currentSecFilter = b.dataset.sec;
      aliasPage = 1;
      qsa('#alias_sec_filters button', c).forEach((btn) => btn.classList.toggle('primary', btn.dataset.sec === currentSecFilter));
      renderAliasesTable();
    };
  });

  qsa('#alloc_sub_tabs button', c).forEach((b) => {
    b.onclick = () => {
      currentAllocTab = b.dataset.alloc;
      allocPage = 1;
      qsa('#alloc_sub_tabs button', c).forEach((btn) => btn.classList.toggle('primary', btn.dataset.alloc === currentAllocTab));
      renderAllocTable();
    };
  });

  const vehFilterInp = qs('#alias_veh_filter', c);
  if (vehFilterInp) {
    vehFilterInp.oninput = (e) => {
      vehSearchQuery = e.target.value.toLowerCase().trim();
      aliasPage = 1;
      renderAliasesTable();
    };
  }
  const autoSuggestBtn = qs('#btn_alias_auto_suggest', c);
  if (autoSuggestBtn) {
    autoSuggestBtn.onclick = () => openAliasAutoSuggestionsModal(aopts, getSecBadge, () => routes.aliases(c));
  }
  const allocFilterInp = qs('#alloc_filter', c);
  if (allocFilterInp) {
    allocFilterInp.oninput = (e) => {
      allocSearchQuery = e.target.value.toLowerCase().trim();
      allocPage = 1;
      renderAllocTable();
    };
  }

  qsa('[data-mlink]', c).forEach((b) => b.onclick = async () => {
    const sel = qs(`[data-malias="${b.dataset.mlink}"]`, c);
    if (!sel || !sel.value) return toast('Pick a mechanic', 'err');
    try {
      await api(`/mechanics/aliases/${b.dataset.mlink}/link`, { method: 'POST', body: { mechanic_id: sel.value } });
      toast('Linked mechanic', 'ok');
      routes.aliases(c);
    } catch (e) { toast(e.message, 'err'); }
  });

  renderAliasesTable();
  renderAllocTable();
};

async function openAliasAutoSuggestionsModal(aopts, getSecBadge, onLinked) {
  let res;
  try {
    res = await withModalOpening(() => api('/aliases/suggestions?limit=150&min_score=50'));
  } catch (e) {
    return toast(e.message, 'err');
  }
  const matched = ((res && res.items) || []).filter((it) => it.suggestions && it.suggestions.length > 0);
  if (!matched.length) {
    return toast('No fuzzy asset suggestions matched the current pending aliases.');
  }

  modal('✨ Auto-Match Asset Suggestions (' + matched.length + ')', `
    <p class="muted" style="margin-top:0;font-size:12px">
      Review fuzzy matches against the active fleet register. High-confidence matches (≥85%) are pre-selected. Adjust any dropdown before bulk linking.
    </p>
    <div class="toolbar" style="margin:0 0 8px;gap:6px;flex-wrap:wrap">
      <button type="button" class="sm primary" id="am-sel-high">Select ≥85%</button>
      <button type="button" class="sm" id="am-sel-all">Select All</button>
      <button type="button" class="sm" id="am-sel-clr">Clear</button>
      <div class="spacer"></div>
      <span id="am-count" class="muted" style="font-size:12px">0 selected</span>
    </div>
    <div style="max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:6px">
      ${tableWrap(
        [{ label: '', width: '32px' }, { label: 'Raw Alias' }, { label: 'Hits', num: true }, { label: 'Match Score' }, { label: 'Target Registered Asset' }],
        matched.map((it) => {
          const top = it.suggestions[0];
          const badgeCls = top.score >= 85 ? 'green' : (top.score >= 70 ? 'blue' : 'amber');
          const sugOpts = it.suggestions.map((s) => `<option value="${s.asset_id}"${s.asset_id === top.asset_id ? ' selected' : ''}>${esc(s.code)}${s.registration && s.registration !== s.code ? ` (${esc(s.registration)})` : ''} — ${s.score}% (${esc(s.reason)})</option>`).join('');
          return `<tr>
            <td><input type="checkbox" data-am-chk="${it.alias_id}" data-score="${top.score}" ${top.score >= 85 ? 'checked' : ''} style="width:auto"></td>
            <td><b>${esc(it.raw_text)}</b><br>${getSecBadge(it.source)}</td>
            <td class="num">${it.hit_count || 1}</td>
            <td><span class="badge ${badgeCls}">${top.score}%</span><div class="muted" style="font-size:10.5px">${esc(top.reason)}</div></td>
            <td>
              <select data-am-sel="${it.alias_id}" data-lazy-assets="optgroup" style="min-width:240px;font-size:12px;padding:3px 6px;margin:0">
                <optgroup label="Suggested Matches">${sugOpts}</optgroup>
              </select>
            </td>
          </tr>`;
        })
      )}
    </div>
    <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
      <button type="button" id="am-cancel">Cancel</button>
      <button type="button" class="primary" id="am-submit">✓ Link Selected</button>
    </div>`, (b, close) => {
    wireLazyAssetPickers(b, aopts);
    const countEl = qs('#am-count', b);
    const subBtn = qs('#am-submit', b);

    const updateCount = () => {
      const checked = qsa('[data-am-chk]:checked', b).length;
      countEl.textContent = `${checked} of ${matched.length} selected`;
      subBtn.disabled = checked === 0;
    };

    qsa('[data-am-chk]', b).forEach((cb) => { cb.onchange = updateCount; });
    qs('#am-sel-high', b).onclick = () => {
      qsa('[data-am-chk]', b).forEach((cb) => { cb.checked = Number(cb.dataset.score) >= 85; });
      updateCount();
    };
    qs('#am-sel-all', b).onclick = () => {
      qsa('[data-am-chk]', b).forEach((cb) => { cb.checked = true; });
      updateCount();
    };
    qs('#am-sel-clr', b).onclick = () => {
      qsa('[data-am-chk]', b).forEach((cb) => { cb.checked = false; });
      updateCount();
    };
    updateCount();

    qs('#am-cancel', b).onclick = close;
    subBtn.onclick = async () => {
      const links = [];
      qsa('[data-am-chk]:checked', b).forEach((cb) => {
        const aliasId = Number(cb.dataset.amChk);
        const sel = qs(`[data-am-sel="${aliasId}"]`, b);
        const assetId = sel ? Number(sel.value) : 0;
        if (aliasId && assetId) links.push({ alias_id: aliasId, asset_id: assetId });
      });
      if (!links.length) return toast('Select at least one alias with a valid asset', 'err');
      subBtn.disabled = true;
      subBtn.textContent = 'Linking...';
      try {
        const out = await api('/aliases/bulk-link', { method: 'POST', body: { links } });
        toast(`Linked ${out.linked_count || 0} aliases (${out.skipped_count || 0} skipped)`);
        close();
        if (onLinked) onLinked();
      } catch (e) {
        toast(e.message, 'err');
        subBtn.disabled = false;
        subBtn.textContent = '✓ Link Selected';
      }
    };
  }, { wide: true });
}
