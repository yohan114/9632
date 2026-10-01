#!/usr/bin/env python3
"""
Import authentic mechanics tool inventory from Excel file into WorkshopOne.
Source file: media_1790420330189.xlsx
Target DB: D:/Master system 1/data/workshopone.db
Target Seed: src/data/mechanics_tools_seed.json

Responsible Mechanics with Dedicated Toolboxes:
1. Nimesh (ID: 17) -> Sheet 'Nimesha'
2. Nawathilaka (ID: 13) -> Sheet 'Nawathilaka'
3. Anura (ID: 1) -> Sheet 'Anura'
4. Seethananda (ID: 11) -> Sheet 'Seethananda'
5. Theminda (ID: 19) -> Sheet 'Theminda'
"""

import os
import json
import sqlite3
import openpyxl

EXCEL_PATH = r'C:\Users\HP\.gemini\antigravity\brain\7997b03d-731d-4e07-8d31-bb57a52ca992\.user_uploaded\media_1790420330189.xlsx'
OUTPUT_JSON = r'C:\Users\HP\.gemini\antigravity\worktrees\Master system 1\view_branches\src\data\mechanics_tools_seed.json'
DB_PATH = r'D:\Master system 1\data\workshopone.db'

wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)

# 1. Nimesh
def get_nimesh_tools():
    ws = wb['Nimesha']
    items = []
    # Combination Spanner (cols 0, 1, 2) rows 4-12
    for r in range(4, 13):
        sz = ws.cell(r, 2).value
        qty = int(ws.cell(r, 3).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, (int, float)) else str(sz)
            items.append({
                'base_name': f"Combination Spanner ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 3500
            })
    # Double Wrench (cols 5, 6, 7) rows 5-8
    for r in range(5, 9):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Double Wrench ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 4200
            })
    # Box Socket (cols 5, 6, 7) rows 12-27
    for r in range(12, 28):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, (int, float)) else str(sz)
            items.append({
                'base_name': f"Box Socket ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 2200
            })
    # Open Combination Spanner (cols 0, 1, 2) rows 17-24
    for r in range(17, 25):
        sz = ws.cell(r, 2).value
        qty = int(ws.cell(r, 3).value or 1)
        if sz is not None:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Open Combination Spanner ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 3800
            })
    # Screw driver (cols 0, 1, 2) rows 29-30
    for r in range(29, 31):
        sz = ws.cell(r, 2).value
        qty = int(ws.cell(r, 3).value or 1)
        if sz is not None:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Screw Driver ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 1800
            })
    # Allen Key (cols 5, 6, 7) rows 31-35
    for r in range(31, 36):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, (int, float)) else str(sz)
            items.append({
                'base_name': f"Allen Key ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 1200
            })
    # Standalone items
    items.append({'base_name': 'Nose Plier', 'specifications': 'Standard', 'category': 'hand_tools', 'qty': int(ws.cell(32, 3).value or 2), 'cost': 2500})
    items.append({'base_name': 'Locking Plier (Vice Grip)', 'specifications': 'Heavy Duty 10"', 'category': 'hand_tools', 'qty': int(ws.cell(33, 3).value or 1), 'cost': 3800})
    items.append({'base_name': 'Filter Wrench', 'specifications': 'Adjustable Belt/Chain', 'category': 'special_tools', 'qty': int(ws.cell(34, 3).value or 3), 'cost': 4500})
    items.append({'base_name': 'Allen Key Set (9 Pieces)', 'specifications': '1.5-10mm Ball End (9 Pcs)', 'category': 'hand_tools', 'qty': int(ws.cell(35, 3).value or 1), 'cost': 6500})

    return {
        'mechanic_id': 17,
        'mechanic_name': 'Nimesh',
        'toolbox_name': "Nimesh's Tool Box",
        'location': 'Mechanic Locker #17',
        'prefix': 'TL-NIM',
        'items': items
    }

