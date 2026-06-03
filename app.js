'use strict';

// ── Configuration from URL params ─────────────────────────────────────────

const DEFAULTS = {
  tags: ['Rough-In', 'Finish', 'Inspection', 'Deficiency', 'Before', 'After', 'Material'],
  rooms: []
};

const CONFIG_STORAGE_KEY = 'melton-snap-config';

function parseConfig() {
  const params = new URLSearchParams(location.search);

  // Reset escape hatch — `?reset=1` clears saved config and forces re-bootstrap
  if (params.get('reset') === '1') {
    localStorage.removeItem(CONFIG_STORAGE_KEY);
  }

  const fromURL = {
    job: params.get('job') || '',
    jobName: params.get('name') || '',
    me: params.get('me') || '',
    mapUrl: params.get('map') || '',
    rooms: (params.get('rooms') || '').split(',').map(s => s.trim()).filter(Boolean),
    tags: params.get('tags')
      ? params.get('tags').split(',').map(s => s.trim()).filter(Boolean)
      : DEFAULTS.tags
  };

  // URL is the source of truth when it has valid config — save for next launch
  if (fromURL.job && fromURL.me) {
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(fromURL));
    } catch (err) {
      // localStorage might fail in private mode; not fatal
    }
    return fromURL;
  }

  // URL is bare (e.g., launched from home-screen icon via manifest start_url).
  // Fall back to last saved config so the icon "just works."
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || 'null');
    if (saved && saved.job && saved.me) {
      saved._fromCache = true;
      return saved;
    }
  } catch (err) {
    // Corrupt localStorage; ignore
  }

  return fromURL; // empty -> error view
}

const CFG = parseConfig();

// ── State ────────────────────────────────────────────────────────────────

const state = {
  rooms: [],            // unified registry: [{id, name, floor, source: 'map'|'fallback'|'url', polygon?}]
  room: null,           // currently selected room object (from state.rooms) or null
  tag: null,
  caption: '',
  queue: [],            // [{ file, meta, url }] — captured photos awaiting share
  batchId: null,        // id shared across one share-batch (set on first capture)
  gps: null,            // {lat, lon, acc_m} if available
  mapData: null,        // parsed JSON from ?map URL; null if no map configured
  mapBaseUrl: null,     // resolved base URL of map JSON (for resolving floor.image)
  loadedMapSavedAt: null,        // saved_at of the currently rendered config
  updateReason: null,            // 'config' | 'app' (for banner refresh action)
  dismissedAppUpdate: false,     // session-scoped: don't re-show app-update banner after dismiss
  dismissedConfigSavedAt: null   // session-scoped: don't re-show same config-update banner
};

// ── Logging ──────────────────────────────────────────────────────────────

function log(msg) {
  const el = document.getElementById('log');
  if (!el) return;
  const t = new Date().toTimeString().slice(0, 8);
  el.textContent = `[${t}] ${msg}\n` + el.textContent;
}

// ── Boot ─────────────────────────────────────────────────────────────────

