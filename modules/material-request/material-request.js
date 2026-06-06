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
  let catalog = [];          // [{ description, unit, search }] for keyword autocomplete
  let autoInput = null;      // the .mr-desc input the autocomplete is attached to
  let urgency = 'normal';    // 'normal' | 'rush'

  // ── Mount: render the form + wire it ────────────────────────────────────
  function mount(root) {
    root.innerHTML = `
      <section class="field">
        <h2 class="module-title">Materials Request</h2>
        <p class="hint module-sub">Tell the office what you need on this job. It queues with your photos and uploads together.</p>
      </section>

      <section class="field">
        <label>Items</label>
        <div id="mrItems" class="mr-items"></div>
        <button type="button" id="mrAddItem" class="ghost-link mr-add">＋ Add item</button>
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

      <div id="mrAuto" class="mr-auto" hidden></div>`;

    injectAutoStyles();
    document.getElementById('mrAuto').addEventListener('click', onAutoPick);
    document.getElementById('mrAddItem').addEventListener('click', () => { addItemRow(); document.querySelector('#mrItems .mr-item:last-child .mr-desc').focus(); });
    document.getElementById('mrAttach').addEventListener('click', onAttach);
    document.getElementById('mrSubmit').addEventListener('click', onSubmit);
    document.getElementById('mrUrgency').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#mrUrgency .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      urgency = chip.dataset.urgency;
    });

    addItemRow();          // start with one empty row
    renderAttachments();
    updateSubmit();
    loadCatalog();         // item autocomplete (graceful if absent)
  }

  // ── Line items (DOM is the source of truth; state stays in the inputs) ───
  function addItemRow(desc, qty, unit) {
    const wrap = document.getElementById('mrItems');
    const row = document.createElement('div');
    row.className = 'mr-item';
    row.innerHTML = `
      <input class="mr-desc" type="text" autocomplete="off" placeholder="Item description" value="${esc(desc || '')}">
      <div class="mr-item-meta">
        <input class="mr-qty" type="number" min="1" inputmode="numeric" value="${qty || 1}" aria-label="Quantity">
        <input class="mr-unit" type="text" value="${esc(unit || 'ea')}" placeholder="ea" aria-label="Unit">
        <button type="button" class="mr-del" aria-label="Remove item">✕</button>
      </div>`;
    wrap.appendChild(row);

    row.querySelector('.mr-del').addEventListener('click', () => {
      row.remove();
      if (!wrap.querySelector('.mr-item')) addItemRow(); // always keep ≥1 row
      updateSubmit();
    });
    const descEl = row.querySelector('.mr-desc');
    descEl.addEventListener('input', (e) => {
      autofillUnit(row, e.target.value);
      updateSubmit();
      openAuto(e.target);
    });
    descEl.addEventListener('focus', (e) => openAuto(e.target));
    descEl.addEventListener('blur', () => setTimeout(closeAuto, 180)); // delay so a tap on a result lands
  }

  function readItems() {
    return [...document.querySelectorAll('#mrItems .mr-item')].map(row => ({
      description: row.querySelector('.mr-desc').value.trim(),
      qty: Math.max(1, parseInt(row.querySelector('.mr-qty').value, 10) || 1),
      unit: row.querySelector('.mr-unit').value.trim() || 'ea',
      note: ''
    })).filter(it => it.description);
  }

  function updateSubmit() {
    document.getElementById('mrSubmit').disabled = readItems().length === 0;
  }

  function autofillUnit(row, desc) {
    const u = catalogUnits[desc.trim().toLowerCase()];
    if (!u) return;
    const unitEl = row.querySelector('.mr-unit');
    if (!unitEl.value || unitEl.value === 'ea') unitEl.value = u; // don't clobber a real edit
  }

  // ── Photo attachments (held locally until submit) ───────────────────────
  async function onAttach() {
    try {
      const jpeg = await shell.capture.pick(); // sync-triggers the input within the gesture
      if (!jpeg) return;
      const named = new File([jpeg], buildPhotoName(), { type: 'image/jpeg' });
      attachments.push({ file: named, name: named.name, url: URL.createObjectURL(named) });
      renderAttachments();
    } catch (err) {
      shell.log(`✗ Attach failed: ${err.message}`);
      alert(`Couldn't attach photo: ${err.message}`);
    }
  }

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
    }));
  }

  // ── Submit → build §7 record, enqueue photos + JSON through shell.sync ───
  async function onSubmit() {
    const items = readItems();
    if (!items.length) return;

    const photos = attachments.map(a => a.name);
    const record = buildRecord(items, photos);

    // Attachments first, so the JSON's photos[] reference files already queued.
    for (const a of attachments) {
      shell.sync.enqueue({ file: a.file, name: a.name, contentType: 'image/jpeg', thumbUrl: a.url, label: 'Materials photo' });
    }
    // Ownership of the object URLs passes to the outbox — don't revoke here.
    attachments = [];

    const fname = buildReqName();
    const file = new File([JSON.stringify(record, null, 2)], fname, { type: 'application/json' });
    shell.sync.enqueue({
      file, name: fname, contentType: 'application/json', thumbUrl: null,
      label: `Request · ${items.length} item${items.length === 1 ? '' : 's'}`
    });

    shell.log(`Materials request queued: ${fname} (${items.length} items, ${photos.length} photo(s))`);
    resetForm();

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
  function appBase() { return location.origin + location.pathname.replace(/[^/]*$/, ''); }

  async function loadCatalog() {
    const url = new URL(`job-data/J${shell.job.jobNo()}/material-request/items.json`, appBase());
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
        return { description: desc, unit: it.unit || '', search };
      });
      shell.log(`✓ Items catalog: ${catalog.length} entries`);
    } catch (err) {
      shell.log(`Items catalog load failed: ${err.message}`);
    }
  }

  // ── Custom autocomplete (searches description + keywords; iOS-safe) ───────
  function openAuto(input) {
    autoInput = input;
    const auto = document.getElementById('mrAuto');
    if (!auto) return;
    const q = input.value.trim().toLowerCase();
    if (!q || !catalog.length) { auto.hidden = true; return; }
    const terms = q.split(/\s+/);
    const hits = [];
    for (let i = 0; i < catalog.length && hits.length < 12; i++) {
      const s = catalog[i].search;
      let ok = true;
      for (let t = 0; t < terms.length; t++) { if (s.indexOf(terms[t]) < 0) { ok = false; break; } }
      if (ok) hits.push(catalog[i]);
    }
    // hide if the only match is exactly what's already typed
    if (!hits.length || (hits.length === 1 && hits[0].description.toLowerCase() === q)) { auto.hidden = true; return; }
    auto._hits = hits;
    auto.innerHTML = hits.map((it, idx) =>
      `<div class="mr-auto-item" data-i="${idx}">${esc(it.description)}${it.unit ? `<span class="mr-auto-unit">${esc(it.unit)}</span>` : ''}</div>`
    ).join('');
    const r = input.getBoundingClientRect();
    auto.style.left = r.left + 'px';
    auto.style.top = r.bottom + 'px';
    auto.style.width = r.width + 'px';
    auto.hidden = false;
  }
  function closeAuto() { const a = document.getElementById('mrAuto'); if (a) a.hidden = true; }
  function onAutoPick(e) {
    const item = e.target.closest('.mr-auto-item');
    if (!item || !autoInput) return;
    const auto = document.getElementById('mrAuto');
    const hit = auto._hits && auto._hits[+item.dataset.i];
    if (!hit) return;
    autoInput.value = hit.description;
    const row = autoInput.closest('.mr-item');
    if (row) autofillUnit(row, hit.description);
    updateSubmit();
    auto.hidden = true;
  }
  function injectAutoStyles() {
    if (document.getElementById('mrAutoStyle')) return;
    const s = document.createElement('style');
    s.id = 'mrAutoStyle';
    s.textContent =
      '.mr-auto{position:fixed;z-index:2000;max-height:46vh;overflow:auto;margin-top:3px;' +
      'background:var(--panel);border:1px solid var(--border);border-radius:12px;' +
      'box-shadow:0 12px 32px rgba(0,0,0,.55);-webkit-overflow-scrolling:touch}' +
      '.mr-auto-item{display:flex;justify-content:space-between;align-items:center;gap:12px;' +
      'padding:13px 14px;font-size:15px;color:var(--text);border-bottom:1px solid var(--border)}' +
      '.mr-auto-item:last-child{border-bottom:0}.mr-auto-item:active{background:var(--chip-bg)}' +
      '.mr-auto-unit{flex:none;color:var(--muted);font-size:13px}';
    document.head.appendChild(s);
  }

  // ── Register ────────────────────────────────────────────────────────────
  shell.nav.register({
    id: 'material-request',
    name: 'Materials',
    icon: '🧰',
    rootId: 'module-material-request',
    mount
  });

})(window.shell);
