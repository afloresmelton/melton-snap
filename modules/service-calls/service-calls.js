'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Module #3 — Field Service Call Completion (FIELD-HUB-PLAN §2.x)
//
// Tech fills in what they did on a service call and submits — the completion
// record and any after-photos queue through the shared outbox to OneDrive,
// where the PM's hub picks them up for review before publishing the report.
//
// Contract: type='sc-completion' JSON + SCCP<job>__ photos (office SC inbox
// will route by type, just as Material Requests inbox routes by type=material-request).
// The SC number links the field record to the PM hub's service-call record.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  const U = shell.util;
  const esc = U.escapeAttr;

  // ── State ──────────────────────────────────────────────────────────────────
  let scRoot;
  let afterPhotos = [];      // [{ file, name, url }] queued before submit
  let activeDraft = null;    // current in-progress completion
  let _loadingDraft = false;
  let _saveTimer = null;

  // ── IDB ────────────────────────────────────────────────────────────────────
  const SC_DB = 'melton-sc';

  function scOpenDb() {
    return new Promise((resolve, reject) => {
      let req; try { req = indexedDB.open(SC_DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sent'))   db.createObjectStore('sent',   { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  function scDbPut(store, val) {
    return scOpenDb().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(val);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    }));
  }
  function scDbDel(store, id) {
    return scOpenDb().then(db => new Promise(res => {
      const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(id);
      t.oncomplete = () => res(); t.onerror = () => res();
    }));
  }
  function scDbAll(store) {
    return scOpenDb().then(db => new Promise(res => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => res([]);
    })).catch(() => []);
  }
  function scId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ── Assigned SC picker (optional: PM publishes job-data/.../assigned.json) ──
  // Renders tap-to-select cards for this tech's assigned SCs.
  // Gracefully absent — free-text entry always works as a fallback.
  async function loadAssigned() {
    const cfg = shell.job.current();
    if (!cfg) return;
    const base = new URL('./', location.href).href;
    try {
      const res = await fetch(
        `${base}job-data/J${esc(cfg.job)}/service-calls/assigned.json`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) return;

      // Filter to only this tech's assignments
      const me = (cfg.me || '').trim().toLowerCase();
      const mine = me
        ? list.filter(c => (c.assignedTech || '').trim().toLowerCase() === me)
        : list;
      if (!mine.length) return;

      // Render cards
      const picker = document.getElementById('scAssignedPicker');
      if (!picker) return;
      picker.innerHTML = mine.map((c, i) =>
        `<button type="button" class="sc-assign-card" data-idx="${i}">` +
          `<div class="sc-assign-num">${U.escapeHtml(c.scNumber || '—')}</div>` +
          (c.problemDescription
            ? `<div class="sc-assign-desc">${U.escapeHtml(c.problemDescription)}</div>` : '') +
          (c.locationArea
            ? `<div class="sc-assign-meta">📍 ${U.escapeHtml(c.locationArea)}</div>` : '') +
          (c.scheduledDate
            ? `<div class="sc-assign-meta">📅 ${U.escapeHtml(c.scheduledDate)}` +
              `${c.scheduledTime ? ' · ' + U.escapeHtml(c.scheduledTime) : ''}</div>` : '') +
        `</button>`
      ).join('');

      // Wire card taps
      picker.querySelectorAll('.sc-assign-card').forEach((btn, i) => {
        btn.addEventListener('click', () => {
          const sc = mine[i];
          picker.querySelectorAll('.sc-assign-card').forEach(b => b.classList.remove('sc-assign-active'));
          btn.classList.add('sc-assign-active');

          const scInput = document.getElementById('scNumber');
          if (scInput) {
            scInput.value = sc.scNumber || '';
            scInput.dispatchEvent(new Event('input'));
          }

          const preview = document.getElementById('scScopePreview');
          if (preview) {
            if (sc.scopeOfWork) {
              preview.textContent = sc.scopeOfWork;
              preview.hidden = false;
            } else {
              preview.hidden = true;
            }
          }

          // Scroll to date field after picker
          const dateField = document.getElementById('scDate');
          if (dateField) setTimeout(() => dateField.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
        });
      });

      // Show picker section
      const pickerSection = document.getElementById('scPickerSection');
      if (pickerSection) pickerSection.hidden = false;

      // Auto-select when only one assignment
      if (mine.length === 1) picker.querySelector('.sc-assign-card').click();
    } catch (e) { /* no assignments file — silent, free-text stays */ }
  }

  // ── Form helpers ───────────────────────────────────────────────────────────
  function today() { return new Date().toISOString().slice(0, 10); }

  function addMaterialRow(desc, qty) {
    const mat = document.getElementById('scMaterials');
    if (!mat) return null;
    const row = document.createElement('div');
    row.className = 'sc-mat-row';
    const seq = Date.now() + Math.random();
    row.innerHTML =
      `<input type="number" class="sc-mat-qty" name="scmq${seq}" min="1" placeholder="Qty"` +
      ` value="${esc(String(qty || ''))}" autocomplete="off" autocorrect="off">` +
      `<input type="text" class="sc-mat-desc" name="scmd${seq}" placeholder="Description…"` +
      ` value="${esc(desc || '')}" autocomplete="off" autocorrect="off" autocapitalize="words">` +
      `<button type="button" class="sc-mat-del" aria-label="Remove">✕</button>`;
    row.querySelector('.sc-mat-del').addEventListener('click', () => { row.remove(); autosave(); });
    row.querySelector('.sc-mat-qty').addEventListener('input', autosave);
    row.querySelector('.sc-mat-desc').addEventListener('input', autosave);
    mat.appendChild(row);
    return row;
  }

  function readMaterials() {
    return [...document.querySelectorAll('#scMaterials .sc-mat-row')]
      .map(row => ({
        description: row.querySelector('.sc-mat-desc').value.trim(),
        qty: Math.max(1, parseInt(row.querySelector('.sc-mat-qty').value, 10) || 1)
      }))
      .filter(it => it.description);
  }

  function renderPhotos() {
    const wrap = document.getElementById('scPhotoWrap');
    if (!wrap) return;
    wrap.innerHTML = afterPhotos.map((p, i) =>
      `<div class="sc-thumb-wrap">` +
      `<img class="sc-thumb" src="${esc(p.url)}" alt="photo ${i + 1}">` +
      `<button type="button" class="sc-thumb-del" data-i="${i}" aria-label="Remove">✕</button>` +
      `</div>`
    ).join('');
    wrap.querySelectorAll('.sc-thumb-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = +btn.dataset.i;
        URL.revokeObjectURL(afterPhotos[i].url);
        afterPhotos.splice(i, 1);
        renderPhotos(); autosave(); updateSubmitBtn();
      });
    });
  }

  function updateSubmitBtn() {
    const btn = document.getElementById('scSubmitBtn');
    if (!btn) return;
    const scNum = (document.getElementById('scNumber') || {}).value || '';
    const work  = (document.getElementById('scWorkPerformed') || {}).value || '';
    btn.disabled = !scNum.trim() || !work.trim();
  }

  // ── Draft system ───────────────────────────────────────────────────────────
  function newDraft() {
    const now = new Date().toISOString();
    return { id: scId('sc'), created_at: now, updated_at: now, jobNo: shell.job.jobNo(),
      scNumber: '', serviceDate: today(), workPerformed: '', hoursOnSite: '',
      materials: [], followUpRequired: false, followUpNotes: '', notes: '', photos: [] };
  }

  function collectIntoDraft() {
    if (!activeDraft) return;
    const g = id => (document.getElementById(id) || {});
    activeDraft.scNumber        = g('scNumber').value        || '';
    activeDraft.serviceDate     = g('scDate').value          || '';
    activeDraft.workPerformed   = g('scWorkPerformed').value || '';
    activeDraft.hoursOnSite     = g('scHours').value         || '';
    activeDraft.materials       = readMaterials();
    activeDraft.followUpRequired = !!(g('scFollowUp').checked);
    activeDraft.followUpNotes   = g('scFollowUpNotes').value || '';
    activeDraft.notes           = g('scNotes').value         || '';
    activeDraft.photos          = afterPhotos.map(p => ({ name: p.name, file: p.file }));
    activeDraft.updated_at      = new Date().toISOString();
  }

  function populateFromDraft(d) {
    _loadingDraft = true;
    try {
      const g = id => document.getElementById(id);
      if (g('scNumber'))        g('scNumber').value        = d.scNumber || '';
      if (g('scDate'))          g('scDate').value          = d.serviceDate || today();
      if (g('scWorkPerformed')) g('scWorkPerformed').value = d.workPerformed || '';
      if (g('scHours'))         g('scHours').value         = d.hoursOnSite || '';
      if (g('scFollowUp'))      g('scFollowUp').checked    = !!d.followUpRequired;
      const fnw = g('scFollowUpWrap');
      if (fnw) fnw.hidden = !d.followUpRequired;
      if (g('scFollowUpNotes')) g('scFollowUpNotes').value = d.followUpNotes || '';
      if (g('scNotes'))         g('scNotes').value         = d.notes || '';

      const mat = g('scMaterials');
      if (mat) mat.innerHTML = '';
      (d.materials || []).forEach(it => addMaterialRow(it.description, it.qty));

      // Restore photo thumbnails from stored File blobs
      afterPhotos.forEach(p => URL.revokeObjectURL(p.url));
      afterPhotos = (d.photos || []).filter(p => p.file instanceof File).map(p => ({
        file: p.file, name: p.name, url: URL.createObjectURL(p.file)
      }));
      renderPhotos();
    } finally {
      _loadingDraft = false;
    }
    updateSubmitBtn();
  }

  async function initDraft() {
    try {
      const all    = await scDbAll('drafts');
      const lastId = localStorage.getItem('sc-active-draft');
      let found    = all.find(d => d.id === lastId) || all[0] || null;
      if (!found) { found = newDraft(); await scDbPut('drafts', found); }
      activeDraft = found;
      try { localStorage.setItem('sc-active-draft', found.id); } catch (e) {}
      populateFromDraft(found);
    } catch (e) {
      shell.log('SC: draft init failed — ' + e.message);
      activeDraft = newDraft();
      populateFromDraft(activeDraft);
    }
  }

  function autosave() {
    if (_loadingDraft || !activeDraft) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
      collectIntoDraft();
      try { await scDbPut('drafts', activeDraft); } catch (e) {}
    }, 500);
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function onSubmit() {
    const scNum = ((document.getElementById('scNumber') || {}).value || '').trim();
    const work  = ((document.getElementById('scWorkPerformed') || {}).value || '').trim();
    if (!scNum || !work) return;

    const statusEl = document.getElementById('scStatus');
    if (statusEl) { statusEl.style.color = '#d29922'; statusEl.textContent = '⏳ Queued — uploading to OneDrive…'; }

    const cfg    = shell.job.current();
    const sentAt = new Date().toISOString();
    const ts     = sentAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, ''); // 20260618T083012
    const n      = Math.random().toString(36).slice(2, 7);

    // Enqueue after-photos first (so the JSON's photos[] references already-queued files)
    const photoNames = [];
    for (const p of afterPhotos) {
      shell.sync.enqueue({ file: p.file, name: p.name, contentType: p.file.type || 'image/jpeg', thumbUrl: p.url, label: 'SC photo' });
      photoNames.push(p.name);
    }
    afterPhotos = [];   // ownership passes to outbox; don't revoke URLs

    const record = {
      schema:           1,
      type:             'sc-completion',
      job:              cfg.job,
      requester:        cfg.me,
      created_at:       sentAt,
      scNumber:         scNum,
      serviceDate:      ((document.getElementById('scDate') || {}).value || sentAt.slice(0, 10)),
      workPerformed:    work,
      hoursOnSite:      parseFloat(((document.getElementById('scHours') || {}).value) || '') || null,
      materials:        readMaterials(),
      followUpRequired: !!((document.getElementById('scFollowUp') || {}).checked),
      followUpNotes:    (((document.getElementById('scFollowUpNotes') || {}).value) || '').trim() || null,
      notes:            (((document.getElementById('scNotes') || {}).value) || '').trim() || null,
      photos:           photoNames,
      status:           'submitted'
    };

    const fname = `sccomp__${ts}__${n}.json`;
    const file  = new File([JSON.stringify(record, null, 2)], fname, { type: 'application/json' });
    shell.sync.enqueue({ file, name: fname, contentType: 'application/json', thumbUrl: null,
      label: `SC Completion · ${scNum}` });

    shell.log(`SC completion queued: ${fname} (${photoNames.length} photo(s))`);

    // Local sent history — reference later; delivered flips on shell:flushed
    try {
      await scDbPut('sent', {
        id: scId('ss'), sent_at: sentAt, jobNo: cfg.job, scNumber: scNum,
        serviceDate: record.serviceDate, workPerformed: work,
        photos: photoNames.length, delivered: false
      });
    } catch (e) { shell.log('SC: sent-history write failed — ' + e.message); }

    // Drop the draft and start fresh
    try { if (activeDraft) await scDbDel('drafts', activeDraft.id); } catch (e) {}
    activeDraft = newDraft();
    try { await scDbPut('drafts', activeDraft); localStorage.setItem('sc-active-draft', activeDraft.id); } catch (e) {}
    populateFromDraft(activeDraft);
    updateSubmitBtn();

    shell.sync.flush();
  }

  // ── Sent history sheet ─────────────────────────────────────────────────────
  function fmtDate(iso) {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${+m[2]}/${+m[3]}/${m[1].slice(2)}` : String(iso).slice(0, 10);
  }

  async function openHistory() {
    const sheet = document.getElementById('scHistorySheet');
    if (!sheet) return;
    const all  = (await scDbAll('sent')).reverse();
    const list = document.getElementById('scHistoryList');
    if (!list) return;
    if (!all.length) {
      list.innerHTML = '<p class="sc-hist-empty">No completions submitted yet on this device.</p>';
    } else {
      list.innerHTML = all.map(s =>
        `<div class="sc-hist-card">` +
        `<div class="sc-hist-sc">${U.escapeHtml(s.scNumber || '—')}</div>` +
        `<div class="sc-hist-meta">${fmtDate(s.sent_at)}${s.serviceDate && s.serviceDate !== s.sent_at.slice(0, 10) ? ' · Svc ' + fmtDate(s.serviceDate) : ''}` +
        `${s.photos ? ' · ' + s.photos + ' photo' + (s.photos === 1 ? '' : 's') : ''}</div>` +
        `<div class="sc-hist-work">${U.escapeHtml((s.workPerformed || '').slice(0, 140))}</div>` +
        `<div class="sc-hist-status">${s.delivered ? '✅ Uploaded' : '⏳ Queued'}</div>` +
        `</div>`
      ).join('');
    }
    sheet.hidden = false;
  }

  // After the outbox flushes, mark all pending sent records as delivered
  document.addEventListener('shell:flushed', async () => {
    try {
      const all     = await scDbAll('sent');
      const pending = all.filter(s => !s.delivered);
      for (const s of pending) {
        await scDbPut('sent', Object.assign({}, s, { delivered: true }));
      }
    } catch (e) {}
  });

  // ── Photo handling ─────────────────────────────────────────────────────────
  function buildPhotoName(file) {
    const cfg = shell.job.current();
    const d   = new Date();
    const hh  = String(d.getHours()).padStart(2, '0');
    const mm  = String(d.getMinutes()).padStart(2, '0');
    const ss2 = String(d.getSeconds()).padStart(2, '0');
    const ext = (file.name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    return `SCCP${cfg ? cfg.job : 'X'}__${hh}${mm}${ss2}__${Math.random().toString(36).slice(2, 7)}.${ext}`;
  }

  async function handlePhotoFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    let f = file;
    try { f = await shell.capture.reencodeAsJpeg(file); } catch (e) {}
    const name = buildPhotoName(f);
    afterPhotos.push({ file: f, name, url: URL.createObjectURL(f) });
    renderPhotos(); autosave(); updateSubmitBtn();
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  function mount(root) {
    scRoot = root;
    injectStyles();

    root.innerHTML = [
      '<div class="sc-module">',

      '<section class="field">',
      '<h2 class="module-title">Service Call Completion</h2>',
      '<p class="hint module-sub">Submit your completed work report. It queues with your photos and uploads together to OneDrive.</p>',
      '</section>',

      '<section class="field sc-actions">',
      '<button type="button" id="scHistory" class="sc-tool-btn">🕓 Submitted</button>',
      '</section>',

      '<section id="scPickerSection" class="field" hidden>',
      '<label>Your Assigned Service Calls</label>',
      '<div id="scAssignedPicker" class="sc-assign-picker"></div>',
      '</section>',

      '<section class="field">',
      '<label for="scNumber">SC Number <span class="sc-req">required</span></label>',
      '<input id="scNumber" type="text" placeholder="SC-2026-XXXX"',
      ' autocomplete="off" autocorrect="off" autocapitalize="characters">',
      '<div id="scScopePreview" class="sc-scope-preview" hidden></div>',
      '</section>',

      '<section class="field">',
      '<label for="scDate">Date of Service</label>',
      '<input id="scDate" type="date">',
      '</section>',

      '<section class="field">',
      '<label for="scWorkPerformed">Work Performed <span class="sc-req">required</span></label>',
      '<textarea id="scWorkPerformed" rows="6" placeholder="Describe what was done…"',
      ' autocorrect="on" autocapitalize="sentences"></textarea>',
      '</section>',

      '<section class="field">',
      '<label for="scHours">Time on Site <span class="label-aside">— hours, optional</span></label>',
      '<input id="scHours" type="number" min="0" step="0.5" placeholder="e.g. 2.5">',
      '</section>',

      '<section class="field">',
      '<label>Materials / Parts Used <span class="label-aside">— optional</span></label>',
      '<div id="scMaterials"></div>',
      '<button type="button" id="scAddMat" class="ghost-link mr-add">＋ Add material</button>',
      '</section>',

      '<section class="field">',
      '<label class="sc-check-label">',
      '<input type="checkbox" id="scFollowUp"> Follow-up required',
      '</label>',
      '<div id="scFollowUpWrap" hidden>',
      '<textarea id="scFollowUpNotes" rows="3"',
      ' placeholder="What still needs to be done…"',
      ' autocorrect="on" autocapitalize="sentences" style="margin-top:8px;width:100%;box-sizing:border-box"></textarea>',
      '</div>',
      '</section>',

      '<section class="field">',
      '<label>After Photos <span class="label-aside">— optional</span></label>',
      '<div id="scPhotoWrap" class="sc-photos"></div>',
      '<button type="button" id="scAddPhoto" class="ghost-link mr-add">📷 Add photo</button>',
      '</section>',

      '<section class="field">',
      '<label for="scNotes">Notes <span class="label-aside">— optional</span></label>',
      '<input id="scNotes" type="text" maxlength="300"',
      ' placeholder="Anything the PM should know…" autocomplete="off">',
      '</section>',

      '<button id="scSubmitBtn" class="shutter" disabled>',
      '<span class="shutter-icon">📤</span>',
      '<span class="shutter-label">Submit Completion</span>',
      '</button>',
      '<p id="scStatus" class="hint"></p>',

      // History sheet (full-screen overlay)
      '<div id="scHistorySheet" class="sc-sheet" hidden>',
      '<div class="sc-sheet-card">',
      '<div class="sc-sheet-head">',
      '<strong>Submitted Completions</strong>',
      '<button type="button" id="scHistoryClose" class="ghost-link">✕</button>',
      '</div>',
      '<div class="sc-sheet-body">',
      '<div id="scHistoryList" class="sc-hist-list"></div>',
      '</div>',
      '</div>',
      '</div>',

      '<input type="file" id="scPhotoInput" accept="image/*" hidden>',

      '</div>'
    ].join('');

    // ── Wire events ──────────────────────────────────────────────────────────
    const q = id => document.getElementById(id);

    q('scNumber').addEventListener('input', () => { autosave(); updateSubmitBtn(); });
    q('scDate').value = today();
    q('scDate').addEventListener('input', autosave);
    q('scWorkPerformed').addEventListener('input', () => { autosave(); updateSubmitBtn(); });
    q('scHours').addEventListener('input', autosave);
    q('scNotes').addEventListener('input', autosave);
    q('scFollowUpNotes').addEventListener('input', autosave);

    q('scFollowUp').addEventListener('change', e => {
      q('scFollowUpWrap').hidden = !e.target.checked;
      autosave();
    });

    q('scAddMat').addEventListener('click', () => {
      const row = addMaterialRow('', '');
      if (row) row.querySelector('.sc-mat-desc').focus();
    });

    const photoInput = q('scPhotoInput');
    q('scAddPhoto').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', async e => {
      for (const f of (e.target.files || [])) await handlePhotoFile(f);
      photoInput.value = '';
    });

    q('scSubmitBtn').addEventListener('click', onSubmit);

    q('scHistory').addEventListener('click', openHistory);
    q('scHistoryClose').addEventListener('click', () => { q('scHistorySheet').hidden = true; });
    // Close sheet on backdrop tap
    q('scHistorySheet').addEventListener('click', e => {
      if (e.target.id === 'scHistorySheet') q('scHistorySheet').hidden = true;
    });

    // ── Init ─────────────────────────────────────────────────────────────────
    loadAssigned();
    initDraft();
  }

  // ── Focus first field on tab activation ────────────────────────────────────
  function focusFirstField() {
    const el = document.getElementById('scNumber');
    if (el && !el.value) { try { el.focus(); } catch (e) {} }
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sc-module-styles')) return;
    const s   = document.createElement('style');
    s.id      = 'sc-module-styles';
    s.textContent = `
      /* Layout */
      .sc-module { padding-bottom: 100px; }

      /* Toolbar */
      .sc-actions { display: flex; flex-direction: row; gap: 10px; }
      .sc-tool-btn {
        flex: 1; padding: 10px 0;
        background: var(--panel, #1a2535); color: var(--text, #e2e8f0);
        border: 1px solid var(--border, #2d3748); border-radius: 8px;
        font-size: 14px; font-family: inherit; cursor: pointer;
      }
      .sc-tool-btn:active { opacity: 0.7; }

      /* Required label */
      .sc-req {
        font-size: 11px; font-weight: 600; color: #ef4444;
        margin-left: 4px; text-transform: uppercase; letter-spacing: 0.05em;
      }

      /* Materials list */
      .sc-mat-row {
        display: flex; gap: 6px; align-items: center; margin-bottom: 6px;
      }
      .sc-mat-qty {
        width: 58px; flex-shrink: 0; padding: 8px 6px; text-align: center;
        background: var(--panel, #1a2535); color: var(--text, #e2e8f0);
        border: 1px solid var(--border, #2d3748); border-radius: 6px;
        font-family: inherit; font-size: 14px;
      }
      .sc-mat-desc {
        flex: 1; min-width: 0; padding: 8px;
        background: var(--panel, #1a2535); color: var(--text, #e2e8f0);
        border: 1px solid var(--border, #2d3748); border-radius: 6px;
        font-family: inherit; font-size: 14px;
      }
      .sc-mat-del {
        flex-shrink: 0; padding: 4px 8px;
        background: none; border: none;
        color: var(--muted, #6b7280); font-size: 16px; cursor: pointer;
      }

      /* Follow-up checkbox */
      .sc-check-label {
        display: flex; align-items: center; gap: 10px;
        font-size: 15px; cursor: pointer;
      }
      .sc-check-label input[type=checkbox] {
        width: 18px; height: 18px; flex-shrink: 0; cursor: pointer;
        accent-color: #3b82f6;
      }

      /* Assigned SC picker cards */
      .sc-assign-picker { display: flex; flex-direction: column; gap: 8px; }
      .sc-assign-card {
        width: 100%; text-align: left; padding: 12px 14px;
        background: var(--panel, #1a2535); color: var(--text, #e2e8f0);
        border: 1px solid var(--border, #2d3748); border-radius: 10px;
        font-family: inherit; cursor: pointer;
      }
      .sc-assign-card:active { opacity: 0.75; }
      .sc-assign-card.sc-assign-active {
        border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.35);
      }
      .sc-assign-num { font-size: 15px; font-weight: 700; margin-bottom: 3px; }
      .sc-assign-desc { font-size: 13px; color: var(--muted, #94a3b8); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sc-assign-meta { font-size: 12px; color: var(--muted, #6b7280); }
      .sc-scope-preview {
        margin-top: 8px; padding: 10px 12px;
        background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.25);
        border-radius: 8px; font-size: 13px; color: var(--muted, #94a3b8);
        white-space: pre-wrap; line-height: 1.5;
      }

      /* After photos */
      .sc-photos { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
      .sc-thumb-wrap { position: relative; }
      .sc-thumb {
        width: 72px; height: 72px; object-fit: cover;
        border-radius: 6px; border: 1px solid var(--border, #2d3748); display: block;
      }
      .sc-thumb-del {
        position: absolute; top: -6px; right: -6px;
        background: #ef4444; color: #fff; border: none; border-radius: 50%;
        width: 20px; height: 20px; font-size: 12px;
        line-height: 20px; text-align: center; padding: 0; cursor: pointer;
      }

      /* Full-screen history sheet */
      .sc-sheet {
        position: fixed; inset: 0; z-index: 2100;
        background: rgba(0,0,0,0.55);
        display: flex; align-items: flex-end;
      }
      .sc-sheet[hidden] { display: none; }
      .sc-sheet-card {
        width: 100%; max-height: 80vh;
        background: var(--bg, #0f1419);
        border-radius: 16px 16px 0 0;
        display: flex; flex-direction: column;
        box-shadow: 0 -4px 24px rgba(0,0,0,0.4);
      }
      .sc-sheet-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 16px 12px; border-bottom: 1px solid var(--border, #2d3748);
        font-size: 15px; font-weight: 600; color: var(--text, #e2e8f0); flex-shrink: 0;
      }
      .sc-sheet-body { overflow-y: auto; overscroll-behavior: contain; flex: 1; }
      .sc-hist-list { padding: 0 16px; }

      /* History cards */
      .sc-hist-card { padding: 12px 0; border-bottom: 1px solid var(--border, #2d3748); }
      .sc-hist-card:last-child { border-bottom: none; }
      .sc-hist-sc { font-weight: 700; font-size: 15px; color: var(--text, #e2e8f0); }
      .sc-hist-meta { font-size: 12px; color: var(--muted, #6b7280); margin: 2px 0 4px; }
      .sc-hist-work { font-size: 13px; color: var(--text, #e2e8f0); line-height: 1.4; margin-bottom: 4px; }
      .sc-hist-status { font-size: 12px; }
      .sc-hist-empty { padding: 16px 0; color: var(--muted, #6b7280); font-size: 14px; }
    `;
    document.head.appendChild(s);
  }

  // ── Register with the nav ──────────────────────────────────────────────────
  shell.nav.register({
    id:     'service-calls',
    name:   'Service',
    icon:   '🔧',
    rootId: 'module-service-calls',
    mount,
    onShow: focusFirstField
  });

})(window.shell);