function boot() {
  log(`UA: ${navigator.userAgent.slice(0, 70)}…`);
  log(`navigator.share files: ${navigator.canShare ? 'check at share' : 'MISSING'}`);
  log(`piexif: ${typeof piexif === 'object'}`);
  log(`Config: job=${CFG.job} me=${CFG.me} rooms=${CFG.rooms.length} tags=${CFG.tags.length}${CFG._fromCache ? ' (from cache)' : ' (from URL)'}`);

  if (!CFG.job || !CFG.me) {
    showBootstrap();
    return;
  }

  // Header
  const label = CFG.jobName ? `Job ${CFG.job} — ${CFG.jobName}` : `Job ${CFG.job}`;
  document.getElementById('jobLabel').textContent = `${label} · ${CFG.me}`;

  // Initial room registry from URL rooms (fallback if no map data arrives)
  rebuildRoomRegistry();

  // Room picker change → unified selection
  document.getElementById('roomPicker').addEventListener('change', (e) => {
    selectRoomById(e.target.value);
  });

  // Tag chips
  const chipRow = document.getElementById('tagChips');
  chipRow.innerHTML = CFG.tags.map(t =>
    `<button type="button" class="chip" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`
  ).join('');
  chipRow.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    chipRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.tag = chip.dataset.tag;
    updateShutter();
  });

  // Caption
  document.getElementById('caption').addEventListener('input', (e) => {
    state.caption = e.target.value;
  });

  // Shutter
  document.getElementById('shutterBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
  });
  document.getElementById('fileInput').addEventListener('change', onCapture);

  // Review actions
  document.getElementById('shareQueueBtn').addEventListener('click', onShareQueue);
  document.getElementById('clearQueueBtn').addEventListener('click', clearQueue);

  // Try to grab GPS in the background (non-blocking, non-required)
  requestGPS();

  // Reset view button for the map
  document.getElementById('resetViewBtn').addEventListener('click', () => {
    if (window.floorplanCanvas) window.floorplanCanvas.resetView();
  });

  // Switch job button — clears localStorage and reloads into bootstrap.
  // No native confirm() — flaky in iOS standalone PWAs. The bootstrap view IS
  // the undo path: if you tapped this by mistake, just paste your link again.
  document.getElementById('switchJobLink').addEventListener('click', (e) => {
    e.preventDefault();
    log('Switch job tapped — clearing config + reloading');
    try {
      localStorage.removeItem(CONFIG_STORAGE_KEY);
    } catch (err) {
      log(`localStorage clear failed: ${err.message}`);
    }
    location.replace('./');
  });

  // Refresh map — re-fetch rooms.json + floorplan without clearing config.
  // Useful when the foreman has published a new config and the field guy
  // wants to pick it up without re-pasting the URL.
  document.getElementById('refreshMapBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    const orig = btn.textContent;
    btn.textContent = '⏳ Refreshing…';
    btn.disabled = true;
    try {
      if (CFG.mapUrl) {
        // Reset the room registry so we don't see stale rooms while the new
        // config loads. parseConfig set CFG.rooms from URL fallback only.
        state.rooms = [];
        state.room = null;
        document.getElementById('roomPicker').value = '';
        updateShutter();
        await loadMapData(CFG.mapUrl, { bustCache: true });
        log('✓ Map refreshed from network');
      } else {
        log('No map URL configured for this job — nothing to refresh');
      }
    } catch (err) {
      log(`✗ Refresh failed: ${err.message}`);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // Load map data if configured
  if (CFG.mapUrl) {
    loadMapData(CFG.mapUrl);
  }

  updateShutter();
}

function showError(html) {
  document.getElementById('captureView').hidden = true;
  document.getElementById('bootstrapView').hidden = true;
  const errView = document.getElementById('errorView');
  errView.hidden = false;
  document.getElementById('errorMsg').innerHTML = html;
}

function showBootstrap() {
  document.getElementById('captureView').hidden = true;
  document.getElementById('errorView').hidden = true;
  document.getElementById('bootstrapView').hidden = false;

  const submitBtn = document.getElementById('bootstrapSubmit');
  const pasteBtn = document.getElementById('bootstrapPasteBtn');
  const input = document.getElementById('bootstrapInput');
  const errorEl = document.getElementById('bootstrapError');

  // Avoid double-binding on subsequent calls
  if (submitBtn.dataset.bound) return;
  submitBtn.dataset.bound = '1';

  pasteBtn.addEventListener('click', async () => {
    errorEl.hidden = true;
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      bootstrapError('Clipboard access not available — paste manually into the box above.');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        input.value = text;
        log(`Pasted from clipboard (${text.length} chars)`);
      } else {
        bootstrapError('Clipboard was empty.');
      }
    } catch (err) {
      bootstrapError(`Clipboard read denied: ${err.message}. Paste manually instead.`);
    }
  });

  submitBtn.addEventListener('click', () => {
    errorEl.hidden = true;
    const text = input.value.trim();
    if (!text) {
      bootstrapError('Paste the link first.');
      return;
    }

    let params;
    try {
      const u = new URL(text);
      params = u.searchParams;
    } catch {
      // Not a full URL — try treating as query string
      const idx = text.indexOf('?');
      try {
        params = new URLSearchParams(idx >= 0 ? text.slice(idx + 1) : text);
      } catch {
        bootstrapError('Could not parse that link. Make sure you pasted the full URL.');
        return;
      }
    }

    const job = params.get('job') || '';
    const me = params.get('me') || '';
    if (!job || !me) {
      const missing = [!job && '"job"', !me && '"me"'].filter(Boolean).join(' and ');
      bootstrapError(`Link is missing required value(s): ${missing}.`);
      return;
    }

    const config = {
      job,
      jobName: params.get('name') || '',
      me,
      mapUrl: params.get('map') || '',
      rooms: (params.get('rooms') || '').split(',').map(s => s.trim()).filter(Boolean),
      tags: params.get('tags')
        ? params.get('tags').split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULTS.tags
    };

    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
      bootstrapError(`Could not save config: ${err.message}`);
      return;
    }

    log(`✓ Bootstrap saved config: job=${config.job} me=${config.me}`);
    // Reload so boot() picks up the saved config cleanly
    location.replace('./');
  });

  function bootstrapError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
}

