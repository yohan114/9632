'use strict';

/**
 * ===========================================================================
 * Segregation of Duties (SoD) & Toxic Combination Rules (Plan Phase 4)
 *
 * Implements SAP GRC / SOX style conflict prevention rules.
 * Flags toxic capability combinations that violate four-eyes principles
 * and internal control separation.
 * ===========================================================================
 */

const SOD_RULES = [
  {
    code: 'SOD-MRN-01',
    title: 'Requisition Creation & Requisition Approval',
    caps: ['stores.mrn.create', 'stores.mrn.approve'],
    severity: 'CRITICAL',
    description: 'A user cannot both initiate a material request (MRN) and approve it for procurement/issuance without an authorized governance exception.'
  },
  {
    code: 'SOD-GRN-01',
    title: 'Goods Receipt & Master Item Pricing',
    caps: ['stores.grn.receive', 'stores.items.price'],
    severity: 'CRITICAL',
    description: 'A physical storekeeper receiving items cannot determine, overwrite, or assign unit prices on stock items.'
  },
  {
    code: 'SOD-COUNT-01',
    title: 'Physical Stock Count & Variance Write-Off Approval',
    caps: ['stores.stock.count', 'stores.count.approve'],
    severity: 'CRITICAL',
    description: 'A storekeeper who counts physical inventory cannot unilaterally approve discrepancy write-offs or stock adjustments.'
  },
  {
    code: 'SOD-PURCH-01',
    title: 'Purchase Order Generation & Commercial Approval',
    caps: ['purchasing.po.create', 'purchasing.po.approve'],
    severity: 'HIGH',
    description: 'The buyer generating a purchase order cannot authorize commercial spend without independent approval.'
  },
  {
    code: 'SOD-JOB-01',
    title: 'Job Card Execution & Final Engineering Sign-off',
    caps: ['jobs.create', 'jobs.signoff'],
    severity: 'HIGH',
    description: 'A technician opening work cards cannot perform final QA gatekeeper sign-off.'
  },
  {
    code: 'SOD-DISP-01',
    title: 'Disposal Recommendation & Final Scrap Authorization',
    caps: ['stores.disposal.request', 'stores.disposal.approve'],
    severity: 'CRITICAL',
    description: 'A person proposing asset scrapping or disposal cannot approve write-off disposals.'
  },
  {
    code: 'SOD-FAB-01',
    title: 'Fabrication Costing Preparation & Cost Approval',
    caps: ['fabrication.cost.edit', 'fabrication.cost.approve'],
    severity: 'CRITICAL',
    description: 'The officer preparing the fabrication costing sheet cannot approve it for financial posting.'
  }
];

const SENSITIVE_CAPABILITIES = [
  'access.manage',
  'users.manage',
  'stores.mrn.approve',
  'stores.count.approve',
  'stores.disposal.approve',
  'purchasing.po.approve',
  'audit.logs.view',
  'audit.logs.export'
];

/**
 * Check a set of capabilities for SoD conflicts.
 *
 * @param {string[]|Set<string>} capabilities
 * @returns {Array<{ rule: Object, conflicts: string[] }>}
 */
function findSodConflicts(capabilities) {
  const capSet = new Set(capabilities || []);
  const violations = [];

  for (const rule of SOD_RULES) {
    const matched = rule.caps.filter((c) => capSet.has(c));
    if (matched.length === rule.caps.length) {
      violations.push({
        rule: {
          code: rule.code,
          title: rule.title,
          severity: rule.severity,
          description: rule.description
        },
        conflicts: matched
      });
    }
  }

  return violations;
}

/**
 * Validate capabilities against SoD rules.
 * Throws 409 Conflict if violations exist and no approved exception reason is provided.
 */
function assertNoSodConflicts(capabilities, exceptionReason = null) {
  const conflicts = findSodConflicts(capabilities);
  if (!conflicts.length) return true;

  const reason = String(exceptionReason || '').trim();
  if (reason && reason.length >= 10) {
    // Approved exception recorded
    return {
      allowedWithException: true,
      conflicts,
      reason
    };
  }

  const first = conflicts[0];
  const err = new Error(
    `Segregation of Duties (SoD) Conflict: [${first.rule.code}] ${first.rule.title}. ${first.rule.description} To authorize emergency dual clearance, provide an approved justification reason (min 10 characters).`
  );
  err.status = 409;
  err.code = 'SOD_CONFLICT';
  err.conflicts = conflicts;
  err.data = { code: 'SOD_CONFLICT', conflicts };
  throw err;
}

/**
 * Check if a list of capabilities contains high-risk sensitive capabilities.
 */
function findSensitiveCapabilities(capabilities) {
  const capSet = new Set(capabilities || []);
  return SENSITIVE_CAPABILITIES.filter((c) => capSet.has(c));
}

module.exports = {
  SOD_RULES,
  SENSITIVE_CAPABILITIES,
  findSodConflicts,
  assertNoSodConflicts,
  findSensitiveCapabilities
};
