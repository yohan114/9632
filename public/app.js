'use strict';
/* WorkshopOne SPA — vanilla JS, no build step. Consumes /api/*. */

// ---------------------------------------------------------------- API + util
let ME = null;

// Live updates are a convenience. Signing in is not.
//
// These two files are cached separately by the browser, so a visitor can hold a NEW app.js against
// an OLD live-client.js. That happened: app.js called LiveERP.connect(), the cached client had no
// such function, the exception escaped boot(), and the login screen reported "Server connection
// issue: LiveERP.connect is not a function" — a real deployment, where nobody could sign in because
// of a stale copy of an optional feature. The cache-busting hole is fixed in src/server.js; this
// makes the dependency one-way regardless, so a missing or half-loaded live client degrades to
// "no live updates" instead of "no way in".
function live(method) {
  try {
    if (window.LiveERP && typeof window.LiveERP[method] === 'function') window.LiveERP[method]();
  } catch (e) {
    console.warn('live updates unavailable:', e && e.message);
  }
}

async function api(path, opts = {}) {
  const baseUrl = (window.WORKSHOPONE_API_BASE || '').replace(/\/+$/, '');
  const url = (baseUrl ? baseUrl : '') + '/api' + path;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'include',
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

// Shrink a picked file to a data URL, the same way the single-image picker does — 1000px on
// the long edge at JPEG 0.7. These live in the database rather than a folder, so an unresized
// phone photo would put megabytes into every backup.
function resizeToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Could not read that file'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const max = 1000; let w = img.width, h = img.height;
        if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.7));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// Several photos of one thing, up to `max`. Pick many at once or add them one at a time; each