function updateShutter() {
  const ready = !!(state.room && state.tag);
  const btn = document.getElementById('shutterBtn');
  btn.disabled = !ready;
  document.getElementById('hint').textContent = ready
    ? `Tap shutter — ${state.room.name} / ${state.tag}`
    : 'Pick a room and a tag, then tap the shutter.';
}

// ── GPS (optional) ───────────────────────────────────────────────────────

function requestGPS() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      state.gps = {
        lat: +pos.coords.latitude.toFixed(6),
        lon: +pos.coords.longitude.toFixed(6),
        acc_m: Math.round(pos.coords.accuracy)
      };
      log(`GPS: ${state.gps.lat}, ${state.gps.lon} (±${state.gps.acc_m}m)`);
    },
    err => log(`GPS unavailable: ${err.message}`),
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
  );
}

// ── Capture ──────────────────────────────────────────────────────────────

async function onCapture(e) {
  const file = e.target.files[0];
  if (!file) return;
  log(`Captured: ${file.name} — ${(file.size/1024).toFixed(0)} KB, ${file.type}`);

  try {
    // Starting a fresh batch (queue was empty) → new batch id. All photos
    // captured before the next share share this id, so the hub can group them.
    if (state.queue.length === 0) {
      state.batchId = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // Re-encode through canvas to guarantee JPEG (handles HEIC + strips orientation surprises)
    const jpegFile = await reencodeAsJpeg(file);
    if (jpegFile !== file) {
      log(`Re-encoded to JPEG (${(jpegFile.size/1024).toFixed(0)} KB)`);
    }

    // Embed metadata
    const meta = buildMetadata();
    const taggedFile = await embedExif(jpegFile, meta);

    // Local round-trip sanity check
    if (!await verifyEmbed(taggedFile, meta)) {
      log('⚠️ Local EXIF verify mismatch — sharing anyway');
    } else {
      log('✓ Local EXIF verify OK');
    }

    // Add to the queue (multi-photo). Each photo keeps the room/tag/caption
    // that was selected at the moment of capture.
    state.queue.push({ file: taggedFile, meta, url: URL.createObjectURL(taggedFile) });
    log(`Queued ${taggedFile.name} (${state.queue.length} total)`);
    renderQueue();
  } catch (err) {
    log(`✗ Capture error: ${err.message}`);
    console.error(err);
    alert(`Capture failed: ${err.message}`);
  } finally {
    e.target.value = ''; // allow same file to be re-selected
  }
}

async function reencodeAsJpeg(file) {
  if (file.type === 'image/jpeg') return file;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Could not decode image — HEIC may need Settings > Camera > Formats > Most Compatible'));
    i.src = URL.createObjectURL(file);
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('JPEG encode failed');
  return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
}

function buildMetadata() {
  const r = state.room;
  return {
    schema: 1,
    job: CFG.job,
    job_name: CFG.jobName || null,
    room: r ? {
      id: r.source === 'map' ? r.id : slug(r.name),
      name: r.name,
      floor: r.floor,
      source: r.source
    } : null,
    tag: state.tag,
    caption: state.caption || '',
    photographer: CFG.me,
    captured_at: new Date().toISOString(),
    batch_id: state.batchId,   // shared across all photos shared together
    gps: state.gps,
    device: {
      ua: navigator.userAgent.slice(0, 120)
    }
  };
}

async function embedExif(file, meta) {
  const dataUrl = await fileToDataUrl(file);
  let exifObj;
  try {
    exifObj = piexif.load(dataUrl);
  } catch {
    exifObj = { '0th': {}, 'Exif': {}, 'GPS': {}, 'Interop': {}, '1st': {}, 'thumbnail': null };
  }
  exifObj.Exif = exifObj.Exif || {};
  const ASCII_PREFIX = '\x41\x53\x43\x49\x49\x00\x00\x00'; // "ASCII\0\0\0"
  const json = JSON.stringify(meta);
  exifObj.Exif[piexif.ExifIFD.UserComment] = ASCII_PREFIX + json;

  const exifBytes = piexif.dump(exifObj);
  const newDataUrl = piexif.insert(exifBytes, dataUrl);
  return dataUrlToFile(newDataUrl, buildFilename());
}

async function verifyEmbed(file, expected) {
  try {
    const dataUrl = await fileToDataUrl(file);
    const exifObj = piexif.load(dataUrl);
    const uc = exifObj.Exif?.[piexif.ExifIFD.UserComment] || '';
    const decoded = uc.slice(8);
    return decoded === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function buildFilename() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const nonce = Math.random().toString(36).slice(2, 5);
  return `J${CFG.job}__${hh}${mm}${ss}__${nonce}.jpg`;
}

// ── Queue (multi-photo) ──────────────────────────────────────────────────

function renderQueue() {
  const tray = document.getElementById('queueTray');
  const thumbs = document.getElementById('queueThumbs');
  const countEl = document.getElementById('queueCount');

  if (state.queue.length === 0) {
    tray.hidden = true;
    thumbs.innerHTML = '';
    return;
  }

  tray.hidden = false;
  countEl.textContent = `${state.queue.length} photo${state.queue.length === 1 ? '' : 's'} ready`;
  document.querySelector('#shareQueueBtn .shutter-label').textContent =
    `Share ${state.queue.length} to OneDrive`;

  thumbs.innerHTML = state.queue.map((q, i) => {
    const roomName = q.meta.room?.name || '—';
    return `<div class="queue-thumb" data-idx="${i}">
      <img src="${q.url}" alt="">
      <button type="button" class="qt-remove" data-idx="${i}" title="Remove">×</button>
      <div class="qt-room">${escapeHtml(roomName)}</div>
    </div>`;
  }).join('');

  thumbs.querySelectorAll('.qt-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(parseInt(btn.dataset.idx, 10));
    });
  });
}