# 2. Nawathilaka
def get_nawathilaka_tools():
    ws = wb['Nawathilaka']
    items = []
    # Standalone tools rows 3-17
    standalone_costs = {
        'drill machine': 28000,
        'angle grinder': 24000,
        'paint spray gun': 18500,
        'measuring tape': 2500,
        'screw drivers': 1800,
        'tinkering hammer': 4500,
        'ball pin hammer': 3500,
        'locking pliers': 3800,
        'pliers': 2500,
        'drill bit set': 12000,
        'spanner': 3500,
        'rachet': 7500,
        'spid handle': 4500,
        't handle': 3800,
        'i handle': 3800
    }
    for r in range(3, 18):
        name = ws.cell(r, 2).value
        qty = int(ws.cell(r, 3).value or 1)
        if name:
            clean_name = str(name).strip()
            cat = 'power_tools' if any(w in clean_name.lower() for w in ['drill', 'grinder', 'spray']) else 'hand_tools'
            cost = standalone_costs.get(clean_name.lower(), 4000)
            items.append({
                'base_name': clean_name,
                'specifications': 'Workshop Standard',
                'category': cat,
                'qty': qty,
                'cost': cost
            })
    # Combination Wrench rows 20-33
    for r in range(20, 34):
        sz = ws.cell(r, 2).value
        qty = int(ws.cell(r, 3).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, (int, float)) else str(sz)
            items.append({
                'base_name': f"Combination Wrench ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 3200
            })
    # Box Socket rows 20-38
    for r in range(20, 39):
        sz = ws.cell(r, 6).value
        qty = int(ws.cell(r, 7).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, (int, float)) else str(sz)
            items.append({
                'base_name': f"Box Socket ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 2200
            })
    return {
        'mechanic_id': 13,
        'mechanic_name': 'Nawathilaka',
        'toolbox_name': 'Tinkering Work Shop - Nawathilaka',
        'location': 'Tinkering Work Shop Bay',
        'prefix': 'TL-NAW',
        'items': items
    }

# 3. Anura
def get_anura_tools():
    ws = wb['Anura']
    items = []
    # Box Socket (standard) rows 5-25
    for r in range(5, 26):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 4).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, (int, float)) else str(sz)
            items.append({
                'base_name': f"Box Socket 1/2\" Drive ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 2400
            })
    # Box Socket (Heavy) rows 5-16
    for r in range(5, 17):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, (int, float)) else str(sz)
            items.append({
                'base_name': f"Heavy Impact Box Socket 3/4\"-1\" Drive ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 8500
            })
    # D End Wrench rows 20-28
    for r in range(20, 29):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Double End Wrench ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 6200
            })
    # Ring Spanner rows 29-35
    for r in range(29, 36):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 4).value or 1)
        if sz is not None:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Offset Ring Spanner ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 4500
            })
    # Combination Spanner rows 32-62
    for r in range(32, 63):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, int) else str(sz).strip()
            items.append({
                'base_name': f"Combination Spanner ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 4200
            })
    # Standalone tools rows 37-52
    standalone_tools = [
        ('D Spanner 36"', '36 Inch Heavy', 'hand_tools', int(ws.cell(37, 4).value or 2), 18500),
        ('Adjustable Shifter Wrench', '12 Inch', 'hand_tools', int(ws.cell(38, 4).value or 1), 6500),
        ('Circlip Plier (Internal/External)', 'Set of 2', 'hand_tools', int(ws.cell(39, 4).value or 2), 4800),
        ('Speed Handle 1/2" Drive', '1/2" Drive Speed Brace', 'hand_tools', int(ws.cell(40, 4).value or 1), 4500),
        ('Extension Bar 6"', '1/2" Drive 6 Inch', 'hand_tools', int(ws.cell(41, 4).value or 1), 2800),
        ('Extension Bar 2 1/2"', '1/2" Drive 2.5 Inch', 'hand_tools', int(ws.cell(42, 4).value or 1), 2200),
        ('Extension Bar 10"', '1/2" Drive 10 Inch', 'hand_tools', int(ws.cell(43, 4).value or 1), 3500),
        ('L-Handle (Breaker Bar)', '1/2" Drive 18 Inch', 'hand_tools', int(ws.cell(44, 4).value or 1), 5500),
        ('Ratchet Handle 1/2" Drive', 'Quick Release 72-Teeth', 'hand_tools', int(ws.cell(45, 4).value or 1), 8500),
        ('Deep Impact Socket', 'Deep Well Metric', 'hand_tools', int(ws.cell(46, 4).value or 4), 3800),
        ('Universal Swivel Joint 1/2"', 'Impact Wobble Joint', 'hand_tools', int(ws.cell(47, 4).value or 1), 3200),
        ('Feeler Gauge (Piller Gauge)', 'Metric Precision 32-Blades', 'precision_measuring', int(ws.cell(48, 4).value or 1), 3800),
        ('Ball Peen / Sledge Hammer', '2.5 lb Steel Head', 'hand_tools', int(ws.cell(49, 4).value or 1), 4500),
        ('Extension Bar Heavy 3/4"', '3/4" Drive Heavy Duty', 'hand_tools', int(ws.cell(50, 4).value or 3), 9500),
        ('L-Handle Heavy 3/4"', '3/4" Drive Breaker Bar 24"', 'hand_tools', int(ws.cell(51, 4).value or 1), 12500),
        ('T-Handle Sliding Bar 1/2"', '1/2" Drive Sliding T-Head', 'hand_tools', int(ws.cell(52, 4).value or 1), 4500),
    ]
    for name, spec, cat, qty, cost in standalone_tools:
        items.append({
            'base_name': name,
            'specifications': spec,
            'category': cat,
            'qty': qty,
            'cost': cost
        })

    return {
        'mechanic_id': 1,
        'mechanic_name': 'Anura',
        'toolbox_name': 'Engine Room - Anura',
        'location': 'Engine Room Tool Crib',
        'prefix': 'TL-ANU',
        'items': items
    }

