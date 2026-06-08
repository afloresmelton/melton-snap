# Melton Field Team Hub — Plan

**Premise:** Melton Snap stops being a single-purpose photo app and becomes the **first module of the Field Team Hub** — a phone-first, cloud-backed companion to the desktop office hub (`C:\Users\aflores\hub\`). Photos is module #1; **Field Materials Request is module #2**.

This plan covers the evolution from "one app" to "field hub with modules." The v1 capture build is in [`PLAN.md`](PLAN.md) and is assumed done — read it first for the photo-capture mechanics this builds on.

---

## 0. Status — built & live (updated 2026-06-07)

Phases **2.0, 2.1, 2.2 (ingest), and 2.2b (catalog publish)** are built and in use on the pilot job (964 / BP EV HUB). The field PWA is deployed on GitHub Pages (`afloresmelton.github.io/melton-snap/`, SW cache `v27`); the office side runs in the desktop hub. **Only Phase 2.3 (real on-phone E2E) remains** before the pilot is end-to-end on a device.

| Phase | State | As built |
|---|---|---|
| **2.0 — Snap → field shell** | ✅ done, live | `window.shell` = `core/identity/job/sync/capture/nav/boot` + `modules/photos` + `modules/material-request`. Plus a **frozen v1 fallback** at `/v1/` (the pre-refactor app, in case the hub breaks on a phone). |
| **2.1 — Field Materials Request** | ✅ done, live | Mobile form (repeatable line items, photo attach, urgency, needed-by, note), **one-press Submit** (queues + uploads in a single tap), `matreq__*.json` bridge. Location field dropped per field feedback. |
| **2.2 — Office ingest** | ✅ done | Built as a **sibling hub module** `material-request-inbox` (not a button inside MO). Routes by jobNo → **deferred order creation**: requests land in a status log; the PM clicks **Create New Order** to mint a draft MO and is dropped into it. |
| **2.2b — Catalog publish** | ✅ done, live | **Company-wide** catalog at `/catalog/` (NOT per-job): `items.json` (30,729 active items + keywords) + `assemblies.json` (112 active kits). Field form gained **keyword autocomplete** (synonyms: "one hole"→`1-H STRAP`), an **assembly picker** with run-length expansion, and **relevance-ranked** search in both the item box and the assembly box. Publish via `tools/publish-catalog.py` from the grouping tool's master exports (`catalog-src/`, gitignored). |
| **2.3 — Real-job E2E** | ⏳ in progress | First on-phone round-trips underway; iterating on device. **The remaining gate** — surfaces the MSAL-tenant/Graph-scope work (§8). |

**Notable departures from the original plan** (detail in §8):
- **MSAL switched popup → redirect auth.** iOS standalone PWAs block popups — this *was* the §2.3 "remaining unknown." Paired with a **durable IndexedDB outbox** so the full-page sign-in redirect doesn't lose queued captures, and an **auto-resume** after sign-in.
- **Office ingest is a sibling module with deferred, status-driven order creation** (status: No order created / Draft / RFP Sent / Deleted), not an auto-create button in MO. The PM stays in control of when a request becomes an order.
- **Photo tag-and-route.** A request's attachment is named `MRQ<job>__…` and the Progress Photos mover *skips* `MRQ*` files, so the photo lands on its **order** (Material Requests attaches it) instead of disappearing into Progress Photos.
- **SW caching hardened** (`cache:'reload'` on precache + navigation) to kill the "deployed but the phone still shows old" problem.
- **Catalog went company-wide, not per-job.** The original plan had the office write a per-job `items.json`; instead the catalog + assemblies are a single **universal `/catalog/`** (master data every job reads), served network-first so a re-publish reaches phones with no SW bump. The field gained relevance-ranked item + assembly search and a run-length assembly picker. Known gap: source has no units yet.

---

## 1. The product pattern: field captures → office processes

The field hub is not a grab-bag of apps. **Every field module is the front door to an office module.** A foreman captures intent in the field; the office hub formalizes and acts on it. They meet at a per-job folder in OneDrive.

| Field hub (capture, phone) | ── bridge (OneDrive job folder) ── | Office hub (process, desktop) |
|---|---|---|
| **Melton Snap** — shoot photo + metadata | → | **Progress Photos** — ingest, review, export *(built)* |
| **Field Materials Request** — "I need X" | → | **Material Order** — consolidate, send vendor RFP *(office side exists; **ingest built** — `material-request-inbox`)* |
| *(later)* Field RFI request | → | RFI module *(exists)* |
| *(later)* Daily report / deficiency log | → | *(future office module)* |

This pairing is the spine. Build the field hub so that adding a pair (capture module + office ingest) is a repeatable move, not a one-off.

---

## 2. Two hubs, one product

| | **Office hub** (`C:\Users\aflores\hub\`) | **Field hub** (this repo, `melton-snap`) |
|---|---|---|
| Users | Alex / office | Foremen, on phones |
| Runtime | Desktop Chrome/Edge | Installed PWA (iOS first) |
| Data layer | **File System Access** + local workspace folders | **Cloud** — MSAL/Graph to OneDrive, fetch from GitHub Pages, local offline queue |
| Identity | None (single local user) | **MSAL login** (multi-user) |
| Deploy | Local files, one machine | Deployed PWA, many phones, auto-updating SW |
| Modules | RFI, OR, Material Order, Progress Photos | Snap (photos) → Field Materials Request → … |

### Decision: separate shells, shared contracts — do **not** unify

The office shell (`shell.js` / `storage.js` / `workspaces.js` / `persist.js`) is fundamentally a **File System Access engine** — it reads/writes folder *handles*. None of that exists on a phone (`showDirectoryPicker` is unavailable in iOS Safari / standalone PWAs). Forcing one shell to abstract over "desktop local files" and "phone cloud API" fights both.

- **Shared (cheap, high value):** the module-manifest idea (`name/icon/entry`), nav pattern, hash routing, the per-job-context concept, visual language, and — most importantly — the **data contracts** below.
- **Not shared:** the storage/identity backend, module discovery, and the desktop-only localhost helper.

The field hub gets its **own thin cloud shell**, kept aligned with the office hub by convention, not by shared code.

---

## 3. The bridge: one seam, two directions, two payload types

The **OneDrive job folder is the universal field↔office meeting point.** It is written by the field hub via MSAL/Graph (cloud) and read by the office hub via File System Access (the local OneDrive sync folder); OneDrive reconciles the two. Resist inventing a second channel — one seam, many artifact types.

```
<OneDrive job folder> / <jobNo> /            ← the bridge for one job
├── _inbox/                                   ← FIELD → OFFICE (capture direction)
│   ├── J964__113715__xmh.jpg                 ·  binary: photos (EXIF metadata)   → Progress Photos
│   └── matreq__20260605T0830__a1b2.json      ·  structured: material requests    → Material Order
└── (office-published config lives in the GitHub job-data feed, below)

melton-snap/job-data/ J<jobNo> / <module> /   ← OFFICE → FIELD (publish direction, served via GitHub Pages)
├── photos/        rooms.json + floorplans     → Snap fetches
└── material-request/  vendors.json + items.json (standard catalog)  → Field Materials Request fetches
```

Two refinements module #2 forces, good to lock now:

1. **The capture bridge carries structured records, not just files.** Photos are binary + EXIF; material requests are JSON. Same `_inbox`, new payload type.
2. **Office-side ingest is symmetric.** Progress Photos already has "Sync Inbox." **Material Order gains the identical step** — pull `matreq__*.json` from the job folder → draft MO line items the estimator reviews → existing RFP flow. Build the "ingest from job folder" pattern once, reuse per module.

### Inbox today vs. long-term

- **Testing phase (now):** one shared OneDrive inbox + filename routing by `jobNo`. Scaffolding — keep it.
- **Long-term:** the inbox **lives inside each job folder** (`<jobFolder>/_inbox/`). On the office side it's then a subfolder of the already-connected workspace — no separate folder picker, no re-grant, and cross-workspace `jobNo` routing becomes vestigial. The harder part that keeps us on the shared inbox today is the **phone upload target** (getting the phone to write into a *specific* job's OneDrive folder), which the field shell's sync layer (§4) is where that gets solved.

---

## 4. The field shell — shared services (what module #2 justifies building)

Two modules share enough that not extracting these means building them twice:

| Service | What it does | Used by |
|---|---|---|
| **Job context** | "Which job am I on" — picked from a synced list (not a folder). The field analog of the office "active workspace." | all modules |
| **Identity** | MSAL login; who is this foreman (the `photographer`/`requester` stamp); which jobs they're assigned to. | all modules |
| **Sync outbox** | Offline-first queue. Captures land locally first, upload to the job folder when there's signal, retry on failure. Carries **both** binary (photos) and JSON (requests). The core service — job sites have bad signal. | all modules |
| **Nav + module registry** | Sidebar/switcher between Snap and Materials Request (and future modules). | shell |
| **Capture component** | Shared camera/photo-attach. **Materials Request reuses it** ("I need *this* breaker" → snap the nameplate → attach to the request). The modules compose. | Snap, Materials Request |

---

## 5. Locked decisions (this planning round)

| Decision | Rationale |
|---|---|
| Field hub is a **separate phone/cloud shell**, not the office FS shell | Storage backends are incompatible; sharing code would fight both runtimes. |
| **Contracts** (manifest shape, bridge layout, metadata schema) are shared | Cheap alignment; lets capture→process pairs be a repeatable move. |
| **OneDrive job folder** is the single field↔office bridge | One seam. Field writes via Graph, office reads via FS, OneDrive syncs. |
| Bridge carries **files and structured JSON** | Photos are binary; requests are records. Same `_inbox`. |
| **Material Order gains a "Sync field requests" ingest** | Symmetric to Progress Photos' Sync Inbox; reuse the pattern. |
| **Field Materials Request feeds the existing MO module** | It is the capture half of a module already built — not a new standalone. |
| **Module #2 = Field Materials Request** (then RFI, daily report, deficiency) | Highest-value pairing; proves the structured-record bridge. |
| **MSAL is the field hub's identity layer**, not just an upload trick | Multi-foreman hub needs real identity → productionizing in Melton's tenant is now load-bearing. |
| Inbox is **per-job long-term**, shared-inbox is testing scaffolding | The job folder is the universal meeting point; per-job kills routing + re-grant friction. |

---

## 6. Build sequence

Continues the v1 numbering (v1 = Phase 0–1.x). Field-hub work = **Phase 2.x**.

### 2.0 — Refactor Snap into a shell (no new features) · ✅ DONE
**Goal:** Extract the shared services (§4) out of today's single-purpose `app.js`, with photo capture re-expressed as `module: photos` running on the shell. Behavior identical; structure changed.
- Pull identity, job context, and the upload queue out of the capture flow into shell services.
- Introduce a minimal module registry + nav (even with one module visible).
- Keep the SW/auto-update + offline queue working (don't regress what's shipped).
**Acceptance:** Snap works exactly as before, but capture now calls `shell.sync.enqueue(...)` and `shell.job.current()` instead of inlined logic. A stub second module can be registered and appears in nav.
**Effort:** ~3–4 days.

### 2.1 — Field Materials Request module · ✅ DONE
**Goal:** A foreman picks a job, creates a request (items + qty + room + needed-by + optional photo), submits; it queues offline and uploads to the job folder `_inbox/` as `matreq__*.json`.
- Form UI (mobile-first): add line items, attach photo via the shared capture component, urgency, note.
- Fetch `job-data/J<jobNo>/material-request/` (vendor + standard-items catalog) for autocomplete; degrade gracefully if absent.
- Write the record via the sync outbox (reuses §4).
**Acceptance:** Submit a request on a phone offline → it uploads when back online → the `matreq__*.json` appears in the job folder with correct schema (§7).
**Effort:** ~4–5 days.

### 2.2 — Office side: Material Order ingest + publish · ✅ ingest DONE / ⏳ publish next
**Goal:** The office MO module pulls field requests and emits the field catalog.
- **Ingest:** ✅ built as a **sibling hub module** `material-request-inbox` (mirror of Progress Photos' Sync Inbox — *not* a button inside the 2,700-line MO form). Sync reads `matreq__*.json`, routes by jobNo, pulls the request's photos, and logs each request with a **status** (No order created / Draft / RFP Sent / Deleted, derived live from whether the order file exists). The PM clicks **Create New Order** to mint the draft MO + attach its photos, then is dropped into it; the existing RFP/vendor flow takes over. Bad/unroutable records → `_needs_review/`. The archived `<orderNo>.source.json` lets a deleted order be re-created. *(Deferred creation — the PM controls when a request becomes an order.)*
- **Publish:** ⏳ office writes `job-data/J<jobNo>/material-request/{vendors,items}.json` (the standard catalog the field module autocompletes against), same one-button git-publish path as `rooms.json`. *(Today `items.json` is hand-seeded.)*
**Acceptance:** A field request becomes a draft MO the estimator turns into a vendor RFP with the existing tooling. ✅ met for ingest.
**Effort:** ~3–4 days.

### 2.3 — End-to-end on a real job + polish · ⏳ IN PROGRESS
**Goal:** One foreman uses Snap **and** Materials Request on the active Cerberus job for a shift.
- Real material-request round-trip (field → MO draft → RFP).
- Address: offline edge cases, duplicate submits, identity/job-assignment papercuts. **Confirm the redirect-auth sign-in works on a real iOS standalone PWA** (the code fix is in — this is the on-device check).
**Acceptance:** ≥1 photo batch and ≥1 material request complete end-to-end, no data loss, correct attribution.
**Effort:** ~3–4 days, spread over real usage.

| Phase | Effort | State |
|---|---|---|
| 2.0 — Snap → shell | 3–4 days | ✅ done, live |
| 2.1 — Field Materials Request | 4–5 days | ✅ done, live |
| 2.2 — MO ingest | 3–4 days | ✅ done |
| 2.2b — catalog publish | ~1 day | ⏳ next |
| 2.3 — Real-job E2E + polish | 3–4 days (spread) | ⏳ in progress |

**~3–4 weeks part-time** to a two-module field hub feeding the office MO module — **the core round-trip is built and live**; remaining is catalog publish + real-job hardening.

---

## 7. Field Materials Request — data contract (draft)

Record dropped at `<jobFolder>/_inbox/matreq__<ISO8601compact>__<nonce>.json`:

```jsonc
{
  "schema": 1,
  "type": "material-request",
  "job": "964",                       // from job context
  "requester": "alex",                // from identity
  "created_at": "2026-06-05T08:30:00-05:00",
  "needed_by": "2026-06-08",          // optional
  "urgency": "normal",                // normal | rush
  "location": { "floor": "1", "room": "IDF", "free": "" },  // optional, mirrors photo room schema
  "items": [
    { "description": "20A 1P breaker, Square D QO", "qty": 6, "unit": "ea", "note": "" }
  ],
  "photos": [ "J964__083012__a1b.jpg" ],   // optional refs to attachments captured via shared component
  "note": "gate code 1234; deliver to trailer",  // optional, request-level free note
  "status": "submitted"               // draft (local only) | submitted (uploaded)
}
```

**Office ingest:** MO reads these, maps `items[]` → draft MO line items (reuse the MO record shape, see office `module_material_order` reference), preserves `requester`/`location`/`photos` as provenance, then the estimator assigns vendors and the existing RFP flow sends. The `matreq__` filename prefix is the routing key (parallel to `J<jobNo>__` for photos).

---

## 8. Open decisions / risks

### Resolved during the 2.x build
- **iOS PWA sign-in** *(was the §2.3 "remaining unknown")*. Popups are blocked in standalone PWAs → MSAL switched to **redirect auth** (`acquireTokenRedirect` + `handleRedirectPromise`). The full-page redirect would lose an in-memory queue, so the **sync outbox is now durable (IndexedDB)** and boot **auto-resumes** the upload on return. The iOS share-sheet remains the no-MSAL fallback. *(On-device confirmation of the redirect itself is the last 2.3 check.)*
- **Photo collision in the shared inbox.** A request's attachment is a `.jpg` Progress Photos would otherwise claim. Fixed with a **tag-and-route rule**: attachments are named `MRQ<job>__…`; the Progress Photos mover skips `MRQ*`; the Material Requests ingest attaches them to the order.
- **Where uploads land.** Confirmed: MSAL direct upload writes to the OneDrive **AppFolder** (`/Apps/<app-display-name>/`); the office connects that synced folder in both Progress Photos and the new Material Requests module.
- **Order-creation control.** Office ingest does **not** auto-create orders — deferred, status-driven **Create New Order** (the PM decides when a request becomes an order).
- **Stale deploys on phones.** SW hardened with `cache:'reload'` on precache + navigation, so a version bump reliably reaches the device on next launch.

### Still open
- **MSAL in Melton's tenant.** Currently the personal-Azure registration (`239f56eb-22b0-4af6-86d4-272126d390a9`, `Files.ReadWrite.AppFolder`). For multi-foreman identity, replicating it in Melton's M365 tenant moves from "nice" to "required." (IT ask.)
- **Job assignment / least privilege.** A foreman should see only their jobs. Where does the job list + assignment live, and who maintains it? (Office hub publishes a per-user job list?)
- **AppFolder vs per-job path.** Uploads target the sandboxed AppFolder. The §3 per-job inbox needs writing into a *specific* job's folder — likely broader Graph scope than `Files.ReadWrite.AppFolder`. Resolve before leaving the shared testing inbox.
- **Durability of un-actioned requests.** Synced-but-no-order-yet requests live in the office browser's IndexedDB (the inbox is consumed on sync); *created* orders are durable on disk. Fine for the single-PC pilot; revisit if it must survive a browser wipe.
- **Offline conflict / dedupe.** Sync outbox is idempotent (nonce in filename) so a retried upload doesn't double-submit.
- **Android.** Still iOS-first; revisit if Android phones enter the field.

---

## 9. Deferred (module #3+ and beyond)

- Field **RFI request** → office RFI module (same pattern).
- **Daily report / crew + hours**, **deficiency / punch log** capture modules.
- Photos/requests **viewable on the phone** (read-back), not just write.
- **Push notifications** to the field (office → "your RFP shipped").
- **Custom domain** (`field.melton.com`).
- **SharePoint / company-wide** migration when this graduates from pilot.

---

## 10. File locations (target)

```
melton-snap/                              ← the Field Team Hub (this repo, GitHub Pages)
├── PLAN.md                               ← v1 capture plan (foundation)
├── FIELD-HUB-PLAN.md                     ← this file
├── index.html  styles.css  sw.js  manifest.webmanifest   ← shell entry + chrome
├── shell/                                ← cloud shell + shared services (Phase 2.0)
│   ├── core.js       (namespace, logger, shared banner, util)
│   ├── identity.js   (MSAL — redirect auth)
│   ├── job.js        (job context + bootstrap/error views)
│   ├── sync.js       (durable IndexedDB outbox; binary + JSON; Graph upload + tray)
│   ├── capture.js    (shared camera/attach)
│   ├── nav.js        (module registry + top tab bar)
│   └── boot.js       (orchestrator: SW reg + app-update + auto-resume)
├── modules/
│   ├── photos/photos.js                  ← v1 capture, re-expressed as a module
│   └── material-request/material-request.js  ← Phase 2.1 form
├── job-data/ J<jobNo>/                   ← office→field publish feed (GitHub Pages)
│   ├── rooms.json + floor-*.svg          ← Snap fetches (photos config)
│   └── material-request/items.json       ← Materials autocomplete (hand-seeded; 2.2b publishes for real)
└── v1/                                   ← FROZEN pre-refactor Snap (emergency fallback; snapv1-* SW namespace)

C:\Users\aflores\hub\  (office hub — local files, not git)
└── modules/
    ├── progress-photos/                  ← built (field→office for photos); now SKIPS MRQ* files
    ├── material-order/                   ← existing capture form (draft orders are written here)
    └── material-request-inbox/           ← NEW (Phase 2.2): field-request ingest + status log + Create New Order
```

---

## 11. Relationship to other plans

- [`melton-snap/PLAN.md`](PLAN.md) — v1 capture mechanics (EXIF, share/MSAL upload, mover). Foundation; unchanged.
- `C:\Users\aflores\hub\PLAN.md` — office hub roadmap; the field hub feeds its Progress Photos and Material Order modules.
- Office Material Order deep reference: the `module_material_order` notes (record shape the field request maps into).