function removeFromQueue(idx) {
  const item = state.queue[idx];
  if (item?.url) URL.revokeObjectURL(item.url);
  state.queue.splice(idx, 1);
  log(`Removed photo from queue (${state.queue.length} left)`);
  renderQueue();
}

function clearQueue() {
  for (const q of state.queue) { if (q.url) URL.revokeObjectURL(q.url); }
  state.queue = [];
  renderQueue();
}

async function onShareQueue() {
  if (state.queue.length === 0) return;
  const files = state.queue.map(q => q.file);

  if (!navigator.canShare || !navigator.canShare({ files })) {
    // Some iOS versions cap multi-file share. Fall back to one-at-a-time.
    if (navigator.canShare && navigator.canShare({ files: [files[0]] })) {
      log('⚠️ Multi-file share unsupported — sharing the first photo only. Share again for the rest.');
      try {
        await navigator.share({ files: [files[0]], title: 'Jobsite photo' });
        removeFromQueue(0);
      } catch (err) {
        if (err.name !== 'AbortError') log(`✗ Share failed: ${err.message}`);
      }
      return;
    }
    log('✗ navigator.share with files NOT supported');
    alert('Sharing files is not supported in this browser. Use Safari on iPhone.');
    return;
  }

  try {
    await navigator.share({ files, title: `Jobsite photos (${files.length})` });
    log(`✓ Shared ${files.length} photo(s)`);
    clearQueue();
    // Clear caption for the next batch; keep room/tag for fast repeat capture.
    state.caption = '';
    document.getElementById('caption').value = '';
  } catch (err) {
    if (err.name === 'AbortError') {
      log('Share canceled by user — photos still queued');
    } else {
      log(`✗ Share failed: ${err.message}`);
      alert(`Share failed: ${err.message}`);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl, filename) {
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

function slug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Room registry + unified selection ────────────────────────────────────

function rebuildRoomRegistry() {
  const list = [];

  // 1. Map rooms from currently active floor (if map loaded)
  const floorIdx = state.mapData ? (state.activeFloorIdx || 0) : -1;
  const activeFloor = floorIdx >= 0 ? state.mapData.floors[floorIdx] : null;
  if (activeFloor) {
    for (const r of activeFloor.rooms || []) {
      list.push({
        id: r.id,
        name: r.name,
        floor: activeFloor.id,
        source: 'map',
        polygon: r.polygon
      });
    }
  }

  // 2. Fallback rooms from JSON config
  if (state.mapData?.fallback_rooms) {
    for (const name of state.mapData.fallback_rooms) {
      list.push({ id: `fb:${slug(name)}`, name, floor: null, source: 'fallback' });
    }
  }

  // 3. URL-provided rooms (not duplicated by map/fallback)
  for (const name of CFG.rooms) {
    if (!list.find(r => r.name.toLowerCase() === name.toLowerCase())) {
      list.push({ id: `url:${slug(name)}`, name, floor: null, source: 'url' });
    }
  }

  state.rooms = list;
  populateRoomDropdown();
}

function populateRoomDropdown() {
  const picker = document.getElementById('roomPicker');
  const previous = picker.value;

  const mapRooms = state.rooms.filter(r => r.source === 'map');
  const otherRooms = state.rooms.filter(r => r.source !== 'map');

  let html = '<option value="">Select a room…</option>';
  if (mapRooms.length > 0) {
    html += '<optgroup label="On floorplan">';
    html += mapRooms.map(r => `<option value="${escapeAttr(r.id)}">${escapeHtml(r.name)}</option>`).join('');
    html += '</optgroup>';
  }
  if (otherRooms.length > 0) {
    html += `<optgroup label="${mapRooms.length > 0 ? 'Other locations' : 'Locations'}">`;
    html += otherRooms.map(r => `<option value="${escapeAttr(r.id)}">${escapeHtml(r.name)}</option>`).join('');
    html += '</optgroup>';
  }
  if (state.rooms.length === 0) {
    html = '<option value="">(No rooms configured — add map URL or &rooms= param)</option>';
    picker.disabled = true;
  } else {
    picker.disabled = false;
  }

  picker.innerHTML = html;

  // Restore previous selection if still valid
  if (previous && state.rooms.find(r => r.id === previous)) {
    picker.value = previous;
  } else if (state.room && state.rooms.find(r => r.id === state.room.id)) {
    picker.value = state.room.id;
  }
}

function selectRoomById(id) {
  const room = id ? (state.rooms.find(r => r.id === id) || null) : null;
  state.room = room;

  // Sync dropdown (no-op if already at this value)
  const picker = document.getElementById('roomPicker');
  if (picker.value !== (id || '')) picker.value = id || '';

  // Sync map highlight (silent to avoid callback loop)
  if (window.floorplanCanvas) {
    if (room && room.source === 'map') {
      window.floorplanCanvas.selectRoom(room.id, { silent: true });
    } else {
      window.floorplanCanvas.selectRoom(null, { silent: true });
    }
  }

  updateShutter();
}

// ── Floorplan / map ──────────────────────────────────────────────────────

// Ray-casting point-in-polygon. Polygon is array of [x, y] pairs.
function pointInPolygon(x, y, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}


async function loadMapData(mapUrl, opts = {}) {
  const statusEl = document.getElementById('mapStatus');
  const sectionEl = document.getElementById('mapSection');
  sectionEl.hidden = false;
  statusEl.textContent = `Loading floorplan…`;
  log(`Fetching map config from ${mapUrl}${opts.bustCache ? ' (cache-busted)' : ''}`);

  try {
    const resolved = new URL(mapUrl, location.href);
    // Belt-and-suspenders: tell the browser to skip its HTTP cache (the SW
    // also goes network-first for /job-data/ paths, but this guarantees we
    // hit the network even if SW caching changes).
    const fetchOpts = opts.bustCache ? { cache: 'reload' } : {};
    const res = await fetch(resolved.href, fetchOpts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    log(`✓ Map config loaded — ${data.floors?.length || 0} floor(s)`);

    if (!data.floors || data.floors.length === 0) {
      statusEl.textContent = `No floors in map config.`;
      return;
    }

    state.mapData = data;
    state.mapBaseUrl = resolved.href;
    state.activeFloorIdx = 0;
    state.loadedMapSavedAt = data.saved_at || null;

    // Rebuild room registry with map rooms (this also repopulates the dropdown)
    rebuildRoomRegistry();

    initFloorplanCanvas(0);

    // Floor tabs if multi-floor
    if (data.floors.length > 1) {
      const tabsEl = document.getElementById('floorTabs');
      tabsEl.hidden = false;
      tabsEl.innerHTML = data.floors.map((f, i) =>
        `<button type="button" class="chip${i === 0 ? ' active' : ''}" data-floor-idx="${i}">${escapeHtml(f.name)}</button>`
      ).join('');
      tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        const idx = parseInt(btn.dataset.floorIdx, 10);
        if (Number.isNaN(idx) || idx === state.activeFloorIdx) return;
        switchFloor(idx);
        tabsEl.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === btn));
      });
    }
  } catch (err) {
    statusEl.textContent = `Map load failed: ${err.message}`;
    log(`✗ Map load failed: ${err.message}`);
  }
}

