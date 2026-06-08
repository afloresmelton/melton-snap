# Phase 2.3 — On-Phone End-to-End Test Checklist

**Goal:** prove the whole chain works on a real iPhone, in the installed PWA, signed in as a foreman: **build a request → submit → it uploads to OneDrive → the office hub ingests it → a draft order is created → the attached photo lands on the order (not Progress Photos).**

Everything below has been verified headless/local. This test exists to catch the things only a real device shows — chiefly the **iOS standalone-PWA sign-in redirect** (the load-bearing unknown), cache freshness, and OneDrive sync timing.

**How to use:** go top to bottom. Each test has an ID (T1, T2…), the action, what you should see, and a result box. If something fails, stop and capture the diagnostics noted in that step + §Diagnostics, then keep going if the rest can still be tested.

App URL: **https://afloresmelton.github.io/melton-snap/** • Pilot job: **964 / BP EV HUB** • Current build: **SW v27**

---

## Pre-flight — what you need

- [ ] An **iPhone** (this is the target platform; redirect auth is the iOS-specific risk).
- [ ] The foreman's **Microsoft 365 account** (the one that should own the OneDrive upload target).
- [ ] Access to the **desktop office hub** (`C:\Users\aflores\hub\`) on the PC, with OneDrive syncing the `Apps/Melton Snap` folder.
- [ ] *(Optional but gold)* a **Mac** on the same Apple ID — lets you use **Safari → Develop → [your iPhone] → Inspect** to read the PWA's real console. Without a Mac, you rely on in-app messages + screenshots.
- [ ] Decide the **test request contents** below so the office side has a known answer to verify against.

### Known-answer test data (use exactly this)
- **Item row (typed):** `3/4 emt conduit` → pick the top suggestion. *(Should be `3/4" EMT CONDUIT`.)* Qty **5**.
- **Assembly:** 🧰 Add from assembly → search `1/2 emt run` → pick **`1/2" EMT RUN - ON-CONC STRAP`** → run length **100**. *(Adds 7 lines: conduit 100, coupling 10, connector 2, strap 13, wedge anchor 13, hex nut 13, fender washer 13.)*
- **Urgency:** 🔴 Rush.
- **Note:** `E2E TEST <today's date> — please ignore` (so the office can spot + discard it).
- **Photo:** attach **1** photo (anything — a nameplate, a wall).

---

## Part A — Install & update (get v27 onto the phone)

- [ ] **T1 · Install.** Open the URL in **Safari** → Share → **Add to Home Screen** → open the app from the **home screen icon** (not Safari). 
      _Expect:_ launches full-screen (no Safari address bar). Header shows **Job 964 — BP EV HUB**.
- [ ] **T2 · Confirm it's v27** (feature proxy — there's no version label). 
      _Expect all three:_ (a) the **Photos / Materials** tabs are at the **top**, (b) on Materials, typing `3/4 emt conduit` puts **`3/4" EMT CONDUIT` first** in the dropdown, (c) **🧰 Add from assembly** button is visible. 
      _If any are missing:_ fully close the app (swipe up, swipe it away) and reopen — **twice** if needed. Still stale ⇒ note it (cache bug regressed) and capture §Diagnostics.

**A result:** ☐ pass ☐ fail — notes: ___________________________

---

## Part B — Sign in (MSAL redirect — the big one) 🔴 highest risk

> iOS standalone PWAs block popups, so this uses a **full-page redirect** to Microsoft and back. The failure mode to watch for: it bounces you out to **Safari**, you sign in *there*, but the **home-screen app stays signed out**. That's the thing we're testing.

- [ ] **T3 · Trigger sign-in.** With the request **not yet built**, you can trigger auth by submitting later (Part D) — OR if there's a visible sign-in affordance, tap it now. When it fires you'll briefly see **"Redirecting to Microsoft sign-in…"** then the page navigates to `login.microsoftonline.com`.
- [ ] **T4 · Complete sign-in.** Enter the foreman's M365 credentials; approve any consent prompt.
      _Expect:_ after sign-in it returns **into the home-screen app** (still full-screen, header intact) — **not** a Safari tab.
