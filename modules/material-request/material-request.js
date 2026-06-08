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
        <div class="mr-add-row">
          <button type="button" id="mrAddItem" class="ghost-link mr-add">＋ Add item</button>
          <button type="button" id="mrAddCat" class="ghost-link mr-add" hidden>📚 Add from catalog</button>
          <button type="button" id="mrAddAsm" class="ghost-link mr-add" hidden>🧰 Add from assembly</button>
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

    addItemRow();          // start with one empty row
    renderAttachments();
    updateSubmit();
    loadCatalog();         // item autocomplete (graceful if absent)
    loadAssemblies();      // assembly kits (graceful if absent)
  }

  // ── Line items (DOM is the source of truth; state stays in the inputs) ───
  function addItemRow(desc, qty, unit) {
    const wrap = document.getElementById('mrItems');
    const row = document.createElement('div');
    row.className = 'mr-item';
    // Quantity first, then Item Description. Catalog search lives in the
    // "Add from catalog" picker now, so the description field is plain free text.
    row.innerHTML = `
      <div class="mr-item-main">
        <input class="mr-qty" type="number" min="1" inputmode="numeric" value="${qty || 1}" aria-label="Quantity">
        <input class="mr-desc" type="text" autocomplete="off" placeholder="Item description" value="${esc(desc || '')}">
      </div>
      <div class="mr-item-meta">
        <input class="mr-unit" type="text" value="${esc(unit || 'ea')}" placeholder="ea" aria-label="Unit">
        <button type="button" class="mr-del" aria-label="Remove item">✕</button>
      </div>`;
    wrap.appendChild(row);

    row.querySelector('.mr-del').addEventListener('click', () => {
      row.remove();
      if (!wrap.querySelector('.mr-item')) addItemRow(); // always keep ≥1 row
      updateSubmit();
    });
    row.querySelector('.mr-desc').addEventListener('input', updateSubmit);
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
        // dn = punctuation-normalized description used to RANK matches
        // ('3/4" EMT CONDUIT' -> '3 4 emt conduit') so an exact/tight hit wins
        // even though the search index also matches keywords.
        const dn = desc.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return { description: desc, unit: it.unit || '', search, dn };
      });
      const btn = document.getElementById('mrAddCat');
      if (btn && catalog.length) btn.hidden = false;   // reveal the catalog picker
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
    const nTerms = terms.length;
    const qn = q.replace(/[^a-z0-9]+/g, ' ').trim();              // normalized query
    const termsN = terms.map(t => t.replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);
    const matches = [];
    for (let i = 0; i < catalog.length; i++) {
      const s = catalog[i].search;
      let ok = true;
      for (let t = 0; t < nTerms; t++) { if (s.indexOf(terms[t]) < 0) { ok = false; break; } }
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
    addItemRow(hit.description, 1, hit.unit || 'ea');
    updateSubmit();
    const status = document.getElementById('mrStatus');
    if (status) { status.style.color = ''; status.textContent = `Added "${hit.description}".`; }
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
      '.mr-asm-results{overflow:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:120px}' +
      '.mr-asm-row{padding:12px 4px;border-bottom:1px solid var(--border);cursor:pointer}' +
      '.mr-asm-row:active{background:var(--chip-bg)}' +
      '.mr-asm-name{font-size:15px;color:var(--text)}' +
      '.mr-asm-meta{font-size:12px;color:var(--muted);margin-top:2px}' +
      '#mrAsmConfig{padding:14px;overflow:auto}' +
      '.mr-asm-cfgname{margin:0 0 10px;font-size:15px}' +
      '.mr-asm-preview{margin:10px 0}' +
      '.mr-asm-tbl{width:100%;border-collapse:collapse;font-size:13px}' +
      '.mr-asm-tbl td{padding:4px 6px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:top}' +
      '.mr-asm-tbl td.q{width:48px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}';
    document.head.appendChild(s);
  }

  // ── Assemblies (kits): pick → expand to line items by run length ─────────
  async function loadAssemblies() {
    const url = new URL('catalog/assemblies.json', appBase());
    try {
      const res = await fetch(url.href);
      if (!res.ok) { shell.log(`No assemblies (HTTP ${res.status})`); return; }
      const data = await res.json();
      assemblies = (data.assemblies || []).filter(a => a && a.name).map(a => ({
        ...a,
        _search: [a.name, a.category, a.group, a.conduit_type, a.size, a.mounting].filter(Boolean).join(' ').toLowerCase(),
        _n: String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() // normalized name, for ranking
      }));
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
    const termsN = terms.map(t => t.replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);
    const nTerms = terms.length;
    // filter on _search (name + category + group + facets) so a category/group
    // word still finds a kit; then RANK by the assembly NAME — same relevance
    // model as the item autocomplete — so the tightest name match floats to #1.
    const matches = [];
    for (let i = 0; i < assemblies.length; i++) {
      const a = assemblies[i];
      if (asmGroup && a.group !== asmGroup) continue;
      let ok = true;
      for (let t = 0; t < nTerms; t++) { if (a._search.indexOf(terms[t]) < 0) { ok = false; break; } }
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
    for (const it of items) addItemRow(it.description, it.qty, it.unit);
    updateSubmit();
    const name = asmCurrent.name;
    closeAsm();
    const status = document.getElementById('mrStatus');
    if (status) { status.style.color = ''; status.textContent = `Added ${items.length} item(s) from "${name}".`; }
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
