'use strict';

const crypto = require('crypto');
const { hasCap } = require('../../lib/auth');

/**
 * SAP API Policy & Security Guard (sap-api-policy & sap-dependency-security).
 *
 * Two ways in, and only two:
 *
 *  1. A machine client presenting SAP_GATEWAY_API_KEY in the `x-sap-api-key` header or as
 *     `Authorization: Bearer <key>`. There is NO built-in key: with SAP_GATEWAY_API_KEY unset (or
 *     shorter than 32 characters) key access is off. The gateway used to fall back to a key written
 *     in this file, and the repository is public, so anyone could read the fleet, job cards and stock
 *     without signing in. The key is never read from the query string — URLs end up in logs, browser
 *     history and proxies.
 *
 *  2. A signed-in WorkshopOne user, let in by CAPABILITY for the scope the endpoint needs. Never by
 *     role name: a role an admin creates would never be in a hard-coded list (src/lib/auth.js).
 */
const MIN_KEY_LENGTH = 32;

// Which capabilities open each SAP scope for a signed-in user (any one of them is enough).
const SCOPE_CAPS = {
  EAM_Tech: ['jobs.view', 'assets.view'],
  Fleet_Manager: ['assets.view'],
  MM_Clerk: ['stores.view'],
  Audit_Compliance: ['system.status'],
};
// Endpoints that name no scope (sync status, analytics exports) describe the whole system.
const NO_SCOPE_CAPS = ['system.status'];

let warnedShortKey = false;
function configuredKey(env = process.env) {
  const k = String(env.SAP_GATEWAY_API_KEY || '').trim();
  if (!k) return null;
  if (k.length < MIN_KEY_LENGTH) {
    if (!warnedShortKey) {
      warnedShortKey = true;
      console.warn(`[sap] SAP_GATEWAY_API_KEY is shorter than ${MIN_KEY_LENGTH} characters — key access to the SAP gateway is OFF.`);
    }
    return null;
  }
  return k;
}

function presentedKey(req) {
  const h = req.headers['x-sap-api-key'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const a = req.headers.authorization;
  if (typeof a === 'string' && a.startsWith('Bearer ')) return a.slice(7).trim() || null;
  return null;
}

// Constant-time: hashing both sides first makes the lengths equal, so timingSafeEqual never throws
// and the comparison time says nothing about how much of the key was right.
function keyMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function capsForScope(scope) {
  return scope ? (SCOPE_CAPS[scope] || NO_SCOPE_CAPS) : NO_SCOPE_CAPS;
}

function requireSapAuth(requiredScope = null) {
  return (req, res, next) => {
    // 1. Machine client with the configured key.
    const expected = configuredKey();
    const given = presentedKey(req);
    if (expected && given && keyMatches(given, expected)) {
      req.sapClient = {
        id: 'sap-integration-gateway',
        name: 'SAP BTP Client',
        scopes: ['EAM_Tech', 'MM_Clerk', 'Fleet_Manager', 'Audit_Compliance', '*']
      };
      return next();
    }

    // 2. Signed-in user, by capability.
    if (req.user) {
      const caps = capsForScope(requiredScope);
      if (hasCap(req.user, ...caps)) {
        req.sapClient = { id: req.user.id, name: req.user.username, scopes: requiredScope ? [requiredScope] : [] };
        return next();
      }
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN_SCOPE',
          message: `Your role does not allow this SAP data${requiredScope ? ` (${requiredScope})` : ''}.`,
          target: 'authorization'
        }
      });
    }

    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Valid SAP API Key (x-sap-api-key header) or Bearer Token required.',
        target: 'authorization'
      }
    });
  };
}

module.exports = {
  requireSapAuth,
  MIN_KEY_LENGTH,
  SCOPE_CAPS
};
