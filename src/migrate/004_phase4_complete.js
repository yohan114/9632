'use strict';

/**
 * ============================================================================
 * Migration 004 — Phase 4: complete stores / inventory / cost schema
 * ----------------------------------------------------------------------------
 * TARGET:  MySQL 8.0+  (uses ENUM, JSON, CHECK constraints, generated columns,
 *          ON UPDATE CURRENT_TIMESTAMP). This is a GREENFIELD MYSQL PORT target,
 *          not the SQLite (better-sqlite3) schema the Node app currently runs on.
 *
 * DEPENDS ON phases 001–003 having created the core tables: `vehicles`,
 *          `stores`, `oil`, `filters`, `job_cards`, `users`. The column-adding
 *          steps for stores/oil/filters are GUARDED — if a table is missing they
 *          skip with a warning rather than aborting.
 *
 * RUN (with mysql2/promise):
 *          const mysql = require('mysql2/promise');
 *          const conn  = await mysql.createConnection({ ...cfg, multipleStatements: false });
 *          await require('./004_phase4_complete').up(conn);      // apply
 *          await require('./004_phase4_complete').down(conn);    // rollback
 *
 * IDEMPOTENT: re-running up() is safe (CREATE TABLE IF NOT EXISTS + information_
 *          schema guards on every ALTER / INDEX / TRIGGER).
 *
 * DESIGN NOTES
 *  - "updated_at trigger on all tables": implemented via the native
 *    `ON UPDATE CURRENT_TIMESTAMP` column attribute — the atomic, idiomatic MySQL
 *    equivalent of a BEFORE-UPDATE trigger, with no per-row trigger overhead.
 *    Explicit triggers are used ONLY where a value must be derived at insert time
 *    (the auto request_no / issue_no document numbers). A BEFORE-UPDATE trigger
 *    template is provided (commented) at the end if you must have trigger objects.
 *  - Money is DECIMAL(14,2); `total_*` columns are GENERATED STORED so they can
 *    never drift from their components.
 *  - All tables: InnoDB + utf8mb4 for full Unicode (Sinhala/Tamil) support.
 * ============================================================================
 */

const ENGINE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

// ---- idempotency helpers ---------------------------------------------------
async function tableExists(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`, [table]);
  return r.length > 0;
}
async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [table, column]);
  return r.length > 0;
}
async function indexExists(conn, table, index) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`, [table, index]);
  return r.length > 0;
}
async function fkExists(conn, table, fk) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`, [table, fk]);
  return r.length > 0;
}

async function addColumn(conn, table, column, ddl) {
  if (!(await tableExists(conn, table))) { console.warn(`  [skip] table \`${table}\` not found — add column \`${column}\` in a later phase once ${table} exists`); return; }
  if (await columnExists(conn, table, column)) { console.log(`  [ok]   ${table}.${column} already present`); return; }
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  console.log(`  [add]  ${table}.${column}`);
}
async function dropColumnIf(conn, table, column) {
  if (await tableExists(conn, table) && await columnExists(conn, table, column)) {
    await conn.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    console.log(`  [drop] ${table}.${column}`);
  }
}
async function addIndex(conn, table, index, cols) {
  if (!(await tableExists(conn, table)) || await indexExists(conn, table, index)) return;
  await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` (${cols})`);
  console.log(`  [idx]  ${table}.${index}`);
}
// Add a FK only if both tables exist (keeps the migration robust across phase order).
async function addFk(conn, table, fk, cols, refTable, refCols, onDelete = 'RESTRICT') {
  if (!(await tableExists(conn, table)) || !(await tableExists(conn, refTable))) {
    console.warn(`  [skip] FK ${fk}: ${table} or ${refTable} missing`); return;
  }
  if (await fkExists(conn, table, fk)) return;
  await conn.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${fk}\` FOREIGN KEY (${cols}) REFERENCES \`${refTable}\` (${refCols}) ON DELETE ${onDelete} ON UPDATE CASCADE`);
  console.log(`  [fk]   ${table}.${fk} -> ${refTable}`);
}