function initFloorplanCanvas(floorIdx) {
  const floor = state.mapData.floors[floorIdx];
  const imageUrl = new URL(floor.image, state.mapBaseUrl).href;
  const canvasEl = document.getElementById('floorplanCanvas');
  const statusEl = document.getElementById('mapStatus');
  const readyText = `${floor.name} — tap a room`;

  window.floorplanCanvas = new FloorplanCanvas(canvasEl, imageUrl, {
    floor,
    onReady: () => {
      statusEl.textContent = readyText;
      // If a room is already selected and exists on this floor, re-highlight
      if (state.room && state.room.floor === floor.id) {
        window.floorplanCanvas.selectRoom(state.room.id, { silent: true });
      }
    },
    onError: (err) => {
      statusEl.textContent = `Couldn't load floorplan image: ${err.message}`;
    },
    onRoomSelected: (room) => {
      if (room) {
        statusEl.innerHTML = `Selected: <strong>${escapeHtml(room.name)}</strong>`;
        log(`Map tap → room ${room.id} (${room.name})`);
        // Unified path — updates state.room AND dropdown
        selectRoomById(room.id);
      } else {
        statusEl.textContent = readyText;
      }
    }
  });
}

function switchFloor(floorIdx) {
  state.activeFloorIdx = floorIdx;
  rebuildRoomRegistry();
  initFloorplanCanvas(floorIdx);
  log(`Switched to floor ${floorIdx}: ${state.mapData.floors[floorIdx].name}`);
}