- [ ] **T5 · Returned context is correct.** Back in the app, you're signed in and whatever you'd queued is **still there** (not lost by the reload).
      _Capture on failure:_ screenshot the screen you land on + note the URL in the address bar if it opened Safari; note whether the app vs Safari is signed in.

**B result:** ☐ pass ☐ fail — Returned to: ☐ home-screen app ☐ Safari — notes: ______________

---

## Part C — Build the request (field side)

- [ ] **T6 · Typed item + ranked search.** Item row, type `3/4 emt conduit`. _Expect:_ `3/4" EMT CONDUIT` is **#1**; tap it; set qty **5**.
- [ ] **T7 · Assembly picker.** Tap **🧰 Add from assembly** → search `1/2 emt run` → tap **`1/2" EMT RUN - ON-CONC STRAP`**. _Expect:_ a **Run length (ft)** field; enter **100**; preview reads **"Adds 7 items"** with conduit **100** / coupling **10** / connector **2** / strap **13** / anchor **13** / nut **13** / washer **13**. Tap **Add to request**.
- [ ] **T8 · Rows landed.** The form now has the typed conduit **+ 7 assembly lines** (8 item rows total).
- [ ] **T9 · Urgency / note / photo.** Set **🔴 Rush**; type the **Note**; tap **Attach photo** and add **1** photo (camera or library). _Expect:_ a thumbnail appears on the form.

**C result:** ☐ pass ☐ fail — item rows seen: ____ — notes: ___________________________

---

## Part D — Submit, upload & resilience (the outbox)

- [ ] **T10 · One-press submit.** Tap **📤 Submit request**. _Expect:_ a single tap both **queues and starts uploading** (it calls the sync flush for you). If not signed in yet, this is what triggers Part B's redirect — complete sign-in, then it should **auto-resume** uploading on return.
- [ ] **T11 · Outbox tray.** While/after submitting, the **outbox tray** appears (thumbnails + a count) with an **Upload** button and a status line ("Uploading 1/2…"). _Expect:_ the count **drains to 0** and the tray empties (or hides) when done. The request JSON **and** the photo both upload.
- [ ] **T12 · Manual retry path exists.** If upload stalls, the tray's **Upload** button re-runs it; the **Share** button is the fallback (push the files via the iOS share sheet into OneDrive) if direct upload won't go.
- [ ] **T13 · Durability across kill.** Build a *second* tiny request (one item, no photo), tap Submit, then **immediately force-quit the app** before it finishes. Reopen. _Expect:_ the tray **rehydrates** with the pending item and auto-resumes (nothing lost).
- [ ] **T14 · Offline → online.** Turn on **Airplane Mode**, build a request, Submit. _Expect:_ it **queues** (tray shows it, no error). Turn Airplane Mode off / reopen. _Expect:_ it uploads on its own (or with one Upload tap).

**D result:** ☐ pass ☐ fail — tray drained to 0: ☐ — survived force-quit: ☐ — offline queue: ☐ — notes: ______

---

## Part E — Office ingest (desktop hub)

> Allow a moment for **OneDrive to sync** the uploaded files down to the PC before the hub can see them.

- [ ] **T15 · Files landed in OneDrive.** On the PC, confirm the request artifacts appear under the OneDrive **`Apps/Melton Snap`** folder (a `matreq…json` and an `MRQ964__…jpg`). _(This isolates "did the phone upload" from "did the hub ingest.")_
- [ ] **T16 · Open the inbox module.** Launch the office hub → open **Material Requests** (`material-request-inbox`). Let it sync/scan.
- [ ] **T17 · Request appears in the log.** _Expect:_ a row for your test request — correct **Job (964)**, **requester**, **item count (8)**, **Rush**, your **Note**, and **Status = "No order created."**

**E result:** ☐ pass ☐ fail — appeared in log: ☐ — fields correct: ☐ — notes: ___________________________

---

