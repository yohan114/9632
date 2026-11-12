'use strict';
/* =============================================================================
 * WorkshopOne - Single-Vehicle Comprehensive Costing & Profitability Statement
 * Combines Hiring Revenue, Workshop Repairs, Diesel Logs, and Driver Costs
 * ============================================================================= */

(function () {
  const routes = window.routes = window.routes || {};

  routes.vehiclecosting = async function (c) {
    if (!canView('costing')) {
      c.innerHTML = `
        <div class="card err" style="margin-top:20px">
          <h2>Access Restricted</h2>
          <p class="muted">You do not have permission to view Vehicle Costing reports. Please contact your System Administrator.</p>
          <a class="btn sm" href="#/dashboard">← Return to Dashboard</a>
        </div>`;
      return;
    }

    const sp = new URLSearchParams(location.hash.split('?')[1] || '');
    const initialAssetId = sp.get('asset_id') || '';
    const nowMonth = new Date().toISOString().slice(0, 7);
    const initialMonth = sp.get('month') || nowMonth;

    let assets = [];
    try { assets = await api('/assets'); } catch {}

    const assetOptions = assets.map((a) => {
      const isSel = String(a.id) === String(initialAssetId) ? 'selected' : '';
      return `<option value="${a.id}" ${isSel}>${esc(a.code)} — ${esc(a.registration || 'No Reg')} (${esc(a.type || a.brand || 'Vehicle')})</option>`;
    }).join('');

    c.innerHTML = `
      <div class="no-print">
        ${pageHeader('Vehicle Costing & Profitability Statement', 'Monthly audit: Revenue, Repairs, Diesel, and Operational Overhead')}
        <div class="card" style="margin-bottom:16px">
          <div style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:260px">
              <label>Select Vehicle / Machine</label>
              <select id="costing-asset-select">
                <option value="">— Select Vehicle / Machine —</option>
                ${assetOptions}
              </select>
            </div>
            <div style="width:160px">
              <label>Month</label>
              <input type="month" id="costing-month-input" value="${esc(initialMonth)}">
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn primary" id="btn-costing-generate">📊 Generate Statement</button>
              <button class="btn" id="btn-costing-print">🖨️ Print Statement</button>
            </div>
            <div class="spacer"></div>
            <div style="display:flex;gap:8px">
              ${canAdd('costing') ? '<button class="btn sm" id="btn-add-revenue">➕ Log Hiring Revenue</button>' : ''}
              ${canAdd('costing') ? '<button class="btn sm" id="btn-add-driver-cost">➕ Log Driver / Site Cost</button>' : ''}
            </div>
          </div>
        </div>
      </div>
      <div id="costing-report-pane"><div class="muted">Select a vehicle and click "Generate Statement" to view the comprehensive costing report.</div></div>
    `;

    const selAsset = qs('#costing-asset-select', c);
    const inMonth = qs('#costing-month-input', c);
    const btnGen = qs('#btn-costing-generate', c);
    const btnPrint = qs('#btn-costing-print', c);
    const btnAddRev = qs('#btn-add-revenue', c);
    const btnAddCost = qs('#btn-add-driver-cost', c);

    const loadReport = async () => {
      const assetId = selAsset.value;
      const m = inMonth.value || nowMonth;
      if (!assetId) {
        toast('Please select a vehicle', 'err');
        return;
      }
      history.replaceState(null, '', `#/vehiclecosting?asset_id=${assetId}&month=${m}`);
      await renderCostingReport(assetId, m, qs('#costing-report-pane', c));
    };

    btnGen.onclick = loadReport;
    btnPrint.onclick = () => window.print();

    if (btnAddRev) {
      btnAddRev.onclick = () => openAddRevenueModal(selAsset.value, inMonth.value, loadReport);
    }
    if (btnAddCost) {
      btnAddCost.onclick = () => openAddDriverCostModal(selAsset.value, inMonth.value, loadReport);
    }

    if (initialAssetId) {
      loadReport();
    }
  };

  async function renderCostingReport(assetId, month, container) {
    container.innerHTML = '<div class="muted">Loading costing records and calculating margins…</div>';
    try {
      const rep = await api(`/vehicle-costing/report?asset_id=${assetId}&month=${month}`);
      const asset = rep.asset;
      const s = rep.summary;
      const [year, moNum] = month.split('-');
      const monthLabel = monthName(month);

      const profitCls = s.final_net_profit >= 0 ? 'color:#15803d' : 'color:#b91c1c';
      const profitBg = s.final_net_profit >= 0 ? 'background:rgba(34,197,94,0.08);border-color:#86efac' : 'background:rgba(239,68,68,0.08);border-color:#fca5a5';

      const bd = rep.breakdown || {};
      const revItems = (bd.hiring_revenue && (bd.hiring_revenue.direct_revenue_lines || bd.hiring_revenue.items)) || [];
      const billItems = (bd.hiring_revenue && bd.hiring_revenue.billing_lines) || [];
      const repairData = bd.repair_costs || bd.repairs || {};
      const jcItems = repairData.job_cards || repairData.job_parts || [];
      const storeItems = repairData.store_issues || [];
      const oilItems = repairData.service_oils || [];
      const filterItems = repairData.service_filters || [];
      const dieselData = bd.diesel_costs || bd.diesel || {};
      const dieselItems = dieselData.issues || dieselData.dispenses || [];
      const driverData = bd.driver_and_other_costs || bd.driver_other || {};
      const driverItems = driverData.lines || driverData.items || [];

      // -----------------------------------------------------------------------
      // 1. Hiring Revenue Lines
      // -----------------------------------------------------------------------
      const allRev = [
        ...revItems.map((r) => `
          <tr>
            <td>${esc(r.date || month)}</td>
            <td><b>${esc((r.hire_type || 'hire').toUpperCase())}</b></td>
            <td class="num">${num(r.quantity)}</td>
            <td class="num">${money(r.hire_rate)}</td>
            <td class="num"><b>${money(r.total_revenue || (r.quantity * r.hire_rate))}</b></td>
            <td>${esc(r.invoice_no || '—')}</td>
            <td>${esc(r.project_name || 'Central')}</td>
            <td>${esc(r.notes || '—')}</td>
          </tr>
        `),
        ...billItems.map((b) => `
          <tr>
            <td>${esc(b.period_start || month)}</td>
            <td><b>EQUIPMENT BILLING</b></td>
            <td class="num">${num(b.hours_or_days)}</td>
            <td class="num">${money(b.rate)}</td>
            <td class="num"><b>${money(b.net_amount || b.base_amount)}</b></td>
            <td>${esc(b.bill_no || '—')}</td>
            <td>${esc(b.project_name || 'Project')}</td>
            <td>Monthly hire invoice</td>
          </tr>
        `)
      ];
      const revHeaders = [
        { label: 'Date' }, { label: 'Hire Basis' }, { label: 'Qty / Hours', num: true },
        { label: 'Hire Rate (LKR)', num: true }, { label: 'Total Revenue (LKR)', num: true },
        { label: 'Invoice / Bill No' }, { label: 'Site / Project' }, { label: 'Notes' }
      ];

      // -----------------------------------------------------------------------
      // 2. Workshop Repairs Lines
      // -----------------------------------------------------------------------
      // a) Job Cards
      const jcRows = jcItems.map((j) => `
        <tr>
          <td><b>${esc(j.job_no)}</b></td>
          <td>${esc(j.completed_at ? j.completed_at.slice(0, 10) : j.created_at ? j.created_at.slice(0, 10) : '—')}</td>
          <td>${esc(j.job_type || 'Repair')}</td>
          <td>${esc(j.lead_mechanic || j.mechanic || '—')}</td>
          <td class="num">${money(j.parts_cost || j.unit_cost || 0)}</td>
          <td class="num">${money(j.labour_cost || 0)}</td>
          <td class="num"><b>${money(j.total_cost || 0)}</b></td>
          <td>${esc(j.description || '—')}</td>
        </tr>
      `);
      const jcHeaders = [
        { label: 'Job Card #' }, { label: 'Date' }, { label: 'Job Type' },
        { label: 'Lead Mechanic' }, { label: 'Parts Cost', num: true },
        { label: 'Labour Cost', num: true }, { label: 'Total Repair (LKR)', num: true },
        { label: 'Remarks / Fault' }
      ];

      // b) Store Material Issues
      const storeRows = storeItems.map((i) => `
        <tr>
          <td><b>${esc(i.issue_no || ('#' + i.id))}</b></td>
          <td>${esc(i.issue_date || (i.created_at ? i.created_at.slice(0, 10) : '—'))}</td>
          <td><b>${esc(i.item_description || i.item_code || 'Store Item')}</b></td>
          <td>${esc(i.recipient_name || i.issued_to_name || 'Mechanic')}</td>
          <td class="num">${num(i.quantity || i.qty)} ${esc(i.unit || '')}</td>
          <td class="num">${money(i.unit_price)}</td>
          <td class="num"><b>${money(i.total_price || i.total_cost)}</b></td>
        </tr>
      `);
      const storeHeaders = [
        { label: 'Issue / MRN #' }, { label: 'Date' }, { label: 'Material Description' },
        { label: 'Recipient Name' }, { label: 'Quantity', num: true },
        { label: 'Unit Price', num: true }, { label: 'Total (LKR)', num: true }
      ];

      // c) PM Oils & Filters
      const pmRows = [
        ...oilItems.map((o) => `
          <tr>
            <td>${esc(o.service_date || '—')}</td>
            <td>🛢️ Oil: <b>${esc(o.oil_type || o.oil_name || 'Engine Oil')}</b></td>
            <td class="num">${num(o.qty)} L</td>
            <td class="num">${money(o.price)}</td>
            <td class="num"><b>${money(o.total_cost)}</b></td>
          </tr>
        `),
        ...filterItems.map((f) => `
          <tr>
            <td>${esc(f.service_date || '—')}</td>
            <td>🛞 Filter: <b>${esc(f.filter_type || f.filter_no || 'Filter')}</b></td>
            <td class="num">${num(f.qty)} Nos</td>
            <td class="num">${money(f.price)}</td>
            <td class="num"><b>${money(f.total_cost)}</b></td>
          </tr>
        `)
      ];
      const pmHeaders = [
        { label: 'Service Date' }, { label: 'Lubricant / Filter Item' },
        { label: 'Quantity', num: true }, { label: 'Unit Price', num: true },
        { label: 'Total (LKR)', num: true }
      ];

      // -----------------------------------------------------------------------
      // 3. Diesel Dispense Logs
      // -----------------------------------------------------------------------
      const dieselRows = dieselItems.map((d) => `
        <tr>
          <td><b>${esc(d.issue_no || ('#' + d.id))}</b></td>
          <td>${esc(d.date || d.issue_date || '—')}</td>
          <td>${esc(d.bulk_tank_name || d.tank_name || 'Bulk Tank')}</td>
          <td class="num"><b>${num(d.litres)} L</b></td>
          <td class="num">${money(d.unit_price)}</td>
          <td class="num"><b>${money(d.total_price || d.total_cost)}</b></td>
          <td class="num">${d.meter_reading ? num(d.meter_reading) + ' ' + (d.meter_type || 'hrs') : '—'}</td>
          <td>${esc(d.driver_name || d.recipient_name || d.issued_by_name || '—')}</td>
          <td>${esc(d.notes || d.purpose || '—')}</td>
        </tr>
      `);
      const dieselHeaders = [
        { label: 'Dispense #' }, { label: 'Date' }, { label: 'Storage Tank' },
        { label: 'Litres Issued', num: true }, { label: 'Price/L', num: true },
        { label: 'Total Cost (LKR)', num: true }, { label: 'Meter Reading', num: true },
        { label: 'Driver / Operator' }, { label: 'Remarks' }
      ];

      // -----------------------------------------------------------------------
      // 4. Driver & Other Costs
      // -----------------------------------------------------------------------
      const driverRows = driverItems.map((c) => `
        <tr>
          <td>${esc(c.date || month)}</td>
          <td><b>${esc((c.cost_type || 'salary').replace(/_/g, ' ').toUpperCase())}</b></td>
          <td>${esc(c.driver_name || '—')}</td>
          <td class="num">${money(c.driver_salary || 0)}</td>
          <td class="num">${money(c.bata_ot || 0)}</td>
          <td class="num">${money(c.other_expenses || 0)}</td>
          <td class="num"><b>${money(c.amount)}</b></td>
          <td>${esc(c.description || c.receipt_no || '—')}</td>
        </tr>
      `);
      const driverHeaders = [
        { label: 'Date' }, { label: 'Expense Category' }, { label: 'Driver / Staff' },
        { label: 'Base Salary', num: true }, { label: 'Bata / OT', num: true },
        { label: 'Site Expenses', num: true }, { label: 'Total Amount (LKR)', num: true },
        { label: 'Description / Receipt' }
      ];

      // Complete Printable Statement HTML
      container.innerHTML = `
        <div class="costing-statement-sheet card" style="background:#fff;color:#1e293b;padding:24px;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1)">
          
          <!-- Corporate Header -->
          <div style="border-bottom:2px solid #0f172a;padding-bottom:12px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div style="font-size:20px;font-weight:800;letter-spacing:-0.02em;color:#0f172a">EDWARD AND CHRISTIE (PVT) LTD</div>
              <div style="font-size:13px;font-weight:600;color:#475569;margin-top:2px">CENTRAL WORKSHOP & FLEET MANAGEMENT DIVISION — BADALGAMA</div>
              <div style="font-size:16px;font-weight:700;color:#0369a1;margin-top:6px">MONTHLY VEHICLE COSTING & PROFITABILITY STATEMENT</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:12px;color:#64748b">Report Period</div>
              <div style="font-size:16px;font-weight:700;color:#0f172a">${esc(monthLabel)}</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:4px">Generated: ${today()}</div>
            </div>
          </div>

          <!-- Vehicle Specs Plate -->
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin-bottom:18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
            <div>
              <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Machine Code</div>
              <div style="font-size:16px;font-weight:800;color:#0f172a">${esc(asset.code)}</div>
            </div>
            <div>
              <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Registration No</div>
              <div style="font-size:14px;font-weight:700;color:#334155">${esc(asset.registration || 'Unregistered')}</div>
            </div>
            <div>
              <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Make & Model</div>
              <div style="font-size:14px;font-weight:600;color:#334155">${esc(asset.brand || '')} ${esc(asset.type || '')}</div>
            </div>
            <div>
              <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Category</div>
              <div style="font-size:14px;font-weight:600;color:#334155">${esc(asset.category || 'General Equipment')}</div>
            </div>
            <div>
              <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Current Project</div>
              <div style="font-size:14px;font-weight:600;color:#334155">${esc(asset.project_name || 'Central')}</div>
            </div>
            <div>
              <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Cumulative Hours</div>
              <div style="font-size:14px;font-weight:700;color:#0369a1">${num(asset.current_hours || 0)} hrs</div>
            </div>
          </div>

          <!-- Executive Summary Scorecard -->
          <div style="border:2px solid;border-radius:8px;padding:16px;margin-bottom:24px;${profitBg}">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
              <div>
                <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase">Hiring Revenue</div>
                <div style="font-size:22px;font-weight:800;color:#0f172a">${money(s.monthly_hiring_revenue)}</div>
                <div style="font-size:11px;color:#64748b">Site billing / direct rate</div>
              </div>
              <div>
                <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase">Repair & Maintenance</div>
                <div style="font-size:22px;font-weight:800;color:#c2410c">${money(s.monthly_vehicle_repair_cost)}</div>
                <div style="font-size:11px;color:#64748b">Job cards, parts & materials</div>
              </div>
              <div>
                <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase">Diesel Fuel Cost</div>
                <div style="font-size:22px;font-weight:800;color:#b45309">${money(s.monthly_diesel_cost)}</div>
                <div style="font-size:11px;color:#64748b">${num(rep.breakdown.diesel.total_litres)} Litres dispensed</div>
              </div>
              <div>
                <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase">Driver & Other Costs</div>
                <div style="font-size:22px;font-weight:800;color:#7c2d12">${money(s.monthly_driver_other_costs)}</div>
                <div style="font-size:11px;color:#64748b">Salary, bata, OT & expenses</div>
              </div>
            </div>

            <div style="margin-top:14px;padding-top:12px;border-top:1px dashed #cbd5e1;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
              <div>
                <span style="font-size:13px;font-weight:700;color:#475569">TOTAL OPERATING EXPENSES:</span>
                <span style="font-size:18px;font-weight:800;color:#475569;margin-left:8px">${money(s.total_expenses)}</span>
              </div>
              <div>
                <span style="font-size:14px;font-weight:800;text-transform:uppercase;color:#0f172a">FINAL NET PROFIT / (LOSS):</span>
                <span style="font-size:24px;font-weight:900;margin-left:10px;${profitCls}">${money(s.final_net_profit)}</span>
                <span style="font-size:13px;font-weight:700;margin-left:8px;${profitCls}">(${s.profit_margin_percent}% Margin)</span>
              </div>
            </div>
          </div>

          <!-- Section 1: Hiring Revenue Breakdown -->
          <div style="margin-bottom:24px">
            <div style="font-size:15px;font-weight:800;color:#0f172a;margin-bottom:8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;display:flex;justify-content:space-between">
              <span>1. VEHICLE HIRING REVENUE BREAKDOWN</span>
              <span style="color:#0369a1">${money(s.monthly_hiring_revenue)}</span>
            </div>
            ${tableWrap(revHeaders, allRev, { noHScroll: true })}
          </div>

          <!-- Section 2: Workshop Repairs & Material Issues -->
          <div style="margin-bottom:24px">
            <div style="font-size:15px;font-weight:800;color:#0f172a;margin-bottom:8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;display:flex;justify-content:space-between">
              <span>2. WORKSHOP REPAIRS & STORE MATERIAL ISSUES</span>
              <span style="color:#c2410c">${money(s.monthly_vehicle_repair_cost)}</span>
            </div>
            <div style="font-weight:700;font-size:12px;color:#475569;margin:8px 0 4px">A) Completed Job Cards (Labour & Parts)</div>
            ${tableWrap(jcHeaders, jcRows, { noHScroll: true })}

            <div style="font-weight:700;font-size:12px;color:#475569;margin:12px 0 4px">B) Store Material Issues (Spare Parts & Materials with Recipient)</div>
            ${tableWrap(storeHeaders, storeRows, { noHScroll: true })}

            ${pmRows.length ? `
              <div style="font-weight:700;font-size:12px;color:#475569;margin:12px 0 4px">C) Preventative Maintenance Oils & Filters</div>
              ${tableWrap(pmHeaders, pmRows, { noHScroll: true })}
            ` : ''}
          </div>

          <!-- Section 3: Diesel Consumption & Fuel Dispense Logs -->
          <div style="margin-bottom:24px">
            <div style="font-size:15px;font-weight:800;color:#0f172a;margin-bottom:8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;display:flex;justify-content:space-between">
              <span>3. DIESEL CONSUMPTION & FUEL DISPENSE LOGS</span>
              <span style="color:#b45309">${money(s.monthly_diesel_cost)}</span>
            </div>
            ${tableWrap(dieselHeaders, dieselRows, { noHScroll: true })}
          </div>

          <!-- Section 4: Driver & Operational Overhead -->
          <div style="margin-bottom:28px">
            <div style="font-size:15px;font-weight:800;color:#0f172a;margin-bottom:8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;display:flex;justify-content:space-between">
              <span>4. DRIVER & OTHER VEHICLE OPERATING EXPENSES</span>
              <span style="color:#7c2d12">${money(s.monthly_driver_other_costs)}</span>
            </div>
            ${tableWrap(driverHeaders, driverRows, { noHScroll: true })}
          </div>

          <!-- Sign-Off & Verification Footer -->
          <div style="margin-top:36px;padding-top:20px;border-top:1px solid #94a3b8;display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;text-align:center">
            <div>
              <div style="height:45px"></div>
              <div style="border-top:1px solid #475569;padding-top:4px;font-size:12px;font-weight:700;color:#334155">Prepared By</div>
              <div style="font-size:11px;color:#64748b">Fleet Costing Clerk</div>
            </div>
            <div>
              <div style="height:45px"></div>
              <div style="border-top:1px solid #475569;padding-top:4px;font-size:12px;font-weight:700;color:#334155">Checked & Verified</div>
              <div style="font-size:11px;color:#64748b">Workshop Engineer / Accountant</div>
            </div>
            <div>
              <div style="height:45px"></div>
              <div style="border-top:1px solid #475569;padding-top:4px;font-size:12px;font-weight:700;color:#334155">Approved By</div>
              <div style="font-size:11px;color:#64748b">General Manager / Director</div>
            </div>
          </div>

        </div>
      `;
    } catch (e) {
      container.innerHTML = `<div class="card err">Failed to generate vehicle costing report: ${esc(e.message)}</div>`;
    }
  }

  // ===========================================================================
  // REVENUE & DRIVER COST MODALS
  // ===========================================================================

  // 1. Add Vehicle Hiring Revenue Modal
  async function openAddRevenueModal(preAssetId, preMonth, onSuccess) {
    let assets = [], projects = [];
    try {
      [assets, projects] = await Promise.all([
        api('/assets'),
        api('/projects').catch(() => [])
      ]);
    } catch { return; }

    const assetOpts = assets.map((a) => ({
      value: a.id,
      label: `${a.code} — ${a.registration || 'No Reg'} (${a.type || a.brand || 'Vehicle'})`
    }));
    const projOpts = projects.map((p) => ({ value: p.id, label: p.name }));
    const nowMonth = preMonth || new Date().toISOString().slice(0, 7);

    modal('Record Vehicle Hiring Revenue', `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>${field('Vehicle / Machine', 'asset_id', { type: 'select', value: preAssetId, options: [{ value: '', label: '— Select Asset —' }, ...assetOpts] })}</div>
        <div>${field('Site / Project', 'project_id', { type: 'select', options: [{ value: '', label: '— Central / Direct —' }, ...projOpts] })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Month', 'month', { type: 'month', value: nowMonth })}</div>
        <div>${field('Date', 'date', { type: 'date', value: today() })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Hire Basis Type', 'hire_type', { type: 'select', options: [{ value: 'hours', label: 'Hourly' }, { value: 'days', label: 'Daily' }, { value: 'monthly', label: 'Monthly' }, { value: 'fixed', label: 'Fixed Contract' }] })}</div>
        <div>${field('Hours / Days Quantity', 'quantity', { type: 'number', step: '0.5', placeholder: 'e.g. 180' })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Hire Rate (LKR)', 'hire_rate', { type: 'number', step: '100', placeholder: 'e.g. 4500' })}</div>
        <div>
          <label>Calculated Revenue</label>
          <div id="rev-total-preview" style="font-size:16px;font-weight:700;padding:8px 0;color:var(--primary)">Rs 0.00</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Invoice / Billing Ref', 'invoice_no', { placeholder: 'e.g. INV-2026-088' })}</div>
        <div>${field('Notes / Work Done', 'notes', { placeholder: 'Site excavation, haulage, etc.' })}</div>
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-revenue">Save Hiring Revenue</button>
      </div>
    `, (mbody, close) => {
      const qQty = qs('input[name="quantity"]', mbody);
      const qRate = qs('input[name="hire_rate"]', mbody);
      const qPrev = qs('#rev-total-preview', mbody);

      const updateCalc = () => {
        const q = Number(qQty.value) || 0;
        const r = Number(qRate.value) || 0;
        qPrev.textContent = money(q * r);
      };
      qQty.oninput = updateCalc;
      qRate.oninput = updateCalc;

      qs('#btn-submit-revenue', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.asset_id || !d.quantity || !d.hire_rate) {
          toast('Please complete vehicle, quantity, and rate', 'err');
          return;
        }
        try {
          await api('/vehicle-costing/revenue', {
            method: 'POST',
            body: {
              asset_id: parseInt(d.asset_id, 10),
              project_id: d.project_id ? parseInt(d.project_id, 10) : undefined,
              month: d.month,
              date: d.date,
              hire_type: d.hire_type,
              quantity: Number(d.quantity),
              hire_rate: Number(d.hire_rate),
              invoice_no: d.invoice_no,
              notes: d.notes
            }
          });
          toast('Hiring revenue recorded');
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    }, { wide: true });
  }

  // 2. Add Driver & Other Costs Modal
  async function openAddDriverCostModal(preAssetId, preMonth, onSuccess) {
    let assets = [], projects = [];
    try {
      [assets, projects] = await Promise.all([
        api('/assets'),
        api('/projects').catch(() => [])
      ]);
    } catch { return; }

    const assetOpts = assets.map((a) => ({
      value: a.id,
      label: `${a.code} — ${a.registration || 'No Reg'} (${a.type || a.brand || 'Vehicle'})`
    }));
    const projOpts = projects.map((p) => ({ value: p.id, label: p.name }));
    const nowMonth = preMonth || new Date().toISOString().slice(0, 7);

    modal('Record Driver & Other Vehicle Costs', `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>${field('Vehicle / Machine', 'asset_id', { type: 'select', value: preAssetId, options: [{ value: '', label: '— Select Asset —' }, ...assetOpts] })}</div>
        <div>${field('Cost Category', 'cost_type', { type: 'select', options: [
          { value: 'driver_salary', label: 'Driver Monthly Salary' },
          { value: 'bata_ot', label: 'Driver Bata / Overtime' },
          { value: 'fuel_oil_local', label: 'Local Emergency Fuel / Top-up' },
          { value: 'maintenance_other', label: 'Outside / Site Repair Services' },
          { value: 'insurance_revenue_license', label: 'Revenue License & Insurance' }
        ] })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Month', 'month', { type: 'month', value: nowMonth })}</div>
        <div>${field('Date', 'date', { type: 'date', value: today() })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Driver / Payee Name', 'driver_name', { placeholder: 'e.g. S. Bandara' })}</div>
        <div>${field('Site / Project', 'project_id', { type: 'select', options: [{ value: '', label: '— Central —' }, ...projOpts] })}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:8px">
        <div>${field('Driver Salary (LKR)', 'driver_salary', { type: 'number', step: '100', placeholder: '0.00' })}</div>
        <div>${field('Bata / OT (LKR)', 'bata_ot', { type: 'number', step: '100', placeholder: '0.00' })}</div>
        <div>${field('Other Expenses (LKR)', 'other_expenses', { type: 'number', step: '100', placeholder: '0.00' })}</div>
      </div>
      <div style="margin-top:8px">
        <label>Total Operating Cost</label>
        <div id="cost-total-preview" style="font-size:16px;font-weight:700;padding:6px 0;color:var(--primary)">Rs 0.00</div>
      </div>
      <div style="margin-top:8px">
        ${field('Description / Receipt / Voucher Ref', 'description', { placeholder: 'Voucher number or payment details' })}
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn primary" id="btn-submit-cost">Save Vehicle Cost</button>
      </div>
    `, (mbody, close) => {
      const qSal = qs('input[name="driver_salary"]', mbody);
      const qBata = qs('input[name="bata_ot"]', mbody);
      const qOther = qs('input[name="other_expenses"]', mbody);
      const qPrev = qs('#cost-total-preview', mbody);

      const updateCalc = () => {
        const s = Number(qSal.value) || 0;
        const b = Number(qBata.value) || 0;
        const o = Number(qOther.value) || 0;
        qPrev.textContent = money(s + b + o);
      };
      qSal.oninput = updateCalc;
      qBata.oninput = updateCalc;
      qOther.oninput = updateCalc;

      qs('#btn-submit-cost', mbody).onclick = async () => {
        const d = formData(mbody);
        if (!d.asset_id) { toast('Please select an asset', 'err'); return; }
        const s = Number(d.driver_salary) || 0;
        const b = Number(d.bata_ot) || 0;
        const o = Number(d.other_expenses) || 0;
        if (s + b + o <= 0) { toast('Please enter an amount', 'err'); return; }

        try {
          await api('/vehicle-costing/driver-costs', {
            method: 'POST',
            body: {
              asset_id: parseInt(d.asset_id, 10),
              project_id: d.project_id ? parseInt(d.project_id, 10) : undefined,
              month: d.month,
              date: d.date,
              cost_type: d.cost_type,
              driver_name: d.driver_name,
              driver_salary: s,
              bata_ot: b,
              other_expenses: o,
              description: d.description
            }
          });
          toast('Driver & vehicle cost recorded');
          close();
          if (onSuccess) onSuccess();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    }, { wide: true });
  }

  // Expose modals for master dashboard
  window.openAddRevenueModal = openAddRevenueModal;
  window.openAddDriverCostModal = openAddDriverCostModal;
})();
