'use strict';

// Phase — Job Request (Transport) workflow bootstrap.
// The job_requests / job_request_approvals tables are created in db/index.js
// migrate() (idempotent). This step seeds the NEW role + demo user into an
// already-populated database so the request → certify → approve flow can run:
//   Assistant Transport Manager (asst/asst) raises → Transport Manager certifies
//   → Operational Manager approves (auto-creates a job card).
// Idempotent: INSERT OR IGNORE on the role, create the user only if missing.

const { get, run } = require('../db');
const auth = require('../lib/auth');

function runStep() {
  const rep = { role_added: 0, user_created: 0, role_linked: 0, already: false };

  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', 'assistant_transport_manager', 'Assistant Transport Manager');
  const role = get('SELECT id FROM roles WHERE name = ?', 'assistant_transport_manager');
  if (!role) return rep; // should never happen
  rep.role_added = 1;

  let user = get('SELECT id FROM users WHERE username = ?', 'asst');
  if (!user) {
    const info = run('INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)',
      'asst', auth.hashPassword('asst'), 'Assistant Transport Manager');
    user = { id: info.lastInsertRowid };
    rep.user_created = 1;
  } else {
    rep.already = true;
  }
  // Ensure the role link exists (idempotent).
  const linked = get('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?', user.id, role.id);
  if (!linked) { run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', user.id, role.id); rep.role_linked = 1; }

  return rep;
}

module.exports = { runStep };