class FloorplanCanvas {
  constructor(canvas, imgUrl, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.transform = { x: 0, y: 0, scale: 1 };
    this.pointers = new Map();
    this.pinchStart = null;
    this.tapStart = null;          // tracks potential single-tap origin
    this.rooms = opts.floor?.rooms || [];
    this.selectedRoomId = null;
    this.onRoomSelected = opts.onRoomSelected || (() => {});
    this.loaded = false;
    this.dpr = window.devicePixelRatio || 1;

    this.image = new Image();
    // SVG needs explicit dimensions sometimes — set crossOrigin if needed
    this.image.onload = () => {
      this.loaded = true;
      this.resizeToContainer();
      this.fit();
      this.render();
      if (opts.onReady) opts.onReady();
    };
    this.image.onerror = () => {
      if (opts.onError) opts.onError(new Error('image load failed'));
    };
    this.image.src = imgUrl;

    this.attachEvents();

    // Re-fit on viewport resize
    this._resizeObserver = new ResizeObserver(() => {
      this.resizeToContainer();
      this.fit();
      this.render();
    });
    this._resizeObserver.observe(this.canvas.parentElement);
  }

  resizeToContainer() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  fit() {
    if (!this.loaded) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const iw = this.image.naturalWidth || this.opts.floor?.image_width || 1000;
    const ih = this.image.naturalHeight || this.opts.floor?.image_height || 700;
    const scale = Math.min(cw / iw, ch / ih) * 0.96;
    this.transform.scale = scale;
    this.transform.x = (cw - iw * scale) / 2;
    this.transform.y = (ch - ih * scale) / 2;
  }

  resetView() {
    this.fit();
    this.render();
  }

  render() {
    if (!this.loaded) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.scale, this.transform.scale);
    const iw = this.image.naturalWidth || this.opts.floor?.image_width || 1000;
    const ih = this.image.naturalHeight || this.opts.floor?.image_height || 700;
    ctx.drawImage(this.image, 0, 0, iw, ih);

