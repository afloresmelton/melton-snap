'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Module #2 — Field Materials Request (Phase 2.1)
//
// The capture half of the office Material Order module. A foreman lists what
// they need, optionally snaps a nameplate, and submits — the request becomes
// a `matreq__*.json` record dropped through the SAME shell.sync outbox photos
// use. This is what proves the bridge carries structured records, not just
// binary (FIELD-HUB-PLAN §3, §7).
//
// It composes the shell, it doesn't reinvent it: shell.capture for photos,
// shell.sync for upload, shell.job for who/where. Data contract = §7.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  const U = shell.util;
  const esc = U.escapeAttr;

  // ── Module state (what can't live in the DOM) ───────────────────────────
  let attachments = [];      // [{ file, name, url }] nameplate photos, pre-submit
  let catalogUnits = {};     // lower(description) -> unit, for unit auto-fill
  let catalog = [];          // [{ description, unit, search, dn }] for the catalog picker
  let assemblies = [];       // [{ id, name, group, lines[], flat?, _search }] kits
  let asmGroups = [];        // distinct top-level groups (for filter chips)
  let asmById = new Map();   // id -> assembly, for resolving kit `ref` lines at runtime
  let asmGroup = '';         // active group filter ('' = all)
  let asmCurrent = null;     // assembly being configured
  let urgency = 'normal';    // 'normal' | 'rush'
  let photoTarget = null;    // { kind:'general' } | { kind:'item', row } — where the next photo lands
  let photoFileInput = null; // shared hidden <input type=file> behind the photo chooser

  // ── Mount: render the form + wire it ────────────────────────────────────
  function mount(root) {
    root.innerHTML = `
      <section class="field">
        <h2 class="module-title">Materials Request</h2>
        <p class="hint module-sub">Tell the office what you need on this job. It queues with your photos and uploads together.</p>
      </section>

      <section class="field mr-actions">
        <button type="button" id="mrLists" class="mr-tool-btn">📋 Saved Lists</button>
        <button type="button" id="mrSent" class="mr-tool-btn">🕓 Previous Orders</button>
      </section>

      <section class="field">
        <label for="mrListName">List name <span id="mrSaved" class="mr-saved"></span></label>
        <input id="mrListName" class="mr-listname" type="text" placeholder="Untitled list" autocomplete="off" aria-label="List name">
      </section>

      <section class="field">
        <label>Items</label>
        <div id="mrItems" class="mr-items"></div>
        <div class="mr-add-row">
          <button type="button" id="mrAddItem" class="ghost-link mr-add">＋ Add item</button>
          <button type="button" id="mrAddCat" class="ghost-link mr-add" hidden>📚 Add from catalog</button>
          <button type="button" id="mrAddAsm" class="ghost-link mr-add" hidden>🧰 Add from assembly</button>
          <button type="button" id="mrAddWire" class="ghost-link mr-add" hidden>⚡ Wire order</button>
        </div>
      </section>

      <section class="field mr-two-col">
        <div>
          <label for="mrNeededBy">Needed by <span class="label-aside">— optional</span></label>
          <input id="mrNeededBy" type="date">
        </div>
        <div>
          <label>Urgency</label>
          <div id="mrUrgency" class="chip-row">
            <button type="button" class="chip active" data-urgency="normal">Normal</button>
            <button type="button" class="chip" data-urgency="rush">🔴 Rush</button>
          </div>
        </div>
      </section>

      <section class="field">
        <label for="mrNote">Note <span class="label-aside">— optional</span></label>
        <input id="mrNote" type="text" maxlength="200" placeholder="Anything the office should know…" autocomplete="off">
      </section>

      <section class="field">
        <label>Photos <span class="label-aside">— optional, e.g. a nameplate</span></label>
        <div id="mrPhotos" class="mr-photos"></div>
        <button type="button" id="mrAttach" class="ghost-link mr-add">📷 Attach photo</button>
      </section>

      <button id="mrSubmit" class="shutter" disabled>
        <span class="shutter-icon">📤</span>
        <span class="shutter-label">Submit request</span>
      </button>
      <p id="mrStatus" class="hint"></p>

      <div id="mrCat" class="mr-asm" hidden>
        <div class="mr-asm-card">
          <div class="mr-asm-head">
            <strong>Add from catalog</strong>
            <button type="button" id="mrCatClose" class="ghost-link">✕</button>
          </div>
          <div class="mr-cat-body">
            <input id="mrCatSearch" type="search" placeholder="Search items — e.g. 3/4 EMT, oct box, lug…" autocomplete="off">
            <div id="mrCatResults" class="mr-asm-results"></div>
          </div>
        </div>
      </div>

      <div id="mrDrafts" class="mr-asm" hidden>
        <div class="mr-asm-card">
          <div class="mr-asm-head">
            <strong>Saved Lists</strong>
            <button type="button" id="mrDraftsClose" class="ghost-link">✕</button>
          </div>
          <div class="mr-cat-body">
            <button type="button" id="mrNewList" class="mr-photo-opt">＋ New list</button>
            <div id="mrDraftsList" class="mr-asm-results"></div>
          </div>
        </div>
      </div>

      <div id="mrSentSheet" class="mr-asm" hidden>
        <div class="mr-asm-card">
          <div class="mr-asm-head">
            <strong>Previous Orders</strong>
            <button type="button" id="mrSentClose" class="ghost-link">✕</button>
          </div>
          <div class="mr-cat-body">
            <div id="mrSentList" class="mr-asm-results"></div>
          </div>
        </div>
      </div>

      <div id="mrWire" class="mr-asm" hidden>
        <div class="mr-asm-card">
          <div class="mr-asm-head">
            <button type="button" id="mrWireBack" class="ghost-link" hidden>←</button>
            <strong id="mrWireTitle">Wire Order</strong>
            <button type="button" id="mrWireClose" class="ghost-link">✕</button>
          </div>
          <div id="mrWireMode" class="mr-photo-opts">
            <button type="button" class="mr-photo-opt" data-wmode="feeder">🔌 Feeder wire <span class="mr-opt-sub">cut lengths, by pull</span></button>
            <button type="button" class="mr-photo-opt" data-wmode="branch">🔀 Branch wire <span class="mr-opt-sub">full spools</span></button>
          </div>
          <div id="mrWireForm" class="mr-wire-form" hidden></div>
        </div>
      </div>

      <div id="mrConfirm" class="mr-confirm" hidden>
        <div class="mr-confirm-box">
          <p id="mrConfirmMsg" class="mr-confirm-msg"></p>
          <div class="mr-confirm-btns">
            <button type="button" id="mrConfirmCancel" class="mr-confirm-cancel">Cancel</button>
            <button type="button" id="mrConfirmOk" class="mr-confirm-ok">Delete</button>
          </div>
        </div>
      </div>

      <div id="mrPhotoSheet" class="mr-asm" hidden>
        <div class="mr-asm-card">
          <div class="mr-asm-head">
            <strong id="mrPhotoTitle">Add a photo</strong>
            <button type="button" id="mrPhotoClose" class="ghost-link">✕</button>
          </div>
          <div class="mr-photo-opts">
            <button type="button" id="mrPhotoLib" class="mr-photo-opt">🖼️ Choose or take a photo</button>
            <button type="button" id="mrPhotoPaste" class="mr-photo-opt">📋 Paste a screenshot</button>
            <p id="mrPhotoHint" class="hint" hidden></p>
          </div>
        </div>
      </div>

      <div id="mrAsm" class="mr-asm" hidden>
        <div class="mr-asm-card">
          <div class="mr-asm-head">
            <button type="button" id="mrAsmBack" class="ghost-link" hidden>←</button>
            <strong id="mrAsmTitle">Add from assembly</strong>
            <button type="button" id="mrAsmClose" class="ghost-link">✕</button>
          </div>
          <div id="mrAsmListView">
            <input id="mrAsmSearch" type="search" placeholder="Search assemblies — e.g. 3/4 EMT, duplex…" autocomplete="off">
            <div id="mrAsmGroups" class="chip-row"></div>
            <div id="mrAsmResults" class="mr-asm-results"></div>
          </div>
          <div id="mrAsmConfig" hidden></div>
        </div>
      </div>`;

    injectAutoStyles();
    document.getElementById('mrAddItem').addEventListener('click', () => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();  // commit pending text into the field it's in
      const prev = document.querySelector('#mrItems .mr-item:last-child');
      const row = addItemRow();
      clearAutofill(row, prev);                                                                  // don't let the new row copy the one above
      setTimeout(() => row.querySelector('.mr-qty').focus(), 0);
    });
    document.getElementById('mrAttach').addEventListener('click', onAttach);
    document.getElementById('mrSubmit').addEventListener('click', onSubmit);
    document.getElementById('mrUrgency').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#mrUrgency .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      urgency = chip.dataset.urgency;
      autosave();
    });

    document.getElementById('mrAddAsm').addEventListener('click', openAsm);
    document.getElementById('mrAsmClose').addEventListener('click', closeAsm);
    document.getElementById('mrAsmBack').addEventListener('click', showAsmList);
    document.getElementById('mrAsmSearch').addEventListener('input', renderAsmResults);
    document.getElementById('mrAsmResults').addEventListener('click', onAsmPick);
    document.getElementById('mrAsmGroups').addEventListener('click', onAsmGroup);

    document.getElementById('mrAddCat').addEventListener('click', openCat);
    document.getElementById('mrCatClose').addEventListener('click', closeCat);
    document.getElementById('mrCatSearch').addEventListener('input', renderCatResults);
    document.getElementById('mrCatResults').addEventListener('click', onCatPick);

    document.getElementById('mrAddWire').addEventListener('click', openWire);
    document.getElementById('mrWireClose').addEventListener('click', closeWire);
    document.getElementById('mrWireBack').addEventListener('click', showWireModes);
    document.getElementById('mrWireMode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-wmode]');
      if (b) startWireForm(b.dataset.wmode);
    });

    // Photo chooser, shared by the bottom "Attach photo" and each line's 📷:
    // one hidden file input (iOS shows Camera/Library/Files; desktop a file
    // dialog) + an explicit Paste button, plus a Ctrl+V listener for power users.
    photoFileInput = document.createElement('input');
    photoFileInput.type = 'file';
    photoFileInput.accept = 'image/*';
    photoFileInput.multiple = true;
    photoFileInput.style.display = 'none';
    photoFileInput.addEventListener('change', onPhotoFilePicked);
    root.appendChild(photoFileInput);
    root.addEventListener('paste', onPasteImage);

    document.getElementById('mrPhotoClose').addEventListener('click', closePhotoSheet);
    document.getElementById('mrPhotoLib').addEventListener('click', () => { closePhotoSheet(); photoFileInput.value = ''; photoFileInput.click(); });
    document.getElementById('mrPhotoPaste').addEventListener('click', pasteFromClipboard);

    // Running lists (drafts) + sent history
    document.getElementById('mrLists').addEventListener('click', openDrafts);
    document.getElementById('mrDraftsClose').addEventListener('click', closeDrafts);
    document.getElementById('mrNewList').addEventListener('click', newList);
    document.getElementById('mrDraftsList').addEventListener('click', onDraftsClick);
    document.getElementById('mrSent').addEventListener('click', openSent);
    document.getElementById('mrSentClose').addEventListener('click', closeSent);
    document.getElementById('mrSentList').addEventListener('click', onSentClick);
    document.getElementById('mrSentList').addEventListener('change', onSentChange);
    document.getElementById('mrConfirmCancel').addEventListener('click', closeConfirm);
    document.getElementById('mrConfirmOk').addEventListener('click', () => { const fn = _confirmYes; closeConfirm(); if (fn) fn(); });
    document.getElementById('mrConfirm').addEventListener('click', (e) => { if (e.target.id === 'mrConfirm') closeConfirm(); });

    // Tap the dark backdrop (anywhere outside the card) to dismiss any bottom
    // sheet — My lists, Sent orders, catalog, assembly, photo chooser.
    root.addEventListener('click', (e) => { if (e.target.classList && e.target.classList.contains('mr-asm')) e.target.hidden = true; });

    // Freeze the page behind any open sheet (iOS lets inner scrolling "chain"
    // to the page otherwise). A MutationObserver on `hidden` covers every
    // open/close path — ✕ buttons, backdrop taps, Add-and-close flows.
    sheetEls = [...root.querySelectorAll('.mr-asm, .mr-confirm')];
    const sheetObserver = new MutationObserver(() => {
      syncSheetLock();
      if (window.visualViewport) applyKeyboardFit(window.visualViewport.height, window.innerHeight);
    });
    sheetEls.forEach(el => sheetObserver.observe(el, { attributes: true, attributeFilter: ['hidden'] }));
    // Keyboard-aware sheet fit (see applyKeyboardFit) — reacts to the on-screen
    // keyboard shrinking the visual viewport.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => applyKeyboardFit(window.visualViewport.height, window.innerHeight));
    }
    root._kbFit = applyKeyboardFit;   // test/debug seam
    // Scrolling the search results dismisses the keyboard, so the search box
    // (and what you typed) snaps back into view while you browse options.
    for (const id of ['mrCatResults', 'mrAsmResults']) {
      const sc = document.getElementById(id);
      if (sc) sc.addEventListener('scroll', () => {
        const a = document.activeElement;
        if (a && (a.id === 'mrCatSearch' || a.id === 'mrAsmSearch')) a.blur();
      }, { passive: true });
    }

    // Auto-save the active running list as the foreman builds it
    document.getElementById('mrItems').addEventListener('input', (e) => {
      if (e.target.classList && e.target.classList.contains('mr-desc')) {
        const row = e.target.closest('.mr-item');
        const changed = row && normDesc(e.target.value) !== row._mergedDesc;
        // Only drop the "combined" cue if the description actually changed to a
        // DIFFERENT material — keep it through typo/case/whitespace fixes.
        if (row && (row._adds || 0) >= 2 && changed) clearCombined(row);
        // The pull name belongs to the wire it was ordered for: keep it through
        // a footage-only fix (230FT → 250FT), drop it if the material changes.
        if (row && row._note && changed) { row._note = ''; renderGroups(); }   // retyped to another material → detach from its pull
      }
      updateSubmit(); autosave();
    });
    document.getElementById('mrListName').addEventListener('input', autosave);
    document.getElementById('mrNeededBy').addEventListener('input', autosave);
    document.getElementById('mrNote').addEventListener('input', autosave);

    initDrafts();          // restore the active running list (or start a fresh one)
    renderAttachments();
    updateSubmit();
    loadCatalog();         // item autocomplete (graceful if absent)
    loadAssemblies();      // assembly kits (graceful if absent)
  }

  // ── Line items (DOM is the source of truth; state stays in the inputs) ───
  let _rowSeq = 0;
  // Defends against WebKit AUTOFILL copying the row above into a freshly-added
  // blank row (Safari treats same-type/same-name inputs as one field group and
  // pre-fills the new one — duplicating the line on "Add item" AND on Enter).
  // Unique per-row field names + autocomplete/autocorrect off break the
  // grouping; clearAutofill() is a cleanup guard if anything slips through.
  function addItemRow(desc, qty, afterRow) {
    const wrap = document.getElementById('mrItems');
    const row = document.createElement('div');
    row.className = 'mr-item';
    row._photos = [];          // [{ file, name, url }] photos linked to THIS line
    const seq = ++_rowSeq;
    // Quantity first, then Item Description, then 📷 (link a photo to this line)
    // and remove. No unit field — quantity + description is all we track.
    row.innerHTML = `
      <div class="mr-item-main">
        <input class="mr-qty" type="number" min="1" inputmode="numeric" name="mrq${seq}" autocomplete="off" value="${qty || ''}" placeholder="Qty" aria-label="Quantity">
        <input class="mr-desc" type="text" name="mrd${seq}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Item description" value="${esc(desc || '')}">
        <button type="button" class="mr-item-photo" aria-label="Attach a photo to this item" title="Attach a photo to this item — pick from your photos or paste a screenshot">📷</button>
        <button type="button" class="mr-del" aria-label="Remove item">✕</button>
      </div>
      <div class="mr-item-thumbs" hidden></div>
      <div class="mr-combined" hidden></div>`;
    if (afterRow && afterRow.parentNode === wrap) afterRow.after(row);
    else wrap.appendChild(row);

    row.querySelector('.mr-del').addEventListener('click', () => {
      (row._photos || []).forEach(p => p.url && URL.revokeObjectURL(p.url));
      row.remove();
      if (!wrap.querySelector('.mr-item')) addItemRow(); // always keep ≥1 row
      renderGroups();
      updateSubmit();
      autosave();
    });
    // Space (like Tab) jumps from the quantity box to the description.
    row.querySelector('.mr-qty').addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.code !== 'Space') return;
      e.preventDefault();
      row.querySelector('.mr-desc').focus();
    });
    const descEl = row.querySelector('.mr-desc');
    // Enter in the description adds the next line and jumps to its (blank) qty —
    // fast keyboard entry: qty → Space/Tab → desc → Enter → next qty → …
    descEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Blur FIRST so iOS commits any pending autocorrect into THIS field (it
      // already holds that text). Focusing the new row synchronously makes iOS
      // flush the buffer into the new row instead — which read as "the previous
      // item duplicated onto the next line" in the field.
      descEl.blur();
      const next = addItemRow(undefined, undefined, row);
      clearAutofill(next, row);
      setTimeout(() => next.querySelector('.mr-qty').focus(), 0);
      updateSubmit();
    });
    row.querySelector('.mr-item-photo').addEventListener('click', () => openPhotoSheet({ kind: 'item', row }));
    return row;
  }

  // Guard: a brand-new blank row should never carry the row-above's values. If
  // WebKit autofill pre-fills it to match `sourceRow`, wipe it (checked over a
  // few frames since the fill lands async). Equality-to-source means we only
  // clear an actual copy, never something the user just typed.
  function clearAutofill(newRow, sourceRow) {
    if (!newRow) return;
    const sq = sourceRow ? sourceRow.querySelector('.mr-qty').value : '';
    const sd = sourceRow ? sourceRow.querySelector('.mr-desc').value : '';
    const sweep = () => {
      const nq = newRow.querySelector('.mr-qty'), nd = newRow.querySelector('.mr-desc');
      if (!nq || !nd) return;
      if (document.activeElement !== nq && nq.value && nq.value === sq) nq.value = '';
      if (document.activeElement !== nd && nd.value && nd.value === sd) nd.value = '';
    };
    requestAnimationFrame(sweep);
    setTimeout(sweep, 80);
    setTimeout(sweep, 250);
  }

  // Add a material, but if a line with the SAME description already exists, sum
  // into it instead of appending a duplicate (so the list stays short and the
  // order shows one line per item — no scattered hex-nut lines).
  function normDesc(s) { return String(s || '').trim().replace(/\s+/g, ' ').toUpperCase(); }
  // note (e.g. a feeder pull name) is part of a line's identity: lines from
  // different pulls never merge, even with identical descriptions.
  function mergeItemRow(desc, qty, source, note) {
    const want = normDesc(desc);
    const wantNote = normDesc(note || '');
    const hit = want && [...document.querySelectorAll('#mrItems .mr-item')]
      .find(r => { const v = r.querySelector('.mr-desc').value; return v.trim() && normDesc(v) === want && normDesc(r._note || '') === wantNote; });
    if (hit) {
      const qEl = hit.querySelector('.mr-qty');
      qEl.value = (parseInt(qEl.value, 10) || 1) + (qty || 1);
      hit._adds = (hit._adds || 1) + 1;            // ≥2 contributions = consolidated line
      if (source !== 'assembly') hit._asmOnly = false;
      hit._mergedDesc = want;                      // the material this summed line represents
      markCombined(hit);
      return hit;
    }
    const row = addItemRow(desc, qty);
    row._adds = 1;
    row._asmOnly = (source === 'assembly');
    row._mergedDesc = want;
    row._note = note || '';
    return row;
  }
  // Feeder conductor rows carry note "<pull> · Set <n>"; parse it back to drive
  // the pull → set → conductor grouping headers in the items list.
  function parsePull(note) {
    const m = /^(.*?)\s*·\s*Set\s+(\d+)\s*$/.exec(note || '');
    if (m) return { pull: m[1].trim(), set: parseInt(m[2], 10) };
    const t = (note || '').trim();
    return { pull: t || null, set: t ? 1 : null };
  }
  // A feeder added with no pull name would slip past the header logic (an empty
  // pull reads as "no group" in renderGroups) and its conductors would render
  // loose. Auto-assign "Pull N" so they still group — N is the next free number
  // among existing auto-named pulls, so two unnamed adds don't merge together.
  function nextPlaceholderPull() {
    let max = 0;
    for (const r of document.querySelectorAll('#mrItems .mr-item')) {
      const m = /^Pull (\d+)$/.exec(parsePull(r._note).pull || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `Pull ${max + 1}`;
  }
  // Inject pull/set group headers above feeder rows and indent the conductors,
  // so the list reads: ⚡ Pull → Set N · <ft> ft → conductor rows. Pure display
  // (headers are .mr-grp, never .mr-item), rebuilt on any structural change.
  function renderGroups() {
    const wrap = document.getElementById('mrItems');
    if (!wrap) return;
    [...wrap.querySelectorAll('.mr-grp')].forEach(h => h.remove());
    let curPull = null, curSet = null;
    for (const row of [...wrap.querySelectorAll('.mr-item')]) {
      const { pull, set } = parsePull(row._note);
      row.classList.toggle('mr-item-child', !!pull);
      if (!pull) { curPull = null; curSet = null; continue; }
      if (pull !== curPull) {
        const h = document.createElement('div'); h.className = 'mr-grp mr-grp-pull'; h.textContent = '⚡ ' + pull;
        wrap.insertBefore(h, row); curPull = pull; curSet = null;
      }
      if (set !== curSet) {
        const ft = row.querySelector('.mr-qty').value;
        const hs = document.createElement('div'); hs.className = 'mr-grp mr-grp-set'; hs.textContent = 'Set ' + set + (ft ? ' · ' + ft + ' ft' : '');
        wrap.insertBefore(hs, row); curSet = set;
      }
    }
  }
  // Discrete "this line is a summed total" note on consolidated rows.
  function combinedText(asmOnly) { return asmOnly ? 'from multiple assemblies' : 'combined'; }
  function markCombined(row) {
    const el = row.querySelector('.mr-combined');
    if (!el) return;
    const combined = (row._adds || 0) >= 2;
    el.hidden = !combined;
    if (combined) el.textContent = combinedText(!!row._asmOnly);
  }
  function clearCombined(row) {            // editing a line's description resets its provenance
    if (!row) return;
    row._adds = 1; row._asmOnly = false;
    const el = row.querySelector('.mr-combined'); if (el) el.hidden = true;
  }

  function hasItems() {
    return [...document.querySelectorAll('#mrItems .mr-desc')].some(d => d.value.trim());
  }

  function updateSubmit() {
    document.getElementById('mrSubmit').disabled = !hasItems();
  }

  // Put the cursor in the first line's (blank) quantity box whenever Materials
  // is shown, so you can start typing a quantity immediately.
  function focusFirstQty() {
    const qty = document.querySelector('#mrItems .mr-qty');
    if (qty) { try { qty.focus(); } catch (e) {} }
  }

  // ── Photo attachments (held locally until submit) ───────────────────────
  // Both the bottom "Attach photo" and each line's 📷 open the same chooser.
  function onAttach() { openPhotoSheet({ kind: 'general' }); }

  function renderAttachments() {
    const wrap = document.getElementById('mrPhotos');
    if (!wrap) return;
    wrap.hidden = attachments.length === 0;
    wrap.innerHTML = attachments.map((a, i) =>
      `<div class="mr-photo"><img src="${a.url}" alt=""><button type="button" class="mr-photo-del" data-i="${i}" aria-label="Remove">✕</button></div>`
    ).join('');
    wrap.querySelectorAll('.mr-photo-del').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.i;
      const a = attachments[i];
      if (a && a.url) URL.revokeObjectURL(a.url);
      attachments.splice(i, 1);
      renderAttachments();
      autosave();
    }));
  }

  // ── Per-item photos (link a picture to one line; library or pasted) ───────
  // The general "Attach photo" above is request-level; these attach to a single
  // line. Renamed with the MRQ tag (same as general photos) so the office routes
  // them to the order, and each item also carries its own photos[] in the record.
  function renamePhoto(file) {
    const d = new Date();
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
    let ext = (file.type && file.type.split('/')[1]) || (file.name || '').split('.').pop() || 'jpg';
    ext = String(ext).toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg';
    return new File([file], `MRQ${shell.job.jobNo()}__${ts}__${nonce()}.${ext}`, { type: file.type || 'image/jpeg' });
  }
  function attachItemPhoto(row, file) {
    if (!row || !file) return;
    const named = renamePhoto(file);
    (row._photos = row._photos || []).push({ file: named, name: named.name, url: URL.createObjectURL(named) });
    renderItemThumbs(row);
    toast('Photo linked');
    autosave();
  }
  function renderItemThumbs(row) {
    const wrap = row.querySelector('.mr-item-thumbs');
    const photos = row._photos || [];
    wrap.hidden = photos.length === 0;
    const btn = row.querySelector('.mr-item-photo');
    if (btn) btn.classList.toggle('has', photos.length > 0);
    wrap.innerHTML = photos.map((p, i) =>
      `<div class="mr-photo"><img src="${p.url}" alt=""><button type="button" class="mr-photo-del" data-i="${i}" aria-label="Remove photo">✕</button></div>`
    ).join('');
    wrap.querySelectorAll('.mr-photo-del').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.i, p = row._photos[i];
      if (p && p.url) URL.revokeObjectURL(p.url);
      row._photos.splice(i, 1);
      renderItemThumbs(row);
      autosave();
    }));
  }
  // ── Photo chooser (shared by the general add + each line's 📷) ─────────────
  function openPhotoSheet(target) {
    photoTarget = target;
    document.getElementById('mrPhotoTitle').textContent = target.kind === 'item' ? 'Photo for this item' : 'Add a photo';
    const hint = document.getElementById('mrPhotoHint'); if (hint) hint.hidden = true;
    document.getElementById('mrPhotoSheet').hidden = false;
  }
  function closePhotoSheet() { document.getElementById('mrPhotoSheet').hidden = true; }

  // Normalize to a clean JPEG when possible (HEIC from the library, a PNG
  // screenshot); fall back to the original file if the browser can't decode it.
  async function normalizeImage(file) {
    try { return await shell.capture.reencodeAsJpeg(file); }
    catch (err) { shell.log(`Photo re-encode skipped: ${err.message}`); return file; }
  }
  function addPhotoToTarget(file, target) {
    const tgt = target || photoTarget;
    if (tgt && tgt.kind === 'item' && tgt.row && tgt.row.isConnected) {
      attachItemPhoto(tgt.row, file);
    } else {
      const named = renamePhoto(file);
      attachments.push({ file: named, name: named.name, url: URL.createObjectURL(named) });
      renderAttachments();
      toast('Photo added');
      autosave();
    }
  }
  async function onPhotoFilePicked() {
    const files = [...(photoFileInput.files || [])];
    photoFileInput.value = '';
    for (const f of files) addPhotoToTarget(await normalizeImage(f));
  }
  // Explicit "Paste a screenshot" — reads the clipboard on a tap (unlike Ctrl+V,
  // which needs a focused field). Graceful when the browser blocks/empties it.
  async function pasteFromClipboard() {
    const hint = document.getElementById('mrPhotoHint');
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('clipboard read unsupported');
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find(t => t.indexOf('image/') === 0);
        if (type) {
          const blob = await it.getType(type);
          addPhotoToTarget(await normalizeImage(new File([blob], 'pasted.png', { type })));
          closePhotoSheet();
          return;
        }
      }
      if (hint) { hint.hidden = false; hint.textContent = 'No image in the clipboard — copy a screenshot first, then tap Paste.'; }
    } catch (err) {
      if (hint) { hint.hidden = false; hint.textContent = 'Couldn’t read the clipboard here. On a computer, click a line and press Ctrl+V instead.'; }
      shell.log(`Clipboard paste failed: ${err.message}`);
    }
  }
  // Ctrl/Cmd+V on desktop: into the open chooser's target if the sheet is up,
  // else the focused line, else a general photo. Text pastes are untouched.
  function onPasteImage(e) {
    const data = e.clipboardData;
    if (!data) return;
    let img = null;
    for (const it of (data.items || [])) { if (it.type && it.type.indexOf('image/') === 0) { img = it.getAsFile(); break; } }
    if (!img) return;
    e.preventDefault();
    const sheetOpen = !document.getElementById('mrPhotoSheet').hidden;
    let target;
    if (sheetOpen && photoTarget) {
      target = photoTarget;
    } else {
      const ae = document.activeElement;
      const row = (ae && ae.closest) ? ae.closest('.mr-item') : null;
      target = row ? { kind: 'item', row } : { kind: 'general' };
    }
    normalizeImage(img).then(f => addPhotoToTarget(f, target));
    if (sheetOpen) closePhotoSheet();
  }

  // ── Sheet scroll containment + keyboard fit (iOS) ──────────────────────────
  // While any sheet/dialog is open the BODY is frozen with position:fixed
  // (preserving the scroll spot) so touch scrolling inside the sheet can't
  // move the page behind — iOS ignores overflow:hidden for touch, this works.
  let sheetEls = [];
  let _sheetLocked = false, _sheetScrollY = 0;
  function syncSheetLock() {
    const anyOpen = sheetEls.some(el => !el.hidden);
    if (anyOpen === _sheetLocked) return;
    const b = document.body.style;
    if (anyOpen) {
      _sheetScrollY = window.scrollY || 0;
      b.position = 'fixed'; b.top = `-${_sheetScrollY}px`; b.left = '0'; b.right = '0'; b.width = '100%';
    } else {
      b.position = ''; b.top = ''; b.left = ''; b.right = ''; b.width = '';
      window.scrollTo(0, _sheetScrollY);
    }
    _sheetLocked = anyOpen;
  }
  // When the on-screen keyboard shrinks the visual viewport, pin the OPEN sheet
  // to the top and cap its height to the space the keyboard leaves — so the
  // search box stays on screen instead of iOS panning it away.
  function applyKeyboardFit(vvHeight, layoutHeight) {
    const kb = !!vvHeight && (layoutHeight - vvHeight) > 140;   // keyboard likely up
    for (const el of sheetEls) {
      if (!el.classList.contains('mr-asm')) continue;
      const card = el.querySelector('.mr-asm-card');
      if (!card) continue;
      if (kb && !el.hidden) {
        el.classList.add('mr-kb');
        card.style.maxHeight = Math.max(220, vvHeight - 10) + 'px';
      } else {
        el.classList.remove('mr-kb');
        card.style.maxHeight = '';
      }
    }
  }

  // ── Toast: transient confirmation that shows ABOVE an open picker sheet ────
  function toast(msg) {
    let t = document.getElementById('mrToast');
    if (!t) { t = document.createElement('div'); t.id = 'mrToast'; t.className = 'mr-toast'; document.body.appendChild(t); }
    t.textContent = '✓ ' + msg;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show'); // restart the animation
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 1700);
  }

  // ── Submit → build §7 record, enqueue photos + JSON through shell.sync ───
  async function onSubmit() {
    // Build items straight from the rows so each line keeps its own photos[].
    // Consolidate duplicate materials (same description) into one summed line —
    // safety net for any dupes the live merge didn't catch (e.g. typed by hand),
    // so the hub/supply house always sees one line per item with the full qty.
    const byDesc = new Map();   // normDesc -> { description, qty, photos, rows, anyCombined, allAsm }
    for (const row of document.querySelectorAll('#mrItems .mr-item')) {
      const description = row.querySelector('.mr-desc').value.trim();
      if (!description) continue;
      const qty = Math.max(1, parseInt(row.querySelector('.mr-qty').value, 10) || 1);
      const photos = (row._photos || []).map(p => ({ name: p.name, file: p.file, url: p.url }));
      const rowCombined = (row._adds || 1) >= 2, rowAsmOnly = !!row._asmOnly;
      const note = (row._note || '').trim();
      // note (pull name) is part of the identity — different pulls never merge
      const key = normDesc(description) + '|' + normDesc(note);
      const prev = byDesc.get(key);
      if (prev) { prev.qty += qty; prev.photos.push(...photos); prev.rows += 1; prev.anyCombined = prev.anyCombined || rowCombined; prev.allAsm = prev.allAsm && rowAsmOnly; }
      else byDesc.set(key, { description, qty, photos, note, rows: 1, anyCombined: rowCombined, allAsm: rowAsmOnly });
    }
    const merged = [...byDesc.values()];
    if (!merged.length) return;
    // A line is "combined" if multiple rows merged at submit OR a row was already
    // consolidated live; note it so the order + Previous Orders show the cue.
    const noteFor = (c) => ((c.rows >= 2 || c.anyCombined) ? combinedText(c.allAsm) : '');
    const items = merged.map(c => ({ description: c.description, qty: c.qty, unit: '', note: c.note || '', photos: c.photos.map(p => p.name), combined_note: noteFor(c) }));
    const sentItems = merged.map(c => ({ description: c.description, qty: c.qty, note: c.note || '', photos: c.photos.map(p => ({ name: p.name, file: p.file })), received: false, received_at: null, combined_note: noteFor(c) }));
    const itemPhotoFiles = merged.flatMap(c => c.photos);

    // photos[] = general (request-level) + every line's linked photos.
    const generalPhotoMeta = attachments.map(a => ({ name: a.name, file: a.file }));
    const allPhotos = [...attachments.map(a => a.name), ...items.flatMap(it => it.photos)];
    const record = buildRecord(items, allPhotos);

    // Order name "<job> MR - <delivery MM-DD-YY> - <NN>" (e.g. "964 MR - 06-10-26 - 01")
    // — recognizable months later. NN = running count of sent requests for this
    // job; date = requested delivery (needed-by), else the send date. Stamped on
    // BOTH the uploaded record (so the office shows the SAME name) and the local
    // Sent-history entry below.
    const sentAt = new Date().toISOString();
    const sJob = shell.job.jobNo();
    let seq = 1;
    try { seq = (await dbAll('sent')).filter(s => String(s.jobNo) === String(sJob)).length + 1; } catch (e) {}
    const orderName = `${sJob} MR - ${fmtMMDDYY(record.needed_by || sentAt)} - ${String(seq).padStart(2, '0')}`;
    record.order_name = orderName;
    record.order_no = seq;

    // Photos first, so the JSON's photos[] reference files already queued.
    for (const a of attachments) {
      shell.sync.enqueue({ file: a.file, name: a.name, contentType: a.file.type || 'image/jpeg', thumbUrl: a.url, label: 'Materials photo' });
    }
    for (const p of itemPhotoFiles) {
      shell.sync.enqueue({ file: p.file, name: p.name, contentType: p.file.type || 'image/jpeg', thumbUrl: p.url, label: 'Item photo' });
    }
    // Ownership of the object URLs passes to the outbox — don't revoke here.
    attachments = [];

    const fname = buildReqName();
    const file = new File([JSON.stringify(record, null, 2)], fname, { type: 'application/json' });
    shell.sync.enqueue({
      file, name: fname, contentType: 'application/json', thumbUrl: null,
      label: `Request · ${items.length} item${items.length === 1 ? '' : 's'}`
    });

    shell.log(`Materials request queued: ${fname} (${items.length} items, ${allPhotos.length} photo(s))`);

    // Local Sent history — reference later + check off as materials arrive.
    try {
      await dbPut('sent', {
        id: mrId('s'), sent_at: sentAt, jobNo: sJob, order_no: seq,
        requester: shell.job.current().me, name: orderName,
        needed_by: record.needed_by || '', urgency, note: record.note || '',
        generalPhotos: generalPhotoMeta, items: sentItems
      });
    } catch (err) { shell.log(`Sent-history save failed: ${err.message}`); }

    // The active running list has been sent — drop it and start a fresh one.
    try { if (activeDraft) await dbDel('drafts', activeDraft.id); } catch (e) {}
    const fresh = newDraft();
    try { await dbPut('drafts', fresh); } catch (e) {}
    setActiveDraft(fresh);
    populateDraft(fresh);   // reset the form to the new empty list

    const status = document.getElementById('mrStatus');
    status.style.color = '#3fb950';
    status.textContent = '✓ Submitting to OneDrive…';

    // One press: send right away (uploads the whole outbox). If not signed in,
    // shell.sync.flush() redirects to Microsoft sign-in and auto-resumes on return.
    shell.sync.flush();
  }

  function buildRecord(items, photos) {
    const cfg = shell.job.current();
    return {
      schema: 1,
      type: 'material-request',
      job: cfg.job,
      requester: cfg.me,
      created_at: new Date().toISOString(),
      needed_by: document.getElementById('mrNeededBy').value || null,
      urgency,
      location: null,
      items,
      photos,
      note: document.getElementById('mrNote').value.trim(),
      status: 'submitted'
    };
  }

  function resetForm() {
    document.getElementById('mrItems').innerHTML = '';
    photoTarget = null;
    addItemRow();
    document.getElementById('mrNeededBy').value = '';
    document.getElementById('mrNote').value = '';
    urgency = 'normal';
    document.querySelectorAll('#mrUrgency .chip').forEach(c => c.classList.toggle('active', c.dataset.urgency === 'normal'));
    renderAttachments();
    updateSubmit();
  }

  // ── Filenames (routing keys; rest of the record is inside the JSON) ──────
  function buildReqName() {
    const compact = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, ''); // 20260605T083012
    return `matreq__${compact}__${nonce()}.json`;
  }
  function buildPhotoName() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    // MRQ tag = "this photo belongs to a material request." Office-side, the
    // Progress Photos mover SKIPS MRQ* files and the Material Requests ingest
    // attaches them to the order. (Progress-photo captures keep J<job>__.)
    return `MRQ${shell.job.jobNo()}__${hh}${mm}${ss}__${nonce()}.jpg`;
  }
  function nonce() { return Math.random().toString(36).slice(2, 6); }

  // ── Office→field catalogs (graceful 404 → free text) ────────────────────
  // These are COMPANY-WIDE master data published to /catalog/ (NOT per-job):
  // every job's field form reads the same items + assemblies. Re-publishing the
  // catalog (network-first in the SW) reaches phones on the next Materials open.
  function appBase() { return location.origin + location.pathname.replace(/[^/]*$/, ''); }

  async function loadCatalog() {
    const url = new URL('catalog/items.json', appBase());
    try {
      const res = await fetch(url.href);
      if (!res.ok) { shell.log(`No items catalog (HTTP ${res.status}) — free text only`); return; }
      const data = await res.json();
      catalogUnits = {};
      catalog = (data.items || []).filter(it => it && it.description).map(it => {
        const desc = String(it.description);
        if (it.unit) catalogUnits[desc.toLowerCase()] = it.unit;
        // search index = description + office-supplied keywords (synonyms), so a
        // foreman typing "one hole strap" finds the abbreviated "1-H STRAP".
        const search = (desc + ' ' + (it.keywords || '')).toLowerCase();
        // searchN = punctuation-normalized haystack used to MATCH (gate), so a
        // typed inch mark (straight " OR an iOS smart-quote ") and "1 in" / "1"
        // all collapse to the same tokens and still find the item.
        const searchN = search.replace(/[^a-z0-9]+/g, ' ').trim();
        // dn = punctuation-normalized description used to RANK matches
        // ('3/4" EMT CONDUIT' -> '3 4 emt conduit') so an exact/tight hit wins
        // even though the search index also matches keywords.
        const dn = desc.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return { description: desc, unit: it.unit || '', search, searchN, dn };
      });
      const btn = document.getElementById('mrAddCat');
      if (btn && catalog.length) btn.hidden = false;   // reveal the catalog picker
      buildWireIndex();                                // sizes for the Wire Order wizard
      shell.log(`✓ Items catalog: ${catalog.length} entries`);
    } catch (err) {
      shell.log(`Items catalog load failed: ${err.message}`);
    }
  }

  // ── Catalog picker (searchable; add tapped items as line rows) ────────────
  // Ranked search over the catalog: AND-of-terms across the search index
  // (description + office keyword synonyms, so "one hole strap" finds the
  // abbreviated "1-H STRAP"), then scored so the tightest description match is #1.
  function rankCatalog(q) {
    const terms = q.split(/\s+/);
    const qn = q.replace(/[^a-z0-9]+/g, ' ').trim();              // normalized query (for ranking)
    const termsN = terms.map(t => t.replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);  // gate on these
    const nTerms = termsN.length;
    if (!nTerms) return [];                                       // query was only punctuation
    const matches = [];
    for (let i = 0; i < catalog.length; i++) {
      const s = catalog[i].searchN;                              // punctuation-normalized haystack
      let ok = true;
      for (let t = 0; t < nTerms; t++) { if (s.indexOf(termsN[t]) < 0) { ok = false; break; } }
      if (ok) matches.push(catalog[i]);
    }
    for (let i = 0; i < matches.length; i++) {
      const dn = matches[i].dn || '';
      let sc = 0;
      if (dn === qn) sc += 1000;                       // exact description (punctuation-insensitive)
      else if (dn.indexOf(qn) === 0) sc += 300;        // description starts with the query
      else if (qn && dn.indexOf(qn) >= 0) sc += 150;   // query appears contiguously in the desc
      let inDesc = 0;
      for (let t = 0; t < termsN.length; t++) { if (dn.indexOf(termsN[t]) >= 0) inDesc++; }
      sc += inDesc * 30;                               // each query word found in the DESCRIPTION
      if (termsN.length && inDesc === termsN.length) sc += 60; // ALL words in desc (vs keyword-only)
      const dWords = dn ? dn.split(' ').length : 0;
      sc -= Math.max(0, dWords - nTerms) * 12;         // looser match (extra words) ranks lower
      matches[i]._sc = sc;
    }
    matches.sort((a, b) => b._sc - a._sc);
    return matches;
  }

  function openCat() {
    document.getElementById('mrCat').hidden = false;
    renderCatResults();
    const s = document.getElementById('mrCatSearch');
    if (s) setTimeout(() => s.focus(), 50);
  }
  function closeCat() { document.getElementById('mrCat').hidden = true; }
  function renderCatResults() {
    const body = document.getElementById('mrCatResults');
    const q = (document.getElementById('mrCatSearch').value || '').trim().toLowerCase();
    if (!q) {
      body._hits = [];
      body.innerHTML = `<p class="hint" style="text-align:left">Type to search ${catalog.length.toLocaleString()} catalog items.</p>`;
      return;
    }
    const hits = rankCatalog(q).slice(0, 50);
    body._hits = hits;
    if (!hits.length) { body.innerHTML = '<p class="hint" style="text-align:left">No matching items.</p>'; return; }
    body.innerHTML = hits.map((it, i) =>
      `<div class="mr-asm-row" data-i="${i}"><div class="mr-asm-name">${esc(it.description)}</div>${it.unit ? `<div class="mr-asm-meta">${esc(it.unit)}</div>` : ''}</div>`
    ).join('');
  }
  function onCatPick(e) {
    const row = e.target.closest('.mr-asm-row');
    if (!row) return;
    const body = document.getElementById('mrCatResults');
    const hit = body._hits && body._hits[+row.dataset.i];
    if (!hit) return;
    // Drop a single empty starter row so the first pick reads clean; keep the
    // sheet open so the foreman can add several items in a row.
    const rows = [...document.querySelectorAll('#mrItems .mr-item')];
    if (rows.length === 1 && !rows[0].querySelector('.mr-desc').value.trim()) rows[0].remove();
    mergeItemRow(hit.description, 1, 'catalog');
    updateSubmit();
    toast(`Added "${hit.description}"`);
    autosave();
  }

  // ── Wire Order wizard (feeder cuts by pull / branch spools) ───────────────
  // Color is an ORDER-TIME attribute — the catalog deliberately has no colored
  // wire items. The wizard picks one size/type/material and fans out one line
  // per color. Feeder: "<ft>FT - <size> <type> <mat> <COLOR>", qty = parallel
  // sets, grouped under a pull name carried as the line note (so different
  // pulls never merge). Branch: "<spool>FT SPOOL - ...", qty = spools per color.
  const WIRE_SYSTEMS = {
    '120/208': ['BLACK', 'RED', 'BLUE', 'WHITE', 'GREEN'],
    '277/480': ['BROWN', 'PURPLE', 'YELLOW', 'GRAY', 'GREEN']
  };
  const WIRE_SWATCH = { BLACK: '#222', RED: '#d22', BLUE: '#26d', WHITE: '#eee', GREEN: '#2a2', BROWN: '#85432a', PURPLE: '#92d', YELLOW: '#dc2', GRAY: '#999' };
  const WIRE_SIZE_ORDER = ['#18', '#16', '#14', '#12', '#10', '#8', '#6', '#4', '#3', '#2', '#1', '#1/0', '#2/0', '#3/0', '#4/0', '#250MCM', '#300MCM', '#350MCM', '#400MCM', '#500MCM', '#600MCM', '#700MCM', '#750MCM', '#1000MCM'];
  let wireIndex = null;       // 'THHN|CU' -> [sizes…] derived from the catalog
  let wire = null;            // active wizard state

  function buildWireIndex() {
    const idx = {};
    for (const it of catalog) {
      const m = /^(#\S+)\s+(THHN|XHHW)(\s+AL)?$/.exec(String(it.description).trim().toUpperCase());
      if (!m) continue;
      const key = m[2] + '|' + (m[3] ? 'AL' : 'CU');
      (idx[key] = idx[key] || new Set()).add(m[1]);
    }
    for (const k of Object.keys(idx)) {
      idx[k] = [...idx[k]].sort((a, b) => {
        const ia = WIRE_SIZE_ORDER.indexOf(a), ib = WIRE_SIZE_ORDER.indexOf(b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      });
    }
    wireIndex = idx;
    const btn = document.getElementById('mrAddWire');
    if (btn && Object.keys(idx).length) btn.hidden = false;
  }

  function openWire() {
    document.getElementById('mrWire').hidden = false;
    // Resume a form dismissed mid-entry (backdrop tap / ✕) instead of wiping it.
    // Completed adds null `wire`, so those reopen at the mode chooser; the
    // childElementCount guard covers a module remount (state without DOM).
    const form = document.getElementById('mrWireForm');
    if (wire && form.childElementCount) {
      document.getElementById('mrWireMode').hidden = true;
      form.hidden = false;
      document.getElementById('mrWireBack').hidden = false;
      document.getElementById('mrWireTitle').textContent = wire.mode === 'feeder' ? 'Feeder wire' : 'Branch wire';
    } else showWireModes();
  }
  function closeWire() { document.getElementById('mrWire').hidden = true; }
  function showWireModes() {
    document.getElementById('mrWireMode').hidden = false;
    document.getElementById('mrWireForm').hidden = true;
    document.getElementById('mrWireBack').hidden = true;
    document.getElementById('mrWireTitle').textContent = 'Wire Order';
    wire = null;
  }
  function startWireForm(mode) {
    wire = {
      mode,                                    // 'feeder' | 'branch'
      system: '120/208',
      colors: new Set(WIRE_SYSTEMS['120/208']),
      type: 'THHN',   // default to THHN CU for both feeder and branch; XHHW still one tap away
      mat: 'CU',
      size: null,                              // phase & neutral
      groundSize: null,                        // EGC (green) — sized separately (NEC 250.122)
      pull: '', cutFt: '', sets: 1,            // feeder
      spool: 500, spools: 1                    // branch
    };
    document.getElementById('mrWireMode').hidden = true;
    document.getElementById('mrWireForm').hidden = false;
    document.getElementById('mrWireBack').hidden = false;
    document.getElementById('mrWireTitle').textContent = mode === 'feeder' ? 'Feeder wire' : 'Branch wire';
    renderWireForm();
  }

  function renderWireForm() {
    const f = document.getElementById('mrWireForm');
    const sysChips = Object.keys(WIRE_SYSTEMS).map(s =>
      `<button type="button" class="chip${wire.system === s ? ' active' : ''}" data-wsys="${esc(s)}">${esc(s)}</button>`).join('');
    f.innerHTML =
      `<div class="field"><label>Voltage system</label><div class="chip-row" id="mrWireSys">${sysChips}</div></div>` +
      `<div class="field"><label>Colors</label><div class="chip-row" id="mrWireColors"></div></div>` +
      `<div class="field mr-two-col">
         <div><label>Type</label><div class="chip-row" id="mrWireType">
           <button type="button" class="chip${wire.type === 'THHN' ? ' active' : ''}" data-wtype="THHN">THHN</button>
           <button type="button" class="chip${wire.type === 'XHHW' ? ' active' : ''}" data-wtype="XHHW">XHHW</button></div></div>
         <div><label>Material</label><div class="chip-row" id="mrWireMat">
           <button type="button" class="chip${wire.mat === 'CU' ? ' active' : ''}" data-wmat="CU">Copper</button>
           <button type="button" class="chip${wire.mat === 'AL' ? ' active' : ''}" data-wmat="AL">Aluminum</button></div></div>
       </div>` +
      `<div class="field"><label>${wire.mode === 'feeder' ? 'Phase & neutral size' : 'Size'}</label><div class="chip-row mr-wire-sizes" id="mrWireSizes"></div></div>` +
      (wire.mode === 'feeder'
        ? `<div class="field"><label>Ground (green) size <span class="label-aside">— sized separately</span></label><div class="chip-row mr-wire-sizes" id="mrWireGround"></div></div>
           <div class="field"><label for="mrWirePull">Pull name</label><input id="mrWirePull" type="text" placeholder="e.g. PANEL LP-1 FEEDER" autocomplete="off"></div>
           <div class="field mr-two-col">
             <div><label for="mrWireCut">Cut length (ft)</label><input id="mrWireCut" type="number" inputmode="numeric" min="1" placeholder="e.g. 230"></div>
             <div><label for="mrWireSets">Parallel sets</label><input id="mrWireSets" type="number" inputmode="numeric" min="1" value="1"></div>
           </div>`
        : `<div class="field mr-two-col">
             <div><label>Spool</label><div class="chip-row" id="mrWireSpool">
               <button type="button" class="chip active" data-wspool="500">500 ft</button>
               <button type="button" class="chip" data-wspool="1000">1000 ft</button></div></div>
             <div><label for="mrWireSpools">Spools per color</label><input id="mrWireSpools" type="number" inputmode="numeric" min="1" value="1"></div>
           </div>`) +
      `<div id="mrWirePreview" class="mr-asm-preview"></div>` +
      `<button type="button" id="mrWireAdd" class="shutter" disabled><span class="shutter-label">Add to request</span></button>`;

    f.querySelector('#mrWireSys').addEventListener('click', (e) => {
      const c = e.target.closest('[data-wsys]'); if (!c) return;
      wire.system = c.dataset.wsys;
      wire.colors = new Set(WIRE_SYSTEMS[wire.system]);
      [...f.querySelectorAll('#mrWireSys .chip')].forEach(x => x.classList.toggle('active', x.dataset.wsys === wire.system));
      renderWireColors(); updateWirePreview();
    });
    f.querySelector('#mrWireType').addEventListener('click', (e) => {
      const c = e.target.closest('[data-wtype]'); if (!c) return;
      wire.type = c.dataset.wtype;
      [...f.querySelectorAll('#mrWireType .chip')].forEach(x => x.classList.toggle('active', x.dataset.wtype === wire.type));
      renderWireSizes(); renderWireGroundSizes(); updateWirePreview();
    });
    f.querySelector('#mrWireMat').addEventListener('click', (e) => {
      const c = e.target.closest('[data-wmat]'); if (!c) return;
      wire.mat = c.dataset.wmat;
      [...f.querySelectorAll('#mrWireMat .chip')].forEach(x => x.classList.toggle('active', x.dataset.wmat === wire.mat));
      renderWireSizes(); renderWireGroundSizes(); updateWirePreview();
    });
    if (wire.mode === 'feeder') {
      f.querySelector('#mrWirePull').addEventListener('input', (e) => { wire.pull = e.target.value; updateWirePreview(); });
      f.querySelector('#mrWireCut').addEventListener('input', (e) => { wire.cutFt = e.target.value; updateWirePreview(); });
      f.querySelector('#mrWireSets').addEventListener('input', (e) => { wire.sets = parseInt(e.target.value, 10); updateWirePreview(); });
    } else {
      f.querySelector('#mrWireSpool').addEventListener('click', (e) => {
        const c = e.target.closest('[data-wspool]'); if (!c) return;
        wire.spool = +c.dataset.wspool;
        [...f.querySelectorAll('#mrWireSpool .chip')].forEach(x => x.classList.toggle('active', +x.dataset.wspool === wire.spool));
        updateWirePreview();
      });
      f.querySelector('#mrWireSpools').addEventListener('input', (e) => { wire.spools = parseInt(e.target.value, 10); updateWirePreview(); });
    }
    f.querySelector('#mrWireAdd').addEventListener('click', addWire);
    renderWireColors();
    renderWireSizes();
    renderWireGroundSizes();
    updateWirePreview();
  }

  function renderWireColors() {
    const el = document.getElementById('mrWireColors');
    el.innerHTML = WIRE_SYSTEMS[wire.system].map(c =>
      `<button type="button" class="chip${wire.colors.has(c) ? ' active' : ''}" data-wcolor="${esc(c)}"><span class="mr-wdot" style="background:${WIRE_SWATCH[c] || '#888'}"></span>${esc(c)}</button>`).join('');
    if (!el._wired) {
      el._wired = true;
      el.addEventListener('click', (e) => {
        const c = e.target.closest('[data-wcolor]'); if (!c) return;
        const col = c.dataset.wcolor;
        if (wire.colors.has(col)) wire.colors.delete(col); else wire.colors.add(col);
        c.classList.toggle('active', wire.colors.has(col));
        updateWirePreview();
      });
    }
  }
  function renderWireSizes() {
    const el = document.getElementById('mrWireSizes');
    const sizes = (wireIndex && wireIndex[wire.type + '|' + wire.mat]) || [];
    if (wire.size && !sizes.includes(wire.size)) wire.size = null;
    el.innerHTML = sizes.length
      ? sizes.map(s => `<button type="button" class="chip${wire.size === s ? ' active' : ''}" data-wsize="${esc(s)}">${esc(s)}</button>`).join('')
      : '<p class="hint" style="text-align:left;margin:0">No catalog wire for this type/material.</p>';
    if (!el._wired) {
      el._wired = true;
      el.addEventListener('click', (e) => {
        const c = e.target.closest('[data-wsize]'); if (!c) return;
        wire.size = c.dataset.wsize;
        [...el.querySelectorAll('.chip')].forEach(x => x.classList.toggle('active', x.dataset.wsize === wire.size));
        updateWirePreview();
      });
    }
  }
  // Separate EGC (green) size picker — feeder only. Same catalog sizes; the
  // ground is typically smaller (NEC 250.122) so it's chosen on its own.
  function renderWireGroundSizes() {
    const el = document.getElementById('mrWireGround');
    if (!el) return;
    const sizes = (wireIndex && wireIndex[wire.type + '|' + wire.mat]) || [];
    if (wire.groundSize && !sizes.includes(wire.groundSize)) wire.groundSize = null;
    el.innerHTML = sizes.length
      ? sizes.map(s => `<button type="button" class="chip${wire.groundSize === s ? ' active' : ''}" data-wgnd="${esc(s)}">${esc(s)}</button>`).join('')
      : '<p class="hint" style="text-align:left;margin:0">No catalog wire for this type/material.</p>';
    if (!el._wired) {
      el._wired = true;
      el.addEventListener('click', (e) => {
        const c = e.target.closest('[data-wgnd]'); if (!c) return;
        wire.groundSize = c.dataset.wgnd;
        [...el.querySelectorAll('.chip')].forEach(x => x.classList.toggle('active', x.dataset.wgnd === wire.groundSize));
        updateWirePreview();
      });
    }
  }

  // The lines this wizard adds — one per selected color, in system order.
  function wireLines() {
    if (!wire || !wire.size || !wire.colors.size) return [];
    const base = `${wire.size} ${wire.type} ${wire.mat}`;
    const colors = WIRE_SYSTEMS[wire.system].filter(c => wire.colors.has(c));
    if (wire.mode === 'feeder') {
      const ft = parseInt(wire.cutFt, 10);
      if (!ft || ft < 1) return [];
      if (!(wire.sets >= 1)) return [];      // a typed 0/blank disables Add (no silent default)
      if (colors.includes('GREEN') && !wire.groundSize) return [];   // EGC needs its own size
      // One row PER PARALLEL SET, per color. Footage is the qty (not in the
      // description); pull + set drive the grouping headers. Green uses the
      // separate ground size; everything else uses the phase/neutral size.
      const out = [];
      const pull = wire.pull.trim() || nextPlaceholderPull();   // blank name → auto "Pull N" so it still groups
      for (let s = 1; s <= wire.sets; s++) for (const c of colors) {
        const sz = (c === 'GREEN') ? wire.groundSize : wire.size;
        out.push({ desc: `${sz} ${wire.type} ${wire.mat} ${c}`, qty: ft, pull, set: s });
      }
      return out;
    }
    if (!(wire.spools >= 1)) return [];
    return colors.map(c => ({ desc: `${wire.spool}FT SPOOL - ${base} ${c}`, qty: wire.spools, note: '' }));
  }
  function updateWirePreview() {
    const lines = wireLines();
    const el = document.getElementById('mrWirePreview');
    const btn = document.getElementById('mrWireAdd');
    if (!el || !btn) return;
    btn.disabled = !lines.length;
    if (!lines.length) {
      let hint;
      if (!wire.size) hint = (wire.mode === 'feeder' ? 'Pick a phase & neutral size.' : 'Pick a size.');
      else if (!wire.colors.size) hint = 'Pick at least one color.';
      else if (wire.mode === 'feeder' && wire.colors.has('GREEN') && !wire.groundSize) hint = 'Pick a ground (green) size.';
      else hint = (wire.mode === 'feeder' ? 'Enter the cut length and parallel sets.' : 'Enter spools per color.');
      el.innerHTML = `<p class="hint" style="text-align:left;margin:0">${hint}</p>`;
      return;
    }
    if (wire.mode === 'feeder') {
      const pull = lines[0].pull;   // already includes the auto "Pull N" placeholder when unnamed
      const ft = parseInt(wire.cutFt, 10);
      const colors = WIRE_SYSTEMS[wire.system].filter(c => wire.colors.has(c));
      let html = `<p class="hint" style="text-align:left;margin:0 0 6px">${esc(pull || 'Feeder pull')} — ${wire.sets} set${wire.sets === 1 ? '' : 's'} × ${colors.length} conductor${colors.length === 1 ? '' : 's'}:</p>`;
      for (let s = 1; s <= wire.sets; s++) {
        html += `<div class="mr-prev-set">Set ${s} · ${ft} ft</div>` +
          `<table class="mr-asm-tbl"><tbody>` +
          colors.map(c => `<tr><td class="q">${ft}</td><td>${esc(`${(c === 'GREEN' ? wire.groundSize : wire.size)} ${wire.type} ${wire.mat} ${c}`)}</td></tr>`).join('') +
          `</tbody></table>`;
      }
      el.innerHTML = html;
      return;
    }
    const rows = lines.map(l => `<tr><td class="q">${l.qty}</td><td>${esc(l.desc)}</td></tr>`).join('');
    el.innerHTML = `<p class="hint" style="text-align:left;margin:0 0 6px">Adds ${lines.length} line${lines.length === 1 ? '' : 's'}:</p>` +
      `<table class="mr-asm-tbl"><tbody>${rows}</tbody></table>`;
  }
  function addWire() {
    const lines = wireLines();
    if (!lines.length) return;
    const rows = [...document.querySelectorAll('#mrItems .mr-item')];
    if (rows.length === 1 && !rows[0].querySelector('.mr-desc').value.trim()) rows[0].remove();
    if (wire.mode === 'feeder') {
      // Feeder cuts are distinct rows (never summed). Continue set numbering if
      // this pull already exists, then group under pull/set headers.
      const pull = lines[0].pull;
      let maxSet = 0;
      for (const r of document.querySelectorAll('#mrItems .mr-item')) { const p = parsePull(r._note); if (p.pull === pull && p.set > maxSet) maxSet = p.set; }
      for (const l of lines) {
        const row = addItemRow(l.desc, l.qty);
        row._note = `${pull} · Set ${l.set + maxSet}`;
        row._mergedDesc = normDesc(l.desc);
      }
      renderGroups();
    } else {
      for (const l of lines) mergeItemRow(l.desc, l.qty, 'wire', l.note);   // branch spools sum by color
    }
    updateSubmit();
    closeWire();
    wire = null;   // completed — next open starts fresh at the mode chooser
    toast(`Added ${lines.length} wire line${lines.length === 1 ? '' : 's'}`);
    autosave();
  }
  function injectAutoStyles() {
    if (document.getElementById('mrAutoStyle')) return;
    const s = document.createElement('style');
    s.id = 'mrAutoStyle';
    s.textContent =
      '.mr-add-row{display:flex;gap:10px;flex-wrap:wrap}' +
      '.mr-asm{position:fixed;inset:0;z-index:2100;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center}' +
      '.mr-asm[hidden]{display:none}' +
      '.mr-asm-card{background:var(--bg);width:100%;max-width:600px;max-height:90vh;display:flex;flex-direction:column;border-radius:16px 16px 0 0;overflow:hidden;padding-bottom:var(--safe-bottom)}' +
      '.mr-asm-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border)}' +
      '.mr-asm-head strong{flex:1;text-align:center;font-size:1rem}' +
      '#mrAsmListView{display:flex;flex-direction:column;min-height:0;flex:1;padding:12px 14px;gap:10px}' +
      '#mrAsmSearch,#mrCatSearch{width:100%;padding:13px 14px;font-size:16px;background:var(--panel);border:1px solid var(--border);border-radius:10px;color:var(--text)}' +
      '.mr-cat-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:12px 14px;gap:10px}' +
      '.mr-photo-opts{display:flex;flex-direction:column;gap:10px;padding:14px}' +
      '.mr-photo-opt{width:100%;text-align:left;padding:16px;font-size:16px;background:var(--panel);border:1px solid var(--border);border-radius:12px;color:var(--text);cursor:pointer}' +
      '.mr-photo-opt:active{background:var(--chip-bg)}' +
      '.mr-actions{display:flex;flex-direction:row;gap:10px}' +
      '.mr-tool-btn{flex:1 1 0;text-align:center;padding:11px 10px;font-size:14px;background:var(--panel);border:1px solid var(--border);border-radius:10px;color:var(--text);cursor:pointer}' +
      '.mr-tool-btn:active{background:var(--chip-bg)}' +
      '.mr-listname{width:100%;box-sizing:border-box;padding:10px 12px;font-size:15px;background:var(--panel);border:1px solid var(--border);border-radius:10px;color:var(--text)}' +
      '.mr-saved{font-size:12px;color:var(--muted);opacity:0;transition:opacity .2s}' +
      '.mr-saved.show{opacity:1}' +
      '.mr-list-row{display:flex;align-items:center;gap:10px;padding:12px 4px;border-bottom:1px solid var(--border)}' +
      '.mr-list-row.active{background:var(--chip-bg)}' +
      '.mr-list-main{flex:1 1 auto;min-width:0;cursor:pointer}' +
      '.mr-list-name{font-size:15px;color:var(--text)}' +
      '.mr-list-meta{font-size:12px;color:var(--muted);margin-top:2px}' +
      '.mr-list-del{flex:0 0 auto;background:transparent;border:0;font-size:16px;cursor:pointer;padding:6px}' +
      '.mr-sent-card{border-bottom:1px solid var(--border)}' +
      '.mr-sent-head{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;background:transparent;border:0;padding:12px 4px;cursor:pointer;color:var(--text)}' +
      '.mr-sent-title{font-size:15px}' +
      '.mr-sent-sub{font-size:12px;color:var(--muted)}' +
      '.mr-sent-body{padding:2px 4px 12px}' +
      '.mr-sent-when{font-size:12px;color:var(--muted);margin-bottom:6px}' +
      '.mr-recv-row{display:flex;align-items:center;gap:10px;padding:8px 2px}' +
      '.mr-recv-row input{width:22px;height:22px;flex:0 0 auto}' +
      '.mr-recv-qty{flex:0 0 auto;min-width:28px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}' +
      '.mr-recv-desc{flex:1 1 auto;color:var(--text)}' +
      '.mr-recv-row.done .mr-recv-desc{text-decoration:line-through;color:var(--muted)}' +
      '.mr-sent-note{font-size:13px;color:var(--muted);margin-top:6px}' +
      '.mr-combined{font-size:11px;color:var(--muted);font-style:italic;margin-top:-2px;padding-left:72px}' +
      '.mr-combined[hidden]{display:none}' +
      '.mr-combined-inline{color:var(--muted);font-style:italic;font-size:12px}' +
      '.mr-grp-pull{font-weight:700;color:var(--text);font-size:14px;padding:10px 2px 2px;border-top:1px solid var(--border);margin-top:4px}' +
      '.mr-grp-set{color:var(--muted);font-size:12px;padding:2px 2px 2px 14px}' +
      '.mr-item-child{margin-left:12px}' +
      '.mr-prev-set{font-size:12px;color:var(--muted);margin:8px 0 2px;font-weight:600}' +
      '.mr-opt-sub{display:block;font-size:12px;color:var(--muted);margin-top:2px}' +
      '.mr-wire-form{padding:14px;overflow:auto;display:flex;flex-direction:column;gap:12px}' +
      '.mr-wire-form[hidden]{display:none}' +
      '.mr-wire-sizes{max-height:128px;overflow:auto;-webkit-overflow-scrolling:touch}' +
      '.mr-wdot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;border:1px solid var(--border);vertical-align:-1px}' +
      '.mr-rush{color:#f85149;font-size:12px;font-weight:700}' +
      '.mr-confirm{position:fixed;inset:0;z-index:3200;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px}' +
      '.mr-confirm[hidden]{display:none}' +
      '.mr-confirm-box{background:var(--bg);border:1px solid var(--border);border-radius:16px;max-width:340px;width:100%;padding:18px}' +
      '.mr-confirm-msg{margin:0 0 16px;font-size:15px;color:var(--text);text-align:center;line-height:1.4}' +
      '.mr-confirm-btns{display:flex;gap:10px}' +
      '.mr-confirm-cancel,.mr-confirm-ok{flex:1 1 0;padding:13px;font-size:15px;font-weight:600;border-radius:10px;cursor:pointer;border:1px solid var(--border)}' +
      '.mr-confirm-cancel{background:var(--panel);color:var(--text)}' +
      '.mr-confirm-cancel:active{background:var(--chip-bg)}' +
      '.mr-confirm-ok{background:#da3633;color:#fff;border-color:#da3633}' +
      '.mr-asm-results{overflow:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:120px}' +
      '.mr-asm-results,#mrAsmConfig,.mr-wire-form{overscroll-behavior:contain}' +
      '.mr-asm.mr-kb{align-items:flex-start}' +
      '.mr-asm.mr-kb .mr-asm-card{border-radius:0 0 16px 16px}' +
      '.mr-asm-row{padding:12px 4px;border-bottom:1px solid var(--border);cursor:pointer}' +
      '.mr-asm-row:active{background:var(--chip-bg)}' +
      '.mr-asm-name{font-size:15px;color:var(--text)}' +
      '.mr-asm-meta{font-size:12px;color:var(--muted);margin-top:2px}' +
      '#mrAsmConfig{padding:14px;overflow:auto}' +
      '.mr-asm-cfgname{margin:0 0 10px;font-size:15px}' +
      '.mr-asm-preview{margin:10px 0}' +
      '.mr-asm-tbl{width:100%;border-collapse:collapse;font-size:13px}' +
      '.mr-asm-tbl td{padding:4px 6px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:top}' +
      '.mr-asm-tbl td.q{width:48px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}' +
      '.mr-toast{position:fixed;left:50%;top:14px;transform:translate(-50%,-12px);z-index:3000;' +
      'background:#238636;color:#fff;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;' +
      'max-width:84vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.mr-toast.show{opacity:1;transform:translate(-50%,0)}';
    document.head.appendChild(s);
  }

  // ── Assemblies (kits): pick → expand to line items by run length ─────────
  async function loadAssemblies() {
    const url = new URL('catalog/assemblies.json', appBase());
    try {
      const res = await fetch(url.href);
      if (!res.ok) { shell.log(`No assemblies (HTTP ${res.status})`); return; }
      const data = await res.json();
      assemblies = (data.assemblies || []).filter(a => a && a.name).map(a => {
        const _search = [a.name, a.category, a.group, a.conduit_type, a.size, a.mounting].filter(Boolean).join(' ').toLowerCase();
        return {
          ...a,
          _search,
          _searchN: _search.replace(/[^a-z0-9]+/g, ' ').trim(), // punctuation-normalized haystack used to MATCH (gate)
          _n: String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() // normalized name, for ranking
        };
      });
      asmGroups = [...new Set(assemblies.map(a => a.group).filter(Boolean))];
      asmById = new Map(assemblies.map(a => [a.id, a]));   // index for resolving kit refs
      const btn = document.getElementById('mrAddAsm');
      if (btn && assemblies.length) btn.hidden = false;
      shell.log(`✓ Assemblies: ${assemblies.length}`);
    } catch (err) { shell.log(`Assemblies load failed: ${err.message}`); }
  }

  // Resolve kit `ref` lines at runtime by flattening from the authoritative `lines[]`
  // (kit definitions ship as assemblies too). This makes `flat[]` in the file optional and
  // removes the "stale / missing flat[]" failure mode — the leaves are always recomputed
  // from source. Falls back to `flat[]` only if we somehow can't flatten (legacy safety).
  function resolveAsm(id) { return asmById.get(id) || null; }
  function flattenAsm(a, seen) {
    const out = [];
    for (const l of (a.lines || [])) {
      if (l.ref) {
        const sub = resolveAsm(l.ref);
        if (!sub || seen.has(l.ref)) { out.push({ itemId: '', description: l.description + (sub ? ' (circular)' : ' (missing kit)'), base: l.base, fct1: l.fct1, fct2: l.fct2, matched: false }); continue; }
        const s2 = new Set(seen); s2.add(l.ref);
        for (const k of flattenAsm(sub, s2)) {
          const len = (l.base === 'Len') || (k.base === 'Len');
          out.push({ itemId: k.itemId, description: k.description, base: len ? 'Len' : 'Cnt',
            fct1: Math.round(l.fct1 * k.fct1 * 1e4) / 1e4, fct2: (l.base === 'Len' ? l.fct2 : (k.base === 'Len' ? k.fct2 : 1)), matched: k.matched });
        }
      } else {
        out.push({ itemId: l.itemId, description: l.description, base: l.base, fct1: l.fct1, fct2: l.fct2, matched: l.matched !== false });
      }
    }
    return out;
  }
  function asmLines(a) {
    if (a.lines && a.lines.length) { const f = flattenAsm(a, new Set([a.id])); if (f.length) return f; }
    return (Array.isArray(a.flat) && a.flat.length) ? a.flat : (a.lines || []);   // legacy fallback
  }
  function asmHasLen(a) { return asmLines(a).some(l => l.base === 'Len'); }

  // Conduit / rigid raceway (EMT, GRC, PVC, ENT, IMC/RMC, rigid) is sold in
  // 10 ft sticks, so its length-based quantity is ordered in whole 10 ft sticks:
  // 10 ft minimum, rounded UP to the next 10 ft (kept in feet — "length based").
  // Gated on a 1:1 (per-foot) factor so fittings sharing the conduit name
  // (couplings 1:10, straps 1:8) and per-foot wire/cable (THHN, MC — no raceway
  // token) are NOT snapped to sticks.
  const CONDUIT_RE = /\b(EMT|IMC|RMC|RGS|GRC|PVC|ENT|RIGID)\b/i;
  function isConduitLine(line) {
    const f1 = Number(line.fct1) || 0, f2 = Number(line.fct2) || 1;
    return line.base === 'Len' && f2 !== 0 && f1 === f2 && CONDUIT_RE.test(String(line.description || ''));
  }

  // Estimating model: Len → qty = runFt × fct1/fct2; Cnt/Abs → fixed fct1.
  function lineQty(line, runFt) {
    const f1 = Number(line.fct1) || 0, f2 = Number(line.fct2) || 1;
    if (line.base === 'Len') {
      const raw = runFt * f1 / (f2 || 1);
      if (isConduitLine(line)) return Math.max(10, Math.ceil(raw / 10) * 10); // whole 10 ft sticks
      return Math.max(1, Math.round(raw));
    }
    return Math.max(1, Math.round(f1 || 1));
  }
  // Count-driven kits (no Len line — boxes, devices, supports) have no run
  // length; the foreman instead gives a UNIT COUNT (how many boxes) and every
  // per-unit line scales by it. Run kits ignore `count` (run length drives them).
  function expandAssembly(a, runFt, count) {
    const mult = asmHasLen(a) ? 1 : Math.max(1, count || 1);
    const byKey = new Map(); // sum same item across kit/lines
    for (const ln of asmLines(a)) {
      if (ln.ref) continue; // a kit ref — its leaves are already in flat[]
      const qty = lineQty(ln, runFt) * mult;
      const key = ln.itemId || ln.description;
      const prev = byKey.get(key);
      if (prev) prev.qty += qty;
      else byKey.set(key, { description: ln.description, qty, unit: isConduitLine(ln) ? 'ft' : (catalogUnits[String(ln.description).toLowerCase()] || '') });
    }
    return [...byKey.values()];
  }

  function openAsm() {
    document.getElementById('mrAsm').hidden = false;
    showAsmList();
    renderAsmGroups();
    renderAsmResults();
    const s = document.getElementById('mrAsmSearch');
    if (s) setTimeout(() => s.focus(), 50);
  }
  function closeAsm() { document.getElementById('mrAsm').hidden = true; }
  function showAsmList() {
    document.getElementById('mrAsmListView').hidden = false;
    document.getElementById('mrAsmConfig').hidden = true;
    document.getElementById('mrAsmBack').hidden = true;
    document.getElementById('mrAsmTitle').textContent = 'Add from assembly';
    asmCurrent = null;
  }
  function renderAsmGroups() {
    const el = document.getElementById('mrAsmGroups');
    el.innerHTML = `<button type="button" class="chip${asmGroup === '' ? ' active' : ''}" data-g="">All</button>` +
      asmGroups.map(g => `<button type="button" class="chip${asmGroup === g ? ' active' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('');
  }
  function onAsmGroup(e) {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    asmGroup = chip.dataset.g || '';
    renderAsmGroups();
    renderAsmResults();
  }
  function renderAsmResults() {
    const q = (document.getElementById('mrAsmSearch').value || '').trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const qn = q.replace(/[^a-z0-9]+/g, ' ').trim();
    const termsN = terms.map(t => t.replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);  // gate on these
    const nTerms = termsN.length;  // empty query (nTerms 0) -> show all in the group
    // filter on _search (name + category + group + facets) so a category/group
    // word still finds a kit; then RANK by the assembly NAME — same relevance
    // model as the item autocomplete — so the tightest name match floats to #1.
    const matches = [];
    for (let i = 0; i < assemblies.length; i++) {
      const a = assemblies[i];
      if (asmGroup && a.group !== asmGroup) continue;
      let ok = true;
      for (let t = 0; t < nTerms; t++) { if (a._searchN.indexOf(termsN[t]) < 0) { ok = false; break; } }
      if (ok) matches.push(a);
    }
    if (qn) {
      for (let i = 0; i < matches.length; i++) {
        const n = matches[i]._n || '';
        let sc = 0;
        if (n === qn) sc += 1000;                     // exact name (punctuation-insensitive)
        else if (n.indexOf(qn) === 0) sc += 300;      // name starts with the query
        else if (n.indexOf(qn) >= 0) sc += 150;       // query appears contiguously in the name
        let inName = 0;
        for (let t = 0; t < termsN.length; t++) { if (n.indexOf(termsN[t]) >= 0) inName++; }
        sc += inName * 30;                            // each query word found in the NAME
        if (termsN.length && inName === termsN.length) sc += 60;
        const nWords = n ? n.split(' ').length : 0;
        sc -= Math.max(0, nWords - nTerms) * 12;      // looser match (extra words) ranks lower
        matches[i]._sc = sc;
      }
      matches.sort((a, b) => b._sc - a._sc);
    }
    const out = matches.slice(0, 60);
    const body = document.getElementById('mrAsmResults');
    if (!out.length) { body.innerHTML = '<p class="hint" style="text-align:left">No matching assemblies.</p>'; return; }
    body.innerHTML = out.map(a => {
      const meta = [a.size, a.conduit_type, a.mounting].filter(Boolean).join(' · ') || a.category || '';
      return `<div class="mr-asm-row" data-id="${esc(a.id)}"><div class="mr-asm-name">${esc(a.name)}</div>${meta ? `<div class="mr-asm-meta">${esc(meta)}</div>` : ''}</div>`;
    }).join('');
  }
  function onAsmPick(e) {
    const row = e.target.closest('.mr-asm-row');
    if (!row) return;
    asmCurrent = assemblies.find(x => x.id === row.dataset.id) || null;
    if (asmCurrent) renderAsmConfig();
  }
  function renderAsmConfig() {
    const a = asmCurrent;
    document.getElementById('mrAsmListView').hidden = true;
    document.getElementById('mrAsmConfig').hidden = false;
    document.getElementById('mrAsmBack').hidden = false;
    document.getElementById('mrAsmTitle').textContent = 'Configure';
    const cfg = document.getElementById('mrAsmConfig');
    cfg.innerHTML =
      `<p class="mr-asm-cfgname"><strong>${esc(a.name)}</strong></p>` +
      (asmHasLen(a)
        ? `<div class="field"><label for="mrAsmRun">Run length (ft)</label><input id="mrAsmRun" type="number" inputmode="numeric" min="1" value="100"></div>`
        : `<div class="field"><label for="mrAsmCount">How many? <span class="label-aside">— units of this assembly</span></label><input id="mrAsmCount" type="number" inputmode="numeric" min="1" value="1"></div>`) +
      `<div id="mrAsmPreview" class="mr-asm-preview"></div>` +
      `<button type="button" id="mrAsmAdd" class="shutter"><span class="shutter-label">Add to request</span></button>`;
    const runEl = document.getElementById('mrAsmRun');
    if (runEl) runEl.addEventListener('input', updateAsmPreview);
    const cntEl = document.getElementById('mrAsmCount');
    if (cntEl) cntEl.addEventListener('input', updateAsmPreview);
    document.getElementById('mrAsmAdd').addEventListener('click', addAsm);
    updateAsmPreview();
  }
  function currentRunFt() {
    const el = document.getElementById('mrAsmRun');
    return el ? Math.max(1, parseInt(el.value, 10) || 100) : 1;
  }
  function currentCount() {
    const el = document.getElementById('mrAsmCount');
    return el ? Math.max(1, parseInt(el.value, 10) || 1) : 1;
  }
  function updateAsmPreview() {
    if (!asmCurrent) return;
    const items = expandAssembly(asmCurrent, currentRunFt(), currentCount());
    const el = document.getElementById('mrAsmPreview');
    const rows = items.slice(0, 40).map(it => `<tr><td class="q">${it.qty}</td><td>${esc(it.description)}</td></tr>`).join('');
    el.innerHTML = `<p class="hint" style="text-align:left;margin:0 0 6px">Adds ${items.length} item${items.length === 1 ? '' : 's'}:</p>` +
      `<table class="mr-asm-tbl"><tbody>${rows}</tbody></table>` +
      (items.length > 40 ? `<p class="hint" style="text-align:left">+${items.length - 40} more…</p>` : '');
  }
  function addAsm() {
    if (!asmCurrent) return;
    const items = expandAssembly(asmCurrent, currentRunFt(), currentCount());
    if (!items.length) return;
    // Drop a single empty starter row so the kit's items read clean.
    const rows = [...document.querySelectorAll('#mrItems .mr-item')];
    if (rows.length === 1 && !rows[0].querySelector('.mr-desc').value.trim()) rows[0].remove();
    for (const it of items) mergeItemRow(it.description, it.qty, 'assembly');
    updateSubmit();
    const name = asmCurrent.name;
    closeAsm();
    toast(`Added ${items.length} item(s) from "${name}"`);
    autosave();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Drafts (running lists) + Sent history — durable, on-device (IndexedDB).
  //   • One ACTIVE list auto-saves as you type; it survives closing the app.
  //   • You can keep several NAMED lists and switch between them ("My lists").
  //   • Submitting writes a SENT record (local history) you can reference and
  //     check off as materials arrive (lead-time tracking, no double-ordering).
  // ════════════════════════════════════════════════════════════════════════
  const MR_DB = 'melton-materials';
  let activeDraft = null;   // { id, name, created_at, updated_at, jobNo, items, generalPhotos, needed_by, urgency, note }
  let _loadingDraft = false;
  let _saveTimer = null;
  let _confirmYes = null;    // pending confirm-dialog callback

  function mrOpenDb() {
    return new Promise((resolve, reject) => {
      let req; try { req = indexedDB.open(MR_DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sent')) db.createObjectStore('sent', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbPut(store, val) { return mrOpenDb().then(db => new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(val); t.oncomplete = () => res(); t.onerror = () => rej(t.error); })); }
  function dbDel(store, id) { return mrOpenDb().then(db => new Promise((res) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(id); t.oncomplete = () => res(); t.onerror = () => res(); })); }
  function dbAll(store) { return mrOpenDb().then(db => new Promise((res) => { const r = db.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); })).catch(() => []); }
  function mrId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function fmtDate(iso) {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (m) return `${+m[2]}/${+m[3]}/${m[1].slice(2)}`;
    const d = new Date(iso);
    return isNaN(d) ? String(iso).slice(0, 10) : `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
  }
  // Zero-padded MM-DD-YY for the sent-order name (e.g. "06-10-26").
  function fmtMMDDYY(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (m) return `${m[2]}-${m[3]}-${m[1].slice(2)}`;
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getFullYear()).slice(2)}`;
  }

  function newDraft() {
    const now = new Date().toISOString();
    return { id: mrId('d'), name: '', created_at: now, updated_at: now, jobNo: shell.job.jobNo(), items: [], generalPhotos: [], needed_by: '', urgency: 'normal', note: '' };
  }
  function setActiveDraft(d) { activeDraft = d; try { localStorage.setItem('mr-active-draft', d.id); } catch (e) {} }

  // A list with truly no input (no items, name, note, need-by, photos, and
  // default urgency) is discarded — not saved — when you move off it.
  function isEmptyDraft(d) {
    return !d || ((!d.items || !d.items.length) && !d.name && !d.note && !d.needed_by && (!d.generalPhotos || !d.generalPhotos.length) && (!d.urgency || d.urgency === 'normal'));
  }
  // Auto display name (date + time the list was started) so unnamed lists are
  // differentiated instead of a pile of "Untitled list". The STORED name stays
  // '' until the foreman types one (so the empty-list check above still works).
  function defaultName(d) {
    const t = new Date(d && d.created_at ? d.created_at : Date.now());
    if (isNaN(t)) return 'List';
    let h = t.getHours(); const ap = h < 12 ? 'a' : 'p'; h = h % 12 || 12;
    return `List ${t.getMonth() + 1}/${t.getDate()} ${h}:${String(t.getMinutes()).padStart(2, '0')}${ap}`;
  }
  function displayName(d) { return (d && d.name && d.name.trim()) ? d.name : defaultName(d); }
  async function stashActive() {
    if (!activeDraft) return;
    collectIntoActive();
    try {
      if (isEmptyDraft(activeDraft)) await dbDel('drafts', activeDraft.id);
      else await dbPut('drafts', activeDraft);
    } catch (e) {}
  }

  // DOM → draft items (keep only rows with content). Photos keep their File blobs.
  function rowsToItems() {
    return [...document.querySelectorAll('#mrItems .mr-item')].map(row => ({
      description: row.querySelector('.mr-desc').value.trim(),
      qty: Math.max(1, parseInt(row.querySelector('.mr-qty').value, 10) || 1),
      photos: (row._photos || []).map(p => ({ name: p.name, file: p.file })),
      adds: row._adds || 1, asmOnly: !!row._asmOnly, note: row._note || ''
    })).filter(it => it.description || it.photos.length);
  }
  function collectIntoActive() {
    if (!activeDraft) return;
    const nameEl = document.getElementById('mrListName');
    activeDraft.name = nameEl ? nameEl.value.trim() : '';
    activeDraft.needed_by = document.getElementById('mrNeededBy').value || '';
    activeDraft.urgency = urgency;
    activeDraft.note = document.getElementById('mrNote').value.trim();
    activeDraft.generalPhotos = attachments.map(a => ({ name: a.name, file: a.file }));
    activeDraft.items = rowsToItems();
    activeDraft.updated_at = new Date().toISOString();
    activeDraft.jobNo = shell.job.jobNo();
  }
  function autosave() {
    if (_loadingDraft || !activeDraft) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
      collectIntoActive();
      try { await dbPut('drafts', activeDraft); showSaved(); }
      catch (err) { shell.log(`Draft save failed: ${err.message}`); }
    }, 500);
  }
  function showSaved() {
    const el = document.getElementById('mrSaved');
    if (!el) return;
    el.textContent = 'Saved ✓';
    el.classList.add('show');
    clearTimeout(showSaved._t);
    showSaved._t = setTimeout(() => el.classList.remove('show'), 1200);
  }

  // Draft → form (rebuilds rows + photo thumbnails from the stored File blobs).
  function populateDraft(d) {
    _loadingDraft = true;
    for (const a of attachments) if (a.url) URL.revokeObjectURL(a.url);
    attachments = (d.generalPhotos || []).map(p => ({ name: p.name, file: p.file, url: URL.createObjectURL(p.file) }));
    const wrap = document.getElementById('mrItems');
    wrap.innerHTML = '';
    const items = (d.items && d.items.length) ? d.items : [null];
    for (const it of items) {
      const row = addItemRow(it ? it.description : '', it ? it.qty : undefined);
      if (it && it.photos && it.photos.length) {
        row._photos = it.photos.map(p => ({ name: p.name, file: p.file, url: URL.createObjectURL(p.file) }));
        renderItemThumbs(row);
      }
      if (it) { row._adds = it.adds || 1; row._asmOnly = !!it.asmOnly; row._mergedDesc = normDesc(it.description || ''); row._note = it.note || ''; markCombined(row); }
    }
    renderGroups();   // rebuild feeder pull/set headers from restored notes
    document.getElementById('mrNeededBy').value = d.needed_by || '';
    document.getElementById('mrNote').value = d.note || '';
    urgency = d.urgency || 'normal';
    document.querySelectorAll('#mrUrgency .chip').forEach(c => c.classList.toggle('active', c.dataset.urgency === urgency));
    const nameEl = document.getElementById('mrListName'); if (nameEl) { nameEl.value = d.name || ''; nameEl.placeholder = defaultName(d); }
    renderAttachments();
    _loadingDraft = false;
    updateSubmit();
    if (shell.nav.current && shell.nav.current() === 'material-request') focusFirstQty();
  }

  async function initDrafts() {
    let all = [];
    try { all = await dbAll('drafts'); } catch (e) {}
    let id = null; try { id = localStorage.getItem('mr-active-draft'); } catch (e) {}
    let d = id ? all.find(x => x.id === id) : null;
    if (!d) d = all.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0] || null;
    if (!d) { d = newDraft(); try { await dbPut('drafts', d); } catch (e) {} }
    setActiveDraft(d);
    populateDraft(d);
  }

  // ── "My lists" sheet (auto-saved running lists + named lists) ─────────────
  function openDrafts() { document.getElementById('mrDrafts').hidden = false; renderDrafts(); }
  function closeDrafts() { document.getElementById('mrDrafts').hidden = true; }
  // Lightweight in-app confirm (native confirm() is unreliable in iOS PWAs).
  function askConfirm(message, onYes, okLabel) {
    _confirmYes = onYes;
    document.getElementById('mrConfirmMsg').textContent = message;
    document.getElementById('mrConfirmOk').textContent = okLabel || 'Delete';
    document.getElementById('mrConfirm').hidden = false;
  }
  function closeConfirm() { document.getElementById('mrConfirm').hidden = true; _confirmYes = null; }
  async function saveActive() { collectIntoActive(); if (activeDraft) { try { await dbPut('drafts', activeDraft); } catch (e) {} } }
  async function renderDrafts() {
    await saveActive();
    const body = document.getElementById('mrDraftsList');
    const all = (await dbAll('drafts')).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    if (!all.length) { body.innerHTML = '<p class="hint" style="text-align:left">No saved lists yet.</p>'; return; }
    body.innerHTML = all.map(d => {
      const n = (d.items || []).length;
      const nm = displayName(d);
      const active = activeDraft && d.id === activeDraft.id;
      return `<div class="mr-list-row${active ? ' active' : ''}" data-id="${esc(d.id)}">
        <div class="mr-list-main"><div class="mr-list-name">${esc(nm)}${active ? ' • current' : ''}</div>
        <div class="mr-list-meta">${n} item${n === 1 ? '' : 's'} · ${fmtDate(d.updated_at)}</div></div>
        <button type="button" class="mr-list-del" data-del="${esc(d.id)}" aria-label="Delete list">🗑</button></div>`;
    }).join('');
  }
  async function onDraftsClick(e) {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      const nm = (del.closest('.mr-list-row').querySelector('.mr-list-name').textContent || 'this list').replace(' • current', '');
      askConfirm(`Delete "${nm}"? This can't be undone.`, () => deleteDraft(id));
      return;
    }
    const row = e.target.closest('.mr-list-row');
    if (row) await switchDraft(row.dataset.id);
  }
  async function switchDraft(id) {
    if (activeDraft && id === activeDraft.id) { closeDrafts(); return; }
    await stashActive();
    const d = (await dbAll('drafts')).find(x => x.id === id);
    if (!d) return;
    setActiveDraft(d); populateDraft(d); closeDrafts();
    toast(`Opened "${displayName(d)}"`);
  }
  async function deleteDraft(id) {
    await dbDel('drafts', id);
    if (activeDraft && id === activeDraft.id) {
      const rest = (await dbAll('drafts')).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      let d = rest[0];
      if (!d) { d = newDraft(); try { await dbPut('drafts', d); } catch (e) {} }
      setActiveDraft(d); populateDraft(d);
    }
    renderDrafts();
  }
  async function newList() {
    await stashActive();
    const d = newDraft();
    try { await dbPut('drafts', d); } catch (e) {}
    setActiveDraft(d); populateDraft(d); closeDrafts();
    const nameEl = document.getElementById('mrListName'); if (nameEl) nameEl.focus();
  }

  // ── "Sent orders" sheet (reference + check off received) ──────────────────
  function openSent() { document.getElementById('mrSentSheet').hidden = false; renderSent(); }
  function closeSent() { document.getElementById('mrSentSheet').hidden = true; }
  async function renderSent() {
    const body = document.getElementById('mrSentList');
    const all = (await dbAll('sent')).sort((a, b) => (b.sent_at || '').localeCompare(a.sent_at || ''));
    if (!all.length) { body.innerHTML = '<p class="hint" style="text-align:left">Nothing sent yet. Submitted orders show up here so you can track what has arrived.</p>'; return; }
    body.innerHTML = all.map(sentCardHtml).join('');
  }
  function sentCardHtml(s) {
    const items = s.items || [];
    const recv = items.filter(it => it.received).length;
    const when = fmtDate(s.sent_at);
    const title = s.name ? esc(s.name) : when;
    const rush = s.urgency === 'rush' ? ' <span class="mr-rush">🔴 RUSH</span>' : '';
    const needBy = s.needed_by ? ` · need ${fmtDate(s.needed_by)}` : '';
    const allIn = items.length && recv === items.length;
    const rows = items.map((it, i) =>
      `<label class="mr-recv-row${it.received ? ' done' : ''}">
        <input type="checkbox" data-sent="${esc(s.id)}" data-i="${i}"${it.received ? ' checked' : ''}>
        <span class="mr-recv-qty">${it.qty}</span>
        <span class="mr-recv-desc">${esc(it.description)}${it.note ? ` <span class="mr-combined-inline">(${esc(it.note)})</span>` : ''}${it.combined_note ? ` <span class="mr-combined-inline">(${esc(it.combined_note)})</span>` : ''}</span>
      </label>`).join('');
    return `<div class="mr-sent-card" data-id="${esc(s.id)}">
      <button type="button" class="mr-sent-head" data-toggle="${esc(s.id)}">
        <span class="mr-sent-title">${title}${rush}${allIn ? ' ✅' : ''}</span>
        <span class="mr-sent-sub">${items.length} item${items.length === 1 ? '' : 's'} · ${recv}/${items.length} received${needBy}</span>
      </button>
      <div class="mr-sent-body" hidden>
        ${s.name ? `<div class="mr-sent-when">Sent ${when}</div>` : ''}
        ${rows}
        ${s.note ? `<div class="mr-sent-note">📝 ${esc(s.note)}</div>` : ''}
      </div></div>`;
  }
  function onSentClick(e) {
    const tog = e.target.closest('[data-toggle]');
    if (!tog) return;
    const body = tog.parentElement.querySelector('.mr-sent-body');
    if (body) body.hidden = !body.hidden;
  }
  async function onSentChange(e) {
    const cb = e.target.closest('input[type=checkbox][data-sent]');
    if (!cb) return;
    const s = (await dbAll('sent')).find(x => x.id === cb.dataset.sent);
    if (!s) return;
    const it = s.items[+cb.dataset.i];
    if (!it) return;
    it.received = cb.checked;
    it.received_at = cb.checked ? new Date().toISOString() : null;
    try { await dbPut('sent', s); } catch (err) {}
    const card = cb.closest('.mr-sent-card');
    const row = cb.closest('.mr-recv-row'); if (row) row.classList.toggle('done', cb.checked);
    const recv = s.items.filter(x => x.received).length;
    const sub = card && card.querySelector('.mr-sent-sub');
    if (sub) { const needBy = s.needed_by ? ` · need ${fmtDate(s.needed_by)}` : ''; sub.textContent = `${s.items.length} item${s.items.length === 1 ? '' : 's'} · ${recv}/${s.items.length} received${needBy}`; }
    const titleEl = card && card.querySelector('.mr-sent-title');
    if (titleEl) { const base = titleEl.textContent.replace(' ✅', ''); titleEl.textContent = (s.items.length && recv === s.items.length) ? base + ' ✅' : base; }
  }

  // ── Register ────────────────────────────────────────────────────────────
  shell.nav.register({
    id: 'material-request',
    name: 'Materials',
    icon: '🧰',
    rootId: 'module-material-request',
    mount,
    onShow: focusFirstQty
  });

})(window.shell);