# 4. Seethananda
def get_seethananda_tools():
    ws = wb['Seethananda']
    items = []
    # Left side equipment (01-14)
    machinery = [
        ('Industrial Heavy Lathe Machine', 'Lathe Centre 6ft Gap Bed', 'machinery', int(ws.cell(3, 5).value or 1), 850000),
        ('Bench Drilling Machine', 'Heavy Duty Pillar Drill Press', 'machinery', int(ws.cell(4, 5).value or 2), 95000),
        ('Bench Grinding Machine', 'Double Ended 8" Grinder', 'machinery', int(ws.cell(5, 5).value or 2), 48000),
        ('Reinforced Bar Cutter Machine', 'Hydraulic / Electric Bar Cutter', 'machinery', int(ws.cell(6, 5).value or 1), 165000),
        ('AC Arc Welding Plant', 'Oil Cooled / Inverter 300A', 'machinery', int(ws.cell(7, 5).value or 1), 120000),
        ('Heavy Duty Bench Vice', 'Forged Steel 8 Inch Swivel Vice', 'hand_tools', int(ws.cell(8, 5).value or 2), 35000),
        ('Hand Angle Grinding Machine', '4-Inch High Speed Electric Grinder', 'power_tools', int(ws.cell(9, 5).value or 3), 26000),
        ('Hand Drill Machine', 'Heavy Impact 13mm Chuck', 'power_tools', int(ws.cell(10, 5).value or 1), 22000),
        ('Workshop Steel Locker', 'Double Door 4-Shelf Storage Locker', 'furniture', int(ws.cell(11, 5).value or 3), 45000),
        ('Supervisor Writing Table', 'Wooden Desk with Drawers', 'furniture', int(ws.cell(12, 5).value or 1), 28000),
        ('Workshop Wooden Chairs', 'Solid Hardwood Armless Chairs', 'furniture', int(ws.cell(13, 5).value or 2), 12000),
        ('Workshop Armchair', 'Padded Steel Armchair', 'furniture', int(ws.cell(14, 5).value or 1), 16000),
        ('Heavy Duty Working Steel Table', 'Welded Steel Fabrication Bench', 'furniture', int(ws.cell(15, 5).value or 2), 55000),
        ('Die Grinder Pneumatic / Electric', 'Collet 6mm High Speed', 'power_tools', int(ws.cell(16, 5).value or 1), 24000),
    ]
    for name, spec, cat, qty, cost in machinery:
        items.append({
            'base_name': name,
            'specifications': spec,
            'category': cat,
            'qty': qty,
            'cost': cost
        })

    # Drill bits (Item 15) rows 19-29
    for r in range(19, 30):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 5).value or 1)
        if sz:
            spec = str(sz).strip()
            items.append({
                'base_name': f"HSS Morse Taper Drill Bit ({spec})",
                'specifications': spec,
                'category': 'power_tools',
                'qty': qty,
                'cost': 4500
            })
    # Drill bit set (Item 16)
    items.append({
        'base_name': 'HSS Jobber Drill Bit Set (02mm to 13mm, 22 Pcs)',
        'specifications': '22-Piece Metric Set 0.5mm steps',
        'category': 'power_tools',
        'qty': int(ws.cell(31, 5).value or 1),
        'cost': 18500
    })
    # Tap Tool Bits Metric (Item 17) rows 35-44
    for r in range(35, 45):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 5).value or 1)
        if sz:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Metric Thread Tap Bit ({spec})",
                'specifications': spec,
                'category': 'special_tools',
                'qty': qty,
                'cost': 2800
            })
    # Tap Tool Bits Inch (Item 18) rows 47-53
    inch_labels = {
        0.75: '3/4"', 0.625: '5/8"', '7/16': '7/16"', 0.5: '1/2"', 0.375: '3/8"', '5/16': '5/16"', 0.25: '1/4"'
    }
    for r in range(47, 54):
        raw_sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 5).value or 1)
        if raw_sz is not None:
            spec = inch_labels.get(raw_sz, str(raw_sz))
            items.append({
                'base_name': f"Imperial BSW/UNC Tap Bit ({spec})",
                'specifications': spec,
                'category': 'special_tools',
                'qty': qty,
                'cost': 2800
            })
    # Micrometers (Item 19) rows 57-60
    for r in range(57, 61):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 5).value or 1)
        if sz:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Precision Outside Micrometer ({spec})",
                'specifications': spec,
                'category': 'precision_measuring',
                'qty': qty,
                'cost': 18500
            })
    # Vernier Calipers (Item 20) rows 63-64
    for r in range(63, 65):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 5).value or 1)
        if sz:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Precision Vernier Caliper ({spec})",
                'specifications': spec,
                'category': 'precision_measuring',
                'qty': qty,
                'cost': 14500
            })

    # Right side:
    items.append({'base_name': 'Jenny Caliper (Outside Hermaphrodite)', 'specifications': 'Machinist Outside Caliper', 'category': 'precision_measuring', 'qty': int(ws.cell(4, 10).value or 3), 'cost': 4800})
    items.append({'base_name': 'Jenny Caliper (Inside Hermaphrodite)', 'specifications': 'Machinist Inside Caliper', 'category': 'precision_measuring', 'qty': int(ws.cell(5, 10).value or 3), 'cost': 4800})
    items.append({'base_name': 'Precision Steel Ruler 12 Inch', 'specifications': '12" / 300mm Stainless Graduated', 'category': 'precision_measuring', 'qty': int(ws.cell(7, 10).value or 2), 'cost': 2800})
    # Spaners (Item 23) rows 10-24
    for r in range(10, 25):
        sz = ws.cell(r, 8).value
        qty = int(ws.cell(r, 10).value or 1)
        if sz:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Machinist Spanner / Wrench ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 4200
            })
    items.append({'base_name': 'Locking Plier (Vice Grip)', 'specifications': '10 Inch Curved Jaw', 'category': 'hand_tools', 'qty': int(ws.cell(26, 10).value or 1), 'cost': 3800})
    items.append({'base_name': 'Heavy Duty Combination Plier 8"', 'specifications': '8" Chrome Vanadium', 'category': 'hand_tools', 'qty': int(ws.cell(27, 10).value or 1), 'cost': 2800})
    # BOX Sockets (Item 26) rows 30-34
    for r in range(30, 35):
        sz = ws.cell(r, 8).value
        qty = int(ws.cell(r, 10).value or 1)
        if sz:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Box Socket 1/2\" Drive ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 2200
            })
    items.append({'base_name': 'T-Handle Sliding Wrench 1/2"', 'specifications': '1/2" Drive Sliding Head', 'category': 'hand_tools', 'qty': int(ws.cell(36, 10).value or 1), 'cost': 4500})
    items.append({'base_name': 'Tap & Die Wrench Handle', 'specifications': 'Heavy Adjustable Bar', 'category': 'special_tools', 'qty': int(ws.cell(37, 10).value or 6), 'cost': 5500})
    items.append({'base_name': 'Industrial Pedestal Stand Fan', 'specifications': '24" High Velocity Oscillation', 'category': 'machinery', 'qty': int(ws.cell(38, 10).value or 1), 'cost': 32000})
    items.append({'base_name': 'Half-Round Bastard File', 'specifications': 'Half Pound Machinist File', 'category': 'hand_tools', 'qty': int(ws.cell(39, 10).value or 4), 'cost': 2500})
    items.append({'base_name': 'Flat Bastard File 12"', 'specifications': '12" Double Cut Workshop File', 'category': 'hand_tools', 'qty': int(ws.cell(40, 10).value or 6), 'cost': 2400})
    items.append({'base_name': 'Round Bastard File', 'specifications': 'Round Chainsaw/Machinist File', 'category': 'hand_tools', 'qty': int(ws.cell(41, 10).value or 4), 'cost': 2200})
    # Reamers (Item 33) rows 44-48
    for r in range(44, 49):
        sz = ws.cell(r, 8).value
        qty = int(ws.cell(r, 10).value or 1)
        if sz:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Adjustable Hand Reamer ({spec})",
                'specifications': spec,
                'category': 'special_tools',
                'qty': qty,
                'cost': 8500
            })
    items.append({'base_name': 'Pop Rivet Gun (Blind Riveter)', 'specifications': 'Heavy Lever Type Riveter', 'category': 'hand_tools', 'qty': int(ws.cell(50, 10).value or 1), 'cost': 6500})
    items.append({'base_name': 'Hacksaw Frame Heavy Duty', 'specifications': '12" High Tension Tubular Frame', 'category': 'hand_tools', 'qty': int(ws.cell(51, 10).value or 1), 'cost': 3200})
    items.append({'base_name': 'Machinist Ball Peen Hammer', 'specifications': '2 lb Steel Head Wood Handle', 'category': 'hand_tools', 'qty': int(ws.cell(52, 10).value or 2), 'cost': 3500})
    # Allen Keys (Item 37) rows 55-63
    for r in range(55, 64):
        sz = ws.cell(r, 8).value
        qty = int(ws.cell(r, 10).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, (int, float)) else str(sz)
            items.append({
                'base_name': f"Hex Allen Key ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 1200
            })
    items.append({'base_name': 'Engineer Try Square 8"', 'specifications': '8" Precision Ground 90 Degree', 'category': 'precision_measuring', 'qty': int(ws.cell(65, 10).value or 2), 'cost': 4500})
    items.append({'base_name': 'Screw Thread Pitch Gauge', 'specifications': 'Metric & Imperial Pitch Leaf Set', 'category': 'precision_measuring', 'qty': int(ws.cell(66, 10).value or 2), 'cost': 3800})

    return {
        'mechanic_id': 11,
        'mechanic_name': 'Seethananda/seetha',
        'toolbox_name': 'Lathe Shop - Seethananda',
        'location': 'Lathe Shop Tool Cabinet',
        'prefix': 'TL-SEE',
        'items': items
    }

