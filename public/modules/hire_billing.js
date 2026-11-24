'use strict';

/**
 * WorkshopOne + Fuel-System-V2 Machine Hire, Costing Options, Rate Cards,
 * Consumption Bands, Site Allocator, Breakdown Monitoring & Billing Module (:1949)
 *
 * Mounts at window.routes['hire-billing'] and window.routes['hire']
 * 5 Integrated Tabs:
 *   1. Rental Bills & Revisions (Auto-Prefill, Breakdown Billing Lock & Deduction, SSCL + VAT)
 *   2. Rate Cards & Consumption Bands (Fleet Rate Cards + Portable Plant + Econ/Typ/Heavy Editor)
 *   3. Site Allocator Console (Assets & Projects Pickers, DRY_WITH_DRIVER / DRY / WET, Month From–To / Current)
 *   4. Breakdown Monitoring (All-Site Job Records, JR Descriptions, Admin Start/Close Adjust, Billing Block)
 *   5. Payments & Receivables Aging (0–30, 31–60, 61–90, 90+ days buckets & payment recording)
 */

(function () {
  function notify(msg, kind = 'err') {
    if (typeof toast === 'function') toast(msg, kind);
    else console[kind === 'err' ? 'error' : 'log'](msg);
  }

  function fmtLkr(val) {
    return 'Rs ' + Number(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtCents(c) {
    return fmtLkr(Number(c || 0) / 100);
  }

  function fmtNum(val, dec = 1) {
    if (val === null || val === undefined || isNaN(Number(val))) return '—';
    return Number(val).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function fmtDateDMY(iso) {
    if (!iso) return '—';
    const s = String(iso).trim().slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
  }

  function lastDayOfMonthStr(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (!m) return currentTodayStr();
    const y = Number(m[1]);
    const mon = Number(m[2]);
    const d = new Date(y, mon, 0).getDate();
    return `${m[1]}-${m[2]}-${String(d).padStart(2, '0')}`;
  }

  function currentTodayStr() {
    if (typeof slToday === 'function') return slToday();
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function currentMonthStr() {
    return currentTodayStr().slice(0, 7);
  }

  function basisLabelText(b) {
    const k = String(b || '').toUpperCase();
    if (k === 'DRY_WITH_DRIVER') return 'DRY WITH DRIVER';
    if (k === 'FULLY_WET') return 'FULLY WET';
    if (k === 'FUEL_ONLY') return 'FUEL ONLY';
    return k || 'DRY';
  }

  function verdictBadge(v) {
    const s = String(v || '').toUpperCase();
    if (s === 'OVER') return '<span class="badge red">OVER</span>';
    if (s === 'HEAVY') return '<span class="badge amber">HEAVY</span>';
    if (s === 'NORMAL') return '<span class="badge green">NORMAL</span>';
    if (s === 'BELOW_ECON') return '<span class="badge blue">BELOW ECON</span>';
    if (s === 'NO_METER') return '<span class="muted" style="font-size:11px">No meter</span>';
    return '<span class="muted" style="font-size:11px">—</span>';
  }

  function canAdjustBreakdowns() {
    return (typeof isAdmin === 'function' && isAdmin()) ||
      (typeof canDo === 'function' && canDo('hire.breakdowns.adjust'));
  }

  async function renderHireBilling(content) {
    const hashParts = (location.hash || '').split('?');
    const qParams = new URLSearchParams(hashParts[1] || '');
    let activeTab = qParams.get('tab') || 'bills';
    let initialRatesMode = qParams.get('mode') || null;
    const curYm = currentMonthStr();
    let curYear = Number(curYm.slice(0, 4));
    let curMonth = Number(curYm.slice(5, 7));

    content.innerHTML = `
      <div class="crumb"><a href="#/dashboard">Dashboard</a> / Machine Hire, Costing Options, Rates &amp; Billing</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0;font-size:24px;font-weight:800">📑 Machine Hire, Costing Options &amp; Rate Cards</h1>
          <p class="muted" style="margin:4px 0 0 0">Site &amp; Monthly Rental Billing, Dry with Driver / Wet / Fully-Wet tariffs, Consumption Bands, Site Allocator &amp; Breakdown Monitoring</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="btn_site_summary_bill" style="background:#0f172a;border-color:#0f172a">🧾 Site Summary Bill</button>
          <button class="btn primary" id="btn_generate_site_bills">🏢 + Bill by Site &amp; Month</button>
          <button class="btn" id="btn_generate_bill">⚡ + Generate Single Bill</button>
          <button class="btn" id="btn_costing_options">⚙️ Costing Options</button>
          <button class="btn" id="btn_sync_costing" style="background:#059669;color:#fff;border-color:#059669">🔄 Sync Bills to Vehicle Costing P&amp;L</button>
          <a href="#/vehicle-costing" class="btn">💰 Final Costing P&amp;L</a>
        </div>
      </div>

      <!-- 5-Tab Bar -->
      <div class="tabs" id="hire_tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid var(--border);padding-bottom:8px">
        <button class="btn sm" data-tab="bills">📑 Rental Bills &amp; Revisions</button>
        <button class="btn sm" data-tab="rates">🏷️ Rate Cards &amp; Consumption Bands</button>
        <button class="btn sm" data-tab="allocations">📍 Site Allocator Console</button>
        <button class="btn sm" data-tab="breakdowns">🛠️ Breakdown Monitoring</button>
        <button class="btn sm" data-tab="aging">💰 Payments &amp; Receivables Aging</button>
      </div>

      <div id="hire_tab_content"></div>
    `;

    let cachedProjects = null;
    async function loadProjectsList() {
      if (cachedProjects) return cachedProjects;
      try {
        const pRes = await api('/projects');
        cachedProjects = Array.isArray(pRes) ? pRes : (pRes.projects || []);
      } catch (_) {
        cachedProjects = [];
      }
      return cachedProjects;
    }

    let cachedSitesCatalog = null;
    async function loadSitesCatalog() {
      if (cachedSitesCatalog) return cachedSitesCatalog;
      try {
        const res = await api('/hire/sites-catalog');
        if (res && Array.isArray(res.projects)) {
          cachedSitesCatalog = res;
          return cachedSitesCatalog;
        }
      } catch (_) {}
      const list = await loadProjectsList();
      cachedSitesCatalog = { projects: list, sites: [], availableMonths: [] };
      return cachedSitesCatalog;
    }

    function buildSiteSelectOptionsHtml(catalog, selectedVal = '', { allowAll = true, allValue = 'ALL', allLabel = 'All Sites / Projects', includeSubSites = true } = {}) {
      const projects = (catalog && catalog.projects) || [];
      const activeGroup = projects.filter((p) => p.hasBillingData || p.active !== 0);
      const otherGroup = projects.filter((p) => !p.hasBillingData && p.active === 0);
      const selStr = String(selectedVal == null ? '' : selectedVal);

      const fmtProjOpt = (p) => {
        const label = p.code ? `${p.code} · ${p.name}` : p.name;
        const loc = p.location && !String(label).toLowerCase().includes(String(p.location).toLowerCase()) ? ` [${p.location}]` : '';
        const siteOpts = (includeSubSites && Array.isArray(p.sites) && p.sites.length)
          ? p.sites.map((s) => `<option value="site:${s.id}" ${selStr === `site:${s.id}` ? 'selected' : ''}>↳ ${esc(p.name)} — ${esc(s.name)}</option>`).join('')
          : '';
        return `<option value="${p.id}" ${selStr === String(p.id) ? 'selected' : ''}>${esc(label)}${esc(loc)}</option>${siteOpts}`;
      };

      const parts = [];
      if (allowAll) {
        const isAllSel = selStr === String(allValue) || (allValue === 'ALL' && selStr.toUpperCase() === 'ALL');
        parts.push(`<option value="${esc(allValue)}" ${isAllSel ? 'selected' : ''}>${esc(allLabel)}</option>`);
      }
      if (activeGroup.length) parts.push(`<optgroup label="Projects &amp; Operational Sites">${activeGroup.map(fmtProjOpt).join('')}</optgroup>`);
      if (otherGroup.length) parts.push(`<optgroup label="Other Projects (${otherGroup.length})">${otherGroup.map(fmtProjOpt).join('')}</optgroup>`);
      return parts.join('');
    }

    function switchTab(t, extra = {}) {
      activeTab = t;
      if (t === 'rates' && extra && extra.mode) {
        initialRatesMode = extra.mode;
      }
      qsa('#hire_tabs button').forEach((b) => b.classList.toggle('primary', b.getAttribute('data-tab') === t));
      const box = qs('#hire_tab_content');
      if (t === 'bills') renderBillsTab(box);
      else if (t === 'rates') renderRatesTab(box);
      else if (t === 'allocations') renderAllocationsTab(box);
      else if (t === 'breakdowns') renderBreakdownsTab(box);
      else if (t === 'aging') renderAgingTab(box);
    }

    qsa('#hire_tabs button').forEach((b) => {
      b.onclick = () => switchTab(b.getAttribute('data-tab'));
    });

    // Site & Month Sync to Vehicle Costing P&L Modal & Costing Options
    qs('#btn_costing_options').onclick = () => openCostingOptionsModal();
    qs('#btn_sync_costing').onclick = () => openSyncCostingModal();
    qs('#btn_site_summary_bill').onclick = () => {
      const box = qs('#hire_tab_content');
      const curProj = box && qs('#bill_proj', box) ? qs('#bill_proj', box).value : '';
      const curY = box && qs('#bill_year', box) ? qs('#bill_year', box).value : '';
      const curM = box && qs('#bill_month', box) ? qs('#bill_month', box).value : '';
      const ym = (curY && curM) ? `${curY}-${String(curM).padStart(2, '0')}` : '';
      openSiteSummaryModal({ defaultProjectId: curProj || '', defaultMonth: ym });
    };
    qs('#btn_generate_site_bills').onclick = () => openGenerateSiteBillsModal({});
    qs('#btn_generate_bill').onclick = () => openGenerateBillModal(() => switchTab('bills'));

    async function openCostingOptionsModal() {
      let opts = {
        earlyMonthCutoffDay: 10,
        workingDaysPerMonth: 25,
        autoAllocMinConsecutive: 2,
        singleSiteFullMonthMode: 'EARLY_CUTOFF',
      };
      try {
        opts = await api('/hire/costing-options');
      } catch (_) {}

      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:540px;padding:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h2 style="margin:0">⚙️ Costing &amp; Fuel Timeline Rules</h2>
            <button type="button" class="btn sm" id="btn_co_close">✕ Close</button>
          </div>
          <p class="muted" style="margin:0 0 14px 0;font-size:12px">Configure how monthly working periods, early-month fuel cutoff, site transfers, and auto-allocations are calculated.</p>
          <form id="form_costing_opts" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:11.5px;font-weight:700">Single-Site Full Month Rule</label>
              <select id="co_mode" class="input sm" style="width:100%">
                <option value="EARLY_CUTOFF" ${opts.singleSiteFullMonthMode === 'EARLY_CUTOFF' ? 'selected' : ''}>Full Month if fuel issued on/before Cutoff Day OR continuous from prior month (Recommended)</option>
                <option value="ALWAYS_FULL" ${opts.singleSiteFullMonthMode === 'ALWAYS_FULL' ? 'selected' : ''}>Always Full Month whenever a site issued any fuel</option>
                <option value="ACTUAL_FROM_FIRST_FUEL" ${opts.singleSiteFullMonthMode === 'ACTUAL_FROM_FIRST_FUEL' ? 'selected' : ''}>Always start from first fuel date in the month</option>
              </select>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11.5px;font-weight:700">Early-Month Cutoff Day (1–28)</label>
                <input type="number" id="co_cutoff" min="1" max="28" required class="input sm" value="${opts.earlyMonthCutoffDay}" style="width:100%">
              </div>
              <div>
                <label style="font-size:11.5px;font-weight:700">Working Days / Month (1–31)</label>
                <input type="number" id="co_work_days" min="1" max="31" required class="input sm" value="${opts.workingDaysPerMonth}" style="width:100%">
              </div>
              <div>
                <label style="font-size:11.5px;font-weight:700" title="Consecutive fuel issues required at another site before auto-allocation switches (short stops still bill separately)">Transit Auto-Alloc Issues (1–10)</label>
                <input type="number" id="co_transit" min="1" max="10" required class="input sm" value="${opts.autoAllocMinConsecutive}" style="width:100%">
              </div>
            </div>
            <div style="background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.2);padding:10px;border-radius:6px;font-size:11.5px">
              • If fuel is issued at a new site mid-month, the previous site stops the day before and the new site starts on the fuel issue date (zero double-billing).<br>
              • Repair / breakdown periods charge <b>Rs 0</b> to the site while tracking internal Workshop Repairs + Lost Hire Revenue in Costing P&amp;L.
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button type="button" class="btn sm" id="btn_co_cancel">Cancel</button>
              <button type="submit" class="btn sm primary">Save Rules</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modalEl);
      const closeM = () => modalEl.remove();
      modalEl.querySelector('#btn_co_close').onclick = closeM;
      modalEl.querySelector('#btn_co_cancel').onclick = closeM;
      modalEl.onclick = (e) => { if (e.target === modalEl) closeM(); };
      modalEl.querySelector('#form_costing_opts').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/hire/costing-options', {
            method: 'PUT',
            body: {
              singleSiteFullMonthMode: modalEl.querySelector('#co_mode').value,
              earlyMonthCutoffDay: Number(modalEl.querySelector('#co_cutoff').value),
              workingDaysPerMonth: Number(modalEl.querySelector('#co_work_days').value),
              autoAllocMinConsecutive: Number(modalEl.querySelector('#co_transit').value),
            },
          });
          toast('Costing rules updated!');
          closeM();
        } catch (err) {
          notify(err.message);
        }
      };
    }

    async function openSiteSummaryModal({ defaultProjectId = '', defaultMonth = '' } = {}) {
      const [catalog, savedCo] = await Promise.all([
        loadSitesCatalog(),
        api('/hire/costing-options').catch(() => ({ workingDaysPerMonth: 25 })),
      ]);
      const defWorkDays = Number(savedCo && savedCo.workingDaysPerMonth) || 25;
      const projects = catalog.projects || [];
      const monthsList = catalog.availableMonths || [];
      const firstOpProj = projects.find((p) => p.hasBillingData) || projects[0];
      const initialProjId = defaultProjectId || (firstOpProj ? String(firstOpProj.id) : 'ALL');
      const initialMonth = defaultMonth || curYm;

      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:1100px;width:96%;max-height:92vh;overflow-y:auto;padding:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px">
            <div>
              <h2 style="margin:0">🧾 Site Summary Bill (Consolidated Monthly Site Statement)</h2>
              <p class="muted" style="margin:3px 0 0 0;font-size:12px">Generates one combined statement per site (Projects &amp; Sites registry · Active working days excluding breakdown period · Actual Cons Typ vs Meter vs Prorated Minimum + Site Pump Fuel + SSCL &amp; VAT + Transfers Excluded).</p>
            </div>
            <button class="btn sm" id="btn_ss_close">✕ Close</button>
          </div>

          <div class="card" style="padding:12px;margin-bottom:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;background:rgba(15,23,42,0.04)">
            <div style="min-width:230px;flex:1.4">
              <label style="font-size:11px;font-weight:600">Site / Project (from Projects section) *</label>
              <select id="ss_proj" class="input sm" style="width:100%">
                ${buildSiteSelectOptionsHtml(catalog, initialProjId, { allowAll: true, allValue: 'ALL', allLabel: 'All Sites / Projects (Combined)', includeSubSites: true })}
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Billing Month *</label>
              <input type="month" id="ss_month" class="input sm" value="${esc(initialMonth)}">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Rate Tier Rule</label>
              <select id="ss_basis" class="input sm">
                <option value="SUMMARY_WET">Summary Standard (Wet + Site Fuel)</option>
                <option value="ALLOCATION">Follow Allocation Basis</option>
                <option value="DRY">Force DRY Rate</option>
                <option value="WET">Force WET Rate</option>
                <option value="FULLY_WET">Force FULLY WET Rate</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Site Fuel Rule</label>
              <select id="ss_fuel_policy" class="input sm">
                <option value="ALL_SITE_PUMPS">Charge All Site Pump Fuel</option>
                <option value="BASIS_ONLY">Skip Fuel on DRY</option>
              </select>
            </div>
            <div style="width:72px">
              <label style="font-size:11px;font-weight:600" title="Monthly working days baseline for deducting breakdown dates">Work Days</label>
              <input type="number" id="ss_work_days" class="input sm" value="${defWorkDays}" min="1" max="31" style="width:100%">
            </div>
            <div style="width:72px">
              <label style="font-size:11px;font-weight:600">Min Hr</label>
              <input type="number" id="ss_min_hr" class="input sm" value="120" min="0" style="width:100%">
            </div>
            <div style="width:78px">
              <label style="font-size:11px;font-weight:600">Min KM</label>
              <input type="number" id="ss_min_km" class="input sm" value="3000" min="0" style="width:100%">
            </div>
            <label style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;cursor:pointer;padding:6px 4px">
              <input type="checkbox" id="ss_inc_zero"> Include 0-fuel posted
            </label>
            <button type="button" class="btn sm primary" id="btn_ss_load">🔍 Load Summary</button>
          </div>

          ${monthsList.length ? `
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:11.5px">
              <span class="muted" style="font-weight:600">Months with data:</span>
              ${monthsList.slice(0, 8).map((ym) => `<button type="button" class="btn sm ss-ym-chip" data-ym="${esc(ym)}" style="padding:3px 8px;font-size:11px">${esc(ym)}</button>`).join('')}
            </div>
          ` : ''}

          <div id="ss_actions_bar" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn sm" id="btn_ss_print">🖨️ Print Preview</button>
              <button type="button" class="btn sm primary" id="btn_ss_pdf" style="background:#b45309;border-color:#b45309">📄 Download PDF</button>
              <button type="button" class="btn sm" id="btn_ss_xlsx" style="background:#059669;color:#fff;border-color:#059669">📊 Export Excel</button>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <select id="ss_gen_finalise" class="input sm">
                <option value="0">Bill Status: DRAFT</option>
                <option value="1">Bill Status: FINAL</option>
              </select>
              <button type="button" class="btn sm primary" id="btn_ss_generate">🏢 Bill All Listed Machines</button>
            </div>
          </div>

          <div id="ss_preview_body" class="muted" style="font-size:12px">Loading site summary...</div>
        </div>
      `;
      document.body.appendChild(modalEl);

      const closeModal = () => modalEl.remove();
      modalEl.querySelector('#btn_ss_close').onclick = closeModal;
      modalEl.onclick = (e) => { if (e.target === modalEl) closeModal(); };

      let lastLoadedSummaries = [];

      function buildQueryStr() {
        const q = new URLSearchParams({
          projectId: modalEl.querySelector('#ss_proj').value || 'ALL',
          month: modalEl.querySelector('#ss_month').value || curYm,
          basisMode: modalEl.querySelector('#ss_basis').value || 'SUMMARY_WET',
          fuelPolicy: modalEl.querySelector('#ss_fuel_policy').value || 'ALL_SITE_PUMPS',
          workingDaysInMonth: modalEl.querySelector('#ss_work_days').value || '25',
          minHours: modalEl.querySelector('#ss_min_hr').value || '120',
          minKm: modalEl.querySelector('#ss_min_km').value || '3000',
          includeZeroFuel: modalEl.querySelector('#ss_inc_zero').checked ? '1' : '0',
        });
        return q.toString();
      }

      function renderOneSummaryBlock(s) {
        const stBadge = s.status === 'FINAL'
          ? '<span class="badge ok">FINAL</span>'
          : '<span class="badge warn">DRAFT</span>';
        const fuelNote = s.fuelRateCents != null
          ? ` @ Rs ${(s.fuelRateCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/L${s.fuelRateBlended ? ' avg' : ''}`
          : '';
        const rows = (s.lines || []).map((l) => {
          const consHtml = l.consRefUnits != null
            ? `<div>${fmtNum(l.consRefUnits, 1)} ${esc(l.unit)}</div>${l.consTypRate != null ? `<div class="muted" style="font-size:10.5px">@ ${esc(l.consTypRate)} L/${esc(l.unit)}</div>` : ''}`
            : '—';
          const meterHtml = l.actualUnits != null ? `${fmtNum(l.actualUnits, 1)} ${esc(l.unit)}` : '—';
          const billSub = l.breakdownDeductCents > 0 && l.breakdownDeductUnits > 0
            ? `${esc(l.billedOn)} (-${fmtNum(l.breakdownDeductUnits, Number.isInteger(l.breakdownDeductUnits) ? 0 : 1)} ${esc(l.unit)} BD)`
            : (l.billedOn === 'days on site' ? 'days on site' : `on ${esc(l.billedOn)}`);
          const billHtml = `<div><b>${fmtNum(l.billableUnits, 1)} ${esc(l.unit)}</b></div><div class="muted" style="font-size:10.5px">${billSub}</div>`;
          const billTag = l.existingBill
            ? `<span class="badge" style="font-size:10px">${esc(l.existingBill.invoice_number || l.existingBill.status)}</span>`
            : '';
          const bdTag = l.breakdownDays > 0
            ? `<div style="font-size:10px;color:#b91c1c;font-weight:700" title="${esc(l.blockReason || '')}">-${Number.isInteger(l.breakdownDays) ? l.breakdownDays : fmtNum(l.breakdownDays, 1)}d BD${l.breakdownDeductCents > 0 ? ` (-${fmtCents(l.breakdownDeductCents)})` : ''}</div>`
            : '';
          const stayTag = l.stayDatesLabel && l.postedDays < l.daysInMonth
            ? `<div class="muted" style="font-size:10px">${esc(l.stayDatesLabel)}</div>`
            : '';
          const fuelWarnTag = l.hasFuelDuringRepair
            ? `<div style="font-size:9.5px;color:#b45309;font-weight:700">⚠️ Fuel in repair (${fmtNum(l.fuelDuringRepairLitres || 0, 0)}L)</div>`
            : '';
          const daysCol = (l.workingDaysHere != null && l.workingDaysInMonth)
            ? `${fmtNum(l.workingDaysHere, Number.isInteger(l.workingDaysHere) ? 0 : 1)} / ${l.workingDaysInMonth}`
            : `${l.daysHere} / ${l.daysInMonth}`;
          return `
            <tr>
              <td style="padding:7px 8px"><b>${esc(l.code)}</b>${l.regNo ? `<div class="muted" style="font-size:10.5px">${esc(l.regNo)}</div>` : ''}</td>
              <td style="padding:7px 8px;text-align:right;white-space:nowrap">${daysCol} ${billTag}${stayTag}${bdTag}${fuelWarnTag}</td>
              <td style="padding:7px 8px;text-align:right">${consHtml}</td>
              <td style="padding:7px 8px;text-align:right">${meterHtml}</td>
              <td style="padding:7px 8px;text-align:right">${billHtml}</td>
              <td style="padding:7px 8px;text-align:right;white-space:nowrap">${l.rateCents != null ? fmtCents(l.rateCents) : '<span class="muted">no rate</span>'}</td>
              <td style="padding:7px 8px;text-align:right;white-space:nowrap">${fmtCents(l.rentalCents)}</td>
              <td style="padding:7px 8px;text-align:right;white-space:nowrap">${fmtNum(l.fuelLitres, 0)} L</td>
              <td style="padding:7px 8px;text-align:right;white-space:nowrap;font-weight:700">${fmtCents(l.lineTotalCents)}</td>
            </tr>
          `;
        }).join('');

        const xferRows = (s.transfersExcluded || []).map((t) => `
          <tr>
            <td style="padding:5px 8px;font-weight:700">${esc(t.ref)}</td>
            <td style="padding:5px 8px">${esc(t.description)}</td>
            <td style="padding:5px 8px;text-align:right">${fmtNum(t.litres, 0)} L</td>
            <td style="padding:5px 8px;text-align:right;font-weight:700">${fmtCents(t.amountCents)}</td>
          </tr>
        `).join('');

        const hasCallouts = s.noFuelHere.length || s.billedDirect.length || s.unrated.length;

        return `
          <div class="card" style="padding:0;margin-bottom:16px;overflow:hidden;border:1px solid var(--border)">
            <div style="background:#0f172a;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #f59e0b;flex-wrap:wrap;gap:8px">
              <div>
                <div style="font-size:15px;font-weight:800;color:#f59e0b;letter-spacing:0.5px">SITE SUMMARY BILL · ${esc(s.siteCode)}</div>
                <div style="font-size:12px;color:#e2e8f0">${esc(s.siteName)} · ${esc(s.monthLabel)} ${stBadge}</div>
              </div>
              <div style="display:flex;gap:16px;font-size:12px;align-items:center">
                <div><span style="color:#93c5fd">Machines:</span> <b>${s.lines.length}</b></div>
                <div><span style="color:#93c5fd">Fuel Here:</span> <b>${fmtNum(s.fuelLitres, 1)} L</b></div>
                <div><span style="color:#93c5fd">Site Total:</span> <b style="color:#f59e0b;font-size:14px">${fmtCents(s.grandTotalCents)}</b></div>
              </div>
            </div>

            <div style="overflow-x:auto">
              <table class="table" style="width:100%;margin:0;font-size:12px">
                <thead>
                  <tr>
                    <th style="padding:8px">MACHINE</th>
                    <th style="padding:8px;text-align:right">DAYS</th>
                    <th style="padding:8px;text-align:right">ACTUAL (CONS TYP)</th>
                    <th style="padding:8px;text-align:right">ACTUAL (METER)</th>
                    <th style="padding:8px;text-align:right">BILLABLE</th>
                    <th style="padding:8px;text-align:right">RATE</th>
                    <th style="padding:8px;text-align:right">RENTAL</th>
                    <th style="padding:8px;text-align:right">FUEL</th>
                    <th style="padding:8px;text-align:right">TOTAL</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || `<tr><td colspan="9" class="muted" style="padding:18px;text-align:center">No billable machines with fuel or bill records at this site for ${esc(s.periodKey)}.${s.noFuelHere.length ? ` <button type="button" class="btn xs primary btn-ss-show-zero" style="margin-left:8px">Show ${s.noFuelHere.length} 0-fuel stationed machine(s)</button>` : ''}</td></tr>`}
                </tbody>
              </table>
            </div>

            <div style="padding:14px 16px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;background:rgba(0,0,0,0.015)">
              <div style="flex:1;min-width:260px;display:flex;flex-direction:column;gap:8px">
                ${hasCallouts ? `
                  <div style="padding:10px 12px;background:#fef3c7;border-left:3px solid #f59e0b;color:#92400e;font-size:11.5px;border-radius:4px">
                    ${s.noFuelHere.length ? `<div style="margin-bottom:4px"><b>No fuel from this site&rsquo;s pumps (0 charged):</b> ${esc(s.noFuelHere.join(', '))}</div>` : ''}
                    ${s.billedDirect.length ? `<div style="margin-bottom:4px"><b>Settled direct with owner (0 charged):</b> ${esc(s.billedDirect.join(', '))}</div>` : ''}
                    ${s.unrated.length ? `<div><b>No rate card (0 rental):</b> ${esc(s.unrated.join(', '))}</div>` : ''}
                  </div>
                ` : ''}
                ${s.transfersExcluded && s.transfersExcluded.length ? `
                  <div style="padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-left:3px solid #f59e0b;border-radius:4px;color:#78350f;font-size:11.5px">
                    <div style="font-weight:700;margin-bottom:4px">TRANSFERS &amp; CORRECTIONS EXCLUDED (BILLED OUTSIDE) — ${fmtNum(s.transfersExcludedLitres, 0)} L · ${fmtCents(s.transfersExcludedCents)}</div>
                    <table style="width:100%;border-collapse:collapse;font-size:11px">
                      <tbody>${xferRows}</tbody>
                    </table>
                  </div>
                ` : ''}
              </div>

              <div style="min-width:300px;max-width:360px;flex:0.8">
                ${s.breakdownDeductCents > 0 ? `
                  <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>Gross machine rental (${s.workingDaysInMonth || 25}d base)</span><b>${fmtCents(s.grossRentalCents)}</b></div>
                  <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);color:#b91c1c"><span>Less: Breakdown rental deduction</span><b>-${fmtCents(s.breakdownDeductCents)}</b></div>
                ` : ''}
                <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>${s.breakdownDeductCents > 0 ? 'Net machine rental' : 'Machine rental'}</span><b>${fmtCents(s.rentalCents)}</b></div>
                <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>Fuel issued here (${fmtNum(s.fuelLitres, 1)} L${esc(fuelNote)})</span><b>${fmtCents(s.fuelCostCents)}</b></div>
                <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>Subtotal</span><b>${fmtCents(s.subtotalCents)}</b></div>
                <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>SSCL (${fmtNum(s.ssclRate * 100, 1)}%)</span><b>${fmtCents(s.ssclCents)}</b></div>
                <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>Value liable to VAT</span><b>${fmtCents(s.vatLiableCents)}</b></div>
                <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>VAT (${fmtNum(s.vatRate * 100, 1)}%)</span><b>${fmtCents(s.vatCents)}</b></div>
                <div style="display:flex;justify-content:space-between;padding:8px 10px;background:#0f172a;color:#fff;border-radius:4px;margin-top:6px;font-weight:800">
                  <span>SITE TOTAL (FINAL BILL)</span><span style="color:#f59e0b">${fmtCents(s.grandTotalCents)}</span>
                </div>
              </div>
            </div>
          </div>
        `;
      }

      async function loadSummary() {
        const bodyEl = modalEl.querySelector('#ss_preview_body');
        bodyEl.innerHTML = '<div style="padding:24px;text-align:center" class="muted">Calculating Site Summary Bill (days on site, breakdown period exclusions, consumption typ, coherent meters, prorated minimums &amp; taxes)...</div>';
        try {
          const data = await api(`/hire/bills/site-summary?${buildQueryStr()}`);
          const list = data.summaries || (data.summary ? [data.summary] : []);
          lastLoadedSummaries = list;
          modalEl.querySelectorAll('.ss-ym-chip').forEach((ch) => {
            ch.classList.toggle('primary', ch.getAttribute('data-ym') === (modalEl.querySelector('#ss_month').value || ''));
          });
          if (!list.length) {
            bodyEl.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">No sites with machine postings, fuel issues, or bills found for <b>${esc(modalEl.querySelector('#ss_month').value)}</b>.${monthsList[0] ? ` Try clicking a month with data above (e.g. <b>${esc(monthsList[0])}</b>).` : ''}</div>`;
            return;
          }
          const combinedHtml = data.combined
            ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px">
                <div class="card" style="padding:10px;border-left:4px solid #0f172a"><div class="muted" style="font-size:10.5px;font-weight:700">SITES WITH ACTIVITY</div><div style="font-size:17px;font-weight:800">${data.combined.totalSites}</div></div>
                <div class="card" style="padding:10px;border-left:4px solid #2563eb"><div class="muted" style="font-size:10.5px;font-weight:700">MACHINES</div><div style="font-size:17px;font-weight:800">${data.combined.totalMachines}</div></div>
                <div class="card" style="padding:10px;border-left:4px solid #b45309"><div class="muted" style="font-size:10.5px;font-weight:700">FUEL ISSUED</div><div style="font-size:17px;font-weight:800">${fmtNum(data.combined.fuelLitres, 1)} L</div></div>
                <div class="card" style="padding:10px;border-left:4px solid #059669"><div class="muted" style="font-size:10.5px;font-weight:700">RENTAL TOTAL</div><div style="font-size:16px;font-weight:800">${fmtCents(data.combined.rentalCents)}</div></div>
                <div class="card" style="padding:10px;border-left:4px solid #7c3aed"><div class="muted" style="font-size:10.5px;font-weight:700">ALL SITES TOTAL</div><div style="font-size:16px;font-weight:800;color:#2563eb">${fmtCents(data.combined.grandTotalCents)}</div></div>
              </div>`
            : '';
          bodyEl.innerHTML = combinedHtml + list.map(renderOneSummaryBlock).join('');
          modalEl.querySelectorAll('.btn-ss-show-zero').forEach((btn) => {
            btn.onclick = () => {
              const chk = modalEl.querySelector('#ss_inc_zero');
              if (chk) chk.checked = true;
              loadSummary();
            };
          });
        } catch (err) {
          lastLoadedSummaries = [];
          bodyEl.innerHTML = `<div class="card err" style="padding:16px">${esc(err.message)}</div>`;
        }
      }

      function ensureExportableOrWarn() {
        if (!lastLoadedSummaries.length) {
          notify(`No site summary data found for ${modalEl.querySelector('#ss_month').value}. Pick a month with activity (e.g. ${monthsList[0] || currentMonthStr()}) or select a site.`);
          return false;
        }
        const totalLines = lastLoadedSummaries.reduce((n, s) => n + ((s.lines || []).length), 0);
        if (totalLines === 0 && !modalEl.querySelector('#ss_inc_zero').checked) {
          notify(`This site currently has 0 billable machines with fuel/bills for ${modalEl.querySelector('#ss_month').value}, so the PDF table would be empty.\n\nSelect a month with activity (e.g. ${monthsList[0] || currentMonthStr()}) or tick "Include 0-fuel posted" first.`);
          return false;
        }
        return true;
      }

      async function downloadSummaryPdf() {
        if (!ensureExportableOrWarn()) return;
        const btn = modalEl.querySelector('#btn_ss_pdf');
        const origLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ Rendering PDF...';
        try {
          const resp = await fetch(`/api/hire/bills/site-summary/download.pdf?${buildQueryStr()}`, { credentials: 'same-origin' });
          const ct = resp.headers.get('content-type') || '';
          if (!resp.ok) {
            const msg = ct.includes('json') ? ((await resp.json()).error || resp.statusText) : await resp.text();
            throw new Error(msg || `HTTP ${resp.status}`);
          }
          if (ct.includes('text/html')) {
            // Graceful print fallback when host browser isn't available
            const htmlText = await resp.text();
            const w = window.open('', '_blank');
            if (w) { w.document.write(htmlText); w.document.close(); }
            return;
          }
          const blob = await resp.blob();
          const disp = resp.headers.get('content-disposition') || '';
          const m = /filename="?([^"]+)"?/i.exec(disp);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = m ? m[1] : `site-summary-${modalEl.querySelector('#ss_month').value}.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (err) {
          notify('PDF export error: ' + err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = origLabel;
        }
      }

      modalEl.querySelector('#btn_ss_load').onclick = loadSummary;
      modalEl.querySelector('#ss_proj').onchange = loadSummary;
      modalEl.querySelector('#ss_month').onchange = loadSummary;
      modalEl.querySelector('#ss_basis').onchange = loadSummary;
      modalEl.querySelector('#ss_fuel_policy').onchange = loadSummary;
      modalEl.querySelector('#ss_work_days').onchange = loadSummary;
      modalEl.querySelector('#ss_min_hr').onchange = loadSummary;
      modalEl.querySelector('#ss_min_km').onchange = loadSummary;
      modalEl.querySelector('#ss_inc_zero').onchange = loadSummary;
      modalEl.querySelectorAll('.ss-ym-chip').forEach((ch) => {
        ch.onclick = () => {
          modalEl.querySelector('#ss_month').value = ch.getAttribute('data-ym');
          loadSummary();
        };
      });
      modalEl.querySelector('#btn_ss_print').onclick = () => {
        if (!ensureExportableOrWarn()) return;
        window.open(`/api/hire/bills/site-summary/print.html?${buildQueryStr()}`, '_blank', 'noopener');
      };
      modalEl.querySelector('#btn_ss_pdf').onclick = downloadSummaryPdf;
      modalEl.querySelector('#btn_ss_xlsx').onclick = () => {
        if (!ensureExportableOrWarn()) return;
        window.open(`/api/hire/bills/site-summary/download.xlsx?${buildQueryStr()}`, '_blank', 'noopener');
      };
      modalEl.querySelector('#btn_ss_generate').onclick = async () => {
        if (!ensureExportableOrWarn()) return;
        try {
          const res = await api('/hire/bills/site-summary/generate', {
            method: 'POST',
            body: {
              projectId: modalEl.querySelector('#ss_proj').value || 'ALL',
              month: modalEl.querySelector('#ss_month').value || curYm,
              basisMode: modalEl.querySelector('#ss_basis').value || 'SUMMARY_WET',
              fuelPolicy: modalEl.querySelector('#ss_fuel_policy').value || 'ALL_SITE_PUMPS',
              includeZeroFuel: modalEl.querySelector('#ss_inc_zero').checked,
              workingDaysInMonth: Number(modalEl.querySelector('#ss_work_days').value || 25),
              minHours: Number(modalEl.querySelector('#ss_min_hr').value || 120),
              minKm: Number(modalEl.querySelector('#ss_min_km').value || 3000),
              finalise: modalEl.querySelector('#ss_gen_finalise').value === '1',
            },
          });
          const bdNote = res.skippedBreakdownsCount ? ` (${res.skippedBreakdownsCount} full-month breakdown skipped)` : '';
          toast(`Created ${res.generatedBills} site bill(s) for ${res.month}${bdNote}!`);
          loadSummary();
          if (activeTab === 'bills') switchTab('bills');
        } catch (err) {
          notify(err.message);
        }
      };

      loadSummary();
    }

    async function openSyncCostingModal() {
      const catalog = await loadSitesCatalog();
      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:460px;padding:24px">
          <h2 style="margin:0 0 6px 0">🔄 Sync Site &amp; Monthly Bills to Costing P&amp;L</h2>
          <p class="muted" style="margin:0 0 14px 0;font-size:12px">Auto-generates FINAL rental bills from Site Allocations, Rate Cards, and Fuel/Meter ledger (blocking open breakdowns).</p>
          <form id="form_sync_costing" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:11px;font-weight:600">Billing Month (Month / Year) *</label>
              <input type="month" id="sc_month" required class="input sm" value="${curYm}" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Project / Site</label>
              <select id="sc_proj" class="input sm" style="width:100%">
                ${buildSiteSelectOptionsHtml(catalog, 'ALL', { allowAll: true, allValue: 'ALL', allLabel: 'All Project Sites', includeSubSites: false })}
              </select>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
              <button type="button" class="btn" id="btn_sc_cancel">Cancel</button>
              <button type="submit" class="btn primary" style="background:#059669;border-color:#059669">🔄 Sync to Costing</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modalEl);
      modalEl.querySelector('#btn_sc_cancel').onclick = () => modalEl.remove();
      modalEl.onclick = (e) => { if (e.target === modalEl) modalEl.remove(); };
      modalEl.querySelector('#form_sync_costing').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const res = await api('/hire/sync-to-costing', {
            method: 'POST',
            body: {
              month: modalEl.querySelector('#sc_month').value || curYm,
              projectId: modalEl.querySelector('#sc_proj').value || 'ALL',
            },
          });
          const skipMsg = res.skippedBreakdownsCount
            ? ` (${res.skippedBreakdownsCount} blocked due to active breakdown)`
            : '';
          toast(`Synced ${res.generatedBills} new rental bill(s) for ${res.month}${skipMsg}!`);
          modalEl.remove();
          if (activeTab === 'bills') switchTab('bills');
        } catch (err) {
          notify('Sync error: ' + err.message);
        }
      };
    }

    async function openGenerateSiteBillsModal({ defaultProjectId = '', defaultMonth = curYm } = {}) {
      const catalog = await loadSitesCatalog();
      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:940px;width:96%;max-height:90vh;overflow-y:auto;padding:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px">
            <div>
              <h2 style="margin:0">🏢 Generate Site Monthly Rental Bills</h2>
              <p class="muted" style="margin:3px 0 0 0;font-size:12px">Bill in reference to <b>Site / Project</b> and <b>Month</b>. Open breakdowns are blocked automatically; closed breakdowns deduct downtime days.</p>
            </div>
            <button class="btn sm" id="btn_sb_close">✕ Close</button>
          </div>

          <div class="card" style="padding:12px;margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;background:rgba(37,99,235,0.04)">
            <div style="min-width:230px;flex:1">
              <label style="font-size:11px;font-weight:600">Site / Project *</label>
              <select id="sb_proj" class="input sm" style="width:100%">
                ${buildSiteSelectOptionsHtml(catalog, defaultProjectId, { allowAll: true, allValue: 'ALL', allLabel: 'All Sites / Projects', includeSubSites: false })}
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Billing Month (YYYY-MM) *</label>
              <input type="month" id="sb_month" class="input sm" value="${esc(defaultMonth || curYm)}">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Issue Status</label>
              <select id="sb_finalise" class="input sm">
                <option value="0">Save as DRAFT</option>
                <option value="1">FINALISE &amp; Issue Invoices</option>
              </select>
            </div>
            <label style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;cursor:pointer;padding:6px 4px" title="Deduct repair days and bill active working days even if breakdown card is still open">
              <input type="checkbox" id="sb_allow_open_bd" checked> Deduct open repair days &amp; bill active days
            </label>
            <button type="button" class="btn sm primary" id="btn_sb_preview">🔍 Load Site Machines</button>
          </div>

          <div id="sb_summary" class="muted" style="font-size:12px;margin-bottom:8px"></div>

          <div class="card" style="padding:0;overflow-x:auto;margin-bottom:14px">
            <table class="table" style="width:100%;margin:0;font-size:12px">
              <thead>
                <tr>
                  <th style="padding:8px 10px"><input type="checkbox" id="sb_chk_all" checked></th>
                  <th style="padding:8px 10px">Vehicle</th>
                  <th style="padding:8px 10px">Site / Project</th>
                  <th style="padding:8px 10px">Site Period</th>
                  <th style="padding:8px 10px">Basis · Rate</th>
                  <th style="padding:8px 10px;text-align:right">Units / Fuel</th>
                  <th style="padding:8px 10px">Breakdown Guard</th>
                  <th style="padding:8px 10px;text-align:right">Est. Grand Total</th>
                </tr>
              </thead>
              <tbody id="sb_tbody">
                <tr><td colspan="8" class="muted" style="padding:18px;text-align:center">Select Site &amp; Month above to preview billable machines...</td></tr>
              </tbody>
            </table>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn" id="btn_sb_cancel">Cancel</button>
            <button type="button" class="btn primary" id="btn_sb_submit">🏢 Generate Selected Site Bills</button>
          </div>
        </div>
      `;
      document.body.appendChild(modalEl);

      const closeModal = () => modalEl.remove();
      modalEl.querySelector('#btn_sb_close').onclick = closeModal;
      modalEl.querySelector('#btn_sb_cancel').onclick = closeModal;
      modalEl.onclick = (e) => { if (e.target === modalEl) closeModal(); };

      let currentItems = [];
      async function loadPreview() {
        const projId = modalEl.querySelector('#sb_proj').value || 'ALL';
        const month = modalEl.querySelector('#sb_month').value || curYm;
        const allowOpenBd = modalEl.querySelector('#sb_allow_open_bd') && modalEl.querySelector('#sb_allow_open_bd').checked ? '1' : '0';
        const tbody = modalEl.querySelector('#sb_tbody');
        const sumEl = modalEl.querySelector('#sb_summary');
        tbody.innerHTML = '<tr><td colspan="8" class="muted" style="padding:18px;text-align:center">Loading site machines &amp; checking breakdowns...</td></tr>';
        try {
          const data = await api(`/hire/bills/site-preview?projectId=${encodeURIComponent(projId)}&month=${encodeURIComponent(month)}&allowOpenBreakdownDeduction=${allowOpenBd}`);
          currentItems = data.items || [];
          const s = data.summary || {};
          sumEl.innerHTML = `Period <b>${esc(data.month)}</b> (${fmtDateDMY(data.periodStart)} – ${fmtDateDMY(data.periodEnd)}) · Machines: <b>${s.totalMachines || 0}</b> · Billable: <b style="color:#059669">${s.eligibleCount || 0}</b> · Blocked: <b style="color:#dc2626">${s.blockedCount || 0}</b> · Already Billed: <b>${s.alreadyBilledCount || 0}</b> · Est. Total: <b>${fmtCents(s.estimatedGrandTotalCents || 0)}</b>`;
          if (!currentItems.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="muted" style="padding:18px;text-align:center">No machines allocated or fueled at this site for the selected month.</td></tr>';
            return;
          }
          tbody.innerHTML = currentItems.map((it) => {
            const disabled = !it.eligible;
            let guardHtml = '<span class="badge green">✅ Clear</span>';
            if (it.billingBlocked) guardHtml = `<span class="badge red" title="${esc(it.blockReason || '')}">🚫 Blocked</span>`;
            else if (it.existingBill) guardHtml = `<span class="badge">${esc(it.existingBill.invoice_number || it.existingBill.status)}</span>`;
            else if (!it.hasRate) guardHtml = '<span class="badge amber">No Rate Card</span>';
            else if (it.breakdownDays > 0) guardHtml = `<span class="badge amber">-${it.breakdownDays}d (${fmtCents(it.calculation.breakdownDeductCents)})</span>`;
            const allocSpan = it.stayDatesLabel || `${fmtDateDMY(it.allocDateFrom)} → ${it.allocIsCurrent ? 'Current' : fmtDateDMY(it.allocDateTo)}`;
            const originBadge = it.stayOrigin === 'MANUAL'
              ? '<span class="badge" style="font-size:9.5px">Manual</span>'
              : '<span class="badge blue" style="font-size:9.5px">Fuel Timeline</span>';
            return `
              <tr style="${it.billingBlocked ? 'background:rgba(220,38,38,0.04)' : ''}">
                <td style="padding:7px 10px"><input type="checkbox" class="sb-row-chk" value="${it.assetId}" ${it.eligible ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>
                <td style="padding:7px 10px"><b>${esc(it.assetCode)}</b><div class="muted" style="font-size:11px">${esc(it.assetType || '')}</div></td>
                <td style="padding:7px 10px">${esc(it.projectName)}</td>
                <td style="padding:7px 10px;white-space:nowrap">${allocSpan} <div>${originBadge}</div></td>
                <td style="padding:7px 10px"><span class="badge">${esc(basisLabelText(it.billingMode))}</span> <span class="muted">${fmtCents(it.rateCents)}/${esc(it.rateBasis)}</span></td>
                <td style="padding:7px 10px;text-align:right">
                  <div>${fmtNum(it.actualUnits, 1)} · ${fmtNum(it.fuelLitres, 0)}L</div>
                  ${it.fuelPriceCents ? `<div class="muted" style="font-size:10.5px">@ Rs ${(Number(it.fuelPriceCents) / 100).toFixed(2)}/L</div>` : ''}
                </td>
                <td style="padding:7px 10px">${guardHtml}</td>
                <td style="padding:7px 10px;text-align:right;font-weight:700">${fmtCents(it.calculation ? it.calculation.grandTotalCents : 0)}</td>
              </tr>
            `;
          }).join('');
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="8" class="err" style="padding:16px">${esc(err.message)}</td></tr>`;
        }
      }

      modalEl.querySelector('#sb_chk_all').onchange = (e) => {
        const chk = e.target.checked;
        modalEl.querySelectorAll('.sb-row-chk:not(:disabled)').forEach((c) => { c.checked = chk; });
      };
      modalEl.querySelector('#btn_sb_preview').onclick = loadPreview;
      modalEl.querySelector('#sb_proj').onchange = loadPreview;
      modalEl.querySelector('#sb_month').onchange = loadPreview;
      if (modalEl.querySelector('#sb_allow_open_bd')) {
        modalEl.querySelector('#sb_allow_open_bd').onchange = loadPreview;
      }

      modalEl.querySelector('#btn_sb_submit').onclick = async () => {
        const selectedIds = [...modalEl.querySelectorAll('.sb-row-chk:checked')].map((c) => Number(c.value));
        if (!selectedIds.length) return notify('No eligible unblocked machines selected.');
        const allowOpenBd = !!(modalEl.querySelector('#sb_allow_open_bd') && modalEl.querySelector('#sb_allow_open_bd').checked);
        try {
          const res = await api('/hire/bills/generate-site', {
            method: 'POST',
            body: {
              projectId: modalEl.querySelector('#sb_proj').value || 'ALL',
              month: modalEl.querySelector('#sb_month').value || curYm,
              selectedAssetIds: selectedIds,
              finalise: modalEl.querySelector('#sb_finalise').value === '1',
              allowOpenBreakdownDeduction: allowOpenBd,
            },
          });
          const skipNote = res.skippedBreakdownsCount ? ` (${res.skippedBreakdownsCount} blocked by open breakdown)` : '';
          toast(`Generated ${res.generatedBills} site bill(s) for ${res.projectName} · ${res.month}${skipNote}!`);
          closeModal();
          switchTab('bills');
        } catch (err) {
          notify(err.message);
        }
      };

      loadPreview();
    }

    // Smart Single Bill Modal with Site, Month & Auto-Prefill + Breakdown Guard
    async function openGenerateBillModal(onDone) {
      const catalog = await loadSitesCatalog();
      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:650px;padding:24px">
          <h2 style="margin:0 0 4px 0">⚡ Generate Machine Rental Bill</h2>
          <p class="muted" style="margin:0 0 12px 0;font-size:12px">Auto-fills Rate Card, Site Allocation, Meter Span, Fuel Litres &amp; Breakdown Days</p>
          <form id="form_generate_bill" style="display:flex;flex-direction:column;gap:12px">
            <div style="display:grid;grid-template-columns:1.2fr 1.2fr 1fr auto;gap:8px;align-items:flex-end">
              <div id="gen_picker_wrap">
                ${assetPickerHtml('Vehicle / Machine Code *')}
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Site / Project</label>
                <select id="gen_project_id" class="input sm" style="width:100%">
                  ${buildSiteSelectOptionsHtml(catalog, '', { allowAll: true, allValue: '', allLabel: '-- Auto / Vehicle Site --', includeSubSites: false })}
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Billing Month *</label>
                <input type="month" id="gen_period" required class="input sm" value="${curYm}" style="width:100%">
              </div>
              <button type="button" class="btn sm primary" id="btn_gen_prefill">⚡ Auto-Fill</button>
            </div>

            <div id="gen_prefill_banner" style="display:none;padding:8px 12px;border-radius:6px;background:rgba(16,185,129,0.1);font-size:12px"></div>
            <div id="gen_bd_banner" style="display:none;padding:10px 12px;border-radius:6px;font-size:12px"></div>

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;font-weight:600">Billing Basis *</label>
                <select id="gen_billing_mode" class="input sm" style="width:100%">
                  <option value="DRY_WITH_DRIVER">DRY WITH DRIVER (Client Fuel)</option>
                  <option value="DRY">DRY (Machine Only, Client Fuel)</option>
                  <option value="WET">WET (Driver + Fuel Recharged)</option>
                  <option value="FULLY_WET">FULLY WET (Fuel Inclusive)</option>
                  <option value="FUEL_ONLY">FUEL ONLY (Fuel Recharge)</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Rate Unit</label>
                <select id="gen_rate_basis" class="input sm" style="width:100%">
                  <option value="HOURLY">HOURLY (Rs/hr)</option>
                  <option value="DAILY">DAILY (Rs/day)</option>
                  <option value="KM">KM (Rs/km)</option>
                  <option value="MONTHLY">MONTHLY</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Tariff Rate (Rs / Unit) *</label>
                <input type="number" step="1" id="gen_rate_rs" required class="input sm" placeholder="2000" style="width:100%">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;font-weight:600">Actual Units Worked *</label>
                <input type="number" step="0.1" id="gen_actual_units" required class="input sm" placeholder="Hours / KM" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Min Guarantee Units</label>
                <input type="number" step="0.1" id="gen_min_units" class="input sm" value="0" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Breakdown Days</label>
                <input type="number" step="0.5" id="gen_breakdown_days" class="input sm" value="0" style="width:100%">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:10px">
              <div>
                <label style="font-size:11px;font-weight:600">Issued Fuel in Month (Litres)</label>
                <input type="number" step="0.1" id="gen_fuel_litres" class="input sm" value="0" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Fuel Rate (Rs / L)</label>
                <input type="number" step="0.01" min="0" id="gen_fuel_price_rs" class="input sm" placeholder="Auto by tariff" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Notes / Contract Ref</label>
                <input type="text" id="gen_notes" class="input sm" placeholder="Monthly hire invoice" style="width:100%">
              </div>
            </div>

            <div style="background:rgba(0,102,255,0.06);border:1px solid rgba(0,102,255,0.2);padding:10px;border-radius:8px;font-size:12px">
              ℹ️ Monthly baseline: <b>25 working days</b> (<b>120 hr</b> Hourly / <b>3,000 km</b> Per-KM). Computes <b>Rental + Fuel Recharge − Breakdown Deduction (days/25) + SSCL 2.5% + VAT 18%</b>. Machines with an open breakdown cannot be billed.
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
              <button type="button" class="btn" id="btn_cancel_gen">Cancel</button>
              <button type="submit" class="btn primary" id="btn_submit_gen">Generate Bill</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modalEl);

      let prefilledProjectId = null;
      let prefilledOpenMeter = null;
      let prefilledCloseMeter = null;
      let prefilledRateCard = null;

      function updateRateRsFromPrefill() {
        if (!prefilledRateCard) return;
        const rc = prefilledRateCard;
        const bm = modalEl.querySelector('#gen_billing_mode').value;
        const rb = modalEl.querySelector('#gen_rate_basis').value;
        let dryC = rc.dry_rate_cents || rc.rate_cents || 0;
        let wetC = rc.wet_rate_cents || dryC;
        let fwC = rc.fully_wet_rate_cents || wetC;
        if (rb === 'KM' && rc.km_dry_cents) {
          dryC = rc.km_dry_cents;
          wetC = rc.km_wet_cents || dryC;
          fwC = rc.km_fw_cents || wetC;
        } else if (rb === 'HOURLY' && rc.hr_dry_cents) {
          dryC = rc.hr_dry_cents;
          wetC = rc.hr_wet_cents || dryC;
          fwC = rc.hr_fw_cents || wetC;
        }
        const picked = bm === 'FUEL_ONLY' ? 0 : (bm === 'FULLY_WET' ? fwC : (bm === 'WET' ? wetC : dryC));
        modalEl.querySelector('#gen_rate_rs').value = Math.round((picked || 0) / 100);
      }

      async function runPrefill(codeOverride) {
        const assetInp = qs('#gen_picker_wrap input[name="asset"]', modalEl);
        const code = (codeOverride || (assetInp ? assetInp.value : '')).trim();
        const ymVal = modalEl.querySelector('#gen_period').value || curYm;
        const [y, m] = ymVal.split('-').map(Number);
        const selProjId = modalEl.querySelector('#gen_project_id').value;
        if (!code) return notify('Select or enter a vehicle code first');
        try {
          const p = await api(`/hire/bills/prefill?assetCode=${encodeURIComponent(code)}&year=${y}&month=${m}${selProjId ? `&projectId=${encodeURIComponent(selProjId)}` : ''}`);
          prefilledProjectId = p.projectId;
          prefilledRateCard = p.rateCard || null;
          if (!selProjId && p.projectId) {
            modalEl.querySelector('#gen_project_id').value = String(p.projectId);
          }
          prefilledOpenMeter = p.openingMeter;
          prefilledCloseMeter = p.closingMeter;

          const modeSel = modalEl.querySelector('#gen_billing_mode');
          const wantedMode = p.billingMode || 'DRY_WITH_DRIVER';
          if ([...modeSel.options].some((o) => o.value === wantedMode)) modeSel.value = wantedMode;
          modalEl.querySelector('#gen_rate_basis').value = p.rateBasis || 'HOURLY';
          modalEl.querySelector('#gen_rate_rs').value = Math.round((p.rateCents || 0) / 100);
          modalEl.querySelector('#gen_actual_units').value = p.actualUnits || p.minBillHours || (p.rateBasis === 'KM' ? 3000 : 120);
          modalEl.querySelector('#gen_min_units').value = p.minBillHours || (p.rateBasis === 'KM' ? 3000 : (p.rateBasis === 'HOURLY' ? 120 : 0));
          modalEl.querySelector('#gen_fuel_litres').value = p.fuelLitres || 0;
          modalEl.querySelector('#gen_fuel_price_rs').value = p.fuelPriceCents ? (Number(p.fuelPriceCents) / 100).toFixed(2) : '';
          modalEl.querySelector('#gen_breakdown_days').value = p.breakdownDays || 0;

          const ban = modalEl.querySelector('#gen_prefill_banner');
          ban.style.display = 'block';
          const rateTxt = p.fuelPriceCents ? ` @ Rs ${(Number(p.fuelPriceCents) / 100).toFixed(2)}/L` : '';
          const unitBadge = p.rateBasis === 'KM' ? 'Per-KM (Rs/km)' : (p.rateBasis || 'HOURLY');
          ban.innerHTML = `✅ <b>${esc(p.asset.code)}</b> (${esc(p.asset.category || '')}) · Unit: <b>${esc(unitBadge)}</b> · Site: <b>${esc(p.projectName || 'Central')}</b> · Alloc Days: <b>${p.siteOverlapDays || p.daysInMonth}d</b> · Meter Span: <b>${p.openingMeter ?? '—'} → ${p.closingMeter ?? '—'} (+${p.actualUnits})</b> · Fuel: <b>${p.fuelLitres} L${rateTxt}</b>`;

          const bdBan = modalEl.querySelector('#gen_bd_banner');
          const subBtn = modalEl.querySelector('#btn_submit_gen');
          if (p.billingBlocked || p.fullMonthDown) {
            bdBan.style.display = 'block';
            bdBan.style.background = 'rgba(220,38,38,0.12)';
            bdBan.style.border = '1px solid rgba(220,38,38,0.35)';
            bdBan.style.color = '#b91c1c';
            bdBan.innerHTML = `🚫 <b>BILLING BLOCKED:</b> ${esc(p.blockReason)} <a href="#/hire-billing?tab=breakdowns" id="gen_open_bd_link" style="text-decoration:underline;font-weight:700">Open Breakdown Monitoring →</a>`;
            const bdLink = bdBan.querySelector('#gen_open_bd_link');
            if (bdLink) bdLink.addEventListener('click', () => modalEl.remove());
            subBtn.disabled = true;
          } else if (p.breakdownDays > 0) {
            bdBan.style.display = 'block';
            bdBan.style.background = 'rgba(245,158,11,0.12)';
            bdBan.style.border = '1px solid rgba(245,158,11,0.35)';
            bdBan.style.color = '#92400e';
            bdBan.innerHTML = `⚠️ <b>Breakdown Deduction Active:</b> ${p.breakdownDays} breakdown day(s) recorded in ${esc(p.periodKey)} will be deducted from rental.`;
            subBtn.disabled = false;
          } else {
            bdBan.style.display = 'none';
            subBtn.disabled = false;
          }
        } catch (err) {
          notify('Prefill lookup: ' + err.message);
        }
      }

      (async () => {
        try {
          const ym = modalEl.querySelector('#gen_period').value || curYm;
          const [y, m] = ym.split('-').map(Number);
          const endDt = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
          const r = await api(`/fuel/prices/lookup?fuelType=AUTO_DIESEL&date=${encodeURIComponent(endDt)}`);
          const fpInp = modalEl.querySelector('#gen_fuel_price_rs');
          if (fpInp && !fpInp.value && r && r.pricePerLitreCents > 0) {
            fpInp.value = (r.pricePerLitreCents / 100).toFixed(2);
          }
        } catch (_) {}
      })();

      wireAssetPicker(qs('#gen_picker_wrap', modalEl), (_id, code) => runPrefill(code));
      modalEl.querySelector('#btn_gen_prefill').onclick = () => runPrefill();
      modalEl.querySelector('#gen_billing_mode').addEventListener('change', updateRateRsFromPrefill);
      modalEl.querySelector('#gen_rate_basis').addEventListener('change', updateRateRsFromPrefill);

      modalEl.querySelector('#btn_cancel_gen').onclick = () => modalEl.remove();
      modalEl.onclick = (e) => { if (e.target === modalEl) modalEl.remove(); };

      modalEl.querySelector('#form_generate_bill').onsubmit = async (e) => {
        e.preventDefault();
        const assetInp = qs('#gen_picker_wrap input[name="asset"]', modalEl);
        const assetIdInp = qs('#gen_picker_wrap input[name="asset_id"]', modalEl);
        const codeVal = (assetInp ? assetInp.value : '').trim();
        const idVal = assetIdInp && assetIdInp.value ? Number(assetIdInp.value) : null;
        if (!codeVal && !idVal) return notify('Select a vehicle code');
        const ymVal = modalEl.querySelector('#gen_period').value || curYm;
        const [y, m] = ymVal.split('-').map(Number);
        const chosenProjId = modalEl.querySelector('#gen_project_id').value
          ? Number(modalEl.querySelector('#gen_project_id').value)
          : prefilledProjectId;
        const rawGenFuelRs = modalEl.querySelector('#gen_fuel_price_rs').value.trim();
        const genFuelPriceCents = rawGenFuelRs !== '' && Number(rawGenFuelRs) > 0 ? Math.round(Number(rawGenFuelRs) * 100) : null;
        try {
          const res = await api('/hire/bills/generate', {
            method: 'POST',
            body: {
              assetId: idVal,
              assetCode: codeVal,
              year: y,
              month: m,
              billingMode: modalEl.querySelector('#gen_billing_mode').value,
              rateBasis: modalEl.querySelector('#gen_rate_basis').value,
              rateCents: Math.round(Number(modalEl.querySelector('#gen_rate_rs').value) * 100),
              actualUnits: Number(modalEl.querySelector('#gen_actual_units').value),
              minBillHours: Number(modalEl.querySelector('#gen_min_units').value) || 0,
              fuelLitres: Number(modalEl.querySelector('#gen_fuel_litres').value) || 0,
              fuelPriceCents: genFuelPriceCents,
              breakdownDays: Number(modalEl.querySelector('#gen_breakdown_days').value) || 0,
              projectId: chosenProjId,
              openingMeter: prefilledOpenMeter,
              closingMeter: prefilledCloseMeter,
              notes: modalEl.querySelector('#gen_notes').value.trim(),
            },
          });
          toast(`Bill generated! Grand Total: ${fmtCents(res.calculation.grandTotalCents)}`);
          modalEl.remove();
          if (typeof onDone === 'function') onDone();
        } catch (err) {
          notify(err.message);
        }
      };
    }

    // =========================================================================
    // TAB 1: RENTAL BILLS & REVISIONS (Site-wise & Monthly-wise)
    // =========================================================================
    async function renderBillsTab(box) {
      const catalog = await loadSitesCatalog();
      const years = [curYear + 1, curYear, curYear - 1, 2025].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b - a);
      box.innerHTML = `
        <div class="card" style="padding:12px;margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="bill_search" placeholder="Search invoice #, vehicle code, site..." class="input sm" style="flex:1;min-width:170px">
          <select id="bill_proj" class="input sm" style="min-width:190px">
            ${buildSiteSelectOptionsHtml(catalog, '', { allowAll: true, allValue: '', allLabel: 'All Sites / Projects', includeSubSites: false })}
          </select>
          <select id="bill_year" class="input sm">
            <option value="">All Years</option>
            ${years.map((y) => `<option value="${y}" ${y === curYear ? 'selected' : ''}>${y}</option>`).join('')}
          </select>
          <select id="bill_month" class="input sm">
            <option value="">All Months</option>
            ${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === curMonth ? 'selected' : ''}>${new Date(2026, i).toLocaleString('en', { month: 'long' })}</option>`).join('')}
          </select>
          <select id="bill_status" class="input sm">
            <option value="">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="FINAL">Final</option>
            <option value="PAID">Paid</option>
          </select>
          <button class="btn sm primary" id="btn_bill_filter">Filter</button>
          <button class="btn sm" id="btn_bill_all_periods" title="Clear Year/Month filter to view all periods">All Periods</button>
        </div>

        <div id="bill_kpis" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(165px, 1fr));gap:10px;margin-bottom:12px"></div>
        <div id="bill_unrated_alert" style="display:none;margin-bottom:12px"></div>

        <div id="bill_site_summary_wrap" class="card" style="padding:0;overflow-x:auto;margin-bottom:14px;display:none">
          <div style="padding:10px 12px;background:rgba(37,99,235,0.05);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <div style="font-size:12.5px;font-weight:700">🏢 Site &amp; Month Billing Summary (Open 🧾 Site Summary Bill or batch-bill remaining machines)</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn sm" id="btn_bill_site_summary" style="background:#0f172a;color:#fff;border-color:#0f172a">🧾 Site Summary Bill</button>
              <button class="btn sm" id="btn_bill_site_now">🏢 + Generate for Selected Site &amp; Month</button>
            </div>
          </div>
          <table class="table" style="width:100%;margin:0;font-size:12px">
            <thead>
              <tr>
                <th style="padding:8px 12px">Month</th>
                <th style="padding:8px 12px">Project / Site</th>
                <th style="padding:8px 12px;text-align:center">Bills</th>
                <th style="padding:8px 12px;text-align:right">Rental</th>
                <th style="padding:8px 12px;text-align:right">Breakdown Ded.</th>
                <th style="padding:8px 12px;text-align:right">Fuel</th>
                <th style="padding:8px 12px;text-align:right">Grand Total</th>
                <th style="padding:8px 12px;text-align:right">Balance Due</th>
                <th style="padding:8px 12px;text-align:center">Actions</th>
              </tr>
            </thead>
            <tbody id="bill_site_summary_tbody"></tbody>
          </table>
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:12.5px">
            <thead>
              <tr style="background:rgba(0,0,0,0.02)">
                <th style="padding:10px 12px">Period</th>
                <th style="padding:10px 12px">Invoice #</th>
                <th style="padding:10px 12px">Vehicle</th>
                <th style="padding:10px 12px">Project / Site</th>
                <th style="padding:10px 12px">Mode</th>
                <th style="padding:10px 12px;text-align:right">Billable Units</th>
                <th style="padding:10px 12px;text-align:right">Rental Amt</th>
                <th style="padding:10px 12px;text-align:right">Breakdown Ded.</th>
                <th style="padding:10px 12px;text-align:right">Fuel Recharge</th>
                <th style="padding:10px 12px;text-align:right">Grand Total</th>
                <th style="padding:10px 12px;text-align:right">Balance Due</th>
                <th style="padding:10px 12px;text-align:center">Status</th>
                <th style="padding:10px 12px;text-align:center">Actions</th>
              </tr>
            </thead>
            <tbody id="bills_tbody">
              <tr><td colspan="13" style="padding:24px;text-align:center" class="muted">Loading rental bills...</td></tr>
            </tbody>
          </table>
        </div>
      `;

      async function loadBills() {
        const q = new URLSearchParams({ limit: 200 });
        const s = qs('#bill_search', box).value.trim();
        const pid = qs('#bill_proj', box).value;
        const y = qs('#bill_year', box).value;
        const m = qs('#bill_month', box).value;
        const st = qs('#bill_status', box).value;
        if (s) q.set('search', s);
        if (pid) q.set('projectId', pid);
        if (y) q.set('year', y);
        if (m) q.set('month', m);
        if (st) q.set('status', st);

        const tbody = qs('#bills_tbody', box);
        const sumWrap = qs('#bill_site_summary_wrap', box);
        const sumBody = qs('#bill_site_summary_tbody', box);
        const kpiEl = qs('#bill_kpis', box);

        try {
          const res = await api(`/hire/bills?${q.toString()}`);
          const bills = res.bills || [];
          const ov = res.overallSummary || {};
          const smRows = res.summaryBySiteMonth || [];

          kpiEl.innerHTML = `
            <div class="card" style="padding:10px 12px;border-left:4px solid #2563eb"><div class="muted" style="font-size:11px;font-weight:700">BILLS (${ov.sitesCount || 0} SITES)</div><div style="font-size:19px;font-weight:800;margin-top:2px">${ov.totalCount ?? bills.length}</div></div>
            <div class="card" style="padding:10px 12px;border-left:4px solid #059669"><div class="muted" style="font-size:11px;font-weight:700">RENTAL TOTAL</div><div style="font-size:17px;font-weight:800;margin-top:2px">${fmtCents(ov.rentalCents || 0)}</div></div>
            <div class="card" style="padding:10px 12px;border-left:4px solid #dc2626"><div class="muted" style="font-size:11px;font-weight:700">BREAKDOWN DEDUCTED</div><div style="font-size:17px;font-weight:800;color:#dc2626;margin-top:2px">-${fmtCents(ov.breakdownDeductCents || 0)}</div></div>
            <div class="card" style="padding:10px 12px;border-left:4px solid #7c3aed"><div class="muted" style="font-size:11px;font-weight:700">GRAND TOTAL (INCL. TAX)</div><div style="font-size:17px;font-weight:800;color:#2563eb;margin-top:2px">${fmtCents(ov.grandTotalCents || 0)}</div></div>
            <div class="card" style="padding:10px 12px;border-left:4px solid #d97706"><div class="muted" style="font-size:11px;font-weight:700">BALANCE DUE</div><div style="font-size:17px;font-weight:800;color:#d97706;margin-top:2px">${fmtCents(ov.balanceCents || 0)}</div></div>
          `;

          if (smRows.length > 0) {
            const canFinalise = (typeof isAdmin === 'function' && isAdmin()) ||
              (typeof canDo === 'function' && (canDo('hire.billing.finalise') || canDo('costing.manage')));
            sumWrap.style.display = 'block';
            sumBody.innerHTML = smRows.slice(0, 60).map((sm) => {
              const lockTip = sm.is_locked
                ? `Locked (${sm.lock_scope || 'SITE'})${sm.locked_by_name ? ' by ' + sm.locked_by_name : ''}${sm.lock_reason ? ': ' + sm.lock_reason : ''}`
                : '';
              const lockBadge = sm.is_locked
                ? ` <span class="badge" style="background:#334155;color:#fff;font-size:10px;margin-left:4px" title="${esc(lockTip)}">🔒 Locked</span>`
                : '';
              return `
              <tr>
                <td style="padding:7px 12px;white-space:nowrap"><b>${esc(sm.period_key)}</b>${lockBadge}</td>
                <td style="padding:7px 12px"><b>${esc(sm.project_name)}</b>${sm.project_code ? ` <span class="muted">(${esc(sm.project_code)})</span>` : ''}</td>
                <td style="padding:7px 12px;text-align:center"><span class="badge">${sm.bill_count}</span> <span class="muted" style="font-size:10px">(${sm.final_count}F / ${sm.draft_count}D)</span></td>
                <td style="padding:7px 12px;text-align:right">${fmtCents(sm.rental_cents)}</td>
                <td style="padding:7px 12px;text-align:right;color:${sm.breakdown_deduct_cents > 0 ? '#dc2626' : 'var(--muted)'}">${sm.breakdown_deduct_cents > 0 ? '-' + fmtCents(sm.breakdown_deduct_cents) : '—'}</td>
                <td style="padding:7px 12px;text-align:right">${fmtCents(sm.fuel_cents)}</td>
                <td style="padding:7px 12px;text-align:right;font-weight:700">${fmtCents(sm.grand_total_cents)}</td>
                <td style="padding:7px 12px;text-align:right;font-weight:700;color:${sm.balance_cents > 0 ? '#d97706' : '#059669'}">${fmtCents(sm.balance_cents)}</td>
                <td style="padding:7px 12px;text-align:center;white-space:nowrap">
                  <button class="btn sm btn-sm-summary" data-pid="${sm.project_id || ''}" data-ym="${esc(sm.period_key)}" style="background:#0f172a;color:#fff;border-color:#0f172a">🧾 Summary</button>
                  <button class="btn sm btn-sm-pdf" data-pid="${sm.project_id || ''}" data-ym="${esc(sm.period_key)}" style="margin-left:3px;background:#b45309;color:#fff;border-color:#b45309" title="Download Site Summary PDF">📄 PDF</button>
                  <button class="btn sm btn-sm-filter" data-pid="${sm.project_id || ''}" data-y="${sm.year}" data-m="${sm.month}" style="margin-left:3px">Inspect</button>
                  <button class="btn sm primary btn-sm-bill" data-pid="${sm.project_id || 'ALL'}" data-ym="${esc(sm.period_key)}" style="margin-left:3px" ${sm.is_locked ? 'disabled title="Period is locked"' : ''}>+ Bill</button>
                  ${(canFinalise && sm.draft_count > 0 && !sm.is_locked) ? `<button class="btn sm btn-sm-finalise-site" data-pid="${sm.project_id || 'ALL'}" data-pname="${esc(sm.project_name)}" data-ym="${esc(sm.period_key)}" data-drafts="${sm.draft_count}" data-total="${sm.grand_total_cents || 0}" style="margin-left:3px;background:#059669;color:#fff;border-color:#059669">✓ Finalise Site</button>` : ''}
                  ${(canFinalise && sm.project_id) ? `<button class="btn sm btn-sm-lock-site" data-pid="${sm.project_id}" data-pname="${esc(sm.project_name)}" data-ym="${esc(sm.period_key)}" data-locked="${sm.is_locked ? '1' : '0'}" data-scope="${esc(sm.lock_scope || '')}" style="margin-left:3px" title="${sm.is_locked ? 'Unlock period' : 'Lock site-month'}">${sm.is_locked ? '🔓 Unlock' : '🔒 Lock'}</button>` : ''}
                </td>
              </tr>
            `;
            }).join('');

            qsa('.btn-sm-summary', sumBody).forEach((btn) => {
              btn.onclick = () => openSiteSummaryModal({
                defaultProjectId: btn.getAttribute('data-pid') || 'ALL',
                defaultMonth: btn.getAttribute('data-ym') || curYm,
              });
            });
            qsa('.btn-sm-pdf', sumBody).forEach((btn) => {
              btn.onclick = async () => {
                const pid = btn.getAttribute('data-pid') || 'ALL';
                const ym = btn.getAttribute('data-ym') || curYm;
                const url = `/api/hire/bills/site-summary/download.pdf?projectId=${encodeURIComponent(pid)}&month=${encodeURIComponent(ym)}`;
                const prevText = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'PDF...';
                try {
                  const res = await fetch(url);
                  if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}));
                    throw new Error(errBody.error || `PDF download failed (HTTP ${res.status})`);
                  }
                  const blob = await res.blob();
                  const blobUrl = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = blobUrl;
                  a.download = `site-summary-${pid}-${ym}.pdf`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
                } catch (e) {
                  notify(e.message || String(e));
                } finally {
                  btn.disabled = false;
                  btn.textContent = prevText;
                }
              };
            });
            qsa('.btn-sm-filter', sumBody).forEach((btn) => {
              btn.onclick = () => {
                qs('#bill_proj', box).value = btn.getAttribute('data-pid') || '';
                qs('#bill_year', box).value = btn.getAttribute('data-y') || '';
                qs('#bill_month', box).value = btn.getAttribute('data-m') || '';
                loadBills();
              };
            });
            qsa('.btn-sm-bill', sumBody).forEach((btn) => {
              btn.onclick = () => openGenerateSiteBillsModal({
                defaultProjectId: btn.getAttribute('data-pid') || 'ALL',
                defaultMonth: btn.getAttribute('data-ym') || curYm,
              });
            });
            qsa('.btn-sm-finalise-site', sumBody).forEach((btn) => {
              btn.onclick = () => {
                const pid = btn.getAttribute('data-pid') || 'ALL';
                const pname = btn.getAttribute('data-pname') || 'Site';
                const ym = btn.getAttribute('data-ym') || curYm;
                const drafts = Number(btn.getAttribute('data-drafts') || 0);
                const totalCents = Number(btn.getAttribute('data-total') || 0);

                const m = document.createElement('div');
                m.className = 'modal-bg modal-backdrop';
                m.innerHTML = `
                  <div class="modal card" style="max-width:460px;padding:22px">
                    <h2 style="margin:0 0 6px 0;font-size:18px">✓ Finalise Site Bills — ${esc(pname)}</h2>
                    <p class="muted" style="margin:0 0 12px 0;font-size:12.5px">
                      Converts <b>${drafts} DRAFT bill(s)</b> for <b>${esc(ym)}</b> (${fmtCents(totalCents)} total) to <b>FINAL</b> and posts revenue to Financial Costing.
                    </p>
                    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:10px;cursor:pointer">
                      <input type="checkbox" id="fs_lock_after" checked> Lock this site-month after finalising
                    </label>
                    <div style="margin-bottom:14px">
                      <label style="font-size:11.5px;font-weight:600">Lock / Finalisation Note</label>
                      <input type="text" id="fs_reason" class="input sm" value="Approved &amp; finalised for ${esc(ym)}" style="width:100%">
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:8px">
                      <button type="button" class="btn sm" id="btn_fs_cancel">Cancel</button>
                      <button type="button" class="btn sm primary" id="btn_fs_confirm" style="background:#059669;border-color:#059669">✓ Confirm Finalise Site</button>
                    </div>
                  </div>
                `;
                document.body.appendChild(m);
                m.querySelector('#btn_fs_cancel').onclick = () => m.remove();
                m.onclick = (e) => { if (e.target === m) m.remove(); };
                m.querySelector('#btn_fs_confirm').onclick = async () => {
                  const confirmBtn = m.querySelector('#btn_fs_confirm');
                  confirmBtn.disabled = true;
                  confirmBtn.textContent = 'Finalising...';
                  try {
                    const res = await api('/hire/bills/finalise-site', {
                      method: 'POST',
                      body: {
                        projectId: pid === 'ALL' ? 'ALL' : Number(pid),
                        periodKey: ym,
                        lockAfter: m.querySelector('#fs_lock_after').checked,
                        lockReason: m.querySelector('#fs_reason').value.trim() || null,
                      },
                    });
                    const skipNote = res.skippedBreakdowns && res.skippedBreakdowns.length
                      ? ` (${res.skippedBreakdowns.length} blocked by open breakdown)`
                      : '';
                    toast(`Finalised ${res.finalisedCount} bill(s) for ${pname}${res.locked ? ' & locked period' : ''}${skipNote}`);
                    m.remove();
                    loadBills();
                  } catch (err) {
                    notify(err.message);
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = '✓ Confirm Finalise Site';
                  }
                };
              };
            });
            qsa('.btn-sm-lock-site', sumBody).forEach((btn) => {
              btn.onclick = () => {
                const pid = Number(btn.getAttribute('data-pid') || 0);
                const pname = btn.getAttribute('data-pname') || 'Site';
                const ym = btn.getAttribute('data-ym') || curYm;
                const isLocked = btn.getAttribute('data-locked') === '1';
                const lockScope = btn.getAttribute('data-scope') || 'SITE';

                const m = document.createElement('div');
                m.className = 'modal-bg modal-backdrop';
                const targetPid = isLocked && lockScope === 'MONTH' ? 0 : pid;
                const scopeLabel = targetPid === 0 ? `ALL sites for ${ym}` : `${pname} (${ym})`;
                m.innerHTML = `
                  <div class="modal card" style="max-width:440px;padding:22px">
                    <h2 style="margin:0 0 6px 0;font-size:18px">${isLocked ? '🔓 Unlock Billing Period' : '🔒 Lock Billing Period'}</h2>
                    <p class="muted" style="margin:0 0 12px 0;font-size:12.5px">
                      ${isLocked
                        ? `Unlocking <b>${esc(scopeLabel)}</b> allows bill generation, revisions, and fuel re-pricing again.`
                        : `Locking <b>${esc(scopeLabel)}</b> prevents any bill generation, edits, finalisation, or retroactive fuel re-pricing.`}
                    </p>
                    <div style="margin-bottom:14px">
                      <label style="font-size:11.5px;font-weight:600">${isLocked ? 'Unlock Reason (Required for Audit) *' : 'Lock Note'}</label>
                      <input type="text" id="pl_reason" class="input sm" placeholder="${isLocked ? 'e.g. Late site meter correction approved' : 'e.g. Closed & signed by management'}" style="width:100%">
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:8px">
                      <button type="button" class="btn sm" id="btn_pl_cancel">Cancel</button>
                      <button type="button" class="btn sm primary" id="btn_pl_confirm">${isLocked ? '🔓 Unlock Period' : '🔒 Lock Period'}</button>
                    </div>
                  </div>
                `;
                document.body.appendChild(m);
                m.querySelector('#btn_pl_cancel').onclick = () => m.remove();
                m.onclick = (e) => { if (e.target === m) m.remove(); };
                m.querySelector('#btn_pl_confirm').onclick = async () => {
                  const reasonVal = m.querySelector('#pl_reason').value.trim();
                  if (isLocked && !reasonVal) {
                    notify('Unlock reason is required.');
                    return;
                  }
                  const confirmBtn = m.querySelector('#btn_pl_confirm');
                  confirmBtn.disabled = true;
                  try {
                    await api('/hire/period-locks', {
                      method: 'POST',
                      body: {
                        periodKey: ym,
                        projectId: targetPid,
                        locked: !isLocked,
                        reason: reasonVal,
                      },
                    });
                    toast(`${isLocked ? 'Unlocked' : 'Locked'} ${scopeLabel}`);
                    m.remove();
                    loadBills();
                  } catch (err) {
                    notify(err.message);
                    confirmBtn.disabled = false;
                  }
                };
              };
            });
          } else {
            sumWrap.style.display = 'none';
          }

          if (!bills.length) {
            tbody.innerHTML = '<tr><td colspan="13" style="padding:24px;text-align:center" class="muted">No rental bills found for this site/month filter. Click "🏢 + Bill by Site & Month" or "🔄 Sync Bills to Vehicle Costing P&L".</td></tr>';
            return;
          }

          tbody.innerHTML = bills.map((b) => {
            const stBadge = b.status === 'PAID'
              ? '<span class="badge ok">PAID</span>'
              : (b.status === 'FINAL' ? '<span class="badge primary">FINAL</span>' : '<span class="badge warn">DRAFT</span>');
            return `
              <tr>
                <td style="padding:9px 12px;white-space:nowrap">${esc(b.period_key)}</td>
                <td style="padding:9px 12px;font-family:monospace;font-weight:700">
                  ${esc(b.invoice_number || 'DRAFT')}
                  ${b.revision_count > 0 ? `<span class="badge" style="font-size:10px">Rev ${b.revision_count}</span>` : ''}
                </td>
                <td style="padding:9px 12px"><a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(b.asset_code)}" style="font-weight:700">${esc(b.asset_code)}</a></td>
                <td style="padding:9px 12px">${esc(b.project_name || 'Central')}</td>
                <td style="padding:9px 12px"><span class="badge">${esc(basisLabelText(b.billing_mode))} · ${esc(b.rate_basis || 'HOURLY')}</span></td>
                <td style="padding:9px 12px;text-align:right">${fmtNum(b.billable_units, 1)}</td>
                <td style="padding:9px 12px;text-align:right">${fmtCents(b.rental_amount_cents)}</td>
                <td style="padding:9px 12px;text-align:right;color:${b.breakdown_deduct_cents > 0 ? '#dc2626' : 'var(--muted)'}">${b.breakdown_deduct_cents > 0 ? `-${fmtCents(b.breakdown_deduct_cents)} (${b.breakdown_days}d)` : '—'}</td>
                <td style="padding:9px 12px;text-align:right">
                  <div>${fmtCents(b.fuel_cost_cents)}</div>
                  ${(b.fuel_cost_cents > 0 && b.fuel_price_cents)
                    ? `<div class="muted" style="font-size:10.5px">${fmtNum(b.fuel_litres, 1)} L @ Rs ${(Number(b.fuel_price_cents) / 100).toFixed(2)}/L</div>`
                    : ''}
                </td>
                <td style="padding:9px 12px;text-align:right;font-weight:800;color:var(--primary,#0066ff)">${fmtCents(b.grand_total_cents)}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:700;color:${b.balance_cents > 0 ? '#d97706' : '#059669'}">${fmtCents(b.balance_cents)}</td>
                <td style="padding:9px 12px;text-align:center">${stBadge}</td>
                <td style="padding:9px 12px;text-align:center;white-space:nowrap">
                  <button class="btn sm btn-bill-detail" data-id="${esc(b.id)}">🔍 Revise / Pay</button>
                  ${b.status === 'DRAFT' ? `<button class="btn sm primary btn-bill-final" data-id="${esc(b.id)}" style="margin-left:4px">Finalise</button>` : ''}
                </td>
              </tr>
            `;
          }).join('');

          qsa('.btn-bill-final', tbody).forEach((btn) => {
            btn.onclick = async () => {
              const id = btn.getAttribute('data-id');
              try {
                const r = await api(`/hire/bills/${id}/finalise`, { method: 'POST' });
                toast(`Bill finalised (${r.invoice_number})`);
                loadBills();
              } catch (err) {
                notify(err.message);
              }
            };
          });

          qsa('.btn-bill-detail', tbody).forEach((btn) => {
            btn.onclick = () => openBillDetailModal(btn.getAttribute('data-id'), loadBills);
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="13" class="err" style="padding:20px">${esc(err.message)}</td></tr>`;
        }
      }

      api('/hire/rates-unrated').then((u) => {
        const alertEl = qs('#bill_unrated_alert', box);
        if (!alertEl || !u || !u.recentFueledCount) return;
        const sampleCodes = (u.unrated || []).filter((x) => x.recent_litres > 0).slice(0, 6).map((x) => x.asset_code).join(', ');
        const extra = u.recentFueledCount > 6 ? ` +${u.recentFueledCount - 6} more` : '';
        alertEl.style.display = 'block';
        alertEl.innerHTML = `
          <div class="card" style="padding:10px 14px;background:rgba(217,119,6,0.08);border:1px solid rgba(217,119,6,0.35);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="font-size:12.5px">
              <b style="color:#b45309">⚠ ${u.recentFueledCount} active vehicle(s) drew fuel recently without a rate card</b>
              <span class="muted" style="margin-left:6px">(${esc(sampleCodes)}${esc(extra)})</span>
            </div>
            <button type="button" class="btn sm primary" id="btn_go_unrated_rates">Review &amp; Assign Rates →</button>
          </div>
        `;
        const goBtn = qs('#btn_go_unrated_rates', alertEl);
        if (goBtn) goBtn.onclick = () => switchTab('rates', { mode: 'UNRATED' });
      }).catch(() => {});

      qs('#btn_bill_filter', box).onclick = loadBills;
      qs('#bill_proj', box).onchange = loadBills;
      qs('#btn_bill_all_periods', box).onclick = () => {
        qs('#bill_year', box).value = '';
        qs('#bill_month', box).value = '';
        loadBills();
      };
      qs('#btn_bill_site_summary', box).onclick = () => {
        const y = qs('#bill_year', box).value || curYear;
        const m = qs('#bill_month', box).value || curMonth;
        openSiteSummaryModal({
          defaultProjectId: qs('#bill_proj', box).value || 'ALL',
          defaultMonth: `${y}-${String(m).padStart(2, '0')}`,
        });
      };
      qs('#btn_bill_site_now', box).onclick = () => {
        const y = qs('#bill_year', box).value || curYear;
        const m = qs('#bill_month', box).value || curMonth;
        openGenerateSiteBillsModal({
          defaultProjectId: qs('#bill_proj', box).value || 'ALL',
          defaultMonth: `${y}-${String(m).padStart(2, '0')}`,
        });
      };
      qs('#bill_search', box).onkeydown = (e) => { if (e.key === 'Enter') loadBills(); };
      loadBills();
    }

    async function openBillDetailModal(billId, onDone) {
      const data = await api(`/hire/bills/${billId}`);
      const b = data.bill;
      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:740px;width:95%;max-height:88vh;overflow-y:auto;padding:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div>
              <h2 style="margin:0">📑 Invoice ${esc(b.invoice_number || b.id)} — ${esc(b.asset_code)} (${esc(b.period_key)})</h2>
              <div class="muted" style="font-size:12px">Site: <b>${esc(b.project_name || 'Central')}</b> · Status: <b>${esc(b.status)}</b> · Grand Total: <b>${fmtCents(b.grand_total_cents)}</b> · Balance: <b>${fmtCents(b.balance_cents)}</b></div>
            </div>
            <button class="btn sm" id="btn_bd_close">✕ Close</button>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
            <div class="card" style="padding:14px">
              <h3 style="margin:0 0 8px 0;font-size:14px">✏️ Amend Bill &amp; Save Revision Snapshot</h3>
              <form id="form_revise_bill" style="display:flex;flex-direction:column;gap:8px">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                  <div>
                    <label style="font-size:11px;font-weight:600">Actual Units</label>
                    <input type="number" step="0.1" id="rv_units" class="input sm" value="${b.actual_units || 0}" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Rate (Rs / Unit)</label>
                    <input type="number" step="1" id="rv_rate" class="input sm" value="${Math.round((b.rate_cents || 0) / 100)}" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Fuel Litres</label>
                    <input type="number" step="0.1" id="rv_fuel" class="input sm" value="${b.fuel_litres || 0}" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Fuel Rate (Rs / L)</label>
                    <input type="number" step="0.01" min="0" id="rv_fuel_price" class="input sm" value="${b.fuel_price_cents ? (Number(b.fuel_price_cents) / 100).toFixed(2) : ''}" placeholder="Auto tariff" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Breakdown Days</label>
                    <input type="number" step="0.5" id="rv_bd" class="input sm" value="${b.breakdown_days || 0}" style="width:100%">
                  </div>
                </div>
                <input type="text" id="rv_reason" required class="input sm" placeholder="Reason for revision (e.g. Verified site log hours)" style="width:100%">
                <button type="submit" class="btn sm primary">Save Revision &amp; Recalculate</button>
              </form>
            </div>

            <div class="card" style="padding:14px">
              <h3 style="margin:0 0 8px 0;font-size:14px">💰 Record Client / Project Payment</h3>
              <form id="form_pay_bill" style="display:flex;flex-direction:column;gap:8px">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                  <div>
                    <label style="font-size:11px;font-weight:600">Amount (LKR) *</label>
                    <input type="number" step="0.01" id="py_amount" required class="input sm" value="${(b.balance_cents / 100).toFixed(2)}" style="width:100%">
                  </div>
                  <div>
                    <label style="font-size:11px;font-weight:600">Payment Date *</label>
                    <input type="date" id="py_date" required class="input sm" value="${currentTodayStr()}" style="width:100%">
                  </div>
                </div>
                <input type="text" id="py_ref" class="input sm" placeholder="Cheque / Bank Transfer Ref #" style="width:100%">
                <button type="submit" class="btn sm" style="background:#059669;color:#fff;border-color:#059669">Record Payment</button>
              </form>
            </div>
          </div>

          <h4 style="margin:8px 0 4px 0;font-size:13px">Revision History (${(data.revisions || []).length})</h4>
          <div style="font-size:12px;margin-bottom:10px">
            ${(data.revisions || []).length ? data.revisions.map((r) => `<div class="muted">• <b>Rev #${r.revision_number}</b> (${esc(String(r.created_at || '').slice(0, 16))} by ${esc(r.creator_name || 'User')}): ${esc(r.change_summary || r.reason || '')}</div>`).join('') : '<span class="muted">Original version (no revisions)</span>'}
          </div>

          <h4 style="margin:8px 0 4px 0;font-size:13px">Payments Received (${(data.payments || []).length})</h4>
          <div style="font-size:12px">
            ${(data.payments || []).length ? data.payments.map((p) => `<div class="muted">• <b>${fmtCents(p.amount_cents)}</b> on ${esc(p.paid_date)} (${esc(p.reference || p.method || 'Transfer')})</div>`).join('') : '<span class="muted">No payments recorded yet</span>'}
          </div>
        </div>
      `;
      document.body.appendChild(modalEl);
      modalEl.querySelector('#btn_bd_close').onclick = () => modalEl.remove();
      modalEl.onclick = (e) => { if (e.target === modalEl) modalEl.remove(); };

      modalEl.querySelector('#form_revise_bill').onsubmit = async (e) => {
        e.preventDefault();
        const rawRvFuelPrice = modalEl.querySelector('#rv_fuel_price').value.trim();
        const rvFuelPriceCents = rawRvFuelPrice !== '' && Number(rawRvFuelPrice) > 0 ? Math.round(Number(rawRvFuelPrice) * 100) : null;
        try {
          await api(`/hire/bills/${billId}/revise`, {
            method: 'POST',
            body: {
              actualUnits: Number(modalEl.querySelector('#rv_units').value),
              rateCents: Math.round(Number(modalEl.querySelector('#rv_rate').value) * 100),
              fuelLitres: Number(modalEl.querySelector('#rv_fuel').value),
              fuelPriceCents: rvFuelPriceCents,
              breakdownDays: Number(modalEl.querySelector('#rv_bd').value),
              reason: modalEl.querySelector('#rv_reason').value.trim(),
            },
          });
          toast('Bill revised and snapshot saved!');
          modalEl.remove();
          if (onDone) onDone();
        } catch (err) {
          notify(err.message);
        }
      };

      modalEl.querySelector('#form_pay_bill').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(`/hire/bills/${billId}/payments`, {
            method: 'POST',
            body: {
              amountLkr: Number(modalEl.querySelector('#py_amount').value),
              paidDate: modalEl.querySelector('#py_date').value,
              reference: modalEl.querySelector('#py_ref').value.trim(),
            },
          });
          toast('Payment recorded!');
          modalEl.remove();
          if (onDone) onDone();
        } catch (err) {
          notify(err.message);
        }
      };
    }

    // =========================================================================
    // TAB 2: RATE CARDS, PORTABLE PLANT & CONSUMPTION BANDS (L/hr Hourly vs km/L Per-KM)
    // =========================================================================
    async function renderRatesTab(box) {
      let mode = initialRatesMode || 'HR';
      initialRatesMode = null;
      let searchQ = '';
      let catFilter = '';

      box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Machinery (L/hr Hourly Rates), Road Vehicles (km/L Per-KM Rates) &amp; Standard Bands...</div>`;

      try {
        const [data, unratedData] = await Promise.all([
          api('/hire/rates-overview'),
          api('/hire/rates-unrated').catch(() => ({ unrated: [], templates: [], recentFueledCount: 0, totalUnratedCount: 0 })),
        ]);
        const unratedList = (unratedData && unratedData.unrated) || [];
        const templatesList = (unratedData && unratedData.templates) || [];
        const fleet = data.fleet || [];
        const machineryHr = data.machinery_hr || fleet.filter((r) => (r.cons_basis || (r.display_unit === 'km/L' ? 'km' : 'hr')) === 'hr');
        const vehiclesKm = data.vehicles_km || fleet.filter((r) => (r.cons_basis || (r.display_unit === 'km/L' ? 'km' : 'hr')) === 'km');
        const portable = data.portable || [];
        const summary = data.summary || {};
        const catsHr = data.categories_hr || [...new Set(machineryHr.map((r) => r.category).filter(Boolean))].sort();
        const catsKm = data.categories_km || [...new Set(vehiclesKm.map((r) => r.category).filter(Boolean))].sort();
        const catsAll = data.categories || [];
        const canManageRates = (typeof isAdmin === 'function' && isAdmin()) || (typeof canDo === 'function' && (canDo('hire.rates.manage') || canDo('costing.manage')));

        box.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:12px">
            <div class="card" style="padding:10px 14px;border-left:4px solid #0284c7">
              <div class="muted" style="font-size:11px">Machinery &amp; Plant (L/hr · Hourly Rate)</div>
              <div style="font-size:20px;font-weight:800;color:#0369a1">${machineryHr.length} <span class="muted" style="font-size:12px;font-weight:500">${catsHr.length} categories</span></div>
            </div>
            <div class="card" style="padding:10px 14px;border-left:4px solid #059669">
              <div class="muted" style="font-size:11px">Road Vehicles (km/L · Per-KM Rate)</div>
              <div style="font-size:20px;font-weight:800;color:#047857">${vehiclesKm.length} <span class="muted" style="font-size:12px;font-weight:500">${catsKm.length} categories</span></div>
            </div>
            <div class="card" style="padding:10px 14px;border-left:4px solid #7c3aed">
              <div class="muted" style="font-size:11px">Portable Plant (Daily Rate)</div>
              <div style="font-size:20px;font-weight:800;color:#6d28d9">${portable.length} <span class="muted" style="font-size:12px;font-weight:500">classes</span></div>
            </div>
            <div class="card" style="padding:10px 14px;border-left:4px solid #d97706">
              <div class="muted" style="font-size:11px">Standard Bands Configured</div>
              <div style="font-size:20px;font-weight:800">${summary.withConsumptionBands || fleet.filter((r) => r.fuel_cons_typ > 0).length} <span class="muted" style="font-size:12px;font-weight:500">of ${fleet.length}</span></div>
            </div>
          </div>
          <div class="card" style="padding:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="btn sm primary" id="btn_rt_hr">🚜 L/hr · Hourly Rate (${machineryHr.length})</button>
              <button type="button" class="btn sm" id="btn_rt_km">🚛 km/L · Per-KM Rate (${vehiclesKm.length})</button>
              <button type="button" class="btn sm" id="btn_rt_port">🧰 Portable Plant · Daily (${portable.length})</button>
              <button type="button" class="btn sm" id="btn_rt_all">📋 All Fleet (${fleet.length})</button>
              <button type="button" class="btn sm" id="btn_rt_unrated">⚠ Unrated Active (${unratedList.length})</button>
              ${canManageRates ? '<button type="button" class="btn sm" id="btn_rt_add">+ Add Rate Card</button>' : ''}
            </div>
            <div id="rt_fleet_filters" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input type="text" id="rt_search" placeholder="Search vehicle code, reg, brand, model..." class="input sm" style="min-width:220px">
              <select id="rt_cat" class="input sm">
                <option value="">All Categories</option>
              </select>
            </div>
          </div>
          <div id="rt_section_note" class="muted" style="font-size:12px;margin-bottom:8px"></div>
          <div id="rt_table_wrap"></div>
        `;

        function syncCategoryOptions() {
          const catSel = qs('#rt_cat', box);
          const list = mode === 'HR' ? catsHr : (mode === 'KM' ? catsKm : catsAll);
          const cur = catFilter && list.includes(catFilter) ? catFilter : '';
          catFilter = cur;
          catSel.innerHTML = '<option value="">All Categories</option>' +
            list.map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
        }

        function drawTable() {
          qs('#btn_rt_hr', box).classList.toggle('primary', mode === 'HR');
          qs('#btn_rt_km', box).classList.toggle('primary', mode === 'KM');
          qs('#btn_rt_port', box).classList.toggle('primary', mode === 'PORTABLE');
          qs('#btn_rt_all', box).classList.toggle('primary', mode === 'ALL');
          if (qs('#btn_rt_unrated', box)) qs('#btn_rt_unrated', box).classList.toggle('primary', mode === 'UNRATED');
          qs('#rt_fleet_filters', box).style.display = 'flex';
          qs('#rt_cat', box).style.display = (mode === 'PORTABLE' || mode === 'UNRATED') ? 'none' : '';
          syncCategoryOptions();

          const noteEl = qs('#rt_section_note', box);
          const wrap = qs('#rt_table_wrap', box);
          if (mode === 'UNRATED') {
            noteEl.textContent = `Active owned registered machines missing a rate card (${unratedData.recentFueledCount || 0} drew fuel in the last 60 days). Assign a category template or mark hired/outside-billed vehicles.`;
            const filteredUnrated = unratedList.filter((u) => {
              if (!searchQ) return true;
              const q = searchQ.toUpperCase();
              return String(u.asset_code || '').toUpperCase().includes(q) ||
                String(u.registration || '').toUpperCase().includes(q) ||
                String(u.brand || '').toUpperCase().includes(q) ||
                String(u.type || '').toUpperCase().includes(q) ||
                String(u.current_site_name || '').toUpperCase().includes(q);
            });

            wrap.innerHTML = `
              <div class="card" style="padding:0;overflow-x:auto">
                <table class="table" style="width:100%;margin:0;font-size:12.5px">
                  <thead>
                    <tr style="background:rgba(0,0,0,0.02)">
                      <th style="padding:10px 12px">Vehicle</th>
                      <th style="padding:10px 12px">Brand / Type</th>
                      <th style="padding:10px 12px">Last Site</th>
                      <th style="padding:10px 12px;text-align:right">Recent Fuel (60d)</th>
                      <th style="padding:10px 12px;text-align:right">All-Time Fuel</th>
                      <th style="padding:10px 12px">Assign Category Template</th>
                      <th style="padding:10px 12px;text-align:center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filteredUnrated.length ? filteredUnrated.map((u, idx) => {
                      const typeLower = String(u.type || '').toLowerCase();
                      const tplOpts = templatesList.map((t) => {
                        const sel = typeLower && String(t.category || '').toLowerCase() === typeLower ? 'selected' : '';
                        const unitLbl = t.rate_basis === 'KM' ? 'Rs/km' : (t.rate_basis === 'DAILY' ? 'Rs/d' : 'Rs/hr');
                        return `<option value="${esc(t.template_rate_id)}" ${sel}>${esc(t.category)} · ${esc(t.rate_basis)} (Dry Rs ${Math.round((t.dry_rate_cents || 0) / 100)} / Wet Rs ${Math.round((t.wet_rate_cents || 0) / 100)} ${unitLbl})</option>`;
                      }).join('');
                      return `
                        <tr>
                          <td style="padding:9px 12px">
                            <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(u.asset_code)}" style="font-weight:700">${esc(u.asset_code)}</a>
                            ${u.registration ? `<div class="muted" style="font-size:11px">${esc(u.registration)}</div>` : ''}
                          </td>
                          <td style="padding:9px 12px">
                            <div>${esc([u.brand, u.model_no].filter(Boolean).join(' ') || '—')}</div>
                            <div class="muted" style="font-size:11px">${esc(u.type || 'Uncategorized')}</div>
                          </td>
                          <td style="padding:9px 12px">
                            <div>${esc(u.current_site_name || '—')}</div>
                            ${u.last_fuel_date ? `<div class="muted" style="font-size:11px">Last fuel ${esc(u.last_fuel_date)}</div>` : ''}
                          </td>
                          <td style="padding:9px 12px;text-align:right;font-weight:${u.recent_litres > 0 ? '700' : '400'};color:${u.recent_litres > 0 ? '#b45309' : 'var(--muted)'}">
                            ${u.recent_litres > 0 ? `${fmtNum(u.recent_litres, 1)} L (${u.recent_slips})` : '0 L'}
                          </td>
                          <td style="padding:9px 12px;text-align:right">${u.total_litres > 0 ? `${fmtNum(u.total_litres, 1)} L (${u.total_slips})` : '—'}</td>
                          <td style="padding:9px 12px;min-width:250px">
                            <select class="input sm sel-unrated-tpl" data-idx="${idx}" style="width:100%">
                              ${tplOpts || '<option value="">No templates available</option>'}
                            </select>
                          </td>
                          <td style="padding:9px 12px;text-align:center;white-space:nowrap">
                            ${canManageRates ? `
                              <button type="button" class="btn sm primary btn-unrated-assign" data-idx="${idx}">✓ Assign</button>
                              <button type="button" class="btn sm btn-unrated-custom" data-idx="${idx}" style="margin-left:3px">Custom</button>
                              <button type="button" class="btn sm btn-unrated-hired" data-idx="${idx}" style="margin-left:3px" title="Mark vehicle as Hired / Outside-Billed">Hired</button>
                            ` : '<span class="muted" style="font-size:11px">View only</span>'}
                          </td>
                        </tr>
                      `;
                    }).join('') : '<tr><td colspan="7" class="muted" style="padding:20px;text-align:center">No unrated active machines found!</td></tr>'}
                  </tbody>
                </table>
              </div>
            `;

            qsa('.btn-unrated-assign', wrap).forEach((btn) => {
              btn.onclick = async () => {
                const idx = Number(btn.getAttribute('data-idx'));
                const u = filteredUnrated[idx];
                const sel = qs(`.sel-unrated-tpl[data-idx="${idx}"]`, wrap);
                const tplId = sel ? sel.value : '';
                if (!u || !tplId) {
                  notify('Please choose a category template first.');
                  return;
                }
                btn.disabled = true;
                try {
                  const res = await api('/hire/rates/assign-template', {
                    method: 'POST',
                    body: { assetId: u.asset_id, templateRateId: tplId },
                  });
                  toast(`Assigned ${res.categoryName || 'template'} rate to ${u.asset_code}`);
                  initialRatesMode = 'UNRATED';
                  renderRatesTab(box);
                } catch (err) {
                  notify(err.message);
                  btn.disabled = false;
                }
              };
            });

            qsa('.btn-unrated-custom', wrap).forEach((btn) => {
              btn.onclick = () => {
                const u = filteredUnrated[Number(btn.getAttribute('data-idx'))];
                if (!u) return;
                const consHint = String(u.meter_type || '').toUpperCase() === 'KM' ? 'km' : 'hr';
                openAddRateModal(consHint, () => {
                  initialRatesMode = 'UNRATED';
                  renderRatesTab(box);
                }, { assetId: u.asset_id, assetCode: u.asset_code });
              };
            });

            qsa('.btn-unrated-hired', wrap).forEach((btn) => {
              btn.onclick = () => {
                const u = filteredUnrated[Number(btn.getAttribute('data-idx'))];
                if (!u) return;
                const m = document.createElement('div');
                m.className = 'modal-bg modal-backdrop';
                m.innerHTML = `
                  <div class="modal card" style="max-width:440px;padding:22px">
                    <h2 style="margin:0 0 6px 0;font-size:18px">Mark ${esc(u.asset_code)} as Hired / Outside-Billed</h2>
                    <p class="muted" style="margin:0 0 12px 0;font-size:12.5px">
                      Removes <b>${esc(u.asset_code)}</b> from the owned rate register and voids any unlocked DRAFT rental bills for it. FINAL/PAID bills and locked periods are never modified.
                    </p>
                    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:10px;cursor:pointer">
                      <input type="checkbox" id="mh_flag_fuel" checked> Flag unlocked fuel slips as direct/outside-billed
                    </label>
                    <div style="margin-bottom:14px">
                      <label style="font-size:11.5px;font-weight:600">Reason</label>
                      <input type="text" id="mh_reason" class="input sm" value="Hired / outside-billed vehicle" style="width:100%">
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:8px">
                      <button type="button" class="btn sm" id="btn_mh_cancel">Cancel</button>
                      <button type="button" class="btn sm primary" id="btn_mh_confirm">Confirm Mark Hired</button>
                    </div>
                  </div>
                `;
                document.body.appendChild(m);
                m.querySelector('#btn_mh_cancel').onclick = () => m.remove();
                m.onclick = (e) => { if (e.target === m) m.remove(); };
                m.querySelector('#btn_mh_confirm').onclick = async () => {
                  const confirmBtn = m.querySelector('#btn_mh_confirm');
                  confirmBtn.disabled = true;
                  try {
                    const res = await api('/hire/rates/mark-hired', {
                      method: 'POST',
                      body: {
                        assetId: u.asset_id,
                        flagDirectBilledFuel: m.querySelector('#mh_flag_fuel').checked,
                        reason: m.querySelector('#mh_reason').value.trim() || 'Hired / outside-billed vehicle',
                      },
                    });
                    toast(`Marked ${u.asset_code} HIRED (${res.draftsVoided || 0} drafts voided, ${res.fuelFlagged || 0} fuel slips flagged)`);
                    m.remove();
                    initialRatesMode = 'UNRATED';
                    renderRatesTab(box);
                  } catch (err) {
                    notify(err.message);
                    confirmBtn.disabled = false;
                  }
                };
              };
            });
            return;
          }
          if (mode === 'PORTABLE') {
            noteEl.textContent = 'Portable plant & small tools — billed per Day (Rs/day).';
            const filteredPortable = portable.filter((p) => {
              if (!searchQ) return true;
              const q = searchQ.toUpperCase();
              return String(p.asset_code || '').toUpperCase().includes(q) ||
                String(p.category_name || '').toUpperCase().includes(q) ||
                String(p.source_label || '').toUpperCase().includes(q) ||
                String(p.note || '').toUpperCase().includes(q) ||
                String(p.current_site || '').toUpperCase().includes(q);
            });
            wrap.innerHTML = `
              <div class="card" style="padding:0;overflow-x:auto">
                <table class="table" style="width:100%;margin:0;font-size:12.5px">
                  <thead>
                    <tr style="background:rgba(0,0,0,0.02)">
                      <th style="padding:10px 12px">Equipment Category</th>
                      <th style="padding:10px 12px">Specification / Capacity</th>
                      <th style="padding:10px 12px">Rate Basis</th>
                      <th style="padding:10px 12px;text-align:right">Dry Rate (Rs / Day)</th>
                      <th style="padding:10px 12px;text-align:right">Wet Rate (Rs / Day)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filteredPortable.length ? filteredPortable.map((p) => `
                      <tr>
                        <td style="padding:9px 12px">${p.asset_code ? `<span class="badge" style="margin-right:6px;font-weight:700">${esc(p.asset_code)}</span>` : ''}<b>${esc(p.category_name || 'Portable Plant')}</b></td>
                        <td style="padding:9px 12px">${esc(p.source_label || p.note || '')}${p.current_site ? ` <span class="muted" style="font-size:11px">(${esc(p.current_site)})</span>` : ''}</td>
                        <td style="padding:9px 12px"><span class="badge">DAILY</span></td>
                        <td style="padding:9px 12px;text-align:right;font-weight:700">${fmtCents(p.port_dd_cents || p.dry_rate_cents)}</td>
                        <td style="padding:9px 12px;text-align:right;font-weight:700;color:#059669">${fmtCents(p.port_dw_cents || p.wet_rate_cents)}</td>
                      </tr>
                    `).join('') : '<tr><td colspan="5" class="muted" style="padding:20px;text-align:center">No portable plant rate cards match your search.</td></tr>'}
                  </tbody>
                </table>
              </div>
            `;
            return;
          }

          const sourcePool = mode === 'HR' ? machineryHr : (mode === 'KM' ? vehiclesKm : fleet);
          if (mode === 'HR') {
            noteEl.innerHTML = '<b>L/hr Machinery &amp; Heavy Plant Section:</b> Tariffs use <b>Hourly Rates (Rs/hr)</b> and Standard Band thresholds are in <b>L/hr</b> (lower = more economical).';
          } else if (mode === 'KM') {
            noteEl.innerHTML = '<b>km/L Road Vehicles Section:</b> Tariffs use <b>Per-KM Rates (Rs/km)</b> and Standard Band thresholds are in <b>km/L</b> (higher = more economical).';
          } else {
            noteEl.innerHTML = '<b>Combined Fleet View:</b> Displays both <b>L/hr (Rs/hr)</b> machinery and <b>km/L (Rs/km)</b> road vehicles with per-unit labels.';
          }

          const filteredFleet = sourcePool.filter((r) => {
            if (catFilter && String(r.category || '').toLowerCase() !== catFilter.toLowerCase()) return false;
            if (searchQ) {
              const q = searchQ.toUpperCase();
              return String(r.asset_code || '').toUpperCase().includes(q) ||
                     String(r.asset_reg || '').toUpperCase().includes(q) ||
                     String(r.category || '').toUpperCase().includes(q) ||
                     String(r.brand || '').toUpperCase().includes(q) ||
                     String(r.model_no || '').toUpperCase().includes(q) ||
                     String(r.source_label || '').toUpperCase().includes(q);
            }
            return true;
          });

          const unitHdr = mode === 'HR' ? ' (Rs/hr)' : (mode === 'KM' ? ' (Rs/km)' : '');
          const bandHdr = mode === 'HR'
            ? 'Standard Band (L/hr · Econ / Typ / Heavy)'
            : (mode === 'KM' ? 'Standard Band (km/L · Econ / Typ / Heavy)' : 'Standard Band (Econ / Typ / Heavy)');
          const measHdr = mode === 'HR' ? 'Measured (L/hr)' : (mode === 'KM' ? 'Measured (km/L)' : 'Measured Burn');

          wrap.innerHTML = `
            <div class="card" style="padding:0;overflow-x:auto">
              <table class="table" style="width:100%;margin:0;font-size:12.5px">
                <thead>
                  <tr style="background:rgba(0,0,0,0.02)">
                    <th style="padding:10px 12px">Vehicle</th>
                    <th style="padding:10px 12px">Category / Model</th>
                    <th style="padding:10px 12px">Site</th>
                    <th style="padding:10px 12px">Billing &amp; Rate Unit</th>
                    <th style="padding:10px 12px;text-align:right">Min / Mo</th>
                    <th style="padding:10px 12px;text-align:right">Dry Rate${unitHdr}</th>
                    <th style="padding:10px 12px;text-align:right">Wet Rate${unitHdr}</th>
                    <th style="padding:10px 12px;text-align:right">Fully Wet${unitHdr}</th>
                    <th style="padding:10px 12px">${bandHdr}</th>
                    <th style="padding:10px 12px">${measHdr}</th>
                    <th style="padding:10px 12px;text-align:center">Edit</th>
                  </tr>
                </thead>
                <tbody>
                  ${filteredFleet.length ? filteredFleet.map((r, idx) => {
                    const unitTag = r.rate_unit_label || (r.rate_basis === 'KM' ? 'Rs/km' : 'Rs/hr');
                    const unitBadgeColor = r.rate_basis === 'KM'
                      ? 'background:rgba(5,150,105,0.12);color:#047857;border:1px solid #a7f3d0'
                      : 'background:rgba(2,132,199,0.12);color:#0369a1;border:1px solid #bae6fd';
                    const showSuffix = mode === 'ALL' ? ` <span class="muted" style="font-size:10px">/${r.rate_basis === 'KM' ? 'km' : 'hr'}</span>` : '';
                    const minMoVal = r.min_bill_units != null ? Number(r.min_bill_units) : (r.min_bill_hours > 0 ? Number(r.min_bill_hours) : (r.rate_basis === 'KM' ? 3000 : (r.rate_basis === 'HOURLY' ? 120 : 0)));
                    const minMoUnit = r.rate_basis === 'KM' ? 'km' : (r.rate_basis === 'DAILY' ? 'd' : 'hr');
                    return `
                      <tr>
                        <td style="padding:9px 12px">
                          <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(r.asset_code || '')}" style="font-weight:800;color:var(--primary,#0066ff)">${esc(r.asset_code || r.category)}</a>
                          <div class="muted" style="font-size:11px">${esc(r.asset_reg || '—')}</div>
                        </td>
                        <td style="padding:9px 12px">
                          <div>${esc(r.category || '—')}</div>
                          <div class="muted" style="font-size:11px">${esc([r.brand, r.model_no].filter(Boolean).join(' ') || r.source_label || r.note || '')}</div>
                        </td>
                        <td style="padding:9px 12px" class="muted">${esc(r.current_site || 'Central')}</td>
                        <td style="padding:9px 12px">
                          <span class="badge">${esc(basisLabelText(r.default_basis || 'DRY'))}</span>
                          <span class="badge" style="${unitBadgeColor};font-weight:700">${esc(r.rate_basis === 'KM' ? 'KM (Rs/km)' : `${r.rate_basis || 'HOURLY'} (${unitTag})`)}</span>
                        </td>
                        <td style="padding:9px 12px;text-align:right;white-space:nowrap">${minMoVal > 0 ? `<b>${fmtNum(minMoVal, 0)}</b> <span class="muted" style="font-size:10.5px">${minMoUnit}</span>` : '—'}</td>
                        <td style="padding:9px 12px;text-align:right;font-weight:700">${fmtCents(r.dry_rate_cents ?? r.rate_cents)}${showSuffix}</td>
                        <td style="padding:9px 12px;text-align:right">${r.wet_rate_cents ? `${fmtCents(r.wet_rate_cents)}${showSuffix}` : '—'}</td>
                        <td style="padding:9px 12px;text-align:right">${r.fully_wet_rate_cents ? `${fmtCents(r.fully_wet_rate_cents)}${showSuffix}` : '—'}</td>
                        <td style="padding:9px 12px">
                          ${r.typ_display != null ? `<b>${r.econ_display ?? '—'}</b> / <b style="color:#059669">${r.typ_display}</b> / <b style="color:#dc2626">${r.heavy_display ?? '—'}</b> <span class="badge">${esc(r.display_unit)}</span>` : `<span class="muted">Not set (${esc(r.display_unit)})</span>`}
                        </td>
                        <td style="padding:9px 12px">
                          ${r.measured_display != null ? `<b>${r.measured_display} ${esc(r.display_unit)}</b> ` : ''}${verdictBadge(r.verdict)}
                        </td>
                        <td style="padding:9px 12px;text-align:center">
                          <button type="button" class="btn sm btn-edit-rate" data-idx="${idx}">✏️ Edit</button>
                        </td>
                      </tr>
                    `;
                  }).join('') : '<tr><td colspan="11" class="muted" style="padding:20px;text-align:center">No matching rate cards found.</td></tr>'}
                </tbody>
              </table>
            </div>
          `;

          qsa('.btn-edit-rate', wrap).forEach((b) => {
            b.onclick = () => openEditRateModal(filteredFleet[Number(b.getAttribute('data-idx'))], () => renderRatesTab(box));
          });
        }

        qs('#btn_rt_hr', box).onclick = () => { mode = 'HR'; catFilter = ''; drawTable(); };
        qs('#btn_rt_km', box).onclick = () => { mode = 'KM'; catFilter = ''; drawTable(); };
        qs('#btn_rt_port', box).onclick = () => { mode = 'PORTABLE'; drawTable(); };
        qs('#btn_rt_all', box).onclick = () => { mode = 'ALL'; catFilter = ''; drawTable(); };
        if (qs('#btn_rt_unrated', box)) qs('#btn_rt_unrated', box).onclick = () => { mode = 'UNRATED'; catFilter = ''; drawTable(); };
        qs('#rt_search', box).oninput = (e) => { searchQ = e.target.value; drawTable(); };
        qs('#rt_cat', box).onchange = (e) => { catFilter = e.target.value; drawTable(); };
        if (qs('#btn_rt_add', box)) {
          qs('#btn_rt_add', box).onclick = () => openAddRateModal(mode === 'KM' ? 'km' : 'hr', () => renderRatesTab(box));
        }

        drawTable();
      } catch (err) {
        box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
      }
    }

    function openAddRateModal(defaultConsBasis, onDone, prefillAsset = null) {
      if (typeof defaultConsBasis === 'function') { onDone = defaultConsBasis; defaultConsBasis = 'hr'; }
      const initCons = defaultConsBasis === 'km' ? 'km' : 'hr';
      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:560px;padding:24px">
          <h2 style="margin:0 0 10px 0">+ Add / Configure Vehicle Rate Card</h2>
          <form id="form_add_rate" style="display:flex;flex-direction:column;gap:10px">
            <div id="add_rate_picker_wrap">${assetPickerHtml('Vehicle / Machine (from Assets) *')}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
              <div>
                <label style="font-size:11px;font-weight:600">Section &amp; Fuel Unit</label>
                <select id="ar_cons_basis" class="input sm" style="width:100%">
                  <option value="hr" ${initCons === 'hr' ? 'selected' : ''}>L/hr (Machinery · Hourly)</option>
                  <option value="km" ${initCons === 'km' ? 'selected' : ''}>km/L (Vehicle · Per-KM)</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Default Billing Basis</label>
                <select id="ar_def_basis" class="input sm" style="width:100%">
                  <option value="DRY_WITH_DRIVER">DRY WITH DRIVER</option>
                  <option value="DRY">DRY</option>
                  <option value="WET">WET</option>
                  <option value="FULLY_WET">FULLY WET</option>
                  <option value="FUEL_ONLY">FUEL ONLY</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Rate Unit</label>
                <select id="ar_rate_basis" class="input sm" style="width:100%">
                  <option value="HOURLY" ${initCons === 'hr' ? 'selected' : ''}>HOURLY (Rs/hr)</option>
                  <option value="KM" ${initCons === 'km' ? 'selected' : ''}>KM (Rs/km)</option>
                  <option value="DAILY">DAILY (Rs/day)</option>
                  <option value="MONTHLY">MONTHLY (Rs/mo)</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
              <div>
                <label id="ar_dry_lbl" style="font-size:11px;font-weight:600">Dry Rate (${initCons === 'km' ? 'Rs/km' : 'Rs/hr'})</label>
                <input type="number" id="ar_dry" class="input sm" required placeholder="${initCons === 'km' ? '45' : '2000'}" style="width:100%">
              </div>
              <div>
                <label id="ar_wet_lbl" style="font-size:11px;font-weight:600">Wet Rate (${initCons === 'km' ? 'Rs/km' : 'Rs/hr'})</label>
                <input type="number" id="ar_wet" class="input sm" placeholder="${initCons === 'km' ? '70' : '2800'}" style="width:100%">
              </div>
              <div>
                <label id="ar_fw_lbl" style="font-size:11px;font-weight:600">Fully Wet (${initCons === 'km' ? 'Rs/km' : 'Rs/hr'})</label>
                <input type="number" id="ar_fw" class="input sm" placeholder="${initCons === 'km' ? '110' : '4150'}" style="width:100%">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center">
              <div>
                <label id="ar_min_lbl" style="font-size:11px;font-weight:600">Min Monthly Units (25d · ${initCons === 'km' ? 'km' : 'hr'})</label>
                <input type="number" id="ar_min_units" class="input sm" min="0" value="${initCons === 'km' ? 3000 : 120}" style="width:100%">
              </div>
              <div class="muted" style="font-size:11px;padding-top:14px">Hourly default: <b>120 hr/mo</b> · Per-KM default: <b>3,000 km/mo</b> (25 working days)</div>
            </div>
            <div style="padding:10px;background:rgba(16,185,129,0.06);border-radius:6px">
              <div id="ar_band_title" style="font-size:11px;font-weight:700;margin-bottom:6px">Standard Band (${initCons === 'km' ? 'km/L' : 'L/hr'})</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                <div><label style="font-size:10px">Economical</label><input type="number" step="0.01" id="ar_econ" class="input sm" style="width:100%"></div>
                <div><label style="font-size:10px">Typical (Norm)</label><input type="number" step="0.01" id="ar_typ" class="input sm" style="width:100%"></div>
                <div><label style="font-size:10px">Heavy Limit</label><input type="number" step="0.01" id="ar_heavy" class="input sm" style="width:100%"></div>
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn sm" id="btn_ar_cancel">Cancel</button>
              <button type="submit" class="btn sm primary">Save Rate Card</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modalEl);

      function syncAddUnitLabels(resetMinIfDefault) {
        const cons = modalEl.querySelector('#ar_cons_basis').value;
        const rb = modalEl.querySelector('#ar_rate_basis').value;
        const rateSuffix = rb === 'KM' ? 'Rs/km' : (rb === 'DAILY' ? 'Rs/day' : (rb === 'MONTHLY' ? 'Rs/mo' : 'Rs/hr'));
        const bandUnit = cons === 'km' ? 'km/L' : 'L/hr';
        const minUnit = rb === 'KM' ? 'km' : (rb === 'DAILY' ? 'days' : 'hr');
        modalEl.querySelector('#ar_dry_lbl').textContent = `Dry Rate (${rateSuffix})`;
        modalEl.querySelector('#ar_wet_lbl').textContent = `Wet Rate (${rateSuffix})`;
        modalEl.querySelector('#ar_fw_lbl').textContent = `Fully Wet (${rateSuffix})`;
        modalEl.querySelector('#ar_min_lbl').textContent = `Min Monthly Units (25d · ${minUnit})`;
        modalEl.querySelector('#ar_band_title').textContent = `Standard Band (${bandUnit} · Econ / Typ / Heavy)`;
        if (resetMinIfDefault) {
          const minInp = modalEl.querySelector('#ar_min_units');
          const curVal = Number(minInp.value);
          if (!curVal || curVal === 120 || curVal === 3000 || curVal === 25) {
            minInp.value = rb === 'KM' ? 3000 : (rb === 'HOURLY' ? 120 : 0);
          }
        }
      }

      modalEl.querySelector('#ar_cons_basis').addEventListener('change', (e) => {
        modalEl.querySelector('#ar_rate_basis').value = e.target.value === 'km' ? 'KM' : 'HOURLY';
        syncAddUnitLabels(true);
      });
      modalEl.querySelector('#ar_rate_basis').addEventListener('change', (e) => {
        if (e.target.value === 'KM') modalEl.querySelector('#ar_cons_basis').value = 'km';
        else if (e.target.value === 'HOURLY') modalEl.querySelector('#ar_cons_basis').value = 'hr';
        syncAddUnitLabels(true);
      });

      wireAssetPicker(qs('#add_rate_picker_wrap', modalEl));
      if (prefillAsset && prefillAsset.assetCode) {
        const inp = qs('#add_rate_picker_wrap input[name="asset"]', modalEl);
        const hid = qs('#add_rate_picker_wrap input[name="asset_id"]', modalEl);
        if (inp) inp.value = prefillAsset.assetCode;
        if (hid && prefillAsset.assetId) hid.value = String(prefillAsset.assetId);
      }
      modalEl.querySelector('#btn_ar_cancel').onclick = () => modalEl.remove();
      modalEl.onclick = (e) => { if (e.target === modalEl) modalEl.remove(); };
      modalEl.querySelector('#form_add_rate').onsubmit = async (e) => {
        e.preventDefault();
        const assetInp = qs('#add_rate_picker_wrap input[name="asset"]', modalEl);
        const assetIdInp = qs('#add_rate_picker_wrap input[name="asset_id"]', modalEl);
        try {
          await api('/hire/rates', {
            method: 'POST',
            body: {
              assetId: assetIdInp && assetIdInp.value ? Number(assetIdInp.value) : null,
              assetCode: assetInp ? assetInp.value.trim() : '',
              defaultBasis: modalEl.querySelector('#ar_def_basis').value,
              rateBasis: modalEl.querySelector('#ar_rate_basis').value,
              fuelConsBasis: modalEl.querySelector('#ar_cons_basis').value,
              dryRateCents: Math.round(Number(modalEl.querySelector('#ar_dry').value || 0) * 100),
              wetRateCents: modalEl.querySelector('#ar_wet').value ? Math.round(Number(modalEl.querySelector('#ar_wet').value) * 100) : null,
              fullyWetRateCents: modalEl.querySelector('#ar_fw').value ? Math.round(Number(modalEl.querySelector('#ar_fw').value) * 100) : null,
              minBillHours: Number(modalEl.querySelector('#ar_min_units').value) || 0,
              econDisplay: modalEl.querySelector('#ar_econ').value,
              typDisplay: modalEl.querySelector('#ar_typ').value,
              heavyDisplay: modalEl.querySelector('#ar_heavy').value,
            },
          });
          toast('Rate card saved!');
          modalEl.remove();
          if (onDone) onDone();
        } catch (err) {
          notify(err.message);
        }
      };
    }

    function openEditRateModal(r, onDone) {
      const initCons = r.cons_basis || r.fuel_cons_basis || (r.rate_basis === 'KM' || r.display_unit === 'km/L' ? 'km' : 'hr');
      const initRateBasis = r.rate_basis || (initCons === 'km' ? 'KM' : 'HOURLY');
      const rateSuffix0 = initRateBasis === 'KM' ? 'Rs/km' : (initRateBasis === 'DAILY' ? 'Rs/day' : (initRateBasis === 'MONTHLY' ? 'Rs/mo' : 'Rs/hr'));
      const initMinUnits = r.min_bill_units > 0 ? Number(r.min_bill_units) : (r.min_bill_hours > 0 ? Number(r.min_bill_hours) : (initRateBasis === 'KM' ? 3000 : (initRateBasis === 'HOURLY' ? 120 : 0)));
      const minUnit0 = initRateBasis === 'KM' ? 'km' : (initRateBasis === 'DAILY' ? 'days' : 'hr');
      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:560px;padding:24px">
          <h2 style="margin:0 0 8px 0">✏️ Edit Rate Card &amp; Consumption Band — ${esc(r.asset_code || r.category)}</h2>
          <form id="form_edit_rate" style="display:flex;flex-direction:column;gap:10px">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
              <div>
                <label style="font-size:11px;font-weight:600">Section &amp; Fuel Unit</label>
                <select id="er_cons_basis" class="input sm" style="width:100%">
                  <option value="hr" ${initCons === 'hr' ? 'selected' : ''}>L/hr (Machinery · Hourly)</option>
                  <option value="km" ${initCons === 'km' ? 'selected' : ''}>km/L (Vehicle · Per-KM)</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Default Billing Basis</label>
                <select id="er_def_basis" class="input sm" style="width:100%">
                  <option value="DRY_WITH_DRIVER" ${r.default_basis === 'DRY_WITH_DRIVER' ? 'selected' : ''}>DRY WITH DRIVER</option>
                  <option value="DRY" ${r.default_basis === 'DRY' ? 'selected' : ''}>DRY</option>
                  <option value="WET" ${r.default_basis === 'WET' ? 'selected' : ''}>WET</option>
                  <option value="FULLY_WET" ${r.default_basis === 'FULLY_WET' ? 'selected' : ''}>FULLY WET</option>
                  <option value="FUEL_ONLY" ${r.default_basis === 'FUEL_ONLY' ? 'selected' : ''}>FUEL ONLY</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Rate Unit</label>
                <select id="er_rate_basis" class="input sm" style="width:100%">
                  <option value="HOURLY" ${initRateBasis === 'HOURLY' ? 'selected' : ''}>HOURLY (Rs/hr)</option>
                  <option value="KM" ${initRateBasis === 'KM' ? 'selected' : ''}>KM (Rs/km)</option>
                  <option value="DAILY" ${initRateBasis === 'DAILY' ? 'selected' : ''}>DAILY (Rs/day)</option>
                  <option value="MONTHLY" ${initRateBasis === 'MONTHLY' ? 'selected' : ''}>MONTHLY (Rs/mo)</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
              <div>
                <label id="er_dry_lbl" style="font-size:11px;font-weight:600">Dry Rate (${rateSuffix0})</label>
                <input type="number" id="er_dry" class="input sm" value="${Math.round((r.dry_rate_cents || r.rate_cents || 0) / 100)}" style="width:100%">
              </div>
              <div>
                <label id="er_wet_lbl" style="font-size:11px;font-weight:600">Wet Rate (${rateSuffix0})</label>
                <input type="number" id="er_wet" class="input sm" value="${Math.round((r.wet_rate_cents || 0) / 100)}" style="width:100%">
              </div>
              <div>
                <label id="er_fw_lbl" style="font-size:11px;font-weight:600">Fully Wet (${rateSuffix0})</label>
                <input type="number" id="er_fw" class="input sm" value="${Math.round((r.fully_wet_rate_cents || 0) / 100)}" style="width:100%">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center">
              <div>
                <label id="er_min_lbl" style="font-size:11px;font-weight:600">Min Monthly Units (25d · ${minUnit0})</label>
                <input type="number" id="er_min_units" class="input sm" min="0" value="${initMinUnits}" style="width:100%">
              </div>
              <div class="muted" style="font-size:11px;padding-top:14px">Hourly default: <b>120 hr/mo</b> · Per-KM default: <b>3,000 km/mo</b> (25 working days)</div>
            </div>
            <div style="padding:10px;background:rgba(16,185,129,0.06);border-radius:6px">
              <div id="er_band_title" style="font-size:11px;font-weight:700;margin-bottom:6px">Standard Consumption Band (${initCons === 'km' ? 'km/L' : 'L/hr'})</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                <div>
                  <label style="font-size:10px">Economical</label>
                  <input type="number" step="0.01" id="er_econ" class="input sm" value="${r.econ_display ?? ''}" style="width:100%">
                </div>
                <div>
                  <label style="font-size:10px">Typical (Norm)</label>
                  <input type="number" step="0.01" id="er_typ" class="input sm" value="${r.typ_display ?? ''}" style="width:100%">
                </div>
                <div>
                  <label style="font-size:10px">Heavy Limit</label>
                  <input type="number" step="0.01" id="er_heavy" class="input sm" value="${r.heavy_display ?? ''}" style="width:100%">
                </div>
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn sm" id="btn_er_cancel">Cancel</button>
              <button type="submit" class="btn sm primary">Save Rate &amp; Band</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modalEl);

      function syncEditLabelsAndStoredTier(shouldSwapValues) {
        const cons = modalEl.querySelector('#er_cons_basis').value;
        const rb = modalEl.querySelector('#er_rate_basis').value;
        const rateSuffix = rb === 'KM' ? 'Rs/km' : (rb === 'DAILY' ? 'Rs/day' : (rb === 'MONTHLY' ? 'Rs/mo' : 'Rs/hr'));
        const minUnit = rb === 'KM' ? 'km' : (rb === 'DAILY' ? 'days' : 'hr');
        modalEl.querySelector('#er_dry_lbl').textContent = `Dry Rate (${rateSuffix})`;
        modalEl.querySelector('#er_wet_lbl').textContent = `Wet Rate (${rateSuffix})`;
        modalEl.querySelector('#er_fw_lbl').textContent = `Fully Wet (${rateSuffix})`;
        modalEl.querySelector('#er_min_lbl').textContent = `Min Monthly Units (25d · ${minUnit})`;
        modalEl.querySelector('#er_band_title').textContent = `Standard Consumption Band (${cons === 'km' ? 'km/L' : 'L/hr'})`;

        if (shouldSwapValues) {
          const minInp = modalEl.querySelector('#er_min_units');
          const curMin = Number(minInp.value);
          if (!curMin || curMin === 120 || curMin === 3000 || curMin === 25) {
            minInp.value = rb === 'KM' ? 3000 : (rb === 'HOURLY' ? 120 : 0);
          }
          if (rb === 'KM' && r.km_dry_cents != null) {
            modalEl.querySelector('#er_dry').value = Math.round(r.km_dry_cents / 100);
            modalEl.querySelector('#er_wet').value = Math.round((r.km_wet_cents || 0) / 100);
            modalEl.querySelector('#er_fw').value = Math.round((r.km_fw_cents || 0) / 100);
          } else if (rb === 'HOURLY' && r.hr_dry_cents != null) {
            modalEl.querySelector('#er_dry').value = Math.round(r.hr_dry_cents / 100);
            modalEl.querySelector('#er_wet').value = Math.round((r.hr_wet_cents || 0) / 100);
            modalEl.querySelector('#er_fw').value = Math.round((r.hr_fw_cents || 0) / 100);
          }
        }
      }

      modalEl.querySelector('#er_cons_basis').addEventListener('change', (e) => {
        modalEl.querySelector('#er_rate_basis').value = e.target.value === 'km' ? 'KM' : 'HOURLY';
        syncEditLabelsAndStoredTier(true);
      });
      modalEl.querySelector('#er_rate_basis').addEventListener('change', (e) => {
        if (e.target.value === 'KM') modalEl.querySelector('#er_cons_basis').value = 'km';
        else if (e.target.value === 'HOURLY') modalEl.querySelector('#er_cons_basis').value = 'hr';
        syncEditLabelsAndStoredTier(true);
      });

      modalEl.querySelector('#btn_er_cancel').onclick = () => modalEl.remove();
      modalEl.onclick = (e) => { if (e.target === modalEl) modalEl.remove(); };

      modalEl.querySelector('#form_edit_rate').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/hire/rates', {
            method: 'POST',
            body: {
              id: r.id,
              assetId: r.asset_id,
              categoryName: r.category,
              defaultBasis: modalEl.querySelector('#er_def_basis').value,
              rateBasis: modalEl.querySelector('#er_rate_basis').value,
              rateCents: Math.round(Number(modalEl.querySelector('#er_dry').value) * 100),
              dryRateCents: Math.round(Number(modalEl.querySelector('#er_dry').value) * 100),
              wetRateCents: Math.round(Number(modalEl.querySelector('#er_wet').value) * 100),
              fullyWetRateCents: Math.round(Number(modalEl.querySelector('#er_fw').value) * 100),
              minBillHours: Number(modalEl.querySelector('#er_min_units').value) || 0,
              econDisplay: modalEl.querySelector('#er_econ').value,
              typDisplay: modalEl.querySelector('#er_typ').value,
              heavyDisplay: modalEl.querySelector('#er_heavy').value,
              fuelConsBasis: modalEl.querySelector('#er_cons_basis').value,
            },
          });
          toast('Rate card and consumption band updated!');
          modalEl.remove();
          if (onDone) onDone();
        } catch (err) {
          notify(err.message);
        }
      };
    }

    // =========================================================================
    // TAB 3: SITE ALLOCATOR CONSOLE (From – To Date/Month/Year)
    // =========================================================================
    async function renderAllocationsTab(box) {
      const projects = (await loadProjectsList()).filter((p) => p.active !== 0);
      const curM = currentMonthStr();
      const todayD = currentTodayStr();
      const canManageAlloc = typeof canDo === 'function' && (canDo('allocations.manage') || canDo('hire.billing.generate'));

      box.innerHTML = `
        <div class="card" style="padding:14px;margin-bottom:14px;background:linear-gradient(90deg, rgba(37,99,235,0.06), rgba(16,185,129,0.05))">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px">📍 Assign / Transfer Machine to Project Site (Vehicles from Assets · Projects from Projects · Dry with Driver · From / To Date/Month/Year)</div>
          <form id="form_alloc" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(165px, 1fr));gap:10px;align-items:flex-end">
            <div id="al_picker_wrap" style="min-width:185px">
              ${assetPickerHtml('Vehicle Code (Assets) *')}
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Project / Site *</label>
              <select id="al_proj" required class="input sm" style="width:100%">
                <option value="">-- Select Project --</option>
                ${projects.map((p) => `<option value="${p.id}">${esc(p.code ? p.code + ' · ' + p.name : p.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Billing Basis *</label>
              <select id="al_basis" class="input sm" style="width:100%">
                <option value="DRY_WITH_DRIVER" selected>DRY WITH DRIVER (Client Fuel)</option>
                <option value="DRY">DRY (Machine Only)</option>
                <option value="WET">WET (Driver + Fuel Recharged)</option>
                <option value="FULLY_WET">FULLY WET (Fuel Inclusive)</option>
                <option value="FUEL_ONLY">FUEL_ONLY</option>
                <option value="BILLED_DIRECT">BILLED DIRECT (Hired / External)</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">From (Date/Month/Year) *</label>
              <input type="date" id="al_date_from" required class="input sm" value="${todayD}" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">To (Date/Month/Year)</label>
              <input type="date" id="al_date_to" class="input sm" value="" style="width:100%">
            </div>
            <div>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding-bottom:6px;cursor:pointer">
                <input type="checkbox" id="al_is_current" checked style="width:auto"> Current / Ongoing
              </label>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Driver / Operator</label>
              <input type="text" id="al_driver" class="input sm" placeholder="Driver name" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Notes</label>
              <input type="text" id="al_notes" class="input sm" placeholder="Site remarks" style="width:100%">
            </div>
            <div>
              <button type="submit" class="btn sm primary" style="width:100%">📍 Allocate Machine</button>
            </div>
          </form>
          <div id="al_compliance_warn" style="display:none;margin-top:8px;padding:7px 10px;border-radius:6px;font-size:12px;justify-content:space-between;align-items:center;gap:8px"></div>
        </div>

        <div class="card" style="padding:10px 12px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="al_flt_code" class="input sm" placeholder="Search vehicle code / reg..." style="min-width:150px;flex:1">
          <select id="al_flt_proj" class="input sm">
            <option value="">All Projects</option>
            ${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
          <select id="al_flt_basis" class="input sm">
            <option value="">All Bases</option>
            <option value="DRY_WITH_DRIVER">DRY WITH DRIVER</option>
            <option value="DRY">DRY</option>
            <option value="WET">WET</option>
            <option value="FULLY_WET">FULLY WET</option>
            <option value="FUEL_ONLY">FUEL ONLY</option>
            <option value="BILLED_DIRECT">BILLED DIRECT (Hired)</option>
          </select>
          <select id="al_flt_origin" class="input sm">
            <option value="ALL">All Origins</option>
            <option value="AUTO_FUEL">Auto (Fuel)</option>
            <option value="MANUAL">Manual / Locked</option>
          </select>
          <label style="font-size:11px;display:flex;align-items:center;gap:4px">From <input type="date" id="al_flt_from" class="input sm"></label>
          <label style="font-size:11px;display:flex;align-items:center;gap:4px">To <input type="date" id="al_flt_to" class="input sm"></label>
          <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="checkbox" id="al_flt_current" style="width:auto"> Current Only
          </label>
          <button class="btn sm primary" id="btn_al_filter">Filter</button>
          <button class="btn sm" id="btn_al_current_month">This Month (${curM})</button>
          ${canManageAlloc ? `
            <div style="display:flex;gap:6px;align-items:center;margin-left:auto;border-left:1px solid var(--border);padding-left:10px">
              <input type="month" id="al_sync_month" class="input sm" value="${curM}" style="width:130px">
              <button type="button" class="btn sm" id="btn_al_sync_fuel" style="background:#0284c7;color:#fff;border-color:#0284c7">🔄 Auto-Allocate from Fuel</button>
            </div>
          ` : ''}
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:12.5px">
            <thead>
              <tr>
                <th style="padding:10px 12px">From – To (Date/Month/Year)</th>
                <th style="padding:10px 12px">Vehicle</th>
                <th style="padding:10px 12px">Category</th>
                <th style="padding:10px 12px">Assigned Site / Project</th>
                <th style="padding:10px 12px">Billing Basis</th>
                <th style="padding:10px 12px">Origin</th>
                <th style="padding:10px 12px">Driver / Notes</th>
                ${canManageAlloc ? '<th style="padding:10px 12px;text-align:center">Action</th>' : ''}
              </tr>
            </thead>
            <tbody id="alloc_tbody">
              <tr><td colspan="${canManageAlloc ? 8 : 7}" class="muted" style="padding:20px;text-align:center">Loading allocations...</td></tr>
            </tbody>
          </table>
        </div>
      `;

      let complianceMap = {};
      let complianceCodeMap = {};
      api('/vehicle-documents/compliance-badges').then((res) => {
        complianceMap = (res && res.by_asset_id) || {};
        complianceCodeMap = (res && res.by_code) || {};
        paintAllocComplianceBadges();
      }).catch(() => {});

      function findComplianceFor(assetId, code) {
        if (assetId && complianceMap[String(assetId)]) return complianceMap[String(assetId)];
        if (code) {
          const up = String(code).trim().toUpperCase();
          return complianceCodeMap[up] || complianceCodeMap[up.replace(/[^A-Z0-9]/g, '')] || null;
        }
        return null;
      }

      function paintAllocComplianceWarn(assetId, code) {
        const warnEl = qs('#al_compliance_warn', box);
        if (!warnEl) return;
        const info = findComplianceFor(assetId, code);
        if (!info || !info.badge) {
          warnEl.style.display = 'none';
          return;
        }
        const isRed = info.badge.level === 'red';
        warnEl.style.display = 'flex';
        warnEl.style.background = isRed ? 'rgba(220,38,38,0.1)' : 'rgba(245,158,11,0.12)';
        warnEl.style.border = `1px solid ${isRed ? '#dc2626' : '#d97706'}`;
        warnEl.style.color = isRed ? '#991b1b' : '#92400e';
        warnEl.innerHTML = `<span>${isRed ? '🚨' : '⚠️'} <b>Non-Blocking Compliance Alert:</b> ${esc(info.badge.label)}${info.badge.detail ? ` (${esc(info.badge.detail)})` : ''}</span><a class="btn sm" href="#/assets/${info.asset_id}">Inspect Docs →</a>`;
      }

      function paintAllocComplianceBadges() {
        qsa('.alloc-comp-slot', box).forEach((slot) => {
          const info = findComplianceFor(slot.dataset.aid, slot.dataset.code);
          if (!info || !info.badge || (!info.has_statutory_expiry && !info.critical_docs.length)) {
            slot.innerHTML = '';
            return;
          }
          const isRed = info.badge.level === 'red';
          slot.innerHTML = `<a href="#/assets/${info.asset_id}" title="${esc(info.badge.detail || info.badge.label)}" style="text-decoration:none;margin-left:4px"><span class="badge ${isRed ? 'danger' : 'warning'}" style="font-size:10px">${esc(info.badge.label)}</span></a>`;
        });
      }

      wireAssetPicker(qs('#al_picker_wrap', box), (assetId, code) => {
        paintAllocComplianceWarn(assetId, code);
      });

      const dateToEl = qs('#al_date_to', box);
      const isCurEl = qs('#al_is_current', box);
      dateToEl.addEventListener('change', () => {
        if (dateToEl.value) isCurEl.checked = false;
      });
      isCurEl.addEventListener('change', () => {
        if (isCurEl.checked) dateToEl.value = '';
      });

      async function loadAllocs() {
        const tbody = qs('#alloc_tbody', box);
        const q = new URLSearchParams();
        const fCode = qs('#al_flt_code', box).value.trim();
        const fProj = qs('#al_flt_proj', box).value;
        const fBasis = qs('#al_flt_basis', box).value;
        const fOrigin = qs('#al_flt_origin', box) ? qs('#al_flt_origin', box).value : 'ALL';
        const fFrom = qs('#al_flt_from', box).value;
        const fTo = qs('#al_flt_to', box).value;
        const fCur = qs('#al_flt_current', box).checked;
        if (fCode) q.set('assetCode', fCode);
        if (fProj) q.set('projectId', fProj);
        if (fBasis) q.set('basis', fBasis);
        if (fOrigin && fOrigin !== 'ALL') q.set('origin', fOrigin);
        if (fFrom) q.set('dateFrom', fFrom);
        if (fTo) q.set('dateTo', fTo);
        if (fCur) q.set('currentOnly', '1');

        try {
          const { allocations } = await api(`/hire/allocations?${q.toString()}`);
          if (!allocations || !allocations.length) {
            tbody.innerHTML = `<tr><td colspan="${canManageAlloc ? 8 : 7}" class="muted" style="padding:20px;text-align:center">No site allocations found.</td></tr>`;
            return;
          }
          tbody.innerHTML = allocations.slice(0, 250).map((a) => {
            const rawFrom = a.date_from || (a.month_from || a.month ? `${a.month_from || a.month}-01` : '');
            const rawTo = a.is_current ? '' : (a.date_to || (a.month_to || a.month ? lastDayOfMonthStr(a.month_to || a.month) : ''));
            const fromLabel = rawFrom ? fmtDateDMY(rawFrom) : esc(a.month_from || a.month || '—');
            const toLabel = a.is_current
              ? '<span class="badge green">Current</span>'
              : esc(rawTo ? fmtDateDMY(rawTo) : (a.month_to || a.month || '—'));
            const periodLabel = `${fromLabel} → ${toLabel}`;
            const isAuto = String(a.origin || '').toUpperCase() === 'AUTO_FUEL';
            const isLocked = Number(a.locked) === 1;
            const isHired =
              String(a.owner_code || '').toUpperCase() === 'HIRED' ||
              String(a.ownership || '').toUpperCase() === 'HIRED' ||
              String(a.assigned_basis || a.basis || '').toUpperCase() === 'BILLED_DIRECT';
            const originBadge = isAuto
              ? '<span class="badge blue">Auto (Fuel)</span>'
              : `<span class="badge">${isLocked ? '🔒 Locked Manual' : 'Manual'}</span>`;
            const hiredBadge = isHired ? '<span class="badge warning" style="margin-left:4px">HIRED</span>' : '';
            return `
              <tr>
                <td style="padding:9px 12px;white-space:nowrap">${periodLabel}</td>
                <td style="padding:9px 12px">
                  <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(a.asset_code || a.vehicle_no)}" style="font-weight:700">${esc(a.asset_code || a.vehicle_no)}</a>${hiredBadge}<span class="alloc-comp-slot" data-aid="${esc(a.asset_id || '')}" data-code="${esc(a.asset_code || a.vehicle_no || '')}"></span>
                  ${a.registration ? `<div class="muted" style="font-size:11px">${esc(a.registration)}</div>` : ''}
                </td>
                <td style="padding:9px 12px">${esc(a.asset_type || '—')}</td>
                <td style="padding:9px 12px"><b>${esc(a.project_name || a.site_name || '—')}</b>${a.project_code ? ` <span class="muted" style="font-size:11px">(${esc(a.project_code)})</span>` : ''}</td>
                <td style="padding:9px 12px"><span class="badge">${esc(basisLabelText(a.assigned_basis || a.basis || 'DRY_WITH_DRIVER'))}</span></td>
                <td style="padding:9px 12px;white-space:nowrap">${originBadge}</td>
                <td style="padding:9px 12px" class="muted">${esc([a.driver_name, a.notes].filter(Boolean).join(' · ') || '—')}</td>
                ${canManageAlloc ? `<td style="padding:9px 12px;text-align:center;white-space:nowrap">
                  <button class="btn sm btn-lock-alloc" data-id="${esc(a.id)}" data-locked="${isLocked ? '1' : '0'}" title="${isLocked ? 'Allow auto-sync updates' : 'Lock manual allocation against auto-sync'}">${isLocked ? '🔓 Unlock' : '🔒 Lock'}</button>
                  ${a.is_current ? `<button class="btn sm btn-end-alloc" data-id="${esc(a.id)}" style="margin-left:4px">End</button>` : ''}
                </td>` : ''}
              </tr>
            `;
          }).join('');
          paintAllocComplianceBadges();

          qsa('.btn-lock-alloc', tbody).forEach((btn) => {
            btn.onclick = async () => {
              const curLocked = btn.getAttribute('data-locked') === '1';
              try {
                await api(`/hire/allocations/${encodeURIComponent(btn.getAttribute('data-id'))}`, {
                  method: 'PATCH',
                  body: { action: curLocked ? 'unlock' : 'lock' },
                });
                toast(curLocked ? 'Allocation unlocked' : 'Allocation locked as Manual');
                loadAllocs();
              } catch (err) {
                notify(err.message);
              }
            };
          });

          qsa('.btn-end-alloc', tbody).forEach((btn) => {
            btn.onclick = async () => {
              if (!confirm('End this current allocation as of today?')) return;
              try {
                await api(`/hire/allocations/${encodeURIComponent(btn.getAttribute('data-id'))}`, {
                  method: 'PATCH',
                  body: { action: 'end' },
                });
                toast('Allocation ended');
                loadAllocs();
              } catch (err) {
                notify(err.message);
              }
            };
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="${canManageAlloc ? 8 : 7}" class="err">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#btn_al_filter', box).onclick = loadAllocs;
      if (qs('#al_flt_origin', box)) qs('#al_flt_origin', box).onchange = loadAllocs;
      if (qs('#btn_al_sync_fuel', box)) {
        qs('#btn_al_sync_fuel', box).onclick = async () => {
          const syncYm = (qs('#al_sync_month', box) && qs('#al_sync_month', box).value) || curM;
          try {
            const preview = await api('/hire/allocations/sync-from-fuel', {
              method: 'POST',
              body: { month: syncYm, dryRun: true },
            });
            const mEl = document.createElement('div');
            mEl.className = 'modal-bg modal-backdrop';
            const rowsHtml = (preview.items || []).slice(0, 120).map((it) => `
              <tr>
                <td style="padding:6px 8px"><b>${esc(it.assetCode)}</b></td>
                <td style="padding:6px 8px">${esc(it.siteName)}</td>
                <td style="padding:6px 8px;white-space:nowrap">${fmtDateDMY(it.dateFrom)} → ${it.isCurrent ? 'Current' : fmtDateDMY(it.dateTo)}</td>
                <td style="padding:6px 8px;text-align:right">${fmtNum(it.totalLitres, 1)} L (${it.issueCount}x)</td>
                <td style="padding:6px 8px"><span class="badge ${it.action === 'CREATE' ? 'green' : (it.action === 'UPDATE' ? 'blue' : (it.action === 'SKIP_MANUAL' ? 'amber' : ''))}">${esc(it.action)}</span></td>
              </tr>
            `).join('');
            mEl.innerHTML = `
              <div class="modal" style="max-width:780px;width:95%;max-height:86vh;overflow-y:auto;padding:24px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                  <h2 style="margin:0">🔄 Preview Auto-Allocation from Fuel (${esc(syncYm)})</h2>
                  <button type="button" class="btn sm" id="btn_sy_close">✕ Close</button>
                </div>
                <p class="muted" style="margin:0 0 10px 0;font-size:12px">
                  Create: <b>${preview.created || 0}</b> · Update: <b>${preview.updated || 0}</b> · Remove stale: <b>${preview.removed || 0}</b> · Skip Manual/Locked: <b>${preview.skippedManual || 0}</b> · Unchanged: <b>${preview.unchanged || 0}</b>
                </p>
                <div class="card" style="padding:0;overflow-x:auto;margin-bottom:14px">
                  <table class="table" style="width:100%;margin:0;font-size:12px">
                    <thead><tr><th style="padding:7px 8px">Vehicle</th><th style="padding:7px 8px">Allocated Site</th><th style="padding:7px 8px">Period</th><th style="padding:7px 8px;text-align:right">Site Fuel</th><th style="padding:7px 8px">Action</th></tr></thead>
                    <tbody>${rowsHtml || '<tr><td colspan="5" class="muted" style="padding:16px;text-align:center">No fuel issues found for this month.</td></tr>'}</tbody>
                  </table>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:8px">
                  <button type="button" class="btn sm" id="btn_sy_cancel">Cancel</button>
                  <button type="button" class="btn sm primary" id="btn_sy_apply">Apply Auto-Allocations</button>
                </div>
              </div>
            `;
            document.body.appendChild(mEl);
            mEl.querySelector('#btn_sy_close').onclick = () => mEl.remove();
            mEl.querySelector('#btn_sy_cancel').onclick = () => mEl.remove();
            mEl.onclick = (e) => { if (e.target === mEl) mEl.remove(); };
            mEl.querySelector('#btn_sy_apply').onclick = async () => {
              try {
                const res = await api('/hire/allocations/sync-from-fuel', {
                  method: 'POST',
                  body: { month: syncYm, dryRun: false },
                });
                toast(`Synced ${res.created || 0} created, ${res.updated || 0} updated, ${res.removed || 0} removed for ${res.periodKey}!`);
                mEl.remove();
                loadAllocs();
              } catch (err) {
                notify(err.message);
              }
            };
          } catch (err) {
            notify(err.message);
          }
        };
      }
      qs('#btn_al_current_month', box).onclick = () => {
        qs('#al_flt_from', box).value = `${curM}-01`;
        qs('#al_flt_to', box).value = lastDayOfMonthStr(curM);
        qs('#al_flt_current', box).checked = false;
        loadAllocs();
      };
      qs('#al_flt_code', box).onkeydown = (e) => { if (e.key === 'Enter') loadAllocs(); };

      qs('#form_alloc', box).onsubmit = async (e) => {
        e.preventDefault();
        const assetInp = qs('#al_picker_wrap input[name="asset"]', box);
        const assetIdInp = qs('#al_picker_wrap input[name="asset_id"]', box);
        const codeVal = (assetInp ? assetInp.value : '').trim();
        const idVal = assetIdInp && assetIdInp.value ? Number(assetIdInp.value) : null;
        if (!codeVal && !idVal) return notify('Please pick a vehicle code from Assets.');

        const dateFromVal = qs('#al_date_from', box).value || todayD;
        const dateToVal = dateToEl.value || '';
        const isCurrentVal = !dateToVal && isCurEl.checked;
        if (dateToVal && dateToVal < dateFromVal) {
          return notify('To Date cannot be earlier than From Date.');
        }

        try {
          await api('/hire/allocations', {
            method: 'POST',
            body: {
              assetId: idVal,
              assetCode: codeVal,
              projectId: Number(qs('#al_proj', box).value),
              assignedBasis: qs('#al_basis', box).value,
              dateFrom: dateFromVal,
              dateTo: dateToVal || null,
              isCurrent: isCurrentVal,
              driverName: qs('#al_driver', box).value.trim(),
              notes: qs('#al_notes', box).value.trim(),
            },
          });
          toast('Machine allocated to project site!');
          loadAllocs();
        } catch (err) {
          notify(err.message);
        }
      };

      loadAllocs();
    }

    // =========================================================================
    // TAB 4: SPECIAL BREAKDOWN MONITORING & ADMIN DATE ADJUSTMENTS
    // =========================================================================
    async function renderBreakdownsTab(box) {
      let projects = [];
      try {
        const pRes = await api('/projects');
        projects = Array.isArray(pRes) ? pRes : (pRes.projects || []);
      } catch (_) {}

      const curM = currentMonthStr();
      const todayD = currentTodayStr();
      const adminCanAdjust = canAdjustBreakdowns();

      box.innerHTML = `
        <div class="card" style="padding:12px 14px;margin-bottom:14px;background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.2)">
          <div style="font-weight:700;font-size:13px;color:#b91c1c">🚨 Special Breakdown Monitoring &amp; Billing Protection</div>
          <div class="muted" style="font-size:12px;margin-top:3px">
            Machines with an <b>Open Breakdown</b> are <b>blocked from rental billing</b> until repaired/closed. Closed breakdown days are deducted from billing.
            Breakdown records sync automatically across <b>all sites' Job Cards &amp; Job Request descriptions</b>; Admins can adjust Start &amp; Close dates below.
          </div>
        </div>

        <div id="bd_kpis" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(175px, 1fr));gap:10px;margin-bottom:14px">
          <div class="card" style="padding:12px;border-left:4px solid #dc2626"><div class="muted" style="font-size:11px;font-weight:700">🚫 OPEN / REPAIR ACTIVE</div><div id="kpi_open" style="font-size:20px;font-weight:800;color:#dc2626;margin-top:4px">—</div></div>
          <div class="card" style="padding:12px;border-left:4px solid #f59e0b"><div class="muted" style="font-size:11px;font-weight:700">📅 REPAIR DOWNTIME DAYS</div><div id="kpi_days" style="font-size:20px;font-weight:800;margin-top:4px">—</div></div>
          <div class="card" style="padding:12px;border-left:4px solid #b45309"><div class="muted" style="font-size:11px;font-weight:700">🔧 WORKSHOP REPAIRS</div><div id="kpi_repair" style="font-size:20px;font-weight:800;color:#b45309;margin-top:4px">—</div></div>
          <div class="card" style="padding:12px;border-left:4px solid #7c3aed"><div class="muted" style="font-size:11px;font-weight:700">💸 LOST HIRE REVENUE</div><div id="kpi_loss" style="font-size:20px;font-weight:800;margin-top:4px">—</div></div>
          <div class="card" style="padding:12px;border-left:4px solid #991b1b"><div class="muted" style="font-size:11px;font-weight:700">🔥 TOTAL BD IMPACT</div><div id="kpi_impact" style="font-size:20px;font-weight:800;color:#991b1b;margin-top:4px">—</div></div>
          <div class="card" style="padding:12px;border-left:4px solid #3b82f6"><div class="muted" style="font-size:11px;font-weight:700">🏗️ SITES AFFECTED</div><div id="kpi_sites" style="font-size:20px;font-weight:800;margin-top:4px">—</div></div>
        </div>

        <div class="card" style="padding:12px;margin-bottom:14px">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px">🛠️ Log Manual Breakdown Period (Optional — Job Cards across all sites appear automatically)</div>
          <form id="form_bd" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:8px;align-items:flex-end">
            <div id="bd_picker_wrap" style="min-width:170px">
              ${assetPickerHtml('Vehicle Code *')}
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Site / Project</label>
              <select id="bd_proj" class="input sm" style="width:100%">
                <option value="">(Vehicle's Current Site)</option>
                ${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Start Date *</label>
              <input type="date" id="bd_start" required class="input sm" value="${todayD}" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Close Date (blank = Still Down)</label>
              <input type="date" id="bd_end" class="input sm" value="" style="width:100%">
            </div>
            <div style="grid-column:span 2">
              <label style="font-size:11px;font-weight:600">Breakdown Reason *</label>
              <input type="text" id="bd_reason" required class="input sm" placeholder="Hydraulic pump / engine failure" style="width:100%">
            </div>
            <div>
              <button type="submit" class="btn sm primary" style="width:100%">Record Breakdown</button>
            </div>
          </form>
        </div>

        <div class="card" style="padding:10px 12px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="bd_flt_search" class="input sm" placeholder="Search vehicle, job #, JR #, reason..." style="min-width:190px;flex:1">
          <label style="font-size:11px;display:flex;align-items:center;gap:4px">Month <input type="month" id="bd_flt_month" class="input sm" value=""></label>
          <select id="bd_flt_proj" class="input sm">
            <option value="">All Sites</option>
            ${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
          <select id="bd_flt_status" class="input sm">
            <option value="ALL">All Statuses</option>
            <option value="OPEN">🚫 Open / Billing Blocked</option>
            <option value="CLOSED">✅ Closed (Deducted)</option>
            <option value="WAIVED">Waived (No Downtime)</option>
          </select>
          <select id="bd_flt_source" class="input sm">
            <option value="ALL">All Sources</option>
            <option value="JOB_RECORDS">All-Site Job Records</option>
            <option value="MANUAL">Manual Logs</option>
            <option value="DAILY_CONDITION">Daily Conditions</option>
          </select>
          <select id="bd_flt_scope" class="input sm" title="Choose All Repair Jobs or Field/Flagged Breakdowns only">
            <option value="all">All Site Repair Jobs</option>
            <option value="flagged">Field / Breakdown Flagged Only</option>
          </select>
          <button class="btn sm primary" id="btn_bd_filter">Filter</button>
          <button class="btn sm" id="btn_bd_cur_month">This Month (${curM})</button>
        </div>

        <div class="card" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;margin:0;font-size:12.5px">
            <thead>
              <tr>
                <th style="padding:10px 12px">Vehicle</th>
                <th style="padding:10px 12px">Site / Project</th>
                <th style="padding:10px 12px">Job / Request Ref</th>
                <th style="padding:10px 12px">Breakdown Reason (JR Description)</th>
                <th style="padding:10px 12px">Start Date</th>
                <th style="padding:10px 12px">Close Date</th>
                <th style="padding:10px 12px;text-align:right">Days</th>
                <th style="padding:10px 12px">Billing Monitoring</th>
                ${adminCanAdjust ? '<th style="padding:10px 12px;text-align:center">Admin Adjust</th>' : ''}
              </tr>
            </thead>
            <tbody id="bd_tbody">
              <tr><td colspan="${adminCanAdjust ? 9 : 8}" class="muted" style="padding:20px;text-align:center">Loading breakdown monitoring...</td></tr>
            </tbody>
          </table>
        </div>
      `;

      wireAssetPicker(qs('#bd_picker_wrap', box));

      async function loadBds() {
        const tbody = qs('#bd_tbody', box);
        const q = new URLSearchParams();
        const m = qs('#bd_flt_month', box).value;
        const p = qs('#bd_flt_proj', box).value;
        const st = qs('#bd_flt_status', box).value;
        const src = qs('#bd_flt_source', box).value;
        const scp = qs('#bd_flt_scope', box).value;
        const srch = qs('#bd_flt_search', box).value.trim();
        if (m) q.set('month', m);
        if (p) q.set('projectId', p);
        if (st && st !== 'ALL') q.set('status', st);
        if (src && src !== 'ALL') q.set('source', src);
        if (scp) q.set('scopeMode', scp);
        if (srch) q.set('search', srch);

        try {
          const data = await api(`/hire/breakdowns?${q.toString()}`);
          const list = data.breakdowns || [];
          const sum = data.summary || {};

          qs('#kpi_open', box).textContent = `${sum.openCount || 0} (${sum.blockedAssetsCount || 0} units)`;
          qs('#kpi_days', box).textContent = `${sum.totalBreakdownDays || 0} d`;
          if (qs('#kpi_repair', box)) qs('#kpi_repair', box).textContent = fmtCents(sum.workshopRepairCostCents || 0);
          qs('#kpi_sites', box).textContent = `${sum.sitesAffected || 0}`;
          qs('#kpi_loss', box).textContent = fmtCents(sum.estimatedUnbillableCents || 0);
          if (qs('#kpi_impact', box)) qs('#kpi_impact', box).textContent = fmtCents(sum.totalBreakdownImpactCents || sum.estimatedUnbillableCents || 0);

          if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="${adminCanAdjust ? 9 : 8}" class="muted" style="padding:20px;text-align:center">No breakdowns found for this filter.</td></tr>`;
            return;
          }

          tbody.innerHTML = list.slice(0, 200).map((b, idx) => {
            const jobLink = b.job_card_id
              ? `<a href="#/jobs/${b.job_card_id}" style="font-weight:700">${esc(b.job_no)}</a>`
              : (b.job_no ? `<b>${esc(b.job_no)}</b>` : '');
            const jrTag = b.jr_no ? `<span class="badge">${esc(b.jr_no)}</span>` : '';
            const srcBadge = `<span class="muted" style="font-size:10px">${esc(b.source_type)}</span>`;

            const startHtml = `
              <div>${esc(b.breakdown_start || '—')}</div>
              ${b.admin_adjusted && b.orig_start_date && b.orig_start_date !== b.breakdown_start ? `<div class="muted" style="font-size:10px">orig: ${esc(b.orig_start_date)}</div>` : ''}
            `;
            const closeHtml = b.is_open
              ? '<span class="badge red">STILL DOWN</span>'
              : `<div>${esc(b.breakdown_end || '—')}</div>${b.admin_adjusted && b.orig_end_date !== b.breakdown_end ? `<div class="muted" style="font-size:10px">orig: ${esc(b.orig_end_date || 'open')}</div>` : ''}`;

            let billingBadge = '';
            if (b.status === 'WAIVED') {
              billingBadge = '<span class="badge">Waived (Billable)</span>';
            } else if (b.is_open) {
              billingBadge = '<span class="badge red">🚫 OPEN REPAIR (ACTIVE DAYS BILLABLE)</span>';
            } else {
              billingBadge = `<span class="badge amber">⚠️ Deducted (${b.period_days || b.total_days || 0}d)</span>${b.estimated_unbillable_cents ? `<div class="muted" style="font-size:10px">Lost Hire: ${fmtCents(b.estimated_unbillable_cents)}</div>` : ''}`;
            }
            if ((b.workshop_repair_cost_cents || 0) > 0) {
              billingBadge += `<div class="muted" style="font-size:10px">Repairs: ${fmtCents(b.workshop_repair_cost_cents)}</div>`;
            }
            if (b.has_fuel_during_repair) {
              billingBadge += `<div style="margin-top:2px"><span class="badge amber" style="font-size:9.5px" title="Site fuel dispensed during repair window (${esc((b.fuel_during_repair_dates || []).join(', '))}) — verify if machine actually worked &amp; adjust dates or waive">⚠️ Fuel logged in repair (${fmtNum(b.fuel_during_repair_litres || 0, 0)} L / ${b.fuel_during_repair_days || 0}d)</span></div>`;
            }

            return `
              <tr style="${b.is_open ? 'background:rgba(220,38,38,0.04)' : ''}">
                <td style="padding:9px 12px">
                  <a href="#/fuel?tab=vehicle-360&vehicle=${encodeURIComponent(b.vehicle_code || '')}" style="font-weight:700">${esc(b.vehicle_code || '—')}</a>
                  <div class="muted" style="font-size:11px">${esc([b.registration, b.category].filter(Boolean).join(' · '))}</div>
                </td>
                <td style="padding:9px 12px">
                  <b>${esc(b.project_name || '—')}</b>
                  ${b.workshop_name ? `<div class="muted" style="font-size:11px">${esc(b.workshop_name)}</div>` : ''}
                </td>
                <td style="padding:9px 12px">
                  <div>${jobLink} ${jrTag}</div>
                  <div>${srcBadge}${b.admin_adjusted ? ' <span class="badge blue" style="font-size:10px">Adjusted</span>' : ''}</div>
                </td>
                <td style="padding:9px 12px;max-width:280px">
                  <div>${esc(b.reason || 'Breakdown')}</div>
                  ${b.adjustment_note ? `<div class="muted" style="font-size:11px">Note: ${esc(b.adjustment_note)}</div>` : ''}
                </td>
                <td style="padding:9px 12px;white-space:nowrap">${startHtml}</td>
                <td style="padding:9px 12px;white-space:nowrap">${closeHtml}</td>
                <td style="padding:9px 12px;text-align:right;font-weight:700;color:${b.is_open ? '#dc2626' : '#d97706'}">${b.status === 'WAIVED' ? 0 : (b.period_days ?? b.total_days ?? 1)} d</td>
                <td style="padding:9px 12px">${billingBadge}</td>
                ${adminCanAdjust ? `<td style="padding:9px 12px;text-align:center;white-space:nowrap"><button class="btn sm btn-adj-bd" data-idx="${idx}">✏️ Adjust Dates</button></td>` : ''}
              </tr>
            `;
          }).join('');

          qsa('.btn-adj-bd', tbody).forEach((btn) => {
            btn.onclick = () => openAdjustBreakdownModal(list[Number(btn.getAttribute('data-idx'))], loadBds);
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="${adminCanAdjust ? 9 : 8}" class="err" style="padding:20px">${esc(err.message)}</td></tr>`;
        }
      }

      qs('#btn_bd_filter', box).onclick = loadBds;
      qs('#btn_bd_cur_month', box).onclick = () => { qs('#bd_flt_month', box).value = curM; loadBds(); };
      qs('#bd_flt_search', box).onkeydown = (e) => { if (e.key === 'Enter') loadBds(); };

      qs('#form_bd', box).onsubmit = async (e) => {
        e.preventDefault();
        const assetInp = qs('#bd_picker_wrap input[name="asset"]', box);
        const assetIdInp = qs('#bd_picker_wrap input[name="asset_id"]', box);
        const codeVal = (assetInp ? assetInp.value : '').trim();
        const idVal = assetIdInp && assetIdInp.value ? Number(assetIdInp.value) : null;
        if (!codeVal && !idVal) return notify('Select a vehicle code from Assets.');
        try {
          await api('/hire/breakdowns', {
            method: 'POST',
            body: {
              assetId: idVal,
              assetCode: codeVal,
              projectId: qs('#bd_proj', box).value ? Number(qs('#bd_proj', box).value) : null,
              breakdownStart: qs('#bd_start', box).value,
              breakdownEnd: qs('#bd_end', box).value || null,
              reason: qs('#bd_reason', box).value.trim(),
            },
          });
          toast('Breakdown logged!');
          qs('#bd_reason', box).value = '';
          loadBds();
        } catch (err) {
          notify(err.message);
        }
      };

      loadBds();
    }

    function openAdjustBreakdownModal(b, onDone) {
      const modalEl = document.createElement('div');
      modalEl.className = 'modal-bg modal-backdrop';
      modalEl.innerHTML = `
        <div class="modal" style="max-width:540px;padding:24px">
          <h2 style="margin:0 0 6px 0">✏️ Admin Adjust Breakdown Dates — ${esc(b.vehicle_code || '')}</h2>
          <p class="muted" style="margin:0 0 12px 0;font-size:12px">
            Site: <b>${esc(b.project_name || '—')}</b> · Ref: <b>${esc(b.job_no || b.jr_no || b.id)}</b>
            <br>Original Job Dates: <b>${esc(b.orig_start_date || '—')}</b> → <b>${esc(b.orig_end_date || 'Open / Not Closed')}</b>
          </p>
          <form id="form_adj_bd" style="display:flex;flex-direction:column;gap:10px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;font-weight:600">Start Date *</label>
                <input type="date" id="adj_start" required class="input sm" value="${esc(b.breakdown_start || '')}" style="width:100%">
              </div>
              <div>
                <label style="font-size:11px;font-weight:600">Close Date (blank = Still Down)</label>
                <div style="display:flex;gap:4px">
                  <input type="date" id="adj_end" class="input sm" value="${esc(b.breakdown_end || '')}" style="flex:1">
                  <button type="button" class="btn sm" id="btn_clear_end" title="Mark Still Down">Clear</button>
                </div>
              </div>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Billing Status</label>
              <select id="adj_status" class="input sm" style="width:100%">
                <option value="OPEN" ${b.status === 'OPEN' ? 'selected' : ''}>OPEN — Still Down (Block Billing)</option>
                <option value="CLOSED" ${b.status === 'CLOSED' ? 'selected' : ''}>CLOSED — Repaired on Close Date (Deduct Breakdown Days)</option>
                <option value="WAIVED" ${b.status === 'WAIVED' ? 'selected' : ''}>WAIVED — No Machine Downtime (Allow Full Billing)</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Breakdown Reason (Job Request Description)</label>
              <textarea id="adj_reason" rows="2" class="input sm" style="width:100%">${esc(b.reason || '')}</textarea>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600">Admin Adjustment Note</label>
              <input type="text" id="adj_note" class="input sm" value="${esc(b.adjustment_note || '')}" placeholder="e.g. Machine returned to service on site before card closed" style="width:100%">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
              <button type="button" class="btn sm" id="btn_adj_cancel">Cancel</button>
              <button type="submit" class="btn sm primary">Save Date Adjustment</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modalEl);

      const endInp = modalEl.querySelector('#adj_end');
      const statusSel = modalEl.querySelector('#adj_status');

      modalEl.querySelector('#btn_clear_end').onclick = () => {
        endInp.value = '';
        statusSel.value = 'OPEN';
      };
      endInp.onchange = () => {
        if (endInp.value && statusSel.value === 'OPEN') statusSel.value = 'CLOSED';
        if (!endInp.value && statusSel.value === 'CLOSED') statusSel.value = 'OPEN';
      };
      statusSel.onchange = () => {
        if (statusSel.value === 'OPEN') endInp.value = '';
        else if (statusSel.value === 'CLOSED' && !endInp.value) endInp.value = currentTodayStr();
      };

      modalEl.querySelector('#btn_adj_cancel').onclick = () => modalEl.remove();
      modalEl.onclick = (e) => { if (e.target === modalEl) modalEl.remove(); };

      modalEl.querySelector('#form_adj_bd').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(`/hire/breakdowns/${encodeURIComponent(b.key || b.id)}`, {
            method: 'PATCH',
            body: {
              breakdownStart: modalEl.querySelector('#adj_start').value,
              breakdownEnd: endInp.value || null,
              status: statusSel.value,
              reason: modalEl.querySelector('#adj_reason').value.trim(),
              adjustmentNote: modalEl.querySelector('#adj_note').value.trim(),
            },
          });
          toast('Breakdown dates updated!');
          modalEl.remove();
          if (onDone) onDone();
        } catch (err) {
          notify(err.message);
        }
      };
    }

    // =========================================================================
    // TAB 5: PAYMENTS & RECEIVABLES AGING
    // =========================================================================
    async function renderAgingTab(box) {
      box.innerHTML = `<div class="card muted" style="padding:24px;text-align:center">Loading Receivables Aging Report...</div>`;
      try {
        const { buckets, items } = await api('/hire/aging');
        box.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:10px;margin-bottom:14px">
            <div class="card" style="padding:12px;border-left:4px solid #10b981">
              <div class="muted" style="font-size:11px;font-weight:700">0–30 DAYS CURRENT</div>
              <div style="font-size:20px;font-weight:800;margin-top:4px">${fmtCents(buckets.b0_30.balance_cents)}</div>
              <div class="muted" style="font-size:11px">${buckets.b0_30.count} invoices</div>
            </div>
            <div class="card" style="padding:12px;border-left:4px solid #3b82f6">
              <div class="muted" style="font-size:11px;font-weight:700">31–60 DAYS</div>
              <div style="font-size:20px;font-weight:800;margin-top:4px">${fmtCents(buckets.b31_60.balance_cents)}</div>
              <div class="muted" style="font-size:11px">${buckets.b31_60.count} invoices</div>
            </div>
            <div class="card" style="padding:12px;border-left:4px solid #f59e0b">
              <div class="muted" style="font-size:11px;font-weight:700">61–90 DAYS</div>
              <div style="font-size:20px;font-weight:800;margin-top:4px">${fmtCents(buckets.b61_90.balance_cents)}</div>
              <div class="muted" style="font-size:11px">${buckets.b61_90.count} invoices</div>
            </div>
            <div class="card" style="padding:12px;border-left:4px solid #dc2626">
              <div class="muted" style="font-size:11px;font-weight:700">90+ DAYS OVERDUE</div>
              <div style="font-size:20px;font-weight:800;margin-top:4px;color:#dc2626">${fmtCents(buckets.b90_plus.balance_cents)}</div>
              <div class="muted" style="font-size:11px">${buckets.b90_plus.count} invoices</div>
            </div>
          </div>

          <div class="card" style="padding:0;overflow-x:auto">
            <table class="table" style="width:100%;margin:0;font-size:12.5px">
              <thead>
                <tr>
                  <th style="padding:10px 12px">Invoice #</th>
                  <th style="padding:10px 12px">Period</th>
                  <th style="padding:10px 12px">Vehicle</th>
                  <th style="padding:10px 12px">Project / Site</th>
                  <th style="padding:10px 12px;text-align:right">Grand Total</th>
                  <th style="padding:10px 12px;text-align:right">Paid</th>
                  <th style="padding:10px 12px;text-align:right">Balance Due</th>
                  <th style="padding:10px 12px">Aging Bucket</th>
                  <th style="padding:10px 12px;text-align:center">Action</th>
                </tr>
              </thead>
              <tbody>
                ${(items || []).map((i) => `
                  <tr>
                    <td style="padding:9px 12px;font-family:monospace;font-weight:700">${esc(i.invoice_number || i.id.slice(0, 10))}</td>
                    <td style="padding:9px 12px">${esc(i.period_key)}</td>
                    <td style="padding:9px 12px"><b>${esc(i.asset_code)}</b></td>
                    <td style="padding:9px 12px">${esc(i.project_name || 'Central')}</td>
                    <td style="padding:9px 12px;text-align:right">${fmtCents(i.grand_total_cents)}</td>
                    <td style="padding:9px 12px;text-align:right;color:#059669">${fmtCents(i.paid_cents)}</td>
                    <td style="padding:9px 12px;text-align:right;font-weight:800;color:${i.balance_cents > 0 ? '#dc2626' : '#059669'}">${fmtCents(i.balance_cents)}</td>
                    <td style="padding:9px 12px"><span class="badge ${i.aging_bucket === '90+' ? 'danger' : (i.aging_bucket === 'PAID' ? 'ok' : 'warn')}">${esc(i.aging_bucket)} (${i.age_days}d)</span></td>
                    <td style="padding:9px 12px;text-align:center">
                      <button class="btn sm primary btn-age-pay" data-id="${esc(i.id)}">💰 Pay / View</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;

        qsa('.btn-age-pay', box).forEach((b) => {
          b.onclick = () => openBillDetailModal(b.getAttribute('data-id'), () => renderAgingTab(box));
        });
      } catch (err) {
        box.innerHTML = `<div class="card err" style="padding:24px">${esc(err.message)}</div>`;
      }
    }

    switchTab(activeTab);
  }

  if (typeof window !== 'undefined') {
    window.routes = window.routes || {};
    window.routes['hire-billing'] = renderHireBilling;
    window.routes['hire'] = renderHireBilling;
  }
})();