    // Overlay room polygons (faint outline always; bold fill on selection)
    const invScale = 1 / this.transform.scale;
    for (const room of this.rooms) {
      if (!Array.isArray(room.polygon) || room.polygon.length < 3) continue;
      const isSelected = room.id === this.selectedRoomId;
      const pts = room.polygon;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();

      if (isSelected) {
        ctx.fillStyle = 'rgba(47, 129, 247, 0.32)';
        ctx.fill();
        ctx.strokeStyle = '#2f81f7';
        ctx.lineWidth = 5 * invScale;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(47, 129, 247, 0.45)';
        ctx.lineWidth = 2 * invScale;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  selectRoom(roomId, opts = {}) {
    if (this.selectedRoomId === roomId) return;
    this.selectedRoomId = roomId;
    this.render();
    if (!opts.silent) {
      const room = roomId ? (this.rooms.find(r => r.id === roomId) || null) : null;
      this.onRoomSelected(room);
    }
  }

  _canvasToImage(canvasX, canvasY) {
    return {
      x: (canvasX - this.transform.x) / this.transform.scale,
      y: (canvasY - this.transform.y) / this.transform.scale
    };
  }

  _handleTap(canvasX, canvasY) {
    const { x, y } = this._canvasToImage(canvasX, canvasY);
    for (const room of this.rooms) {
      if (pointInPolygon(x, y, room.polygon)) {
        this.selectRoom(room.id);
        return;
      }
    }
    // Tap on empty area — leave existing selection alone
  }

  attachEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.onPointerDown(e));
    c.addEventListener('pointermove', e => this.onPointerMove(e));
    c.addEventListener('pointerup', e => this.onPointerUp(e));
    c.addEventListener('pointercancel', e => this.onPointerUp(e));
    c.addEventListener('pointerleave', e => this.onPointerUp(e));
    c.addEventListener('wheel', e => this.onWheel(e), { passive: false });
  }

  _clientToCanvas(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * this.dpr,
      y: (clientY - rect.top) * this.dpr
    };
  }

  onPointerDown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._clientToCanvas(e.clientX, e.clientY);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 1) {
      // Track potential tap — pointerup before threshold movement counts as a tap
      this.tapStart = { x: p.x, y: p.y, t: Date.now() };
    } else {
      // Multi-touch — cancel any pending tap
      this.tapStart = null;
    }

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStart = {
        dist: Math.hypot(b.x - a.x, b.y - a.y),
        scale: this.transform.scale,
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        tx: this.transform.x,
        ty: this.transform.y
      };
    }
  }

  onPointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const next = this._clientToCanvas(e.clientX, e.clientY);
    this.pointers.set(e.pointerId, next);

    // Cancel pending tap if pointer moved past threshold
    if (this.tapStart) {
      const dx = next.x - this.tapStart.x;
      const dy = next.y - this.tapStart.y;
      const moveThreshold = (10 * this.dpr) ** 2; // ~10 CSS px
      if (dx * dx + dy * dy > moveThreshold) this.tapStart = null;
    }

    if (this.pointers.size === 1) {
      this.transform.x += next.x - prev.x;
      this.transform.y += next.y - prev.y;
      this.render();
    } else if (this.pointers.size === 2 && this.pinchStart) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const ratio = dist / this.pinchStart.dist;
      const newScale = Math.max(0.1, Math.min(10, this.pinchStart.scale * ratio));
      const change = newScale / this.pinchStart.scale;
      const cx = this.pinchStart.center.x;
      const cy = this.pinchStart.center.y;
      this.transform.scale = newScale;
      this.transform.x = cx - (cx - this.pinchStart.tx) * change;
      this.transform.y = cy - (cy - this.pinchStart.ty) * change;
      this.render();
    }
  }

  onPointerUp(e) {
    // Was this a tap? (single pointer, no significant movement, under 600ms)
    const wasTap = this.tapStart
      && this.pointers.size === 1
      && Date.now() - this.tapStart.t < 600;

    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchStart = null;

    if (wasTap) {
      const p = this._clientToCanvas(e.clientX, e.clientY);
      this._handleTap(p.x, p.y);
    }
    this.tapStart = null;
  }

  onWheel(e) {
    e.preventDefault();
    const p = this._clientToCanvas(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(0.1, Math.min(10, this.transform.scale * factor));
    const change = newScale / this.transform.scale;
    this.transform.scale = newScale;
    this.transform.x = p.x - (p.x - this.transform.x) * change;
    this.transform.y = p.y - (p.y - this.transform.y) * change;
    this.render();
  }
}

// ── Update banner (config + app shell) ───────────────────────────────────

function showUpdateBanner(reason, message) {
  state.updateReason = reason;
  const banner = document.getElementById('updateBanner');
  banner.querySelector('.update-text').textContent = message;
  banner.hidden = false;
  log(`Banner shown: ${reason} — ${message}`);
}

function hideUpdateBanner() {
  document.getElementById('updateBanner').hidden = true;
}

