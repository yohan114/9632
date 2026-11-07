'use strict';

/**
 * Migration 054: CCOM Outsourced Service & Repair Requests
 *
 * 1. Creates core CCOM outsourcing tables:
 *    - outsourcing_vendors: Vendor registry (C.COM / United Motors Lanka PLC)
 *    - outsourcing_vendor_contacts: Verified vendor recipient contacts
 *    - outsourcing_requests: Parent-linked request headers (repair_job_id OR service_record_id)
 *    - outsourcing_request_lines: Itemized repair/service tasks
 *    - outsourcing_revisions: Immutable revision snapshots with SHA256 content hashes
 *    - outsourcing_approvals: Mechanical Engineer electronic signatures and decisions
 *    - outsourcing_documents: Generated approved PDF documents with file paths and hashes
 *    - outsourcing_email_outbox: Queued reviewed emails with idempotency and delivery states
 *    - outsourcing_events: Complete audit trail and lifecycle transitions
 *    - outsourcing_cost_links: Verified invoice links and cost postings to parent job/service
 * 2. Seeds C.COM vendor and default service contact
 * 3. Seeds outsourcing role capabilities and role permissions
 * 4. Ensures outsourcing settings in settings table
 *
 * Guarded by setting key 'migration_054_done'.
 * Fully idempotent across single-database and multidb modes.
 */

const crypto = require('crypto');
const permissions = require('../lib/permissions');
const capabilities = require('../lib/capabilities');

