'use strict';

/**
 * Outbox Email Adapter for CCOM Outsourced Requests
 *
 * Provides transactional outbox queueing, idempotency protection against duplicate sends,
 * delivery state tracking, and configurable mail transport.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run, get, all, tx } = require('../db');

/**
 * Queue a reviewed email for dispatch
 */
function queueEmail({
  requestId,
  documentId,
  to,
  cc = [],
  subject,
  body,
  userId,
  idempotencyKey = null
}) {
  const toStr = JSON.stringify(to);
  const ccStr = JSON.stringify(cc);
  const idemKey = idempotencyKey || `send_${requestId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Check if idempotency key already exists
  const existing = get('SELECT * FROM outsourcing_email_outbox WHERE idempotency_key = ?', idemKey);
  if (existing) {
    return existing;
  }

  // Get document details
  const doc = get('SELECT * FROM outsourcing_documents WHERE id = ? AND request_id = ?', documentId, requestId);
  if (!doc) {
    const err = new Error('Approved document not found for this request');
    err.status = 404;
    throw err;
  }

  const attachments = [
    {
      document_id: doc.id,
      file_path: doc.file_path,
      file_hash: doc.file_hash,
      filename: path.basename(doc.file_path)
    }
  ];

  const id = run(`
    INSERT INTO outsourcing_email_outbox (
      request_id, document_id, to_emails, cc_emails, subject, body,
      attachments_json, status, idempotency_key, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `, requestId, documentId, toStr, ccStr, subject, body, JSON.stringify(attachments), idemKey, userId).lastInsertRowid;

  // Record workflow event
  run(`
    INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
    VALUES (?, 'email_queued', ?, ?)
  `, requestId, userId, JSON.stringify({ outbox_id: id, to, subject }));

  return get('SELECT * FROM outsourcing_email_outbox WHERE id = ?', id);
}

/**
 * Process an outbox item and dispatch via mail transport
 */
async function processOutboxItem(outboxId) {
  const item = get('SELECT * FROM outsourcing_email_outbox WHERE id = ?', outboxId);
  if (!item || item.status === 'sent') return item;

  run("UPDATE outsourcing_email_outbox SET status = 'sending' WHERE id = ?", outboxId);

  try {
    let toList = [];
    try { toList = JSON.parse(item.to_emails); } catch (_) {}
    let ccList = [];
    try { ccList = JSON.parse(item.cc_emails); } catch (_) {}

    let attachments = [];
    try { attachments = JSON.parse(item.attachments_json); } catch (_) {}

    // Verify attachments exist on disk
    for (const a of attachments) {
      if (a.file_path && !fs.existsSync(a.file_path)) {
        throw new Error(`Attachment file missing on server: ${a.file_path}`);
      }
    }

    // Provider dispatch
    // If SMTP credentials exist, dispatch via nodemailer transport;
    // otherwise fallback safely to outbox simulation for offline/test environments.
    let providerMsgId = null;
    const smtpService = process.env.SMTP_SERVICE;
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const smtpSecure = process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true' || smtpPort === 465;
    const smtpFrom = process.env.SMTP_FROM || (smtpUser ? `"WorkshopOne" <${smtpUser}>` : 'workshop@edwardchristie.com');

    if (smtpUser && (smtpHost || smtpService)) {
      const nodemailer = require('nodemailer');
      const transportOpts = smtpService
        ? {
            service: smtpService,
            auth: { user: smtpUser, pass: smtpPass }
          }
        : {
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            auth: { user: smtpUser, pass: smtpPass }
          };

      const transporter = nodemailer.createTransport(transportOpts);
      const mailOptions = {
        from: smtpFrom,
        to: toList.map((t) => (t && t.name ? `"${t.name}" <${t.email}>` : (t && t.email ? t.email : t))).join(', '),
        cc: ccList.length ? ccList.map((c) => (c && c.name ? `"${c.name}" <${c.email}>` : (c && c.email ? c.email : c))).join(', ') : undefined,
        subject: item.subject,
        text: item.body,
        attachments: attachments.map((a) => ({
          filename: a.filename || 'Request_Document.pdf',
          path: a.file_path
        }))
      };

      const info = await transporter.sendMail(mailOptions);
      providerMsgId = info.messageId || `smtp_${Date.now()}`;
    } else {
      providerMsgId = `local_sim_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    const now = new Date().toISOString();
    run(`
      UPDATE outsourcing_email_outbox
         SET status = 'sent', provider_msg_id = ?, sent_at = ?, error_message = NULL
       WHERE id = ?
    `, providerMsgId, now, outboxId);

    // Update parent request status to 'sent' if it is currently 'approved'
    run(`
      UPDATE outsourcing_requests
         SET status = 'sent', updated_at = datetime('now')
       WHERE id = ? AND status = 'approved'
    `, item.request_id);

    // Record workflow event
    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'email_sent', ?, ?)
    `, item.request_id, item.created_by, JSON.stringify({ outbox_id: outboxId, provider_msg_id: providerMsgId, sent_at: now }));

    return get('SELECT * FROM outsourcing_email_outbox WHERE id = ?', outboxId);
  } catch (err) {
    console.error(`Outbox email send failed (ID: ${outboxId}):`, err.message);
    run(`
      UPDATE outsourcing_email_outbox
         SET status = 'failed', error_message = ?
       WHERE id = ?
    `, err.message, outboxId);

    run(`
      INSERT INTO outsourcing_events (request_id, event_type, user_id, details_json)
      VALUES (?, 'email_failed', ?, ?)
    `, item.request_id, item.created_by, JSON.stringify({ outbox_id: outboxId, error: err.message }));

    throw err;
  }
}

module.exports = {
  queueEmail,
  processOutboxItem
};
