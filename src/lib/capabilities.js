'use strict';

// ===========================================================================
// Capabilities — WHAT a person may do, one named action at a time.
//
// Access Resolution Order (WorkshopOne Plan Part B):
//   1. Admin role always holds every capability.
//   2. Temporary access expiration (user.access_until): expired -> none.
//   3. Role starting template: base set from role_capabilities.
//   4. Person-by-person overrides in user_capabilities:
//      granted = 1 -> granted specifically to this user
//      granted = 0 -> explicitly revoked from this user
// ===========================================================================

const { all, run } = require('../db');

const C = (key, module, label, legacy = [], needs = null, section = null, actvt = '02', domain = 'Operations', dualAuth = false) => ({
  key, module, label, legacy: Array.isArray(legacy) ? legacy : [], needs, section: section || module, actvt, domain, dualAuth: !!dualAuth
});

const ALL_ROLES = ['storekeeper', 'main_storekeeper', 'workshop', 'transport_manager', 'assistant_transport_manager', 'operational_manager', 'manager', 'purchase_head_office', 'purchase_local', 'viewer'];
const OPS_MANAGERS = ['operational_manager', 'manager'];
const TRANSPORT_MANAGERS = ['transport_manager', 'assistant_transport_manager', 'operational_manager', 'manager'];
const ALL_MANAGERS = ['transport_manager', 'assistant_transport_manager', 'operational_manager', 'manager'];
const STORE_STAFF = ['storekeeper', 'main_storekeeper'];

