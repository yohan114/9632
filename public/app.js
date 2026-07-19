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

// Two consolidated sources; legacy values fold in (direct→Head Office, local store→Local Purchase).
const SOURCE_LABEL = { head_office: 'Head Office', local_purchase: 'Local Purchase', direct_purchase: 'Head Office', local_store: 'Local Purchase', mixed: 'Head Office', 'Head Office': 'Head Office', 'Local Purchase': 'Local Purchase', 'Local Store': 'Local Purchase', 'Direct Purchase': 'Head Office' };
const sourceLabel = (s) => (s ? (SOURCE_LABEL[s] || s) : '—');
const SOURCE_OPTS = [{ value: '', label: '—' }, { value: 'head_office', label: 'Head Office' }, { value: 'local_purchase', label: 'Local Purchase' }];
const MRN_STATUS_CLASS = { open: '', partially_received: 'amber', received: 'green', cancelled: 'red' };
const mrnStatusBadge = (s) => `<span class="badge ${MRN_STATUS_CLASS[s] || ''}">${esc(String(s || '').replace(/_/g, ' '))}</span>`;

const STORE_CATEGORIES = ['General Items', 'Filters', 'Electrical', 'Bearings & Seals', 'Hydraulics', 'Battery', 'Oil & Lubricants', 'Belts', 'Tyre', 'Consumables'];

// Searchable vehicle/asset picker: type to search, click to select. Emits two form
// fields — `asset_id` (selected id) and `asset` (typed text, resolved server-side if
// no id was picked). Call wireAssetPicker(modalBody) after inserting the HTML.
function assetPickerHtml(label) {
  return `<label>${esc(label)}</label>
    <div class="apick" style="position:relative">
      <input type="text" name="asset" class="apick-input" autocomplete="off" placeholder="Type a vehicle code…">
      <input type="hidden" name="asset_id">
      <div class="apick-menu" style="position:absolute;z-index:60;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);max-height:220px;overflow:auto;display:none"></div>
    </div>`;
}
function wireAssetPicker(root) {
  qsa('.apick', root).forEach((pick) => {
    const input = qs('.apick-input', pick), hidden = qs('input[type=hidden]', pick), menu = qs('.apick-menu', pick);
    let deb;
    const close = () => { menu.style.display = 'none'; };
    const search = async () => {
      hidden.value = ''; // typing invalidates any prior selection until re-picked
      let rows = [];
      try { rows = await api('/assets/search?q=' + encodeURIComponent(input.value.trim()) + '&limit=25'); } catch (e) { return; }
      if (!rows.length) { menu.innerHTML = '<div class="muted" style="padding:8px 10px">No match — will be queued for linking</div>'; menu.style.display = 'block'; return; }
      menu.innerHTML = rows.map((r) => `<div class="apick-item" data-id="${r.id}" data-code="${esc(r.code)}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)">${esc(r.code)}${r.registration ? ` <span class="muted">· ${esc(r.registration)}</span>` : ''}</div>`).join('');
      menu.style.display = 'block';
      qsa('.apick-item', menu).forEach((it) => {
        it.onmousedown = (e) => { e.preventDefault(); input.value = it.dataset.code; hidden.value = it.dataset.id; close(); };
      });
    };
    input.oninput = () => { clearTimeout(deb); deb = setTimeout(search, 200); };
    input.onfocus = search;
    input.onblur = () => setTimeout(close, 150);
  });
}

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99;padding:10px 18px;border-radius:8px;box-shadow:var(--shadow);font-weight:600;color:#fff;background:${kind === 'err' ? 'var(--red)' : 'var(--green)'}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function modal(title, bodyHtml, onMount, opts = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2>${esc(title)}</h2><div class="mbody">${bodyHtml}</div></div>`;
  if (!opts.persistent) bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  if (onMount) onMount(qs('.mbody', bg), () => bg.remove());
  return bg;
}

