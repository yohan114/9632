'use strict';

/**
 * Access Control and Permission Resolution for CCOM Outsourced Requests
 *
 * Implements strict tenancy rules, capability requirements, self-approval prevention,
 * and parent job scoping.
 */

const { get, all } = require('../db');
const auth = require('./auth');
const capabilities = require('./capabilities');
const bcrypt = require('bcryptjs');

function hasCap(user, capKey) {
  if (!user) return false;
  return auth.hasCap(user, capKey);
}

/**
 * Check if the caller has access to the parent job / service record.
 */
function checkParentAccess(user, parentType, parentId) {
  if (!user) return { allowed: false, reason: 'Authentication required' };
  if (user.role === 'admin' || user.roles?.includes('admin')) {
    return { allowed: true };
  }

  if (parentType === 'repair') {
    const job = get('SELECT id, workshop_id, type, status FROM job_cards WHERE id = ?', parentId);
    if (!job) return { allowed: false, reason: 'Parent repair job not found' };

    // Check fabrication scoping rule if this is a fabrication job
    if (job.type === 'fabrication') {
      const canViewFab = hasCap(user, 'fabrication.view');
      if (!canViewFab) {
        return { allowed: false, reason: 'Fabrication visibility required to access outsourcing on a fabrication job' };
      }
    }

    // Check workshop / site scope
    if (user.workshop_id && job.workshop_id && Number(user.workshop_id) !== Number(job.workshop_id)) {
      if (!hasCap(user, 'jobs.view_other_workshops')) {
        return { allowed: false, reason: 'Access to repair job of another workshop is restricted' };
      }
    }

    return { allowed: true, job };
  } else if (parentType === 'service') {
    const srv = get('SELECT id, workshop_id, store_id, physical_store_id FROM service_jobs WHERE id = ?', parentId);
    if (!srv) return { allowed: false, reason: 'Parent service record not found' };

    if (user.workshop_id && srv.workshop_id && Number(user.workshop_id) !== Number(srv.workshop_id)) {
      if (!hasCap(user, 'jobs.view_other_workshops')) {
        return { allowed: false, reason: 'Access to service record of another workshop is restricted' };
      }
    }

    return { allowed: true, service: srv };
  }

  return { allowed: false, reason: 'Unknown parent type' };
}

/**
 * Check if caller can view the specific request
 */
function canViewRequest(user, request) {
  if (!user) return false;
  if (user.role === 'admin' || user.roles?.includes('admin')) return true;
  if (!hasCap(user, 'outsourcing.view')) return false;

  // Requester or assigned engineer can view
  if (request.created_by === user.id) return true;
  if (request.assigned_engineer_id === user.id) return true;

  // Otherwise check parent access
  const parentType = request.repair_job_id ? 'repair' : 'service';
  const parentId = request.repair_job_id || request.service_record_id;
  const pCheck = checkParentAccess(user, parentType, parentId);
  return pCheck.allowed;
}

/**
 * Check if caller can edit draft / returned request
 */
function canEditDraft(user, request) {
  if (!user) return { allowed: false, reason: 'Authentication required' };
  if (!['draft', 'returned'].includes(request.status)) {
    return { allowed: false, reason: `Cannot edit request in '${request.status}' status` };
  }
  if (user.role === 'admin' || user.roles?.includes('admin')) return { allowed: true };

  if (!hasCap(user, 'outsourcing.edit_draft')) {
    return { allowed: false, reason: "Missing capability 'outsourcing.edit_draft'" };
  }

  // Must be creator or authorised storekeeper with parent access
  const parentType = request.repair_job_id ? 'repair' : 'service';
  const parentId = request.repair_job_id || request.service_record_id;
  const pCheck = checkParentAccess(user, parentType, parentId);
  if (!pCheck.allowed) return pCheck;

  return { allowed: true };
}

/**
 * Check if caller can approve/return this request
 */
function canApproveRequest(user, request) {
  if (!user) return { allowed: false, reason: 'Authentication required' };

  if (request.status !== 'pending_approval') {
    return { allowed: false, reason: `Request is not pending approval (currently '${request.status}')` };
  }

  // Rule 1: The requester CANNOT approve their own request!
  if (request.created_by === user.id) {
    return { allowed: false, reason: 'Separation of duties: The requester cannot approve their own outsourcing request.' };
  }

  if (user.role === 'admin' || user.roles?.includes('admin')) {
    return { allowed: true };
  }

  if (!hasCap(user, 'outsourcing.approve')) {
    return { allowed: false, reason: "Missing capability 'outsourcing.approve'" };
  }

  // Must be the assigned engineer
  if (request.assigned_engineer_id && Number(request.assigned_engineer_id) !== Number(user.id)) {
    return { allowed: false, reason: 'Only the assigned Mechanical Engineer may approve or return this request.' };
  }

  return { allowed: true };
}

/**
 * Verify engineer re-authentication for electronic signature
 */
function verifyEngineerReauth(user, password) {
  if (!user || !user.id) return false;
  const u = get('SELECT id, password_hash, signature, full_name, username FROM users WHERE id = ?', user.id);
  if (!u || !u.password_hash) return false;
  if (!password) return false;
  return bcrypt.compareSync(String(password), u.password_hash);
}

module.exports = {
  hasCap,
  checkParentAccess,
  canViewRequest,
  canEditDraft,
  canApproveRequest,
  verifyEngineerReauth
};