# 5. Theminda
def get_theminda_tools():
    ws = wb['Theminda']
    items = []
    # Ring Spanner rows 5-7
    for r in range(5, 8):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 4).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, int) else str(sz)
            items.append({
                'base_name': f"Offset Ring Spanner ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 3500
            })
    # Combination Spanner rows 11-33
    for r in range(11, 34):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 4).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, int) else str(sz)
            items.append({
                'base_name': f"Combination Spanner ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 3200
            })
    # Deep Socket rows 37-41
    for r in range(37, 42):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 4).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, int) else str(sz)
            items.append({
                'base_name': f"Deep Drive Socket ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 2800
            })
    # Box Socket rows 45-60
    for r in range(45, 61):
        sz = ws.cell(r, 3).value
        qty = int(ws.cell(r, 4).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, int) else str(sz)
            items.append({
                'base_name': f"Box Socket 1/2\" Drive ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 2200
            })
    # Allen Key rows 5-13 (right col)
    for r in range(5, 14):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = f"{sz}mm" if isinstance(sz, int) else str(sz)
            items.append({
                'base_name': f"Hex Allen Key ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 1200
            })
    # Star Allen Key rows 17-25
    for r in range(17, 26):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Torx Star Key ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 1500
            })
    # Hollow Punch rows 29-37
    for r in range(29, 38):
        sz = ws.cell(r, 7).value
        qty = int(ws.cell(r, 8).value or 1)
        if sz is not None:
            spec = str(sz).strip()
            items.append({
                'base_name': f"Hollow Leather & Gasket Punch ({spec})",
                'specifications': spec,
                'category': 'hand_tools',
                'qty': qty,
                'cost': 2400
            })
    # Standalone tools rows 39-55
    theminda_standalone = [
        ('Ratchet Handle 1/2" Drive', 'Quick Release 72-Teeth', 'hand_tools', int(ws.cell(39, 8).value or 1), 7500),
        ('Extension Bar 1/2" Drive', '10" Heavy Duty Bar', 'hand_tools', int(ws.cell(40, 8).value or 2), 3200),
        ('T-Handle Sliding Wrench 1/2"', '1/2" Drive Sliding Head', 'hand_tools', int(ws.cell(41, 8).value or 1), 4500),
        ('Speed Handle (Speed Brace)', '1/2" Drive Rapid Spinner', 'hand_tools', int(ws.cell(42, 8).value or 1), 4200),
        ('Double End Heavy Wrench (36-41)', '36mm x 41mm Drop Forged', 'hand_tools', int(ws.cell(43, 8).value or 1), 14500),
        ('D-Spanner 27mm', '27mm Single Head Open End', 'hand_tools', int(ws.cell(44, 8).value or 1), 5500),
        ('Automotive 12V/24V Test Lamp', 'Electrical Circuit Probe Tester', 'special_tools', int(ws.cell(45, 8).value or 1), 3500),
        ('Screwdriver Set', 'Slotted & Phillips (4 Pcs)', 'hand_tools', int(ws.cell(46, 8).value or 4), 2200),
        ('Heavy Duty Diagonal Cutting Plier', '7 Inch Hardened Cutting Edge', 'hand_tools', int(ws.cell(47, 8).value or 1), 2800),
        ('Water Pump Plier (Groove Joint)', '10 Inch Adjustable Slip Joint', 'hand_tools', int(ws.cell(48, 8).value or 1), 4500),
        ('Locking Plier (Vice Grip)', '10 Inch Curved Jaw', 'hand_tools', int(ws.cell(49, 8).value or 1), 3800),
        ('Heavy Duty Pipe Wrench 14"', '14 Inch Ductile Iron Pipe Wrench', 'hand_tools', int(ws.cell(50, 8).value or 1), 6800),
        ('Telescopic Magnetic Pickup Tool', 'Flexible Magnetic Pick-up Wand', 'special_tools', int(ws.cell(51, 8).value or 1), 2500),
        ('Circlip Plier (Internal/External)', 'Snap Ring Retaining Plier', 'hand_tools', int(ws.cell(52, 8).value or 1), 3800),
        ('Long Nose Needle Plier 8"', '8 Inch Precision Long Reach', 'hand_tools', int(ws.cell(53, 8).value or 1), 2600),
        ('Heavy Sledgehammer 4 lb', '4 lb Forged Steel Head Club Hammer', 'hand_tools', int(ws.cell(54, 8).value or 1), 5800),
        ('Oil Filter Wrench (Strap/Chain)', 'Heavy Duty Oil Filter Removal Tool', 'special_tools', int(ws.cell(55, 8).value or 1), 4200),
    ]
    for name, spec, cat, qty, cost in theminda_standalone:
        items.append({
            'base_name': name,
            'specifications': spec,
            'category': cat,
            'qty': qty,
            'cost': cost
        })

    return {
        'mechanic_id': 19,
        'mechanic_name': 'Theminda',
        'toolbox_name': "Theminda's Tool Box",
        'location': 'Mechanic Locker #19',
        'prefix': 'TL-THE',
        'items': items
    }

