'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Shell sync — the offline-first outbox (FIELD-HUB-PLAN §4, the core service).
//
// Captures land here first and upload to OneDrive when there's signal. The
// outbox is payload-agnostic: it carries binary (photos) AND structured JSON
// (material requests, later) through the same queue and the same upload path.
// Modules call shell.sync.enqueue({ file, name, contentType, thumbUrl, label })
// and forget about it.
//
// v1 parity note: today's queue is in-memory (matches shipped Snap behavior).
// Durable offline persistence (IndexedDB) is a Phase 2.1+ enhancement — the
// enqueue/flush seam is shaped so that swap is internal.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  const GRAPH_SCOPES = ['Files.ReadWrite.AppFolder'];

  const state = { items: [] };  // [{ id, file, name, contentType, thumbUrl, label }]
  let _seq = 0;
  let _uploading = false;

  // ── Durable storage (IndexedDB) ─────────────────────────────────────────
  // The outbox persists so a queued capture/request survives an app kill AND
  // the full-page sign-in redirect (see shell.identity). File/Blob objects go
  // straight in via structured clone; the object-URL thumbnail is regenerated
  // on restore (object URLs don't survive a reload).
  const DB_NAME = 'melton-field-hub';
  const STORE = 'outbox';

  function openDb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function persistPut(item) {
    try {
      const db = await openDb();
      db.transaction(STORE, 'readwrite').objectStore(STORE).put({
        id: item.id, name: item.name, contentType: item.contentType,
        label: item.label, file: item.file,
        isImage: !!(item.contentType && item.contentType.startsWith('image/'))
      });
    } catch (err) { shell.log(`Outbox persist failed: ${err.message}`); }
  }

  async function persistDel(id) {
    try { const db = await openDb(); db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id); } catch (e) {}
  }

  async function persistClear() {
    try { const db = await openDb(); db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch (e) {}
  }

  function idbAll() {
    return openDb().then(db => new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    })).catch(() => []);
  }

  // ── Outbox operations ───────────────────────────────────────────────────

  function enqueue({ file, name, contentType, thumbUrl, label }) {
    const item = {
      id: 'o' + Date.now().toString(36) + '_' + (++_seq), // unique across sessions
      file,
      name: name || file.name,
      contentType: contentType || file.type || 'application/octet-stream',
      thumbUrl: thumbUrl || null,
      label: label || name || file.name
    };
    state.items.push(item);
    persistPut(item);
    shell.log(`Outbox + ${item.name} (${state.items.length} pending)`);
    render();
    return item;
  }

  function items() { return state.items.slice(); }
  function count() { return state.items.length; }

  function remove(id) {
    const idx = state.items.findIndex(i => i.id === id);
    if (idx < 0) return;
    const [it] = state.items.splice(idx, 1);
    if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    persistDel(it.id);
    shell.log(`Outbox − ${it.name} (${state.items.length} left)`);
    render();
  }

  function clear() {
    for (const it of state.items) if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    state.items = [];
    persistClear();
    render();
  }

  // ── Upload engine (MSAL → Graph AppFolder) ──────────────────────────────

  // Provision the app's special folder (/Apps/Melton Snap/). On a personal
  // OneDrive the folder doesn't exist until first accessed; a GET creates it.
  async function ensureAppRoot(token) {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/approot', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Couldn't access app folder: HTTP ${res.status} ${text.slice(0, 160)}`);
    }
    return (await res.json()).id;
  }

  async function uploadItem(item, token, approotId) {
    const safeName = encodeURIComponent(item.name);
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${approotId}:/${safeName}:/content`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': item.contentType },
      body: item.file
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Upload everything in the outbox. Items are removed as they succeed; a
  // failure stops the run and leaves the rest queued for retry.
  async function flush(opts = {}) {
    if (state.items.length === 0 || _uploading) return;
    _uploading = true;

    const btn = document.getElementById('outboxUploadBtn');
    const label = btn && btn.querySelector('.shutter-label');
    const status = document.getElementById('outboxStatus');
    const origLabel = label && label.textContent;
    if (btn) btn.disabled = true;

    try {
      if (status) { status.style.color = ''; status.textContent = 'Connecting to OneDrive…'; }
      const token = await shell.identity.getToken(GRAPH_SCOPES, { interactive: opts.interactive !== false });
      const approotId = await ensureAppRoot(token);

      let done = 0;
      const total = state.items.length;
      const snapshot = state.items.slice();
      for (const item of snapshot) {
        if (label) label.textContent = `Uploading ${done + 1}/${total}…`;
        if (status) status.textContent = `Uploading ${item.name}`;
        try {
          await uploadItem(item, token, approotId);
          remove(item.id);
          done++;
        } catch (err) {
          shell.log(`✗ Upload failed for ${item.name}: ${err.message}`);
          if (status) { status.style.color = '#f85149'; status.textContent = `Failed on ${item.name}: ${err.message}`; }
          return; // stop; remaining stay queued for retry
        }
      }

      if (status) { status.style.color = '#3fb950'; status.textContent = `✓ Uploaded ${done} item${done === 1 ? '' : 's'} to OneDrive`; }
      shell.log(`✓ Outbox flush: ${done} item(s)`);
      document.dispatchEvent(new CustomEvent('shell:flushed', { detail: { count: done } }));
    } catch (err) {
      if (status) {
        status.style.color = '#f85149';
        if (err.name === 'BrowserAuthError' && /popup/i.test(err.message)) {
          status.textContent = 'Sign-in popup blocked — allow popups and try again.';
        } else {
          status.textContent = `Upload error: ${err.message}`;
        }
      }
      shell.log(`✗ Outbox flush error: ${err.message}`);
    } finally {
      _uploading = false;
      if (btn) btn.disabled = false;
      if (label && origLabel != null) label.textContent = origLabel;
      render();
    }
  }

  // Fallback path: hand the files to the OS share sheet (iOS "Save to OneDrive").
  async function shareFallback() {
    if (state.items.length === 0) return;
    const files = state.items.map(i => i.file);

    if (!navigator.canShare || !navigator.canShare({ files })) {
      // Some iOS versions cap multi-file share. Fall back to one-at-a-time.
      if (navigator.canShare && navigator.canShare({ files: [files[0]] })) {
        shell.log('⚠️ Multi-file share unsupported — sharing the first item only. Share again for the rest.');
        try {
          await navigator.share({ files: [files[0]], title: 'Jobsite item' });
          remove(state.items[0].id);
        } catch (err) {
          if (err.name !== 'AbortError') shell.log(`✗ Share failed: ${err.message}`);
        }
        return;
      }
      shell.log('✗ navigator.share with files NOT supported');
      alert('Sharing files is not supported in this browser. Use Safari on iPhone.');
      return;
    }

    try {
      await navigator.share({ files, title: `Jobsite items (${files.length})` });
      shell.log(`✓ Shared ${files.length} item(s)`);
      clear();
      document.dispatchEvent(new CustomEvent('shell:flushed', { detail: { count: files.length } }));
    } catch (err) {
      if (err.name === 'AbortError') {
        shell.log('Share canceled by user — items still queued');
      } else {
        shell.log(`✗ Share failed: ${err.message}`);
        alert(`Share failed: ${err.message}`);
      }
    }
  }

  // ── Tray rendering (shell-level; shown whenever the outbox is non-empty) ──

  function render() {
    const tray = document.getElementById('outboxTray');
    const thumbs = document.getElementById('outboxThumbs');
    const countEl = document.getElementById('outboxCount');
    if (!tray) return;

    if (state.items.length === 0) {
      tray.hidden = true;
      if (thumbs) thumbs.innerHTML = '';
      return;
    }

    tray.hidden = false;
    const n = state.items.length;
    if (countEl) countEl.textContent = `${n} item${n === 1 ? '' : 's'} ready`;

    const upLabel = document.querySelector('#outboxUploadBtn .shutter-label');
    if (upLabel && !_uploading) upLabel.textContent = `Upload ${n} to OneDrive`;
    const shareLabel = document.querySelector('#outboxShareBtn .shutter-label');
    if (shareLabel) shareLabel.textContent = `Share ${n} to OneDrive`;

    if (thumbs) {
      thumbs.innerHTML = state.items.map(it => {
        const label = shell.util.escapeHtml(it.label || '');
        const inner = it.thumbUrl
          ? `<img src="${it.thumbUrl}" alt="">`
          : `<div class="qt-doc">📄</div>`;
        return `<div class="queue-thumb" data-id="${shell.util.escapeAttr(it.id)}">
          ${inner}
          <button type="button" class="qt-remove" data-id="${shell.util.escapeAttr(it.id)}" title="Remove">×</button>
          <div class="qt-room">${label}</div>
        </div>`;
      }).join('');

      thumbs.querySelectorAll('.qt-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          remove(btn.dataset.id);
        });
      });
    }
  }

  async function init() {
    const upBtn = document.getElementById('outboxUploadBtn');
    const shareBtn = document.getElementById('outboxShareBtn');
    const clearBtn = document.getElementById('outboxClearBtn');
    if (upBtn) upBtn.addEventListener('click', () => flush()); // don't pass the event as opts
    if (shareBtn) shareBtn.addEventListener('click', shareFallback);
    if (clearBtn) clearBtn.addEventListener('click', clear);
    await restore();
    render();
  }

  // Rehydrate the outbox from IndexedDB (after an app restart or sign-in redirect).
  async function restore() {
    try {
      const recs = await idbAll();
      for (const rec of recs) {
        if (state.items.find(i => i.id === rec.id)) continue;
        state.items.push({
          id: rec.id, file: rec.file, name: rec.name,
          contentType: rec.contentType, label: rec.label,
          thumbUrl: rec.isImage ? URL.createObjectURL(rec.file) : null
        });
      }
      if (recs.length) shell.log(`Outbox restored ${recs.length} item(s) from device`);
    } catch (err) {
      shell.log(`Outbox restore failed: ${err.message}`);
    }
  }

  shell.sync = {
    enqueue, remove, clear, items, count, flush, shareFallback, init,
    scopes: GRAPH_SCOPES
  };

})(window.shell);
