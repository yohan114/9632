'use strict';

const config = require('../../config');
const { get } = require('../../db');

/**
 * SAP API Policy & Security Guard (sap-api-policy & sap-dependency-security).
 * Validates OAuth2 / Bearer Tokens, SAP API Keys, or existing admin sessions.
 */
function requireSapAuth(requiredScope = null) {
  return (req, res, next) => {
    // 1. Allow existing signed-in WorkshopOne web sessions (for testing in browser/cockpit)
    if (req.user) {
      if (req.user.role === 'admin' || req.user.role === 'superadmin') {
        req.sapClient = { id: req.user.id, name: req.user.username, scopes: ['*'] };
        return next();
      }
    }

    // 2. Check API Key header
    const apiKey = req.headers['x-sap-api-key'] || req.query.apiKey;
    const authHeader = req.headers['authorization'];

    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }

    // Default configured SAP gateway token or env token
    const expectedKey = process.env.SAP_GATEWAY_API_KEY || config.sapGatewayKey || 'sap-wsone-dev-token-2026';

    if ((apiKey && apiKey === expectedKey) || (token && token === expectedKey)) {
      req.sapClient = {
        id: 'sap-integration-gateway',
        name: 'SAP BTP Client',
        scopes: ['EAM_Tech', 'MM_Clerk', 'Fleet_Manager', 'Audit_Compliance', '*']
      };

      if (requiredScope && !req.sapClient.scopes.includes('*') && !req.sapClient.scopes.includes(requiredScope)) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN_SCOPE',
            message: `Client lacks the required SAP scope: ${requiredScope}`,
            target: 'authorization'
          }
        });
      }
      return next();
    }

    // 3. Fallback check: check user authorization if signed in with standard session
    if (req.user) {
      // Map WorkshopOne roles to SAP scopes
      const roleScopes = {
        admin: ['*'],
        superadmin: ['*'],
        manager: ['EAM_Tech', 'MM_Clerk', 'Fleet_Manager'],
        storekeeper: ['MM_Clerk'],
        engineer: ['EAM_Tech', 'Fleet_Manager'],
        transport: ['Fleet_Manager', 'EAM_Tech']
      };

      const userScopes = roleScopes[req.user.role] || [];
      if (!requiredScope || userScopes.includes('*') || userScopes.includes(requiredScope)) {
        req.sapClient = { id: req.user.id, name: req.user.username, scopes: userScopes };
        return next();
      }
    }

    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Valid SAP API Key (x-sap-api-key) or Bearer Token required.',
        target: 'authorization'
      }
    });
  };
}

module.exports = {
  requireSapAuth
};
