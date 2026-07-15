'use strict';
/* WorkshopOne SPA — vanilla JS, no build step. Consumes /api/*. */

// ---------------------------------------------------------------- API + util
let ME = null;

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = new Error((data && data.error) || res.statusText);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => (Number(n) || 0).toLocaleString('en-US');
const can = (...roles) => ME && (ME.roles.includes('admin') || roles.some((r) => ME.roles.includes(r)));
const qs = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => [...r.querySelectorAll(s)];

const STATUS_CLASS = {
  REQUESTED: '', APPROVED_TRANSPORT: 'blue', APPROVED_OPERATIONS: 'blue',
  IN_WORKSHOP: 'amber', IN_PROGRESS: 'amber', WORK_COMPLETE: 'amber',
  CLOSED: 'green', REJECTED: 'red',
};
const statusBadge = (s) => `<span class="badge ${STATUS_CLASS[s] || ''}">${esc(s)}</span>`;

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99;padding:10px 18px;border-radius:8px;box-shadow:var(--shadow);font-weight:600;color:#fff;background:${kind === 'err' ? 'var(--red)' : 'var(--green)'}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function modal(title, bodyHtml, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2>${esc(title)}</h2><div class="mbody">${bodyHtml}</div></div>`;
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  if (onMount) onMount(qs('.mbody', bg), () => bg.remove());
  return bg;
}

