# WorkshopOne — Master Inventory System URL Map

_Canonical single paths, supported tabs, and backwards-compatible redirect shims._

## 1. Master Inventory Canonical Routes (One Section = One Path)

Every section in the master inventory system now has exactly **one canonical path** in the primary navigation:

| Section | Canonical URL | Tabs / Views | Description |
|---|---|---|---|
| **Stock Cockpit** | `#/stockcockpit` | Executive Board | Master valuation across all stores, active SKUs, automated reorder alerts, universal search across all categories, 1-click restock MRN generator. |
| **Stores** | `#/stores` | `tab=pipeline`<br/>`tab=workspace`<br/>`tab=paperwork` (`sub=mrn`, `sub=grn`)<br/>`tab=movements` (`sub=issues`, `sub=mtn`)<br/>`tab=search` | Physical warehouse logistics & operations pipeline: intake pipeline, fast receive & price workspace, material requests (MRN), receipts (GRN), issues, and transfers (MTN). |
| **General Stock** | `#/generalstock` | `tab=stock` (Live Balances)<br/>`tab=catalogue` (Part Numbers & Facets)<br/>`tab=categories` (2-Level Hierarchy)<br/>`tab=reorder` (Re-Order Shortfalls) | Single canonical home for general consumables & spare parts catalog, shelf balances, live pricing, stock adjustments, and movements ledger. |
| **Filters & Prices** | `#/filters` | `tab=stock` (Stock Position)<br/>`tab=book` (Price Book)<br/>`tab=services` (Service Records)<br/>`tab=xref` (Cross-References) | Complete unified filtration center: stock positions, receive/issue stock, price book, historical services, and Sakura/VIC/HIFI cross-references. |
| **Oil & Lubricants** | `#/oil` | `tab=products`<br/>`tab=stock`<br/>`tab=ledger`<br/>`tab=forecast`<br/>`tab=names`<br/>`tab=counts` | Fluid & lubricant products, pricing, stock panel, transaction ledger, 60-day consumption forecast, and name alias queue. |
| **Batteries** | `#/batteries` | Lifecycle Registry | Serial-tracked rotables, vehicle battery assignments, 60-day warranty radar, photo inspections, and serial search. |

---

## 2. Eliminated Redundant Navigation & Backward-Compatible Redirect Shims

To avoid confusion where the same section could be viewed from 2 or 3 paths, redundant shortcuts and cross-module buttons have been removed from the primary UI while preserving seamless client-side redirects for bookmarks and existing links:

| Redundant / Secondary Path | Canonical Destination | Resolution in System |
|---|---|---|
| **Sidebar "Material Requests"** | `#/stores?tab=paperwork&sub=mrn` | Removed from sidebar; accessed directly in Stores -> Requests (MRN). `#/matreq` redirects here. |
| **Sidebar "Stock Issues"** | `#/stores?tab=movements&sub=issues` | Removed from sidebar; accessed directly in Stores -> Issues. `#/stockissues` redirects here. |
| **Separate "Filter Stock" (`#/filterstock`)** | `#/filters?tab=stock` | Unified with Filters & Prices; `#/filterstock` silently redirects to `#/filters?tab=stock`. |
| **Stores "📦 GENERAL STOCK →" button** | `#/generalstock` | Removed from Stores toolbar so Stores focuses strictly on warehouse intake/movements and General Stock is accessed via its canonical nav. |
| **Legacy `#/stores?tab=catalogue`** | `#/generalstock?tab=catalogue` | Seamlessly redirects to Catalogue & Part Numbers in General Stock. |
| **Legacy `#/stores?tab=categories`** | `#/generalstock?tab=categories` | Seamlessly redirects to Categories tree in General Stock. |
| **Legacy `#/stores?tab=reorder`** | `#/generalstock?tab=reorder` | Seamlessly redirects to Re-Order Watch in General Stock. |
| **Legacy `#/stores?tab=general` / `tab=items`** | `#/generalstock?tab=catalogue` | Seamlessly redirects to General Stock catalogue. |
| **Dashboard "To Reorder" badge** | `#/generalstock?tab=reorder` | Directly opens General Stock reorder watch without bouncing through Stores. |

---

## 3. Data Integrity & Safety Guarantee

- **100% Data Preservation**: No database tables, columns, rows, or API endpoints have been altered or deleted.
- All backend endpoints (`/api/filter-stock/*`, `/api/general-stock/*`, `/api/stores/*`, `/api/oil/*`, `/api/batteries/*`, `/api/stock-cockpit/*`) remain fully active and responsive.
- Real-time updates (`LiveERP`) are wired to ensure all consolidated views re-render instantly on database mutations.
