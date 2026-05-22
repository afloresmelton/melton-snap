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
  room: null,
  tag: null,
  caption: '',
  pendingFile: null,    // File object after capture+EXIF
  pendingMeta: null,    // metadata object embedded in EXIF
  gps: null             // {lat, lon, acc_m} if available
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

  // Room picker
  const picker = document.getElementById('roomPicker');
  picker.innerHTML = '<option value="">Select a room…</option>' +
    CFG.rooms.map(r => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('');
  if (CFG.rooms.length === 0) {
    picker.innerHTML = '<option value="">(No rooms configured — add &rooms=… to URL)</option>';
    picker.disabled = true;
  }
  picker.addEventListener('change', () => {
    state.room = picker.value || null;
    updateShutter();
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
  document.getElementById('retakeBtn').addEventListener('click', resetToCapture);
  document.getElementById('shareBtn').addEventListener('click', onShare);

  // Try to grab GPS in the background (non-blocking, non-required)
  requestGPS();

  updateShutter();
}

function showError(html) {
  document.getElementById('captureView').hidden = true;
  document.getElementById('reviewView').hidden = true;
  document.getElementById('bootstrapView').hidden = true;
  const errView = document.getElementById('errorView');
  errView.hidden = false;
  document.getElementById('errorMsg').innerHTML = html;
}

function showBootstrap() {
  document.getElementById('captureView').hidden = true;
  document.getElementById('reviewView').hidden = true;
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
  const ready = state.room && state.tag;
  const btn = document.getElementById('shutterBtn');
  btn.disabled = !ready;
  document.getElementById('hint').textContent = ready
    ? 'Tap shutter to take a photo.'
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
    // Re-encode through canvas to guarantee JPEG (handles HEIC + strips orientation surprises)
    const jpegFile = await reencodeAsJpeg(file);
    if (jpegFile !== file) {
      log(`Re-encoded to JPEG (${(jpegFile.size/1024).toFixed(0)} KB)`);
    }

    // Embed metadata
    const meta = buildMetadata();
    const taggedFile = await embedExif(jpegFile, meta);

    state.pendingFile = taggedFile;
    state.pendingMeta = meta;

    // Local round-trip sanity check
    if (!await verifyEmbed(taggedFile, meta)) {
      log('⚠️ Local EXIF verify mismatch — sharing anyway');
    } else {
      log('✓ Local EXIF verify OK');
    }

    showReview(taggedFile, meta);
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
  return {
    schema: 1,
    job: CFG.job,
    job_name: CFG.jobName || null,
    room: { id: slug(state.room), name: state.room, floor: null },
    tag: state.tag,
    caption: state.caption || '',
    photographer: CFG.me,
    captured_at: new Date().toISOString(),
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

// ── Review view ──────────────────────────────────────────────────────────

function showReview(file, meta) {
  document.getElementById('captureView').hidden = true;
  document.getElementById('reviewView').hidden = false;

  const url = URL.createObjectURL(file);
  document.getElementById('previewImg').src = url;

  const metaEl = document.getElementById('reviewMeta');
  metaEl.innerHTML =
    `<strong>${escapeHtml(file.name)}</strong><br>` +
    `Room: <strong>${escapeHtml(meta.room.name)}</strong> · ` +
    `Tag: <strong>${escapeHtml(meta.tag)}</strong>` +
    (meta.caption ? `<br>"${escapeHtml(meta.caption)}"` : '') +
    (meta.gps ? `<br>GPS: ${meta.gps.lat}, ${meta.gps.lon} (±${meta.gps.acc_m}m)` : '');
}

async function onShare() {
  if (!state.pendingFile) return;
  if (!navigator.canShare || !navigator.canShare({ files: [state.pendingFile] })) {
    log('✗ navigator.share with files NOT supported');
    alert('Sharing files is not supported in this browser. Use Safari on iPhone.');
    return;
  }
  try {
    await navigator.share({ files: [state.pendingFile], title: 'Jobsite photo' });
    log(`✓ Shared: ${state.pendingFile.name}`);
    resetToCapture();
  } catch (err) {
    if (err.name === 'AbortError') {
      log('Share canceled by user');
    } else {
      log(`✗ Share failed: ${err.message}`);
      alert(`Share failed: ${err.message}`);
    }
  }
}

function resetToCapture() {
  state.pendingFile = null;
  state.pendingMeta = null;
  state.caption = '';
  document.getElementById('caption').value = '';
  document.getElementById('reviewView').hidden = true;
  document.getElementById('captureView').hidden = false;
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

// ── Service worker registration ──────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(
      reg => log(`SW registered (scope: ${reg.scope})`),
      err => log(`SW register failed: ${err.message}`)
    );
  });
}

// ── Go ───────────────────────────────────────────────────────────────────

boot();
