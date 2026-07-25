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
const moneyC = (n) => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e6 ? 'Rs ' + (n / 1e6).toFixed(2) + 'M' : a >= 1e3 ? 'Rs ' + Math.round(n / 1e3) + 'K' : 'Rs ' + Math.round(n); };
const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (m) => { const [y, mo] = String(m).split('-'); return (MONTH_NAMES[+mo] || mo) + ' ' + y; };

// Lazy-load Chart.js (dashboard charts). Resolves cb(true/false) — degrades gracefully offline.
let _chartLoading;
function loadChartJs(cb) {
  if (window.Chart) return cb(true);
  if (!_chartLoading) {
    _chartLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
      s.onload = () => resolve(true); s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  _chartLoading.then(() => cb(!!window.Chart));
}
function timeAgo(s) {
  if (!s) return '';
  let iso = String(s).replace(' ', 'T'); if (!/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) iso += 'Z';
  let diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (isNaN(diff)) return esc(String(s)); if (diff < 0) diff = 0;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
  return new Date(iso).toISOString().slice(0, 10);
}
const ENTITY_ICON = { mrn: '📝', issue: '📤', stock_ledger: '🛢️', filter_stock: '🛞', store_item: '📦', product: '🛢️', job_card: '🔧', stock_count: '🔢', session: '🔑', battery: '🔋', asset: '🚜' };

// ---- signature pad (draw or upload a signature; PNG data URL) ----
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.2; ctx.lineJoin = ctx.lineCap = 'round'; ctx.strokeStyle = '#0b2447';
  let drawing = false, last = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); const t = (e.touches && e.touches[0]) || e; return { x: (t.clientX - r.left) * (canvas.width / r.width), y: (t.clientY - r.top) * (canvas.height / r.height) }; };
  const start = (e) => { drawing = true; last = pos(e); e.preventDefault(); };
  const move = (e) => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; e.preventDefault(); };
  const end = () => { drawing = false; };
  canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); document.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', end);
  const self = {
    clear: () => ctx.clearRect(0, 0, canvas.width, canvas.height),
    isEmpty: () => { const dd = ctx.getImageData(0, 0, canvas.width, canvas.height).data; for (let i = 3; i < dd.length; i += 4) if (dd[i] !== 0) return false; return true; },
    dataURL: () => canvas.toDataURL('image/png'),
    load: (url) => { if (!url) return; const img = new Image(); img.onload = () => { self.clear(); ctx.drawImage(img, 0, 0, canvas.width, canvas.height); }; img.src = url; },
    loadFile: (file) => { const fr = new FileReader(); fr.onload = () => { const img = new Image(); img.onload = () => { self.clear(); const s = Math.min(canvas.width / img.width, canvas.height / img.height); ctx.drawImage(img, 0, 0, img.width * s, img.height * s); }; img.src = fr.result; }; fr.readAsDataURL(file); },
  };
  return self;
}
function signaturePadHtml(id) {
  return `<canvas id="${id}" width="360" height="120" style="border:1px solid var(--border);border-radius:4px;background:#fff;touch-action:none;width:100%;max-width:360px;display:block"></canvas>
    <div class="toolbar" style="margin:6px 0 0">
      <button type="button" class="sm" id="${id}_clear">Clear</button>
      <label class="btn sm" style="cursor:pointer;margin:0">Upload image<input type="file" id="${id}_file" accept="image/png,image/jpeg" style="display:none"></label>
      <span class="muted" style="font-size:11px">draw above, or upload a signature image</span>
    </div>`;
}
function wireSignaturePad(root, id, savedUrl) {
  const pad = signaturePad(qs('#' + id, root));
  if (savedUrl) pad.load(savedUrl);
  qs('#' + id + '_clear', root).onclick = () => pad.clear();
  qs('#' + id + '_file', root).onchange = (e) => { if (e.target.files[0]) pad.loadFile(e.target.files[0]); };
  return pad;
}

// Reusable photo picker: choose an image, resize it client-side to a modest JPEG
// data URL (kept small so it stores in the DB alongside the record), show a preview.
function imageUploadHtml(id, existing) {
  return `<div class="imgup" id="${id}">
    <div class="imgup-preview" style="margin:6px 0">${existing ? `<img src="${existing}" style="max-height:150px;max-width:100%;border:1px solid var(--border);border-radius:6px">` : '<span class="muted">No photo</span>'}</div>
    <label class="btn sm" style="cursor:pointer;margin:0">📷 Choose photo<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none"></label>
    <button type="button" class="btn sm" data-imgclear style="margin-left:6px">Remove</button>
  </div>`;
}
function wireImageUpload(root, id, existing) {
  const box = qs('#' + id, root);
  const preview = qs('.imgup-preview', box);
  const fileInput = qs('input[type=file]', box);
  let dataUrl = existing || null;
  const setPreview = () => { preview.innerHTML = dataUrl ? `<img src="${dataUrl}" style="max-height:150px;max-width:100%;border:1px solid var(--border);border-radius:6px">` : '<span class="muted">No photo</span>'; };
  fileInput.onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1000; let w = img.width, h = img.height;
        if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        dataUrl = cv.toDataURL('image/jpeg', 0.7);
        setPreview();
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  };
  qs('[data-imgclear]', box).onclick = () => { dataUrl = null; fileInput.value = ''; setPreview(); };
  return { dataURL: () => dataUrl };
}
// Show both the vehicle/registration number and the E&C number, since staff
// may know one but not the other. Vehicle number comes FIRST (many staff know the
// plate, not the E&C number); the E&C number is appended when it exists and differs.
function vehText(j) {
  const ecNo = j.asset_ec || j.asset_code || '';
  const vehNo = j.asset_reg || '';
  return (vehNo && ecNo && vehNo !== ecNo) ? vehNo + ' · ' + ecNo : (vehNo || ecNo || '');
}
// Same vehicle-first rule for the flat display objects (MRN / daily-work / job rows)
// that carry bare keys (asset_code/registration/ec_code) rather than the job shape.
// For plant/machines the registration is null and code === ec_code, so it collapses
// to a single token instead of rendering "E&C · E&C".
function idLabel(o) {
  if (!o) return '';
  const reg = o.asset_reg || o.registration || '';
  const ec = o.asset_ec || o.ec_code || '';
  const code = o.asset_code || o.code || '';
  const primary = reg || code;                        // vehicle number first, else the code
  const secondary = (ec && ec !== primary) ? ec : ''; // E&C only if present and distinct
  return secondary ? primary + ' · ' + secondary : (primary || '');
}

// ---- request-target picker: General item OR Machine/Vehicle → pick a job card ----
function targetPickerHtml(idp, opts) {
  const o = opts || {};
  return `<label>${esc(o.label || 'Request for')}</label>
    <div class="pill-row" style="margin-bottom:6px">
      <label style="font-weight:400"><input type="radio" name="${idp}_type" value="general" checked style="width:auto"> ${esc(o.generalLabel || 'General item')}</label>
      <label style="font-weight:400"><input type="radio" name="${idp}_type" value="vehicle" style="width:auto"> Machine / Vehicle</label>
    </div>
    <div id="${idp}_veh" style="display:none;position:relative">
      <input type="text" id="${idp}_jq" autocomplete="off" placeholder="Search job no / vehicle no / E&C no…">
      <div id="${idp}_menu" style="position:absolute;z-index:60;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:var(--shadow);max-height:220px;overflow:auto;display:none"></div>
      <div id="${idp}_sel" class="muted" style="font-size:12px;margin-top:4px">Pick the job card this is for.</div>
    </div>`;
}
function wireTargetPicker(root, idp) {
  const state = { type: 'general', job_id: '', asset_code: '', job_no: '' };
  const veh = qs('#' + idp + '_veh', root), jq = qs('#' + idp + '_jq', root), menu = qs('#' + idp + '_menu', root), sel = qs('#' + idp + '_sel', root);
  qsa('input[name=' + idp + '_type]', root).forEach((r) => { r.onchange = () => { state.type = r.value; veh.style.display = state.type === 'vehicle' ? 'block' : 'none'; if (state.type === 'general') { state.job_id = ''; state.asset_code = ''; state.job_no = ''; } }; });
  let deb;
  const search = async () => {
    const q = jq.value.trim(); if (!q) { menu.style.display = 'none'; return; }
    let rows = []; try { rows = await api('/jobs?open=1&limit=15&q=' + encodeURIComponent(q)); } catch (e) { return; }
    menu.innerHTML = rows.length
      ? rows.map((j) => `<div class="tpick" data-id="${j.id}" data-veh="${esc(vehText(j))}" data-no="${esc(j.job_no || '')}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)"><b>${esc(j.job_no || '')}</b> <span class="muted">· ${esc(vehText(j) || '—')} · ${esc(j.status || '')}</span></div>`).join('')
      : '<div class="muted" style="padding:8px 10px">No matching <b>open</b> job card</div>';
    menu.style.display = 'block';
    qsa('.tpick', menu).forEach((it) => { it.onmousedown = (e) => { e.preventDefault(); state.job_id = it.dataset.id; state.asset_code = it.dataset.veh; state.job_no = it.dataset.no; jq.value = it.dataset.no; sel.innerHTML = `Job <b>${esc(it.dataset.no)}</b> · ${esc(it.dataset.veh || 'no vehicle')}`; menu.style.display = 'none'; }; });
  };
  jq.oninput = () => { clearTimeout(deb); deb = setTimeout(search, 220); };
  jq.onblur = () => setTimeout(() => { menu.style.display = 'none'; }, 150);
  return () => state;
}

async function mySignatureModal() {
  let saved = null;
  try { saved = (await api('/auth/signature')).signature; } catch (e) { /* ignore */ }
  modal('My Signature', `
    <p class="muted">Draw your signature below or upload an image. It is saved to your profile and applied automatically when you certify or approve.</p>
    ${signaturePadHtml('mysigpad')}
    <div style="margin-top:12px;text-align:right"><button class="sm" id="rm">Remove</button> <button class="primary" id="s">Save signature</button></div>`, (body, close) => {
    const pad = wireSignaturePad(body, 'mysigpad', saved);
    qs('#s', body).onclick = async () => { if (pad.isEmpty()) return toast('Draw or upload a signature first', 'err'); try { await api('/auth/signature', { method: 'POST', body: { signature: pad.dataURL() } }); toast('Signature saved'); if (window.ME) ME.hasSignature = true; close(); } catch (e) { toast(e.message, 'err'); } };
    qs('#rm', body).onclick = async () => { try { await api('/auth/signature', { method: 'POST', body: { signature: null } }); toast('Signature removed'); if (window.ME) ME.hasSignature = false; close(); } catch (e) { toast(e.message, 'err'); } };
  });
}
const can = (...roles) => ME && (ME.roles.includes('admin') || roles.some((r) => ME.roles.includes(r)));
// RBAC — a module's clearance level for the signed-in user (from the permission matrix).
const RANKL = { none: 0, view: 1, edit: 2, full: 3 };
const rankL = (l) => RANKL[l] || 0;
const canView = (m) => can('admin') || (ME && ME.permissions ? rankL(ME.permissions[m]) >= 1 : true);
const canEdit = (m) => can('admin') || (ME && ME.permissions ? rankL(ME.permissions[m]) >= 2 : true);
const qs = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => [...r.querySelectorAll(s)];

// ---- Real-time: ONE global subscriber auto-refreshes the active view when the data
// it shows changes. audit.record broadcasts a generic 'data_changed' {entity,action,...}
// for every mutation, so no view needs to wire its own listeners.
const LIVE_ENTITY_ROUTES = {
  store_item: ['generalstock', 'stores', 'stockissues'], issue: ['stockissues', 'stores'],
  mrn: ['stores', 'matreq'], grn: ['stores'], mtn: ['stores'], stock_count: ['oil'],
  product: ['oil'], product_price: ['oil'], stock_ledger: ['oil', 'stockissues'],
  filter_stock: ['filterstock'], filter_price: ['filters'], filter_xref: ['filters'], service_job: ['filters'],
  job_card: ['jobs', 'jobrequests'], job_request: ['jobrequests', 'jobs'], job_daily_work: ['dailywork', 'jobs'],
  battery: ['batteries'], asset: ['assets'],
  mechanic: ['mechanics', 'labour'], labour_rate: ['labour', 'mechanics'], mechanic_alias: ['mechanics'],
};
const LIVE_AGG_ROUTES = ['dashboard', 'attention']; // aggregate views refresh on ANY change
let _liveWired = false;
function wireLiveUpdates() {
  if (_liveWired || !window.LiveERP) return;
  _liveWired = true;
  let deb;
  const refresh = () => { clearTimeout(deb); deb = setTimeout(() => { if (ME) render(); }, 300); };
  const curRoute = () => location.hash.replace('#/', '').split('?')[0].split('/')[0] || 'dashboard';
  LiveERP.on('data_changed', (p) => {
    const cur = curRoute();
    if (LIVE_AGG_ROUTES.includes(cur) || ((p && LIVE_ENTITY_ROUTES[p.entity]) || []).includes(cur)) refresh();
  });
  LiveERP.on('connect', () => { if (ME) render(); }); // reconnect catch-up — never leave a stale view
}
// live-client.js self-loads the socket client asynchronously; wire up as soon as it exists.
(function tryWireLive() { if (window.LiveERP) return void wireLiveUpdates(); setTimeout(tryWireLive, 800); })();

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
// True receipt status derived from actual line coverage (the stored mrn.status can be stale).
const receiptBadge = (requested, received) => {
  const req = Number(requested) || 0, rec = Number(received) || 0;
  if (rec <= 0) return '<span class="badge amber">Pending received</span>';
  if (rec < req) return '<span class="badge blue">Partially received</span>';
  return '<span class="badge green">✓ Received</span>';
};

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
      menu.innerHTML = rows.map((r) => `<div class="apick-item" data-id="${r.id}" data-code="${esc(r.code)}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)">${esc(r.registration || r.code)}${(r.registration && r.code && r.registration !== r.code) ? ` <span class="muted">· ${esc(r.code)}</span>` : ''}</div>`).join('');
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
  ['jobrequests', '📋', 'Job Requests'],
  ['dailywork', '📅', 'Daily Work'],
  ['labour', '💵', 'Labour Rates'],
  ['stores', '📦', 'Stores'],
  ['oil', '🛢️', 'Oil & Lube'],
  ['batteries', '🔋', 'Batteries'],
  ['filters', '🧰', 'Filters & Prices'],
  ['matreq', '📝', 'Material Requests', null, '#/stores?tab=mrn'],
  ['stockissues', '📤', 'Stock Issues'],
  ['generalstock', '🧰', 'General Stock'],
  ['filterstock', '🛞', 'Filter Stock'],
  ['projects', '🏗️', 'Projects'],
  ['aliases', '🔗', 'Alias Queue'],
  ['attention', '⚠️', 'Needs Attention'],
  ['progress', '📆', 'Daily Progress'],
  ['teardown', '📉', 'Cost Teardown'],
  ['tyrebattery', '🛞', 'Tyre & Battery'],
  ['reports', '📈', 'Reports'],
  ['access', '🔐', 'Access Control', 'admin'],
];
// Which permission module governs each nav item's visibility (dashboard always on).
const NAV_MODULE = {
  assets: 'assets', jobs: 'jobs', jobrequests: 'jobrequests', dailywork: 'dailywork',
  labour: 'labour', stores: 'stores', oil: 'oil', batteries: 'batteries', filters: 'filters',
  projects: 'projects', aliases: 'aliases', attention: 'reports', progress: 'reports',
  teardown: 'reports', reports: 'reports', tyrebattery: 'reports',
  matreq: 'stores', stockissues: 'stores', generalstock: 'stores', filterstock: 'filters',
};
function navVisible(n) {
  if (n[3] === 'admin') return can('admin');
  if (n[0] === 'dashboard') return true;
  const m = NAV_MODULE[n[0]];
  return !m || canView(m);
}

// Sidebar grouping — headings shown above each cluster (a group with no visible item is hidden).
const NAV_GROUP_ORDER = ['Operations', 'Inventory', 'Procurement', 'Fleet', 'Analysis', 'Admin'];
const NAV_GROUP = {
  dashboard: 'Operations', jobs: 'Operations', jobrequests: 'Operations', dailywork: 'Operations',
  stores: 'Inventory', generalstock: 'Inventory', filterstock: 'Inventory', oil: 'Inventory', filters: 'Inventory', batteries: 'Inventory',
  matreq: 'Procurement', stockissues: 'Procurement',
  assets: 'Fleet',
  reports: 'Analysis', attention: 'Analysis', progress: 'Analysis', teardown: 'Analysis', tyrebattery: 'Analysis', aliases: 'Analysis', projects: 'Analysis', labour: 'Analysis',
  access: 'Admin',
};