def main():
    print("--- Parsing 5 responsible mechanics tool sheets ---")
    mechanics_data = [
        get_nimesh_tools(),
        get_nawathilaka_tools(),
        get_anura_tools(),
        get_seethananda_tools(),
        get_theminda_tools()
    ]

    all_seed_tools = []
    total_distinct_items = 0
    total_physical_units = 0

    for m in mechanics_data:
        m_items = m['items']
        total_distinct_items += len(m_items)
        seq = 1
        for it in m_items:
            qty = it['qty']
            total_physical_units += qty
            base_name = it['base_name']
            spec = it['specifications']
            cat = it['category']
            cost = it['cost']

            for u in range(1, qty + 1):
                code = f"{m['prefix']}-{String(seq).padStart(3, '0')}" if False else f"{m['prefix']}-{seq:03d}"
                unit_suffix = f" #{u}" if qty > 1 else ""
                full_name = f"{base_name}{unit_suffix}"

                all_seed_tools.append({
                    'tool_code': code,
                    'name': full_name,
                    'category': cat,
                    'type': 'mechanic',
                    'mechanic_id': m['mechanic_id'],
                    'mechanic_name': m['mechanic_name'],
                    'toolbox_name': m['toolbox_name'],
                    'location': m['location'],
                    'brand': 'Koken / Stanley / Workshop Standard',
                    'model_no': '',
                    'serial_no': '',
                    'specifications': spec,
                    'purchase_cost': cost,
                    'replacement_cost': int(cost * 1.15),
                    'condition': 'good',
                    'status': 'in_use',
                    'active': 1,
                    'notes': f"Issued in {m['toolbox_name']} ({spec})" if spec else f"Issued in {m['toolbox_name']}"
                })
                seq += 1

        print(f"-> {m['mechanic_name']} ({m['toolbox_name']}): {len(m_items)} distinct items, {seq - 1} physical tools")

    print(f"Total distinct tool lines: {total_distinct_items}")
    print(f"Total physical tool units generated: {len(all_seed_tools)}")

    # Save to JSON
    os.makedirs(os.path.dirname(OUTPUT_JSON), exist_ok=True)
    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(all_seed_tools, f, indent=2)
    print(f"Saved seed data to: {OUTPUT_JSON}")

    # Now apply to SQLite DB if it exists
    if os.path.exists(DB_PATH):
        print(f"Connecting to database: {DB_PATH}")
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()

        # Check existing dummy mechanic tools
        cur.execute("SELECT id, tool_code, name, mechanic_id, mechanic_name FROM workshop_tools WHERE type = 'mechanic'")
        dummy_rows = cur.fetchall()
        print(f"Found {len(dummy_rows)} existing mechanic tool rows in database.")

        # Delete existing dummy mechanic tools (IDs 11 to 25 or all mechanic tools without scrap/issue logs)
        cur.execute("DELETE FROM workshop_tools WHERE type = 'mechanic'")
        print(f"Cleared previous dummy mechanic tools.")

        # Insert authentic mechanic tools
        ins_sql = """
            INSERT INTO workshop_tools (
                tool_code, name, category, type, mechanic_id, mechanic_name,
                toolbox_name, location, brand, model_no, serial_no, specifications,
                purchase_cost, replacement_cost, condition, status, active, notes
            ) VALUES (
                :tool_code, :name, :category, :type, :mechanic_id, :mechanic_name,
                :toolbox_name, :location, :brand, :model_no, :serial_no, :specifications,
                :purchase_cost, :replacement_cost, :condition, :status, :active, :notes
            )
        """
        for t in all_seed_tools:
            cur.execute(ins_sql, t)

        conn.commit()
        print(f"Successfully inserted {len(all_seed_tools)} authentic mechanic tools into workshop_tools!")

        # Verify summary
        cur.execute("""
            SELECT m.id, m.name, COUNT(t.id) as tools_count, COALESCE(MAX(t.toolbox_name), 'No Toolbox') as box
            FROM mechanics m
            LEFT JOIN workshop_tools t ON t.mechanic_id = m.id AND t.active = 1
            GROUP BY m.id
            HAVING tools_count > 0
            ORDER BY tools_count DESC
        """)
        print("--- Verified Mechanics with Toolboxes in DB ---")
        for row in cur.fetchall():
            print(f"  ID {row[0]:2d}: {row[1]:20s} -> {row[2]:3d} tools ({row[3]})")

        conn.close()

if __name__ == '__main__':
    main()