// ===========================================================================
// UP
// ===========================================================================
async function up(conn) {
  console.log('▶ 004_phase4_complete: up()');

  // -- shared document-number counters (race-safe auto numbering) ------------
  await conn.query(`CREATE TABLE IF NOT EXISTS \`doc_counters\` (
    \`name\`        VARCHAR(40)      NOT NULL PRIMARY KEY,
    \`current_val\` BIGINT UNSIGNED  NOT NULL DEFAULT 0
  ) ${ENGINE}`);
  await conn.query(`INSERT IGNORE INTO \`doc_counters\` (\`name\`, \`current_val\`) VALUES ('material_request', 0), ('stock_issue', 0)`);

  // == 1) EXISTING GAPS: stores / oil / filters (guarded ALTERs) =============
  // stores
  await addColumn(conn, 'stores', 'category',
    `\`category\` ENUM('general','vehicle','oil','filter','battery') NOT NULL DEFAULT 'general' AFTER \`id\``);
  await addColumn(conn, 'stores', 'reorder_level', `\`reorder_level\` INT NOT NULL DEFAULT 0`);
  await addColumn(conn, 'stores', 'location', `\`location\` VARCHAR(120) NULL`);
  await addIndex(conn, 'stores', 'idx_stores_category', '`category`');
  await addIndex(conn, 'stores', 'idx_stores_reorder', '`reorder_level`');

  // oil  (total_cost is generated so it always equals stock_quantity * unit_cost)
  await addColumn(conn, 'oil', 'stock_quantity', `\`stock_quantity\` DECIMAL(12,2) NOT NULL DEFAULT 0`);
  await addColumn(conn, 'oil', 'unit_cost', `\`unit_cost\` DECIMAL(12,2) NOT NULL DEFAULT 0`);
  await addColumn(conn, 'oil', 'total_cost',
    `\`total_cost\` DECIMAL(14,2) AS (ROUND(\`stock_quantity\` * \`unit_cost\`, 2)) STORED`);
  await addColumn(conn, 'oil', 'supplier', `\`supplier\` VARCHAR(150) NULL`);
  await addIndex(conn, 'oil', 'idx_oil_supplier', '`supplier`');

  // filters
  await addColumn(conn, 'filters', 'stock_quantity', `\`stock_quantity\` INT NOT NULL DEFAULT 0`);
  await addColumn(conn, 'filters', 'unit_cost', `\`unit_cost\` DECIMAL(12,2) NOT NULL DEFAULT 0`);
  await addColumn(conn, 'filters', 'compatible_vehicles',
    `\`compatible_vehicles\` JSON NULL CHECK (\`compatible_vehicles\` IS NULL OR JSON_VALID(\`compatible_vehicles\`))`);

  // == 2) NEW TABLE: general_stock (items not tied to a vehicle) =============
  await conn.query(`CREATE TABLE IF NOT EXISTS \`general_stock\` (
    \`id\`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`item_code\`     VARCHAR(50)     NOT NULL,
    \`item_name\`     VARCHAR(200)    NOT NULL,
    \`category\`      ENUM('stationery','tools','safety','cleaning','consumable','spare','other') NOT NULL DEFAULT 'other',
    \`unit\`          VARCHAR(20)     NOT NULL DEFAULT 'nos',
    \`quantity\`      DECIMAL(12,2)   NOT NULL DEFAULT 0,
    \`reorder_level\` DECIMAL(12,2)   NOT NULL DEFAULT 0,
    \`unit_cost\`     DECIMAL(12,2)   NOT NULL DEFAULT 0,
    \`total_value\`   DECIMAL(14,2)   AS (ROUND(\`quantity\` * \`unit_cost\`, 2)) STORED,
    \`location\`      VARCHAR(120)    NULL,
    \`supplier\`      VARCHAR(150)    NULL,
    \`is_low\`        TINYINT(1)      AS (\`quantity\` <= \`reorder_level\`) STORED,
    \`created_at\`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`last_updated\`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_general_stock_code\` (\`item_code\`),
    KEY \`idx_general_stock_category\` (\`category\`),
    KEY \`idx_general_stock_low\` (\`is_low\`),
    KEY \`idx_general_stock_name\` (\`item_name\`)
  ) ${ENGINE}`);

  // == 3) NEW TABLE: material_requests (general/vehicle, workflow) ===========
  await conn.query(`CREATE TABLE IF NOT EXISTS \`material_requests\` (
    \`id\`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`request_no\`           VARCHAR(30)     NOT NULL,
    \`request_type\`         ENUM('general','vehicle') NOT NULL,
    \`vehicle_id\`           BIGINT UNSIGNED NULL,
    \`requested_by\`         VARCHAR(150)    NOT NULL,
    \`department\`           VARCHAR(120)    NULL,
    \`items\`                JSON            NOT NULL CHECK (JSON_VALID(\`items\`) AND JSON_TYPE(\`items\`) = 'ARRAY'),
    \`item_count\`           INT             AS (JSON_LENGTH(\`items\`)) VIRTUAL,
    \`total_estimated_cost\` DECIMAL(14,2)   NOT NULL DEFAULT 0,
    \`status\`               ENUM('pending','approved','partially_issued','issued','rejected') NOT NULL DEFAULT 'pending',
    \`approved_by\`          VARCHAR(150)    NULL,
    \`approved_at\`          DATETIME        NULL,
    \`notes\`                TEXT            NULL,
    \`created_at\`           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_material_requests_no\` (\`request_no\`),
    KEY \`idx_mr_status\` (\`status\`),
    KEY \`idx_mr_type\` (\`request_type\`),
    KEY \`idx_mr_vehicle\` (\`vehicle_id\`),
    KEY \`idx_mr_created\` (\`created_at\`),
    CONSTRAINT \`chk_mr_vehicle_required\` CHECK (\`request_type\` <> 'vehicle' OR \`vehicle_id\` IS NOT NULL)
  ) ${ENGINE}`);

  // == 4) NEW TABLE: stock_issues (who took what, when, cost) ================
  await conn.query(`CREATE TABLE IF NOT EXISTS \`stock_issues\` (
    \`id\`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`issue_no\`            VARCHAR(30)     NOT NULL,
    \`issue_date\`          DATE            NOT NULL DEFAULT (CURRENT_DATE),
    \`issued_to\`           VARCHAR(150)    NOT NULL,
    \`vehicle_id\`          BIGINT UNSIGNED NULL,
    \`job_card_id\`         BIGINT UNSIGNED NULL,
    \`items\`               JSON            NOT NULL CHECK (JSON_VALID(\`items\`) AND JSON_TYPE(\`items\`) = 'ARRAY'),
    \`item_count\`          INT             AS (JSON_LENGTH(\`items\`)) VIRTUAL,
    \`total_cost\`          DECIMAL(14,2)   NOT NULL DEFAULT 0,
    \`issued_by\`           VARCHAR(150)    NOT NULL,
    \`material_request_id\` BIGINT UNSIGNED NULL,
    \`notes\`               TEXT            NULL,
    \`created_at\`          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_stock_issues_no\` (\`issue_no\`),
    KEY \`idx_si_date\` (\`issue_date\`),
    KEY \`idx_si_vehicle\` (\`vehicle_id\`),
    KEY \`idx_si_job\` (\`job_card_id\`),
    KEY \`idx_si_mr\` (\`material_request_id\`),
    KEY \`idx_si_issued_to\` (\`issued_to\`)
  ) ${ENGINE}`);

  // == 5) NEW TABLE: vehicle_cost_summary (per vehicle × month rollup) =======
  await conn.query(`CREATE TABLE IF NOT EXISTS \`vehicle_cost_summary\` (
    \`id\`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`vehicle_id\`  BIGINT UNSIGNED NOT NULL,
    \`year\`        SMALLINT UNSIGNED NOT NULL,
    \`month\`       TINYINT UNSIGNED  NOT NULL,
    \`fuel_cost\`   DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`oil_cost\`    DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`filter_cost\` DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`battery_cost\`DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`parts_cost\`  DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`labour_cost\` DECIMAL(14,2) NOT NULL DEFAULT 0,
    \`total_cost\`  DECIMAL(14,2) AS (ROUND(\`fuel_cost\` + \`oil_cost\` + \`filter_cost\` + \`battery_cost\` + \`parts_cost\` + \`labour_cost\`, 2)) STORED,
    \`updated_at\`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_vcs_vehicle_period\` (\`vehicle_id\`, \`year\`, \`month\`),
    KEY \`idx_vcs_period\` (\`year\`, \`month\`),
    CONSTRAINT \`chk_vcs_month\` CHECK (\`month\` BETWEEN 1 AND 12)
  ) ${ENGINE}`);

  // == 6) NEW TABLE: live_events (WebSocket / realtime event log) ============
  // Append-only log — no updated_at (rows are never mutated).
  await conn.query(`CREATE TABLE IF NOT EXISTS \`live_events\` (
    \`id\`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`event_type\`  VARCHAR(80)     NOT NULL,
    \`channel\`     VARCHAR(80)     NULL,
    \`entity_type\` VARCHAR(80)     NULL,
    \`entity_id\`   BIGINT UNSIGNED NULL,
    \`payload\`     JSON            NULL CHECK (\`payload\` IS NULL OR JSON_VALID(\`payload\`)),
    \`user_id\`     BIGINT UNSIGNED NULL,
    \`created_at\`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY \`idx_le_type\` (\`event_type\`),
    KEY \`idx_le_created\` (\`created_at\`),
    KEY \`idx_le_entity\` (\`entity_type\`, \`entity_id\`),
    KEY \`idx_le_channel\` (\`channel\`)
  ) ${ENGINE}`);

  // == 7) NEW TABLE: dashboard_snapshots (KPI cache) =========================
  await conn.query(`CREATE TABLE IF NOT EXISTS \`dashboard_snapshots\` (
    \`id\`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`snapshot_key\` VARCHAR(120)    NOT NULL,
    \`scope\`        VARCHAR(80)     NULL,
    \`data\`         JSON            NOT NULL CHECK (JSON_VALID(\`data\`)),
    \`computed_at\`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`expires_at\`   DATETIME        NULL,
    \`updated_at\`   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_dashboard_key\` (\`snapshot_key\`),
    KEY \`idx_ds_expires\` (\`expires_at\`),
    KEY \`idx_ds_scope\` (\`scope\`)
  ) ${ENGINE}`);

  // == 8) FOREIGN KEYS (added after all tables exist; guarded) ===============
  await addFk(conn, 'material_requests', 'fk_mr_vehicle', '`vehicle_id`', 'vehicles', '`id`', 'SET NULL');
  await addFk(conn, 'stock_issues', 'fk_si_vehicle', '`vehicle_id`', 'vehicles', '`id`', 'SET NULL');
  await addFk(conn, 'stock_issues', 'fk_si_job_card', '`job_card_id`', 'job_cards', '`id`', 'SET NULL');
  await addFk(conn, 'stock_issues', 'fk_si_material_request', '`material_request_id`', 'material_requests', '`id`', 'SET NULL');
  await addFk(conn, 'vehicle_cost_summary', 'fk_vcs_vehicle', '`vehicle_id`', 'vehicles', '`id`', 'CASCADE');

  // == 9) TRIGGERS: auto document numbers (MR-000001 / ISS-000001) ==========
  // Race-safe: LAST_INSERT_ID(expr) atomically bumps + returns the counter.
  await conn.query(`DROP TRIGGER IF EXISTS \`trg_material_requests_no\``);
  await conn.query(`CREATE TRIGGER \`trg_material_requests_no\` BEFORE INSERT ON \`material_requests\`
    FOR EACH ROW
    BEGIN
      IF NEW.\`request_no\` IS NULL OR NEW.\`request_no\` = '' THEN
        UPDATE \`doc_counters\` SET \`current_val\` = LAST_INSERT_ID(\`current_val\` + 1) WHERE \`name\` = 'material_request';
        SET NEW.\`request_no\` = CONCAT('MR-', LPAD(LAST_INSERT_ID(), 6, '0'));
      END IF;
    END`);

  await conn.query(`DROP TRIGGER IF EXISTS \`trg_stock_issues_no\``);
  await conn.query(`CREATE TRIGGER \`trg_stock_issues_no\` BEFORE INSERT ON \`stock_issues\`
    FOR EACH ROW
    BEGIN
      IF NEW.\`issue_no\` IS NULL OR NEW.\`issue_no\` = '' THEN
        UPDATE \`doc_counters\` SET \`current_val\` = LAST_INSERT_ID(\`current_val\` + 1) WHERE \`name\` = 'stock_issue';
        SET NEW.\`issue_no\` = CONCAT('ISS-', LPAD(LAST_INSERT_ID(), 6, '0'));
      END IF;
    END`);

  console.log('✔ 004_phase4_complete: up() done');
}