function renderShell() {
  const route = (location.hash.replace('#/', '').split('?')[0].split('/')[0]) || 'dashboard';
  const link = (n, i) => `<a href="${n[4] || '#/' + n[0]}" class="${!n[4] && route === n[0] ? 'active' : ''}"><span class="ix">${String(i + 1).padStart(2, '0')}</span><span class="ico">${n[1]}</span>${n[2]}</a>`;
  let i = 0;
  const nav = NAV_GROUP_ORDER.map((g) => {
    const items = NAV.filter((n) => (NAV_GROUP[n[0]] || 'Analysis') === g && navVisible(n));
    return items.length ? `<div class="nav-group">${esc(g)}</div>` + items.map((n) => link(n, i++)).join('') : '';
  }).join('');
  qs('#app').innerHTML = `
    <div class="topbar">
      <button class="hamburger" id="ham">☰</button>
      <div class="brand">Workshop<span>One</span></div>
      <div class="spacer"></div>
      <span class="live-dot" title="Live updates — green when connected">●</span>
      <div class="who">${esc(ME.fullName || ME.username)} · ${ME.roles.join(', ')}</div>
      <button class="sm" id="mysig">Signature</button>
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
  qs('#mysig').onclick = mySignatureModal;
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
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = sp.get('month'), asset = sp.get('asset');
  if (month && asset) return dashVehicleMonth(c, month, asset);
  if (month) return dashMonthAssets(c, month);
  return dashMain(c);
};

// Managers' time is precious: their dashboard leads with what needs their sign-off.
function renderPendingApprovals(pa) {
  if (!pa || !pa.is_approver) return '';
  const mrnRow = (m, action) => `<div class="cost-line"><a href="#/stores?tab=mrn&id=${m.id}"><b>MRN ${esc(m.mrn_no)}</b> · ${esc(idLabel(m) || 'general')} · ${m.lines} item(s)${m.requested_by ? ' · by ' + esc(m.requested_by) : ''}${m.certified_by ? ' · certified ' + esc(m.certified_by) : ''}</a><span class="badge ${action === 'Approve' ? 'blue' : 'amber'}">${action} →</span></div>`;
  const jobRow = (j, action) => `<div class="cost-line"><a href="#/jobs/${j.id}"><b>${esc(j.job_no)}</b> · ${esc(idLabel(j) || '—')}</a><span class="badge amber">${action} →</span></div>`;
  const jrRow = (r, action) => `<div class="cost-line"><a href="#/jobrequests/${r.id}"><b>${esc(r.jr_no)}</b> · ${esc(idLabel(r) || '—')}${r.description ? ' · ' + esc(String(r.description).slice(0, 40)) : ''}${r.requested_by ? ' · by ' + esc(r.requested_by) : ''}</a><span class="badge ${action === 'Approve' ? 'blue' : 'amber'}">${action} →</span></div>`;
  const section = (title, rows) => rows.length ? `<div style="margin-top:6px"><div class="muted" style="font-size:12px;margin:6px 0 2px">${title} (${rows.length})</div>${rows}</div>` : '';
  const body = [
    section('Job requests awaiting your <b>certification</b>', (pa.jr_certify || []).map((r) => jrRow(r, 'Certify')).join('')),
    section('Job requests awaiting your <b>approval</b>', (pa.jr_approve || []).map((r) => jrRow(r, 'Approve')).join('')),
    section('MRNs awaiting your <b>certification</b>', pa.certify.map((m) => mrnRow(m, 'Certify')).join('')),
    section('MRNs awaiting your <b>approval</b>', pa.approve.map((m) => mrnRow(m, 'Approve')).join('')),
    section('Job cards awaiting <b>transport approval</b>', pa.transport.map((j) => jobRow(j, 'Approve')).join('')),
    section('Job cards awaiting <b>operations approval</b>', pa.ops.map((j) => jobRow(j, 'Approve')).join('')),
  ].join('');
  return `<div class="card section" style="border-left:4px solid ${pa.total ? 'var(--red)' : 'var(--green)'}">
    <div class="toolbar" style="margin:0"><h3 style="margin:0">⚡ Pending Your Approval</h3><div class="spacer"></div><span class="badge ${pa.total ? 'red' : 'green'}">${pa.total} pending</span></div>
    ${pa.total ? body : '<span class="muted">✓ Nothing awaiting your approval — you\'re all caught up.</span>'}</div>`;
}

async function dashMain(c) {
  const [d, mc, pa] = await Promise.all([
    api('/reports/dashboard'), api('/reports/monthly'),
    api('/reports/pending-approvals').catch(() => ({ total: 0, is_approver: false, certify: [], approve: [], transport: [], ops: [], jr_certify: [], jr_approve: [] })),
  ]);
  const na = d.needs_attention || {};
  const naTotal = Object.values(na).reduce((a, b) => a + (b || 0), 0);
  const statusRows = d.jobs_by_status.map((s) => `<tr><td>${statusBadge(s.status)}</td><td class="num">${s.count}</td></tr>`);
  const maxProj = Math.max(1, ...d.month_cost_by_project.map((p) => p.total));
  const projBars = d.month_cost_by_project.map((p) => `
    <div class="cost-line"><span>${esc(p.project)}</span><span>${money(p.total)}</span></div>
    <div class="bar-track"><div class="bar" style="width:${(p.total / maxProj) * 100}%"></div></div>`).join('') || '<span class="muted">No cost this month</span>';
  // Role-tailored cockpit: quick-launch tiles for the sections this user can work in.
  const wsTiles = [
    { m: 'stores', route: 'stores', ico: '📦', title: 'Stores', sub: 'MRNs · receive · issue' },
    { m: 'oil', route: 'oil', ico: '🛢️', title: 'Oil & Lube', sub: 'issue · stock book' },
    { m: 'jobrequests', route: 'jobrequests', ico: '📋', title: 'Job Requests', sub: 'raise · certify · approve' },
    { m: 'jobs', route: 'jobs', ico: '🔧', title: 'Job Cards', sub: 'manage work' },
    { m: 'dailywork', route: 'dailywork', ico: '📅', title: 'Daily Work', sub: 'log hours' },
    { m: 'batteries', route: 'batteries', ico: '🔋', title: 'Batteries', sub: 'track · swap' },
    { m: 'assets', route: 'assets', ico: '🚜', title: 'Assets', sub: 'fleet registry' },
  ].filter((w) => canEdit(w.m)).map((w) => `<a class="card stat" href="#/${w.route}" style="text-decoration:none;align-items:flex-start;gap:2px"><span class="n" style="font-size:26px">${w.ico}</span><span class="l"><b>${w.title}</b><br>${w.sub}</span></a>`).join('');
  const S = [pageHeader('Dashboard', `${esc(ME.fullName || ME.username)} · ${esc(ME.roles.join(', '))}`), renderPendingApprovals(pa)];
  if (wsTiles) S.push(`<div class="card section"><h3 style="margin-top:0">Your workspace</h3><div class="grid">${wsTiles}</div></div>`);
  if (canView('reports')) S.push(`
    <h3 style="margin-top:0">This Month · ${monthName(mc.this_month.month)}</h3>
    <div class="grid section">
      <div class="card stat"><span class="n">${moneyC(mc.this_month.total)}</span><span class="l">Total Cost</span></div>
      <div class="card stat"><span class="n">${moneyC(mc.this_month.labour)}</span><span class="l">Labour</span></div>
      <div class="card stat"><span class="n">${moneyC(mc.this_month.head_office)}</span><span class="l">Head Office Purchase</span></div>
      <div class="card stat"><span class="n">${moneyC(mc.this_month.local_purchase)}</span><span class="l">Local Purchase</span></div>
      <div class="card stat"><span class="n">${moneyC(mc.this_month.oil)}</span><span class="l">Oil &amp; Lube</span></div>
      <div class="card stat"><span class="n">${moneyC(mc.this_month.service || 0)}</span><span class="l">Service</span></div>
    </div>
    <div class="card section"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Monthly Cost History</h3><div class="spacer"></div><span class="muted">click a month to drill in →</span></div>
      ${tableWrap([{ label: 'Month' }, { label: 'Jobs', num: true }, { label: 'Labour', num: true }, { label: 'Head Office', num: true }, { label: 'Local', num: true }, { label: 'Oil', num: true }, { label: 'Service', num: true }, { label: 'Total', num: true }],
        mc.months.map((m) => `<tr style="cursor:pointer" onclick="location.hash='#/dashboard?month=${m.month}'">
          <td><b>${monthName(m.month)}</b></td>
          <td class="num">${m.jobs}</td>
          <td class="num">${money(m.labour)}</td>
          <td class="num">${money(m.head_office)}</td>
          <td class="num">${money(m.local_purchase)}</td>
          <td class="num">${money(m.oil)}</td>
          <td class="num">${money(m.service || 0)}</td>
          <td class="num"><b>${money(m.total)}</b></td></tr>`), { scroll: true })}</div>`);
  const opStats = [];
  if (canView('jobs')) opStats.push(`<div class="card stat"><span class="n">${d.open_jobs_count}</span><span class="l">Open Job Cards</span></div>
      <div class="card stat"><span class="n">${d.closed_this_month_count}</span><span class="l">Closed This Month</span></div>
      <div class="card stat"><span class="n">${d.awaiting_price.length}</span><span class="l">Awaiting Price (blocked)</span></div>`);
  if (canView('oil')) opStats.push(`<div class="card stat"><span class="n">${d.low_stock_oil.length}</span><span class="l">Low-stock Lubricants</span></div>`);
  if (canView('batteries')) opStats.push(`<div class="card stat"><span class="n">${d.batteries_warranty.length}</span><span class="l">Battery Warranty ≤60d</span></div>`);
  if (opStats.length) S.push(`<div class="grid section">${opStats.join('')}</div>`);
  if (canView('reports')) S.push(`
    <a href="#/attention" style="text-decoration:none"><div class="card section" style="border-left:4px solid ${naTotal ? 'var(--amber)' : 'var(--green)'}">
      <div class="toolbar" style="margin:0"><h3 style="margin:0">⚠ Needs Attention</h3><div class="spacer"></div><span class="badge ${naTotal ? 'amber' : 'green'}">${naTotal} flag${naTotal === 1 ? '' : 's'}</span></div>
      <div class="pill-row" style="margin-top:8px">
        <span class="badge ${na.service_due ? 'amber' : ''}">Service due: ${na.service_due || 0}</span>
        <span class="badge ${na.unusual_consumption ? 'red' : ''}">Unusual consumption: ${na.unusual_consumption || 0}</span>
        <span class="badge ${na.duplicate_mrn ? 'red' : ''}">Duplicate MRN: ${na.duplicate_mrn || 0}</span>
        <span class="badge ${na.grn_price_spikes ? 'red' : ''}">GRN price spikes: ${na.grn_price_spikes || 0}</span>
        <span class="badge ${na.integrity_issues ? 'red' : ''}">Integrity issues: ${na.integrity_issues || 0}</span>
      </div>
    </div></a>`);
  const G = [];
  if (canView('jobs')) G.push(`<div class="card"><h3>Jobs by Status</h3>${tableWrap([{ label: 'Status' }, { label: 'Count', num: true }], statusRows)}</div>
      <div class="card"><h3>Awaiting Price — blocking closure</h3>
        ${d.awaiting_price.length ? d.awaiting_price.map((j) => `<div class="cost-line"><a href="#/jobs/${j.id}">${esc(j.job_no)} · ${esc(j.asset_code || '?')}</a><span class="badge red">${j.missing_count} unpriced</span></div>`).join('') : '<span class="muted">None — all priced</span>'}
      </div>`);
  if (canView('reports')) G.push(`<div class="card"><h3>This-Month Cost by Project</h3>${projBars}</div>`);
  if (canView('oil')) G.push(`<div class="card"><h3>Low-stock Lubricants</h3>
        ${d.low_stock_oil.length ? d.low_stock_oil.map((p) => `<div class="cost-line"><span>${esc(p.name)}</span><span class="badge amber">${num(p.balance)} / ${num(p.reorder_level)} ${esc(p.unit)}</span></div>`).join('') : '<span class="muted">All above reorder level</span>'}
      </div>`);
  if (canView('batteries')) G.push(`<div class="card"><h3>Battery Warranty Radar</h3>
        ${d.batteries_warranty.length ? d.batteries_warranty.map((b) => `<div class="cost-line"><span>${esc(b.serial_no)} ${b.asset_code ? '· ' + esc(b.asset_code) : ''}</span><span class="badge amber">${esc(b.warranty_date)}</span></div>`).join('') : '<span class="muted">Nothing expiring soon</span>'}
      </div>`);
  if (G.length) S.push(`<div class="grid">${G.join('')}</div>`);
  // Live overview (charts + activity) — additive, powered by /api/dashboard/overview.
  if (canView('reports')) S.push(`<div class="card section"><h3 style="margin-top:0">📊 Live Overview</h3>
    <div class="grid" style="grid-template-columns:1.5fr 1fr 1fr;gap:12px">
      <div><div class="muted" style="font-size:12px">Monthly cost trend</div><div style="position:relative;height:220px"><canvas id="dc-trend"></canvas></div></div>
      <div><div class="muted" style="font-size:12px">Job status (90 days)</div><div style="position:relative;height:220px"><canvas id="dc-jobs"></canvas></div></div>
      <div><div class="muted" style="font-size:12px">Top 5 cost vehicles</div><div style="position:relative;height:220px"><canvas id="dc-top5"></canvas></div></div>
    </div><div id="dc-charts-msg" class="muted" style="display:none;padding:8px"></div></div>`);
  S.push(`<div class="card section"><h3 style="margin-top:0">Recent Activity</h3><div id="dc-feed" class="muted">Loading…</div></div>`);
  c.innerHTML = S.join('\n');
  dashRenderOverview();
}

// Charts + activity feed for the dashboard (additive; isolated so a failure never
// breaks the rest of the page). Powered by /api/dashboard/overview.
let _dcCharts = {};
async function dashRenderOverview() {
  let o;
  try { o = await api('/dashboard/overview'); } catch (e) { const f = qs('#dc-feed'); if (f) f.innerHTML = '<span class="muted">Overview unavailable</span>'; return; }
  const feed = qs('#dc-feed');
  if (feed) {
    const acts = o.recent_activity || [];
    feed.innerHTML = acts.length ? acts.map((a) => {
      const who = a.full_name || a.username || 'system';
      const desc = ((a.action || 'update').replace(/_/g, ' ')) + ' ' + (a.entity || '').replace(/_/g, ' ') + (a.entity_id ? ' #' + a.entity_id : '');
      return `<div class="cost-line"><span>${ENTITY_ICON[a.entity] || '•'} <b style="text-transform:capitalize">${esc(desc)}</b> <span class="muted">· ${esc(who)}</span></span><span class="muted">${esc(timeAgo(a.created_at))}</span></div>`;
    }).join('') : '<span class="muted">No recent activity</span>';
  }
  if (!qs('#dc-trend')) return; // reports-gated section absent
  loadChartJs((ok) => {
    if (!ok) { const m = qs('#dc-charts-msg'); if (m) { m.textContent = 'Charts unavailable (offline).'; m.style.display = ''; } return; }
    Object.values(_dcCharts).forEach((ch) => { try { ch.destroy(); } catch (e) { /* detached */ } });
    _dcCharts = {};
    const tr = o.monthly_cost_trend || [];
    if (qs('#dc-trend') && tr.length) {
      _dcCharts.trend = new Chart(qs('#dc-trend').getContext('2d'), {
        type: 'bar',
        data: { labels: tr.map((t) => t.month), datasets: [['Parts', 'parts_cost', '#1d5a73'], ['Oil', 'oil_cost', '#f2a900'], ['Filters', 'filter_cost', '#3c7d5a'], ['Labour', 'labour_cost', '#6a7379']].map((d) => ({ label: d[0], backgroundColor: d[2], data: tr.map((t) => Number(t[d[1]]) || 0) })) },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => moneyC(v) } } } },
      });
    }
    const js = o.job_status_breakdown || [];
    const JC = { REQUESTED: '#f2a900', WORK_COMPLETE: '#3c7d5a', CLOSED: '#6a7379', REJECTED: '#c4392d' };
    if (qs('#dc-jobs') && js.length) {
      _dcCharts.jobs = new Chart(qs('#dc-jobs').getContext('2d'), {
        type: 'doughnut',
        data: { labels: js.map((b) => b.status), datasets: [{ data: js.map((b) => b.count), backgroundColor: js.map((b) => JC[b.status] || '#1d5a73') }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } } },
      });
    }
    const t5 = o.top_5_cost_vehicles || [];
    if (qs('#dc-top5') && t5.length) {
      _dcCharts.top5 = new Chart(qs('#dc-top5').getContext('2d'), {
        type: 'bar',
        data: { labels: t5.map((v) => idLabel(v) || v.code || ('#' + v.asset_id)), datasets: [{ data: t5.map((v) => Number(v.total_cost) || 0), backgroundColor: '#1d5a73' }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { callback: (v) => moneyC(v) } } } },
      });
    }
  });
}

// Drill 1: which vehicles cost the most in a given month.
async function dashMonthAssets(c, month) {
  const data = await api('/reports/monthly/' + month + '/assets');
  const rows = data.assets.map((a) => `<tr style="cursor:pointer" onclick="location.hash='#/dashboard?month=${month}&asset=${a.asset_id}'">
    <td>${a.asset_code ? `<span class="stamp">${esc(a.asset_code)}</span>` : '—'}</td>
    <td class="num">${money(a.labour)}</td>
    <td class="num">${money(a.material)}</td>
    <td class="num">${money(a.oil)}</td>
    <td class="num"><b>${money(a.total)}</b></td></tr>`);
  c.innerHTML = `${pageHeader('Cost · ' + monthName(month), 'Vehicles by cost this month — highest first. Click a vehicle for its detail.')}
    <div class="toolbar"><a class="btn sm" href="#/dashboard">← Back to months</a><div class="spacer"></div><span class="muted">${data.assets.length} vehicle(s)</span></div>
    ${data.assets.length ? tableWrap([{ label: 'Vehicle' }, { label: 'Labour', num: true }, { label: 'Material', num: true }, { label: 'Oil', num: true }, { label: 'Total', num: true }], rows, { scroll: true })
      : '<div class="card"><p class="muted">No vehicle cost recorded this month.</p></div>'}`;
}

// Drill 2: one vehicle's cost for that month, with the line items.
async function dashVehicleMonth(c, month, assetId) {
  const d = await api('/reports/monthly/' + month + '/asset/' + assetId);
  const lbl = (idLabel(d) || '(vehicle)');
  const matRows = d.material_lines.map((m) => `<tr>
    <td>${esc((m.delivery_date || '').slice(0, 10))}</td><td>${esc(m.description || '')}</td>
    <td class="num">${num(m.qty)}</td><td class="num">${money(m.unit_price)}</td>
    <td class="num">${money((Number(m.qty) || 0) * (Number(m.unit_price) || 0))}</td>
    <td>${esc(sourceLabel(m.source))}</td><td>${esc(m.supplier || '')}</td></tr>`);
  const labRows = d.labour_lines.map((l) => `<tr>
    <td>${esc((l.work_date || '').slice(0, 10))}</td><td>${esc(l.mechanic || '')}</td>
    <td class="num">${num(l.hours)}</td><td class="num">${money(l.rate)}</td><td class="num">${money(l.amount)}</td>
    <td><a href="#/jobs?q=${encodeURIComponent(l.job_no || '')}">${esc(l.job_no || '')}</a></td></tr>`);
  const oilRows = d.oil_lines.map((o) => `<tr>
    <td>${esc((o.txn_date || '').slice(0, 10))}</td><td>${esc(o.product || '')}</td>
    <td class="num">${num(o.qty)} ${esc(o.unit || '')}</td><td class="num">${money(o.unit_price)}</td>
    <td class="num">${money((Number(o.qty) || 0) * (Number(o.unit_price) || 0))}</td></tr>`);
  c.innerHTML = `${pageHeader(lbl + ' · ' + monthName(month))}
    <div class="toolbar"><a class="btn sm" href="#/dashboard?month=${month}">← Back to ${monthName(month)}</a></div>
    <div class="grid section">
      <div class="card stat"><span class="n">${moneyC(d.total)}</span><span class="l">Total This Month</span></div>
      <div class="card stat"><span class="n">${moneyC(d.labour)}</span><span class="l">Labour</span></div>
      <div class="card stat"><span class="n">${moneyC(d.material)}</span><span class="l">Material</span></div>
      <div class="card stat"><span class="n">${moneyC(d.oil)}</span><span class="l">Oil</span></div>
    </div>
    <div class="card section"><h3>Material / Purchases (${d.material_lines.length})</h3>
      ${d.material_lines.length ? tableWrap([{ label: 'Received' }, { label: 'Item' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Value', num: true }, { label: 'Source' }, { label: 'Supplier' }], matRows, { scroll: true }) : '<span class="muted">None</span>'}</div>
    <div class="card section"><h3>Labour (${d.labour_lines.length})</h3>
      ${d.labour_lines.length ? tableWrap([{ label: 'Date' }, { label: 'Mechanic' }, { label: 'Hours', num: true }, { label: 'Rate', num: true }, { label: 'Amount', num: true }, { label: 'Job' }], labRows, { scroll: true }) : '<span class="muted">None</span>'}</div>
    <div class="card section"><h3>Oil &amp; Lubricant (${d.oil_lines.length})</h3>
      ${d.oil_lines.length ? tableWrap([{ label: 'Date' }, { label: 'Product' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Value', num: true }], oilRows, { scroll: true }) : '<span class="muted">None</span>'}</div>`;
}

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
  c.innerHTML = `${pageHeader(idLabel(a.asset), '<a href="#/assets">← Assets</a>')}
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
      <td>${vehText(j) ? `<span class="stamp">${esc(vehText(j))}</span>` : '—'}</td>
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
      ${can('workshop', 'manager') ? '<button class="primary sm" id="dadd">+ Add Work Done</button>' : ''}
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
      <td>${esc(idLabel(e) || '—')}</td>
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
  if (qs('#dadd')) qs('#dadd').onclick = () => addWorkDoneModal(qs('#ddate').value, go);
  await load(date);
};

// Log a single daily-work entry from the Daily Work section (day by day).
async function addWorkDoneModal(defaultDate, onDone) {
  let mechs = [];
  try { mechs = await api('/mechanics'); } catch (e) { /* falls back to an empty list */ }
  const mechOpts = mechs.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}${m.rate != null ? ' · Rs ' + m.rate + '/h' : ' · no rate'}</option>`).join('');
  modal('Add Work Done', `
    ${field('Date', 'work_date', { type: 'date', value: defaultDate })}
    ${targetPickerHtml('dwt', { label: 'Work for', generalLabel: 'General workshop' })}
    ${field('Description of work', 'description')}
    <label>Mechanic(s)</label>
    <select id="dwmech"><option value="">— add a mechanic —</option>${mechOpts}</select>
    <div id="dwcrew" class="pill-row" style="margin:6px 0;min-height:6px"></div>
    <input type="hidden" name="mechanic">
    ${field('Hours', 'hours', { type: 'number' })}
    <p class="muted" style="font-size:12px;margin:2px 0 0">Pick each mechanic who worked — each is charged the full hours at their own rate.</p>
    <div class="row">${field('External repair (outside work)', 'is_external', { type: 'checkbox' })}${field('External value (Rs, if external)', 'external_value', { type: 'number' })}</div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add</button></div>`, (body, close) => {
    const getTarget = wireTargetPicker(body, 'dwt');
    const crew = [];
    const hidden = qs('input[name=mechanic]', body);
    const chips = qs('#dwcrew', body);
    const paint = () => {
      hidden.value = crew.join(', ');
      chips.innerHTML = crew.map((n) => `<span class="badge blue" data-rm="${esc(n)}" style="cursor:pointer" title="Remove">${esc(n)} ✕</span>`).join('');
      qsa('[data-rm]', chips).forEach((el) => { el.onclick = () => { const i = crew.indexOf(el.dataset.rm); if (i >= 0) crew.splice(i, 1); paint(); }; });
    };
    qs('#dwmech', body).onchange = (e) => { const v = e.target.value; if (v && !crew.includes(v)) { crew.push(v); paint(); } e.target.value = ''; };
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      const t = getTarget();
      if (t.type === 'vehicle' && !t.job_id) return toast('Pick the machine/vehicle job card', 'err');
      try {
        const r = await api('/daily-work', { method: 'POST', body: { ...f, request_type: t.type, job_id: t.type === 'vehicle' ? t.job_id : undefined } });
        toast('Logged to job ' + r.job_no);
        close();
        onDone(r.date);
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

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
      <a href="#/assets/${job.asset_id}">${esc(idLabel(job) || '—')}</a>
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
  const tabs = ['categories', 'general', 'items', 'reorder', 'mrn', 'grn', 'awaiting', 'pending', 'issues', 'mtn'];
  const TAB_LABELS = { general: 'GENERAL ITEMS', awaiting: 'AWAITING GRN', pending: 'PENDING PURCHASES' };
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
          <td><span class="stamp">${esc(i.item_no)}</span></td>
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
    const fmtD = (d) => (d ? String(d).slice(0, 10) : '—');
    body.innerHTML = `
      <div class="toolbar">
        <input id="gq" type="search" placeholder="Search GRN / item / supplier / MRN…" style="max-width:240px">
        <select id="gsrc" style="max-width:160px"><option value="">All sources</option><option value="head_office">Head Office</option><option value="local_purchase">Local Purchase</option></select>
        <label style="display:flex;gap:6px;align-items:center;flex-direction:row;width:auto"><input type="checkbox" id="gawait" style="width:auto"> Awaiting price only</label>
        <div class="spacer"></div><span class="muted" id="gcount"></span>
      </div>
      <p class="muted" id="gawaitsum" style="margin:0 0 8px"></p>
      <div id="gtable"><div class="muted">Loading…</div></div>`;
    const load = async () => {
      const q = qs('#gq').value.trim(), awaiting = qs('#gawait').checked, src = qs('#gsrc').value;
      const list = await api('/stores/grn?limit=500' + (q ? '&q=' + encodeURIComponent(q) : '') + (awaiting ? '&awaiting=1' : '') + (src ? '&source=' + src : ''));
      qs('#gcount').textContent = `${list.length}${list.length === 500 ? '+' : ''} record${list.length === 1 ? '' : 's'}`;
      qs('#gtable').innerHTML = tableWrap(
        [{ label: 'GRN' }, { label: 'MRN' }, { label: 'Req Date' }, { label: 'Received' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Value', num: true }, { label: 'Supplier' }, { label: 'Source' }].concat(canRx ? [{ label: '', num: true }] : []),
        list.map((g) => `<tr>
          <td>${esc(g.grn_no || '')}</td>
          <td>${g.mrn_id ? `<a href="#/stores?tab=mrn&id=${g.mrn_id}">${esc(g.mrn_no || '')}</a>` : ''}</td>
          <td>${fmtD(g.mrn_req_date)}</td>
          <td>${fmtD(g.delivery_date)}</td>
          <td>${esc(g.description || '')}</td>
          <td class="num">${num(g.qty)}</td>
          <td class="num">${g.unit_price == null ? '<span class="badge amber">awaiting</span>' : money(g.unit_price) + (g.priced_at ? `<div class="muted" style="font-size:10px">priced ${fmtD(g.priced_at)}</div>` : '')}</td>
          <td class="num">${g.unit_price == null ? '—' : money((Number(g.qty) || 0) * g.unit_price)}</td>
          <td>${esc(g.supplier || '')}</td>
          <td>${esc(sourceLabel(g.purchase_source))}</td>
          ${canRx ? `<td class="num"><button class="sm ${g.unit_price == null ? 'primary' : ''}" data-price="${g.id}">${g.unit_price == null ? 'Add price' : 'Edit'}</button></td>` : ''}</tr>`), { scroll: true });
      if (canRx) qsa('[data-price]', qs('#gtable')).forEach((btn) => btn.onclick = () => grnPriceModal(list.find((x) => String(x.id) === btn.dataset.price), load));
    };
    api('/stores/grn/awaiting-count').then((c) => {
      const bits = (c.by_source || []).filter((s) => s.source !== '(unset)').map((s) => `${sourceLabel(s.source)}: ${num(s.awaiting)}`).join('  ·  ');
      const el = qs('#gawaitsum'); if (el) el.innerHTML = bits ? `⏳ Awaiting price — ${bits}  ·  ${num(c.awaiting_grn)} item(s) awaiting receipt` : '';
    }).catch(() => {});
    let gdeb; qs('#gq').oninput = () => { clearTimeout(gdeb); gdeb = setTimeout(load, 250); };
    qs('#gawait').onchange = load; qs('#gsrc').onchange = load;
    await load();
  } else if (tab === 'awaiting') {
    const fmtD = (d) => (d ? String(d).slice(0, 10) : '—');
    body.innerHTML = `
      <div class="toolbar">
        <input id="aq" type="search" placeholder="Search MRN / item / vehicle…" style="max-width:260px">
        <select id="asrc" style="max-width:160px"><option value="">All sources</option><option value="head_office">Head Office</option><option value="local_purchase">Local Purchase</option></select>
        <div class="spacer"></div><span class="muted" id="acount"></span>
      </div>
      <p class="muted" style="margin:0 0 8px">Items requested (MRN) but not yet received. Purchase source is chosen when the item is received, so it may be blank here.</p>
      <div id="atable"><div class="muted">Loading…</div></div>`;
    const load = async () => {
      const q = qs('#aq').value.trim(), src = qs('#asrc').value;
      const list = await api('/stores/awaiting-grn?limit=500' + (q ? '&q=' + encodeURIComponent(q) : '') + (src ? '&source=' + src : ''));
      qs('#acount').textContent = `${list.length}${list.length === 500 ? '+' : ''} item${list.length === 1 ? '' : 's'} awaiting receipt`;
      qs('#atable').innerHTML = list.length ? tableWrap(
        [{ label: 'Req Date' }, { label: 'MRN' }, { label: 'Vehicle' }, { label: 'Item' }, { label: 'Category' }, { label: 'Ordered', num: true }, { label: 'Received', num: true }, { label: 'Outstanding', num: true }, { label: 'Source' }],
        list.map((r) => `<tr>
          <td>${fmtD(r.req_date)}</td>
          <td>${r.mrn_id ? `<a href="#/stores?tab=mrn&id=${r.mrn_id}">${esc(r.mrn_no || '')}</a>` : esc(r.mrn_no || '')}</td>
          <td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>` : '—'}</td>
          <td>${esc(r.description || '')}</td>
          <td>${esc(r.category || '')}</td>
          <td class="num">${num(r.qty)}</td>
          <td class="num">${num(r.qty_received || 0)}</td>
          <td class="num"><span class="badge amber">${num((Number(r.qty) || 0) - (Number(r.qty_received) || 0))}</span></td>
          <td>${esc(sourceLabel(r.purchase_source))}</td></tr>`), { scroll: true })
        : '<div class="card"><p class="muted">Nothing awaiting receipt — every requested item has a GRN.</p></div>';
    };
    let adeb; qs('#aq').oninput = () => { clearTimeout(adeb); adeb = setTimeout(load, 250); };
    qs('#asrc').onchange = load;
    await load();
  } else if (tab === 'pending') {
    const canRx = can('storekeeper');
    body.innerHTML = `
      <div class="toolbar">
        <input id="pq" type="search" placeholder="Search MRN / item / vehicle…" style="max-width:220px">
        <select id="psrc" style="max-width:150px"><option value="">All sources</option><option value="head_office">Head Office</option><option value="local_purchase">Local Purchase</option><option value="unsourced">Not sourced yet</option></select>
        <select id="pstatus" style="max-width:160px"><option value="">Partial + Not rec.</option><option value="partial">Partial only</option><option value="not_received">Not received only</option></select>
        <a class="btn sm" id="pprint" href="#" target="_blank">🖨 Print</a>
        <div class="spacer"></div><span class="muted" id="pcount"></span>
      </div>
      <p class="muted" id="psum" style="margin:0 0 8px"></p>
      <div id="ptable"><div class="muted">Loading…</div></div>`;
    const qstr = () => { const s = qs('#psrc').value, st = qs('#pstatus').value, q = qs('#pq').value.trim(); return (s ? '&source=' + s : '') + (st ? '&status=' + st : '') + (q ? '&q=' + encodeURIComponent(q) : ''); };
    const load = async () => {
      const list = await api('/stores/pending?limit=2000' + qstr());
      qs('#pcount').textContent = `${list.length} pending line(s)`;
      qs('#pprint').href = '/api/stores/pending/print.html?x=1' + qstr();
      qs('#ptable').innerHTML = list.length ? tableWrap(
        [{ label: 'MRN' }, { label: 'Req Date' }, { label: 'Vehicle' }, { label: 'Item' }, { label: 'Ordered', num: true }, { label: 'Received', num: true }, { label: 'Pending', num: true }, { label: 'Status' }, { label: 'Source' }].concat(canRx ? [{ label: '' }] : []),
        list.map((r) => `<tr>
          <td><a href="#/stores?tab=mrn&id=${r.mrn_id}">${esc(r.mrn_no || '')}</a></td>
          <td>${esc((r.req_date || '').slice(0, 10))}</td>
          <td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>` : '—'}</td>
          <td>${esc(r.description || '')}</td>
          <td class="num">${num(r.ordered)}</td>
          <td class="num">${num(r.received)}</td>
          <td class="num"><span class="badge amber">${num(r.pending)}</span></td>
          <td><span class="badge ${r.status === 'partial' ? 'blue' : ''}">${r.status === 'partial' ? 'Partial' : 'Not received'}</span></td>
          <td>${r.source ? esc(sourceLabel(r.source)) : '<span class="muted">—</span>'}</td>
          ${canRx ? `<td><select data-setsrc="${r.id}" style="width:auto;font-size:12px"><option value="">set source…</option><option value="head_office">→ Head Office</option><option value="local_purchase">→ Local Purchase</option></select></td>` : ''}</tr>`), { scroll: true })
        : '<div class="card"><p class="muted">Nothing pending — every requested item is fully received.</p></div>';
      if (canRx) qsa('[data-setsrc]', qs('#ptable')).forEach((sel) => { sel.onchange = async () => { if (!sel.value) return; try { await api('/stores/mrn/line/' + sel.dataset.setsrc, { method: 'PATCH', body: { purchase_source: sel.value } }); toast('Source set'); load(); loadSummary(); } catch (e) { toast(e.message, 'err'); sel.value = ''; } }; });
    };
    const loadSummary = async () => {
      try {
        const s = await api('/stores/pending/summary');
        const by = { head_office: { partial: 0, not_received: 0 }, local_purchase: { partial: 0, not_received: 0 }, unsourced: { partial: 0, not_received: 0 } };
        for (const r of s) { const k = r.source || 'unsourced'; (by[k] || by.unsourced)[r.status] = r.count; }
        const fmt = (k, name) => `${name}: ${(by[k].partial || 0) + (by[k].not_received || 0)} (${by[k].partial || 0} partial · ${by[k].not_received || 0} not rec.)`;
        qs('#psum').textContent = `${fmt('head_office', 'Head Office')}   ·   ${fmt('local_purchase', 'Local Purchase')}   ·   ${fmt('unsourced', 'Not sourced')}`;
      } catch (e) { /* ignore */ }
    };
    let pdeb; qs('#pq').oninput = () => { clearTimeout(pdeb); pdeb = setTimeout(load, 250); };
    qs('#psrc').onchange = load; qs('#pstatus').onchange = load;
    loadSummary();
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
      list.map((m) => `<tr data-mrn="${m.id}" style="cursor:pointer${m.approval_status === 'rejected' ? ';background:rgba(196,57,44,.06)' : ''}">
        <td><a href="#/stores?tab=mrn&id=${m.id}">${esc(m.mrn_no)}</a></td>
        <td>${esc((m.req_date || '').slice(0, 10))}</td>
        <td>${esc(idLabel(m) || '—')}</td>
        <td>${esc(sourceLabel(m.purchase_source))}</td>
        <td class="num">${m.line_count}</td>
        <td class="num">${num(m.qty_requested)}</td>
        <td class="num">${num(m.qty_received)}</td>
        <td>${m.approval_status === 'rejected' ? '<span class="badge red">✕ Cancelled (rejected)</span>' : receiptBadge(m.qty_requested, m.qty_received)}</td></tr>`), { scroll: true });
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
    const req = Number(l.qty) || 0, rec = Number(l.qty_received) || 0;
    const remaining = Math.max(0, req - rec);
    const status = rec <= 0 ? '<span class="badge amber">Pending received</span>'
      : rec < req ? '<span class="badge blue">Partial received</span>'
      : '<span class="badge green">✓ Received</span>';
    return `<tr>
      <td>${esc(l.description || '')}</td>
      <td>${esc(l.category || '')}</td>
      <td class="num">${num(l.qty)} ${esc(l.unit || '')}</td>
      <td class="num">${num(l.qty_received)}</td>
      <td class="num">${remaining > 0 ? `<span class="badge amber">${num(remaining)}</span>` : '<span class="badge green">0</span>'}</td>
      <td>${status}</td>
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
  const astatus = m.approval_status || 'requested';
  // Imported/historical MRNs (no live requester) predate the approval workflow → treat as approved.
  const isImported = astatus === 'requested' && !(m.requested_by && String(m.requested_by).trim());
  const aBadge = isImported
    ? '<span class="badge green">✓ Approved (imported)</span>'
    : ({ requested: '<span class="badge amber">Awaiting certification</span>', certified: '<span class="badge blue">Certified · awaiting approval</span>', approved: '<span class="badge green">✓ Approved</span>', rejected: '<span class="badge red">✕ Cancelled (rejected)</span>' }[astatus] || '');
  const sig = (name, at) => name ? `${esc(name)} <span class="muted">· ${esc((at || '').slice(0, 16).replace('T', ' '))}</span>` : '<span class="muted">pending</span>';
  const canCertify = !isImported && can('workshop') && astatus === 'requested';
  const canApprove = can('operational_manager') && astatus === 'certified';
  const canReject = !isImported && (can('workshop') || can('operational_manager')) && astatus !== 'approved' && astatus !== 'rejected';
  body.innerHTML = `
    <div class="toolbar"><a class="btn sm" href="#/stores?tab=mrn">← MRN list</a><div class="spacer"></div><a class="btn sm" href="/api/stores/mrn/${m.id}/print.html" target="_blank">🖨 Print MRN</a></div>
    <div class="card">
      <div class="toolbar" style="margin:0"><h3 style="margin:0">Approval flow</h3><div class="spacer"></div>${aBadge}
        ${canCertify ? '<button class="sm primary" id="mcertify">✍ Certify</button>' : ''}
        ${canApprove ? '<button class="sm primary" id="mapprove">✅ Approve</button>' : ''}
        ${canReject ? '<button class="sm danger" id="mreject">Reject</button>' : ''}
      </div>
      ${isImported ? '<p class="muted" style="margin:8px 0 0">Imported record — predates the approval workflow, so it is treated as already approved. No certification/approval is required.</p>' : `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:8px;font-size:13px">
        <div><b>1 · Requested</b>${m.requested_sig ? `<div style="height:30px"><img src="${m.requested_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(m.requested_by, m.req_date)}<br><span class="muted">Storekeeper</span></div>
        <div><b>2 · Certified</b>${m.certified_sig ? `<div style="height:30px"><img src="${m.certified_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(m.certified_by, m.certified_at)}<br><span class="muted">Workshop Engineer</span></div>
        <div><b>3 · Approved</b>${m.approved_sig ? `<div style="height:30px"><img src="${m.approved_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(m.approved_by, m.approved_at)}<br><span class="muted">Operational Manager</span></div>
      </div>
      ${(d.approvals && d.approvals.length) ? `<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:6px">${d.approvals.map((a) => `<div class="cost-line"><span>${a.decision === 'rejected' ? '✕' : '✓'} ${esc(a.stage)} — <b>${esc(a.signed_name || '')}</b> <span class="muted">(${esc(a.role || '')})</span>${a.reason ? ' · ' + esc(a.reason) : ''}</span><span class="muted">${esc((a.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>`).join('')}</div>` : ''}`}
    </div>
    <div class="card">
      <h3>MRN ${esc(m.mrn_no)} ${receiptBadge(d.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0), d.lines.reduce((s, l) => s + (Number(l.qty_received) || 0), 0))} ${aBadge}</h3>
      <p class="muted">Date ${esc((m.req_date || '').slice(0, 10))} · Vehicle ${esc(idLabel(m) || '—')} · Source ${esc(sourceLabel(m.purchase_source))}${m.purpose ? ' · ' + esc(m.purpose) : ''}${m.requested_by ? ' · by ' + esc(m.requested_by) : ''}</p>
      ${tableWrap([{ label: 'Item description' }, { label: 'Category' }, { label: 'Qty requested', num: true }, { label: 'Qty received', num: true }, { label: 'Remaining', num: true }, { label: 'Status' }].concat(canRx ? [{ label: '', num: true }] : []), lineRows, { scroll: true })}
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
  if (qs('#mcertify')) qs('#mcertify').onclick = () => mrnSignModal(m, 'certify', () => mrnDetail(body, id));
  if (qs('#mapprove')) qs('#mapprove').onclick = () => mrnSignModal(m, 'approve', () => mrnDetail(body, id));
  if (qs('#mreject')) qs('#mreject').onclick = () => mrnSignModal(m, 'reject', () => mrnDetail(body, id));
}

// E-signature modal for MRN certify / approve / reject.
function mrnSignModal(mrn, action, onDone) {
  const meta = {
    certify: { title: 'Certify MRN', verb: 'certify', btn: 'Sign & Certify' },
    approve: { title: 'Approve MRN', verb: 'approve', btn: 'Sign & Approve' },
    reject: { title: 'Reject MRN', verb: 'reject', btn: 'Reject' },
  }[action];
  const who = esc(ME.fullName || ME.username);
  const withSig = action !== 'reject';
  modal(meta.title + ' — ' + esc(mrn.mrn_no), `
    <p class="muted">Signing as <b>${who}</b> <span class="badge blue">${esc(ME.roles.join(', '))}</span></p>
    ${action === 'reject'
      ? field('Reason (required)', 'reason')
      : `<label style="display:flex;gap:8px;align-items:flex-start;font-weight:400"><input type="checkbox" id="confirm" style="width:auto;margin-top:3px"> I, ${who}, ${meta.verb} this material requisition. This records my e-signature and time.</label>
         <label>Signature</label>${signaturePadHtml('signpad')}
         ${field('Remark (optional)', 'reason')}`}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">${meta.btn}</button></div>`, (body, close) => {
    let pad = null;
    if (withSig) { pad = wireSignaturePad(body, 'signpad', null); (async () => { try { const s = (await api('/auth/signature')).signature; if (s) pad.load(s); } catch (e) { /* no saved sig */ } })(); }
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      if (action !== 'reject' && !qs('#confirm', body).checked) return toast('Tick the confirmation to e-sign', 'err');
      if (action === 'reject' && !String(f.reason || '').trim()) return toast('A reason is required to reject', 'err');
      const signature = (withSig && pad && !pad.isEmpty()) ? pad.dataURL() : undefined;
      const past = { certify: 'certified', approve: 'approved', reject: 'rejected' }[action];
      try { await api('/stores/mrn/' + mrn.id + '/' + action, { method: 'POST', body: { reason: f.reason, signature } }); toast('MRN ' + past + (action !== 'reject' ? ' · e-signed' : '')); close(); onDone(); } catch (e) { toast(e.message, 'err'); }
    };
  });
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
    <div class="row">${field('MRN Number (edit to override)', 'mrn_no', { value: nextNo })}${field('Date', 'req_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}</div>
    <p class="muted" style="font-size:12px;margin:0 0 4px">Continues from the last number (${esc(nextNo || 'auto')}). Change it to set a specific number.</p>
    <div class="row">${field('Project / Workshop', 'purpose', { placeholder: 'e.g. Badalgama W/Shop' })}${field('Required date', 'required_date', { type: 'date' })}</div>
    ${targetPickerHtml('mrnt', { label: 'Request for', generalLabel: 'General item (store)' })}
    <div class="row">${field('Requested by', 'requested_by')}${field('Default source (per item below)', 'purchase_source', { type: 'select', options: SOURCE_OPTS })}</div>
    <h3>Items <span class="muted" style="font-weight:400;font-size:12px">— set Head Office / Local per item</span></h3><div id="lines"></div>
    <button class="sm" id="addline">+ item</button>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create MRN</button></div>`, (body, close) => {
    const getTarget = wireTargetPicker(body, 'mrnt');
    const lines = qs('#lines', body);
    const addLine = () => {
      const defSrc = qs('[name=purchase_source]', body) ? qs('[name=purchase_source]', body).value : '';
      const d = document.createElement('div');
      d.style.cssText = 'border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:8px';
      d.innerHTML = field('Description', 'ldesc') + '<div class="row">' + field('Unit', 'lunit', { value: 'nos' }) + field('Qty', 'lqty', { type: 'number', value: 1 }) + field('Source', 'lsrc', { type: 'select', options: SOURCE_OPTS, value: defSrc }) + '</div>';
      lines.appendChild(d);
    };
    addLine();
    qs('#addline', body).onclick = addLine;
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      const descs = qsa('[name=ldesc]', body).map((e) => e.value);
      const units = qsa('[name=lunit]', body).map((e) => e.value);
      const qtys = qsa('[name=lqty]', body).map((e) => e.value);
      const srcs = qsa('[name=lsrc]', body).map((e) => e.value);
      const t = getTarget();
      if (t.type === 'vehicle' && !t.job_id) return toast('Pick a job card for the machine/vehicle request', 'err');
      const payload = {
        mrn_no: d.mrn_no, req_date: d.req_date, request_type: t.type, job_id: t.type === 'vehicle' ? t.job_id : undefined,
        purchase_source: d.purchase_source || undefined, purpose: d.purpose, required_date: d.required_date, requested_by: d.requested_by,
        lines: descs.map((desc, i) => ({ description: desc, unit: units[i] || 'nos', qty: qtys[i], purchase_source: srcs[i] || undefined })).filter((l) => l.description),
      };
      try { const r = await api('/stores/mrn', { method: 'POST', body: payload }); close(); toast('MRN ' + r.mrn.mrn_no + ' created'); location.hash = '#/stores?tab=mrn&id=' + r.mrn.id; } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function newIssueModal(onDone) {
  const today = new Date().toISOString().slice(0, 10);
  modal('New Issue', `
    ${field('Issue date', 'issue_date', { type: 'date', value: today })}
    ${targetPickerHtml('nis-tgt', { label: 'Issue to — job card (cost lands on the job) or general workshop', generalLabel: 'General workshop (no vehicle)' })}
    ${field('Item / description *', 'description')}
    ${field('Category', 'category', { type: 'select', options: [{ value: '', label: '—' }].concat(STORE_CATEGORIES.map((c) => ({ value: c, label: c }))) })}
    <div class="row">${field('Qty', 'qty', { type: 'number', value: 1 })}${field('Unit price (Rs)', 'unit_price', { type: 'number' })}</div>
    ${field('Issued by', 'issued_by')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Record issue</button></div>`,
    (body, close) => {
      const getTarget = wireTargetPicker(body, 'nis-tgt');
      qs('#s', body).onclick = async () => {
        const d = formData(body);
        const t = getTarget();
        if (t.type === 'vehicle' && !t.job_id) return toast('Pick a job card for the selected vehicle', 'err');
        if (!d.description) return toast('Item / description is required', 'err');
        try {
          await api('/stores/issues', { method: 'POST', body: { job_id: t.job_id || undefined, description: d.description, category: d.category, qty: d.qty, unit_price: d.unit_price, issue_date: d.issue_date, issued_by: d.issued_by } });
          close();
          toast('Issue recorded');
          if (onDone) onDone(); else render();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
}

// ---- Job Requests (Transport) — Assistant Transport raises → Transport Manager
// certifies → Operational Manager approves (auto-creates a job card).
const JR_STATUS = {
  requested: '<span class="badge amber">Awaiting certification</span>',
  certified: '<span class="badge blue">Certified · awaiting approval</span>',
  approved: '<span class="badge green">✓ Approved</span>',
  rejected: '<span class="badge red">✕ Rejected</span>',
};
const jrBadge = (s) => JR_STATUS[s] || mrnStatusBadge(s);

routes.jobrequests = async (c, params) => {
  if (params[0]) return jobRequestDetail(c, params[0]);
  return jobRequestList(c);
};

async function jobRequestList(c) {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const cur = { q: sp.get('q') || '' };
  c.innerHTML = `${pageHeader('Job Requests', 'Transport → Assistant raises · Transport Manager certifies · Operational Manager approves')}
    <div class="toolbar">
      ${can('assistant_transport_manager') ? '<button class="primary" id="njr">+ New Job Request</button>' : ''}
      <input id="jrq" type="search" placeholder="Search JR no / vehicle / description…" value="${esc(cur.q)}" style="max-width:280px">
      <div class="spacer"></div><span class="muted" id="jrcount"></span>
    </div>
    <div id="jrtable"><div class="muted">Loading…</div></div>`;
  const load = async () => {
    const q = qs('#jrq').value.trim();
    history.replaceState(null, '', '#/jobrequests' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const list = await api('/job-requests?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + 'limit=500');
    qs('#jrcount').textContent = `${list.length}${list.length === 500 ? '+' : ''} request${list.length === 1 ? '' : 's'}`;
    qs('#jrtable').innerHTML = tableWrap(
      [{ label: 'JR No' }, { label: 'Date' }, { label: 'Vehicle' }, { label: 'Type' }, { label: 'Work requested' }, { label: 'Requested By' }, { label: 'Job Card' }, { label: 'Status' }],
      list.map((r) => `<tr data-jr="${r.id}" style="cursor:pointer${r.approval_status === 'rejected' ? ';background:rgba(196,57,44,.06)' : ''}">
        <td><a href="#/jobrequests/${r.id}">${esc(r.jr_no)}</a></td>
        <td>${esc((r.req_date || '').slice(0, 10))}</td>
        <td>${esc(idLabel(r) || '—')}</td>
        <td>${esc(r.type || '')}${r.severity ? ' · ' + esc(r.severity) : ''}</td>
        <td>${esc(String(r.description || '').slice(0, 60))}</td>
        <td>${esc(r.requested_by || '')}</td>
        <td>${r.job_no ? `<a href="#/jobs/${r.job_id}">${esc(r.job_no)}</a>` : '—'}</td>
        <td>${jrBadge(r.approval_status)}</td></tr>`), { scroll: true });
    qsa('[data-jr]').forEach((tr) => tr.onclick = (e) => { if (e.target.tagName !== 'A') location.hash = '#/jobrequests/' + tr.dataset.jr; });
  };
  let deb; qs('#jrq').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  if (qs('#njr')) qs('#njr').onclick = newJobRequestModal;
  await load();
}

async function jobRequestDetail(c, id) {
  const d = await api('/job-requests/' + id);
  const r = d.request;
  const st = r.approval_status || 'requested';
  const sig = (name, at) => name ? `${esc(name)} <span class="muted">· ${esc((at || '').slice(0, 16).replace('T', ' '))}</span>` : '<span class="muted">pending</span>';
  const canCertify = can('transport_manager') && st === 'requested';
  const canApprove = (can('operational_manager') || can('manager')) && st === 'certified';
  const canReject = (can('transport_manager') || can('operational_manager') || can('manager')) && st !== 'approved' && st !== 'rejected';
  c.innerHTML = `
    <div class="toolbar"><a class="btn sm" href="#/jobrequests">← Job Requests</a><div class="spacer"></div><a class="btn sm" href="/api/job-requests/${r.id}/print.html" target="_blank">🖨 Print Job Request</a></div>
    <div class="card">
      <div class="toolbar" style="margin:0"><h3 style="margin:0">Approval flow</h3><div class="spacer"></div>${jrBadge(st)}
        ${canCertify ? '<button class="sm primary" id="jrcertify">✍ Certify</button>' : ''}
        ${canApprove ? '<button class="sm primary" id="jrapprove">✅ Approve</button>' : ''}
        ${canReject ? '<button class="sm danger" id="jrreject">Reject</button>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:8px;font-size:13px">
        <div><b>1 · Requested</b>${r.requested_sig ? `<div style="height:30px"><img src="${r.requested_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(r.requested_by, r.req_date)}<br><span class="muted">Assistant Transport Manager</span></div>
        <div><b>2 · Certified</b>${r.certified_sig ? `<div style="height:30px"><img src="${r.certified_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(r.certified_by, r.certified_at)}<br><span class="muted">Transport Manager</span></div>
        <div><b>3 · Approved</b>${r.approved_sig ? `<div style="height:30px"><img src="${r.approved_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(r.approved_by, r.approved_at)}<br><span class="muted">Operational Manager</span></div>
      </div>
      ${(d.approvals && d.approvals.length) ? `<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:6px">${d.approvals.map((a) => `<div class="cost-line"><span>${a.decision === 'rejected' ? '✕' : '✓'} ${esc(a.stage)} — <b>${esc(a.signed_name || '')}</b> <span class="muted">(${esc(a.role || '')})</span>${a.reason ? ' · ' + esc(a.reason) : ''}</span><span class="muted">${esc((a.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>`).join('')}</div>` : ''}
    </div>
    <div class="card">
      <h3>Job Request ${esc(r.jr_no)} ${jrBadge(st)}</h3>
      <p class="muted">Date ${esc((r.req_date || '').slice(0, 10))} · Vehicle ${esc(idLabel(r) || '—')} · ${esc((r.type || '').toUpperCase())}${r.severity ? ' / ' + esc(r.severity) : ''} · Priority ${esc(r.priority || 'normal')}${r.project_name ? ' · ' + esc(r.project_name) : ''}${r.required_date ? ' · required ' + esc((r.required_date || '').slice(0, 10)) : ''}</p>
      <div style="white-space:pre-wrap;border:1px solid var(--border);border-radius:6px;padding:10px;background:var(--surface)">${esc(r.description || '')}</div>
      ${r.job_no ? `<p style="margin-top:10px">✅ Approved — job card created: <a href="#/jobs/${r.job_id}"><b>${esc(r.job_no)}</b></a>${r.job_status ? ' <span class="badge">' + esc(r.job_status) + '</span>' : ''}</p>` : ''}
    </div>`;
  if (qs('#jrcertify')) qs('#jrcertify').onclick = () => jobRequestSignModal(r, 'certify', () => jobRequestDetail(c, id));
  if (qs('#jrapprove')) qs('#jrapprove').onclick = () => jobRequestSignModal(r, 'approve', () => jobRequestDetail(c, id));
  if (qs('#jrreject')) qs('#jrreject').onclick = () => jobRequestSignModal(r, 'reject', () => jobRequestDetail(c, id));
}

// E-signature modal for Job Request certify / approve / reject.
function jobRequestSignModal(jr, action, onDone) {
  const meta = {
    certify: { title: 'Certify Job Request', verb: 'certify', btn: 'Sign & Certify' },
    approve: { title: 'Approve Job Request', verb: 'approve', btn: 'Sign & Approve' },
    reject: { title: 'Reject Job Request', verb: 'reject', btn: 'Reject' },
  }[action];
  const who = esc(ME.fullName || ME.username);
  const withSig = action !== 'reject';
  modal(meta.title + ' — ' + esc(jr.jr_no), `
    <p class="muted">Signing as <b>${who}</b> <span class="badge blue">${esc(ME.roles.join(', '))}</span></p>
    ${action === 'approve' ? '<p class="muted">Approving will create the job card and route it to the workshop.</p>' : ''}
    ${action === 'reject'
      ? field('Reason (required)', 'reason')
      : `<label style="display:flex;gap:8px;align-items:flex-start;font-weight:400"><input type="checkbox" id="confirm" style="width:auto;margin-top:3px"> I, ${who}, ${meta.verb} this job request. This records my e-signature and time.</label>
         <label>Signature</label>${signaturePadHtml('jrsignpad')}
         ${field('Remark (optional)', 'reason')}`}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">${meta.btn}</button></div>`, (body, close) => {
    let pad = null;
    if (withSig) { pad = wireSignaturePad(body, 'jrsignpad', null); (async () => { try { const s = (await api('/auth/signature')).signature; if (s) pad.load(s); } catch (e) { /* no saved sig */ } })(); }
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      if (action !== 'reject' && !qs('#confirm', body).checked) return toast('Tick the confirmation to e-sign', 'err');
      if (action === 'reject' && !String(f.reason || '').trim()) return toast('A reason is required to reject', 'err');
      const signature = (withSig && pad && !pad.isEmpty()) ? pad.dataURL() : undefined;
      const past = { certify: 'certified', approve: 'approved', reject: 'rejected' }[action];
      try {
        const r = await api('/job-requests/' + jr.id + '/' + action, { method: 'POST', body: { reason: f.reason, signature } });
        toast('Job request ' + past + (action === 'approve' && r.job ? ' · job card ' + r.job.job_no + ' created' : (action !== 'reject' ? ' · e-signed' : '')));
        close(); onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function newJobRequestModal() {
  let nextNo = '';
  try { nextNo = (await api('/job-requests/numbers')).next_jr; } catch (e) { /* leave blank -> auto */ }
  let projects = [];
  try { projects = await api('/projects'); } catch (e) { /* optional */ }
  const projOpts = [{ value: '', label: '—' }].concat(projects.map((p) => ({ value: p.id, label: p.name })));
  modal('New Job Request', `
    <div class="row">${field('JR Number (edit to override)', 'jr_no', { value: nextNo })}${field('Date', 'req_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}</div>
    <p class="muted" style="font-size:12px;margin:0 0 4px">Continues from the last number (${esc(nextNo || 'auto')}). Change it to set a specific number.</p>
    ${assetPickerHtml('Vehicle / Machine (search & select) *')}
    <div class="row">${field('Type', 'type', { type: 'select', options: [{ value: 'repair', label: 'Repair' }, { value: 'service', label: 'Service' }] })}${field('Severity', 'severity', { type: 'select', options: [{ value: '', label: '—' }, { value: 'major', label: 'Major' }, { value: 'minor', label: 'Minor' }] })}</div>
    <div class="row">${field('Priority', 'priority', { type: 'select', options: [{ value: 'normal', label: 'Normal' }, { value: 'urgent', label: 'Urgent' }] })}${field('Required date', 'required_date', { type: 'date' })}</div>
    ${field('Project', 'project_id', { type: 'select', options: projOpts })}
    ${field('Work requested *', 'description', { type: 'textarea' })}
    ${field('Requested by', 'requested_by')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create Job Request</button></div>`, (body, close) => {
    wireAssetPicker(body);
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      if (!String(d.description || '').trim()) return toast('Describe the work requested', 'err');
      if (!d.asset && !d.asset_id) return toast('Pick the vehicle / machine', 'err');
      try {
        const r = await api('/job-requests', { method: 'POST', body: d });
        close();
        if (r.unresolved) toast('Job request created — vehicle "' + r.unresolved.raw + '" queued in the Alias Queue', 'err');
        else toast('Job request ' + r.request.jr_no + ' created');
        location.hash = '#/jobrequests/' + r.request.id;
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
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="ntop">⛽ Issue / Top-up</button><button class="sm" id="np">+ New Product</button><button class="sm" id="nl">+ Ledger Txn</button></div>' : ''}
      ${tableWrap([{ label: 'Code' }, { label: 'Name' }, { label: 'Unit' }, { label: 'Category' }, { label: 'Balance', num: true }, { label: 'Reorder', num: true }, { label: 'Unit Price', num: true }],
        list.map((p) => `<tr><td>${esc(p.code || '')}</td><td>${esc(p.name)}</td><td>${esc(p.unit)}</td><td>${esc(p.category || '')}</td><td class="num ${p.current_balance <= p.reorder_level ? '' : ''}">${p.current_balance <= p.reorder_level && p.reorder_level > 0 ? `<span class="badge amber">${num(p.current_balance)}</span>` : num(p.current_balance)}</td><td class="num">${num(p.reorder_level)}</td><td class="num">${money(p.unit_price)}</td></tr>`), { scroll: true })}`;
    if (qs('#np')) qs('#np').onclick = () => simpleCreateModal('New Product', '/oil/products', [['Code', 'code'], ['Name *', 'name'], ['Unit (L/kg/nos)', 'unit'], ['Category', 'category'], ['Reorder level', 'reorder_level', 'number'], ['Unit price', 'unit_price', 'number']]);
    if (qs('#nl')) qs('#nl').onclick = () => newLedgerModal(list);
    if (qs('#ntop')) qs('#ntop').onclick = () => oilTopupModal(list);
  } else if (tab === 'ledger') {
    const list = await api('/oil/ledger');
    const svcRef = (l) => { const m = String(l.note || '').match(/Service record #(\d+)/); return m ? m[1] : null; };
    body.innerHTML = `<p class="muted" style="margin-top:0">Issues tagged <span class="badge blue">Service</span> are consumed by a service record — their <b>cost is counted in that service</b>, not here (stock-out only, to avoid double-counting).</p>` +
      tableWrap([{ label: 'Date' }, { label: 'Product' }, { label: 'Kind' }, { label: 'Qty', num: true }, { label: 'Balance', num: true }, { label: 'Unit Price', num: true }, { label: 'Asset' }, { label: 'Reference' }],
      list.map((l) => { const sid = svcRef(l); return `<tr${sid ? ' style="background:rgba(46,120,210,.05)"' : ''}><td>${esc(l.txn_date)}</td><td>${esc(l.product_name)}</td><td><span class="badge ${l.kind === 'issue' ? 'amber' : 'green'}">${esc(l.kind)}</span></td><td class="num">${num(l.qty)}</td><td class="num">${num(l.balance_after)}</td><td class="num">${sid ? '<span class="muted">' + money(l.unit_price) + '</span>' : money(l.unit_price)}</td><td>${esc(l.asset_code || '')}</td><td>${sid ? `<a href="#/filters/service/${sid}"><span class="badge blue">Service #${sid}</span></a>` : esc(l.consumer || l.note || '')}</td></tr>`; }), { scroll: true });
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

// Issue lubricant — General store use OR a machine/vehicle top-up (against a job card).
async function oilTopupModal(products) {
  modal('Issue / Top-up Lubricant', `
    ${targetPickerHtml('oilt', { label: 'Issue for', generalLabel: 'General / store use' })}
    <div class="row">${field('Product', 'product_id', { type: 'select', options: products.map((p) => ({ value: p.id, label: p.name + ' (' + p.unit + ')' })) })}${field('Qty', 'qty', { type: 'number', value: 1 })}</div>
    <div class="row">${field('Date', 'txn_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}${field('Unit price (blank = auto)', 'unit_price', { type: 'number' })}</div>
    ${field('Note (e.g. oil top-up)', 'note')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Issue</button></div>`, (body, close) => {
    const getTarget = wireTargetPicker(body, 'oilt');
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      if (!f.qty || Number(f.qty) <= 0) return toast('Enter a quantity', 'err');
      const t = getTarget();
      if (t.type === 'vehicle' && !t.job_id) return toast('Pick the machine/vehicle job card', 'err');
      try {
        await api('/oil/ledger', { method: 'POST', body: { ...f, kind: 'issue', job_id: t.type === 'vehicle' ? t.job_id : undefined } });
        toast(t.type === 'vehicle' ? 'Lubricant issued to ' + (t.asset_code || 'vehicle') : 'General lubricant issue posted');
        close(); render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

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
      <div class="spacer"></div>${canEdit('batteries') ? '<button class="primary" id="nb">+ Add Battery</button>' : ''}
    </div>
    ${radar.expiring.length ? `<div class="card section"><h3>Warranty expiring ≤60 days</h3>${radar.expiring.map((b) => `<div class="cost-line"><a href="#/batteries/${b.id}">${esc(b.serial_no)}</a><span class="badge amber">${esc(b.warranty_date)} · ${esc(b.current_asset_code || 'store')}</span></div>`).join('')}</div>` : ''}
    ${tableWrap([{ label: 'Serial' }, { label: 'Brand' }, { label: 'Ah', num: true }, { label: 'State' }, { label: 'Current Asset' }, { label: 'Warranty' }],
      list.map((b) => `<tr><td>${b.has_photo ? '📷 ' : ''}<a href="#/batteries/${b.id}">${esc(b.serial_no)}</a></td><td>${esc(b.brand || '')}</td><td class="num">${b.capacity_ah || ''}</td><td><span class="badge ${b.state === 'installed' ? 'green' : b.state === 'decommissioned' ? 'red' : ''}">${esc(b.state)}</span></td><td>${esc(b.current_asset_code || '—')}</td><td>${esc(b.warranty_date || '')}</td></tr>`), { scroll: true })}`;
  qs('#bwbtn').onclick = async () => { const s = qs('#bwhere').value.trim(); if (!s) return; try { const r = await api('/batteries/whereis/' + encodeURIComponent(s)); toast(s + ' → ' + (r.current_asset ? r.current_asset.code : 'in store') + ' (' + r.battery.state + ')'); } catch { toast('Serial not found', 'err'); } };
  if (qs('#nb')) qs('#nb').onclick = newBatteryModal;
};

function newBatteryModal() {
  modal('Add Battery', `
    <div class="row">${field('Serial No *', 'serial_no')}${field('Brand', 'brand')}</div>
    <div class="row">${field('Capacity Ah', 'capacity_ah', { type: 'number' })}${field('Condition', 'condition', { type: 'select', options: [{ value: 'new', label: 'new' }, { value: 'old', label: 'old' }] })}</div>
    <div class="row">${field('Purchase date', 'purchase_date', { type: 'date' })}${field('Warranty date', 'warranty_date', { type: 'date' })}</div>
    ${field('Install on asset (code/text)', 'current_asset')}
    <label>Battery photo</label>${imageUploadHtml('batimg')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add Battery</button></div>`, (body, close) => {
    const up = wireImageUpload(body, 'batimg');
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      if (!String(d.serial_no || '').trim()) return toast('Serial No is required', 'err');
      d.photo_path = up.dataURL() || undefined;
      try { await api('/batteries', { method: 'POST', body: d }); toast('Battery added'); close(); render(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function batteryDetail(c, id) {
  const b = await api('/batteries/' + id);
  const bat = b.battery;
  const editable = canEdit('batteries');
  c.innerHTML = `${pageHeader(bat.serial_no, '<a href="#/batteries">← Batteries</a>')}
    <div class="toolbar"><span class="badge ${bat.state === 'installed' ? 'green' : bat.state === 'decommissioned' ? 'red' : ''}">${esc(bat.state)}</span>
      <span class="muted">${esc(bat.brand || '')} · ${bat.capacity_ah || '?'}Ah · ${esc(bat.current_asset_code || 'in store')}</span>
      <div class="spacer"></div>${editable ? `<button class="sm" id="photo">📷 ${bat.photo_path ? 'Change' : 'Add'} photo</button><button class="sm" id="ev">+ Event</button>` : ''}</div>
    <div class="grid section">
      <div class="card"><h3>Photo</h3>
        ${bat.photo_path ? `<img src="${bat.photo_path}" alt="Battery ${esc(bat.serial_no)}" style="max-width:100%;max-height:280px;border:1px solid var(--border);border-radius:8px">` : `<p class="muted">No photo yet.${editable ? ' Use “Add photo”.' : ''}</p>`}</div>
      <div class="card"><h3>Details</h3>
        <div class="cost-line"><span>Serial</span><span>${esc(bat.serial_no)}</span></div>
        <div class="cost-line"><span>Brand</span><span>${esc(bat.brand || '—')}</span></div>
        <div class="cost-line"><span>Capacity</span><span>${bat.capacity_ah || '?'} Ah</span></div>
        <div class="cost-line"><span>Condition</span><span>${esc(bat.condition || '—')}</span></div>
        <div class="cost-line"><span>Purchase date</span><span>${esc(bat.purchase_date || '—')}</span></div>
        <div class="cost-line"><span>Warranty date</span><span>${esc(bat.warranty_date || '—')}</span></div>
        <div class="cost-line"><span>Current asset</span><span>${esc(bat.current_asset_code || 'in store')}</span></div>
      </div>
    </div>
    <div class="card"><h3>Event History</h3>
      ${tableWrap([{ label: 'Date' }, { label: 'Event' }, { label: 'From' }, { label: 'To' }, { label: 'Reason' }, { label: 'MTN' }, { label: 'Photo' }],
        b.events.map((e) => `<tr><td>${esc(e.event_date)}</td><td><span class="badge">${esc(e.event_type)}</span></td><td>${esc(e.from_asset_code || '')}</td><td>${esc(e.to_asset_code || '')}</td><td>${esc(e.reason || '')}</td><td>${esc(e.mtn_ref || '')}</td><td>${e.photo_path ? `<a href="${e.photo_path}" target="_blank"><img src="${e.photo_path}" style="height:38px;border:1px solid var(--border);border-radius:4px"></a>` : ''}</td></tr>`))}</div>`;
  if (qs('#photo')) qs('#photo').onclick = () => modal((bat.photo_path ? 'Change' : 'Add') + ' battery photo — ' + bat.serial_no, `
    <label>Battery photo</label>${imageUploadHtml('bpimg', bat.photo_path)}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save photo</button></div>`,
    (body, close) => {
      const up = wireImageUpload(body, 'bpimg', bat.photo_path);
      qs('#s', body).onclick = async () => {
        try { await api(`/batteries/${id}/photo`, { method: 'PATCH', body: { photo_path: up.dataURL() || null } }); toast('Photo saved'); close(); batteryDetail(c, id); }
        catch (e) { toast(e.message, 'err'); }
      };
    });
  if (qs('#ev')) qs('#ev').onclick = () => modal('Battery Event', `
    ${field('Event', 'event_type', { type: 'select', options: ['install', 'transfer', 'return', 'warranty', 'decommission'].map((v) => ({ value: v, label: v })) })}
    ${field('To asset (code/text)', 'to_asset')}${field('Reason', 'reason')}${field('MTN ref', 'mtn_ref')}${field('Date', 'event_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}
    <label>Photo (optional evidence)</label>${imageUploadHtml('evimg')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Record</button></div>`,
    (body, close) => {
      const up = wireImageUpload(body, 'evimg');
      qs('#s', body).onclick = async () => {
        const d = formData(body); d.photo_path = up.dataURL() || undefined;
        try { await api(`/batteries/${id}/event`, { method: 'POST', body: d }); close(); batteryDetail(c, id); }
        catch (e) { toast(e.message, 'err'); }
      };
    });
}

// ---- Filters & Prices — the filter price book + service records -------------
routes.filters = async (c, params) => {
  if (params[0] === 'new-service') return renderNewServiceForm(c);
  if (params[0] === 'service' && params[1]) return serviceDetail(c, params[1]);
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = ['services', 'xref'].includes(sp.get('tab')) ? sp.get('tab') : 'book';
  c.innerHTML = `${pageHeader('Filters & Prices', 'Price book · service records · cross-references (VIC / Sakura / HIFI and the SL market).')}
    <div class="pill-row" style="margin-bottom:12px">
      <button class="btn sm ${tab === 'book' ? 'primary' : ''}" id="tb-book">Price Book</button>
      <button class="btn sm ${tab === 'services' ? 'primary' : ''}" id="tb-svc">Service Records</button>
      <button class="btn sm ${tab === 'xref' ? 'primary' : ''}" id="tb-xref">Cross-References</button>
    </div>
    <div id="fpane"><div class="muted">Loading…</div></div>`;
  qs('#tb-book').onclick = () => { location.hash = '#/filters?tab=book'; };
  qs('#tb-svc').onclick = () => { location.hash = '#/filters?tab=services'; };
  qs('#tb-xref').onclick = () => { location.hash = '#/filters?tab=xref'; };
  if (tab === 'services') await renderServiceRecords(qs('#fpane'));
  else if (tab === 'xref') await renderCrossRefs(qs('#fpane'));
  else await renderPriceBook(qs('#fpane'));
};

function filterPriceModal(filterNo, category, value, cats, onDone) {
  const isNew = !filterNo;
  modal(isNew ? 'Add filter number' : 'Price — ' + filterNo, `
    ${isNew ? field('Filter number *', 'filter_no') : `<p class="muted">Filter <b>${esc(filterNo)}</b></p><input type="hidden" name="filter_no" value="${esc(filterNo)}">`}
    ${field('Category', 'category', { type: 'select', options: [{ value: '', label: '—' }].concat((cats || []).map((x) => ({ value: x, label: x }))), value: category || '' })}
    ${field('Unit price (LKR)', 'unit_price', { type: 'number', value: value || '' })}
    ${isNew ? '<p class="muted" style="font-size:12px">Saved to the price book — this number will auto-price on future services.</p>' : ''}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save price</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      if (isNew && !String(d.filter_no || '').trim()) return toast('Enter a filter number', 'err');
      try { await api('/filters/prices', { method: 'POST', body: { filter_no: d.filter_no, category: d.category || undefined, unit_price: d.unit_price } }); toast('Price saved'); close(); onDone(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- Cross-References (VIC / Sakura / HIFI … for the Sri Lankan market) ------
const XREF_HOT = (b) => /^(vic|sakura)$/i.test(b || ''); // the brands you buy — highlighted

function xrefResultHtml(r, editable) {
  const cat = r.catalogue || {};
  const rows = r.crossRefs.map((x) => `<tr${XREF_HOT(x.brand) ? ' style="background:rgba(224,168,0,.08)"' : ''}>
      <td>${x.brand ? `<span class="badge ${XREF_HOT(x.brand) ? 'amber' : ''}">${esc(x.brand)}</span>` : ''}</td>
      <td><b>${esc(x.part_number)}</b></td>
      <td><span class="muted">${esc(x.ref_type || '')}</span></td>
      <td class="num">${x.price ? money(x.price) : '—'}</td>
      <td>${x.source === 'manual' ? '<span class="badge blue">added</span>' : x.source === 'research' ? '<span class="badge">researched</span>' : ''}</td></tr>`);
  return `<div class="card">
    <div class="toolbar" style="margin:0"><h3 style="margin:0">${esc(cat.category || 'Filter')} <span class="muted" style="font-weight:400">— ${r.crossRefs.length} equivalent${r.crossRefs.length === 1 ? '' : 's'}</span></h3><div class="spacer"></div>${editable ? '<button class="sm primary" id="xaddbtn">+ Add cross-ref</button>' : ''}</div>
    <p class="muted">OEM <b>${esc(cat.oem_pn || '—')}</b> · HIFI <b>${esc(cat.hifi_pn || '—')}</b>${cat.top_vehicle ? ' · fits ' + esc(cat.top_vehicle) : ''}${cat.fleet_types ? ' · ' + esc(cat.fleet_types) : ''}</p>
    ${tableWrap([{ label: 'Brand' }, { label: 'Part Number' }, { label: 'Type' }, { label: 'Price', num: true }, { label: '' }], rows, { scroll: true })}
    ${cat.description ? `<p class="muted" style="font-size:12px;margin-top:8px">${esc(cat.description)}</p>` : ''}</div>`;
}

function xrefAddModal(catalogueId, cat, onDone) {
  modal('Add cross-reference' + (cat && cat.category ? ' — ' + cat.category : ''), `
    <p class="muted">Add an equivalent part number you've confirmed at a supplier (e.g. a VIC or Sakura number).</p>
    ${field('Brand', 'brand', { type: 'select', options: ['VIC', 'Sakura', 'HIFI', 'Fleetguard', 'Donaldson', 'Baldwin', 'Bosch', 'Mann', 'Genuine', 'Other'].map((b) => ({ value: b, label: b })) })}
    ${field('Part number *', 'part_number')}
    ${field('Note (optional)', 'note')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add cross-reference</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      if (!String(d.part_number || '').trim()) return toast('Enter a part number', 'err');
      try { await api('/filters/xref', { method: 'POST', body: { catalogue_id: catalogueId, brand: d.brand, part_number: d.part_number, note: d.note } }); toast('Cross-reference added'); close(); onDone(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function renderCrossRefs(c) {
  const editable = canEdit('filters');
  c.innerHTML = `
    <div class="pill-row" style="margin-bottom:10px">
      <button class="btn sm primary" id="m-no">By Filter No</button>
      <button class="btn sm" id="m-veh">By Vehicle</button>
    </div>
    <div id="xrbody"></div>`;
  qs('#m-no', c).onclick = () => { qs('#m-no', c).classList.add('primary'); qs('#m-veh', c).classList.remove('primary'); xrefByNo(qs('#xrbody', c), editable); };
  qs('#m-veh', c).onclick = () => { qs('#m-veh', c).classList.add('primary'); qs('#m-no', c).classList.remove('primary'); xrefByVehicle(qs('#xrbody', c), editable); };
  xrefByNo(qs('#xrbody', c), editable);
}

function xrefByNo(c, editable) {
  c.innerHTML = `<div class="card"><label>Filter part number <span class="muted" style="font-weight:400">— any brand (OEM · HIFI · VIC · Sakura · Fleetguard …)</span></label>
    <div style="display:flex;gap:8px;margin-top:4px"><input id="xq" type="search" placeholder="e.g. SO 10058 · 252718130145 · C-115" style="flex:1"><button class="primary sm" id="xgo">Find equivalents</button></div></div>
    <div id="xres"></div>`;
  const lookup = async () => {
    const no = qs('#xq', c).value.trim(); if (!no) return;
    let r; try { r = await api('/filters/xref/lookup?no=' + encodeURIComponent(no)); } catch (e) { toast(e.message, 'err'); return; }
    const res = qs('#xres', c);
    if (!r.found) { res.innerHTML = `<div class="card"><p class="muted">No cross-reference on record for <b>${esc(no)}</b>.</p></div>`; return; }
    res.innerHTML = xrefResultHtml(r, editable);
    const add = qs('#xaddbtn', res); if (add) add.onclick = () => xrefAddModal(r.catalogue.id, r.catalogue, lookup);
  };
  qs('#xgo', c).onclick = lookup;
  qs('#xq', c).onkeydown = (e) => { if (e.key === 'Enter') lookup(); };
}

function xrefByVehicle(c, editable) {
  c.innerHTML = `<div class="card">${assetPickerHtml('Vehicle / Machine (search & select)')}</div><div id="xvres"></div>`;
  wireAssetPicker(c);
  c.addEventListener('mousedown', (e) => {
    const it = e.target.closest && e.target.closest('.apick-item');
    if (it && it.dataset.id) setTimeout(() => showVeh(it.dataset.id), 80);
  }, true);
  const showVeh = async (id) => {
    let r; try { r = await api('/filters/xref/vehicle/' + id); } catch (e) { return; }
    const res = qs('#xvres', c);
    res.innerHTML = `<div class="card"><h3>${esc(idLabel(r.asset) || (r.asset && r.asset.code) || 'Vehicle')} — filters used <span class="muted" style="font-weight:400">(${r.filters.length})</span></h3>
      ${r.filters.length ? tableWrap([{ label: 'Filter No' }, { label: 'Category' }, { label: 'Uses', num: true }, { label: 'Brands available' }, { label: '' }],
        r.filters.map((f) => `<tr><td><b>${esc(f.filter_no)}</b></td><td>${esc(f.category || '')}</td><td class="num">${f.uses}</td><td>${f.brands.map((b) => `<span class="badge ${XREF_HOT(b) ? 'amber' : ''}">${esc(b)}</span>`).join(' ') || '<span class="muted">—</span>'}</td><td>${f.catalogue_id ? `<button class="sm" data-cid="${f.catalogue_id}">View refs</button>` : '<span class="muted">no refs</span>'}</td></tr>`), { scroll: true }) : '<p class="muted">No filters recorded for this vehicle yet.</p>'}</div>
      <div id="xvdetail"></div>`;
    qsa('[data-cid]', res).forEach((b) => b.onclick = async () => {
      const r2 = await api('/filters/xref/catalogue/' + b.dataset.cid);
      const detail = qs('#xvdetail', res);
      detail.innerHTML = xrefResultHtml({ catalogue: r2.catalogue, crossRefs: r2.crossRefs, found: true }, editable);
      const add = qs('#xaddbtn', detail); if (add) add.onclick = () => xrefAddModal(r2.catalogue.id, r2.catalogue, () => b.onclick());
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };
}

async function renderPriceBook(c) {
  const editable = canEdit('filters');
  const cats = await api('/filters/categories').catch(() => []);
  c.innerHTML = `
    <div class="grid section">
      <div class="card stat"><span class="n" id="st-total">—</span><span class="l">Filter Numbers</span></div>
      <div class="card stat"><span class="n" id="st-priced">—</span><span class="l">Priced</span></div>
      <div class="card stat" style="border-left:3px solid var(--amber)"><span class="n" id="st-missing">—</span><span class="l">Missing Price</span></div>
    </div>
    <div class="toolbar">
      ${editable ? '<button class="primary" id="addf">+ Add filter number</button>' : ''}
      <input id="fq" type="search" placeholder="Search filter no / category…" style="max-width:260px">
      <label style="display:flex;gap:6px;align-items:center;flex-direction:row;width:auto"><input type="checkbox" id="fmiss" style="width:auto"> Missing price only</label>
      <div class="spacer"></div><span class="muted" id="fcount"></span>
    </div>
    <div id="ftable"><div class="muted">Loading…</div></div>`;
  const refreshStats = async () => {
    try { const s = await api('/filters/stats'); qs('#st-total').textContent = num(s.total); qs('#st-priced').textContent = num(s.priced); qs('#st-missing').textContent = num(s.missing); } catch (e) { /* ignore */ }
  };
  const load = async () => {
    const q = qs('#fq').value.trim(), miss = qs('#fmiss').checked ? '1' : '';
    const list = await api('/filters/prices?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + (miss ? 'missing=1&' : '') + 'limit=1000');
    qs('#fcount').textContent = `${list.length} filter${list.length === 1 ? '' : 's'}`;
    qs('#ftable').innerHTML = tableWrap(
      [{ label: 'Filter No' }, { label: 'Category' }, { label: 'Uses', num: true }, { label: 'Unit Price (LKR)', num: true }].concat(editable ? [{ label: '' }] : []),
      list.map((f) => `<tr${f.has_price ? '' : ' style="background:rgba(224,168,0,.06)"'}>
        <td><b>${esc(f.filter_no)}</b>${f.notes ? `<br><span class="muted" style="font-size:11px" title="${esc(f.notes)}">${esc(String(f.notes).slice(0, 60))}${String(f.notes).length > 60 ? '…' : ''}</span>` : ''}</td>
        <td>${esc(f.category || '—')}</td>
        <td class="num">${num(f.uses)}</td>
        <td class="num">${f.has_price ? money(f.unit_price) + (f.source && f.source !== 'manual' && f.source !== 'import' ? ` <span class="muted" style="font-size:10px">(${esc(f.source)})</span>` : '') : '<span class="badge amber">no price</span>'}</td>
        ${editable ? `<td class="num"><button class="sm ${f.has_price ? '' : 'primary'}" data-price="${esc(f.filter_no)}" data-cat="${esc(f.category || '')}" data-val="${f.unit_price == null ? '' : f.unit_price}">${f.has_price ? 'Edit' : 'Add price'}</button></td>` : ''}
      </tr>`), { scroll: true });
    qsa('[data-price]', c).forEach((b) => b.onclick = () => filterPriceModal(b.dataset.price, b.dataset.cat, b.dataset.val, cats, async () => { await load(); await refreshStats(); }));
  };
  if (qs('#addf')) qs('#addf').onclick = () => filterPriceModal('', '', '', cats, async () => { await load(); await refreshStats(); });
  let deb; qs('#fq').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#fmiss').onchange = load;
  await refreshStats();
  await load();
}

async function renderServiceRecords(c) {
  const editable = canEdit('filters');
  c.innerHTML = `<div class="toolbar">${editable ? '<button class="primary" id="nsvc">+ New Service</button>' : ''}<input id="sq" type="search" placeholder="Search vehicle / site / type…" style="max-width:280px"><div class="spacer"></div><span class="muted" id="scount"></span></div>
    <div id="stable"><div class="muted">Loading…</div></div>`;
  const load = async () => {
    const q = qs('#sq').value.trim();
    const list = await api('/filters/services?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + 'limit=500');
    qs('#scount').textContent = `${list.length} service${list.length === 1 ? '' : 's'}`;
    qs('#stable').innerHTML = tableWrap(
      [{ label: 'Date' }, { label: 'Vehicle' }, { label: 'Type' }, { label: 'Site' }, { label: 'Filters', num: true }, { label: 'Missing', num: true }, { label: 'Cost', num: true }],
      list.map((s) => `<tr data-svc="${s.id}" style="cursor:pointer">
        <td>${esc((s.service_date || '').slice(0, 10))}</td>
        <td>${esc(idLabel(s) || s.vehicle_label || '—')}</td>
        <td>${esc(s.service_type || '')}</td>
        <td>${esc(s.site_location || '')}</td>
        <td class="num">${num(s.filter_count)}</td>
        <td class="num">${s.missing_count > 0 ? `<span class="badge amber">${num(s.missing_count)}</span>` : '<span class="badge green">0</span>'}</td>
        <td class="num">${money(s.computed_cost)}</td></tr>`), { scroll: true });
    qsa('[data-svc]', c).forEach((tr) => tr.onclick = () => { location.hash = '#/filters/service/' + tr.dataset.svc; });
  };
  if (qs('#nsvc')) qs('#nsvc').onclick = () => { location.hash = '#/filters/new-service'; };
  let deb; qs('#sq').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  await load();
}

// Full "Vehicle / Machinery Service Details" form — matches the paper layout.
async function renderNewServiceForm(c) {
  const today = new Date().toISOString().slice(0, 10);
  const ref = await api('/filters/reference');
  const oilTypeOpts = '<option value="">—</option>' + ref.oilTypes.map((t) => `<option value="${esc(t.code)}" data-price="${t.unit_price}">${esc(t.code)}</option>`).join('');
  const oilRows = ref.oils.map((o) => `<tr>
      <td>${esc(o.name)}<input type="hidden" class="o_name" value="${esc(o.name)}"></td>
      <td><select class="o_type" style="width:100%">${oilTypeOpts}</select></td>
      <td><select class="o_cv" style="width:56px"><option value=""></option><option>C</option><option>V</option></select></td>
      <td><input type="number" class="o_lit" style="width:64px" step="0.1"></td>
      <td><input type="number" class="o_price" style="width:96px"></td></tr>`).join('');
  const filterRows = ref.filterCategories.map((cat) => `<tr>
      <td>${esc(cat)}<input type="hidden" class="f_cat" value="${esc(cat)}"></td>
      <td><input type="text" class="f_no" style="width:120px"></td>
      <td><input type="number" class="f_qty" value="1" style="width:48px"></td>
      <td><select class="f_xe" style="width:52px"><option value=""></option><option>X</option><option>E</option></select></td>
      <td><input type="number" class="f_price" style="width:96px"></td></tr>`).join('');
  c.innerHTML = `${pageHeader('Vehicle / Machinery Service Details', '<a href="#/filters?tab=services">← Service Records</a>')}
    <div class="card">
      <div class="row">${assetPickerHtml('Vehicle / Machine (search & select) *')}${field('Date', 'service_date', { type: 'date', value: today })}</div>
      <div class="grid" style="grid-template-columns:1fr 1fr 1fr">
        ${field('Reg. ID', 'reg_id')}${field('E&C Code', 'ec_code_disp')}${field('Model', 'model_no')}
        ${field('Job / Service No.', 'job_no')}${field('Meter Reading', 'meter_reading')}${field('Next Service at', 'next_service_meter')}
        ${field('Service Type', 'service_type', { placeholder: 'e.g. 5000 Hrs' })}${field('Location (Site)', 'site_location')}${field('Up-keeping', 'upkeeping', { type: 'select', options: [{ value: '', label: '—' }, { value: 'Good', label: 'Good (G)' }, { value: 'Fair', label: 'Fair (F)' }, { value: 'Bad', label: 'Bad (B)' }] })}
      </div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
      <div class="card"><h3 style="margin-top:0">Oils / Lubricants</h3>
        <div class="table-wrap scroll"><table><thead><tr><th>Oil Name</th><th>Type</th><th>C/V</th><th>Liters</th><th>Price</th></tr></thead>
          <tbody id="oilBody">${oilRows}</tbody></table></div></div>
      <div class="card"><h3 style="margin-top:0">Filters <span class="muted" style="font-weight:400;font-size:12px">— No. auto-prices from the book</span></h3>
        <div class="table-wrap scroll"><table><thead><tr><th>Filter</th><th>Filter No.</th><th>Qty</th><th>X/E</th><th>Price</th></tr></thead>
          <tbody id="filterBody">${filterRows}</tbody></table></div></div>
    </div>
    <div class="card"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Other Costs (parts, consumables)</h3><div class="spacer"></div><button type="button" class="sm" id="addpart">+ line</button></div>
      <div class="table-wrap"><table><thead><tr><th>Description</th><th>Unit</th><th>Rate</th><th>Qty</th><th>Amount</th></tr></thead><tbody id="partBody"></tbody></table></div></div>
    <div class="grid" style="grid-template-columns:2fr 1fr;align-items:start">
      <div class="card"><h3 style="margin-top:0">Repair / Service Details</h3>${field('', 'repair_details', { type: 'textarea' })}</div>
      <div class="card"><h3 style="margin-top:0">Totals</h3>
        <div class="cost-line"><span>Parts Subtotal</span><span id="t_parts">Rs 0.00</span></div>
        <div class="cost-line"><span>Labour Charge (<input type="number" id="labourRate" value="${ref.labourRate}" style="width:48px">%)</span><span id="t_labour">Rs 0.00</span></div>
        <div class="cost-line"><span>Sundry (<input type="number" id="sundryRate" value="${ref.sundryRate}" style="width:44px">%)</span><span id="t_sundry">Rs 0.00</span></div>
        <div class="cost-line total"><span><b>Grand Total</b></span><span id="t_grand"><b>Rs 0.00</b></span></div>
        <div style="margin-top:12px;text-align:right"><a class="btn sm" href="#/filters?tab=services">Cancel</a> <button class="primary" id="saveService">Create Service</button></div>
      </div>
    </div>`;
  wireAssetPicker(c);
  // Fill Reg/E&C/Model when a vehicle is picked.
  c.addEventListener('mousedown', (e) => {
    const it = e.target.closest && e.target.closest('.apick-item');
    if (it && it.dataset.id) setTimeout(async () => {
      try { const a = (await api('/assets/' + it.dataset.id)).asset; if (a) { qs('[name=reg_id]', c).value = a.registration || ''; qs('[name=ec_code_disp]', c).value = a.ec_code || ''; qs('[name=model_no]', c).value = a.model_no || ''; } } catch (err) { /* ignore */ }
    }, 80);
  }, true);
  const money0 = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const recalc = () => {
    let sub = 0;
    qsa('#oilBody tr', c).forEach((tr) => { sub += Number(qs('.o_price', tr).value) || 0; });
    qsa('#filterBody tr', c).forEach((tr) => { sub += (Number(qs('.f_price', tr).value) || 0) * (Number(qs('.f_qty', tr).value) || 1); });
    qsa('#partBody tr', c).forEach((tr) => { sub += Number(qs('.p_amount', tr).value) || 0; });
    const lr = Number(qs('#labourRate', c).value) || 0, sr = Number(qs('#sundryRate', c).value) || 0;
    const lab = sub * lr / 100, sun = sub * sr / 100;
    qs('#t_parts', c).textContent = money0(sub);
    qs('#t_labour', c).textContent = money0(lab);
    qs('#t_sundry', c).textContent = money0(sun);
    qs('#t_grand', c).innerHTML = '<b>' + money0(sub + lab + sun) + '</b>';
  };
  // Oil rows: type auto-fills unit price; liters × unit price → line price.
  qsa('#oilBody tr', c).forEach((tr) => {
    const typeSel = qs('.o_type', tr), lit = qs('.o_lit', tr), price = qs('.o_price', tr);
    const fill = () => { const up = Number(typeSel.selectedOptions[0] && typeSel.selectedOptions[0].dataset.price) || 0; if (up && lit.value) price.value = Math.round(up * Number(lit.value) * 100) / 100; recalc(); };
    typeSel.onchange = fill; lit.oninput = fill; price.oninput = recalc;
  });
  // Filter rows: number blur → book price.
  qsa('#filterBody tr', c).forEach((tr) => {
    const noIn = qs('.f_no', tr), price = qs('.f_price', tr);
    noIn.onblur = async () => { const v = noIn.value.trim(); if (!v || price.value) return; try { const r = await api('/filters/prices/lookup?no=' + encodeURIComponent(v)); if (r.found && r.unit_price != null) { price.value = r.unit_price; recalc(); } } catch (e) { /* ignore */ } };
    price.oninput = recalc; qs('.f_qty', tr).oninput = recalc;
  });
  const addPart = () => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="text" class="p_desc" style="width:100%"></td><td><input type="text" class="p_unit" style="width:60px"></td><td><input type="number" class="p_rate" style="width:80px"></td><td><input type="number" class="p_qty" style="width:56px"></td><td><input type="number" class="p_amount" style="width:96px"></td>`;
    qs('#partBody', c).appendChild(tr);
    const rate = qs('.p_rate', tr), qty = qs('.p_qty', tr), amt = qs('.p_amount', tr);
    const calc = () => { if (rate.value && qty.value) amt.value = Math.round(Number(rate.value) * Number(qty.value) * 100) / 100; recalc(); };
    rate.oninput = calc; qty.oninput = calc; amt.oninput = recalc;
  };
  qs('#addpart', c).onclick = addPart; addPart();
  qs('#labourRate', c).oninput = recalc; qs('#sundryRate', c).oninput = recalc;
  qs('#saveService', c).onclick = async () => {
    const assetInput = qs('.apick-input', c), assetId = qs('input[name=asset_id]', c).value;
    if (!assetInput.value && !assetId) return toast('Pick the vehicle / machine', 'err');
    const oils = qsa('#oilBody tr', c).map((tr) => ({ oil_name: qs('.o_name', tr).value, oil_type: qs('.o_type', tr).value, cv: qs('.o_cv', tr).value, qty: qs('.o_lit', tr).value, price: qs('.o_price', tr).value })).filter((o) => Number(o.qty) > 0 || Number(o.price) > 0);
    const filters = qsa('#filterBody tr', c).map((tr) => ({ category: qs('.f_cat', tr).value, filter_no: qs('.f_no', tr).value.trim(), qty: qs('.f_qty', tr).value, xe: qs('.f_xe', tr).value, price: qs('.f_price', tr).value })).filter((f) => f.filter_no);
    const parts = qsa('#partBody tr', c).map((tr) => ({ description: qs('.p_desc', tr).value.trim(), unit: qs('.p_unit', tr).value, rate: qs('.p_rate', tr).value, qty: qs('.p_qty', tr).value, amount: qs('.p_amount', tr).value })).filter((p) => p.description);
    const payload = {
      asset: assetInput.value, asset_id: assetId, service_date: qs('[name=service_date]', c).value,
      job_no: qs('[name=job_no]', c).value, reg_id: qs('[name=reg_id]', c).value, model_no: qs('[name=model_no]', c).value,
      meter_reading: qs('[name=meter_reading]', c).value, next_service_meter: qs('[name=next_service_meter]', c).value,
      service_type: qs('[name=service_type]', c).value, site_location: qs('[name=site_location]', c).value,
      upkeeping: qs('[name=upkeeping]', c).value, repair_details: qs('[name=repair_details]', c).value,
      labour_rate: qs('#labourRate', c).value, sundry_rate: qs('#sundryRate', c).value,
      oils, filters, parts,
    };
    try { const r = await api('/filters/services', { method: 'POST', body: payload }); toast('Service recorded' + (r.oil_issues ? ' · ' + r.oil_issues + ' oil issue(s) posted to Lubricants' : '')); location.hash = '#/filters/service/' + r.service.id; }
    catch (e) { toast(e.message, 'err'); }
  };
  recalc();
}

async function serviceDetail(c, id) {
  const d = await api('/filters/services/' + id);
  const s = d.service;
  const editable = canEdit('filters');
  const cats = await api('/filters/categories').catch(() => []);
  const upk = { Good: 'green', Fair: 'amber', Bad: 'red' }[s.upkeeping] || '';
  c.innerHTML = `${pageHeader('Vehicle / Machinery Service Details', '<a href="#/filters?tab=services">← Service Records</a>')}
    <div class="toolbar"><a class="btn sm" href="#/filters?tab=services">← Service Records</a><div class="spacer"></div>
      ${s.upkeeping ? `<span class="badge ${upk}">Up-keeping: ${esc(s.upkeeping)}</span>` : ''}
      <span class="badge amber">Cost ${money(s.computed_cost)}</span>
      <a class="btn sm" href="/api/filters/services/${s.id}/print.html" target="_blank">🖨 Print</a></div>
    <div class="card"><h3 style="margin-top:0">${esc(idLabel(s) || s.vehicle_label || 'Vehicle')}</h3>
      <p class="muted">${esc((s.service_date || '').slice(0, 10))}${s.job_no ? ' · Job ' + esc(s.job_no) : ''}${s.service_type ? ' · type ' + esc(s.service_type) : ''}${s.site_location ? ' · ' + esc(s.site_location) : ''}${s.meter_reading ? ' · meter ' + esc(s.meter_reading) : ''}${s.next_service_meter ? ' · next ' + esc(s.next_service_meter) : ''}</p>
      ${s.repair_details ? `<div style="white-space:pre-wrap;border:1px solid var(--border);border-radius:6px;padding:8px">${esc(s.repair_details)}</div>` : ''}</div>
    <div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
      <div class="card"><h3 style="margin-top:0">Oils / Lubricants <span class="muted" style="font-weight:400">(${d.oils.length})</span></h3>
        ${d.oils.length ? tableWrap([{ label: 'Oil' }, { label: 'Type' }, { label: 'C/V' }, { label: 'Liters', num: true }, { label: 'Price', num: true }],
          d.oils.map((o) => `<tr><td>${esc(o.oil_name || '')}</td><td>${esc(o.oil_type || '')}</td><td>${esc(o.action_type || '')}</td><td class="num">${num(o.qty)}</td><td class="num">${o.price > 0 ? money(o.price) : '—'}</td></tr>`), { scroll: true }) : '<p class="muted">None.</p>'}</div>
      <div class="card"><h3 style="margin-top:0">Filters <span class="muted" style="font-weight:400">(${d.filters.length})</span></h3>
        ${d.filters.length ? tableWrap([{ label: 'Filter No' }, { label: 'Category' }, { label: 'Qty', num: true }, { label: 'X/E' }, { label: 'Price', num: true }].concat(editable ? [{ label: '' }] : []),
          d.filters.map((f) => `<tr${(f.book_price > 0) ? '' : ' style="background:rgba(224,168,0,.06)"'}>
            <td><b>${esc(f.filter_no || '')}</b></td><td>${esc(f.category || '')}</td><td class="num">${num(f.qty)}</td><td>${esc(f.action_type || '')}</td>
            <td class="num">${f.book_price > 0 ? money(f.book_price) : '<span class="badge amber">no price</span>'}</td>
            ${editable ? `<td class="num"><button class="sm ${f.book_price > 0 ? '' : 'primary'}" data-price="${esc(f.filter_no || '')}" data-cat="${esc(f.category || '')}" data-val="${f.book_price == null ? '' : f.book_price}">${f.book_price > 0 ? 'Edit' : 'Add price'}</button></td>` : ''}
          </tr>`), { scroll: true }) : '<p class="muted">None.</p>'}</div>
    </div>
    ${(d.parts && d.parts.length) ? `<div class="card"><h3 style="margin-top:0">Other Costs</h3>
      ${tableWrap([{ label: 'Description' }, { label: 'Unit' }, { label: 'Rate', num: true }, { label: 'Qty', num: true }, { label: 'Amount', num: true }],
        d.parts.map((p) => `<tr><td>${esc(p.description || '')}</td><td>${esc(p.unit || '')}</td><td class="num">${money(p.rate)}</td><td class="num">${num(p.qty)}</td><td class="num">${money(p.amount)}</td></tr>`))}</div>` : ''}
    <div class="grid" style="grid-template-columns:2fr 1fr;align-items:start">
      <div></div>
      <div class="card"><h3 style="margin-top:0">Totals</h3>
        <div class="cost-line"><span>Parts Subtotal</span><span>${money(s.parts_subtotal)}</span></div>
        <div class="cost-line"><span>Labour Charge (${num(s.labour_rate)}%)</span><span>${money(s.labour_charge)}</span></div>
        <div class="cost-line"><span>Sundry (${num(s.sundry_rate)}%)</span><span>${money(s.sundry_amount)}</span></div>
        <div class="cost-line total"><span><b>Grand Total</b></span><span><b>${money(s.grand_total || s.computed_cost)}</b></span></div>
      </div>
    </div>`;
  qsa('[data-price]', c).forEach((b) => b.onclick = () => filterPriceModal(b.dataset.price, b.dataset.cat, b.dataset.val, cats, () => serviceDetail(c, id)));
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
// ---- Monthly Cost Report — manual inputs editor (Tyre/Battery/Fuel/Other/Staff salaries)
// Tyre & Battery are auto-sourced from the issue ledger (see routes.tyrebattery); only these
// three sheets are entered by hand here.
const MRI_SHEETS = [['fuel', 'Fuel'], ['other', 'Other (overhead)'], ['salary', 'Salaries (Staff)']];
const MRI_COLS = {
  fuel: [['vehicle', 'Reg No', 'text'], ['label', 'Machine type', 'text'], ['qty', 'Qty (L)', 'num'], ['rate', 'Fuel rate', 'num'], ['amount2', 'Std rate', 'num']],
  other: [['label', 'Cost type', 'text'], ['project', 'Project / Plant', 'text'], ['amount1', 'Amount', 'num']],
  salary: [['label', 'Name', 'text'], ['qty', 'Qty', 'text'], ['project', 'Project / Plant', 'text'], ['amount1', 'Cost', 'num'], ['amount2', 'Other', 'num']],
};
async function openMonthlyInputs(year, month, onSaved) {
  let data;
  try { data = await api(`/reports/monthly-inputs?year=${year}&month=${month}`); }
  catch (e) { return toast(e.message, 'err'); }
  const state = {};
  for (const [k] of MRI_SHEETS) state[k] = (data.inputs[k] || []).map((r) => ({ ...r }));
  let active = 'fuel';
  const bg = modal(`Monthly inputs — ${MONTH_NAMES[month]} ${year}`, `
    <p class="muted" style="margin-top:0;font-size:12px">Only these five sheets are entered by hand — Repair, Service and the mechanic-hours table are pulled from live data automatically.</p>
    <div class="toolbar" id="mri-tabs" style="margin-top:0">${MRI_SHEETS.map(([k, l]) => `<button class="sm" data-k="${k}">${l}</button>`).join('')}</div>
    <div id="mri-grid"></div>
    <div class="toolbar" style="margin-top:12px">
      <span class="muted" id="mri-note"></span><div class="spacer"></div>
      <button class="sm" id="mri-add">+ Add row</button>
      <button class="primary sm" id="mri-save">Save all &amp; close</button>
    </div>`, (body) => {
    const grid = qs('#mri-grid', body);
    const close = () => bg.remove();
    const paintTabs = () => qsa('#mri-tabs button', body).forEach((b) => b.classList.toggle('primary', b.dataset.k === active));
    const paintGrid = () => {
      const cols = MRI_COLS[active], rows = state[active];
      grid.innerHTML = `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%">
        <thead><tr>${cols.map((cd) => `<th style="text-align:left;padding:4px 6px;border-bottom:2px solid var(--line,#ccc);white-space:nowrap">${esc(cd[1])}</th>`).join('')}<th></th></tr></thead>
        <tbody>${rows.length ? rows.map((r, i) => `<tr data-i="${i}">${cols.map((cd) => `<td style="padding:2px 4px"><input data-f="${cd[0]}" type="${cd[2] === 'num' ? 'number' : (cd[2] === 'date' ? 'date' : 'text')}" value="${esc(r[cd[0]] ?? '')}" style="width:${cd[2] === 'num' ? '92px' : (cd[2] === 'date' ? '132px' : '120px')}"></td>`).join('')}<td style="padding:2px 4px"><button class="sm mri-del" data-i="${i}" title="Remove row">✕</button></td></tr>`).join('') : `<tr><td colspan="${cols.length + 1}" class="muted" style="padding:8px">No rows — click “Add row”.</td></tr>`}</tbody></table></div>`;
      qsa('tr[data-i] input', grid).forEach((inp) => { inp.oninput = () => { state[active][+inp.closest('tr').dataset.i][inp.dataset.f] = inp.value; }; });
      qsa('.mri-del', grid).forEach((b) => { b.onclick = () => { state[active].splice(+b.dataset.i, 1); paintGrid(); }; });
      qs('#mri-note', body).textContent = `${rows.length} row(s) on “${active}”`;
    };
    qsa('#mri-tabs button', body).forEach((b) => { b.onclick = () => { active = b.dataset.k; paintTabs(); paintGrid(); }; });
    qs('#mri-add', body).onclick = () => { state[active].push({}); paintGrid(); };
    qs('#mri-save', body).onclick = async () => {
      try {
        for (const [k] of MRI_SHEETS) await api('/reports/monthly-inputs', { method: 'POST', body: { year, month, sheet: k, lines: state[k] } });
        toast('Monthly inputs saved'); close(); if (onSaved) onSaved();
      } catch (e) { toast(e.message, 'err'); }
    };
    paintTabs(); paintGrid();
  }, { persistent: true });
  const box = qs('.modal', bg); if (box) { box.style.width = 'min(940px, 95vw)'; box.style.maxWidth = 'none'; }
}

// ---- Tyre & Battery Issues — imported ledger + category price book (feeds the Monthly Cost Report)
routes.tyrebattery = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const kind = sp.get('kind') === 'battery' ? 'battery' : 'tyre';
  c.innerHTML = pageHeader('Tyre & Battery Issues', 'Imported issue ledger — set a price per category (or override a single issue). Feeds the Monthly Cost Report’s Tyre & Battery sheets.') + `
    <div class="toolbar">
      <button class="sm ${kind === 'tyre' ? 'primary' : ''}" id="tb-tyre">🛞 Tyre</button>
      <button class="sm ${kind === 'battery' ? 'primary' : ''}" id="tb-batt">🔋 Battery</button>
    </div>
    <div id="tb-sum" class="grid section"></div>
    <div class="card section">
      <div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Category prices</h3>
        <span class="muted" style="font-weight:400">— set once per size / type; every matching issue is priced</span>
        <div class="spacer"></div>
        <input id="tb-catq" placeholder="filter category…" style="width:auto">
        <a class="btn sm" href="/api/tyre-battery/categories/print.html?kind=${kind}" target="_blank">🖨 Print</a>
        <button class="primary sm" id="tb-save">Save prices</button></div>
      <div id="tb-cats" class="muted">Loading…</div></div>
    <div class="card section">
      <div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Issues</h3>
        <label style="width:auto">Month <input id="tb-month" type="month" style="width:auto"></label>
        <input id="tb-q" placeholder="search vehicle / category / site" style="width:auto">
        <div class="spacer"></div><span class="muted" id="tb-issum"></span></div>
      <div id="tb-issues" class="muted">Loading…</div></div>`;
  qs('#tb-tyre', c).onclick = () => { location.hash = '#/tyrebattery?kind=tyre'; };
  qs('#tb-batt', c).onclick = () => { location.hash = '#/tyrebattery?kind=battery'; };

  const loadSummary = async () => {
    let s; try { s = await api('/tyre-battery/summary'); } catch (e) { return; }
    const k = s[kind] || {};
    qs('#tb-sum', c).innerHTML = [['Issues', k.issues], ['Total qty', num(k.qty)], ['Categories', k.categories], ['Priced issues', (k.priced_issues || 0) + ' / ' + (k.issues || 0)], ['Priced categories', k.priced_categories]]
      .map(([l, v]) => `<div class="card stat"><span class="n">${v}</span><span class="l">${esc(l)}</span></div>`).join('');
  };

  let catState = [], dirty = new Set();
  // Client-side filter — keeps original catState indices (data-i) so edits + dirty-tracking
  // still target the right row, and in-progress prices survive re-render (they live in catState).
  const renderCats = () => {
    const q = (qs('#tb-catq', c).value || '').trim().toLowerCase();
    const rows = catState.map((r, i) => [r, i]).filter(([r]) => !q || (r.category || '').toLowerCase().includes(q) || (r.category_norm || '').toLowerCase().includes(q));
    qs('#tb-cats', c).innerHTML = tableWrap(
      [{ label: 'Category' }, { label: 'Issues', num: true }, { label: 'Total qty', num: true }, { label: 'Unit price (Rs)', num: true }],
      rows.map(([r, i]) => `<tr><td>${esc(r.category)}</td><td class="num">${r.issues}</td><td class="num">${num(r.qty)}</td><td class="num"><input type="number" min="0" step="0.01" data-i="${i}" class="tb-price" value="${r.unit_price == null ? '' : r.unit_price}" style="width:120px;text-align:right"></td></tr>`),
      { scroll: true }) + (q ? `<p class="muted" style="font-size:12px;margin:6px 0 0">Showing ${rows.length} of ${catState.length} categories</p>` : '');
    qsa('.tb-price', c).forEach((inp) => { inp.oninput = () => { const r = catState[+inp.dataset.i]; r.unit_price = inp.value === '' ? null : Number(inp.value); dirty.add(r.category_norm); }; });
  };
  const loadCats = async () => {
    let d; try { d = await api('/tyre-battery/categories?kind=' + kind); } catch (e) { qs('#tb-cats', c).innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
    catState = d.categories; dirty = new Set();
    renderCats();
  };
  let catTimer; qs('#tb-catq', c).oninput = () => { clearTimeout(catTimer); catTimer = setTimeout(renderCats, 120); };
  qs('#tb-save', c).onclick = async () => {
    // Only send the rows the user actually edited — sending the whole snapshot would let an
    // untouched (stale) null clobber a price another session set concurrently.
    const prices = catState.filter((r) => dirty.has(r.category_norm)).map((r) => ({ category_norm: r.category_norm, category: r.category, unit_price: r.unit_price }));
    if (!prices.length) return toast('No price changes to save');
    try { const res = await api('/tyre-battery/prices', { method: 'POST', body: { kind, prices } }); toast('Saved ' + res.saved + ' category price(s)'); loadCats(); loadSummary(); loadIssues(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const loadIssues = async () => {
    const month = qs('#tb-month', c).value, q = qs('#tb-q', c).value;
    let d;
    try { d = await api('/tyre-battery/issues?kind=' + kind + (month ? '&month=' + month : '') + (q ? '&q=' + encodeURIComponent(q) : '') + '&limit=500'); }
    catch (e) { qs('#tb-issues', c).innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
    qs('#tb-issum', c).textContent = `${d.summary.count} issues · ${num(d.summary.qty)} qty · ${money(d.summary.cost)}`;
    qs('#tb-issues', c).innerHTML = tableWrap(
      [{ label: 'Date' }, { label: 'Vehicle' }, { label: 'Site' }, { label: 'Qty', num: true }, { label: 'Category' }, { label: 'Override price', num: true }, { label: 'Cost', num: true }],
      d.issues.map((r) => `<tr><td>${esc(r.issue_date || '—')}</td><td>${esc(r.vehicle || '')}${r.asset_code ? ` <span class="muted">(${esc(r.asset_code)})</span>` : ''}</td><td>${esc(r.site || '')}</td><td class="num">${esc(r.qty_raw || r.qty)}</td><td>${esc(r.category || '')}</td><td class="num"><input type="number" min="0" step="0.01" class="tb-ovr" data-id="${r.id}" value="${r.unit_price == null ? '' : r.unit_price}" placeholder="${r.effective_price || 0}" style="width:100px;text-align:right"></td><td class="num">${money(r.cost)}</td></tr>`),
      { scroll: true });
    qsa('.tb-ovr', c).forEach((inp) => { inp.onchange = async () => {
      try { await api('/tyre-battery/issues/' + inp.dataset.id, { method: 'PATCH', body: { unit_price: inp.value === '' ? null : Number(inp.value) } }); toast('Override saved'); loadIssues(); loadSummary(); }
      catch (e) { toast(e.message, 'err'); }
    }; });
  };
  qs('#tb-month', c).onchange = loadIssues;
  let qTimer; qs('#tb-q', c).oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadIssues, 300); };
  loadSummary(); loadCats(); loadIssues();
};

routes.reports = async (c) => {
  const [byAsset, byProject, bySite, bySource, variance] = await Promise.all([
    api('/reports/cost/by-asset'), api('/reports/cost/by-project'), api('/reports/cost/by-site'), api('/reports/cost/by-source'), api('/reports/variance'),
  ]);
  c.innerHTML = `${pageHeader('Cost Reports & Analytics')}
    <div class="card section">
      <div class="toolbar" style="margin-top:0">
        <h3 style="margin:0">Monthly Cost Report</h3>
        <span class="muted" style="font-weight:400">— full 8-sheet workbook (Repair · Service · Tyre · Battery · Fuel · Salaries · Other · Total)</span>
        <div class="spacer"></div>
        <div><label>Year</label><select id="mcr-year"></select></div>
        <div><label>Month</label><select id="mcr-month"></select></div>
        <button class="sm" id="mcr-edit">✎ Edit monthly inputs</button>
        <a class="btn primary sm" id="mcr-dl" href="#">⬇ Download Excel</a>
      </div>
      <div id="mcr-preview" class="muted">Loading…</div></div>
    <div class="card section"><h3 style="margin-top:0">Vehicle Cost Report</h3>
      <div class="toolbar">
        <div style="flex:1;min-width:220px">${assetPickerHtml('Vehicle / machinery')}</div>
        <div><label>Year</label><select id="vcr-year"></select></div>
        <div><label>Month</label><select id="vcr-month"><option value="">Full year</option></select></div>
        <button class="primary sm" id="vcr-gen">Generate</button>
      </div>
      <div id="vcr-result"></div></div>
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

  // Monthly Cost Report — 8-sheet workbook download + manual-inputs editor + live totals preview.
  const mcrYear = qs('#mcr-year', c), mcrMonth = qs('#mcr-month', c);
  const now = new Date();
  for (let i = 0; i < 6; i++) { const o = document.createElement('option'); o.value = now.getFullYear() - i; o.textContent = now.getFullYear() - i; mcrYear.appendChild(o); }
  for (let m = 1; m <= 12; m++) { const o = document.createElement('option'); o.value = m; o.textContent = MONTH_NAMES[m]; if (m === now.getMonth() + 1) o.selected = true; mcrMonth.appendChild(o); }
  const mcrDl = qs('#mcr-dl', c), mcrPrev = qs('#mcr-preview', c);
  const loadMcr = async () => {
    const y = mcrYear.value, mo = mcrMonth.value;
    mcrDl.href = `/api/reports/monthly-cost.xlsx?year=${y}&month=${mo}`;
    mcrPrev.innerHTML = '<span class="muted">Loading…</span>';
    let p;
    try { p = (await api(`/reports/monthly-inputs?year=${y}&month=${mo}`)).preview; }
    catch (e) { mcrPrev.innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
    const line = (label, count, total, warn) => `<tr><td>${esc(label)}</td><td class="num">${count}</td><td class="num">${money(total)}</td><td>${warn ? '<span class="badge amber">enter inputs</span>' : ''}</td></tr>`;
    mcrPrev.innerHTML = tableWrap(
      [{ label: 'Sheet' }, { label: 'Rows', num: true }, { label: 'Total (Rs)', num: true }, { label: '' }],
      [line('Repair — Closed jobs', p.repair.closed_count, p.repair.closed_total),
        line('Repair — Pending jobs', p.repair.pending_count, p.repair.pending_total),
        line('Service', p.service.count, p.service.total),
        line('Tyre', p.tyre.count, p.tyre.total, false),
        line('Battery', p.battery.count, p.battery.total, false),
        line('Oils & Lubrication', p.oils.count, p.oils.total, false),
        line('Fuel', p.fuel.count, p.fuel.total, p.fuel.count === 0),
        line('Salaries (Staff)', p.salary.count, p.salary.staff_total, p.salary.count === 0),
        line('Other (overhead)', p.other.count, p.other.total, p.other.count === 0),
        `<tr><td><b>Grand Total (incl. 10% Sundry)</b></td><td></td><td class="num"><b>${money(p.grand_total)}</b></td><td></td></tr>`]) +
      `<p class="muted" style="font-size:12px;margin:6px 0 0">Repair, Service &amp; the mechanic-hours table are pulled from live data. Tyre &amp; Battery come from the <a href="#/tyrebattery">Tyre &amp; Battery</a> ledger (qty × price). Fuel, Overhead &amp; Staff salaries come from <b>Edit monthly inputs</b>.</p>`;
  };
  mcrYear.onchange = loadMcr; mcrMonth.onchange = loadMcr;
  qs('#mcr-edit', c).onclick = () => openMonthlyInputs(+mcrYear.value, +mcrMonth.value, loadMcr);
  loadMcr();

  // Vehicle Cost Report — interactive drill from vehicle_monthly_costs (/reports/vehicle-cost-complete).
  const yearSel = qs('#vcr-year', c), mSel = qs('#vcr-month', c);
  const yNow = new Date().getFullYear();
  for (let i = 0; i < 6; i++) { const o = document.createElement('option'); o.value = yNow - i; o.textContent = yNow - i; yearSel.appendChild(o); }
  for (let m = 1; m <= 12; m++) { const o = document.createElement('option'); o.value = m; o.textContent = MONTH_NAMES[m]; mSel.appendChild(o); }
  wireAssetPicker(c);
  let vcrChart;
  qs('#vcr-gen', c).onclick = async () => {
    const assetId = qs('input[name=asset_id]', c).value;
    if (!assetId) return toast('Pick a vehicle first', 'err');
    const month = mSel.value, res = qs('#vcr-result', c);
    res.innerHTML = '<div class="muted">Generating…</div>';
    let d;
    try { d = await api('/reports/vehicle-cost-complete?asset_id=' + assetId + '&year=' + yearSel.value + (month ? '&month=' + month : '')); }
    catch (e) { res.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const s = d.cost_summary || {}, mb = d.monthly_breakdown || [];
    const cards = [['Fuel', s.fuel_cost], ['Oil', s.oil_cost], ['Filters', s.filter_cost], ['Parts', s.parts_cost], ['Labour', s.labour_cost], ['Total', s.total_cost]];
    const detail = mb.length ? tableWrap([{ label: 'Month' }, { label: 'Fuel', num: true }, { label: 'Oil', num: true }, { label: 'Filter', num: true }, { label: 'Parts', num: true }, { label: 'Labour', num: true }, { label: 'Total', num: true }],
      mb.map((r) => `<tr><td>${MONTH_NAMES[r.month] || r.month}</td><td class="num">${money(r.fuel_cost)}</td><td class="num">${money(r.oil_cost)}</td><td class="num">${money(r.filter_cost)}</td><td class="num">${money(r.parts_cost)}</td><td class="num">${money(r.labour_cost)}</td><td class="num"><b>${money(r.total_cost)}</b></td></tr>`), { scroll: true }) : '<span class="muted">No cost recorded for this period.</span>';
    res.innerHTML = `<div class="grid section">${cards.map(([l, v]) => `<div class="card stat"><span class="n">${moneyC(v)}</span><span class="l">${esc(l)}</span></div>`).join('')}</div>
      ${mb.length > 1 ? '<div style="position:relative;height:240px"><canvas id="vcr-chart"></canvas></div>' : ''}
      <h4 style="margin:12px 0 6px">Cost detail</h4>${detail}`;
    if (mb.length > 1) loadChartJs((ok) => {
      if (!ok || !qs('#vcr-chart', c)) return;
      if (vcrChart) { try { vcrChart.destroy(); } catch (e) { /* detached */ } }
      vcrChart = new Chart(qs('#vcr-chart', c).getContext('2d'), {
        type: 'bar',
        data: { labels: mb.map((r) => MONTH_NAMES[r.month] || r.month), datasets: [['Fuel', 'fuel_cost', '#6a7379'], ['Oil', 'oil_cost', '#f2a900'], ['Filters', 'filter_cost', '#3c7d5a'], ['Parts', 'parts_cost', '#1d5a73'], ['Labour', 'labour_cost', '#8a949b']].map((dd) => ({ label: dd[0], backgroundColor: dd[2], data: mb.map((r) => Number(r[dd[1]]) || 0) })) },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => moneyC(v) } } } },
      });
    });
  };
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
// ---- Daily Progress Report — one day's workshop output ----------------------
routes.progress = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const today = new Date().toISOString().slice(0, 10);
  const date0 = sp.get('date') || today;
  c.innerHTML = `${pageHeader('Daily Progress Report', 'One day’s workshop output — jobs worked, hours, labour, materials & oil.')}
    <div class="toolbar">
      <label style="display:flex;gap:6px;align-items:center;flex-direction:row;width:auto">Date <input type="date" id="pgdate" value="${esc(date0)}" style="width:auto"></label>
      <div class="spacer"></div>
      <a class="btn sm" id="pgprint" href="/api/reports/daily-progress/print.html?date=${encodeURIComponent(date0)}" target="_blank">🖨 Print</a>
    </div>
    <div id="pgbody"><div class="muted">Loading…</div></div>`;
  const load = async () => {
    const dt = qs('#pgdate').value || today;
    history.replaceState(null, '', '#/progress?date=' + dt);
    qs('#pgprint').href = '/api/reports/daily-progress/print.html?date=' + encodeURIComponent(dt);
    let rep;
    try { rep = await api('/reports/daily-progress?date=' + encodeURIComponent(dt)); }
    catch (e) { qs('#pgbody').innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    const t = rep.totals;
    const jobRows = rep.jobs.map((j) => `<tr>
        <td><a href="#/jobs/${j.job_id}">${esc(j.job_no)}</a></td>
        <td>${esc(idLabel(j) || '—')}</td>
        <td>${esc(j.mechanics.join(', '))}</td>
        <td>${esc(j.tasks.map((x) => x.description || (x.is_external ? 'External repair' : '')).filter(Boolean).join('; '))}</td>
        <td class="num">${num(j.hours)}</td>
        <td class="num">${money(j.labour)}</td></tr>`);
    qs('#pgbody').innerHTML = `
      <div class="grid section">
        <div class="card stat"><span class="n">${t.jobs}</span><span class="l">Jobs Worked</span></div>
        <div class="card stat"><span class="n">${num(t.hours)}</span><span class="l">Mechanic-Hours</span></div>
        <div class="card stat"><span class="n">${moneyC(t.labour)}</span><span class="l">Labour</span></div>
        <div class="card stat"><span class="n">${moneyC(t.material)}</span><span class="l">Material</span></div>
        <div class="card stat"><span class="n">${moneyC(t.oil)}</span><span class="l">Oil &amp; Lube</span></div>
        <div class="card stat"><span class="n">${moneyC(t.grand)}</span><span class="l">Day Total</span></div>
      </div>
      <div class="card"><h3>Jobs worked · ${esc(dt)}</h3>
        ${tableWrap([{ label: 'Job No' }, { label: 'Vehicle' }, { label: 'Mechanic(s)' }, { label: 'Work done' }, { label: 'Hours', num: true }, { label: 'Labour', num: true }], jobRows, { scroll: true })}</div>
      ${rep.issues.length ? `<div class="card"><h3>Materials issued</h3>${tableWrap([{ label: 'Item' }, { label: 'Job' }, { label: 'Qty', num: true }, { label: 'Value', num: true }], rep.issues.map((i) => `<tr><td>${esc(i.description)}</td><td>${esc(i.job_no || '')}</td><td class="num">${num(i.qty)}</td><td class="num">${money((Number(i.qty) || 0) * (Number(i.unit_price) || 0))}</td></tr>`), { scroll: true })}</div>` : ''}
      ${rep.oil.length ? `<div class="card"><h3>Oil &amp; lubricants issued</h3>${tableWrap([{ label: 'Product' }, { label: 'Job' }, { label: 'Qty', num: true }, { label: 'Value', num: true }], rep.oil.map((o) => `<tr><td>${esc(o.product)}</td><td>${esc(o.job_no || '')}</td><td class="num">${num(Math.abs(o.qty))}</td><td class="num">${money(Math.abs(o.qty) * (Number(o.unit_price) || 0))}</td></tr>`), { scroll: true })}</div>` : ''}`;
  };
  qs('#pgdate').onchange = load;
  await load();
};

// ---- Reverse Costing — per-vehicle cost teardown ----------------------------
routes.teardown = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const preId = sp.get('asset');
  c.innerHTML = `${pageHeader('Cost Teardown', 'Reverse costing — where a vehicle’s spend went, by bucket, job, part and mechanic.')}
    <div class="card">${assetPickerHtml('Vehicle / Machine (search & select)')}</div>
    <div id="tdbody"></div>`;
  wireAssetPicker(c);
  const show = async (id) => {
    let t;
    try { t = await api('/reports/teardown/asset/' + id); }
    catch (e) { qs('#tdbody').innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    const b = t.buckets;
    const total = Number(b.total) || 0;
    const pct = (n) => total > 0 ? (100 * (Number(n) || 0) / total) : 0;
    const BUCKETS = [['Labour', b.labour], ['Material', b.material], ['Oil & Lube', b.oil], ['General', b.general], ['External', b.external], ['Other', b.other]];
    const bars = BUCKETS.filter(([, v]) => (Number(v) || 0) > 0.005).map(([label, v]) => `
      <div class="cost-line"><span>${label}</span><span>${money(v)} · ${pct(v).toFixed(1)}%</span></div>
      <div class="bar-track"><div class="bar" style="width:${pct(v)}%"></div></div>`).join('') || '<span class="muted">No recorded cost for this vehicle.</span>';
    const jobRows = t.jobs.map((j) => `<tr>
        <td><a href="#/jobs/${j.id}">${esc(j.job_no)}</a></td><td>${esc(j.type)}</td>
        <td class="num">${money(j.labour_cost)}</td><td class="num">${money(j.material_cost)}</td>
        <td class="num">${money(j.oil_cost)}</td><td class="num">${money(j.external_cost)}</td>
        <td class="num"><b>${money(j.total_cost)}</b></td></tr>`);
    history.replaceState(null, '', '#/teardown?asset=' + id);
    qs('#tdbody').innerHTML = `
      <div class="toolbar"><h3 style="margin:0">${esc(idLabel(t.asset) || t.asset.code)} <span class="muted" style="font-weight:400">${esc([t.asset.brand, t.asset.type].filter(Boolean).join(' '))}</span></h3>
        <div class="spacer"></div><span class="badge">${b.jobs} jobs</span><span class="badge amber">Lifetime ${money(total)}</span>
        <a class="btn sm" href="/api/reports/teardown/asset/${id}/print.html" target="_blank">🖨 Print</a></div>
      <div class="card"><h3>Cost by bucket</h3>${bars}</div>
      <div class="grid">
        <div class="card"><h3>Jobs by cost</h3>${tableWrap([{ label: 'Job No' }, { label: 'Type' }, { label: 'Labour', num: true }, { label: 'Material', num: true }, { label: 'Oil', num: true }, { label: 'External', num: true }, { label: 'Total', num: true }], jobRows, { scroll: true })}</div>
        <div class="card"><h3>Top parts by value</h3>${t.parts.length ? t.parts.map((p) => `<div class="cost-line"><span>${esc(p.description)} <span class="muted">×${p.lines}</span></span><span>${money(p.value)}</span></div>`).join('') : '<span class="muted">No priced parts.</span>'}</div>
        <div class="card"><h3>Labour by mechanic</h3>${t.mechanics.length ? t.mechanics.map((mm) => `<div class="cost-line"><span>${esc(mm.mechanic)} <span class="muted">${num(mm.hours)}h</span></span><span>${money(mm.amount)}</span></div>`).join('') : '<span class="muted">No labour recorded.</span>'}</div>
      </div>`;
  };
  // The picker sets the hidden asset_id via JS on item mousedown — hook the same event.
  c.addEventListener('mousedown', (e) => {
    const it = e.target.closest && e.target.closest('.apick-item');
    if (it && it.dataset.id) setTimeout(() => show(it.dataset.id), 0);
  }, true);
  if (preId) await show(preId);
};

// ---- Access Control (admin) — clearance board + user/role management --------
routes.access = async (c) => {
  if (!can('admin')) { c.innerHTML = '<div class="card err">Admin only.</div>'; return; }
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = sp.get('tab') === 'users' ? 'users' : 'board';
  c.innerHTML = `${pageHeader('Access Control', 'Who holds the keys to which bay — set each role’s clearance per section.')}
    <div class="pill-row" style="margin-bottom:12px">
      <button class="btn sm ${tab === 'board' ? 'primary' : ''}" id="tb-board">Clearance Board</button>
      <button class="btn sm ${tab === 'users' ? 'primary' : ''}" id="tb-users">Users &amp; Roles</button>
    </div>
    <div id="apane"><div class="muted">Loading…</div></div>`;
  qs('#tb-board').onclick = () => { location.hash = '#/access?tab=board'; };
  qs('#tb-users').onclick = () => { location.hash = '#/access?tab=users'; };
  if (tab === 'users') await renderUsersManager(qs('#apane'));
  else await renderClearanceBoard(qs('#apane'));
};
routes.users = async (c) => { location.hash = '#/access?tab=users'; };

const lvlChip = (lvl) => {
  const cls = lvl === 'full' ? 'amber' : lvl === 'edit' ? 'green' : '';
  const txt = lvl === 'none' ? '—' : lvl.toUpperCase();
  return `<span class="badge ${cls}"${lvl === 'none' ? ' style="opacity:.4"' : ''}>${txt}</span>`;
};

async function renderClearanceBoard(c) {
  const m = await api('/access/matrix');
  const LV = m.levels;
  const headCols = m.modules.map((mod) => `<th style="text-align:center">${esc(mod.label)}${mod.enforce ? '' : ' <span class="muted" title="Hidden in the sidebar but not API-blocked (reference/analytics)">*</span>'}</th>`).join('');
  const rows = m.roles.map((r) => `<tr><td><b>${esc(r.label || r.name)}</b><br><span class="muted" style="font-size:11px">${esc(r.name)}</span></td>${m.modules.map((mod) => {
    const lvl = m.grid[r.name][mod.key];
    const locked = r.name === 'admin';
    return `<td style="text-align:center;cursor:${locked ? 'default' : 'pointer'}"${locked ? '' : ` data-cell="${r.name}:${mod.key}" data-lvl="${lvl}" title="click to change"`}>${lvlChip(lvl)}</td>`;
  }).join('')}</tr>`).join('');
  c.innerHTML = `<div class="card">
    <p class="muted" style="margin-top:0">Click a cell to cycle clearance: — → VIEW → EDIT → FULL. <b>Admin</b> is always full. Changes apply immediately; a signed-in user sees nav changes after their next login. <span title="nav-level only">*</span> = hidden in the sidebar but not API-blocked.</p>
    <div class="table-wrap scroll"><table><thead><tr><th>Role</th>${headCols}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pill-row" style="margin-top:12px"><span class="muted">Legend:</span> ${lvlChip('full')} manage ${lvlChip('edit')} add / modify ${lvlChip('view')} read-only ${lvlChip('none')} no access</div>
  </div>`;
  qsa('[data-cell]', c).forEach((td) => td.onclick = async () => {
    const [role, mod] = td.dataset.cell.split(':');
    const next = LV[(LV.indexOf(td.dataset.lvl) + 1) % LV.length];
    try { await api('/access/matrix', { method: 'POST', body: { role, module: mod, level: next } }); renderClearanceBoard(c); }
    catch (e) { toast(e.message, 'err'); }
  });
}

async function renderUsersManager(c) {
  const [users, roles] = await Promise.all([api('/users'), api('/users/roles')]);
  const roleNames = roles.map((r) => r.name);
  c.innerHTML = `<div class="toolbar"><button class="primary" id="nu">+ New User</button><div class="spacer"></div><span class="muted">${users.length} user(s)</span></div>
    ${tableWrap([{ label: 'Username' }, { label: 'Name' }, { label: 'Roles' }, { label: 'Active' }, { label: '' }],
      users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.full_name || '')}</td><td>${u.roles.map((r) => `<span class="badge">${esc(r)}</span>`).join(' ')}</td><td>${u.active ? '✓' : '✕'}</td><td><button class="sm" data-roles="${u.id}">Roles</button></td></tr>`))}`;
  if (qs('#nu', c)) qs('#nu', c).onclick = () => modal('New User', `${field('Username *', 'username')}${field('Password *', 'password', { type: 'password' })}${field('Full name', 'full_name')}<label>Roles</label>${roleNames.map((r) => `<label style="flex-direction:row;display:flex;gap:6px;align-items:center"><input type="checkbox" style="width:auto" data-role="${r}"> ${r}</label>`).join('')}<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create</button></div>`,
    (body, close) => { qs('#s', body).onclick = async () => { const d = formData(body); d.roles = qsa('[data-role]', body).filter((x) => x.checked).map((x) => x.dataset.role); try { await api('/users', { method: 'POST', body: d }); close(); renderUsersManager(c); } catch (e) { toast(e.message, 'err'); } }; });
  qsa('[data-roles]', c).forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.roles);
    modal('Roles for ' + u.username, roleNames.map((r) => `<label style="flex-direction:row;display:flex;gap:6px;align-items:center"><input type="checkbox" style="width:auto" data-role="${r}" ${u.roles.includes(r) ? 'checked' : ''}> ${r}</label>`).join('') + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>',
      (body, close) => { qs('#s', body).onclick = async () => { const rs = qsa('[data-role]', body).filter((x) => x.checked).map((x) => x.dataset.role); try { await api(`/users/${u.id}/roles`, { method: 'POST', body: { roles: rs } }); close(); renderUsersManager(c); } catch (e) { toast(e.message, 'err'); } }; });
  });
}

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

// ===== General Stock — native SPA view (was public/general-stock.html) =====
// General consumables held in store_items with is_general=1. Backed by /api/general-stock.
const gsStatus = (s) => (s === 'critical' ? '<span class="badge red">CRITICAL</span>' : s === 'low' ? '<span class="badge amber">LOW</span>' : '<span class="badge green">OK</span>');
routes.generalstock = async (c) => {
  if (!canView('stores')) { c.innerHTML = `<div class="card"><p class="err">You do not have access to Stores.</p></div>`; return; }
  const edit = canEdit('stores');
  c.innerHTML = pageHeader('General Stock') + `
    <div class="grid section" id="gs-stats"></div>
    <div class="toolbar">
      <input type="search" id="gs-q" placeholder="Search name / item no / category…" style="max-width:240px">
      <select id="gs-cat" style="max-width:180px"><option value="">All categories</option></select>
      <button class="sm" id="gs-low">Low stock only</button>
      <div class="spacer"></div>
      ${edit ? '<button class="primary sm" id="gs-add">+ Add Item</button>' : ''}
      <span class="muted" id="gs-count"></span>
    </div>
    <div id="gs-table" class="muted">Loading…</div>`;

  try { (await api('/general-stock/categories')).forEach((cat) => { const o = document.createElement('option'); o.value = cat; o.textContent = cat; qs('#gs-cat').appendChild(o); }); } catch (e) { /* dropdown optional */ }

  let lowOnly = false, rows = [];
  const load = async () => {
    const q = qs('#gs-q').value.trim(), cat = qs('#gs-cat').value;
    const query = '?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + (cat ? 'category=' + encodeURIComponent(cat) + '&' : '') + (lowOnly ? 'low_stock=1' : '');
    try {
      const [s, items] = await Promise.all([api('/general-stock/summary'), api('/general-stock/items' + query)]);
      qs('#gs-stats').innerHTML = [
        [num(s.total_items), 'Total Items'], [moneyC(s.total_value), 'Total Value (LKR)'],
        [num(s.low_stock_count), 'Low Stock'], [num(s.categories), 'Categories'],
      ].map(([n, l]) => `<div class="card stat"><span class="n">${n}</span><span class="l">${esc(l)}</span></div>`).join('');
      rows = items;
      qs('#gs-count').textContent = items.length + (items.length === 1 ? ' item' : ' items');
      const headers = [{ label: 'Item No' }, { label: 'Name' }, { label: 'Category' }, { label: 'Unit' }, { label: 'Balance', num: true }, { label: 'Min Stock', num: true }, { label: 'Unit Cost', num: true }, { label: 'Total Value', num: true }, { label: 'Status' }, { label: 'Actions' }];
      const body = items.map((r) => `<tr${r.status !== 'ok' ? ' style="background:rgba(224,168,0,.06)"' : ''}>
        <td>${esc(r.item_no || '')}</td>
        <td><b>${esc(r.name)}</b>${r.description ? `<br><span class="muted" style="font-size:11px">${esc(r.description)}</span>` : ''}</td>
        <td>${esc(r.category || '—')}</td><td>${esc(r.unit || '')}</td>
        <td class="num">${num(r.balance)}</td><td class="num">${num(r.min_stock)}</td>
        <td class="num">${money(r.unit_cost)}</td><td class="num">${money(r.total_value)}</td>
        <td>${gsStatus(r.status)}</td>
        <td>${edit ? `<button class="sm" data-adj="${r.id}">Adjust</button>` : ''}</td></tr>`);
      qs('#gs-table').innerHTML = tableWrap(headers, body, { scroll: true });
      qsa('[data-adj]').forEach((b) => { b.onclick = () => gsAdjust(rows.find((x) => String(x.id) === b.dataset.adj)); });
    } catch (e) { qs('#gs-table').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  };

  const gsAdd = () => modal('Add General Stock Item', `
    <div class="row">${field('Name', 'name')}${field('Category', 'category')}</div>
    <div class="row">${field('Unit', 'unit', { value: 'nos' })}${field('Item No (auto if blank)', 'item_no', { placeholder: 'GS-####' })}</div>
    <div class="row">${field('Opening balance', 'balance', { type: 'number', value: '0' })}${field('Min stock (reorder)', 'min_stock', { type: 'number', value: '0' })}</div>
    <div class="row">${field('Unit cost (LKR)', 'unit_cost', { type: 'number', value: '0' })}${field('Location', 'location')}</div>
    ${field('Description', 'description')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="gs-save">Add Item</button></div>`, (body, close) => {
    qs('#gs-save', body).onclick = async () => {
      const d = formData(body);
      if (!d.name.trim()) return toast('Name is required', 'err');
      try { await api('/general-stock/items', { method: 'POST', body: d }); toast('Item added'); close(); load(); } catch (e) { toast(e.message, 'err'); }
    };
  });

  const gsAdjust = (item) => {
    if (!item) return;
    const today = new Date().toISOString().slice(0, 10);
    modal('Adjust Stock — ' + item.name, `
      <p class="muted" style="margin-top:0">${esc(item.item_no || '')} · current balance <b>${num(item.balance)}</b> ${esc(item.unit || '')}</p>
      <div class="row">${field('Type', 'txn_type', { type: 'select', options: [{ value: 'receipt', label: 'Receipt (+)' }, { value: 'issue', label: 'Issue (−)' }, { value: 'adjustment', label: 'Adjustment (set to)' }] })}${field('Quantity', 'qty', { type: 'number' })}</div>
      <div class="row">${field('Unit price (optional)', 'unit_price', { type: 'number' })}${field('Date', 'txn_date', { type: 'date', value: today })}</div>
      ${field('Reason / reference', 'reason')}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="gs-adj">Record</button></div>`, (body, close) => {
      qs('#gs-adj', body).onclick = async () => {
        try { await api('/general-stock/items/' + item.id + '/adjust', { method: 'POST', body: formData(body) }); toast('Stock updated'); close(); load(); } catch (e) { toast(e.message, 'err'); }
      };
    });
  };

  let deb;
  qs('#gs-q').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#gs-cat').onchange = load;
  qs('#gs-low').onclick = () => { lowOnly = !lowOnly; qs('#gs-low').classList.toggle('primary', lowOnly); load(); };
  if (edit && qs('#gs-add')) qs('#gs-add').onclick = gsAdd;
  load();
};

// ===== Filter Stock — native SPA view (was public/filter-stock.html) =====
// Dedicated filter inventory (filter_stock + filter_stock_ledger). Backed by /api/filter-stock.
const fsStatus = (s) => (s === 'critical' ? '<span class="badge red">CRITICAL</span>' : s === 'low' ? '<span class="badge amber">LOW</span>' : '<span class="badge green">OK</span>');
const fsPills = (v) => (v ? String(v).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => `<span class="badge" style="font-weight:400">${esc(x)}</span>`).join(' ') : '<span class="muted">—</span>');
routes.filterstock = async (c) => {
  if (!canView('filters')) { c.innerHTML = `<div class="card"><p class="err">You do not have access to Filters.</p></div>`; return; }
  const edit = canEdit('filters');
  c.innerHTML = pageHeader('Filter Stock') + `
    <div class="grid section" id="fs-stats"></div>
    <div class="toolbar">
      <input type="search" id="fs-q" placeholder="Search type / brand / part no / vehicle…" style="max-width:280px">
      <button class="sm" id="fs-low">Low stock only</button>
      <div class="spacer"></div>
      ${edit ? '<button class="primary sm" id="fs-add">+ Add Filter Type</button>' : ''}
      <span class="muted" id="fs-count"></span>
    </div>
    <div id="fs-table" class="muted">Loading…</div>`;
  let lowOnly = false, rows = [];
  const load = async () => {
    const q = qs('#fs-q').value.trim();
    const query = '?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + (lowOnly ? 'low_stock=1' : '');
    try {
      const [s, items] = await Promise.all([api('/filter-stock/summary'), api('/filter-stock/' + query)]);
      qs('#fs-stats').innerHTML = [
        [num(s.total_types), 'Total Filter Types'], [moneyC(s.total_value), 'Total Stock Value (LKR)'], [num(s.low_stock_count), 'Low Stock Count'],
      ].map(([n, l]) => `<div class="card stat"><span class="n">${n}</span><span class="l">${esc(l)}</span></div>`).join('');
      rows = items;
      qs('#fs-count').textContent = items.length + (items.length === 1 ? ' type' : ' types');
      const headers = [{ label: 'Type' }, { label: 'Brand' }, { label: 'Part No' }, { label: 'Compatible Vehicles' }, { label: 'In Stock', num: true }, { label: 'Reorder', num: true }, { label: 'Unit Cost', num: true }, { label: 'Status' }, { label: 'Actions' }];
      const body = items.map((r) => `<tr${r.status !== 'ok' ? ' style="background:rgba(224,168,0,.06)"' : ''}>
        <td><a href="javascript:void 0" data-led="${r.id}"><b>${esc(r.filter_type)}</b></a></td>
        <td>${esc(r.brand || '—')}</td><td>${esc(r.part_no || '—')}</td><td>${fsPills(r.compatible_assets)}</td>
        <td class="num">${num(r.qty_in_stock)} ${esc(r.unit || '')}</td><td class="num">${num(r.reorder_level)}</td>
        <td class="num">${money(r.unit_cost)}</td><td>${fsStatus(r.status)}</td>
        <td style="white-space:nowrap">${edit ? `<button class="sm" data-rcv="${r.id}">Receive</button> <button class="sm" data-iss="${r.id}">Issue</button>` : ''}</td></tr>`);
      qs('#fs-table').innerHTML = tableWrap(headers, body, { scroll: true });
      const byId = (id) => rows.find((x) => String(x.id) === String(id));
      qsa('[data-led]').forEach((a) => { a.onclick = () => fsLedger(a.dataset.led); });
      qsa('[data-rcv]').forEach((b) => { b.onclick = () => fsReceive(byId(b.dataset.rcv)); });
      qsa('[data-iss]').forEach((b) => { b.onclick = () => fsIssue(byId(b.dataset.iss)); });
    } catch (e) { qs('#fs-table').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  };

  const fsAdd = () => modal('Add Filter Type', `
    <div class="row">${field('Filter type', 'filter_type', { placeholder: 'e.g. Oil Filter' })}${field('Brand', 'brand', { placeholder: 'VIC / Sakura…' })}</div>
    <div class="row">${field('Part No', 'part_no')}${field('Unit', 'unit', { value: 'nos' })}</div>
    <div class="row">${field('Opening qty', 'qty_in_stock', { type: 'number', value: '0' })}${field('Reorder level', 'reorder_level', { type: 'number', value: '5' })}</div>
    <div class="row">${field('Unit cost (LKR)', 'unit_cost', { type: 'number', value: '0' })}${field('Supplier', 'supplier')}</div>
    ${field('Compatible vehicles (comma separated)', 'compatible_assets', { placeholder: 'LO-5981, GE-126' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="fs-save">Add</button></div>`, (body, close) => {
    qs('#fs-save', body).onclick = async () => {
      const d = formData(body);
      if (!d.filter_type.trim()) return toast('Filter type is required', 'err');
      try { await api('/filter-stock', { method: 'POST', body: d }); toast('Filter type added'); close(); load(); } catch (e) { toast(e.message, 'err'); }
    };
  });

  const fsReceive = (f) => {
    if (!f) return;
    const today = new Date().toISOString().slice(0, 10);
    modal('Receive Stock — ' + f.filter_type, `
      <p class="muted" style="margin-top:0">Current stock <b>${num(f.qty_in_stock)}</b> ${esc(f.unit || '')}</p>
      <div class="row">${field('Quantity', 'qty', { type: 'number' })}${field('Unit cost (LKR)', 'unit_cost', { type: 'number', value: f.unit_cost || '' })}</div>
      <div class="row">${field('Supplier', 'supplier', { value: f.supplier || '' })}${field('Invoice no', 'invoice_no')}</div>
      ${field('Date', 'date', { type: 'date', value: today })}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="fs-r">Receive</button></div>`, (body, close) => {
      qs('#fs-r', body).onclick = async () => {
        const d = formData(body);
        if (!(Number(d.qty) > 0)) return toast('Enter a quantity greater than 0', 'err');
        try { await api('/filter-stock/' + f.id + '/receive', { method: 'POST', body: d }); toast('Stock received'); close(); load(); } catch (e) { toast(e.message, 'err'); }
      };
    });
  };

  const fsIssue = (f) => {
    if (!f) return;
    const today = new Date().toISOString().slice(0, 10);
    modal('Issue Filter — ' + f.filter_type, `
      <p class="muted" style="margin-top:0">Available <b>${num(f.qty_in_stock)}</b> ${esc(f.unit || '')} · costed at ${money(f.unit_cost)} each</p>
      ${assetPickerHtml('Vehicle / machinery')}
      <div class="row">${field('Quantity', 'qty', { type: 'number', value: '1' })}${field('Date', 'date', { type: 'date', value: today })}</div>
      ${field('Note', 'note')}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="fs-i">Issue</button></div>`, (body, close) => {
      wireAssetPicker(body);
      qs('#fs-i', body).onclick = async () => {
        const d = formData(body);
        if (!d.asset_id) return toast('Pick a vehicle', 'err');
        if (!(Number(d.qty) > 0)) return toast('Enter a quantity greater than 0', 'err');
        if (Number(d.qty) > Number(f.qty_in_stock)) return toast('Only ' + num(f.qty_in_stock) + ' in stock', 'err');
        try { await api('/filter-stock/' + f.id + '/issue', { method: 'POST', body: { asset_id: d.asset_id, qty: d.qty, date: d.date, note: d.note } }); toast('Filter issued'); close(); load(); } catch (e) { toast(e.message, 'err'); }
      };
    });
  };

  const fsLedger = async (id) => {
    try {
      const d = await api('/filter-stock/' + id + '/ledger');
      const f = d.filter, l = d.ledger || [];
      const kindB = (k) => (k === 'issue' ? '<span class="badge red">Issue</span>' : k === 'receipt' ? '<span class="badge green">Receipt</span>' : '<span class="badge">Adj</span>');
      const headers = [{ label: 'Date' }, { label: 'Type' }, { label: 'Qty', num: true }, { label: 'Balance', num: true }, { label: 'Unit Price', num: true }, { label: 'Vehicle / Note' }];
      const body = l.map((t) => `<tr><td>${esc((t.txn_date || '').slice(0, 10))}</td><td>${kindB(t.kind)}</td><td class="num">${num(t.qty)}</td><td class="num">${num(t.balance_after)}</td><td class="num">${t.unit_price == null ? '—' : money(t.unit_price)}</td><td>${esc(idLabel(t) || t.note || '—')}${t.job_no ? ` <span class="badge">${esc(t.job_no)}</span>` : ''}</td></tr>`);
      modal('Ledger — ' + f.filter_type, `<p class="muted" style="margin-top:0">${esc(f.brand || '')} · ${esc(f.part_no || '')} · in stock <b>${num(f.qty_in_stock)}</b> ${esc(f.unit || '')} ${fsStatus(f.status)}</p>${tableWrap(headers, body, { scroll: true })}`);
    } catch (e) { toast(e.message, 'err'); }
  };

  let deb;
  qs('#fs-q').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#fs-low').onclick = () => { lowOnly = !lowOnly; qs('#fs-low').classList.toggle('primary', lowOnly); load(); };
  if (edit && qs('#fs-add')) qs('#fs-add').onclick = fsAdd;
  load();
};

// ===== Stock Issues — native SPA view (was public/stock-issues.html) =====
// Parts/consumables issued to a vehicle/job. Backed by /api/stores/issues (+ /kpis).
routes.stockissues = async (c) => {
  if (!canView('stores')) { c.innerHTML = `<div class="card"><p class="err">You do not have access to Stores.</p></div>`; return; }
  const edit = canEdit('stores');
  c.innerHTML = pageHeader('Stock Issues') + `
    <div class="grid section" id="si-kpi"></div>
    <div class="toolbar">
      <label style="width:auto">From <input type="date" id="si-from" style="max-width:150px"></label>
      <label style="width:auto">To <input type="date" id="si-to" style="max-width:150px"></label>
      <input type="search" id="si-q" placeholder="Vehicle / item…" style="max-width:180px">
      <select id="si-cat" style="max-width:170px"><option value="">All categories</option></select>
      <div class="spacer"></div>
      ${edit ? '<button class="primary sm" id="si-new">+ New Issue</button>' : ''}
      <span class="muted" id="si-count"></span>
    </div>
    <div id="si-table" class="muted">Loading…</div>`;
  try { (await api('/stores/issue-categories')).forEach((cat) => { const o = document.createElement('option'); o.value = cat; o.textContent = cat; qs('#si-cat').appendChild(o); }); } catch (e) { /* optional */ }
  const load = async () => {
    let query = '?limit=500';
    if (qs('#si-from').value) query += '&date_from=' + qs('#si-from').value;
    if (qs('#si-to').value) query += '&date_to=' + qs('#si-to').value;
    if (qs('#si-q').value.trim()) query += '&q=' + encodeURIComponent(qs('#si-q').value.trim());
    if (qs('#si-cat').value) query += '&category=' + encodeURIComponent(qs('#si-cat').value);
    try {
      const [k, rows] = await Promise.all([api('/stores/issues/kpis'), api('/stores/issues' + query)]);
      qs('#si-kpi').innerHTML = [
        [num(k.issues_today), 'Issues Today'], [moneyC(k.cost_today), 'Cost Today (LKR)'],
        [num(k.issues_month), 'This Month Issues'], [moneyC(k.cost_month), 'Monthly Cost (LKR)'],
      ].map(([n, l]) => `<div class="card stat"><span class="n">${n}</span><span class="l">${esc(l)}</span></div>`).join('');
      qs('#si-count').textContent = rows.length + (rows.length === 1 ? ' issue' : ' issues');
      const headers = [{ label: 'Date' }, { label: 'Vehicle' }, { label: 'Job' }, { label: 'Item' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Total Cost', num: true }, { label: 'Issued By' }, { label: 'Category' }];
      const body = rows.map((r) => `<tr>
        <td>${esc((r.issue_date || '').slice(0, 10))}</td><td>${esc(idLabel(r) || 'General')}</td>
        <td>${r.job_no ? esc(r.job_no) : '<span class="muted">—</span>'}</td><td>${esc(r.description || '')}</td>
        <td class="num">${num(r.qty)}</td><td class="num">${r.unit_price == null ? '<span class="muted">—</span>' : money(r.unit_price)}</td>
        <td class="num">${money(r.total_cost)}</td><td>${esc(r.issued_by || '—')}</td>
        <td>${r.category ? `<span class="badge">${esc(r.category)}</span>` : '—'}</td></tr>`);
      qs('#si-table').innerHTML = tableWrap(headers, body, { scroll: true });
    } catch (e) { qs('#si-table').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  };

  const newIssue = () => {
    const today = new Date().toISOString().slice(0, 10);
    modal('New Stock Issue', `
      ${targetPickerHtml('si-tgt', { label: 'Issue to — job card (cost lands on the job) or general workshop', generalLabel: 'General workshop (no vehicle)' })}
      <div style="position:relative"><label>Item</label>
        <input type="text" id="si-item" autocomplete="off" placeholder="Search store items…">
        <input type="hidden" name="store_item_id"><input type="hidden" name="description">
        <div id="si-item-menu" style="position:absolute;z-index:60;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);max-height:220px;overflow:auto;display:none"></div>
      </div>
      <div class="row">${field('Quantity', 'qty', { type: 'number', value: '1' })}${field('Unit Price (LKR)', 'unit_price', { type: 'number' })}</div>
      <div class="row">${field('Date', 'issue_date', { type: 'date', value: today })}${field('Category', 'category')}</div>
      ${field('Issued By', 'issued_by', { value: (ME.fullName || ME.username) })}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="si-save">Record Issue</button></div>`, (body, close) => {
      const getTarget = wireTargetPicker(body, 'si-tgt');
      const input = qs('#si-item', body), menu = qs('#si-item-menu', body);
      const hId = qs('input[name=store_item_id]', body), hDesc = qs('input[name=description]', body);
      let deb2;
      input.oninput = () => { clearTimeout(deb2); deb2 = setTimeout(async () => {
        const q = input.value.trim(); hId.value = ''; hDesc.value = q; // typed text is the fallback description
        if (q.length < 2) { menu.style.display = 'none'; return; }
        let items = []; try { items = await api('/stores/items?limit=8&q=' + encodeURIComponent(q)); } catch (e) { return; }
        menu.innerHTML = items.length ? items.map((it) => `<div class="si-it" data-id="${it.id}" data-name="${esc(it.name)}" data-cost="${it.unit_cost || ''}" data-cat="${esc(it.category || '')}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)"><b>${esc(it.name)}</b>${it.part_number ? ` <span class="muted">· ${esc(it.part_number)}</span>` : ''}</div>`).join('') : '<div class="muted" style="padding:8px 10px">No item — free text kept</div>';
        menu.style.display = 'block';
        qsa('.si-it', menu).forEach((el) => { el.onmousedown = (e) => { e.preventDefault(); clearTimeout(deb2); input.value = el.dataset.name; hId.value = el.dataset.id; hDesc.value = el.dataset.name; if (el.dataset.cost) qs('input[name=unit_price]', body).value = el.dataset.cost; if (el.dataset.cat) qs('input[name=category]', body).value = el.dataset.cat; menu.style.display = 'none'; }; });
      }, 200); };
      input.onblur = () => setTimeout(() => { menu.style.display = 'none'; }, 150);
      qs('#si-save', body).onclick = async () => {
        const d = formData(body);
        const t = getTarget();
        if (t.type === 'vehicle' && !t.job_id) return toast('Pick a job card for the selected vehicle', 'err');
        const description = (d.description || input.value).trim();
        if (!description) return toast('Pick or type an item', 'err');
        if (!(Number(d.qty) > 0)) return toast('Enter a quantity greater than 0', 'err');
        try { await api('/stores/issues', { method: 'POST', body: { job_id: t.job_id || undefined, description, store_item_id: d.store_item_id || undefined, qty: d.qty, unit_price: d.unit_price, issue_date: d.issue_date, category: d.category, issued_by: d.issued_by } }); toast('Issue recorded'); close(); load(); } catch (e) { toast(e.message, 'err'); }
      };
    });
  };

  let deb;
  qs('#si-q').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 260); };
  ['si-from', 'si-to', 'si-cat'].forEach((id) => { qs('#' + id).onchange = load; });
  if (edit && qs('#si-new')) qs('#si-new').onclick = newIssue;
  load();
};

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
