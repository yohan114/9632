# WorkshopOne Mobile — Android client

A native Android app for **WorkshopOne** (Edward & Christie Central Workshop,
Badalgama). It talks to the WorkshopOne server over the workshop LAN using the
same REST API and session auth as the browser SPA — same accounts, same roles,
same rules. The server stays the single source of truth; the app is a fast,
phone-friendly front end for the people on the floor.

## What it does

| Area | Features |
|---|---|
| **Sign in** | Server address setup + connection test, username/password login, forced first-login password change (server rule), session persists across app restarts |
| **Dashboard** | Open jobs / closed this month, jobs by status, "awaiting price" list, low-stock lubricants, battery warranty radar (60 days), this-month cost by project, Needs Attention summary |
| **Job cards** | List with status filter + search, raise a new job card (asset resolves through the alias resolver — unknown names are queued, never lost), full job detail: cost buckets, closure-gate blockers, labour lines, daily work (crew hours split per mechanic, external repairs), parts (add / late pricing / delete), oil & general issues, approval history |
| **Workflow** | All state transitions with the exact server rules: two-step approval, reject/return with reason, start/complete, gated close (server rejects with the missing-items list, shown in-app), admin-only reopen |
| **Assets** | Search, then Asset 360: identity, service-due, lifetime cost breakdown, current battery, open jobs, unified timeline (jobs, oil, MRN/MTN, battery events) |
| **Stock** | Lubricant forecast (balance, daily rate, days of cover, reorder flags), recent oil ledger, general-store reorder list |
| **Batteries** | Search by serial/brand (whereis), state filters, full event history per battery |
| **Needs Attention** | Service due fleet-wide, unusual consumption, duplicate MRNs, GRN price spikes, integrity check — read-only, flags only |

Role-aware UI: buttons the signed-in user can't use (per `src/lib/auth.js` +
`src/lib/jobstate.js`) are hidden. The server still enforces everything.

## Building

Prerequisites: Android Studio (or Android SDK 35 + JDK 17+).

```bash
cd android
./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
```

or open `android/` in Android Studio and Run. Minimum Android version: 8.0
(API 26).

## Connecting

1. Start the WorkshopOne server on the workshop PC (`npm start`), bound to
   `0.0.0.0` per `deploy/DEPLOY.md`; note the LAN address it prints
   (e.g. `http://192.168.1.50:3000`).
2. Put the phone on the same Wi-Fi / LAN.
3. In the app's sign-in screen enter `192.168.1.50:3000`, tap **Test
   connection**, then sign in with a WorkshopOne account.

The server speaks plain HTTP on the LAN, so the app allows cleartext traffic
(`android:usesCleartextTraffic="true"`). If you later front the server with
HTTPS, `https://…` addresses work unchanged.

## Design notes

- **Stack:** Kotlin 2.0, Jetpack Compose (Material 3), Navigation-Compose,
  ViewModel + StateFlow, Retrofit + Gson, OkHttp. Single activity, no DI
  framework.
- **Auth:** the server's `wo_session` cookie is captured from the login
  response, stored in `SharedPreferences`, attached to every request, and
  dropped on any 401 — which returns the UI to the sign-in screen. Sessions
  are DB-backed server-side, so a stored cookie survives app restarts until
  it expires.
- **DTOs** (`data/Models.kt`) mirror the API JSON field-for-field
  (snake_case straight from SQLite rows; the auth endpoints' camelCase kept
  as-is).
- **State machine** (`data/Roles.kt`) mirrors `src/lib/jobstate.js` only to
  decide which buttons to show; every transition is still validated
  server-side.
- `app/src/main/java/.../MainActivity.kt` is the only file touching
  `androidx.activity`; everything else is plain Compose + ViewModel, which is
  what allowed the whole codebase to be machine-verified against the public
  Compose APIs before commit.
