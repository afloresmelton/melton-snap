# Melton Snap — v1 Plan

Jobsite progress photo capture for Melton Electric field foremen.
PWA on iPhone + iOS share extension + OneDrive landing folder + hub-side mover into per-workspace photo archive.

---

## Phase 0 — Architecture validation (COMPLETE)

| Sub-phase | Question | Result |
|---|---|---|
| 0.1 | Set up local test playground | ✅ `C:\Users\aflores\photos-test\` + GitHub Pages deploy at `afloresmelton.github.io/melton-photos-test/` |
| 0.2 | Does EXIF UserComment survive iOS Safari → share sheet → OneDrive? | ✅ **Yes, intact.** Full JSON metadata round-trips perfectly. |
| 0.3 | Can the hub read EXIF from OneDrive-synced JPEGs via File System Access API? | ✅ **Yes.** Connect, list, persist handle, scan EXIF — all work in Chrome/Edge. |

**Conclusion:** the architecture is sound end-to-end. Every remaining task is implementation, not research.

---

## Locked-in decisions (post-validation)

| Decision | Rationale |
|---|---|
| **PWA** as the capture surface | No app stores, no Apple Developer cost, no Mac required, same skills as the existing hub. |
| **EXIF UserComment** holds metadata JSON | Validated end-to-end. Travels with the file. No sidecar files needed. |
| **iOS share extension** ("Save to OneDrive") as upload path | Proven working with 3 taps; doesn't require an iOS Shortcut. Shortcut path remains a future optimization. |
| **OneDrive Inbox** is the single shared folder | `JobsitePhotos-Inbox/` at OneDrive root. Field guys: edit perms. |
| **Workspace folder** is the permanent archive | `<workspace>/data/progress-photos/blobs/<YYYY-MM-DD>/<filename>` — matches RFI/MO/REQ pattern. |
| **Filename grammar** | `J<jobNo>__<HHmmss>__<3-char-nonce>.jpg` — routing key only; rest in EXIF. |
| **GitHub Pages** for PWA hosting | Free, fast, portable. Custom domain (e.g. `field.melton.com`) deferrable. |
| **Hub stays static HTML** | New `📸 Progress Photos` module + small hub-shell additions (FS handle storage). |
| **Hub-as-mover** | When you open the Photos module, hub scans Inbox and routes files into the right workspace. |
| **Map included from Phase 1.2** (not deferred to v2) | Floorplan-tap UX is the killer feature; ship the full experience. |
| **iOS-only for v1** | Android = whole separate problem. ~95% of Melton field phones are iPhones. |

---

## Phase 1 — Build sequence

### 1.1 — PWA shell with dropdown room picker

**Goal:** PWA deployed to GitHub Pages. Field guy can open it on iPhone, pick a job + room from dropdowns, snap a photo, fill caption, share to OneDrive Inbox. EXIF embed working. No map yet.

**Scope:**
- New repo `melton-snap` at GitHub
- `index.html` shell, mobile-first responsive
- `app.js` — capture flow (input + EXIF embed + filename builder + share)
- Config fetched from URL params (`?job=964&me=alex&rooms=IDF,Main+Elec,Floor+1`)
- `manifest.webmanifest` + basic service worker for "Add to Home Screen"
- Vendor: piexifjs (~30KB)

**Acceptance:** Capture a photo from your iPhone, share to OneDrive Inbox, verify EXIF intact via the existing `fs-test.html` page (Scan JPEGs button).

**Effort:** ~1-2 days part-time.

---

### 1.2 — Floorplan render + room tap

**Goal:** Replace the dropdown with a tappable floorplan map. Field guy taps a room → snap photo → metadata uses tapped room.

**Scope:**
- PWA fetches floorplan PNG + `rooms.json` from a OneDrive shared link (read-only public)
- Canvas-based floorplan renderer with pinch-zoom + pan (lightweight library or hand-rolled with Pointer Events)
- Room polygons overlaid (invisible or faint outlines)
- Tap → polygon hit-test → room selected
- Dropdown remains as fallback for outdoor / site-wide shots
- Floor selector tabs at top (multi-floor jobs)

**Test data for this phase:** hand-craft one floorplan PNG + `rooms.json` for testing. The Map Setup tool (1.4) lets you create these properly later.

**Acceptance:** Tap a room on the floorplan → snap → photo lands in OneDrive with the correct `room.id` and `room.name` in EXIF.

**Effort:** ~2-3 days part-time.

---

### 1.3 — Hub Progress Photos module + mover

**Goal:** Hub has a `📸 Progress Photos` module in the sidebar. Opens to a photo grid for the active workspace. On open, scans OneDrive Inbox and moves new photos into the workspace's `data/progress-photos/blobs/` folder.

**Scope:**
- `hub/modules/progress-photos/` — `module.yaml`, `index.html`, `app.js`, `mover.js`, `exif.js`, `filesystem.js`
- Hub-shell addition: `hub.filesystem` helper for persisting `FileSystemDirectoryHandle` in IndexedDB (generic, useful for future modules too)
- Mover algorithm:
  - List files in Inbox
  - Parse filename → `{jobNo, ts, nonce}`
  - Look up workspace by `jobNo` via the existing workspace switcher's index
  - Move file into `<workspace>/data/progress-photos/blobs/<YYYY-MM-DD>/<filename>`
  - Read EXIF UserComment, append to workspace's `manifest.json`
  - Quarantine bad filenames + unknown-job files into `Inbox/_needs_review/`
- Grid view reads from workspace's `manifest.json`
- Filters: date, room, tag, photographer

**Acceptance:** Photo uploaded via PWA shows up in the hub's Photos module within 60s of opening the module (after OneDrive sync delay).

**Effort:** ~3-4 days part-time.

---

### 1.4 — Map Setup tool (hub side)

**Goal:** User can mark up a floorplan and save room data without hand-crafting JSON. This is the "configuration" tool that produces the `rooms.json` + floorplan PNG that the PWA in 1.2 consumes.

**Scope:**
- `setup.html` sub-route in the Photos module
- Upload floorplan: PDF (via pdf.js) or PNG/JPG directly
- Click-to-mark UI: click a point on the floorplan → name the room → repeat
- Optional: polygon mode for irregularly shaped rooms (later refinement)
- Multi-floor support (one floorplan + room set per floor)
- Save outputs:
  - `<workspace>/data/progress-photos/rooms.json` + `floorplans/floor-N.png`
  - Mirror to OneDrive at `JobsitePhotos-Config/J<jobNo>/` (anonymous read share link for PWA fetch)
- Generate field-guy onboarding kit: copy-to-clipboard text containing the PWA URL (`field.melton.com/?job=964&me=<name>`) + setup instructions

**Acceptance:** Configure rooms for the real Cerberus job. PWA fetches the config and shows the actual floorplan with real room labels.

**Effort:** ~4-5 days part-time. The longest single piece.

---

### 1.5 — End-to-end with a real job + polish

**Goal:** Roll out to one real field guy on the active Cerberus job. Iterate based on real use.

**Scope:**
- Map Setup the Cerberus floorplan
- Generate field-guy URL + send onboarding instructions
- Field guy uses it for one shift
- Address issues: filename collisions, sync delays, weird photos, UX papercuts
- Lightbox detail view (full image, edit caption, "open file location")
- Quarantine review UI (resolve mis-routed photos)
- Manifest-as-cache layer (don't re-scan EXIF on every grid render)

**Acceptance:** Field guy completes one shift with ≥10 photos uploaded. You can browse them in the hub. No data loss. Caption edits round-trip.

**Effort:** ~3-4 days part-time, spread over a couple weeks of real usage.

---

## Rough total effort

| Phase | Effort | Cumulative |
|---|---|---|
| 1.1 — PWA shell | 1-2 days | 1-2 days |
| 1.2 — Floorplan map | 2-3 days | 3-5 days |
| 1.3 — Hub module + mover | 3-4 days | 6-9 days |
| 1.4 — Map Setup tool | 4-5 days | 10-14 days |
| 1.5 — Real-job rollout | 3-4 days (spread) | 13-18 days |

**~3-4 weeks of part-time work** to a production-ready v1 with map.

---

## Deferred to v2+

- **Android support** — Tasker or PWA-only workflow if Android phones enter the picture
- **Photos accessible from phone** — currently archive is PC-only; v2 could sync workspace blobs back to OneDrive in a read-only namespace
- **Multi-PC hub** — workspace folder in OneDrive resolves this, plus a lock-file pattern in the mover
- **AI-assisted room extraction** — PDF text-layer OCR or vision API to bootstrap Map Setup from the architect's drawings
- **Export**: ZIP+CSV report for sharing with GC / owner / inspector
- **Linking photos to RFI/MO records** — punted from v1 per the "standalone" decision
- **SharePoint migration** — when this graduates from pilot to company-wide tool
- **Voice memos attached to photos**
- **Photo annotation** (arrows, redaction, callouts) — Apple Pencil if iPad ever enters the mix
- **Custom domain** (`field.melton.com`) — when ready; just a DNS change away
- **Capacitor wrap** — if "real app" feel becomes politically important

---

## Recovery & safety

Per the existing hub workflow:
- Before each phase: `robocopy hub hub/_recovery/pre-photos-<phase>-<date>`
- Before each Map Setup change to a real job: snapshot workspace folder
- OneDrive Inbox is transient — loss is bounded to a few hours of pending uploads
- Workspace `data/progress-photos/blobs/` is the durable copy; backed up by whatever backs up the workspace folder (likely OneDrive private namespace if workspaces live under `OneDrive - Melton/Projects/`)

---

## File locations (when complete)

```
C:\Users\aflores\
├── hub\                                          ← existing
│   └── modules\
│       └── progress-photos\                      ← NEW (Phase 1.3)
│           ├── module.yaml
│           ├── index.html
│           ├── detail.html
│           ├── setup.html
│           ├── app.js
│           ├── mover.js
│           ├── exif.js
│           ├── filesystem.js
│           ├── styles.css
│           └── vendor\piexif.min.js
│
├── melton-snap\                                  ← NEW (Phase 1.1) — PWA source
│   ├── PLAN.md                                   ← this file
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── manifest.webmanifest
│   ├── sw.js                                     ← service worker (offline cache)
│   └── vendor\piexif.min.js
│
├── photos-test\                                  ← existing — Phase 0 throwaway tests
│   ├── exif-test.html
│   └── fs-test.html
│
└── OneDrive - MELTON ELECTRIC INC\  (or personal OneDrive)
    ├── JobsitePhotos-Inbox\                      ← existing (Phase 0)
    │   └── _needs_review\
    │
    ├── JobsitePhotos-Config\                     ← NEW (Phase 1.4 output)
    │   └── J964\
    │       ├── floor-1.png
    │       ├── floor-2.png
    │       └── rooms.json
    │
    └── Projects\
        └── 964 - Cerberus WSD IB3\               ← workspace (existing)
            ├── workspace.json
            └── data\
                └── progress-photos\              ← NEW (Phase 1.3)
                    ├── manifest.json
                    └── blobs\
                        └── 2026-05-22\
                            └── J964__113715__xmh.jpg
```

PWA deployed at `afloresmelton.github.io/melton-snap/` (with future migration to `field.melton.com`).

---

## What's NOT in v1

To prevent scope creep, these are explicitly out:

- No backend service — everything is static files + browser APIs
- No authentication — OneDrive's own auth gates uploads via the share extension
- No real-time notifications — hub polls Inbox when you open it
- No collaborative editing — single-writer model (the hub on your PC)
- No cross-job photo browsing — each workspace shows only its own photos
- No Android — iOS-only for v1
