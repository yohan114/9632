'use strict';

/**
 * Fleet Identity & Cross-System Entity Resolver (Plan V2)
 *
 * Provides bidirectional resolution between Fuel-System-V2 UUIDs and WorkshopOne
 * native identities (Assets, Projects, Users, Tanks).
 * Maintains 100% provenance and auditability in fleet_identity_mappings table.
 */

const { get, all, run, tx } = require('../db');

/**
 * Resolve a Fuel Asset UUID or identifier to native WorkshopOne asset record.
 */
function resolveAsset(sourceIdOrCode, { autoRecord = true } = {}) {
  if (!sourceIdOrCode) return null;
  const str = String(sourceIdOrCode).trim();

  // 1. Check existing identity mapping
  const mapped = get(`
    SELECT m.target_id, a.*
      FROM fleet_identity_mappings m
      JOIN assets a ON a.id = CAST(m.target_id AS INTEGER)
     WHERE m.source_system = 'FUEL_SYSTEM_V2'
       AND m.entity_type = 'ASSET'
       AND (m.source_id = ? OR m.source_code = ?)
  `, str, str);
  if (mapped) return mapped;

  // 2. Direct lookup in native WorkshopOne assets by ec_code
  let asset = get(`
    SELECT * FROM assets 
     WHERE UPPER(TRIM(ec_code)) = UPPER(?)
     ORDER BY in_register DESC, id ASC LIMIT 1
  `, str);

  // 3. Direct lookup in native WorkshopOne assets by registration
  if (!asset) {
    asset = get(`
      SELECT * FROM assets 
       WHERE UPPER(TRIM(registration)) = UPPER(?)
       ORDER BY in_register DESC, id ASC LIMIT 1
    `, str);
  }

  // 4. Lookup in asset_aliases table via canonical alias resolver
  if (!asset) {
    try {
      const aliases = require('./aliases');
      const res = aliases.resolveAsset(str, { source: 'fuel_identity' });
      if (res && res.resolved && res.assetId) {
        asset = get('SELECT * FROM assets WHERE id = ?', res.assetId);
      }
    } catch (_) {}
  }

  // 5. If found and autoRecord is true, record the mapping
  if (asset && autoRecord) {
    try {
      run(`
        INSERT OR IGNORE INTO fleet_identity_mappings (
          entity_type, source_system, source_id, target_id, match_method, source_code, target_code
        ) VALUES ('ASSET', 'FUEL_SYSTEM_V2', ?, ?, ?, ?, ?)
      `, str, String(asset.id), str === asset.ec_code ? 'EXACT_FLEET_CODE' : 'EXACT_REG_NO', str, asset.ec_code || asset.registration);
    } catch (_) {}
  }

  return asset || null;
}

/**
 * Resolve a Project Site from Fuel project ID, code, or name to native WorkshopOne project.
 */
function resolveProject(sourceIdOrName, { autoRecord = true } = {}) {
  if (!sourceIdOrName) return null;
  const str = String(sourceIdOrName).trim();

  // 1. Check identity mapping
  const mapped = get(`
    SELECT m.target_id, p.*
      FROM fleet_identity_mappings m
      JOIN projects p ON p.id = CAST(m.target_id AS INTEGER)
     WHERE m.source_system = 'FUEL_SYSTEM_V2'
       AND m.entity_type = 'PROJECT'
       AND (m.source_id = ? OR m.source_code = ?)
  `, str, str);
  if (mapped) return mapped;

  // 2. Lookup in native projects by code or name
  let proj = get(`
    SELECT * FROM projects
     WHERE UPPER(TRIM(code)) = UPPER(?)
        OR UPPER(TRIM(name)) = UPPER(?)
     LIMIT 1
  `, str, str);

  // 3. Fallback: fuzzy/partial match on major project names (e.g. "CEP-03" -> "Central Expressway Package 3")
  if (!proj) {
    proj = get(`
      SELECT * FROM projects
       WHERE UPPER(name) LIKE UPPER(?) || '%'
          OR UPPER(?) LIKE '%' || UPPER(code) || '%'
       LIMIT 1
    `, str, str);
  }

  if (proj && autoRecord) {
    try {
      run(`
        INSERT OR IGNORE INTO fleet_identity_mappings (
          entity_type, source_system, source_id, target_id, match_method, source_code, target_code
        ) VALUES ('PROJECT', 'FUEL_SYSTEM_V2', ?, ?, 'EXACT_PROJECT_CODE', ?, ?)
      `, str, String(proj.id), str, proj.code || proj.name);
    } catch (_) {}
  }

  return proj || null;
}

/**
 * Resolve a User from Fuel username or ID to native WorkshopOne user.
 */
function resolveUser(sourceIdOrUsername, { autoRecord = true } = {}) {
  if (!sourceIdOrUsername) return null;
  const str = String(sourceIdOrUsername).trim();

  // 1. Check identity mapping
  const mapped = get(`
    SELECT m.target_id, u.*
      FROM fleet_identity_mappings m
      JOIN users u ON u.id = CAST(m.target_id AS INTEGER)
     WHERE m.source_system = 'FUEL_SYSTEM_V2'
       AND m.entity_type = 'USER'
       AND (m.source_id = ? OR m.source_code = ?)
  `, str, str);
  if (mapped) return mapped;

  // 2. Lookup in native users table by username
  const user = get(`
    SELECT * FROM users
     WHERE LOWER(TRIM(username)) = LOWER(?)
     LIMIT 1
  `, str);

  if (user && autoRecord) {
    try {
      run(`
        INSERT OR IGNORE INTO fleet_identity_mappings (
          entity_type, source_system, source_id, target_id, match_method, source_code, target_code
        ) VALUES ('USER', 'FUEL_SYSTEM_V2', ?, ?, 'EXACT_USERNAME', ?, ?)
      `, str, String(user.id), str, user.username);
    } catch (_) {}
  }

  return user || null;
}

module.exports = {
  resolveAsset,
  resolveProject,
  resolveUser,
};
