#!/usr/bin/env python3
"""
Import Fleet Oil & Lubricant Capacities from Excel workbook into SQLite database.
Source: Fleet_Oil_Lubricant_Capacities.xlsx
Target: data/workshopone.db
"""

import os
import sys
import sqlite3
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, 'data', 'workshopone.db')
EXCEL_PATH = os.path.join(ROOT, 'Fleet_Oil_Lubricant_Capacities.xlsx')

def clean_val(v):
    if v is None:
        return None
    s = str(v).strip()
    if not s or s == '—' or s == 'None' or s == '(Unknown)':
        return None
    return s

def clean_num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(',', '')
    if not s or s == '—' or s == 'None':
        return None
    try:
        return float(s)
    except ValueError:
        return None

def clean_int(v, default=0):
    n = clean_num(v)
    return int(n) if n is not None else default

def main():
    if not os.path.exists(EXCEL_PATH):
        print(f"Error: {EXCEL_PATH} not found.")
        sys.exit(1)

    print(f"Opening workbook: {EXCEL_PATH}")
    wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)

    print(f"Connecting to database: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Ensure tables exist
    cur.execute("""
    CREATE TABLE IF NOT EXISTS vehicle_lubricant_capacities (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id             INTEGER REFERENCES assets(id) ON DELETE SET NULL,
      sheet_id             INTEGER,
      ec_no                TEXT,
      registration         TEXT,
      category             TEXT,
      brand                TEXT,
      model                TEXT,
      year                 TEXT,
      engine_oil_l         REAL,
      engine_oil_grade     TEXT,
      gearbox_oil_l        REAL,
      gearbox_oil_grade    TEXT,
      diff_oil_l           REAL,
      diff_oil_grade       TEXT,
      front_axle_oil_l     REAL,
      hydraulic_oil_l      REAL,
      final_drive_oil_l    REAL,
      swing_oil_l          REAL,
      other_gearbox_oil_l  REAL,
      coolant_l            REAL,
      brake_fluid_l        REAL,
      engine_oil_basis     TEXT,
      engine_oil_records   INTEGER DEFAULT 0,
      notes                TEXT,
      updated_by           TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_vlc_asset ON vehicle_lubricant_capacities(asset_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_vlc_ec ON vehicle_lubricant_capacities(ec_no)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_vlc_reg ON vehicle_lubricant_capacities(registration)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_vlc_cat ON vehicle_lubricant_capacities(category)")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS lubricant_capacity_evidence (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      capacity_id          INTEGER REFERENCES vehicle_lubricant_capacities(id) ON DELETE SET NULL,
      asset_id             INTEGER REFERENCES assets(id) ON DELETE SET NULL,
      vehicle_raw          TEXT,
      ec_no                TEXT,
      registration         TEXT,
      category             TEXT,
      brand                TEXT,
      model                TEXT,
      year                 TEXT,
      component            TEXT,
      qty_l                REAL,
      grade                TEXT,
      source_sheet         TEXT,
      source_row           INTEGER,
      record_date          TEXT,
      note                 TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_lce_capacity ON lubricant_capacity_evidence(capacity_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_lce_ec ON lubricant_capacity_evidence(ec_no)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_lce_comp ON lubricant_capacity_evidence(component)")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS other_equipment_capacities (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_name       TEXT NOT NULL,
      component            TEXT,
      qty_l                REAL,
      records_count        INTEGER DEFAULT 0,
      all_quantities       TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_oec_name ON other_equipment_capacities(equipment_name)")

    # Build asset lookup caches
    cur.execute("SELECT id, code, registration FROM assets")
    asset_by_code = {}
    asset_by_reg = {}
    for aid, code, reg in cur.fetchall():
        if code:
            asset_by_code[code.strip().upper()] = aid
        if reg:
            asset_by_reg[reg.strip().upper()] = aid

    # 1. Import Vehicle Capacities
    print("\n--- Importing Vehicle Capacities ---")
    ws_vc = wb['Vehicle Capacities']
    cur.execute("DELETE FROM vehicle_lubricant_capacities")
    
    vc_rows = 0
    ec_to_capacity_id = {}
    reg_to_capacity_id = {}

    for r in range(5, ws_vc.max_row + 1):
        sheet_id = ws_vc.cell(r, 1).value
        ec_no = clean_val(ws_vc.cell(r, 2).value)
        reg = clean_val(ws_vc.cell(r, 3).value)
        cat = clean_val(ws_vc.cell(r, 4).value)
        brand = clean_val(ws_vc.cell(r, 5).value)
        model = clean_val(ws_vc.cell(r, 6).value)
        year = clean_val(ws_vc.cell(r, 7).value)
        
        # Stop if row is completely empty
        if not ec_no and not reg and not cat:
            continue

        eng_l = clean_num(ws_vc.cell(r, 8).value)
        eng_grade = clean_val(ws_vc.cell(r, 9).value)
        gear_l = clean_num(ws_vc.cell(r, 10).value)
        gear_grade = clean_val(ws_vc.cell(r, 11).value)
        diff_l = clean_num(ws_vc.cell(r, 12).value)
        diff_grade = clean_val(ws_vc.cell(r, 13).value)
        faxle_l = clean_num(ws_vc.cell(r, 14).value)
        hyd_l = clean_num(ws_vc.cell(r, 15).value)
        fdrive_l = clean_num(ws_vc.cell(r, 16).value)
        swing_l = clean_num(ws_vc.cell(r, 17).value)
        other_l = clean_num(ws_vc.cell(r, 18).value)
        cool_l = clean_num(ws_vc.cell(r, 19).value)
        brake_l = clean_num(ws_vc.cell(r, 20).value)
        basis = clean_val(ws_vc.cell(r, 21).value)
        records_n = clean_int(ws_vc.cell(r, 22).value, 0)

        # Resolve asset ID
        aid = None
        if ec_no and ec_no.strip().upper() in asset_by_code:
            aid = asset_by_code[ec_no.strip().upper()]
        elif reg and reg.strip().upper() in asset_by_reg:
            aid = asset_by_reg[reg.strip().upper()]

        cur.execute("""
            INSERT INTO vehicle_lubricant_capacities (
              asset_id, sheet_id, ec_no, registration, category, brand, model, year,
              engine_oil_l, engine_oil_grade, gearbox_oil_l, gearbox_oil_grade,
              diff_oil_l, diff_oil_grade, front_axle_oil_l, hydraulic_oil_l,
              final_drive_oil_l, swing_oil_l, other_gearbox_oil_l, coolant_l, brake_fluid_l,
              engine_oil_basis, engine_oil_records, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            aid, sheet_id, ec_no, reg, cat, brand, model, year,
            eng_l, eng_grade, gear_l, gear_grade,
            diff_l, diff_grade, faxle_l, hyd_l,
            fdrive_l, swing_l, other_l, cool_l, brake_l,
            basis, records_n, 'excel_import'
        ))
        cid = cur.lastrowid
        vc_rows += 1
        if ec_no:
            ec_to_capacity_id[ec_no.strip().upper()] = cid
        if reg:
            reg_to_capacity_id[reg.strip().upper()] = cid

    print(f"Imported {vc_rows} vehicle capacity records.")

    # 2. Import Service Record Evidence
    print("\n--- Importing Service Record Evidence ---")
    ws_ev = wb['Service Record Evidence']
    cur.execute("DELETE FROM lubricant_capacity_evidence")

    ev_rows = 0
    for r in range(4, ws_ev.max_row + 1):
        veh_raw = clean_val(ws_ev.cell(r, 1).value)
        ec_no = clean_val(ws_ev.cell(r, 2).value)
        reg = clean_val(ws_ev.cell(r, 3).value)
        cat = clean_val(ws_ev.cell(r, 4).value)
        brand = clean_val(ws_ev.cell(r, 5).value)
        model = clean_val(ws_ev.cell(r, 6).value)
        year = clean_val(ws_ev.cell(r, 7).value)
        comp = clean_val(ws_ev.cell(r, 8).value)
        qty = clean_num(ws_ev.cell(r, 9).value)
        grade = clean_val(ws_ev.cell(r, 10).value)
        sheet = clean_val(ws_ev.cell(r, 11).value)
        srow = clean_int(ws_ev.cell(r, 12).value, None)
        rdate = clean_val(ws_ev.cell(r, 13).value)
        note = clean_val(ws_ev.cell(r, 14).value)

        if not veh_raw and not ec_no and not reg and qty is None:
            continue

        cid = None
        if ec_no and ec_no.strip().upper() in ec_to_capacity_id:
            cid = ec_to_capacity_id[ec_no.strip().upper()]
        elif reg and reg.strip().upper() in reg_to_capacity_id:
            cid = reg_to_capacity_id[reg.strip().upper()]

        aid = None
        if ec_no and ec_no.strip().upper() in asset_by_code:
            aid = asset_by_code[ec_no.strip().upper()]
        elif reg and reg.strip().upper() in asset_by_reg:
            aid = asset_by_reg[reg.strip().upper()]

        cur.execute("""
            INSERT INTO lubricant_capacity_evidence (
              capacity_id, asset_id, vehicle_raw, ec_no, registration, category, brand, model, year,
              component, qty_l, grade, source_sheet, source_row, record_date, note
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            cid, aid, veh_raw, ec_no, reg, cat, brand, model, year,
            comp, qty, grade, sheet, srow, rdate, note
        ))
        ev_rows += 1

    print(f"Imported {ev_rows} service record evidence entries.")

    # 3. Import Other Equipment
    print("\n--- Importing Other Equipment ---")
    ws_oe = wb['Other Equipment']
    cur.execute("DELETE FROM other_equipment_capacities")

    oe_rows = 0
    for r in range(4, ws_oe.max_row + 1):
        eq_name = clean_val(ws_oe.cell(r, 1).value) or '(Unspecified Equipment)'
        comp = clean_val(ws_oe.cell(r, 2).value)
        qty = clean_num(ws_oe.cell(r, 3).value)
        n_rec = clean_int(ws_oe.cell(r, 4).value, 0)
        all_q = clean_val(ws_oe.cell(r, 5).value)

        if not comp and qty is None:
            continue

        cur.execute("""
            INSERT INTO other_equipment_capacities (
              equipment_name, component, qty_l, records_count, all_quantities
            ) VALUES (?, ?, ?, ?, ?)
        """, (
            eq_name, comp, qty, n_rec, all_q
        ))
        oe_rows += 1

    print(f"Imported {oe_rows} other equipment capacity records.")

    conn.commit()
    conn.close()
    print("\n[SUCCESS] DATA IMPORT COMPLETED SUCCESSFULLY!")

if __name__ == '__main__':
    main()
