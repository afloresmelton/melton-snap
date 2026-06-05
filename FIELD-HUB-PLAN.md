# Melton Field Team Hub — Plan

**Premise:** Melton Snap stops being a single-purpose photo app and becomes the **first module of the Field Team Hub** — a phone-first, cloud-backed companion to the desktop office hub (`C:\Users\aflores\hub\`). Photos is module #1; **Field Materials Request is module #2**.

This plan covers the evolution from "one app" to "field hub with modules." The v1 capture build is in [`PLAN.md`](PLAN.md) and is assumed done — read it first for the photo-capture mechanics this builds on.

---

## 1. The product pattern: field captures → office processes

The field hub is not a grab-bag of apps. **Every field module is the front door to an office module.** A foreman captures intent in the field; the office hub formalizes and acts on it. They meet at a per-job folder in OneDrive.

| Field hub (capture, phone) | ── bridge (OneDrive job folder) ── | Office hub (process, desktop) |
|---|---|---|
| **Melton Snap** — shoot photo + metadata | → | **Progress Photos** — ingest, review, export *(built)* |
| **Field Materials Request** — "I need X" | → | **Material Order** — consolidate, send vendor RFP *(office side exists; gains ingest)* |
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

### 2.0 — Refactor Snap into a shell (no new features)
**Goal:** Extract the shared services (§4) out of today's single-purpose `app.js`, with photo capture re-expressed as `module: photos` running on the shell. Behavior identical; structure changed.
- Pull identity, job context, and the upload queue out of the capture flow into shell services.
- Introduce a minimal module registry + nav (even with one module visible).
- Keep the SW/auto-update + offline queue working (don't regress what's shipped).
**Acceptance:** Snap works exactly as before, but capture now calls `shell.sync.enqueue(...)` and `shell.job.current()` instead of inlined logic. A stub second module can be registered and appears in nav.
**Effort:** ~3–4 days.

### 2.1 — Field Materials Request module
**Goal:** A foreman picks a job, creates a request (items + qty + room + needed-by + optional photo), submits; it queues offline and uploads to the job folder `_inbox/` as `matreq__*.json`.
- Form UI (mobile-first): add line items, attach photo via the shared capture component, urgency, note.
- Fetch `job-data/J<jobNo>/material-request/` (vendor + standard-items catalog) for autocomplete; degrade gracefully if absent.
- Write the record via the sync outbox (reuses §4).
**Acceptance:** Submit a request on a phone offline → it uploads when back online → the `matreq__*.json` appears in the job folder with correct schema (§7).
**Effort:** ~4–5 days.

### 2.2 — Office side: Material Order ingest + publish
**Goal:** The office MO module pulls field requests and emits the field catalog.
- **Ingest:** "Sync field requests" button (mirror of Progress Photos' Sync Inbox) → reads `matreq__*.json` from the job folder → creates draft MO line items for review → existing RFP/vendor flow takes over. Quarantine malformed records.
- **Publish:** office writes `job-data/J<jobNo>/material-request/{vendors,items}.json` (the standard catalog the field module autocompletes against), same one-button git-publish path as `rooms.json`.
**Acceptance:** A field request becomes a draft line item in MO within a sync cycle; estimator turns it into a vendor RFP with the existing tooling.
**Effort:** ~3–4 days.

### 2.3 — End-to-end on a real job + polish
**Goal:** One foreman uses Snap **and** Materials Request on the active Cerberus job for a shift.
- Real material-request round-trip (field → MO draft → RFP).
- Address: offline edge cases, duplicate submits, identity/job-assignment papercuts, MSAL token persistence on standalone iOS PWA (the v1 "remaining unknown").
**Acceptance:** ≥1 photo batch and ≥1 material request complete end-to-end, no data loss, correct attribution.
**Effort:** ~3–4 days, spread over real usage.

| Phase | Effort | Cumulative |
|---|---|---|
| 2.0 — Snap → shell | 3–4 days | 3–4 |
| 2.1 — Field Materials Request | 4–5 days | 7–9 |
| 2.2 — MO ingest + publish | 3–4 days | 10–13 |
| 2.3 — Real-job E2E + polish | 3–4 days (spread) | 13–17 |

**~3–4 weeks part-time** to a two-module field hub feeding the office MO module.

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
  "status": "submitted"               // draft (local only) | submitted (uploaded)
}
```

**Office ingest:** MO reads these, maps `items[]` → draft MO line items (reuse the MO record shape, see office `module_material_order` reference), preserves `requester`/`location`/`photos` as provenance, then the estimator assigns vendors and the existing RFP flow sends. The `matreq__` filename prefix is the routing key (parallel to `J<jobNo>__` for photos).

---

## 8. Open decisions / risks

- **MSAL in Melton's tenant.** Currently the personal-Azure registration (`239f56eb-22b0-4af6-86d4-272126d390a9`, `Files.ReadWrite.AppFolder`). As the field hub's identity layer for multiple foremen, replicating it in Melton's M365 tenant moves from "nice" to "required." (De-risked already; it's an IT ask.)
- **Job assignment / least privilege.** A foreman should see only their jobs. Where does the job list + assignment live, and who maintains it? (Office hub publishes a per-user job list?)
- **AppFolder vs per-job path.** The good upload path today targets the sandboxed AppFolder (`/Apps/Melton Snap/`). Per-job inbox (§3) needs writing into a *specific* job's folder — which likely needs broader Graph scope than `Files.ReadWrite.AppFolder`. Resolve before leaving the testing inbox.
- **Offline conflict / dedupe.** Sync outbox must be idempotent (nonce in filename) so a retried upload doesn't double-submit.
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
├── index.html                            ← shell entry
├── shell/                                ← NEW (Phase 2.0): cloud shell + shared services
│   ├── identity.js   (MSAL login)
│   ├── job.js        (job context/selection)
│   ├── sync.js       (offline outbox; binary + JSON)
│   ├── nav.js        (module registry + switcher)
│   └── capture.js    (shared camera/attach)
├── modules/
│   ├── photos/                           ← today's app.js, re-expressed as a module
│   └── material-request/                 ← NEW (Phase 2.1)
├── job-data/ J<jobNo> / <module>/        ← office→field publish feed
│   ├── photos/  (rooms.json, floorplans)
│   └── material-request/ (vendors.json, items.json)
├── sw.js  manifest.webmanifest  styles.css

C:\Users\aflores\hub\  (office hub)
└── modules/
    ├── progress-photos/                  ← built (field→office for photos)
    └── material-order/                   ← gains "Sync field requests" ingest (Phase 2.2)
```

---

## 11. Relationship to other plans

- [`melton-snap/PLAN.md`](PLAN.md) — v1 capture mechanics (EXIF, share/MSAL upload, mover). Foundation; unchanged.
- `C:\Users\aflores\hub\PLAN.md` — office hub roadmap; the field hub feeds its Progress Photos and Material Order modules.
- Office Material Order deep reference: the `module_material_order` notes (record shape the field request maps into).
