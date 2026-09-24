'use strict';

// Multi-site Stage 2 on an EXISTING database: the first start creates Central Workshop — Badalgama
// as the default, gives it every user, job card, request and mechanic that exists, links the old
// transfer notes to the places their text clearly names — and changes nothing else.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s2m-'));
process.env.DB_PATH = path.join(TMP, 'old.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');

// A database as it was before Stage 2: the same tables, no workshop columns, no workshops.
{
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const raw = new Database(process.env.DB_PATH);
  raw.exec(schema);
  raw.pragma('foreign_keys = OFF');   // item_categories is made by the migration, not schema.sql
  raw.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'kasun', 'x'), (2, 'anura', 'x');
    INSERT INTO assets (id, code, code_norm) VALUES (1, 'AC-06', 'AC06');
    INSERT INTO projects (id, name, name_norm, code) VALUES (1, 'CEP-03 Project', 'CEP03PROJECT', 'CEP-03'),
      (2, 'Marawila Road Project', 'MARAWILAROADPROJECT', NULL), (3, 'Muthur Plant', 'MUTHURPLANT', NULL);
    INSERT INTO job_cards (id, job_no, asset_id, description, status) VALUES (5, '2026/8/R/5', 1, 'x', 'CLOSED'), (6, '2026/9/R/6', 1, 'y', 'IN_PROGRESS');
    INSERT INTO mrn (id, mrn_no, job_id) VALUES (1, '167001', 6), (2, '167002', NULL);
    INSERT INTO mechanics (id, name, name_norm) VALUES (1, 'Anura', 'ANURA'), (2, 'Buddhika', 'BUDDHIKA');
    INSERT INTO mtn (id, mtn_no, from_location, to_location) VALUES
      (1, '58601', 'Work Shop Stores', 'CEP-03 Wadakada Machanic'),
      (2, '58602', 'HEX-19', 'Marawila Site'),
      (3, '58603', 'Main Store', 'Batticoloa'),
      (4, '58604', 'Work Shop', '');
    INSERT INTO mtn_lines (mtn_id, line_no, description, qty, from_location, to_location) VALUES
      (1, 1, 'Filter', 1, NULL, NULL), (2, 1, 'Belt', 1, 'Muthur Plant', 'Head Office');`);
  raw.close();
}

const { migrate, get, all, run } = require('../src/db');

test('the first start: one default workshop, and everything that exists belongs to it', () => {
  migrate();
  const ws = all('SELECT * FROM workshops');
  assert.strictEqual(ws.length, 1);
  assert.strictEqual(ws[0].name, 'Central Workshop — Badalgama');
  assert.strictEqual(ws[0].is_default, 1);
  const cw = ws[0].id;
  assert.deepStrictEqual(all('SELECT DISTINCT workshop_id w FROM users').map((r) => r.w), [cw]);
  assert.deepStrictEqual(all('SELECT DISTINCT workshop_id w FROM job_cards').map((r) => r.w), [cw]);
  assert.deepStrictEqual(all('SELECT DISTINCT workshop_id w FROM mrn').map((r) => r.w), [cw]);
  assert.deepStrictEqual(all('SELECT mechanic_id, workshop_id, from_date FROM mechanic_workshops ORDER BY mechanic_id'),
    [{ mechanic_id: 1, workshop_id: cw, from_date: '2000-01-01' }, { mechanic_id: 2, workshop_id: cw, from_date: '2000-01-01' }]);
  // Nothing else moved: the cards keep their status and numbers.
  assert.deepStrictEqual(all('SELECT id, job_no, status FROM job_cards ORDER BY id').map((r) => [r.id, r.job_no, r.status]),
    [[5, '2026/8/R/5', 'CLOSED'], [6, '2026/9/R/6', 'IN_PROGRESS']]);
  assert.deepStrictEqual(all('PRAGMA foreign_key_check'), []);
});

test('old transfer notes: linked where the text clearly names one place, the text never changed', () => {
  const cw = get('SELECT id FROM workshops').id;
  const notes = all('SELECT id, from_location, to_location, from_place, to_place FROM mtn ORDER BY id');
  assert.deepStrictEqual(notes.map((n) => [n.from_place, n.to_place]), [
    [`w:${cw}`, 'p:1'],        // the workshop's store → CEP-03's own mechanic
    [null, 'p:2'],             // a machine stays text; "Marawila Site" is Marawila Road Project
    [`w:${cw}`, null],         // a misspelt place stays text
    [`w:${cw}`, null],         // an empty end stays empty
  ]);
  assert.deepStrictEqual(notes.map((n) => [n.from_location, n.to_location]), [
    ['Work Shop Stores', 'CEP-03 Wadakada Machanic'], ['HEX-19', 'Marawila Site'], ['Main Store', 'Batticoloa'], ['Work Shop', '']]);
  // (Notes that had no item rows got one from an earlier migration; those carry no ends of their own.)
  const lines = all("SELECT from_place, to_place FROM mtn_lines WHERE description IN ('Filter', 'Belt') ORDER BY id");
  assert.deepStrictEqual(lines.map((l) => [l.from_place, l.to_place]), [[null, null], ['p:3', null]]);
  const done = JSON.parse(get("SELECT value FROM settings WHERE key = 'mtn_places_matched'").value);
  assert.strictEqual(done.linked, 6);
  assert.strictEqual(done.left, 3);
});

test('it runs once, and new rows take a workshop on their own', () => {
  migrate();
  assert.strictEqual(get('SELECT COUNT(*) n FROM workshops').n, 1, 'no second default workshop');
  // A note written after the update is not re-matched behind anyone's back.
  run("UPDATE mtn SET to_place = NULL WHERE id = 1");
  migrate();
  assert.strictEqual(get('SELECT to_place FROM mtn WHERE id = 1').to_place, null);
  // Rows inserted by any path — an import, the container cards — are never left without one.
  const cw = get('SELECT id FROM workshops').id;
  const u = run("INSERT INTO users (username, password_hash) VALUES ('new', 'x')").lastInsertRowid;
  const j = run("INSERT INTO job_cards (job_no, description) VALUES ('NEW', 'x')").lastInsertRowid;
  const m = run("INSERT INTO mechanics (name, name_norm) VALUES ('Chaminda', 'CHAMINDA')").lastInsertRowid;
  assert.strictEqual(get('SELECT workshop_id w FROM users WHERE id = ?', u).w, cw);
  assert.strictEqual(get('SELECT workshop_id w FROM job_cards WHERE id = ?', j).w, cw);
  assert.strictEqual(get('SELECT workshop_id w FROM mechanic_workshops WHERE mechanic_id = ?', m).w, cw);
});