async function onUpdateRefresh() {
  const reason = state.updateReason;
  hideUpdateBanner();
  if (reason === 'app') {
    // For app shell updates, the new SW is already in 'installed' state.
    // Reload to activate it (the new SW skipWaiting + clients.claim takes over).
    log('App update — reloading page');
    location.reload();
  } else {
    // For config updates, re-fetch the map without losing capture state.
    log('Config update — refreshing map');
    if (CFG.mapUrl) {
      // Reset room selection while reloading
      state.rooms = [];
      state.room = null;
      document.getElementById('roomPicker').value = '';
      updateShutter();
      try {
        await loadMapData(CFG.mapUrl, { bustCache: true });
      } catch (err) {
        log(`Refresh failed: ${err.message}`);
      }
    }
  }
}

function onUpdateDismiss() {
  if (state.updateReason === 'app') {
    state.dismissedAppUpdate = true;
  } else if (state.updateReason === 'config') {
    state.dismissedConfigSavedAt = state.loadedMapSavedAt;
  }
  hideUpdateBanner();
}

// Poll the map config and silently auto-refresh if a newer version exists.
// If the user has work in progress (pending capture), defer with a banner
// instead of disrupting them.
async function checkForConfigUpdate() {
  if (!CFG.mapUrl) return;
  if (!state.loadedMapSavedAt) return;       // nothing to compare against yet
  try {
    const url = new URL(CFG.mapUrl, location.href);
    // Append a unique timestamp so the SW's cache-key never matches — this
    // forces a real network fetch even on an old SW that does cache-first.
    const bustedUrl = url.href + (url.search ? '&' : '?') + '_t=' + Date.now();
    const res = await fetch(bustedUrl, { cache: 'reload' });
    if (!res.ok) return;
    const fresh = await res.json();
    if (!fresh.saved_at) return;
    if (fresh.saved_at === state.loadedMapSavedAt) return; // already up-to-date

    log(`New config detected: ${state.loadedMapSavedAt} → ${fresh.saved_at}`);

    // If the user has photos queued but not yet shared, don't disrupt them.
    // Show a banner so they can finish + tap when ready.
    if (state.queue.length > 0) {
      if (state.updateReason === 'config') return;
      showUpdateBanner('config', 'Updated map — share your photos first');
      return;
    }

    // Otherwise silently swap in the new config.
    log('Auto-refreshing map (no pending capture)');
    state.rooms = [];
    state.room = null;
    document.getElementById('roomPicker').value = '';
    updateShutter();
    await loadMapData(CFG.mapUrl, { bustCache: true });
  } catch (err) {
    // Network issue — silent
  }
}

// Set up the polling triggers + button wiring
function initUpdateChecks() {
  document.getElementById('updateRefreshBtn').addEventListener('click', onUpdateRefresh);
  document.getElementById('updateDismissBtn').addEventListener('click', onUpdateDismiss);

  function tickUpdateChecks() {
    checkForConfigUpdate();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => reg && reg.update());
    }
  }

  // Check when the user returns to the app (tab focus, app re-foreground, etc.)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tickUpdateChecks();
  });
  window.addEventListener('focus', tickUpdateChecks);

  // Periodic poll while the app is in foreground — every 2 minutes.
  // Light traffic (a ~2KB JSON) but keeps the app current without user action.
  setInterval(() => {
    if (document.visibilityState === 'visible') tickUpdateChecks();
  }, 2 * 60 * 1000);

  // Also tick once shortly after boot (catches config changes made in the
  // last 30 seconds before the user opened the app).
  setTimeout(tickUpdateChecks, 30 * 1000);
}

// ── Service worker registration + update detection ───────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(
      reg => {
        log(`SW registered (scope: ${reg.scope})`);
        // Listen for new SW installs (app shell updates)
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // A new SW finished installing AND an old one is still controlling.
              // If the user has queued photos, defer with a banner.
              if (state.queue.length > 0) {
                if (state.dismissedAppUpdate) return;
                showUpdateBanner('app', 'App update — share your photos first');
                return;
              }
              // Otherwise auto-reload — small delay lets in-flight state settle.
              log('App update installed — auto-reloading');
              setTimeout(() => location.reload(), 500);
            }
          });
        });
      },
      err => log(`SW register failed: ${err.message}`)
    );
  });
}

initUpdateChecks();

// ── Go ───────────────────────────────────────────────────────────────────

boot();