function forceChangePassword() {
  modal('Set a new password', `
    <p class="muted">Your account requires a new password before you can continue.</p>
    ${field('New password', 'new_password', { type: 'password' })}
    ${field('Confirm password', 'confirm', { type: 'password' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Set password</button></div>`,
    (body, close) => {
      qs('#s', body).onclick = async () => {
        const d = formData(body);
        if (!d.new_password || d.new_password.length < 6) return toast('At least 6 characters', 'err');
        if (d.new_password !== d.confirm) return toast('Passwords do not match', 'err');
        try {
          await api('/auth/change-password', { method: 'POST', body: { new_password: d.new_password } });
          if (ME) ME.mustChangePassword = false;
          toast('Password updated'); close(); render();
        } catch (e) { toast(e.message, 'err'); }
      };
    }, { persistent: true });
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
  ['dailywork', '📅', 'Daily Work'],
  ['labour', '💵', 'Labour Rates'],
  ['stores', '📦', 'Stores'],
  ['oil', '🛢️', 'Oil & Lube'],
  ['batteries', '🔋', 'Batteries'],
  ['projects', '🏗️', 'Projects'],
  ['aliases', '🔗', 'Alias Queue'],
  ['attention', '⚠️', 'Needs Attention'],
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
      <button class="sm" id="chpw">Password</button>
      <button class="sm" id="logout">Logout</button>
    </div>
    <div class="layout">
      <nav class="nav" id="nav">${nav}</nav>
      <main class="content" id="content"><div class="muted">Loading…</div></main>
    </div>`;
  qs('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); ME = null; location.hash = ''; boot(); };
  qs('#chpw').onclick = () => modal('Change password', `
    ${field('Current password', 'current_password', { type: 'password' })}
    ${field('New password', 'new_password', { type: 'password' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Update</button></div>`,
    (body, close) => { qs('#s', body).onclick = async () => { try { await api('/auth/change-password', { method: 'POST', body: formData(body) }); toast('Password updated'); close(); } catch (e) { toast(e.message, 'err'); } }; });
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
  const na = d.needs_attention || {};
  const naTotal = Object.values(na).reduce((a, b) => a + (b || 0), 0);
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
    <a href="#/attention" style="text-decoration:none"><div class="card section" style="border-left:4px solid ${naTotal ? 'var(--amber)' : 'var(--green)'}">
      <div class="toolbar" style="margin:0"><h3 style="margin:0">⚠ Needs Attention</h3><div class="spacer"></div><span class="badge ${naTotal ? 'amber' : 'green'}">${naTotal} flag${naTotal === 1 ? '' : 's'}</span></div>
      <div class="pill-row" style="margin-top:8px">
        <span class="badge ${na.service_due ? 'amber' : ''}">Service due: ${na.service_due || 0}</span>
        <span class="badge ${na.unusual_consumption ? 'red' : ''}">Unusual consumption: ${na.unusual_consumption || 0}</span>
        <span class="badge ${na.duplicate_mrn ? 'red' : ''}">Duplicate MRN: ${na.duplicate_mrn || 0}</span>
        <span class="badge ${na.grn_price_spikes ? 'red' : ''}">GRN price spikes: ${na.grn_price_spikes || 0}</span>
        <span class="badge ${na.integrity_issues ? 'red' : ''}">Integrity issues: ${na.integrity_issues || 0}</span>
      </div>
    </div></a>
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
  c.innerHTML = `${pageHeader('Fleet & Asset Registry')}
    <div class="toolbar">
      <input id="asearch" type="search" placeholder="Search vehicle no / E&C / brand / type…" style="max-width:280px">
      <label style="display:flex;gap:6px;align-items:center;flex-direction:row;width:auto"><input type="checkbox" id="aregonly" checked style="width:auto"> Registered fleet only</label>
      <div class="spacer"></div>
      <span class="muted" id="acount"></span>
      <a class="btn sm" href="/api/assets/export.xlsx">⬇ Excel</a>
      ${can('storekeeper') ? '<button class="primary" id="newasset">+ New Asset</button>' : ''}
    </div>
    <div id="atable"><div class="muted">Loading…</div></div>`;
  const load = async () => {
    const regOnly = qs('#aregonly').checked;
    const list = await api('/assets?limit=1500' + (regOnly ? '&in_register=1' : ''));
    const rows = list.map((a) => `<tr data-id="${a.id}" style="cursor:pointer">
      <td><a href="#/assets/${a.id}">${esc(a.registration || a.code)}</a></td>
      <td>${esc(a.ec_code || '—')}</td>
      <td><span class="badge">${esc(a.asset_class)}</span></td>
      <td>${esc([a.brand, a.type].filter(Boolean).join(' ') || '')}</td>
      <td>${esc(a.current_project || '—')}</td>
      <td><span class="badge ${a.status === 'active' ? 'green' : a.status === 'under_repair' ? 'amber' : ''}">${esc(a.status)}</span></td>
      <td class="num">${a.open_jobs}</td>
      <td class="num">${money(a.lifetime_cost)}</td></tr>`);
    qs('#acount').textContent = `${list.length}${list.length === 1500 ? '+' : ''} asset${list.length === 1 ? '' : 's'}`;
    qs('#atable').innerHTML = tableWrap(
      [{ label: 'Code' }, { label: 'E&C No' }, { label: 'Class' }, { label: 'Type' }, { label: 'Project' }, { label: 'Status' }, { label: 'Open Jobs', num: true }, { label: 'Lifetime Cost', num: true }],
      rows, { scroll: true });
    const term = qs('#asearch').value.toLowerCase();
    if (term) qsa('#atable tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(term) ? '' : 'none'; });
  };
  qs('#asearch').oninput = (e) => {
    const v = e.target.value.toLowerCase();
    qsa('#atable tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(v) ? '' : 'none'; });
  };
  qs('#aregonly').onchange = load;
  if (qs('#newasset')) qs('#newasset').onclick = newAssetModal;
  await load();
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
const JOB_STATUSES = ['REQUESTED', 'APPROVED_TRANSPORT', 'APPROVED_OPERATIONS', 'IN_WORKSHOP', 'IN_PROGRESS', 'WORK_COMPLETE', 'CLOSED', 'REJECTED'];
const MONTHS = [['01', 'Jan'], ['02', 'Feb'], ['03', 'Mar'], ['04', 'Apr'], ['05', 'May'], ['06', 'Jun'], ['07', 'Jul'], ['08', 'Aug'], ['09', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec']];

routes.jobs = async (c, params) => {
  if (params[0]) return jobDetail(c, params[0]);
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const cur = { q: sp.get('q') || '', year: sp.get('year') || '', month: sp.get('month') || '', status: sp.get('status') || '' };

  const nowY = new Date().getFullYear();
  const years = [];
  for (let y = nowY + 1; y >= 2020; y--) years.push(y);

  c.innerHTML = `${pageHeader('Job Cards')}
    <div class="toolbar">
      <input id="jq" type="search" placeholder="Search job no or vehicle…" value="${esc(cur.q)}" style="max-width:240px">
      <select id="jyear" style="max-width:120px"><option value="">All years</option>${years.map((y) => `<option ${String(y) === cur.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <select id="jmonth" style="max-width:140px"><option value="">All months</option>${MONTHS.map(([v, l]) => `<option value="${v}" ${v === cur.month ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="jstatus" style="max-width:200px"><option value="">All statuses</option>${JOB_STATUSES.map((s) => `<option ${s === cur.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button class="sm" id="jclear">Clear</button>
      <span class="muted" id="jcount"></span>
      <div class="spacer"></div>
      ${can('transport_manager', 'workshop') ? '<button class="primary" id="newjob">+ New Job Card</button>' : ''}
    </div>
    <div id="jtable"><div class="muted">Loading…</div></div>`;

  const buildParams = () => {
    const p = new URLSearchParams();
    const q = qs('#jq').value.trim();
    if (q) p.set('q', q);
    if (qs('#jyear').value) p.set('year', qs('#jyear').value);
    if (qs('#jmonth').value) p.set('month', qs('#jmonth').value);
    if (qs('#jstatus').value) p.set('status', qs('#jstatus').value);
    return p;
  };

  const load = async () => {
    const p = buildParams();
    const query = p.toString();
    // Keep the URL shareable/bookmarkable without triggering a full re-render.
    history.replaceState(null, '', '#/jobs' + (query ? '?' + query : ''));
    const list = await api('/jobs' + (query ? '?' + query : ''));
    const rows = list.map((j) => `<tr>
      <td><a href="#/jobs/${j.id}">${esc(j.job_no)}</a></td>
      <td>${esc(j.asset_code || '—')}</td>
      <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(j.description || '')}">${esc(j.description || '')}</td>
      <td><span class="badge ${j.type === 'service' ? 'blue' : ''}">${esc(j.type)}</span></td>
      <td>${statusBadge(j.status)}</td>
      <td>${esc(j.project_name || '')}</td>
      <td class="num">${j.labour_cost ? money(j.labour_cost) : '—'}</td>
      <td class="num">${j.material_cost ? money(j.material_cost) : '—'}</td>
      <td class="num">${money(j.total_cost)}</td>
      <td class="muted">${esc((j.requested_at || '').slice(0, 10))}</td></tr>`);
    const labTotal = list.reduce((s, j) => s + (Number(j.labour_cost) || 0), 0);
    const matTotal = list.reduce((s, j) => s + (Number(j.material_cost) || 0), 0);
    qs('#jcount').textContent = list.length ? `${list.length}${list.length === 500 ? '+' : ''} job${list.length === 1 ? '' : 's'}${labTotal ? ' · labour ' + money(labTotal) : ''}${matTotal ? ' · material ' + money(matTotal) : ''}` : '';
    qs('#jtable').innerHTML = list.length
      ? tableWrap([{ label: 'Job No' }, { label: 'Asset' }, { label: 'Description' }, { label: 'Type' }, { label: 'Status' }, { label: 'Project' }, { label: 'Labour', num: true }, { label: 'Material', num: true }, { label: 'Total', num: true }, { label: 'Requested' }], rows, { scroll: true })
      : '<div class="card"><p class="muted">No job cards match your search.</p></div>';
  };

  let deb;
  qs('#jq').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#jq').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(deb); load(); } };
  qs('#jyear').onchange = load;
  qs('#jmonth').onchange = load;
  qs('#jstatus').onchange = load;
  qs('#jclear').onclick = () => { qs('#jq').value = ''; qs('#jyear').value = ''; qs('#jmonth').value = ''; qs('#jstatus').value = ''; load(); };
  if (qs('#newjob')) qs('#newjob').onclick = newJobModal;
  await load();
};

// ---- Daily Work (day-by-day review of job_daily_work)
routes.dailywork = async (c) => {
  const days = await api('/daily-work/days'); // [{date, entries, jobs, hours}] newest first
  if (!days.length) {
    c.innerHTML = `${pageHeader('Daily Work')}<div class="card"><p class="muted">No daily work has been logged yet.</p></div>`;
    return;
  }
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  let date = sp.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = days[0].date; // default = most recent day with work

  c.innerHTML = `${pageHeader('Daily Work')}
    <div class="toolbar">
      <button class="sm" id="dprev">← Older</button>
      <input id="ddate" type="date" value="${esc(date)}" style="max-width:170px">
      <button class="sm" id="dnext">Newer →</button>
      <select id="ddays" style="max-width:260px">${days.map((d) => `<option value="${d.date}" ${d.date === date ? 'selected' : ''}>${d.date} · ${d.entries} entr${d.entries === 1 ? 'y' : 'ies'} · ${d.hours || 0}h</option>`).join('')}</select>
      <input id="dq" type="search" placeholder="Filter vehicle / mechanic…" style="max-width:220px">
      <div class="spacer"></div>
      <span class="muted" id="dsum"></span>
    </div>
    <div id="dtable"><div class="muted">Loading…</div></div>`;

  const dayList = days.map((d) => d.date);
  const go = (dt) => {
    history.replaceState(null, '', '#/dailywork?date=' + dt);
    qs('#ddate').value = dt;
    if (dayList.includes(dt)) qs('#ddays').value = dt;
    load(dt);
  };
  const canEdit = can('workshop', 'manager');
  const load = async (dt) => {
    const q = qs('#dq').value.trim();
    const data = await api('/daily-work?date=' + encodeURIComponent(dt) + (q ? '&q=' + encodeURIComponent(q) : ''));
    const rows = data.entries.map((e) => {
      const hoursCell = e.is_external
        ? '<span class="badge">external</span>'
        : (canEdit
          ? `<input type="number" step="0.5" min="0" value="${Number(e.hours) || 0}" data-hours="${e.id}" style="width:66px;text-align:right">`
          : (Number(e.hours) || 0));
      const costCell = e.is_external
        ? money(e.external_value)
        : money(e.labour_cost) + (e.unrated && e.unrated.length ? ` <span class="badge amber" title="No rate for: ${esc(e.unrated.join(', '))}">no rate</span>` : '');
      return `<tr>
      <td>${esc(e.asset_code || '—')}</td>
      <td><a href="#/jobs/${e.job_id}">${esc(e.job_no)}</a></td>
      <td>${esc(e.mechanic || '—')}</td>
      <td>${esc(e.description || '')}</td>
      <td class="num">${hoursCell}</td>
      <td class="num">${costCell}</td></tr>`;
    });
    qs('#dsum').textContent = `${data.count} entr${data.count === 1 ? 'y' : 'ies'} · ${data.total_hours || 0} hrs · ${money(data.total_labour || 0)} labour`;
    qs('#dtable').innerHTML = data.entries.length
      ? tableWrap([{ label: 'Vehicle' }, { label: 'Job No' }, { label: 'Mechanic' }, { label: 'Description' }, { label: 'Hours', num: true }, { label: 'Labour (Rs)', num: true }], rows, { scroll: true })
      : '<div class="card"><p class="muted">No daily work logged on this day.</p></div>';
    if (canEdit) qsa('[data-hours]').forEach((inp) => {
      inp.onchange = async () => {
        try { await api('/daily-work/' + inp.dataset.hours, { method: 'PATCH', body: { hours: inp.value } }); toast('Hours updated'); load(qs('#ddate').value); }
        catch (err) { toast(err.message, 'err'); }
      };
    });
  };

  qs('#ddate').onchange = (e) => go(e.target.value);
  qs('#ddays').onchange = (e) => go(e.target.value);
  // days are sorted newest→oldest; "Older" = closest date before the current one.
  qs('#dprev').onclick = () => { const older = dayList.filter((x) => x < qs('#ddate').value); if (older.length) go(older[0]); };
  qs('#dnext').onclick = () => { const newer = dayList.filter((x) => x > qs('#ddate').value); if (newer.length) go(newer[newer.length - 1]); };
  let deb; qs('#dq').oninput = () => { clearTimeout(deb); deb = setTimeout(() => load(qs('#ddate').value), 250); };
  await load(date);
};

// ---- Labour Rates (hourly rates + unassigned labour used in daily work)
routes.labour = async (c) => {
  const [mechs, unassigned] = await Promise.all([api('/mechanics'), api('/mechanics/unassigned')]);
  const canEdit = can('admin', 'manager');
  const rateRows = mechs.map((m) => `<tr>
    <td>${esc(m.name)}</td>
    <td class="num">${m.rate != null ? money(m.rate) + '/hr' : '<span class="badge amber">no rate</span>'}</td>
    ${canEdit ? `<td class="num"><button class="sm" data-setrate="${esc(m.name)}" data-rate="${m.rate != null ? m.rate : ''}">Edit</button></td>` : ''}</tr>`);
  const unRows = unassigned.map((u) => `<tr>
    <td>${esc(u.name)}${u.resolved && u.resolvedName && u.resolvedName !== u.name ? ` <span class="muted">(→ ${esc(u.resolvedName)})</span>` : ''}</td>
    <td class="num">${u.entries}</td>
    ${canEdit ? `<td class="num"><button class="sm primary" data-setrate="${esc(u.resolvedName || u.name)}" data-rate="">Set rate</button></td>` : ''}</tr>`);

  c.innerHTML = `${pageHeader('Labour Rates')}
    <div class="toolbar">
      ${canEdit ? '<button class="primary" id="addrate">+ Add / update rate</button>' : ''}
      <div class="spacer"></div>
    </div>
    <div class="card">
      <h3>Hourly rates <span class="muted">(${mechs.length})</span></h3>
      ${tableWrap([{ label: 'Labour' }, { label: 'Rate', num: true }].concat(canEdit ? [{ label: '', num: true }] : []), rateRows, { scroll: true })}
    </div>
    <div class="card">
      <h3>Unassigned labour <span class="muted">— appear in daily work, no rate (${unassigned.length})</span></h3>
      ${unassigned.length
        ? tableWrap([{ label: 'Labour name' }, { label: 'Daily-work entries', num: true }].concat(canEdit ? [{ label: '', num: true }] : []), unRows, { scroll: true })
        : '<p class="muted">Every labour name in the daily-work log has a rate. 🎉</p>'}
    </div>`;

  const setRate = (name, rate) => modal('Set hourly rate', `
    ${field('Labour name', 'mechanic', { value: name })}
    ${field('Hourly rate (Rs)', 'rate', { type: 'number', value: rate })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save rate</button></div>`,
    (body, close) => {
      qs('#s', body).onclick = async () => {
        const d = formData(body);
        if (!d.mechanic || !d.rate) return toast('Name and rate are required', 'err');
        try { await api('/mechanics/rates', { method: 'POST', body: { mechanic: d.mechanic, rate: d.rate } }); toast('Rate saved'); close(); render(); }
        catch (e) { toast(e.message, 'err'); }
      };
    });

  if (qs('#addrate')) qs('#addrate').onclick = () => setRate('', '');
  qsa('[data-setrate]').forEach((b) => b.onclick = () => setRate(b.dataset.setrate, b.dataset.rate));
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
        ${j.cost.other_cost ? `<div class="cost-line"><span>Other / Recorded</span><span>${money(j.cost.other_cost)}</span></div>` : ''}
        <div class="cost-line total"><span>Total</span><span>${money(j.cost.total_cost)}</span></div>
      </div>
      <div class="card"><h3>Approvals</h3>
        ${j.approvals.length ? j.approvals.map((a) => `<div class="cost-line"><span>${esc(a.role.replace(/_/g, ' '))}</span><span class="badge ${a.decision === 'approved' ? 'green' : 'red'}">${esc(a.decision)}</span></div>${a.reason ? `<div class="muted" style="font-size:12px">${esc(a.reason)}</div>` : ''}`).join('') : '<span class="muted">No approvals yet</span>'}
      </div>
    </div>
    <div class="card section"><div class="toolbar" style="margin:0 0 10px"><h3 style="margin:0">Daily Work</h3><div class="spacer"></div>${can('workshop') ? '<button class="sm" id="adddaily">+ Add</button>' : ''}</div>
      ${(() => {
        // Each mechanic in a crew is shown on its own line: rate × hours = amount.
        const rateOf = {};
        j.labour.forEach((l) => { if (l.mechanic != null) rateOf[l.mechanic] = l.rate; });
        const splitMechs = (raw) => String(raw || '').split(/\s*(?:,|&|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
        const canDel = can('workshop');
        const rows = [];
        let labourTotal = 0;
        for (const w of j.dailyWork) {
          const del = canDel ? `<button class="sm danger" data-del-daily="${w.id}">✕</button>` : '';
          const date = esc((w.work_date || '').slice(0, 10));
          if (w.is_external) { rows.push(`<tr><td>${date}</td><td>(external)</td><td>${esc(w.description || '')}</td><td class="num">—</td><td class="num">—</td><td class="num">${money(w.external_value)}</td><td>${del}</td></tr>`); continue; }
          const names = splitMechs(w.mechanic);
          const hrs = Number(w.hours) || 0;
          if (!names.length) { rows.push(`<tr><td>${date}</td><td>—</td><td>${esc(w.description || '')}</td><td class="num">${num(hrs)}</td><td class="num">—</td><td class="num">${money(0)}</td><td>${del}</td></tr>`); continue; }
          names.forEach((nm, i) => {
            const rate = rateOf[nm];
            const amount = rate != null ? hrs * rate : 0;
            labourTotal += amount;
            rows.push(`<tr>
              <td>${i === 0 ? date : ''}</td>
              <td>${esc(nm)}</td>
              <td>${i === 0 ? esc(w.description || '') : ''}</td>
              <td class="num">${num(hrs)}</td>
              <td class="num">${rate == null ? '<span class="badge amber">no rate</span>' : money(rate)}</td>
              <td class="num">${money(amount)}</td>
              <td>${i === 0 ? del : ''}</td></tr>`);
          });
        }
        if (j.dailyWork.length) rows.push(`<tr><td colspan="5" class="num"><b>Labour total</b></td><td class="num"><b>${money(labourTotal)}</b></td><td></td></tr>`);
        return tableWrap([{ label: 'Date' }, { label: 'Mechanic' }, { label: 'Description' }, { label: 'Hours', num: true }, { label: 'Rate', num: true }, { label: 'Amount', num: true }, { label: '' }], rows);
      })()}
    </div>
    <div class="card section"><div class="toolbar" style="margin:0 0 10px"><h3 style="margin:0">Parts &amp; External</h3><div class="spacer"></div>${can('workshop', 'storekeeper') ? '<button class="sm" id="addpart">+ Add item</button>' : ''}</div>
      ${tableWrap([{ label: 'Source' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Amount', num: true }, { label: '' }],
        j.parts.map((p) => `<tr><td><span class="badge">${esc(p.source_type)}${p.is_external_repair ? ' · ext' : ''}</span></td><td>${esc(p.description || '')}</td>
          <td class="num">${num(p.qty)}</td>
          <td class="num">${p.unit_price == null ? '<span class="badge amber">awaiting</span>' : money(p.unit_price)}</td>
          <td class="num">${p.unit_price == null ? '—' : money(p.qty * p.unit_price)}</td>
          <td>${can('workshop', 'storekeeper') ? `<button class="sm" data-price="${p.id}">Price</button> <button class="sm danger" data-del-part="${p.id}">✕</button>` : ''}</td></tr>`))}
    </div>
    ${j.mrnItems && j.mrnItems.length ? `<div class="card section"><h3>MRN Items <span class="muted">— requested materials (${j.mrnItems.length})</span></h3>
      ${tableWrap([{ label: 'MRN No' }, { label: 'Date' }, { label: 'Item' }, { label: 'Category' }, { label: 'Qty Req', num: true }, { label: 'Qty Recd', num: true }],
        j.mrnItems.map((m) => `<tr>
          <td><a href="#/stores?tab=mrn&id=${m.mrn_id}">${esc(m.mrn_no)}</a></td>
          <td>${esc((m.req_date || '').slice(0, 10))}</td>
          <td>${esc(m.description || '')}</td>
          <td>${esc(m.category || '')}</td>
          <td class="num">${num(m.qty)}</td>
          <td class="num">${num(m.qty_received)}</td></tr>`), { scroll: true })}</div>` : ''}
    ${j.oilIssues.length ? `<div class="card section"><h3>Oil / Lubricant Issued</h3>${tableWrap([{ label: 'Product' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }], j.oilIssues.map((o) => `<tr><td>${esc(o.product_name)}</td><td class="num">${num(Math.abs(o.qty))} ${esc(o.unit)}</td><td class="num">${money(o.unit_price)}</td></tr>`))}</div>` : ''}
    ${j.generalIssues && j.generalIssues.length ? `<div class="card section"><h3>General Items Issued <span class="muted">(${j.generalIssues.length})</span></h3>
      ${tableWrap([{ label: 'Date' }, { label: 'Item' }, { label: 'Qty', num: true }, { label: 'Ref / MR' }],
        j.generalIssues.map((g) => `<tr><td>${esc((g.txn_date || '').slice(0, 10))}</td><td>${esc(g.item_name || '')}</td><td class="num">${num(Math.abs(g.qty))}</td><td>${esc(g.ref || '')}</td></tr>`), { scroll: true })}</div>` : ''}`;

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
    <p class="muted" style="font-size:12px;margin:2px 0 0">Each mechanic is charged the full hours at their own rate (one costed row each). A slash name ("Seethananda/seetha") stays one person.</p>
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
  const tab = (location.hash.split('?')[1] && new URLSearchParams(location.hash.split('?')[1]).get('tab')) || 'categories';
  const tabs = ['categories', 'general', 'items', 'reorder', 'mrn', 'grn', 'issues', 'mtn'];
  const TAB_LABELS = { general: 'GENERAL ITEMS' };
  const tabBar = `<div class="toolbar">${tabs.map((t) => `<button class="sm ${t === tab ? 'primary' : ''}" onclick="location.hash='#/stores?tab=${t}'">${TAB_LABELS[t] || t.toUpperCase()}</button>`).join('')}</div>`;
  c.innerHTML = pageHeader('Stores & Inventory') + tabBar + '<div id="storebody" class="muted">Loading…</div>';
  const body = qs('#storebody');
  if (tab === 'categories') {
    const d = await api('/stores/categories');
    const totLines = d.lines.reduce((s, r) => s + r.lines, 0);
    body.innerHTML = `
      <div class="card"><h3>Requested items by category <span class="muted">— MRN request lines (${num(totLines)})</span></h3>
        ${tableWrap([{ label: 'Category' }, { label: 'Request lines', num: true }, { label: 'Distinct items', num: true }, { label: 'Total qty', num: true }, { label: 'Received qty', num: true }],
          d.lines.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${num(r.lines)}</td><td class="num">${num(r.distinct_items)}</td><td class="num">${num(r.qty)}</td><td class="num">${num(r.received)}</td></tr>`), { scroll: true })}</div>
      <div class="card"><h3>Issued by category</h3>
        ${tableWrap([{ label: 'Category' }, { label: 'Issues', num: true }, { label: 'Qty', num: true }],
          d.issues.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${num(r.issues)}</td><td class="num">${num(r.qty)}</td></tr>`), { scroll: true })}</div>
      <div class="card"><h3>Transfers (MTN) by category</h3>
        ${d.transfers.length ? tableWrap([{ label: 'Category' }, { label: 'Transfers', num: true }, { label: 'Qty', num: true }],
          d.transfers.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${num(r.transfers)}</td><td class="num">${num(r.qty)}</td></tr>`), { scroll: true }) : '<p class="muted">None</p>'}</div>
      <div class="card"><h3>General catalogue by category</h3>
        ${tableWrap([{ label: 'Category' }, { label: 'Items', num: true }],
          d.catalogue.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${num(r.items)}</td></tr>`))}</div>`;
  } else if (tab === 'general') {
    const facets = await api('/stores/catalogue/facets');
    const kindBadge = (k) => { const cls = k === 'consumable' ? 'amber' : (k === 'service' ? '' : 'blue'); return `<span class="badge ${cls}">${esc(k || 'part')}</span>`; };
    body.innerHTML = `
      <div class="toolbar">
        <input id="cq" type="search" placeholder="Search item no / name / part number…" style="max-width:300px">
        <select id="ccat" style="max-width:210px"><option value="">All categories</option>${facets.categories.map((r) => `<option value="${esc(r.category)}">${esc(r.category)} (${r.count})</option>`).join('')}</select>
        <select id="ckind" style="max-width:170px"><option value="">All kinds</option>${facets.by_kind.map((r) => `<option value="${esc(r.kind)}">${esc(r.kind)} (${r.count})</option>`).join('')}</select>
        <a class="btn sm" href="/api/stores/export/catalogue.xlsx">⬇ Excel</a>
        <div class="spacer"></div><span class="muted" id="ccount"></span>
      </div>
      <p class="muted" style="margin:0 0 8px">${num(facets.total)} general items — deduped from every MRN request, each with a category-prefixed item number. The Part Numbers column lists every code ever seen for that item.</p>
      <div id="ctable"><div class="muted">Loading…</div></div>`;
    const load = async () => {
      const q = qs('#cq').value.trim(), cat = qs('#ccat').value, kind = qs('#ckind').value;
      const list = await api('/stores/catalogue?limit=2000'
        + (q ? '&q=' + encodeURIComponent(q) : '')
        + (cat ? '&category=' + encodeURIComponent(cat) : '')
        + (kind ? '&kind=' + encodeURIComponent(kind) : ''));
      qs('#ccount').textContent = `${list.length}${list.length === 2000 ? '+' : ''} item${list.length === 1 ? '' : 's'}`;
      qs('#ctable').innerHTML = tableWrap(
        [{ label: 'Item No' }, { label: 'Item Name' }, { label: 'Category' }, { label: 'Kind' }, { label: 'Requests', num: true }, { label: 'Part Numbers' }],
        list.map((i) => { const pn = i.part_numbers || ''; return `<tr>
          <td><code>${esc(i.item_no)}</code></td>
          <td>${esc(i.name)}</td>
          <td>${esc(i.category || '')}</td>
          <td>${kindBadge(i.catalogue_kind)}</td>
          <td class="num">${num(i.req_count || 0)}</td>
          <td title="${esc(pn)}" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pn.length > 70 ? pn.slice(0, 70) + '…' : pn)}</td></tr>`; }), { scroll: true });
    };
    let cdeb; qs('#cq').oninput = () => { clearTimeout(cdeb); cdeb = setTimeout(load, 250); };
    qs('#ccat').onchange = load; qs('#ckind').onchange = load;
    await load();
  } else if (tab === 'items') {
    const items = await api('/stores/items?limit=500');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="ni">+ New Item</button></div>' : ''}
      ${tableWrap([{ label: 'Name' }, { label: 'Part No' }, { label: 'Category' }, { label: 'Unit' }, { label: 'General?' }, { label: 'Balance', num: true }, { label: 'Min', num: true }],
        items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.part_number || '')}</td><td>${esc(i.category || '')}</td><td>${esc(i.unit)}</td><td>${i.is_general ? '✓' : ''}</td><td class="num">${i.is_general ? num(i.balance) : '—'}</td><td class="num">${i.min_stock || ''}</td></tr>`), { scroll: true })}`;
    if (qs('#ni')) qs('#ni').onclick = () => simpleCreateModal('New Store Item', '/stores/items', [['Name *', 'name'], ['Part Number', 'part_number'], ['Category', 'category'], ['Unit', 'unit'], ['Min Stock', 'min_stock', 'number'], ['General consumable', 'is_general', 'checkbox']]);
  } else if (tab === 'reorder') {
    const items = await api('/stores/reorder');
    body.innerHTML = tableWrap([{ label: 'Name' }, { label: 'Balance', num: true }, { label: 'Min Stock', num: true }], items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num"><span class="badge red">${num(i.balance)}</span></td><td class="num">${num(i.min_stock)}</td></tr>`));
  } else if (tab === 'mrn') {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (params.get('id')) return mrnDetail(body, params.get('id'));
    return mrnList(body, params);
  } else if (tab === 'grn') {
    const canRx = can('storekeeper');
    body.innerHTML = `
      <div class="toolbar">
        <input id="gq" type="search" placeholder="Search GRN / item / supplier / MRN…" style="max-width:280px">
        <label style="display:flex;gap:6px;align-items:center;flex-direction:row;width:auto"><input type="checkbox" id="gawait" style="width:auto"> Awaiting price only</label>
        <div class="spacer"></div><span class="muted" id="gcount"></span>
      </div>
      <div id="gtable"><div class="muted">Loading…</div></div>`;
    const load = async () => {
      const q = qs('#gq').value.trim(), awaiting = qs('#gawait').checked;
      const list = await api('/stores/grn?limit=500' + (q ? '&q=' + encodeURIComponent(q) : '') + (awaiting ? '&awaiting=1' : ''));
      qs('#gcount').textContent = `${list.length}${list.length === 500 ? '+' : ''} record${list.length === 1 ? '' : 's'}`;
      qs('#gtable').innerHTML = tableWrap(
        [{ label: 'GRN' }, { label: 'MRN' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Value', num: true }, { label: 'Supplier' }, { label: 'Source' }].concat(canRx ? [{ label: '', num: true }] : []),
        list.map((g) => `<tr>
          <td>${esc(g.grn_no || '')}</td>
          <td>${g.mrn_id ? `<a href="#/stores?tab=mrn&id=${g.mrn_id}">${esc(g.mrn_no || '')}</a>` : ''}</td>
          <td>${esc(g.description || '')}</td>
          <td class="num">${num(g.qty)}</td>
          <td class="num">${g.unit_price == null ? '<span class="badge amber">awaiting</span>' : money(g.unit_price)}</td>
          <td class="num">${g.unit_price == null ? '—' : money((Number(g.qty) || 0) * g.unit_price)}</td>
          <td>${esc(g.supplier || '')}</td>
          <td>${esc(sourceLabel(g.purchase_source))}</td>
          ${canRx ? `<td class="num"><button class="sm ${g.unit_price == null ? 'primary' : ''}" data-price="${g.id}">${g.unit_price == null ? 'Add price' : 'Edit'}</button></td>` : ''}</tr>`), { scroll: true });
      if (canRx) qsa('[data-price]', qs('#gtable')).forEach((btn) => btn.onclick = () => grnPriceModal(list.find((x) => String(x.id) === btn.dataset.price), load));
    };
    let gdeb; qs('#gq').oninput = () => { clearTimeout(gdeb); gdeb = setTimeout(load, 250); };
    qs('#gawait').onchange = load;
    await load();
  } else if (tab === 'issues') {
    body.innerHTML = `
      <div class="toolbar">
        ${can('storekeeper') ? '<button class="primary" id="nis">+ New Issue</button>' : ''}
        <input id="iq" type="search" placeholder="Search vehicle / item / issued by…" style="max-width:260px">
        <div class="spacer"></div><span class="muted" id="icount"></span>
      </div>
      <div id="itable"><div class="muted">Loading…</div></div>`;
    const load = async () => {
      const q = qs('#iq').value.trim();
      const list = await api('/stores/issues?limit=500' + (q ? '&q=' + encodeURIComponent(q) : ''));
      qs('#icount').textContent = `${list.length}${list.length === 500 ? '+' : ''} issue${list.length === 1 ? '' : 's'}`;
      qs('#itable').innerHTML = tableWrap(
        [{ label: 'Date' }, { label: 'Vehicle' }, { label: 'Item / description' }, { label: 'Category' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Issued by' }],
        list.map((i) => `<tr>
          <td>${esc((i.issue_date || '').slice(0, 10))}</td>
          <td>${esc(i.asset_code || '—')}</td>
          <td>${esc(i.description)}</td>
          <td>${esc(i.category || '')}</td>
          <td class="num">${num(i.qty)}</td>
          <td class="num">${i.unit_price == null ? '—' : money(i.unit_price)}</td>
          <td>${esc(i.issued_by || '')}</td></tr>`), { scroll: true });
    };
    let ideb; qs('#iq').oninput = () => { clearTimeout(ideb); ideb = setTimeout(load, 250); };
    if (qs('#nis')) qs('#nis').onclick = () => newIssueModal(load);
    await load();
  } else if (tab === 'mtn') {
    const list = await api('/stores/mtn');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="nt">+ New MTN</button></div>' : ''}
      ${tableWrap([{ label: 'MTN No' }, { label: 'Date' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'From' }, { label: 'To' }],
        list.map((t) => `<tr><td>${esc(t.mtn_no)}</td><td>${esc(t.txn_date)}</td><td>${esc(t.description || '')}</td><td class="num">${num(t.qty)}</td><td>${esc(t.from_location || t.from_asset_code || '')}</td><td>${esc(t.to_location || t.to_asset_code || '')}</td></tr>`), { scroll: true })}`;
    if (qs('#nt')) qs('#nt').onclick = () => simpleCreateModal('New MTN (transfer)', '/stores/mtn', [['Description', 'description'], ['Qty *', 'qty', 'number'], ['From location', 'from_location'], ['To location', 'to_location'], ['To asset (code/text)', 'to_asset'], ['Transferred by', 'transferred_by'], ['Received by', 'received_by'], ['Reason', 'reason']]);
  }
};

async function mrnList(body, params) {
  const cur = { q: params.get('q') || '', sort: params.get('sort') || 'date_desc' };
  body.innerHTML = `
    <div class="toolbar">
      ${can('storekeeper') ? '<button class="primary" id="nm">+ New MRN</button>' : ''}
      <input id="mq" type="search" placeholder="Search MRN no / vehicle / item…" value="${esc(cur.q)}" style="max-width:260px">
      <select id="msort" style="max-width:160px">
        <option value="date_desc">Newest first</option>
        <option value="date_asc">Oldest first</option>
        <option value="mrn_desc">MRN no ↓</option>
        <option value="mrn_asc">MRN no ↑</option>
      </select>
      <div class="spacer"></div><span class="muted" id="mcount"></span>
    </div>
    <div id="mtable"><div class="muted">Loading…</div></div>`;
  qs('#msort').value = cur.sort;
  const load = async () => {
    const q = qs('#mq').value.trim(), sort = qs('#msort').value;
    const sp = new URLSearchParams({ tab: 'mrn' });
    if (q) sp.set('q', q);
    if (sort) sp.set('sort', sort);
    history.replaceState(null, '', '#/stores?' + sp.toString());
    const list = await api('/stores/mrn?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + 'sort=' + sort + '&limit=500');
    qs('#mcount').textContent = `${list.length}${list.length === 500 ? '+' : ''} MRN${list.length === 1 ? '' : 's'}`;
    qs('#mtable').innerHTML = tableWrap(
      [{ label: 'MRN No' }, { label: 'Date' }, { label: 'Vehicle' }, { label: 'Source' }, { label: 'Lines', num: true }, { label: 'Qty Req', num: true }, { label: 'Qty Recd', num: true }, { label: 'Status' }],
      list.map((m) => `<tr data-mrn="${m.id}" style="cursor:pointer">
        <td><a href="#/stores?tab=mrn&id=${m.id}">${esc(m.mrn_no)}</a></td>
        <td>${esc((m.req_date || '').slice(0, 10))}</td>
        <td>${esc(m.asset_code || '—')}</td>
        <td>${esc(sourceLabel(m.purchase_source))}</td>
        <td class="num">${m.line_count}</td>
        <td class="num">${num(m.qty_requested)}</td>
        <td class="num">${num(m.qty_received)}</td>
        <td>${mrnStatusBadge(m.status)}</td></tr>`), { scroll: true });
    qsa('[data-mrn]').forEach((tr) => tr.onclick = (e) => { if (e.target.tagName !== 'A') location.hash = '#/stores?tab=mrn&id=' + tr.dataset.mrn; });
  };
  let deb; qs('#mq').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#msort').onchange = load;
  if (qs('#nm')) qs('#nm').onclick = newMrnModal;
  await load();
}

async function mrnDetail(body, id) {
  const d = await api('/stores/mrn/' + id);
  const m = d.mrn;
  const canRx = can('storekeeper');
  const lineRows = d.lines.map((l) => {
    const remaining = Math.max(0, (Number(l.qty) || 0) - (Number(l.qty_received) || 0));
    return `<tr>
      <td>${esc(l.description || '')}</td>
      <td>${esc(l.category || '')}</td>
      <td class="num">${num(l.qty)} ${esc(l.unit || '')}</td>
      <td class="num">${num(l.qty_received)}</td>
      <td class="num">${remaining > 0 ? `<span class="badge amber">${num(remaining)}</span>` : '<span class="badge green">0</span>'}</td>
      ${canRx ? `<td class="num">${remaining > 0 ? `<button class="sm primary" data-rx="${l.id}" data-desc="${esc(l.description || '')}" data-rem="${remaining}">Receive</button>` : '✓'}</td>` : ''}</tr>`;
  });
  const grnRows = d.grns.map((g) => `<tr>
    <td>${esc(g.grn_no || '—')}</td>
    <td>${esc(g.description || '')}</td>
    <td class="num">${num(g.qty)}</td>
    <td class="num">${g.unit_price == null ? '<span class="badge amber">awaiting</span>' : money(g.unit_price)}</td>
    <td class="num">${g.unit_price == null ? '—' : money((Number(g.qty) || 0) * g.unit_price)}</td>
    <td>${esc(g.supplier || '')}</td>
    <td>${esc(sourceLabel(g.purchase_source))}</td>
    ${canRx ? `<td class="num"><button class="sm ${g.unit_price == null ? 'primary' : ''}" data-price="${g.id}">${g.unit_price == null ? 'Add price' : 'Edit'}</button></td>` : ''}</tr>`);
  body.innerHTML = `
    <div class="toolbar"><a class="btn sm" href="#/stores?tab=mrn">← MRN list</a></div>
    <div class="card">
      <h3>MRN ${esc(m.mrn_no)} ${mrnStatusBadge(m.status)}</h3>
      <p class="muted">Date ${esc((m.req_date || '').slice(0, 10))} · Vehicle ${esc(m.asset_code || '—')} · Source ${esc(sourceLabel(m.purchase_source))}${m.purpose ? ' · ' + esc(m.purpose) : ''}${m.requested_by ? ' · by ' + esc(m.requested_by) : ''}</p>
      ${tableWrap([{ label: 'Item description' }, { label: 'Category' }, { label: 'Qty requested', num: true }, { label: 'Qty received', num: true }, { label: 'Remaining', num: true }].concat(canRx ? [{ label: '', num: true }] : []), lineRows, { scroll: true })}
    </div>
    <div class="card">
      <h3>Received records — GRN <span class="muted">(${d.grns.length})</span></h3>
      ${d.grns.length
        ? tableWrap([{ label: 'GRN No' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Value', num: true }, { label: 'Supplier' }, { label: 'Source' }].concat(canRx ? [{ label: '', num: true }] : []), grnRows, { scroll: true })
        : '<p class="muted">Nothing received against this MRN yet.</p>'}
    </div>`;
  if (canRx) {
    qsa('[data-rx]').forEach((btn) => btn.onclick = () => receiveModal(m, btn.dataset.rx, btn.dataset.desc, btn.dataset.rem, () => mrnDetail(body, id)));
    qsa('[data-price]').forEach((btn) => btn.onclick = () => grnPriceModal(d.grns.find((x) => String(x.id) === btn.dataset.price), () => mrnDetail(body, id)));
  }
}

function receiveModal(mrn, lineId, desc, remaining, onDone) {
  modal('Receive against MRN ' + mrn.mrn_no, `
    <p class="muted">${esc(desc)} — remaining ${esc(remaining)}</p>
    ${field('Qty received *', 'qty', { type: 'number', value: remaining })}
    ${field('Unit price (Rs)', 'unit_price', { type: 'number' })}
    ${field('Purchase source', 'purchase_source', { type: 'select', options: SOURCE_OPTS, value: mrn.purchase_source || '' })}
    ${field('Supplier', 'supplier')}
    ${field('GRN No', 'grn_no')}
    ${field('Invoice No', 'invoice_no')}
    ${field('Delivery date', 'delivery_date', { type: 'date' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Record receipt</button></div>`,
    (mbody, close) => {
      qs('#s', mbody).onclick = async () => {
        const f = formData(mbody);
        if (!f.qty || Number(f.qty) <= 0) return toast('Enter a quantity received', 'err');
        try {
          await api('/stores/grn', { method: 'POST', body: {
            mrn_id: mrn.id, mrn_line_id: lineId, description: desc, qty: f.qty,
            unit_price: f.unit_price, purchase_source: f.purchase_source || undefined,
            supplier: f.supplier, grn_no: f.grn_no, invoice_no: f.invoice_no, delivery_date: f.delivery_date,
          } });
          toast('Receipt recorded'); close(); onDone();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
}

// Add / edit the price (and supplier/invoice) on a received record (GRN).
function grnPriceModal(g, onDone) {
  modal((g.unit_price == null ? 'Add price — GRN ' : 'Edit price — GRN ') + (g.grn_no || ''), `
    <p class="muted">${esc(g.description || '')} — qty ${num(g.qty)}</p>
    ${field('Unit price (Rs) *', 'unit_price', { type: 'number', value: g.unit_price == null ? '' : g.unit_price })}
    ${field('Supplier', 'supplier', { value: g.supplier || '' })}
    ${field('Invoice No', 'invoice_no', { value: g.invoice_no || '' })}
    ${field('Invoice date', 'invoice_date', { type: 'date', value: (g.invoice_date || '').slice(0, 10) })}
    ${field('Purchase source', 'purchase_source', { type: 'select', options: SOURCE_OPTS, value: g.purchase_source || '' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save price</button></div>`,
    (mb, close) => {
      qs('#s', mb).onclick = async () => {
        const f = formData(mb);
        if (f.unit_price === '' || Number(f.unit_price) < 0 || isNaN(Number(f.unit_price))) return toast('Enter a valid unit price', 'err');
        try {
          await api('/stores/grn/' + g.id, { method: 'PATCH', body: {
            unit_price: f.unit_price, supplier: f.supplier, invoice_no: f.invoice_no,
            invoice_date: f.invoice_date, purchase_source: f.purchase_source || undefined,
          } });
          toast('Price saved'); close(); onDone();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
}

async function newMrnModal() {
  let nextNo = '';
  try { nextNo = (await api('/stores/numbers')).next_mrn; } catch (e) { /* leave blank -> auto */ }
  modal('New MRN', `
    ${field('MRN Number', 'mrn_no', { value: nextNo, placeholder: 'auto if left blank' })}
    ${field('Asset (code/text)', 'asset')}
    ${field('Purchase source', 'purchase_source', { type: 'select', options: SOURCE_OPTS })}
    ${field('Purpose', 'purpose')}
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
      const payload = {
        mrn_no: d.mrn_no, asset: d.asset, purchase_source: d.purchase_source || undefined,
        purpose: d.purpose, requested_by: d.requested_by,
        lines: descs.map((desc, i) => ({ description: desc, qty: qtys[i] })).filter((l) => l.description),
      };
      try { const r = await api('/stores/mrn', { method: 'POST', body: payload }); close(); toast('MRN ' + r.mrn.mrn_no + ' created'); location.hash = '#/stores?tab=mrn&id=' + r.mrn.id; } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function newIssueModal(onDone) {
  const today = new Date().toISOString().slice(0, 10);
  modal('New Issue', `
    ${field('Issue date', 'issue_date', { type: 'date', value: today })}
    ${assetPickerHtml('Vehicle (search & select)')}
    ${field('Item / description *', 'description')}
    ${field('Category', 'category', { type: 'select', options: [{ value: '', label: '—' }].concat(STORE_CATEGORIES.map((c) => ({ value: c, label: c }))) })}
    <div class="row">${field('Qty', 'qty', { type: 'number', value: 1 })}${field('Unit price (Rs)', 'unit_price', { type: 'number' })}</div>
    ${field('Issued by', 'issued_by')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Record issue</button></div>`,
    (body, close) => {
      wireAssetPicker(body);
      qs('#s', body).onclick = async () => {
        const d = formData(body);
        if (!d.description) return toast('Item / description is required', 'err');
        try {
          const r = await api('/stores/issues', { method: 'POST', body: d });
          close();
          if (r.unresolved) toast('Issue recorded — vehicle "' + r.unresolved.raw + '" queued in the Alias Queue', 'err');
          else toast('Issue recorded');
          if (onDone) onDone(); else render();
        } catch (e) { toast(e.message, 'err'); }
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
  const [byAsset, byProject, bySite, bySource, variance] = await Promise.all([
    api('/reports/cost/by-asset'), api('/reports/cost/by-project'), api('/reports/cost/by-site'), api('/reports/cost/by-source'), api('/reports/variance'),
  ]);
  c.innerHTML = `${pageHeader('Cost Reports & Analytics')}
    <div class="card section"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Cost by Project</h3><div class="spacer"></div><a class="btn sm" href="/api/reports/cost/by-project?format=xlsx">⬇ Excel</a></div>
      ${tableWrap([{ label: 'Project' }, { label: 'Labour', num: true }, { label: 'Material', num: true }, { label: 'Oil', num: true }, { label: 'General', num: true }, { label: 'External', num: true }, { label: 'Other/Rec.', num: true }, { label: 'Total', num: true }],
        byProject.map((p) => `<tr><td>${esc(p.project)}</td><td class="num">${money(p.labour)}</td><td class="num">${money(p.material)}</td><td class="num">${money(p.oil)}</td><td class="num">${money(p.general)}</td><td class="num">${money(p.external)}</td><td class="num">${money(p.other)}</td><td class="num"><b>${money(p.total)}</b></td></tr>`))}</div>
    <div class="card section"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Cost by Site <span class="muted" style="font-weight:400">— full location breakdown (${bySite.length})</span></h3><div class="spacer"></div><a class="btn sm" href="/api/reports/cost/by-site?format=xlsx">⬇ Excel</a></div>
      ${tableWrap([{ label: 'Site' }, { label: 'Jobs', num: true }, { label: 'Labour', num: true }, { label: 'Material', num: true }, { label: 'Oil', num: true }, { label: 'General', num: true }, { label: 'External', num: true }, { label: 'Other/Rec.', num: true }, { label: 'Total', num: true }],
        bySite.map((p) => `<tr><td>${esc(p.site)}</td><td class="num">${p.jobs}</td><td class="num">${money(p.labour)}</td><td class="num">${money(p.material)}</td><td class="num">${money(p.oil)}</td><td class="num">${money(p.general)}</td><td class="num">${money(p.external)}</td><td class="num">${money(p.other)}</td><td class="num"><b>${money(p.total)}</b></td></tr>`), { scroll: true })}</div>
    <div class="card section"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Cost by Asset</h3><div class="spacer"></div><a class="btn sm" href="/api/reports/cost/by-asset?format=xlsx">⬇ Excel</a></div>
      ${tableWrap([{ label: 'Asset' }, { label: 'Jobs', num: true }, { label: 'Labour', num: true }, { label: 'Material', num: true }, { label: 'Oil', num: true }, { label: 'General', num: true }, { label: 'External', num: true }, { label: 'Other/Rec.', num: true }, { label: 'Total', num: true }],
        byAsset.map((p) => `<tr><td>${esc(p.asset_code || '—')}</td><td class="num">${p.job_count}</td><td class="num">${money(p.labour)}</td><td class="num">${money(p.material)}</td><td class="num">${money(p.oil)}</td><td class="num">${money(p.general)}</td><td class="num">${money(p.external)}</td><td class="num">${money(p.other)}</td><td class="num"><b>${money(p.total)}</b></td></tr>`), { scroll: true })}</div>
    <div class="grid">
      <div class="card"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Material by Purchase Source</h3><div class="spacer"></div><a class="btn sm" href="/api/reports/cost/by-source?format=xlsx">⬇</a></div>
        ${bySource.map((s) => `<div class="cost-line"><span>${esc(s.purchase_source)}</span><span>${money(s.total)}</span></div>`).join('') || '<span class="muted">none</span>'}</div>
      <div class="card"><h3>Stock Variance Flags</h3>
        ${variance.length ? variance.map((v) => `<div class="cost-line"><span>${esc(v.product)} · ${esc(v.period)}</span><span class="badge red">${num(v.variance)}</span></div>`).join('') : '<span class="muted">No variances</span>'}</div>
    </div>`;
};

// ---- Needs Attention (advisory intelligence — read-only)
routes.attention = async (c) => {
  const [due, anom, integ] = await Promise.all([
    api('/reports/service-due'), api('/reports/anomalies'), api('/reports/integrity'),
  ]);
  const dueList = due.filter((s) => s.due);
  c.innerHTML = `${pageHeader('Needs Attention', 'Advisory only — the system flags, you decide. Nothing here is auto-corrected.')}
    <div class="card section"><h3>Service due / overdue (${dueList.length})</h3>
      ${dueList.length ? tableWrap([{ label: 'Asset' }, { label: 'Machine' }, { label: 'Running h', num: true }, { label: 'Interval', num: true }, { label: 'Overdue by', num: true }, { label: 'Expected Cost', num: true }],
        dueList.map((s) => `<tr><td><a href="#/assets/${s.asset_id}">${esc(s.asset_code)}</a></td><td>${esc(s.machine_label || '')}</td><td class="num">${num(s.running_hours)}</td><td class="num">${num(s.interval_hours)}</td><td class="num"><span class="badge red">${num(s.overdue_by)}</span></td><td class="num">${money(s.expected_cost)}</td></tr>`)) : '<span class="muted">No machines due.</span>'}</div>

    <div class="card section"><h3>Unusual lubricant consumption (${anom.unusual_consumption.length})</h3>
      <p class="muted" style="font-size:12px;margin-top:0">Each asset compared to its <b>own</b> history. Flagged above ${anom.thresholds.consumption_factor}× baseline.</p>
      ${anom.unusual_consumption.length ? tableWrap([{ label: 'Asset' }, { label: 'Product' }, { label: 'Recent rate/day', num: true }, { label: 'Baseline rate/day', num: true }, { label: 'Ratio', num: true }],
        anom.unusual_consumption.map((u) => `<tr><td>${esc(u.asset_code)}</td><td>${esc(u.product_name)}</td><td class="num">${num(u.recent_rate)} ${esc(u.unit)}</td><td class="num">${num(u.baseline_rate)}</td><td class="num"><span class="badge red">${u.ratio}×</span></td></tr>`)) : '<span class="muted">Nothing unusual.</span>'}</div>

    <div class="card section"><h3>GRN price spikes (${anom.grn_price_spikes.length})</h3>
      <p class="muted" style="font-size:12px;margin-top:0">Flagged above ${anom.thresholds.price_spike_factor}× the item's recent average price.</p>
      ${anom.grn_price_spikes.length ? tableWrap([{ label: 'Item' }, { label: 'GRN price', num: true }, { label: 'Baseline avg', num: true }, { label: 'Ratio', num: true }],
        anom.grn_price_spikes.map((g) => `<tr><td>${esc(g.item || '')}</td><td class="num">${money(g.unit_price)}</td><td class="num">${money(g.baseline_avg)}</td><td class="num"><span class="badge red">${g.ratio}×</span></td></tr>`)) : '<span class="muted">No price spikes.</span>'}</div>

    <div class="card section"><h3>Duplicate MRN / likely double-entries (${anom.duplicate_mrn.duplicate_numbers.length + anom.duplicate_mrn.likely_double_entries.length})</h3>
      ${anom.duplicate_mrn.duplicate_numbers.map((d) => `<div class="cost-line"><span>Duplicate MRN number ${esc(d.mrn_no)}</span><span class="badge red">×${d.c}</span></div>`).join('')}
      ${anom.duplicate_mrn.likely_double_entries.map((d) => `<div class="cost-line"><span>${esc(d.asset_code || '?')} · ${esc(d.description)} × ${num(d.qty)} on ${esc(d.req_date)} (${esc(d.mrn_nos)})</span><span class="badge amber">×${d.c}</span></div>`).join('')}
      ${anom.duplicate_mrn.duplicate_numbers.length + anom.duplicate_mrn.likely_double_entries.length === 0 ? '<span class="muted">No duplicates.</span>' : ''}</div>

    <div class="card"><h3>Integrity check (${integ.count})</h3>
      ${integ.count ? integ.issues.map((i) => `<div class="cost-line"><span>${esc(i.detail)}</span><span class="badge red">${esc(i.type)}</span></div>`).join('') : '<span class="ok">✓ No integrity problems found.</span>'}</div>`;
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
    try {
      ME = await api('/auth/login', { method: 'POST', body: { username: qs('#u').value, password: qs('#p').value } });
      location.hash = '#/dashboard'; render();
      if (ME.mustChangePassword) forceChangePassword();
    } catch (e) { renderLogin(e.message); }
  };
  qs('#login').onclick = go;
  qs('#p').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function boot() {
  try {
    ME = await api('/auth/me');
    if (!location.hash) location.hash = '#/dashboard';
    render();
    if (ME.mustChangePassword) forceChangePassword();
  } catch { renderLogin(); }
}
boot();