const CAPABILITIES = [
  // ============================================================================================
  // DOMAIN 1: OPERATIONS (Dashboard, Job Cards, Job Requests, Field Work, Operations, Daily Work, Services, Service Plan)
  // ============================================================================================

  // ---- 1. Dashboard (Z_WO_DASH) --------------------------------------------------------------
  C('dashboard.view', 'dashboard', 'View main dashboard and operational task counts', ALL_ROLES, null, 'dashboard', '03', 'Operations'),
  C('dashboard.kpi.view', 'dashboard', 'View high-level executive KPI fleet metrics', ['workshop', 'transport_manager', 'operational_manager', 'manager', 'viewer'], null, 'dashboard', '03', 'Operations'),
  C('dashboard.export', 'dashboard', 'Export dashboard charts and summary data', OPS_MANAGERS.concat(['transport_manager']), null, 'dashboard', '08', 'Operations'),

  // ---- 2. Job Cards & Work Orders (Z_WO_JOBS) ------------------------------------------------
  C('jobs.view', 'jobs', 'View open and closed job cards and service sheets', ALL_ROLES, null, 'jobs', '03', 'Operations'),
  C('jobs.create', 'jobs', 'Open a job card from an approved job request', ['workshop', 'manager'], 'jobs', 'jobs', '01', 'Operations'),
  C('jobs.edit', 'jobs', 'Change a job card\'s vehicle, description or type', ['workshop', 'operational_manager', 'manager'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.delete', 'jobs', 'Delete or void an un-started job card', ['manager'], 'jobs', 'jobs', '06', 'Operations', true),
  C('jobs.approve_transport', 'jobs', 'Approve a job card — transport step', ['transport_manager'], 'jobs', 'jobs', '10', 'Operations'),
  C('jobs.approve_operations', 'jobs', 'Approve a job card — operations step', OPS_MANAGERS, 'jobs', 'jobs', '10', 'Operations'),
  C('jobs.assign_workshop', 'jobs', 'Take an approved job card into the workshop bay', ['workshop'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.start', 'jobs', 'Start physical repair work on a job card', ['workshop'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.complete', 'jobs', 'Mark a job card\'s physical repair work complete', ['workshop'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.close', 'jobs', 'Close a job card and seal financial posting', ['operational_manager', 'workshop', 'manager'], 'jobs', 'jobs', '10', 'Operations'),
  C('jobs.close_on_date', 'jobs', 'Close a job card on a chosen (past) date', ['operational_manager', 'workshop', 'manager'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.reject', 'jobs', 'Reject a job card at an approval step', ['transport_manager', 'operational_manager', 'manager'], 'jobs', 'jobs', '10', 'Operations'),
  C('jobs.return', 'jobs', 'Send a job card back to "requested" state', ['transport_manager', 'operational_manager', 'manager'], 'jobs', 'jobs', '10', 'Operations'),
  C('jobs.reopen', 'jobs', 'Reopen a CLOSED job card for corrections', ['operational_manager', 'manager', 'workshop'], 'jobs', 'jobs', '02', 'Operations', true),
  C('jobs.reason', 'jobs', 'Log reason why a job in the workshop is not being worked on', ['workshop', 'transport_manager', 'operational_manager', 'manager'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.dailywork', 'jobs', 'Add or remove daily work labour on a job card', ['workshop'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.parts', 'jobs', 'Add, price or remove parts on a job card', ['workshop', 'storekeeper', 'manager'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.flat_labour', 'jobs', 'Set a service job\'s flat labour charge', ['workshop', 'operational_manager'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.triage', 'jobs', 'Review stuck job cards and reject or close them in bulk', OPS_MANAGERS, 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.partial_close', 'jobs', 'Partly close a job card (work done, prices still missing)', ['operational_manager', 'workshop'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.reopen_request', 'jobs', 'Ask for a partly closed or closed job card to be reopened', ['workshop', 'operational_manager', 'manager'], 'jobs', 'jobs', '02', 'Operations'),
  C('jobs.settings', 'jobs', 'Switch partial close and reopen requests on or off', ['manager'], null, 'jobs', '02', 'Operations'),
  C('jobs.cost.view', 'jobs', 'View parts and labour monetary costs (unmasked)', OPS_MANAGERS.concat(['transport_manager']), 'jobs', 'jobs', '03', 'Operations'),
  C('jobs.export', 'jobs', 'Export job cards to PDF and Excel work orders', ['workshop', 'operational_manager', 'manager', 'transport_manager'], 'jobs', 'jobs', '08', 'Operations'),
  C('jobs.breakdown', 'jobs', 'Report a breakdown in the field (opens a field job card)', ['transport_manager', 'assistant_transport_manager', 'workshop', 'operational_manager', 'manager'], null, 'field', '01', 'Operations'),
  C('jobs.field', 'jobs', 'Record field work on a job card (site, times, km)', ['workshop', 'operational_manager', 'manager'], 'jobs', 'field', '02', 'Operations'),
  C('jobs.view_other_workshops', 'jobs', 'View job cards and service records of other workshops (read-only)', ['workshop', 'operational_manager', 'manager', 'transport_manager'], 'jobs', 'jobs', '03', 'Operations'),

  // ---- 3. Job Requests (Z_WO_JREQ) -----------------------------------------------------------
  C('jobrequests.view', 'jobrequests', 'View incoming vehicle repair requests', ALL_ROLES, null, 'jobs', '03', 'Operations'),
  C('jobrequests.create', 'jobrequests', 'Raise a job request from driver or field', ['assistant_transport_manager', 'transport_manager', 'workshop'], 'jobrequests', 'jobs', '01', 'Operations'),
  C('jobrequests.certify', 'jobrequests', 'Certify a job request (transport step)', ['transport_manager'], 'jobrequests', 'jobs', 'A1', 'Operations'),
  C('jobrequests.approve', 'jobrequests', 'Approve a job request (operations step)', OPS_MANAGERS, 'jobrequests', 'jobs', '10', 'Operations'),
  C('jobrequests.reject', 'jobrequests', 'Reject a job request at certify or approve step', ['transport_manager', 'operational_manager', 'manager'], 'jobrequests', 'jobs', '10', 'Operations'),
  C('jobrequests.delete', 'jobrequests', 'Cancel an unapproved job request', ['transport_manager', 'operational_manager', 'manager'], 'jobrequests', 'jobs', '06', 'Operations'),

  // ---- 4. Field Work & Breakdowns (Z_WO_FLD) -------------------------------------------------
  C('field.view', 'field', 'View mobile field breakdown calls and road repairs', ALL_ROLES, null, 'field', '03', 'Operations'),
  C('field.create', 'field', 'Dispatch emergency mobile field repair team', ['transport_manager', 'assistant_transport_manager', 'workshop', 'operational_manager', 'manager'], null, 'field', '01', 'Operations'),
  C('field.edit', 'field', 'Update field response times, GPS site, and km', ['workshop', 'operational_manager', 'manager'], 'jobs', 'field', '02', 'Operations'),
  C('field.approve', 'field', 'Approve field breakdown hours and site allowances', OPS_MANAGERS, null, 'field', '10', 'Operations'),
  C('field.export', 'field', 'Export field work breakdown history', ALL_MANAGERS, null, 'field', '08', 'Operations'),

  // ---- 5. Operations & Movements (Z_WO_OPS) --------------------------------------------------
  C('operations.view', 'operations', 'View machine deployment register and location movements', ALL_ROLES, null, 'operations', '03', 'Operations'),
  C('operations.dispatch', 'operations', 'Authorize transport carrier and dispatch machine', ALL_MANAGERS, null, 'operations', '01', 'Operations'),
  C('operations.site_change', 'operations', 'Reassign asset operating site or project yard', ALL_MANAGERS, null, 'operations', '02', 'Operations'),
  C('operations.export', 'operations', 'Export equipment deployment history', ALL_MANAGERS, null, 'operations', '08', 'Operations'),

  // ---- 6. Daily Work & Attendance (Z_WO_DWORK) -----------------------------------------------
  C('dailywork.view', 'dailywork', 'View daily workshop labour entries and work logs', ALL_ROLES, null, 'dailywork', '03', 'Operations'),
  C('dailywork.add', 'dailywork', 'Add daily technician work hours against job cards', ['workshop', 'manager', 'storekeeper'], 'dailywork', 'dailywork', '01', 'Operations'),
  C('dailywork.edit', 'dailywork', 'Edit, bulk-log or correct daily work entries', ['workshop', 'manager'], 'dailywork', 'dailywork', '02', 'Operations'),
  C('dailywork.delete', 'dailywork', 'Remove invalid daily work line items', ['workshop', 'manager'], 'dailywork', 'dailywork', '06', 'Operations'),
  C('dailywork.bulk_log', 'dailywork', 'Batch-log labour hours across entire workshop shift', ['workshop', 'manager'], 'dailywork', 'dailywork', '01', 'Operations'),
  C('dailywork.export', 'dailywork', 'Export daily technician labour hours to Excel', ['workshop', 'manager', 'operational_manager'], null, 'dailywork', '08', 'Operations'),
  C('attendance.record', 'dailywork', 'Record technician daily attendance (Present/Absent/Leave)', ['workshop', 'manager'], null, 'dailywork', '01', 'Operations'),
  C('attendance.unlock', 'dailywork', 'Unlock historical signed-off attendance day', OPS_MANAGERS, null, 'dailywork', '02', 'Operations', true),
  C('attendance.signoff', 'dailywork', 'Sign off a day\'s attendance and work tallies (locks day)', ['workshop', 'manager'], null, 'dailywork', '10', 'Operations'),
  C('attendance.settings', 'dailywork', 'Configure overtime policy and attendance locks', ['manager'], null, 'dailywork', '02', 'Operations'),

  // ---- 7. Service Records (Z_WO_SERV) --------------------------------------------------------
  C('services.view', 'services', 'View preventative maintenance records and service passports', ALL_ROLES, null, 'services', '03', 'Operations'),
  C('services.create', 'services', 'Log a completed preventative service with meter reading', ['workshop', 'operational_manager', 'manager'], null, 'services', '01', 'Operations'),
  C('services.edit', 'services', 'Update service checklist items, odometer, and technician notes', ['workshop', 'operational_manager', 'manager'], null, 'services', '02', 'Operations'),
  C('services.delete', 'services', 'Void a duplicate or erroneously created service record', OPS_MANAGERS, null, 'services', '06', 'Operations'),
  C('services.attachments', 'services', 'Upload or delete service inspection sheets and invoices', ['workshop', 'storekeeper', 'operational_manager', 'manager'], null, 'services', '02', 'Operations'),
  C('services.checklist.verify', 'services', 'Engineer sign-off on 40-point maintenance checklist', ['workshop', 'operational_manager', 'manager'], null, 'services', '10', 'Operations'),
  C('services.export', 'services', 'Export vehicle service passport and oil change history', ALL_MANAGERS.concat(['workshop']), null, 'services', '08', 'Operations'),

  // ---- 8. Service Plan (Z_WO_SPLAN) ----------------------------------------------------------
  C('service_plan.view', 'service_plan', 'View service interval forecast matrix and upcoming countdowns', ALL_ROLES, null, 'service_plan', '03', 'Operations'),
  C('service_plan.calculate', 'service_plan', 'Recalculate PM forecast based on latest machine meter readings', ['operational_manager', 'manager', 'workshop'], null, 'service_plan', '02', 'Operations'),
  C('service_plan.override_interval', 'service_plan', 'Override default OEM service intervals for severe site conditions', OPS_MANAGERS, null, 'service_plan', '02', 'Operations'),
  C('service_plan.export', 'service_plan', 'Export scheduled maintenance forecast calendar', ALL_MANAGERS, null, 'service_plan', '08', 'Operations'),

  // ============================================================================================
  // DOMAIN 2: FLEET & ASSETS (Assets, Vehicle Documents, Lubricant Capacities, Labour, Projects, Aliases)
  // ============================================================================================

  // ---- 9. Assets Master Register (Z_WO_ASSET) ------------------------------------------------
  C('assets.view', 'assets', 'View asset master register, specifications, and meter history', ALL_ROLES, null, 'assets', '03', 'Fleet'),
  C('assets.create', 'assets', 'Register a new vehicle or heavy machine in the fleet', ['storekeeper', 'manager', 'transport_manager', 'operational_manager'], 'assets', 'assets', '01', 'Fleet'),
  C('assets.edit', 'assets', 'Edit vehicle make, model, chassis, engine, and year', ['storekeeper', 'manager', 'transport_manager', 'operational_manager'], 'assets', 'assets', '02', 'Fleet'),
  C('assets.delete', 'assets', 'Delete an asset record from the system registry', ['manager'], 'assets', 'assets', '06', 'Fleet', true),
  C('assets.deactivate', 'assets', 'Mark machine decommissioned, scrapped, or archived', ALL_MANAGERS, 'assets', 'assets', '02', 'Fleet'),
  C('assets.photo.upload', 'assets', 'Upload, re-order, and categorize asset gallery photos', ['storekeeper', 'workshop', 'manager', 'transport_manager'], 'assets', 'assets', '02', 'Fleet'),
  C('assets.repoint', 'assets', 'Repoint legacy vehicle codes to standardized numbers', ['manager'], null, 'assets', '02', 'Fleet'),
  C('assets.move', 'assets', 'Move a machine to another project or site', ALL_MANAGERS, null, 'operations', '02', 'Fleet'),
  C('assets.export', 'assets', 'Export complete fleet register and depreciation summaries', ALL_MANAGERS, null, 'assets', '08', 'Fleet'),

  // ---- 10. Vehicle Statutory Documents (Z_WO_VDOC) -------------------------------------------
  C('vehicle_docs.view', 'vehicle_docs', 'View vehicle statutory documents, statuses and countdowns', ALL_ROLES, 'assets', 'vehicle_docs', '03', 'Fleet'),
  C('vehicle_docs.create', 'vehicle_docs', 'Register a new compliance requirement for a vehicle', ALL_MANAGERS, 'assets', 'vehicle_docs', '01', 'Fleet'),
  C('vehicle_docs.edit', 'vehicle_docs', 'Create or edit vehicle document metadata and records', ALL_MANAGERS, 'assets', 'vehicle_docs', '02', 'Fleet'),
  C('vehicle_docs.delete', 'vehicle_docs', 'Remove an obsolete vehicle document requirement', OPS_MANAGERS, 'assets', 'vehicle_docs', '06', 'Fleet'),
  C('vehicle_docs.upload', 'vehicle_docs', 'Upload certificates, cover notes and payment receipts', ALL_MANAGERS.concat(['workshop']), 'assets', 'vehicle_docs', '02', 'Fleet'),
  C('vehicle_docs.renew', 'vehicle_docs', 'Submit renewal versions and manage renewal tasks', ALL_MANAGERS, 'assets', 'vehicle_docs', '02', 'Fleet'),
  C('vehicle_docs.verify', 'vehicle_docs', 'Verify and promote renewed document versions (Transport / Ops Manager)', ALL_MANAGERS, 'assets', 'vehicle_docs', '10', 'Fleet'),
  C('vehicle_docs.download', 'vehicle_docs', 'Download attached document files and certificates', ALL_ROLES, 'assets', 'vehicle_docs', '03', 'Fleet'),
  C('vehicle_docs.exempt', 'vehicle_docs', 'Mark vehicle document requirements as exempt (off-road / laid-up)', ALL_MANAGERS, 'assets', 'vehicle_docs', '02', 'Fleet', true),
  C('vehicle_docs.export', 'vehicle_docs', 'Generate and export statutory compliance audit report', ALL_MANAGERS, 'assets', 'vehicle_docs', '08', 'Fleet'),

  // ---- 11. Lubricant Capacities (Z_WO_LCAP) --------------------------------------------------
  C('lubricants.view', 'lubricants', 'View equipment OEM oil capacities and grade specifications', ALL_ROLES, null, 'lubricants', '03', 'Fleet'),
  C('lubricants.create', 'lubricants', 'Add lubrication capacity profile for a machine model', ['storekeeper', 'workshop', 'manager'], null, 'lubricants', '01', 'Fleet'),
  C('lubricants.edit', 'lubricants', 'Edit vehicle sump, gearbox, and hydraulic oil capacities', ['storekeeper', 'workshop', 'manager'], null, 'lubricants', '02', 'Fleet'),
  C('fleet.capacities.edit', 'lubricants', 'Legacy alias: Add, edit or delete vehicle lubricant capacities', ['storekeeper', 'workshop', 'manager'], null, 'lubricants', '02', 'Fleet'),
  C('lubricants.delete', 'lubricants', 'Delete an obsolete lubrication capacity profile', ['manager'], null, 'lubricants', '06', 'Fleet'),
  C('lubricants.import', 'lubricants', 'Bulk-import OEM lubrication tables from spreadsheet', ['manager'], null, 'lubricants', '01', 'Fleet'),
  C('lubricants.export', 'lubricants', 'Export lubricant capacity reference matrix', ALL_ROLES, null, 'lubricants', '08', 'Fleet'),

  // ---- 12. Labour Rates & Mechanics (Z_WO_LABOUR) --------------------------------------------
  C('labour.mechanics.view', 'labour', 'View technician directory, trades, and assigned workshops', ALL_ROLES, null, 'labour', '03', 'Fleet'),
  C('labour.mechanics.create', 'labour', 'Add a mechanic or apprentice to the staff register', OPS_MANAGERS, null, 'labour', '01', 'Fleet'),
  C('labour.mechanics.edit', 'labour', 'Edit labourer status, trade qualification or profile', OPS_MANAGERS, null, 'labour', '02', 'Fleet'),
  C('labour.mechanics.move', 'labour', 'Move a mechanic to another workshop branch', OPS_MANAGERS, null, 'labour', '02', 'Fleet'),
  C('labour.mechanics.deactivate', 'labour', 'Archive a resigned or transferred technician', OPS_MANAGERS, null, 'labour', '02', 'Fleet'),
  C('mechanics.create', 'labour', 'Legacy alias: Add a mechanic to the staff register', OPS_MANAGERS, null, 'labour', '01', 'Fleet'),
  C('mechanics.edit', 'labour', 'Legacy alias: Edit mechanic profile', OPS_MANAGERS, null, 'labour', '02', 'Fleet'),
  C('mechanics.move', 'labour', 'Legacy alias: Move mechanic to another workshop', OPS_MANAGERS, null, 'labour', '02', 'Fleet'),
  C('labour.rates.view', 'labour', 'CONFIDENTIAL: View mechanic hourly wage and charge rates', OPS_MANAGERS, null, 'labour', '03', 'Fleet'),
  C('labour.rates.edit', 'labour', 'Set a mechanic\'s hourly wage and charge rates', ['manager'], null, 'labour', '02', 'Fleet', true),

  // ---- 13. Projects & Sites (Z_WO_PRJ) -------------------------------------------------------
  C('projects.view', 'projects', 'View civil projects, road schemes, and quarry sites', ALL_ROLES, null, 'projects', '03', 'Fleet'),
  C('projects.manage', 'projects', 'Create and edit projects and their constituent sites', OPS_MANAGERS, null, 'projects', '02', 'Fleet'),
  C('projects.close', 'projects', 'Mark civil contract completed and archive project', OPS_MANAGERS, null, 'projects', '02', 'Fleet'),
  C('projects.export', 'projects', 'Export projects master directory and active sites', OPS_MANAGERS, null, 'projects', '08', 'Fleet'),

  // ---- 14. Alias Queue (Z_WO_ALIAS) ----------------------------------------------------------
  C('aliases.view', 'aliases', 'View unrecognised vehicle and mechanic text queue', ['storekeeper', 'workshop', 'manager', 'operational_manager'], null, 'aliases', '03', 'Fleet'),
  C('aliases.vehicle.resolve', 'aliases', 'Link or dismiss an unrecognised vehicle name', ['storekeeper', 'workshop', 'manager'], null, 'aliases', '02', 'Fleet'),
  C('aliases.mechanic.resolve', 'aliases', 'Link an unrecognised mechanic name', ['storekeeper', 'manager'], null, 'aliases', '02', 'Fleet'),
  C('aliases.allocate', 'aliases', 'Allocate vehicle to job request directly in alias queue', ['storekeeper', 'workshop', 'manager'], null, 'aliases', '02', 'Fleet'),
  C('aliases.ignore', 'aliases', 'Dismiss or ignore an unresolvable raw text entry', ['storekeeper', 'manager'], null, 'aliases', '02', 'Fleet'),

  // ============================================================================================
  // DOMAIN 3: INVENTORY (Stores, Stores Docs, Tools, Oil, Batteries, Filters)
  // ============================================================================================

  // ---- 15. Stores Catalogue & Physical Hierarchy (Z_WO_STORE) --------------------------------
  C('stores.view', 'stores', 'View parts catalogue, shelf locations, and bin cards', ALL_ROLES, 'stores', 'stores', '03', 'Inventory'),
  C('stores.items.create', 'stores', 'Register a new store inventory SKU and barcode', STORE_STAFF.concat(['manager']), 'stores', 'stores', '01', 'Inventory'),
  C('stores.items.edit', 'stores', 'Create or edit store catalogue items and their prices', STORE_STAFF.concat(['manager']), 'stores', 'stores', '02', 'Inventory'),
  C('stores.items.price', 'stores', 'Set parts standard cost and issue charge-out prices', STORE_STAFF.concat(['manager']), 'stores', 'stores', '02', 'Inventory'),
  C('stores.items.delete', 'stores', 'Delete an obsolete or unused store catalogue SKU', ['manager'], 'stores', 'stores', '06', 'Inventory', true),
  C('stores.items.txn', 'stores', 'Record manual stock receipts, adjustments and issues', STORE_STAFF, 'stores', 'stores', '02', 'Inventory'),
  C('stores.categories.edit', 'stores', 'Add or rename store item categories', STORE_STAFF.concat(['manager']), 'stores', 'stores', '02', 'Inventory'),
  C('stores.locations.view', 'stores', 'View physical store locations and network hierarchy', ALL_ROLES, 'stores', 'stores', '03', 'Inventory'),
  C('stores.locations.manage', 'stores', 'Configure physical store locations and hierarchy', ['main_storekeeper', 'manager'], 'stores', 'stores', '02', 'Inventory'),
  C('stores.locations.access', 'stores', 'Assign store location permissions to staff', ['manager'], 'stores', 'stores', '02', 'Inventory'),
  C('stores.stock.rebuild', 'stores', 'Rebuild stock balances from the ledgers (maintenance)', STORE_STAFF.concat(['manager']), 'stores', 'stores', '02', 'Inventory'),
  C('stores.stock.levels', 'stores', 'Set a store\'s min, max, and reorder levels', STORE_STAFF.concat(['manager']), 'stores', 'stores', '02', 'Inventory'),
  C('stores.export', 'stores', 'Export parts valuation, fast/slow moving items, and bin cards', STORE_STAFF.concat(OPS_MANAGERS), 'stores', 'stores', '08', 'Inventory'),
  C('general.items.edit', 'stores', 'Add a general rack item', STORE_STAFF, 'stores', 'stores', '02', 'Inventory'),
  C('general.stock.adjust', 'stores', 'Adjust a general rack item\'s stock', STORE_STAFF, 'stores', 'stores', '02', 'Inventory'),
  C('general.items.price', 'stores', 'Set a general rack item\'s price', STORE_STAFF, 'stores', 'stores', '02', 'Inventory'),

  // ---- 16. Stores Documents & Transactions (Z_WO_SDOC) ---------------------------------------
  C('stores.mrn.create', 'stores', 'Raise a Material Requisition Note (MRN)', STORE_STAFF.concat(['workshop', 'assistant_transport_manager']), 'stores', 'stores', '01', 'Inventory'),
  C('stores.mrn.edit', 'stores', 'Change or cancel an open MRN', STORE_STAFF.concat(['workshop']), 'stores', 'stores', '02', 'Inventory'),
  C('stores.mrn.certify', 'stores', 'Certify an MRN (workshop step)', ['workshop'], null, 'stores', 'A1', 'Inventory'),
  C('stores.mrn.site_authority', 'stores', 'Review and approve/reject material demand as Site Authority', ALL_MANAGERS.concat(['workshop', 'engineer']), null, 'stores', '10', 'Inventory'),
  C('stores.mrn.approve', 'stores', 'Approve an MRN (operations step, up to your limit)', OPS_MANAGERS, null, 'stores', '10', 'Inventory'),
  C('stores.mrn.reject', 'stores', 'Reject an MRN at certify or approve step', ['workshop', 'operational_manager', 'manager'], null, 'stores', '10', 'Inventory'),
  C('stores.mrn.amend_settled', 'stores', 'Amend a settled MRN after issues have posted', OPS_MANAGERS, 'stores', 'stores', '02', 'Inventory', true),
  C('stores.grn.receive', 'stores', 'Receive goods into workshop store or central store (GRN)', STORE_STAFF, 'stores', 'stores', '01', 'Inventory'),
  C('stores.grn.edit', 'stores', 'Price or edit a goods receipt (GRN)', STORE_STAFF, 'stores', 'stores', '02', 'Inventory'),
  C('stores.grn.approve', 'stores', 'Approve a Goods Received Note (GRN) posting', OPS_MANAGERS.concat(['workshop']), null, 'stores', '10', 'Inventory'),
  C('stores.grn.reject', 'stores', 'Reject a Goods Received Note (GRN)', OPS_MANAGERS.concat(['workshop']), null, 'stores', '10', 'Inventory'),
  C('stores.issue', 'stores', 'Hand over parts against an approved MRN', STORE_STAFF, 'stores', 'stores', '02', 'Inventory'),
  C('stores.stock_issue', 'stores', 'Issue catalogue parts from the shelf onto a job card', STORE_STAFF, 'stores', 'stores', '02', 'Inventory'),
  C('stores.min.approve', 'stores', 'Approve a Material Issue Note (MIN)', ['workshop', 'operational_manager', 'manager'], null, 'stores', '10', 'Inventory'),
  C('stores.min.reject', 'stores', 'Reject a Material Issue Note (MIN)', ['workshop', 'operational_manager', 'manager'], null, 'stores', '10', 'Inventory'),
  C('stores.reorder_mrn', 'stores', 'Generate restock MRNs from stock cockpit reorder lines', STORE_STAFF.concat(['manager']), 'stores', 'stores', '01', 'Inventory'),
  C('stores.mtn.edit', 'stores', 'Create, send, receive or cancel Material Transfer Notes (MTN)', STORE_STAFF, 'stores', 'stores', '01', 'Inventory'),
  C('stores.mtn.approve', 'stores', 'Approve a Material Transfer Note (MTN)', ['workshop', 'operational_manager', 'manager'], null, 'stores', '10', 'Inventory'),
  C('stores.mtn.reject', 'stores', 'Reject a Material Transfer Note (MTN)', ['workshop', 'operational_manager', 'manager'], null, 'stores', '10', 'Inventory'),
  C('stores.issue_return', 'stores', 'Return an issued part back to store stock', STORE_STAFF, 'stores', 'stores', '02', 'Inventory'),
  C('stores.stock.count', 'stores', 'Open and record physical stock counts', STORE_STAFF.concat(['manager']), 'stores', 'stores', '01', 'Inventory'),
  C('stores.count.approve', 'stores', 'Approve a stock take and put its corrections into stock (HO)', OPS_MANAGERS, null, 'stores', '10', 'Inventory', true),
  C('stores.disposal.edit', 'stores', 'Write a disposal note (scrap and waste oil to sell)', STORE_STAFF, 'stores', 'stores', '01', 'Inventory'),
  C('stores.disposal.approve', 'stores', 'Approve a disposal note, with buyer, amount and date', OPS_MANAGERS, null, 'stores', '10', 'Inventory'),

  // ---- 17. Tools, Toolboxes & Scrap Control (Z_WO_TOOL) ---------------------------------------
  C('tools.view', 'tools', 'View tools inventory, mechanic toolboxes, daily logs and scrap records', ALL_ROLES, 'stores', 'tools', '03', 'Inventory'),
  C('tools.manage', 'tools', 'Register, edit and reassign workshop tools and mechanic toolboxes', STORE_STAFF.concat(['manager']), 'stores', 'tools', '02', 'Inventory'),
  C('tools.delete', 'tools', 'Delete an incorrect tool entry from workshop registry', ['manager'], 'stores', 'tools', '06', 'Inventory'),
  C('tools.issue', 'tools', 'Check out and check in tools on daily workshop log', STORE_STAFF, 'stores', 'tools', '02', 'Inventory'),
  C('tools.damage.report', 'tools', 'Report a broken or damaged tool and raise scrap request', STORE_STAFF.concat(['workshop', 'manager']), 'stores', 'tools', '01', 'Inventory'),
  C('tools.scrap.approve', 'tools', 'Inspect broken tools and approve or reject removal to scrap', ['engineer', 'assistant_engineer', 'operational_manager', 'manager'], null, 'tools', '10', 'Inventory', true),
  C('tools.toolbox.audit', 'tools', 'Perform physical verification audit on mechanic toolbox', ['workshop', 'storekeeper', 'manager'], 'stores', 'tools', '01', 'Inventory'),
  C('tools.export', 'tools', 'Export tooling register and breakage logs to Excel', STORE_STAFF.concat(OPS_MANAGERS).concat(['workshop']), 'stores', 'tools', '08', 'Inventory'),

  // ---- 18. Oil & Bulk Lubricants (Z_WO_OIL) --------------------------------------------------
  C('oil.view', 'oil', 'View bulk lubricant stocks, dipstick logs, and issue ledgers', ALL_ROLES, 'oil', 'oil', '03', 'Inventory'),
  C('oil.identity.resolve', 'oil', 'Decide which oil-book product a lubricant name is', STORE_STAFF, 'oil', 'oil', '02', 'Inventory'),
  C('oil.products.edit', 'oil', 'Add or edit an oil product brand or grade', STORE_STAFF.concat(['manager']), 'oil', 'oil', '02', 'Inventory'),
  C('oil.prices.edit', 'oil', 'Set oil procurement cost and charge-out prices', STORE_STAFF.concat(['manager']), 'oil', 'oil', '02', 'Inventory'),
  C('oil.ledger.post', 'oil', 'Post bulk oil receipts and sump dispense issues', STORE_STAFF, 'oil', 'oil', '01', 'Inventory'),
  C('oil.count', 'oil', 'Record an oil dipstick physical stock count', STORE_STAFF, 'oil', 'oil', '01', 'Inventory'),
  C('oil.export', 'oil', 'Export lubricant consumption ledgers and dip records', STORE_STAFF.concat(OPS_MANAGERS), 'oil', 'oil', '08', 'Inventory'),

  // ---- 19. Batteries (Z_WO_BATT) -------------------------------------------------------------
  C('batteries.view', 'batteries', 'View serial-tracked battery pool, voltages, and test logs', ALL_ROLES, 'batteries', 'batteries', '03', 'Inventory'),
  C('batteries.register', 'batteries', 'Register a new battery with serial number and specs', STORE_STAFF, 'batteries', 'batteries', '01', 'Inventory'),
  C('batteries.photos', 'batteries', 'Add, change or remove battery inspection photos', STORE_STAFF, 'batteries', 'batteries', '02', 'Inventory'),
  C('batteries.event', 'batteries', 'Record battery event (fitted, removed, charged, warranty claim)', STORE_STAFF, 'batteries', 'batteries', '02', 'Inventory'),
  C('batteries.scrap', 'batteries', 'Approve condemned battery write-off and scrap disposal', OPS_MANAGERS, null, 'batteries', '10', 'Inventory', true),
  C('batteries.export', 'batteries', 'Export battery registry and replacement history', STORE_STAFF.concat(OPS_MANAGERS), 'batteries', 'batteries', '08', 'Inventory'),

  // ---- 20. Filters & Consumables (Z_WO_FILT) -------------------------------------------------
  C('filters.view', 'filters', 'View filter catalogue and store bin stock balances', ALL_ROLES, 'filters', 'filters', '03', 'Inventory'),
  C('filters.stock.edit', 'filters', 'Add or edit a filter stock item part number', STORE_STAFF, 'filters', 'filters', '02', 'Inventory'),
  C('filters.stock.receive', 'filters', 'Receive filters into store inventory', STORE_STAFF, 'filters', 'filters', '01', 'Inventory'),
  C('filters.stock.issue', 'filters', 'Issue filters from stock against service job cards', STORE_STAFF, 'filters', 'filters', '02', 'Inventory'),
  C('filters.prices.edit', 'filters', 'Set filter procurement cost and issue prices', STORE_STAFF.concat(['manager']), 'filters', 'filters', '02', 'Inventory'),
  C('filters.export', 'filters', 'Export filter stock valuation and consumption matrix', STORE_STAFF.concat(OPS_MANAGERS), 'filters', 'filters', '08', 'Inventory'),

  // ============================================================================================
  // DOMAIN 4: PROCUREMENT (Purchasing, Tyre & Battery Requests, Tyre & Battery Reports)
  // ============================================================================================

  // ---- 21. Purchasing & Supplier Procurement (Z_WO_PURCH) -----------------------------------
  C('purchasing.view', 'purchasing', 'View procurement pipelines and supplier order queues', ['purchase_head_office', 'purchase_local', 'manager', 'operational_manager', 'viewer'], 'purchasing', 'purchasing', '03', 'Procurement'),
  C('purchasing.head_office', 'purchasing', 'Work the Head Office purchasing channel', ['purchase_head_office', 'manager'], 'purchasing', 'purchasing', '02', 'Procurement'),
  C('purchasing.local', 'purchasing', 'Work the Local purchasing channel', ['purchase_local', 'manager'], 'purchasing', 'purchasing', '02', 'Procurement'),
  C('purchasing.all_channels', 'purchasing', 'Work both purchasing channels (managers)', OPS_MANAGERS, 'purchasing', 'purchasing', '03', 'Procurement'),
  C('purchasing.priority_edit', 'purchasing', 'Adjust buying priorities and urgency notes', ['workshop', 'operational_manager', 'manager', 'purchase_head_office', 'purchase_local'], 'purchasing', 'purchasing', '02', 'Procurement'),
  C('purchasing.po.create', 'purchasing', 'Generate formal Purchase Orders to vendors', ['purchase_head_office', 'purchase_local', 'manager'], 'purchasing', 'purchasing', '01', 'Procurement'),
  C('purchasing.po.approve', 'purchasing', 'Approve vendor purchase orders up to limit', OPS_MANAGERS, 'purchasing', 'purchasing', '10', 'Procurement'),
  C('purchasing.suppliers.manage', 'purchasing', 'Maintain vendor master records, payment terms, and ratings', ['purchase_head_office', 'manager'], 'purchasing', 'purchasing', '02', 'Procurement'),
  C('purchasing.price_override', 'purchasing', 'Override negotiated vendor catalogue rates', OPS_MANAGERS, 'purchasing', 'purchasing', '02', 'Procurement'),
  C('purchasing.export', 'purchasing', 'Export purchasing commitments and supplier expenditure', OPS_MANAGERS.concat(['purchase_head_office']), 'purchasing', 'purchasing', '08', 'Procurement'),

  // ---- 22. Tyre & Battery Requests (Z_WO_TBREQ) ----------------------------------------------
  C('tb.request.view', 'tb_requests', 'View tyre and battery replacement demands and status', ALL_ROLES, null, 'tb_requests', '03', 'Procurement'),
  C('tb.specs.edit', 'tb_requests', 'Edit tyre and battery technical specifications and sizes', OPS_MANAGERS, null, 'tb_requests', '02', 'Procurement'),
  C('tb.request.create', 'tb_requests', 'Raise a new tyre or battery requisition for an asset', STORE_STAFF.concat(['workshop', 'assistant_transport_manager']), null, 'tb_requests', '01', 'Procurement'),
  C('tb.request.certify', 'tb_requests', 'Certify tyre wear / tread depth before replacement', ['transport_manager', 'workshop'], null, 'tb_requests', 'A1', 'Procurement'),
  C('tb.request.approve', 'tb_requests', 'Approve tyre or battery replacement request', OPS_MANAGERS, null, 'tb_requests', '10', 'Procurement'),
  C('tb.purchase.send', 'tb_requests', 'Send approved request to purchasing procurement queue', STORE_STAFF.concat(['manager']), null, 'tb_requests', '02', 'Procurement'),
  C('tb.grn.receive', 'tb_requests', 'Receive tyres or batteries into store from vendor', STORE_STAFF, null, 'tb_requests', '01', 'Procurement'),
  C('tb.issue.post', 'tb_requests', 'Post fitment issue to vehicle with wheel position', STORE_STAFF, null, 'tb_requests', '02', 'Procurement'),

  // ---- 23. Tyre & Battery Reports & Wear Tracking (Z_WO_TBREP) -------------------------------
  C('tb.reports.view', 'tb_reports', 'View tyre wear logs, scrap summaries, and wheel analytics', ALL_ROLES, null, 'tb_reports', '03', 'Procurement'),
  C('tb.inspection.record', 'tb_reports', 'Record periodic tread depth and tyre pressure inspection', ['workshop', 'storekeeper'], null, 'tb_reports', '01', 'Procurement'),
  C('tb.scrap.approve', 'tb_reports', 'Inspect worn tyres and approve casing scrap or retread', OPS_MANAGERS, null, 'tb_reports', '10', 'Procurement', true),
  C('tb.reports.export', 'tb_reports', 'Export fleet tyre wear and mileage life sheets', OPS_MANAGERS, null, 'tb_reports', '08', 'Procurement'),

  // ============================================================================================
  // DOMAIN 5: ANALYSIS (Needs Attention, Daily Progress, Cost Teardown, Reports)
  // ============================================================================================

  // ---- 24. Needs Attention & Diagnostic Radar (Z_WO_ATTN) -----------------------------------
  C('attention.view', 'attention', 'View automated diagnostic radar alerts and fleet warnings', ALL_ROLES, null, 'attention', '03', 'Analysis'),
  C('attention.dismiss', 'attention', 'Acknowledge and snooze non-critical operational warnings', OPS_MANAGERS, null, 'attention', '02', 'Analysis'),
  C('attention.recalc', 'attention', 'Force diagnostic scan recalculation across fleet', OPS_MANAGERS, null, 'attention', '02', 'Analysis'),
  C('attention.export', 'attention', 'Export automated exception report to Excel', OPS_MANAGERS, null, 'attention', '08', 'Analysis'),

  // ---- 25. Daily Progress Journal & Notes (Z_WO_PROG) ---------------------------------------
  C('daily_progress.view', 'daily_progress', 'View plant output diaries and daily progress reports', ALL_ROLES, null, 'daily_progress', '03', 'Analysis'),
  C('daily_progress.create', 'daily_progress', 'Record daily site machinery progress remarks and diaries', ['workshop', 'operational_manager', 'manager', 'storekeeper'], null, 'daily_progress', '01', 'Analysis'),
  C('daily_progress.notes.edit', 'daily_progress', 'Write and edit notes on the daily reports', ['workshop', 'operational_manager', 'manager', 'storekeeper'], null, 'daily_progress', '02', 'Analysis'),
  C('reports.daily.notes', 'daily_progress', 'Legacy alias: Write notes on the daily reports', ['workshop', 'operational_manager', 'manager', 'storekeeper'], null, 'daily_progress', '02', 'Analysis'),
  C('daily_progress.signoff', 'daily_progress', 'Site Supervisor sign-off on daily work diary', OPS_MANAGERS, null, 'daily_progress', '10', 'Analysis'),
  C('daily_progress.export', 'daily_progress', 'Export daily progress and site diary sheets', OPS_MANAGERS, null, 'daily_progress', '08', 'Analysis'),

  // ---- 26. Cost Teardown (Z_WO_COST) ---------------------------------------------------------
  C('cost_teardown.view', 'cost_teardown', 'View life-to-date machine cost teardown and breakdown', ALL_MANAGERS.concat(['viewer']), null, 'cost_teardown', '03', 'Analysis'),
  C('cost_teardown.drilldown', 'cost_teardown', 'Drill down into individual expense items and job parts', ALL_MANAGERS, null, 'cost_teardown', '03', 'Analysis'),
  C('cost_teardown.export', 'cost_teardown', 'Export cost teardown breakdown to Excel', OPS_MANAGERS, null, 'cost_teardown', '08', 'Analysis'),

  // ---- 27. Reports & Financial Statements (Z_WO_REP) -----------------------------------------
  C('reports.view', 'reports', 'View standard monthly vehicle cost reports', ALL_ROLES, null, 'reports', '03', 'Analysis'),
  C('reports.financial.view', 'reports', 'CONFIDENTIAL: View total company expenditure and profit margins', OPS_MANAGERS, null, 'reports', '03', 'Analysis'),
  C('reports.monthly_cost.edit', 'reports', 'Edit monthly vehicle cost inputs (fuel, depreciation, leasing)', OPS_MANAGERS, null, 'reports', '02', 'Analysis'),
  C('reports.repair_sections.sync', 'reports', 'Re-sync labour into the repair sections report', ['operational_manager', 'workshop'], null, 'reports', '02', 'Analysis'),
  C('reports.export_excel', 'reports', 'Download unmasked financial reports to Excel', OPS_MANAGERS, null, 'reports', '08', 'Analysis'),
  C('reports.export_pdf', 'reports', 'Download executive monthly PDF board reports', OPS_MANAGERS, null, 'reports', '08', 'Analysis'),

  // ============================================================================================
  // DOMAIN 6: ADMINISTRATION & GOVERNANCE (Workshops, Users, Access Control)
  // ============================================================================================

  // ---- 28. Workshops Master (Z_WO_WSHOP) -----------------------------------------------------
  C('workshops.view', 'workshops', 'View workshop branch directory and home workshop mapping', ALL_ROLES, null, 'workshops', '03', 'Admin'),
  C('workshops.manage', 'workshops', 'Add, rename and retire workshop branches', ['manager'], null, 'workshops', '02', 'Admin'),
  C('workshops.all', 'workshops', 'Work across all workshops (head office oversight)', ['manager', 'operational_manager', 'purchase_head_office', 'purchase_local'], null, 'workshops', '03', 'Admin'),
  C('workshops.cluster.assign', 'workshops', 'Group workshops into regional operational clusters', ['manager'], null, 'workshops', '02', 'Admin'),

  // ---- 29. Access Control & Security Governance (Z_WO_SEC) -----------------------------------
  C('users.manage', 'access', 'Create accounts, reset passwords, assign roles', ['manager'], null, 'access', '02', 'Admin'),
  C('access.manage', 'access', 'Create and edit roles, their permissions and clearance matrix', ['manager'], null, 'access', '02', 'Admin'),
  C('system.status', 'access', 'See backup status, server uptime, and database health', ['manager'], null, 'access', '03', 'Admin'),
  C('audit.log.view', 'access', 'View SHA-256 hash-chained security audit ledger', OPS_MANAGERS, null, 'access', '03', 'Admin'),
  C('dual_auth.override', 'access', 'Executive override on pending 4-Eyes dual auth requests', ['manager'], null, 'access', '10', 'Admin'),
  C('user.session.kill', 'access', 'Terminate active user web and mobile sessions', ['manager'], null, 'access', '06', 'Admin'),
  C('mfa.enforce', 'access', 'Enforce mandatory Two-Factor Authentication on roles', ['manager'], null, 'access', '02', 'Admin'),
];


const CAP_KEYS = CAPABILITIES.map((c) => c.key);
const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));
const isCapability = (k) => BY_KEY.has(k);

const RESERVED_ROLE_NAMES = new Set(['admin', ...CAPABILITIES.flatMap((c) => c.legacy),
  ...Object.keys(require('./permissions').DEFAULT_MATRIX)]);

function seedCapabilities() {
  let seeded = 0;
  for (const c of CAPABILITIES) {
    for (const role of c.legacy) {
      seeded += run('INSERT OR IGNORE INTO role_capabilities (role, capability, granted) VALUES (?, ?, 1)', role, c.key).changes;
    }
  }
  return { seeded };
}

/** Every capability a set of roles holds. Admin holds all. */
function capsForRoles(roles) {
  if (!roles || !roles.length) return [];
  if (roles.includes('admin')) return CAP_KEYS.slice();
  const marks = roles.map(() => '?').join(',');
  return all(`SELECT DISTINCT capability FROM role_capabilities WHERE granted = 1 AND role IN (${marks})`, ...roles)
    .map((r) => r.capability)
    .filter(isCapability)
    .sort();
}

/** Every capability a specific USER holds (incorporates user_capabilities overrides on top of role template). */
function effectiveCaps(user) {
  if (!user) return [];
  const roles = user.roles || [];
  if (roles.includes('admin')) return CAP_KEYS.slice();

  // Temporary access check
  if (user.access_until) {
    const until = new Date(user.access_until);
    if (!isNaN(until.getTime()) && until < new Date()) {
      return [];
    }
  }

  // Start with role capabilities
  const set = new Set(capsForRoles(roles));

  // Apply user-level capability overrides
  if (user.id) {
    const userCaps = all('SELECT capability, granted FROM user_capabilities WHERE user_id = ?', user.id);
    for (const uc of userCaps) {
      if (isCapability(uc.capability)) {
        if (uc.granted) set.add(uc.capability);
        else set.delete(uc.capability);
      }
    }

    // Step 3b: stand-in delegated approval capabilities (plan §4.2)
    if (!user.skipDelegations) {
      try {
        const standIn = require('./stand_in');
        const dCaps = standIn.delegatedCapsFor(user.id);
        for (const dc of dCaps) set.add(dc);
      } catch {
        // Safe fallback before stand_in table is initialized
      }
    }
  }

  return Array.from(set).sort();
}

function needsFor(caps) {
  const out = {};
  for (const k of caps) { const c = BY_KEY.get(k); if (c && c.needs) out[k] = c.needs; }
  return out;
}

function capsForRole(role) {
  return capsForRoles([role]);
}

function setCapability(role, capability, granted) {
  if (role === 'admin') { const e = new Error('Admin always holds every permission and cannot be changed'); e.status = 400; throw e; }
  if (!isCapability(capability)) { const e = new Error(`Unknown permission: ${capability}`); e.status = 400; throw e; }
  run(`INSERT INTO role_capabilities (role, capability, granted, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(role, capability) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at`,
    role, capability, granted ? 1 : 0);
}

function setUserCapability(userId, capability, granted) {
  if (!isCapability(capability)) { const e = new Error(`Unknown permission: ${capability}`); e.status = 400; throw e; }
  run(`INSERT INTO user_capabilities (user_id, capability, granted, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, capability) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at`,
    userId, capability, granted ? 1 : 0);
}

function removeUserCapability(userId, capability) {
  run('DELETE FROM user_capabilities WHERE user_id = ? AND capability = ?', userId, capability);
}

function clearUserCapabilities(userId) {
  run('DELETE FROM user_capabilities WHERE user_id = ?', userId);
}

module.exports = {
  CAPABILITIES, CAP_KEYS, RESERVED_ROLE_NAMES,
  isCapability, seedCapabilities, capsForRoles, effectiveCaps, capsForRole, setCapability,
  setUserCapability, removeUserCapability, clearUserCapabilities, needsFor,
  get: (k) => BY_KEY.get(k),
};
