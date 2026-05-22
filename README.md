# Melton Snap

Jobsite progress photo capture PWA for Melton Electric field foremen.

Pairs with the hub's Progress Photos module to provide an end-to-end workflow:
phone capture → OneDrive Inbox → hub-side mover → per-workspace archive.

## Usage

Open the deployed URL with required parameters:

```
https://afloresmelton.github.io/melton-snap/?job=964&me=alex&rooms=IDF+Room,Main+Elec,Floor+1,Site
```

| Param | Required | Notes |
|---|---|---|
| `job` | yes | Job number, used in filename routing |
| `me` | yes | Photographer name slug |
| `name` | no | Friendly job name shown in header |
| `rooms` | recommended | Comma-separated room labels for the dropdown |
| `tags` | no | Override default tag chips (Rough-In, Finish, etc.) |

## Architecture (v1)

- Single static HTML/JS/CSS bundle
- piexifjs (CDN) for EXIF read/write
- Service worker for offline shell cache
- Capture → embed metadata as JSON in EXIF UserComment → share via iOS share sheet
- Field guy picks "Save to OneDrive" share extension; photo lands in `JobsitePhotos-Inbox`
- Hub on PC scans the Inbox, parses filename, reads EXIF, routes to the correct workspace

## See also

- `PLAN.md` — full v1 build sequence and decisions
- Hub-side Progress Photos module: `C:\Users\aflores\hub\modules\progress-photos\` (Phase 1.3, not yet built)
