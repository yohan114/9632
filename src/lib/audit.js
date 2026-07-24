'use strict';

// Full audit trail: who changed what, when, and why.
const { run } = require('../db');
const emitter = require('./emitter');

function record({ userId = null, entity, entityId = null, action, before = null, after = null, reason = null }) {
  run(
    `INSERT INTO audit_log (user_id, entity, entity_id, action, before_json, after_json, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId,
    entity,
    entityId,
    action,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    reason
  );
  // Real-time: every audited mutation broadcasts one generic 'data_changed' so clients
  // can auto-refresh any affected view. audit.record is called post-commit throughout,
  // so this fires after the write lands. Best-effort — never break the write on notify.
  try {
    emitter.notify(entity, action, { id: entityId, asset_id: after && after.asset_id, job_id: after && after.job_id });
  } catch (e) { /* notify is advisory */ }
}

module.exports = { record };