## Part F — Create order + photo routing

- [ ] **T18 · Create New Order.** On the request row, click **Create New Order**. _Expect:_ a **draft Material Order** is minted from the request and you're dropped into it; the row's status flips to **Draft**.
- [ ] **T19 · Lines mapped.** The draft order contains the 8 items with quantities matching T6–T7 (conduit 5, plus the 7 assembly lines).
- [ ] **T20 · Photo is on the ORDER (the key routing test).** Back in the Material Requests log, the request row has a **📷** button — click it. _Expect:_ a lightbox shows your attached photo, read from the **order's attachments** — i.e. the photo travelled **with the order**.
- [ ] **T21 · Photo did NOT go to Progress Photos.** Open the **Progress Photos** module and confirm your test photo is **not** sitting in its inbox/queue (the `MRQ…` tag makes Progress Photos skip it). 
      _Note the race:_ if Progress Photos happened to scan first, the photo may show as "in Progress Photos" instead — if so, record the order you ran the two modules in.

**F result:** ☐ pass ☐ fail — order created: ☐ — lines correct: ☐ — photo on order: ☐ — skipped by Progress Photos: ☐ — notes: ______

---

## Part G — Cleanup

- [ ] **T22 · Discard the test.** Delete the test draft order (and the test photo) so the pilot data stays clean. Note: deleting the order leaves a `…source.json` behind by design (so it can be re-created) — that's expected.

---

## Diagnostics — what to capture when something fails

For **any** failed test, record: **test ID**, **time**, **exactly what you tapped**, and a **screenshot** of the unexpected screen.

- **Sign-in (B) failures:** screenshot the page you land on; note whether the **home-screen app** or **Safari** ended up signed in; note the address-bar URL if it left the PWA. This is the most important data point of the whole test.
- **Console (if you have a Mac):** Safari → Preferences → Advanced → "Show Develop menu"; on iPhone enable Settings → Safari → Advanced → **Web Inspector**; connect via cable; Mac Safari → **Develop → [iPhone] → [the PWA]** → Console + Network tabs. Copy any red errors and the failing request URL/status.
- **Upload (D) failures:** screenshot the **outbox tray** + its status line; note the count that's stuck.
- **Ingest (E) failures:** check the OneDrive `Apps/Melton Snap` folder first (T15) — if files are there but the hub doesn't show them, it's a hub-scan/sync issue, not an upload issue. Note which.

---

## Known high-risk items (most likely to fail, and why)

1. **iOS redirect auth (B)** — standalone PWAs can break auth out to Safari and not return the token to the installed app. *If this fails, it's the #1 thing to fix before going past the pilot* — and it likely forces the **MSAL app-registration in Melton's real M365 tenant** (§8 of the plan).
2. **Token persistence after app close** — you may have to re-sign-in each cold launch; note if so.
3. **Outbox surviving the sign-in redirect (T5/T13)** — the page reloads mid-sign-in; the durable IndexedDB outbox should carry the queued request + photo blob through. Watch for a lost item.
4. **Cache freshness (T2)** — if the phone won't show v27 even after closing twice, the SW update path needs another look.
5. **OneDrive sync latency (E)** — the office hub reads the *local* OneDrive sync folder; there can be a real delay between upload and the file appearing on the PC. Wait before calling it a failure.
6. **Photo race (T21)** — sync the **Material Requests** module before Progress Photos to guarantee the order claims the photo.

---

## Result summary

| Part | Result | Blocking issue (if any) |
|---|---|---|
| A — Install & v27 | ☐ pass ☐ fail | |
| B — Sign-in redirect | ☐ pass ☐ fail | |
| C — Build request | ☐ pass ☐ fail | |
| D — Submit & outbox | ☐ pass ☐ fail | |
| E — Office ingest | ☐ pass ☐ fail | |
| F — Order + photo | ☐ pass ☐ fail | |

**Overall:** ☐ full round-trip works ☐ works with caveats ☐ blocked

**Tester:** ____________  **Date:** ____________  **Phone / iOS:** ____________