function field(label, name, opts = {}) {
  const t = opts.type || 'text';
  if (t === 'select') {
    const options = (opts.options || []).map((o) => `<option value="${esc(o.value)}" ${o.value == opts.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    return `<label>${esc(label)}</label><select name="${name}">${options}</select>`;
  }
  if (t === 'textarea') return `<label>${esc(label)}</label><textarea name="${name}" rows="2">${esc(opts.value || '')}</textarea>`;
  if (t === 'checkbox') return `<label style="display:flex;gap:8px;align-items:center;flex-direction:row"><input type="checkbox" name="${name}" style="width:auto" ${opts.value ? 'checked' : ''}> ${esc(label)}</label>`;
  return `<label>${esc(label)}</label><input type="${t}" name="${name}" value="${esc(opts.value ?? '')}" placeholder="${esc(opts.placeholder || '')}">`;
}
function formData(root) {
  const out = {};
  qsa('input,select,textarea', root).forEach((el) => {
    if (!el.name) return;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return out;
}

// ---------------------------------------------------------------- shell
const NAV = [
  ['dashboard', '📊', 'Dashboard'],
  ['assets', '🚜', 'Assets'],
  ['jobs', '🔧', 'Job Cards'],
  ['stores', '📦', 'Stores'],
  ['oil', '🛢️', 'Oil & Lube'],
  ['batteries', '🔋', 'Batteries'],
  ['projects', '🏗️', 'Projects'],
  ['aliases', '🔗', 'Alias Queue'],
  ['reports', '📈', 'Reports'],
  ['users', '👤', 'Users', 'admin'],
];

function renderShell() {
  const route = (location.hash.replace('#/', '').split('?')[0].split('/')[0]) || 'dashboard';
  const nav = NAV.filter((n) => !n[3] || can(n[3])).map(
    (n) => `<a href="#/${n[0]}" class="${route === n[0] ? 'active' : ''}"><span class="ico">${n[1]}</span>${n[2]}</a>`
  ).join('');
  qs('#app').innerHTML = `
    <div class="topbar">
      <button class="hamburger" id="ham">☰</button>
      <div class="brand">Workshop<span>One</span></div>
      <div class="spacer"></div>
      <div class="who">${esc(ME.fullName || ME.username)} · ${ME.roles.join(', ')}</div>
      <button class="sm" id="logout">Logout</button>
    </div>
    <div class="layout">
      <nav class="nav" id="nav">${nav}</nav>
      <main class="content" id="content"><div class="muted">Loading…</div></main>
    </div>`;
  qs('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); ME = null; location.hash = ''; boot(); };
  qs('#ham').onclick = () => qs('#nav').classList.toggle('open');
  qsa('#nav a').forEach((a) => a.addEventListener('click', () => qs('#nav').classList.remove('open')));
}

// ---------------------------------------------------------------- router
const routes = {};
async function render() {
  if (!ME) return;
  renderShell();
  const parts = location.hash.replace('#/', '').split('?')[0].split('/');
  const page = parts[0] || 'dashboard';
  const content = qs('#content');
  const fn = routes[page] || routes.dashboard;
  try {
    await fn(content, parts.slice(1));
  } catch (e) {
    content.innerHTML = `<div class="card"><p class="err">Error: ${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- pages
function pageHeader(title, crumb) {
  return `${crumb ? `<div class="crumb">${crumb}</div>` : ''}<h1>${esc(title)}</h1>`;
}
function tableWrap(headers, rows, opts = {}) {
  const th = headers.map((h) => `<th class="${h.num ? 'num' : ''}">${esc(h.label)}</th>`).join('');
  const body = rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="muted" style="text-align:center;padding:20px">No records</td></tr>`;
  return `<div class="table-wrap ${opts.scroll ? 'scroll' : ''}"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---- Dashboard
routes.dashboard = async (c) => {
  const d = await api('/reports/dashboard');
  const statusRows = d.jobs_by_status.map((s) => `<tr><td>${statusBadge(s.status)}</td><td class="num">${s.count}</td></tr>`);
  const maxProj = Math.max(1, ...d.month_cost_by_project.map((p) => p.total));
  const projBars = d.month_cost_by_project.map((p) => `
    <div class="cost-line"><span>${esc(p.project)}</span><span>${money(p.total)}</span></div>
    <div class="bar-track"><div class="bar" style="width:${(p.total / maxProj) * 100}%"></div></div>`).join('') || '<span class="muted">No cost this month</span>';
  c.innerHTML = `
    ${pageHeader('Dashboard')}
    <div class="grid section">
      <div class="card stat"><span class="n">${d.open_jobs_count}</span><span class="l">Open Job Cards</span></div>
      <div class="card stat"><span class="n">${d.closed_this_month_count}</span><span class="l">Closed This Month</span></div>
      <div class="card stat"><span class="n">${d.awaiting_price.length}</span><span class="l">Awaiting Price (blocked)</span></div>
      <div class="card stat"><span class="n">${d.low_stock_oil.length}</span><span class="l">Low-stock Lubricants</span></div>
      <div class="card stat"><span class="n">${d.batteries_warranty.length}</span><span class="l">Battery Warranty ≤60d</span></div>
    </div>
    <div class="grid">
      <div class="card"><h3>Jobs by Status</h3>${tableWrap([{ label: 'Status' }, { label: 'Count', num: true }], statusRows)}</div>
      <div class="card"><h3>Awaiting Price — blocking closure</h3>
        ${d.awaiting_price.length ? d.awaiting_price.map((j) => `<div class="cost-line"><a href="#/jobs/${j.id}">${esc(j.job_no)} · ${esc(j.asset_code || '?')}</a><span class="badge red">${j.missing_count} unpriced</span></div>`).join('') : '<span class="muted">None — all priced</span>'}
      </div>
      <div class="card"><h3>This-Month Cost by Project</h3>${projBars}</div>
      <div class="card"><h3>Low-stock Lubricants</h3>
        ${d.low_stock_oil.length ? d.low_stock_oil.map((p) => `<div class="cost-line"><span>${esc(p.name)}</span><span class="badge amber">${num(p.balance)} / ${num(p.reorder_level)} ${esc(p.unit)}</span></div>`).join('') : '<span class="muted">All above reorder level</span>'}
      </div>
      <div class="card"><h3>Battery Warranty Radar</h3>
        ${d.batteries_warranty.length ? d.batteries_warranty.map((b) => `<div class="cost-line"><span>${esc(b.serial_no)} ${b.asset_code ? '· ' + esc(b.asset_code) : ''}</span><span class="badge amber">${esc(b.warranty_date)}</span></div>`).join('') : '<span class="muted">Nothing expiring soon</span>'}
      </div>
    </div>`;
};

// ---- Assets
routes.assets = async (c, params) => {
  if (params[0]) return assetDetail(c, params[0]);
  const q = new URLSearchParams(location.search);
  const list = await api('/assets?limit=500');
  const rows = list.map((a) => `<tr data-id="${a.id}" style="cursor:pointer">
    <td><a href="#/assets/${a.id}">${esc(a.code)}</a></td>
    <td><span class="badge">${esc(a.asset_class)}</span></td>
    <td>${esc(a.brand || '')} ${esc(a.type || '')}</td>
    <td>${esc(a.current_project || '—')}</td>
    <td><span class="badge ${a.status === 'active' ? 'green' : a.status === 'under_repair' ? 'amber' : ''}">${esc(a.status)}</span></td>
    <td class="num">${a.open_jobs}</td>
    <td class="num">${money(a.lifetime_cost)}</td></tr>`);
  c.innerHTML = `${pageHeader('Fleet & Asset Registry')}
    <div class="toolbar">
      <input id="asearch" placeholder="Search code / brand / type…" style="max-width:280px">
      <div class="spacer"></div>
      <a class="btn" href="/api/assets/export.xlsx">⬇ Excel</a>
      ${can('storekeeper') ? '<button class="primary" id="newasset">+ New Asset</button>' : ''}
    </div>
    ${tableWrap([{ label: 'Code' }, { label: 'Class' }, { label: 'Make/Type' }, { label: 'Project' }, { label: 'Status' }, { label: 'Open Jobs', num: true }, { label: 'Lifetime Cost', num: true }], rows, { scroll: true })}`;
  qs('#asearch').oninput = (e) => {
    const v = e.target.value.toLowerCase();
    qsa('#content tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(v) ? '' : 'none'; });
  };
  if (qs('#newasset')) qs('#newasset').onclick = newAssetModal;
};

async function newAssetModal() {
  const projects = await api('/projects');
  const opts = [{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
  modal('New Asset', `
    <div class="row">${field('Code *', 'code', { placeholder: 'e.g. 28-4314' })}${field('Class', 'asset_class', { type: 'select', options: ['vehicle', 'plant', 'generator', 'tool', 'machine', 'other'].map((v) => ({ value: v, label: v })) })}</div>
    <div class="row">${field('Brand', 'brand')}${field('Type', 'type')}</div>
    <div class="row">${field('Home Project', 'home_project_id', { type: 'select', options: opts })}${field('Registration', 'registration')}</div>
    <div style="margin-top:14px;text-align:right"><button class="primary" id="save">Create</button></div>`, (body, close) => {
    qs('#save', body).onclick = async () => {
      const d = formData(body);
      d.current_project_id = d.home_project_id;
      try { await api('/assets', { method: 'POST', body: d }); toast('Asset created'); close(); render(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function assetDetail(c, id) {
  const a = await api('/assets/' + id);
  const lc = a.lifetime_cost;
  const sd = a.service_due;
  c.innerHTML = `${pageHeader(a.asset.code, '<a href="#/assets">← Assets</a>')}
    <div class="toolbar"><span class="badge">${esc(a.asset.asset_class)}</span>
      <span class="badge ${a.asset.status === 'active' ? 'green' : a.asset.status === 'under_repair' ? 'amber' : ''}">${esc(a.asset.status)}</span>
      <span class="muted">${esc(a.asset.brand || '')} ${esc(a.asset.type || '')} · ${esc(a.current_project ? a.current_project.name : 'no project')}</span>
      <div class="spacer"></div>
      ${can('storekeeper') ? '<button class="sm" id="editasset">Edit</button>' : ''}
    </div>
    <div class="grid section">
      <div class="card"><h3>Lifetime Cost</h3>
        <div class="cost-line"><span>Labour</span><span>${money(lc.labour)}</span></div>
        <div class="cost-line"><span>Material</span><span>${money(lc.material)}</span></div>
        <div class="cost-line"><span>Oil</span><span>${money(lc.oil)}</span></div>
        <div class="cost-line"><span>General</span><span>${money(lc.general)}</span></div>
        <div class="cost-line"><span>External</span><span>${money(lc.external)}</span></div>
        <div class="cost-line total"><span>Total</span><span>${money(lc.total)}</span></div>
      </div>
      <div class="card"><h3>Current Battery</h3>
        ${a.current_battery ? `<p><b>${esc(a.current_battery.serial_no)}</b><br>${esc(a.current_battery.brand || '')} ${a.current_battery.capacity_ah || ''}Ah<br><span class="muted">Warranty: ${esc(a.current_battery.warranty_date || '—')}</span></p>` : '<span class="muted">No battery installed</span>'}
        <h3 style="margin-top:14px">Service Due</h3>
        ${sd ? `<div class="cost-line"><span>Running / Interval</span><span>${num(sd.running_hours)} / ${num(sd.interval_hours)} h</span></div>
          <div class="cost-line"><span>Status</span>${sd.due ? '<span class="badge red">DUE NOW</span>' : `<span class="badge green">${num(sd.hours_remaining)} h left</span>`}</div>
          <div class="cost-line"><span>Expected cost</span><span>${money(sd.expected_cost)}</span></div>` : '<span class="muted">No service spec</span>'}
      </div>
      <div class="card"><h3>Open Job Cards</h3>
        ${a.open_jobs.length ? a.open_jobs.map((j) => `<div class="cost-line"><a href="#/jobs/${j.id}">${esc(j.job_no)}</a>${statusBadge(j.status)}</div>`).join('') : '<span class="muted">None open</span>'}
      </div>
    </div>
    <div class="card"><h3>Unified Timeline</h3>
      <ul class="timeline">${a.timeline.map((t) => `<li><span class="date">${esc(t.date || '')}</span><span class="badge ${t.kind === 'job' ? 'blue' : ''}">${esc(t.kind)}</span><span>${esc(t.ref ? t.ref + ' · ' : '')}${esc(t.description || '')}</span></li>`).join('') || '<li class="muted">No activity</li>'}</ul>
    </div>`;
  if (qs('#editasset')) qs('#editasset').onclick = () => editAssetModal(a.asset);
}

async function editAssetModal(asset) {
  const projects = await api('/projects');
  const popts = [{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
  modal('Edit ' + asset.code, `
    <div class="row">${field('Brand', 'brand', { value: asset.brand })}${field('Type', 'type', { value: asset.type })}</div>
    <div class="row">${field('Status', 'status', { type: 'select', value: asset.status, options: ['active', 'idle', 'under_repair', 'decommissioned'].map((v) => ({ value: v, label: v })) })}${field('Current Project', 'current_project_id', { type: 'select', value: asset.current_project_id, options: popts })}</div>
    <div class="row">${field('Running Hours', 'running_hours', { type: 'number', value: asset.running_hours })}${field('Registration', 'registration', { value: asset.registration })}</div>
    <div style="margin-top:14px;text-align:right"><button class="primary" id="save">Save</button></div>`, (body, close) => {
    qs('#save', body).onclick = async () => {
      try { await api('/assets/' + asset.id, { method: 'PATCH', body: formData(body) }); toast('Saved'); close(); render(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- Job Cards
routes.jobs = async (c, params) => {
  if (params[0]) return jobDetail(c, params[0]);
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
  const list = await api('/jobs' + (status ? '?status=' + status : ''));
  const rows = list.map((j) => `<tr>
    <td><a href="#/jobs/${j.id}">${esc(j.job_no)}</a></td>
    <td>${esc(j.asset_code || '—')}</td>
    <td><span class="badge ${j.type === 'service' ? 'blue' : ''}">${esc(j.type)}</span></td>
    <td>${statusBadge(j.status)}</td>
    <td>${esc(j.project_name || '')}</td>
    <td class="num">${money(j.total_cost)}</td>
    <td class="muted">${esc((j.requested_at || '').slice(0, 10))}</td></tr>`);
  c.innerHTML = `${pageHeader('Job Cards')}
    <div class="toolbar">
      <select id="jstatus" style="max-width:200px"><option value="">All statuses</option>${['REQUESTED', 'APPROVED_TRANSPORT', 'APPROVED_OPERATIONS', 'IN_WORKSHOP', 'IN_PROGRESS', 'WORK_COMPLETE', 'CLOSED', 'REJECTED'].map((s) => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <div class="spacer"></div>
      ${can('transport_manager', 'workshop') ? '<button class="primary" id="newjob">+ New Job Card</button>' : ''}
    </div>
    ${tableWrap([{ label: 'Job No' }, { label: 'Asset' }, { label: 'Type' }, { label: 'Status' }, { label: 'Project' }, { label: 'Total', num: true }, { label: 'Requested' }], rows, { scroll: true })}`;
  qs('#jstatus').onchange = (e) => { location.hash = '#/jobs' + (e.target.value ? '?status=' + e.target.value : ''); };
  if (qs('#newjob')) qs('#newjob').onclick = newJobModal;
};

async function newJobModal() {
  const projects = await api('/projects');
  const popts = [{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
  modal('New Job Card', `
    <p class="muted">The asset is resolved through the master alias engine — type any code or description.</p>
    ${field('Asset (code or text) *', 'asset', { placeholder: 'e.g. 28-4314 or "CAT 320 excavator"' })}
    <div class="row">${field('Type', 'type', { type: 'select', options: [{ value: 'repair', label: 'repair' }, { value: 'service', label: 'service' }] })}${field('Severity', 'severity', { type: 'select', options: [{ value: '', label: '—' }, { value: 'major', label: 'major' }, { value: 'minor', label: 'minor' }] })}</div>
    ${field('Project', 'project_id', { type: 'select', options: popts })}
    ${field('Description *', 'description', { type: 'textarea' })}
    <div style="margin-top:14px;text-align:right"><button class="primary" id="save">Raise Job Card</button></div>`, (body, close) => {
    qs('#save', body).onclick = async () => {
      try {
        const r = await api('/jobs', { method: 'POST', body: formData(body) });
        close();
        if (r.unresolved) toast('Job raised — asset "' + r.unresolved.raw + '" queued in Alias Queue for linking', 'err');
        else toast('Job card ' + r.job.job_no + ' raised');
        location.hash = '#/jobs/' + r.job.id;
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function jobDetail(c, id) {
  const j = await api('/jobs/' + id);
  const job = j.job;
  const r = j.readiness;
  const transitions = j.nextStates.map((s) => `<button class="sm ${s === 'CLOSED' ? 'primary' : ''}" data-to="${s}">${s.replace(/_/g, ' ')}</button>`).join(' ');
  c.innerHTML = `${pageHeader(job.job_no, '<a href="#/jobs">← Job Cards</a>')}
    <div class="toolbar">${statusBadge(job.status)}<span class="badge ${job.type === 'service' ? 'blue' : ''}">${esc(job.type)}</span>
      ${job.severity ? `<span class="badge">${esc(job.severity)}</span>` : ''}
      <a href="#/assets/${job.asset_id}">${esc(job.asset_code || '—')}</a>
      <span class="muted">${esc(job.project_name || '')}</span>
      <div class="spacer"></div>
      ${job.type === 'service' && can('workshop', 'operational_manager') && job.status !== 'CLOSED' ? `<button class="sm" id="flatlabour">Service labour${job.flat_labour != null ? ': ' + money(job.flat_labour) : ' (flat)'}</button>` : ''}
      <a class="btn sm" href="/api/reports/job/${job.id}/costsheet.html" target="_blank">🖨 Cost Sheet</a>
    </div>
    ${job.type === 'service' ? `<p class="muted" style="font-size:12px">Service job — labour is a flat charge${job.flat_labour == null ? ' (not set yet)' : ''}, not hours×rate.</p>` : ''}
    <p>${esc(job.description || '')}</p>
    ${transitions ? `<div class="card section"><h3>Actions</h3><div class="pill-row" id="transitions">${transitions}</div>
      ${!r.ready ? `<p class="err" style="margin-top:10px">⚠ Closure gate — ${r.missing.length} line(s) awaiting price:</p><ul>${r.missing.map((m) => `<li class="muted">${esc(m)}</li>`).join('')}</ul>` : '<p class="ok" style="margin-top:10px">✓ Fully priced — ready to close</p>'}
    </div>` : ''}
    <div class="grid section">
      <div class="card"><h3>Cost Breakdown ${job.status === 'CLOSED' ? '(frozen snapshot)' : '(live)'}</h3>
        <div class="cost-line"><span>Labour</span><span>${money(j.cost.labour_cost)}</span></div>
        <div class="cost-line"><span>Material</span><span>${money(j.cost.material_cost)}</span></div>
        <div class="cost-line"><span>Oil</span><span>${money(j.cost.oil_cost)}</span></div>
        <div class="cost-line"><span>General</span><span>${money(j.cost.general_cost)}</span></div>
        <div class="cost-line"><span>External</span><span>${money(j.cost.external_cost)}</span></div>
        <div class="cost-line total"><span>Total</span><span>${money(j.cost.total_cost)}</span></div>
      </div>
      <div class="card"><h3>Approvals</h3>
        ${j.approvals.length ? j.approvals.map((a) => `<div class="cost-line"><span>${esc(a.role.replace(/_/g, ' '))}</span><span class="badge ${a.decision === 'approved' ? 'green' : 'red'}">${esc(a.decision)}</span></div>${a.reason ? `<div class="muted" style="font-size:12px">${esc(a.reason)}</div>` : ''}`).join('') : '<span class="muted">No approvals yet</span>'}
      </div>
    </div>
    <div class="card section"><div class="toolbar" style="margin:0 0 10px"><h3 style="margin:0">Daily Work</h3><div class="spacer"></div>${can('workshop') && job.status !== 'CLOSED' ? '<button class="sm" id="adddaily">+ Add</button>' : ''}</div>
      ${tableWrap([{ label: 'Date' }, { label: 'Mechanic' }, { label: 'Description' }, { label: 'Hours', num: true }, { label: 'Rate', num: true }, { label: 'Amount', num: true }, { label: '' }],
        j.dailyWork.map((w) => {
          const lab = j.labour.find((l) => l.mechanic === w.mechanic && l.work_date === w.work_date) || {};
          return `<tr><td>${esc(w.work_date)}</td><td>${esc(w.mechanic || (w.is_external ? '(external)' : ''))}</td><td>${esc(w.description || '')}</td>
            <td class="num">${w.is_external ? '—' : num(w.hours)}</td><td class="num">${w.is_external ? '—' : money(lab.rate)}</td>
            <td class="num">${w.is_external ? money(w.external_value) : money(lab.amount)}</td>
            <td>${can('workshop') && job.status !== 'CLOSED' ? `<button class="sm danger" data-del-daily="${w.id}">✕</button>` : ''}</td></tr>`;
        }))}
    </div>
    <div class="card section"><div class="toolbar" style="margin:0 0 10px"><h3 style="margin:0">Parts &amp; External</h3><div class="spacer"></div>${can('workshop', 'storekeeper') && job.status !== 'CLOSED' ? '<button class="sm" id="addpart">+ Add</button>' : ''}</div>
      ${tableWrap([{ label: 'Source' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Amount', num: true }, { label: '' }],
        j.parts.map((p) => `<tr><td><span class="badge">${esc(p.source_type)}${p.is_external_repair ? ' · ext' : ''}</span></td><td>${esc(p.description || '')}</td>
          <td class="num">${num(p.qty)}</td>
          <td class="num">${p.unit_price == null ? '<span class="badge amber">awaiting</span>' : money(p.unit_price)}</td>
          <td class="num">${p.unit_price == null ? '—' : money(p.qty * p.unit_price)}</td>
          <td>${can('workshop', 'storekeeper') && job.status !== 'CLOSED' ? `<button class="sm" data-price="${p.id}">Price</button> <button class="sm danger" data-del-part="${p.id}">✕</button>` : ''}</td></tr>`))}
    </div>
    ${j.oilIssues.length ? `<div class="card section"><h3>Oil / Lubricant Issued</h3>${tableWrap([{ label: 'Product' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }], j.oilIssues.map((o) => `<tr><td>${esc(o.product_name)}</td><td class="num">${num(Math.abs(o.qty))} ${esc(o.unit)}</td><td class="num">${money(o.unit_price)}</td></tr>`))}</div>` : ''}`;

  // wire actions
  qsa('#transitions button').forEach((b) => b.onclick = () => doTransition(job.id, b.dataset.to, job.status));
  if (qs('#flatlabour')) qs('#flatlabour').onclick = () => modal('Service Labour (flat charge)',
    field('Flat labour amount (Rs)', 'flat_labour', { type: 'number', value: job.flat_labour ?? '' }) + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>',
    (body, close) => { qs('#s', body).onclick = async () => { try { await api(`/jobs/${job.id}/flat-labour`, { method: 'PATCH', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } }; });
  if (qs('#adddaily')) qs('#adddaily').onclick = () => addDailyModal(job.id);
  if (qs('#addpart')) qs('#addpart').onclick = () => addPartModal(job.id);
  qsa('[data-del-daily]').forEach((b) => b.onclick = async () => { await api(`/jobs/${job.id}/daily-work/${b.dataset.delDaily}`, { method: 'DELETE' }); render(); });
  qsa('[data-del-part]').forEach((b) => b.onclick = async () => { await api(`/jobs/${job.id}/parts/${b.dataset.delPart}`, { method: 'DELETE' }); render(); });
  qsa('[data-price]').forEach((b) => b.onclick = () => {
    modal('Set Unit Price', field('Unit Price', 'unit_price', { type: 'number' }) + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>', (body, close) => {
      qs('#s', body).onclick = async () => { await api(`/jobs/${job.id}/parts/${b.dataset.price}`, { method: 'PATCH', body: formData(body) }); close(); render(); };
    });
  });
}

async function doTransition(jobId, to, current) {
  const needsReason = to === 'REJECTED' || (current === 'APPROVED_TRANSPORT' && to === 'REQUESTED');
  let reason = null;
  if (needsReason) { reason = prompt('Reason?'); if (reason === null) return; }
  try {
    await api(`/jobs/${jobId}/transition`, { method: 'POST', body: { to, reason } });
    toast('Moved to ' + to);
    render();
  } catch (e) {
    if (e.data && e.data.missing) toast('Blocked: ' + e.data.missing.length + ' unpriced line(s)', 'err');
    else toast(e.message, 'err');
  }
}

async function addDailyModal(jobId) {
  modal('Add Daily Work', `
    <div class="row">${field('Date', 'work_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}${field('Mechanic(s) — comma / & separated', 'mechanic', { placeholder: 'e.g. Buddhika, Krishna' })}</div>
    <p class="muted" style="font-size:12px;margin:2px 0 0">Several mechanics split the total hours equally (one costed row each). A slash name ("Seethananda/seetha") stays one person.</p>
    ${field('Description', 'description')}
    ${field('Hours', 'hours', { type: 'number' })}
    ${field('External repair (outside work)', 'is_external', { type: 'checkbox' })}
    ${field('External value (if external)', 'external_value', { type: 'number' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => { try { await api(`/jobs/${jobId}/daily-work`, { method: 'POST', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } };
  });
}
async function addPartModal(jobId) {
  modal('Add Part / External', `
    ${field('Source', 'source_type', { type: 'select', options: [{ value: 'grn', label: 'GRN (stores)' }, { value: 'issue', label: 'Issue' }, { value: 'general', label: 'General item' }, { value: 'external', label: 'External repair' }] })}
    ${field('Description', 'description')}
    <div class="row">${field('Qty', 'qty', { type: 'number', value: 1 })}${field('Unit Price (blank = later)', 'unit_price', { type: 'number' })}</div>
    ${field('Is external repair', 'is_external_repair', { type: 'checkbox' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => { try { await api(`/jobs/${jobId}/parts`, { method: 'POST', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } };
  });
}

// ---- Stores
routes.stores = async (c) => {
  const tab = (location.hash.split('?')[1] && new URLSearchParams(location.hash.split('?')[1]).get('tab')) || 'items';
  const tabs = ['items', 'reorder', 'mrn', 'grn', 'issues', 'mtn'];
  const tabBar = `<div class="toolbar">${tabs.map((t) => `<button class="sm ${t === tab ? 'primary' : ''}" onclick="location.hash='#/stores?tab=${t}'">${t.toUpperCase()}</button>`).join('')}</div>`;
  c.innerHTML = pageHeader('Stores & Inventory') + tabBar + '<div id="storebody" class="muted">Loading…</div>';
  const body = qs('#storebody');
  if (tab === 'items') {
    const items = await api('/stores/items?limit=500');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="ni">+ New Item</button></div>' : ''}
      ${tableWrap([{ label: 'Name' }, { label: 'Part No' }, { label: 'Category' }, { label: 'Unit' }, { label: 'General?' }, { label: 'Balance', num: true }, { label: 'Min', num: true }],
        items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.part_number || '')}</td><td>${esc(i.category || '')}</td><td>${esc(i.unit)}</td><td>${i.is_general ? '✓' : ''}</td><td class="num">${i.is_general ? num(i.balance) : '—'}</td><td class="num">${i.min_stock || ''}</td></tr>`), { scroll: true })}`;
    if (qs('#ni')) qs('#ni').onclick = () => simpleCreateModal('New Store Item', '/stores/items', [['Name *', 'name'], ['Part Number', 'part_number'], ['Category', 'category'], ['Unit', 'unit'], ['Min Stock', 'min_stock', 'number'], ['General consumable', 'is_general', 'checkbox']]);
  } else if (tab === 'reorder') {
    const items = await api('/stores/reorder');
    body.innerHTML = tableWrap([{ label: 'Name' }, { label: 'Balance', num: true }, { label: 'Min Stock', num: true }], items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num"><span class="badge red">${num(i.balance)}</span></td><td class="num">${num(i.min_stock)}</td></tr>`));
  } else if (tab === 'mrn') {
    const list = await api('/stores/mrn');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="nm">+ New MRN</button></div>' : ''}
      ${tableWrap([{ label: 'MRN No' }, { label: 'Date' }, { label: 'Asset' }, { label: 'Purpose' }, { label: 'Lines', num: true }, { label: 'Status' }],
        list.map((m) => `<tr><td>${esc(m.mrn_no)}</td><td>${esc(m.req_date)}</td><td>${esc(m.asset_code || '—')}</td><td>${esc(m.purpose || '')}</td><td class="num">${m.line_count}</td><td><span class="badge ${m.status === 'received' ? 'green' : 'amber'}">${esc(m.status)}</span></td></tr>`), { scroll: true })}`;
    if (qs('#nm')) qs('#nm').onclick = newMrnModal;
  } else if (tab === 'grn') {
    const list = await api('/stores/grn');
    body.innerHTML = tableWrap([{ label: 'GRN' }, { label: 'MRN' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Supplier' }, { label: 'Source' }],
      list.map((g) => `<tr><td>${esc(g.grn_no || '')}</td><td>${esc(g.mrn_no || '')}</td><td>${esc(g.description || '')}</td><td class="num">${num(g.qty)}</td><td class="num">${g.unit_price == null ? '<span class="badge amber">awaiting</span>' : money(g.unit_price)}</td><td>${esc(g.supplier || '')}</td><td>${esc(g.purchase_source || '')}</td></tr>`), { scroll: true });
  } else if (tab === 'issues') {
    const list = await api('/stores/issues');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="nis">+ New Issue</button></div>' : ''}
      ${tableWrap([{ label: 'Date' }, { label: 'Asset' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }],
        list.map((i) => `<tr><td>${esc(i.issue_date)}</td><td>${esc(i.asset_code || '—')}</td><td>${esc(i.description)}</td><td class="num">${num(i.qty)}</td><td class="num">${i.unit_price == null ? '—' : money(i.unit_price)}</td></tr>`), { scroll: true })}`;
    if (qs('#nis')) qs('#nis').onclick = () => simpleCreateModal('New Issue', '/stores/issues', [['Asset (code/text) *', 'asset'], ['Description *', 'description'], ['Qty', 'qty', 'number'], ['Unit Price', 'unit_price', 'number'], ['Issued by', 'issued_by']]);
  } else if (tab === 'mtn') {
    const list = await api('/stores/mtn');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="nt">+ New MTN</button></div>' : ''}
      ${tableWrap([{ label: 'MTN No' }, { label: 'Date' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'From' }, { label: 'To' }],
        list.map((t) => `<tr><td>${esc(t.mtn_no)}</td><td>${esc(t.txn_date)}</td><td>${esc(t.description || '')}</td><td class="num">${num(t.qty)}</td><td>${esc(t.from_location || t.from_asset_code || '')}</td><td>${esc(t.to_location || t.to_asset_code || '')}</td></tr>`), { scroll: true })}`;
    if (qs('#nt')) qs('#nt').onclick = () => simpleCreateModal('New MTN (transfer)', '/stores/mtn', [['Description', 'description'], ['Qty *', 'qty', 'number'], ['From location', 'from_location'], ['To location', 'to_location'], ['To asset (code/text)', 'to_asset'], ['Transferred by', 'transferred_by'], ['Received by', 'received_by'], ['Reason', 'reason']]);
  }
};

async function newMrnModal() {
  modal('New MRN', `
    ${field('Asset (code/text)', 'asset')}
    ${field('Purpose *', 'purpose')}
    ${field('Requested by', 'requested_by')}
    <h3>Lines</h3><div id="lines"></div>
    <button class="sm" id="addline">+ line</button>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create MRN</button></div>`, (body, close) => {
    const lines = qs('#lines', body);
    const addLine = () => { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = field('Description', 'ldesc') + field('Qty', 'lqty', { type: 'number', value: 1 }); lines.appendChild(d); };
    addLine();
    qs('#addline', body).onclick = addLine;
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      const descs = qsa('[name=ldesc]', body).map((e) => e.value);
      const qtys = qsa('[name=lqty]', body).map((e) => e.value);
      const payload = { asset: d.asset, purpose: d.purpose, requested_by: d.requested_by, lines: descs.map((desc, i) => ({ description: desc, qty: qtys[i] })).filter((l) => l.description) };
      try { const r = await api('/stores/mrn', { method: 'POST', body: payload }); close(); toast('MRN ' + r.mrn.mrn_no + ' created'); render(); } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- Oil
routes.oil = async (c) => {
  const tab = (location.hash.split('?')[1] && new URLSearchParams(location.hash.split('?')[1]).get('tab')) || 'products';
  const tabs = ['products', 'ledger', 'forecast', 'counts'];
  c.innerHTML = pageHeader('Oil & Lubricant Stock Book') + `<div class="toolbar">${tabs.map((t) => `<button class="sm ${t === tab ? 'primary' : ''}" onclick="location.hash='#/oil?tab=${t}'">${t.toUpperCase()}</button>`).join('')}<div class="spacer"></div><a class="btn sm" href="/api/oil/export/ledger.xlsx">⬇ Ledger Excel</a></div><div id="oilbody" class="muted">Loading…</div>`;
  const body = qs('#oilbody');
  if (tab === 'products') {
    const list = await api('/oil/products');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="np">+ New Product</button><button class="sm" id="nl">+ Ledger Txn</button></div>' : ''}
      ${tableWrap([{ label: 'Code' }, { label: 'Name' }, { label: 'Unit' }, { label: 'Category' }, { label: 'Balance', num: true }, { label: 'Reorder', num: true }, { label: 'Unit Price', num: true }],
        list.map((p) => `<tr><td>${esc(p.code || '')}</td><td>${esc(p.name)}</td><td>${esc(p.unit)}</td><td>${esc(p.category || '')}</td><td class="num ${p.current_balance <= p.reorder_level ? '' : ''}">${p.current_balance <= p.reorder_level && p.reorder_level > 0 ? `<span class="badge amber">${num(p.current_balance)}</span>` : num(p.current_balance)}</td><td class="num">${num(p.reorder_level)}</td><td class="num">${money(p.unit_price)}</td></tr>`), { scroll: true })}`;
    if (qs('#np')) qs('#np').onclick = () => simpleCreateModal('New Product', '/oil/products', [['Code', 'code'], ['Name *', 'name'], ['Unit (L/kg/nos)', 'unit'], ['Category', 'category'], ['Reorder level', 'reorder_level', 'number'], ['Unit price', 'unit_price', 'number']]);
    if (qs('#nl')) qs('#nl').onclick = () => newLedgerModal(list);
  } else if (tab === 'ledger') {
    const list = await api('/oil/ledger');
    body.innerHTML = tableWrap([{ label: 'Date' }, { label: 'Product' }, { label: 'Kind' }, { label: 'Qty', num: true }, { label: 'Balance', num: true }, { label: 'Unit Price', num: true }, { label: 'Asset' }],
      list.map((l) => `<tr><td>${esc(l.txn_date)}</td><td>${esc(l.product_name)}</td><td><span class="badge ${l.kind === 'issue' ? 'amber' : 'green'}">${esc(l.kind)}</span></td><td class="num">${num(l.qty)}</td><td class="num">${num(l.balance_after)}</td><td class="num">${money(l.unit_price)}</td><td>${esc(l.asset_code || '')}</td></tr>`), { scroll: true });
  } else if (tab === 'forecast') {
    const f = await api('/oil/forecast');
    body.innerHTML = `<p class="muted">Days-of-cover from consumption over the last ${f.window_days} days; low-stock threshold ${f.low_stock_days} days.</p>` +
      tableWrap([{ label: 'Product' }, { label: 'Balance', num: true }, { label: 'Daily Use', num: true }, { label: 'Days Cover', num: true }, { label: 'Reorder?' }],
        f.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${num(p.balance)} ${esc(p.unit)}</td><td class="num">${num(p.daily_rate)}</td><td class="num">${p.days_of_cover == null ? '∞' : num(p.days_of_cover)}</td><td>${p.suggested_reorder ? '<span class="badge red">ORDER</span>' : '<span class="badge green">ok</span>'}</td></tr>`), { scroll: true });
  } else if (tab === 'counts') {
    const list = await api('/oil/counts');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="nc">+ New Count</button></div>' : ''}
      ${tableWrap([{ label: 'Period' }, { label: 'Product' }, { label: 'Book', num: true }, { label: 'Counted', num: true }, { label: 'Variance', num: true }],
        list.map((s) => `<tr><td>${esc(s.period)}</td><td>${esc(s.product_name)}</td><td class="num">${num(s.book_qty)}</td><td class="num">${num(s.counted_qty)}</td><td class="num"><span class="badge ${Math.abs(s.variance) > 0.001 ? 'red' : 'green'}">${num(s.variance)}</span></td></tr>`), { scroll: true })}`;
    if (qs('#nc')) qs('#nc').onclick = async () => {
      const products = await api('/oil/products');
      modal('New Stock Count', field('Product', 'product_id', { type: 'select', options: products.map((p) => ({ value: p.id, label: p.name })) }) +
        field('Period (YYYY-MM)', 'period', { value: new Date().toISOString().slice(0, 7) }) + field('Counted Qty', 'counted_qty', { type: 'number' }) +
        field('Post adjustment to ledger', 'post_adjustment', { type: 'checkbox' }) + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>',
        (b, close) => { qs('#s', b).onclick = async () => { try { await api('/oil/counts', { method: 'POST', body: formData(b) }); close(); render(); } catch (e) { toast(e.message, 'err'); } }; });
    };
  }
};

async function newLedgerModal(products) {
  modal('New Oil Ledger Txn', `
    ${field('Product', 'product_id', { type: 'select', options: products.map((p) => ({ value: p.id, label: p.name })) })}
    <div class="row">${field('Kind', 'kind', { type: 'select', options: ['receipt', 'issue', 'opening', 'adjustment'].map((v) => ({ value: v, label: v })) })}${field('Qty', 'qty', { type: 'number' })}</div>
    <div class="row">${field('Asset (code/text)', 'asset')}${field('Unit Price (blank=auto)', 'unit_price', { type: 'number' })}</div>
    ${field('Note', 'note')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Post</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => { try { const r = await api('/oil/ledger', { method: 'POST', body: formData(body) }); close(); if (r.unresolved) toast('Posted — asset queued in Alias Queue', 'err'); else toast('Ledger posted'); render(); } catch (e) { toast(e.message, 'err'); } };
  });
}

// ---- Batteries
routes.batteries = async (c, params) => {
  if (params[0]) return batteryDetail(c, params[0]);
  const list = await api('/batteries');
  const radar = await api('/batteries/warranty-radar');
  c.innerHTML = `${pageHeader('Battery Lifecycle')}
    <div class="toolbar">
      <input id="bwhere" placeholder="Where is serial…?" style="max-width:220px"><button class="sm" id="bwbtn">Find</button>
      <div class="spacer"></div>${can('storekeeper') ? '<button class="primary" id="nb">+ Add Battery</button>' : ''}
    </div>
    ${radar.expiring.length ? `<div class="card section"><h3>Warranty expiring ≤60 days</h3>${radar.expiring.map((b) => `<div class="cost-line"><a href="#/batteries/${b.id}">${esc(b.serial_no)}</a><span class="badge amber">${esc(b.warranty_date)} · ${esc(b.current_asset_code || 'store')}</span></div>`).join('')}</div>` : ''}
    ${tableWrap([{ label: 'Serial' }, { label: 'Brand' }, { label: 'Ah', num: true }, { label: 'State' }, { label: 'Current Asset' }, { label: 'Warranty' }],
      list.map((b) => `<tr><td><a href="#/batteries/${b.id}">${esc(b.serial_no)}</a></td><td>${esc(b.brand || '')}</td><td class="num">${b.capacity_ah || ''}</td><td><span class="badge ${b.state === 'installed' ? 'green' : b.state === 'decommissioned' ? 'red' : ''}">${esc(b.state)}</span></td><td>${esc(b.current_asset_code || '—')}</td><td>${esc(b.warranty_date || '')}</td></tr>`), { scroll: true })}`;
  qs('#bwbtn').onclick = async () => { const s = qs('#bwhere').value.trim(); if (!s) return; try { const r = await api('/batteries/whereis/' + encodeURIComponent(s)); toast(s + ' → ' + (r.current_asset ? r.current_asset.code : 'in store') + ' (' + r.battery.state + ')'); } catch { toast('Serial not found', 'err'); } };
  if (qs('#nb')) qs('#nb').onclick = () => simpleCreateModal('Add Battery', '/batteries', [['Serial No *', 'serial_no'], ['Brand', 'brand'], ['Capacity Ah', 'capacity_ah', 'number'], ['Condition (new/old)', 'condition'], ['Purchase date', 'purchase_date', 'date'], ['Warranty date', 'warranty_date', 'date'], ['Install on asset (code/text)', 'current_asset']]);
};

async function batteryDetail(c, id) {
  const b = await api('/batteries/' + id);
  c.innerHTML = `${pageHeader(b.battery.serial_no, '<a href="#/batteries">← Batteries</a>')}
    <div class="toolbar"><span class="badge ${b.battery.state === 'installed' ? 'green' : ''}">${esc(b.battery.state)}</span>
      <span class="muted">${esc(b.battery.brand || '')} · ${b.battery.capacity_ah || '?'}Ah · ${esc(b.battery.current_asset_code || 'in store')}</span>
      <div class="spacer"></div>${can('storekeeper') ? '<button class="sm" id="ev">+ Event</button>' : ''}</div>
    <div class="card"><h3>Event History</h3>
      ${tableWrap([{ label: 'Date' }, { label: 'Event' }, { label: 'From' }, { label: 'To' }, { label: 'Reason' }, { label: 'MTN' }],
        b.events.map((e) => `<tr><td>${esc(e.event_date)}</td><td><span class="badge">${esc(e.event_type)}</span></td><td>${esc(e.from_asset_code || '')}</td><td>${esc(e.to_asset_code || '')}</td><td>${esc(e.reason || '')}</td><td>${esc(e.mtn_ref || '')}</td></tr>`))}</div>`;
  if (qs('#ev')) qs('#ev').onclick = () => modal('Battery Event', `
    ${field('Event', 'event_type', { type: 'select', options: ['install', 'transfer', 'return', 'warranty', 'decommission'].map((v) => ({ value: v, label: v })) })}
    ${field('To asset (code/text)', 'to_asset')}${field('Reason', 'reason')}${field('MTN ref', 'mtn_ref')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Record</button></div>`,
    (body, close) => { qs('#s', body).onclick = async () => { try { await api(`/batteries/${id}/event`, { method: 'POST', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } }; });
}

// ---- Projects
routes.projects = async (c, params) => {
  if (params[0]) {
    const p = await api('/projects/' + params[0]);
    c.innerHTML = `${pageHeader(p.project.name, '<a href="#/projects">← Projects</a>')}
      <div class="grid section">
        <div class="card"><h3>Cost Roll-up</h3>
          ${['labour', 'material', 'oil', 'general', 'external'].map((k) => `<div class="cost-line"><span>${k}</span><span>${money(p.cost[k])}</span></div>`).join('')}
          <div class="cost-line total"><span>Total</span><span>${money(p.cost.total)}</span></div>
          <a class="btn sm" style="margin-top:10px" href="/api/projects/${params[0]}/cost?format=xlsx">⬇ Monthly Excel</a></div>
        <div class="card"><h3>Assets (${p.assets.length})</h3>${p.assets.map((a) => `<div class="cost-line"><a href="#/assets/${a.id}">${esc(a.code)}</a><span class="muted">${esc(a.type || '')}</span></div>`).join('') || '<span class="muted">none</span>'}</div>
      </div>`;
    return;
  }
  const list = await api('/projects');
  c.innerHTML = `${pageHeader('Projects')}${can('manager') ? '<div class="toolbar"><button class="primary" id="npr">+ New Project</button></div>' : ''}
    ${tableWrap([{ label: 'Code' }, { label: 'Name' }, { label: 'Location' }, { label: 'Assets', num: true }, { label: 'This-Month Cost', num: true }],
      list.map((p) => `<tr><td>${esc(p.code || '')}</td><td><a href="#/projects/${p.id}">${esc(p.name)}</a></td><td>${esc(p.location || '')}</td><td class="num">${p.asset_count}</td><td class="num">${money(p.month_cost)}</td></tr>`), { scroll: true })}`;
  if (qs('#npr')) qs('#npr').onclick = () => simpleCreateModal('New Project', '/projects', [['Code', 'code'], ['Name *', 'name'], ['Location', 'location']]);
};

// ---- Alias queue (assets + mechanics)
routes.aliases = async (c) => {
  const [pending, all, assets, mPending, mechs] = await Promise.all([
    api('/aliases?resolved=0'), api('/aliases?resolved=1&limit=100'), api('/assets?limit=1000'),
    api('/mechanics/aliases?resolved=0'), api('/mechanics'),
  ]);
  const aopts = assets.map((a) => `<option value="${a.id}">${esc(a.code)} — ${esc(a.brand || '')} ${esc(a.type || '')}</option>`).join('');
  const mopts = mechs.map((m) => `<option value="${m.id}">${esc(m.name)}${m.rate ? ' (Rs ' + m.rate + '/h)' : ''}</option>`).join('');
  c.innerHTML = `${pageHeader('Resolver Queues', 'The learning glue: unrecognised vehicle & mechanic text is queued here, never lost.')}
    <div class="card section"><h3>Vehicles — pending link (${pending.length})</h3>
      ${pending.length ? tableWrap([{ label: 'Raw Text' }, { label: 'Hits', num: true }, { label: 'Source' }, { label: 'Link to Asset' }],
        pending.map((a) => `<tr><td>${esc(a.raw_text)}</td><td class="num">${a.hit_count}</td><td>${esc(a.source || '')}</td>
          <td>${can('storekeeper') ? `<select data-alias="${a.id}" style="width:auto;display:inline-block"><option value="">— pick —</option>${aopts}</select> <button class="sm" data-link="${a.id}">Link</button>` : '<span class="muted">read-only</span>'}</td></tr>`)) : '<span class="muted">Queue empty — every name resolves.</span>'}</div>
    <div class="card section"><h3>Mechanic names — pending link (${mPending.length})</h3>
      ${mPending.length ? tableWrap([{ label: 'Raw Text' }, { label: 'Hits', num: true }, { label: 'Source' }, { label: 'Link to Mechanic' }],
        mPending.map((a) => `<tr><td>${esc(a.raw_text)}</td><td class="num">${a.hit_count}</td><td>${esc(a.source || '')}</td>
          <td>${can('storekeeper', 'manager') ? `<select data-malias="${a.id}" style="width:auto;display:inline-block"><option value="">— pick —</option>${mopts}</select> <button class="sm" data-mlink="${a.id}">Link</button>` : '<span class="muted">read-only</span>'}</td></tr>`)) : '<span class="muted">Queue empty — every mechanic name resolves.</span>'}</div>
    <div class="grid">
      <div class="card"><h3>Resolved vehicle aliases</h3>
        ${tableWrap([{ label: 'Raw Text' }, { label: 'Asset' }, { label: 'Hits', num: true }], all.map((a) => `<tr><td>${esc(a.raw_text)}</td><td>${esc(a.asset_code || '')}</td><td class="num">${a.hit_count}</td></tr>`), { scroll: true })}</div>
      <div class="card"><h3>Mechanics &amp; rates</h3>
        ${tableWrap([{ label: 'Mechanic' }, { label: 'Rate/h', num: true }], mechs.map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${m.rate == null ? '<span class="badge amber">no rate</span>' : money(m.rate)}</td></tr>`), { scroll: true })}</div>
    </div>`;
  qsa('[data-link]').forEach((b) => b.onclick = async () => {
    const sel = qs(`[data-alias="${b.dataset.link}"]`);
    if (!sel.value) return toast('Pick an asset', 'err');
    try { await api(`/aliases/${b.dataset.link}/link`, { method: 'POST', body: { asset_id: sel.value } }); toast('Linked'); render(); } catch (e) { toast(e.message, 'err'); }
  });
  qsa('[data-mlink]').forEach((b) => b.onclick = async () => {
    const sel = qs(`[data-malias="${b.dataset.mlink}"]`);
    if (!sel.value) return toast('Pick a mechanic', 'err');
    try { await api(`/mechanics/aliases/${b.dataset.mlink}/link`, { method: 'POST', body: { mechanic_id: sel.value } }); toast('Linked'); render(); } catch (e) { toast(e.message, 'err'); }
  });
};

// ---- Reports
routes.reports = async (c) => {
  const [byAsset, byProject, bySource, variance] = await Promise.all([
    api('/reports/cost/by-asset'), api('/reports/cost/by-project'), api('/reports/cost/by-source'), api('/reports/variance'),
  ]);
  c.innerHTML = `${pageHeader('Cost Reports & Analytics')}
    <div class="card section"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Cost by Project</h3><div class="spacer"></div><a class="btn sm" href="/api/reports/cost/by-project?format=xlsx">⬇ Excel</a></div>
      ${tableWrap([{ label: 'Project' }, { label: 'Labour', num: true }, { label: 'Material', num: true }, { label: 'Oil', num: true }, { label: 'External', num: true }, { label: 'Total', num: true }],
        byProject.map((p) => `<tr><td>${esc(p.project)}</td><td class="num">${money(p.labour)}</td><td class="num">${money(p.material)}</td><td class="num">${money(p.oil)}</td><td class="num">${money(p.external)}</td><td class="num"><b>${money(p.total)}</b></td></tr>`))}</div>
    <div class="card section"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Cost by Asset</h3><div class="spacer"></div><a class="btn sm" href="/api/reports/cost/by-asset?format=xlsx">⬇ Excel</a></div>
      ${tableWrap([{ label: 'Asset' }, { label: 'Jobs', num: true }, { label: 'Labour', num: true }, { label: 'Material', num: true }, { label: 'Oil', num: true }, { label: 'Total', num: true }],
        byAsset.map((p) => `<tr><td>${esc(p.asset_code || '—')}</td><td class="num">${p.job_count}</td><td class="num">${money(p.labour)}</td><td class="num">${money(p.material)}</td><td class="num">${money(p.oil)}</td><td class="num"><b>${money(p.total)}</b></td></tr>`), { scroll: true })}</div>
    <div class="grid">
      <div class="card"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Material by Purchase Source</h3><div class="spacer"></div><a class="btn sm" href="/api/reports/cost/by-source?format=xlsx">⬇</a></div>
        ${bySource.map((s) => `<div class="cost-line"><span>${esc(s.purchase_source)}</span><span>${money(s.total)}</span></div>`).join('') || '<span class="muted">none</span>'}</div>
      <div class="card"><h3>Stock Variance Flags</h3>
        ${variance.length ? variance.map((v) => `<div class="cost-line"><span>${esc(v.product)} · ${esc(v.period)}</span><span class="badge red">${num(v.variance)}</span></div>`).join('') : '<span class="muted">No variances</span>'}</div>
    </div>`;
};

// ---- Users (admin)
routes.users = async (c) => {
  if (!can('admin')) { c.innerHTML = '<div class="card err">Admin only.</div>'; return; }
  const [users, roles] = await Promise.all([api('/users'), api('/users/roles')]);
  c.innerHTML = `${pageHeader('Users & Roles')}<div class="toolbar"><button class="primary" id="nu">+ New User</button></div>
    ${tableWrap([{ label: 'Username' }, { label: 'Name' }, { label: 'Roles' }, { label: 'Active' }, { label: '' }],
      users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.full_name || '')}</td><td>${u.roles.map((r) => `<span class="badge">${esc(r)}</span>`).join(' ')}</td><td>${u.active ? '✓' : '✕'}</td><td><button class="sm" data-roles="${u.id}">Roles</button></td></tr>`))}`;
  const roleNames = roles.map((r) => r.name);
  if (qs('#nu')) qs('#nu').onclick = () => modal('New User', `${field('Username *', 'username')}${field('Password *', 'password', { type: 'password' })}${field('Full name', 'full_name')}<label>Roles</label>${roleNames.map((r) => `<label style="flex-direction:row;display:flex;gap:6px;align-items:center"><input type="checkbox" style="width:auto" data-role="${r}"> ${r}</label>`).join('')}<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create</button></div>`,
    (body, close) => { qs('#s', body).onclick = async () => { const d = formData(body); d.roles = qsa('[data-role]', body).filter((x) => x.checked).map((x) => x.dataset.role); try { await api('/users', { method: 'POST', body: d }); close(); render(); } catch (e) { toast(e.message, 'err'); } }; });
  qsa('[data-roles]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.roles);
    modal('Roles for ' + u.username, roleNames.map((r) => `<label style="flex-direction:row;display:flex;gap:6px;align-items:center"><input type="checkbox" style="width:auto" data-role="${r}" ${u.roles.includes(r) ? 'checked' : ''}> ${r}</label>`).join('') + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>',
      (body, close) => { qs('#s', body).onclick = async () => { const rs = qsa('[data-role]', body).filter((x) => x.checked).map((x) => x.dataset.role); try { await api(`/users/${u.id}/roles`, { method: 'POST', body: { roles: rs } }); close(); render(); } catch (e) { toast(e.message, 'err'); } }; });
  });
};

// generic create modal for simple flat forms
function simpleCreateModal(title, path, fields) {
  const body = fields.map((f) => field(f[0], f[1], { type: f[2] || 'text' })).join('');
  modal(title, body + '<div style="margin-top:14px;text-align:right"><button class="primary" id="s">Create</button></div>', (root, close) => {
    qs('#s', root).onclick = async () => {
      try { await api(path, { method: 'POST', body: formData(root) }); toast('Created'); close(); render(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---------------------------------------------------------------- login + boot
function renderLogin(err) {
  qs('#app').innerHTML = `<div class="login-wrap"><div class="card login-card">
    <div class="brand">Workshop<span style="color:var(--primary)">One</span></div>
    <div class="sub">Central Workshop Master System<br>Edward &amp; Christie · Badalgama</div>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <label>Username</label><input id="u" autofocus>
    <label>Password</label><input id="p" type="password">
    <button class="primary" id="login" style="width:100%;margin-top:14px">Sign In</button>
    <p class="muted" style="text-align:center;margin-top:14px;font-size:12px">Demo: admin/admin · store/store · mech/mech · transport/transport · ops/ops</p>
  </div></div>`;
  const go = async () => {
    try { ME = await api('/auth/login', { method: 'POST', body: { username: qs('#u').value, password: qs('#p').value } }); location.hash = '#/dashboard'; render(); }
    catch (e) { renderLogin(e.message); }
  };
  qs('#login').onclick = go;
  qs('#p').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function boot() {
  try { ME = await api('/auth/me'); if (!location.hash) location.hash = '#/dashboard'; render(); }
  catch { renderLogin(); }
}
boot();