function runMigration(targetDb) {
  console.log('=== Running Migration 054: CCOM Outsourced Service & Repair Requests ===');
  if (!targetDb) return;

  const isWsDb = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ws_meta'").get());

  // 1. Create outsourcing_vendors
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_vendors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      address     TEXT,
      phone       TEXT,
      email       TEXT,
      notes       TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 2. Create outsourcing_vendor_contacts
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_vendor_contacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id   INTEGER NOT NULL REFERENCES outsourcing_vendors(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      designation TEXT,
      email       TEXT NOT NULL,
      phone       TEXT,
      is_default  INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed default C.COM vendor
  const ccomVendor = targetDb.prepare("SELECT id FROM outsourcing_vendors WHERE code = 'CCOM'").get();
  let ccomVendorId = ccomVendor ? ccomVendor.id : null;
  if (!ccomVendorId) {
    const info = targetDb.prepare(`
      INSERT INTO outsourcing_vendors (code, name, address, phone, email, notes, active)
      VALUES ('CCOM', 'C.COM (United Motors Lanka PLC)', 'Central Workshop Premises / Colombo', '011-2345678', 'service@ccom.lk', 'Primary authorized outsourcing vendor for heavy machinery & vehicle repairs', 1)
    `).run();
    ccomVendorId = info.lastInsertRowid;
    console.log('[054] Seeded C.COM vendor');
  }

  // Seed default contact if none exists
  if (ccomVendorId) {
    const contactCount = targetDb.prepare("SELECT COUNT(*) c FROM outsourcing_vendor_contacts WHERE vendor_id = ?").get(ccomVendorId).c;
    if (contactCount === 0) {
      targetDb.prepare(`
        INSERT INTO outsourcing_vendor_contacts (vendor_id, name, designation, email, phone, is_default, active)
        VALUES (?, 'C.COM Service Desk', 'Service Desk Agent', 'service@ccom.lk', '077-1234567', 1, 1)
      `).run(ccomVendorId);
      console.log('[054] Seeded C.COM default service contact');
    }
  }

  // 3. Create outsourcing_requests
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_requests (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_no               TEXT UNIQUE,
      repair_job_id        INTEGER REFERENCES job_cards(id),
      service_record_id    INTEGER REFERENCES service_jobs(id),
      vendor_id            INTEGER NOT NULL REFERENCES outsourcing_vendors(id),
      vendor_contact_id    INTEGER REFERENCES outsourcing_vendor_contacts(id),
      assigned_engineer_id INTEGER REFERENCES users(id),
      request_type         TEXT NOT NULL DEFAULT 'repair' CHECK (request_type IN ('repair', 'service')),
      required_date        TEXT,
      priority             TEXT NOT NULL DEFAULT 'normal',
      meter_reading        REAL,
      meter_unit           TEXT NOT NULL DEFAULT 'hours',
      contact_name         TEXT,
      contact_number       TEXT,
      informed_by          TEXT,
      status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'returned', 'approved', 'sent', 'acknowledged', 'in_progress', 'completed', 'closed', 'cancelled')),
      version              INTEGER NOT NULL DEFAULT 1,
      current_revision_id  INTEGER,
      created_by           INTEGER NOT NULL REFERENCES users(id),
      store_location_id    INTEGER REFERENCES store_locations(id),
      workshop_id          INTEGER REFERENCES workshops(id),
      asset_id             INTEGER REFERENCES assets(id),
      asset_snapshot       TEXT,
      cancellation_reason  TEXT,
      cancelled_by         INTEGER REFERENCES users(id),
      cancelled_at         TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (repair_job_id IS NOT NULL AND service_record_id IS NULL) OR
        (repair_job_id IS NULL AND service_record_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_outsrc_repair_job ON outsourcing_requests(repair_job_id);
    CREATE INDEX IF NOT EXISTS idx_outsrc_service_rec ON outsourcing_requests(service_record_id);
    CREATE INDEX IF NOT EXISTS idx_outsrc_status ON outsourcing_requests(status);
    CREATE INDEX IF NOT EXISTS idx_outsrc_engineer ON outsourcing_requests(assigned_engineer_id);
  `);

  // 4. Create outsourcing_request_lines
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_request_lines (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id  INTEGER NOT NULL REFERENCES outsourcing_requests(id) ON DELETE CASCADE,
      line_no     INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL,
      location    TEXT,
      remarks     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outsrc_lines_req ON outsourcing_request_lines(request_id);
  `);

  // 5. Create outsourcing_revisions
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_revisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id    INTEGER NOT NULL REFERENCES outsourcing_requests(id) ON DELETE CASCADE,
      revision_no   INTEGER NOT NULL,
      content_json  TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      submitted_by  INTEGER NOT NULL REFERENCES users(id),
      submitted_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outsrc_rev_req ON outsourcing_revisions(request_id);
  `);

  // 6. Create outsourcing_approvals
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_approvals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id     INTEGER NOT NULL REFERENCES outsourcing_requests(id) ON DELETE CASCADE,
      revision_id    INTEGER NOT NULL REFERENCES outsourcing_revisions(id),
      engineer_id    INTEGER NOT NULL REFERENCES users(id),
      decision       TEXT NOT NULL CHECK (decision IN ('approved', 'returned')),
      approval_note  TEXT,
      signed_name    TEXT,
      signature_data TEXT,
      signed_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outsrc_app_req ON outsourcing_approvals(request_id);
  `);

  // 7. Create outsourcing_documents
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_documents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id    INTEGER NOT NULL REFERENCES outsourcing_requests(id) ON DELETE CASCADE,
      revision_id   INTEGER NOT NULL REFERENCES outsourcing_revisions(id),
      doc_type      TEXT NOT NULL DEFAULT 'approved_request_pdf',
      file_path     TEXT NOT NULL,
      file_hash     TEXT,
      file_size     INTEGER,
      generated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outsrc_doc_req ON outsourcing_documents(request_id);
  `);

  // 8. Create outsourcing_email_outbox
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_email_outbox (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id       INTEGER NOT NULL REFERENCES outsourcing_requests(id),
      document_id      INTEGER REFERENCES outsourcing_documents(id),
      to_emails        TEXT NOT NULL,
      cc_emails        TEXT,
      subject          TEXT NOT NULL,
      body             TEXT,
      attachments_json TEXT,
      status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unknown')),
      idempotency_key  TEXT UNIQUE,
      provider_msg_id  TEXT,
      sent_at          TEXT,
      error_message    TEXT,
      created_by       INTEGER NOT NULL REFERENCES users(id),
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outsrc_outbox_status ON outsourcing_email_outbox(status);
    CREATE INDEX IF NOT EXISTS idx_outsrc_outbox_req ON outsourcing_email_outbox(request_id);
  `);

  // 9. Create outsourcing_events
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id   INTEGER NOT NULL REFERENCES outsourcing_requests(id) ON DELETE CASCADE,
      event_type   TEXT NOT NULL,
      user_id      INTEGER REFERENCES users(id),
      details_json TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outsrc_events_req ON outsourcing_events(request_id);
  `);

  // 10. Create outsourcing_cost_links
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS outsourcing_cost_links (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id         INTEGER NOT NULL REFERENCES outsourcing_requests(id),
      invoice_no         TEXT,
      invoice_date       TEXT,
      amount             REAL NOT NULL,
      posted_to_parent   INTEGER NOT NULL DEFAULT 0,
      parent_cost_type   TEXT,
      posted_by          INTEGER REFERENCES users(id),
      posted_at          TEXT,
      notes              TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outsrc_cost_req ON outsourcing_cost_links(request_id);
  `);

  // 11. Backfill permissions & capabilities if core/roles table exists
  const hasRoles = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roles'").get());
  if (hasRoles) {
    const hasRolePerms = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_permissions'").get());
    if (hasRolePerms) {
      const insertPermStmt = targetDb.prepare('INSERT OR IGNORE INTO role_permissions (role, module, level) VALUES (?, ?, ?)');
      let permsSeeded = 0;
      for (const [role, mods] of Object.entries(permissions.DEFAULT_MATRIX)) {
        for (const [mod, lvl] of Object.entries(mods)) {
          if (mod === 'outsourcing') {
            const info = insertPermStmt.run(role, mod, lvl);
            if (info.changes) permsSeeded++;
          }
        }
      }
      console.log(`[054] Backfilled ${permsSeeded} role_permissions entries for outsourcing`);
    }

    const hasRoleCaps = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_capabilities'").get());
    if (hasRoleCaps) {
      const insertCapStmt = targetDb.prepare(`
        INSERT OR IGNORE INTO role_capabilities (role, capability, granted, updated_at)
        VALUES (?, ?, 1, datetime('now'))
      `);
      let capsSeeded = 0;
      for (const c of capabilities.CAPABILITIES) {
        if (c.key.startsWith('outsourcing.')) {
          for (const role of c.legacy) {
            const info = insertCapStmt.run(role, c.key);
            if (info.changes) capsSeeded++;
          }
        }
      }
      console.log(`[054] Backfilled ${capsSeeded} role_capabilities entries for outsourcing`);
    }
  }

  // 12. Ensure outsourcing settings
  const hasSettings = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get());
  if (hasSettings) {
    targetDb.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('outsourcing_enabled', '1')").run();
  }

  console.log('=== Migration 054 Completed Successfully ===');
}

module.exports = {
  runMigration
};
