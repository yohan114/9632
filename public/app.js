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

// In-memory reference cache for high-frequency dropdown feeds (mechanics, assets, oil catalogue).
// 60-second TTL; automatically invalidated on any state mutation (POST, PUT, PATCH, DELETE).
const REF_CACHE_PATHS = new Set(['/mechanics', '/assets', '/aliases/refs', '/oil/products']);
const refCache = new Map();
function clearRefCache() { refCache.clear(); }

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const isRefPath = method === 'GET' && REF_CACHE_PATHS.has(path.split('?')[0]);
  if (isRefPath) {
    const hit = refCache.get(path);
    if (hit && Date.now() - hit.time < 60000) return JSON.parse(JSON.stringify(hit.data));
  }
  const baseUrl = (window.WORKSHOPONE_API_BASE || '').replace(/\/+$/, '');
  const url = (baseUrl ? baseUrl : '') + '/api' + path;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    // How long since the last mouse / keyboard / touch input: the server counts only REAL use
    // towards the idle timeout, not the refreshes this page makes on its own (src/lib/auth.js).
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), 'X-WO-Idle-Ms': String(idleMs()) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'include',
  });
  // The session is over (expired, idle, or signed out from another device): back to sign-in,
  // instead of every panel on the page showing "Authentication required".
  if (res.status === 401 && res.headers.get('X-WO-Session') === 'ended' && ME) {
    sessionEnded('Your session has ended. Please sign in again.');
  }
  if (method !== 'GET') clearRefCache();
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = new Error((data && data.error) || res.statusText);
    e.status = res.status; e.data = data;
    // The role now requires two-factor sign-in (perhaps switched on while this person was working).
    if (res.status === 428 && data && data.mfaSetupRequired && ME) { ME.mfaSetupRequired = true; forceMfaSetup(); }
    throw e;
  }
  if (isRefPath) refCache.set(path, { time: Date.now(), data });
  return data;
}

// ---- idle sign-out -----------------------------------------------------------------------------
//
// A PC left signed in at the stores counter is anyone's. After the idle limit (from the server,
// default 2 hours) without mouse, keyboard or touch input, this page signs itself out; a minute
// before, it warns. Activity is shared across this browser's tabs (localStorage), so working in one
// tab keeps the others signed in. The server enforces the same limit on its own (src/lib/auth.js).
const ACTIVITY_KEY = 'wo_last_activity';
let _lastInput = Date.now();
let _lastStored = 0;
let _idleWarned = false;
function noteActivity() {
  _lastInput = Date.now();
  if (_lastInput - _lastStored > 5000) {
    _lastStored = _lastInput;
    try { localStorage.setItem(ACTIVITY_KEY, String(_lastInput)); } catch (e) { /* private mode */ }
  }
  if (_idleWarned) { _idleWarned = false; const w = document.getElementById('idle-warn'); if (w) w.remove(); }
}
['mousedown', 'mousemove', 'keydown', 'touchstart', 'wheel', 'scroll']
  .forEach((ev) => window.addEventListener(ev, noteActivity, { passive: true, capture: true }));
function lastActivity() {
  let stored = 0;
  try { stored = Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch (e) { /* private mode */ }
  return Math.max(_lastInput, stored);
}
function idleMs() { return Math.max(0, Date.now() - lastActivity()); }

let _sessionEnding = false;
// Back to the sign-in screen. `logout`: also end the session on the server (the idle case; when the
// server already ended it there is nothing to end).
function sessionEnded(message, { logout = false } = {}) {
  if (_sessionEnding) return;
  _sessionEnding = true;
  const w = document.getElementById('idle-warn'); if (w) w.remove();
  const done = () => { live('disconnect'); ME = null; location.hash = ''; _sessionEnding = false; renderLogin(message); };
  if (!logout) return done();
  const base = (window.WORKSHOPONE_API_BASE || '').replace(/\/+$/, '');
  fetch(base + '/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {}).finally(done);
}

setInterval(() => {
  const mins = ME && ME.sessionPolicy && ME.sessionPolicy.idleMinutes;
  if (!mins) return;
  const idle = idleMs();
  if (idle >= mins * 60000) return sessionEnded(`Signed out after ${mins} minutes without activity.`, { logout: true });
  if (idle >= mins * 60000 - 60000 && !_idleWarned) {
    _idleWarned = true;
    const bar = document.createElement('div');
    bar.id = 'idle-warn';
    bar.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;background:#b45309;color:#fff;padding:10px 16px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.25);font-weight:600';
    bar.textContent = 'No activity — you will be signed out in about a minute. Move the mouse or press a key to stay signed in.';
    document.body.appendChild(bar);
  }
}, 15000);

// The apostrophe matters as much as the double quote. Several buttons carry their data as JSON in a
// SINGLE-quoted attribute (data-shelf-item='…'), so an item called "Driver's seat" used to end the
// attribute early — and a name crafted to do that on purpose could add a script to the page of
// everyone who opened the list.
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
function wireJobPicker(root, idp, prefill) {
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
  if (prefill && prefill.job_id) {
    pick(prefill.job_id, prefill.job_no || ('Job #' + prefill.job_id), prefill.vehicle || prefill.asset_code || '', prefill.asset_id || '');
  }
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
// RBAC — a module's clearance level for the signed-in user (from the permission matrix).
const RANKL = { none: 0, view: 1, edit: 2, full: 3 };
const rankL = (l) => RANKL[l] || 0;
const isAdmin = () => !!(ME && ME.roles && ME.roles.includes('admin'));
const canView = (m) => isAdmin() || (ME && ME.permissions ? rankL(ME.permissions[m]) >= 1 : true);
const canEdit = (m) => isAdmin() || (ME && ME.permissions ? rankL(ME.permissions[m]) >= 2 : true);
// May the signed-in user do this? Asked by CAPABILITY (src/lib/capabilities.js), never by role
// name, so a role an admin creates works on every screen. Some actions also sit behind a section's
// router gate on the server, which wants EDIT clearance on that section; the server says which
// (capNeeds), and a button whose request the server would refuse is not shown.
const canDo = (...caps) => !!ME && caps.some((c) => (ME.caps || []).includes(c)
  && (!(ME.capNeeds && ME.capNeeds[c]) || canEdit(ME.capNeeds[c])));
const qs = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => [...r.querySelectorAll(s)];

// ---- Real-time: ONE global subscriber auto-refreshes the active view when the data
// it shows changes. audit.record broadcasts a generic 'data_changed' {entity,action,...}
// for every mutation, so no view needs to wire its own listeners.
const LIVE_ENTITY_ROUTES = {
  store_item: ['generalstock', 'stores', 'stockissues', 'stockcockpit', 'stocktake'], issue: ['stockissues', 'stores', 'stockcockpit', 'stocktake'],
  count_session: ['stores'], store_count: ['stores'], store_reorder: ['stores'],
  item_category: ['stores', 'generalstock', 'stockissues', 'stocktake'],
  mrn: ['stores', 'matreq', 'purchasing', 'stockcockpit', 'stocktake'], mrn_lines: ['purchasing', 'stockcockpit', 'stocktake'], grn: ['stores', 'purchasing', 'stockcockpit', 'stocktake'], mtn: ['stores'], stock_count: ['oil', 'stocktake', 'stores'],
  product: ['oil', 'stockcockpit', 'stocktake', 'stores'], product_price: ['oil', 'stocktake', 'stores'], stock_ledger: ['oil', 'stockissues', 'stockcockpit', 'stocktake', 'stores'],
  filter_stock: ['filters', 'filterstock', 'stockcockpit', 'stocktake', 'stores'], filter_price: ['filters', 'stocktake', 'stores'], filter_xref: ['filters', 'stocktake', 'stores'], service_job: ['filters', 'services'],
  job_card: ['jobs', 'jobrequests'], job_request: ['jobrequests', 'jobs'], job_daily_work: ['dailywork', 'jobs'],
  mechanic_attendance: ['dailywork'], workday_signoff: ['dailywork'], job_reopen_request: ['jobs'],
  battery: ['batteries', 'stockcockpit', 'stocktake', 'stores'], asset: ['assets'],
  mechanic: ['mechanics', 'labour', 'workshops'], labour_rate: ['labour', 'mechanics'], mechanic_alias: ['mechanics'],
  workshop: ['workshops', 'access', 'jobs'],
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
  PARTIALLY_CLOSED: 'violet', CLOSED: 'green', REJECTED: 'red',
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
function wireAssetPicker(root, onPick) {
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
        it.onmousedown = (e) => { e.preventDefault(); input.value = it.dataset.code; hidden.value = it.dataset.id; close(); if (onPick) onPick(it.dataset.id, it.dataset.code); };
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

// The server decides what a good password is (src/lib/password_policy.js) and says so in /auth/me;
// the screens only help before the request is sent. 10 is the server's default.
const passwordMinLength = () => (ME && ME.passwordPolicy && ME.passwordPolicy.minLength) || 10;
const passwordHint = () => `Use at least ${passwordMinLength()} characters. A few unrelated words work well — avoid your username, the company or workshop name, and common passwords.`;

function forceChangePassword() {
  modal('Set a new password', `
    <p class="muted">Your account requires a new password before you can continue.</p>
    <p class="muted">${esc(passwordHint())}</p>
    ${field('New password', 'new_password', { type: 'password' })}
    ${field('Confirm password', 'confirm', { type: 'password' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Set password</button></div>`,
    (body, close) => {
      qs('#s', body).onclick = async () => {
        const d = formData(body);
        if (!d.new_password || d.new_password.length < passwordMinLength()) return toast(`At least ${passwordMinLength()} characters`, 'err');
        if (d.new_password !== d.confirm) return toast('Passwords do not match', 'err');
        try {
          await api('/auth/change-password', { method: 'POST', body: { new_password: d.new_password } });
          if (ME) ME.mustChangePassword = false;
          toast('Password updated'); close(); render();
          if (ME && ME.mfaSetupRequired) forceMfaSetup();
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
  ['jobs', '🔧', 'Job Cards'],
  ['field', '📍', 'Field Work'],
  ['operations', '🧭', 'Operations'],
  ['dailywork', '📅', 'Daily Work'],
  ['services', '🛠️', 'Service Records'],
  ['lubecapacities', '🛢️', 'Lubricant Capacities'],
  ['assets', '🚜', 'Assets'],
  ['labour', '💵', 'Labour Rates'],
  ['stores', '📦', 'Stores'],
  ['serviceplan', '🗓️', 'Service & Filter Plan'],
  ['projects', '🏗️', 'Projects'],
  ['aliases', '🔗', 'Alias Queue'],
  ['attention', '⚠️', 'Needs Attention'],
  ['progress', '📆', 'Daily Progress'],
  ['teardown', '📉', 'Cost Teardown'],
  ['purchasing', '🛒', 'Purchasing'],
  ['tbrequests', '🛞', 'Tyre & Battery Requests'],
  ['tyrebattery', '🛞', 'Tyre & Battery'],
  ['reports', '📈', 'Reports'],
  ['workshops', '🏭', 'Workshops', 'workshops'],
  ['access', '🔐', 'Access Control', 'admin'],
];
// Which permission module governs each nav item's visibility (dashboard always on). Each of the 22
// sections has its own switch (access plan, Part 1) — the server checks the same one.
const NAV_MODULE = {
  assets: 'assets', jobs: 'jobs', jobrequests: 'jobrequests', field: 'field', operations: 'operations', dailywork: 'dailywork', services: 'services', lubecapacities: 'lubecapacities',
  labour: 'labour', stores: 'stores', stocktake: 'stores', stockcockpit: 'stores', generalstock: 'stores', oil: 'oil', batteries: 'batteries', filters: 'filters', filterstock: 'filters',
  projects: 'projects', aliases: 'aliases', attention: 'attention', progress: 'progress',
  teardown: 'teardown', reports: 'reports', tyrebattery: 'tyrebattery',
  // The request screen belongs to whoever may raise one. The ledger above stays on 'reports',
  // because reading what was issued is a different question from being allowed to issue it.
  tbrequests: 'tb_request',
  // Enforced, so the two buying officers see this and nobody else does. Which of the two
  // channels each one sees is decided by the server from their role — the nav only opens the door.
  purchasing: 'purchasing',
  matreq: 'stores', stockissues: 'stores', serviceplan: 'serviceplan',
};
function navVisible(n) {
  if (n[3] === 'admin') return canDo('access.manage', 'users.manage');
  if (n[3] === 'workshops') return canDo('workshops.manage', 'mechanics.move');
  if (n[0] === 'dashboard') return true;
  // Job Cards holds the job requests too (its Requests tab).
  if (n[0] === 'jobs') return canView('jobs') || canView('jobrequests');
  const m = NAV_MODULE[n[0]];
  return !m || canView(m);
}

// Sidebar grouping — headings shown above each cluster (a group with no visible item is hidden).
const NAV_GROUP_ORDER = ['Operations', 'Inventory', 'Procurement', 'Fleet', 'Analysis', 'Admin'];
const NAV_GROUP = {
  dashboard: 'Operations', jobs: 'Operations', jobrequests: 'Operations', field: 'Operations', operations: 'Operations', dailywork: 'Operations', services: 'Operations', lubecapacities: 'Operations',
  stores: 'Inventory', stocktake: 'Inventory',
  purchasing: 'Procurement', tbrequests: 'Procurement',
  assets: 'Fleet', serviceplan: 'Fleet',
  reports: 'Analysis', attention: 'Analysis', progress: 'Analysis', teardown: 'Analysis', tyrebattery: 'Analysis', aliases: 'Analysis', projects: 'Analysis', labour: 'Analysis',
  workshops: 'Admin', access: 'Admin',
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
      <button class="sm" id="mymfa" title="Signed-in devices and two-factor sign-in">🔐 Security${ME && ME.mfaEnabled ? ' ✓' : ''}</button>
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
    <p class="muted">${esc(passwordHint())} Other devices signed in to your account will be signed out.</p>
    ${field('Current password', 'current_password', { type: 'password' })}
    ${field('New password', 'new_password', { type: 'password' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Update</button></div>`,
    (body, close) => { qs('#s', body).onclick = async () => { try { await api('/auth/change-password', { method: 'POST', body: formData(body) }); toast('Password updated'); close(); } catch (e) { toast(e.message, 'err'); } }; });
  qs('#mysig').onclick = mySignatureModal;
  qs('#mymfa').onclick = securityModal;
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
    // Stage 3: a record of another workshop is not an error, just not yours to open.
    content.innerHTML = e.data && e.data.other_workshop
      ? `<div class="card"><p><b>${esc(e.message)}</b></p><p class="muted">Each workshop sees its own work. Ask head office if you need it.</p><a class="btn sm" href="javascript:history.back()">← Back</a></div>`
      : `<div class="card"><p class="err">Error: ${esc(e.message)}</p></div>`;
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
// Somebody whose only role is buying. Not "can see purchasing" — a manager can see it too, and
// should still get the workshop dashboard.
const isPurchasingOnly = () => !!(ME && ME.roles && ME.roles.length
  && ME.roles.every((r) => r === 'purchase_head_office' || r === 'purchase_local'));

routes.dashboard = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = sp.get('month'), asset = sp.get('asset');
  // The workshop dashboard is job costs, stock value and vehicle history — none of which is any of
  // a purchasing officer's business, and none of which answers the only question they have.
  if (isPurchasingOnly()) return dashPurchasing(c);
  if (month && asset) return dashVehicleMonth(c, month, asset);
  if (month) return dashMonthAssets(c, month);
  return dashMain(c);
};

// What is waiting to be bought, and how much of it is theirs. Refreshes itself: the dashboard is
// in LIVE_AGG_ROUTES, so an MRN approved anywhere in the building lands here without a reload.
async function dashPurchasing(c) {
  c.innerHTML = pageHeader('Purchasing', 'What has been approved and still has to be bought.')
    + '<div id="dp" class="muted">Loading…</div>';
  let counts; let d;
  try {
    counts = await api('/purchasing/counts');
    d = await api('/purchasing/queue?tab=to_buy&limit=12');
  } catch (e) { qs('#dp', c).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }

  const mine = d.channels.map((s) => (s === 'head_office' ? 'Head Office' : 'Local Purchase')).join(' + ') || 'none yet';
  qs('#dp', c).innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr));margin-bottom:14px">
      <div class="card"><div class="stat"><div class="n">${counts.to_buy}</div><div class="l">On your list</div></div></div>
      <div class="card"><div class="stat"><div class="n">${counts.unassigned}</div><div class="l">Not yet assigned</div></div></div>
      <div class="card"><div class="stat"><div class="n">${counts.bought}</div><div class="l">Bought</div></div></div>
      <div class="card"><div class="stat"><div class="l">You buy</div><div>${esc(mine)}</div></div></div>
    </div>
    <div class="toolbar" style="margin:0 0 8px"><h2 style="margin:0">Waiting to be bought</h2><div class="spacer"></div>
      <button class="sm primary" onclick="location.hash='#/purchasing'">Open the list</button></div>
    <div id="dpl"></div>`;

  qs('#dpl', c).innerHTML = d.rows.length ? tableWrap(
    [{ label: 'Needed', width: '96px' }, { label: 'Request', width: '104px' },
    { label: 'Vehicle', width: '120px' }, { label: 'Item', cls: 'desc-col' }, { label: 'Qty', num: true, width: '70px' }],
    d.rows.map((r) => `<tr>
      <td>${r.required_date ? esc(String(r.required_date).slice(0, 10)) : '<span class="muted">—</span>'}</td>
      <td class="mono">${esc(r.mrn_no || '')}${r.is_new ? ' <span class="badge amber">new</span>' : ''}</td>
      <td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="desc-col">${esc(r.description || '')}</td>
      <td class="num">${num(r.qty)}${r.unit ? ' ' + esc(r.unit) : ''}</td></tr>`), { scroll: true })
    : `<div class="card"><p class="muted">Nothing waiting${counts.unassigned
      ? ` — but ${counts.unassigned} item(s) have not been given to an officer yet.` : '.'}</p></div>`;
}

// Managers' time is precious: their dashboard leads with what needs their sign-off.
function renderPendingApprovals(pa) {
  if (!pa || !pa.is_approver) return '';
  // An MRN awaiting approval carries its estimated value, and says so when it is above this
  // person's approval limit (it waits for someone with a higher one).
  const mrnWorth = (m) => (m.value == null ? '' : ` · about ${esc(money(m.value))}${m.unpriced ? ` <span class="muted">(${m.unpriced} without a price)</span>` : ''}`);
  const mrnRow = (m, action) => `<div class="cost-line"><a href="#/stores?tab=mrn&id=${m.id}"><b>MRN ${esc(m.mrn_no)}</b> · ${esc(idLabel(m) || 'general')} · ${m.lines} item(s)${mrnWorth(m)}${m.requested_by ? ' · by ' + esc(m.requested_by) : ''}${m.certified_by ? ' · certified ' + esc(m.certified_by) : ''}</a>${m.over_limit
    ? `<span class="badge amber" title="Needs: ${esc((m.who_can || []).join(', '))}">Above your limit</span>`
    : `<span class="badge ${action === 'Approve' ? 'blue' : 'amber'}">${action} →</span>`}</div>`;
  // How long it has been waiting, from the request date. An approver deciding between a card raised
  // this morning and one raised three weeks ago was previously shown neither — just a number and a
  // vehicle — so the queue gave no sense of what was overdue.
  const waited = (d) => {
    const day = String(d || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
    const days = Math.floor((Date.now() - new Date(day + 'T00:00:00').getTime()) / 86400000);
    if (!Number.isFinite(days) || days < 0) return `<span class="muted"> · ${esc(day)}</span>`;
    // Only worth calling out once it has actually sat there; "0 days" is noise on today's request.
    const age = days >= 3 ? ` <span class="badge ${days >= 14 ? 'red' : 'amber'}">${days} days</span>` : '';
    return `<span class="muted"> · requested ${esc(day)}</span>${age}`;
  };
  const jobRow = (j, action) => `<div class="cost-line"><a href="#/jobs/${j.id}"><b>${esc(j.job_no)}</b> · ${esc(idLabel(j) || '—')}${waited(j.requested_at)}</a><span class="badge amber">${action} →</span></div>`;
  const jrRow = (r, action) => `<div class="cost-line"><a href="#/jobrequests/${r.id}"><b>${esc(r.jr_no)}</b> · ${esc(idLabel(r) || '—')}${r.description ? ' · ' + esc(String(r.description).slice(0, 40)) : ''}${r.requested_by ? ' · by ' + esc(r.requested_by) : ''}</a><span class="badge ${action === 'Approve' ? 'blue' : 'amber'}">${action} →</span></div>`;
  const section = (title, items, rowFn) => (items && items.length) ? `<div style="margin-top:6px"><div class="muted" style="font-size:12px;margin:6px 0 2px">${title} (${items.length})</div>${items.map(rowFn).join('')}</div>` : '';
  const body = [
    section('Job requests awaiting your <b>certification</b>', pa.jr_certify || [], (r) => jrRow(r, 'Certify')),
    section('Job requests awaiting your <b>approval</b>', pa.jr_approve || [], (r) => jrRow(r, 'Approve')),
    section('MRNs awaiting your <b>certification</b>', pa.certify || [], (m) => mrnRow(m, 'Certify')),
    section('MRNs awaiting your <b>approval</b>', pa.approve || [], (m) => mrnRow(m, 'Approve')),
    section('Job cards awaiting <b>transport approval</b>', pa.transport || [], (j) => jobRow(j, 'Approve')),
    section('Job cards awaiting <b>operations approval</b>', pa.ops || [], (j) => jobRow(j, 'Approve')),
    section('Days waiting for <b>sign-off</b>', pa.signoff || [], (d) => `<div class="cost-line"><a href="#/dailywork?att=${esc(d.date)}${d.workshop_id ? '&att_ws=' + d.workshop_id : ''}"><b>${esc(d.date)}</b>${d.workshop_name ? ` · ${esc(d.workshop_name)}` : ''} · attendance &amp; daily work${d.red_count ? ` · <span style="color:var(--red)">${d.red_count} red</span>` : ''}</a><span class="badge ${d.red_count ? 'red' : 'amber'}">Sign off →</span></div>`),
    section('Job cards asking to be <b>reopened</b>', pa.reopen || [], (r) => `<div class="cost-line"><a href="#/jobs/${r.job_id}"><b>${esc(r.job_no)}</b> · ${esc(idLabel(r) || '—')} · ${esc(String(r.reason || '').slice(0, 60))}${r.requested_by_name ? ' · by ' + esc(r.requested_by_name) : ''}${waited(r.requested_at)}</a><span class="badge amber">Decide →</span></div>`),
  ].join('');
  return `<div class="card section" style="border-left:4px solid ${pa.total ? 'var(--red)' : 'var(--green)'}">
    <div class="toolbar" style="margin:0"><h3 style="margin:0">⚡ Pending Your Approval</h3><div class="spacer"></div><span class="badge ${pa.total ? 'red' : 'green'}">${pa.total} pending</span></div>
    ${pa.total ? body : '<span class="muted">✓ Nothing awaiting your approval — you\'re all caught up.</span>'}</div>`;
}

async function dashMain(c) {
  const [d, mc, pa] = await Promise.all([
    api('/reports/dashboard'), canView('reports') ? api('/reports/monthly') : null,
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
  if (canView('jobs')) opStats.push(`<a class="card stat" href="#/jobs" style="text-decoration:none"><span class="n">${d.open_jobs_count}</span><span class="l">Open Job Cards</span></a>
      <a class="card stat" href="#/jobs?status=CLOSED" style="text-decoration:none"><span class="n">${d.closed_this_month_count}</span><span class="l">Closed This Month</span></a>
      <a class="card stat" href="#/teardown" style="text-decoration:none"><span class="n">${d.awaiting_price.length}</span><span class="l">Awaiting Price (blocked)</span></a>
      ${(d.partly_closed || []).length ? `<a class="card stat" href="#/jobs?status=PARTIALLY_CLOSED" style="text-decoration:none"><span class="n">${d.partly_closed.length}</span><span class="l">Partly Closed — awaiting prices</span></a>` : ''}
      ${d.ready_to_close ? `<a class="card stat" href="#/jobs?tab=ready" style="text-decoration:none"><span class="n" style="color:var(--green)">${d.ready_to_close}</span><span class="l">Ready to close — nothing missing</span></a>` : ''}
      ${d.field_down != null ? `<a class="card stat" href="#/field" style="text-decoration:none"><span class="n" style="color:${d.field_down ? 'var(--red)' : 'inherit'}">${d.field_down}</span><span class="l">Machines down in the field</span></a>` : ''}`);
  // Attendance (W3): today's tally and the days still to sign off — only while attendance is on.
  const at = d.attendance_today;
  if (at && canView('dailywork')) opStats.push(`<a class="card stat" href="#/dailywork" style="text-decoration:none"><span class="n" style="color:${at.red_count ? 'var(--red)' : 'inherit'}">${at.before_start ? '—' : at.red_count}</span><span class="l">Today's tally — ${at.before_start ? 'not started' : (at.red_count ? 'red' : 'nothing red')}</span></a>
      ${at.unsigned_days.length ? `<a class="card stat" href="#/dailywork?att=${esc(at.unsigned_days[0].date)}${at.unsigned_days[0].workshop_id ? '&att_ws=' + at.unsigned_days[0].workshop_id : ''}" style="text-decoration:none"><span class="n">${at.unsigned_days.length}</span><span class="l">Days to sign off</span></a>` : ''}`);
  if (canView('oil')) opStats.push(`<a class="card stat" href="#/oil?tab=forecast" style="text-decoration:none"><span class="n">${d.low_stock_oil.length}</span><span class="l">Low-stock Lubricants</span></a>`);
  if (canView('batteries')) opStats.push(`<a class="card stat" href="#/batteries" style="text-decoration:none"><span class="n">${d.batteries_warranty.length}</span><span class="l">Battery Warranty ≤60d</span></a>`);
  if (canView('stores') || canView('oil')) {
    opStats.push(`<div class="card stat" style="text-decoration:none"><div class="toolbar" style="margin:0 0 4px"><span class="l" style="margin:0"><b>To Reorder</b></span><div class="spacer"></div><span class="badge ${d.low_stock_oil.length ? 'amber' : 'green'}">${d.low_stock_oil.length ? 'Action needed' : 'Healthy'}</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <a class="badge" href="#/generalstock?tab=reorder" style="text-decoration:none">🧰 General Stock Reorder →</a>
        <a class="badge ${d.low_stock_oil.length ? 'amber' : ''}" href="#/oil?tab=forecast" style="text-decoration:none">🛢️ Oil: ${d.low_stock_oil.length} low →</a>
      </div></div>`);
  }
  if (opStats.length) S.push(`<div class="grid section">${opStats.join('')}</div>`);
  if (canView('attention')) S.push(`
    <div class="card section" style="border-left:4px solid ${naTotal ? 'var(--amber)' : 'var(--green)'}">
      <div class="toolbar" style="margin:0"><h3 style="margin:0">⚠ Needs Attention</h3><div class="spacer"></div><span class="badge ${naTotal ? 'amber' : 'green'}">${naTotal} flag${naTotal === 1 ? '' : 's'}</span> <a class="btn sm" href="#/attention">See all →</a></div>
      <div class="pill-row" style="margin-top:8px">
        <a class="badge ${na.service_due ? 'amber' : ''}" href="#/attention" style="text-decoration:none">Service due: ${na.service_due || 0}</a>
        <a class="badge ${na.unusual_consumption ? 'red' : ''}" href="#/attention" style="text-decoration:none">Unusual consumption: ${na.unusual_consumption || 0}</a>
        <a class="badge ${na.duplicate_mrn ? 'red' : ''}" href="#/attention" style="text-decoration:none">Duplicate MRN: ${na.duplicate_mrn || 0}</a>
        <a class="badge ${na.grn_price_spikes ? 'red' : ''}" href="#/attention" style="text-decoration:none">GRN price spikes: ${na.grn_price_spikes || 0}</a>
        <a class="badge ${na.integrity_issues ? 'red' : ''}" href="#/attention" style="text-decoration:none">Integrity issues: ${na.integrity_issues || 0}</a>
        <a class="badge ${na.vehicle_conflicts ? 'amber' : ''}" href="#/attention" style="text-decoration:none">Vehicles with 2+ open jobs: ${na.vehicle_conflicts || 0}</a>
      </div>
    </div>`);
  const G = [];
  if (canView('jobs')) G.push(`<div class="card"><h3>Jobs by Status</h3>${tableWrap([{ label: 'Status' }, { label: 'Count', num: true }], statusRows)}</div>
      <div class="card"><div class="toolbar" style="margin:0 0 6px"><h3 style="margin:0">Awaiting Price — blocking closure</h3><div class="spacer"></div><a class="sm" href="#/teardown">Cost Teardown →</a></div>
        ${d.awaiting_price.length ? d.awaiting_price.map((j) => `<div class="cost-line"><a href="#/jobs/${j.id}">${esc(j.job_no)} · ${esc(j.asset_code || '?')}</a><span class="badge red">${j.missing_count} unpriced</span></div>`).join('') : '<span class="muted">None — all priced</span>'}
      </div>`);
  if (canView('reports')) G.push(`<div class="card"><h3>This-Month Cost by Project</h3>${projBars}</div>`);
  if (canView('oil')) G.push(`<div class="card"><div class="toolbar" style="margin:0 0 6px"><h3 style="margin:0">Low-stock Lubricants</h3><div class="spacer"></div><a class="sm" href="#/oil?tab=forecast">See forecast →</a></div>
        ${d.low_stock_oil.length ? d.low_stock_oil.map((p) => `<div class="cost-line"><span>${esc(p.name)}</span><span class="badge amber">${num(p.balance)} / ${num(p.reorder_level)} ${esc(p.unit)}</span></div>`).join('') : '<span class="muted">All above reorder level</span>'}
      </div>`);
  if (canView('batteries')) G.push(`<div class="card"><div class="toolbar" style="margin:0 0 6px"><h3 style="margin:0">Battery Warranty Radar</h3><div class="spacer"></div><a class="sm" href="#/batteries">See all →</a></div>
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
  if (canView('reports')) dashRenderOverview();
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
  c.innerHTML = `${pageHeader('Assets')}
    <div class="toolbar">
      <input id="asearch" type="search" placeholder="Search vehicle no / E&C / brand / type…" style="max-width:280px">
      <label style="display:flex;gap:6px;align-items:center;flex-direction:row;width:auto"><input type="checkbox" id="aregonly" checked style="width:auto"> Registered fleet only</label>
      <div class="spacer"></div>
      <span class="muted" id="acount"></span>
      <a class="btn sm" href="/api/assets/export.xlsx">⬇ Excel</a>
      ${canDo('assets.create') ? '<button class="primary" id="newasset">+ New Asset</button>' : ''}
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
      <span class="muted">${esc(a.asset.brand || '')} ${esc(a.asset.type || '')} · 📍 ${esc(a.place && a.place.key ? a.place.label : (a.current_project ? a.current_project.name : 'no project'))}</span>
      <div class="spacer"></div>
      ${canDo('assets.move') ? '<button class="sm" id="moveasset" title="The machine goes to another project or site">🚚 Move machine…</button>' : ''}
      ${canDo('assets.edit') ? '<button class="sm" id="editasset">Edit</button>' : ''}
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
        ${a.open_jobs.length ? a.open_jobs.map(assetJobLine).join('') : '<span class="muted">None open</span>'}
        ${(a.partly_closed_jobs || []).length ? `<div class="muted" style="font-size:12px;margin:8px 0 2px">Partly closed — prices still to come</div>${a.partly_closed_jobs.map(assetJobLine).join('')}` : ''}
      </div>
    </div>
    <div class="card section"><h3>Moves</h3>
      ${(a.moves || []).length ? `<ul class="timeline">${a.moves.map((m) => `<li><span class="date">${esc(m.move_date)}</span><span>${esc(m.from)} → <b>${esc(m.to)}</b>${m.note ? ` — ${esc(m.note)}` : ''}${m.moved_by ? ` <span class="muted">(${esc(m.moved_by)})</span>` : ''}</span></li>`).join('')}</ul>`
    : '<span class="muted">No moves recorded yet.</span>'}
    </div>
    <div class="card"><h3>Unified Timeline</h3>
      <ul class="timeline">${a.timeline.map((t) => `<li><span class="date">${esc(t.date || '')}</span><span class="badge ${t.kind === 'job' ? 'blue' : ''}">${esc(t.kind)}</span><span>${esc(t.ref ? t.ref + ' · ' : '')}${esc(t.description || '')}</span></li>`).join('') || '<li class="muted">No activity</li>'}</ul>
    </div>`;
  if (qs('#editasset')) qs('#editasset').onclick = () => editAssetModal(a.asset);
  if (qs('#moveasset')) qs('#moveasset').onclick = () => moveMachineModal(a.asset, a.place, () => assetDetail(c, id));
}

// Stage 7: move a machine to another project or site, from a date. Every move is kept.
async function moveMachineModal(asset, place, onDone) {
  const places = await api('/operations/places').catch(() => []);
  modal('Move ' + (asset.registration || asset.code), `
    <p class="muted" style="margin-top:0">Now at: <b>${esc(place && place.key ? place.label : 'no site set')}</b></p>
    <datalist id="mvplaces">${places.map((p) => `<option value="${esc(p.label)}">`).join('')}</datalist>
    <label>Moves to *</label><input name="to" list="mvplaces" placeholder="Project or site" autocomplete="off">
    ${field('Date of the move', 'move_date', { type: 'date', value: localNowInput().slice(0, 10) })}
    ${field('Note', 'note', { placeholder: 'e.g. low-bed, for the new contract' })}
    <div style="margin-top:14px;text-align:right"><button class="primary" id="s">Move machine</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      const p = places.find((x) => x.label === String(f.to || '').trim());
      if (!p) return toast('Choose a project or site from the list.', 'err');
      try {
        await api(`/operations/machines/${asset.id}/move`, { method: 'POST', body: { place: p.key, move_date: f.move_date, note: f.note } });
        close(); toast('Moved to ' + p.label); if (onDone) onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
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
const JOB_STATUSES = ['REQUESTED', 'APPROVED_TRANSPORT', 'APPROVED_OPERATIONS', 'IN_WORKSHOP', 'IN_PROGRESS', 'WORK_COMPLETE', 'PARTIALLY_CLOSED', 'CLOSED', 'REJECTED'];
const MONTHS = [['01', 'Jan'], ['02', 'Feb'], ['03', 'Mar'], ['04', 'Apr'], ['05', 'May'], ['06', 'Jun'], ['07', 'Jul'], ['08', 'Aug'], ['09', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec']];

// ---- Job Cards (job cards plan): one page with tabs, like Stores — the Monitor, every request
// waiting for a decision, the cards in the workshop, the cards being finished, those ready to close,
// and all the cards (src/lib/jobs_flow.js). The job request list became the Requests tab; its own
// pages (#/jobrequests/:id) stay.
const JOB_TABS = [['monitor', '📊 MONITOR'], ['requests', '📨 REQUESTS'], ['ongoing', '🛠️ ONGOING'], ['finishing', '🧾 FINISHING'],
  ['ready', '✅ READY TO CLOSE'], ['all', '🗂️ ALL CARDS']];
const CARD_TABS = ['ongoing', 'finishing', 'ready', 'all'];
routes.jobs = async (c, params) => {
  if (params[0]) return jobDetail(c, params[0]);
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tabs = JOB_TABS.filter(([t]) => !CARD_TABS.includes(t) || canView('jobs'));
  // Old links to the list (#/jobs?status=…, the dashboard's) still open it.
  let tab = sp.get('tab') || (['q', 'year', 'month', 'status', 'workshop_id'].some((k) => sp.get(k)) ? 'all' : 'monitor');
  if (!tabs.some(([t]) => t === tab)) tab = 'monitor';
  c.innerHTML = `${pageHeader('Job Cards')}<div class="toolbar" style="margin-bottom:10px">${tabs
    .map(([t, l]) => `<button class="sm ${t === tab ? 'primary' : ''}" onclick="location.hash='#/jobs?tab=${t}'">${l}</button>`).join('')}</div>
    <div id="jobsbody"><div class="muted">Loading…</div></div>`;
  const body = qs('#jobsbody');
  if (tab === 'requests') return jobsRequests(body, sp);
  if (tab === 'all') return jobsAllCards(body, sp);
  if (tab === 'ongoing') return jobsOngoing(body, sp);
  if (tab === 'finishing') return jobsFinishing(body, sp);
  if (tab === 'ready') return jobsReady(body, sp);
  return jobsMonitor(body);
};

const monCard = (n, label, href, tone, note) => `<a class="card stat" href="${href}" style="text-decoration:none">
    <span class="n"${tone && n ? ` style="color:var(--${tone})"` : ''}>${n}</span><span class="l">${esc(label)}</span>${note ? `<span class="muted" style="font-size:11px">${esc(note)}</span>` : ''}</a>`;

async function jobsMonitor(body) {
  const m = await api('/job-flow/monitor');
  const rq = m.requests;
  const R = (step) => `#/jobs?tab=requests&step=${step}`;
  const O = (show) => `#/jobs?tab=ongoing&show=${show}`;
  const F = (show) => `#/jobs?tab=finishing&show=${show}`;
  const req = [
    ...(m.sees.jobrequests ? [monCard(rq.to_certify, 'Job requests to certify', R('to_certify'), 'amber'), monCard(rq.to_approve, 'Job requests to approve', R('to_approve'), 'amber')] : []),
    ...(m.sees.jobs ? [monCard(rq.transport, 'Cards waiting for transport approval', R('transport'), 'amber'), monCard(rq.operations, 'Cards waiting for operations approval', R('operations'), 'amber')] : []),
  ];
  const w = m.workshop; const f = m.finishing; const x = m.watch;
  body.innerHTML = `
    <p class="muted" style="margin-top:0">What is waiting at each step${m.scope && m.scope.label ? ` — ${esc(m.scope.label)}` : ''}. Click a number to see the jobs.</p>
    <h3 style="margin:10px 0 6px">Requests</h3><div class="grid">${req.join('')}</div>
    ${w ? `<h3 style="margin:14px 0 6px">In the workshop <span class="muted" style="font-weight:400;font-size:12px">— ${w.all} card${w.all === 1 ? '' : 's'}</span></h3><div class="grid">
      ${monCard(w.worked_today, 'Worked on today', O('today'), 'green')}
      ${monCard(w.idle_1_2, 'Not attended 1–2 days', O('idle'), 'amber')}
      ${monCard(w.idle_3, 'Not attended 3+ days', O('red'), 'red')}
      ${monCard(w.not_started, 'Not started', O('not_started'), 'blue')}
      ${monCard(w.waiting_parts, 'Waiting for parts', O('parts'), 'amber', 'from the Stores list')}
      ${monCard(w.no_reason, 'No reason given', O('no_reason'), 'red', '3+ days, nobody said why')}
      ${w.idle_mechanics != null ? monCard(w.idle_mechanics, 'Mechanics present, on no job', '#/dailywork', 'amber', 'from today\'s attendance') : ''}
    </div>` : ''}
    ${f ? `<h3 style="margin:14px 0 6px">Finishing</h3><div class="grid">
      ${monCard(f.work_done, 'Work done, something missing', F('work_done'), 'amber')}
      ${monCard(f.partly_closed, 'Partly closed — waiting for prices', F('partly_closed'), 'amber')}
      ${monCard(f.ready, 'Ready to close', '#/jobs?tab=ready', 'green', 'nothing missing')}
    </div>` : ''}
    ${x ? `<h3 style="margin:14px 0 6px">Watch</h3><div class="grid">
      ${x.breakdowns_down != null ? monCard(x.breakdowns_down, 'Breakdowns still down', '#/field', 'red') : ''}
      ${monCard(x.reopen, 'Reopen requests waiting', R('reopen'), 'amber')}
      ${monCard(x.stuck, 'Requested long ago, never moved', canDo('jobs.triage') ? '#/jobreview' : R('stuck'), 'red')}
      ${monCard(x.two_open, 'Vehicles with 2 open cards', '#/jobs?tab=all', 'red')}
    </div>` : ''}`;
}

const JOB_REQ_STEPS = [['open', 'Waiting for a decision'], ['to_certify', 'To certify'], ['to_approve', 'To approve'],
  ['transport', 'Transport approval'], ['operations', 'Operations approval'], ['reopen', 'Reopen requests'],
  ['stuck', 'Never moved'], ['approved', 'Approved'], ['rejected', 'Rejected']];
const JOB_REQ_KIND = { jr: ['blue', 'Request'], card: ['', 'Card'], reopen: ['amber', 'Reopen'] };

async function jobsRequests(body, sp) {
  const cur = { step: sp.get('step') || 'open', q: sp.get('q') || '', type: sp.get('type') || '' };
  if (!JOB_REQ_STEPS.some(([k]) => k === cur.step)) cur.step = 'open';
  body.innerHTML = `
    <div class="toolbar">
      <input id="jrf-q" type="search" placeholder="Search number, vehicle, work, who asked…" value="${esc(cur.q)}" style="max-width:280px">
      <select id="jrf-type" style="max-width:140px"><option value="">Repair &amp; service</option>
        <option value="repair" ${cur.type === 'repair' ? 'selected' : ''}>Repair</option><option value="service" ${cur.type === 'service' ? 'selected' : ''}>Service</option></select>
      <a class="btn sm" id="jrf-xls" href="#">⬇ Excel</a>
      <div class="spacer"></div>
      ${canDo('jobrequests.create') ? '<button class="sm" id="jrf-newjr">+ New job request</button>' : ''}
      ${canDo('jobs.create') ? '<button class="sm" id="jrf-newjob">+ New job card</button>' : ''}
    </div>
    <div class="pill-row" id="jrf-steps" style="margin:0 0 10px;flex-wrap:wrap;gap:6px"></div>
    <div id="jrf-bulk" class="toolbar" style="display:none;margin:0 0 8px"></div>
    <div id="jrf-table"><div class="muted">Loading…</div></div>`;
  const qstr = () => {
    const p = new URLSearchParams({ tab: 'requests', step: cur.step });
    if (cur.q) p.set('q', cur.q);
    if (cur.type) p.set('type', cur.type);
    return p;
  };
  const load = async () => {
    const p = qstr();
    history.replaceState(null, '', '#/jobs?' + p.toString());
    p.delete('tab');
    qs('#jrf-xls', body).href = '/api/job-flow/requests/export.xlsx?' + p.toString();
    let d;
    try { d = await api('/job-flow/requests?' + p.toString()); } catch (e) { qs('#jrf-table', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    qs('#jrf-steps', body).innerHTML = JOB_REQ_STEPS.map(([k, l]) => `<button class="sm ${k === cur.step ? 'primary' : ''}" data-step="${k}">${esc(l)}${d.counts[k] != null ? ` <span class="badge">${d.counts[k]}</span>` : ''}</button>`).join('');
    qsa('[data-step]', body).forEach((b) => { b.onclick = () => { cur.step = b.dataset.step; load(); }; });
    const rows = d.rows;
    const bulkable = (r) => r.can && (r.can.transport || r.can.operations);
    const anyBulk = rows.some(bulkable);
    const act = (r) => {
      const b = [];
      if (r.can.certify) b.push(`<button class="sm primary" data-act="certify" data-i="${r.kind}:${r.id}">✍ Certify</button>`);
      if (r.can.approve) b.push(`<button class="sm primary" data-act="approve" data-i="${r.kind}:${r.id}">✅ Approve</button>`);
      if (r.can.transport) b.push(`<button class="sm primary" data-act="transport" data-i="${r.kind}:${r.id}">✓ Approve (transport)</button>`);
      if (r.can.operations) b.push(`<button class="sm primary" data-act="operations" data-i="${r.kind}:${r.id}">✓ Approve (operations)</button>`);
      if (r.can.reopen) b.push(`<button class="sm primary" data-act="reopen" data-i="${r.kind}:${r.id}">↩ Reopen</button><button class="sm" data-act="refuse" data-i="${r.kind}:${r.id}">Refuse</button>`);
      if (r.can.reject) b.push(`<button class="sm danger" data-act="reject" data-i="${r.kind}:${r.id}">Reject</button>`);
      if (r.can.review) b.push('<a class="btn sm" href="#/jobreview">🧹 Review…</a>');
      if (r.step === 'approved' && r.job_id) b.push(`<a class="btn sm" href="#/jobs/${r.job_id}">Card ${esc(r.job_no || '')}</a>`);
      return b.join(' ');
    };
    qs('#jrf-table', body).innerHTML = rows.length ? tableWrap(
      (anyBulk ? [{ label: '<input type="checkbox" id="jrf-all" title="Select all">', html: true, width: '32px' }] : []).concat([
        { label: 'No', width: '118px' }, { label: 'Vehicle', cls: 'desc-col', width: '110px' }, { label: 'Work', cls: 'desc-col' },
        { label: 'Waiting for', width: '400px' }, { label: '', width: '190px' }]),
      rows.map((r) => `<tr>
        ${anyBulk ? `<td>${bulkable(r) ? `<input type="checkbox" class="jrf-chk" data-i="${r.kind}:${r.id}">` : ''}</td>` : ''}
        <td><a href="${r.link}"><b>${esc(r.no)}</b></a><br><span class="badge ${JOB_REQ_KIND[r.kind][0]}">${JOB_REQ_KIND[r.kind][1]}</span>${r.imported ? ' <span class="badge">imported</span>' : ''}<br><span class="muted" style="font-size:12px">${esc(r.date || '')}</span></td>
        <td class="desc-col">${esc(idLabel(r) || '—')}</td>
        <td class="desc-col"><span class="badge ${r.type === 'service' ? 'blue' : ''}">${esc(r.type || '')}</span>${r.priority === 'urgent' ? ' <span class="badge red">urgent</span>' : ''} ${esc(String(r.description || '').slice(0, 120))}
          ${r.reason ? `<br><span class="muted" style="font-size:12px">Why reopen: ${esc(r.reason)}</span>` : ''}
          <br><span class="muted" style="font-size:12px">Asked by ${esc(r.requested_by || '—')}</span></td>
        <td>${esc(r.waiting_for)}${r.days != null ? ` <span class="badge ${r.days > 7 ? 'red' : (r.days > 2 ? 'amber' : '')}">${r.days} day${r.days === 1 ? '' : 's'}</span>` : ''}${r.reject_reason && r.step === 'rejected' ? `<br><span class="muted" style="font-size:12px">${esc(r.reject_reason)}</span>` : ''}${r.note ? `<br><span class="muted" style="font-size:12px">${esc(r.note)}</span>` : ''}
          <div style="margin-top:4px">${roadBar(r)}</div></td>
        <td>${act(r)}</td></tr>`), { scroll: true, fit: true, noHScroll: true })
      : `<div class="card"><p class="muted">${cur.step === 'open' ? 'Nothing is waiting for a decision.' : 'Nothing here.'}</p></div>`;
    const byI = new Map(rows.map((r) => [r.kind + ':' + r.id, r]));
    qsa('[data-act]', body).forEach((btn) => { btn.onclick = () => jobReqAction(btn.dataset.act, byI.get(btn.dataset.i), load); });
    // Several cards approved at once (a job request is signed one by one, on its own).
    const bulk = qs('#jrf-bulk', body);
    const picked = () => qsa('.jrf-chk:checked', body).map((x) => byI.get(x.dataset.i));
    const showBulk = () => {
      const n = picked().length;
      bulk.style.display = n ? 'flex' : 'none';
      bulk.innerHTML = n ? `<span><b>${n}</b> card${n === 1 ? '' : 's'} chosen</span><button class="sm primary" id="jrf-bulk-ok">✓ Approve the chosen cards</button>` : '';
      if (n) qs('#jrf-bulk-ok', body).onclick = async () => {
        const rs = picked();
        if (!confirm(`Approve ${rs.length} card${rs.length === 1 ? '' : 's'}?`)) return;
        let ok = 0; const bad = [];
        for (const [to, list] of [['APPROVED_TRANSPORT', rs.filter((r) => r.can.transport)], ['APPROVED_OPERATIONS', rs.filter((r) => r.can.operations)]]) {
          if (!list.length) continue;
          try {
            const res = await api('/jobs/bulk-transition', { method: 'POST', body: { ids: list.map((r) => r.id), to } });
            ok += res.success_count; bad.push(...(res.failed || []).map((f) => `${f.job_no || f.id}: ${f.error}`));
          } catch (e) { bad.push(e.message); }
        }
        if (bad.length) alert(`${ok} approved. Not approved:\n${bad.slice(0, 8).join('\n')}`); else toast(`${ok} approved`);
        load();
      };
    };
    qsa('.jrf-chk', body).forEach((x) => { x.onchange = showBulk; });
    if (qs('#jrf-all', body)) qs('#jrf-all', body).onchange = (e) => { qsa('.jrf-chk', body).forEach((x) => { x.checked = e.target.checked; }); showBulk(); };
    showBulk();
  };
  let deb;
  qs('#jrf-q', body).oninput = (e) => { cur.q = e.target.value.trim(); clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#jrf-type', body).onchange = (e) => { cur.type = e.target.value; load(); };
  if (qs('#jrf-newjr', body)) qs('#jrf-newjr', body).onclick = newJobRequestModal;
  if (qs('#jrf-newjob', body)) qs('#jrf-newjob', body).onclick = newJobModal;
  await load();
}

// ---- Ongoing (job cards plan, Part 2): every card in the workshop, attended or not ----------------
// A card is attended on a day with a daily-work line; idle days are working days (Sundays skipped).
// "Waiting for parts" comes from the Stores list; any other reason a supervisor gives.
const JOB_REASONS = [['waiting_mechanic', 'Waiting for a mechanic'], ['waiting_parts', 'Waiting for parts (not in Stores)'],
  ['outside_repair', 'Outside repair'], ['waiting_decision', 'Waiting for a decision'], ['vehicle_away', 'Vehicle not here'], ['other', 'Other']];
const ONGOING_SHOW = [['all', 'All in the workshop'], ['today', 'Worked today'], ['idle', 'Not attended'], ['red', '3+ days'],
  ['not_started', 'Not started'], ['parts', 'Waiting for parts'], ['no_reason', 'No reason given'], ['field', 'Field jobs']];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function attendedChip(r) {
  if (r.state === 'today') return `<span class="badge green">🟢 Worked today</span>`;
  if (r.state === 'not_started') return `<span class="badge ${r.idle >= 3 ? 'red' : ''}">⚪ Not started${r.idle ? ' · ' + plural(r.idle, 'day') : ''}</span>`;
  return `<span class="badge ${r.state === 'red' ? 'red' : 'amber'}">${r.state === 'red' ? '🔴' : '🟡'} Not attended ${plural(r.idle, 'day')}</span>`;
}
function whyNot(r) {
  const out = [];
  if (r.parts && r.parts.waiting) {
    out.push(`<div><a href="#/stores?tab=flow&sub=lines&step=open&q=${encodeURIComponent(r.job_no)}"><span class="badge amber">🔧 Waiting for parts (${r.parts.waiting})</span></a>
      <div class="muted" style="font-size:11.5px">${r.parts.lines.map((l) => `${esc(l.description)} — ${esc(FLOW_STEP_LABEL[l.step] || l.step)}`).join('<br>')}</div></div>`);
  }
  if (r.reason) out.push(`<div><b>${esc(r.reason.label)}</b>${r.reason.note ? ': ' + esc(r.reason.note) : ''}<div class="muted" style="font-size:11.5px">${esc(r.reason.set_by || '')} · ${esc(String(r.reason.set_at || '').slice(0, 10))}</div></div>`);
  if (r.needs_reason) out.push('<span class="badge red">No reason given</span>');
  return out.join('') || '<span class="muted">—</span>';
}
function reasonModal(job, done) {
  modal('Why is ' + job.job_no + ' not being worked on?', `
    ${field('Reason', 'reason', { type: 'select', options: JOB_REASONS.map(([value, label]) => ({ value, label })) })}
    ${field('Note (needed for "Other")', 'note')}
    <p class="muted" style="font-size:12px;margin:4px 0 0">Parts waiting in Stores show by themselves. A reason stays until work is recorded again.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      try { await api(`/job-flow/jobs/${job.id}/reason`, { method: 'POST', body: formData(b) }); toast('Saved'); close(); done && done(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function jobsOngoing(body, sp) {
  const cur = { show: sp.get('show') || 'all', q: sp.get('q') || '', type: sp.get('type') || '' };
  if (!ONGOING_SHOW.some(([k]) => k === cur.show)) cur.show = 'all';
  body.innerHTML = `
    <div class="toolbar">
      <input id="og-q" type="search" placeholder="Search job no, vehicle, work…" value="${esc(cur.q)}" style="max-width:260px">
      <select id="og-type" style="max-width:140px"><option value="">Repair &amp; service</option>
        <option value="repair" ${cur.type === 'repair' ? 'selected' : ''}>Repair</option><option value="service" ${cur.type === 'service' ? 'selected' : ''}>Service</option></select>
      <div class="spacer"></div>
      ${canView('progress') || canView('reports') ? '<a class="btn sm" href="/api/reports/ongoing-jobs.xlsx">⬇ Excel</a><a class="btn sm" href="/api/reports/ongoing-jobs.html" target="_blank">🖨 PDF</a>' : ''}
    </div>
    <p class="muted" style="margin:0 0 8px;font-size:12.5px">Worked on = a daily-work line that day. Days count working days (not Sundays). 3 days or more is red.</p>
    <div class="pill-row" id="og-show" style="margin:0 0 10px;flex-wrap:wrap;gap:6px"></div>
    <div id="og-table"><div class="muted">Loading…</div></div>`;
  const load = async () => {
    const p = new URLSearchParams({ tab: 'ongoing', show: cur.show });
    if (cur.q) p.set('q', cur.q);
    if (cur.type) p.set('type', cur.type);
    history.replaceState(null, '', '#/jobs?' + p.toString());
    p.delete('tab');
    let d;
    try { d = await api('/job-flow/ongoing?' + p.toString()); } catch (e) { qs('#og-table', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    qs('#og-show', body).innerHTML = ONGOING_SHOW.map(([k, l]) => `<button class="sm ${k === cur.show ? 'primary' : ''}" data-show="${k}">${esc(l)} <span class="badge ${k === 'no_reason' && d.counts[k] ? 'red' : ''}">${d.counts[k]}</span></button>`).join('');
    qsa('[data-show]', body).forEach((b) => { b.onclick = () => { cur.show = b.dataset.show; load(); }; });
    const jobCell = (r) => `<a href="${r.link}"><b>${esc(r.job_no)}</b></a> · ${esc(idLabel(r) || '—')}${r.field ? ` <span class="badge ${r.breakdown ? 'red' : 'amber'}">${r.breakdown ? 'Breakdown' : 'Field'}</span>` : ''}${r.workshop_code && wsMulti() ? ` <span class="badge">${esc(r.workshop_code)}</span>` : ''}
          <div style="font-size:12.5px">${r.type === 'service' ? '<span class="badge blue">service</span> ' : ''}${esc(String(r.description || '').slice(0, 120))}</div>
          <div class="muted" style="font-size:12px">open ${plural(r.days_open || 0, 'day')}</div>`;
    const workedCell = (r) => `${attendedChip(r)}
          <div class="muted" style="font-size:12px">${r.state === 'today' ? esc(r.today_mechanics || '') : (r.last_worked ? `Last: ${esc(r.last_worked)} · ${esc(r.last_mechanics || '')}` : 'No work yet')}${r.hours ? ` · ${num(r.hours)} h so far` : ''}</div>`;
    const whyCell = (r) => `${whyNot(r)}${r.can.reason ? `<div style="margin-top:4px"><button class="sm" data-why="${r.id}">Say why…</button></div>` : ''}`;
    // On a phone, one box a card: what matters (worked on, why not) is never off the screen.
    if (d.rows.length && window.matchMedia('(max-width: 700px)').matches) {
      qs('#og-table', body).innerHTML = d.rows.map((r) => `<div class="card" style="padding:10px 12px;margin:0 0 8px">${jobCell(r)}
        <div style="margin-top:6px">${workedCell(r)}</div><div style="margin-top:6px">${whyCell(r)}</div></div>`).join('');
    } else qs('#og-table', body).innerHTML = d.rows.length ? tableWrap(
      [{ label: 'Job', cls: 'desc-col' }, { label: 'Worked on', width: '34%' }, { label: 'Why not', width: '33%' }],
      d.rows.map((r) => `<tr><td class="desc-col">${jobCell(r)}</td><td>${workedCell(r)}</td><td>${whyCell(r)}</td></tr>`), { scroll: true, fit: true, noHScroll: true })
      : `<div class="card"><p class="muted">${cur.show === 'all' ? 'No cards in the workshop.' : 'None here.'}</p></div>`;
    qsa('[data-why]', body).forEach((b) => { b.onclick = () => reasonModal(d.rows.find((r) => String(r.id) === b.dataset.why), load); });
  };
  let deb;
  qs('#og-q', body).oninput = (e) => { cur.q = e.target.value.trim(); clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#og-type', body).onchange = (e) => { cur.type = e.target.value; load(); };
  await load();
}

// On the card's own page: is it being worked on, why not, and every reason given.
function attendedPanel(a, job, reload) {
  if (!a || (!a.ongoing && !(a.history || []).length)) return '';
  const hist = (a.history || []).length ? `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:12px">Reasons given (${a.history.length})</summary>
      ${a.history.map((h) => `<div class="cost-line"><span><b>${esc(h.label)}</b>${h.note ? ': ' + esc(h.note) : ''}</span><span class="muted">${esc(h.set_by || '')} · ${esc(String(h.set_at || '').slice(0, 16))}</span></div>`).join('')}</details>` : '';
  if (!a.ongoing) return `<div class="card section">${hist}</div>`;
  const tone = a.state === 'today' ? 'var(--green)' : (a.state === 'red' || a.late ? 'var(--red)' : 'var(--amber)');
  return `<div class="card section" style="border-left:4px solid ${tone}">
    <div class="toolbar" style="margin:0 0 6px"><b>🛠 Worked on?</b> ${attendedChip(a)}<div class="spacer"></div>${a.can.reason ? '<button class="sm" id="jwhy">Say why…</button>' : ''}</div>
    <div class="muted" style="font-size:12.5px">${a.state === 'today' ? 'Today: ' + esc(a.today_mechanics || '') : (a.last_worked ? `Last worked ${esc(a.last_worked)} · ${esc(a.last_mechanics || '')}` : 'No work recorded yet')}${a.hours ? ` · ${num(a.hours)} h so far` : ''}</div>
    ${a.state === 'today' ? '' : `<div style="margin-top:6px">${whyNot(a)}</div>`}
    ${hist}</div>`;
}

// ---- Finishing and Ready to close (job cards plan, Part 3) -----------------------------------------
// A card whose work is done stays in Finishing while the close check finds something missing — the
// Close button's own check — and moves to Ready to close by itself when the last thing is added.
// Nothing closes by itself: a person closes it, one card or several together.
const FIN_SHOW = [['all', 'All'], ['work_done', 'Work done'], ['partly_closed', 'Partly closed']];
const FIN_MISSING = [['received', 'Parts not received'], ['shelf', 'Parts not handed over'], ['part_price', 'Part prices'],
  ['oil_price', 'Oil prices'], ['general_price', 'Item prices'], ['service_labour', 'Service charge'], ['labour_rate', 'Labour rates'],
  ['outside_value', 'Outside repair value'], ['no_work', 'No work recorded']];
// Where each missing thing is put right: the Stores list for parts, Labour Rates for a rate, else the card.
function finLink(kind, r) {
  const q = encodeURIComponent(r.job_no);
  if (kind === 'received' && canView('stores')) return `#/stores?tab=flow&sub=lines&step=open&q=${q}`;
  if (kind === 'shelf' && canView('stores')) return `#/stores?tab=flow&sub=lines&step=ready&q=${q}`;
  if (kind === 'labour_rate' && canView('labour')) return '#/labour';
  return r.link;
}
const finStatus = (r) => (r.status === 'PARTIALLY_CLOSED' ? '<span class="badge amber">Partly closed</span>' : '<span class="badge blue">Work done</span>');
function finJobCell(r) {
  return `<a href="${r.link}"><b>${esc(r.job_no)}</b></a> · ${esc(idLabel(r) || '—')}${r.workshop_code && wsMulti() ? ` <span class="badge">${esc(r.workshop_code)}</span>` : ''}
    <div style="font-size:12.5px">${r.type === 'service' ? '<span class="badge blue">service</span> ' : ''}${esc(String(r.description || '').slice(0, 120))}</div>
    <div class="muted" style="font-size:12px">${finStatus(r)} ${r.since ? `since ${esc(r.since)} · ${plural(r.days || 0, 'day')}` : ''}${r.partly_by ? ` · by ${esc(r.partly_by)}` : ''}</div>
    ${r.note ? `<div class="muted" style="font-size:12px">Note: ${esc(r.note)}</div>` : ''}`;
}
function finMissingCell(r) {
  return r.missing.groups.map((g) => `<div style="margin:0 0 4px"><a href="${finLink(g.kind, r)}"><span class="badge ${g.kind === 'received' || g.kind === 'shelf' ? 'amber' : 'red'}">${esc(g.label)} (${g.n})</span></a>
    <div class="muted" style="font-size:11.5px">${g.items.map(esc).join('<br>')}${g.n > g.items.length ? `<br>… and ${g.n - g.items.length} more` : ''}</div></div>`).join('');
}

async function jobsFinishing(body, sp) {
  const cur = { show: sp.get('show') || 'all', q: sp.get('q') || '', type: sp.get('type') || '' };
  body.innerHTML = `
    <div class="toolbar">
      <input id="fin-q" type="search" placeholder="Search job no, vehicle, work…" value="${esc(cur.q)}" style="max-width:260px">
      <select id="fin-type" style="max-width:140px"><option value="">Repair &amp; service</option>
        <option value="repair" ${cur.type === 'repair' ? 'selected' : ''}>Repair</option><option value="service" ${cur.type === 'service' ? 'selected' : ''}>Service</option></select>
      <div class="spacer"></div><a class="btn sm" href="#/jobs?tab=ready">✅ Ready to close <span class="badge" id="fin-ready">…</span></a>
    </div>
    <p class="muted" style="margin:0 0 8px;font-size:12.5px">Work is done, but something is still missing. Click a red or amber label to fix it. When nothing is missing, the card moves to Ready to close by itself.</p>
    <div class="pill-row" id="fin-show" style="margin:0 0 10px;flex-wrap:wrap;gap:6px"></div>
    <div id="fin-table"><div class="muted">Loading…</div></div>`;
  const load = async () => {
    const p = new URLSearchParams({ tab: 'finishing', show: cur.show });
    if (cur.q) p.set('q', cur.q);
    if (cur.type) p.set('type', cur.type);
    history.replaceState(null, '', '#/jobs?' + p.toString());
    p.delete('tab');
    let d;
    try { d = await api('/job-flow/finishing?' + p.toString()); } catch (e) { qs('#fin-table', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    qs('#fin-ready', body).textContent = d.counts.ready;
    // The missing kinds show only when some card has them.
    const pills = FIN_SHOW.concat(FIN_MISSING.filter(([k]) => d.counts[k] || k === cur.show));
    qs('#fin-show', body).innerHTML = pills.map(([k, l]) => `<button class="sm ${k === cur.show ? 'primary' : ''}" data-show="${k}">${esc(l)} <span class="badge">${d.counts[k] || 0}</span></button>`).join('');
    qsa('[data-show]', body).forEach((b) => { b.onclick = () => { cur.show = b.dataset.show; load(); }; });
    const empty = `<div class="card"><p class="muted">${cur.show === 'all' ? 'No card is waiting for anything. ' + (d.counts.ready ? `<a href="#/jobs?tab=ready">${plural(d.counts.ready, 'card')} ready to close →</a>` : '') : 'None here.'}</p></div>`;
    if (d.rows.length && window.matchMedia('(max-width: 700px)').matches) {
      qs('#fin-table', body).innerHTML = d.rows.map((r) => `<div class="card" style="padding:10px 12px;margin:0 0 8px">${finJobCell(r)}
        <div style="margin-top:6px"><b style="font-size:12.5px">Still missing:</b>${finMissingCell(r)}</div></div>`).join('');
    } else qs('#fin-table', body).innerHTML = d.rows.length ? tableWrap(
      [{ label: 'Job', cls: 'desc-col' }, { label: 'Still missing', width: '48%' }],
      d.rows.map((r) => `<tr><td class="desc-col">${finJobCell(r)}</td><td>${finMissingCell(r)}</td></tr>`), { scroll: true, fit: true, noHScroll: true })
      : empty;
  };
  let deb;
  qs('#fin-q', body).oninput = (e) => { cur.q = e.target.value.trim(); clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#fin-type', body).onchange = (e) => { cur.type = e.target.value; load(); };
  await load();
}

async function jobsReady(body, sp) {
  const cur = { q: sp.get('q') || '', type: sp.get('type') || '' };
  body.innerHTML = `
    <div class="toolbar">
      <input id="rdy-q" type="search" placeholder="Search job no, vehicle, work…" value="${esc(cur.q)}" style="max-width:260px">
      <select id="rdy-type" style="max-width:140px"><option value="">Repair &amp; service</option>
        <option value="repair" ${cur.type === 'repair' ? 'selected' : ''}>Repair</option><option value="service" ${cur.type === 'service' ? 'selected' : ''}>Service</option></select>
    </div>
    <p class="muted" style="margin:0 0 8px;font-size:12.5px">Nothing is missing on these cards. Check the cost, then close one card, or tick several and close them together. Closing fixes the final cost.</p>
    <div id="rdy-bulk" class="toolbar" style="display:none;margin:0 0 8px"></div>
    <div id="rdy-table"><div class="muted">Loading…</div></div>`;
  const load = async () => {
    const p = new URLSearchParams({ tab: 'ready' });
    if (cur.q) p.set('q', cur.q);
    if (cur.type) p.set('type', cur.type);
    history.replaceState(null, '', '#/jobs?' + p.toString());
    p.delete('tab');
    let d;
    try { d = await api('/job-flow/ready?' + p.toString()); } catch (e) { qs('#rdy-table', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    const rows = d.rows;
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const anyClose = rows.some((r) => r.can.close);
    const other = rows.some((r) => r.cost.other);
    const costCols = [['labour', 'Labour'], ['parts', 'Parts'], ['outside', 'Outside'], ['oil', 'Oil'], ['general', 'General']].concat(other ? [['other', 'Other']] : []);
    const act = (r) => (r.can.close ? `<button class="sm primary" data-close="${r.id}">🔒 Close</button>`
      : (r.over_limit ? `<span class="badge amber" title="Your approval limit is ${esc(money(r.over_limit.limit))}">Over your limit</span>` : ''));
    const costLines = (r) => costCols.filter(([k]) => r.cost[k]).map(([k, l]) => `${l} ${money(r.cost[k])}`).join(' · ');
    if (rows.length && window.matchMedia('(max-width: 700px)').matches) {
      qs('#rdy-table', body).innerHTML = rows.map((r) => `<div class="card" style="padding:10px 12px;margin:0 0 8px">${finJobCell(r)}
        <div style="margin-top:6px"><b>${money(r.cost.total)}</b> <span class="muted" style="font-size:12px">${costLines(r)}</span></div>
        <div style="margin-top:6px;display:flex;align-items:center;gap:14px">${act(r)}${r.can.close ? `<label style="display:inline-flex;align-items:center;gap:6px;margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:inherit">
          <input type="checkbox" class="rdy-chk" data-id="${r.id}" style="min-height:0;width:22px;height:22px;margin:0"> Tick to close with others</label>` : ''}</div></div>`).join('')
        + `<div class="card" style="padding:10px 12px"><b>All ready cards: ${money(d.total)}</b></div>`;
    } else qs('#rdy-table', body).innerHTML = rows.length ? tableWrap(
      (anyClose ? [{ label: '<input type="checkbox" id="rdy-all" title="Select all">', html: true, width: '32px' }] : [])
        .concat([{ label: 'Job', cls: 'desc-col' }], costCols.map(([, l]) => ({ label: l, num: true })), [{ label: 'Total', num: true }, { label: '', width: '120px' }]),
      rows.map((r) => `<tr>${anyClose ? `<td>${r.can.close ? `<input type="checkbox" class="rdy-chk" data-id="${r.id}">` : ''}</td>` : ''}
        <td class="desc-col">${finJobCell(r)}</td>
        ${costCols.map(([k]) => `<td class="num">${r.cost[k] ? money(r.cost[k]) : '<span class="muted">—</span>'}</td>`).join('')}
        <td class="num"><b>${money(r.cost.total)}</b></td><td>${act(r)}</td></tr>`)
        .concat([`<tr><td colspan="${(anyClose ? 2 : 1) + costCols.length}"><b>All ready cards</b></td><td class="num"><b>${money(d.total)}</b></td><td></td></tr>`]),
      { scroll: true, fit: true, noHScroll: true })
      : `<div class="card"><p class="muted">No card is ready to close. <a href="#/jobs?tab=finishing">See what is still missing →</a></p></div>`;
    const report = (res) => {
      const bad = (res.failed || []).map((f) => `${f.job_no || f.id}: ${f.error}`);
      if (bad.length) alert(`${res.success_count} closed. Not closed:\n${bad.slice(0, 8).join('\n')}`); else toast(`✓ ${plural(res.success_count, 'card')} closed`);
    };
    qsa('[data-close]', body).forEach((b) => { b.onclick = async () => {
      const r = byId.get(b.dataset.close);
      if (!confirm(`Close ${r.job_no}?\nFinal cost: ${money(r.cost.total)}`)) return;
      try { await api(`/jobs/${r.id}/transition`, { method: 'POST', body: { to: 'CLOSED' } }); toast(`✓ ${r.job_no} closed`); }
      catch (e) { toast(e.message, 'err'); }
      load();
    }; });
    // Several cards closed at once; the total is shown before the person confirms (JC-D8).
    const bulk = qs('#rdy-bulk', body);
    const picked = () => qsa('.rdy-chk:checked', body).map((x) => byId.get(x.dataset.id));
    const showBulk = () => {
      const rs = picked();
      const sum = rs.reduce((t, r) => t + r.cost.total, 0);
      bulk.style.display = rs.length ? 'flex' : 'none';
      bulk.innerHTML = rs.length ? `<span><b>${plural(rs.length, 'card')}</b> chosen · total <b>${money(sum)}</b></span><button class="sm primary" id="rdy-bulk-ok">🔒 Close the chosen cards</button>` : '';
      if (rs.length) qs('#rdy-bulk-ok', body).onclick = async () => {
        if (!confirm(`Close ${plural(rs.length, 'card')}?\nTotal: ${money(sum)}\n\n${rs.slice(0, 15).map((r) => `${r.job_no}  ${money(r.cost.total)}`).join('\n')}${rs.length > 15 ? '\n…' : ''}`)) return;
        try { report(await api('/jobs/bulk-transition', { method: 'POST', body: { ids: rs.map((r) => r.id), to: 'CLOSED' } })); }
        catch (e) { toast(e.message, 'err'); }
        load();
      };
    };
    qsa('.rdy-chk', body).forEach((x) => { x.onchange = showBulk; });
    if (qs('#rdy-all', body)) qs('#rdy-all', body).onchange = (e) => { qsa('.rdy-chk', body).forEach((x) => { x.checked = e.target.checked; }); showBulk(); };
    showBulk();
  };
  let deb;
  qs('#rdy-q', body).oninput = (e) => { cur.q = e.target.value.trim(); clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#rdy-type', body).onchange = (e) => { cur.type = e.target.value; load(); };
  await load();
}

// One decision on one row: each goes to the route that already makes it.
function jobReqAction(act, r, done) {
  if (!r) return;
  if (r.kind === 'jr') return jobRequestSignModal({ ...r, jr_no: r.no }, act === 'certify' ? 'certify' : (act === 'approve' ? 'approve' : 'reject'), done);
  if (act === 'transport' || act === 'operations') {
    if (!confirm(`Approve ${r.no} (${act})?`)) return;
    return api(`/jobs/${r.id}/transition`, { method: 'POST', body: { to: act === 'transport' ? 'APPROVED_TRANSPORT' : 'APPROVED_OPERATIONS' } })
      .then(() => { toast(`✓ ${r.no} approved`); done(); }).catch((e) => toast(e.message, 'err'));
  }
  if (act === 'reopen') {
    if (!confirm(`Reopen ${r.no}? It goes back to In progress.`)) return;
    return api(`/jobs/reopen-requests/${r.id}/approve`, { method: 'POST', body: {} })
      .then(() => { toast(`✓ ${r.no} reopened`); done(); }).catch((e) => toast(e.message, 'err'));
  }
  const refuse = act === 'refuse';
  modal(`${refuse ? 'Refuse the reopen of' : 'Reject'} ${r.no}`, `
    ${field(refuse ? 'Why not? *' : 'Reason *', 'reason')}
    <div style="margin-top:12px;text-align:right"><button class="primary danger" id="s">${refuse ? 'Refuse' : 'Reject'}</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      const why = String(formData(b).reason || '').trim();
      if (!why) return toast('Give a reason', 'err');
      try {
        if (refuse) await api(`/jobs/reopen-requests/${r.id}/refuse`, { method: 'POST', body: { note: why } });
        else await api(`/jobs/${r.id}/transition`, { method: 'POST', body: { to: 'REJECTED', reason: why } });
        toast(refuse ? 'Reopen refused' : `${r.no} rejected`); close(); done();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function jobsAllCards(c, sp) {
  const cur = { q: sp.get('q') || '', year: sp.get('year') || '', month: sp.get('month') || '', status: sp.get('status') || '',
    workshop: sp.get('workshop_id') || '' };
  // Workshop filter and tag (Stage 2): only once there is more than one workshop. The filter is for
  // those who see every workshop; someone kept to their own (Stage 3) has nothing to choose.
  const wsd = wsMulti() ? await workshopsData() : null;
  const wsFilter = wsd && (ME.seesAllWorkshops !== false || (ME.workshopsSeen || []).length > 1);

  const nowY = new Date().getFullYear();
  const years = [];
  for (let y = nowY + 1; y >= 2020; y--) years.push(y);
  // Partial close and reopen requests (W2) — switched on or off by the admin.
  const closeCfg = await api('/jobs/close-settings').catch(() => ({ partial_close_enabled: false }));
  const partialOn = !!closeCfg.partial_close_enabled;

  c.innerHTML = `
    <div class="toolbar">
      <input id="jq" type="search" placeholder="Search job no or vehicle…" value="${esc(cur.q)}" style="max-width:240px">
      <select id="jyear" style="max-width:120px"><option value="">All years</option>${years.map((y) => `<option ${String(y) === cur.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <select id="jmonth" style="max-width:140px"><option value="">All months</option>${MONTHS.map(([v, l]) => `<option value="${v}" ${v === cur.month ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="jstatus" style="max-width:200px"><option value="">All statuses</option>${JOB_STATUSES.map((s) => `<option ${s === cur.status ? 'selected' : ''}>${s}</option>`).join('')}${cur.status && !JOB_STATUSES.includes(cur.status) ? `<option value="${esc(cur.status)}" selected>${cur.status === 'APPROVED_OPERATIONS,IN_WORKSHOP' ? 'Approved, not started' : esc(cur.status.replace(/,/g, ' or '))}</option>` : ''}</select>
      ${wsFilter ? `<select id="jws" style="max-width:220px"><option value="">All workshops</option>${wsd.workshops.filter((w) => !ME.workshopsSeen || ME.workshopsSeen.includes(w.id)).map((w) => `<option value="${w.id}" ${String(w.id) === cur.workshop ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>` : ''}
      <button class="sm" id="jclear">Clear</button>
      <button class="sm" id="jfilter-backlog" style="background:#fff3cd;color:#856404;border-color:#ffeeba;font-weight:600" title="Filter to backlog cards awaiting triage / approval">⚡ Backlog: Requested</button>
      <span class="muted" id="jcount"></span>
      <div class="spacer"></div>
      ${canDo('jobs.create') ? '<button class="primary" id="newjob">+ New Job Card</button>' : ''}
      ${canDo('jobs.breakdown') ? '<button class="danger" id="newbd" title="A machine stopped at a site: open a field job card now">🚨 Report a breakdown</button>' : ''}
      ${canDo('jobs.triage') ? '<a class="btn sm" href="#/jobreview" title="REQUESTED cards that hold their vehicle but never moved">🧹 Review stuck cards</a>' : ''}
      ${canDo('jobs.settings') ? `<button class="sm" id="jpartial" title="Partial close, full close check and reopen requests">⚙ Partial close: ${partialOn ? 'on' : 'off'}</button>` : ''}
    </div>
    <div id="jbulk-tray" class="card" style="display:none;background:#f0fdf4;border:1px solid #86efac;margin-bottom:12px;padding:10px 14px;align-items:center;gap:10px;flex-wrap:wrap">
      <span id="jbulk-count" style="font-weight:700;color:#166534">0 cards selected</span>
      <div class="spacer"></div>
      ${canDo('jobs.approve_transport') ? '<button class="sm primary" id="jbulk-btn-trans" style="background:#2563eb">✓ Approve Transport</button>' : ''}
      ${canDo('jobs.approve_operations') ? '<button class="sm primary" id="jbulk-btn-ops" style="background:#059669">✓ Approve Operations</button>' : ''}
      ${canDo('jobs.assign_workshop') ? '<button class="sm" id="jbulk-btn-ws">In Workshop</button>' : ''}${canDo('jobs.start') ? '<button class="sm" id="jbulk-btn-prog">In Progress</button>' : ''}
      ${canDo('jobs.reject') ? '<button class="sm danger" id="jbulk-btn-reject">✕ Reject</button>' : ''}
      <button class="sm" id="jbulk-btn-clear">Clear</button>
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
    if (qs('#jws') && qs('#jws').value) p.set('workshop_id', qs('#jws').value);
    return p;
  };

  const updateBulkTray = () => {
    const chks = qsa('.jrow-chk:checked', c);
    const tray = qs('#jbulk-tray', c);
    const cnt = qs('#jbulk-count', c);
    if (!tray || !cnt) return;
    if (chks.length > 0) {
      tray.style.display = 'flex';
      cnt.textContent = `${chks.length} card${chks.length === 1 ? '' : 's'} selected`;
    } else {
      tray.style.display = 'none';
    }
  };

  const load = async () => {
    const p = buildParams();
    const query = p.toString();
    // Keep the URL shareable/bookmarkable without triggering a full re-render.
    history.replaceState(null, '', '#/jobs?tab=all' + (query ? '&' + query : ''));
    const list = await api('/jobs' + (query ? '?' + query : ''));
    const canCloseDate = canDo('jobs.close_on_date');
    // The same permission jobstate.canReopen checks on the server.
    const canReopenJob = canDo('jobs.reopen');
    const rows = list.map((j) => `<tr>
      <td style="text-align:center;width:36px"><input type="checkbox" class="jrow-chk" data-id="${j.id}" data-status="${j.status}" data-jobno="${esc(j.job_no)}"></td>
      <td><a href="#/jobs/${j.id}">${esc(j.job_no)}</a>${wsd && j.workshop_code ? `<br><span class="badge" title="${esc(wsName(wsd, j.workshop_id))}">${esc(j.workshop_code)}</span>` : ''}</td>
      <td class="desc-col">${vehText(j) ? `<span class="stamp">${esc(vehText(j))}</span>` : '—'}</td>
      <td class="desc-col" title="${esc(j.description || '')}">${esc(j.description || '')}</td>
      <td><span class="badge ${j.type === 'service' ? 'blue' : ''}">${esc(j.type)}</span>${j.field ? ` <span class="badge ${j.breakdown ? 'red' : 'amber'}" title="Repaired at the site">${j.breakdown ? 'Breakdown' : 'Field'}</span>` : ''}</td>
      <td>${statusBadge(j.status)}</td>
      <td class="desc-col">${esc(j.project_name || '')}</td>
      <td class="num">${j.labour_cost ? money(j.labour_cost) : '—'}</td>
      <td class="num">${j.material_cost ? money(j.material_cost) : '—'}</td>
      <td class="num">${money(j.total_cost)}</td>
      <td class="muted">${esc((j.requested_at || '').slice(0, 10))}</td>
      <td>${canCloseDate && !['CLOSED', 'REJECTED', 'PARTIALLY_CLOSED'].includes(j.status)
        ? `<button class="sm" data-closedate="${j.id}" data-jobno="${esc(j.job_no)}" title="Close this card on a chosen (past) date">📅 Close…</button>`
        : (['CLOSED', 'PARTIALLY_CLOSED'].includes(j.status)
          ? (partialOn
            ? (canDo('jobs.reopen_request') ? `<button class="sm" data-reopenreq="${j.id}" data-jobno="${esc(j.job_no)}" title="Ask for this job card to be reopened">↩ Request reopen…</button>` : '')
            : (canReopenJob ? `<button class="sm danger" data-reopen="${j.id}" data-jobno="${esc(j.job_no)}" data-closed="${esc((j.completed_at || j.closed_at || '').slice(0, 10))}" title="Reopen this closed job card">↩ Reopen…</button>` : ''))
          : '')}</td></tr>`);
    const labTotal = list.reduce((s, j) => s + (Number(j.labour_cost) || 0), 0);
    const matTotal = list.reduce((s, j) => s + (Number(j.material_cost) || 0), 0);
    qs('#jcount').textContent = list.length ? `${list.length}${list.length === 500 ? '+' : ''} job${list.length === 1 ? '' : 's'}${labTotal ? ' · labour ' + money(labTotal) : ''}${matTotal ? ' · material ' + money(matTotal) : ''}` : '';
    // fit-table + wrapping text columns → the whole table fits the window at any size (no
    // horizontal scroll); the box keeps its vertical scrollbar for the long list.
    qs('#jtable').innerHTML = list.length
      ? tableWrap([
        { label: '<input type="checkbox" id="jselect-all" title="Select / Deselect all visible">', width: '36px', html: true },
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

    const selAll = qs('#jselect-all', c);
    if (selAll) {
      selAll.onchange = () => {
        qsa('.jrow-chk', c).forEach((cb) => { cb.checked = selAll.checked; });
        updateBulkTray();
      };
    }
    qsa('.jrow-chk', c).forEach((cb) => {
      cb.onchange = () => {
        if (!cb.checked && selAll) selAll.checked = false;
        updateBulkTray();
      };
    });
    updateBulkTray();

    qsa('[data-closedate]', c).forEach((b) => b.onclick = () => closeOnDateModal(b.dataset.closedate, b.dataset.jobno, load));
    qsa('[data-reopen]', c).forEach((b) => b.onclick = () => reopenJobModal(
      { id: b.dataset.reopen, job_no: b.dataset.jobno, completed_at: b.dataset.closed }, load));
    qsa('[data-reopenreq]', c).forEach((b) => b.onclick = () => reopenRequestModal({ id: b.dataset.reopenreq, job_no: b.dataset.jobno }, load));
  };
  if (qs('#jpartial')) qs('#jpartial').onclick = () => partialCloseSwitchModal(partialOn);

  const executeBulkTransition = async (targetStatus) => {
    const checkedBoxes = qsa('.jrow-chk:checked', c);
    const ids = checkedBoxes.map((cb) => Number(cb.dataset.id));
    if (!ids.length) return toast('Please select at least one job card', 'err');

    let reason = null;
    if (targetStatus === 'REJECTED') {
      reason = prompt(`Enter rejection reason for ${ids.length} selected job card(s):`);
      if (reason === null) return;
      if (!reason.trim()) return toast('Rejection reason is required', 'err');
    } else {
      const actionLabel = targetStatus.replace(/_/g, ' ');
      if (!confirm(`Are you sure you want to transition ${ids.length} selected job card(s) to "${actionLabel}"?`)) return;
    }

    try {
      const res = await api('/jobs/bulk-transition', {
        method: 'POST',
        body: { ids, to: targetStatus, reason }
      });
      if (res.fail_count === 0) {
        toast(`✓ Transitioned ${res.success_count} job card(s) to ${targetStatus}`, 'ok');
      } else {
        const failMsgs = (res.failed || []).map((f) => `Job #${f.id}: ${f.error}`).slice(0, 5).join('\n');
        alert(`Bulk update summary:\n✓ ${res.success_count} updated\n✕ ${res.fail_count} skipped/failed:\n\n${failMsgs}${res.fail_count > 5 ? '\n...' : ''}`);
      }
      await load();
    } catch (err) {
      toast(err.message || 'Bulk transition failed', 'err');
    }
  };

  if (qs('#jbulk-btn-trans', c)) qs('#jbulk-btn-trans', c).onclick = () => executeBulkTransition('APPROVED_TRANSPORT');
  if (qs('#jbulk-btn-ops', c)) qs('#jbulk-btn-ops', c).onclick = () => executeBulkTransition('APPROVED_OPERATIONS');
  if (qs('#jbulk-btn-ws', c)) qs('#jbulk-btn-ws', c).onclick = () => executeBulkTransition('IN_WORKSHOP');
  if (qs('#jbulk-btn-prog', c)) qs('#jbulk-btn-prog', c).onclick = () => executeBulkTransition('IN_PROGRESS');
  if (qs('#jbulk-btn-reject', c)) qs('#jbulk-btn-reject', c).onclick = () => executeBulkTransition('REJECTED');
  if (qs('#jbulk-btn-clear', c)) qs('#jbulk-btn-clear', c).onclick = () => {
    qsa('.jrow-chk', c).forEach((cb) => { cb.checked = false; });
    if (qs('#jselect-all', c)) qs('#jselect-all', c).checked = false;
    updateBulkTray();
  };

  let deb;
  qs('#jq').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#jq').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(deb); load(); } };
  qs('#jyear').onchange = load;
  qs('#jmonth').onchange = load;
  qs('#jstatus').onchange = load;
  if (qs('#jws')) qs('#jws').onchange = load;
  qs('#jclear').onclick = () => { qs('#jq').value = ''; qs('#jyear').value = ''; qs('#jmonth').value = ''; qs('#jstatus').value = ''; if (qs('#jws')) qs('#jws').value = ''; load(); };
  if (qs('#jfilter-backlog')) {
    qs('#jfilter-backlog').onclick = () => {
      qs('#jstatus').value = 'REQUESTED';
      qs('#jyear').value = '';
      qs('#jmonth').value = '';
      qs('#jq').value = '';
      load();
    };
  }
  if (qs('#newjob')) qs('#newjob').onclick = newJobModal;
  if (qs('#newbd')) qs('#newbd').onclick = breakdownModal;
  await load();
}

// ---- Daily Work (day-by-day review of job_daily_work)
routes.dailywork = async (c) => {
  const days = await api('/daily-work/days'); // [{date, entries, jobs, hours}] newest first
  if (!days.length) {
    c.innerHTML = `${pageHeader('Daily Work')}<div id="att-card"></div><div class="card"><p class="muted">No daily work has been logged yet.</p></div>`;
    await attendanceCard(qs('#att-card', c), { onChanged: () => render() });
    return;
  }
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  let date = sp.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = days[0].date; // default = most recent day with work

  const initialMonth = date.slice(0, 7);

  c.innerHTML = `${pageHeader('Daily Work')}
    <div id="att-card"></div>
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
      <div id="dwm-att-note" class="muted" style="font-size:12px;margin-top:6px"></div>
    </div>

    <div class="card section">
      <div class="toolbar" style="margin-top:0">
        <h3 style="margin:0">Month-Wise Daily Work Entries (Time Update)</h3>
        <span class="muted" style="font-weight:400">— check full month list &amp; update working hours</span>
        <div class="spacer"></div>
        ${canDo('dailywork.edit') ? '<button class="primary sm" id="dw-save-all-btn" disabled style="margin-right:6px">💾 Save Changes</button>' : ''}
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
        ${canDo('dailywork.add') ? '<button class="primary sm" id="dadd">+ Add Work Done</button> <button class="sm" id="dquickgrid" style="background:#e0e7ff;color:#3730a3;border-color:#c7d2fe;font-weight:600" title="Quickly enter daily timesheet hours for multiple mechanics across jobs in one table">📋 Quick Timesheet Grid</button>' : ''}
        <button class="sm" id="dprev">← Older</button>
        <input id="ddate" type="date" value="${esc(date)}" style="max-width:170px">
        <button class="sm" id="dnext">Newer →</button>
        <select id="ddays" style="max-width:260px">${days.map((d) => `<option value="${d.date}" ${d.date === date ? 'selected' : ''}>${d.date} · ${d.entries} entr${d.entries === 1 ? 'y' : 'ies'} · ${d.hours || 0}h</option>`).join('')}</select>
        <input id="dq" type="search" placeholder="Filter vehicle / mechanic…" style="max-width:220px">
      </div>
      <div id="dtable"><div class="muted">Loading…</div></div>
      <div style="margin-top:8px;text-align:right"><span class="muted" id="dsum"></span></div>
    </div>`;

  const canEdit = canDo('dailywork.edit');
  const canEditDW = canEdit;
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
    // Attendance on: hours at work, hours booked and utilisation, over the days the tally runs.
    const att = currentMonthlyData.attendance;
    const rows = list.map((l) => `<tr>
      <td><b>${esc(l.mechanic)}</b></td>
      <td class="num"><b>${num(l.total_hours)} hrs</b></td>
      <td class="num">${l.rate === 0 ? '<span class="badge blue">Staff / Foreman (Rs 0/h)</span>' : (l.rate != null ? money(l.rate) + '/h' : '<span class="badge amber">no rate</span>')}</td>
      <td class="num">${money(l.total_cost)}</td>
      <td class="num">${l.entries}</td>
      ${att ? `<td class="num">${l.attended_hours ? fmtH(l.attended_hours) : '—'}</td>
      <td class="num">${l.booked_hours ? fmtH(l.booked_hours) : '—'}</td>
      <td class="num">${l.utilisation == null ? '—' : `<span class="badge ${l.utilisation > 100 ? 'red' : l.utilisation >= 85 ? 'green' : 'amber'}">${l.utilisation}%</span>`}</td>` : ''}
    </tr>`);
    const heads = [{ label: 'Laborer / Mechanic' }, { label: 'Monthly Working Hours', num: true }, { label: 'Hourly Rate', num: true }, { label: 'Monthly Labour Cost', num: true }, { label: 'Work Entries', num: true }];
    if (att) heads.push({ label: 'Attended', num: true }, { label: 'Booked', num: true }, { label: 'Utilisation', num: true });
    qs('#dwm-table').innerHTML = list.length
      ? tableWrap(heads, rows, { scroll: true })
      : '<p class="muted">No laborer records match search.</p>';
    qs('#dwm-att-note').textContent = att
      ? (att.from ? `Attended, Booked and Utilisation count only the attendance days ${att.from} to ${att.to}. Utilisation = booked ÷ attended.` : 'Attendance has not started in this month.')
      : '';
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
    } catch (_) { }
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
    // A signed-off day (attendance) is locked: no edit controls on it.
    const canEdit = canEditDW && !data.locked;
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
    qs('#dsum').textContent = `${data.locked ? '🔒 Signed off — locked · ' : ''}${data.count} entr${data.count === 1 ? 'y' : 'ies'} · ${data.total_hours || 0} hrs · ${money(data.total_labour || 0)} labour`;
    qs('#dtable').innerHTML = data.entries.length
      ? tableWrap([{ label: 'Vehicle' }, { label: 'Job No' }, { label: 'Mechanic' }, { label: 'Description', cls: 'desc-col' }, { label: 'Hours', num: true }, { label: 'Labour (Rs)', num: true }, { label: 'Outside Labor', num: true }, { label: '', width: '78px' }], rows, { scroll: true, fit: true, noHScroll: true })
      : '<div class="card"><p class="muted">No daily work logged on this day.</p></div>';

    // After any change, repaint the day AND the month tables so every total agrees.
    const refreshAll = () => {
      const curM = qs('#dwm-month').value;
      load(qs('#ddate').value);
      loadMonthly(curM);
      loadMonthEntries(curM);
      if (attCtl) attCtl.reload();
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
  let attCtl = null;
  if (qs('#dadd')) qs('#dadd').onclick = () => addWorkDoneModal(qs('#ddate').value, (newDate) => { go(newDate); loadMonthly(newDate.slice(0, 7)); if (attCtl) attCtl.reload(); });
  if (qs('#dquickgrid')) qs('#dquickgrid').onclick = () => quickTimesheetGridModal(qs('#ddate').value, (newDate) => { go(newDate); loadMonthly(newDate.slice(0, 7)); if (attCtl) attCtl.reload(); });

  // Attendance: after a save, booking or sign-off, the day view and the month follow.
  const attEl = qs('#att-card', c);
  const attDone = attendanceCard(attEl, {
    onChanged: () => { const curM = qs('#dwm-month').value; load(qs('#ddate').value); loadMonthly(curM); },
    onDayView: (dt) => { go(dt); qs('#dtable').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  }).then((ctl) => { attCtl = ctl; });
  await Promise.all([loadMonthly(initialMonth), load(date), attDone]);
};

// ---- Attendance & day tally (src/lib/attendance.js; docs/WORKSHOPONE_PLAN.md §A.1)
//
// In, out and break for every mechanic, checked against the hours booked on jobs that day. The
// server does the counting; this card only shows it and sends what was typed. Nothing here
// changes labour cost.
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftDay = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// 8 → "8.0 h", 7.75 → "7.75 h"
const fmtH = (h) => {
  if (h == null) return '—';
  const n = Math.round(Number(h) * 100) / 100;
  return (Math.round(n * 10) === n * 10 ? n.toFixed(1) : n.toFixed(2)) + ' h';
};
const ATT_STATUSES = [['', '—'], ['present', 'Present'], ['absent', 'Absent'], ['leave', 'Leave'], ['half_day', 'Half day'], ['holiday', 'Holiday']];
const ATT_OFF = ['absent', 'leave', 'holiday'];
const ATT_ICON = { green: '✅ ', amber: '🟡 ', red: '🔴 ', grey: '' };
const attMinutes = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
// Same rule as the server: (out − in) − break; out before in = overnight; off days = 0.
function attWorked(a) {
  if (!a || !a.status) return null;
  if (ATT_OFF.includes(a.status)) return 0;
  const i = attMinutes(a.time_in); const o = attMinutes(a.time_out);
  if (i == null || o == null) return null;
  let span = o - i; if (span < 0) span += 1440;
  return Math.max(0, span - (Number(a.break_minutes) || 0)) / 60;
}
// Typed but not saved yet. Kept outside the page so a live refresh (somebody else saving) does
// not throw away what is being typed.
let ATT_DRAFT = { date: null, rows: new Map() };
// Stage 4: with the workshops kept apart, the day is one workshop's. Head office picks which;
// everyone else always gets their own (the server decides). null = the server's default.
let ATT_WS = null;
const attWsQ = () => (ATT_WS ? '&workshop_id=' + ATT_WS : '');
const attWsB = () => (ATT_WS ? { workshop_id: ATT_WS } : {});

async function attendanceCard(el, { onChanged, onDayView } = {}) {
  // #/dailywork?att=YYYY-MM-DD (from "Days waiting for sign-off") opens that day.
  const hashQ = new URLSearchParams(location.hash.split('?')[1] || '');
  const asked = hashQ.get('att');
  // …and, for head office, whose day (Stage 4): #/dailywork?att=…&att_ws=<workshop>.
  if (/^\d+$/.test(hashQ.get('att_ws') || '')) ATT_WS = Number(hashQ.get('att_ws'));
  let date = (asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null) || ATT_DRAFT.date || localDay();
  let d = null;
  const load = async () => {
    try {
      d = await api('/attendance/day?date=' + encodeURIComponent(date) + attWsQ());
      if (d.workshop_id && ME.seesAllWorkshops && !WS_CACHE) await workshopsData();
    } catch (e) {
      el.innerHTML = `<div class="card section"><p class="err">${esc(e.message)}</p></div>`; return;
    }
    paint();
  };
  const dirty = () => ATT_DRAFT.date === date && ATT_DRAFT.rows.size > 0;
  const current = (r) => (ATT_DRAFT.date === date && ATT_DRAFT.rows.get(r.mechanic_id)) || r.attendance || { status: '' };
  const setDraft = (mid, v) => { if (ATT_DRAFT.date !== date) ATT_DRAFT = { date, rows: new Map() }; ATT_DRAFT.rows.set(mid, v); };

  const paint = () => {
    if (!d.enabled) {
      el.innerHTML = d.can.settings
        ? `<div class="card section"><div class="toolbar" style="margin:0"><h3 style="margin:0">Attendance &amp; day tally</h3><span class="muted">— switched off</span><div class="spacer"></div><button class="sm" id="att-set">⚙ Switch on</button></div></div>`
        : '';
      if (qs('#att-set', el)) qs('#att-set', el).onclick = () => attendanceSettingsModal(d.settings);
      return;
    }
    if (ATT_DRAFT.date !== date) ATT_DRAFT = { date, rows: new Map() };
    const s = d.settings;
    const edit = d.can.edit;
    const rows = d.rows.map((r) => {
      const a = current(r);
      const changed = ATT_DRAFT.rows.has(r.mechanic_id);
      const off = ATT_OFF.includes(a.status);
      const worked = changed ? attWorked(a) : r.worked_hours;
      const lines = r.lines.map((l) => `${l.job_no} · ${fmtH(l.hours)}${l.crew && l.crew !== r.name ? ` (${l.crew})` : ''}`).join('\n');
      const diff = changed ? (worked == null ? null : Math.round((worked - r.booked_hours) * 100) / 100) : r.diff_hours;
      let tally = changed
        ? '<span class="muted">not saved</span>'
        : `<span class="badge ${r.tone === 'grey' ? '' : r.tone}">${ATT_ICON[r.tone] || ''}${esc(r.tally_label)}</span>`;
      if (!changed && r.tally === 'unbooked') {
        const reason = r.attendance && r.attendance.unbooked_reason;
        tally += reason
          ? `<div class="muted" style="font-size:11px">Reason: ${esc(reason)}</div>`
          : `<div style="margin-top:3px;display:flex;gap:4px;white-space:nowrap">${d.can.book_rest ? `<button class="sm" data-book="${r.mechanic_id}" title="Book the ${fmtH(r.diff_hours)} not on a job to the General Workshop card">Book to General</button>` : ''}${edit ? `<button class="sm" data-why="${r.mechanic_id}">Reason</button>` : ''}</div>`;
      }
      const t = (k) => esc(a[k] || '');
      return `<tr data-mid="${r.mechanic_id}"${changed ? ' style="background:rgba(29,90,115,.06)"' : ''}>
        <td><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="badge">inactive</span>'}</td>
        <td>${edit ? `<select class="att-st" style="min-width:92px">${ATT_STATUSES.map(([v, l]) => `<option value="${v}" ${v === (a.status || '') ? 'selected' : ''}>${l}</option>`).join('')}</select>` : esc((ATT_STATUSES.find(([v]) => v === a.status) || ['', '—'])[1])}</td>
        <td>${edit ? `<input type="time" class="att-in" value="${t('time_in')}" ${off || !a.status ? 'disabled' : ''} style="width:126px">` : (t('time_in') || '—')}</td>
        <td>${edit ? `<input type="time" class="att-out" value="${t('time_out')}" ${off || !a.status ? 'disabled' : ''} style="width:126px">` : (t('time_out') || '—')}</td>
        <td class="num">${edit ? `<input type="number" class="att-br" min="0" step="5" value="${a.status && !off ? (a.break_minutes ?? '') : ''}" ${off || !a.status ? 'disabled' : ''} style="width:60px;text-align:right">` : (a.status && !off ? `${a.break_minutes || 0} min` : '—')}</td>
        <td class="num">${fmtH(worked)}</td>
        <td class="num" title="${esc(lines || 'Nothing booked')}">${fmtH(r.booked_hours)}</td>
        <td class="num" style="color:${diff == null || Math.abs(diff) * 60 <= s.tolerance_minutes ? 'inherit' : diff > 0 ? 'var(--amber)' : 'var(--red)'}">${diff == null ? '—' : (diff > 0 ? '+' : '') + fmtH(diff)}</td>
        <td>${tally}</td>
        <td>${edit ? `<input class="att-note" value="${t('note')}" placeholder="e.g. at site X" maxlength="200" style="min-width:120px">` : esc(a.note || '')}</td>
      </tr>`;
    });

    const c = d.counts;
    const summary = [
      c.matched ? `✅ ${c.matched} matched` : '',
      c.unbooked ? `🟡 ${c.unbooked} unbooked` : '',
      d.red_count ? `<b style="color:var(--red)">🔴 ${d.red_count} red</b>` : '',
      c.not_entered ? `${c.not_entered} not entered` : '',
    ].filter(Boolean).join(' · ');

    let sign = '';
    if (d.locked) {
      sign = `<span class="badge green">🔒 Signed off by ${esc(d.signoff.signed_by || '—')} · ${esc(d.signoff.signed_at || '')}</span>
        ${d.can.unlock ? '<button class="sm" id="att-unlock">Unlock day</button>' : ''}`;
    } else if (d.before_start) {
      sign = `<span class="muted">Before the start date (${esc(s.start_date || 'not set')}) — not checked.</span>`;
    } else if (d.can.signoff) {
      const why = d.red_count ? 'Fix the red rows first' : dirty() ? 'Save first' : '';
      sign = `<button class="primary sm" id="att-sign" ${why ? 'disabled' : ''} title="${esc(why || 'Lock this day\'s attendance and daily work')}">✓ Sign off day</button>
        ${why ? `<span class="muted">${esc(why)}</span>` : ''}`;
    }
    const unlocked = d.signoff && d.signoff.unlocked_at && !d.locked
      ? `<div class="muted" style="font-size:12px;margin-top:4px">Unlocked by ${esc(d.signoff.unlocked_by || '—')} · ${esc(d.signoff.unlocked_at)} — ${esc(d.signoff.unlock_reason || '')}</div>` : '';

    const unmatched = d.unmatched.length
      ? `<div class="card" style="margin-top:10px;padding:10px 12px;border-color:var(--amber)"><b>Names not matched to a mechanic</b> — their hours are not in anyone's tally:
          <ul style="margin:6px 0 4px 18px;padding:0">${d.unmatched.map((u) => `<li>${u.name ? `<b>${esc(u.name)}</b>` : '<i>(no mechanic named)</i>'} · ${fmtH(u.hours)} · ${u.lines.map((l) => `<a href="#/jobs/${l.job_id}">${esc(l.job_no)}</a>`).join(', ')}</li>`).join('')}</ul>
          <a href="#/aliases">Link them in the Alias Queue →</a></div>` : '';

    el.innerHTML = `<div class="card section">
      <div class="toolbar" style="margin-top:0">
        <h3 style="margin:0">Attendance &amp; day tally</h3>
        ${d.workshop_id && ME.seesAllWorkshops && WS_CACHE
          ? `<select id="att-ws" style="max-width:220px" title="Whose day">${WS_CACHE.workshops.filter((w) => w.active).map((w) => `<option value="${w.id}" ${w.id === d.workshop_id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>`
          : (d.workshop_id && WS_CACHE ? `<span class="badge">🏭 ${esc(wsName(WS_CACHE, d.workshop_id))}</span>` : '')}
        <div class="spacer"></div>
        <button class="sm" id="att-prev">←</button>
        <input id="att-date" type="date" value="${esc(date)}" max="${esc(d.today)}" style="max-width:160px">
        <button class="sm" id="att-next" ${date >= d.today ? 'disabled' : ''}>→</button>
        ${onDayView ? '<button class="sm" id="att-dayview" title="Show this day\'s work in the day view below">Day view ↓</button>' : ''}
        <a class="btn sm" href="/api/reports/daily/day_tally/export.xlsx?date=${esc(date)}" title="This day's tally as a spreadsheet">⬇ Day</a>
        <a class="btn sm" href="/api/attendance/month.xlsx?month=${esc(date.slice(0, 7))}${attWsQ()}" title="The month: attended, booked and utilisation per mechanic">⬇ Month</a>
        ${d.can.settings ? '<button class="sm" id="att-set" title="Attendance settings">⚙</button>' : ''}
      </div>
      <div class="toolbar" style="margin:0 0 8px">
        ${edit ? `<button class="sm" id="att-fill">All present ${esc(s.shift_start)}–${esc(s.shift_end)}</button>
          <button class="sm" id="att-copy">Copy yesterday</button>
          <button class="primary sm" id="att-save" ${dirty() ? '' : 'disabled'}>💾 Save${dirty() ? ` (${ATT_DRAFT.rows.size})` : ''}</button>` : `<span class="muted">${esc(d.can.edit_reason || '')}</span>`}
        <div class="spacer"></div>
        ${sign}
      </div>
      ${unlocked}
      ${tableWrap([{ label: 'Mechanic' }, { label: 'Status' }, { label: 'In' }, { label: 'Out' }, { label: 'Break', num: true },
        { label: 'Worked', num: true }, { label: 'Booked on jobs', num: true }, { label: 'Difference', num: true }, { label: 'Tally' }, { label: 'Note' }], rows, { scroll: true })}
      <div class="muted" style="margin-top:6px;font-size:12px">${summary || 'Nothing recorded yet.'} · Worked ${fmtH(d.totals.worked_hours)} · Booked ${fmtH(d.totals.booked_hours)} · Matched when within ${s.tolerance_minutes} min.</div>
      ${unmatched}
    </div>`;
    wire();
  };

  const confirmLeave = () => !dirty() || confirm('You have attendance that is not saved. Leave it?');
  const goTo = (dt) => {
    if (!dt || !confirmLeave()) return;
    ATT_DRAFT = { date: dt, rows: new Map() }; date = dt;
    // Drop a date that came in on the link, so a refresh keeps the day chosen here.
    if (/[?&]att=/.test(location.hash)) history.replaceState(null, '', '#/dailywork');
    load();
  };
  const repaintWith = (day) => { d = day; paint(); if (onChanged) onChanged(); };

  const wire = () => {
    qs('#att-prev', el).onclick = () => goTo(shiftDay(date, -1));
    if (qs('#att-ws', el)) qs('#att-ws', el).onchange = (e) => {
      if (dirty() && !confirm('Changes not saved will be lost. Continue?')) { e.target.value = String(d.workshop_id); return; }
      ATT_WS = Number(e.target.value); ATT_DRAFT = { date: null, rows: new Map() }; load();
    };
    qs('#att-next', el).onclick = () => goTo(shiftDay(date, 1));
    qs('#att-date', el).onchange = (e) => goTo(e.target.value);
    if (qs('#att-dayview', el)) qs('#att-dayview', el).onclick = () => onDayView(date);
    if (qs('#att-set', el)) qs('#att-set', el).onclick = () => attendanceSettingsModal(d.settings);

    // Typing: every change goes into the draft; the Worked cell follows as you type.
    const readRow = (tr) => {
      const status = qs('.att-st', tr).value;
      return { status, time_in: qs('.att-in', tr).value, time_out: qs('.att-out', tr).value,
        break_minutes: qs('.att-br', tr).value === '' ? 0 : Number(qs('.att-br', tr).value), note: qs('.att-note', tr).value };
    };
    qsa('tr[data-mid]', el).forEach((tr) => {
      if (!qs('.att-st', tr)) return;
      const mid = Number(tr.dataset.mid);
      const s = d.settings;
      qs('.att-st', tr).onchange = () => {
        const v = readRow(tr);
        // Sensible times the moment a status is chosen; they can still be changed.
        if ((v.status === 'present' || v.status === 'half_day') && !v.time_in && !v.time_out) {
          v.time_in = s.shift_start;
          if (v.status === 'present') { v.time_out = s.shift_end; v.break_minutes = s.break_minutes; } else {
            const shift = ((attMinutes(s.shift_end) - attMinutes(s.shift_start) + 1440) % 1440) - s.break_minutes;
            const out = (attMinutes(s.shift_start) + Math.round(shift / 2)) % 1440;
            v.time_out = `${String(Math.floor(out / 60)).padStart(2, '0')}:${String(out % 60).padStart(2, '0')}`;
            v.break_minutes = 0;
          }
        }
        if (ATT_OFF.includes(v.status)) { v.time_in = ''; v.time_out = ''; v.break_minutes = 0; }
        setDraft(mid, v); paint();
      };
      for (const cls of ['.att-in', '.att-out', '.att-br', '.att-note']) {
        qs(cls, tr).onchange = () => { setDraft(mid, readRow(tr)); paint(); };
      }
    });

    if (qs('#att-fill', el)) qs('#att-fill', el).onclick = () => {
      const s = d.settings; let n = 0;
      for (const r of d.rows) {
        if (r.attendance || ATT_DRAFT.rows.has(r.mechanic_id) || !r.active) continue;
        setDraft(r.mechanic_id, { status: 'present', time_in: s.shift_start, time_out: s.shift_end, break_minutes: s.break_minutes, note: '' }); n++;
      }
      paint(); toast(n ? `${n} filled — check them, then Save` : 'Everybody already has attendance');
    };
    if (qs('#att-copy', el)) qs('#att-copy', el).onclick = async () => {
      // The last day with any attendance: yesterday, or Saturday when today is Monday.
      let from = null;
      for (let i = 1; i <= 7 && !from; i++) {
        const prev = await api('/attendance/day?date=' + shiftDay(date, -i) + attWsQ());
        if (prev.rows.some((r) => r.attendance)) from = prev;
      }
      if (!from) return toast('No attendance in the last 7 days to copy', 'err');
      let n = 0;
      for (const r of d.rows) {
        const p = from.rows.find((x) => x.mechanic_id === r.mechanic_id);
        if (!p || !p.attendance || r.attendance || ATT_DRAFT.rows.has(r.mechanic_id)) continue;
        const a = p.attendance;
        setDraft(r.mechanic_id, { status: a.status, time_in: a.time_in || '', time_out: a.time_out || '', break_minutes: a.break_minutes || 0, note: a.note || '' }); n++;
      }
      paint(); toast(n ? `${n} copied from ${from.date} — check them, then Save` : 'Nothing to copy — everybody already has attendance');
    };
    if (qs('#att-save', el)) qs('#att-save', el).onclick = async () => {
      const rows = [...ATT_DRAFT.rows.entries()].map(([mid, v]) => (v.status
        ? { mechanic_id: mid, status: v.status, time_in: v.time_in || null, time_out: v.time_out || null, break_minutes: v.break_minutes || 0, note: v.note || '' }
        : { mechanic_id: mid, clear: true }));
      try {
        const r = await api('/attendance/day', { method: 'POST', body: { date, rows, ...attWsB() } });
        ATT_DRAFT = { date, rows: new Map() };
        toast(`Saved (${r.saved})`);
        repaintWith(r.day);
      } catch (e) { toast(e.message, 'err'); }
    };
    qsa('[data-book]', el).forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await api('/attendance/day/book-rest', { method: 'POST', body: { date, mechanic_id: Number(b.dataset.book), ...attWsB() } });
          toast(`${fmtH(r.hours)} booked to ${r.job_no}`);
          repaintWith(r.day);
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    qsa('[data-why]', el).forEach((b) => {
      b.onclick = async () => {
        const reason = prompt('Why are these hours not on a job? (e.g. cleaning the bay, waiting for parts)');
        if (reason == null || !reason.trim()) return;
        try {
          const r = await api('/attendance/day', { method: 'POST', body: { date, rows: [{ mechanic_id: Number(b.dataset.why), unbooked_reason: reason.trim() }], ...attWsB() } });
          repaintWith(r.day);
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    if (qs('#att-sign', el)) qs('#att-sign', el).onclick = async () => {
      if (!confirm(`Sign off ${date}?\n\nThe day's attendance and daily work will be locked. A manager can unlock it with a reason.`)) return;
      try { repaintWith(await api('/attendance/day/signoff', { method: 'POST', body: { date, ...attWsB() } })); toast('Day signed off'); } catch (e) { toast(e.message, 'err'); }
    };
    if (qs('#att-unlock', el)) qs('#att-unlock', el).onclick = async () => {
      const reason = prompt(`Unlock ${date}? Give the reason:`);
      if (reason == null) return;
      if (!reason.trim()) return toast('A reason is needed to unlock a day', 'err');
      try { repaintWith(await api('/attendance/day/unlock', { method: 'POST', body: { date, reason: reason.trim(), ...attWsB() } })); toast('Day unlocked'); } catch (e) { toast(e.message, 'err'); }
    };
  };

  await load();
  // The page reloads the card after daily work changes (booked hours move); a draft survives it.
  return { reload: () => load() };
}

function attendanceSettingsModal(s) {
  modal('Attendance settings', `
    ${field('Attendance on', 'enabled', { type: 'checkbox', value: s.enabled })}
    <p class="muted" style="font-size:12px;margin:2px 0 8px">Off: Daily Work works exactly as before — no tally, no lock, no hints.</p>
    ${field('Start date (days before it are not checked)', 'start_date', { type: 'date', value: s.start_date || '' })}
    <div class="row"><div>${field('Shift start', 'shift_start', { type: 'time', value: s.shift_start })}</div><div>${field('Shift end', 'shift_end', { type: 'time', value: s.shift_end })}</div></div>
    <div class="row"><div>${field('Break (minutes)', 'break_minutes', { type: 'number', value: s.break_minutes })}</div><div>${field('Matched within (minutes)', 'tolerance_minutes', { type: 'number', value: s.tolerance_minutes })}</div></div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      try {
        await api('/attendance/settings', { method: 'PUT', body: {
          enabled: f.enabled, start_date: f.start_date, shift_start: f.shift_start, shift_end: f.shift_end,
          break_minutes: Number(f.break_minutes), tolerance_minutes: Number(f.tolerance_minutes),
        } });
        toast('Attendance settings saved'); close(); render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// At the point of entry: "attended 8.0 h · booked 6.5 h · 1.5 h left" for each named mechanic, and
// a warning when the new hours would book more than they were at work. It only WARNS — the entry
// is still accepted; an over-booked day is stopped at sign-off. Says nothing while attendance is off.
// `rows`: [{ names: 'Govinda, Vinod', hours }] — each named mechanic counts the full hours.
let _hintSeq = 0;
async function hoursLeftHint(box, { date, rows, excludeLine = null }) {
  if (!box) return;
  const seq = ++_hintSeq;
  const split = (s) => String(s || '').split(/\s*(?:,|&|\+|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  const entries = (rows || []).filter((r) => r.names && String(r.names).trim());
  if (!date || !entries.length) { box.innerHTML = ''; return; }
  let r;
  try {
    r = await api(`/attendance/hours-left?date=${encodeURIComponent(date)}&names=${encodeURIComponent(entries.map((e) => e.names).join('|'))}${excludeLine ? '&exclude_line=' + excludeLine : ''}`);
  } catch (e) { box.innerHTML = ''; return; }
  if (seq !== _hintSeq) return;                   // a newer request has already answered
  if (!r.enabled) { box.innerHTML = ''; return; }
  if (r.locked) { box.innerHTML = `<div class="err">🔒 ${esc(date)} is signed off — its daily work cannot be changed.</div>`; return; }
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tol = (r.tolerance_minutes || 0) / 60;
  const out = r.mechanics.map((m) => {
    if (!m.resolved) return `<div class="muted">${esc(m.name)}: not a known mechanic — it will show as an unmatched name</div>`;
    const mine = new Set(m.raws.map(norm));
    const adding = entries.reduce((t, e) => t + (split(e.names).some((n) => mine.has(norm(n))) ? (Number(e.hours) || 0) : 0), 0);
    if (m.attended_hours == null) {
      return `<div class="muted"><b>${esc(m.name)}</b>: no attendance yet${m.booked_hours ? ` · booked ${fmtH(m.booked_hours)}` : ''}</div>`;
    }
    const over = adding - m.left_hours;
    const line = `<b>${esc(m.name)}</b>: attended ${fmtH(m.attended_hours)} · booked ${fmtH(m.booked_hours)} · ${fmtH(Math.max(0, m.left_hours))} left`;
    return over > tol + 1e-9
      ? `<div style="color:var(--red)">⚠ ${line} — this would over-book by ${fmtH(over)}</div>`
      : `<div class="muted">${line}</div>`;
  });
  box.innerHTML = out.join('');
}

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
    <div id="dw-hint" style="font-size:12px;margin-top:4px"></div>
    <p class="muted" style="font-size:12px;margin:2px 0 0">Pick each mechanic who worked — each is charged the full hours at their own rate.</p>
    <div class="row">${field('Travel (to or from a field job)', 'travel', { type: 'checkbox' })}${field('External repair (outside work)', 'is_external', { type: 'checkbox' })}${field('External value (Rs, if external)', 'external_value', { type: 'number' })}</div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add</button></div>`, (body, close) => {
    const getTarget = wireTargetPicker(body, 'dwt');
    const crew = [];
    const hidden = qs('input[name=mechanic]', body);
    const chips = qs('#dwcrew', body);
    let hintT;
    const hint = () => { clearTimeout(hintT); hintT = setTimeout(() => hoursLeftHint(qs('#dw-hint', body), {
      date: qs('input[name=work_date]', body).value,
      rows: qs('input[name=is_external]', body).checked ? [] : [{ names: hidden.value, hours: qs('input[name=hours]', body).value }],
    }), 250); };
    const paint = () => {
      hidden.value = crew.join(', ');
      chips.innerHTML = crew.map((n) => `<span class="badge blue" data-rm="${esc(n)}" style="cursor:pointer" title="Remove">${esc(n)} ✕</span>`).join('');
      qsa('[data-rm]', chips).forEach((el) => { el.onclick = () => { const i = crew.indexOf(el.dataset.rm); if (i >= 0) crew.splice(i, 1); paint(); }; });
      hint();
    };
    for (const n of ['work_date', 'hours', 'is_external']) qs(`input[name=${n}]`, body).addEventListener(n === 'hours' ? 'input' : 'change', hint);
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

// Rapid multi-row timesheet logging grid for mechanics across jobs
async function quickTimesheetGridModal(defaultDate, onDone) {
  let mechs = [];
  try { mechs = await api('/mechanics'); } catch (e) { }
  const mechListOptions = mechs.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}${m.rate != null ? ' (Rs ' + m.rate + '/h)' : ''}</option>`).join('');

  modal('Quick Timesheet Grid', `
    <p class="muted" style="margin-top:0">Log daily mechanic hours across vehicles/job cards rapidly in a single grid. Blank rows will be ignored.</p>
    <div class="row" style="margin-bottom:12px;align-items:center">
      <div style="max-width:200px">
        <label>Date</label>
        <input type="date" id="tg-date" value="${esc(defaultDate || new Date().toISOString().slice(0, 10))}">
      </div>
      <div class="spacer"></div>
      <button class="sm" id="tg-add-rows">+ Add 5 Rows</button>
    </div>
    <div style="max-height:380px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
      <table class="data-table" style="width:100%;margin:0">
        <thead>
          <tr>
            <th style="width:200px">Mechanic</th>
            <th style="width:140px">Vehicle / Machine</th>
            <th>Work Description</th>
            <th style="width:90px;text-align:right">Hours</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody id="tg-tbody"></tbody>
      </table>
    </div>
    <datalist id="tg-mech-dl">${mechListOptions}</datalist>
    <div id="tg-hint" style="font-size:12px;margin-top:8px"></div>
    <div style="margin-top:14px;display:flex;align-items:center">
      <button class="sm" id="tg-add-1">+ Add Row</button>
      <div class="spacer"></div>
      <button class="primary" id="tg-submit">💾 Submit Timesheets</button>
    </div>`, (body, close) => {

    const tbody = qs('#tg-tbody', body);
    const addRow = (initialData = {}) => {
      const tr = document.createElement('tr');
      tr.className = 'tg-row';
      tr.innerHTML = `
        <td><input type="text" list="tg-mech-dl" class="tg-mech" placeholder="Mechanic name" value="${esc(initialData.mechanic || '')}" style="width:100%"></td>
        <td><input type="text" class="tg-asset" placeholder="e.g. AC06" value="${esc(initialData.asset || '')}" style="width:100%"></td>
        <td><input type="text" class="tg-desc" placeholder="Work done..." value="${esc(initialData.description || '')}" style="width:100%"></td>
        <td><input type="number" step="0.5" min="0" class="tg-hours" placeholder="0" value="${initialData.hours != null ? initialData.hours : ''}" style="width:100%;text-align:right"></td>
        <td style="text-align:center"><button class="sm danger tg-del" title="Remove row" style="padding:2px 6px">✕</button></td>
      `;
      qs('.tg-del', tr).onclick = () => { tr.remove(); };
      tbody.appendChild(tr);
    };

    for (let i = 0; i < 5; i++) addRow();

    // Hours left for everyone in the grid, adding up each mechanic's rows.
    let hintT;
    const hint = () => { clearTimeout(hintT); hintT = setTimeout(() => hoursLeftHint(qs('#tg-hint', body), {
      date: qs('#tg-date', body).value,
      rows: qsa('.tg-row', tbody).map((r) => ({ names: qs('.tg-mech', r).value.trim(), hours: qs('.tg-hours', r).value })),
    }), 300); };
    tbody.addEventListener('input', hint);
    tbody.addEventListener('click', (e) => { if (e.target.closest('.tg-del')) setTimeout(hint, 0); });
    qs('#tg-date', body).addEventListener('change', hint);

    qs('#tg-add-rows', body).onclick = () => { for (let i = 0; i < 5; i++) addRow(); };
    qs('#tg-add-1', body).onclick = () => addRow();

    qs('#tg-submit', body).onclick = async () => {
      const date = qs('#tg-date', body).value;
      if (!date) return toast('Date is required', 'err');
      const rows = qsa('.tg-row', tbody);
      const entries = [];
      for (const r of rows) {
        const mechanic = qs('.tg-mech', r).value.trim();
        const asset = qs('.tg-asset', r).value.trim();
        const description = qs('.tg-desc', r).value.trim();
        const hours = parseFloat(qs('.tg-hours', r).value) || 0;
        if (!mechanic && !asset && !description && hours === 0) continue;
        if (!mechanic) return toast('Mechanic is required for all non-empty rows', 'err');
        if (hours <= 0) return toast(`Please enter hours for mechanic "${mechanic}"`, 'err');
        entries.push({ mechanic, asset, description, hours });
      }
      if (!entries.length) return toast('Please enter at least one timesheet entry', 'err');

      qs('#tg-submit', body).disabled = true;
      qs('#tg-submit', body).textContent = 'Saving...';
      try {
        const res = await api('/daily-work/bulk-log', {
          method: 'POST',
          body: { date, entries }
        });
        toast(`✓ Logged ${res.entries_logged} work entries across ${res.jobs_affected} job(s)!`, 'ok');
        close();
        if (onDone) onDone(date);
      } catch (err) {
        toast(err.message || 'Bulk timesheet log failed', 'err');
        qs('#tg-submit', body).disabled = false;
        qs('#tg-submit', body).textContent = '💾 Submit Timesheets';
      }
    };
  }, { wide: true });
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
    <div id="ew-hint" style="font-size:12px;margin-top:4px"></div>
    <p class="muted" style="font-size:12px;margin:2px 0 0">Each mechanic is charged the full hours at their own rate. Outside labor is what this work would cost sent out — leave blank to clear it.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save changes</button></div>`, (body, close) => {
    const crew = String(entry.mechanic || '').split(/\s*(?:,|&|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
    const hidden = qs('input[name=mechanic]', body);
    const chips = qs('#ewcrew', body);
    // This line's own hours are left out of "booked" — they are the ones being changed.
    let hintT;
    const hint = () => { clearTimeout(hintT); hintT = setTimeout(() => hoursLeftHint(qs('#ew-hint', body), {
      date: qs('input[name=work_date]', body).value, excludeLine: entry.is_external ? null : entry.id,
      rows: entry.is_external ? [] : [{ names: hidden.value, hours: qs('input[name=hours]', body).value }],
    }), 250); };
    const paint = () => {
      hidden.value = crew.join(', ');
      chips.innerHTML = crew.length ? crew.map((n) => `<span class="badge blue" data-rm="${esc(n)}" style="cursor:pointer" title="Remove">${esc(n)} ✕</span>`).join('') : '<span class="muted" style="font-size:12px">No mechanic on this line</span>';
      qsa('[data-rm]', chips).forEach((el) => { el.onclick = () => { const i = crew.indexOf(el.dataset.rm); if (i >= 0) crew.splice(i, 1); paint(); }; });
      hint();
    };
    qs('input[name=work_date]', body).addEventListener('change', hint);
    qs('input[name=hours]', body).addEventListener('input', hint);
    qs('#ewmech', body).onchange = (e) => { const v = e.target.value; if (v && !crew.includes(v)) { crew.push(v); paint(); } e.target.value = ''; };
    paint();
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      try {
        await api('/daily-work/' + entry.id, {
          method: 'PATCH', body: {
            work_date: f.work_date, description: f.description, mechanic: hidden.value,
            hours: f.hours, outside_labour: f.outside_labour === '' ? null : f.outside_labour,
          }
        });
        toast('Entry updated'); close(); if (onDone) onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- Labour Rates (hourly rates + unassigned labour used in daily work)
routes.labour = async (c) => {
  const [mechs, unassigned] = await Promise.all([api('/mechanics'), api('/mechanics/unassigned')]);
  const canEdit = canDo('labour.rates.edit');
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

// ---- Field work (Stage 6) ------------------------------------------------------------------
// A repair done at the site. The times are typed as 'YYYY-MM-DDTHH:MM' in the form and kept as
// 'YYYY-MM-DD HH:MM'.
const fldTime = (s) => (s ? esc(String(s).replace('T', ' ').slice(0, 16)) : '—');
const fldInput = (s) => (s ? String(s).replace(' ', 'T').slice(0, 16) : '');
// Under an hour in minutes ("25 min"), else hours ("3.5 h").
const fldHours = (h) => (h == null ? '—' : (Math.abs(h) < 1 ? `${Math.round(h * 60)} min` : `${num(h)} h`));
const localNowInput = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// A breakdown reported from a site: a field job card, open at once, so a mechanic can go now.
async function breakdownModal() {
  const places = await api('/field/places').catch(() => []);
  const wsd = wsMulti() ? await workshopsData().catch(() => null) : null;
  modal('Report a breakdown', `
    <p class="muted" style="margin-top:0">This opens a field job card now, so a mechanic can go. The approvals follow as usual.</p>
    <datalist id="bdplaces">${places.map((p) => `<option value="${esc(p.label)}">`).join('')}</datalist>
    ${assetPickerHtml('Machine *')}
    <label>Site *</label><input name="location" list="bdplaces" placeholder="Project or site" autocomplete="off">
    ${field('What is wrong? *', 'description', { type: 'textarea' })}
    <label>Stopped at</label><input type="datetime-local" name="stopped_at" value="${localNowInput()}">
    ${wsd ? field('Workshop that sends the mechanic', 'workshop_id', { type: 'select', options: wsOptions(wsd), value: wsd.mine }) : ''}
    <div style="margin-top:14px;text-align:right"><button class="primary" id="save">Report breakdown</button></div>`, (body, close) => {
    wireAssetPicker(body);
    qs('#save', body).onclick = async () => {
      const f = formData(body);
      const p = places.find((x) => x.label === String(f.location || '').trim());
      try {
        const r = await api('/field/breakdown', { method: 'POST', body: { ...f, place: p ? p.key : undefined } });
        close(); toast('Breakdown reported — job card ' + r.job.job_no); location.hash = '#/jobs/' + r.job.id;
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// The field details of one card: in the field or not, the site, the times, the km.
async function fieldModal(jobId, fld, onSaved) {
  const places = await api('/field/places').catch(() => []);
  modal('Field details', `
    <datalist id="fdplaces">${places.map((p) => `<option value="${esc(p.label)}">`).join('')}</datalist>
    <label style="display:flex;gap:8px;align-items:center;flex-direction:row;width:auto;margin-bottom:8px">
      <input type="checkbox" name="field" style="width:auto" checked> In the field (repaired at the site)</label>
    <div id="fdmore">
      <label>Site</label><input name="location" list="fdplaces" value="${esc(fld.location || '')}" autocomplete="off">
      <div class="row">
        <div><label>Reported / stopped</label><input type="datetime-local" name="reported_at" value="${fldInput(fld.reported_at)}"></div>
        <div><label>Mechanic arrived</label><input type="datetime-local" name="arrived_at" value="${fldInput(fld.arrived_at)}"></div>
        <div><label>Working again</label><input type="datetime-local" name="working_at" value="${fldInput(fld.working_at)}"></div>
      </div>
      ${field('Km driven by the field vehicle', 'km', { type: 'number', value: fld.km == null ? '' : fld.km })}
      <p class="muted" style="font-size:12px;margin:4px 0 0">Travel time goes in Daily Work as a line marked "Travel".</p>
    </div>
    <div style="margin-top:14px;text-align:right"><button class="primary" id="save">Save</button></div>`, (body, close) => {
    const box = qs('input[name=field]', body);
    box.onchange = () => { qs('#fdmore', body).style.display = box.checked ? '' : 'none'; };
    qs('#save', body).onclick = async () => {
      const f = formData(body);
      let payload;
      if (!box.checked) {
        if (fld.field && !confirm('Take this job out of the field? Its site, times and km are cleared.')) return;
        payload = { field: false };
      } else {
        const p = places.find((x) => x.label === String(f.location || '').trim());
        payload = { field: true, location: f.location, place: p ? p.key : '', reported_at: f.reported_at, arrived_at: f.arrived_at, working_at: f.working_at, km: f.km };
      }
      try { await api('/field/jobs/' + jobId, { method: 'PATCH', body: payload }); close(); toast('Saved'); if (onSaved) onSaved(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

// The field board: every field job still open, the machines still down first.
routes.field = async (c) => {
  if (!canView('field')) { c.innerHTML = '<div class="card err">You do not have access to this page.</div>'; return; }
  const d = await api('/field/board');
  const canBd = canDo('jobs.breakdown');
  const canRate = canDo('jobs.settings');
  const rows = d.rows.map((r) => `<tr>
      <td><a href="#/jobs/${r.id}"><b>${esc(r.job_no)}</b></a>${r.breakdown ? ' <span class="badge red">Breakdown</span>' : ''}${wsMulti() && r.workshop_name ? `<br><span class="muted" style="font-size:11px">${esc(r.workshop_name)}</span>` : ''}</td>
      <td>${esc(r.asset_reg || r.asset_code || '—')}<br><span class="muted" style="font-size:11px">${esc(r.asset_type || '')}</span></td>
      <td class="desc-col">${esc(r.field_location || '—')}</td>
      <td>${fldTime(r.reported_at)}</td>
      <td>${r.arrived_at ? fldTime(r.arrived_at) : '<span class="badge amber">not yet</span>'}</td>
      <td>${r.down ? `<span class="badge red">down${r.down_hours != null ? ' ' + fldHours(r.down_hours) : ''}</span>` : `<span class="badge green">working · ${fldHours(r.downtime_hours)}</span>`}</td>
      <td class="desc-col">${esc(r.mechanics || '—')}</td>
      <td>${statusBadge(r.status)}</td></tr>`);
  c.innerHTML = `${pageHeader('Field work', 'Repairs done at the site: the machines still down first.')}
    <div class="toolbar">
      <span class="badge ${d.down ? 'red' : 'green'}">${d.down} machine${d.down === 1 ? '' : 's'} down</span>
      <div class="spacer"></div>
      ${canRate ? `<span class="muted" style="font-size:12px">Field vehicle: ${d.settings.km_rate != null ? money(d.settings.km_rate) + ' per km' : 'no rate per km set'}</span> <button class="sm" id="fdrate">Set rate…</button>` : ''}
      ${canBd ? '<button class="primary" id="fdbd">🚨 Report a breakdown</button>' : ''}
    </div>
    ${rows.length ? tableWrap([{ label: 'Job' }, { label: 'Machine' }, { label: 'Site' }, { label: 'Reported' }, { label: 'Arrived' },
    { label: 'Now' }, { label: 'Mechanics (3 days)' }, { label: 'Status' }], rows, { scroll: true })
    : '<div class="card"><p class="muted">No open field jobs.</p></div>'}`;
  if (qs('#fdbd', c)) qs('#fdbd', c).onclick = breakdownModal;
  if (qs('#fdrate', c)) qs('#fdrate', c).onclick = () => modal('Field vehicle rate', `
    ${field('Rate per km (Rs)', 'km_rate', { type: 'number', value: d.settings.km_rate == null ? '' : d.settings.km_rate })}
    <p class="muted" style="font-size:12px">Used for km entered from now on. Km already entered keep the rate they were entered at.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      try { await api('/field/settings', { method: 'PUT', body: formData(b) }); close(); toast('Saved'); routes.field(c); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
};

// ---- Operations (Stage 7): the site fleet, workshops at a glance, job handovers.
const OPS_STATE = { working: ['Working', 'green'], down_workshop: ['Down · workshop', 'red'], down_field: ['Down · field', 'red'],
  idle: ['Idle', 'amber'], out_of_use: ['Out of use', ''] };
const isHeadOffice = () => isAdmin() || !!(ME && (ME.caps || []).includes('workshops.all'));

routes.operations = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tabs = [];
  if (canView('operations')) {
    tabs.push(['fleet', 'Site fleet']);
    if (isHeadOffice()) tabs.push(['glance', 'Workshops at a glance']);
    if (wsMulti()) tabs.push(['handovers', 'Job handovers']);
  }
  if (!tabs.length) { c.innerHTML = '<div class="card err">You do not have access to this page.</div>'; return; }
  const tab = tabs.some((t) => t[0] === sp.get('tab')) ? sp.get('tab') : tabs[0][0];
  c.innerHTML = `${pageHeader('Operations', 'Where the machines are, which are down, and how each workshop is doing.')}
    <div class="toolbar">${tabs.map(([k, l]) => `<a class="btn sm ${k === tab ? 'primary' : ''}" href="#/operations?tab=${k}">${esc(l)}</a>`).join('')}</div>
    <div id="opsbody"><div class="muted">Loading…</div></div>`;
  const body = qs('#opsbody', c);
  if (tab === 'fleet') return opsFleet(body, sp.get('month'));
  if (tab === 'glance') return opsGlance(body);
  return opsHandovers(body);
};

async function opsFleet(body, month) {
  const d = await api('/operations/fleet' + (month ? '?month=' + encodeURIComponent(month) : ''));
  const pct = (v) => (v == null ? '—' : `<b style="color:${v >= 90 ? 'var(--green)' : v >= 75 ? 'var(--amber)' : 'var(--red)'}">${num(v)}%</b>`);
  const n = (v, tone) => (v ? `<span class="badge ${tone}">${v}</span>` : '<span class="muted">0</span>');
  const machineRows = (r) => r.list.map((m) => `<tr>
      <td><a href="#/assets/${m.id}">${esc(m.registration || m.code)}</a>${m.registration && m.code !== m.registration ? ` <span class="muted" style="font-size:11px">${esc(m.code)}</span>` : ''}</td>
      <td>${esc(m.type || '')}</td>
      <td><span class="badge ${OPS_STATE[m.state][1]}">${OPS_STATE[m.state][0]}</span></td>
      <td>${m.job ? (m.job.reachable ? `<a href="#/jobs/${m.job.id}">${esc(m.job.job_no)}</a>` : esc(m.job.job_no)) + (wsMulti() && m.job.workshop_name ? ` <span class="muted" style="font-size:11px">${esc(m.job.workshop_name)}</span>` : '') : '—'}</td>
      <td class="num">${m.down_days == null ? '—' : m.down_days}</td></tr>`).join('');
  const rows = d.rows.map((r, i) => `<tr class="opsrow" data-i="${i}" style="cursor:pointer" title="Show the machines">
      <td><b>${esc(r.label)}</b></td><td class="num">${r.machines}</td>
      <td class="num">${n(r.working, 'green')}</td><td class="num">${n(r.down_workshop, 'red')}</td><td class="num">${n(r.down_field, 'red')}</td>
      <td class="num">${n(r.idle, 'amber')}</td><td class="num">${n(r.out_of_use, '')}</td>
      <td class="num">${pct(r.availability)}</td><td class="num muted">${r.down_days} / ${r.machine_days}</td></tr>
    <tr class="opsdetail" data-i="${i}" style="display:none"><td colspan="9" style="background:var(--surface-2, #f6f6f3)">
      ${r.list.length ? tableWrap([{ label: 'Machine' }, { label: 'Type' }, { label: 'Now' }, { label: 'Job card' }, { label: 'Down days this month', num: true }], [machineRows(r)])
    : '<span class="muted">No machine here now; the days counted are from machines that were here earlier in the month.</span>'}
    </td></tr>`);
  const t = d.total;
  body.innerHTML = `
    <div class="toolbar">
      <label style="width:auto">Month <input type="month" id="opsmonth" value="${esc(d.month)}" style="max-width:170px"></label>
      <span class="muted">${esc(d.from)} to ${esc(d.to)} · ${d.days} day${d.days === 1 ? '' : 's'}</span>
      <div class="spacer"></div>
      <span>Availability: ${pct(t.availability)}</span>
    </div>
    <div class="grid section">
      <div class="card stat"><span class="n">${t.machines}</span><span class="l">Machines</span></div>
      <div class="card stat"><span class="n" style="color:var(--green)">${t.working}</span><span class="l">Working now</span></div>
      <div class="card stat"><span class="n" style="color:${t.down_workshop + t.down_field ? 'var(--red)' : 'inherit'}">${t.down_workshop + t.down_field}</span><span class="l">Down now (workshop + field)</span></div>
      <div class="card stat"><span class="n">${t.idle}</span><span class="l">Idle</span></div>
    </div>
    ${tableWrap([{ label: 'Project / site' }, { label: 'Machines', num: true }, { label: 'Working', num: true }, { label: 'Down · workshop', num: true },
    { label: 'Down · field', num: true }, { label: 'Idle', num: true }, { label: 'Out of use', num: true }, { label: 'Availability', num: true }, { label: 'Down days / machine-days', num: true }], rows, { scroll: true })}
    <p class="muted" style="font-size:12px">Availability = machine-days with no open repair ÷ all machine-days in the month. A machine counts where it stood each day. A machine is down from the day its repair card is opened (or the breakdown is reported) until the work is complete. Services and machines out of use are not counted. Click a row to see its machines.</p>`;
  qs('#opsmonth', body).onchange = (e) => { location.hash = '#/operations?tab=fleet&month=' + e.target.value; };
  qsa('.opsrow', body).forEach((tr) => {
    tr.onclick = () => { const det = qs(`.opsdetail[data-i="${tr.dataset.i}"]`, body); det.style.display = det.style.display === 'none' ? '' : 'none'; };
  });
}

async function opsGlance(body) {
  const d = await api('/operations/glance');
  const cell = (w, what, v, tone) => `<td class="num">${v == null ? '<span class="muted">—</span>'
    : v ? `<button class="sm opsn" data-ws="${w.workshop_id}" data-what="${what}" data-name="${esc(w.name)}">${tone ? `<span style="color:var(--${tone})">${v}</span>` : v}</button>` : '<span class="muted">0</span>'}</td>`;
  const rows = d.rows.map((w) => `<tr>
      <td><b>${esc(w.name)}</b> <span class="muted" style="font-size:11px">${esc(w.code || '')}</span></td>
      ${cell(w, 'open', w.open_jobs)}${cell(w, 'down', w.machines_down, 'red')}${cell(w, 'parts', w.waiting_parts, 'amber')}
      ${cell(w, 'approvals', w.approvals)}${cell(w, 'present', w.present)}${cell(w, 'signoff', w.unsigned_days, 'red')}
      <td class="num">${w.cost_month == null ? '—' : money(w.cost_month)}</td></tr>`);
  body.innerHTML = `
    <p class="muted" style="margin-top:0">Today, ${esc(d.date)}. Click a number to see the list behind it.</p>
    ${tableWrap([{ label: 'Workshop' }, { label: 'Open jobs', num: true }, { label: 'Machines down', num: true }, { label: 'Waiting for parts', num: true },
    { label: 'Requests to approve', num: true }, { label: d.attendance ? 'Mechanics present' : 'Mechanics with work today', num: true },
    { label: 'Days to sign off', num: true }, { label: 'Cost this month', num: true }], rows, { scroll: true })}
    <p class="muted" style="font-size:12px">Cost this month is the workshop's total in the Job Cost report for ${esc(d.month)}.${d.attendance ? '' : ' Attendance is off, so "mechanics" counts those with daily work booked today.'}</p>`;
  const TITLES = { open: 'Open jobs', down: 'Machines down', parts: 'Waiting for parts', approvals: 'Requests to approve', present: 'Mechanics today', signoff: 'Days to sign off' };
  qsa('.opsn', body).forEach((b) => {
    b.onclick = async () => {
      const list = await api(`/operations/glance/${b.dataset.ws}/${b.dataset.what}`);
      const what = b.dataset.what;
      let html;
      if (['open', 'down', 'parts'].includes(what)) {
        html = tableWrap([{ label: 'Job' }, { label: 'Machine' }, { label: 'Since' }, { label: 'Status' }],
          list.map((j) => `<tr><td><a href="#/jobs/${j.id}">${esc(j.job_no)}</a></td><td>${esc(j.asset_reg || j.asset_code || '—')}</td><td>${esc(j.since || '')}</td><td>${statusBadge(j.status)}</td></tr>`));
      } else if (what === 'approvals') {
        html = tableWrap([{ label: 'Request' }, { label: 'Kind' }, { label: 'Machine' }, { label: 'Date' }, { label: 'Waiting for' }],
          list.map((r) => `<tr><td>${esc(r.ref || '')}</td><td>${esc(r.kind)}</td><td>${esc(r.asset_code || '—')}</td><td>${esc(String(r.since || '').slice(0, 10))}</td><td>${r.status === 'certified' ? 'approval' : 'certification'}</td></tr>`));
      } else if (what === 'present') {
        html = tableWrap([{ label: 'Mechanic' }, { label: '' }], list.map((m) => `<tr><td>${esc(m.name)}</td><td class="muted">${esc(m.detail || '')}</td></tr>`));
      } else {
        html = tableWrap([{ label: 'Day' }], list.map((x) => `<tr><td>${esc(x.date)}</td></tr>`));
      }
      modal(`${TITLES[what] || ''} · ${b.dataset.name}`, html, (mb, close) => { qsa('a', mb).forEach((a) => { a.addEventListener('click', () => close()); }); }, { wide: true });
    };
  });
}

async function opsHandovers(body) {
  const list = await api('/operations/handovers?days=90');
  body.innerHTML = `
    <p class="muted" style="margin-top:0">Job cards sent from one workshop to another in the last 90 days${isHeadOffice() ? '' : ', to or from your workshop'}.</p>
    ${tableWrap([{ label: 'Date' }, { label: 'Job' }, { label: 'Machine' }, { label: 'From' }, { label: 'To' }, { label: 'Why' }, { label: 'By' }],
    list.map((h) => `<tr><td>${esc(String(h.moved_at || '').slice(0, 10))}</td>
      <td>${h.reachable ? `<a href="#/jobs/${h.job_id}">${esc(h.job_no)}</a>` : esc(h.job_no)}</td><td>${esc(h.asset_code || '—')}</td>
      <td>${esc(h.from_name || '—')}</td><td><b>${esc(h.to_name || '—')}</b></td><td class="desc-col">${esc(h.reason)}</td><td>${esc(h.moved_by || '')}</td></tr>`), { scroll: true })}`;
}

async function newJobModal() {
  const projects = await api('/projects');
  const popts = [{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
  // Which workshop does the repair (Stage 2): your home workshop unless you choose another.
  const wsd = wsMulti() ? await workshopsData() : null;
  modal('New Job Card', `
    <p class="muted">One open job card per vehicle — if this vehicle already has one, close it first or add the work to it.</p>
    ${assetPickerHtml('Vehicle / machine *')}
    <div id="njblock" style="margin:4px 0"></div>
    <div class="row">${field('Type', 'type', { type: 'select', options: [{ value: 'repair', label: 'repair' }, { value: 'service', label: 'service' }] })}${field('Severity', 'severity', { type: 'select', options: [{ value: '', label: '—' }, { value: 'major', label: 'major' }, { value: 'minor', label: 'minor' }] })}</div>
    ${field('Project', 'project_id', { type: 'select', options: popts })}
    ${wsd ? field('Workshop (who repairs it)', 'workshop_id', { type: 'select', options: wsOptions(wsd), value: wsd.mine }) : ''}
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
  // Partly closed (W2): the work is done and the vehicle has left; prices and records still come in.
  const isPartial = job.status === 'PARTIALLY_CLOSED';
  const partialOn = !!j.partialCloseEnabled;
  const pendingReq = (j.reopenRequests || []).find((q) => q.status === 'pending');
  // Reopen gets its own labelled button and confirm dialog — the raw CLOSED → IN_PROGRESS
  // state button read as "IN PROGRESS" and offered itself to users the server would refuse.
  // Partly close has its own button too (it asks for a note).
  // Approval limit: a job that costs more than this person may sign off is closed by someone else.
  const overCloseLimit = !!(j.closeLimit && !j.closeLimit.ok);
  const transitions = j.nextStates
    .filter((s) => !((isClosed || isPartial) && s === 'IN_PROGRESS') && s !== 'PARTIALLY_CLOSED' && !(overCloseLimit && s === 'CLOSED'))
    .map((s) => `<button class="sm ${s === 'CLOSED' ? 'primary' : ''}" data-to="${s}">${s === 'CLOSED' && partialOn ? '✓ Close fully' : s.replace(/_/g, ' ')}</button>`).join(' ');
  const partialBtn = partialOn && canDo('jobs.partial_close') && ['IN_PROGRESS', 'WORK_COMPLETE'].includes(job.status)
    ? '<button class="sm" id="partialclose" title="The work is done and the vehicle has left, but prices or records are missing">◐ Partly close…</button>' : '';
  // Switched on, a reopen is ASKED FOR and someone else approves it; off, a manager reopens directly.
  const reopenBtn = (isClosed || isPartial)
    ? (partialOn
      ? (canDo('jobs.reopen_request') && !pendingReq ? '<button class="sm danger" id="reopenreq" title="Ask for this job card to be reopened — another manager approves it">↩ Request reopen…</button>' : '')
      : (j.canReopen ? '<button class="sm danger" id="reopen" title="Reopen this closed job card so more work and costs can be added">↩ Reopen job…</button>' : ''))
    : '';
  const reopens = j.reopens || [];
  const mayDecide = pendingReq && canDo('jobs.reopen') && (pendingReq.requested_by !== ME.id || isAdmin());
  const linkJob = (x) => `<a href="#/jobs/${x.id}"><b>${esc(x.job_no)}</b></a> ${statusBadge(x.status)}`;
  const successor = (j.continuedAs || []).slice(-1)[0];
  // Stage 6: field work — the site, the times (one button each, for the phone), response and downtime.
  const fld = j.field || {};
  const canField = canDo('jobs.field') && !isClosed && job.status !== 'REJECTED';
  const fieldPanel = fld.field ? `<div class="card section" style="border-left:4px solid ${fld.down ? 'var(--red)' : 'var(--green)'}">
      <div class="toolbar" style="margin:0 0 6px"><h3 style="margin:0">📍 In the field</h3>
        ${fld.breakdown ? '<span class="badge red">Breakdown</span>' : ''}${fld.down ? '<span class="badge amber">Machine down</span>' : '<span class="badge green">Working again</span>'}
        <div class="spacer"></div>${canField ? '<button class="sm" id="fldedit">✎ Field details</button>' : ''}</div>
      <p style="margin:0 0 8px"><b>${esc(fld.location || 'Site not given')}</b></p>
      <div class="grid">
        <div class="card stat"><span class="n" style="font-size:16px">${fldTime(fld.reported_at)}</span><span class="l">Reported</span></div>
        <div class="card stat"><span class="n" style="font-size:16px">${fld.arrived_at ? fldTime(fld.arrived_at) : (canField ? '<button class="primary" id="fldarr">Mechanic arrived</button>' : '—')}</span><span class="l">Mechanic arrived</span></div>
        <div class="card stat"><span class="n" style="font-size:16px">${fld.working_at ? fldTime(fld.working_at) : (canField && fld.arrived_at ? '<button class="primary" id="fldwork">Machine working again</button>' : '—')}</span><span class="l">Working again</span></div>
        <div class="card stat"><span class="n" style="font-size:16px">${fldHours(fld.response_hours)} · ${fld.downtime_hours != null ? fldHours(fld.downtime_hours) : (fld.down_hours != null ? 'down ' + fldHours(fld.down_hours) : '—')}</span><span class="l">Response · downtime</span></div>
      </div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Travel: ${num(fld.travel_hours || 0)} h · Field vehicle: ${fld.km != null
    ? `${num(fld.km)} km × ${fld.km_rate != null ? money(fld.km_rate) : '(no rate set)'} = ${money(fld.transport_cost)}` : 'no km entered'}</p>
    </div>` : '';
  c.innerHTML = `${pageHeader(job.job_no, '<a href="#/jobs">← Job Cards</a>')}
    <div class="toolbar">${statusBadge(job.status)}<span class="badge ${job.type === 'service' ? 'blue' : ''}">${esc(job.type)}</span>
      ${job.severity ? `<span class="badge">${esc(job.severity)}</span>` : ''}
      <a href="#/assets/${job.asset_id}">${esc(idLabel(job) || '—')}</a>
      <span class="muted">${esc(job.project_name || '')}</span>
      ${wsMulti() && job.workshop_name ? `<span class="badge" title="The workshop doing this repair">🏭 ${esc(job.workshop_name)}</span>` : ''}
      <div class="spacer"></div>
      ${!isClosed && !isPartial && canDo('stores.mrn.create') ? '<button class="sm" id="jobreqmrn" title="Create a Material Request Note (MRN) for this job">+ Request Parts (MRN)</button>' : ''}
      ${!isClosed && !isPartial && canDo('stores.stock_issue') ? '<button class="sm primary" id="jobissue" title="Issue stock from store to this job card">⚡ Issue to Job</button>' : ''}
      ${canDo('jobs.edit') && !isPartial ? '<button class="sm" id="editjob" title="Change the vehicle, description or type">✎ Edit</button>' : ''}
      ${!fld.field && canField && !isPartial ? '<button class="sm" id="fldmark" title="The repair is done at the site, not in the workshop">📍 In the field…</button>' : ''}
      ${job.type === 'service' && canDo('jobs.flat_labour') && job.status !== 'CLOSED' ? `<button class="sm" id="flatlabour">Service labour${job.flat_labour != null ? ': ' + money(job.flat_labour) : ' (flat)'}</button>` : ''}
      <a class="btn primary sm" href="/api/reports/job/${job.id}/report.html" target="_blank" title="Full job report — parts requested & received, daily work done, and costs">📋 Job Report</a>
      <a class="btn sm" href="/api/reports/job/${job.id}/costsheet.html" target="_blank">🖨 Cost Sheet</a>
    </div>
    ${job.type === 'service' ? `<p class="muted" style="font-size:12px">Service job — labour is a flat charge${job.flat_labour == null ? ' (not set yet)' : ''}, not hours×rate.</p>` : ''}
    <p>${esc(job.description || '')}</p>
    ${(j.handovers || []).map((h) => `<p class="muted" style="font-size:13px;margin:4px 0">🔀 Sent from <b>${esc(h.from_name || '—')}</b> to <b>${esc(h.to_name || '—')}</b> on ${esc(String(h.moved_at || '').slice(0, 10))}${h.moved_by ? ` by ${esc(h.moved_by)}` : ''} — ${esc(h.reason)}</p>`).join('')}
    ${fieldPanel}
    ${attendedPanel(j.attended, job)}
    ${j.continues ? `<p class="muted" style="font-size:13px">↪ Continues ${linkJob(j.continues)} — the vehicle's earlier job, partly closed.</p>` : ''}
    ${isPartial ? `<div class="card section" style="border-left:4px solid var(--violet)">
      <b>◐ Partly closed ${esc(String(job.partial_closed_at || '').slice(0, 10))}</b>${job.partial_note ? ` — ${esc(job.partial_note)}` : ''}
      <p class="muted" style="margin:6px 0 0">This job is partly closed. You can price items, receive what was already requested and add general items. Daily work can be added up to ${esc(String(job.partial_closed_at || '').slice(0, 10))}. To add anything else, request a reopen${successor ? ` — or use the vehicle's new job ${linkJob(successor)}` : ''}.</p>
    </div>` : (successor ? `<p class="muted" style="font-size:13px">↪ Continued as ${linkJob(successor)}</p>` : '')}
    ${pendingReq ? `<div class="card section" style="border-left:4px solid var(--amber)">
      <b>↩ Reopen asked for</b> by ${esc(pendingReq.requested_by_name || '—')} on ${esc(String(pendingReq.requested_at || '').slice(0, 10))}: ${esc(pendingReq.reason)}
      ${mayDecide ? '<div class="pill-row" style="margin-top:8px"><button class="sm primary" id="reqapprove">✓ Approve reopen</button><button class="sm danger" id="reqrefuse">✕ Refuse</button></div>'
        : `<p class="muted" style="margin:6px 0 0">Waiting for ${pendingReq.requested_by === ME.id ? 'another manager' : 'a manager'} to approve it.</p>`}
    </div>` : ''}
    ${(transitions || reopenBtn || partialBtn || (!isClosed && !isPartial && canDo('jobs.close_on_date'))) ? `<div class="card section"><h3>Actions</h3><div class="pill-row" id="transitions">${transitions}${partialBtn}${reopenBtn}
      ${!isClosed && !isPartial && canDo('jobs.close_on_date') ? '<button class="sm" id="closedate" title="Close this card with a chosen (past) completion date — for old cards missed at the time">📅 Close on date…</button>' : ''}</div>
      ${isClosed
        ? `<p class="muted" style="margin-top:10px">Closed ${esc(String(job.completed_at || job.closed_at || '').slice(0, 10))} — locked for editing. ${partialOn ? 'Request a reopen to add more work or costs.' : (j.canReopen ? 'Reopen it to add more work or costs.' : 'Ask a manager or the admin to reopen it.')}</p>`
        : !r.ready ? `<p class="err" style="margin-top:10px">⚠ ${isPartial ? 'Still missing before it can close fully' : 'Closure gate'} — ${r.missing.length} line(s):</p><ul>${r.missing.map((m) => `<li class="muted">${esc(m)}</li>`).join('')}</ul>` : `<p class="ok" style="margin-top:10px">✓ Fully priced — ready to close${partialOn ? ' fully' : ''}</p>`}
      ${overCloseLimit && j.nextStates.includes('CLOSED') ? `<p style="margin-top:8px"><span class="badge amber">Above your limit</span> This job costs ${esc(money(j.closeLimit.value))}. Your limit for closing a job is ${esc(money(j.closeLimit.limit))}. Needs: ${esc(j.closeLimit.who_can.join(', '))}.</p>` : ''}
      ${reopens.length ? `<p class="muted" style="margin-top:10px;font-size:12px"><b>Reopen history</b></p><ul style="margin:4px 0 0">${reopens.map((x) => `<li class="muted" style="font-size:12px">${esc(String(x.reopened_at || '').slice(0, 10))} by ${esc(x.reopened_by_name || '—')} — ${esc(x.reason)}${x.prev_completed_at ? ` <span class="note">(was closed ${esc(String(x.prev_completed_at).slice(0, 10))})</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${job.original_completed_at && !isClosed ? `<p class="muted" style="margin-top:8px;font-size:12px">↩ Reopened. When you close it again it goes back into <b>${esc(String(job.original_completed_at).slice(0, 7))}</b>'s cost report, so that month's figures do not change.</p>` : ''}
    </div>` : ''}
    ${j.unissued_shelf_parts && j.unissued_shelf_parts.length ? `
      <div class="card section" style="background:#fffbeb;border:1px solid #fcd34d">
        <div style="display:flex;align-items:center;gap:8px;font-weight:700;color:#92400e;margin-bottom:6px">
          <span style="font-size:18px">📦</span>
          <span>Parts Delivered on GRN Waiting Unissued on Store Shelf (${j.unissued_shelf_parts.length})</span>
        </div>
        <p class="muted" style="color:#b45309;font-size:12px;margin:0 0 10px">
          These items arrived in stores via GRN but have not yet been issued/handed over to this vehicle. Card closure is blocked until all delivered parts are issued or cleared.
        </p>
        <div style="display:grid;gap:8px">
          ${j.unissued_shelf_parts.map((p) => `
            <div style="display:flex;align-items:center;justify-content:space-between;background:#ffffff;padding:8px 12px;border:1px solid #fde68a;border-radius:6px">
              <div>
                <b>${esc(p.description)}</b>
                <span class="muted" style="margin-left:8px;font-size:12px">MRN: ${esc(p.mrn_no || '—')} · GRN: ${esc(p.grn_no || '—')} · Unissued: <b style="color:#b45309">${num(p.remaining_in_store)} ${esc(p.unit || 'nos')}</b></span>
              </div>
              ${!isClosed && canDo('stores.stock_issue') ? `
                <button class="sm primary issue-shelf-shortcut" data-shelf-item='${esc(JSON.stringify({
          job_id: job.id, job_no: job.job_no, asset_id: job.asset_id,
          grn_id: p.grn_id, mrn_no: p.mrn_no, grn_no: p.grn_no,
          description: p.description, remaining: p.remaining_in_store, unit_price: p.grn_price || p.unit_price
        }))}'>⚡ Issue Handover</button>
              ` : ''}
            </div>
          `).join('')}
        </div>
      </div>` : ''}
    <div class="grid section">
      <div class="card"><h3>Cost Breakdown ${job.status === 'CLOSED' ? '(frozen snapshot)' : '(live)'}</h3>
        <div class="cost-line"><span>Labour</span><span>${money(j.cost.labour_cost)}</span></div>
        ${j.cost.travel_hours ? `<div class="muted" style="font-size:12px;margin:-2px 0 4px">incl. travel ${fldHours(j.cost.travel_hours)} · ${money(j.cost.travel_cost)}</div>` : ''}
        <div class="cost-line"><span>Material</span><span>${money(j.cost.material_cost)}</span></div>
        <div class="cost-line"><span>Oil</span><span>${money(j.cost.oil_cost)}</span></div>
        <div class="cost-line"><span>General</span><span>${money(j.cost.general_cost)}</span></div>
        <div class="cost-line"><span>External</span><span>${money(j.cost.external_cost)}</span></div>
        ${j.cost.field_cost ? `<div class="cost-line"><span>Field transport</span><span>${money(j.cost.field_cost)}</span></div>` : ''}
        ${Math.abs((j.cost.other_cost || 0) - (j.cost.field_cost || 0)) >= 0.005 ? `<div class="cost-line"><span>Other / Recorded</span><span>${money((j.cost.other_cost || 0) - (j.cost.field_cost || 0))}</span></div>` : ''}
        <div class="cost-line total"><span>Total</span><span>${money(j.cost.total_cost)}</span></div>
      </div>
      <div class="card"><h3>Approvals</h3>
        ${j.approvals.length ? j.approvals.map((a) => `<div class="cost-line"><span>${esc(a.role.replace(/_/g, ' '))}</span><span class="badge ${a.decision === 'approved' ? 'green' : 'red'}">${esc(a.decision)}</span></div>${a.reason ? `<div class="muted" style="font-size:12px">${esc(a.reason)}</div>` : ''}`).join('') : '<span class="muted">No approvals yet</span>'}
      </div>
    </div>
    <div class="card section"><div class="toolbar" style="margin:0 0 10px"><h3 style="margin:0">Daily Work</h3><div class="spacer"></div>${canDo('jobs.dailywork') ? '<button class="sm" id="adddaily">+ Add</button>' : ''}</div>
      ${(() => {
      // Each mechanic in a crew is shown on its own line: rate × hours = amount.
      const rateOf = {};
      j.labour.forEach((l) => { if (l.mechanic != null) rateOf[l.mechanic] = l.rate; });
      const splitMechs = (raw) => String(raw || '').split(/\s*(?:,|&|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
      const canDel = canDo('jobs.dailywork');
      const rows = [];
      let labourTotal = 0;
      for (const w of j.dailyWork) {
        const del = canDel ? `<button class="sm" data-del-daily="${w.id}" title="Take off this job — the entry goes back to unassigned daily work, it is not deleted">✕</button>` : '';
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
              <td>${i === 0 ? `${w.travel ? '<span class="badge blue">Travel</span> ' : ''}${esc(w.description || '')}` : ''}</td>
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
    <div class="card section"><div class="toolbar" style="margin:0 0 10px"><h3 style="margin:0">Parts &amp; External</h3><div class="spacer"></div>${canDo('jobs.parts') && !isPartial ? '<button class="sm" id="addpart">+ Add item</button>' : ''}</div>
      ${tableWrap([{ label: 'Source' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Amount', num: true }, { label: '' }],
      j.parts.map((p) => `<tr><td><span class="badge">${esc(p.source_type)}${p.is_external_repair ? ' · ext' : ''}</span></td><td>${esc(p.description || '')}</td>
          <td class="num">${num(p.qty)}</td>
          <td class="num">${p.unit_price == null ? '<span class="badge amber">awaiting</span>' : money(p.unit_price)}</td>
          <td class="num">${p.unit_price == null ? '—' : money(p.qty * p.unit_price)}</td>
          <td>${canDo('jobs.parts') ? `<button class="sm" data-price="${p.id}">Price</button>${isPartial ? '' : ` <button class="sm" data-del-part="${p.id}" title="Take off this job — the item goes back to unassigned parts, it is not deleted">✕</button>`}` : ''}</td></tr>`))}
    </div>
    ${j.mrnItems && j.mrnItems.length ? `<div class="card section"><h3>MRN Items <span class="muted">— requested materials (${j.mrnItems.length})</span></h3>
      ${tableWrap([{ label: 'MRN No' }, { label: 'Date' }, { label: 'Item' }, { label: 'Category' }, { label: 'Qty Req', num: true }, { label: 'Qty Recd', num: true }, { label: 'Shelf Status' }, { label: 'Action' }],
        j.mrnItems.map((m) => {
          const avail = Number(m.remaining_in_store) || 0;
          const recd = Number(m.qty_received) || 0;
          const req = Number(m.qty) || 0;
          let statusBadgeHtml = '';
          if (avail > 0) statusBadgeHtml = `<span class="pipe-badge avail">● ${num(avail)} ready on shelf</span>`;
          else if (recd >= req && req > 0) statusBadgeHtml = `<span class="badge green">Fully issued</span>`;
          else if (recd > 0) statusBadgeHtml = `<span class="badge blue">Partial (${num(recd)}/${num(req)})</span>`;
          else statusBadgeHtml = `<span class="pipe-badge pend">Awaiting delivery</span>`;

          const actBtn = (avail > 0 && !isClosed && canDo('stores.stock_issue'))
            ? `<button class="sm primary issue-mrn-btn" data-mrn-item='${esc(JSON.stringify({
              job_id: job.id, job_no: job.job_no, asset_id: job.asset_id,
              grn_id: m.grn_id, mrn_no: m.mrn_no, grn_no: m.grn_no,
              description: m.description, remaining: avail, unit_price: m.unit_price
            }))}'>⚡ Issue</button>`
            : '—';

          return `<tr>
            <td><a href="#/stores?tab=mrn&id=${m.mrn_id}">${esc(m.mrn_no)}</a></td>
            <td>${esc((m.req_date || '').slice(0, 10))}</td>
            <td>${esc(m.description || '')}</td>
            <td>${esc(m.category || '')}</td>
            <td class="num">${num(m.qty)}</td>
            <td class="num">${num(m.qty_received)}</td>
            <td>${statusBadgeHtml}</td>
            <td>${actBtn}</td></tr>`;
        }), { scroll: true })}</div>` : ''}
    ${j.oilIssues.length ? `<div class="card section"><h3>Oil / Lubricant Issued</h3>${tableWrap([{ label: 'Product' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }], j.oilIssues.map((o) => `<tr><td>${esc(o.product_name)}</td><td class="num">${num(Math.abs(o.qty))} ${esc(o.unit)}</td><td class="num">${money(o.unit_price)}</td></tr>`))}</div>` : ''}
    ${j.generalIssues && j.generalIssues.length ? `<div class="card section"><h3>General Items Issued <span class="muted">(${j.generalIssues.length})</span></h3>
      ${tableWrap([{ label: 'Date' }, { label: 'Item' }, { label: 'Qty', num: true }, { label: 'Ref / MR' }],
          j.generalIssues.map((g) => `<tr><td>${esc((g.txn_date || '').slice(0, 10))}</td><td>${esc(g.item_name || '')}</td><td class="num">${num(Math.abs(g.qty))}</td><td>${esc(g.ref || '')}</td></tr>`), { scroll: true })}</div>` : ''}`;

  // wire actions
  qsa('#transitions button[data-to]').forEach((b) => b.onclick = () => doTransition(job.id, b.dataset.to, job.status));
  if (qs('#closedate')) qs('#closedate').onclick = () => closeOnDateModal(job.id, job.job_no, render);
  if (qs('#reopen')) qs('#reopen').onclick = () => reopenJobModal(job, render);
  if (qs('#reopenreq')) qs('#reopenreq').onclick = () => reopenRequestModal(job, render);
  if (qs('#partialclose')) qs('#partialclose').onclick = () => partialCloseModal(job, j, render);
  if (qs('#jwhy')) qs('#jwhy').onclick = () => reasonModal(job, () => jobDetail(c, id));
  if (qs('#reqapprove')) qs('#reqapprove').onclick = async () => {
    if (!confirm(`Reopen ${job.job_no}?\n\nIt goes back to IN PROGRESS and becomes the vehicle's open job.`)) return;
    try { await api(`/jobs/reopen-requests/${pendingReq.id}/approve`, { method: 'POST', body: {} }); toast(`✓ ${job.job_no} reopened`); render(); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (qs('#reqrefuse')) qs('#reqrefuse').onclick = async () => {
    const note = prompt('Why is the reopen refused?');
    if (note == null) return;
    if (!note.trim()) return toast('Say why — the person who asked will see it', 'err');
    try { await api(`/jobs/reopen-requests/${pendingReq.id}/refuse`, { method: 'POST', body: { note: note.trim() } }); toast('Reopen refused'); render(); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (qs('#editjob')) qs('#editjob').onclick = () => editJobModal(job, render);
  // Stage 6: field work.
  if (qs('#fldmark')) qs('#fldmark').onclick = () => fieldModal(job.id, { field: false }, render);
  if (qs('#fldedit')) qs('#fldedit').onclick = () => fieldModal(job.id, fld, render);
  const fieldStep = (step, label) => async () => {
    try { await api(`/field/jobs/${job.id}/${step}`, { method: 'POST' }); toast(label); render(); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (qs('#fldarr')) qs('#fldarr').onclick = fieldStep('arrived', 'Arrival recorded');
  if (qs('#fldwork')) qs('#fldwork').onclick = fieldStep('working', 'Machine working again — recorded');
  if (qs('#jobreqmrn')) qs('#jobreqmrn').onclick = () => newMrnModal({
    job_id: job.id,
    job_no: job.job_no,
    asset_id: job.asset_id,
    asset_code: idLabel(job),
    purpose: 'Job ' + job.job_no
  });
  if (qs('#jobissue')) qs('#jobissue').onclick = () => newIssueModal(render, {
    job_id: job.id,
    job_no: job.job_no,
    asset_id: job.asset_id
  });
  qsa('.issue-mrn-btn').forEach((b) => {
    b.onclick = () => {
      try {
        const item = JSON.parse(b.dataset.mrnItem);
        newIssueModal(render, item);
      } catch (err) { console.error(err); }
    };
  });
  qsa('.issue-shelf-shortcut').forEach((b) => {
    b.onclick = () => {
      try {
        const item = JSON.parse(b.dataset.shelfItem);
        newIssueModal(render, item);
      } catch (err) { console.error(err); }
    };
  });
  if (qs('#flatlabour')) qs('#flatlabour').onclick = () => modal('Service Labour (flat charge)',
    field('Flat labour amount (Rs)', 'flat_labour', { type: 'number', value: job.flat_labour ?? '' }) + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>',
    (body, close) => { qs('#s', body).onclick = async () => { try { await api(`/jobs/${job.id}/flat-labour`, { method: 'PATCH', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } }; });
  if (qs('#adddaily')) qs('#adddaily').onclick = () => addDailyModal(job.id, job.asset_id);
  if (qs('#addpart')) qs('#addpart').onclick = () => addPartModal(job.id, job.asset_id);
  qsa('[data-del-daily]').forEach((b) => b.onclick = async () => {
    try { const r = await api(`/jobs/${job.id}/daily-work/${b.dataset.delDaily}`, { method: 'DELETE' }); toast(r.message || 'Removed'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  qsa('[data-del-part]').forEach((b) => b.onclick = async () => {
    try { const r = await api(`/jobs/${job.id}/parts/${b.dataset.delPart}`, { method: 'DELETE' }); toast(r.message || 'Removed'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
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
    if (e.data && e.data.missing) toast(e.message, 'err');
    else if (e.data && e.data.blocking_job) toast(`Blocked — ${e.data.blocking_job.job_no} is already open for this vehicle`, 'err');
    else toast(e.message, 'err');
  }
}

// Edit the card itself — vehicle, description, type. The vehicle box is pre-filled with the
// current one and left alone unless the user actually picks a different vehicle, so simply
// correcting the description can never move a job to another machine by accident.
async function editJobModal(job, onDone) {
  const fld = (...args) => `<div class="fld">${field(...args)}</div>`;
  const wsd = wsMulti() ? await workshopsData() : null;
  modal(`Edit ${job.job_no}`, `
    ${fld('Description *', 'description', { value: job.description || '' })}
    ${wsd ? fld('Workshop (who repairs it)', 'workshop_id', { type: 'select', options: wsOptions(wsd), value: job.workshop_id }) : ''}
    ${wsd ? `<div id="wsreason" style="display:none">${fld('Why does it go to another workshop? *', 'workshop_reason', { placeholder: 'e.g. no crane here, Central has the parts' })}</div>` : ''}
    <div class="row" style="margin-top:8px">
      ${fld('Type', 'type', { type: 'select', value: job.type, options: [{ value: 'repair', label: 'Repair' }, { value: 'service', label: 'Service' }] })}
      <div class="fld">${assetPickerHtml('Vehicle')}</div>
    </div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Leave the vehicle box as it is to keep <b>${esc(idLabel(job) || 'no vehicle')}</b>. Changing it moves this job's labour and parts onto the other vehicle's monthly costs.</p>
    <div style="margin-top:14px;text-align:right"><button class="primary" id="s">Save changes</button></div>`, (body, close) => {
    wireAssetPicker(body);
    const cur = qs('.apick-input', body);
    if (cur) cur.value = job.asset_code || job.asset_reg || '';
    // Stage 7: sending the card to another workshop asks why.
    const wsSel = qs('select[name=workshop_id]', body);
    if (wsSel) wsSel.onchange = () => { qs('#wsreason', body).style.display = Number(wsSel.value) !== Number(job.workshop_id) ? '' : 'none'; };
    qs('#s', body).onclick = async () => {
      const d = formData(body);
      const payload = { description: d.description, type: d.type };
      if (d.workshop_id && Number(d.workshop_id) !== Number(job.workshop_id)) {
        payload.workshop_id = Number(d.workshop_id);
        payload.workshop_reason = d.workshop_reason;
      }
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
        // Sent to a workshop out of your reach (Stage 3): the card is theirs now — back to your list.
        if (payload.workshop_id && ME.workshopsSeen && !ME.workshopsSeen.includes(payload.workshop_id)) {
          toast(`✓ ${job.job_no} sent to ${wsName(wsd, payload.workshop_id)}`);
          location.hash = '#/jobs';
          return;
        }
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
    <p class="muted" style="margin-top:0;font-size:12px">For old cards missed at the time — the card closes as if it was closed on this date, and it appears in that month's cost report. Unpriced lines don't block; they show as a warning so you can price them after. (With partial close switched on, a card with something still missing is <b>partly</b> closed on that date instead.)</p>
    ${field('Close date *', 'date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}
    ${field('Note (optional)', 'reason', { placeholder: 'e.g. missed closing — job finished on this date' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Close job on this date</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      const data = formData(body);
      if (!data.date) return toast('Pick the close date', 'err');
      try {
        const res = await api(`/jobs/${jobId}/close-on-date`, { method: 'POST', body: data });
        toast(res.partly_closed ? `◐ ${jobNo}: ${res.warning}` : `✓ ${jobNo} closed on ${data.date}` + (res.warning ? ` — ${res.warning}` : ''));
        close(); if (onDone) onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- partial close and reopen requests (src/lib/job_close.js; docs/WORKSHOPONE_PLAN.md §A.2)

// Partly close: the work is finished and the vehicle has left, but prices or records are missing.
function partialCloseModal(job, detail, onDone) {
  const missing = (detail.readiness && detail.readiness.missing) || [];
  const canNew = !!job.asset_id && canDo('jobs.create');
  modal(`Partly close ${job.job_no}?`, `
    <p class="muted" style="margin-top:0;font-size:12px">Use this when the work is finished and the vehicle has left, but prices or records are still missing. The vehicle is free for a new job straight away. Close it fully once everything below is done.</p>
    <p style="margin:6px 0 2px"><b>Still outstanding (${missing.length})</b></p>
    <ul style="margin:0 0 8px">${missing.map((m) => `<li class="muted">${esc(m)}</li>`).join('') || '<li class="muted">Nothing — close it fully instead.</li>'}</ul>
    ${detail.workRecorded ? '' : '<p class="err" style="margin:4px 0">No work is recorded on this job. Write why in the note.</p>'}
    ${field('Note' + (detail.workRecorded ? ' (optional)' : ' *'), 'note', { type: 'textarea' })}
    ${canNew ? `${field('Open a new job for this vehicle now', 'open_new', { type: 'checkbox' })}
      <div id="pcnew" style="display:none">${field('New job — description', 'new_description', { placeholder: 'e.g. Next fault, or: continued from ' + job.job_no })}</div>` : ''}
    <p class="muted" style="font-size:12px;margin:8px 0 0">After this the job takes only prices, items already requested, general items and daily work up to today. For anything else, request a reopen.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">◐ Partly close</button></div>`, (body, close) => {
    const tick = qs('input[name=open_new]', body);
    if (tick) tick.onchange = () => { qs('#pcnew', body).style.display = tick.checked ? '' : 'none'; };
    qs('#s', body).onclick = async () => {
      const f = formData(body);
      if (!detail.workRecorded && !String(f.note || '').trim()) return toast('Write why no work is recorded', 'err');
      try {
        const res = await api(`/jobs/${job.id}/partial-close`, { method: 'POST', body: {
          note: f.note, open_new: !!f.open_new, new_description: f.new_description } });
        close();
        toast(`◐ ${job.job_no} partly closed` + (res.new_job ? ` — new job ${res.new_job.job_no} opened` : ''));
        if (onDone) onDone();
      } catch (e) {
        toast(e.data && e.data.blocking_job ? `${e.message}` : e.message, 'err');
      }
    };
  });
}

// Ask for a partly closed or closed card to be reopened. Someone else approves it.
function reopenRequestModal(job, onDone) {
  modal(`Request reopen of ${job.job_no}`, `
    <p class="muted" style="margin-top:0;font-size:12px">A manager (not you) approves it. When approved the job goes back to <b>IN PROGRESS</b> and keeps its original report month. It can only be reopened when the vehicle has no other open job.</p>
    ${field('Why should it be reopened? *', 'reason', { type: 'textarea' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Send request</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      const reason = String(formData(body).reason || '').trim();
      if (!reason) return toast('Give the reason', 'err');
      try {
        await api(`/jobs/${job.id}/reopen-request`, { method: 'POST', body: { reason } });
        close(); toast('Reopen requested — waiting for approval');
        if (onDone) onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// Admin: partial close, the stricter full close and reopen requests go on and off together.
function partialCloseSwitchModal(isOn) {
  modal('Partial close', `
    <p class="muted" style="margin-top:0">When <b>on</b>:</p>
    <ul class="muted" style="margin-top:0">
      <li>a job can be <b>partly closed</b> — the vehicle is freed, prices can still be added;</li>
      <li><b>close fully</b> needs every item priced and the work done recorded;</li>
      <li>a closed or partly closed job is reopened by <b>request</b>, approved by someone else.</li>
    </ul>
    <p class="muted">When <b>off</b>, closing and reopening work as before. Jobs already partly closed stay partly closed.</p>
    ${field('Partial close on', 'on', { type: 'checkbox', value: isOn })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      try {
        const r = await api('/jobs/close-settings', { method: 'PUT', body: { partial_close_enabled: !!formData(body).on } });
        close(); toast(`Partial close is ${r.partial_close_enabled ? 'on' : 'off'}`); render();
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

// Naming the machine on a line that never recorded one. The 159 rows written before
// job_daily_work.asset_id existed are the reason this exists: somebody who recognises the work says
// which machine it was, and from then on it is searchable rather than a guess in prose.
function setDailyWorkVehicle(lineId, onDone) {
  modal('Which machine was this work on?', `
    ${assetPickerHtml('Vehicle / machine')}
    <p class="muted" style="font-size:12px;margin:8px 0 0">Leave blank to say it is still unknown — better than a vehicle that might be wrong.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="sv">Save</button></div>`,
    (body, close) => {
      wireAssetPicker(body);
      qs('#sv', body).onclick = async () => {
        const id = qs('input[name=asset_id]', body).value;
        try {
          await api('/daily-work/' + lineId, { method: 'PATCH', body: { asset_id: id || null } });
          toast(id ? 'Vehicle recorded' : 'Vehicle cleared');
          close();
          if (onDone) onDone();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
}

async function addDailyModal(jobId, assetId) {
  modal('Add Daily Work', `
    ${pickerTabs('✎ New entry', '📋 Not yet assigned')}
    <div id="paneNew">
      <div class="row">${field('Date', 'work_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}${field('Mechanic(s) — comma / & separated', 'mechanic', { placeholder: 'e.g. Buddhika, Krishna' })}</div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">Each mechanic is charged the full hours at their own rate (one costed row each). A slash name ("Seethananda/seetha") stays one person.</p>
      ${field('Description', 'description')}
      ${field('Hours', 'hours', { type: 'number' })}
      <div id="jd-hint" style="font-size:12px;margin-top:4px"></div>
      ${assetPickerHtml('Vehicle / machine' + (assetId ? ' (defaults to this card)' : ' — this card has none, so name it here'))}
      ${field('Travel (to or from a field job)', 'travel', { type: 'checkbox' })}
      ${field('External repair (outside work)', 'is_external', { type: 'checkbox' })}
      ${field('External value (if external)', 'external_value', { type: 'number' })}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Add</button></div>
    </div>
    <div id="panePool" style="display:none">
      <p class="muted" style="font-size:12px;margin:0 0 8px">Work booked to the general workshop rather than to a job card. Tick what belongs to this job — the hours and their cost move across with it.<br>Search by vehicle — <b>AC06</b>, <b>ac-06</b> and <b>AC 06</b> all find the same machine, in the recorded vehicle or in the work text.</p>
      <input id="dwq" type="search" placeholder="Search vehicle, description or mechanic…" style="max-width:320px">
      <div id="dwlist" style="margin-top:8px"><div class="muted">Loading…</div></div>
      <div style="margin-top:12px;display:flex;align-items:center;gap:8px">
        <span class="muted" id="dwsel"></span><div class="spacer"></div>
        <button class="primary" id="dwAttach" disabled>Attach selected</button>
      </div>
    </div>`, (body, close) => {
    wireAssetPicker(body);
    let hintT;
    const hint = () => { clearTimeout(hintT); hintT = setTimeout(() => hoursLeftHint(qs('#jd-hint', body), {
      date: qs('#paneNew input[name=work_date]', body).value,
      rows: qs('#paneNew input[name=is_external]', body).checked ? [] : [{ names: qs('#paneNew input[name=mechanic]', body).value, hours: qs('#paneNew input[name=hours]', body).value }],
    }), 300); };
    for (const n of ['work_date', 'mechanic', 'hours', 'is_external']) qs(`#paneNew input[name=${n}]`, body).addEventListener(n === 'mechanic' || n === 'hours' ? 'input' : 'change', hint);
    qs('#s', body).onclick = async () => { try { await api(`/jobs/${jobId}/daily-work`, { method: 'POST', body: formData(body) }); close(); render(); } catch (e) { toast(e.message, 'err'); } };

    const chosen = new Set();
    const refreshSel = () => {
      qs('#dwsel', body).textContent = chosen.size ? `${chosen.size} selected` : '';
      qs('#dwAttach', body).disabled = chosen.size === 0;
    };
    const load = async () => {
      const q = qs('#dwq', body).value.trim();
      let rows = [];
      // asset_id sorts this job's own machine to the top, as the parts picker does.
      try {
        // job_id: the pool of this card's workshop (one per workshop, Stage 3).
        rows = await api('/jobs/unassigned/daily-work?limit=200&job_id=' + jobId
          + (assetId ? '&asset_id=' + assetId : '')
          + (q ? '&q=' + encodeURIComponent(q) : ''));
      }
      catch (e) { qs('#dwlist', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
      qs('#poolN', body).textContent = rows.length ? `(${rows.length})` : '';
      qs('#dwlist', body).innerHTML = rows.length ? tableWrap(
        [{ label: '', width: '34px' }, { label: 'Date', width: '104px' }, { label: 'Vehicle', width: '150px' }, { label: 'Mechanic' }, { label: 'Work', cls: 'desc-col' }, { label: 'Hrs', num: true, width: '60px' }],
        rows.map((r) => `<tr${assetId && r.asset_id === assetId ? ' style="background:var(--surface-2)"' : ''}>
          <td><input type="checkbox" data-dw="${r.id}" ${chosen.has(String(r.id)) ? 'checked' : ''} style="width:auto"></td>
          <td>${esc(String(r.work_date || '').slice(0, 10))}</td>
          <td>${r.asset_code
            ? `<span class="stamp">${esc(r.asset_code)}</span>${assetId && r.asset_id === assetId ? ' <span class="badge green">this job</span>' : ''}`
            // Not recorded — say so, and offer to record it. This is the only way the 159 rows
            // written before the column existed ever become searchable by machine.
            : `<button class="sm" data-setveh="${r.id}" title="Say which machine this work was on">set vehicle</button>`}</td>
          <td>${esc(r.mechanic || (r.is_external ? 'outside' : ''))}</td>
          <td class="desc-col">${esc(r.description || '')}</td>
          <td class="num">${num(r.hours)}</td></tr>`), { scroll: true })
        : '<div class="card"><p class="muted">Nothing unassigned — every entry is already on a job card.</p></div>';
      qsa('[data-dw]', body).forEach((cb) => {
        cb.onchange = () => {
          if (cb.checked) chosen.add(cb.dataset.dw); else chosen.delete(cb.dataset.dw);
          refreshSel();
        };
      });
      qsa('[data-setveh]', body).forEach((b) => { b.onclick = () => setDailyWorkVehicle(b.dataset.setveh, load); });
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
        d = await api('/jobs/unassigned/parts?limit=200&job_id=' + jobId
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
      qsa('[data-pt]', body).forEach((cb) => {
        cb.onchange = () => {
          const [kind, id] = cb.dataset.pt.split(':');
          if (cb.checked) chosen.set(cb.dataset.pt, { kind, id, value: Number(cb.dataset.val) || 0 });
          else chosen.delete(cb.dataset.pt);
          refreshSel();
        };
      });
      refreshSel();
    };
    let deb; qs('#ptq', body).oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
    qs('#ptAttach', body).onclick = async () => {
      const picked = [...chosen.values()];
      try {
        const r = await api(`/jobs/${jobId}/parts/attach`, {
          method: 'POST', body: {
            receipts: picked.filter((x) => x.kind === 'receipt').map((x) => x.id),
            parts: picked.filter((x) => x.kind === 'part').map((x) => x.id),
          }
        });
        toast(`${r.attached} item${r.attached === 1 ? '' : 's'} attached · ${money(r.value)}`);
        close(); render();
      } catch (e) { toast(e.message, 'err'); }
    };
    wirePickerTabs(body, load);
  }, { wide: true });
}

async function storeCatalogueTab(body) {
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
    const p = tree.find((x) => String(x.id) === qs('#ccat', body).value);
    qs('#csub', body).innerHTML = '<option value="">All sub-categories</option>'
      + (p ? p.subs.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.counts.items})</option>`).join('') : '');
  };
  const load = async () => {
    const q = qs('#cq', body).value.trim(), cat = qs('#csub', body).value || qs('#ccat', body).value, kind = qs('#ckind', body).value;
    const list = await api('/stores/catalogue?limit=2000'
      + (q ? '&q=' + encodeURIComponent(q) : '')
      + (cat ? '&category_id=' + encodeURIComponent(cat) : '')
      + (kind ? '&kind=' + encodeURIComponent(kind) : ''));
    qs('#ccount', body).textContent = `${list.length}${list.length === 2000 ? '+' : ''} item${list.length === 1 ? '' : 's'}`;
    qs('#ctable', body).innerHTML = tableWrap(
      [{ label: 'Item No' }, { label: 'Item Name' }, { label: 'Category' }, { label: 'Sub-category' }, { label: 'Kind' }, { label: 'Requests', num: true }, { label: 'Part Numbers' }],
      list.map((i) => {
        const pn = i.part_numbers || ''; return `<tr>
        <td><span class="stamp">${esc(i.item_no)}</span></td>
        <td>${esc(i.name)}</td>
        <td>${esc(i.parent_category || i.category || '')}</td>
        <td class="muted">${esc(i.sub_category || '')}</td>
        <td>${kindBadge(i.catalogue_kind)}</td>
        <td class="num">${num(i.req_count || 0)}</td>
        <td title="${esc(pn)}" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pn.length > 70 ? pn.slice(0, 70) + '…' : pn)}</td></tr>`;
      }), { scroll: true });
  };
  let cdeb; qs('#cq', body).oninput = () => { clearTimeout(cdeb); cdeb = setTimeout(load, 250); };
  qs('#ccat', body).onchange = async () => { await fillSubs(); load(); };
  qs('#csub', body).onchange = load; qs('#ckind', body).onchange = load;
  await load();
}

// ---- Stores
routes.stores = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  let tab = sp.get('tab') || 'monitor';

  // If someone lands on legacy catalogue/categories/reorder/general/items tab, redirect to generalstock
  if (['catalogue', 'categories', 'reorder', 'general', 'items'].includes(tab)) {
    const sub = sp.get('sub') || (tab === 'general' || tab === 'items' ? 'catalogue' : tab);
    location.replace('#/generalstock?tab=' + (sub === 'general' ? 'catalogue' : sub));
    return;
  }

  // One Stores page (stores plan, Part 1): the Monitor, one road from request to issue, and the
  // transfers. The old tabs still answer: the pipeline hub and the item search became the list of
  // requested items; "requests & receipts" and "issues & transfers" are its views and Transfers.
  if (tab === 'pipeline' || tab === 'search') tab = 'lines';
  if (tab === 'paperwork') tab = sp.get('sub') || 'mrn';
  if (tab === 'movements') tab = sp.get('sub') || 'issues';
  const GROUPS = {
    flow: { label: '🔄 REQUESTS → ISSUE',
      subs: [['lines', '📋 Items'], ['mrn', 'Requests (MRN)'], ['grn', 'Receipts (GRN)'], ['issues', 'Issues'], ['workspace', '⚡ Receive & price many']] },
  };
  // Part 2: every kind of stock in one view, and the stock take.
  // Part 4: scrap and waste oil leave on a disposal note.
  const PRIMARY = [['monitor', '📊 MONITOR'], ['flow', GROUPS.flow.label], ['mtn', '🔁 TRANSFERS'], ['stock', '📦 STOCK'], ['counts', '🧮 STOCK TAKE'], ['disposal', '♻️ DISPOSAL']];

  const group = GROUPS[tab] ? tab : null;
  if (group) tab = sp.get('sub') || GROUPS[group].subs[0][0];      // a group renders its sub-view
  const owner = group || Object.keys(GROUPS).find((g) => GROUPS[g].subs.some(([s]) => s === tab)) || null;

  const isOn = (t) => (owner ? t === owner : t === tab);
  const primaryBar = `<div class="toolbar" style="margin-bottom:4px">${PRIMARY
    .map(([t, l]) => `<button class="sm ${isOn(t) ? 'primary' : ''}" onclick="location.hash='#/stores?tab=${t}'">${l}</button>`).join('')}</div>`;
  const subBar = owner ? `<div class="toolbar" style="margin:0 0 10px 0">${GROUPS[owner].subs
    .map(([s, l]) => `<button class="sm ${s === tab ? 'primary' : ''}" onclick="location.hash='#/stores?tab=${owner}&sub=${s}'">${l}</button>`).join('')}</div>` : '';

  c.innerHTML = pageHeader('Stores') + primaryBar + subBar + '<div id="storebody" class="muted">Loading…</div>';
  const body = qs('#storebody');
  if (tab === 'monitor') {
    return storesMonitor(body);
  } else if (tab === 'stock') {
    return storesStock(body, sp);
  } else if (tab === 'counts') {
    return sp.get('id') ? countDetail(body, sp.get('id'), sp) : countList(body, sp);
  } else if (tab === 'disposal') {
    return sp.get('id') ? disposalDetail(body, sp.get('id')) : disposalList(body, sp);
  } else if (tab === 'lines') {
    return storesLines(body, sp);
  } else if (tab === 'workspace') {
    return receivePriceTab(body);
  } else if (tab === 'categories') {
    return categoriesTab(body);
  } else if (tab === 'general' || tab === 'catalogue') {
    return storeCatalogueTab(body);
  } else if (tab === 'items') {
    const items = await api('/stores/items?limit=500');
    body.innerHTML = `${canDo('stores.items.edit') ? '<div class="toolbar"><button class="primary" id="ni">+ New Item</button></div>' : ''}
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
    const canRx = canDo('stores.grn.edit');     // price / correct a receipt
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
    }).catch(() => { });
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
    const canRx = canDo('stores.mrn.edit');     // set a line's purchase source
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
        ${canDo('stores.stock_issue') ? '<button class="primary" id="nis">+ New Issue</button>' : ''}
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
        [{ label: 'Date' }, { label: 'Vehicle' }, { label: 'Job Card' }, { label: 'Item / description' }, { label: 'Category' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Issued by' }]
          .concat(canReturn ? [{ label: '' }] : []),
        list.map((i) => `<tr>
          <td>${esc((i.issue_date || '').slice(0, 10))}</td>
          <td>${esc(i.asset_code || '—')}</td>
          <td>${i.job_no ? `<a href="#/jobs/${i.job_id}">${esc(i.job_no)}</a>` : '<span class="muted">—</span>'}</td>
          <td>${esc(i.description)}</td>
          <td>${esc(i.category || '')}${i.sub_category ? ` <span class="muted" style="font-size:11px">› ${esc(i.sub_category)}</span>` : ''}</td>
          <td class="num">${num(i.qty)}${i.returned > 0 ? `<br><span class="badge blue" title="Brought back unused">${num(i.returned)} returned</span>` : ''}</td>
          <td class="num">${i.unit_price == null ? '—' : money(i.unit_price)}</td>
          <td>${esc(i.issued_by || '')}</td>
          ${canReturn ? `<td>${!i.voided && i.qty - (i.returned || 0) > 0.001 ? `<button class="sm" data-ret="${i.id}" data-left="${i.qty - (i.returned || 0)}" data-desc="${esc(i.description)}" title="Parts brought back unused go back into the store">↩ Return</button>` : ''}</td>` : ''}</tr>`), { scroll: true });
      // Stage 6: parts brought back unused — back into the store, off the job's cost.
      qsa('[data-ret]', qs('#itable')).forEach((b) => { b.onclick = () => modal(`Return to store · ${b.dataset.desc}`, `
        ${field('Quantity brought back', 'qty', { type: 'number', value: b.dataset.left })}
        ${field('Date', 'return_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}
        ${field('Note (optional)', 'note')}
        <p class="muted" style="font-size:12px">It goes back into the store it left, and comes off the job's cost.</p>
        <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Return to store</button></div>`, (mb, close) => {
        qs('#s', mb).onclick = async () => {
          try { const r = await api(`/stores/issues/${b.dataset.ret}/return`, { method: 'POST', body: formData(mb) }); close(); toast(`Returned ${num(r.qty)}`); load(); }
          catch (e) { toast(e.message, 'err'); }
        };
      }); });
    };
    const canReturn = canDo('stores.issue_return');
    let ideb; qs('#iq').oninput = () => { clearTimeout(ideb); ideb = setTimeout(load, 250); };
    if (qs('#nis')) qs('#nis').onclick = () => newIssueModal(load);
    await load();
  } else if (tab === 'mtn') {
    const canT = canDo('stores.mtn.edit');
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
          <td class="desc-col">${esc(t.description || '')}${t.moves_stock ? ' <span class="badge green" title="Moves stock from one store to another">moves stock</span>' : ''}</td>
          <td class="num">${(t.item_count || 1) > 1 ? `<span class="badge blue">${t.item_count}</span>` : '1'}</td>
          <td class="num">${num(t.qty)}</td>
          <td>${esc(t.from_location || t.from_asset_code || '')}</td><td>${esc(t.to_location || t.to_asset_code || '')}</td>
          ${canT ? `<td><button class="sm" data-mtn="${t.id}">✎ Edit</button></td>` : ''}</tr>`), { scroll: true })
        : `<div class="card"><p class="muted">${q || from || to ? 'No transfer matches that.' : 'No transfers recorded yet.'}</p></div>`;
      qsa('[data-mtn]', body).forEach((b) => { b.onclick = () => mtnModal(list.find((x) => String(x.id) === b.dataset.mtn), loadMtn); });
      // ▸ opens the note's items underneath, so a multi-item transfer can be read without
      // leaving the list.
      qsa('[data-exp]', body).forEach((b) => {
        b.onclick = async () => {
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
              d.lines.map((l, i) => `<tr><td class="num">${i + 1}</td><td>${esc(l.description || '')}${l.from_store ? `<br><span class="muted" style="font-size:12px">stock: ${esc(l.from_store)} → ${esc(l.to_store)}</span>` : ''}</td>
              <td class="num">${num(l.qty)}</td><td>${esc(l.unit || '')}</td><td>${esc(l.category || '')}</td>
              <td>${esc(l.from_location || l.from_asset_code || '')}</td>
              <td>${esc(l.to_location || l.to_asset_code || '')}</td>
              <td>${esc(l.reason || '')}</td></tr>`));
          } catch (e) { holder.firstChild.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
        };
      });
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
    (mb, close) => {
      qs('#s', mb).onclick = async () => {
        const nm = formData(mb).name.trim();
        if (!nm) return toast('Enter a name', 'err');
        try { await onSave(nm); close(); toast('Saved'); reload(); } catch (e) { toast(e.message, 'err'); }
      };
    });

  if (qs('#newcat')) qs('#newcat').onclick = () => modal('New Category', `
    <p class="muted">A top-level category. It starts with a "General" sub-category; add more below it afterwards.</p>
    <div class="row">${field('Name', 'name')}${field('Code (item no prefix, e.g. ELE)', 'code')}</div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create</button></div>`,
    (mb, close) => {
      qs('#s', mb).onclick = async () => {
        const f = formData(mb);
        if (!f.name.trim()) return toast('Enter a name', 'err');
        try { await api('/stores/categories', { method: 'POST', body: { name: f.name, code: f.code } }); close(); toast('Category created'); reload(); }
        catch (e) { toast(e.message, 'err'); }
      };
    });

  qsa('[data-add]').forEach((b) => b.onclick = () => nameModal('New sub-category', '',
    (nm) => api('/stores/categories', { method: 'POST', body: { parent_id: b.dataset.add, name: nm } })));

  qsa('[data-ren]').forEach((b) => b.onclick = () => nameModal('Rename "' + b.dataset.name + '"', b.dataset.name,
    (nm) => api('/stores/categories/' + b.dataset.ren, { method: 'PATCH', body: { name: nm } })));

  qsa('[data-move]').forEach((b) => b.onclick = () => modal('Move "' + b.dataset.name + '"', `
    <p class="muted">Move this sub-category under a different category. Every record under it is relabelled.</p>
    ${field('New parent category', 'parent_id', { type: 'select', value: b.dataset.parent, options: tree.map((p) => ({ value: p.id, label: p.name })) })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Move</button></div>`,
    (mb, close) => {
      qs('#s', mb).onclick = async () => {
        try { await api('/stores/categories/' + b.dataset.move, { method: 'PATCH', body: { parent_id: formData(mb).parent_id } }); close(); toast('Moved'); reload(); }
        catch (e) { toast(e.message, 'err'); }
      };
    }));

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
      (mb, close) => {
        qs('#s', mb).onclick = async () => {
          try {
            const r = await api('/stores/categories/' + b.dataset.merge + '/merge', { method: 'POST', body: { into_id: formData(mb).into_id } });
            close(); toast(`Merged — ${r.records} record(s) moved`); reload();
          } catch (e) { toast(e.message, 'err'); }
        };
      });
  });

  qsa('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this category? Only empty ones can be deleted.')) return;
    try { await api('/stores/categories/' + b.dataset.del, { method: 'DELETE' }); toast('Deleted'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

// ---- Material Pipeline Cockpit Hub (ReQuest ➔ Received ➔ Issue) ------------
// ---- Stores plan, Part 1: the Monitor and the list of requested items -------------------------
// src/lib/stores_flow.js. Every requested item walks one road — requested, approved, bought,
// received, priced, issued — and each screen here reads where it has got to.
const FLOW_STEPS = [
  ['open', 'All to do'], ['requested', 'To certify'], ['certified', 'To approve'], ['to_buy', 'To buy'],
  ['on_order', 'On order'], ['unpriced', 'To price'], ['ready', 'Ready to issue'], ['done', 'Done'],
  ['rejected', 'Rejected'], ['all', 'All (with imported history)'],
];
const FLOW_STEP_LABEL = Object.fromEntries(FLOW_STEPS.concat([['imported', 'Imported history']]));
const FLOW_KINDS = [['', 'All kinds'], ['general', 'Parts & general'], ['oil', 'Lubricants'], ['filter', 'Filters'], ['tyre', 'Tyres'], ['battery', 'Batteries']];
const FLOW_KIND_LABEL = Object.fromEntries(FLOW_KINDS);
const ROAD_WORD = { done: 'done', part: 'part done', now: 'waiting here', todo: 'not yet', stop: 'stopped' };
const roadBar = (r) => `<div class="road">${r.road.map((x) => `<span class="rd rd-${x.state}" title="${esc(x.label)}: ${ROAD_WORD[x.state] || x.state}">${esc(x.label)}</span>`).join('')}</div>`;

async function storesMonitor(body) {
  const m = await api('/stores/flow/monitor');
  const s = m.steps;
  const card = (n, label, href, tone, note) => `<a class="card stat" href="${href}" style="text-decoration:none">
      <span class="n"${tone && n ? ` style="color:var(--${tone})"` : ''}>${n}</span><span class="l">${esc(label)}</span>${note ? `<span class="muted" style="font-size:11px">${esc(note)}</span>` : ''}</a>`;
  const at = (step) => `#/stores?tab=flow&sub=lines&step=${step}`;
  body.innerHTML = `
    <p class="muted" style="margin-top:0">What is waiting at each step${m.store ? ` — ${esc(m.store.label)}` : ''}. Click a number to see the items.</p>
    <h3 style="margin:10px 0 6px">Requests</h3>
    <div class="grid">
      ${card(s.requested, 'To certify', at('requested'), 'amber', `${m.to_certify} request${m.to_certify === 1 ? '' : 's'}`)}
      ${card(s.certified, 'To approve', at('certified'), 'amber', `${m.to_approve} request${m.to_approve === 1 ? '' : 's'}`)}
      ${card(s.to_buy, 'To buy', at('to_buy'), 'amber')}
      ${card(s.on_order, 'On order', at('on_order'))}
    </div>
    <h3 style="margin:14px 0 6px">In the store</h3>
    <div class="grid">
      ${card(m.received_today, 'Received today', '#/stores?tab=flow&sub=grn')}
      ${card(s.unpriced, 'To price', at('unpriced'), 'amber', `${s.unpriced_receipts} receipt${s.unpriced_receipts === 1 ? '' : 's'} without a price`)}
      ${card(s.ready, 'Ready to issue', at('ready'), 'blue', 'received for a job, not handed over')}
      ${card(m.issued_today, 'Issued today', '#/stores?tab=flow&sub=issues')}
    </div>
    <h3 style="margin:14px 0 6px">Watch</h3>
    <div class="grid">
      ${card(m.transfers_week, 'Transfers (7 days)', '#/stores?tab=mtn')}
      ${card(m.low_stock, 'At or under reorder level', '#/stores?tab=stock', 'red')}
      ${card(m.battery_warranty, 'Battery warranties ending (60 days)', '#/stores?tab=stock&kind=battery&sub=register', 'amber')}
      ${card(s.open, 'All items still to do', at('open'))}
    </div>
    <h3 style="margin:14px 0 6px">Stock take</h3>
    <div class="grid">
      ${card(m.stock_takes.counting, 'Being counted', '#/stores?tab=counts&status=counting', 'blue')}
      ${card(m.stock_takes.submitted, 'Waiting for head office', '#/stores?tab=counts&status=submitted', 'amber')}
    </div>
    <h3 style="margin:14px 0 6px">Tyres, batteries &amp; scrap</h3>
    <div class="grid">
      ${card(m.old_units_due.tyre, 'Old tyres to record', '#/tbrequests?tab=returns&kind=tyre', 'amber', 'what came off the vehicle')}
      ${card(m.old_units_due.battery, 'Old batteries to record', '#/tbrequests?tab=returns&kind=battery', 'amber', 'what came off the vehicle')}
      ${card(m.disposals, 'Disposal notes to approve', '#/stores?tab=disposal&status=open', 'amber')}
    </div>`;
}

async function storesLines(body, sp) {
  const cur = { step: sp.get('step') || 'open', kind: sp.get('kind') || '', q: sp.get('q') || '', source: sp.get('source') || '' };
  if (!FLOW_STEPS.some(([k]) => k === cur.step)) cur.step = 'open';
  const counts = await api('/stores/flow/monitor').then((m) => m.steps).catch(() => ({}));
  body.innerHTML = `
    <div class="toolbar">
      <input id="flq" type="search" placeholder="Search request no / vehicle / item / job / supplier…" value="${esc(cur.q)}" style="max-width:300px">
      <select id="flkind" style="max-width:160px">${FLOW_KINDS.map(([v, l]) => `<option value="${v}" ${v === cur.kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="flsrc" style="max-width:160px"><option value="">All sources</option><option value="head_office" ${cur.source === 'head_office' ? 'selected' : ''}>Head Office</option><option value="local_purchase" ${cur.source === 'local_purchase' ? 'selected' : ''}>Local Purchase</option></select>
      <a class="btn sm" id="flxls" href="#">⬇ Excel</a>
      <div class="spacer"></div>
      ${canDo('stores.mrn.create') ? '<button class="sm" id="flnew">+ New request (MRN)</button>' : ''}
      ${canDo('stores.stock_issue') ? '<button class="sm primary" id="flissue">⚡ Direct issue</button>' : ''}
    </div>
    <div class="pill-row" style="margin:0 0 10px;flex-wrap:wrap;gap:6px">${FLOW_STEPS.map(([k, l]) => `<button class="sm ${k === cur.step ? 'primary' : ''}" data-step="${k}">${esc(l)}${counts[k] != null ? ` <span class="badge">${counts[k]}</span>` : ''}</button>`).join('')}</div>
    <div id="fltable"><div class="muted">Loading…</div></div>`;
  const qstr = () => {
    const p = new URLSearchParams({ step: cur.step });
    if (cur.kind) p.set('kind', cur.kind);
    if (cur.q) p.set('q', cur.q);
    if (cur.source) p.set('source', cur.source);
    return p.toString();
  };
  const canRx = canDo('stores.grn.receive');
  const canPrice = canDo('stores.grn.edit');
  const canIssue = canDo('stores.stock_issue');
  const load = async () => {
    history.replaceState(null, '', '#/stores?tab=flow&sub=lines&' + qstr());
    qs('#flxls', body).href = '/api/stores/flow/export.xlsx?' + qstr();
    let rows;
    try { rows = await api('/stores/flow?limit=300&' + qstr()); } catch (e) { qs('#fltable', body).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    const tb = (r) => r.kind === 'tyre' || r.kind === 'battery';
    const actions = (r) => {
      const b = [];
      const live = !['rejected', 'imported'].includes(r.step);
      const approved = r.road[1].state === 'done';
      if (live && canRx && approved && r.received < r.qty - 0.001) b.push(`<button class="sm" data-rx="${r.id}">📥 Receive</button>`);
      if (canPrice && r.price_grn) b.push(`<button class="sm" data-price="${r.id}">💲 Price</button>`);
      if (live && r.on_shelf > 0) {
        if (tb(r)) b.push('<a class="btn sm" href="#/tbrequests" title="Tyres and batteries are fitted from the Tyre &amp; Battery page">⚡ Issue</a>');
        else if (canIssue && r.shelf) b.push(`<button class="sm primary" data-iss="${r.id}">⚡ Issue</button>`);
      }
      b.push(`<a class="btn sm" href="#/stores?tab=mrn&id=${r.mrn_id}">Open</a>`);
      return b.join(' ');
    };
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    qs('#fltable', body).innerHTML = rows.length ? tableWrap(
      [{ label: 'Request' }, { label: 'Item', cls: 'desc-col' }, { label: 'Progress' }, { label: '' }],
      rows.map((r) => `<tr>
        <td><a href="#/stores?tab=mrn&id=${r.mrn_id}"><b>${esc(r.mrn_no || '')}</b></a> <span class="muted" style="font-size:11px">${esc(String(r.req_date || '').slice(0, 10))}${wsMulti() && r.workshop_code ? ' · ' + esc(r.workshop_code) : ''}</span>
          <br>${r.asset_reg || r.asset_code ? `<span class="stamp">${esc(r.asset_reg || r.asset_code)}</span>` : (r.request_type === 'general' ? '<span class="muted" style="font-size:12px">Store stock</span>' : '')}${r.job_no ? ` <a href="#/jobs/${r.job_id}" style="font-size:11px">${esc(r.job_no)}</a>` : ''}</td>
        <td class="desc-col">${esc(r.description || '')} <span class="badge">${esc(FLOW_KIND_LABEL[r.kind] || r.kind)}</span>
          <br><span class="muted" style="font-size:12px">received ${num(r.received)} of ${num(r.qty)}${r.issued > 0 ? ` · issued ${num(r.issued)}` : ''}</span>${r.unpriced ? ` <span class="badge amber">${r.unpriced} unpriced</span>` : ''}</td>
        <td>${roadBar(r)}<span class="muted" style="font-size:11px">${esc(FLOW_STEP_LABEL[r.step] || r.step)}</span></td>
        <td><div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end">${actions(r)}</div></td></tr>`),
      { scroll: true })
      + (rows.length === 300 ? '<p class="muted" style="font-size:12px">Showing the newest 300. Search or choose a step to narrow the list.</p>' : '')
      : '<div class="card"><p class="muted">Nothing here.</p></div>';
    qsa('[data-rx]', body).forEach((b) => { b.onclick = () => flowReceiveModal(byId.get(b.dataset.rx), load); });
    qsa('[data-price]', body).forEach((b) => { b.onclick = () => grnPriceModal(byId.get(b.dataset.price).price_grn, load); });
    qsa('[data-iss]', body).forEach((b) => {
      b.onclick = () => {
        const r = byId.get(b.dataset.iss);
        newIssueModal(load, { grn_id: r.shelf.grn_id, grn_no: r.shelf.grn_no, mrn_no: r.mrn_no, description: r.description, section: r.shelf.section,
          unit: r.shelf.unit, unit_price: r.shelf.unit_price, remaining: r.shelf.remaining, job_id: r.job_id, job_no: r.job_no,
          asset_id: r.asset_id, asset_code: r.asset_reg || r.asset_code });
      };
    });
  };
  qsa('[data-step]', body).forEach((b) => { b.onclick = () => { cur.step = b.dataset.step; qsa('[data-step]', body).forEach((x) => x.classList.toggle('primary', x === b)); load(); }; });
  qs('#flkind', body).onchange = (e) => { cur.kind = e.target.value; load(); };
  qs('#flsrc', body).onchange = (e) => { cur.source = e.target.value; load(); };
  let deb; qs('#flq', body).oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { cur.q = e.target.value.trim(); load(); }, 250); };
  if (qs('#flnew', body)) qs('#flnew', body).onclick = () => newMrnModal();
  if (qs('#flissue', body)) qs('#flissue', body).onclick = () => newIssueModal(load);
  await load();
}

// Mark an item received: how many came, when, and — if known — from whom and at what price. The
// price can follow later. The server refuses more than was asked for.
function flowReceiveModal(r, onDone) {
  const left = Math.round((r.qty - r.received) * 100) / 100;
  modal('Mark received · ' + r.description, `
    <p class="muted" style="margin-top:0">Request ${esc(r.mrn_no)} · asked ${num(r.qty)} · received so far ${num(r.received)}</p>
    ${field('Quantity received now *', 'qty', { type: 'number', value: left })}
    ${field('Date received', 'delivery_date', { type: 'date', value: localNowInput().slice(0, 10) })}
    <div class="row"><div>${field('Supplier', 'supplier', { value: r.bought_from || '' })}</div><div>${field('Invoice no', 'invoice_no')}</div></div>
    ${field('Unit price (Rs) — can be added later', 'unit_price', { type: 'number' })}
    ${r.kind === 'filter' ? field('Part number on the box, if different', 'received_part_no') : ''}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Mark received</button></div>`, (mb, close) => {
    qs('#s', mb).onclick = async () => {
      const f = formData(mb);
      if (!(Number(f.qty) > 0)) return toast('How many arrived?', 'err');
      try {
        const res = await api('/stores/grn/bulk-receive', { method: 'POST', body: { rows: [{
          mrn_line_id: r.id, qty: f.qty, delivery_date: f.delivery_date || undefined, supplier: f.supplier || undefined,
          invoice_no: f.invoice_no || undefined, unit_price: f.unit_price === '' ? undefined : f.unit_price, received_part_no: f.received_part_no || undefined,
        }] } });
        if (!res.received) return toast('Not received: ' + (((res.skipped || [])[0] || {}).reason || 'nothing to receive'), 'err');
        close(); toast('Received ' + num(f.qty)); if (onDone) onDone();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- Receive & Price workspace ---------------------------------------------
// The two jobs a storekeeper repeats all day, done inline instead of one popup per row:
//   • RECEIVE  — type the qty (and price/supplier if known) straight onto the pending lines
//   • PRICE    — type prices down the column for stock that arrived without one
// Edits are held until "Save Changes", then written in a single batched request.
async function receivePriceTab(body) {
  const canRx = canDo('stores.grn.receive', 'stores.grn.edit');
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
      ${canDo('stores.mrn.create') ? '<button class="primary" id="nm">+ New MRN</button>' : ''}
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
  const canRx = canDo('stores.grn.receive');
  const canMrnEdit = canDo('stores.mrn.edit');
  const canGrnPrice = canDo('stores.grn.edit');
  const canGrnIssue = canDo('stores.stock_issue');
  const lineCol = canRx || canMrnEdit;          // the action column on the item lines
  const grnCol = canGrnPrice || canGrnIssue;    // the action column on the received records
  const astatus0 = m.approval_status || 'requested';
  const canEditLines = canMrnEdit && astatus0 !== 'approved' && astatus0 !== 'rejected'
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
      ${lineCol ? `<td class="num" style="white-space:nowrap">${remaining > 0 ? (canRx ? `<button class="sm primary" data-rx="${l.id}" data-desc="${esc(l.description || '')}" data-rem="${remaining}">Receive</button>` : '') : '✓'}${
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
    ${grnCol ? `<td class="num" style="white-space:nowrap">${canGrnIssue ? `<button class="sm primary" data-issue-grn="${g.id}" title="Issue this received item to vehicle or job card">⚡ Issue</button>` : ''} ${canGrnPrice ? `<button class="sm ${g.unit_price == null ? 'primary' : ''}" data-price="${g.id}">${g.unit_price == null ? 'Add price' : 'Edit'}</button>` : ''}</td>` : ''}</tr>`);
  const astatus = m.approval_status || 'requested';
  // Imported/historical MRNs (no live requester) predate the approval workflow → treat as approved.
  const isImported = astatus === 'requested' && !(m.requested_by && String(m.requested_by).trim());
  const aBadge = isImported
    ? '<span class="badge green">✓ Approved (imported)</span>'
    : ({ requested: '<span class="badge amber">Awaiting certification</span>', certified: '<span class="badge blue">Certified · awaiting approval</span>', approved: '<span class="badge green">✓ Approved</span>', rejected: '<span class="badge red">✕ Cancelled (rejected)</span>' }[astatus] || '');
  const sig = (name, at) => name ? `${esc(name)} <span class="muted">· ${esc((at || '').slice(0, 16).replace('T', ' '))}</span>` : '<span class="muted">pending</span>';
  // Correctable right up until approval. After that the request IS the authority to spend.
  const canEditReq = canMrnEdit && astatus !== 'approved' && astatus !== 'rejected' && !isImported;
  // A settled request — signed off, or an imported record shown as "approved (imported)" — is
  // frozen to everyone but an admin, who may still put a forgotten item on it rather than raise
  // a second request for one line. That covers almost the whole book: 25 approved and 1,651
  // imported. The approval is not disturbed; the item itself is marked, with the reason.
  const adminAmend = canDo('stores.mrn.amend_settled') && (astatus === 'approved' || isImported);
  const canCertify = !isImported && canDo('stores.mrn.certify') && astatus === 'requested';
  // Approval limit: above it, the Approve button gives way to who can approve instead.
  const worth = d.worth;
  const overLimit = !!(worth && worth.limit && !worth.limit.ok);
  const canApprove = canDo('stores.mrn.approve') && astatus === 'certified' && !overLimit;
  const canReject = !isImported && canDo('stores.mrn.reject') && astatus !== 'approved' && astatus !== 'rejected';
  const worthLine = worth ? `<p style="margin:8px 0 0;font-size:13px">Estimated value: <b>${esc(money(worth.value))}</b>
      <span class="muted">— quantity × last price paid${worth.unpriced ? `; ${worth.unpriced} item(s) have no price yet, so the real cost may be higher` : ''}</span>
      ${overLimit ? `<br><span class="badge amber">Above your approval limit (${esc(money(worth.limit.limit))})</span> Needs: ${esc(worth.limit.who_can.join(', '))}.` : ''}</p>` : '';
  body.innerHTML = `
    <div class="toolbar"><a class="btn sm" href="#/stores?tab=mrn">← MRN list</a><div class="spacer"></div><button class="btn sm primary" id="mrntrace">🔍 Trace Lifecycle</button> <a class="btn sm" href="/api/stores/mrn/${m.id}/print.html" target="_blank">🖨 Print MRN</a></div>
    <div class="card">
      <div class="toolbar" style="margin:0"><h3 style="margin:0">Approval flow</h3><div class="spacer"></div>${aBadge}
        ${canCertify ? '<button class="sm primary" id="mcertify">✍ Certify</button>' : ''}
        ${canApprove ? '<button class="sm primary" id="mapprove">✅ Approve</button>' : ''}
        ${canReject ? '<button class="sm danger" id="mreject">Reject</button>' : ''}
      </div>
      ${worthLine}
      ${isImported ? `<p class="muted" style="margin:8px 0 0">Imported record — predates the approval workflow, so it is treated as already approved. No certification/approval is required.${adminAmend ? ' As an admin you may still add a forgotten item to it: the item is marked as added later, with your reason.' : ''}</p>` : `
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
      <p class="muted">Date ${esc((m.req_date || '').slice(0, 10))}${wsMulti() && m.workshop_name ? ` · Workshop ${esc(m.workshop_name)}` : ''} · Vehicle ${esc(idLabel(m) || '—')} · Job ${m.job_no ? `<a href="#/jobs/${m.job_id}">${esc(m.job_no)}</a> <span class="badge ${STATUS_CLASS[m.job_status] || ''}">${esc(m.job_status || '')}</span>` : 'not linked'} · Source ${esc(sourceLabel(m.purchase_source))}${m.purpose ? ' · ' + esc(m.purpose) : ''}${m.requested_by ? ' · by ' + esc(m.requested_by) : ''}</p>
      ${canEditReq && astatus === 'certified' ? '<p class="muted" style="font-size:12px;margin:0 0 6px">This request is certified. Changing what was asked for withdraws that certification and sends it back to the Workshop Engineer.</p>' : ''}
      ${astatus === 'approved' ? `<p class="muted" style="font-size:12px;margin:0 0 6px">Approved — the request is now the authority to spend, so it can no longer be changed.${
      // Telling an admin it cannot be changed, next to a button that changes it, would be a lie.
      adminAmend ? ' As an admin you may still add a forgotten item: the approval stands, and the item is marked as added after it.' : ''}</p>` : ''}
      ${tableWrap([{ label: 'Item description' }, { label: 'Category' }, { label: 'Qty requested', num: true }, { label: 'Qty received', num: true }, { label: 'Received date' }, { label: 'Remaining', num: true }, { label: 'Status' }].concat(lineCol ? [{ label: '', num: true }] : []), lineRows, { scroll: true })}
    </div>
    <div class="card">
      <h3>Received records — GRN <span class="muted">(${d.grns.length})</span></h3>
      ${d.grns.length
      ? tableWrap([{ label: 'GRN No' }, { label: 'Received' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Unit Price', num: true }, { label: 'Value', num: true }, { label: 'Supplier' }, { label: 'Source' }].concat(grnCol ? [{ label: '', num: true }] : []), grnRows, { scroll: true })
      : '<p class="muted">Nothing received against this MRN yet.</p>'}
    </div>`;
  if (lineCol || grnCol) {
    qsa('[data-rx]').forEach((btn) => btn.onclick = () => receiveModal(m, btn.dataset.rx, btn.dataset.desc, btn.dataset.rem, () => mrnDetail(body, id)));
    qsa('[data-price]').forEach((btn) => btn.onclick = () => grnPriceModal(d.grns.find((x) => String(x.id) === btn.dataset.price), () => mrnDetail(body, id)));
    qsa('[data-issue-grn]').forEach((btn) => btn.onclick = () => {
      const g = d.grns.find((x) => String(x.id) === btn.dataset.issueGrn);
      if (!g) return;
      newIssueModal(() => mrnDetail(body, id), {
        job_id: m.job_id,
        asset_id: m.asset_id,
        vehicle: idLabel(m),
        grn_id: g.id,
        mrn_no: m.mrn_no,
        grn_no: g.grn_no,
        description: g.description,
        qty: g.qty,
        unit_price: g.unit_price,
        section: sectionOf(g.description),
      });
    });
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

  if (qs('#mrntrace')) qs('#mrntrace').onclick = () => pipelineTraceModal({ mrn_id: m.id });
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
    ${field('Purchase source', 'purchase_source', {
    type: 'select', value: m.purchase_source || '',
    options: [{ value: '', label: '—' }, { value: 'head_office', label: 'Head Office' }, { value: 'local_purchase', label: 'Local Purchase' }]
  })}
    <p class="muted" style="font-size:12px;margin:6px 0 0">The machine and job this request is for are set when it is raised — reject and re-raise if those are wrong.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save changes</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      const f = formData(b);
      try {
        told(await api('/stores/mrn/' + m.id, {
          method: 'PATCH', body: {
            req_date: f.req_date, required_date: f.required_date, requested_by: f.requested_by,
            purpose: f.purpose, purchase_source: f.purchase_source,
          }
        }));
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
          await api('/stores/grn', {
            method: 'POST', body: {
              mrn_id: mrn.id, mrn_line_id: lineId, description: desc, qty: f.qty,
              unit_price: f.unit_price, purchase_source: f.purchase_source || undefined,
              supplier: f.supplier, grn_no: f.grn_no, invoice_no: f.invoice_no, delivery_date: f.delivery_date,
            }
          });
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
          await api('/stores/grn/' + g.id, {
            method: 'PATCH', body: {
              unit_price: f.unit_price, supplier: f.supplier, invoice_no: f.invoice_no,
              invoice_date: f.invoice_date, purchase_source: f.purchase_source || undefined,
            }
          });
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
function wireMrnTarget(root, idp, opts) {
  const state = { type: 'vehicle', job_id: '' };
  const veh = qs('#' + idp + '_veh', root), jobsEl = qs('#' + idp + '_jobs', root);
  wireAssetPicker(root);
  const hidden = qs('input[name=asset_id]', root), input = qs('.apick-input', root);
  qsa('input[name=' + idp + '_type]', root).forEach((r) => {
    r.onchange = () => {
      state.type = r.value;
      veh.style.display = r.value === 'vehicle' ? 'block' : 'none';
      // Coming back to Machine/Vehicle, the select is still on screen showing a card — so the
      // state has to agree with it, or the request saves unlinked while claiming otherwise.
      const sel = qs(`select[name=${idp}_job]`, jobsEl);
      state.job_id = r.value === 'general' ? '' : (sel ? sel.value : '');
    };
  });

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
      <select name="${idp}_job">${open.map((j) => `<option value="${j.id}" ${opts && opts.job_id && String(opts.job_id) === String(j.id) ? 'selected' : ''}>${esc(j.job_no)} · ${esc(j.status)}</option>`).join('')}<option value="">— none —</option></select>
      ${open.length > 1 ? `<div class="muted" style="font-size:12px;margin-top:4px">${open.length - 1} older open card${open.length > 2 ? 's' : ''} on this vehicle — the newest is pre-selected.</div>` : ''}`;
    const sel = qs(`select[name=${idp}_job]`, jobsEl);
    state.job_id = sel ? sel.value : '';
    if (sel) sel.onchange = () => { state.job_id = sel.value; };
  };
  // The asset picker fills its hidden id on mousedown — hook the same event.
  root.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.apick-item')) setTimeout(loadJobs, 0);
  }, true);
  if (input) input.addEventListener('input', () => { state.job_id = ''; jobsEl.innerHTML = 'Any vehicle can be requested for — a job card is optional.'; });

  if (opts && opts.asset_id) {
    hidden.value = opts.asset_id;
    if (input) input.value = opts.asset_code || opts.vehicle || '';
    setTimeout(loadJobs, 50);
  }

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
      qsa('.mrnpick', menu).forEach((it) => {
        it.onmousedown = (e) => {
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
        };
      });
    }, 220);
  };
  input.onblur = () => setTimeout(close, 150);
}

async function newMrnModal(opts = {}) {
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
        ${fld('Project / Workshop', 'purpose', { placeholder: 'e.g. Badalgama W/Shop', value: opts.purpose || '' })}
        ${fld('Requested by', 'requested_by', { placeholder: 'name', value: opts.requested_by || (ME ? (ME.fullName || ME.username) : '') })}
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
    const getTarget = wireMrnTarget(body, 'mrnt', opts);
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
      qsa('.ipick', menu).forEach((el) => {
        el.onmousedown = (e) => {
          e.preventDefault();
          clearTimeout(deb);
          input.value = el.dataset.name;
          hId.value = el.dataset.id;
          if (el.dataset.price && price && !price.value) price.value = el.dataset.price;
          if (el.dataset.cat) setCategoryPicker(root, el.dataset.cat);
          close();
        };
      });
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

function newIssueModal(onDone, prefill) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];          // the items about to go out
  let section = (prefill && prefill.section) || '';
  let mode = (prefill && prefill.asset_id && !prefill.job_id) ? 'vehicle' : 'job';

  if (prefill && prefill.grn_id) {
    const code = prefill.mrn_no ? 'MRN ' + prefill.mrn_no : (prefill.grn_no ? 'GRN ' + prefill.grn_no : 'GRN #' + prefill.grn_id);
    lines.push({
      grn_id: prefill.grn_id,
      id: 'grn' + prefill.grn_id,
      code,
      name: prefill.description,
      section: prefill.section || 'general',
      unit: prefill.unit || 'nos',
      unit_price: prefill.unit_price,
      balance: prefill.remaining != null ? prefill.remaining : (prefill.qty || 1),
      qty: prefill.remaining != null ? prefill.remaining : (prefill.qty || 1),
      note: prefill.note || '',
    });
  }

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
      const getJob = wireJobPicker(body, 'nis-job', prefill);
      wireAssetPicker(body);
      if (prefill && prefill.asset_id) {
        const hVeh = qs('#ni-veh input[type=hidden]', body);
        const inVeh = qs('#ni-veh .apick-input', body);
        if (hVeh) hVeh.value = prefill.asset_id;
        if (inVeh) inVeh.value = prefill.vehicle || prefill.asset_code || '';
      }
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
      if (mode === 'vehicle') setMode('vehicle');

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
          // Stage 4: with a job card chosen, the balance is its workshop's store's.
          api('/stores/stock-items/search?limit=25&section=' + encodeURIComponent(section) + '&q=' + encodeURIComponent(term)
            + (mode === 'job' && getJob().job_id ? '&job_id=' + encodeURIComponent(getJob().job_id) : '')).catch(() => []),
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
  // The list is the Job Cards page's Requests tab now (job cards plan, Part 1).
  location.replace('#/jobs?tab=requests' + (/[?&]q=/.test(location.hash) ? '&q=' + encodeURIComponent(new URLSearchParams(location.hash.split('?')[1]).get('q')) : ''));
};

async function jobRequestDetail(c, id) {
  const d = await api('/job-requests/' + id);
  const r = d.request;
  const st = r.approval_status || 'requested';
  const sig = (name, at) => name ? `${esc(name)} <span class="muted">· ${esc((at || '').slice(0, 16).replace('T', ' '))}</span>` : '<span class="muted">pending</span>';
  const canCertify = canDo('jobrequests.certify') && st === 'requested';
  const canApprove = canDo('jobrequests.approve') && st === 'certified';
  const canReject = canDo('jobrequests.reject') && st !== 'approved' && st !== 'rejected';
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
async function renderOilSection(c) {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = ['products', 'names', 'ledger', 'stock', 'forecast', 'counts'].includes(sp.get('sub') || sp.get('tab')) ? (sp.get('sub') || sp.get('tab')) : 'products';
  const tabs = ['products', 'names', 'ledger', 'stock', 'forecast', 'counts'];
  const setTab = (t) => {
    if (location.hash.startsWith('#/stocktake') || location.hash.startsWith('#/stores')) location.hash = stockBooksHash('oil', t);
    else location.hash = '#/oil?tab=' + t;
  };
  c.innerHTML = `<div class="toolbar" style="margin-bottom:12px">${tabs.map((t) => `<button class="sm ${t === tab ? 'primary' : ''}" id="oil-tb-${t}">${t.toUpperCase()}</button>`).join('')}<div class="spacer"></div><a class="btn sm" href="/api/oil/export/ledger.xlsx">⬇ Ledger Excel</a></div><div id="oilbody" class="muted">Loading…</div>`;
  tabs.forEach((t) => {
    const btn = qs('#oil-tb-' + t, c);
    if (btn) btn.onclick = () => setTab(t);
  });
  const body = qs('#oilbody', c);
  if (tab === 'stock') {
    return stockPanel(body, 'oil');
  } else if (tab === 'products') {
    const list = await api('/oil/products');
    body.innerHTML = `${canDo('oil.ledger.post', 'oil.products.edit') ? `<div class="toolbar">${canDo('oil.ledger.post') ? '<button class="primary" id="ntop">⛽ Issue a lubricant</button>' : ''}${canDo('oil.products.edit') ? '<button class="sm" id="np">+ New Product</button>' : ''}${canDo('oil.ledger.post') ? '<button class="sm" id="nl">+ Ledger Txn</button>' : ''}</div>` : ''}
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
    const editable = canDo('oil.identity.resolve');
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
    qsa('[data-alias]', body).forEach((sel) => {
      sel.onchange = async () => {
        try {
          await api('/oil/aliases/' + sel.dataset.alias, { method: 'PATCH', body: { product_id: sel.value || null } });
          toast(sel.value ? 'Name identified — rebuild stock to apply it' : 'Marked as not a lubricant');
          renderOilSection(c);
        } catch (e) { toast(e.message, 'err'); sel.value = ''; }
      };
    });
    qsa('[data-reopen]', body).forEach((b) => {
      b.onclick = async () => {
        try {
          await api('/oil/aliases/' + b.dataset.reopen, { method: 'PATCH', body: { reset: true } });
          toast('Back on the list to identify'); renderOilSection(c);
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  } else if (tab === 'ledger') {
    const list = await api('/oil/ledger');
    const svcRef = (l) => { const m = String(l.note || '').match(/Service record #(\d+)/); return m ? m[1] : null; };
    body.innerHTML = `<p class="muted" style="margin-top:0">Issues tagged <span class="badge blue">Service</span> are consumed by a service record — their <b>cost is counted in that service</b>, not here (stock-out only, to avoid double-counting).</p>` +
      tableWrap([{ label: 'Date' }, { label: 'Product' }, { label: 'Kind' }, { label: 'Qty', num: true }, { label: 'Balance', num: true }, { label: 'Unit Price', num: true }, { label: 'Asset' }, { label: 'Reference' }],
        list.map((l) => { const sid = svcRef(l); return `<tr${sid ? ' style="background:rgba(46,120,210,.05)"' : ''}><td>${esc(l.txn_date)}</td><td>${esc(l.product_name)}</td><td><span class="badge ${l.kind === 'issue' ? 'amber' : 'green'}">${esc(l.kind)}</span></td><td class="num">${num(l.qty)}</td><td class="num">${num(l.balance_after)}</td><td class="num">${sid ? '<span class="muted">' + money(l.unit_price) + '</span>' : money(l.unit_price)}</td><td>${esc(l.asset_code || '')}</td><td>${sid ? `<a href="#/services/${sid}"><span class="badge blue">Service #${sid}</span></a>` : esc(l.consumer || l.note || '')}</td></tr>`; }), { scroll: true });
  } else if (tab === 'forecast') {
    const f = await api('/oil/forecast');
    body.innerHTML = `<p class="muted">Days-of-cover from consumption over the last ${f.window_days} days; low-stock threshold ${f.low_stock_days} days.</p>` +
      tableWrap([{ label: 'Product' }, { label: 'Balance', num: true }, { label: 'Daily Use', num: true }, { label: 'Days Cover', num: true }, { label: 'Reorder?' }],
        f.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${num(p.balance)} ${esc(p.unit)}</td><td class="num">${num(p.daily_rate)}</td><td class="num">${p.days_of_cover == null ? '∞' : num(p.days_of_cover)}</td><td>${p.suggested_reorder ? '<span class="badge red">ORDER</span>' : '<span class="badge green">ok</span>'}</td></tr>`), { scroll: true });
  } else if (tab === 'counts') {
    const list = await api('/oil/counts');
    body.innerHTML = `${canDo('oil.count') ? '<div class="toolbar"><button class="primary" id="nc">+ New Count</button></div>' : ''}
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
}

routes.oil = async () => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const sub = sp.get('tab') || 'products';
  location.replace('#/stocktake?tab=oil' + (sub !== 'products' ? '&sub=' + sub : ''));
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
async function renderBatteriesSection(c, params) {
  if (params && params[0]) return batteryDetail(c, params[0]);
  const list = await api('/batteries');
  const radar = await api('/batteries/warranty-radar');
  c.innerHTML = `
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
  if (qs('#nb', c)) qs('#nb', c).onclick = newBatteryModal;
}

routes.batteries = async (c, params) => {
  if (params && params[0]) return batteryDetail(c, params[0]);
  location.replace('#/stocktake?tab=batteries');
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
  qsa('[data-delphoto]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Remove this photo?')) return;
      try { await api(`/batteries/${id}/photos/${btn.dataset.delphoto}`, { method: 'DELETE' }); toast('Photo removed'); batteryDetail(c, id); }
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

// ---- Filters — the unified filter stock position + price book + service records + cross-references -------------
routes.services = async (c, params) => {
  if (params[0] === 'new-service' || params[0] === 'new') return renderNewServiceForm(c);
  if (params[0] === 'service' && params[1] && params[2] === 'edit') {
    if (!canEdit('services')) return toast('You do not have permission to edit services', 'err');
    return renderNewServiceForm(c, await api('/filters/services/' + params[1]));
  }
  if (params[0] && params[1] === 'edit') {
    if (!canEdit('services')) return toast('You do not have permission to edit services', 'err');
    return renderNewServiceForm(c, await api('/filters/services/' + params[0]));
  }
  if (params[0] === 'service' && params[1]) return serviceDetail(c, params[1]);
  if (params[0]) return serviceDetail(c, params[0]);
  c.innerHTML = `${pageHeader('Service Records', 'Vehicle & machinery maintenance service logs, meter readings, and service histories.')}
    <div id="spane"><div class="muted">Loading…</div></div>`;
  await renderServiceRecords(qs('#spane', c));
};

async function renderFiltersSection(c) {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = ['book', 'xref'].includes(sp.get('sub') || sp.get('tab')) ? (sp.get('sub') || sp.get('tab')) : 'book';
  const setTab = (t) => {
    if (location.hash.startsWith('#/stocktake') || location.hash.startsWith('#/stores')) location.hash = stockBooksHash('filter', t);
    else location.hash = '#/filters?tab=' + t;
  };
  c.innerHTML = `
    <div class="pill-row" style="margin-bottom:12px">
      <button class="btn sm ${tab === 'book' ? 'primary' : ''}" id="tb-book">Price Book</button>
      <button class="btn sm ${tab === 'xref' ? 'primary' : ''}" id="tb-xref">Cross-References</button>
    </div>
    <div id="fpane"><div class="muted">Loading…</div></div>`;
  qs('#tb-book', c).onclick = () => setTab('book');
  qs('#tb-xref', c).onclick = () => setTab('xref');
  if (tab === 'xref') await renderCrossRefs(qs('#fpane', c));
  else await renderPriceBook(qs('#fpane', c));
}

routes.filters = async (c, params) => {
  if (params && (params[0] === 'new-service' || params[0] === 'service')) {
    if (params[0] === 'new-service') return location.replace('#/services/new');
    if (params[1] && params[2] === 'edit') return location.replace('#/services/' + params[1] + '/edit');
    if (params[1]) return location.replace('#/services/' + params[1]);
  }
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  if (sp.get('tab') === 'services') return location.replace('#/services');
  const sub = sp.get('tab') || 'book';
  location.replace('#/stocktake?tab=filters' + (sub !== 'book' ? '&sub=' + sub : ''));
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
  const editable = canEdit('services');
  c.innerHTML = `
    <div class="toolbar" style="gap:8px;flex-wrap:wrap">
      ${editable ? '<button class="primary" id="nsvc">+ New Service</button>' : ''}
      <input id="sq" type="search" placeholder="Search vehicle / site / type…" style="max-width:240px">
      <select id="vselect" style="max-width:220px;background:#fff;border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:13px">
        <option value="">— Quick Vehicle History —</option>
      </select>
      <button type="button" class="btn sm" id="btn-toggle-all" title="Expand or collapse all service details on screen">▼ Expand All</button>
      <div class="spacer"></div>
      <span class="muted" id="scount"></span>
    </div>
    <div id="stable"><div class="muted">Loading…</div></div>`;

  // Populate vehicle selector dropdown for 1-click vehicle history
  try {
    const assets = await api('/assets');
    if (Array.isArray(assets) && assets.length && qs('#vselect', c)) {
      const items = assets
        .map((a) => {
          const val = (a.code || a.registration || a.ec_code || '').trim();
          const label = [a.code, a.registration || a.ec_code].filter(Boolean).join(' · ') || val;
          return { val, label };
        })
        .filter((x) => x.val && x.label);
      const seen = new Set();
      const unique = [];
      for (const it of items) {
        if (!seen.has(it.val.toUpperCase())) {
          seen.add(it.val.toUpperCase());
          unique.push(it);
        }
      }
      unique.sort((a, b) => a.label.localeCompare(b.label));
      qs('#vselect', c).innerHTML = '<option value="">— Quick Vehicle History —</option>' +
        unique.map((o) => `<option value="${esc(o.val)}">${esc(o.label)}</option>`).join('');
    }
  } catch (e) {
    console.warn('Could not populate vehicle dropdown:', e && e.message);
  }

  // In-memory cache for loaded service details (instant re-open with 0ms delay)
  const svcCache = new Map();
  let allExpanded = false;

  const buildServiceHistoryHtml = (s, d) => {
    const filters = d.filters || [];
    const oils = d.oils || [];
    const parts = d.parts || [];
    const svc = d.service || s;
    const upk = { Good: 'green', Fair: 'amber', Bad: 'red' }[svc.upkeeping] || '';
    const vehLabel = esc(idLabel(svc) || svc.vehicle_label || 'Vehicle');

    const filtersHtml = filters.length ? `
      <table class="table sm" style="margin:0;width:100%;font-size:12px">
        <thead><tr><th>Filter #</th><th>Category</th><th class="num">Qty</th><th>Action</th><th class="num">Price</th></tr></thead>
        <tbody>
          ${filters.map((f) => `<tr${f.book_price > 0 ? '' : ' style="background:rgba(224,168,0,.08)"'}>
            <td><b>${esc(f.filter_no || '—')}</b></td>
            <td>${esc(f.category || '—')}</td>
            <td class="num">${num(f.qty)}</td>
            <td><span class="badge ${f.action_type === 'Cleaned' ? 'blue' : 'green'}">${esc(f.action_type || 'Replaced')}</span></td>
            <td class="num">${f.book_price > 0 ? money(f.book_price) : (f.price > 0 ? money(f.price) : '<span class="badge amber">no price</span>')}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<p class="muted" style="margin:4px 0;font-size:12px">No filters recorded on this service.</p>';

    const oilsHtml = oils.length ? `
      <table class="table sm" style="margin:0;width:100%;font-size:12px">
        <thead><tr><th>Oil / Lubricant</th><th>Type</th><th class="num">Liters</th><th class="num">Price</th></tr></thead>
        <tbody>
          ${oils.map((o) => `<tr>
            <td><b>${esc(o.oil_name || '—')}</b></td>
            <td>${esc(o.oil_type || '—')}</td>
            <td class="num">${num(o.qty)} L</td>
            <td class="num">${o.price > 0 ? money(o.price) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<p class="muted" style="margin:4px 0;font-size:12px">No oils or lubricants recorded.</p>';

    const partsHtml = parts.length ? `
      <div style="margin-top:8px">
        <div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px">Other Spares / Costs</div>
        <table class="table sm" style="margin:0;width:100%;font-size:12px">
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
          <tbody>
            ${parts.map((p) => `<tr><td>${esc(p.description || '')}</td><td class="num">${num(p.qty)} ${esc(p.unit || '')}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>` : '';

    return `
      <div class="svc-quick-panel" style="padding:14px 18px;background:var(--card-bg, #fff);border:1px solid #c7d2e0;border-radius:6px;margin:6px 8px 12px;box-shadow:0 3px 10px rgba(0,0,0,0.06)">
        <!-- Top info bar -->
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid var(--border)">
          <div><span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Vehicle</span><b>${vehLabel}</b></div>
          <div><span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Service Date</span>${esc((svc.service_date || '').slice(0, 10))}</div>
          ${svc.job_no ? `<div><span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Job Card</span><span class="badge blue">#${esc(svc.job_no)}</span></div>` : ''}
          ${svc.service_type ? `<div><span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Service Type</span>${esc(svc.service_type)}</div>` : ''}
          ${svc.site_location ? `<div><span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Location / Site</span>${esc(svc.site_location)}</div>` : ''}
          ${svc.meter_reading ? `<div><span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Meter Reading</span><span class="badge green">⏱️ ${esc(svc.meter_reading)}</span></div>` : ''}
          ${svc.next_service_meter ? `<div><span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Next Service Due</span><span class="badge">⏩ ${esc(svc.next_service_meter)}</span></div>` : ''}
          ${svc.upkeeping ? `<div><span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Condition</span><span class="badge ${upk}">${esc(svc.upkeeping)}</span></div>` : ''}
          <div style="margin-left:auto;text-align:right">
            <span class="muted" style="font-size:10px;font-weight:700;text-transform:uppercase;display:block">Total Computed Cost</span>
            <span style="font-weight:700;font-size:15px;color:var(--text, #111)">${money(svc.computed_cost || svc.grand_total)}</span>
          </div>
        </div>

        <!-- Details Grid -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:14px;margin-top:10px">
          <!-- Filters Column -->
          <div style="background:#fafbfc;border:1px solid var(--border);border-radius:6px;padding:8px 10px">
            <div style="font-weight:700;font-size:12px;color:var(--text);margin-bottom:6px">
              🧰 Filters Fitted / Serviced (${filters.length})
            </div>
            ${filtersHtml}
          </div>

          <!-- Oils Column -->
          <div style="background:#fafbfc;border:1px solid var(--border);border-radius:6px;padding:8px 10px">
            <div style="font-weight:700;font-size:12px;color:var(--text);margin-bottom:6px">
              🛢️ Oils & Lubricants (${oils.length})
            </div>
            ${oilsHtml}
          </div>

          <!-- Notes & Spares -->
          ${(svc.repair_details || parts.length) ? `
          <div style="background:#fafbfc;border:1px solid var(--border);border-radius:6px;padding:8px 10px">
            <div style="font-weight:700;font-size:12px;color:var(--text);margin-bottom:6px">
              📝 Repair Notes & Additional Spares
            </div>
            ${svc.repair_details ? `<div style="font-size:12px;white-space:pre-wrap;background:#fff;border:1px solid var(--border);border-radius:4px;padding:6px 8px;margin-bottom:6px">${esc(svc.repair_details)}</div>` : ''}
            ${partsHtml}
          </div>` : ''}
        </div>

        <!-- Action Toolbar -->
        <div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:8px;border-top:1px solid var(--border)">
          <a class="btn sm primary" href="#/services/${s.id}" title="Open the full service details and attachments">📄 Full View →</a>
          <a class="btn sm" href="/api/filters/services/${s.id}/print.html" target="_blank" title="Print this service sheet">🖨️ Print Sheet</a>
          ${editable ? `<a class="btn sm" href="#/services/${s.id}/edit" title="Edit this service record">✏️ Edit Service</a>` : ''}
          <div style="margin-left:auto">
            <button type="button" class="btn sm ghost svc-close-btn" data-id="${s.id}">▲ Close History</button>
          </div>
        </div>
      </div>
    `;
  };

  const toggleRow = async (tr, id, forceOpen) => {
    const existing = tr.nextElementSibling && tr.nextElementSibling.classList.contains('svc-detail-tr') ? tr.nextElementSibling : null;
    const btn = qs('.svc-expand-toggle', tr);
    const colCount = editable ? 11 : 10;

    if (existing && forceOpen !== true) {
      existing.remove();
      tr.classList.remove('svc-open-parent');
      tr.style.background = '';
      if (btn) { btn.innerHTML = '▶'; btn.title = 'View simple history'; }
      return;
    }

    if (!existing && forceOpen !== false) {
      tr.classList.add('svc-open-parent');
      tr.style.background = 'rgba(46, 120, 210, 0.05)';
      if (btn) { btn.innerHTML = '▼'; btn.title = 'Hide simple history'; }

      const detailTr = document.createElement('tr');
      detailTr.className = 'svc-detail-tr';
      detailTr.dataset.for = String(id);
      detailTr.innerHTML = `<td colspan="${colCount}" style="padding:0;background:var(--bg-subtle, #f6f8fa);border-top:none;border-bottom:2px solid #0969da">
        <div class="svc-detail-box" style="padding:12px;text-align:center"><span class="muted">Loading service history…</span></div>
      </td>`;
      detailTr.onclick = (e) => e.stopPropagation();
      tr.parentNode.insertBefore(detailTr, tr.nextSibling);

      const box = qs('.svc-detail-box', detailTr);
      try {
        let data = svcCache.get(id);
        if (!data) {
          data = await api('/filters/services/' + id);
          svcCache.set(id, data);
        }
        const s = (window._lastServicesList || []).find((x) => String(x.id) === String(id)) || data.service || {};
        box.outerHTML = buildServiceHistoryHtml(s, data);
        const closeBtn = qs(`.svc-close-btn[data-id="${id}"]`, detailTr);
        if (closeBtn) closeBtn.onclick = (e) => { e.stopPropagation(); toggleRow(tr, id, false); };
      } catch (err) {
        box.innerHTML = `<div style="padding:10px;color:var(--err,#cf222e)">Failed to load service details: ${esc(err.message)}</div>`;
      }
    }
  };

  const load = async () => {
    const q = qs('#sq', c).value.trim();
    const CAP = 500;
    const list = await api('/filters/services?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + 'limit=' + CAP);
    window._lastServicesList = list;
    qs('#scount', c).textContent = `${list.length} service${list.length === 1 ? '' : 's'}`
      + (list.length >= CAP ? ` — showing the newest ${CAP}, search a vehicle to narrow it` : '');

    qs('#stable', c).innerHTML = tableWrap(
      [
        { label: '▾', width: '38px' },
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
      list.map((s) => `<tr data-svc="${s.id}" style="cursor:pointer" title="Click row to view simple history">
        <td style="text-align:center"><button type="button" class="btn sm ghost svc-expand-toggle" data-id="${s.id}" title="View simple history" style="padding:1px 6px;font-size:11px;font-weight:700">▶</button></td>
        <td>${esc((s.service_date || '').slice(0, 10))}</td>
        <td class="desc-col"><b>${esc(idLabel(s) || s.vehicle_label || '—')}</b></td>
        <td class="desc-col">${esc(s.service_type || '')}</td>
        <td class="desc-col">${esc(s.site_location || '')}</td>
        <td class="num">${num(s.filter_count)}</td>
        <td class="num">${s.missing_count > 0 ? `<span class="badge amber">${num(s.missing_count)}</span>` : '<span class="badge green">0</span>'}</td>
        <td class="num">${money(s.labour_charge)}</td>
        <td class="num">${money(s.computed_cost)}</td>
        <td class="num"><input type="number" min="0" step="0.01" class="svc-out" data-id="${s.id}" value="${!s.outside_estimate ? '' : s.outside_estimate}" placeholder="—" style="width:100%;max-width:110px;box-sizing:border-box;text-align:right" ${editable ? '' : 'disabled'}></td>
        ${editable ? `<td><a class="btn sm svc-edit" href="#/services/${s.id}/edit" title="Edit this service">✏️</a></td>` : ''}</tr>`),
      { scroll: true, fit: true, noHScroll: true });

    // Wire row click to toggle simple history dropdown
    qsa('tr[data-svc]', c).forEach((tr) => {
      tr.onclick = () => toggleRow(tr, tr.dataset.svc);
    });
    // The outside-value box saves in place — clicks inside it must not toggle dropdown
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
    // The edit pencil must not toggle dropdown
    qsa('.svc-edit', c).forEach((a) => { a.onclick = (e) => e.stopPropagation(); });
    // Expand toggle button inside row
    qsa('.svc-expand-toggle', c).forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr[data-svc]');
        if (tr) toggleRow(tr, tr.dataset.svc);
      };
    });
  };

  if (qs('#nsvc', c)) qs('#nsvc', c).onclick = () => { location.hash = '#/services/new'; };
  let deb;
  qs('#sq', c).oninput = () => {
    if (qs('#vselect', c)) qs('#vselect', c).value = '';
    clearTimeout(deb);
    deb = setTimeout(load, 250);
  };
  if (qs('#vselect', c)) {
    qs('#vselect', c).onchange = () => {
      const val = qs('#vselect', c).value;
      qs('#sq', c).value = val;
      load();
    };
  }
  if (qs('#btn-toggle-all', c)) {
    qs('#btn-toggle-all', c).onclick = async () => {
      allExpanded = !allExpanded;
      qs('#btn-toggle-all', c).textContent = allExpanded ? '▲ Collapse All' : '▼ Expand All';
      const rows = Array.from(qsa('tr[data-svc]', c));
      for (const tr of rows) {
        await toggleRow(tr, tr.dataset.svc, allExpanded);
      }
    };
  }
  await load();
}

// ---- Operations: Vehicle Lubricant Capacities (Fleet_Oil_Lubricant_Capacities.xlsx) ---
routes.lubecapacities = async (c) => {
  const isAdmin = canDo('fleet.capacities.edit');   // may edit capacities (admin, unless given to another role)
  c.innerHTML = `
    ${pageHeader('Lubricant Capacities', 'Vehicle-wise oil & fluid capacities · Engine, gearbox, differential, hydraulics, coolant, and brake fluid')}
    <div id="lcap-pane"></div>
  `;
  await renderVehicleCapacitiesList(qs('#lcap-pane', c), isAdmin);
};

async function renderVehicleCapacitiesList(c, isAdmin) {
  c.innerHTML = `
    <div id="vlc-kpi" class="kpi-grid" style="margin-bottom:14px;display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px">
      <div class="card" style="padding:10px 12px;margin:0"><div class="muted" style="font-size:11px">TOTAL FLEET</div><div style="font-size:20px;font-weight:700" id="kpi-tot">—</div></div>
      <div class="card" style="padding:10px 12px;margin:0"><div class="muted" style="font-size:11px">CATEGORIES</div><div style="font-size:20px;font-weight:700" id="kpi-cat">—</div></div>
      <div class="card" style="padding:10px 12px;margin:0"><div class="muted" style="font-size:11px">ENGINE OIL SPECS</div><div style="font-size:20px;font-weight:700" id="kpi-eng">—</div></div>
      <div class="card" style="padding:10px 12px;margin:0"><div class="muted" style="font-size:11px">HYDRAULIC SPECS</div><div style="font-size:20px;font-weight:700" id="kpi-hyd">—</div></div>
      <div class="card" style="padding:10px 12px;margin:0"><div class="muted" style="font-size:11px">GEAR / DIFF SPECS</div><div style="font-size:20px;font-weight:700" id="kpi-gr">—</div></div>
      <div class="card" style="padding:10px 12px;margin:0"><div class="muted" style="font-size:11px">OWN HISTORY</div><div style="font-size:20px;font-weight:700;color:var(--primary)" id="kpi-own">—</div></div>
    </div>

    <div class="toolbar" style="margin-bottom:12px;gap:8px;flex-wrap:wrap">
      <input type="text" id="vlc-q" placeholder="Search vehicle code, reg, brand, model, category…" style="max-width:300px">
      <select id="vlc-cat" style="max-width:180px"><option value="">All Categories</option></select>
      <select id="vlc-basis" style="max-width:170px">
        <option value="">All Evidence Types</option>
        <option value="Own record">Own record (Green)</option>
        <option value="Same model">Same model (Blue)</option>
        <option value="Category median">Category median (Purple)</option>
        <option value="Estimate">Estimate (Orange)</option>
      </select>
      <div class="spacer"></div>
      ${isAdmin ? '<button class="primary sm" id="vlc-btn-new">+ Add Vehicle Capacity</button>' : '<span class="muted" style="font-size:12px;align-self:center">🔒 Admin only can edit</span>'}
    </div>
    <div id="vlc-table-wrap" class="muted">Loading table…</div>
  `;

  let deb;
  const load = async () => {
    const q = qs('#vlc-q', c).value.trim();
    const cat = qs('#vlc-cat', c).value;
    const basis = qs('#vlc-basis', c).value;

    let url = '/lubricant-capacities?limit=520';
    if (q) url += '&q=' + encodeURIComponent(q);
    if (cat) url += '&category=' + encodeURIComponent(cat);
    if (basis) url += '&basis=' + encodeURIComponent(basis);

    try {
      const data = await api(url);
      const items = data.items || [];
      const summary = data.summary || {};

      qs('#kpi-tot', c).textContent = num(summary.total_vehicles || items.length);
      qs('#kpi-cat', c).textContent = num(summary.total_categories || (data.categories || []).length);
      qs('#kpi-eng', c).textContent = num(summary.count_engine_oil || 0);
      qs('#kpi-hyd', c).textContent = num(summary.count_hydraulic || 0);
      qs('#kpi-gr', c).textContent = num((summary.count_gearbox || 0) + (summary.count_diff || 0));
      qs('#kpi-own', c).textContent = num(summary.count_own_records || 0);

      // Populate category filter once
      const catSelect = qs('#vlc-cat', c);
      if (catSelect && catSelect.children.length <= 1 && data.categories) {
        catSelect.innerHTML = '<option value="">All Categories (' + data.categories.length + ')</option>' +
          data.categories.map((k) => `<option value="${esc(k.category)}">${esc(k.category)} (${k.count})</option>`).join('');
        if (cat) catSelect.value = cat;
      }

      if (!items.length) {
        qs('#vlc-table-wrap', c).innerHTML = '<div class="card"><p class="muted">No vehicle lubricant capacities match your search criteria.</p></div>';
        return;
      }

      const basisBadge = (b) => {
        if (!b) return '—';
        if (b.includes('Own record')) return '<span class="badge green" title="Derived from this vehicle\'s own service history">Own record</span>';
        if (b.includes('Same model')) return '<span class="badge blue" title="Derived from same brand/model vehicles">Same model</span>';
        if (b.includes('Category median')) return '<span class="badge" style="background:#8a4fff;color:#fff" title="Median of other vehicles in category">Category median</span>';
        if (b.includes('Estimate')) return '<span class="badge amber" title="Typical equipment class estimate">Estimate</span>';
        return `<span class="badge">${esc(b)}</span>`;
      };

      const headers = [
        { label: 'Vehicle' },
        { label: 'Category' },
        { label: 'Brand & Model' },
        { label: 'Year', width: '60px' },
        { label: 'Engine Oil', num: true },
        { label: 'Gearbox', num: true },
        { label: 'Diff / Axle', num: true },
        { label: 'Hydraulic', num: true },
        { label: 'Other Fluids', num: true },
        { label: 'Evidence Basis' },
        { label: 'Actions', width: isAdmin ? '130px' : '75px' },
      ];

      const rows = items.map((it) => {
        const engText = it.engine_oil_l != null ? `<b>${num(it.engine_oil_l)} L</b>${it.engine_oil_grade ? `<br><span class="muted" style="font-size:11px">${esc(it.engine_oil_grade)}</span>` : ''}` : '<span class="muted">—</span>';
        const gearText = it.gearbox_oil_l != null ? `${num(it.gearbox_oil_l)} L${it.gearbox_oil_grade ? `<br><span class="muted" style="font-size:11px">${esc(it.gearbox_oil_grade)}</span>` : ''}` : '<span class="muted">—</span>';
        const diffText = it.diff_oil_l != null ? `${num(it.diff_oil_l)} L${it.diff_oil_grade ? `<br><span class="muted" style="font-size:11px">${esc(it.diff_oil_grade)}</span>` : ''}` : '<span class="muted">—</span>';
        const hydText = it.hydraulic_oil_l != null ? `<b>${num(it.hydraulic_oil_l)} L</b>` : '<span class="muted">—</span>';

        const otherParts = [];
        if (it.front_axle_oil_l) otherParts.push(`Front: ${num(it.front_axle_oil_l)}L`);
        if (it.final_drive_oil_l) otherParts.push(`Final: ${num(it.final_drive_oil_l)}L`);
        if (it.swing_oil_l) otherParts.push(`Swing: ${num(it.swing_oil_l)}L`);
        if (it.coolant_l) otherParts.push(`Coolant: ${num(it.coolant_l)}L`);
        if (it.brake_fluid_l) otherParts.push(`Brake: ${num(it.brake_fluid_l)}L`);
        const otherText = otherParts.length ? `<span style="font-size:11px">${otherParts.slice(0, 2).join('<br>')}${otherParts.length > 2 ? `<br><span class="muted">+${otherParts.length - 2} more</span>` : ''}</span>` : '<span class="muted">—</span>';

        const vehLabel = `<b>${esc(it.ec_no || it.registration || 'Vehicle #' + it.id)}</b>${(it.ec_no && it.registration) ? `<br><span class="muted" style="font-size:11px">${esc(it.registration)}</span>` : ''}`;

        return `<tr>
          <td><a href="javascript:void(0)" class="vlc-view-link" data-id="${it.id}" style="text-decoration:none">${vehLabel}</a></td>
          <td><span class="badge" style="font-size:11px">${esc(it.category || '—')}</span></td>
          <td><b>${esc(it.brand || '—')}</b> ${esc(it.model || '')}</td>
          <td>${esc(it.year || '—')}</td>
          <td class="num">${engText}</td>
          <td class="num">${gearText}</td>
          <td class="num">${diffText}</td>
          <td class="num">${hydText}</td>
          <td class="num">${otherText}</td>
          <td>${basisBadge(it.engine_oil_basis)}${it.engine_oil_records > 0 ? `<br><span class="muted" style="font-size:10.5px">${it.engine_oil_records} record${it.engine_oil_records === 1 ? '' : 's'}</span>` : ''}</td>
          <td>
            <button type="button" class="btn sm vlc-btn-view" data-id="${it.id}" title="View details and evidence">🔍 Details</button>
            ${isAdmin ? `<button type="button" class="btn sm vlc-btn-edit" data-id="${it.id}" title="Edit capacity values">✏️ Edit</button>` : ''}
          </td>
        </tr>`;
      });

      qs('#vlc-table-wrap', c).innerHTML = tableWrap(headers, rows, { scroll: true });

      // Wire detail views
      qsa('.vlc-btn-view, .vlc-view-link', c).forEach((el) => {
        el.onclick = () => showVehicleCapacityModal(el.dataset.id, isAdmin, load);
      });

      // Wire admin edit
      if (isAdmin) {
        qsa('.vlc-btn-edit', c).forEach((btn) => {
          btn.onclick = () => showVehicleCapacityEditModal(btn.dataset.id, load);
        });
      }

    } catch (e) {
      qs('#vlc-table-wrap', c).innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
    }
  };

  qs('#vlc-q', c).oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#vlc-cat', c).onchange = load;
  qs('#vlc-basis', c).onchange = load;

  if (isAdmin && qs('#vlc-btn-new', c)) {
    qs('#vlc-btn-new', c).onclick = () => showVehicleCapacityEditModal(null, load);
  }

  await load();
}

// Modal: Detailed View of Vehicle Capacities + Service Evidence History
async function showVehicleCapacityModal(id, isAdmin, onReload) {
  try {
    const data = await api('/lubricant-capacities/' + id);
    const it = data.item;
    const evidence = data.evidence || [];

    const fieldBlock = (label, val, unit = 'L', grade = null) => `
      <div style="background:#f8fafc;border:1px solid var(--border);border-radius:6px;padding:8px 10px">
        <div class="muted" style="font-size:11px;text-transform:uppercase">${esc(label)}</div>
        <div style="font-size:16px;font-weight:700;margin-top:2px">
          ${val != null ? num(val) + ' ' + unit : '<span class="muted" style="font-weight:400">—</span>'}
        </div>
        ${grade ? `<div class="muted" style="font-size:11px;margin-top:2px">Grade: <b>${esc(grade)}</b></div>` : ''}
      </div>
    `;

    const modalHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div>
          <h3 style="margin:0">${esc(it.ec_no || '')} ${it.registration ? `· ${esc(it.registration)}` : ''}</h3>
          <p class="muted" style="margin:2px 0 0;font-size:12.5px">${esc(it.category || '')} · <b>${esc(it.brand || '')}</b> ${esc(it.model || '')} ${it.year ? `(${esc(it.year)})` : ''}</p>
        </div>
        ${isAdmin ? `<button class="btn sm" id="vlc-modal-edit">✏️ Edit Specifications</button>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:8px;margin-bottom:14px">
        ${fieldBlock('Engine Oil', it.engine_oil_l, 'L', it.engine_oil_grade)}
        ${fieldBlock('Gearbox / Trans', it.gearbox_oil_l, 'L', it.gearbox_oil_grade)}
        ${fieldBlock('Differential / Axle', it.diff_oil_l, 'L', it.diff_oil_grade)}
        ${fieldBlock('Hydraulic Oil', it.hydraulic_oil_l, 'L')}
        ${fieldBlock('Front Axle / Hub', it.front_axle_oil_l, 'L')}
        ${fieldBlock('Final Drive', it.final_drive_oil_l, 'L')}
        ${fieldBlock('Swing Motor', it.swing_oil_l, 'L')}
        ${fieldBlock('Other Gearbox', it.other_gearbox_oil_l, 'L')}
        ${fieldBlock('Coolant', it.coolant_l, 'L')}
        ${fieldBlock('Brake Fluid', it.brake_fluid_l, 'L')}
      </div>

      <div class="card section" style="background:#fff">
        <div style="font-weight:700;font-size:12px;margin-bottom:4px">Capacity Attribution Basis</div>
        <p style="margin:0;font-size:12px"><b>${esc(it.engine_oil_basis || 'Standard specification')}</b></p>
        ${it.notes ? `<p class="muted" style="margin:4px 0 0;font-size:11.5px">Notes: ${esc(it.notes)}</p>` : ''}
      </div>
    `;

    modal('Vehicle Lubricant Capacities', modalHtml, (body, close) => {
      if (isAdmin && qs('#vlc-modal-edit', body)) {
        qs('#vlc-modal-edit', body).onclick = () => {
          close();
          showVehicleCapacityEditModal(id, onReload);
        };
      }
    });

  } catch (e) {
    toast('Error loading vehicle details: ' + e.message, 'err');
  }
}

// Modal: Admin Edit Vehicle Capacity
async function showVehicleCapacityEditModal(id, onDone) {
  let existing = null;
  if (id) {
    try {
      const res = await api('/lubricant-capacities/' + id);
      existing = res.item;
    } catch (e) {
      toast('Failed to load record: ' + e.message, 'err');
      return;
    }
  }

  const it = existing || {};
  const isNew = !id;

  const formHtml = `
    <div class="row">
      ${field('E&C Vehicle No. *', 'ec_no', { value: it.ec_no || '', placeholder: 'e.g. AP-06, EX-14, 28-4314' })}
      ${field('Registration No.', 'registration', { value: it.registration || '', placeholder: 'e.g. WP NA-1234' })}
    </div>
    <div class="row">
      ${field('Category *', 'category', { value: it.category || '', placeholder: 'e.g. Dump Truck, Excavator' })}
      ${field('Brand', 'brand', { value: it.brand || '', placeholder: 'e.g. Caterpillar, Komatsu, Tata' })}
    </div>
    <div class="row">
      ${field('Model', 'model', { value: it.model || '', placeholder: 'e.g. 320D, PC200, 1618' })}
      ${field('Manufacturing Year', 'year', { value: it.year || '', placeholder: 'e.g. 2018' })}
    </div>

    <div style="font-weight:700;margin:12px 0 6px;border-bottom:1px solid var(--border);padding-bottom:4px">🛢️ Oil & Fluid Capacities (Litres per fill)</div>
    <div class="row">
      ${field('Engine Oil (L)', 'engine_oil_l', { type: 'number', step: '0.1', value: it.engine_oil_l ?? '' })}
      ${field('Engine Oil Grade', 'engine_oil_grade', { value: it.engine_oil_grade || '', placeholder: 'e.g. 15W-40 CI-4' })}
    </div>
    <div class="row">
      ${field('Gearbox Oil (L)', 'gearbox_oil_l', { type: 'number', step: '0.1', value: it.gearbox_oil_l ?? '' })}
      ${field('Gearbox Grade', 'gearbox_oil_grade', { value: it.gearbox_oil_grade || '', placeholder: 'e.g. 80W-90, 85W-140' })}
    </div>
    <div class="row">
      ${field('Differential Oil (L)', 'diff_oil_l', { type: 'number', step: '0.1', value: it.diff_oil_l ?? '' })}
      ${field('Diff Grade', 'diff_oil_grade', { value: it.diff_oil_grade || '', placeholder: 'e.g. 85W-140 GL-5' })}
    </div>
    <div class="row">
      ${field('Hydraulic Oil (L)', 'hydraulic_oil_l', { type: 'number', step: '0.1', value: it.hydraulic_oil_l ?? '' })}
      ${field('Front Axle / Hub (L)', 'front_axle_oil_l', { type: 'number', step: '0.1', value: it.front_axle_oil_l ?? '' })}
    </div>
    <div class="row">
      ${field('Final Drive (L)', 'final_drive_oil_l', { type: 'number', step: '0.1', value: it.final_drive_oil_l ?? '' })}
      ${field('Swing Motor (L)', 'swing_oil_l', { type: 'number', step: '0.1', value: it.swing_oil_l ?? '' })}
    </div>
    <div class="row">
      ${field('Other Gearbox (L)', 'other_gearbox_oil_l', { type: 'number', step: '0.1', value: it.other_gearbox_oil_l ?? '' })}
      ${field('Coolant (L)', 'coolant_l', { type: 'number', step: '0.1', value: it.coolant_l ?? '' })}
    </div>
    <div class="row">
      ${field('Brake Fluid (L)', 'brake_fluid_l', { type: 'number', step: '0.1', value: it.brake_fluid_l ?? '' })}
      ${field('Evidence Basis', 'engine_oil_basis', { value: it.engine_oil_basis || 'Own record: verified', placeholder: 'e.g. Own record, OEM spec' })}
    </div>
    ${field('Notes & Remarks', 'notes', { value: it.notes || '', placeholder: 'Special fill instructions, component notes…' })}

    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px;padding-top:10px;border-top:1px solid var(--border)">
      ${!isNew ? `<button type="button" class="btn sm err" id="vlc-form-del">🗑️ Delete Vehicle</button>` : '<div></div>'}
      <div style="display:flex;gap:8px">
        <button type="button" class="btn sm" id="vlc-form-cancel">Cancel</button>
        <button type="button" class="primary sm" id="vlc-form-save">${isNew ? 'Create Vehicle' : 'Save Changes'}</button>
      </div>
    </div>
  `;

  modal(isNew ? 'New Vehicle Capacity Record' : 'Edit Lubricant Capacity · ' + (it.ec_no || it.registration), formHtml, (body, close) => {
    qs('#vlc-form-cancel', body).onclick = close;

    if (!isNew && qs('#vlc-form-del', body)) {
      qs('#vlc-form-del', body).onclick = async () => {
        if (!confirm('Are you sure you want to delete this vehicle lubricant capacity record?')) return;
        try {
          await api('/lubricant-capacities/' + id, { method: 'DELETE' });
          toast('Vehicle capacity record deleted');
          close();
          if (onDone) onDone();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    }

    qs('#vlc-form-save', body).onclick = async () => {
      const data = formData(body);
      if (!data.ec_no && !data.registration) {
        return toast('Please provide an E&C vehicle number or registration', 'err');
      }

      try {
        if (isNew) {
          await api('/lubricant-capacities', { method: 'POST', body: data });
          toast('Vehicle lubricant capacity created');
        } else {
          await api('/lubricant-capacities/' + id, { method: 'PUT', body: data });
          toast('Vehicle capacity specifications updated');
        }
        close();
        if (onDone) onDone();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
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
      <td><select class="o_type" style="width:100%;min-width:78px">${oilTypeOpts}</select></td>
      <td><select class="o_cv" style="width:56px"><option value=""></option><option>C</option><option>V</option></select></td>
      <td><input type="number" class="o_lit" style="width:64px" step="0.1"><div class="o_stock muted" style="font-size:11px"></div></td>
      <td><input type="number" class="o_price" style="width:96px"></td></tr>`).join('');
  const filterRows = ref.filterCategories.map((cat) => `<tr>
      <td>${esc(cat)}<input type="hidden" class="f_cat" value="${esc(cat)}"></td>
      <td style="position:relative"><input type="text" class="f_no" autocomplete="off" placeholder="type to search…" style="width:120px"><div class="f_note muted" style="font-size:11px"></div>
        <div class="f_menu" style="position:absolute;z-index:80;left:0;top:100%;min-width:300px;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:var(--shadow);max-height:230px;overflow:auto;display:none"></div></td>
      <td><input type="number" class="f_qty" value="1" style="width:48px"></td>
      <td><select class="f_xe" style="width:52px"><option value=""></option><option>X</option><option>E</option></select></td>
      <td><input type="number" class="f_price" style="width:96px"></td></tr>`).join('');
  const back = edit ? `<a href="#/services/${edit.id}">← Back to the record</a>` : '<a href="#/services">← Service Records</a>';
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
        <p class="muted" style="font-size:11.5px;margin:6px 0 0" id="oilCount"></p><p class="muted stk-note" style="font-size:11.5px;margin:4px 0 0"></p></div>
      <div class="card"><div class="toolbar" style="margin:0 0 8px">
          <h3 style="margin:0">Filters</h3><div class="spacer"></div>
          <input type="search" id="filFind" placeholder="Find a filter…" style="max-width:150px;font-size:12px">
          <label class="muted" style="font-size:11.5px;display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="filOnlyUsed" style="width:auto;margin:0"> only filled</label>
        </div>
        <div class="table-wrap scroll"><table><thead><tr><th>Filter</th><th>Filter No.</th><th>Qty</th><th>X/E</th><th>Price</th></tr></thead>
          <tbody id="filterBody">${filterRows}</tbody></table></div>
        <p class="muted" style="font-size:11.5px;margin:6px 0 0" id="filCount">Type a filter number in the box to search — picking one fills its price.</p><p class="muted stk-note" style="font-size:11.5px;margin:4px 0 0"></p></div>
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
        <div style="margin-top:12px;text-align:right"><a class="btn sm" href="${edit ? '#/services/' + edit.id : '#/services'}">Cancel</a> <button class="primary" id="saveService">${edit ? 'Save Changes' : 'Create Service'}</button></div>
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
        <td><select class="o_type" style="width:100%;min-width:78px">${oilTypeOpts}</select></td>
        <td><select class="o_cv" style="width:56px"><option value=""></option><option>C</option><option>V</option></select></td>
        <td><input type="number" class="o_lit" style="width:64px" step="0.1"><div class="o_stock muted" style="font-size:11px"></div></td>
        <td><input type="number" class="o_price" style="width:96px"></td>`);
      qs('.o_type', tr).value = o.oil_type || '';
      qs('.o_cv', tr).value = o.action_type || '';
      qs('.o_lit', tr).value = o.qty == null ? '' : o.qty;
      qs('.o_price', tr).value = o.price == null ? '' : o.price;
    }
    for (const f of existing.filters) {
      const tr = claim('filterBody', 'f_cat', f.category, () => `
        <td>${esc(f.category || '—')}<input type="hidden" class="f_cat" value="${esc(f.category || '')}"></td>
        <td style="position:relative"><input type="text" class="f_no" autocomplete="off" placeholder="type to search…" style="width:120px"><div class="f_note muted" style="font-size:11px"></div>
          <div class="f_menu" style="position:absolute;z-index:80;left:0;top:100%;min-width:300px;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:var(--shadow);max-height:230px;overflow:auto;display:none"></div></td>
        <td><input type="number" class="f_qty" value="1" style="width:48px"></td>
        <td><select class="f_xe" style="width:52px"><option value=""></option><option>X</option><option>E</option></select></td>
        <td><input type="number" class="f_price" style="width:96px"></td>`);
      qs('.f_no', tr).value = f.filter_no || '';
      if (f.required_no) { tr.dataset.required = f.required_no; qs('.f_note', tr).textContent = 'equivalent of ' + f.required_no; }
      qs('.f_qty', tr).value = f.qty == null ? 1 : f.qty;
      qs('.f_xe', tr).value = f.action_type || '';
      // The line's own price is what this service was charged; the book price is the
      // fallback for a line recorded before the number was priced.
      qs('.f_price', tr).value = f.price != null && f.price > 0 ? f.price : (f.book_price == null ? '' : f.book_price);
    }
    qsa('#oilBody tr, #filterBody tr', c).forEach((tr) => delete tr.dataset.taken);
  }

  wireAssetPicker(c);

  // Stores plan, Part 3: the oil and the filters come off the store's stock (the service's own
  // store; for a new one, its job card's workshop's, else yours). Show what that store holds, and
  // whether its "must be in stock" rule has started — the save refuses what is not there.
  let STK = null;
  const stkQuery = (extra = {}) => {
    const p = new URLSearchParams(extra);
    if (edit) p.set('service_id', edit.id);
    p.set('job_no', qs('[name=job_no]', c).value.trim());
    p.set('date', qs('[name=service_date]', c).value);
    return p.toString();
  };
  const oilStock = (tr) => {
    if (!STK) return null;
    const type = qs('.o_type', tr).value, name = qs('.o_name', tr).value;
    return (type && STK.types[type]) || STK.names[name] || null;
  };
  const paintOil = (tr) => {
    const el = qs('.o_stock', tr);
    if (!el) return;
    const lit = Number(qs('.o_lit', tr).value) || 0;
    const p = oilStock(tr);
    el.style.color = '';
    if (!STK) { el.textContent = ''; return; }
    if (!p) {
      el.textContent = lit > 0 && STK.rule.oil ? 'not in the oil book — choose the type' : '';
      if (lit > 0 && STK.rule.oil) el.style.color = 'var(--danger,#c4392c)';
      return;
    }
    el.textContent = `${num(p.in_stock)} ${p.unit} in stock`;
    if (STK.rule.oil && lit > p.in_stock + 0.001) el.style.color = 'var(--danger,#c4392c)';
  };
  const loadStock = async () => {
    try { STK = await api('/filters/stock-context?' + stkQuery()); } catch (e) { STK = null; }
    qsa('#oilBody tr', c).forEach(paintOil);
    const notes = qsa('.stk-note', c);
    const say = (rule) => (!STK || !STK.store ? ''
      : `From ${STK.store.name} stock. ` + (rule ? `Must be in stock (since ${rule}).` : 'Not blocked yet: this starts after the store\'s first full stock take.'));
    if (notes[0]) notes[0].textContent = say(STK && STK.rule.oil);
    if (notes[1]) notes[1].textContent = say(STK && STK.rule.filter);
  };
  let stkDeb;
  for (const n of ['job_no', 'service_date']) qs(`[name=${n}]`, c).addEventListener('change', () => { clearTimeout(stkDeb); stkDeb = setTimeout(loadStock, 200); });
  loadStock();

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
    typeSel.addEventListener('change', () => paintOil(tr));
    lit.addEventListener('input', () => paintOil(tr));
  });
  // Filter rows: type a number → suggestions from the price book / catalogue / cross-refs.
  // Picking one fills the number AND its price; ↑/↓ + Enter work, and leaving the box still
  // falls back to the exact-match book price for a number typed in full.
  qsa('#filterBody tr', c).forEach((tr) => {
    const noIn = qs('.f_no', tr), price = qs('.f_price', tr), menu = qs('.f_menu', tr);
    let items = [], active = -1, deb;

    const close = () => { menu.style.display = 'none'; active = -1; };
    const note = qs('.f_note', tr);
    const choose = (i) => {
      const it = items[i]; if (!it) return;
      noIn.value = it.filter_no;
      if (it.unit_price != null) price.value = it.unit_price;
      // An equivalent fitted in place of the vehicle's own number keeps both (ST-D15).
      if (it.equivalent_of) { tr.dataset.required = it.equivalent_of; note.textContent = `equivalent of ${it.equivalent_of} · ${num(it.in_stock)} in stock`; }
      else { delete tr.dataset.required; note.textContent = it.in_stock != null ? `${num(it.in_stock)} in stock` : ''; }
      close(); recalc(); price.focus();
    };
    const stockBadge = (it) => (it.in_stock == null ? ''
      : it.in_stock > 0 ? ` <span class="badge green">${num(it.in_stock)} in stock</span>`
        : ` <span class="badge ${STK && STK.rule.filter ? 'red' : 'amber'}">none in stock</span>`);
    const paint = () => {
      const firstEq = items.findIndex((it) => it.equivalent_of);
      menu.innerHTML = items.map((it, i) => `${i === firstEq ? `<div class="muted" style="padding:5px 9px;font-size:11px;background:var(--surface-2)">In stock instead — same filter as ${esc(it.equivalent_of)}:</div>` : ''}
        <div class="f_opt" data-i="${i}" style="padding:6px 9px;cursor:pointer;border-bottom:1px solid var(--border);background:${i === active ? 'var(--surface-2)' : 'transparent'}">
          <b>${esc(it.filter_no)}</b>${it.unit_price != null ? ` <span style="float:right">${money(it.unit_price)}</span>` : ' <span class="badge amber" style="float:right">no price</span>'}
          <div class="muted" style="font-size:11px">${esc(it.category || (it.equivalent_of ? 'equivalent' : '—'))}${it.src ? ' · ' + esc(it.src) : ''}${it.uses ? ' · used ' + it.uses + '×' : ''}${stockBadge(it)}</div></div>`).join('');
      qsa('.f_opt', menu).forEach((el) => {
        el.onmousedown = (e) => { e.preventDefault(); choose(+el.dataset.i); };
        el.onmouseenter = () => { active = +el.dataset.i; paint(); };
      });
      menu.style.display = items.length ? 'block' : 'none';
    };
    // Search from the first character. With the box empty it lists this row's own filter
    // category (click into "Engine Oil Filter" and you see the engine oil filters we stock).
    const rowCat = (qs('.f_cat', tr) || {}).value || '';
    // Part 3: with what the service's store holds of each, and — when the number asked for is not
    // on the shelf — the equivalents that are.
    const search = async () => {
      const q = noIn.value.trim();
      try {
        const r = await api('/filters/stock-search?' + stkQuery({ q, category: rowCat, limit: 20 }));
        items = r.items.concat(r.equivalents.map((e) => ({ ...e, equivalent_of: q })));
        // An equivalent in stock comes first when the number asked for has none.
        if (r.equivalents.length) items.sort((a, b) => (b.in_stock > 0) - (a.in_stock > 0));
      } catch (e) { items = []; }
      active = items.length ? 0 : -1;
      paint();
    };

    noIn.oninput = () => { delete tr.dataset.required; note.textContent = ''; clearTimeout(deb); deb = setTimeout(search, 140); };
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
    const filters = qsa('#filterBody tr', c).map((tr) => ({ category: qs('.f_cat', tr).value, filter_no: qs('.f_no', tr).value.trim(), required_no: tr.dataset.required || '', qty: qs('.f_qty', tr).value, xe: qs('.f_xe', tr).value, price: qs('.f_price', tr).value })).filter((f) => f.filter_no);
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
        location.hash = '#/services/' + edit.id;
      } else {
        const r = await api('/filters/services', { method: 'POST', body: payload });
        toast('Service recorded' + (r.oil_issues ? ' · ' + r.oil_issues + ' oil issue(s) posted to Lubricants' : ''));
        location.hash = '#/services/' + r.service.id;
      }
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
  recalc();
}

async function serviceDetail(c, id) {
  const d = await api('/filters/services/' + id);
  const s = d.service;
  const editable = canEdit('services');
  const cats = await api('/filters/categories').catch(() => []);
  const upk = { Good: 'green', Fair: 'amber', Bad: 'red' }[s.upkeeping] || '';
  c.innerHTML = `${pageHeader('Vehicle / Machinery Service Details', '<a href="#/services">← Service Records</a>')}
    <div class="toolbar"><a class="btn sm" href="#/services">← Service Records</a><div class="spacer"></div>
      ${s.upkeeping ? `<span class="badge ${upk}">Up-keeping: ${esc(s.upkeeping)}</span>` : ''}
      <span class="badge amber">Cost ${money(s.computed_cost)}</span>
      ${editable ? `<a class="btn sm primary" href="#/services/${s.id}/edit">✏️ Edit</a>` : ''}
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
            <td><b>${esc(f.filter_no || '')}</b>${f.required_no ? `<div class="muted" style="font-size:11px">equivalent of ${esc(f.required_no)}</div>` : ''}</td><td>${esc(f.category || '')}</td><td class="num">${num(f.qty)}</td><td>${esc(f.action_type || '')}</td>
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
  c.innerHTML = `${pageHeader('Projects')}${canDo('projects.manage') ? '<div class="toolbar"><button class="primary" id="npr">+ New Project</button></div>' : ''}
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
          <td>${canDo('aliases.vehicle.resolve') ? `<select data-alias="${a.id}" style="width:auto;display:inline-block"><option value="">— pick —</option>${aopts}</select> <button class="sm" data-link="${a.id}">Link</button>` : '<span class="muted">read-only</span>'}</td></tr>`)) : '<span class="muted">Queue empty — every name resolves.</span>'}</div>
    <div class="card section"><h3>Mechanic names — pending link (${mPending.length})</h3>
      ${mPending.length ? tableWrap([{ label: 'Raw Text' }, { label: 'Hits', num: true }, { label: 'Source' }, { label: 'Link to Mechanic' }],
      mPending.map((a) => `<tr><td>${esc(a.raw_text)}</td><td class="num">${a.hit_count}</td><td>${esc(a.source || '')}</td>
          <td>${canDo('aliases.mechanic.resolve') ? `<select data-malias="${a.id}" style="width:auto;display:inline-block"><option value="">— pick —</option>${mopts}</select> <button class="sm" data-mlink="${a.id}">Link</button>` : '<span class="muted">read-only</span>'}</td></tr>`)) : '<span class="muted">Queue empty — every mechanic name resolves.</span>'}</div>
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
// Stage 5: the workshop the Reports page is showing ('' = all workshops, or the only one). Kept
// while the app is open; the server decides what each person may actually read.
let REP_WS = '';
const repWsQ = () => (REP_WS ? '&workshop_id=' + encodeURIComponent(REP_WS) : '');

async function openMonthlyInputs(year, month, onSaved) {
  let data;
  try { data = await api(`/reports/monthly-inputs?year=${year}&month=${month}${repWsQ()}`); }
  catch (e) { return toast(e.message, 'err'); }
  // Stage 5: with more than one workshop, inputs are entered one workshop at a time.
  if (data.editable === false) return toast('Choose a workshop at the top of the page to enter its monthly inputs.', 'err');
  const wsLabel = data.workshop_id && WS_CACHE ? ' — ' + wsName(WS_CACHE, data.workshop_id) : '';
  const state = {};
  for (const [k] of MRI_SHEETS) state[k] = (data.inputs[k] || []).map((r) => ({ ...r }));
  // Seed the outside-price editors from the month's live daily-work vehicles and service jobs, with
  // any already-saved price merged in (the report reads these same values back).
  state.daily_outside = (data.daily_work || []).map((d) => ({ vehicle: d.vehicle, labour: d.labour, amount1: (d.outside ? d.outside : '') }));
  state.service_outside = (data.service_jobs || []).map((s) => ({ id: s.id, job_no: s.job_no, vehicle: s.vehicle, labour: s.labour, amount1: (s.outside ? s.outside : '') }));
  let active = 'fuel';
  const bg = modal(`Monthly inputs — ${MONTH_NAMES[month]} ${year}${wsLabel}`, `
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
            await api('/reports/monthly-inputs', { method: 'POST', body: { year, month, sheet: k, lines, workshop_id: data.workshop_id } });
          } else {
            await api('/reports/monthly-inputs', { method: 'POST', body: { year, month, sheet: k, lines: state[k], workshop_id: data.workshop_id } });
          }
        }
        toast('Monthly inputs saved'); close(); if (onSaved) onSaved();
      } catch (e) { toast(e.message, 'err'); }
    };
    paintTabs(); paintGrid();
  }, { persistent: true });
  const box = qs('.modal', bg); if (box) { box.style.width = 'min(940px, 95vw)'; box.style.maxWidth = 'none'; }
}

// ---- Repair Cost Sections Reconciler (Closed, Pending, Other Labour, Spares Supply + Labour Tally)
async function openRepairSectionsReconciler(year, month, onSync) {
  let repData;
  const loadData = async () => {
    try {
      repData = await api(`/reports/repair-sections?year=${year}&month=${month}${repWsQ()}`);
    } catch (e) {
      toast(e.message, 'err');
      throw e;
    }
  };

  try { await loadData(); } catch { return; }

  let activeTab = 'closed';
  let searchQuery = '';

  const bg = modal(`Repair Cost Sections Reconciler — ${MONTH_NAMES[month]} ${year}`, `
    <div id="repsec-root">
      <div id="repsec-summary-cards" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:10px;margin-bottom:12px"></div>
      <div id="repsec-tally-banner" style="margin-bottom:12px"></div>
      <div class="toolbar" style="margin:0 0 10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <div id="repsec-tabs" class="pill-row" style="margin:0">
          <button class="sm" data-tab="closed">1. Closed Jobs</button>
          <button class="sm" data-tab="pending">2. Pending Jobs</button>
          <button class="sm" data-tab="other">3. Other Labour</button>
          <button class="sm" data-tab="spares">4. Spares Supply</button>
        </div>
        <div class="spacer"></div>
        <input type="search" id="repsec-search" placeholder="Search job, vehicle, description…" style="width:240px;font-size:12px;padding:4px 8px">
      </div>
      <div id="repsec-table-view" style="min-height:260px;max-height:50vh;overflow-y:auto"></div>
      <div class="toolbar" style="margin-top:14px;border-top:1px solid var(--line,#eee);padding-top:10px">
        <a class="btn sm" href="/api/reports/monthly-repair-detail.html?year=${year}&month=${month}" target="_blank">🖨 Print Repair Detail (PDF/HTML)</a>
        <a class="btn sm primary" href="/api/reports/monthly-cost.xlsx?year=${year}&month=${month}">⬇ 14-Sheet Master Excel</a>
        <div class="spacer"></div>
        <button class="sm" id="repsec-close">Close</button>
      </div>
    </div>
  `, (body, close) => {
    const summaryEl = qs('#repsec-summary-cards', body);
    const tallyEl = qs('#repsec-tally-banner', body);
    const tableEl = qs('#repsec-table-view', body);
    const searchInp = qs('#repsec-search', body);

    qs('#repsec-close', body).onclick = close;

    searchInp.oninput = () => {
      searchQuery = searchInp.value.trim().toLowerCase();
      renderTable();
    };

    const renderSummary = () => {
      const c = repData.closed_jobs || [];
      const p = repData.pending_jobs || [];
      const o = repData.other_labour || [];
      const s = repData.spares_supply || [];

      summaryEl.innerHTML = `
        <div class="card stat" style="padding:10px;background:#f8fafc;border:1px solid #cbd5e1;cursor:pointer" data-target="closed">
          <div style="font-weight:700;font-size:13px;color:#0f172a">1. Closed Jobs (${c.length})</div>
          <div style="font-size:16px;font-weight:700;color:#1e40af;margin:2px 0">${money(repData.closed_total)}</div>
          <div class="muted" style="font-size:11px">Labour: ${money(repData.tally.closed_labour)} · Spares: ${money(c.reduce((a, x) => a + (Number(x.material || 0) + Number(x.general || 0)), 0))}</div>
        </div>
        <div class="card stat" style="padding:10px;background:#f8fafc;border:1px solid #cbd5e1;cursor:pointer" data-target="pending">
          <div style="font-weight:700;font-size:13px;color:#0f172a">2. Pending Jobs (${p.length})</div>
          <div style="font-size:16px;font-weight:700;color:#0369a1;margin:2px 0">${money(repData.pending_total)}</div>
          <div class="muted" style="font-size:11px">Labour: ${money(repData.tally.pending_labour)} · Spares: ${money(p.reduce((a, x) => a + (Number(x.material || 0) + Number(x.general || 0)), 0))}</div>
        </div>
        <div class="card stat" style="padding:10px;background:#f8fafc;border:1px solid #cbd5e1;cursor:pointer" data-target="other">
          <div style="font-weight:700;font-size:13px;color:#0f172a">3. Other Labour (${o.length})</div>
          <div style="font-size:16px;font-weight:700;color:#b45309;margin:2px 0">${money(repData.other_labour_total)}</div>
          <div class="muted" style="font-size:11px">Yard / unallocated work · Outside: ${money(repData.other_labour_outside || 0)}</div>
        </div>
        <div class="card stat" style="padding:10px;background:#f8fafc;border:1px solid #cbd5e1;cursor:pointer" data-target="spares">
          <div style="font-weight:700;font-size:13px;color:#0f172a">4. Spares Supply (${s.length})</div>
          <div style="font-size:16px;font-weight:700;color:#475569;margin:2px 0">${money(repData.spares_supply_total)}</div>
          <div class="muted" style="font-size:11px">Parts-only container supply outside jobs</div>
        </div>
      `;

      qsa('#repsec-summary-cards .card', body).forEach(card => {
        card.onclick = () => {
          activeTab = card.dataset.target;
          updateTabButtons();
          renderTable();
        };
      });
    };

    const renderTally = () => {
      const t = repData.tally || {};
      const isBal = t.is_balanced;
      tallyEl.innerHTML = `
        <div style="background:${isBal ? '#f0fdf4' : '#fffbeb'};border:1px solid ${isBal ? '#86efac' : '#fcd34d'};border-radius:6px;padding:10px 14px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:700;font-size:13px;color:${isBal ? '#166534' : '#92400e'}">
              ${isBal ? '✓ MATHEMATICAL LABOUR TALLY BALANCED' : `⚠️ LABOUR TALLY VARIANCE: ${money(t.difference)}`}
            </div>
            <div style="font-size:12px;color:#334155;margin-top:2px">
              Daily Work Labour (<b>${money(t.total_daily_work_labour)}</b>) = Closed (<b>${money(t.closed_labour)}</b>) + Pending (<b>${money(t.pending_labour)}</b>) + Other Labour (<b>${money(t.other_labour)}</b>) = Sum (<b>${money(t.allocated_sum)}</b>)
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${!isBal ? `<button class="sm primary" id="repsec-sync-btn" title="Re-synchronize job labour records from daily work entries">⚡ Sync Labour Tally</button>` : `<span class="badge green">100% Reconciled</span>`}
          </div>
        </div>
      `;

      const syncBtn = qs('#repsec-sync-btn', body);
      if (syncBtn) {
        syncBtn.onclick = async () => {
          syncBtn.disabled = true;
          syncBtn.textContent = 'Syncing…';
          try {
            const r = await api('/reports/repair-sections/sync-labour', {
              method: 'POST',
              body: { year, month }
            });
            toast(r.message || 'Labour re-synchronized');
            await loadData();
            renderAll();
            if (onSync) onSync();
          } catch (e) {
            toast(e.message, 'err');
            syncBtn.disabled = false;
            syncBtn.textContent = '⚡ Sync Labour Tally';
          }
        };
      }
    };

    const updateTabButtons = () => {
      qsa('#repsec-tabs button', body).forEach(b => {
        b.classList.toggle('primary', b.dataset.tab === activeTab);
      });
    };

    const renderTable = () => {
      updateTabButtons();
      const q = searchQuery;

      if (activeTab === 'closed') {
        const rows = (repData.closed_jobs || []).filter(r => !q ||
          String(r.job_no || '').toLowerCase().includes(q) ||
          String(r.vehicle || '').toLowerCase().includes(q) ||
          String(r.description || '').toLowerCase().includes(q)
        );
        tableEl.innerHTML = tableWrap([
          { label: 'Job No', width: '80px' },
          { label: 'Vehicle', width: '110px' },
          { label: 'Closed Date', width: '95px' },
          { label: 'Description', cls: 'desc-col' },
          { label: 'Labour (Rs)', num: true, width: '100px' },
          { label: 'Spares (Rs)', num: true, width: '100px' },
          { label: 'Oil (Rs)', num: true, width: '90px' },
          { label: 'External (Rs)', num: true, width: '95px' },
          { label: 'Total (Rs)', num: true, width: '110px' }
        ], rows.map(r => `<tr>
          <td><a href="#/jobcards/${esc(r.id || '')}" style="font-weight:600">Job ${esc(r.job_no || '')}</a></td>
          <td><b>${esc(r.vehicle || '')}</b></td>
          <td>${esc(String(r.completed_at || '').slice(0, 10))}</td>
          <td class="desc-col">${esc(r.description || '')}</td>
          <td class="num">${money(r.labour || 0)}</td>
          <td class="num">${money(Number(r.material || 0) + Number(r.general || 0))}</td>
          <td class="num">${money(r.oil || 0)}</td>
          <td class="num">${money(r.external || 0)}</td>
          <td class="num"><b>${money(r.total || 0)}</b></td>
        </tr>`), { scroll: true });
      } else if (activeTab === 'pending') {
        const rows = (repData.pending_jobs || []).filter(r => !q ||
          String(r.job_no || '').toLowerCase().includes(q) ||
          String(r.vehicle || '').toLowerCase().includes(q) ||
          String(r.description || '').toLowerCase().includes(q)
        );
        tableEl.innerHTML = tableWrap([
          { label: 'Job No', width: '80px' },
          { label: 'Vehicle', width: '110px' },
          { label: 'Status', width: '95px' },
          { label: 'Description', cls: 'desc-col' },
          { label: 'Month Labour (Rs)', num: true, width: '120px' },
          { label: 'Month Spares (Rs)', num: true, width: '120px' },
          { label: 'Month Oil (Rs)', num: true, width: '100px' },
          { label: 'Month Total (Rs)', num: true, width: '120px' }
        ], rows.map(r => `<tr>
          <td><a href="#/jobcards/${esc(r.id || '')}" style="font-weight:600">Job ${esc(r.job_no || '')}</a></td>
          <td><b>${esc(r.vehicle || '')}</b></td>
          <td><span class="badge ${r.status === 'in_progress' ? 'amber' : 'gray'}">${esc(r.status || '')}</span></td>
          <td class="desc-col">${esc(r.description || '')}</td>
          <td class="num">${money(r.labour || 0)}</td>
          <td class="num">${money(Number(r.material || 0) + Number(r.general || 0))}</td>
          <td class="num">${money(r.oil || 0)}</td>
          <td class="num"><b>${money(r.total || 0)}</b></td>
        </tr>`), { scroll: true });
      } else if (activeTab === 'other') {
        const rows = (repData.other_labour || []).filter(r => !q ||
          String(r.vehicle || '').toLowerCase().includes(q) ||
          String(r.description || '').toLowerCase().includes(q)
        );
        tableEl.innerHTML = tableWrap([
          { label: 'Vehicle / Work Area', width: '150px' },
          { label: 'Description / Nature of Work', cls: 'desc-col' },
          { label: 'Labour Cost (Rs)', num: true, width: '130px' },
          { label: 'Outside Estimate (Rs)', num: true, width: '140px' }
        ], rows.map(r => `<tr>
          <td><b>${esc(r.vehicle || '')}</b></td>
          <td class="desc-col">${esc(r.description || '')}</td>
          <td class="num"><b>${money(r.labour || 0)}</b></td>
          <td class="num">${money(r.outside || 0)}</td>
        </tr>`), { scroll: true });
      } else if (activeTab === 'spares') {
        const rows = (repData.spares_supply || []).filter(r => !q ||
          String(r.vehicle || '').toLowerCase().includes(q) ||
          String(r.items || '').toLowerCase().includes(q)
        );
        tableEl.innerHTML = tableWrap([
          { label: 'Vehicle / Plant', width: '160px' },
          { label: 'Parts & Consumables Issued (Descriptions)', cls: 'desc-col' },
          { label: 'Total Spares Cost (Rs)', num: true, width: '150px' }
        ], rows.map(r => `<tr>
          <td><b>${esc(r.vehicle || '')}</b></td>
          <td class="desc-col">${esc(r.items || '')}</td>
          <td class="num"><b>${money(r.total_spares || 0)}</b></td>
        </tr>`), { scroll: true });
      }
    };

    qsa('#repsec-tabs button', body).forEach(b => {
      b.onclick = () => {
        activeTab = b.dataset.tab;
        renderTable();
      };
    });

    const renderAll = () => {
      renderSummary();
      renderTally();
      renderTable();
    };

    renderAll();
  }, { persistent: true });

  const box = qs('.modal', bg);
  if (box) {
    box.style.width = 'min(1100px, 96vw)';
    box.style.maxWidth = 'none';
  }
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

// ---- Purchasing -----------------------------------------------------------
// Two officers buy what the workshop asked for: one on the Head Office account, one locally. Each
// sees their own channel only — the server decides which from their role, so this screen never has
// to know, and cannot be talked into showing the other list.
routes.purchasing = async (c) => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = ['to_buy', 'unassigned', 'bought'].includes(sp.get('tab')) ? sp.get('tab') : 'to_buy';
  const go = (t) => `location.hash='#/purchasing?tab=${t}'`;

  c.innerHTML = pageHeader('Purchasing',
    'What has been approved and still has to be bought. Tick it off with the invoice once it is.') + `
    <div class="toolbar" style="margin:0 0 10px 0">
      <span id="pu-tabs"></span>
      <div class="spacer"></div>
      <input id="pu-q" type="search" placeholder="Item, request no, vehicle, invoice…" style="max-width:260px">
    </div>
    <div id="pu-body" class="muted">Loading…</div>`;

  const counts = await api('/purchasing/counts').catch(() => ({ to_buy: 0, unassigned: 0, bought: 0 }));
  qs('#pu-tabs', c).innerHTML = [
    ['to_buy', 'To buy', counts.to_buy],
    ['unassigned', 'Not yet assigned', counts.unassigned],
    ['bought', 'Bought', counts.bought],
  ].map(([t, l, n]) => `<button class="sm ${t === tab ? 'primary' : ''}" onclick="${go(t)}">${l}${n ? ` (${n})` : ''}</button>`).join(' ');

  const load = async () => {
    const q = qs('#pu-q', c).value.trim();
    let d;
    try { d = await api(`/purchasing/queue?tab=${tab}` + (q ? '&q=' + encodeURIComponent(q) : '')); }
    catch (e) { qs('#pu-body', c).innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }

    if (!d.rows.length) {
      qs('#pu-body', c).innerHTML = `<div class="card"><p class="muted">${tab === 'bought' ? 'Nothing bought yet.'
          : tab === 'unassigned' ? 'Every approved item has been given to an officer.'
            : d.channels.length ? 'Nothing waiting to be bought.'
              : 'You are not set up as a purchasing officer, so there is no list of your own to show.'}</p></div>`;
      return;
    }

    const chan = (s) => (s === 'head_office' ? '<span class="badge">Head Office</span>'
      : s === 'local_purchase' ? '<span class="badge green">Local</span>'
        : '<span class="muted">—</span>');

    const headers = [
      { label: 'Needed', width: '96px' }, { label: 'Request', width: '104px' },
      { label: 'Vehicle', width: '120px' }, { label: 'Item', cls: 'desc-col' },
      { label: 'Qty', num: true, width: '68px' },
    ];
    if (d.sees_both || tab === 'unassigned') headers.push({ label: 'Channel', width: '104px' });
    if (tab === 'bought') headers.push({ label: 'Supplier' }, { label: 'Invoice', width: '120px' }, { label: 'Amount', num: true, width: '110px' });
    headers.push({ label: '', width: tab === 'bought' ? '90px' : '190px' });

    qs('#pu-body', c).innerHTML = tableWrap(headers, d.rows.map((r) => {
      const cells = [
        `<td>${r.required_date ? esc(String(r.required_date).slice(0, 10)) : '<span class="muted">—</span>'}</td>`,
        `<td class="mono">${esc(r.mrn_no || '')}${r.is_new && tab !== 'bought' ? ' <span class="badge amber">new</span>' : ''}</td>`,
        `<td>${r.asset_code ? `<span class="stamp">${esc(r.asset_code)}</span>` : '<span class="muted">—</span>'}</td>`,
        `<td class="desc-col">${esc(r.description || '')}${r.source_changed_reason
          // Why it was handed over is worth reading before buying it — usually it is the reason the
          // last person could not.
          ? `<div class="muted" style="font-size:11px">↔ from ${esc(r.source_changed_from || '?')}: ${esc(r.source_changed_reason)}</div>` : ''}</td>`,
        `<td class="num">${num(r.qty)}${r.unit ? ' ' + esc(r.unit) : ''}</td>`,
      ];
      if (d.sees_both || tab === 'unassigned') cells.push(`<td>${chan(r.purchase_source)}</td>`);
      if (tab === 'bought') {
        cells.push(`<td>${esc(r.supplier || '')}</td>`,
          `<td class="mono">${esc(r.invoice_no || '')}</td>`,
          `<td class="num">${r.purchase_amount == null ? '<span class="muted">—</span>' : money(r.purchase_amount)}</td>`);
      }
      cells.push(`<td>${tab === 'bought'
        ? `<button class="sm" data-view="${r.id}">View</button>`
        : `<button class="sm primary" data-buy="${r.id}">✓ Bought</button> <button class="sm" data-move="${r.id}" data-src="${esc(r.purchase_source || '')}" title="Cannot buy this on your account — send it to the other officer">↔</button>`}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    }), { scroll: true });

    qsa('[data-buy]', c).forEach((b) => { b.onclick = () => markBought(b.dataset.buy, load); });
    qsa('[data-move]', c).forEach((b) => { b.onclick = () => moveChannel(b.dataset.move, b.dataset.src, load); });
    qsa('[data-view]', c).forEach((b) => { b.onclick = () => viewPurchase(b.dataset.view, load); });

    // Looking at the list IS having seen it. Recorded per person, so two officers never clear each
    // other badge.
    if (tab === 'to_buy') api('/purchasing/seen', { method: 'POST' }).catch(() => { });
  };

  let deb; qs('#pu-q', c).oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  load();
};

// Hand an item to the other officer, with the reason that makes the record worth keeping.
function moveChannel(lineId, current, onDone) {
  const to = current === 'head_office' ? 'local_purchase' : 'head_office';
  const label = to === 'head_office' ? 'Head Office' : 'Local Purchase';
  modal(`Send to ${label}`, `
    <p class="muted" style="font-size:12px;margin:0 0 10px">Why can this not be bought on the current account? A few months of these is the case for opening one.</p>
    ${field('Reason', 'reason', { placeholder: 'e.g. No head office account with this supplier' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="mv">Send to ${label}</button></div>`,
    (body, close) => {
      qs('#mv', body).onclick = async () => {
        try {
          const r = await api(`/purchasing/lines/${lineId}/source`, {
            method: 'POST',
            body: { purchase_source: to, reason: qs('[name=reason]', body).value }
          });
          toast(r.message); close(); onDone();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
}

// The tick. The invoice photo is required — it is the evidence the whole screen exists to collect.
function markBought(lineId, onDone) {
  modal('Mark bought', `
    <div class="row">${field('Supplier', 'supplier')}${field('Invoice no', 'invoice_no')}</div>
    <div class="row">${field('Invoice date', 'invoice_date', { type: 'date' })}${field('Amount for this item (line total)', 'purchase_amount', { type: 'number' })}</div>
    <label>Invoice photo *</label>
    <input type="file" id="pu-img" accept="image/*" multiple>
    <div id="pu-thumbs" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"></div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Up to 3 photos. Marking it bought does not put it into stock — the storekeeper still receives it when it arrives.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="pb">Mark bought</button></div>`,
    (body, close) => {
      const images = [];
      qs('#pu-img', body).onchange = async (e) => {
        for (const f of [...e.target.files].slice(0, 3 - images.length)) {
          try { images.push(await shrinkImage(f)); } catch (err) { toast('Could not read that photo', 'err'); }
        }
        qs('#pu-thumbs', body).innerHTML = images.map((src, i) =>
          `<img src="${src}" style="height:64px;border-radius:4px;border:1px solid var(--border)" alt="invoice ${i + 1}">`).join('');
      };
      qs('#pb', body).onclick = async () => {
        if (!images.length) { toast('Attach a photo of the invoice', 'err'); return; }
        const f = formData(body);
        try {
          const r = await api(`/purchasing/lines/${lineId}/purchase`, { method: 'POST', body: { ...f, images } });
          toast(r.message); close(); onDone();
        } catch (e) { toast(e.message, 'err'); }
      };
    }, { wide: true });
}

async function viewPurchase(lineId, onDone) {
  let d;
  try { d = await api(`/purchasing/lines/${lineId}`); } catch (e) { toast(e.message, 'err'); return; }
  modal(`${d.description || 'Item'} — ${d.mrn_no || ''}`, `
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">
      ${[['Supplier', d.supplier], ['Invoice', d.invoice_no], ['Invoice date', String(d.invoice_date || '').slice(0, 10)],
    ['Amount', d.purchase_amount == null ? '—' : money(d.purchase_amount)], ['Bought by', d.purchased_by],
    ['Bought on', String(d.purchased_at || '').slice(0, 10)]]
      .map(([l, v]) => `<div class="card"><div class="stat"><div class="l">${l}</div><div>${esc(v || '—')}</div></div></div>`).join('')}
    </div>
    ${d.price_check ? `<div class="card err" style="margin-top:10px">
      <b>The invoice and the receipt disagree.</b><br>
      Invoice ${money(d.price_check.invoice)} · received ${money(d.price_check.received)} ·
      difference ${money(d.price_check.difference)}.<br>
      <span class="muted">Neither is overwritten — someone should say which is right.</span></div>` : ''}
    ${d.invoices.length ? `<h3>Invoice</h3><div style="display:flex;gap:8px;flex-wrap:wrap">${d.invoices.map((i) => `<a href="${i.image}" target="_blank" rel="noopener"><img src="${i.image}" style="height:150px;border-radius:4px;border:1px solid var(--border)" alt="invoice"></a>`).join('')}</div>` : ''}
    ${d.receipts.length ? `<h3>Received</h3>${tableWrap(
        [{ label: 'GRN' }, { label: 'Qty', num: true }, { label: 'Unit', num: true }, { label: 'Value', num: true }, { label: 'Delivered' }],
        d.receipts.map((g) => `<tr><td class="mono">${esc(g.grn_no || '')}</td><td class="num">${num(g.qty)}</td>
        <td class="num">${g.unit_price == null ? '—' : money(g.unit_price)}</td><td class="num">${money(g.value)}</td>
        <td>${esc(String(g.delivery_date || '').slice(0, 10))}</td></tr>`))}`
      : '<p class="muted">Not yet received into stores.</p>'}
    <div style="margin-top:12px;text-align:right">
      ${d.qty_received > 0 ? '' : '<button class="sm danger" id="undo">Clear this purchase</button>'}
    </div>`,
    (body, close) => {
      const u = qs('#undo', body);
      if (u) {
        u.onclick = async () => {
          try { const r = await api(`/purchasing/lines/${lineId}/purchase`, { method: 'DELETE' }); toast(r.message); close(); onDone(); }
          catch (e) { toast(e.message, 'err'); }
        };
      }
    }, { wide: true });
}

// Photos come off a phone at several megabytes. Resized here, before upload, because the database
// is copied whole every 30 minutes — an oversized invoice does not just make one row big, it
// multiplies every backup from here on.
function shrinkImage(file, maxSide = 1400, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('unreadable'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not an image'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

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
    <div class="row">${field('Site', 'site')}${field('Priority', 'priority', {
    type: 'select',
    options: [['normal', 'Normal'], ['urgent', 'Urgent'], ['breakdown', 'Breakdown']].map(([v, l]) => ({ value: v, label: l }))
  })}</div>
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
          const r = await api('/tb/requests', {
            method: 'POST', body: {
              kind, asset_id: f.asset_id, site: f.site, purpose: f.notes, reason: f.reason,
              lines: rows.map((ln) => ({
                spec_id: ln.spec_id, qty: ln.qty, reason: f.reason, position: ln.position,
                km_reading: f.km_reading, old_serial: ln.old_serial, priority: f.priority, notes: f.notes
              })),
            }
          });
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
    ${field('Bought by', 'purchase_source', {
    type: 'select', options: [
      { value: 'head_office', label: 'Head Office' }, { value: 'local_purchase', label: 'Local purchase' }]
  })}
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
// Stores plan, Part 4: a tyre or a battery goes out by its serial number, one row a unit, and is
// fixed to the vehicle (ST-D6, D7). A tyre names its wheel, and the one there now comes off. What
// came off can be said here, or later under "Old units due" (ST-D8). A tube or a flap goes as before.
const TB_CONDS = { tyre: ['repairable', 'retreadable', 'reusable', 'warranty', 'scrap', 'not_returned'], battery: ['reusable', 'warranty', 'scrap', 'not_returned'] };
async function tbIssueModal(request, line, done) {
  const kind = line.kind;
  const byUnit = kind === 'tyre' || kind === 'battery';
  const left = Math.max(0, (line.qty || 0) - (line.issued || 0));
  let onIt = { tyres: [], batteries: [] };
  if (byUnit && request.asset_id) { try { onIt = await api('/tb/vehicle/' + request.asset_id); } catch (e) { /* shown without it */ } }
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  modal('Issue against ' + request.mrn_no, `
    <div class="note">${esc(line.spec_label || line.description)} · approved ${num(line.qty)}${line.issued ? ' · ' + num(line.issued) + ' gone out' : ''}${request.asset_code ? ' · ' + esc(request.asset_code) : ''}</div>
    <div class="row">${field('How many now', 'qty', { type: 'number', value: byUnit ? Math.min(left, 8) : left })}
      ${field('Date', 'issue_date', { type: 'date', value: today })}</div>
    ${byUnit ? `<p class="muted" style="margin:6px 0 2px;font-size:12px">${kind === 'tyre'
    ? 'Each tyre: its serial number and wheel. The tyre now at that wheel comes off.'
    : `Each battery: its serial number. ${esc(request.asset_code || 'The vehicle')} has ${onIt.batteries.length} now (2 at most).`}</p><div id="tbu"></div>`
    : field('Serial number (if it has one)', 'serial_no')}
    <div class="row">${field('Unit price (blank = list price)', 'unit_price', { type: 'number' })}${field('Issued by', 'issued_by')}</div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Issue</button></div>`,
    (body, close) => {
      const units = [];
      const host = qs('#tbu', body);
      const conds = TB_CONDS[kind] || [];
      const atWheel = (pos) => onIt.tyres.find((t) => String(t.position || '').toUpperCase() === String(pos || '').toUpperCase());
      const draw = () => {
        if (!host) return;
        const want = Math.max(0, Math.min(Math.floor(Number(qs('[name=qty]', body).value) || 0), 8));
        while (units.length < want) units.push({ serial_no: '', position: units.length ? '' : (line.position || ''), old_serial: '', old_condition: '', old_reason: '', photo: null });
        units.length = want;
        host.innerHTML = units.map((u, i) => {
          const here = kind === 'tyre' ? atWheel(u.position) : null;
          const offOpts = kind === 'tyre'
            ? [['', here ? `${here.serial_no} (at ${u.position})` : 'None']].concat(onIt.tyres.filter((t) => t !== here).map((t) => [t.serial_no, `${t.serial_no} (at ${t.position || '?'})`]))
            : [['', 'None']].concat(onIt.batteries.map((b) => [b.serial_no, b.serial_no]));
          return `<div class="card" style="padding:8px 10px;margin:6px 0">
            <b style="font-size:12px">${kind === 'tyre' ? '🛞 Tyre' : '🔋 Battery'} ${i + 1}</b>
            <div class="row">
              <div><label>Serial number *</label><input data-u="${i}" data-f="serial_no" value="${esc(u.serial_no)}"></div>
              ${kind === 'tyre' ? `<div><label>Wheel *</label><select data-u="${i}" data-f="position"><option value="">—</option>${TB_POS.map((p) => `<option${p === u.position ? ' selected' : ''}>${p}</option>`).join('')}</select></div>` : ''}
            </div>
            <div class="row">
              <div><label>Coming off</label><select data-u="${i}" data-f="old_serial">${offOpts.map(([v, l]) => `<option value="${esc(v)}"${v === u.old_serial ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
              <div><label>What came off</label><select data-u="${i}" data-f="old_condition"><option value="">Say later</option>${conds.map((c) => `<option value="${c}"${c === u.old_condition ? ' selected' : ''}>${esc(TB_COND_LABEL[c])}</option>`).join('')}</select></div>
            </div>
            ${u.old_condition === 'not_returned' ? `<label>Why not returned *</label><input data-u="${i}" data-f="old_reason" value="${esc(u.old_reason)}">` : ''}
            <label class="btn sm" style="cursor:pointer;margin:6px 0 0">📷 ${u.photo ? 'Photo added ✔' : 'Photo of serial (recommended)'}<input type="file" accept="image/png,image/jpeg,image/webp" data-photo="${i}" style="display:none"></label>
          </div>`;
        }).join('');
        qsa('[data-u]', host).forEach((el) => {
          const set = () => { units[+el.dataset.u][el.dataset.f] = el.value; };
          el.oninput = set;
          el.onchange = () => { set(); if (el.tagName === 'SELECT') draw(); };
        });
        qsa('[data-photo]', host).forEach((el) => {
          el.onchange = async (e) => {
            const f = e.target.files[0]; if (!f) return;
            try { units[+el.dataset.photo].photo = await resizeToDataUrl(f); draw(); } catch (err) { toast(err.message, 'err'); }
          };
        });
      };
      if (host) { qs('[name=qty]', body).oninput = draw; draw(); }
      qs('#s', body).onclick = async () => {
        const f = formData(body);
        const payload = { mrn_line_id: line.mrn_line_id, qty: f.qty, issue_date: f.issue_date, unit_price: f.unit_price, issued_by: f.issued_by };
        if (byUnit) {
          if (units.some((u) => !u.serial_no.trim())) return toast('Give the serial number of each one', 'err');
          if (kind === 'tyre' && units.some((u) => !u.position)) return toast('Choose the wheel of each tyre', 'err');
          payload.units = units.map((u) => ({ ...u, photo: u.photo || undefined }));
        } else payload.serial_no = f.serial_no;
        try {
          const r = await api('/tb/issue', { method: 'POST', body: payload });
          toast(r.message || 'Issued');
          close(); done && done();
        } catch (e) { toast(e.message, 'err'); }
      };
    }, { wide: true });
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
    qsa('.tb-ovr', c).forEach((inp) => {
      inp.onchange = async () => {
        try { await api('/tyre-battery/issues/' + inp.dataset.id, { method: 'PATCH', body: { unit_price: inp.value === '' ? null : Number(inp.value) } }); toast('Override saved'); loadIssues(); loadSummary(); }
        catch (e) { toast(e.message, 'err'); }
      };
    });
  };
  qs('#tb-month', c).onchange = loadIssues;
  let qTimer; qs('#tb-q', c).oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadIssues, 300); };
  loadSummary(); loadCats(); loadIssues();
};

routes.reports = async (c) => {
  // Stage 5: a workshop picker once there is more than one workshop. Head office: "All workshops"
  // or any one; someone kept to their own sees only theirs (store staff: the ones their store serves).
  const wsd = wsMulti() ? await workshopsData().catch(() => null) : null;
  const seen = ME && ME.workshopsSeen;
  const wsChoices = wsd ? wsd.workshops.filter((w) => w.active && (!seen || seen.includes(w.id))) : [];
  if (wsd && seen && !seen.includes(Number(REP_WS))) REP_WS = String((ME.workshop && seen.includes(ME.workshop.id)) ? ME.workshop.id : seen[0]);
  if (wsd && !seen && REP_WS && !wsChoices.some((w) => String(w.id) === String(REP_WS))) REP_WS = '';
  if (!wsd) REP_WS = '';
  const repTitle = REP_WS && wsd ? `Edward and Christie (Pvt) Ltd — ${wsName(wsd, Number(REP_WS))}` : 'Edward and Christie (Pvt) Ltd — Badalgama Central Workshop';
  c.innerHTML = `${pageHeader('Reports', repTitle)}
    ${wsd ? `<div class="toolbar" style="margin:0 0 10px">
      <label class="muted" style="font-size:12px">Workshop</label>
      ${wsChoices.length === 1 && seen ? `<span class="badge blue">${esc(wsChoices[0].name)}</span>`
    : `<select id="rep-ws" style="max-width:280px">${seen ? '' : `<option value="" ${REP_WS ? '' : 'selected'}>All workshops</option>`}
          ${wsChoices.map((w) => `<option value="${w.id}" ${String(w.id) === String(REP_WS) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>`}
    </div>` : ''}
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
        <button class="sm" id="dr-t-tally" style="display:none">⏱ Day Tally</button>
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
        <span class="muted" style="font-weight:400">— full 14-sheet master workbook (PROFIT OR LOSS · Repair · Service · Tyre · Battery · Oils · General · Fuel · Salaries · Overhead · Total Cost · Material Summary · Cost Comparison · Job-wise Comparison; plus Attendance &amp; utilisation while attendance is on). Partly closed jobs are in Closed, marked "prices pending".</span>
        <div class="spacer"></div>
        <div><label>Year</label><select id="mcr-year"></select></div>
        <div><label>Month</label><select id="mcr-month"></select></div>
        ${canDo('reports.monthly_inputs') ? '<button class="sm" id="mcr-edit">✎ Edit monthly inputs</button>' : ''}
        <button class="sm secondary" id="mcr-reconcile" title="Reconcile Closed, Pending, Other Labour and Spares Supply with live daily work tally">⚖️ Repair Sections Reconciler</button>
        <a class="btn sm" id="mcr-rd" href="#" target="_blank">🖨 Repair Detail</a>
        <a class="btn primary sm" id="mcr-dl" href="#">⬇ Download Excel</a>
      </div>
      <div id="mcr-preview" class="muted">Loading…</div></div>
    ${wsd && !seen && !REP_WS ? `<div class="card section"><h3 style="margin-top:0">Workshops compared <span class="muted" style="font-weight:400;font-size:12px">— the month chosen above, one row per workshop</span></h3>
      <div id="rep-cmp" class="muted">Loading…</div></div>` : ''}`;
  if (qs('#rep-ws', c)) qs('#rep-ws', c).onchange = (e) => { REP_WS = e.target.value; routes.reports(c); };

  // ---- Daily Reports: the two sheets the office used to type by hand.
  // Today reads live so it is always current; an earlier day reads its frozen copy, so a sheet
  // printed last week still says what it said then.
  let drKind = 'pending_parts';
  const drDate = qs('#dr-date', c), drBody = qs('#dr-body', c), drStamp = qs('#dr-stamp', c);
  const drCanEdit = canDo('reports.daily.notes');

  const drNote = (id, field, value, ph) => drCanEdit
    ? `<textarea class="dr-note" data-id="${id}" data-f="${field}" rows="2" placeholder="${esc(ph || '')}"
         style="width:100%;font-size:12px;resize:vertical">${esc(value || '')}</textarea>`
    : esc(value || '');

  const drRender = (d) => {
    drStamp.textContent = d.saved
      ? `frozen copy of that day · saved ${String(d.generated_at || '').slice(0, 16)}`
      : (d.last_saved_at ? `live · last saved ${String(d.last_saved_at).slice(0, 16)}` : 'live · not saved yet');
    if (drKind === 'day_tally') {
      if (!d.rows.length) { drBody.innerHTML = '<p class="muted">No attendance or daily work on this day.</p>'; return; }
      const ST = { present: 'Present', absent: 'Absent', leave: 'Leave', half_day: 'Half day', holiday: 'Holiday' };
      const c2 = d.counts || {};
      drBody.innerHTML = `<p class="muted" style="margin:0 0 8px">${d.locked && d.signoff ? `🔒 Signed off by ${esc(d.signoff.signed_by || '—')} · ${esc(d.signoff.signed_at || '')}` : (d.before_start ? 'Before the attendance start date — not checked.' : 'Not signed off yet.')}
          · ✅ ${c2.matched || 0} matched · 🟡 ${c2.unbooked || 0} unbooked · <b style="color:${d.red_count ? 'var(--red)' : 'inherit'}">🔴 ${d.red_count || 0} red</b></p>`
        + tableWrap([{ label: 'No', width: '44px' }, { label: 'Mechanic' }, { label: 'Status' }, { label: 'In' }, { label: 'Out' },
          { label: 'Worked', num: true }, { label: 'Booked', num: true }, { label: 'Difference', num: true }, { label: 'Tally' }, { label: 'Note / reason' }],
        d.rows.map((r) => `<tr><td>${r.no}</td><td><b>${esc(r.mechanic)}</b></td><td>${esc(ST[r.status] || '—')}</td>
            <td>${esc(r.time_in || '—')}</td><td>${esc(r.time_out || '—')}</td>
            <td class="num">${fmtH(r.worked)}</td><td class="num">${fmtH(r.booked)}</td>
            <td class="num">${r.diff == null ? '—' : (r.diff > 0 ? '+' : '') + fmtH(r.diff)}</td>
            <td><span class="badge ${r.red ? 'red' : r.tally === 'matched' ? 'green' : r.tally === 'unbooked' ? 'amber' : ''}">${esc(r.tally_label)}</span></td>
            <td class="muted">${esc(r.note || '')}</td></tr>`), { scroll: true })
        + (d.unmatched && d.unmatched.length ? `<p class="muted" style="margin-top:8px"><b>Names not matched to a mechanic:</b> ${d.unmatched.map((u) => `${esc(u.name)} (${fmtH(u.hours)}, ${esc(u.jobs)})`).join(' · ')}</p>` : '');
      return;
    }
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
    qs('#dr-dl', c).href = `/api/reports/daily/${drKind}/export.xlsx?date=${date}${repWsQ()}`;
    qs('#dr-t-pending', c).classList.toggle('primary', drKind === 'pending_parts');
    qs('#dr-t-price', c).classList.toggle('primary', drKind === 'pending_price');
    qs('#dr-t-jobs', c).classList.toggle('primary', drKind === 'job_summary');
    qs('#dr-t-tally', c).classList.toggle('primary', drKind === 'day_tally');
    drBody.innerHTML = '<div class="muted">Loading…</div>';
    try { drRender(await api(`/reports/daily/${drKind}?date=${date}${repWsQ()}`)); }
    catch (e) { drBody.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    try {
      const h = await api(`/reports/daily/${drKind}/history?limit=30${repWsQ()}`);
      qs('#dr-hist', c).innerHTML = h.length ? tableWrap(
        [{ label: 'Day' }, { label: 'Rows', num: true }, { label: 'Saved at' }, { label: 'By' }, { label: '' }],
        h.map((x) => `<tr><td>${esc(x.report_date)}</td><td class="num">${x.row_count}</td>
          <td class="muted">${esc(String(x.generated_at).slice(0, 16))}</td><td class="muted">${esc(x.generated_by_name || 'auto')}</td>
          <td><a class="btn sm" href="/api/reports/daily/${drKind}/export.xlsx?date=${x.report_date}${repWsQ()}">⬇</a></td></tr>`))
        : '<p class="muted" style="margin:0">No saved days yet.</p>';
    } catch (e) { /* history is a nicety */ }
  };
  qs('#dr-t-pending', c).onclick = () => { drKind = 'pending_parts'; drLoad(); };
  qs('#dr-t-price', c).onclick = () => { drKind = 'pending_price'; drLoad(); };
  qs('#dr-t-jobs', c).onclick = () => { drKind = 'job_summary'; drLoad(); };
  qs('#dr-t-tally', c).onclick = () => { drKind = 'day_tally'; drLoad(); };
  // The Day Tally tab is there only while attendance is on, and for those who may read Daily Work.
  if (canView('dailywork')) {
    api('/attendance/settings').then((s) => { if (s && s.enabled) qs('#dr-t-tally', c).style.display = ''; }).catch(() => {});
  }
  drDate.onchange = drLoad;
  qs('#dr-save', c).onclick = async () => {
    try {
      const r = await api(`/reports/daily/${drKind}/save`, { method: 'POST', body: { date: drDate.value, workshop_id: REP_WS || undefined } });
      toast(`Saved ${r.report_date} — ${r.row_count} row(s)`); drLoad();
    }
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
    mcrDl.href = `/api/reports/monthly-cost.xlsx?year=${y}&month=${mo}${repWsQ()}`;
    qs('#mcr-rd', c).href = `/api/reports/monthly-repair-detail.html?year=${y}&month=${mo}${repWsQ()}`;
    mcrPrev.innerHTML = '<span class="muted">Loading…</span>';
    // Stage 5: one row per workshop, for head office looking at all of them.
    if (qs('#rep-cmp', c)) {
      api(`/reports/workshops-compared?year=${y}&month=${mo}`).then((d) => {
        const rows = d.rows || [];
        const sum = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
        const K = [['repair_jobs', 'Repair jobs', 0], ['jobs_closed', 'Closed', 0], ['services', 'Services', 0], ['labour', 'Labour', 1],
          ['spare_parts', 'Spare parts', 1], ['lubricants', 'Lubricants', 1], ['other_material', 'Other material', 1],
          ['overheads', 'Overheads', 1], ['total', 'Total cost', 1], ['hours_booked', 'Hours booked', 0]];
        qs('#rep-cmp', c).innerHTML = tableWrap([{ label: 'Workshop' }].concat(K.map(([, l]) => ({ label: l, num: true }))),
          rows.map((r) => `<tr><td>${esc(r.name)}</td>${K.map(([k, , m]) => `<td class="num">${m ? money(r[k]) : num(r[k])}</td>`).join('')}</tr>`)
            .concat([`<tr><td><b>All workshops</b></td>${K.map(([k, , m]) => `<td class="num"><b>${m ? money(sum(k)) : num(sum(k))}</b></td>`).join('')}</tr>`]),
          { scroll: true });
      }).catch((e) => { qs('#rep-cmp', c).innerHTML = `<span class="err">${esc(e.message)}</span>`; });
    }
    let p;
    try { p = (await api(`/reports/monthly-inputs?year=${y}&month=${mo}${repWsQ()}`)).preview; }
    catch (e) { mcrPrev.innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }

    const pl = p.profit_loss;
    const isZero = pl && (pl.is_zero || (pl.in_house_cost === 0 && pl.outside_cost === 0));
    const plBanner = pl ? (isZero ? `<div style="background:#f1f3f4;border:1px solid #dadce0;padding:12px;border-radius:6px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-weight:700;font-size:15px;color:#5f6368">ZERO VALUE · NO ACTIVITY: Rs 0.00</div>
        <div style="font-size:12px;color:#3c4043">In-house absorbed cost: <b>Rs 0.00</b> vs Outside estimate: <b>Rs 0.00</b> (No transactions or inputs recorded for this month)</div>
      </div>
      <a class="btn primary sm" href="/api/reports/monthly-cost.xlsx?year=${y}&month=${mo}${repWsQ()}">⬇ Download 14-Sheet Bill</a>
    </div>` : `<div style="background:${pl.is_profit ? '#e6f4ea' : '#fce8e6'};border:1px solid ${pl.is_profit ? '#a8dab5' : '#f5c6cb'};padding:12px;border-radius:6px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-weight:700;font-size:15px;color:${pl.is_profit ? '#137333' : '#c5221f'}">${pl.is_profit ? 'PROFIT' : 'LOSS'}: Rs ${money(pl.saving_amount)}</div>
        <div style="font-size:12px;color:#3c4043">In-house absorbed cost: <b>Rs ${money(pl.in_house_cost)}</b> vs Outside estimate: <b>Rs ${money(pl.outside_cost)}</b> (${(pl.saving_pct * 100).toFixed(1)}% ${pl.is_profit ? 'cheaper than outside' : 'more expensive than outside'})</div>
      </div>
      <a class="btn primary sm" href="/api/reports/monthly-cost.xlsx?year=${y}&month=${mo}${repWsQ()}">⬇ Download 14-Sheet Bill</a>
    </div>`) : '';

    const line = (label, count, total, warn) => `<tr><td>${esc(label)}</td><td class="num">${count}</td><td class="num">${money(total)}</td><td>${warn ? '<span class="badge amber">enter inputs</span>' : ''}</td></tr>`;
    const rows = [
      line('1. PROFIT OR LOSS', 'Headline', pl ? (isZero ? 0 : (pl.is_profit ? pl.saving_amount : -pl.saving_amount)) : 0),
      `<tr><td><a href="javascript:void(0)" id="mcr-row-repsec" style="font-weight:600;color:inherit;text-decoration:underline" title="Click to view Repair Cost Sections Reconciler">2. Repair cost (Closed + Pending + Other Labour + Spares)</a> <button class="sm" style="padding:1px 6px;margin-left:6px;font-size:11px" onclick="document.getElementById('mcr-reconcile').click()">Reconcile ⚖️</button></td><td class="num">${(p.repair.closed_count + p.repair.pending_count)} jobs</td><td class="num">${money(p.repair.closed_total + p.repair.pending_total + p.repair.other_labour_total + p.repair.spares_supply_total)}</td><td></td></tr>`,
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
    if (qs('#mcr-row-repsec', c)) qs('#mcr-row-repsec', c).onclick = () => openRepairSectionsReconciler(+mcrYear.value, +mcrMonth.value, loadMcr);
  };
  mcrYear.onchange = loadMcr; mcrMonth.onchange = loadMcr;
  if (qs('#mcr-edit', c)) qs('#mcr-edit', c).onclick = () => openMonthlyInputs(+mcrYear.value, +mcrMonth.value, loadMcr);
  qs('#mcr-reconcile', c).onclick = () => openRepairSectionsReconciler(+mcrYear.value, +mcrMonth.value, loadMcr);
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
  // Stage 5: the same workshop choice as the Reports page.
  const wsd = wsMulti() ? await workshopsData().catch(() => null) : null;
  const seen = ME && ME.workshopsSeen;
  const wsChoices = wsd ? wsd.workshops.filter((w) => w.active && (!seen || seen.includes(w.id))) : [];
  if (wsd && seen && !seen.includes(Number(REP_WS))) REP_WS = String((ME.workshop && seen.includes(ME.workshop.id)) ? ME.workshop.id : seen[0]);
  if (!wsd) REP_WS = '';
  c.innerHTML = `${pageHeader('Daily Report', 'One day at a glance — work done, jobs opened & closed, what’s still to do, items requested & received.')}
    <div class="toolbar">
      <label style="display:flex;gap:6px;align-items:center;flex-direction:row;width:auto">Date <input type="date" id="pgdate" value="${esc(date0)}" style="width:auto"></label>
      <button class="sm" id="pgprev">← Previous day</button>
      <button class="sm" id="pgnext">Next day →</button>
      ${wsd && !(seen && wsChoices.length === 1) ? `<select id="pgws" style="max-width:240px">${seen ? '' : `<option value="" ${REP_WS ? '' : 'selected'}>All workshops</option>`}
        ${wsChoices.map((w) => `<option value="${w.id}" ${String(w.id) === String(REP_WS) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>` : ''}
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
    qs('#pgprint').href = '/api/reports/daily-progress/print.html?date=' + encodeURIComponent(dt) + repWsQ();
    qs('#pgjobs').href = '/api/reports/jobs-summary.html?from=' + encodeURIComponent(dt);
    let rep;
    try { rep = await api('/reports/daily-progress?date=' + encodeURIComponent(dt) + repWsQ()); }
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
    const card = (title, cols, rows, empty) => `<div class="card section"><h3>${title}</h3>${rows.length ? tableWrap(cols, rows, { scroll: true, fit: true, noHScroll: true })
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
  if (qs('#pgws')) qs('#pgws').onchange = (e) => { REP_WS = e.target.value; load(); };
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
        <td><a href="#/jobs/${j.id}">${esc(j.job_no)}</a>${wsMulti() && j.workshop_name ? `<br><span class="muted" style="font-size:11px">${esc(j.workshop_name)}</span>` : ''}</td><td>${esc(j.type)}</td>
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

// ---- Stuck job cards (W0) --------------------------------------------------------------------
//
// REQUESTED cards that hold their vehicle but will never move. The server suggests what to do with
// each (src/lib/job_review.js); nothing changes until a person ticks cards and presses Apply.
routes.jobreview = async (c) => {
  if (!canDo('jobs.triage')) { c.innerHTML = '<div class="card err">You do not have access to this page.</div>'; return; }
  const d = await api('/jobs/review/stuck');
  const label = { reject: 'Reject — not carried out', close: 'Close — work was done', keep: 'Keep' };
  const badge = { reject: 'red', close: 'amber', keep: 'green' };
  let filter = 'reject';
  const choice = new Map();          // job id -> { action, close_date }
  for (const x of d.cards) if (x.preselected) choice.set(x.id, { action: x.suggestion, close_date: x.close_date });
  // This month and the three before it: a close dated in one of these lands in a report you may
  // already have handed out. Plain year*12+month arithmetic, so January looks back into December.
  const now = new Date();
  const recentMonths = new Set([0, 1, 2, 3].map((k) => {
    const m = now.getFullYear() * 12 + now.getMonth() - k;
    return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
  }));

  const draw = () => {
    const rows = d.cards.filter((x) => filter === 'all' || x.suggestion === filter);
    const act = (x) => {
      const ch = choice.get(x.id);
      return `<select data-act="${x.id}" style="width:auto">
          <option value="">— no change —</option>
          <option value="reject" ${ch && ch.action === 'reject' ? 'selected' : ''}>Reject</option>
          <option value="close" ${ch && ch.action === 'close' ? 'selected' : ''}>Close</option>
        </select>
        ${ch && ch.action === 'close' ? `<input type="date" data-cdate="${x.id}" value="${esc(ch.close_date || x.close_date || x.period || '')}" style="width:auto">
          <br><span class="muted" style="font-size:11px">goes in the <b>${esc(String(ch.close_date || x.close_date || '').slice(0, 7))}</b> cost report</span>` : ''}`;
    };
    const activityText = (a) => Object.entries(a).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ') || 'none';
    qs('#rv-body', c).innerHTML = tableWrap(
      [{ label: 'Job' }, { label: 'Vehicle' }, { label: 'Period' }, { label: 'Last activity' }, { label: 'Activity' }, { label: 'Cost', num: true }, { label: 'Suggestion' }, { label: 'Do' }],
      rows.map((x) => `<tr>
        <td><a href="#/jobs/${x.id}"><b>${esc(x.job_no)}</b></a>${x.imported ? ' <span class="badge">imported</span>' : ''}<br><span class="muted" style="font-size:11px">${esc(String(x.description || '').slice(0, 60))}</span></td>
        <td>${esc(x.vehicle || '—')}</td><td>${esc(x.period || '—')}</td>
        <td>${esc(x.last_activity || '—')}${x.age_days != null ? `<br><span class="muted" style="font-size:11px">${x.age_days} days ago</span>` : ''}</td>
        <td style="font-size:12px">${esc(activityText(x.activity))}</td>
        <td class="num">${x.total_cost ? money(x.total_cost) : '—'}</td>
        <td><span class="badge ${badge[x.suggestion]}">${esc(label[x.suggestion])}</span></td>
        <td style="white-space:nowrap">${act(x)}</td></tr>`),
      { scroll: true });
    const picked = [...choice.values()];
    const nRej = picked.filter((p) => p.action === 'reject').length;
    const nClose = picked.filter((p) => p.action === 'close').length;
    const recentClose = picked.filter((p) => p.action === 'close' && recentMonths.has(String(p.close_date || '').slice(0, 7))).length;
    qs('#rv-summary', c).innerHTML = `Chosen: <b>${nRej}</b> to reject, <b>${nClose}</b> to close.
      ${recentClose ? `<span class="badge amber">${recentClose} would land in a recent cost-report month — check the dates</span>` : ''}`;
    qs('#rv-apply', c).disabled = !picked.length;
    qsa('[data-act]', c).forEach((sel) => sel.onchange = () => {
      const x = d.cards.find((k) => k.id == sel.dataset.act);
      if (!sel.value) choice.delete(x.id);
      else choice.set(x.id, { action: sel.value, close_date: sel.value === 'close' ? (x.close_date || x.period) : null });
      draw();
    });
    qsa('[data-cdate]', c).forEach((inp) => inp.onchange = () => {
      const ch = choice.get(Number(inp.dataset.cdate)); if (ch) ch.close_date = inp.value; draw();
    });
    qsa('[data-rvf]', c).forEach((b) => b.classList.toggle('primary', b.dataset.rvf === filter));
  };

  const dup = d.duplicate_vehicles.map((v) => `<tr><td><b>${esc(v.asset_code || v.asset_reg || '')}</b></td><td>${v.open_count}</td>
      <td>${v.jobs.map((j) => `<a href="#/jobs/${j.id}">${esc(j.job_no)}</a> <span class="muted">${esc(j.status)} · ${j.age_days} d</span>`).join('<br>')}</td></tr>`);

  c.innerHTML = `${pageHeader('Stuck job cards', '<a href="#/jobs">Job Cards</a>')}
    <div class="card">
      <p style="margin-top:0">A card in REQUESTED holds its vehicle: no new job can be opened for it. These <b>${d.total}</b> cards have
      not moved. The suggestions follow your rule: <b>no activity and nothing for ${d.stale_days} days → reject</b> ("not carried out");
      <b>work recorded but nothing for ${d.stale_days} days → close</b> on the last activity date. <b>Nothing changes until you press Apply.</b></p>
      <div class="pill-row">
        <button class="btn sm" data-rvf="reject">Reject (${d.counts.reject})</button>
        <button class="btn sm" data-rvf="close">Close (${d.counts.close})</button>
        <button class="btn sm" data-rvf="keep">Keep (${d.counts.keep})</button>
        <button class="btn sm" data-rvf="all">All (${d.total})</button>
      </div>
    </div>
    <div class="card"><div id="rv-body"></div></div>
    <div class="card">
      <div id="rv-summary" style="margin-bottom:8px"></div>
      <label>Why (goes on every card changed) *</label>
      <textarea id="rv-reason" rows="2" placeholder="e.g. Clean-up of old imported cards, reviewed by the workshop manager"></textarea>
      <div style="margin-top:10px;text-align:right"><button class="primary" id="rv-apply" disabled>Apply to the chosen cards</button></div>
    </div>
    <div class="card"><h3 style="margin-top:0">Vehicles with more than one open card (${d.duplicate_vehicles.length})</h3>
      ${tableWrap([{ label: 'Vehicle' }, { label: 'Open cards' }, { label: 'Cards' }], dup)}</div>`;
  qsa('[data-rvf]', c).forEach((b) => b.onclick = () => { filter = b.dataset.rvf; draw(); });
  qs('#rv-apply', c).onclick = async () => {
    const actions = [...choice.entries()].map(([job_id, p]) => ({ job_id, action: p.action, close_date: p.close_date }));
    if (!confirm(`Change ${actions.length} card(s)? This is recorded against your name.`)) return;
    try {
      const r = await api('/jobs/review/apply', { method: 'POST', body: { actions, reason: qs('#rv-reason', c).value } });
      toast(`${r.rejected} rejected, ${r.closed} closed`);
      routes.jobreview(c);
    } catch (e) { toast(e.message, 'err'); }
  };
  draw();
};

// A vehicle's card on its page. Another workshop's card (Stage 3, workshops kept apart) shows only
// its number, status and workshop, and does not open.
const assetJobLine = (j) => (j.reachable === false
  ? `<div class="cost-line"><span>${esc(j.job_no)} <span class="muted">· at ${esc(j.workshop_name || 'another workshop')}</span></span>${statusBadge(j.status)}</div>`
  : `<div class="cost-line"><a href="#/jobs/${j.id}">${esc(j.job_no)}</a>${statusBadge(j.status)}</div>`);

// ---- Workshops (multi-site Stage 2) ---------------------------------------------------------
//
// A workshop repairs vehicles and has its own mechanics and job cards; a SITE is where a vehicle
// works (the Projects list). Until a second workshop is added (ME.workshopsMulti), no workshop
// picker, column or filter appears anywhere else — the screens look as they always did.
let WS_CACHE = null;
async function workshopsData(fresh) {
  if (!WS_CACHE || fresh) WS_CACHE = await api('/workshops');
  if (ME) ME.workshopsMulti = WS_CACHE.multi;
  return WS_CACHE;
}
const wsMulti = () => !!(ME && ME.workshopsMulti);
const wsOptions = (d) => d.workshops.filter((w) => w.active).map((w) => ({ value: w.id, label: w.name }));
const wsName = (d, id) => { const w = d && d.workshops.find((x) => x.id === id); return w ? w.name : '—'; };

routes.workshops = async (c) => {
  if (!canDo('workshops.manage', 'mechanics.move')) { c.innerHTML = '<div class="card err">You do not have access to this page.</div>'; return; }
  const [d, mechs] = await Promise.all([workshopsData(true), api('/workshops/mechanics')]);
  const manage = canDo('workshops.manage');
  const move = canDo('mechanics.move');
  // Stage 4: each workshop has its own store or uses another's. Shown once there are two workshops.
  const storeCell = (w) => {
    if (w.own_store) return `<span class="badge green">Own store</span>${w.store_opened ? `<br><span class="muted" style="font-size:12px">since ${esc(w.store_opened)}</span>` : ''}`;
    return `<span class="muted">Uses</span> ${esc(wsName(d, d.store_of[w.id]))}`;
  };
  const rows = d.workshops.map((w) => `<tr${w.active ? '' : ' style="opacity:.55"'}>
    <td><b>${esc(w.name)}</b>${w.is_default ? ' <span class="badge blue">main</span>' : ''}${w.active ? '' : ' <span class="badge">retired</span>'}<br><span class="muted" style="font-size:12px">${esc(w.code)}${w.place ? ' · ' + esc(w.place) : ''}</span></td>
    <td class="num">${w.users}</td><td class="num">${w.mechanics}</td><td class="num">${w.open_jobs}</td>
    ${d.multi ? `<td>${storeCell(w)}</td>` : ''}
    ${manage ? `<td class="num" style="white-space:nowrap"><button class="sm" data-wedit="${w.id}">✎ Edit</button>
      ${d.multi && w.active && !w.is_default ? `<button class="sm" data-wstore="${w.id}">Store…</button>` : ''}
      ${w.is_default ? '' : (w.active ? `<button class="sm danger" data-wretire="${w.id}">Retire</button>` : `<button class="sm" data-wback="${w.id}">Reinstate</button>`)}</td>` : ''}</tr>`);
  const mrows = mechs.filter((m) => m.active).map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(wsName(d, m.workshop_id))}</td>
    <td class="muted">${m.last_move ? 'since ' + esc(m.last_move) : ''}</td>
    ${move ? `<td class="num"><button class="sm" data-mmove="${m.id}" data-name="${esc(m.name)}" data-ws="${m.workshop_id}">Move…</button></td>` : ''}</tr>`);
  c.innerHTML = `${pageHeader('Workshops', 'Where vehicles are repaired. Sites — where vehicles work — are on the Projects page.')}
    <div class="card">
      <div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Workshops</h3><div class="spacer"></div>${manage ? '<button class="primary sm" id="wnew">+ Add workshop</button>' : ''}</div>
      ${tableWrap([{ label: 'Workshop' }, { label: 'People', num: true }, { label: 'Mechanics', num: true }, { label: 'Open job cards', num: true }]
    .concat(d.multi ? [{ label: 'Store' }] : []).concat(manage ? [{ label: '', num: true }] : []), rows)}
      <p class="muted" style="font-size:12px;margin:8px 0 0">${d.multi
        ? 'Each person has a home workshop (Access Control → Users). New job cards go to the home workshop of whoever raises them.'
        : 'With one workshop, nothing else changes on any screen. When you add a second, job cards, requests and people show their workshop.'}</p>
      ${d.multi ? `<p class="muted" style="font-size:12px;margin:4px 0 0">${d.stores_multi
    ? 'Each store has its own stock. Goods received go into the store of the request\'s workshop; issues come out of the store of the job\'s workshop.'
    : 'All stock is in one store. Give a workshop its own store with Store…'}</p>` : ''}
    </div>
    <div class="card">
      <div class="toolbar" style="margin:0 0 6px"><h3 style="margin:0">Separate workshops</h3><div class="spacer"></div>
        ${manage ? `<button class="sm ${d.separate ? 'danger' : 'primary'}" id="wsep">${d.separate ? 'Turn off' : 'Turn on'}</button>` : ''}</div>
      <p style="margin:0">${d.separate
        ? (d.separate_in_force ? '<span class="badge green">On</span> Each workshop sees only its own job cards, job requests, requests (MRN), daily work and approvals.'
          : '<span class="badge amber">On, waiting</span> It takes effect when there is a second workshop.')
        : '<span class="badge">Off</span> Everyone sees every workshop\'s work, as before.'}</p>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Head office (Admin, Manager, Operational Manager, Purchasing) always sees every workshop.
        Store staff see the requests and job cards of every workshop their store serves. Vehicles and reports stay shared.</p>
    </div>
    <div class="card">
      <h3 style="margin:0 0 8px">Mechanics</h3>
      ${tableWrap([{ label: 'Mechanic' }, { label: 'Workshop' }, { label: '' }].concat(move ? [{ label: '', num: true }] : []), mrows, { scroll: true })}
      <p class="muted" style="font-size:12px;margin:8px 0 0">A move keeps its date, so hours worked before it stay with the old workshop.</p>
    </div>`;
  const edit = (w) => modal(w ? `Edit ${w.name}` : 'Add a workshop', `
    ${field('Name', 'name', { value: w ? w.name : '', placeholder: 'e.g. Muthur Site Workshop' })}
    ${field('Short code', 'code', { value: w ? w.code : '', placeholder: 'e.g. MTR' })}
    ${field('Place', 'place', { value: w ? (w.place || '') : '', placeholder: 'Town' })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (body, close) => {
    qs('#s', body).onclick = async () => {
      try {
        await api(w ? `/workshops/${w.id}` : '/workshops', { method: w ? 'PATCH' : 'POST', body: formData(body) });
        close(); toast('Saved'); routes.workshops(c);
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  if (qs('#wnew', c)) qs('#wnew', c).onclick = () => edit(null);
  if (qs('#wsep', c)) qs('#wsep', c).onclick = async () => {
    const on = !d.separate;
    if (on && !confirm('Turn on "Separate workshops"? People outside head office will then see only their own workshop\'s job cards, requests and daily work.')) return;
    try { await api('/workshops/separate', { method: 'PUT', body: { on } }); toast(on ? 'Separate workshops: on' : 'Separate workshops: off'); routes.workshops(c); }
    catch (e) { toast(e.message, 'err'); }
  };
  qsa('[data-wedit]', c).forEach((b) => { b.onclick = () => edit(d.workshops.find((w) => String(w.id) === b.dataset.wedit)); });
  // Stage 4: its own store (from a date), or the store it uses.
  qsa('[data-wstore]', c).forEach((b) => {
    const w = d.workshops.find((x) => String(x.id) === b.dataset.wstore);
    const others = d.stores.filter((st) => st.id !== w.id).map((st) => ({ value: st.id, label: st.name }));
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    b.onclick = () => modal(`Store of ${w.name}`, `
      <label style="display:block;margin:4px 0"><input type="radio" name="kind" value="own" ${w.own_store ? 'checked' : ''}> Own store</label>
      <div id="st-own" style="margin-left:22px">${w.own_store
    ? `<p class="muted" style="margin:0">Open${w.store_opened ? ' since ' + esc(w.store_opened) : ''}.</p>`
    : field('Opens on', 'opened', { type: 'date', value: today })}</div>
      <label style="display:block;margin:8px 0 4px"><input type="radio" name="kind" value="uses" ${w.own_store ? '' : 'checked'}> Uses another workshop's store</label>
      <div id="st-uses" style="margin-left:22px">${field('Store', 'uses', { type: 'select', options: others, value: d.store_of[w.id] })}</div>
      <p class="muted" style="font-size:12px">A new store starts empty. Send stock to it with a transfer note (MTN). What was received before it opened stays where it was.</p>
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (body, close) => {
      qs('#s', body).onclick = async () => {
        const own = qs('input[name="kind"]:checked', body).value === 'own';
        if (own && !w.own_store && !confirm(`Open a store at ${w.name}? From then on its goods received and issues are in its own store.`)) return;
        try {
          const f = formData(body);
          await api(`/workshops/${w.id}/store`, { method: 'PUT', body: own ? { own: true, opened: f.opened } : { own: false, uses: f.uses } });
          close(); toast('Saved'); routes.workshops(c);
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  });
  const setActive = async (id, active) => {
    try { await api(`/workshops/${id}`, { method: 'PATCH', body: { active } }); toast(active ? 'Reinstated' : 'Retired'); routes.workshops(c); }
    catch (e) { toast(e.message, 'err'); }
  };
  qsa('[data-wretire]', c).forEach((b) => { b.onclick = () => { if (confirm('Retire this workshop? Nothing can be added to it until it is reinstated.')) setActive(b.dataset.wretire, false); }; });
  qsa('[data-wback]', c).forEach((b) => { b.onclick = () => setActive(b.dataset.wback, true); });
  qsa('[data-mmove]', c).forEach((b) => {
    b.onclick = () => modal(`Move ${b.dataset.name}`, `
      ${field('To workshop', 'workshop_id', { type: 'select', options: wsOptions(d), value: Number(b.dataset.ws) })}
      ${field('From date', 'from_date', { type: 'date', value: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) })}
      ${field('Note (optional)', 'note')}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Move</button></div>`, (body, close) => {
      qs('#s', body).onclick = async () => {
        try {
          const r = await api(`/workshops/mechanics/${b.dataset.mmove}/move`, { method: 'POST', body: formData(body) });
          close(); toast(`${r.mechanic} → ${r.workshop} from ${r.from_date}`); routes.workshops(c);
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  });
};

// ---- Access Control — roles & permissions, clearance board, users --------------------------
//
// Three tabs, each shown to whoever may use it: Roles & Permissions and the Clearance Board need
// access.manage, Users & Roles needs users.manage. The server enforces every rule (only give what
// you hold, only an admin touches the admin role, there is always an admin); these screens just
// make the rules visible before someone runs into them.
routes.access = async (c) => {
  if (!canDo('access.manage', 'users.manage')) { c.innerHTML = '<div class="card err">You do not have access to this page.</div>'; return; }
  const tabs = [];
  if (canDo('access.manage')) tabs.push(['roles', 'Roles & Permissions'], ['board', 'Clearance Board'], ['limits', 'Approval limits']);
  if (canDo('users.manage')) tabs.push(['users', 'Users & Roles']);
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = tabs.some((t) => t[0] === sp.get('tab')) ? sp.get('tab') : tabs[0][0];
  c.innerHTML = `${pageHeader('Access Control', 'Who may do what — roles, the permissions in each role, and who holds them.')}
    <div id="admin-warn"></div>
    <div class="pill-row" style="margin-bottom:12px">
      ${tabs.map(([k, label]) => `<button class="btn sm ${tab === k ? 'primary' : ''}" data-atab="${k}">${esc(label)}</button>`).join('')}
    </div>
    <div id="apane"><div class="muted">Loading…</div></div>`;
  qsa('[data-atab]', c).forEach((b) => { b.onclick = () => { location.hash = '#/access?tab=' + b.dataset.atab; }; });
  // One admin is a single point of failure: if that account is lost, only someone with a shell on
  // the server can get the system back (scripts/admin.js).
  api('/access/roles').then((r) => {
    if (r.active_admins < 2) {
      qs('#admin-warn', c).innerHTML = `<div class="card" style="border-left:4px solid #d97706;margin-bottom:12px"><b>Only ${r.active_admins} active admin.</b>
        If that account is lost or locked, nobody can manage users without logging in to the server. Give a second trusted person the admin role.</div>`;
    }
  }).catch(() => {});
  const pane = qs('#apane', c);
  if (tab === 'users') await renderUsersManager(pane);
  else if (tab === 'board') await renderClearanceBoard(pane);
  else if (tab === 'limits') await renderApprovalLimits(pane);
  else await renderRolesManager(pane, sp.get('role'));
};
routes.users = async () => { location.hash = '#/access?tab=users'; };

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

const lvlChip = (lvl) => {
  const cls = lvl === 'full' ? 'amber' : lvl === 'edit' ? 'green' : '';
  const txt = lvl === 'none' ? '—' : lvl.toUpperCase();
  return `<span class="badge ${cls}"${lvl === 'none' ? ' style="opacity:.4"' : ''}>${txt}</span>`;
};

async function renderRolesManager(c, wanted) {
  const [cat, board] = await Promise.all([api('/access/capabilities'), api('/access/matrix')]);
  const roles = cat.roles;
  const sel = roles.find((r) => r.name === wanted) || roles.find((r) => r.active && !r.locked) || roles[0];
  const modLabel = Object.fromEntries(cat.modules.map((m) => [m.key, m.label]));
  modLabel.users = 'Users & Access';
  const levelOf = (role, m) => (board.grid[role] && board.grid[role][m]) || 'none';
  const held = new Set(sel.caps);
  const mine = new Set(ME.caps || []);

  // Permissions grouped by section, in catalogue order.
  const groups = [];
  for (const cap of cat.capabilities) {
    let g = groups.find((x) => x.module === cap.module);
    if (!g) groups.push(g = { module: cap.module, caps: [] });
    g.caps.push(cap);
  }
  const editable = !sel.locked && sel.active;
  const capRows = groups.map((g) => {
    const lvl = levelOf(sel.name, g.module);
    const rows = g.caps.map((cap) => {
      const has = sel.locked || held.has(cap.key);
      // You can take away anything, but only give what you hold yourself (the server says the same).
      const canTick = editable && (has || isAdmin() || mine.has(cap.key));
      const short = cap.needs && has && !sel.locked && rankL(levelOf(sel.name, cap.needs)) < 2
        ? ` <span class="badge amber" title="The ${esc(modLabel[cap.needs] || cap.needs)} section blocks changes for this role until its clearance is EDIT or FULL">needs ${esc(modLabel[cap.needs] || cap.needs)} EDIT</span>` : '';
      return `<label style="display:flex;flex-direction:row;gap:8px;align-items:flex-start;margin:3px 0;font-weight:normal">
        <input type="checkbox" style="width:auto;margin-top:3px" data-cap="${esc(cap.key)}" ${has ? 'checked' : ''} ${canTick ? '' : 'disabled'}>
        <span>${esc(cap.label)}${short}<br><span class="muted" style="font-size:11px">${esc(cap.key)}</span></span></label>`;
    }).join('');
    return `<div class="card section" style="margin-bottom:10px"><h3 style="margin:0 0 6px">${esc(modLabel[g.module] || g.module)}
      <span class="muted" style="font-size:12px;font-weight:normal">— section clearance ${lvlChip(sel.locked ? 'full' : lvl)}</span></h3>${rows}</div>`;
  }).join('');

  const roleList = roles.map((r) => `<tr data-pick="${esc(r.name)}" style="cursor:pointer;${r.name === sel.name ? 'background:#eef2ff;' : ''}${r.active ? '' : 'opacity:.55;'}">
    <td><b>${esc(r.label || r.name)}</b>${r.locked ? ' <span class="badge amber">everything</span>' : ''}${r.is_system ? '' : ' <span class="badge blue">custom</span>'}${r.active ? '' : ' <span class="badge">retired</span>'}
    <br><span class="muted" style="font-size:11px">${r.users} user(s) · ${r.locked ? 'all' : r.caps.length} permission(s)</span></td></tr>`).join('');

  c.innerHTML = `<div style="display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:14px;align-items:start">
    <div class="card"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Roles</h3><div class="spacer"></div><button class="primary sm" id="newrole">+ New Role</button></div>
      <div class="table-wrap scroll"><table><tbody>${roleList}</tbody></table></div></div>
    <div>
      <div class="card" style="margin-bottom:10px">
        <div class="toolbar" style="margin:0"><h2 style="margin:0">${esc(sel.label || sel.name)}</h2><div class="spacer"></div>
          ${sel.locked ? '' : `<button class="sm" id="editrole">✎ Rename / describe</button>
          ${sel.active ? '<button class="sm danger" id="retirerole">Retire</button>' : '<button class="sm" id="reinstaterole">Reinstate</button>'}`}
        </div>
        <label style="flex-direction:row;display:flex;gap:6px;align-items:center;margin:8px 0 0;font-weight:normal">
          <input type="checkbox" id="rolemfa" style="width:auto" ${sel.require_mfa ? 'checked' : ''} ${sel.active && (!sel.locked || isAdmin()) ? '' : 'disabled'}>
          Require two-factor sign-in for everyone with this role <span class="muted" style="font-size:12px">— recommended for admins, approvers and purchasing</span></label>
        <p class="muted" style="margin:6px 0 0">${esc(sel.description || '')}${sel.description ? '<br>' : ''}Key <code>${esc(sel.name)}</code> · held by ${sel.users} active user(s).
          ${sel.locked ? ' Admin always holds every permission and cannot be changed.' : ''}
          ${!sel.active ? ' Retired — it grants nothing until reinstated.' : ''}
          ${editable ? ' Ticking a box applies from each holder\'s next click. Section clearance is set on the Clearance Board.' : ''}</p>
      </div>
      ${capRows}
    </div></div>`;

  const reload = (name) => { location.hash = '#/access?tab=roles&role=' + encodeURIComponent(name || sel.name); };
  qsa('[data-pick]', c).forEach((tr) => { tr.onclick = () => reload(tr.dataset.pick); });
  qs('#rolemfa', c).onchange = async (e) => {
    const on = e.target.checked;
    if (on && !confirm(`Everyone with "${sel.label || sel.name}" will have to set up two-factor sign-in before they can use the system. Continue?`)) { e.target.checked = false; return; }
    try { await api('/access/roles/' + encodeURIComponent(sel.name), { method: 'PATCH', body: { require_mfa: on } }); toast(on ? 'Two-factor sign-in required for this role' : 'No longer required'); reload(); }
    catch (err) { e.target.checked = !on; toast(err.message, 'err'); }
  };
  qsa('[data-cap]', c).forEach((box) => {
    box.onchange = async () => {
      try {
        await api('/access/capabilities', { method: 'POST', body: { role: sel.name, capability: box.dataset.cap, granted: box.checked } });
        await renderRolesManager(c, sel.name);
      } catch (e) { box.checked = !box.checked; toast(e.message, 'err'); }
    };
  });
  qs('#newrole', c).onclick = () => modal('New role', `
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
  // One column per switch, grouped under the sidebar's sections (access plan, Part 1). A section with
  // parts (Job Cards, Stores, Tyre & Battery Requests) has a column for each part.
  const byKey = new Map(m.modules.filter((mod) => mod.enforce).map((mod) => [mod.key, mod]));
  const groups = m.sections.map((s) => ({ label: s.label, mods: (s.modules || []).filter((k) => byKey.has(k)).map((k) => byKey.get(k)) }))
    .filter((g) => g.mods.length);
  const cols = groups.flatMap((g) => g.mods);
  const groupRow = groups.map((g) => `<th colspan="${g.mods.length}" style="text-align:center;border-left:2px solid var(--line, #ddd)">${esc(g.label)}</th>`).join('');
  const partRow = groups.map((g) => g.mods.map((mod, i) => `<th style="text-align:center;font-weight:400;font-size:11px${i ? '' : ';border-left:2px solid var(--line, #ddd)'}">${g.mods.length > 1 ? esc(mod.label.split(' · ').pop()) : ''}</th>`).join('')).join('');
  const rows = m.roles.map((r) => `<tr${r.active ? '' : ' style="opacity:.5"'}><td><b>${esc(r.label || r.name)}</b>${r.active ? '' : ' <span class="badge">retired</span>'}<br><span class="muted" style="font-size:11px">${esc(r.name)}</span></td>${cols.map((mod) => {
    const lvl = m.grid[r.name][mod.key];
    const locked = r.name === 'admin';
    return `<td style="text-align:center;cursor:${locked ? 'default' : 'pointer'}"${locked ? '' : ` data-cell="${esc(r.name)}:${mod.key}" data-lvl="${lvl}" title="click to change"`}>${lvlChip(lvl)}</td>`;
  }).join('')}</tr>`).join('');
  c.innerHTML = `<div class="card">
    <p class="muted" style="margin-top:0">Each section of the sidebar has its own switch, and the server checks it. The permissions on the <b>Roles &amp; Permissions</b> tab decide each action inside a section. Click a cell to cycle: — → VIEW → EDIT → FULL. <b>Admin</b> is always FULL. Dashboard is always on; Workshops and Access Control open with their permissions.</p>
    <div class="table-wrap scroll"><table><thead><tr><th rowspan="2">Role</th>${groupRow}</tr><tr>${partRow}</tr></thead><tbody>${rows}</tbody></table></div>
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
  const [users, roles, wsd] = await Promise.all([api('/users'), api('/users/roles'), workshopsData(true)]);
  // Home workshop (Stage 2): shown once there is more than one workshop.
  const multi = wsd.multi;
  const labelOf = Object.fromEntries(roles.map((r) => [r.name, r.label || r.name]));
  const roleBoxes = (checked = []) => roles.map((r) => `<label style="flex-direction:row;display:flex;gap:6px;align-items:flex-start;font-weight:normal">
      <input type="checkbox" style="width:auto;margin-top:3px" data-role="${esc(r.name)}" ${checked.includes(r.name) ? 'checked' : ''}>
      <span>${esc(r.label || r.name)}${r.description ? `<br><span class="muted" style="font-size:11px">${esc(r.description)}</span>` : ''}</span></label>`).join('');
  const picked = (body) => qsa('[data-role]', body).filter((x) => x.checked).map((x) => x.dataset.role);

  c.innerHTML = `<div class="toolbar"><button class="primary" id="nu">+ New User</button><div class="spacer"></div><span class="muted">${users.length} user(s)</span></div>
    ${tableWrap([{ label: 'Username' }, { label: 'Name' }].concat(multi ? [{ label: 'Workshop' }] : []).concat([{ label: 'Roles' }, { label: '2FA' }, { label: 'Active' }, { label: '' }]),
    users.map((u) => `<tr${u.active ? '' : ' style="opacity:.55"'}><td>${esc(u.username)}</td><td>${esc(u.full_name || '')}</td>
      ${multi ? `<td>${esc(wsName(wsd, u.workshop_id))} <button class="sm" data-uws="${u.id}" title="Change home workshop">✎</button></td>` : ''}
      <td>${u.roles.map((r) => `<span class="badge">${esc(labelOf[r] || r)}</span>`).join(' ')}</td>
      <td>${u.mfa_enabled ? '<span class="badge green">on</span>' : '<span class="muted">off</span>'}</td><td>${u.active ? '✓' : '✕'}</td>
      <td style="white-space:nowrap"><button class="sm" data-roles="${u.id}">Roles</button> <button class="sm" data-reset="${u.id}">Reset password</button>
        <button class="sm" data-sessions="${u.id}">Sessions</button>
        ${u.mfa_enabled ? `<button class="sm" data-mfareset="${u.id}" title="Lost or new phone">Reset 2FA</button>` : ''}
        <button class="sm ${u.active ? 'danger' : ''}" data-active="${u.id}">${u.active ? 'Deactivate' : 'Activate'}</button></td></tr>`))}`;
  qsa('[data-sessions]', c).forEach((b) => b.onclick = () => userSessionsModal(users.find((x) => x.id == b.dataset.sessions)));
  qsa('[data-mfareset]', c).forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.mfareset);
    if (!confirm(`Reset two-factor sign-in for ${u.username}? They are signed out, and set it up again with their new phone at next sign-in (if their role requires it) or when they choose to.`)) return;
    try { await api(`/users/${u.id}/mfa-reset`, { method: 'POST' }); toast('Two-factor sign-in reset'); renderUsersManager(c); } catch (e) { toast(e.message, 'err'); }
  });

  qs('#nu', c).onclick = () => modal('New User', `${field('Username *', 'username')}${field('Temporary password *', 'password', { type: 'password' })}
    <p class="muted">${esc(passwordHint())} They must choose their own at first sign-in.</p>${field('Full name', 'full_name')}
    ${multi ? field('Home workshop', 'workshop_id', { type: 'select', options: wsOptions(wsd), value: wsd.default_id }) : ''}<label>Roles</label>${roleBoxes()}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Create</button></div>`,
    (body, close) => {
      qs('#s', body).onclick = async () => {
        const d = formData(body); d.roles = picked(body);
        try { await api('/users', { method: 'POST', body: d }); close(); toast('User created'); renderUsersManager(c); } catch (e) { toast(e.message, 'err'); }
      };
    });
  qsa('[data-uws]', c).forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.id == b.dataset.uws);
    modal('Home workshop — ' + u.username, `${field('Workshop', 'workshop_id', { type: 'select', options: wsOptions(wsd), value: u.workshop_id })}
      <p class="muted">New job cards and requests they raise go to this workshop.</p>
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (body, close) => {
      qs('#s', body).onclick = async () => {
        try { await api(`/users/${u.id}`, { method: 'PATCH', body: { workshop_id: formData(body).workshop_id } }); close(); toast('Saved'); renderUsersManager(c); }
        catch (e) { toast(e.message, 'err'); }
      };
    });
  });
  qsa('[data-roles]', c).forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.id == b.dataset.roles);
    modal('Roles for ' + u.username, roleBoxes(u.roles) + '<div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>',
      (body, close) => {
        qs('#s', body).onclick = async () => {
          try { await api(`/users/${u.id}/roles`, { method: 'POST', body: { roles: picked(body) } }); close(); toast('Roles saved'); renderUsersManager(c); } catch (e) { toast(e.message, 'err'); }
        };
      });
  });
  qsa('[data-reset]', c).forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.id == b.dataset.reset);
    modal('Reset password — ' + u.username, `${field('Temporary password *', 'password', { type: 'password' })}
      <p class="muted">${esc(passwordHint())} ${esc(u.username)} is signed out everywhere and must choose a new password at next sign-in.</p>
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Reset</button></div>`,
      (body, close) => {
        qs('#s', body).onclick = async () => {
          try { await api(`/users/${u.id}`, { method: 'PATCH', body: { password: formData(body).password } }); close(); toast('Password reset'); } catch (e) { toast(e.message, 'err'); }
        };
      });
  });
  qsa('[data-active]', c).forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.active);
    if (u.active && !confirm(`Deactivate ${u.username}? They are signed out at once and cannot sign in again until reactivated.`)) return;
    try { await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); toast(u.active ? 'User deactivated' : 'User activated'); renderUsersManager(c); }
    catch (e) { toast(e.message, 'err'); }
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
      qsa('.mrnpick', menu).forEach((el) => {
        el.onclick = () => {
          input.value = el.dataset.name; hItem.value = el.dataset.id;
          if (unit && el.dataset.unit) unit.value = el.dataset.unit;
          const cat = qs('input[name=tcat]', row); if (cat && el.dataset.cat) cat.value = el.dataset.cat;
          close();
        };
      });
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
  // Places (Stage 2): workshops, projects and sites, offered as you type "From" and "To". Picking
  // one links the note to that place; anything else typed (a machine, "Head Office") stays text.
  const placeList = await api('/stores/places').catch(() => []);
  const placeOf = (text) => { const p = placeList.find((x) => x.label === String(text || '').trim()); return p ? p.key : undefined; };
  const wsd = wsMulti() ? await workshopsData().catch(() => null) : null;
  const fld = (...args) => `<div class="fld">${field(...args)}</div>`;
  const bg = modal(existing ? 'Edit MTN ' + esc(v.mtn_no) : 'New MTN (transfer)', `
    <datalist id="mtnplaces">${placeList.map((p) => `<option value="${esc(p.label)}">${esc(p.kind)}</option>`).join('')}</datalist>
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
      <p id="tstock" class="muted" style="font-size:12px;margin:6px 0 0;display:none"></p>
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
      const offerPlaces = (el) => qsa('input[name=from_location],input[name=to_location],input[name=tfrom],input[name=tto]', el)
        .forEach((i) => i.setAttribute('list', 'mtnplaces'));
      offerPlaces(root);
      const addLine = (line) => {
        const holder = document.createElement('div');
        holder.innerHTML = mtnLineHtml(line);
        const row = holder.firstElementChild;
        lines.appendChild(row);
        wireMtnLine(row);
        offerPlaces(row);
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
      // Stage 4: say when the note moves stock — from one workshop's store to another's, on its date.
      if (wsd && wsd.stores_multi) {
        const storeOn = (wsId, date) => {
          const w = wsd.workshops.find((x) => x.id === wsId);
          if (!w) return null;
          return w.own_store && (!w.store_opened || w.store_opened <= date) ? w.id : (w.uses_store || wsd.default_id);
        };
        const wsAt = (text) => { const k = placeOf(text); return k && /^w:\d+$/.test(k) ? Number(k.slice(2)) : null; };
        const hint = () => {
          const date = qs('input[name=txn_date]', root).value;
          const f = wsAt(qs('input[name=from_location]', root).value);
          const t = wsAt(qs('input[name=to_location]', root).value);
          const a = f && storeOn(f, date); const b = t && storeOn(t, date);
          const el = qs('#tstock', root);
          el.style.display = a && b && a !== b ? '' : 'none';
          el.innerHTML = a && b && a !== b ? `<span class="badge green">moves stock</span> Out of ${esc(wsName(wsd, a))}'s store, into ${esc(wsName(wsd, b))}'s store, on ${esc(date)}.` : '';
        };
        qsa('input[name=from_location],input[name=to_location],input[name=txn_date]', root).forEach((i) => { i.addEventListener('input', hint); i.addEventListener('change', hint); });
        hint();
      }
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
        from_place: placeOf(qs('input[name=tfrom]', row).value),
        to_place: placeOf(qs('input[name=tto]', row).value),
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
        const head = {
          mtn_no: d.mtn_no, txn_date: d.txn_date, from_location: d.from_location,
          to_location: d.to_location, transferred_by: d.transferred_by, received_by: d.received_by,
          reason: d.reason, to_asset: d.to_asset, from_place: placeOf(d.from_location), to_place: placeOf(d.to_location)
        };
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

// ===== Central Stock Cockpit & Automated Reorder Alerts =====
// Unified inventory valuation, reorder alerts board, and universal search. Backed by /api/stock-cockpit.
async function renderStockCockpitSection(c) {
  const edit = canEdit('stores');
  const canRestock = canDo('stores.reorder_mrn');

  c.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <div>
        <p class="muted" style="margin:0;font-size:13px">Unified live inventory valuation, automated reorder shortfalls &amp; 1-click restock procurement across all stores.</p>
      </div>
      <div class="pill-row">
        <button class="sm" id="sc-refresh">🔄 Refresh</button>
        ${edit ? '<button class="primary sm" id="sc-new-issue">⚡ New Stock Issue</button>' : ''}
      </div>
    </div>
    <div class="grid section" id="sc-kpis">
      <div class="card stat"><span class="n">…</span><span class="l">Live Stock Valuation</span></div>
      <div class="card stat"><span class="n">…</span><span class="l">Active SKUs</span></div>
      <div class="card stat"><span class="n">…</span><span class="l">Reorder Shortfalls</span></div>
      <div class="card stat"><span class="n">…</span><span class="l">Est. Restock Budget</span></div>
    </div>

    <!-- Section 1: Automated Reorder Alerts Board -->
    <div class="card section" style="border-top:3px solid var(--accent)">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <div>
          <h3 style="margin:0;display:flex;align-items:center;gap:8px">
            <span>🚨 Automated Reorder Shortfalls &amp; Replenishment Alerts</span>
            <span id="sc-alert-badge" class="badge red">0</span>
          </h3>
          <div class="muted" style="font-size:12px;margin-top:2px">
            Items currently at or below minimum reorder threshold. Select items to generate a 1-click Restock Material Request Note (MRN).
          </div>
        </div>
        <div class="pill-row" style="align-items:center">
          <button type="button" class="sm" id="sc-sel-all">Select All</button>
          <button type="button" class="sm" id="sc-sel-none">Clear</button>
          ${canRestock ? '<button type="button" class="primary sm" id="sc-gen-mrn" disabled>⚡ Generate Reorder MRN (<span id="sc-sel-n">0</span>)</button>' : ''}
        </div>
      </div>
      <div class="pill-row" style="margin-bottom:12px" id="sc-alert-filter-pills">
        <button type="button" class="sm primary" data-urgency="all">All Alerts (<span id="sc-cnt-all">0</span>)</button>
        <button type="button" class="sm" data-urgency="CRITICAL">🔴 Critical Only (<span id="sc-cnt-crit">0</span>)</button>
        <button type="button" class="sm" data-urgency="LOW">🟡 Low Stock (<span id="sc-cnt-low">0</span>)</button>
      </div>
      <div id="sc-alerts-table" class="muted">Loading reorder alerts…</div>
    </div>

    <!-- Section 2: Universal Live Inventory Search -->
    <div class="card section">
      <div style="margin-bottom:12px">
        <h3 style="margin:0 0 4px">🔍 Universal Live Inventory Search</h3>
        <div class="muted" style="font-size:12px">Instant multi-section lookup across General Stock, Lubricants, Filters, and Batteries.</div>
      </div>
      <div class="toolbar" style="flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <input type="search" id="sc-search-q" placeholder="Search code, part number, brand, name, category, or location…" style="flex:1;min-width:240px">
        <select id="sc-search-status" style="max-width:160px">
          <option value="all">All Stock Statuses</option>
          <option value="critical">🔴 Critical (0 Stock)</option>
          <option value="low">🟡 Low Stock</option>
          <option value="ok">🟢 Healthy Stock</option>
        </select>
        <span class="muted" id="sc-search-count" style="font-size:12px;margin-left:auto;align-self:center"></span>
      </div>
      <div class="pill-row" id="sc-section-pills" style="margin-bottom:12px">
        <button type="button" class="sm primary" data-section="all">All Sections</button>
        <button type="button" class="sm" data-section="general">🧰 General Stock</button>
        <button type="button" class="sm" data-section="oil">🛢️ Oil &amp; Lubricants</button>
        <button type="button" class="sm" data-section="filter">🛞 Filter Stock</button>
        <button type="button" class="sm" data-section="battery">🔋 Batteries</button>
      </div>
      <div id="sc-search-table" class="muted">Loading inventory…</div>
    </div>
  `;

  let overviewData = null;
  let allAlerts = [];
  let currentUrgencyFilter = 'all';
  const selectedAlertKeys = new Set();

  const updateSelectedCount = () => {
    const btn = qs('#sc-gen-mrn', c);
    const badge = qs('#sc-sel-n', c);
    if (badge) badge.textContent = selectedAlertKeys.size;
    if (btn) btn.disabled = selectedAlertKeys.size === 0;
  };

  const renderAlertsTable = () => {
    let rows = allAlerts;
    if (currentUrgencyFilter !== 'all') {
      rows = rows.filter((a) => a.urgency === currentUrgencyFilter);
    }
    const headers = [
      { label: '', width: '32px' },
      { label: 'Urgency', width: '80px' },
      { label: 'Section', width: '90px' },
      { label: 'Code / Part #', width: '110px' },
      { label: 'Item Name & Category', cls: 'desc-col' },
      { label: 'Stock', num: true, width: '70px' },
      { label: 'Reorder', num: true, width: '70px' },
      { label: 'Shortfall', num: true, width: '80px' },
      { label: 'Unit Cost', num: true, width: '95px' },
      { label: 'Est. Cost', num: true, width: '105px' },
      { label: 'Actions', width: '80px' }
    ];
    const secTag = {
      general: '<span class="badge">🧰 General</span>',
      oil: '<span class="badge blue">🛢️ Oil</span>',
      filter: '<span class="badge amber">🛞 Filter</span>'
    };
    const body = rows.map((a) => {
      const key = `${a.section}-${a.item_id}`;
      const checked = selectedAlertKeys.has(key) ? ' checked' : '';
      const urgBadge = a.urgency === 'CRITICAL'
        ? '<span class="badge red">CRITICAL</span>'
        : '<span class="badge amber">LOW</span>';
      return `<tr style="${a.urgency === 'CRITICAL' ? 'background:rgba(220,53,69,0.06)' : 'background:rgba(255,193,7,0.04)'}">
        <td style="text-align:center"><input type="checkbox" class="sc-chk" data-key="${esc(key)}" style="margin:0"${checked}></td>
        <td>${urgBadge}</td>
        <td>${secTag[a.section] || esc(a.section_label)}</td>
        <td><b>${esc(a.code)}</b></td>
        <td><b>${esc(a.name)}</b>${a.category ? `<br><span class="muted" style="font-size:11px">${esc(a.category)}</span>` : ''}</td>
        <td class="num"><b style="color:${a.current_stock <= 0 ? 'var(--danger,#c4392c)' : 'inherit'}">${num(a.current_stock)}</b> ${esc(a.unit)}</td>
        <td class="num">${num(a.reorder_level)}</td>
        <td class="num"><b style="color:var(--danger,#c4392c)">+${num(a.shortfall)}</b></td>
        <td class="num">${a.unit_cost > 0 ? money(a.unit_cost) : '<span class="muted">—</span>'}</td>
        <td class="num"><b>${a.estimated_cost > 0 ? money(a.estimated_cost) : '<span class="muted">—</span>'}</b></td>
        <td><button class="sm sc-alert-issue" data-sec="${esc(a.section)}" data-name="${esc(a.name)}" data-price="${a.unit_cost || 0}" data-unit="${esc(a.unit)}">⚡ Issue</button></td>
      </tr>`;
    });
    qs('#sc-alerts-table', c).innerHTML = tableWrap(headers, body, { scroll: true });

    // Wire alert checkboxes
    qsa('.sc-chk', qs('#sc-alerts-table', c)).forEach((chk) => {
      chk.onchange = () => {
        if (chk.checked) selectedAlertKeys.add(chk.dataset.key);
        else selectedAlertKeys.delete(chk.dataset.key);
        updateSelectedCount();
      };
    });

    // Wire alert Issue button
    qsa('.sc-alert-issue', qs('#sc-alerts-table', c)).forEach((btn) => {
      btn.onclick = () => {
        newIssueModal(loadOverview, {
          section: btn.dataset.sec,
          description: btn.dataset.name,
          unit_price: Number(btn.dataset.price) || undefined,
          unit: btn.dataset.unit || 'nos'
        });
      };
    });
  };

  const generateRestockMrn = () => {
    const chosenAlerts = allAlerts.filter((a) => selectedAlertKeys.has(`${a.section}-${a.item_id}`));
    if (!chosenAlerts.length) return toast('Select at least one item to reorder', 'err');

    const totalEst = chosenAlerts.reduce((sum, it) => sum + (it.estimated_cost || 0), 0);

    modal('⚡ Generate Restock Material Request Note (MRN)', `
      <p class="muted" style="margin-top:0">
        Review the <b>${chosenAlerts.length}</b> replenishment item(s) below. Quantities default to each item's shortfall below minimum reorder level.
      </p>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-bottom:12px">
        <table class="ni-tab" style="width:100%">
          <thead>
            <tr><th>Section</th><th>Item</th><th style="text-align:right">Stock</th><th style="text-align:right">Reorder</th><th style="text-align:right">Shortfall</th><th style="text-align:right">Est. Cost</th></tr>
          </thead>
          <tbody>
            ${chosenAlerts.map((it) => `<tr>
              <td><span class="badge" style="font-size:11px">${esc(it.section_label)}</span></td>
              <td><b>${esc(it.name)}</b> <span class="muted">(${esc(it.code)})</span></td>
              <td style="text-align:right">${num(it.current_stock)} ${esc(it.unit)}</td>
              <td style="text-align:right">${num(it.reorder_level)}</td>
              <td style="text-align:right"><b style="color:var(--danger,#c4392c)">${num(it.shortfall)}</b> ${esc(it.unit)}</td>
              <td style="text-align:right">${it.estimated_cost > 0 ? money(it.estimated_cost) : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="row">
        <div class="card stat" style="margin-bottom:12px">
          <span class="n">${money(totalEst)}</span>
          <span class="l">Estimated Restock Cost</span>
        </div>
      </div>
      ${field('Purchase Source', 'purchase_source', {
      type: 'select',
      options: [
        { value: 'Head Office', label: 'Head Office Purchase (Colombo)' },
        { value: 'Local Purchase', label: 'Local Purchase (Urgent)' }
      ],
      value: 'Head Office'
    })}
      ${field('Purpose / Remarks', 'purpose', {
      value: `Restock: Central Stock Cockpit (${chosenAlerts.length} items)`
    })}
      <div style="margin-top:14px;text-align:right;display:flex;justify-content:flex-end;gap:8px">
        <button type="button" class="sm" id="sc-mrn-cancel">Cancel</button>
        <button type="button" class="primary" id="sc-mrn-submit">⚡ Create Restock MRN</button>
      </div>`, (body, close) => {
      qs('#sc-mrn-cancel', body).onclick = close;
      qs('#sc-mrn-submit', body).onclick = async () => {
        const d = formData(body);
        const source = d.purchase_source || 'Head Office';
        const purpose = d.purpose || `Restock: Central Stock Cockpit (${chosenAlerts.length} items)`;
        const payload = {
          purpose,
          items: chosenAlerts.map((it) => ({
            item_id: it.item_id,
            section: it.section,
            name: it.name,
            code: it.code,
            category: it.category,
            unit: it.unit,
            qty: it.shortfall,
            purchase_source: source
          }))
        };
        try {
          const res = await api('/stock-cockpit/create-reorder-mrn', { method: 'POST', body: payload });
          toast(`Restock MRN #${res.mrn_no} generated with ${res.lines_count} items!`);
          close();
          selectedAlertKeys.clear();
          updateSelectedCount();
          await loadOverview();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
  };

  const loadOverview = async () => {
    try {
      overviewData = await api('/stock-cockpit/overview');
      allAlerts = overviewData.reorder_alerts || [];
      const k = overviewData;

      qs('#sc-kpis', c).innerHTML = `
        <div class="card stat">
          <span class="n">${money(k.total_valuation)}</span>
          <span class="l">Total Stock Valuation</span>
          <div class="muted" style="font-size:11px;margin-top:4px">
            🧰 Gen: ${moneyC(k.valuation_breakdown.general)} · 🛢️ Oil: ${moneyC(k.valuation_breakdown.oil)} · 🛞 Filters: ${moneyC(k.valuation_breakdown.filters)}
          </div>
        </div>
        <div class="card stat">
          <span class="n">${num(k.sku_counts.total)} SKUs</span>
          <span class="l">Active Stock Items</span>
          <div class="muted" style="font-size:11px;margin-top:4px">
            ${num(k.sku_counts.general)} Gen · ${num(k.sku_counts.filters)} Filters · ${num(k.sku_counts.oil)} Oil · ${num(k.sku_counts.in_store_batteries)} Bat
          </div>
        </div>
        <div class="card stat">
          <span class="n" style="color:${k.reorder_summary.critical_count > 0 ? 'var(--danger,#c4392c)' : 'inherit'}">${num(k.reorder_summary.total_alerts)} Items</span>
          <span class="l">Reorder Shortfalls</span>
          <div class="muted" style="font-size:11px;margin-top:4px">
            <span class="badge red">${num(k.reorder_summary.critical_count)} Critical (0 bal)</span> <span class="badge amber">${num(k.reorder_summary.low_count)} Low</span>
          </div>
        </div>
        <div class="card stat">
          <span class="n">${money(k.reorder_summary.total_estimated_cost)}</span>
          <span class="l">Est. Restock Budget</span>
          <div class="muted" style="font-size:11px;margin-top:4px">
            To replenish all ${num(k.reorder_summary.total_alerts)} items to reorder thresholds
          </div>
        </div>
      `;

      qs('#sc-alert-badge', c).textContent = num(k.reorder_summary.total_alerts);
      qs('#sc-alert-badge', c).className = 'badge ' + (k.reorder_summary.critical_count > 0 ? 'red' : 'amber');
      qs('#sc-cnt-all', c).textContent = num(k.reorder_summary.total_alerts);
      qs('#sc-cnt-crit', c).textContent = num(k.reorder_summary.critical_count);
      qs('#sc-cnt-low', c).textContent = num(k.reorder_summary.low_count);

      renderAlertsTable();
      updateSelectedCount();
    } catch (e) {
      qs('#sc-kpis', c).innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
      qs('#sc-alerts-table', c).innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
    }
  };

  let searchSection = 'all';
  let searchStatus = 'all';
  let searchDebounce;

  const loadSearch = async () => {
    const q = (qs('#sc-search-q', c) ? qs('#sc-search-q', c).value.trim() : '');
    const query = '?q=' + encodeURIComponent(q) + '&section=' + searchSection + '&status=' + searchStatus;
    try {
      const items = await api('/stock-cockpit/search' + query);
      qs('#sc-search-count', c).textContent = `${num(items.length)} item${items.length === 1 ? '' : 's'} found`;
      const headers = [
        { label: 'Section', width: '90px' },
        { label: 'Code / Part #', width: '110px' },
        { label: 'Item Name & Category', cls: 'desc-col' },
        { label: 'Rack / Location', width: '110px' },
        { label: 'Balance', num: true, width: '90px' },
        { label: 'Reorder', num: true, width: '70px' },
        { label: 'Unit Cost', num: true, width: '95px' },
        { label: 'Total Value', num: true, width: '105px' },
        { label: 'Status', width: '80px' },
        { label: 'Actions', width: '80px' }
      ];
      const secIcon = {
        general: '<span class="badge">🧰 General</span>',
        oil: '<span class="badge blue">🛢️ Oil</span>',
        filter: '<span class="badge amber">🛞 Filter</span>',
        battery: '<span class="badge">🔋 Battery</span>'
      };
      const statBadge = {
        critical: '<span class="badge red">CRITICAL</span>',
        low: '<span class="badge amber">LOW</span>',
        ok: '<span class="badge green">HEALTHY</span>'
      };
      const body = items.map((r) => `<tr>
        <td>${secIcon[r.section] || esc(r.section_label)}</td>
        <td><b>${esc(r.code)}</b></td>
        <td><b>${esc(r.name)}</b>${r.brand ? ` <span class="muted" style="font-size:11px">[${esc(r.brand)}]</span>` : ''}${r.category ? `<br><span class="muted" style="font-size:11px">${esc(r.category)}</span>` : ''}</td>
        <td>${esc(r.location || '—')}</td>
        <td class="num"><b style="color:${r.balance <= 0 ? 'var(--danger,#c4392c)' : 'inherit'}">${num(r.balance)}</b> ${esc(r.unit || '')}</td>
        <td class="num">${r.reorder_level > 0 ? num(r.reorder_level) : '<span class="muted">—</span>'}</td>
        <td class="num">${r.unit_cost > 0 ? money(r.unit_cost) : '<span class="muted">—</span>'}</td>
        <td class="num"><b>${r.total_value > 0 ? money(r.total_value) : '<span class="muted">—</span>'}</b></td>
        <td>${statBadge[r.status] || r.status}</td>
        <td><button class="sm sc-search-issue" data-sec="${esc(r.section)}" data-name="${esc(r.name)}" data-price="${r.unit_cost || 0}" data-unit="${esc(r.unit)}">⚡ Issue</button></td>
      </tr>`);

      qs('#sc-search-table', c).innerHTML = tableWrap(headers, body, { scroll: true });

      qsa('.sc-search-issue', qs('#sc-search-table', c)).forEach((btn) => {
        btn.onclick = () => {
          newIssueModal(loadOverview, {
            section: btn.dataset.sec,
            description: btn.dataset.name,
            unit_price: Number(btn.dataset.price) || undefined,
            unit: btn.dataset.unit || 'nos'
          });
        };
      });
    } catch (e) {
      qs('#sc-search-table', c).innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
    }
  };

  // Wire Top Actions
  qs('#sc-refresh', c).onclick = () => { loadOverview(); loadSearch(); };
  if (edit && qs('#sc-new-issue', c)) qs('#sc-new-issue', c).onclick = () => newIssueModal(loadOverview);

  // Wire Reorder Actions
  qs('#sc-sel-all', c).onclick = () => {
    let rows = allAlerts;
    if (currentUrgencyFilter !== 'all') rows = rows.filter((a) => a.urgency === currentUrgencyFilter);
    rows.forEach((a) => selectedAlertKeys.add(`${a.section}-${a.item_id}`));
    renderAlertsTable();
    updateSelectedCount();
  };
  qs('#sc-sel-none', c).onclick = () => {
    selectedAlertKeys.clear();
    renderAlertsTable();
    updateSelectedCount();
  };
  if (canRestock && qs('#sc-gen-mrn', c)) qs('#sc-gen-mrn', c).onclick = generateRestockMrn;

  // Wire Urgency Filter Pills
  qsa('#sc-alert-filter-pills button', c).forEach((btn) => {
    btn.onclick = () => {
      qsa('#sc-alert-filter-pills button', c).forEach((b) => b.classList.remove('primary'));
      btn.classList.add('primary');
      currentUrgencyFilter = btn.dataset.urgency;
      renderAlertsTable();
    };
  });

  // Wire Universal Search Controls
  qs('#sc-search-q', c).oninput = () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadSearch, 250);
  };
  qs('#sc-search-status', c).onchange = (e) => {
    searchStatus = e.target.value;
    loadSearch();
  };
  qsa('#sc-section-pills button', c).forEach((btn) => {
    btn.onclick = () => {
      qsa('#sc-section-pills button', c).forEach((b) => b.classList.remove('primary'));
      btn.classList.add('primary');
      searchSection = btn.dataset.section;
      loadSearch();
    };
  });

  await Promise.all([loadOverview(), loadSearch()]);
}

routes.stockcockpit = async () => {
  location.replace('#/stores?tab=stock');
};

// ===== General Stock — Master Consumables & Spare Parts Inventory =====
const gsStatus = (s) => (s === 'critical' ? '<span class="badge red">CRITICAL</span>' : s === 'low' ? '<span class="badge amber">LOW</span>' : '<span class="badge green">OK</span>');

async function renderGeneralStockSection(c) {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = ['stock', 'catalogue', 'categories', 'reorder'].includes(sp.get('sub') || sp.get('tab')) ? (sp.get('sub') || sp.get('tab')) : 'stock';
  const setTab = (t) => {
    if (location.hash.startsWith('#/stocktake') || location.hash.startsWith('#/stores')) location.hash = stockBooksHash('general', t);
    else location.hash = '#/generalstock?tab=' + t;
  };

  c.innerHTML = `
    <div class="pill-row" style="margin-bottom:12px">
      <button class="btn sm ${tab === 'stock' ? 'primary' : ''}" id="gs-tb-stock">📦 Live Balances</button>
      <button class="btn sm ${tab === 'catalogue' ? 'primary' : ''}" id="gs-tb-cat">📑 Catalogue &amp; Part Numbers</button>
      <button class="btn sm ${tab === 'categories' ? 'primary' : ''}" id="gs-tb-tree">🗂️ Categories</button>
      <button class="btn sm ${tab === 'reorder' ? 'primary' : ''}" id="gs-tb-reorder">⚠️ Re-Order Watch</button>
    </div>
    <div id="gspane"><div class="muted">Loading…</div></div>`;

  qs('#gs-tb-stock', c).onclick = () => setTab('stock');
  qs('#gs-tb-cat', c).onclick = () => setTab('catalogue');
  qs('#gs-tb-tree', c).onclick = () => setTab('categories');
  qs('#gs-tb-reorder', c).onclick = () => setTab('reorder');

  const pane = qs('#gspane', c);
  if (tab === 'catalogue') {
    await storeCatalogueTab(pane);
  } else if (tab === 'categories') {
    await categoriesTab(pane);
  } else if (tab === 'reorder') {
    const items = await api('/stores/reorder');
    pane.innerHTML = `<div class="card section">
      <h3 style="margin-top:0">Items at or below minimum stock level</h3>
      ${tableWrap([{ label: 'Item Name' }, { label: 'Balance', num: true }, { label: 'Min Stock', num: true }], items.map((i) => `<tr><td><b>${esc(i.name)}</b></td><td class="num"><span class="badge red">${num(i.balance)}</span></td><td class="num">${num(i.min_stock)}</td></tr>`))}
    </div>`;
  } else {
    await renderGeneralStockLive(pane);
  }
}

routes.generalstock = async () => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const sub = sp.get('tab') || 'stock';
  location.replace('#/stocktake?tab=general' + (sub !== 'stock' ? '&sub=' + sub : ''));
};

// The old Stock Take page is the Stores page's Stock tab now (stores plan, Part 2). Its links still
// open the same place: the kind of stock, and the older book of it when one was asked for.
routes.stocktake = async () => {
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const KIND = { general: 'general', oil: 'oil', filters: 'filter', batteries: 'battery' };
  const kind = KIND[sp.get('tab')];
  let sub = sp.get('sub');
  if (kind === 'battery') sub = 'register';
  if (kind === 'oil' && sub === 'stock') sub = null;
  location.replace('#/stores?tab=stock' + (kind ? '&kind=' + kind : '') + (kind && sub ? '&sub=' + encodeURIComponent(sub) : ''));
};

async function renderGeneralStockLive(c) {
  const edit = canEdit('stores');
  c.innerHTML = `
    <div class="card section"><h3 style="margin-top:0">Stock position <span class="muted" style="font-weight:400;font-size:12px">— requested, received, issued and what's left, from the shared stock ledger</span></h3>
      <div id="gs-stock"></div></div>
    <p class="muted" id="gs-whole" style="font-size:12px;margin:0 0 8px;display:none"></p>
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
  wholeCompanyNote(qs('#gs-whole', c));
  try { (await api('/general-stock/categories')).forEach((cat) => { const o = document.createElement('option'); o.value = cat; o.textContent = cat; qs('#gs-cat', c).appendChild(o); }); } catch (e) { /* dropdown optional */ }

  // The register carries ~700 zero-balance names left behind by the old warehouse import —
  // "(+) terminal", "(14mm) must Belt" — which alphabetically bury the items actually being
  // kept. "Live" means the item holds stock or sits on a real rack, i.e. it is on one of the
  // storekeeper's sheets. Everything is still one click away.
  const RACKS = ['1C', '1D', '2C', '2D', '5E', '6E', '10D', 'Car Wash'];
  const isLive = (r) => Number(r.balance) !== 0 || RACKS.includes(String(r.location || '').trim());
  let liveOnly = true, lowOnly = false, unpricedOnly = false, rows = [], suggMap = null;
  const load = async () => {
    const q = qs('#gs-q', c).value.trim(), cat = qs('#gs-cat', c).value;
    const query = '?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + (cat ? 'category=' + encodeURIComponent(cat) + '&' : '') + (lowOnly ? 'low_stock=1' : '');
    try {
      if (suggMap === null) { try { suggMap = await api('/general-stock/suggestions'); } catch (e) { suggMap = {}; } }
      const [s, items] = await Promise.all([api('/general-stock/summary'), api('/general-stock/items' + query)]);
      qs('#gs-stats', c).innerHTML = [
        [num(s.total_items), 'Total Items'], [moneyC(s.total_value), 'Total Value (LKR)'],
        [num(s.low_stock_count), 'Low Stock'], [num(s.categories), 'Categories'],
      ].map(([n, l]) => `<div class="card stat"><span class="n">${n}</span><span class="l">${esc(l)}</span></div>`).join('');
      rows = unpricedOnly ? items.filter((r) => !(Number(r.unit_cost) > 0)) : items;
      // Only while browsing. Someone who has typed a name is looking for that thing and
      // should find it, even if it is one of the old empty ones.
      const filtering = liveOnly && !q;
      const hidden = filtering ? rows.filter((r) => !isLive(r)).length : 0;
      if (filtering) rows = rows.filter(isLive);
      qs('#gs-count', c).textContent = rows.length + (rows.length === 1 ? ' item' : ' items')
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
      qs('#gs-table', c).innerHTML = tableWrap(headers, body, { scroll: true });
      qsa('[data-led]', c).forEach((b) => { b.onclick = () => gsLedger(b.dataset.led); });
      qsa('[data-adj]', c).forEach((b) => { b.onclick = () => gsAdjust(rows.find((x) => String(x.id) === b.dataset.adj)); });
      const savePrice = async (id, val) => {
        try {
          await api('/general-stock/items/' + id + '/price', { method: 'POST', body: { unit_cost: val === '' ? null : Number(val) } });
          const it = rows.find((x) => String(x.id) === String(id)); if (it) { it.unit_cost = val === '' ? 0 : Number(val); it.total_value = Math.round(it.balance * it.unit_cost * 100) / 100; }
          toast('Price saved');
        } catch (e) { toast(e.message, 'err'); }
      };
      qsa('.gs-price', qs('#gs-table', c)).forEach((inp) => { inp.onchange = () => savePrice(inp.dataset.id, inp.value); });
      qsa('.gs-use', qs('#gs-table', c)).forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); const inp = qs('.gs-price[data-id="' + a.dataset.id + '"]', qs('#gs-table', c)); if (inp) { inp.value = a.dataset.p; savePrice(a.dataset.id, a.dataset.p); a.remove(); } }; });
    } catch (e) { qs('#gs-table', c).innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
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
  qs('#gs-q', c).oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#gs-cat', c).onchange = load;
  qs('#gs-live', c).onclick = () => { liveOnly = !liveOnly; qs('#gs-live', c).classList.toggle('primary', liveOnly); load(); };
  qs('#gs-low', c).onclick = () => { lowOnly = !lowOnly; qs('#gs-low', c).classList.toggle('primary', lowOnly); load(); };
  if (edit && qs('#gs-add', c)) qs('#gs-add', c).onclick = gsAdd;
  load();
}

// ===== Filter Stock — native SPA view (was public/filter-stock.html) =====
// Dedicated filter inventory (filter_stock + filter_stock_ledger). Backed by /api/filter-stock.
const fsStatus = (s) => (s === 'critical' ? '<span class="badge red">CRITICAL</span>' : s === 'low' ? '<span class="badge amber">LOW</span>' : '<span class="badge green">OK</span>');
const fsPills = (v) => (v ? String(v).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => `<span class="badge" style="font-weight:400">${esc(x)}</span>`).join(' ') : '<span class="muted">—</span>');
// ---- Shared stock panel -----------------------------------------------------
// One component, mounted in Oil & Lube / Batteries / General Stock / Filter Stock.
// Every section answers the same four questions — on order, received, issued, balance —
// and each item opens its full movement trail: what went where, when and to which vehicle.
// Stage 4: under the stock panel, the older book of a section counts the whole company — every store
// together. Say so once there is more than one store.
async function wholeCompanyNote(el) {
  if (!el || !wsMulti()) return;
  const d = await workshopsData().catch(() => null);
  if (!d || !d.stores_multi) return;
  el.textContent = 'The list below is for the whole company (all stores together). For one store, use Stock position above. Counts are made there, store by store.';
  el.style.display = '';
}

// Stage 4: with more than one store, the panel is one store's shelf — or, for head office, all of
// them. The choice is kept while the page is open. Someone kept to their own store has no choice.
let STOCK_STORE = '';
async function stockPanel(host, section, opts = {}) {
  host.innerHTML = '<div class="muted">Loading stock…</div>';
  const storeQ = () => (STOCK_STORE ? '&store_id=' + encodeURIComponent(STOCK_STORE) : '');
  let data;
  try { data = await api(`/stores/stock/${section}?limit=400${storeQ()}`); }
  catch (e) { host.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const s = data.summary;
  const cut = s.opening && s.opening.mode === 'cutover' ? s.opening.cutover : null;
  const store = data.store;              // null = every store (or the only one)
  const multi = !!data.multi;
  const can = data.can || {};
  const countStore = store || data.home || null;   // with one store, a count goes in it

  host.innerHTML = `
    ${multi ? `<div class="toolbar" style="margin:0 0 8px">
      ${data.fixed ? `<span class="badge blue">${esc(store ? store.name : '')}</span><span class="muted" style="font-size:12px">your store</span>`
    : `<label class="muted" style="font-size:12px">Store</label><select id="sk-store" style="max-width:260px">
          <option value="all" ${store ? '' : 'selected'}>All stores</option>
          ${(data.stores || []).map((x) => `<option value="${x.id}" ${store && store.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`}
    </div>` : ''}
    <div class="grid section">
      <div class="card stat"><span class="n">${num(s.received)}</span><span class="l">Received in</span></div>
      <div class="card stat"><span class="n">${num(s.issued)}</span><span class="l">Issued out</span></div>
      <div class="card stat"><span class="n" style="color:${s.balance < 0 ? 'var(--danger,#c4392c)' : 'inherit'}">${num(s.balance)}</span><span class="l">Balance in stock</span></div>
      <div class="card stat"><span class="n">${num(s.items)}</span><span class="l">Items</span></div>
      <div class="card stat"><span class="n">${moneyC(s.value || 0)}</span><span class="l">Value</span>${s.unpriced ? `<span class="muted" style="font-size:11px">${num(s.unpriced)} item(s) without a price</span>` : ''}</div>
    </div>
    ${cut ? `<p class="muted" style="font-size:12px;margin:0 0 8px">Stock for this section counts from <b>${esc(cut)}</b> — earlier movements (${num(s.history_moves)}, ${num(s.history_issued)} issued) are kept as history below but don't affect the balance, because those purchases were never recorded in stores.</p>` : ''}
    ${multi && !store ? '<p class="muted" style="font-size:12px;margin:0 0 8px">All stores together. Stock sent from one store to another is not counted as received or issued here.</p>' : ''}
    <div class="toolbar">
      <input id="sk-q" type="search" placeholder="Search item…" style="max-width:260px">
      <button class="sm primary" id="sk-items">By item</button>
      <button class="sm" id="sk-moves">All movements</button>
      ${store ? '<button class="sm" id="sk-low" title="At or under the reorder level">Low only</button>' : ''}
      <div class="spacer"></div><span class="muted" id="sk-count"></span>
    </div>
    <div id="sk-body"><div class="muted">Loading…</div></div>`;

  let mode = 'items';
  let lowOnly = false;
  const bodyEl = qs('#sk-body', host);
  if (qs('#sk-store', host)) qs('#sk-store', host).onchange = (e) => { STOCK_STORE = e.target.value === 'all' ? 'all' : e.target.value; stockPanel(host, section, opts); };

  const showMoves = (rows, title) => {
    qs('#sk-count', host).textContent = `${rows.length} movement(s)`;
    bodyEl.innerHTML = (title ? `<h3 style="margin:0 0 6px">${esc(title)}</h3>` : '')
      + (rows.length ? tableWrap(
        [{ label: 'Date' }, { label: 'In / Out' }, { label: 'Item', cls: 'desc-col' }, { label: 'Qty', num: true }]
          .concat(multi ? [{ label: 'Store' }] : [])
          .concat([{ label: 'Vehicle' }, { label: 'Job / Ref' }, { label: 'Counts?' }]),
        rows.map((m) => `<tr>
          <td>${esc(m.txn_date || '—')}</td>
          <td>${m.kind === 'out' ? '<span class="badge amber">issued</span>' : `<span class="badge green">${esc(m.kind)}</span>`}</td>
          <td class="desc-col">${esc(m.item_name || '')}${m.source_table === 'mtn_lines' ? ` <span class="muted" style="font-size:12px">(${esc(m.note || 'transfer')})</span>` : ''}</td>
          <td class="num">${num(m.qty)}</td>
          ${multi ? `<td>${esc(m.store_code || '')}</td>` : ''}
          <td>${m.asset_reg || m.asset_code ? `<span class="stamp">${esc(m.asset_reg || m.asset_code)}</span>` : '—'}</td>
          <td>${esc(m.job_no || m.ref || '')}</td>
          <td>${m.counts ? '<span class="badge green">yes</span>' : `<span class="badge" title="${esc(m.note || 'before the stock cut-over')}">history</span>`}</td></tr>`),
        { scroll: true, fit: true, noHScroll: true })
        : '<div class="card"><p class="muted">No movements.</p></div>');
  };

  // A quick count of one item in this store (stores plan, Part 2): head office approves the correction.
  const countItem = (key, name, balance) => modal(`Count ${name}`, `
    <p class="muted" style="margin:0 0 8px">${esc(countStore.name)} · the book says <b>${num(balance)}</b>. Head office approves the change.</p>
    ${section === 'oil' ? lubeCountFields() : field('Counted on the shelf', 'counted', { type: 'number', value: '' })}
    ${field('Date', 'count_date', { type: 'date', value: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) })}
    ${field('Note (optional)', 'note')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save count</button></div>`, (b, close) => {
    wireLubeCount(b);
    qs('#s', b).onclick = async () => {
      try {
        const r = await api(`/stores/stock/${section}/count`, { method: 'POST', body: { ...formData(b), store_id: countStore.id, item_key: key } });
        close();
        if (r.status !== 'approved') toast(`Counted ${num(r.counted)} · sent to head office (${r.count_no})`);
        else toast(r.delta ? `Counted ${num(r.counted)} · corrected by ${r.delta > 0 ? '+' : ''}${num(r.delta)}` : 'Counted · the book was right');
        load();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  const setLevel = (key, name, level) => modal(`Reorder level · ${name}`, `
    <p class="muted" style="margin:0 0 8px">${esc(store.name)}. Leave empty for no level.</p>
    ${field('Reorder at', 'level', { type: 'number', value: level == null ? '' : level })}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      try { await api(`/stores/stock/${section}/level`, { method: 'PUT', body: { ...formData(b), store_id: store.id, item_key: key } }); close(); toast('Saved'); load(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });

  const load = async () => {
    const q = qs('#sk-q', host).value.trim();
    qs('#sk-items', host).classList.toggle('primary', mode === 'items');
    qs('#sk-moves', host).classList.toggle('primary', mode === 'moves');
    if (qs('#sk-low', host)) qs('#sk-low', host).classList.toggle('primary', lowOnly);
    bodyEl.innerHTML = '<div class="muted">Loading…</div>';
    if (mode === 'moves') {
      showMoves(await api(`/stores/stock/${section}/moves?limit=400${storeQ()}${q ? '&q=' + encodeURIComponent(q) : ''}`));
      return;
    }
    const d = await api(`/stores/stock/${section}?limit=400${storeQ()}${lowOnly ? '&low=1' : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    qs('#sk-count', host).textContent = `${d.items.length} item(s)`;
    const byStore = (i) => (i.by_store || []).map((b) => `${esc(b.store_code || '?')} ${num(b.balance)}`).join(' · ');
    bodyEl.innerHTML = d.items.length ? tableWrap(
      [{ label: 'Item', cls: 'desc-col' }, { label: 'Received', num: true }, { label: 'Issued', num: true },
      { label: 'Balance', num: true }, { label: 'Value', num: true }]
        .concat(multi && !store ? [{ label: 'By store' }] : [])
        .concat(store ? [{ label: 'Reorder at', num: true }] : [])
        .concat([{ label: 'Issued (all time)', num: true }, { label: 'Last movement' }, { label: 'Last count' }, { label: '' }]),
      d.items.map((i) => {
        const low = store && i.reorder_level > 0 && i.balance <= i.reorder_level;
        return `<tr>
        <td class="desc-col">${esc(i.item_name || i.item_key)}</td>
        <td class="num">${num(i.received)}</td>
        <td class="num">${num(i.issued)}</td>
        <td class="num"><b style="color:${i.balance < 0 ? 'var(--danger,#c4392c)' : 'inherit'}">${num(i.balance)}</b>${low ? ' <span class="badge amber">low</span>' : ''}</td>
        <td class="num">${i.unit_price == null ? (i.balance > 0 ? '<span class="muted" title="No price yet">—</span>' : '') : money(i.value)}</td>
        ${multi && !store ? `<td class="muted" style="font-size:12px">${byStore(i)}</td>` : ''}
        ${store ? `<td class="num">${i.reorder_level ? num(i.reorder_level) : '<span class="muted">—</span>'}${can.levels ? ` <button class="sm" data-lvl="${esc(i.item_key)}" data-name="${esc(i.item_name || i.item_key)}" data-v="${i.reorder_level == null ? '' : i.reorder_level}" title="Set the reorder level">✎</button>` : ''}</td>` : ''}
        <td class="num muted">${num(i.issued_all_time)}</td>
        <td>${esc(i.last_move || '—')}</td>
        <td>${esc(i.last_count || '—')}</td>
        <td style="white-space:nowrap">${can.count ? `<button class="sm" data-cnt="${esc(i.item_key)}" data-name="${esc(i.item_name || i.item_key)}" data-bal="${i.balance}">Count</button> ` : ''}<button class="sm" data-hist="${esc(i.item_key)}" data-name="${esc(i.item_name || i.item_key)}">history →</button></td></tr>`;
      }),
      { scroll: true, fit: true, noHScroll: true })
      : `<div class="card"><p class="muted">${lowOnly ? 'Nothing is at or under its reorder level.' : 'Nothing recorded for this section yet.'}</p></div>`;
    // Drill into one item: every movement, which vehicle, when, how much.
    qsa('[data-hist]', bodyEl).forEach((b) => b.onclick = async () => {
      bodyEl.innerHTML = '<div class="muted">Loading history…</div>';
      const rows = await api(`/stores/stock/${section}/moves?item_key=${encodeURIComponent(b.dataset.hist)}&limit=400${storeQ()}`);
      showMoves(rows, b.dataset.name);
      bodyEl.insertAdjacentHTML('afterbegin', '<button class="sm" id="sk-back" style="margin-bottom:8px">← back to items</button>');
      qs('#sk-back', bodyEl).onclick = load;
    });
    qsa('[data-cnt]', bodyEl).forEach((b) => { b.onclick = () => countItem(b.dataset.cnt, b.dataset.name, Number(b.dataset.bal)); });
    qsa('[data-lvl]', bodyEl).forEach((b) => { b.onclick = () => setLevel(b.dataset.lvl, b.dataset.name, b.dataset.v === '' ? null : Number(b.dataset.v)); });
  };
  qs('#sk-items', host).onclick = () => { mode = 'items'; load(); };
  qs('#sk-moves', host).onclick = () => { mode = 'moves'; load(); };
  if (qs('#sk-low', host)) qs('#sk-low', host).onclick = () => { lowOnly = !lowOnly; mode = 'items'; load(); };
  let skdeb; qs('#sk-q', host).oninput = () => { clearTimeout(skdeb); skdeb = setTimeout(load, 250); };
  await load();
}

// ---- Stores: the Stock view and the stock take (stores plan, Part 2) --------------------------
// Every kind of stock in one view — Parts & general, Lubricants, Filters, Tyres, Batteries — each
// with its value, reorder level, last count and history (the shared stock panel above). Each kind
// keeps its older book (catalogue, oil book, filter price book, battery register) one click away.
const STOCK_KINDS = [['overview', '📊 Overview'], ['general', '🔩 Parts & general'], ['oil', '🛢️ Lubricants'],
  ['filter', '🧰 Filters'], ['tyre', '🛞 Tyres'], ['battery', '🔋 Batteries']];
const KIND_LABEL = { all: 'All kinds', general: 'Parts & general', oil: 'Lubricants', filter: 'Filters', tyre: 'Tyres', battery: 'Batteries' };
const STOCK_BOOKS = {
  general: [['stock', 'Rack register'], ['catalogue', 'Catalogue'], ['categories', 'Categories'], ['reorder', 'Re-order watch']],
  oil: [['products', 'Products'], ['names', 'Names'], ['ledger', 'Oil book'], ['forecast', 'Forecast'], ['counts', 'Old counts']],
  filter: [['book', 'Price book'], ['xref', 'Cross-references']],
  tyre: [['tyres', 'Tyre register'], ['vehicle', 'By vehicle']],
  battery: [['register', 'Battery register'], ['vehicle', 'By vehicle']],
};
const stockBooksHash = (kind, sub) => `#/stores?tab=stock&kind=${kind}&sub=${encodeURIComponent(sub)}`;

// Lubricants are counted in litres: full drums or cans × their size, plus the part-used one by dip.
const lubeCountFields = (v = {}) => `
  <div class="row">${field('Full drums / cans', 'containers', { type: 'number', value: v.containers ?? '' })}${field('Size of one (L)', 'container_size', { type: 'number', value: v.container_size ?? '', placeholder: 'e.g. 210' })}</div>
  ${field('Part-used drum (L, dip reading)', 'loose_qty', { type: 'number', value: v.loose_qty ?? '' })}
  <p class="muted" style="margin:4px 0 0" data-lube-total></p>`;
function wireLubeCount(root) {
  const out = qs('[data-lube-total]', root);
  if (!out) return;
  const show = () => {
    const d = formData(root);
    const total = (Number(d.containers) || 0) * (Number(d.container_size) || 0) + (Number(d.loose_qty) || 0);
    out.textContent = d.containers || d.loose_qty ? `Total: ${num(total)} L` : '';
  };
  qsa('input', root).forEach((i) => { i.addEventListener('input', show); });
  show();
}

async function storesStock(body, sp) {
  const kind = STOCK_KINDS.some(([k]) => k === sp.get('kind')) ? sp.get('kind') : 'overview';
  const sub = sp.get('sub');
  const books = STOCK_BOOKS[kind] || [];
  body.innerHTML = `<div class="toolbar" style="margin:0 0 10px">${STOCK_KINDS
    .map(([k, l]) => `<button class="sm ${k === kind ? 'primary' : ''}" data-kind="${k}">${l}</button>`).join('')}</div><div id="stk-main"></div>`;
  qsa('[data-kind]', body).forEach((b) => { b.onclick = () => { location.hash = '#/stores?tab=stock' + (b.dataset.kind === 'overview' ? '' : '&kind=' + b.dataset.kind); }; });
  const host = qs('#stk-main', body);
  if (kind === 'overview') return stockOverview(host);
  if (sub && books.some(([k]) => k === sub)) {
    host.innerHTML = `<div class="toolbar" style="margin:0 0 8px"><a class="btn sm" href="#/stores?tab=stock&kind=${kind}">← ${esc(KIND_LABEL[kind])}: stock</a></div><div id="stk-book"></div>`;
    const bk = qs('#stk-book', host);
    if (kind === 'general') return renderGeneralStockSection(bk);
    if (kind === 'oil') return renderOilSection(bk);
    if (kind === 'filter') return renderFiltersSection(bk);
    if (sub === 'vehicle') return unitVehicleView(bk, sp);
    if (kind === 'tyre') return sp.get('id') ? tyreDetail(bk, sp.get('id')) : tyreRegister(bk, sp);
    return renderBatteriesSection(bk);
  }
  const links = books.map(([k, l]) => `<a class="btn sm" href="${stockBooksHash(kind, k)}">${esc(l)}</a>`)
    .concat(kind === 'tyre' && canView('tyrebattery') ? ['<a class="btn sm" href="#/tyrebattery">Tyre &amp; battery ledger</a>'] : []);
  host.innerHTML = `${links.length ? `<div class="toolbar" style="margin:0 0 8px"><span class="muted" style="font-size:12px">📚 Books</span>${links.join('')}</div>` : ''}<div id="stk-panel"></div>`;
  return stockPanel(qs('#stk-panel', host), kind);
}

// The front page: every kind of stock in one store (or all) — value, what is low, and when the store
// last counted it in full; then the reorder and restock list.
async function stockOverview(host) {
  let d;
  try { d = await api('/stores/stock/overview' + (STOCK_STORE ? '?store_id=' + encodeURIComponent(STOCK_STORE) : '')); }
  catch (e) { host.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const store = d.store;
  const total = d.kinds.reduce((t, k) => t + (k.value || 0), 0);
  const waiting = d.counts.counting + d.counts.submitted;
  host.innerHTML = `
    ${d.multi ? `<div class="toolbar" style="margin:0 0 8px">
      ${d.fixed ? `<span class="badge blue">${esc(store ? store.name : '')}</span><span class="muted" style="font-size:12px">your store</span>`
    : `<label class="muted" style="font-size:12px">Store</label><select id="ov-store" style="max-width:260px">
          <option value="all" ${store ? '' : 'selected'}>All stores</option>
          ${(d.stores || []).map((x) => `<option value="${x.id}" ${store && store.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`}
    </div>` : ''}
    <p class="muted" style="margin:0 0 8px">All stock: <b>${money(total)}</b>${waiting ? ` · <a href="#/stores?tab=counts&status=open">${d.counts.counting} stock take(s) being counted, ${d.counts.submitted} waiting for head office</a>` : ''}</p>
    <div class="grid section">${STOCK_KINDS.map(([s]) => d.kinds.find((k) => k.section === s)).filter(Boolean).map((k) => `<a class="card stat" href="#/stores?tab=stock&kind=${k.section}" style="text-decoration:none">
        <span class="l" style="font-weight:600;color:inherit">${esc(KIND_LABEL[k.section])}</span>
        <span class="n">${moneyC(k.value)}</span>
        <span class="l">${num(k.items)} items${k.low ? ` · <span class="badge red">${num(k.low)} low</span>` : ''}</span>
        ${store || !d.multi ? `<span class="muted" style="font-size:11px">${!k.full_count ? 'No full count yet'
    : '✔ Must be in stock since ' + esc(k.full_count)}</span>` : ''}</a>`).join('')}</div>
    <p class="muted" style="font-size:12px;margin:0 0 8px">Nothing is issued unless it is in stock. This starts for each kind after the store's first full stock take.</p>
    <h3 style="margin:14px 0 6px">Reorder &amp; restock</h3>
    <div id="ov-cockpit"></div>`;
  if (qs('#ov-store', host)) qs('#ov-store', host).onchange = (e) => { STOCK_STORE = e.target.value; stockOverview(host); };
  renderStockCockpitSection(qs('#ov-cockpit', host));
}

// ---- tyres and batteries by serial number (stores plan, Part 4) ------------------------------
// src/lib/tb_units.js: every tyre is known by its serial, like the batteries; issuing one fixes it
// to the vehicle, and what came off moves on in the register.
const TYRE_STATE = { in_store: ['', 'In store'], installed: ['green', 'On vehicle'], removed: ['amber', 'Taken off'], repair: ['blue', 'At repair'],
  retread: ['blue', 'At retread'], warranty: ['blue', 'Warranty claim'], scrap: ['red', 'Scrap'], lost: ['red', 'Lost'], disposed: ['', 'Disposed'] };
const tyreBadge = (st) => `<span class="badge ${(TYRE_STATE[st] || [''])[0]}">${esc((TYRE_STATE[st] || [0, st])[1])}</span>`;
const UNIT_EVENT = { add: 'Added', install: 'Fitted', remove: 'Taken off', return: 'Back to store', repair: 'Sent for repair', retread: 'Sent for retread',
  lost: 'Lost', dispose: 'Disposed', transfer: 'Moved', decommission: 'Finished', ...TB_COND_LABEL };
const tyreHash = (id) => stockBooksHash('tyre', 'tyres') + '&id=' + id;

async function tyreRegister(host, sp) {
  const cur = { q: sp.get('q') || '', state: sp.get('state') || '' };
  host.innerHTML = `<div class="toolbar">
      <input id="ty-q" type="search" placeholder="Serial, size or vehicle…" value="${esc(cur.q)}" style="max-width:240px">
      <select id="ty-st" style="max-width:170px"><option value="">Every state</option>${Object.entries(TYRE_STATE).map(([k, [, l]]) => `<option value="${k}"${k === cur.state ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <div class="spacer"></div><span class="muted" id="ty-n"></span></div>
    <div id="ty-list" class="muted">Loading…</div>`;
  const load = async () => {
    const q = qs('#ty-q', host).value.trim(), st = qs('#ty-st', host).value;
    const rows = await api('/tb/tyres?limit=1000' + (q ? '&q=' + encodeURIComponent(q) : '') + (st ? '&state=' + st : ''));
    qs('#ty-n', host).textContent = `${rows.length} tyre${rows.length === 1 ? '' : 's'}`;
    qs('#ty-list', host).innerHTML = rows.length ? tableWrap([{ label: 'Serial' }, { label: 'Size' }, { label: 'State' }, { label: 'Vehicle' }, { label: 'Wheel' }],
      rows.map((t) => `<tr><td>${t.photo_count ? '📷 ' : ''}<a href="${tyreHash(t.id)}"><b>${esc(t.serial_no)}</b></a></td><td>${esc(t.spec || '—')}</td>
        <td>${tyreBadge(t.state)}</td><td>${t.current_asset_id ? `<a href="${stockBooksHash('tyre', 'vehicle')}&asset=${t.current_asset_id}">${esc(t.asset_code || '')}</a>` : '—'}</td><td>${esc(t.position || '—')}</td></tr>`), { scroll: true })
      : '<div class="card"><p class="muted">No tyres yet. A tyre is added here when it is issued with its serial number.</p></div>';
  };
  let deb;
  qs('#ty-q', host).oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#ty-st', host).onchange = load;
  load();
}

async function tyreDetail(host, id) {
  let d;
  try { d = await api('/tb/tyres/' + encodeURIComponent(id)); } catch (e) { host.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const t = d.tyre;
  const editable = canEdit('tb_issue');
  const reload = () => tyreDetail(host, id);
  const room = d.max_photos - d.photos.length;
  host.innerHTML = `
    <div class="toolbar" style="margin:0 0 8px"><a class="btn sm" href="${stockBooksHash('tyre', 'tyres')}">← Tyre register</a></div>
    <div class="toolbar"><h3 style="margin:0">🛞 ${esc(t.serial_no)}</h3>${tyreBadge(t.state)}
      <span class="muted">${esc(t.spec || '')}${t.asset_code ? ` · on <a href="${stockBooksHash('tyre', 'vehicle')}&asset=${t.current_asset_id}">${esc(t.asset_code)}</a> at ${esc(t.position || '?')}` : ''}</span>
      <div class="spacer"></div>${editable ? `${room > 0 ? '<button class="sm" id="ty-photo">📷 Add photos</button>' : ''}${TYRE_ACTIONS(t).length ? '<button class="sm primary" id="ty-ev">What happened…</button>' : ''}` : ''}</div>
    <div class="card section"><h3 style="margin-top:0">Photos <span class="muted" style="font-weight:400;font-size:12px">— ${d.photos.length} of ${d.max_photos}</span></h3>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${d.photos.length ? d.photos.map((p) => `<div style="position:relative">
          <a href="${p.photo}" target="_blank"><img src="${p.photo}" alt="Tyre ${esc(t.serial_no)}" style="height:110px;width:110px;object-fit:cover;border:1px solid var(--border);border-radius:8px"></a>
          ${editable ? `<button class="btn sm danger" data-delphoto="${p.id}" title="Remove" style="position:absolute;top:-6px;right:-6px;padding:0 6px;line-height:18px">✕</button>` : ''}</div>`).join('')
    : '<p class="muted" style="margin:0">No photos yet.</p>'}</div></div>
    <div class="card"><h3 style="margin-top:0">History</h3>
      ${tableWrap([{ label: 'Date' }, { label: 'What' }, { label: 'From' }, { label: 'To' }, { label: 'Wheel' }, { label: 'Km' }, { label: 'Note' }, { label: 'By' }],
      d.events.map((e) => `<tr><td>${esc(e.event_date || '')}</td><td><span class="badge">${esc(UNIT_EVENT[e.event_type] || e.event_type)}</span></td>
        <td>${esc(e.from_asset_code || '')}</td><td>${esc(e.to_asset_code || '')}</td><td>${esc(e.position || '')}</td><td>${e.km_reading == null ? '' : num(e.km_reading)}</td>
        <td>${esc(e.reason || '')}</td><td>${esc(e.username || '')}</td></tr>`), { scroll: true })}</div>`;
  if (qs('#ty-photo', host)) qs('#ty-photo', host).onclick = () => modal('Add photos — ' + t.serial_no, `
      <label>Tyre photos <span class="muted" style="font-weight:400">— ${room} more can be added</span></label>${multiImageHtml('tyimg', room)}
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save photos</button></div>`, (b, close) => {
    const up = wireMultiImage(b, 'tyimg');
    qs('#s', b).onclick = async () => {
      const shots = up.dataURLs();
      if (!shots.length) return toast('Choose at least one photo', 'err');
      try { await api(`/tb/tyres/${t.id}/photos`, { method: 'POST', body: { photos: shots } }); toast('Photos added'); close(); reload(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
  qsa('[data-delphoto]', host).forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this photo?')) return;
      try { await api(`/tb/tyres/${t.id}/photos/${b.dataset.delphoto}`, { method: 'DELETE' }); reload(); } catch (e) { toast(e.message, 'err'); }
    };
  });
  if (qs('#ty-ev', host)) qs('#ty-ev', host).onclick = () => tyreEventModal(t, reload);
}

// What can happen to a tyre next, by where it is now.
const TYRE_ACTIONS = (t) => {
  if (['scrap', 'lost', 'disposed'].includes(t.state)) return [];
  if (t.state === 'installed') return [['remove', 'Take off'], ['repair', 'Send for repair'], ['retread', 'Send for retread'], ['warranty', 'Warranty claim'], ['scrap', 'Scrap']];
  if (['in_store', 'removed'].includes(t.state)) return [['install', 'Fit to a vehicle'], ...(t.state === 'removed' ? [['return', 'Back to store']] : []), ['repair', 'Send for repair'], ['retread', 'Send for retread'], ['warranty', 'Warranty claim'], ['scrap', 'Scrap']];
  return [['return', 'Back to store'], ['scrap', 'Scrap']];
};
function tyreEventModal(t, done) {
  const acts = TYRE_ACTIONS(t);
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  modal('Tyre ' + t.serial_no, `
    ${field('What happened', 'event_type', { type: 'select', options: acts.map(([value, label]) => ({ value, label })) })}
    <div id="ty-fit" style="display:none"><div class="fld">${assetPickerHtml('Vehicle *')}</div>
      ${field('Wheel *', 'position', { type: 'select', options: [{ value: '', label: '—' }].concat(TB_POS.map((p) => ({ value: p, label: p }))) })}</div>
    <div class="row">${field('Date', 'event_date', { type: 'date', value: today })}${field('Note', 'reason')}</div>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save</button></div>`, (b, close) => {
    wireAssetPicker(b);
    const sel = qs('[name=event_type]', b);
    const show = () => { qs('#ty-fit', b).style.display = sel.value === 'install' ? '' : 'none'; };
    sel.onchange = show; show();
    qs('#s', b).onclick = async () => {
      const f = formData(b);
      if (f.event_type === 'install' && (!f.asset_id || !f.position)) return toast('Pick the vehicle and the wheel', 'err');
      try {
        await api(`/tb/tyres/${t.id}/event`, { method: 'POST', body: { event_type: f.event_type, to_asset_id: f.asset_id, position: f.position, event_date: f.event_date, reason: f.reason } });
        toast('Saved'); close(); done && done();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// One vehicle's tyres (by wheel) and batteries now, and every one issued to it.
const unitLine = (head, u) => `<div style="padding:5px 0;border-bottom:1px solid var(--border)">${head}
  <div class="muted" style="font-size:11.5px">${esc([u.spec, u.fitted_on ? 'fitted ' + u.fitted_on : ''].filter(Boolean).join(' · ') || '—')}</div></div>`;
async function unitVehicleView(host, sp) {
  const kind = sp.get('kind') === 'battery' ? 'battery' : 'tyre';
  const assetId = sp.get('asset');
  host.innerHTML = `<div class="toolbar" style="max-width:420px"><div class="fld" style="flex:1">${assetPickerHtml('Vehicle')}</div></div><div id="uv-body"></div>`;
  wireAssetPicker(host, (id) => { location.hash = stockBooksHash(kind, 'vehicle') + '&asset=' + id; });
  const out = qs('#uv-body', host);
  if (!assetId) { out.innerHTML = '<p class="muted">Pick a vehicle to see its tyres and batteries.</p>'; return; }
  let v;
  try { v = await api('/tb/vehicle/' + encodeURIComponent(assetId)); } catch (e) { out.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  qs('.apick-input', host).value = v.asset.code || '';
  const mayRecord = canEdit('tb_issue');
  out.innerHTML = `
    <h3 style="margin:8px 0 6px">${esc(idLabel(v.asset))}${v.old_due ? ` <span class="badge amber">${v.old_due} old unit${v.old_due === 1 ? '' : 's'} to record</span>` : ''}</h3>
    <div class="grid section">
      <div class="card"><h3 style="margin-top:0">🛞 Tyres now (${v.tyres.length})</h3>
        ${v.tyres.length ? v.tyres.map((t) => unitLine(`<b>${esc(t.position || '?')}</b> · <a href="${tyreHash(t.id)}">${esc(t.serial_no)}</a>`, t)).join('')
    : '<p class="muted" style="margin:0">None recorded.</p>'}</div>
      <div class="card"><h3 style="margin-top:0">🔋 Batteries now (${v.batteries.length} of 2)</h3>
        ${v.batteries.length ? v.batteries.map((b) => unitLine(`<a href="#/batteries/${b.id}">${esc(b.serial_no)}</a>`, b)).join('')
    : '<p class="muted" style="margin:0">None recorded.</p>'}</div>
    </div>
    <div class="card"><h3 style="margin-top:0">Issued to this vehicle</h3>
      ${v.issues.length ? tableWrap([{ label: 'Date' }, { label: 'Request' }, { label: 'Item' }, { label: 'Serial' }, { label: 'Wheel' }, { label: 'What came off' }],
      v.issues.map((i) => `<tr><td>${esc(String(i.issue_date || '').slice(0, 10))}</td><td>${esc(i.mrn_no || '—')}</td><td>${esc(i.spec_label || i.kind)}</td>
        <td>${esc(i.serial_no || '—')}</td><td>${esc(i.position || '—')}</td>
        <td>${i.old_due ? `<span class="badge amber">Not recorded</span>${mayRecord ? ` <button class="sm" data-ret="${i.id}">Record…</button>` : ''}`
    : i.old_condition ? esc(TB_COND_LABEL[i.old_condition] || i.old_condition) + (i.old_serial ? ' · ' + esc(i.old_serial) : '') : '—'}</td></tr>`), { scroll: true })
    : '<p class="muted" style="margin:0">Nothing issued yet.</p>'}</div>`;
  qsa('[data-ret]', out).forEach((b) => {
    const i = v.issues.find((x) => String(x.id) === b.dataset.ret);
    b.onclick = () => tbReturnModal({ issue_id: i.id, kind: i.kind, asset_code: v.asset.code, spec_label: i.spec_label, issue_date: i.issue_date, mrn_no: i.mrn_no },
      () => unitVehicleView(host, sp));
  });
}

// ---- disposal notes (stores plan, Part 4) ------------------------------------------------------
// src/lib/disposal.js: scrap tyres, batteries, parts and waste oil leave on a note; a manager
// approves it with the buyer, the amount and the date (ST-D9).
const DISPOSAL_STATUS = { open: ['amber', 'Waiting for approval'], approved: ['green', 'Approved'], cancelled: ['', 'Cancelled'] };
const disposalBadge = (st) => `<span class="badge ${(DISPOSAL_STATUS[st] || [''])[0]}">${esc((DISPOSAL_STATUS[st] || [0, st])[1])}</span>`;
const DISPOSAL_KIND = { tyre: '🛞 Tyre', battery: '🔋 Battery', part: '🔩 Part', waste_oil: '🛢️ Waste oil' };

async function disposalList(body, sp) {
  const FILTERS = [['open', 'Waiting'], ['approved', 'Approved'], ['cancelled', 'Cancelled'], ['all', 'All']];
  const status = FILTERS.some(([k]) => k === sp.get('status')) ? sp.get('status') : 'open';
  const [rows, wd] = await Promise.all([api('/stores/disposals' + (status === 'all' ? '' : '?status=' + status)), workshopsData().catch(() => null)]);
  const multi = !!(wd && wd.stores_multi);
  body.innerHTML = `
    <div class="toolbar">
      ${FILTERS.map(([k, l]) => `<button class="sm ${k === status ? 'primary' : ''}" data-st="${k}">${l}</button>`).join('')}
      <div class="spacer"></div>
      ${canDo('stores.disposal.edit') ? '<button class="primary sm" id="dn-new">+ New disposal note</button>' : ''}
    </div>
    <p class="muted" style="margin:0 0 8px">Scrap tyres, batteries, parts and waste oil leave on a note. A manager approves it with the buyer, the amount and the date.</p>
    ${rows.length ? tableWrap([{ label: 'No' }].concat(multi ? [{ label: 'Store' }] : []).concat([{ label: 'Status' }, { label: 'Items', num: true },
      { label: 'Waste oil (L)', num: true }, { label: 'Buyer' }, { label: 'Amount', num: true }, { label: 'Date' }, { label: 'Written by' }]),
    rows.map((r) => `<tr><td><a href="#/stores?tab=disposal&id=${r.id}"><b>${esc(r.disposal_no)}</b></a></td>${multi ? `<td>${esc(r.store_name || '')}</td>` : ''}
      <td>${disposalBadge(r.status)}</td><td class="num">${r.lines}</td><td class="num">${r.waste_oil_litres ? num(r.waste_oil_litres) : ''}</td>
      <td>${esc(r.buyer || '—')}</td><td class="num">${r.amount == null ? '—' : money(r.amount)}</td>
      <td>${esc(r.sale_date || String(r.created_at || '').slice(0, 10))}</td><td>${esc(r.created_by_name || '')}</td></tr>`), { scroll: true })
    : '<div class="card"><p class="muted">No notes here.</p></div>'}`;
  qsa('[data-st]', body).forEach((b) => { b.onclick = () => { location.hash = '#/stores?tab=disposal&status=' + b.dataset.st; }; });
  if (qs('#dn-new', body)) qs('#dn-new', body).onclick = () => disposalNewModal(multi, wd);
}

function disposalNewModal(multi, wd) {
  const pickStore = multi && ME && ME.seesAllWorkshops;
  modal('New disposal note', `
    ${pickStore ? field('Store', 'store_id', { type: 'select', options: (wd.stores || []).map((x) => ({ value: x.id, label: x.name })) }) : ''}
    <div id="dn-scrap" class="muted">Loading…</div>
    <h4 style="margin:12px 0 4px">Other scrap parts</h4>
    <div id="dn-parts"></div>
    <button type="button" class="sm" id="dn-addpart">+ Add a part</button>
    <div class="row" style="margin-top:8px">${field('Waste oil (litres)', 'waste_oil', { type: 'number' })}${field('Buyer (if known)', 'buyer')}</div>
    ${field('Note', 'note')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Save note</button></div>`, (b, close) => {
    const parts = [];
    let scrap = { tyres: [], batteries: [] };
    const loadScrap = async () => {
      const sid = pickStore ? qs('[name=store_id]', b).value : '';
      try { scrap = await api('/stores/disposals/scrap' + (sid ? '?store_id=' + sid : '')); } catch (e) { scrap = { tyres: [], batteries: [] }; }
      const box = (list, kind) => (list.length ? list.map((u) => `<label style="display:flex;gap:8px;align-items:center;flex-direction:row;font-weight:400">
          <input type="checkbox" data-${kind}="${u.id}" style="width:auto"> ${esc(u.serial_no)} <span class="muted">${esc(u.spec || '')}</span></label>`).join('')
        : '<p class="muted" style="margin:0">None.</p>');
      qs('#dn-scrap', b).classList.remove('muted');
      qs('#dn-scrap', b).innerHTML = `<h4 style="margin:4px 0">Scrap tyres</h4>${box(scrap.tyres, 'tyre')}
        <h4 style="margin:10px 0 4px">Scrap batteries</h4>${box(scrap.batteries, 'battery')}`;
    };
    const drawParts = () => {
      qs('#dn-parts', b).innerHTML = parts.map((p, i) => `<div class="row" style="align-items:end">
          <div style="flex:3"><label>Part</label><input data-p="${i}" data-f="description" value="${esc(p.description)}"></div>
          <div><label>Qty</label><input type="number" data-p="${i}" data-f="qty" value="${esc(p.qty)}"></div>
          <div><label>Unit</label><input data-p="${i}" data-f="unit" value="${esc(p.unit)}"></div>
          <div style="flex:0"><button type="button" class="sm" data-rm="${i}">✕</button></div></div>`).join('');
      qsa('[data-p]', b).forEach((el) => { el.oninput = () => { parts[+el.dataset.p][el.dataset.f] = el.value; }; });
      qsa('[data-rm]', b).forEach((el) => { el.onclick = () => { parts.splice(+el.dataset.rm, 1); drawParts(); }; });
    };
    qs('#dn-addpart', b).onclick = () => { parts.push({ description: '', qty: 1, unit: 'nos' }); drawParts(); };
    if (pickStore) qs('[name=store_id]', b).onchange = loadScrap;
    loadScrap();
    qs('#s', b).onclick = async () => {
      const f = formData(b);
      const lines = qsa('[data-tyre]', b).filter((x) => x.checked).map((x) => ({ kind: 'tyre', tyre_id: Number(x.dataset.tyre) }))
        .concat(qsa('[data-battery]', b).filter((x) => x.checked).map((x) => ({ kind: 'battery', battery_id: Number(x.dataset.battery) })))
        .concat(parts.filter((p) => String(p.description).trim()).map((p) => ({ kind: 'part', ...p })))
        .concat(Number(f.waste_oil) > 0 ? [{ kind: 'waste_oil', qty: Number(f.waste_oil) }] : []);
      if (!lines.length) return toast('Put at least one thing on the note', 'err');
      try {
        const r = await api('/stores/disposals', { method: 'POST', body: { store_id: f.store_id, buyer: f.buyer, note: f.note, lines } });
        toast(r.disposal_no + ' saved. A manager approves it.'); close();
        location.hash = '#/stores?tab=disposal&id=' + r.id;
      } catch (e) { toast(e.message, 'err'); }
    };
  }, { wide: true });
}

async function disposalDetail(body, id) {
  let d;
  try { d = await api('/stores/disposals/' + encodeURIComponent(id)); } catch (e) { body.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const reload = () => disposalDetail(body, id);
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const line = (k, v) => `<div class="cost-line"><span>${k}</span><span>${v}</span></div>`;
  body.innerHTML = `
    <div class="toolbar" style="margin:0 0 8px"><a class="btn sm" href="#/stores?tab=disposal">← Disposal notes</a></div>
    <div class="card section">
      <div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">${esc(d.disposal_no)}</h3>${disposalBadge(d.status)}<div class="spacer"></div>
        ${d.can.edit ? '<button class="sm" id="dn-edit">Change buyer / amount</button>' : ''}
        ${d.can.cancel ? '<button class="sm danger" id="dn-cancel">Cancel note</button>' : ''}
        ${d.can.approve ? '<button class="sm primary" id="dn-approve">Approve…</button>' : ''}</div>
      ${line('Store', esc(d.store_name || '—'))}
      ${line('Written by', `${esc(d.created_by_name || '—')} · ${esc(String(d.created_at || '').slice(0, 10))}`)}
      ${line('Buyer', esc(d.buyer || '—'))}
      ${line('Amount', d.amount == null ? '—' : money(d.amount))}
      ${line('Date it leaves', esc(d.sale_date || '—'))}
      ${d.note ? line('Note', esc(d.note)) : ''}
      ${d.decided_by_name ? line(d.status === 'approved' ? 'Approved by' : 'Cancelled by',
    `${esc(d.decided_by_name)} · ${esc(String(d.decided_at || '').slice(0, 10))}${d.decision_note ? ' — ' + esc(d.decision_note) : ''}`) : ''}
    </div>
    <div class="card"><h3 style="margin-top:0">On this note</h3>
      ${tableWrap([{ label: 'Kind' }, { label: 'What' }, { label: 'Qty', num: true }, { label: 'Unit' }],
    d.lines.map((l) => `<tr><td>${DISPOSAL_KIND[l.kind] || esc(l.kind)}</td>
        <td>${l.tyre_id ? `<a href="${tyreHash(l.tyre_id)}">${esc(l.description)}</a>` : l.battery_id ? `<a href="#/batteries/${l.battery_id}">${esc(l.description)}</a>` : esc(l.description)}</td>
        <td class="num">${num(l.qty)}</td><td>${esc(l.unit || '')}</td></tr>`))}</div>`;
  const moneyForm = (label) => `
    <div class="row">${field('Buyer *', 'buyer', { value: d.buyer || '' })}${field('Amount (Rs) *', 'amount', { type: 'number', value: d.amount ?? '' })}</div>
    ${field('Date it leaves *', 'sale_date', { type: 'date', value: d.sale_date || today })}
    <p class="muted" style="font-size:12px;margin:4px 0 0">Amount 0 if it is taken away for nothing.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">${label}</button></div>`;
  if (qs('#dn-approve', body)) qs('#dn-approve', body).onclick = () => modal('Approve ' + d.disposal_no, moneyForm('Approve'), (b, close) => {
    qs('#s', b).onclick = async () => {
      try { await api(`/stores/disposals/${d.id}/approve`, { method: 'POST', body: formData(b) }); toast('Approved'); close(); reload(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
  if (qs('#dn-edit', body)) qs('#dn-edit', body).onclick = () => modal(d.disposal_no, moneyForm('Save') + field('Note', 'note', { value: d.note || '' }), (b, close) => {
    qs('#s', b).onclick = async () => {
      try { await api(`/stores/disposals/${d.id}`, { method: 'PUT', body: formData(b) }); toast('Saved'); close(); reload(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
  if (qs('#dn-cancel', body)) qs('#dn-cancel', body).onclick = () => modal('Cancel ' + d.disposal_no, `
    ${field('Why is it cancelled? *', 'reason')}
    <div style="margin-top:12px;text-align:right"><button class="primary danger" id="s">Cancel note</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      try { await api(`/stores/disposals/${d.id}/cancel`, { method: 'POST', body: formData(b) }); toast('Cancelled'); close(); reload(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---- stock take: count sessions --------------------------------------------------------------
const COUNT_STATUS = { counting: ['blue', 'Counting'], submitted: ['amber', 'Waiting for head office'], approved: ['green', 'Approved'], cancelled: ['', 'Cancelled'] };
const countBadge = (st) => `<span class="badge ${(COUNT_STATUS[st] || [''])[0]}">${esc((COUNT_STATUS[st] || [0, st])[1])}</span>`;
const countWhat = (r) => (r.scope === 'quick' ? `Quick count · ${r.item_name || ''}` : `${KIND_LABEL[r.kind] || r.kind} · full count`);
const signed = (n) => `<span style="color:${n < 0 ? 'var(--danger,#c4392c)' : n > 0 ? 'var(--success,#2e7d32)' : 'inherit'}">${n > 0 ? '+' : ''}${num(n)}</span>`;
const signedMoney = (n) => `<span style="color:${n < 0 ? 'var(--danger,#c4392c)' : n > 0 ? 'var(--success,#2e7d32)' : 'inherit'}">${n > 0 ? '+' : ''}${money(n)}</span>`;

async function countList(body, sp) {
  const FILTERS = [['open', 'Open'], ['submitted', 'Waiting for head office'], ['approved', 'Approved'], ['cancelled', 'Cancelled'], ['all', 'All']];
  const status = FILTERS.some(([k]) => k === sp.get('status')) || sp.get('status') === 'counting' ? sp.get('status') : 'open';
  const [rows, wd] = await Promise.all([api('/stores/counts?status=' + status), workshopsData().catch(() => null)]);
  const multi = !!(wd && wd.stores_multi);
  body.innerHTML = `
    <div class="toolbar">
      ${FILTERS.map(([k, l]) => `<button class="sm ${k === status ? 'primary' : ''}" data-st="${k}">${l}</button>`).join('')}
      <div class="spacer"></div>
      ${canDo('stores.stock.count') ? '<button class="primary sm" id="cnt-new">+ Start a stock take</button>' : ''}
    </div>
    <p class="muted" style="margin:0 0 8px">Count what is on the shelf. Head office approves, then the differences go into stock.</p>
    ${rows.length ? tableWrap(
    [{ label: 'No' }].concat(multi ? [{ label: 'Store' }] : []).concat([{ label: 'What' }, { label: 'Status' }, { label: 'Date' },
      { label: 'Counted', num: true }, { label: 'Differences', num: true }, { label: 'Value of differences', num: true }, { label: '' }]),
    rows.map((r) => `<tr>
        <td><a href="#/stores?tab=counts&id=${r.id}">${esc(r.count_no)}</a></td>
        ${multi ? `<td>${esc(r.store_name || '')}</td>` : ''}
        <td>${esc(countWhat(r))}</td>
        <td>${countBadge(r.status)}</td>
        <td>${esc(r.count_date)}</td>
        <td class="num">${num(r.totals.counted)} of ${num(r.totals.lines)}</td>
        <td class="num">${num(r.totals.differ)}</td>
        <td class="num">${r.totals.differ ? signedMoney(r.totals.net_value) : '—'}</td>
        <td><a class="btn sm" href="#/stores?tab=counts&id=${r.id}">Open</a></td></tr>`), { scroll: true })
    : '<div class="card"><p class="muted">No stock takes here.</p></div>'}`;
  qsa('[data-st]', body).forEach((b) => { b.onclick = () => { location.hash = '#/stores?tab=counts&status=' + b.dataset.st; }; });
  if (qs('#cnt-new', body)) qs('#cnt-new', body).onclick = () => countStartModal(multi, wd);
}

function countStartModal(multi, wd) {
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const pickStore = multi && ME && ME.seesAllWorkshops;
  modal('Start a stock take', `
    ${pickStore ? field('Store', 'store_id', { type: 'select', options: (wd.stores || []).map((x) => ({ value: x.id, label: x.name })) }) : ''}
    ${field('What to count', 'kind', { type: 'select', options: [['all', 'All kinds'], ...STOCK_KINDS.filter(([k]) => k !== 'overview').map(([k]) => [k, KIND_LABEL[k]])].map(([value, label]) => ({ value, label })) })}
    ${field('Date', 'count_date', { type: 'date', value: today })}
    ${field('Note (optional)', 'note')}
    <p class="muted" style="font-size:12px">The list holds every item the store's book knows. The book figure is kept from now; anything issued or received while you count is shown apart.</p>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Start</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => {
      try {
        const r = await api('/stores/counts', { method: 'POST', body: formData(b) });
        close(); toast(`${r.count_no} started · ${r.lines.length} items to count`);
        location.hash = '#/stores?tab=counts&id=' + r.id;
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function countDetail(body, id, sp) {
  let d;
  try { d = await api('/stores/counts/' + encodeURIComponent(id)); }
  catch (e) { body.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const VIEWS = [['sheet', '✏️ Count sheet'], ['diff', '⚖️ Differences'], ['all', 'All items']];
  const view = VIEWS.some(([k]) => k === sp.get('view')) ? sp.get('view') : (d.can.count ? 'sheet' : 'diff');
  const go = (v) => { location.hash = `#/stores?tab=counts&id=${d.id}&view=${v}`; };
  const reload = () => countDetail(body, id, sp);
  const t = d.totals;
  const who = (name, at) => (name ? ` by ${esc(name)}${at ? ' on ' + esc(String(at).slice(0, 10)) : ''}` : '');
  body.innerHTML = `
    <div class="toolbar" style="margin:0 0 8px"><a class="btn sm" href="#/stores?tab=counts">← Stock takes</a></div>
    <div class="card section">
      <h3 style="margin:0 0 4px">${esc(d.count_no)} · ${esc(countWhat({ ...d, item_name: d.lines[0] && d.lines[0].item_name }))} ${countBadge(d.status)}</h3>
      <p class="muted" style="margin:0">${esc(d.store_name || '')} · began ${esc(d.count_date)}${who(d.started_by_name)}${d.note ? ' · ' + esc(d.note) : ''}
        ${d.submitted_at ? ` · sent${who(d.submitted_by_name, d.submitted_at)}` : ''}${d.decided_at ? ` · ${esc(d.status)}${who(d.decided_by_name, d.decided_at)}` : ''}</p>
      ${d.decision_note && d.status === 'counting' ? `<p class="err" style="margin:6px 0 0">Sent back: ${esc(d.decision_note)}</p>` : ''}
      ${d.decision_note && d.status === 'cancelled' ? `<p class="muted" style="margin:6px 0 0">Why: ${esc(d.decision_note)}</p>` : ''}
      <div style="display:flex;gap:6px 18px;flex-wrap:wrap;margin-top:10px;font-size:15px">
        <span><b id="cnt-counted">${num(t.counted)} / ${num(t.lines)}</b> <span class="muted">counted</span></span>
        <span><b>${num(t.differ)}</b> <span class="muted">differences${t.unpriced ? ` (${t.unpriced} without a price)` : ''}</span></span>
        <span>${signedMoney(t.over_value)} <span class="muted">more than the book</span></span>
        <span>${signedMoney(t.short_value)} <span class="muted">less than the book</span></span>
        <span><b>${signedMoney(t.net_value)}</b> <span class="muted">net</span></span>
      </div>
    </div>
    <div class="toolbar">
      ${VIEWS.map(([k, l]) => `<button class="sm ${k === view ? 'primary' : ''}" data-view="${k}">${l}</button>`).join('')}
      <div class="spacer"></div>
      ${d.can.submit ? '<button class="primary sm" id="c-submit">📨 Send to head office</button>' : ''}
      ${d.can.approve ? '<button class="primary sm" id="c-approve">✔ Approve</button>' : ''}
      ${d.can.send_back ? '<button class="sm" id="c-back">↩ Send back</button>' : ''}
      ${d.can.cancel ? '<button class="sm" id="c-cancel">✖ Cancel</button>' : ''}
      <a class="btn sm" href="/api/stores/counts/${d.id}/export.xlsx">⬇ Excel</a>
    </div>
    <div id="cnt-body"></div>`;
  qsa('[data-view]', body).forEach((b) => { b.onclick = () => go(b.dataset.view); });
  const host = qs('#cnt-body', body);
  const act = async (path, payload, msg) => {
    try { await api(`/stores/counts/${d.id}/${path}`, { method: 'POST', body: payload || {} }); toast(msg); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const withReason = (title, label, path, msg) => modal(title, `${field(label, 'reason')}
    <div style="margin-top:12px;text-align:right"><button class="primary" id="s">${esc(title)}</button></div>`, (b, close) => {
    qs('#s', b).onclick = async () => { close(); await act(path, formData(b), msg); };
  });
  if (qs('#c-submit', body)) qs('#c-submit', body).onclick = () => act('submit', null, 'Sent to head office');
  if (qs('#c-approve', body)) {
    qs('#c-approve', body).onclick = () => modal('Approve this stock take?', `
      <p>${num(t.differ)} difference(s), net ${money(t.net_value)}. They go into ${esc(d.store_name || 'the store')}'s stock now.</p>
      <div style="margin-top:12px;text-align:right"><button class="primary" id="s">Approve</button></div>`, (b, close) => {
      qs('#s', b).onclick = async () => { close(); await act('approve', null, 'Approved · stock corrected'); };
    });
  }
  if (qs('#c-back', body)) qs('#c-back', body).onclick = () => withReason('Send back', 'What to count again', 'send-back', 'Sent back to count again');
  if (qs('#c-cancel', body)) qs('#c-cancel', body).onclick = () => withReason('Cancel', 'Why cancel this count', 'cancel', 'Cancelled');

  if (view === 'sheet') return countSheet(host, d, reload);
  const rows = view === 'diff'
    ? d.lines.filter((l) => l.diff).sort((a, b) => Math.abs(b.diff_value ?? b.diff) - Math.abs(a.diff_value ?? a.diff))
    : d.lines;
  const kindCol = d.kind === 'all';
  host.innerHTML = rows.length ? tableWrap(
    [{ label: 'Item', cls: 'desc-col' }].concat(kindCol ? [{ label: 'Kind' }] : []).concat([{ label: 'Unit' },
      { label: 'Book at start', num: true }, { label: 'Moved while counting', num: true }, { label: 'Book when counted', num: true },
      { label: 'Counted', num: true }, { label: 'Difference', num: true }, { label: 'Value', num: true }, { label: 'Note' }]),
    rows.map((l) => `<tr>
      <td class="desc-col">${esc(l.item_name)}${l.added ? ' <span class="badge blue" title="Found on the shelf, not on the list">added</span>' : ''}</td>
      ${kindCol ? `<td>${esc(KIND_LABEL[l.section])}</td>` : ''}
      <td>${esc(l.unit || '')}</td>
      <td class="num">${num(l.book_start)}</td>
      <td class="num">${l.counted && l.moved_during ? signed(l.moved_during) : ''}</td>
      <td class="num">${l.counted ? num(l.book_at_count) : ''}</td>
      <td class="num">${l.counted ? `<b>${num(l.counted_qty)}</b>${l.containers ? `<div class="muted" style="font-size:11px">${num(l.containers)} × ${num(l.container_size)} L + ${num(l.loose_qty)} L</div>` : ''}` : '<span class="muted">not counted</span>'}</td>
      <td class="num">${l.counted ? signed(l.diff) : ''}</td>
      <td class="num">${l.diff_value != null && l.diff ? signedMoney(l.diff_value) : (l.diff ? '<span class="muted" title="No price yet">—</span>' : '')}</td>
      <td class="muted" style="font-size:12px">${esc(l.note || '')}</td></tr>`), { scroll: true })
    : `<div class="card"><p class="muted">${view === 'diff' ? (t.counted ? 'No differences: the shelf matches the book.' : 'Nothing counted yet.') : 'No items.'}</p></div>`;
}

// The count sheet: the items and what is on the shelf — not the book figure, so the count is what
// was seen. Works on a phone; each count saves as soon as it is typed.
function countSheet(host, d, reload) {
  const editable = d.can.count;
  let onlyLeft = editable;
  const kindCol = d.kind === 'all';
  host.innerHTML = `
    <div class="toolbar">
      <input id="cs-q" type="search" placeholder="Find an item…" style="max-width:240px">
      <button class="sm" id="cs-left"></button><button class="sm" id="cs-all">All items</button>
      <div class="spacer"></div>
      ${editable ? '<button class="sm" id="cs-add">+ Item not on the list</button>' : ''}
    </div>
    ${editable ? '' : '<p class="muted" style="margin:0 0 8px">This count cannot be changed now.</p>'}
    <div id="cs-rows"></div>`;
  const left = () => d.lines.filter((l) => !l.counted).length;
  const input = (l, name, value, ph, w = 90) => `<input type="number" min="0" step="any" data-f="${name}" value="${value ?? ''}" placeholder="${ph}" style="width:${w}px;text-align:right" ${editable ? '' : 'disabled'}>`;
  const cell = (l) => (l.section === 'oil'
    ? `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end">${input(l, 'containers', l.containers, 'drums', 78)}<span>×</span>${input(l, 'container_size', l.container_size, 'size L', 78)}<span>+</span>${input(l, 'loose_qty', l.loose_qty, 'dip L', 78)}
        <span class="muted" style="font-size:12px">or</span>${input(l, 'counted', l.containers ? '' : l.counted_qty, 'total L', 84)}</div>`
    : input(l, 'counted', l.counted_qty, l.unit || 'qty'));
  const mark = (l) => (l.counted ? `<span class="badge green" title="${esc(l.counted_by_name || '')}">✓ ${num(l.counted_qty)}</span>` : '<span class="muted">—</span>');
  const draw = () => {
    const q = qs('#cs-q', host).value.trim().toLowerCase();
    qs('#cs-left', host).textContent = `Not counted (${left()})`;
    qs('#cs-left', host).classList.toggle('primary', onlyLeft);
    qs('#cs-all', host).classList.toggle('primary', !onlyLeft);
    const rows = d.lines.filter((l) => (!onlyLeft || !l.counted) && (!q || String(l.item_name || '').toLowerCase().includes(q)));
    qs('#cs-rows', host).innerHTML = rows.length ? tableWrap(
      [{ label: 'Item', cls: 'desc-col' }].concat(kindCol ? [{ label: 'Kind' }] : []).concat([{ label: 'Unit' }, { label: 'On the shelf', num: true }, { label: '' }]),
      rows.map((l) => `<tr data-line="${l.id}">
        <td class="desc-col">${esc(l.item_name)}${l.added ? ' <span class="badge blue">added</span>' : ''}</td>
        ${kindCol ? `<td>${esc(KIND_LABEL[l.section])}</td>` : ''}
        <td>${esc(l.unit || '')}</td>
        <td class="num">${cell(l)}</td>
        <td data-mark>${mark(l)}</td></tr>`), { scroll: true, fit: true, noHScroll: true })
      : `<div class="card"><p class="muted">${onlyLeft && !q ? 'Everything is counted. Check the differences, then send it to head office.' : 'Nothing matches.'}</p></div>`;
    if (!editable) return;
    qsa('tr[data-line]', host).forEach((tr) => {
      const l = d.lines.find((x) => String(x.id) === tr.dataset.line);
      const save = async (ev) => {
        const vals = {};
        qsa('[data-f]', tr).forEach((i) => { vals[i.dataset.f] = i.value; });
        // For a lubricant, typing the drums clears a total typed before, and the other way round.
        if (l.section === 'oil' && ev && ev.target.dataset.f !== 'counted' && (vals.containers || vals.loose_qty)) vals.counted = '';
        if (l.section === 'oil' && ev && ev.target.dataset.f === 'counted') { vals.containers = ''; vals.container_size = ''; vals.loose_qty = ''; }
        const body = l.section === 'oil' && (vals.containers || vals.loose_qty) ? vals : { counted: vals.counted };
        if (l.section === 'oil' && body.containers && !body.container_size) { qs('[data-mark]', tr).innerHTML = '<span class="badge amber">size?</span>'; return; }
        try {
          const r = await api(`/stores/counts/${d.id}/lines/${l.id}`, { method: 'PUT', body });
          Object.assign(l, r);
          qs('[data-mark]', tr).innerHTML = mark(l);
          qs('#cs-left', host).textContent = `Not counted (${left()})`;
          const top = qs('#cnt-counted');
          if (top) top.textContent = `${num(d.lines.length - left())} / ${num(d.lines.length)}`;
        } catch (e) { toast(e.message, 'err'); }
      };
      qsa('[data-f]', tr).forEach((i) => { i.onchange = save; });
    });
  };
  let deb;
  qs('#cs-q', host).oninput = () => { clearTimeout(deb); deb = setTimeout(draw, 200); };
  qs('#cs-left', host).onclick = () => { onlyLeft = true; draw(); };
  qs('#cs-all', host).onclick = () => { onlyLeft = false; draw(); };
  if (qs('#cs-add', host)) qs('#cs-add', host).onclick = () => countAddModal(d, reload);
  draw();
}

// An item found on the shelf that the list did not name: find it in the catalogue and add it.
function countAddModal(d, reload) {
  modal('Item not on the list', `
    <input id="ca-q" type="search" placeholder="Name, code or part number…">
    <div id="ca-res" style="margin-top:8px"><p class="muted">Type at least 2 letters.</p></div>`, (b, close) => {
    let deb;
    const find = async () => {
      const q = qs('#ca-q', b).value.trim();
      const res = qs('#ca-res', b);
      if (q.length < 2) { res.innerHTML = '<p class="muted">Type at least 2 letters.</p>'; return; }
      const items = await api(`/stores/counts/${d.id}/find?q=${encodeURIComponent(q)}`);
      res.innerHTML = items.length ? items.map((i) => `<div class="cost-line"><span>${esc(i.name)} <span class="muted" style="font-size:11px">${esc(i.code || '')} · ${esc(KIND_LABEL[i.section])}</span></span>
          ${i.on_list ? '<span class="muted">on the list</span>' : `<button class="sm primary" data-add="${esc(i.section)}|${esc(i.item_key)}">Add</button>`}</div>`).join('')
        : '<p class="muted">Nothing found.</p>';
      qsa('[data-add]', res).forEach((x) => {
        x.onclick = async () => {
          const [section, key] = x.dataset.add.split('|');
          try { await api(`/stores/counts/${d.id}/lines`, { method: 'POST', body: { section, item_key: key } }); close(); toast('Added · count it on the sheet'); reload(); }
          catch (e) { toast(e.message, 'err'); }
        };
      });
    };
    qs('#ca-q', b).oninput = () => { clearTimeout(deb); deb = setTimeout(find, 250); };
    qs('#ca-q', b).focus();
  });
}

// ---- Service & Filter Plan -------------------------------------------------
// Which machines are candidates for service this month, and the filters each would need —
// read out of what that machine actually took at its own past services. Deliberately framed
// as a shortlist to tick through: the underlying prediction is about 70 days out on average,
// and roughly 150 machines qualify in a month that will really see 26–49 services.
routes.serviceplan = async (c) => {
  if (!canView('serviceplan')) { c.innerHTML = `<div class="card"><p class="err">You do not have access to the Service &amp; Filter Plan.</p></div>`; return; }
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

async function renderFilterStock(c) {
  if (!canView('filters')) { c.innerHTML = `<div class="card"><p class="err">You do not have access to Filters.</p></div>`; return; }
  const edit = canEdit('filters');
  c.innerHTML = `
    <div class="card section"><h3 style="margin-top:0">Stock position <span class="muted" style="font-weight:400;font-size:12px">— requested, received, issued and what's left, from the shared stock ledger</span></h3>
      <div id="fs-stock"></div></div>
    <p class="muted" id="fs-whole" style="font-size:12px;margin:0 0 8px;display:none"></p>
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
  wholeCompanyNote(qs('#fs-whole', c));
  let lowOnly = false, rows = [];
  const load = async () => {
    const q = qs('#fs-q', c).value.trim();
    const query = '?' + (q ? 'q=' + encodeURIComponent(q) + '&' : '') + (lowOnly ? 'low_stock=1' : '');
    try {
      const [s, items] = await Promise.all([api('/filter-stock/summary'), api('/filter-stock/' + query)]);
      qs('#fs-stats', c).innerHTML = [
        [num(s.total_types), 'Total Filter Types'], [moneyC(s.total_value), 'Total Stock Value (LKR)'], [num(s.low_stock_count), 'Low Stock Count'],
      ].map(([n, l]) => `<div class="card stat"><span class="n">${n}</span><span class="l">${esc(l)}</span></div>`).join('');
      rows = items;
      qs('#fs-count', c).textContent = items.length + (items.length === 1 ? ' type' : ' types');
      const headers = [{ label: 'Type' }, { label: 'Brand' }, { label: 'Part No' }, { label: 'Compatible Vehicles' }, { label: 'In Stock', num: true }, { label: 'Reorder', num: true }, { label: 'Unit Cost', num: true }, { label: 'Status' }, { label: 'Actions' }];
      const body = items.map((r) => `<tr${r.status !== 'ok' ? ' style="background:rgba(224,168,0,.06)"' : ''}>
        <td><a href="javascript:void 0" data-led="${r.id}"><b>${esc(r.filter_type)}</b></a></td>
        <td>${esc(r.brand || '—')}</td><td>${esc(r.part_no || '—')}</td><td>${fsPills(r.compatible_assets)}</td>
        <td class="num">${num(r.qty_in_stock)} ${esc(r.unit || '')}</td><td class="num">${num(r.reorder_level)}</td>
        <td class="num">${money(r.unit_cost)}</td><td>${fsStatus(r.status)}</td>
        <td style="white-space:nowrap">${edit ? `<button class="sm" data-rcv="${r.id}">Receive</button> <button class="sm" data-iss="${r.id}">Issue</button>` : ''}</td></tr>`);
      qs('#fs-table', c).innerHTML = tableWrap(headers, body, { scroll: true });
      const byId = (id) => rows.find((x) => String(x.id) === String(id));
      qsa('[data-led]', c).forEach((a) => { a.onclick = () => fsLedger(a.dataset.led); });
      qsa('[data-rcv]', c).forEach((b) => { b.onclick = () => fsReceive(byId(b.dataset.rcv)); });
      qsa('[data-iss]', c).forEach((b) => { b.onclick = () => fsIssue(byId(b.dataset.iss)); });
    } catch (e) { qs('#fs-table', c).innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
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
  qs('#fs-q', c).oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
  qs('#fs-low', c).onclick = () => { lowOnly = !lowOnly; qs('#fs-low', c).classList.toggle('primary', lowOnly); load(); };
  if (edit && qs('#fs-add', c)) qs('#fs-add', c).onclick = fsAdd;
  load();
}

routes.filterstock = async (c) => {
  location.replace('#/filters?tab=book');
};

// ===== Stock Issues — Redirect Shim to Stores Movements (Issues) =====
routes.stockissues = async (c) => {
  location.replace('#/stores?tab=movements&sub=issues');
};

// ===== Material Requests — Redirect Shim to Stores Paperwork (MRN) =====
routes.matreq = async (c) => {
  location.replace('#/stores?tab=paperwork&sub=mrn');
};

// ---------------------------------------------------------------- two-factor sign-in
//
// The second step of signing in, enrolling a phone, and the settings box in the top bar. The
// server holds every rule (src/lib/mfa.js); these screens only walk a person through it.

// After a right password on an account with two-factor sign-in: ask for the code.
function renderMfaStep(challenge, username, err) {
  let recovery = false;
  const draw = (msg) => {
    qs('#app').innerHTML = `<div class="login-wrap"><div class="card login-card">
      <div class="brand">Workshop<span style="color:var(--primary)">One</span></div>
      <div class="sub">Two-factor sign-in · ${esc(username)}</div>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
      ${recovery
        ? `<label>Recovery code</label><input id="mc" autocomplete="off" autocapitalize="characters" placeholder="ABCDE-FGHJK">
           <p class="muted" style="font-size:12px">Each recovery code works once.</p>`
        : `<label>6-digit code from your authenticator app</label>
           <input id="mc" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" style="font-size:22px;letter-spacing:4px;text-align:center">`}
      <button class="primary" id="mgo" style="width:100%;margin-top:14px">Verify</button>
      <button class="btn" id="mswap" style="width:100%;margin-top:8px;font-size:12px">${recovery ? 'Use the code from my app' : 'I don\'t have my phone — use a recovery code'}</button>
      <button class="btn" id="mback" style="width:100%;margin-top:8px;font-size:12px">← Back to sign in</button>
    </div></div>`;
    const go = async () => {
      try {
        ME = await api('/auth/mfa/verify', { method: 'POST', body: { challenge, code: qs('#mc').value } });
        afterSignIn();
        if (ME.recoveryCodesLeft != null) {
          toast(ME.recoveryCodesLeft <= 3
            ? `Signed in with a recovery code — only ${ME.recoveryCodesLeft} left. Make new ones under Two-factor.`
            : `Signed in with a recovery code (${ME.recoveryCodesLeft} left).`, ME.recoveryCodesLeft <= 3 ? 'err' : undefined);
        }
      } catch (e) {
        if (e.data && e.data.restart) return renderLogin(e.message);
        draw(e.message);
      }
    };
    qs('#mgo').onclick = go;
    qs('#mc').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    qs('#mswap').onclick = () => { recovery = !recovery; draw(); };
    qs('#mback').onclick = () => renderLogin();
    qs('#mc').focus();
  };
  draw(err);
}

// What happens once someone is fully signed in, however they got there.
function afterSignIn() {
  live('connect');   // the socket is refused until a session exists
  location.hash = '#/dashboard'; render();
  if (ME.mustChangePassword) forceChangePassword();
  else if (ME.mfaSetupRequired) forceMfaSetup();
}

// The recovery codes, shown exactly once. The person must say they have kept them.
function showRecoveryCodes(codes, onDone) {
  const text = codes.join('\n');
  modal('Your recovery codes', `
    <p>If you lose your phone, each of these lets you sign in <b>once</b>. Keep them somewhere safe and
    private — printed and locked away, or in a password manager. <b>They will not be shown again.</b></p>
    <pre style="font-size:16px;line-height:1.7;background:#f8fafc;padding:10px;border-radius:6px;columns:2">${esc(text)}</pre>
    <div class="pill-row"><button class="sm" id="rccopy">Copy</button><button class="sm" id="rcprint">Print</button></div>
    <label style="flex-direction:row;display:flex;gap:6px;align-items:center;margin-top:12px"><input type="checkbox" id="rcok" style="width:auto"> I have saved these codes</label>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="rcdone" disabled>Done</button></div>`,
  (body, close) => {
    qs('#rcok', body).onchange = (e) => { qs('#rcdone', body).disabled = !e.target.checked; };
    qs('#rccopy', body).onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch (e) { toast('Copy failed — select the codes and copy them by hand', 'err'); } };
    qs('#rcprint', body).onclick = () => {
      const w = window.open('', '_blank');
      if (!w) return toast('Allow pop-ups to print', 'err');
      w.document.write(`<pre style="font:16px monospace">WorkshopOne recovery codes — ${esc(ME.username)}\n\n${esc(text)}</pre>`);
      w.document.close(); w.print();
    };
    qs('#rcdone', body).onclick = () => { close(); if (onDone) onDone(); };
  }, { persistent: true });
}

// Enrol a phone. `forced`: the role requires it, so there is no "later" — only sign out.
async function runMfaSetup({ forced = false, onDone } = {}) {
  let s;
  try { s = await api('/auth/mfa/setup', { method: 'POST' }); } catch (e) { return toast(e.message, 'err'); }
  modal('Set up two-factor sign-in', `
    ${forced ? '<p><b>Your role requires two-factor sign-in.</b> Set it up now to continue.</p>' : ''}
    <ol style="padding-left:18px;line-height:1.6">
      <li>On your phone, install <b>Google Authenticator</b> or <b>Microsoft Authenticator</b> (free, from the app store).</li>
      <li>In the app, tap <b>+</b> → <b>Enter a setup key</b>. Account name: <b>WorkshopOne</b>. Key:
        <div style="font:600 18px monospace;letter-spacing:2px;background:#f8fafc;padding:10px;border-radius:6px;margin:6px 0;word-break:break-all" id="mkey">${esc(s.grouped)}</div>
        Type of key: <b>Time based</b>. <span class="muted">On this phone already? <a href="${esc(s.uri)}">Open in the authenticator app</a>.</span></li>
      <li>Type the 6-digit code the app now shows:</li>
    </ol>
    <input id="mcode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" style="font-size:22px;letter-spacing:4px;text-align:center">
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
      ${forced ? '<button class="btn" id="mout">Sign out</button>' : '<button class="btn" id="mcancel">Cancel</button>'}
      <button class="primary" id="menable">Turn on</button>
    </div>`,
  (body, close) => {
    const enable = async () => {
      try {
        const r = await api('/auth/mfa/enable', { method: 'POST', body: { code: qs('#mcode', body).value } });
        close();
        ME.mfaEnabled = true; ME.mfaSetupRequired = false;
        showRecoveryCodes(r.recoveryCodes, () => {
          toast('Two-factor sign-in is on');
          live('connect');   // refused until now if the role required it
          render();
          if (onDone) onDone();
        });
      } catch (e) { toast(e.message, 'err'); }
    };
    qs('#menable', body).onclick = enable;
    qs('#mcode', body).addEventListener('keydown', (e) => { if (e.key === 'Enter') enable(); });
    if (qs('#mcancel', body)) qs('#mcancel', body).onclick = close;
    if (qs('#mout', body)) qs('#mout', body).onclick = async () => { close(); await api('/auth/logout', { method: 'POST' }); ME = null; location.hash = ''; boot(); };
  }, { persistent: forced });
}

// Asked for from several places (sign-in, boot, any request the server answers with 428) — only
// one setup box at a time.
let _mfaSetupPending = null;
function forceMfaSetup() {
  if (_mfaSetupPending || document.querySelector('#menable')) return;
  _mfaSetupPending = runMfaSetup({ forced: true }).finally(() => { _mfaSetupPending = null; });
}

// ---- signed-in devices ---------------------------------------------------------------------------

// Server times are UTC "YYYY-MM-DD HH:MM:SS" (or ISO). Shown as "12 min ago · 24 Sep 09:14".
function whenText(t) {
  if (!t) return '—';
  const ms = Date.parse(String(t).includes('T') ? t : String(t).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return esc(t);
  const mins = Math.round((Date.now() - ms) / 60000);
  const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return `${rel} <span class="muted" style="font-size:11px">· ${esc(new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>`;
}
function sessionRows(list, { mine }) {
  return list.map((x) => `<tr>
    <td><b>${esc(x.device)}</b>${x.current ? ' <span class="badge green">this device</span>' : ''}${x.second_factor ? ' <span class="badge blue" title="Signed in with two-factor">2FA</span>' : ''}
      <br><span class="muted" style="font-size:11px">${esc(x.ip || '')}</span></td>
    <td>${whenText(x.signed_in_at)}</td><td>${whenText(x.last_active_at)}</td>
    <td>${mine && !x.current ? `<button class="sm" data-endsess="${x.id}">Sign out</button>` : ''}</td></tr>`);
}

// The top-bar "Security" box: where I am signed in, and two-factor sign-in.
async function securityModal() {
  let d;
  try { d = await api('/auth/sessions'); } catch (e) { return toast(e.message, 'err'); }
  const others = d.sessions.filter((x) => !x.current).length;
  modal('Security', `
    <h3 style="margin-top:0">Where you are signed in</h3>
    ${tableWrap([{ label: 'Device' }, { label: 'Signed in' }, { label: 'Last active' }, { label: '' }], sessionRows(d.sessions, { mine: true }))}
    <p class="muted" style="font-size:12px">${d.policy.idleMinutes ? `You are signed out automatically after ${d.policy.idleMinutes} minutes without activity, and` : 'Sessions end'} after ${d.policy.ttlHours} hours in any case. Don't recognise a device? Sign it out and change your password.</p>
    <div class="pill-row">
      <button class="btn" id="endothers" ${others ? '' : 'disabled'}>Sign out all other devices${others ? ` (${others})` : ''}</button>
      <button class="btn" id="open2fa">Two-factor sign-in: ${ME && ME.mfaEnabled ? 'on' : 'off'} …</button>
    </div>`,
  (body, close) => {
    qsa('[data-endsess]', body).forEach((b) => b.onclick = async () => {
      try { await api(`/auth/sessions/${b.dataset.endsess}/revoke`, { method: 'POST' }); toast('Signed out'); close(); securityModal(); }
      catch (e) { toast(e.message, 'err'); }
    });
    qs('#endothers', body).onclick = async () => {
      try { const r = await api('/auth/sessions/revoke-others', { method: 'POST' }); toast(`${r.ended} other device(s) signed out`); close(); securityModal(); }
      catch (e) { toast(e.message, 'err'); }
    };
    qs('#open2fa', body).onclick = () => { close(); mfaSettingsModal(); };
  });
}

// An admin looking at someone else's sessions (Users & Roles → Sessions).
async function userSessionsModal(u) {
  let d;
  try { d = await api(`/users/${u.id}/sessions`); } catch (e) { return toast(e.message, 'err'); }
  modal('Signed-in devices — ' + u.username, `
    ${tableWrap([{ label: 'Device' }, { label: 'Signed in' }, { label: 'Last active' }, { label: '' }], sessionRows(d.sessions, { mine: false }))}
    <div style="margin-top:12px;text-align:right"><button class="btn danger" id="endall" ${d.sessions.length ? '' : 'disabled'}>Sign out everywhere</button></div>`,
  (body, close) => {
    qs('#endall', body).onclick = async () => {
      if (!confirm(`Sign ${u.username} out on every device? They can sign in again straight away with their password.`)) return;
      try { const r = await api(`/users/${u.id}/sessions/revoke`, { method: 'POST' }); toast(`${r.ended} session(s) ended`); close(); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

// The top-bar box: is it on, recovery codes left, new codes, turn off.
async function mfaSettingsModal() {
  let st;
  try { st = await api('/auth/mfa'); } catch (e) { return toast(e.message, 'err'); }
  if (!st.enabled) {
    return modal('Two-factor sign-in', `
      <p>Two-factor sign-in is <b>off</b> for your account.</p>
      <p class="muted">With it on, signing in needs your password <b>and</b> a 6-digit code from an app on your phone —
      so a stolen or guessed password is not enough on its own.</p>
      <div style="margin-top:12px;text-align:right"><button class="primary" id="mon">Set it up</button></div>`,
    (body, close) => { qs('#mon', body).onclick = () => { close(); runMfaSetup(); }; });
  }
  modal('Two-factor sign-in', `
    <p>Two-factor sign-in is <b>on</b>.${st.required ? ' Your role requires it.' : ''}</p>
    <p>Recovery codes left: <b>${st.recoveryCodesLeft}</b>${st.recoveryCodesLeft <= 3 ? ' <span class="badge amber">running low</span>' : ''}</p>
    <hr>
    <label>Code from your app (needed for either button)</label>
    <input id="mc" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456">
    ${st.required ? '' : `<label>Password (only to turn it off)</label><input id="mpw" type="password">`}
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" id="mnewrc">New recovery codes</button>
      ${st.required ? '' : '<button class="btn danger" id="moff">Turn off</button>'}
    </div>
    <p class="muted" style="font-size:12px">New phone? Ask an administrator to reset your two-factor sign-in, then set it up again.</p>`,
  (body, close) => {
    qs('#mnewrc', body).onclick = async () => {
      try { const r = await api('/auth/mfa/recovery-codes', { method: 'POST', body: { code: qs('#mc', body).value } }); close(); showRecoveryCodes(r.recoveryCodes); }
      catch (e) { toast(e.message, 'err'); }
    };
    if (qs('#moff', body)) qs('#moff', body).onclick = async () => {
      if (!confirm('Turn off two-factor sign-in? Your password alone will be enough to sign in.')) return;
      try { await api('/auth/mfa/disable', { method: 'POST', body: { code: qs('#mc', body).value, password: qs('#mpw', body).value } }); ME.mfaEnabled = false; close(); toast('Two-factor sign-in is off'); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

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
    ${window.WORKSHOPONE_IS_PACKAGED_APP
      // Only the packaged app needs a server address — it is loaded off the device and has no
      // origin of its own. In a browser this button offered a way to point the app at a machine
      // that is not the one serving it, which is never right and, on the day the system went
      // public, left PCs calling an unreachable LAN address and reporting only "Failed to fetch".
      ? `<button type="button" class="btn" onclick="window.configureServerIp()" style="width:100%;margin-top:8px;font-size:12px;cursor:pointer">⚙️ Server: ${esc(currentServer)}</button>`
      : ''}
    <!-- The demo credentials that used to be printed here (admin/admin, store/store, …) are gone.
         They were seed passwords, all since rotated, so the hint was wrong as well as unwise:
         people read it, typed admin/admin, were refused, and concluded the system was broken.
         On a login page facing the internet it was also a list of which names are worth guessing. -->
  </div></div>`;
  const go = async () => {
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username: qs('#u').value, password: qs('#p').value } });
      if (r.mfaRequired) return renderMfaStep(r.challenge, r.username);
      ME = r;
      afterSignIn();
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
    else if (ME.mfaSetupRequired) forceMfaSetup();
  } catch (e) {
    renderLogin(e && e.message ? 'Server connection issue: ' + e.message : null);
  }
}
boot();
