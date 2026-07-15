'use strict';

// Full audit trail: who changed what, when, and why.
const { run } = require('../db');

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
}

module.exports = { record };