// thumbnail removes itself. Returns { dataURLs, count }.
function multiImageHtml(id, max) {
  return `<div class="imgup" id="${id}" data-max="${max}">
    <div class="mimg-grid" style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0"></div>
    <label class="btn sm" style="cursor:pointer;margin:0">📷 Add photos<input type="file" accept="image/png,image/jpeg,image/webp" multiple style="display:none"></label>
    <span class="muted mimg-count" style="margin-left:8px;font-size:11.5px"></span>
  </div>`;
}
function wireMultiImage(root, id, existing) {
  const box = qs('#' + id, root);
  const max = Number(box.dataset.max) || 6;
  const grid = qs('.mimg-grid', box);
  const counter = qs('.mimg-count', box);
  const fileInput = qs('input[type=file]', box);
  const shots = (existing || []).slice(0, max);
  const draw = () => {
    grid.innerHTML = shots.length ? shots.map((p, i) => `<div style="position:relative">
        <img src="${p}" style="height:88px;width:88px;object-fit:cover;border:1px solid var(--border);border-radius:6px">
        <button type="button" class="btn sm danger" data-rm="${i}" title="Remove this photo"
          style="position:absolute;top:-6px;right:-6px;padding:0 6px;line-height:18px">✕</button>
      </div>`).join('') : '<span class="muted">No photos yet</span>';
    counter.textContent = `${shots.length} of ${max}`;
    // Silently ignoring the 7th would read as a bug, so the button goes away at the limit.
    qs('label', box).style.display = shots.length >= max ? 'none' : '';
    qsa('[data-rm]', grid).forEach((b) => { b.onclick = () => { shots.splice(Number(b.dataset.rm), 1); draw(); }; });
  };
  fileInput.onchange = async (e) => {
    const files = [...e.target.files];
    fileInput.value = '';
    const room = max - shots.length;
    if (files.length > room) toast(`Only ${room} more photo${room === 1 ? '' : 's'} fit — the rest were skipped`, 'err');
    for (const f of files.slice(0, room)) {
      try { shots.push(await resizeToDataUrl(f)); draw(); } catch (err) { toast(err.message, 'err'); }
    }
  };
  draw();
  return { dataURLs: () => shots.slice(), count: () => shots.length };
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

// ---- shared job-card menu used by every "pick a job card" box ----
// A machine can be carrying more than one card left open — sometimes four, raised years
// apart and all still REQUESTED, so nothing on screen says which is the live one. Offering
// them side by side is how today's work ends up logged against a 2023 card. The menu asks
// the server for one row per machine (its newest card) and parks the rest behind
// "+N older" — one click away, never gone.
const JOB_MENU_URL = '/jobs?open=1&one_per_asset=1&limit=25&q=';

function jobMenuRow(j, cls, indent) {
  // "other", not "older": search by an old job number and the row shown IS the old card, so
  // the cards behind the badge are the newer ones.
  const more = j.open_siblings > 0
    ? ` <span class="jmore" data-asset="${j.asset_id}" style="text-decoration:underline;cursor:pointer">+${j.open_siblings} other card${j.open_siblings > 1 ? 's' : ''}</span>`
    : '';
  return `<div class="${cls}" data-id="${j.id}" data-no="${esc(j.job_no || '')}" data-veh="${esc(vehText(j))}" data-assetid="${j.asset_id == null ? '' : j.asset_id}"
      style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)${indent ? ';padding-left:26px' : ''}">
      <b>${esc(j.job_no || '')}</b> <span class="muted">· ${esc(vehText(j) || 'no vehicle')} · ${esc(j.status || '')}</span>${more}</div>`;
}

// Clicking a row picks that card; clicking "+N older" lists the machine's other open cards
// underneath instead. Re-entrant, so the freshly inserted rows get wired too.
function wireJobMenu(menu, cls, pick) {
  qsa('.' + cls, menu).forEach((it) => { it.onmousedown = (e) => { e.preventDefault(); pick(it); }; });
  qsa('.jmore', menu).forEach((el) => {
    el.onmousedown = async (e) => {
      // Without stopPropagation the row underneath would select the newest card and close
      // the menu — the opposite of what the user just asked for.
      e.preventDefault();
      e.stopPropagation();
      if (el.dataset.busy) return;   // a second click mid-fetch would splice the rows in twice
      el.dataset.busy = '1';
      const row = el.closest('.' + cls);
      el.textContent = 'loading…';
      let rows = [];
      try { rows = await api('/jobs?open=1&limit=20&asset_id=' + encodeURIComponent(el.dataset.asset)); }
      catch (err) { el.textContent = 'could not load'; delete el.dataset.busy; return; }
      const others = rows.filter((j) => String(j.id) !== row.dataset.id);
      if (!others.length) { el.textContent = 'no others still open'; return; }
      el.remove();
      row.insertAdjacentHTML('afterend', others.map((j) => jobMenuRow(j, cls, true)).join(''));
      wireJobMenu(menu, cls, pick);
    };
  });
}

// ---- request-target picker: General item OR Machine/Vehicle → pick a job card ----
function targetPickerHtml(idp, opts) {
  const o = opts || {};
  return `<label>${esc(o.label || 'Request for')}</label>
    <div class="pill-row" style="margin-bottom:6px">
      <label style="font-weight:400"><input type="radio" name="${idp}_type" value="general" checked style="width:auto"> ${esc(o.generalLabel || 'General item')}</label>
      <label style="font-weight:400"><input type="radio" name="${idp}_type" value="vehicle" style="width:auto"> Machine / Vehicle</label>
    </div>
    ${o.generalVehicle ? `<div id="${idp}_gveh" style="margin-bottom:6px">
      <input type="text" id="${idp}_gv" autocomplete="off" placeholder="Vehicle / Reg No — optional (e.g. LD-8875)">
      <div class="muted" style="font-size:12px;margin-top:4px">Leave blank for workshop-only work. Name a vehicle and the cost is booked to it — its job card is used, or one is created and closed on this date.</div>
    </div>` : ''}
    <div id="${idp}_veh" style="display:none;position:relative">
      <input type="text" id="${idp}_jq" autocomplete="off" placeholder="Search job no / vehicle no / E&C no…">
      <div id="${idp}_menu" style="position:absolute;z-index:60;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:var(--shadow);max-height:220px;overflow:auto;display:none"></div>
      <div id="${idp}_sel" class="muted" style="font-size:12px;margin-top:4px">Pick the job card this is for.</div>
    </div>`;
}
function wireTargetPicker(root, idp) {
  const state = { type: 'general', job_id: '', asset_code: '', job_no: '' };
  const veh = qs('#' + idp + '_veh', root), jq = qs('#' + idp + '_jq', root), menu = qs('#' + idp + '_menu', root), sel = qs('#' + idp + '_sel', root);
  // Optional "which vehicle?" box on the General option (daily work only — absent elsewhere).
  const gveh = qs('#' + idp + '_gveh', root), gv = qs('#' + idp + '_gv', root);
  qsa('input[name=' + idp + '_type]', root).forEach((r) => { r.onchange = () => { state.type = r.value; veh.style.display = state.type === 'vehicle' ? 'block' : 'none'; if (gveh) gveh.style.display = state.type === 'general' ? 'block' : 'none'; if (state.type === 'general') { state.job_id = ''; state.asset_code = ''; state.job_no = ''; } }; });
  let deb;
  const search = async () => {
    const q = jq.value.trim(); if (!q) { menu.style.display = 'none'; return; }
    let rows = []; try { rows = await api(JOB_MENU_URL + encodeURIComponent(q)); } catch (e) { return; }
    menu.innerHTML = rows.length
      ? rows.map((j) => jobMenuRow(j, 'tpick')).join('')
      : '<div class="muted" style="padding:8px 10px">No matching <b>open</b> job card</div>';
    menu.style.display = 'block';
    wireJobMenu(menu, 'tpick', (it) => {
      state.job_id = it.dataset.id; state.asset_code = it.dataset.veh; state.job_no = it.dataset.no;
      jq.value = it.dataset.no;
      sel.innerHTML = `Job <b>${esc(it.dataset.no)}</b> · ${esc(it.dataset.veh || 'no vehicle')}`;
      menu.style.display = 'none';
    });
  };
  jq.oninput = () => { clearTimeout(deb); deb = setTimeout(search, 220); };
  jq.onblur = () => setTimeout(() => { menu.style.display = 'none'; }, 150);
  return () => ({ ...state, general_vehicle: gv ? gv.value.trim() : '' });
}

// ---- issue target: a job card, always -------------------------------------
// Every stock issue names a job card — the vehicle is derived from it, so the two can
// never disagree. Consumption that isn't vehicle-specific goes to the General Workshop
// card, offered here as one click rather than a silent fallback.
function jobPickerHtml(idp, opts = {}) {
  return `<label>${esc(opts.label || 'Job card *')}</label>
    <div style="position:relative">
      <input type="text" id="${idp}_q" autocomplete="off" placeholder="Search job no / vehicle no / E&C no…">
      <div id="${idp}_menu" style="position:absolute;z-index:60;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:var(--shadow);max-height:220px;overflow:auto;display:none"></div>
    </div>
    <div class="pill-row" style="margin-top:5px;align-items:center">
      <button type="button" class="sm" id="${idp}_gen">General Workshop (no vehicle)</button>
      <span id="${idp}_sel" class="muted" style="font-size:12px">The cost lands on this job card.</span>
    </div>`;
}
function wireJobPicker(root, idp) {
  const state = { job_id: '', job_no: '', vehicle: '', asset_id: '' };
  const q = qs('#' + idp + '_q', root), menu = qs('#' + idp + '_menu', root), sel = qs('#' + idp + '_sel', root);
  const show = () => {
    sel.innerHTML = state.job_id
      ? `→ <b>${esc(state.job_no)}</b>${state.vehicle ? ' · ' + esc(state.vehicle) : ' · no vehicle'}`
      : 'The cost lands on this job card.';
  };
  // The machine comes back with the card so callers can ask "what is on the shelf for this
  // VEHICLE" rather than for this one card — the two differ whenever a machine has more than
  // one card open, and the shelf belongs to the machine.
  const pick = (id, no, vehicle, assetId) => {
    state.job_id = String(id); state.job_no = no; state.vehicle = vehicle || '';
    state.asset_id = assetId == null ? '' : String(assetId);
    q.value = no; menu.style.display = 'none'; show();
  };
  let deb;
  q.oninput = () => {
    state.job_id = ''; show();
    clearTimeout(deb);
    deb = setTimeout(async () => {
      const term = q.value.trim();
      if (!term) { menu.style.display = 'none'; return; }
      let rows = [];
      try { rows = await api(JOB_MENU_URL + encodeURIComponent(term)); } catch (e) { return; }
      menu.innerHTML = rows.length
        ? rows.map((j) => jobMenuRow(j, 'jpick')).join('')
        : '<div class="muted" style="padding:8px 10px">No matching <b>open</b> job card</div>';
      menu.style.display = 'block';
      wireJobMenu(menu, 'jpick', (it) => pick(it.dataset.id, it.dataset.no, it.dataset.veh, it.dataset.assetid));
    }, 220);
  };
  q.onblur = () => setTimeout(() => { menu.style.display = 'none'; }, 150);
  qs('#' + idp + '_gen', root).onclick = async () => {
    try { const g = await api('/stores/general-job'); pick(g.id, g.job_no, '', ''); }
    catch (e) { toast(e.message, 'err'); }
  };
  return () => state;
}

/** POST an issue, asking for confirmation if the chosen job card is already closed. */
async function postIssue(payload) {
  try { return await api('/stores/issues', { method: 'POST', body: payload }); }
  catch (e) {
    if (!(e.data && e.data.needs_confirm)) throw e;
    if (!confirm(`${e.data.job_no} is ${e.data.job_status}. Record this issue against it anyway?`)) return null;
    return api('/stores/issues', { method: 'POST', body: { ...payload, allow_closed: true } });
  }
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
  item_category: ['stores', 'generalstock', 'stockissues'],
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

// When an item arrived. This is the browser copy of receivedLabel() in
// src/lib/received_date.js — the same three answers, so a screen and the Excel of that screen
// never disagree. Keep them in step: the date comes from the goods-received notes
// (delivery_date) and never from the received QUANTITY, a line holding nothing shows nothing,
// and a line that arrived over several dates says so instead of reporting only the last van.
const receivedLabel = (r) => {
  const last = String((r && r.last_received) || '').slice(0, 10);
  const first = String((r && r.first_received) || '').slice(0, 10);
  const days = Number(r && r.receipt_days) || 0;
  const rec = Number(r && (r.qty_received != null ? r.qty_received : r.received)) || 0;
  if (rec <= 0) return { text: '', title: '', split: 0 };
  if (!last) return { text: 'not recorded', title: 'Recorded as received, but no goods-received note carries a date for it', split: 0 };
  if (days > 1 && first && first !== last) return { text: last, title: `Received on ${days} dates, ${first} to ${last}`, split: days - 1 };
  return { text: last, title: '', split: 0 };
};

// A column of its own.
const receivedDate = (r) => {
  const l = receivedLabel(r);
  if (!l.text) return '<span class="muted">—</span>';
  if (l.text === 'not recorded') return `<span class="muted" title="${esc(l.title)}">not recorded</span>`;
  return l.split
    ? `${esc(l.text)} <span class="badge blue" title="${esc(l.title)}">+${l.split}</span>`
    : esc(l.text);
};

// The same fact tucked under a received QUANTITY, for tables with no room for a column of its
// own. Silent only where there is nothing to say — a quantity with no note still warns, or the
// one line in that state would look ordinary here and flagged everywhere else.
const receivedUnder = (r) => {
  const l = receivedLabel(r);
  if (!l.text) return '';
  return `<div class="muted" style="font-size:10px;font-weight:400;white-space:nowrap"
    title="${esc(l.title || 'Received ' + l.text)}">${esc(l.text)}${l.split ? ` +${l.split}` : ''}</div>`;
};

// ---- item category tree (Category → Sub-category) --------------------------
// Fetched once per page load and shared by every picker. A record is always saved
// against a SUB-category id; the server derives the parent label it stores in the
// free-text `category` column. Any edit on the Categories tab invalidates the cache.
let CAT_TREE = null;
async function catTree(force) {
  if (!CAT_TREE || force) CAT_TREE = (await api('/stores/categories/tree?active=1')).tree;
  return CAT_TREE;
}
const catInvalidate = () => { CAT_TREE = null; };
// "General" sorts first so choosing only a Category still yields a sensible sub.
const catSubs = (p) => [...p.subs].sort((a, b) => (a.name === 'General' ? -1 : b.name === 'General' ? 1 : 0));

let _catPickerSeq = 0;
/** Two linked selects. The SUB select carries the submitted name (default category_id). */
function categoryPickerHtml(opts = {}) {
  const idp = opts.idp || 'catp' + (++_catPickerSeq);
  const name = opts.name || 'category_id';
  return `<div class="catpick" data-idp="${idp}" data-name="${name}">
    ${opts.label === null ? '' : `<label>${esc(opts.label || 'Category')}</label>`}
    <div class="row">
      <select id="${idp}_p"><option value="">— none —</option></select>
      <select id="${idp}_s" name="${name}"><option value="">—</option></select>
    </div></div>`;
}
/** Fill every picker inside `root` from the tree; optionally preselect a sub-category. */
async function wireCategoryPickers(root, selectedId) {
  const tree = await catTree();
  qsa('.catpick', root).forEach((pick) => {
    const idp = pick.dataset.idp;
    const pSel = qs('#' + idp + '_p', pick), sSel = qs('#' + idp + '_s', pick);
    const owner = selectedId ? tree.find((p) => p.subs.some((s) => String(s.id) === String(selectedId))) : null;
    pSel.innerHTML = '<option value="">— none —</option>'
      + tree.map((p) => `<option value="${p.id}" ${owner && owner.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const fill = () => {
      const p = tree.find((x) => String(x.id) === String(pSel.value));
      sSel.innerHTML = p
        ? catSubs(p).map((s) => `<option value="${s.id}" ${String(s.id) === String(selectedId) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
        : '<option value="">—</option>';
    };
    pSel.onchange = fill;
    fill();
  });
}
/** Point a picker at a sub-category id (used when picking an item auto-fills it). */
function setCategoryPicker(root, categoryId) {
  if (!categoryId || !CAT_TREE) return;
  const owner = CAT_TREE.find((p) => p.subs.some((s) => String(s.id) === String(categoryId)));
  if (!owner) return;
  qsa('.catpick', root).forEach((pick) => {
    const idp = pick.dataset.idp;
    const pSel = qs('#' + idp + '_p', pick), sSel = qs('#' + idp + '_s', pick);
    pSel.value = owner.id;
    sSel.innerHTML = catSubs(owner).map((s) => `<option value="${s.id}" ${String(s.id) === String(categoryId) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  });
}
const catPath = (row) => (row.parent_category || row.category || '') + (row.sub_category ? ' › ' + row.sub_category : '');

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
  bg.innerHTML = `<div class="modal${opts.wide ? ' wide' : ''}"><h2>${esc(title)}</h2><div class="mbody">${bodyHtml}</div></div>`;
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
  ['serviceplan', '🗓️', 'Service & Filter Plan'],
  ['projects', '🏗️', 'Projects'],
  ['aliases', '🔗', 'Alias Queue'],
  ['attention', '⚠️', 'Needs Attention'],
  ['progress', '📆', 'Daily Progress'],
  ['teardown', '📉', 'Cost Teardown'],
  ['tbrequests', '🛞', 'Tyre & Battery Requests'],
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
  // The request screen belongs to whoever may raise one. The ledger above stays on 'reports',
  // because reading what was issued is a different question from being allowed to issue it.
  tbrequests: 'tb_request',
  matreq: 'stores', stockissues: 'stores', generalstock: 'stores', filterstock: 'filters', serviceplan: 'filters',
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
  assets: 'Fleet', serviceplan: 'Fleet',
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
  qs('#logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    live('disconnect');   // the socket holds the session of whoever just left
    ME = null; location.hash = ''; boot();
  };
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
  const th = headers.map((h) => {
    const cls = [h.num ? 'num' : '', h.cls || ''].filter(Boolean).join(' ');
    const style = h.width ? `style="width:${h.width}"` : '';
    // `html: true` lets a caller put controls (e.g. sort links) in a header cell.
    return `<th class="${cls}" ${style}>${h.html ? h.label : esc(h.label)}</th>`;
  }).join('');
  const body = rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="muted" style="text-align:center;padding:20px">No records</td></tr>`;
  const wrapCls = ['table-wrap', opts.scroll ? 'scroll' : '', opts.noHScroll ? 'no-hscroll' : ''].filter(Boolean).join(' ');
  const tblCls = opts.fit ? 'fit-table' : '';
  return `<div class="${wrapCls}"><table class="${tblCls}"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
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
        <span class="badge ${na.vehicle_conflicts ? 'amber' : ''}">Vehicles with 2+ open jobs: ${na.vehicle_conflicts || 0}</span>
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
    <div id="jconflicts"></div>
    <div id="jtable"><div class="muted">Loading…</div></div>`;

  loadVehicleConflicts(qs('#jconflicts'));

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
    const canCloseDate = can('operational_manager', 'workshop', 'manager');
    // Mirrors jobstate.canReopen — keep the two in step if the roles change.
    const canReopenJob = can('operational_manager', 'workshop', 'manager');
    const rows = list.map((j) => `<tr>
      <td><a href="#/jobs/${j.id}">${esc(j.job_no)}</a></td>
      <td class="desc-col">${vehText(j) ? `<span class="stamp">${esc(vehText(j))}</span>` : '—'}</td>
      <td class="desc-col" title="${esc(j.description || '')}">${esc(j.description || '')}</td>
      <td><span class="badge ${j.type === 'service' ? 'blue' : ''}">${esc(j.type)}</span></td>
      <td>${statusBadge(j.status)}</td>
      <td class="desc-col">${esc(j.project_name || '')}</td>
      <td class="num">${j.labour_cost ? money(j.labour_cost) : '—'}</td>
      <td class="num">${j.material_cost ? money(j.material_cost) : '—'}</td>
      <td class="num">${money(j.total_cost)}</td>
      <td class="muted">${esc((j.requested_at || '').slice(0, 10))}</td>
      <td>${canCloseDate && j.status !== 'CLOSED' && j.status !== 'REJECTED'
        ? `<button class="sm" data-closedate="${j.id}" data-jobno="${esc(j.job_no)}" title="Close this card on a chosen (past) date">📅 Close…</button>`
        : (j.status === 'CLOSED' && canReopenJob ? `<button class="sm danger" data-reopen="${j.id}" data-jobno="${esc(j.job_no)}" data-closed="${esc((j.completed_at || j.closed_at || '').slice(0, 10))}" title="Reopen this closed job card">↩ Reopen…</button>` : '')}</td></tr>`);
    const labTotal = list.reduce((s, j) => s + (Number(j.labour_cost) || 0), 0);
    const matTotal = list.reduce((s, j) => s + (Number(j.material_cost) || 0), 0);
    qs('#jcount').textContent = list.length ? `${list.length}${list.length === 500 ? '+' : ''} job${list.length === 1 ? '' : 's'}${labTotal ? ' · labour ' + money(labTotal) : ''}${matTotal ? ' · material ' + money(matTotal) : ''}` : '';
    // fit-table + wrapping text columns → the whole table fits the window at any size (no
    // horizontal scroll); the box keeps its vertical scrollbar for the long list.
    qs('#jtable').innerHTML = list.length
      ? tableWrap([
          { label: 'Job No', width: '104px' },
          { label: 'Asset', cls: 'desc-col', width: '124px' },
          { label: 'Description', cls: 'desc-col' },
          { label: 'Type', width: '72px' },
          { label: 'Status', width: '110px' },
          { label: 'Project', cls: 'desc-col', width: '110px' },
          { label: 'Labour', num: true, width: '94px' },
          { label: 'Material', num: true, width: '100px' },
          { label: 'Total', num: true, width: '100px' },
          { label: 'Requested', width: '92px' },
          { label: '', width: '92px' },
        ], rows, { scroll: true, fit: true, noHScroll: true })
      : '<div class="card"><p class="muted">No job cards match your search.</p></div>';
    qsa('[data-closedate]', c).forEach((b) => b.onclick = () => closeOnDateModal(b.dataset.closedate, b.dataset.jobno, load));
    qsa('[data-reopen]', c).forEach((b) => b.onclick = () => reopenJobModal(
      { id: b.dataset.reopen, job_no: b.dataset.jobno, completed_at: b.dataset.closed }, load));
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

  const initialMonth = date.slice(0, 7);

  c.innerHTML = `${pageHeader('Daily Work')}
    <div class="card section">
      <div class="toolbar" style="margin-top:0">
        <h3 style="margin:0">Monthly Labour Working Hours</h3>
        <span class="muted" style="font-weight:400">— selected month total hours &amp; each laborer's monthly working hours</span>
        <div class="spacer"></div>
        <div><label>Month</label><select id="dwm-month" style="max-width:190px"></select></div>
        <a class="btn sm" id="dwm-dl" href="#" target="_blank">⬇ Excel Summary</a>
      </div>
      <div id="dwm-stats" class="grid section" style="margin-bottom:12px"></div>
      <div class="toolbar" style="margin:0 0 6px">
        <input id="dwm-search" type="search" placeholder="Search laborer / mechanic…" style="max-width:240px">
        <div class="spacer"></div>
        <span class="muted" id="dwm-count"></span>
      </div>
      <div id="dwm-table"><div class="muted">Loading monthly working hours…</div></div>
    </div>

    <div class="card section">
      <div class="toolbar" style="margin-top:0">
        <h3 style="margin:0">Month-Wise Daily Work Entries (Time Update)</h3>
        <span class="muted" style="font-weight:400">— check full month list &amp; update working hours</span>
        <div class="spacer"></div>
        ${can('workshop', 'manager') ? '<button class="primary sm" id="dw-save-all-btn" disabled style="margin-right:6px">💾 Save Changes</button>' : ''}
        <div><label>Laborer</label><select id="dw-mech-select" style="max-width:180px"><option value="">All Laborers</option></select></div>
        <input id="dw-month-search" type="search" placeholder="Filter vehicle / desc / job…" style="max-width:220px">
        <a class="btn sm" id="dw-month-log-dl" href="#" target="_blank">⬇ Excel Month Log</a>
      </div>
      <div id="dw-month-entries-table"><div class="muted">Loading month work log…</div></div>
      <div style="margin-top:8px;text-align:right"><span class="muted" id="dw-month-sum"></span></div>
    </div>

    <div class="card section">
      <div class="toolbar" style="margin-top:0">
        <h3 style="margin:0">Daily Work Log (Day View)</h3>
        <div class="spacer"></div>
        ${can('workshop', 'manager') ? '<button class="primary sm" id="dadd">+ Add Work Done</button>' : ''}
        <button class="sm" id="dprev">← Older</button>
        <input id="ddate" type="date" value="${esc(date)}" style="max-width:170px">
        <button class="sm" id="dnext">Newer →</button>
        <select id="ddays" style="max-width:260px">${days.map((d) => `<option value="${d.date}" ${d.date === date ? 'selected' : ''}>${d.date} · ${d.entries} entr${d.entries === 1 ? 'y' : 'ies'} · ${d.hours || 0}h</option>`).join('')}</select>
        <input id="dq" type="search" placeholder="Filter vehicle / mechanic…" style="max-width:220px">
      </div>
      <div id="dtable"><div class="muted">Loading…</div></div>
      <div style="margin-top:8px;text-align:right"><span class="muted" id="dsum"></span></div>
    </div>`;

  const canEdit = can('workshop', 'manager');
  let currentMonthlyData = null;
  const pendingEdits = new Map();

  const updateSaveButtonState = () => {
    const btn = qs('#dw-save-all-btn');
    if (!btn) return;
    if (pendingEdits.size > 0) {
      btn.disabled = false;
      btn.textContent = `💾 Save Changes (${pendingEdits.size})`;
      btn.classList.add('primary');
    } else {
      btn.disabled = true;
      btn.textContent = '💾 Save Changes';
    }
  };

  const renderMonthlyTable = () => {
    if (!currentMonthlyData) return;
    const q = (qs('#dwm-search').value || '').trim().toLowerCase();
    const list = (currentMonthlyData.labor_summary || []).filter((l) => !q || l.mechanic.toLowerCase().includes(q));
    qs('#dwm-count').textContent = `${list.length} laborer${list.length === 1 ? '' : 's'}`;
    const rows = list.map((l) => `<tr>
      <td><b>${esc(l.mechanic)}</b></td>
      <td class="num"><b>${num(l.total_hours)} hrs</b></td>
      <td class="num">${l.rate === 0 ? '<span class="badge blue">Staff / Foreman (Rs 0/h)</span>' : (l.rate != null ? money(l.rate) + '/h' : '<span class="badge amber">no rate</span>')}</td>
      <td class="num">${money(l.total_cost)}</td>
      <td class="num">${l.entries}</td>
    </tr>`);
    qs('#dwm-table').innerHTML = list.length
      ? tableWrap([{ label: 'Laborer / Mechanic' }, { label: 'Monthly Working Hours', num: true }, { label: 'Hourly Rate', num: true }, { label: 'Monthly Labour Cost', num: true }, { label: 'Work Entries', num: true }], rows, { scroll: true })
      : '<p class="muted">No laborer records match search.</p>';
  };

  const populateMechanicFilter = (mechanicsList) => {
    const sel = qs('#dw-mech-select');
    if (!sel) return;
    const curVal = sel.value;
    sel.innerHTML = '<option value="">All Laborers</option>' + (mechanicsList || []).map((l) => `<option value="${esc(l.mechanic)}">${esc(l.mechanic)} (${l.total_hours}h)</option>`).join('');
    if (curVal && sel.querySelector(`option[value="${CSS.escape ? CSS.escape(curVal) : curVal}"]`)) {
      sel.value = curVal;
    }
  };

  const silentRefreshMonthlyStats = async (m, curMech) => {
    try {
      const data = await api('/daily-work/monthly-summary?month=' + encodeURIComponent(m));
      currentMonthlyData = data;
      if (qs('#dwm-stats')) {
        qs('#dwm-stats').innerHTML = `
          <div class="card stat"><span class="n">${num(data.total_line_hours)} hrs</span><span class="l">${esc(data.month_label)} Total Hours</span></div>
          <div class="card stat"><span class="n">${moneyC(data.total_labour_cost)}</span><span class="l">Monthly Labour Cost</span></div>
          <div class="card stat"><span class="n">${data.mechanics_count}</span><span class="l">Active Laborers</span></div>
          <div class="card stat"><span class="n">${data.entries_count}</span><span class="l">Total Work Entries</span></div>
        `;
      }
      renderMonthlyTable();
      populateMechanicFilter(data.labor_summary);

      const q = qs('#dw-month-search') ? qs('#dw-month-search').value.trim() : '';
      const mData = await api(`/daily-work/month?month=${encodeURIComponent(m)}${curMech ? '&mechanic=' + encodeURIComponent(curMech) : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`);
      if (qs('#dw-month-sum')) {
        qs('#dw-month-sum').textContent = `${mData.count} entr${mData.count === 1 ? 'y' : 'ies'} · ${mData.total_hours || 0} hrs · ${money(mData.total_labour || 0)} labour`;
      }
    } catch (_) {}
  };

  const loadMonthEntries = async (m) => {
    pendingEdits.clear();
    updateSaveButtonState();
    const tableEl = qs('#dw-month-entries-table');
    if (!tableEl) return;
    const mech = qs('#dw-mech-select') ? qs('#dw-mech-select').value : '';
    const q = qs('#dw-month-search') ? qs('#dw-month-search').value.trim() : '';

    qs('#dw-month-log-dl').href = `/api/daily-work/month?month=${encodeURIComponent(m)}${mech ? '&mechanic=' + encodeURIComponent(mech) : ''}${q ? '&q=' + encodeURIComponent(q) : ''}&format=xlsx`;

    try {
      const data = await api(`/daily-work/month?month=${encodeURIComponent(m)}${mech ? '&mechanic=' + encodeURIComponent(mech) : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`);
      const rows = data.entries.map((e) => {
        const hoursCell = e.is_external
          ? '<span class="badge">external</span>'
          : (canEdit
            ? `<input type="number" step="0.5" min="0" value="${Number(e.hours) || 0}" data-mhours="${e.id}" data-orig="${Number(e.hours) || 0}" class="dw-hours-input" style="width:64px;text-align:right">`
            : (Number(e.hours) || 0));
        const costCell = e.is_external
          ? money(e.external_value)
          : money(e.labour_cost) + (e.unrated && e.unrated.length ? ` <span class="badge amber" title="No rate for: ${esc(e.unrated.join(', '))}">no rate</span>` : '');
        const outsideCell = canEdit
          ? `<input type="number" step="0.01" min="0" value="${e.outside_labour == null ? '' : e.outside_labour}" data-mout="${e.id}" data-orig="${e.outside_labour == null ? '' : e.outside_labour}" class="dw-outside-input" placeholder="—" style="width:96px;text-align:right">`
          : (e.outside_labour == null ? '—' : money(e.outside_labour));
        // No inline nowrap here. It beat every stylesheet rule, so a four-name crew could not wrap
        // inside its column and ran across the Description beside it. Let the stylesheet decide.
        return `<tr>
        <td>${esc(e.work_date || '—')}</td>
        <td>${esc(idLabel(e) || '—')}</td>
        <td><a href="#/jobs/${e.job_id}">${esc(e.job_no)}</a></td>
        <td><b>${esc(e.mechanic || '—')}</b></td>
        <td class="desc-col">${esc(e.description || '')}</td>
        <td class="num">${hoursCell}</td>
        <td class="num">${costCell}</td>
        <td class="num">${outsideCell}</td></tr>`;
      });

      qs('#dw-month-sum').textContent = `${data.count} entr${data.count === 1 ? 'y' : 'ies'} · ${data.total_hours || 0} hrs · ${money(data.total_labour || 0)} labour`;
      tableEl.innerHTML = data.entries.length
        ? tableWrap([
            { label: 'Date', width: '92px' },
            { label: 'Vehicle', width: '110px' },
            { label: 'Job No', width: '110px' },
            { label: 'Mechanic / Crew', width: '130px' },
            { label: 'Description', cls: 'desc-col' },
            { label: 'Hours (Time Update)', num: true, width: '80px' },
            { label: 'Labour Cost (Rs)', num: true, width: '115px' },
            { label: 'Outside Labor (Rs)', num: true, width: '110px' }
          ], rows, { scroll: true, noHScroll: true, fit: true })
        : '<div class="card"><p class="muted">No daily work entries match filter for this month.</p></div>';

      if (canEdit) {
        // pendingEdits: id -> { hours?, outside_labour? } — either field alone or both.
        const highlight = (inp, on) => {
          inp.style.background = on ? '#eef6ff' : '';
          inp.style.borderColor = on ? '#2563eb' : '';
          inp.style.fontWeight = on ? 'bold' : '';
        };
        const markEdit = (id, field, val, changed, inp) => {
          const cur = pendingEdits.get(id) || {};
          if (changed) { cur[field] = val; pendingEdits.set(id, cur); highlight(inp, true); }
          else {
            delete cur[field];
            if (Object.keys(cur).length) pendingEdits.set(id, cur); else pendingEdits.delete(id);
            highlight(inp, false);
          }
          updateSaveButtonState();
        };
        qsa('.dw-hours-input', tableEl).forEach((inp) => {
          inp.oninput = () => {
            const orig = parseFloat(inp.dataset.orig) || 0;
            const val = parseFloat(inp.value);
            markEdit(inp.dataset.mhours, 'hours', val, !isNaN(val) && val !== orig, inp);
          };
        });
        qsa('.dw-outside-input', tableEl).forEach((inp) => {
          inp.oninput = () => {
            const changed = inp.value.trim() !== String(inp.dataset.orig).trim();
            // Blank clears the outside value; a number sets it.
            const val = inp.value.trim() === '' ? null : parseFloat(inp.value);
            markEdit(inp.dataset.mout, 'outside_labour', val, changed && (val === null || !isNaN(val)), inp);
          };
        });

        if (qs('#dw-save-all-btn')) {
          qs('#dw-save-all-btn').onclick = async () => {
            if (!pendingEdits.size) return;
            const saveBtn = qs('#dw-save-all-btn');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            try {
              const updates = Array.from(pendingEdits.entries()).map(([id, fields]) => ({ id: parseInt(id, 10), ...fields }));
              const res = await api('/daily-work/batch-update', { method: 'POST', body: { updates } });
              toast(`✓ Successfully updated ${res.updated_count} work entries!`);
              pendingEdits.clear();
              updateSaveButtonState();

              // Reset input styling and origin values
              qsa('.dw-hours-input, .dw-outside-input', tableEl).forEach((inp) => {
                inp.dataset.orig = inp.value;
                inp.style.background = '';
                inp.style.borderColor = '';
                inp.style.fontWeight = '';
              });

              // Silently refresh stats without touching selected laborer or month!
              const curM = qs('#dwm-month').value;
              const curMech = qs('#dw-mech-select').value;
              silentRefreshMonthlyStats(curM, curMech);
            } catch (err) {
              toast(err.message, 'err');
              updateSaveButtonState();
            }
          };
        }
      }
    } catch (e) {
      tableEl.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  };

  const loadMonthly = async (m) => {
    qs('#dwm-table').innerHTML = '<div class="muted">Loading monthly summary…</div>';
    try {
      const data = await api('/daily-work/monthly-summary?month=' + encodeURIComponent(m));
      currentMonthlyData = data;
      const monthSel = qs('#dwm-month');
      if (!monthSel.options.length) {
        monthSel.innerHTML = (data.available_months || []).map((o) => `<option value="${o.month}">${esc(o.label)}</option>`).join('');
      }
      monthSel.value = data.month;
      qs('#dwm-dl').href = `/api/daily-work/monthly-summary?month=${encodeURIComponent(data.month)}&format=xlsx`;

      qs('#dwm-stats').innerHTML = `
        <div class="card stat"><span class="n">${num(data.total_line_hours)} hrs</span><span class="l">${esc(data.month_label)} Total Hours</span></div>
        <div class="card stat"><span class="n">${moneyC(data.total_labour_cost)}</span><span class="l">Monthly Labour Cost</span></div>
        <div class="card stat"><span class="n">${data.mechanics_count}</span><span class="l">Active Laborers</span></div>
        <div class="card stat"><span class="n">${data.entries_count}</span><span class="l">Total Work Entries</span></div>
      `;
      renderMonthlyTable();
      populateMechanicFilter(data.labor_summary);
      loadMonthEntries(m);
    } catch (e) {
      qs('#dwm-table').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  };

  qs('#dwm-month').onchange = (e) => loadMonthly(e.target.value);
  qs('#dwm-search').oninput = () => renderMonthlyTable();
  qs('#dw-mech-select').onchange = () => loadMonthEntries(qs('#dwm-month').value);
  let debM; qs('#dw-month-search').oninput = () => { clearTimeout(debM); debM = setTimeout(() => loadMonthEntries(qs('#dwm-month').value), 250); };

  const dayList = days.map((d) => d.date);
  const go = (dt) => {
    history.replaceState(null, '', '#/dailywork?date=' + dt);
    qs('#ddate').value = dt;
    if (dayList.includes(dt)) qs('#ddays').value = dt;
    const m = dt.slice(0, 7);
    if (qs('#dwm-month') && qs('#dwm-month').value !== m && currentMonthlyData && currentMonthlyData.available_months.some((o) => o.month === m)) {
      loadMonthly(m);
    }
    load(dt);
  };

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
      <td class="desc-col">${esc(e.description || '')}</td>
      <td class="num">${hoursCell}</td>
      <td class="num">${costCell}</td>
      <td class="num">${e.outside_labour ? money(e.outside_labour) : '<span class="muted">—</span>'}</td>
      <td>${canEdit ? `<button class="sm" data-edit="${e.id}" title="Edit this entry">✎</button> <button class="sm danger" data-del="${e.id}" title="Delete this entry">✕</button>` : ''}</td></tr>`;
    });
    qs('#dsum').textContent = `${data.count} entr${data.count === 1 ? 'y' : 'ies'} · ${data.total_hours || 0} hrs · ${money(data.total_labour || 0)} labour`;
    qs('#dtable').innerHTML = data.entries.length
      ? tableWrap([{ label: 'Vehicle' }, { label: 'Job No' }, { label: 'Mechanic' }, { label: 'Description', cls: 'desc-col' }, { label: 'Hours', num: true }, { label: 'Labour (Rs)', num: true }, { label: 'Outside Labor', num: true }, { label: '', width: '78px' }], rows, { scroll: true, fit: true, noHScroll: true })
      : '<div class="card"><p class="muted">No daily work logged on this day.</p></div>';

    // After any change, repaint the day AND the month tables so every total agrees.
    const refreshAll = () => {
      const curM = qs('#dwm-month').value;
      load(qs('#ddate').value);
      loadMonthly(curM);
      loadMonthEntries(curM);
    };
    if (canEdit) {
      qsa('[data-hours]').forEach((inp) => {
        inp.onchange = async () => {
          try { await api('/daily-work/' + inp.dataset.hours, { method: 'PATCH', body: { hours: inp.value } }); toast('Hours updated'); refreshAll(); }
          catch (err) { toast(err.message, 'err'); }
        };
      });
      const byId = new Map(data.entries.map((e) => [String(e.id), e]));
      qsa('[data-edit]').forEach((b) => { b.onclick = () => editWorkDoneModal(byId.get(b.dataset.edit), refreshAll); });
      qsa('[data-del]').forEach((b) => {
        b.onclick = async () => {
          const e = byId.get(b.dataset.del);
          if (!confirm(`Delete this entry?\n\n${e.work_date} · ${idLabel(e) || 'no vehicle'} · ${e.mechanic || 'no mechanic'}\n${e.description || ''}\n${e.hours || 0} hrs\n\nThe job total and the month's labour are recalculated.`)) return;
          try { await api('/daily-work/' + b.dataset.del, { method: 'DELETE' }); toast('Entry deleted'); refreshAll(); }
          catch (err) { toast(err.message, 'err'); }
        };
      });
    }
  };

  qs('#ddate').onchange = (e) => go(e.target.value);
  qs('#ddays').onchange = (e) => go(e.target.value);
  qs('#dprev').onclick = () => { const older = dayList.filter((x) => x < qs('#ddate').value); if (older.length) go(older[0]); };
  qs('#dnext').onclick = () => { const newer = dayList.filter((x) => x > qs('#ddate').value); if (newer.length) go(newer[newer.length - 1]); };
  let deb; qs('#dq').oninput = () => { clearTimeout(deb); deb = setTimeout(() => load(qs('#ddate').value), 250); };
  if (qs('#dadd')) qs('#dadd').onclick = () => addWorkDoneModal(qs('#ddate').value, (newDate) => { go(newDate); loadMonthly(newDate.slice(0, 7)); });

  await Promise.all([loadMonthly(initialMonth), load(date)]);
};

// Log a single daily-work entry from the Daily Work section (day by day).
async function addWorkDoneModal(defaultDate, onDone) {
  let mechs = [];
  try { mechs = await api('/mechanics'); } catch (e) { /* falls back to an empty list */ }
  const mechOpts = mechs.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}${m.rate != null ? ' · Rs ' + m.rate + '/h' : ' · no rate'}</option>`).join('');
  modal('Add Work Done', `
    ${field('Date', 'work_date', { type: 'date', value: defaultDate })}
    ${targetPickerHtml('dwt', { label: 'Work for', generalLabel: 'General workshop', generalVehicle: true })}
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
        const r = await api('/daily-work', { method: 'POST', body: { ...f, request_type: t.type, job_id: t.type === 'vehicle' ? t.job_id : undefined, asset: t.type === 'general' ? t.general_vehicle : undefined } });
        toast('Logged to job ' + r.job_no + (r.auto_created ? ` — new card created & closed ${r.date}` : '') + (r.unresolved ? ' · vehicle not recognised, queued in Alias Queue' : ''));
        close();
        onDone(r.date);
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// Edit one logged daily-work entry (date / mechanics / description / hours / outside labor).
// The job card it belongs to is shown but not changed here — move work between cards by
// deleting the line and logging it again against the right card.
async function editWorkDoneModal(entry, onDone) {
  if (!entry) return toast('Entry not found — refresh the day', 'err');
  let mechs = [];
  try { mechs = await api('/mechanics'); } catch (e) { /* falls back to typing names */ }
  const mechOpts = mechs.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}${m.rate != null ? ' · Rs ' + m.rate + '/h' : ' · no rate'}</option>`).join('');
  modal('Edit Work Done', `
    <p class="muted" style="margin-top:0;font-size:12px">Job <b>${esc(entry.job_no || '—')}</b> · ${esc(idLabel(entry) || 'no vehicle')}</p>
    ${field('Date', 'work_date', { type: 'date', value: String(entry.work_date || '').slice(0, 10) })}
    ${field('Description of work', 'description', { value: entry.description || '' })}
    <label>Mechanic(s)</label>
    <select id="ewmech"><option value="">— add a mechanic —</option>${mechOpts}</select>
    <div id="ewcrew" class="pill-row" style="margin:6px 0;min-height:6px"></div>
    <input type="hidden" name="mechanic">
    <div class="row">${field('Hours', 'hours', { type: 'number', value: Number(entry.hours) || 0 })}${field('Outside labor (Rs)', 'outside_labour', { type: 'number', value: entry.outside_labour == null ? '' : entry.outside_labour })}</div>
    <p class="muted" style="font-size:12px;margin:2px 0 0">Each mechanic is charged the full hours at their own rate. Outside labor is what this work would cost sent out — leave blank to clear it.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save changes</button></div>`, (body, close) => {
    const crew = String(entry.mechanic || '').split(/\s*(?:,|&|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
    const hidden = qs('input[name=mechanic]', body);
    const chips = qs('#ewcrew', body);
    const paint = () => {
      hidden.value = crew.join(', ');
      chips.innerHTML = crew.length ? crew.map((n) => `<span class="badge blue" data-rm="${esc(n)}" style="cursor:pointer" title="Remove">${esc(n)} ✕</span>`).join('') : '<span class="muted" style="font-size:12px">No mechanic on this line</span>';
      qsa('[data-rm]', chips).forEach((el) => { el.onclick = () => { const i = crew.indexOf(el.dataset.rm); if (i >= 0) crew.splice(i, 1); paint(); }; });
    };
    qs('#ewmech', body).onchange = (e) => { const v = e.target.value; if (v && !crew.includes(v)) { crew.push(v); paint(); } e.target.value = ''; };
    paint();
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      try {
        await api('/daily-work/' + entry.id, { method: 'PATCH', body: {
          work_date: f.work_date, description: f.description, mechanic: hidden.value,
          hours: f.hours, outside_labour: f.outside_labour === '' ? null : f.outside_labour,
        } });
        toast('Entry updated'); close(); if (onDone) onDone();
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
    <td class="num">${m.rate === 0 ? '<span class="badge blue">Staff / Foreman (Rs 0/h)</span>' : (m.rate != null ? money(m.rate) + '/hr' : '<span class="badge amber">no rate</span>')}</td>
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

// ---- vehicle conflicts: more than one open card on the same vehicle --------
// These predate the one-open-card rule, which only stops NEW ones. Collapsed by
// default — it's a backlog to work off, not an error.
async function loadVehicleConflicts(el) {
  let d;
  try { d = await api('/jobs/duplicates'); } catch (e) { return; }
  if (!d.vehicle_count) { el.innerHTML = ''; return; }
  el.innerHTML = `<details class="card section" style="border-left:4px solid var(--amber);margin-bottom:12px">
    <summary style="cursor:pointer"><b>⚠ ${num(d.vehicle_count)} vehicle${d.vehicle_count === 1 ? '' : 's'} with more than one open job card</b>
      <span class="muted"> — ${num(d.job_count)} cards. New duplicates are blocked; close these off when you can.</span></summary>
    <div style="margin-top:10px">${d.vehicles.map((v) => `
      <div class="cost-line" style="align-items:flex-start">
        <span><b>${esc(idLabel(v) || v.asset_code)}</b> <span class="badge amber">${v.open_count} open</span></span>
        <span style="text-align:right">${v.jobs.map((j) => `<div><a href="#/jobs/${j.id}">${esc(j.job_no)}</a> ${statusBadge(j.status)}
          <span class="muted" style="font-size:11px">${j.age_days != null ? j.age_days + 'd old' : ''}${j.total_cost ? ' · ' + money(j.total_cost) : ''}</span></div>`).join('')}</span>
      </div>`).join('')}</div></details>`;
}

async function newJobModal() {
  const projects = await api('/projects');
  const popts = [{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
  modal('New Job Card', `
    <p class="muted">One open job card per vehicle — if this vehicle already has one, close it first or add the work to it.</p>
    ${assetPickerHtml('Vehicle / machine *')}
    <div id="njblock" style="margin:4px 0"></div>
    <div class="row">${field('Type', 'type', { type: 'select', options: [{ value: 'repair', label: 'repair' }, { value: 'service', label: 'service' }] })}${field('Severity', 'severity', { type: 'select', options: [{ value: '', label: '—' }, { value: 'major', label: 'major' }, { value: 'minor', label: 'minor' }] })}</div>
    ${field('Project', 'project_id', { type: 'select', options: popts })}
    ${field('Description *', 'description', { type: 'textarea' })}
    <div style="margin-top:14px;text-align:right"><button class="primary" id="save">Raise Job Card</button></div>`, (body, close) => {
    wireAssetPicker(body);
    const blockEl = qs('#njblock', body), saveBtn = qs('#save', body);
    const hidden = qs('input[name=asset_id]', body), input = qs('.apick-input', body);

    // Check the moment a vehicle is picked, so the block shows before the form is filled.
    const check = async () => {
      blockEl.innerHTML = '';
      saveBtn.disabled = false;
      if (!hidden.value) return;
      let r;
      try { r = await api('/jobs/open-for/' + encodeURIComponent(hidden.value)); } catch (e) { return; }
      if (!r.blocked) return;
      const b = r.blocking_job;
      blockEl.innerHTML = `<div class="card" style="border-left:4px solid var(--red);padding:8px 10px;margin:0">
        <b class="err">Already has an open job card</b><br>
        <a href="#/jobs/${b.id}">${esc(b.job_no)}</a> ${statusBadge(b.status)}
        <span class="muted">${esc(String(b.description || '').slice(0, 60))}</span></div>`;
      saveBtn.disabled = true;
    };
    body.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.apick-item')) setTimeout(check, 0);
    }, true);
    if (input) input.addEventListener('input', () => { blockEl.innerHTML = ''; saveBtn.disabled = false; });

    saveBtn.onclick = async () => {
      try {
        const r = await api('/jobs', { method: 'POST', body: formData(body) });
        close();
        if (r.unresolved) toast('Job raised — asset "' + r.unresolved.raw + '" queued in Alias Queue for linking', 'err');
        else toast('Job card ' + r.job.job_no + ' raised');
        location.hash = '#/jobs/' + r.job.id;
      } catch (e) {
        // Lost the race, or the vehicle was typed rather than picked.
        if (e.data && e.data.blocking_job) {
          const b = e.data.blocking_job;
          blockEl.innerHTML = `<div class="card" style="border-left:4px solid var(--red);padding:8px 10px;margin:0">
            <b class="err">Already has an open job card</b><br>
            <a href="#/jobs/${b.id}">${esc(b.job_no)}</a> ${statusBadge(b.status)}</div>`;
          saveBtn.disabled = true;
          toast(e.message, 'err');
        } else toast(e.message, 'err');
      }
    };
  });
}

async function jobDetail(c, id) {
  const j = await api('/jobs/' + id);
  const job = j.job;
  const r = j.readiness;
  const isClosed = job.status === 'CLOSED';
  // Reopen gets its own labelled button and confirm dialog — the raw CLOSED → IN_PROGRESS
  // state button read as "IN PROGRESS" and offered itself to users the server would refuse.
  const transitions = j.nextStates
    .filter((s) => !(isClosed && s === 'IN_PROGRESS'))
    .map((s) => `<button class="sm ${s === 'CLOSED' ? 'primary' : ''}" data-to="${s}">${s.replace(/_/g, ' ')}</button>`).join(' ');
  const reopenBtn = isClosed && j.canReopen
    ? '<button class="sm danger" id="reopen" title="Reopen this closed job card so more work and costs can be added">↩ Reopen job…</button>' : '';
  const reopens = j.reopens || [];
  c.innerHTML = `${pageHeader(job.job_no, '<a href="#/jobs">← Job Cards</a>')}
    <div class="toolbar">${statusBadge(job.status)}<span class="badge ${job.type === 'service' ? 'blue' : ''}">${esc(job.type)}</span>
      ${job.severity ? `<span class="badge">${esc(job.severity)}</span>` : ''}
      <a href="#/assets/${job.asset_id}">${esc(idLabel(job) || '—')}</a>
      <span class="muted">${esc(job.project_name || '')}</span>
      <div class="spacer"></div>
      ${can('workshop', 'operational_manager', 'manager') ? '<button class="sm" id="editjob" title="Change the vehicle, description or type">✎ Edit</button>' : ''}
      ${job.type === 'service' && can('workshop', 'operational_manager') && job.status !== 'CLOSED' ? `<button class="sm" id="flatlabour">Service labour${job.flat_labour != null ? ': ' + money(job.flat_labour) : ' (flat)'}</button>` : ''}
      <a class="btn primary sm" href="/api/reports/job/${job.id}/report.html" target="_blank" title="Full job report — parts requested & received, daily work done, and costs">📋 Job Report</a>
      <a class="btn sm" href="/api/reports/job/${job.id}/costsheet.html" target="_blank">🖨 Cost Sheet</a>
    </div>
    ${job.type === 'service' ? `<p class="muted" style="font-size:12px">Service job — labour is a flat charge${job.flat_labour == null ? ' (not set yet)' : ''}, not hours×rate.</p>` : ''}
    <p>${esc(job.description || '')}</p>
    ${(transitions || reopenBtn || (!isClosed && can('operational_manager', 'workshop', 'manager'))) ? `<div class="card section"><h3>Actions</h3><div class="pill-row" id="transitions">${transitions}${reopenBtn}
      ${!isClosed && can('operational_manager', 'workshop', 'manager') ? '<button class="sm" id="closedate" title="Close this card with a chosen (past) completion date — for old cards missed at the time">📅 Close on date…</button>' : ''}</div>
      ${isClosed
        ? `<p class="muted" style="margin-top:10px">Closed ${esc(String(job.completed_at || job.closed_at || '').slice(0, 10))} — locked for editing. ${j.canReopen ? 'Reopen it to add more work or costs.' : 'Ask a manager or the admin to reopen it.'}</p>`
        : !r.ready ? `<p class="err" style="margin-top:10px">⚠ Closure gate — ${r.missing.length} line(s) awaiting price:</p><ul>${r.missing.map((m) => `<li class="muted">${esc(m)}</li>`).join('')}</ul>` : '<p class="ok" style="margin-top:10px">✓ Fully priced — ready to close</p>'}
      ${reopens.length ? `<p class="muted" style="margin-top:10px;font-size:12px"><b>Reopen history</b></p><ul style="margin:4px 0 0">${reopens.map((x) => `<li class="muted" style="font-size:12px">${esc(String(x.reopened_at || '').slice(0, 10))} by ${esc(x.reopened_by_name || '—')} — ${esc(x.reason)}${x.prev_completed_at ? ` <span class="note">(was closed ${esc(String(x.prev_completed_at).slice(0, 10))})</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${job.original_completed_at && !isClosed ? `<p class="muted" style="margin-top:8px;font-size:12px">↩ Reopened. When you close it again it goes back into <b>${esc(String(job.original_completed_at).slice(0, 7))}</b>'s cost report, so that month's figures do not change.</p>` : ''}
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
  qsa('#transitions button[data-to]').forEach((b) => b.onclick = () => doTransition(job.id, b.dataset.to, job.status));
  if (qs('#closedate')) qs('#closedate').onclick = () => closeOnDateModal(job.id, job.job_no, render);
  if (qs('#reopen')) qs('#reopen').onclick = () => reopenJobModal(job, render);
  if (qs('#editjob')) qs('#editjob').onclick = () => editJobModal(job, render);
  if (qs('#flatlabour')) qs('#flatlabour').onclick = () => modal('Service Labour (flat charge)',
    field('Flat labour amount (Rs)', 'flat_labour', { type: 'number', value: job.flat_labour ?? '' }) + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>',
    (body, close) => { qs('#s', body).onclick = async () => { try { await api(`/jobs/${job.id}/flat-labour`, { method: 'PATCH', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } }; });
  if (qs('#adddaily')) qs('#adddaily').onclick = () => addDailyModal(job.id);
  if (qs('#addpart')) qs('#addpart').onclick = () => addPartModal(job.id, job.asset_id);
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
    else if (e.data && e.data.blocking_job) toast(`Blocked — ${e.data.blocking_job.job_no} is already open for this vehicle`, 'err');
    else toast(e.message, 'err');
  }
}

// Edit the card itself — vehicle, description, type. The vehicle box is pre-filled with the
// current one and left alone unless the user actually picks a different vehicle, so simply
// correcting the description can never move a job to another machine by accident.
function editJobModal(job, onDone) {
  const fld = (...args) => `<div class="fld">${field(...args)}</div>`;
  modal(`Edit ${job.job_no}`, `
    ${fld('Description *', 'description', { value: job.description || '' })}
    <div class="row" style="margin-top:8px">
      ${fld('Type', 'type', { type: 'select', value: job.type, options: [{ value: 'repair', label: 'Repair' }, { value: 'service', label: 'Service' }] })}
      <div class="fld">${assetPickerHtml('Vehicle')}</div>
    </div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Leave the vehicle box as it is to keep <b>${esc(idLabel(job) || 'no vehicle')}</b>. Changing it moves this job's labour and parts onto the other vehicle's monthly costs.</p>
    <div style="margin-top:14px;text-align:right"><button class="primary" id="s">Save changes</button></div>`, (body, close) => {
    wireAssetPicker(body);
    const cur = qs('.apick-input', body);
    if (cur) cur.value = job.asset_code || job.asset_reg || '';
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      const payload = { description: d.description, type: d.type };
      // Only send a vehicle when one was actually re-picked; a hidden id appears on selection.
      if (d.asset_id && Number(d.asset_id) !== Number(job.asset_id)) payload.asset_id = Number(d.asset_id);
      const send = async (p) => {
        try { return await api(`/jobs/${job.id}`, { method: 'PATCH', body: p }); }
        catch (e) {
          if (!(e.data && e.data.needs_confirm)) throw e;
          if (!confirm(e.data.error + '\n\nChange it anyway?')) return null;
          return api(`/jobs/${job.id}`, { method: 'PATCH', body: { ...p, confirm_type_change: true } });
        }
      };
      try {
        const r = await send(payload);
        if (!r) return;
        close();
        toast('✓ ' + job.job_no + ' updated');
        (r.warnings || []).forEach((w) => toast(w, 'err'));
        if (onDone) onDone();
      } catch (e) {
        if (e.data && e.data.blocking_job) toast(`Blocked — ${e.data.blocking_job.job_no} is already open for that vehicle`, 'err');
        else toast(e.message, 'err');
      }
    };
  }, { wide: true });
}

// Reopen a CLOSED job card. A deliberate confirm rather than a bare state button: reopening
// unlocks editing, puts the vehicle back under repair, and re-enters the one-open-card-per-
// vehicle rule. The reason is required — it is the only record of why cost history moved.
function reopenJobModal(job, onDone) {
  const fld = (...args) => `<div class="fld">${field(...args)}</div>`;
  const closedOn = String(job.completed_at || job.closed_at || '').slice(0, 10);
  modal(`Reopen ${job.job_no}?`, `
    <p class="muted" style="margin-top:0;font-size:12px">The card goes back to <b>IN PROGRESS</b> and can take work and parts again, and the vehicle returns to <b>under repair</b>. It becomes this vehicle's one open job card.</p>
    ${closedOn ? `<p class="note" style="font-size:12px">It was closed on <b>${esc(closedOn)}</b>. When you close it again it returns to <b>${esc(closedOn.slice(0, 7))}</b>'s cost report — that month's figures will not change.</p>` : ''}
    ${fld('Why are you reopening it? *', 'reason', { placeholder: 'e.g. same leak came back — reopening to finish' })}
    <div style="margin-top:14px;text-align:right"><button class="primary danger" id="s">↩ Reopen job</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      const reason = String(formData(body).reason || '').trim();
      if (!reason) return toast('Give a reason — it goes on the job\'s record', 'err');
      try {
        await api(`/jobs/${job.id}/transition`, { method: 'POST', body: { to: 'IN_PROGRESS', reason } });
        close();
        toast(`✓ ${job.job_no} reopened`);
        if (onDone) onDone();
      } catch (e) {
        if (e.data && e.data.blocking_job) toast(`Blocked — ${e.data.blocking_job.job_no} is already open for this vehicle`, 'err');
        else toast(e.message, 'err');
      }
    };
  });
}

// Close a job card with a chosen (usually past) completion date — the correction tool for old
// cards that were finished but never closed. The date drives the monthly report's Closed section.
function closeOnDateModal(jobId, jobNo, onDone) {
  modal(`Close ${jobNo} on a chosen date`, `
    <p class="muted" style="margin-top:0;font-size:12px">For old cards missed at the time — the card closes as if it was closed on this date, and it appears in that month's cost report. Unpriced lines don't block; they show as a warning so you can price them after.</p>
    ${field('Close date *', 'date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}
    ${field('Note (optional)', 'reason', { placeholder: 'e.g. missed closing — job finished on this date' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Close job on this date</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      const data = formData(body);
      if (!data.date) return toast('Pick the close date', 'err');
      try {
        const res = await api(`/jobs/${jobId}/close-on-date`, { method: 'POST', body: data });
        toast(`✓ ${jobNo} closed on ${data.date}` + (res.warning ? ` — ${res.warning}` : ''));
        close(); if (onDone) onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// Two ways to put something on a job card: write it down now, or claim something already
// recorded that nobody has assigned yet. The second tab is the point — labour booked to the
// general workshop and goods received against a request with no job sit unclaimed until
// somebody opens the job they belong to, which is exactly here.
const pickerTabs = (newLabel, poolLabel) => `
  <div class="toolbar" style="margin:0 0 10px">
    <button class="btn sm primary" id="tabNew">${newLabel}</button>
    <button class="btn sm" id="tabPool">${poolLabel} <span id="poolN" class="muted"></span></button>
  </div>`;
function wirePickerTabs(body, onPool) {
  const showNew = (isNew) => {
    qs('#tabNew', body).classList.toggle('primary', isNew);
    qs('#tabPool', body).classList.toggle('primary', !isNew);
    qs('#paneNew', body).style.display = isNew ? '' : 'none';
    qs('#panePool', body).style.display = isNew ? 'none' : '';
    if (!isNew) onPool();
  };
  qs('#tabNew', body).onclick = () => showNew(true);
  qs('#tabPool', body).onclick = () => showNew(false);
}

async function addDailyModal(jobId) {
  modal('Add Daily Work', `
    ${pickerTabs('✎ New entry', '📋 Not yet assigned')}
    <div id="paneNew">
      <div class="row">${field('Date', 'work_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}${field('Mechanic(s) — comma / & separated', 'mechanic', { placeholder: 'e.g. Buddhika, Krishna' })}</div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">Each mechanic is charged the full hours at their own rate (one costed row each). A slash name ("Seethananda/seetha") stays one person.</p>
      ${field('Description', 'description')}
      ${field('Hours', 'hours', { type: 'number' })}
      ${field('External repair (outside work)', 'is_external', { type: 'checkbox' })}
      ${field('External value (if external)', 'external_value', { type: 'number' })}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add</button></div>
    </div>
    <div id="panePool" style="display:none">
      <p class="muted" style="font-size:12px;margin:0 0 8px">Work booked to the general workshop rather than to a job card. Tick what belongs to this job — the hours and their cost move across with it.</p>
      <input id="dwq" type="search" placeholder="Search description or mechanic…" style="max-width:280px">
      <div id="dwlist" style="margin-top:8px"><div class="muted">Loading…</div></div>
      <div style="margin-top:12px;display:flex;align-items:center;gap:8px">
        <span class="muted" id="dwsel"></span><div class="spacer"></div>
        <button class="primary" id="dwAttach" disabled>Attach selected</button>
      </div>
    </div>`, (body, close) => {
    qs('#s', body).onclick = async () => { try { await api(`/jobs/${jobId}/daily-work`, { method: 'POST', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } };

    const chosen = new Set();
    const refreshSel = () => {
      qs('#dwsel', body).textContent = chosen.size ? `${chosen.size} selected` : '';
      qs('#dwAttach', body).disabled = chosen.size === 0;
    };
    const load = async () => {
      const q = qs('#dwq', body).value.trim();
      let rows = [];
      try { rows = await api('/jobs/unassigned/daily-work?limit=200' + (q ? '&q=' + encodeURIComponent(q) : '')); }
      catch (e) { qs('#dwlist', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
      qs('#poolN', body).textContent = rows.length ? `(${rows.length})` : '';
      qs('#dwlist', body).innerHTML = rows.length ? tableWrap(
        [{ label: '', width: '34px' }, { label: 'Date', width: '104px' }, { label: 'Mechanic' }, { label: 'Work', cls: 'desc-col' }, { label: 'Hrs', num: true, width: '60px' }],
        rows.map((r) => `<tr>
          <td><input type="checkbox" data-dw="${r.id}" ${chosen.has(String(r.id)) ? 'checked' : ''} style="width:auto"></td>
          <td>${esc(String(r.work_date || '').slice(0, 10))}</td>
          <td>${esc(r.mechanic || (r.is_external ? 'outside' : ''))}</td>
          <td class="desc-col">${esc(r.description || '')}</td>
          <td class="num">${num(r.hours)}</td></tr>`), { scroll: true })
        : '<div class="card"><p class="muted">Nothing unassigned — every entry is already on a job card.</p></div>';
      qsa('[data-dw]', body).forEach((cb) => { cb.onchange = () => {
        if (cb.checked) chosen.add(cb.dataset.dw); else chosen.delete(cb.dataset.dw);
        refreshSel();
      }; });
      refreshSel();
    };
    let deb; qs('#dwq', body).oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
    qs('#dwAttach', body).onclick = async () => {
      try {
        const r = await api(`/jobs/${jobId}/daily-work/attach`, { method: 'POST', body: { ids: [...chosen] } });
        toast(`${r.attached} entr${r.attached === 1 ? 'y' : 'ies'} attached · ${r.hours} h`);
        close(); render();
      } catch (e) { toast(e.message, 'err'); }
    };
    wirePickerTabs(body, load);
  }, { wide: true });
}

async function addPartModal(jobId, assetId) {
  modal('Add Part / External', `
    ${pickerTabs('✎ New line', '📋 Not yet assigned')}
    <div id="paneNew">
      ${field('Source', 'source_type', { type: 'select', options: [{ value: 'grn', label: 'GRN (stores)' }, { value: 'issue', label: 'Issue' }, { value: 'general', label: 'General item' }, { value: 'external', label: 'External repair' }] })}
      ${field('Description', 'description')}
      <div class="row">${field('Qty', 'qty', { type: 'number', value: 1 })}${field('Unit Price (blank = later)', 'unit_price', { type: 'number' })}</div>
      ${field('Is external repair', 'is_external_repair', { type: 'checkbox' })}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add</button></div>
    </div>
    <div id="panePool" style="display:none">
      <p class="muted" style="font-size:12px;margin:0 0 8px">Goods received against a request that was never tied to a job, and lines booked to the general workshop. This job's own vehicle is listed first.</p>
      <input id="ptq" type="search" placeholder="Search item / MRN / GRN…" style="max-width:280px">
      <div id="ptlist" style="margin-top:8px"><div class="muted">Loading…</div></div>
      <div style="margin-top:12px;display:flex;align-items:center;gap:8px">
        <span class="muted" id="ptsel"></span><div class="spacer"></div>
        <button class="primary" id="ptAttach" disabled>Attach selected</button>
      </div>
    </div>`, (body, close) => {
    qs('#s', body).onclick = async () => { try { await api(`/jobs/${jobId}/parts`, { method: 'POST', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } };

    const chosen = new Map();               // key -> {kind, id, value}
    const refreshSel = () => {
      const v = [...chosen.values()].reduce((s, x) => s + (Number(x.value) || 0), 0);
      qs('#ptsel', body).textContent = chosen.size ? `${chosen.size} selected · ${money(v)}` : '';
      qs('#ptAttach', body).disabled = chosen.size === 0;
    };
    const load = async () => {
      const q = qs('#ptq', body).value.trim();
      let d = { receipts: [], parts: [] };
      try {
        d = await api('/jobs/unassigned/parts?limit=200'
          + (assetId ? '&asset_id=' + assetId : '') + (q ? '&q=' + encodeURIComponent(q) : ''));
      } catch (e) { qs('#ptlist', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
      const rows = [...(d.receipts || []), ...(d.parts || [])];
      qs('#poolN', body).textContent = rows.length ? `(${rows.length})` : '';
      qs('#ptlist', body).innerHTML = rows.length ? tableWrap(
        [{ label: '', width: '34px' }, { label: 'Date', width: '104px' }, { label: 'Vehicle' }, { label: 'Item', cls: 'desc-col' },
          { label: 'Qty', num: true, width: '60px' }, { label: 'Value', num: true, width: '96px' }, { label: 'Ref' }],
        rows.map((r) => {
          const key = r.kind + ':' + r.id;
          const mine = assetId && String(r.asset_id) === String(assetId);
          return `<tr${mine ? ' style="background:var(--surface-2)"' : ''}>
            <td><input type="checkbox" data-pt="${key}" data-val="${r.value || 0}" ${chosen.has(key) ? 'checked' : ''} style="width:auto"></td>
            <td>${esc(String(r.on_date || '').slice(0, 10))}</td>
            <td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>${mine ? ' <span class="badge green">this job</span>' : ''}` : '<span class="muted">—</span>'}</td>
            <td class="desc-col">${esc(r.description || '')}</td>
            <td class="num">${num(r.qty)}</td>
            <td class="num">${r.value ? money(r.value) : '<span class="muted">unpriced</span>'}</td>
            <td>${r.kind === 'receipt' ? `<span class="muted">${esc(r.mrn_no || r.grn_no || '')}</span>` : '<span class="badge">general w/s</span>'}</td></tr>`;
        }), { scroll: true })
        : '<div class="card"><p class="muted">Nothing unassigned — every receipt is already on a job card.</p></div>';
      qsa('[data-pt]', body).forEach((cb) => { cb.onchange = () => {
        const [kind, id] = cb.dataset.pt.split(':');
        if (cb.checked) chosen.set(cb.dataset.pt, { kind, id, value: Number(cb.dataset.val) || 0 });
        else chosen.delete(cb.dataset.pt);
        refreshSel();
      }; });
      refreshSel();
    };
    let deb; qs('#ptq', body).oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
    qs('#ptAttach', body).onclick = async () => {
      const picked = [...chosen.values()];
      try {
        const r = await api(`/jobs/${jobId}/parts/attach`, { method: 'POST', body: {
          receipts: picked.filter((x) => x.kind === 'receipt').map((x) => x.id),
          parts: picked.filter((x) => x.kind === 'part').map((x) => x.id),
        } });
        toast(`${r.attached} item${r.attached === 1 ? '' : 's'} attached · ${money(r.value)}`);
        close(); render();
      } catch (e) { toast(e.message, 'err'); }
    };
    wirePickerTabs(body, load);
  }, { wide: true });
}

// ---- Stores
routes.stores = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  let tab = sp.get('tab') || 'search';

  // Five everyday areas up front. Two of them (Catalogue, Movements) are groups: they show a
  // sub-bar and then reuse the existing view underneath, so nothing had to be rewritten.
  const GROUPS = {
    paperwork: { label: '📄 REQUESTS & RECEIPTS', subs: [['mrn', 'Requests (MRN)'], ['grn', 'Receipts (GRN)']] },
    catalogue: { label: '📦 CATALOGUE', subs: [['general', 'Store items'], ['categories', 'Categories'], ['reorder', 'Re-order']] },
    movements: { label: '🔁 ISSUES & TRANSFERS', subs: [['issues', 'Issues'], ['mtn', 'Transfers (MTN)']] },
  };
  const PRIMARY = [['search', '🔎 SEARCH'], ['workspace', '⚡ RECEIVE & PRICE'],
    ['paperwork', GROUPS.paperwork.label], ['catalogue', GROUPS.catalogue.label], ['movements', GROUPS.movements.label]];

  const group = GROUPS[tab] ? tab : null;
  if (group) tab = sp.get('sub') || GROUPS[group].subs[0][0];      // a group renders its sub-view
  // A direct link (e.g. #/stores?tab=mrn&id=12) still lands on the right view — light up the
  // group that owns it so the menu doesn't look lost. The retired tabs (items / awaiting /
  // pending) are superseded by Search and Receive & Price, but their URLs still resolve.
  const owner = group || Object.keys(GROUPS).find((g) => GROUPS[g].subs.some(([s]) => s === tab)) || null;

  const isOn = (t) => (owner ? t === owner : t === tab);
  const primaryBar = `<div class="toolbar" style="margin-bottom:4px">${PRIMARY
    .map(([t, l]) => `<button class="sm ${isOn(t) ? 'primary' : ''}" onclick="location.hash='#/stores?tab=${t}'">${l}</button>`).join('')}</div>`;
  const subBar = owner ? `<div class="toolbar" style="margin:0 0 10px 0">${GROUPS[owner].subs
    .map(([s, l]) => `<button class="sm ${s === tab ? 'primary' : ''}" onclick="location.hash='#/stores?tab=${owner}&sub=${s}'">${l}</button>`).join('')}</div>` : '';

  c.innerHTML = pageHeader('Stores & Inventory') + primaryBar + subBar + '<div id="storebody" class="muted">Loading…</div>';
  const body = qs('#storebody');
  if (tab === 'workspace') {
    return receivePriceTab(body);
  } else if (tab === 'search') {
    // One row per requested item — search by vehicle, MRN no, item, job, supplier or invoice,
    // and sort by any column. Clicking a header toggles asc/desc.
    const sp0 = new URLSearchParams(location.hash.split('?')[1] || '');
    let sort = sp0.get('sort') || 'date_desc';
    body.innerHTML = `
      <div class="toolbar">
        <input id="sxq" type="search" placeholder="Search vehicle / MRN no / item / job / supplier…" value="${esc(sp0.get('q') || '')}" style="max-width:320px">
        <select id="sxsrc" style="max-width:150px"><option value="">All sources</option><option value="head_office">Head Office</option><option value="local_purchase">Local Purchase</option></select>
        <select id="sxstatus" style="max-width:170px"><option value="">All statuses</option><option value="pending">Pending (not full)</option><option value="received">Fully received</option><option value="unpriced">Has unpriced GRN</option></select>
        <button class="sm" id="sxclear">Clear</button>
        <a class="btn sm" id="sxxls" href="#">⬇ Excel</a>
        <div class="spacer"></div><span class="muted" id="sxcount"></span>
      </div>
      <div id="sxtable"><div class="muted">Type to search, or browse the latest requests below…</div></div>`;

    const qstr = () => {
      const q = qs('#sxq').value.trim(), src = qs('#sxsrc').value, st = qs('#sxstatus').value;
      return (q ? '&q=' + encodeURIComponent(q) : '') + (src ? '&source=' + src : '') + (st ? '&status=' + st : '') + '&sort=' + sort;
    };
    // Header definitions: [label, sort key base, numeric?, sort tooltip]
    // The received date rides UNDER the Recv quantity rather than taking a column of its own:
    // this table is fit + no-hscroll (table-layout:fixed, no sideways scroll) and already runs
    // 111px over its 992px box at eleven columns, so a twelfth takes ~9px off every other one
    // and doubles the number of clipped cells. The header still sorts by the date.
    const COLS = [
      ['MRN No', 'mrn'], ['Req Date', 'date'], ['Vehicle', 'vehicle'], ['Item', 'item'],
      ['Category', null], ['Qty', 'qty', true], ['Recv', 'received', true, 'Quantity received, and the date it arrived — sorts by that date'],
      ['Pending', 'pending', true],
      ['Status', 'status'], ['Source', null], ['Value (Rs)', 'value', true],
    ];
    const load = async () => {
      qs('#sxxls').href = '/api/stores/search/export.xlsx?x=1' + qstr();
      let list;
      try { list = await api('/stores/search?limit=500' + qstr()); }
      catch (e) { qs('#sxtable').innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
      qs('#sxcount').textContent = `${list.length}${list.length === 500 ? '+' : ''} item line(s)`;
      const head = COLS.map(([label, key, num, hint]) => {
        if (!key) return { label, num };
        const active = sort === key + '_asc' || sort === key + '_desc';
        const arrow = active ? (sort.endsWith('_asc') ? ' ▲' : ' ▼') : '';
        return { label: `<span class="sxsort" data-k="${key}"${hint ? ` title="${esc(hint)}"` : ''} style="cursor:pointer;text-decoration:underline dotted">${esc(label)}${arrow}</span>`, num, html: true };
      });
      qs('#sxtable').innerHTML = list.length ? tableWrap(
        head.map((h) => ({ label: h.label, num: h.num, html: h.html })),
        list.map((r) => `<tr>
          <td><a href="#/stores?tab=mrn&id=${r.mrn_id}">${esc(r.mrn_no || '')}</a></td>
          <td>${esc(String(r.req_date || '').slice(0, 10))}</td>
          <td>${r.asset_reg || r.asset_code ? `<span class="stamp">${esc(r.asset_reg || r.asset_code)}</span>` : '—'}</td>
          <td class="desc-col">${esc(r.description || '')}${r.job_no ? ` <span class="muted" style="font-size:11px">· ${esc(r.job_no)}</span>` : ''}</td>
          <td>${esc(r.category || '')}</td>
          <td class="num">${num(r.qty)}</td>
          <td class="num">${num(r.qty_received)}${receivedUnder(r)}</td>
          <td class="num">${r.pending > 0 ? `<span class="badge amber">${num(r.pending)}</span>` : '—'}</td>
          <td><span class="badge ${r.status === 'received' ? 'green' : (r.status === 'partial' ? 'blue' : '')}">${esc(r.status)}</span></td>
          <td>${esc(sourceLabel(r.source))}</td>
          <td class="num">${r.value ? money(r.value) : '—'}${r.unpriced ? ` <span class="badge amber" title="${r.unpriced} receipt(s) awaiting a price">${r.unpriced} unpriced</span>` : ''}</td></tr>`),
        { scroll: true, fit: true, noHScroll: true })
        : '<div class="card"><p class="muted">Nothing matches that search.</p></div>';
      // Header sorting — same key toggles direction, a new key starts descending.
      qsa('.sxsort', qs('#sxtable')).forEach((el) => {
        el.onclick = () => {
          const k = el.dataset.k;
          sort = (sort === k + '_desc') ? k + '_asc' : k + '_desc';
          load();
        };
      });
    };
    let sxdeb; qs('#sxq').oninput = () => { clearTimeout(sxdeb); sxdeb = setTimeout(load, 250); };
    qs('#sxsrc').onchange = load; qs('#sxstatus').onchange = load;
    qs('#sxclear').onclick = () => { qs('#sxq').value = ''; qs('#sxsrc').value = ''; qs('#sxstatus').value = ''; sort = 'date_desc'; load(); };
    return load();
  } else if (tab === 'categories') {
    return categoriesTab(body);
  } else if (tab === 'general') {
    const facets = await api('/stores/catalogue/facets');
    const kindBadge = (k) => { const cls = k === 'consumable' ? 'amber' : (k === 'service' ? '' : 'blue'); return `<span class="badge ${cls}">${esc(k || 'part')}</span>`; };
    body.innerHTML = `
      <div class="toolbar">
        <input id="cq" type="search" placeholder="Search item no / name / part number…" style="max-width:300px">
        <select id="ccat" style="max-width:210px"><option value="">All categories</option>${(await catTree()).map((p) => `<option value="${p.id}">${esc(p.name)} (${p.counts.items})</option>`).join('')}</select>
        <select id="csub" style="max-width:200px"><option value="">All sub-categories</option></select>
        <select id="ckind" style="max-width:170px"><option value="">All kinds</option>${facets.by_kind.map((r) => `<option value="${esc(r.kind)}">${esc(r.kind)} (${r.count})</option>`).join('')}</select>
        <a class="btn sm" href="/api/stores/export/catalogue.xlsx">⬇ Excel</a>
        <div class="spacer"></div><span class="muted" id="ccount"></span>
      </div>
      <p class="muted" style="margin:0 0 8px">${num(facets.total)} general items — deduped from every MRN request, each with a category-prefixed item number. The Part Numbers column lists every code ever seen for that item.</p>
      <div id="ctable"><div class="muted">Loading…</div></div>`;
    // The sub-category list follows whichever category is selected.
    const fillSubs = async () => {
      const tree = await catTree();
      const p = tree.find((x) => String(x.id) === qs('#ccat').value);
      qs('#csub').innerHTML = '<option value="">All sub-categories</option>'
        + (p ? p.subs.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.counts.items})</option>`).join('') : '');
    };
    const load = async () => {
      const q = qs('#cq').value.trim(), cat = qs('#csub').value || qs('#ccat').value, kind = qs('#ckind').value;
      const list = await api('/stores/catalogue?limit=2000'
        + (q ? '&q=' + encodeURIComponent(q) : '')
        + (cat ? '&category_id=' + encodeURIComponent(cat) : '')
        + (kind ? '&kind=' + encodeURIComponent(kind) : ''));
      qs('#ccount').textContent = `${list.length}${list.length === 2000 ? '+' : ''} item${list.length === 1 ? '' : 's'}`;
      qs('#ctable').innerHTML = tableWrap(
        [{ label: 'Item No' }, { label: 'Item Name' }, { label: 'Category' }, { label: 'Sub-category' }, { label: 'Kind' }, { label: 'Requests', num: true }, { label: 'Part Numbers' }],
        list.map((i) => { const pn = i.part_numbers || ''; return `<tr>
          <td><span class="stamp">${esc(i.item_no)}</span></td>
          <td>${esc(i.name)}</td>
          <td>${esc(i.parent_category || i.category || '')}</td>
          <td class="muted">${esc(i.sub_category || '')}</td>
          <td>${kindBadge(i.catalogue_kind)}</td>
          <td class="num">${num(i.req_count || 0)}</td>
          <td title="${esc(pn)}" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pn.length > 70 ? pn.slice(0, 70) + '…' : pn)}</td></tr>`; }), { scroll: true });
    };
    let cdeb; qs('#cq').oninput = () => { clearTimeout(cdeb); cdeb = setTimeout(load, 250); };
    qs('#ccat').onchange = async () => { await fillSubs(); load(); };
    qs('#csub').onchange = load; qs('#ckind').onchange = load;
    await load();
  } else if (tab === 'items') {
    const items = await api('/stores/items?limit=500');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="ni">+ New Item</button></div>' : ''}
      ${tableWrap([{ label: 'Name' }, { label: 'Part No' }, { label: 'Category' }, { label: 'Sub-category' }, { label: 'Unit' }, { label: 'General?' }, { label: 'Balance', num: true }, { label: 'Min', num: true }],
        items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.part_number || '')}</td><td>${esc(i.parent_category || i.category || '')}</td><td class="muted">${esc(i.sub_category || '')}</td><td>${esc(i.unit)}</td><td>${i.is_general ? '✓' : ''}</td><td class="num">${i.is_general ? num(i.balance) : '—'}</td><td class="num">${i.min_stock || ''}</td></tr>`), { scroll: true })}`;
    if (qs('#ni')) qs('#ni').onclick = () => simpleCreateModal('New Store Item', '/stores/items', [['Name *', 'name'], ['Part Number', 'part_number'], ['Category', 'category_id', 'category'], ['Unit', 'unit'], ['Min Stock', 'min_stock', 'number'], ['General consumable', 'is_general', 'checkbox']]);
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
        <a class="btn sm" id="gaxls" href="#" title="Excel list of items received without a price (one sheet per source)">⬇ Excel — awaiting price</a>
        <a class="btn sm" id="gaprint" href="#" target="_blank" title="Printable / Save-as-PDF list of items awaiting a price">🖨 PDF — awaiting price</a>
        <div class="spacer"></div><span class="muted" id="gcount"></span>
      </div>
      <p class="muted" id="gawaitsum" style="margin:0 0 8px"></p>
      <div id="gtable"><div class="muted">Loading…</div></div>`;
    const load = async () => {
      const q = qs('#gq').value.trim(), awaiting = qs('#gawait').checked, src = qs('#gsrc').value;
      // The two report buttons always cover the awaiting-price list, narrowed by the same
      // source / search filters shown on screen.
      const rq = (src ? '&source=' + src : '') + (q ? '&q=' + encodeURIComponent(q) : '');
      qs('#gaxls').href = '/api/stores/awaiting-price/export.xlsx?x=1' + rq;
      qs('#gaprint').href = '/api/stores/awaiting-price/print.html?x=1' + rq;
      // Spell out which list the buttons will produce — they follow the source dropdown.
      const whichSrc = src ? sourceLabel(src) : 'all sources';
      qs('#gaxls').textContent = `⬇ Excel — awaiting price (${whichSrc})`;
      qs('#gaprint').textContent = `🖨 PDF — awaiting price (${whichSrc})`;
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
        [{ label: 'Req Date' }, { label: 'MRN' }, { label: 'Vehicle' }, { label: 'Item' }, { label: 'Category' }, { label: 'Ordered', num: true }, { label: 'Received', num: true }, { label: 'Received date' }, { label: 'Outstanding', num: true }, { label: 'Source' }],
        list.map((r) => `<tr>
          <td>${fmtD(r.req_date)}</td>
          <td>${r.mrn_id ? `<a href="#/stores?tab=mrn&id=${r.mrn_id}">${esc(r.mrn_no || '')}</a>` : esc(r.mrn_no || '')}</td>
          <td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>` : '—'}</td>
          <td>${esc(r.description || '')}</td>
          <td>${esc(r.category || '')}</td>
          <td class="num">${num(r.qty)}</td>
          <td class="num">${num(r.qty_received || 0)}</td>
          <td style="white-space:nowrap">${receivedDate(r)}</td>
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
        <a class="btn sm" id="pxls" href="#">⬇ Excel</a>
        <a class="btn sm" id="pprint" href="#" target="_blank">🖨 PDF / Print</a>
        <div class="spacer"></div><span class="muted" id="pcount"></span>
      </div>
      <p class="muted" id="psum" style="margin:0 0 8px"></p>
      <div id="ptable"><div class="muted">Loading…</div></div>`;
    const qstr = () => { const s = qs('#psrc').value, st = qs('#pstatus').value, q = qs('#pq').value.trim(); return (s ? '&source=' + s : '') + (st ? '&status=' + st : '') + (q ? '&q=' + encodeURIComponent(q) : ''); };
    const load = async () => {
      const list = await api('/stores/pending?limit=2000' + qstr());
      qs('#pcount').textContent = `${list.length} pending line(s)`;
      qs('#pprint').href = '/api/stores/pending/print.html?x=1' + qstr();
      qs('#pxls').href = '/api/stores/pending/export.xlsx?x=1' + qstr();
      qs('#ptable').innerHTML = list.length ? tableWrap(
        [{ label: 'MRN' }, { label: 'Req Date' }, { label: 'Vehicle' }, { label: 'Item' }, { label: 'Ordered', num: true }, { label: 'Received', num: true }, { label: 'Received date' }, { label: 'Pending', num: true }, { label: 'Status' }, { label: 'Source' }].concat(canRx ? [{ label: '' }] : []),
        list.map((r) => `<tr>
          <td><a href="#/stores?tab=mrn&id=${r.mrn_id}">${esc(r.mrn_no || '')}</a></td>
          <td>${esc((r.req_date || '').slice(0, 10))}</td>
          <td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>` : '—'}</td>
          <td>${esc(r.description || '')}</td>
          <td class="num">${num(r.ordered)}</td>
          <td class="num">${num(r.received)}</td>
          <td style="white-space:nowrap">${receivedDate(r)}</td>
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
      <div id="itable"><div class="muted">Loading…</div></div>
      <div class="card section"><div class="toolbar" style="margin:0 0 8px">
          <h3 style="margin:0">Everything issued — all sections</h3>
          <span class="muted" style="font-weight:400;font-size:12px">oil · filters · batteries · tyres · general, in one feed</span>
          <div class="spacer"></div>
          <select id="afsec" style="max-width:150px"><option value="">All sections</option>${['oil', 'filter', 'battery', 'tyre', 'general'].map((x) => `<option value="${x}">${x}</option>`).join('')}</select>
          <input id="afq" type="search" placeholder="Search item / vehicle…" style="max-width:200px">
          <span class="muted" id="afcount"></span>
        </div><div id="affeed"><div class="muted">Loading…</div></div></div>`;
    // One feed across every section — each row still belongs to its own section view.
    const loadFeed = async () => {
      const sec = qs('#afsec').value, q = qs('#afq').value.trim();
      const secs = sec ? [sec] : ['oil', 'filter', 'battery', 'tyre', 'general'];
      const per = sec ? 400 : 120;
      const lists = await Promise.all(secs.map((s) => api(`/stores/stock/${s}/moves?kind=out&limit=${per}${q ? '&q=' + encodeURIComponent(q) : ''}`).catch(() => [])));
      const rows = lists.flat().sort((a, b) => String(b.txn_date || '').localeCompare(String(a.txn_date || '')));
      qs('#afcount').textContent = `${rows.length} issue movement(s)`;
      qs('#affeed').innerHTML = rows.length ? tableWrap(
        [{ label: 'Date' }, { label: 'Section' }, { label: 'Item', cls: 'desc-col' }, { label: 'Qty', num: true },
          { label: 'Vehicle' }, { label: 'Job / Ref' }],
        rows.map((m) => `<tr>
          <td>${esc(m.txn_date || '—')}</td>
          <td><span class="badge ${m.section === 'oil' ? 'blue' : (m.section === 'filter' ? 'green' : '')}">${esc(m.section)}</span></td>
          <td class="desc-col">${esc(m.item_name || '')}</td>
          <td class="num">${num(m.qty)}</td>
          <td>${m.asset_reg || m.asset_code ? `<span class="stamp">${esc(m.asset_reg || m.asset_code)}</span>` : '—'}</td>
          <td>${esc(m.job_no || m.ref || '')}</td></tr>`),
        { scroll: true, fit: true, noHScroll: true })
        : '<div class="card"><p class="muted">No issues match.</p></div>';
    };
    qs('#afsec').onchange = loadFeed;
    let afdeb; qs('#afq').oninput = () => { clearTimeout(afdeb); afdeb = setTimeout(loadFeed, 250); };
    loadFeed();
    const load = async () => {
      const q = qs('#iq').value.trim();
      const list = await api('/stores/issues?limit=500' + (q ? '&q=' + encodeURIComponent(q) : ''));
      qs('#icount').textContent = `${list.length}${list.length === 500 ? '+' : ''} issue${list.length === 1 ? '' : 's'}`;
      qs('#itable').innerHTML = tableWrap(
        [{ label: 'Date' }, { label: 'Vehicle' }, { label: 'Job Card' }, { label: 'Item / description' }, { label: 'Category' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Issued by' }],
        list.map((i) => `<tr>
          <td>${esc((i.issue_date || '').slice(0, 10))}</td>
          <td>${esc(i.asset_code || '—')}</td>
          <td>${i.job_no ? `<a href="#/jobs/${i.job_id}">${esc(i.job_no)}</a>` : '<span class="muted">—</span>'}</td>
          <td>${esc(i.description)}</td>
          <td>${esc(i.category || '')}${i.sub_category ? ` <span class="muted" style="font-size:11px">› ${esc(i.sub_category)}</span>` : ''}</td>
          <td class="num">${num(i.qty)}</td>
          <td class="num">${i.unit_price == null ? '—' : money(i.unit_price)}</td>
          <td>${esc(i.issued_by || '')}</td></tr>`), { scroll: true });
    };
    let ideb; qs('#iq').oninput = () => { clearTimeout(ideb); ideb = setTimeout(load, 250); };
    if (qs('#nis')) qs('#nis').onclick = () => newIssueModal(load);
    await load();
  } else if (tab === 'mtn') {
    const canT = can('storekeeper');
    const CAP = 300;
    body.innerHTML = `
      <div class="toolbar">
        ${canT ? '<button class="primary" id="nt">+ New MTN</button>' : ''}
        <input id="tq" type="search" placeholder="Search MTN no / item / location / person…" style="max-width:280px">
        <label style="width:auto">From <input id="tfrom" type="date" style="max-width:150px"></label>
        <label style="width:auto">To <input id="tto" type="date" style="max-width:150px"></label>
        <button class="sm" id="tclear">Clear</button>
        <div class="spacer"></div><span class="muted" id="tcount"></span>
      </div>
      <div id="ttable" class="muted">Loading…</div>`;

    const loadMtn = async () => {
      const q = qs('#tq', body).value.trim();
      const from = qs('#tfrom', body).value, to = qs('#tto', body).value;
      const qs_ = new URLSearchParams({ limit: String(CAP) });
      if (q) qs_.set('q', q);
      if (from) qs_.set('from', from);
      if (to) qs_.set('to', to);
      let list = [];
      try { list = await api('/stores/mtn?' + qs_); }
      catch (e) { qs('#ttable', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
      // Say when the list is cut off rather than letting it read as "that is all of them".
      qs('#tcount', body).textContent = `${list.length} transfer${list.length === 1 ? '' : 's'}`
        + (list.length >= CAP ? ` — showing the newest ${CAP}, narrow the search` : '');
      const COLS = 7 + (canT ? 1 : 0);
      qs('#ttable', body).innerHTML = list.length ? tableWrap(
        [{ label: 'MTN No', width: '124px' }, { label: 'Date', width: '104px' }, { label: 'Items', cls: 'desc-col' },
          { label: 'No.', num: true, width: '54px' }, { label: 'Qty', num: true, width: '72px' },
          { label: 'From' }, { label: 'To' }].concat(canT ? [{ label: '', width: '64px' }] : []),
        list.map((t) => `<tr>
          <td>${(t.item_count || 1) > 1 ? `<button class="sm" data-exp="${t.id}" title="Show the items on this transfer" style="padding:0 6px;margin-right:4px">▸</button>` : ''}<b>${esc(t.mtn_no)}</b></td>
          <td>${esc(String(t.txn_date || '').slice(0, 10))}</td>
          <td class="desc-col">${esc(t.description || '')}</td>
          <td class="num">${(t.item_count || 1) > 1 ? `<span class="badge blue">${t.item_count}</span>` : '1'}</td>
          <td class="num">${num(t.qty)}</td>
          <td>${esc(t.from_location || t.from_asset_code || '')}</td><td>${esc(t.to_location || t.to_asset_code || '')}</td>
          ${canT ? `<td><button class="sm" data-mtn="${t.id}">✎ Edit</button></td>` : ''}</tr>`), { scroll: true })
        : `<div class="card"><p class="muted">${q || from || to ? 'No transfer matches that.' : 'No transfers recorded yet.'}</p></div>`;
      qsa('[data-mtn]', body).forEach((b) => { b.onclick = () => mtnModal(list.find((x) => String(x.id) === b.dataset.mtn), loadMtn); });
      // ▸ opens the note's items underneath, so a multi-item transfer can be read without
      // leaving the list.
      qsa('[data-exp]', body).forEach((b) => { b.onclick = async () => {
        const tr = b.closest('tr');
        if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('mtn-items')) {
          tr.nextElementSibling.remove(); b.textContent = '▸'; return;
        }
        b.textContent = '▾';
        const holder = document.createElement('tr');
        holder.className = 'mtn-items';
        holder.innerHTML = `<td colspan="${COLS}" style="background:var(--surface-2);padding:8px 12px"><span class="muted">Loading items…</span></td>`;
        tr.after(holder);
        try {
          const d = await api('/stores/mtn/' + b.dataset.exp);
          holder.firstChild.innerHTML = tableWrap(
            [{ label: '#', num: true, width: '38px' }, { label: 'Item' }, { label: 'Qty', num: true, width: '70px' },
              { label: 'Unit', width: '64px' }, { label: 'Category' }, { label: 'From' }, { label: 'To' }, { label: 'Reason' }],
            d.lines.map((l, i) => `<tr><td class="num">${i + 1}</td><td>${esc(l.description || '')}</td>
              <td class="num">${num(l.qty)}</td><td>${esc(l.unit || '')}</td><td>${esc(l.category || '')}</td>
              <td>${esc(l.from_location || l.from_asset_code || '')}</td>
              <td>${esc(l.to_location || l.to_asset_code || '')}</td>
              <td>${esc(l.reason || '')}</td></tr>`));
        } catch (e) { holder.firstChild.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
      }; });
    };

    let tdeb;
    qs('#tq', body).oninput = () => { clearTimeout(tdeb); tdeb = setTimeout(loadMtn, 250); };
    qs('#tfrom', body).onchange = loadMtn;
    qs('#tto', body).onchange = loadMtn;
    qs('#tclear', body).onclick = () => {
      qs('#tq', body).value = ''; qs('#tfrom', body).value = ''; qs('#tto', body).value = '';
      loadMtn();
    };
    if (qs('#nt')) qs('#nt').onclick = () => mtnModal(null, loadMtn);
    await loadMtn();
  }
};

// ---- Categories tab: the Category → Sub-category tree ----------------------
// Every store item, request line, issue and transfer hangs off a sub-category here.
// Renaming or moving one rewrites the label on every record under it; merging is how
// the imported free-text vocabulary gets tidied up.
async function categoriesTab(body) {
  const d = await api('/stores/categories');
  catInvalidate();
  const edit = canEdit('stores');
  const tree = d.tree;
  const reload = () => { catInvalidate(); categoriesTab(body); };
  const cnt = (c) => `<td class="num">${num(c.items)}</td><td class="num">${num(c.mrn_lines)}</td><td class="num">${num(c.issues)}</td><td class="num">${num(c.transfers)}</td>`;

  const rows = [];
  for (const p of tree) {
    rows.push(`<tr style="background:var(--bg)">
      <td><b>${esc(p.name)}</b>${p.code ? ` <span class="stamp">${esc(p.code)}</span>` : ''}
        <span class="muted" style="font-size:11px"> · ${p.subs.length} sub-categor${p.subs.length === 1 ? 'y' : 'ies'}</span></td>
      ${cnt(p.counts)}
      <td>${edit ? `<button class="sm primary" data-add="${p.id}">+ Sub</button>
        <button class="sm" data-ren="${p.id}" data-name="${esc(p.name)}">Rename</button>
        <button class="sm" data-merge="${p.id}" data-level="parent" data-name="${esc(p.name)}">Merge</button>
        <button class="sm danger" data-del="${p.id}">✕</button>` : ''}</td></tr>`);
    for (const s of p.subs) {
      rows.push(`<tr>
        <td style="padding-left:26px" class="muted">› ${esc(s.name)}</td>
        ${cnt(s.counts)}
        <td>${edit ? `<button class="sm" data-ren="${s.id}" data-name="${esc(s.name)}">Rename</button>
          <button class="sm" data-move="${s.id}" data-parent="${p.id}" data-name="${esc(s.name)}">Move</button>
          <button class="sm" data-merge="${s.id}" data-level="sub" data-name="${esc(s.name)}">Merge</button>
          <button class="sm danger" data-del="${s.id}">✕</button>` : ''}</td></tr>`);
    }
  }
  const totals = tree.reduce((a, p) => { for (const k of Object.keys(a)) a[k] += p.counts[k]; return a; },
    { items: 0, mrn_lines: 0, issues: 0, transfers: 0 });

  body.innerHTML = `
    <div class="toolbar">
      ${edit ? '<button class="primary" id="newcat">+ Category</button>' : ''}
      <input id="catq" type="search" placeholder="Filter categories…" style="max-width:240px">
      <div class="spacer"></div>
      <span class="muted">${tree.length} categories · ${num(tree.reduce((n, p) => n + p.subs.length, 0))} sub-categories</span>
    </div>
    <p class="muted" style="margin:0 0 8px">Items, requests, issues and transfers all hang off a <b>sub-category</b>. Renaming or moving one updates every record under it; use <b>Merge</b> to fold a duplicate into another.</p>
    <div id="cattable">${tableWrap(
      [{ label: 'Category / Sub-category' }, { label: 'Items', num: true }, { label: 'Request lines', num: true },
        { label: 'Issues', num: true }, { label: 'Transfers', num: true }, { label: '' }],
      rows, { scroll: true })}</div>
    <p class="muted" style="margin:6px 0 0">Totals — ${num(totals.items)} items · ${num(totals.mrn_lines)} request lines · ${num(totals.issues)} issues · ${num(totals.transfers)} transfers</p>
    <details style="margin-top:14px"><summary class="muted" style="cursor:pointer">Totals by category label (quantities)</summary>
      <div class="grid" style="margin-top:10px">
        <div class="card"><h3>Requested (MRN lines)</h3>
          ${tableWrap([{ label: 'Category' }, { label: 'Lines', num: true }, { label: 'Distinct items', num: true }, { label: 'Qty', num: true }, { label: 'Received', num: true }],
            d.lines.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${num(r.lines)}</td><td class="num">${num(r.distinct_items)}</td><td class="num">${num(r.qty)}</td><td class="num">${num(r.received)}</td></tr>`), { scroll: true })}</div>
        <div class="card"><h3>Issued</h3>
          ${tableWrap([{ label: 'Category' }, { label: 'Issues', num: true }, { label: 'Qty', num: true }],
            d.issues.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${num(r.issues)}</td><td class="num">${num(r.qty)}</td></tr>`), { scroll: true })}</div>
        <div class="card"><h3>Transfers (MTN)</h3>
          ${d.transfers.length ? tableWrap([{ label: 'Category' }, { label: 'Transfers', num: true }, { label: 'Qty', num: true }],
            d.transfers.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${num(r.transfers)}</td><td class="num">${num(r.qty)}</td></tr>`), { scroll: true }) : '<p class="muted">None</p>'}</div>
        <div class="card"><h3>Catalogue</h3>
          ${tableWrap([{ label: 'Category' }, { label: 'Items', num: true }],
            d.catalogue.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${num(r.items)}</td></tr>`))}</div>
      </div></details>`;

  qs('#catq').oninput = (e) => {
    const v = e.target.value.toLowerCase();
    qsa('#cattable tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(v) ? '' : 'none'; });
  };
  if (!edit) return;

  const nameModal = (title, initial, onSave) => modal(title,
    field('Name', 'name', { value: initial || '' }) + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>',
    (mb, close) => { qs('#s', mb).onclick = async () => {
      const nm = formData(mb).name.trim();
      if (!nm) return toast('Enter a name', 'err');
      try { await onSave(nm); close(); toast('Saved'); reload(); } catch (e) { toast(e.message, 'err'); }
    }; });

  if (qs('#newcat')) qs('#newcat').onclick = () => modal('New Category', `
    <p class="muted">A top-level category. It starts with a "General" sub-category; add more below it afterwards.</p>
    <div class="row">${field('Name', 'name')}${field('Code (item no prefix, e.g. ELE)', 'code')}</div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create</button></div>`,
    (mb, close) => { qs('#s', mb).onclick = async () => {
      const f = formData(mb);
      if (!f.name.trim()) return toast('Enter a name', 'err');
      try { await api('/stores/categories', { method: 'POST', body: { name: f.name, code: f.code } }); close(); toast('Category created'); reload(); }
      catch (e) { toast(e.message, 'err'); }
    }; });

  qsa('[data-add]').forEach((b) => b.onclick = () => nameModal('New sub-category', '',
    (nm) => api('/stores/categories', { method: 'POST', body: { parent_id: b.dataset.add, name: nm } })));

  qsa('[data-ren]').forEach((b) => b.onclick = () => nameModal('Rename "' + b.dataset.name + '"', b.dataset.name,
    (nm) => api('/stores/categories/' + b.dataset.ren, { method: 'PATCH', body: { name: nm } })));

  qsa('[data-move]').forEach((b) => b.onclick = () => modal('Move "' + b.dataset.name + '"', `
    <p class="muted">Move this sub-category under a different category. Every record under it is relabelled.</p>
    ${field('New parent category', 'parent_id', { type: 'select', value: b.dataset.parent, options: tree.map((p) => ({ value: p.id, label: p.name })) })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Move</button></div>`,
    (mb, close) => { qs('#s', mb).onclick = async () => {
      try { await api('/stores/categories/' + b.dataset.move, { method: 'PATCH', body: { parent_id: formData(mb).parent_id } }); close(); toast('Moved'); reload(); }
      catch (e) { toast(e.message, 'err'); }
    }; }));

  qsa('[data-merge]').forEach((b) => b.onclick = async () => {
    const isParent = b.dataset.level === 'parent';
    const opts = isParent
      ? tree.filter((p) => String(p.id) !== b.dataset.merge).map((p) => ({ value: p.id, label: p.name }))
      : tree.flatMap((p) => p.subs.filter((s) => String(s.id) !== b.dataset.merge).map((s) => ({ value: s.id, label: p.name + ' › ' + s.name })));
    let u = null;
    try { u = await api('/stores/categories/' + b.dataset.merge + '/usage'); } catch (e) { /* show the form anyway */ }
    modal('Merge "' + b.dataset.name + '" into…', `
      <p class="muted">Moves ${u ? num(u.total) : 'all'} record(s)${isParent && u && u.children ? ` and ${num(u.children)} sub-categor${u.children === 1 ? 'y' : 'ies'}` : ''} into the target, then deletes "${esc(b.dataset.name)}". This cannot be undone.</p>
      ${field('Merge into', 'into_id', { type: 'select', options: opts })}
      <div style="margin-top:12px;text-align:right"><button class="primary danger" id="s">Merge</button></div>`,
      (mb, close) => { qs('#s', mb).onclick = async () => {
        try {
          const r = await api('/stores/categories/' + b.dataset.merge + '/merge', { method: 'POST', body: { into_id: formData(mb).into_id } });
          close(); toast(`Merged — ${r.records} record(s) moved`); reload();
        } catch (e) { toast(e.message, 'err'); }
      }; });
  });

  qsa('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this category? Only empty ones can be deleted.')) return;
    try { await api('/stores/categories/' + b.dataset.del, { method: 'DELETE' }); toast('Deleted'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

// ---- Receive & Price workspace ---------------------------------------------
// The two jobs a storekeeper repeats all day, done inline instead of one popup per row:
//   • RECEIVE  — type the qty (and price/supplier if known) straight onto the pending lines
//   • PRICE    — type prices down the column for stock that arrived without one
// Edits are held until "Save Changes", then written in a single batched request.
async function receivePriceTab(body) {
  const canRx = can('storekeeper');
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  let mode = sp.get('mode') === 'price' ? 'price' : 'receive';
  const edits = new Map();               // row id -> { field: value }

  body.innerHTML = `
    <div class="toolbar" style="margin-top:0">
      <button class="sm" id="wsRecv">📥 To receive</button>
      <button class="sm" id="wsPrice">💰 Awaiting price</button>
      <input id="wsq" type="search" placeholder="Search item / MRN / vehicle / supplier…" style="max-width:280px">
      <select id="wssrc" style="max-width:150px"><option value="">All sources</option><option value="head_office">Head Office</option><option value="local_purchase">Local Purchase</option></select>
      <div class="spacer"></div>
      ${canRx ? '<button class="primary sm" id="wsSave" disabled>💾 Save Changes</button>' : '<span class="muted">read-only</span>'}
    </div>
    <p class="muted" id="wsHint" style="margin:0 0 8px;font-size:12px"></p>
    <div id="wsTable"><div class="muted">Loading…</div></div>
    <div class="toolbar" style="margin-top:8px"><span class="muted" id="wsCount"></span></div>`;

  const saveBtn = qs('#wsSave', body);
  const paintSave = () => {
    if (!saveBtn) return;
    saveBtn.disabled = edits.size === 0;
    saveBtn.textContent = edits.size ? `💾 Save Changes (${edits.size})` : '💾 Save Changes';
  };
  const mark = (id, field, value, changed, el) => {
    const cur = edits.get(id) || {};
    if (changed) { cur[field] = value; edits.set(id, cur); }
    else { delete cur[field]; if (Object.keys(cur).length) edits.set(id, cur); else edits.delete(id); }
    const row = el.closest('tr');
    if (row) row.style.background = edits.has(id) ? '#eef6ff' : '';
    paintSave();
  };
  // One editable cell: remembers its original value so un-editing clears the pending change.
  const cell = (id, field, value, opts = {}) => {
    const v = value == null ? '' : value;
    if (!canRx) return `<td class="${opts.num ? 'num' : ''}">${esc(v)}</td>`;
    if (opts.type === 'select') {
      return `<td><select data-id="${id}" data-f="${field}" data-orig="${esc(v)}" style="width:100%;font-size:12px">
        ${opts.options.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(v) ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select></td>`;
    }
    return `<td class="${opts.num ? 'num' : ''}"><input data-id="${id}" data-f="${field}" data-orig="${esc(v)}"
      type="${opts.type || 'text'}" ${opts.step ? 'step="' + opts.step + '"' : ''} ${opts.min != null ? 'min="' + opts.min + '"' : ''}
      value="${esc(v)}" placeholder="${esc(opts.ph || '')}" style="width:${opts.w || '92px'};${opts.num ? 'text-align:right;' : ''}font-size:12px"></td>`;
  };
  const SRC_OPTS = [{ v: '', l: '—' }, { v: 'head_office', l: 'Head Office' }, { v: 'local_purchase', l: 'Local Purchase' }];

  // "Received as" — the number on the box when it is not the number that was asked for.
  // Filters are routinely supplied as an equivalent, and the receipt has to record what is
  // actually on the shelf. Left blank it means "exactly what was requested"; the known
  // equivalents are offered as a datalist so the common cases are a pick, not typing.
  const receivedAsCell = (r) => {
    if (!canRx) return `<td>${esc(r.received_part_no || '')}</td>`;
    const listId = `eq-${r.id}`;
    const eq = (r.equivalents || []);
    const hint = r.requested_part_no
      ? `asked for ${r.requested_part_no}${eq.length ? ` · ${eq.length} known equivalent${eq.length === 1 ? '' : 's'}` : ''}`
      : 'only if a different part number arrived';
    return `<td><input data-id="${r.id}" data-f="received_part_no" data-orig=""
      list="${listId}" placeholder="same as asked" title="${esc(hint)}"
      style="width:146px;font-size:12px">
      ${eq.length ? `<datalist id="${listId}">${eq.map((e) => `<option value="${esc(e.part_number)}">${esc([e.brand, e.ref_type].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>` : ''}</td>`;
  };

  const wire = () => {
    qsa('#wsTable input[data-id], #wsTable select[data-id]', body).forEach((el) => {
      const handler = () => mark(el.dataset.id, el.dataset.f, el.value, String(el.value).trim() !== String(el.dataset.orig).trim(), el);
      el.oninput = handler; el.onchange = handler;
    });
  };

  const load = async () => {
    edits.clear(); paintSave();
    const q = qs('#wsq', body).value.trim(), src = qs('#wssrc', body).value;
    const qstr = (q ? '&q=' + encodeURIComponent(q) : '') + (src ? '&source=' + src : '');
    qs('#wsRecv', body).classList.toggle('primary', mode === 'receive');
    qs('#wsPrice', body).classList.toggle('primary', mode === 'price');
    history.replaceState(null, '', '#/stores?tab=workspace&mode=' + mode);
    qs('#wsTable', body).innerHTML = '<div class="muted">Loading…</div>';

    if (mode === 'receive') {
      qs('#wsHint', body).textContent = 'Items requested but not fully received. Type the quantity that arrived — add the price and invoice now if you have them, or leave blank and price it later on the Awaiting-price tab.';
      const list = await api('/stores/pending?limit=400' + qstr);
      qs('#wsCount', body).textContent = `${list.length}${list.length === 400 ? '+ (showing first 400)' : ''} line(s) awaiting receipt`;
      qs('#wsTable', body).innerHTML = list.length ? tableWrap(
        [{ label: 'MRN' }, { label: 'Req date' }, { label: 'Vehicle' }, { label: 'Item', cls: 'desc-col' },
          { label: 'Ord', num: true }, { label: 'Recv', num: true }, { label: 'Pending', num: true },
          { label: 'Qty now', num: true }, { label: 'Received as', width: '150px' },
          { label: 'GRN No' }, { label: 'GRN date' }, { label: 'Received' },
          { label: 'Unit price', num: true }, { label: 'Supplier' }, { label: 'Invoice' }, { label: 'Source' }],
        list.map((r) => `<tr>
          <td><a href="#/stores?tab=mrn&id=${r.mrn_id}">${esc(r.mrn_no || '')}</a></td>
          <td>${esc(String(r.req_date || '').slice(0, 10))}</td>
          <td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>` : '—'}</td>
          <td class="desc-col">${esc(r.description || '')}</td>
          <td class="num">${num(r.ordered)}</td>
          <td class="num">${num(r.received)}${
  // The "Received" column to the right is the date being entered NOW; this says when the
  // part-delivery already on the books turned up, so the two are not confused. Through the
  // shared rule, not by hand: keying it off last_received alone claimed a part-delivery on
  // the line whose only receipt had been reversed — on the very screen used to key goods in.
  receivedUnder(r)}</td>
          <td class="num"><span class="badge amber">${num(r.pending)}</span></td>
          ${cell(r.id, 'qty', '', { type: 'number', num: true, step: 'any', min: 0, w: '74px', ph: String(r.pending) })}
          ${receivedAsCell(r)}
          ${cell(r.id, 'grn_no', '', { w: '92px', ph: 'GRN no' })}
          ${cell(r.id, 'grn_date', '', { type: 'date', w: '126px' })}
          ${cell(r.id, 'delivery_date', new Date().toISOString().slice(0, 10), { type: 'date', w: '126px' })}
          ${cell(r.id, 'unit_price', '', { type: 'number', num: true, step: '0.01', min: 0, w: '96px' })}
          ${cell(r.id, 'supplier', r.supplier || '', { w: '110px' })}
          ${cell(r.id, 'invoice_no', '', { w: '96px' })}
          ${cell(r.id, 'purchase_source', r.source || '', { type: 'select', options: SRC_OPTS })}</tr>`),
        { scroll: true }) : '<div class="card"><p class="muted">Nothing outstanding — every requested item is fully received.</p></div>';
    } else {
      qs('#wsHint', body).textContent = 'Stock that arrived without a price. Type the unit price (and invoice details if you have them) straight down the column, then Save — these are missing from job and vehicle costs until priced.';
      const list = await api('/stores/awaiting-price?limit=400' + qstr);
      qs('#wsCount', body).textContent = `${list.length}${list.length === 400 ? '+ (showing first 400)' : ''} receipt(s) awaiting a price`;
      qs('#wsTable', body).innerHTML = list.length ? tableWrap(
        [{ label: 'GRN No' }, { label: 'GRN date' }, { label: 'Received' }, { label: 'MRN' }, { label: 'Vehicle' },
          { label: 'Item', cls: 'desc-col' },
          { label: 'Qty', num: true }, { label: 'Unit price', num: true }, { label: 'Value', num: true },
          { label: 'Supplier' }, { label: 'Invoice' }, { label: 'Source' }],
        list.map((r) => `<tr>
          ${cell(r.id, 'grn_no', r.grn_no || '', { w: '92px', ph: 'GRN no' })}
          ${cell(r.id, 'grn_date', String(r.grn_date || '').slice(0, 10), { type: 'date', w: '126px' })}
          ${cell(r.id, 'delivery_date', String(r.delivery_date || '').slice(0, 10), { type: 'date', w: '126px' })}
          <td>${r.mrn_id ? `<a href="#/stores?tab=mrn&id=${r.mrn_id}">${esc(r.mrn_no || '')}</a>` : esc(r.mrn_no || '')}</td>
          <td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>` : '—'}</td>
          <td class="desc-col">${esc(r.description || '')}${r.received_part_no
    ? ` <span class="badge blue" title="a cross-referenced equivalent was supplied against the number requested">received as ${esc(r.received_part_no)}</span>` : ''}</td>
          <td class="num">${num(r.qty)}</td>
          ${cell(r.id, 'unit_price', '', { type: 'number', num: true, step: '0.01', min: 0, w: '104px' })}
          <td class="num muted" data-val="${r.id}">—</td>
          ${cell(r.id, 'supplier', r.supplier || '', { w: '120px' })}
          ${cell(r.id, 'invoice_no', r.invoice_no || '', { w: '104px' })}
          ${cell(r.id, 'purchase_source', r.source || '', { type: 'select', options: SRC_OPTS })}</tr>`),
        { scroll: true }) : '<div class="card"><p class="muted">Everything received has a price. 🎉</p></div>';
      // live value = qty × the price being typed
      const qtyById = Object.fromEntries(list.map((r) => [String(r.id), Number(r.qty) || 0]));
      qsa('#wsTable input[data-f="unit_price"]', body).forEach((inp) => {
        inp.addEventListener('input', () => {
          const cellEl = qs(`[data-val="${inp.dataset.id}"]`, body);
          if (cellEl) cellEl.textContent = inp.value ? money(Number(inp.value) * qtyById[inp.dataset.id]) : '—';
        });
      });
    }
    wire();
  };

  if (saveBtn) saveBtn.onclick = async () => {
    if (!edits.size) return;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const rows = [...edits.entries()].map(([id, f]) => ({ id: Number(id), ...f }));
    try {
      if (mode === 'receive') {
        // Only lines where a quantity was actually typed become receipts.
        const payload = rows.filter((r) => Number(r.qty) > 0).map((r) => ({ mrn_line_id: r.id, ...r }));
        if (!payload.length) { toast('Type the quantity received on at least one line', 'err'); paintSave(); return; }
        const res = await api('/stores/grn/bulk-receive', { method: 'POST', body: { rows: payload } });
        toast(`✓ Received ${res.received} line(s) across ${res.mrns} MRN(s)` + (res.skipped && res.skipped.length ? ` · ${res.skipped.length} skipped (over-receipt)` : ''));
        if (res.skipped && res.skipped.length) res.skipped.forEach((s) => toast(`Line ${s.mrn_line_id}: ${s.reason}`, 'err'));
      } else {
        const res = await api('/stores/grn/bulk-price', { method: 'POST', body: { rows } });
        toast(`✓ Saved ${res.saved} price update(s)`);
      }
      await load();
    } catch (e) { toast(e.message, 'err'); paintSave(); }
  };

  qs('#wsRecv', body).onclick = () => { mode = 'receive'; load(); };
  qs('#wsPrice', body).onclick = () => { mode = 'price'; load(); };
  let wsdeb; qs('#wsq', body).oninput = () => { clearTimeout(wsdeb); wsdeb = setTimeout(load, 250); };
  qs('#wssrc', body).onchange = load;
  await load();
}

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
      [{ label: 'MRN No' }, { label: 'Date' }, { label: 'Vehicle' }, { label: 'Job Card' }, { label: 'Source' }, { label: 'Lines', num: true }, { label: 'Qty Req', num: true }, { label: 'Qty Recd', num: true }, { label: 'Received date' }, { label: 'Status' }],
      list.map((m) => `<tr data-mrn="${m.id}" style="cursor:pointer${m.approval_status === 'rejected' ? ';background:rgba(196,57,44,.06)' : ''}">
        <td><button class="sm" data-exp="${m.id}" title="Show the items on this MRN here" style="padding:0 6px;margin-right:4px">▸</button><a href="#/stores?tab=mrn&id=${m.id}">${esc(m.mrn_no)}</a></td>
        <td>${esc((m.req_date || '').slice(0, 10))}</td>
        <td>${esc(idLabel(m) || '—')}</td>
        <td>${m.job_no ? `<a href="#/jobs/${m.job_id}">${esc(m.job_no)}</a>` : '<span class="muted">—</span>'}</td>
        <td>${esc(sourceLabel(m.purchase_source))}</td>
        <td class="num">${m.line_count}</td>
        <td class="num">${num(m.qty_requested)}</td>
        <td class="num">${num(m.qty_received)}</td>
        <td style="white-space:nowrap">${receivedDate(m)}</td>
        <td>${m.approval_status === 'rejected' ? '<span class="badge red">✕ Cancelled (rejected)</span>' : receiptBadge(m.qty_requested, m.qty_received)}</td></tr>`), { scroll: true });
    qsa('[data-mrn]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.tagName === 'A' || e.target.dataset.exp) return;      // link / expander handle themselves
      location.hash = '#/stores?tab=mrn&id=' + tr.dataset.mrn;
    });
    // ▸ opens the MRN's items in a row underneath — no page change, list keeps its place.
    qsa('[data-exp]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const tr = b.closest('tr');
      const open = tr.nextElementSibling && tr.nextElementSibling.classList.contains('mrn-lines');
      if (open) { tr.nextElementSibling.remove(); b.textContent = '▸'; return; }
      b.textContent = '▾';
      const holder = document.createElement('tr');
      holder.className = 'mrn-lines';
      holder.innerHTML = `<td colspan="10" style="background:var(--surface-2);padding:8px 12px"><span class="muted">Loading items…</span></td>`;
      tr.after(holder);
      try {
        const d = await api('/stores/mrn/' + b.dataset.exp);
        const rows = d.lines.map((l) => {
          const req = Number(l.qty) || 0, rec = Number(l.qty_received) || 0;
          const st = rec <= 0 ? '<span class="badge amber">not received</span>'
            : rec < req ? '<span class="badge blue">partial</span>' : '<span class="badge green">received</span>';
          return `<tr><td>${esc(l.description || '')}</td><td>${esc(l.category || '')}</td>
            <td class="num">${num(req)}</td><td class="num">${num(rec)}</td>
            <td style="white-space:nowrap">${receivedDate(l)}</td>
            <td class="num">${req - rec > 0 ? `<b>${num(req - rec)}</b>` : '—'}</td><td>${st}</td></tr>`;
        }).join('');
        holder.firstChild.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${d.lines.length} item(s) on ${esc(d.mrn.mrn_no)}${d.mrn.purpose ? ' — ' + esc(d.mrn.purpose) : ''}</div>`
          + tableWrap([{ label: 'Item' }, { label: 'Category' }, { label: 'Qty', num: true }, { label: 'Received', num: true }, { label: 'Received date' }, { label: 'Pending', num: true }, { label: 'Status' }], [rows])
          + `<div style="margin-top:6px"><a class="btn sm" href="#/stores?tab=mrn&id=${b.dataset.exp}">Open full MRN →</a>
             <a class="btn sm" href="#/stores?tab=workspace&mode=receive">Receive items →</a></div>`;
      } catch (err) { holder.firstChild.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
    });
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
  const astatus0 = m.approval_status || 'requested';
  const canEditLines = canRx && astatus0 !== 'approved' && astatus0 !== 'rejected'
    && !(astatus0 === 'requested' && !(m.requested_by && String(m.requested_by).trim()));
  const lineRows = d.lines.map((l) => {
    const req = Number(l.qty) || 0, rec = Number(l.qty_received) || 0;
    const remaining = Math.max(0, req - rec);
    const status = rec <= 0 ? '<span class="badge amber">Pending received</span>'
      : rec < req ? '<span class="badge blue">Partial received</span>'
      : '<span class="badge green">✓ Received</span>';
    return `<tr>
      <td>${esc(l.description || '')}${l.added_after_approval
  ? ` <span class="badge red" title="${esc('Added after this request was approved, by ' + (l.added_by || 'an admin') + (l.added_at ? ' on ' + l.added_at : '') + (l.added_reason ? ' — ' + l.added_reason : ''))}">added after approval</span>` : ''}</td>
      <td>${esc(l.category || '')}</td>
      <td class="num">${num(l.qty)} ${esc(l.unit || '')}</td>
      <td class="num">${num(l.qty_received)}</td>
      <td style="white-space:nowrap">${receivedDate(l)}</td>
      <td class="num">${remaining > 0 ? `<span class="badge amber">${num(remaining)}</span>` : '<span class="badge green">0</span>'}</td>
      <td>${status}</td>
      ${canRx ? `<td class="num" style="white-space:nowrap">${remaining > 0 ? `<button class="sm primary" data-rx="${l.id}" data-desc="${esc(l.description || '')}" data-rem="${remaining}">Receive</button>` : '✓'}${
  // An item can be corrected until approval; one already part-received can only have its
  // quantity raised, and cannot be removed at all.
  canEditLines ? ` <button class="sm" data-ledit="${l.id}">✎</button>${rec > 0 ? '' : ` <button class="sm danger" data-ldel="${l.id}" data-desc="${esc(l.description || '')}">✕</button>`}` : ''}</td>` : ''}</tr>`;
  });
  const grnRows = d.grns.map((g) => `<tr>
    <td>${esc(g.grn_no || '—')}</td>
    <td style="white-space:nowrap">${g.delivery_date ? esc(String(g.delivery_date).slice(0, 10)) : '<span class="muted">—</span>'}</td>
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
  // Correctable right up until approval. After that the request IS the authority to spend.
  const canEditReq = canRx && astatus !== 'approved' && astatus !== 'rejected' && !isImported;
  // A settled request — signed off, or an imported record shown as "approved (imported)" — is
  // frozen to everyone but an admin, who may still put a forgotten item on it rather than raise
  // a second request for one line. That covers almost the whole book: 25 approved and 1,651
  // imported. The approval is not disturbed; the item itself is marked, with the reason.
  const adminAmend = can('admin') && (astatus === 'approved' || isImported);
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
      ${isImported ? `<p class="muted" style="margin:8px 0 0">Imported record — predates the approval workflow, so it is treated as already approved. No certification/approval is required.${
  adminAmend ? ' As an admin you may still add a forgotten item to it: the item is marked as added later, with your reason.' : ''}</p>` : `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:8px;font-size:13px">
        <div><b>1 · Requested</b>${m.requested_sig ? `<div style="height:30px"><img src="${m.requested_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(m.requested_by, m.req_date)}<br><span class="muted">Storekeeper</span></div>
        <div><b>2 · Certified</b>${m.certified_sig ? `<div style="height:30px"><img src="${m.certified_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(m.certified_by, m.certified_at)}<br><span class="muted">Workshop Engineer</span></div>
        <div><b>3 · Approved</b>${m.approved_sig ? `<div style="height:30px"><img src="${m.approved_sig}" style="max-height:30px;max-width:130px"></div>` : ''}<br>${sig(m.approved_by, m.approved_at)}<br><span class="muted">Operational Manager</span></div>
      </div>
      ${(d.approvals && d.approvals.length) ? `<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:6px">${d.approvals.map((a) => `<div class="cost-line"><span>${a.decision === 'rejected' ? '✕' : '✓'} ${esc(a.stage)} — <b>${esc(a.signed_name || '')}</b> <span class="muted">(${esc(a.role || '')})</span>${a.reason ? ' · ' + esc(a.reason) : ''}</span><span class="muted">${esc((a.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>`).join('')}</div>` : ''}`}
    </div>
    <div class="card">
      <div class="toolbar" style="margin:0 0 6px">
        <h3 style="margin:0">MRN ${esc(m.mrn_no)} ${receiptBadge(d.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0), d.lines.reduce((s, l) => s + (Number(l.qty_received) || 0), 0))} ${aBadge}</h3>
        <div class="spacer"></div>
        ${canEditReq ? '<button class="sm" id="medit">✎ Edit request</button> <button class="sm" id="maddline">+ Add item</button>' : ''}
        ${adminAmend ? '<button class="sm danger" id="maddline" title="Admin only — the approval stands, and the item is marked as added after it">+ Add item (after approval)</button>' : ''}
      </div>
      <p class="muted">Date ${esc((m.req_date || '').slice(0, 10))} · Vehicle ${esc(idLabel(m) || '—')} · Job ${m.job_no ? `<a href="#/jobs/${m.job_id}">${esc(m.job_no)}</a> <span class="badge ${STATUS_CLASS[m.job_status] || ''}">${esc(m.job_status || '')}</span>` : 'not linked'} · Source ${esc(sourceLabel(m.purchase_source))}${m.purpose ? ' · ' + esc(m.purpose) : ''}${m.requested_by ? ' · by ' + esc(m.requested_by) : ''}</p>
      ${canEditReq && astatus === 'certified' ? '<p class="muted" style="font-size:12px;margin:0 0 6px">This request is certified. Changing what was asked for withdraws that certification and sends it back to the Workshop Engineer.</p>' : ''}
      ${astatus === 'approved' ? `<p class="muted" style="font-size:12px;margin:0 0 6px">Approved — the request is now the authority to spend, so it can no longer be changed.${
  // Telling an admin it cannot be changed, next to a button that changes it, would be a lie.
  adminAmend ? ' As an admin you may still add a forgotten item: the approval stands, and the item is marked as added after it.' : ''}</p>` : ''}
      ${tableWrap([{ label: 'Item description' }, { label: 'Category' }, { label: 'Qty requested', num: true }, { label: 'Qty received', num: true }, { label: 'Received date' }, { label: 'Remaining', num: true }, { label: 'Status' }].concat(canRx ? [{ label: '', num: true }] : []), lineRows, { scroll: true })}
    </div>
    <div class="card">
      <h3>Received records — GRN <span class="muted">(${d.grns.length})</span></h3>
      ${d.grns.length
        ? tableWrap([{ label: 'GRN No' }, { label: 'Received' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Value', num: true }, { label: 'Supplier' }, { label: 'Source' }].concat(canRx ? [{ label: '', num: true }] : []), grnRows, { scroll: true })
        : '<p class="muted">Nothing received against this MRN yet.</p>'}
    </div>`;
  if (canRx) {
    qsa('[data-rx]').forEach((btn) => btn.onclick = () => receiveModal(m, btn.dataset.rx, btn.dataset.desc, btn.dataset.rem, () => mrnDetail(body, id)));
    qsa('[data-price]').forEach((btn) => btn.onclick = () => grnPriceModal(d.grns.find((x) => String(x.id) === btn.dataset.price), () => mrnDetail(body, id)));
  }
  const reload = () => mrnDetail(body, id);
  // A change that withdraws a certification must say so — the request has gone back a step.
  const told = (r) => { if (r && r.recertification_required) toast('Saved — certification withdrawn, the Workshop Engineer must certify it again', 'err'); else toast('Saved'); };

  if (qs('#medit')) qs('#medit').onclick = () => mrnEditModal(m, reload, told);
  if (qs('#maddline')) qs('#maddline').onclick = () => mrnLineModal(null, m, reload, told);
  qsa('[data-ledit]').forEach((b) => { b.onclick = () => mrnLineModal(d.lines.find((x) => String(x.id) === b.dataset.ledit), m, reload, told); });
  qsa('[data-ldel]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Remove "${b.dataset.desc}" from this request?`)) return;
      try { told(await api('/stores/mrn/line/' + b.dataset.ldel, { method: 'DELETE' })); reload(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });

  if (qs('#mcertify')) qs('#mcertify').onclick = () => mrnSignModal(m, 'certify', () => mrnDetail(body, id));
  if (qs('#mapprove')) qs('#mapprove').onclick = () => mrnSignModal(m, 'approve', () => mrnDetail(body, id));
  if (qs('#mreject')) qs('#mreject').onclick = () => mrnSignModal(m, 'reject', () => mrnDetail(body, id));
}

// Correct the request itself — who asked, what for, when it is needed, which machine.
function mrnEditModal(m, onDone, told) {
  modal('Edit request — ' + esc(m.mrn_no), `
    ${m.approval_status === 'certified' ? '<p class="muted" style="margin-top:0">This request is certified. Saving a change here withdraws that certification and sends it back to the Workshop Engineer.</p>' : ''}
    <div class="fgrid">
      <div class="fld">${field('Request date', 'req_date', { type: 'date', value: String(m.req_date || '').slice(0, 10) })}</div>
      <div class="fld">${field('Required by', 'required_date', { type: 'date', value: String(m.required_date || '').slice(0, 10) })}</div>
      <div class="fld">${field('Requested by', 'requested_by', { value: m.requested_by || '' })}</div>
    </div>
    ${field('Purpose', 'purpose', { value: m.purpose || '' })}
    ${field('Purchase source', 'purchase_source', { type: 'select', value: m.purchase_source || '',
    options: [{ value: '', label: '—' }, { value: 'head_office', label: 'Head Office' }, { value: 'local_purchase', label: 'Local Purchase' }] })}
    <p class="muted" style="font-size:12px;margin:6px 0 0">The machine and job this request is for are set when it is raised — reject and re-raise if those are wrong.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save changes</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      const f = formData(b);
      try {
        told(await api('/stores/mrn/' + m.id, { method: 'PATCH', body: {
          req_date: f.req_date, required_date: f.required_date, requested_by: f.requested_by,
          purpose: f.purpose, purchase_source: f.purchase_source,
        } }));
        close(); onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// Add or correct one requested item. `line` null = adding.
function mrnLineModal(line, m, onDone, told) {
  const rec = Number(line && line.qty_received) || 0;
  // Adding to a request that has already been approved is an override: it needs a reason, and
  // the reason is kept with the item and on the approval trail.
  const wasImported = (m.approval_status || 'requested') === 'requested' && !(m.requested_by && String(m.requested_by).trim());
  const afterApproval = !line && ((m.approval_status === 'approved') || wasImported);
  modal(line ? 'Edit item' : (afterApproval ? 'Add item to filed request — ' : 'Add item to ') + esc(m.mrn_no), `
    ${afterApproval ? `<p class="muted" style="margin-top:0;padding:8px;border-left:3px solid var(--red);background:var(--surface-2)">
      <b>${esc(m.mrn_no)} ${wasImported ? 'was already filed' : 'is already approved'}.</b> ${wasImported
    ? 'It came in with the imported records, so it is treated as approved and nobody is expected to change it.'
    : 'The approval stands and receiving carries on — but this item was not part of what was signed for.'}
      The item will be marked <b>added after approval</b> with your name and reason, on the request, on the printed
      form and on the approval trail.</p>` : ''}
    ${rec > 0 ? `<p class="muted" style="margin-top:0">${num(rec)} already received against this item — the quantity cannot go below that.</p>` : ''}
    ${field('Item description *', 'description', { value: line ? line.description || '' : '' })}
    <div class="row">
      ${field('Quantity *', 'qty', { type: 'number', step: 'any', min: rec || 0, value: line ? line.qty : '' })}
      ${field('Unit', 'unit', { value: line ? line.unit || '' : 'nos' })}
    </div>
    ${field('Category', 'category', { value: line ? line.category || '' : '' })}
    ${afterApproval ? field('Why is it being added? *', 'reason', { placeholder: 'e.g. missed off the original request — same job, same delivery' }) : ''}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">${line ? 'Save changes' : 'Add item'}</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      const f = formData(b);
      if (!String(f.description || '').trim()) return toast('Describe the item', 'err');
      if (!(Number(f.qty) > 0)) return toast('Enter a quantity', 'err');
      if (afterApproval && !String(f.reason || '').trim()) return toast('Say why it is being added to an approved request', 'err');
      try {
        told(line
          ? await api('/stores/mrn/line/' + line.id, { method: 'PATCH', body: { description: f.description, qty: f.qty, unit: f.unit, category: f.category } })
          : await api('/stores/mrn/' + m.id + '/lines', { method: 'POST', body: { description: f.description, qty: f.qty, unit: f.unit, category: f.category, reason: f.reason } }));
        close(); onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
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

// ---- MRN request target: ANY vehicle, job card optional --------------------
// A request is raised against the VEHICLE. If that vehicle has open job cards they
// are offered for linking (one open card is pre-selected), because linking is what
// makes the request gate that job's closure — but it is never required.
function mrnTargetHtml(idp) {
  return `<label>Request for</label>
    <div class="pill-row" style="margin-bottom:6px">
      <label style="font-weight:400"><input type="radio" name="${idp}_type" value="vehicle" checked style="width:auto"> Machine / Vehicle</label>
      <label style="font-weight:400"><input type="radio" name="${idp}_type" value="general" style="width:auto"> General item (store)</label>
    </div>
    <div id="${idp}_veh">
      ${assetPickerHtml('Vehicle / machine *')}
      <div id="${idp}_jobs" class="muted" style="font-size:12px;margin-top:4px">Any vehicle can be requested for — a job card is optional.</div>
    </div>`;
}
function wireMrnTarget(root, idp) {
  const state = { type: 'vehicle', job_id: '' };
  const veh = qs('#' + idp + '_veh', root), jobsEl = qs('#' + idp + '_jobs', root);
  wireAssetPicker(root);
  const hidden = qs('input[name=asset_id]', root), input = qs('.apick-input', root);
  qsa('input[name=' + idp + '_type]', root).forEach((r) => { r.onchange = () => {
    state.type = r.value;
    veh.style.display = r.value === 'vehicle' ? 'block' : 'none';
    // Coming back to Machine/Vehicle, the select is still on screen showing a card — so the
    // state has to agree with it, or the request saves unlinked while claiming otherwise.
    const sel = qs(`select[name=${idp}_job]`, jobsEl);
    state.job_id = r.value === 'general' ? '' : (sel ? sel.value : '');
  }; });

  const loadJobs = async () => {
    state.job_id = '';
    if (!hidden.value) { jobsEl.innerHTML = 'Any vehicle can be requested for — a job card is optional.'; return; }
    let open = [];
    try { open = await api('/jobs?open=1&limit=10&asset_id=' + encodeURIComponent(hidden.value)); } catch (e) { return; }
    if (!open.length) {
      jobsEl.innerHTML = 'No open job card for this vehicle — the request is recorded against the vehicle itself.';
      return;
    }
    // Newest card first and always pre-selected, "— none —" last. It used to be the other
    // way round whenever a vehicle had two open cards, so the 34 vehicles carrying a stale
    // card were exactly the ones whose requests defaulted to being linked to no job at all.
    jobsEl.innerHTML = `<label style="margin-top:6px">Link to job card <span class="muted" style="font-weight:400">(optional — links the request to that job's closure gate)</span></label>
      <select name="${idp}_job">${open.map((j) => `<option value="${j.id}">${esc(j.job_no)} · ${esc(j.status)}</option>`).join('')}<option value="">— none —</option></select>
      ${open.length > 1 ? `<div class="muted" style="font-size:12px;margin-top:4px">${open.length - 1} older open card${open.length > 2 ? 's' : ''} on this vehicle — the newest is pre-selected.</div>` : ''}`;
    const sel = qs(`select[name=${idp}_job]`, jobsEl);
    state.job_id = sel.value;
    sel.onchange = () => { state.job_id = sel.value; };
  };
  // The asset picker fills its hidden id on mousedown — hook the same event.
  root.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.apick-item')) setTimeout(loadJobs, 0);
  }, true);
  if (input) input.addEventListener('input', () => { state.job_id = ''; jobsEl.innerHTML = 'Any vehicle can be requested for — a job card is optional.'; });

  return () => ({ type: state.type, job_id: state.job_id, asset_id: hidden.value, asset: input ? input.value.trim() : '' });
}

// ---- one requested item: catalogue search, or a brand-new item -------------
let _mrnLineSeq = 0;
function mrnLineHtml(defSrc) {
  const lid = 'mrnl' + (++_mrnLineSeq);
  const fld = (...args) => `<div class="fld">${field(...args)}</div>`;
  return `<div class="mrnline" data-lid="${lid}">
    <div class="mrnline-h"><span class="mrnline-n"></span><button type="button" class="sm danger mrnline-x" title="Remove this item">✕</button></div>
    <div style="position:relative">
      <label>Item</label>
      <input type="text" name="ldesc" id="${lid}_q" autocomplete="off" placeholder="Search the item catalogue, or type a new item…">
      <input type="hidden" name="litem">
      <div id="${lid}_menu" style="position:absolute;z-index:60;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);max-height:220px;overflow:auto;display:none"></div>
      <div class="muted" id="${lid}_hint" style="font-size:11px;margin-top:2px">Pick one from the catalogue, or just type a new item.</div>
    </div>
    <div class="fgrid" style="margin-top:6px">
      ${fld('Qty', 'lqty', { type: 'number', value: 1 })}
      ${fld('Unit', 'lunit', { value: 'nos' })}
      ${fld('Head Office / Local', 'lsrc', { type: 'select', options: SOURCE_OPTS, value: defSrc })}
      <div class="fld">${categoryPickerHtml({ label: 'Category', name: 'lcat' })}</div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;flex-direction:row;font-weight:400;margin-top:6px"><input type="checkbox" name="lnew" style="width:auto"> Add this as a new catalogue item</label>
  </div>`;
}
function wireMrnLine(row) {
  const lid = row.dataset.lid;
  const input = qs('#' + lid + '_q', row), menu = qs('#' + lid + '_menu', row), hint = qs('#' + lid + '_hint', row);
  const hItem = qs('input[name=litem]', row), unit = qs('input[name=lunit]', row), isNew = qs('input[name=lnew]', row);
  wireCategoryPickers(row);
  let deb;
  const close = () => { menu.style.display = 'none'; };
  input.oninput = () => {
    hItem.value = ''; // typing invalidates a prior pick
    hint.textContent = 'New item — tick the box below to add it to the catalogue.';
    clearTimeout(deb);
    deb = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) return close();
      let rows = [];
      try { rows = await api('/stores/items/search?q=' + encodeURIComponent(q) + '&limit=12'); } catch (e) { return; }
      menu.innerHTML = rows.length
        ? rows.map((r) => `<div class="mrnpick" data-id="${r.id || ''}" data-lube="${r.is_lubricant ? 1 : ''}" data-name="${esc(r.name)}" data-unit="${esc(r.unit || 'nos')}" data-cat="${r.category_id || ''}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)">
            <b>${esc(r.name)}</b>${r.item_no ? ` <span class="stamp">${esc(r.item_no)}</span>` : ''}${r.is_lubricant ? ' <span class="badge blue">oil book</span>' : ''}
            <div class="muted" style="font-size:11px">${esc(catPath(r) || '')}${r.part_numbers ? ' · ' + esc(String(r.part_numbers).slice(0, 40)) : ''}${r.req_count ? ' · requested ' + num(r.req_count) + '×' : ''}</div></div>`).join('')
        : '<div class="muted" style="padding:8px 10px">No catalogue match — it will be requested as typed.</div>';
      menu.style.display = 'block';
      qsa('.mrnpick', menu).forEach((it) => { it.onmousedown = (e) => {
        e.preventDefault();
        clearTimeout(deb);
        input.value = it.dataset.name;
        hItem.value = it.dataset.id;
        if (it.dataset.unit) unit.value = it.dataset.unit;
        if (it.dataset.cat) setCategoryPicker(row, it.dataset.cat);
        // A lubricant's identity is its catalogue NAME — written exactly, it resolves to that
        // product everywhere without anyone having to teach the system another spelling.
        hint.textContent = it.dataset.lube
          ? 'From the oil book — recorded against this exact lubricant, so it counts as oil stock.'
          : 'Catalogue item — name, unit and category come from the catalogue.';
        isNew.checked = false;
        close();
      }; });
    }, 220);
  };
  input.onblur = () => setTimeout(close, 150);
}

async function newMrnModal() {
  let nextNo = '';
  try { nextNo = (await api('/stores/numbers')).next_mrn; } catch (e) { /* leave blank -> auto */ }
  // fld() keeps a label glued to its input. field() emits them as siblings, so dropping two
  // fields straight into a flex/grid row splits the pairs up and the form reads scrambled.
  const fld = (...args) => `<div class="fld">${field(...args)}</div>`;
  const bg = modal('New MRN', `
    <div class="mrnsec">
      <div class="mrnsec-h">1 · Request details</div>
      <div class="fgrid">
        ${fld('MRN Number', 'mrn_no', { value: nextNo })}
        ${fld('Date', 'req_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}
        ${fld('Required date', 'required_date', { type: 'date' })}
        ${fld('Project / Workshop', 'purpose', { placeholder: 'e.g. Badalgama W/Shop' })}
        ${fld('Requested by', 'requested_by', { placeholder: 'name' })}
        ${fld('Default source', 'purchase_source', { type: 'select', options: SOURCE_OPTS })}
      </div>
      <p class="muted" style="font-size:11.5px;margin:6px 0 0">Number continues from <b>${esc(nextNo || 'auto')}</b> — change it to force a specific one. “Default source” pre-fills each item below; you can still set Head Office / Local per item.</p>
    </div>
    <div class="mrnsec">
      <div class="mrnsec-h">2 · What is it for?</div>
      ${mrnTargetHtml('mrnt')}
    </div>
    <div class="mrnsec">
      <div class="mrnsec-h">3 · Items requested <span id="lcount" class="muted" style="font-weight:400"></span></div>
      <div id="lines"></div>
      <button class="sm" id="addline" style="margin-top:4px">+ add another item</button>
    </div>
    <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;align-items:center">
      <span class="muted" id="mrnerr" style="margin-right:auto;color:var(--danger,#c4392c)"></span>
      <button class="sm" id="cancel">Cancel</button>
      <button class="primary" id="s">Create MRN</button>
    </div>`, (body, close) => {
    const getTarget = wireMrnTarget(body, 'mrnt');
    const lines = qs('#lines', body);
    // Keep the item cards numbered, and only offer ✕ when there is more than one.
    const renumber = () => {
      const rows = qsa('.mrnline', lines);
      rows.forEach((r, i) => {
        const n = qs('.mrnline-n', r); if (n) n.textContent = 'Item ' + (i + 1);
        const x = qs('.mrnline-x', r); if (x) x.style.display = rows.length > 1 ? '' : 'none';
      });
      const c = qs('#lcount', body); if (c) c.textContent = `— ${rows.length} item(s)`;
    };
    const addLine = () => {
      const defSrc = qs('[name=purchase_source]', body) ? qs('[name=purchase_source]', body).value : '';
      const holder = document.createElement('div');
      holder.innerHTML = mrnLineHtml(defSrc);
      const row = holder.firstElementChild;
      lines.appendChild(row);
      wireMrnLine(row);
      const x = qs('.mrnline-x', row);
      if (x) x.onclick = () => { row.remove(); renumber(); };
      renumber();
      const q = qs('input[name=ldesc]', row); if (q) q.focus();
    };
    addLine();
    qs('#addline', body).onclick = addLine;
    if (qs('#cancel', body)) qs('#cancel', body).onclick = close;
    // Changing the default source updates any item row still left on "—".
    const defSel = qs('[name=purchase_source]', body);
    if (defSel) defSel.onchange = () => {
      qsa('select[name=lsrc]', lines).forEach((s) => { if (!s.value) s.value = defSel.value; });
    };
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      const val = (n) => qsa('[name=' + n + ']', body).map((e) => (e.type === 'checkbox' ? e.checked : e.value));
      const descs = val('ldesc'), items = val('litem'), units = val('lunit');
      const qtys = val('lqty'), srcs = val('lsrc'), cats = val('lcat'), news = val('lnew');
      const t = getTarget();
      if (t.type === 'vehicle' && !t.asset_id && !t.asset) return toast('Pick the vehicle / machine this request is for', 'err');
      const payload = {
        mrn_no: d.mrn_no, req_date: d.req_date, request_type: t.type,
        asset_id: t.type === 'vehicle' ? (t.asset_id || undefined) : undefined,
        asset: t.type === 'vehicle' && !t.asset_id ? t.asset : undefined,
        job_id: t.type === 'vehicle' ? (t.job_id || undefined) : undefined,
        purchase_source: d.purchase_source || undefined, purpose: d.purpose, required_date: d.required_date, requested_by: d.requested_by,
        lines: descs.map((desc, i) => ({
          description: desc, unit: units[i] || 'nos', qty: qtys[i],
          store_item_id: items[i] || undefined, create_item: news[i] || undefined,
          purchase_source: srcs[i] || undefined, category_id: cats[i] || undefined,
        })).filter((l) => l.description),
      };
      if (!payload.lines.length) return toast('Add at least one item', 'err');
      try {
        const r = await api('/stores/mrn', { method: 'POST', body: payload });
        close();
        if (r.unresolved) toast('MRN ' + r.mrn.mrn_no + ' created — vehicle "' + r.unresolved.raw + '" queued in the Alias Queue', 'err');
        else toast('MRN ' + r.mrn.mrn_no + ' created');
        location.hash = '#/stores?tab=mrn&id=' + r.mrn.id;
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  // A request form needs room — the default 520px dialog squeezes these fields together.
  const box = qs('.modal', bg);
  if (box) { box.style.width = 'min(860px, 96vw)'; box.style.maxWidth = 'none'; }
}

// ---- item picker for issues: catalogue search that fills price + category ---
function issueItemHtml(idp) {
  return `<div style="position:relative"><label>Item *</label>
    <input type="text" id="${idp}_q" name="description" autocomplete="off" placeholder="Search store items…">
    <input type="hidden" name="store_item_id">
    <div id="${idp}_menu" style="position:absolute;z-index:60;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);max-height:220px;overflow:auto;display:none"></div>
  </div>`;
}
function wireIssueItem(root, idp) {
  const input = qs('#' + idp + '_q', root), menu = qs('#' + idp + '_menu', root);
  const hId = qs('input[name=store_item_id]', root), price = qs('input[name=unit_price]', root);
  let deb;
  const close = () => { menu.style.display = 'none'; };
  input.oninput = () => {
    hId.value = ''; // typed text stands on its own until an item is picked
    clearTimeout(deb);
    deb = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) return close();
      let rows = [];
      try { rows = await api('/stores/items/search?q=' + encodeURIComponent(q) + '&limit=12'); } catch (e) { return; }
      menu.innerHTML = rows.length
        ? rows.map((r) => `<div class="ipick" data-id="${r.id}" data-name="${esc(r.name)}" data-cat="${r.category_id || ''}" data-price="${r.last_price == null ? '' : r.last_price}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)">
            <b>${esc(r.name)}</b>${r.item_no ? ` <span class="stamp">${esc(r.item_no)}</span>` : ''}
            <div class="muted" style="font-size:11px">${esc(catPath(r) || '')}${r.last_price != null ? ' · last ' + money(r.last_price) : ''}${r.is_general ? ' · in stock ' + num(r.balance) : ''}</div></div>`).join('')
        : '<div class="muted" style="padding:8px 10px">No item — free text kept</div>';
      menu.style.display = 'block';
      qsa('.ipick', menu).forEach((el) => { el.onmousedown = (e) => {
        e.preventDefault();
        clearTimeout(deb);
        input.value = el.dataset.name;
        hId.value = el.dataset.id;
        if (el.dataset.price && price && !price.value) price.value = el.dataset.price;
        if (el.dataset.cat) setCategoryPicker(root, el.dataset.cat);
        close();
      }; });
    }, 200);
  };
  input.onblur = () => setTimeout(close, 150);
}

// ---- New Issue -------------------------------------------------------------
// Four steps down the page: who it's for (job card or bare vehicle) → which section →
// search and pick the item → check the lines and issue. Several items go out on one
// trip to the store, so the form takes several lines rather than one item per popup.
const ISSUE_SECTIONS = [
  { key: '', label: 'All sections' },
  { key: 'oil', label: 'Oil & Lubricants' },
  { key: 'filter', label: 'Filters' },
  { key: 'battery', label: 'Batteries' },
  { key: 'tyre', label: 'Tyres' },
  { key: 'general', label: 'General Stock' },
];
const SECTION_LABEL = { oil: 'Oil & Lube', filter: 'Filter', battery: 'Battery', tyre: 'Tyre', general: 'General' };

function newIssueModal(onDone) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];          // the items about to go out
  let section = '';          // '' = search everything
  let mode = 'job';          // 'job' | 'vehicle'

  modal('New Issue', `
    <div class="istep"><span class="istep-n">1</span> Who is this issue for?</div>
    <div class="pill-row" style="margin-bottom:8px">
      <button type="button" class="sm primary" id="ni-mjob">Job card</button>
      <button type="button" class="sm" id="ni-mveh">Vehicle only (no job card)</button>
    </div>
    <div id="ni-job">${jobPickerHtml('nis-job', { label: 'Job card * — the vehicle comes from the job' })}</div>
    <div id="ni-veh" style="display:none">${assetPickerHtml('Vehicle *')}</div>

    <div id="ni-recv-wrap" style="display:none">
      <div class="istep" style="margin-top:14px"><span class="istep-n">2</span> In store for this vehicle
        <span class="muted" style="font-weight:400;font-size:12px" id="ni-recv-count"></span>
        <span class="spacer"></span>
        <label class="muted" style="font-weight:400;font-size:11.5px;display:flex;align-items:center;gap:4px">
          <input type="checkbox" id="ni-recv-all" style="width:auto;margin:0"> show fully issued too</label>
      </div>
      <div id="ni-recv" class="ni-recv"></div>
    </div>

    <div class="istep" style="margin-top:14px"><span class="istep-n">3</span> Or pick from the catalogue — which section?</div>
    <div class="pill-row" id="ni-secs">
      ${ISSUE_SECTIONS.map((s) => `<button type="button" class="sm${s.key === '' ? ' primary' : ''}" data-sec="${s.key}">${esc(s.label)}</button>`).join('')}
    </div>

    <input type="search" id="ni-q" autocomplete="off" placeholder="Item code, name, part number, or an MRN number — e.g. C-1121, grease, 141636…">
    <div id="ni-res" class="ni-res"></div>

    <div class="istep" style="margin-top:14px"><span class="istep-n">4</span> Issue these items</div>
    <div id="ni-lines"></div>

    <div class="row" style="margin-top:10px">
      <div class="fld">${field('Issue date', 'issue_date', { type: 'date', value: today })}</div>
      <div class="fld">${field('Issued by', 'issued_by')}</div>
    </div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Record issue</button></div>`,
    (body, close) => {
      const getJob = wireJobPicker(body, 'nis-job');
      wireAssetPicker(body);
      const res = qs('#ni-res', body), lineBox = qs('#ni-lines', body), q = qs('#ni-q', body);

      // -- step 1 toggle
      const setMode = (m) => {
        mode = m;
        qs('#ni-mjob', body).classList.toggle('primary', m === 'job');
        qs('#ni-mveh', body).classList.toggle('primary', m === 'vehicle');
        qs('#ni-job', body).style.display = m === 'job' ? '' : 'none';
        qs('#ni-veh', body).style.display = m === 'vehicle' ? '' : 'none';
      };
      qs('#ni-mjob', body).onclick = () => setMode('job');
      qs('#ni-mveh', body).onclick = () => setMode('vehicle');

      // -- step 4 line list
      const drawLines = () => {
        if (!lines.length) {
          lineBox.innerHTML = '<div class="muted" style="padding:10px 2px">No items yet — search above and click one to add it.</div>';
          return;
        }
        lineBox.innerHTML = `<table class="ni-tab"><thead><tr>
            <th>Code</th><th>Item</th><th>Section</th><th class="r">Available</th>
            <th class="r">Qty</th><th class="r">Unit price</th><th>Note</th><th></th></tr></thead><tbody>
          ${lines.map((l, i) => {
            const short = l.qty > l.balance;
            return `<tr>
              <td><b>${esc(l.code)}</b></td>
              <td>${esc(l.name)}${l.part_no && l.part_no !== l.name ? ` <span class="muted">· ${esc(l.part_no)}</span>` : ''}${l.grn_id ? ' <span class="badge blue" style="font-size:10px">from store</span>' : ''}</td>
              <td>${esc(SECTION_LABEL[l.section] || l.section)}</td>
              <td class="r${short ? ' warn' : ''}">${num(l.balance)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
              <td class="r"><input type="number" step="0.01" min="0" class="ni-qty" data-i="${i}" value="${l.qty}" style="width:78px;text-align:right"></td>
              <td class="r"><input type="number" step="0.01" min="0" class="ni-price" data-i="${i}" value="${l.unit_price == null ? '' : l.unit_price}" style="width:96px;text-align:right"></td>
              <td><input type="text" class="ni-note" data-i="${i}" value="${esc(l.note || '')}" placeholder="optional" style="width:130px"></td>
              <td><button type="button" class="sm danger ni-del" data-i="${i}">✕</button></td>
            </tr>${short ? `<tr class="ni-warn"><td colspan="8">⚠ ${esc(l.code)} — issuing ${num(l.qty)} but only ${num(l.balance)} ${l.grn_id ? 'left on that receipt' : 'on record'}. It will be recorded anyway.</td></tr>` : ''}`;
          }).join('')}
        </tbody></table>`;
        qsa('.ni-qty', lineBox).forEach((el) => { el.onchange = () => { lines[+el.dataset.i].qty = Number(el.value) || 0; drawLines(); }; });
        qsa('.ni-price', lineBox).forEach((el) => { el.onchange = () => { lines[+el.dataset.i].unit_price = el.value === '' ? null : Number(el.value); }; });
        qsa('.ni-note', lineBox).forEach((el) => { el.onchange = () => { lines[+el.dataset.i].note = el.value; }; });
        qsa('.ni-del', lineBox).forEach((el) => { el.onclick = () => { lines.splice(+el.dataset.i, 1); drawLines(); }; });
      };
      drawLines();

      const addLine = (it) => {
        const dup = lines.find((l) => (it.grn_id ? l.grn_id === it.grn_id : (!l.grn_id && l.id === it.id)));
        if (dup) { dup.qty = Math.round((dup.qty + 1) * 100) / 100; toast(dup.code + ' — qty is now ' + num(dup.qty)); }
        else lines.push({ ...it, qty: 1, note: '' });
        drawLines();
      };

      // A received line, shaped like a catalogue line so the basket treats both the same.
      // `balance` is what is LEFT on that receipt, not the section balance — the storekeeper
      // is handing over this specific delivery, not drawing from general stock.
      const fromReceipt = (r) => ({
        grn_id: r.grn_id, id: 'grn' + r.grn_id, code: 'MRN ' + r.mrn_no, name: r.description,
        section: r.section, unit: r.unit, unit_price: r.unit_price, balance: r.remaining, part_no: null,
      });

      // -- step 2: what is already in store for this vehicle
      const recvWrap = qs('#ni-recv-wrap', body), recvBox = qs('#ni-recv', body), recvCount = qs('#ni-recv-count', body);
      let recvKey = '';
      const loadReceived = async (force) => {
        const p = new URLSearchParams();
        // Scoped to the MACHINE, which is what this step says it shows. Scoping to the chosen
        // card instead hid whatever had been received against the machine's other open cards —
        // 352 shelf lines across 27 machines. The issue itself still books to the card picked.
        if (mode === 'job') {
          const j = getJob();
          if (!j.job_id) { recvWrap.style.display = 'none'; recvKey = ''; return; }
          if (j.asset_id) p.set('asset_id', j.asset_id); else p.set('job_id', j.job_id);
        }
        else { const id = qs('#ni-veh input[type=hidden]', body).value; if (!id) { recvWrap.style.display = 'none'; recvKey = ''; return; } p.set('asset_id', id); }
        if (qs('#ni-recv-all', body).checked) p.set('include_done', '1');
        const key = p.toString();
        if (key === recvKey && !force) return;
        recvKey = key;
        recvWrap.style.display = '';
        recvBox.innerHTML = '<div class="muted" style="padding:8px 2px">Loading what is in store…</div>';
        const CAP = 300;
        let rows = [];
        try { rows = await api(`/stores/received?limit=${CAP}&` + key); }
        catch (e) { recvBox.innerHTML = `<div class="muted" style="padding:8px 2px">${esc(e.message)}</div>`; return; }
        if (key !== recvKey) return; // a newer selection already won
        // Say so rather than quietly showing a partial list — only the two stores pseudo-vehicles
        // are anywhere near this many, but a silent cut reads as "that is everything".
        recvCount.textContent = rows.length
          ? ` · ${rows.length}${rows.length >= CAP ? '+ (showing the newest ' + CAP + ' — use the search below for older ones)' : ''} item${rows.length === 1 ? '' : 's'}`
          : '';
        if (!rows.length) {
          recvBox.innerHTML = '<div class="muted" style="padding:8px 2px">Nothing received for this vehicle is still waiting in store.</div>';
          return;
        }
        recvBox.innerHTML = rows.map((r, i) => `<div class="ni-hit${r.remaining <= 0 ? ' done' : ''}" data-i="${i}">
            <span class="ni-mrn">${esc(r.mrn_no || '')}</span>
            ${esc(r.description)}
            <span class="muted"> · ${esc(String(r.received_date || '').slice(0, 10))}${r.source ? ' · ' + esc(r.source) : ''}</span>
            <span class="ni-bal${r.remaining > 0 ? ' ok' : ''}">${r.remaining <= 0 ? 'all issued' : num(r.remaining) + ' of ' + num(r.qty) + ' left'}${r.unit_price != null ? ' · ' + money(r.unit_price) : ''}</span>
          </div>`).join('');
        qsa('.ni-hit', recvBox).forEach((el) => {
          el.onclick = () => { const r = rows[+el.dataset.i]; if (r.remaining > 0 || qs('#ni-recv-all', body).checked) addLine(fromReceipt(r)); };
        });
      };
      qs('#ni-recv-all', body).onchange = () => loadReceived(true);
      // The job and vehicle pickers commit their choice internally with no change event to
      // listen for, so watch for a settled selection. Stops itself when the dialog goes away.
      const watch = setInterval(() => {
        if (!body.isConnected) return clearInterval(watch);
        loadReceived(false);
      }, 600);

      // -- step 3 search. An MRN number is a perfectly good way to find a part — it is what is
      // written on the paperwork in the storekeeper's hand — so a numeric term is looked up as
      // an MRN as well, and its received lines are offered alongside the catalogue matches.
      let deb;
      const search = async () => {
        const term = q.value.trim();
        if (term.length < 2) { res.innerHTML = ''; return; }
        res.innerHTML = '<div class="muted" style="padding:8px 2px">Searching…</div>';
        const looksLikeMrn = /^[0-9][0-9/\-]{2,}$/.test(term);
        const [items, received] = await Promise.all([
          api('/stores/stock-items/search?limit=25&section=' + encodeURIComponent(section) + '&q=' + encodeURIComponent(term)).catch(() => []),
          looksLikeMrn ? api('/stores/received?limit=40&mrn=' + encodeURIComponent(term)).catch(() => []) : Promise.resolve([]),
        ]);
        const recv = section ? received.filter((r) => r.section === section) : received;
        if (!items.length && !recv.length) {
          res.innerHTML = `<div class="muted" style="padding:8px 2px">Nothing matches${looksLikeMrn ? ' that item or MRN number' : ''} — try the part number, or widen the section.</div>`;
          return;
        }
        const recvHtml = recv.map((r, i) => `<div class="ni-hit" data-r="${i}">
            <span class="ni-mrn">${esc(r.mrn_no || '')}</span>
            ${esc(r.description)}${r.vehicle ? ` <span class="muted">· ${esc(r.vehicle)}</span>` : ''}
            <span class="muted"> · ${esc(SECTION_LABEL[r.section] || r.section)}</span>${
  // Same line the "in store for this vehicle" panel shows — how long it has sat on the shelf.
  r.received_date ? `<span class="muted"> · received ${esc(String(r.received_date).slice(0, 10))}</span>` : ''}
            <span class="ni-bal ok">${num(r.remaining)} of ${num(r.qty)} left${r.unit_price != null ? ' · ' + money(r.unit_price) : ''}</span>
          </div>`).join('');
        const itemHtml = items.map((r, i) => `<div class="ni-hit" data-i="${i}">
            <b>${esc(r.code)}</b> ${esc(r.name)}${r.part_no && r.part_no !== r.name ? ` <span class="muted">· ${esc(r.part_no)}</span>` : ''}
            <span class="muted"> · ${esc(SECTION_LABEL[r.section] || r.section)}</span>
            <span class="ni-bal${r.balance > 0 ? ' ok' : ''}">${num(r.balance)}${r.unit ? ' ' + esc(r.unit) : ''}</span>
          </div>`).join('');
        res.innerHTML = (recv.length ? `<div class="ni-grp">On MRN ${esc(term)} — in store</div>${recvHtml}` : '')
                      + (items.length ? `${recv.length ? '<div class="ni-grp">Catalogue</div>' : ''}${itemHtml}` : '');
        qsa('.ni-hit[data-i]', res).forEach((el) => { el.onclick = () => addLine(items[+el.dataset.i]); });
        qsa('.ni-hit[data-r]', res).forEach((el) => { el.onclick = () => addLine(fromReceipt(recv[+el.dataset.r])); });
      };
      q.oninput = () => { clearTimeout(deb); deb = setTimeout(search, 200); };
      qsa('#ni-secs button', body).forEach((b) => {
        b.onclick = () => {
          section = b.dataset.sec;
          qsa('#ni-secs button', body).forEach((o) => o.classList.toggle('primary', o === b));
          search();
        };
      });

      // -- submit
      qs('#s', body).onclick = async () => {
        const d = formData(body);
        const payload = { issue_date: d.issue_date, issued_by: d.issued_by };
        let where = '';
        if (mode === 'job') {
          const j = getJob();
          if (!j.job_id) return toast('Pick the job card this issue belongs to', 'err');
          payload.job_id = j.job_id; where = j.job_no;
        } else {
          if (!d.asset_id) return toast('Pick the vehicle this issue is for', 'err');
          payload.asset_id = d.asset_id; where = d.asset || 'the vehicle';
        }
        const use = lines.filter((l) => l.qty > 0);
        if (!use.length) return toast('Add at least one item to issue', 'err');
        payload.lines = use.map((l) => (l.grn_id
          ? { grn_id: l.grn_id, qty: l.qty, unit_price: l.unit_price, note: l.note }
          : { stock_item_id: l.id, qty: l.qty, unit_price: l.unit_price, note: l.note }));

        const btn = qs('#s', body);
        btn.disabled = true;
        // A closed card can take a late issue, but only deliberately — same confirm as postIssue().
        const send = async (p) => {
          try { return await api('/stores/stock-issue', { method: 'POST', body: p }); }
          catch (e) {
            if (!(e.data && e.data.needs_confirm)) throw e;
            if (!confirm(`${e.data.job_no} is ${e.data.job_status}. Record this issue against it anyway?`)) return null;
            return api('/stores/stock-issue', { method: 'POST', body: { ...p, allow_closed: true } });
          }
        };
        try {
          const r = await send(payload);
          if (!r) { btn.disabled = false; return; }
          close();
          toast(`${r.issued.length} item${r.issued.length === 1 ? '' : 's'} issued to ${r.landed_on ? where + ' · ' + r.landed_on : where}`);
          if (r.warnings && r.warnings.length) toast(r.warnings.join(' · '), 'err');
          if (onDone) onDone(); else render();
        } catch (e) { btn.disabled = false; toast(e.message, 'err'); }
      };
    }, { wide: true });
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
        // Raising is never blocked, but approval will be until the open card closes.
        else if (r.open_job) toast(`Request ${r.request.jr_no} created — note ${r.open_job.job_no} is still open for this vehicle`, 'err');
        else toast('Job request ' + r.request.jr_no + ' created');
        location.hash = '#/jobrequests/' + r.request.id;
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- Oil
routes.oil = async (c) => {
  const tab = (location.hash.split('?')[1] && new URLSearchParams(location.hash.split('?')[1]).get('tab')) || 'products';
  const tabs = ['products', 'names', 'ledger', 'stock', 'forecast', 'counts'];
  c.innerHTML = pageHeader('Oil & Lubricant Stock Book') + `<div class="toolbar">${tabs.map((t) => `<button class="sm ${t === tab ? 'primary' : ''}" onclick="location.hash='#/oil?tab=${t}'">${t.toUpperCase()}</button>`).join('')}<div class="spacer"></div><a class="btn sm" href="/api/oil/export/ledger.xlsx">⬇ Ledger Excel</a></div><div id="oilbody" class="muted">Loading…</div>`;
  const body = qs('#oilbody');
  if (tab === 'stock') {
    return stockPanel(body, 'oil');
  } else if (tab === 'products') {
    const list = await api('/oil/products');
    body.innerHTML = `${can('storekeeper') ? '<div class="toolbar"><button class="primary" id="ntop">⛽ Issue a lubricant</button><button class="sm" id="np">+ New Product</button><button class="sm" id="nl">+ Ledger Txn</button></div>' : ''}
      ${tableWrap([{ label: 'Code' }, { label: 'Name' }, { label: 'Unit' }, { label: 'Category' }, { label: 'Balance', num: true }, { label: 'Reorder', num: true }, { label: 'Unit Price', num: true }],
        list.map((p) => `<tr><td>${esc(p.code || '')}</td><td>${esc(p.name)}</td><td>${esc(p.unit)}</td><td>${esc(p.category || '')}</td><td class="num ${p.current_balance <= p.reorder_level ? '' : ''}">${p.current_balance <= p.reorder_level && p.reorder_level > 0 ? `<span class="badge amber">${num(p.current_balance)}</span>` : num(p.current_balance)}</td><td class="num">${num(p.reorder_level)}</td><td class="num">${money(p.unit_price)}</td></tr>`), { scroll: true })}`;
    if (qs('#np')) qs('#np').onclick = () => simpleCreateModal('New Product', '/oil/products', [['Code', 'code'], ['Name *', 'name'], ['Unit (L/kg/nos)', 'unit'], ['Category', 'category'], ['Reorder level', 'reorder_level', 'number'], ['Unit price', 'unit_price', 'number']]);
    if (qs('#nl')) qs('#nl').onclick = () => newLedgerModal(list);
    // Issuing moved to Stores (owner, 2026-08-21) — one door, so a drum handed over is written
    // down once. The button stays where the storekeeper's hand already goes, and takes them there.
    if (qs('#ntop')) qs('#ntop').onclick = () => { location.hash = '#/stores?tab=movements&sub=issues'; };
  } else if (tab === 'names') {
    // The same drum is written differently on every piece of paper it touches. Until a name is
    // matched to a product it is not lubricant stock — so this list is the gap between what the
    // store recorded and what the oil book knows about.
    const d = await api('/oil/aliases/unresolved');
    const editable = can('storekeeper');
    const opts = (sel) => ['<option value="">— not a lubricant —</option>']
      .concat(d.catalogue.map((p) => `<option value="${p.id}"${String(sel) === String(p.id) ? ' selected' : ''}>${esc(p.code || '')} · ${esc(p.name)}</option>`)).join('');
    body.innerHTML = `
      <p class="muted" style="margin-top:0">Names seen on requests, receipts, issues and transfers that match no lubricant in the book.
      Say which one each is and it becomes stock again; leave it as <b>not a lubricant</b> and it stays out of the oil balance
      (a grease gun and an oil seal are not litres). Nothing here is guessed — <b>HD 68 Oil (Valvoline)</b> and
      <b>HD-68 Hy/Oil Caltex</b> are two different oils, so a bare “HD-68 Oil” is a question, not a match.</p>
      ${d.unresolved.length ? tableWrap(
    [{ label: 'Name as written', cls: 'desc-col' }, { label: 'Seen', num: true, width: '64px' },
      { label: 'Movements', num: true, width: '90px' }, { label: 'Outside the balance', num: true, width: '140px' },
      { label: 'This is…', width: '280px' }],
    d.unresolved.map((r) => `<tr>
          <td class="desc-col"><b>${esc(r.raw_text)}</b></td>
          <td class="num">${num(r.hit_count)}</td>
          <td class="num">${num(r.moves)}</td>
          <td class="num">${r.qty_outside_balance ? `<span class="badge amber">${num(r.qty_outside_balance)}</span>` : '—'}</td>
          <td>${editable ? `<select data-alias="${r.id}" style="width:100%">${opts(r.product_id)}</select>` : '<span class="muted">—</span>'}</td></tr>`), { scroll: true })
    : '<div class="card"><p class="muted">Every name on record matches a lubricant. Nothing to identify.</p></div>'}
      ${(d.not_lubricant && d.not_lubricant.length) ? `<div class="card section">
        <div class="toolbar" style="margin:0 0 6px"><h3 style="margin:0">Ruled out</h3>
          <div class="spacer"></div><span class="badge">${d.not_lubricant.length}</span></div>
        <p class="muted" style="font-size:11.5px;margin:0 0 8px">Names already settled as not being a lubricant — tools, tanks, seals, repair notes.
        They keep their category and stay out of the oil balance. Put one back if it was a mistake.</p>
        ${tableWrap([{ label: 'Name', cls: 'desc-col' }, { label: 'Movements', num: true, width: '96px' }, { label: '', width: '150px' }],
    d.not_lubricant.map((r) => `<tr><td class="desc-col">${esc(r.raw_text)}</td><td class="num">${num(r.moves)}</td>
            <td>${editable ? `<button class="sm" data-reopen="${r.id}">↩ Not settled</button>` : ''}</td></tr>`), { scroll: true })}
      </div>` : ''}`;
    qsa('[data-alias]', body).forEach((sel) => { sel.onchange = async () => {
      try {
        await api('/oil/aliases/' + sel.dataset.alias, { method: 'PATCH', body: { product_id: sel.value || null } });
        toast(sel.value ? 'Name identified — rebuild stock to apply it' : 'Marked as not a lubricant');
        routes.oil(c);
      } catch (e) { toast(e.message, 'err'); sel.value = ''; }
    }; });
    qsa('[data-reopen]', body).forEach((b) => { b.onclick = async () => {
      try {
        await api('/oil/aliases/' + b.dataset.reopen, { method: 'PATCH', body: { reset: true } });
        toast('Back on the list to identify'); routes.oil(c);
      } catch (e) { toast(e.message, 'err'); }
    }; });
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

// oilTopupModal was the second door for handing a lubricant out. Retired 2026-08-21 — Stores →
// Issue is now the only one, so the handover, the stock move and the cost all come from one record.

async function newLedgerModal(products) {
  modal('New Oil Ledger Txn', `
    ${field('Product', 'product_id', { type: 'select', options: products.map((p) => ({ value: p.id, label: p.name })) })}
    <div class="row">${field('Kind', 'kind', { type: 'select', options: ['receipt', 'opening', 'adjustment'].map((v) => ({ value: v, label: v })) })}${field('Qty', 'qty', { type: 'number' })}</div>
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
    <div class="card section"><h3 style="margin-top:0">Stock position <span class="muted" style="font-weight:400;font-size:12px">— requested, received, issued and what's left, from the shared stock ledger</span></h3>
      <div id="bt-stock"></div></div>
    <div class="toolbar">
      <input id="bwhere" placeholder="Where is serial…?" style="max-width:220px"><button class="sm" id="bwbtn">Find</button>
      <div class="spacer"></div>${canEdit('batteries') ? '<button class="primary" id="nb">+ Add Battery</button>' : ''}
    </div>
    ${radar.expiring.length ? `<div class="card section"><h3>Warranty expiring ≤60 days</h3>${radar.expiring.map((b) => `<div class="cost-line"><a href="#/batteries/${b.id}">${esc(b.serial_no)}</a><span class="badge amber">${esc(b.warranty_date)} · ${esc(b.current_asset_code || 'store')}</span></div>`).join('')}</div>` : ''}
    ${tableWrap([{ label: 'Serial' }, { label: 'Brand' }, { label: 'Ah', num: true }, { label: 'State' }, { label: 'Current Asset' }, { label: 'Warranty' }],
      list.map((b) => `<tr>
        <td>${b.photo_count ? `<span title="${b.photo_count} photo${b.photo_count === 1 ? '' : 's'}">📷${b.photo_count > 1 ? b.photo_count : ''} </span>` : ''}<a href="#/batteries/${b.id}">${esc(b.serial_no)}</a></td>
        <td>${esc(b.brand || '')}</td><td class="num">${b.capacity_ah || ''}</td>
        <td><span class="badge ${b.state === 'installed' ? 'green' : b.state === 'decommissioned' ? 'red' : ''}">${esc(b.state)}</span></td>
        <td>${b.current_asset_code ? `${esc(b.current_asset_code)}${b.on_vehicle > 1 ? ` <span class="badge blue" title="${esc(b.current_asset_code)} is carrying a pair">pair</span>` : ''}` : '—'}</td>
        <td>${esc(b.warranty_date || '')}</td></tr>`), { scroll: true })}`;
  stockPanel(qs('#bt-stock', c), 'battery');
  qs('#bwbtn').onclick = async () => { const s = qs('#bwhere').value.trim(); if (!s) return; try { const r = await api('/batteries/whereis/' + encodeURIComponent(s)); toast(s + ' → ' + (r.current_asset ? r.current_asset.code : 'in store') + ' (' + r.battery.state + ')'); } catch { toast('Serial not found', 'err'); } };
  if (qs('#nb')) qs('#nb').onclick = newBatteryModal;
};

// Kept in step with MAX_PHOTOS / MAX_PER_VEHICLE in src/routes/batteries.js, which enforce them.
const BATTERY_PHOTO_MAX = 6;
const BATTERY_PER_VEHICLE_MAX = 2;

function newBatteryModal() {
  modal('Add Battery', `
    <div class="row">${field('Serial No *', 'serial_no')}${field('Brand', 'brand')}</div>
    <div class="row">${field('Capacity Ah', 'capacity_ah', { type: 'number' })}${field('Condition', 'condition', { type: 'select', options: [{ value: 'new', label: 'new' }, { value: 'old', label: 'old' }] })}</div>
    <div class="row">${field('Purchase date', 'purchase_date', { type: 'date' })}${field('Warranty date', 'warranty_date', { type: 'date' })}</div>
    ${field('Install on asset (code/text)', 'current_asset')}
    <p class="muted" style="font-size:11.5px;margin:2px 0 0">A vehicle takes up to 2 batteries. If it already has two, return or decommission one first.</p>
    <label style="margin-top:10px">Battery photos <span class="muted" style="font-weight:400">— up to ${BATTERY_PHOTO_MAX}: the serial plate, its condition, anything a warranty claim would need</span></label>
    ${multiImageHtml('batimg', BATTERY_PHOTO_MAX)}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add Battery</button></div>`, (body, close) => {
    const up = wireMultiImage(body, 'batimg');
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      if (!String(d.serial_no || '').trim()) return toast('Serial No is required', 'err');
      d.photos = up.dataURLs();
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
      <div class="spacer"></div>${editable ? `<button class="sm" id="photo">📷 Add photos</button><button class="sm" id="ev">+ Event</button>` : ''}</div>
    ${(b.on_same_vehicle && b.on_same_vehicle.length) ? `<div class="card section" style="margin-bottom:12px">
      <div class="toolbar" style="margin:0 0 6px"><h3 style="margin:0">Also on ${esc(bat.current_asset_code || 'this vehicle')}</h3>
        <div class="spacer"></div><span class="badge ${(b.on_same_vehicle.length + 1) >= BATTERY_PER_VEHICLE_MAX ? 'green' : ''}">${b.on_same_vehicle.length + 1} of ${BATTERY_PER_VEHICLE_MAX} fitted</span></div>
      <p class="muted" style="font-size:11.5px;margin:0 0 6px">A pair is fitted and replaced together, so the other one is here too.</p>
      ${b.on_same_vehicle.map((o) => `<div class="cost-line"><span><a href="#/batteries/${o.id}">${esc(o.serial_no)}</a> <span class="muted">${esc(o.brand || '')} ${o.capacity_ah ? o.capacity_ah + 'Ah' : ''}</span></span><span class="badge">${esc(o.state)}</span></div>`).join('')}
    </div>` : ''}
    <div class="grid section">
      <div class="card"><h3>Photos <span class="muted" style="font-weight:400;font-size:12px">— ${(b.photos || []).length} of ${b.max_photos || BATTERY_PHOTO_MAX}</span></h3>
        <div id="bphotos" style="display:flex;flex-wrap:wrap;gap:8px">${(b.photos || []).length
    ? b.photos.map((p) => `<div style="position:relative">
            <a href="${p.photo}" target="_blank" title="${esc(p.note || 'Open full size')}"><img src="${p.photo}" alt="Battery ${esc(bat.serial_no)}" style="height:120px;width:120px;object-fit:cover;border:1px solid var(--border);border-radius:8px"></a>
            ${editable ? `<button class="btn sm danger" data-delphoto="${p.id}" title="Remove this photo" style="position:absolute;top:-6px;right:-6px;padding:0 6px;line-height:18px">✕</button>` : ''}
          </div>`).join('')
    : `<p class="muted">No photos yet.${editable ? ' Use “Add photos”.' : ''}</p>`}</div></div>
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
  const room = (b.max_photos || BATTERY_PHOTO_MAX) - (b.photos || []).length;
  if (qs('#photo')) qs('#photo').onclick = () => {
    if (room <= 0) return toast(`This battery already has all ${b.max_photos || BATTERY_PHOTO_MAX} photos — remove one first`, 'err');
    modal('Add photos — ' + bat.serial_no, `
      <label>Battery photos <span class="muted" style="font-weight:400">— ${room} more can be added</span></label>
      ${multiImageHtml('bpimg', room)}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save photos</button></div>`,
    (body, close) => {
      const up = wireMultiImage(body, 'bpimg');
      qs('#s', body).onclick = async () => {
        const shots = up.dataURLs();
        if (!shots.length) return toast('Choose at least one photo', 'err');
        try {
          await api(`/batteries/${id}/photos`, { method: 'POST', body: { photos: shots } });
          toast(`${shots.length} photo${shots.length === 1 ? '' : 's'} added`); close(); batteryDetail(c, id);
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  };
  qsa('[data-delphoto]').forEach((btn) => { btn.onclick = async () => {
    if (!confirm('Remove this photo?')) return;
    try { await api(`/batteries/${id}/photos/${btn.dataset.delphoto}`, { method: 'DELETE' }); toast('Photo removed'); batteryDetail(c, id); }
    catch (e) { toast(e.message, 'err'); }
  }; });
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
  if (params[0] === 'service' && params[1] && params[2] === 'edit') {
    if (!canEdit('filters')) return toast('You do not have permission to edit services', 'err');
    return renderNewServiceForm(c, await api('/filters/services/' + params[1]));
  }
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
    const CAP = 500;
    const list = await api('/filters/services?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + 'limit=' + CAP);
    // Say when the list is cut off. A bare "500 services" reads as "that is all of them",
    // and there are over sixteen hundred.
    qs('#scount').textContent = `${list.length} service${list.length === 1 ? '' : 's'}`
      + (list.length >= CAP ? ` — showing the newest ${CAP}, search a vehicle to narrow it` : '');
    // fit-table + wrapping text columns → the table always fills the window and adapts to any
    // screen size (no horizontal or inner vertical scrollbar); number columns keep fixed widths.
    qs('#stable').innerHTML = tableWrap(
      [
        { label: 'Date', width: '92px' },
        { label: 'Vehicle', cls: 'desc-col' },
        { label: 'Type', cls: 'desc-col', width: '90px' },
        { label: 'Site', cls: 'desc-col' },
        { label: 'Filters', num: true, width: '58px' },
        { label: 'Missing', num: true, width: '64px' },
        { label: 'Labor', num: true, width: '100px' },
        { label: 'Cost', num: true, width: '112px' },
        { label: 'Outside Labor Value', num: true, width: '118px' },
      ].concat(editable ? [{ label: '', width: '52px' }] : []),
      list.map((s) => `<tr data-svc="${s.id}" style="cursor:pointer">
        <td>${esc((s.service_date || '').slice(0, 10))}</td>
        <td class="desc-col">${esc(idLabel(s) || s.vehicle_label || '—')}</td>
        <td class="desc-col">${esc(s.service_type || '')}</td>
        <td class="desc-col">${esc(s.site_location || '')}</td>
        <td class="num">${num(s.filter_count)}</td>
        <td class="num">${s.missing_count > 0 ? `<span class="badge amber">${num(s.missing_count)}</span>` : '<span class="badge green">0</span>'}</td>
        <td class="num">${money(s.labour_charge)}</td>
        <td class="num">${money(s.computed_cost)}</td>
        <td class="num"><input type="number" min="0" step="0.01" class="svc-out" data-id="${s.id}" value="${!s.outside_estimate ? '' : s.outside_estimate}" placeholder="—" style="width:100%;max-width:110px;box-sizing:border-box;text-align:right" ${editable ? '' : 'disabled'}></td>
        ${editable ? `<td><a class="btn sm svc-edit" href="#/filters/service/${s.id}/edit" title="Edit this service">✏️</a></td>` : ''}</tr>`),
      { scroll: true, fit: true, noHScroll: true });
    qsa('[data-svc]', c).forEach((tr) => tr.onclick = () => { location.hash = '#/filters/service/' + tr.dataset.svc; });
    // The outside-value box saves in place (same store the Job Cost Report reads) — clicks inside it
    // must not open the service-detail page.
    // The pencil is inside a row that opens the record — let the link do its own job.
    qsa('.svc-edit', c).forEach((a) => { a.onclick = (e) => e.stopPropagation(); });
    qsa('.svc-out', c).forEach((inp) => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = async (e) => {
        e.stopPropagation();
        try {
          await api('/reports/service-outside', { method: 'POST', body: { items: [{ id: inp.dataset.id, outside: inp.value }] } });
          toast('Outside labor value saved');
        } catch (err) { toast(err.message, 'err'); }
      };
    });
  };
  if (qs('#nsvc')) qs('#nsvc').onclick = () => { location.hash = '#/filters/new-service'; };
  let deb; qs('#sq').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  await load();
}

// Full "Vehicle / Machinery Service Details" form — matches the paper layout.
// The same form records a service and edits one back: `existing` is the payload from
// GET /filters/services/:id, and everything below fills from it. Editing through the form it
// was written on means the two can never drift apart or disagree about what a field means.
async function renderNewServiceForm(c, existing) {
  const edit = existing ? existing.service : null;
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
      <td style="position:relative"><input type="text" class="f_no" autocomplete="off" placeholder="type to search…" style="width:120px">
        <div class="f_menu" style="position:absolute;z-index:80;left:0;top:100%;min-width:300px;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:var(--shadow);max-height:230px;overflow:auto;display:none"></div></td>
      <td><input type="number" class="f_qty" value="1" style="width:48px"></td>
      <td><select class="f_xe" style="width:52px"><option value=""></option><option>X</option><option>E</option></select></td>
      <td><input type="number" class="f_price" style="width:96px"></td></tr>`).join('');
  const back = edit ? `<a href="#/filters/service/${edit.id}">← Back to the record</a>` : '<a href="#/filters?tab=services">← Service Records</a>';
  c.innerHTML = `${pageHeader('Vehicle / Machinery Service Details', back)}
    <div class="card">
      <div class="mrnsec">
        <div class="mrnsec-h">Which machine</div>
        <div class="fgrid">
          <div class="fld" style="grid-column:span 2">${assetPickerHtml('Vehicle / Machine * — type a code and pick it')}</div>
          <div class="fld">${field('Date', 'service_date', { type: 'date', value: edit ? String(edit.service_date || '').slice(0, 10) : today })}</div>
        </div>
        <div class="fgrid" style="margin-top:10px">
          <div class="fld">${field('Reg. ID', 'reg_id')}</div>
          <div class="fld">${field('E&C Code', 'ec_code_disp')}</div>
          <div class="fld">${field('Model', 'model_no')}</div>
        </div>
        <p class="muted" style="font-size:11.5px;margin:6px 0 0">Reg. ID, E&amp;C code and model fill in by themselves once you pick the machine.</p>
      </div>
      <div class="mrnsec" style="margin-bottom:0">
        <div class="mrnsec-h">This service</div>
        <div class="fgrid">
          <div class="fld">${field('Job / Service No.', 'job_no')}</div>
          <div class="fld">${field('Service Type', 'service_type', { placeholder: 'e.g. 5000 Hrs' })}</div>
          <div class="fld">${field('Meter Reading', 'meter_reading')}</div>
          <div class="fld">${field('Next Service at', 'next_service_meter')}</div>
          <div class="fld">${field('Location (Site)', 'site_location')}</div>
          <div class="fld">${field('Up-keeping', 'upkeeping', { type: 'select', options: [{ value: '', label: '—' }, { value: 'Good', label: 'Good (G)' }, { value: 'Fair', label: 'Fair (F)' }, { value: 'Bad', label: 'Bad (B)' }] })}</div>
        </div>
      </div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
      <div class="card"><div class="toolbar" style="margin:0 0 8px">
          <h3 style="margin:0">Oils / Lubricants</h3><div class="spacer"></div>
          <input type="search" id="oilFind" placeholder="Find an oil…" style="max-width:150px;font-size:12px">
          <label class="muted" style="font-size:11.5px;display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="oilOnlyUsed" style="width:auto;margin:0"> only filled</label>
        </div>
        <div class="table-wrap scroll"><table><thead><tr><th>Oil Name</th><th>Type</th><th>C/V</th><th>Liters</th><th>Price</th></tr></thead>
          <tbody id="oilBody">${oilRows}</tbody></table></div>
        <p class="muted" style="font-size:11.5px;margin:6px 0 0" id="oilCount"></p></div>
      <div class="card"><div class="toolbar" style="margin:0 0 8px">
          <h3 style="margin:0">Filters</h3><div class="spacer"></div>
          <input type="search" id="filFind" placeholder="Find a filter…" style="max-width:150px;font-size:12px">
          <label class="muted" style="font-size:11.5px;display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="filOnlyUsed" style="width:auto;margin:0"> only filled</label>
        </div>
        <div class="table-wrap scroll"><table><thead><tr><th>Filter</th><th>Filter No.</th><th>Qty</th><th>X/E</th><th>Price</th></tr></thead>
          <tbody id="filterBody">${filterRows}</tbody></table></div>
        <p class="muted" style="font-size:11.5px;margin:6px 0 0" id="filCount">Type a filter number in the box to search — picking one fills its price.</p></div>
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
        <div style="margin-top:12px;text-align:right"><a class="btn sm" href="${edit ? '#/filters/service/' + edit.id : '#/filters?tab=services'}">Cancel</a> <button class="primary" id="saveService">${edit ? 'Save Changes' : 'Create Service'}</button></div>
      </div>
    </div>`;

  // ---- editing: put the record back into the form it was written on -------
  // Oils and filters are laid out one row per stocked oil / per filter category, which is the
  // paper sheet's shape — so a service that used two filters of one category, or an oil no
  // longer on the list, needs a row adding for the surplus rather than quietly losing it.
  if (edit) {
    for (const [name, val] of [
      ['reg_id', edit.reg_id], ['ec_code_disp', edit.asset_ec], ['model_no', edit.model_no],
      ['job_no', edit.job_no], ['service_type', edit.service_type], ['meter_reading', edit.meter_reading],
      ['next_service_meter', edit.next_service_meter], ['site_location', edit.site_location],
      ['upkeeping', edit.upkeeping], ['repair_details', edit.repair_details],
    ]) { const el = qs(`[name=${name}]`, c); if (el) el.value = val == null ? '' : val; }
    qs('.apick-input', c).value = idLabel(edit) || edit.vehicle_label || '';
    qs('input[name=asset_id]', c).value = edit.asset_id || '';
    if (edit.labour_rate != null) qs('#labourRate', c).value = edit.labour_rate;
    if (edit.sundry_rate != null) qs('#sundryRate', c).value = edit.sundry_rate;

    const N = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Claim the first free row whose label matches; otherwise append one.
    const claim = (bodyId, matchCls, wantedName, buildRow) => {
      const tbody = qs('#' + bodyId, c);
      const free = [...tbody.rows].find((tr) => {
        const lab = qs('.' + matchCls, tr);
        return lab && N(lab.value) === N(wantedName) && !tr.dataset.taken;
      });
      if (free) { free.dataset.taken = '1'; return free; }
      const tr = document.createElement('tr');
      tr.innerHTML = buildRow();
      tr.dataset.taken = '1';
      tbody.appendChild(tr);
      return tr;
    };

    for (const o of existing.oils) {
      const tr = claim('oilBody', 'o_name', o.oil_name, () => `
        <td>${esc(o.oil_name || '')}<input type="hidden" class="o_name" value="${esc(o.oil_name || '')}"></td>
        <td><select class="o_type" style="width:100%">${oilTypeOpts}</select></td>
        <td><select class="o_cv" style="width:56px"><option value=""></option><option>C</option><option>V</option></select></td>
        <td><input type="number" class="o_lit" style="width:64px" step="0.1"></td>
        <td><input type="number" class="o_price" style="width:96px"></td>`);
      qs('.o_type', tr).value = o.oil_type || '';
      qs('.o_cv', tr).value = o.action_type || '';
      qs('.o_lit', tr).value = o.qty == null ? '' : o.qty;
      qs('.o_price', tr).value = o.price == null ? '' : o.price;
    }
    for (const f of existing.filters) {
      const tr = claim('filterBody', 'f_cat', f.category, () => `
        <td>${esc(f.category || '—')}<input type="hidden" class="f_cat" value="${esc(f.category || '')}"></td>
        <td style="position:relative"><input type="text" class="f_no" autocomplete="off" placeholder="type to search…" style="width:120px">
          <div class="f_menu" style="position:absolute;z-index:80;left:0;top:100%;min-width:300px;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:var(--shadow);max-height:230px;overflow:auto;display:none"></div></td>
        <td><input type="number" class="f_qty" value="1" style="width:48px"></td>
        <td><select class="f_xe" style="width:52px"><option value=""></option><option>X</option><option>E</option></select></td>
        <td><input type="number" class="f_price" style="width:96px"></td>`);
      qs('.f_no', tr).value = f.filter_no || '';
      qs('.f_qty', tr).value = f.qty == null ? 1 : f.qty;
      qs('.f_xe', tr).value = f.action_type || '';
      // The line's own price is what this service was charged; the book price is the
      // fallback for a line recorded before the number was priced.
      qs('.f_price', tr).value = f.price != null && f.price > 0 ? f.price : (f.book_price == null ? '' : f.book_price);
    }
    qsa('#oilBody tr, #filterBody tr', c).forEach((tr) => delete tr.dataset.taken);
  }

  wireAssetPicker(c);

  // Both lists show every oil and every filter category the workshop stocks, because any of
  // them might be part of this service. That is a lot to read past when you only need two or
  // three, so each list gets a find box and a "only filled" toggle to collapse it down to the
  // lines actually being recorded.
  const listFilter = (bodyId, findId, onlyId, countId, noun) => {
    const tbody = qs('#' + bodyId, c), find = qs('#' + findId, c);
    const only = qs('#' + onlyId, c), count = qs('#' + countId, c);
    const isFilled = (tr) => [...tr.querySelectorAll('input,select')]
      .some((el) => el.type !== 'hidden' && !el.classList.contains('f_qty') && String(el.value || '').trim() !== '');
    const apply = () => {
      const term = find.value.trim().toLowerCase();
      let shown = 0, filled = 0;
      for (const tr of tbody.rows) {
        const name = (tr.cells[0] ? tr.cells[0].textContent : '').toLowerCase();
        const full = isFilled(tr);
        if (full) filled++;
        const hit = (!term || name.includes(term)) && (!only.checked || full);
        tr.style.display = hit ? '' : 'none';
        if (hit) shown++;
      }
      count.textContent = `${shown} of ${tbody.rows.length} ${noun} shown`
        + (filled ? ` · ${filled} filled in` : '');
    };
    find.oninput = apply;
    only.onchange = apply;
    // Re-count as the user types into the rows, so "only filled" stays honest.
    tbody.addEventListener('input', () => { if (only.checked || count.textContent) apply(); });
    apply();
  };
  listFilter('oilBody', 'oilFind', 'oilOnlyUsed', 'oilCount', 'oils');
  listFilter('filterBody', 'filFind', 'filOnlyUsed', 'filCount', 'filters');

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
  // Filter rows: type a number → suggestions from the price book / catalogue / cross-refs.
  // Picking one fills the number AND its price; ↑/↓ + Enter work, and leaving the box still
  // falls back to the exact-match book price for a number typed in full.
  qsa('#filterBody tr', c).forEach((tr) => {
    const noIn = qs('.f_no', tr), price = qs('.f_price', tr), menu = qs('.f_menu', tr);
    let items = [], active = -1, deb;

    const close = () => { menu.style.display = 'none'; active = -1; };
    const choose = (i) => {
      const it = items[i]; if (!it) return;
      noIn.value = it.filter_no;
      if (it.unit_price != null) price.value = it.unit_price;
      close(); recalc(); price.focus();
    };
    const paint = () => {
      menu.innerHTML = items.map((it, i) => `<div class="f_opt" data-i="${i}" style="padding:6px 9px;cursor:pointer;border-bottom:1px solid var(--border);background:${i === active ? 'var(--surface-2)' : 'transparent'}">
          <b>${esc(it.filter_no)}</b>${it.unit_price != null ? ` <span style="float:right">${money(it.unit_price)}</span>` : ' <span class="badge amber" style="float:right">no price</span>'}
          <div class="muted" style="font-size:11px">${esc(it.category || '—')} · ${esc(it.src)}${it.uses ? ' · used ' + it.uses + '×' : ''}</div></div>`).join('');
      qsa('.f_opt', menu).forEach((el) => {
        el.onmousedown = (e) => { e.preventDefault(); choose(+el.dataset.i); };
        el.onmouseenter = () => { active = +el.dataset.i; paint(); };
      });
      menu.style.display = items.length ? 'block' : 'none';
    };
    // Search from the first character. With the box empty it lists this row's own filter
    // category (click into "Engine Oil Filter" and you see the engine oil filters we stock).
    const rowCat = (qs('.f_cat', tr) || {}).value || '';
    const search = async () => {
      const q = noIn.value.trim();
      try {
        items = await api('/filters/search?q=' + encodeURIComponent(q) + '&category=' + encodeURIComponent(rowCat) + '&limit=20');
      } catch (e) { items = []; }
      active = items.length ? 0 : -1;
      paint();
    };

    noIn.oninput = () => { clearTimeout(deb); deb = setTimeout(search, 140); };
    noIn.onfocus = () => { if (!noIn.value.trim()) search(); };
    noIn.onkeydown = (e) => {
      if (menu.style.display === 'none' || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') close();
    };
    noIn.onblur = async () => {
      setTimeout(close, 150);
      const v = noIn.value.trim(); if (!v || price.value) return;
      try { const r = await api('/filters/prices/lookup?no=' + encodeURIComponent(v)); if (r.found && r.unit_price != null) { price.value = r.unit_price; recalc(); } } catch (e) { /* ignore */ }
    };
    price.oninput = recalc; qs('.f_qty', tr).oninput = recalc;
  });
  const addPart = (v) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="text" class="p_desc" style="width:100%"></td><td><input type="text" class="p_unit" style="width:60px"></td><td><input type="number" class="p_rate" style="width:80px"></td><td><input type="number" class="p_qty" style="width:56px"></td><td><input type="number" class="p_amount" style="width:96px"></td>`;
    qs('#partBody', c).appendChild(tr);
    const rate = qs('.p_rate', tr), qty = qs('.p_qty', tr), amt = qs('.p_amount', tr);
    const calc = () => { if (rate.value && qty.value) amt.value = Math.round(Number(rate.value) * Number(qty.value) * 100) / 100; recalc(); };
    rate.oninput = calc; qty.oninput = calc; amt.oninput = recalc;
    if (v) {
      qs('.p_desc', tr).value = v.description || '';
      qs('.p_unit', tr).value = v.unit || '';
      rate.value = v.rate == null ? '' : v.rate;
      qty.value = v.qty == null ? '' : v.qty;
      amt.value = v.amount == null ? '' : v.amount;
    }
    return tr;
  };
  qs('#addpart', c).onclick = () => addPart();
  if (edit && existing.parts.length) existing.parts.forEach(addPart);
  addPart();   // always one blank line ready at the bottom
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
    const btn = qs('#saveService', c);
    btn.disabled = true;
    try {
      if (edit) {
        const r = await api('/filters/services/' + edit.id, { method: 'PUT', body: payload });
        // The shelf is settled by difference, so say plainly whether anything moved — an edit
        // that only fixed a date must not look like it consumed oil again.
        toast('Service updated' + (r.stock_moves ? ' · ' + r.stock_moves + ' oil correction(s) posted to Lubricants' : ''));
        location.hash = '#/filters/service/' + edit.id;
      } else {
        const r = await api('/filters/services', { method: 'POST', body: payload });
        toast('Service recorded' + (r.oil_issues ? ' · ' + r.oil_issues + ' oil issue(s) posted to Lubricants' : ''));
        location.hash = '#/filters/service/' + r.service.id;
      }
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
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
      ${editable ? `<a class="btn sm primary" href="#/filters/service/${s.id}/edit">✏️ Edit</a>` : ''}
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
    <div class="card"><div class="toolbar" style="margin:0 0 8px">
        <h3 style="margin:0">Service Sheet / Documents <span class="muted" style="font-weight:400">(${(d.attachments || []).length})</span></h3>
        <div class="spacer"></div>
        ${editable ? '<button class="sm primary" id="attachBtn">📎 Attach PDF</button><input type="file" id="attachFile" accept="application/pdf,.pdf" multiple style="display:none">' : ''}
      </div>
      <div id="attachList"></div></div>
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

  // ---- scanned service sheets
  // The PDF is posted as the raw body, so the file goes up at its real size rather than a
  // third bigger as base64. Uploading only redraws this card — re-rendering the whole page
  // would throw away any filter price the user is part-way through editing.
  const listBox = qs('#attachList', c);
  const drawAttachments = (rows) => {
    if (!rows.length) {
      listBox.innerHTML = `<p class="muted" style="margin:0">No document attached yet.${editable ? ' Attach the signed service sheet so it stays with this record.' : ''}</p>`;
      return;
    }
    listBox.innerHTML = tableWrap(
      [{ label: 'Document' }, { label: 'Size', num: true }, { label: 'Attached' }, { label: 'By' }, { label: '', width: '150px' }],
      rows.map((a) => `<tr>
        <td>📄 <a href="/api/filters/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a></td>
        <td class="num">${fileSize(a.size_bytes)}</td>
        <td class="muted">${esc(String(a.uploaded_at || '').slice(0, 16))}</td>
        <td class="muted">${esc(a.uploaded_by_name || '—')}</td>
        <td><a class="btn sm" href="/api/filters/attachments/${a.id}?download=1">⬇</a>
            ${editable ? `<button class="sm danger" data-del-att="${a.id}" data-name="${esc(a.filename)}">✕</button>` : ''}</td>
      </tr>`));
    qsa('[data-del-att]', listBox).forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Remove "${b.dataset.name}" from this service record?`)) return;
        try { await api('/filters/attachments/' + b.dataset.delAtt, { method: 'DELETE' }); toast('Document removed'); refreshAttachments(); }
        catch (e) { toast(e.message, 'err'); }
      };
    });
  };
  const refreshAttachments = async () => {
    try { drawAttachments(await api(`/filters/services/${id}/attachments`)); }
    catch (e) { listBox.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  drawAttachments(d.attachments || []);

  const fileInput = qs('#attachFile', c);
  if (fileInput) {
    qs('#attachBtn', c).onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const files = [...fileInput.files];
      fileInput.value = '';                       // so the same file can be picked again
      for (const f of files) {
        if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is ${fileSize(f.size)} — the limit is 15 MB`, 'err'); continue; }
        try {
          const res = await fetch(`/api/filters/services/${id}/attachments?filename=${encodeURIComponent(f.name)}`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/pdf' },
            body: f,
          });
          if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Upload failed (${res.status})`); }
          toast(`Attached ${f.name}`);
        } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
      }
      refreshAttachments();
    };
  }
}

const fileSize = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
};

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
const MRI_SHEETS = [['fuel', 'Fuel'], ['other', 'Other (overhead)'], ['salary', 'Salaries (Staff)'], ['daily_outside', 'Daily Work Outside'], ['service_outside', 'Service Outside']];
const MRI_COLS = {
  fuel: [['vehicle', 'Reg No', 'text'], ['label', 'Machine type', 'text'], ['qty', 'Qty (L)', 'num'], ['rate', 'Fuel rate', 'num'], ['amount2', 'Std rate', 'num']],
  other: [['label', 'Cost type', 'text'], ['project', 'Project / Plant', 'text'], ['amount1', 'Amount', 'num']],
  salary: [['label', 'Name', 'text'], ['qty', 'Qty', 'text'], ['project', 'Project / Plant', 'text'], ['amount1', 'Cost', 'num'], ['amount2', 'Other', 'num']],
  daily_outside: [['vehicle', 'Vehicle', 'ro'], ['labour', 'Our labour (Rs)', 'money'], ['amount1', 'Outside labour price (Rs)', 'num']],
  service_outside: [['job_no', 'Job Card No', 'ro'], ['vehicle', 'Vehicle', 'ro'], ['labour', 'Our labour (Rs)', 'money'], ['amount1', 'Outside labour price (Rs)', 'num']],
};
// The two "outside price" sheets are seeded from live lists (not free-form) and save differently.
const MRI_SEEDED = new Set(['daily_outside', 'service_outside']);
async function openMonthlyInputs(year, month, onSaved) {
  let data;
  try { data = await api(`/reports/monthly-inputs?year=${year}&month=${month}`); }
  catch (e) { return toast(e.message, 'err'); }
  const state = {};
  for (const [k] of MRI_SHEETS) state[k] = (data.inputs[k] || []).map((r) => ({ ...r }));
  // Seed the outside-price editors from the month's live daily-work vehicles and service jobs, with
  // any already-saved price merged in (the report reads these same values back).
  state.daily_outside = (data.daily_work || []).map((d) => ({ vehicle: d.vehicle, labour: d.labour, amount1: (d.outside ? d.outside : '') }));
  state.service_outside = (data.service_jobs || []).map((s) => ({ id: s.id, job_no: s.job_no, vehicle: s.vehicle, labour: s.labour, amount1: (s.outside ? s.outside : '') }));
  let active = 'fuel';
  const bg = modal(`Monthly inputs — ${MONTH_NAMES[month]} ${year}`, `
    <p class="muted" style="margin-top:0;font-size:12px">Fuel, Other &amp; Salaries are entered by hand. <b>Daily Work Outside</b> &amp; <b>Service Outside</b> let you type what each job would cost sent outside — those roll into the make-or-buy Profit/Loss. Repair, Service &amp; mechanic hours are pulled from live data.</p>
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
    const cellHtml = (r, cd) => {
      if (cd[2] === 'ro') return `<td style="padding:3px 6px;color:#555;white-space:nowrap">${esc(r[cd[0]] ?? '')}</td>`;
      if (cd[2] === 'money') return `<td style="padding:3px 6px;text-align:right;color:#555;white-space:nowrap">${money(r[cd[0]] || 0)}</td>`;
      return `<td style="padding:2px 4px"><input data-f="${cd[0]}" type="${cd[2] === 'num' ? 'number' : (cd[2] === 'date' ? 'date' : 'text')}" value="${esc(r[cd[0]] ?? '')}" style="width:${cd[2] === 'num' ? '120px' : (cd[2] === 'date' ? '132px' : '120px')}"></td>`;
    };
    const paintGrid = () => {
      const cols = MRI_COLS[active], rows = state[active], seeded = MRI_SEEDED.has(active);
      grid.innerHTML = `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%">
        <thead><tr>${cols.map((cd) => `<th style="text-align:${cd[2] === 'money' ? 'right' : 'left'};padding:4px 6px;border-bottom:2px solid var(--line,#ccc);white-space:nowrap">${esc(cd[1])}</th>`).join('')}<th></th></tr></thead>
        <tbody>${rows.length ? rows.map((r, i) => `<tr data-i="${i}">${cols.map((cd) => cellHtml(r, cd)).join('')}<td style="padding:2px 4px">${seeded ? '' : `<button class="sm mri-del" data-i="${i}" title="Remove row">✕</button>`}</td></tr>`).join('') : `<tr><td colspan="${cols.length + 1}" class="muted" style="padding:8px">${seeded ? 'No daily-work / service rows this month.' : 'No rows — click “Add row”.'}</td></tr>`}</tbody></table></div>`;
      qsa('tr[data-i] input', grid).forEach((inp) => { inp.oninput = () => { state[active][+inp.closest('tr').dataset.i][inp.dataset.f] = inp.value; }; });
      qsa('.mri-del', grid).forEach((b) => { b.onclick = () => { state[active].splice(+b.dataset.i, 1); paintGrid(); }; });
      qs('#mri-add', body).style.display = seeded ? 'none' : '';
      const total = seeded ? rows.reduce((a, r) => a + (Number(r.amount1) || 0), 0) : 0;
      qs('#mri-note', body).textContent = seeded ? `${rows.length} line(s) · outside total ${money(total)}` : `${rows.length} row(s) on “${active}”`;
    };
    qsa('#mri-tabs button', body).forEach((b) => { b.onclick = () => { active = b.dataset.k; paintTabs(); paintGrid(); }; });
    qs('#mri-add', body).onclick = () => { state[active].push({}); paintGrid(); };
    qs('#mri-save', body).onclick = async () => {
      try {
        for (const [k] of MRI_SHEETS) {
          if (k === 'service_outside') {
            await api('/reports/service-outside', { method: 'POST', body: { items: state[k].map((r) => ({ id: r.id, outside: r.amount1 })) } });
          } else if (k === 'daily_outside') {
            const lines = state[k].filter((r) => r.amount1 !== '' && r.amount1 != null).map((r) => ({ vehicle: r.vehicle, amount1: r.amount1 }));
            await api('/reports/monthly-inputs', { method: 'POST', body: { year, month, sheet: k, lines } });
          } else {
            await api('/reports/monthly-inputs', { method: 'POST', body: { year, month, sheet: k, lines: state[k] } });
          }
        }
        toast('Monthly inputs saved'); close(); if (onSaved) onSaved();
      } catch (e) { toast(e.message, 'err'); }
    };
    paintTabs(); paintGrid();
  }, { persistent: true });
  const box = qs('.modal', bg); if (box) { box.style.width = 'min(940px, 95vw)'; box.style.maxWidth = 'none'; }
}

// ---- Tyre & Battery Issues — imported ledger + category price book (feeds the Monthly Cost Report)
// ===== Tyre & Battery — request, approve, issue, and what came off ==========
//
// The register has recorded ISSUES since 2012 with nothing behind them saying who asked or who
// agreed, and the item was always typed by hand — 804 spellings of about 170 real tyre sizes.
// These screens put a request in front of the issue, and a PICKLIST in front of the item.
//
// The approval itself is deliberately NOT here. A tyre request is an ordinary MRN, so it is
// certified and approved in the same inbox as everything else — two inboxes is how things stop
// being read.

const TB_POS = ['FL', 'FR', 'RL1', 'RR1', 'RL2', 'RR2', 'SPARE', 'TRAILER'];
const TB_REASON_LABEL = {
  worn: 'Worn out', puncture: 'Puncture', sidewall: 'Sidewall damage', burst: 'Burst',
  accident: 'Accident', rotation: 'Rotation', planned: 'Planned replacement', other: 'Other',
  low_capacity: 'Low capacity', no_crank: 'Will not crank', leakage: 'Leaking', damage: 'Damaged',
  warranty: 'Warranty failure',
};
const TB_COND_LABEL = {
  repairable: 'Repairable', retreadable: 'Retreadable', reusable: 'Reusable spare',
  warranty: 'Warranty claim', scrap: 'Scrap', not_returned: 'Not returned',
};
const tbBadge = (s) => {
  const m = { requested: 'amber', certified: 'blue', approved: 'green', rejected: 'red' };
  return '<span class="badge ' + (m[s] || '') + '">' + esc(s || 'requested') + '</span>';
};

routes.tbrequests = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const kind = sp.get('kind') === 'battery' ? 'battery' : 'tyre';
  const tab = sp.get('tab') || 'requests';
  const go = (t, k) => `location.hash='#/tbrequests?tab=${t}&kind=${k || kind}'`;

  c.innerHTML = pageHeader('Tyre & Battery Requests',
    'Ask for one, have it approved, issue it against the request, and record what came off.') + `
    <div class="toolbar" style="margin-bottom:4px">
      <button class="sm ${kind === 'tyre' ? 'primary' : ''}" onclick="${go(tab, 'tyre')}">🛞 Tyre</button>
      <button class="sm ${kind === 'battery' ? 'primary' : ''}" onclick="${go(tab, 'battery')}">🔋 Battery</button>
      <div class="spacer"></div>
      ${canEdit('tb_request') ? '<button class="primary sm" id="tb-new">+ New request</button>' : ''}
    </div>
    <div class="toolbar" style="margin:0 0 10px 0">
      ${[['requests', 'Requests'], ['purchase', 'To purchase'], ['issue', 'Ready to issue'], ['returns', 'Old units due'], ['specs', 'Sizes &amp; prices']]
    .map(([t, l]) => `<button class="sm ${t === tab ? 'primary' : ''}" onclick="${go(t)}">${l}</button>`).join('')}
    </div>
    <div id="tb-body" class="muted">Loading…</div>`;

  // A role that may not raise one is not shown the button at all — a form that 403s on submit
  // is a worse answer than a screen that simply does not offer it.
  if (qs('#tb-new', c)) qs('#tb-new', c).onclick = () => tbRequestModal(kind, () => render());
  const body = qs('#tb-body', c);

  if (tab === 'requests') {
    const rows = await api('/tb/requests?kind=' + kind);
    body.innerHTML = rows.length ? tableWrap(
      [{ label: 'Request' }, { label: 'Date' }, { label: 'Vehicle' }, { label: 'Items', num: true },
        { label: 'Qty', num: true }, { label: 'Approval' }, { label: 'Issued', num: true }, { label: 'Requested by' }],
      rows.map((r) => `<tr>
        <td><a href="#/tbrequests?tab=one&id=${r.id}&kind=${kind}"><b>${esc(r.mrn_no)}</b></a></td>
        <td>${esc(String(r.req_date || '').slice(0, 10))}</td>
        <td>${esc(r.asset_code || '—')}${r.registration ? ' <span class="muted">' + esc(r.registration) + '</span>' : ''}</td>
        <td class="num">${r.lines}</td><td class="num">${num(r.qty)}</td>
        <td>${tbBadge(r.approval_status)}${r.purchase_requested_at ? ' <span class="badge blue">sent to buy</span>' : ''}</td>
        <td class="num">${r.issued_lines}/${r.lines}</td>
        <td>${esc(r.requested_by || '—')}</td></tr>`), { scroll: true })
      : `<div class="card"><p class="muted">No ${kind} requests yet — the button above raises one.</p></div>`;
    return;
  }

  if (tab === 'one') {
    const d = await api('/tb/requests/' + sp.get('id'));
    body.innerHTML = `<div class="card section">
        <div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Request ${esc(d.mrn_no)}</h3>
          ${tbBadge(d.approval_status)}<div class="spacer"></div>
          <span class="muted">${esc(d.asset_code || '')} ${esc(d.registration || '')}${d.job_no ? ' · job ' + esc(d.job_no) : ''}</span></div>
        <div class="note">Certifying and approving happen in the ordinary request inbox —
          <a href="#/stores?tab=mrn&id=${d.id}">open ${esc(d.mrn_no)} there</a>.</div>
        ${tableWrap([{ label: 'Item' }, { label: 'Qty', num: true }, { label: 'Position' }, { label: 'Reason' },
    { label: 'Meter' }, { label: 'Issued', num: true }, { label: '' }],
    d.lines.map((l) => `<tr>
            <td>${esc(l.spec_label || l.description)}</td>
            <td class="num">${num(l.qty)}</td>
            <td>${esc(l.position || '—')}</td>
            <td>${esc(TB_REASON_LABEL[l.reason] || l.reason || '—')}</td>
            <td>${l.km_reading != null ? num(l.km_reading) : esc(l.km_remark || '—')}</td>
            <td class="num">${l.issued || 0}</td>
            <td>${d.approval_status === 'approved' && (l.issued || 0) < l.qty && canEdit('tb_issue')
    ? '<button class="sm primary" data-issue="' + l.mrn_line_id + '">Issue…</button>' : ''}</td></tr>`))}
      </div>`;
    qsa('[data-issue]', body).forEach((b) => {
      b.onclick = () => tbIssueModal(d, d.lines.find((l) => String(l.mrn_line_id) === b.dataset.issue), () => render());
    });
    return;
  }

  if (tab === 'purchase') {
    // THE WORKSHOP STORE DOES NOT BUY TYRES. Approved is not the end of the story here — the
    // request goes to Head Office to be bought, and without this queue an approved request simply
    // sat there with nobody able to say whether anyone had been asked for it.
    const rows = await api('/tb/requests?kind=' + kind + '&awaiting_purchase=1');
    body.innerHTML = `<div class="note">Approved, and waiting to be sent to Head Office to be bought.
      An ordinary workshop request does not come through here — only tyres and batteries.</div>`
      + (rows.length ? tableWrap(
        [{ label: 'Request' }, { label: 'Approved' }, { label: 'Vehicle' }, { label: 'Items', num: true },
          { label: 'Qty', num: true }, { label: '' }],
        rows.map((r) => `<tr><td><b>${esc(r.mrn_no)}</b></td><td>${esc(String(r.req_date || '').slice(0, 10))}</td>
          <td>${esc(r.asset_code || '—')}</td><td class="num">${r.lines}</td><td class="num">${num(r.qty)}</td>
          <td>${canEdit('tb_purchase') ? '<button class="sm primary" data-buy="' + r.id + '">Send to purchase…</button>' : ''}</td></tr>`), { scroll: true })
        : '<div class="card"><p class="muted">Nothing approved is waiting to be bought.</p></div>');
    qsa('[data-buy]', body).forEach((b) => {
      b.onclick = () => tbPurchaseModal(rows.find((r) => String(r.id) === b.dataset.buy), () => render());
    });
    return;
  }

  if (tab === 'issue') {
    const rows = (await api('/tb/requests?kind=' + kind + '&status=approved')).filter((r) => r.issued_lines < r.lines);
    body.innerHTML = rows.length ? tableWrap(
      [{ label: 'Request' }, { label: 'Date' }, { label: 'Vehicle' }, { label: 'Items', num: true }, { label: 'Issued', num: true }, { label: '' }],
      rows.map((r) => `<tr><td><b>${esc(r.mrn_no)}</b></td><td>${esc(String(r.req_date || '').slice(0, 10))}</td>
        <td>${esc(r.asset_code || '—')}</td><td class="num">${r.lines}</td><td class="num">${r.issued_lines}/${r.lines}</td>
        <td><a class="btn sm primary" href="#/tbrequests?tab=one&id=${r.id}&kind=${kind}">Open</a></td></tr>`), { scroll: true })
      : '<div class="card"><p class="muted">Nothing approved is waiting to go out.</p></div>';
    return;
  }

  if (tab === 'returns') {
    const rows = await api('/tb/returns/outstanding?kind=' + kind);
    body.innerHTML = `<div class="note">A replacement is not finished until the old one is accounted for —
      an old battery is worth money, and an old tyre may still be repairable or retreadable.</div>`
      + (rows.length ? tableWrap(
        [{ label: 'Issued' }, { label: 'Request' }, { label: 'Vehicle' }, { label: 'Item' },
          { label: 'Qty', num: true }, { label: 'Position' }, { label: '' }],
        rows.map((r) => `<tr><td>${esc(String(r.issue_date || '').slice(0, 10))}</td><td>${esc(r.mrn_no || '—')}</td>
        <td>${esc(r.asset_code || '—')}</td><td>${esc(r.spec_label || '—')}</td><td class="num">${num(r.qty)}</td>
        <td>${esc(r.position || '—')}</td>
        <td>${canEdit('tb_issue') ? '<button class="sm primary" data-ret="' + r.issue_id + '">Record…</button>' : ''}</td></tr>`), { scroll: true })
        : '<div class="card"><p class="muted">Every old unit has been accounted for.</p></div>');
    qsa('[data-ret]', body).forEach((b) => {
      b.onclick = () => tbReturnModal(rows.find((r) => String(r.issue_id) === b.dataset.ret), () => render());
    });
    return;
  }

  const specs = await api('/tb/specs?kind=' + kind);
  body.innerHTML = `<div class="note">A request can only name a size on this list. That is what stops the next ten
    years reading like the last ten, when 804 spellings covered about 170 real sizes and a third of
    tyre issues never reached a price.</div>` + tableWrap(
    [{ label: kind === 'tyre' ? 'Size & type' : 'Rating' }, { label: 'Used', num: true }, { label: 'Unit price (Rs)', num: true }],
    specs.map((s) => `<tr><td>${esc(s.label)}</td><td class="num">${s.used || 0}</td>
      <td class="num">${s.unit_price == null ? '<span class="badge amber">needs a price</span>' : money(s.unit_price)}</td></tr>`),
    { scroll: true });
};

// ---- raising one ----------------------------------------------------------
//
// SEVERAL ITEMS TO A REQUEST. A tyre rarely goes on alone — it wants its tube and often a flap —
// and the register has been writing "750 X 16 TYER /TUBE/COLLER" into the tyre's own description
// for want of anywhere else to put them. Each row picks its own item, so a tube is a tube and
// "how many tubes did we fit this year" becomes a question with an answer.
const TB_LINE_KINDS = { tyre: [['tyre', '🛞 Tyre'], ['tube', '⭕ Tube'], ['flap', '➰ Flap']], battery: [['battery', '🔋 Battery']] };

async function tbRequestModal(kind, done) {
  // Every list the rows can choose from, fetched once rather than per row.
  const catalogue = {};
  for (const [k] of TB_LINE_KINDS[kind]) catalogue[k] = await api('/tb/specs?kind=' + k);
  const reasons = (await api('/tb/reasons'))[kind] || [];
  modal(kind === 'tyre' ? '🛞 New tyre request' : '🔋 New battery request', `
    <div class="istep"><span class="istep-n">1</span> Which machine, and why</div>
    <!-- The ASSET picker, not the job/general one: a tyre is always for a particular machine, and
         the general picker's default option is one this form has to refuse. -->
    <div class="fld">${assetPickerHtml('For which vehicle / machine *')}</div>
    <div class="row">${field('Site', 'site')}${field('Priority', 'priority', { type: 'select',
    options: [['normal', 'Normal'], ['urgent', 'Urgent'], ['breakdown', 'Breakdown']].map(([v, l]) => ({ value: v, label: l })) })}</div>
    <div class="row">${field('Reason', 'reason', { type: 'select', options: reasons.map((r) => ({ value: r, label: TB_REASON_LABEL[r] || r })) })}
      ${field('Meter reading (km / hr)', 'km_reading', { type: 'number' })}</div>
    <div class="istep"><span class="istep-n">2</span> What is needed</div>
    <div id="tb-lines"></div>
    <div class="toolbar" style="margin:6px 0 0">
      ${TB_LINE_KINDS[kind].map(([k, l]) => `<button type="button" class="sm" data-add="${k}">+ ${l}</button>`).join('')}
    </div>
    ${field('Note', 'notes')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Raise request</button></div>`,
  (body, close) => {
    wireAssetPicker(body);
    const rows = [];
    const host = qs('#tb-lines', body);
    const draw = () => {
      host.innerHTML = rows.length ? `<table class="ni-tab"><thead><tr>
          <th>Item</th><th>Size / rating</th><th class="r">Qty</th>
          ${kind === 'tyre' ? '<th>Position</th>' : '<th>Old serial</th>'}<th></th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr>
          <td>${esc((TB_LINE_KINDS[kind].find(([k]) => k === r.kind) || [, r.kind])[1])}</td>
          <td><select data-spec="${i}">${(catalogue[r.kind] || []).map((s) =>
    `<option value="${s.id}"${String(s.id) === String(r.spec_id) ? ' selected' : ''}>${esc(s.label)}${s.unit_price == null ? ' — no price yet' : ''}</option>`).join('')}</select></td>
          <td class="r"><input type="number" min="0.01" step="1" value="${r.qty}" data-qty="${i}" style="width:70px;text-align:right"></td>
          <td>${kind === 'tyre'
    ? `<select data-pos="${i}"><option value="">—</option>${TB_POS.map((p) => `<option${p === r.position ? ' selected' : ''}>${p}</option>`).join('')}</select>`
    : `<input data-old="${i}" value="${esc(r.old_serial || '')}" placeholder="if known">`}</td>
          <td class="r"><button type="button" class="sm" data-del="${i}">✕</button></td></tr>`).join('')}
        </tbody></table>`
        : '<p class="muted" style="margin:4px 0">Nothing on the request yet — add the tyre, and its tube if it takes one.</p>';
      qsa('[data-spec]', host).forEach((el) => { el.onchange = () => { rows[+el.dataset.spec].spec_id = el.value; }; });
      qsa('[data-qty]', host).forEach((el) => { el.oninput = () => { rows[+el.dataset.qty].qty = el.value; }; });
      qsa('[data-pos]', host).forEach((el) => { el.onchange = () => { rows[+el.dataset.pos].position = el.value; }; });
      qsa('[data-old]', host).forEach((el) => { el.oninput = () => { rows[+el.dataset.old].old_serial = el.value; }; });
      qsa('[data-del]', host).forEach((el) => { el.onclick = () => { rows.splice(+el.dataset.del, 1); draw(); }; });
    };
    qsa('[data-add]', body).forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.add;
        const first = (catalogue[k] || [])[0];
        rows.push({ kind: k, spec_id: first ? first.id : '', qty: k === 'tyre' ? 2 : 1, position: '', old_serial: '' });
        draw();
      };
    });
    // Open with the obvious first row already there, so the common case is one click.
    qs('[data-add]', body).click();

    qs('#s', body).onclick = async () => {
      const f = formData(body);
      // Typing a code without picking it from the list leaves asset_id empty on purpose — the
      // request has to name a machine the register actually knows.
      if (!f.asset_id) return toast('Pick the vehicle or machine from the list', 'err');
      if (!rows.length) return toast('Add at least one item to the request', 'err');
      if (rows.some((r) => !r.spec_id)) return toast('Every line needs a size or rating', 'err');
      try {
        const r = await api('/tb/requests', { method: 'POST', body: {
          kind, asset_id: f.asset_id, site: f.site, purpose: f.notes, reason: f.reason,
          lines: rows.map((ln) => ({ spec_id: ln.spec_id, qty: ln.qty, reason: f.reason, position: ln.position,
            km_reading: f.km_reading, old_serial: ln.old_serial, priority: f.priority, notes: f.notes })),
        } });
        toast('Request ' + r.mrn_no + ' raised — it now needs certifying and approving');
        close(); done && done();
      } catch (e) { toast(e.message, 'err'); }
    };
  }, { wide: true });
}

// ---- sending it to be bought ----------------------------------------------
function tbPurchaseModal(row, done) {
  modal('Send ' + row.mrn_no + ' to be purchased', `
    <div class="note">Approved for ${esc(row.asset_code || 'the machine')} · ${row.lines} item(s), ${num(row.qty)} in total.</div>
    ${field('Bought by', 'purchase_source', { type: 'select', options: [
    { value: 'head_office', label: 'Head Office' }, { value: 'local_purchase', label: 'Local purchase' }] })}
    <div class="row">${field('Their reference (if they gave one)', 'purchase_ref')}
      ${field('Date', 'date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}</div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Send to purchase</button></div>`,
  (body, close) => {
    qs('#s', body).onclick = async () => {
      try {
        await api('/tb/requests/' + row.id + '/purchase', { method: 'POST', body: formData(body) });
        toast(row.mrn_no + ' sent to be bought');
        close(); done && done();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- issuing against it ---------------------------------------------------
function tbIssueModal(request, line, done) {
  modal('Issue against ' + request.mrn_no, `
    <div class="note">${esc(line.spec_label || line.description)} · approved ${num(line.qty)}${line.position ? ' · ' + esc(line.position) : ''}</div>
    <div class="row">${field('How many are going out', 'qty', { type: 'number', value: Math.max(0, (line.qty || 0) - (line.issued || 0)) })}
      ${field('Date', 'issue_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}</div>
    <div class="row">${field('Serial number (if it has one)', 'serial_no')}${field('Unit price (blank = the list price)', 'unit_price', { type: 'number' })}</div>
    ${field('Issued by', 'issued_by')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Issue</button></div>`,
  (body, close) => {
    qs('#s', body).onclick = async () => {
      try {
        const r = await api('/tb/issue', { method: 'POST', body: { mrn_line_id: line.mrn_line_id, ...formData(body) } });
        toast(r.message || 'Issued');
        close(); done && done();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- what came off --------------------------------------------------------
function tbReturnModal(row, done) {
  // A tyre can be repaired or retreaded; a battery cannot. Offering the whole list for both would
  // invite an answer that means nothing.
  const conds = row.kind === 'tyre'
    ? ['repairable', 'retreadable', 'reusable', 'warranty', 'scrap', 'not_returned']
    : ['reusable', 'warranty', 'scrap', 'not_returned'];
  modal('What came off ' + (row.asset_code || 'the machine'), `
    <div class="note">${esc(row.spec_label || '')} issued ${esc(String(row.issue_date || '').slice(0, 10))}${row.mrn_no ? ' on ' + esc(row.mrn_no) : ''}</div>
    <div class="row">${field('Condition', 'condition', { type: 'select', options: conds.map((v) => ({ value: v, label: TB_COND_LABEL[v] })) })}
      ${field('Old serial (if known)', 'serial_no')}</div>
    <div class="row">${field('Meter reading', 'km_reading', { type: 'number' })}${field('Taken in by', 'received_by')}</div>
    ${field('If it is not coming back, why', 'exception_reason')}
    ${field('Note', 'notes')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Record</button></div>`,
  (body, close) => {
    qs('#s', body).onclick = async () => {
      try {
        await api('/tb/returns', { method: 'POST', body: { issue_id: row.issue_id, ...formData(body) } });
        toast('Recorded'); close(); done && done();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

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
  c.innerHTML = `${pageHeader('Reports', 'Edward and Christie (Pvt) Ltd — Badalgama Central Workshop')}
    <div class="card section">
      <div class="toolbar" style="margin-top:0">
        <h3 style="margin:0">Daily Reports</h3>
        <span class="muted" style="font-weight:400">— Pending Parts and the Maintenance Summery, saved every day</span>
        <div class="spacer"></div>
        <div class="fld"><label>Day</label><input type="date" id="dr-date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="pill-row" style="margin-bottom:10px">
        <button class="sm primary" id="dr-t-pending">📦 Pending Parts</button>
        <button class="sm" id="dr-t-price">💰 Pending Price</button>
        <button class="sm" id="dr-t-jobs">🔧 Job Record Summary</button>
        <div class="spacer"></div>
        <span class="muted" id="dr-stamp" style="font-size:12px"></span>
        <button class="sm" id="dr-save">💾 Save this day</button>
        <a class="btn primary sm" id="dr-dl" href="#">⬇ Excel</a>
      </div>
      <div id="dr-body"><div class="muted">Loading…</div></div>
      <details style="margin-top:10px"><summary class="muted" style="font-size:12px;cursor:pointer">Saved days</summary>
        <div id="dr-hist" style="margin-top:8px"></div></details>
    </div>
    <div class="card section">
      <div class="toolbar" style="margin-top:0">
        <h3 style="margin:0">Job Cost Report</h3>
        <span class="muted" style="font-weight:400">— full 14-sheet master workbook (PROFIT OR LOSS · Repair · Service · Tyre · Battery · Oils · General · Fuel · Salaries · Overhead · Total Cost · Material Summary · Cost Comparison · Job-wise Comparison)</span>
        <div class="spacer"></div>
        <div><label>Year</label><select id="mcr-year"></select></div>
        <div><label>Month</label><select id="mcr-month"></select></div>
        <button class="sm" id="mcr-edit">✎ Edit monthly inputs</button>
        <a class="btn sm" id="mcr-rd" href="#" target="_blank">🖨 Repair Detail</a>
        <a class="btn primary sm" id="mcr-dl" href="#">⬇ Download Excel</a>
      </div>
      <div id="mcr-preview" class="muted">Loading…</div></div>`;

  // ---- Daily Reports: the two sheets the office used to type by hand.
  // Today reads live so it is always current; an earlier day reads its frozen copy, so a sheet
  // printed last week still says what it said then.
  let drKind = 'pending_parts';
  const drDate = qs('#dr-date', c), drBody = qs('#dr-body', c), drStamp = qs('#dr-stamp', c);
  const drCanEdit = can('workshop', 'operational_manager', 'manager', 'storekeeper');

  const drNote = (id, field, value, ph) => drCanEdit
    ? `<textarea class="dr-note" data-id="${id}" data-f="${field}" rows="2" placeholder="${esc(ph || '')}"
         style="width:100%;font-size:12px;resize:vertical">${esc(value || '')}</textarea>`
    : esc(value || '');

  const drRender = (d) => {
    drStamp.textContent = d.saved
      ? `frozen copy of that day · saved ${String(d.generated_at || '').slice(0, 16)}`
      : (d.last_saved_at ? `live · last saved ${String(d.last_saved_at).slice(0, 16)}` : 'live · not saved yet');
    if (drKind === 'pending_price') {
      if (!d.sections.length) { drBody.innerHTML = '<p class="muted">Everything received has a price. 🎉</p>'; return; }
      drBody.innerHTML = d.sections.map((s) => `
        <div class="mrnsec"><div class="mrnsec-h">${esc(s.label)} — ${s.requests} request(s), ${s.rows.length} receipt(s) awaiting a price</div>
        ${tableWrap([{ label: 'NO', width: '48px' }, { label: 'Received', width: '92px' }, { label: 'GRN No', width: '80px' },
          { label: 'MR No', width: '80px' }, { label: 'Vehicle no', width: '104px' }, { label: 'Description', cls: 'desc-col' },
          { label: 'Unit', width: '54px' }, { label: 'Qty', num: true, width: '56px' }, { label: 'Supplier', width: '130px' },
          { label: 'Invoice No', width: '96px' }, { label: 'Site', width: '104px' }, { label: 'Remarks', width: '180px' }],
          s.rows.map((r) => `<tr>
            <td>${esc(r.no)}</td><td>${esc(r.recv_date)}</td><td>${esc(r.grn_no)}</td><td>${esc(r.mrn_no)}</td>
            <td>${esc(r.vehicle)}</td><td class="desc-col">${esc(r.description)}</td><td>${esc(r.unit)}</td>
            <td class="num">${num(r.qty)}</td><td>${esc(r.supplier)}</td><td>${esc(r.invoice_no)}</td><td>${esc(r.site)}</td>
            <td>${d.saved ? esc(r.remarks) : drNote(r.grn_id, 'remarks', r.remarks, 'invoice chased…')}</td></tr>`),
          { scroll: true })}</div>`).join('');
    } else if (drKind === 'pending_parts') {
      if (!d.sections.length) { drBody.innerHTML = '<p class="muted">Nothing outstanding.</p>'; return; }
      drBody.innerHTML = d.sections.map((s) => `
        <div class="mrnsec"><div class="mrnsec-h">${esc(s.label)} — ${s.requests} request(s), ${s.rows.length} item(s)</div>
        ${tableWrap([{ label: 'NO', width: '48px' }, { label: 'Date', width: '92px' }, { label: 'MR No', width: '80px' },
          { label: 'Vehicle no', width: '104px' }, { label: 'Description', cls: 'desc-col' }, { label: 'Unit', width: '54px' },
          { label: 'Qty', num: true, width: '56px' }, { label: 'Site', width: '110px' }, { label: 'Remarks', width: '190px' }],
          s.rows.map((r) => `<tr>
            <td>${esc(r.no)}</td><td>${esc(r.date)}</td><td>${esc(r.mrn_no)}</td><td>${esc(r.vehicle)}</td>
            <td class="desc-col">${esc(r.description)}</td><td>${esc(r.unit)}</td><td class="num">${num(r.qty)}</td>
            <td>${esc(r.site)}</td>
            <td>${d.saved ? esc(r.remarks) : drNote(r.line_id, 'remarks', r.remarks, 'remark…')}
              ${r.note ? `<div class="muted" style="font-size:11px;margin-top:2px">${esc(r.note)}</div>` : ''}</td></tr>`),
          { scroll: true })}</div>`).join('');
    } else {
      if (!d.rows.length) { drBody.innerHTML = '<p class="muted">No jobs attended in the last 30 days.</p>'; return; }
      drBody.innerHTML = tableWrap(
        [{ label: 'No', width: '44px' }, { label: 'Machine No', width: '104px' }, { label: 'Type', width: '140px' },
          { label: 'Site', width: '110px' }, { label: 'Start date', width: '92px' },
          { label: 'Job Card Description', cls: 'desc-col', width: '190px' },
          { label: 'Completed Repairs', width: '200px' }, { label: 'Pending Repairs', width: '190px' },
          { label: 'Overall Job status', width: '130px' }, { label: 'Spare parts', width: '170px' }],
        d.rows.map((r) => `<tr>
          <td>${r.no}</td>
          <td><a href="#/jobs/${r.job_id}">${esc(r.machine)}</a></td>
          <td>${esc(r.type)}</td><td>${esc(r.site)}</td><td>${esc(r.start_date)}</td>
          <td class="desc-col">${esc(r.job_description)}</td>
          <td>${d.saved ? esc(r.completed_repairs) : drNote(r.job_id, 'completed_repairs', r.completed_repairs, 'filled from the daily work — edit to override')}</td>
          <td>${d.saved ? esc(r.pending_repairs) : drNote(r.job_id, 'pending_repairs', r.pending_repairs, 'what is still to do…')}</td>
          <td>${d.saved ? esc(r.job_status) : drNote(r.job_id, 'job_status', r.job_status, 'Ongoing / No Technicians…')}</td>
          <td>${d.saved ? esc(r.spare_parts) : drNote(r.job_id, 'spare_parts', r.spare_parts, 'parts requested but not received')}</td></tr>`),
        { scroll: true });
    }
    // Notes save as you leave the box and carry into every later day.
    qsa('.dr-note', drBody).forEach((el) => {
      el.onchange = async () => {
        const path = drKind === 'pending_parts' ? `/reports/daily/pending-parts/notes/${el.dataset.id}`
          : drKind === 'pending_price' ? `/reports/daily/pending-price/notes/${el.dataset.id}`
            : `/reports/daily/job-summary/notes/${el.dataset.id}`;
        const body = {};
        if (drKind === 'pending_parts' || drKind === 'pending_price') body.remarks = el.value;
        else {
          const row = el.closest('tr');
          qsa('.dr-note', row).forEach((x) => { body[x.dataset.f] = x.value; });
        }
        try { await api(path, { method: 'PUT', body }); el.style.background = '#eefaf0'; }
        catch (e) { toast(e.message, 'err'); el.style.background = '#fdf3f2'; }
      };
    });
  };

  const drLoad = async () => {
    const date = drDate.value;
    qs('#dr-dl', c).href = `/api/reports/daily/${drKind}/export.xlsx?date=${date}`;
    qs('#dr-t-pending', c).classList.toggle('primary', drKind === 'pending_parts');
    qs('#dr-t-price', c).classList.toggle('primary', drKind === 'pending_price');
    qs('#dr-t-jobs', c).classList.toggle('primary', drKind === 'job_summary');
    drBody.innerHTML = '<div class="muted">Loading…</div>';
    try { drRender(await api(`/reports/daily/${drKind}?date=${date}`)); }
    catch (e) { drBody.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    try {
      const h = await api(`/reports/daily/${drKind}/history?limit=30`);
      qs('#dr-hist', c).innerHTML = h.length ? tableWrap(
        [{ label: 'Day' }, { label: 'Rows', num: true }, { label: 'Saved at' }, { label: 'By' }, { label: '' }],
        h.map((x) => `<tr><td>${esc(x.report_date)}</td><td class="num">${x.row_count}</td>
          <td class="muted">${esc(String(x.generated_at).slice(0, 16))}</td><td class="muted">${esc(x.generated_by_name || 'auto')}</td>
          <td><a class="btn sm" href="/api/reports/daily/${drKind}/export.xlsx?date=${x.report_date}">⬇</a></td></tr>`))
        : '<p class="muted" style="margin:0">No saved days yet.</p>';
    } catch (e) { /* history is a nicety */ }
  };
  qs('#dr-t-pending', c).onclick = () => { drKind = 'pending_parts'; drLoad(); };
  qs('#dr-t-price', c).onclick = () => { drKind = 'pending_price'; drLoad(); };
  qs('#dr-t-jobs', c).onclick = () => { drKind = 'job_summary'; drLoad(); };
  drDate.onchange = drLoad;
  qs('#dr-save', c).onclick = async () => {
    try { const r = await api(`/reports/daily/${drKind}/save`, { method: 'POST', body: { date: drDate.value } });
      toast(`Saved ${r.report_date} — ${r.row_count} row(s)`); drLoad(); }
    catch (e) { toast(e.message, 'err'); }
  };
  drLoad();

  // Monthly Cost Report — full 14-sheet workbook download + manual-inputs editor + live totals preview.
  const mcrYear = qs('#mcr-year', c), mcrMonth = qs('#mcr-month', c);
  const now = new Date();
  for (let i = 0; i < 6; i++) { const o = document.createElement('option'); o.value = now.getFullYear() - i; o.textContent = now.getFullYear() - i; mcrYear.appendChild(o); }
  for (let m = 1; m <= 12; m++) { const o = document.createElement('option'); o.value = m; o.textContent = MONTH_NAMES[m]; if (m === now.getMonth() + 1) o.selected = true; mcrMonth.appendChild(o); }
  const mcrDl = qs('#mcr-dl', c), mcrPrev = qs('#mcr-preview', c);
  const loadMcr = async () => {
    const y = mcrYear.value, mo = mcrMonth.value;
    mcrDl.href = `/api/reports/monthly-cost.xlsx?year=${y}&month=${mo}`;
    qs('#mcr-rd', c).href = `/api/reports/monthly-repair-detail.html?year=${y}&month=${mo}`;
    mcrPrev.innerHTML = '<span class="muted">Loading…</span>';
    let p;
    try { p = (await api(`/reports/monthly-inputs?year=${y}&month=${mo}`)).preview; }
    catch (e) { mcrPrev.innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }

    const pl = p.profit_loss;
    const plBanner = pl ? `<div style="background:${pl.is_profit ? '#e6f4ea' : '#fce8e6'};border:1px solid ${pl.is_profit ? '#a8dab5' : '#f5c6cb'};padding:12px;border-radius:6px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-weight:700;font-size:15px;color:${pl.is_profit ? '#137333' : '#c5221f'}">${pl.is_profit ? 'PROFIT' : 'LOSS'}: Rs ${money(pl.saving_amount)}</div>
        <div style="font-size:12px;color:#3c4043">In-house absorbed cost: <b>Rs ${money(pl.in_house_cost)}</b> vs Outside estimate: <b>Rs ${money(pl.outside_cost)}</b> (${(pl.saving_pct * 100).toFixed(1)}% ${pl.is_profit ? 'cheaper than outside' : 'more expensive than outside'})</div>
      </div>
      <a class="btn primary sm" href="/api/reports/monthly-cost.xlsx?year=${y}&month=${mo}">⬇ Download 14-Sheet Bill</a>
    </div>` : '';

    const line = (label, count, total, warn) => `<tr><td>${esc(label)}</td><td class="num">${count}</td><td class="num">${money(total)}</td><td>${warn ? '<span class="badge amber">enter inputs</span>' : ''}</td></tr>`;
    const rows = [
      line('1. PROFIT OR LOSS', 'Headline', pl ? (pl.is_profit ? pl.saving_amount : -pl.saving_amount) : 0),
      line('2. Repair cost (Closed + Pending + Other Labour + Spares)', (p.repair.closed_count + p.repair.pending_count) + ' jobs', p.repair.closed_total + p.repair.pending_total + p.repair.other_labour_total + p.repair.spares_supply_total),
      line('3. Service cost', p.service.count, p.service.total),
      line('4. Battery cost', p.battery.count, p.battery.total),
      line('5. Tyre work cost', p.tyre.count, p.tyre.total),
      line('6. Oils & Lubrication', p.oils.count, p.oils.total),
      line('7. General Items', p.general.count, p.general.total),
      line('8. Fuel & Rental Cost', p.fuel.count, p.fuel.total, p.fuel.count === 0),
      line('9. Salaries Cost (Staff & Mechanics)', p.salary.count + ' staff', p.salary.staff_total + p.salary.mechanic_total, p.salary.count === 0),
      line('10. Other Cost (Overheads)', p.other.count, p.other.total, p.other.count === 0),
      line('11. Total cost (Consolidated)', 'Summary', p.total_cost ? p.total_cost.grand_total : p.grand_total),
      line('12. Material Summary (Consolidated materials)', 'Summary', p.material_summary ? p.material_summary.total_material : 0),
      line('13. Cost Comparison (Make-or-buy pricing)', 'Summary', p.cost_comparison ? p.cost_comparison.saving : 0),
      line('14. Job-wise Comparison (Job savings)', p.job_wise_comparison ? p.job_wise_comparison.total_jobs + ' jobs' : 'Summary', p.job_wise_comparison ? p.job_wise_comparison.saving : 0),
      `<tr><td><b>Grand Total Workshop Cost</b></td><td></td><td class="num"><b>${money(p.grand_total)}</b></td><td></td></tr>`
    ];

    mcrPrev.innerHTML = plBanner + tableWrap(
      [{ label: 'Sheet' }, { label: 'Rows / Scope', num: true }, { label: 'Total Amount / Saving (Rs)', num: true }, { label: '' }],
      rows) +
      `<p class="muted" style="font-size:12px;margin:6px 0 0">Repair, Service &amp; mechanic labour hours are pulled live from transactions. Tyre &amp; Battery come from the <a href="#/tyrebattery">Tyre &amp; Battery</a> ledger. Fuel, Overhead &amp; Staff salaries come from <b>Edit monthly inputs</b>.</p>`;
  };
  mcrYear.onchange = loadMcr; mcrMonth.onchange = loadMcr;
  qs('#mcr-edit', c).onclick = () => openMonthlyInputs(+mcrYear.value, +mcrMonth.value, loadMcr);
  loadMcr();
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
  c.innerHTML = `${pageHeader('Daily Report', 'One day at a glance — work done, jobs opened & closed, what’s still to do, items requested & received.')}
    <div class="toolbar">
      <label style="display:flex;gap:6px;align-items:center;flex-direction:row;width:auto">Date <input type="date" id="pgdate" value="${esc(date0)}" style="width:auto"></label>
      <button class="sm" id="pgprev">← Previous day</button>
      <button class="sm" id="pgnext">Next day →</button>
      <div class="spacer"></div>
      <a class="btn sm" id="pgongx" href="/api/reports/ongoing-jobs.xlsx" title="Excel: every open job from the last 8 months, ranked by delay, plus the parts they are waiting for">⬇ Ongoing Jobs (Excel)</a>
      <a class="btn sm" id="pgong" href="/api/reports/ongoing-jobs.html" target="_blank" title="PDF: every open job from the last 8 months, ranked by delay, plus the parts they are waiting for">⚠ Ongoing Jobs / Delays (PDF)</a>
      <a class="btn sm" id="pgjobs" href="#" target="_blank" title="Jobs attended from this date onward — spares requested (Head Office / Local Purchase), spares received, work done, last attended date">📋 Jobs Attended (from this date)</a>
      <a class="btn primary sm" id="pgprint" href="/api/reports/daily-progress/print.html?date=${encodeURIComponent(date0)}" target="_blank">🖨 PDF / Print</a>
    </div>
    <div id="pgbody"><div class="muted">Loading…</div></div>`;
  const load = async () => {
    const dt = qs('#pgdate').value || today;
    history.replaceState(null, '', '#/progress?date=' + dt);
    qs('#pgprint').href = '/api/reports/daily-progress/print.html?date=' + encodeURIComponent(dt);
    qs('#pgjobs').href = '/api/reports/jobs-summary.html?from=' + encodeURIComponent(dt);
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
    const SRC = { head_office: 'Head Office', local_purchase: 'Local Purchase' };
    const card = (title, cols, rows, empty) => `<div class="card section"><h3>${title}</h3>${
      rows.length ? tableWrap(cols, rows, { scroll: true, fit: true, noHScroll: true })
        : `<p class="muted" style="margin:0">${empty}</p>`}</div>`;
    qs('#pgbody').innerHTML = `
      <div class="grid section">
        <div class="card stat"><span class="n">${t.jobs}</span><span class="l">Jobs Worked</span></div>
        <div class="card stat"><span class="n">${num(t.hours)}</span><span class="l">Mechanic-Hours</span></div>
        <div class="card stat"><span class="n">${t.opened}</span><span class="l">Jobs Opened</span></div>
        <div class="card stat"><span class="n">${t.closed}</span><span class="l">Jobs Closed</span></div>
        <div class="card stat"><span class="n">${t.open_total}</span><span class="l">Still Open</span></div>
        <div class="card stat"><span class="n">${t.requested}</span><span class="l">Items Requested</span></div>
        <div class="card stat"><span class="n">${t.received}</span><span class="l">Items Received</span></div>
        <div class="card stat"><span class="n">${moneyC(t.grand)}</span><span class="l">Day Total</span></div>
      </div>
      ${card(`1 · Work done today`,
        [{ label: 'Job No', width: '110px' }, { label: 'Vehicle', width: '120px' }, { label: 'Mechanic(s)', width: '150px' }, { label: 'Work done', cls: 'desc-col' }, { label: 'Hours', num: true, width: '70px' }, { label: 'Labour', num: true, width: '110px' }],
        jobRows, 'No work logged on this day.')}
      ${card(`2 · Jobs opened today (${rep.opened.length})`,
        [{ label: 'Job No', width: '110px' }, { label: 'Vehicle', width: '120px' }, { label: 'Complaint / work requested', cls: 'desc-col' }, { label: 'Status', width: '120px' }],
        rep.opened.map((j) => `<tr><td>${esc(j.job_no)}</td><td>${esc(idLabel(j) || '—')}</td><td class="desc-col">${esc(j.description || '')}</td><td>${statusBadge(j.status)}</td></tr>`),
        'No new job cards opened.')}
      ${card(`3 · Jobs closed today (${rep.closed.length})`,
        [{ label: 'Job No', width: '110px' }, { label: 'Vehicle', width: '120px' }, { label: 'Work done', cls: 'desc-col' }, { label: 'Job total', num: true, width: '120px' }],
        rep.closed.map((j) => `<tr><td>${esc(j.job_no)}</td><td>${esc(idLabel(j) || '—')}</td><td class="desc-col">${esc(j.description || '')}</td><td class="num">${money(j.total_cost)}</td></tr>`),
        'No jobs closed.')}
      ${card(`4 · Still to do — open jobs (${rep.pending.length} active${t.open_total > rep.pending.length ? ` of ${t.open_total} open` : ''})`,
        [{ label: 'Job No', width: '110px' }, { label: 'Vehicle', width: '120px' }, { label: 'Work to do', cls: 'desc-col' }, { label: 'Status', width: '115px' }, { label: 'Opened', width: '92px' }, { label: 'Days', num: true, width: '60px' }, { label: 'Last worked', width: '100px' }],
        rep.pending.map((j) => `<tr><td>${esc(j.job_no)}</td><td>${esc(idLabel(j) || '—')}</td><td class="desc-col">${esc(j.description || '')}</td><td>${statusBadge(j.status)}</td><td>${esc(j.since || '')}</td><td class="num">${j.age_days > 30 ? `<span class="badge amber">${j.age_days}</span>` : j.age_days}</td><td>${esc(j.last_work || '—')}</td></tr>`),
        'Nothing open.')}
      ${card(`5 · Items requested today (${rep.requested.length})`,
        [{ label: 'MRN No', width: '110px' }, { label: 'Vehicle', width: '110px' }, { label: 'Item', cls: 'desc-col' }, { label: 'Category', width: '130px' }, { label: 'Qty', num: true, width: '70px' }, { label: 'Source', width: '120px' }],
        rep.requested.map((r) => `<tr><td>${esc(r.mrn_no || '')}</td><td>${esc(r.asset_code || '')}</td><td class="desc-col">${esc(r.description || '')}</td><td>${esc(r.category || '')}</td><td class="num">${num(r.qty)}</td><td>${esc(SRC[r.source] || '—')}</td></tr>`),
        'No material requests raised.')}
      ${card(`6 · Items received today (${rep.received.length}${t.received_unpriced ? ` · ${t.received_unpriced} awaiting price` : ''})`,
        [{ label: 'MRN No', width: '110px' }, { label: 'Vehicle', width: '110px' }, { label: 'Item', cls: 'desc-col' }, { label: 'Qty', num: true, width: '70px' }, { label: 'Supplier', width: '130px' }, { label: 'Source', width: '115px' }, { label: 'Value', num: true, width: '110px' }],
        rep.received.map((g) => `<tr><td>${esc(g.mrn_no || '')}</td><td>${esc(g.asset_code || '')}</td><td class="desc-col">${esc(g.description || '')}</td><td class="num">${num(g.qty)}</td><td>${esc(g.supplier || '')}</td><td>${esc(SRC[g.source] || '—')}</td><td class="num">${g.unit_price == null ? '<span class="badge amber">awaiting price</span>' : money((Number(g.qty) || 0) * g.unit_price)}</td></tr>`),
        'Nothing received.')}
      ${rep.issues.length ? card(`7 · Materials issued out (${rep.issues.length})`, [{ label: 'Item', cls: 'desc-col' }, { label: 'Job', width: '120px' }, { label: 'Qty', num: true, width: '70px' }, { label: 'Value', num: true, width: '110px' }], rep.issues.map((i) => `<tr><td class="desc-col">${esc(i.description)}</td><td>${esc(i.job_no || '')}</td><td class="num">${num(i.qty)}</td><td class="num">${money((Number(i.qty) || 0) * (Number(i.unit_price) || 0))}</td></tr>`), '') : ''}
      ${rep.oil.length ? card(`8 · Oil &amp; lubricants issued (${rep.oil.length})`, [{ label: 'Product', cls: 'desc-col' }, { label: 'Job', width: '120px' }, { label: 'Qty', num: true, width: '70px' }, { label: 'Value', num: true, width: '110px' }], rep.oil.map((o) => `<tr><td class="desc-col">${esc(o.product)}</td><td>${esc(o.job_no || '')}</td><td class="num">${num(Math.abs(o.qty))}</td><td class="num">${money(Math.abs(o.qty) * (Number(o.unit_price) || 0))}</td></tr>`), '') : ''}`;
  };
  const shiftDay = (n) => { const d = new Date(qs('#pgdate').value || today); d.setDate(d.getDate() + n); qs('#pgdate').value = d.toISOString().slice(0, 10); load(); };
  qs('#pgprev').onclick = () => shiftDay(-1);
  qs('#pgnext').onclick = () => shiftDay(1);
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
// A field tuple of ['Label', 'name', 'category'] renders the Category → Sub-category
// picker; it submits `category_id` like any other named control.
// New or corrected transfer note. The NUMBER is editable and pre-filled with the next in the
// sequence — these continue a paper book, so the storekeeper must be able to type the number
// actually written on it rather than accept whatever the system counted to.
// One item on a transfer note. `line` is an existing mtn_lines row when editing.
let _mtnLineSeq = 0;
function mtnLineHtml(line) {
  const l = line || {};
  const lid = 'mtnl' + (++_mtnLineSeq);
  const fld = (...args) => `<div class="fld">${field(...args)}</div>`;
  // A line only carries its own from/to when it genuinely differs from the note's — transfer
  // 64965 moved three filters off three different machines — so that pair stays folded away
  // until it is wanted, and blank keeps meaning "same as the note".
  const moved = l.from_location || l.to_location || l.from_asset_code || l.to_asset_code;
  return `<div class="mrnline" data-lid="${lid}" data-line-id="${l.id || ''}">
    <div class="mrnline-h"><span class="mrnline-n"></span><button type="button" class="sm danger mrnline-x" title="Remove this item">✕</button></div>
    <div style="position:relative">
      <label>Item</label>
      <input type="text" name="tdesc" id="${lid}_q" autocomplete="off" value="${esc(l.description || '')}" placeholder="Search the item catalogue, or type what is being moved…">
      <input type="hidden" name="titem" value="${l.store_item_id || ''}">
      <div id="${lid}_menu" style="position:absolute;z-index:60;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);max-height:220px;overflow:auto;display:none"></div>
    </div>
    <div class="fgrid" style="margin-top:6px">
      ${fld('Qty', 'tqty', { type: 'number', step: 'any', min: 0, value: l.qty != null ? l.qty : 1 })}
      ${fld('Unit', 'tunit', { value: l.unit || 'nos' })}
      <div class="fld">${categoryPickerHtml({ label: 'Category', name: 'tcat', value: l.category_id || '' })}</div>
    </div>
    <details class="mtn-line-move" ${moved ? 'open' : ''} style="margin-top:6px">
      <summary class="muted" style="cursor:pointer;font-size:11.5px">This item came from / goes somewhere else</summary>
      <div class="fgrid" style="margin-top:6px">
        ${fld('From (this item)', 'tfrom', { value: l.from_location || l.from_asset_code || '' })}
        ${fld('To (this item)', 'tto', { value: l.to_location || l.to_asset_code || '' })}
        ${fld('Reason (this item)', 'treason', { value: l.reason || '' })}
      </div>
    </details>
  </div>`;
}
function wireMtnLine(row) {
  const lid = row.dataset.lid;
  const input = qs('#' + lid + '_q', row), menu = qs('#' + lid + '_menu', row);
  const hItem = qs('input[name=titem]', row), unit = qs('input[name=tunit]', row);
  wireCategoryPickers(row);
  let deb;
  const close = () => { menu.style.display = 'none'; };
  input.oninput = () => {
    hItem.value = '';                       // typing invalidates a prior pick
    clearTimeout(deb);
    deb = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) return close();
      let rows = [];
      try { rows = await api('/stores/items/search?q=' + encodeURIComponent(q) + '&limit=12'); } catch (e) { return; }
      if (!rows.length) return close();
      menu.innerHTML = rows.map((r) => `<div class="mrnpick" data-id="${r.id || ''}" data-lube="${r.is_lubricant ? 1 : ''}" data-name="${esc(r.name)}" data-unit="${esc(r.unit || 'nos')}" data-cat="${r.category_id || ''}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)">
          <b>${esc(r.name)}</b>${r.item_no ? ` <span class="stamp">${esc(r.item_no)}</span>` : ''}</div>`).join('');
      menu.style.display = '';
      qsa('.mrnpick', menu).forEach((el) => { el.onclick = () => {
        input.value = el.dataset.name; hItem.value = el.dataset.id;
        if (unit && el.dataset.unit) unit.value = el.dataset.unit;
        const cat = qs('input[name=tcat]', row); if (cat && el.dataset.cat) cat.value = el.dataset.cat;
        close();
      }; });
    }, 250);
  };
  input.onblur = () => setTimeout(close, 150);
}

async function mtnModal(existing, onDone) {
  const today = new Date().toISOString().slice(0, 10);
  let suggested = '';
  let v = existing || {};
  let lines0 = [];
  if (existing) {
    try { const d = await api('/stores/mtn/' + existing.id); v = d.mtn; lines0 = d.lines; }
    catch (e) { return toast(e.message, 'err'); }
  } else {
    try { suggested = (await api('/stores/numbers')).next_mtn || ''; } catch (e) { /* type it in */ }
  }
  const fld = (...args) => `<div class="fld">${field(...args)}</div>`;
  const bg = modal(existing ? 'Edit MTN ' + esc(v.mtn_no) : 'New MTN (transfer)', `
    <div class="mrnsec">
      <div class="mrnsec-h">1 · The transfer note</div>
      <div class="fgrid">
        ${fld('MTN No *', 'mtn_no', { value: existing ? v.mtn_no || '' : suggested })}
        ${fld('Date', 'txn_date', { type: 'date', value: String(v.txn_date || today).slice(0, 10) })}
        ${fld('From location', 'from_location', { value: v.from_location || '' })}
        ${fld('To location', 'to_location', { value: v.to_location || '' })}
        ${fld('Transferred by', 'transferred_by', { value: v.transferred_by || '' })}
        ${fld('Received by', 'received_by', { value: v.received_by || '' })}
      </div>
      ${existing ? '' : fld('To asset (code/text)', 'to_asset')}
      ${field('Reason', 'reason', { value: v.reason || '' })}
      ${existing ? '' : `<p class="muted" style="font-size:11.5px;margin:6px 0 0">${suggested ? `Next in the sequence is ${esc(suggested)} — change it to match the book.` : 'Type the number from the transfer book.'} Everything here applies to the whole note; an item that came from somewhere else can say so on its own row.</p>`}
    </div>
    <div class="mrnsec">
      <div class="mrnsec-h">2 · Items on this note <span id="tlcount" class="muted" style="font-weight:400"></span></div>
      <div id="tlines"></div>
      <button class="sm" id="taddline" style="margin-top:4px">+ add another item</button>
    </div>
    <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;align-items:center">
      <button class="sm" id="tcancel">Cancel</button>
      <button class="primary" id="s">${existing ? 'Save changes' : 'Create transfer'}</button>
    </div>`,
  (root, close) => {
    const lines = qs('#tlines', root);
    const renumber = () => {
      const rows = qsa('.mrnline', lines);
      rows.forEach((r, i) => {
        const n = qs('.mrnline-n', r); if (n) n.textContent = 'Item ' + (i + 1);
        const x = qs('.mrnline-x', r); if (x) x.style.display = rows.length > 1 ? '' : 'none';
      });
      const c = qs('#tlcount', root); if (c) c.textContent = `— ${rows.length} item(s)`;
    };
    const removed = [];                       // ids of existing items the user took off the note
    const addLine = (line) => {
      const holder = document.createElement('div');
      holder.innerHTML = mtnLineHtml(line);
      const row = holder.firstElementChild;
      lines.appendChild(row);
      wireMtnLine(row);
      const x = qs('.mrnline-x', row);
      if (x) x.onclick = () => {
        if (row.dataset.lineId) removed.push(row.dataset.lineId);
        row.remove(); renumber();
      };
      renumber();
      if (!line) { const q = qs('input[name=tdesc]', row); if (q) q.focus(); }
    };
    if (lines0.length) lines0.forEach(addLine); else addLine();
    qs('#taddline', root).onclick = () => addLine();
    qs('#tcancel', root).onclick = close;

    const readLines = () => qsa('.mrnline', lines).map((row) => ({
      id: row.dataset.lineId || null,
      description: qs('input[name=tdesc]', row).value.trim(),
      store_item_id: qs('input[name=titem]', row).value || undefined,
      qty: qs('input[name=tqty]', row).value,
      unit: qs('input[name=tunit]', row).value.trim() || 'nos',
      category_id: qs('input[name=tcat]', row) ? qs('input[name=tcat]', row).value || undefined : undefined,
      from_location: qs('input[name=tfrom]', row).value.trim() || undefined,
      to_location: qs('input[name=tto]', row).value.trim() || undefined,
      reason: qs('input[name=treason]', row).value.trim() || undefined,
    })).filter((l) => l.description);

    qs('#s', root).onclick = async () => {
      const d = formData(root);
      const items = readLines();
      if (!String(d.mtn_no || '').trim()) return toast('Enter the MTN number', 'err');
      if (!items.length) return toast('Add at least one item', 'err');
      const bad = items.findIndex((l) => !(Number(l.qty) > 0));
      if (bad >= 0) return toast(`Item ${bad + 1}: enter a quantity`, 'err');
      // The header form carries item fields on a one-item note; strip them so a note is only
      // ever described by its items.
      const head = { mtn_no: d.mtn_no, txn_date: d.txn_date, from_location: d.from_location,
        to_location: d.to_location, transferred_by: d.transferred_by, received_by: d.received_by,
        reason: d.reason, to_asset: d.to_asset };
      try {
        if (!existing) {
          await api('/stores/mtn', { method: 'POST', body: { ...head, lines: items } });
        } else {
          await api('/stores/mtn/' + existing.id, { method: 'PATCH', body: head });
          // Additions before removals. The server refuses to empty a note, so swapping the only
          // item on a one-item note would be rejected if the delete went first.
          for (const l of items) {
            if (l.id) await api('/stores/mtn/line/' + l.id, { method: 'PATCH', body: l });
            else await api('/stores/mtn/' + existing.id + '/lines', { method: 'POST', body: l });
          }
          for (const id of removed) await api('/stores/mtn/line/' + id, { method: 'DELETE' });
        }
        toast(existing ? 'MTN updated' : 'MTN created');
        close(); onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  const box = qs('.modal', bg);
  if (box) { box.style.width = 'min(820px, 96vw)'; box.style.maxWidth = 'none'; }
}

function simpleCreateModal(title, path, fields) {
  const body = fields.map((f) => (f[2] === 'category'
    ? categoryPickerHtml({ label: f[0], name: f[1] })
    : field(f[0], f[1], { type: f[2] || 'text' }))).join('');
  modal(title, body + '<div style="margin-top:14px;text-align:right"><button class="primary" id="s">Create</button></div>', (root, close) => {
    if (fields.some((f) => f[2] === 'category')) wireCategoryPickers(root);
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
    <div class="card section"><h3 style="margin-top:0">Stock position <span class="muted" style="font-weight:400;font-size:12px">— requested, received, issued and what's left, from the shared stock ledger</span></h3>
      <div id="gs-stock"></div></div>
    <div class="grid section" id="gs-stats"></div>
    <div class="toolbar">
      <input type="search" id="gs-q" placeholder="Search name / item no / category…" style="max-width:240px">
      <select id="gs-cat" style="max-width:180px"><option value="">All categories</option></select>
      <button class="sm primary" id="gs-live">Live items only</button>
      <button class="sm" id="gs-low">Low stock only</button>
      <button class="sm" id="gs-unpriced">Unpriced only</button>
      <div class="spacer"></div>
      ${edit ? '<button class="primary sm" id="gs-add">+ Add Item</button>' : ''}
      <span class="muted" id="gs-count"></span>
    </div>
    <div id="gs-table" class="muted">Loading…</div>`;

  stockPanel(qs('#gs-stock', c), 'general');
  try { (await api('/general-stock/categories')).forEach((cat) => { const o = document.createElement('option'); o.value = cat; o.textContent = cat; qs('#gs-cat').appendChild(o); }); } catch (e) { /* dropdown optional */ }

  // The register carries ~700 zero-balance names left behind by the old warehouse import —
  // "(+) terminal", "(14mm) must Belt" — which alphabetically bury the items actually being
  // kept. "Live" means the item holds stock or sits on a real rack, i.e. it is on one of the
  // storekeeper's sheets. Everything is still one click away.
  const RACKS = ['1C', '1D', '2C', '2D', '5E', '6E', '10D', 'Car Wash'];
  const isLive = (r) => Number(r.balance) !== 0 || RACKS.includes(String(r.location || '').trim());
  let liveOnly = true, lowOnly = false, unpricedOnly = false, rows = [], suggMap = null;
  const load = async () => {
    const q = qs('#gs-q').value.trim(), cat = qs('#gs-cat').value;
    const query = '?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + (cat ? 'category=' + encodeURIComponent(cat) + '&' : '') + (lowOnly ? 'low_stock=1' : '');
    try {
      if (suggMap === null) { try { suggMap = await api('/general-stock/suggestions'); } catch (e) { suggMap = {}; } }
      const [s, items] = await Promise.all([api('/general-stock/summary'), api('/general-stock/items' + query)]);
      qs('#gs-stats').innerHTML = [
        [num(s.total_items), 'Total Items'], [moneyC(s.total_value), 'Total Value (LKR)'],
        [num(s.low_stock_count), 'Low Stock'], [num(s.categories), 'Categories'],
      ].map(([n, l]) => `<div class="card stat"><span class="n">${n}</span><span class="l">${esc(l)}</span></div>`).join('');
      rows = unpricedOnly ? items.filter((r) => !(Number(r.unit_cost) > 0)) : items;
      // Only while browsing. Someone who has typed a name is looking for that thing and
      // should find it, even if it is one of the old empty ones.
      const filtering = liveOnly && !q;
      const hidden = filtering ? rows.filter((r) => !isLive(r)).length : 0;
      if (filtering) rows = rows.filter(isLive);
      qs('#gs-count').textContent = rows.length + (rows.length === 1 ? ' item' : ' items')
        + (unpricedOnly ? ' (unpriced)' : '')
        + (hidden ? ` · ${hidden} empty older item${hidden === 1 ? '' : 's'} hidden` : '');
      const headers = [{ label: 'Item No' }, { label: 'Name' }, { label: 'Category' }, { label: 'Unit' }, { label: 'Balance', num: true }, { label: 'Min Stock', num: true }, { label: 'Unit Cost (Rs)', num: true }, { label: 'Total Value', num: true }, { label: 'Status' }, { label: 'Actions' }];
      const priceCell = (r) => {
        if (!edit) return `<td class="num">${money(r.unit_cost)}</td>`;
        const sug = suggMap[r.id];
        const hint = (!(Number(r.unit_cost) > 0) && sug) ? `<br><a href="#" class="gs-use muted" data-id="${r.id}" data-p="${sug}" style="font-size:11px">use ${money(sug)}</a>` : '';
        return `<td class="num"><input type="number" min="0" step="0.01" class="gs-price" data-id="${r.id}" value="${Number(r.unit_cost) > 0 ? r.unit_cost : ''}" placeholder="${sug || 0}" style="width:92px;text-align:right">${hint}</td>`;
      };
      const body = rows.map((r) => `<tr${r.status !== 'ok' ? ' style="background:rgba(224,168,0,.06)"' : ''}>
        <td>${esc(r.item_no || '')}</td>
        <td><b>${esc(r.name)}</b>${r.description ? `<br><span class="muted" style="font-size:11px">${esc(r.description)}</span>` : ''}</td>
        <td>${esc(r.category || '—')}</td><td>${esc(r.unit || '')}</td>
        <td class="num">${num(r.balance)}</td><td class="num">${num(r.min_stock)}</td>
        ${priceCell(r)}<td class="num">${money(r.total_value)}</td>
        <td>${gsStatus(r.status)}</td>
        <td><button class="sm" data-led="${r.id}">Movements</button>${edit ? ` <button class="sm" data-adj="${r.id}">Adjust</button>` : ''}</td></tr>`);
      qs('#gs-table').innerHTML = tableWrap(headers, body, { scroll: true });
      qsa('[data-led]').forEach((b) => { b.onclick = () => gsLedger(b.dataset.led); });
      qsa('[data-adj]').forEach((b) => { b.onclick = () => gsAdjust(rows.find((x) => String(x.id) === b.dataset.adj)); });
      const savePrice = async (id, val) => {
        try { await api('/general-stock/items/' + id + '/price', { method: 'POST', body: { unit_cost: val === '' ? null : Number(val) } });
          const it = rows.find((x) => String(x.id) === String(id)); if (it) { it.unit_cost = val === '' ? 0 : Number(val); it.total_value = Math.round(it.balance * it.unit_cost * 100) / 100; }
          toast('Price saved'); } catch (e) { toast(e.message, 'err'); }
      };
      qsa('.gs-price', qs('#gs-table')).forEach((inp) => { inp.onchange = () => savePrice(inp.dataset.id, inp.value); });
      qsa('.gs-use', qs('#gs-table')).forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); const inp = qs('.gs-price[data-id="' + a.dataset.id + '"]', qs('#gs-table')); if (inp) { inp.value = a.dataset.p; savePrice(a.dataset.id, a.dataset.p); a.remove(); } }; });
    } catch (e) { qs('#gs-table').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  };
  qs('#gs-unpriced', c).onclick = () => { unpricedOnly = !unpricedOnly; qs('#gs-unpriced', c).classList.toggle('primary', unpricedOnly); load(); };

  const gsAdd = () => modal('Add General Stock Item', `
    ${field('Name', 'name')}
    ${categoryPickerHtml({ label: 'Category' })}
    <div class="row">${field('Unit', 'unit', { value: 'nos' })}${field('Item No (auto if blank)', 'item_no', { placeholder: 'GS-####' })}</div>
    <div class="row">${field('Opening balance', 'balance', { type: 'number', value: '0' })}${field('Min stock (reorder)', 'min_stock', { type: 'number', value: '0' })}</div>
    <div class="row">${field('Unit cost (LKR)', 'unit_cost', { type: 'number', value: '0' })}${field('Location', 'location')}</div>
    ${field('Description', 'description')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="gs-save">Add Item</button></div>`, (body, close) => {
    wireCategoryPickers(body);
    qs('#gs-save', body).onclick = async () => {
      const d = formData(body);
      if (!d.name.trim()) return toast('Name is required', 'err');
      try { await api('/general-stock/items', { method: 'POST', body: d }); toast('Item added'); close(); load(); } catch (e) { toast(e.message, 'err'); }
    };
  });

  // Every movement behind an item's balance — what came in, what went out and to which
  // machine. Without this the register showed a number with nothing to explain it.
  const gsLedger = async (id) => {
    let d;
    try { d = await api('/general-stock/items/' + id); } catch (e) { return toast(e.message, 'err'); }
    const it = d.item;
    const issued = d.ledger.filter((l) => l.txn_type === 'issue').reduce((s, l) => s + Math.abs(l.qty), 0);
    const recvd = d.ledger.filter((l) => l.txn_type !== 'issue').reduce((s, l) => s + Math.abs(l.qty), 0);
    modal('Movements — ' + it.name, `
      <p class="muted" style="margin-top:0">${esc(it.item_no || '')}${it.location ? ' · rack <b>' + esc(it.location) + '</b>' : ''}
        · in <b>${num(recvd)}</b> · out <b>${num(issued)}</b> · balance <b>${num(it.balance)}</b> ${esc(it.unit || '')}</p>
      ${d.ledger.length ? tableWrap(
    [{ label: 'Date', width: '96px' }, { label: 'What', width: '86px' }, { label: 'Qty', num: true, width: '70px' },
      { label: 'Balance', num: true, width: '84px' }, { label: 'Machine / for', cls: 'desc-col' },
      { label: 'MR / GRN', width: '96px' }, { label: 'Job', width: '104px' }],
    d.ledger.map((l) => `<tr>
          <td>${esc(String(l.txn_date || '').slice(0, 10))}</td>
          <td>${l.txn_type === 'issue' ? '<span class="badge amber">issued</span>' : (l.txn_type === 'opening' ? '<span class="badge">opening</span>' : '<span class="badge green">received</span>')}</td>
          <td class="num">${num(l.qty)}</td>
          <td class="num">${num(l.balance_after)}</td>
          <td class="desc-col">${esc(idLabel(l) || '')}</td>
          <td>${esc(l.ref || '')}</td>
          <td>${l.job_no ? esc(l.job_no) : ''}</td></tr>`),
    { scroll: true })
    : '<p class="muted">No movements recorded for this item yet.</p>'}`, null, { wide: true });
  };

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
  qs('#gs-live').onclick = () => { liveOnly = !liveOnly; qs('#gs-live').classList.toggle('primary', liveOnly); load(); };
  qs('#gs-low').onclick = () => { lowOnly = !lowOnly; qs('#gs-low').classList.toggle('primary', lowOnly); load(); };
  if (edit && qs('#gs-add')) qs('#gs-add').onclick = gsAdd;
  load();
};

// ===== Filter Stock — native SPA view (was public/filter-stock.html) =====
// Dedicated filter inventory (filter_stock + filter_stock_ledger). Backed by /api/filter-stock.
const fsStatus = (s) => (s === 'critical' ? '<span class="badge red">CRITICAL</span>' : s === 'low' ? '<span class="badge amber">LOW</span>' : '<span class="badge green">OK</span>');
const fsPills = (v) => (v ? String(v).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => `<span class="badge" style="font-weight:400">${esc(x)}</span>`).join(' ') : '<span class="muted">—</span>');
// ---- Shared stock panel -----------------------------------------------------
// One component, mounted in Oil & Lube / Batteries / General Stock / Filter Stock.
// Every section answers the same four questions — on order, received, issued, balance —
// and each item opens its full movement trail: what went where, when and to which vehicle.
async function stockPanel(host, section, opts = {}) {
  host.innerHTML = '<div class="muted">Loading stock…</div>';
  let data;
  try { data = await api(`/stores/stock/${section}?limit=400`); }
  catch (e) { host.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const s = data.summary;
  const cut = s.opening && s.opening.mode === 'cutover' ? s.opening.cutover : null;

  host.innerHTML = `
    <div class="grid section">
      <div class="card stat"><span class="n">${num(s.received)}</span><span class="l">Received in</span></div>
      <div class="card stat"><span class="n">${num(s.issued)}</span><span class="l">Issued out</span></div>
      <div class="card stat"><span class="n" style="color:${s.balance < 0 ? 'var(--danger,#c4392c)' : 'inherit'}">${num(s.balance)}</span><span class="l">Balance in stock</span></div>
      <div class="card stat"><span class="n">${num(s.items)}</span><span class="l">Items</span></div>
    </div>
    ${cut ? `<p class="muted" style="font-size:12px;margin:0 0 8px">Stock for this section counts from <b>${esc(cut)}</b> — earlier movements (${num(s.history_moves)}, ${num(s.history_issued)} issued) are kept as history below but don't affect the balance, because those purchases were never recorded in stores.</p>` : ''}
    <div class="toolbar">
      <input id="sk-q" type="search" placeholder="Search item…" style="max-width:260px">
      <button class="sm primary" id="sk-items">By item</button>
      <button class="sm" id="sk-moves">All movements</button>
      <div class="spacer"></div><span class="muted" id="sk-count"></span>
    </div>
    <div id="sk-body"><div class="muted">Loading…</div></div>`;

  let mode = 'items';
  const bodyEl = qs('#sk-body', host);

  const showMoves = (rows, title) => {
    qs('#sk-count', host).textContent = `${rows.length} movement(s)`;
    bodyEl.innerHTML = (title ? `<h3 style="margin:0 0 6px">${esc(title)}</h3>` : '')
      + (rows.length ? tableWrap(
        [{ label: 'Date' }, { label: 'In / Out' }, { label: 'Item', cls: 'desc-col' }, { label: 'Qty', num: true },
          { label: 'Vehicle' }, { label: 'Job / Ref' }, { label: 'Counts?' }],
        rows.map((m) => `<tr>
          <td>${esc(m.txn_date || '—')}</td>
          <td>${m.kind === 'out' ? '<span class="badge amber">issued</span>' : `<span class="badge green">${esc(m.kind)}</span>`}</td>
          <td class="desc-col">${esc(m.item_name || '')}</td>
          <td class="num">${num(m.qty)}</td>
          <td>${m.asset_reg || m.asset_code ? `<span class="stamp">${esc(m.asset_reg || m.asset_code)}</span>` : '—'}</td>
          <td>${esc(m.job_no || m.ref || '')}</td>
          <td>${m.counts ? '<span class="badge green">yes</span>' : `<span class="badge" title="${esc(m.note || 'before the stock cut-over')}">history</span>`}</td></tr>`),
        { scroll: true, fit: true, noHScroll: true })
        : '<div class="card"><p class="muted">No movements.</p></div>');
  };

  const load = async () => {
    const q = qs('#sk-q', host).value.trim();
    qs('#sk-items', host).classList.toggle('primary', mode === 'items');
    qs('#sk-moves', host).classList.toggle('primary', mode === 'moves');
    bodyEl.innerHTML = '<div class="muted">Loading…</div>';
    if (mode === 'moves') {
      showMoves(await api(`/stores/stock/${section}/moves?limit=400${q ? '&q=' + encodeURIComponent(q) : ''}`));
      return;
    }
    const d = await api(`/stores/stock/${section}?limit=400${q ? '&q=' + encodeURIComponent(q) : ''}`);
    qs('#sk-count', host).textContent = `${d.items.length} item(s)`;
    bodyEl.innerHTML = d.items.length ? tableWrap(
      [{ label: 'Item', cls: 'desc-col' }, { label: 'Received', num: true }, { label: 'Issued', num: true },
        { label: 'Balance', num: true }, { label: 'Issued (all time)', num: true }, { label: 'Last movement' }, { label: '' }],
      d.items.map((i) => `<tr>
        <td class="desc-col">${esc(i.item_name || i.item_key)}</td>
        <td class="num">${num(i.received)}</td>
        <td class="num">${num(i.issued)}</td>
        <td class="num"><b style="color:${i.balance < 0 ? 'var(--danger,#c4392c)' : 'inherit'}">${num(i.balance)}</b></td>
        <td class="num muted">${num(i.issued_all_time)}</td>
        <td>${esc(i.last_move || '—')}</td>
        <td><button class="sm" data-hist="${esc(i.item_key)}" data-name="${esc(i.item_name || i.item_key)}">history →</button></td></tr>`),
      { scroll: true, fit: true, noHScroll: true })
      : '<div class="card"><p class="muted">Nothing recorded for this section yet.</p></div>';
    // Drill into one item: every movement, which vehicle, when, how much.
    qsa('[data-hist]', bodyEl).forEach((b) => b.onclick = async () => {
      bodyEl.innerHTML = '<div class="muted">Loading history…</div>';
      const rows = await api(`/stores/stock/${section}/moves?item_key=${encodeURIComponent(b.dataset.hist)}&limit=400`);
      showMoves(rows, b.dataset.name);
      bodyEl.insertAdjacentHTML('afterbegin', '<button class="sm" id="sk-back" style="margin-bottom:8px">← back to items</button>');
      qs('#sk-back', bodyEl).onclick = load;
    });
  };
  qs('#sk-items', host).onclick = () => { mode = 'items'; load(); };
  qs('#sk-moves', host).onclick = () => { mode = 'moves'; load(); };
  let skdeb; qs('#sk-q', host).oninput = () => { clearTimeout(skdeb); skdeb = setTimeout(load, 250); };
  await load();
}

// ---- Service & Filter Plan -------------------------------------------------
// Which machines are candidates for service this month, and the filters each would need —
// read out of what that machine actually took at its own past services. Deliberately framed
// as a shortlist to tick through: the underlying prediction is about 70 days out on average,
// and roughly 150 machines qualify in a month that will really see 26–49 services.
routes.serviceplan = async (c) => {
  if (!canView('filters')) { c.innerHTML = `<div class="card"><p class="err">You do not have access to Filters.</p></div>`; return; }
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = /^\d{4}-\d{2}$/.test(sp.get('month') || '') ? sp.get('month') : new Date().toISOString().slice(0, 7);

  c.innerHTML = `${pageHeader('Service &amp; Filter Plan', 'Machines due for service this month and the filters they will need, from each machine’s own service history.')}
    <div class="toolbar">
      <div><label>Month</label><input type="month" id="spm" value="${esc(month)}" style="max-width:170px"></div>
      <label class="muted" style="font-weight:400;font-size:12px;display:flex;align-items:center;gap:5px">
        <input type="checkbox" id="splong" style="width:auto;margin:0"> also show parked & unrecorded</label>
      <div class="spacer"></div>
      <a class="btn sm" id="spdl" href="#" target="_blank">⬇ Excel</a>
    </div>
    <div id="spstats" class="grid section"></div>
    <div id="spwarn"></div>
    <div id="spbody"><div class="muted">Loading…</div></div>`;

  const load = async () => {
    const m = qs('#spm', c).value || month;
    const long = qs('#splong', c).checked ? '&include_long_overdue=1' : '';
    qs('#spdl', c).href = `/api/filters/service-plan?month=${m}${long}&format=xlsx`;
    history.replaceState(null, '', '#/serviceplan?month=' + m);
    const box = qs('#spbody', c);
    box.innerHTML = '<div class="muted">Working out the plan…</div>';
    let d;
    try { d = await api(`/filters/service-plan?month=${m}${long}`); }
    catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }

    const t = d.totals; const f = d.fleet;
    // The whole register in four states — the two on the left are the ones this page lists.
    qs('#spstats', c).innerHTML = [
      [num(f.overdue), 'Overdue', 'var(--danger,#c4392c)'],
      [num(f.due_soon), 'Due soon', 'var(--warn,#e0a800)'],
      [num(f.ok), 'OK', 'var(--ok,#2f8f4e)'],
      [num(f.unknown), 'Unknown', ''],
    ].map(([n, l, col]) => `<div class="card stat"><span class="n"${col ? ` style="color:${col}"` : ''}>${n}</span><span class="l">${esc(l)}</span></div>`).join('')
      + `<div class="card stat"><span class="n">${num(t.qty_to_buy)}</span><span class="l">Filters to buy · ${moneyC(t.value_priced)}</span></div>`;

    // Where the verdict came from matters: the planner measures what a machine has actually
    // run, this system can only measure elapsed days. Never let one pass for the other.
    const linked = d.source === 'service planner';
    qs('#spwarn', c).innerHTML = `<div class="card section" style="border-left:3px solid ${linked ? 'var(--ok,#2f8f4e)' : 'var(--warn,#e0a800)'}">
      <p style="margin:0 0 6px;font-size:12.5px">${linked
    ? `✓ <b>From the Service Planner</b> — it measures meter growth and fuel-derived running${d.planner_as_of ? `, as at ${esc(d.planner_as_of)}` : ''}.`
    : `⚠ <b>WorkshopOne's own estimate</b>, from service dates only — this system holds no meter or fuel data, so a machine that has barely run can read as overdue.<br><span class="muted" style="font-size:11.5px">Service Planner not used: ${esc(d.planner_error || 'unavailable')}</span>`}</p>
      ${d.warnings.map((w) => `<p class="muted" style="margin:4px 0;font-size:12px">• ${esc(w)}</p>`).join('')}
      <p class="muted" style="margin:6px 0 0;font-size:11.5px">${num(f.registered)} machines on the register, ${num(f.active)} touched in the last 180 days. Unknown = ${num(f.unknown_why.never_serviced)} never serviced · ${num(f.unknown_why.parked)} parked · ${num(f.unknown_why.no_recent_record)} running but no service recorded in over twice their usual gap${f.off_register_listed ? ` · ${num(f.off_register_listed)} listed machine(s) are off the register` : ''}.</p>
      <p class="muted" style="margin:4px 0 0;font-size:11.5px"><b>As at ${esc(d.as_of)}</b> — a machine drops off the day its service is recorded${d.as_of === new Date().toISOString().slice(0, 10) ? ' (today)' : ''} · typical gap across the fleet ${d.fleet_prior} days, from ${num(d.fleet_gaps)} intervals${t.lines_without_a_part ? ` · ${t.lines_without_a_part} filter(s) with no part number in the machine’s history` : ''}</p></div>`;

    // The filters a machine needs, as chips — category first, because that is the part this
    // is confident about; the number beside it is the one it took last time.
    const kit = (v) => (v.core.length
      ? v.core.map((k) => `<span class="badge ${k.confirm ? 'amber' : ''}" title="${esc(k.category)} — seen on ${k.seen} of ${k.of} services${k.last_fitted ? ', last fitted ' + k.last_fitted : ''}${k.distinct_numbers > 1 ? '. Numbers used: ' + k.alternates.join(', ') : ''}">${esc(k.category)}${k.part ? ' · ' + esc(k.part) : ' · <i>no number on record</i>'}</span>`).join(' ')
      : '<span class="muted">no filter ever recorded for this machine</span>')
      + (v.sometimes.length ? ` <span class="muted" style="font-size:11px" title="${esc(v.sometimes.map((s) => `${s.category} — ${s.seen} of ${s.of}`).join('; '))}">+${v.sometimes.length} sometimes fitted</span>` : '');

    const table = (rows) => tableWrap(
      [{ label: 'Machine', width: '130px' }, { label: 'Site', width: '110px' }, { label: 'Last service', width: '96px' },
        { label: 'Services', num: true, width: '76px' }, { label: 'Every', width: '132px' },
        { label: 'Due', width: '96px' }, { label: 'Idle', num: true, width: '68px' },
        { label: 'Filters needed', cls: 'desc-col' }],
      rows.map((v) => `<tr>
        <td><b>${esc(idLabel(v) || v.asset_code || '—')}</b>${v.in_register ? '' : ' <span class="badge" title="not on the register">off-register</span>'}</td>
        <td>${esc(v.site || '')}</td>
        <td>${esc(v.last_service)}</td>
        <td class="num">${v.visits}</td>
        <td>${v.expected_gap} d <span class="muted" style="font-size:11px">${esc(v.basis)}</span></td>
        <td>${esc(v.due_date)}</td>
        <td class="num">${v.days_idle}</td>
        <td class="desc-col">${kit(v)}</td></tr>`),
      { scroll: true, fit: true, noHScroll: true });

    box.innerHTML = `
      <div class="card section"><div class="toolbar" style="margin-top:0"><h3 style="margin:0">Due soon — in ${esc(d.month)}</h3>
        <span class="muted" style="font-weight:400">— ${num(d.due.length)} machine(s), most-serviced first</span></div>
        ${d.due.length ? table(d.due) : '<p class="muted">Nothing falls due this month.</p>'}</div>

      <div class="card section"><div class="toolbar" style="margin-top:0"><h3 style="margin:0">Overdue</h3>
        <span class="muted" style="font-weight:400">— ${num(d.carry.length)} machine(s) past due and still running</span>
        <div class="spacer"></div><button class="sm" id="spcarry">${d.carry.length ? 'Show' : ''}</button></div>
        <div id="spcarrybox"></div></div>

      ${d.parked && d.parked.length ? `<div class="card section"><div class="toolbar" style="margin-top:0"><h3 style="margin:0">Parked &amp; unrecorded</h3>
        <span class="muted" style="font-weight:400">— ${num(d.parked.length)} machine(s) with no recent service record; included in the order below while this is ticked</span></div>
        ${table(d.parked)}</div>` : ''}

      <div class="card section"><div class="toolbar" style="margin-top:0"><h3 style="margin:0">Filter request for ${esc(d.month)}</h3>
        <div class="spacer"></div>
        <button class="sm primary" id="sptab-cat">By category</button>
        <button class="sm" id="sptab-part">By part number</button></div>
        <div id="sporder"></div></div>`;

    const carryBtn = qs('#spcarry', c);
    if (carryBtn && d.carry.length) {
      let open = false;
      carryBtn.onclick = () => {
        open = !open;
        qs('#spcarrybox', c).innerHTML = open ? table(d.carry) : '';
        carryBtn.textContent = open ? 'Hide' : 'Show';
      };
    }

    const drawCat = () => {
      qs('#sporder', c).innerHTML = tableWrap(
        // No separate "machines" column: a machine takes one filter per category, so it would
        // always repeat the quantity.
        [{ label: 'Filter', cls: 'desc-col' }, { label: 'Machines needing it', num: true, width: '150px' },
          { label: 'On hand', num: true, width: '92px' }, { label: 'Short', num: true, width: '86px' }],
        d.categories.map((x) => `<tr${x.shortfall > 0 ? ' style="background:rgba(224,168,0,.06)"' : ''}>
          <td class="desc-col">${esc(x.category)}</td><td class="num">${num(x.qty)}</td>
          <td class="num">${num(x.on_hand)}</td>
          <td class="num">${x.shortfall > 0 ? '<b>' + num(x.shortfall) + '</b>' : '0'}</td></tr>`),
        { scroll: true });
    };
    const drawPart = () => {
      qs('#sporder', c).innerHTML = tableWrap(
        [{ label: 'Part number', width: '150px' }, { label: 'Filter', cls: 'desc-col' },
          { label: 'Machines', num: true, width: '92px' }, { label: 'Needed', num: true, width: '82px' },
          { label: 'On hand', num: true, width: '86px' }, { label: 'To buy', num: true, width: '80px' },
          { label: 'Unit price', num: true, width: '100px' }, { label: 'Value', num: true, width: '110px' }],
        d.parts.map((p) => `<tr${p.to_buy > 0 ? ' style="background:rgba(224,168,0,.06)"' : ''}>
          <td><b>${esc(p.part || '')}</b>${p.no_stock_row ? ' <span class="badge" title="this number is not on the filter stock sheet">not on the sheet</span>' : ''}${p.duplicate_stock_rows ? ' <span class="badge amber" title="more than one stock row for this number — verify">2 stock rows</span>' : ''}</td>
          <td class="desc-col">${esc(p.category)}</td>
          <td class="num">${num(p.vehicles)}</td><td class="num">${num(p.qty)}</td>
          <td class="num">${num(p.on_hand)}</td><td class="num">${p.to_buy > 0 ? '<b>' + num(p.to_buy) + '</b>' : '0'}</td>
          <td class="num">${p.unit_price == null ? '<span class="muted">no price</span>' : money(p.unit_price)}</td>
          <td class="num">${p.value == null ? '—' : money(p.value)}</td></tr>`),
        { scroll: true });
    };
    qs('#sptab-cat', c).onclick = () => { qs('#sptab-cat', c).classList.add('primary'); qs('#sptab-part', c).classList.remove('primary'); drawCat(); };
    qs('#sptab-part', c).onclick = () => { qs('#sptab-part', c).classList.add('primary'); qs('#sptab-cat', c).classList.remove('primary'); drawPart(); };
    drawCat();
  };

  qs('#spm', c).onchange = load;
  qs('#splong', c).onchange = load;
  await load();
};

routes.filterstock = async (c) => {
  if (!canView('filters')) { c.innerHTML = `<div class="card"><p class="err">You do not have access to Filters.</p></div>`; return; }
  const edit = canEdit('filters');
  c.innerHTML = pageHeader('Filter Stock') + `
    <div class="card section"><h3 style="margin-top:0">Stock position <span class="muted" style="font-weight:400;font-size:12px">— requested, received, issued and what's left, from the shared stock ledger</span></h3>
      <div id="fs-stock"></div></div>
    <div class="grid section" id="fs-stats"></div>
    <div class="toolbar">
      <input type="search" id="fs-q" placeholder="Search type / brand / part no / vehicle…" style="max-width:280px">
      <button class="sm" id="fs-low">Low stock only</button>
      <div class="spacer"></div>
      ${edit ? '<button class="primary sm" id="fs-add">+ Add Filter Type</button>' : ''}
      <span class="muted" id="fs-count"></span>
    </div>
    <div id="fs-table" class="muted">Loading…</div>`;
  stockPanel(qs('#fs-stock', c), 'filter');
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
        <td>${r.category ? `<span class="badge">${esc(r.category)}</span>${r.sub_category ? ` <span class="muted" style="font-size:11px">${esc(r.sub_category)}</span>` : ''}` : '—'}</td></tr>`);
      qs('#si-table').innerHTML = tableWrap(headers, body, { scroll: true });
    } catch (e) { qs('#si-table').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  };

  const newIssue = () => {
    const today = new Date().toISOString().slice(0, 10);
    modal('New Stock Issue', `
      ${jobPickerHtml('si-job', { label: 'Issue to job card * — the vehicle comes from the job' })}
      ${issueItemHtml('si-item')}
      <div class="row">${field('Quantity', 'qty', { type: 'number', value: '1' })}${field('Unit Price (LKR)', 'unit_price', { type: 'number' })}</div>
      ${field('Date', 'issue_date', { type: 'date', value: today })}
      ${categoryPickerHtml({ label: 'Category' })}
      ${field('Issued By', 'issued_by', { value: (ME.fullName || ME.username) })}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="si-save">Record Issue</button></div>`, (body, close) => {
      const getJob = wireJobPicker(body, 'si-job');
      wireCategoryPickers(body);
      wireIssueItem(body, 'si-item');
      qs('#si-save', body).onclick = async () => {
        const d = formData(body);
        const j = getJob();
        if (!j.job_id) return toast('Pick the job card this issue belongs to', 'err');
        const description = (d.description || '').trim();
        if (!description) return toast('Pick or type an item', 'err');
        if (!(Number(d.qty) > 0)) return toast('Enter a quantity greater than 0', 'err');
        try {
          const r = await postIssue({
            job_id: j.job_id, description, store_item_id: d.store_item_id || undefined,
            qty: d.qty, unit_price: d.unit_price, issue_date: d.issue_date,
            category_id: d.category_id || undefined, issued_by: d.issued_by,
          });
          if (!r) return;
          toast('Issue recorded on ' + j.job_no); close(); load();
        } catch (e) { toast(e.message, 'err'); }
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
  const currentServer = window.WORKSHOPONE_API_BASE || window.location.origin;
  qs('#app').innerHTML = `<div class="login-wrap"><div class="card login-card">
    <div class="brand">Workshop<span style="color:var(--primary)">One</span></div>
    <div class="sub">Central Workshop Master System<br>Edward &amp; Christie · Badalgama</div>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <label>Username</label><input id="u" autofocus>
    <label>Password</label><input id="p" type="password">
    <button class="primary" id="login" style="width:100%;margin-top:14px">Sign In</button>
    <button type="button" class="btn" onclick="window.configureServerIp()" style="width:100%;margin-top:8px;font-size:12px;cursor:pointer">⚙️ Server: ${esc(currentServer)}</button>
    <!-- The demo credentials that used to be printed here (admin/admin, store/store, …) are gone.
         They were seed passwords, all since rotated, so the hint was wrong as well as unwise:
         people read it, typed admin/admin, were refused, and concluded the system was broken.
         On a login page facing the internet it was also a list of which names are worth guessing. -->
  </div></div>`;
  const go = async () => {
    try {
      ME = await api('/auth/login', { method: 'POST', body: { username: qs('#u').value, password: qs('#p').value } });
      live('connect');   // the socket is refused until a session exists
      location.hash = '#/dashboard'; render();
      if (ME.mustChangePassword) forceChangePassword();
    } catch (e) { renderLogin(e.message || 'Connection failed'); }
  };
  qs('#login').onclick = go;
  qs('#p').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function boot() {
  try {
    ME = await api('/auth/me');
    live('connect');   // an existing session — open the live socket
    if (!location.hash) location.hash = '#/dashboard';
    render();
    if (ME.mustChangePassword) forceChangePassword();
  } catch (e) {
    renderLogin(e && e.message ? 'Server connection issue: ' + e.message : null);
  }
}
boot();
