# WorkshopOne — Master Inventory System URL Map

_Canonical single paths, supported tabs, and backwards-compatible redirect shims._

## 1. Master Inventory Canonical Routes (One Section = One Path)

Every section in the master inventory system now has exactly **one canonical path** in the primary navigation:

| Section | Canonical URL | Tabs / Views | Description |
|---|---|---|---|
| **Stores** | `#/stores` | `tab=pipeline`<br/>`tab=workspace`<br/>`tab=paperwork` (`sub=mrn`, `sub=grn`)<br/>`tab=movements` (`sub=issues`, `sub=mtn`)<br/>`tab=search` | Physical warehouse logistics & operations pipeline: intake pipeline, fast receive & price workspace, material requests (MRN), receipts (GRN), issues, and transfers (MTN). |
| **Stock Take** | `#/stocktake` | `tab=overview` (Master Overview)<br/>`tab=general` (General Stock)<br/>`tab=oil` (Oil & Lubricants)<br/>`tab=filters` (Filters & Prices)<br/>`tab=batteries` (Batteries) | Single unified master stock center: consolidated valuation, automated reorder alerts, universal search, live shelf balances, physical counts, lubricants, filters, and battery lifecycle registry. |
| **Service Records** | `#/services` | `#/services` (List)<br/>`#/services/new`<br/>`#/services/:id`<br/>`#/services/:id/edit` | Operations section: canonical home for vehicle & machinery maintenance service logs, meter readings, filter/oil consumption, and service histories. |

---

## 2. Eliminated Redundant Navigation & Backward-Compatible Redirect Shims

To avoid confusion where the same section could be viewed from 2 or 3 paths, redundant shortcuts and cross-module buttons have been removed from the primary UI while preserving seamless client-side redirects for bookmarks and existing links:

| Redundant / Secondary Path | Canonical Destination | Resolution in System |
|---|---|---|
| **Legacy `#/stockcockpit`** | `#/stocktake?tab=overview` | Seamlessly redirects to the Master Overview tab in Stock Take. |
| **Legacy `#/generalstock`** | `#/stocktake?tab=general` | Seamlessly redirects to General Stock tab in Stock Take. |
| **Legacy `#/oil`** | `#/stocktake?tab=oil` | Seamlessly redirects to Oil & Lubricants tab in Stock Take. |
| **Legacy `#/filters`** | `#/stocktake?tab=filters` | Seamlessly redirects to Filters tab in Stock Take. |
| **Legacy `#/batteries`** | `#/stocktake?tab=batteries` | Seamlessly redirects to Batteries tab in Stock Take. |
| **Legacy `#/filters?tab=services`** | `#/services` | Automatically redirects to the canonical Service Records view under Operations. |
| **Legacy `#/filters/service/:id`** | `#/services/:id` | Seamlessly redirects to Service Record details. |
| **Legacy `#/filters/new-service`** | `#/services/new` | Seamlessly redirects to New Service Form. |
| **Sidebar "Material Requests"** | `#/stores?tab=paperwork&sub=mrn` | Removed from sidebar; accessed directly in Stores -> Requests (MRN). `#/matreq` redirects here. |
| **Sidebar "Stock Issues"** | `#/stores?tab=movements&sub=issues` | Removed from sidebar; accessed directly in Stores -> Issues. `#/stockissues` redirects here. |
| **Separate "Filter Stock" (`#/filterstock`)** | `#/stocktake?tab=filters` | Redirects to Filters tab in Stock Take. Stock operations are handled in the Inventory section. |
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
