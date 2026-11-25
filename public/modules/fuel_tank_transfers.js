'use strict';

/**
 * Shared Bulk Tank-to-Tank Fuel Transfer Request Module
 *
 * Exposes on window:
 *   openTankTransferRequestModal(defaults, onDone)
 *   openTankTransferReviewModal(tr, bootstrap, onDone)
 *   openTankTransferDispatchModal(tr, bootstrap, onDone)
 *   openTankTransferReceiveModal(tr, onDone)
 *   openTankTransferCancelModal(tr, onDone)
 *   renderTankTransfersPanel(box, opts)
 */
(function () {
  function notify(msg, kind = 'err') {
    if (typeof toast === 'function') toast(msg, kind);
    else console[kind === 'err' ? 'error' : 'log'](msg);
  }

  function fmtNum(val, dec = 1) {
    if (val === null || val === undefined || isNaN(Number(val))) return '—';
    return Number(val).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function localTodayStr() {
    if (typeof slToday === 'function') return slToday();
    return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function bowserBadge(tr) {
    if (!tr.bowser_code && !tr.bowser_display && !tr.bowser_ec_code) return '<span class="muted">Not assigned</span>';
    if (typeof window.fmtVehicleBadge === 'function') {
      return window.fmtVehicleBadge({
        code: tr.bowser_code,
        ec_code: tr.bowser_ec_code,
        registration: tr.bowser_registration,
        asset_display: tr.bowser_display,
      });
    }
    return `<b>${esc(tr.bowser_display || tr.bowser_code)}</b>`;
  }

  function bowserText(v) {
    if (!v) return '';
    if (typeof window.fmtVehicleText === 'function') return window.fmtVehicleText(v);
    return v.display || v.code || '';
  }

  function transferStatusBadge(tr) {
    const st = String(tr.status || '').toUpperCase();
    if (st === 'PENDING') return '<span class="badge warn" style="background:#d97706;color:#fff">AWAITING TRANSPORT</span>';
    if (st === 'APPROVED') return '<span class="badge" style="background:#2563eb;color:#fff">READY TO DISPATCH</span>';
    if (st === 'IN_TRANSIT') return '<span class="badge" style="background:#7c3aed;color:#fff">🚚 IN TRANSIT</span>';
    if (st === 'RECEIVED') return '<span class="badge ok" style="background:#059669;color:#fff">✓ RECEIVED</span>';
    if (st === 'REJECTED') return '<span class="badge danger" style="background:#dc2626;color:#fff">REJECTED</span>';
    if (st === 'CANCELLED') return '<span class="badge" style="background:#64748b;color:#fff">CANCELLED</span>';
    return `<span class="badge">${esc(st)}</span>`;
  }

  function canReviewTransfer() {
    if (typeof isAdmin === 'function' && isAdmin()) return true;
    return typeof canDo === 'function' && canDo('fuel.approve_request', 'fuel.approve', 'fuel.transfer', 'fuel.tanks.manage');
  }

  function canDispatchTransfer(tr) {
    if (typeof isAdmin === 'function' && isAdmin()) return true;
    if (!(typeof canDo === 'function' && canDo('fuel.issue', 'fuel.transfer', 'fuel.tanks.refill'))) return false;
    const sc = (typeof ME !== 'undefined' && ME && ME.fuelScope) || {};
    if (sc.scoped) {
      const allowed = (sc.allowedTankIds || []).map(String);
      return allowed.includes(String(tr.source_tank_id));
    }
    return true;
  }

  function canReceiveTransfer(tr) {
    if (typeof isAdmin === 'function' && isAdmin()) return true;
    if (!(typeof canDo === 'function' && canDo('fuel.tanks.refill', 'fuel.issue', 'fuel.transfer'))) return false;
    const sc = (typeof ME !== 'undefined' && ME && ME.fuelScope) || {};
    if (sc.scoped) {
      const allowed = (sc.allowedTankIds || []).map(String);
      return allowed.includes(String(tr.dest_tank_id));
    }
    return true;
  }

  async function fetchBootstrap() {
    try {
      return await api('/fuel/tank-transfers/bootstrap');
    } catch (_) {
      return { sourceTanks: [], destTanks: [], bowsers: [], fuelScope: {} };
    }
  }

  function renderBowserOptions(bowsers, selectedId, selectedCode) {
    return (bowsers || []).map((b) => {
      const sel = (selectedId && String(b.id) === String(selectedId))
        || (!selectedId && selectedCode && [b.code, b.ec_code, b.registration].some((k) => k && String(k).toUpperCase() === String(selectedCode).toUpperCase()));
      return `<option value="${esc(b.id)}" ${sel ? 'selected' : ''}>${esc(b.display || bowserText(b))}${b.type ? ' · ' + esc(b.type) : ''}</option>`;
    }).join('');
  }

  function renderTankOptions(tanks, selectedId, excludeId) {
    return (tanks || [])
      .filter((t) => !excludeId || String(t.id) !== String(excludeId))
      .map((t) => {
        const stockTxt = (!t.hide_stock && t.current_litres != null) ? ` — Stock: ${fmtNum(t.current_litres, 0)}L` : '';
        const siteTxt = t.project_name ? ` (${t.project_name})` : '';
        return `<option value="${esc(t.id)}" ${String(selectedId || '') === String(t.id) ? 'selected' : ''}>${esc(t.name)} [${esc(t.code)}]${esc(siteTxt)}${esc(stockTxt)}</option>`;
      })
      .join('');
  }

  window.openTankTransferRequestModal = async function (defaults = {}, onDone) {
    const boot = await fetchBootstrap();
    const srcTanks = boot.sourceTanks || [];
    const dstTanks = boot.destTanks || [];
    const bowsers = boot.bowsers || [];
    const scope = boot.fuelScope || {};
    const badalgamaDefault = srcTanks.find((t) => String(t.id) === '1' || /badalgama/i.test(t.name || ''));
    const initSrcId = defaults.sourceTankId
      || (badalgamaDefault && String(badalgamaDefault.id) !== String(defaults.destTankId || '') ? String(badalgamaDefault.id) : (srcTanks[0] && String(srcTanks[0].id)) || '');
    const initDstId = defaults.destTankId
      || (dstTanks.length === 1 ? String(dstTanks[0].id) : '');

    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:580px;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <h2 style="margin:0;font-size:18px">🔄 New Bulk Tank-to-Tank Transfer Request</h2>
          <span class="badge blue">Internal Transfer</span>
        </div>
        <p class="muted" style="margin:0 0 12px 0;font-size:12px">
          ${scope.scoped
            ? 'Site bulk transfer requests go to <b>Transport Section</b> for approval &amp; bowser assignment before Source Tank dispatch.'
            : 'Move bulk diesel between depot/site tanks (e.g. Badalgama Tank → Wadakada / Galagedara) with transit reconciliation.'}
        </p>

        <form id="form_ftt_create" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">From Source Tank (Dispatch) *</label>
              <select id="ftt_src_tank" required class="input" style="width:100%">
                <option value="">-- Select Source Tank --</option>
                ${renderTankOptions(srcTanks, initSrcId)}
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">To Destination Tank (Receive) *</label>
              <select id="ftt_dst_tank" required class="input" style="width:100%" ${scope.scoped && dstTanks.length <= 1 ? 'disabled' : ''}>
                ${!(scope.scoped && dstTanks.length <= 1) ? '<option value="">-- Select Receiving Tank --</option>' : ''}
                ${renderTankOptions(dstTanks, initDstId)}
              </select>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Requested Litres *</label>
              <input type="number" step="1" min="1" id="ftt_litres" required class="input" value="${esc(defaults.requestedLitres || '')}" placeholder="e.g. 3000" style="width:100%;font-weight:700">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Fuel Kind</label>
              <select id="ftt_fuel" class="input" style="width:100%">
                <option value="AUTO_DIESEL">Auto Diesel</option>
                <option value="SUPER_DIESEL">Super Diesel</option>
                <option value="PETROL_92">Petrol 92</option>
                <option value="KEROSENE">Kerosene</option>
              </select>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Bowser Vehicle (E&amp;C · Reg No)</label>
              <select id="ftt_bowser" class="input" style="width:100%">
                <option value="">— Transport Will Assign —</option>
                ${renderBowserOptions(bowsers)}
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Bowser Driver</label>
              <input type="text" id="ftt_driver" class="input" placeholder="Driver name (optional)" style="width:100%">
            </div>
          </div>

          <div>
            <label style="font-size:12px;font-weight:600">Purpose / Site Requirement Note</label>
            <input type="text" id="ftt_reason" class="input" placeholder="e.g. Galagedara excavator &amp; dump truck weekly stock" style="width:100%">
          </div>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
            <button type="button" class="btn" id="ftt_cancel_btn">Cancel</button>
            <button type="submit" class="btn primary" id="ftt_submit_btn">📨 Submit Tank Transfer Request</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#ftt_cancel_btn').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.querySelector('#form_ftt_create').onsubmit = async (e) => {
      e.preventDefault();
      const srcId = modal.querySelector('#ftt_src_tank').value;
      const dstId = modal.querySelector('#ftt_dst_tank').value || initDstId;
      if (!srcId || !dstId) return notify('Select both Source Tank and Destination Tank', 'err');
      if (String(srcId) === String(dstId)) return notify('Source tank and destination tank cannot be the same', 'err');

      const btn = modal.querySelector('#ftt_submit_btn');
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      try {
        const bowserVal = modal.querySelector('#ftt_bowser').value;
        const created = await api('/fuel/tank-transfers', {
          method: 'POST',
          body: {
            sourceTankId: srcId,
            destTankId: dstId,
            requestedLitres: Number(modal.querySelector('#ftt_litres').value),
            fuelType: modal.querySelector('#ftt_fuel').value,
            bowserAssetId: bowserVal ? Number(bowserVal) : null,
            driverName: modal.querySelector('#ftt_driver').value.trim() || null,
            reason: modal.querySelector('#ftt_reason').value.trim() || null,
          },
        });
        toast(created.status === 'PENDING'
          ? `${created.transfer_no} sent to Transport Section for approval.`
          : `${created.transfer_no} approved & ready for Source Tank dispatch!`);
        modal.remove();
        if (typeof onDone === 'function') onDone(created);
      } catch (err) {
        notify(err.message || 'Failed to create tank transfer request', 'err');
        btn.disabled = false;
        btn.textContent = '📨 Submit Tank Transfer Request';
      }
    };
  };

  window.openTankTransferReviewModal = async function (tr, bootArg, onDone) {
    const boot = bootArg && bootArg.sourceTanks ? bootArg : await fetchBootstrap();
    const srcTanks = boot.sourceTanks || [];
    const bowsers = boot.bowsers || [];

    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:590px;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <h2 style="margin:0;font-size:18px">🛡️ Transport Review — Tank Transfer</h2>
          <span class="badge" style="font-family:monospace">${esc(tr.transfer_no)}</span>
        </div>
        <div class="card" style="padding:12px;margin-bottom:14px;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.2);font-size:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div><span class="muted">From Source Tank:</span><br><b>${esc(tr.source_tank_name)}</b> (${esc(tr.source_tank_code)})</div>
            <div><span class="muted">To Destination Tank:</span><br><b>${esc(tr.dest_tank_name)}</b> (${esc(tr.dest_tank_code)})</div>
            <div><span class="muted">Requested By:</span><br><b>${esc(tr.requester_name || 'Site')}</b> (${esc(tr.requested_channel || 'SITE')})</div>
            <div><span class="muted">Requested Quantity:</span><br><b style="font-size:14px">${fmtNum(tr.requested_litres, 1)} L</b></div>
          </div>
          ${tr.reason ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed rgba(37,99,235,0.2)"><b>Note:</b> ${esc(tr.reason)}</div>` : ''}
        </div>

        <form id="form_ftt_review" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Approved Litres *</label>
              <input type="number" step="1" min="1" id="ftrv_litres" required class="input" value="${esc(tr.approved_litres || tr.requested_litres)}" style="width:100%;font-weight:700">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Supply Source Tank *</label>
              <select id="ftrv_src_tank" required class="input" style="width:100%">
                ${renderTankOptions(srcTanks, tr.source_tank_id, tr.dest_tank_id)}
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Assign Bowser (E&amp;C · Reg No)</label>
              <select id="ftrv_bowser" class="input" style="width:100%">
                <option value="">— Optional / Assign at Pump —</option>
                ${renderBowserOptions(bowsers, tr.bowser_asset_id, tr.bowser_code)}
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Driver Name</label>
              <input type="text" id="ftrv_driver" class="input" value="${esc(tr.driver_name || '')}" placeholder="Driver name" style="width:100%">
            </div>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600">Transport Remarks / Rejection Reason</label>
            <textarea id="ftrv_note" rows="2" class="input" placeholder="Dispatch instruction or reason if rejecting..." style="width:100%">${esc(tr.review_note || '')}</textarea>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn danger" id="ftrv_reject">✕ Reject Transfer</button>
            <div style="display:flex;gap:8px">
              <button type="button" class="btn" id="ftrv_cancel">Cancel</button>
              <button type="submit" class="btn primary" id="ftrv_approve">✅ Approve for Dispatch</button>
            </div>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#ftrv_cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.querySelector('#ftrv_reject').onclick = async () => {
      const reason = modal.querySelector('#ftrv_note').value.trim();
      if (reason.length < 3) {
        notify('Enter rejection reason (min 3 characters)', 'err');
        modal.querySelector('#ftrv_note').focus();
        return;
      }
      try {
        const res = await api(`/fuel/tank-transfers/${encodeURIComponent(tr.id)}/review`, {
          method: 'POST',
          body: { action: 'REJECT', rejectionReason: reason, reviewNote: reason },
        });
        toast(`${tr.transfer_no} rejected.`);
        modal.remove();
        if (typeof onDone === 'function') onDone(res);
      } catch (err) {
        notify(err.message || 'Reject failed', 'err');
      }
    };

    modal.querySelector('#form_ftt_review').onsubmit = async (e) => {
      e.preventDefault();
      const btn = modal.querySelector('#ftrv_approve');
      btn.disabled = true;
      try {
        const bowVal = modal.querySelector('#ftrv_bowser').value;
        const res = await api(`/fuel/tank-transfers/${encodeURIComponent(tr.id)}/review`, {
          method: 'POST',
          body: {
            action: 'APPROVE',
            approvedLitres: Number(modal.querySelector('#ftrv_litres').value),
            sourceTankId: modal.querySelector('#ftrv_src_tank').value,
            bowserAssetId: bowVal ? Number(bowVal) : null,
            driverName: modal.querySelector('#ftrv_driver').value.trim() || null,
            reviewNote: modal.querySelector('#ftrv_note').value.trim() || null,
          },
        });
        toast(`${tr.transfer_no} approved — Source Tank can now dispatch!`);
        modal.remove();
        if (typeof onDone === 'function') onDone(res);
      } catch (err) {
        notify(err.message || 'Approval failed', 'err');
        btn.disabled = false;
      }
    };
  };

  window.openTankTransferDispatchModal = async function (tr, bootArg, onDone) {
    const boot = bootArg && bootArg.bowsers ? bootArg : await fetchBootstrap();
    const bowsers = boot.bowsers || [];

    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:540px;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <h2 style="margin:0;font-size:18px">🚚 Dispatch Bulk Transfer (Deduct Source Tank)</h2>
          <span class="badge" style="font-family:monospace">${esc(tr.transfer_no)}</span>
        </div>
        <div class="card" style="padding:10px 12px;margin-bottom:12px;background:rgba(124,58,237,0.06);border:1px solid rgba(124,58,237,0.22);font-size:12px">
          <b>From:</b> ${esc(tr.source_tank_name)} → <b>To:</b> ${esc(tr.dest_tank_name)}<br>
          <b>Approved Qty:</b> ${fmtNum(tr.approved_litres || tr.requested_litres, 1)} L &nbsp;·&nbsp; <b>Assigned Bowser:</b> ${bowserBadge(tr)}
        </div>
        <form id="form_ftt_dispatch" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Actual Loaded Litres *</label>
              <input type="number" step="0.1" min="1" id="ftd_litres" required class="input" value="${esc(tr.approved_litres || tr.requested_litres)}" style="width:100%;font-weight:700">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Tanker Seal #</label>
              <input type="text" id="ftd_seal" class="input" placeholder="e.g. SL-2041" style="width:100%">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Bowser Vehicle (E&amp;C · Reg)</label>
              <select id="ftd_bowser" class="input" style="width:100%">
                <option value="">— Select Bowser —</option>
                ${renderBowserOptions(bowsers, tr.bowser_asset_id, tr.bowser_code)}
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Driver Name</label>
              <input type="text" id="ftd_driver" class="input" value="${esc(tr.driver_name || '')}" style="width:100%">
            </div>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600">Dispatch Remarks</label>
            <input type="text" id="ftd_note" class="input" placeholder="Dip before/after loading note" style="width:100%">
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
            <button type="button" class="btn" id="ftd_cancel">Cancel</button>
            <button type="submit" class="btn primary" id="ftd_submit">🚚 Confirm Dispatch (IN TRANSIT)</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#ftd_cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.querySelector('#form_ftt_dispatch').onsubmit = async (e) => {
      e.preventDefault();
      const btn = modal.querySelector('#ftd_submit');
      btn.disabled = true;
      btn.textContent = 'Dispatching...';
      try {
        const bowVal = modal.querySelector('#ftd_bowser').value;
        const res = await api(`/fuel/tank-transfers/${encodeURIComponent(tr.id)}/dispatch`, {
          method: 'POST',
          body: {
            dispatchedLitres: Number(modal.querySelector('#ftd_litres').value),
            sealNo: modal.querySelector('#ftd_seal').value.trim() || null,
            bowserAssetId: bowVal ? Number(bowVal) : null,
            driverName: modal.querySelector('#ftd_driver').value.trim() || null,
            dispatchNote: modal.querySelector('#ftd_note').value.trim() || null,
          },
        });
        toast(`${tr.transfer_no} dispatched (${fmtNum(res.dispatched_litres, 1)} L IN TRANSIT to ${res.dest_tank_name})`);
        modal.remove();
        if (typeof onDone === 'function') onDone(res);
      } catch (err) {
        notify(err.message || 'Dispatch failed', 'err');
        btn.disabled = false;
        btn.textContent = '🚚 Confirm Dispatch (IN TRANSIT)';
      }
    };
  };

  window.openTankTransferReceiveModal = function (tr, onDone) {
    const dispL = Number(tr.dispatched_litres || tr.approved_litres || tr.requested_litres || 0);
    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:520px;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <h2 style="margin:0;font-size:18px">📥 Confirm Bulk Transfer Receipt</h2>
          <span class="badge" style="font-family:monospace">${esc(tr.transfer_no)}</span>
        </div>
        <div class="card" style="padding:10px 12px;margin-bottom:12px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.3);font-size:12px">
          <b>From:</b> ${esc(tr.source_tank_name)} → <b>Into:</b> ${esc(tr.dest_tank_name)}<br>
          <b>Dispatched Qty:</b> <b>${fmtNum(dispL, 1)} L</b> &nbsp;·&nbsp; <b>Bowser:</b> ${bowserBadge(tr)}
          ${tr.seal_no ? ` · <b>Dispatch Seal:</b> <code>${esc(tr.seal_no)}</code>` : ''}
        </div>
        <form id="form_ftt_receive" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Actual Offloaded Litres *</label>
              <input type="number" step="0.1" min="1" id="ftrc_litres" required class="input" value="${esc(dispL)}" style="width:100%;font-weight:700">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Receipt Seal #</label>
              <input type="text" id="ftrc_seal" class="input" value="${esc(tr.seal_no || '')}" placeholder="Verify tanker seal #" style="width:100%">
            </div>
          </div>
          <div id="ftrc_var_banner" style="padding:8px 10px;border-radius:6px;font-size:12px"></div>
          <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:10px">
            <div>
              <label style="font-size:12px;font-weight:600">Receipt Date</label>
              <input type="date" id="ftrc_date" class="input" value="${localTodayStr()}" style="width:100%">
            </div>
            <div>
              <label style="font-size:12px;font-weight:600">Receiving Note</label>
              <input type="text" id="ftrc_note" class="input" placeholder="Dip check / variance note" style="width:100%">
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
            <button type="button" class="btn" id="ftrc_cancel">Cancel</button>
            <button type="submit" class="btn primary" id="ftrc_submit" style="background:#059669;border-color:#059669">📥 Confirm Offload &amp; Credit Tank</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    const litInp = modal.querySelector('#ftrc_litres');
    const varBan = modal.querySelector('#ftrc_var_banner');
    function updateVar() {
      const rec = Number(litInp.value || 0);
      const diff = Math.round((rec - dispL) * 10) / 10;
      const absDiff = Math.abs(diff);
      if (absDiff <= 0.1) {
        varBan.style.background = 'rgba(16,185,129,0.1)';
        varBan.style.border = '1px solid rgba(16,185,129,0.35)';
        varBan.innerHTML = '✅ Exact match with dispatched volume (0.0 L variance).';
      } else {
        const warn = absDiff > 20;
        varBan.style.background = warn ? 'rgba(220,38,38,0.1)' : 'rgba(245,158,11,0.12)';
        varBan.style.border = `1px solid ${warn ? '#dc2626' : '#d97706'}`;
        varBan.innerHTML = `${warn ? '🚨' : '⚠️'} <b>Transit Variance:</b> ${diff > 0 ? '+' : ''}${fmtNum(diff, 1)} L vs ${fmtNum(dispL, 1)} L dispatched.`;
      }
    }
    litInp.oninput = updateVar;
    updateVar();

    modal.querySelector('#ftrc_cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.querySelector('#form_ftt_receive').onsubmit = async (e) => {
      e.preventDefault();
      const btn = modal.querySelector('#ftrc_submit');
      btn.disabled = true;
      btn.textContent = 'Confirming...';
      try {
        const res = await api(`/fuel/tank-transfers/${encodeURIComponent(tr.id)}/receive`, {
          method: 'POST',
          body: {
            receivedLitres: Number(litInp.value),
            receiveSealNo: modal.querySelector('#ftrc_seal').value.trim() || null,
            receivedDate: modal.querySelector('#ftrc_date').value || localTodayStr(),
            receiveNote: modal.querySelector('#ftrc_note').value.trim() || null,
          },
        });
        toast(`Received ${fmtNum(res.received_litres, 1)} L into ${res.dest_tank_name}!`);
        modal.remove();
        if (typeof onDone === 'function') onDone(res);
      } catch (err) {
        notify(err.message || 'Confirm receipt failed', 'err');
        btn.disabled = false;
        btn.textContent = '📥 Confirm Offload & Credit Tank';
      }
    };
  };

  window.openTankTransferCancelModal = function (tr, onDone) {
    const modal = document.createElement('div');
    modal.className = 'modal-bg modal-backdrop';
    const isTransit = tr.status === 'IN_TRANSIT';
    modal.innerHTML = `
      <div class="modal" style="max-width:450px;padding:22px">
        <h3 style="margin:0 0 6px 0">Cancel Transfer ${esc(tr.transfer_no)}</h3>
        <div class="muted" style="font-size:12px;margin-bottom:10px">${esc(tr.source_tank_name)} → ${esc(tr.dest_tank_name)}</div>
        ${isTransit ? `<div style="padding:8px 10px;border-radius:6px;background:rgba(245,158,11,0.14);border:1px solid #d97706;font-size:12px;margin-bottom:10px">⚠️ Cancelling an <b>IN_TRANSIT</b> transfer will automatically restore <b>${fmtNum(tr.dispatched_litres, 1)} L</b> back to ${esc(tr.source_tank_name)}.</div>` : ''}
        <form id="form_ftt_cancel" style="display:flex;flex-direction:column;gap:10px">
          <input type="text" id="ftc_reason" required class="input" placeholder="Reason for cancelling transfer..." style="width:100%">
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn" id="ftc_back">Back</button>
            <button type="submit" class="btn danger">Confirm Cancel</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#ftc_back').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.querySelector('#form_ftt_cancel').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await api(`/fuel/tank-transfers/${encodeURIComponent(tr.id)}/cancel`, {
          method: 'POST',
          body: { reason: modal.querySelector('#ftc_reason').value.trim() || 'Cancelled' },
        });
        toast('Tank transfer cancelled');
        modal.remove();
        if (typeof onDone === 'function') onDone(res);
      } catch (err) {
        notify(err.message || 'Cancel failed', 'err');
      }
    };
  };

  window.renderTankTransfersPanel = async function (box, opts = {}) {
    const isAdm = typeof isAdmin === 'function' && isAdmin();
    const canReq = isAdm || (typeof canDo === 'function' && canDo('fuel.transport.request', 'fuel.request', 'fuel.transfer', 'fuel.tanks.refill'));
    const canRev = canReviewTransfer();
    const boot = await fetchBootstrap();

    box.innerHTML = `
      <div id="ftt_kpi_row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px"></div>
      <div class="card" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px">
          <div>
            <h3 style="margin:0;font-size:16px">🔄 Bulk Tank-to-Tank Transfers (e.g. Badalgama → Wadakada / Galagedara)</h3>
            <div class="muted" style="font-size:11.5px">Site Request → Transport Approval &amp; Bowser Assignment → Source Tank Dispatch → Destination Tank Receipt</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <select id="ftt_status_filter" class="input sm">
              <option value="OPEN">Open Transfers (Pending + Approved + In Transit)</option>
              <option value="PENDING">Awaiting Transport Approval</option>
              <option value="APPROVED">Ready to Dispatch at Source</option>
              <option value="IN_TRANSIT">🚚 In Transit (Awaiting Receipt)</option>
              <option value="RECEIVED">✓ Received</option>
              <option value="ALL">All Transfers</option>
            </select>
            <input type="text" id="ftt_search_inp" class="input sm" placeholder="Search FTR #, tank, bowser, driver..." style="min-width:200px">
            ${canReq ? '<button class="btn sm primary" id="ftt_btn_new">+ New Tank Transfer Request</button>' : ''}
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="table" style="width:100%;font-size:12.5px">
            <thead>
              <tr>
                <th>Transfer #</th>
                <th>From Tank → To Tank</th>
                <th>Bowser &amp; Seal</th>
                <th style="text-align:right">Requested / App</th>
                <th style="text-align:right">Dispatched / Recv</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="ftt_tbody">
              <tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Loading tank transfers...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const stEl = box.querySelector('#ftt_status_filter');
    const qEl = box.querySelector('#ftt_search_inp');
    const newBtn = box.querySelector('#ftt_btn_new');
    if (newBtn) {
      newBtn.onclick = () => window.openTankTransferRequestModal({}, () => {
        loadTransfers();
        if (typeof opts.onChanged === 'function') opts.onChanged();
      });
    }

    async function loadTransfers() {
      const tbody = box.querySelector('#ftt_tbody');
      const kpiRow = box.querySelector('#ftt_kpi_row');
      try {
        const p = new URLSearchParams({ status: stEl.value, limit: '200' });
        if (opts.projectId && opts.projectId !== 'ALL') p.set('projectId', opts.projectId);
        if (opts.tankId && opts.tankId !== 'ALL') p.set('tankId', opts.tankId);
        if (qEl.value.trim()) p.set('search', qEl.value.trim());
        const res = await api(`/fuel/tank-transfers?${p.toString()}`);
        const rows = res.transfers || [];
        const sm = res.summary || { pending: 0, approved: 0, inTransit: 0, received: 0 };

        if (kpiRow) {
          kpiRow.innerHTML = `
            <div class="card kpi-card" style="padding:10px 12px"><div class="muted" style="font-size:11px;font-weight:600">AWAITING TRANSPORT</div><div style="font-size:20px;font-weight:800;color:#d97706">${sm.pending || 0}</div></div>
            <div class="card kpi-card" style="padding:10px 12px"><div class="muted" style="font-size:11px;font-weight:600">READY TO DISPATCH</div><div style="font-size:20px;font-weight:800;color:#2563eb">${sm.approved || 0}</div></div>
            <div class="card kpi-card" style="padding:10px 12px"><div class="muted" style="font-size:11px;font-weight:600">🚚 IN TRANSIT</div><div style="font-size:20px;font-weight:800;color:#7c3aed">${sm.inTransit || 0}</div></div>
            <div class="card kpi-card" style="padding:10px 12px"><div class="muted" style="font-size:11px;font-weight:600">✓ RECEIVED</div><div style="font-size:20px;font-weight:800;color:#059669">${sm.received || 0}</div></div>
          `;
        }

        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No bulk tank transfers match this filter.</td></tr>';
          return;
        }

        tbody.innerHTML = rows.map((tr) => {
          const allowDisp = tr.status === 'APPROVED' && canDispatchTransfer(tr);
          const allowRecv = tr.status === 'IN_TRANSIT' && canReceiveTransfer(tr);
          const allowCancel = (tr.status === 'PENDING' || tr.status === 'APPROVED' || (tr.status === 'IN_TRANSIT' && isAdm));
          const varTxt = tr.variance_litres != null && Math.abs(Number(tr.variance_litres)) > 0.1
            ? `<div style="font-size:10.5px;color:${Number(tr.variance_litres) < 0 ? '#dc2626' : '#059669'};font-weight:700">Var: ${tr.variance_litres > 0 ? '+' : ''}${fmtNum(tr.variance_litres, 1)} L</div>`
            : '';

          return `
            <tr>
              <td>
                <div style="font-family:monospace;font-weight:700">${esc(tr.transfer_no)}</div>
                <div class="muted" style="font-size:11px">${esc(String(tr.requested_at || '').slice(0, 16).replace('T', ' '))}</div>
              </td>
              <td>
                <div><b>${esc(tr.source_tank_name)}</b> <span class="muted">(${esc(tr.source_tank_code)})</span></div>
                <div style="margin-top:2px">→ <b>${esc(tr.dest_tank_name)}</b> <span class="muted">(${esc(tr.dest_tank_code)})</span></div>
              </td>
              <td>
                <div>${bowserBadge(tr)}</div>
                <div class="muted" style="font-size:11px">${tr.driver_name ? esc(tr.driver_name) : ''}${tr.seal_no ? ' · Seal: ' + esc(tr.seal_no) : ''}</div>
              </td>
              <td style="text-align:right">
                <div>Req: <b>${fmtNum(tr.requested_litres, 1)} L</b></div>
                ${tr.approved_litres != null ? `<div class="muted" style="font-size:11px">App: <b>${fmtNum(tr.approved_litres, 1)} L</b></div>` : ''}
              </td>
              <td style="text-align:right">
                <div>Disp: <b>${tr.dispatched_litres != null ? fmtNum(tr.dispatched_litres, 1) + ' L' : '—'}</b></div>
                <div class="muted" style="font-size:11px">Recv: <b>${tr.received_litres != null ? fmtNum(tr.received_litres, 1) + ' L' : '—'}</b></div>
                ${varTxt}
              </td>
              <td>
                <div>${transferStatusBadge(tr)}</div>
                ${tr.review_note || tr.rejection_reason ? `<div class="muted" style="font-size:10.5px;margin-top:2px">${esc(tr.rejection_reason || tr.review_note)}</div>` : ''}
              </td>
              <td style="white-space:nowrap">
                ${tr.status === 'PENDING' && canRev ? `<button class="btn sm primary ftt-act-review" data-id="${esc(tr.id)}">🛡️ Review</button>` : ''}
                ${allowDisp ? `<button class="btn sm primary ftt-act-dispatch" data-id="${esc(tr.id)}">🚚 Dispatch</button>` : ''}
                ${allowRecv ? `<button class="btn sm ftt-act-receive" data-id="${esc(tr.id)}" style="background:#059669;color:#fff;border-color:#059669">📥 Confirm Receipt</button>` : ''}
                ${allowCancel ? `<button class="btn sm ftt-act-cancel" data-id="${esc(tr.id)}">Cancel</button>` : ''}
              </td>
            </tr>
          `;
        }).join('');

        const afterAct = () => {
          loadTransfers();
          if (typeof opts.onChanged === 'function') opts.onChanged();
        };
        qsa('.ftt-act-review', tbody).forEach((b) => {
          b.onclick = () => {
            const tr = rows.find((x) => x.id === b.dataset.id);
            if (tr) window.openTankTransferReviewModal(tr, boot, afterAct);
          };
        });
        qsa('.ftt-act-dispatch', tbody).forEach((b) => {
          b.onclick = () => {
            const tr = rows.find((x) => x.id === b.dataset.id);
            if (tr) window.openTankTransferDispatchModal(tr, boot, afterAct);
          };
        });
        qsa('.ftt-act-receive', tbody).forEach((b) => {
          b.onclick = () => {
            const tr = rows.find((x) => x.id === b.dataset.id);
            if (tr) window.openTankTransferReceiveModal(tr, afterAct);
          };
        });
        qsa('.ftt-act-cancel', tbody).forEach((b) => {
          b.onclick = () => {
            const tr = rows.find((x) => x.id === b.dataset.id);
            if (tr) window.openTankTransferCancelModal(tr, afterAct);
          };
        });
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="err">${esc(err.message)}</td></tr>`;
      }
    }

    stEl.onchange = loadTransfers;
    let tmr = null;
    qEl.oninput = () => { clearTimeout(tmr); tmr = setTimeout(loadTransfers, 220); };
    await loadTransfers();
    return { reload: loadTransfers };
  };
})();
