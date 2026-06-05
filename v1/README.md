# Melton Snap — v1 (frozen fallback)

This folder is a **frozen snapshot of the shipped, pre–Phase-2.0 Melton Snap**,
deployed at `https://afloresmelton.github.io/melton-snap/v1/`.

## Why it exists
Phase 2.0 turned the root app into a multi-module **field hub**. This page keeps
the proven single-purpose photo app reachable at a stable URL — an emergency
fallback if the hub at the root URL ever misbehaves on a field phone. Tell a
foreman to open the `/v1/` link and they get the exact app they already know.

## What it is
Byte-for-byte the v1 code (`index.html`, `app.js`, `styles.css`) extracted from
the last pre-refactor commit, plus a snapshot of `job-data/`. **Do not develop
here** — fix forward in the root hub instead.

## Deliberate deviations from the pure freeze
- `sw.js` — cache namespace changed to `snapv1-*` (was `melton-snap-v15`) with
  cleanup scoped to that prefix, so this SW and the root hub's SW never delete
  each other's caches (shared origin, overlapping `/melton-snap/` scope).
- `manifest` / `<title>` / apple title — labeled "v1" so installing it doesn't
  collide with the root hub's home-screen icon.

## MSAL note
The 1-tap "Upload to OneDrive" (MSAL direct upload) needs the redirect URI
`https://afloresmelton.github.io/melton-snap/v1/` registered in Azure to work
here. Until then, the **"Share to OneDrive"** (iOS share-sheet) path still works
on this page with no extra setup.