// ===========================================================================
// DOWN — full rollback (children before parents; guarded IF EXISTS)
// ===========================================================================
async function down(conn) {
  console.log('▶ 004_phase4_complete: down()');

  await conn.query(`DROP TRIGGER IF EXISTS \`trg_material_requests_no\``);
  await conn.query(`DROP TRIGGER IF EXISTS \`trg_stock_issues_no\``);

  // Drop FKs first so table drops don't fail on dependency order.
  for (const [t, fk] of [
    ['stock_issues', 'fk_si_material_request'],
    ['stock_issues', 'fk_si_job_card'],
    ['stock_issues', 'fk_si_vehicle'],
    ['material_requests', 'fk_mr_vehicle'],
    ['vehicle_cost_summary', 'fk_vcs_vehicle'],
  ]) {
    if (await fkExists(conn, t, fk)) { await conn.query(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${fk}\``); console.log(`  [drop fk] ${t}.${fk}`); }
  }

  for (const t of ['dashboard_snapshots', 'live_events', 'vehicle_cost_summary', 'stock_issues', 'material_requests', 'general_stock']) {
    await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    console.log(`  [drop table] ${t}`);
  }

  // Revert the column additions on the pre-existing tables.
  for (const c of ['compatible_vehicles', 'unit_cost', 'stock_quantity']) await dropColumnIf(conn, 'filters', c);
  for (const c of ['supplier', 'total_cost', 'unit_cost', 'stock_quantity']) await dropColumnIf(conn, 'oil', c);
  for (const c of ['location', 'reorder_level', 'category']) await dropColumnIf(conn, 'stores', c);

  await conn.query(`DELETE FROM \`doc_counters\` WHERE \`name\` IN ('material_request', 'stock_issue')`);
  // doc_counters is left in place (harmless, may be shared by other phases).

  console.log('✔ 004_phase4_complete: down() done');
}

module.exports = { up, down };

/*
 * ---------------------------------------------------------------------------
 * OPTIONAL — literal BEFORE-UPDATE triggers, if you require trigger *objects*
 * for updated_at instead of the ON UPDATE CURRENT_TIMESTAMP attribute above.
 * Not installed by default (redundant with the column attribute). Apply per
 * table if your policy mandates it:
 *
 *   CREATE TRIGGER `trg_general_stock_touch` BEFORE UPDATE ON `general_stock`
 *   FOR EACH ROW SET NEW.`last_updated` = CURRENT_TIMESTAMP;
 *
 *   CREATE TRIGGER `trg_material_requests_touch` BEFORE UPDATE ON `material_requests`
 *   FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP;
 *   -- …and likewise for stock_issues / vehicle_cost_summary / dashboard_snapshots.
 * ---------------------------------------------------------------------------
 */
